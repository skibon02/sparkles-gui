use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use axum::extract::ws::{Message, Utf8Bytes, WebSocket};
use futures_util::TryFutureExt;
use log::{error, info, warn};
use sparkles_parser::TracingEventId;
use tokio::sync::mpsc::Sender;
use tokio::time::interval;
use crate::tasks::connection_manager::StorageStats;
use crate::tasks::server::SharedDataWrapper;
use crate::ws_protocol::{MessageFromServer, MessageToServer};

pub async fn handle_socket(mut socket: WebSocket, shared_data: SharedDataWrapper, client_msg_tx: Sender<MessageFromClient>, client_id: u32) -> anyhow::Result<()> {
    info!("New WebSocket connection: {client_id}");
    let mut send_ticker = interval(Duration::from_secs(2));
    let mut stats_ticker = interval(Duration::from_millis(500));

    let mut event_data_rx_channel = None;
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
                            // Try to deserialize from JSON
                            match serde_json::from_str::<MessageToServer>(&text) {
                                Ok(msg_to_server) => {
                                    match msg_to_server {
                                        MessageToServer::Connect { addr } => {
                                            let (resp, resp_rx) = tokio::sync::oneshot::channel();
                                            let msg = MessageFromClient::Connect {
                                                addr,
                                                resp,
                                            };
                                            let _ = client_msg_tx.send(msg).await;

                                            if let Ok(Err(msg)) = resp_rx.await {
                                                let _ = send_websocket(&mut socket, MessageFromServer::ConnectError(msg)).await;
                                            }
                                        }
                                        MessageToServer::RequestNewRange { start, end } => {
                                            if event_data_rx_channel.is_some() {
                                                send_websocket(&mut socket, MessageFromServer::ConnectError("Already waiting for a range".into())).await?;
                                            }
                                            else {
                                                let (resp_tx, resp_rx) = tokio::sync::mpsc::channel(5);
                                                let msg = MessageFromClient::RequestNewEvents {
                                                    start,
                                                    end,
                                                    resp: resp_tx,
                                                };
                                                client_msg_tx.send(msg).await?;

                                                // Register the response channel
                                                event_data_rx_channel = Some(resp_rx);
                                            }
                                        }
                                    }
                                }
                                Err(e) => {
                                    error!("Failed to deserialize message from client: {}. Message: {}", e, text);
                                }
                            }
                        }
                        Message::Binary(data) => {
                            info!("Received binary message: {:?}", data);
                        }
                        Message::Ping(ping) => {
                            socket.send(Message::Pong(ping)).await.unwrap_or_else(|e| {
                                error!("Failed to send Pong response: {}", e);
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
            _ = send_ticker.tick() => {
                let clients = shared_data.0.lock().discovered_clients.clone();
                let msg = MessageFromServer::DiscoveredClients {clients};
                let json = match serde_json::to_string(&msg) {
                    Ok(json) => json,
                    Err(e) => {
                        error!("Failed to serialize discovered clients: {}", e);
                        continue;
                    }
                };

                let _ = send_websocket(&mut socket, msg).await;
            }
            _ = stats_ticker.tick() => {
                let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
                let msg = MessageFromClient::GetStorageStats {
                    resp: resp_tx
                };
                client_msg_tx.send(msg).await?;
                let res = resp_rx.await?;
                let msg = MessageFromServer::Stats(res);
                let _ = send_websocket(&mut socket, msg).await;
            }
        }
    }
}

async fn send_websocket(socket: &mut WebSocket, msg: MessageFromServer) -> anyhow::Result<()> {
    let json = serde_json::to_string(&msg)?;
    socket.send(Message::Text(Utf8Bytes::from(json))).await?;
    Ok(())
}

#[derive(Debug)]
pub enum MessageFromClient {
    Connect {
        addr: SocketAddr,
        resp: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    RequestNewEvents {
        start: u64,
        end: u64,
        resp: tokio::sync::mpsc::Sender<Vec<u8>>,
    },
    GetThreadNames {
        addr: SocketAddr,
        resp: tokio::sync::oneshot::Sender<HashMap<u64, String>>,
    },
    GetEventNames {
        addr: SocketAddr,
        thread: u64,
        resp: tokio::sync::oneshot::Sender<HashMap<TracingEventId, Arc<str>>>,
    },
    GetStorageStats {
        resp: tokio::sync::oneshot::Sender<StorageStats>,
    }
}