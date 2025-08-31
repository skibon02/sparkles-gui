pub mod storage;
pub mod event_skipper;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::thread;
use std::time::Instant;
use log::{debug, error, info, warn};
use sparkles_parser::packet_decoder::PacketDecoder;
use sparkles_parser::parsed::ParsedEvent;
use sparkles_parser::{SparklesParser, TracingEventId};
use tokio::select;
use crate::shared::{SparklesConnection, WsToSparklesMessage};
use crate::tasks::sparkles_connection::storage::ClientStorage;
use crate::tasks::sparkles_connection::event_skipper::EventSkippingProcessor;

pub fn spawn_conn_handler(addr: SocketAddr, conn: SparklesConnection) {
    let (msg_tx, msg_rx) = tokio::sync::mpsc::channel(100);
    let client_storage = ClientStorage::new(msg_rx);

    spawn_connection(addr, msg_tx);

    let _ = tokio::spawn(async move {
        if let Err(e) = run(addr, conn, client_storage).await {
            error!("Error running Sparkles connection: {e}");
        }
        else {
            info!("Sparkles connection handler for {addr} finished successfully");
        }
    });
}

const MAX_EV_CNT: usize = 50_000;

#[derive(Debug)]
enum RangeEventType {
    Local(u64, u64, TracingEventId, Option<TracingEventId>),
    CrossThread(u64, u64, TracingEventId, Option<TracingEventId>, u64),
}

impl RangeEventType {
    fn start_time(&self) -> u64 {
        match self {
            RangeEventType::Local(start, _, _, _) => *start,
            RangeEventType::CrossThread(start, _, _, _, _) => *start,
        }
    }

    fn end_time(&self) -> u64 {
        match self {
            RangeEventType::Local(_, end, _, _) => *end,
            RangeEventType::CrossThread(_, end, _, _, _) => *end,
        }
    }

    fn name_id(&self) -> TracingEventId {
        match self {
            RangeEventType::Local(_, _, name_id, _) => *name_id,
            RangeEventType::CrossThread(_, _, name_id, _, _) => *name_id,
        }
    }

    fn end_name_id(&self) -> Option<TracingEventId> {
        match self {
            RangeEventType::Local(_, _, _, end_name_id) => *end_name_id,
            RangeEventType::CrossThread(_, _, _, end_name_id, _) => *end_name_id,
        }
    }

    fn cross_thread_id(&self) -> Option<u64> {
        match self {
            RangeEventType::Local(_, _, _, _) => None,
            RangeEventType::CrossThread(_, _, _, _, thread_id) => Some(*thread_id),
        }
    }
}

fn merge_range_events<I1, I2>(
    local_events: I1,
    cross_thread_events: I2,
) -> impl Iterator<Item = RangeEventType>
where
    I1: Iterator<Item = (u64, u64, TracingEventId, Option<TracingEventId>)>,
    I2: Iterator<Item = (u64, u64, TracingEventId, Option<TracingEventId>, u64)>,
{
    let mut local_peekable = local_events.map(|(start, end, name_id, end_name_id)| {
        RangeEventType::Local(start, end, name_id, end_name_id)
    }).peekable();
    
    let mut cross_thread_peekable = cross_thread_events.map(|(start, end, name_id, end_name_id, thread_id)| {
        RangeEventType::CrossThread(start, end, name_id, end_name_id, thread_id)
    }).peekable();
    
    std::iter::from_fn(move || {
        match (local_peekable.peek(), cross_thread_peekable.peek()) {
            (Some(local), Some(cross_thread)) => {
                if local.start_time() <= cross_thread.start_time() {
                    local_peekable.next()
                } else {
                    cross_thread_peekable.next()
                }
            }
            (Some(_), None) => local_peekable.next(),
            (None, Some(_)) => cross_thread_peekable.next(),
            (None, None) => None,
        }
    })
}

