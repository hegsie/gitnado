//! Azure DevOps Integration Commands
//!
//! Provides integration with Azure DevOps for pull requests, work items, and pipelines.

use crate::error::{GitnadoError, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use tauri::command;
use tracing::{debug, error, info};

const AZURE_DEVOPS_API_VERSION: &str = "7.1";

/// Helper to resolve token from parameter
/// Returns an error if no token is provided
fn resolve_ado_token(token: Option<String>) -> Result<String> {
    match token {
        Some(t) if !t.is_empty() => Ok(t),
        _ => Err(GitnadoError::OperationFailed(
            "Azure DevOps token not configured".to_string(),
        )),
    }
}

// ============================================================================
// Types
// ============================================================================

/// Azure DevOps user info
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoUser {
    pub id: String,
    pub display_name: String,
    pub unique_name: String,
    pub image_url: Option<String>,
}

/// Azure DevOps connection status
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoConnectionStatus {
    pub connected: bool,
    pub user: Option<AdoUser>,
    pub organization: Option<String>,
}

/// Detected Azure DevOps repository info
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAdoRepo {
    pub organization: String,
    pub project: String,
    pub repository: String,
    pub remote_name: String,
}

/// Pull request summary
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoPullRequest {
    pub pull_request_id: u32,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub created_by: AdoUser,
    pub creation_date: String,
    pub source_ref_name: String,
    pub target_ref_name: String,
    pub is_draft: bool,
    pub url: String,
    pub repository_id: String,
}

/// Create pull request input
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAdoPullRequestInput {
    pub title: String,
    pub description: Option<String>,
    pub source_ref_name: String,
    pub target_ref_name: String,
    pub is_draft: Option<bool>,
}

/// Work item summary
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoWorkItem {
    pub id: u32,
    pub title: String,
    pub work_item_type: String,
    pub state: String,
    pub assigned_to: Option<AdoUser>,
    pub created_date: String,
    pub url: String,
}

/// Create work item input
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAdoWorkItemInput {
    pub work_item_type: Option<String>,
    pub title: String,
    pub description: Option<String>,
    /// Identity (unique name / UPN) to assign the new work item to. The dialog
    /// passes the signed-in user so a created item shows up in the `@Me`-scoped
    /// Work Items list instead of being created unassigned and vanishing.
    pub assigned_to: Option<String>,
}

/// Pipeline run summary
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoPipelineRun {
    pub id: u32,
    pub name: String,
    pub state: String,
    pub result: Option<String>,
    pub created_date: String,
    pub finished_date: Option<String>,
    pub source_branch: String,
    pub url: String,
}

/// Azure DevOps organization (account) the signed-in user belongs to.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoOrganization {
    pub id: String,
    pub name: String,
    pub url: String,
}

// ============================================================================
// Helper Functions
// ============================================================================

fn get_auth_header(token: &str) -> String {
    // OAuth tokens (from Entra ID) use Bearer auth
    // PATs use Basic auth with empty username
    if token.starts_with("ey") {
        // JWT/OAuth token — use Bearer
        format!("Bearer {}", token)
    } else {
        // PAT — use Basic auth with empty username
        let credentials = format!(":{}", token);
        format!("Basic {}", BASE64.encode(credentials.as_bytes()))
    }
}

fn build_api_url(organization: &str, project: &str, path: &str) -> String {
    format!(
        "https://dev.azure.com/{}/{}/_apis/{}?api-version={}",
        organization, project, path, AZURE_DEVOPS_API_VERSION
    )
}

fn build_api_url_with_params(
    organization: &str,
    project: &str,
    path: &str,
    params: &str,
) -> String {
    format!(
        "https://dev.azure.com/{}/{}/_apis/{}?api-version={}&{}",
        organization, project, path, AZURE_DEVOPS_API_VERSION, params
    )
}

/// Build the `searchCriteria.status` query fragment for a PR status filter.
///
/// Azure DevOps defaults `searchCriteria.status` to `active` when the parameter
/// is omitted, so omitting it is *not* "All" — a caller wanting every state must
/// pass the `all` status explicitly. `None` here means only "no filter
/// supplied", which leaves that server default in place.
fn ado_pr_status_param(status: Option<&str>) -> Option<String> {
    status.map(|s| format!("searchCriteria.status={}", s))
}

/// Default page size for the pull-request listing.
///
/// Kept in sync with PULL_REQUESTS_PAGE_SIZE in lv-azure-devops-dialog.ts, which
/// discloses it to the user.
const PULL_REQUESTS_DEFAULT_TOP: u32 = 100;

/// Build the `pullrequests` query fragment: an explicit page size plus the
/// optional status filter.
///
/// Omitting `$top` does not mean "everything" — Azure DevOps still applies a
/// server-side default page size, so the list was silently truncated with no
/// number the UI could disclose. Sending `$top` makes the cap ours and lets the
/// dialog say how many it is showing.
fn ado_pr_query_params(status: Option<&str>, top: u32) -> String {
    match ado_pr_status_param(status) {
        Some(status_param) => format!("$top={}&{}", top, status_param),
        None => format!("$top={}", top),
    }
}

// ============================================================================
// Connection Commands
// ============================================================================

/// Check Azure DevOps connection status
#[command]
pub async fn check_ado_connection(
    organization: String,
    token: Option<String>,
) -> Result<AdoConnectionStatus> {
    debug!("Checking Azure DevOps connection for org: {}", organization);

    // Use provided token - no fallback to file storage
    let token = match token {
        Some(t) if !t.is_empty() => {
            debug!("Using provided token (length: {})", t.len());
            t
        }
        _ => {
            debug!("No Azure DevOps token provided");
            return Ok(AdoConnectionStatus {
                connected: false,
                user: None,
                organization: Some(organization),
            });
        }
    };

    let client = reqwest::Client::new();

    // Use the profile endpoint to verify connection and get user info
    let url = format!(
        "https://vssps.dev.azure.com/{}/_apis/profile/profiles/me?api-version={}",
        organization, AZURE_DEVOPS_API_VERSION
    );
    debug!("Requesting: {}", url);

    let response = client
        .get(&url)
        .header("Authorization", get_auth_header(&token))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| {
            error!("HTTP request failed: {}", e);
            GitnadoError::OperationFailed(format!("Failed to check connection: {}", e))
        })?;

    debug!("Response status: {}", response.status());

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let error_msg = if body.is_empty() {
            match status.as_u16() {
                401 => "Invalid or expired token. Please check your PAT.".to_string(),
                403 => "Access denied. Ensure your PAT has the required scopes.".to_string(),
                404 => "Organization not found. Please check the organization name.".to_string(),
                _ => "Unknown error".to_string(),
            }
        } else {
            body.clone()
        };
        error!(
            "Azure DevOps API error: status={}, body={}",
            status,
            if body.is_empty() { "<empty>" } else { &body }
        );
        return Err(GitnadoError::OperationFailed(format!(
            "Azure DevOps connection failed ({}): {}",
            status, error_msg
        )));
    }

    #[derive(Deserialize)]
    struct ProfileData {
        id: String,
        #[serde(rename = "displayName")]
        display_name: String,
        #[serde(rename = "emailAddress")]
        email_address: Option<String>,
    }

    let data: ProfileData = response.json().await.map_err(|e| {
        error!("Failed to parse profile data: {}", e);
        GitnadoError::OperationFailed(format!("Failed to parse profile data: {}", e))
    })?;

    info!(
        "Successfully connected to Azure DevOps as: {}",
        data.display_name
    );

    // Store git credentials in keyring for push/pull operations
    // Username must be non-empty for macOS Keychain - use 'pat' as a placeholder
    // Store for both dev.azure.com and {org}.visualstudio.com URL formats
    use crate::services::credentials_service;
    if let Err(e) = credentials_service::store_credentials("https://dev.azure.com", "pat", &token) {
        error!("Failed to store git credentials for dev.azure.com: {}", e);
    } else {
        info!("Stored git credentials for dev.azure.com");
    }

    let visualstudio_url = format!("https://{}.visualstudio.com", organization);
    if let Err(e) = credentials_service::store_credentials(&visualstudio_url, "pat", &token) {
        error!(
            "Failed to store git credentials for {}: {}",
            visualstudio_url, e
        );
    } else {
        info!("Stored git credentials for {}", visualstudio_url);
    }

    Ok(AdoConnectionStatus {
        connected: true,
        user: Some(AdoUser {
            id: data.id.clone(),
            display_name: data.display_name.clone(),
            unique_name: data
                .email_address
                .unwrap_or_else(|| data.display_name.clone()),
            image_url: None,
        }),
        organization: Some(organization),
    })
}

