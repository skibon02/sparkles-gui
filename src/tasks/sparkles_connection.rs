use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::thread;
use log::info;
use sparkles_parser::packet_decoder::PacketDecoder;
use sparkles_parser::parsed::ParsedEvent;
use sparkles_parser::{SparklesParser, TracingEventId};

pub fn connect(addr: SocketAddr, events_tx: tokio::sync::mpsc::Sender<SparklesConnectionMessage>) {
    thread::spawn(move || {
        let decoder = PacketDecoder::from_socket(addr);
        info!("Connected to Sparkles at {}", addr);

        let events_tx2 = events_tx.clone();
        let mut thread_infos = HashMap::new();
        SparklesParser::new().parse_to_end(decoder, move |evs, thread_info, event_names| {
            if let Some(thread_name) = &thread_info.thread_name {
                let entry = thread_infos.entry(thread_info.thread_ord_id);
                match entry {
                    std::collections::hash_map::Entry::Vacant(e) => {
                        e.insert(thread_name.clone());
                        events_tx.blocking_send(SparklesConnectionMessage::UpdateThreadName {
                            thread_ord_id: thread_info.thread_ord_id,
                            thread_name: thread_name.clone(),
                        }).unwrap();
                    },
                    std::collections::hash_map::Entry::Occupied(mut e) => {
                        let existing_thread_name = e.get_mut();
                        if existing_thread_name != thread_name {
                            *existing_thread_name = thread_name.clone();
                            events_tx.blocking_send(SparklesConnectionMessage::UpdateThreadName {
                                thread_ord_id: thread_info.thread_ord_id,
                                thread_name: thread_name.clone(),
                            }).unwrap();
                        }
                    }
                }
            }
            events_tx.blocking_send(SparklesConnectionMessage::Events {
                thread_ord_id: thread_info.thread_ord_id,
                events: evs.to_vec(),
            }).unwrap();
        }, |thread_info, new_event_names| {
            events_tx2.blocking_send(SparklesConnectionMessage::UpdateEventNames {
                thread_ord_id: thread_info.thread_ord_id,
                event_names: new_event_names.iter().map(|(id, (name, _))| {
                    (*id, Arc::from(&**name))
                }).collect()
            }).unwrap();
        }).unwrap();
    });
}

pub enum SparklesConnectionMessage {
    Events {
        thread_ord_id: u64,
        events: Vec<ParsedEvent>,
    },
    UpdateThreadName {
        thread_ord_id: u64,
        thread_name: String,
    },
    UpdateEventNames {
        thread_ord_id: u64,
        event_names: HashMap<TracingEventId, Arc<str>>
    },
}