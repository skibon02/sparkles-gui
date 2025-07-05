use log::{error, info};
use tokio::sync::mpsc::Receiver;
use crate::tasks::server::SharedDataWrapper;
use crate::tasks::ws_connection::MessageFromClient;

pub fn spawn(shared_data: SharedDataWrapper, client_msg_rx: Receiver<MessageFromClient>) {
    tokio::spawn(async move {
        if let Err(e) = run(shared_data, client_msg_rx).await {
            error!("Error in connection task: {e:?}");
        }
        info!("Connection task finished");
    });
}

pub async fn run(shared_data: SharedDataWrapper, mut client_msg_rx: Receiver<MessageFromClient>) -> anyhow::Result<()> {
    while let Some(msg) = client_msg_rx.recv().await {
        info!("Connection manager: got message from client: {:?}", msg);
    }
    Ok(())
}