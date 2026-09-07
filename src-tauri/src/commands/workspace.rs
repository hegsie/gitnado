//! Workspace command handlers
//! Manage multi-repository workspaces

use std::fs;
use std::io::{BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};

use chrono::Utc;
use git2::Repository;
use tauri::command;
use uuid::Uuid;

use crate::commands::search::{find_match_position, read_grep_records};
use crate::error::{GitnadoError, Result};
use crate::models::{Workspace, WorkspaceRepoStatus, WorkspaceRepository, WorkspacesConfig};

/// A single search match across workspace repositories
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchResult {
    pub repo_name: String,
    pub repo_path: String,
    pub file_path: String,
    pub line_number: u32,
    pub line_content: String,
    pub match_start: u32,
    pub match_end: u32,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchResponse {
    pub results: Vec<WorkspaceSearchResult>,
    pub failures: Vec<String>,
}

/// Run `git grep` in one repository. Errors carry only the underlying detail;
/// the repository name is attached once, by the caller, so every entry in the
/// user-visible failure list has the same shape.
fn run_workspace_grep(
    repo_entry: &WorkspaceRepository,
    query: &str,
    case_sensitive: bool,
    use_regex: bool,
    file_pattern: Option<&str>,
    limit: usize,
) -> std::result::Result<Vec<(String, u32, String)>, String> {
    let mut cmd = Command::new("git");
    // `--no-color` because the records are parsed byte-for-byte: a user with
    // `color.grep` (or `color.ui`) set to `always` gets SGR escapes around the
    // path and the line number even into a pipe, and every match would then be
    // dropped by the line-number parse rather than shown. `--no-column` for the
    // same reason: `grep.column` adds a third NUL-delimited field, which would
    // be read as the line content and shown with the column number and a raw
    // NUL byte in front of the code.
    cmd.arg("-C")
        .arg(&repo_entry.path)
        .arg("grep")
        .arg("--no-color")
        .arg("--no-column")
        .arg("-n")
        .arg("-z")
        .arg("-I");

    if !case_sensitive {
        cmd.arg("-i");
    }
    if use_regex {
        cmd.arg("-E");
    } else {
        cmd.arg("-F");
    }

    cmd.arg("-e").arg(query).arg("--");
    if let Some(pattern) = file_pattern {
        cmd.arg(pattern);
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|error| error.to_string())?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture git grep errors".to_string())?;
    let stderr_reader = std::thread::spawn(move || {
        let mut stderr = stderr;
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture git grep output".to_string())?;
    let mut stdout = BufReader::new(stdout);
    let records = read_grep_records(&mut stdout, limit).map_err(|error| error.to_string())?;

    let reached_limit = records.len() == limit;
    if reached_limit {
        let _ = child.kill();
    }
    let status = child.wait().map_err(|error| error.to_string())?;
    let stderr = stderr_reader.join().unwrap_or_default();

    // git grep returns exit code 1 when no matches are found.
    if !reached_limit && !status.success() && status.code() != Some(1) {
        let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
        let details = if stderr.is_empty() {
            format!("git grep exited with {}", status)
        } else {
            stderr
        };
        return Err(details);
    }

    Ok(records)
}

/// Search one repository, returning a ready-to-display failure message on
/// error so every entry in `failures` reads the same way.
fn search_repository(
    repo_entry: &WorkspaceRepository,
    query: &str,
    case_sensitive: bool,
    use_regex: bool,
    file_pattern: Option<&str>,
    limit: usize,
) -> std::result::Result<Vec<(String, u32, String)>, String> {
    if !Path::new(&repo_entry.path).exists() {
        return Err(format!(
            "Failed to search repository \"{}\": repository path does not exist",
            repo_entry.name
        ));
    }

    run_workspace_grep(
        repo_entry,
        query,
        case_sensitive,
        use_regex,
        file_pattern,
        limit,
    )
    .map_err(|detail| {
        format!(
            "Failed to search repository \"{}\": {}",
            repo_entry.name, detail
        )
    })
}

/// Search every repository in turn, collecting matches and per-repository
/// failures. Both ways of hitting the global match limit are reported —
/// repositories left unsearched, and matches dropped inside the repository that
/// consumed the limit — so a truncated list never reads as a complete one.
fn search_repositories(
    repositories: &[WorkspaceRepository],
    query: &str,
    case_sensitive: bool,
    use_regex: bool,
    file_pattern: Option<&str>,
    max_results: u32,
) -> WorkspaceSearchResponse {
    let mut results: Vec<WorkspaceSearchResult> = Vec::new();
    let mut failures = Vec::new();
    let mut skipped_repositories = false;
    let mut truncated_matches = false;

    for (index, repo_entry) in repositories.iter().enumerate() {
        if results.len() as u32 >= max_results {
            let skipped = repositories.len() - index;
            failures.push(format!(
                "Stopped at the {}-match limit; {} {} not searched",
                max_results,
                skipped,
                if skipped == 1 {
                    "repository was"
                } else {
                    "repositories were"
                }
            ));
            skipped_repositories = true;
            break;
        }

        let remaining = max_results.saturating_sub(results.len() as u32) as usize;
        // Ask for one more match than can be kept: a repository holding more
        // than the limit is otherwise indistinguishable from one holding
        // exactly the limit, and its dropped matches would go unreported.
        let mut matches = match search_repository(
            repo_entry,
            query,
            case_sensitive,
            use_regex,
            file_pattern,
            remaining + 1,
        ) {
            Ok(matches) => matches,
            Err(failure) => {
                failures.push(failure);
                continue;
            }
        };

        if matches.len() > remaining {
            matches.truncate(remaining);
            truncated_matches = true;
        }

        for (file_path, line_number, line_content) in matches {
            let (match_start, match_end) =
                find_match_position(&line_content, query, case_sensitive);

            results.push(WorkspaceSearchResult {
                repo_name: repo_entry.name.clone(),
                repo_path: repo_entry.path.clone(),
                file_path,
                line_number,
                line_content,
                match_start,
                match_end,
            });
        }
    }

    // The repository that consumed the limit had more to give. Only say so when
    // no repository was skipped, otherwise the skipped line already reports it.
    if truncated_matches && !skipped_repositories {
        failures.push(format!(
            "Stopped at the {}-match limit; more matches were not shown",
            max_results
        ));
    }

    WorkspaceSearchResponse { results, failures }
}

/// Get the path to the workspaces config file
fn get_workspaces_path() -> Result<std::path::PathBuf> {
    Ok(crate::utils::app_paths::config_dir()?.join("workspaces.json"))
}

/// Load workspaces config from disk
fn load_workspaces_config() -> Result<WorkspacesConfig> {
    let path = get_workspaces_path()?;

    if !path.exists() {
        return Ok(WorkspacesConfig::default());
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to read workspaces: {}", e)))?;

    let config: WorkspacesConfig = serde_json::from_str(&content)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse workspaces: {}", e)))?;

    Ok(config)
}

/// Save workspaces config to disk
fn save_workspaces_config(config: &WorkspacesConfig) -> Result<()> {
    let path = get_workspaces_path()?;

    let content = serde_json::to_string_pretty(config).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to serialize workspaces: {}", e))
    })?;

    fs::write(&path, content)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to write workspaces: {}", e)))?;

    Ok(())
}

/// Get all workspaces
#[command]
pub async fn get_workspaces() -> Result<Vec<Workspace>> {
    let config = load_workspaces_config()?;
    Ok(config.workspaces)
}

/// Get a single workspace by ID
#[command]
pub async fn get_workspace(workspace_id: String) -> Result<Workspace> {
    let config = load_workspaces_config()?;
    config
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| GitnadoError::OperationFailed("Workspace not found".to_string()))
}

/// Save a workspace (create or update)
/// If the id is empty, a new UUID is generated.
#[command]
pub async fn save_workspace(mut workspace: Workspace) -> Result<Workspace> {
    let mut config = load_workspaces_config()?;

    if workspace.id.is_empty() {
        workspace.id = Uuid::new_v4().to_string();
        workspace.created_at = Utc::now();
        config.workspaces.push(workspace.clone());
    } else if let Some(idx) = config.workspaces.iter().position(|w| w.id == workspace.id) {
        config.workspaces[idx] = workspace.clone();
    } else {
        config.workspaces.push(workspace.clone());
    }

    save_workspaces_config(&config)?;
    Ok(workspace)
}

/// Delete a workspace by ID
#[command]
pub async fn delete_workspace(workspace_id: String) -> Result<()> {
    let mut config = load_workspaces_config()?;
    config.workspaces.retain(|w| w.id != workspace_id);
    save_workspaces_config(&config)?;
    Ok(())
}

/// Add a repository to a workspace
#[command]
pub async fn add_repository_to_workspace(
    workspace_id: String,
    path: String,
    name: String,
) -> Result<Workspace> {
    let mut config = load_workspaces_config()?;

    let workspace = config
        .workspaces
        .iter_mut()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| GitnadoError::OperationFailed("Workspace not found".to_string()))?;

    // Don't add duplicates
    if !workspace.repositories.iter().any(|r| r.path == path) {
        workspace
            .repositories
            .push(WorkspaceRepository { path, name });
    }

    let result = workspace.clone();
    save_workspaces_config(&config)?;
    Ok(result)
}

