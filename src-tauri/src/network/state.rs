use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum CallState {
    Idle,
    Ringing,
    Connected,
    OnHold,
    Rejected,
    Ended,
    Failed,
}

/// Call state machine for managing call lifecycle
pub struct CallStateMachine;

impl CallStateMachine {
    pub fn new() -> Self {
        CallStateMachine
    }

    /// Check if transition from one state to another is valid
    pub fn is_valid_transition(from: CallState, to: CallState) -> bool {
        match (from, to) {
            // Initial transition
            (CallState::Idle, CallState::Ringing) => true,
            // From Ringing
            (CallState::Ringing, CallState::Connected) => true,
            (CallState::Ringing, CallState::Rejected) => true,
            (CallState::Ringing, CallState::Failed) => true,
            // From Connected
            (CallState::Connected, CallState::OnHold) => true,
            (CallState::Connected, CallState::Ended) => true,
            (CallState::Connected, CallState::Failed) => true,
            // From OnHold
            (CallState::OnHold, CallState::Connected) => true,
            (CallState::OnHold, CallState::Ended) => true,
            (CallState::OnHold, CallState::Failed) => true,
            // Invalid transitions
            _ => false,
        }
    }

    /// Get human-readable state name
    pub fn state_name(state: CallState) -> &'static str {
        match state {
            CallState::Idle => "Idle",
            CallState::Ringing => "Ringing",
            CallState::Connected => "Connected",
            CallState::OnHold => "On Hold",
            CallState::Rejected => "Rejected",
            CallState::Ended => "Ended",
            CallState::Failed => "Failed",
        }
    }
}

impl Default for CallStateMachine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_transitions() {
        assert!(CallStateMachine::is_valid_transition(
            CallState::Idle,
            CallState::Ringing
        ));
        assert!(CallStateMachine::is_valid_transition(
            CallState::Ringing,
            CallState::Connected
        ));
        assert!(CallStateMachine::is_valid_transition(
            CallState::Connected,
            CallState::Ended
        ));
    }

    #[test]
    fn test_invalid_transitions() {
        assert!(!CallStateMachine::is_valid_transition(
            CallState::Idle,
            CallState::Connected
        ));
        assert!(!CallStateMachine::is_valid_transition(
            CallState::Ended,
            CallState::Connected
        ));
    }
}
