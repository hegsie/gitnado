//! Fetch and pull command handlers and upstream resolution helpers

use std::path::Path;
use tauri::{command, AppHandle, Emitter, State};

use super::{
    await_remote_task, ensure_pullable, fetch_late_event, guard_remote_op, late_failure,
    network_deadline, network_timeout, operation_monitor, transfer_failure,
};
use crate::error::{GitnadoError, Result};
use crate::models::{FetchAllResult, RemoteFetchResult, RemoteFetchStatus, RemoteOperationResult};
use crate::services::cancellation::CancellationRegistry;
use crate::services::credentials_service;
use crate::services::remote_ops::{self, RemoteOp, RemoteOpRegistry};
use crate::services::transfer_monitor::TransferMonitor;

/// Fetch from remote
#[allow(clippy::too_many_arguments)]
#[command]
pub async fn fetch(
    app_handle: AppHandle,
    remote_ops_registry: State<'_, RemoteOpRegistry>,
    cancellation_registry: State<'_, CancellationRegistry>,
    path: String,
    remote: Option<String>,
    prune: Option<bool>,
    token: Option<String>,
    timeout_secs: Option<u64>,
    quiet: Option<bool>,
    operation_id: Option<String>,
) -> Result<()> {
    // A fetch the user did not ask for must not announce itself. The
    // window-focus refresh runs this same command, and the success event below
    // is toasted by setupRemoteOperationListeners — so with fetch-on-focus
    // enabled, "Fetched from origin" appeared every single time the user
    // alt-tabbed back into the app. That is exactly the noise the background
    // fetch is documented to avoid.
    let quiet = quiet.unwrap_or(false);
    guard_remote_op(&path, false, |repo| {
        Some(resolve_fetch_remote(repo, remote.clone()))
    })?;
    // Claimed BEFORE the timeout wrapper, and handed to the blocking task
    // below so it outlives a timed-out caller — see services/remote_ops.rs.
    //
    // A background fetch (window focus) YIELDS but never claims: it skips this
    // round when the user has something running, and takes no slot of its own,
    // so it can never refuse the user's next push. Its timer twin in
    // services/autofetch_service.rs has always run alongside whatever the user
    // is doing; making this one exclusive would break a working flow rather
    // than fix the racing retry this guard is for.
    let slot = if quiet {
        if remote_ops_registry.running(Path::new(&path)).is_some() {
            return Ok(());
        }
        None
    } else {
        Some(remote_ops_registry.acquire(Path::new(&path), RemoteOp::Fetch)?)
    };

    let repo = git2::Repository::open(Path::new(&path))?;
    let remote_name_owned = resolve_fetch_remote(&repo, remote);
    repo.find_remote(&remote_name_owned)
        .map_err(|_| GitnadoError::RemoteNotFound(remote_name_owned.clone()))?;
    drop(repo);

    let repo_path = path.clone();
    let deadline = network_deadline(timeout_secs);
    let path_clone = path.clone();
    let prune_val = prune.unwrap_or(false);
    let remote_name_for_event = remote_name_owned.clone();

    // Registered so `cancel_operation` can actually find this fetch. The guard
    // rides into the blocking task below and deregisters the id when the fetch
    // really ends — on success, on an error, and on the late completion of a
    // fetch whose caller already timed out.
    let op_guard = cancellation_registry.guard(operation_id.clone());
    let monitor = operation_monitor(
        &app_handle,
        operation_id,
        format!("Fetching from {}", remote_name_owned),
        op_guard.token(),
    );

    // git2 fetch is blocking network I/O; offload to a blocking thread so
    // it doesn't starve the Tokio runtime. spawn_holding carries the slot into
    // that thread, so the claim is released when the fetch really ends rather
    // than when a timed-out caller drops this future.
    let handle = remote_ops::spawn_holding(slot, move || -> Result<()> {
        // Dropped when this closure returns, however it returns.
        let _op_guard = op_guard;
        fetch_internal(
            &path_clone,
            &remote_name_owned,
            prune_val,
            token,
            deadline,
            monitor,
        )
    });

    let app_late = app_handle.clone();
    let remote_late = remote_name_for_event.clone();
    let repo_late = repo_path.clone();
    await_remote_task(
        network_timeout(timeout_secs),
        "Fetch",
        handle,
        move |late| {
            // A background fetch stays silent, but one the user asked for that
            // lands after its timeout error must say so: the caller already
            // returned an error and will never refresh.
            if let Some(event) = fetch_late_event(quiet, late, remote_late, repo_late) {
                let _ = app_late.emit("remote-operation-completed", event);
            }
        },
    )
    .await?;

    // Emit success event, unless this fetch is a background one.
    if !quiet {
        let _ = app_handle.emit(
            "remote-operation-completed",
            RemoteOperationResult {
                operation: "fetch".to_string(),
                remote: remote_name_for_event,
                repo_path,
                success: true,
                message: "Fetch completed successfully".to_string(),
                error_code: None,
                late: false,
            },
        );
    }

    Ok(())
}

