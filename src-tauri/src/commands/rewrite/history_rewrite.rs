//! Drop commit and reorder commits history rewrite handlers

use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};

/// Result of a drop commit operation
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropCommitResult {
    pub success: bool,
    pub new_tip: String,
    pub has_conflicts: bool,
    pub dropped_message: String,
}

/// Drop (remove) a commit from history
///
/// This removes a commit from the branch history by replaying all commits
/// after the dropped one onto its parent, effectively performing an interactive
/// rebase with a "drop" action for the specified commit.
///
/// # Arguments
/// * `path` - Repository path
/// * `commit_oid` - The OID of the commit to drop
#[command]
pub async fn drop_commit(path: String, commit_oid: String) -> Result<DropCommitResult> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Check for existing operations in progress
    if repo.state() != git2::RepositoryState::Clean {
        return Err(GitnadoError::OperationFailed(
            "Another operation is in progress".to_string(),
        ));
    }

    // Verify the repository has no uncommitted changes
    let statuses = repo.statuses(None)?;
    if !statuses.is_empty() {
        let has_changes = statuses
            .iter()
            .any(|s| s.status() != git2::Status::IGNORED && s.status() != git2::Status::CURRENT);
        if has_changes {
            return Err(GitnadoError::OperationFailed(
                "Working directory has uncommitted changes. Commit or stash them first."
                    .to_string(),
            ));
        }
    }

    // Parse the commit OID
    let target_oid = git2::Oid::from_str(&commit_oid)
        .map_err(|_| GitnadoError::CommitNotFound(commit_oid.clone()))?;

    let target_commit = repo
        .find_commit(target_oid)
        .map_err(|_| GitnadoError::CommitNotFound(commit_oid.clone()))?;

    let dropped_message = target_commit
        .message()
        .unwrap_or("")
        .lines()
        .next()
        .unwrap_or("")
        .to_string();

    // Cannot drop root commit (no parent to rebase onto)
    if target_commit.parent_count() == 0 {
        return Err(GitnadoError::OperationFailed(
            "Cannot drop root commit".to_string(),
        ));
    }

    // Get the current HEAD
    let head_commit = repo.head()?.peel_to_commit()?;

    // If the commit to drop IS the HEAD, simply reset to its parent
    if head_commit.id() == target_oid {
        let parent = target_commit.parent(0)?;
        let parent_oid = parent.id();

        // Update HEAD to the parent
        let head_ref = repo.head()?;
        if head_ref.is_branch() {
            let branch_name = head_ref.shorthand().unwrap_or("HEAD");
            let refname = format!("refs/heads/{}", branch_name);
            repo.reference(
                &refname,
                parent_oid,
                true,
                &format!(
                    "drop: remove commit {}",
                    &commit_oid[..8.min(commit_oid.len())]
                ),
            )?;
        } else {
            repo.set_head_detached(parent_oid)?;
        }

        repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))?;

        return Ok(DropCommitResult {
            success: true,
            new_tip: parent_oid.to_string(),
            has_conflicts: false,
            dropped_message,
        });
    }

    // Verify that target_commit is an ancestor of HEAD
    if !repo.graph_descendant_of(head_commit.id(), target_commit.id())? {
        return Err(GitnadoError::OperationFailed(
            "Commit to drop is not an ancestor of HEAD".to_string(),
        ));
    }

    // Get the parent of the commit to drop - this is where we rebase onto
    let drop_parent = target_commit.parent(0)?;

    // Collect all commits after the dropped commit up to HEAD (oldest first)
    let mut commits_after_drop = Vec::new();
    let mut revwalk = repo.revwalk()?;
    revwalk.push(head_commit.id())?;
    revwalk.hide(target_oid)?;
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::REVERSE)?;

    for oid in revwalk {
        let oid = oid?;
        let commit = repo.find_commit(oid)?;
        commits_after_drop.push(commit);
    }

    // Replay all commits after the dropped one onto the drop parent
    let mut current_base_oid = drop_parent.id();
    let signature = repo.signature()?;

    for commit in &commits_after_drop {
        let current_base = repo.find_commit(current_base_oid)?;

        let new_tree = {
            let commit_parent = commit.parent(0)?;
            let parent_tree = commit_parent.tree()?;
            let commit_tree = commit.tree()?;
            let base_tree = current_base.tree()?;

            let mut merge_result =
                repo.merge_trees(&parent_tree, &base_tree, &commit_tree, None)?;

            if merge_result.has_conflicts() {
                // Conflicts occurred while replaying
                let tree_oid = merge_result.write_tree_to(&repo)?;
                let _tree = repo.find_tree(tree_oid)?;

                return Ok(DropCommitResult {
                    success: false,
                    new_tip: current_base_oid.to_string(),
                    has_conflicts: true,
                    dropped_message,
                });
            }

            let new_tree_oid = merge_result.write_tree_to(&repo)?;
            repo.find_tree(new_tree_oid)?
        };

        current_base_oid = repo.commit(
            None,
            &commit.author(),
            &signature,
            commit.message().unwrap_or(""),
            &new_tree,
            &[&current_base],
        )?;
    }

    // Update HEAD to point to the final replayed commit
    let head_ref = repo.head()?;
    if head_ref.is_branch() {
        let branch_name = head_ref.shorthand().unwrap_or("HEAD");
        let refname = format!("refs/heads/{}", branch_name);
        repo.reference(
            &refname,
            current_base_oid,
            true,
            &format!(
                "drop: remove commit {}",
                &commit_oid[..8.min(commit_oid.len())]
            ),
        )?;
    } else {
        repo.set_head_detached(current_base_oid)?;
    }

    // Checkout to update working directory
    repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))?;

    // git's rebase sequencer fires post-commit per replayed commit as HEAD
    // advances; we replay atomically (nothing moved until success) and move the
    // ref once, so fire post-commit a single time for the final rewritten HEAD
    // when the drop actually rewrote commits (dropping the tip rewrites none).
    if !commits_after_drop.is_empty() {
        crate::commands::hooks::run_hook_noblock(&repo, "post-commit", &[]);
    }

    Ok(DropCommitResult {
        success: true,
        new_tip: current_base_oid.to_string(),
        has_conflicts: false,
        dropped_message,
    })
}

