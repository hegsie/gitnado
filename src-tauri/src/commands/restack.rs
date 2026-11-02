//! Restack a stack of branches (roadmap 4.3, issue #615).
//!
//! After the base of a stack moves (new commits on `main`, or a lower branch
//! amended, rebased or squash-merged), every branch above it has to be
//! replayed onto its parent's new tip. Doing that branch by branch in the
//! user's working tree is exactly the error-prone chore stacks are meant to
//! remove, so the whole stack is replayed in a throwaway worktree first:
//!
//! * `preview_restack` runs that ghost restack and reports, per branch,
//!   whether it is already up to date, would be replayed cleanly, would
//!   conflict (with the files and the commit), or has already been merged into
//!   its parent — without touching a single ref.
//! * `restack` runs the same ghost restack and, only when every level replayed
//!   cleanly, moves all the branch refs at once. A conflict anywhere leaves
//!   the repository exactly as it was.
//!
//! A branch that turns out to be merged into its parent already (fast-forward,
//! rebase or squash merge) is skipped; the branches stacked on it are replayed
//! straight onto that parent, with their stack link re-pointed to it.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use git2::{BranchType, Oid, Repository};
use serde::Serialize;
use tauri::command;

use crate::commands::merge::{join_output, stopped_commit_summary};
use crate::commands::stack::{set_parent_in, stacks_in, StackBranch};
use crate::error::{GitnadoError, Result};
use crate::utils::create_command;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RestackStatus {
    /// Already on its parent's tip: nothing to do.
    UpToDate,
    /// Replays cleanly onto its parent.
    Restacked,
    /// Its changes are already in its parent; it is skipped and the branches
    /// above it move onto the parent.
    Merged,
    /// Replaying it stops on a conflict.
    Conflict,
    /// Not attempted because a branch below it conflicted.
    Blocked,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestackStep {
    pub branch: String,
    /// The parent it is replayed onto (after skipping merged branches).
    pub onto: String,
    pub status: RestackStatus,
    /// Commits replayed (for `restacked`), or that would have been.
    pub commits: usize,
    pub conflict_files: Vec<String>,
    pub conflict_commit: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestackPlan {
    pub base: String,
    pub steps: Vec<RestackStep>,
    /// True when nothing conflicts, so `restack` would apply.
    pub can_apply: bool,
    /// True when `restack` would change at least one branch.
    pub has_changes: bool,
}

/// The outcome of the ghost restack: the plan, and the new tip for every
/// branch that moves.
struct GhostRun {
    plan: RestackPlan,
    new_tips: Vec<(String, Oid, Oid)>,
    /// Branches whose stack parent changes because their old parent merged.
    reparent: Vec<(String, String)>,
}

fn branch_tip(repo: &Repository, name: &str) -> Result<Oid> {
    repo.find_branch(name, BranchType::Local)
        .map_err(|_| GitnadoError::BranchNotFound(name.to_string()))?
        .get()
        .target()
        .ok_or_else(|| GitnadoError::BranchNotFound(name.to_string()))
}

/// Whether everything `branch` changes is already in `parent`: an ancestor
/// (fast-forward / true merge), or merging it in would not change the parent's
/// tree (squash or rebase merge).
fn content_merged(repo: &Repository, branch: Oid, parent: Oid) -> bool {
    if branch == parent || repo.graph_descendant_of(parent, branch).unwrap_or(false) {
        return true;
    }
    let Ok(base) = repo.merge_base(branch, parent) else {
        return false;
    };
    if base == branch {
        return true;
    }
    let (Ok(ours), Ok(theirs), Ok(ancestor)) = (
        repo.find_commit(parent),
        repo.find_commit(branch),
        repo.find_commit(base),
    ) else {
        return false;
    };
    let (Ok(our_tree), Ok(their_tree), Ok(base_tree)) =
        (ours.tree(), theirs.tree(), ancestor.tree())
    else {
        return false;
    };
    let Ok(mut index) = repo.merge_trees(&base_tree, &our_tree, &their_tree, None) else {
        return false;
    };
    if index.has_conflicts() {
        return false;
    }
    match index.write_tree_to(repo) {
        Ok(merged) => merged == our_tree.id(),
        Err(_) => false,
    }
}

fn git(dir: &Path, args: &[&str]) -> Result<std::process::Output> {
    create_command("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run git: {e}")))
}

