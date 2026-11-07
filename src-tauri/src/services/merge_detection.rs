//! Merge detection beyond ancestry.
//!
//! `git branch --merged` only recognises branches whose tip is an ancestor of
//! the target. Hosted PR workflows routinely land work with "Squash and merge"
//! or "Rebase and merge", which rewrite the commits, so the original branch is
//! never an ancestor of the target even though every change on it is already
//! there. This module detects those cases so branch cleanup (and later, stack
//! pruning) can treat them as merged.
//!
//! Detection order, cheapest first:
//! 1. **Ancestor** — the branch tip equals or is reachable from the target.
//! 2. **Rebase** — every non-merge commit on the branch has a commit with the
//!    same patch-id among the target's commits since the merge base.
//! 3. **Squash** — re-applying the branch's combined change (merge base →
//!    branch tip) on top of the target is a no-op, i.e. the target tree
//!    already contains it.
//!
//! Every check is conservative: anything ambiguous reports "not merged", so a
//! branch is only ever labelled merged when deleting it loses no content.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use git2::{Oid, Repository, Sort};
use serde::Serialize;

/// Upper bound on branch-only commits examined for patch-id equivalence.
const MAX_BRANCH_COMMITS: usize = 500;
/// Upper bound on target-only commits examined for patch-id equivalence.
const MAX_TARGET_COMMITS: usize = 5000;

/// How a branch's work reached the target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeKind {
    /// The branch tip is the target or one of its ancestors.
    Ancestor,
    /// Each branch commit was replayed onto the target (same patch-ids).
    Rebase,
    /// The branch's combined change already exists in the target tree.
    Squash,
}

/// Stateful merge detector for comparing many branches against a single target.
///
/// Caches per-commit tree-delta signatures and patch-ids across branches so
/// scanning dozens of branches in `get_cleanup_candidates` never recomputes
/// `diff_tree_to_tree` or `patchid` on the same target history more than once,
/// and only runs full blob `patchid` (`xdiff`) on target commits whose changed
/// file path/status signature actually matches a branch commit.
pub struct MergeDetector<'repo> {
    repo: &'repo Repository,
    target: Oid,
    target_tree: Option<git2::Tree<'repo>>,
    /// Cached tree-only delta signature per commit (`None` for root/merge commits).
    delta_sigs: HashMap<Oid, Option<u64>>,
    /// Cached blob-level patch-id per commit (`None` for root/merge commits).
    patch_ids: HashMap<Oid, Option<Oid>>,
}

impl<'repo> MergeDetector<'repo> {
    /// Create a detector comparing branches against `target`.
    pub fn new(repo: &'repo Repository, target: Oid) -> Self {
        let target_tree = repo.find_commit(target).ok().and_then(|c| c.tree().ok());
        Self {
            repo,
            target,
            target_tree,
            delta_sigs: HashMap::new(),
            patch_ids: HashMap::new(),
        }
    }

    /// Determine whether `branch` has been merged into `self.target`, and how.
    pub fn detect(&mut self, branch: Oid) -> Result<Option<MergeKind>, git2::Error> {
        if branch == self.target || self.repo.graph_descendant_of(self.target, branch)? {
            return Ok(Some(MergeKind::Ancestor));
        }

        let merge_base = match self.repo.merge_base(branch, self.target) {
            Ok(oid) => oid,
            // Unrelated histories: nothing to compare against.
            Err(e) if e.code() == git2::ErrorCode::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };

        if self.is_rebase_merged(branch)? {
            return Ok(Some(MergeKind::Rebase));
        }

        if self.is_squash_merged(branch, merge_base)? {
            return Ok(Some(MergeKind::Squash));
        }

        Ok(None)
    }

    /// Cheap tree-only signature of the file paths and delta statuses changed
    /// by a single-parent commit, without decompressing blobs or running xdiff.
    ///
    /// Two single-parent commits can only produce the same `patchid` if their
    /// tree diffs have the exact same sequence of `(status, old_path, new_path)`
    /// deltas. Pre-filtering on this signature skips >99% of blob `patchid` calls.
    fn commit_delta_sig(&mut self, oid: Oid) -> Result<Option<u64>, git2::Error> {
        if let Some(&cached) = self.delta_sigs.get(&oid) {
            return Ok(cached);
        }
        let commit = self.repo.find_commit(oid)?;
        if commit.parent_count() != 1 {
            self.delta_sigs.insert(oid, None);
            return Ok(None);
        }
        let parent_tree = commit.parent(0)?.tree()?;
        let tree = commit.tree()?;
        if parent_tree.id() == tree.id() {
            // Empty commit: signature 0.
            self.delta_sigs.insert(oid, Some(0));
            return Ok(Some(0));
        }
        let diff = self
            .repo
            .diff_tree_to_tree(Some(&parent_tree), Some(&tree), None)?;
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        let deltas = diff.deltas();
        deltas.len().hash(&mut hasher);
        for delta in deltas {
            (delta.status() as u32).hash(&mut hasher);
            delta.old_file().path().hash(&mut hasher);
            delta.new_file().path().hash(&mut hasher);
        }
        let sig = Some(hasher.finish());
        self.delta_sigs.insert(oid, sig);
        Ok(sig)
    }

