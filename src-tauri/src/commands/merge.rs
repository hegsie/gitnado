//! Merge and rebase command handlers

mod conflicts;
#[path = "merge/rebase.rs"]
mod rebase_ops;
#[cfg(test)]
#[path = "merge/tests.rs"]
mod test_suite;

pub use conflicts::*;
#[cfg(test)]
use conflicts::{
    collision_free_size, detected_marker_sizes, diff3_within_first_conflict, has_complete_conflict,
    parse_conflict_markers, parse_merge_branch_from_msg, replay_hunks, MAX_DETECTED_SIZES,
};

pub use rebase_ops::*;
#[cfg(test)]
use rebase_ops::{append_rewritten, skipped_count_path, take_rewritten, take_skipped};
pub(crate) use rebase_ops::{append_skipped, commit_or_skip_empty, ensure_libgit2_rewritten_file};

use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::utils::create_command;

/// Merge a branch into HEAD
#[command]
pub async fn merge(
    path: String,
    source_ref: String,
    no_ff: Option<bool>,
    squash: Option<bool>,
    message: Option<String>,
) -> Result<()> {
    // The repository lives inside this block so it is dropped before any await:
    // git2::Repository is not Send, and a Tauri command's future must be. The
    // block yields the signed commit to perform, if one is needed.
    let signed_merge: Option<(String, bool)> = 'merge_body: {
        let repo = git2::Repository::open(Path::new(&path))?;

        // Like git's pre-merge checks: refuse to start a merge while another
        // operation is in progress, with an actionable message (instead of the
        // misleading libgit2 "uncommitted change would be overwritten" error).
        match repo.state() {
            git2::RepositoryState::Clean => {}
            git2::RepositoryState::Merge => {
                return Err(GitnadoError::OperationFailed(
                    "You have not concluded your merge (MERGE_HEAD exists). \
                 Resolve the conflicts and commit, or abort the merge, before merging again."
                        .to_string(),
                ));
            }
            state => {
                return Err(GitnadoError::OperationFailed(format!(
                    "Cannot merge: another operation is in progress ({:?}). \
                 Complete or abort it first.",
                    state
                )));
            }
        }

        // Find the commit to merge
        // Shared with `preview_merge`, so the preview can never resolve a
        // different commit than the merge it is previewing.
        let reference = find_merge_ref(&repo, &source_ref)?;

        let annotated_commit = repo.reference_to_annotated_commit(&reference)?;
        let (analysis, _preference) = repo.merge_analysis(&[&annotated_commit])?;

        if analysis.is_up_to_date() {
            return Ok(());
        }

        if analysis.is_fast_forward() && !no_ff.unwrap_or(false) && !squash.unwrap_or(false) {
            // Fast-forward merge. Check out the target tree SAFELY first — git
            // aborts a merge that would overwrite local changes or untracked
            // files — and only move the branch ref once the checkout succeeded.
            let target_oid = annotated_commit.id();
            let target_commit = repo.find_commit(target_oid)?;
            let head = repo.head()?;
            let refname = head
                .name()
                .ok()
                .ok_or_else(|| GitnadoError::InvalidReference)?;

            // Collect the conflicting paths so the error can name them, like
            // git's "Your local changes to the following files ..." message.
            let conflict_paths = std::rc::Rc::new(std::cell::RefCell::new(Vec::<String>::new()));
            let notify_paths = std::rc::Rc::clone(&conflict_paths);
            let mut checkout = git2::build::CheckoutBuilder::new();
            checkout
                .notify_on(git2::CheckoutNotificationType::CONFLICT)
                .notify(move |_why, path, _baseline, _target, _workdir| {
                    if let Some(p) = path {
                        notify_paths.borrow_mut().push(p.display().to_string());
                    }
                    true
                });

            match repo.checkout_tree(target_commit.as_object(), Some(&mut checkout)) {
                Ok(()) => {}
                Err(e) if e.code() == git2::ErrorCode::Conflict => {
                    let files = conflict_paths.borrow().join(", ");
                    return Err(GitnadoError::OperationFailed(if files.is_empty() {
                        "Your local changes would be overwritten by merge. \
                     Commit or stash them before you merge."
                            .to_string()
                    } else {
                        format!(
                            "Your local changes to the following files would be \
                         overwritten by merge: {}. Commit or stash them before you merge.",
                            files
                        )
                    }));
                }
                Err(e) => return Err(e.into()),
            }

            let mut reference = repo.find_reference(refname)?;
            reference.set_target(target_oid, "Fast-forward merge")?;

            // git runs post-merge after a fast-forward merge too (flag 0 = not a
            // squash merge). Non-blocking.
            crate::commands::hooks::run_hook_noblock(&repo, "post-merge", &["0"]);
        } else {
            // Normal or squash merge. Once repo.merge() succeeds the index/working
            // tree is in MERGING state; any subsequent failure must reset that
            // state so the user isn't stuck with a half-merged repo.
            repo.merge(&[&annotated_commit], None, None)?;

            // A conflict is the expected "user must resolve" path; the UI drives a
            // conflict-resolution flow that needs MERGE_HEAD intact (and
            // `abort_merge` to undo), so return before any cleanup.
            if repo.index()?.has_conflicts() {
                return Err(GitnadoError::MergeConflict);
            }

            // git runs pre-merge-commit before creating the automatic merge commit,
            // but a non-zero exit does NOT abort the merge — git leaves
            // MERGE_HEAD/MERGE_MSG in place ("Not committing merge; use 'git commit'
            // to complete the merge"). So on a veto, return WITHOUT cleanup_state,
            // keeping the merge resumable via commit_merge and abortable via
            // abort_merge. (A squash merge records no merge commit, so no hook.)
            if !squash.unwrap_or(false) {
                crate::commands::hooks::run_hook_blocking(&repo, "pre-merge-commit", &[], None)?;
            }

            // Default to the MERGE_MSG libgit2 wrote during repo.merge() — git's
            // canonical auto-message ("Merge branch 'feature'") — with '#' comment
            // lines stripped, like `git commit` does.
            let commit_message =
                message.unwrap_or_else(|| default_merge_message(&repo, &source_ref));

            // Route signed commits through the git CLI, exactly as commit_merge
            // does for a conflicted merge.
            //
            // Without this, commit.gpgsign was honoured only when the merge happened
            // to CONFLICT (and was therefore concluded via commit_merge). The same
            // gesture produced a signed merge commit or an unsigned one depending
            // purely on whether the branches touched the same lines — and on a repo
            // that enforces signed commits, the unsigned ones are rejected on push
            // or show as unverified, with nothing to explain why only some merges
            // fail.
            //
            // MERGE_HEAD and the merged index are already on disk here, so
            // `git commit -S` records the correct two-parent merge commit (or, for
            // a squash, the single-parent commit after the helper clears the merge
            // metadata) and runs the hooks natively.
            //
            // This is deliberately BEFORE the commit-msg hook below: `git commit`
            // runs commit-msg itself, so running it here as well would fire the
            // hook twice for one merge — a Change-Id or ticket-prefix hook would
            // stamp the message twice, and a counting/notifying one would double
            // its effect. commit_merge takes the same route for the same reason.
            if crate::commands::commit::should_sign_commit(&path, None)? {
                break 'merge_body Some((commit_message, squash.unwrap_or(false)));
            }

            // git runs commit-msg for an automatic merge commit (after
            // pre-merge-commit); the hook may rewrite the message or veto it. Like
            // pre-merge-commit, a veto leaves the merge resumable, so run it before
            // the cleanup-guarded commit closure. (A squash merge records no merge
            // commit, so no hook — matching `git merge --squash`.)
            let commit_message = if squash.unwrap_or(false) {
                commit_message
            } else {
                crate::commands::hooks::run_commit_msg_hook(&repo, &commit_message)?
            };

            let result = (|| -> Result<()> {
                let signature = repo.signature()?;
                let head = repo.head()?.peel_to_commit()?;
                let tree_oid = repo.index()?.write_tree()?;
                let tree = repo.find_tree(tree_oid)?;

                if squash.unwrap_or(false) {
                    repo.commit(
                        Some("HEAD"),
                        &signature,
                        &signature,
                        &commit_message,
                        &tree,
                        &[&head],
                    )?;
                } else {
                    let source_commit = repo.find_commit(annotated_commit.id())?;
                    repo.commit(
                        Some("HEAD"),
                        &signature,
                        &signature,
                        &commit_message,
                        &tree,
                        &[&head, &source_commit],
                    )?;

                    // post-merge after the merge commit (flag 0 = not a squash).
                    crate::commands::hooks::run_hook_noblock(&repo, "post-merge", &["0"]);
                }
                Ok(())
            })();

            // Leave MERGE_HEAD/MERGE_MSG in place on a commit-phase failure.
            //
            // cleanup_state() only UNLINKS the state files — it does not touch the
            // index or the working tree, both of which repo.merge() has already
            // filled with the fully merged result. So calling it here removed the
            // only marker that makes the merge resumable and abortable while
            // leaving the merge itself applied: repo.state() went Clean, the
            // operation banner vanished, abort_merge refused with "there is no
            // merge to abort", and the whole inter-branch diff sat staged under a
            // toast reading "Merge failed". Committing that by hand produces a
            // single-parent commit, so the source branch is still not an ancestor
            // of HEAD — and the later force-delete escalation then discards commits
            // that only LOOK duplicated.
            //
            // Canonical git leaves MERGE_HEAD on any failure after the merge, which
            // is why commit_merge_signed one function away goes to the trouble of
            // snapshotting and restoring it. Reachable with no user.name/user.email
            // configured (repo.signature() is called raw), or on index.lock
            // contention from a terminal, or a disk-full write_tree.
            result?;

            repo.cleanup_state()?;
        }

        None
    };

    if let Some((commit_message, is_squash)) = signed_merge {
        commit_merge_signed(&path, &commit_message, is_squash).await?;

        // `git commit -S` clears the merge state itself, so there is no
        // cleanup_state here — the same shape commit_merge uses.
        //
        // The merge commit is already recorded at this point, so a failure to
        // reopen the repository must not be reported as a failed merge: the user
        // would be told the merge failed and asked to retry one that already
        // happened. post-merge is advisory (run_hook_noblock never blocks), so
        // it is simply skipped.
        if !is_squash {
            if let Ok(repo) = git2::Repository::open(Path::new(&path)) {
                crate::commands::hooks::run_hook_noblock(&repo, "post-merge", &["0"]);
            }
        }
    }

    Ok(())
}

