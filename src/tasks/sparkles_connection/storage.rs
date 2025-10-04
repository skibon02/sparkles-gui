use std::collections::{BTreeMap, HashMap, VecDeque};
use std::iter::Sum;
use std::ops::Add;
use std::sync::Arc;
use std::time::Instant;
use serde::Serialize;
use slab::Slab;
use smallvec::SmallVec;
use sparkles_parser::parser::thread_parser::EventNamesStore;
use tokio::sync::mpsc::Receiver;
use crate::tasks::sparkles_connection::{ChannelId, SparklesConnectionMessage};

pub type GeneralEventNameId = u16;
pub type GeneralEventNamesStore = HashMap<GeneralEventNameId, Arc<str>>;

pub struct ClientStorage {
    pub channel_events: HashMap<ChannelId, ChannelEventsStorage>,
    pub channel_names: HashMap<ChannelId, Arc<str>>,
    pub msg_rx: Receiver<SparklesConnectionMessage>,

    pub conn_timestamps: Option<ConnectionTimestamps>,
}

impl ClientStorage {
    pub fn update_conn_timestamps(&mut self, min_tm: Option<u64>, max_tm: Option<u64>) {
        if let Some(min) = min_tm && let Some(max) = max_tm {
            let now = Instant::now();
            let last_event_tm = max;

            if let Some(conn_ts) = &mut self.conn_timestamps {
                conn_ts.last_sync = (now, last_event_tm);
                conn_ts.min_tm = conn_ts.min_tm.min(min);
                conn_ts.max_tm = conn_ts.max_tm.max(max);
            } else {
                self.conn_timestamps = Some(ConnectionTimestamps {
                    last_sync: (now, last_event_tm),
                    min_tm: min,
                    max_tm: max,
                });
            }
        }
    }
}

pub struct ConnectionTimestamps {
    pub last_sync: (Instant, u64),
    pub min_tm: u64,
    pub max_tm: u64,
}
impl ClientStorage {
    pub fn get_storage_stats(&self) -> StorageStats {
        let mut res = StorageStats::default();
        for storage in self.channel_events.values() {
            res.instant_events += storage.instant_events.len();
            res.range_events += storage.range_events.len() + storage.cross_thread_range_events.len();
        }
        res
    }
}

impl ClientStorage {
    pub fn new(msg_rx: Receiver<SparklesConnectionMessage>) -> Self {
        Self {
            channel_events: HashMap::new(),
            channel_names: HashMap::new(),
            conn_timestamps: None,
            msg_rx,
        }
    }
}
#[derive(Default)]
pub struct RangeEventStorage<T = ()> {
    events: Slab<(u64, GeneralEventNameId, Option<GeneralEventNameId>, T)>,
    starts_index: BTreeMap<u64, SmallVec<[usize; 2]>>,
}

impl<T: Copy> RangeEventStorage<T> {
    pub fn insert(&mut self, start: u64, end: u64, name_id: GeneralEventNameId, end_name_id: Option<GeneralEventNameId>, extra: T) -> usize {
        let id = self.events.insert((end, name_id, end_name_id, extra));
        match self.starts_index.entry(start) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                let mut vec = SmallVec::new();
                vec.push(id);
                entry.insert(vec);
            }
            std::collections::btree_map::Entry::Occupied(mut entry) => {
                entry.get_mut().push(id);
            }
        }
        id
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn request_events(&self, start: u64, end: u64) -> impl Iterator<Item = (u64, u64, GeneralEventNameId, Option<GeneralEventNameId>, T)> + '_ {
        self.starts_index.range(..end).flat_map(move |(start_time, ids)| {
            ids.iter().filter_map(move |&id| {
                let (end_time, name_id, end_name_id, extra) = self.events.get(id)?;
                if *start_time < end && *end_time > start {
                    Some((*start_time, *end_time, *name_id, *end_name_id, *extra))
                } else {
                    None
                }
            })
        })
    }
}

