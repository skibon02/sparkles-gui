use std::collections::{BTreeMap, HashMap};
use std::iter::Sum;
use std::ops::Add;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
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
}
impl ClientStorage {
    pub fn get_storage_stats(&self) -> StorageStats {
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
            msg_rx,
        }
    }
}
#[derive(Default)]
pub struct EventStorage {
    pub(crate) event_names: HashMap<TracingEventId, Arc<str>>,

    pub(crate) instant_events: BTreeMap<u64, TracingEventId>,
    pub(crate) range_events: Slab<(u64, TracingEventId, Option<TracingEventId>)>,
    pub(crate) range_events_starts: BTreeMap<u64, SmallVec<[usize; 2]>>,

    pub(crate) last_sync: Option<(Instant, u64)>,
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
