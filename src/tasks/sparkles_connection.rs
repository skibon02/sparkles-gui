pub mod storage;
pub mod event_skipper;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::thread;
use std::time::Instant;
use log::{error, info};
use smallvec::SmallVec;
use sparkles::flush_thread_local;
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
                            let thread_storage = storage.thread_events
                                .entry(thread_ord_id)
                                .or_default();

                            let mut event_timestamps = Vec::new();

                            for event in events {
                                match event {
                                    ParsedEvent::Instant {
                                        tm,
                                        name_id
                                    } => {
                                        event_timestamps.push(tm);
                                        thread_storage.instant_events.insert(tm, name_id);
                                    }
                                    ParsedEvent::Range {
                                        start,
                                        end,
                                        name_id,
                                        end_name_id,
                                    } => {
                                        event_timestamps.push(start);
                                        event_timestamps.push(end);
                                        
                                        match thread_storage.range_events_starts.entry(start) {
                                            std::collections::btree_map::Entry::Vacant(entry) => {
                                                let mut vec = SmallVec::new();
                                                vec.push(thread_storage.range_events.insert((end, name_id, end_name_id)));
                                                entry.insert(vec);
                                            }
                                            std::collections::btree_map::Entry::Occupied(mut entry) => {
                                                entry.get_mut().push(thread_storage.range_events.insert((end, name_id, end_name_id)));
                                            }
                                        }
                                    }
                                }
                            }

                            if !event_timestamps.is_empty() {
                                let now = Instant::now();
                                let last_event_tm = *event_timestamps.iter().max().unwrap();
                                
                                if let Some(conn_ts) = &mut storage.conn_timestamps {
                                    conn_ts.last_sync = (now, last_event_tm);
                                    conn_ts.min_tm = conn_ts.min_tm.min(*event_timestamps.iter().min().unwrap());
                                    conn_ts.max_tm = conn_ts.max_tm.max(*event_timestamps.iter().max().unwrap());
                                } else {
                                    let min_tm = *event_timestamps.iter().min().unwrap();
                                    let max_tm = *event_timestamps.iter().max().unwrap();
                                    storage.conn_timestamps = Some(storage::ConnectionTimestamps {
                                        last_sync: (now, last_event_tm),
                                        min_tm,
                                        max_tm,
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

        if let Some(k) = active_sending_requests.keys().next().cloned() {
            let ActiveRangeRequest {
                resp,
                start,
                end,
            } = active_sending_requests.remove(&k).unwrap();
            for (thread_ord_id, thread_storage) in storage.thread_events.iter() {
                let g = sparkles_macro::range_event_start!("request thread events");
                let mut res_buf = Vec::new();

                let mut buf = Vec::new();

                let gc = sparkles_macro::range_event_start!("count events");
                let instant_event_cnt = thread_storage.request_instant_events(start, end).count();
                let range_event_cnt = thread_storage.request_range_events(start, end).count();
                drop(gc);
                
                let skip_thr = (end - start) / 2000; // assume 2000px horizontal resolution, use as skip threshold
                let mut processor = EventSkippingProcessor::new(skip_thr, MAX_EV_CNT, instant_event_cnt, range_event_cnt);

                let mut active_ranges: Vec<(u64, u8)> = Vec::new(); // (end_time, y_position)
                let mut used_y_levels = [false; 256]; // Track which Y levels are in use
                let mut range_buf = Vec::new();

                // Process range events first to find max Y position
                let g2 = sparkles_macro::range_event_start!("process range events");
                let mut max_range_y = 0u8;
                let mut prev_range_start: Option<u64> = None;
                
                for (range_start, range_end, start_id, end_id) in thread_storage.request_range_events(start, end) {
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

                        // Serialize range event
                        range_buf.extend_from_slice(&range_start.to_le_bytes());
                        range_buf.extend_from_slice(&range_end.to_le_bytes());
                        range_buf.push(start_id);
                        if let Some(end_id) = end_id {
                            range_buf.push(end_id);
                        } else {
                            range_buf.push(255);
                        }
                        range_buf.push(y_pos);
                    }
                    prev_range_start = Some(range_start);
                }
                drop(g2);

                // Process instant events - put them all at max_range_y + 1
                let g3 = sparkles_macro::range_event_start!("process instant events");
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
                drop(g3);
                
                let len = buf.len() as u32;
                res_buf.extend_from_slice(&len.to_le_bytes());
                res_buf.extend_from_slice(&buf);
                
                res_buf.extend_from_slice(&range_buf);
                
                let (skipped_instant, skipped_range, total_instant, total_range) = processor.get_stats();
                let stats = EventsSkipStats {
                    skipped_instant,
                    skipped_range,
                    total_instant,
                    total_range,
                };

                drop(g);
                info!("Connection manager: sending range request response to {} for thread {}: start={}, end={}, instant data size={}, range data size={}. Skipped: instant {}/{}, range {}/{}",
                        addr, thread_ord_id, start, end, buf.len(), range_buf.len(), skipped_instant, total_instant, skipped_range, total_range);
                resp.send((*thread_ord_id, res_buf, stats)).await?;
            }
            flush_thread_local();
        }
    }
}
fn spawn_connection(addr: SocketAddr, events_tx: tokio::sync::mpsc::Sender<SparklesConnectionMessage>) {
    thread::spawn(move || {
        let decoder = PacketDecoder::from_socket(addr);
        info!("Connected to Sparkles at {addr}");

        let events_tx2 = events_tx.clone();
        let mut thread_infos = HashMap::new();
        SparklesParser::new().parse_to_end(decoder, move |evs, thread_info, event_names| {
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
    });
}

enum SparklesConnectionMessage {
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
