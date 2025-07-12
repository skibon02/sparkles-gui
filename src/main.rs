pub(crate) mod util;
mod tasks;
pub(crate) mod shared;

use log::LevelFilter;
use crate::shared::SparklesWebsocketShared;
use crate::tasks::discover::DiscoverTask;
use crate::tasks::{sparkles_connection_manager, web_server};
use crate::tasks::web_server::DiscoveryShared;
use crate::util::ShutdownSignal;

#[tokio::main]
async fn main() {
    simple_logger::SimpleLogger::new().with_level(LevelFilter::Info)
        .with_module_level("multicast_discovery_socket", LevelFilter::Warn).init().unwrap();

    let shutdown = ShutdownSignal::register_ctrl_c();

    let discovery_shared = DiscoveryShared::new();

    // Discovery
    let discover = DiscoverTask::new(shutdown.clone(), discovery_shared.clone());
    let discover_jh = discover.spawn();

    let sparkles_websocket_shared = SparklesWebsocketShared::new();

    // Sparkles connection manager
    sparkles_connection_manager::spawn(discovery_shared.clone(), sparkles_websocket_shared.clone());

    // Web server (and websocket handler)
    // LAST TASK
    web_server::spawn_server(shutdown.clone(), discovery_shared.clone(), sparkles_websocket_shared.clone()).await;

    // Web server
    let _ = discover_jh.join();
}