//! Cherry-pick, revert, and reset command handlers

use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::models::Commit;

/// Message git prints when a cherry-pick becomes empty (its changes are already
/// present). Canonical git stops and creates no commit rather than polluting
/// history with an empty commit.
const EMPTY_CHERRY_PICK_MSG: &str = "The cherry-pick is now empty because its changes are already present in HEAD; no commit was created. Skip or abort the cherry-pick to continue.";

/// Message git prints when a revert becomes empty (there is nothing to undo).
const EMPTY_REVERT_MSG: &str = "The revert is now empty because there is nothing to undo; no commit was created. Skip or abort the revert to continue.";

/// Name of the sidecar file tracking the commits still to be applied during a
/// multi-commit cherry-pick sequence (used so `continue` can resume the range).
const CHERRY_PICK_SEQUENCE: &str = "CHERRY_PICK_SEQUENCE";

/// Name of the sidecar file storing the pre-sequence HEAD oid so that aborting a
/// multi-commit cherry-pick rewinds to the exact commit it started from
/// (matching `git cherry-pick --abort`), rather than leaving already-applied
/// picks on the branch.
const CHERRY_PICK_SEQUENCE_HEAD: &str = "CHERRY_PICK_SEQUENCE_HEAD";

/// Refuse to start an index-rewriting operation while the index holds staged
/// work the operation — or a later abort of it — would destroy.
fn ensure_index_matches_head(repo: &git2::Repository) -> Result<()> {
    let head_tree = repo.head()?.peel_to_commit()?.tree()?;
    let mut index = repo.index()?;

    // write_tree fails outright on an index with unmerged entries, and that
    // state is reachable while `state()` is still Clean — a conflicted stash
    // apply leaves it — so answer it before writing rather than leaking a raw
    // libgit2 error. The wording deliberately avoids the word "conflict": the
    // cherry-pick dialog routes any message containing it to the
    // conflict-resolution flow, which has no operation to resolve here.
    if index.has_conflicts() {
        return Err(GitnadoError::OperationFailed(
            "The index has unmerged files. Resolve them before starting this operation."
                .to_string(),
        ));
    }

    if index.write_tree()? != head_tree.id() {
        return Err(GitnadoError::OperationFailed(
            "The index has staged changes. Commit or stash them before starting this operation."
                .to_string(),
        ));
    }

    Ok(())
}

/// Interpret a git path (raw bytes) as a filesystem path.
///
/// git stores paths as bytes, and on unix a name that is not valid UTF-8 is
/// still a perfectly ordinary filename. Routing it through
/// `str::from_utf8(..).unwrap_or("")` turned such a path into the empty string,
/// so `workdir.join(rel)` became the workdir itself and the removal below
/// silently did nothing — a file the aborted operation had ADDED was left
/// behind in the working tree. Returns None only where the platform genuinely
/// cannot represent the bytes.
#[cfg(unix)]
fn git_path_to_pathbuf(bytes: &[u8]) -> Option<std::path::PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    Some(std::path::PathBuf::from(std::ffi::OsStr::from_bytes(bytes)))
}

#[cfg(not(unix))]
fn git_path_to_pathbuf(bytes: &[u8]) -> Option<std::path::PathBuf> {
    std::str::from_utf8(bytes)
        .ok()
        .map(std::path::PathBuf::from)
}

/// Restore the working tree and index to HEAD when aborting a cherry-pick or
/// revert, while preserving uncommitted changes to files the operation did not
/// touch. This mirrors `git cherry-pick --abort` / `git revert --abort`, which
/// use reset --merge semantics and do NOT force-reset the entire working tree.
///
/// A blanket `checkout_head().force()` (the previous behavior) destroys any
/// unrelated uncommitted work, so we instead force-checkout ONLY the paths the
/// aborted operation actually affected (its conflicted paths plus any path whose
/// staged content differs from HEAD).
fn restore_after_abort(repo: &git2::Repository) -> Result<()> {
    let head_commit = repo.head()?.peel_to_commit()?;
    let head_tree = head_commit.tree()?;
    let mut index = repo.index()?;

    // Collect exactly the paths the operation touched.
    let mut affected: std::collections::BTreeSet<Vec<u8>> = std::collections::BTreeSet::new();

    if let Ok(conflicts) = index.conflicts() {
        for conflict in conflicts.flatten() {
            if let Some(entry) = conflict.our.or(conflict.their).or(conflict.ancestor) {
                affected.insert(entry.path);
            }
        }
    }

    let diff = repo.diff_tree_to_index(Some(&head_tree), Some(&index), None)?;
    for delta in diff.deltas() {
        if let Some(p) = delta.new_file().path_bytes() {
            affected.insert(p.to_vec());
        }
        if let Some(p) = delta.old_file().path_bytes() {
            affected.insert(p.to_vec());
        }
    }

    // Reset the index to HEAD so conflict stages are cleared.
    index.read_tree(&head_tree)?;
    index.write()?;

    if affected.is_empty() {
        return Ok(());
    }

    // Files the operation ADDED are absent from HEAD, so a path-scoped checkout
    // has nothing to write for them and would leave them behind. Delete them
    // from the working tree explicitly (still scoped to operation paths, so
    // unrelated untracked files are untouched).
    if let Some(workdir) = repo.workdir() {
        for path in &affected {
            let Some(rel) = git_path_to_pathbuf(path) else {
                continue;
            };
            if head_tree.get_path(&rel).is_err() {
                let _ = std::fs::remove_file(workdir.join(&rel));
            }
        }
    }

    // Force-checkout only the affected paths; unrelated dirty files survive.
    // disable_pathspec_match is what makes that true: CheckoutBuilder::path()
    // takes a pathspec, so an affected file named e.g. `a[1].txt` would
    // otherwise also force-restore `a1.txt` and destroy its uncommitted work.
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.force();
    checkout.disable_pathspec_match(true);
    for path in &affected {
        checkout.path(path.as_slice());
    }
    repo.checkout_head(Some(&mut checkout))?;

    Ok(())
}

/// What a single sequencer pick did.
///
/// git's sequencer distinguishes three outcomes and each needs different
/// bookkeeping from the caller. Signalling "empty" through `Err` (as this used
/// to) meant the caller's `?` returned before it could record the commits still
/// queued behind the stop, so the rest of a range was silently dropped.
enum PickOutcome {
    /// The pick was applied and committed. Boxed so the stop variants — which
    /// are the common ones a caller matches on — do not each carry a Commit's
    /// worth of padding.
    Applied(Box<Commit>),
    /// The pick conflicted; CHERRY_PICK_HEAD is left in place for the caller.
    Conflicted,
    /// The pick's changes are already present in HEAD, so git stops and creates
    /// no commit. CHERRY_PICK_HEAD is left in place so it can be skipped.
    Empty,
}

/// Apply a single non-merge commit as a cherry-pick onto the current HEAD and
/// create the resulting commit, matching canonical git semantics:
/// - refuses root commits and merge commits (a merge needs an explicit mainline);
/// - stops (creates no commit) when the result would be empty;
/// - runs the post-commit hook git's sequencer runs.
///
/// Returns `PickOutcome::Applied` on success, `PickOutcome::Conflicted` when the
/// pick conflicts and `PickOutcome::Empty` when it is already applied — the last
/// two both leave the repository in cherry-pick state with CHERRY_PICK_HEAD
/// written so the caller can persist sequencer state. `Err` is reserved for hard
/// failures.
fn cherry_pick_one(repo: &git2::Repository, commit: &git2::Commit) -> Result<PickOutcome> {
    if commit.parent_count() == 0 {
        return Err(GitnadoError::OperationFailed(format!(
            "Cannot cherry-pick root commit {}",
            commit.id()
        )));
    }
    if commit.parent_count() > 1 {
        return Err(GitnadoError::OperationFailed(format!(
            "Commit {} is a merge but no mainline parent was given; refusing to cherry-pick a merge commit without an explicit mainline.",
            commit.id()
        )));
    }

    let mut checkout_builder = git2::build::CheckoutBuilder::new();
    checkout_builder
        .allow_conflicts(true)
        .conflict_style_merge(true);
    let mut opts = git2::CherrypickOptions::new();
    opts.checkout_builder(checkout_builder);

    repo.cherrypick(commit, Some(&mut opts))?;

    let mut index = repo.index()?;
    if index.has_conflicts() {
        return Ok(PickOutcome::Conflicted);
    }

    let head = repo.head()?.peel_to_commit()?;
    let tree_oid = index.write_tree()?;
    if tree_oid == head.tree_id() {
        return Ok(PickOutcome::Empty);
    }
    let tree = repo.find_tree(tree_oid)?;
    let signature = repo.signature()?;

    // git cherry-pick preserves the ORIGINAL author and records the current
    // user as committer at the current time. git2's signature is
    // commit(update_ref, author, committer, ..) — passing them the other way
    // round credits the picker as author and back-dates the committer time to
    // the original commit, which also breaks the max(author, committer) graph
    // ordering.
    let new_oid = repo.commit(
        Some("HEAD"),
        &commit.author(),
        &signature,
        commit.message().unwrap_or(""),
        &tree,
        &[&head],
    )?;

    repo.cleanup_state()?;
    // The sequencer runs post-commit (but not pre-commit / commit-msg) for each
    // cherry-picked commit. (prepare-commit-msg is not run here: this path never
    // opens an editor, a documented deviation from githooks(5).)
    crate::commands::hooks::run_hook_noblock(repo, "post-commit", &[]);

    let new_commit = repo.find_commit(new_oid)?;
    Ok(PickOutcome::Applied(Box::new(Commit::from_git2(
        &new_commit,
    ))))
}

/// Persist multi-commit cherry-pick sequencer state on a conflict: the commits
/// still to apply and the HEAD the sequence started from (for abort rewind).
fn write_sequencer_state(
    repo: &git2::Repository,
    pre_sequence_head: git2::Oid,
    remaining: &[String],
) -> Result<()> {
    std::fs::write(
        repo.path().join(CHERRY_PICK_SEQUENCE_HEAD),
        pre_sequence_head.to_string(),
    )?;
    std::fs::write(repo.path().join(CHERRY_PICK_SEQUENCE), remaining.join("\n"))?;
    Ok(())
}

/// Remove the multi-commit cherry-pick sequencer sidecar files.
fn clear_sequencer_state(repo: &git2::Repository) {
    let _ = std::fs::remove_file(repo.path().join(CHERRY_PICK_SEQUENCE));
    let _ = std::fs::remove_file(repo.path().join(CHERRY_PICK_SEQUENCE_HEAD));
}

/// Drop the sequencer sidecar when a hard error left no cherry-pick in progress.
///
/// The sidecar is written before the first pick so an abort can rewind the whole
/// range — including when the sequence stops on an already-applied (empty) pick,
/// which returns `Err` while deliberately leaving CHERRY_PICK_HEAD in place.
/// But an error that leaves NO cherry-pick in progress leaves nothing to abort,
/// and the files then outlive the operation entirely: a later, unrelated
/// cherry-pick that conflicts would have its abort read this stale
/// CHERRY_PICK_SEQUENCE_HEAD and rewind the branch past commits the aborted
/// operation never touched, silently discarding committed work.
fn clear_sequencer_state_if_not_in_progress(repo: &git2::Repository) {
    if !repo.path().join("CHERRY_PICK_HEAD").exists() {
        clear_sequencer_state(repo);
    }
}

/// Resolve every commit in a cherry-pick sequence, refusing the whole sequence
/// if any of them cannot be picked.
///
/// git validates the set before applying any of it. Discovering at commit 4 of 6
/// that the user multi-selected a merge commit — easy to do in the graph — and
/// erroring out there leaves three picks already committed and a half-applied
/// range nobody asked for. Checking first means the sequence either starts or
/// does not.
fn resolve_sequence<'repo>(
    repo: &'repo git2::Repository,
    commit_oids: &[String],
) -> Result<Vec<git2::Commit<'repo>>> {
    let mut commits = Vec::with_capacity(commit_oids.len());

    for commit_oid in commit_oids {
        let oid = git2::Oid::from_str(commit_oid)
            .map_err(|_| GitnadoError::CommitNotFound(commit_oid.clone()))?;
        let commit = repo
            .find_commit(oid)
            .map_err(|_| GitnadoError::CommitNotFound(commit_oid.clone()))?;

        // Same refusals cherry_pick_one makes, hoisted ahead of the first pick.
        if commit.parent_count() == 0 {
            return Err(GitnadoError::OperationFailed(format!(
                "Cannot cherry-pick root commit {}",
                commit.id()
            )));
        }
        if commit.parent_count() > 1 {
            return Err(GitnadoError::OperationFailed(format!(
                "Commit {} is a merge but no mainline parent was given; refusing to cherry-pick a merge commit without an explicit mainline.",
                commit.id()
            )));
        }

        commits.push(commit);
    }

    Ok(commits)
}

/// Apply the commits still queued in CHERRY_PICK_SEQUENCE — git's sequencer
/// resuming a range after a stop. Returns the last commit it created, or None
/// when nothing was queued.
///
/// On a fresh stop (conflict or empty pick) it rewrites the sequence file with
/// the commits AFTER the one that stopped, so the next continue/skip resumes
/// from the right place instead of re-attempting the commit that just stopped.
/// CHERRY_PICK_SEQUENCE_HEAD is deliberately left alone: an abort must still
/// rewind to the commit the whole range started from.
fn resume_sequence(repo: &git2::Repository) -> Result<Option<Commit>> {
    let seq_path = repo.path().join(CHERRY_PICK_SEQUENCE);
    let contents = match std::fs::read_to_string(&seq_path) {
        Ok(contents) => contents,
        // No sequence file: this was a single pick, not a range. Nothing queued,
        // nothing to resume.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            clear_sequencer_state(repo);
            return Ok(None);
        }
        // The file IS there but unreadable (permissions, corruption, a
        // half-written line). It still names commits the user asked for, so
        // treating it as "nothing queued" would report the cherry-pick as
        // finished and drop the rest of the range without a word. Surface it
        // instead, and drop the sidecar only when no cherry-pick is left in
        // progress — the same rule the resolve failure below follows, so a
        // stale CHERRY_PICK_SEQUENCE_HEAD can never rewind a later, unrelated
        // abort past commits it never touched.
        Err(e) => {
            clear_sequencer_state_if_not_in_progress(repo);
            return Err(GitnadoError::OperationFailed(format!(
                "Could not read the queued cherry-pick sequence: {}",
                e
            )));
        }
    };

    let remaining: Vec<String> = contents
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    // Check the remainder before resuming it, for the same reason the initial
    // range is checked: stopping partway leaves picks applied that no abort path
    // accounts for.
    let commits = match resolve_sequence(repo, &remaining) {
        Ok(commits) => commits,
        Err(e) => {
            clear_sequencer_state_if_not_in_progress(repo);
            return Err(e);
        }
    };

    let mut last = None;
    for (i, commit) in commits.iter().enumerate() {
        // The commits still pending AFTER this one. Written on every stop so a
        // second continue/skip never re-attempts the commit that just stopped.
        let still: Vec<String> = remaining.iter().skip(i + 1).cloned().collect();
        match cherry_pick_one(repo, commit) {
            Ok(PickOutcome::Applied(c)) => last = Some(*c),
            Ok(PickOutcome::Conflicted) => {
                std::fs::write(&seq_path, still.join("\n"))?;
                return Err(GitnadoError::CherryPickConflict);
            }
            Ok(PickOutcome::Empty) => {
                std::fs::write(&seq_path, still.join("\n"))?;
                return Err(GitnadoError::OperationFailed(
                    EMPTY_CHERRY_PICK_MSG.to_string(),
                ));
            }
            Err(e) => {
                clear_sequencer_state_if_not_in_progress(repo);
                return Err(e);
            }
        }
    }

    clear_sequencer_state(repo);
    Ok(last)
}

