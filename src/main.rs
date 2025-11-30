pub(crate) mod util;
mod tasks;
pub(crate) mod shared;

use std::path::PathBuf;
use clap::Parser;
use log::LevelFilter;
use crate::shared::SparklesWebsocketShared;
use crate::tasks::discover::DiscoverTask;
use crate::tasks::{sparkles_connection_manager, web_server};
use crate::tasks::web_server::DiscoveryShared;
use crate::util::ShutdownSignal;

#[derive(Parser, Debug)]
#[command(name = "sparkles-gui")]
#[command(about = "Sparkles GUI application", long_about = None)]
struct Args {
    #[arg(long, help = "Base directory (trace subdirectory will be used)", default_value = ".")]
    path: PathBuf,
}

#[tokio::main]
async fn main() {
    let args = Args::parse();

    simple_logger::SimpleLogger::new().with_level(LevelFilter::Info)
        .with_module_level("multicast_discovery_socket", LevelFilter::Warn).init().unwrap();

    #[cfg(feature = "self-tracing")]
    let g = sparkles::init(
        sparkles::config::SparklesConfig::default()
            .with_udp_multicast_default()
    );

    let shutdown = ShutdownSignal::register_ctrl_c();

    let discovery_shared = DiscoveryShared::new();

    // Discovery
    let discover = DiscoverTask::new(shutdown.clone(), discovery_shared.clone(), args.path);
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