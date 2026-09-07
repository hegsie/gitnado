//! MCP tool definitions and handlers
//!
//! Each tool maps to git2 operations for querying repository state.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// An MCP tool definition
#[derive(Debug, Clone, Serialize)]
pub struct McpTool {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

/// Get the list of all available MCP tools
pub fn get_tool_list() -> Vec<McpTool> {
    vec![
        McpTool {
            name: "get_commit_history".to_string(),
            description: "Get recent commit history for a repository".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "repo_path": {
                        "type": "string",
                        "description": "Path to the git repository"
                    },
                    "count": {
                        "type": "integer",
                        "description": "Number of commits to return (default 20)"
                    },
                    "branch": {
                        "type": "string",
                        "description": "Branch name to get history for (default: HEAD)"
                    }
                },
                "required": ["repo_path"]
            }),
        },
        McpTool {
            name: "get_branches".to_string(),
            description: "List all branches in a repository".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "repo_path": {
                        "type": "string",
                        "description": "Path to the git repository"
                    }
                },
                "required": ["repo_path"]
            }),
        },
        McpTool {
            name: "get_status".to_string(),
            description: "Get working directory status (staged, modified, untracked files)"
                .to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "repo_path": {
                        "type": "string",
                        "description": "Path to the git repository"
                    }
                },
                "required": ["repo_path"]
            }),
        },
        McpTool {
            name: "get_diff".to_string(),
            description: "Get diff for working directory or between two refs".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "repo_path": {
                        "type": "string",
                        "description": "Path to the git repository"
                    },
                    "from_ref": {
                        "type": "string",
                        "description": "Starting reference (commit SHA, branch, tag)"
                    },
                    "to_ref": {
                        "type": "string",
                        "description": "Ending reference (commit SHA, branch, tag)"
                    }
                },
                "required": ["repo_path"]
            }),
        },
        McpTool {
            name: "get_file_blame".to_string(),
            description: "Get blame information for a file".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "repo_path": {
                        "type": "string",
                        "description": "Path to the git repository"
                    },
                    "file_path": {
                        "type": "string",
                        "description": "Relative path to the file within the repository"
                    }
                },
                "required": ["repo_path", "file_path"]
            }),
        },
        McpTool {
            name: "search_commits".to_string(),
            description: "Search commits by message content".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "repo_path": {
                        "type": "string",
                        "description": "Path to the git repository"
                    },
                    "query": {
                        "type": "string",
                        "description": "Search query to match against commit messages"
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of results (default 20)"
                    }
                },
                "required": ["repo_path", "query"]
            }),
        },
        McpTool {
            name: "get_open_repositories".to_string(),
            description: "Get list of repositories currently open in Gitnado".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
    ]
}

/// Parameters for get_commit_history
#[derive(Debug, Deserialize)]
struct CommitHistoryParams {
    repo_path: String,
    count: Option<u32>,
    branch: Option<String>,
}

/// Parameters for get_branches
#[derive(Debug, Deserialize)]
struct BranchesParams {
    repo_path: String,
}

/// Parameters for get_status
#[derive(Debug, Deserialize)]
struct StatusParams {
    repo_path: String,
}

/// Parameters for get_diff
#[derive(Debug, Deserialize)]
struct DiffParams {
    repo_path: String,
    from_ref: Option<String>,
    to_ref: Option<String>,
}

/// Parameters for get_file_blame
#[derive(Debug, Deserialize)]
struct BlameParams {
    repo_path: String,
    file_path: String,
}

/// Parameters for search_commits
#[derive(Debug, Deserialize)]
struct SearchCommitsParams {
    repo_path: String,
    query: String,
    max_results: Option<u32>,
}

