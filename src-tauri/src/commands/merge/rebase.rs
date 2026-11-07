//! Rebase command handlers and interactive rebase helpers

use std::{io::Write, path::Path};
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::utils::create_command;

/// Represents a commit in the interactive rebase todo list
/// Outcome of an interactive rebase run.
///
/// `git rebase -i` exits 0 both when the plan ran to completion and when it
/// stopped at an `edit`/`break` line, so the exit code alone cannot tell the
/// caller whether the repository is still mid-rebase.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveRebaseOutcome {
    /// True when the rebase stopped at a breakpoint and the repo is still in a
    /// rebase state awaiting `git rebase --continue`.
    pub paused: bool,
}

/// The commits `git rebase -i` would list for a range, plus how many merge
/// commits the range contained.
///
/// Merges are omitted from the todo (canonical `git rebase -i` does the same,
/// and a `pick` of one fails mid-run), but omitting them SILENTLY hid that
/// replaying the plan would flatten the topology and rewrite the merged-in side
/// commits — from a gesture that promised only to change one commit message.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebasePlan {
    pub commits: Vec<RebaseCommit>,
    /// Merge commits in the range, excluded from `commits`.
    pub merge_count: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseCommit {
    pub oid: String,
    pub short_id: String,
    pub summary: String,
    /// Everything after the subject line, empty when there is none.
    ///
    /// The reword route amends with `-m`, which REPLACES the whole message —
    /// so seeding the editor from `summary` alone silently deleted trailers,
    /// issue references and rationale. The commit panel's amend has always
    /// carried the body; this is what lets the rebase route match it.
    pub body: String,
    pub action: String,
}

