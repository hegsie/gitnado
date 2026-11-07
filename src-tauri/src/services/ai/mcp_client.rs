//! MCP client mode (roadmap 4.2, issue #613).
//!
//! Gitnado's own AI features can call MCP servers the user configures —
//! issue trackers, docs, internal tools — for extra context. Each server is
//! reached over Streamable HTTP or by launching a local stdio command.
//!
//! A server becomes a context source by naming one of its tools and an
//! argument template; placeholders are filled from the repository:
//! `{branch}`, `{issueKey}` (a Jira-style key in the branch name, e.g.
//! `PROJ-123`), `{issueNumber}` (the first number in the branch name) and
//! `{repo}` (the repository folder name). The tool's text result is added to
//! the commit-message and PR-description prompts.
//!
//! Privacy: nothing is sent unless the user added the server and chose a
//! context tool. HTTP servers go through the paranoid-mode URL guard; in
//! offline mode no external server is contacted at all (a stdio server could
//! reach the network on its own). Bearer tokens live in the system keyring,
//! never in the settings file.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock as StdRwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const SERVERS_FILE: &str = "mcp-external-servers.json";
const PROTOCOL_VERSION: &str = "2025-06-18";
const CALL_TIMEOUT: Duration = Duration::from_secs(20);
/// Most characters of context any one server may add to a prompt.
pub const MAX_CONTEXT_CHARS: usize = 4000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum McpTransport {
    Http {
        url: String,
    },
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMcpServer {
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Tool to call for AI context, if this server is a context source.
    #[serde(default)]
    pub context_tool: Option<String>,
    /// JSON arguments for the context tool, with `{placeholders}`.
    #[serde(default)]
    pub context_args: Option<String>,
    /// Whether a bearer token is stored in the keyring for this server.
    #[serde(default)]
    pub has_token: bool,
}

fn default_true() -> bool {
    true
}

/// A tool an external server offers.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalTool {
    pub name: String,
    pub description: String,
}

/// Context gathered from one server.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalContext {
    pub server: String,
    pub text: String,
}

/// The configured servers, persisted next to the other MCP settings.
#[derive(Default)]
pub struct ExternalServers {
    config_dir: Option<PathBuf>,
    servers: StdRwLock<Vec<ExternalMcpServer>>,
}

pub type SharedExternalServers = Arc<ExternalServers>;

pub fn keyring_key(id: &str) -> String {
    format!("mcp-server:{id}")
}

impl ExternalServers {
    pub fn load(config_dir: &Path) -> Self {
        let servers = std::fs::read_to_string(config_dir.join(SERVERS_FILE))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            config_dir: Some(config_dir.to_path_buf()),
            servers: StdRwLock::new(servers),
        }
    }

    pub fn list(&self) -> Vec<ExternalMcpServer> {
        self.servers
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn get(&self, id: &str) -> Option<ExternalMcpServer> {
        self.list().into_iter().find(|s| s.id == id)
    }

    fn persist(&self, servers: &[ExternalMcpServer]) -> Result<(), String> {
        let Some(dir) = &self.config_dir else {
            return Ok(());
        };
        std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create config dir: {e}"))?;
        let text = serde_json::to_string_pretty(servers).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(SERVERS_FILE), text)
            .map_err(|e| format!("Failed to save MCP servers: {e}"))
    }

    /// Add (empty id) or replace a server after validating it.
    pub fn upsert(&self, mut server: ExternalMcpServer) -> Result<ExternalMcpServer, String> {
        validate(&server)?;
        server.name = server.name.trim().to_string();
        if server.id.is_empty() {
            server.id = uuid::Uuid::new_v4().to_string();
        }
        let mut servers = self.servers.write().unwrap_or_else(|e| e.into_inner());
        let mut next = servers.clone();
        match next.iter_mut().find(|s| s.id == server.id) {
            Some(existing) => *existing = server.clone(),
            None => next.push(server.clone()),
        }
        self.persist(&next)?;
        *servers = next;
        Ok(server)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let mut servers = self.servers.write().unwrap_or_else(|e| e.into_inner());
        if !servers.iter().any(|s| s.id == id) {
            return Err("That server no longer exists".to_string());
        }
        let next: Vec<_> = servers.iter().filter(|s| s.id != id).cloned().collect();
        self.persist(&next)?;
        *servers = next;
        Ok(())
    }
}

