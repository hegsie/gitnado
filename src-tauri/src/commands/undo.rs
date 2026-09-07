//! Undo/redo history tracking commands
//!
//! Provides GitKraken-style undo/redo by using the git reflog as a backing store.
//! Actions are parsed from reflog entries and can be undone/redone via reset operations.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::command;

use crate::error::GitnadoError;
use crate::error::Result;

/// Refuse to reset while a multi-step operation (rebase, bisect, or a
/// cherry-pick/revert *sequence*) is in progress. Canonical `git reset` leaves
/// `.git/rebase-merge`, `.git/rebase-apply`, `.git/BISECT_LOG` and the sequencer
/// directory in place, but libgit2's reset unconditionally runs
/// `git_repository_state_cleanup` for MIXED/HARD resets and deletes them,
/// silently destroying the in-progress operation. Mirror git by refusing.
/// (A plain single-op Merge / CherryPick / Revert is intentionally allowed:
/// `git reset` is the documented way to abort those, and clearing MERGE_HEAD /
/// CHERRY_PICK_HEAD / REVERT_HEAD is exactly what git itself does.)
fn ensure_resettable(repo: &git2::Repository) -> Result<()> {
    use git2::RepositoryState::*;
    match repo.state() {
        Rebase | RebaseInteractive | RebaseMerge | ApplyMailbox | ApplyMailboxOrRebase => {
            Err(GitnadoError::OperationFailed(
                "Cannot reset while a rebase is in progress. Finish or abort the rebase (git rebase --continue or --abort) before undoing.".to_string(),
            ))
        }
        Bisect => Err(GitnadoError::OperationFailed(
            "Cannot reset while a bisect is in progress. Run 'git bisect reset' before undoing.".to_string(),
        )),
        CherryPickSequence => Err(GitnadoError::OperationFailed(
            "Cannot reset while a cherry-pick sequence is in progress. Finish or abort it (git cherry-pick --continue or --abort) before undoing.".to_string(),
        )),
        RevertSequence => Err(GitnadoError::OperationFailed(
            "Cannot reset while a revert sequence is in progress. Finish or abort it (git revert --continue or --abort) before undoing.".to_string(),
        )),
        _ => Ok(()),
    }
}

/// Parse the source ref of a checkout reflog message.
/// Format: "checkout: moving from <from> to <to>".
fn parse_checkout_source(message: &str) -> Option<String> {
    let rest = message.split_once("moving from ")?.1;
    let from = rest.rsplit_once(" to ")?.0.trim();
    if from.is_empty() {
        None
    } else {
        Some(from.to_string())
    }
}

/// The ref HEAD currently points at: `refs/heads/<branch>` when attached, and
/// `HEAD` itself when detached.
fn head_ref_name(repo: &git2::Repository) -> Option<String> {
    // Reference::name() is Result-wrapped in this git2 binding, not Option.
    repo.head().ok()?.name().ok().map(|n| n.to_string())
}

/// Record a marker in repo config so `redo_last_action` can distinguish an
/// app-performed undo from a user-initiated reset. `redo_target` is the state
/// redo should restore (HEAD before the undo); `undo_head` is HEAD immediately
/// after the undo, used to detect whether anything changed since.
///
/// The ref HEAD was on is recorded alongside them, because an OID alone does not
/// identify a branch: any number of branches can sit on the same commit. Undo on
/// `main`, create a branch at the undo point and switch to it — exactly what a
/// cautious user does before experimenting — and a redo would otherwise pass the
/// OID check and reset that OTHER branch to the redo target.
fn set_redo_marker(repo: &git2::Repository, redo_target: &str, undo_head: &str) {
    if let Ok(mut cfg) = repo.config() {
        let _ = cfg.set_str("gitnado.redotarget", redo_target);
        let _ = cfg.set_str("gitnado.redohead", undo_head);
        match head_ref_name(repo) {
            // A mixed reset does not change which ref HEAD points at, so reading
            // it after the undo names the ref the undo actually moved.
            Some(name) => {
                let _ = cfg.set_str("gitnado.redoref", &name);
            }
            // Without a recorded ref, redo_last_action refuses rather than
            // falling back to the OID-only check that lets it hit the wrong
            // branch. Remove any stale value so it cannot be inherited.
            None => {
                let _ = cfg.remove("gitnado.redoref");
            }
        }
    }
}

fn clear_redo_marker(repo: &git2::Repository) {
    if let Ok(mut cfg) = repo.config() {
        let _ = cfg.remove("gitnado.redotarget");
        let _ = cfg.remove("gitnado.redohead");
        let _ = cfg.remove("gitnado.redoref");
    }
}

/// Represents a single undoable git action parsed from the reflog
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoAction {
    /// The type of action: "commit", "checkout", "merge", "rebase", "reset", "stash", "branch_delete", "pull", "cherry_pick", "revert", "amend"
    pub action_type: String,
    /// Human-readable description of what happened
    pub description: String,
    /// Unix timestamp of when this action occurred
    pub timestamp: i64,
    /// The ref (OID) state before this action
    pub before_ref: String,
    /// The ref (OID) state after this action
    pub after_ref: String,
    /// Optional JSON string with additional details
    pub details: Option<String>,
}

