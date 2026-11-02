//! MCP client mode commands (roadmap 4.2, issue #613): manage the external
//! MCP servers Gitnado's AI features may call for context.

use tauri::{command, State};

use crate::error::{GitnadoError, Result};
use crate::services::ai::mcp_client::{
    self, ExternalContext, ExternalMcpServer, ExternalTool, SharedExternalServers,
};

fn err(e: String) -> GitnadoError {
    GitnadoError::OperationFailed(e)
}

fn find(servers: &SharedExternalServers, id: &str) -> Result<ExternalMcpServer> {
    servers
        .get(id)
        .ok_or_else(|| err("That server no longer exists".to_string()))
}

#[command]
pub async fn list_external_mcp_servers(
    servers: State<'_, SharedExternalServers>,
) -> Result<Vec<ExternalMcpServer>> {
    Ok(servers.list())
}

/// Add or update a server. `token` (when non-empty) is stored in the system
/// keyring; `clear_token` removes a stored one. Otherwise the stored token is
/// kept as is.
#[command]
pub async fn save_external_mcp_server(
    servers: State<'_, SharedExternalServers>,
    server: ExternalMcpServer,
    token: Option<String>,
    clear_token: Option<bool>,
) -> Result<ExternalMcpServer> {
    mcp_client::validate(&server).map_err(err)?;
    let mut server = server;
    let existing_has_token = servers
        .get(&server.id)
        .map(|s| s.has_token)
        .unwrap_or(false);
    server.has_token = existing_has_token;
    // Save first so a new server has its id before the token is keyed by it.
    let mut saved = servers.upsert(server).map_err(err)?;
    let key = mcp_client::keyring_key(&saved.id);
    if let Some(token) = token
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
    {
        crate::commands::credentials::store_keyring_token(key, token).await?;
        saved.has_token = true;
    } else if clear_token.unwrap_or(false) {
        crate::commands::credentials::delete_keyring_token(key).await?;
        saved.has_token = false;
    } else {
        return Ok(saved);
    }
    servers.upsert(saved).map_err(err)
}

#[command]
pub async fn remove_external_mcp_server(
    servers: State<'_, SharedExternalServers>,
    id: String,
) -> Result<()> {
    let server = find(&servers, &id)?;
    if server.has_token {
        let _ =
            crate::commands::credentials::delete_keyring_token(mcp_client::keyring_key(&id)).await;
    }
    servers.remove(&id).map_err(err)
}

/// Connect to a server and list its tools (the "Test" button).
#[command]
pub async fn list_external_mcp_tools(
    servers: State<'_, SharedExternalServers>,
    id: String,
) -> Result<Vec<ExternalTool>> {
    let server = find(&servers, &id)?;
    let token = mcp_client::token_for_server(&server).await;
    mcp_client::list_tools(&server, token.as_deref())
        .await
        .map_err(err)
}

/// Show exactly what a server would add to an AI prompt for this repository.
#[command]
pub async fn preview_external_mcp_context(
    servers: State<'_, SharedExternalServers>,
    id: String,
    repo_path: String,
) -> Result<Option<ExternalContext>> {
    let server = find(&servers, &id)?;
    let token = mcp_client::token_for_server(&server).await;
    let vars = mcp_client::ContextVars::from_repo(&repo_path);
    mcp_client::fetch_context(&server, token.as_deref(), &vars)
        .await
        .map_err(err)
}