pub(crate) fn resolve_fetch_remote(repo: &git2::Repository, requested: Option<String>) -> String {
    if let Some(remote) = requested {
        return remote;
    }
    let from_upstream = repo
        .head()
        .ok()
        .filter(|head| head.is_branch())
        .and_then(|head| head.name().ok().map(str::to_owned))
        .and_then(|refname| repo.branch_upstream_remote(&refname).ok())
        .and_then(|name| name.as_str().ok().map(str::to_owned))
        .filter(|name| name != "." && repo.find_remote(name).is_ok());
    if let Some(remote) = from_upstream {
        return remote;
    }
    match repo.remotes() {
        Ok(names) if names.len() == 1 => {
            names.get(0).ok().flatten().unwrap_or("origin").to_string()
        }
        _ => "origin".to_string(),
    }
}

#[tauri::command]
pub async fn get_fetch_remote(path: String, remote: Option<String>) -> Result<String> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let remote_name = resolve_fetch_remote(&repo, remote);
    repo.find_remote(&remote_name)
        .map_err(|_| GitnadoError::RemoteNotFound(remote_name.clone()))?;
    Ok(remote_name)
}

/// Fast-forward `refname` to `target_oid`, checking out the target tree first.
///
/// The checkout is SAFE (git2's default), not forced, and the ref only moves
/// once it succeeded — exactly what `merge()`'s fast-forward path does. This
/// used to `checkout_head` with `.force()` AFTER moving the ref:
/// `GIT_CHECKOUT_FORCE` overwrites modified files, so a pull onto a branch
/// with an uncommitted edit to a file the incoming commits touch silently
/// destroyed that edit — content that is in no git object and has no reflog to
/// recover it. git itself refuses such a fast-forward.
pub(super) fn fast_forward_to(
    repo: &git2::Repository,
    refname: &str,
    target_oid: git2::Oid,
) -> Result<()> {
    let target_commit = repo.find_commit(target_oid)?;
    // Resolved before the checkout: a refname that does not exist must abort
    // while the working tree is still untouched, not after it has been
    // rewritten to content HEAD does not point at.
    repo.find_reference(refname)?;

    // Collect the conflicting paths so the error can name them, like git's own
    // "Your local changes to the following files ..." message.
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
                 Commit or stash them before you pull."
                    .to_string()
            } else {
                format!(
                    "Your local changes to the following files would be overwritten by \
                     merge: {}. Commit or stash them before you pull.",
                    files
                )
            }));
        }
        Err(e) => return Err(e.into()),
    }

    let mut reference = repo.find_reference(refname)?;
    reference.set_target(target_oid, "Fast-forward")?;
    repo.set_head(refname)?;

    // git runs post-merge after a fast-forward too (flag 0 = not a squash
    // merge). merge() fires it; this path did not.
    crate::commands::hooks::run_hook_noblock(repo, "post-merge", &["0"]);
    Ok(())
}

/// Whether `git pull` should rebase, mirroring git's own precedence.
///
/// `branch.<name>.rebase` overrides `pull.rebase`. Both accept more than a
/// boolean: `interactive`, `merges` and `preserve` all mean "rebase", and git
/// treats an unrecognised value as unset rather than an error, so an unusable
/// value falls through to the next level instead of failing the pull.
pub(super) fn pull_should_rebase(repo: &git2::Repository, branch_name: &str) -> bool {
    fn interpret(raw: &str) -> Option<bool> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "on" | "1" | "interactive" | "merges" | "preserve" => Some(true),
            "false" | "no" | "off" | "0" => Some(false),
            _ => None,
        }
    }

    let Ok(config) = repo.config() else {
        return false;
    };

    if let Ok(raw) = config.get_string(&format!("branch.{}.rebase", branch_name)) {
        if let Some(value) = interpret(&raw) {
            return value;
        }
    }

    config
        .get_string("pull.rebase")
        .ok()
        .and_then(|raw| interpret(&raw))
        .unwrap_or(false)
}

