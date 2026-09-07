//! OAuth command handlers
//!
//! Provides Tauri commands for OAuth authentication flow.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use crate::error::{GitnadoError, Result};
use crate::services::loopback_server::{CancelHandle, LoopbackServer};
use crate::services::oauth::{
    generate_state, OAuthConfig, OAuthProvider, OAuthTokenResponse, PKCEChallenge,
};
use once_cell::sync::Lazy;

/// Time-to-live for pending loopback servers (5 minutes).
/// Servers older than this are cleaned up to prevent unbounded growth
/// when OAuth callbacks never fire.
const PENDING_SERVER_TTL: Duration = Duration::from_secs(5 * 60);

/// A pending loopback server paired with its creation timestamp for TTL enforcement.
struct PendingServer {
    server: LoopbackServer,
    created_at: std::time::Instant,
}

/// Global storage for pending loopback servers (GitHub OAuth)
static PENDING_SERVERS: Lazy<Mutex<HashMap<u16, PendingServer>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// A loopback wait already in flight, with the handle that can abort it.
///
/// `oauth_wait_for_callback` REMOVES the server from `PENDING_SERVERS` and moves
/// it into a blocking wait, so that map can no longer release the port. This
/// registry keeps the detached cancel handle so an abandoned sign-in can free
/// its socket instead of holding it until the callback timeout.
struct ActiveWait {
    /// Identifies this specific wait, so a finishing wait cannot deregister the
    /// handle belonging to a newer wait that reused the same port.
    id: u64,
    cancel: CancelHandle,
}

/// In-flight loopback waits, keyed by port.
static ACTIVE_WAITS: Lazy<Mutex<HashMap<u16, ActiveWait>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Monotonic id source for `ActiveWait`.
static NEXT_WAIT_ID: AtomicU64 = AtomicU64::new(1);

/// Deregister a finished wait, but ONLY if the registered entry is still the
/// same wait. A cancelled wait can return AFTER the user's retry registered a
/// new wait on the same port; removing blindly would strip the new flow's
/// ability to cancel.
fn unregister_wait(port: u16, id: u64) {
    if let Ok(mut waits) = ACTIVE_WAITS.lock() {
        if waits.get(&port).is_some_and(|w| w.id == id) {
            waits.remove(&port);
        }
    }
}

/// Release the loopback server bound to `port`, whether it is still parked in
/// `PENDING_SERVERS` or already moved into a blocking wait. Returns `true` if
/// something of ours was released, `false` if we hold nothing on that port.
///
/// The teardown blocks until the accept loop confirms its listeners are closed
/// (~100 ms worst case), so it runs on a blocking task and the port is
/// re-bindable as soon as this returns.
async fn release_loopback_port(port: u16) -> Result<bool> {
    let parked = PENDING_SERVERS
        .lock()
        .map_err(|e| GitnadoError::OAuth(format!("Failed to access server storage: {}", e)))?
        .remove(&port);
    let in_flight = ACTIVE_WAITS
        .lock()
        .map_err(|e| GitnadoError::OAuth(format!("Failed to access OAuth waits: {}", e)))?
        .remove(&port);

    if parked.is_none() && in_flight.is_none() {
        return Ok(false);
    }

    tokio::task::spawn_blocking(move || {
        if let Some(pending) = parked {
            pending.server.shutdown();
        }
        if let Some(wait) = in_flight {
            wait.cancel.cancel();
        }
    })
    .await
    .map_err(|e| GitnadoError::OAuth(format!("Task join error: {}", e)))?;

    tracing::debug!("Released OAuth loopback server on port {}", port);
    Ok(true)
}

/// Remove expired entries from the pending servers map.
fn cleanup_expired_pending_servers(map: &mut HashMap<u16, PendingServer>) {
    let now = std::time::Instant::now();
    map.retain(|port, entry| {
        let alive = now.duration_since(entry.created_at) < PENDING_SERVER_TTL;
        if !alive {
            tracing::debug!("Cleaned up expired pending OAuth server on port {}", port);
        }
        alive
    });
}

/// Server-side data for an in-flight OAuth flow.
///
/// The PKCE `verifier` is kept SERVER-SIDE (never returned to the frontend) and
/// is looked up by the `state` parameter once the provider redirects back. The
/// `redirect_uri` is stored so the token exchange can reproduce the exact value
/// sent in the authorize request.
#[derive(Debug, Clone)]
pub struct PendingOAuthFlow {
    /// The OAuth provider for this flow.
    pub provider: OAuthProvider,
    /// PKCE code verifier (secret — never sent to the frontend).
    pub verifier: String,
    /// Instance / issuer URL (GitLab self-hosted, Azure tenant, OIDC issuer).
    pub instance_url: Option<String>,
    /// The client ID used to build the authorize URL. Stored so the token
    /// exchange can reuse it for providers (e.g. OIDC) whose client ID is
    /// per-account and therefore not available from the embedded client-ID map
    /// the frontend uses for the built-in providers.
    pub client_id: String,
    /// The redirect URI used when building the authorize URL.
    pub redirect_uri: String,
    /// Creation timestamp for TTL enforcement.
    pub created_at: std::time::Instant,
}

/// State for pending OAuth flows, keyed by the issued `state` parameter.
///
/// This stores the PKCE verifier and per-flow metadata server-side so the
/// verifier never has to round-trip through the frontend, and so the `state`
/// echoed back on the callback can be validated (CSRF / flow-binding).
pub struct OAuthState {
    /// Map of `state` -> pending flow data.
    pending: Mutex<HashMap<String, PendingOAuthFlow>>,
}

impl Default for OAuthState {
    fn default() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }
}

impl OAuthState {
    /// Insert a pending flow keyed by its `state`, evicting any expired flows.
    pub fn insert_pending(&self, state: String, flow: PendingOAuthFlow) -> Result<()> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|e| GitnadoError::OAuth(format!("Failed to store OAuth flow: {}", e)))?;
        cleanup_expired_flows(&mut pending);
        pending.insert(state, flow);
        Ok(())
    }

    /// Look up and REMOVE the pending flow for a given `state`.
    ///
    /// Returns `None` if no matching flow exists (state mismatch / expired /
    /// already consumed) — callers MUST treat that as a rejected callback.
    pub fn take_pending(&self, state: &str) -> Result<Option<PendingOAuthFlow>> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|e| GitnadoError::OAuth(format!("Failed to access OAuth flow: {}", e)))?;
        cleanup_expired_flows(&mut pending);
        Ok(pending.remove(state))
    }
}

/// Remove expired pending OAuth flows (same TTL as pending loopback servers).
fn cleanup_expired_flows(map: &mut HashMap<String, PendingOAuthFlow>) {
    let now = std::time::Instant::now();
    map.retain(|_, flow| now.duration_since(flow.created_at) < PENDING_SERVER_TTL);
}

