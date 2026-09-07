//! Bitbucket Integration Commands
//!
//! Provides integration with Bitbucket Cloud for pull requests, issues, and pipelines.
//! Credential storage is handled by the frontend credential service (OS keyring).
//! All API functions accept optional credentials from the frontend.

use crate::error::{GitnadoError, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use tauri::command;

const BITBUCKET_API_BASE: &str = "https://api.bitbucket.org/2.0";

/// Sentinel prefix marking a per-account token slot that actually holds an
/// app-password credential of the form `<PREFIX><username>:<app_password>`.
/// App passwords must be sent as HTTP Basic auth, NOT as a Bearer token
/// (Bitbucket rejects app passwords presented as `Bearer`). OAuth access
/// tokens are stored raw (no prefix) and continue to use Bearer auth.
///
/// Must stay in sync with `BITBUCKET_APP_PASSWORD_PREFIX` in
/// `src/services/credential.service.ts`.
const APP_PASSWORD_PREFIX: &str = "bbapp:";

/// Default page size for the pull-request and issue listings.
///
/// Kept in sync with BITBUCKET_LIST_PAGE_SIZE in lv-bitbucket-dialog.ts, which
/// discloses it to the user.
const LIST_DEFAULT_PAGELEN: u32 = 30;

/// Default page size for the pipeline listing.
///
/// Kept in sync with BITBUCKET_PIPELINE_PAGE_SIZE in lv-bitbucket-dialog.ts.
const PIPELINES_DEFAULT_PAGELEN: u32 = 20;

/// Build the `pagelen=<n>` query fragment for a listing.
///
/// The dialog discloses the page size it asked for ("Showing the first N ...").
/// Taking the size from the caller keeps the number the request caps at and the
/// number the hint quotes the same value, instead of two literals that drift.
fn pagelen_query_param(pagelen: Option<u32>, default_pagelen: u32) -> String {
    format!("pagelen={}", pagelen.unwrap_or(default_pagelen))
}

// ============================================================================
// Credential Management (handled by frontend credential service via OS keyring - these are stubs)
// ============================================================================

/// Store Bitbucket credentials - handled by frontend credential service (OS keyring)
#[command]
pub async fn store_bitbucket_credentials(_username: String, _app_password: String) -> Result<()> {
    // Credential storage is now handled by frontend credential service (OS keyring)
    Ok(())
}

/// Get Bitbucket credentials - handled by frontend credential service (OS keyring)
#[command]
pub async fn get_bitbucket_credentials() -> Result<Option<(String, String)>> {
    // Credential storage is now handled by frontend credential service (OS keyring)
    // Return None - credentials should be passed from frontend
    Ok(None)
}

/// Delete Bitbucket credentials - handled by frontend credential service (OS keyring)
#[command]
pub async fn delete_bitbucket_credentials() -> Result<()> {
    // Credential storage is now handled by frontend credential service (OS keyring)
    Ok(())
}

// ============================================================================
// Types
// ============================================================================

/// Bitbucket user info
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketUser {
    pub uuid: String,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

/// Bitbucket connection status
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketConnectionStatus {
    pub connected: bool,
    pub user: Option<BitbucketUser>,
}

/// Detected Bitbucket repository info
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedBitbucketRepo {
    pub workspace: String,
    pub repo_slug: String,
    pub remote_name: String,
}

/// Pull request summary
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketPullRequest {
    pub id: u64,
    pub title: String,
    pub description: Option<String>,
    pub state: String,
    pub author: BitbucketUser,
    pub created_on: String,
    pub source_branch: String,
    pub destination_branch: String,
    pub url: String,
}

/// Create pull request input
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBitbucketPullRequestInput {
    pub title: String,
    pub description: Option<String>,
    pub source_branch: String,
    pub destination_branch: String,
    pub close_source_branch: Option<bool>,
}

/// Create issue input
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBitbucketIssueInput {
    pub title: String,
    pub content: Option<String>,
    pub kind: Option<String>,
    pub priority: Option<String>,
}

/// Issue summary
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketIssue {
    pub id: u64,
    pub title: String,
    pub content: Option<String>,
    pub state: String,
    pub priority: String,
    pub kind: String,
    pub reporter: Option<BitbucketUser>,
    pub assignee: Option<BitbucketUser>,
    pub created_on: String,
    pub url: String,
}

/// Pipeline summary
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketPipeline {
    pub uuid: String,
    pub build_number: u64,
    pub state_name: String,
    pub result_name: Option<String>,
    pub target_branch: String,
    pub created_on: String,
    pub completed_on: Option<String>,
    pub url: String,
}

// ============================================================================
// Helper Functions
// ============================================================================

fn get_auth_header(username: &str, password: &str) -> String {
    let credentials = format!("{}:{}", username, password);
    format!("Basic {}", BASE64.encode(credentials.as_bytes()))
}

/// Build the Authorization header for a per-account token.
///
/// A token stored with the `bbapp:` prefix is an app-password credential
/// (`bbapp:<username>:<app_password>`) and must use HTTP Basic auth. Any other
/// token is treated as an OAuth access token and uses Bearer auth. This lets a
/// single token slot carry either credential kind and route it correctly,
/// mirroring how Azure DevOps auto-detects JWT vs PAT.
fn build_token_auth_header(token: &str) -> String {
    if let Some(rest) = token.strip_prefix(APP_PASSWORD_PREFIX) {
        // Split on the FIRST colon only: usernames never contain a colon, and an
        // app password may, so everything after the first colon is the password.
        if let Some((username, password)) = rest.split_once(':') {
            return get_auth_header(username, password);
        }
    }
    format!("Bearer {}", token)
}

/// Get auth header - prefer OAuth token if provided, otherwise use username/password
fn get_auth_header_with_token(
    token: Option<&str>,
    username: Option<&str>,
    app_password: Option<&str>,
) -> Result<String> {
    // Prefer a per-account token if provided. It may be an OAuth bearer token or
    // a prefixed app-password credential; build_token_auth_header picks the right
    // scheme for each.
    if let Some(t) = token {
        if !t.is_empty() {
            return Ok(build_token_auth_header(t));
        }
    }

    // Fall back to username/password
    match (username, app_password) {
        (Some(u), Some(p)) if !u.is_empty() && !p.is_empty() => Ok(get_auth_header(u, p)),
        _ => Err(GitnadoError::OperationFailed(
            "Bitbucket credentials not configured".to_string(),
        )),
    }
}

// ============================================================================
// Connection Commands
// ============================================================================

/// Check Bitbucket connection status
#[command]
pub async fn check_bitbucket_connection(
    username: Option<String>,
    app_password: Option<String>,
) -> Result<BitbucketConnectionStatus> {
    // Use provided credentials, or fall back to stored credentials
    let credentials = match (username, app_password) {
        (Some(u), Some(p)) if !u.is_empty() && !p.is_empty() => (u, p),
        _ => match get_bitbucket_credentials().await? {
            Some(c) => c,
            None => {
                return Ok(BitbucketConnectionStatus {
                    connected: false,
                    user: None,
                })
            }
        },
    };

    let client = reqwest::Client::new();

    let response = client
        .get(format!("{}/user", BITBUCKET_API_BASE))
        .header(
            "Authorization",
            get_auth_header(&credentials.0, &credentials.1),
        )
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to check connection: {}", e)))?;

    if !response.status().is_success() {
        return Ok(BitbucketConnectionStatus {
            connected: false,
            user: None,
        });
    }

    #[derive(Deserialize)]
    struct ApiUser {
        uuid: String,
        username: String,
        display_name: String,
        links: ApiLinks,
    }

    #[derive(Deserialize)]
    struct ApiLinks {
        avatar: Option<ApiLink>,
    }

    #[derive(Deserialize)]
    struct ApiLink {
        href: String,
    }

    let api_user: ApiUser = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse user data: {}", e)))?;

    Ok(BitbucketConnectionStatus {
        connected: true,
        user: Some(BitbucketUser {
            uuid: api_user.uuid,
            username: api_user.username,
            display_name: api_user.display_name,
            avatar_url: api_user.links.avatar.map(|a| a.href),
        }),
    })
}

/// Check Bitbucket connection status using OAuth token
#[command]
pub async fn check_bitbucket_connection_with_token(
    token: Option<String>,
) -> Result<BitbucketConnectionStatus> {
    let token = match token {
        Some(t) if !t.is_empty() => t,
        _ => {
            return Ok(BitbucketConnectionStatus {
                connected: false,
                user: None,
            })
        }
    };

    let client = reqwest::Client::new();

    let response = client
        .get(format!("{}/user", BITBUCKET_API_BASE))
        .header("Authorization", build_token_auth_header(&token))
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to check connection: {}", e)))?;

    if !response.status().is_success() {
        return Ok(BitbucketConnectionStatus {
            connected: false,
            user: None,
        });
    }

    #[derive(Deserialize)]
    struct ApiUser {
        uuid: String,
        username: String,
        display_name: String,
        links: ApiLinks,
    }

    #[derive(Deserialize)]
    struct ApiLinks {
        avatar: Option<ApiLink>,
    }

    #[derive(Deserialize)]
    struct ApiLink {
        href: String,
    }

    let api_user: ApiUser = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse user data: {}", e)))?;

    Ok(BitbucketConnectionStatus {
        connected: true,
        user: Some(BitbucketUser {
            uuid: api_user.uuid,
            username: api_user.username,
            display_name: api_user.display_name,
            avatar_url: api_user.links.avatar.map(|a| a.href),
        }),
    })
}

/// Detect Bitbucket repository from git remotes
#[command]
pub async fn detect_bitbucket_repo(path: String) -> Result<Option<DetectedBitbucketRepo>> {
    let repo = git2::Repository::open(&path)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to open repository: {}", e)))?;

    let remotes = repo
        .remotes()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to get remotes: {}", e)))?;

    for remote_name in remotes.iter().flatten().flatten() {
        if let Ok(remote) = repo.find_remote(remote_name) {
            if let Ok(url) = remote.url() {
                if let Some(repo_info) = parse_bitbucket_url(url) {
                    return Ok(Some(DetectedBitbucketRepo {
                        workspace: repo_info.0,
                        repo_slug: repo_info.1,
                        remote_name: remote_name.to_string(),
                    }));
                }
            }
        }
    }

    Ok(None)
}

fn parse_bitbucket_url(url: &str) -> Option<(String, String)> {
    // Bitbucket URLs can be:
    // https://bitbucket.org/{workspace}/{repo}.git
    // https://username@bitbucket.org/{workspace}/{repo}.git
    // git@bitbucket.org:{workspace}/{repo}.git

    // SSH format
    if url.starts_with("git@bitbucket.org:") {
        let path = url.trim_start_matches("git@bitbucket.org:");
        let path = path.trim_end_matches(".git");
        let parts: Vec<&str> = path.split('/').collect();
        if parts.len() >= 2 {
            return Some((parts[0].to_string(), parts[1].to_string()));
        }
    }

    // HTTPS format (with or without username@)
    if url.contains("bitbucket.org") {
        let url = url
            .trim_start_matches("https://")
            .trim_start_matches("http://");

        // Handle username@bitbucket.org format - strip everything before bitbucket.org
        let url = if let Some(pos) = url.find("bitbucket.org") {
            &url[pos..]
        } else {
            url
        };

        let url = url.trim_start_matches("bitbucket.org/");
        let path = url.trim_end_matches(".git");
        let parts: Vec<&str> = path.split('/').collect();
        if parts.len() >= 2 {
            return Some((parts[0].to_string(), parts[1].to_string()));
        }
    }

    None
}

// ============================================================================
// Pull Request Commands
// ============================================================================

/// List pull requests for a repository
#[command]
pub async fn list_bitbucket_pull_requests(
    workspace: String,
    repo_slug: String,
    state: Option<String>,
    pagelen: Option<u32>,
    token: Option<String>,
    username: Option<String>,
    app_password: Option<String>,
) -> Result<Vec<BitbucketPullRequest>> {
    let auth_header = get_auth_header_with_token(
        token.as_deref(),
        username.as_deref(),
        app_password.as_deref(),
    )?;

    let state_param = state.unwrap_or_else(|| "OPEN".to_string());
    let url = format!(
        "{}/repositories/{}/{}/pullrequests?state={}&{}",
        BITBUCKET_API_BASE,
        workspace,
        repo_slug,
        state_param,
        pagelen_query_param(pagelen, LIST_DEFAULT_PAGELEN)
    );

    tracing::debug!(
        "Fetching Bitbucket PRs: url={}, has_token={}",
        url,
        token.is_some()
    );

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Authorization", auth_header)
        .send()
        .await
        .map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to fetch pull requests: {}", e))
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "Bitbucket API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiResponse {
        values: Vec<ApiPullRequest>,
    }

    #[derive(Deserialize)]
    struct ApiPullRequest {
        id: u64,
        title: String,
        description: Option<String>,
        state: String,
        author: ApiUser,
        created_on: String,
        source: ApiBranch,
        destination: ApiBranch,
        links: ApiPrLinks,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        uuid: String,
        username: Option<String>,
        display_name: String,
        links: ApiLinks,
    }

    #[derive(Deserialize)]
    struct ApiLinks {
        avatar: Option<ApiLink>,
    }

    #[derive(Deserialize)]
    struct ApiLink {
        href: String,
    }

    #[derive(Deserialize)]
    struct ApiBranch {
        branch: ApiBranchName,
    }

    #[derive(Deserialize)]
    struct ApiBranchName {
        name: String,
    }

    #[derive(Deserialize)]
    struct ApiPrLinks {
        html: ApiLink,
    }

    let data: ApiResponse = response.json().await.map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse pull requests: {}", e))
    })?;

    Ok(data
        .values
        .into_iter()
        .map(|pr| BitbucketPullRequest {
            id: pr.id,
            title: pr.title,
            description: pr.description,
            state: pr.state,
            author: BitbucketUser {
                uuid: pr.author.uuid,
                username: pr.author.username.unwrap_or_default(),
                display_name: pr.author.display_name,
                avatar_url: pr.author.links.avatar.map(|a| a.href),
            },
            created_on: pr.created_on,
            source_branch: pr.source.branch.name,
            destination_branch: pr.destination.branch.name,
            url: pr.links.html.href,
        })
        .collect())
}

