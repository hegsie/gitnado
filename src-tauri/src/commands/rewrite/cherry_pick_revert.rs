//! Cherry-pick and revert command handlers and sequencer state helpers

use std::path::Path;
use tauri::command;

use super::{CHERRY_PICK_SEQUENCE, CHERRY_PICK_SEQUENCE_HEAD};
use crate::error::{GitnadoError, Result};
use crate::models::Commit;

/// Message git prints when a cherry-pick becomes empty (its changes are already
/// present). Canonical git stops and creates no commit rather than polluting
/// history with an empty commit.
const EMPTY_CHERRY_PICK_MSG: &str = "The cherry-pick is now empty because its changes are already present in HEAD; no commit was created. Skip or abort the cherry-pick to continue.";

/// Message git prints when a revert becomes empty (there is nothing to undo).
const EMPTY_REVERT_MSG: &str = "The revert is now empty because there is nothing to undo; no commit was created. Skip or abort the revert to continue.";

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