/// Detect Azure DevOps repository from git remotes
#[command]
pub async fn detect_ado_repo(
    path: String,
    remote_name: Option<String>,
) -> Result<Option<DetectedAdoRepo>> {
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
                if let Some(repo_info) = parse_ado_url(url) {
                    return Ok(Some(DetectedAdoRepo {
                        organization: repo_info.0,
                        project: repo_info.1,
                        repository: repo_info.2,
                        remote_name: candidate.to_string(),
                    }));
                }
            }
        }
    }

    Ok(None)
}

/// Get a single pull request by ID
#[command]
pub async fn get_ado_pull_request(
    organization: String,
    project: String,
    repository: String,
    pull_request_id: u32,
    token: Option<String>,
) -> Result<AdoPullRequest> {
    let token = resolve_ado_token(token)?;

    let url = build_api_url(
        &organization,
        &project,
        &format!(
            "git/repositories/{}/pullrequests/{}",
            repository, pull_request_id
        ),
    );

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Authorization", get_auth_header(&token))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to fetch pull request: {}", e))
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "Azure DevOps API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiPullRequest {
        #[serde(rename = "pullRequestId")]
        pull_request_id: u32,
        title: String,
        description: Option<String>,
        status: String,
        #[serde(rename = "createdBy")]
        created_by: ApiUser,
        #[serde(rename = "creationDate")]
        creation_date: String,
        #[serde(rename = "sourceRefName")]
        source_ref_name: String,
        #[serde(rename = "targetRefName")]
        target_ref_name: String,
        #[serde(rename = "isDraft")]
        is_draft: Option<bool>,
        repository: ApiRepository,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        id: String,
        #[serde(rename = "displayName")]
        display_name: String,
        #[serde(rename = "uniqueName")]
        unique_name: String,
        #[serde(rename = "imageUrl")]
        image_url: Option<String>,
    }

    #[derive(Deserialize)]
    struct ApiRepository {
        id: String,
    }

    let pr: ApiPullRequest = response.json().await.map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse pull request: {}", e))
    })?;

    Ok(AdoPullRequest {
        pull_request_id: pr.pull_request_id,
        title: pr.title,
        description: pr.description,
        status: pr.status,
        created_by: AdoUser {
            id: pr.created_by.id,
            display_name: pr.created_by.display_name,
            unique_name: pr.created_by.unique_name,
            image_url: pr.created_by.image_url,
        },
        creation_date: pr.creation_date,
        source_ref_name: pr.source_ref_name.replace("refs/heads/", ""),
        target_ref_name: pr.target_ref_name.replace("refs/heads/", ""),
        is_draft: pr.is_draft.unwrap_or(false),
        url: format!(
            "https://dev.azure.com/{}/{}/_git/{}/pullrequest/{}",
            organization, project, repository, pr.pull_request_id
        ),
        repository_id: pr.repository.id,
    })
}

fn parse_ado_url(url: &str) -> Option<(String, String, String)> {
    // Azure DevOps URLs can be in multiple formats:
    // https://dev.azure.com/{org}/{project}/_git/{repo}
    // https://{org}@dev.azure.com/{org}/{project}/_git/{repo}
    // https://{org}.visualstudio.com/{project}/_git/{repo}
    // git@ssh.dev.azure.com:v3/{org}/{project}/{repo}

    // Check SSH format first (before HTTPS check since it also contains dev.azure.com)
    if url.starts_with("git@ssh.dev.azure.com:v3/") {
        let path = url.trim_start_matches("git@ssh.dev.azure.com:v3/");
        let parts: Vec<&str> = path.split('/').collect();
        if parts.len() >= 3 {
            let org = parts[0].to_string();
            let project = parts[1].to_string();
            let repo = parts[2].trim_end_matches(".git").to_string();
            return Some((org, project, repo));
        }
    }

    if url.contains("dev.azure.com") || url.contains("visualstudio.com") {
        // HTTPS format
        let url = url
            .trim_start_matches("https://")
            .trim_start_matches("http://");

        // Remove username@ prefix if present
        let url = if let Some(at_pos) = url.find('@') {
            &url[at_pos + 1..]
        } else {
            url
        };

        // dev.azure.com/{org}/{project}/_git/{repo}
        if url.starts_with("dev.azure.com/") {
            let parts: Vec<&str> = url.split('/').collect();
            if parts.len() >= 5 && parts[3] == "_git" {
                let org = parts[1].to_string();
                let project = parts[2].to_string();
                let repo = parts[4].trim_end_matches(".git").to_string();
                return Some((org, project, repo));
            }
        }

        // {org}.visualstudio.com/{project}/_git/{repo}
        if url.contains(".visualstudio.com/") {
            let parts: Vec<&str> = url.split('/').collect();
            if parts.len() >= 4 && parts[2] == "_git" {
                let org = parts[0].split('.').next().unwrap_or("").to_string();
                let project = parts[1].to_string();
                let repo = parts[3].trim_end_matches(".git").to_string();
                return Some((org, project, repo));
            }
        }
    }

    None
}

// ============================================================================
// Pull Request Commands
// ============================================================================

