use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;
use axum::extract::WebSocketUpgrade;
use axum::extract::ws::WebSocket;
use axum::Router;
use axum::routing::any;
use log::{error, info};
use parking_lot::Mutex;
use tower_http::services::{ServeDir, ServeFile};
use crate::shared::SparklesWebsocketShared;
use crate::tasks::ws_connection::{handle_socket};
use crate::util::ShutdownSignal;

#[derive(Debug, Default)]
pub(crate) struct SharedData {
    pub discovered_clients: Vec<Vec<SocketAddr>>,
    pub active_connections: HashSet<SocketAddr>,
}

#[derive(Clone)]
pub(crate) struct DiscoveryShared(pub Arc<Mutex<SharedData>>);
impl DiscoveryShared {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(SharedData::default())))
    }
}

pub async fn spawn_server(
    shutdown: ShutdownSignal,
    discovery_shared: DiscoveryShared,
    sparkles_shared: SparklesWebsocketShared,
) {
    let server_task = tokio::spawn(async move {
        run_server(shutdown, discovery_shared, sparkles_shared).await;
    });

    if let Err(e) = server_task.await {
        error!("Web server task failed: {e:?}");
    }
    else {
        info!("Web server task exited");
    }
}
async fn run_server(shutdown: ShutdownSignal, shared_data: DiscoveryShared, sparkles_shared: SparklesWebsocketShared) {
    let static_files = ServeDir::new("static").not_found_service(ServeFile::new("static/404.html"));
    let shared_data_clone = shared_data.clone();
    let app = Router::new()
        .route_service("/", ServeFile::new("static/index.html"))
        .route("/ws", any(async |ws: WebSocketUpgrade| {
            ws.on_upgrade(|socket: WebSocket| async move {
                let conn = sparkles_shared.new_ws_connection();
                let conn_id = conn.id();
                if let Err(e) = handle_socket(socket, shared_data_clone, conn).await {
                    error!("Error handling WebSocket connection: {e:?}");
                } else {
                    info!("WebSocket connection closed for client ID: {conn_id}");
                }
            })
        }))
        .fallback_service(static_files);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    info!("Server running on http://127.0.0.1:{port}");
    let _ = open::that(format!("http://127.0.0.1:{port}"));


    if let Err(e) = axum::serve(listener, app).with_graceful_shutdown(shutdown.wait()).await {
        error!("HTTP Server error: {e:?}");
    }
    info!("Server task finished")
}