//! GitHub integration command handlers
//! Provides GitHub API integration for PRs, issues, and Actions

use serde::{Deserialize, Serialize};
use tauri::command;

use crate::error::{GitnadoError, Result};

const GITHUB_API_BASE: &str = "https://api.github.com";

/// GitHub user information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubUser {
    pub login: String,
    pub id: u64,
    #[serde(alias = "avatar_url", rename = "avatarUrl")]
    pub avatar_url: String,
    pub name: Option<String>,
    pub email: Option<String>,
}

/// GitHub repository information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepo {
    pub id: u64,
    pub name: String,
    pub full_name: String,
    pub private: bool,
    pub html_url: String,
    pub description: Option<String>,
    pub default_branch: String,
    pub open_issues_count: u32,
    pub has_issues: bool,
    pub has_projects: bool,
    pub has_wiki: bool,
}

/// Pull request state
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PullRequestState {
    Open,
    Closed,
    Merged,
}

/// Pull request summary for listing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestSummary {
    pub number: u32,
    pub title: String,
    pub state: String,
    pub user: GitHubUser,
    pub created_at: String,
    pub updated_at: String,
    pub head_ref: String,
    pub head_sha: String,
    pub base_ref: String,
    pub draft: bool,
    pub mergeable: Option<bool>,
    pub merged_at: Option<String>,
    pub html_url: String,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub changed_files: Option<u32>,
}

/// Pull request details
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetails {
    pub number: u32,
    pub title: String,
    pub body: Option<String>,
    pub state: String,
    pub user: GitHubUser,
    pub created_at: String,
    pub updated_at: String,
    pub closed_at: Option<String>,
    pub merged_at: Option<String>,
    pub head_ref: String,
    pub head_sha: String,
    pub base_ref: String,
    pub base_sha: String,
    pub draft: bool,
    pub mergeable: Option<bool>,
    pub mergeable_state: Option<String>,
    pub html_url: String,
    pub additions: u32,
    pub deletions: u32,
    pub changed_files: u32,
    pub commits: u32,
    pub comments: u32,
    pub review_comments: u32,
    pub labels: Vec<Label>,
    pub assignees: Vec<GitHubUser>,
    pub reviewers: Vec<GitHubUser>,
}

/// GitHub label
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub id: u64,
    pub name: String,
    pub color: String,
    pub description: Option<String>,
}

/// Pull request review
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReview {
    pub id: u64,
    pub user: GitHubUser,
    pub body: Option<String>,
    pub state: String,
    pub submitted_at: Option<String>,
    pub html_url: String,
}

/// PR comment
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestComment {
    pub id: u64,
    pub user: GitHubUser,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    pub html_url: String,
}

/// GitHub Actions workflow run
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub id: u64,
    pub name: String,
    pub head_branch: String,
    pub head_sha: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub workflow_id: u64,
    pub html_url: String,
    pub created_at: String,
    pub updated_at: String,
    pub run_number: u32,
    pub event: String,
}

/// GitHub Actions check run
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRun {
    pub id: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub html_url: Option<String>,
}

/// Create pull request input
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePullRequestInput {
    pub title: String,
    pub body: Option<String>,
    pub head: String,
    pub base: String,
    pub draft: Option<bool>,
}

/// GitHub connection status
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubConnectionStatus {
    pub connected: bool,
    pub user: Option<GitHubUser>,
    pub scopes: Vec<String>,
}

/// Detected GitHub repository info from remote URL
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedGitHubRepo {
    pub owner: String,
    pub repo: String,
    pub remote_name: String,
}

// ============================================================================
// Authentication Commands
// ============================================================================

/// Helper to resolve the token for a request.
///
/// Falls back to a GitHub App installation token when the caller has no
/// per-account token but an App is configured. Without this, connecting via
/// GitHub App was a dead end: `configure_github_app` persists only the app
/// config, so every subsequent request arrived with `None` and failed with
/// "GitHub token not configured" despite the UI reporting a live connection.
///
/// Minted per call rather than stored at connect time — installation tokens
/// expire after an hour, so a stored one would leave the integration dead again
/// shortly after it started working.
async fn resolve_github_token(token: Option<String>) -> Result<String> {
    if let Some(t) = token {
        if !t.is_empty() {
            return Ok(t);
        }
    }

    if let Some(app_token) = github_app_installation_token().await? {
        return Ok(app_token);
    }

    Err(GitnadoError::OperationFailed(
        "GitHub token not configured".to_string(),
    ))
}

/// Mint a fresh installation token from the stored GitHub App config.
///
/// Returns `Ok(None)` when no App is configured, so callers can fall through to
/// their own "not configured" handling.
async fn github_app_installation_token() -> Result<Option<String>> {
    use crate::commands::credentials::get_keyring_token;
    use crate::services::github_app;

    let raw = match get_keyring_token(GITHUB_APP_KEYRING_KEY.to_string()).await? {
        Some(s) => s,
        None => return Ok(None),
    };

    let cfg = deserialize_app_config(&raw)?;

    let jwt = github_app::generate_jwt(cfg.app_id, &cfg.private_key_pem)
        .map_err(GitnadoError::OperationFailed)?;
    let token = github_app::get_installation_token(&jwt, cfg.installation_id)
        .await
        .map_err(GitnadoError::OperationFailed)?;

    Ok(Some(token.token))
}

/// Check GitHub connection and get user info
#[command]
pub async fn check_github_connection(token: Option<String>) -> Result<GitHubConnectionStatus> {
    // No per-account token: fall back to a GitHub App installation token so an
    // App-connected account reports connected instead of flipping back to
    // "disconnected" the next time the dialog opens.
    let token = match token {
        Some(t) if !t.is_empty() => t,
        // An error here is NOT the same as "no App configured". A corrupt
        // config or a failed mint is actionable, and folding it into
        // connected:false would hide the reason — something the user-token path
        // never does. Propagate it and report disconnected only when there is
        // genuinely no App to fall back to.
        _ => match github_app_installation_token().await? {
            Some(app_token) => {
                // /user is a user-scoped endpoint an installation token cannot
                // reach, so report the installation itself as the connection.
                return Ok(GitHubConnectionStatus {
                    connected: !app_token.is_empty(),
                    user: None,
                    scopes: vec!["app-installation".to_string()],
                });
            }
            None => {
                return Ok(GitHubConnectionStatus {
                    connected: false,
                    user: None,
                    scopes: vec![],
                })
            }
        },
    };

    let client = reqwest::Client::new();
    let response = client
        .get(format!("{}/user", GITHUB_API_BASE))
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "Gitnado-Git-Client")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to connect to GitHub: {}", e))
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let error_body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitHub API error ({}): {}",
            status, error_body
        )));
    }

    // Get scopes from header
    let scopes: Vec<String> = response
        .headers()
        .get("x-oauth-scopes")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(", ").map(|s| s.to_string()).collect())
        .unwrap_or_default();

    let user: GitHubUser = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse user: {}", e)))?;

    Ok(GitHubConnectionStatus {
        connected: true,
        user: Some(user),
        scopes,
    })
}

// ============================================================================
// Repository Detection
// ============================================================================

/// Detect GitHub repository from git remotes
#[command]
pub async fn detect_github_repo(
    path: String,
    remote_name: Option<String>,
) -> Result<Option<DetectedGitHubRepo>> {
    let repo = git2::Repository::open(&path)
        .map_err(|e| GitnadoError::RepositoryNotFound(e.to_string()))?;

    // Check all remotes for GitHub URLs
    for candidate in repo.remotes()?.iter().flatten().flatten() {
        if remote_name
            .as_deref()
            .is_some_and(|wanted| wanted != candidate)
        {
            continue;
        }
        if let Ok(remote) = repo.find_remote(candidate) {
            if let Ok(url) = remote.url() {
                if let Some(parsed) = parse_github_url(url) {
                    return Ok(Some(DetectedGitHubRepo {
                        owner: parsed.0,
                        repo: parsed.1,
                        remote_name: candidate.to_string(),
                    }));
                }
            }
        }
    }

    Ok(None)
}