/// Default merge-commit message: the MERGE_MSG that libgit2 wrote when the
/// merge started (git's canonical wording, e.g. "Merge branch 'feature'"),
/// with '#' comment lines stripped the way `git commit` cleans messages.
/// Falls back to git's canonical subject if MERGE_MSG is missing or empty.
fn default_merge_message(repo: &git2::Repository, source_ref: &str) -> String {
    let base = std::fs::read_to_string(repo.path().join("MERGE_MSG"))
        .ok()
        .map(|m| {
            m.lines()
                .filter(|line| !line.starts_with('#'))
                .collect::<Vec<_>>()
                .join("\n")
                .trim_end()
                .to_string()
        })
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| format!("Merge branch '{}'", source_ref));

    // git appends " into <branch>" to the merge subject unless the current
    // branch is "master" or "main" (see fmt-merge-msg / builtin/merge.c).
    // libgit2's MERGE_MSG never adds this suffix, so apply git's rule here so
    // teams whose integration branch is develop/trunk/release get the canonical
    // subject ("Merge branch 'feature' into develop").
    let current: Option<String> = match repo.head() {
        Ok(h) => h.shorthand().map(|s| s.to_string()).ok(),
        Err(_) => None,
    };
    match current.as_deref() {
        Some(branch) if branch != "master" && branch != "main" && branch != "HEAD" => {
            let mut lines: Vec<String> = base.lines().map(|s| s.to_string()).collect();
            if let Some(first) = lines.first_mut() {
                if !first.contains(" into ") {
                    *first = format!("{first} into {branch}");
                }
            }
            lines.join("\n")
        }
        _ => base,
    }
}