/// A detached throwaway worktree, removed on drop.
struct GhostWorktree {
    repo_path: std::path::PathBuf,
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
}

impl GhostWorktree {
    fn new(repo_path: &Path, at: Oid) -> Result<Self> {
        let dir = tempfile::tempdir().map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to create temp dir: {e}"))
        })?;
        let path = dir.path().join("ghost");
        let at = at.to_string();
        let out = git(
            repo_path,
            &["worktree", "add", "--detach", &path.to_string_lossy(), &at],
        )?;
        if !out.status.success() {
            return Err(GitnadoError::OperationFailed(format!(
                "Failed to create a scratch worktree: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Ok(Self {
            repo_path: repo_path.to_path_buf(),
            _dir: dir,
            path,
        })
    }

    /// Replay `fork..tip` onto `onto`. Ok(new tip) or Err((files, commit)).
    fn replay(
        &self,
        tip: Oid,
        fork: Oid,
        onto: Oid,
    ) -> Result<std::result::Result<Oid, (Vec<String>, Option<String>)>> {
        let out = git(
            &self.path,
            &["checkout", "--detach", "--quiet", &tip.to_string()],
        )?;
        if !out.status.success() {
            return Err(GitnadoError::OperationFailed(format!(
                "Failed to prepare the scratch worktree: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        let out = git(
            &self.path,
            &["rebase", "--onto", &onto.to_string(), &fork.to_string()],
        )?;
        if out.status.success() {
            let head = git(&self.path, &["rev-parse", "HEAD"])?;
            let sha = String::from_utf8_lossy(&head.stdout).trim().to_string();
            return Oid::from_str(&sha)
                .map(Ok)
                .map_err(|e| GitnadoError::OperationFailed(format!("Bad rebase result: {e}")));
        }
        let combined = join_output(
            &String::from_utf8_lossy(&out.stdout),
            &String::from_utf8_lossy(&out.stderr),
        );
        let files: Vec<String> = git(
            &self.path,
            &["diff", "--name-only", "--diff-filter=U", "-z"],
        )
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .split('\0')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
        // The commit the rebase stopped on, from REBASE_HEAD rather than
        // git's (translated, version-dependent) message when available.
        let stopped = git(&self.path, &["log", "-1", "--format=%s", "REBASE_HEAD"])
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| stopped_commit_summary(&combined));
        let _ = git(&self.path, &["rebase", "--abort"]);
        if files.is_empty() {
            return Err(GitnadoError::OperationFailed(format!(
                "Could not replay the branch: {}",
                combined.trim()
            )));
        }
        Ok(Err((files, stopped)))
    }
}

impl Drop for GhostWorktree {
    fn drop(&mut self) {
        let _ = git(
            &self.repo_path,
            &[
                "worktree",
                "remove",
                "--force",
                &self.path.to_string_lossy(),
            ],
        );
        let _ = git(&self.repo_path, &["worktree", "prune"]);
    }
}

fn count_commits(repo: &Repository, from: Oid, to: Oid) -> usize {
    repo.graph_ahead_behind(to, from)
        .map(|(a, _)| a)
        .unwrap_or(0)
}

/// Run the whole stack through the ghost worktree, bottom to top.
fn ghost_restack(repo: &Repository, repo_path: &Path, base: &str) -> Result<GhostRun> {
    let stack = stacks_in(repo)?
        .into_iter()
        .find(|s| s.base == base)
        .ok_or_else(|| GitnadoError::OperationFailed(format!("No stack is based on {base}")))?;
    if let Some(orphan) = stack.branches.iter().find(|b| b.parent_missing) {
        return Err(GitnadoError::OperationFailed(format!(
            "{}'s parent {} no longer exists; stack it on an existing branch first",
            orphan.name, orphan.parent
        )));
    }

    let base_tip = branch_tip(repo, base)?;
    // Old and new tips of every branch processed so far, keyed by name; the
    // base never moves.
    let mut old_tip: HashMap<String, Oid> = HashMap::new();
    let mut new_tip: HashMap<String, Oid> = HashMap::new();
    old_tip.insert(base.to_string(), base_tip);
    new_tip.insert(base.to_string(), base_tip);
    // A merged branch stands in for its own parent from then on.
    let mut effective_parent: HashMap<String, String> = HashMap::new();
    let mut blocked: HashSet<String> = HashSet::new();

    let mut ghost: Option<GhostWorktree> = None;
    let mut steps = Vec::new();
    let mut new_tips = Vec::new();
    let mut reparent = Vec::new();

    for StackBranch { name, parent, .. } in &stack.branches {
        let onto_name = effective_parent
            .get(parent)
            .cloned()
            .unwrap_or_else(|| parent.clone());
        let tip = branch_tip(repo, name)?;
        old_tip.insert(name.clone(), tip);
        let step = |status, commits, files: Vec<String>, commit: Option<String>| RestackStep {
            branch: name.clone(),
            onto: onto_name.clone(),
            status,
            commits,
            conflict_files: files,
            conflict_commit: commit,
        };

        if blocked.contains(parent) {
            blocked.insert(name.clone());
            steps.push(step(RestackStatus::Blocked, 0, vec![], None));
            continue;
        }

        let parent_old = old_tip[parent];
        let onto = new_tip[&onto_name];

        // Merged into what it would be replayed onto: skip it, and let the
        // branches above it land on its parent instead.
        if content_merged(repo, tip, onto) {
            steps.push(step(RestackStatus::Merged, 0, vec![], None));
            effective_parent.insert(name.clone(), onto_name.clone());
            new_tip.insert(name.clone(), onto);
            continue;
        }

        // Where this branch left its parent: the parent's pre-restack tip when
        // the branch still contains it, else the best common ancestor.
        let fork =
            if repo.graph_descendant_of(tip, parent_old).unwrap_or(false) || tip == parent_old {
                parent_old
            } else {
                repo.merge_base(tip, parent_old)?
            };
        let commits = count_commits(repo, fork, tip);

        if onto_name != *parent {
            reparent.push((name.clone(), onto_name.clone()));
        }

        if fork == onto {
            steps.push(step(RestackStatus::UpToDate, commits, vec![], None));
            new_tip.insert(name.clone(), tip);
            continue;
        }

        if ghost.is_none() {
            ghost = Some(GhostWorktree::new(repo_path, onto)?);
        }
        match ghost
            .as_ref()
            .expect("ghost created above")
            .replay(tip, fork, onto)?
        {
            Ok(replayed) => {
                steps.push(step(RestackStatus::Restacked, commits, vec![], None));
                new_tip.insert(name.clone(), replayed);
                new_tips.push((name.clone(), tip, replayed));
            }
            Err((files, commit)) => {
                steps.push(step(RestackStatus::Conflict, commits, files, commit));
                blocked.insert(name.clone());
            }
        }
    }

    let can_apply = blocked.is_empty();
    let has_changes = !new_tips.is_empty() || !reparent.is_empty();
    Ok(GhostRun {
        plan: RestackPlan {
            base: base.to_string(),
            steps,
            can_apply,
            has_changes,
        },
        new_tips,
        reparent,
    })
}

/// Branches checked out in any worktree of the repository, by worktree path.
fn checked_out_branches(repo_path: &Path) -> Result<HashMap<String, String>> {
    let out = git(repo_path, &["worktree", "list", "--porcelain"])?;
    let mut map = HashMap::new();
    let mut current: Option<String> = None;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            current = Some(p.to_string());
        } else if let Some(r) = line.strip_prefix("branch refs/heads/") {
            if let Some(p) = &current {
                map.insert(r.to_string(), p.clone());
            }
        }
    }
    Ok(map)
}

