//! Per-client MCP access tokens (roadmap 4.2, issue #612).
//!
//! Besides the server's master token, each MCP client (Claude Code, Cursor,
//! VS Code, …) can get its own named token. Tokens are shown once at creation
//! and stored only as SHA-256 hashes; revoking one takes effect on the very
//! next request. The last time each client was seen is tracked so a stale or
//! unexpected client stands out.

use std::path::{Path, PathBuf};
use std::sync::RwLock as StdRwLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const CLIENTS_FILE: &str = "mcp-clients.json";
const MAX_NAME_LEN: usize = 60;
/// How often a client's last-used time is written to disk.
const TOUCH_PERSIST_SECS: i64 = 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredClient {
    id: String,
    name: String,
    /// Hex SHA-256 of the token. The token itself is never stored.
    token_hash: String,
    created_at: i64,
    #[serde(default)]
    last_used_at: Option<i64>,
}

/// What the UI sees about a client: never the token or its hash.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpClientInfo {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

/// A newly created client and its token (shown to the user exactly once).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedMcpClient {
    pub client: McpClientInfo,
    pub token: String,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn hash_hex(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Constant-time comparison of two equal-length hex digests.
fn digest_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

impl From<&StoredClient> for McpClientInfo {
    fn from(c: &StoredClient) -> Self {
        Self {
            id: c.id.clone(),
            name: c.name.clone(),
            created_at: c.created_at,
            last_used_at: c.last_used_at,
        }
    }
}

#[derive(Default)]
pub struct ClientRegistry {
    config_dir: Option<PathBuf>,
    clients: StdRwLock<Vec<StoredClient>>,
    /// Last time a touch was persisted, per client id.
    persisted_touch: StdRwLock<std::collections::HashMap<String, i64>>,
}

impl ClientRegistry {
    pub fn load(config_dir: &Path) -> Self {
        let clients = std::fs::read_to_string(config_dir.join(CLIENTS_FILE))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            config_dir: Some(config_dir.to_path_buf()),
            clients: StdRwLock::new(clients),
            persisted_touch: Default::default(),
        }
    }

    fn persist(&self, clients: &[StoredClient]) -> Result<(), String> {
        let Some(dir) = &self.config_dir else {
            return Ok(());
        };
        std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create config dir: {e}"))?;
        let text = serde_json::to_string_pretty(clients)
            .map_err(|e| format!("Failed to serialize MCP clients: {e}"))?;
        std::fs::write(dir.join(CLIENTS_FILE), text)
            .map_err(|e| format!("Failed to save MCP clients: {e}"))
    }

    pub fn list(&self) -> Vec<McpClientInfo> {
        self.clients
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(McpClientInfo::from)
            .collect()
    }

    /// Create a named client and return its token (the only time it is shown).
    pub fn create(&self, name: &str) -> Result<CreatedMcpClient, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("Give the client a name, e.g. \"Claude Code\"".to_string());
        }
        let name: String = name.chars().take(MAX_NAME_LEN).collect();
        let token = format!("gnc_{}", super::server::generate_auth_token());
        let id = uuid::Uuid::new_v4().to_string();
        let stored = StoredClient {
            id: id.clone(),
            name,
            token_hash: hash_hex(&token),
            created_at: now(),
            last_used_at: None,
        };
        let mut clients = self.clients.write().unwrap_or_else(|e| e.into_inner());
        let mut next = clients.clone();
        next.push(stored.clone());
        self.persist(&next)?;
        *clients = next;
        Ok(CreatedMcpClient {
            client: McpClientInfo::from(&stored),
            token,
        })
    }

    /// Revoke a client's token. Effective on the next request.
    pub fn revoke(&self, id: &str) -> Result<(), String> {
        let mut clients = self.clients.write().unwrap_or_else(|e| e.into_inner());
        if !clients.iter().any(|c| c.id == id) {
            return Err("That client no longer exists".to_string());
        }
        let next: Vec<StoredClient> = clients.iter().filter(|c| c.id != id).cloned().collect();
        self.persist(&next)?;
        *clients = next;
        Ok(())
    }

    /// The id of the client this bearer token belongs to, if any.
    pub fn verify(&self, presented: &str) -> Option<String> {
        if presented.is_empty() {
            return None;
        }
        let hash = hash_hex(presented);
        let clients = self.clients.read().unwrap_or_else(|e| e.into_inner());
        // Compare against every client so the time taken does not reveal
        // which one (if any) matched.
        let mut found = None;
        for c in clients.iter() {
            if digest_eq(&hash, &c.token_hash) && found.is_none() {
                found = Some(c.id.clone());
            }
        }
        found
    }

    /// Record that a client just made a request.
    pub fn touch(&self, id: &str) {
        let t = now();
        let snapshot = {
            let mut clients = self.clients.write().unwrap_or_else(|e| e.into_inner());
            let Some(c) = clients.iter_mut().find(|c| c.id == id) else {
                return;
            };
            c.last_used_at = Some(t);
            clients.clone()
        };
        let mut persisted = self
            .persisted_touch
            .write()
            .unwrap_or_else(|e| e.into_inner());
        let due = persisted
            .get(id)
            .is_none_or(|last| t - last >= TOUCH_PERSIST_SECS);
        if due {
            persisted.insert(id.to_string(), t);
            let _ = self.persist(&snapshot);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_verify_touch_and_revoke() {
        let dir = tempfile::TempDir::new().unwrap();
        let reg = ClientRegistry::load(dir.path());
        let created = reg.create("  Claude Code  ").unwrap();
        assert_eq!(created.client.name, "Claude Code");
        assert!(created.token.starts_with("gnc_"));
        assert_eq!(reg.verify(&created.token), Some(created.client.id.clone()));
        assert_eq!(reg.verify("gnc_wrong"), None);
        assert_eq!(reg.verify(""), None);

        // The token itself is never written to disk.
        let file = std::fs::read_to_string(dir.path().join(CLIENTS_FILE)).unwrap();
        assert!(!file.contains(&created.token));

        reg.touch(&created.client.id);
        assert!(reg.list()[0].last_used_at.is_some());

        // Survives a restart.
        let reloaded = ClientRegistry::load(dir.path());
        assert_eq!(
            reloaded.verify(&created.token),
            Some(created.client.id.clone())
        );
        assert!(reloaded.list()[0].last_used_at.is_some());

        reloaded.revoke(&created.client.id).unwrap();
        assert_eq!(reloaded.verify(&created.token), None);
        assert!(reloaded.list().is_empty());
        assert!(reloaded.revoke(&created.client.id).is_err());
        assert!(ClientRegistry::load(dir.path()).list().is_empty());
    }

    #[test]
    fn names_are_required_and_bounded() {
        let reg = ClientRegistry::default();
        assert!(reg.create("   ").is_err());
        let long = reg.create(&"x".repeat(200)).unwrap();
        assert_eq!(long.client.name.chars().count(), MAX_NAME_LEN);
    }

    #[test]
    fn each_client_has_its_own_token() {
        let reg = ClientRegistry::default();
        let a = reg.create("Cursor").unwrap();
        let b = reg.create("VS Code").unwrap();
        assert_ne!(a.token, b.token);
        assert_eq!(reg.verify(&a.token), Some(a.client.id.clone()));
        assert_eq!(reg.verify(&b.token), Some(b.client.id.clone()));
        reg.revoke(&a.client.id).unwrap();
        assert_eq!(reg.verify(&a.token), None);
        assert_eq!(reg.verify(&b.token), Some(b.client.id));
    }

    #[test]
    fn info_serializes_camel_case_without_secrets() {
        let reg = ClientRegistry::default();
        let created = reg.create("Cursor").unwrap();
        let json = serde_json::to_string(&reg.list()).unwrap();
        assert!(json.contains("createdAt") && json.contains("lastUsedAt"));
        assert!(!json.contains("tokenHash") && !json.contains(&created.token));
    }
}