/// List pull requests for a repository
#[command]
pub async fn list_ado_pull_requests(
    organization: String,
    project: String,
    repository: String,
    status: Option<String>,
    top: Option<u32>,
    token: Option<String>,
) -> Result<Vec<AdoPullRequest>> {
    let token = resolve_ado_token(token)?;

    let top = top.unwrap_or(PULL_REQUESTS_DEFAULT_TOP);
    let path = format!("git/repositories/{}/pullrequests", repository);
    let url = build_api_url_with_params(
        &organization,
        &project,
        &path,
        &ado_pr_query_params(status.as_deref(), top),
    );

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Authorization", get_auth_header(&token))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to fetch pull requests: {}", e))
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "Azure DevOps API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiResponse {
        value: Vec<ApiPullRequest>,
    }

    #[derive(Deserialize)]
    struct ApiPullRequest {
        #[serde(rename = "pullRequestId")]
        pull_request_id: u32,
        title: String,
        description: Option<String>,
        status: String,
        #[serde(rename = "createdBy")]
        created_by: ApiUser,
        #[serde(rename = "creationDate")]
        creation_date: String,
        #[serde(rename = "sourceRefName")]
        source_ref_name: String,
        #[serde(rename = "targetRefName")]
        target_ref_name: String,
        #[serde(rename = "isDraft")]
        is_draft: Option<bool>,
        repository: ApiRepository,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        id: String,
        #[serde(rename = "displayName")]
        display_name: String,
        #[serde(rename = "uniqueName")]
        unique_name: String,
        #[serde(rename = "imageUrl")]
        image_url: Option<String>,
    }

    #[derive(Deserialize)]
    struct ApiRepository {
        id: String,
    }

    let data: ApiResponse = response.json().await.map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse pull requests: {}", e))
    })?;

    Ok(data
        .value
        .into_iter()
        .map(|pr| AdoPullRequest {
            pull_request_id: pr.pull_request_id,
            title: pr.title,
            description: pr.description,
            status: pr.status,
            created_by: AdoUser {
                id: pr.created_by.id,
                display_name: pr.created_by.display_name,
                unique_name: pr.created_by.unique_name,
                image_url: pr.created_by.image_url,
            },
            creation_date: pr.creation_date,
            source_ref_name: pr.source_ref_name.replace("refs/heads/", ""),
            target_ref_name: pr.target_ref_name.replace("refs/heads/", ""),
            is_draft: pr.is_draft.unwrap_or(false),
            url: format!(
                "https://dev.azure.com/{}/{}/_git/{}/pullrequest/{}",
                organization, project, repository, pr.pull_request_id
            ),
            repository_id: pr.repository.id,
        })
        .collect())
}

/// Create a pull request
#[command]
pub async fn create_ado_pull_request(
    organization: String,
    project: String,
    repository: String,
    input: CreateAdoPullRequestInput,
    token: Option<String>,
) -> Result<AdoPullRequest> {
    let token = resolve_ado_token(token)?;

    let url = build_api_url(
        &organization,
        &project,
        &format!("git/repositories/{}/pullrequests", repository),
    );

    #[derive(Serialize)]
    struct CreatePrBody {
        #[serde(rename = "sourceRefName")]
        source_ref_name: String,
        #[serde(rename = "targetRefName")]
        target_ref_name: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(rename = "isDraft", skip_serializing_if = "Option::is_none")]
        is_draft: Option<bool>,
    }

    let body = CreatePrBody {
        source_ref_name: format!("refs/heads/{}", input.source_ref_name),
        target_ref_name: format!("refs/heads/{}", input.target_ref_name),
        title: input.title,
        description: input.description,
        is_draft: input.is_draft,
    };

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Authorization", get_auth_header(&token))
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
            "Azure DevOps API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiPullRequest {
        #[serde(rename = "pullRequestId")]
        pull_request_id: u32,
        title: String,
        description: Option<String>,
        status: String,
        #[serde(rename = "createdBy")]
        created_by: ApiUser,
        #[serde(rename = "creationDate")]
        creation_date: String,
        #[serde(rename = "sourceRefName")]
        source_ref_name: String,
        #[serde(rename = "targetRefName")]
        target_ref_name: String,
        #[serde(rename = "isDraft")]
        is_draft: Option<bool>,
        repository: ApiRepository,
    }

    #[derive(Deserialize)]
    struct ApiUser {
        id: String,
        #[serde(rename = "displayName")]
        display_name: String,
        #[serde(rename = "uniqueName")]
        unique_name: String,
        #[serde(rename = "imageUrl")]
        image_url: Option<String>,
    }

    #[derive(Deserialize)]
    struct ApiRepository {
        id: String,
    }

    let pr: ApiPullRequest = response.json().await.map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse pull request: {}", e))
    })?;

    Ok(AdoPullRequest {
        pull_request_id: pr.pull_request_id,
        title: pr.title,
        description: pr.description,
        status: pr.status,
        created_by: AdoUser {
            id: pr.created_by.id,
            display_name: pr.created_by.display_name,
            unique_name: pr.created_by.unique_name,
            image_url: pr.created_by.image_url,
        },
        creation_date: pr.creation_date,
        source_ref_name: pr.source_ref_name.replace("refs/heads/", ""),
        target_ref_name: pr.target_ref_name.replace("refs/heads/", ""),
        is_draft: pr.is_draft.unwrap_or(false),
        url: format!(
            "https://dev.azure.com/{}/{}/_git/{}/pullrequest/{}",
            organization, project, repository, pr.pull_request_id
        ),
        repository_id: pr.repository.id,
    })
}

// ============================================================================
// Work Item Commands
// ============================================================================

/// Get work items by IDs
#[command]
pub async fn get_ado_work_items(
    organization: String,
    project: String,
    ids: Vec<u32>,
    token: Option<String>,
) -> Result<Vec<AdoWorkItem>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }

    let token = resolve_ado_token(token)?;

    let ids_str = ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let url = build_api_url_with_params(
        &organization,
        &project,
        "wit/workitems",
        &format!("ids={}&fields=System.Id,System.Title,System.WorkItemType,System.State,System.AssignedTo,System.CreatedDate", ids_str),
    );

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Authorization", get_auth_header(&token))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to fetch work items: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "Azure DevOps API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiResponse {
        value: Vec<ApiWorkItem>,
    }

    #[derive(Deserialize)]
    struct ApiWorkItem {
        id: u32,
        fields: ApiFields,
    }

    #[derive(Deserialize)]
    struct ApiFields {
        #[serde(rename = "System.Title")]
        title: String,
        #[serde(rename = "System.WorkItemType")]
        work_item_type: String,
        #[serde(rename = "System.State")]
        state: String,
        #[serde(rename = "System.AssignedTo")]
        assigned_to: Option<ApiIdentity>,
        #[serde(rename = "System.CreatedDate")]
        created_date: String,
    }

    #[derive(Deserialize)]
    struct ApiIdentity {
        id: String,
        #[serde(rename = "displayName")]
        display_name: String,
        #[serde(rename = "uniqueName")]
        unique_name: String,
        #[serde(rename = "imageUrl")]
        image_url: Option<String>,
    }

    let data: ApiResponse = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse work items: {}", e)))?;

    Ok(data
        .value
        .into_iter()
        .map(|wi| AdoWorkItem {
            id: wi.id,
            title: wi.fields.title,
            work_item_type: wi.fields.work_item_type,
            state: wi.fields.state,
            assigned_to: wi.fields.assigned_to.map(|u| AdoUser {
                id: u.id,
                display_name: u.display_name,
                unique_name: u.unique_name,
                image_url: u.image_url,
            }),
            created_date: wi.fields.created_date,
            url: format!(
                "https://dev.azure.com/{}/_workitems/edit/{}",
                organization, wi.id
            ),
        })
        .collect())
}