fn has_tracked_changes(repo: &Repository) -> Result<bool> {
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(false).include_ignored(false);
    Ok(repo
        .statuses(Some(&mut opts))?
        .iter()
        .any(|s| s.status() != git2::Status::CURRENT))
}

pub fn preview_in(repo_path: &Path, base: &str) -> Result<RestackPlan> {
    let repo = Repository::open(repo_path)?;
    Ok(ghost_restack(&repo, repo_path, base)?.plan)
}

pub fn restack_in(repo_path: &Path, base: &str) -> Result<RestackPlan> {
    let repo = Repository::open(repo_path)?;
    if repo.state() != git2::RepositoryState::Clean {
        return Err(GitnadoError::OperationFailed(
            "Finish or abort the operation in progress before restacking".to_string(),
        ));
    }
    let run = ghost_restack(&repo, repo_path, base)?;
    if !run.plan.can_apply {
        let conflict = run
            .plan
            .steps
            .iter()
            .find(|s| s.status == RestackStatus::Conflict)
            .map(|s| format!("{} conflicts in {}", s.branch, s.conflict_files.join(", ")))
            .unwrap_or_default();
        return Err(GitnadoError::OperationFailed(format!(
            "Restack would stop on a conflict ({conflict}); nothing was changed"
        )));
    }

    // A moved branch that is checked out must have its working tree follow.
    // The main worktree is updated below when it is clean; a branch checked
    // out in another worktree cannot be moved safely from here.
    let checked_out = checked_out_branches(repo_path)?;
    let head_branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().ok().map(str::to_string));
    let main_root = repo
        .workdir()
        .map(|p| p.canonicalize().unwrap_or(p.to_path_buf()));
    let mut moves_head = false;
    for (name, _, _) in &run.new_tips {
        if head_branch.as_deref() == Some(name.as_str()) {
            moves_head = true;
        } else if let Some(wt) = checked_out.get(name) {
            let wt_path = Path::new(wt).canonicalize().unwrap_or_else(|_| wt.into());
            if Some(&wt_path) != main_root.as_ref() {
                return Err(GitnadoError::OperationFailed(format!(
                    "{name} is checked out in another worktree ({wt}); switch that worktree away from it first"
                )));
            }
        }
    }
    if moves_head && has_tracked_changes(&repo)? {
        return Err(GitnadoError::OperationFailed(
            "The current branch is part of the stack and has uncommitted changes; commit or stash them first"
                .to_string(),
        ));
    }

    for (name, old, new) in &run.new_tips {
        let refname = format!("refs/heads/{name}");
        repo.reference_matching(
            &refname,
            *new,
            true,
            *old,
            &format!("gitnado: restack {name} onto its parent"),
        )
        .map_err(|e| {
            GitnadoError::OperationFailed(format!(
                "{name} changed while restacking: {}",
                e.message()
            ))
        })?;
    }
    for (name, parent) in &run.reparent {
        set_parent_in(&repo, name, parent)?;
    }
    if moves_head {
        let mut opts = git2::build::CheckoutBuilder::new();
        opts.force();
        repo.checkout_head(Some(&mut opts))?;
    }
    Ok(run.plan)
}

