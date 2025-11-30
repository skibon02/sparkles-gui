use std::{thread};
use std::path::PathBuf;
use std::thread::JoinHandle;
use std::time::Duration;
use log::{error, info};
use sparkles_parser::DiscoveryWrapper;
use crate::tasks::web_server::{DiscoveryShared};
use crate::util::ShutdownSignal;

pub struct DiscoverTask {
    shutdown: ShutdownSignal,
    shared_data: DiscoveryShared,
    trace_dir: PathBuf,
}

impl DiscoverTask {
    pub fn new(shutdown: ShutdownSignal, shared_data: DiscoveryShared, trace_dir: PathBuf) -> Self {
        Self {
            shutdown,
            shared_data,
            trace_dir,
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
                info!("Discovered UDP clients: ");
                for client in discovered_clients.iter() {
                    let addrs: Vec<_> = client.iter().map(|a| format!("{a}")).collect();
                    info!("- {}", addrs.join(", "))
                }
                info!("");
            }
            clients_prev = discovered_clients.clone();
            self.shared_data.0.lock().discovered_clients = discovered_clients.clone();

            if let Ok(trace_files) = discover_trace_files(&self.trace_dir).inspect_err(|e| {
                error!("Error discovering trace files: {e:?}");
            }) {
                self.shared_data.0.lock().discovered_files = trace_files;
            }

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

fn discover_trace_files(base_dir: &PathBuf) -> anyhow::Result<Vec<PathBuf>> {
    let mut traces = vec![];
    let base_dir = if base_dir.is_absolute() {
        base_dir.clone()
    } else {
        std::env::current_dir()?.join(base_dir)
    };
    let trace_dir = base_dir.join("trace");

    if trace_dir.is_dir() {
        for entry in std::fs::read_dir(&trace_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_file() && path.extension().map_or(false, |ext| ext == "sprk") {
                traces.push(path);
            }
        }
    }

    Ok(traces)
}