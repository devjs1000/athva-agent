use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

pub mod discovery;
pub mod state;

pub use discovery::PeerDiscovery;
pub use state::{CallState, CallStateMachine};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct PeerId(String);

impl PeerId {
    pub fn new() -> Self {
        PeerId(Uuid::new_v4().to_string())
    }

    pub fn from_string(s: String) -> Self {
        PeerId(s)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for PeerId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Peer {
    pub id: PeerId,
    pub name: String,
    pub ip_address: String,
    pub port: u16,
    pub last_seen: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallId(String);

impl CallId {
    pub fn new() -> Self {
        CallId(Uuid::new_v4().to_string())
    }

    pub fn from_string(s: String) -> Self {
        CallId(s)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for CallId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Call {
    pub id: CallId,
    pub initiator_id: PeerId,
    pub responder_id: PeerId,
    pub state: CallState,
    pub started_at: Option<u64>,
    pub ended_at: Option<u64>,
}

/// Voice call manager
pub struct VoiceCallManager {
    peer_discovery: Arc<RwLock<PeerDiscovery>>,
    active_calls: Arc<RwLock<std::collections::HashMap<String, Call>>>,
    state_machine: Arc<CallStateMachine>,
}

impl VoiceCallManager {
    pub fn new() -> Self {
        Self {
            peer_discovery: Arc::new(RwLock::new(PeerDiscovery::new())),
            active_calls: Arc::new(RwLock::new(std::collections::HashMap::new())),
            state_machine: Arc::new(CallStateMachine::new()),
        }
    }

    pub async fn start_discovery(&self) -> Result<(), String> {
        let discovery = self.peer_discovery.write().await;
        discovery.start().await
    }

    pub async fn get_peers(&self) -> Result<Vec<Peer>, String> {
        let discovery = self.peer_discovery.read().await;
        Ok(discovery.get_peers())
    }

    pub async fn initiate_call(&self, peer_id: PeerId) -> Result<CallId, String> {
        let call = Call {
            id: CallId::new(),
            initiator_id: PeerId::new(),
            responder_id: peer_id,
            state: CallState::Ringing,
            started_at: None,
            ended_at: None,
        };

        let call_id = call.id.clone();
        let mut calls = self.active_calls.write().await;
        calls.insert(call_id.0.clone(), call);

        Ok(call_id)
    }

    pub async fn accept_call(&self, call_id: &CallId) -> Result<(), String> {
        let mut calls = self.active_calls.write().await;
        if let Some(call) = calls.get_mut(&call_id.0) {
            call.state = CallState::Connected;
            call.started_at = Some(std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs());
            Ok(())
        } else {
            Err("Call not found".to_string())
        }
    }

    pub async fn reject_call(&self, call_id: &CallId) -> Result<(), String> {
        let mut calls = self.active_calls.write().await;
        if let Some(call) = calls.get_mut(&call_id.0) {
            call.state = CallState::Rejected;
            call.ended_at = Some(std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs());
            Ok(())
        } else {
            Err("Call not found".to_string())
        }
    }

    pub async fn end_call(&self, call_id: &CallId) -> Result<(), String> {
        let mut calls = self.active_calls.write().await;
        if let Some(call) = calls.get_mut(&call_id.0) {
            call.state = CallState::Ended;
            call.ended_at = Some(std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs());
            Ok(())
        } else {
            Err("Call not found".to_string())
        }
    }

    pub async fn get_call(&self, call_id: &CallId) -> Result<Option<Call>, String> {
        let calls = self.active_calls.read().await;
        Ok(calls.get(&call_id.0).cloned())
    }

    pub async fn get_active_calls(&self) -> Result<Vec<Call>, String> {
        let calls = self.active_calls.read().await;
        let active: Vec<_> = calls
            .values()
            .filter(|c| c.state == CallState::Connected)
            .cloned()
            .collect();
        Ok(active)
    }
}

impl Default for VoiceCallManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Tauri managed state wrapper
pub struct VoiceCallManagerState(pub Arc<tokio::sync::RwLock<VoiceCallManager>>);

impl VoiceCallManagerState {
    pub fn new() -> Self {
        Self(Arc::new(tokio::sync::RwLock::new(VoiceCallManager::new())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_call_lifecycle() {
        let manager = VoiceCallManager::new();
        let peer_id = PeerId::new();

        // Initiate call
        let call_id = manager.initiate_call(peer_id.clone()).await.unwrap();

        // Verify call exists in ringing state
        let call = manager.get_call(&call_id).await.unwrap();
        assert!(call.is_some());
        assert_eq!(call.unwrap().state, CallState::Ringing);

        // Accept call
        manager.accept_call(&call_id).await.unwrap();
        let call = manager.get_call(&call_id).await.unwrap();
        assert_eq!(call.unwrap().state, CallState::Connected);

        // End call
        manager.end_call(&call_id).await.unwrap();
        let call = manager.get_call(&call_id).await.unwrap();
        assert_eq!(call.unwrap().state, CallState::Ended);
    }
}