/// Parse GitHub URL to extract owner and repo
fn parse_github_url(url: &str) -> Option<(String, String)> {
    // Handle SSH format: git@github.com:owner/repo.git
    if url.starts_with("git@github.com:") {
        let path = url.strip_prefix("git@github.com:")?;
        let path = path.strip_suffix(".git").unwrap_or(path);
        let parts: Vec<&str> = path.split('/').collect();
        if parts.len() == 2 {
            return Some((parts[0].to_string(), parts[1].to_string()));
        }
    }

    // Handle HTTPS format: https://github.com/owner/repo.git
    if url.contains("github.com") {
        let url = url
            .strip_prefix("https://")
            .or_else(|| url.strip_prefix("http://"))?;
        let url = url.strip_prefix("github.com/")?;
        let url = url.strip_suffix(".git").unwrap_or(url);
        let parts: Vec<&str> = url.split('/').collect();
        if parts.len() >= 2 {
            return Some((parts[0].to_string(), parts[1].to_string()));
        }
    }

    None
}

// ============================================================================
// Pagination Helpers
// ============================================================================

/// Maximum `/issues` pages fetched to fill one page of real issues. The issues
/// endpoint returns pull requests too and they are filtered out below, so a
/// pull-request-heavy repository can hand back a full API page containing no
/// issues at all; the walk keeps going in that case, but never past this many
/// requests.
const MAX_ISSUE_PAGE_FETCHES: u32 = 5;

/// Maximum label pages collected. Labels feed a picker that has no paging of
/// its own, so the command gathers the pages itself rather than truncating the
/// list at the first one.
const MAX_LABEL_PAGE_FETCHES: u32 = 5;

/// Pagination query pairs shared by the list endpoints. GitHub pages are
/// 1-based, so anything lower means the first page.
fn pagination_query(per_page: u32, page: Option<u32>) -> [(&'static str, String); 2] {
    [
        ("per_page", per_page.to_string()),
        ("page", page.unwrap_or(1).max(1).to_string()),
    ]
}

/// The page to request after `page` returned `raw_len` entries, or `None` when
/// GitHub returned a short page — the list ends there.
fn next_page_after(page: u32, raw_len: usize, per_page: u32) -> Option<u32> {
    if per_page > 0 && raw_len >= per_page as usize {
        Some(page + 1)
    } else {
        None
    }
}

/// Whether the issue walk should spend another request: the page of results is
/// not full yet (pull requests filtered out of `/issues` can leave it short or
/// even empty) and the request budget is not spent.
fn should_fetch_more_issues(collected: usize, per_page: u32, fetches: u32) -> bool {
    collected < per_page as usize && fetches < MAX_ISSUE_PAGE_FETCHES
}

// ============================================================================
// Pull Request Commands
// ============================================================================

/// List pull requests for a repository
#[command]
pub async fn list_pull_requests(
    owner: String,
    repo: String,
    state: Option<String>,
    per_page: Option<u32>,
    page: Option<u32>,
    token: Option<String>,
) -> Result<Vec<PullRequestSummary>> {
    let token = resolve_github_token(token).await?;

    let state = state.unwrap_or_else(|| "open".to_string());
    let per_page = per_page.unwrap_or(30);

    let client = reqwest::Client::new();
    let response = client
        .get(format!(
            "{}/repos/{}/{}/pulls",
            GITHUB_API_BASE, owner, repo
        ))
        .query(&[("state", state.as_str())])
        .query(&pagination_query(per_page, page))
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "Gitnado-Git-Client")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to fetch PRs: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitHub API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiPR {
        number: u32,
        title: String,
        state: String,
        user: ApiUser,
        created_at: String,
        updated_at: String,
        merged_at: Option<String>,
        head: ApiRef,
        base: ApiRef,
        draft: Option<bool>,
        mergeable: Option<bool>,
        html_url: String,
        additions: Option<u32>,
        deletions: Option<u32>,
        changed_files: Option<u32>,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        login: String,
        id: u64,
        avatar_url: String,
        name: Option<String>,
        email: Option<String>,
    }

    #[derive(Deserialize)]
    struct ApiRef {
        #[serde(rename = "ref")]
        ref_name: String,
        sha: String,
    }

    let prs: Vec<ApiPR> = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse PRs: {}", e)))?;

    Ok(prs
        .into_iter()
        .map(|pr| PullRequestSummary {
            number: pr.number,
            title: pr.title,
            state: pr.state,
            user: GitHubUser {
                login: pr.user.login,
                id: pr.user.id,
                avatar_url: pr.user.avatar_url,
                name: pr.user.name,
                email: pr.user.email,
            },
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            merged_at: pr.merged_at,
            head_ref: pr.head.ref_name,
            head_sha: pr.head.sha,
            base_ref: pr.base.ref_name,
            draft: pr.draft.unwrap_or(false),
            mergeable: pr.mergeable,
            html_url: pr.html_url,
            additions: pr.additions,
            deletions: pr.deletions,
            changed_files: pr.changed_files,
        })
        .collect())
}

/// Get pull request details
#[command]
pub async fn get_pull_request(
    owner: String,
    repo: String,
    number: u32,
    token: Option<String>,
) -> Result<PullRequestDetails> {
    let token = resolve_github_token(token).await?;

    let client = reqwest::Client::new();
    let response = client
        .get(format!(
            "{}/repos/{}/{}/pulls/{}",
            GITHUB_API_BASE, owner, repo, number
        ))
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "Gitnado-Git-Client")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to fetch PR: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitHub API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiPRDetail {
        number: u32,
        title: String,
        body: Option<String>,
        state: String,
        user: ApiUser,
        created_at: String,
        updated_at: String,
        closed_at: Option<String>,
        merged_at: Option<String>,
        head: ApiRefDetail,
        base: ApiRefDetail,
        draft: Option<bool>,
        mergeable: Option<bool>,
        mergeable_state: Option<String>,
        html_url: String,
        additions: u32,
        deletions: u32,
        changed_files: u32,
        commits: u32,
        comments: u32,
        review_comments: u32,
        labels: Vec<ApiLabel>,
        assignees: Vec<ApiUser>,
        requested_reviewers: Vec<ApiUser>,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        login: String,
        id: u64,
        avatar_url: String,
        name: Option<String>,
        email: Option<String>,
    }

    #[derive(Deserialize)]
    struct ApiRefDetail {
        #[serde(rename = "ref")]
        ref_name: String,
        sha: String,
    }

    #[derive(Deserialize)]
    struct ApiLabel {
        id: u64,
        name: String,
        color: String,
        description: Option<String>,
    }

    let pr: ApiPRDetail = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse PR: {}", e)))?;

    Ok(PullRequestDetails {
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        user: GitHubUser {
            login: pr.user.login,
            id: pr.user.id,
            avatar_url: pr.user.avatar_url,
            name: pr.user.name,
            email: pr.user.email,
        },
        created_at: pr.created_at,
        updated_at: pr.updated_at,
        closed_at: pr.closed_at,
        merged_at: pr.merged_at,
        head_ref: pr.head.ref_name,
        head_sha: pr.head.sha,
        base_ref: pr.base.ref_name,
        base_sha: pr.base.sha,
        draft: pr.draft.unwrap_or(false),
        mergeable: pr.mergeable,
        mergeable_state: pr.mergeable_state,
        html_url: pr.html_url,
        additions: pr.additions,
        deletions: pr.deletions,
        changed_files: pr.changed_files,
        commits: pr.commits,
        comments: pr.comments,
        review_comments: pr.review_comments,
        labels: pr
            .labels
            .into_iter()
            .map(|l| Label {
                id: l.id,
                name: l.name,
                color: l.color,
                description: l.description,
            })
            .collect(),
        assignees: pr
            .assignees
            .into_iter()
            .map(|u| GitHubUser {
                login: u.login,
                id: u.id,
                avatar_url: u.avatar_url,
                name: u.name,
                email: u.email,
            })
            .collect(),
        reviewers: pr
            .requested_reviewers
            .into_iter()
            .map(|u| GitHubUser {
                login: u.login,
                id: u.id,
                avatar_url: u.avatar_url,
                name: u.name,
                email: u.email,
            })
            .collect(),
    })
}

