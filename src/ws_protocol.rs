use std::net::SocketAddr;
use serde::{Deserialize, Serialize};

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
}