/// How many conflicting paths a preview lists.
///
/// The COUNT is always exact; only the list is capped. A merge that rewrites a
/// whole tree can conflict in tens of thousands of paths, and shipping all of
/// them over IPC to render "…and 40,000 more" costs far more than the preview
/// saves.
const MERGE_PREVIEW_PATH_CAP: usize = 50;

/// What merging `source_ref` would do, computed without touching the working
/// tree, the index, or any ref.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    /// `upToDate`, `fastForward`, `normal` or `unborn`.
    pub outcome: String,
    /// Exact number of paths that would conflict. Zero unless `outcome` is
    /// `normal` — a fast-forward and an up-to-date merge cannot conflict.
    pub conflict_count: usize,
    /// The conflicting paths, sorted, capped at `MERGE_PREVIEW_PATH_CAP`.
    pub conflicting_files: Vec<String>,
    /// The two sides share no common ancestor.
    pub unrelated_histories: bool,
    /// Set when the repository is already mid-merge/rebase/cherry-pick, naming
    /// the state. `merge` refuses outright in that case, so the confirm has to
    /// be able to say so BEFORE the user commits to the operation.
    pub operation_in_progress: Option<String>,
}

/// Resolve a merge source the way `merge` itself does.
///
/// refs/heads FIRST, then refs/remotes, then the name verbatim — see the
/// comment at the sidebar call sites about `origin/feature` vs `feature`. The
/// preview and the merge MUST resolve identically, or the preview describes a
/// merge of a different commit than the one that actually runs.
fn find_merge_ref<'repo>(
    repo: &'repo git2::Repository,
    name: &str,
) -> Result<git2::Reference<'repo>> {
    repo.find_reference(&format!("refs/heads/{}", name))
        .or_else(|_| repo.find_reference(&format!("refs/remotes/{}", name)))
        .or_else(|_| repo.find_reference(name))
        .map_err(Into::into)
}