/// The full undo/redo history state
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoHistory {
    /// List of undoable actions, newest first
    pub actions: Vec<UndoAction>,
    /// Current position in the undo stack (-1 means at latest state)
    pub current_index: i32,
    /// Whether there is an action that can be undone
    pub can_undo: bool,
    /// Whether there is an action that can be redone
    pub can_redo: bool,
}

/// Parse a reflog message into an action type and human-readable description
fn parse_reflog_action(message: &str) -> (String, String) {
    // Reflog messages follow the format "action: details"
    // e.g. "commit: Add new feature"
    //      "checkout: moving from main to feature"
    //      "merge feature: Fast-forward"
    //      "rebase (finish): refs/heads/main onto abc123"
    //      "reset: moving to HEAD~1"
    //      "pull: Fast-forward"
    //      "cherry-pick: Added feature X"
    //      "revert: Revert \"Some commit\""
    //      "commit (amend): Updated message"
    //      "commit (initial): Initial commit"

    let lower = message.to_lowercase();

    if lower.starts_with("commit (amend)") {
        let desc = message
            .split_once(':')
            .map(|x| x.1.trim())
            .unwrap_or("Amended commit");
        return ("amend".to_string(), format!("Amend commit: {}", desc));
    }

    if lower.starts_with("commit (initial)") {
        let desc = message
            .split_once(':')
            .map(|x| x.1.trim())
            .unwrap_or("Initial commit");
        return ("commit".to_string(), format!("Initial commit: {}", desc));
    }

    if lower.starts_with("commit") {
        let desc = message
            .split_once(':')
            .map(|x| x.1.trim())
            .unwrap_or("Commit");
        return ("commit".to_string(), format!("Commit: {}", desc));
    }

    if lower.starts_with("checkout") {
        let desc = message
            .split_once(':')
            .map(|x| x.1.trim())
            .unwrap_or("Checkout");
        return ("checkout".to_string(), format!("Checkout: {}", desc));
    }

    if lower.starts_with("merge") {
        let desc = message
            .split_once(':')
            .map(|x| x.1.trim())
            .unwrap_or("Merge");
        return ("merge".to_string(), format!("Merge: {}", desc));
    }

    if lower.starts_with("rebase") {
        let desc = message
            .split_once(':')
            .map(|x| x.1.trim())
            .unwrap_or("Rebase");
        return ("rebase".to_string(), format!("Rebase: {}", desc));
    }

    if lower.starts_with("reset") {
        let desc = message
            .split_once(':')
            .map(|x| x.1.trim())
            .unwrap_or("Reset");
        return ("reset".to_string(), format!("Reset: {}", desc));
    }

    if lower.starts_with("pull") {
        let desc = message
            .split_once(':')
            .map(|x| x.1.trim())
            .unwrap_or("Pull");
        return ("pull".to_string(), format!("Pull: {}", desc));
    }

    if lower.starts_with("cherry-pick") {
        let desc = message
            .split_once(':')
            .map(|x| x.1.trim())
            .unwrap_or("Cherry-pick");
        return ("cherry_pick".to_string(), format!("Cherry-pick: {}", desc));
    }

    if lower.starts_with("revert") {
        let desc = message
            .split_once(':')
            .map(|x| x.1.trim())
            .unwrap_or("Revert");
        return ("revert".to_string(), format!("Revert: {}", desc));
    }

    // Branch delete is not in reflog directly, but we handle it for record_action
    if lower.starts_with("branch") {
        return ("branch_delete".to_string(), message.to_string());
    }

    // Fallback: use the raw message
    let action = message
        .split(':')
        .next()
        .unwrap_or("unknown")
        .trim()
        .to_lowercase();
    (action, message.to_string())
}

/// Find the current undo position by scanning the reflog for the most recent
/// reset that was performed as an undo/redo operation.
/// Returns the index in the actions list that represents the current state.
/// -1 means we're at the latest state (no undo has been performed).
fn find_current_index(actions: &[UndoAction]) -> i32 {
    // The current index is always -1 (at latest) because the reflog
    // itself records undo operations as new entries. Each undo/redo
    // creates a new reflog entry, so the "current" state is always the top.
    // The UI can track undo position separately if needed.
    if actions.is_empty() {
        return -1;
    }
    -1
}

/// Get the undo/redo history for a repository by parsing the reflog
#[command]
pub async fn get_undo_history(path: String, max_count: Option<u32>) -> Result<UndoHistory> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let reflog = repo.reflog("HEAD")?;

    let limit = max_count.unwrap_or(50) as usize;
    let mut actions = Vec::new();

    for (index, entry) in reflog.iter().enumerate() {
        if actions.len() >= limit {
            break;
        }

        let message = entry.message().ok().flatten().unwrap_or("").to_string();
        let (action_type, description) = parse_reflog_action(&message);

        let after_ref = entry.id_new().to_string();
        let before_ref = entry.id_old().to_string();
        let timestamp = entry.committer().when().seconds();

        // Build details JSON with extra context
        let details = serde_json::json!({
            "reflogIndex": index,
            "rawMessage": message,
            "author": entry.committer().name().ok().unwrap_or("Unknown"),
        });

        actions.push(UndoAction {
            action_type,
            description,
            timestamp,
            before_ref,
            after_ref,
            details: Some(details.to_string()),
        });
    }

    let current_index = find_current_index(&actions);

    // can_undo: there is at least one action to undo (go back in history)
    let can_undo = !actions.is_empty();
    // can_redo: only meaningful when tracking undo position client-side
    let can_redo = false;

    Ok(UndoHistory {
        actions,
        current_index,
        can_undo,
        can_redo,
    })
}