/// Get a single pull request
#[command]
pub async fn get_bitbucket_pull_request(
    workspace: String,
    repo_slug: String,
    pr_id: u64,
    token: Option<String>,
    username: Option<String>,
    app_password: Option<String>,
) -> Result<BitbucketPullRequest> {
    let auth_header = get_auth_header_with_token(
        token.as_deref(),
        username.as_deref(),
        app_password.as_deref(),
    )?;

    let url = format!(
        "{}/repositories/{}/{}/pullrequests/{}",
        BITBUCKET_API_BASE, workspace, repo_slug, pr_id
    );

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Authorization", auth_header)
        .send()
        .await
        .map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to fetch pull request: {}", e))
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "Bitbucket API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiPullRequest {
        id: u64,
        title: String,
        description: Option<String>,
        state: String,
        author: ApiUser,
        created_on: String,
        source: ApiBranch,
        destination: ApiBranch,
        links: ApiPrLinks,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        uuid: String,
        username: Option<String>,
        display_name: String,
        links: ApiLinks,
    }

    #[derive(Deserialize)]
    struct ApiLinks {
        avatar: Option<ApiLink>,
    }

    #[derive(Deserialize)]
    struct ApiLink {
        href: String,
    }

    #[derive(Deserialize)]
    struct ApiBranch {
        branch: ApiBranchName,
    }

    #[derive(Deserialize)]
    struct ApiBranchName {
        name: String,
    }

    #[derive(Deserialize)]
    struct ApiPrLinks {
        html: ApiLink,
    }

    let pr: ApiPullRequest = response.json().await.map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse pull request: {}", e))
    })?;

    Ok(BitbucketPullRequest {
        id: pr.id,
        title: pr.title,
        description: pr.description,
        state: pr.state,
        author: BitbucketUser {
            uuid: pr.author.uuid,
            username: pr.author.username.unwrap_or_default(),
            display_name: pr.author.display_name,
            avatar_url: pr.author.links.avatar.map(|a| a.href),
        },
        created_on: pr.created_on,
        source_branch: pr.source.branch.name,
        destination_branch: pr.destination.branch.name,
        url: pr.links.html.href,
    })
}

