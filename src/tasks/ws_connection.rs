use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::{Duration, Instant};
use axum::body::Bytes;
use axum::extract::ws::{Message, Utf8Bytes, WebSocket};
use log::{error, info, warn};
use tokio::time::interval;
use crate::shared::WsConnection;
use crate::tasks::sparkles_connection::EventsSkipStats;
use crate::tasks::sparkles_connection::storage::StorageStats;
use crate::tasks::web_server::DiscoveryShared;

pub async fn handle_socket(mut socket: WebSocket, shared_data: DiscoveryShared, mut conn: WsConnection) -> anyhow::Result<()> {
    info!("New WebSocket connection: {}", conn.id());
    let mut discover_list_ticker = interval(Duration::from_millis(400));
    let mut active_connections_ticker = interval(Duration::from_millis(100));
    let mut sync_ticker = interval(Duration::from_millis(200));

    let start_time = Instant::now();

    let mut last_msg_id = 0;

    let mut is_channel_registered = false;
    let (mut dummy_tx, dummy_rx) = tokio::sync::mpsc::channel(1);

    let mut event_data_rx_channel = dummy_rx;
    let mut current_sparkles_id = 0;
    loop {
        tokio::select! {
            msg = socket.recv() => {
                let Some(msg) = msg else {
                    error!("Client disconnected!");
                    return Ok(());
                };
                
                if let Ok(msg) = msg {
                    match msg {
                        Message::Text(text) => {
                            match serde_json::from_str::<MessageToServer>(&text) {
                                Ok(msg_to_server) => {
                                    match msg_to_server {
                                        MessageToServer::Connect { addr } => {
                                            match conn.connect(addr).await? {
                                                Ok(id) => {
                                                    send_websocket(&mut socket, MessageFromServer::Connected { id, addr }).await?;
                                                }
                                                Err(msg) => {
                                                    let _ = send_websocket(&mut socket, MessageFromServer::ConnectError(msg.to_string())).await;
                                                }
                                            }
                                        }
                                        MessageToServer::RequestNewRange { conn_id, start, end } => {
                                            if is_channel_registered {
                                                send_websocket(&mut socket, MessageFromServer::ConnectError("Already waiting for a range".into())).await?;
                                            }
                                            else {
                                                let resp_rx = conn.request_new_events(conn_id, start, end).await?;

                                                info!("Channel registered!");
                                                event_data_rx_channel = resp_rx;
                                                current_sparkles_id = conn_id;
                                                is_channel_registered = true;
                                            }
                                        }
                                        MessageToServer::SetThreadName { conn_id, thread_id, name } => {
                                            match conn.set_thread_name(conn_id, thread_id, name.clone()).await {
                                                Ok(_) => {
                                                    info!("Thread name set for connection {}, thread {}: {}", conn_id, thread_id, name);
                                                }
                                                Err(e) => {
                                                    warn!("Failed to set thread name: {}", e);
                                                }
                                            }
                                        }
                                    }
                                }
                                Err(e) => {
                                    error!("Failed to deserialize message from client: {e}. Message: {text}");
                                }
                            }
                        }
                        Message::Binary(data) => {
                            info!("Received binary message: {data:?}");
                        }
                        Message::Ping(ping) => {
                            socket.send(Message::Pong(ping)).await.unwrap_or_else(|e| {
                                error!("Failed to send Pong response: {e}");
                            })
                        }
                        Message::Pong(_) => {
                            continue;
                        }
                        Message::Close(_) => {
                            warn!("Client closed the connection");
                            return Ok(());
                        }
                    }
                } else {
                    return Ok(());
                };
            }
            _ = discover_list_ticker.tick() => {
                let clients = shared_data.0.lock().discovered_clients.clone();
                let msg = MessageFromServer::DiscoveredClients {clients};
                let json = match serde_json::to_string(&msg) {
                    Ok(json) => json,
                    Err(e) => {
                        error!("Failed to serialize discovered clients: {e}");
                        continue;
                    }
                };

                let _ = send_websocket(&mut socket, msg).await;
            }
            _ = active_connections_ticker.tick() => {
                let clients = conn.all_sparkles_connections();
                let mut conns = Vec::new();

                for (id, addr, online) in clients {
                    let stats = if online {
                        conn.get_storage_stats(id).await.unwrap_or_default()
                    } else {
                        StorageStats::default()
                    };
                    let thread_names = if online {
                        conn.get_thread_names(id).await.unwrap_or_default()
                    } else {
                        HashMap::new()
                    };
                    conns.push(ActiveConnectionInfo {
                        id,
                        addr,
                        stats,
                        thread_names,
                        online,
                    })
                }
                let _ = send_websocket(&mut socket, MessageFromServer::ActiveConnections(conns)).await;
            }
            _ = sync_ticker.tick() => {
                let connections = conn.active_sparkles_connections();
                for (id, addr) in connections {
                    if let Ok(Some((min_tm, max_tm, current_tm))) = conn.get_connection_timestamps(id).await {
                        let msg = MessageFromServer::addressed(id, AddressedMessageFromServer::ConnectionTimestamps { 
                            min: min_tm, 
                            max: max_tm, 
                            current: current_tm 
                        });
                        let _ = send_websocket(&mut socket, msg).await;
                    }
                }
            }
            res = event_data_rx_channel.recv() => {
                match res {
                    Some((thread_ord_id, mut data, stats)) => {
                        let msg_id = last_msg_id;
                        last_msg_id += 1;

                        let msg = MessageFromServer::addressed(current_sparkles_id, AddressedMessageFromServer::NewEventsHeader {
                            thread_ord_id,
                            msg_id,
                            stats
                        });
                        let _ = send_websocket(&mut socket, msg).await;
                        let msg_id_le = msg_id.to_le_bytes();
                        data.extend_from_slice(&msg_id_le);
                        let _ = send_websocket_bytes(&mut socket, data.into()).await;
                    }
                    None => {
                        let msg = MessageFromServer::addressed(current_sparkles_id, AddressedMessageFromServer::EventsFinished);
                        let _ = send_websocket(&mut socket, msg).await;

                        is_channel_registered = false;
                        let (new_dummy_tx, new_dummy_rx) = tokio::sync::mpsc::channel(1);
                        dummy_tx = new_dummy_tx;
                        event_data_rx_channel = new_dummy_rx;
                        info!("Channel unregistered!");
                    }
                }
            }
        }
    }
}