/// Predict a merge without performing it.
///
/// The rebase equivalent (`preview_rebase`) has to shell out to `git rebase` in
/// a throwaway worktree, because replaying a series of commits has no in-memory
/// form. A merge does: libgit2 merges the two trees into an index that never
/// leaves memory, so this needs no worktree, writes no `index.lock`, moves no
/// ref and leaves nothing to clean up — which also means it cannot deadlock
/// against, or corrupt, a real operation running on the same repository. Every
/// caller runs it inside the working-tree claim it already holds for the merge
/// it is about to confirm (see `utils/ref-lock.ts`), so a preview never runs
/// concurrently with another ref operation either.
///
/// `into_ref` names the branch the merge will land on; omit it for HEAD. The
/// drag-to-merge path checks the target branch out FIRST and merges into that,
/// so previewing against HEAD there would describe a merge into the branch the
/// user is leaving.
#[command]
pub async fn preview_merge(
    path: String,
    source_ref: String,
    into_ref: Option<String>,
) -> Result<MergePreview> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Read-only: reported, not refused. The preview is still worth computing —
    // the user wants to know what the merge would do once the current operation
    // is concluded — and `merge` produces the actionable refusal itself.
    let operation_in_progress = match repo.state() {
        git2::RepositoryState::Clean => None,
        state => Some(format!("{:?}", state)),
    };

    let source = find_merge_ref(&repo, &source_ref)?;
    let annotated_commit = repo.reference_to_annotated_commit(&source)?;

    let our_ref = match into_ref.as_deref().filter(|r| !r.is_empty()) {
        Some(name) => Some(find_merge_ref(&repo, name)?),
        None => None,
    };

    let (analysis, _preference) = match our_ref.as_ref() {
        Some(our) => repo.merge_analysis_for_ref(our, &[&annotated_commit])?,
        None => repo.merge_analysis(&[&annotated_commit])?,
    };

    let mut preview = MergePreview {
        outcome: "normal".to_string(),
        conflict_count: 0,
        conflicting_files: Vec::new(),
        unrelated_histories: false,
        operation_in_progress,
    };

    // UP_TO_DATE before UNBORN before FAST_FORWARD: libgit2 sets FASTFORWARD
    // alongside UNBORN, and "this will fast-forward" is the wrong thing to tell
    // someone whose branch has no commits at all.
    if analysis.is_up_to_date() {
        preview.outcome = "upToDate".to_string();
        return Ok(preview);
    }
    if analysis.is_unborn() {
        preview.outcome = "unborn".to_string();
        return Ok(preview);
    }
    if analysis.is_fast_forward() {
        preview.outcome = "fastForward".to_string();
        return Ok(preview);
    }

    // A real merge commit. Up-to-date, unborn and fast-forward are all handled
    // above, so both sides are known to exist and peel.
    let our_commit = match our_ref.as_ref() {
        Some(our) => our.peel_to_commit()?,
        None => repo.head()?.peel_to_commit()?,
    };
    let their_commit = repo.find_commit(annotated_commit.id())?;

    // No merge base at all. libgit2 merges unrelated histories against an empty
    // ancestor rather than refusing the way the git CLI does without
    // --allow-unrelated-histories, so `merge` WILL go through with it — the
    // preview says so instead of leaving the user to discover it.
    preview.unrelated_histories = match repo.merge_base(our_commit.id(), their_commit.id()) {
        Ok(_) => false,
        Err(e) if e.code() == git2::ErrorCode::NotFound => true,
        Err(e) => return Err(e.into()),
    };

    // `None` options: exactly what `merge` passes to `repo.merge()`, so the
    // prediction is made with the same rename detection and conflict rules the
    // real merge will use.
    let merged = repo.merge_commits(&our_commit, &their_commit, None)?;

    if merged.has_conflicts() {
        // One path occupies up to three conflict stages; "N files would
        // conflict" is a count of distinct paths, not of index entries.
        let mut paths = std::collections::BTreeSet::new();
        for conflict in merged.conflicts()? {
            let conflict = conflict?;
            // Any stage names the path. A delete/modify conflict has no `our`
            // or no `their` entry, so all three have to be tried or those
            // conflicts go unnamed.
            if let Some(entry) = conflict.our.or(conflict.their).or(conflict.ancestor) {
                paths.insert(String::from_utf8_lossy(&entry.path).into_owned());
            }
        }
        preview.conflict_count = paths.len();
        preview.conflicting_files = paths.into_iter().take(MERGE_PREVIEW_PATH_CAP).collect();
    }

    Ok(preview)
}