    /// Patch-id of a single-parent commit's change, cached by commit OID.
    fn commit_patch_id(&mut self, oid: Oid) -> Result<Option<Oid>, git2::Error> {
        if let Some(&cached) = self.patch_ids.get(&oid) {
            return Ok(cached);
        }
        let commit = self.repo.find_commit(oid)?;
        if commit.parent_count() != 1 {
            self.patch_ids.insert(oid, None);
            return Ok(None);
        }
        let parent_tree = commit.parent(0)?.tree()?;
        let tree = commit.tree()?;
        let diff = self
            .repo
            .diff_tree_to_tree(Some(&parent_tree), Some(&tree), None)?;
        let patch_id = Some(diff.patchid(None)?);
        self.patch_ids.insert(oid, patch_id);
        Ok(patch_id)
    }

    fn is_rebase_merged(&mut self, branch: Oid) -> Result<bool, git2::Error> {
        let Some(branch_oids) =
            commit_oids_between(self.repo, branch, self.target, MAX_BRANCH_COMMITS)?
        else {
            return Ok(false);
        };
        if branch_oids.is_empty() {
            return Ok(false);
        }

        // Compute cheap tree-delta signatures for the branch commits first;
        // any merge or root commit disqualifies patch-id matching immediately.
        let mut branch_sigs = Vec::with_capacity(branch_oids.len());
        for &b_oid in &branch_oids {
            match self.commit_delta_sig(b_oid)? {
                Some(sig) => branch_sigs.push((b_oid, sig)),
                None => return Ok(false),
            }
        }

        let Some(target_oids) =
            commit_oids_between(self.repo, self.target, branch, MAX_TARGET_COMMITS)?
        else {
            return Ok(false);
        };
        if target_oids.is_empty() {
            return Ok(false);
        }

        // For each branch commit (newest first), check if any target commit shares
        // its tree-delta signature and then its full patch-id. Short-circuit as
        // soon as any branch commit has no match on target.
        for (b_oid, b_sig) in branch_sigs {
            let mut matched = false;
            let mut b_patch_id: Option<Oid> = None;

            for &t_oid in &target_oids {
                if self.commit_delta_sig(t_oid)? != Some(b_sig) {
                    continue;
                }
                let bp = match b_patch_id {
                    Some(id) => id,
                    None => match self.commit_patch_id(b_oid)? {
                        Some(id) => {
                            b_patch_id = Some(id);
                            id
                        }
                        None => return Ok(false),
                    },
                };
                if self.commit_patch_id(t_oid)? == Some(bp) {
                    matched = true;
                    break;
                }
            }

            if !matched {
                return Ok(false);
            }
        }

        Ok(true)
    }

    fn is_squash_merged(&self, branch: Oid, merge_base: Oid) -> Result<bool, git2::Error> {
        let base_tree = self.repo.find_commit(merge_base)?.tree()?;
        let branch_tree = self.repo.find_commit(branch)?.tree()?;
        let target_tree = match &self.target_tree {
            Some(t) => t.clone(),
            None => self.repo.find_commit(self.target)?.tree()?,
        };

        // A branch whose net change is empty contributes nothing; that is not
        // evidence of a squash merge, and ancestry/rebase already had their say.
        if base_tree.id() == branch_tree.id() {
            return Ok(false);
        }

        // Three-way merge of the branch's change onto the target in memory.
        // Compare the resulting in-memory index against `target_tree` via
        // `diff_tree_to_index` instead of `index.write_tree_to(repo)` so a
        // read-only merge check never writes loose tree objects into `.git/objects`.
        let index = self
            .repo
            .merge_trees(&base_tree, &target_tree, &branch_tree, None)?;
        if index.has_conflicts() {
            return Ok(false);
        }
        let diff = self
            .repo
            .diff_tree_to_index(Some(&target_tree), Some(&index), None)?;
        Ok(diff.deltas().len() == 0)
    }
}