/// Undo the last action by resetting HEAD to the previous reflog state
#[command]
pub async fn undo_last_action(path: String) -> Result<UndoAction> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Get the reflog to find the previous state
    let (before_oid_str, target_oid_str, message, timestamp, author) = {
        let reflog = repo.reflog("HEAD")?;

        // We need at least 2 entries to undo (current + previous)
        if reflog.len() < 2 {
            return Err(crate::error::GitnadoError::OperationFailed(
                "Nothing to undo: not enough reflog history".to_string(),
            ));
        }

        // Entry 0 is the current state, entry 1 is the state before
        let current_entry = reflog.get(0).ok_or_else(|| {
            crate::error::GitnadoError::OperationFailed(
                "Failed to read current reflog entry".to_string(),
            )
        })?;

        let previous_entry = reflog.get(1).ok_or_else(|| {
            crate::error::GitnadoError::OperationFailed(
                "Failed to read previous reflog entry".to_string(),
            )
        })?;

        let current_oid = current_entry.id_new().to_string();
        let target_oid = previous_entry.id_new().to_string();
        let msg = current_entry
            .message()
            .ok()
            .flatten()
            .unwrap_or("")
            .to_string();
        let ts = current_entry.committer().when().seconds();
        let auth = current_entry
            .committer()
            .name()
            .ok()
            .unwrap_or("Unknown")
            .to_string();

        (current_oid, target_oid, msg, ts, auth)
    };

    // Parse the action we're undoing
    let (action_type, description) = parse_reflog_action(&message);

    // Undoing a checkout must restore the previous HEAD *symbolically* — like
    // `git switch -` — which returns to the previous branch and never moves any
    // branch ref. A mixed reset here would rewrite the current branch to the
    // pre-checkout commit and orphan its commits (data loss).
    if action_type == "checkout" {
        return undo_checkout(
            &repo,
            &message,
            &before_oid_str,
            &target_oid_str,
            timestamp,
            author,
            description,
        );
    }

    // Refuse if a rebase/bisect/sequence is in progress: a reset would destroy it.
    ensure_resettable(&repo)?;

    // If the recorded action did not move HEAD (e.g. a synthetic record_action
    // entry such as a branch delete, or a checkout between two refs at the same
    // commit), a reset to that OID is a silent no-op that restores nothing.
    // Refuse rather than claim a successful undo.
    if target_oid_str == before_oid_str {
        return Err(GitnadoError::OperationFailed(
            "This action did not move HEAD, so it cannot be undone by resetting. Nothing was changed.".to_string(),
        ));
    }

    // Perform a mixed reset to the previous state
    let target_oid = git2::Oid::from_str(&target_oid_str)?;
    let target_commit = repo.find_commit(target_oid)?;
    repo.reset(target_commit.as_object(), git2::ResetType::Mixed, None)?;

    // Record a marker so a subsequent redo can tell this was an app undo.
    set_redo_marker(&repo, &before_oid_str, &target_oid_str);

    let details = serde_json::json!({
        "undoneAction": action_type,
        "undoneDescription": description,
        "author": author,
    });

    Ok(UndoAction {
        action_type: "undo".to_string(),
        description: format!("Undo: {}", description),
        timestamp,
        before_ref: before_oid_str,
        after_ref: target_oid_str,
        details: Some(details.to_string()),
    })
}

/// Undo a checkout by switching back to the previous branch (or detached
/// commit) symbolically, exactly like `git switch -`. Never moves a branch ref.
#[allow(clippy::too_many_arguments)]
fn undo_checkout(
    repo: &git2::Repository,
    message: &str,
    before_oid_str: &str,
    fallback_oid_str: &str,
    timestamp: i64,
    author: String,
    description: String,
) -> Result<UndoAction> {
    // The non-checkout branch of undo_last_action calls ensure_resettable; this
    // one switches branches instead, so it needs the switch guard rather than
    // the reset guard. It was the last set_head site in the codebase without
    // one. Not reachable from any UI surface today (Ctrl+Z opens the reflog
    // dialog, a different path), but leaving the hole is how the last five
    // rounds of this exact pattern started.
    crate::commands::branch::ensure_checkoutable(repo)?;

    let from = parse_checkout_source(message).ok_or_else(|| {
        GitnadoError::OperationFailed(
            "Could not determine which branch to switch back to for this checkout.".to_string(),
        )
    })?;

    let make_action = |after: String| {
        let details = serde_json::json!({
            "undoneAction": "checkout",
            "undoneDescription": description,
            "author": author,
        });
        UndoAction {
            action_type: "undo".to_string(),
            description: format!("Undo: {}", description),
            timestamp,
            before_ref: before_oid_str.to_string(),
            after_ref: after,
            details: Some(details.to_string()),
        }
    };

    // Prefer switching back to the named branch (symbolic, like `git switch -`).
    if let Ok(branch) = repo.find_branch(&from, git2::BranchType::Local) {
        let commit = branch.get().peel_to_commit()?;
        repo.checkout_tree(commit.as_object(), None)?;
        repo.set_head(&format!("refs/heads/{}", from))?;
        return Ok(make_action(commit.id().to_string()));
    }

    // Otherwise the previous location was a detached commit; restore it detached.
    let oid = git2::Oid::from_str(fallback_oid_str)?;
    let commit = repo.find_commit(oid)?;
    repo.checkout_tree(commit.as_object(), None)?;
    repo.set_head_detached(oid)?;
    Ok(make_action(fallback_oid_str.to_string()))
}