fn process_range_events<I1, I2>(
    local_events: I1,
    cross_thread_events: I2,
    processor: &mut EventSkippingProcessor,
    skip_thr: u64,
) -> (Vec<u8>, Vec<u8>, u8)
where
    I1: Iterator<Item = (u64, u64, TracingEventId, Option<TracingEventId>)>,
    I2: Iterator<Item = (u64, u64, TracingEventId, Option<TracingEventId>, u64)>,
{
    let mut active_ranges: Vec<(u64, u8)> = Vec::new(); // (end_time, y_position)
    let mut used_y_levels = [false; 256]; // Track which Y levels are in use
    let mut local_range_buf = Vec::new();
    let mut cross_thread_range_buf = Vec::new();
    let mut max_range_y = 0u8;
    let mut prev_range_start: Option<u64> = None;
    
    let merged_events = merge_range_events(local_events, cross_thread_events);

    let mut prev_start = 0;
    for event in merged_events {
        let range_start = event.start_time();
        let range_end = event.end_time();

        if range_start < prev_start {
            panic!("Error in merge algorithm: Range start time {} is before previous event end time {}", range_start, prev_start);
        }
        prev_start = range_start;
        let start_id = event.name_id();
        let end_id = event.end_name_id();
        
        let duration = range_end - range_start;
        let start_distance = if let Some(prev_start) = prev_range_start {
            range_start - prev_start
        } else {
            skip_thr + 1 // Always keep first event
        };

        if processor.should_keep_range(start_distance, duration) {
            // Remove expired ranges and update used_y_levels
            let mut i = 0;
            while i < active_ranges.len() {
                if active_ranges[i].0 <= range_start {
                    let (_, expired_y) = active_ranges.swap_remove(i);
                    used_y_levels[expired_y as usize] = false;
                } else {
                    i += 1;
                }
            }

            // Find first available Y position using array lookup
            let mut y_pos = 0u8;
            while y_pos < 255 && used_y_levels[y_pos as usize] {
                y_pos += 1;
            }

            // Track maximum Y position used by ranges
            max_range_y = max_range_y.max(y_pos);

            // Mark Y position as used and add to active ranges
            used_y_levels[y_pos as usize] = true;
            active_ranges.push((range_end, y_pos));

            // Serialize range event to appropriate buffer
            let range_buf = if event.cross_thread_id().is_some() {
                &mut cross_thread_range_buf
            } else {
                &mut local_range_buf
            };
            
            range_buf.extend_from_slice(&range_start.to_le_bytes());
            range_buf.extend_from_slice(&range_end.to_le_bytes());
            range_buf.push(start_id);
            if let Some(end_id) = end_id {
                range_buf.push(end_id);
            } else {
                range_buf.push(255);
            }
            range_buf.push(y_pos);
            
            // Add thread ID for cross-thread events
            if let Some(thread_id) = event.cross_thread_id() {
                range_buf.extend_from_slice(&thread_id.to_le_bytes());
            }
        }
        prev_range_start = Some(range_start);
    }
    
    (local_range_buf, cross_thread_range_buf, max_range_y)
}

struct ActiveRangeRequest {
    resp: tokio::sync::mpsc::Sender<(u64, Vec<u8>, EventsSkipStats)>,
    start: u64,
    end: u64,
}

