//! Cherry-pick, revert, and reset command handlers

mod cherry_pick_revert;
mod history_rewrite;
#[cfg(test)]
#[path = "rewrite/rewrite_tests.rs"]
mod test_suite;

pub use cherry_pick_revert::*;
pub use history_rewrite::*;

use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};

/// Name of the sidecar file tracking the commits still to be applied during a
/// multi-commit cherry-pick sequence (used so `continue` can resume the range).
const CHERRY_PICK_SEQUENCE: &str = "CHERRY_PICK_SEQUENCE";

/// Name of the sidecar file storing the pre-sequence HEAD oid so that aborting a
/// multi-commit cherry-pick rewinds to the exact commit it started from
/// (matching `git cherry-pick --abort`), rather than leaving already-applied
/// picks on the branch.
const CHERRY_PICK_SEQUENCE_HEAD: &str = "CHERRY_PICK_SEQUENCE_HEAD";

/// Represents the current state of an interactive rebase
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseState {
    pub in_progress: bool,
    pub head_name: Option<String>,
    pub onto: Option<String>,
    pub current_commit: Option<String>,
    pub done_count: u32,
    pub total_count: u32,
    pub has_conflicts: bool,
}

/// Represents an entry in the rebase todo list
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseTodoEntry {
    pub action: String,
    pub commit_oid: String,
    pub commit_short: String,
    pub message: String,
}

/// Represents the full rebase todo state
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseTodo {
    pub entries: Vec<RebaseTodoEntry>,
    pub done: Vec<RebaseTodoEntry>,
}

/// Get the current interactive rebase state
#[command]
pub async fn get_rebase_state(path: String) -> Result<RebaseState> {
    let repo = git2::Repository::open(Path::new(&path))?;

    let state = repo.state();
    let in_progress = matches!(
        state,
        git2::RepositoryState::Rebase
            | git2::RepositoryState::RebaseInteractive
            | git2::RepositoryState::RebaseMerge
    );

    if !in_progress {
        return Ok(RebaseState {
            in_progress: false,
            head_name: None,
            onto: None,
            current_commit: None,
            done_count: 0,
            total_count: 0,
            has_conflicts: false,
        });
    }

    // Resolve via repo.path() so per-worktree rebase state is found in linked
    // worktrees (where <wt>/.git is a gitdir-pointer file, not a directory).
    let git_dir = repo.path();
    let rebase_merge_dir = git_dir.join("rebase-merge");
    let rebase_apply_dir = git_dir.join("rebase-apply");

    // Determine which rebase directory is active
    let rebase_dir = if rebase_merge_dir.exists() {
        rebase_merge_dir
    } else if rebase_apply_dir.exists() {
        rebase_apply_dir
    } else {
        return Ok(RebaseState {
            in_progress: true,
            head_name: None,
            onto: None,
            current_commit: None,
            done_count: 0,
            total_count: 0,
            has_conflicts: repo.index()?.has_conflicts(),
        });
    };

    // Read head-name (branch being rebased)
    let head_name = std::fs::read_to_string(rebase_dir.join("head-name"))
        .ok()
        .map(|s| s.trim().to_string())
        .map(|s| s.strip_prefix("refs/heads/").unwrap_or(&s).to_string());

    // Read onto (target commit)
    let onto = std::fs::read_to_string(rebase_dir.join("onto"))
        .ok()
        .map(|s| s.trim().to_string());

    // Read current commit being applied (stopped-sha or current-commit)
    let current_commit = std::fs::read_to_string(rebase_dir.join("stopped-sha"))
        .or_else(|_| std::fs::read_to_string(rebase_dir.join("current-commit")))
        .ok()
        .map(|s| s.trim().to_string());

    // Count done and total entries
    let done_count = std::fs::read_to_string(rebase_dir.join("done"))
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count() as u32)
        .unwrap_or(0);

    let todo_count = std::fs::read_to_string(rebase_dir.join("git-rebase-todo"))
        .map(|s| {
            s.lines()
                .filter(|l| !l.trim().is_empty() && !l.trim().starts_with('#'))
                .count() as u32
        })
        .unwrap_or(0);

    let total_count = done_count + todo_count;

    let has_conflicts = repo.index()?.has_conflicts();

    Ok(RebaseState {
        in_progress: true,
        head_name,
        onto,
        current_commit,
        done_count,
        total_count,
        has_conflicts,
    })
}

/// Parse a rebase todo line into a RebaseTodoEntry
fn parse_todo_line(line: &str, repo: &git2::Repository) -> Option<RebaseTodoEntry> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }

    let parts: Vec<&str> = line.splitn(3, ' ').collect();
    if parts.len() < 2 {
        return None;
    }

    let action = parts[0].to_lowercase();
    let commit_short = parts[1].to_string();

    // Try to resolve the full OID
    let commit_oid = repo
        .revparse_single(&commit_short)
        .ok()
        .map(|obj| obj.id().to_string())
        .unwrap_or_else(|| commit_short.clone());

    // Get the message from the line or from the commit
    let message = if parts.len() >= 3 {
        parts[2].to_string()
    } else {
        repo.find_commit(git2::Oid::from_str(&commit_oid).ok()?)
            .ok()
            .and_then(|c| c.summary().ok().flatten().map(|s| s.to_string()))
            .unwrap_or_default()
    };

    Some(RebaseTodoEntry {
        action,
        commit_oid,
        commit_short,
        message,
    })
}

