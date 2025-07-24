use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::ops::Deref;
use std::sync::Arc;
use std::time::Instant;
use parking_lot::Mutex;
use sparkles_parser::TracingEventId;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use crate::tasks::sparkles_connection::EventsSkipStats;
use crate::tasks::sparkles_connection::storage::StorageStats;

#[derive(Clone)]
pub struct SparklesWebsocketShared {
    inner: Arc<Mutex<SparklesWebsocketSharedInner>>
}

pub struct SparklesWebsocketSharedInner {
    sparkles_connections: HashMap<u32, (UnboundedSender<(u32, WsToSparklesMessage)>, SocketAddr)>,
    ws_connections: HashMap<u32, UnboundedSender<(u32, SparklesToWsMessage)>>,
    disconnected_connections: HashSet<u32>, // Track disconnected connections

    new_sparkles_connection_id: u32,
    new_ws_connection_id: u32,

    control_msg_rx: Option<UnboundedReceiver<WsControlMessage>>,
    control_msg_tx: UnboundedSender<WsControlMessage>,
}

impl SparklesWebsocketSharedInner {
    pub fn new() -> Self {
        let (control_msg_tx, control_msg_rx) = unbounded_channel();

        Self {
            sparkles_connections: HashMap::new(),
            ws_connections: HashMap::new(),
            disconnected_connections: HashSet::new(),
            new_sparkles_connection_id: 0,
            new_ws_connection_id: 0,
            control_msg_rx: Some(control_msg_rx),
            control_msg_tx,
        }
    }
}

impl SparklesWebsocketShared {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(SparklesWebsocketSharedInner::new()))
        }
    }

    pub fn new_sparkles_connection(&self, addr: SocketAddr) -> SparklesConnection {
        let (sender, receiver) = unbounded_channel();
        let mut guard = self.inner.lock();
        let id = guard.new_sparkles_connection_id;
        guard.new_sparkles_connection_id += 1;
        guard.sparkles_connections.insert(id, (sender, addr));
        SparklesConnection {
            senders: self.clone(),
            receiver,
            id,
            addr
        }
    }

    pub fn new_ws_connection(&self) -> WsConnection {
        let (sender, receiver) = unbounded_channel();
        let mut guard = self.inner.lock();
        let id = guard.new_ws_connection_id;
        guard.new_ws_connection_id += 1;
        guard.ws_connections.insert(id, sender);
        WsConnection {
            control_msg_tx: guard.control_msg_tx.clone(),
            shared: self.clone(),
            receiver,
            id,
        }
    }

    /// Must be called from ws connection manager
    pub fn take_control_msg_rx(&self) -> Option<UnboundedReceiver<WsControlMessage>> {
        let mut guard = self.inner.lock();
        guard.control_msg_rx.take()
    }

    /// Must be called from sparkles connection manager
    pub fn send_control_message(&self, msg: WsControlMessage) -> anyhow::Result<()> {
        let guard = self.inner.lock();
        guard.control_msg_tx.send(msg).map_err(|e| anyhow::anyhow!("Failed to send control message: {}", e))
    }

    pub fn active_sparkles_connections(&self) -> Vec<(u32, SocketAddr)> {
        let guard = self.inner.lock();
        guard.sparkles_connections.iter()
            .map(|(&id, &(ref _sender, addr))| (id, addr))
            .collect()
    }
    
    pub fn all_sparkles_connections(&self) -> Vec<(u32, SocketAddr, bool)> {
        let guard = self.inner.lock();
        let mut connections = Vec::new();
        
        // Add online connections
        for (&id, &(ref _sender, addr)) in guard.sparkles_connections.iter() {
            let online = !guard.disconnected_connections.contains(&id);
            connections.push((id, addr, online));
        }
        
        connections
    }
    
    pub fn mark_connection_disconnected(&self, connection_id: u32) {
        let mut guard = self.inner.lock();
        guard.disconnected_connections.insert(connection_id);
    }
}

pub struct WsConnection {
    shared: SparklesWebsocketShared,
    receiver: UnboundedReceiver<(u32, SparklesToWsMessage)>,
    id: u32,
    control_msg_tx: UnboundedSender<WsControlMessage>,
}

impl Deref for WsConnection {
    type Target = SparklesWebsocketShared;

    fn deref(&self) -> &Self::Target {
        &self.shared
    }
}
impl WsConnection {
    pub fn id(&self) -> u32 {
        self.id
    }

    pub async fn recv_message(&mut self) -> anyhow::Result<(u32, SparklesToWsMessage)>{
        match self.receiver.recv().await {
            Some(msg) => Ok(msg), // Replace 0 with actual device ID if needed
            None => Err(anyhow::anyhow!("Connection closed"))
        }
    }

    fn send_message(&mut self, id: u32, msg: WsToSparklesMessage) -> anyhow::Result<()> {
        let guard = self.shared.inner.lock();
        if let Some(sender) = guard.sparkles_connections.get(&id).map(|v| &v.0) {
            sender.send((id, msg)).map_err(|e| anyhow::anyhow!("Failed to send message: {}", e))
        } else {
            Err(anyhow::anyhow!("No connection with ID {}", id))
        }
    }

    fn send_control_message(&self, msg: WsControlMessage) -> anyhow::Result<()> {
        self.control_msg_tx.send(msg).map_err(|e| anyhow::anyhow!("Failed to send control message: {}", e))
    }