/// Global storage for in-flight OAuth flows (keyed by `state`).
///
/// Used because the OAuth Tauri commands are free functions and `OAuthState`
/// is not registered as Tauri-managed state.
static OAUTH_FLOWS: Lazy<OAuthState> = Lazy::new(OAuthState::default);

/// Response from starting an OAuth flow
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOAuthResponse {
    /// The URL to open in the browser
    pub authorize_url: String,
    /// State for CSRF protection.
    ///
    /// The PKCE verifier is intentionally NOT returned: it is stored
    /// server-side keyed by this `state` and looked up during token exchange.
    pub state: String,
    /// Port if using loopback server (for GitHub)
    pub loopback_port: Option<u16>,
}

/// Request to exchange authorization code for tokens
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeCodeRequest {
    pub provider: String,
    pub code: String,
    pub verifier: String,
    pub instance_url: Option<String>,
    pub redirect_uri: String,
}

/// Get the authorize URL for OAuth flow
///
/// For GitHub, this also starts a loopback server to receive the callback.
/// For other providers, returns a deep link redirect URI.
#[tauri::command]
pub async fn oauth_get_authorize_url(
    provider: String,
    instance_url: Option<String>,
    client_id: String,
) -> Result<StartOAuthResponse> {
    let provider_enum: OAuthProvider = provider
        .parse()
        .map_err(|e: String| GitnadoError::OAuth(e))?;

    // Generate PKCE challenge
    let pkce = PKCEChallenge::new();
    let state = generate_state();

    // Build config based on provider
    let (config, loopback_port) = match provider_enum {
        OAuthProvider::GitHub => {
            // GitHub requires loopback server
            let server = LoopbackServer::new()?;
            let port = server.port();
            let config = OAuthConfig::github(&client_id, port);

            // Cleanup expired servers, then store for later retrieval
            let mut servers = PENDING_SERVERS
                .lock()
                .map_err(|e| GitnadoError::OAuth(format!("Failed to store server: {}", e)))?;
            cleanup_expired_pending_servers(&mut servers);
            servers.insert(
                port,
                PendingServer {
                    server,
                    created_at: std::time::Instant::now(),
                },
            );

            (config, Some(port))
        }
        OAuthProvider::GitLab => {
            // GitLab uses loopback server (like GitHub)
            let server = LoopbackServer::new()?;
            let port = server.port();
            let config = OAuthConfig::gitlab(&client_id, instance_url.as_deref(), port);

            // Cleanup expired servers, then store for later retrieval
            let mut servers = PENDING_SERVERS
                .lock()
                .map_err(|e| GitnadoError::OAuth(format!("Failed to store server: {}", e)))?;
            cleanup_expired_pending_servers(&mut servers);
            servers.insert(
                port,
                PendingServer {
                    server,
                    created_at: std::time::Instant::now(),
                },
            );

            (config, Some(port))
        }
        OAuthProvider::Azure => {
            // Azure DevOps (Entra ID): interactive auth-code + loopback (like GitHub/GitLab),
            // using Microsoft's Visual Studio first-party public client (no admin consent /
            // app registration). instance_url carries the optional tenant.
            let server = LoopbackServer::new()?;
            let port = server.port();
            let config = OAuthConfig::azure(&client_id, instance_url.as_deref(), port);

            let mut servers = PENDING_SERVERS
                .lock()
                .map_err(|e| GitnadoError::OAuth(format!("Failed to store server: {}", e)))?;
            cleanup_expired_pending_servers(&mut servers);
            servers.insert(
                port,
                PendingServer {
                    server,
                    created_at: std::time::Instant::now(),
                },
            );

            (config, Some(port))
        }
        OAuthProvider::Bitbucket => {
            // Bitbucket requires http/https redirect URIs and only allows ONE callback URL
            // We use a dedicated port (8085) to avoid conflicts with GitHub/GitLab
            const BITBUCKET_PORT: u16 = 8085;
            // The port is pinned by Bitbucket's registered redirect, so a flow
            // abandoned without a cancel (or a retry that races one) would leave
            // OUR OWN listener holding 8085 and the user would be told to close
            // whatever application is using the port. A new sign-in supersedes
            // the old one — the frontend already drops a superseded flow's late
            // callback silently — so release ours and re-bind. A genuine
            // third-party occupant still yields the original error.
            let server = match LoopbackServer::new_with_port(BITBUCKET_PORT) {
                Ok(server) => server,
                Err(bind_error) => {
                    if release_loopback_port(BITBUCKET_PORT).await? {
                        LoopbackServer::new_with_port(BITBUCKET_PORT)?
                    } else {
                        return Err(bind_error);
                    }
                }
            };
            let port = server.port();
            let config = OAuthConfig::bitbucket(&client_id, port);

            // Cleanup expired servers, then store for later retrieval
            let mut servers = PENDING_SERVERS
                .lock()
                .map_err(|e| GitnadoError::OAuth(format!("Failed to store server: {}", e)))?;
            cleanup_expired_pending_servers(&mut servers);
            servers.insert(
                port,
                PendingServer {
                    server,
                    created_at: std::time::Instant::now(),
                },
            );

            (config, Some(port))
        }
        OAuthProvider::Oidc => {
            // OIDC: instance_url is the issuer URL — discover endpoints
            let issuer_url = instance_url.as_deref().ok_or_else(|| {
                GitnadoError::OAuth("OIDC requires an issuer URL (pass as instanceUrl)".to_string())
            })?;

            let discovery = crate::services::oauth::discover_oidc_config(issuer_url)
                .await
                .map_err(GitnadoError::OAuth)?;

            let server = LoopbackServer::new()?;
            let port = server.port();
            let scopes = vec![
                "openid".to_string(),
                "profile".to_string(),
                "email".to_string(),
            ];
            let config = OAuthConfig::oidc(
                &client_id,
                &discovery.authorization_endpoint,
                &discovery.token_endpoint,
                scopes,
                port,
            );

            // Cleanup expired servers, then store for later retrieval
            let mut servers = PENDING_SERVERS
                .lock()
                .map_err(|e| GitnadoError::OAuth(format!("Failed to store server: {}", e)))?;
            cleanup_expired_pending_servers(&mut servers);
            servers.insert(
                port,
                PendingServer {
                    server,
                    created_at: std::time::Instant::now(),
                },
            );

            (config, Some(port))
        }
    };

    let authorize_url = config.build_authorize_url(&pkce, &state);

    // Store the PKCE verifier and per-flow data SERVER-SIDE, keyed by `state`.
    // The verifier is never returned to the frontend; the loopback callback and
    // token exchange look it up by the `state` value the provider echoes back.
    OAUTH_FLOWS.insert_pending(
        state.clone(),
        PendingOAuthFlow {
            provider: provider_enum,
            verifier: pkce.verifier,
            instance_url,
            client_id: config.client_id.clone(),
            redirect_uri: config.redirect_uri.clone(),
            created_at: std::time::Instant::now(),
        },
    )?;

    Ok(StartOAuthResponse {
        authorize_url,
        state,
        loopback_port,
    })
}

