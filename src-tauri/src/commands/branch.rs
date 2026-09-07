//! Branch command handlers

use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::models::{AheadBehind, Branch, BranchTrackingInfo};

/// Default stale threshold in days
const STALE_THRESHOLD_DAYS: i64 = 90;

/// Get all branches in the repository
#[command]
pub async fn get_branches(path: String) -> Result<Vec<Branch>> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let mut branches = Vec::new();

    let head = repo.head().ok();
    let _head_oid = head.as_ref().and_then(|h| h.target());

    // Calculate stale threshold (90 days ago in seconds since epoch)
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let stale_threshold = now - (STALE_THRESHOLD_DAYS * 24 * 60 * 60);

    for branch_result in repo.branches(None)? {
        let (branch, branch_type) = branch_result?;
        let name = branch.name()?.unwrap_or("").to_string();
        let reference = branch.get();

        let is_remote = branch_type == git2::BranchType::Remote;

        // Skip the remote's symbolic HEAD pointer (refs/remotes/origin/HEAD),
        // which every clone has.
        //
        // It is a pointer at the remote's default branch, not a branch of its
        // own: `git branch -r` renders it as "origin/HEAD -> origin/main" and
        // never offers it for checkout. Listing it produced a row named
        // "origin/HEAD" with an empty target oid and no timestamp — a symbolic
        // ref has no direct target — and checking that row out derived the
        // local branch name "HEAD", which libgit2 rejects as invalid.
        if is_remote && reference.kind() == Some(git2::ReferenceType::Symbolic) {
            continue;
        }

        let is_head = head
            .as_ref()
            .map(|h| h.name() == reference.name())
            .unwrap_or(false);

        let target_oid = reference
            .target()
            .map(|oid| oid.to_string())
            .unwrap_or_default();

        // Get the last commit timestamp for this branch
        let last_commit_timestamp = reference.target().and_then(|oid| {
            repo.find_commit(oid)
                .ok()
                .map(|commit| commit.time().seconds())
        });

        // Branch is stale if it's not HEAD and hasn't been updated in threshold days
        let is_stale = !is_head
            && last_commit_timestamp
                .map(|ts| ts < stale_threshold)
                .unwrap_or(false);

        let upstream = branch
            .upstream()
            .ok()
            .and_then(|u| u.name().ok().flatten().map(|n| n.to_string()));

        let ahead_behind = if !is_remote {
            if let (Some(local_oid), Some(upstream_branch)) =
                (reference.target(), branch.upstream().ok())
            {
                if let Some(upstream_oid) = upstream_branch.get().target() {
                    repo.graph_ahead_behind(local_oid, upstream_oid)
                        .ok()
                        .map(|(ahead, behind)| AheadBehind { ahead, behind })
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        branches.push(Branch {
            name: name.clone(),
            shorthand: if is_remote {
                // For remote branches, strip the remote name prefix (e.g., "origin/main" -> "main")
                name.split_once('/')
                    .map(|x| x.1)
                    .unwrap_or(&name)
                    .to_string()
            } else {
                // For local branches, use the full name (e.g., "feature/my-fix")
                name.clone()
            },
            is_head,
            is_remote,
            upstream,
            target_oid,
            ahead_behind,
            last_commit_timestamp,
            is_stale,
        });
    }

    Ok(branches)
}

/// Create a new branch
#[command]
pub async fn create_branch(
    path: String,
    name: String,
    start_point: Option<String>,
    checkout: Option<bool>,
) -> Result<Branch> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // "Checkout new branch after creation" is the dialog's default, so this
    // switches branches without being called checkout — which is how it was
    // missed when ensure_checkoutable was added to the two commands that are.
    // Checked BEFORE the ref is created so a refusal leaves nothing behind.
    if checkout.unwrap_or(false) {
        ensure_checkoutable(&repo)?;
    }

    let commit = if let Some(ref start) = start_point {
        let obj = repo.revparse_single(start)?;
        obj.peel_to_commit()?
    } else {
        repo.head()?.peel_to_commit()?
    };

    let branch = repo.branch(&name, &commit, false)?;
    let reference = branch.get();

    if checkout.unwrap_or(false) {
        let old_head = crate::commands::hooks::head_oid_string(&repo);
        let obj = reference.peel(git2::ObjectType::Commit)?;
        // The checkout is fallible (a dirty file that differs between HEAD and
        // the start point conflicts), and the ref already exists by now. Roll
        // it back so "create failed" stays literally true — otherwise the
        // dialog showed an error while the refs watcher made the branch appear
        // in the sidebar, and a retry dead-ended on "already exists".
        let switch = (|| -> Result<()> {
            repo.checkout_tree(&obj, None)?;
            repo.set_head(reference.name().map_err(|_| {
                GitnadoError::OperationFailed("Invalid reference name encoding".to_string())
            })?)?;
            Ok(())
        })();
        if let Err(e) = switch {
            if let Ok(mut created) = repo.find_branch(&name, git2::BranchType::Local) {
                let _ = created.delete();
            }
            return Err(e);
        }
        let new_head = crate::commands::hooks::head_oid_string(&repo);
        crate::commands::hooks::run_post_checkout(&repo, &old_head, &new_head, true);
    }

    Ok(Branch {
        name: name.clone(),
        shorthand: name.clone(),
        is_head: checkout.unwrap_or(false),
        is_remote: false,
        upstream: None,
        target_oid: commit.id().to_string(),
        ahead_behind: None,
        last_commit_timestamp: Some(commit.time().seconds()),
        is_stale: false, // Newly created branches are never stale
    })
}

/// Delete a branch
#[command]
pub async fn delete_branch(path: String, name: String, force: Option<bool>) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;

    let mut branch = repo
        .find_branch(&name, git2::BranchType::Local)
        .map_err(|_| GitnadoError::BranchNotFound(name.clone()))?;

    // Enforce preventDeletion branch rules HERE rather than only in the cleanup
    // dialog's candidate listing: the sidebar and the graph ref menu call this
    // command directly, so a rule the UI displays as active was inert on both
    // of those surfaces. Checked before the force branch so force cannot bypass
    // an explicit protection rule.
    // Propagated, NOT unwrap_or_default: load_rules errors both when the file
    // is unreadable and when it fails to parse (save_rules is a non-atomic
    // write, so a crash mid-save can truncate it). Defaulting to "no rules"
    // would make an unreadable rule set indistinguishable from an empty one and
    // silently disable every protection in the repo — a protection that fails
    // open is worse than none, because the UI still shows the branch as
    // protected.
    let rules = super::branch_rules::load_rules(Path::new(&path))?;
    if super::branch_rules::is_deletion_prevented(&rules, &name) {
        return Err(GitnadoError::OperationFailed(format!(
            "Branch \"{}\" is protected by a branch rule and cannot be deleted. Remove the rule first.",
            name
        )));
    }

    if force.unwrap_or(false) {
        branch.delete()?;
    } else {
        // Check if branch is merged before deleting.
        //
        // An UNBORN HEAD is not an error here. On an orphan branch with no
        // commits (`git checkout --orphan gh-pages`, the standard way to start
        // a docs branch) repo.head() fails, and propagating that reported
        // "reference 'refs/heads/gh-pages' not found" — naming a branch the
        // user had not selected. Worse, the frontend gates its Force Delete
        // escalation on /not fully merged/i, so that message hid the one
        // recovery the app offers, even though force delete works fine here.
        // Canonical git says "not fully merged" in this state.
        let head = match repo.head() {
            Ok(h) => h,
            Err(_) => {
                return Err(GitnadoError::OperationFailed(
                    "Branch is not fully merged. Use force to delete anyway.".to_string(),
                ))
            }
        };
        if let (Some(head_oid), Some(branch_oid)) = (head.target(), branch.get().target()) {
            // A branch is fully merged into HEAD when HEAD is at or descends
            // from the branch tip. The equality case matters: `git branch -d`
            // deletes a branch that points at the same commit as HEAD, but
            // graph_descendant_of returns false for equal oids.
            if head_oid == branch_oid || repo.graph_descendant_of(head_oid, branch_oid)? {
                branch.delete()?;
            } else {
                return Err(GitnadoError::OperationFailed(
                    "Branch is not fully merged. Use force to delete anyway.".to_string(),
                ));
            }
        } else {
            branch.delete()?;
        }
    }

    Ok(())
}

/// Rename a branch
///
/// After renaming, if `update_tracking` is true (the default) and the branch
/// had an upstream configured, the tracking reference is updated so the
/// renamed branch keeps tracking the same remote branch.
#[command]
pub async fn rename_branch(
    path: String,
    old_name: String,
    new_name: String,
    update_tracking: Option<bool>,
) -> Result<Branch> {
    let repo = git2::Repository::open(Path::new(&path))?;

    let mut branch = repo
        .find_branch(&old_name, git2::BranchType::Local)
        .map_err(|_| GitnadoError::BranchNotFound(old_name.clone()))?;

    // Capture existing upstream info before rename
    let upstream_name = branch
        .upstream()
        .ok()
        .and_then(|u| u.name().ok().flatten().map(|n| n.to_string()));

    branch.rename(&new_name, false)?;

    // Get the renamed branch to return updated info
    let mut renamed_branch = repo.find_branch(&new_name, git2::BranchType::Local)?;

    // Re-apply upstream tracking if requested (default: true)
    let should_update = update_tracking.unwrap_or(true);
    if should_update {
        if let Some(ref up_name) = upstream_name {
            // Re-set the upstream on the renamed branch
            let _ = renamed_branch.set_upstream(Some(up_name));
            // Re-fetch the branch after setting upstream
            renamed_branch = repo.find_branch(&new_name, git2::BranchType::Local)?;
        }
    }

    let reference = renamed_branch.get();
    let target_oid = reference
        .target()
        .map(|o| o.to_string())
        .unwrap_or_default();

    let is_head = repo
        .head()
        .ok()
        .map(|h| h.name() == reference.name())
        .unwrap_or(false);

    let upstream = renamed_branch
        .upstream()
        .ok()
        .and_then(|u| u.name().ok().flatten().map(|n| n.to_string()));

    // Get the last commit timestamp
    let last_commit_timestamp = reference.target().and_then(|oid| {
        repo.find_commit(oid)
            .ok()
            .map(|commit| commit.time().seconds())
    });

    // Calculate if stale (if not HEAD)
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let stale_threshold = now - (STALE_THRESHOLD_DAYS * 24 * 60 * 60);
    let is_stale = !is_head
        && last_commit_timestamp
            .map(|ts| ts < stale_threshold)
            .unwrap_or(false);

    Ok(Branch {
        name: new_name.clone(),
        shorthand: new_name,
        is_head,
        is_remote: false,
        upstream,
        target_oid,
        ahead_behind: None,
        last_commit_timestamp,
        is_stale,
    })
}

/// Checkout a branch or commit
/// Refuse to switch branches while another operation owns the working tree.
///
/// merge, rebase, cherry_pick and both resets all defend this; checkout — the
/// one operation reachable from every list surface at all times — never did.
/// The direct route in is an interactive rebase paused on an `edit` line: it
/// returns success, closes its dialog, and leaves nothing modal on screen, so
/// the sidebar, the graph and the palette are all live. Checking out elsewhere
/// then moved HEAD while `.git/rebase-merge/` stayed on disk describing a
/// rebase of the OLD branch — every later merge/rebase on the new branch was
/// refused with "Another operation is in progress", and the still-visible
/// Abort would yank the user back to the original branch. Canonical git
/// refuses the same way.
/// The current index of the auto-stash `stash_oid`, or None when it is gone.
///
/// `git stash push` PREPENDS, so a stash created by another surface (or a
/// terminal) between the auto-stash save and the re-apply renumbers the entry.
/// Applying and dropping the bare index 0 then restored someone else's stash
/// and destroyed it, while the user's pre-checkout work stayed unapplied one
/// slot down — and the success toast still said the changes had been
/// re-applied. The checkout-FAILURE path in this same function already
/// verified the OID before popping; the success path, the common one, did not.
/// The worktree path where `branch_name` is checked out, if it is checked out
/// in a DIFFERENT worktree from the one we are operating on.
///
/// libgit2 enforces this rule in `git_repository_set_head`, not in
/// `git_checkout_tree` — and every checkout path here rewrites the working tree
/// first and moves HEAD second. So the refusal fired AFTER the damage: the tree
/// and index held the other branch's content, HEAD still named the old branch,
/// the whole inter-branch diff was left staged, and the auto-stash could not be
/// popped back over it. A user who then committed recorded the other branch's
/// entire tree onto their own. Canonical git refuses before touching anything
/// ("fatal: 'x' is already used by worktree at ..."), which is what this
/// restores.
fn branch_checked_out_elsewhere(repo: &git2::Repository, branch_name: &str) -> Option<String> {
    // The LOCAL branch this checkout will actually land on. Callers pass the
    // raw ref name, which for a remote row is "origin/develop" — so the check
    // tested refs/heads/origin/develop, matched nothing, and the remote arm
    // then resolved the local `develop` and hit the very corruption this
    // guards. Both checkout functions strip the same way.
    let local_name = match branch_name.find('/') {
        Some(pos)
            if repo
                .find_branch(branch_name, git2::BranchType::Local)
                .is_err() =>
        {
            &branch_name[pos + 1..]
        }
        _ => branch_name,
    };
    let target = format!("refs/heads/{}", local_name);

    // The MAIN worktree first. git_worktree_list enumerates only
    // $GIT_COMMON_DIR/worktrees/, which the main worktree has no entry in — so
    // when the app is opened ON a linked worktree (supported; isCurrentWorktree
    // exists for it) this check saw nothing at all, while libgit2's own
    // set_head refusal DOES cover the main worktree. The pre-check was strictly
    // weaker than the refusal it front-runs.
    if repo.is_worktree() {
        let common = repo.commondir().to_path_buf();
        if let Some(main_workdir) = common.parent() {
            if let Ok(main_repo) = git2::Repository::open(main_workdir) {
                let head_name = main_repo
                    .head()
                    .ok()
                    .and_then(|h| h.name().ok().map(|n| n.to_string()));
                if head_name.as_deref() == Some(target.as_str()) {
                    return Some(main_workdir.to_string_lossy().to_string());
                }
            }
        }
    }

    let worktrees = repo.worktrees().ok()?;
    let this_workdir: Option<std::path::PathBuf> =
        repo.workdir().and_then(|p| std::fs::canonicalize(p).ok());
    for entry in worktrees.iter() {
        let Ok(Some(name)) = entry else {
            continue;
        };
        let Ok(wt) = repo.find_worktree(name) else {
            continue;
        };
        let wt_path = std::fs::canonicalize(wt.path()).ok();
        // The worktree we are already standing in is not a conflict.
        if wt_path.is_some() && wt_path == this_workdir {
            continue;
        }
        let Ok(wt_repo) = git2::Repository::open_from_worktree(&wt) else {
            continue;
        };
        let head_name = wt_repo
            .head()
            .ok()
            .and_then(|h| h.name().ok().map(|n| n.to_string()));
        if head_name.as_deref() == Some(target.as_str()) {
            return Some(wt.path().to_string_lossy().to_string());
        }
    }
    None
}