/// Create a new pull request
#[command]
pub async fn create_pull_request(
    owner: String,
    repo: String,
    input: CreatePullRequestInput,
    token: Option<String>,
) -> Result<PullRequestSummary> {
    let token = resolve_github_token(token).await?;

    #[derive(Serialize)]
    struct CreatePRBody {
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        body: Option<String>,
        head: String,
        base: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        draft: Option<bool>,
    }

    let body = CreatePRBody {
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft,
    };

    let client = reqwest::Client::new();
    let response = client
        .post(format!(
            "{}/repos/{}/{}/pulls",
            GITHUB_API_BASE, owner, repo
        ))
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "Gitnado-Git-Client")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&body)
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to create PR: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitHub API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiPR {
        number: u32,
        title: String,
        state: String,
        user: ApiUser,
        created_at: String,
        updated_at: String,
        head: ApiRef,
        base: ApiRef,
        draft: Option<bool>,
        html_url: String,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        login: String,
        id: u64,
        avatar_url: String,
        name: Option<String>,
        email: Option<String>,
    }

    #[derive(Deserialize)]
    struct ApiRef {
        #[serde(rename = "ref")]
        ref_name: String,
        sha: String,
    }

    let pr: ApiPR = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse PR: {}", e)))?;

    Ok(PullRequestSummary {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        user: GitHubUser {
            login: pr.user.login,
            id: pr.user.id,
            avatar_url: pr.user.avatar_url,
            name: pr.user.name,
            email: pr.user.email,
        },
        created_at: pr.created_at,
        updated_at: pr.updated_at,
        merged_at: None,
        head_ref: pr.head.ref_name,
        head_sha: pr.head.sha,
        base_ref: pr.base.ref_name,
        draft: pr.draft.unwrap_or(false),
        mergeable: None,
        html_url: pr.html_url,
        additions: None,
        deletions: None,
        changed_files: None,
    })
}

/// Get pull request reviews
#[command]
pub async fn get_pull_request_reviews(
    owner: String,
    repo: String,
    number: u32,
    token: Option<String>,
) -> Result<Vec<PullRequestReview>> {
    let token = resolve_github_token(token).await?;

    let client = reqwest::Client::new();
    let response = client
        .get(format!(
            "{}/repos/{}/{}/pulls/{}/reviews",
            GITHUB_API_BASE, owner, repo, number
        ))
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "Gitnado-Git-Client")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to fetch reviews: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitHub API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiReview {
        id: u64,
        user: ApiUser,
        body: Option<String>,
        state: String,
        submitted_at: Option<String>,
        html_url: String,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        login: String,
        id: u64,
        avatar_url: String,
        name: Option<String>,
        email: Option<String>,
    }

    let reviews: Vec<ApiReview> = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse reviews: {}", e)))?;

    Ok(reviews
        .into_iter()
        .map(|r| PullRequestReview {
            id: r.id,
            user: GitHubUser {
                login: r.user.login,
                id: r.user.id,
                avatar_url: r.user.avatar_url,
                name: r.user.name,
                email: r.user.email,
            },
            body: r.body,
            state: r.state,
            submitted_at: r.submitted_at,
            html_url: r.html_url,
        })
        .collect())
}

// ============================================================================
// GitHub Actions Commands
// ============================================================================

/// Get workflow runs for a repository
#[command]
pub async fn get_workflow_runs(
    owner: String,
    repo: String,
    branch: Option<String>,
    per_page: Option<u32>,
    page: Option<u32>,
    token: Option<String>,
) -> Result<Vec<WorkflowRun>> {
    let token = resolve_github_token(token).await?;

    let per_page = per_page.unwrap_or(20);

    let client = reqwest::Client::new();
    let mut request = client
        .get(format!(
            "{}/repos/{}/{}/actions/runs",
            GITHUB_API_BASE, owner, repo
        ))
        .query(&pagination_query(per_page, page))
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "Gitnado-Git-Client")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");

    if let Some(branch) = branch {
        request = request.query(&[("branch", branch)]);
    }

    let response = request.send().await.map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to fetch workflow runs: {}", e))
    })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitHub API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiWorkflowRuns {
        workflow_runs: Vec<ApiWorkflowRun>,
    }

    #[derive(Deserialize)]
    struct ApiWorkflowRun {
        id: u64,
        name: Option<String>,
        head_branch: Option<String>,
        head_sha: String,
        status: String,
        conclusion: Option<String>,
        workflow_id: u64,
        html_url: String,
        created_at: String,
        updated_at: String,
        run_number: u32,
        event: String,
    }

    let runs: ApiWorkflowRuns = response.json().await.map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse workflow runs: {}", e))
    })?;

    Ok(runs
        .workflow_runs
        .into_iter()
        .map(|r| WorkflowRun {
            id: r.id,
            name: r.name.unwrap_or_else(|| "Unknown".to_string()),
            head_branch: r.head_branch.unwrap_or_default(),
            head_sha: r.head_sha,
            status: r.status,
            conclusion: r.conclusion,
            workflow_id: r.workflow_id,
            html_url: r.html_url,
            created_at: r.created_at,
            updated_at: r.updated_at,
            run_number: r.run_number,
            event: r.event,
        })
        .collect())
}

/// Get check runs for a specific commit
#[command]
pub async fn get_check_runs(
    owner: String,
    repo: String,
    commit_sha: String,
    token: Option<String>,
) -> Result<Vec<CheckRun>> {
    let token = resolve_github_token(token).await?;

    let client = reqwest::Client::new();
    let response = client
        .get(format!(
            "{}/repos/{}/{}/commits/{}/check-runs",
            GITHUB_API_BASE, owner, repo, commit_sha
        ))
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "Gitnado-Git-Client")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to fetch check runs: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitHub API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiCheckRuns {
        check_runs: Vec<ApiCheckRun>,
    }

    #[derive(Deserialize)]
    struct ApiCheckRun {
        id: u64,
        name: String,
        status: String,
        conclusion: Option<String>,
        started_at: Option<String>,
        completed_at: Option<String>,
        html_url: Option<String>,
    }

    let runs: ApiCheckRuns = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse check runs: {}", e)))?;

    Ok(runs
        .check_runs
        .into_iter()
        .map(|r| CheckRun {
            id: r.id,
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            started_at: r.started_at,
            completed_at: r.completed_at,
            html_url: r.html_url,
        })
        .collect())
}

/// Get combined status for a commit (legacy status API + checks)
#[command]
pub async fn get_commit_status(
    owner: String,
    repo: String,
    commit_sha: String,
    token: Option<String>,
) -> Result<String> {
    let token = resolve_github_token(token).await?;

    let client = reqwest::Client::new();
    let response = client
        .get(format!(
            "{}/repos/{}/{}/commits/{}/status",
            GITHUB_API_BASE, owner, repo, commit_sha
        ))
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "Gitnado-Git-Client")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to fetch commit status: {}", e))
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitHub API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiStatus {
        state: String,
    }

    let status: ApiStatus = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse status: {}", e)))?;

    Ok(status.state)
}

// ============================================================================
// Issue Types
// ============================================================================

/// Issue summary for listing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueSummary {
    pub number: u32,
    pub title: String,
    pub state: String,
    pub user: GitHubUser,
    pub labels: Vec<Label>,
    pub assignees: Vec<GitHubUser>,
    pub comments: u32,
    pub created_at: String,
    pub updated_at: String,
    pub closed_at: Option<String>,
    pub html_url: String,
    pub body: Option<String>,
}