/// Cherry-pick a commit onto the current branch
///
/// Options:
/// - `no_commit`: If true, stages changes without committing (like `git cherry-pick -n`)
#[command]
pub async fn cherry_pick(
    path: String,
    commit_oid: String,
    no_commit: Option<bool>,
    mainline: Option<u32>,
) -> Result<Commit> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let no_commit = no_commit.unwrap_or(false);

    // Check for existing operations in progress
    if repo.state() != git2::RepositoryState::Clean {
        match repo.state() {
            git2::RepositoryState::CherryPick | git2::RepositoryState::CherryPickSequence => {
                return Err(GitnadoError::CherryPickInProgress);
            }
            git2::RepositoryState::Revert | git2::RepositoryState::RevertSequence => {
                return Err(GitnadoError::RevertInProgress);
            }
            git2::RepositoryState::Rebase
            | git2::RepositoryState::RebaseInteractive
            | git2::RepositoryState::RebaseMerge => {
                return Err(GitnadoError::RebaseInProgress);
            }
            _ => {
                return Err(GitnadoError::OperationFailed(
                    "Another operation is in progress".to_string(),
                ));
            }
        }
    }
    ensure_index_matches_head(&repo)?;

    // Find the commit to cherry-pick
    let oid = git2::Oid::from_str(&commit_oid)
        .map_err(|_| GitnadoError::CommitNotFound(commit_oid.clone()))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|_| GitnadoError::CommitNotFound(commit_oid.clone()))?;

    // Verify commit has a parent (can't cherry-pick root commit)
    if commit.parent_count() == 0 {
        return Err(GitnadoError::OperationFailed(
            "Cannot cherry-pick root commit".to_string(),
        ));
    }

    // Use repo.cherrypick() which properly updates working directory and index
    let mut checkout_builder = git2::build::CheckoutBuilder::new();
    checkout_builder
        .allow_conflicts(true)
        .conflict_style_merge(true);

    let mut opts = git2::CherrypickOptions::new();
    opts.checkout_builder(checkout_builder);

    // Merge commits are ambiguous: git refuses to cherry-pick one unless the
    // caller picks which parent's diff to apply via an explicit mainline.
    if commit.parent_count() > 1 {
        match mainline {
            Some(m) if m >= 1 && m <= commit.parent_count() as u32 => {
                opts.mainline(m);
            }
            Some(m) => {
                return Err(GitnadoError::OperationFailed(format!(
                    "Mainline {} is out of range: commit {} has {} parents.",
                    m,
                    commit_oid,
                    commit.parent_count()
                )));
            }
            None => {
                return Err(GitnadoError::OperationFailed(format!(
                    "Commit {} is a merge but no mainline parent was given; choose which parent to cherry-pick relative to.",
                    commit_oid
                )));
            }
        }
    }

    repo.cherrypick(&commit, Some(&mut opts))?;

    // Check if there are conflicts
    let mut index = repo.index()?;
    let has_conflicts = index.has_conflicts();
    tracing::debug!(
        "Cherry-pick completed. has_conflicts: {}, repo_state: {:?}, no_commit: {}",
        has_conflicts,
        repo.state(),
        no_commit
    );

    if has_conflicts {
        tracing::debug!("Returning CherryPickConflict error");
        return Err(GitnadoError::CherryPickConflict);
    }

    // If no_commit is true, just stage the changes without committing
    if no_commit {
        // Clean up cherry-pick state but keep the staged changes
        repo.cleanup_state()?;
        // Return the original commit info since we didn't create a new one
        return Ok(Commit::from_git2(&commit));
    }

    // No conflicts - the working directory and index are updated, now create the commit
    let head = repo.head()?.peel_to_commit()?;
    let tree_oid = index.write_tree()?;

    // If the pick is already applied the result is empty; git stops here (leaving
    // CHERRY_PICK_HEAD in place) instead of creating an empty commit.
    if tree_oid == head.tree_id() {
        return Err(GitnadoError::OperationFailed(
            EMPTY_CHERRY_PICK_MSG.to_string(),
        ));
    }

    let tree = repo.find_tree(tree_oid)?;
    let signature = repo.signature()?;

    // Original author preserved, current user recorded as committer — see
    // cherry_pick_one for why the argument order matters.
    let new_oid = repo.commit(
        Some("HEAD"),
        &commit.author(),
        &signature,
        commit.message().unwrap_or(""),
        &tree,
        &[&head],
    )?;

    // Clean up cherry-pick state
    repo.cleanup_state()?;
    // The sequencer runs post-commit for the cherry-picked commit.
    crate::commands::hooks::run_hook_noblock(&repo, "post-commit", &[]);

    let new_commit = repo.find_commit(new_oid)?;
    Ok(Commit::from_git2(&new_commit))
}

/// Continue a cherry-pick after resolving conflicts
#[command]
pub async fn continue_cherry_pick(path: String) -> Result<Commit> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Check if we're actually in a cherry-pick state. Resolve the state file via
    // repo.path() so this works in linked worktrees (where <wt>/.git is a file).
    let cherry_pick_head_path = repo.path().join("CHERRY_PICK_HEAD");
    if !cherry_pick_head_path.exists() {
        return Err(GitnadoError::OperationFailed(
            "No cherry-pick in progress".to_string(),
        ));
    }

    // Read the original commit OID
    let original_oid_str = std::fs::read_to_string(&cherry_pick_head_path)?
        .trim()
        .to_string();
    let original_oid = git2::Oid::from_str(&original_oid_str)
        .map_err(|_| GitnadoError::CommitNotFound(original_oid_str.clone()))?;
    let original_commit = repo.find_commit(original_oid)?;

    // Check for remaining conflicts
    let mut index = repo.index()?;
    if index.has_conflicts() {
        return Err(GitnadoError::CherryPickConflict);
    }

    // Get the current HEAD
    let head = repo.head()?.peel_to_commit()?;

    // Create the commit
    let tree_oid = index.write_tree()?;

    // A conflict resolution that leaves nothing to apply is empty; git stops
    // rather than recording an empty commit.
    if tree_oid == head.tree_id() {
        return Err(GitnadoError::OperationFailed(
            EMPTY_CHERRY_PICK_MSG.to_string(),
        ));
    }

    let tree = repo.find_tree(tree_oid)?;
    let signature = repo.signature()?;

    // Original author preserved, current user recorded as committer — see
    // cherry_pick_one for why the argument order matters.
    let new_oid = repo.commit(
        Some("HEAD"),
        &original_commit.author(),
        &signature,
        original_commit.message().unwrap_or(""),
        &tree,
        &[&head],
    )?;

    // Clean up cherry-pick state for the resolved commit.
    let _ = std::fs::remove_file(&cherry_pick_head_path);
    repo.cleanup_state()?;
    crate::commands::hooks::run_hook_noblock(&repo, "post-commit", &[]);

    let mut last = {
        let new_commit = repo.find_commit(new_oid)?;
        Commit::from_git2(&new_commit)
    };

    // If this cherry-pick was part of a multi-commit sequence, apply the
    // remaining commits now (the real sequencer resumes automatically).
    if let Some(resumed) = resume_sequence(&repo)? {
        last = resumed;
    }

    Ok(last)
}

/// Skip the stopped cherry-pick and resume the rest of the sequence
/// (`git cherry-pick --skip`).
///
/// The stopped pick is dropped — reset --merge semantics, so unrelated
/// uncommitted work survives — and any commits still queued in
/// CHERRY_PICK_SEQUENCE are applied. Unlike abort, picks already applied earlier
/// in the range STAY, so this is the only exit from an already-applied
/// (empty) pick that does not throw the whole range away. Returns the last
/// commit the resumed sequence created, or None when nothing was left to apply.
#[command]
pub async fn skip_cherry_pick(path: String) -> Result<Option<Commit>> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // git refuses to skip when no cherry-pick is in progress and leaves the
    // working tree untouched. Resolve via repo.path() (worktree-safe).
    let cherry_pick_head_path = repo.path().join("CHERRY_PICK_HEAD");
    if !cherry_pick_head_path.exists() {
        return Err(GitnadoError::OperationFailed(
            "There is no cherry-pick in progress to skip.".to_string(),
        ));
    }

    // Drop the stopped pick's changes (its conflict stages, or nothing at all
    // when it stopped because it was already applied). Deliberately does NOT
    // read CHERRY_PICK_SEQUENCE_HEAD — skip keeps earlier picks; only abort
    // rewinds them.
    restore_after_abort(&repo)?;
    let _ = std::fs::remove_file(&cherry_pick_head_path);
    repo.cleanup_state()?;

    // The sequencer sidecars are NOT cleared first: if the resumed range stops
    // again, a later abort still has to rewind to the original pre-sequence
    // HEAD. resume_sequence clears them when the range actually finishes.
    resume_sequence(&repo)
}

/// Abort a cherry-pick in progress
#[command]
pub async fn abort_cherry_pick(path: String) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // git refuses to abort when no cherry-pick is in progress and leaves the
    // working tree untouched; blindly force-resetting here would destroy
    // uncommitted work. Resolve the state file via repo.path() (worktree-safe).
    let cherry_pick_head_path = repo.path().join("CHERRY_PICK_HEAD");
    if !cherry_pick_head_path.exists() {
        return Err(GitnadoError::OperationFailed(
            "There is no cherry-pick in progress to abort.".to_string(),
        ));
    }

    // If this was a multi-commit sequence, rewind HEAD to the commit the
    // sequence started from so already-applied picks are removed too.
    if let Ok(head_str) = std::fs::read_to_string(repo.path().join(CHERRY_PICK_SEQUENCE_HEAD)) {
        if let Ok(pre_seq_oid) = git2::Oid::from_str(head_str.trim()) {
            let head_ref = repo.head()?;
            if head_ref.is_branch() {
                let branch_name = head_ref.shorthand().unwrap_or("HEAD");
                let refname = format!("refs/heads/{}", branch_name);
                repo.reference(&refname, pre_seq_oid, true, "cherry-pick: abort")?;
            } else {
                repo.set_head_detached(pre_seq_oid)?;
            }
        }
    }

    // Restore the working tree to (the possibly rewound) HEAD, preserving
    // unrelated uncommitted changes.
    restore_after_abort(&repo)?;

    repo.cleanup_state()?;
    clear_sequencer_state(&repo);

    Ok(())
}

/// Revert a commit (create a new commit that undoes the changes)
#[command]
pub async fn revert(path: String, commit_oid: String, mainline: Option<u32>) -> Result<Commit> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Check for existing operations in progress
    if repo.state() != git2::RepositoryState::Clean {
        return Err(GitnadoError::OperationFailed(
            "Another operation is in progress".to_string(),
        ));
    }
    ensure_index_matches_head(&repo)?;

    // Find the commit to revert
    let oid = git2::Oid::from_str(&commit_oid)
        .map_err(|_| GitnadoError::CommitNotFound(commit_oid.clone()))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|_| GitnadoError::CommitNotFound(commit_oid.clone()))?;

    // Verify commit has a parent (can't revert root commit)
    if commit.parent_count() == 0 {
        return Err(GitnadoError::OperationFailed(
            "Cannot revert root commit".to_string(),
        ));
    }

    // Use repo.revert() which properly updates working directory and index
    let mut checkout_builder = git2::build::CheckoutBuilder::new();
    checkout_builder
        .allow_conflicts(true)
        .conflict_style_merge(true);

    let mut opts = git2::RevertOptions::new();
    opts.checkout_builder(checkout_builder);

    // Merge commits are ambiguous: git refuses to revert one unless the caller
    // picks which parent's change to undo via an explicit mainline.
    if commit.parent_count() > 1 {
        match mainline {
            Some(m) if m >= 1 && m <= commit.parent_count() as u32 => {
                opts.mainline(m);
            }
            Some(m) => {
                return Err(GitnadoError::OperationFailed(format!(
                    "Mainline {} is out of range: commit {} has {} parents.",
                    m,
                    commit_oid,
                    commit.parent_count()
                )));
            }
            None => {
                return Err(GitnadoError::OperationFailed(format!(
                    "Commit {} is a merge but no mainline parent was given; choose which parent to revert relative to.",
                    commit_oid
                )));
            }
        }
    }

    repo.revert(&commit, Some(&mut opts))?;

    // Check if there are conflicts
    let mut index = repo.index()?;
    if index.has_conflicts() {
        return Err(GitnadoError::RevertConflict);
    }

    // No conflicts - the working directory and index are updated, now create the commit
    let head = repo.head()?.peel_to_commit()?;
    let tree_oid = index.write_tree()?;

    // A revert that changes nothing is empty; git stops rather than recording an
    // empty commit (leaving REVERT_HEAD in place).
    if tree_oid == head.tree_id() {
        return Err(GitnadoError::OperationFailed(EMPTY_REVERT_MSG.to_string()));
    }

    let tree = repo.find_tree(tree_oid)?;
    let signature = repo.signature()?;

    let summary = commit.summary().ok().flatten().unwrap_or("").to_string();
    let revert_message = if commit.parent_count() > 1 {
        // Reverting a merge: git records which parent the changes were made to.
        let m = mainline.unwrap_or(1);
        let parent_oid = commit
            .parent((m - 1) as usize)
            .map(|p| p.id().to_string())
            .unwrap_or_default();
        format!(
            "Revert \"{}\"\n\nThis reverts commit {}, reversing\nchanges made to {}.",
            summary, commit_oid, parent_oid
        )
    } else {
        format!(
            "Revert \"{}\"\n\nThis reverts commit {}.",
            summary, commit_oid
        )
    };

    let new_oid = repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        &revert_message,
        &tree,
        &[&head],
    )?;

    // Clean up revert state
    repo.cleanup_state()?;
    crate::commands::hooks::run_hook_noblock(&repo, "post-commit", &[]);

    let new_commit = repo.find_commit(new_oid)?;
    Ok(Commit::from_git2(&new_commit))
}

/// Continue a revert after resolving conflicts
#[command]
pub async fn continue_revert(path: String) -> Result<Commit> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Check if we're actually in a revert state. Resolve via repo.path() so this
    // works in linked worktrees (where <wt>/.git is a file, not a directory).
    let revert_head_path = repo.path().join("REVERT_HEAD");
    if !revert_head_path.exists() {
        return Err(GitnadoError::OperationFailed(
            "No revert in progress".to_string(),
        ));
    }

    // Read the original commit OID
    let original_oid_str = std::fs::read_to_string(&revert_head_path)?
        .trim()
        .to_string();
    let original_oid = git2::Oid::from_str(&original_oid_str)
        .map_err(|_| GitnadoError::CommitNotFound(original_oid_str.clone()))?;
    let original_commit = repo.find_commit(original_oid)?;

    // Check for remaining conflicts
    let mut index = repo.index()?;
    if index.has_conflicts() {
        return Err(GitnadoError::RevertConflict);
    }

    // Get the current HEAD
    let head = repo.head()?.peel_to_commit()?;

    // Create the revert commit
    let tree_oid = index.write_tree()?;

    // A conflict resolution that undoes nothing is empty; git stops rather than
    // recording an empty commit.
    if tree_oid == head.tree_id() {
        return Err(GitnadoError::OperationFailed(EMPTY_REVERT_MSG.to_string()));
    }

    let tree = repo.find_tree(tree_oid)?;
    let signature = repo.signature()?;

    let revert_message = format!(
        "Revert \"{}\"\n\nThis reverts commit {}.",
        original_commit.summary().ok().flatten().unwrap_or(""),
        original_oid_str
    );

    let new_oid = repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        &revert_message,
        &tree,
        &[&head],
    )?;

    // Clean up revert state
    let _ = std::fs::remove_file(&revert_head_path);
    repo.cleanup_state()?;
    crate::commands::hooks::run_hook_noblock(&repo, "post-commit", &[]);

    let new_commit = repo.find_commit(new_oid)?;
    Ok(Commit::from_git2(&new_commit))
}

/// Skip the stopped revert (`git revert --skip`): drop its changes and end the
/// operation.
///
/// Reverts here are always single-commit, so there is no queued remainder to
/// resume — but the empty-revert message promises a skip, and skipping (unlike
/// aborting) is not framed as rolling anything back.
#[command]
pub async fn skip_revert(path: String) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // git refuses to skip when no revert is in progress and leaves the working
    // tree untouched. Resolve via repo.path() (worktree-safe).
    let revert_head_path = repo.path().join("REVERT_HEAD");
    if !revert_head_path.exists() {
        return Err(GitnadoError::OperationFailed(
            "There is no revert in progress to skip.".to_string(),
        ));
    }

    // Drop the stopped revert's changes, preserving unrelated uncommitted work.
    restore_after_abort(&repo)?;
    let _ = std::fs::remove_file(&revert_head_path);
    repo.cleanup_state()?;

    Ok(())
}

/// Abort a revert in progress
#[command]
pub async fn abort_revert(path: String) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // git refuses to abort when no revert is in progress and leaves the working
    // tree untouched; blindly force-resetting here would destroy uncommitted
    // work. Resolve the state file via repo.path() (worktree-safe).
    let revert_head_path = repo.path().join("REVERT_HEAD");
    if !revert_head_path.exists() {
        return Err(GitnadoError::OperationFailed(
            "There is no revert in progress to abort.".to_string(),
        ));
    }

    // Restore the working tree to HEAD, preserving unrelated uncommitted changes.
    restore_after_abort(&repo)?;

    repo.cleanup_state()?;

    Ok(())
}