/// Abort an in-progress merge.
///
/// Mirrors `git merge --abort` (implemented as `git reset --merge`): only the
/// paths the merge touched — where the index differs from HEAD, including
/// conflicted and newly-added entries — are restored to HEAD. Uncommitted
/// changes to files the merge did not touch are preserved, exactly like git.
#[command]
pub async fn abort_merge(path: String) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // git: "fatal: There is no merge to abort (MERGE_HEAD missing)."
    if repo.state() != git2::RepositoryState::Merge {
        return Err(GitnadoError::OperationFailed(
            "There is no merge to abort (MERGE_HEAD missing).".to_string(),
        ));
    }

    // Paths written by the merge: everything where the index (auto-merged,
    // conflicted, or newly added by the merge) differs from HEAD.
    let head_tree = repo.head()?.peel_to_tree()?;
    let index = repo.index()?;
    let diff = repo.diff_tree_to_index(Some(&head_tree), Some(&index), None)?;

    let mut touched: Vec<std::path::PathBuf> = Vec::new();
    for delta in diff.deltas() {
        for file in [delta.old_file(), delta.new_file()] {
            if let Some(p) = file.path() {
                if !touched.iter().any(|t| t == p) {
                    touched.push(p.to_path_buf());
                }
            }
        }
    }

    // Restore ONLY those paths to HEAD (force is scoped to them); everything
    // else in the working tree is left alone.
    if !touched.is_empty() {
        let mut checkout = git2::build::CheckoutBuilder::new();
        checkout.force();
        // Keeps "everything else is left alone" literally true: without this,
        // CheckoutBuilder::path() glob-matches, so a touched path containing
        // `*`, `?` or `[` would also force-restore unrelated dirty files.
        checkout.disable_pathspec_match(true);
        for p in &touched {
            checkout.path(p);
        }
        repo.checkout_head(Some(&mut checkout))?;
    }

    repo.cleanup_state()?;
    Ok(())
}

