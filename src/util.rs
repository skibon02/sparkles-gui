use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::time::Interval;

#[derive(Clone)]
pub struct ShutdownSignal(Arc<AtomicBool>, tokio::sync::watch::Receiver<bool>);

impl ShutdownSignal {
    pub fn register_ctrl_c() -> Self {
        let sig = Arc::new(AtomicBool::new(false));
        let (watch_tx, watch_rx) = tokio::sync::watch::channel(false);
        let sig_clone = sig.clone();
        ctrlc::set_handler(move || {
            sig.store(true, Ordering::Relaxed);
            watch_tx.send(true).unwrap();
        }).unwrap();

        Self(sig_clone, watch_rx)
    }

    pub fn is_shutdown(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }

    pub async fn wait(mut self) {
        let _ = self.1.wait_for(|t| *t).await;
    }
}

pub struct IntervalCaller {
    interval: Interval,
}

impl IntervalCaller {
    pub fn new(dur: Duration) -> Self {
        let mut interval = tokio::time::interval(dur);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        Self {
            interval,
        }
    }


    /// Cancellation safe!
    async fn interval_caller<T, R, F: FnMut(T) -> R>(&mut self, v: T, mut f: F) -> R {
        self.interval.tick().await;
        f(v)
    }
}