/// One page of issues plus the cursor for the next request.
///
/// `/issues` returns pull requests alongside issues and they are filtered out
/// when the page is mapped, so the number of issues in a page says nothing
/// about whether more exist — a full API page of pull requests yields none at
/// all. `next_page` carries that answer instead.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuePage {
    pub issues: Vec<IssueSummary>,
    pub next_page: Option<u32>,
}

/// Issue comment
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    pub id: u64,
    pub user: GitHubUser,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    pub html_url: String,
}

/// Create issue input
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateIssueInput {
    pub title: String,
    pub body: Option<String>,
    pub labels: Option<Vec<String>>,
    pub assignees: Option<Vec<String>>,
}

// ============================================================================
// Issue Commands
// ============================================================================

/// List issues for a repository
///
/// The `/issues` endpoint returns pull requests alongside issues and they are
/// filtered out here, so a single API page can yield few issues or none at
/// all. The command keeps walking pages until it has a full page of real
/// issues (bounded by `MAX_ISSUE_PAGE_FETCHES`) and reports where the caller
/// should resume in `next_page`.
#[command]
pub async fn list_issues(
    owner: String,
    repo: String,
    state: Option<String>,
    labels: Option<String>,
    per_page: Option<u32>,
    page: Option<u32>,
    token: Option<String>,
) -> Result<IssuePage> {
    let token = resolve_github_token(token).await?;

    let state = state.unwrap_or_else(|| "open".to_string());
    let per_page = per_page.unwrap_or(30);

    #[derive(Deserialize)]
    struct ApiIssue {
        number: u32,
        title: String,
        state: String,
        user: ApiUser,
        labels: Vec<ApiLabel>,
        assignees: Vec<ApiUser>,
        comments: u32,
        created_at: String,
        updated_at: String,
        closed_at: Option<String>,
        html_url: String,
        body: Option<String>,
        pull_request: Option<serde_json::Value>, // Present if this is a PR
    }

    #[derive(Deserialize)]
    struct ApiUser {
        login: String,
        id: u64,
        avatar_url: String,
        name: Option<String>,
        email: Option<String>,
    }

    #[derive(Deserialize)]
    struct ApiLabel {
        id: u64,
        name: String,
        color: String,
        description: Option<String>,
    }

    let client = reqwest::Client::new();
    let mut current = page.unwrap_or(1).max(1);
    let mut collected: Vec<IssueSummary> = Vec::new();
    let mut fetches = 0u32;

    let next_page = loop {
        let mut request = client
            .get(format!(
                "{}/repos/{}/{}/issues",
                GITHUB_API_BASE, owner, repo
            ))
            .query(&[("state", state.as_str())])
            .query(&pagination_query(per_page, Some(current)))
            .header("Authorization", format!("Bearer {}", token))
            .header("User-Agent", "Gitnado-Git-Client")
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");

        if let Some(labels) = labels.as_ref() {
            request = request.query(&[("labels", labels)]);
        }

        let response = request
            .send()
            .await
            .map_err(|e| GitnadoError::OperationFailed(format!("Failed to fetch issues: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(GitnadoError::OperationFailed(format!(
                "GitHub API error {}: {}",
                status, body
            )));
        }

        let issues: Vec<ApiIssue> = response
            .json()
            .await
            .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse issues: {}", e)))?;

        fetches += 1;
        // The raw page length decides whether GitHub has more; the filtered
        // length decides whether this page is worth showing to the user.
        let raw_len = issues.len();

        // Filter out pull requests (they appear in issues API)
        collected.extend(
            issues
                .into_iter()
                .filter(|i| i.pull_request.is_none())
                .map(|issue| IssueSummary {
                    number: issue.number,
                    title: issue.title,
                    state: issue.state,
                    user: GitHubUser {
                        login: issue.user.login,
                        id: issue.user.id,
                        avatar_url: issue.user.avatar_url,
                        name: issue.user.name,
                        email: issue.user.email,
                    },
                    labels: issue
                        .labels
                        .into_iter()
                        .map(|l| Label {
                            id: l.id,
                            name: l.name,
                            color: l.color,
                            description: l.description,
                        })
                        .collect(),
                    assignees: issue
                        .assignees
                        .into_iter()
                        .map(|u| GitHubUser {
                            login: u.login,
                            id: u.id,
                            avatar_url: u.avatar_url,
                            name: u.name,
                            email: u.email,
                        })
                        .collect(),
                    comments: issue.comments,
                    created_at: issue.created_at,
                    updated_at: issue.updated_at,
                    closed_at: issue.closed_at,
                    html_url: issue.html_url,
                    body: issue.body,
                }),
        );

        match next_page_after(current, raw_len, per_page) {
            Some(n) if should_fetch_more_issues(collected.len(), per_page, fetches) => current = n,
            next => break next,
        }
    };

    Ok(IssuePage {
        issues: collected,
        next_page,
    })
}

/// Get issue details
#[command]
pub async fn get_issue(
    owner: String,
    repo: String,
    number: u32,
    token: Option<String>,
) -> Result<IssueSummary> {
    let token = resolve_github_token(token).await?;

    let client = reqwest::Client::new();
    let response = client
        .get(format!(
            "{}/repos/{}/{}/issues/{}",
            GITHUB_API_BASE, owner, repo, number
        ))
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "Gitnado-Git-Client")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to fetch issue: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitHub API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiIssue {
        number: u32,
        title: String,
        state: String,
        user: ApiUser,
        labels: Vec<ApiLabel>,
        assignees: Vec<ApiUser>,
        comments: u32,
        created_at: String,
        updated_at: String,
        closed_at: Option<String>,
        html_url: String,
        body: Option<String>,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        login: String,
        id: u64,
        avatar_url: String,
        name: Option<String>,
        email: Option<String>,
    }

    #[derive(Deserialize)]
    struct ApiLabel {
        id: u64,
        name: String,
        color: String,
        description: Option<String>,
    }

    let issue: ApiIssue = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse issue: {}", e)))?;

    Ok(IssueSummary {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        user: GitHubUser {
            login: issue.user.login,
            id: issue.user.id,
            avatar_url: issue.user.avatar_url,
            name: issue.user.name,
            email: issue.user.email,
        },
        labels: issue
            .labels
            .into_iter()
            .map(|l| Label {
                id: l.id,
                name: l.name,
                color: l.color,
                description: l.description,
            })
            .collect(),
        assignees: issue
            .assignees
            .into_iter()
            .map(|u| GitHubUser {
                login: u.login,
                id: u.id,
                avatar_url: u.avatar_url,
                name: u.name,
                email: u.email,
            })
            .collect(),
        comments: issue.comments,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        closed_at: issue.closed_at,
        html_url: issue.html_url,
        body: issue.body,
    })
}

/// Create a new issue
#[command]
pub async fn create_issue(
    owner: String,
    repo: String,
    input: CreateIssueInput,
    token: Option<String>,
) -> Result<IssueSummary> {
    let token = resolve_github_token(token).await?;

    #[derive(Serialize)]
    struct CreateIssueBody {
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        body: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        labels: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        assignees: Option<Vec<String>>,
    }

    let body = CreateIssueBody {
        title: input.title,
        body: input.body,
        labels: input.labels,
        assignees: input.assignees,
    };

    let client = reqwest::Client::new();
    let response = client
        .post(format!(
            "{}/repos/{}/{}/issues",
            GITHUB_API_BASE, owner, repo
        ))
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "Gitnado-Git-Client")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&body)
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to create issue: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitHub API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiIssue {
        number: u32,
        title: String,
        state: String,
        user: ApiUser,
        labels: Vec<ApiLabel>,
        assignees: Vec<ApiUser>,
        comments: u32,
        created_at: String,
        updated_at: String,
        closed_at: Option<String>,
        html_url: String,
        body: Option<String>,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        login: String,
        id: u64,
        avatar_url: String,
        name: Option<String>,
        email: Option<String>,
    }

    #[derive(Deserialize)]
    struct ApiLabel {
        id: u64,
        name: String,
        color: String,
        description: Option<String>,
    }

    let issue: ApiIssue = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse issue: {}", e)))?;

    Ok(IssueSummary {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        user: GitHubUser {
            login: issue.user.login,
            id: issue.user.id,
            avatar_url: issue.user.avatar_url,
            name: issue.user.name,
            email: issue.user.email,
        },
        labels: issue
            .labels
            .into_iter()
            .map(|l| Label {
                id: l.id,
                name: l.name,
                color: l.color,
                description: l.description,
            })
            .collect(),
        assignees: issue
            .assignees
            .into_iter()
            .map(|u| GitHubUser {
                login: u.login,
                id: u.id,
                avatar_url: u.avatar_url,
                name: u.name,
                email: u.email,
            })
            .collect(),
        comments: issue.comments,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        closed_at: issue.closed_at,
        html_url: issue.html_url,
        body: issue.body,
    })
}