/// Determine whether `branch` has been merged into `target`, and how.
///
/// Returns `Ok(None)` when the branch carries changes the target does not.
pub fn detect_merge_kind(
    repo: &Repository,
    branch: Oid,
    target: Oid,
) -> Result<Option<MergeKind>, git2::Error> {
    MergeDetector::new(repo, target).detect(branch)
}

/// Commit OIDs reachable from `include` but not from `exclude`, newest first.
/// Returns `None` when more than `limit` commits would be produced.
fn commit_oids_between(
    repo: &Repository,
    include: Oid,
    exclude: Oid,
    limit: usize,
) -> Result<Option<Vec<Oid>>, git2::Error> {
    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL)?;
    walk.push(include)?;
    walk.hide(exclude)?;

    let mut oids = Vec::new();
    for oid in walk {
        if oids.len() >= limit {
            return Ok(None);
        }
        oids.push(oid?);
    }
    Ok(Some(oids))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    fn oid_of(repo: &Repository, name: &str) -> Oid {
        repo.revparse_single(name)
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id()
    }

    #[test]
    fn ancestor_branch_is_detected() {
        let t = TestRepo::with_initial_commit();
        t.create_branch("done");
        t.create_commit("main moves", &[("m.txt", "m")]);
        let repo = t.repo();
        let kind = detect_merge_kind(&repo, oid_of(&repo, "done"), t.head_oid()).unwrap();
        assert_eq!(kind, Some(MergeKind::Ancestor));
    }

    #[test]
    fn branch_at_target_is_ancestor() {
        let t = TestRepo::with_initial_commit();
        t.create_branch("same");
        let repo = t.repo();
        let kind = detect_merge_kind(&repo, oid_of(&repo, "same"), t.head_oid()).unwrap();
        assert_eq!(kind, Some(MergeKind::Ancestor));
    }

    #[test]
    fn unmerged_branch_is_not_detected() {
        let t = TestRepo::with_initial_commit();
        let main = t.current_branch();
        t.create_branch("wip");
        t.checkout_branch("wip");
        t.create_commit("wip", &[("wip.txt", "wip")]);
        t.checkout_branch(&main);
        t.create_commit("main moves", &[("m.txt", "m")]);
        let repo = t.repo();
        let kind = detect_merge_kind(&repo, oid_of(&repo, "wip"), t.head_oid()).unwrap();
        assert_eq!(kind, None);
    }

    #[test]
    fn rebase_merged_branch_is_detected() {
        let t = TestRepo::with_initial_commit();
        let main = t.current_branch();
        t.create_branch("feature");
        t.checkout_branch("feature");
        let c1 = t.create_commit("feat 1", &[("a.txt", "a")]);
        let c2 = t.create_commit("feat 2", &[("b.txt", "b")]);
        t.checkout_branch(&main);
        t.create_commit("main moves", &[("m.txt", "m")]);
        let repo = t.repo();
        t.cherry_pick_onto_head(c1);
        t.cherry_pick_onto_head(c2);

        let target = repo.head().unwrap().target().unwrap();
        let kind = detect_merge_kind(&repo, oid_of(&repo, "feature"), target).unwrap();
        assert_eq!(kind, Some(MergeKind::Rebase));
    }

    #[test]
    fn partially_rebased_branch_is_not_merged() {
        let t = TestRepo::with_initial_commit();
        let main = t.current_branch();
        t.create_branch("feature");
        t.checkout_branch("feature");
        let c1 = t.create_commit("feat 1", &[("a.txt", "a")]);
        t.create_commit("feat 2", &[("b.txt", "b")]);
        t.checkout_branch(&main);
        t.create_commit("main moves", &[("m.txt", "m")]);
        let repo = t.repo();
        t.cherry_pick_onto_head(c1);

        let target = repo.head().unwrap().target().unwrap();
        let kind = detect_merge_kind(&repo, oid_of(&repo, "feature"), target).unwrap();
        assert_eq!(
            kind, None,
            "feat 2 never landed, so the branch is not merged"
        );
    }

    #[test]
    fn squash_merged_branch_is_detected() {
        let t = TestRepo::with_initial_commit();
        let main = t.current_branch();
        let base = t.head_oid();
        t.create_branch("feature");
        t.checkout_branch("feature");
        t.create_commit("feat 1", &[("a.txt", "a1")]);
        t.create_commit("feat 2", &[("a.txt", "a2"), ("b.txt", "b")]);
        t.checkout_branch(&main);
        t.create_commit("main moves", &[("m.txt", "m")]);
        let repo = t.repo();
        t.squash_onto_head(oid_of(&repo, "feature"), base);

        let target = repo.head().unwrap().target().unwrap();
        let kind = detect_merge_kind(&repo, oid_of(&repo, "feature"), target).unwrap();
        assert_eq!(kind, Some(MergeKind::Squash));
    }

    #[test]
    fn landed_commit_later_edited_on_target_is_still_merged() {
        // A one-commit branch squash-merged has the same patch-id as its
        // commit, so it is recognised even after the target rewrites the line
        // (`git cherry` agrees). Deleting it loses nothing that is not already
        // in the target's history.
        let t = TestRepo::with_initial_commit();
        let main = t.current_branch();
        let base = t.head_oid();
        t.create_branch("feature");
        t.checkout_branch("feature");
        t.create_commit("feat", &[("a.txt", "feature")]);
        t.checkout_branch(&main);
        let repo = t.repo();
        t.squash_onto_head(oid_of(&repo, "feature"), base);
        t.create_commit("rewrite", &[("a.txt", "rewritten")]);

        let target = repo.head().unwrap().target().unwrap();
        let kind = detect_merge_kind(&repo, oid_of(&repo, "feature"), target).unwrap();
        assert_eq!(kind, Some(MergeKind::Rebase));
    }

    #[test]
    fn squash_then_conflicting_target_edit_is_not_provably_merged() {
        // Multi-commit squash (no patch-id match) followed by a target edit of
        // the same lines: re-applying the branch conflicts, so containment
        // cannot be proven and the branch must not be labelled merged.
        let t = TestRepo::with_initial_commit();
        let main = t.current_branch();
        let base = t.head_oid();
        t.create_branch("feature");
        t.checkout_branch("feature");
        t.create_commit("feat 1", &[("a.txt", "one")]);
        t.create_commit("feat 2", &[("a.txt", "two")]);
        t.checkout_branch(&main);
        let repo = t.repo();
        t.squash_onto_head(oid_of(&repo, "feature"), base);
        t.create_commit("rewrite", &[("a.txt", "rewritten")]);

        let target = repo.head().unwrap().target().unwrap();
        let kind = detect_merge_kind(&repo, oid_of(&repo, "feature"), target).unwrap();
        assert_eq!(kind, None);
    }

    #[test]
    fn branch_with_extra_work_after_squash_is_not_merged() {
        let t = TestRepo::with_initial_commit();
        let main = t.current_branch();
        let base = t.head_oid();
        t.create_branch("feature");
        t.checkout_branch("feature");
        t.create_commit("feat", &[("a.txt", "a")]);
        let repo = t.repo();
        let squashed_tip = oid_of(&repo, "feature");
        t.create_commit("more work", &[("c.txt", "c")]);
        t.checkout_branch(&main);
        t.squash_onto_head(squashed_tip, base);

        let target = repo.head().unwrap().target().unwrap();
        let kind = detect_merge_kind(&repo, oid_of(&repo, "feature"), target).unwrap();
        assert_eq!(kind, None, "c.txt is not in the target");
    }

    #[test]
    fn merge_kind_serializes_camel_case() {
        assert_eq!(
            serde_json::to_string(&MergeKind::Squash).unwrap(),
            "\"squash\""
        );
        assert_eq!(
            serde_json::to_string(&MergeKind::Ancestor).unwrap(),
            "\"ancestor\""
        );
    }

    #[test]
    fn squash_detection_does_not_write_loose_objects() {
        let t = TestRepo::with_initial_commit();
        let main = t.current_branch();
        let base = t.head_oid();
        t.create_branch("feature");
        t.checkout_branch("feature");
        t.create_commit("feat 1", &[("a.txt", "a1")]);
        t.create_commit("feat 2", &[("a.txt", "a2"), ("b.txt", "b")]);
        t.checkout_branch(&main);
        t.create_commit("main moves", &[("m.txt", "m")]);
        let repo = t.repo();
        t.squash_onto_head(oid_of(&repo, "feature"), base);

        let objects_dir = t.path.join(".git").join("objects");
        let count_loose = || -> usize {
            std::fs::read_dir(&objects_dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| {
                    let name = e.file_name();
                    let s = name.to_string_lossy();
                    s.len() == 2 && s.chars().all(|c| c.is_ascii_hexdigit())
                })
                .map(|dir| std::fs::read_dir(dir.path()).unwrap().count())
                .sum()
        };

        let before = count_loose();
        let target = repo.head().unwrap().target().unwrap();
        let kind = detect_merge_kind(&repo, oid_of(&repo, "feature"), target).unwrap();
        assert_eq!(kind, Some(MergeKind::Squash));
        let after = count_loose();
        assert_eq!(
            before, after,
            "read-only merge detection must not write loose objects into .git/objects"
        );
    }
}
