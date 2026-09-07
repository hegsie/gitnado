//! GitLab Integration Commands
//!
//! Provides integration with GitLab for merge requests, issues, and pipelines.
//! Token storage is handled by the frontend credential service (OS keyring).
//! All API functions accept an optional token parameter from the frontend.

use crate::error::{GitnadoError, Result};
use serde::{Deserialize, Serialize};
use tauri::command;

const GITLAB_API_VERSION: &str = "v4";

/// Helper to resolve token from parameter
/// Returns an error if no token is provided
fn resolve_token(token: Option<String>) -> Result<String> {
    match token {
        Some(t) if !t.is_empty() => Ok(t),
        _ => Err(GitnadoError::OperationFailed(
            "GitLab token not configured".to_string(),
        )),
    }
}

/// Helper to make authenticated GitLab API GET requests
/// Tries Bearer auth first (for OAuth tokens), falls back to PRIVATE-TOKEN (for PATs)
async fn gitlab_get(url: &str, token: &str) -> Result<reqwest::Response> {
    let client = reqwest::Client::new();

    // Try Bearer auth first (for OAuth tokens)
    let response = client
        .get(url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Request failed: {}", e)))?;

    // If Bearer auth fails with 401, try PRIVATE-TOKEN (for PATs)
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return client
            .get(url)
            .header("PRIVATE-TOKEN", token)
            .send()
            .await
            .map_err(|e| GitnadoError::OperationFailed(format!("Request failed: {}", e)));
    }

    Ok(response)
}

/// Helper to make authenticated GitLab API POST requests
/// Tries Bearer auth first (for OAuth tokens), falls back to PRIVATE-TOKEN (for PATs)
async fn gitlab_post<T: Serialize + ?Sized>(
    url: &str,
    token: &str,
    body: &T,
) -> Result<reqwest::Response> {
    let client = reqwest::Client::new();

    // Try Bearer auth first (for OAuth tokens)
    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Request failed: {}", e)))?;

    // If Bearer auth fails with 401, try PRIVATE-TOKEN (for PATs)
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return client
            .post(url)
            .header("PRIVATE-TOKEN", token)
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|e| GitnadoError::OperationFailed(format!("Request failed: {}", e)));
    }

    Ok(response)
}

// ============================================================================
// Types
// ============================================================================

/// GitLab user info
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabUser {
    pub id: u64,
    pub username: String,
    pub name: String,
    pub avatar_url: Option<String>,
    pub web_url: String,
}

/// GitLab connection status
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabConnectionStatus {
    pub connected: bool,
    pub user: Option<GitLabUser>,
    pub instance_url: String,
}

/// Detected GitLab repository info
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedGitLabRepo {
    pub instance_url: String,
    pub project_path: String,
    pub remote_name: String,
}

/// Merge request summary
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabMergeRequest {
    pub iid: u64,
    pub title: String,
    pub description: Option<String>,
    pub state: String,
    pub author: GitLabUser,
    pub created_at: String,
    pub source_branch: String,
    pub target_branch: String,
    pub draft: bool,
    pub web_url: String,
    pub merge_status: String,
}

/// Create merge request input
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMergeRequestInput {
    pub title: String,
    pub description: Option<String>,
    pub source_branch: String,
    pub target_branch: String,
    pub draft: Option<bool>,
}

/// Issue summary
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabIssue {
    pub iid: u64,
    pub title: String,
    pub description: Option<String>,
    pub state: String,
    pub author: GitLabUser,
    pub assignees: Vec<GitLabUser>,
    pub labels: Vec<String>,
    pub created_at: String,
    pub web_url: String,
}

/// Create issue input
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGitLabIssueInput {
    pub title: String,
    pub description: Option<String>,
    pub labels: Option<Vec<String>>,
}

/// Pipeline summary
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabPipeline {
    pub id: u64,
    pub iid: u64,
    pub status: String,
    pub source: String,
    pub r#ref: String,
    pub sha: String,
    pub created_at: String,
    pub updated_at: String,
    pub web_url: String,
}

// ============================================================================
// Helper Functions
// ============================================================================

fn build_api_url(instance_url: &str, path: &str) -> String {
    let base = instance_url.trim_end_matches('/');
    format!("{}/api/{}/{}", base, GITLAB_API_VERSION, path)
}