/// Result of a commit reorder operation
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderResult {
    pub success: bool,
    pub new_tip: String,
    pub reordered_count: u32,
    pub has_conflicts: bool,
}

/// Reorder commits by replaying them in a new order
///
/// This performs a non-interactive rebase-like operation that replays commits
/// in a different order. The commits are cherry-picked onto the base commit
/// in the specified order.
///
/// # Arguments
/// * `path` - Repository path
/// * `base_commit` - Parent of the oldest commit to reorder (exclusive base)
/// * `commit_order` - New order of commit OIDs from oldest to newest
#[command]
pub async fn reorder_commits(
    path: String,
    base_commit: String,
    commit_order: Vec<String>,
) -> Result<ReorderResult> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Check for existing operations in progress
    if repo.state() != git2::RepositoryState::Clean {
        return Err(GitnadoError::OperationFailed(
            "Another operation is in progress".to_string(),
        ));
    }

    // Verify the repository has no uncommitted changes
    let statuses = repo.statuses(None)?;
    if !statuses.is_empty() {
        let has_changes = statuses
            .iter()
            .any(|s| s.status() != git2::Status::IGNORED && s.status() != git2::Status::CURRENT);
        if has_changes {
            return Err(GitnadoError::OperationFailed(
                "Working directory has uncommitted changes. Commit or stash them first."
                    .to_string(),
            ));
        }
    }

    if commit_order.is_empty() {
        return Err(GitnadoError::OperationFailed(
            "No commits specified for reordering".to_string(),
        ));
    }

    // Parse the base commit
    let base_oid = git2::Oid::from_str(&base_commit)
        .map_err(|_| GitnadoError::CommitNotFound(base_commit.clone()))?;
    let _base = repo
        .find_commit(base_oid)
        .map_err(|_| GitnadoError::CommitNotFound(base_commit.clone()))?;

    // Parse and validate all commit OIDs in the new order
    let mut commits_in_order = Vec::new();
    for oid_str in &commit_order {
        let oid = git2::Oid::from_str(oid_str)
            .map_err(|_| GitnadoError::CommitNotFound(oid_str.clone()))?;
        let commit = repo
            .find_commit(oid)
            .map_err(|_| GitnadoError::CommitNotFound(oid_str.clone()))?;
        commits_in_order.push(commit);
    }

    // Collect the original commits between base and HEAD to validate
    let head_commit = repo.head()?.peel_to_commit()?;
    let mut original_oids = std::collections::HashSet::new();
    let mut revwalk = repo.revwalk()?;
    revwalk.push(head_commit.id())?;
    revwalk.hide(base_oid)?;
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::REVERSE)?;

    for oid in revwalk {
        let oid = oid?;
        original_oids.insert(oid);
    }

    // Verify that the reorder list contains exactly the same commits
    let reorder_oids: std::collections::HashSet<git2::Oid> =
        commits_in_order.iter().map(|c| c.id()).collect();

    if original_oids != reorder_oids {
        return Err(GitnadoError::OperationFailed(
            "Reorder list must contain exactly the same commits as the original range".to_string(),
        ));
    }

    let reordered_count = commits_in_order.len() as u32;

    // Replay commits in the new order onto the base commit
    let mut current_base_oid = base_oid;
    let signature = repo.signature()?;

    for commit in &commits_in_order {
        let current_base = repo.find_commit(current_base_oid)?;

        // Cherry-pick this commit onto the new base using tree merge
        let commit_parent = commit.parent(0).map_err(|_| {
            GitnadoError::OperationFailed(format!("Cannot reorder root commit {}", commit.id()))
        })?;
        let parent_tree = commit_parent.tree()?;
        let commit_tree = commit.tree()?;
        let base_tree = current_base.tree()?;

        let mut merge_result = repo.merge_trees(&parent_tree, &base_tree, &commit_tree, None)?;

        if merge_result.has_conflicts() {
            // Restore HEAD to original state - abort the reorder
            repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))?;

            return Ok(ReorderResult {
                success: false,
                new_tip: head_commit.id().to_string(),
                reordered_count: 0,
                has_conflicts: true,
            });
        }

        let new_tree_oid = merge_result.write_tree_to(&repo)?;
        let new_tree = repo.find_tree(new_tree_oid)?;

        // Create the replayed commit preserving original author and message
        current_base_oid = repo.commit(
            None,
            &commit.author(),
            &signature,
            commit.message().unwrap_or(""),
            &new_tree,
            &[&current_base],
        )?;
    }

    // Update HEAD to point to the final commit
    let head = repo.head()?;
    if head.is_branch() {
        let branch_name = head.shorthand().unwrap_or("HEAD");
        let refname = format!("refs/heads/{}", branch_name);
        repo.reference(
            &refname,
            current_base_oid,
            true,
            &format!("reorder: {} commits reordered", reordered_count),
        )?;
    } else {
        repo.set_head_detached(current_base_oid)?;
    }

    // Checkout the new commit to update working directory
    repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))?;

    // git's rebase sequencer fires post-commit per replayed commit as HEAD
    // advances; we replay atomically (nothing moved until success) and move the
    // ref once, so fire post-commit a single time for the final rewritten HEAD.
    if !commits_in_order.is_empty() {
        crate::commands::hooks::run_hook_noblock(&repo, "post-commit", &[]);
    }

    Ok(ReorderResult {
        success: true,
        new_tip: current_base_oid.to_string(),
        reordered_count,
        has_conflicts: false,
    })
}