/// Remove a repository from a workspace
#[command]
pub async fn remove_repository_from_workspace(
    workspace_id: String,
    path: String,
) -> Result<Workspace> {
    let mut config = load_workspaces_config()?;

    let workspace = config
        .workspaces
        .iter_mut()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| GitnadoError::OperationFailed("Workspace not found".to_string()))?;

    workspace.repositories.retain(|r| r.path != path);

    let result = workspace.clone();
    save_workspaces_config(&config)?;
    Ok(result)
}

/// Update the last_opened timestamp for a workspace
#[command]
pub async fn update_workspace_last_opened(workspace_id: String) -> Result<()> {
    let mut config = load_workspaces_config()?;

    if let Some(workspace) = config.workspaces.iter_mut().find(|w| w.id == workspace_id) {
        workspace.last_opened = Some(Utc::now());
        save_workspaces_config(&config)?;
    }

    Ok(())
}

/// Validate all repositories in a workspace, returning status for each
#[command]
pub async fn validate_workspace_repositories(
    workspace_id: String,
) -> Result<Vec<WorkspaceRepoStatus>> {
    let config = load_workspaces_config()?;

    let workspace = config
        .workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| GitnadoError::OperationFailed("Workspace not found".to_string()))?;

    let mut statuses = Vec::new();

    for repo_entry in &workspace.repositories {
        let repo_path = Path::new(&repo_entry.path);
        let exists = repo_path.exists();

        if !exists {
            statuses.push(WorkspaceRepoStatus {
                path: repo_entry.path.clone(),
                name: repo_entry.name.clone(),
                exists: false,
                is_valid_repo: false,
                changed_files_count: 0,
                current_branch: None,
                is_detached: false,
                ahead: 0,
                behind: 0,
            });
            continue;
        }

        match Repository::open(repo_path) {
            Ok(repo) => {
                let (current_branch, is_detached) = head_branch(&repo);

                let changed_files_count = repo
                    .statuses(Some(
                        git2::StatusOptions::new()
                            .include_untracked(true)
                            .recurse_untracked_dirs(false),
                    ))
                    .map(|statuses| statuses.len())
                    .unwrap_or(0);

                // Compute ahead/behind relative to upstream
                let (ahead, behind) = compute_ahead_behind(&repo);

                statuses.push(WorkspaceRepoStatus {
                    path: repo_entry.path.clone(),
                    name: repo_entry.name.clone(),
                    exists: true,
                    is_valid_repo: true,
                    changed_files_count,
                    current_branch,
                    is_detached,
                    ahead,
                    behind,
                });
            }
            Err(_) => {
                statuses.push(WorkspaceRepoStatus {
                    path: repo_entry.path.clone(),
                    name: repo_entry.name.clone(),
                    exists: true,
                    is_valid_repo: false,
                    changed_files_count: 0,
                    current_branch: None,
                    is_detached: false,
                    ahead: 0,
                    behind: 0,
                });
            }
        }
    }

    Ok(statuses)
}

