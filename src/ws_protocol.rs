use std::net::SocketAddr;
use serde::{Deserialize, Serialize};
use crate::tasks::connection_manager::StorageStats;

#[derive(Debug, Deserialize)]
pub enum MessageToServer {
    Connect {
        addr: SocketAddr
    },
    RequestNewRange {
        start: u64,
        end: u64,
    }
}


#[derive(Debug, Serialize)]
pub enum MessageFromServer {
    DiscoveredClients {
        clients: Vec<Vec<SocketAddr>>,
    },
    ConnectError(String),
    Stats(StorageStats),
    CurrentClientTimestamp(SocketAddr, u64),
    NewEvents {
        addr: SocketAddr,
        thread_ord_id: u64,
        data: Vec<u8>,
    },
}
