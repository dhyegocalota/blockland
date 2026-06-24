//! A per-account capability tier — pure game logic shared by the room (admit/role handlers) and the
//! db layer (which re-exports it and maps it to/from the persisted flags).

use serde::{Deserialize, Serialize};

/// A per-account capability tier. `Admin` (parents) can do everything; `Moderator` (kids) can flip
/// only the harmless room toggles and manage other moderators; `Player` is a normal account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Player,
    Moderator,
    Admin,
}

impl Role {
    /// Reconstruct the role from the two persisted flags (admin wins if both are somehow set).
    pub fn from_flags(is_admin: bool, is_moderator: bool) -> Self {
        if is_admin {
            return Self::Admin;
        }
        if is_moderator {
            return Self::Moderator;
        }
        Self::Player
    }
    pub fn is_admin(self) -> bool {
        self == Self::Admin
    }
    pub fn is_moderator(self) -> bool {
        self == Self::Moderator
    }
}

impl From<protocol::Role> for Role {
    fn from(role: protocol::Role) -> Self {
        match role {
            protocol::Role::Player => Self::Player,
            protocol::Role::Moderator => Self::Moderator,
            protocol::Role::Admin => Self::Admin,
        }
    }
}
