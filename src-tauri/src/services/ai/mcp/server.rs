//! MCP server implementation
//!
//! Lightweight HTTP server using `tokio::net::TcpListener` that implements
//! the MCP JSON-RPC protocol for external tool integration.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock as StdRwLock};

use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::RwLock;

use super::tools;

const MCP_CONFIG_FILE: &str = "mcp_config.json";

/// Number of characters in a generated bearer token
const AUTH_TOKEN_LEN: usize = 43;

/// The message every rejected-authentication response carries.
///
/// It is deliberately identical for a missing header, a wrong scheme and a
/// wrong token so a caller cannot learn which half it got wrong, and it names
/// the exact fix because clients configured before authentication existed will
/// start failing with it.
pub const UNAUTHORIZED_MESSAGE: &str =
    "Unauthorized: this MCP server requires an 'Authorization: Bearer <token>' header. \
     An MCP client configured before Gitnado added authentication must add that header. \
     Copy the token from Gitnado Settings -> MCP Server.";

/// Generate a new random bearer token for the MCP server
pub fn generate_auth_token() -> String {
    rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(AUTH_TOKEN_LEN)
        .map(char::from)
        .collect()
}

/// MCP server configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfig {
    pub enabled: bool,
    pub port: u16,
    /// Allowed origins for CORS and for the request-path origin check
    /// (empty = localhost only, and no `Origin` requirement)
    #[serde(default)]
    pub allowed_origins: Vec<String>,
    /// Bearer token every request must present. Generated on first start and
    /// persisted with the rest of the configuration; never sent to any remote.
    #[serde(default)]
    pub auth_token: String,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 3001,
            allowed_origins: Vec::new(),
            auth_token: String::new(),
        }
    }
}

impl McpConfig {
    /// Load configuration from disk
    pub fn load(config_dir: &Path) -> Result<Self, String> {
        let config_path = config_dir.join(MCP_CONFIG_FILE);

        if !config_path.exists() {
            return Ok(Self::default());
        }

        let contents = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read MCP config: {}", e))?;

        serde_json::from_str(&contents).map_err(|e| format!("Failed to parse MCP config: {}", e))
    }

    /// Save configuration to disk
    pub fn save(&self, config_dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(config_dir)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;

        let config_path = config_dir.join(MCP_CONFIG_FILE);

        let contents = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize MCP config: {}", e))?;

        std::fs::write(&config_path, contents)
            .map_err(|e| format!("Failed to write MCP config: {}", e))
    }
}

/// The part of the configuration the request path enforces on every request.
///
/// It is shared with the running accept loop, so a regenerated token or an
/// edited origin list takes effect immediately instead of at the next restart.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuthSettings {
    /// Expected bearer token. Empty means "no token yet": every request is
    /// refused rather than let through unauthenticated.
    pub token: String,
    /// Origins allowed to talk to the server (empty = localhost-only posture)
    pub allowed_origins: Vec<String>,
}

impl AuthSettings {
    fn from_config(config: &McpConfig) -> Self {
        Self {
            token: config.auth_token.clone(),
            allowed_origins: config.allowed_origins.clone(),
        }
    }
}

/// A request refused before it reached the JSON-RPC dispatcher
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthRejection {
    /// HTTP status to answer with
    pub status: u16,
    /// JSON-RPC error code carried in the body
    pub code: i32,
    /// Human-readable explanation, safe to show to the caller
    pub message: String,
}

impl AuthRejection {
    fn unauthorized() -> Self {
        Self {
            status: 401,
            code: -32001,
            message: UNAUTHORIZED_MESSAGE.to_string(),
        }
    }

    fn forbidden(message: String) -> Self {
        Self {
            status: 403,
            code: -32002,
            message,
        }
    }
}

/// Read a header value out of a raw HTTP request.
///
/// Only the head is scanned: the loop stops at the blank line, so a body that
/// happens to contain something header-shaped can never be mistaken for one.
fn header_value<'a>(request: &'a str, name: &str) -> Option<&'a str> {
    for line in request.lines().skip(1) {
        if line.is_empty() {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case(name) {
            return Some(value.trim());
        }
    }
    None
}

/// Compare a presented secret against the expected one without leaking its
/// contents through timing.
///
/// Both sides are hashed first, so the comparison always walks exactly 32
/// bytes with no early exit and reveals neither the length nor the position of
/// the first differing byte.
fn constant_time_eq(presented: &str, expected: &str) -> bool {
    let mut hasher = Sha256::new();
    hasher.update(presented.as_bytes());
    let presented_hash = hasher.finalize();

    let mut hasher = Sha256::new();
    hasher.update(expected.as_bytes());
    let expected_hash = hasher.finalize();

    let mut diff = 0u8;
    for (a, b) in presented_hash.iter().zip(expected_hash.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// Decide whether a raw HTTP request may reach the MCP tools.
///
/// Origin is checked first so a browser page from an unlisted origin is turned
/// away before it can probe the token, then the bearer token is verified.
pub fn authorize_request(request: &str, settings: &AuthSettings) -> Result<(), AuthRejection> {
    if !settings.allowed_origins.is_empty() {
        match header_value(request, "origin") {
            Some(origin) if settings.allowed_origins.iter().any(|a| a == origin) => {}
            Some(_) => {
                return Err(AuthRejection::forbidden(
                    "Forbidden: this origin is not in the MCP allowed origins list.".to_string(),
                ));
            }
            None => {
                return Err(AuthRejection::forbidden(
                    "Forbidden: this MCP server only accepts requests from its configured \
                     allowed origins, and the request sent no Origin header."
                        .to_string(),
                ));
            }
        }
    }

    // No token generated yet: refuse everything rather than serve repository
    // contents unauthenticated.
    if settings.token.is_empty() {
        return Err(AuthRejection::unauthorized());
    }

    let Some(header) = header_value(request, "authorization") else {
        return Err(AuthRejection::unauthorized());
    };

    let mut parts = header.splitn(2, ' ');
    let scheme = parts.next().unwrap_or("");
    let presented = parts.next().unwrap_or("").trim();

    if !scheme.eq_ignore_ascii_case("bearer") {
        return Err(AuthRejection::unauthorized());
    }

    if !constant_time_eq(presented, &settings.token) {
        return Err(AuthRejection::unauthorized());
    }

    Ok(())
}

/// The `Access-Control-Allow-Origin` value for a response, reflecting the
/// configured origins instead of a hard-coded one.
///
/// With no configured origins the server keeps its localhost-only posture.
/// With configured origins the request's own origin is echoed when it is
/// listed, and otherwise the first configured origin is named so a browser can
/// never read a response from an origin that is not allowed.
fn cors_allow_origin(request: &str, settings: &AuthSettings) -> String {
    if settings.allowed_origins.is_empty() {
        return "http://localhost".to_string();
    }

    match header_value(request, "origin") {
        Some(origin) if settings.allowed_origins.iter().any(|a| a == origin) => origin.to_string(),
        _ => settings.allowed_origins[0].clone(),
    }
}

/// Strip the value of any `Authorization` header so a request head can be
/// logged without ever writing the token to disk or to the console.
pub fn redact_authorization(request: &str) -> String {
    request
        .lines()
        .map(|line| match line.split_once(':') {
            Some((key, _)) if key.trim().eq_ignore_ascii_case("authorization") => {
                format!("{}: <redacted>", key.trim())
            }
            _ => line.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// MCP server status information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub port: u16,
    pub url: Option<String>,
    /// Why the server is not running, when the last start attempt failed
    pub last_error: Option<String>,
}

/// JSON-RPC request structure
#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    #[allow(dead_code)]
    jsonrpc: String,
    id: Value,
    method: String,
    params: Option<Value>,
}

/// JSON-RPC response structure
#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

/// JSON-RPC error structure
#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

impl JsonRpcResponse {
    fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }

    fn error(id: Value, code: i32, message: String) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(JsonRpcError { code, message }),
        }
    }
}