/// The branch a pull will merge into, and its full refname.
///
/// On a detached HEAD, shorthand() is the literal "HEAD" — so this used to
/// resolve origin/HEAD (a symref that DOES exist in a normal clone),
/// fast-forward-check-out its tree, and only then fail looking up
/// "refs/heads/HEAD". The tree ended up holding origin/main's content while
/// HEAD still pointed at the tag, so every diverging file showed as an
/// uncommitted change. git refuses to pull with no upstream; so do we. merge()
/// gets this right by using head.name() rather than rebuilding it.
///
/// Shared with `get_pull_remote` so the remote the frontend's network gate is
/// evaluated against comes from exactly the ref the pull itself will use.
pub(crate) fn resolve_pull_branch(
    repo: &git2::Repository,
    branch_for_task: Option<&str>,
) -> Result<(String, String)> {
    if let Some(b) = branch_for_task {
        return Ok((b.to_string(), format!("refs/heads/{}", b)));
    }
    let head = repo.head()?;
    if !head.is_branch() {
        return Err(GitnadoError::OperationFailed(
            "You are not currently on a branch. Check out a branch before \
             pulling, or say which branch to pull."
                .to_string(),
        ));
    }
    let refname = head
        .name()
        .map_err(|_| GitnadoError::InvalidReference)?
        .to_string();
    Ok((head.shorthand().unwrap_or("main").to_string(), refname))
}

/// Which remote a pull will contact when the caller named none.
///
/// The remote half of `resolve_pull_target`, split out so `get_pull_remote` can
/// answer the same question WITHOUT touching the network. The frontend's
/// offline/allowlist gate and its credential scoping both need the remote a
/// pull will actually reach: assuming "origin" evaluated the allowlist against
/// the wrong host and offered origin's token to an unrelated one.
pub(crate) fn resolve_pull_remote(
    repo: &git2::Repository,
    requested_remote: Option<String>,
    head_refname: &str,
) -> String {
    match requested_remote {
        Some(r) => r,
        None => repo
            .branch_upstream_remote(head_refname)
            .ok()
            .and_then(|b| b.as_str().ok().map(|s| s.to_string()))
            .unwrap_or_else(|| "origin".to_string()),
    }
}

/// The remote a pull would contact, without performing it.
#[tauri::command]
pub async fn get_pull_remote(
    path: String,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<String> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let (_, head_refname) = resolve_pull_branch(&repo, branch.as_deref())?;
    let remote_name = resolve_pull_remote(&repo, remote, &head_refname);
    repo.find_remote(&remote_name)
        .map_err(|_| GitnadoError::RemoteNotFound(remote_name.clone()))?;
    Ok(remote_name)
}

/// Which remote to fetch, and which remote-tracking ref to merge, for a pull.
///
/// Asks git rather than rebuilding "<remote>/<shorthand>". The rebuilt form was
/// wrong twice over: it hard-coded "origin", so `git clone -o upstream`, a
/// Gerrit checkout, or a remote the app's own Remote dialog renamed all failed
/// with "Remote not found: origin" and no way to pick another; and in the
/// standard fork workflow (origin = your fork, upstream = canonical, main
/// tracking upstream/main) it merged the FORK's branch while the sidebar showed
/// the branch tracking upstream/main.
pub(crate) fn resolve_pull_target(
    repo: &git2::Repository,
    requested_remote: Option<String>,
    branch_name: &str,
    head_refname: &str,
) -> (String, String) {
    let upstream_ref = repo
        .find_branch(branch_name, git2::BranchType::Local)
        .ok()
        .and_then(|b| b.upstream().ok())
        .and_then(|u| u.get().name().ok().map(|n| n.to_string()));

    let remote = resolve_pull_remote(repo, requested_remote, head_refname);

    let remote_ref = upstream_ref
        .as_deref()
        .and_then(|r| r.strip_prefix("refs/remotes/"))
        .map(|r| r.to_string())
        .unwrap_or_else(|| format!("{}/{}", remote, branch_name));

    (remote, remote_ref)
}