/// Search across all repositories in a workspace using git grep
#[command]
pub async fn search_workspace(
    workspace_id: String,
    query: String,
    case_sensitive: Option<bool>,
    regex: Option<bool>,
    file_pattern: Option<String>,
    max_results: Option<u32>,
) -> Result<WorkspaceSearchResponse> {
    let config = load_workspaces_config()?;
    let workspace = config
        .workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| GitnadoError::OperationFailed("Workspace not found".to_string()))?;

    Ok(search_repositories(
        &workspace.repositories,
        &query,
        case_sensitive.unwrap_or(false),
        regex.unwrap_or(false),
        file_pattern.as_deref(),
        max_results.unwrap_or(500),
    ))
}

/// Export a workspace configuration as a JSON string
#[command]
pub async fn export_workspace(workspace_id: String) -> Result<String> {
    let config = load_workspaces_config()?;
    let workspace = config
        .workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| GitnadoError::OperationFailed("Workspace not found".to_string()))?;

    let json = serde_json::to_string_pretty(workspace).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to serialize workspace: {}", e))
    })?;

    Ok(json)
}

/// Import a workspace from a JSON string
#[command]
pub async fn import_workspace(json_data: String) -> Result<Workspace> {
    let mut workspace: Workspace = serde_json::from_str(&json_data).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse workspace JSON: {}", e))
    })?;

    // Generate a new ID and creation timestamp
    workspace.id = Uuid::new_v4().to_string();
    workspace.created_at = Utc::now();
    workspace.last_opened = None;

    let mut config = load_workspaces_config()?;
    config.workspaces.push(workspace.clone());
    save_workspaces_config(&config)?;

    Ok(workspace)
}

