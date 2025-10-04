use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use axum::body::Bytes;
use axum::extract::ws::{Message, Utf8Bytes, WebSocket};
use log::{debug, error, info, warn};
use tokio::time::interval;
use crate::shared::WsConnection;
use crate::tasks::sparkles_connection::{ChannelId, EventsSkipStats};
use crate::tasks::sparkles_connection::storage::{GeneralEventNameId, StorageStats};
use crate::tasks::web_server::{DiscoveryShared, SparklesAddress};

pub async fn handle_socket(mut socket: WebSocket, shared_data: DiscoveryShared, mut conn: WsConnection) -> anyhow::Result<()> {
    info!("New WebSocket connection: {}", conn.id());
    #[cfg(feature = "self-tracing")]
    let g = sparkles::range_event_start!("Websocket connection handler");
    let mut discover_list_ticker = interval(Duration::from_millis(400));
    let mut active_connections_ticker = interval(Duration::from_millis(200));
    let mut sync_ticker = interval(Duration::from_millis(100));

    let mut last_msg_id = 0;

    let mut is_channel_registered = false;
    let (mut dummy_tx, dummy_rx) = tokio::sync::mpsc::channel(1);

    let mut event_data_rx_channel = dummy_rx;
    let mut current_sparkles_id = 0;
    loop {
        tokio::select! {
            msg = socket.recv() => {
                #[cfg(feature = "self-tracing")]
                let g = sparkles::range_event_start!("Websocket: handle incoming message");
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
                                            let addr = SparklesAddress::Udp(addr);
                                            match conn.connect(addr.clone()).await? {
                                                Ok(id) => {
                                                    send_websocket(&mut socket, MessageFromServer::Connected { id, addr }).await?;
                                                }
                                                Err(msg) => {
                                                    let _ = send_websocket(&mut socket, MessageFromServer::ConnectError(msg.to_string())).await;
                                                }
                                            }
                                        }
                                        MessageToServer::OpenFile { path } => {
                                            // validate path to be in the discovered files list
                                            let is_valid = {
                                                let guard = shared_data.0.lock();
                                                guard.discovered_files.contains(&path)
                                            };
                                            if !is_valid {
                                                let _ = send_websocket(&mut socket, MessageFromServer::ConnectError("File not in discovered files list".into())).await;
                                                continue;
                                            }

                                            let addr = SparklesAddress::File(path);
                                            match conn.connect(addr.clone()).await? {
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

                                                debug!("Channel registered!");
                                                event_data_rx_channel = resp_rx;
                                                current_sparkles_id = conn_id;
                                                is_channel_registered = true;
                                            }
                                        }
                                        MessageToServer::SetChannelId { conn_id, channel_id, name } => {
                                            match conn.set_thread_name(conn_id, channel_id, name.clone()).await {
                                                Ok(_) => {
                                                    info!("Thread name set for connection {}, channel {:?}: {}", conn_id, channel_id, name);
                                                }
                                                Err(e) => {
                                                    warn!("Failed to set thread name: {}", e);
                                                }
                                            }
                                        }
                                        MessageToServer::Disconnect { conn_id } => {
                                            match conn.disconnect(conn_id).await {
                                                Ok(_) => {
                                                    info!("Connection {} disconnected", conn_id);
                                                }
                                                Err(e) => {
                                                    warn!("Failed to disconnect connection {}: {}", conn_id, e);
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
                // Collect all data from shared state
                let (discovered_clients, discovered_files, active_connections) = {
                    let guard = shared_data.0.lock();
                    (
                        guard.discovered_clients.clone(),
                        guard.discovered_files.clone(),
                        guard.active_connections.clone()
                    )
                };

                // Build clients with connection status
                let clients: Vec<DiscoveredClient> = discovered_clients
                    .into_iter()
                    .map(|addresses| {
                        let connected = addresses.iter().any(|addr| {
                            active_connections.contains(&SparklesAddress::Udp(*addr))
                        });
                        DiscoveredClient { addresses, connected }
                    })
                    .collect();

                // Build files with connection status
                let files: Vec<DiscoveredFile> = discovered_files
                    .into_iter()
                    .map(|path| {
                        let connected = active_connections.contains(&SparklesAddress::File(path.clone()));
                        DiscoveredFile { path, connected }
                    })
                    .collect();

                let msg = MessageFromServer::DiscoveredClients { clients, files };
                let _ = send_websocket(&mut socket, msg).await;
            }
            _ = active_connections_ticker.tick() => {
                let clients = conn.all_sparkles_connections();
                let mut conns = Vec::new();

                for (id, addr, online) in clients {
                    let stats = conn.get_storage_stats(id).await.unwrap_or_default();
                    let channel_names_raw = conn.get_channel_names(id).await.unwrap_or_default();

                    // Convert ChannelId keys to strings for JSON serialization
                    let channel_names: HashMap<String, Arc<str>> = channel_names_raw
                        .iter()
                        .map(|(channel_id, name)| (serde_json::to_string(channel_id).unwrap(), name.clone()))
                        .collect();

                    let mut event_names = HashMap::new();
                    for (&thread_id, _) in &channel_names_raw {
                        if let Ok(names) = conn.get_event_names(id, thread_id).await {
                            let string_names: HashMap<GeneralEventNameId, Arc<str>> = names
                                .into_iter()
                                .map(|(k, v)| (k, v.clone()))
                                .collect();
                            let channel_key = serde_json::to_string(&thread_id).unwrap();
                            event_names.insert(channel_key, string_names);
                        }
                    }

                    conns.push(ActiveConnectionInfo {
                        id,
                        addr,
                        stats,
                        channel_names,
                        event_names,
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
                    Some((channel_id, mut data, stats)) => {
                        let msg_id = last_msg_id;
                        last_msg_id += 1;

                        let msg = MessageFromServer::addressed(current_sparkles_id, AddressedMessageFromServer::NewEventsHeader {
                            channel_id,
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
                        debug!("Channel unregistered!");
                    }
                }
            }
        }
    }
}

async fn send_websocket(socket: &mut WebSocket, msg: MessageFromServer) -> anyhow::Result<()> {
    let json = serde_json::to_string(&msg).inspect_err(|e| {
        error!("Failed to serialize websocket message: {e}");
    })?;
    socket.send(Message::Text(Utf8Bytes::from(json))).await.inspect_err(|e| {
        error!("Failed to send websocket message: {e}");
    })?;
    Ok(())
}

async fn send_websocket_bytes(socket: &mut WebSocket, bytes: Bytes) -> anyhow::Result<()> {
    socket.send(Message::Binary(bytes)).await.inspect_err(|e| {
        error!("Failed to send websocket binary message: {e}");
    })?;
    Ok(())
}

#[derive(Debug, Clone, serde::Deserialize)]
pub enum MessageToServer {
    Connect {
        addr: SocketAddr,
    },
    OpenFile {
        path: PathBuf,
    },
    RequestNewRange {
        conn_id: u32,
        start: u64,
        end: u64,
    },
    SetChannelId {
        conn_id: u32,
        channel_id: ChannelId,
        name: Arc<str>,
    },
    Disconnect {
        conn_id: u32,
    },
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ActiveConnectionInfo {
    id: u32,
    addr: SparklesAddress,
    stats: StorageStats,
    channel_names: HashMap<String, Arc<str>>,
    event_names: HashMap<String, HashMap<GeneralEventNameId, Arc<str>>>,
    online: bool,
}
#[derive(Debug, Clone, serde::Serialize)]
pub struct DiscoveredClient {
    pub addresses: Vec<SocketAddr>,
    pub connected: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DiscoveredFile {
    pub path: std::path::PathBuf,
    pub connected: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub enum MessageFromServer {
    DiscoveredClients {
        clients: Vec<DiscoveredClient>,
        files: Vec<DiscoveredFile>,
    },
    ActiveConnections(Vec<ActiveConnectionInfo>),
    ConnectError(String),
    Connected {
        id: u32,
        addr: SparklesAddress,
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
        channel_id: ChannelId,
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