/// Start GitHub OAuth flow with loopback server
///
/// This starts a loopback server and returns immediately.
/// The server will wait for the callback and the frontend should poll
/// using `oauth_poll_github_callback`.
#[tauri::command]
pub async fn oauth_start_github_flow(client_id: String) -> Result<StartOAuthResponse> {
    oauth_get_authorize_url("github".to_string(), None, client_id).await
}

/// Exchange authorization code for tokens.
///
/// The PKCE `verifier`, provider, redirect URI, and instance/issuer URL are
/// looked up SERVER-SIDE from the pending-flow map keyed by `state` — they are
/// NOT accepted from the frontend. This both validates the `state` (it must
/// match an in-flight flow this process issued) and prevents the PKCE secret
/// from round-tripping through the client.
/// Build the Azure (Entra ID) token endpoint for a given tenant. Defaults to
/// `organizations` so the code is redeemed at the SAME authority segment the
/// authorize URL was built with (see `OAuthConfig::azure`) — redeeming under a
/// different segment (e.g. `common`) can be rejected by Entra.
fn azure_token_url(instance_url: Option<&str>) -> String {
    let tenant = instance_url.unwrap_or("organizations");
    format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
        tenant
    )
}

#[tauri::command]
pub async fn oauth_exchange_code(
    state: String,
    code: String,
    client_id: String,
    client_secret: Option<String>,
) -> Result<OAuthTokenResponse> {
    // Look up (and consume) the pending flow for this state. A missing entry
    // means the state is unknown/expired/replayed — reject the exchange.
    let flow = OAUTH_FLOWS.take_pending(&state)?.ok_or_else(|| {
        GitnadoError::OAuth("OAuth state did not match any pending flow".to_string())
    })?;

    let provider_enum = flow.provider.clone();
    let verifier = flow.verifier.clone();
    let redirect_uri = flow.redirect_uri.clone();
    let instance_url = flow.instance_url.clone();

    // Prefer the frontend-supplied client ID (built-in providers source it from
    // the embedded client-ID map), but fall back to the one captured when the
    // authorize URL was built. OIDC client IDs are per-account, so the frontend
    // passes an empty string for them and we must use the stored value.
    let client_id = if client_id.trim().is_empty() {
        flow.client_id.clone()
    } else {
        client_id
    };

    // Build token URL based on provider
    let token_url = match provider_enum {
        OAuthProvider::GitHub => "https://github.com/login/oauth/access_token".to_string(),
        OAuthProvider::GitLab => {
            let base = instance_url.as_deref().unwrap_or("https://gitlab.com");
            format!("{}/oauth/token", base)
        }
        OAuthProvider::Azure => azure_token_url(instance_url.as_deref()),
        OAuthProvider::Bitbucket => "https://bitbucket.org/site/oauth2/access_token".to_string(),
        OAuthProvider::Oidc => {
            // For OIDC, discover the token endpoint from the issuer URL
            let issuer = instance_url
                .as_deref()
                .ok_or_else(|| GitnadoError::OAuth("OIDC requires issuer URL".to_string()))?;
            let discovery = crate::services::oauth::discover_oidc_config(issuer)
                .await
                .map_err(GitnadoError::OAuth)?;
            discovery.token_endpoint
        }
    };

    // Build request body
    let mut params = vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", code.clone()),
        ("redirect_uri", redirect_uri.clone()),
        ("client_id", client_id.clone()),
        ("code_verifier", verifier.clone()),
    ];

    // Add client_secret if provided (required for GitHub OAuth Apps)
    if let Some(ref secret) = client_secret {
        params.push(("client_secret", secret.clone()));
    }

    // Make token request
    let client = reqwest::Client::new();
    let response = client
        .post(&token_url)
        .header("Accept", "application/json")
        .form(&params)
        .send()
        .await
        .map_err(|e| GitnadoError::OAuth(format!("Token request failed: {}", e)))?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        // Some IdPs echo the submitted `code` / `code_verifier` (PKCE secret)
        // back in 4xx response bodies. Discard the body before surfacing the
        // error so it doesn't reach toasts or logs.
        tracing::debug!(
            "OAuth exchange failed with status {} ({} body bytes discarded)",
            status,
            text.len()
        );
        return Err(GitnadoError::OAuth(format!(
            "Token request failed with status {}",
            status
        )));
    }

    // Check if the response contains an error (GitHub returns 200 with error in body)
    if let Ok(error_response) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(error) = error_response.get("error").and_then(|e| e.as_str()) {
            let description = error_response
                .get("error_description")
                .and_then(|d| d.as_str())
                .unwrap_or("Unknown error");
            return Err(GitnadoError::OAuth(format!("{}: {}", error, description)));
        }
    }

    // Try to parse as token response. Do NOT log the raw response — it contains
    // access_token / refresh_token / id_token in plaintext.
    tracing::debug!("Token exchange response received ({} bytes)", text.len());
    let tokens: OAuthTokenResponse = serde_json::from_str(&text)
        .map_err(|e| GitnadoError::OAuth(format!("Failed to parse token response: {}", e)))?;

    tracing::info!(
        "Parsed token - has access_token: {}",
        !tokens.access_token.is_empty()
    );
    Ok(tokens)
}

/// Build the form body for a `refresh_token` grant. Bitbucket (and GitHub)
/// authenticate the refresh with the client secret, exactly as they do the code
/// exchange; public PKCE clients (GitLab, Entra) send only the client id.
fn refresh_token_params<'a>(
    refresh_token: &'a str,
    client_id: &'a str,
    client_secret: Option<&'a str>,
) -> Vec<(&'static str, &'a str)> {
    let mut params = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
    ];
    if let Some(secret) = client_secret {
        params.push(("client_secret", secret));
    }
    params
}