/// Default number of work items fetched for the "My Work Items" list. When the
/// caller receives exactly this many, more may exist — the dialog surfaces a
/// "capped" hint.
///
/// Kept in sync with WORK_ITEMS_PAGE_SIZE in lv-azure-devops-dialog.ts, which
/// discloses it to the user.
const WORK_ITEMS_DEFAULT_LIMIT: u32 = 50;

/// Resolve how many work items to fetch details for.
///
/// The dialog discloses the size it asked for ("Showing your N most recent"), so
/// taking the size from the caller keeps the number the request caps at and the
/// number the hint quotes the same value, instead of two literals that drift.
fn work_items_limit(limit: Option<u32>) -> usize {
    limit.unwrap_or(WORK_ITEMS_DEFAULT_LIMIT) as usize
}

/// Build the WIQL for the work-items list.
///
/// Scoped to the signed-in user's assigned items (`@Me`): a project-wide flat
/// query returns every work item, which Azure DevOps rejects with VS402337
/// ("size limit of 20000") on large projects — and "my work items" is the
/// intended result anyway. `@Me` keeps the result set well under the cap. The
/// optional `state` value is single-quote-escaped so it can't break out of the
/// WIQL string literal.
fn build_work_items_wiql(state: Option<&str>) -> String {
    let state_clause = state
        .map(|s| format!(" AND [System.State] = '{}'", s.replace('\'', "''")))
        .unwrap_or_default();
    format!(
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @Me{} ORDER BY [System.CreatedDate] DESC",
        state_clause
    )
}

/// Map an Azure DevOps WIQL error body to a friendly, actionable message.
/// Returns `None` when the body is not a recognized size-limit error.
fn map_wiql_error_body(body: &str) -> Option<String> {
    if body.contains("VS402337") || body.contains("QueryResultSizeLimitExceeded") {
        // The list is already scoped to the signed-in user, so this only happens
        // with an unusually large personal backlog — point the user at the web UI.
        Some(
            "You have too many assigned work items to list here. Open this project in Azure DevOps to view them.".to_string(),
        )
    } else {
        None
    }
}

/// Query work items assigned to current user
#[command]
pub async fn query_ado_work_items(
    organization: String,
    project: String,
    state: Option<String>,
    limit: Option<u32>,
    token: Option<String>,
) -> Result<Vec<AdoWorkItem>> {
    let token = resolve_ado_token(token)?;

    let wiql = build_work_items_wiql(state.as_deref());

    let url = build_api_url(&organization, &project, "wit/wiql");

    #[derive(Serialize)]
    struct WiqlQuery {
        query: String,
    }

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Authorization", get_auth_header(&token))
        .header("Content-Type", "application/json")
        .json(&WiqlQuery { query: wiql })
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to query work items: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        // Azure DevOps caps a flat WIQL result at 20000 work items (VS402337).
        // Surface a clear, actionable message instead of the raw API JSON.
        if let Some(message) = map_wiql_error_body(&body) {
            return Err(GitnadoError::OperationFailed(message));
        }
        return Err(GitnadoError::OperationFailed(format!(
            "Azure DevOps API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct WiqlResponse {
        #[serde(rename = "workItems")]
        work_items: Vec<WorkItemRef>,
    }

    #[derive(Deserialize)]
    struct WorkItemRef {
        id: u32,
    }

    let data: WiqlResponse = response.json().await.map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse WIQL response: {}", e))
    })?;

    // Fetch full details for at most the caller's page size of the user's
    // most-recent items. The dialog flags the list as capped when it receives
    // exactly this many, and it asks for the number it discloses.
    let ids: Vec<u32> = data
        .work_items
        .into_iter()
        .take(work_items_limit(limit))
        .map(|w| w.id)
        .collect();

    if ids.is_empty() {
        return Ok(vec![]);
    }

    get_ado_work_items(organization, project, ids, Some(token)).await
}

/// Build the JSON-Patch document Azure DevOps requires for work item creation.
/// Each field is an add operation onto `/fields/<ref name>`.
fn build_create_work_item_patch(input: &CreateAdoWorkItemInput) -> serde_json::Value {
    let mut ops = vec![serde_json::json!({
        "op": "add",
        "path": "/fields/System.Title",
        "value": input.title,
    })];

    if let Some(description) = &input.description {
        if !description.is_empty() {
            ops.push(serde_json::json!({
                "op": "add",
                "path": "/fields/System.Description",
                "value": description,
            }));
        }
    }

    // Assign to the given identity so a created item appears in the @Me-scoped
    // Work Items list (the dialog passes the signed-in user).
    if let Some(assigned_to) = &input.assigned_to {
        if !assigned_to.is_empty() {
            ops.push(serde_json::json!({
                "op": "add",
                "path": "/fields/System.AssignedTo",
                "value": assigned_to,
            }));
        }
    }

    serde_json::Value::Array(ops)
}

/// Create a new work item
#[command]
pub async fn create_azure_devops_work_item(
    organization: String,
    project: String,
    input: CreateAdoWorkItemInput,
    token: Option<String>,
) -> Result<AdoWorkItem> {
    let token = resolve_ado_token(token)?;

    let work_item_type = input
        .work_item_type
        .clone()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Task".to_string());

    // Path includes a $-prefixed type: wit/workitems/$Task. URL-encode the type
    // so valid multi-word types (e.g. "User Story") produce a valid path.
    let url = build_api_url(
        &organization,
        &project,
        &format!("wit/workitems/${}", urlencoding::encode(&work_item_type)),
    );

    let patch = build_create_work_item_patch(&input);

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Authorization", get_auth_header(&token))
        .header("Content-Type", "application/json-patch+json")
        .json(&patch)
        .send()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to create work item: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "Azure DevOps API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiWorkItem {
        id: u32,
        fields: ApiFields,
    }

    #[derive(Deserialize)]
    struct ApiFields {
        #[serde(rename = "System.Title")]
        title: String,
        #[serde(rename = "System.WorkItemType")]
        work_item_type: String,
        #[serde(rename = "System.State")]
        state: String,
        #[serde(rename = "System.AssignedTo")]
        assigned_to: Option<ApiIdentity>,
        #[serde(rename = "System.CreatedDate")]
        created_date: String,
    }

    #[derive(Deserialize)]
    struct ApiIdentity {
        id: String,
        #[serde(rename = "displayName")]
        display_name: String,
        #[serde(rename = "uniqueName")]
        unique_name: String,
        #[serde(rename = "imageUrl")]
        image_url: Option<String>,
    }

    let wi: ApiWorkItem = response
        .json()
        .await
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse work item: {}", e)))?;

    Ok(AdoWorkItem {
        id: wi.id,
        title: wi.fields.title,
        work_item_type: wi.fields.work_item_type,
        state: wi.fields.state,
        assigned_to: wi.fields.assigned_to.map(|u| AdoUser {
            id: u.id,
            display_name: u.display_name,
            unique_name: u.unique_name,
            image_url: u.image_url,
        }),
        created_date: wi.fields.created_date,
        url: format!(
            "https://dev.azure.com/{}/_workitems/edit/{}",
            organization, wi.id
        ),
    })
}

