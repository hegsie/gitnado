//! Squash and fixup commit command handlers

use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};

/// Result of a squash operation
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquashResult {
    pub new_oid: String,
    pub squashed_count: u32,
    pub success: bool,
}

/// Refuse a commit the replay loops below cannot re-apply.
///
/// Both loops replay a commit by diffing it against its FIRST parent, so a
/// merge would be flattened: its topology is lost and the merged-in side is
/// applied twice, because the plain revwalk also yields the side commits and
/// replays them individually. The root of an unrelated merged-in history has
/// no first parent at all and would hard-error mid-replay. `git rebase -i`
/// never picks a merge either — refuse while nothing has been moved yet.
fn ensure_replayable(commit: &git2::Commit, action: &str, position: &str) -> Result<()> {
    if commit.parent_count() > 1 {
        return Err(GitnadoError::OperationFailed(format!(
            "Cannot {action}: commit {} {position} is a merge. \
             Use an interactive rebase instead.",
            commit.id()
        )));
    }
    if commit.parent_count() == 0 {
        return Err(GitnadoError::OperationFailed(format!(
            "Cannot {action}: commit {} {position} has no parent (an unrelated \
             history was merged in). Use an interactive rebase instead.",
            commit.id()
        )));
    }
    Ok(())
}

/// Squash a range of commits into one
///
/// Takes commits between from_oid (exclusive) and to_oid (inclusive) and squashes them
/// into a single commit with the given message.
///
/// # Arguments
/// * `path` - Repository path
/// * `from_oid` - The parent commit (exclusive - commits after this are squashed)
/// * `to_oid` - The newest commit to squash (inclusive)
/// * `message` - The new commit message for the squashed commit
#[command]
pub async fn squash_commits(
    path: String,
    from_oid: String,
    to_oid: String,
    message: String,
) -> Result<SquashResult> {
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

    // Parse the OIDs
    let from = git2::Oid::from_str(&from_oid)
        .map_err(|_| GitnadoError::CommitNotFound(from_oid.clone()))?;
    let to =
        git2::Oid::from_str(&to_oid).map_err(|_| GitnadoError::CommitNotFound(to_oid.clone()))?;

    // Find the commits
    let from_commit = repo
        .find_commit(from)
        .map_err(|_| GitnadoError::CommitNotFound(from_oid.clone()))?;
    let to_commit = repo
        .find_commit(to)
        .map_err(|_| GitnadoError::CommitNotFound(to_oid.clone()))?;

    // Collect commits to squash (from oldest to newest, exclusive of from_commit)
    let mut commits_to_squash = Vec::new();
    let mut revwalk = repo.revwalk()?;
    revwalk.push(to)?;
    revwalk.hide(from)?;
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::REVERSE)?;

    for oid in revwalk {
        let oid = oid?;
        let commit = repo.find_commit(oid)?;
        commits_to_squash.push(commit);
    }

    if commits_to_squash.is_empty() {
        return Err(GitnadoError::OperationFailed(
            "No commits found in the specified range".to_string(),
        ));
    }

    let squashed_count = commits_to_squash.len() as u32;

    // The squashed range must be part of the current branch history: the
    // branch ref is force-moved below, so an unrelated `to` would rewrite
    // the branch to foreign history.
    let head_commit = repo.head()?.peel_to_commit()?;
    if head_commit.id() != to && !repo.graph_descendant_of(head_commit.id(), to)? {
        return Err(GitnadoError::OperationFailed(
            "The commits to squash must be part of the current branch history.".to_string(),
        ));
    }

    // Get the tree from the newest commit (to_commit) - this contains the final state
    let tree = to_commit.tree()?;

    // Create a new commit with the same tree but with from_commit as the parent
    let signature = repo.signature()?;

    // Get the author from the first commit in the range (oldest commit being squashed)
    let author = commits_to_squash
        .first()
        .map(|c| c.author())
        .unwrap_or_else(|| signature.clone());

    let new_oid = repo.commit(
        None, // Don't update any reference yet
        &author,
        &signature,
        &message,
        &tree,
        &[&from_commit],
    )?;

    // Replay every commit after to_commit (to..HEAD) onto the squashed
    // commit, like `git rebase -i` does when a mid-history range is
    // squashed. Without this, moving the branch ref to the squashed commit
    // would silently discard all descendants of to_commit.
    let mut commits_after = Vec::new();
    let mut revwalk = repo.revwalk()?;
    revwalk.push(head_commit.id())?;
    revwalk.hide(to)?;
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::REVERSE)?;
    for oid in revwalk {
        let commit = repo.find_commit(oid?)?;
        ensure_replayable(&commit, "squash", "after the squashed range")?;
        commits_after.push(commit);
    }

    let mut new_head_oid = new_oid;
    for commit in &commits_after {
        let current_base = repo.find_commit(new_head_oid)?;
        let parent_tree = commit.parent(0)?.tree()?;
        let commit_tree = commit.tree()?;
        let base_tree = current_base.tree()?;

        let mut merge_result = repo.merge_trees(&parent_tree, &base_tree, &commit_tree, None)?;
        if merge_result.has_conflicts() {
            // Nothing has been moved yet — the repository is untouched.
            return Err(GitnadoError::OperationFailed(format!(
                "Cannot squash: replaying the later commit {} onto the squashed \
                 commit produced a conflict. Use an interactive rebase instead.",
                commit.id()
            )));
        }
        let new_tree = repo.find_tree(merge_result.write_tree_to(&repo)?)?;
        new_head_oid = repo.commit(
            None,
            &commit.author(),
            &signature,
            commit.message().unwrap_or(""),
            &new_tree,
            &[&current_base],
        )?;
    }

    // Now we need to update HEAD to point to the new commit
    // First check if we're on a branch or in detached HEAD state
    let head = repo.head()?;
    if head.is_branch() {
        // Update the branch reference
        let branch_name = head.shorthand().unwrap_or("HEAD");
        let refname = format!("refs/heads/{}", branch_name);
        repo.reference(
            &refname,
            new_head_oid,
            true,
            &format!("squash: {} commits into one", squashed_count),
        )?;
    } else {
        // Detached HEAD - just update HEAD
        repo.set_head_detached(new_head_oid)?;
    }

    // Checkout the new commit to update working directory
    repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))?;

    // git's rebase sequencer fires post-commit per replayed commit as HEAD
    // advances. This app replays as an ATOMIC batch — nothing is moved until
    // the whole sequence succeeds, so a mid-replay conflict leaves the repo
    // untouched. Advancing HEAD per commit to fire the hook accurately would
    // break that atomicity, and firing N times with HEAD already at the final
    // commit would feed every invocation the same (wrong) SHA. So fire
    // post-commit once, for the final rewritten HEAD.
    crate::commands::hooks::run_hook_noblock(&repo, "post-commit", &[]);

    Ok(SquashResult {
        new_oid: new_head_oid.to_string(),
        squashed_count,
        success: true,
    })
}