    pub async fn connect(&self, addr: SocketAddr) -> anyhow::Result<Result<u32, String>> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let msg = WsControlMessage::Connect { addr, resp: sender };
        self.send_control_message(msg)?;
        receiver.await.map_err(|e| anyhow::anyhow!("Failed to receive response: {}", e))
    }

    pub async fn get_thread_names(&mut self, id: u32) -> anyhow::Result<HashMap<u64, String>> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let msg = WsToSparklesMessage::GetThreadNames { resp: sender };
        self.send_message(id, msg)?;
        receiver.await.map_err(|e| anyhow::anyhow!("Failed to receive response: {}", e))
    }

    pub async fn set_thread_name(&mut self, id: u32, thread_id: u64, name: String) -> anyhow::Result<()> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let msg = WsToSparklesMessage::SetThreadName { thread_id, name, resp: sender };
        self.send_message(id, msg)?;
        receiver.await.map_err(|e| anyhow::anyhow!("Failed to receive response: {}", e))
    }

    pub async fn get_event_names(&mut self, id: u32, thread: u64) -> anyhow::Result<HashMap<TracingEventId, Arc<str>>> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let msg = WsToSparklesMessage::GetEventNames { thread, resp: sender };
        self.send_message(id, msg)?;
        receiver.await.map_err(|e| anyhow::anyhow!("Failed to receive response: {}", e))
    }

    pub async fn get_storage_stats(&mut self, id: u32) -> anyhow::Result<StorageStats> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let msg = WsToSparklesMessage::GetStorageStats { resp: sender };
        self.send_message(id, msg)?;
        receiver.await.map_err(|e| anyhow::anyhow!("Failed to receive response: {}", e))
    }

    pub async fn get_connection_timestamps(&mut self, id: u32) -> anyhow::Result<Option<(u64, u64, u64)>> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let msg = WsToSparklesMessage::GetConnectionTimestamps { resp: sender };
        self.send_message(id, msg)?;
        receiver.await.map_err(|e| anyhow::anyhow!("Failed to receive response: {}", e))
    }

    pub async fn request_new_events(&mut self, id: u32, start: u64, end: u64) -> anyhow::Result<tokio::sync::mpsc::Receiver<(u64, Vec<u8>, EventsSkipStats)>> {
        let (sender, receiver) = tokio::sync::mpsc::channel(5);
        let msg = WsToSparklesMessage::RequestNewRange { start, end, events_channel: sender };
        self.send_message(id, msg)?;
        Ok(receiver)
    }
}

impl Drop for WsConnection {
    fn drop(&mut self) {
        let mut guard = self.shared.inner.lock();
        guard.ws_connections.remove(&self.id);
    }
}

pub struct SparklesConnection {
    senders: SparklesWebsocketShared,
    receiver: UnboundedReceiver<(u32, WsToSparklesMessage)>,
    id: u32,
    addr: SocketAddr,
}

impl Deref for SparklesConnection {
    type Target = SparklesWebsocketShared;

    fn deref(&self) -> &Self::Target {
        &self.senders
    }
}

impl SparklesConnection {
    pub fn id(&self) -> u32 {
        self.id
    }

    pub async fn recv_message(&mut self) -> anyhow::Result<(u32, WsToSparklesMessage)> {
        match self.receiver.recv().await {
            Some(msg) => Ok(msg), // Replace 0 with actual device ID if needed
            None => Err(anyhow::anyhow!("Connection closed"))
        }
    }

    fn send_message(&mut self, id: u32, msg: SparklesToWsMessage) -> anyhow::Result<()> {
        let guard = self.senders.inner.lock();
        if let Some(sender) = guard.ws_connections.get(&id) {
            sender.send((id, msg)).map_err(|e| anyhow::anyhow!("Failed to send message: {}", e))
        } else {
            Err(anyhow::anyhow!("No connection with ID {}", id))
        }
    }

    // pub fn broadcast_message(&mut self, msg: SparklesToWsMessage) -> anyhow::Result<()> {
    //     let guard = self.senders.inner.lock();
    //     for sender in guard.ws_connections.values() {
    //         sender.send((self.id, msg.clone())).map_err(|e| anyhow::anyhow!("Failed to broadcast message: {}", e))?;
    //     }
    //     Ok(())
    // }
}

impl Drop for SparklesConnection {
    fn drop(&mut self) {
        let mut guard = self.senders.inner.lock();
        guard.sparkles_connections.remove(&self.id);
    }
}

#[derive(Debug)]
pub enum WsControlMessage {
    Connect {
        addr: SocketAddr,
        resp: tokio::sync::oneshot::Sender<Result<u32, String>>
    },
}


#[derive(Debug)]
pub enum SparklesToWsMessage {
}

#[derive(Debug)]
pub enum WsToSparklesMessage {
    GetThreadNames {
        resp: tokio::sync::oneshot::Sender<HashMap<u64, String>>,
    },
    SetThreadName {
        thread_id: u64,
        name: String,
        resp: tokio::sync::oneshot::Sender<()>,
    },
    GetEventNames {
        thread: u64,
        resp: tokio::sync::oneshot::Sender<HashMap<TracingEventId, Arc<str>>>,
    },
    RequestNewRange {
        start: u64,
        end: u64,
        events_channel: tokio::sync::mpsc::Sender<(u64, Vec<u8>, EventsSkipStats)>,
    },
    GetConnectionTimestamps {
        resp: tokio::sync::oneshot::Sender<Option<(u64, u64, u64)>>,
    },
    GetStorageStats {
        resp: tokio::sync::oneshot::Sender<StorageStats>,
    },
}