/// MCP server instance
pub struct McpServer {
    config: McpConfig,
    /// Directory the MCP configuration is persisted in
    config_dir: PathBuf,
    running: Arc<AtomicBool>,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    /// Paths of repositories currently open in Gitnado
    open_repos: Arc<RwLock<Vec<String>>>,
    /// Error from the last failed start attempt, surfaced in the status
    last_error: Option<String>,
    /// Token and origin rules enforced by the running accept loop
    auth: Arc<StdRwLock<AuthSettings>>,
}

/// Shared MCP server state
pub type McpState = Arc<RwLock<McpServer>>;

/// Create a new MCP server state instance backed by the saved configuration
pub fn create_mcp_state(config_dir: PathBuf) -> McpState {
    Arc::new(RwLock::new(McpServer::new(config_dir)))
}

impl McpServer {
    /// Create a new MCP server, restoring the configuration saved on disk
    pub fn new(config_dir: PathBuf) -> Self {
        let mut config = McpConfig::load(&config_dir).unwrap_or_default();

        // First start — or an upgrade from a version that had no
        // authentication — gets a token generated and persisted here, so the
        // server is never reachable without one.
        let needs_token = config.auth_token.is_empty();
        if needs_token {
            config.auth_token = generate_auth_token();
        }

        let server = Self {
            auth: Arc::new(StdRwLock::new(AuthSettings::from_config(&config))),
            config,
            config_dir,
            running: Arc::new(AtomicBool::new(false)),
            shutdown_tx: None,
            open_repos: Arc::new(RwLock::new(Vec::new())),
            last_error: None,
        };

        if needs_token {
            server.persist_config();
        }

        server
    }

    /// Persist the current configuration, logging (but not failing on) write errors
    fn persist_config(&self) {
        if let Err(e) = self.config.save(&self.config_dir) {
            tracing::warn!("Failed to persist MCP config: {}", e);
        }
    }

    /// Publish the current token and origin rules to the running accept loop
    fn sync_auth(&self) {
        let mut auth = self
            .auth
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *auth = AuthSettings::from_config(&self.config);
    }

    /// Replace the bearer token with a freshly generated one and persist it.
    /// Existing clients stop working until they are given the new token.
    pub fn regenerate_auth_token(&mut self) -> Result<String, String> {
        let token = generate_auth_token();
        self.config.auth_token = token.clone();
        self.config.save(&self.config_dir)?;
        self.sync_auth();
        tracing::info!("MCP access token regenerated");
        Ok(token)
    }

    /// Start the MCP server
    pub async fn start(&mut self) -> Result<(), String> {
        if self.running.load(Ordering::SeqCst) {
            return Err("MCP server is already running".to_string());
        }

        let addr = format!("127.0.0.1:{}", self.config.port);
        let listener = match TcpListener::bind(&addr).await {
            Ok(listener) => listener,
            Err(e) => {
                let message = format!("Failed to bind to {}: {}", addr, e);
                self.last_error = Some(message.clone());
                return Err(message);
            }
        };

        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        self.shutdown_tx = Some(shutdown_tx);

        let running = self.running.clone();
        running.store(true, Ordering::SeqCst);

        let open_repos = self.open_repos.clone();
        let auth = self.auth.clone();

        tokio::spawn(async move {
            Self::run_server(listener, running, shutdown_rx, open_repos, auth).await;
        });

        // Remember that the server should come back up on the next launch
        self.last_error = None;
        self.config.enabled = true;
        self.persist_config();

        tracing::info!("MCP server started on {}", addr);
        Ok(())
    }

    /// Stop the MCP server
    pub async fn stop(&mut self) -> Result<(), String> {
        if !self.running.load(Ordering::SeqCst) {
            return Err("MCP server is not running".to_string());
        }

        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }

        self.running.store(false, Ordering::SeqCst);

        // Remember that the server should stay down on the next launch
        self.last_error = None;
        self.config.enabled = false;
        self.persist_config();