/// Refresh an OAuth token
#[tauri::command]
pub async fn oauth_refresh_token(
    provider: String,
    refresh_token: String,
    client_id: String,
    client_secret: Option<String>,
    instance_url: Option<String>,
) -> Result<OAuthTokenResponse> {
    let provider_enum: OAuthProvider = provider
        .parse()
        .map_err(|e: String| GitnadoError::OAuth(e))?;

    // Build token URL based on provider
    let token_url = match provider_enum {
        OAuthProvider::GitHub => "https://github.com/login/oauth/access_token".to_string(),
        OAuthProvider::GitLab => {
            let base = instance_url.as_deref().unwrap_or("https://gitlab.com");
            format!("{}/oauth/token", base)
        }
        OAuthProvider::Azure => azure_token_url(instance_url.as_deref()),
        OAuthProvider::Bitbucket => "https://bitbucket.org/site/oauth2/access_token".to_string(),
        OAuthProvider::Oidc => {
            let issuer = instance_url
                .as_deref()
                .ok_or_else(|| GitnadoError::OAuth("OIDC requires issuer URL".to_string()))?;
            let discovery = crate::services::oauth::discover_oidc_config(issuer)
                .await
                .map_err(GitnadoError::OAuth)?;
            discovery.token_endpoint
        }
    };

    // Build request body
    let params = refresh_token_params(&refresh_token, &client_id, client_secret.as_deref());

    // Make token request
    let client = reqwest::Client::new();
    let response = client
        .post(&token_url)
        .header("Accept", "application/json")
        .form(&params)
        .send()
        .await
        .map_err(|e| GitnadoError::OAuth(format!("Refresh request failed: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        // Some IdPs echo the submitted refresh_token back inside 4xx error
        // bodies. Discard the body so it doesn't propagate to user-visible
        // error toasts or logs.
        let body_len = response.text().await.unwrap_or_default().len();
        tracing::debug!(
            "OAuth refresh failed with status {} ({} body bytes discarded)",
            status,
            body_len
        );
        return Err(GitnadoError::OAuth(format!(
            "Refresh request failed with status {}",
            status
        )));
    }

    let tokens: OAuthTokenResponse = response
        .json()
        .await
        .map_err(|e| GitnadoError::OAuth(format!("Failed to parse token response: {}", e)))?;

    Ok(tokens)
}

/// Result of a validated loopback OAuth callback returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallbackResponse {
    /// Authorization code to pass to `oauth_exchange_code`.
    pub code: String,
    /// The validated `state` (matches an in-flight flow); pass this back to
    /// `oauth_exchange_code` so the server can look up the PKCE verifier.
    pub state: String,
}

/// Wait for loopback callback (works for GitHub, GitLab, and any provider using loopback)
///
/// This should be called after opening the authorize URL. It waits for the
/// callback on the loopback server, VALIDATES the `state` parameter echoed back
/// by the provider against the set of in-flight flows this process issued, and
/// returns the authorization code together with the validated state. A callback
/// whose `state` does not match a pending flow is rejected (CSRF protection).
#[tauri::command]
pub async fn oauth_wait_for_callback(port: u16) -> Result<CallbackResponse> {
    // Retrieve the stored server for this port
    let mut pending = PENDING_SERVERS
        .lock()
        .map_err(|e| GitnadoError::OAuth(format!("Failed to access server storage: {}", e)))?
        .remove(&port)
        .ok_or_else(|| GitnadoError::OAuth(format!("No server found for port {}", port)))?;

    // Detach a cancel handle BEFORE the server is consumed by the wait, and
    // register it so `oauth_cancel_flow` can free the port if the user abandons
    // the sign-in instead of waiting out the timeout.
    let wait_id = NEXT_WAIT_ID.fetch_add(1, Ordering::Relaxed);
    if let Some(cancel) = pending.server.take_cancel_handle() {
        ACTIVE_WAITS
            .lock()
            .map_err(|e| GitnadoError::OAuth(format!("Failed to access OAuth waits: {}", e)))?
            .insert(
                port,
                ActiveWait {
                    id: wait_id,
                    cancel,
                },
            );
    }

    // Use the server's wait_for_callback method
    // This runs in a blocking thread to avoid blocking the async runtime
    let timeout = Duration::from_secs(300); // 5 minutes

    let joined =
        tokio::task::spawn_blocking(move || pending.server.wait_for_callback(timeout)).await;

    // Deregister before propagating, so an errored/cancelled/aborted wait still
    // clears its registry entry.
    unregister_wait(port, wait_id);

    let callback = joined.map_err(|e| GitnadoError::OAuth(format!("Task join error: {}", e)))??;

    // Validate the returned `state` against an in-flight flow. We only PEEK here
    // (the flow is consumed later by `oauth_exchange_code`), so confirm a match
    // without removing the entry.
    validate_callback_state(&callback.state)?;

    Ok(CallbackResponse {
        code: callback.code,
        state: callback.state,
    })
}

/// Confirm that the given `state` matches an in-flight OAuth flow without
/// consuming it. Returns an error if no matching flow exists.
fn validate_callback_state(state: &str) -> Result<()> {
    let mut pending = OAUTH_FLOWS
        .pending
        .lock()
        .map_err(|e| GitnadoError::OAuth(format!("Failed to access OAuth flow: {}", e)))?;
    // Evict expired flows first so this peek stays consistent with the later
    // consume in `oauth_exchange_code` (which also cleans up). Otherwise an
    // expired state could validate here only to fail at exchange time.
    cleanup_expired_flows(&mut pending);
    if pending.contains_key(state) {
        Ok(())
    } else {
        Err(GitnadoError::OAuth(
            "OAuth callback state did not match any pending flow".to_string(),
        ))
    }
}

/// Alias for backward compatibility
#[tauri::command]
pub async fn oauth_wait_for_github_callback(port: u16) -> Result<CallbackResponse> {
    oauth_wait_for_callback(port).await
}

/// Cancel an in-flight OAuth flow and release its loopback server.
///
/// `oauth_wait_for_callback` consumes the pending server, so without this the
/// listener stays bound until the 5-minute callback timeout. That blocks a
/// retry for providers pinned to a fixed port (Bitbucket's registered redirect
/// is `127.0.0.1:8085`) with a "port is not available" error that points the
/// user at the wrong application. Cancelling a port with nothing in flight is a
/// no-op, so cancelling twice — or after the flow already completed — is safe.
#[tauri::command]
pub async fn oauth_cancel_flow(port: u16) -> Result<()> {
    release_loopback_port(port).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ==========================================================================
    // refresh_token_params Tests
    // ==========================================================================

    #[test]
    fn test_refresh_token_params_includes_client_secret() {
        let params = refresh_token_params("r1", "cid", Some("sek"));
        assert!(params.contains(&("grant_type", "refresh_token")));
        assert!(params.contains(&("refresh_token", "r1")));
        assert!(params.contains(&("client_id", "cid")));
        // Bitbucket rejects a refresh grant without the client secret.
        assert!(params.contains(&("client_secret", "sek")));
    }

    #[test]
    fn test_refresh_token_params_omits_client_secret_when_none() {
        let params = refresh_token_params("r1", "cid", None);
        assert_eq!(params.len(), 3);
        assert!(!params.iter().any(|(k, _)| *k == "client_secret"));
    }

    // ==========================================================================
    // StartOAuthResponse Tests
    // ==========================================================================

    #[test]
    fn test_start_oauth_response_serialization() {
        let response = StartOAuthResponse {
            authorize_url: "https://example.com/oauth".to_string(),
            state: "test-state".to_string(),
            loopback_port: Some(8080),
        };

        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("authorizeUrl"));
        assert!(json.contains("state"));
        assert!(json.contains("loopbackPort"));
        // SECURITY: the PKCE verifier must NOT be serialized to the frontend.
        assert!(!json.contains("verifier"));
    }

    #[test]
    fn test_start_oauth_response_without_loopback_port() {
        let response = StartOAuthResponse {
            authorize_url: "https://example.com/oauth".to_string(),
            state: "test-state".to_string(),
            loopback_port: None,
        };

        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("loopbackPort"));
        assert!(json.contains("null"));
    }

    #[test]
    fn test_start_oauth_response_deserialization() {
        let json = r#"{
            "authorizeUrl": "https://example.com/oauth",
            "state": "test-state",
            "loopbackPort": 8080
        }"#;

        let response: StartOAuthResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.authorize_url, "https://example.com/oauth");
        assert_eq!(response.state, "test-state");
        assert_eq!(response.loopback_port, Some(8080));
    }

    // ==========================================================================
    // ExchangeCodeRequest Tests
    // ==========================================================================

    #[test]
    fn test_exchange_code_request_serialization() {
        let request = ExchangeCodeRequest {
            provider: "github".to_string(),
            code: "auth-code".to_string(),
            verifier: "test-verifier".to_string(),
            instance_url: None,
            redirect_uri: "http://127.0.0.1:8080/callback".to_string(),
        };

        let json = serde_json::to_string(&request).unwrap();
        assert!(json.contains("provider"));
        assert!(json.contains("code"));
        assert!(json.contains("verifier"));
        assert!(json.contains("instanceUrl"));
        assert!(json.contains("redirectUri"));
    }

    #[test]
    fn test_exchange_code_request_with_instance_url() {
        let request = ExchangeCodeRequest {
            provider: "gitlab".to_string(),
            code: "auth-code".to_string(),
            verifier: "test-verifier".to_string(),
            instance_url: Some("https://gitlab.example.com".to_string()),
            redirect_uri: "http://127.0.0.1:8080/callback".to_string(),
        };

        let json = serde_json::to_string(&request).unwrap();
        assert!(json.contains("gitlab.example.com"));
    }

    #[test]
    fn test_exchange_code_request_deserialization() {
        let json = r#"{
            "provider": "github",
            "code": "auth-code",
            "verifier": "test-verifier",
            "instanceUrl": null,
            "redirectUri": "http://127.0.0.1:8080/callback"
        }"#;

        let request: ExchangeCodeRequest = serde_json::from_str(json).unwrap();
        assert_eq!(request.provider, "github");
        assert_eq!(request.code, "auth-code");
        assert_eq!(request.verifier, "test-verifier");
        assert!(request.instance_url.is_none());
        assert_eq!(request.redirect_uri, "http://127.0.0.1:8080/callback");
    }

    // ==========================================================================
    // OAuthState Tests
    // ==========================================================================

    #[test]
    fn test_oauth_state_default() {
        let state = OAuthState::default();
        let pending = state.pending.lock().unwrap();
        assert!(pending.is_empty());
    }

    // ==========================================================================
    // oauth_get_authorize_url Tests
    // ==========================================================================

    #[tokio::test]
    async fn test_oauth_get_authorize_url_github() {
        let result =
            oauth_get_authorize_url("github".to_string(), None, "test-client-id".to_string()).await;

        assert!(result.is_ok());
        let response = result.unwrap();

        assert!(response.authorize_url.contains("github.com"));
        assert!(response.authorize_url.contains("client_id=test-client-id"));
        assert!(response.authorize_url.contains("response_type=code"));
        assert!(response.authorize_url.contains("code_challenge="));
        assert!(!response.state.is_empty());
        assert!(response.loopback_port.is_some());

        // The verifier is stored server-side keyed by state, not returned.
        let flow = OAUTH_FLOWS
            .take_pending(&response.state)
            .unwrap()
            .expect("pending flow should be stored for the issued state");
        assert!(!flow.verifier.is_empty());
        assert_eq!(flow.provider, OAuthProvider::GitHub);
    }

    #[tokio::test]
    async fn test_oauth_get_authorize_url_gitlab() {
        let result =
            oauth_get_authorize_url("gitlab".to_string(), None, "test-client-id".to_string()).await;

        assert!(result.is_ok());
        let response = result.unwrap();

        assert!(response.authorize_url.contains("gitlab.com"));
        assert!(response.authorize_url.contains("client_id=test-client-id"));
        assert!(response.loopback_port.is_some());
    }

    #[tokio::test]
    async fn test_oauth_get_authorize_url_gitlab_custom_instance() {
        let result = oauth_get_authorize_url(
            "gitlab".to_string(),
            Some("https://gitlab.example.com".to_string()),
            "test-client-id".to_string(),
        )
        .await;

        assert!(result.is_ok());
        let response = result.unwrap();

        assert!(response.authorize_url.contains("gitlab.example.com"));
    }

    #[tokio::test]
    async fn test_oauth_get_authorize_url_azure() {
        let result =
            oauth_get_authorize_url("azure".to_string(), None, "test-client-id".to_string()).await;

        assert!(result.is_ok());
        let response = result.unwrap();

        assert!(response.authorize_url.contains("login.microsoftonline.com"));
        assert!(response.authorize_url.contains("organizations"));
        assert!(response.loopback_port.is_some());
        // The redirect URI must be a `localhost` loopback (urlencoded into the URL),
        // NOT 127.0.0.1 — Entra only ignores the port for localhost, and the port is
        // dynamic. `localhost%3A` is `localhost:` percent-encoded.
        assert!(response.authorize_url.contains("localhost"));
        assert!(!response.authorize_url.contains("127.0.0.1"));
    }

    #[tokio::test]
    async fn test_oauth_get_authorize_url_azure_custom_tenant() {
        let result = oauth_get_authorize_url(
            "azure".to_string(),
            Some("my-tenant-id".to_string()),
            "test-client-id".to_string(),
        )
        .await;

        assert!(result.is_ok());
        let response = result.unwrap();

        assert!(response.authorize_url.contains("my-tenant-id"));
    }

    #[test]
    fn test_azure_token_url_default_tenant_matches_authorize() {
        // The exchange/refresh token endpoint must default to the SAME tenant
        // segment (`organizations`) the authorize URL is built with, or Entra can
        // reject redeeming the code under a mismatched authority.
        let authorize = OAuthConfig::azure("cid", None, 8080).authorize_url;
        assert!(authorize.contains("/organizations/"));
        assert_eq!(
            azure_token_url(None),
            "https://login.microsoftonline.com/organizations/oauth2/v2.0/token"
        );
    }

    #[test]
    fn test_azure_token_url_specific_tenant() {
        assert_eq!(
            azure_token_url(Some("my-tenant-id")),
            "https://login.microsoftonline.com/my-tenant-id/oauth2/v2.0/token"
        );
    }

    /// Bitbucket's redirect is pinned to the fixed port 8085, so the tests that
    /// exercise it must not run concurrently with each other.
    /// An async mutex: the guard is held across `.await` points.
    static BITBUCKET_PORT_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[tokio::test]
    async fn test_oauth_get_authorize_url_bitbucket() {
        let _guard = BITBUCKET_PORT_TEST_LOCK.lock().await;
        let result =
            oauth_get_authorize_url("bitbucket".to_string(), None, "test-client-id".to_string())
                .await;

        assert!(result.is_ok());
        let response = result.unwrap();

        assert!(response.authorize_url.contains("bitbucket.org"));
        assert!(response.loopback_port.is_some());
        // Bitbucket uses dedicated port 8085
        assert_eq!(response.loopback_port, Some(8085));
    }

    #[tokio::test]
    async fn test_oauth_get_authorize_url_invalid_provider() {
        let result = oauth_get_authorize_url(
            "invalid-provider".to_string(),
            None,
            "test-client-id".to_string(),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_oauth_get_authorize_url_generates_unique_state() {
        let result1 =
            oauth_get_authorize_url("gitlab".to_string(), None, "test-client-id".to_string()).await;
        let result2 =
            oauth_get_authorize_url("gitlab".to_string(), None, "test-client-id".to_string()).await;

        assert!(result1.is_ok());
        assert!(result2.is_ok());

        let response1 = result1.unwrap();
        let response2 = result2.unwrap();

        // Each call should generate unique state
        assert_ne!(response1.state, response2.state);

        // Each call stores a unique verifier server-side (never returned).
        let flow1 = OAUTH_FLOWS.take_pending(&response1.state).unwrap().unwrap();
        let flow2 = OAUTH_FLOWS.take_pending(&response2.state).unwrap().unwrap();
        assert_ne!(flow1.verifier, flow2.verifier);
    }

    // ==========================================================================
    // oauth_start_github_flow Tests
    // ==========================================================================

    #[tokio::test]
    async fn test_oauth_start_github_flow() {
        let result = oauth_start_github_flow("test-client-id".to_string()).await;

        assert!(result.is_ok());
        let response = result.unwrap();

        assert!(response.authorize_url.contains("github.com"));
        assert!(response.loopback_port.is_some());
    }

    // ==========================================================================
    // oauth_wait_for_callback Tests
    // ==========================================================================

    #[tokio::test]
    async fn test_oauth_wait_for_callback_no_server() {
        // Attempting to wait on a port with no pending server should fail
        let result = oauth_wait_for_callback(59999).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_oauth_wait_for_github_callback_alias() {
        // The alias should behave the same as oauth_wait_for_callback
        let result = oauth_wait_for_github_callback(59999).await;
        assert!(result.is_err());
    }

    // ==========================================================================
    // Provider Case Sensitivity Tests
    // ==========================================================================

    #[tokio::test]
    async fn test_oauth_provider_case_insensitive() {
        let result_lower =
            oauth_get_authorize_url("github".to_string(), None, "test-client-id".to_string()).await;
        let result_upper =
            oauth_get_authorize_url("GITHUB".to_string(), None, "test-client-id".to_string()).await;
        let result_mixed =
            oauth_get_authorize_url("GitHub".to_string(), None, "test-client-id".to_string()).await;

        assert!(result_lower.is_ok());
        assert!(result_upper.is_ok());
        assert!(result_mixed.is_ok());
    }

    // ==========================================================================
    // URL Structure Tests
    // ==========================================================================

    #[tokio::test]
    async fn test_oauth_authorize_url_contains_pkce() {
        let result =
            oauth_get_authorize_url("github".to_string(), None, "test-client-id".to_string()).await;

        assert!(result.is_ok());
        let response = result.unwrap();

        assert!(response.authorize_url.contains("code_challenge="));
        assert!(response
            .authorize_url
            .contains("code_challenge_method=S256"));
    }

    #[tokio::test]
    async fn test_oauth_authorize_url_contains_scopes() {
        let result =
            oauth_get_authorize_url("github".to_string(), None, "test-client-id".to_string()).await;

        assert!(result.is_ok());
        let response = result.unwrap();

        // GitHub scopes include "repo" and "read:user"
        assert!(response.authorize_url.contains("scope="));
    }

    // ==========================================================================
    // Pending Server Cleanup Tests
    // ==========================================================================

    #[test]
    fn test_cleanup_expired_pending_servers_removes_old() {
        let mut map: HashMap<u16, PendingServer> = HashMap::new();
        // Create a server that is already expired
        let server = LoopbackServer::new().unwrap();
        let port = server.port();
        map.insert(
            port,
            PendingServer {
                server,
                created_at: std::time::Instant::now() - PENDING_SERVER_TTL - Duration::from_secs(1),
            },
        );

        cleanup_expired_pending_servers(&mut map);
        assert!(map.is_empty(), "expired server should be removed");
    }

    #[test]
    fn test_cleanup_expired_pending_servers_keeps_fresh() {
        let mut map: HashMap<u16, PendingServer> = HashMap::new();
        let server = LoopbackServer::new().unwrap();
        let port = server.port();
        map.insert(
            port,
            PendingServer {
                server,
                created_at: std::time::Instant::now(),
            },
        );

        cleanup_expired_pending_servers(&mut map);
        assert_eq!(map.len(), 1, "fresh server should remain");
    }

    #[test]
    fn test_cleanup_empty_pending_servers() {
        let mut map: HashMap<u16, PendingServer> = HashMap::new();
        cleanup_expired_pending_servers(&mut map);
        assert!(map.is_empty());
    }

    #[test]
    fn test_cleanup_mixed_pending_servers() {
        let mut map: HashMap<u16, PendingServer> = HashMap::new();

        // Add an expired server
        let old_server = LoopbackServer::new().unwrap();
        let old_port = old_server.port();
        map.insert(
            old_port,
            PendingServer {
                server: old_server,
                created_at: std::time::Instant::now()
                    - PENDING_SERVER_TTL
                    - Duration::from_secs(60),
            },
        );

        // Add a fresh server
        let new_server = LoopbackServer::new().unwrap();
        let new_port = new_server.port();
        map.insert(
            new_port,
            PendingServer {
                server: new_server,
                created_at: std::time::Instant::now(),
            },
        );

        cleanup_expired_pending_servers(&mut map);
        assert_eq!(map.len(), 1);
        assert!(map.contains_key(&new_port));
        assert!(!map.contains_key(&old_port));
    }

    // ==========================================================================
    // decode_oidc_id_token Command Tests
    // ==========================================================================

    #[tokio::test]
    async fn test_decode_oidc_id_token_valid() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

        let payload = serde_json::json!({
            "sub": "user-456",
            "email": "test@example.com",
            "name": "OIDC User"
        });
        let payload_b64 = URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes());
        let header_b64 = URL_SAFE_NO_PAD.encode(b"{}");
        let token = format!("{}.{}.sig", header_b64, payload_b64);

        let result = decode_oidc_id_token(token).await;
        assert!(result.is_ok());
        let info = result.unwrap();
        assert_eq!(info.sub, "user-456");
        assert_eq!(info.email, Some("test@example.com".to_string()));
        assert_eq!(info.name, Some("OIDC User".to_string()));
    }

    #[tokio::test]
    async fn test_decode_oidc_id_token_invalid() {
        let result = decode_oidc_id_token("not.valid".to_string()).await;
        assert!(result.is_err());
    }

    // ==========================================================================
    // Multiple OAuth Flows Tests
    // ==========================================================================

    #[tokio::test]
    async fn test_multiple_concurrent_github_flows() {
        // Start multiple GitHub OAuth flows — each should get a unique port/state
        let result1 =
            oauth_get_authorize_url("github".to_string(), None, "client1".to_string()).await;
        let result2 =
            oauth_get_authorize_url("github".to_string(), None, "client2".to_string()).await;

        assert!(result1.is_ok());
        assert!(result2.is_ok());

        let r1 = result1.unwrap();
        let r2 = result2.unwrap();

        // Different ports and states
        assert_ne!(r1.loopback_port, r2.loopback_port);
        assert_ne!(r1.state, r2.state);

        // Each flow's verifier (stored server-side) is unique.
        let f1 = OAUTH_FLOWS.take_pending(&r1.state).unwrap().unwrap();
        let f2 = OAUTH_FLOWS.take_pending(&r2.state).unwrap().unwrap();
        assert_ne!(f1.verifier, f2.verifier);
    }

    fn make_flow(provider: OAuthProvider, verifier: &str) -> PendingOAuthFlow {
        PendingOAuthFlow {
            provider,
            verifier: verifier.to_string(),
            instance_url: None,
            client_id: "test-client-id".to_string(),
            redirect_uri: "http://127.0.0.1:8080/callback".to_string(),
            created_at: std::time::Instant::now(),
        }
    }

    #[test]
    fn test_pending_flow_stores_client_id() {
        // The pending flow must retain the client ID used to build the authorize
        // URL so the token exchange can reuse it for per-account providers (OIDC).
        let state = OAuthState::default();
        let mut flow = make_flow(OAuthProvider::Oidc, "oidc-verifier");
        flow.client_id = "oidc-account-client".to_string();
        flow.instance_url = Some("https://auth.example.com".to_string());
        state
            .insert_pending("oidc-state".to_string(), flow)
            .unwrap();

        let retrieved = state.take_pending("oidc-state").unwrap().unwrap();
        assert_eq!(retrieved.provider, OAuthProvider::Oidc);
        assert_eq!(retrieved.client_id, "oidc-account-client");
        assert_eq!(
            retrieved.instance_url,
            Some("https://auth.example.com".to_string())
        );
    }

    #[test]
    fn test_exchange_client_id_fallback_semantics() {
        // Mirrors the fallback used in oauth_exchange_code: an empty/whitespace
        // client ID from the frontend falls back to the one stored on the flow
        // (OIDC), while a non-empty value is preserved (built-in providers).
        let stored = "stored-oidc-client".to_string();

        let frontend_empty = String::new();
        let resolved = if frontend_empty.trim().is_empty() {
            stored.clone()
        } else {
            frontend_empty
        };
        assert_eq!(resolved, "stored-oidc-client");

        let frontend_whitespace = "   ".to_string();
        let resolved = if frontend_whitespace.trim().is_empty() {
            stored.clone()
        } else {
            frontend_whitespace
        };
        assert_eq!(resolved, "stored-oidc-client");

        let frontend_present = "github-embedded-client".to_string();
        let resolved = if frontend_present.trim().is_empty() {
            stored.clone()
        } else {
            frontend_present
        };
        assert_eq!(resolved, "github-embedded-client");
    }

    #[test]
    fn test_oauth_state_pending_operations() {
        let state = OAuthState::default();

        // Insert a pending flow and round-trip it by `state` key.
        state
            .insert_pending(
                "rt-state".to_string(),
                make_flow(OAuthProvider::GitHub, "v1"),
            )
            .unwrap();

        let flow = state.take_pending("rt-state").unwrap().unwrap();
        assert_eq!(flow.provider, OAuthProvider::GitHub);
        assert_eq!(flow.verifier, "v1");
        assert!(flow.instance_url.is_none());

        // take_pending consumes the entry: a second lookup yields None.
        assert!(state.take_pending("rt-state").unwrap().is_none());
    }

    #[test]
    fn test_take_pending_state_mismatch_rejected() {
        let state = OAuthState::default();
        state
            .insert_pending(
                "issued-state".to_string(),
                make_flow(OAuthProvider::GitLab, "v2"),
            )
            .unwrap();

        // A non-matching state must not resolve to any flow.
        assert!(state.take_pending("attacker-state").unwrap().is_none());
        // The legitimate state still resolves.
        assert!(state.take_pending("issued-state").unwrap().is_some());
    }

    #[test]
    fn test_validate_callback_state_via_global_store() {
        // Insert into the global flow store and validate the state matches.
        OAUTH_FLOWS
            .insert_pending(
                "global-valid-state".to_string(),
                make_flow(OAuthProvider::GitHub, "vg"),
            )
            .unwrap();

        assert!(validate_callback_state("global-valid-state").is_ok());
        assert!(validate_callback_state("does-not-exist").is_err());

        // Validation peeks without consuming — the flow is still retrievable.
        assert!(OAUTH_FLOWS
            .take_pending("global-valid-state")
            .unwrap()
            .is_some());
    }

    #[test]
    fn test_exchange_code_request_all_fields() {
        let request = ExchangeCodeRequest {
            provider: "oidc".to_string(),
            code: "auth-code-123".to_string(),
            verifier: "pkce-verifier".to_string(),
            instance_url: Some("https://auth.example.com".to_string()),
            redirect_uri: "http://127.0.0.1:9090/callback".to_string(),
        };

        // Round-trip serialization
        let json = serde_json::to_string(&request).unwrap();
        let deserialized: ExchangeCodeRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.provider, "oidc");
        assert_eq!(deserialized.code, "auth-code-123");
        assert_eq!(deserialized.verifier, "pkce-verifier");
        assert_eq!(
            deserialized.instance_url,
            Some("https://auth.example.com".to_string())
        );
    }

    // ==========================================================================
    // Cancelling an in-flight OAuth flow (loopback port release)
    // ==========================================================================

    /// Park a server the way `oauth_get_authorize_url` does.
    fn park_server(server: LoopbackServer) -> u16 {
        let port = server.port();
        PENDING_SERVERS.lock().unwrap().insert(
            port,
            PendingServer {
                server,
                created_at: std::time::Instant::now(),
            },
        );
        port
    }

    /// Register an in-flight wait exactly the way `oauth_wait_for_callback`
    /// does — detach the cancel handle, record it under the port, and move the
    /// server into a blocking wait that keeps the socket bound.
    fn register_wait(
        mut server: LoopbackServer,
    ) -> (
        u16,
        u64,
        std::thread::JoinHandle<Result<crate::services::loopback_server::CallbackResult>>,
    ) {
        let port = server.port();
        let id = NEXT_WAIT_ID.fetch_add(1, Ordering::Relaxed);
        let cancel = server
            .take_cancel_handle()
            .expect("cancel handle available");
        ACTIVE_WAITS
            .lock()
            .unwrap()
            .insert(port, ActiveWait { id, cancel });
        let handle = std::thread::spawn(move || server.wait_for_callback(Duration::from_secs(300)));
        (port, id, handle)
    }

    fn port_is_free(port: u16) -> bool {
        std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
    }

    /// The core bug: `oauth_wait_for_callback` consumes the pending server, so a
    /// cancelled sign-in used to hold its port until the 5-minute timeout.
    #[tokio::test]
    async fn test_oauth_cancel_flow_releases_a_port_held_by_an_in_flight_wait() {
        let port = park_server(LoopbackServer::new_with_port(0).unwrap());

        let waiting = tokio::spawn(oauth_wait_for_callback(port));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !port_is_free(port),
            "the in-flight wait should own the port before the cancel"
        );

        oauth_cancel_flow(port).await.unwrap();

        assert!(
            port_is_free(port),
            "cancelling must free the port for an immediate retry"
        );
        assert!(
            waiting.await.unwrap().is_err(),
            "the cancelled wait must not report a callback"
        );
    }

    /// A flow abandoned before the frontend started waiting is still parked in
    /// `PENDING_SERVERS`; cancelling must evict it and free the port too.
    #[tokio::test]
    async fn test_oauth_cancel_flow_releases_a_server_that_never_started_waiting() {
        let port = park_server(LoopbackServer::new_with_port(0).unwrap());

        oauth_cancel_flow(port).await.unwrap();

        assert!(
            !PENDING_SERVERS.lock().unwrap().contains_key(&port),
            "the parked server must be evicted"
        );
        assert!(port_is_free(port), "the parked server's port must be freed");

        // Cancelling again (or after the flow already finished) is a no-op.
        assert!(oauth_cancel_flow(port).await.is_ok());
    }

    /// Cancelling a port we hold nothing on must succeed quietly — the frontend
    /// fires this on every cancel, including for already-completed flows.
    #[tokio::test]
    async fn test_oauth_cancel_flow_is_a_noop_for_an_unknown_port() {
        assert!(oauth_cancel_flow(59998).await.is_ok());
    }

    /// A cancelled wait returns AFTER the user's retry has registered a new wait
    /// on the same (fixed) port. Its deregistration must not strip the retry's
    /// cancel handle, or the retry becomes uncancellable and its port leaks.
    #[tokio::test]
    async fn test_a_finished_wait_does_not_strip_a_retrys_cancel_handle() {
        // Wait A takes the port, then the user cancels it.
        let (port, id_a, handle_a) = register_wait(LoopbackServer::new_with_port(0).unwrap());
        oauth_cancel_flow(port).await.unwrap();
        assert!(handle_a.join().unwrap().is_err());

        // The retry (wait B) reuses the same port.
        let (_, id_b, handle_b) = register_wait(LoopbackServer::new_with_port(port).unwrap());
        assert_ne!(id_a, id_b);

        // Wait A's task only now gets around to deregistering itself.
        unregister_wait(port, id_a);

        // B is still cancellable, so its port is released on the next cancel.
        oauth_cancel_flow(port).await.unwrap();
        assert!(
            port_is_free(port),
            "the retry must still be cancellable after the older wait finishes"
        );
        assert!(handle_b.join().unwrap().is_err());
    }

    /// End-to-end: a Bitbucket sign-in abandoned without a cancel must not make
    /// the next attempt fail with "Port 8085 is not available".
    #[tokio::test]
    async fn test_bitbucket_flow_can_restart_after_an_abandoned_sign_in() {
        let _guard = BITBUCKET_PORT_TEST_LOCK.lock().await;
        let first = oauth_get_authorize_url("bitbucket".to_string(), None, "cid".to_string()).await;
        // Self-skip when another process on this host owns 8085 (same pattern as
        // the IPv6 loopback test) — there is nothing of ours to release then.
        let Ok(first) = first else {
            return;
        };
        assert_eq!(first.loopback_port, Some(8085));

        let second = oauth_get_authorize_url("bitbucket".to_string(), None, "cid".to_string())
            .await
            .expect("a second Bitbucket sign-in must be able to re-bind port 8085");
        assert_eq!(second.loopback_port, Some(8085));

        oauth_cancel_flow(8085).await.unwrap();
    }
}

// ========================================================================
// OIDC Commands
// ========================================================================

/// Discover an OIDC provider's configuration from its issuer URL
#[tauri::command]
pub async fn discover_oidc_provider(
    issuer_url: String,
) -> Result<crate::services::oauth::OidcDiscovery> {
    crate::services::oauth::discover_oidc_config(&issuer_url)
        .await
        .map_err(GitnadoError::OperationFailed)
}

/// Decode an OIDC ID token to extract user identity
#[tauri::command]
pub async fn decode_oidc_id_token(
    id_token: String,
) -> Result<crate::services::oauth::OidcUserInfo> {
    crate::services::oauth::decode_id_token(&id_token).map_err(GitnadoError::OperationFailed)
}