pub fn validate(server: &ExternalMcpServer) -> Result<(), String> {
    if server.name.trim().is_empty() {
        return Err("Give the server a name".to_string());
    }
    match &server.transport {
        McpTransport::Http { url } => {
            let parsed = url::Url::parse(url).map_err(|e| format!("Invalid server URL: {e}"))?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err("Server URL must start with http:// or https://".to_string());
            }
        }
        McpTransport::Stdio { command, .. } => {
            if command.trim().is_empty() {
                return Err("Enter the command that starts the server".to_string());
            }
        }
    }
    if let Some(template) = &server.context_args {
        if !template.trim().is_empty() {
            let filled = fill_template(template, &ContextVars::default());
            serde_json::from_str::<Value>(&filled)
                .map_err(|e| format!("Context arguments must be JSON: {e}"))?;
        }
    }
    Ok(())
}

/// Values available to argument templates.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContextVars {
    pub branch: String,
    pub issue_key: String,
    pub issue_number: String,
    pub repo: String,
}

impl ContextVars {
    pub fn from_repo(repo_path: &str) -> Self {
        let branch = git2::Repository::open(repo_path)
            .ok()
            .and_then(|r| {
                r.head()
                    .ok()
                    .filter(|h| h.is_branch())
                    .and_then(|h| h.shorthand().ok().map(str::to_string))
            })
            .unwrap_or_default();
        let repo = Path::new(repo_path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        Self {
            issue_key: issue_key(&branch),
            issue_number: issue_number(&branch),
            branch,
            repo,
        }
    }
}

/// A Jira-style key (`PROJ-123`) in a branch name, upper-cased.
pub fn issue_key(branch: &str) -> String {
    let upper = branch.to_uppercase();
    let bytes: Vec<char> = upper.chars().collect();
    for start in 0..bytes.len() {
        if start > 0 && bytes[start - 1].is_ascii_alphanumeric() {
            continue;
        }
        let mut i = start;
        if i < bytes.len() && bytes[i].is_ascii_uppercase() {
            i += 1;
            while i < bytes.len() && (bytes[i].is_ascii_uppercase() || bytes[i].is_ascii_digit()) {
                i += 1;
            }
            if i < bytes.len() && bytes[i] == '-' {
                let digits_start = i + 1;
                let mut j = digits_start;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if j > digits_start {
                    return bytes[start..j].iter().collect();
                }
            }
        }
    }
    String::new()
}

/// The first run of digits in a branch name (`feature/42-login` → `42`).
pub fn issue_number(branch: &str) -> String {
    branch
        .split(|c: char| !c.is_ascii_digit())
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .to_string()
}

/// Fill `{placeholders}` with JSON-string-escaped values, so a branch name can
/// never break out of a string in the argument template.
pub fn fill_template(template: &str, vars: &ContextVars) -> String {
    let esc = |v: &str| {
        let quoted = serde_json::to_string(v).unwrap_or_default();
        quoted[1..quoted.len() - 1].to_string()
    };
    template
        .replace("{branch}", &esc(&vars.branch))
        .replace("{issueKey}", &esc(&vars.issue_key))
        .replace("{issueNumber}", &esc(&vars.issue_number))
        .replace("{repo}", &esc(&vars.repo))
}

/// Text content of a `tools/call` result.
fn result_text(result: &Value) -> String {
    let text: Vec<String> = result
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|c| c.get("text").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if text.is_empty() {
        result.to_string()
    } else {
        text.join("\n")
    }
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let mut t: String = text.chars().take(max).collect();
        t.push_str("\n[truncated]");
        t
    }
}