/// Rebase current branch onto another.
///
/// Returns how many commits were skipped because their patch is already
/// present on `onto`. Those are local commits that disappear from the branch,
/// and `git rebase` warns about each one on stderr — there is no stderr here,
/// so the count is handed to the UI to say so instead.
#[command]
pub async fn rebase(path: String, onto: String) -> Result<usize> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Like canonical `git rebase`, refuse up front if another operation is in
    // progress or the working tree is dirty, instead of starting the rebase
    // and failing partway through with a misleading libgit2 error.
    if repo.state() != git2::RepositoryState::Clean {
        return Err(GitnadoError::OperationFailed(
            "Another operation is in progress".to_string(),
        ));
    }
    // Match canonical `git rebase`: staged changes and modifications to tracked
    // files abort the rebase, but untracked (WT_NEW) and ignored files do not.
    let blocking = git2::Status::INDEX_NEW
        | git2::Status::INDEX_MODIFIED
        | git2::Status::INDEX_DELETED
        | git2::Status::INDEX_RENAMED
        | git2::Status::INDEX_TYPECHANGE
        | git2::Status::WT_MODIFIED
        | git2::Status::WT_DELETED
        | git2::Status::WT_TYPECHANGE
        | git2::Status::WT_RENAMED
        | git2::Status::CONFLICTED;
    let has_changes = repo
        .statuses(None)?
        .iter()
        .any(|s| s.status().intersects(blocking));
    if has_changes {
        return Err(GitnadoError::OperationFailed(
            "Working directory has uncommitted changes. Commit or stash them first.".to_string(),
        ));
    }

    // The Hooks dialog advertises pre-rebase as "Run before rebase. Can prevent
    // the rebase", and it does fire for Interactive rebase / Reword / non-HEAD
    // Amend, because those shell out to `git rebase -i` and git runs it. This
    // libgit2 path ran no hooks at all — libgit2 never does — so one repo with
    // one enabled hook had two Rebase buttons, one honouring the veto and one
    // silently ignoring it. Placed after the dirty-tree checks and before any
    // repository state is created, so a refusal leaves nothing behind. git
    // passes <upstream> [<branch>]; the single-argument form is the
    // current-branch invocation.
    crate::commands::hooks::run_hook_blocking(&repo, "pre-rebase", &[&onto], None)?;

    // Find the onto commit
    let onto_ref = repo
        .find_reference(&format!("refs/heads/{}", onto))
        .or_else(|_| repo.find_reference(&format!("refs/remotes/{}", onto)))
        .or_else(|_| repo.find_reference(&onto))?;

    let onto_commit = repo.reference_to_annotated_commit(&onto_ref)?;
    let head = repo.head()?;
    let head_commit = repo.reference_to_annotated_commit(&head)?;

    // Resolved BEFORE repo.rebase(). repo.rebase() is git_rebase_init, not a
    // dry run: it creates .git/rebase-merge/, checks out `onto` and detaches
    // HEAD. This binding sat AFTER it and OUTSIDE the closure whose Err arm
    // aborts — so an unusable identity (no user.name/user.email, an empty
    // email, a name containing angle brackets) left the repo wedged in
    // RebaseMerge on a detached HEAD showing the other branch's content, with
    // every later operation refused as "another operation is in progress" and
    // nothing in the message saying Abort was the way out. pull --rebase in
    // remote.rs already resolves it inside its guarded closure.
    let signature = repo.signature()?;
    let mut rebase = repo.rebase(Some(&head_commit), Some(&onto_commit), None, None)?;

    // git2::Rebase does NOT call abort() on Drop. Without an explicit abort,
    // failures other than the expected RebaseConflict (e.g. missing
    // user.name signature, mid-loop git2 errors) leave the working tree
    // permanently stuck in REBASE state. We do NOT abort on RebaseConflict
    // because the UI surfaces a "resolve conflicts" flow that needs the
    // rebase state intact; the user can call abort_rebase explicitly.
    // post-rewrite reads `<old-sha> <new-sha>` lines, one per replayed commit.
    let mut rewritten: Vec<String> = Vec::new();
    let mut skipped = 0usize;
    let result = (|| -> Result<()> {
        while let Some(op) = rebase.next() {
            let op = op?;
            let old_oid = op.id();

            if repo.index()?.has_conflicts() {
                return Err(GitnadoError::RebaseConflict);
            }

            // A commit whose patch is already present on `onto` becomes empty.
            // Canonical git rebase skips it and continues; libgit2 reports
            // GIT_EAPPLIED from commit(), which used to enter the hard-error
            // path below and abort the entire rebase.
            if let Some(new_oid) =
                commit_or_skip_empty(&repo, &mut rebase, &signature, Some(old_oid))?
            {
                rewritten.push(format!("{} {}", old_oid, new_oid));
            } else {
                skipped += 1;
            }
        }

        ensure_libgit2_rewritten_file(&repo)?;
        rebase.finish(Some(&signature))?;
        Ok(())
    })();

    if result.is_ok() {
        if !rewritten.is_empty() {
            // Same hook the CLI rebase path gets for free — see the pre-rebase
            // note above. Advertised by the Hooks dialog for "rebase, amend".
            crate::commands::hooks::run_hook_noblock_with_stdin(
                &repo,
                "post-rewrite",
                &["rebase"],
                Some(&format!("{}\n", rewritten.join("\n"))),
            );
        }
    } else if matches!(result, Err(GitnadoError::RebaseConflict)) {
        // Paused, not finished. Hand the pairs replayed so far to whichever
        // continue_rebase eventually completes this rebase, so the hook
        // describes the whole thing rather than only the last leg.
        append_rewritten(&repo, &rewritten);
        // Same reasoning for the skip count. This invocation returns
        // RebaseConflict, so the commits it has already dropped never reach the
        // UI; continue_rebase adds its own skips and reports the total.
        append_skipped(&repo, skipped);
    }

    match result {
        Err(GitnadoError::RebaseConflict) => Err(GitnadoError::RebaseConflict),
        Err(e) => {
            let _ = rebase.abort();
            Err(e)
        }
        Ok(()) => Ok(skipped),
    }
}

/// Where the `<old> <new>` pairs of a paused rebase are kept.
///
/// libgit2's rebase state lives in `<gitdir>/rebase-merge/`, which git removes
/// when the rebase finishes or is aborted — so a file there is scoped to
/// exactly one rebase and needs no separate cleanup.
fn rewritten_list_path(repo: &git2::Repository) -> std::path::PathBuf {
    repo.path().join("rebase-merge").join("gitnado-rewritten")
}