/// Update issue state (open/close)
#[command]
pub async fn update_issue_state(
    owner: String,
    repo: String,
    number: u32,
    state: String,
    token: Option<String>,
) -> Result<IssueSummary> {
    let token = resolve_github_token(token).await?;

    #[derive(Serialize)]
    struct UpdateBody {
        state: String,
    }

    let client = reqwest::Client::new();
    let response = client
        .patch(format!(
            "{}/repos/{}/{}/issues/{}",
            GITHUB_API_BASE, owner, repo, number
        ))
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "Gitnado-Git-Client")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&UpdateBody { state })
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to update issue: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitHub API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiIssue {
        number: u32,
        title: String,
        state: String,
        user: ApiUser,
        labels: Vec<ApiLabel>,
        assignees: Vec<ApiUser>,
        comments: u32,
        created_at: String,
        updated_at: String,
        closed_at: Option<String>,
        html_url: String,
        body: Option<String>,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        login: String,
        id: u64,
        avatar_url: String,
        name: Option<String>,
        email: Option<String>,
    }

    #[derive(Deserialize)]
    struct ApiLabel {
        id: u64,
        name: String,
        color: String,
        description: Option<String>,
    }

    let issue: ApiIssue = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse issue: {}", e)))?;

    Ok(IssueSummary {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        user: GitHubUser {
            login: issue.user.login,
            id: issue.user.id,
            avatar_url: issue.user.avatar_url,
            name: issue.user.name,
            email: issue.user.email,
        },
        labels: issue
            .labels
            .into_iter()
            .map(|l| Label {
                id: l.id,
                name: l.name,
                color: l.color,
                description: l.description,
            })
            .collect(),
        assignees: issue
            .assignees
            .into_iter()
            .map(|u| GitHubUser {
                login: u.login,
                id: u.id,
                avatar_url: u.avatar_url,
                name: u.name,
                email: u.email,
            })
            .collect(),
        comments: issue.comments,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        closed_at: issue.closed_at,
        html_url: issue.html_url,
        body: issue.body,
    })
}

/// Get issue comments
#[command]
pub async fn get_issue_comments(
    owner: String,
    repo: String,
    number: u32,
    per_page: Option<u32>,
    token: Option<String>,
) -> Result<Vec<IssueComment>> {
    let token = resolve_github_token(token).await?;

    let per_page = per_page.unwrap_or(30);

    let client = reqwest::Client::new();
    let response = client
        .get(format!(
            "{}/repos/{}/{}/issues/{}/comments",
            GITHUB_API_BASE, owner, repo, number
        ))
        .query(&[("per_page", per_page.to_string())])
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "Gitnado-Git-Client")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to fetch comments: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitHub API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiComment {
        id: u64,
        user: ApiUser,
        body: String,
        created_at: String,
        updated_at: String,
        html_url: String,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        login: String,
        id: u64,
        avatar_url: String,
        name: Option<String>,
        email: Option<String>,
    }

    let comments: Vec<ApiComment> = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse comments: {}", e)))?;

    Ok(comments
        .into_iter()
        .map(|c| IssueComment {
            id: c.id,
            user: GitHubUser {
                login: c.user.login,
                id: c.user.id,
                avatar_url: c.user.avatar_url,
                name: c.user.name,
                email: c.user.email,
            },
            body: c.body,
            created_at: c.created_at,
            updated_at: c.updated_at,
            html_url: c.html_url,
        })
        .collect())
}

/// Add a comment to an issue
#[command]
pub async fn add_issue_comment(
    owner: String,
    repo: String,
    number: u32,
    body: String,
    token: Option<String>,
) -> Result<IssueComment> {
    let token = resolve_github_token(token).await?;

    #[derive(Serialize)]
    struct CommentBody {
        body: String,
    }

    let client = reqwest::Client::new();
    let response = client
        .post(format!(
            "{}/repos/{}/{}/issues/{}/comments",
            GITHUB_API_BASE, owner, repo, number
        ))
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "Gitnado-Git-Client")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&CommentBody { body })
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to add comment: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitHub API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiComment {
        id: u64,
        user: ApiUser,
        body: String,
        created_at: String,
        updated_at: String,
        html_url: String,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        login: String,
        id: u64,
        avatar_url: String,
        name: Option<String>,
        email: Option<String>,
    }

    let comment: ApiComment = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse comment: {}", e)))?;

    Ok(IssueComment {
        id: comment.id,
        user: GitHubUser {
            login: comment.user.login,
            id: comment.user.id,
            avatar_url: comment.user.avatar_url,
            name: comment.user.name,
            email: comment.user.email,
        },
        body: comment.body,
        created_at: comment.created_at,
        updated_at: comment.updated_at,
        html_url: comment.html_url,
    })
}

/// Get repository labels
///
/// The label picker this feeds has no paging of its own, so a repository with
/// more labels than one API page would silently lose the rest. The command
/// collects the pages itself, bounded by `MAX_LABEL_PAGE_FETCHES`.
#[command]
pub async fn get_repo_labels(
    owner: String,
    repo: String,
    per_page: Option<u32>,
    token: Option<String>,
) -> Result<Vec<Label>> {
    let token = resolve_github_token(token).await?;

    let per_page = per_page.unwrap_or(100);

    #[derive(Deserialize)]
    struct ApiLabel {
        id: u64,
        name: String,
        color: String,
        description: Option<String>,
    }

    let client = reqwest::Client::new();
    let mut current = 1u32;
    let mut fetches = 0u32;
    let mut labels: Vec<Label> = Vec::new();

    loop {
        let response = client
            .get(format!(
                "{}/repos/{}/{}/labels",
                GITHUB_API_BASE, owner, repo
            ))
            .query(&pagination_query(per_page, Some(current)))
            .header("Authorization", format!("Bearer {}", token))
            .header("User-Agent", "Gitnado-Git-Client")
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .await
            .map_err(|e| GitnadoError::OperationFailed(format!("Failed to fetch labels: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(GitnadoError::OperationFailed(format!(
                "GitHub API error {}: {}",
                status, body
            )));
        }

        let raw: Vec<ApiLabel> = response
            .json()
            .await
            .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse labels: {}", e)))?;

        fetches += 1;
        let raw_len = raw.len();
        labels.extend(raw.into_iter().map(|l| Label {
            id: l.id,
            name: l.name,
            color: l.color,
            description: l.description,
        }));

        match next_page_after(current, raw_len, per_page) {
            Some(n) if fetches < MAX_LABEL_PAGE_FETCHES => current = n,
            _ => break,
        }
    }

    Ok(labels)
}

// ============================================================================
// Release Types
// ============================================================================

/// GitHub release summary
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseSummary {
    pub id: u64,
    pub tag_name: String,
    pub name: Option<String>,
    pub body: Option<String>,
    pub draft: bool,
    pub prerelease: bool,
    pub created_at: String,
    pub published_at: Option<String>,
    pub html_url: String,
    pub author: GitHubUser,
    pub assets_count: usize,
}