/// Parse a JSON-RPC response from either a JSON body or an SSE stream.
fn parse_response(body: &str, id: u64) -> Result<Value, String> {
    let candidates: Vec<&str> = if body.trim_start().starts_with('{') {
        vec![body]
    } else {
        body.lines()
            .filter_map(|l| l.strip_prefix("data:"))
            .map(str::trim)
            .collect()
    };
    for c in candidates {
        if let Ok(v) = serde_json::from_str::<Value>(c) {
            if v.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(err) = v.get("error") {
                    return Err(err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("The server returned an error")
                        .to_string());
                }
                return v
                    .get("result")
                    .cloned()
                    .ok_or_else(|| "Response had no result".to_string());
            }
        }
    }
    Err("The server's response could not be read".to_string())
}

fn request(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

fn initialize_params() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": "gitnado", "version": env!("CARGO_PKG_VERSION") }
    })
}

/// Run initialize → notifications/initialized → `method` against a server.
async fn session(
    server: &ExternalMcpServer,
    token: Option<&str>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    if crate::services::security::global().snapshot().offline_mode {
        return Err("Offline mode is on: external MCP servers are not contacted".to_string());
    }
    let run = async {
        match &server.transport {
            McpTransport::Http { url } => http_session(url, token, method, params).await,
            McpTransport::Stdio { command, args } => {
                stdio_session(command, args, method, params).await
            }
        }
    };
    tokio::time::timeout(CALL_TIMEOUT, run).await.map_err(|_| {
        format!(
            "{} did not answer within {}s",
            server.name,
            CALL_TIMEOUT.as_secs()
        )
    })?
}

fn http_post(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
    session_id: Option<&str>,
    body: Value,
) -> reqwest::RequestBuilder {
    let mut req = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", PROTOCOL_VERSION)
        .body(body.to_string());
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    if let Some(sid) = session_id {
        req = req.header("Mcp-Session-Id", sid);
    }
    req
}

async fn http_session(
    url: &str,
    token: Option<&str>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    crate::services::security::guard_url(url).map_err(|e| e.to_string())?;
    let client = reqwest::Client::new();
    let resp = http_post(
        &client,
        url,
        token,
        None,
        request(1, "initialize", initialize_params()),
    )
    .send()
    .await
    .map_err(|e| format!("Cannot reach the server: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "The server refused the connection (HTTP {})",
            resp.status()
        ));
    }
    let session_id = resp
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    parse_response(&resp.text().await.unwrap_or_default(), 1)?;
    let sid = session_id.as_deref();
    let _ = http_post(
        &client,
        url,
        token,
        sid,
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    )
    .send()
    .await;
    let resp = http_post(&client, url, token, sid, request(2, method, params))
        .send()
        .await
        .map_err(|e| format!("Cannot reach the server: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("The server returned HTTP {}", resp.status()));
    }
    parse_response(&resp.text().await.unwrap_or_default(), 2)
}

async fn stdio_session(
    command: &str,
    args: &[String],
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let mut child = tokio::process::Command::new(command)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Cannot start {command}: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("No stdin")?;
    let mut lines = BufReader::new(child.stdout.take().ok_or("No stdout")?).lines();

    async fn send(stdin: &mut tokio::process::ChildStdin, msg: Value) -> Result<(), String> {
        stdin
            .write_all(format!("{msg}\n").as_bytes())
            .await
            .map_err(|e| format!("The server closed its input: {e}"))
    }
    async fn read_reply(
        lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
        id: u64,
    ) -> Result<Value, String> {
        while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
            if let Ok(v) = parse_response(&line, id) {
                return Ok(v);
            }
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if v.get("id").and_then(Value::as_u64) == Some(id) {
                    return parse_response(&line, id);
                }
            }
        }
        Err("The server exited without answering".to_string())
    }

    send(&mut stdin, request(1, "initialize", initialize_params())).await?;
    read_reply(&mut lines, 1).await?;
    send(
        &mut stdin,
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    )
    .await?;
    send(&mut stdin, request(2, method, params)).await?;
    let result = read_reply(&mut lines, 2).await;
    drop(stdin);
    let _ = child.kill().await;
    result
}