/// The merge-and-commit body of a non-fast-forward `pull`.
///
/// Extracted from `pull` so it can be TESTED. `pull` takes a Tauri
/// `AppHandle`, so it cannot be driven from a unit test at all; two real bugs
/// have already shipped in this arm — a `cleanup_state()` that destroyed a
/// resumable merge, and missing `pre-merge-commit` / `commit-msg` hooks — and
/// the only guard was an `include_str!` grep over this file, which can see
/// that a hook is NAMED but not that it runs, in what order, or what it leaves
/// on disk when it vetoes. This takes a plain `&Repository`, so all of that is
/// assertable.
///
/// The contract, matching `merge()`:
/// - `pre-merge-commit` and `commit-msg` run BEFORE the commit and OUTSIDE any
///   cleanup, so a veto returns with `MERGE_HEAD` intact and the merge still
///   resumable (and abortable).
/// - Conflicts return `MergeConflict` with the merge state left in place for
///   the conflict-resolution flow.
/// - No `cleanup_state()` on failure. On success: cleanup, then `post-merge`.
pub(crate) fn merge_fetched_commit(
    repo: &git2::Repository,
    fetch_commit: &git2::AnnotatedCommit<'_>,
    remote_ref: &str,
    branch_name: &str,
) -> Result<()> {
    // Anything that fails AFTER repo.merge() succeeds must leave the state
    // coherent, otherwise the working copy is stuck in MERGING.
    repo.merge(&[fetch_commit], None, None)?;

    // Hoisted ABOVE the guarded closure, like merge(). A veto must return with
    // MERGE_HEAD intact so the merge stays resumable — which is only true out
    // here.
    crate::commands::hooks::run_hook_blocking(repo, "pre-merge-commit", &[], None)?;
    let default_message = format!("Merge {} into {}", remote_ref, branch_name);
    let commit_message = crate::commands::hooks::run_commit_msg_hook(repo, &default_message)?;

    let merge_commit_result = (|| -> Result<()> {
        if repo.index()?.has_conflicts() {
            return Err(GitnadoError::MergeConflict);
        }
        // The same two hooks merge() runs. `git pull` is fetch + merge, and
        // githooks(5) has git merge fire pre-merge-commit and commit-msg — so
        // whether a repo's merge policy (a Gerrit Change-Id hook, a
        // Conventional-Commits linter) was enforced depended only on which of
        // two buttons the user pressed. A veto returns before the commit with
        // MERGE_HEAD intact, so the merge stays resumable, which is the
        // contract merge() already documents. post-merge is already fired
        // below for this same parity reason.
        let signature = repo.signature()?;
        let head = repo.head()?.peel_to_commit()?;
        let remote_commit = repo.find_commit(fetch_commit.id())?;
        let tree_oid = repo.index()?.write_tree()?;
        let tree = repo.find_tree(tree_oid)?;
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            &commit_message,
            &tree,
            &[&head, &remote_commit],
        )?;
        Ok(())
    })();

    // MergeConflict is the expected "user must resolve" path; the UI drives a
    // conflict-resolution flow that needs MERGE_HEAD intact.
    // NO cleanup_state on failure — the same trap removed from merge(). It
    // only unlinks MERGE_HEAD/MERGE_MSG while repo.merge() has already written
    // the merged result into the index and working tree, so it leaves the
    // merge fully applied but unmarked: banner gone, abort_merge refusing, the
    // whole diff staged under a failure toast. The pre-merge-commit and
    // commit-msg hooks above made a veto the ROUTINE way in.
    merge_commit_result?;

    repo.cleanup_state()?;
    // git runs post-merge after a merge commit (flag 0 = not a squash). The
    // fast-forward arm of pull fires it; this one did not, so whether a repo's
    // hooks ran depended only on whether the history happened to diverge.
    crate::commands::hooks::run_hook_noblock(repo, "post-merge", &["0"]);
    Ok(())
}