// ============================================================================
// Pipeline Commands
// ============================================================================

/// Path of the repository-metadata endpoint for `repository` (name or GUID).
///
/// `repository` comes from `parse_ado_url`, which keeps the remote URL's path
/// segment verbatim, and Azure DevOps clone URLs already percent-encode the
/// names that need it (`My Repo` is cloned from `.../_git/My%20Repo`). Encoding
/// again here would request `My%2520Repo` and 404, so the segment is used as-is
/// — exactly like the sibling `git/repositories/{repository}/pullrequests`.
fn ado_repository_lookup_path(repository: &str) -> String {
    format!("git/repositories/{}", repository)
}

/// Build the `build/builds` query fragment for a repository-scoped run listing.
///
/// Without a repository filter Azure DevOps returns builds for *every* repository
/// in the project, so `$top` fills with unrelated repos' runs. `repositoryId` is
/// matched by GUID only (never by name) and the API ignores it unless
/// `repositoryType` is sent alongside it.
fn ado_pipeline_query_params(top: u32, repository_id: &str) -> String {
    format!(
        "$top={}&queryOrder=queueTimeDescending&repositoryId={}&repositoryType=TfsGit",
        top,
        urlencoding::encode(repository_id)
    )
}

/// Frame a repository-lookup failure so the Pipelines tab names the repository.
fn map_repository_lookup_error(repository: &str, detail: &str) -> String {
    format!("Failed to resolve repository '{}': {}", repository, detail)
}

/// Resolve an Azure DevOps repository name (or GUID) to its GUID.
///
/// The build API matches `repositoryId` by GUID only, so the Pipelines listing
/// has to translate the detected repository name first. Passing an already
/// resolved GUID is a no-op — `git/repositories/{x}` accepts either form.
async fn resolve_ado_repository_id(
    organization: &str,
    project: &str,
    repository: &str,
    token: &str,
) -> Result<String> {
    let url = build_api_url(
        organization,
        project,
        &ado_repository_lookup_path(repository),
    );

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Authorization", get_auth_header(token))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| {
            GitnadoError::OperationFailed(map_repository_lookup_error(repository, &e.to_string()))
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(map_repository_lookup_error(
            repository,
            &format!("Azure DevOps API error {}: {}", status, body),
        )));
    }

    #[derive(Deserialize)]
    struct ApiRepositoryRef {
        id: String,
    }

    let repo: ApiRepositoryRef = response.json().await.map_err(|e| {
        GitnadoError::OperationFailed(map_repository_lookup_error(repository, &e.to_string()))
    })?;

    Ok(repo.id)
}

/// List pipeline runs for a repository
#[command]
pub async fn list_ado_pipeline_runs(
    organization: String,
    project: String,
    repository: String,
    top: Option<u32>,
    token: Option<String>,
) -> Result<Vec<AdoPipelineRun>> {
    let token = resolve_ado_token(token)?;

    let top = top.unwrap_or(20);
    // Scope the listing to this repository — an Azure DevOps project commonly
    // hosts many repos, and an unfiltered listing fills `$top` with their builds.
    let repository_id =
        resolve_ado_repository_id(&organization, &project, &repository, &token).await?;
    let url = build_api_url_with_params(
        &organization,
        &project,
        "build/builds",
        &ado_pipeline_query_params(top, &repository_id),
    );

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Authorization", get_auth_header(&token))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to fetch pipeline runs: {}", e))
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "Azure DevOps API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ApiResponse {
        value: Vec<ApiBuild>,
    }

    #[derive(Deserialize)]
    struct ApiBuild {
        id: u32,
        #[serde(rename = "buildNumber")]
        build_number: String,
        status: String,
        result: Option<String>,
        #[serde(rename = "queueTime")]
        queue_time: String,
        #[serde(rename = "finishTime")]
        finish_time: Option<String>,
        #[serde(rename = "sourceBranch")]
        source_branch: String,
        #[serde(rename = "_links")]
        links: ApiLinks,
        definition: ApiDefinition,
    }

    #[derive(Deserialize)]
    struct ApiLinks {
        web: ApiLink,
    }

    #[derive(Deserialize)]
    struct ApiLink {
        href: String,
    }

    #[derive(Deserialize)]
    struct ApiDefinition {
        name: String,
    }

    let data: ApiResponse = response.json().await.map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse pipeline runs: {}", e))
    })?;

    Ok(data
        .value
        .into_iter()
        .map(|b| AdoPipelineRun {
            id: b.id,
            name: format!("{} #{}", b.definition.name, b.build_number),
            state: b.status,
            result: b.result,
            created_date: b.queue_time,
            finished_date: b.finish_time,
            source_branch: b.source_branch.replace("refs/heads/", ""),
            url: b.links.web.href,
        })
        .collect())
}

// ============================================================================
// Organization Commands
// ============================================================================