/// Validate that a repo_path is an actual git repository and is not a path traversal attempt.
///
/// Only allows access to repositories whose paths are in the `open_repos` list,
/// or any valid git repository if the list is empty (for backwards compatibility
/// during initial setup before repos are registered).
fn validate_repo_path(repo_path: &str, open_repos: &[String]) -> Result<(), String> {
    let path = std::path::Path::new(repo_path);

    // Must be an absolute path
    if !path.is_absolute() {
        return Err("Repository path must be absolute".to_string());
    }

    // Canonicalize to resolve symlinks and ../ traversals
    let canonical = path
        .canonicalize()
        .map_err(|_| format!("Repository path does not exist: {}", repo_path))?;

    // If we have open repos registered, only allow access to those
    if !open_repos.is_empty() {
        let canonical_str = canonical.to_string_lossy();
        let allowed = open_repos.iter().any(|r| {
            if let Ok(c) = std::path::Path::new(r).canonicalize() {
                canonical_str.starts_with(&*c.to_string_lossy())
            } else {
                false
            }
        });
        if !allowed {
            return Err(format!(
                "Access denied: '{}' is not an open repository",
                repo_path
            ));
        }
    }

    // Verify it's actually a git repository
    git2::Repository::open(&canonical)
        .map_err(|_| format!("Not a valid git repository: {}", repo_path))?;

    Ok(())
}

/// Call a tool by name with the given arguments
pub async fn call_tool(
    name: &str,
    arguments: &Value,
    open_repos: &[String],
) -> Result<Value, String> {
    match name {
        "get_commit_history" => {
            let params: CommitHistoryParams = serde_json::from_value(arguments.clone())
                .map_err(|e| format!("Invalid arguments: {}", e))?;
            validate_repo_path(&params.repo_path, open_repos)?;
            tool_get_commit_history(params)
        }
        "get_branches" => {
            let params: BranchesParams = serde_json::from_value(arguments.clone())
                .map_err(|e| format!("Invalid arguments: {}", e))?;
            validate_repo_path(&params.repo_path, open_repos)?;
            tool_get_branches(params)
        }
        "get_status" => {
            let params: StatusParams = serde_json::from_value(arguments.clone())
                .map_err(|e| format!("Invalid arguments: {}", e))?;
            validate_repo_path(&params.repo_path, open_repos)?;
            tool_get_status(params)
        }
        "get_diff" => {
            let params: DiffParams = serde_json::from_value(arguments.clone())
                .map_err(|e| format!("Invalid arguments: {}", e))?;
            validate_repo_path(&params.repo_path, open_repos)?;
            tool_get_diff(params)
        }
        "get_file_blame" => {
            let params: BlameParams = serde_json::from_value(arguments.clone())
                .map_err(|e| format!("Invalid arguments: {}", e))?;
            validate_repo_path(&params.repo_path, open_repos)?;
            tool_get_file_blame(params)
        }
        "search_commits" => {
            let params: SearchCommitsParams = serde_json::from_value(arguments.clone())
                .map_err(|e| format!("Invalid arguments: {}", e))?;
            validate_repo_path(&params.repo_path, open_repos)?;
            tool_search_commits(params)
        }
        "get_open_repositories" => tool_get_open_repositories(open_repos),
        _ => Err(format!("Unknown tool: {}", name)),
    }
}

