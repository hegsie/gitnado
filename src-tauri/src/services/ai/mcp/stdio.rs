//! stdio transport for MCP clients that cannot speak HTTP (roadmap 4.2, #612).
//!
//! `gitnado --mcp-stdio` reads newline-delimited JSON-RPC messages on stdin,
//! forwards each to the running Gitnado MCP server over HTTP, and writes the
//! responses to stdout, one per line. Notifications (answered with 202) produce
//! no output. The bridge only ever talks to a loopback address.
//!
//! Configuration comes from the environment so client config files can set it:
//! - `GITNADO_MCP_TOKEN` (required): a client token from Settings > MCP Server
//! - `GITNADO_MCP_URL` (optional): defaults to `http://127.0.0.1:3001/mcp`

use std::io::{BufRead, Write};

use serde_json::{json, Value};

pub const DEFAULT_URL: &str = "http://127.0.0.1:3001/mcp";

/// Accept only loopback HTTP URLs: the bridge must never send the token, or
/// repository contents, anywhere but this machine.
pub fn validate_local_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("Invalid GITNADO_MCP_URL: {e}"))?;
    if parsed.scheme() != "http" {
        return Err("GITNADO_MCP_URL must be an http:// loopback address".to_string());
    }
    match parsed.host() {
        Some(url::Host::Domain("localhost")) => Ok(()),
        Some(url::Host::Ipv4(ip)) if ip.is_loopback() => Ok(()),
        Some(url::Host::Ipv6(ip)) if ip.is_loopback() => Ok(()),
        _ => Err(
            "GITNADO_MCP_URL must point at this machine (127.0.0.1, ::1 or localhost)".to_string(),
        ),
    }
}

fn error_line(id: Value, code: i32, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

/// Forward every line of `input` to the server and write responses to `output`.
pub async fn bridge<R: BufRead, W: Write>(
    input: R,
    mut output: W,
    url: &str,
    token: &str,
) -> Result<(), String> {
    validate_local_url(url)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;
    for line in input.lines() {
        let line = line.map_err(|e| e.to_string())?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let id = serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|v| v.get("id").cloned())
            .unwrap_or(Value::Null);
        let reply = match client
            .post(url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .bearer_auth(token)
            .body(line.to_string())
            .send()
            .await
        {
            Ok(resp) if resp.status().as_u16() == 202 => None,
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                if body.trim().is_empty() {
                    Some(error_line(id, -32603, &format!("Gitnado answered HTTP {status} with no body")))
                } else {
                    // Error bodies are JSON-RPC errors already; make sure the
                    // client's id is carried so it can match the reply.
                    match serde_json::from_str::<Value>(&body) {
                        Ok(mut v) => {
                            if v.get("id").is_none_or(Value::is_null) && !id.is_null() {
                                v["id"] = id.clone();
                            }
                            Some(v.to_string())
                        }
                        Err(_) => Some(error_line(id, -32603, "Gitnado returned an invalid response")),
                    }
                }
            }
            Err(e) => Some(error_line(
                id,
                -32603,
                &format!("Cannot reach Gitnado's MCP server at {url}: is Gitnado running with the MCP server started? ({e})"),
            )),
        };
        if let Some(reply) = reply {
            writeln!(output, "{reply}").map_err(|e| e.to_string())?;
            output.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Entry point for `gitnado --mcp-stdio`. Returns the process exit code.
pub fn run_from_env() -> i32 {
    let token = match std::env::var("GITNADO_MCP_TOKEN") {
        Ok(t) if !t.trim().is_empty() => t,
        _ => {
            eprintln!("gitnado --mcp-stdio: set GITNADO_MCP_TOKEN to a client token from Gitnado (Settings > MCP Server)");
            return 2;
        }
    };
    let url = std::env::var("GITNADO_MCP_URL").unwrap_or_else(|_| DEFAULT_URL.to_string());
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("gitnado --mcp-stdio: {e}");
            return 1;
        }
    };
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    match runtime.block_on(bridge(stdin.lock(), stdout.lock(), &url, token.trim())) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("gitnado --mcp-stdio: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_urls_are_accepted() {
        assert!(validate_local_url("http://127.0.0.1:3001/mcp").is_ok());
        assert!(validate_local_url("http://localhost:4000").is_ok());
        assert!(validate_local_url("http://[::1]:3001/").is_ok());
        assert!(validate_local_url("https://127.0.0.1:3001").is_err());
        assert!(validate_local_url("http://example.com/mcp").is_err());
        assert!(validate_local_url("http://10.0.0.2:3001").is_err());
        assert!(validate_local_url("not a url").is_err());
    }

    #[tokio::test]
    async fn unreachable_server_yields_a_jsonrpc_error_per_request() {
        // Port 9 (discard) is essentially never listening on loopback.
        let input = b"{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/list\"}\n\n" as &[u8];
        let mut out = Vec::new();
        bridge(input, &mut out, "http://127.0.0.1:9/mcp", "t")
            .await
            .unwrap();
        let text = String::from_utf8(out).unwrap();
        let v: Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(v["id"], 7);
        assert!(v["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Cannot reach"));
    }

    #[tokio::test]
    async fn refuses_non_local_urls_before_sending_anything() {
        let mut out = Vec::new();
        let err = bridge(
            b"{}\n" as &[u8],
            &mut out,
            "http://example.com/mcp",
            "secret",
        )
        .await
        .unwrap_err();
        assert!(err.contains("this machine"));
        assert!(out.is_empty());
    }
}
