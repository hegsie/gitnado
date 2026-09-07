//! MCP (Model Context Protocol) server management commands
//!
//! Provides Tauri commands for starting, stopping, and configuring
//! the MCP server that allows external tools to query Gitnado.

use crate::error::{GitnadoError, Result};
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