/// Cherry-pick a range of commits onto the current branch (oldest first order)
#[command]
pub async fn cherry_pick_range(path: String, commit_oids: Vec<String>) -> Result<Vec<Commit>> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Check for existing operations in progress
    if repo.state() != git2::RepositoryState::Clean {
        return Err(GitnadoError::OperationFailed(
            "Another operation is in progress".to_string(),
        ));
    }
    ensure_index_matches_head(&repo)?;

    if commit_oids.is_empty() {
        return Err(GitnadoError::OperationFailed(
            "No commits specified for cherry-pick".to_string(),
        ));
    }

    // Resolve and check the whole set before touching the repository, so a
    // commit the sequence was never going to accept is refused with nothing
    // applied rather than partway through.
    let commits = resolve_sequence(&repo, &commit_oids)?;

    // Record the HEAD the sequence starts from so an abort mid-sequence can
    // rewind to it (matching git's return-to-pre-sequence-HEAD on --abort).
    // Persist it up front: a mid-range pick can stop not only on a conflict but
    // on an already-applied (empty) pick, which returns Err before the conflict
    // branch runs — yet still leaves CHERRY_PICK_HEAD and earlier picks applied.
    // Writing the sequence head now lets abort_cherry_pick rewind the whole
    // range regardless of how the sequence stops.
    let pre_sequence_head = repo.head()?.peel_to_commit()?.id();
    std::fs::write(
        repo.path().join(CHERRY_PICK_SEQUENCE_HEAD),
        pre_sequence_head.to_string(),
    )?;

    let mut results = Vec::new();

    for (i, commit) in commits.iter().enumerate() {
        // The commits still pending AFTER this one, persisted on any stop so
        // continue/skip resume from the right place.
        let remaining: Vec<String> = commit_oids.iter().skip(i + 1).cloned().collect();
        match cherry_pick_one(&repo, commit) {
            Ok(PickOutcome::Applied(new_commit)) => results.push(*new_commit),
            Ok(PickOutcome::Conflicted) => {
                // Conflict: persist the not-yet-applied commits and the
                // pre-sequence HEAD so continue/abort behave like git's
                // sequencer.
                write_sequencer_state(&repo, pre_sequence_head, &remaining)?;
                return Err(GitnadoError::CherryPickConflict);
            }
            Ok(PickOutcome::Empty) => {
                // git's sequencer stops on an already-applied pick but keeps the
                // REST of the range queued so `--skip` can resume it. Without
                // this the remainder was dropped on the floor and Abort — which
                // rewinds every applied pick — was the only way out.
                write_sequencer_state(&repo, pre_sequence_head, &remaining)?;
                return Err(GitnadoError::OperationFailed(
                    EMPTY_CHERRY_PICK_MSG.to_string(),
                ));
            }
            Err(e) => {
                clear_sequencer_state_if_not_in_progress(&repo);
                return Err(e);
            }
        }
    }

    clear_sequencer_state(&repo);

    Ok(results)
}

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