fn url_encode(s: &str) -> String {
    urlencoding::encode(s).into_owned()
}

/// Build the `&state=<x>` query fragment for a MR/issue state filter.
///
/// GitLab's REST API returns items in *all* states when the `state` query
/// parameter is omitted. A `None` state therefore means "All" and must not
/// append any `state` param (previously this defaulted to `opened`, hiding
/// closed/merged items from the "All" filter).
fn state_query_param(state: Option<&str>) -> String {
    match state {
        Some(s) => format!("&state={}", s),
        None => String::new(),
    }
}

/// Default page size for the merge-request and issue listings.
///
/// Kept in sync with GITLAB_LIST_PAGE_SIZE in lv-gitlab-dialog.ts, which
/// discloses it to the user.
const LIST_DEFAULT_PER_PAGE: u32 = 30;

/// Default page size for the pipeline listing.
///
/// Kept in sync with GITLAB_PIPELINE_PAGE_SIZE in lv-gitlab-dialog.ts.
const PIPELINES_DEFAULT_PER_PAGE: u32 = 20;

/// Build the `per_page=<n>` query fragment for a listing.
///
/// The dialog discloses the page size it asked for ("Showing the first N ...").
/// Taking the size from the caller keeps the number the request caps at and the
/// number the hint quotes the same value, instead of two literals that drift.
fn per_page_query_param(per_page: Option<u32>, default_per_page: u32) -> String {
    format!("per_page={}", per_page.unwrap_or(default_per_page))
}

// ============================================================================
// Connection Commands
// ============================================================================

/// Check GitLab connection status
/// Supports both OAuth tokens (Bearer auth) and Personal Access Tokens (PRIVATE-TOKEN header)
#[command]
pub async fn check_gitlab_connection(
    instance_url: String,
    token: Option<String>,
) -> Result<GitLabConnectionStatus> {
    // Use provided token - no fallback to file storage
    let token = match token {
        Some(t) if !t.is_empty() => t,
        _ => {
            return Ok(GitLabConnectionStatus {
                connected: false,
                user: None,
                instance_url,
            })
        }
    };

    let client = reqwest::Client::new();
    let api_url = build_api_url(&instance_url, "user");

    // Try Bearer auth first (for OAuth tokens)
    let response = client
        .get(&api_url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to check connection: {}", e)))?;

    // If Bearer auth fails with 401, try PRIVATE-TOKEN (for PATs)
    let response = if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        tracing::debug!("Bearer auth failed, trying PRIVATE-TOKEN header");
        client
            .get(&api_url)
            .header("PRIVATE-TOKEN", &token)
            .send()
            .await
            .map_err(|e| {
                GitnadoError::OperationFailed(format!("Failed to check connection: {}", e))
            })?
    } else {
        response
    };

    if !response.status().is_success() {
        return Ok(GitLabConnectionStatus {
            connected: false,
            user: None,
            instance_url,
        });
    }

    #[derive(Deserialize)]
    struct ApiUser {
        id: u64,
        username: String,
        name: String,
        avatar_url: Option<String>,
        web_url: String,
    }

    let api_user: ApiUser = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse user data: {}", e)))?;

    Ok(GitLabConnectionStatus {
        connected: true,
        user: Some(GitLabUser {
            id: api_user.id,
            username: api_user.username,
            name: api_user.name,
            avatar_url: api_user.avatar_url,
            web_url: api_user.web_url,
        }),
        instance_url,
    })
}

/// Detect GitLab repository from git remotes
#[command]
pub async fn detect_gitlab_repo(
    path: String,
    remote_name: Option<String>,
) -> Result<Option<DetectedGitLabRepo>> {
    let repo = git2::Repository::open(&path)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to open repository: {}", e)))?;

    let remotes = repo
        .remotes()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to get remotes: {}", e)))?;

    for candidate in remotes.iter().flatten().flatten() {
        if remote_name
            .as_deref()
            .is_some_and(|wanted| wanted != candidate)
        {
            continue;
        }
        if let Ok(remote) = repo.find_remote(candidate) {
            if let Ok(url) = remote.url() {
                if let Some(repo_info) = parse_gitlab_url(url) {
                    return Ok(Some(DetectedGitLabRepo {
                        instance_url: repo_info.0,
                        project_path: repo_info.1,
                        remote_name: candidate.to_string(),
                    }));
                }
            }
        }
    }

    Ok(None)
}