/// Run one pull: fetch, then merge or rebase the fetched commit.
///
/// Extracted from `pull` so it can be TESTED — the same reason `push_branch`
/// was: `pull` takes a Tauri `AppHandle`, so this whole body was unreachable
/// from a unit test.
///
/// Returns the remote actually pulled from and a user-facing message.
#[allow(clippy::too_many_arguments)]
pub(crate) fn pull_branch(
    path_for_task: &str,
    requested_remote: Option<String>,
    branch_for_task: Option<String>,
    rebase: Option<bool>,
    token: Option<String>,
    deadline: Option<std::time::Instant>,
    monitor: TransferMonitor,
) -> Result<(String, String)> {
    // Refuse before the network round trip if another operation is
    // unresolved. merge() has always had this guard; pull never
    // did, and its normal-merge branch calls repo.merge() a SECOND
    // time on top of the first. libgit2 errors out — but as a side
    // effect it deletes MERGE_HEAD and flips state() back to Clean
    // while the index still holds the conflicted entries. abort_merge
    // then refuses ("no merge to abort"), so the app's only recovery
    // action for a stuck merge is gone and the conflicted index still
    // blocks a commit. The keyboard shortcut fires through an open
    // conflict dialog, so this is one keystroke away.
    ensure_pullable(Path::new(path_for_task))?;

    let repo = git2::Repository::open(Path::new(path_for_task))?;

    let (branch_name, head_refname) = resolve_pull_branch(&repo, branch_for_task.as_deref())?;

    // Honour the repository's own pull strategy when the caller
    // did not force one. Defaulting to merge meant a user with
    // pull.rebase=true — a very common setting — silently got a
    // merge commit from every diverged pull, the opposite of what
    // `git pull` does in their terminal.
    let rebase_val = match rebase {
        Some(explicit) => explicit,
        None => pull_should_rebase(&repo, &branch_name),
    };

    let (effective_remote, remote_ref) =
        resolve_pull_target(&repo, requested_remote.clone(), &branch_name, &head_refname);

    // Fetch (network I/O) the remote we actually resolved. A transfer the
    // deadline aborted is this pull's timeout, and must read as one.
    //
    // THE FETCH IS THE ONLY CANCELLATION POINT OF A PULL. Everything after it
    // — the fast-forward checkout, the merge, the rebase loop — rewrites the
    // index and the working tree, and there is no point inside those at which
    // stopping leaves a state a user could reason about (a half-applied
    // rebase, a merged-but-unmarked tree). Cancelling during the fetch is
    // safe because a fetch writes nothing but remote-tracking refs and
    // FETCH_HEAD, which is exactly what a plain `Fetch` does and leaves the
    // working tree untouched. So: cancel here, or let the merge finish.
    fetch_internal(
        path_for_task,
        &effective_remote,
        false,
        token,
        deadline,
        monitor.with_message(format!("Pulling from {}", effective_remote)),
    )
    .map_err(|e| match e {
        GitnadoError::OperationTimeout(_) => {
            GitnadoError::OperationTimeout("Pull operation timed out".to_string())
        }
        other => other,
    })?;
    let repo = git2::Repository::open(Path::new(path_for_task))?;

    // The last moment a pull can be stopped (see the comment above the fetch).
    // Reported as a plain cancellation, not a "cancelled after change": the
    // repository is in exactly the state a fetch would have left it in.
    if monitor.is_cancelled() {
        return Err(GitnadoError::OperationCancelled);
    }

    // Do NOT start the merge or rebase once the caller has already been told
    // the pull timed out. The outer timeout only drops the future, so this
    // thread would otherwise rewrite refs and the working tree minutes later,
    // with the user looking at a "Pull operation timed out" error and the
    // retry hitting ensure_pullable's "another operation is in progress".
    //
    // Reported as OperationTimeoutAfterChange, NOT OperationTimeout: the fetch
    // above already wrote the remote-tracking refs and FETCH_HEAD, so this
    // repository DID change. await_remote_task suppresses a plain
    // OperationTimeout as an outcome the caller was already told about, which
    // would leave those writes with no late event and no refresh anywhere.
    if crate::utils::deadline_passed(deadline) {
        return Err(GitnadoError::OperationTimeoutAfterChange(
            "Pull operation timed out".to_string(),
        ));
    }

    let fetch_head = repo.find_reference(&format!("refs/remotes/{}", remote_ref))?;
    let fetch_commit = repo.reference_to_annotated_commit(&fetch_head)?;

    let message: String;

    if rebase_val {
        let head = repo.head()?;
        let head_commit = repo.reference_to_annotated_commit(&head)?;

        let mut rebase_obj = repo.rebase(Some(&head_commit), Some(&fetch_commit), None, None)?;

        // `git2::Rebase` does NOT call abort() on Drop. Without
        // an explicit abort, errors other than the expected
        // RebaseConflict (e.g. missing user.name signature,
        // mid-loop git2 errors) would leave the working tree
        // permanently stuck in REBASE state. We do NOT abort on
        // RebaseConflict because the UI surfaces a "resolve
        // conflicts" flow that needs the rebase state intact.
        let mut commit_count = 0;
        let mut skipped_count = 0usize;
        let rebase_result = (|| -> Result<()> {
            while let Some(op) = rebase_obj.next() {
                let op = op?;
                if repo.index()?.has_conflicts() {
                    return Err(GitnadoError::RebaseConflict);
                }
                let signature = repo.signature()?;
                if crate::commands::merge::commit_or_skip_empty(
                    &repo,
                    &mut rebase_obj,
                    &signature,
                    Some(op.id()),
                )?
                .is_some()
                {
                    commit_count += 1;
                } else {
                    skipped_count += 1;
                }
            }
            crate::commands::merge::ensure_libgit2_rewritten_file(&repo)?;
            rebase_obj.finish(Some(&repo.signature()?))?;
            Ok(())
        })();
        match rebase_result {
            Err(GitnadoError::RebaseConflict) => {
                // Paused, not finished: this call reports a conflict, never a
                // count, so the commits already dropped here would go
                // unreported. Hand them to the continue_rebase that finishes
                // this rebase, which adds its own and reports the total.
                crate::commands::merge::append_skipped(&repo, skipped_count);
                return Err(GitnadoError::RebaseConflict);
            }
            Err(e) => {
                let _ = rebase_obj.abort();
                return Err(e);
            }
            Ok(()) => {}
        }
        // A skipped commit is a local commit that silently disappears from the
        // branch, so say so. `git rebase` prints "warning: skipped previously
        // applied commit ..." on stderr; there is no stderr here, and without
        // this the flagship case this fix unblocks (every local commit already
        // upstream) reports the bare "Rebased 0 commit(s)" while the branch
        // moves and the user's commits are gone.
        message = if skipped_count > 0 {
            format!(
                "Rebased {} commit(s), skipped {} already applied upstream",
                commit_count, skipped_count
            )
        } else {
            format!("Rebased {} commit(s)", commit_count)
        };
    } else {
        let (analysis, _preference) = repo.merge_analysis(&[&fetch_commit])?;

        if analysis.is_up_to_date() {
            message = "Already up to date".to_string();
        } else if analysis.is_fast_forward() {
            fast_forward_to(&repo, &head_refname, fetch_commit.id())?;
            message = "Fast-forward merge completed".to_string();
        } else {
            // Normal merge. Body extracted to merge_fetched_commit
            // so it can be tested — see the doc comment there.
            merge_fetched_commit(&repo, &fetch_commit, &remote_ref, &branch_name)?;
            message = "Merge completed".to_string();
        }
    }

    Ok((effective_remote, message))
}