/// Fixup the current staged changes into a specific commit
///
/// This is similar to `git commit --fixup` followed by `git rebase --autosquash`.
/// It takes the currently staged changes and amends them into the specified target commit.
///
/// # Arguments
/// * `path` - Repository path
/// * `target_oid` - The commit to fixup (amend changes into)
/// * `amend_message` - If true, also amend the commit message; if false, keep original message
#[command]
pub async fn fixup_commit(
    path: String,
    target_oid: String,
    amend_message: Option<String>,
) -> Result<SquashResult> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Check for existing operations in progress
    if repo.state() != git2::RepositoryState::Clean {
        return Err(GitnadoError::OperationFailed(
            "Another operation is in progress".to_string(),
        ));
    }

    // Refuse on unstaged working-tree changes, like the canonical flow
    // (`git commit --fixup` + `git rebase --autosquash`), which errors with
    // "cannot rebase: You have unstaged changes." The final checkout below
    // would otherwise silently overwrite them. Untracked files are fine.
    let statuses = repo.statuses(None)?;
    let has_unstaged = statuses.iter().any(|s| {
        s.status().intersects(
            git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_TYPECHANGE
                | git2::Status::WT_RENAMED,
        )
    });
    if has_unstaged {
        return Err(GitnadoError::OperationFailed(
            "Cannot fixup: you have unstaged changes. Commit or stash them first.".to_string(),
        ));
    }

    // Check if there are staged changes
    let mut index = repo.index()?;
    let head_tree = repo.head()?.peel_to_tree()?;

    // Check for staged changes by comparing index to HEAD
    let diff = repo.diff_tree_to_index(Some(&head_tree), Some(&index), None)?;
    if diff.deltas().len() == 0 {
        return Err(GitnadoError::OperationFailed(
            "No staged changes to fixup".to_string(),
        ));
    }

    // Parse the target OID
    let target = git2::Oid::from_str(&target_oid)
        .map_err(|_| GitnadoError::CommitNotFound(target_oid.clone()))?;

    let target_commit = repo
        .find_commit(target)
        .map_err(|_| GitnadoError::CommitNotFound(target_oid.clone()))?;

    // Get the current HEAD
    let head_commit = repo.head()?.peel_to_commit()?;

    // The target must be HEAD itself or an ancestor of it. libgit2 does not
    // consider a commit a descendant of itself, so the graph check alone would
    // reject the most common target of all — the tip commit, i.e. `git commit
    // --amend`, for which the replay below is simply a no-op.
    if head_commit.id() != target_commit.id()
        && !repo.graph_descendant_of(head_commit.id(), target_commit.id())?
    {
        return Err(GitnadoError::OperationFailed(
            "Target commit is not an ancestor of HEAD".to_string(),
        ));
    }

    // Collect all commits from target (exclusive) to HEAD (inclusive)
    let mut commits_after_target = Vec::new();
    let mut revwalk = repo.revwalk()?;
    revwalk.push(head_commit.id())?;
    revwalk.hide(target_commit.id())?;
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::REVERSE)?;

    for oid in revwalk {
        let oid = oid?;
        let commit = repo.find_commit(oid)?;
        ensure_replayable(&commit, "fixup", "after the target commit")?;
        commits_after_target.push(commit);
    }

    // Create the new tree by applying staged changes to target commit's tree
    // First, we need to merge the current index changes with the target tree
    let target_tree = target_commit.tree()?;

    // Write the current index as a tree
    let staged_tree_oid = index.write_tree()?;
    let staged_tree = repo.find_tree(staged_tree_oid)?;

    // Apply the staged changes to the target tree with a three-way merge:
    // HEAD is the base, so exactly `staged_tree - head_tree` — what the user
    // staged — is replayed onto the target tree. A treebuilder cannot be used
    // here: it operates on a single tree level and rejects entry names
    // containing '/', so any staged file inside a subdirectory would fail.
    let mut merge_result = repo.merge_trees(&head_tree, &target_tree, &staged_tree, None)?;
    if merge_result.has_conflicts() {
        // Nothing has been moved yet — the repository is untouched.
        return Err(GitnadoError::OperationFailed(format!(
            "Cannot fixup: the staged changes conflict with commit {}. \
             Use an interactive rebase instead.",
            target_commit.id()
        )));
    }
    let new_target_tree = repo.find_tree(merge_result.write_tree_to(&repo)?)?;

    // Create the new target commit with the merged tree
    let signature = repo.signature()?;
    let commit_message =
        amend_message.unwrap_or_else(|| target_commit.message().unwrap_or("").to_string());

    // Keep every parent of the target commit. The target may now be HEAD, so it
    // may be a merge commit, and rewriting it must not silently flatten the
    // merge — `git commit --amend` keeps both parents. A root commit yields an
    // empty parent list, exactly as before.
    let target_parents: Vec<git2::Commit> = target_commit.parents().collect();
    let parent_refs: Vec<&git2::Commit> = target_parents.iter().collect();

    let new_target_oid = repo.commit(
        None,
        &target_commit.author(),
        &signature,
        &commit_message,
        &new_target_tree,
        &parent_refs,
    )?;

    // Now replay all commits after target onto the new target
    let mut current_base_oid = new_target_oid;

    for commit in &commits_after_target {
        let current_base = repo.find_commit(current_base_oid)?;

        // Cherry-pick this commit onto the new base
        let new_tree = {
            // Get the changes this commit introduced
            let commit_parent = commit.parent(0)?;
            let parent_tree = commit_parent.tree()?;
            let commit_tree = commit.tree()?;

            // Merge the commit's changes onto the new base
            let base_tree = current_base.tree()?;
            let mut merge_result =
                repo.merge_trees(&parent_tree, &base_tree, &commit_tree, None)?;

            if merge_result.has_conflicts() {
                // Write the conflicted index
                merge_result.write_tree_to(&repo)?;
                return Err(GitnadoError::OperationFailed(format!(
                    "Conflict while replaying commit {}. Manual resolution required.",
                    commit.id()
                )));
            }

            let new_tree_oid = merge_result.write_tree_to(&repo)?;
            repo.find_tree(new_tree_oid)?
        };

        // Create the replayed commit
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
            "fixup: amend changes into earlier commit",
        )?;
    } else {
        repo.set_head_detached(current_base_oid)?;
    }

    // Reset the index to remove staged changes (they're now in the fixup)
    index.read_tree(&repo.find_commit(current_base_oid)?.tree()?)?;
    index.write()?;

    // Checkout the new commit to update working directory
    repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))?;

    Ok(SquashResult {
        new_oid: current_base_oid.to_string(),
        squashed_count: 1,
        success: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    /// Record a real merge of `other_oid` into HEAD (two parents, merged tree)
    /// and leave the working tree matching it, so the pre-flight cleanliness
    /// checks see an untouched repository.
    fn commit_merge(repo: &TestRepo, message: &str, other_oid: git2::Oid) -> git2::Oid {
        let git = repo.repo();
        let head = git.head().unwrap().peel_to_commit().unwrap();
        let other = git.find_commit(other_oid).unwrap();
        let mut merged = git.merge_commits(&head, &other, None).unwrap();
        assert!(!merged.has_conflicts());
        let tree_oid = merged.write_tree_to(&git).unwrap();
        let tree = git.find_tree(tree_oid).unwrap();
        let sig = git.signature().unwrap();
        let oid = git
            .commit(Some("HEAD"), &sig, &sig, message, &tree, &[&head, &other])
            .unwrap();
        let obj = git.find_object(oid, None).unwrap();
        git.reset(&obj, git2::ResetType::Hard, None).unwrap();
        oid
    }

    /// c0 - c1 - c2 - c3 - M, where M merges a side branch off c2.
    /// Returns (c0, c2, merge_oid).
    fn repo_with_merge_after_range(repo: &TestRepo) -> (git2::Oid, git2::Oid, git2::Oid) {
        let c0 = repo.head_oid();
        let main = repo.current_branch();
        repo.create_commit("Commit 1", &[("file1.txt", "content1")]);
        let c2 = repo.create_commit("Commit 2", &[("file2.txt", "content2")]);
        repo.create_branch("side");
        repo.checkout_branch("side");
        let s1 = repo.create_commit("Side work", &[("side.txt", "side")]);
        repo.checkout_branch(&main);
        repo.create_commit("Commit 3", &[("file3.txt", "content3")]);
        let m = commit_merge(repo, "Merge branch 'side'", s1);
        (c0, c2, m)
    }

    #[tokio::test]
    async fn test_squash_refuses_when_a_merge_follows_the_range() {
        let repo = TestRepo::with_initial_commit();
        let (c0, c2, m) = repo_with_merge_after_range(&repo);
        let head_before = repo.head_oid();

        let result = squash_commits(
            repo.path_str(),
            c0.to_string(),
            c2.to_string(),
            "Squashed".to_string(),
        )
        .await;

        let err = result
            .expect_err("squashing under a merge must be refused")
            .to_string();
        assert!(err.contains("merge"), "unexpected error: {}", err);

        // Nothing moved: the branch still points at the merge, with both parents.
        assert_eq!(repo.head_oid(), head_before);
        let git = repo.repo();
        assert_eq!(git.find_commit(m).unwrap().parent_count(), 2);
        assert_eq!(head_before, m);
    }

    #[tokio::test]
    async fn test_fixup_refuses_when_a_merge_follows_the_target() {
        let repo = TestRepo::with_initial_commit();
        let main = repo.current_branch();
        let target = repo.create_commit("Target commit", &[("target.txt", "original")]);
        repo.create_branch("side");
        repo.checkout_branch("side");
        let s1 = repo.create_commit("Side work", &[("side.txt", "side")]);
        repo.checkout_branch(&main);
        repo.create_commit("After commit", &[("after.txt", "after")]);
        let m = commit_merge(&repo, "Merge branch 'side'", s1);

        // Stage the fix that would be folded into the target commit.
        repo.create_file("target.txt", "modified");
        repo.stage_file("target.txt");
        let head_before = repo.head_oid();

        let result = fixup_commit(repo.path_str(), target.to_string(), None).await;

        let err = result
            .expect_err("fixup under a merge must be refused")
            .to_string();
        assert!(err.contains("merge"), "unexpected error: {}", err);

        // Nothing moved and the merge topology survives.
        assert_eq!(repo.head_oid(), head_before);
        let git = repo.repo();
        assert_eq!(git.find_commit(m).unwrap().parent_count(), 2);

        // The user's staged work is still staged, and still on disk.
        let head_tree = git.head().unwrap().peel_to_tree().unwrap();
        let index = git.index().unwrap();
        let diff = git
            .diff_tree_to_index(Some(&head_tree), Some(&index), None)
            .unwrap();
        assert_eq!(diff.deltas().len(), 1);
        assert_eq!(
            std::fs::read_to_string(repo.path.join("target.txt")).unwrap(),
            "modified"
        );
    }

    #[tokio::test]
    async fn test_fixup_into_a_mid_history_merge_keeps_both_parents() {
        // The guard above refuses a merge that FOLLOWS the target, because the
        // replay loop would flatten it. The target itself is a different case:
        // it is rebuilt in place from all of its parents, so a merge that is
        // the target survives with its topology, even when later commits are
        // replayed on top of it.
        let repo = TestRepo::with_initial_commit();
        let default_branch = repo.current_branch();
        repo.create_commit("Base", &[("b.txt", "base")]);

        repo.create_branch("side");
        repo.checkout_branch("side");
        let side = repo.create_commit("Side work", &[("side.txt", "s")]);
        repo.checkout_branch(&default_branch);

        let merge = commit_merge(&repo, "Merge side", side);
        let parents_before: Vec<git2::Oid> = {
            let git = repo.repo();
            let ids = git.find_commit(merge).unwrap().parent_ids().collect();
            ids
        };
        assert_eq!(parents_before.len(), 2);

        // A plain commit on top, so the merge is mid-history and the replay
        // loop actually runs.
        repo.create_commit("After commit", &[("after.txt", "after")]);

        repo.create_file("b.txt", "fixed");
        repo.stage_file("b.txt");

        let result = fixup_commit(repo.path_str(), merge.to_string(), None).await;
        assert!(
            result.is_ok(),
            "fixup into a mid-history merge must succeed: {:?}",
            result.err()
        );

        let git = repo.repo();
        let new_head = git.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(new_head.summary().unwrap(), Some("After commit"));

        // The replayed tip still sits on the rewritten merge, and that merge
        // still has both parents, in order.
        let rewritten_merge = new_head.parent(0).unwrap();
        assert_eq!(rewritten_merge.summary().unwrap(), Some("Merge side"));
        assert_eq!(
            rewritten_merge.parent_count(),
            2,
            "amending a mid-history merge must keep the merge"
        );
        assert_eq!(
            rewritten_merge.parent_ids().collect::<Vec<_>>(),
            parents_before,
            "both parents are preserved, in order"
        );

        // The fix landed in the merge, and nothing was lost from either side.
        assert!(rewritten_merge.tree().unwrap().get_name("b.txt").is_some());
        assert_eq!(
            std::fs::read_to_string(repo.path.join("b.txt")).unwrap(),
            "fixed"
        );
        assert!(repo.path.join("side.txt").exists(), "side branch content");
        assert!(repo.path.join("after.txt").exists(), "replayed commit");
    }

    #[tokio::test]
    async fn test_squash_refuses_when_an_unrelated_root_follows_the_range() {
        let repo = TestRepo::with_initial_commit();
        let c0 = repo.head_oid();
        repo.create_commit("Commit 1", &[("file1.txt", "content1")]);
        let c2 = repo.create_commit("Commit 2", &[("file2.txt", "content2")]);

        // An orphan root, merged in like `git merge --allow-unrelated-histories`.
        let root_oid = {
            let git = repo.repo();
            let blob = git.blob(b"unrelated").unwrap();
            let mut builder = git.treebuilder(None).unwrap();
            builder.insert("unrelated.txt", blob, 0o100644).unwrap();
            let tree_oid = builder.write().unwrap();
            let tree = git.find_tree(tree_oid).unwrap();
            let sig = git.signature().unwrap();
            git.commit(None, &sig, &sig, "Unrelated root", &tree, &[])
                .unwrap()
        };
        commit_merge(&repo, "Merge unrelated history", root_oid);
        let head_before = repo.head_oid();

        let result = squash_commits(
            repo.path_str(),
            c0.to_string(),
            c2.to_string(),
            "Squashed".to_string(),
        )
        .await;

        let err = result
            .expect_err("squashing under an unrelated merged-in root must be refused")
            .to_string();
        assert!(err.contains("Cannot squash"), "unexpected error: {}", err);
        assert_eq!(repo.head_oid(), head_before);
    }

    #[tokio::test]
    async fn test_squash_range_containing_a_merge_still_squashes() {
        // The guard applies to the commits REPLAYED after the range, not to the
        // range itself: squashing up to and including a merge still collapses to
        // that merge's tree.
        let repo = TestRepo::with_initial_commit();
        let (c0, _c2, m) = repo_with_merge_after_range(&repo);

        let result = squash_commits(
            repo.path_str(),
            c0.to_string(),
            m.to_string(),
            "Squashed".to_string(),
        )
        .await;

        assert!(result.is_ok(), "unexpected error: {:?}", result.err());
        let git = repo.repo();
        let new_head = git.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(new_head.summary().unwrap(), Some("Squashed"));
        assert_eq!(new_head.parent_count(), 1);
        assert_eq!(new_head.parent(0).unwrap().id(), c0);
        for f in ["file1.txt", "file2.txt", "file3.txt", "side.txt"] {
            assert!(repo.path.join(f).exists(), "missing {}", f);
        }
    }

    #[tokio::test]
    async fn test_squash_commits_basic() {
        let repo = TestRepo::with_initial_commit();

        // Create multiple commits to squash
        let _commit1 = repo.create_commit("Commit 1", &[("file1.txt", "content1")]);
        let _commit2 = repo.create_commit("Commit 2", &[("file2.txt", "content2")]);
        let commit3 = repo.create_commit("Commit 3", &[("file3.txt", "content3")]);

        // Get the initial commit (parent of commit1)
        let git_repo = repo.repo();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        let initial_oid = head
            .parent(0)
            .unwrap()
            .parent(0)
            .unwrap()
            .parent(0)
            .unwrap()
            .id();

        // Squash all three commits into one
        let result = squash_commits(
            repo.path_str(),
            initial_oid.to_string(),
            commit3.to_string(),
            "Squashed commit".to_string(),
        )
        .await;

        assert!(result.is_ok());
        let squash_result = result.unwrap();
        assert!(squash_result.success);
        assert_eq!(squash_result.squashed_count, 3);

        // Verify all files exist
        assert!(repo.path.join("file1.txt").exists());
        assert!(repo.path.join("file2.txt").exists());
        assert!(repo.path.join("file3.txt").exists());

        // Verify we have the new commit
        let binding = repo.repo();
        let new_head = binding.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(new_head.summary().unwrap(), Some("Squashed commit"));

        // Verify the parent is the initial commit
        assert_eq!(new_head.parent(0).unwrap().id(), initial_oid);
    }

    #[tokio::test]
    async fn test_squash_commits_two_commits() {
        let repo = TestRepo::with_initial_commit();
        let initial_oid = repo.head_oid();

        // Create two commits
        let _commit1 = repo.create_commit("First", &[("a.txt", "a")]);
        let commit2 = repo.create_commit("Second", &[("b.txt", "b")]);

        let result = squash_commits(
            repo.path_str(),
            initial_oid.to_string(),
            commit2.to_string(),
            "Combined commit".to_string(),
        )
        .await;

        assert!(result.is_ok());
        let squash_result = result.unwrap();
        assert_eq!(squash_result.squashed_count, 2);

        // Verify files exist
        assert!(repo.path.join("a.txt").exists());
        assert!(repo.path.join("b.txt").exists());
    }

    #[tokio::test]
    async fn test_squash_commits_invalid_from_oid() {
        let repo = TestRepo::with_initial_commit();
        let head = repo.head_oid();

        let result = squash_commits(
            repo.path_str(),
            "invalid-oid".to_string(),
            head.to_string(),
            "Test".to_string(),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_squash_commits_invalid_to_oid() {
        let repo = TestRepo::with_initial_commit();
        let head = repo.head_oid();

        let result = squash_commits(
            repo.path_str(),
            head.to_string(),
            "invalid-oid".to_string(),
            "Test".to_string(),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_squash_commits_empty_range() {
        let repo = TestRepo::with_initial_commit();
        let head = repo.head_oid();

        // Try to squash with the same from and to (empty range)
        let result = squash_commits(
            repo.path_str(),
            head.to_string(),
            head.to_string(),
            "Test".to_string(),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_squash_commits_preserves_content() {
        let repo = TestRepo::with_initial_commit();
        let initial_oid = repo.head_oid();

        // Create commits that modify the same file
        repo.create_commit("Add file", &[("test.txt", "line1\n")]);
        repo.create_commit("Modify file", &[("test.txt", "line1\nline2\n")]);
        let final_commit =
            repo.create_commit("Final modify", &[("test.txt", "line1\nline2\nline3\n")]);

        let result = squash_commits(
            repo.path_str(),
            initial_oid.to_string(),
            final_commit.to_string(),
            "All changes".to_string(),
        )
        .await;

        assert!(result.is_ok());

        // Verify final content is preserved
        let content = std::fs::read_to_string(repo.path.join("test.txt")).unwrap();
        assert_eq!(content, "line1\nline2\nline3\n");
    }

    #[tokio::test]
    async fn test_squash_commits_mid_history_preserves_descendants() {
        // `git rebase -i` squashing C1+C2 in C0-C1-C2-C3 yields
        // C0-(C1+C2)-C3': the later commit C3 and its file are preserved,
        // not silently discarded.
        let repo = TestRepo::with_initial_commit();
        let c0 = repo.head_oid();
        let _c1 = repo.create_commit("Commit 1", &[("f1.txt", "1")]);
        let c2 = repo.create_commit("Commit 2", &[("f2.txt", "2")]);
        let _c3 = repo.create_commit("Commit 3", &[("f3.txt", "3")]);

        let result = squash_commits(
            repo.path_str(),
            c0.to_string(),
            c2.to_string(),
            "Squashed".to_string(),
        )
        .await;
        assert!(
            result.is_ok(),
            "mid-history squash failed: {:?}",
            result.err()
        );
        let squash_result = result.unwrap();
        assert_eq!(squash_result.squashed_count, 2);

        let git_repo = repo.repo();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        // HEAD is the replayed C3, on top of the squashed commit, on top of C0.
        assert_eq!(head.summary().unwrap(), Some("Commit 3"));
        assert_eq!(head.id().to_string(), squash_result.new_oid);
        let squashed = head.parent(0).unwrap();
        assert_eq!(squashed.summary().unwrap(), Some("Squashed"));
        assert_eq!(squashed.parent(0).unwrap().id(), c0);

        // All files, including C3's, survive in the working tree.
        assert!(repo.path.join("f1.txt").exists());
        assert!(repo.path.join("f2.txt").exists());
        assert!(repo.path.join("f3.txt").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_squash_runs_post_commit_hook() {
        // The squash replays history as an atomic batch (nothing is moved until
        // the whole sequence succeeds), so post-commit fires once for the final
        // rewritten HEAD — firing per replayed commit would either break that
        // atomicity or feed every invocation the same, already-final SHA.
        let repo = TestRepo::with_initial_commit();
        let counter = repo.path.join("pc-count");
        repo.install_hook(
            "post-commit",
            &format!("#!/bin/sh\necho x >> \"{}\"\n", counter.display()),
        );

        let c0 = repo.head_oid();
        let _c1 = repo.create_commit("Commit 1", &[("f1.txt", "1")]);
        let c2 = repo.create_commit("Commit 2", &[("f2.txt", "2")]);
        let _c3 = repo.create_commit("Commit 3", &[("f3.txt", "3")]);

        squash_commits(
            repo.path_str(),
            c0.to_string(),
            c2.to_string(),
            "Squashed".to_string(),
        )
        .await
        .unwrap();

        let count = std::fs::read_to_string(&counter)
            .unwrap_or_default()
            .lines()
            .count();
        assert_eq!(count, 1, "post-commit fires once for the rewritten HEAD");
    }

    #[tokio::test]
    async fn test_fixup_commit_refuses_unstaged_changes() {
        // The canonical flow (`git commit --fixup` + `git rebase -i
        // --autosquash`) refuses with "cannot rebase: You have unstaged
        // changes." — the unstaged edit must survive untouched.
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add b", &[("b.txt", "base\n")]);
        let target_oid = repo.create_commit("Target commit", &[("target.txt", "original")]);
        repo.create_commit("After commit", &[("after.txt", "after content")]);

        // Staged fix for the target commit.
        repo.create_file("target.txt", "modified");
        repo.stage_file("target.txt");
        // Unstaged precious edit to an unrelated file.
        repo.create_file("b.txt", "base\nprecious unstaged\n");

        let head_before = repo.head_oid();
        let result = fixup_commit(repo.path_str(), target_oid.to_string(), None).await;
        assert!(
            result.is_err(),
            "fixup with unstaged changes must refuse like git rebase"
        );
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("unstaged"), "unexpected message: {msg}");

        // Nothing was rewritten and the unstaged edit is preserved.
        assert_eq!(repo.head_oid(), head_before);
        let content = std::fs::read_to_string(repo.path.join("b.txt")).unwrap();
        assert_eq!(content, "base\nprecious unstaged\n");
    }

    #[tokio::test]
    async fn test_fixup_commit_no_staged_changes() {
        let repo = TestRepo::with_initial_commit();
        let head = repo.head_oid();

        let result = fixup_commit(repo.path_str(), head.to_string(), None).await;

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("No staged changes"));
    }

    #[tokio::test]
    async fn test_fixup_commit_basic() {
        let repo = TestRepo::with_initial_commit();

        // Create a commit that we want to fixup
        let target_oid = repo.create_commit("Target commit", &[("target.txt", "original")]);

        // Create another commit after it
        repo.create_commit("After commit", &[("after.txt", "after content")]);

        // Stage some changes to fixup into the target commit
        repo.create_file("target.txt", "modified");
        repo.stage_file("target.txt");

        let result = fixup_commit(repo.path_str(), target_oid.to_string(), None).await;

        assert!(result.is_ok());
        let fixup_result = result.unwrap();
        assert!(fixup_result.success);

        // Verify the target file has the new content
        let content = std::fs::read_to_string(repo.path.join("target.txt")).unwrap();
        assert_eq!(content, "modified");

        // Verify both files exist
        assert!(repo.path.join("target.txt").exists());
        assert!(repo.path.join("after.txt").exists());
    }

    #[tokio::test]
    async fn test_fixup_commit_with_message() {
        let repo = TestRepo::with_initial_commit();

        // Create a commit that we want to fixup
        let target_oid = repo.create_commit("Original message", &[("file.txt", "content")]);

        // Create another commit after it (fixup requires target to be an ancestor of HEAD)
        repo.create_commit("After commit", &[("after.txt", "after content")]);

        // Stage some changes
        repo.create_file("file.txt", "new content");
        repo.stage_file("file.txt");

        let result = fixup_commit(
            repo.path_str(),
            target_oid.to_string(),
            Some("Updated message".to_string()),
        )
        .await;

        assert!(result.is_ok());

        // Verify the content was updated
        let content = std::fs::read_to_string(repo.path.join("file.txt")).unwrap();
        assert_eq!(content, "new content");

        // Verify both files exist
        assert!(repo.path.join("file.txt").exists());
        assert!(repo.path.join("after.txt").exists());
    }

    #[tokio::test]
    async fn test_fixup_commit_into_head_amends_tip() {
        // Fixing staged changes into the tip commit is `git commit --amend`,
        // the most common target of all. libgit2 does not call a commit a
        // descendant of itself, so the ancestor guard used to reject it.
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Base", &[("b.txt", "base")]);
        let target = repo.create_commit("Tip commit", &[("tip.txt", "original")]);

        let parent_before = {
            let git = repo.repo();
            let id = git.find_commit(target).unwrap().parent(0).unwrap().id();
            id
        };

        repo.create_file("tip.txt", "fixed");
        repo.stage_file("tip.txt");

        let result = fixup_commit(repo.path_str(), target.to_string(), None).await;
        assert!(
            result.is_ok(),
            "fixup into HEAD must amend the tip: {:?}",
            result.err()
        );
        let fixup_result = result.unwrap();

        let git = repo.repo();
        let new_head = git.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(new_head.summary().unwrap(), Some("Tip commit"));
        assert_eq!(
            new_head.parent(0).unwrap().id(),
            parent_before,
            "the tip was amended, not stacked on top of"
        );
        assert_eq!(new_head.id().to_string(), fixup_result.new_oid);

        let content = std::fs::read_to_string(repo.path.join("tip.txt")).unwrap();
        assert_eq!(content, "fixed");

        let mut revwalk = git.revwalk().unwrap();
        revwalk.push_head().unwrap();
        assert_eq!(revwalk.count(), 3, "no commit was appended or lost");
    }

    #[tokio::test]
    async fn test_fixup_commit_into_root_head() {
        // The tip may also be the root commit: no parents at all.
        let repo = TestRepo::with_initial_commit();
        repo.create_file("extra.txt", "x");
        repo.stage_file("extra.txt");

        let head = repo.head_oid();
        let result = fixup_commit(repo.path_str(), head.to_string(), None).await;
        assert!(
            result.is_ok(),
            "fixup into a root HEAD must amend it: {:?}",
            result.err()
        );

        let git = repo.repo();
        let new_head = git.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(
            new_head.parent_count(),
            0,
            "root commit stays a root commit"
        );
        assert_eq!(new_head.summary().unwrap(), Some("Initial commit"));
        let tree = new_head.tree().unwrap();
        assert!(tree.get_name("README.md").is_some());
        assert!(tree.get_name("extra.txt").is_some());
    }

    #[tokio::test]
    async fn test_fixup_commit_into_merge_head_keeps_both_parents() {
        // Amending a merge tip must keep the merge, exactly as `git commit
        // --amend` does — rebuilding it from parent 0 alone would silently
        // drop the side branch from history.
        let repo = TestRepo::with_initial_commit();
        let default_branch = repo.current_branch();
        repo.create_commit("Base", &[("b.txt", "base")]);

        repo.create_branch("side");
        repo.checkout_branch("side");
        let side = repo.create_commit("Side work", &[("side.txt", "s")]);
        repo.checkout_branch(&default_branch);

        let merge = commit_merge(&repo, "Merge side", side);
        let parents_before: Vec<git2::Oid> = {
            let git = repo.repo();
            let ids = git.find_commit(merge).unwrap().parent_ids().collect();
            ids
        };
        assert_eq!(parents_before.len(), 2);

        repo.create_file("b.txt", "fixed");
        repo.stage_file("b.txt");

        let result = fixup_commit(repo.path_str(), merge.to_string(), None).await;
        assert!(
            result.is_ok(),
            "fixup into a merge tip must succeed: {:?}",
            result.err()
        );

        let git = repo.repo();
        let new_head = git.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(
            new_head.parent_count(),
            2,
            "amending a merge tip must keep the merge"
        );
        assert_eq!(
            new_head.parent_ids().collect::<Vec<_>>(),
            parents_before,
            "both parents are preserved, in order"
        );
        assert_eq!(new_head.summary().unwrap(), Some("Merge side"));

        let content = std::fs::read_to_string(repo.path.join("b.txt")).unwrap();
        assert_eq!(content, "fixed");
    }

    #[tokio::test]
    async fn test_fixup_commit_rejects_unrelated_commit() {
        // The guard is narrowed for HEAD, not removed: a commit on another
        // branch is still not a legal fixup target.
        let repo = TestRepo::with_initial_commit();
        let default_branch = repo.current_branch();

        repo.create_branch("side");
        repo.checkout_branch("side");
        let side_only = repo.create_commit("Side only", &[("side.txt", "s")]);

        repo.checkout_branch(&default_branch);
        repo.create_commit("Main work", &[("m.txt", "m")]);

        repo.create_file("m.txt", "staged");
        repo.stage_file("m.txt");

        let head_before = repo.head_oid();
        let result = fixup_commit(repo.path_str(), side_only.to_string(), None).await;

        assert!(result.is_err(), "an unrelated commit is not a fixup target");
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("not an ancestor"), "unexpected message: {msg}");
        assert_eq!(repo.head_oid(), head_before, "nothing was rewritten");
    }

    #[tokio::test]
    async fn test_fixup_commit_nested_path() {
        // Every real project stages files inside directories, and a treebuilder
        // rejects entry names containing '/', so this is the normal case.
        let repo = TestRepo::with_initial_commit();
        let target_oid = repo.create_commit("Target commit", &[("src/dir/file.txt", "original\n")]);
        repo.create_commit("After commit", &[("after.txt", "after\n")]);

        repo.create_file("src/dir/file.txt", "modified\n");
        repo.stage_file("src/dir/file.txt");

        let result = fixup_commit(repo.path_str(), target_oid.to_string(), None).await;
        assert!(
            result.is_ok(),
            "fixup of a file in a subdirectory failed: {:?}",
            result.err()
        );

        // The change landed in the target commit, not on top of HEAD.
        let git_repo = repo.repo();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.summary().unwrap(), Some("After commit"));
        let rewritten_target = head.parent(0).unwrap();
        assert_eq!(rewritten_target.summary().unwrap(), Some("Target commit"));
        let entry = rewritten_target
            .tree()
            .unwrap()
            .get_path(Path::new("src/dir/file.txt"))
            .unwrap();
        assert_eq!(
            git_repo.find_blob(entry.id()).unwrap().content(),
            b"modified\n"
        );

        // Working tree and the later commit survive.
        let content =
            std::fs::read_to_string(repo.path.join("src").join("dir").join("file.txt")).unwrap();
        assert_eq!(content, "modified\n");
        assert!(repo.path.join("after.txt").exists());
    }

    #[tokio::test]
    async fn test_fixup_commit_nested_deletion() {
        let repo = TestRepo::with_initial_commit();
        let target_oid = repo.create_commit(
            "Target commit",
            &[("src/keep.txt", "keep\n"), ("src/gone.txt", "gone\n")],
        );
        repo.create_commit("After commit", &[("after.txt", "after\n")]);

        // Stage the deletion of a file in a subdirectory (staged, so the
        // unstaged-changes guard does not fire).
        std::fs::remove_file(repo.path.join("src").join("gone.txt")).unwrap();
        {
            let git_repo = repo.repo();
            let mut index = git_repo.index().unwrap();
            index.remove_path(Path::new("src/gone.txt")).unwrap();
            index.write().unwrap();
        }

        let result = fixup_commit(repo.path_str(), target_oid.to_string(), None).await;
        assert!(
            result.is_ok(),
            "fixup of a deletion in a subdirectory failed: {:?}",
            result.err()
        );

        let git_repo = repo.repo();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        let tree = head.parent(0).unwrap().tree().unwrap();
        assert!(
            tree.get_path(Path::new("src/gone.txt")).is_err(),
            "the deletion belongs to the target commit"
        );
        assert!(tree.get_path(Path::new("src/keep.txt")).is_ok());
        assert!(!repo.path.join("src").join("gone.txt").exists());
        assert!(repo.path.join("after.txt").exists());
    }

    #[tokio::test]
    async fn test_fixup_commit_refuses_conflicting_staged_change() {
        // A later commit rewrote the same line, so the staged fix cannot be
        // replayed onto the target — refuse and leave the repository untouched.
        let repo = TestRepo::with_initial_commit();
        let target_oid = repo.create_commit("Target commit", &[("src/f.txt", "v1\n")]);
        repo.create_commit("After commit", &[("src/f.txt", "v2\n")]);

        repo.create_file("src/f.txt", "v3\n");
        repo.stage_file("src/f.txt");

        let head_before = repo.head_oid();
        let result = fixup_commit(repo.path_str(), target_oid.to_string(), None).await;
        assert!(result.is_err(), "a conflicting fixup must be refused");
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("Cannot fixup") && msg.contains("conflict"),
            "unexpected message: {msg}"
        );

        // Nothing was rewritten and the staged change is still staged.
        assert_eq!(repo.head_oid(), head_before);
        let content = std::fs::read_to_string(repo.path.join("src").join("f.txt")).unwrap();
        assert_eq!(content, "v3\n");
        let git_repo = repo.repo();
        let index = git_repo.index().unwrap();
        let head_tree = git_repo.head().unwrap().peel_to_tree().unwrap();
        let diff = git_repo
            .diff_tree_to_index(Some(&head_tree), Some(&index), None)
            .unwrap();
        assert_eq!(
            diff.deltas().len(),
            1,
            "the staged change must survive the refusal"
        );
    }

    #[tokio::test]
    async fn test_fixup_commit_invalid_target() {
        let repo = TestRepo::with_initial_commit();

        // Stage some changes
        repo.create_file("new.txt", "content");
        repo.stage_file("new.txt");

        let result = fixup_commit(repo.path_str(), "invalid-oid".to_string(), None).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_squash_result_serialization() {
        let result = SquashResult {
            new_oid: "abc123".to_string(),
            squashed_count: 3,
            success: true,
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"newOid\":\"abc123\""));
        assert!(json.contains("\"squashedCount\":3"));
        assert!(json.contains("\"success\":true"));
    }
}