/// Release asset
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseAsset {
    pub id: u64,
    pub name: String,
    pub label: Option<String>,
    pub content_type: String,
    pub size: u64,
    pub download_count: u64,
    pub browser_download_url: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Create release input
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateReleaseInput {
    pub tag_name: String,
    pub target_commitish: Option<String>,
    pub name: Option<String>,
    pub body: Option<String>,
    pub draft: Option<bool>,
    pub prerelease: Option<bool>,
    pub generate_release_notes: Option<bool>,
}

// ============================================================================
// Release Commands
// ============================================================================

/// List releases for a repository
#[command]
pub async fn list_releases(
    owner: String,
    repo: String,
    per_page: Option<u32>,
    page: Option<u32>,
    token: Option<String>,
) -> Result<Vec<ReleaseSummary>> {
    let token = resolve_github_token(token).await?;

    let per_page = per_page.unwrap_or(30);

    let client = reqwest::Client::new();
    let response = client
        .get(format!(
            "{}/repos/{}/{}/releases",
            GITHUB_API_BASE, owner, repo
        ))
        .query(&pagination_query(per_page, page))
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "Gitnado-Git-Client")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to fetch releases: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitHub API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiRelease {
        id: u64,
        tag_name: String,
        name: Option<String>,
        body: Option<String>,
        draft: bool,
        prerelease: bool,
        created_at: String,
        published_at: Option<String>,
        html_url: String,
        author: ApiUser,
        assets: Vec<serde_json::Value>,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        login: String,
        id: u64,
        avatar_url: String,
        name: Option<String>,
        email: Option<String>,
    }

    let releases: Vec<ApiRelease> = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse releases: {}", e)))?;

    Ok(releases
        .into_iter()
        .map(|r| ReleaseSummary {
            id: r.id,
            tag_name: r.tag_name,
            name: r.name,
            body: r.body,
            draft: r.draft,
            prerelease: r.prerelease,
            created_at: r.created_at,
            published_at: r.published_at,
            html_url: r.html_url,
            author: GitHubUser {
                login: r.author.login,
                id: r.author.id,
                avatar_url: r.author.avatar_url,
                name: r.author.name,
                email: r.author.email,
            },
            assets_count: r.assets.len(),
        })
        .collect())
}

/// Get release by tag
#[command]
pub async fn get_release_by_tag(
    owner: String,
    repo: String,
    tag: String,
    token: Option<String>,
) -> Result<ReleaseSummary> {
    let token = resolve_github_token(token).await?;

    let client = reqwest::Client::new();
    let response = client
        .get(format!(
            "{}/repos/{}/{}/releases/tags/{}",
            GITHUB_API_BASE, owner, repo, tag
        ))
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "Gitnado-Git-Client")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to fetch release: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitHub API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiRelease {
        id: u64,
        tag_name: String,
        name: Option<String>,
        body: Option<String>,
        draft: bool,
        prerelease: bool,
        created_at: String,
        published_at: Option<String>,
        html_url: String,
        author: ApiUser,
        assets: Vec<serde_json::Value>,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        login: String,
        id: u64,
        avatar_url: String,
        name: Option<String>,
        email: Option<String>,
    }

    let release: ApiRelease = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse release: {}", e)))?;

    Ok(ReleaseSummary {
        id: release.id,
        tag_name: release.tag_name,
        name: release.name,
        body: release.body,
        draft: release.draft,
        prerelease: release.prerelease,
        created_at: release.created_at,
        published_at: release.published_at,
        html_url: release.html_url,
        author: GitHubUser {
            login: release.author.login,
            id: release.author.id,
            avatar_url: release.author.avatar_url,
            name: release.author.name,
            email: release.author.email,
        },
        assets_count: release.assets.len(),
    })
}

/// Get latest release
#[command]
pub async fn get_latest_release(
    owner: String,
    repo: String,
    token: Option<String>,
) -> Result<ReleaseSummary> {
    let token = resolve_github_token(token).await?;

    let client = reqwest::Client::new();
    let response = client
        .get(format!(
            "{}/repos/{}/{}/releases/latest",
            GITHUB_API_BASE, owner, repo
        ))
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "Gitnado-Git-Client")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to fetch latest release: {}", e))
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitHub API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiRelease {
        id: u64,
        tag_name: String,
        name: Option<String>,
        body: Option<String>,
        draft: bool,
        prerelease: bool,
        created_at: String,
        published_at: Option<String>,
        html_url: String,
        author: ApiUser,
        assets: Vec<serde_json::Value>,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        login: String,
        id: u64,
        avatar_url: String,
        name: Option<String>,
        email: Option<String>,
    }

    let release: ApiRelease = response.json().await.map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse latest release: {}", e))
    })?;

    Ok(ReleaseSummary {
        id: release.id,
        tag_name: release.tag_name,
        name: release.name,
        body: release.body,
        draft: release.draft,
        prerelease: release.prerelease,
        created_at: release.created_at,
        published_at: release.published_at,
        html_url: release.html_url,
        author: GitHubUser {
            login: release.author.login,
            id: release.author.id,
            avatar_url: release.author.avatar_url,
            name: release.author.name,
            email: release.author.email,
        },
        assets_count: release.assets.len(),
    })
}

/// Create a new release
#[command]
pub async fn create_release(
    owner: String,
    repo: String,
    input: CreateReleaseInput,
    token: Option<String>,
) -> Result<ReleaseSummary> {
    let token = resolve_github_token(token).await?;

    #[derive(Serialize)]
    struct CreateReleaseBody {
        tag_name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_commitish: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        body: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        draft: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        prerelease: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        generate_release_notes: Option<bool>,
    }

    let body = CreateReleaseBody {
        tag_name: input.tag_name,
        target_commitish: input.target_commitish,
        name: input.name,
        body: input.body,
        draft: input.draft,
        prerelease: input.prerelease,
        generate_release_notes: input.generate_release_notes,
    };

    let client = reqwest::Client::new();
    let response = client
        .post(format!(
            "{}/repos/{}/{}/releases",
            GITHUB_API_BASE, owner, repo
        ))
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "Gitnado-Git-Client")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&body)
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to create release: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitHub API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiRelease {
        id: u64,
        tag_name: String,
        name: Option<String>,
        body: Option<String>,
        draft: bool,
        prerelease: bool,
        created_at: String,
        published_at: Option<String>,
        html_url: String,
        author: ApiUser,
        assets: Vec<serde_json::Value>,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        login: String,
        id: u64,
        avatar_url: String,
        name: Option<String>,
        email: Option<String>,
    }

    let release: ApiRelease = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse release: {}", e)))?;

    Ok(ReleaseSummary {
        id: release.id,
        tag_name: release.tag_name,
        name: release.name,
        body: release.body,
        draft: release.draft,
        prerelease: release.prerelease,
        created_at: release.created_at,
        published_at: release.published_at,
        html_url: release.html_url,
        author: GitHubUser {
            login: release.author.login,
            id: release.author.id,
            avatar_url: release.author.avatar_url,
            name: release.author.name,
            email: release.author.email,
        },
        assets_count: release.assets.len(),
    })
}