pub async fn list_tools(
    server: &ExternalMcpServer,
    token: Option<&str>,
) -> Result<Vec<ExternalTool>, String> {
    let result = session(server, token, "tools/list", json!({})).await?;
    Ok(result
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|t| {
                    Some(ExternalTool {
                        name: t.get("name")?.as_str()?.to_string(),
                        description: t
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Call a server's context tool with its filled-in template.
pub async fn fetch_context(
    server: &ExternalMcpServer,
    token: Option<&str>,
    vars: &ContextVars,
) -> Result<Option<ExternalContext>, String> {
    let Some(tool) = server
        .context_tool
        .as_deref()
        .filter(|t| !t.trim().is_empty())
    else {
        return Ok(None);
    };
    let arguments: Value = match server
        .context_args
        .as_deref()
        .filter(|t| !t.trim().is_empty())
    {
        Some(template) => serde_json::from_str(&fill_template(template, vars))
            .map_err(|e| format!("Context arguments must be JSON: {e}"))?,
        None => json!({}),
    };
    let result = session(
        server,
        token,
        "tools/call",
        json!({ "name": tool, "arguments": arguments }),
    )
    .await?;
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        return Err(result_text(&result));
    }
    Ok(Some(ExternalContext {
        server: server.name.clone(),
        text: truncate(result_text(&result).trim(), MAX_CONTEXT_CHARS),
    }))
}

async fn token_for(server: &ExternalMcpServer) -> Option<String> {
    if !server.has_token {
        return None;
    }
    crate::commands::credentials::get_keyring_token(keyring_key(&server.id))
        .await
        .ok()
        .flatten()
}

/// Gather context from every enabled context source. Failures are logged and
/// skipped: an unreachable issue tracker must not block a commit message.
pub async fn gather_context(servers: &ExternalServers, repo_path: &str) -> Vec<ExternalContext> {
    let sources: Vec<_> = servers
        .list()
        .into_iter()
        .filter(|s| {
            s.enabled
                && s.context_tool
                    .as_deref()
                    .is_some_and(|t| !t.trim().is_empty())
        })
        .collect();
    if sources.is_empty() {
        return Vec::new();
    }
    let vars = ContextVars::from_repo(repo_path);
    let mut out = Vec::new();
    for server in sources {
        let token = token_for(&server).await;
        match fetch_context(&server, token.as_deref(), &vars).await {
            Ok(Some(ctx)) if !ctx.text.is_empty() => out.push(ctx),
            Ok(_) => {}
            Err(e) => tracing::warn!("MCP context from {} skipped: {}", server.name, e),
        }
    }
    out
}

/// Render gathered context for a prompt.
pub fn render_context(contexts: &[ExternalContext]) -> String {
    contexts
        .iter()
        .map(|c| format!("Context from {}:\n{}", c.server, c.text))
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub async fn token_for_server(server: &ExternalMcpServer) -> Option<String> {
    token_for(server).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn http(name: &str, url: &str) -> ExternalMcpServer {
        ExternalMcpServer {
            id: String::new(),
            name: name.into(),
            transport: McpTransport::Http { url: url.into() },
            enabled: true,
            context_tool: None,
            context_args: None,
            has_token: false,
        }
    }

    #[test]
    fn issue_keys_and_numbers_come_from_the_branch() {
        assert_eq!(issue_key("feature/PROJ-123-login"), "PROJ-123");
        assert_eq!(issue_key("proj-7_fix"), "PROJ-7");
        assert_eq!(issue_key("agent/fix-login"), "");
        assert_eq!(issue_key("X2-9"), "X2-9");
        assert_eq!(issue_number("feature/42-login"), "42");
        assert_eq!(issue_number("main"), "");
    }

    #[test]
    fn templates_escape_values_so_json_stays_valid() {
        let vars = ContextVars {
            branch: "evil\",\"x\":\"y".into(),
            issue_key: "PROJ-1".into(),
            issue_number: "1".into(),
            repo: "app".into(),
        };
        let filled = fill_template(r#"{"key":"{issueKey}","branch":"{branch}"}"#, &vars);
        let v: Value = serde_json::from_str(&filled).unwrap();
        assert_eq!(v["key"], "PROJ-1");
        assert_eq!(v["branch"], "evil\",\"x\":\"y");
        assert!(v.get("x").is_none(), "a branch name cannot inject keys");
    }

    #[test]
    fn validation() {
        assert!(validate(&http("Jira", "https://mcp.example.com/mcp")).is_ok());
        assert!(validate(&http(" ", "https://x")).is_err());
        assert!(validate(&http("x", "ftp://x")).is_err());
        assert!(validate(&http("x", "not a url")).is_err());
        let mut s = http("x", "https://x");
        s.context_args = Some("{not json".into());
        assert!(validate(&s).unwrap_err().contains("JSON"));
        s.context_args = Some(r#"{"q":"{branch}"}"#.into());
        assert!(validate(&s).is_ok());
        let stdio = ExternalMcpServer {
            transport: McpTransport::Stdio {
                command: " ".into(),
                args: vec![],
            },
            ..http("x", "https://x")
        };
        assert!(validate(&stdio).is_err());
    }

    #[test]
    fn servers_persist_and_are_replaced_by_id() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = ExternalServers::load(dir.path());
        let saved = store
            .upsert(http("Jira", "https://mcp.example.com"))
            .unwrap();
        assert!(!saved.id.is_empty());
        let renamed = store
            .upsert(ExternalMcpServer {
                name: "Jira Cloud".into(),
                ..saved.clone()
            })
            .unwrap();
        assert_eq!(renamed.id, saved.id);
        let reloaded = ExternalServers::load(dir.path());
        assert_eq!(reloaded.list().len(), 1);
        assert_eq!(reloaded.list()[0].name, "Jira Cloud");
        reloaded.remove(&saved.id).unwrap();
        assert!(ExternalServers::load(dir.path()).list().is_empty());
        assert!(reloaded.remove(&saved.id).is_err());
    }

    #[test]
    fn responses_parse_from_json_and_sse() {
        let json_body = r#"{"jsonrpc":"2.0","id":2,"result":{"ok":true}}"#;
        assert_eq!(parse_response(json_body, 2).unwrap()["ok"], true);
        let sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"n\":1}}\n\n";
        assert_eq!(parse_response(sse, 2).unwrap()["n"], 1);
        let err = r#"{"jsonrpc":"2.0","id":2,"error":{"code":-1,"message":"nope"}}"#;
        assert_eq!(parse_response(err, 2).unwrap_err(), "nope");
        assert!(parse_response("garbage", 2).is_err());
    }

    #[test]
    fn context_text_is_joined_truncated_and_rendered() {
        let result = json!({ "content": [{ "type": "text", "text": "a" }, { "type": "text", "text": "b" }] });
        assert_eq!(result_text(&result), "a\nb");
        let long = "x".repeat(MAX_CONTEXT_CHARS + 10);
        assert!(truncate(&long, MAX_CONTEXT_CHARS).ends_with("[truncated]"));
        let rendered = render_context(&[ExternalContext {
            server: "Jira".into(),
            text: "PROJ-1: Fix login".into(),
        }]);
        assert_eq!(rendered, "Context from Jira:\nPROJ-1: Fix login");
    }

    /// A stdio MCP server written in sh: answers initialize, tools/list and
    /// tools/call (echoing the `key` argument).
    #[cfg(unix)]
    fn fake_stdio_server(dir: &Path) -> ExternalMcpServer {
        let script = dir.join("fake-mcp.sh");
        std::fs::write(
            &script,
            r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"fake","version":"1"}}}\n' "$id" ;;
    *'"tools/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"get_issue","description":"Look up an issue"}]}}\n' "$id" ;;
    *'"tools/call"'*) key=$(printf '%s' "$line" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p'); printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"Issue %s: Fix the login redirect"}]}}\n' "$id" "$key" ;;
  esac
done
"#,
        )
        .unwrap();
        ExternalMcpServer {
            id: "s1".into(),
            name: "Fake tracker".into(),
            transport: McpTransport::Stdio {
                command: "sh".into(),
                args: vec![script.to_string_lossy().into_owned()],
            },
            enabled: true,
            context_tool: Some("get_issue".into()),
            context_args: Some(r#"{"key":"{issueKey}"}"#.into()),
            has_token: false,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stdio_server_lists_tools_and_provides_context() {
        let _policy = crate::services::security::test_support::no_policy();
        let dir = tempfile::TempDir::new().unwrap();
        let server = fake_stdio_server(dir.path());
        let tools = list_tools(&server, None).await.unwrap();
        assert_eq!(
            tools,
            vec![ExternalTool {
                name: "get_issue".into(),
                description: "Look up an issue".into()
            }]
        );

        let vars = ContextVars {
            issue_key: "PROJ-42".into(),
            ..Default::default()
        };
        let ctx = fetch_context(&server, None, &vars).await.unwrap().unwrap();
        assert_eq!(ctx.server, "Fake tracker");
        assert_eq!(ctx.text, "Issue PROJ-42: Fix the login redirect");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gather_context_uses_the_repo_branch_and_skips_failures() {
        let t = crate::test_utils::TestRepo::with_initial_commit();
        t.create_branch("PROJ-9-login");
        t.checkout_branch("PROJ-9-login");
        let dir = tempfile::TempDir::new().unwrap();
        let store = ExternalServers::load(dir.path());
        store.upsert(fake_stdio_server(dir.path())).unwrap();
        // A broken source must not block the others.
        let mut broken = fake_stdio_server(dir.path());
        broken.id = "s2".into();
        broken.name = "Broken".into();
        broken.transport = McpTransport::Stdio {
            command: "/no/such/server".into(),
            args: vec![],
        };
        store.upsert(broken).unwrap();
        // A server without a context tool is not called.
        let mut plain = fake_stdio_server(dir.path());
        plain.id = "s3".into();
        plain.context_tool = None;
        store.upsert(plain).unwrap();

        let ctx = gather_context(&store, &t.path_str()).await;
        assert_eq!(ctx.len(), 1, "{ctx:?}");
        assert_eq!(ctx[0].text, "Issue PROJ-9: Fix the login redirect");
    }

    #[tokio::test]
    async fn offline_mode_contacts_no_server() {
        let _guard = crate::services::security::test_support::offline();
        let err = list_tools(&http("x", "http://127.0.0.1:9/mcp"), None)
            .await
            .unwrap_err();
        assert!(err.contains("Offline mode"), "{err}");
    }

    #[tokio::test]
    async fn http_servers_list_tools_from_a_real_mcp_server() {
        let _policy = crate::services::security::test_support::no_policy();
        // Gitnado's own MCP server stands in for an external one.
        let dir = tempfile::TempDir::new().unwrap();
        let mut server = crate::services::ai::mcp::McpServer::new(dir.path().to_path_buf());
        let port = crate::test_utils::reserve_test_port();
        server
            .set_config(crate::services::ai::mcp::McpConfig {
                enabled: true,
                port,
                allowed_origins: vec![],
                auth_token: String::new(),
            })
            .unwrap();
        let token = server.get_config().auth_token.clone();
        server.start().await.unwrap();

        let external = http("Self", &format!("http://127.0.0.1:{port}/mcp"));
        let tools = list_tools(&external, Some(&token)).await.unwrap();
        assert!(
            tools.iter().any(|t| t.name == "get_commit_history"),
            "{tools:?}"
        );
        let err = list_tools(&external, Some("wrong")).await.unwrap_err();
        assert!(err.contains("refused"), "{err}");
        server.stop().await.unwrap();
    }
}