async fn send_websocket(socket: &mut WebSocket, msg: MessageFromServer) -> anyhow::Result<()> {
    let json = serde_json::to_string(&msg)?;
    socket.send(Message::Text(Utf8Bytes::from(json))).await?;
    Ok(())
}

async fn send_websocket_bytes(socket: &mut WebSocket, bytes: Bytes) -> anyhow::Result<()> {
    socket.send(Message::Binary(bytes)).await?;
    Ok(())
}

#[derive(Debug, Clone, serde::Deserialize)]
pub enum MessageToServer {
    Connect {
        addr: SocketAddr,
    },
    RequestNewRange {
        conn_id: u32,
        start: u64,
        end: u64,
    },
    SetThreadName {
        conn_id: u32,
        thread_id: u64,
        name: String,
    },
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ActiveConnectionInfo {
    id: u32,
    addr: SocketAddr,
    stats: StorageStats,
    thread_names: HashMap<u64, String>,
    online: bool,
}
#[derive(Debug, Clone, serde::Serialize)]
pub enum MessageFromServer {
    DiscoveredClients {
        clients: Vec<Vec<SocketAddr>>,
    },
    ActiveConnections(Vec<ActiveConnectionInfo>),
    ConnectError(String),
    Connected {
        id: u32,
        addr: SocketAddr,
    },

    Addressed {
        id: u32,
        message: AddressedMessageFromServer,
    }
}

impl MessageFromServer {
    pub fn addressed(id: u32, message: AddressedMessageFromServer) -> Self {
        Self::Addressed { id, message }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub enum AddressedMessageFromServer {
    NewEventsHeader {
        thread_ord_id: u64,
        msg_id: u32,
        stats: EventsSkipStats
    },
    EventsFinished,
    ConnectionTimestamps {
        min: u64,
        max: u64,
        current: u64,
    },
}