/// Get commit history for a repository
fn tool_get_commit_history(params: CommitHistoryParams) -> Result<Value, String> {
    let repo = git2::Repository::open(&params.repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let count = params.count.unwrap_or(20) as usize;

    let mut revwalk = repo
        .revwalk()
        .map_err(|e| format!("Failed to create revwalk: {}", e))?;

    // Start from the specified branch or HEAD
    if let Some(ref branch) = params.branch {
        let reference = repo
            .resolve_reference_from_short_name(branch)
            .map_err(|e| format!("Failed to resolve branch '{}': {}", branch, e))?;
        let oid = reference
            .target()
            .ok_or_else(|| format!("Branch '{}' has no target", branch))?;
        revwalk
            .push(oid)
            .map_err(|e| format!("Failed to push to revwalk: {}", e))?;
    } else {
        revwalk
            .push_head()
            .map_err(|e| format!("Failed to push HEAD: {}", e))?;
    }

    revwalk.set_sorting(git2::Sort::TIME).ok();

    let mut commits = Vec::new();
    for oid_result in revwalk.take(count) {
        let oid = oid_result.map_err(|e| format!("Revwalk error: {}", e))?;
        let commit = repo
            .find_commit(oid)
            .map_err(|e| format!("Failed to find commit: {}", e))?;

        let author = commit.author();
        commits.push(serde_json::json!({
            "sha": oid.to_string(),
            "message": commit.message().unwrap_or("").to_string(),
            "author": author.name().unwrap_or("Unknown").to_string(),
            "date": commit.time().seconds()
        }));
    }

    Ok(Value::Array(commits))
}

/// List all branches in a repository
fn tool_get_branches(params: BranchesParams) -> Result<Value, String> {
    let repo = git2::Repository::open(&params.repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let head = repo.head().ok();
    let head_name = head
        .as_ref()
        .and_then(|h| h.shorthand().ok().map(String::from));

    let mut branches = Vec::new();

    for branch_result in repo
        .branches(None)
        .map_err(|e| format!("Failed to list branches: {}", e))?
    {
        let (branch, branch_type) =
            branch_result.map_err(|e| format!("Failed to get branch: {}", e))?;

        let name = branch
            .name()
            .map_err(|e| format!("Failed to get branch name: {}", e))?
            .unwrap_or("unknown")
            .to_string();

        let is_remote = branch_type == git2::BranchType::Remote;
        let is_current = !is_remote && head_name.as_deref() == Some(&name);

        branches.push(serde_json::json!({
            "name": name,
            "isCurrent": is_current,
            "isRemote": is_remote
        }));
    }

    Ok(Value::Array(branches))
}

/// Get working directory status
fn tool_get_status(params: StatusParams) -> Result<Value, String> {
    let repo = git2::Repository::open(&params.repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let statuses = repo
        .statuses(Some(
            git2::StatusOptions::new()
                .include_untracked(true)
                .recurse_untracked_dirs(true),
        ))
        .map_err(|e| format!("Failed to get status: {}", e))?;

    let mut staged = Vec::new();
    let mut modified = Vec::new();
    let mut untracked = Vec::new();

    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let status = entry.status();

        if status.intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED
                | git2::Status::INDEX_TYPECHANGE,
        ) {
            staged.push(path.clone());
        }

        if status.intersects(
            git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_RENAMED
                | git2::Status::WT_TYPECHANGE,
        ) {
            modified.push(path.clone());
        }

        if status.contains(git2::Status::WT_NEW) {
            untracked.push(path);
        }
    }

    Ok(serde_json::json!({
        "staged": staged,
        "modified": modified,
        "untracked": untracked
    }))
}

/// Get diff for working directory or between two refs
fn tool_get_diff(params: DiffParams) -> Result<Value, String> {
    let repo = git2::Repository::open(&params.repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let diff = if let (Some(from_ref), Some(to_ref)) = (&params.from_ref, &params.to_ref) {
        // Diff between two refs
        let from_obj = repo
            .revparse_single(from_ref)
            .map_err(|e| format!("Failed to resolve '{}': {}", from_ref, e))?;
        let to_obj = repo
            .revparse_single(to_ref)
            .map_err(|e| format!("Failed to resolve '{}': {}", to_ref, e))?;

        let from_tree = from_obj
            .peel_to_tree()
            .map_err(|e| format!("Failed to get tree for '{}': {}", from_ref, e))?;
        let to_tree = to_obj
            .peel_to_tree()
            .map_err(|e| format!("Failed to get tree for '{}': {}", to_ref, e))?;

        repo.diff_tree_to_tree(Some(&from_tree), Some(&to_tree), None)
            .map_err(|e| format!("Failed to create diff: {}", e))?
    } else if let Some(from_ref) = &params.from_ref {
        // Diff from a ref to working directory
        let from_obj = repo
            .revparse_single(from_ref)
            .map_err(|e| format!("Failed to resolve '{}': {}", from_ref, e))?;
        let from_tree = from_obj
            .peel_to_tree()
            .map_err(|e| format!("Failed to get tree for '{}': {}", from_ref, e))?;

        repo.diff_tree_to_workdir_with_index(Some(&from_tree), None)
            .map_err(|e| format!("Failed to create diff: {}", e))?
    } else {
        // Working directory diff (unstaged changes)
        let head = repo.head().ok();
        let head_tree = head.and_then(|h| h.peel_to_tree().ok());

        repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), None)
            .map_err(|e| format!("Failed to create diff: {}", e))?
    };

    let mut diff_str = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        if let Ok(content) = std::str::from_utf8(line.content()) {
            let prefix = match line.origin() {
                '+' => "+",
                '-' => "-",
                ' ' => " ",
                _ => "",
            };
            diff_str.push_str(prefix);
            diff_str.push_str(content);
        }
        true
    })
    .map_err(|e| format!("Failed to print diff: {}", e))?;

    Ok(serde_json::json!({
        "diff": diff_str
    }))
}

