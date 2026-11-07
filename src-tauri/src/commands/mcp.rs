//! MCP (Model Context Protocol) server management commands
//!
//! Provides Tauri commands for starting, stopping, and configuring
//! the MCP server that allows external tools to query Gitnado.

use crate::error::{GitnadoError, Result};
use crate::services::ai::mcp::clients::{CreatedMcpClient, McpClientInfo};
use crate::services::ai::mcp::write::{ConsentRequest, WriteSettings};
use crate::services::ai::mcp::{McpConfig, McpState, McpStatus};
use tauri::{command, State};

/// Start the MCP server
#[command]
pub async fn start_mcp_server(state: State<'_, McpState>) -> Result<()> {
    let mut server = state.write().await;
    server.start().await.map_err(GitnadoError::OperationFailed)
}

/// Stop the MCP server
#[command]
pub async fn stop_mcp_server(state: State<'_, McpState>) -> Result<()> {
    let mut server = state.write().await;
    server.stop().await.map_err(GitnadoError::OperationFailed)
}

/// Get the current MCP server status
#[command]
pub async fn get_mcp_status(state: State<'_, McpState>) -> Result<McpStatus> {
    let server = state.read().await;
    Ok(server.get_status())
}

/// Get the current MCP server configuration
#[command]
pub async fn get_mcp_config(state: State<'_, McpState>) -> Result<McpConfig> {
    let server = state.read().await;
    Ok(server.get_config().clone())
}

/// Set the MCP server configuration
///
/// The access token is not part of what a caller may set: the backend keeps
/// the stored one and `regenerate_mcp_token` is the only way to change it.
#[command]
pub async fn set_mcp_config(state: State<'_, McpState>, config: McpConfig) -> Result<()> {
    let mut server = state.write().await;
    server
        .set_config(config)
        .map_err(GitnadoError::OperationFailed)
}

/// Generate a new MCP access token, invalidating the previous one
#[command]
pub async fn regenerate_mcp_token(state: State<'_, McpState>) -> Result<String> {
    let mut server = state.write().await;
    server
        .regenerate_auth_token()
        .map_err(GitnadoError::OperationFailed)
}

/// Write-tool settings: on/off and the saved "always allow" policies.
#[command]
pub async fn get_mcp_write_settings(state: State<'_, McpState>) -> Result<WriteSettings> {
    Ok(state.read().await.write_gate().settings())
}

/// Replace the write-tool settings. Turning write tools off denies every
/// request still waiting for an answer.
#[command]
pub async fn set_mcp_write_settings(
    state: State<'_, McpState>,
    settings: WriteSettings,
) -> Result<()> {
    let gate = state.read().await.write_gate();
    gate.set_settings(settings)
        .map_err(GitnadoError::OperationFailed)
}

/// Write requests waiting for the user (e.g. after the window reloaded).
#[command]
pub async fn get_pending_mcp_consents(state: State<'_, McpState>) -> Result<Vec<ConsentRequest>> {
    Ok(state.read().await.write_gate().pending_requests())
}

/// Approve or deny a waiting write request. With `always_allow_pattern`,
/// approving also saves a policy for this tool and repository.
#[command]
pub async fn respond_mcp_consent(
    state: State<'_, McpState>,
    id: u64,
    approve: bool,
    always_allow_pattern: Option<String>,
) -> Result<()> {
    let gate = state.read().await.write_gate();
    gate.respond(id, approve, always_allow_pattern)
        .map_err(GitnadoError::OperationFailed)
}

/// Named MCP client tokens (never the tokens themselves).
#[command]
pub async fn list_mcp_clients(state: State<'_, McpState>) -> Result<Vec<McpClientInfo>> {
    Ok(state.read().await.clients().list())
}

/// Create a named client token. The token is returned only here.
#[command]
pub async fn create_mcp_client(
    state: State<'_, McpState>,
    name: String,
) -> Result<CreatedMcpClient> {
    let clients = state.read().await.clients();
    clients.create(&name).map_err(GitnadoError::OperationFailed)
}

/// Revoke a client token; it stops working on the next request.
#[command]
pub async fn revoke_mcp_client(state: State<'_, McpState>, id: String) -> Result<()> {
    let clients = state.read().await.clients();
    clients.revoke(&id).map_err(GitnadoError::OperationFailed)
}

/// How to launch the stdio bridge: this executable plus `--mcp-stdio`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioCommand {
    pub program: String,
    pub args: Vec<String>,
}

#[command]
pub async fn get_mcp_stdio_command() -> Result<McpStdioCommand> {
    let exe = std::env::current_exe().map_err(|e| {
        GitnadoError::OperationFailed(format!("Cannot locate the Gitnado executable: {e}"))
    })?;
    Ok(McpStdioCommand {
        program: exe.to_string_lossy().into_owned(),
        args: vec!["--mcp-stdio".to_string()],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::ai::mcp::server::McpServer;
    use tempfile::TempDir;

    /// Build a server backed by a throwaway config directory.
    /// The TempDir is returned so it outlives the server.
    fn test_server() -> (TempDir, McpServer) {
        let dir = TempDir::new().expect("Failed to create temp dir");
        let server = McpServer::new(dir.path().to_path_buf());
        (dir, server)
    }

    #[test]
    fn test_mcp_config_camel_case_serialization() {
        let config = McpConfig {
            enabled: true,
            port: 3001,
            allowed_origins: Vec::new(),
            auth_token: String::new(),
        };
        let json = serde_json::to_string(&config).expect("Failed to serialize");
        // Verify camelCase serialization
        assert!(json.contains("\"enabled\""));
        assert!(json.contains("\"port\""));
    }

    #[test]
    fn test_mcp_status_camel_case_serialization() {
        let status = McpStatus {
            running: true,
            port: 3001,
            url: Some("http://127.0.0.1:3001".to_string()),
            last_error: None,
        };
        let json = serde_json::to_string(&status).expect("Failed to serialize");
        assert!(json.contains("\"running\""));
        assert!(json.contains("\"port\""));
        assert!(json.contains("\"url\""));
        // The frontend reads status.lastError to explain why the server is stopped
        assert!(json.contains("\"lastError\""));
    }

    #[tokio::test]
    async fn test_server_lifecycle() {
        let (_dir, server) = test_server();
        let status = server.get_status();
        assert!(!status.running);
        assert_eq!(status.port, 3001);
    }

    #[test]
    fn test_config_default_values() {
        let config = McpConfig::default();
        assert!(!config.enabled);
        assert_eq!(config.port, 3001);
    }

    #[test]
    fn test_config_deserialization_from_frontend() {
        // Simulate what the frontend would send (camelCase)
        let json = r#"{"enabled":true,"port":4000}"#;
        let config: McpConfig = serde_json::from_str(json).expect("Failed to deserialize");
        assert!(config.enabled);
        assert_eq!(config.port, 4000);
    }

    #[tokio::test]
    async fn test_update_open_repos() {
        let (_dir, server) = test_server();
        server
            .update_open_repos(vec!["/repo1".to_string(), "/repo2".to_string()])
            .await;

        // Verify via status that the server is still functional
        let status = server.get_status();
        assert!(!status.running);
    }
}