/// Complete an in-progress merge after all conflicts have been resolved.
///
/// Normally creates the merge commit with HEAD + MERGE_HEAD as parents and
/// clears the MERGING state. When `squash` is true, creates a SINGLE-parent
/// commit instead (HEAD only) so a conflicted gitflow *squash* finish completes
/// as the squash the user asked for, not a merge commit.
///
/// Signed commits are routed through the git CLI so the user's GPG/SSH signing
/// configuration is honoured (git2 cannot sign).
#[command]
pub async fn commit_merge(
    path: String,
    message: Option<String>,
    squash: Option<bool>,
) -> Result<()> {
    let is_squash = squash.unwrap_or(false);
    let mut repo = git2::Repository::open(Path::new(&path))?;

    if repo.state() != git2::RepositoryState::Merge {
        return Err(GitnadoError::OperationFailed(
            "No merge in progress".to_string(),
        ));
    }

    // Collect merge heads first: mergehead_foreach needs a unique borrow
    let mut merge_oids: Vec<git2::Oid> = Vec::new();
    repo.mergehead_foreach(|oid| {
        merge_oids.push(*oid);
        true
    })?;
    if merge_oids.is_empty() {
        return Err(GitnadoError::OperationFailed(
            "MERGE_HEAD not found".to_string(),
        ));
    }
    let repo = repo;

    if repo.index()?.has_conflicts() {
        return Err(GitnadoError::MergeConflict);
    }

    // Default to git's own MERGE_MSG (what `git commit` would use mid-merge).
    // MERGE_MSG contains libgit2's '# Conflicts:' / '#\t<path>' comment lines;
    // `git commit` strips '#'-prefixed lines during message cleanup, but git2's
    // commit does not — so we must strip them ourselves, or they get baked into
    // permanent history (in both the git2 and signed -m paths).
    let commit_message = message
        .filter(|m| !m.trim().is_empty())
        .or_else(|| {
            std::fs::read_to_string(repo.path().join("MERGE_MSG"))
                .ok()
                .map(|m| {
                    m.lines()
                        .filter(|line| !line.starts_with('#'))
                        .collect::<Vec<_>>()
                        .join("\n")
                        .trim_end()
                        .to_string()
                })
                .filter(|m| !m.trim().is_empty())
        })
        .unwrap_or_else(|| "Merge".to_string());

    // Route signed commits through the git CLI (git2 cannot sign) — which runs
    // hooks natively.
    if crate::commands::commit::should_sign_commit(&path, None)? {
        return commit_merge_signed(&path, &commit_message, is_squash).await;
    }

    // Concluding a (conflicted) merge via `git commit` runs pre-commit and
    // commit-msg; the git2 path otherwise bypasses them. pre-commit can veto;
    // commit-msg can veto or rewrite the message.
    crate::commands::hooks::run_hook_blocking(&repo, "pre-commit", &[], None)?;
    let commit_message = crate::commands::hooks::run_commit_msg_hook(&repo, &commit_message)?;

    let mut index = repo.index()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    let signature = repo.signature()?;
    let head_commit = repo.head()?.peel_to_commit()?;

    if is_squash {
        // Squash: a SINGLE parent (HEAD only). The resolved index already holds
        // the full merged tree, so this commits it as an ordinary commit.
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            &commit_message,
            &tree,
            &[&head_commit],
        )?;
    } else {
        let mut parents: Vec<git2::Commit> = vec![head_commit];
        for oid in merge_oids {
            parents.push(repo.find_commit(oid)?);
        }
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            &commit_message,
            &tree,
            &parent_refs,
        )?;
    }
    repo.cleanup_state()?;

    // post-commit runs after the merge commit is recorded; never blocks.
    crate::commands::hooks::run_hook_noblock(&repo, "post-commit", &[]);

    Ok(())
}

