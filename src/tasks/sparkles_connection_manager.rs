use log::{error, info};
use crate::shared::{SparklesWebsocketShared, WsControlMessage};
use crate::tasks::web_server::DiscoveryShared;
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
                info!("Got connection request for {}", addr);
                let mut guard = discovery_shared.0.lock();
                if guard.active_connections.contains(&addr) {
                    let _ = resp.send(Err("Already connected".into()));
                    continue;
                }
                guard.active_connections.insert(addr);
                drop(guard);

                let conn = ws_shared.new_sparkles_connection(addr);
                let id = conn.id();

                let _ = resp.send(Ok(id));

                sparkles_connection::spawn_conn_handler(addr, conn);
            }
        }
    }
}