/// Append pairs replayed so far, so a conflict pause does not lose them.
///
/// post-rewrite must describe the WHOLE rebase. Both `rebase` and
/// `continue_rebase` accumulated pairs in a local Vec and fired the hook only
/// if that one invocation ran to completion, so every commit replayed before a
/// conflict was dropped: rebase A-B-C where B conflicts reported only B and C.
pub(super) fn append_rewritten(repo: &git2::Repository, pairs: &[String]) {
    if pairs.is_empty() {
        return;
    }
    let path = rewritten_list_path(repo);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{}", pairs.join("\n"));
    }
}

/// Read and clear the pairs persisted by earlier passes of this rebase.
pub(super) fn take_rewritten(repo: &git2::Repository) -> Vec<String> {
    let path = rewritten_list_path(repo);
    let contents = std::fs::read_to_string(&path).unwrap_or_default();
    let _ = std::fs::remove_file(&path);
    contents
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect()
}

/// Where the running skip total of a paused rebase is kept.
///
/// Same `<gitdir>/rebase-merge/` lifecycle as `rewritten_list_path`: git
/// removes the directory when the rebase finishes or is aborted, so the file is
/// scoped to exactly one rebase and needs no separate cleanup.
pub(super) fn skipped_count_path(repo: &git2::Repository) -> std::path::PathBuf {
    repo.path().join("rebase-merge").join("gitnado-skipped")
}

/// Add the skips of one leg to the running total, so a conflict pause does not
/// lose them.
///
/// A commit dropped as already-applied is a local commit that disappears from
/// the branch, and the completion toast is the only place the user can learn
/// that. A rebase that pauses returns RebaseConflict — not a count — so every
/// commit it dropped before the conflict would go unreported unless it is
/// carried across the pause to whichever `continue_rebase` finishes the rebase.
pub(crate) fn append_skipped(repo: &git2::Repository, skipped: usize) {
    if skipped == 0 {
        return;
    }
    let path = skipped_count_path(repo);
    let running = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| s.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let _ = std::fs::write(&path, (running + skipped).to_string());
}

/// Read and clear the skips persisted by earlier passes of this rebase.
pub(super) fn take_skipped(repo: &git2::Repository) -> usize {
    let path = skipped_count_path(repo);
    let total = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| s.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let _ = std::fs::remove_file(&path);
    total
}

/// Continue a paused rebase
///
/// Returns how many commits this rebase dropped because their patch is already
/// present on the target — the skips of every leg, not just this one. Same
/// contract as `rebase`, and for the same reason: those are local commits that
/// disappear from the branch with nothing on stderr to say so. The CLI branch
/// below reports the same count, and for the same reason: the drops there are
/// performed by `continue_rebase_cli` itself, and git names none of them
/// anywhere the user can see.
#[command]
pub async fn continue_rebase(path: String) -> Result<usize> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Interactive rebases are driven by the git CLI (`git rebase -i`, see
    // execute_interactive_rebase) and leave a git-rebase-todo file. Those
    // must be continued by the CLI too — its todo lists can contain
    // exec/squash/fixup operations that libgit2's Rebase loop cannot replay.
    // Rebases started through libgit2 (the `rebase` command) have no todo
    // file and are continued through libgit2 below.
    if repo.path().join("rebase-merge/git-rebase-todo").exists() {
        return continue_rebase_cli(&path);
    }

    let signature = repo.signature()?;
    let mut rebase = repo.open_rebase(None)?;

    // post-rewrite reads `<old-sha> <new-sha>` lines, one per replayed commit,
    // and must describe the WHOLE rebase. rebase() fires it when it completes
    // in one go; a rebase that PAUSED finishes here instead, and this path
    // never fired it at all — so the hook ran or not depending only on whether
    // the user hit a conflict. Seeded from the pairs earlier passes persisted,
    // so commits replayed before each pause are not dropped.
    let mut rewritten: Vec<String> = Vec::new();
    let mut skipped = 0usize;

    // Commit the current (just-resolved) operation; a patch that became
    // empty after resolution is skipped like `git rebase --skip` would.
    // The operation being resolved is the rebase's current one.
    let resumed_old = rebase
        .operation_current()
        .and_then(|i| rebase.nth(i).map(|op| op.id()));
    if let Some(new_oid) = commit_or_skip_empty(&repo, &mut rebase, &signature, resumed_old)? {
        if let Some(old_oid) = resumed_old {
            rewritten.push(format!("{} {}", old_oid, new_oid));
        }
    } else {
        // Resolving the conflict to exactly the target's content leaves an
        // empty patch, so this commit is dropped too — counted like any other.
        skipped += 1;
    }

    // Continue with remaining operations
    while let Some(op) = rebase.next() {
        let old_oid = op?.id();

        if repo.index()?.has_conflicts() {
            // Paused again. Persist this leg so the eventual completion still
            // sees every commit replayed — and every commit dropped — across
            // all of them.
            append_rewritten(&repo, &rewritten);
            append_skipped(&repo, skipped);
            return Err(GitnadoError::RebaseConflict);
        }

        if let Some(new_oid) = commit_or_skip_empty(&repo, &mut rebase, &signature, Some(old_oid))?
        {
            rewritten.push(format!("{} {}", old_oid, new_oid));
        } else {
            skipped += 1;
        }
    }

    // Read BEFORE finish(): it removes the rebase-merge directory the list
    // lives in.
    let mut all_rewritten = take_rewritten(&repo);
    all_rewritten.extend(rewritten);
    let all_skipped = take_skipped(&repo) + skipped;

    ensure_libgit2_rewritten_file(&repo)?;
    rebase.finish(Some(&signature))?;

    if !all_rewritten.is_empty() {
        crate::commands::hooks::run_hook_noblock_with_stdin(
            &repo,
            "post-rewrite",
            &["rebase"],
            Some(&format!("{}\n", all_rewritten.join("\n"))),
        );
    }

    Ok(all_skipped)
}