/// Pull from remote
#[allow(clippy::too_many_arguments)]
#[command]
pub async fn pull(
    app_handle: AppHandle,
    remote_ops_registry: State<'_, RemoteOpRegistry>,
    cancellation_registry: State<'_, CancellationRegistry>,
    path: String,
    remote: Option<String>,
    branch: Option<String>,
    rebase: Option<bool>,
    token: Option<String>,
    timeout_secs: Option<u64>,
    operation_id: Option<String>,
) -> Result<()> {
    guard_remote_op(&path, false, |repo| {
        let (_, head_refname) = resolve_pull_branch(repo, branch.as_deref()).ok()?;
        Some(resolve_pull_remote(repo, remote.clone(), &head_refname))
    })?;
    // Claimed before the timeout wrapper and released by the blocking task,
    // not by this future — see services/remote_ops.rs. The ensure_pullable
    // guard inside pull_branch only refuses a repository that is ALREADY
    // mid-merge, so it cannot see a pull that timed out and is still running.
    let slot = remote_ops_registry.acquire(Path::new(&path), RemoteOp::Pull)?;

    let repo_path = path.clone();
    let deadline = network_deadline(timeout_secs);
    let path_for_task = path.clone();
    // NOT defaulted to "origin" here. The branch's configured upstream is
    // the right answer when the caller did not name a remote.
    let requested_remote = remote.clone();
    let branch_for_task = branch.clone();

    // Registered so `cancel_operation` can find this pull; the guard rides
    // into the blocking task and deregisters when the pull really ends.
    let op_guard = cancellation_registry.guard(operation_id.clone());
    let monitor = operation_monitor(
        &app_handle,
        operation_id,
        "Pulling from remote",
        op_guard.token(),
    );

    // Whole pull is git2 / blocking network I/O. Run it on a blocking
    // thread so the Tokio runtime stays responsive; the slot rides into that
    // thread so it is released when the pull really ends.
    let handle = remote_ops::spawn_holding(Some(slot), move || {
        let _op_guard = op_guard;
        pull_branch(
            &path_for_task,
            requested_remote,
            branch_for_task,
            rebase,
            token,
            deadline,
            monitor,
        )
    });

    let app_late = app_handle.clone();
    let repo_late = repo_path.clone();
    let (remote_name_returned, message) =
        await_remote_task(network_timeout(timeout_secs), "Pull", handle, move |late| {
            // The merge or rebase landed after the caller was told the pull
            // timed out: refs and the working tree changed with nothing on the
            // frontend waiting to refresh. Announce the real outcome.
            let (remote, success, message, error_code) = match late {
                Ok((remote, message)) => (
                    remote,
                    true,
                    format!(
                        "Pull finished after it was reported as timed out: {}",
                        message
                    ),
                    None,
                ),
                // With the code, not just the text: a late pull that ends in
                // MergeConflict/RebaseConflict leaves MERGE_HEAD (or the rebase
                // state) on disk, and the frontend needs the code to open the
                // conflict dialog for it — the same thing the normal pull path
                // does with the command's own error.
                Err(e) => {
                    let (message, code) =
                        late_failure("Pull failed after it was reported as timed out", e);
                    ("unknown".to_string(), false, message, code)
                }
            };
            let _ = app_late.emit(
                "remote-operation-completed",
                RemoteOperationResult {
                    operation: "pull".to_string(),
                    remote,
                    repo_path: repo_late,
                    success,
                    message,
                    error_code,
                    late: true,
                },
            );
        })
        .await?;

    // Emit success event
    let _ = app_handle.emit(
        "remote-operation-completed",
        RemoteOperationResult {
            operation: "pull".to_string(),
            remote: remote_name_returned,
            repo_path,
            success: true,
            message,
            error_code: None,
            late: false,
        },
    );

    Ok(())
}