fn parse_gitlab_url(url: &str) -> Option<(String, String)> {
    // GitLab URLs can be in multiple formats:
    // https://gitlab.com/{namespace}/{project}.git
    // git@gitlab.com:{namespace}/{project}.git
    // https://{custom-domain}/{namespace}/{project}.git

    // SSH format: git@gitlab.com:namespace/project.git
    if url.starts_with("git@") {
        let without_prefix = url.trim_start_matches("git@");
        if let Some(colon_pos) = without_prefix.find(':') {
            let host = &without_prefix[..colon_pos];
            let path = without_prefix[colon_pos + 1..]
                .trim_end_matches(".git")
                .to_string();

            // Check if it's a GitLab instance (gitlab.com or contains gitlab)
            if host.contains("gitlab") {
                let instance_url = format!("https://{}", host);
                return Some((instance_url, path));
            }
        }
    }

    // HTTPS format
    if url.starts_with("https://") || url.starts_with("http://") {
        let url_parsed = url::Url::parse(url).ok()?;
        let host = url_parsed.host_str()?;

        // Check if it's a GitLab instance
        if host.contains("gitlab") {
            let instance_url = format!("{}://{}", url_parsed.scheme(), host);
            let path = url_parsed
                .path()
                .trim_start_matches('/')
                .trim_end_matches(".git")
                .to_string();

            if !path.is_empty() {
                return Some((instance_url, path));
            }
        }
    }

    None
}

// ============================================================================
// Merge Request Commands
// ============================================================================

/// List merge requests for a project
#[command]
pub async fn list_gitlab_merge_requests(
    instance_url: String,
    project_path: String,
    state: Option<String>,
    per_page: Option<u32>,
    token: Option<String>,
) -> Result<Vec<GitLabMergeRequest>> {
    let token = resolve_token(token)?;

    let encoded_path = url_encode(&project_path);
    let url = format!(
        "{}?{}{}",
        build_api_url(
            &instance_url,
            &format!("projects/{}/merge_requests", encoded_path)
        ),
        per_page_query_param(per_page, LIST_DEFAULT_PER_PAGE),
        state_query_param(state.as_deref())
    );

    let response = gitlab_get(&url, &token).await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitLab API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiMR {
        iid: u64,
        title: String,
        description: Option<String>,
        state: String,
        author: ApiUser,
        created_at: String,
        source_branch: String,
        target_branch: String,
        draft: bool,
        web_url: String,
        merge_status: String,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        id: u64,
        username: String,
        name: String,
        avatar_url: Option<String>,
        web_url: String,
    }

    let mrs: Vec<ApiMR> = response.json().await.map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse merge requests: {}", e))
    })?;

    Ok(mrs
        .into_iter()
        .map(|mr| GitLabMergeRequest {
            iid: mr.iid,
            title: mr.title,
            description: mr.description,
            state: mr.state,
            author: GitLabUser {
                id: mr.author.id,
                username: mr.author.username,
                name: mr.author.name,
                avatar_url: mr.author.avatar_url,
                web_url: mr.author.web_url,
            },
            created_at: mr.created_at,
            source_branch: mr.source_branch,
            target_branch: mr.target_branch,
            draft: mr.draft,
            web_url: mr.web_url,
            merge_status: mr.merge_status,
        })
        .collect())
}