/// Get blame information for a file
fn tool_get_file_blame(params: BlameParams) -> Result<Value, String> {
    let repo = git2::Repository::open(&params.repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let blame = repo
        .blame_file(std::path::Path::new(&params.file_path), None)
        .map_err(|e| format!("Failed to get blame for '{}': {}", params.file_path, e))?;

    let mut hunks = Vec::new();
    for i in 0..blame.len() {
        if let Some(hunk) = blame.get_index(i) {
            // `final_signature()` returns `Option<Signature>` (git2 0.21), so a hunk
            // without a recoverable signature falls back to "Unknown"/epoch 0 rather
            // than panicking.
            let sig = hunk.final_signature();
            let author_name = sig
                .as_ref()
                .and_then(|s| s.name().ok())
                .unwrap_or("Unknown")
                .to_string();
            let date = sig.as_ref().map(|s| s.when().seconds()).unwrap_or(0);
            hunks.push(serde_json::json!({
                "lineStart": hunk.final_start_line(),
                "lineEnd": hunk.final_start_line() + hunk.lines_in_hunk() - 1,
                "author": author_name,
                "commitSha": hunk.final_commit_id().to_string(),
                "date": date
            }));
        }
    }

    Ok(Value::Array(hunks))
}

/// Search commits by message content
fn tool_search_commits(params: SearchCommitsParams) -> Result<Value, String> {
    let repo = git2::Repository::open(&params.repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let max_results = params.max_results.unwrap_or(20) as usize;
    let query_lower = params.query.to_lowercase();

    let mut revwalk = repo
        .revwalk()
        .map_err(|e| format!("Failed to create revwalk: {}", e))?;

    revwalk
        .push_head()
        .map_err(|e| format!("Failed to push HEAD: {}", e))?;

    revwalk.set_sorting(git2::Sort::TIME).ok();

    let mut results = Vec::new();
    for oid_result in revwalk {
        if results.len() >= max_results {
            break;
        }

        let oid = match oid_result {
            Ok(oid) => oid,
            Err(_) => continue,
        };

        let commit = match repo.find_commit(oid) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let message = commit.message().unwrap_or("");
        if message.to_lowercase().contains(&query_lower) {
            let author = commit.author();
            results.push(serde_json::json!({
                "sha": oid.to_string(),
                "message": message.to_string(),
                "author": author.name().unwrap_or("Unknown").to_string(),
                "date": commit.time().seconds()
            }));
        }
    }

    Ok(Value::Array(results))
}

/// Get the list of open repositories
fn tool_get_open_repositories(open_repos: &[String]) -> Result<Value, String> {
    let repos: Vec<Value> = open_repos
        .iter()
        .map(|path| {
            serde_json::json!({
                "path": path
            })
        })
        .collect();

    Ok(Value::Array(repos))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    // ========================================================================
    // Tool list tests
    // ========================================================================

    #[test]
    fn test_get_tool_list_returns_all_tools() {
        let tools = get_tool_list();
        assert_eq!(tools.len(), 7);

        let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"get_commit_history"));
        assert!(names.contains(&"get_branches"));
        assert!(names.contains(&"get_status"));
        assert!(names.contains(&"get_diff"));
        assert!(names.contains(&"get_file_blame"));
        assert!(names.contains(&"search_commits"));
        assert!(names.contains(&"get_open_repositories"));
    }

    #[test]
    fn test_tool_has_required_fields() {
        let tools = get_tool_list();
        for tool in &tools {
            assert!(!tool.name.is_empty());
            assert!(!tool.description.is_empty());
            assert!(tool.input_schema.is_object());
            assert_eq!(tool.input_schema["type"], "object");
        }
    }

    #[test]
    fn test_tool_serialization() {
        let tools = get_tool_list();
        let json = serde_json::to_string(&tools).expect("Failed to serialize tools");
        assert!(json.contains("get_commit_history"));
        assert!(json.contains("inputSchema"));
    }

    // ========================================================================
    // get_open_repositories tests
    // ========================================================================

    #[tokio::test]
    async fn test_get_open_repositories_empty() {
        let result = call_tool("get_open_repositories", &serde_json::json!({}), &[]).await;
        assert!(result.is_ok());
        let repos = result.unwrap();
        assert!(repos.is_array());
        assert!(repos.as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_get_open_repositories_with_repos() {
        let open = vec!["/path/to/repo1".to_string(), "/path/to/repo2".to_string()];
        let result = call_tool("get_open_repositories", &serde_json::json!({}), &open).await;
        assert!(result.is_ok());
        let repos = result.unwrap();
        let arr = repos.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["path"], "/path/to/repo1");
        assert_eq!(arr[1]["path"], "/path/to/repo2");
    }

    // ========================================================================
    // Unknown tool tests
    // ========================================================================

    #[tokio::test]
    async fn test_unknown_tool() {
        let result = call_tool("nonexistent_tool", &serde_json::json!({}), &[]).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown tool"));
    }

    // ========================================================================
    // get_commit_history tests
    // ========================================================================

    #[tokio::test]
    async fn test_get_commit_history() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("Second commit", &[("file.txt", "content")]);
        test_repo.create_commit("Third commit", &[("file2.txt", "content2")]);

        let result = call_tool(
            "get_commit_history",
            &serde_json::json!({
                "repo_path": test_repo.path_str(),
                "count": 10
            }),
            &[],
        )
        .await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        let arr = commits.as_array().unwrap();
        assert_eq!(arr.len(), 3);
        // Most recent first
        assert!(arr[0]["message"].as_str().unwrap().contains("Third commit"));
    }

    #[tokio::test]
    async fn test_get_commit_history_with_limit() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("Second commit", &[("file.txt", "content")]);
        test_repo.create_commit("Third commit", &[("file2.txt", "content2")]);

        let result = call_tool(
            "get_commit_history",
            &serde_json::json!({
                "repo_path": test_repo.path_str(),
                "count": 1
            }),
            &[],
        )
        .await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        assert_eq!(commits.as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_get_commit_history_invalid_repo() {
        let result = call_tool(
            "get_commit_history",
            &serde_json::json!({
                "repo_path": "/nonexistent/repo"
            }),
            &[],
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_commit_history_with_branch() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        test_repo.create_commit("Feature commit", &[("feature.txt", "feature content")]);

        let result = call_tool(
            "get_commit_history",
            &serde_json::json!({
                "repo_path": test_repo.path_str(),
                "branch": "feature"
            }),
            &[],
        )
        .await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        let arr = commits.as_array().unwrap();
        assert_eq!(arr.len(), 2); // feature commit + initial
        assert!(arr[0]["message"]
            .as_str()
            .unwrap()
            .contains("Feature commit"));
    }

    // ========================================================================
    // get_branches tests
    // ========================================================================

    #[tokio::test]
    async fn test_get_branches() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_branch("feature");
        test_repo.create_branch("develop");

        let result = call_tool(
            "get_branches",
            &serde_json::json!({
                "repo_path": test_repo.path_str()
            }),
            &[],
        )
        .await;

        assert!(result.is_ok());
        let branches = result.unwrap();
        let arr = branches.as_array().unwrap();
        assert!(arr.len() >= 3); // main, feature, develop

        // Find main and check it's current
        let main_branch = arr.iter().find(|b| b["name"] == "main");
        assert!(main_branch.is_some());
        assert!(main_branch.unwrap()["isCurrent"].as_bool().unwrap());
    }

    #[tokio::test]
    async fn test_get_branches_invalid_repo() {
        let result = call_tool(
            "get_branches",
            &serde_json::json!({
                "repo_path": "/nonexistent/repo"
            }),
            &[],
        )
        .await;

        assert!(result.is_err());
    }

    // ========================================================================
    // get_status tests
    // ========================================================================

    #[tokio::test]
    async fn test_get_status_clean() {
        let test_repo = TestRepo::with_initial_commit();

        let result = call_tool(
            "get_status",
            &serde_json::json!({
                "repo_path": test_repo.path_str()
            }),
            &[],
        )
        .await;

        assert!(result.is_ok());
        let status = result.unwrap();
        assert!(status["staged"].as_array().unwrap().is_empty());
        assert!(status["modified"].as_array().unwrap().is_empty());
        assert!(status["untracked"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_get_status_with_changes() {
        let test_repo = TestRepo::with_initial_commit();

        // Create an untracked file
        test_repo.create_file("untracked.txt", "untracked content");

        // Create and stage a file
        test_repo.create_file("staged.txt", "staged content");
        test_repo.stage_file("staged.txt");

        // Modify an existing file
        test_repo.create_file("README.md", "modified content");

        let result = call_tool(
            "get_status",
            &serde_json::json!({
                "repo_path": test_repo.path_str()
            }),
            &[],
        )
        .await;

        assert!(result.is_ok());
        let status = result.unwrap();

        let staged: Vec<&str> = status["staged"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(staged.contains(&"staged.txt"));

        let untracked: Vec<&str> = status["untracked"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(untracked.contains(&"untracked.txt"));
    }

    // ========================================================================
    // get_diff tests
    // ========================================================================

    #[tokio::test]
    async fn test_get_diff_working_directory() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_file("README.md", "modified content");

        let result = call_tool(
            "get_diff",
            &serde_json::json!({
                "repo_path": test_repo.path_str()
            }),
            &[],
        )
        .await;

        assert!(result.is_ok());
        let diff_result = result.unwrap();
        let diff_str = diff_result["diff"].as_str().unwrap();
        assert!(diff_str.contains("-# Test Repo"));
        assert!(diff_str.contains("+modified content"));
    }

    #[tokio::test]
    async fn test_get_diff_no_changes() {
        let test_repo = TestRepo::with_initial_commit();

        let result = call_tool(
            "get_diff",
            &serde_json::json!({
                "repo_path": test_repo.path_str()
            }),
            &[],
        )
        .await;

        assert!(result.is_ok());
        let diff_result = result.unwrap();
        let diff_str = diff_result["diff"].as_str().unwrap();
        assert!(diff_str.is_empty());
    }

    #[tokio::test]
    async fn test_get_diff_between_refs() {
        let test_repo = TestRepo::with_initial_commit();
        let first_sha = test_repo.head_oid().to_string();

        test_repo.create_commit("Second commit", &[("new_file.txt", "new content")]);
        let second_sha = test_repo.head_oid().to_string();

        let result = call_tool(
            "get_diff",
            &serde_json::json!({
                "repo_path": test_repo.path_str(),
                "from_ref": first_sha,
                "to_ref": second_sha
            }),
            &[],
        )
        .await;

        assert!(result.is_ok());
        let diff_result = result.unwrap();
        let diff_str = diff_result["diff"].as_str().unwrap();
        assert!(diff_str.contains("+new content"));
    }

    // ========================================================================
    // get_file_blame tests
    // ========================================================================

    #[tokio::test]
    async fn test_get_file_blame() {
        let test_repo = TestRepo::with_initial_commit();

        let result = call_tool(
            "get_file_blame",
            &serde_json::json!({
                "repo_path": test_repo.path_str(),
                "file_path": "README.md"
            }),
            &[],
        )
        .await;

        assert!(result.is_ok());
        let hunks = result.unwrap();
        let arr = hunks.as_array().unwrap();
        assert!(!arr.is_empty());
        assert_eq!(arr[0]["author"], "Test User");
        assert!(arr[0]["commitSha"].as_str().is_some());
    }

    #[tokio::test]
    async fn test_get_file_blame_nonexistent_file() {
        let test_repo = TestRepo::with_initial_commit();

        let result = call_tool(
            "get_file_blame",
            &serde_json::json!({
                "repo_path": test_repo.path_str(),
                "file_path": "nonexistent.txt"
            }),
            &[],
        )
        .await;

        assert!(result.is_err());
    }

    // ========================================================================
    // search_commits tests
    // ========================================================================

    #[tokio::test]
    async fn test_search_commits() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("feat: add login page", &[("login.txt", "login")]);
        test_repo.create_commit("fix: resolve crash on startup", &[("fix.txt", "fix")]);
        test_repo.create_commit("feat: add dashboard", &[("dash.txt", "dashboard")]);

        let result = call_tool(
            "search_commits",
            &serde_json::json!({
                "repo_path": test_repo.path_str(),
                "query": "feat"
            }),
            &[],
        )
        .await;

        assert!(result.is_ok());
        let results = result.unwrap();
        let arr = results.as_array().unwrap();
        assert_eq!(arr.len(), 2);
    }

    #[tokio::test]
    async fn test_search_commits_case_insensitive() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("FEAT: add feature", &[("f.txt", "content")]);

        let result = call_tool(
            "search_commits",
            &serde_json::json!({
                "repo_path": test_repo.path_str(),
                "query": "feat"
            }),
            &[],
        )
        .await;

        assert!(result.is_ok());
        let results = result.unwrap();
        assert_eq!(results.as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_search_commits_no_results() {
        let test_repo = TestRepo::with_initial_commit();

        let result = call_tool(
            "search_commits",
            &serde_json::json!({
                "repo_path": test_repo.path_str(),
                "query": "nonexistent_query_xyz"
            }),
            &[],
        )
        .await;

        assert!(result.is_ok());
        let results = result.unwrap();
        assert!(results.as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_search_commits_with_max_results() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("feat: one", &[("a.txt", "a")]);
        test_repo.create_commit("feat: two", &[("b.txt", "b")]);
        test_repo.create_commit("feat: three", &[("c.txt", "c")]);

        let result = call_tool(
            "search_commits",
            &serde_json::json!({
                "repo_path": test_repo.path_str(),
                "query": "feat",
                "max_results": 2
            }),
            &[],
        )
        .await;

        assert!(result.is_ok());
        let results = result.unwrap();
        assert_eq!(results.as_array().unwrap().len(), 2);
    }

    // ========================================================================
    // Invalid arguments tests
    // ========================================================================

    // ========================================================================
    // Path validation tests
    // ========================================================================

    #[test]
    fn test_validate_repo_path_relative_rejected() {
        let result = validate_repo_path("../some/repo", &[]);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("absolute"));
    }

    #[test]
    fn test_validate_repo_path_nonexistent_rejected() {
        // Built from the platform's temp dir rather than hardcoded as
        // "/nonexistent/...": a leading-slash-only path has no drive prefix, so
        // `Path::is_absolute` is false for it on Windows and the earlier
        // "must be absolute" arm answered instead of the one under test.
        let missing = std::env::temp_dir().join("gitnado-definitely-nonexistent-repo");
        let result = validate_repo_path(&missing.to_string_lossy(), &[]);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does not exist"));
    }

    #[test]
    fn test_validate_repo_path_not_in_open_repos() {
        let test_repo = TestRepo::with_initial_commit();
        let open_repos = vec!["/some/other/repo".to_string()];
        let result = validate_repo_path(&test_repo.path_str(), &open_repos);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Access denied"));
    }

    #[test]
    fn test_validate_repo_path_in_open_repos() {
        let test_repo = TestRepo::with_initial_commit();
        let path = test_repo.path_str();
        let open_repos = vec![path.clone()];
        let result = validate_repo_path(&path, &open_repos);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_repo_path_empty_open_repos_allows_valid_repo() {
        let test_repo = TestRepo::with_initial_commit();
        let result = validate_repo_path(&test_repo.path_str(), &[]);
        assert!(result.is_ok());
    }

    // ========================================================================
    // Invalid arguments tests
    // ========================================================================

    #[tokio::test]
    async fn test_call_tool_invalid_arguments() {
        let result = call_tool(
            "get_commit_history",
            &serde_json::json!({"wrong_field": 123}),
            &[],
        )
        .await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid arguments"));
    }
}
