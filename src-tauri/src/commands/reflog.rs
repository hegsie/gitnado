//! Reflog command handlers for undo/redo operations

use std::path::Path;
use tauri::command;

use crate::error::Result;

/// Refuse to reset while a multi-step operation (rebase, bisect, or a
/// cherry-pick/revert *sequence*) is in progress. Canonical `git reset` leaves
/// `.git/rebase-merge`, `.git/rebase-apply`, `.git/BISECT_LOG` and the sequencer
/// directory in place, but libgit2's reset unconditionally runs
/// `git_repository_state_cleanup` for MIXED/HARD resets and deletes them,
/// silently destroying the in-progress operation. Mirror git by refusing.
/// (A plain single-op Merge / CherryPick / Revert is intentionally allowed:
/// `git reset` is the documented way to abort those.)
pub(crate) fn ensure_resettable(repo: &git2::Repository) -> Result<()> {
    use git2::RepositoryState::*;
    match repo.state() {
        Rebase | RebaseInteractive | RebaseMerge | ApplyMailbox | ApplyMailboxOrRebase => {
            Err(crate::error::GitnadoError::OperationFailed(
                "Cannot reset while a rebase is in progress. Finish or abort the rebase (git rebase --continue or --abort) first.".to_string(),
            ))
        }
        Bisect => Err(crate::error::GitnadoError::OperationFailed(
            "Cannot reset while a bisect is in progress. Run 'git bisect reset' first.".to_string(),
        )),
        CherryPickSequence => Err(crate::error::GitnadoError::OperationFailed(
            "Cannot reset while a cherry-pick sequence is in progress. Finish or abort it (git cherry-pick --continue or --abort) first.".to_string(),
        )),
        RevertSequence => Err(crate::error::GitnadoError::OperationFailed(
            "Cannot reset while a revert sequence is in progress. Finish or abort it (git revert --continue or --abort) first.".to_string(),
        )),
        _ => Ok(()),
    }
}

/// A reflog entry representing a recorded state change
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    /// The commit OID this entry points to
    pub oid: String,
    /// Short form of the OID
    pub short_id: String,
    /// The reflog index (0 = most recent)
    pub index: usize,
    /// The action that was performed (e.g., "commit", "checkout", "rebase")
    pub action: String,
    /// Human-readable message describing what happened
    pub message: String,
    /// Unix timestamp of when this happened
    pub timestamp: i64,
    /// Author name who performed the action
    pub author: String,
}

/// Get the reflog entries for HEAD
#[command]
pub async fn get_reflog(path: String, limit: Option<usize>) -> Result<Vec<ReflogEntry>> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let reflog = repo.reflog("HEAD")?;

    let limit_count = limit.unwrap_or(100);
    let mut entries = Vec::new();

    for (index, entry) in reflog.iter().enumerate() {
        if entries.len() >= limit_count {
            break;
        }

        let oid = entry.id_new();
        let message = entry.message().ok().flatten().unwrap_or("").to_string();

        // Parse action from message (format is usually "action: details")
        let action = message
            .split(':')
            .next()
            .unwrap_or("unknown")
            .trim()
            .to_string();

        entries.push(ReflogEntry {
            oid: oid.to_string(),
            short_id: oid.to_string()[..7.min(oid.to_string().len())].to_string(),
            index,
            action,
            message,
            timestamp: entry.committer().when().seconds(),
            author: entry
                .committer()
                .name()
                .ok()
                .unwrap_or("Unknown")
                .to_string(),
        });
    }

    Ok(entries)
}