/// Complete an in-progress merge with a SIGNED commit via the git CLI.
///
/// For a normal merge, `git commit` mid-merge creates the 2-parent merge commit
/// and clears the merge state itself. For a squash, that would wrongly produce
/// a 2-parent merge commit, so we clear the merge metadata first (which leaves
/// the resolved index staged) and then commit the staged tree as an ordinary
/// single-parent signed commit.
async fn commit_merge_signed(path: &str, message: &str, is_squash: bool) -> Result<()> {
    // For a squash we clear the merge metadata BEFORE committing (so `git
    // commit` produces a single-parent commit, not a 2-parent merge). But if the
    // CLI commit then fails (missing GPG key, failing pre-commit hook), that
    // cleanup would strand the user: a retry reports "No merge in progress" and
    // `abort_merge` has nothing to abort. Snapshot MERGE_HEAD/MERGE_MSG first and
    // restore them on failure so the merge stays resumable.
    let saved_state = if is_squash {
        let repo = git2::Repository::open(Path::new(path))?;
        let git_dir = repo.path().to_path_buf();
        let merge_head_path = git_dir.join("MERGE_HEAD");
        let merge_msg_path = git_dir.join("MERGE_MSG");
        let merge_head = std::fs::read_to_string(&merge_head_path)?;
        let merge_msg = std::fs::read_to_string(&merge_msg_path).ok();
        repo.cleanup_state()?;
        Some((merge_head_path, merge_head, merge_msg_path, merge_msg))
    } else {
        None
    };

    let output = create_command("git")
        .current_dir(path)
        .args(["commit", "-S", "-m", message])
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run git commit: {}", e)))?;

    if !output.status.success() {
        // Restore the merge metadata we cleared so the user can retry or abort.
        // (The resolved index is untouched by cleanup_state.)
        if let Some((merge_head_path, merge_head, merge_msg_path, merge_msg)) = saved_state {
            let _ = std::fs::write(&merge_head_path, merge_head);
            if let Some(msg) = merge_msg {
                let _ = std::fs::write(&merge_msg_path, msg);
            }
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "Git commit failed: {}",
            stderr
        )));
    }

    Ok(())
}

/// Join a command's stdout and stderr into one searchable block.
///
/// Concatenating them directly runs the last line of stdout into the first line
/// of stderr whenever stdout does not end in a newline — and git does not always
/// end it with one. The line that gets mangled is exactly the kind being matched
/// here (`error: could not apply ...`), so the separator is not cosmetic.
fn join_output(stdout: &str, stderr: &str) -> String {
    if stdout.is_empty() {
        return stderr.to_string();
    }
    if stderr.is_empty() {
        return stdout.to_string();
    }
    if stdout.ends_with('\n') {
        format!("{}{}", stdout, stderr)
    } else {
        format!("{}\n{}", stdout, stderr)
    }
}

/// The commit a stopped rebase could not apply, from
/// `error: could not apply <sha> <summary>`.
///
/// Best-effort and cosmetic: git translates this line, so a localized git
/// yields None and the conflict is reported without a commit summary — which is
/// what the field held for every conflict before.
fn stopped_commit_summary(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("error: could not apply ")?;
        let (_sha, summary) = rest.split_once(' ')?;
        let summary = summary.trim();
        (!summary.is_empty()).then(|| summary.to_string())
    })
}