/// Predict a restack of the stack based on `base` without changing anything.
#[command]
pub async fn preview_restack(path: String, base: String) -> Result<RestackPlan> {
    crate::utils::blocking_git(move || preview_in(Path::new(&path), &base)).await
}

/// Replay every branch of the stack based on `base` onto its parent's tip.
/// All-or-nothing: a conflict anywhere changes nothing.
#[command]
pub async fn restack(path: String, base: String) -> Result<RestackPlan> {
    crate::utils::blocking_git(move || restack_in(Path::new(&path), &base)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::stack::set_parent_in;
    use crate::test_utils::TestRepo;

    /// main -> a (a1) -> b (b1), then main moves on.
    fn stack_with_moved_base() -> TestRepo {
        let t = TestRepo::with_initial_commit();
        t.create_branch("a");
        t.checkout_branch("a");
        t.create_commit("a1", &[("a.txt", "a")]);
        t.create_branch("b");
        t.checkout_branch("b");
        t.create_commit("b1", &[("b.txt", "b")]);
        t.checkout_branch("main");
        t.create_commit("main moves", &[("main.txt", "m")]);
        let repo = t.repo();
        set_parent_in(&repo, "a", "main").unwrap();
        set_parent_in(&repo, "b", "a").unwrap();
        t
    }

    fn tip(t: &TestRepo, name: &str) -> Oid {
        branch_tip(&t.repo(), name).unwrap()
    }

    fn statuses(plan: &RestackPlan) -> Vec<(&str, RestackStatus)> {
        plan.steps
            .iter()
            .map(|s| (s.branch.as_str(), s.status))
            .collect()
    }

    #[tokio::test]
    async fn preview_changes_nothing_and_reports_each_level() {
        let t = stack_with_moved_base();
        let (a, b) = (tip(&t, "a"), tip(&t, "b"));
        let plan = preview_restack(t.path_str(), "main".into()).await.unwrap();
        assert_eq!(
            statuses(&plan),
            vec![
                ("a", RestackStatus::Restacked),
                ("b", RestackStatus::Restacked)
            ]
        );
        assert!(plan.can_apply && plan.has_changes);
        assert_eq!(plan.steps[0].commits, 1);
        assert_eq!((tip(&t, "a"), tip(&t, "b")), (a, b), "preview moved a ref");
        // The scratch worktree is gone.
        assert_eq!(t.repo().worktrees().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn restack_moves_every_level_onto_its_new_parent() {
        let t = stack_with_moved_base();
        restack(t.path_str(), "main".into()).await.unwrap();
        let repo = t.repo();
        let (main, a, b) = (tip(&t, "main"), tip(&t, "a"), tip(&t, "b"));
        assert_eq!(repo.find_commit(a).unwrap().parent_id(0).unwrap(), main);
        assert_eq!(repo.find_commit(b).unwrap().parent_id(0).unwrap(), a);
        let stacks = stacks_in(&repo).unwrap();
        assert!(stacks[0].branches.iter().all(|b| b.behind == 0));
        // A second run is a no-op.
        let plan = preview_restack(t.path_str(), "main".into()).await.unwrap();
        assert!(!plan.has_changes);
        assert!(plan
            .steps
            .iter()
            .all(|s| s.status == RestackStatus::UpToDate));
    }

    #[tokio::test]
    async fn an_amended_middle_branch_carries_its_children_without_duplicates() {
        let t = TestRepo::with_initial_commit();
        t.create_branch("a");
        t.checkout_branch("a");
        t.create_commit("a1", &[("a.txt", "a")]);
        t.create_branch("b");
        t.checkout_branch("b");
        t.create_commit("b1", &[("b.txt", "b")]);
        let repo = t.repo();
        set_parent_in(&repo, "a", "main").unwrap();
        set_parent_in(&repo, "b", "a").unwrap();
        // Amend a: same change, different commit.
        t.checkout_branch("a");
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let amended = head
            .amend(Some("HEAD"), None, None, None, Some("a1 (amended)"), None)
            .unwrap();
        assert_ne!(amended, head.id());

        restack(t.path_str(), "main".into()).await.unwrap();
        let b = repo.find_commit(tip(&t, "b")).unwrap();
        assert_eq!(
            b.parent_id(0).unwrap(),
            amended,
            "b now sits on the amended a"
        );
        assert_eq!(
            count_commits(&repo, amended, b.id()),
            1,
            "old a1 not replayed again"
        );
    }

    #[tokio::test]
    async fn a_conflict_is_predicted_and_restack_changes_nothing() {
        let t = TestRepo::with_initial_commit();
        t.create_branch("a");
        t.checkout_branch("a");
        t.create_commit("a edits README", &[("README.md", "from a")]);
        t.create_branch("b");
        t.checkout_branch("b");
        t.create_commit("b1", &[("b.txt", "b")]);
        t.checkout_branch("main");
        t.create_commit("main edits README", &[("README.md", "from main")]);
        let repo = t.repo();
        set_parent_in(&repo, "a", "main").unwrap();
        set_parent_in(&repo, "b", "a").unwrap();
        let before = (tip(&t, "a"), tip(&t, "b"));

        let plan = preview_restack(t.path_str(), "main".into()).await.unwrap();
        assert_eq!(
            statuses(&plan),
            vec![
                ("a", RestackStatus::Conflict),
                ("b", RestackStatus::Blocked)
            ]
        );
        assert_eq!(plan.steps[0].conflict_files, vec!["README.md".to_string()]);
        assert_eq!(
            plan.steps[0].conflict_commit.as_deref(),
            Some("a edits README")
        );
        assert!(!plan.can_apply);

        let err = restack(t.path_str(), "main".into())
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("nothing was changed"), "{err}");
        assert_eq!((tip(&t, "a"), tip(&t, "b")), before);
        assert_eq!(repo.worktrees().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn a_squash_merged_lower_branch_is_skipped_and_children_move_to_the_base() {
        let t = TestRepo::with_initial_commit();
        t.create_branch("a");
        t.checkout_branch("a");
        t.create_commit("a1", &[("a.txt", "a")]);
        t.create_commit("a2", &[("a.txt", "aa")]);
        t.create_branch("b");
        t.checkout_branch("b");
        t.create_commit("b1", &[("b.txt", "b")]);
        let repo = t.repo();
        set_parent_in(&repo, "a", "main").unwrap();
        set_parent_in(&repo, "b", "a").unwrap();
        // Squash-merge a into main.
        t.checkout_branch("main");
        t.create_commit("a (squashed)", &[("a.txt", "aa")]);

        let plan = restack(t.path_str(), "main".into()).await.unwrap();
        assert_eq!(
            statuses(&plan),
            vec![
                ("a", RestackStatus::Merged),
                ("b", RestackStatus::Restacked)
            ]
        );
        assert_eq!(plan.steps[1].onto, "main");
        let b = repo.find_commit(tip(&t, "b")).unwrap();
        assert_eq!(b.parent_id(0).unwrap(), tip(&t, "main"));
        let stacks = stacks_in(&repo).unwrap();
        let b_entry = stacks
            .iter()
            .flat_map(|s| &s.branches)
            .find(|e| e.name == "b")
            .unwrap();
        assert_eq!(b_entry.parent, "main", "b re-pointed at a's parent");
    }

    #[tokio::test]
    async fn the_checked_out_branch_moves_with_its_working_tree() {
        let t = stack_with_moved_base();
        t.checkout_branch("b");
        restack(t.path_str(), "main".into()).await.unwrap();
        // The working tree now has main's new file too.
        assert!(t.path.join("main.txt").exists());
        assert!(!has_tracked_changes(&t.repo()).unwrap());
    }

    #[tokio::test]
    async fn uncommitted_changes_on_a_moving_head_branch_are_refused() {
        let t = stack_with_moved_base();
        t.checkout_branch("b");
        std::fs::write(t.path.join("b.txt"), "dirty").unwrap();
        let before = tip(&t, "b");
        let err = restack(t.path_str(), "main".into())
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("uncommitted"), "{err}");
        assert_eq!(tip(&t, "b"), before);
        assert_eq!(
            std::fs::read_to_string(t.path.join("b.txt")).unwrap(),
            "dirty"
        );
    }

    #[tokio::test]
    async fn unknown_stack_and_orphans_are_errors() {
        let t = stack_with_moved_base();
        assert!(preview_restack(t.path_str(), "nope".into()).await.is_err());
        t.repo()
            .find_branch("a", BranchType::Local)
            .unwrap()
            .delete()
            .unwrap();
        let err = preview_restack(t.path_str(), "a".into())
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("no longer exists"), "{err}");
    }

    #[test]
    fn plan_serializes_camel_case() {
        let json = serde_json::to_string(&RestackPlan {
            base: "main".into(),
            steps: vec![RestackStep {
                branch: "a".into(),
                onto: "main".into(),
                status: RestackStatus::UpToDate,
                commits: 0,
                conflict_files: vec![],
                conflict_commit: None,
            }],
            can_apply: true,
            has_changes: false,
        })
        .unwrap();
        assert!(
            json.contains("\"upToDate\"")
                && json.contains("canApply")
                && json.contains("conflictFiles")
        );
    }
}