        tracing::info!("MCP server stopped");
        Ok(())
    }

    /// Get the current server status
    pub fn get_status(&self) -> McpStatus {
        let running = self.running.load(Ordering::SeqCst);
        McpStatus {
            running,
            port: self.config.port,
            url: if running {
                Some(format!("http://127.0.0.1:{}", self.config.port))
            } else {
                None
            },
            last_error: self.last_error.clone(),
        }
    }

    /// Get the current configuration
    pub fn get_config(&self) -> &McpConfig {
        &self.config
    }

    /// Set the server configuration and persist it to disk.
    ///
    /// The token is owned by the backend: a saved configuration never replaces
    /// it, so a caller that round-trips the config (or a stale one that predates
    /// authentication) cannot blank it and reopen the server to anyone.
    pub fn set_config(&mut self, config: McpConfig) -> Result<(), String> {
        let token = if self.config.auth_token.is_empty() {
            generate_auth_token()
        } else {
            self.config.auth_token.clone()
        };

        self.config = McpConfig {
            auth_token: token,
            ..config
        };
        self.config.save(&self.config_dir)?;
        self.sync_auth();
        Ok(())
    }

    /// Update the list of open repositories
    pub async fn update_open_repos(&self, repos: Vec<String>) {
        let mut open = self.open_repos.write().await;
        *open = repos;
    }

    /// Run the server loop accepting connections until shutdown
    async fn run_server(
        listener: TcpListener,
        running: Arc<AtomicBool>,
        mut shutdown_rx: tokio::sync::oneshot::Receiver<()>,
        open_repos: Arc<RwLock<Vec<String>>>,
        auth: Arc<StdRwLock<AuthSettings>>,
    ) {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    running.store(false, Ordering::SeqCst);
                    break;
                }
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((stream, _addr)) => {
                            let repos = open_repos.clone();
                            let auth = auth.clone();
                            tokio::spawn(async move {
                                if let Err(e) = Self::handle_connection(stream, repos, auth).await {
                                    tracing::warn!("MCP connection error: {}", e);
                                }
                            });
                        }
                        Err(e) => {
                            tracing::warn!("MCP accept error: {}", e);
                        }
                    }
                }
            }
        }
    }

    /// Handle a single HTTP connection
    async fn handle_connection(
        mut stream: tokio::net::TcpStream,
        open_repos: Arc<RwLock<Vec<String>>>,
        auth: Arc<StdRwLock<AuthSettings>>,
    ) -> Result<(), String> {
        // Snapshot the auth rules once per connection so the lock is never held
        // across an await
        let settings = auth
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();

        // Read until we find the end of headers, then read the body based on Content-Length
        let mut buf = Vec::with_capacity(65536);
        let mut tmp = vec![0u8; 8192];

        // Read headers first
        loop {
            let n = stream
                .read(&mut tmp)
                .await
                .map_err(|e| format!("Read error: {}", e))?;

            if n == 0 {
                if buf.is_empty() {
                    return Ok(());
                }
                break;
            }

            buf.extend_from_slice(&tmp[..n]);

            // Check if we have the complete headers
            let s = String::from_utf8_lossy(&buf);
            if s.contains("\r\n\r\n") || s.contains("\n\n") {
                // Check if we also have the full body
                if let Some(content_len) = parse_content_length(&s) {
                    let header_end = if let Some(idx) = s.find("\r\n\r\n") {
                        idx + 4
                    } else if let Some(idx) = s.find("\n\n") {
                        idx + 2
                    } else {
                        break;
                    };
                    let body_received = buf.len() - header_end;
                    if body_received >= content_len {
                        break;
                    }
                    // Need more body data, continue reading
                } else {
                    break;
                }
            }

            if buf.len() > 1_048_576 {
                // 1MB limit
                return Self::send_http_response(
                    &mut stream,
                    413,
                    &serde_json::to_string(&JsonRpcResponse::error(
                        Value::Null,
                        -32600,
                        "Request too large".to_string(),
                    ))
                    .unwrap_or_default(),
                    &cors_allow_origin("", &settings),
                )
                .await;
            }
        }

        let request_str = String::from_utf8_lossy(&buf);
        let allow_origin = cors_allow_origin(&request_str, &settings);

        // Parse HTTP request - find the body after the blank line
        let body = if let Some(idx) = request_str.find("\r\n\r\n") {
            &request_str[idx + 4..]
        } else if let Some(idx) = request_str.find("\n\n") {
            &request_str[idx + 2..]
        } else {
            return Self::send_http_response(
                &mut stream,
                400,
                &serde_json::to_string(&JsonRpcResponse::error(
                    Value::Null,
                    -32700,
                    "Invalid HTTP request".to_string(),
                ))
                .unwrap_or_default(),
                &allow_origin,
            )
            .await;
        };

        // Check if it's a POST request (MCP uses POST)
        let is_post = request_str.starts_with("POST ");

        // Handle OPTIONS for CORS preflight. Browsers never send credentials on
        // a preflight, so it is answered without a token — the actual POST that
        // follows is still authenticated.
        if request_str.starts_with("OPTIONS ") {
            return Self::send_cors_response(&mut stream, &allow_origin).await;
        }

        // Every other request must authenticate before it can reach the tools,
        // which expose the contents and history of every open repository
        if let Err(rejection) = authorize_request(&request_str, &settings) {
            // The head is logged with the Authorization value stripped: the
            // token must never reach the log
            tracing::warn!(
                "MCP request rejected ({}): {}",
                rejection.status,
                redact_authorization(request_str.lines().next().unwrap_or(""))
            );
            return Self::send_http_response(
                &mut stream,
                rejection.status,
                &serde_json::to_string(&JsonRpcResponse::error(
                    Value::Null,
                    rejection.code,
                    rejection.message,
                ))
                .unwrap_or_default(),
                &allow_origin,
            )
            .await;
        }

        if !is_post {
            return Self::send_http_response(
                &mut stream,
                405,
                &serde_json::to_string(&JsonRpcResponse::error(
                    Value::Null,
                    -32600,
                    "Method not allowed. Use POST.".to_string(),
                ))
                .unwrap_or_default(),
                &allow_origin,
            )
            .await;
        }

        // Parse JSON-RPC request
        let rpc_request: JsonRpcRequest = match serde_json::from_str(body) {
            Ok(req) => req,
            Err(e) => {
                let response =
                    JsonRpcResponse::error(Value::Null, -32700, format!("Parse error: {}", e));
                let response_json = serde_json::to_string(&response).unwrap_or_default();
                return Self::send_http_response(&mut stream, 200, &response_json, &allow_origin)
                    .await;
            }
        };

        // Route to handler
        let repos = open_repos.read().await;
        let response = Self::handle_rpc_request(&rpc_request, &repos).await;
        let response_json = serde_json::to_string(&response).unwrap_or_default();

        Self::send_http_response(&mut stream, 200, &response_json, &allow_origin).await
    }

    /// Route a JSON-RPC request to the appropriate handler
    async fn handle_rpc_request(
        request: &JsonRpcRequest,
        open_repos: &[String],
    ) -> JsonRpcResponse {
        match request.method.as_str() {
            "initialize" => Self::handle_initialize(request),
            "tools/list" => Self::handle_tools_list(request),
            "tools/call" => Self::handle_tools_call(request, open_repos).await,
            _ => JsonRpcResponse::error(
                request.id.clone(),
                -32601,
                format!("Method not found: {}", request.method),
            ),
        }
    }

    /// Handle the `initialize` method
    fn handle_initialize(request: &JsonRpcRequest) -> JsonRpcResponse {
        let result = serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "tools": {}
            },
            "serverInfo": {
                "name": "gitnado",
                "version": env!("CARGO_PKG_VERSION")
            }
        });
        JsonRpcResponse::success(request.id.clone(), result)
    }

    /// Handle the `tools/list` method
    fn handle_tools_list(request: &JsonRpcRequest) -> JsonRpcResponse {
        let tool_list = tools::get_tool_list();
        let result = serde_json::json!({
            "tools": tool_list
        });
        JsonRpcResponse::success(request.id.clone(), result)
    }

    /// Handle the `tools/call` method
    async fn handle_tools_call(request: &JsonRpcRequest, open_repos: &[String]) -> JsonRpcResponse {
        let params = match &request.params {
            Some(p) => p,
            None => {
                return JsonRpcResponse::error(
                    request.id.clone(),
                    -32602,
                    "Missing params".to_string(),
                );
            }
        };

        let tool_name = match params.get("name").and_then(|n| n.as_str()) {
            Some(name) => name,
            None => {
                return JsonRpcResponse::error(
                    request.id.clone(),
                    -32602,
                    "Missing tool name in params".to_string(),
                );
            }
        };

        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or(Value::Object(serde_json::Map::new()));

        match tools::call_tool(tool_name, &arguments, open_repos).await {
            Ok(result) => {
                let content = serde_json::json!({
                    "content": [{
                        "type": "text",
                        "text": serde_json::to_string_pretty(&result).unwrap_or_default()
                    }]
                });
                JsonRpcResponse::success(request.id.clone(), content)
            }
            Err(e) => {
                let content = serde_json::json!({
                    "content": [{
                        "type": "text",
                        "text": e
                    }],
                    "isError": true
                });
                JsonRpcResponse::success(request.id.clone(), content)
            }
        }
    }

    /// Send an HTTP response, allowing the configured origin
    async fn send_http_response(
        stream: &mut tokio::net::TcpStream,
        status: u16,
        body: &str,
        allow_origin: &str,
    ) -> Result<(), String> {
        let status_text = match status {
            200 => "OK",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            405 => "Method Not Allowed",
            413 => "Payload Too Large",
            _ => "Error",
        };

        let response = format!(
            "HTTP/1.1 {status} {status_text}\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\
             {}\
             Access-Control-Allow-Origin: {allow_origin}\r\n\
             Access-Control-Allow-Methods: POST, OPTIONS\r\n\
             Access-Control-Allow-Headers: Content-Type, Authorization\r\n\
             Vary: Origin\r\n\
             Connection: close\r\n\
             \r\n{body}",
            body.len(),
            if status == 401 {
                "WWW-Authenticate: Bearer realm=\"Gitnado MCP\"\r\n"
            } else {
                ""
            },
        );

        stream
            .write_all(response.as_bytes())
            .await
            .map_err(|e| format!("Write error: {}", e))?;

        stream
            .flush()
            .await
            .map_err(|e| format!("Flush error: {}", e))?;

        Ok(())
    }

    /// Send a CORS preflight response for the configured origin
    async fn send_cors_response(
        stream: &mut tokio::net::TcpStream,
        allow_origin: &str,
    ) -> Result<(), String> {
        let response = format!(
            "HTTP/1.1 204 No Content\r\n\
             Access-Control-Allow-Origin: {allow_origin}\r\n\
             Access-Control-Allow-Methods: POST, OPTIONS\r\n\
             Access-Control-Allow-Headers: Content-Type, Authorization\r\n\
             Access-Control-Max-Age: 86400\r\n\
             Vary: Origin\r\n\
             Connection: close\r\n\
             \r\n"
        );

        stream
            .write_all(response.as_bytes())
            .await
            .map_err(|e| format!("Write error: {}", e))?;

        stream
            .flush()
            .await
            .map_err(|e| format!("Flush error: {}", e))?;

        Ok(())
    }
}