/// Internal fetch without event emission (used by `fetch` and by pull).
///
/// `monitor` carries the user's cancellation token and the progress sink;
/// pass `TransferMonitor::disabled()` for a fetch that is neither cancellable
/// nor reported (the background fetch, an internal one).
pub(crate) fn fetch_internal(
    path: &str,
    remote_name: &str,
    prune: bool,
    token: Option<String>,
    deadline: Option<std::time::Instant>,
    monitor: TransferMonitor,
) -> Result<()> {
    // Checked before anything opens a socket: a cancel that arrived while the
    // operation was still queued must not produce a network round trip at all.
    // The in-transfer check lives in the git2 callback, which is the only
    // abort point libgit2 offers.
    if monitor.is_cancelled() {
        return Err(GitnadoError::OperationCancelled);
    }

    let repo = git2::Repository::open(Path::new(path))?;

    let mut git_remote = repo
        .find_remote(remote_name)
        .map_err(|_| GitnadoError::RemoteNotFound(remote_name.to_string()))?;

    let (mut fetch_opts, abort) = credentials_service::get_fetch_options_with_monitor(
        token, deadline,
        // The message is the CALLER's: a pull's fetch phase must keep saying
        // "Pulling from origin" rather than relabelling the row half-way
        // through an operation the user asked for by another name.
        monitor,
    );

    if prune {
        fetch_opts.prune(git2::FetchPrune::On);
    }

    let refspecs: Vec<String> = git_remote
        .fetch_refspecs()?
        .iter()
        .filter_map(|s| s.ok().flatten().map(|s| s.to_string()))
        .collect();

    let refspec_strs: Vec<&str> = refspecs.iter().map(|s| s.as_str()).collect();

    git_remote
        .fetch(&refspec_strs, Some(&mut fetch_opts), None)
        // libgit2 reports both a cancelled and a deadline-aborted transfer as
        // a generic indexer error; name each for what it is — but only when
        // the callback really aborted this transfer. Asking the condition here
        // instead relabelled every failure that happened to surface after the
        // deadline (a wrong credential, a protocol error, a full disk) as
        // "timed out", and on the pull path such an error is then dropped as
        // an already-reported timeout, so the real cause never reached the
        // user.
        .map_err(|e| transfer_failure(&abort, e, "Fetch operation timed out"))?;

    Ok(())
}

/// Fetch from all remotes
#[command]
pub async fn fetch_all_remotes(
    app_handle: AppHandle,
    path: String,
    prune: bool,
    tags: bool,
    token: Option<String>,
) -> Result<FetchAllResult> {
    {
        let repo = git2::Repository::open(Path::new(&path))?;
        for remote_name in repo.remotes()?.iter().filter_map(|s| s.ok().flatten()) {
            crate::services::security::guard_remote(&path, Some(remote_name))?;
        }
    }

    // Multiple sequential blocking fetches; run on a blocking thread to keep
    // the Tokio runtime responsive.
    let path_for_task = path.clone();
    let token_for_task = token.clone();

    let (results, total_fetched, total_failed) =
        tokio::task::spawn_blocking(move || -> Result<(Vec<RemoteFetchResult>, u32, u32)> {
            let repo = git2::Repository::open(Path::new(&path_for_task))?;
            let remote_names = repo.remotes()?;

            let mut results: Vec<RemoteFetchResult> = Vec::new();
            let mut total_fetched: u32 = 0;
            let mut total_failed: u32 = 0;

            for remote_name in remote_names.iter().filter_map(|s| s.ok().flatten()) {
                let fetch_result = fetch_single_remote(
                    &path_for_task,
                    remote_name,
                    prune,
                    tags,
                    token_for_task.clone(),
                );

                match fetch_result {
                    Ok(refs_updated) => {
                        results.push(RemoteFetchResult {
                            remote: remote_name.to_string(),
                            success: true,
                            message: Some(format!("Fetched {} refs", refs_updated)),
                            refs_updated,
                        });
                        total_fetched += 1;
                    }
                    Err(e) => {
                        results.push(RemoteFetchResult {
                            remote: remote_name.to_string(),
                            success: false,
                            message: Some(e.to_string()),
                            refs_updated: 0,
                        });
                        total_failed += 1;
                    }
                }
            }

            Ok((results, total_fetched, total_failed))
        })
        .await
        .map_err(|e| GitnadoError::Custom(format!("Fetch task failed: {}", e)))??;

    let overall_success = total_failed == 0;

    // Emit event for the operation
    let _ = app_handle.emit(
        "remote-operation-completed",
        RemoteOperationResult {
            operation: "fetch_all".to_string(),
            remote: "all".to_string(),
            repo_path: path.clone(),
            success: overall_success,
            message: format!(
                "Fetched from {} remotes ({} failed)",
                total_fetched, total_failed
            ),
            error_code: None,
            late: false,
        },
    );

    Ok(FetchAllResult {
        remotes: results,
        success: overall_success,
        total_fetched,
        total_failed,
    })
}