/// Commit the current rebase operation, treating an empty patch
/// (GIT_EAPPLIED) as a skip rather than a failure.
///
/// Returns the new commit's oid, or None when the patch was skipped — the
/// caller pairs it with the original oid for the post-rewrite hook.
pub(crate) fn commit_or_skip_empty(
    repo: &git2::Repository,
    rebase: &mut git2::Rebase,
    signature: &git2::Signature,
    original_oid: Option<git2::Oid>,
) -> Result<Option<git2::Oid>> {
    match rebase.commit(None, signature, None) {
        Ok(oid) => Ok(Some(oid)),
        Err(e) if e.code() == git2::ErrorCode::Applied => {
            let Some(original_oid) = original_oid else {
                return Ok(None);
            };
            let original = repo.find_commit(original_oid)?;
            let started_empty =
                original.parent_count() == 1 && original.tree_id() == original.parent(0)?.tree_id();
            if !started_empty {
                return Ok(None);
            }

            // Git keeps commits that were intentionally empty before the
            // rebase, while dropping patches that only became empty because
            // their change is already upstream. libgit2 reports GIT_EAPPLIED
            // for both, so recreate the former on the current rebased HEAD.
            let head = repo.head()?.peel_to_commit()?;
            let author = original.author();
            let oid = create_empty_rebase_commit(repo, &head, &author, signature, &original)?;
            append_libgit2_rewritten(repo, original_oid, oid)?;
            Ok(Some(oid))
        }
        Err(e) => Err(e.into()),
    }
}