/// Get a single merge request
#[command]
pub async fn get_gitlab_merge_request(
    instance_url: String,
    project_path: String,
    mr_iid: u64,
    token: Option<String>,
) -> Result<GitLabMergeRequest> {
    let token = resolve_token(token)?;

    let encoded_path = url_encode(&project_path);
    let url = build_api_url(
        &instance_url,
        &format!("projects/{}/merge_requests/{}", encoded_path, mr_iid),
    );

    let response = gitlab_get(&url, &token).await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitLab API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiMR {
        iid: u64,
        title: String,
        description: Option<String>,
        state: String,
        author: ApiUser,
        created_at: String,
        source_branch: String,
        target_branch: String,
        draft: bool,
        web_url: String,
        merge_status: String,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        id: u64,
        username: String,
        name: String,
        avatar_url: Option<String>,
        web_url: String,
    }

    let mr: ApiMR = response.json().await.map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse merge request: {}", e))
    })?;

    Ok(GitLabMergeRequest {
        iid: mr.iid,
        title: mr.title,
        description: mr.description,
        state: mr.state,
        author: GitLabUser {
            id: mr.author.id,
            username: mr.author.username,
            name: mr.author.name,
            avatar_url: mr.author.avatar_url,
            web_url: mr.author.web_url,
        },
        created_at: mr.created_at,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        draft: mr.draft,
        web_url: mr.web_url,
        merge_status: mr.merge_status,
    })
}

/// Create a merge request
#[command]
pub async fn create_gitlab_merge_request(
    instance_url: String,
    project_path: String,
    input: CreateMergeRequestInput,
    token: Option<String>,
) -> Result<GitLabMergeRequest> {
    let token = resolve_token(token)?;

    let encoded_path = url_encode(&project_path);
    let url = build_api_url(
        &instance_url,
        &format!("projects/{}/merge_requests", encoded_path),
    );

    #[derive(Serialize)]
    struct CreateMrBody {
        source_branch: String,
        target_branch: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    }

    let mut title = input.title;
    if input.draft.unwrap_or(false) && !title.starts_with("Draft:") {
        title = format!("Draft: {}", title);
    }

    let body = CreateMrBody {
        source_branch: input.source_branch,
        target_branch: input.target_branch,
        title,
        description: input.description,
    };

    let response = gitlab_post(&url, &token, &body).await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitLab API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiMR {
        iid: u64,
        title: String,
        description: Option<String>,
        state: String,
        author: ApiUser,
        created_at: String,
        source_branch: String,
        target_branch: String,
        draft: bool,
        web_url: String,
        merge_status: String,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        id: u64,
        username: String,
        name: String,
        avatar_url: Option<String>,
        web_url: String,
    }

    let mr: ApiMR = response.json().await.map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse merge request: {}", e))
    })?;

    Ok(GitLabMergeRequest {
        iid: mr.iid,
        title: mr.title,
        description: mr.description,
        state: mr.state,
        author: GitLabUser {
            id: mr.author.id,
            username: mr.author.username,
            name: mr.author.name,
            avatar_url: mr.author.avatar_url,
            web_url: mr.author.web_url,
        },
        created_at: mr.created_at,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        draft: mr.draft,
        web_url: mr.web_url,
        merge_status: mr.merge_status,
    })
}

// ============================================================================
// Issue Commands
// ============================================================================

/// List issues for a project
#[command]
pub async fn list_gitlab_issues(
    instance_url: String,
    project_path: String,
    state: Option<String>,
    labels: Option<String>,
    per_page: Option<u32>,
    token: Option<String>,
) -> Result<Vec<GitLabIssue>> {
    let token = resolve_token(token)?;

    let encoded_path = url_encode(&project_path);
    let mut url = format!(
        "{}?{}{}",
        build_api_url(&instance_url, &format!("projects/{}/issues", encoded_path)),
        per_page_query_param(per_page, LIST_DEFAULT_PER_PAGE),
        state_query_param(state.as_deref())
    );

    if let Some(label_str) = labels {
        url.push_str(&format!("&labels={}", url_encode(&label_str)));
    }

    let response = gitlab_get(&url, &token).await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitLab API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiIssue {
        iid: u64,
        title: String,
        description: Option<String>,
        state: String,
        author: ApiUser,
        assignees: Vec<ApiUser>,
        labels: Vec<String>,
        created_at: String,
        web_url: String,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        id: u64,
        username: String,
        name: String,
        avatar_url: Option<String>,
        web_url: String,
    }

    let issues: Vec<ApiIssue> = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse issues: {}", e)))?;

    Ok(issues
        .into_iter()
        .map(|issue| GitLabIssue {
            iid: issue.iid,
            title: issue.title,
            description: issue.description,
            state: issue.state,
            author: GitLabUser {
                id: issue.author.id,
                username: issue.author.username,
                name: issue.author.name,
                avatar_url: issue.author.avatar_url,
                web_url: issue.author.web_url,
            },
            assignees: issue
                .assignees
                .into_iter()
                .map(|u| GitLabUser {
                    id: u.id,
                    username: u.username,
                    name: u.name,
                    avatar_url: u.avatar_url,
                    web_url: u.web_url,
                })
                .collect(),
            labels: issue.labels,
            created_at: issue.created_at,
            web_url: issue.web_url,
        })
        .collect())
}

