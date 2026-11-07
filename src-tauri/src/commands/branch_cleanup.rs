//! Branch cleanup command handlers
//!
//! Provides server-side logic for identifying branches that are candidates
//! for cleanup: merged, stale, or with gone (deleted) upstream tracking branches.
//! Uses graph ancestry plus patch-id and tree comparison
//! (`services::merge_detection`) so branches landed via "Rebase and merge" or
//! "Squash and merge" are recognised as merged, not just true ancestors.

use std::path::Path;

use serde::Serialize;
use tauri::command;

use crate::error::Result;
use crate::models::AheadBehind;
use crate::services::merge_detection::{MergeDetector, MergeKind};

use super::branch_rules::load_rules;

/// Default stale threshold in days
const DEFAULT_STALE_DAYS: i64 = 90;

/// A branch that is a candidate for cleanup
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCandidate {
    /// Full branch name
    pub name: String,
    /// Short display name
    pub shorthand: String,
    /// Category: "merged", "stale", or "gone"
    pub category: String,
    /// Unix timestamp of the last commit on this branch
    pub last_commit_timestamp: Option<i64>,
    /// Display name of the last commit's author on this branch
    pub last_commit_author: Option<String>,
    /// Email address of the last commit's author on this branch
    pub last_commit_author_email: Option<String>,
    /// Whether the branch is protected by a branch rule
    pub is_protected: bool,
    /// The upstream tracking reference, if any
    pub upstream: Option<String>,
    /// Ahead/behind counts relative to upstream (or HEAD for gone/remote branches)
    pub ahead_behind: Option<AheadBehind>,
    /// Whether this candidate is a remote-tracking branch (e.g. "origin/feature")
    pub is_remote: bool,
    /// Remote name when `is_remote` is true (e.g. "origin")
    pub remote_name: Option<String>,
    /// How the branch was merged into HEAD (`ancestor`, `rebase`, `squash`).
    /// Set on every entry of a merged branch, `None` when not merged.
    pub merge_kind: Option<MergeKind>,
}