/// Recreate a commit that was intentionally empty before the rebase.
///
/// `Repository::commit` only accepts UTF-8 and has no encoding argument. Build
/// the ordinary unsigned commit object directly so a legacy-encoded message is
/// preserved byte-for-byte, including its encoding header.
fn create_empty_rebase_commit(
    repo: &git2::Repository,
    head: &git2::Commit<'_>,
    author: &git2::Signature<'_>,
    committer: &git2::Signature<'_>,
    original: &git2::Commit<'_>,
) -> Result<git2::Oid> {
    use std::io::Write;

    fn write_signature(
        output: &mut Vec<u8>,
        label: &str,
        signature: &git2::Signature<'_>,
    ) -> std::io::Result<()> {
        let when = signature.when();
        let offset = when.offset_minutes();
        // Match libgit2's serializer: preserve negative zero, but normalize a
        // missing or malformed raw sign instead of writing NUL/garbage into the
        // new commit header.
        let sign = if offset < 0 || when.sign() == '-' {
            '-'
        } else {
            '+'
        };
        let absolute = offset.abs();
        write!(output, "{} ", label)?;
        output.extend_from_slice(signature.name_bytes());
        output.extend_from_slice(b" <");
        output.extend_from_slice(signature.email_bytes());
        writeln!(
            output,
            "> {} {}{:02}{:02}",
            when.seconds(),
            sign,
            absolute / 60,
            absolute % 60
        )
    }

    let mut content = Vec::new();
    writeln!(content, "tree {}", head.tree_id())?;
    writeln!(content, "parent {}", head.id())?;
    write_signature(&mut content, "author", author)?;
    write_signature(&mut content, "committer", committer)?;
    if let Some(encoding) = original.message_encoding()? {
        writeln!(content, "encoding {}", encoding)?;
    }
    content.push(b'\n');
    content.extend_from_slice(original.message_raw_bytes());

    let oid = repo.odb()?.write(git2::ObjectType::Commit, &content)?;
    repo.reference("HEAD", oid, true, "rebase: preserve empty commit")?;
    Ok(oid)
}

/// libgit2 consumes this map during `rebase.finish()` to copy notes. Normally
/// `Rebase::commit` writes it, but an intentionally empty commit is recreated
/// directly after that call returns GIT_EAPPLIED.
fn append_libgit2_rewritten(
    repo: &git2::Repository,
    old_oid: git2::Oid,
    new_oid: git2::Oid,
) -> Result<()> {
    use std::io::Write;

    let path = repo.path().join("rebase-merge").join("rewritten");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{} {}", old_oid, new_oid)?;
    Ok(())
}

pub(crate) fn ensure_libgit2_rewritten_file(repo: &git2::Repository) -> Result<()> {
    let path = repo.path().join("rebase-merge").join("rewritten");
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    Ok(())
}

/// Does continuing this rebase drop the commit it is stopped on?
///
/// `git rebase --continue` DROPS a pending commit whose patch came back empty
/// — already applied on the target, or resolved to the target's content — and
/// says nothing about it on either stream. It only stops and asks for
/// `git rebase --skip` when a LATER commit comes back empty, so the one it is
/// stopped on right now never appears in git's output at all and has to be
/// read off the rebase state instead. Three conditions, all needed:
///
///  - no `amend` marker: git writes it when it stopped at an `edit` line AFTER
///    applying the commit, and continuing from there drops nothing;
///  - the last command in `done` is one that adds a commit: a `break` (or
///    `exec`) stop also leaves a clean index matching HEAD and drops nothing,
///    while `squash`/`fixup` fold INTO HEAD, so a HEAD-to-index diff does not
///    describe their patch;
///  - no conflicts, and the index holds nothing over HEAD — which is what "the
///    pending patch is empty" means.
fn pending_operation_is_empty(repo: &git2::Repository) -> bool {
    let state_dir = repo.path().join("rebase-merge");
    if state_dir.join("amend").exists() {
        return false;
    }

    let done = std::fs::read_to_string(state_dir.join("done")).unwrap_or_default();
    let adds_a_commit = done
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .and_then(|line| line.split_whitespace().next())
        .is_some_and(|command| matches!(command, "pick" | "p" | "reword" | "r" | "edit" | "e"));
    if !adds_a_commit {
        return false;
    }

    let Ok(index) = repo.index() else {
        return false;
    };
    if index.has_conflicts() {
        return false;
    }
    let Ok(head_tree) = repo
        .head()
        .and_then(|head| head.peel_to_commit())
        .and_then(|commit| commit.tree())
    else {
        return false;
    };
    repo.diff_tree_to_index(Some(&head_tree), Some(&index), None)
        .map(|diff| diff.deltas().len() == 0)
        .unwrap_or(false)
}