/// Create a pull request
#[command]
pub async fn create_bitbucket_pull_request(
    workspace: String,
    repo_slug: String,
    input: CreateBitbucketPullRequestInput,
    token: Option<String>,
    username: Option<String>,
    app_password: Option<String>,
) -> Result<BitbucketPullRequest> {
    let auth_header = get_auth_header_with_token(
        token.as_deref(),
        username.as_deref(),
        app_password.as_deref(),
    )?;

    let url = format!(
        "{}/repositories/{}/{}/pullrequests",
        BITBUCKET_API_BASE, workspace, repo_slug
    );

    #[derive(Serialize)]
    struct CreatePrBody {
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        source: BranchSpec,
        destination: BranchSpec,
        #[serde(skip_serializing_if = "Option::is_none")]
        close_source_branch: Option<bool>,
    }

    #[derive(Serialize)]
    struct BranchSpec {
        branch: BranchName,
    }

    #[derive(Serialize)]
    struct BranchName {
        name: String,
    }

    let body = CreatePrBody {
        title: input.title,
        description: input.description,
        source: BranchSpec {
            branch: BranchName {
                name: input.source_branch,
            },
        },
        destination: BranchSpec {
            branch: BranchName {
                name: input.destination_branch,
            },
        },
        close_source_branch: input.close_source_branch,
    };

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Authorization", auth_header)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to create pull request: {}", e))
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "Bitbucket API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiPullRequest {
        id: u64,
        title: String,
        description: Option<String>,
        state: String,
        author: ApiUser,
        created_on: String,
        source: ApiBranch,
        destination: ApiBranch,
        links: ApiPrLinks,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        uuid: String,
        username: Option<String>,
        display_name: String,
        links: ApiLinks,
    }

    #[derive(Deserialize)]
    struct ApiLinks {
        avatar: Option<ApiLink>,
    }

    #[derive(Deserialize)]
    struct ApiLink {
        href: String,
    }

    #[derive(Deserialize)]
    struct ApiBranch {
        branch: ApiBranchName,
    }

    #[derive(Deserialize)]
    struct ApiBranchName {
        name: String,
    }

    #[derive(Deserialize)]
    struct ApiPrLinks {
        html: ApiLink,
    }

    let pr: ApiPullRequest = response.json().await.map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse pull request: {}", e))
    })?;

    Ok(BitbucketPullRequest {
        id: pr.id,
        title: pr.title,
        description: pr.description,
        state: pr.state,
        author: BitbucketUser {
            uuid: pr.author.uuid,
            username: pr.author.username.unwrap_or_default(),
            display_name: pr.author.display_name,
            avatar_url: pr.author.links.avatar.map(|a| a.href),
        },
        created_on: pr.created_on,
        source_branch: pr.source.branch.name,
        destination_branch: pr.destination.branch.name,
        url: pr.links.html.href,
    })
}