/// Create an issue
#[command]
pub async fn create_gitlab_issue(
    instance_url: String,
    project_path: String,
    input: CreateGitLabIssueInput,
    token: Option<String>,
) -> Result<GitLabIssue> {
    let token = resolve_token(token)?;

    let encoded_path = url_encode(&project_path);
    let url = build_api_url(&instance_url, &format!("projects/{}/issues", encoded_path));

    #[derive(Serialize)]
    struct CreateIssueBody {
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        labels: Option<String>,
    }

    let body = CreateIssueBody {
        title: input.title,
        description: input.description,
        labels: input.labels.map(|l| l.join(",")),
    };

    let response = gitlab_post(&url, &token, &body).await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitLab API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiIssue {
        iid: u64,
        title: String,
        description: Option<String>,
        state: String,
        author: ApiUser,
        assignees: Vec<ApiUser>,
        labels: Vec<String>,
        created_at: String,
        web_url: String,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        id: u64,
        username: String,
        name: String,
        avatar_url: Option<String>,
        web_url: String,
    }

    let issue: ApiIssue = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse issue: {}", e)))?;

    Ok(GitLabIssue {
        iid: issue.iid,
        title: issue.title,
        description: issue.description,
        state: issue.state,
        author: GitLabUser {
            id: issue.author.id,
            username: issue.author.username,
            name: issue.author.name,
            avatar_url: issue.author.avatar_url,
            web_url: issue.author.web_url,
        },
        assignees: issue
            .assignees
            .into_iter()
            .map(|u| GitLabUser {
                id: u.id,
                username: u.username,
                name: u.name,
                avatar_url: u.avatar_url,
                web_url: u.web_url,
            })
            .collect(),
        labels: issue.labels,
        created_at: issue.created_at,
        web_url: issue.web_url,
    })
}

// ============================================================================
// Pipeline Commands
// ============================================================================

/// List pipelines for a project
#[command]
pub async fn list_gitlab_pipelines(
    instance_url: String,
    project_path: String,
    status: Option<String>,
    per_page: Option<u32>,
    token: Option<String>,
) -> Result<Vec<GitLabPipeline>> {
    let token = resolve_token(token)?;

    let encoded_path = url_encode(&project_path);
    let mut url = format!(
        "{}?{}&order_by=updated_at&sort=desc",
        build_api_url(
            &instance_url,
            &format!("projects/{}/pipelines", encoded_path)
        ),
        per_page_query_param(per_page, PIPELINES_DEFAULT_PER_PAGE)
    );

    if let Some(status_str) = status {
        url.push_str(&format!("&status={}", status_str));
    }

    let response = gitlab_get(&url, &token).await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitLab API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiPipeline {
        id: u64,
        iid: u64,
        status: String,
        source: String,
        #[serde(rename = "ref")]
        ref_name: String,
        sha: String,
        created_at: String,
        updated_at: String,
        web_url: String,
    }

    let pipelines: Vec<ApiPipeline> = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse pipelines: {}", e)))?;

    Ok(pipelines
        .into_iter()
        .map(|p| GitLabPipeline {
            id: p.id,
            iid: p.iid,
            status: p.status,
            source: p.source,
            r#ref: p.ref_name,
            sha: p.sha,
            created_at: p.created_at,
            updated_at: p.updated_at,
            web_url: p.web_url,
        })
        .collect())
}