/// Preview a rebase by running it in a temporary worktree (ghost rebase)
#[command]
pub async fn preview_rebase(
    path: String,
    onto: String,
) -> Result<crate::services::ai::RebasePreview> {
    use crate::services::ai::{PredictedConflict, RebasePreview};

    // Reject ref values that could be parsed as a flag, e.g.
    // `--exec=/tmp/payload` would run an arbitrary command via `git rebase`.
    if onto.starts_with('-') {
        return Err(GitnadoError::OperationFailed(
            "Rebase target must not start with '-'".into(),
        ));
    }

    // Create a temp directory for the ghost worktree
    let temp_dir = tempfile::tempdir()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to create temp dir: {}", e)))?;
    let temp_path = temp_dir.path().to_string_lossy().to_string();

    // Add a detached worktree at HEAD
    let add_output = std::process::Command::new("git")
        .arg("-C")
        .arg(&path)
        .arg("worktree")
        .arg("add")
        .arg("--detach")
        .arg(&temp_path)
        .arg("HEAD")
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to create worktree: {}", e)))?;

    if !add_output.status.success() {
        return Err(GitnadoError::OperationFailed(format!(
            "Failed to create worktree: {}",
            String::from_utf8_lossy(&add_output.stderr)
        )));
    }

    // Run rebase in the temp worktree. `--` prevents the user-supplied ref
    // from being parsed as a flag.
    let rebase_output = std::process::Command::new("git")
        .arg("-C")
        .arg(&temp_path)
        .arg("rebase")
        .arg("--")
        .arg(&onto)
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run ghost rebase: {}", e)))?;

    let mut conflicts = Vec::new();
    // A failure that is NOT a conflict — a dirty worktree, an unknown ref. The
    // preview cannot be computed then, and must not be reported as "clean".
    let mut preview_failure: Option<String> = None;

    if !rebase_output.status.success() {
        let combined = join_output(
            &String::from_utf8_lossy(&rebase_output.stdout),
            &String::from_utf8_lossy(&rebase_output.stderr),
        );
        let commit_summary = stopped_commit_summary(&combined).unwrap_or_default();

        // Ask the index which paths are unmerged rather than parsing conflict
        // messages. Those messages go to STDOUT, not the stderr this read — so
        // the scan matched nothing and the preview reported a clean rebase for
        // every conflicting one, the exact opposite of what it exists to say.
        // They are also translated, so an English-only scan would have found
        // nothing on a localized git even with the right stream.
        let unmerged = std::process::Command::new("git")
            .arg("-C")
            .arg(&temp_path)
            .args(["diff", "--name-only", "--diff-filter=U", "-z"])
            .output()
            .ok();

        if let Some(out) = unmerged {
            for file_path in String::from_utf8_lossy(&out.stdout)
                .split('\0')
                .filter(|s| !s.is_empty())
            {
                conflicts.push(PredictedConflict {
                    file_path: file_path.to_string(),
                    commit_summary: commit_summary.clone(),
                });
            }
        }

        if conflicts.is_empty() {
            preview_failure = Some(combined.trim().to_string());
        }

        // Abort the failed rebase in the worktree
        let _ = std::process::Command::new("git")
            .arg("-C")
            .arg(&temp_path)
            .arg("rebase")
            .arg("--abort")
            .output();
    }

    // Count total commits that would be rebased
    let log_output = std::process::Command::new("git")
        .arg("-C")
        .arg(&path)
        .arg("log")
        .arg("--oneline")
        .arg(format!("{}..HEAD", onto))
        .output()
        .ok();

    let total_commits = log_output
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().count())
        .unwrap_or(0);

    // Clean up: remove the temp worktree
    let _ = std::process::Command::new("git")
        .arg("-C")
        .arg(&path)
        .arg("worktree")
        .arg("remove")
        .arg("--force")
        .arg(&temp_path)
        .output();

    // The temp dir will be cleaned up when temp_dir is dropped

    // Reported only after the worktree is removed, so a failed preview does not
    // strand a worktree registration in the user's repository.
    if let Some(message) = preview_failure {
        return Err(GitnadoError::OperationFailed(format!(
            "Could not preview the rebase: {}",
            message
        )));
    }

    // The ghost rebase stops at the FIRST commit it cannot apply, so one stop is
    // all it can observe. `conflicts.len()` is a count of FILES, and using it
    // here reported more conflicting commits than the rebase even has whenever
    // one commit touched several conflicting files.
    let conflicting_commits = usize::from(!conflicts.is_empty());
    let clean_commits = total_commits.saturating_sub(conflicting_commits);

    Ok(RebasePreview {
        total_commits,
        clean_commits,
        conflicting_commits,
        conflicts,
    })
}