/// Redo the last undone action.
///
/// Only fires when the immediately preceding HEAD movement was an undo the app
/// performed (recognized via a marker written by `undo_last_action`). A reset
/// the user performed themselves — through the reflog dialog, Smart Undo, or the
/// git CLI — is NOT an app undo, and "redoing" over it is refused so the user's
/// deliberate reset is never silently reverted.
#[command]
pub async fn redo_last_action(path: String) -> Result<UndoAction> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Read the app-undo marker. Absent marker => the last action was not an
    // app undo, so there is nothing to redo.
    let (redo_target, undo_head, undo_ref) = {
        let cfg = repo.config()?;
        let target = cfg.get_string("gitnado.redotarget").ok();
        let head = cfg.get_string("gitnado.redohead").ok();
        let reference = cfg.get_string("gitnado.redoref").ok();
        match (target, head) {
            (Some(t), Some(h)) if !t.is_empty() && !h.is_empty() => (t, h, reference),
            _ => {
                return Err(GitnadoError::OperationFailed(
                    "Nothing to redo: the last action was not an undo.".to_string(),
                ));
            }
        }
    };

    // If HEAD has moved since the undo (a new commit, a manual reset, etc.),
    // the marker is stale and redoing would clobber whatever the user did next.
    let current_head = repo
        .head()
        .ok()
        .and_then(|h| h.target())
        .map(|o| o.to_string());
    if current_head.as_deref() != Some(undo_head.as_str()) {
        return Err(GitnadoError::OperationFailed(
            "Nothing to redo: the repository has changed since the last undo.".to_string(),
        ));
    }

    // The OID matching is not enough on its own: branches share commits, so the
    // check above passes just as happily on a DIFFERENT branch that happens to
    // point at the undo position. The reset below moves whatever ref HEAD is on,
    // so redo must be on the same ref the undo moved. A marker with no recorded
    // ref (written before this was tracked) is treated as stale for the same
    // reason — the marker only ever spans a single undo/redo pair, so refusing
    // costs at most one redo and never resets a branch the undo never touched.
    let current_ref = head_ref_name(&repo);
    if undo_ref.is_none() || current_ref != undo_ref {
        return Err(GitnadoError::OperationFailed(
            "Nothing to redo: the repository has changed since the last undo.".to_string(),
        ));
    }

    // Refuse if a rebase/bisect/sequence is in progress: a reset would destroy it.
    ensure_resettable(&repo)?;

    // Perform a mixed reset to the redo target (undo always used a mixed reset).
    let target_oid = git2::Oid::from_str(&redo_target)?;
    let target_commit = repo.find_commit(target_oid)?;
    repo.reset(target_commit.as_object(), git2::ResetType::Mixed, None)?;

    // The marker has been consumed.
    clear_redo_marker(&repo);

    let author = match repo.signature() {
        Ok(sig) => sig.name().unwrap_or("Unknown").to_string(),
        Err(_) => "Unknown".to_string(),
    };
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let details = serde_json::json!({
        "author": author,
    });

    Ok(UndoAction {
        action_type: "redo".to_string(),
        description: "Redo: restored previous state".to_string(),
        timestamp,
        before_ref: undo_head,
        after_ref: redo_target,
        details: Some(details.to_string()),
    })
}