/// Continue a CLI-initiated (interactive) rebase via `git rebase --continue`,
/// advancing past patches that became empty with `git rebase --skip`.
///
/// Returns how many commits this leg dropped, plus the ones earlier legs of
/// the same rebase persisted. The count is this function's to report, not
/// git's: the drops are performed here — by the `--skip` loop below, and by
/// the `--continue` that silently drops the commit it was stopped on — and a
/// dropped commit is a local commit that disappears from the branch with
/// nothing on either stream to say so. The running total has to be read before
/// the final `git rebase --continue`, which removes the `rebase-merge`
/// directory it lives in.
fn continue_rebase_cli(path: &str) -> Result<usize> {
    let repo = git2::Repository::open(Path::new(path))?;
    // Skips the earlier legs of this rebase persisted.
    let carried = take_skipped(&repo);
    // The commit this rebase is stopped on, when continuing would drop it.
    let pending = usize::from(pending_operation_is_empty(&repo));
    // Skips made by this leg's own `git rebase --skip` calls.
    let mut skipped = 0usize;
    let mut args: Vec<&str> = vec!["rebase", "--continue"];
    loop {
        let output = create_command("git")
            .current_dir(path)
            // Accept recorded commit messages non-interactively (reword etc.)
            .env("GIT_EDITOR", "true")
            // Force the C locale so our stdout/stderr matching below ("No
            // changes", "nothing to commit", "CONFLICT") works regardless of the
            // user's system language — a localized git would break the
            // empty-patch skip and misclassify conflicts.
            .env("LC_ALL", "C")
            .args(&args)
            .output()
            .map_err(|e| GitnadoError::OperationFailed(e.to_string()))?;

        if output.status.success() {
            // Exit 0 does NOT mean "finished": `git rebase --continue` also
            // exits 0 when it advances to the NEXT `edit` or `break` line. The
            // sibling execute_interactive_rebase already tells the two apart
            // this way; reporting a pause as completion closed the conflict
            // dialog with no message and left the repo mid-rebase on a
            // detached HEAD, where the most obvious remaining button was the
            // one that throws the rebase away.
            let git_dir = repo.path().to_path_buf();
            if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
                // Carry the skips across the pause, exactly as the libgit2 arm
                // does: whichever continue finishes the rebase is the only
                // surface that can report them.
                append_skipped(&repo, carried + pending + skipped);
                return Err(GitnadoError::RebasePaused);
            }
            return Ok(carried + pending + skipped);
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let combined = format!("{stdout}\n{stderr}");

        // Patch became empty after resolution: advance past it the way git
        // itself suggests, then keep going.
        if combined.contains("git rebase --skip")
            && (combined.contains("No changes") || combined.contains("nothing to commit"))
        {
            args = vec!["rebase", "--skip"];
            skipped += 1;
            continue;
        }

        if combined.contains("CONFLICT") || combined.contains("conflict") {
            // A conflict is raised by a LATER commit, so the pending one was
            // dealt with — dropped or committed — before git got there.
            append_skipped(&repo, carried + pending + skipped);
            return Err(GitnadoError::RebaseConflict);
        }
        // A hard failure can leave the same commit pending, and the next
        // Continue reads it off the rebase state again — so counting it here
        // would report it twice. Anything this leg skipped did move past it.
        append_skipped(
            &repo,
            carried + skipped + if skipped > 0 { pending } else { 0 },
        );
        return Err(GitnadoError::OperationFailed(if stderr.trim().is_empty() {
            stdout.to_string()
        } else {
            stderr.to_string()
        }));
    }
}

/// Abort an in-progress rebase
#[command]
pub async fn abort_rebase(path: String) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Same CLI branch continue_rebase has. libgit2 refuses to open an
    // interactive rebase at all — rebase.c returns "interactive rebase is not
    // supported" — so `open_rebase` failed for every rebase started through
    // execute_interactive_rebase. That made Abort impossible from the banner,
    // from the trigger-abort toast action, and from the conflict dialog, which
    // renders no × and suppresses Escape: its only other control is Continue,
    // disabled until every conflict is resolved. A user who opened it on an
    // interactive-rebase conflict and did not want to finish was trapped in a
    // modal with no working exit, and reset is refused mid-rebase too.
    if repo.path().join("rebase-merge/git-rebase-todo").exists() {
        let output = create_command("git")
            .current_dir(&path)
            // As continue_rebase_cli: no editor is reachable from a GUI child
            // process, and the C locale keeps any error matching meaningful.
            .env("GIT_EDITOR", "true")
            .env("LC_ALL", "C")
            .args(["rebase", "--abort"])
            .output()
            .map_err(|e| GitnadoError::OperationFailed(e.to_string()))?;
        if !output.status.success() {
            return Err(GitnadoError::OperationFailed(
                String::from_utf8_lossy(&output.stderr).to_string(),
            ));
        }
        return Ok(());
    }

    let mut rebase = repo.open_rebase(None)?;
    rebase.abort()?;
    Ok(())
}

