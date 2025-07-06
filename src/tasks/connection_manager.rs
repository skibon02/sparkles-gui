use std::collections::HashMap;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use axum::response::sse::Event;
use log::{error, info};
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
    loop {
        // Handle messages from the cwient
        if let Ok(msg) = client_msg_rx.try_recv() {
            info!("Connection manager: got message from client: {:?}", msg);
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
                MessageFromClient::RequestNewRange {
                    start,
                    end,
                    resp
                } => {
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
            loop {
                match storage.msg_rx.try_recv() {
                    Ok(msg) => {
                        match msg {
                            sparkles_connection::SparklesConnectionMessage::Events { thread_ord_id, events } => {
                                // info!("Received {} events from thread {}", events.len(), thread_ord_id);
                                // Process events and store them
                                for event in events {
                                    // Here you can store the event in your storage
                                    // For example, you can push it to a vector or a database
                                }
                            }
                            sparkles_connection::SparklesConnectionMessage::UpdateThreadName { thread_ord_id, thread_name } => {
                                storage.thread_names.insert(thread_ord_id, thread_name.clone());
                            }
                            sparkles_connection::SparklesConnectionMessage::UpdateEventNames { thread_ord_id, event_names } => {
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
            active_connections.remove(&addr);
        }

        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    Ok(())
}

pub struct ClientStorage {
    thread_events: HashMap<u64, EventStorage>,
    thread_names: HashMap<u64, String>,
    msg_rx: Receiver<SparklesConnectionMessage>,
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
    event_names: HashMap<TracingEventId, Arc<str>>,
    events: Vec<ParsedEvent>,
}