/// The checked-out branch name, plus whether HEAD is detached.
///
/// `shorthand()` returns the literal "HEAD" on a detached HEAD, which the
/// workspace dialog then rendered as if it were a branch called "HEAD". An
/// unborn HEAD has no branch yet and is not detached either.
fn head_branch(repo: &Repository) -> (Option<String>, bool) {
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return (None, false),
    };

    if !head.is_branch() {
        return (None, true);
    }

    (head.shorthand().ok().map(String::from), false)
}

/// Compute ahead/behind counts for HEAD relative to its configured upstream
/// tracking branch
fn compute_ahead_behind(repo: &Repository) -> (usize, usize) {
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return (0, 0),
    };

    // A detached HEAD is not a branch, so it has no upstream to compare
    // against. shorthand() is the literal "HEAD" when detached, which used to
    // resolve refs/remotes/origin/HEAD — the remote's default-branch pointer —
    // and count the checked-out commit against it.
    if !head.is_branch() {
        return (0, 0);
    }

    let local_oid = match head.target() {
        Some(oid) => oid,
        None => return (0, 0),
    };

    let branch_name = match head.shorthand() {
        Ok(name) => name,
        Err(_) => return (0, 0),
    };

    // Follow the branch's own upstream (branch.<name>.remote/merge) rather than
    // assuming origin/<branch>. A fork tracking upstream/main, a clone whose
    // remote is not called "origin", and a branch tracking a differently named
    // remote branch each counted against the wrong ref or reported nothing —
    // and disagreed with the branches panel for the same repository, which has
    // always used the configured upstream. A branch with no upstream has
    // nothing to report, which is not a failure.
    let upstream = match repo
        .find_branch(branch_name, git2::BranchType::Local)
        .and_then(|b| b.upstream())
    {
        Ok(u) => u,
        Err(_) => return (0, 0),
    };

    let upstream_oid = match upstream.get().target() {
        Some(oid) => oid,
        None => return (0, 0),
    };

    repo.graph_ahead_behind(local_oid, upstream_oid)
        .unwrap_or((0, 0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    /// Commit on top of `parent` without moving any ref — stands in for
    /// commits that only exist on the remote-tracking side.
    fn dangling_commit(repo: &Repository, parent: git2::Oid, message: &str) -> git2::Oid {
        let parent_commit = repo.find_commit(parent).expect("parent commit");
        let tree = parent_commit.tree().expect("parent tree");
        let sig = repo.signature().expect("signature");
        repo.commit(None, &sig, &sig, message, &tree, &[&parent_commit])
            .expect("commit")
    }

    fn set_remote_ref(repo: &Repository, refname: &str, oid: git2::Oid) {
        repo.reference(refname, oid, true, "test").expect("ref");
    }

    /// Fork workflow: `origin` is your stale fork, the branch tracks
    /// `upstream/main`. Counting against origin/<branch> reported "in sync"
    /// for a branch that is two commits ahead of what it actually tracks.
    #[test]
    fn test_ahead_behind_follows_the_configured_upstream_not_origin() {
        let test_repo = TestRepo::with_initial_commit();
        let base = test_repo.head_oid();
        test_repo.create_commit("Local 1", &[("a.txt", "a")]);
        test_repo.create_commit("Local 2", &[("b.txt", "b")]);
        let local_tip = test_repo.head_oid();

        let repo = test_repo.repo();
        let branch = test_repo.current_branch();
        repo.remote("origin", "https://example.com/fork.git")
            .unwrap();
        repo.remote("upstream", "https://example.com/canonical.git")
            .unwrap();

        // The fork is up to date with the local branch; the real upstream is not.
        set_remote_ref(&repo, &format!("refs/remotes/origin/{}", branch), local_tip);
        set_remote_ref(&repo, &format!("refs/remotes/upstream/{}", branch), base);

        repo.find_branch(&branch, git2::BranchType::Local)
            .unwrap()
            .set_upstream(Some(&format!("upstream/{}", branch)))
            .unwrap();

        assert_eq!(compute_ahead_behind(&repo), (2, 0));
    }

    /// `git clone -o github` (or a renamed remote): there is no
    /// refs/remotes/origin/* at all, so a hard-coded origin lookup reported
    /// 0/0 while git reported divergence in both directions.
    #[test]
    fn test_ahead_behind_reports_divergence_when_the_remote_is_not_named_origin() {
        let test_repo = TestRepo::with_initial_commit();
        let base = test_repo.head_oid();
        test_repo.create_commit("Local 1", &[("a.txt", "a")]);

        let repo = test_repo.repo();
        let branch = test_repo.current_branch();
        repo.remote("github", "https://example.com/repo.git")
            .unwrap();
        assert!(repo.find_remote("origin").is_err(), "origin must not exist");

        let remote_1 = dangling_commit(&repo, base, "Remote 1");
        let remote_2 = dangling_commit(&repo, remote_1, "Remote 2");
        set_remote_ref(&repo, &format!("refs/remotes/github/{}", branch), remote_2);

        repo.find_branch(&branch, git2::BranchType::Local)
            .unwrap()
            .set_upstream(Some(&format!("github/{}", branch)))
            .unwrap();

        assert_eq!(compute_ahead_behind(&repo), (1, 2));
    }

    /// A branch with no upstream has nothing to report, even when a
    /// same-named remote-tracking ref happens to exist — git prints no
    /// ahead/behind for it, so neither should the workspace dialog.
    #[test]
    fn test_ahead_behind_is_zero_for_a_branch_with_no_upstream() {
        let test_repo = TestRepo::with_initial_commit();
        let base = test_repo.head_oid();
        // Creates refs/remotes/origin/<branch> only — no branch.<name>.merge.
        test_repo.create_remote_branch(&test_repo.current_branch(), base);
        test_repo.create_commit("Local 1", &[("a.txt", "a")]);
        test_repo.create_commit("Local 2", &[("b.txt", "b")]);

        let repo = test_repo.repo();
        let branch = test_repo.current_branch();
        assert!(
            repo.find_branch(&branch, git2::BranchType::Local)
                .unwrap()
                .upstream()
                .is_err(),
            "branch must have no configured upstream"
        );

        assert_eq!(compute_ahead_behind(&repo), (0, 0));
    }

    /// Detached HEAD: shorthand() is the literal "HEAD", which used to resolve
    /// refs/remotes/origin/HEAD. In a mirror-style clone that ref is a DIRECT
    /// ref to the remote's default branch, so the checked-out commit was
    /// counted against it.
    #[test]
    fn test_ahead_behind_on_a_detached_head_ignores_the_remote_head_pointer() {
        let test_repo = TestRepo::with_initial_commit();
        let base = test_repo.head_oid();
        test_repo.create_commit("Local 1", &[("a.txt", "a")]);
        test_repo.create_commit("Local 2", &[("b.txt", "b")]);
        let local_tip = test_repo.head_oid();

        let repo = test_repo.repo();
        set_remote_ref(&repo, "refs/remotes/origin/HEAD", base);
        repo.set_head_detached(local_tip).unwrap();
        assert!(
            !repo.head().unwrap().is_branch(),
            "HEAD must be detached for this test"
        );

        assert_eq!(compute_ahead_behind(&repo), (0, 0));
    }

    /// A detached HEAD is not a branch called "HEAD" — the dialog must not
    /// print one.
    #[test]
    fn test_head_branch_reports_a_detached_head_as_no_branch() {
        let test_repo = TestRepo::with_initial_commit();
        let repo = test_repo.repo();
        repo.set_head_detached(test_repo.head_oid()).unwrap();

        assert_eq!(head_branch(&repo), (None, true));
    }

    /// Guard against over-correcting: a checked-out branch still reports its
    /// name, and a fresh repository with an unborn HEAD is not "detached".
    #[test]
    fn test_head_branch_reports_the_checked_out_branch() {
        let test_repo = TestRepo::with_initial_commit();
        assert_eq!(
            head_branch(&test_repo.repo()),
            (Some(test_repo.current_branch()), false)
        );

        let empty = TestRepo::new();
        assert_eq!(head_branch(&empty.repo()), (None, false));
    }

    #[test]
    fn test_workspace_grep_treats_plain_query_as_literal_text() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit(
            "Add search content",
            &[("search.txt", "literal a.b\nregex axb\n")],
        );
        let entry = WorkspaceRepository {
            path: repo.path_str(),
            name: "search-repo".to_string(),
        };

        let matches = run_workspace_grep(&entry, "a.b", true, false, None, 10).unwrap();

        assert_eq!(
            matches,
            vec![("search.txt".to_string(), 1, "literal a.b".to_string())]
        );
    }

    /// `color.grep = always` makes git colour its output even into a pipe. The
    /// records are parsed byte-for-byte, so without `--no-color` the escape
    /// codes wrapping the line number fail to parse and every match is silently
    /// dropped — a query that does match reads as "No results found".
    #[test]
    fn test_workspace_grep_ignores_forced_colour_output() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add search content", &[("search.txt", "literal a.b\n")]);
        repo.repo()
            .config()
            .unwrap()
            .set_str("color.grep", "always")
            .unwrap();
        let entry = WorkspaceRepository {
            path: repo.path_str(),
            name: "search-repo".to_string(),
        };

        let matches = run_workspace_grep(&entry, "a.b", true, false, None, 10).unwrap();

        assert_eq!(
            matches,
            vec![("search.txt".to_string(), 1, "literal a.b".to_string())]
        );
    }

    /// `grep.column = true` adds a column field to every record, so without
    /// `--no-column` the NUL-framed records are read one field out of step and
    /// the column number plus a raw NUL byte are shown in front of the code.
    #[test]
    fn test_workspace_grep_ignores_forced_column_output() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add search content", &[("search.txt", "literal a.b\n")]);
        repo.repo()
            .config()
            .unwrap()
            .set_bool("grep.column", true)
            .unwrap();
        let entry = WorkspaceRepository {
            path: repo.path_str(),
            name: "search-repo".to_string(),
        };

        let matches = run_workspace_grep(&entry, "a.b", true, false, None, 10).unwrap();

        assert_eq!(
            matches,
            vec![("search.txt".to_string(), 1, "literal a.b".to_string())]
        );
    }

    /// Colour and column forced together: neither neutralising flag may undo
    /// the other, and a query that does not match must still report nothing.
    #[test]
    fn test_workspace_grep_ignores_forced_colour_and_column_together() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add search content", &[("search.txt", "literal a.b\n")]);
        let git_repo = repo.repo();
        let mut config = git_repo.config().unwrap();
        config.set_str("color.grep", "always").unwrap();
        config.set_bool("grep.column", true).unwrap();
        let entry = WorkspaceRepository {
            path: repo.path_str(),
            name: "search-repo".to_string(),
        };

        let matches = run_workspace_grep(&entry, "a.b", true, false, None, 10).unwrap();
        assert_eq!(
            matches,
            vec![("search.txt".to_string(), 1, "literal a.b".to_string())]
        );

        let missing = run_workspace_grep(&entry, "zzz-absent", true, false, None, 10).unwrap();
        assert!(missing.is_empty());
    }

    /// The grep error carries only the underlying detail: the repository name
    /// and the "Failed to search repository" wording are added once, by
    /// `search_repository`, so the user never reads either of them twice.
    #[test]
    fn test_workspace_grep_returns_only_the_underlying_failure_detail() {
        let dir = tempfile::TempDir::new().unwrap();
        let entry = WorkspaceRepository {
            path: dir.path().to_string_lossy().to_string(),
            name: "broken-repo".to_string(),
        };

        let error = run_workspace_grep(&entry, "query", false, false, None, 10).unwrap_err();

        assert!(
            error.contains("not a git repository"),
            "expected the git detail, got {error}"
        );
        assert!(!error.contains("Operation failed"), "got {error}");
        assert!(
            !error.contains("Failed to search repository"),
            "got {error}"
        );
    }

    /// Both kinds of failure entry read the same way, so a workspace with one
    /// missing path and one broken repository does not show two shapes.
    #[test]
    fn test_search_repository_reports_a_missing_path_with_the_shared_wording() {
        let entry = WorkspaceRepository {
            path: "/definitely/not/here".to_string(),
            name: "gone".to_string(),
        };

        assert_eq!(
            search_repository(&entry, "query", false, false, None, 10).unwrap_err(),
            "Failed to search repository \"gone\": repository path does not exist"
        );
    }

    #[test]
    fn test_search_repository_names_the_repository_on_a_grep_failure() {
        let dir = tempfile::TempDir::new().unwrap();
        let entry = WorkspaceRepository {
            path: dir.path().to_string_lossy().to_string(),
            name: "broken-repo".to_string(),
        };

        let failure = search_repository(&entry, "query", false, false, None, 10).unwrap_err();

        assert!(
            failure.starts_with("Failed to search repository \"broken-repo\": "),
            "got {failure}"
        );
        assert!(!failure.contains("Operation failed"), "got {failure}");
    }

    fn read_records(bytes: &[u8], limit: usize) -> Vec<(String, u32, String)> {
        read_grep_records(&mut std::io::Cursor::new(bytes), limit).unwrap()
    }

    #[test]
    fn test_workspace_grep_parser_accepts_colons_in_file_names() {
        assert_eq!(
            read_records(b"folder:name.txt\x0042\0matching text\n", 10),
            vec![(
                "folder:name.txt".to_string(),
                42,
                "matching text".to_string()
            )]
        );
    }

    #[test]
    fn test_workspace_grep_parser_accepts_newlines_in_file_names() {
        assert_eq!(
            read_records(b"folder\nname.txt\x007\0matching text\n", 10),
            vec![(
                "folder\nname.txt".to_string(),
                7,
                "matching text".to_string()
            )]
        );
    }

    #[test]
    fn test_workspace_grep_parser_respects_result_limit() {
        assert_eq!(
            read_records(b"a.txt\x001\0first\nb.txt\x002\0second\n", 1),
            vec![("a.txt".to_string(), 1, "first".to_string())]
        );
    }

    #[test]
    fn test_workspace_grep_parser_strips_a_trailing_carriage_return() {
        assert_eq!(
            read_records(b"a.txt\x001\0first\r\n", 10),
            vec![("a.txt".to_string(), 1, "first".to_string())]
        );
    }

    /// A workspace search that stops at the global match limit must say which
    /// repositories it never looked at — otherwise the truncated list reads as
    /// "the term is not in those repositories".
    #[test]
    fn test_search_repositories_reports_repositories_skipped_by_the_limit() {
        let first = TestRepo::with_initial_commit();
        first.create_commit("Add matches", &[("a.txt", "match\nmatch\n")]);
        let second = TestRepo::with_initial_commit();
        second.create_commit("Add matches", &[("b.txt", "match\n")]);

        let repositories = vec![
            WorkspaceRepository {
                path: first.path_str(),
                name: "alpha".to_string(),
            },
            WorkspaceRepository {
                path: second.path_str(),
                name: "beta".to_string(),
            },
        ];

        let response = search_repositories(&repositories, "match", true, false, None, 2);

        assert_eq!(response.results.len(), 2);
        assert!(
            response
                .results
                .iter()
                .all(|result| result.repo_name == "alpha"),
            "the limit should be consumed by the first repository"
        );
        assert_eq!(
            response.failures,
            vec!["Stopped at the 2-match limit; 1 repository was not searched".to_string()]
        );
    }

    /// The limit is just as often consumed inside the only repository, where no
    /// repository is left to report as skipped. That truncation must still be
    /// announced, or 200 of 500 matches read as all of them.
    #[test]
    fn test_search_repositories_reports_matches_dropped_by_the_limit() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add matches", &[("a.txt", "match\nmatch\nmatch\n")]);

        let repositories = vec![WorkspaceRepository {
            path: repo.path_str(),
            name: "alpha".to_string(),
        }];

        let response = search_repositories(&repositories, "match", true, false, None, 2);

        assert_eq!(response.results.len(), 2);
        assert_eq!(
            response.failures,
            vec!["Stopped at the 2-match limit; more matches were not shown".to_string()]
        );
    }

    /// The last repository in the list is the same case: the loop ends instead
    /// of taking the skipped-repository branch.
    #[test]
    fn test_search_repositories_reports_matches_dropped_by_the_last_repository() {
        let first = TestRepo::with_initial_commit();
        first.create_commit("Add matches", &[("a.txt", "match\n")]);
        let second = TestRepo::with_initial_commit();
        second.create_commit("Add matches", &[("b.txt", "match\nmatch\nmatch\n")]);

        let repositories = vec![
            WorkspaceRepository {
                path: first.path_str(),
                name: "alpha".to_string(),
            },
            WorkspaceRepository {
                path: second.path_str(),
                name: "beta".to_string(),
            },
        ];

        let response = search_repositories(&repositories, "match", true, false, None, 2);

        assert_eq!(response.results.len(), 2);
        assert_eq!(
            response.failures,
            vec!["Stopped at the 2-match limit; more matches were not shown".to_string()]
        );
    }

    /// Filling the limit exactly is not truncation: a complete list must not be
    /// labelled as cut short.
    #[test]
    fn test_search_repositories_stays_silent_when_matches_exactly_fill_the_limit() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add matches", &[("a.txt", "match\nmatch\n")]);

        let repositories = vec![WorkspaceRepository {
            path: repo.path_str(),
            name: "alpha".to_string(),
        }];

        let response = search_repositories(&repositories, "match", true, false, None, 2);

        assert_eq!(response.results.len(), 2);
        assert!(response.failures.is_empty(), "{:?}", response.failures);
    }

    #[test]
    fn test_search_repositories_searches_every_repository_below_the_limit() {
        let first = TestRepo::with_initial_commit();
        first.create_commit("Add matches", &[("a.txt", "match\n")]);
        let second = TestRepo::with_initial_commit();
        second.create_commit("Add matches", &[("b.txt", "match\n")]);

        let repositories = vec![
            WorkspaceRepository {
                path: first.path_str(),
                name: "alpha".to_string(),
            },
            WorkspaceRepository {
                path: second.path_str(),
                name: "beta".to_string(),
            },
        ];

        let response = search_repositories(&repositories, "match", true, false, None, 50);

        assert_eq!(response.results.len(), 2);
        assert!(response.failures.is_empty(), "{:?}", response.failures);
    }

    /// A repository that cannot be searched must not cost the workspace the
    /// matches from the ones that can be. The broken repository comes first, so
    /// abandoning the loop on the first failure is caught here too.
    #[test]
    fn test_search_repositories_keeps_matches_when_one_repository_fails() {
        let good = TestRepo::with_initial_commit();
        good.create_commit("Add matches", &[("a.txt", "match\n")]);

        let repositories = vec![
            WorkspaceRepository {
                path: "/definitely/not/here".to_string(),
                name: "gone".to_string(),
            },
            WorkspaceRepository {
                path: good.path_str(),
                name: "alpha".to_string(),
            },
        ];

        let response = search_repositories(&repositories, "match", true, false, None, 50);

        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].repo_name, "alpha");
        assert_eq!(
            response.failures,
            vec![
                "Failed to search repository \"gone\": repository path does not exist".to_string()
            ]
        );
    }

    #[test]
    fn test_workspace_grep_stops_at_result_limit() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit(
            "Add many matches",
            &[("many.txt", "match\nmatch\nmatch\nmatch\n")],
        );
        let entry = WorkspaceRepository {
            path: repo.path_str(),
            name: "search-repo".to_string(),
        };

        let matches = run_workspace_grep(&entry, "match", true, false, None, 2).unwrap();

        assert_eq!(matches.len(), 2);
    }

    #[test]
    fn test_load_default_config() {
        // When no file exists, should return default
        let config = WorkspacesConfig::default();
        assert!(config.workspaces.is_empty());
    }

    #[test]
    fn test_config_serialization_roundtrip() {
        let config = WorkspacesConfig {
            workspaces: vec![Workspace {
                id: "ws-1".to_string(),
                name: "Test Workspace".to_string(),
                description: "Description".to_string(),
                color: "#81c784".to_string(),
                repositories: vec![
                    WorkspaceRepository {
                        path: "/path/to/repo1".to_string(),
                        name: "repo1".to_string(),
                    },
                    WorkspaceRepository {
                        path: "/path/to/repo2".to_string(),
                        name: "repo2".to_string(),
                    },
                ],
                created_at: Utc::now(),
                last_opened: None,
            }],
        };

        let json = serde_json::to_string_pretty(&config).unwrap();
        let deserialized: WorkspacesConfig = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.workspaces.len(), 1);
        assert_eq!(deserialized.workspaces[0].id, "ws-1");
        assert_eq!(deserialized.workspaces[0].repositories.len(), 2);
    }
}