/// List the Azure DevOps organizations the authenticated user is a member of.
/// Used to auto-resolve the organization after an Entra sign-in when it cannot be
/// detected from the repo remote. Uses the org-less vssps host so it works before
/// any organization is known.
#[command]
pub async fn list_ado_organizations(token: Option<String>) -> Result<Vec<AdoOrganization>> {
    let token = resolve_ado_token(token)?;

    let client = reqwest::Client::new();

    // Step 1: Resolve the member id via the org-less profile endpoint.
    let profile_url =
        "https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1";
    debug!("Requesting: {}", profile_url);

    let profile_response = client
        .get(profile_url)
        .header("Authorization", get_auth_header(&token))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| {
            error!("HTTP request failed: {}", e);
            GitnadoError::OperationFailed(format!("Failed to fetch profile: {}", e))
        })?;

    if !profile_response.status().is_success() {
        let status = profile_response.status();
        let body = profile_response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "Azure DevOps API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct ProfileData {
        id: String,
    }

    let profile: ProfileData = profile_response.json().await.map_err(|e| {
        error!("Failed to parse profile data: {}", e);
        GitnadoError::OperationFailed(format!("Failed to parse profile data: {}", e))
    })?;

    // Step 2: List accounts for the resolved member id.
    let accounts_url = format!(
        "https://app.vssps.visualstudio.com/_apis/accounts?memberId={}&api-version=7.1",
        profile.id
    );
    debug!("Requesting: {}", accounts_url);

    let accounts_response = client
        .get(&accounts_url)
        .header("Authorization", get_auth_header(&token))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| {
            error!("HTTP request failed: {}", e);
            GitnadoError::OperationFailed(format!("Failed to fetch accounts: {}", e))
        })?;

    if !accounts_response.status().is_success() {
        let status = accounts_response.status();
        let body = accounts_response.text().await.unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "Azure DevOps API error {}: {}",
            status, body
        )));
    }

    #[derive(Deserialize)]
    struct AccountsResponse {
        value: Vec<ApiAccount>,
    }

    #[derive(Deserialize)]
    struct ApiAccount {
        #[serde(rename = "accountId")]
        account_id: String,
        #[serde(rename = "accountName")]
        account_name: String,
    }

    let data: AccountsResponse = accounts_response.json().await.map_err(|e| {
        error!("Failed to parse accounts data: {}", e);
        GitnadoError::OperationFailed(format!("Failed to parse accounts data: {}", e))
    })?;

    Ok(data
        .value
        .into_iter()
        .map(|a| AdoOrganization {
            id: a.account_id,
            url: format!("https://dev.azure.com/{}", a.account_name),
            name: a.account_name,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_work_items_wiql_scopes_to_me() {
        let wiql = build_work_items_wiql(None);
        // Must scope to the current user so a large project's flat query can't
        // exceed Azure DevOps' 20000-item WIQL limit (VS402337).
        assert!(wiql.contains("[System.AssignedTo] = @Me"));
        assert!(wiql.contains("[System.TeamProject] = @project"));
        // No state filter when none is given.
        assert!(!wiql.contains("[System.State]"));
    }

    #[test]
    fn test_build_work_items_wiql_adds_and_escapes_state() {
        let wiql = build_work_items_wiql(Some("Active"));
        assert!(wiql.contains("[System.State] = 'Active'"));
        // A single quote in the state value is escaped (doubled) so it can't
        // break out of the WIQL string literal.
        let injected = build_work_items_wiql(Some("O'Brien"));
        assert!(injected.contains("'O''Brien'"));
    }

    #[test]
    fn test_build_work_items_wiql_orders_by_created_date() {
        // Must match the date the UI displays (System.CreatedDate) so the list
        // isn't sorted by a hidden key.
        assert!(build_work_items_wiql(None).contains("ORDER BY [System.CreatedDate] DESC"));
    }

    #[test]
    fn test_map_wiql_error_body() {
        assert!(map_wiql_error_body("...\"message\":\"VS402337: ...\"").is_some());
        assert!(map_wiql_error_body("QueryResultSizeLimitExceededException").is_some());
        // Unrelated errors are not swallowed by the friendly mapping.
        assert_eq!(map_wiql_error_body("TF401019: project not found"), None);
        assert_eq!(map_wiql_error_body(""), None);
    }

    #[test]
    fn test_create_work_item_patch_includes_assigned_to() {
        let input = CreateAdoWorkItemInput {
            work_item_type: Some("Task".into()),
            title: "T".into(),
            description: None,
            assigned_to: Some("user@example.com".into()),
        };
        let patch = build_create_work_item_patch(&input).to_string();
        assert!(patch.contains("/fields/System.AssignedTo"));
        assert!(patch.contains("user@example.com"));

        // Omitted when not provided.
        let unassigned = CreateAdoWorkItemInput {
            assigned_to: None,
            ..input
        };
        assert!(!build_create_work_item_patch(&unassigned)
            .to_string()
            .contains("System.AssignedTo"));
    }

    #[test]
    fn test_ado_pr_status_param() {
        // A concrete status yields the searchCriteria fragment.
        assert_eq!(
            ado_pr_status_param(Some("active")).as_deref(),
            Some("searchCriteria.status=active")
        );
        assert_eq!(
            ado_pr_status_param(Some("completed")).as_deref(),
            Some("searchCriteria.status=completed")
        );
        // "All" (None) omits the filter so every PR state is returned.
        assert_eq!(ado_pr_status_param(None), None);
    }

    /// Credential selection is scoped to the remote the operation actually
    /// targets, so detection must answer for THAT remote — not for whichever
    /// one happens to sort first. Without the filter a fetch of `upstream`
    /// resolved `origin`'s organization, and with it the wrong account.
    #[tokio::test]
    async fn test_detect_ado_repo_targets_requested_remote() {
        use crate::test_utils::TestRepo;

        let repo = TestRepo::with_initial_commit();
        repo.add_remote(
            "origin",
            "https://dev.azure.com/personalorg/Proj/_git/frontend",
        );
        repo.add_remote(
            "upstream",
            "https://dev.azure.com/workorg/Proj/_git/frontend",
        );

        let detected = detect_ado_repo(repo.path_str(), Some("upstream".to_string()))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(detected.organization, "workorg");
        assert_eq!(detected.remote_name, "upstream");
    }

    #[test]
    fn test_ado_pr_query_params_always_sends_top() {
        // Without $top the Azure DevOps server default silently caps the list,
        // leaving the dialog no number to disclose.
        assert_eq!(
            ado_pr_query_params(Some("active"), 100),
            "$top=100&searchCriteria.status=active"
        );
        // "All" is a real Azure DevOps status, so it is sent like any other —
        // omitting it would leave the API's `active` default in place and hide
        // completed and abandoned pull requests.
        assert_eq!(
            ado_pr_query_params(Some("all"), 100),
            "$top=100&searchCriteria.status=all"
        );
        // No filter supplied still gets an explicit page size.
        assert_eq!(ado_pr_query_params(None, 100), "$top=100");
        assert_eq!(ado_pr_query_params(None, 5), "$top=5");
    }

    #[test]
    fn test_work_items_limit() {
        // The caller's page size wins, so the size requested is the size the
        // dialog discloses.
        assert_eq!(work_items_limit(Some(50)), 50);
        assert_eq!(work_items_limit(Some(3)), 3);
        // No caller size falls back to this file's default.
        assert_eq!(work_items_limit(None), WORK_ITEMS_DEFAULT_LIMIT as usize);
    }

    #[test]
    fn test_parse_ado_url_https_standard() {
        let url = "https://dev.azure.com/mycompany/MyProject/_git/frontend";
        let result = parse_ado_url(url);

        assert!(result.is_some());
        let (org, project, repo) = result.unwrap();
        assert_eq!(org, "mycompany");
        assert_eq!(project, "MyProject");
        assert_eq!(repo, "frontend");
    }

    #[test]
    fn test_parse_ado_url_https_with_username() {
        let url = "https://mycompany@dev.azure.com/mycompany/MyProject/_git/backend";
        let result = parse_ado_url(url);

        assert!(result.is_some());
        let (org, project, repo) = result.unwrap();
        assert_eq!(org, "mycompany");
        assert_eq!(project, "MyProject");
        assert_eq!(repo, "backend");
    }

    #[test]
    fn test_parse_ado_url_https_with_git_suffix() {
        let url = "https://dev.azure.com/mycompany/MyProject/_git/repo.git";
        let result = parse_ado_url(url);

        assert!(result.is_some());
        let (_, _, repo) = result.unwrap();
        assert_eq!(repo, "repo");
    }

    #[test]
    fn test_parse_ado_url_visualstudio() {
        let url = "https://mycompany.visualstudio.com/MyProject/_git/repo";
        let result = parse_ado_url(url);

        assert!(result.is_some());
        let (org, project, repo) = result.unwrap();
        assert_eq!(org, "mycompany");
        assert_eq!(project, "MyProject");
        assert_eq!(repo, "repo");
    }

    #[test]
    fn test_parse_ado_url_ssh() {
        let url = "git@ssh.dev.azure.com:v3/mycompany/MyProject/repo";
        let result = parse_ado_url(url);

        assert!(result.is_some());
        let (org, project, repo) = result.unwrap();
        assert_eq!(org, "mycompany");
        assert_eq!(project, "MyProject");
        assert_eq!(repo, "repo");
    }

    #[test]
    fn test_parse_ado_url_ssh_with_git_suffix() {
        let url = "git@ssh.dev.azure.com:v3/mycompany/MyProject/repo.git";
        let result = parse_ado_url(url);

        assert!(result.is_some());
        let (_, _, repo) = result.unwrap();
        assert_eq!(repo, "repo");
    }

    #[test]
    fn test_parse_ado_url_github_returns_none() {
        let url = "https://github.com/user/repo";
        let result = parse_ado_url(url);
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_ado_url_gitlab_returns_none() {
        let url = "https://gitlab.com/user/repo";
        let result = parse_ado_url(url);
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_ado_url_malformed_returns_none() {
        let url = "https://dev.azure.com/org/project";
        let result = parse_ado_url(url);
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_ado_url_empty_returns_none() {
        let url = "";
        let result = parse_ado_url(url);
        assert!(result.is_none());
    }

    #[test]
    fn test_get_auth_header() {
        let token = "myToken123";
        let header = get_auth_header(token);

        assert!(header.starts_with("Basic "));
        // Decode and verify format
        let encoded = header.trim_start_matches("Basic ");
        let decoded = String::from_utf8(base64::Engine::decode(&BASE64, encoded).unwrap()).unwrap();
        assert_eq!(decoded, ":myToken123");
    }

    #[test]
    fn test_build_api_url() {
        let url = build_api_url("myorg", "myproject", "git/repositories");

        assert!(url.contains("dev.azure.com/myorg/myproject"));
        assert!(url.contains("_apis/git/repositories"));
        assert!(url.contains("api-version=7.1"));
    }

    #[test]
    fn test_ado_pipeline_query_params_scopes_to_repository() {
        let params = ado_pipeline_query_params(20, "0d1a2b3c-4d5e-6f70-8191-a2b3c4d5e6f7");

        assert!(
            params.contains("repositoryId=0d1a2b3c-4d5e-6f70-8191-a2b3c4d5e6f7"),
            "expected a repositoryId filter, got: {}",
            params
        );
        assert!(
            params.contains("repositoryType=TfsGit"),
            "repositoryId is ignored without repositoryType, got: {}",
            params
        );
    }

    #[test]
    fn test_ado_pipeline_query_params_keeps_top_and_order() {
        let params = ado_pipeline_query_params(5, "0d1a2b3c-4d5e-6f70-8191-a2b3c4d5e6f7");

        assert!(params.contains("$top=5"), "got: {}", params);
        assert!(
            params.contains("queryOrder=queueTimeDescending"),
            "got: {}",
            params
        );
    }

    #[test]
    fn test_ado_repository_lookup_path_preserves_encoded_name() {
        // `parse_ado_url` hands back the clone URL's path segment verbatim, and
        // Azure DevOps already percent-encodes it. Re-encoding would look up
        // `My%2520Repo` and 404.
        assert_eq!(
            ado_repository_lookup_path("My%20Repo"),
            "git/repositories/My%20Repo"
        );
    }

    #[test]
    fn test_ado_repository_lookup_path_matches_pull_request_path() {
        // The pipeline lookup must scope by the same segment the repo-scoped PR
        // listing already uses, otherwise one of the two tabs resolves a
        // different repository for the same detected remote.
        let (_, _, repository) =
            parse_ado_url("https://dev.azure.com/mycompany/MyProject/_git/My%20Repo").unwrap();

        assert_eq!(repository, "My%20Repo");
        assert_eq!(
            ado_repository_lookup_path(&repository),
            format!("git/repositories/{}", repository)
        );
    }

    #[test]
    fn test_map_repository_lookup_error_names_repository() {
        let msg = map_repository_lookup_error("test-repo", "Azure DevOps API error 404: not found");

        assert!(msg.contains("test-repo"), "got: {}", msg);
        assert!(msg.contains("404"), "got: {}", msg);
    }

    #[test]
    fn test_build_api_url_with_params() {
        let url = build_api_url_with_params(
            "myorg",
            "myproject",
            "git/pullrequests",
            "status=active&top=10",
        );

        assert!(url.contains("api-version=7.1"));
        assert!(url.contains("status=active"));
        assert!(url.contains("top=10"));
    }

    #[test]
    fn test_resolve_ado_token_valid() {
        let result = resolve_ado_token(Some("valid-token".to_string()));
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "valid-token");
    }

    #[test]
    fn test_resolve_ado_token_empty() {
        let result = resolve_ado_token(Some("".to_string()));
        assert!(result.is_err());
    }

    #[test]
    fn test_resolve_ado_token_none() {
        let result = resolve_ado_token(None);
        assert!(result.is_err());
    }

    #[test]
    fn test_ado_user_serialization() {
        let user = AdoUser {
            id: "user-123".to_string(),
            display_name: "John Doe".to_string(),
            unique_name: "john@company.com".to_string(),
            image_url: Some("https://example.com/avatar.png".to_string()),
        };

        let json = serde_json::to_string(&user).unwrap();
        assert!(json.contains("displayName"));
        assert!(json.contains("John Doe"));
        assert!(json.contains("uniqueName"));
    }

    #[test]
    fn test_ado_connection_status_connected() {
        let status = AdoConnectionStatus {
            connected: true,
            user: Some(AdoUser {
                id: "1".to_string(),
                display_name: "User".to_string(),
                unique_name: "user@test.com".to_string(),
                image_url: None,
            }),
            organization: Some("myorg".to_string()),
        };

        assert!(status.connected);
        assert!(status.user.is_some());
    }

    #[test]
    fn test_ado_connection_status_disconnected() {
        let status = AdoConnectionStatus {
            connected: false,
            user: None,
            organization: Some("myorg".to_string()),
        };

        assert!(!status.connected);
        assert!(status.user.is_none());
    }

    #[test]
    fn test_detected_ado_repo_serialization() {
        let repo = DetectedAdoRepo {
            organization: "mycompany".to_string(),
            project: "MyProject".to_string(),
            repository: "frontend".to_string(),
            remote_name: "origin".to_string(),
        };

        let json = serde_json::to_string(&repo).unwrap();
        assert!(json.contains("organization"));
        assert!(json.contains("mycompany"));
        assert!(json.contains("remoteName"));
    }

    #[test]
    fn test_ado_pull_request_serialization() {
        let pr = AdoPullRequest {
            pull_request_id: 123,
            title: "Test PR".to_string(),
            description: Some("Description".to_string()),
            status: "active".to_string(),
            created_by: AdoUser {
                id: "1".to_string(),
                display_name: "User".to_string(),
                unique_name: "user@test.com".to_string(),
                image_url: None,
            },
            creation_date: "2024-01-15T10:00:00Z".to_string(),
            source_ref_name: "feature/test".to_string(),
            target_ref_name: "main".to_string(),
            is_draft: false,
            url: "https://dev.azure.com/org/proj/_git/repo/pullrequest/123".to_string(),
            repository_id: "repo-id".to_string(),
        };

        let json = serde_json::to_string(&pr).unwrap();
        assert!(json.contains("pullRequestId"));
        assert!(json.contains("123"));
        assert!(json.contains("sourceRefName"));
        assert!(json.contains("isDraft"));
    }

    #[test]
    fn test_create_ado_pull_request_input_serialization() {
        let input = CreateAdoPullRequestInput {
            title: "New Feature".to_string(),
            description: Some("Adds a new feature".to_string()),
            source_ref_name: "feature/new".to_string(),
            target_ref_name: "main".to_string(),
            is_draft: Some(true),
        };

        let json = serde_json::to_string(&input).unwrap();
        assert!(json.contains("title"));
        assert!(json.contains("sourceRefName"));
    }

    #[test]
    fn test_ado_work_item_serialization() {
        let work_item = AdoWorkItem {
            id: 456,
            title: "Implement feature".to_string(),
            work_item_type: "User Story".to_string(),
            state: "Active".to_string(),
            assigned_to: None,
            created_date: "2024-01-10T08:00:00Z".to_string(),
            url: "https://dev.azure.com/org/_workitems/edit/456".to_string(),
        };

        let json = serde_json::to_string(&work_item).unwrap();
        assert!(json.contains("workItemType"));
        assert!(json.contains("User Story"));
    }

    #[test]
    fn test_create_ado_work_item_input_serialization() {
        let input = CreateAdoWorkItemInput {
            work_item_type: Some("Bug".to_string()),
            title: "Fix the thing".to_string(),
            description: Some("It is broken".to_string()),
            assigned_to: None,
        };

        let json = serde_json::to_string(&input).unwrap();
        assert!(json.contains("workItemType"));
        assert!(json.contains("title"));
        assert!(json.contains("Fix the thing"));
    }

    #[test]
    fn test_build_create_work_item_patch_full() {
        let input = CreateAdoWorkItemInput {
            work_item_type: Some("Task".to_string()),
            title: "My Task".to_string(),
            description: Some("Do the work".to_string()),
            assigned_to: None,
        };

        let patch = build_create_work_item_patch(&input);
        let ops = patch.as_array().expect("patch should be an array");
        assert_eq!(ops.len(), 2);

        // Title op
        assert_eq!(ops[0]["op"], "add");
        assert_eq!(ops[0]["path"], "/fields/System.Title");
        assert_eq!(ops[0]["value"], "My Task");

        // Description op
        assert_eq!(ops[1]["op"], "add");
        assert_eq!(ops[1]["path"], "/fields/System.Description");
        assert_eq!(ops[1]["value"], "Do the work");
    }

    #[test]
    fn test_build_create_work_item_patch_title_only() {
        let input = CreateAdoWorkItemInput {
            work_item_type: None,
            title: "Title only".to_string(),
            description: None,
            assigned_to: None,
        };

        let patch = build_create_work_item_patch(&input);
        let ops = patch.as_array().expect("patch should be an array");
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0]["path"], "/fields/System.Title");
        assert_eq!(ops[0]["value"], "Title only");
    }

    #[test]
    fn test_build_create_work_item_patch_skips_empty_description() {
        let input = CreateAdoWorkItemInput {
            work_item_type: Some("Task".to_string()),
            title: "Title".to_string(),
            description: Some(String::new()),
            assigned_to: None,
        };

        let patch = build_create_work_item_patch(&input);
        let ops = patch.as_array().expect("patch should be an array");
        assert_eq!(ops.len(), 1);
    }

    #[test]
    fn test_ado_pipeline_run_serialization() {
        let run = AdoPipelineRun {
            id: 1234,
            name: "Build #1234".to_string(),
            state: "completed".to_string(),
            result: Some("succeeded".to_string()),
            created_date: "2024-01-15T10:00:00Z".to_string(),
            finished_date: Some("2024-01-15T10:15:00Z".to_string()),
            source_branch: "main".to_string(),
            url: "https://dev.azure.com/org/proj/_build/results?buildId=1234".to_string(),
        };

        let json = serde_json::to_string(&run).unwrap();
        assert!(json.contains("sourceBranch"));
        assert!(json.contains("finishedDate"));
    }

    #[test]
    fn test_ado_organization_serialization() {
        let org = AdoOrganization {
            id: "acct-123".to_string(),
            name: "mycompany".to_string(),
            url: "https://dev.azure.com/mycompany".to_string(),
        };

        let json = serde_json::to_string(&org).unwrap();
        assert!(json.contains("\"id\":\"acct-123\""));
        assert!(json.contains("\"name\":\"mycompany\""));
        assert!(json.contains("\"url\":\"https://dev.azure.com/mycompany\""));
    }

    #[test]
    fn test_ado_accounts_response_deserialization() {
        // Mirrors the accounts API `value` array shape used by list_ado_organizations.
        #[derive(Deserialize)]
        struct AccountsResponse {
            value: Vec<ApiAccount>,
        }

        #[derive(Deserialize)]
        struct ApiAccount {
            #[serde(rename = "accountId")]
            account_id: String,
            #[serde(rename = "accountName")]
            account_name: String,
        }

        let raw = r#"{
            "count": 2,
            "value": [
                { "accountId": "id-1", "accountName": "orgOne" },
                { "accountId": "id-2", "accountName": "orgTwo" }
            ]
        }"#;

        let parsed: AccountsResponse = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.value.len(), 2);
        assert_eq!(parsed.value[0].account_id, "id-1");
        assert_eq!(parsed.value[0].account_name, "orgOne");
        assert_eq!(parsed.value[1].account_id, "id-2");
        assert_eq!(parsed.value[1].account_name, "orgTwo");

        // Verify the mapping list_ado_organizations performs.
        let orgs: Vec<AdoOrganization> = parsed
            .value
            .into_iter()
            .map(|a| AdoOrganization {
                id: a.account_id,
                url: format!("https://dev.azure.com/{}", a.account_name),
                name: a.account_name,
            })
            .collect();
        assert_eq!(orgs[0].name, "orgOne");
        assert_eq!(orgs[0].url, "https://dev.azure.com/orgOne");
        assert_eq!(orgs[1].id, "id-2");
    }
}