/// Record a custom action to the undo history.
/// This writes a synthetic reflog entry that can be used for undo/redo tracking.
#[command]
pub async fn record_action(path: String, action: UndoAction) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Write a reflog entry for the current HEAD with the action description
    let head_ref = repo.head()?;
    let head_oid = head_ref.target().ok_or_else(|| {
        crate::error::GitnadoError::OperationFailed(
            "HEAD does not point to a valid commit".to_string(),
        )
    })?;

    let sig = repo.signature()?;
    let reflog_message = format!("{}: {}", action.action_type, action.description);

    // Append to the HEAD reflog
    let mut reflog = repo.reflog("HEAD")?;
    reflog.append(head_oid, &sig, Some(&reflog_message))?;
    reflog.write()?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[tokio::test]
    async fn test_get_undo_history_empty_repo() {
        let repo = TestRepo::new();

        let result = get_undo_history(repo.path_str(), None).await;
        assert!(result.is_ok());

        let history = result.unwrap();
        assert!(history.actions.is_empty());
        assert_eq!(history.current_index, -1);
        assert!(!history.can_undo);
        assert!(!history.can_redo);
    }

    #[tokio::test]
    async fn test_get_undo_history_with_commits() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second commit", &[("file2.txt", "content2")]);

        let result = get_undo_history(repo.path_str(), None).await;
        assert!(result.is_ok());

        let history = result.unwrap();
        assert!(!history.actions.is_empty());
        assert!(history.can_undo);
        assert_eq!(history.current_index, -1);

        // Most recent action should be a commit
        let latest = &history.actions[0];
        assert_eq!(latest.action_type, "commit");
        assert!(latest.description.contains("Second commit"));
    }

    #[tokio::test]
    async fn test_get_undo_history_with_max_count() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second", &[("f2.txt", "2")]);
        repo.create_commit("Third", &[("f3.txt", "3")]);
        repo.create_commit("Fourth", &[("f4.txt", "4")]);
        repo.create_commit("Fifth", &[("f5.txt", "5")]);

        let result = get_undo_history(repo.path_str(), Some(2)).await;
        assert!(result.is_ok());

        let history = result.unwrap();
        assert_eq!(history.actions.len(), 2);
    }

    #[tokio::test]
    async fn test_get_undo_history_default_limit() {
        let repo = TestRepo::with_initial_commit();

        let result = get_undo_history(repo.path_str(), None).await;
        assert!(result.is_ok());
        // Default limit is 50, should not exceed it
        assert!(result.unwrap().actions.len() <= 50);
    }

    #[tokio::test]
    async fn test_get_undo_history_action_types() {
        let repo = TestRepo::with_initial_commit();

        // Create various operations to generate different reflog entries
        repo.create_commit("Feature commit", &[("feature.txt", "feature")]);
        repo.create_branch("feature");
        repo.checkout_branch("feature");

        let result = get_undo_history(repo.path_str(), None).await;
        assert!(result.is_ok());

        let history = result.unwrap();
        assert!(history.actions.len() >= 2);

        // Most recent should be a checkout
        let latest = &history.actions[0];
        assert_eq!(latest.action_type, "checkout");
    }

    #[tokio::test]
    async fn test_get_undo_history_has_timestamps() {
        let repo = TestRepo::with_initial_commit();

        let result = get_undo_history(repo.path_str(), None).await;
        assert!(result.is_ok());

        let history = result.unwrap();
        for action in &history.actions {
            // Timestamp should be after year 2000
            assert!(action.timestamp > 946684800);
        }
    }

    #[tokio::test]
    async fn test_get_undo_history_has_refs() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second", &[("f.txt", "c")]);

        let result = get_undo_history(repo.path_str(), None).await;
        assert!(result.is_ok());

        let history = result.unwrap();
        for action in &history.actions {
            assert!(!action.after_ref.is_empty());
            // before_ref can be all-zeros for the first entry
        }
    }

    #[tokio::test]
    async fn test_get_undo_history_has_details() {
        let repo = TestRepo::with_initial_commit();

        let result = get_undo_history(repo.path_str(), None).await;
        assert!(result.is_ok());

        let history = result.unwrap();
        for action in &history.actions {
            assert!(action.details.is_some());
            let details: serde_json::Value =
                serde_json::from_str(action.details.as_ref().unwrap()).unwrap();
            assert!(details.get("reflogIndex").is_some());
            assert!(details.get("rawMessage").is_some());
            assert!(details.get("author").is_some());
        }
    }

    #[tokio::test]
    async fn test_undo_last_action() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid();

        repo.create_commit("Second commit", &[("file2.txt", "content2")]);
        let second_oid = repo.head_oid();
        assert_ne!(first_oid, second_oid);

        // Undo the last action (the second commit)
        let result = undo_last_action(repo.path_str()).await;
        assert!(result.is_ok());

        let undo_action = result.unwrap();
        assert_eq!(undo_action.action_type, "undo");
        assert!(undo_action.description.contains("Undo"));

        // HEAD should now point back to first commit
        assert_eq!(repo.head_oid(), first_oid);
    }

    /// undo_checkout switches branches, so it needs the switch guard, not the
    /// reset guard the other undo path uses. Without it, undoing a checkout
    /// mid-rebase moved HEAD while .git/rebase-merge stayed on disk.
    #[tokio::test]
    async fn test_undo_checkout_refuses_mid_rebase() {
        let repo = TestRepo::with_initial_commit();
        let git = repo.repo();
        let head = git.head().unwrap().peel_to_commit().unwrap().id();
        std::fs::create_dir_all(repo.path.join(".git/rebase-merge")).unwrap();
        std::fs::write(repo.path.join(".git/rebase-merge/interactive"), "").unwrap();
        std::fs::write(
            repo.path.join(".git/rebase-merge/head-name"),
            "refs/heads/main\n",
        )
        .unwrap();
        std::fs::write(
            repo.path.join(".git/rebase-merge/onto"),
            format!("{}\n", head),
        )
        .unwrap();
        assert_ne!(repo.repo().state(), git2::RepositoryState::Clean);

        let err = undo_checkout(
            &repo.repo(),
            "checkout: moving from main to feature",
            &head.to_string(),
            &head.to_string(),
            0,
            "Test User".to_string(),
            "checkout".to_string(),
        )
        .expect_err("undoing a checkout mid-rebase orphans the rebase state");
        assert!(
            err.to_string().contains("rebase is in progress"),
            "unexpected error: {}",
            err
        );
    }

    #[tokio::test]
    async fn test_undo_last_action_insufficient_history() {
        // A repo with only one commit has only one reflog entry
        let repo = TestRepo::new();

        let result = undo_last_action(repo.path_str()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Nothing to undo"));
    }

    #[tokio::test]
    async fn test_undo_preserves_reflog() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second", &[("f.txt", "c")]);

        undo_last_action(repo.path_str()).await.unwrap();

        // After undo, the reflog should have more entries (the undo itself creates a new entry)
        let history = get_undo_history(repo.path_str(), None).await.unwrap();
        // At least: initial commit + second commit + reset (undo)
        assert!(history.actions.len() >= 3);
    }

    #[tokio::test]
    async fn test_redo_last_action() {
        let repo = TestRepo::with_initial_commit();
        let _first_oid = repo.head_oid();

        repo.create_commit("Second commit", &[("file2.txt", "content2")]);
        let second_oid = repo.head_oid();

        // Undo
        undo_last_action(repo.path_str()).await.unwrap();
        assert_ne!(repo.head_oid(), second_oid);

        // Redo
        let result = redo_last_action(repo.path_str()).await;
        assert!(result.is_ok());

        let redo_action = result.unwrap();
        assert_eq!(redo_action.action_type, "redo");

        // HEAD should now point back to second commit
        assert_eq!(repo.head_oid(), second_oid);
    }

    #[tokio::test]
    async fn test_redo_without_prior_undo() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second", &[("f.txt", "c")]);

        // Try to redo without having undone anything
        let result = redo_last_action(repo.path_str()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Nothing to redo"));
    }

    /// Tip of a local branch, for asserting that a ref did or did not move.
    fn branch_tip(repo: &TestRepo, name: &str) -> git2::Oid {
        repo.repo()
            .find_branch(name, git2::BranchType::Local)
            .unwrap()
            .get()
            .target()
            .unwrap()
    }

    #[tokio::test]
    async fn test_redo_is_refused_on_a_different_branch_at_the_same_commit() {
        // Branching at the undo point before experimenting is exactly what a
        // cautious user does. The redo marker's OID check cannot tell that
        // branch apart from the one the undo moved — both point at the same
        // commit — so redo would reset a branch it never touched.
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid();

        repo.create_commit("Second commit", &[("file2.txt", "content2")]);

        undo_last_action(repo.path_str()).await.unwrap();
        assert_eq!(repo.head_oid(), first_oid);

        let default_branch = repo.current_branch();
        repo.create_branch("experiment");
        repo.checkout_branch("experiment");

        let result = redo_last_action(repo.path_str()).await;

        assert!(
            result.is_err(),
            "redo must refuse on a branch the undo never moved"
        );
        assert_eq!(
            branch_tip(&repo, "experiment"),
            first_oid,
            "the branch the user switched to must not be reset by redo"
        );
        assert_eq!(
            branch_tip(&repo, &default_branch),
            first_oid,
            "the undone branch must be left for a redo on that branch"
        );
    }

    #[tokio::test]
    async fn test_redo_is_refused_on_a_detached_head_at_the_same_commit() {
        // Same hole, reached by detaching instead of branching.
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid();

        repo.create_commit("Second commit", &[("file2.txt", "content2")]);
        undo_last_action(repo.path_str()).await.unwrap();

        let default_branch = repo.current_branch();
        repo.repo().set_head_detached(first_oid).unwrap();

        let result = redo_last_action(repo.path_str()).await;

        assert!(result.is_err(), "redo must refuse on a detached HEAD");
        assert_eq!(
            branch_tip(&repo, &default_branch),
            first_oid,
            "the undone branch must not move while HEAD is detached"
        );
    }

    #[tokio::test]
    async fn test_redo_still_fires_on_the_undone_branch_when_a_sibling_shares_the_commit() {
        // The refusal keys on the ref, not on whether other branches exist: a
        // sibling sitting on the same commit must not block a legitimate redo.
        let repo = TestRepo::with_initial_commit();

        repo.create_commit("Second commit", &[("file2.txt", "content2")]);
        let second_oid = repo.head_oid();

        undo_last_action(repo.path_str()).await.unwrap();
        let first_oid = repo.head_oid();

        // A sibling at the undo point, but the user stays where they were.
        repo.create_branch("experiment");

        redo_last_action(repo.path_str())
            .await
            .expect("redo on the branch the undo moved must still work");

        assert_eq!(repo.head_oid(), second_oid, "redo must restore the commit");
        assert_eq!(
            branch_tip(&repo, "experiment"),
            first_oid,
            "the sibling branch must be untouched by the redo"
        );
    }

    #[tokio::test]
    async fn test_record_action() {
        let repo = TestRepo::with_initial_commit();

        let action = UndoAction {
            action_type: "branch_delete".to_string(),
            description: "Deleted branch feature".to_string(),
            timestamp: 1706400000,
            before_ref: "abc123".to_string(),
            after_ref: "def456".to_string(),
            details: None,
        };

        let result = record_action(repo.path_str(), action).await;
        assert!(result.is_ok());

        // Verify the action was recorded in the reflog
        let history = get_undo_history(repo.path_str(), None).await.unwrap();
        assert!(history.actions.len() >= 2); // initial commit + recorded action
    }

    #[tokio::test]
    async fn test_parse_reflog_action_commit() {
        let (action_type, desc) = parse_reflog_action("commit: Add new feature");
        assert_eq!(action_type, "commit");
        assert!(desc.contains("Add new feature"));
    }

    #[tokio::test]
    async fn test_parse_reflog_action_checkout() {
        let (action_type, desc) = parse_reflog_action("checkout: moving from main to feature");
        assert_eq!(action_type, "checkout");
        assert!(desc.contains("moving from main to feature"));
    }

    #[tokio::test]
    async fn test_parse_reflog_action_merge() {
        let (action_type, desc) = parse_reflog_action("merge feature: Fast-forward");
        assert_eq!(action_type, "merge");
        assert!(desc.contains("Fast-forward"));
    }

    #[tokio::test]
    async fn test_parse_reflog_action_rebase() {
        let (action_type, desc) =
            parse_reflog_action("rebase (finish): refs/heads/main onto abc123");
        assert_eq!(action_type, "rebase");
        assert!(desc.contains("refs/heads/main"));
    }

    #[tokio::test]
    async fn test_parse_reflog_action_reset() {
        let (action_type, desc) = parse_reflog_action("reset: moving to HEAD~1");
        assert_eq!(action_type, "reset");
        assert!(desc.contains("moving to HEAD~1"));
    }

    #[tokio::test]
    async fn test_parse_reflog_action_pull() {
        let (action_type, _desc) = parse_reflog_action("pull: Fast-forward");
        assert_eq!(action_type, "pull");
    }

    #[tokio::test]
    async fn test_parse_reflog_action_cherry_pick() {
        let (action_type, _desc) = parse_reflog_action("cherry-pick: Added feature X");
        assert_eq!(action_type, "cherry_pick");
    }

    #[tokio::test]
    async fn test_parse_reflog_action_revert() {
        let (action_type, _desc) = parse_reflog_action("revert: Revert \"Some commit\"");
        assert_eq!(action_type, "revert");
    }

    #[tokio::test]
    async fn test_parse_reflog_action_amend() {
        let (action_type, desc) = parse_reflog_action("commit (amend): Updated message");
        assert_eq!(action_type, "amend");
        assert!(desc.contains("Updated message"));
    }

    #[tokio::test]
    async fn test_parse_reflog_action_initial_commit() {
        let (action_type, desc) = parse_reflog_action("commit (initial): Initial commit");
        assert_eq!(action_type, "commit");
        assert!(desc.contains("Initial commit"));
    }

    #[tokio::test]
    async fn test_parse_reflog_action_unknown() {
        let (action_type, desc) = parse_reflog_action("something_unexpected: details");
        assert_eq!(action_type, "something_unexpected");
        assert!(desc.contains("details"));
    }

    #[tokio::test]
    async fn test_undo_action_serialization() {
        let action = UndoAction {
            action_type: "commit".to_string(),
            description: "Commit: Add feature".to_string(),
            timestamp: 1706400000,
            before_ref: "abc123".to_string(),
            after_ref: "def456".to_string(),
            details: Some("{\"key\": \"value\"}".to_string()),
        };

        let json = serde_json::to_string(&action);
        assert!(json.is_ok());

        let json_str = json.unwrap();
        assert!(json_str.contains("\"actionType\":\"commit\""));
        assert!(json_str.contains("\"description\":\"Commit: Add feature\""));
        assert!(json_str.contains("\"timestamp\":1706400000"));
        assert!(json_str.contains("\"beforeRef\":\"abc123\""));
        assert!(json_str.contains("\"afterRef\":\"def456\""));
    }

    #[tokio::test]
    async fn test_undo_history_serialization() {
        let history = UndoHistory {
            actions: vec![],
            current_index: -1,
            can_undo: false,
            can_redo: false,
        };

        let json = serde_json::to_string(&history);
        assert!(json.is_ok());

        let json_str = json.unwrap();
        assert!(json_str.contains("\"currentIndex\":-1"));
        assert!(json_str.contains("\"canUndo\":false"));
        assert!(json_str.contains("\"canRedo\":false"));
    }

    #[tokio::test]
    async fn test_undo_action_deserialization() {
        let json = r#"{
            "actionType": "checkout",
            "description": "Checkout: moving from main to feature",
            "timestamp": 1706400000,
            "beforeRef": "abc123",
            "afterRef": "def456",
            "details": null
        }"#;

        let action: UndoAction = serde_json::from_str(json).unwrap();
        assert_eq!(action.action_type, "checkout");
        assert_eq!(action.description, "Checkout: moving from main to feature");
        assert_eq!(action.timestamp, 1706400000);
        assert!(action.details.is_none());
    }

    #[tokio::test]
    async fn test_undo_then_redo_cycle() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid();

        repo.create_commit("Second", &[("f2.txt", "2")]);
        let second_oid = repo.head_oid();

        // Undo second commit -> should be at first
        undo_last_action(repo.path_str()).await.unwrap();
        assert_eq!(repo.head_oid(), first_oid);

        // Redo -> should be back at second
        redo_last_action(repo.path_str()).await.unwrap();
        assert_eq!(repo.head_oid(), second_oid);

        // Undo again -> should be at first again
        undo_last_action(repo.path_str()).await.unwrap();
        assert_eq!(repo.head_oid(), first_oid);
    }

    #[tokio::test]
    async fn test_undo_checkout() {
        let repo = TestRepo::with_initial_commit();
        // Determine the default branch name
        let default_branch = repo.current_branch();
        // Record the OID of the default branch before anything happens.
        let main_oid_before = repo.head_oid();
        repo.create_branch("feature");

        // Create a commit on feature branch with a different tree
        repo.checkout_branch("feature");
        repo.create_commit("Feature work", &[("feature.txt", "work")]);
        let feature_oid = repo.head_oid();
        assert_ne!(feature_oid, main_oid_before);

        // Checkout back to default branch
        repo.checkout_branch(&default_branch);
        assert_eq!(repo.head_oid(), main_oid_before);

        // Undo the checkout. Canonical git undoes a checkout with `git switch -`,
        // which returns to the previous branch *symbolically* and never moves a
        // branch ref.
        let result = undo_last_action(repo.path_str()).await;
        assert!(result.is_ok());

        // HEAD is back on the feature branch (symbolic switch), not the default.
        assert_eq!(repo.current_branch(), "feature");
        assert_eq!(repo.head_oid(), feature_oid);

        // Neither branch ref moved: the default branch stayed where it was, and
        // no commit was orphaned.
        let git_repo = repo.repo();
        let main_ref = git_repo
            .find_branch(&default_branch, git2::BranchType::Local)
            .unwrap();
        assert_eq!(main_ref.get().target().unwrap(), main_oid_before);
        let feature_ref = git_repo
            .find_branch("feature", git2::BranchType::Local)
            .unwrap();
        assert_eq!(feature_ref.get().target().unwrap(), feature_oid);
    }

    #[tokio::test]
    async fn test_undo_record_action_is_refused() {
        // A synthetic record_action entry sits at the current HEAD OID, so
        // "undoing" it would be a no-op mixed reset. That must be refused, not
        // reported as a successful undo that restored nothing.
        let repo = TestRepo::with_initial_commit();
        let head_before = repo.head_oid();

        let action = UndoAction {
            action_type: "branch_delete".to_string(),
            description: "Deleted branch feature".to_string(),
            timestamp: 0,
            before_ref: head_before.to_string(),
            after_ref: head_before.to_string(),
            details: None,
        };
        record_action(repo.path_str(), action).await.unwrap();

        let result = undo_last_action(repo.path_str()).await;
        assert!(result.is_err(), "undo of a no-op record_action must fail");
        // HEAD must be untouched.
        assert_eq!(repo.head_oid(), head_before);
    }

    #[tokio::test]
    async fn test_redo_after_user_reset_is_refused() {
        // A reset the user performed themselves (here via reset_to_reflog) is
        // NOT an app undo, so redo must refuse and must NOT revert it.
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second", &[("f2.txt", "2")]);
        let second_oid = repo.head_oid();

        crate::commands::reflog::reset_to_reflog(repo.path_str(), 1, "hard".to_string(), None)
            .await
            .unwrap();
        let after_reset = repo.head_oid();
        assert_ne!(after_reset, second_oid);

        let result = redo_last_action(repo.path_str()).await;
        assert!(
            result.is_err(),
            "redo must not fire after a user-initiated reset"
        );
        // The user's deliberate reset is preserved.
        assert_eq!(repo.head_oid(), after_reset);
    }

    #[tokio::test]
    async fn test_undo_refused_during_bisect() {
        // A reset mid-bisect would erase .git/BISECT_LOG; git preserves it.
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second", &[("f2.txt", "2")]);
        let second_oid = repo.head_oid();

        std::fs::write(repo.path.join(".git").join("BISECT_LOG"), b"").unwrap();
        assert_eq!(repo.repo().state(), git2::RepositoryState::Bisect);

        let result = undo_last_action(repo.path_str()).await;
        assert!(result.is_err(), "undo must refuse during a bisect");
        assert_eq!(repo.head_oid(), second_oid);
        assert!(repo.path.join(".git").join("BISECT_LOG").exists());
    }

    #[tokio::test]
    async fn test_get_undo_history_invalid_path() {
        let result = get_undo_history("/nonexistent/path".to_string(), None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_undo_last_action_invalid_path() {
        let result = undo_last_action("/nonexistent/path".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_redo_last_action_invalid_path() {
        let result = redo_last_action("/nonexistent/path".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_record_action_invalid_path() {
        let action = UndoAction {
            action_type: "commit".to_string(),
            description: "test".to_string(),
            timestamp: 0,
            before_ref: "".to_string(),
            after_ref: "".to_string(),
            details: None,
        };
        let result = record_action("/nonexistent/path".to_string(), action).await;
        assert!(result.is_err());
    }
}
