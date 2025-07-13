pub mod storage;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::thread;
use std::time::Instant;
use log::{error, info};
use smallvec::SmallVec;
use sparkles_parser::packet_decoder::PacketDecoder;
use sparkles_parser::parsed::ParsedEvent;
use sparkles_parser::{SparklesParser, TracingEventId};
use tokio::select;
use crate::shared::{SparklesConnection, WsToSparklesMessage};
use crate::tasks::sparkles_connection::storage::ClientStorage;

pub fn spawn_conn_handler(addr: SocketAddr, conn: SparklesConnection) {
    let (msg_tx, msg_rx) = tokio::sync::mpsc::channel(100);
    let client_storage = ClientStorage::new(msg_rx);

    spawn_connection(addr, msg_tx);

    let _ = tokio::spawn(async move {
        if let Err(e) = run(addr, conn, client_storage).await {;
            error!("Error running Sparkles connection: {e}");
        }
        else {
            info!("Sparkles connection handler for {addr} finished successfully");
        }
    });
}

struct ActiveRangeRequest {
    resp: tokio::sync::mpsc::Sender<(u64, Vec<u8>)>,
    start: u64,
    end: u64,
}

async fn run(addr: SocketAddr, mut conn: SparklesConnection, mut storage: ClientStorage) -> anyhow::Result<()> {
    let mut active_sending_requests: HashMap<u32, ActiveRangeRequest> = HashMap::new();
    let (mut dummy_tx, _dummy_rx) = tokio::sync::mpsc::channel(1);
    let mut is_disconnected = false;

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
                        thread,
                        resp
                    } => {
                        if let Some(event_storage) = storage.thread_events.get(&thread) {
                            let event_names = event_storage.event_names.clone();
                            let _ = resp.send(event_names);
                        }
                    }
                    WsToSparklesMessage::GetThreadNames {
                        resp
                    } => {
                        let _ = resp.send(storage.thread_names.clone());
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

                    is_disconnected = true;
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
                let mut res_buf = Vec::new();

                let mut buf = Vec::new();
                for (tm, id) in thread_storage.request_instant_events(start, end) {
                    buf.extend_from_slice(&tm.to_le_bytes());
                    buf.push(id);
                }
                let len = buf.len() as u32;
                res_buf.extend_from_slice(&len.to_le_bytes());
                res_buf.extend_from_slice(&buf);

                let mut buf = Vec::new();
                for (start, end, start_id, end_id) in thread_storage.request_range_events(start, end) {
                    buf.extend_from_slice(&start.to_le_bytes());
                    buf.extend_from_slice(&end.to_le_bytes());
                    buf.push(start_id);
                    if let Some(end_id) = end_id {
                        buf.push(end_id);
                    } else {
                        buf.push(255);
                    }
                }
                res_buf.extend_from_slice(&buf);

                info!("Connection manager: sending range request response to {} for thread {}: start={}, end={}, data size={}",
                        addr, thread_ord_id, start, end, buf.len());
                resp.send((*thread_ord_id, res_buf)).await?;
            }
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