/// Parse the Content-Length header from an HTTP request string
fn parse_content_length(request: &str) -> Option<usize> {
    for line in request.lines() {
        let lower = line.to_lowercase();
        if lower.starts_with("content-length:") {
            return lower
                .trim_start_matches("content-length:")
                .trim()
                .parse()
                .ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Build a server backed by a throwaway config directory.
    /// The TempDir is returned so it outlives the server.
    fn test_server() -> (TempDir, McpServer) {
        let dir = TempDir::new().expect("Failed to create temp dir");
        let server = McpServer::new(dir.path().to_path_buf());
        (dir, server)
    }

    #[test]
    fn test_mcp_server_new() {
        let (_dir, server) = test_server();
        assert!(!server.running.load(Ordering::SeqCst));
        assert_eq!(server.config.port, 3001);
        assert!(!server.config.enabled);
    }

    #[test]
    fn test_get_status_not_running() {
        let (_dir, server) = test_server();
        let status = server.get_status();
        assert!(!status.running);
        assert_eq!(status.port, 3001);
        assert!(status.url.is_none());
    }

    #[test]
    fn test_get_status_running() {
        let (_dir, server) = test_server();
        server.running.store(true, Ordering::SeqCst);
        let status = server.get_status();
        assert!(status.running);
        assert_eq!(status.url, Some("http://127.0.0.1:3001".to_string()));
    }

    #[test]
    fn test_get_config() {
        let (_dir, server) = test_server();
        let config = server.get_config();
        assert!(!config.enabled);
        assert_eq!(config.port, 3001);
    }

    #[test]
    fn test_set_config() {
        let (_dir, mut server) = test_server();
        let config = McpConfig {
            enabled: true,
            port: 8080,
            allowed_origins: Vec::new(),
            auth_token: String::new(),
        };
        server.set_config(config).expect("Failed to set config");
        assert!(server.config.enabled);
        assert_eq!(server.config.port, 8080);
    }

    #[test]
    fn test_mcp_config_default() {
        let config = McpConfig::default();
        assert!(!config.enabled);
        assert_eq!(config.port, 3001);
    }

    #[test]
    fn test_mcp_config_serialization() {
        let config = McpConfig {
            enabled: true,
            port: 4000,
            allowed_origins: Vec::new(),
            auth_token: String::new(),
        };
        let json = serde_json::to_string(&config).expect("Failed to serialize");
        assert!(json.contains("\"enabled\":true"));
        assert!(json.contains("\"port\":4000"));
    }

    #[test]
    fn test_mcp_config_deserialization() {
        let json = r#"{"enabled":true,"port":5000}"#;
        let config: McpConfig = serde_json::from_str(json).expect("Failed to deserialize");
        assert!(config.enabled);
        assert_eq!(config.port, 5000);
    }

    #[test]
    fn test_mcp_status_serialization() {
        let status = McpStatus {
            running: true,
            port: 3001,
            url: Some("http://127.0.0.1:3001".to_string()),
            last_error: None,
        };
        let json = serde_json::to_string(&status).expect("Failed to serialize");
        assert!(json.contains("\"running\":true"));
        assert!(json.contains("\"port\":3001"));
        assert!(json.contains("\"url\":\"http://127.0.0.1:3001\""));
    }

    #[test]
    fn test_json_rpc_response_success() {
        let response = JsonRpcResponse::success(Value::Number(1.into()), serde_json::json!("ok"));
        assert_eq!(response.jsonrpc, "2.0");
        assert_eq!(response.id, Value::Number(1.into()));
        assert!(response.result.is_some());
        assert!(response.error.is_none());
    }

    #[test]
    fn test_json_rpc_response_error() {
        let response =
            JsonRpcResponse::error(Value::Number(1.into()), -32600, "Bad request".to_string());
        assert_eq!(response.jsonrpc, "2.0");
        assert!(response.result.is_none());
        assert!(response.error.is_some());
        let err = response.error.unwrap();
        assert_eq!(err.code, -32600);
        assert_eq!(err.message, "Bad request");
    }

    #[test]
    fn test_json_rpc_request_parsing() {
        let json = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":null}"#;
        let request: JsonRpcRequest = serde_json::from_str(json).expect("Failed to parse");
        assert_eq!(request.jsonrpc, "2.0");
        assert_eq!(request.method, "initialize");
        assert_eq!(request.id, Value::Number(1.into()));
    }

    #[test]
    fn test_json_rpc_request_with_params() {
        let json = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_status","arguments":{"repo_path":"/tmp/repo"}}}"#;
        let request: JsonRpcRequest = serde_json::from_str(json).expect("Failed to parse");
        assert_eq!(request.method, "tools/call");
        assert!(request.params.is_some());
        let params = request.params.unwrap();
        assert_eq!(params["name"], "get_status");
    }

    #[tokio::test]
    async fn test_handle_initialize() {
        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: Value::Number(1.into()),
            method: "initialize".to_string(),
            params: None,
        };
        let response = McpServer::handle_initialize(&request);
        assert!(response.result.is_some());
        let result = response.result.unwrap();
        assert_eq!(result["protocolVersion"], "2024-11-05");
        assert_eq!(result["serverInfo"]["name"], "gitnado");
        assert_eq!(result["serverInfo"]["version"], env!("CARGO_PKG_VERSION"));
    }

    #[tokio::test]
    async fn test_handle_tools_list() {
        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: Value::Number(1.into()),
            method: "tools/list".to_string(),
            params: None,
        };
        let response = McpServer::handle_tools_list(&request);
        assert!(response.result.is_some());
        let result = response.result.unwrap();
        assert!(result["tools"].is_array());
        assert!(!result["tools"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_handle_unknown_method() {
        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: Value::Number(1.into()),
            method: "unknown/method".to_string(),
            params: None,
        };
        let response = McpServer::handle_rpc_request(&request, &[]).await;
        assert!(response.error.is_some());
        assert_eq!(response.error.unwrap().code, -32601);
    }

    #[tokio::test]
    async fn test_handle_tools_call_missing_params() {
        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: Value::Number(1.into()),
            method: "tools/call".to_string(),
            params: None,
        };
        let response = McpServer::handle_rpc_request(&request, &[]).await;
        assert!(response.error.is_some());
        assert_eq!(response.error.unwrap().code, -32602);
    }

    #[tokio::test]
    async fn test_handle_tools_call_missing_name() {
        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: Value::Number(1.into()),
            method: "tools/call".to_string(),
            params: Some(serde_json::json!({"arguments": {}})),
        };
        let response = McpServer::handle_rpc_request(&request, &[]).await;
        assert!(response.error.is_some());
        assert_eq!(response.error.unwrap().code, -32602);
    }

    #[tokio::test]
    async fn test_update_open_repos() {
        let (_dir, server) = test_server();
        server
            .update_open_repos(vec![
                "/path/to/repo1".to_string(),
                "/path/to/repo2".to_string(),
            ])
            .await;
        let repos = server.open_repos.read().await;
        assert_eq!(repos.len(), 2);
        assert_eq!(repos[0], "/path/to/repo1");
        assert_eq!(repos[1], "/path/to/repo2");
    }

    #[tokio::test]
    async fn test_start_stop_server() {
        let (_dir, mut server) = test_server();
        // Use a high port to avoid conflicts
        server
            .set_config(McpConfig {
                enabled: true,
                port: 19876,
                allowed_origins: Vec::new(),
                auth_token: String::new(),
            })
            .expect("Failed to set config");

        let result = server.start().await;
        assert!(result.is_ok());
        assert!(server.running.load(Ordering::SeqCst));

        // Starting again should fail
        let result = server.start().await;
        assert!(result.is_err());

        let result = server.stop().await;
        assert!(result.is_ok());
        assert!(!server.running.load(Ordering::SeqCst));

        // Stopping again should fail
        let result = server.stop().await;
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_content_length() {
        let request = "POST / HTTP/1.1\r\nContent-Length: 42\r\n\r\n";
        assert_eq!(parse_content_length(request), Some(42));
    }

    #[test]
    fn test_parse_content_length_missing() {
        let request = "POST / HTTP/1.1\r\n\r\n";
        assert_eq!(parse_content_length(request), None);
    }

    #[test]
    fn test_create_mcp_state() {
        let dir = TempDir::new().expect("Failed to create temp dir");
        let state = create_mcp_state(dir.path().to_path_buf());
        // Just verify it creates without panic
        assert!(Arc::strong_count(&state) >= 1);
    }

    // =====================================================
    // Configuration persistence
    // =====================================================

    #[test]
    fn test_mcp_config_save_and_load_round_trip() {
        let dir = TempDir::new().expect("Failed to create temp dir");
        let config = McpConfig {
            enabled: true,
            port: 4321,
            allowed_origins: Vec::new(),
            auth_token: String::new(),
        };

        config.save(dir.path()).expect("Failed to save config");

        let loaded = McpConfig::load(dir.path()).expect("Failed to load config");
        assert!(loaded.enabled);
        assert_eq!(loaded.port, 4321);
    }

    #[test]
    fn test_load_missing_config_returns_default() {
        let dir = TempDir::new().expect("Failed to create temp dir");
        let config = McpConfig::load(dir.path()).expect("Missing config should not be an error");
        assert!(!config.enabled);
        assert_eq!(config.port, 3001);
    }

    #[test]
    fn test_new_restores_saved_config() {
        let dir = TempDir::new().expect("Failed to create temp dir");
        McpConfig {
            enabled: true,
            port: 4321,
            allowed_origins: Vec::new(),
            auth_token: String::new(),
        }
        .save(dir.path())
        .expect("Failed to save config");

        let server = McpServer::new(dir.path().to_path_buf());
        assert_eq!(server.get_config().port, 4321);
        assert!(server.get_config().enabled);
    }

    #[test]
    fn test_set_config_persists_across_instances() {
        let dir = TempDir::new().expect("Failed to create temp dir");

        {
            let mut server = McpServer::new(dir.path().to_path_buf());
            server
                .set_config(McpConfig {
                    enabled: true,
                    port: 4321,
                    allowed_origins: Vec::new(),
                    auth_token: String::new(),
                })
                .expect("Failed to set config");
        }

        let restarted = McpServer::new(dir.path().to_path_buf());
        assert_eq!(restarted.get_config().port, 4321);
        assert!(restarted.get_config().enabled);
    }

    #[test]
    fn test_new_falls_back_to_default_on_corrupt_config() {
        let dir = TempDir::new().expect("Failed to create temp dir");
        std::fs::write(dir.path().join(MCP_CONFIG_FILE), "not json").expect("Failed to write");

        let server = McpServer::new(dir.path().to_path_buf());
        assert_eq!(server.get_config().port, 3001);
        assert!(!server.get_config().enabled);
    }

    /// Ask the OS for a currently unused localhost port
    async fn free_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("Failed to reserve a port");
        listener
            .local_addr()
            .expect("Failed to read reserved address")
            .port()
    }

    #[tokio::test]
    async fn test_start_enables_and_stop_disables_persisted_config() {
        let port = free_port().await;
        let dir = TempDir::new().expect("Failed to create temp dir");
        let mut server = McpServer::new(dir.path().to_path_buf());
        server
            .set_config(McpConfig {
                enabled: false,
                port,
                allowed_origins: Vec::new(),
                auth_token: String::new(),
            })
            .expect("Failed to set config");

        server.start().await.expect("Failed to start server");
        let saved = McpConfig::load(dir.path()).expect("Failed to load config");
        assert!(saved.enabled, "start() should persist enabled = true");
        assert_eq!(saved.port, port);

        server.stop().await.expect("Failed to stop server");
        let saved = McpConfig::load(dir.path()).expect("Failed to load config");
        assert!(!saved.enabled, "stop() should persist enabled = false");
    }

    #[tokio::test]
    async fn test_start_records_bind_error_in_status() {
        // Occupy a port so the server cannot bind to it
        let blocker = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("Failed to occupy port");
        let port = blocker
            .local_addr()
            .expect("Failed to read occupied address")
            .port();

        let dir = TempDir::new().expect("Failed to create temp dir");
        let mut server = McpServer::new(dir.path().to_path_buf());
        server
            .set_config(McpConfig {
                enabled: true,
                port,
                allowed_origins: Vec::new(),
                auth_token: String::new(),
            })
            .expect("Failed to set config");

        let result = server.start().await;
        assert!(result.is_err());

        let status = server.get_status();
        assert!(!status.running);
        let last_error = status.last_error.expect("Bind failure should be recorded");
        assert!(
            last_error.contains("Failed to bind"),
            "unexpected error: {}",
            last_error
        );

        drop(blocker);
    }

    // =====================================================
    // Access token: generation and persistence
    // =====================================================

    #[test]
    fn test_new_generates_a_token_on_first_start() {
        let dir = TempDir::new().expect("Failed to create temp dir");
        let server = McpServer::new(dir.path().to_path_buf());

        let token = server.get_config().auth_token.clone();
        assert_eq!(token.len(), AUTH_TOKEN_LEN);
        assert!(token.chars().all(|c| c.is_ascii_alphanumeric()));

        // ...and it is persisted, so the same token survives a restart
        let saved = McpConfig::load(dir.path()).expect("Failed to load config");
        assert_eq!(saved.auth_token, token);

        let restarted = McpServer::new(dir.path().to_path_buf());
        assert_eq!(restarted.get_config().auth_token, token);
    }

    #[test]
    fn test_upgrade_from_a_config_without_a_token_generates_one() {
        // A config written by a version that had no authentication at all
        let dir = TempDir::new().expect("Failed to create temp dir");
        std::fs::write(
            dir.path().join(MCP_CONFIG_FILE),
            r#"{"enabled":true,"port":4321,"allowedOrigins":[]}"#,
        )
        .expect("Failed to write legacy config");

        let server = McpServer::new(dir.path().to_path_buf());
        assert_eq!(server.get_config().port, 4321, "existing settings are kept");
        assert!(server.get_config().enabled);
        assert!(
            !server.get_config().auth_token.is_empty(),
            "an upgrading user must get a token"
        );

        let saved = McpConfig::load(dir.path()).expect("Failed to load config");
        assert_eq!(saved.auth_token, server.get_config().auth_token);
    }

    #[test]
    fn test_generate_auth_token_is_random() {
        assert_ne!(generate_auth_token(), generate_auth_token());
    }

    #[test]
    fn test_set_config_never_clears_the_token() {
        let dir = TempDir::new().expect("Failed to create temp dir");
        let mut server = McpServer::new(dir.path().to_path_buf());
        let token = server.get_config().auth_token.clone();

        // The frontend saves the config without echoing the secret back
        server
            .set_config(McpConfig {
                enabled: true,
                port: 4321,
                allowed_origins: vec!["http://localhost:5173".to_string()],
                auth_token: String::new(),
            })
            .expect("Failed to set config");

        assert_eq!(server.get_config().auth_token, token);
        assert_eq!(server.get_config().port, 4321);

        let saved = McpConfig::load(dir.path()).expect("Failed to load config");
        assert_eq!(saved.auth_token, token);
    }

    #[test]
    fn test_set_config_cannot_replace_the_token() {
        let dir = TempDir::new().expect("Failed to create temp dir");
        let mut server = McpServer::new(dir.path().to_path_buf());
        let token = server.get_config().auth_token.clone();

        server
            .set_config(McpConfig {
                enabled: false,
                port: 3001,
                allowed_origins: Vec::new(),
                auth_token: "caller-chosen-token".to_string(),
            })
            .expect("Failed to set config");

        assert_eq!(server.get_config().auth_token, token);
    }

    #[test]
    fn test_set_config_publishes_origins_to_the_request_path() {
        let dir = TempDir::new().expect("Failed to create temp dir");
        let mut server = McpServer::new(dir.path().to_path_buf());
        server
            .set_config(McpConfig {
                enabled: false,
                port: 3001,
                allowed_origins: vec!["http://localhost:5173".to_string()],
                auth_token: String::new(),
            })
            .expect("Failed to set config");

        let settings = server.auth.read().expect("auth lock").clone();
        assert_eq!(settings.allowed_origins, vec!["http://localhost:5173"]);
        assert_eq!(settings.token, server.get_config().auth_token);
    }

    #[test]
    fn test_regenerate_auth_token_replaces_and_persists() {
        let dir = TempDir::new().expect("Failed to create temp dir");
        let mut server = McpServer::new(dir.path().to_path_buf());
        let original = server.get_config().auth_token.clone();

        let new_token = server
            .regenerate_auth_token()
            .expect("Failed to regenerate token");

        assert_ne!(new_token, original);
        assert_eq!(server.get_config().auth_token, new_token);
        assert_eq!(
            McpConfig::load(dir.path())
                .expect("Failed to load config")
                .auth_token,
            new_token
        );
        // The running request path sees the new token immediately
        assert_eq!(server.auth.read().expect("auth lock").token, new_token);
    }

    // =====================================================
    // Request authorization
    // =====================================================

    fn settings_with(token: &str, origins: &[&str]) -> AuthSettings {
        AuthSettings {
            token: token.to_string(),
            allowed_origins: origins.iter().map(|o| o.to_string()).collect(),
        }
    }

    fn request_with_headers(headers: &[&str]) -> String {
        let mut request = String::from("POST / HTTP/1.1\r\nHost: 127.0.0.1:3001\r\n");
        for header in headers {
            request.push_str(header);
            request.push_str("\r\n");
        }
        request.push_str("\r\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}");
        request
    }

    #[test]
    fn test_authorize_accepts_the_configured_token() {
        let settings = settings_with("s3cret-token", &[]);
        let request = request_with_headers(&["Authorization: Bearer s3cret-token"]);
        assert!(authorize_request(&request, &settings).is_ok());
    }

    #[test]
    fn test_authorize_accepts_a_lowercase_header_and_scheme() {
        let settings = settings_with("s3cret-token", &[]);
        let request = request_with_headers(&["authorization: bearer s3cret-token"]);
        assert!(authorize_request(&request, &settings).is_ok());
    }

    #[test]
    fn test_authorize_rejects_a_missing_header() {
        let settings = settings_with("s3cret-token", &[]);
        let request = request_with_headers(&[]);
        let rejection = authorize_request(&request, &settings).expect_err("must be rejected");
        assert_eq!(rejection.status, 401);
        assert_eq!(rejection.message, UNAUTHORIZED_MESSAGE);
    }

    #[test]
    fn test_authorize_rejects_a_wrong_scheme() {
        let settings = settings_with("s3cret-token", &[]);
        let request = request_with_headers(&["Authorization: Basic s3cret-token"]);
        let rejection = authorize_request(&request, &settings).expect_err("must be rejected");
        assert_eq!(rejection.status, 401);
    }

    #[test]
    fn test_authorize_rejects_a_bare_token_without_a_scheme() {
        let settings = settings_with("s3cret-token", &[]);
        let request = request_with_headers(&["Authorization: s3cret-token"]);
        assert_eq!(
            authorize_request(&request, &settings)
                .expect_err("must be rejected")
                .status,
            401
        );
    }

    #[test]
    fn test_authorize_rejects_a_wrong_token() {
        let settings = settings_with("s3cret-token", &[]);
        // Same length, differs in the last character
        let request = request_with_headers(&["Authorization: Bearer s3cret-tokeN"]);
        assert_eq!(
            authorize_request(&request, &settings)
                .expect_err("must be rejected")
                .status,
            401
        );
    }

    #[test]
    fn test_authorize_rejects_a_token_prefix() {
        let settings = settings_with("s3cret-token", &[]);
        let request = request_with_headers(&["Authorization: Bearer s3cret"]);
        assert!(authorize_request(&request, &settings).is_err());
    }

    #[test]
    fn test_authorize_rejects_everything_when_no_token_is_configured() {
        // An empty stored token must never read as "authentication is off"
        let settings = settings_with("", &[]);
        assert!(authorize_request(&request_with_headers(&[]), &settings).is_err());
        assert!(authorize_request(
            &request_with_headers(&["Authorization: Bearer "]),
            &settings
        )
        .is_err());
    }

    #[test]
    fn test_authorize_ignores_an_authorization_line_in_the_body() {
        let settings = settings_with("s3cret-token", &[]);
        let request = "POST / HTTP/1.1\r\nHost: x\r\n\r\nAuthorization: Bearer s3cret-token";
        assert!(authorize_request(request, &settings).is_err());
    }

    #[test]
    fn test_authorize_allows_a_listed_origin() {
        let settings = settings_with("s3cret-token", &["http://localhost:5173"]);
        let request = request_with_headers(&[
            "Origin: http://localhost:5173",
            "Authorization: Bearer s3cret-token",
        ]);
        assert!(authorize_request(&request, &settings).is_ok());
    }

    #[test]
    fn test_authorize_rejects_an_unlisted_origin() {
        let settings = settings_with("s3cret-token", &["http://localhost:5173"]);
        let request = request_with_headers(&[
            "Origin: https://not-allowed.example",
            "Authorization: Bearer s3cret-token",
        ]);
        let rejection = authorize_request(&request, &settings).expect_err("must be rejected");
        assert_eq!(rejection.status, 403);
        assert!(rejection.message.contains("allowed origins"));
    }

    #[test]
    fn test_authorize_rejects_an_absent_origin_when_a_list_is_configured() {
        let settings = settings_with("s3cret-token", &["http://localhost:5173"]);
        let request = request_with_headers(&["Authorization: Bearer s3cret-token"]);
        assert_eq!(
            authorize_request(&request, &settings)
                .expect_err("must be rejected")
                .status,
            403
        );
    }

    #[test]
    fn test_authorize_ignores_the_origin_when_the_list_is_empty() {
        // Empty list keeps today's posture: any local caller with the token
        let settings = settings_with("s3cret-token", &[]);
        let request = request_with_headers(&[
            "Origin: https://anything.example",
            "Authorization: Bearer s3cret-token",
        ]);
        assert!(authorize_request(&request, &settings).is_ok());
    }

    #[test]
    fn test_authorize_checks_the_origin_before_the_token() {
        // An unlisted origin never learns whether its token guess was right
        let settings = settings_with("s3cret-token", &["http://localhost:5173"]);
        let request = request_with_headers(&[
            "Origin: https://not-allowed.example",
            "Authorization: Bearer wrong",
        ]);
        assert_eq!(
            authorize_request(&request, &settings)
                .expect_err("must be rejected")
                .status,
            403
        );
    }

    #[test]
    fn test_unauthorized_message_tells_the_user_how_to_fix_it() {
        assert!(UNAUTHORIZED_MESSAGE.contains("Authorization: Bearer"));
        assert!(UNAUTHORIZED_MESSAGE.contains("Settings"));
    }

    // =====================================================
    // Constant-time comparison
    // =====================================================

    #[test]
    fn test_constant_time_eq_matches_only_the_exact_token() {
        assert!(constant_time_eq("token", "token"));
        assert!(!constant_time_eq("tokes", "token"));
        assert!(!constant_time_eq("Token", "token"));
        // Differences at the very first and very last byte are both caught,
        // which a comparison that stopped early could not guarantee
        assert!(!constant_time_eq("aoken", "token"));
        assert!(!constant_time_eq("tokem", "token"));
    }

    #[test]
    fn test_constant_time_eq_is_length_independent() {
        // Hashing both sides means the work is fixed at 32 bytes whatever the
        // inputs, so neither the length nor the first differing position leaks
        assert!(!constant_time_eq("", "token"));
        assert!(!constant_time_eq("token-with-a-much-longer-tail", "token"));
        assert!(!constant_time_eq("tok", "token"));
        assert!(constant_time_eq("", ""));
    }

    // =====================================================
    // CORS and logging
    // =====================================================

    #[test]
    fn test_cors_origin_defaults_to_localhost() {
        let settings = settings_with("t", &[]);
        assert_eq!(
            cors_allow_origin(&request_with_headers(&[]), &settings),
            "http://localhost"
        );
    }

    #[test]
    fn test_cors_origin_reflects_a_configured_origin() {
        let settings = settings_with("t", &["http://localhost:5173", "http://localhost:4200"]);
        assert_eq!(
            cors_allow_origin(
                &request_with_headers(&["Origin: http://localhost:4200"]),
                &settings
            ),
            "http://localhost:4200"
        );
    }

    #[test]
    fn test_cors_origin_never_echoes_an_unlisted_origin() {
        let settings = settings_with("t", &["http://localhost:5173"]);
        assert_eq!(
            cors_allow_origin(
                &request_with_headers(&["Origin: https://not-allowed.example"]),
                &settings
            ),
            "http://localhost:5173"
        );
    }

    #[test]
    fn test_redact_authorization_removes_the_token() {
        let head = "POST / HTTP/1.1\r\nHost: 127.0.0.1:3001\r\nAuthorization: Bearer s3cret-token\r\nContent-Type: application/json";
        let redacted = redact_authorization(head);
        assert!(
            !redacted.contains("s3cret-token"),
            "the token must never reach a log: {}",
            redacted
        );
        assert!(redacted.contains("Authorization: <redacted>"));
        // The rest of the head is untouched, so the log is still useful
        assert!(redacted.contains("Host: 127.0.0.1:3001"));
        assert!(redacted.contains("Content-Type: application/json"));
    }

    #[test]
    fn test_redact_authorization_is_case_insensitive() {
        let redacted = redact_authorization("POST / HTTP/1.1\nauthorization: bearer s3cret-token");
        assert!(!redacted.contains("s3cret-token"));
    }

    #[test]
    fn test_request_line_logged_on_rejection_carries_no_token() {
        // The rejection path logs only the redacted request line
        let request = request_with_headers(&["Authorization: Bearer s3cret-token"]);
        let logged = redact_authorization(request.lines().next().unwrap_or(""));
        assert!(!logged.contains("s3cret-token"));
        assert_eq!(logged, "POST / HTTP/1.1");
    }

    // =====================================================
    // End-to-end over a real socket
    // =====================================================

    /// Send a raw HTTP request to the running server and return the response
    async fn send_raw(port: u16, request: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("Failed to connect to the MCP server");
        stream
            .write_all(request.as_bytes())
            .await
            .expect("Failed to write request");
        stream.flush().await.expect("Failed to flush request");

        let mut response = Vec::new();
        stream
            .read_to_end(&mut response)
            .await
            .expect("Failed to read response");
        String::from_utf8_lossy(&response).to_string()
    }

    /// A `tools/list` request, optionally carrying headers
    fn tools_list_request(headers: &[String]) -> String {
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
        let mut request = format!(
            "POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        );
        for header in headers {
            request.push_str(header);
            request.push_str("\r\n");
        }
        request.push_str("\r\n");
        request.push_str(body);
        request
    }

    /// Start a server on a free port with the given allowed origins,
    /// returning the server, its port and its token
    async fn started_server(
        dir: &TempDir,
        allowed_origins: Vec<String>,
    ) -> (McpServer, u16, String) {
        let port = free_port().await;
        let mut server = McpServer::new(dir.path().to_path_buf());
        server
            .set_config(McpConfig {
                enabled: true,
                port,
                allowed_origins,
                auth_token: String::new(),
            })
            .expect("Failed to set config");
        let token = server.get_config().auth_token.clone();
        server.start().await.expect("Failed to start server");
        (server, port, token)
    }

    #[tokio::test]
    async fn test_running_server_rejects_requests_without_a_token() {
        let dir = TempDir::new().expect("Failed to create temp dir");
        let (mut server, port, token) = started_server(&dir, Vec::new()).await;

        let response = send_raw(port, &tools_list_request(&[])).await;
        assert!(response.starts_with("HTTP/1.1 401"), "got: {}", response);
        assert!(response.contains("Authorization: Bearer"));
        assert!(
            !response.contains("get_commit_history"),
            "an unauthenticated caller must not see the tool list"
        );

        let wrong = tools_list_request(&["Authorization: Bearer not-the-token".to_string()]);
        let response = send_raw(port, &wrong).await;
        assert!(response.starts_with("HTTP/1.1 401"), "got: {}", response);

        let right = tools_list_request(&[format!("Authorization: Bearer {}", token)]);
        let response = send_raw(port, &right).await;
        assert!(response.starts_with("HTTP/1.1 200"), "got: {}", response);
        assert!(response.contains("get_commit_history"));

        server.stop().await.expect("Failed to stop server");
    }

    #[tokio::test]
    async fn test_regenerating_the_token_invalidates_the_old_one_immediately() {
        let dir = TempDir::new().expect("Failed to create temp dir");
        let (mut server, port, old_token) = started_server(&dir, Vec::new()).await;

        let new_token = server
            .regenerate_auth_token()
            .expect("Failed to regenerate token");

        let old = tools_list_request(&[format!("Authorization: Bearer {}", old_token)]);
        assert!(
            send_raw(port, &old).await.starts_with("HTTP/1.1 401"),
            "the previous token must stop working without a restart"
        );

        let new = tools_list_request(&[format!("Authorization: Bearer {}", new_token)]);
        assert!(send_raw(port, &new).await.starts_with("HTTP/1.1 200"));

        server.stop().await.expect("Failed to stop server");
    }

    #[tokio::test]
    async fn test_running_server_enforces_allowed_origins() {
        let dir = TempDir::new().expect("Failed to create temp dir");
        let (mut server, port, token) =
            started_server(&dir, vec!["http://localhost:5173".to_string()]).await;

        // Right token, wrong origin
        let denied = tools_list_request(&[
            "Origin: https://not-allowed.example".to_string(),
            format!("Authorization: Bearer {}", token),
        ]);
        let response = send_raw(port, &denied).await;
        assert!(response.starts_with("HTTP/1.1 403"), "got: {}", response);
        assert!(!response.contains("Access-Control-Allow-Origin: https://not-allowed.example"));

        // Right token, listed origin
        let allowed = tools_list_request(&[
            "Origin: http://localhost:5173".to_string(),
            format!("Authorization: Bearer {}", token),
        ]);
        let response = send_raw(port, &allowed).await;
        assert!(response.starts_with("HTTP/1.1 200"), "got: {}", response);
        assert!(response.contains("Access-Control-Allow-Origin: http://localhost:5173"));

        server.stop().await.expect("Failed to stop server");
    }

    #[tokio::test]
    async fn test_preflight_is_answered_without_a_token() {
        let dir = TempDir::new().expect("Failed to create temp dir");
        let (mut server, port, _token) = started_server(&dir, Vec::new()).await;

        let response = send_raw(port, "OPTIONS / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await;
        assert!(response.starts_with("HTTP/1.1 204"), "got: {}", response);
        // Browser clients must be allowed to send the Authorization header
        assert!(response.contains("Access-Control-Allow-Headers: Content-Type, Authorization"));
        assert!(response.contains("Access-Control-Allow-Origin: http://localhost"));

        server.stop().await.expect("Failed to stop server");
    }

    #[tokio::test]
    async fn test_non_post_requests_still_require_a_token() {
        let dir = TempDir::new().expect("Failed to create temp dir");
        let (mut server, port, token) = started_server(&dir, Vec::new()).await;

        let response = send_raw(port, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await;
        assert!(response.starts_with("HTTP/1.1 401"), "got: {}", response);

        let authenticated = format!(
            "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\n\r\n",
            token
        );
        let response = send_raw(port, &authenticated).await;
        assert!(response.starts_with("HTTP/1.1 405"), "got: {}", response);

        server.stop().await.expect("Failed to stop server");
    }
}