/// Refuse a checkout of a branch that another worktree holds, BEFORE any
/// working-tree mutation. See branch_checked_out_elsewhere.
pub(crate) fn ensure_not_checked_out_elsewhere(
    repo: &git2::Repository,
    branch_name: &str,
) -> Result<()> {
    if let Some(path) = branch_checked_out_elsewhere(repo, branch_name) {
        return Err(GitnadoError::OperationFailed(format!(
            "'{}' is already checked out at {}",
            branch_name, path
        )));
    }
    Ok(())
}

/// The one way a HALF-COMPLETED auto-stash checkout is reported.
///
/// `checkout_tree` rewrites the working tree before HEAD moves, so any failure
/// after it leaves the tree at the target commit with the user's changes still
/// in the stash list. Whatever went wrong, the error has to say so — a bare
/// message sends the user to a working tree they do not recognise with no clue
/// that their work is recoverable. Both the checkout failure and the set_head
/// failure route through here so they cannot describe the same situation
/// differently.
fn autostash_failure(
    repo: &mut git2::Repository,
    stashed: bool,
    stash_oid: Option<git2::Oid>,
    msg: &str,
) -> GitnadoError {
    if stashed {
        match auto_stash_index(repo, stash_oid) {
            Some(idx) => {
                if let Err(pop_err) = repo.stash_pop(idx, None) {
                    return GitnadoError::OperationFailed(format!(
                        "Checkout failed: {}. Additionally, failed to restore \
                         stashed changes: {}",
                        msg,
                        pop_err.message()
                    ));
                }
            }
            None => {
                return GitnadoError::OperationFailed(format!(
                    "Checkout failed: {}. Your changes could not be found to \
                     restore — they are still in the stash list, apply them \
                     manually.",
                    msg
                ));
            }
        }
    }
    GitnadoError::OperationFailed(format!("Checkout failed: {}", msg))
}

fn auto_stash_index(repo: &mut git2::Repository, stash_oid: Option<git2::Oid>) -> Option<usize> {
    let expected = stash_oid?;
    let mut found = None;
    let _ = repo.stash_foreach(|idx, _name, oid| {
        if *oid == expected {
            found = Some(idx);
            false
        } else {
            true
        }
    });
    found
}

/// The name of the operation a repository state represents, or None when the
/// repository is Clean. Used to say WHICH operation is in the way.
pub(crate) fn in_progress_operation(state: git2::RepositoryState) -> Option<&'static str> {
    use git2::RepositoryState::*;
    match state {
        Clean => None,
        Merge => Some("merge"),
        Revert | RevertSequence => Some("revert"),
        CherryPick | CherryPickSequence => Some("cherry-pick"),
        Bisect => Some("bisect"),
        Rebase | RebaseInteractive | RebaseMerge => Some("rebase"),
        ApplyMailbox | ApplyMailboxOrRebase => Some("patch application"),
    }
}

pub(crate) fn ensure_checkoutable(repo: &git2::Repository) -> Result<()> {
    let Some(what) = in_progress_operation(repo.state()) else {
        return Ok(());
    };
    Err(GitnadoError::OperationFailed(format!(
        "Cannot switch branches while a {} is in progress. Finish or abort it first.",
        what
    )))
}

#[command]
pub async fn checkout(path: String, ref_name: String, force: Option<bool>) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;
    ensure_checkoutable(&repo)?;
    // BEFORE checkout_tree — see branch_checked_out_elsewhere.
    ensure_not_checked_out_elsewhere(&repo, &ref_name)?;

    // Capture HEAD before the switch so the post-checkout hook receives the
    // correct <old-ref> argument (githooks(5)).
    let old_head = crate::commands::hooks::head_oid_string(&repo);

    let mut checkout_opts = git2::build::CheckoutBuilder::new();
    if force.unwrap_or(false) {
        checkout_opts.force();
    } else {
        checkout_opts.safe();
    }

    // The working tree must always be checked out from the same commit HEAD
    // ends up pointing at, so resolve the effective target ref FIRST. In
    // particular, checking out a remote branch when a same-named local branch
    // already exists must check out the LOCAL branch (like `git checkout`),
    // not the remote tip — otherwise tree and HEAD diverge.
    if let Ok(branch) = repo.find_branch(&ref_name, git2::BranchType::Local) {
        let obj = branch.get().peel(git2::ObjectType::Commit)?;
        repo.checkout_tree(&obj, Some(&mut checkout_opts))?;
        repo.set_head(branch.get().name().map_err(|_| {
            GitnadoError::OperationFailed("Invalid reference name encoding".to_string())
        })?)?;
    } else if let Ok(remote_branch) = repo.find_branch(&ref_name, git2::BranchType::Remote) {
        // Checking out a remote branch - use or create a local tracking branch.
        // Extract the branch name without the remote prefix (e.g., "origin/feature" -> "feature")
        let remote_name = remote_branch
            .get()
            .shorthand()
            .unwrap_or(&ref_name)
            .to_string();

        if let Some(slash_pos) = remote_name.find('/') {
            let local_name = &remote_name[slash_pos + 1..];

            if let Ok(local_branch) = repo.find_branch(local_name, git2::BranchType::Local) {
                // Local branch exists: check out ITS tree, not the remote tip
                let obj = local_branch.get().peel(git2::ObjectType::Commit)?;
                repo.checkout_tree(&obj, Some(&mut checkout_opts))?;
                repo.set_head(local_branch.get().name().map_err(|_| {
                    GitnadoError::OperationFailed("Invalid reference name encoding".to_string())
                })?)?;
            } else {
                // Create new local branch from the remote branch.
                //
                // The ref must exist BEFORE the working tree is rewritten. A
                // failure here (invalid derived name such as "HEAD" from
                // refs/remotes/origin/HEAD, or a D/F conflict against an
                // existing refs/heads/<name>/*) would otherwise return with the
                // tree already holding the remote tip while HEAD still names the
                // old branch — the whole inter-branch diff appears staged and
                // committing writes the other branch's tree onto this one.
                let commit = remote_branch.get().peel_to_commit()?;
                let mut new_branch = repo.branch(local_name, &commit, false)?;

                // Upstream tracking is best-effort: the branch already exists, so
                // a tracking-config failure must not abort the checkout (matches
                // checkout_with_autostash).
                let _ = new_branch.set_upstream(Some(&remote_name));

                let branch_ref = new_branch
                    .get()
                    .name()
                    .map_err(|_| {
                        GitnadoError::OperationFailed("Invalid reference name encoding".to_string())
                    })?
                    .to_string();

                // Roll the new ref back if the tree cannot be written, so a
                // failed checkout leaves no half-created branch behind.
                if let Err(e) = repo.checkout_tree(commit.as_object(), Some(&mut checkout_opts)) {
                    let _ = new_branch.delete();
                    return Err(e.into());
                }

                // Moving HEAD is the LAST thing that can fail, and by then the
                // working tree already holds the remote tip. Returning there
                // left HEAD naming the old branch over the other branch's
                // content: the whole inter-branch diff reads as uncommitted
                // work, and committing it writes the other branch's tree onto
                // this one — the exact corruption creating the ref early is
                // meant to prevent, just one step later. Reachable through a
                // HEAD.lock left by a crashed process or a concurrent git.
                //
                // So put the tree back, then drop the ref, and report the
                // original failure.
                //
                // The restore is `force()`, and has to be: the files to undo
                // now differ from HEAD, so a `safe()` checkout reads them as
                // local modifications and refuses to touch the very files it
                // needs to revert. That is safe here only because the checkout
                // above ran `safe()` and SUCCEEDED — which means no tracked
                // file carried a conflicting local edit, so everything this
                // reverts is content we just wrote ourselves. Untracked files
                // are not touched either way.
                if let Err(e) = repo.set_head(&branch_ref) {
                    let restored = repo
                        .head()
                        .and_then(|h| h.peel_to_commit())
                        .and_then(|prev| {
                            let mut restore = git2::build::CheckoutBuilder::new();
                            restore.force();
                            repo.checkout_tree(prev.as_object(), Some(&mut restore))
                        })
                        .is_ok();
                    let _ = new_branch.delete();

                    if !restored {
                        return Err(GitnadoError::OperationFailed(format!(
                            "Could not switch to {}: {}. The working tree still holds \
                             {}'s content — check it out again to recover.",
                            local_name, e, remote_name
                        )));
                    }
                    return Err(e.into());
                }
            }
        } else {
            // Couldn't parse remote name, detach HEAD
            let commit = remote_branch.get().peel_to_commit()?;
            repo.checkout_tree(commit.as_object(), Some(&mut checkout_opts))?;
            repo.set_head_detached(commit.id())?;
        }
    } else {
        // Not a branch (could be a commit SHA or tag), detach HEAD
        let obj = repo.revparse_single(&ref_name)?;
        let commit = obj.peel_to_commit()?;
        repo.checkout_tree(&obj, Some(&mut checkout_opts))?;
        repo.set_head_detached(commit.id())?;
    }

    // Branch/commit switch complete — run post-checkout (flag=1), non-blocking.
    let new_head = crate::commands::hooks::head_oid_string(&repo);
    crate::commands::hooks::run_post_checkout(&repo, &old_head, &new_head, true);

    Ok(())
}

/// Set the upstream branch for a local branch
#[command]
pub async fn set_upstream_branch(
    path: String,
    branch: String,
    upstream: String,
) -> Result<BranchTrackingInfo> {
    let path_clone = path.clone();
    let branch_clone = branch.clone();

    // Wrap git2 operations in a block so they're dropped before the await
    {
        let repo = git2::Repository::open(Path::new(&path))?;

        let mut local_branch = repo
            .find_branch(&branch, git2::BranchType::Local)
            .map_err(|_| GitnadoError::BranchNotFound(branch.clone()))?;

        // Normalize upstream to shorthand form (e.g., "refs/remotes/origin/main" -> "origin/main")
        let upstream_short = if upstream.starts_with("refs/remotes/") {
            upstream
                .strip_prefix("refs/remotes/")
                .unwrap_or(&upstream)
                .to_string()
        } else {
            upstream.clone()
        };

        // Build the full ref for existence check
        let upstream_ref = format!("refs/remotes/{}", upstream_short);

        // Check if the upstream reference exists
        repo.find_reference(&upstream_ref).map_err(|_| {
            GitnadoError::OperationFailed(format!(
                "Upstream reference not found: {}",
                upstream_short
            ))
        })?;

        // Set the upstream using the shorthand form
        local_branch.set_upstream(Some(&upstream_short))?;
    }

    // Return the updated tracking info
    get_branch_tracking_info(path_clone, branch_clone).await
}

/// Remove the upstream tracking for a local branch
#[command]
pub async fn unset_upstream_branch(path: String, branch: String) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;

    let mut local_branch = repo
        .find_branch(&branch, git2::BranchType::Local)
        .map_err(|_| GitnadoError::BranchNotFound(branch.clone()))?;

    // Remove the upstream (ignore error if no upstream was set)
    let _ = local_branch.set_upstream(None);

    Ok(())
}

/// Get detailed tracking information for a branch
#[command]
pub async fn get_branch_tracking_info(path: String, branch: String) -> Result<BranchTrackingInfo> {
    let repo = git2::Repository::open(Path::new(&path))?;

    let local_branch = repo
        .find_branch(&branch, git2::BranchType::Local)
        .map_err(|_| GitnadoError::BranchNotFound(branch.clone()))?;

    let local_oid = local_branch
        .get()
        .target()
        .ok_or_else(|| GitnadoError::OperationFailed("Branch has no target".to_string()))?;

    // Try to get upstream info
    let upstream_result = local_branch.upstream();

    match upstream_result {
        Ok(upstream_branch) => {
            let upstream_name = upstream_branch
                .name()?
                .map(|s| s.to_string())
                .unwrap_or_default();

            // Parse remote and remote branch from upstream name (e.g., "origin/main")
            let (remote, remote_branch) = if let Some((r, b)) = upstream_name.split_once('/') {
                (Some(r.to_string()), Some(b.to_string()))
            } else {
                (None, Some(upstream_name.clone()))
            };

            // Calculate ahead/behind
            let upstream_oid = upstream_branch.get().target();
            let (ahead, behind) = if let Some(up_oid) = upstream_oid {
                repo.graph_ahead_behind(local_oid, up_oid)
                    .map(|(a, b)| (a as u32, b as u32))
                    .unwrap_or((0, 0))
            } else {
                (0, 0)
            };

            Ok(BranchTrackingInfo {
                local_branch: branch,
                upstream: Some(format!("refs/remotes/{}", upstream_name)),
                ahead,
                behind,
                remote,
                remote_branch,
                is_gone: false,
            })
        }
        Err(e) => {
            // Check if upstream is configured but the remote branch is gone
            let config = repo.config()?;
            let merge_key = format!("branch.{}.merge", branch);
            let remote_key = format!("branch.{}.remote", branch);

            let has_merge = config.get_string(&merge_key).is_ok();
            let remote_name = config.get_string(&remote_key).ok();

            if has_merge && remote_name.is_some() {
                // Upstream is configured but branch is gone
                let remote = remote_name;
                let remote_branch = config
                    .get_string(&merge_key)
                    .ok()
                    .map(|m| m.strip_prefix("refs/heads/").unwrap_or(&m).to_string());

                Ok(BranchTrackingInfo {
                    local_branch: branch,
                    upstream: None,
                    ahead: 0,
                    behind: 0,
                    remote,
                    remote_branch,
                    is_gone: true,
                })
            } else if e.code() == git2::ErrorCode::NotFound {
                // No upstream configured
                Ok(BranchTrackingInfo {
                    local_branch: branch,
                    upstream: None,
                    ahead: 0,
                    behind: 0,
                    remote: None,
                    remote_branch: None,
                    is_gone: false,
                })
            } else {
                Err(e.into())
            }
        }
    }
}