/// Get all branches that are candidates for cleanup.
///
/// Returns branches categorized as:
/// - **merged**: all of the branch's changes are in HEAD — HEAD descends from
///   it, or its commits were rebase-merged / squash-merged (see `merge_kind`)
/// - **stale**: last commit is older than `stale_days` (default 90)
/// - **gone**: branch has upstream configured but the remote branch no longer exists
///
/// A branch can appear multiple times if it matches more than one category.
/// Protected branches (matching branch rules with `prevent_deletion`) are flagged.
#[command]
pub async fn get_cleanup_candidates(
    path: String,
    stale_days: Option<i64>,
) -> Result<Vec<CleanupCandidate>> {
    crate::utils::blocking_git(move || {
        let repo = git2::Repository::open(Path::new(&path))?;
        let mut candidates = Vec::new();

        let head = repo.head()?;
        let head_oid = match head.target() {
            Some(oid) => oid,
            None => return Ok(candidates),
        };

        let stale_days = stale_days.unwrap_or(DEFAULT_STALE_DAYS).clamp(0, 36_500);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let stale_threshold = if stale_days > 0 {
            now.saturating_sub(stale_days.saturating_mul(24 * 60 * 60))
        } else {
            0 // disabled
        };

        // Propagate load_rules error (returns Ok(vec![]) when branch_rules.json does
        // not exist, and Err when the file is unreadable or corrupt) so a corrupt
        // rules file never silently strips deletion protection in the cleanup list.
        let rules = load_rules(Path::new(&path))?;

        // Shared with delete_branch's enforcement so the badge shown here and the
        // rule actually applied at delete time can never diverge.
        let is_protected = |branch_name: &str| -> bool {
            super::branch_rules::is_deletion_prevented(&rules, branch_name)
        };

        let config = repo.config().ok();
        let mut merge_detector = MergeDetector::new(&repo, head_oid);

        for branch_result in repo.branches(Some(git2::BranchType::Local))? {
            let (branch, _) = branch_result?;
            let name = branch.name()?.unwrap_or("").to_string();

            // Skip HEAD branch
            let reference = branch.get();
            let is_head = head
                .name()
                .and_then(|h| reference.name().map(|r| h == r))
                .unwrap_or(false);
            if is_head {
                continue;
            }

            let branch_oid = match reference.target() {
                Some(oid) => oid,
                None => continue,
            };

            let (last_commit_timestamp, last_commit_author, last_commit_author_email) = repo
                .find_commit(branch_oid)
                .ok()
                .map(|commit| {
                    let sig = commit.author();
                    let name = sig
                        .name()
                        .ok()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty());
                    let email = sig
                        .email()
                        .ok()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty());
                    (Some(commit.time().seconds()), name, email)
                })
                .unwrap_or((None, None, None));

            let upstream_branch = branch.upstream().ok();
            let upstream = upstream_branch
                .as_ref()
                .and_then(|u| u.name().ok().flatten().map(|n| n.to_string()));

            let protected = is_protected(&name);

            // Check if upstream is gone
            let is_gone = {
                let has_merge = config
                    .as_ref()
                    .and_then(|c| c.get_string(&format!("branch.{}.merge", name)).ok())
                    .is_some();
                let has_remote = config
                    .as_ref()
                    .and_then(|c| c.get_string(&format!("branch.{}.remote", name)).ok())
                    .is_some();
                // Gone if upstream is configured but branch.upstream() fails
                has_merge && has_remote && upstream_branch.is_none()
            };

            let ahead_behind = if let Some(ref upstream_branch) = upstream_branch {
                if let Some(upstream_oid) = upstream_branch.get().target() {
                    repo.graph_ahead_behind(branch_oid, upstream_oid)
                        .ok()
                        .map(|(ahead, behind)| AheadBehind { ahead, behind })
                } else {
                    None
                }
            } else if is_gone {
                // Upstream was deleted, so ahead/behind relative to it is
                // impossible. Measure divergence from HEAD instead: a gone branch
                // with commits not in HEAD is exactly what `git branch -d` refuses
                // as "not fully merged", so the UI must be able to flag it as risky
                // (unpushed commits) rather than silently "safe".
                repo.graph_ahead_behind(branch_oid, head_oid)
                    .ok()
                    .map(|(ahead, behind)| AheadBehind { ahead, behind })
            } else {
                None
            };

            // Merged when HEAD descends from (or equals) the branch tip, or when
            // the branch's changes landed via rebase- or squash-merge. Detection
            // errors are treated as "not merged" so a failure never labels a
            // branch safe to delete.
            let merge_kind = merge_detector.detect(branch_oid).unwrap_or(None);
            let is_merged = merge_kind.is_some();

            // Check if stale
            let is_stale = stale_days > 0
                && last_commit_timestamp
                    .map(|ts| ts < stale_threshold)
                    .unwrap_or(false);

            let base = |category: &str| CleanupCandidate {
                name: name.clone(),
                shorthand: name.clone(),
                category: category.to_string(),
                last_commit_timestamp,
                last_commit_author: last_commit_author.clone(),
                last_commit_author_email: last_commit_author_email.clone(),
                is_protected: protected,
                upstream: upstream.clone(),
                ahead_behind: ahead_behind.clone(),
                is_remote: false,
                remote_name: None,
                merge_kind,
            };

            if is_merged {
                candidates.push(base("merged"));
            }
            if is_stale {
                candidates.push(base("stale"));
            }
            if is_gone {
                candidates.push(base("gone"));
            }
        }

        // Determine the current HEAD branch's shorthand and upstream so we skip the
        // remote branch corresponding to HEAD (e.g., "origin/main" when HEAD is "main").
        let head_shorthand = head.shorthand().ok().map(|s| s.to_string());
        let head_upstream_name = head_shorthand
            .as_deref()
            .and_then(|name| repo.find_branch(name, git2::BranchType::Local).ok())
            .and_then(|b| b.upstream().ok())
            .and_then(|u| u.name().ok().flatten().map(|n| n.to_string()));

        for branch_result in repo.branches(Some(git2::BranchType::Remote))? {
            let (branch, _) = branch_result?;
            let reference = branch.get();

            // Skip symbolic remote references such as "origin/HEAD -> origin/main"
            if reference.kind() == Some(git2::ReferenceType::Symbolic) {
                continue;
            }

            let name = branch.name()?.unwrap_or("").to_string();
            if name.is_empty() {
                continue;
            }

            let (remote_name, shorthand) = match name.split_once('/') {
                Some((r, s)) if !r.is_empty() && !s.is_empty() => (r.to_string(), s.to_string()),
                _ => continue,
            };

            if shorthand == "HEAD" {
                continue;
            }

            // Skip the remote branch that HEAD is tracking or that shares HEAD's branch name
            if head_upstream_name.as_deref() == Some(name.as_str())
                || head_shorthand.as_deref() == Some(shorthand.as_str())
            {
                continue;
            }

            let branch_oid = match reference.target() {
                Some(oid) => oid,
                None => continue,
            };

            let (last_commit_timestamp, last_commit_author, last_commit_author_email) = repo
                .find_commit(branch_oid)
                .ok()
                .map(|commit| {
                    let sig = commit.author();
                    let name = sig
                        .name()
                        .ok()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty());
                    let email = sig
                        .email()
                        .ok()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty());
                    (Some(commit.time().seconds()), name, email)
                })
                .unwrap_or((None, None, None));

            let protected = is_protected(&name) || is_protected(&shorthand);

            // Compare remote branch against HEAD so the UI knows whether deleting the
            // remote branch would discard commits not in the current branch.
            let ahead_behind = repo
                .graph_ahead_behind(branch_oid, head_oid)
                .ok()
                .map(|(ahead, behind)| AheadBehind { ahead, behind });

            let merge_kind = merge_detector.detect(branch_oid).unwrap_or(None);
            let is_merged = merge_kind.is_some();

            let is_stale = stale_days > 0
                && last_commit_timestamp
                    .map(|ts| ts < stale_threshold)
                    .unwrap_or(false);

            let base = |category: &str| CleanupCandidate {
                name: name.clone(),
                shorthand: shorthand.clone(),
                category: category.to_string(),
                last_commit_timestamp,
                last_commit_author: last_commit_author.clone(),
                last_commit_author_email: last_commit_author_email.clone(),
                is_protected: protected,
                upstream: None,
                ahead_behind: ahead_behind.clone(),
                is_remote: true,
                remote_name: Some(remote_name.clone()),
                merge_kind,
            };

            if is_merged {
                candidates.push(base("merged"));
            }
            if is_stale {
                candidates.push(base("stale"));
            }
        }

        Ok(candidates)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[test]
    fn test_cleanup_candidate_serialization() {
        let candidate = CleanupCandidate {
            name: "feature/old".to_string(),
            shorthand: "feature/old".to_string(),
            category: "merged".to_string(),
            last_commit_timestamp: Some(1700000000),
            last_commit_author: Some("Alice".to_string()),
            last_commit_author_email: Some("alice@example.com".to_string()),
            is_protected: false,
            upstream: Some("origin/feature/old".to_string()),
            ahead_behind: Some(AheadBehind {
                ahead: 0,
                behind: 2,
            }),
            is_remote: false,
            remote_name: None,
            merge_kind: Some(MergeKind::Squash),
        };

        let json = serde_json::to_string(&candidate).expect("Failed to serialize");
        assert!(json.contains("\"name\""));
        assert!(json.contains("\"shorthand\""));
        assert!(json.contains("\"category\""));
        assert!(json.contains("\"lastCommitTimestamp\""));
        assert!(json.contains("\"isProtected\""));
        assert!(json.contains("\"upstream\""));
        assert!(json.contains("\"aheadBehind\""));
        assert!(json.contains("\"mergeKind\":\"squash\""));
        // Verify camelCase
        assert!(!json.contains("last_commit_timestamp"));
        assert!(!json.contains("is_protected"));
        assert!(!json.contains("ahead_behind"));
        assert!(!json.contains("merge_kind"));
    }

    #[tokio::test]
    async fn test_get_cleanup_candidates_empty_repo() {
        let repo = TestRepo::with_initial_commit();
        let result = get_cleanup_candidates(repo.path_str(), None).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_get_cleanup_candidates_merged_branch() {
        let repo = TestRepo::with_initial_commit();
        // Create a branch at current HEAD, then add a commit on main
        // The branch will be "merged" since HEAD contains all its commits
        repo.create_branch("feature-done");
        repo.create_commit("Another commit", &[("file.txt", "content")]);

        let result = get_cleanup_candidates(repo.path_str(), None).await;
        assert!(result.is_ok());
        let candidates = result.unwrap();
        assert!(
            candidates
                .iter()
                .any(|c| c.name == "feature-done" && c.category == "merged"),
            "Expected feature-done to be a merged candidate"
        );
    }

    #[tokio::test]
    async fn test_get_cleanup_candidates_skips_head() {
        let repo = TestRepo::with_initial_commit();
        let result = get_cleanup_candidates(repo.path_str(), None).await;
        assert!(result.is_ok());
        let candidates = result.unwrap();
        // HEAD branch should never appear
        assert!(
            !candidates.iter().any(|c| c.name == repo.current_branch()),
            "HEAD branch should not be a cleanup candidate"
        );
    }

    #[tokio::test]
    async fn test_get_cleanup_candidates_stale_disabled() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("old-branch");

        // stale_days=0 disables stale detection
        let result = get_cleanup_candidates(repo.path_str(), Some(0)).await;
        assert!(result.is_ok());
        let candidates = result.unwrap();
        assert!(
            !candidates.iter().any(|c| c.category == "stale"),
            "No stale candidates when stale_days=0"
        );
    }

    #[tokio::test]
    async fn test_get_cleanup_candidates_branch_at_head_is_merged() {
        // Finding 19: a branch pointing at the same commit as HEAD is merged.
        // `git branch --merged` lists it and `git branch -d` deletes it, but
        // graph_descendant_of(head, branch) returns false for equal OIDs.
        let repo = TestRepo::with_initial_commit();
        // Create branches at HEAD without advancing main.
        repo.create_branch("b1");
        repo.create_branch("b2");

        let result = get_cleanup_candidates(repo.path_str(), Some(0)).await;
        assert!(result.is_ok());
        let candidates = result.unwrap();
        assert!(
            candidates
                .iter()
                .any(|c| c.name == "b1" && c.category == "merged"),
            "Branch b1 at HEAD should be a merged candidate (git branch --merged lists it)"
        );
        assert!(
            candidates
                .iter()
                .any(|c| c.name == "b2" && c.category == "merged"),
            "Branch b2 at HEAD should be a merged candidate (git branch --merged lists it)"
        );
    }

    #[tokio::test]
    async fn test_get_cleanup_candidates_gone_branch_reports_unpushed_commits() {
        // Finding 12: a branch whose upstream was deleted and which contains
        // commits not in HEAD is exactly the case git protects (`git branch -d`
        // refuses "not fully merged"). The backend must compute ahead relative
        // to HEAD for gone branches so the UI flags them as risky, not merged.
        let repo = TestRepo::with_initial_commit();

        // Local branch "feature" configured to track origin/feature, but with
        // NO remote-tracking ref present (simulating the remote branch being
        // deleted and pruned) — so branch.upstream() fails ("gone" upstream).
        repo.create_branch("feature");
        {
            let git_repo = repo.repo();
            let mut config = git_repo.config().expect("config");
            config
                .set_str("branch.feature.remote", "origin")
                .expect("set remote");
            config
                .set_str("branch.feature.merge", "refs/heads/feature")
                .expect("set merge");
        }
        // Advance "feature" by 2 commits not contained in HEAD (main).
        repo.checkout_branch("feature");
        repo.create_commit("wip 1", &[("wip1.txt", "one")]);
        repo.create_commit("wip 2", &[("wip2.txt", "two")]);
        repo.checkout_branch("main");

        let result = get_cleanup_candidates(repo.path_str(), Some(0)).await;
        assert!(result.is_ok());
        let candidates = result.unwrap();
        let gone = candidates
            .iter()
            .find(|c| c.name == "feature" && c.category == "gone")
            .expect("feature should be a gone candidate");
        let ab = gone
            .ahead_behind
            .as_ref()
            .expect("gone branch must report ahead/behind relative to HEAD");
        assert_eq!(
            ab.ahead, 2,
            "gone branch with 2 unpushed commits must report ahead=2 so the UI flags it as risky"
        );
    }

    #[tokio::test]
    async fn test_get_cleanup_candidates_unmerged_branch_not_in_merged() {
        let repo = TestRepo::with_initial_commit();
        // Create a branch and add a commit on it that's NOT in HEAD
        repo.create_branch("feature-wip");
        repo.checkout_branch("feature-wip");
        repo.create_commit("WIP commit", &[("wip.txt", "wip content")]);
        repo.checkout_branch("main");

        let result = get_cleanup_candidates(repo.path_str(), Some(0)).await;
        assert!(result.is_ok());
        let candidates = result.unwrap();
        // feature-wip should NOT appear as merged
        assert!(
            !candidates
                .iter()
                .any(|c| c.name == "feature-wip" && c.category == "merged"),
            "Unmerged branch should not be a merged candidate"
        );
    }

    #[tokio::test]
    async fn test_get_cleanup_candidates_includes_remote_merged_and_skips_head_upstream() {
        let test_repo = TestRepo::with_initial_commit();
        let default_branch = test_repo.current_branch();
        let initial_oid = test_repo.head_oid();
        test_repo.create_commit("advance main", &[("file.txt", "v2")]);
        let latest_oid = test_repo.head_oid();

        {
            let repo = test_repo.repo();
            // Remote branch matching HEAD's branch name (should be skipped)
            repo.reference(
                &format!("refs/remotes/origin/{}", default_branch),
                latest_oid,
                true,
                "remote head branch",
            )
            .unwrap();
            // Symbolic remote HEAD (should be skipped)
            repo.reference_symbolic(
                "refs/remotes/origin/HEAD",
                &format!("refs/remotes/origin/{}", default_branch),
                true,
                "remote head symref",
            )
            .unwrap();
            // Remote branch that is merged into HEAD
            repo.reference(
                "refs/remotes/origin/feature/old-merged",
                initial_oid,
                true,
                "merged remote branch",
            )
            .unwrap();
        }

        let candidates = get_cleanup_candidates(test_repo.path_str(), Some(0))
            .await
            .expect("should return candidates");

        assert!(
            !candidates
                .iter()
                .any(|c| c.name == format!("origin/{}", default_branch) || c.name == "origin/HEAD"),
            "origin/HEAD and origin/<default_branch> must not be offered as cleanup candidates"
        );

        let remote_merged = candidates
            .iter()
            .find(|c| c.name == "origin/feature/old-merged" && c.category == "merged")
            .expect("origin/feature/old-merged should be returned as a merged remote candidate");
        assert!(remote_merged.is_remote);
        assert_eq!(remote_merged.remote_name.as_deref(), Some("origin"));
        assert_eq!(remote_merged.shorthand, "feature/old-merged");
    }

    #[tokio::test]
    async fn test_get_cleanup_candidates_squash_merged_branch() {
        let repo = TestRepo::with_initial_commit();
        let main = repo.current_branch();
        let base = repo.head_oid();
        repo.create_branch("feature-squashed");
        repo.checkout_branch("feature-squashed");
        repo.create_commit("one", &[("f.txt", "1")]);
        let tip = repo.create_commit("two", &[("f.txt", "2"), ("g.txt", "g")]);
        repo.checkout_branch(&main);
        repo.create_commit("main moves", &[("m.txt", "m")]);
        repo.squash_onto_head(tip, base);

        let candidates = get_cleanup_candidates(repo.path_str(), Some(0))
            .await
            .unwrap();
        let merged = candidates
            .iter()
            .find(|c| c.name == "feature-squashed" && c.category == "merged")
            .expect("squash-merged branch should be a merged candidate");
        assert_eq!(merged.merge_kind, Some(MergeKind::Squash));
    }

    #[tokio::test]
    async fn test_get_cleanup_candidates_rebase_merged_branch() {
        let repo = TestRepo::with_initial_commit();
        let main = repo.current_branch();
        repo.create_branch("feature-rebased");
        repo.checkout_branch("feature-rebased");
        let c1 = repo.create_commit("r1", &[("r1.txt", "1")]);
        let c2 = repo.create_commit("r2", &[("r2.txt", "2")]);
        repo.checkout_branch(&main);
        repo.create_commit("main moves", &[("m.txt", "m")]);
        repo.cherry_pick_onto_head(c1);
        repo.cherry_pick_onto_head(c2);

        let candidates = get_cleanup_candidates(repo.path_str(), Some(0))
            .await
            .unwrap();
        let merged = candidates
            .iter()
            .find(|c| c.name == "feature-rebased" && c.category == "merged")
            .expect("rebase-merged branch should be a merged candidate");
        assert_eq!(merged.merge_kind, Some(MergeKind::Rebase));
    }

    #[tokio::test]
    async fn test_get_cleanup_candidates_ancestor_merge_kind() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("plain");
        repo.create_commit("main moves", &[("m.txt", "m")]);

        let candidates = get_cleanup_candidates(repo.path_str(), Some(0))
            .await
            .unwrap();
        let merged = candidates
            .iter()
            .find(|c| c.name == "plain" && c.category == "merged")
            .unwrap();
        assert_eq!(merged.merge_kind, Some(MergeKind::Ancestor));
    }

    #[tokio::test]
    async fn test_get_cleanup_candidates_unmerged_has_no_merge_kind() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("old");
        repo.checkout_branch("old");
        repo.create_commit("wip", &[("w.txt", "w")]);
        repo.checkout_branch("main");

        let candidates = get_cleanup_candidates(repo.path_str(), Some(0))
            .await
            .unwrap();
        assert!(candidates
            .iter()
            .filter(|c| c.name == "old")
            .all(|c| c.merge_kind.is_none()));
    }
}