// ============================================================================
// Issue Commands (Note: Issues must be enabled on the repository)
// ============================================================================

/// List issues for a repository
#[command]
pub async fn list_bitbucket_issues(
    workspace: String,
    repo_slug: String,
    state: Option<String>,
    pagelen: Option<u32>,
    token: Option<String>,
    username: Option<String>,
    app_password: Option<String>,
) -> Result<Vec<BitbucketIssue>> {
    let auth_header = get_auth_header_with_token(
        token.as_deref(),
        username.as_deref(),
        app_password.as_deref(),
    )?;

    let mut url = format!(
        "{}/repositories/{}/{}/issues?{}",
        BITBUCKET_API_BASE,
        workspace,
        repo_slug,
        pagelen_query_param(pagelen, LIST_DEFAULT_PAGELEN)
    );

    if let Some(state_str) = state {
        url.push_str(&format!("&q=state=\"{}\"", state_str));
    }

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Authorization", auth_header)
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to fetch issues: {}", e)))?;

    if !response.status().is_success() {
        // A 404 means the issue tracker is not enabled for this repo — treat as empty.
        // Other failures (401/403/500…) are real errors and must be surfaced, not
        // silently swallowed as "no issues".
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(vec![]);
        }
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "Bitbucket API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiResponse {
        values: Vec<ApiIssue>,
    }

    #[derive(Deserialize)]
    struct ApiIssue {
        id: u64,
        title: String,
        content: Option<ApiContent>,
        state: String,
        priority: String,
        kind: String,
        reporter: Option<ApiUser>,
        assignee: Option<ApiUser>,
        created_on: String,
        links: ApiIssueLinks,
    }

    #[derive(Deserialize)]
    struct ApiContent {
        raw: Option<String>,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        uuid: String,
        username: Option<String>,
        display_name: String,
        links: ApiLinks,
    }

    #[derive(Deserialize)]
    struct ApiLinks {
        avatar: Option<ApiLink>,
    }

    #[derive(Deserialize)]
    struct ApiLink {
        href: String,
    }

    #[derive(Deserialize)]
    struct ApiIssueLinks {
        html: ApiLink,
    }

    let data: ApiResponse = response
        .json()
        .await
        .unwrap_or(ApiResponse { values: vec![] });

    Ok(data
        .values
        .into_iter()
        .map(|issue| BitbucketIssue {
            id: issue.id,
            title: issue.title,
            content: issue.content.and_then(|c| c.raw),
            state: issue.state,
            priority: issue.priority,
            kind: issue.kind,
            reporter: issue.reporter.map(|u| BitbucketUser {
                uuid: u.uuid,
                username: u.username.unwrap_or_default(),
                display_name: u.display_name,
                avatar_url: u.links.avatar.map(|a| a.href),
            }),
            assignee: issue.assignee.map(|u| BitbucketUser {
                uuid: u.uuid,
                username: u.username.unwrap_or_default(),
                display_name: u.display_name,
                avatar_url: u.links.avatar.map(|a| a.href),
            }),
            created_on: issue.created_on,
            url: issue.links.html.href,
        })
        .collect())
}

/// Create a new issue
#[command]
pub async fn create_bitbucket_issue(
    workspace: String,
    repo_slug: String,
    input: CreateBitbucketIssueInput,
    token: Option<String>,
    username: Option<String>,
    app_password: Option<String>,
) -> Result<BitbucketIssue> {
    let auth_header = get_auth_header_with_token(
        token.as_deref(),
        username.as_deref(),
        app_password.as_deref(),
    )?;

    let url = format!(
        "{}/repositories/{}/{}/issues",
        BITBUCKET_API_BASE, workspace, repo_slug
    );

    let body = build_create_issue_body(&input);

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Authorization", auth_header)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to create issue: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "Bitbucket API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiIssue {
        id: u64,
        title: String,
        content: Option<ApiContent>,
        state: String,
        priority: String,
        kind: String,
        reporter: Option<ApiUser>,
        assignee: Option<ApiUser>,
        created_on: String,
        links: ApiIssueLinks,
    }

    #[derive(Deserialize)]
    struct ApiContent {
        raw: Option<String>,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        uuid: String,
        username: Option<String>,
        display_name: String,
        links: ApiLinks,
    }

    #[derive(Deserialize)]
    struct ApiLinks {
        avatar: Option<ApiLink>,
    }

    #[derive(Deserialize)]
    struct ApiLink {
        href: String,
    }

    #[derive(Deserialize)]
    struct ApiIssueLinks {
        html: ApiLink,
    }

    let issue: ApiIssue = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse issue: {}", e)))?;

    Ok(BitbucketIssue {
        id: issue.id,
        title: issue.title,
        content: issue.content.and_then(|c| c.raw),
        state: issue.state,
        priority: issue.priority,
        kind: issue.kind,
        reporter: issue.reporter.map(|u| BitbucketUser {
            uuid: u.uuid,
            username: u.username.unwrap_or_default(),
            display_name: u.display_name,
            avatar_url: u.links.avatar.map(|a| a.href),
        }),
        assignee: issue.assignee.map(|u| BitbucketUser {
            uuid: u.uuid,
            username: u.username.unwrap_or_default(),
            display_name: u.display_name,
            avatar_url: u.links.avatar.map(|a| a.href),
        }),
        created_on: issue.created_on,
        url: issue.links.html.href,
    })
}