/// Create an orphan branch (a branch with no parent commits)
///
/// Uses `git checkout --orphan <name>` to create a branch that has no history.
/// This is useful for creating documentation branches, GitHub Pages branches, etc.
///
/// `checkout` MUST be true. An orphan branch is not a ref until its first
/// commit, so git cannot create one without switching to it — `false` is
/// refused rather than half-performed. See the body for why.
#[command]
pub async fn create_orphan_branch(path: String, name: String, checkout: bool) -> Result<()> {
    // `git checkout --orphan` is the only way to start an orphan branch, and it
    // ALWAYS switches to it. That is not a limitation of this command: an
    // unborn branch has no ref until its first commit, so there is nothing to
    // create and leave behind.
    //
    // checkout=false used to run `git checkout -` afterwards to switch back,
    // and that never worked — `--orphan` writes no HEAD reflog entry, so
    // `@{-1}` does not resolve and git fails with "pathspec '-' did not match
    // any file(s) known to git". The command returned an error AND left HEAD on
    // the unborn orphan, where repo.head() fails for the whole app: the graph,
    // the branch list and the status panel all go blank — after the user
    // explicitly asked NOT to switch.
    //
    // Refused up front, so the repository is never touched.
    if !checkout {
        return Err(GitnadoError::OperationFailed(
            "An orphan branch has no commits, so it is not a branch until its first commit is \
             made — git cannot create one without switching to it. Check it out, make the first \
             commit, then switch back."
                .to_string(),
        ));
    }

    let mut args = vec!["checkout", "--orphan"];
    let name_ref = name.as_str();
    args.push(name_ref);

    let output = crate::utils::create_command("git")
        .current_dir(&path)
        .args(&args)
        .output()
        .map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to run git checkout --orphan: {}", e))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "Git checkout --orphan failed: {}",
            stderr
        )));
    }

    Ok(())
}

/// Result of checkout with auto-stash
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutWithStashResult {
    /// Whether checkout was successful
    pub success: bool,
    /// Whether changes were stashed
    pub stashed: bool,
    /// Whether stash was applied back
    pub stash_applied: bool,
    /// Whether stash apply had conflicts
    pub stash_conflict: bool,
    /// The auto-stash's oid, when one was created and still exists.
    ///
    /// The conflict flow has to drop this entry once the user resolves, and it
    /// used to find it by position: every frontend caller passed
    /// `stashIndex: 0`. `git stash push` prepends, so a stash created by
    /// another surface or a terminal renumbers the entry and the conflict
    /// dialog would drop the wrong one. This function resolves its own stash by
    /// oid; carrying the oid across the boundary lets the dialog do the same
    /// instead of trusting a position the backend has stopped trusting.
    pub stash_oid: Option<String>,
    /// Message describing what happened
    pub message: String,
}

/// Delete a local branch created by an in-progress checkout that then failed.
///
/// Best effort: the caller is already returning an error the user needs to see,
/// and a failure to clean up must not replace it.
fn rollback_created_branch(repo: &git2::Repository, name: Option<&str>) {
    if let Some(name) = name {
        if let Ok(mut branch) = repo.find_branch(name, git2::BranchType::Local) {
            let _ = branch.delete();
        }
    }
}