/// Get the current rebase todo list
#[command]
pub async fn get_rebase_todo(path: String) -> Result<RebaseTodo> {
    let repo = git2::Repository::open(Path::new(&path))?;

    let state = repo.state();
    if !matches!(
        state,
        git2::RepositoryState::Rebase
            | git2::RepositoryState::RebaseInteractive
            | git2::RepositoryState::RebaseMerge
    ) {
        return Err(GitnadoError::OperationFailed(
            "No rebase in progress".to_string(),
        ));
    }

    // Resolve via repo.path() so per-worktree rebase state is found in linked
    // worktrees (where <wt>/.git is a gitdir-pointer file, not a directory).
    let git_dir = repo.path();
    let rebase_merge_dir = git_dir.join("rebase-merge");
    let rebase_apply_dir = git_dir.join("rebase-apply");

    let rebase_dir = if rebase_merge_dir.exists() {
        rebase_merge_dir
    } else if rebase_apply_dir.exists() {
        rebase_apply_dir
    } else {
        return Err(GitnadoError::OperationFailed(
            "Cannot find rebase directory".to_string(),
        ));
    };

    // Read todo entries
    let todo_content =
        std::fs::read_to_string(rebase_dir.join("git-rebase-todo")).unwrap_or_default();
    let entries: Vec<RebaseTodoEntry> = todo_content
        .lines()
        .filter_map(|line| parse_todo_line(line, &repo))
        .collect();

    // Read done entries
    let done_content = std::fs::read_to_string(rebase_dir.join("done")).unwrap_or_default();
    let done: Vec<RebaseTodoEntry> = done_content
        .lines()
        .filter_map(|line| parse_todo_line(line, &repo))
        .collect();

    Ok(RebaseTodo { entries, done })
}

/// Update the rebase todo list (reorder, change actions)
#[command]
pub async fn update_rebase_todo(path: String, entries: Vec<RebaseTodoEntry>) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;

    let state = repo.state();
    if !matches!(
        state,
        git2::RepositoryState::Rebase
            | git2::RepositoryState::RebaseInteractive
            | git2::RepositoryState::RebaseMerge
    ) {
        return Err(GitnadoError::OperationFailed(
            "No rebase in progress".to_string(),
        ));
    }

    // Resolve via repo.path() so per-worktree rebase state is found in linked
    // worktrees (where <wt>/.git is a gitdir-pointer file, not a directory).
    let git_dir = repo.path();
    let rebase_merge_dir = git_dir.join("rebase-merge");
    let rebase_apply_dir = git_dir.join("rebase-apply");

    let rebase_dir = if rebase_merge_dir.exists() {
        rebase_merge_dir
    } else if rebase_apply_dir.exists() {
        rebase_apply_dir
    } else {
        return Err(GitnadoError::OperationFailed(
            "Cannot find rebase directory".to_string(),
        ));
    };

    // Build the new todo content
    let todo_content: String = entries
        .iter()
        .map(|entry| format!("{} {} {}", entry.action, entry.commit_short, entry.message))
        .collect::<Vec<_>>()
        .join("\n");

    // Write the updated todo file
    std::fs::write(rebase_dir.join("git-rebase-todo"), todo_content)?;

    Ok(())
}

/// Skip the current commit during an interactive rebase
#[command]
pub async fn skip_rebase_commit(path: String) -> Result<()> {
    // Use git rebase --skip via CLI as it's the most reliable way
    let output = crate::utils::create_command("git")
        .current_dir(&path)
        .args(["rebase", "--skip"])
        .output()
        .map_err(|e| GitnadoError::OperationFailed(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("CONFLICT") || stderr.contains("conflict") {
            return Err(GitnadoError::RebaseConflict);
        }
        return Err(GitnadoError::OperationFailed(stderr.to_string()));
    }

    Ok(())
}

/// Reset the current branch to a specific commit
#[command]
pub async fn reset(path: String, target_ref: String, mode: String) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Shared with the reflog dialog's reset, which was written later with the
    // researched rule and refuses only the states where libgit2's state cleanup
    // would silently destroy an in-progress operation. A blanket
    // `state() != Clean` also refused a plain merge, cherry-pick or revert —
    // where `git reset` is the documented way to back out — so the same reset
    // succeeded from Undo and failed from the graph with "Another operation is
    // in progress", a message naming no way forward.
    super::reflog::ensure_resettable(&repo)?;

    // Find the target commit
    let obj = repo
        .revparse_single(&target_ref)
        .map_err(|_| GitnadoError::CommitNotFound(target_ref.clone()))?;
    let commit = obj
        .peel_to_commit()
        .map_err(|_| GitnadoError::CommitNotFound(target_ref.clone()))?;

    // Determine reset type
    let reset_type = match mode.as_str() {
        "soft" => git2::ResetType::Soft,
        "mixed" => git2::ResetType::Mixed,
        "hard" => git2::ResetType::Hard,
        _ => {
            return Err(GitnadoError::OperationFailed(format!(
                "Invalid reset mode: {}. Use 'soft', 'mixed', or 'hard'",
                mode
            )));
        }
    };

    // Perform the reset
    repo.reset(commit.as_object(), reset_type, None)?;

    Ok(())
}
