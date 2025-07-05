use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use axum::extract::WebSocketUpgrade;
use axum::extract::ws::WebSocket;
use axum::Router;
use axum::routing::any;
use log::{error, info};
use parking_lot::Mutex;
use tokio::sync::mpsc::Sender;
use tower_http::services::{ServeDir, ServeFile};
use crate::tasks::ws_connection::{handle_socket, MessageFromClient};
use crate::util::ShutdownSignal;

#[derive(Debug, Default)]
pub(crate) struct SharedData {
    pub discovered_clients: Vec<Vec<SocketAddr>>,
    pub active_connections: HashSet<SocketAddr>,
}

#[derive(Clone)]
pub(crate) struct SharedDataWrapper(pub Arc<Mutex<SharedData>>);
impl SharedDataWrapper {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(SharedData::default())))
    }
}

static LAST_CLIENT_ID: AtomicU32 = AtomicU32::new(0);
pub async fn run_server(shutdown: ShutdownSignal, shared_data: SharedDataWrapper, client_msg_tx: Sender<MessageFromClient>) {
    let static_files = ServeDir::new("static").not_found_service(ServeFile::new("static/404.html"));
    let shared_data_clone = shared_data.clone();
    let app = Router::new()
        .route_service("/", ServeFile::new("static/index.html"))
        .route("/ws", any(async |ws: WebSocketUpgrade| {
            ws.on_upgrade(|socket: WebSocket| async move {
                let new_client_id = LAST_CLIENT_ID.fetch_add(1, Ordering::Relaxed);
                if let Err(e) = handle_socket(socket, shared_data_clone, client_msg_tx, new_client_id).await {
                    error!("Error handling WebSocket connection: {e:?}");
                } else {
                    info!("WebSocket connection closed for client ID: {new_client_id}");
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