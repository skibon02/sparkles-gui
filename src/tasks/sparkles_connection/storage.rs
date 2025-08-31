use std::collections::{BTreeMap, HashMap};
use std::iter::Sum;
use std::ops::Add;
use std::sync::Arc;
use std::time::Instant;
use serde::Serialize;
use slab::Slab;
use smallvec::SmallVec;
use sparkles_parser::TracingEventId;
use tokio::sync::mpsc::Receiver;
use crate::tasks::sparkles_connection::SparklesConnectionMessage;

pub struct ClientStorage {
    pub thread_events: HashMap<u64, EventStorage>,
    pub thread_names: HashMap<u64, String>,
    pub msg_rx: Receiver<SparklesConnectionMessage>,

    pub conn_timestamps: Option<ConnectionTimestamps>,
}

pub struct ConnectionTimestamps {
    pub last_sync: (Instant, u64),
    pub min_tm: u64,
    pub max_tm: u64,
}
impl ClientStorage {
    pub fn get_storage_stats(&self) -> StorageStats {
        let mut res = StorageStats::default();
        for storage in self.thread_events.values() {
            res.instant_events += storage.instant_events.len();
            res.range_events += storage.range_events.len() + storage.cross_thread_range_events.len();
        }
        res
    }
}

impl ClientStorage {
    pub fn new(msg_rx: Receiver<SparklesConnectionMessage>) -> Self {
        Self {
            thread_events: HashMap::new(),
            thread_names: HashMap::new(),
            conn_timestamps: None,
            msg_rx,
        }
    }
}
#[derive(Default)]
pub struct RangeEventStorage<T = ()> {
    events: Slab<(u64, TracingEventId, Option<TracingEventId>, T)>,
    starts_index: BTreeMap<u64, SmallVec<[usize; 2]>>,
}

impl<T: Copy> RangeEventStorage<T> {
    pub fn insert(&mut self, start: u64, end: u64, name_id: TracingEventId, end_name_id: Option<TracingEventId>, extra: T) -> usize {
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

    pub fn request_events(&self, start: u64, end: u64) -> impl Iterator<Item = (u64, u64, TracingEventId, Option<TracingEventId>, T)> + '_ {
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
    pub fn insert_simple(&mut self, start: u64, end: u64, name_id: TracingEventId, end_name_id: Option<TracingEventId>) -> usize {
        self.insert(start, end, name_id, end_name_id, ())
    }

    pub fn request_events_simple(&self, start: u64, end: u64) -> impl Iterator<Item = (u64, u64, TracingEventId, Option<TracingEventId>)> + '_ {
        self.request_events(start, end).map(|(start_time, end_time, name_id, end_name_id, _)| (start_time, end_time, name_id, end_name_id))
    }
}

#[derive(Default)]
pub struct EventStorage {
    pub(crate) event_names: HashMap<TracingEventId, Arc<str>>,

    pub(crate) instant_events: BTreeMap<u64, TracingEventId>,
    
    pub(crate) range_events: RangeEventStorage<()>,

    pub(crate) cross_thread_range_events: RangeEventStorage<u64>,
}

impl EventStorage {
    /// Events are guaranteed to be in order of timestamp
    pub fn request_instant_events(&self, start: u64, end: u64) -> impl Iterator<Item = (u64, TracingEventId)> + '_ {
        self.instant_events.range(start..end).map(|(tm, name_id)| (*tm, *name_id))
    }

    /// Events are guaranteed to be in order of start time
    pub fn request_range_events(&self, start: u64, end: u64) -> impl Iterator<Item = (u64, u64, TracingEventId, Option<TracingEventId>)> + '_ {
        self.range_events.request_events_simple(start, end)
    }

    /// Events are guaranteed to be in order of start time
    pub fn request_cross_thread_range_events(&self, start: u64, end: u64) -> impl Iterator<Item = (u64, u64, TracingEventId, Option<TracingEventId>, u64)> + '_ {
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