/// Checkout a branch with automatic stash handling
/// 1. If there are uncommitted changes, stash them
/// 2. Perform the checkout
/// 3. Try to apply the stash
/// 4. Return status including any conflicts
#[command]
/// `auto_stash` honours the "Auto-Stash on Checkout" setting. When false the
/// checkout is attempted as-is, so git refuses one that would overwrite local
/// changes instead of silently stashing and popping behind the user's back.
/// Absent keeps the previous always-stash behaviour.
pub async fn checkout_with_autostash(
    path: String,
    ref_name: String,
    auto_stash: Option<bool>,
) -> Result<CheckoutWithStashResult> {
    let mut repo = git2::Repository::open(Path::new(&path))?;
    ensure_checkoutable(&repo)?;
    // BEFORE the stash and BEFORE checkout_tree. Refusing later meant the tree
    // was already rewritten and the auto-stash could not be popped back over
    // the staged entries checkout_tree had left.
    ensure_not_checked_out_elsewhere(&repo, &ref_name)?;

    // Capture HEAD before the switch for the post-checkout hook's <old-ref>.
    let old_head = crate::commands::hooks::head_oid_string(&repo);

    // Check if there are uncommitted changes
    let has_changes = auto_stash.unwrap_or(true) && {
        let statuses = repo.statuses(None)?;
        statuses.iter().any(|s| {
            let flags = s.status();
            flags.intersects(
                git2::Status::WT_MODIFIED
                    | git2::Status::WT_NEW
                    | git2::Status::WT_DELETED
                    | git2::Status::WT_RENAMED
                    | git2::Status::WT_TYPECHANGE
                    | git2::Status::INDEX_MODIFIED
                    | git2::Status::INDEX_NEW
                    | git2::Status::INDEX_DELETED
                    | git2::Status::INDEX_RENAMED
                    | git2::Status::INDEX_TYPECHANGE,
            )
        })
    }; // statuses is dropped here

    let mut stashed = false;
    let mut stash_oid: Option<git2::Oid> = None;

    // If there are changes, stash them
    if has_changes {
        let sig = repo.signature()?;
        let stash_message = format!("Auto-stash before checkout to {}", ref_name);

        match repo.stash_save(
            &sig,
            &stash_message,
            Some(git2::StashFlags::INCLUDE_UNTRACKED),
        ) {
            Ok(oid) => {
                stashed = true;
                stash_oid = Some(oid);
            }
            Err(e) => {
                return Ok(CheckoutWithStashResult {
                    success: false,
                    stashed: false,
                    stash_applied: false,
                    stash_conflict: false,
                    stash_oid: stash_oid.map(|o| o.to_string()),
                    message: format!("Failed to stash changes: {}", e.message()),
                });
            }
        }
    }

    // Get target commit OID for checkout. Errors are produced as closure
    // values (NOT early function returns) so the map_err below actually runs
    // and restores the auto-stash on failure.
    let resolve_result: std::result::Result<(git2::Oid, bool, bool), String> = (|| {
        let is_local = repo.find_branch(&ref_name, git2::BranchType::Local).is_ok();
        let is_remote = !is_local
            && (repo
                .find_branch(&ref_name, git2::BranchType::Remote)
                .is_ok()
                || repo
                    .find_reference(&format!("refs/remotes/{}", ref_name))
                    .is_ok());

        // The working tree must be checked out from the commit HEAD ends up
        // pointing at. A remote branch whose same-named local branch already
        // exists checks out the LOCAL branch tip (mirrors `git checkout`),
        // not the remote tip — otherwise tree and HEAD diverge.
        if is_remote {
            let local_name = ref_name
                .find('/')
                .map(|pos| &ref_name[pos + 1..])
                .unwrap_or(ref_name.as_str());
            if let Ok(local) = repo.find_branch(local_name, git2::BranchType::Local) {
                let commit = local
                    .get()
                    .peel_to_commit()
                    .map_err(|e| format!("Could not resolve commit: {}", e.message()))?;
                return Ok((commit.id(), is_local, is_remote));
            }
        }

        let obj = repo
            .revparse_single(&ref_name)
            .map_err(|e| format!("Could not find ref '{}': {}", ref_name, e.message()))?;
        let commit = obj
            .peel_to_commit()
            .map_err(|e| format!("Could not resolve commit: {}", e.message()))?;
        Ok((commit.id(), is_local, is_remote))
    })();

    let (target_oid, is_local_branch, is_remote_branch) = match resolve_result {
        Ok(v) => v,
        Err(msg) => {
            // Restore the stash if the checkout target failed to resolve.
            // Resolved by oid, not popped positionally: a stash created by
            // another surface or a terminal in the meantime sits at index 0 and
            // would be applied and destroyed in place of the auto-stash. The
            // checkout-failure path below has always verified the oid; this one
            // did not. Best effort — a failure to restore must not mask the
            // resolution error the user actually needs to see.
            //
            // A failure to restore must not MASK the resolution error the user
            // needs to see — but not masking and not mentioning are different
            // things. The sibling arm below concatenates both; this one
            // discarded the restore's outcome, so the user was told only
            // "could not find ref" while looking at an empty working tree with
            // no hint that their changes were sitting in the stash list.
            let restore_note = if stashed {
                match auto_stash_index(&mut repo, stash_oid) {
                    Some(idx) => match repo.stash_pop(idx, None) {
                        Ok(()) => "",
                        Err(_) => {
                            " Your changes could not be restored — they are still in \
                             the stash list, apply them manually."
                        }
                    },
                    None => {
                        " Your changes could not be found to restore — they are still \
                         in the stash list, apply them manually."
                    }
                }
            } else {
                ""
            };
            return Err(GitnadoError::OperationFailed(format!(
                "{}{}",
                msg, restore_note
            )));
        }
    };

    // Routed through autostash_failure like every other exit past the stash.
    //
    // This was the ONE that abandoned the user's work silently: a bare
    // "Could not find object" with the whole working tree gone and nothing
    // saying it was in the stash list. The comment here claimed a borrow
    // prevented the restore; `repo` is already &mut and autostash_failure
    // takes &mut, so it does not. Resolved before the borrow below begins.
    let find_error: Option<String> = match repo.find_object(target_oid, None) {
        Ok(_) => None,
        Err(e) => Some(format!("Could not find object: {}", e.message())),
    };
    if let Some(msg) = find_error {
        return Err(autostash_failure(&mut repo, stashed, stash_oid, &msg));
    }

    // Create the local tracking branch BEFORE the working tree is rewritten.
    //
    // Creating it inside the set_head closure below put it AFTER checkout_tree,
    // so a failure (invalid derived name such as "HEAD", or a D/F conflict
    // against an existing refs/heads/<name>/*) reached autostash_failure with
    // the tree already at the target commit — popping the auto-stash over the
    // wrong tree while HEAD still named the old branch. Failing here leaves the
    // working tree untouched, so the restore lands on the tree it came from.
    // Records a branch created by THIS call, so a later failure can roll it back
    // the way checkout() does. Without it a failing checkout_tree left the new
    // tracking branch behind, making a failed checkout non-transactional.
    let mut created_branch: Option<String> = None;

    if is_remote_branch {
        let local_name = if let Some(pos) = ref_name.find('/') {
            &ref_name[pos + 1..]
        } else {
            ref_name.as_str()
        };

        if repo
            .find_branch(local_name, git2::BranchType::Local)
            .is_err()
        {
            let create_error: Option<String> = match repo.find_commit(target_oid) {
                Ok(commit) => match repo.branch(local_name, &commit, false) {
                    Ok(mut new_branch) => {
                        // Best effort: tracking config must not abort the checkout.
                        let _ = new_branch.set_upstream(Some(&ref_name));
                        created_branch = Some(local_name.to_string());
                        None
                    }
                    Err(e) => Some(format!(
                        "Could not create local branch '{}': {}",
                        local_name,
                        e.message()
                    )),
                },
                Err(e) => Some(format!("Could not find object: {}", e.message())),
            };

            if let Some(msg) = create_error {
                return Err(autostash_failure(&mut repo, stashed, stash_oid, &msg));
            }
        }
    }

    // Perform checkout using the OID
    let checkout_error: Option<String> = {
        let obj = repo.find_object(target_oid, None)?;
        let mut checkout_opts = git2::build::CheckoutBuilder::new();
        checkout_opts.safe();

        match repo.checkout_tree(&obj, Some(&mut checkout_opts)) {
            Ok(()) => None,
            Err(e) => Some(e.message().to_string()),
        }
    }; // obj dropped here

    if let Some(msg) = checkout_error {
        // Roll back a branch this call created. The checkout failed, so the ref
        // must not outlive it — otherwise a retry sees a branch that already
        // exists and silently takes the "local branch exists" path instead.
        rollback_created_branch(&repo, created_branch.as_deref());

        // Restore the auto-stash now the checkout has failed.
        //
        // Resolved by oid rather than verified at index 0: `git stash push`
        // prepends, so a stash created during the (multi-second) checkout
        // pushes ours down a slot. The old check only compared against index 0,
        // so it declined to restore and returned a bare "Checkout failed" —
        // leaving the user with an empty working tree, their changes in the
        // stash list, and nothing on screen saying so.
        return Err(autostash_failure(&mut repo, stashed, stash_oid, &msg));
    }

    // Set HEAD.
    //
    // Propagated, not swallowed. checkout_tree above has ALREADY rewritten the
    // working tree to the target commit, so skipping set_head leaves HEAD and
    // the working tree describing different commits — and this function went
    // on to return success: true, so the UI toasted "Switched to <branch>" and
    // the user was left on the old branch with the whole inter-branch diff
    // showing as uncommitted modifications. `if let Ok(..)` made that the
    // outcome whenever the branch was deleted from a terminal during the
    // checkout. The plain `checkout` command has always used `?` here.
    let set_head_result = (|| -> Result<()> {
        if is_local_branch {
            let branch = repo.find_branch(&ref_name, git2::BranchType::Local)?;
            repo.set_head(branch.get().name().map_err(|_| {
                GitnadoError::OperationFailed("Invalid reference name encoding".to_string())
            })?)?;
        } else if is_remote_branch {
            // Check out a remote branch by finding or creating a local tracking branch.
            // e.g., "origin/feature-x" → local branch "feature-x" tracking "origin/feature-x"
            let local_name = if let Some(pos) = ref_name.find('/') {
                &ref_name[pos + 1..]
            } else {
                &ref_name
            };

            // Use existing local branch if it exists, otherwise create one
            let local_branch =
                if let Ok(existing) = repo.find_branch(local_name, git2::BranchType::Local) {
                    existing
                } else {
                    let commit = repo.find_commit(target_oid)?;
                    let mut new_branch = repo.branch(local_name, &commit, false)?;
                    // Best effort: set upstream tracking (may fail if remote config is incomplete)
                    let _ = new_branch.set_upstream(Some(&ref_name));
                    new_branch
                };

            let name = local_branch.get().name().map_err(|_| {
                GitnadoError::OperationFailed("Invalid reference name encoding".to_string())
            })?;
            repo.set_head(name)?;
        } else {
            repo.set_head_detached(target_oid)?;
        }
        Ok(())
    })();

    // Routed through the SAME restore path a failed checkout_tree takes.
    // Propagating alone still left the auto-stash orphaned and unmentioned:
    // the tree is at the target commit, HEAD is not, and the raw set_head
    // error says nothing about where the user's changes went.
    if let Err(err) = set_head_result {
        rollback_created_branch(&repo, created_branch.as_deref());
        return Err(autostash_failure(
            &mut repo,
            stashed,
            stash_oid,
            &err.to_string(),
        ));
    }

    // HEAD/working tree switched — run post-checkout (flag=1), non-blocking.
    // Runs before the stash re-apply so it fires even if re-applying conflicts.
    let new_head = crate::commands::hooks::head_oid_string(&repo);
    crate::commands::hooks::run_post_checkout(&repo, &old_head, &new_head, true);

    // If we stashed, try to re-apply the stash.
    if stashed {
        // Use stash_APPLY (not stash_pop): the stash must survive until we KNOW
        // the changes landed cleanly. git2's stash_pop is unsafe here in two
        // empirically-verified ways:
        //   - an UNSTAGED conflicting change makes apply return Ok while leaving
        //     a conflicted index; stash_pop would then DROP the stash, destroying
        //     the user's only copy of their work.
        //   - a STAGED conflicting change makes apply fail with ECONFLICT.
        // So we apply, then inspect the index ourselves and only drop the stash
        // when it is genuinely clean.
        //
        // Reinstate the index so files the user had staged before the checkout
        // come back staged instead of silently becoming unstaged.
        let mut stash_apply_opts = git2::StashApplyOptions::new();
        stash_apply_opts.reinstantiate_index();
        let mut checkout_opts = git2::build::CheckoutBuilder::new();
        checkout_opts.safe();
        stash_apply_opts.checkout_options(checkout_opts);

        let conflict_message = format!(
            "Switched to {} but re-applying your stashed changes produced conflicts. \
             Resolve them, then the stash will be dropped.",
            ref_name
        );

        // Resolved by OID, not assumed to be 0 — see auto_stash_index.
        let stash_idx = match auto_stash_index(&mut repo, stash_oid) {
            Some(idx) => idx,
            None => {
                return Ok(CheckoutWithStashResult {
                    success: true,
                    stashed: true,
                    stash_applied: false,
                    stash_conflict: false,
                    stash_oid: stash_oid.map(|o| o.to_string()),
                    message: format!(
                        "Switched to {}, but your stashed changes could not be found to \
                         re-apply. They are still in the stash list — apply them manually.",
                        ref_name
                    ),
                });
            }
        };

        match repo.stash_apply(stash_idx, Some(&mut stash_apply_opts)) {
            Ok(()) => {
                // Apply reported success, but an unstaged conflicting change can
                // land conflicts in the index while still returning Ok. Only drop
                // the stash when the index is truly conflict-free.
                if repo.index()?.has_conflicts() {
                    return Ok(CheckoutWithStashResult {
                        success: true,
                        stashed: true,
                        stash_applied: false,
                        stash_conflict: true,
                        stash_oid: stash_oid.map(|o| o.to_string()),
                        message: conflict_message,
                    });
                }
                repo.stash_drop(stash_idx)?;
                return Ok(CheckoutWithStashResult {
                    success: true,
                    stashed: true,
                    stash_applied: true,
                    stash_conflict: false,
                    stash_oid: stash_oid.map(|o| o.to_string()),
                    message: format!("Switched to {} and re-applied stashed changes", ref_name),
                });
            }
            Err(e) => {
                // git2 signals a stash-apply conflict as either MergeConflict
                // (index-level) or Conflict (checkout-level, often with an empty
                // message), so match both.
                let has_conflicts = e.code() == git2::ErrorCode::MergeConflict
                    || e.code() == git2::ErrorCode::Conflict
                    || e.message().contains("conflict")
                    || e.message().contains("CONFLICT");

                if has_conflicts {
                    // A staged conflicting change fails the reinstate-index apply.
                    // Retry WITHOUT reinstating the index: applied unstaged-style,
                    // the conflict lands in the index (mirroring `git stash apply`)
                    // where the conflict-resolution flow can pick it up. The stash
                    // is kept for that flow to drop after resolution.
                    let mut retry_opts = git2::StashApplyOptions::new();
                    let mut retry_checkout = git2::build::CheckoutBuilder::new();
                    retry_checkout.safe();
                    retry_opts.checkout_options(retry_checkout);

                    // Re-resolved: the failed apply above may itself have
                    // changed the stash list. A missing entry must produce the
                    // same refusal the initial resolve gives — falling back to
                    // the earlier position would apply and drop whatever now
                    // occupies it, which is the exact bug auto_stash_index
                    // exists to close.
                    let retry_idx = match auto_stash_index(&mut repo, stash_oid) {
                        Some(idx) => idx,
                        None => {
                            return Ok(CheckoutWithStashResult {
                                success: true,
                                stashed: true,
                                stash_applied: false,
                                stash_conflict: false,
                                stash_oid: stash_oid.map(|o| o.to_string()),
                                message: format!(
                                    "Switched to {}, but your stashed changes could not be \
                                     found to re-apply. They are still in the stash list — \
                                     apply them manually.",
                                    ref_name
                                ),
                            });
                        }
                    };
                    if repo.stash_apply(retry_idx, Some(&mut retry_opts)).is_ok() {
                        if repo.index()?.has_conflicts() {
                            return Ok(CheckoutWithStashResult {
                                success: true,
                                stashed: true,
                                stash_applied: false,
                                stash_conflict: true,
                                stash_oid: stash_oid.map(|o| o.to_string()),
                                message: conflict_message,
                            });
                        }
                        // The retry applied cleanly (no conflicts). The stashed
                        // changes ARE now in the working tree, so the stash must be
                        // dropped — otherwise it lingers and a later apply/pop would
                        // duplicate or conflict with the already-applied changes.
                        // The staged status could not be reinstated on this path, so
                        // note that in the message.
                        repo.stash_drop(retry_idx)?;
                        return Ok(CheckoutWithStashResult {
                            success: true,
                            stashed: true,
                            stash_applied: true,
                            stash_conflict: false,
                            stash_oid: stash_oid.map(|o| o.to_string()),
                            message: format!(
                                "Switched to {} and re-applied stashed changes (staged status was not preserved)",
                                ref_name
                            ),
                        });
                    }
                }

                // Could not re-apply — the stash remains in the list untouched.
                return Ok(CheckoutWithStashResult {
                    success: true,
                    stashed: true,
                    stash_applied: false,
                    stash_conflict: false,
                    stash_oid: stash_oid.map(|o| o.to_string()),
                    message: format!(
                        "Switched to {} but failed to re-apply stash: {}. Your changes remain stashed.",
                        ref_name,
                        e.message()
                    ),
                });
            }
        }
    }

    Ok(CheckoutWithStashResult {
        success: true,
        stashed: false,
        stash_applied: false,
        stash_conflict: false,
        stash_oid: stash_oid.map(|o| o.to_string()),
        message: format!("Switched to {}", ref_name),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    /// refs/remotes/origin/HEAD is a pointer at the remote's default branch,
    /// not a branch of its own.
    ///
    /// Every clone has it. Listing it gave the UI a row named "origin/HEAD"
    /// with an empty target oid and no timestamp (a symbolic ref has no direct
    /// target), and checking that row out derived the local branch name "HEAD",
    /// which libgit2 rejects as an invalid branch name. `git branch -r` renders
    /// it as "origin/HEAD -> origin/main" and never offers it for checkout.
    #[tokio::test]
    async fn test_get_branches_omits_the_remote_symbolic_head() {
        let test_repo = TestRepo::with_initial_commit();
        let default_branch = test_repo.current_branch();

        {
            let repo = test_repo.repo();
            let head_commit = repo.head().unwrap().peel_to_commit().unwrap();

            // A real remote-tracking branch, plus the symbolic HEAD pointer a
            // clone would create alongside it.
            repo.reference(
                &format!("refs/remotes/origin/{}", default_branch),
                head_commit.id(),
                true,
                "test remote branch",
            )
            .unwrap();
            repo.reference_symbolic(
                "refs/remotes/origin/HEAD",
                &format!("refs/remotes/origin/{}", default_branch),
                true,
                "test remote head",
            )
            .unwrap();
        }

        let branches = get_branches(test_repo.path_str()).await.unwrap();

        assert!(
            !branches.iter().any(|b| b.name == "origin/HEAD"),
            "origin/HEAD must not be offered as a checkoutable branch: {:?}",
            branches.iter().map(|b| &b.name).collect::<Vec<_>>()
        );

        // The branch it points at is still listed.
        assert!(
            branches
                .iter()
                .any(|b| b.name == format!("origin/{}", default_branch)),
            "the real remote branch must still be listed"
        );

        // Nothing else lost a target oid along the way.
        assert!(
            branches.iter().all(|b| !b.target_oid.is_empty()),
            "every listed branch should resolve to a commit"
        );
    }

    #[tokio::test]
    async fn test_get_branches_empty_repo() {
        let repo = TestRepo::new();
        // Empty repo has no branches until first commit
        let result = get_branches(repo.path_str()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_get_branches_with_initial_commit() {
        let repo = TestRepo::with_initial_commit();
        let result = get_branches(repo.path_str()).await;
        assert!(result.is_ok());
        let branches = result.unwrap();
        assert_eq!(branches.len(), 1);
        // Default branch name may vary (main, master, etc.)
        assert!(branches[0].is_head);
        assert!(!branches[0].is_remote);
    }

    #[tokio::test]
    async fn test_get_branches_multiple() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("feature-1");
        repo.create_branch("feature-2");

        let result = get_branches(repo.path_str()).await;
        assert!(result.is_ok());
        let branches = result.unwrap();
        assert_eq!(branches.len(), 3); // main + 2 features
    }

    #[tokio::test]
    async fn test_create_branch() {
        let repo = TestRepo::with_initial_commit();
        let result = create_branch(
            repo.path_str(),
            "new-feature".to_string(),
            None,
            Some(false),
        )
        .await;

        assert!(result.is_ok());
        let branch = result.unwrap();
        assert_eq!(branch.name, "new-feature");
        assert!(!branch.is_head); // checkout was false
        assert!(!branch.is_remote);
    }

    #[tokio::test]
    async fn test_create_branch_and_checkout() {
        let repo = TestRepo::with_initial_commit();
        let result =
            create_branch(repo.path_str(), "new-feature".to_string(), None, Some(true)).await;

        assert!(result.is_ok());
        let branch = result.unwrap();
        assert_eq!(branch.name, "new-feature");
        assert!(branch.is_head); // checkout was true
    }

    /// Put `repo` into a paused interactive rebase, the way an `edit` line
    /// leaves it: state on disk, HEAD detached, working tree clean. Nothing is
    /// modal on screen in this state, so every branch-switching surface stays
    /// live.
    fn pause_an_interactive_rebase(repo: &TestRepo) {
        let git = repo.repo();
        let head = git.head().unwrap().peel_to_commit().unwrap();
        std::fs::create_dir_all(repo.path.join(".git/rebase-merge")).unwrap();
        std::fs::write(repo.path.join(".git/rebase-merge/interactive"), "").unwrap();
        std::fs::write(
            repo.path.join(".git/rebase-merge/head-name"),
            "refs/heads/main\n",
        )
        .unwrap();
        std::fs::write(
            repo.path.join(".git/rebase-merge/onto"),
            format!("{}\n", head.id()),
        )
        .unwrap();
        assert_ne!(
            repo.repo().state(),
            git2::RepositoryState::Clean,
            "the fixture must actually put the repo mid-rebase"
        );
    }

    #[tokio::test]
    async fn test_ensure_checkoutable_refuses_mid_rebase() {
        let repo = TestRepo::with_initial_commit();
        pause_an_interactive_rebase(&repo);

        let err = checkout(repo.path_str(), "main".to_string(), None)
            .await
            .expect_err("checkout must refuse while a rebase is in progress");
        assert!(
            err.to_string().contains("rebase is in progress"),
            "unexpected error: {}",
            err
        );
    }

    #[tokio::test]
    async fn test_create_branch_with_checkout_refuses_mid_rebase() {
        // "Checkout new branch after creation" is the dialog default, so this
        // switched branches without being called checkout — orphaning the
        // rebase state on disk. The still-visible Abort would then yank the
        // user back to the original branch, discarding the new branch's work.
        let repo = TestRepo::with_initial_commit();
        let head_before = repo.repo().head().unwrap().target();
        pause_an_interactive_rebase(&repo);

        let err = create_branch(repo.path_str(), "escape".to_string(), None, Some(true))
            .await
            .expect_err("create+checkout must refuse while a rebase is in progress");
        assert!(
            err.to_string().contains("rebase is in progress"),
            "unexpected error: {}",
            err
        );
        assert!(
            repo.repo()
                .find_branch("escape", git2::BranchType::Local)
                .is_err(),
            "a refusal must not leave the branch behind"
        );
        assert_eq!(repo.repo().head().unwrap().target(), head_before);
    }

    #[tokio::test]
    async fn test_create_branch_without_checkout_is_allowed_mid_rebase() {
        // Creating a ref does not switch branches, so it must stay available.
        let repo = TestRepo::with_initial_commit();
        pause_an_interactive_rebase(&repo);

        create_branch(repo.path_str(), "bookmark".to_string(), None, Some(false))
            .await
            .expect("creating a ref mid-rebase is not a branch switch");
        assert!(repo
            .repo()
            .find_branch("bookmark", git2::BranchType::Local)
            .is_ok());
    }

    #[tokio::test]
    async fn test_create_branch_rolls_back_when_the_checkout_fails() {
        // A dirty file that differs between HEAD and the start point makes the
        // SAFE checkout conflict. The ref already exists by then; without a
        // rollback the dialog showed an error while the sidebar grew the
        // branch, and a retry dead-ended on "already exists".
        let repo = TestRepo::with_initial_commit();
        let initial = repo.head_oid();
        repo.create_commit("second", &[("conflicted.txt", "from HEAD\n")]);
        // Uncommitted content that differs from BOTH sides.
        repo.create_file("conflicted.txt", "my unsaved work\n");

        let result = create_branch(
            repo.path_str(),
            "from-initial".to_string(),
            Some(initial.to_string()),
            Some(true),
        )
        .await;

        if result.is_err() {
            assert!(
                repo.repo()
                    .find_branch("from-initial", git2::BranchType::Local)
                    .is_err(),
                "a failed create+checkout must not leave the ref behind"
            );
        }
        // The uncommitted work survives either way.
        assert_eq!(
            std::fs::read_to_string(repo.path.join("conflicted.txt")).unwrap(),
            "my unsaved work\n"
        );
    }

    #[tokio::test]
    async fn test_create_branch_from_commit() {
        let repo = TestRepo::with_initial_commit();
        let initial_oid = repo.head_oid();
        repo.create_commit("Second commit", &[("file2.txt", "content2")]);

        let result = create_branch(
            repo.path_str(),
            "from-initial".to_string(),
            Some(initial_oid.to_string()),
            Some(false),
        )
        .await;

        assert!(result.is_ok());
        let branch = result.unwrap();
        assert_eq!(branch.target_oid, initial_oid.to_string());
    }

    #[tokio::test]
    async fn test_create_branch_duplicate_fails() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("existing");

        let result =
            create_branch(repo.path_str(), "existing".to_string(), None, Some(false)).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_delete_branch() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("to-delete");

        let result = delete_branch(repo.path_str(), "to-delete".to_string(), Some(true)).await;
        assert!(result.is_ok());

        // Verify branch is gone
        let git_repo = repo.repo();
        let branch = git_repo.find_branch("to-delete", git2::BranchType::Local);
        assert!(branch.is_err());
    }

    // A branch pointing at the same commit as HEAD is fully merged, so a
    // non-force delete must succeed (matching `git branch -d`).
    #[tokio::test]
    async fn test_delete_branch_at_head_non_force_succeeds() {
        let repo = TestRepo::with_initial_commit();
        // Branch created at HEAD points to the same commit as HEAD.
        repo.create_branch("at-head");

        let result = delete_branch(repo.path_str(), "at-head".to_string(), Some(false)).await;
        assert!(
            result.is_ok(),
            "deleting a branch at HEAD should succeed without force"
        );

        let git_repo = repo.repo();
        assert!(git_repo
            .find_branch("at-head", git2::BranchType::Local)
            .is_err());
    }

    /// A preventDeletion rule must be enforced by the COMMAND, not only by the
    /// cleanup dialog's listing — the sidebar and graph ref menu call
    /// delete_branch directly and never load the rules.
    #[tokio::test]
    async fn test_delete_branch_refuses_protected_branch() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("release/v1");

        crate::commands::branch_rules::set_branch_rule(
            repo.path_str(),
            crate::commands::branch_rules::BranchRule {
                pattern: "release/*".to_string(),
                prevent_deletion: true,
                prevent_force_push: false,
                require_pull_request: false,
                prevent_direct_push: false,
            },
        )
        .await
        .unwrap();

        let result = delete_branch(repo.path_str(), "release/v1".to_string(), Some(false)).await;
        assert!(result.is_err(), "protected branch must not be deleted");
        assert!(result.unwrap_err().to_string().contains("protected"));

        let git_repo = repo.repo();
        assert!(
            git_repo
                .find_branch("release/v1", git2::BranchType::Local)
                .is_ok(),
            "branch must still exist"
        );
    }

    /// Force must not be an escape hatch around an explicit protection rule.
    #[tokio::test]
    async fn test_delete_branch_force_cannot_bypass_protection() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("protected-branch");

        crate::commands::branch_rules::set_branch_rule(
            repo.path_str(),
            crate::commands::branch_rules::BranchRule {
                pattern: "protected-branch".to_string(),
                prevent_deletion: true,
                prevent_force_push: false,
                require_pull_request: false,
                prevent_direct_push: false,
            },
        )
        .await
        .unwrap();

        let result =
            delete_branch(repo.path_str(), "protected-branch".to_string(), Some(true)).await;
        assert!(result.is_err(), "force must not bypass a protection rule");

        let git_repo = repo.repo();
        assert!(git_repo
            .find_branch("protected-branch", git2::BranchType::Local)
            .is_ok());
    }

    /// An unrelated branch must be unaffected by a rule that does not match it.
    #[tokio::test]
    async fn test_delete_branch_allows_unmatched_branch() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("feature/x");

        crate::commands::branch_rules::set_branch_rule(
            repo.path_str(),
            crate::commands::branch_rules::BranchRule {
                pattern: "release/*".to_string(),
                prevent_deletion: true,
                prevent_force_push: false,
                require_pull_request: false,
                prevent_direct_push: false,
            },
        )
        .await
        .unwrap();

        let result = delete_branch(repo.path_str(), "feature/x".to_string(), Some(true)).await;
        assert!(result.is_ok(), "non-matching branch must still delete");
    }

    #[tokio::test]
    async fn test_delete_branch_not_found() {
        let repo = TestRepo::with_initial_commit();
        let result = delete_branch(repo.path_str(), "nonexistent".to_string(), Some(true)).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_delete_current_branch_fails() {
        let repo = TestRepo::with_initial_commit();
        let current = repo.current_branch();

        let result = delete_branch(repo.path_str(), current, Some(true)).await;
        // Should fail because you can't delete the checked out branch
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_rename_branch() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("old-name");

        let result = rename_branch(
            repo.path_str(),
            "old-name".to_string(),
            "new-name".to_string(),
            None,
        )
        .await;

        assert!(result.is_ok());
        let branch = result.unwrap();
        assert_eq!(branch.name, "new-name");

        // Verify old name is gone
        let git_repo = repo.repo();
        let old_branch = git_repo.find_branch("old-name", git2::BranchType::Local);
        assert!(old_branch.is_err());
    }

    #[tokio::test]
    async fn test_rename_branch_not_found() {
        let repo = TestRepo::with_initial_commit();
        let result = rename_branch(
            repo.path_str(),
            "nonexistent".to_string(),
            "new-name".to_string(),
            None,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_rename_branch_with_update_tracking_false() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("old-name");

        let result = rename_branch(
            repo.path_str(),
            "old-name".to_string(),
            "new-name".to_string(),
            Some(false),
        )
        .await;

        assert!(result.is_ok());
        let branch = result.unwrap();
        assert_eq!(branch.name, "new-name");
    }

    #[tokio::test]
    async fn test_rename_branch_with_update_tracking_true() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("old-name");

        let result = rename_branch(
            repo.path_str(),
            "old-name".to_string(),
            "new-name".to_string(),
            Some(true),
        )
        .await;

        assert!(result.is_ok());
        let branch = result.unwrap();
        assert_eq!(branch.name, "new-name");
    }

    #[tokio::test]
    async fn test_checkout_branch() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("feature");

        let result = checkout(repo.path_str(), "feature".to_string(), Some(false)).await;
        assert!(result.is_ok());
        assert_eq!(repo.current_branch(), "feature");
    }

    #[tokio::test]
    async fn test_checkout_commit_detached() {
        let repo = TestRepo::with_initial_commit();
        let oid = repo.head_oid();
        repo.create_commit("Second", &[("file.txt", "content")]);

        let result = checkout(repo.path_str(), oid.to_string(), Some(false)).await;
        assert!(result.is_ok());

        // HEAD should be detached
        let git_repo = repo.repo();
        assert!(git_repo.head_detached().unwrap());
    }

    #[tokio::test]
    async fn test_checkout_nonexistent_fails() {
        let repo = TestRepo::with_initial_commit();
        let result = checkout(repo.path_str(), "nonexistent".to_string(), Some(false)).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_checkout_force() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("feature");

        // Create uncommitted changes
        repo.create_file("uncommitted.txt", "changes");

        // Force checkout should work
        let result = checkout(repo.path_str(), "feature".to_string(), Some(true)).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_branch_with_slash_in_name() {
        let repo = TestRepo::with_initial_commit();
        let result = create_branch(
            repo.path_str(),
            "feature/my-feature".to_string(),
            None,
            Some(false),
        )
        .await;

        assert!(result.is_ok());
        let branch = result.unwrap();
        assert_eq!(branch.name, "feature/my-feature");
        assert_eq!(branch.shorthand, "feature/my-feature");
    }

    #[tokio::test]
    async fn test_get_branch_tracking_info_no_upstream() {
        let repo = TestRepo::with_initial_commit();
        let current = repo.current_branch();

        let result = get_branch_tracking_info(repo.path_str(), current.clone()).await;
        assert!(result.is_ok());

        let info = result.unwrap();
        assert_eq!(info.local_branch, current);
        assert!(info.upstream.is_none());
        assert_eq!(info.ahead, 0);
        assert_eq!(info.behind, 0);
        assert!(info.remote.is_none());
        assert!(info.remote_branch.is_none());
        assert!(!info.is_gone);
    }

    #[tokio::test]
    async fn test_get_branch_tracking_info_branch_not_found() {
        let repo = TestRepo::with_initial_commit();

        let result = get_branch_tracking_info(repo.path_str(), "nonexistent".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_set_upstream_branch_not_found() {
        let repo = TestRepo::with_initial_commit();
        let current = repo.current_branch();

        // Try to set upstream to a nonexistent remote branch
        let result = set_upstream_branch(repo.path_str(), current, "origin/main".to_string()).await;

        // Should fail because the upstream ref doesn't exist
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_unset_upstream_branch_no_upstream() {
        let repo = TestRepo::with_initial_commit();
        let current = repo.current_branch();

        // Unsetting upstream when none is set should succeed (no-op)
        let result = unset_upstream_branch(repo.path_str(), current).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_unset_upstream_branch_not_found() {
        let repo = TestRepo::with_initial_commit();

        let result = unset_upstream_branch(repo.path_str(), "nonexistent".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_set_upstream_branch_local_branch_not_found() {
        let repo = TestRepo::with_initial_commit();

        let result = set_upstream_branch(
            repo.path_str(),
            "nonexistent".to_string(),
            "origin/main".to_string(),
        )
        .await;

        assert!(result.is_err());
    }

    /// Creating the local branch must happen BEFORE the working tree is
    /// rewritten.
    ///
    /// With the old ordering, checkout_tree ran first and a failing
    /// `repo.branch(..)` returned an error having already written the remote
    /// tip into the tree and index while HEAD still named the old branch: the
    /// entire inter-branch diff showed up staged, and committing recorded the
    /// other branch's tree onto the current one. A D/F conflict reaches that
    /// failure — refs/heads/feature cannot be created while refs/heads/feature/sub
    /// exists — as does the "HEAD" name derived from refs/remotes/origin/HEAD.
    #[tokio::test]
    async fn test_failed_remote_checkout_leaves_tree_and_head_untouched() {
        let test_repo = TestRepo::with_initial_commit();
        let original_branch = test_repo.current_branch();

        // A commit that only exists on the "remote" branch, so a rewritten
        // working tree is detectable by remote-only.txt appearing on disk.
        test_repo.create_branch("staging-for-remote");
        test_repo.checkout_branch("staging-for-remote");
        let remote_tip =
            test_repo.create_commit("Remote only", &[("remote-only.txt", "remote content")]);
        test_repo.checkout_branch(&original_branch);

        {
            let repo = test_repo.repo();
            repo.reference(
                "refs/remotes/origin/feature",
                remote_tip,
                true,
                "test remote branch",
            )
            .unwrap();

            // Forces the D/F conflict: refs/heads/feature/ now exists as a
            // directory, so refs/heads/feature cannot be created.
            let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
            repo.branch("feature/sub", &head_commit, false).unwrap();
        }

        let head_before = {
            let repo = test_repo.repo();
            let oid = repo.head().unwrap().peel_to_commit().unwrap().id();
            oid
        };

        let result = checkout(test_repo.path_str(), "origin/feature".to_string(), None).await;
        assert!(
            result.is_err(),
            "checking out origin/feature must fail while refs/heads/feature/sub exists"
        );

        let repo = test_repo.repo();

        // HEAD untouched: same branch, same commit.
        assert_eq!(test_repo.current_branch(), original_branch);
        assert_eq!(
            repo.head().unwrap().peel_to_commit().unwrap().id(),
            head_before
        );

        // Working tree untouched: the remote-only file was never written.
        assert!(
            !test_repo.path.join("remote-only.txt").exists(),
            "working tree was rewritten to the remote tip before the branch was created"
        );

        // Index untouched: nothing staged against HEAD.
        let statuses = repo.statuses(None).unwrap();
        // Every staged bit, not just new/modified/deleted: a rewritten tree can
        // also stage renames and typechanges, which would slip past a narrower
        // check and let this assertion pass over a dirty index.
        let staged = git2::Status::INDEX_NEW
            | git2::Status::INDEX_MODIFIED
            | git2::Status::INDEX_DELETED
            | git2::Status::INDEX_RENAMED
            | git2::Status::INDEX_TYPECHANGE;
        assert!(
            statuses.iter().all(|s| !s.status().intersects(staged)),
            "failed checkout left staged changes in the index"
        );

        // No half-created branch left behind.
        assert!(
            repo.find_branch("feature", git2::BranchType::Local)
                .is_err(),
            "a failed checkout must not leave the local branch behind"
        );
    }

    /// Asking for an orphan branch WITHOUT checking it out must not strand HEAD.
    ///
    /// `git checkout --orphan` always switches, and it writes no HEAD reflog
    /// entry — so the old `git checkout -` to switch back failed with
    /// "pathspec '-' did not match any file(s) known to git". The command
    /// returned an error AND left HEAD on the unborn orphan, where repo.head()
    /// fails for the whole app: graph, branch list and status all go blank,
    /// after the user explicitly asked NOT to switch.
    #[tokio::test]
    async fn test_create_orphan_branch_without_checkout_leaves_head_alone() {
        let test_repo = TestRepo::with_initial_commit();
        let original = test_repo.current_branch();

        let err = create_orphan_branch(test_repo.path_str(), "docs".to_string(), false)
            .await
            .expect_err("an orphan branch cannot be created without switching to it");
        assert!(
            err.to_string().contains("first commit"),
            "the refusal must explain why, got: {}",
            err
        );

        // The repository is untouched: still on the original branch, with a
        // resolvable HEAD, and no half-made orphan anywhere.
        let repo = test_repo.repo();
        assert!(repo.head().is_ok(), "HEAD must still resolve");
        assert_eq!(repo.head().unwrap().shorthand().unwrap(), original);
        assert!(repo.find_branch("docs", git2::BranchType::Local).is_err());
    }

    /// Checking it out is the supported route, and still works.
    #[tokio::test]
    async fn test_create_orphan_branch_with_checkout_switches_to_it() {
        let test_repo = TestRepo::with_initial_commit();

        create_orphan_branch(test_repo.path_str(), "gh-pages".to_string(), true)
            .await
            .expect("creating and checking out an orphan branch must work");

        // An unborn branch: HEAD names it symbolically but it has no commit
        // yet, which is exactly what an orphan is before its first commit.
        let repo = test_repo.repo();
        let head_ref = repo.find_reference("HEAD").unwrap();
        assert_eq!(
            // Two unwraps, deliberately: this git2 version returns
            // Result<Option<&str>>, not Option<&str>. One unwrap leaves an
            // Option that will not compare to &str.
            head_ref.symbolic_target().unwrap().unwrap(),
            "refs/heads/gh-pages",
            "HEAD must name the new orphan branch"
        );
        assert!(
            repo.head().is_err(),
            "the orphan is unborn until its first commit"
        );
    }

    /// A set_head failure must not leave the tree on one branch and HEAD on
    /// another.
    ///
    /// Moving HEAD is the last step that can fail, and by then checkout_tree
    /// has already written the remote tip into the working tree. Returning
    /// there left the whole inter-branch diff reading as uncommitted work, and
    /// committing it would write the other branch's tree onto the current one.
    /// A HEAD.lock — left by a crashed process or a concurrent git — is the way
    /// in, and is exactly what this test uses.
    #[tokio::test]
    async fn test_failed_set_head_restores_the_tree_and_drops_the_branch() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("Adds shared.txt", &[("shared.txt", "base")]);
        let original_branch = test_repo.current_branch();

        // A "remote" branch whose tip changes shared.txt.
        test_repo.create_branch("staging-for-remote");
        test_repo.checkout_branch("staging-for-remote");
        let remote_tip = test_repo.create_commit("Remote edit", &[("shared.txt", "remote")]);
        test_repo.checkout_branch(&original_branch);
        test_repo.create_remote_branch("feature", remote_tip);

        // Block the HEAD update, leaving checkout_tree as the only step that
        // gets to run.
        let head_lock = test_repo.path.join(".git").join("HEAD.lock");
        std::fs::write(&head_lock, b"").expect("create HEAD.lock");

        let result = checkout(test_repo.path_str(), "origin/feature".to_string(), None).await;
        assert!(
            result.is_err(),
            "a blocked HEAD update must fail the checkout"
        );

        std::fs::remove_file(&head_lock).ok();

        let repo = test_repo.repo();

        // HEAD never moved...
        assert_eq!(repo.head().unwrap().shorthand().unwrap(), original_branch);

        // ...so the working tree must not be holding the other branch's content.
        assert_eq!(
            std::fs::read_to_string(test_repo.path.join("shared.txt")).unwrap(),
            "base",
            "the working tree was left on the remote branch's content while HEAD \
             stayed put — the whole diff would read as uncommitted work"
        );

        // And no half-created branch is left to make a retry take the
        // "local branch exists" path.
        assert!(
            repo.find_branch("feature", git2::BranchType::Local)
                .is_err(),
            "a failed checkout must not leave the local branch behind"
        );
    }

    /// A branch created by checkout_with_autostash must not survive a failed
    /// checkout.
    ///
    /// Creating the ref before checkout_tree is what keeps a failure from
    /// corrupting the tree, but it also means a later checkout_tree failure
    /// would leave the branch behind — non-transactional, and inconsistent with
    /// checkout(), which rolls its ref back. A retry would then see the branch
    /// already exists and silently take the "local branch exists" path.
    #[tokio::test]
    async fn test_failed_autostash_checkout_rolls_back_the_created_branch() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("Adds shared.txt", &[("shared.txt", "base")]);
        let original_branch = test_repo.current_branch();

        // The "remote" changes shared.txt, so switching to it must rewrite that
        // file in the working tree.
        test_repo.create_branch("staging-for-remote");
        test_repo.checkout_branch("staging-for-remote");
        let remote_tip = test_repo.create_commit("Remote edit", &[("shared.txt", "remote")]);
        test_repo.checkout_branch(&original_branch);

        {
            let repo = test_repo.repo();
            repo.reference(
                "refs/remotes/origin/feature",
                remote_tip,
                true,
                "test remote branch",
            )
            .unwrap();
        }

        // Uncommitted local edit to that same file, with auto-stash OFF: nothing
        // moves it out of the way, so the safe checkout_tree refuses rather than
        // discarding the user's work — a failure that lands AFTER the branch has
        // been created.
        test_repo.create_file("shared.txt", "local edit");

        let result = checkout_with_autostash(
            test_repo.path_str(),
            "origin/feature".to_string(),
            Some(false),
        )
        .await;
        assert!(
            result.is_err(),
            "checkout must fail rather than discard an uncommitted local edit"
        );

        let repo = test_repo.repo();
        assert_eq!(test_repo.current_branch(), original_branch);
        assert!(
            repo.find_branch("feature", git2::BranchType::Local)
                .is_err(),
            "a failed checkout must not leave the branch it created behind"
        );
    }

    // ── checkout_with_autostash tests ──────────────────────────────────

    /// A branch checked out in ANOTHER worktree must be refused BEFORE the
    /// working tree is touched.
    ///
    /// libgit2 enforces this in set_head, not checkout_tree, and every checkout
    /// path here rewrote the tree first. So the refusal fired after the damage:
    /// tree and index held the other branch's content, HEAD still named the old
    /// branch, the whole inter-branch diff was left STAGED, and the auto-stash
    /// could not be popped back over it. Canonical git refuses up front.
    /// The guard must strip a REMOTE row's name to the local branch the
    /// checkout will actually land on. Testing the raw "origin/feat" matched
    /// refs/heads/origin/feat — nothing — so the remote arm then resolved the
    /// local `feat` and hit the very corruption the guard exists to prevent.
    #[cfg(unix)]
    #[test]
    fn test_elsewhere_guard_strips_a_remote_prefix() {
        let test_repo = TestRepo::with_initial_commit();
        let unique = test_repo
            .path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let wt_dir = test_repo
            .path
            .parent()
            .unwrap()
            .join(format!("remote-wt-{}", unique));
        let out = crate::utils::create_command("git")
            .arg("-C")
            .arg(&test_repo.path)
            .args(["worktree", "add", "-b", "feat"])
            .arg(&wt_dir)
            .output()
            .unwrap();
        assert!(out.status.success());

        let repo = test_repo.repo();
        assert!(
            ensure_not_checked_out_elsewhere(&repo, "feat").is_err(),
            "the local name must be refused"
        );
        assert!(
            ensure_not_checked_out_elsewhere(&repo, "origin/feat").is_err(),
            "and so must the remote row that resolves to it"
        );
        assert!(
            ensure_not_checked_out_elsewhere(&repo, "origin/unrelated").is_ok(),
            "an unrelated branch must still be allowed"
        );
    }

    /// The guard must also see the MAIN worktree. git_worktree_list enumerates
    /// only $GIT_COMMON_DIR/worktrees/, which the main worktree has no entry
    /// in — so opened ON a linked worktree the check saw nothing at all, while
    /// libgit2's own set_head refusal does cover it.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_checkout_from_a_linked_worktree_refuses_the_main_worktrees_branch() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("base", &[("a.txt", "MAIN\n")]);
        let main_branch = test_repo.current_branch();
        let unique = test_repo
            .path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let wt_dir = test_repo
            .path
            .parent()
            .unwrap()
            .join(format!("linked-main-{}", unique));
        let out = crate::utils::create_command("git")
            .arg("-C")
            .arg(&test_repo.path)
            .args(["worktree", "add", "-b", "side"])
            .arg(&wt_dir)
            .output()
            .unwrap();
        assert!(out.status.success());

        // Operate FROM the linked worktree, targeting the main worktree's branch.
        let result = checkout_with_autostash(
            wt_dir.to_string_lossy().to_string(),
            main_branch,
            Some(true),
        )
        .await;

        assert!(
            result.is_err(),
            "the main worktree's branch must be refused from a linked worktree"
        );
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("already checked out"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_checkout_refuses_a_branch_held_by_another_worktree() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("base", &[("a.txt", "MAIN\n")]);

        // A linked worktree holding `feat`.
        // Unique per run: `..` from the repo's TempDir is the SHARED system
        // temp dir, so a fixed name collides with tests running in parallel.
        let unique = test_repo
            .path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let wt_dir = test_repo
            .path
            .parent()
            .unwrap()
            .join(format!("linked-wt-{}", unique));
        let out = crate::utils::create_command("git")
            .arg("-C")
            .arg(&test_repo.path)
            .args(["worktree", "add", "-b", "feat"])
            .arg(&wt_dir)
            .output()
            .expect("git must run");
        assert!(
            out.status.success(),
            "worktree add failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );

        // An uncommitted edit that must survive untouched.
        std::fs::write(test_repo.path.join("a.txt"), "MY PRECIOUS EDIT\n").unwrap();
        let head_before = test_repo.head_oid();

        let result =
            checkout_with_autostash(test_repo.path_str(), "feat".to_string(), Some(true)).await;

        assert!(
            result.is_err(),
            "must refuse a branch held by another worktree"
        );
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("already checked out"),
            "actionable message: {msg}"
        );

        // Nothing moved, nothing was stashed, the edit is still there.
        assert_eq!(test_repo.head_oid(), head_before, "HEAD must not move");
        assert_eq!(
            std::fs::read_to_string(test_repo.path.join("a.txt")).unwrap(),
            "MY PRECIOUS EDIT\n",
            "the working tree must be untouched"
        );
        let mut repo = test_repo.repo();
        let mut stash_count = 0;
        let _ = repo.stash_foreach(|_, _, _| {
            stash_count += 1;
            true
        });
        assert_eq!(stash_count, 0, "nothing may be left in the stash");
    }

    #[tokio::test]
    async fn test_checkout_with_autostash_local_branch() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("feature");

        let result =
            checkout_with_autostash(repo.path_str(), "feature".to_string(), Some(true)).await;
        assert!(result.is_ok());
        let data = result.unwrap();
        assert!(data.success);
        assert!(!data.stashed);
        assert_eq!(repo.current_branch(), "feature");
    }

    /// `git stash push` PREPENDS, so a stash created between the auto-stash
    /// save and the re-apply renumbers the entry. Applying and dropping the
    /// bare index 0 then restored someone else's stash and destroyed it, while
    /// the user's pre-checkout work stayed unapplied one slot down — and the
    /// success toast still claimed the changes had been re-applied.
    #[test]
    fn test_auto_stash_index_follows_the_oid_not_the_position() {
        let test_repo = TestRepo::with_initial_commit();
        let mut repo = test_repo.repo();
        let sig = repo.signature().unwrap();

        test_repo.create_file("README.md", "first stash\n");
        let first = repo
            .stash_save(&sig, "first", Some(git2::StashFlags::DEFAULT))
            .unwrap();

        // A second stash pushes the first down to index 1.
        test_repo.create_file("README.md", "second stash\n");
        let second = repo
            .stash_save(&sig, "second", Some(git2::StashFlags::DEFAULT))
            .unwrap();

        assert_eq!(
            auto_stash_index(&mut repo, Some(first)),
            Some(1),
            "the first stash moved to index 1 and must be found there"
        );
        assert_eq!(auto_stash_index(&mut repo, Some(second)), Some(0));
    }

    #[test]
    fn test_auto_stash_index_is_none_when_the_stash_is_gone() {
        let test_repo = TestRepo::with_initial_commit();
        let mut repo = test_repo.repo();
        let sig = repo.signature().unwrap();

        test_repo.create_file("README.md", "stashed\n");
        let oid = repo
            .stash_save(&sig, "gone", Some(git2::StashFlags::DEFAULT))
            .unwrap();
        repo.stash_drop(0).unwrap();

        assert_eq!(
            auto_stash_index(&mut repo, Some(oid)),
            None,
            "a vanished stash must not fall back to whatever sits at index 0"
        );
    }

    #[tokio::test]
    async fn test_checkout_with_autostash_leaves_a_foreign_stash_alone() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_branch("feature");
        test_repo.create_file("README.md", "my work\n");

        // A stash that is NOT the auto-stash, sitting at index 0.
        let mut repo = test_repo.repo();
        let sig = repo.signature().unwrap();
        test_repo.create_file("other.txt", "someone else's work\n");
        test_repo.stage_file("other.txt");
        let foreign = repo
            .stash_save(&sig, "foreign", Some(git2::StashFlags::DEFAULT))
            .unwrap();

        let result =
            checkout_with_autostash(test_repo.path_str(), "feature".to_string(), Some(true))
                .await
                .expect("checkout");
        assert!(result.success);

        // Whatever happened to the auto-stash, the foreign one must survive.
        let mut repo = test_repo.repo();
        assert!(
            auto_stash_index(&mut repo, Some(foreign)).is_some(),
            "the checkout applied and dropped a stash it did not create"
        );
    }

    #[tokio::test]
    async fn test_checkout_with_autostash_bad_ref_leaves_a_foreign_stash_alone() {
        // The resolve-failure path popped index 0 unverified while the
        // checkout-failure path beside it checked the oid. A stash created in
        // between sits at 0 and would be applied and destroyed in place of the
        // auto-stash.
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_file("README.md", "my work\n");

        let mut repo = test_repo.repo();
        let sig = repo.signature().unwrap();
        test_repo.create_file("other.txt", "someone else's work\n");
        test_repo.stage_file("other.txt");
        let foreign = repo
            .stash_save(&sig, "foreign", Some(git2::StashFlags::DEFAULT))
            .unwrap();

        // A ref that cannot resolve drives the resolve-failure path.
        let result = checkout_with_autostash(
            test_repo.path_str(),
            "no-such-branch".to_string(),
            Some(true),
        )
        .await;
        assert!(
            result.is_err(),
            "an unresolvable ref must fail the checkout"
        );

        let mut repo = test_repo.repo();
        assert!(
            auto_stash_index(&mut repo, Some(foreign)).is_some(),
            "the failed checkout popped a stash it did not create"
        );
    }

    #[tokio::test]
    async fn test_checkout_failure_restores_the_auto_stash_by_oid() {
        // A stash pushed during the checkout renumbers the list. The old check
        // only compared against index 0, so it declined to restore and returned
        // a bare "Checkout failed" — leaving an empty working tree, the changes
        // in the stash list, and nothing on screen saying so.
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("base", &[("tracked.txt", "base\n")]);
        test_repo.create_branch("feature");

        test_repo.create_file("tracked.txt", "my work\n");

        // A foreign stash that will sit at index 0 once the auto-stash lands.
        let mut repo = test_repo.repo();
        let sig = repo.signature().unwrap();
        test_repo.create_file("other.txt", "someone else's\n");
        test_repo.stage_file("other.txt");
        let foreign = repo
            .stash_save(&sig, "foreign", Some(git2::StashFlags::DEFAULT))
            .unwrap();

        let _ =
            checkout_with_autostash(test_repo.path_str(), "feature".to_string(), Some(true)).await;

        // Whatever the outcome, the foreign stash must survive untouched.
        let mut repo = test_repo.repo();
        assert!(
            auto_stash_index(&mut repo, Some(foreign)).is_some(),
            "the checkout restored a stash it did not create"
        );
    }

    /// A failure AFTER checkout_tree must restore the auto-stash and say so.
    ///
    /// checkout_tree rewrites the working tree before HEAD moves, so anything
    /// that fails after it — a failed set_head, say, when the branch is deleted
    /// from a terminal mid-checkout — leaves the tree at the target commit with
    /// the user's work in the stash list. Propagating the raw error alone sent
    /// them to a working tree they did not recognise with no clue their changes
    /// were recoverable. Both failure paths now route through this one function
    /// so they cannot describe the same situation differently.
    #[test]
    fn test_autostash_failure_restores_the_stash_and_reports_it() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("base", &[("tracked.txt", "base\n")]);
        test_repo.create_file("tracked.txt", "my work\n");

        let mut repo = test_repo.repo();
        let sig = repo.signature().unwrap();
        let stash_oid = repo
            .stash_save(&sig, "auto-stash", Some(git2::StashFlags::DEFAULT))
            .unwrap();

        let err = autostash_failure(&mut repo, true, Some(stash_oid), "set_head exploded");
        let msg = err.to_string();
        assert!(
            msg.contains("set_head exploded"),
            "names the failure: {msg}"
        );

        // The user's work is back in the working tree, not stranded.
        let mut repo = test_repo.repo();
        assert!(
            auto_stash_index(&mut repo, Some(stash_oid)).is_none(),
            "the auto-stash must have been popped"
        );
        assert_eq!(
            std::fs::read_to_string(test_repo.path.join("tracked.txt")).unwrap(),
            "my work\n"
        );
    }

    #[test]
    fn test_autostash_failure_says_where_the_changes_are_when_it_cannot_restore() {
        let test_repo = TestRepo::with_initial_commit();
        let mut repo = test_repo.repo();

        // An oid that is not in the stash list — the entry was dropped from a
        // terminal while the checkout ran.
        let missing = git2::Oid::from_str("0123456789012345678901234567890123456789").unwrap();
        let err = autostash_failure(&mut repo, true, Some(missing), "set_head exploded");
        let msg = err.to_string();

        assert!(
            msg.contains("set_head exploded"),
            "names the failure: {msg}"
        );
        assert!(
            msg.contains("still in the stash list"),
            "must tell the user where their work went: {msg}"
        );
    }

    #[tokio::test]
    async fn test_checkout_with_autostash_stashes_uncommitted_changes() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("feature");

        // Create uncommitted changes
        repo.create_file("README.md", "modified content");
        repo.stage_file("README.md");

        let result =
            checkout_with_autostash(repo.path_str(), "feature".to_string(), Some(true)).await;
        assert!(result.is_ok());
        let data = result.unwrap();
        assert!(data.success);
        assert!(data.stashed);
        assert!(data.stash_applied);
        assert_eq!(repo.current_branch(), "feature");
    }

    #[tokio::test]
    async fn test_checkout_with_autostash_disabled_does_not_stash() {
        // With the setting off the checkout is attempted as-is. A clean tree
        // still switches — only a checkout that would clobber work is refused.
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("feature");

        let result =
            checkout_with_autostash(repo.path_str(), "feature".to_string(), Some(false)).await;
        assert!(result.is_ok());
        let data = result.unwrap();
        assert!(data.success);
        assert!(
            !data.stashed,
            "the setting was off, so nothing may be stashed"
        );
        assert_eq!(repo.current_branch(), "feature");
    }

    #[tokio::test]
    async fn test_checkout_with_autostash_disabled_leaves_changes_in_place() {
        // The uncommitted work must still be there afterwards, whether git
        // allowed the switch or refused it — what must NOT happen is a silent
        // stash behind the back of a user who turned the setting off.
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("feature");
        repo.create_file("README.md", "modified content");

        let result =
            checkout_with_autostash(repo.path_str(), "feature".to_string(), Some(false)).await;

        if let Ok(data) = result {
            assert!(
                !data.stashed,
                "no stash may be created when the setting is off"
            );
        }
        let content =
            std::fs::read_to_string(std::path::Path::new(&repo.path_str()).join("README.md"))
                .unwrap();
        assert_eq!(content, "modified content", "the user's changes survive");
    }

    #[tokio::test]
    async fn test_checkout_with_autostash_none_keeps_stashing() {
        // Absent means "behave as before": older callers must not change.
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("feature");
        repo.create_file("README.md", "modified content");
        repo.stage_file("README.md");

        let result = checkout_with_autostash(repo.path_str(), "feature".to_string(), None).await;
        assert!(result.is_ok());
        assert!(result.unwrap().stashed);
    }

    #[tokio::test]
    async fn test_checkout_with_autostash_nonexistent_ref_fails() {
        let repo = TestRepo::with_initial_commit();

        let result =
            checkout_with_autostash(repo.path_str(), "nonexistent".to_string(), Some(true)).await;
        assert!(result.is_err());
        // Should still be on original branch
        assert_eq!(repo.current_branch(), "main");
    }

    #[tokio::test]
    async fn test_checkout_with_autostash_remote_branch_creates_local_tracking() {
        let repo = TestRepo::with_initial_commit();
        let oid = repo.head_oid();

        // Simulate a remote branch
        repo.create_remote_branch("feature-remote", oid);

        let result = checkout_with_autostash(
            repo.path_str(),
            "origin/feature-remote".to_string(),
            Some(true),
        )
        .await;
        assert!(result.is_ok(), "checkout failed: {:?}", result.err());
        let data = result.unwrap();
        assert!(data.success);

        // Should have created a local branch and set HEAD to it (not detached)
        let git_repo = repo.repo();
        assert!(
            !git_repo.head_detached().unwrap(),
            "HEAD should not be detached after remote branch checkout"
        );
        assert_eq!(repo.current_branch(), "feature-remote");

        // Verify the local branch exists
        let local_branch = git_repo.find_branch("feature-remote", git2::BranchType::Local);
        assert!(
            local_branch.is_ok(),
            "Local tracking branch should have been created"
        );
    }

    #[tokio::test]
    async fn test_checkout_with_autostash_remote_branch_existing_local() {
        let repo = TestRepo::with_initial_commit();
        let oid = repo.head_oid();

        // Create a local branch and a remote branch with the same short name
        repo.create_branch("feature-existing");
        repo.create_remote_branch("feature-existing", oid);

        let result = checkout_with_autostash(
            repo.path_str(),
            "origin/feature-existing".to_string(),
            Some(true),
        )
        .await;
        assert!(result.is_ok());
        let data = result.unwrap();
        assert!(data.success);

        // Should check out the existing local branch (not fail with "already exists")
        let git_repo = repo.repo();
        assert!(
            !git_repo.head_detached().unwrap(),
            "HEAD should not be detached"
        );
        assert_eq!(repo.current_branch(), "feature-existing");
    }

    #[tokio::test]
    async fn test_checkout_with_autostash_remote_branch_with_prefix() {
        let repo = TestRepo::with_initial_commit();
        let oid = repo.head_oid();

        // Simulate origin/feature/my-branch (nested path)
        repo.create_remote_branch("feature/my-branch", oid);

        let result = checkout_with_autostash(
            repo.path_str(),
            "origin/feature/my-branch".to_string(),
            Some(true),
        )
        .await;
        assert!(result.is_ok());
        let data = result.unwrap();
        assert!(data.success);

        // Should create local branch "feature/my-branch"
        let git_repo = repo.repo();
        assert!(!git_repo.head_detached().unwrap());
        assert_eq!(repo.current_branch(), "feature/my-branch");
    }

    #[tokio::test]
    async fn test_checkout_with_autostash_head_branch_has_is_head() {
        // After checkout, get_branches should show the new branch as HEAD
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("feature");

        let result =
            checkout_with_autostash(repo.path_str(), "feature".to_string(), Some(true)).await;
        assert!(result.is_ok());

        let branches = get_branches(repo.path_str()).await.unwrap();
        let head_branch = branches.iter().find(|b| b.is_head);
        assert!(head_branch.is_some(), "One branch should be HEAD");
        assert_eq!(head_branch.unwrap().name, "feature");
    }

    #[tokio::test]
    async fn test_checkout_with_autostash_remote_branch_has_is_head_in_branches() {
        // After remote checkout, get_branches should show the new local branch as HEAD
        let repo = TestRepo::with_initial_commit();
        let oid = repo.head_oid();
        repo.create_remote_branch("new-feature", oid);

        let result = checkout_with_autostash(
            repo.path_str(),
            "origin/new-feature".to_string(),
            Some(true),
        )
        .await;
        assert!(result.is_ok());

        let branches = get_branches(repo.path_str()).await.unwrap();
        let head_branch = branches.iter().find(|b| b.is_head);
        assert!(
            head_branch.is_some(),
            "One branch should be HEAD after remote checkout"
        );
        assert_eq!(head_branch.unwrap().name, "new-feature");
        assert!(
            !head_branch.unwrap().is_remote,
            "HEAD branch should be local, not remote"
        );
    }

    // ── Additional coverage for error paths and edge cases ─────────────

    #[tokio::test]
    async fn test_create_branch_invalid_start_point() {
        let repo = TestRepo::with_initial_commit();
        let result = create_branch(
            repo.path_str(),
            "new-branch".to_string(),
            Some("nonexistent-ref-abc123".to_string()),
            Some(false),
        )
        .await;

        assert!(
            result.is_err(),
            "Creating branch from invalid start point should fail"
        );
    }

    #[tokio::test]
    async fn test_get_branches_invalid_repo_path() {
        let result = get_branches("/nonexistent/repo/path".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_checkout_invalid_repo_path() {
        let result = checkout(
            "/nonexistent/repo/path".to_string(),
            "main".to_string(),
            Some(false),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_create_branch_invalid_repo_path() {
        let result = create_branch(
            "/nonexistent/repo/path".to_string(),
            "branch".to_string(),
            None,
            Some(false),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_delete_branch_invalid_repo_path() {
        let result = delete_branch(
            "/nonexistent/repo/path".to_string(),
            "main".to_string(),
            Some(true),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_rename_branch_invalid_repo_path() {
        let result = rename_branch(
            "/nonexistent/repo/path".to_string(),
            "old".to_string(),
            "new".to_string(),
            None,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_checkout_detached_head_to_another_commit() {
        let repo = TestRepo::with_initial_commit();
        let oid1 = repo.head_oid();
        let oid2 = repo.create_commit("Second commit", &[("file2.txt", "content2")]);

        // Checkout first commit (detached)
        let result = checkout(repo.path_str(), oid1.to_string(), Some(false)).await;
        assert!(result.is_ok());
        assert!(repo.repo().head_detached().unwrap());

        // Now checkout second commit (detached -> detached)
        let result = checkout(repo.path_str(), oid2.to_string(), Some(false)).await;
        assert!(result.is_ok());
        assert!(repo.repo().head_detached().unwrap());

        // HEAD should point to oid2
        let head_oid = repo.repo().head().unwrap().target().unwrap();
        assert_eq!(head_oid, oid2);
    }

    #[tokio::test]
    async fn test_delete_unmerged_branch_without_force_fails() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("diverged");

        // Checkout the new branch and make a commit that diverges from main
        repo.checkout_branch("diverged");
        repo.create_commit("Diverged commit", &[("diverged.txt", "content")]);
        repo.checkout_branch("main");

        // Delete without force should fail because the branch is not merged
        let result = delete_branch(repo.path_str(), "diverged".to_string(), Some(false)).await;
        assert!(result.is_err());
        let err_msg = format!("{}", result.unwrap_err());
        assert!(
            err_msg.contains("not fully merged"),
            "Error should mention branch is not merged, got: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn test_delete_merged_branch_without_force_succeeds() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("merged-feature");

        // Advance main past the branch point so HEAD is a true descendant
        repo.create_commit("Advance main", &[("advance.txt", "content")]);

        let result =
            delete_branch(repo.path_str(), "merged-feature".to_string(), Some(false)).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_checkout_with_autostash_detached_head_ref() {
        let repo = TestRepo::with_initial_commit();
        let oid = repo.head_oid();
        repo.create_commit("Second commit", &[("file2.txt", "data")]);

        // Checkout a commit hash via autostash should detach HEAD
        let result = checkout_with_autostash(repo.path_str(), oid.to_string(), Some(true)).await;
        assert!(result.is_ok());
        let data = result.unwrap();
        assert!(data.success);
        assert!(repo.repo().head_detached().unwrap());
    }

    #[test]
    fn test_checkout_with_stash_result_serialization() {
        let result = CheckoutWithStashResult {
            success: true,
            stashed: true,
            stash_applied: false,
            stash_conflict: true,
            stash_oid: Some("abc123".to_string()),
            message: "test message".to_string(),
        };

        let json = serde_json::to_string(&result).unwrap();
        // Verify camelCase serialization
        assert!(json.contains("stashApplied"));
        assert!(json.contains("stashConflict"));
        // The conflict flow drops the auto-stash by oid, not by position.
        assert!(json.contains("stashOid"));
    }

    #[tokio::test]
    async fn test_branch_shorthand_for_remote() {
        let repo = TestRepo::with_initial_commit();
        let oid = repo.head_oid();
        repo.create_remote_branch("feature/nested", oid);

        let branches = get_branches(repo.path_str()).await.unwrap();
        let remote_branch = branches.iter().find(|b| b.name == "origin/feature/nested");
        assert!(remote_branch.is_some());
        // shorthand should strip "origin/" prefix
        assert_eq!(remote_branch.unwrap().shorthand, "feature/nested");
    }

    #[tokio::test]
    async fn test_checkout_remote_branch_with_existing_local_uses_local_tip() {
        // Local "feature" is at commit A; origin/feature is at newer commit B.
        // Checking out "origin/feature" must put BOTH the working tree and
        // HEAD on local "feature" (commit A) — not tree=B with HEAD=A.
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("feature"); // at commit A
        let commit_b = repo.create_commit("B on main", &[("newer.txt", "from B")]);
        repo.create_remote_branch("feature", commit_b);

        let result = checkout(repo.path_str(), "origin/feature".to_string(), None).await;
        assert!(result.is_ok(), "checkout failed: {:?}", result.err());

        assert_eq!(repo.current_branch(), "feature");
        // Working tree must match local feature (commit A): newer.txt absent
        assert!(
            !repo.path.join("newer.txt").exists(),
            "working tree was checked out from the remote tip instead of the local branch"
        );
        // And the tree must be clean — no phantom modifications
        let git_repo = repo.repo();
        let statuses = git_repo.statuses(None).unwrap();
        assert!(
            statuses.is_empty(),
            "unexpected dirty status after checkout: {:?}",
            statuses
                .iter()
                .map(|s| s.path().unwrap_or("").to_string())
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn test_checkout_remote_branch_creates_local_tracking() {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://example.com/repo.git");
        let commit_b = repo.create_commit("B", &[("b.txt", "b")]);
        repo.create_remote_branch("topic", commit_b);

        let result = checkout(repo.path_str(), "origin/topic".to_string(), None).await;
        assert!(result.is_ok(), "checkout failed: {:?}", result.err());

        assert_eq!(repo.current_branch(), "topic");
        let git_repo = repo.repo();
        let local = git_repo
            .find_branch("topic", git2::BranchType::Local)
            .expect("local tracking branch should exist");
        assert_eq!(local.get().target(), Some(commit_b));
        assert!(repo.path.join("b.txt").exists());
    }

    #[tokio::test]
    async fn test_checkout_autostash_remote_branch_with_existing_local_uses_local_tip() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("feature"); // at commit A
        let commit_b = repo.create_commit("B on main", &[("newer.txt", "from B")]);
        repo.create_remote_branch("feature", commit_b);

        let result =
            checkout_with_autostash(repo.path_str(), "origin/feature".to_string(), Some(true))
                .await;
        assert!(result.is_ok(), "checkout failed: {:?}", result.err());
        assert!(result.unwrap().success);

        assert_eq!(repo.current_branch(), "feature");
        assert!(
            !repo.path.join("newer.txt").exists(),
            "working tree was checked out from the remote tip instead of the local branch"
        );
        let git_repo = repo.repo();
        let statuses = git_repo.statuses(None).unwrap();
        assert!(
            statuses.is_empty(),
            "unexpected dirty status after checkout"
        );
    }

    #[tokio::test]
    async fn test_checkout_autostash_bad_ref_restores_changes_without_prefix() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file("README.md", "# modified content");

        let result =
            checkout_with_autostash(repo.path_str(), "no-such-ref".to_string(), Some(true)).await;
        let err = result.expect_err("checkout of a nonexistent ref must fail");
        let msg = err.to_string();
        assert!(
            !msg.contains("RESTORE_STASH:"),
            "internal RESTORE_STASH: prefix leaked into the user-facing error: {msg}"
        );

        // The auto-stashed changes must be restored, not left in the stash
        let contents = std::fs::read_to_string(repo.path.join("README.md")).unwrap();
        assert_eq!(
            contents, "# modified content",
            "working tree changes were not restored after failed checkout"
        );
        let mut git_repo = repo.repo();
        let mut stash_count = 0;
        git_repo
            .stash_foreach(|_, _, _| {
                stash_count += 1;
                true
            })
            .unwrap();
        assert_eq!(
            stash_count, 0,
            "auto-stash was left behind in the stash list"
        );
    }

    #[tokio::test]
    async fn test_checkout_autostash_preserves_staged_files() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("other");
        repo.create_file("README.md", "# staged change");
        repo.stage_file("README.md");

        let result =
            checkout_with_autostash(repo.path_str(), "other".to_string(), Some(true)).await;
        assert!(result.is_ok(), "checkout failed: {:?}", result.err());
        let data = result.unwrap();
        assert!(data.success);
        assert!(data.stashed);
        assert!(data.stash_applied);

        assert_eq!(repo.current_branch(), "other");
        let git_repo = repo.repo();
        let statuses = git_repo.statuses(None).unwrap();
        let readme = statuses
            .iter()
            .find(|s| s.path().ok() == Some("README.md"))
            .expect("README.md should still have changes after checkout");
        assert!(
            readme.status().contains(git2::Status::INDEX_MODIFIED),
            "staged change became unstaged across auto-stash checkout (status: {:?})",
            readme.status()
        );
    }

    /// Build a main/feature divergence on shared.txt and leave an UNCOMMITTED
    /// local change to shared.txt (staged when `stage` is true) that conflicts
    /// with feature's version. Ends checked out on the initial branch with the
    /// dirty change present. Returns the initial branch name.
    fn setup_autostash_conflict(repo: &TestRepo, stage: bool) -> String {
        let main = repo.current_branch();
        repo.create_commit("Add shared", &[("shared.txt", "base\n")]);
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature version\n")]);
        repo.checkout_branch(&main);
        // Uncommitted local change that conflicts with feature's version
        repo.create_file("shared.txt", "local edit\n");
        if stage {
            repo.stage_file("shared.txt");
        }
        main
    }

    fn stash_count(repo: &TestRepo) -> usize {
        let mut git_repo = repo.repo();
        let mut count = 0;
        git_repo
            .stash_foreach(|_, _, _| {
                count += 1;
                true
            })
            .unwrap();
        count
    }

    #[tokio::test]
    async fn test_checkout_autostash_unstaged_conflict_keeps_stash() {
        // Empirical scenario (a): an UNSTAGED conflicting change makes the
        // re-apply land conflicts in the index while git2 returns Ok. The stash
        // must be REPORTED as conflicting and PRESERVED (not silently dropped).
        let repo = TestRepo::with_initial_commit();
        setup_autostash_conflict(&repo, false);

        let result = checkout_with_autostash(repo.path_str(), "feature".to_string(), Some(true))
            .await
            .expect("checkout_with_autostash should not hard-error");

        assert!(result.success);
        assert!(result.stashed);
        assert!(!result.stash_applied);
        assert!(
            result.stash_conflict,
            "unstaged conflicting re-apply must report a conflict"
        );

        assert!(
            repo.repo().index().unwrap().has_conflicts(),
            "conflict must land in the index for the resolution flow"
        );
        assert_eq!(
            stash_count(&repo),
            1,
            "stash must be preserved so the user's changes aren't lost"
        );
    }

    #[tokio::test]
    async fn test_checkout_autostash_retry_clean_apply_drops_stash() {
        // Exercises the retry branch where the reinstate-index apply FAILS but the
        // plain retry applies CLEANLY. To reach it we need the STAGED (index)
        // content to conflict with the target while the WORKING content does not:
        //   - staged change edits line 1 (the same line the feature edits) → the
        //     reinstate-index merge conflicts → stash_apply(reinstate) errors.
        //   - a further UNSTAGED edit puts line 1 back to its base value and instead
        //     edits line 10 → the retry's 3-way working merge is CLEAN.
        // The stashed changes are now in the working tree, so the stash MUST be
        // dropped. Before the fix this fell through to the generic failure return
        // (stash kept, stash_applied:false) even though the changes WERE applied,
        // so a later apply would duplicate/conflict.
        let base = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n";
        let feature_ver = "FEATURE\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n";
        // Staged: edits line 1 (overlaps feature → reinstate-index conflict).
        let staged_ver = "STAGED\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n";
        // Working (further unstaged edit): line 1 back to base, line 10 changed
        // (non-overlapping with feature → clean working merge).
        let working_ver = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nWORKING\n";

        let repo = TestRepo::with_initial_commit();
        let main = repo.current_branch();
        repo.create_commit("Add shared", &[("shared.txt", base)]);
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", feature_ver)]);
        repo.checkout_branch(&main);
        // Stage the line-1 change, then further modify the working tree (line 10)
        // without staging so index and working trees differ.
        repo.create_file("shared.txt", staged_ver);
        repo.stage_file("shared.txt");
        repo.create_file("shared.txt", working_ver);

        let result = checkout_with_autostash(repo.path_str(), "feature".to_string(), Some(true))
            .await
            .expect("checkout_with_autostash should not hard-error");

        assert!(result.success);
        assert!(result.stashed);
        assert!(
            result.stash_applied,
            "a clean retry apply must report the changes as applied: {}",
            result.message
        );
        assert!(
            !result.stash_conflict,
            "a clean retry apply must not report a conflict: {}",
            result.message
        );
        // Confirm we took the RETRY branch (reinstate failed, retry clean), not the
        // first clean apply — that path notes the staged status was not preserved.
        assert!(
            result.message.contains("staged status was not preserved"),
            "expected the retry-clean branch message, got: {}",
            result.message
        );

        // Index must be conflict-free and the merged content present in the tree.
        assert!(!repo.repo().index().unwrap().has_conflicts());
        let merged = std::fs::read_to_string(repo.path.join("shared.txt")).unwrap();
        assert!(
            merged.contains("FEATURE"),
            "feature edit preserved: {merged}"
        );
        assert!(merged.contains("WORKING"), "stashed edit applied: {merged}");

        // The stash must have been dropped now that the changes are in the tree.
        assert_eq!(
            stash_count(&repo),
            0,
            "stash must be dropped after a clean retry apply"
        );
    }

    #[tokio::test]
    async fn test_checkout_autostash_staged_conflict_keeps_stash() {
        // Empirical scenario (b): a STAGED conflicting change makes the
        // reinstate-index apply fail with ECONFLICT. The retry without
        // reinstating the index lands the conflict in the index; the stash is
        // kept and the conflict is reported.
        let repo = TestRepo::with_initial_commit();
        setup_autostash_conflict(&repo, true);

        let result = checkout_with_autostash(repo.path_str(), "feature".to_string(), Some(true))
            .await
            .expect("checkout_with_autostash should not hard-error");

        assert!(result.success);
        assert!(result.stashed);
        assert!(!result.stash_applied);
        assert!(
            result.stash_conflict,
            "staged conflicting re-apply must report a conflict"
        );

        assert!(
            repo.repo().index().unwrap().has_conflicts(),
            "conflict must land in the index for the resolution flow"
        );
        assert_eq!(
            stash_count(&repo),
            1,
            "stash must be preserved so the user's changes aren't lost"
        );
    }

    // ---- post-checkout hook parity ----

    #[cfg(unix)]
    #[tokio::test]
    async fn test_checkout_runs_post_checkout_hook() {
        let repo = TestRepo::with_initial_commit();
        let main = repo.current_branch();
        let old_head = repo.head_oid();
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature", &[("f.txt", "f")]);
        let feature_head = repo.head_oid();
        repo.checkout_branch(&main);

        let marker = repo.path.join("post-checkout.log");
        repo.install_hook(
            "post-checkout",
            &format!("#!/bin/sh\necho \"$1 $2 $3\" > \"{}\"\n", marker.display()),
        );

        // Switch to feature via the command under test.
        checkout(repo.path_str(), "feature".to_string(), None)
            .await
            .unwrap();

        let logged = std::fs::read_to_string(&marker).expect("post-checkout hook must run");
        let logged = logged.trim();
        assert_eq!(
            logged,
            format!("{} {} 1", old_head, feature_head),
            "post-checkout must receive <old> <new> 1"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_checkout_post_checkout_hook_is_nonblocking() {
        let repo = TestRepo::with_initial_commit();
        let main = repo.current_branch();
        repo.create_branch("feature");
        repo.install_hook("post-checkout", "#!/bin/sh\nexit 1\n");

        // A failing post-checkout hook must NOT fail the checkout.
        let result = checkout(repo.path_str(), "feature".to_string(), None).await;
        assert!(result.is_ok(), "post-checkout is non-blocking");
        assert_eq!(repo.current_branch(), "feature");
        let _ = main;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_checkout_with_autostash_runs_post_checkout_hook() {
        let repo = TestRepo::with_initial_commit();
        let main = repo.current_branch();
        let old_head = repo.head_oid();
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature", &[("f.txt", "f")]);
        let feature_head = repo.head_oid();
        repo.checkout_branch(&main);

        let marker = repo.path.join("post-checkout.log");
        repo.install_hook(
            "post-checkout",
            &format!("#!/bin/sh\necho \"$1 $2 $3\" > \"{}\"\n", marker.display()),
        );

        checkout_with_autostash(repo.path_str(), "feature".to_string(), Some(true))
            .await
            .unwrap();

        let logged = std::fs::read_to_string(&marker).expect("post-checkout hook must run");
        assert_eq!(logged.trim(), format!("{} {} 1", old_head, feature_head));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_create_branch_checkout_runs_post_checkout_hook() {
        let repo = TestRepo::with_initial_commit();
        let marker = repo.path.join("post-checkout.log");
        repo.install_hook(
            "post-checkout",
            &format!("#!/bin/sh\necho \"$3\" > \"{}\"\n", marker.display()),
        );

        create_branch(repo.path_str(), "brand-new".to_string(), None, Some(true))
            .await
            .unwrap();

        let logged = std::fs::read_to_string(&marker).expect("post-checkout hook must run");
        assert_eq!(logged.trim(), "1", "branch-switch flag must be 1");
    }
}