/// Internal function to fetch from a single remote with tag support
pub(super) fn fetch_single_remote(
    path: &str,
    remote_name: &str,
    prune: bool,
    tags: bool,
    token: Option<String>,
) -> Result<u32> {
    let repo = git2::Repository::open(Path::new(path))?;

    let mut git_remote = repo
        .find_remote(remote_name)
        .map_err(|_| GitnadoError::RemoteNotFound(remote_name.to_string()))?;

    // Collect refspecs
    let mut refspecs: Vec<String> = git_remote
        .fetch_refspecs()?
        .iter()
        .filter_map(|s| s.ok().flatten().map(|s| s.to_string()))
        .collect();

    // Add tag refspec if requested
    if tags {
        refspecs.push("refs/tags/*:refs/tags/*".to_string());
    }

    let refspec_strs: Vec<&str> = refspecs.iter().map(|s| s.as_str()).collect();

    // Track refs updated using a callback
    let refs_updated = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let refs_counter = refs_updated.clone();

    // Build callbacks that carry BOTH the credentials (token) AND our
    // update_tips counter. Previously this code rebuilt options with `None`
    // for the token, silently dropping the caller's auth and breaking fetch
    // on private remotes.
    let mut callbacks = credentials_service::get_callbacks_with_progress(token);
    callbacks.update_tips(move |_refname, _old, _new| {
        refs_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        true
    });

    let mut fetch_opts = git2::FetchOptions::new();
    if prune {
        fetch_opts.prune(git2::FetchPrune::On);
    }
    fetch_opts.remote_callbacks(callbacks);

    git_remote.fetch(&refspec_strs, Some(&mut fetch_opts), None)?;

    Ok(refs_updated.load(std::sync::atomic::Ordering::Relaxed))
}

/// Get fetch status for all remotes
#[command]
pub async fn get_fetch_status(path: String) -> Result<Vec<RemoteFetchStatus>> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let remote_names = repo.remotes()?;
    let mut statuses: Vec<RemoteFetchStatus> = Vec::new();

    for remote_name in remote_names.iter().filter_map(|s| s.ok().flatten()) {
        if let Ok(remote) = repo.find_remote(remote_name) {
            let url = remote.url().unwrap_or("").to_string();

            // Get branches that track this remote
            let mut branches: Vec<String> = Vec::new();
            if let Ok(branch_iter) = repo.branches(Some(git2::BranchType::Remote)) {
                for (branch, _) in branch_iter.flatten() {
                    if let Some(name) = branch.name().ok().flatten() {
                        if name.starts_with(&format!("{}/", remote_name)) {
                            // Strip the remote prefix to get just the branch name
                            let branch_name = name
                                .strip_prefix(&format!("{}/", remote_name))
                                .unwrap_or(name)
                                .to_string();
                            branches.push(branch_name);
                        }
                    }
                }
            }

            // Try to get last fetch time from FETCH_HEAD
            let last_fetch = get_last_fetch_time(&repo, remote_name);

            statuses.push(RemoteFetchStatus {
                remote: remote_name.to_string(),
                url,
                last_fetch,
                branches,
            });
        }
    }

    Ok(statuses)
}

/// Get the last fetch time for a remote by checking FETCH_HEAD modification time
fn get_last_fetch_time(repo: &git2::Repository, _remote_name: &str) -> Option<i64> {
    let fetch_head_path = repo.path().join("FETCH_HEAD");
    if let Ok(metadata) = std::fs::metadata(&fetch_head_path) {
        if let Ok(modified) = metadata.modified() {
            if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                return Some(duration.as_secs() as i64);
            }
        }
    }
    None
}