impl RangeEventStorage<()> {
    pub fn insert_simple(&mut self, start: u64, end: u64, name_id: GeneralEventNameId, end_name_id: Option<GeneralEventNameId>) -> usize {
        self.insert(start, end, name_id, end_name_id, ())
    }

    pub fn request_events_simple(&self, start: u64, end: u64) -> impl Iterator<Item = (u64, u64, GeneralEventNameId, Option<GeneralEventNameId>)> + '_ {
        self.request_events(start, end).map(|(start_time, end_time, name_id, end_name_id, _)| (start_time, end_time, name_id, end_name_id))
    }
}

/// Instant event ordered by timestamp
#[derive(Copy, Clone, Debug)]
pub struct StoredInstantEvent {
    pub tm: u64,
    pub name_id: GeneralEventNameId,
}

impl StoredInstantEvent {
    pub fn new(tm: u64, name_id: GeneralEventNameId) -> Self {
        Self { tm, name_id }
    }
}

impl PartialEq for StoredInstantEvent {
    fn eq(&self, other: &Self) -> bool {
        self.tm == other.tm
    }
}
impl Eq for StoredInstantEvent {}
impl PartialOrd for StoredInstantEvent {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.tm.cmp(&other.tm))
    }
}
impl Ord for StoredInstantEvent {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.tm.cmp(&other.tm)
    }
}

#[derive(Default)]
pub struct ChannelEventsStorage {
    event_names: GeneralEventNamesStore,
    instant_events: VecDeque<StoredInstantEvent>,
    range_events: RangeEventStorage<()>,
    cross_thread_range_events: RangeEventStorage<u64>,
}

impl ChannelEventsStorage {
    pub fn update_event_names(&mut self, names: GeneralEventNamesStore) {
        self.event_names = names;
    }

    pub fn event_names(&self) -> HashMap<GeneralEventNameId, Arc<str>> {
        self.event_names.clone()
    }

    /// Insert a new instant event
    pub fn insert_instant_event(&mut self, tm: u64, name_id: GeneralEventNameId) {
        let event = StoredInstantEvent::new(tm, name_id);
        match self.instant_events.back() {
            Some(last) if *last <= event => {
                // Fast path: append to the end
                self.instant_events.push_back(event);
            }
            _ => {
                // Slow path: insert in sorted order
                let pos = self.instant_events.partition_point(|e| *e < event);
                self.instant_events.insert(pos, event);
            }
        }
    }

    /// Request events in range [start, end)
    pub fn request_instant_events(&self, start: u64, end: u64) -> impl Iterator<Item = StoredInstantEvent> + '_ {
        let start = self.instant_events.partition_point(|e| e.tm < start);
        let end = self.instant_events.partition_point(|e| e.tm < end);
        self.instant_events.iter().skip(start).take(end - start).copied()
    }

    /// Insert a new range event. If `start_thread_id` is Some, it is treated as a cross-thread event
    pub fn insert_range_event(&mut self, start: u64, end: u64, name_id: GeneralEventNameId, end_name_id: Option<GeneralEventNameId>, start_thread_id: Option<u64>) -> usize {
        if let Some(start_thread_id) = start_thread_id {
            self.cross_thread_range_events.insert(start, end, name_id, end_name_id, start_thread_id)
        } else {
            self.range_events.insert_simple(start, end, name_id, end_name_id)
        }
    }

    /// Events are guaranteed to be in order of start time
    pub fn request_range_events(&self, start: u64, end: u64) -> impl Iterator<Item = (u64, u64, GeneralEventNameId, Option<GeneralEventNameId>)> + '_ {
        self.range_events.request_events_simple(start, end)
    }

    /// Events are guaranteed to be in order of start time
    pub fn request_cross_thread_range_events(&self, start: u64, end: u64) -> impl Iterator<Item = (u64, u64, GeneralEventNameId, Option<GeneralEventNameId>, u64)> + '_ {
        self.cross_thread_range_events.request_events(start, end)
    }
}

#[derive(Clone, Debug, Serialize, Default)]
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