/// Delete a release
#[command]
pub async fn delete_release(
    owner: String,
    repo: String,
    release_id: u64,
    token: Option<String>,
) -> Result<()> {
    let token = resolve_github_token(token).await?;

    let client = reqwest::Client::new();
    let response = client
        .delete(format!(
            "{}/repos/{}/{}/releases/{}",
            GITHUB_API_BASE, owner, repo, release_id
        ))
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "Gitnado-Git-Client")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to delete release: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitHub API error {}: {}",
            status, body
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // GitHubUser Parsing Tests
    // ========================================================================

    #[test]
    fn test_parse_github_user_full() {
        let json = r#"{
            "login": "octocat",
            "id": 12345,
            "avatar_url": "https://avatars.githubusercontent.com/u/12345",
            "name": "The Octocat",
            "email": "octocat@github.com"
        }"#;

        let user: GitHubUser = serde_json::from_str(json).expect("Failed to parse user");

        assert_eq!(user.login, "octocat");
        assert_eq!(user.id, 12345);
        assert_eq!(
            user.avatar_url,
            "https://avatars.githubusercontent.com/u/12345"
        );
        assert_eq!(user.name, Some("The Octocat".to_string()));
        assert_eq!(user.email, Some("octocat@github.com".to_string()));
    }

    #[test]
    fn test_parse_github_user_minimal() {
        let json = r#"{
            "login": "octocat",
            "id": 12345,
            "avatar_url": "https://avatars.githubusercontent.com/u/12345"
        }"#;

        let user: GitHubUser = serde_json::from_str(json).expect("Failed to parse user");

        assert_eq!(user.login, "octocat");
        assert_eq!(user.id, 12345);
        assert_eq!(
            user.avatar_url,
            "https://avatars.githubusercontent.com/u/12345"
        );
        assert_eq!(user.name, None);
        assert_eq!(user.email, None);
    }

    #[test]
    fn test_parse_github_user_null_optionals() {
        let json = r#"{
            "login": "octocat",
            "id": 12345,
            "avatar_url": "https://avatars.githubusercontent.com/u/12345",
            "name": null,
            "email": null
        }"#;

        let user: GitHubUser = serde_json::from_str(json).expect("Failed to parse user");

        assert_eq!(user.login, "octocat");
        assert_eq!(user.name, None);
        assert_eq!(user.email, None);
    }

    #[test]
    fn test_github_user_serializes_avatar_url_as_camel_case() {
        let user = GitHubUser {
            login: "octocat".to_string(),
            id: 12345,
            avatar_url: "https://example.com/avatar.png".to_string(),
            name: Some("Test User".to_string()),
            email: None,
        };

        let json = serde_json::to_string(&user).expect("Failed to serialize user");

        // Should serialize as avatarUrl for frontend
        assert!(json.contains("avatarUrl"));
        assert!(!json.contains("avatar_url"));
    }

    // ========================================================================
    // GitHubConnectionStatus Tests
    // ========================================================================

    #[test]
    fn test_connection_status_connected() {
        let status = GitHubConnectionStatus {
            connected: true,
            user: Some(GitHubUser {
                login: "octocat".to_string(),
                id: 12345,
                avatar_url: "https://example.com/avatar.png".to_string(),
                name: Some("The Octocat".to_string()),
                email: None,
            }),
            scopes: vec!["repo".to_string(), "read:user".to_string()],
        };

        assert!(status.connected);
        assert!(status.user.is_some());
        assert_eq!(status.scopes.len(), 2);
    }

    #[test]
    fn test_connection_status_disconnected() {
        let status = GitHubConnectionStatus {
            connected: false,
            user: None,
            scopes: vec![],
        };

        assert!(!status.connected);
        assert!(status.user.is_none());
        assert!(status.scopes.is_empty());
    }

    // ========================================================================
    // List Pagination Tests
    // ========================================================================

    /// Every list request must carry a `page` param; with no page asked for it
    /// is the first one.
    #[test]
    fn test_pagination_query_defaults_to_first_page() {
        let query = pagination_query(30, None);
        assert_eq!(query[0], ("per_page", "30".to_string()));
        assert_eq!(query[1], ("page", "1".to_string()));
    }

    /// A requested page reaches the API verbatim — that is what makes page 2
    /// of a list reachable at all.
    #[test]
    fn test_pagination_query_uses_requested_page() {
        let query = pagination_query(30, Some(4));
        assert_eq!(query[1], ("page", "4".to_string()));
    }

    /// GitHub pages are 1-based; page 0 would silently repeat page 1, so it is
    /// clamped instead of forwarded.
    #[test]
    fn test_pagination_query_clamps_zero_to_first_page() {
        let query = pagination_query(30, Some(0));
        assert_eq!(query[1], ("page", "1".to_string()));
    }

    /// A full page means GitHub may hold more, so the list continues.
    #[test]
    fn test_next_page_after_full_page_continues() {
        assert_eq!(next_page_after(2, 30, 30), Some(3));
    }

    /// A short page is the end of the list — no further request, and no
    /// "Load more" offered to the user.
    #[test]
    fn test_next_page_after_short_page_ends_list() {
        assert_eq!(next_page_after(2, 12, 30), None);
        assert_eq!(next_page_after(1, 0, 30), None);
    }

    /// A `per_page` of zero must not loop forever on empty pages.
    #[test]
    fn test_next_page_after_zero_per_page_ends_list() {
        assert_eq!(next_page_after(1, 0, 0), None);
    }

    /// The issue undercount: an API page made up entirely of pull requests
    /// leaves zero issues collected. Stopping there is what rendered
    /// "No open issues" for a repository that has them.
    #[test]
    fn test_should_fetch_more_issues_when_page_held_only_pull_requests() {
        assert!(should_fetch_more_issues(0, 30, 1));
    }

    /// Once a full page of real issues is collected the walk stops.
    #[test]
    fn test_should_fetch_more_issues_stops_once_page_is_full() {
        assert!(!should_fetch_more_issues(30, 30, 1));
    }

    /// A repository of nothing but pull requests must not walk forever.
    #[test]
    fn test_should_fetch_more_issues_stops_at_request_budget() {
        assert!(!should_fetch_more_issues(0, 30, MAX_ISSUE_PAGE_FETCHES));
    }

    /// The issue page cursor crosses the Tauri boundary as camelCase, like
    /// every other field the frontend reads.
    #[test]
    fn test_issue_page_serializes_next_page_as_camel_case() {
        let page = IssuePage {
            issues: vec![],
            next_page: Some(2),
        };

        let json = serde_json::to_string(&page).expect("serialize failed");
        assert!(json.contains("\"nextPage\":2"), "unexpected json: {}", json);
        assert!(
            !json.contains("next_page"),
            "unexpected snake_case: {}",
            json
        );
    }

    /// Credential selection is scoped to the remote the operation actually
    /// targets, so detection must answer for THAT remote — not for whichever
    /// one happens to sort first. Without the filter a fetch of `upstream`
    /// resolved `origin`'s account.
    #[tokio::test]
    async fn test_detect_github_repo_targets_requested_remote() {
        use crate::test_utils::TestRepo;

        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://github.com/personal/repo.git");
        repo.add_remote("upstream", "https://github.com/work/repo.git");

        let detected = detect_github_repo(repo.path_str(), Some("upstream".to_string()))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(detected.owner, "work");
        assert_eq!(detected.remote_name, "upstream");
    }

    // ========================================================================
    // GitHub URL Parsing Tests
    // ========================================================================

    #[test]
    fn test_parse_github_url_https() {
        let result = parse_github_url("https://github.com/owner/repo.git");
        assert!(result.is_some());
        let (owner, repo) = result.unwrap();
        assert_eq!(owner, "owner");
        assert_eq!(repo, "repo");
    }

    #[test]
    fn test_parse_github_url_https_no_git_suffix() {
        let result = parse_github_url("https://github.com/owner/repo");
        assert!(result.is_some());
        let (owner, repo) = result.unwrap();
        assert_eq!(owner, "owner");
        assert_eq!(repo, "repo");
    }

    #[test]
    fn test_parse_github_url_ssh() {
        let result = parse_github_url("git@github.com:owner/repo.git");
        assert!(result.is_some());
        let (owner, repo) = result.unwrap();
        assert_eq!(owner, "owner");
        assert_eq!(repo, "repo");
    }

    #[test]
    fn test_parse_github_url_ssh_no_git_suffix() {
        let result = parse_github_url("git@github.com:owner/repo");
        assert!(result.is_some());
        let (owner, repo) = result.unwrap();
        assert_eq!(owner, "owner");
        assert_eq!(repo, "repo");
    }

    #[test]
    fn test_parse_github_url_not_github() {
        let result = parse_github_url("https://gitlab.com/owner/repo.git");
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_github_url_invalid() {
        let result = parse_github_url("not-a-valid-url");
        assert!(result.is_none());
    }

    // ========================================================================
    // GitHub App Config Serialization Tests (M1)
    // ========================================================================

    /// Round-trip: serialise then deserialise should produce identical values.
    #[test]
    fn test_app_config_roundtrip() {
        let original = StoredGithubAppConfig {
            app_id: 123456,
            installation_id: 987654,
            private_key_pem:
                "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQ\n-----END RSA PRIVATE KEY-----"
                    .to_string(),
        };

        let json = serialize_app_config(&original).expect("serialize failed");

        // The private key must be present in the serialized form (it's stored
        // in the keyring secret, not exposed to the frontend).
        assert!(json.contains("privateKeyPem"));
        assert!(json.contains("appId"));
        assert!(json.contains("installationId"));

        let restored = deserialize_app_config(&json).expect("deserialize failed");
        assert_eq!(restored.app_id, original.app_id);
        assert_eq!(restored.installation_id, original.installation_id);
        assert_eq!(restored.private_key_pem, original.private_key_pem);
    }

    /// Verify that `serialize_app_config` uses camelCase keys (serde rename_all).
    #[test]
    fn test_app_config_serializes_camel_case() {
        let cfg = StoredGithubAppConfig {
            app_id: 1,
            installation_id: 2,
            private_key_pem: "key".to_string(),
        };

        let json = serialize_app_config(&cfg).expect("serialize failed");
        let v: serde_json::Value = serde_json::from_str(&json).expect("parse failed");

        // camelCase keys must be present
        assert!(v.get("appId").is_some(), "expected appId key");
        assert!(
            v.get("installationId").is_some(),
            "expected installationId key"
        );
        assert!(
            v.get("privateKeyPem").is_some(),
            "expected privateKeyPem key"
        );

        // snake_case keys must NOT be present
        assert!(v.get("app_id").is_none(), "unexpected app_id key");
        assert!(
            v.get("installation_id").is_none(),
            "unexpected installation_id key"
        );
        assert!(
            v.get("private_key_pem").is_none(),
            "unexpected private_key_pem key"
        );
    }

    /// Deserializing invalid JSON must return an Err, not panic.
    #[test]
    fn test_app_config_deserialize_invalid_json() {
        let result = deserialize_app_config("this is not json");
        assert!(result.is_err(), "expected error for invalid JSON");
    }

    /// Deserializing JSON that is missing required fields must return an Err.
    #[test]
    fn test_app_config_deserialize_missing_fields() {
        let result = deserialize_app_config(r#"{"appId": 1}"#);
        assert!(result.is_err(), "expected error for incomplete JSON");
    }

    /// The keyring key constant must follow the expected naming pattern.
    #[test]
    fn test_github_app_keyring_key_format() {
        // The key must not contain characters that could cause keyring injection
        // (spaces, quotes, control chars etc.).
        assert!(!GITHUB_APP_KEYRING_KEY.is_empty());
        for ch in GITHUB_APP_KEYRING_KEY.chars() {
            assert!(
                ch.is_ascii_alphanumeric() || ch == '_',
                "unexpected char {:?} in GITHUB_APP_KEYRING_KEY",
                ch
            );
        }
    }
}

// ========================================================================
// GitHub App Installation Commands
// ========================================================================

/// Keyring key used to store the GitHub App configuration JSON.
///
/// A single key is used (no per-app-id sharding) because Gitnado supports
/// at most one GitHub App installation at a time.  The stored value is a JSON
/// object containing `appId`, `installationId`, and `privateKeyPem`.
const GITHUB_APP_KEYRING_KEY: &str = "github_app_config";

/// Serialised form of the GitHub App configuration that is persisted to the
/// system keyring.  The private key PEM is stored in the secret value; the
/// app/installation IDs travel with it so we can reconstruct the full config
/// on retrieval.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredGithubAppConfig {
    app_id: u64,
    installation_id: u64,
    private_key_pem: String,
}