/// Get project labels
#[command]
pub async fn get_gitlab_labels(
    instance_url: String,
    project_path: String,
    token: Option<String>,
) -> Result<Vec<String>> {
    let token = resolve_token(token)?;

    let encoded_path = url_encode(&project_path);
    let url = format!(
        "{}?per_page=100",
        build_api_url(&instance_url, &format!("projects/{}/labels", encoded_path))
    );

    let response = gitlab_get(&url, &token).await?;

    if !response.status().is_success() {
        // Only a missing project means "no labels"; a bad token or server error
        // must surface, not silently render an empty labels dropdown.
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(vec![]);
        }
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "GitLab API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiLabel {
        name: String,
    }

    let labels: Vec<ApiLabel> = response.json().await.unwrap_or_default();

    Ok(labels.into_iter().map(|l| l.name).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[test]
    fn test_build_api_url() {
        assert_eq!(
            build_api_url("https://gitlab.com", "user"),
            "https://gitlab.com/api/v4/user"
        );
        assert_eq!(
            build_api_url("https://gitlab.com/", "user"),
            "https://gitlab.com/api/v4/user"
        );
        assert_eq!(
            build_api_url("https://gitlab.example.com", "projects/123"),
            "https://gitlab.example.com/api/v4/projects/123"
        );
    }

    #[test]
    fn test_per_page_query_param() {
        // The caller's page size wins, so the size requested is the size the
        // dialog discloses.
        assert_eq!(per_page_query_param(Some(30), 30), "per_page=30");
        assert_eq!(per_page_query_param(Some(5), 30), "per_page=5");
        // No caller size falls back to this file's default.
        assert_eq!(per_page_query_param(None, 30), "per_page=30");
        assert_eq!(per_page_query_param(None, 20), "per_page=20");
    }

    #[test]
    fn test_state_query_param() {
        // A concrete state appends the filter.
        assert_eq!(state_query_param(Some("opened")), "&state=opened");
        assert_eq!(state_query_param(Some("closed")), "&state=closed");
        assert_eq!(state_query_param(Some("merged")), "&state=merged");
        // "All" (None) omits the param entirely so GitLab returns every state.
        assert_eq!(state_query_param(None), "");
    }

    #[test]
    fn test_url_encode() {
        assert_eq!(url_encode("user/repo"), "user%2Frepo");
        assert_eq!(
            url_encode("group/subgroup/project"),
            "group%2Fsubgroup%2Fproject"
        );
        assert_eq!(url_encode("simple"), "simple");
    }

    #[test]
    fn test_resolve_token_with_valid_token() {
        let result = resolve_token(Some("valid_token".to_string()));
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "valid_token");
    }

    #[test]
    fn test_resolve_token_with_empty_token() {
        let result = resolve_token(Some("".to_string()));
        assert!(result.is_err());
    }

    #[test]
    fn test_resolve_token_with_none() {
        let result = resolve_token(None);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_gitlab_url_https() {
        let result = parse_gitlab_url("https://gitlab.com/user/repo.git");
        assert!(result.is_some());
        let (instance, path) = result.unwrap();
        assert_eq!(instance, "https://gitlab.com");
        assert_eq!(path, "user/repo");
    }

    #[test]
    fn test_parse_gitlab_url_https_with_subgroups() {
        let result = parse_gitlab_url("https://gitlab.com/group/subgroup/project.git");
        assert!(result.is_some());
        let (instance, path) = result.unwrap();
        assert_eq!(instance, "https://gitlab.com");
        assert_eq!(path, "group/subgroup/project");
    }

    #[test]
    fn test_parse_gitlab_url_ssh() {
        let result = parse_gitlab_url("git@gitlab.com:user/repo.git");
        assert!(result.is_some());
        let (instance, path) = result.unwrap();
        assert_eq!(instance, "https://gitlab.com");
        assert_eq!(path, "user/repo");
    }

    #[test]
    fn test_parse_gitlab_url_ssh_with_subgroups() {
        let result = parse_gitlab_url("git@gitlab.com:group/subgroup/project.git");
        assert!(result.is_some());
        let (instance, path) = result.unwrap();
        assert_eq!(instance, "https://gitlab.com");
        assert_eq!(path, "group/subgroup/project");
    }

    #[test]
    fn test_parse_gitlab_url_non_gitlab() {
        // Should return None for non-GitLab URLs
        let result = parse_gitlab_url("https://github.com/user/repo.git");
        assert!(result.is_none());

        let result = parse_gitlab_url("git@github.com:user/repo.git");
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_gitlab_url_custom_instance() {
        let result = parse_gitlab_url("https://gitlab.example.com/user/repo.git");
        assert!(result.is_some());
        let (instance, path) = result.unwrap();
        assert_eq!(instance, "https://gitlab.example.com");
        assert_eq!(path, "user/repo");
    }

    #[tokio::test]
    async fn test_detect_gitlab_repo_no_gitlab_remote() {
        let repo = TestRepo::with_initial_commit();
        // Add a non-GitLab remote
        repo.add_remote("origin", "https://github.com/user/repo.git");

        let result = detect_gitlab_repo(repo.path_str(), None).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_detect_gitlab_repo_with_gitlab_remote() {
        let repo = TestRepo::with_initial_commit();
        // Add a GitLab remote
        repo.add_remote("origin", "https://gitlab.com/user/repo.git");

        let result = detect_gitlab_repo(repo.path_str(), None).await;
        assert!(result.is_ok());
        let detected = result.unwrap();
        assert!(detected.is_some());

        let info = detected.unwrap();
        assert_eq!(info.instance_url, "https://gitlab.com");
        assert_eq!(info.project_path, "user/repo");
        assert_eq!(info.remote_name, "origin");
    }

    #[tokio::test]
    async fn test_detect_gitlab_repo_targets_requested_remote() {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://gitlab.com/personal/repo.git");
        repo.add_remote("upstream", "https://gitlab.com/work/repo.git");

        let detected = detect_gitlab_repo(repo.path_str(), Some("upstream".to_string()))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(detected.project_path, "work/repo");
        assert_eq!(detected.remote_name, "upstream");
    }

    #[tokio::test]
    async fn test_detect_gitlab_repo_with_ssh_remote() {
        let repo = TestRepo::with_initial_commit();
        // Add a GitLab SSH remote
        repo.add_remote("origin", "git@gitlab.com:user/repo.git");

        let result = detect_gitlab_repo(repo.path_str(), None).await;
        assert!(result.is_ok());
        let detected = result.unwrap();
        assert!(detected.is_some());

        let info = detected.unwrap();
        assert_eq!(info.instance_url, "https://gitlab.com");
        assert_eq!(info.project_path, "user/repo");
    }

    #[tokio::test]
    async fn test_check_gitlab_connection_no_token() {
        let result = check_gitlab_connection("https://gitlab.com".to_string(), None).await;
        assert!(result.is_ok());
        let status = result.unwrap();
        assert!(!status.connected);
        assert!(status.user.is_none());
    }

    #[tokio::test]
    async fn test_check_gitlab_connection_empty_token() {
        let result =
            check_gitlab_connection("https://gitlab.com".to_string(), Some("".to_string())).await;
        assert!(result.is_ok());
        let status = result.unwrap();
        assert!(!status.connected);
    }

    #[tokio::test]
    async fn test_list_gitlab_merge_requests_no_token() {
        let result = list_gitlab_merge_requests(
            "https://gitlab.com".to_string(),
            "user/repo".to_string(),
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_gitlab_merge_request_no_token() {
        let result = get_gitlab_merge_request(
            "https://gitlab.com".to_string(),
            "user/repo".to_string(),
            1,
            None,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_list_gitlab_issues_no_token() {
        let result = list_gitlab_issues(
            "https://gitlab.com".to_string(),
            "user/repo".to_string(),
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_list_gitlab_pipelines_no_token() {
        let result = list_gitlab_pipelines(
            "https://gitlab.com".to_string(),
            "user/repo".to_string(),
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_gitlab_labels_no_token() {
        let result = get_gitlab_labels(
            "https://gitlab.com".to_string(),
            "user/repo".to_string(),
            None,
        )
        .await;
        assert!(result.is_err());
    }

    #[test]
    fn test_gitlab_user_struct() {
        let user = GitLabUser {
            id: 123,
            username: "testuser".to_string(),
            name: "Test User".to_string(),
            avatar_url: Some("https://gitlab.com/avatar.png".to_string()),
            web_url: "https://gitlab.com/testuser".to_string(),
        };

        assert_eq!(user.id, 123);
        assert_eq!(user.username, "testuser");
        assert_eq!(user.name, "Test User");
    }

    #[test]
    fn test_gitlab_connection_status_struct() {
        let status = GitLabConnectionStatus {
            connected: true,
            user: Some(GitLabUser {
                id: 1,
                username: "test".to_string(),
                name: "Test".to_string(),
                avatar_url: None,
                web_url: "https://gitlab.com/test".to_string(),
            }),
            instance_url: "https://gitlab.com".to_string(),
        };

        assert!(status.connected);
        assert!(status.user.is_some());
    }

    #[test]
    fn test_detected_gitlab_repo_struct() {
        let repo_info = DetectedGitLabRepo {
            instance_url: "https://gitlab.com".to_string(),
            project_path: "user/repo".to_string(),
            remote_name: "origin".to_string(),
        };

        assert_eq!(repo_info.instance_url, "https://gitlab.com");
        assert_eq!(repo_info.project_path, "user/repo");
        assert_eq!(repo_info.remote_name, "origin");
    }

    #[test]
    fn test_create_merge_request_input_struct() {
        let input = CreateMergeRequestInput {
            title: "Test MR".to_string(),
            description: Some("Description".to_string()),
            source_branch: "feature".to_string(),
            target_branch: "main".to_string(),
            draft: Some(true),
        };

        assert_eq!(input.title, "Test MR");
        assert_eq!(input.source_branch, "feature");
        assert_eq!(input.target_branch, "main");
        assert_eq!(input.draft, Some(true));
    }

    #[test]
    fn test_create_gitlab_issue_input_struct() {
        let input = CreateGitLabIssueInput {
            title: "Test Issue".to_string(),
            description: Some("Issue description".to_string()),
            labels: Some(vec!["bug".to_string(), "urgent".to_string()]),
        };

        assert_eq!(input.title, "Test Issue");
        assert!(input.description.is_some());
        assert_eq!(input.labels.as_ref().unwrap().len(), 2);
    }

    #[test]
    fn test_gitlab_merge_request_struct() {
        let user = GitLabUser {
            id: 1,
            username: "author".to_string(),
            name: "Author Name".to_string(),
            avatar_url: None,
            web_url: "https://gitlab.com/author".to_string(),
        };

        let mr = GitLabMergeRequest {
            iid: 42,
            title: "Test MR".to_string(),
            description: Some("MR description".to_string()),
            state: "opened".to_string(),
            author: user,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            source_branch: "feature".to_string(),
            target_branch: "main".to_string(),
            draft: false,
            web_url: "https://gitlab.com/user/repo/-/merge_requests/42".to_string(),
            merge_status: "can_be_merged".to_string(),
        };

        assert_eq!(mr.iid, 42);
        assert_eq!(mr.state, "opened");
        assert!(!mr.draft);
    }

    #[test]
    fn test_gitlab_issue_struct() {
        let author = GitLabUser {
            id: 1,
            username: "author".to_string(),
            name: "Author Name".to_string(),
            avatar_url: None,
            web_url: "https://gitlab.com/author".to_string(),
        };

        let issue = GitLabIssue {
            iid: 10,
            title: "Test Issue".to_string(),
            description: Some("Issue description".to_string()),
            state: "opened".to_string(),
            author,
            assignees: vec![],
            labels: vec!["bug".to_string()],
            created_at: "2024-01-01T00:00:00Z".to_string(),
            web_url: "https://gitlab.com/user/repo/-/issues/10".to_string(),
        };

        assert_eq!(issue.iid, 10);
        assert_eq!(issue.labels.len(), 1);
        assert!(issue.assignees.is_empty());
    }

    #[test]
    fn test_gitlab_pipeline_struct() {
        let pipeline = GitLabPipeline {
            id: 1000,
            iid: 50,
            status: "success".to_string(),
            source: "push".to_string(),
            r#ref: "main".to_string(),
            sha: "abc123".to_string(),
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T01:00:00Z".to_string(),
            web_url: "https://gitlab.com/user/repo/-/pipelines/1000".to_string(),
        };

        assert_eq!(pipeline.id, 1000);
        assert_eq!(pipeline.iid, 50);
        assert_eq!(pipeline.status, "success");
        assert_eq!(pipeline.r#ref, "main");
    }
}
