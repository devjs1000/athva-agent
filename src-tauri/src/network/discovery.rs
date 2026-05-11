use super::{Peer, PeerId};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const SERVICE_TYPE: &str = "_athva-voice._tcp.local.";
const SERVICE_PORT: u16 = 5432;

pub struct PeerDiscovery {
    peers: Arc<Mutex<HashMap<String, Peer>>>,
    peer_ttl_seconds: u64,
    local_peer_id: PeerId,
    local_name: String,
}

impl PeerDiscovery {
    pub fn new() -> Self {
        Self {
            peers: Arc::new(Mutex::new(HashMap::new())),
            peer_ttl_seconds: 300,
            local_peer_id: PeerId::new(),
            local_name: hostname::get()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|_| "unknown".to_string()),
        }
    }

    /// Start mDNS peer discovery and announce this peer
    pub async fn start(&self) -> Result<(), String> {
        let peers = self.peers.clone();
        let local_id = self.local_peer_id.as_str().to_string();
        let local_name = self.local_name.clone();

        tokio::spawn(async move {
            let daemon = match ServiceDaemon::new() {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("mDNS daemon error: {}", e);
                    return;
                }
            };

            // Announce ourselves
            let mut props = HashMap::new();
            props.insert("peer_id".to_string(), local_id.clone());
            props.insert("name".to_string(), local_name.clone());

            let host = format!("{}.local.", local_name.replace(' ', "-"));
            let service = ServiceInfo::new(
                SERVICE_TYPE,
                &local_name,
                &host,
                "",
                SERVICE_PORT,
                Some(props),
            );

            if let Ok(svc) = service {
                daemon.register(svc).ok();
            }

            // Browse for peers
            let receiver = match daemon.browse(SERVICE_TYPE) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("mDNS browse error: {}", e);
                    return;
                }
            };

            loop {
                match receiver.recv_async().await {
                    Ok(event) => match event {
                        ServiceEvent::ServiceResolved(info) => {
                            let props = info.get_properties();
                            let peer_id_str = props
                                .get_property_val_str("peer_id")
                                .unwrap_or_default()
                                .to_string();

                            // Skip ourselves
                            if peer_id_str == local_id {
                                continue;
                            }

                            let name = props
                                .get_property_val_str("name")
                                .unwrap_or(info.get_fullname())
                                .to_string();

                            let ip = info
                                .get_addresses()
                                .iter()
                                .next()
                                .map(|a| a.to_string())
                                .unwrap_or_default();

                            let now = SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs();

                            let peer = Peer {
                                id: PeerId::from_string(peer_id_str.clone()),
                                name,
                                ip_address: ip,
                                port: info.get_port(),
                                last_seen: now,
                            };

                            peers.lock().unwrap().insert(peer_id_str, peer);
                        }
                        ServiceEvent::ServiceRemoved(_, fullname) => {
                            let mut map = peers.lock().unwrap();
                            map.retain(|_, p| p.name != fullname);
                        }
                        _ => {}
                    },
                    Err(_) => break,
                }
            }
        });

        Ok(())
    }

    pub fn add_peer(&mut self, peer: Peer) {
        self.peers.lock().unwrap().insert(peer.id.0.clone(), peer);
    }

    pub fn remove_peer(&mut self, peer_id: &PeerId) -> Option<Peer> {
        self.peers.lock().unwrap().remove(&peer_id.0)
    }

    pub fn get_peers(&self) -> Vec<Peer> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        self.peers
            .lock()
            .unwrap()
            .values()
            .filter(|peer| now.saturating_sub(peer.last_seen) < self.peer_ttl_seconds)
            .cloned()
            .collect()
    }

    pub fn get_peer(&self, peer_id: &PeerId) -> Option<Peer> {
        self.peers.lock().unwrap().get(&peer_id.0).cloned()
    }

    pub fn peer_count(&self) -> usize {
        self.peers.lock().unwrap().len()
    }

    pub fn clear_peers(&mut self) {
        self.peers.lock().unwrap().clear();
    }

    pub fn update_peer_seen(&self, peer_id: &PeerId) -> Result<(), String> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let mut map = self.peers.lock().unwrap();
        if let Some(peer) = map.get_mut(&peer_id.0) {
            peer.last_seen = now;
            Ok(())
        } else {
            Err("Peer not found".to_string())
        }
    }
}

impl Default for PeerDiscovery {
    fn default() -> Self {
        Self::new()
    }
}
