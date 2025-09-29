use log::{error, info};
use crate::shared::{SparklesWebsocketShared, WsControlMessage, WsToSparklesMessage};
use crate::tasks::web_server::{DiscoveryShared, SparklesAddress};
use crate::tasks::sparkles_connection;

pub fn spawn(discovery_shared: DiscoveryShared, ws_shared: SparklesWebsocketShared) {
    tokio::spawn(async move {
        if let Err(e) = run(discovery_shared, ws_shared).await {
            error!("Error in connection task: {e:?}");
        }
        info!("Connection task finished");
    });
}

pub async fn run(discovery_shared: DiscoveryShared, ws_shared: SparklesWebsocketShared) -> anyhow::Result<()> {
    let mut control_msg_rx = ws_shared.take_control_msg_rx().unwrap();
    loop {
        // Handle messages from the cwient
        let msg = control_msg_rx.recv().await.ok_or(
            anyhow::anyhow!("Websocket control message channel closed")
        )?;

        match msg {
            WsControlMessage::Connect {
                addr,
                resp
            } => {
                info!("Got connection request for {addr:?}");
                let mut guard = discovery_shared.0.lock();

                // Check if this exact address is already connected
                if guard.active_connections.contains(&addr) {
                    let _ = resp.send(Err("Already connected".into()));
                    continue;
                }

                // Check if any address in the same client group is already connected
                let mut group_already_connected = false;
                match &addr {
                    SparklesAddress::Udp(socket_addr) => {
                        for client_group in &guard.discovered_clients {
                            if client_group.contains(socket_addr) {
                                // Found the group containing this address, check if any address in this group is connected
                                for group_addr in client_group {
                                    let group_addr_dst = SparklesAddress::Udp(*group_addr);
                                    if guard.active_connections.contains(&group_addr_dst) {
                                        group_already_connected = true;
                                        break;
                                    }
                                }
                                break;
                            }
                        }
                    }
                    SparklesAddress::File(path) => {
                        if guard.active_connections.contains(&addr) {
                            group_already_connected = true;
                        }
                    }
                }

                if group_already_connected {
                    let _ = resp.send(Err("Already connected to this client".into()));
                    continue;
                }

                guard.active_connections.insert(addr.clone());
                drop(guard);

                let conn = ws_shared.new_sparkles_connection(addr.clone());
                let id = conn.id();

                let _ = resp.send(Ok(id));

                sparkles_connection::spawn_conn_handler(addr.clone(), conn);
            }
            WsControlMessage::Disconnect { id } => {
                info!("Got disconnection request for connection {id}");
                if let Some(addr) = ws_shared.sparkles_connection_addr(id) {
                    let mut guard = discovery_shared.0.lock();
                    guard.active_connections.remove(&addr);
                    drop(guard);

                    let _ = ws_shared.send_to_sparkles_connection(id, WsToSparklesMessage::Disconnect );
                } else {
                    error!("No connection found with id {id} to disconnect");
                }
            }
        }
    }
}