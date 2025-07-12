use std::{thread};
use std::thread::JoinHandle;
use std::time::Duration;
use log::{error, info};
use sparkles_parser::DiscoveryWrapper;
use crate::tasks::web_server::{DiscoveryShared};
use crate::util::ShutdownSignal;

pub struct DiscoverTask {
    shutdown: ShutdownSignal,
    shared_data: DiscoveryShared
}

impl DiscoverTask {
    pub fn new(shutdown: ShutdownSignal, shared_data: DiscoveryShared) -> Self {
        Self {
            shutdown,
            shared_data
        }
    }

    pub fn spawn(mut self) -> JoinHandle<()> {
        thread::Builder::new()
            .name("Discover".to_string())
            .spawn(move || {
                if let Err(e) = self.run() {
                    error!("Discover task exited with error: {e:?}")
                }
                else {
                    info!("Discover task exited")
                }
            }).unwrap()
    }
    pub fn run(&mut self) -> anyhow::Result<()> {
        let mut discovery_wrapper = DiscoveryWrapper::new();
        let mut clients_prev = vec![];
        'outer: loop {
            let discovered_clients: Vec<_> = discovery_wrapper.discover()?.into_values().collect();
            if discovered_clients != clients_prev {
                info!("Discovered clients: ");
                for client in discovered_clients.iter() {
                    let addrs: Vec<_> = client.iter().map(|a| format!("{a}")).collect();
                    info!("- {}", addrs.join(", "))
                }
                info!("");
            }
            clients_prev = discovered_clients.clone();

            self.shared_data.0.lock().discovered_clients = discovered_clients.clone();

            for i in 0..10 {
                if self.shutdown.is_shutdown() {
                    info!("Discovery task: got shutdown signal");
                    break 'outer;
                }
                thread::sleep(Duration::from_millis(100))
            }
        }

        Ok(())
    }
}