use std::collections::{BTreeMap, HashMap};
use std::iter::Sum;
use std::ops::Add;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
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
                    info!("Connection manager: added new range request for start: {}, end: {}", start, end);
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
                MessageFromClient::GetCurrentClientTimestamps {
                    resp
                } => {
                    for (addr, storage) in active_connections.iter() {
                        let now = Instant::now();
                        let mut best_tm = 0;
                        for (_, thread_storage) in storage.thread_events.iter() {
                            if let Some((last_sync_time, last_sync_tm)) = thread_storage.last_sync {
                                // adjust local time
                                let elapsed = now - last_sync_time;
                                let elapsed_ns = elapsed.as_nanos() as u64;
                                let adjusted_tm = last_sync_tm + elapsed_ns;
                                if adjusted_tm > best_tm {
                                    best_tm = adjusted_tm;
                                }
                            }
                        }

                        if best_tm != 0 {
                            resp.send((*addr, now, best_tm)).await?;
                        }
                    }
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

                                let last_event_tm = events.last();
                                if let Some(last_event) = last_event_tm {
                                    match last_event {
                                        ParsedEvent::Instant { tm, .. } => {
                                            storage.last_sync = Some((Instant::now(), *tm));
                                        }
                                        ParsedEvent::Range { end, .. } => {
                                            storage.last_sync = Some((Instant::now(), *end));
                                        }
                                    }
                                }
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
                                                    vec.push(storage.range_events.insert((end, name_id, end_name_id)));
                                                    entry.insert(vec);
                                                }
                                                std::collections::btree_map::Entry::Occupied(mut entry) => {
                                                    entry.get_mut().push(storage.range_events.insert((end, name_id, end_name_id)));
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


        // Handle active range requests
        let mut closed_ranges = vec![];
        for (idx, (resp, start, end)) in active_ranges_requests.iter_mut() {
            // Iterate over addresses
            for (client_addr, storage) in active_connections.iter() {
                // Iterate over threads
                for (thread_ord_id, thread_storage) in storage.thread_events.iter() {
                    // Encode data
                    let mut res_buf = Vec::new();

                    let mut buf = Vec::new();
                    for (tm, id) in thread_storage.request_instant_events(*start, *end) {
                        buf.extend_from_slice(&tm.to_le_bytes());
                        buf.push(id);
                    }
                    let len = buf.len() as u32;
                    res_buf.extend_from_slice(&len.to_le_bytes());
                    res_buf.extend_from_slice(&buf);

                    let mut buf = Vec::new();
                    for (start, end, start_id, end_id) in thread_storage.request_range_events(*start, *end) {
                        buf.extend_from_slice(&start.to_le_bytes());
                        buf.extend_from_slice(&end.to_le_bytes());
                        buf.push(start_id);
                        if let Some(end_id) = end_id {
                            buf.push(end_id);
                        } else {
                            buf.push(255); // Use 255 to indicate no end event
                        }
                    }
                    res_buf.extend_from_slice(&buf);

                    info!("Connection manager: sending range request response to {} for thread {}: start={}, end={}, data size={}",
                        client_addr, thread_ord_id, start, end, buf.len());
                    resp.send((*client_addr, *thread_ord_id, res_buf)).await?;
                }
            }
            closed_ranges.push(idx);
        }
        for idx in closed_ranges {
            active_ranges_requests.remove(idx);
            info!("Connection manager: removed range request for index {}", idx);
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
    range_events: Slab<(u64, TracingEventId, Option<TracingEventId>)>,
    range_events_starts: BTreeMap<u64, SmallVec<[usize; 2]>>,

    last_sync: Option<(Instant, u64)>,
}

impl EventStorage {
    pub fn request_instant_events(&self, start: u64, end: u64) -> impl Iterator<Item = (u64, TracingEventId)> + '_ {
        self.instant_events.range(start..end).map(|(tm, name_id)| (*tm, *name_id))
    }

    pub fn request_range_events(&self, start: u64, end: u64) -> impl Iterator<Item = (u64, u64, TracingEventId, Option<TracingEventId>)> + '_ {
        self.range_events_starts.range(..end).flat_map(move |(start_time, ids)| {
            ids.iter().filter_map(move |&id| {
                let (end_time, name_id, end_name_id) = self.range_events.get(id)?;
                if *start_time < end && *end_time > start {
                    Some((*start_time, *end_time, *name_id, *end_name_id))
                } else {
                    None
                }
            })
        })
    }
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