/// Reset HEAD to a specific reflog entry (undo operation)
#[command]
pub async fn reset_to_reflog(
    path: String,
    reflog_index: usize,
    mode: String,
    expected_oid: Option<String>,
) -> Result<ReflogEntry> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Extract entry info before any borrows
    let (target_oid_str, message, timestamp, author) = {
        let reflog = repo.reflog("HEAD")?;
        let entry = reflog.get(reflog_index).ok_or_else(|| {
            crate::error::GitnadoError::OperationFailed(format!(
                "Reflog entry {} not found",
                reflog_index
            ))
        })?;

        let oid_str = entry.id_new().to_string();

        // `reflog_index` is a POSITION: anything that writes HEAD's reflog (a
        // commit or checkout from a terminal, or a second window) shifts every
        // entry down by one. The caller listed the reflog earlier and showed the
        // user a specific commit, so verify the position still holds that commit
        // before resetting — otherwise a hard reset discards uncommitted work to
        // land somewhere the user never chose.
        if let Some(expected) = &expected_oid {
            if &oid_str != expected {
                return Err(crate::error::GitnadoError::OperationFailed(
                    "The reflog changed since this entry was listed — refresh and try again."
                        .to_string(),
                ));
            }
        }
        let msg = entry.message().ok().flatten().unwrap_or("").to_string();
        let committer = entry.committer();
        let ts = committer.when().seconds();
        let auth = committer.name().ok().unwrap_or("Unknown").to_string();

        (oid_str, msg, ts, auth)
    };

    let target_oid = git2::Oid::from_str(&target_oid_str)?;
    let target_commit = repo.find_commit(target_oid)?;

    // Determine reset type
    let reset_type = match mode.as_str() {
        "soft" => git2::ResetType::Soft,
        "mixed" => git2::ResetType::Mixed,
        "hard" => git2::ResetType::Hard,
        _ => git2::ResetType::Mixed,
    };

    // A MIXED or HARD reset triggers libgit2's repository state cleanup, which
    // would delete any in-progress rebase/bisect/sequencer state.
    //
    // A SOFT reset skips that cleanup, but it still repoints HEAD — and doing
    // that under a paused rebase leaves the sequencer's orig-head/onto files
    // describing a base the user never chose, so Continue replays onto the
    // wrong commit. `rewrite.rs`'s reset applies this check for every mode, so
    // gating it on the type here meant the same soft reset was refused from the
    // graph and allowed from Undo History. Round 30 shared the helper between
    // the two paths but not the condition; this finishes that.
    ensure_resettable(&repo)?;

    // Perform the reset
    repo.reset(target_commit.as_object(), reset_type, None)?;

    // Return info about where we reset to
    Ok(ReflogEntry {
        oid: target_oid_str.clone(),
        short_id: target_oid_str[..7.min(target_oid_str.len())].to_string(),
        index: reflog_index,
        action: "reset".to_string(),
        message,
        timestamp,
        author,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[tokio::test]
    async fn test_get_reflog_empty_repo() {
        let repo = TestRepo::new();

        // Empty repo has no reflog entries
        let result = get_reflog(repo.path_str(), None).await;
        assert!(result.is_ok());
        let entries = result.unwrap();
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn test_get_reflog_with_commits() {
        let repo = TestRepo::with_initial_commit();

        let result = get_reflog(repo.path_str(), None).await;
        assert!(result.is_ok());

        let entries = result.unwrap();
        assert!(!entries.is_empty());

        // First entry (index 0) should be the most recent
        let first = &entries[0];
        assert_eq!(first.index, 0);
        assert!(!first.oid.is_empty());
        assert!(!first.short_id.is_empty());
        assert_eq!(first.short_id.len(), 7);
    }

    #[tokio::test]
    async fn test_get_reflog_multiple_commits() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second commit", &[("file2.txt", "content2")]);
        repo.create_commit("Third commit", &[("file3.txt", "content3")]);

        let result = get_reflog(repo.path_str(), None).await;
        assert!(result.is_ok());

        let entries = result.unwrap();
        // Should have at least 3 entries (for 3 commits)
        assert!(entries.len() >= 3);

        // Entries should be ordered by index
        for (i, entry) in entries.iter().enumerate() {
            assert_eq!(entry.index, i);
        }
    }

    #[tokio::test]
    async fn test_get_reflog_with_limit() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second", &[("f2.txt", "2")]);
        repo.create_commit("Third", &[("f3.txt", "3")]);
        repo.create_commit("Fourth", &[("f4.txt", "4")]);
        repo.create_commit("Fifth", &[("f5.txt", "5")]);

        let result = get_reflog(repo.path_str(), Some(2)).await;
        assert!(result.is_ok());

        let entries = result.unwrap();
        assert_eq!(entries.len(), 2);

        // Should be the most recent 2 entries
        assert_eq!(entries[0].index, 0);
        assert_eq!(entries[1].index, 1);
    }

    #[tokio::test]
    async fn test_get_reflog_limit_larger_than_entries() {
        let repo = TestRepo::with_initial_commit();

        let result = get_reflog(repo.path_str(), Some(1000)).await;
        assert!(result.is_ok());

        let entries = result.unwrap();
        // Should return all entries, not error
        assert!(!entries.is_empty());
    }

    #[tokio::test]
    async fn test_get_reflog_action_parsing() {
        let repo = TestRepo::with_initial_commit();

        // Create a branch and checkout to generate different reflog actions
        repo.create_branch("feature");
        repo.checkout_branch("feature");

        let result = get_reflog(repo.path_str(), None).await;
        assert!(result.is_ok());

        let entries = result.unwrap();
        assert!(!entries.is_empty());

        // Most recent entry should be a checkout action
        let latest = &entries[0];
        assert!(
            latest.action == "checkout" || latest.message.contains("checkout"),
            "Expected checkout action, got: {} (message: {})",
            latest.action,
            latest.message
        );
    }

    #[tokio::test]
    async fn test_get_reflog_author_info() {
        let repo = TestRepo::with_initial_commit();

        let result = get_reflog(repo.path_str(), None).await;
        assert!(result.is_ok());

        let entries = result.unwrap();
        assert!(!entries.is_empty());

        // Author should match the configured test user
        let entry = &entries[0];
        assert_eq!(entry.author, "Test User");
    }

    #[tokio::test]
    async fn test_get_reflog_timestamp() {
        let repo = TestRepo::with_initial_commit();

        let result = get_reflog(repo.path_str(), None).await;
        assert!(result.is_ok());

        let entries = result.unwrap();
        assert!(!entries.is_empty());

        // Timestamp should be reasonable (after year 2000)
        let entry = &entries[0];
        assert!(entry.timestamp > 946684800); // Jan 1, 2000
    }

    #[tokio::test]
    async fn test_reset_to_reflog_soft() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid();

        repo.create_commit("Second commit", &[("file2.txt", "content2")]);
        let second_oid = repo.head_oid();

        assert_ne!(first_oid, second_oid);

        // Reset soft to first commit (reflog index 1)
        let result = reset_to_reflog(repo.path_str(), 1, "soft".to_string(), None).await;
        assert!(result.is_ok());

        let entry = result.unwrap();
        assert_eq!(entry.action, "reset");
        assert_eq!(entry.oid, first_oid.to_string());

        // HEAD should now point to first commit
        assert_eq!(repo.head_oid(), first_oid);

        // With soft reset, changes should be staged
        let git_repo = repo.repo();
        let status = git_repo.statuses(None).unwrap();
        // The file from second commit should show as staged
        assert!(!status.is_empty() || repo.path.join("file2.txt").exists());
    }

    #[tokio::test]
    async fn test_reset_to_reflog_mixed() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid();

        repo.create_commit("Second commit", &[("file2.txt", "content2")]);

        // Reset mixed to first commit
        let result = reset_to_reflog(repo.path_str(), 1, "mixed".to_string(), None).await;
        assert!(result.is_ok());

        // HEAD should now point to first commit
        assert_eq!(repo.head_oid(), first_oid);
    }

    #[tokio::test]
    async fn test_reset_to_reflog_hard() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid();

        repo.create_commit("Second commit", &[("file2.txt", "content2")]);
        assert!(repo.path.join("file2.txt").exists());

        // Reset hard to first commit
        let result = reset_to_reflog(repo.path_str(), 1, "hard".to_string(), None).await;
        assert!(result.is_ok());

        // HEAD should point to first commit
        assert_eq!(repo.head_oid(), first_oid);

        // With hard reset, the file should be gone
        assert!(!repo.path.join("file2.txt").exists());
    }

    #[tokio::test]
    async fn test_reset_to_reflog_invalid_mode_uses_mixed() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid();

        repo.create_commit("Second", &[("f.txt", "c")]);

        // Invalid mode should default to mixed
        let result = reset_to_reflog(repo.path_str(), 1, "invalid".to_string(), None).await;
        assert!(result.is_ok());
        assert_eq!(repo.head_oid(), first_oid);
    }

    #[tokio::test]
    async fn test_reset_to_reflog_invalid_index() {
        let repo = TestRepo::with_initial_commit();

        // Try to reset to a nonexistent reflog entry
        let result = reset_to_reflog(repo.path_str(), 9999, "mixed".to_string(), None).await;
        assert!(result.is_err());

        let err = result.unwrap_err();
        assert!(err.to_string().contains("not found"));
    }

    #[tokio::test]
    async fn test_reset_to_reflog_refuses_when_entry_shifted() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second", &[("f2.txt", "2")]);

        // What the UI listed and showed the user at index 1.
        let listed = get_reflog(repo.path_str(), None).await.unwrap();
        let expected_oid = listed[1].oid.clone();

        // A commit from a terminal / second window pushes every entry down one,
        // so index 1 now names a DIFFERENT commit than the user selected.
        repo.create_commit("Third", &[("f3.txt", "3")]);

        let head_before = repo.head_oid();
        let result = reset_to_reflog(
            repo.path_str(),
            1,
            "hard".to_string(),
            Some(expected_oid.clone()),
        )
        .await;

        assert!(result.is_err(), "a shifted entry must not be reset to");
        assert!(result.unwrap_err().to_string().contains("reflog changed"));
        assert_eq!(
            repo.head_oid(),
            head_before,
            "HEAD must be untouched when the guard trips"
        );
    }

    #[tokio::test]
    async fn test_reset_to_reflog_proceeds_when_oid_matches() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second", &[("f2.txt", "2")]);

        let listed = get_reflog(repo.path_str(), None).await.unwrap();
        let expected_oid = listed[1].oid.clone();

        // Nothing shifted, so the pinned oid still matches index 1.
        let result = reset_to_reflog(
            repo.path_str(),
            1,
            "mixed".to_string(),
            Some(expected_oid.clone()),
        )
        .await;

        assert!(result.is_ok(), "a matching oid must not be blocked");
        assert_eq!(result.unwrap().oid, expected_oid);
    }

    #[tokio::test]
    async fn test_reset_to_reflog_returns_correct_entry_info() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second", &[("f2.txt", "2")]);

        let result = reset_to_reflog(repo.path_str(), 1, "mixed".to_string(), None).await;
        assert!(result.is_ok());

        let entry = result.unwrap();
        assert_eq!(entry.index, 1);
        assert_eq!(entry.action, "reset");
        assert!(!entry.oid.is_empty());
        assert_eq!(entry.short_id.len(), 7);
        assert_eq!(entry.author, "Test User");
    }

    #[tokio::test]
    async fn test_reflog_entry_struct_serialization() {
        let entry = ReflogEntry {
            oid: "abc123def456789".to_string(),
            short_id: "abc123d".to_string(),
            index: 5,
            action: "commit".to_string(),
            message: "commit: Added new feature".to_string(),
            timestamp: 1700000000,
            author: "John Doe".to_string(),
        };

        let json = serde_json::to_string(&entry);
        assert!(json.is_ok());

        let json_str = json.unwrap();
        assert!(json_str.contains("\"oid\":\"abc123def456789\""));
        assert!(json_str.contains("\"shortId\":\"abc123d\""));
        assert!(json_str.contains("\"index\":5"));
        assert!(json_str.contains("\"action\":\"commit\""));
        assert!(json_str.contains("\"timestamp\":1700000000"));
    }

    #[tokio::test]
    async fn test_get_reflog_zero_limit() {
        let repo = TestRepo::with_initial_commit();

        // Limit of 0 should return empty (though default is 100)
        let result = get_reflog(repo.path_str(), Some(0)).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_reset_to_reflog_refused_during_bisect() {
        // A mixed/hard reset would erase .git/BISECT_LOG (libgit2 state cleanup);
        // canonical git preserves it. The reset must be refused.
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second", &[("f2.txt", "2")]);
        let second_oid = repo.head_oid();

        std::fs::write(repo.path.join(".git").join("BISECT_LOG"), b"").unwrap();
        assert_eq!(repo.repo().state(), git2::RepositoryState::Bisect);

        // Hard reset must be refused.
        let hard = reset_to_reflog(repo.path_str(), 1, "hard".to_string(), None).await;
        assert!(hard.is_err(), "hard reset must refuse during a bisect");

        // Mixed reset must be refused.
        let mixed = reset_to_reflog(repo.path_str(), 1, "mixed".to_string(), None).await;
        assert!(mixed.is_err(), "mixed reset must refuse during a bisect");

        // HEAD and the bisect state are both preserved.
        assert_eq!(repo.head_oid(), second_oid);
        assert!(repo.path.join(".git").join("BISECT_LOG").exists());
    }

    #[tokio::test]
    async fn test_reset_to_reflog_index_zero() {
        let repo = TestRepo::with_initial_commit();
        let oid = repo.head_oid();

        repo.create_commit("Second", &[("f.txt", "c")]);

        // Reset to index 0 (current HEAD) should be a no-op essentially
        let result = reset_to_reflog(repo.path_str(), 0, "mixed".to_string(), None).await;
        assert!(result.is_ok());

        // Should point to the second commit (most recent)
        assert_ne!(repo.head_oid(), oid);
    }
}