/// Is `oid` reachable from HEAD (or HEAD itself)?
///
/// The graph is loaded with every branch, so Reword and Amend are offered on
/// commits that live only on OTHER branches. Both route non-HEAD commits to the
/// interactive-rebase dialog as `<oid>^`, and `get_rebase_commits` then walks
/// HEAD while hiding that parent — which for an off-branch commit yields the
/// current branch's own history and never contains the target. The dialog
/// opened with no reword row but an enabled Start Rebase, one click from
/// replaying the current branch onto an unrelated branch's commit.
///
/// A plain rebase onto another branch is legitimate and stays available from
/// the branch list; it is only the reword/amend route that requires the target
/// to be in the history being rewritten, so the check lives here rather than in
/// get_rebase_commits.
#[command]
pub async fn is_ancestor_of_head(path: String, oid: String) -> Result<bool> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let target = repo.revparse_single(&oid)?.peel_to_commit()?.id();
    let head = repo
        .head()?
        .target()
        .ok_or(GitnadoError::InvalidReference)?;
    if head == target {
        return Ok(true);
    }
    Ok(repo.graph_descendant_of(head, target)?)
}

/// Get commits between HEAD and a target ref for interactive rebase
#[command]
pub async fn get_rebase_commits(path: String, onto: String) -> Result<RebasePlan> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Find the onto commit.
    //
    // `find_reference` is an EXACT refname lookup and validates the name, so it
    // rejects any revspec. The graph's Reword and Amend entries route non-HEAD
    // commits here as `<oid>^`, where `^` is illegal in a refname — all three
    // lookups failed and the dialog opened showing "the given reference name
    // '<oid>^' is not valid", an empty plan and a disabled Start Rebase, with
    // no way to proceed. `execute_interactive_rebase` shells out to
    // `git rebase -i <onto>` and has always accepted the revspec; only the
    // listing could not resolve it. revparse_single closes that gap and is what
    // git itself would do.
    let onto_oid = match repo
        .find_reference(&format!("refs/heads/{}", onto))
        .or_else(|_| repo.find_reference(&format!("refs/remotes/{}", onto)))
        .or_else(|_| repo.find_reference(&onto))
    {
        Ok(r) => r
            .peel_to_commit()
            .map_err(|_| GitnadoError::InvalidReference)?
            .id(),
        Err(_) => repo.revparse_single(&onto)?.peel_to_commit()?.id(),
    };

    let head_oid = repo
        .head()?
        .target()
        .ok_or_else(|| GitnadoError::InvalidReference)?;

    let mut revwalk = repo.revwalk()?;
    revwalk.push(head_oid)?;
    revwalk.hide(onto_oid)?;

    let mut commits = Vec::new();
    let mut merge_count: usize = 0;

    for oid in revwalk {
        let oid = oid?;
        let commit = repo.find_commit(oid)?;

        // Canonical `git rebase -i` omits merge commits from its todo, and a
        // `pick` of one fails mid-run with "is a merge but no -m option was
        // given" — after earlier commits have already been replayed, leaving a
        // detached HEAD and a live rebase the user has to find the banner to
        // abort. The plain revwalk also emitted commits from the merged-in
        // side, which the user never touched and did not expect to see.
        if commit.parent_count() > 1 {
            // Counted, not just skipped. Dropping them silently produced a plan
            // that LOOKS linear while the range is not: replaying it flattens
            // the merge topology and rewrites the merged-in side commits. The
            // caller needs to know so it can warn — or refuse.
            merge_count += 1;
            continue;
        }

        commits.push(RebaseCommit {
            oid: oid.to_string(),
            short_id: oid.to_string()[..7].to_string(),
            summary: commit.summary().ok().flatten().unwrap_or("").to_string(),
            body: commit.body().ok().flatten().unwrap_or("").to_string(),
            action: "pick".to_string(),
        });
    }

    // Reverse to get oldest first (git rebase order)
    commits.reverse();

    Ok(RebasePlan {
        commits,
        merge_count,
    })
}

