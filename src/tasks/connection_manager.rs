use std::collections::{BTreeMap, HashMap, HashSet};
use std::iter::Sum;
use std::ops::{Add, AddAssign};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use axum::response::sse::Event;
use log::{error, info};
use serde::Serialize;
use slab::Slab;
use smallvec::SmallVec;
use sparkles_parser::parsed::ParsedEvent;
use sparkles_parser::TracingEventId;
use tokio::sync::mpsc::Receiver;
use crate::tasks::server::SharedDataWrapper;
use crate::tasks::sparkles_connection;
use crate::tasks::sparkles_connection::SparklesConnectionMessage;
use crate::tasks::ws_connection::MessageFromClient;

pub fn spawn(shared_data: SharedDataWrapper, client_msg_rx: Receiver<MessageFromClient>) {
    tokio::spawn(async move {
        if let Err(e) = run(shared_data, client_msg_rx).await {
            error!("Error in connection task: {e:?}");
        }
        info!("Connection task finished");
    });
}

pub async fn run(shared_data: SharedDataWrapper, mut client_msg_rx: Receiver<MessageFromClient>) -> anyhow::Result<()> {
    let mut active_connections = HashMap::new();
    let mut active_ranges_requests = Slab::new();
    loop {
        // Handle messages from the cwient
        if let Ok(msg) = client_msg_rx.try_recv() {
            info!("Connection manager: got message from client: {:?}", msg);
            match msg {
                MessageFromClient::Connect {
                    addr,
                    resp
                } => {
                    let mut guard = shared_data.0.lock();
                    if guard.active_connections.contains(&addr) {
                        let _ = resp.send(Err("Already connected".into()));
                        continue;
                    }

                    let _ = resp.send(Ok(()));
                    guard.active_connections.insert(addr);
                    let (msg_tx, msg_rx) = tokio::sync::mpsc::channel(100);
                    let client_storage = ClientStorage::new(msg_rx);
                    active_connections.insert(addr, client_storage);

                    thread::spawn(move || {
                        sparkles_connection::connect(addr, msg_tx);
                    });
                }
                MessageFromClient::RequestNewEvents {
                    start,
                    end,
                    resp
                } => {
                    active_ranges_requests.insert((resp, start, end));
                }
                MessageFromClient::GetEventNames {
                    addr,
                    thread,
                    resp
                } => {
                    if let Some(storage) = active_connections.get(&addr) {
                        if let Some(event_storage) = storage.thread_events.get(&thread) {
                            let event_names = event_storage.event_names.clone();
                            let _ = resp.send(event_names);
                        }
                    }
                }
                MessageFromClient::GetThreadNames {
                    addr,
                    resp
                } => {
                    if let Some(storage) = active_connections.get(&addr) {
                        let _ = resp.send(storage.thread_names.clone());
                    }
                }
                MessageFromClient::GetStorageStats {
                    resp
                } => {
                    let res = active_connections.values().map(|v| v.get_storage_stats())
                        .sum();
                    let _ = resp.send(res);
                }
            }
        }

        if client_msg_rx.is_closed() {
            info!("Connection manager: client message channel is closed, exiting");
            break;
        }

        // Handle incoming events
        let mut closed_connections = vec![];
        for (addr, storage) in active_connections.iter_mut() {
            let Some(msg_rx) = storage.msg_rx.as_mut() else {
                continue;
            };
            loop {
                match msg_rx.try_recv() {
                    Ok(msg) => {
                        match msg {
                            SparklesConnectionMessage::Events { thread_ord_id, events } => {
                                let storage = storage.thread_events
                                    .entry(thread_ord_id)
                                    .or_default();

                                for event in events {
                                    match event {
                                        ParsedEvent::Instant {
                                            tm,
                                            name_id
                                        } => {
                                            storage.instant_events.insert(tm, name_id);
                                        }
                                        ParsedEvent::Range {
                                            start,
                                            end,
                                            name_id,
                                            end_name_id,
                                        } => {
                                            match storage.range_events_starts.entry(start) {
                                                std::collections::btree_map::Entry::Vacant(entry) => {
                                                    let mut vec = SmallVec::new();
                                                    vec.push(storage.range_events.insert((start, name_id)));
                                                    entry.insert(vec);
                                                }
                                                std::collections::btree_map::Entry::Occupied(mut entry) => {
                                                    entry.get_mut().push(storage.range_events.insert((start, name_id)));
                                                }
                                            }
                                        }
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
                    Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                        break; // No more messages to process
                    }
                    Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                        info!("Connection manager: message channel for {} is closed, removing connection", addr);
                        closed_connections.push(*addr);
                        break; // Exit the loop for this connection
                    }
                }

            }
        }

        for addr in closed_connections {
            active_connections.get_mut(&addr).unwrap()
                .msg_rx = None;
        }

        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    Ok(())
}

pub struct ClientStorage {
    thread_events: HashMap<u64, EventStorage>,
    thread_names: HashMap<u64, String>,
    msg_rx: Option<Receiver<SparklesConnectionMessage>>,
}
impl ClientStorage {
    fn get_storage_stats(&self) -> StorageStats {
        let mut res = StorageStats::default();
        for storage in self.thread_events.values() {
            res.instant_events += storage.instant_events.len();
            res.range_events += storage.range_events.len();
        }
        res
    }
}

impl ClientStorage {
    pub fn new(msg_rx: Receiver<SparklesConnectionMessage>) -> Self {
        Self {
            thread_events: HashMap::new(),
            thread_names: HashMap::new(),
            msg_rx: Some(msg_rx),
        }
    }
}
#[derive(Default)]
pub struct EventStorage {
    event_names: HashMap<TracingEventId, Arc<str>>,

    instant_events: BTreeMap<u64, TracingEventId>,
    range_events: Slab<(u64, TracingEventId)>,
    range_events_starts: BTreeMap<u64, SmallVec<[usize; 2]>>,
}

#[derive(Debug, Default, Serialize)]
pub struct StorageStats {
    instant_events: usize,
    range_events: usize,
}

impl Add for StorageStats {
    type Output = Self;
    fn add(self, other: Self) -> Self {
        Self {
            range_events: self.range_events + other.range_events,
            instant_events: self.instant_events + other.instant_events,
        }
    }
}

impl Sum for StorageStats {
    fn sum<I: Iterator<Item=Self>>(iter: I) -> Self {
        iter.fold(StorageStats::default(), |a, b| a + b)
    }
}