async fn run(addr: SocketAddr, mut conn: SparklesConnection, mut storage: ClientStorage) -> anyhow::Result<()> {
    let mut active_sending_requests: HashMap<u32, ActiveRangeRequest> = HashMap::new();
    let (mut dummy_tx, _dummy_rx) = tokio::sync::mpsc::channel(1);

    loop {
        select! {
            res = conn.recv_message() => {
                let (ws_id, msg) = res?;
                match msg {
                    WsToSparklesMessage::RequestNewRange {
                        start,
                        end,
                        events_channel
                    } => {
                        active_sending_requests.insert(ws_id, ActiveRangeRequest {
                            resp: events_channel,
                            start,
                            end,
                        });
                        info!("Connection manager: added new range request for start: {start}, end: {end}");
                    }
                    WsToSparklesMessage::GetEventNames {
                        thread_id,
                        resp
                    } => {
                        if let Some(event_storage) = storage.thread_events.get(&thread_id) {
                            let event_names = event_storage.event_names.clone();
                            let _ = resp.send(event_names);
                        }
                    }
                    WsToSparklesMessage::GetThreadNames {
                        resp
                    } => {
                        let _ = resp.send(storage.thread_names.clone());
                    }
                    WsToSparklesMessage::SetThreadName {
                        thread_id,
                        name,
                        resp
                    } => {
                        storage.thread_names.insert(thread_id, name);
                        let _ = resp.send(());
                    }
                    WsToSparklesMessage::GetConnectionTimestamps {
                        resp
                    } => {
                        if let Some(conn_ts) = &storage.conn_timestamps {
                            let now = Instant::now();
                            let (last_sync_time, last_sync_tm) = conn_ts.last_sync;
                            let elapsed = now - last_sync_time;
                            let elapsed_ns = elapsed.as_nanos() as u64;
                            let adjusted_tm = last_sync_tm + elapsed_ns;
                            
                            let _ = resp.send(Some((conn_ts.min_tm, conn_ts.max_tm, adjusted_tm)));
                        } else {
                            let _ = resp.send(None);
                        }
                    }
                    WsToSparklesMessage::GetStorageStats {
                        resp
                    } => {
                        let _ = resp.send(storage.get_storage_stats());
                    }
                }
            },

            res = storage.msg_rx.recv() => {
                if let Some(msg) = res {
                    match msg {
                        SparklesConnectionMessage::Events { thread_ord_id, events } => {
                            #[cfg(feature = "self-tracing")]
                            let g = sparkles::range_event_start!("storing new events");
                            let thread_storage = storage.thread_events
                                .entry(thread_ord_id)
                                .or_default();

                            let mut min_tm: Option<u64> = None;
                            let mut max_tm: Option<u64> = None;

                            for event in events {
                                match event {
                                    ParsedEvent::Instant {
                                        tm,
                                        name_id
                                    } => {
                                        min_tm = Some(min_tm.map_or(tm, |min| min.min(tm)));
                                        max_tm = Some(max_tm.map_or(tm, |max| max.max(tm)));
                                        thread_storage.instant_events.insert(tm, name_id);
                                    }
                                    ParsedEvent::Range {
                                        start,
                                        end,
                                        name_id,
                                        end_name_id,
                                        start_thread_ord_id
                                    } => {
                                        min_tm = Some(min_tm.map_or(start, |min| min.min(start).min(end)));
                                        max_tm = Some(max_tm.map_or(end, |max| max.max(start).max(end)));

                                        if let Some(start_thread_ord_id) = start_thread_ord_id {
                                            thread_storage.cross_thread_range_events.insert(start, end, name_id, end_name_id, start_thread_ord_id);
                                        }
                                        else {
                                            thread_storage.range_events.insert_simple(start, end, name_id, end_name_id);
                                        }
                                    }
                                }
                            }

                            if let Some(min) = min_tm && let Some(max) = max_tm {
                                let now = Instant::now();
                                let last_event_tm = max;
                                
                                if let Some(conn_ts) = &mut storage.conn_timestamps {
                                    conn_ts.last_sync = (now, last_event_tm);
                                    conn_ts.min_tm = conn_ts.min_tm.min(min);
                                    conn_ts.max_tm = conn_ts.max_tm.max(max);
                                } else {
                                    storage.conn_timestamps = Some(storage::ConnectionTimestamps {
                                        last_sync: (now, last_event_tm),
                                        min_tm: min,
                                        max_tm: max,
                                    });
                                }
                            }
                        }
                        SparklesConnectionMessage::UpdateThreadName { thread_ord_id, thread_name } => {
                            storage.thread_names.insert(thread_ord_id, thread_name.clone());
                        }
                        SparklesConnectionMessage::UpdateEventNames { thread_ord_id, event_names } => {
                            storage.thread_events
                                .entry(thread_ord_id)
                                .or_default()
                                .event_names = event_names;
                        }
                    }

                }
                else {
                    info!("Sparkles channel closed, preserving events");
                    let (tx, rx) = tokio::sync::mpsc::channel(1);

                    conn.mark_connection_disconnected(conn.id());
                    storage.msg_rx = rx;
                    dummy_tx = tx;
                }
            },
        }

        // process one request
        if let Some(k) = active_sending_requests.keys().next().cloned() {
            let ActiveRangeRequest {
                resp,
                start,
                end,
            } = active_sending_requests.remove(&k).unwrap();
            
            let len_requests = storage.thread_events.len();
            let Ok(mut permits) = resp.try_reserve_many(len_requests) else {
                // reserve failed, push back the request
                active_sending_requests.insert(k, ActiveRangeRequest {
                    resp,
                    start,
                    end,
                });
                warn!("Too many threads! Cannot request events");
                continue;
            };
            #[cfg(feature = "self-tracing")]
            let g = sparkles::range_event_start!("request events");
            for (thread_ord_id, thread_storage) in storage.thread_events.iter() {
                #[cfg(feature = "self-tracing")]
                let g = sparkles::range_event_start!("request thread events");
                let mut res_buf = Vec::new();
                let mut buf = Vec::new();

                #[cfg(feature = "self-tracing")]
                let gc = sparkles::range_event_start!("count events");
                let instant_event_cnt = thread_storage.request_instant_events(start, end).count();
                let range_event_cnt = thread_storage.request_range_events(start, end).count();
                let cross_thread_range_event_cnt = thread_storage.request_cross_thread_range_events(start, end).count();
                #[cfg(feature = "self-tracing")]
                drop(gc);

                let skip_thr = (end - start) / 2000; // assume 2000px horizontal resolution, use as skip threshold
                let mut processor = EventSkippingProcessor::new(skip_thr, MAX_EV_CNT, instant_event_cnt, range_event_cnt + cross_thread_range_event_cnt);

                // Process range events
                #[cfg(feature = "self-tracing")]
                let g2 = sparkles::range_event_start!("process range events");
                let (range_buf, foreign_range_buf, max_range_y) = process_range_events(
                    thread_storage.request_range_events(start, end),
                    thread_storage.request_cross_thread_range_events(start, end),
                    &mut processor,
                    skip_thr,
                );
                #[cfg(feature = "self-tracing")]
                drop(g2);

                // Process instant events - put them all at max_range_y + 1
                #[cfg(feature = "self-tracing")]
                let g3 = sparkles::range_event_start!("process instant events");
                let instant_y = if max_range_y < 255 { max_range_y + 1 } else { 255 };
                let mut prev_instant: Option<(u64, TracingEventId)> = None;
                for (tm, id) in thread_storage.request_instant_events(start, end) {
                    if let Some((prev_tm, prev_id)) = prev_instant {
                        let tm_diff = tm - prev_tm;

                        if processor.should_keep_instant(tm_diff) {
                            buf.extend_from_slice(&prev_tm.to_le_bytes());
                            buf.push(prev_id);
                            buf.push(instant_y);
                        }
                    }
                    prev_instant = Some((tm, id));
                }

                // Handle last instant event
                if let Some((tm, id)) = prev_instant {
                    buf.extend_from_slice(&tm.to_le_bytes());
                    buf.push(id);
                    buf.push(instant_y);
                }
                #[cfg(feature = "self-tracing")]
                drop(g3);

                let len = buf.len() as u32;
                res_buf.extend_from_slice(&len.to_le_bytes());
                res_buf.extend_from_slice(&buf);

                let len = range_buf.len() as u32;
                res_buf.extend_from_slice(&len.to_le_bytes());
                res_buf.extend_from_slice(&range_buf);

                let len = foreign_range_buf.len() as u32;
                res_buf.extend_from_slice(&len.to_le_bytes());
                res_buf.extend_from_slice(&foreign_range_buf);

                let (skipped_instant, skipped_range, total_instant, total_range) = processor.get_stats();
                let stats = EventsSkipStats {
                    skipped_instant,
                    skipped_range,
                    total_instant,
                    total_range,
                };

                debug!("Connection manager: sending range request response to {} for thread {}: start={}, end={}, instant data size={}, local range data size={}, cross-thread range data size={}. Skipped: instant {}/{}, range {}/{}",
                    addr, thread_ord_id, start, end, buf.len(), range_buf.len(), foreign_range_buf.len(), skipped_instant, total_instant, skipped_range, total_range);
                #[cfg(feature = "self-tracing")]
                let g4 = sparkles::range_event_start!("send response");
                permits.next().unwrap().send((*thread_ord_id, res_buf, stats));
            }
        }
    }
}
fn spawn_connection(addr: SocketAddr, events_tx: tokio::sync::mpsc::Sender<SparklesConnectionMessage>) {
    thread::Builder::new().name(String::from("Sparkles connection")).spawn(move || {
        #[cfg(feature = "self-tracing")]
        let g = sparkles::range_event_start!("Sparkles connection handler thread");
        let decoder = PacketDecoder::from_socket(addr);
        info!("Connected to Sparkles at {addr}");

        let events_tx2 = events_tx.clone();
        let mut thread_infos = HashMap::new();
        SparklesParser::new().parse_to_end(decoder, move |evs, thread_info, event_names| {
            #[cfg(feature = "self-tracing")]
            let g = sparkles::range_event_start!("got new events");
            if let Some(thread_name) = &thread_info.thread_name {
                let entry = thread_infos.entry(thread_info.thread_ord_id);
                match entry {
                    std::collections::hash_map::Entry::Vacant(e) => {
                        e.insert(thread_name.clone());
                        events_tx.blocking_send(SparklesConnectionMessage::UpdateThreadName {
                            thread_ord_id: thread_info.thread_ord_id,
                            thread_name: thread_name.clone(),
                        }).unwrap();
                    },
                    std::collections::hash_map::Entry::Occupied(mut e) => {
                        let existing_thread_name = e.get_mut();
                        if existing_thread_name != thread_name {
                            *existing_thread_name = thread_name.clone();
                            events_tx.blocking_send(SparklesConnectionMessage::UpdateThreadName {
                                thread_ord_id: thread_info.thread_ord_id,
                                thread_name: thread_name.clone(),
                            }).unwrap();
                        }
                    }
                }
            }
            #[cfg(feature = "self-tracing")]
            drop(g);
            events_tx.blocking_send(SparklesConnectionMessage::Events {
                thread_ord_id: thread_info.thread_ord_id,
                events: evs.to_vec(),
            }).unwrap();
        }, |thread_info, new_event_names| {
            events_tx2.blocking_send(SparklesConnectionMessage::UpdateEventNames {
                thread_ord_id: thread_info.thread_ord_id,
                event_names: new_event_names.iter().map(|(id, (name, _))| {
                    (*id, Arc::from(&**name))
                }).collect()
            }).unwrap();
        }).unwrap();
    }).unwrap();
}

pub enum SparklesConnectionMessage {
    Events {
        thread_ord_id: u64,
        events: Vec<ParsedEvent>,
    },
    UpdateThreadName {
        thread_ord_id: u64,
        thread_name: String,
    },
    UpdateEventNames {
        thread_ord_id: u64,
        event_names: HashMap<TracingEventId, Arc<str>>
    },
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct EventsSkipStats {
    skipped_instant: usize,
    skipped_range: usize,
    total_instant: usize,
    total_range: usize,
}
