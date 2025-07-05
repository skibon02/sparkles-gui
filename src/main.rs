mod ws_protocol;
pub(crate) mod util;
mod tasks;

use log::LevelFilter;
use crate::tasks::discover::DiscoverTask;
use crate::tasks::{connection_manager, server};
use crate::tasks::server::SharedDataWrapper;
use crate::util::ShutdownSignal;

#[tokio::main]
async fn main() {
    simple_logger::SimpleLogger::new().with_level(LevelFilter::Info)
        .with_module_level("multicast_discovery_socket", LevelFilter::Warn).init().unwrap();

    let shutdown = ShutdownSignal::register_ctrl_c();

    let shared_data = SharedDataWrapper::new();
    
    // Discover task
    let discover = DiscoverTask::new(shutdown.clone(), shared_data.clone());
    let discover_jh = discover.spawn();
    
    let (client_msg_tx, client_msg_rx) = tokio::sync::mpsc::channel(100);

    // Connection manager
    connection_manager::spawn(shared_data.clone(), client_msg_rx);

    // Web server
    server::run_server(shutdown.clone(), shared_data, client_msg_tx).await;
    let _ = discover_jh.join();
}