/// Build the JSON body for creating a Bitbucket issue.
/// The Bitbucket Cloud API expects content as `{ "raw": "..." }`.
fn build_create_issue_body(input: &CreateBitbucketIssueInput) -> serde_json::Value {
    let mut body = serde_json::Map::new();
    body.insert(
        "title".to_string(),
        serde_json::Value::String(input.title.clone()),
    );

    if let Some(content) = &input.content {
        if !content.is_empty() {
            body.insert("content".to_string(), serde_json::json!({ "raw": content }));
        }
    }

    if let Some(kind) = &input.kind {
        if !kind.is_empty() {
            body.insert("kind".to_string(), serde_json::Value::String(kind.clone()));
        }
    }

    if let Some(priority) = &input.priority {
        if !priority.is_empty() {
            body.insert(
                "priority".to_string(),
                serde_json::Value::String(priority.clone()),
            );
        }
    }

    serde_json::Value::Object(body)
}

// ============================================================================
// Pipeline Commands
// ============================================================================

/// List pipelines for a repository
#[command]
pub async fn list_bitbucket_pipelines(
    workspace: String,
    repo_slug: String,
    pagelen: Option<u32>,
    token: Option<String>,
    username: Option<String>,
    app_password: Option<String>,
) -> Result<Vec<BitbucketPipeline>> {
    let auth_header = get_auth_header_with_token(
        token.as_deref(),
        username.as_deref(),
        app_password.as_deref(),
    )?;

    let url = format!(
        "{}/repositories/{}/{}/pipelines/?{}&sort=-created_on",
        BITBUCKET_API_BASE,
        workspace,
        repo_slug,
        pagelen_query_param(pagelen, PIPELINES_DEFAULT_PAGELEN)
    );

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Authorization", auth_header)
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to fetch pipelines: {}", e)))?;

    if !response.status().is_success() {
        // A 404 means Pipelines is not enabled for this repo — treat as empty.
        // Other failures (401/403/500…) are real errors and must be surfaced, not
        // silently swallowed as "no pipelines".
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(vec![]);
        }
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "Bitbucket API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiResponse {
        values: Vec<ApiPipeline>,
    }

    #[derive(Deserialize)]
    struct ApiPipeline {
        uuid: String,
        build_number: u64,
        state: ApiState,
        target: ApiTarget,
        created_on: String,
        completed_on: Option<String>,
        links: ApiPipelineLinks,
    }

    #[derive(Deserialize)]
    struct ApiState {
        name: String,
        result: Option<ApiResult>,
    }

    #[derive(Deserialize)]
    struct ApiResult {
        name: String,
    }

    #[derive(Deserialize)]
    struct ApiTarget {
        ref_name: Option<String>,
    }

    #[derive(Deserialize)]
    struct ApiPipelineLinks {
        html: Option<ApiLink>,
    }

    #[derive(Deserialize)]
    struct ApiLink {
        href: String,
    }

    let data: ApiResponse = response
        .json()
        .await
        .unwrap_or(ApiResponse { values: vec![] });

    Ok(data
        .values
        .into_iter()
        .map(|p| BitbucketPipeline {
            uuid: p.uuid,
            build_number: p.build_number,
            state_name: p.state.name,
            result_name: p.state.result.map(|r| r.name),
            target_branch: p.target.ref_name.unwrap_or_else(|| "unknown".to_string()),
            created_on: p.created_on,
            completed_on: p.completed_on,
            url: p.links.html.map(|l| l.href).unwrap_or_else(|| {
                format!(
                    "https://bitbucket.org/{}/{}/pipelines",
                    workspace, repo_slug
                )
            }),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[test]
    fn test_pagelen_query_param() {
        // The caller's page size wins, so the size requested is the size the
        // dialog discloses.
        assert_eq!(pagelen_query_param(Some(30), 30), "pagelen=30");
        assert_eq!(pagelen_query_param(Some(5), 30), "pagelen=5");
        // No caller size falls back to this file's default.
        assert_eq!(pagelen_query_param(None, 30), "pagelen=30");
        assert_eq!(pagelen_query_param(None, 20), "pagelen=20");
    }

    // ========================================================================
    // parse_bitbucket_url Tests
    // ========================================================================

    #[test]
    fn test_parse_bitbucket_url_https() {
        let result = parse_bitbucket_url("https://bitbucket.org/workspace/repo.git");
        assert!(result.is_some());
        let (workspace, repo_slug) = result.unwrap();
        assert_eq!(workspace, "workspace");
        assert_eq!(repo_slug, "repo");
    }

    #[test]
    fn test_parse_bitbucket_url_https_no_git_suffix() {
        let result = parse_bitbucket_url("https://bitbucket.org/workspace/repo");
        assert!(result.is_some());
        let (workspace, repo_slug) = result.unwrap();
        assert_eq!(workspace, "workspace");
        assert_eq!(repo_slug, "repo");
    }

    #[test]
    fn test_parse_bitbucket_url_https_with_username() {
        let result = parse_bitbucket_url("https://username@bitbucket.org/workspace/repo.git");
        assert!(result.is_some());
        let (workspace, repo_slug) = result.unwrap();
        assert_eq!(workspace, "workspace");
        assert_eq!(repo_slug, "repo");
    }

    #[test]
    fn test_parse_bitbucket_url_ssh() {
        let result = parse_bitbucket_url("git@bitbucket.org:workspace/repo.git");
        assert!(result.is_some());
        let (workspace, repo_slug) = result.unwrap();
        assert_eq!(workspace, "workspace");
        assert_eq!(repo_slug, "repo");
    }

    #[test]
    fn test_parse_bitbucket_url_ssh_no_git_suffix() {
        let result = parse_bitbucket_url("git@bitbucket.org:workspace/repo");
        assert!(result.is_some());
        let (workspace, repo_slug) = result.unwrap();
        assert_eq!(workspace, "workspace");
        assert_eq!(repo_slug, "repo");
    }

    #[test]
    fn test_parse_bitbucket_url_not_bitbucket() {
        let result = parse_bitbucket_url("https://github.com/owner/repo.git");
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_bitbucket_url_gitlab() {
        let result = parse_bitbucket_url("https://gitlab.com/owner/repo.git");
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_bitbucket_url_invalid() {
        let result = parse_bitbucket_url("not-a-valid-url");
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_bitbucket_url_http() {
        let result = parse_bitbucket_url("http://bitbucket.org/workspace/repo.git");
        assert!(result.is_some());
        let (workspace, repo_slug) = result.unwrap();
        assert_eq!(workspace, "workspace");
        assert_eq!(repo_slug, "repo");
    }

    // ========================================================================
    // get_auth_header Tests
    // ========================================================================

    #[test]
    fn test_get_auth_header_basic() {
        let header = get_auth_header("username", "password");
        assert!(header.starts_with("Basic "));
        // Verify it's valid base64
        let encoded = header.strip_prefix("Basic ").unwrap();
        let decoded = BASE64.decode(encoded).expect("Should be valid base64");
        let decoded_str = String::from_utf8(decoded).expect("Should be valid UTF-8");
        assert_eq!(decoded_str, "username:password");
    }

    #[test]
    fn test_get_auth_header_special_characters() {
        let header = get_auth_header("user@example.com", "p@ss:word!");
        assert!(header.starts_with("Basic "));
        let encoded = header.strip_prefix("Basic ").unwrap();
        let decoded = BASE64.decode(encoded).expect("Should be valid base64");
        let decoded_str = String::from_utf8(decoded).expect("Should be valid UTF-8");
        assert_eq!(decoded_str, "user@example.com:p@ss:word!");
    }

    // ========================================================================
    // get_auth_header_with_token Tests
    // ========================================================================

    #[test]
    fn test_get_auth_header_with_token_prefers_token() {
        let result =
            get_auth_header_with_token(Some("oauth_token"), Some("username"), Some("password"));
        assert!(result.is_ok());
        let header = result.unwrap();
        assert_eq!(header, "Bearer oauth_token");
    }

    #[test]
    fn test_get_auth_header_with_token_falls_back_to_basic() {
        let result = get_auth_header_with_token(None, Some("username"), Some("password"));
        assert!(result.is_ok());
        let header = result.unwrap();
        assert!(header.starts_with("Basic "));
    }

    #[test]
    fn test_get_auth_header_with_token_empty_token_falls_back() {
        let result = get_auth_header_with_token(Some(""), Some("username"), Some("password"));
        assert!(result.is_ok());
        let header = result.unwrap();
        assert!(header.starts_with("Basic "));
    }

    #[test]
    fn test_get_auth_header_with_token_no_credentials_errors() {
        let result = get_auth_header_with_token(None, None, None);
        assert!(result.is_err());
    }

    // ========================================================================
    // build_token_auth_header Tests (app-password vs OAuth routing)
    // ========================================================================

    #[test]
    fn test_build_token_auth_header_oauth_uses_bearer() {
        // A raw OAuth access token (no prefix) must use Bearer auth.
        let header = build_token_auth_header("oauth_access_token_abc");
        assert_eq!(header, "Bearer oauth_access_token_abc");
    }

    #[test]
    fn test_build_token_auth_header_app_password_uses_basic() {
        // A prefixed app-password credential must use Basic auth, decoding to
        // username:app_password.
        let header = build_token_auth_header("bbapp:myuser:my-app-password");
        assert!(header.starts_with("Basic "));
        let encoded = header.strip_prefix("Basic ").unwrap();
        let decoded = BASE64.decode(encoded).expect("Should be valid base64");
        let decoded_str = String::from_utf8(decoded).expect("Should be valid UTF-8");
        assert_eq!(decoded_str, "myuser:my-app-password");
    }

    #[test]
    fn test_build_token_auth_header_app_password_with_colon_in_password() {
        // Only the first colon separates username from password; a colon inside
        // the password must be preserved.
        let header = build_token_auth_header("bbapp:myuser:pa:ss:word");
        let encoded = header.strip_prefix("Basic ").unwrap();
        let decoded = BASE64.decode(encoded).expect("Should be valid base64");
        let decoded_str = String::from_utf8(decoded).expect("Should be valid UTF-8");
        assert_eq!(decoded_str, "myuser:pa:ss:word");
    }

    #[test]
    fn test_build_token_auth_header_prefix_without_colon_falls_back_to_bearer() {
        // Malformed (prefix but no username:password separator) — treat as bearer
        // rather than panicking.
        let header = build_token_auth_header("bbapp:no-separator");
        assert_eq!(header, "Bearer bbapp:no-separator");
    }

    #[test]
    fn test_get_auth_header_with_token_app_password_token_uses_basic() {
        // End-to-end: an app-password credential passed via the token slot routes
        // through Basic auth for every API call (PRs, issues, pipelines, create).
        let result = get_auth_header_with_token(Some("bbapp:user:pass"), None, None);
        assert!(result.is_ok());
        let header = result.unwrap();
        assert!(header.starts_with("Basic "));
        let encoded = header.strip_prefix("Basic ").unwrap();
        let decoded = BASE64.decode(encoded).expect("Should be valid base64");
        assert_eq!(String::from_utf8(decoded).unwrap(), "user:pass");
    }

    #[test]
    fn test_get_auth_header_with_token_oauth_token_uses_bearer() {
        let result = get_auth_header_with_token(Some("oauth_token"), None, None);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "Bearer oauth_token");
    }

    #[test]
    fn test_get_auth_header_with_token_empty_credentials_errors() {
        let result = get_auth_header_with_token(None, Some(""), Some(""));
        assert!(result.is_err());
    }

    // ========================================================================
    // BitbucketUser Tests
    // ========================================================================

    #[test]
    fn test_bitbucket_user_serialization() {
        let user = BitbucketUser {
            uuid: "{12345}".to_string(),
            username: "octocat".to_string(),
            display_name: "The Octocat".to_string(),
            avatar_url: Some("https://example.com/avatar.png".to_string()),
        };

        let json = serde_json::to_string(&user).expect("Failed to serialize");
        assert!(json.contains("displayName") || json.contains("display_name"));
        assert!(json.contains("avatarUrl") || json.contains("avatar_url"));
    }

    #[test]
    fn test_bitbucket_user_without_avatar() {
        let user = BitbucketUser {
            uuid: "{12345}".to_string(),
            username: "testuser".to_string(),
            display_name: "Test User".to_string(),
            avatar_url: None,
        };

        assert!(user.avatar_url.is_none());
        let json = serde_json::to_string(&user).expect("Failed to serialize");
        assert!(json.contains("null") || !json.contains("avatar"));
    }

    // ========================================================================
    // BitbucketConnectionStatus Tests
    // ========================================================================

    #[test]
    fn test_connection_status_connected() {
        let status = BitbucketConnectionStatus {
            connected: true,
            user: Some(BitbucketUser {
                uuid: "{12345}".to_string(),
                username: "testuser".to_string(),
                display_name: "Test User".to_string(),
                avatar_url: None,
            }),
        };

        assert!(status.connected);
        assert!(status.user.is_some());
    }

    #[test]
    fn test_connection_status_disconnected() {
        let status = BitbucketConnectionStatus {
            connected: false,
            user: None,
        };

        assert!(!status.connected);
        assert!(status.user.is_none());
    }

    // ========================================================================
    // DetectedBitbucketRepo Tests
    // ========================================================================

    #[test]
    fn test_detected_repo_structure() {
        let repo = DetectedBitbucketRepo {
            workspace: "myworkspace".to_string(),
            repo_slug: "myrepo".to_string(),
            remote_name: "origin".to_string(),
        };

        assert_eq!(repo.workspace, "myworkspace");
        assert_eq!(repo.repo_slug, "myrepo");
        assert_eq!(repo.remote_name, "origin");
    }

    #[test]
    fn test_detected_repo_serialization() {
        let repo = DetectedBitbucketRepo {
            workspace: "workspace".to_string(),
            repo_slug: "repo".to_string(),
            remote_name: "upstream".to_string(),
        };

        let json = serde_json::to_string(&repo).expect("Failed to serialize");
        assert!(json.contains("repoSlug") || json.contains("repo_slug"));
        assert!(json.contains("remoteName") || json.contains("remote_name"));
    }

    // ========================================================================
    // BitbucketPullRequest Tests
    // ========================================================================

    #[test]
    fn test_pull_request_structure() {
        let pr = BitbucketPullRequest {
            id: 123,
            title: "Fix bug".to_string(),
            description: Some("This fixes the bug".to_string()),
            state: "OPEN".to_string(),
            author: BitbucketUser {
                uuid: "{author}".to_string(),
                username: "author".to_string(),
                display_name: "Author".to_string(),
                avatar_url: None,
            },
            created_on: "2024-01-01T00:00:00Z".to_string(),
            source_branch: "feature".to_string(),
            destination_branch: "main".to_string(),
            url: "https://bitbucket.org/workspace/repo/pull-requests/123".to_string(),
        };

        assert_eq!(pr.id, 123);
        assert_eq!(pr.state, "OPEN");
        assert_eq!(pr.source_branch, "feature");
        assert_eq!(pr.destination_branch, "main");
    }

    #[test]
    fn test_pull_request_without_description() {
        let pr = BitbucketPullRequest {
            id: 456,
            title: "Quick fix".to_string(),
            description: None,
            state: "MERGED".to_string(),
            author: BitbucketUser {
                uuid: "{author}".to_string(),
                username: "author".to_string(),
                display_name: "Author".to_string(),
                avatar_url: None,
            },
            created_on: "2024-01-02T00:00:00Z".to_string(),
            source_branch: "hotfix".to_string(),
            destination_branch: "main".to_string(),
            url: "https://bitbucket.org/workspace/repo/pull-requests/456".to_string(),
        };

        assert!(pr.description.is_none());
        assert_eq!(pr.state, "MERGED");
    }

    // ========================================================================
    // CreateBitbucketPullRequestInput Tests
    // ========================================================================

    #[test]
    fn test_create_pr_input_full() {
        let input = CreateBitbucketPullRequestInput {
            title: "New Feature".to_string(),
            description: Some("Adds new feature".to_string()),
            source_branch: "feature/new".to_string(),
            destination_branch: "main".to_string(),
            close_source_branch: Some(true),
        };

        assert_eq!(input.title, "New Feature");
        assert!(input.close_source_branch.unwrap());
    }

    #[test]
    fn test_create_pr_input_minimal() {
        let input = CreateBitbucketPullRequestInput {
            title: "Minimal PR".to_string(),
            description: None,
            source_branch: "branch".to_string(),
            destination_branch: "main".to_string(),
            close_source_branch: None,
        };

        assert!(input.description.is_none());
        assert!(input.close_source_branch.is_none());
    }

    // ========================================================================
    // BitbucketIssue Tests
    // ========================================================================

    #[test]
    fn test_issue_structure() {
        let issue = BitbucketIssue {
            id: 42,
            title: "Bug report".to_string(),
            content: Some("Description of the bug".to_string()),
            state: "open".to_string(),
            priority: "major".to_string(),
            kind: "bug".to_string(),
            reporter: Some(BitbucketUser {
                uuid: "{reporter}".to_string(),
                username: "reporter".to_string(),
                display_name: "Reporter".to_string(),
                avatar_url: None,
            }),
            assignee: None,
            created_on: "2024-01-01T00:00:00Z".to_string(),
            url: "https://bitbucket.org/workspace/repo/issues/42".to_string(),
        };

        assert_eq!(issue.id, 42);
        assert_eq!(issue.kind, "bug");
        assert_eq!(issue.priority, "major");
        assert!(issue.assignee.is_none());
    }

    // ========================================================================
    // CreateBitbucketIssueInput / build_create_issue_body Tests
    // ========================================================================

    #[test]
    fn test_create_issue_input_full() {
        let input = CreateBitbucketIssueInput {
            title: "Bug report".to_string(),
            content: Some("Steps to reproduce".to_string()),
            kind: Some("bug".to_string()),
            priority: Some("major".to_string()),
        };

        assert_eq!(input.title, "Bug report");
        assert_eq!(input.kind.as_deref(), Some("bug"));
    }

    #[test]
    fn test_create_issue_input_minimal() {
        let input = CreateBitbucketIssueInput {
            title: "Just a title".to_string(),
            content: None,
            kind: None,
            priority: None,
        };

        assert!(input.content.is_none());
        assert!(input.kind.is_none());
        assert!(input.priority.is_none());
    }

    #[test]
    fn test_build_create_issue_body_full() {
        let input = CreateBitbucketIssueInput {
            title: "My Issue".to_string(),
            content: Some("Detailed description".to_string()),
            kind: Some("enhancement".to_string()),
            priority: Some("minor".to_string()),
        };

        let body = build_create_issue_body(&input);
        assert_eq!(body["title"], "My Issue");
        // Content must be wrapped as { "raw": ... } per Bitbucket API
        assert_eq!(body["content"]["raw"], "Detailed description");
        assert_eq!(body["kind"], "enhancement");
        assert_eq!(body["priority"], "minor");
    }

    #[test]
    fn test_build_create_issue_body_title_only() {
        let input = CreateBitbucketIssueInput {
            title: "Title only".to_string(),
            content: None,
            kind: None,
            priority: None,
        };

        let body = build_create_issue_body(&input);
        assert_eq!(body["title"], "Title only");
        // Optional fields must be omitted when not provided
        assert!(body.get("content").is_none());
        assert!(body.get("kind").is_none());
        assert!(body.get("priority").is_none());
    }

    #[test]
    fn test_build_create_issue_body_skips_empty_strings() {
        let input = CreateBitbucketIssueInput {
            title: "Title".to_string(),
            content: Some(String::new()),
            kind: Some(String::new()),
            priority: Some(String::new()),
        };

        let body = build_create_issue_body(&input);
        assert!(body.get("content").is_none());
        assert!(body.get("kind").is_none());
        assert!(body.get("priority").is_none());
    }

    #[test]
    fn test_create_bitbucket_issue_input_serialization() {
        let input = CreateBitbucketIssueInput {
            title: "Serialize me".to_string(),
            content: Some("body".to_string()),
            kind: Some("task".to_string()),
            priority: Some("trivial".to_string()),
        };

        let json = serde_json::to_string(&input).expect("Failed to serialize");
        assert!(json.contains("title"));
        assert!(json.contains("content"));
    }

    // ========================================================================
    // BitbucketPipeline Tests
    // ========================================================================

    #[test]
    fn test_pipeline_structure() {
        let pipeline = BitbucketPipeline {
            uuid: "{pipeline-uuid}".to_string(),
            build_number: 100,
            state_name: "COMPLETED".to_string(),
            result_name: Some("SUCCESSFUL".to_string()),
            target_branch: "main".to_string(),
            created_on: "2024-01-01T00:00:00Z".to_string(),
            completed_on: Some("2024-01-01T00:05:00Z".to_string()),
            url: "https://bitbucket.org/workspace/repo/pipelines/100".to_string(),
        };

        assert_eq!(pipeline.build_number, 100);
        assert_eq!(pipeline.state_name, "COMPLETED");
        assert_eq!(pipeline.result_name, Some("SUCCESSFUL".to_string()));
    }

    #[test]
    fn test_pipeline_in_progress() {
        let pipeline = BitbucketPipeline {
            uuid: "{pipeline-uuid}".to_string(),
            build_number: 101,
            state_name: "IN_PROGRESS".to_string(),
            result_name: None,
            target_branch: "feature".to_string(),
            created_on: "2024-01-02T00:00:00Z".to_string(),
            completed_on: None,
            url: "https://bitbucket.org/workspace/repo/pipelines/101".to_string(),
        };

        assert_eq!(pipeline.state_name, "IN_PROGRESS");
        assert!(pipeline.result_name.is_none());
        assert!(pipeline.completed_on.is_none());
    }

    // ========================================================================
    // detect_bitbucket_repo Tests
    // ========================================================================

    #[tokio::test]
    async fn test_detect_bitbucket_repo_no_remotes() {
        let repo = TestRepo::with_initial_commit();
        let result = detect_bitbucket_repo(repo.path_str()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_detect_bitbucket_repo_github_remote() {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://github.com/owner/repo.git");

        let result = detect_bitbucket_repo(repo.path_str()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_none()); // GitHub URL, not Bitbucket
    }

    #[tokio::test]
    async fn test_detect_bitbucket_repo_with_bitbucket_remote() {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://bitbucket.org/workspace/repo.git");

        let result = detect_bitbucket_repo(repo.path_str()).await;
        assert!(result.is_ok());
        let detected = result.unwrap();
        assert!(detected.is_some());
        let detected = detected.unwrap();
        assert_eq!(detected.workspace, "workspace");
        assert_eq!(detected.repo_slug, "repo");
        assert_eq!(detected.remote_name, "origin");
    }

    #[tokio::test]
    async fn test_detect_bitbucket_repo_ssh_url() {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "git@bitbucket.org:myworkspace/myrepo.git");

        let result = detect_bitbucket_repo(repo.path_str()).await;
        assert!(result.is_ok());
        let detected = result.unwrap();
        assert!(detected.is_some());
        let detected = detected.unwrap();
        assert_eq!(detected.workspace, "myworkspace");
        assert_eq!(detected.repo_slug, "myrepo");
    }

    #[tokio::test]
    async fn test_detect_bitbucket_repo_invalid_path() {
        let result = detect_bitbucket_repo("/nonexistent/path".to_string()).await;
        assert!(result.is_err());
    }

    // ========================================================================
    // Credential Stub Tests
    // ========================================================================

    #[tokio::test]
    async fn test_store_credentials_stub() {
        let result = store_bitbucket_credentials("user".to_string(), "password".to_string()).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_get_credentials_stub() {
        let result = get_bitbucket_credentials().await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_none()); // Always returns None as stub
    }

    #[tokio::test]
    async fn test_delete_credentials_stub() {
        let result = delete_bitbucket_credentials().await;
        assert!(result.is_ok());
    }
}