/// Execute an interactive rebase using git CLI
#[command]
pub async fn execute_interactive_rebase(
    path: String,
    onto: String,
    todo: String,
) -> Result<InteractiveRebaseOutcome> {
    // `onto` is forwarded to `git rebase -i` as a bare positional argument, so
    // a ref named `--exec=<command>` would become a flag. cli_safety states the
    // rule and 24 call sites apply it by hand; this was the destructive
    // CLI-invoking command never added to that list.
    crate::utils::reject_flag_like(&onto, "Rebase target")?;

    // A unique name per call, like apply_patch_to_index. The fixed
    // /tmp/gitnado-rebase-todo it replaces meant two rebases running at
    // once would read each other's plan — one repo silently rewritten with the
    // other's drops — and the predictable path in a world-writable directory
    // was a symlink target for anyone on the machine.
    let mut todo_file = tempfile::Builder::new()
        .prefix("gitnado-rebase-todo-")
        .tempfile()?;
    todo_file.write_all(todo.as_bytes())?;
    todo_file.flush()?;

    // Git evaluates GIT_SEQUENCE_EDITOR through a shell and appends the actual
    // todo path as its final argument. A direct copy command avoids the
    // platform-specific script execution and cmd.exe quoting pitfalls.
    let sequence_editor = crate::utils::copy_file_editor_command(todo_file.path());

    // Run git rebase -i with our custom editor
    let output = create_command("git")
        .current_dir(&path)
        .env("GIT_SEQUENCE_EDITOR", sequence_editor)
        // GIT_SEQUENCE_EDITOR only supplies the todo list. A `squash` (or
        // `reword`) line then opens GIT_EDITOR for the combined message, and
        // this is the one rebase in the app whose todo the USER composes, so it
        // is the one that can contain them. Without this, git fell through to
        // core.editor/VISUAL/EDITOR/vi: a terminal editor died instantly on the
        // null stdin Command::output() gives it, and a GUI editor
        // (`code --wait`) blocked forever on a window nobody asked for — either
        // way leaving a paused rebase and a detached HEAD whose only exit was
        // the banner's Abort. `true` accepts the message git already composed,
        // which is exactly what the dialog's preview promises. Its sibling
        // continue_rebase_cli has always set this.
        .env("GIT_EDITOR", "true")
        // Same reason as continue_rebase_cli: the conflict classification below
        // matches English stderr, so a localized git would report a conflict as
        // a generic failure and skip the conflict-resolution route entirely.
        .env("LC_ALL", "C")
        .args(["rebase", "-i", &onto])
        .output()
        .map_err(|e| GitnadoError::OperationFailed(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("CONFLICT") || stderr.contains("conflict") {
            return Err(GitnadoError::RebaseConflict);
        }
        return Err(GitnadoError::OperationFailed(stderr.to_string()));
    }

    // Exit 0 does NOT mean "finished": `git rebase -i` also exits 0 when it
    // stops at an `edit` or `break` line. Reporting that as success closed the
    // dialog with no message and left the repo mid-rebase on a detached HEAD,
    // where the only visible affordance was an Abort button that would throw
    // the rebase away. The rebase directory is still on disk while it is
    // paused, so use that to tell the two apart.
    // Resolve via repo.path() so per-worktree rebase state is found in linked
    // worktrees: there `<wt>/.git` is a gitdir-POINTER FILE and the rebase
    // state lives under `<main>/.git/worktrees/<name>/`, so joining ".git/..."
    // onto the working-tree root can never match and `paused` was always false.
    let git_dir = git2::Repository::open(Path::new(&path))?
        .path()
        .to_path_buf();
    let paused = git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists();

    Ok(InteractiveRebaseOutcome { paused })
}