/// Serialise `StoredGithubAppConfig` to a JSON string for keyring storage.
fn serialize_app_config(cfg: &StoredGithubAppConfig) -> Result<String> {
    serde_json::to_string(cfg).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to serialize GitHub App config: {}", e))
    })
}

/// Deserialise `StoredGithubAppConfig` from a JSON string retrieved from the keyring.
fn deserialize_app_config(json: &str) -> Result<StoredGithubAppConfig> {
    serde_json::from_str(json).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to deserialize GitHub App config: {}", e))
    })
}

/// Configure a GitHub App for authentication.
///
/// M1: After validating `private_key_pem` by generating a JWT and exchanging
/// it for an installation token, the full config (`app_id`, `installation_id`,
/// `private_key_pem`) is persisted to the system keyring so that subsequent
/// calls to `get_github_app_config` can confirm the connection is live.
#[command]
pub async fn configure_github_app(
    app_id: u64,
    private_key_pem: String,
    installation_id: u64,
) -> Result<GitHubConnectionStatus> {
    use crate::commands::credentials::{delete_keyring_token, store_keyring_token};
    use crate::services::github_app;

    // Generate JWT to validate the key
    let jwt = github_app::generate_jwt(app_id, &private_key_pem)
        .map_err(GitnadoError::OperationFailed)?;

    // Get an installation token to verify it works
    let token = github_app::get_installation_token(&jwt, installation_id)
        .await
        .map_err(GitnadoError::OperationFailed)?;

    // Verify the token works by checking connection
    let client = reqwest::Client::new();
    let response = client
        .get(format!(
            "{}/installation/repositories?per_page=1",
            GITHUB_API_BASE
        ))
        .header("Authorization", format!("Bearer {}", token.token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Gitnado-Git-Client")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Connection test failed: {}", e)))?;

    if !response.status().is_success() {
        return Err(GitnadoError::OperationFailed(
            "Installation token verification failed".to_string(),
        ));
    }

    // M1: Persist the app config to the system keyring.
    // Remove any pre-existing entry first (idempotent reconfigure).
    let _ = delete_keyring_token(GITHUB_APP_KEYRING_KEY.to_string()).await;

    let stored = StoredGithubAppConfig {
        app_id,
        installation_id,
        private_key_pem,
    };
    let json = serialize_app_config(&stored)?;
    store_keyring_token(GITHUB_APP_KEYRING_KEY.to_string(), json).await?;

    tracing::info!(
        "GitHub App {} (installation {}) persisted to keyring",
        app_id,
        installation_id
    );

    Ok(GitHubConnectionStatus {
        connected: true,
        user: None,
        scopes: vec!["app-installation".to_string()],
    })
}

/// Get the current GitHub App configuration (without the private key).
///
/// M1: Returns `Ok(Some(..))` only when a config has actually been persisted
/// via `configure_github_app`, so the UI can distinguish "connected" from
/// "never configured".  The private key is deliberately excluded from the
/// returned JSON.
#[command]
pub async fn get_github_app_config() -> Result<Option<serde_json::Value>> {
    use crate::commands::credentials::get_keyring_token;

    let raw = match get_keyring_token(GITHUB_APP_KEYRING_KEY.to_string()).await? {
        Some(s) => s,
        None => return Ok(None),
    };

    let cfg = deserialize_app_config(&raw)?;

    // Return only the non-secret fields so the private key never leaves
    // the backend.
    let public_config = serde_json::json!({
        "appId": cfg.app_id,
        "installationId": cfg.installation_id,
    });

    Ok(Some(public_config))
}

/// Remove GitHub App configuration from the system keyring.
///
/// M1: After this call `get_github_app_config` will return `Ok(None)`.
#[command]
pub async fn remove_github_app_config() -> Result<()> {
    use crate::commands::credentials::delete_keyring_token;

    delete_keyring_token(GITHUB_APP_KEYRING_KEY.to_string()).await?;
    tracing::info!("GitHub App config removed from keyring");
    Ok(())
}

/// List all installations for a GitHub App
#[command]
pub async fn list_github_app_installations(
    app_id: u64,
    private_key_pem: String,
) -> Result<Vec<crate::services::github_app::AppInstallation>> {
    use crate::services::github_app;

    let jwt = github_app::generate_jwt(app_id, &private_key_pem)
        .map_err(GitnadoError::OperationFailed)?;

    github_app::list_installations(&jwt)
        .await
        .map_err(GitnadoError::OperationFailed)
}