/// Cherry-pick commits from the tip of a branch by name
///
/// Resolves the given branch name to its tip commit and cherry-picks
/// the most recent `count` commits (default 1) onto the current branch.
/// Commits are applied oldest-first.
///
/// # Arguments
/// * `path` - Repository path
/// * `branch` - Branch name to cherry-pick from
/// * `count` - Number of commits from the tip to cherry-pick (default 1)
#[command]
pub async fn cherry_pick_from_branch(
    path: String,
    branch: String,
    count: Option<u32>,
) -> Result<Vec<Commit>> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Check for existing operations in progress
    if repo.state() != git2::RepositoryState::Clean {
        match repo.state() {
            git2::RepositoryState::CherryPick | git2::RepositoryState::CherryPickSequence => {
                return Err(GitnadoError::CherryPickInProgress);
            }
            git2::RepositoryState::Revert | git2::RepositoryState::RevertSequence => {
                return Err(GitnadoError::RevertInProgress);
            }
            git2::RepositoryState::Rebase
            | git2::RepositoryState::RebaseInteractive
            | git2::RepositoryState::RebaseMerge => {
                return Err(GitnadoError::RebaseInProgress);
            }
            _ => {
                return Err(GitnadoError::OperationFailed(
                    "Another operation is in progress".to_string(),
                ));
            }
        }
    }
    ensure_index_matches_head(&repo)?;

    let count = count.unwrap_or(1);
    if count == 0 {
        return Err(GitnadoError::OperationFailed(
            "Count must be at least 1".to_string(),
        ));
    }

    // Resolve the branch name to a commit
    let branch_ref = repo
        .find_branch(&branch, git2::BranchType::Local)
        .or_else(|_| repo.find_branch(&branch, git2::BranchType::Remote))
        .map_err(|_| GitnadoError::BranchNotFound(branch.clone()))?;

    let tip_oid = branch_ref
        .get()
        .target()
        .ok_or_else(|| GitnadoError::BranchNotFound(branch.clone()))?;

    // Walk backwards from the tip to collect `count` commits (oldest first)
    let mut revwalk = repo.revwalk()?;
    revwalk.push(tip_oid)?;
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL)?;

    let mut commit_oids: Vec<git2::Oid> = Vec::new();
    for oid_result in revwalk {
        if commit_oids.len() >= count as usize {
            break;
        }
        let oid = oid_result?;
        commit_oids.push(oid);
    }

    if commit_oids.is_empty() {
        return Err(GitnadoError::OperationFailed(
            "No commits found on the specified branch".to_string(),
        ));
    }

    // Reverse so we apply oldest first
    commit_oids.reverse();

    // The tip of a branch can easily be — or sit above — a merge commit, so
    // check the whole set before applying any of it rather than stopping partway
    // through with picks already committed.
    let commit_oids: Vec<String> = commit_oids.iter().map(|o| o.to_string()).collect();
    let commits = resolve_sequence(&repo, &commit_oids)?;

    // Record the pre-sequence HEAD for abort rewind. Persist it up front so an
    // abort can rewind the whole range even when the sequence stops on an
    // already-applied (empty) pick, which returns Err before the conflict
    // branch writes the sequencer state.
    let pre_sequence_head = repo.head()?.peel_to_commit()?.id();
    std::fs::write(
        repo.path().join(CHERRY_PICK_SEQUENCE_HEAD),
        pre_sequence_head.to_string(),
    )?;

    // Cherry-pick each commit
    let mut results = Vec::new();

    for (i, commit) in commits.iter().enumerate() {
        let remaining: Vec<String> = commit_oids.iter().skip(i + 1).cloned().collect();
        match cherry_pick_one(&repo, commit) {
            Ok(PickOutcome::Applied(new_commit)) => results.push(*new_commit),
            Ok(PickOutcome::Conflicted) => {
                write_sequencer_state(&repo, pre_sequence_head, &remaining)?;
                return Err(GitnadoError::CherryPickConflict);
            }
            Ok(PickOutcome::Empty) => {
                // Keep the rest of the range queued so Skip can resume it — see
                // cherry_pick_range's Empty arm.
                write_sequencer_state(&repo, pre_sequence_head, &remaining)?;
                return Err(GitnadoError::OperationFailed(
                    EMPTY_CHERRY_PICK_MSG.to_string(),
                ));
            }
            Err(e) => {
                clear_sequencer_state_if_not_in_progress(&repo);
                return Err(e);
            }
        }
    }

    clear_sequencer_state(&repo);

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[tokio::test]
    async fn test_reset_is_allowed_mid_merge() {
        // `git reset` is the documented way to back out of a conflicted merge.
        // A blanket `state() != Clean` refused it here while the reflog
        // dialog's reset — same operation, same confirm copy — allowed it.
        let repo = TestRepo::with_initial_commit();
        let base = repo.head_oid().to_string();
        let main_branch = repo.current_branch();
        repo.create_branch("feature");
        repo.create_commit("on main", &[("f.txt", "main side")]);
        repo.checkout_branch("feature");
        repo.create_commit("on feature", &[("f.txt", "feature side")]);
        repo.checkout_branch(&main_branch);

        // Leave a conflicted merge in progress.
        let _ =
            crate::commands::merge::merge(repo.path_str(), "feature".to_string(), None, None, None)
                .await;
        assert_ne!(
            repo.repo().state(),
            git2::RepositoryState::Clean,
            "the merge must actually be in progress for this to mean anything"
        );

        reset(repo.path_str(), base, "hard".to_string())
            .await
            .expect("reset must back out of a conflicted merge");
    }

    #[tokio::test]
    async fn test_reset_is_still_refused_mid_rebase() {
        // The states ensure_resettable does refuse are the ones where libgit2's
        // state cleanup would silently destroy the in-progress operation.
        let repo = TestRepo::with_initial_commit();
        let base = repo.head_oid().to_string();
        std::fs::write(
            repo.path.join(".git").join("REBASE_HEAD"),
            format!("{}\n", base),
        )
        .unwrap();
        std::fs::create_dir_all(repo.path.join(".git").join("rebase-merge")).unwrap();

        let err = reset(repo.path_str(), base, "hard".to_string())
            .await
            .expect_err("a rebase in progress must still refuse");
        assert!(
            format!("{}", err).contains("rebase"),
            "and say which one: {}",
            err
        );
    }

    // ==================== Cherry-Pick Tests ====================

    #[tokio::test]
    async fn test_cherry_pick_success() {
        // Setup: Create repo with main branch, create feature branch with a commit,
        // then cherry-pick that commit to main
        let test_repo = TestRepo::with_initial_commit();
        let initial_main_head = test_repo.head_oid();

        // Create a feature branch and add a commit
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        let feature_commit_oid =
            test_repo.create_commit("Feature commit", &[("feature.txt", "feature content")]);

        // Switch back to main
        test_repo.checkout_branch("main");

        // Verify main is still at initial commit
        assert_eq!(test_repo.head_oid(), initial_main_head);

        // Verify feature.txt doesn't exist on main
        assert!(!test_repo.path.join("feature.txt").exists());

        // Cherry-pick the feature commit
        let result = cherry_pick(
            test_repo.path_str(),
            feature_commit_oid.to_string(),
            None,
            None,
        )
        .await;

        assert!(result.is_ok(), "Cherry-pick should succeed");
        let new_commit = result.unwrap();

        // Verify the commit message was preserved
        assert_eq!(new_commit.summary, "Feature commit");

        // Verify main HEAD has advanced (new commit was created)
        assert_ne!(test_repo.head_oid(), initial_main_head);

        // Verify the file now exists on main
        assert!(test_repo.path.join("feature.txt").exists());
        let content = std::fs::read_to_string(test_repo.path.join("feature.txt")).unwrap();
        assert_eq!(content, "feature content");

        // Verify we're still on main
        assert_eq!(test_repo.current_branch(), "main");

        // Verify repo state is clean
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);
    }

    #[tokio::test]
    async fn test_cherry_pick_no_commit_option() {
        // Test cherry-pick with no_commit=true (stages changes without committing)
        let test_repo = TestRepo::with_initial_commit();
        let initial_head = test_repo.head_oid();

        // Create a feature branch and add a commit
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        let feature_commit_oid =
            test_repo.create_commit("Feature commit", &[("feature.txt", "feature content")]);

        // Switch back to main
        test_repo.checkout_branch("main");

        // Cherry-pick with no_commit=true
        let result = cherry_pick(
            test_repo.path_str(),
            feature_commit_oid.to_string(),
            Some(true),
            None,
        )
        .await;

        assert!(result.is_ok(), "Cherry-pick with no_commit should succeed");

        // Verify HEAD hasn't changed (no new commit created)
        assert_eq!(test_repo.head_oid(), initial_head);

        // Verify the file exists in working directory
        assert!(test_repo.path.join("feature.txt").exists());

        // Verify changes are staged
        let repo = test_repo.repo();
        let index = repo.index().unwrap();
        let entry = index.get_path(std::path::Path::new("feature.txt"), 0);
        assert!(entry.is_some(), "feature.txt should be staged");

        // Verify repo state is clean (no cherry-pick in progress)
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
    }

    #[tokio::test]
    async fn test_cherry_pick_conflict() {
        // Test cherry-pick that results in a conflict
        let test_repo = TestRepo::with_initial_commit();

        // Create a file on main
        test_repo.create_commit("Add conflict file", &[("conflict.txt", "main content")]);

        // Create a feature branch from initial commit and modify same file
        test_repo.checkout_branch("main");
        let repo = test_repo.repo();
        let head = repo.head().unwrap();
        let head_commit = head.peel_to_commit().unwrap();
        let parent = head_commit.parent(0).unwrap();

        // Create branch from parent (before conflict.txt was added)
        repo.branch("feature", &parent, false).unwrap();
        test_repo.checkout_branch("feature");

        // Add the same file with different content
        let feature_commit_oid =
            test_repo.create_commit("Feature conflict", &[("conflict.txt", "feature content")]);

        // Switch back to main
        test_repo.checkout_branch("main");

        // Cherry-pick should result in conflict
        let result = cherry_pick(
            test_repo.path_str(),
            feature_commit_oid.to_string(),
            None,
            None,
        )
        .await;

        assert!(result.is_err(), "Cherry-pick should fail with conflict");
        let err = result.unwrap_err();
        assert!(
            matches!(err, GitnadoError::CherryPickConflict),
            "Error should be CherryPickConflict"
        );

        // Verify repo is in cherry-pick state
        let repo = test_repo.repo();
        assert_eq!(repo.state(), git2::RepositoryState::CherryPick);

        // Verify CHERRY_PICK_HEAD exists
        let cherry_pick_head = test_repo.path.join(".git/CHERRY_PICK_HEAD");
        assert!(cherry_pick_head.exists(), "CHERRY_PICK_HEAD should exist");
    }

    #[tokio::test]
    async fn test_cherry_pick_abort() {
        // Test aborting a cherry-pick in progress
        let test_repo = TestRepo::with_initial_commit();

        // Create a conflict scenario (same as above)
        test_repo.create_commit("Add conflict file", &[("conflict.txt", "main content")]);

        let repo = test_repo.repo();
        let head = repo.head().unwrap();
        let head_commit = head.peel_to_commit().unwrap();
        let parent = head_commit.parent(0).unwrap();

        repo.branch("feature", &parent, false).unwrap();
        test_repo.checkout_branch("feature");
        let feature_commit_oid =
            test_repo.create_commit("Feature conflict", &[("conflict.txt", "feature content")]);

        test_repo.checkout_branch("main");

        // Cherry-pick to create conflict
        let _ = cherry_pick(
            test_repo.path_str(),
            feature_commit_oid.to_string(),
            None,
            None,
        )
        .await;

        // Verify we're in cherry-pick state
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::CherryPick);

        // Abort the cherry-pick
        let abort_result = abort_cherry_pick(test_repo.path_str()).await;
        assert!(abort_result.is_ok(), "Abort should succeed");

        // Verify repo state is clean
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);

        // Verify CHERRY_PICK_HEAD is removed
        let cherry_pick_head = test_repo.path.join(".git/CHERRY_PICK_HEAD");
        assert!(
            !cherry_pick_head.exists(),
            "CHERRY_PICK_HEAD should be removed"
        );

        // Verify working directory is clean (conflict file has original content)
        let content = std::fs::read_to_string(test_repo.path.join("conflict.txt")).unwrap();
        assert_eq!(content, "main content");
    }

    #[tokio::test]
    async fn test_cherry_pick_continue_after_resolve() {
        // Test continuing cherry-pick after manually resolving conflicts
        let test_repo = TestRepo::with_initial_commit();

        // Create a conflict scenario
        test_repo.create_commit("Add conflict file", &[("conflict.txt", "main content")]);

        let repo = test_repo.repo();
        let head = repo.head().unwrap();
        let head_commit = head.peel_to_commit().unwrap();
        let parent = head_commit.parent(0).unwrap();

        repo.branch("feature", &parent, false).unwrap();
        test_repo.checkout_branch("feature");
        let feature_commit_oid =
            test_repo.create_commit("Feature conflict", &[("conflict.txt", "feature content")]);

        test_repo.checkout_branch("main");
        let main_head_before = test_repo.head_oid();

        // Cherry-pick to create conflict
        let _ = cherry_pick(
            test_repo.path_str(),
            feature_commit_oid.to_string(),
            None,
            None,
        )
        .await;

        // Manually resolve the conflict by writing resolved content
        std::fs::write(test_repo.path.join("conflict.txt"), "resolved content").unwrap();

        // Stage the resolved file
        let repo = test_repo.repo();
        let mut index = repo.index().unwrap();
        index
            .add_path(std::path::Path::new("conflict.txt"))
            .unwrap();
        index.write().unwrap();

        // Continue the cherry-pick
        let continue_result = continue_cherry_pick(test_repo.path_str()).await;
        assert!(continue_result.is_ok(), "Continue should succeed");

        let new_commit = continue_result.unwrap();
        assert_eq!(new_commit.summary, "Feature conflict");

        // Verify a new commit was created
        assert_ne!(test_repo.head_oid(), main_head_before);

        // Verify repo state is clean
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);

        // Verify CHERRY_PICK_HEAD is removed
        let cherry_pick_head = test_repo.path.join(".git/CHERRY_PICK_HEAD");
        assert!(!cherry_pick_head.exists());

        // Verify resolved content is in the commit
        let content = std::fs::read_to_string(test_repo.path.join("conflict.txt")).unwrap();
        assert_eq!(content, "resolved content");
    }

    #[tokio::test]
    async fn test_cherry_pick_cannot_pick_root_commit() {
        // Test that cherry-picking a root commit fails
        let test_repo = TestRepo::new();

        // Create a single commit (root commit)
        let root_oid = test_repo.create_commit("Root commit", &[("file.txt", "content")]);

        // Try to cherry-pick the root commit
        let result = cherry_pick(test_repo.path_str(), root_oid.to_string(), None, None).await;

        assert!(
            result.is_err(),
            "Should not be able to cherry-pick root commit"
        );
        let err = result.unwrap_err();
        assert!(matches!(err, GitnadoError::OperationFailed(_)));
    }

    #[tokio::test]
    async fn test_cherry_pick_fails_when_operation_in_progress() {
        // Test that cherry-pick fails if another operation is already in progress
        let test_repo = TestRepo::with_initial_commit();

        // Create a conflict scenario to get into cherry-pick state
        test_repo.create_commit("Add conflict file", &[("conflict.txt", "main content")]);

        let repo = test_repo.repo();
        let head = repo.head().unwrap();
        let head_commit = head.peel_to_commit().unwrap();
        let parent = head_commit.parent(0).unwrap();

        repo.branch("feature", &parent, false).unwrap();
        test_repo.checkout_branch("feature");
        let feature_commit_oid =
            test_repo.create_commit("Feature conflict", &[("conflict.txt", "feature content")]);

        // Create another commit on feature
        let another_commit_oid =
            test_repo.create_commit("Another commit", &[("another.txt", "content")]);

        test_repo.checkout_branch("main");

        // First cherry-pick creates conflict
        let _ = cherry_pick(
            test_repo.path_str(),
            feature_commit_oid.to_string(),
            None,
            None,
        )
        .await;

        // Verify we're in cherry-pick state
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::CherryPick);

        // Second cherry-pick should fail
        let result = cherry_pick(
            test_repo.path_str(),
            another_commit_oid.to_string(),
            None,
            None,
        )
        .await;

        assert!(
            result.is_err(),
            "Should fail when cherry-pick already in progress"
        );
        let err = result.unwrap_err();
        assert!(matches!(err, GitnadoError::CherryPickInProgress));
    }

    #[tokio::test]
    async fn test_cherry_pick_preserves_author() {
        // `git cherry-pick` keeps the ORIGINAL author and records the picker as
        // committer at pick time.
        //
        // The author must differ from the repo signature for this to mean
        // anything: TestRepo::create_commit passes repo.signature() as BOTH
        // author and committer, so a swap of the two is invisible against a
        // commit it creates and the assertion passes either way.
        let test_repo = TestRepo::with_initial_commit();
        let default_branch = test_repo.current_branch();

        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");

        const ORIGINAL_TIME: i64 = 1_000_000_000;
        let feature_commit_oid = {
            let repo = test_repo.repo();
            test_repo.create_file("feature.txt", "content");
            test_repo.stage_file("feature.txt");

            let mut index = repo.index().unwrap();
            let tree_oid = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_oid).unwrap();

            let author = git2::Signature::new(
                "Original Author",
                "original@example.com",
                &git2::Time::new(ORIGINAL_TIME, 0),
            )
            .unwrap();
            let committer = repo.signature().unwrap();
            let parent = repo.head().unwrap().peel_to_commit().unwrap();

            repo.commit(
                Some("HEAD"),
                &author,
                &committer,
                "Feature commit",
                &tree,
                &[&parent],
            )
            .unwrap()
        };

        test_repo.checkout_branch(&default_branch);
        cherry_pick(
            test_repo.path_str(),
            feature_commit_oid.to_string(),
            None,
            None,
        )
        .await
        .unwrap();

        let repo = test_repo.repo();
        let picked = repo.head().unwrap().peel_to_commit().unwrap();
        let local = repo.signature().unwrap();

        // Author carried over from the original commit, timestamp included.
        assert_eq!(picked.author().name().unwrap(), "Original Author");
        assert_eq!(picked.author().email().unwrap(), "original@example.com");
        assert_eq!(picked.author().when().seconds(), ORIGINAL_TIME);

        // Committer is whoever performed the pick, stamped at pick time.
        assert_eq!(picked.committer().name().unwrap(), local.name().unwrap());
        assert_eq!(picked.committer().email().unwrap(), local.email().unwrap());
        assert!(
            picked.committer().when().seconds() > ORIGINAL_TIME,
            "committer time must be the cherry-pick time, not the original commit's; \
             back-dating it breaks max(author, committer) graph ordering"
        );
    }

    #[tokio::test]
    async fn test_cherry_pick_range() {
        let repo = TestRepo::with_initial_commit();
        let default_branch = repo.current_branch();

        // Create commits on feature branch
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        let commit1 = repo.create_commit("Commit 1", &[("file1.txt", "content1")]);
        let commit2 = repo.create_commit("Commit 2", &[("file2.txt", "content2")]);

        // Go back to default branch
        repo.checkout_branch(&default_branch);

        // Cherry-pick range (oldest first)
        let result = cherry_pick_range(
            repo.path_str(),
            vec![commit1.to_string(), commit2.to_string()],
        )
        .await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].summary, "Commit 1");
        assert_eq!(commits[1].summary, "Commit 2");

        // Verify both files exist
        assert!(repo.path.join("file1.txt").exists());
        assert!(repo.path.join("file2.txt").exists());
    }

    #[tokio::test]
    async fn test_cherry_pick_range_empty_fails() {
        let repo = TestRepo::with_initial_commit();
        let result = cherry_pick_range(repo.path_str(), vec![]).await;
        assert!(result.is_err());
    }

    /// Record a merge commit on the current branch with `other_oid` as its
    /// second parent. The tree is HEAD's, because the only property the
    /// cherry-pick refusals care about is `parent_count() > 1`.
    fn commit_merge(repo: &TestRepo, message: &str, other_oid: git2::Oid) -> git2::Oid {
        let git = repo.repo();
        let head = git.head().unwrap().peel_to_commit().unwrap();
        let other = git.find_commit(other_oid).unwrap();
        let tree = head.tree().unwrap();
        let sig = git.signature().unwrap();
        git.commit(Some("HEAD"), &sig, &sig, message, &tree, &[&head, &other])
            .unwrap()
    }

    #[tokio::test]
    async fn test_cherry_pick_range_refuses_merge_before_applying_anything() {
        // Multi-selecting a range that happens to contain a merge commit is easy
        // in the graph. git checks the whole set first and refuses; applying the
        // earlier picks and only then discovering the merge leaves a half-applied
        // range the user never asked for.
        let repo = TestRepo::with_initial_commit();
        let default_branch = repo.current_branch();

        repo.create_branch("side");
        repo.checkout_branch("side");
        let side_oid = repo.create_commit("Side work", &[("side.txt", "side")]);

        repo.checkout_branch(&default_branch);
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        let commit1 = repo.create_commit("Commit 1", &[("file1.txt", "content1")]);
        let merge_oid = commit_merge(&repo, "Merge side", side_oid);

        repo.checkout_branch(&default_branch);
        let head_before = repo.head_oid();

        let result = cherry_pick_range(
            repo.path_str(),
            vec![commit1.to_string(), merge_oid.to_string()],
        )
        .await;

        assert!(
            result.is_err(),
            "a range containing a merge must be refused"
        );
        assert_eq!(
            repo.head_oid(),
            head_before,
            "the refusal must leave the branch where it was; the leading pick \
             must not have been applied"
        );
        assert!(
            !repo.path.join("file1.txt").exists(),
            "no commit in the range may be applied when the range is refused"
        );
        assert!(
            !repo.repo().path().join(CHERRY_PICK_SEQUENCE_HEAD).exists(),
            "a refused range must not leave sequencer state behind"
        );
    }

    #[tokio::test]
    async fn test_refused_range_does_not_rewind_a_later_unrelated_abort() {
        // The damage the stale sidecar causes: nothing clears
        // CHERRY_PICK_SEQUENCE_HEAD on a hard error, so the next cherry-pick the
        // user aborts rewinds the branch to a HEAD from the earlier, unrelated
        // operation — silently discarding everything committed since.
        let repo = TestRepo::with_initial_commit();
        let default_branch = repo.current_branch();

        repo.create_branch("side");
        repo.checkout_branch("side");
        let side_oid = repo.create_commit("Side work", &[("side.txt", "side")]);

        // A commit that will conflict with the later work on the default branch.
        repo.checkout_branch(&default_branch);
        repo.create_branch("other");
        repo.checkout_branch("other");
        let conflicting = repo.create_commit("Other README", &[("README.md", "theirs\n")]);

        repo.checkout_branch(&default_branch);
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        let commit1 = repo.create_commit("Commit 1", &[("file1.txt", "content1")]);
        let merge_oid = commit_merge(&repo, "Merge side", side_oid);

        // A range that stops on the merge.
        repo.checkout_branch(&default_branch);
        let _ = cherry_pick_range(
            repo.path_str(),
            vec![commit1.to_string(), merge_oid.to_string()],
        )
        .await;

        // Later, unrelated work the user commits and expects to keep.
        let later_work = repo.create_commit("Later work", &[("README.md", "ours\n")]);

        // An ordinary single cherry-pick that conflicts, which the user aborts.
        let conflict = cherry_pick(repo.path_str(), conflicting.to_string(), None, None).await;
        assert!(
            conflict.is_err(),
            "the pick must conflict for this to be an abort"
        );
        abort_cherry_pick(repo.path_str())
            .await
            .expect("aborting the conflicted pick must succeed");

        assert_eq!(
            repo.head_oid(),
            later_work,
            "aborting an unrelated cherry-pick must rewind only that pick; \
             sequencer state from the earlier refused range must not survive to \
             rewind the branch past committed work"
        );
    }

    #[tokio::test]
    async fn test_cherry_pick_range_conflict_still_records_sequencer_state() {
        // The counterpart to clearing on hard errors: a conflict stop DOES leave
        // a cherry-pick in progress, and abort needs the pre-sequence HEAD to
        // rewind the picks already applied.
        let repo = TestRepo::with_initial_commit();
        let default_branch = repo.current_branch();

        repo.create_branch("feature");
        repo.checkout_branch("feature");
        let commit1 = repo.create_commit("Commit 1", &[("file1.txt", "content1")]);
        let commit2 = repo.create_commit("Conflicting", &[("README.md", "theirs\n")]);

        repo.checkout_branch(&default_branch);
        let pre_range_head = repo.create_commit("Ours", &[("README.md", "ours\n")]);

        let result = cherry_pick_range(
            repo.path_str(),
            vec![commit1.to_string(), commit2.to_string()],
        )
        .await;

        assert!(matches!(result, Err(GitnadoError::CherryPickConflict)));
        assert!(
            repo.repo().path().join(CHERRY_PICK_SEQUENCE_HEAD).exists(),
            "a conflict stop must keep the sequence head so abort can rewind"
        );

        abort_cherry_pick(repo.path_str())
            .await
            .expect("abort must succeed");
        assert_eq!(
            repo.head_oid(),
            pre_range_head,
            "abort must rewind the leading pick the range already applied"
        );
    }

    #[tokio::test]
    async fn test_empty_pick_mid_range_keeps_sequencer_state_for_abort() {
        // An empty pick returns Err but deliberately leaves CHERRY_PICK_HEAD in
        // place, so there IS something to abort and the sequence head must
        // survive to rewind the picks already applied.
        let repo = TestRepo::with_initial_commit();
        let default_branch = repo.current_branch();

        repo.create_branch("feature");
        repo.checkout_branch("feature");
        let commit1 = repo.create_commit("Commit 1", &[("file1.txt", "content1")]);
        let commit2 = repo.create_commit("Commit 2", &[("file2.txt", "content2")]);

        repo.checkout_branch(&default_branch);
        // Apply commit2 first so the range's second pick has nothing left to do.
        cherry_pick(repo.path_str(), commit2.to_string(), None, None)
            .await
            .expect("the priming pick must succeed");

        let result = cherry_pick_range(
            repo.path_str(),
            vec![commit1.to_string(), commit2.to_string()],
        )
        .await;

        assert!(result.is_err(), "an already-applied pick is an empty stop");
        assert!(
            repo.repo().path().join(CHERRY_PICK_SEQUENCE_HEAD).exists(),
            "an empty stop leaves a cherry-pick in progress, so the sequence \
             head must survive for abort to rewind the applied picks"
        );
    }

    #[tokio::test]
    async fn test_abort_cherry_pick_no_operation() {
        // Canonical git: `git cherry-pick --abort` with no cherry-pick in
        // progress fails ("no cherry-pick or revert in progress") and touches
        // nothing. A blanket force-reset here would destroy uncommitted work.
        let repo = TestRepo::with_initial_commit();

        // Make an uncommitted edit to a tracked file.
        std::fs::write(repo.path.join("README.md"), "uncommitted precious work").unwrap();

        let result = abort_cherry_pick(repo.path_str()).await;
        assert!(
            result.is_err(),
            "Abort with no cherry-pick in progress must fail like git"
        );

        // The uncommitted edit must survive (nothing was force-reset).
        let content = std::fs::read_to_string(repo.path.join("README.md")).unwrap();
        assert_eq!(content, "uncommitted precious work");
    }

    #[tokio::test]
    async fn test_continue_cherry_pick_no_operation() {
        let repo = TestRepo::with_initial_commit();
        // Continuing when no cherry-pick in progress should fail
        let result = continue_cherry_pick(repo.path_str()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_continue_revert_no_operation() {
        let repo = TestRepo::with_initial_commit();
        // Continuing when no revert in progress should fail
        let result = continue_revert(repo.path_str()).await;
        assert!(result.is_err());
    }

    // ==================== Revert Tests ====================

    #[tokio::test]
    async fn test_revert_success() {
        let test_repo = TestRepo::with_initial_commit();

        // Create a commit to revert
        let commit_to_revert =
            test_repo.create_commit("Add file to revert", &[("revert-me.txt", "content")]);

        // Verify file exists
        assert!(test_repo.path.join("revert-me.txt").exists());

        // Revert the commit
        let result = revert(test_repo.path_str(), commit_to_revert.to_string(), None).await;
        assert!(result.is_ok(), "Revert should succeed");

        let revert_commit = result.unwrap();
        assert!(revert_commit.summary.contains("Revert"));

        // Verify the file no longer exists
        assert!(!test_repo.path.join("revert-me.txt").exists());

        // Verify repo state is clean
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);
    }

    #[tokio::test]
    async fn test_revert_conflict() {
        let test_repo = TestRepo::with_initial_commit();

        // Create a commit that adds a file
        let commit_to_revert =
            test_repo.create_commit("Add file", &[("file.txt", "original content")]);

        // Modify the file in another commit
        test_repo.create_commit("Modify file", &[("file.txt", "modified content")]);

        // Revert the original commit - this should conflict
        let result = revert(test_repo.path_str(), commit_to_revert.to_string(), None).await;

        assert!(result.is_err(), "Revert should fail with conflict");
        let err = result.unwrap_err();
        assert!(matches!(err, GitnadoError::RevertConflict));
    }

    #[tokio::test]
    async fn test_abort_revert() {
        let test_repo = TestRepo::with_initial_commit();

        // Create conflict scenario
        let commit_to_revert =
            test_repo.create_commit("Add file", &[("file.txt", "original content")]);
        test_repo.create_commit("Modify file", &[("file.txt", "modified content")]);

        // Revert to create conflict
        let _ = revert(test_repo.path_str(), commit_to_revert.to_string(), None).await;

        // Abort
        let abort_result = abort_revert(test_repo.path_str()).await;
        assert!(abort_result.is_ok());

        // Verify state is clean
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);
    }

    #[tokio::test]
    async fn test_revert_invalid_commit() {
        let repo = TestRepo::with_initial_commit();
        let result = revert(
            repo.path_str(),
            "0000000000000000000000000000000000000000".to_string(),
            None,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_abort_revert_no_operation() {
        // Canonical git: `git revert --abort` with no revert in progress fails
        // and touches nothing.
        let repo = TestRepo::with_initial_commit();

        std::fs::write(repo.path.join("README.md"), "uncommitted precious work").unwrap();

        let result = abort_revert(repo.path_str()).await;
        assert!(
            result.is_err(),
            "Abort with no revert in progress must fail like git"
        );

        let content = std::fs::read_to_string(repo.path.join("README.md")).unwrap();
        assert_eq!(content, "uncommitted precious work");
    }

    #[tokio::test]
    async fn test_revert_message_format() {
        let repo = TestRepo::with_initial_commit();

        let commit_oid = repo.create_commit("Original message", &[("file.txt", "content")]);

        let result = revert(repo.path_str(), commit_oid.to_string(), None).await;
        assert!(result.is_ok());
        let revert_commit = result.unwrap();

        // Check revert message format
        assert!(revert_commit.summary.contains("Original message"));
        assert!(revert_commit.message.contains(&commit_oid.to_string()));
    }

    // ==================== Reset Tests ====================

    #[tokio::test]
    async fn test_reset_soft() {
        let test_repo = TestRepo::with_initial_commit();
        let initial_head = test_repo.head_oid();

        // Create another commit
        test_repo.create_commit("Second commit", &[("file2.txt", "content")]);

        // Soft reset to initial commit
        let result = reset(
            test_repo.path_str(),
            initial_head.to_string(),
            "soft".to_string(),
        )
        .await;

        assert!(result.is_ok());

        // HEAD should point to initial commit
        assert_eq!(test_repo.head_oid(), initial_head);

        // File should still exist (soft reset keeps working directory)
        assert!(test_repo.path.join("file2.txt").exists());

        // Changes should be staged
        let repo = test_repo.repo();
        let index = repo.index().unwrap();
        assert!(index
            .get_path(std::path::Path::new("file2.txt"), 0)
            .is_some());
    }

    #[tokio::test]
    async fn test_reset_hard() {
        let test_repo = TestRepo::with_initial_commit();
        let initial_head = test_repo.head_oid();

        // Create another commit
        test_repo.create_commit("Second commit", &[("file2.txt", "content")]);

        // Hard reset to initial commit
        let result = reset(
            test_repo.path_str(),
            initial_head.to_string(),
            "hard".to_string(),
        )
        .await;

        assert!(result.is_ok());

        // HEAD should point to initial commit
        assert_eq!(test_repo.head_oid(), initial_head);

        // File should NOT exist (hard reset discards working directory)
        assert!(!test_repo.path.join("file2.txt").exists());
    }

    #[tokio::test]
    async fn test_reset_mixed() {
        let test_repo = TestRepo::with_initial_commit();
        let initial_head = test_repo.head_oid();

        // Create another commit
        test_repo.create_commit("Second commit", &[("file2.txt", "content")]);

        // Mixed reset to initial commit
        let result = reset(
            test_repo.path_str(),
            initial_head.to_string(),
            "mixed".to_string(),
        )
        .await;

        assert!(result.is_ok());

        // HEAD should point to initial commit
        assert_eq!(test_repo.head_oid(), initial_head);

        // File should still exist
        assert!(test_repo.path.join("file2.txt").exists());

        // Changes should NOT be staged (mixed reset unstages)
        let repo = test_repo.repo();
        let index = repo.index().unwrap();
        assert!(index
            .get_path(std::path::Path::new("file2.txt"), 0)
            .is_none());
    }

    #[tokio::test]
    async fn test_reset_invalid_mode() {
        let test_repo = TestRepo::with_initial_commit();

        let result = reset(
            test_repo.path_str(),
            test_repo.head_oid().to_string(),
            "invalid".to_string(),
        )
        .await;

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(err, GitnadoError::OperationFailed(_)));
    }

    #[tokio::test]
    async fn test_reset_invalid_target() {
        let repo = TestRepo::with_initial_commit();

        let result = reset(
            repo.path_str(),
            "nonexistent-ref".to_string(),
            "soft".to_string(),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_reset_to_branch_name() {
        let repo = TestRepo::with_initial_commit();
        let initial_oid = repo.head_oid();

        // Create a branch at current position
        repo.create_branch("marker");

        // Create more commits
        repo.create_commit("Commit 2", &[("file2.txt", "content2")]);
        repo.create_commit("Commit 3", &[("file3.txt", "content3")]);

        // Reset to branch name
        let result = reset(repo.path_str(), "marker".to_string(), "hard".to_string()).await;
        assert!(result.is_ok());
        assert_eq!(repo.head_oid(), initial_oid);
    }

    #[tokio::test]
    async fn test_reset_head_tilde() {
        let repo = TestRepo::with_initial_commit();
        let initial_oid = repo.head_oid();

        // Create more commits
        repo.create_commit("Commit 2", &[("file2.txt", "content2")]);
        repo.create_commit("Commit 3", &[("file3.txt", "content3")]);

        // Reset to HEAD~2 (2 commits back)
        let result = reset(repo.path_str(), "HEAD~2".to_string(), "hard".to_string()).await;
        assert!(result.is_ok());
        assert_eq!(repo.head_oid(), initial_oid);
    }

    // ==================== Rebase Tests ====================

    #[tokio::test]
    async fn test_get_rebase_state_no_rebase() {
        let repo = TestRepo::with_initial_commit();

        let result = get_rebase_state(repo.path_str()).await;
        assert!(result.is_ok());

        let state = result.unwrap();
        assert!(!state.in_progress);
        assert!(state.head_name.is_none());
        assert!(state.onto.is_none());
        assert!(state.current_commit.is_none());
        assert_eq!(state.done_count, 0);
        assert_eq!(state.total_count, 0);
        assert!(!state.has_conflicts);
    }

    #[tokio::test]
    async fn test_get_rebase_state_serialization() {
        let state = RebaseState {
            in_progress: true,
            head_name: Some("feature".to_string()),
            onto: Some("abc123".to_string()),
            current_commit: Some("def456".to_string()),
            done_count: 2,
            total_count: 5,
            has_conflicts: false,
        };

        let json = serde_json::to_string(&state);
        assert!(json.is_ok());
        let json_str = json.unwrap();
        assert!(json_str.contains("\"inProgress\":true"));
        assert!(json_str.contains("\"headName\":\"feature\""));
        assert!(json_str.contains("\"onto\":\"abc123\""));
        assert!(json_str.contains("\"currentCommit\":\"def456\""));
        assert!(json_str.contains("\"doneCount\":2"));
        assert!(json_str.contains("\"totalCount\":5"));
        assert!(json_str.contains("\"hasConflicts\":false"));
    }

    #[tokio::test]
    async fn test_rebase_todo_entry_serialization() {
        let entry = RebaseTodoEntry {
            action: "pick".to_string(),
            commit_oid: "abc123def456".to_string(),
            commit_short: "abc123d".to_string(),
            message: "Test commit message".to_string(),
        };

        let json = serde_json::to_string(&entry);
        assert!(json.is_ok());
        let json_str = json.unwrap();
        assert!(json_str.contains("\"action\":\"pick\""));
        assert!(json_str.contains("\"commitOid\":\"abc123def456\""));
        assert!(json_str.contains("\"commitShort\":\"abc123d\""));
        assert!(json_str.contains("\"message\":\"Test commit message\""));
    }

    #[tokio::test]
    async fn test_rebase_todo_serialization() {
        let todo = RebaseTodo {
            entries: vec![
                RebaseTodoEntry {
                    action: "pick".to_string(),
                    commit_oid: "abc".to_string(),
                    commit_short: "abc".to_string(),
                    message: "First".to_string(),
                },
                RebaseTodoEntry {
                    action: "squash".to_string(),
                    commit_oid: "def".to_string(),
                    commit_short: "def".to_string(),
                    message: "Second".to_string(),
                },
            ],
            done: vec![RebaseTodoEntry {
                action: "pick".to_string(),
                commit_oid: "ghi".to_string(),
                commit_short: "ghi".to_string(),
                message: "Done".to_string(),
            }],
        };

        let json = serde_json::to_string(&todo);
        assert!(json.is_ok());
        let json_str = json.unwrap();
        assert!(json_str.contains("\"entries\":"));
        assert!(json_str.contains("\"done\":"));
        assert!(json_str.contains("\"action\":\"squash\""));
    }

    #[tokio::test]
    async fn test_get_rebase_todo_no_rebase() {
        let repo = TestRepo::with_initial_commit();

        // Should fail when no rebase in progress
        let result = get_rebase_todo(repo.path_str()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_update_rebase_todo_no_rebase() {
        let repo = TestRepo::with_initial_commit();

        // Should fail when no rebase in progress
        let result = update_rebase_todo(repo.path_str(), vec![]).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_skip_rebase_commit_no_rebase() {
        let repo = TestRepo::with_initial_commit();

        // Should fail when no rebase in progress
        let result = skip_rebase_commit(repo.path_str()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_rebase_todo_entry_deserialization() {
        let json = r#"{"action":"pick","commitOid":"abc123","commitShort":"abc","message":"Test"}"#;
        let entry: RebaseTodoEntry = serde_json::from_str(json).unwrap();

        assert_eq!(entry.action, "pick");
        assert_eq!(entry.commit_oid, "abc123");
        assert_eq!(entry.commit_short, "abc");
        assert_eq!(entry.message, "Test");
    }

    // ==================== Drop Commit Tests ====================

    #[tokio::test]
    async fn test_drop_commit_head() {
        let repo = TestRepo::with_initial_commit();
        let initial_oid = repo.head_oid();

        // Create a commit that we will drop
        let drop_oid = repo.create_commit("Commit to drop", &[("drop.txt", "drop content")]);

        // Verify the file exists before drop
        assert!(repo.path.join("drop.txt").exists());

        // Drop the HEAD commit
        let result = drop_commit(repo.path_str(), drop_oid.to_string()).await;

        assert!(result.is_ok());
        let drop_result = result.unwrap();
        assert!(drop_result.success);
        assert!(!drop_result.has_conflicts);
        assert_eq!(drop_result.new_tip, initial_oid.to_string());
        assert_eq!(drop_result.dropped_message, "Commit to drop");

        // HEAD should be at initial commit
        assert_eq!(repo.head_oid(), initial_oid);

        // File should be gone
        assert!(!repo.path.join("drop.txt").exists());
    }

    #[tokio::test]
    async fn test_drop_commit_middle() {
        let repo = TestRepo::with_initial_commit();

        // Create three commits: keep1 -> drop -> keep2
        repo.create_commit("Keep 1", &[("keep1.txt", "keep1")]);
        let drop_oid = repo.create_commit("Drop this", &[("drop.txt", "drop content")]);
        repo.create_commit("Keep 2", &[("keep2.txt", "keep2")]);

        // Drop the middle commit
        let result = drop_commit(repo.path_str(), drop_oid.to_string()).await;

        assert!(result.is_ok());
        let drop_result = result.unwrap();
        assert!(drop_result.success);
        assert!(!drop_result.has_conflicts);
        assert_eq!(drop_result.dropped_message, "Drop this");

        // Verify the kept files exist
        assert!(repo.path.join("keep1.txt").exists());
        assert!(repo.path.join("keep2.txt").exists());

        // Verify the dropped file no longer exists
        assert!(!repo.path.join("drop.txt").exists());

        // Verify the commit history no longer contains the dropped commit
        let git_repo = repo.repo();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.summary().unwrap(), Some("Keep 2"));
        let parent = head.parent(0).unwrap();
        assert_eq!(parent.summary().unwrap(), Some("Keep 1"));
    }

    #[tokio::test]
    async fn test_drop_commit_invalid_oid() {
        let repo = TestRepo::with_initial_commit();
        let result = drop_commit(repo.path_str(), "invalid-oid".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_drop_commit_nonexistent() {
        let repo = TestRepo::with_initial_commit();
        let result = drop_commit(
            repo.path_str(),
            "0000000000000000000000000000000000000000".to_string(),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_drop_commit_root_fails() {
        let repo = TestRepo::with_initial_commit();
        let root_oid = repo.head_oid();

        // Dropping the root commit should fail
        let result = drop_commit(repo.path_str(), root_oid.to_string()).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("Cannot drop root commit"));
    }

    #[tokio::test]
    async fn test_drop_commit_not_ancestor_of_head() {
        let repo = TestRepo::with_initial_commit();
        let default_branch = repo.current_branch();

        // Create a commit on a feature branch
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        let feature_oid = repo.create_commit("Feature commit", &[("feature.txt", "content")]);

        // Go back to default branch and create a different commit
        repo.checkout_branch(&default_branch);
        repo.create_commit("Main commit", &[("main.txt", "content")]);

        // Trying to drop the feature commit from default branch should fail
        let result = drop_commit(repo.path_str(), feature_oid.to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_drop_commit_result_serialization() {
        let result = DropCommitResult {
            success: true,
            new_tip: "abc123def456".to_string(),
            has_conflicts: false,
            dropped_message: "Dropped commit message".to_string(),
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"success\":true"));
        assert!(json.contains("\"newTip\":\"abc123def456\""));
        assert!(json.contains("\"hasConflicts\":false"));
        assert!(json.contains("\"droppedMessage\":\"Dropped commit message\""));
    }

    #[tokio::test]
    async fn test_drop_commit_preserves_subsequent_commits() {
        let repo = TestRepo::with_initial_commit();

        // Create a chain: initial -> A -> B (drop) -> C -> D
        repo.create_commit("Commit A", &[("a.txt", "a")]);
        let drop_oid = repo.create_commit("Commit B", &[("b.txt", "b")]);
        repo.create_commit("Commit C", &[("c.txt", "c")]);
        repo.create_commit("Commit D", &[("d.txt", "d")]);

        let result = drop_commit(repo.path_str(), drop_oid.to_string()).await;

        assert!(result.is_ok());
        let drop_result = result.unwrap();
        assert!(drop_result.success);

        // Files from non-dropped commits should exist
        assert!(repo.path.join("a.txt").exists());
        assert!(repo.path.join("c.txt").exists());
        assert!(repo.path.join("d.txt").exists());

        // File from dropped commit should not exist
        assert!(!repo.path.join("b.txt").exists());

        // Verify the commit chain: D -> C -> A -> initial
        let git_repo = repo.repo();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.summary().unwrap(), Some("Commit D"));
        let c = head.parent(0).unwrap();
        assert_eq!(c.summary().unwrap(), Some("Commit C"));
        let a = c.parent(0).unwrap();
        assert_eq!(a.summary().unwrap(), Some("Commit A"));
    }

    // ==================== Reorder Commits Tests ====================

    #[tokio::test]
    async fn test_reorder_commits_reverse_two() {
        let repo = TestRepo::with_initial_commit();
        let base_oid = repo.head_oid();

        // Create two commits: A -> B
        let commit_a = repo.create_commit("Commit A", &[("a.txt", "a content")]);
        let commit_b = repo.create_commit("Commit B", &[("b.txt", "b content")]);

        // Reorder to: B -> A (reversed)
        let result = reorder_commits(
            repo.path_str(),
            base_oid.to_string(),
            vec![commit_b.to_string(), commit_a.to_string()],
        )
        .await;

        assert!(result.is_ok());
        let reorder_result = result.unwrap();
        assert!(reorder_result.success);
        assert_eq!(reorder_result.reordered_count, 2);
        assert!(!reorder_result.has_conflicts);

        // Verify both files still exist
        assert!(repo.path.join("a.txt").exists());
        assert!(repo.path.join("b.txt").exists());

        // Verify the commit order is now reversed: A on top, B below
        let git_repo = repo.repo();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.summary().unwrap(), Some("Commit A"));
        let parent = head.parent(0).unwrap();
        assert_eq!(parent.summary().unwrap(), Some("Commit B"));
    }

    #[tokio::test]
    async fn test_reorder_commits_three_commits() {
        let repo = TestRepo::with_initial_commit();
        let base_oid = repo.head_oid();

        // Create three commits: A -> B -> C
        let commit_a = repo.create_commit("Commit A", &[("a.txt", "a")]);
        let commit_b = repo.create_commit("Commit B", &[("b.txt", "b")]);
        let commit_c = repo.create_commit("Commit C", &[("c.txt", "c")]);

        // Reorder to: C -> A -> B
        let result = reorder_commits(
            repo.path_str(),
            base_oid.to_string(),
            vec![
                commit_c.to_string(),
                commit_a.to_string(),
                commit_b.to_string(),
            ],
        )
        .await;

        assert!(result.is_ok());
        let reorder_result = result.unwrap();
        assert!(reorder_result.success);
        assert_eq!(reorder_result.reordered_count, 3);

        // Verify all files exist
        assert!(repo.path.join("a.txt").exists());
        assert!(repo.path.join("b.txt").exists());
        assert!(repo.path.join("c.txt").exists());

        // Verify the commit order: B -> A -> C -> base
        let git_repo = repo.repo();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.summary().unwrap(), Some("Commit B"));
        let second = head.parent(0).unwrap();
        assert_eq!(second.summary().unwrap(), Some("Commit A"));
        let third = second.parent(0).unwrap();
        assert_eq!(third.summary().unwrap(), Some("Commit C"));
    }

    #[tokio::test]
    async fn test_reorder_commits_empty_list_fails() {
        let repo = TestRepo::with_initial_commit();
        let base_oid = repo.head_oid();

        let result = reorder_commits(repo.path_str(), base_oid.to_string(), vec![]).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("No commits specified"));
    }

    #[tokio::test]
    async fn test_reorder_commits_invalid_base_oid() {
        let repo = TestRepo::with_initial_commit();
        let commit_a = repo.create_commit("Commit A", &[("a.txt", "a")]);

        let result = reorder_commits(
            repo.path_str(),
            "invalid-oid".to_string(),
            vec![commit_a.to_string()],
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_reorder_commits_invalid_commit_oid() {
        let repo = TestRepo::with_initial_commit();
        let base_oid = repo.head_oid();

        let result = reorder_commits(
            repo.path_str(),
            base_oid.to_string(),
            vec!["invalid-oid".to_string()],
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_reorder_commits_mismatched_commits_fails() {
        let repo = TestRepo::with_initial_commit();
        let base_oid = repo.head_oid();

        // Create two commits
        let commit_a = repo.create_commit("Commit A", &[("a.txt", "a")]);
        let _commit_b = repo.create_commit("Commit B", &[("b.txt", "b")]);

        // Try to reorder with only one of the two commits - should fail
        let result = reorder_commits(
            repo.path_str(),
            base_oid.to_string(),
            vec![commit_a.to_string()],
        )
        .await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("exactly the same commits"));
    }

    #[tokio::test]
    async fn test_reorder_commits_preserves_messages() {
        let repo = TestRepo::with_initial_commit();
        let base_oid = repo.head_oid();

        let commit_a = repo.create_commit("Message for A", &[("a.txt", "a")]);
        let commit_b = repo.create_commit("Message for B", &[("b.txt", "b")]);

        // Reverse the order
        let result = reorder_commits(
            repo.path_str(),
            base_oid.to_string(),
            vec![commit_b.to_string(), commit_a.to_string()],
        )
        .await;

        assert!(result.is_ok());

        // Verify commit messages are preserved
        let git_repo = repo.repo();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.summary().unwrap(), Some("Message for A"));
        let parent = head.parent(0).unwrap();
        assert_eq!(parent.summary().unwrap(), Some("Message for B"));
    }

    #[tokio::test]
    async fn test_reorder_commits_same_order() {
        let repo = TestRepo::with_initial_commit();
        let base_oid = repo.head_oid();

        // Create commits
        let commit_a = repo.create_commit("Commit A", &[("a.txt", "a")]);
        let commit_b = repo.create_commit("Commit B", &[("b.txt", "b")]);

        // Reorder in the same order (no-op reorder)
        let result = reorder_commits(
            repo.path_str(),
            base_oid.to_string(),
            vec![commit_a.to_string(), commit_b.to_string()],
        )
        .await;

        assert!(result.is_ok());
        let reorder_result = result.unwrap();
        assert!(reorder_result.success);
        assert_eq!(reorder_result.reordered_count, 2);

        // Verify commit order is still A -> B
        let git_repo = repo.repo();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.summary().unwrap(), Some("Commit B"));
        let parent = head.parent(0).unwrap();
        assert_eq!(parent.summary().unwrap(), Some("Commit A"));
    }

    #[tokio::test]
    async fn test_reorder_result_serialization() {
        let result = ReorderResult {
            success: true,
            new_tip: "abc123def456".to_string(),
            reordered_count: 3,
            has_conflicts: false,
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"success\":true"));
        assert!(json.contains("\"newTip\":\"abc123def456\""));
        assert!(json.contains("\"reorderedCount\":3"));
        assert!(json.contains("\"hasConflicts\":false"));
    }

    // ==================== Cherry-Pick From Branch Tests ====================

    #[tokio::test]
    async fn test_cherry_pick_from_branch_single_commit() {
        let repo = TestRepo::with_initial_commit();
        let default_branch = repo.current_branch();

        // Create a feature branch with a commit
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature commit", &[("feature.txt", "feature content")]);

        // Go back to default branch
        repo.checkout_branch(&default_branch);

        // Cherry-pick from the feature branch (default count = 1)
        let result = cherry_pick_from_branch(repo.path_str(), "feature".to_string(), None).await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].summary, "Feature commit");

        // Verify the file exists
        let content = std::fs::read_to_string(repo.path.join("feature.txt")).unwrap();
        assert_eq!(content, "feature content");
    }

    #[tokio::test]
    async fn test_cherry_pick_from_branch_multiple_commits() {
        let repo = TestRepo::with_initial_commit();
        let default_branch = repo.current_branch();

        // Create a feature branch with multiple commits
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature commit 1", &[("file1.txt", "content1")]);
        repo.create_commit("Feature commit 2", &[("file2.txt", "content2")]);
        repo.create_commit("Feature commit 3", &[("file3.txt", "content3")]);

        // Go back to default branch
        repo.checkout_branch(&default_branch);

        // Cherry-pick 2 commits from the tip
        let result = cherry_pick_from_branch(repo.path_str(), "feature".to_string(), Some(2)).await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        assert_eq!(commits.len(), 2);
        // Oldest first: commit 2, then commit 3
        assert_eq!(commits[0].summary, "Feature commit 2");
        assert_eq!(commits[1].summary, "Feature commit 3");

        // Verify both files exist
        assert!(repo.path.join("file2.txt").exists());
        assert!(repo.path.join("file3.txt").exists());
        // file1.txt should NOT exist since we only picked the last 2
        assert!(!repo.path.join("file1.txt").exists());
    }

    #[tokio::test]
    async fn test_cherry_pick_from_branch_not_found() {
        let repo = TestRepo::with_initial_commit();

        let result =
            cherry_pick_from_branch(repo.path_str(), "nonexistent".to_string(), None).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_cherry_pick_from_branch_zero_count_fails() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("feature");

        let result = cherry_pick_from_branch(repo.path_str(), "feature".to_string(), Some(0)).await;

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("Count must be at least 1"));
    }

    #[tokio::test]
    async fn test_cherry_pick_from_branch_count_exceeds_history() {
        let repo = TestRepo::with_initial_commit();
        let default_branch = repo.current_branch();

        // Create feature branch with 1 commit (plus the initial commit)
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature commit", &[("feature.txt", "content")]);

        repo.checkout_branch(&default_branch);

        // Request 100 commits but branch only has 2 total (initial + feature)
        let result =
            cherry_pick_from_branch(repo.path_str(), "feature".to_string(), Some(100)).await;

        // Should succeed, cherry-picking all available commits
        // The initial commit is a root commit so it will fail on root commit check
        // Actually, it will try to cherry-pick root commit which should fail
        assert!(result.is_err());
    }

    // ==================== Regression tests: canonical git parity ====================

    /// Build a merge commit on the current HEAD merging in `other`, returning its
    /// oid. The merge's tree is just HEAD's tree (content is irrelevant for these
    /// tests, which only exercise the merge-parent handling).
    fn make_merge_commit(repo: &TestRepo, other: git2::Oid) -> git2::Oid {
        let git_repo = repo.repo();
        let sig = git_repo.signature().unwrap();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        let other_commit = git_repo.find_commit(other).unwrap();
        let tree = head.tree().unwrap();
        git_repo
            .commit(
                Some("HEAD"),
                &sig,
                &sig,
                "Merge commit",
                &tree,
                &[&head, &other_commit],
            )
            .unwrap()
    }

    // ---- Finding 42: empty cherry-pick / revert must stop, not commit ----

    #[tokio::test]
    async fn test_cherry_pick_already_applied_stops() {
        let test_repo = TestRepo::with_initial_commit();

        // Commit a change on feature, then make the identical change on main.
        test_repo.create_commit("Base", &[("f.txt", "x")]);
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        let feature_oid = test_repo.create_commit("Change to y", &[("f.txt", "y")]);

        test_repo.checkout_branch("main");
        test_repo.create_commit("Same change to y", &[("f.txt", "y")]);
        let head_before = test_repo.head_oid();

        // Cherry-picking the already-applied change must stop with an empty error
        // and create NO commit (matching `git cherry-pick`'s default --empty=stop).
        let result = cherry_pick(test_repo.path_str(), feature_oid.to_string(), None, None).await;
        assert!(result.is_err(), "empty cherry-pick must not succeed");
        assert!(
            result
                .unwrap_err()
                .to_string()
                .to_lowercase()
                .contains("empty"),
            "error should explain the pick is empty"
        );

        // HEAD must not have advanced (no empty commit was created).
        assert_eq!(test_repo.head_oid(), head_before);
        // git leaves CHERRY_PICK_HEAD in place so the user can skip/abort.
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::CherryPick);
    }

    #[tokio::test]
    async fn test_revert_already_undone_stops() {
        let test_repo = TestRepo::with_initial_commit();

        // f.txt starts at x, A changes it to y, B changes it back to x (the exact
        // inverse). Reverting A is then a no-op → empty.
        test_repo.create_commit("Setup", &[("f.txt", "x")]);
        let add_oid = test_repo.create_commit("A: x->y", &[("f.txt", "y")]);
        test_repo.create_commit("B: y->x", &[("f.txt", "x")]);
        let head_before = test_repo.head_oid();

        // Reverting the already-undone commit is empty; git stops.
        let result = revert(test_repo.path_str(), add_oid.to_string(), None).await;
        assert!(result.is_err(), "empty revert must not succeed");
        assert!(
            result
                .unwrap_err()
                .to_string()
                .to_lowercase()
                .contains("empty"),
            "error should explain the revert is empty"
        );
        assert_eq!(test_repo.head_oid(), head_before);
    }

    // ---- Finding 43: merge commits require an explicit mainline ----

    #[tokio::test]
    async fn test_cherry_pick_merge_without_mainline_refuses() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        let feat = test_repo.create_commit("Feature", &[("feat.txt", "f")]);
        test_repo.checkout_branch("main");
        test_repo.create_commit("Main", &[("main.txt", "m")]);
        let merge_oid = make_merge_commit(&test_repo, feat);

        // Without a mainline, git refuses to cherry-pick a merge commit.
        let result = cherry_pick(test_repo.path_str(), merge_oid.to_string(), None, None).await;
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .to_lowercase()
                .contains("mainline"),
            "error should mention the missing mainline"
        );

        // An out-of-range mainline is rejected too.
        let result = cherry_pick(test_repo.path_str(), merge_oid.to_string(), None, Some(5)).await;
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .to_lowercase()
            .contains("out of range"));
    }

    #[tokio::test]
    async fn test_revert_merge_without_mainline_refuses() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        let feat = test_repo.create_commit("Feature", &[("feat.txt", "f")]);
        test_repo.checkout_branch("main");
        test_repo.create_commit("Main", &[("main.txt", "m")]);
        let merge_oid = make_merge_commit(&test_repo, feat);

        let result = revert(test_repo.path_str(), merge_oid.to_string(), None).await;
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .to_lowercase()
                .contains("mainline"),
            "error should mention the missing mainline"
        );
    }

    #[tokio::test]
    async fn test_cherry_pick_merge_with_mainline_is_accepted() {
        // With an explicit, in-range mainline the merge-commit guard must NOT
        // block the operation — the frontend now always supplies one for merge
        // commits, so this contract must hold (any later empty/conflict outcome
        // is fine; what must not happen is the "no mainline" refusal).
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        let feat = test_repo.create_commit("Feature", &[("feat.txt", "f")]);
        test_repo.checkout_branch("main");
        test_repo.create_commit("Main", &[("main.txt", "m")]);
        let merge_oid = make_merge_commit(&test_repo, feat);

        let result = cherry_pick(test_repo.path_str(), merge_oid.to_string(), None, Some(1)).await;
        if let Err(e) = &result {
            assert!(
                !e.to_string()
                    .to_lowercase()
                    .contains("no mainline parent was given"),
                "an explicit mainline must satisfy the merge-commit guard, got: {e}"
            );
        }
    }

    #[tokio::test]
    async fn test_revert_merge_with_mainline_is_accepted() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        let feat = test_repo.create_commit("Feature", &[("feat.txt", "f")]);
        test_repo.checkout_branch("main");
        test_repo.create_commit("Main", &[("main.txt", "m")]);
        let merge_oid = make_merge_commit(&test_repo, feat);

        let result = revert(test_repo.path_str(), merge_oid.to_string(), Some(1)).await;
        if let Err(e) = &result {
            assert!(
                !e.to_string()
                    .to_lowercase()
                    .contains("no mainline parent was given"),
                "an explicit mainline must satisfy the merge-commit guard, got: {e}"
            );
        }
    }

    // ---- Finding 40: aborting must preserve unrelated uncommitted work ----

    fn stage_file(test_repo: &TestRepo, path: &str, content: &str) -> git2::Oid {
        std::fs::write(test_repo.path.join(path), content).unwrap();
        let repo = test_repo.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new(path)).unwrap();
        index.write().unwrap();
        index.get_path(std::path::Path::new(path), 0).unwrap().id
    }

    #[tokio::test]
    async fn test_cherry_pick_refuses_preexisting_staged_changes() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("Add unrelated", &[("unrelated.txt", "original")]);
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        let feature_oid = test_repo.create_commit("Feature commit", &[("feature.txt", "feature")]);
        test_repo.checkout_branch("main");

        let staged_oid = stage_file(&test_repo, "unrelated.txt", "STAGED WORK");
        let result = cherry_pick(test_repo.path_str(), feature_oid.to_string(), None, None).await;

        assert!(result
            .unwrap_err()
            .to_string()
            .contains("index has staged changes"));
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);
        assert_eq!(
            test_repo
                .repo()
                .index()
                .unwrap()
                .get_path(std::path::Path::new("unrelated.txt"), 0)
                .unwrap()
                .id,
            staged_oid
        );
    }

    #[tokio::test]
    async fn test_revert_refuses_preexisting_staged_changes() {
        let test_repo = TestRepo::with_initial_commit();
        let revert_oid = test_repo.create_commit("Add file", &[("file.txt", "content")]);
        test_repo.create_commit("Add unrelated", &[("unrelated.txt", "original")]);

        let staged_oid = stage_file(&test_repo, "unrelated.txt", "STAGED WORK");
        let result = revert(test_repo.path_str(), revert_oid.to_string(), None).await;

        assert!(result
            .unwrap_err()
            .to_string()
            .contains("index has staged changes"));
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);
        assert_eq!(
            test_repo
                .repo()
                .index()
                .unwrap()
                .get_path(std::path::Path::new("unrelated.txt"), 0)
                .unwrap()
                .id,
            staged_oid
        );
    }

    #[tokio::test]
    async fn test_cherry_pick_range_refuses_preexisting_staged_changes() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("Add unrelated", &[("unrelated.txt", "original")]);
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        let feature_oid = test_repo.create_commit("Feature commit", &[("feature.txt", "feature")]);
        test_repo.checkout_branch("main");

        let staged_oid = stage_file(&test_repo, "unrelated.txt", "STAGED WORK");
        let result = cherry_pick_range(test_repo.path_str(), vec![feature_oid.to_string()]).await;

        assert!(result
            .unwrap_err()
            .to_string()
            .contains("index has staged changes"));
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);
        assert_eq!(
            test_repo
                .repo()
                .index()
                .unwrap()
                .get_path(std::path::Path::new("unrelated.txt"), 0)
                .unwrap()
                .id,
            staged_oid
        );
    }

    #[tokio::test]
    async fn test_cherry_pick_from_branch_refuses_preexisting_staged_changes() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("Add unrelated", &[("unrelated.txt", "original")]);
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        test_repo.create_commit("Feature commit", &[("feature.txt", "feature")]);
        test_repo.checkout_branch("main");

        let staged_oid = stage_file(&test_repo, "unrelated.txt", "STAGED WORK");
        let result =
            cherry_pick_from_branch(test_repo.path_str(), "feature".to_string(), None).await;

        assert!(result
            .unwrap_err()
            .to_string()
            .contains("index has staged changes"));
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);
        assert_eq!(
            test_repo
                .repo()
                .index()
                .unwrap()
                .get_path(std::path::Path::new("unrelated.txt"), 0)
                .unwrap()
                .id,
            staged_oid
        );
    }

    #[tokio::test]
    async fn test_no_commit_cherry_pick_refuses_preexisting_staged_changes() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit(
            "Add files",
            &[("conflict.txt", "base"), ("unrelated.txt", "original")],
        );
        let repo = test_repo.repo();
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        let parent = head_commit.parent(0).unwrap();
        repo.branch("feature", &parent, false).unwrap();
        test_repo.checkout_branch("feature");
        let feature_oid =
            test_repo.create_commit("Feature conflict", &[("conflict.txt", "feature")]);
        test_repo.checkout_branch("main");
        test_repo.create_commit("Main conflict", &[("conflict.txt", "main")]);

        let staged_oid = stage_file(&test_repo, "unrelated.txt", "PRECIOUS STAGED WORK");
        let result = cherry_pick(
            test_repo.path_str(),
            feature_oid.to_string(),
            Some(true),
            None,
        )
        .await;
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("index has staged changes"));

        let repo = test_repo.repo();
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
        assert_eq!(
            std::fs::read_to_string(test_repo.path.join("unrelated.txt")).unwrap(),
            "PRECIOUS STAGED WORK"
        );
        assert_eq!(
            repo.index()
                .unwrap()
                .get_path(std::path::Path::new("unrelated.txt"), 0)
                .unwrap()
                .id,
            staged_oid
        );
    }

    /// A `no_commit` pick leaves its work staged with `state()` back to Clean,
    /// so the next pick meets the guard. libgit2's merge preflight refuses that
    /// index regardless (it rejects any index that differs from HEAD, even a
    /// pure addition), so the guard is not what makes chaining impossible — it
    /// only replaces libgit2's "uncommitted changes would be overwritten by
    /// merge" with something the user can act on. The first pick's work must
    /// survive intact either way.
    #[tokio::test]
    async fn test_no_commit_cherry_pick_chain_reports_actionable_error() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        let first = test_repo.create_commit("First", &[("first.txt", "first")]);
        let second = test_repo.create_commit("Second", &[("second.txt", "second")]);
        test_repo.checkout_branch("main");

        cherry_pick(test_repo.path_str(), first.to_string(), Some(true), None)
            .await
            .expect("first no_commit pick should succeed");

        let err = cherry_pick(test_repo.path_str(), second.to_string(), Some(true), None)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("index has staged changes"),
            "expected an actionable message, got: {err}"
        );

        let repo = test_repo.repo();
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
        assert!(repo
            .index()
            .unwrap()
            .get_path(std::path::Path::new("first.txt"), 0)
            .is_some());
    }

    /// A staged deletion of a path HEAD tracks is work the operation could
    /// destroy just as surely as a staged edit, so it must still be refused.
    #[tokio::test]
    async fn test_cherry_pick_refuses_staged_deletion() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("Add unrelated", &[("unrelated.txt", "original")]);
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        let feature_oid = test_repo.create_commit("Feature commit", &[("feature.txt", "feature")]);
        test_repo.checkout_branch("main");

        let repo = test_repo.repo();
        let mut index = repo.index().unwrap();
        index
            .remove_path(std::path::Path::new("unrelated.txt"))
            .unwrap();
        index.write().unwrap();

        let result = cherry_pick(test_repo.path_str(), feature_oid.to_string(), None, None).await;
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("index has staged changes"));
    }

    /// A conflicted stash apply leaves unmerged entries in the index while
    /// `state()` stays Clean. Diffing (or writing) a tree fails outright there,
    /// so the guard must recognise it rather than leak a raw libgit2 error.
    fn leave_conflicted_index(test_repo: &TestRepo) {
        test_repo.create_commit("Base", &[("conflict.txt", "base")]);
        {
            let mut repo = test_repo.repo();
            std::fs::write(test_repo.path.join("conflict.txt"), "stashed").unwrap();
            let signature = repo.signature().unwrap();
            repo.stash_save(&signature, "wip", None).unwrap();
        }
        test_repo.create_commit("Diverge", &[("conflict.txt", "other")]);

        // Re-open: a Repository handle caches its index, so the one that saved
        // the stash would apply against a stale snapshot.
        let mut repo = test_repo.repo();
        repo.stash_apply(0, None).unwrap();
        assert!(repo.index().unwrap().has_conflicts());
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
    }

    #[tokio::test]
    async fn test_revert_refuses_unmerged_index() {
        let test_repo = TestRepo::with_initial_commit();
        let revert_oid = test_repo.create_commit("Add file", &[("file.txt", "content")]);
        leave_conflicted_index(&test_repo);

        let err = revert(test_repo.path_str(), revert_oid.to_string(), None)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("index has unmerged files"),
            "expected an actionable message, got: {err}"
        );
    }

    #[tokio::test]
    async fn test_cherry_pick_refuses_unmerged_index() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        let feature_oid = test_repo.create_commit("Feature commit", &[("feature.txt", "feature")]);
        test_repo.checkout_branch("main");
        leave_conflicted_index(&test_repo);

        let err = cherry_pick(test_repo.path_str(), feature_oid.to_string(), None, None)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("index has unmerged files"),
            "expected an actionable message, got: {err}"
        );
    }

    #[tokio::test]
    async fn test_abort_cherry_pick_preserves_unrelated_changes() {
        let test_repo = TestRepo::with_initial_commit();

        // Commit conflict.txt and unrelated.txt on main.
        test_repo.create_commit(
            "Add files",
            &[("conflict.txt", "base"), ("unrelated.txt", "orig")],
        );
        let repo = test_repo.repo();
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        let parent = head_commit.parent(0).unwrap();
        repo.branch("feature", &parent, false).unwrap();
        test_repo.checkout_branch("feature");
        let feature_oid =
            test_repo.create_commit("Feature conflict", &[("conflict.txt", "feature")]);
        test_repo.checkout_branch("main");
        // Re-add conflict.txt on main so the pick conflicts.
        test_repo.create_commit("Main conflict", &[("conflict.txt", "main")]);

        // Uncommitted edit to an unrelated tracked file.
        std::fs::write(test_repo.path.join("unrelated.txt"), "PRECIOUS WORK").unwrap();

        // Cherry-pick conflicts on conflict.txt.
        let result = cherry_pick(test_repo.path_str(), feature_oid.to_string(), None, None).await;
        assert!(matches!(result, Err(GitnadoError::CherryPickConflict)));

        // Abort must restore conflict.txt but preserve the unrelated edit.
        abort_cherry_pick(test_repo.path_str()).await.unwrap();

        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);
        let unrelated = std::fs::read_to_string(test_repo.path.join("unrelated.txt")).unwrap();
        assert_eq!(
            unrelated, "PRECIOUS WORK",
            "unrelated uncommitted work must survive the abort"
        );
        let conflict = std::fs::read_to_string(test_repo.path.join("conflict.txt")).unwrap();
        assert_eq!(conflict, "main", "conflicted file restored to HEAD");
    }

    #[tokio::test]
    async fn test_abort_revert_preserves_unrelated_changes() {
        let test_repo = TestRepo::with_initial_commit();

        test_repo.create_commit("Add unrelated", &[("unrelated.txt", "orig")]);
        let add_oid = test_repo.create_commit("Add file", &[("file.txt", "original")]);
        test_repo.create_commit("Modify file", &[("file.txt", "modified")]);

        std::fs::write(test_repo.path.join("unrelated.txt"), "PRECIOUS WORK").unwrap();

        // Reverting the add conflicts on file.txt (later modified).
        let result = revert(test_repo.path_str(), add_oid.to_string(), None).await;
        assert!(matches!(result, Err(GitnadoError::RevertConflict)));

        abort_revert(test_repo.path_str()).await.unwrap();

        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);
        let unrelated = std::fs::read_to_string(test_repo.path.join("unrelated.txt")).unwrap();
        assert_eq!(unrelated, "PRECIOUS WORK");
    }

    /// A cherry-pick that ADDS a file whose name is not valid UTF-8 must still
    /// have that file removed on abort.
    ///
    /// git paths are bytes; on unix a non-UTF-8 filename is ordinary. Decoding
    /// it with `from_utf8(..).unwrap_or("")` collapsed the path to the workdir
    /// root, so the explicit removal — the step that handles files ADDED by the
    /// operation, which a path-scoped checkout_head cannot restore because they
    /// are absent from HEAD — silently did nothing and left the file behind.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_abort_cherry_pick_removes_added_non_utf8_path() {
        use std::os::unix::ffi::OsStrExt;

        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("Base", &[("shared.txt", "base")]);

        let odd_name = std::ffi::OsStr::from_bytes(b"added-\xff.txt");
        let odd_rel = std::path::Path::new(odd_name);

        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        // Commit the odd-named file alongside a conflicting edit, so the pick
        // both adds it and fails.
        std::fs::write(test_repo.path.join(odd_rel), "picked").unwrap();
        std::fs::write(test_repo.path.join("shared.txt"), "feature").unwrap();
        let feature_oid = {
            let repo = test_repo.repo();
            let mut index = repo.index().unwrap();
            index.add_path(odd_rel).unwrap();
            index.add_path(std::path::Path::new("shared.txt")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = repo.signature().unwrap();
            let parent = repo.head().unwrap().peel_to_commit().unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "Feature", &tree, &[&parent])
                .unwrap()
        };

        test_repo.checkout_branch("main");
        test_repo.create_commit("Main edits shared", &[("shared.txt", "main")]);

        let result = cherry_pick(test_repo.path_str(), feature_oid.to_string(), None, None).await;
        assert!(matches!(result, Err(GitnadoError::CherryPickConflict)));
        assert!(
            test_repo.path.join(odd_rel).exists(),
            "the conflicting pick writes the added file into the working tree"
        );

        abort_cherry_pick(test_repo.path_str()).await.unwrap();

        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);
        assert!(
            !test_repo.path.join(odd_rel).exists(),
            "abort must remove a file the pick added, whatever its name encodes to"
        );
    }

    // ---- Finding 44: multi-commit sequencer abort rewinds & continue resumes ----

    /// Set up main at M with a feature branch [A (clean), B (conflicts), C (clean)]
    /// branched before M. Returns (pre_sequence_head = M, [A, B, C]).
    fn setup_range(test_repo: &TestRepo) -> (git2::Oid, git2::Oid, git2::Oid, git2::Oid) {
        // Base commit adds shared.txt.
        test_repo.create_commit("Base", &[("shared.txt", "base")]);
        // Feature branch from base.
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        let a = test_repo.create_commit("A adds a.txt", &[("a.txt", "a")]);
        let b = test_repo.create_commit("B edits shared", &[("shared.txt", "feature")]);
        let c = test_repo.create_commit("C adds c.txt", &[("c.txt", "c")]);
        // Main diverges: edit shared.txt so B will conflict.
        test_repo.checkout_branch("main");
        test_repo.create_commit("Main edits shared", &[("shared.txt", "main")]);
        let m = test_repo.head_oid();
        (m, a, b, c)
    }

    #[tokio::test]
    async fn test_cherry_pick_range_abort_rewinds_applied_picks() {
        let test_repo = TestRepo::with_initial_commit();
        let (m, a, b, _c) = setup_range(&test_repo);

        // Range [A, B]: A applies cleanly, B conflicts.
        let result =
            cherry_pick_range(test_repo.path_str(), vec![a.to_string(), b.to_string()]).await;
        assert!(matches!(result, Err(GitnadoError::CherryPickConflict)));

        // A was applied on top of M, so HEAD advanced and a.txt exists.
        assert_ne!(test_repo.head_oid(), m);
        assert!(test_repo.path.join("a.txt").exists());

        // Abort must rewind HEAD all the way back to the pre-sequence commit M,
        // removing the already-applied A (git's return-to-pre-sequence-HEAD).
        abort_cherry_pick(test_repo.path_str()).await.unwrap();

        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);
        assert_eq!(
            test_repo.head_oid(),
            m,
            "abort must rewind to pre-sequence HEAD"
        );
        assert!(
            !test_repo.path.join("a.txt").exists(),
            "applied pick removed"
        );
        // Sequencer sidecar files must be cleaned up.
        let git_dir = test_repo.repo().path().to_path_buf();
        assert!(!git_dir.join(CHERRY_PICK_SEQUENCE).exists());
        assert!(!git_dir.join(CHERRY_PICK_SEQUENCE_HEAD).exists());
    }

    #[tokio::test]
    async fn test_cherry_pick_range_abort_rewinds_on_empty_mid_pick() {
        // A mid-range pick that is already present in HEAD stops the sequence
        // with an "empty" error (not a conflict). Abort must still rewind the
        // whole range to the pre-sequence HEAD, removing earlier applied picks —
        // this only works if the sequence head was persisted before the loop.
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("Base", &[("shared.txt", "base")]);
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        let a = test_repo.create_commit("A adds a.txt", &[("a.txt", "a")]);
        let d = test_repo.create_commit("D adds d.txt", &[("d.txt", "d")]);
        let e = test_repo.create_commit("E adds e.txt", &[("e.txt", "e")]);

        // Pre-apply D onto main so the mid-range pick of D becomes empty.
        test_repo.checkout_branch("main");
        cherry_pick(test_repo.path_str(), d.to_string(), None, None)
            .await
            .unwrap();
        let pre_seq = test_repo.head_oid();

        // Range [A, D, E]: A applies, D is empty -> Err; repo left mid-sequence.
        let result = cherry_pick_range(
            test_repo.path_str(),
            vec![a.to_string(), d.to_string(), e.to_string()],
        )
        .await;
        assert!(
            result.is_err(),
            "an already-applied mid-range pick must error"
        );
        assert_ne!(test_repo.head_oid(), pre_seq, "A was applied");

        // Abort must rewind to the pre-sequence HEAD, removing the applied A.
        abort_cherry_pick(test_repo.path_str()).await.unwrap();
        assert_eq!(
            test_repo.head_oid(),
            pre_seq,
            "abort must rewind to pre-sequence HEAD even after an empty pick"
        );
        assert!(
            !test_repo.path.join("a.txt").exists(),
            "applied pick A must be removed on abort"
        );
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);
    }

    #[tokio::test]
    async fn test_cherry_pick_range_continue_resumes_remaining() {
        let test_repo = TestRepo::with_initial_commit();
        let (_m, a, b, c) = setup_range(&test_repo);

        // Range [A, B, C]: A clean, B conflicts, C still pending.
        let result = cherry_pick_range(
            test_repo.path_str(),
            vec![a.to_string(), b.to_string(), c.to_string()],
        )
        .await;
        assert!(matches!(result, Err(GitnadoError::CherryPickConflict)));

        // Resolve B's conflict and stage it.
        std::fs::write(test_repo.path.join("shared.txt"), "resolved").unwrap();
        let repo = test_repo.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("shared.txt")).unwrap();
        index.write().unwrap();

        // Continue must commit B AND resume the remaining pick C.
        let last = continue_cherry_pick(test_repo.path_str()).await.unwrap();
        assert_eq!(last.summary, "C adds c.txt", "the last resumed pick is C");

        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);
        assert!(test_repo.path.join("a.txt").exists());
        assert!(test_repo.path.join("c.txt").exists());
        assert_eq!(
            std::fs::read_to_string(test_repo.path.join("shared.txt")).unwrap(),
            "resolved"
        );
        // Sequencer sidecar files must be gone.
        let git_dir = test_repo.repo().path().to_path_buf();
        assert!(!git_dir.join(CHERRY_PICK_SEQUENCE).exists());
        assert!(!git_dir.join(CHERRY_PICK_SEQUENCE_HEAD).exists());
    }

    // ---- Empty/conflicted picks are skippable, and a stop keeps the remainder ----

    /// main with [A, D, E] on feature and D already applied to main, so a range
    /// of [A, D, E] stops on D with an "empty" error. Returns (pre_seq, a, d, e).
    async fn setup_empty_mid_range(
        test_repo: &TestRepo,
    ) -> (git2::Oid, git2::Oid, git2::Oid, git2::Oid) {
        test_repo.create_commit("Base", &[("shared.txt", "base")]);
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        let a = test_repo.create_commit("A adds a.txt", &[("a.txt", "a")]);
        let d = test_repo.create_commit("D adds d.txt", &[("d.txt", "d")]);
        let e = test_repo.create_commit("E adds e.txt", &[("e.txt", "e")]);

        // Pre-apply D onto main so the mid-range pick of D becomes empty.
        test_repo.checkout_branch("main");
        cherry_pick(test_repo.path_str(), d.to_string(), None, None)
            .await
            .unwrap();
        (test_repo.head_oid(), a, d, e)
    }

    #[tokio::test]
    async fn test_cherry_pick_range_empty_mid_pick_queues_remaining() {
        // An already-applied mid-range pick stops the sequence. git keeps the
        // REST of the range queued so `--skip` can resume it; signalling the
        // empty stop through Err used to return before the sequencer state was
        // written, silently dropping every commit after it.
        let test_repo = TestRepo::with_initial_commit();
        let (_pre_seq, a, d, e) = setup_empty_mid_range(&test_repo).await;

        let result = cherry_pick_range(
            test_repo.path_str(),
            vec![a.to_string(), d.to_string(), e.to_string()],
        )
        .await;
        assert!(
            result
                .unwrap_err()
                .to_string()
                .to_lowercase()
                .contains("empty"),
            "the mid-range stop must report the pick as empty"
        );

        let seq_path = test_repo.repo().path().join(CHERRY_PICK_SEQUENCE);
        assert!(
            seq_path.exists(),
            "the commits after the empty pick must stay queued"
        );
        assert_eq!(
            std::fs::read_to_string(&seq_path).unwrap().trim(),
            e.to_string(),
            "only E is still pending — D itself must not be re-queued"
        );
    }

    #[tokio::test]
    async fn test_skip_cherry_pick_resumes_after_empty_stop() {
        let test_repo = TestRepo::with_initial_commit();
        let (pre_seq, a, d, e) = setup_empty_mid_range(&test_repo).await;

        let _ = cherry_pick_range(
            test_repo.path_str(),
            vec![a.to_string(), d.to_string(), e.to_string()],
        )
        .await;

        // Skip drops the already-applied D and resumes with E, keeping A.
        let last = skip_cherry_pick(test_repo.path_str())
            .await
            .expect("skip must succeed")
            .expect("the resumed sequence applied E");
        assert_eq!(last.summary, "E adds e.txt");

        assert!(test_repo.path.join("a.txt").exists(), "A stays applied");
        assert!(test_repo.path.join("e.txt").exists(), "E was resumed");
        assert_ne!(
            test_repo.head_oid(),
            pre_seq,
            "skip must not rewind already-applied picks"
        );
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);

        let git_dir = test_repo.repo().path().to_path_buf();
        assert!(!git_dir.join("CHERRY_PICK_HEAD").exists());
        assert!(!git_dir.join(CHERRY_PICK_SEQUENCE).exists());
        assert!(!git_dir.join(CHERRY_PICK_SEQUENCE_HEAD).exists());
    }

    #[tokio::test]
    async fn test_skip_cherry_pick_drops_conflicted_pick_and_resumes() {
        let test_repo = TestRepo::with_initial_commit();
        let (m, a, b, c) = setup_range(&test_repo);

        let result = cherry_pick_range(
            test_repo.path_str(),
            vec![a.to_string(), b.to_string(), c.to_string()],
        )
        .await;
        assert!(matches!(result, Err(GitnadoError::CherryPickConflict)));

        // Skip abandons the conflicted B and applies the pending C.
        let last = skip_cherry_pick(test_repo.path_str())
            .await
            .expect("skip must succeed")
            .expect("the resumed sequence applied C");
        assert_eq!(last.summary, "C adds c.txt");

        assert!(test_repo.path.join("a.txt").exists(), "A stays applied");
        assert!(test_repo.path.join("c.txt").exists(), "C was resumed");
        let shared = std::fs::read_to_string(test_repo.path.join("shared.txt")).unwrap();
        assert_eq!(shared, "main", "the skipped pick's changes are dropped");
        assert!(!shared.contains("<<<<<<<"), "no conflict markers survive");
        assert!(!test_repo.repo().index().unwrap().has_conflicts());
        assert_ne!(test_repo.head_oid(), m, "skip is not an abort — A survives");
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);

        let git_dir = test_repo.repo().path().to_path_buf();
        assert!(!git_dir.join("CHERRY_PICK_HEAD").exists());
        assert!(!git_dir.join(CHERRY_PICK_SEQUENCE).exists());
        assert!(!git_dir.join(CHERRY_PICK_SEQUENCE_HEAD).exists());
    }

    #[tokio::test]
    async fn test_skip_cherry_pick_single_pick_returns_none() {
        // A lone cherry-pick that stopped as empty has no queued remainder, so
        // the skip simply ends the operation.
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("Base", &[("f.txt", "x")]);
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        let feature_oid = test_repo.create_commit("Change to y", &[("f.txt", "y")]);
        test_repo.checkout_branch("main");
        test_repo.create_commit("Same change to y", &[("f.txt", "y")]);
        let head_before = test_repo.head_oid();

        let result = cherry_pick(test_repo.path_str(), feature_oid.to_string(), None, None).await;
        assert!(result.is_err());

        let last = skip_cherry_pick(test_repo.path_str()).await.unwrap();
        assert!(last.is_none(), "nothing was left to apply");
        assert_eq!(test_repo.head_oid(), head_before, "no commit is created");
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);
        assert!(!test_repo.repo().path().join("CHERRY_PICK_HEAD").exists());
    }

    #[tokio::test]
    async fn test_skip_cherry_pick_with_nothing_in_progress_errors() {
        let test_repo = TestRepo::with_initial_commit();
        let head_before = test_repo.head_oid();
        test_repo.create_file("dirty.txt", "uncommitted");

        let err = skip_cherry_pick(test_repo.path_str())
            .await
            .expect_err("skipping with no cherry-pick in progress must fail");
        assert!(
            err.to_string()
                .contains("no cherry-pick in progress to skip"),
            "unexpected error: {}",
            err
        );

        // Refusing must leave the repository entirely untouched.
        assert_eq!(test_repo.head_oid(), head_before);
        assert_eq!(
            std::fs::read_to_string(test_repo.path.join("dirty.txt")).unwrap(),
            "uncommitted"
        );
    }

    #[tokio::test]
    async fn test_skip_cherry_pick_reports_an_unreadable_sequence_file() {
        // An unreadable CHERRY_PICK_SEQUENCE is not the same as an absent one:
        // it still names commits the user queued. Reporting success and
        // dropping them would end the range silently, with no error and no
        // in-progress state left to tell the user anything went wrong.
        let test_repo = TestRepo::with_initial_commit();
        let (_m, a, b, c) = setup_range(&test_repo);

        let result = cherry_pick_range(
            test_repo.path_str(),
            vec![a.to_string(), b.to_string(), c.to_string()],
        )
        .await;
        assert!(matches!(result, Err(GitnadoError::CherryPickConflict)));

        // C is still queued; corrupt the file so read_to_string fails with
        // something other than NotFound (invalid UTF-8 -> InvalidData).
        let seq_path = test_repo.repo().path().join(CHERRY_PICK_SEQUENCE);
        assert_eq!(
            std::fs::read_to_string(&seq_path).unwrap().trim(),
            c.to_string()
        );
        std::fs::write(&seq_path, [0xff, 0xfe, 0xfd]).unwrap();

        let err = skip_cherry_pick(test_repo.path_str())
            .await
            .expect_err("an unreadable sequence must not report success");
        assert!(
            err.to_string()
                .contains("Could not read the queued cherry-pick sequence"),
            "unexpected error: {}",
            err
        );

        // The queued C was never applied, and nothing pretended it was.
        assert!(!test_repo.path.join("c.txt").exists());

        // No cherry-pick is left in progress, so the sidecars must be gone —
        // a stale CHERRY_PICK_SEQUENCE_HEAD would let a later, unrelated
        // abort rewind past commits it never touched.
        let git_dir = test_repo.repo().path().to_path_buf();
        assert!(!git_dir.join("CHERRY_PICK_HEAD").exists());
        assert!(!git_dir.join(CHERRY_PICK_SEQUENCE).exists());
        assert!(!git_dir.join(CHERRY_PICK_SEQUENCE_HEAD).exists());
    }

    #[tokio::test]
    async fn test_skip_cherry_pick_preserves_unrelated_dirty_file() {
        // Skip restores only the paths the stopped pick touched (reset --merge
        // semantics). A blanket force checkout here would destroy unrelated
        // uncommitted work.
        let test_repo = TestRepo::with_initial_commit();
        let (_m, a, b, c) = setup_range(&test_repo);

        let _ = cherry_pick_range(
            test_repo.path_str(),
            vec![a.to_string(), b.to_string(), c.to_string()],
        )
        .await;

        // README.md is tracked and unrelated to any pick in the range.
        std::fs::write(test_repo.path.join("README.md"), "local edit").unwrap();

        skip_cherry_pick(test_repo.path_str()).await.unwrap();

        assert_eq!(
            std::fs::read_to_string(test_repo.path.join("README.md")).unwrap(),
            "local edit",
            "skip must not discard unrelated uncommitted work"
        );
    }

    #[tokio::test]
    async fn test_continue_cherry_pick_empty_mid_sequence_queues_remaining() {
        // Resuming a range can itself hit an already-applied pick. The stop must
        // strip that commit from the sequence file, otherwise the next
        // continue/skip re-attempts it and loops forever.
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("Base", &[("shared.txt", "base")]);
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        let a = test_repo.create_commit("A adds a.txt", &[("a.txt", "a")]);
        let b = test_repo.create_commit("B edits shared", &[("shared.txt", "feature")]);
        let d = test_repo.create_commit("D adds d.txt", &[("d.txt", "d")]);
        let e = test_repo.create_commit("E adds e.txt", &[("e.txt", "e")]);

        test_repo.checkout_branch("main");
        test_repo.create_commit("Main edits shared", &[("shared.txt", "main")]);
        // Pre-apply D so the resumed sequence stops on it as empty.
        cherry_pick(test_repo.path_str(), d.to_string(), None, None)
            .await
            .unwrap();

        // Range [A, B, D, E]: A applies, B conflicts.
        let result = cherry_pick_range(
            test_repo.path_str(),
            vec![a.to_string(), b.to_string(), d.to_string(), e.to_string()],
        )
        .await;
        assert!(matches!(result, Err(GitnadoError::CherryPickConflict)));

        // Resolve B and stage it.
        std::fs::write(test_repo.path.join("shared.txt"), "resolved").unwrap();
        let repo = test_repo.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("shared.txt")).unwrap();
        index.write().unwrap();

        let err = continue_cherry_pick(test_repo.path_str())
            .await
            .expect_err("the resumed sequence stops on the already-applied D");
        assert!(
            err.to_string().to_lowercase().contains("empty"),
            "unexpected error: {}",
            err
        );

        let seq_path = test_repo.repo().path().join(CHERRY_PICK_SEQUENCE);
        assert!(seq_path.exists(), "E must stay queued behind the stop");
        assert_eq!(
            std::fs::read_to_string(&seq_path).unwrap().trim(),
            e.to_string(),
            "D must be dropped from the sequence so a skip does not re-hit it"
        );
    }

    #[tokio::test]
    async fn test_skip_revert_after_empty_revert() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("Setup", &[("f.txt", "x")]);
        let add_oid = test_repo.create_commit("A: x->y", &[("f.txt", "y")]);
        test_repo.create_commit("B: y->x", &[("f.txt", "x")]);
        let head_before = test_repo.head_oid();

        let result = revert(test_repo.path_str(), add_oid.to_string(), None).await;
        assert!(result.is_err(), "the revert is empty and must stop");

        skip_revert(test_repo.path_str())
            .await
            .expect("skip must end the stopped revert");
        assert_eq!(test_repo.head_oid(), head_before, "no commit is created");
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);
        assert!(!test_repo.repo().path().join("REVERT_HEAD").exists());
    }

    #[tokio::test]
    async fn test_skip_revert_with_nothing_in_progress_errors() {
        let test_repo = TestRepo::with_initial_commit();
        let head_before = test_repo.head_oid();

        let err = skip_revert(test_repo.path_str())
            .await
            .expect_err("skipping with no revert in progress must fail");
        assert!(
            err.to_string().contains("no revert in progress to skip"),
            "unexpected error: {}",
            err
        );
        assert_eq!(test_repo.head_oid(), head_before);
    }

    // ---- Finding 45: state files resolved via repo.path() for linked worktrees ----

    #[tokio::test]
    async fn test_continue_cherry_pick_in_linked_worktree() {
        let test_repo = TestRepo::with_initial_commit();

        // Build a conflict scenario on main.
        test_repo.create_commit("Add", &[("conflict.txt", "base")]);
        let repo = test_repo.repo();
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        let parent = head_commit.parent(0).unwrap();
        repo.branch("feature", &parent, false).unwrap();
        test_repo.checkout_branch("feature");
        let feature_oid = test_repo.create_commit("Feature", &[("conflict.txt", "feature")]);
        test_repo.checkout_branch("main");
        test_repo.create_commit("Main", &[("conflict.txt", "main")]);

        // Create a linked worktree (checked out on a new branch "wt").
        let wt_path = test_repo
            .path
            .parent()
            .unwrap()
            .join(format!("wt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&wt_path);
        {
            let git_repo = test_repo.repo();
            git_repo.worktree("wt", &wt_path, None).unwrap();
        }
        let wt_path_str = wt_path.to_string_lossy().to_string();

        // Cherry-pick in the worktree conflicts.
        let result = cherry_pick(wt_path_str.clone(), feature_oid.to_string(), None, None).await;
        assert!(matches!(result, Err(GitnadoError::CherryPickConflict)));

        // Resolve the conflict inside the worktree and stage it.
        std::fs::write(wt_path.join("conflict.txt"), "resolved in wt").unwrap();
        {
            let wt_repo = git2::Repository::open(&wt_path).unwrap();
            let mut index = wt_repo.index().unwrap();
            index
                .add_path(std::path::Path::new("conflict.txt"))
                .unwrap();
            index.write().unwrap();
        }

        // Continue must find CHERRY_PICK_HEAD via repo.path() (the per-worktree
        // gitdir) rather than <wt>/.git/CHERRY_PICK_HEAD, which does not exist.
        let cont = continue_cherry_pick(wt_path_str.clone()).await;
        assert!(
            cont.is_ok(),
            "continue must succeed in a linked worktree, got: {:?}",
            cont.err()
        );

        let _ = std::fs::remove_dir_all(&wt_path);
    }

    // ---- Finding 46: post-commit hook runs for cherry-pick / revert ----

    #[cfg(unix)]
    #[tokio::test]
    async fn test_cherry_pick_runs_post_commit_hook() {
        let test_repo = TestRepo::with_initial_commit();

        let marker = test_repo.path.join("post-commit-ran");
        test_repo.install_hook(
            "post-commit",
            &format!("#!/bin/sh\ntouch \"{}\"\n", marker.display()),
        );

        // A clean cherry-pick.
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        let feature_oid = test_repo.create_commit("Feature", &[("feature.txt", "content")]);
        test_repo.checkout_branch("main");

        cherry_pick(test_repo.path_str(), feature_oid.to_string(), None, None)
            .await
            .unwrap();

        assert!(
            marker.exists(),
            "post-commit hook must run for a cherry-pick commit"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_revert_runs_post_commit_hook() {
        let test_repo = TestRepo::with_initial_commit();

        let marker = test_repo.path.join("post-commit-ran");
        test_repo.install_hook(
            "post-commit",
            &format!("#!/bin/sh\ntouch \"{}\"\n", marker.display()),
        );

        let commit = test_repo.create_commit("Add file", &[("f.txt", "content")]);
        revert(test_repo.path_str(), commit.to_string(), None)
            .await
            .unwrap();

        assert!(
            marker.exists(),
            "post-commit hook must run for a revert commit"
        );
    }
}
