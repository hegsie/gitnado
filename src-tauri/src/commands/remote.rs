//! Remote command handlers

use std::path::Path;
use tauri::{command, AppHandle, Emitter, State};

use crate::error::{GitnadoError, Result};
use crate::models::{
    FetchAllResult, MultiPushResult, Remote, RemoteFetchResult, RemoteFetchStatus,
    RemoteOperationResult, RemotePushResult,
};
use crate::services::cancellation::CancellationRegistry;
use crate::services::credentials_service::{self, TransferAbort};
use crate::services::remote_ops::{self, RemoteOp, RemoteOpRegistry};
use crate::services::transfer_monitor::{OperationProgress, ProgressSink, TransferMonitor};
use crate::utils::{create_command, reject_flag_like};

/// The sink that turns a transfer snapshot into the `operation-progress` event
/// `src/services/progress.service.ts` listens for.
fn progress_sink(app_handle: &AppHandle) -> ProgressSink {
    let app = app_handle.clone();
    std::sync::Arc::new(move |progress: OperationProgress| {
        let _ = app.emit("operation-progress", progress);
    })
}

/// The monitor a user-initiated remote operation runs under: cancellable via
/// `operation_id`, and reporting progress to the row that id belongs to.
fn operation_monitor(
    app_handle: &AppHandle,
    operation_id: Option<String>,
    message: impl Into<String>,
    token: crate::services::cancellation::CancellationToken,
) -> TransferMonitor {
    TransferMonitor::new(operation_id, message, token, progress_sink(app_handle))
}

/// Name the reason a git2 transfer stopped.
///
/// A cancelled and a timed-out transfer both surface from libgit2 as a
/// generic error, and the two flags are the only way to tell either of them
/// from a real failure that merely happened to land at the same moment — see
/// `credentials_service::TransferAbort`.
fn transfer_failure(
    abort: &TransferAbort,
    error: git2::Error,
    timeout_message: &str,
) -> GitnadoError {
    if abort.cancelled() {
        GitnadoError::OperationCancelled
    } else if abort.timed_out() {
        GitnadoError::OperationTimeout(timeout_message.to_string())
    } else {
        error.into()
    }
}

/// Add a new remote
#[command]
pub async fn add_remote(path: String, name: String, url: String) -> Result<Remote> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Check if remote already exists
    if repo.find_remote(&name).is_ok() {
        return Err(GitnadoError::OperationFailed(format!(
            "Remote '{}' already exists",
            name
        )));
    }

    let remote = repo.remote(&name, &url)?;

    Ok(Remote {
        name,
        url: remote.url().unwrap_or("").to_string(),
        push_url: remote.pushurl().ok().flatten().map(|s| s.to_string()),
    })
}

/// Remove a remote
#[command]
pub async fn remove_remote(path: String, name: String) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Check if remote exists
    repo.find_remote(&name)
        .map_err(|_| GitnadoError::RemoteNotFound(name.clone()))?;

    repo.remote_delete(&name)?;

    Ok(())
}

/// Rename a remote
#[command]
pub async fn rename_remote(path: String, old_name: String, new_name: String) -> Result<Remote> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Check if old remote exists
    let old_remote = repo
        .find_remote(&old_name)
        .map_err(|_| GitnadoError::RemoteNotFound(old_name.clone()))?;

    let url = old_remote.url().unwrap_or("").to_string();
    let push_url = old_remote.pushurl().ok().flatten().map(|s| s.to_string());

    // Check if new name already exists
    if repo.find_remote(&new_name).is_ok() {
        return Err(GitnadoError::OperationFailed(format!(
            "Remote '{}' already exists",
            new_name
        )));
    }

    // git2 remote_rename returns problems as a string array
    let problems = repo.remote_rename(&old_name, &new_name)?;

    if !problems.is_empty() {
        let problem_list: Vec<&str> = problems.iter().filter_map(|s| s.ok().flatten()).collect();
        if !problem_list.is_empty() {
            tracing::warn!("Remote rename had issues: {:?}", problem_list);
        }
    }

    Ok(Remote {
        name: new_name,
        url,
        push_url,
    })
}

/// Set the URL of a remote
///
/// An empty `url` with `push` set clears the push URL so pushes fall back to
/// the fetch URL — that is the only way to undo a divergent push destination.
/// An empty fetch URL is refused: a remote without one is unusable.
#[command]
pub async fn set_remote_url(
    path: String,
    name: String,
    url: String,
    push: Option<bool>,
) -> Result<Remote> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Check if remote exists
    repo.find_remote(&name)
        .map_err(|_| GitnadoError::RemoteNotFound(name.clone()))?;

    let url = url.trim();

    if push.unwrap_or(false) {
        match repo.remote_set_pushurl(&name, if url.is_empty() { None } else { Some(url) }) {
            // Deleting an absent pushurl reports NotFound; the remote is
            // already in the state the caller asked for.
            Err(e) if url.is_empty() && e.code() == git2::ErrorCode::NotFound => {}
            other => other?,
        }
    } else {
        if url.is_empty() {
            return Err(GitnadoError::OperationFailed(
                "Remote URL cannot be empty".to_string(),
            ));
        }
        repo.remote_set_url(&name, url)?;
    }

    // Get updated remote info
    let remote = repo.find_remote(&name)?;

    Ok(Remote {
        name,
        url: remote.url().unwrap_or("").to_string(),
        push_url: remote.pushurl().ok().flatten().map(|s| s.to_string()),
    })
}

/// Get all remotes
#[command]
pub async fn get_remotes(path: String) -> Result<Vec<Remote>> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let remotes = repo.remotes()?;

    let mut result = Vec::new();

    for name in remotes.iter().filter_map(|s| s.ok().flatten()) {
        if let Ok(remote) = repo.find_remote(name) {
            result.push(Remote {
                name: name.to_string(),
                url: remote.url().unwrap_or("").to_string(),
                push_url: remote.pushurl().ok().flatten().map(|s| s.to_string()),
            });
        }
    }

    Ok(result)
}

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

/// The message and IPC error code for a failure reported through an EVENT
/// rather than as a command result.
///
/// The code is what the frontend already switches on (MERGE_CONFLICT,
/// REBASE_CONFLICT, ...); a late completion that carried only prose lost it.
fn late_failure(prefix: &str, error: GitnadoError) -> (String, Option<String>) {
    let message = format!("{}: {}", prefix, error);
    (message, Some(crate::error::ErrorResponse::from(error).code))
}

/// The event a fetch that landed after its reported timeout should emit, if
/// any.
///
/// A free function rather than a closure body so both branches are testable:
/// whether a background fetch stays silent, and what a user-initiated one says
/// when it lands late, are user-visible decisions.
fn fetch_late_event(
    quiet: bool,
    late: Result<()>,
    remote: String,
    repo_path: String,
) -> Option<RemoteOperationResult> {
    // A fetch the user did not ask for must not announce itself, late or not.
    if quiet {
        return None;
    }
    let (success, message, error_code) = match late {
        Ok(()) => (
            true,
            "Fetch finished after it was reported as timed out".to_string(),
            None,
        ),
        Err(e) => {
            let (message, code) =
                late_failure("Fetch failed after it was reported as timed out", e);
            (false, message, code)
        }
    };
    Some(RemoteOperationResult {
        operation: "fetch".to_string(),
        remote,
        repo_path,
        success,
        message,
        error_code,
        late: true,
    })
}

/// Refuse a pull while another operation is unresolved, the way merge() does.
fn ensure_pullable(repo_path: &Path) -> Result<()> {
    let repo = git2::Repository::open(repo_path)?;
    match repo.state() {
        git2::RepositoryState::Clean => Ok(()),
        git2::RepositoryState::Merge => Err(GitnadoError::OperationFailed(
            "You have not concluded your merge (MERGE_HEAD exists). Resolve the \
             conflicts and commit, or abort the merge, before pulling."
                .to_string(),
        )),
        state => Err(GitnadoError::OperationFailed(format!(
            "Cannot pull: another operation is in progress ({:?}). \
             Complete or abort it first.",
            state
        ))),
    }
}

/// The timeout a `timeout_secs` argument asks for. `None`/`0` means none.
fn network_timeout(timeout_secs: Option<u64>) -> Option<std::time::Duration> {
    timeout_secs
        .filter(|secs| *secs > 0)
        .map(std::time::Duration::from_secs)
}

/// The wall-clock deadline that timeout implies, for enforcement INSIDE the
/// blocking task — the same thing `clone_repository` computes for its own.
fn network_deadline(timeout_secs: Option<u64>) -> Option<std::time::Instant> {
    network_timeout(timeout_secs).map(|d| std::time::Instant::now() + d)
}

/// Await a spawned remote operation under `timeout`, without abandoning it.
///
/// `tokio::time::timeout` drops the future it wraps; it does NOT cancel a
/// `tokio::task::spawn_blocking` task. The merge, the rebase, the push kept
/// running on its thread and landed minutes after the user was told the
/// operation had timed out: refs and the working tree changed with no event,
/// no refresh and no toast, and the retry hit `ensure_pullable`'s "another
/// operation is in progress" or produced a second merge nobody asked for. The
/// in-task deadline usually stops the transfer first, but work already past
/// the network phase cannot be stopped — so the still-running handle is handed
/// to a detached reporter that announces the real outcome when it lands.
///
/// `on_late` is skipped when the abandoned task ends in `OperationTimeout`:
/// that is the in-task deadline stopping the work cleanly, before anything was
/// written — the very outcome the caller was already told about — so there is
/// nothing new to report. `OperationTimeoutAfterChange` is deliberately NOT
/// suppressed: it means the work had already changed the repository.
async fn await_remote_task<T: Send + 'static>(
    timeout: Option<std::time::Duration>,
    label: &str,
    mut handle: tokio::task::JoinHandle<Result<T>>,
    on_late: impl FnOnce(Result<T>) + Send + 'static,
) -> Result<T> {
    let label_owned = label.to_string();
    let late_label = label.to_string();
    let join_failed = move |e: tokio::task::JoinError| {
        GitnadoError::Custom(format!("{} task failed: {}", label_owned, e))
    };

    let Some(timeout) = timeout else {
        return handle.await.map_err(join_failed)?;
    };

    // `&mut JoinHandle` is itself a Future (JoinHandle is Unpin), so the task
    // survives the timeout and can still be moved into the reporter below.
    match tokio::time::timeout(timeout, &mut handle).await {
        Ok(joined) => joined.map_err(join_failed)?,
        Err(_) => {
            tokio::spawn(async move {
                match handle.await {
                    Ok(Err(GitnadoError::OperationTimeout(_))) => {}
                    Ok(result) => on_late(result),
                    // A panic AFTER the task moved refs or rewrote the working
                    // tree is exactly the silent mutation this reporter exists
                    // to prevent, so a log line is not enough: report it like
                    // any other late failure so the frontend refreshes.
                    Err(e) => {
                        tracing::warn!("abandoned remote task failed to join: {}", e);
                        on_late(Err(GitnadoError::Custom(format!(
                            "{} task failed: {}",
                            late_label, e
                        ))));
                    }
                }
            });
            Err(GitnadoError::OperationTimeout(format!(
                "{} operation timed out",
                label
            )))
        }
    }
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
fn fast_forward_to(repo: &git2::Repository, refname: &str, target_oid: git2::Oid) -> Result<()> {
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
fn pull_should_rebase(repo: &git2::Repository, branch_name: &str) -> bool {
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

/// The remote a push would target, without performing it.
#[tauri::command]
pub async fn get_push_remote(path: String, remote: Option<String>) -> Result<String> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let remote_name = resolve_push_remote(&repo, remote);
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

/// Which remote a push should target when the caller named none.
///
/// git's documented precedence: branch.<n>.pushRemote, then remote.pushDefault,
/// then branch.<n>.remote, then origin. Reading only branch_upstream_remote was
/// a REGRESSION on the fork workflow it was meant to help: with main tracking
/// upstream/main and remote.pushDefault=origin, a Force Push aimed at the
/// CANONICAL repo rather than the user's fork — and its confirm names no remote.
pub(crate) fn resolve_push_remote(repo: &git2::Repository, requested: Option<String>) -> String {
    if let Some(r) = requested {
        return r;
    }

    let head_branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().ok().map(|s| s.to_string()));
    let cfg = repo.config().ok();
    let from_push_config = cfg.as_ref().and_then(|c| {
        head_branch
            .as_ref()
            .and_then(|b| c.get_string(&format!("branch.{}.pushRemote", b)).ok())
            .or_else(|| c.get_string("remote.pushDefault").ok())
    });
    if let Some(r) = from_push_config {
        return r;
    }
    let from_upstream = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.name().ok().map(|n| n.to_string()))
        .and_then(|refname| repo.branch_upstream_remote(&refname).ok())
        .and_then(|b| b.as_str().ok().map(|s| s.to_string()));
    if let Some(r) = from_upstream {
        return r;
    }
    match repo.remotes() {
        Ok(names) if names.len() == 1 => {
            names.get(0).ok().flatten().unwrap_or("origin").to_string()
        }
        _ => "origin".to_string(),
    }
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

/// Whether a branch has an upstream CONFIGURED, per branch.<name>.remote and
/// branch.<name>.merge — the two keys git itself treats as the upstream.
///
/// Read from config rather than resolved via `Branch::upstream()`, which fails
/// both when no upstream is configured AND when a configured one no longer
/// resolves — a remote-tracking ref that has since been pruned, or a remote
/// removed from the repository. Treating those alike silently re-pointed a
/// deliberately-configured upstream at whatever remote the user happened to
/// push to next, which is exactly what leaving established upstreams alone is
/// supposed to prevent.
fn upstream_is_configured(repo: &git2::Repository, branch_name: &str) -> bool {
    let Ok(config) = repo.config() else {
        return false;
    };
    let is_set = |key: String| {
        config
            .get_string(&key)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
    };
    is_set(format!("branch.{}.remote", branch_name))
        && is_set(format!("branch.{}.merge", branch_name))
}

/// Push one branch to a remote, and record the upstream when the branch has
/// none.
///
/// Extracted from `push` so it can be TESTED: `push` takes a Tauri
/// `AppHandle`, so the whole body — remote resolution, the force-push branch
/// rule, the git2/CLI split and the upstream bookkeeping — was unreachable
/// from a unit test.
///
/// Returns the remote and branch actually pushed.
#[allow(clippy::too_many_arguments)]
pub(crate) fn push_branch(
    path_for_task: &str,
    requested_remote: Option<String>,
    branch_for_task: Option<String>,
    force_val: bool,
    use_force_with_lease: bool,
    use_push_tags: bool,
    set_upstream_val: bool,
    token: Option<String>,
    monitor: TransferMonitor,
) -> Result<(String, String)> {
    // A cancel that arrived while the push was still queued must not reach the
    // remote at all. The later checks are the branch-rule gate and, for the
    // git2 path, `push_negotiation` — see `get_push_options_with_monitor` for
    // why that is the last one git2 offers.
    if monitor.is_cancelled() {
        return Err(GitnadoError::OperationCancelled);
    }

    let repo = git2::Repository::open(Path::new(path_for_task))?;

    // Resolve the remote from the branch's upstream, then the sole
    // remote, before falling back to "origin". Hard-coding origin
    // failed outright on `git clone -o upstream`, on a Gerrit
    // checkout, and on any remote the app's own Remote dialog
    // renamed — with no remote selector on Push anywhere in the UI,
    // the user's only recovery was to rename it back.
    let remote_for_task = resolve_push_remote(&repo, requested_remote.clone());

    repo.find_remote(&remote_for_task)
        .map_err(|_| GitnadoError::RemoteNotFound(remote_for_task.clone()))?;

    let branch_name = if let Some(ref b) = branch_for_task {
        b.clone()
    } else {
        let head = repo.head()?;
        head.shorthand().unwrap_or("main").to_string()
    };

    // A `preventForcePush` rule was stored and read by nothing —
    // only `preventDeletion` was ever enforced, so the field was
    // decorative while the app grew a one-click Force Push action
    // on the push-rejection toast. Checked here, in the command, for
    // the same reason deletion is: every surface reaches this path,
    // and none of them load the rules themselves.
    //
    // Propagated rather than defaulted, like delete_branch: a
    // protection that fails open is worse than none.
    if force_val || use_force_with_lease {
        let rules = crate::commands::branch_rules::load_rules(Path::new(&path_for_task))?;
        if crate::commands::branch_rules::is_force_push_prevented(&rules, &branch_name) {
            return Err(GitnadoError::OperationFailed(format!(
                "Branch \"{}\" is protected by a branch rule and cannot be \
                         force-pushed. Remove the rule first.",
                branch_name
            )));
        }
    }

    // Give a branch that has no upstream one from the push that
    // published it, the way `git push -u` and every mainstream
    // client do on a first push.
    //
    // No push surface in this app passes set_upstream — not the
    // toolbar, not the dashboard, not force push — so after the
    // routine "create branch → commit → Push" the branch was left
    // untracked: no tracking arrow in the sidebar, no ahead/behind
    // badge ever, pulls falling back to name-matching instead of
    // real tracking, and the cleanup dialog later flagging it as
    // "No upstream configured — may contain unmerged work". The
    // only cure was a Set Upstream context-menu item the user had
    // to know to look for.
    //
    // Branches that already track something are left alone, so a
    // push to a second remote never re-points the upstream.
    let branch_lacks_upstream = repo
        .find_branch(&branch_name, git2::BranchType::Local)
        .is_ok()
        && !upstream_is_configured(&repo, &branch_name);
    let should_set_upstream = set_upstream_val || branch_lacks_upstream;

    let monitor = monitor.with_message(format!("Pushing to {}", remote_for_task));

    if use_force_with_lease || use_push_tags {
        push_via_cli(
            path_for_task,
            &remote_for_task,
            &branch_name,
            force_val,
            use_force_with_lease,
            use_push_tags,
            should_set_upstream,
            token,
            &monitor,
        )?;
    } else {
        // Run pre-push like canonical git — the git2 push path
        // otherwise bypasses it. A non-zero exit aborts the push.
        crate::commands::hooks::run_pre_push_branch(&repo, &remote_for_task, &branch_name)?;

        // The pre-push hook can take a while (test suites are a common one),
        // so re-check before opening a connection.
        if monitor.is_cancelled() {
            return Err(GitnadoError::OperationCancelled);
        }

        let mut git_remote = repo
            .find_remote(&remote_for_task)
            .map_err(|_| GitnadoError::RemoteNotFound(remote_for_task.clone()))?;

        let (mut push_opts, abort) =
            credentials_service::get_push_options_with_monitor(token, monitor);

        let refspec = if force_val {
            format!("+refs/heads/{}:refs/heads/{}", branch_name, branch_name)
        } else {
            format!("refs/heads/{}:refs/heads/{}", branch_name, branch_name)
        };

        git_remote
            .push(&[&refspec], Some(&mut push_opts))
            .map_err(|e| transfer_failure(&abort, e, "Push operation timed out"))?;

        if should_set_upstream {
            let upstream_name = format!("{}/{}", remote_for_task, branch_name);
            let recorded = repo
                .find_branch(&branch_name, git2::BranchType::Local)
                .and_then(|mut b| b.set_upstream(Some(&upstream_name)));

            // The commits are on the remote either way. An explicit
            // "Set Upstream" must still report its own failure, but
            // the automatic first-push case must not turn a landed
            // push into a red "Push failed" the user would retry.
            if set_upstream_val {
                recorded?;
            }
        }
    }

    Ok((remote_for_task, branch_name))
}

/// The message a completed push reports. Shared by the normal and the late
/// path so the two cannot drift.
fn push_message(
    remote: &str,
    branch: &str,
    force: bool,
    force_with_lease: bool,
    push_tags: bool,
) -> String {
    let mut message = if force_with_lease {
        format!("Force-pushed (with lease) to {}/{}", remote, branch)
    } else if force {
        format!("Force-pushed to {}/{}", remote, branch)
    } else {
        format!("Pushed to {}/{}", remote, branch)
    };
    if push_tags {
        message.push_str(" (including tags)");
    }
    message
}

/// Push to remote
#[allow(clippy::too_many_arguments)]
#[command]
pub async fn push(
    app_handle: AppHandle,
    remote_ops_registry: State<'_, RemoteOpRegistry>,
    cancellation_registry: State<'_, CancellationRegistry>,
    path: String,
    remote: Option<String>,
    branch: Option<String>,
    force: Option<bool>,
    force_with_lease: Option<bool>,
    push_tags: Option<bool>,
    set_upstream: Option<bool>,
    token: Option<String>,
    timeout_secs: Option<u64>,
    operation_id: Option<String>,
) -> Result<()> {
    // Reject branch values that could be parsed as a flag by `git push`
    // (e.g. `--receive-pack=/tmp/evil`). The remote name is safer because
    // it must already exist in the repo config.
    if let Some(ref b) = branch {
        reject_flag_like(b, "Branch name")?;
    }
    if let Some(ref r) = remote {
        reject_flag_like(r, "Remote name")?;
    }

    // The claim the racing retry is about. Push has no abort point at all, so
    // when the network timeout fires the git2/CLI push keeps running against
    // the remote; the frontend push slot is released on that early return and
    // the user's retry used to overlap the original. The slot travels into the
    // blocking task below and is released only when the push really ends.
    let slot = remote_ops_registry.acquire(Path::new(&path), RemoteOp::Push)?;

    let repo_path = path.clone();
    let path_for_task = path.clone();
    let requested_remote = remote.clone();
    let branch_for_task = branch.clone();
    let force_val = force.unwrap_or(false);
    let use_force_with_lease = force_with_lease.unwrap_or(false);
    let use_push_tags = push_tags.unwrap_or(false);
    let set_upstream_val = set_upstream.unwrap_or(false);

    // Registered so `cancel_operation` can find this push; the guard rides
    // into the blocking task and deregisters when the push really ends.
    let op_guard = cancellation_registry.guard(operation_id.clone());
    let monitor = operation_monitor(
        &app_handle,
        operation_id,
        "Pushing to remote",
        op_guard.token(),
    );

    // git2/git-CLI push is blocking network I/O; offload so the runtime
    // stays responsive during slow remotes.
    let handle = remote_ops::spawn_holding(Some(slot), move || {
        let _op_guard = op_guard;
        push_branch(
            &path_for_task,
            requested_remote,
            branch_for_task,
            force_val,
            use_force_with_lease,
            use_push_tags,
            set_upstream_val,
            token,
            monitor,
        )
    });

    let app_late = app_handle.clone();
    let repo_late = repo_path.clone();
    let (remote_name_returned, branch_name_returned) =
        await_remote_task(network_timeout(timeout_secs), "Push", handle, move |late| {
            // git2 offers no way to abort a push in flight, so a slow push can
            // land — force push included — after the caller was told it timed
            // out. Say what actually happened to the remote branch.
            let (remote, success, message, error_code) = match late {
                Ok((remote, branch)) => {
                    let done = push_message(
                        &remote,
                        &branch,
                        force_val,
                        use_force_with_lease,
                        use_push_tags,
                    );
                    (
                        remote,
                        true,
                        format!("Push finished after it was reported as timed out: {}", done),
                        None,
                    )
                }
                Err(e) => {
                    let (message, code) =
                        late_failure("Push failed after it was reported as timed out", e);
                    ("unknown".to_string(), false, message, code)
                }
            };
            let _ = app_late.emit(
                "remote-operation-completed",
                RemoteOperationResult {
                    operation: "push".to_string(),
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
    let message = push_message(
        &remote_name_returned,
        &branch_name_returned,
        force_val,
        use_force_with_lease,
        use_push_tags,
    );

    let _ = app_handle.emit(
        "remote-operation-completed",
        RemoteOperationResult {
            operation: "push".to_string(),
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

/// The URL a push to `remote_name` will actually contact, and therefore the one
/// whose host a token has to be scoped to.
///
/// `pushurl` wins when the remote configures one: git contacts THAT host on a
/// push, so scoping the credential to the fetch url would leave the push
/// authenticating with nothing. `None` when the remote is unknown or has no
/// url, in which case no host can be named and nothing is injected.
fn push_remote_url(path: &str, remote_name: &str) -> Option<String> {
    let repo = git2::Repository::open(path).ok()?;
    let remote = repo.find_remote(remote_name).ok()?;
    remote
        .pushurl()
        .ok()
        .flatten()
        .or_else(|| remote.url().ok())
        .map(|u| u.to_string())
}

/// Run a prepared `git push` to completion, killing it if the user cancels.
///
/// `Command::output()` blocks until the child exits, which is why the force
/// push had no cancellation point at all. Spawning and polling gives it one.
/// Both pipes are drained on their own threads: git push writes its progress
/// to stderr, and leaving a piped stream unread deadlocks the child once the
/// pipe buffer fills — the same trap `clone_repository` documents.
fn run_push_command(
    mut cmd: std::process::Command,
    monitor: &TransferMonitor,
) -> Result<std::process::Output> {
    if monitor.is_cancelled() {
        return Err(GitnadoError::OperationCancelled);
    }

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to execute git push: {}", e)))?;

    let drain = |pipe: Option<Box<dyn std::io::Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                use std::io::Read;
                let _ = pipe.read_to_end(&mut buf);
            }
            buf
        })
    };
    let stdout_reader = drain(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
    );
    let stderr_reader = drain(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
    );

    let status = loop {
        if monitor.is_cancelled() {
            // Killed and reaped before returning: an orphaned `git push` would
            // keep talking to the remote after the user was told it stopped.
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(GitnadoError::OperationCancelled);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(GitnadoError::OperationFailed(format!(
                    "Failed to wait for git push: {}",
                    e
                )));
            }
        }
    };

    Ok(std::process::Output {
        status,
        stdout: stdout_reader.join().unwrap_or_default(),
        stderr: stderr_reader.join().unwrap_or_default(),
    })
}

/// Push via git CLI (used for --force-with-lease and --tags which git2 doesn't support)
///
/// Unlike the git2 path this one CAN be stopped mid-transfer: the child is
/// spawned rather than run to completion, and a cancellation kills it — the
/// same shape `clone_repository`'s CLI path uses.
#[allow(clippy::too_many_arguments)]
fn push_via_cli(
    path: &str,
    remote_name: &str,
    branch_name: &str,
    force: bool,
    force_with_lease: bool,
    push_tags: bool,
    set_upstream: bool,
    token: Option<String>,
    monitor: &TransferMonitor,
) -> Result<()> {
    let mut cmd = create_command("git");
    cmd.arg("-C").arg(path).arg("push");

    // force_with_lease takes priority over force
    if force_with_lease {
        cmd.arg("--force-with-lease");
        // --force-if-includes is what makes the lease mean what the confirm
        // says it means. A BARE --force-with-lease leases against the local
        // remote-tracking ref, and this app ships a background auto-fetch
        // (services/autofetch_service.rs) that updates exactly that ref on a
        // timer. With auto-fetch on, a colleague's push landed in
        // refs/remotes/<remote>/<branch> seconds later, the lease then matched
        // it, and the force push destroyed their commits — the one outcome the
        // confirm promises cannot happen. --force-if-includes additionally
        // requires that the remote tip be reachable from the local branch's
        // reflog, i.e. that the user actually SAW and integrated it, which a
        // background fetch cannot fake. Verified: with a background fetch in
        // between, bare --force-with-lease overwrites the colleague's commit
        // and --force-if-includes refuses it.
        cmd.arg("--force-if-includes");
    } else if force {
        cmd.arg("--force");
    }

    if push_tags {
        cmd.arg("--tags");
    }

    if set_upstream {
        cmd.arg("--set-upstream");
    }

    // `--` keeps remote_name / branch_name from being parsed as flags by git
    // even though callers also validate them with reject_flag_like.
    cmd.arg("--");
    cmd.arg(remote_name);
    cmd.arg(branch_name);

    // Feed the token through a credential helper, the way the git2 path does
    // with Cred::userpass_plaintext.
    //
    // This used to set GIT_ASKPASS=echo, which makes git run `echo <prompt>` —
    // so it authenticated with the literal string "Username for
    // 'https://...'" as the username and the prompt text as the password.
    // GIT_TOKEN is not a variable git reads, and clearing credential.helper
    // also disabled the user's own helper, so the fallback could not save it.
    // The net effect was that Force Push — the only route through this
    // function — failed to authenticate on HTTPS precisely BECAUSE a token was
    // found, while pushing with no token stored worked.
    //
    // Scoped to the remote's own host, so the token is offered to the host it
    // belongs to and nowhere else.
    if let Some(ref token_value) = token {
        if let Some(remote_url) = push_remote_url(path, remote_name) {
            crate::utils::apply_token_credential_helper(&mut cmd, token_value, &remote_url);
        }
    }

    let output = run_push_command(cmd, monitor)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // git older than 2.30 has no --force-if-includes. Say so instead of
        // reporting a bare "unknown option", and do NOT retry without it: the
        // whole point of the flag is that the lease is unsafe on this app
        // without it, so silently dropping it would trade a clear error for a
        // force push that can discard a colleague's commits.
        if force_with_lease && stderr.contains("force-if-includes") {
            return Err(GitnadoError::OperationFailed(
                "Force push needs git 2.30 or newer for its safety check (--force-if-includes). Please update git."
                    .to_string(),
            ));
        }
        return Err(GitnadoError::OperationFailed(format!(
            "git push failed: {}",
            stderr.trim()
        )));
    }

    Ok(())
}

/// Internal function to push to a single remote (used by push_to_multiple_remotes)
fn push_single_remote(
    path: &str,
    remote_name: &str,
    branch_name: &str,
    force: bool,
    force_with_lease: bool,
    push_tags: bool,
    token: Option<String>,
) -> std::result::Result<(), String> {
    // The same branch-rule gate the single-remote `push` command applies. A
    // protection enforced on only some of the paths that reach a force push is
    // the stale hand-enumerated list this codebase keeps being bitten by, so
    // this one is checked here even though the multi-remote command currently
    // has no UI caller — the hole would be invisible the day it gets one.
    if force || force_with_lease {
        let rules = crate::commands::branch_rules::load_rules(Path::new(path))
            .map_err(|e| e.to_string())?;
        if crate::commands::branch_rules::is_force_push_prevented(&rules, branch_name) {
            return Err(format!(
                "Branch \"{}\" is protected by a branch rule and cannot be force-pushed. \
                 Remove the rule first.",
                branch_name
            ));
        }
    }

    if force_with_lease || push_tags {
        push_via_cli(
            path,
            remote_name,
            branch_name,
            force,
            force_with_lease,
            push_tags,
            false,
            token,
            // The multi-remote push has no progress row and no operation id of
            // its own, so nothing can cancel it — see `push_to_multiple_remotes`.
            &TransferMonitor::disabled(),
        )
        .map_err(|e| e.to_string())
    } else {
        let repo = git2::Repository::open(Path::new(path)).map_err(|e| e.message().to_string())?;

        // Run pre-push like canonical git; a non-zero exit aborts the push.
        crate::commands::hooks::run_pre_push_branch(&repo, remote_name, branch_name)
            .map_err(|e| e.to_string())?;

        let mut git_remote = repo
            .find_remote(remote_name)
            .map_err(|_| format!("Remote '{}' not found", remote_name))?;

        let mut push_opts = credentials_service::get_push_options(token);

        let refspec = if force {
            format!("+refs/heads/{}:refs/heads/{}", branch_name, branch_name)
        } else {
            format!("refs/heads/{}:refs/heads/{}", branch_name, branch_name)
        };

        git_remote
            .push(&[&refspec], Some(&mut push_opts))
            .map_err(|e| e.message().to_string())?;

        Ok(())
    }
}

/// Push to multiple remotes
#[allow(clippy::too_many_arguments)]
#[command]
pub async fn push_to_multiple_remotes(
    app_handle: AppHandle,
    path: String,
    remotes: Vec<String>,
    branch: Option<String>,
    force: bool,
    force_with_lease: bool,
    push_tags: bool,
    token: Option<String>,
) -> Result<MultiPushResult> {
    // Reject branch and remote names that could be parsed as flags.
    if let Some(ref b) = branch {
        reject_flag_like(b, "Branch name")?;
    }
    for r in &remotes {
        reject_flag_like(r, "Remote name")?;
    }

    // Each push is blocking network I/O for potentially seconds; running them
    // sequentially on the async executor blocks a Tokio worker for the full
    // duration of all pushes combined. Offload to a blocking thread.
    let path_for_task = path.clone();
    let remotes_for_task = remotes.clone();
    let branch_for_task = branch.clone();
    let token_for_task = token.clone();

    let (results, total_success, total_failed) =
        tokio::task::spawn_blocking(move || -> Result<(Vec<RemotePushResult>, u32, u32)> {
            let repo = git2::Repository::open(Path::new(&path_for_task))?;

            let branch_name = if let Some(ref b) = branch_for_task {
                b.clone()
            } else {
                let head = repo.head()?;
                head.shorthand().unwrap_or("main").to_string()
            };

            // Validate that all remotes exist before starting
            for remote_name in &remotes_for_task {
                repo.find_remote(remote_name)
                    .map_err(|_| GitnadoError::RemoteNotFound(remote_name.clone()))?;
            }

            let mut results: Vec<RemotePushResult> = Vec::new();
            let mut total_success: u32 = 0;
            let mut total_failed: u32 = 0;

            for remote_name in &remotes_for_task {
                match push_single_remote(
                    &path_for_task,
                    remote_name,
                    &branch_name,
                    force,
                    force_with_lease,
                    push_tags,
                    token_for_task.clone(),
                ) {
                    Ok(()) => {
                        let mut message = format!("Pushed to {}/{}", remote_name, branch_name);
                        if force_with_lease {
                            message = format!(
                                "Force-pushed (with lease) to {}/{}",
                                remote_name, branch_name
                            );
                        } else if force {
                            message = format!("Force-pushed to {}/{}", remote_name, branch_name);
                        }
                        if push_tags {
                            message.push_str(" (including tags)");
                        }

                        results.push(RemotePushResult {
                            remote: remote_name.clone(),
                            success: true,
                            message: Some(message),
                        });
                        total_success += 1;
                    }
                    Err(e) => {
                        results.push(RemotePushResult {
                            remote: remote_name.clone(),
                            success: false,
                            message: Some(e),
                        });
                        total_failed += 1;
                    }
                }
            }

            Ok((results, total_success, total_failed))
        })
        .await
        .map_err(|e| GitnadoError::Custom(format!("Push task failed: {}", e)))??;

    let overall_success = total_failed == 0;

    // Emit event for the operation
    let _ = app_handle.emit(
        "remote-operation-completed",
        RemoteOperationResult {
            operation: "push_multiple".to_string(),
            remote: "multiple".to_string(),
            repo_path: path.clone(),
            success: overall_success,
            message: format!(
                "Pushed to {} remote(s) ({} failed)",
                total_success, total_failed
            ),
            error_code: None,
            late: false,
        },
    );

    Ok(MultiPushResult {
        results,
        total_success,
        total_failed,
    })
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
fn fetch_single_remote(
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

/// Cancel an ongoing remote operation
#[command]
pub async fn cancel_operation(
    registry: tauri::State<'_, CancellationRegistry>,
    operation_id: String,
) -> Result<bool> {
    Ok(registry.cancel(&operation_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    // ---- a timed-out remote operation is never abandoned silently ----

    /// Collects whatever the late reporter is handed, so a test can assert on
    /// a completion that arrives after `await_remote_task` already returned.
    type LateSlot<T> = Arc<Mutex<Option<Result<T>>>>;

    fn late_slot<T>() -> (LateSlot<T>, impl FnOnce(Result<T>) + Send + 'static)
    where
        T: Send + 'static,
    {
        let seen: LateSlot<T> = Arc::new(Mutex::new(None));
        let sink = Arc::clone(&seen);
        (seen, move |result| {
            *sink.lock().unwrap() = Some(result);
        })
    }

    /// Wait for the detached reporter to hand something over, rather than
    /// pinning the test to a fixed sleep the machine may not honour.
    async fn late_outcome<T: Send + 'static>(seen: &LateSlot<T>) -> Option<Result<T>> {
        for _ in 0..250 {
            if seen.lock().unwrap().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        seen.lock().unwrap().take()
    }

    /// `tokio::time::timeout` only DROPS the future it wraps — a
    /// `spawn_blocking` task keeps running. The merge landed minutes after the
    /// user was told the pull timed out, with no event and no refresh.
    #[tokio::test]
    async fn test_timed_out_task_still_reports_its_completion() {
        let (seen, on_late) = late_slot::<String>();
        let handle = tokio::task::spawn_blocking(|| {
            std::thread::sleep(Duration::from_millis(120));
            Ok("Merge completed".to_string())
        });

        let result =
            await_remote_task(Some(Duration::from_millis(10)), "Pull", handle, on_late).await;

        match result {
            Err(GitnadoError::OperationTimeout(m)) => {
                assert_eq!(m, "Pull operation timed out");
            }
            other => panic!("expected a Pull timeout, got {:?}", other.map(|_| ())),
        }

        tokio::time::sleep(Duration::from_millis(400)).await;
        let late = seen.lock().unwrap();
        match late.as_ref() {
            Some(Ok(message)) => assert_eq!(message, "Merge completed"),
            Some(Err(e)) => panic!("the abandoned task reported a failure: {}", e),
            None => panic!("the abandoned task's completion was never reported at all"),
        }
    }

    /// The two halves of the timeout story have to hold together.
    ///
    /// `services/remote_ops.rs` keeps the repository claimed until the
    /// abandoned task really ends, so the user's retry cannot race it; this
    /// module reports what that task finally did, so the change it made is not
    /// silent. Each is easy to break while the other still passes — awaiting
    /// the JoinHandle inside `run_holding` throws away the handle the late
    /// reporter needs, and holding the guard outside the closure frees the
    /// repository the instant the timeout fires.
    #[tokio::test]
    async fn test_a_timed_out_operation_keeps_its_slot_and_still_reports_late() {
        let repo = TestRepo::new();
        let registry = RemoteOpRegistry::default();
        let (seen, on_late) = late_slot::<String>();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel::<()>();

        // Exactly what `push` does: claim, then hand the claim to the task.
        let slot = registry.acquire(&repo.path, RemoteOp::Push).unwrap();
        let handle = remote_ops::spawn_holding(Some(slot), move || {
            // Stands in for a git2 push against an unreachable remote:
            // blocking, and with no abort point.
            let _ = finish_rx.recv();
            Ok("Pushed to origin/main".to_string())
        });

        let result =
            await_remote_task(Some(Duration::from_millis(10)), "Push", handle, on_late).await;
        match result {
            Err(GitnadoError::OperationTimeout(m)) => assert_eq!(m, "Push operation timed out"),
            other => panic!("expected a Push timeout, got {:?}", other.map(|_| ())),
        }

        // The retry the user is about to attempt has to be refused while the
        // abandoned push is still talking to the remote.
        assert_eq!(
            registry.running(&repo.path),
            Some(RemoteOp::Push),
            "the timed-out push must still hold the repository"
        );
        assert!(
            registry.acquire(&repo.path, RemoteOp::Push).is_err(),
            "a retry must not overlap the push that is still running"
        );

        finish_tx.send(()).unwrap();
        match late_outcome(&seen).await {
            Some(Ok(message)) => assert_eq!(message, "Pushed to origin/main"),
            Some(Err(e)) => panic!("the abandoned push reported a failure: {}", e),
            None => panic!("the abandoned push's completion was never reported at all"),
        }

        // ...and once it really ended, the repository is usable again.
        for _ in 0..250 {
            if registry.running(&repo.path).is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            registry.acquire(&repo.path, RemoteOp::Push).is_ok(),
            "the slot must be released once the work really finished"
        );
    }

    /// The late reporter must stay quiet for an operation that made its
    /// deadline — otherwise every normal pull would toast twice.
    #[tokio::test]
    async fn test_task_that_finishes_in_time_is_never_reported_late() {
        let (seen, on_late) = late_slot::<u32>();
        let handle = tokio::task::spawn_blocking(|| Ok(7u32));

        let result = await_remote_task(Some(Duration::from_secs(5)), "Pull", handle, on_late).await;

        assert_eq!(result.unwrap(), 7);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(seen.lock().unwrap().is_none());
    }

    /// timeoutSecs absent or 0 (the setting can be disabled) waits it out.
    #[tokio::test]
    async fn test_no_timeout_awaits_the_task_to_completion() {
        let (seen, on_late) = late_slot::<()>();
        let handle = tokio::task::spawn_blocking(|| {
            std::thread::sleep(Duration::from_millis(50));
            Ok(())
        });

        await_remote_task(None, "Fetch", handle, on_late)
            .await
            .unwrap();

        assert!(seen.lock().unwrap().is_none());
        assert_eq!(network_timeout(Some(0)), None);
        assert_eq!(network_timeout(None), None);
    }

    /// The in-task deadline stopping the work cleanly is the outcome the
    /// caller was already told about — reporting it again is noise.
    #[tokio::test]
    async fn test_a_late_deadline_abort_is_not_reported_twice() {
        let (seen, on_late) = late_slot::<()>();
        let handle = tokio::task::spawn_blocking(|| {
            std::thread::sleep(Duration::from_millis(120));
            Err(GitnadoError::OperationTimeout(
                "Pull operation timed out".to_string(),
            ))
        });

        let result =
            await_remote_task(Some(Duration::from_millis(10)), "Pull", handle, on_late).await;
        assert!(matches!(result, Err(GitnadoError::OperationTimeout(_))));

        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(seen.lock().unwrap().is_none());
    }

    /// A timeout raised AFTER the fetch already wrote refs and FETCH_HEAD is
    /// not the "nothing happened" outcome the caller was told about: the
    /// repository changed, so the late reporter must still fire and the
    /// frontend must still refresh it.
    #[tokio::test]
    async fn test_a_timeout_after_the_repository_changed_is_still_reported() {
        let (seen, on_late) = late_slot::<()>();
        let handle = tokio::task::spawn_blocking(|| {
            std::thread::sleep(Duration::from_millis(120));
            Err(GitnadoError::OperationTimeoutAfterChange(
                "Pull operation timed out".to_string(),
            ))
        });

        let result =
            await_remote_task(Some(Duration::from_millis(10)), "Pull", handle, on_late).await;
        assert!(matches!(result, Err(GitnadoError::OperationTimeout(_))));

        match late_outcome(&seen).await {
            Some(Err(GitnadoError::OperationTimeoutAfterChange(_))) => {}
            Some(other) => panic!("unexpected late outcome: {:?}", other.err()),
            None => panic!("a timeout that had already changed the repo went unreported"),
        }
    }

    /// ...and it still reads as an ordinary timeout to the frontend, so the
    /// distinction stays internal to `await_remote_task`.
    #[test]
    fn test_a_post_fetch_timeout_reports_the_ordinary_timeout_code() {
        let response = crate::error::ErrorResponse::from(
            GitnadoError::OperationTimeoutAfterChange("Pull operation timed out".to_string()),
        );
        assert_eq!(response.code, "OPERATION_TIMEOUT");
    }

    /// A panic inside an abandoned task can land after it moved refs or
    /// rewrote the working tree. A log line reaches nobody; the frontend needs
    /// the event to refresh.
    #[tokio::test]
    async fn test_a_panicking_abandoned_task_is_reported_not_just_logged() {
        let (seen, on_late) = late_slot::<()>();
        let handle = tokio::task::spawn_blocking(|| -> Result<()> {
            std::thread::sleep(Duration::from_millis(120));
            panic!("boom")
        });

        let result =
            await_remote_task(Some(Duration::from_millis(10)), "Pull", handle, on_late).await;
        assert!(matches!(result, Err(GitnadoError::OperationTimeout(_))));

        match late_outcome(&seen).await {
            Some(Err(GitnadoError::Custom(m))) => assert!(
                m.starts_with("Pull task failed:"),
                "unexpected late join failure: {}",
                m
            ),
            Some(other) => panic!("unexpected late outcome: {:?}", other.err()),
            None => panic!("the abandoned task's panic was never reported"),
        }
    }

    // ---- what a fetch says when it lands after its timeout ----

    /// A fetch the user never asked for stays silent, late or not — the
    /// window-focus refresh runs this same command.
    #[test]
    fn test_a_background_fetch_says_nothing_when_it_lands_late() {
        assert!(
            fetch_late_event(true, Ok(()), "origin".to_string(), "/repos/a".to_string()).is_none()
        );
        assert!(fetch_late_event(
            true,
            Err(GitnadoError::OperationFailed("boom".to_string())),
            "origin".to_string(),
            "/repos/a".to_string(),
        )
        .is_none());
    }

    /// A fetch the user asked for that lands after its timeout error must say
    /// so: the caller already returned an error and will never refresh.
    #[test]
    fn test_a_user_fetch_reports_the_outcome_it_actually_had() {
        let done = fetch_late_event(false, Ok(()), "origin".to_string(), "/repos/a".to_string())
            .expect("a user-initiated fetch must report its late completion");
        assert_eq!(done.operation, "fetch");
        assert_eq!(done.remote, "origin");
        assert_eq!(done.repo_path, "/repos/a");
        assert!(done.success);
        assert!(done.late);
        assert_eq!(done.error_code, None);

        let failed = fetch_late_event(
            false,
            Err(GitnadoError::OperationFailed("boom".to_string())),
            "origin".to_string(),
            "/repos/a".to_string(),
        )
        .expect("a late failure must be reported too");
        assert!(!failed.success);
        assert!(failed.late);
        assert!(failed.message.contains("boom"), "{}", failed.message);
        assert_eq!(failed.error_code.as_deref(), Some("OPERATION_FAILED"));
    }

    /// Only a transfer the deadline callback aborted is a timeout. Anything
    /// else that fails while the deadline happens to be in the past keeps its
    /// own error — relabelling it hid auth and protocol failures behind
    /// "timed out", and on the pull path suppressed them entirely.
    #[test]
    fn test_a_fetch_failure_that_is_not_a_deadline_abort_keeps_its_error() {
        let local = TestRepo::new();
        local.add_remote("origin", "/does/not/exist/upstream.git");
        let past = Instant::now()
            .checked_sub(Duration::from_secs(60))
            .expect("a deadline in the past");

        let err = fetch_internal(
            &local.path_str(),
            "origin",
            false,
            None,
            Some(past),
            TransferMonitor::disabled(),
        )
        .expect_err("fetching a remote that does not exist must fail");

        assert!(
            !matches!(err, GitnadoError::OperationTimeout(_)),
            "a connection failure must not be relabelled as a timeout: {}",
            err
        );
    }

    /// A panicking task keeps today's message, so the restructure is not a
    /// silent regression for callers matching on it.
    #[tokio::test]
    async fn test_join_failure_keeps_the_operation_label() {
        let (_seen, on_late) = late_slot::<()>();
        let handle = tokio::task::spawn_blocking(|| -> Result<()> { panic!("boom") });

        let result = await_remote_task(Some(Duration::from_secs(5)), "Push", handle, on_late).await;

        match result {
            Err(GitnadoError::Custom(m)) => assert!(
                m.starts_with("Push task failed:"),
                "unexpected join error: {}",
                m
            ),
            other => panic!("expected a join failure, got {:?}", other.map(|_| ())),
        }
    }

    /// The shape a real clone has, built without a network: `local` sits on
    /// `origin/<branch>` with `origin` pointing at `upstream`.
    fn pull_fixture() -> (TestRepo, TestRepo, String) {
        let upstream = TestRepo::with_initial_commit();
        let local = TestRepo::new();
        local.add_remote("origin", &upstream.path_str());
        fetch_internal(
            &local.path_str(),
            "origin",
            false,
            None,
            None,
            TransferMonitor::disabled(),
        )
        .expect("fixture fetch");

        let branch = upstream.current_branch();
        let repo = local.repo();
        let commit = repo
            .find_reference(&format!("refs/remotes/origin/{}", branch))
            .expect("fixture remote ref")
            .peel_to_commit()
            .expect("fixture commit");
        repo.branch(&branch, &commit, true).expect("fixture branch");
        repo.set_head(&format!("refs/heads/{}", branch))
            .expect("fixture head");
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .expect("fixture checkout");

        (upstream, local, branch)
    }

    fn pull_with_deadline(
        local: &TestRepo,
        branch: &str,
        deadline: Option<Instant>,
    ) -> Result<(String, String)> {
        pull_with_monitor(local, branch, deadline, TransferMonitor::disabled())
    }

    fn pull_with_monitor(
        local: &TestRepo,
        branch: &str,
        deadline: Option<Instant>,
        monitor: TransferMonitor,
    ) -> Result<(String, String)> {
        pull_branch(
            &local.path_str(),
            Some("origin".to_string()),
            Some(branch.to_string()),
            Some(false),
            None,
            deadline,
            monitor,
        )
    }

    /// The payload: past its deadline the pull must not rewrite refs or the
    /// working tree. It used to fast-forward anyway, minutes after the user
    /// was shown "Pull operation timed out". Here the transfer itself is what
    /// the deadline stops — and it reports as the pull's own timeout, not as
    /// libgit2's "indexer progress callback returned -1".
    #[test]
    fn test_pull_past_its_deadline_does_not_touch_the_working_tree() {
        let (upstream, local, branch) = pull_fixture();
        upstream.create_commit("second", &[("b.txt", "b")]);
        let before = local.head_oid();

        let result = pull_with_deadline(
            &local,
            &branch,
            Some(Instant::now() - Duration::from_secs(1)),
        );

        match result {
            Err(GitnadoError::OperationTimeout(m)) => {
                assert_eq!(m, "Pull operation timed out");
            }
            other => panic!("expected a Pull timeout, got {:?}", other.map(|_| ())),
        }
        assert_eq!(local.head_oid(), before, "the pull mutated the repository");
    }

    /// The half the aborted transfer cannot cover: a fetch that finished just
    /// inside the deadline leaves the merge to start just outside it. Nothing
    /// is left to download here, so the transfer callback never runs and the
    /// deadline check before merge_analysis is the only thing standing between
    /// the user's timeout error and a working tree rewritten behind it.
    #[test]
    fn test_pull_past_its_deadline_does_not_merge_an_already_fetched_commit() {
        let (upstream, local, branch) = pull_fixture();
        upstream.create_commit("second", &[("b.txt", "b")]);
        // Bring the remote-tracking ref (and its objects) over first, so the
        // pull's own fetch has nothing to transfer and runs to completion.
        fetch_internal(
            &local.path_str(),
            "origin",
            false,
            None,
            None,
            TransferMonitor::disabled(),
        )
        .expect("pre-fetch");
        let before = local.head_oid();
        assert_ne!(before, upstream.head_oid(), "fixture must be behind");

        let result = pull_with_deadline(
            &local,
            &branch,
            Some(Instant::now() - Duration::from_secs(1)),
        );

        // AfterChange, not a plain timeout: the fetch above already wrote the
        // remote-tracking refs, so this outcome must still reach the late
        // reporter (await_remote_task suppresses a plain OperationTimeout).
        match result {
            Err(GitnadoError::OperationTimeoutAfterChange(m)) => {
                assert_eq!(m, "Pull operation timed out");
            }
            other => panic!("expected a Pull timeout, got {:?}", other.map(|_| ())),
        }
        assert_eq!(
            local.head_oid(),
            before,
            "the merge ran after the caller was told the pull timed out"
        );
        assert!(!local.path.join("b.txt").exists());
    }

    /// Guard against overreach: a deadline still ahead of us must not stop a
    /// healthy pull.
    #[test]
    fn test_pull_within_its_deadline_still_fast_forwards() {
        let (upstream, local, branch) = pull_fixture();
        upstream.create_commit("second", &[("b.txt", "b")]);

        let (remote, message) = pull_with_deadline(
            &local,
            &branch,
            Some(Instant::now() + Duration::from_secs(60)),
        )
        .expect("pull within its deadline must succeed");

        assert_eq!(remote, "origin");
        assert_eq!(message, "Fast-forward merge completed");
        assert_eq!(local.head_oid(), upstream.head_oid());
    }

    /// Timeout disabled: no deadline at all is not a passed deadline.
    #[test]
    fn test_pull_with_no_deadline_fast_forwards() {
        let (upstream, local, branch) = pull_fixture();
        upstream.create_commit("second", &[("b.txt", "b")]);

        let (_, message) =
            pull_with_deadline(&local, &branch, None).expect("pull with no deadline must succeed");

        assert_eq!(message, "Fast-forward merge completed");
        assert_eq!(local.head_oid(), upstream.head_oid());
    }

    // ---- pull's rebase arm ----

    fn pull_rebase(local: &TestRepo, branch: &str) -> Result<(String, String)> {
        pull_branch(
            &local.path_str(),
            Some("origin".to_string()),
            Some(branch.to_string()),
            Some(true),
            None,
            None,
            TransferMonitor::disabled(),
        )
    }

    /// The bug, on the path most users hit it: your patch landed upstream, so
    /// replaying your own copy of it produces nothing and libgit2 reports
    /// GIT_EAPPLIED. The pull used to abort the whole rebase with "this patch
    /// has already been applied"; it must skip that one commit and keep the
    /// rest.
    #[test]
    fn test_pull_rebase_skips_a_local_commit_already_applied_upstream() {
        let (upstream, local, branch) = pull_fixture();
        upstream.create_commit(
            "upstream took the shared change",
            &[("shared.txt", "shared\n")],
        );
        // The same patch as a distinct local commit, plus work only we have.
        local.create_commit("local shared change", &[("shared.txt", "shared\n")]);
        local.create_commit("local only", &[("local.txt", "local\n")]);

        let (_, message) = pull_rebase(&local, &branch)
            .expect("an already-applied local commit must be skipped, not abort the pull");

        assert_eq!(
            message,
            "Rebased 1 commit(s), skipped 1 already applied upstream"
        );
        let repo = local.repo();
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.message().unwrap(), "local only");
        assert_eq!(head.parent(0).unwrap().id(), upstream.head_oid());
        assert_eq!(
            std::fs::read_to_string(local.path.join("shared.txt")).unwrap(),
            "shared\n"
        );
        assert_eq!(
            std::fs::read_to_string(local.path.join("local.txt")).unwrap(),
            "local\n"
        );
    }

    /// Every local commit already upstream: the branch still moves to the
    /// remote tip, so the message must not be the bare "Rebased 0 commit(s)" —
    /// in a GUI it is the only feedback the user gets for commits disappearing
    /// from their branch.
    #[test]
    fn test_pull_rebase_reports_when_every_local_commit_was_already_upstream() {
        let (upstream, local, branch) = pull_fixture();
        upstream.create_commit(
            "upstream took the shared change",
            &[("shared.txt", "shared\n")],
        );
        local.create_commit("local shared change", &[("shared.txt", "shared\n")]);

        let (_, message) =
            pull_rebase(&local, &branch).expect("a fully already-applied pull must succeed");

        assert_eq!(
            message,
            "Rebased 0 commit(s), skipped 1 already applied upstream"
        );
        assert_eq!(local.head_oid(), upstream.head_oid());
        assert_eq!(local.repo().state(), git2::RepositoryState::Clean);
    }

    /// A pull --rebase that stops on a conflict reports RebaseConflict, not a
    /// message — so the commits it already dropped had nowhere to go. They are
    /// handed to the continue_rebase that finishes the rebase, which reports
    /// the total to the conflict dialog.
    #[tokio::test]
    async fn test_pull_rebase_carries_its_skips_across_a_conflict() {
        let (upstream, local, branch) = pull_fixture();
        upstream.create_commit(
            "upstream took the shared change",
            &[("shared.txt", "shared\n")],
        );
        upstream.create_commit("upstream edits contested", &[("contested.txt", "theirs\n")]);
        // The same patch as a distinct local commit — dropped before the stop.
        local.create_commit("local shared change", &[("shared.txt", "shared\n")]);
        local.create_commit("local edits contested", &[("contested.txt", "ours\n")]);

        let err = pull_rebase(&local, &branch).expect_err("the pull must stop on the conflict");
        assert!(matches!(err, GitnadoError::RebaseConflict), "{:?}", err);

        crate::commands::merge::resolve_conflict(
            local.path_str(),
            "contested.txt".to_string(),
            "resolved\n".to_string(),
            None,
        )
        .await
        .unwrap();

        let skipped = crate::commands::merge::continue_rebase(local.path_str())
            .await
            .expect("the resolved pull must finish");

        assert_eq!(
            skipped, 1,
            "the commit the pull dropped before the conflict must still be reported"
        );
        assert_eq!(local.repo().state(), git2::RepositoryState::Clean);
    }

    /// The other arm of the same libgit2 error: a commit that was ALREADY
    /// empty before the pull is not an already-applied patch, and git keeps
    /// it. It must be recreated on the rebased HEAD and counted as rebased.
    #[test]
    fn test_pull_rebase_preserves_a_local_commit_that_started_empty() {
        let (upstream, local, branch) = pull_fixture();
        upstream.create_commit("upstream change", &[("up.txt", "up\n")]);
        let empty_oid = {
            let repo = local.repo();
            let head = repo.head().unwrap().peel_to_commit().unwrap();
            let tree = head.tree().unwrap();
            let signature = repo.signature().unwrap();
            repo.commit(
                Some("HEAD"),
                &signature,
                &signature,
                "Intentional empty marker",
                &tree,
                &[&head],
            )
            .unwrap()
        };
        local.create_commit("local follow-up", &[("local.txt", "local\n")]);

        let (_, message) = pull_rebase(&local, &branch)
            .expect("a commit that started empty must survive the pull");

        assert_eq!(message, "Rebased 2 commit(s)");
        let repo = local.repo();
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.message().unwrap(), "local follow-up");
        let empty = head.parent(0).unwrap();
        assert_ne!(
            empty.id(),
            empty_oid,
            "the empty commit must be replayed onto the upstream tip"
        );
        assert_eq!(empty.message().unwrap(), "Intentional empty marker");
        assert_eq!(empty.tree_id(), empty.parent(0).unwrap().tree_id());
        assert_eq!(empty.parent(0).unwrap().id(), upstream.head_oid());
    }

    /// Skipping empty patches must not swallow a real conflict: that one still
    /// stops the loop and leaves the rebase state in place for the UI's
    /// resolve flow.
    #[test]
    fn test_pull_rebase_conflict_keeps_the_rebase_state() {
        let (upstream, local, branch) = pull_fixture();
        upstream.create_commit("upstream edit", &[("conflict.txt", "upstream\n")]);
        local.create_commit("local edit", &[("conflict.txt", "local\n")]);

        let err = pull_rebase(&local, &branch)
            .expect_err("a conflicting rebase pull must report the conflict");

        assert!(
            matches!(err, GitnadoError::RebaseConflict),
            "unexpected error: {}",
            err
        );
        assert_eq!(local.repo().state(), git2::RepositoryState::RebaseMerge);
    }

    // ---- pull strategy comes from git config ----

    /// Sets a config value on the repo and reads back what pull would do.
    fn rebase_decision(repo: &TestRepo, keys: &[(&str, &str)], branch: &str) -> bool {
        let git_repo = repo.repo();
        {
            let mut config = git_repo.config().unwrap();
            for (key, value) in keys {
                config.set_str(key, value).unwrap();
            }
        }
        pull_should_rebase(&git_repo, branch)
    }

    /// Defaulting to merge meant a user with pull.rebase=true silently got a
    /// merge commit from every diverged pull — the opposite of what `git pull`
    /// does in their terminal.
    #[test]
    fn test_pull_rebase_config_is_honoured() {
        let repo = TestRepo::with_initial_commit();
        assert!(rebase_decision(&repo, &[("pull.rebase", "true")], "main"));
    }

    /// Absent config means merge, git's default.
    #[test]
    fn test_pull_defaults_to_merge_without_config() {
        let repo = TestRepo::with_initial_commit();
        assert!(!pull_should_rebase(&repo.repo(), "main"));
    }

    /// branch.<name>.rebase overrides pull.rebase, in both directions.
    #[test]
    fn test_branch_rebase_overrides_pull_rebase() {
        let repo = TestRepo::with_initial_commit();
        assert!(rebase_decision(
            &repo,
            &[("pull.rebase", "false"), ("branch.main.rebase", "true")],
            "main"
        ));

        let repo = TestRepo::with_initial_commit();
        assert!(!rebase_decision(
            &repo,
            &[("pull.rebase", "true"), ("branch.main.rebase", "false")],
            "main"
        ));
    }

    /// The override is per branch: another branch's setting must not apply.
    #[test]
    fn test_branch_rebase_does_not_leak_to_other_branches() {
        let repo = TestRepo::with_initial_commit();
        assert!(!rebase_decision(
            &repo,
            &[("branch.feature.rebase", "true")],
            "main"
        ));
    }

    /// git accepts more than a boolean here, and all of these mean rebase.
    #[test]
    fn test_non_boolean_rebase_values_mean_rebase() {
        for value in ["interactive", "merges", "preserve"] {
            let repo = TestRepo::with_initial_commit();
            assert!(
                rebase_decision(&repo, &[("pull.rebase", value)], "main"),
                "pull.rebase={} should rebase",
                value
            );
        }
    }

    /// An unrecognised value is treated as unset rather than failing the pull,
    /// and must fall through to the next level.
    #[test]
    fn test_unrecognised_branch_value_falls_through_to_pull_rebase() {
        let repo = TestRepo::with_initial_commit();
        assert!(rebase_decision(
            &repo,
            &[("pull.rebase", "true"), ("branch.main.rebase", "nonsense")],
            "main"
        ));
    }

    // ---- fast-forward pull must not overwrite uncommitted work ----

    /// Build a repo whose `main` is one commit behind `refs/heads/incoming`,
    /// where the incoming commit touches `tracked.txt`.
    fn repo_behind_by_one() -> (TestRepo, git2::Oid) {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("base", &[("tracked.txt", "base\n")]);
        let base = test_repo
            .repo()
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id();

        let incoming = test_repo.create_commit("incoming", &[("tracked.txt", "incoming\n")]);
        let repo = test_repo.repo();
        repo.reference("refs/heads/incoming", incoming, true, "test")
            .unwrap();

        // Put main (and the working tree) back on `base`.
        let branch = repo.head().unwrap().shorthand().unwrap().to_string();
        let refname = format!("refs/heads/{}", branch);
        repo.find_reference(&refname)
            .unwrap()
            .set_target(base, "test")
            .unwrap();
        repo.set_head(&refname).unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
            .unwrap();

        (test_repo, incoming)
    }

    #[test]
    fn test_fast_forward_refuses_when_a_touched_file_is_dirty() {
        let (test_repo, incoming) = repo_behind_by_one();
        // Uncommitted edit to the very file the incoming commit changes.
        test_repo.create_file("tracked.txt", "my unsaved work\n");

        let repo = test_repo.repo();
        let refname = format!("refs/heads/{}", repo.head().unwrap().shorthand().unwrap());
        let before = repo.head().unwrap().peel_to_commit().unwrap().id();

        let err = fast_forward_to(&repo, &refname, incoming)
            .expect_err("a forced checkout would have destroyed the edit");
        let message = err.to_string();
        assert!(
            message.contains("would be overwritten") && message.contains("tracked.txt"),
            "the error must name the file, got: {}",
            message
        );

        assert_eq!(
            std::fs::read_to_string(test_repo.path.join("tracked.txt")).unwrap(),
            "my unsaved work\n",
            "the uncommitted edit is in no git object — losing it is unrecoverable"
        );
        assert_eq!(
            test_repo
                .repo()
                .head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .id(),
            before,
            "the branch must not move when the checkout was refused"
        );
    }

    #[test]
    fn test_fast_forward_succeeds_with_a_clean_tree() {
        let (test_repo, incoming) = repo_behind_by_one();
        let repo = test_repo.repo();
        let refname = format!("refs/heads/{}", repo.head().unwrap().shorthand().unwrap());

        fast_forward_to(&repo, &refname, incoming).expect("clean tree fast-forwards");

        assert_eq!(
            test_repo
                .repo()
                .head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .id(),
            incoming
        );
        assert_eq!(
            std::fs::read_to_string(test_repo.path.join("tracked.txt")).unwrap(),
            "incoming\n"
        );
    }

    #[test]
    fn test_fast_forward_keeps_an_unrelated_dirty_file() {
        let (test_repo, incoming) = repo_behind_by_one();
        // Dirty, but not a file the incoming commit touches — git allows this.
        test_repo.create_commit("other", &[("other.txt", "committed\n")]);
        let repo = test_repo.repo();
        let refname = format!("refs/heads/{}", repo.head().unwrap().shorthand().unwrap());
        // Re-point main back to the base of the incoming commit.
        let base = repo.find_commit(incoming).unwrap().parent(0).unwrap().id();
        repo.find_reference(&refname)
            .unwrap()
            .set_target(base, "test")
            .unwrap();
        repo.set_head(&refname).unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
            .unwrap();
        test_repo.create_file("other.txt", "uncommitted\n");

        fast_forward_to(&test_repo.repo(), &refname, incoming)
            .expect("an unrelated dirty file must not block the fast-forward");

        assert_eq!(
            std::fs::read_to_string(test_repo.path.join("other.txt")).unwrap(),
            "uncommitted\n",
            "the unrelated edit survives"
        );
    }

    #[test]
    fn test_fast_forward_aborts_before_touching_the_tree_when_the_ref_is_missing() {
        // On a detached HEAD, pull used to rebuild the refname from
        // shorthand() — "refs/heads/HEAD" — and only look it up AFTER the
        // checkout had already rewritten the working tree. HEAD stayed on the
        // tag while every tracked file held the incoming content, so the whole
        // diverging file set showed up as uncommitted modifications.
        let (test_repo, incoming) = repo_behind_by_one();
        let before = std::fs::read_to_string(test_repo.path.join("tracked.txt")).unwrap();
        let head_before = test_repo
            .repo()
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id();

        fast_forward_to(&test_repo.repo(), "refs/heads/HEAD", incoming)
            .expect_err("a missing ref must abort the fast-forward");

        assert_eq!(
            std::fs::read_to_string(test_repo.path.join("tracked.txt")).unwrap(),
            before,
            "the working tree must be untouched when the ref lookup fails"
        );
        assert_eq!(
            test_repo
                .repo()
                .head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .id(),
            head_before
        );
    }

    // ---- pull must not clobber an unresolved operation ----

    /// A second git2 merge on top of an unresolved one errors out, but as a
    /// side effect deletes MERGE_HEAD and flips state() back to Clean while
    /// the index still holds the conflicted entries — after which abort_merge
    /// refuses ("no merge to abort") and the conflicted index still blocks a
    /// commit. This locks in the refusal that keeps that from happening.
    #[test]
    fn test_pull_refuses_while_a_merge_is_unresolved() {
        let t = TestRepo::with_initial_commit();
        t.create_commit("base", &[("f.txt", "base\n")]);
        let repo = t.repo();
        let base = repo.head().unwrap().peel_to_commit().unwrap().id();
        let main_ref = repo.head().unwrap().name().unwrap().to_string();

        repo.branch("side", &repo.find_commit(base).unwrap(), false)
            .unwrap();
        t.create_commit("main side", &[("f.txt", "main\n")]);

        repo.set_head("refs/heads/side").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
            .unwrap();
        t.create_commit("other side", &[("f.txt", "side\n")]);
        let side_oid = t.repo().head().unwrap().peel_to_commit().unwrap().id();

        let repo = t.repo();
        repo.set_head(&main_ref).unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
            .unwrap();

        // Conflicting merge, left unresolved — what the conflict dialog shows.
        let annotated = repo.find_annotated_commit(side_oid).unwrap();
        let _ = repo.merge(&[&annotated], None, None);
        assert_eq!(repo.state(), git2::RepositoryState::Merge);
        assert!(repo.index().unwrap().has_conflicts());

        let err = ensure_pullable(&t.path).expect_err("pull must refuse mid-merge");
        assert!(
            err.to_string().contains("not concluded your merge"),
            "unexpected error: {}",
            err
        );

        // The recovery path is still intact.
        assert_eq!(t.repo().state(), git2::RepositoryState::Merge);
        assert!(t.path.join(".git/MERGE_HEAD").exists());
    }

    #[test]
    fn test_pull_is_allowed_on_a_clean_repo() {
        let t = TestRepo::with_initial_commit();
        ensure_pullable(&t.path).expect("a clean repo must be pullable");
    }

    /// Push must honour branch.<n>.pushRemote and remote.pushDefault.
    ///
    /// In the fork workflow (origin = your fork, upstream = canonical, main
    /// tracking upstream/main, pushDefault=origin) reading only
    /// branch.<n>.remote sent a FORCE PUSH at the canonical repository — with a
    /// confirm that names no remote at all. The hard-coded "origin" this
    /// replaced was correct there, so getting it half-right was a regression.
    #[cfg(unix)]
    #[test]
    fn test_resolve_push_remote_honours_push_default() {
        let repo_dir = TestRepo::with_initial_commit();
        let repo = repo_dir.repo();
        let branch = repo_dir.current_branch();
        repo_dir.add_remote("origin", "https://example.test/fork.git");
        repo_dir.add_remote("upstream", "https://example.test/canonical.git");

        // main tracks upstream/main ...
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str(&format!("branch.{}.remote", branch), "upstream")
                .unwrap();
            cfg.set_str(
                &format!("branch.{}.merge", branch),
                &format!("refs/heads/{}", branch),
            )
            .unwrap();
        }

        assert_eq!(
            resolve_push_remote(&repo, None),
            "upstream",
            "with no push config, the tracking remote is right"
        );

        // ... but pushes go to the fork.
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("remote.pushDefault", "origin").unwrap();
        }
        assert_eq!(
            resolve_push_remote(&repo, None),
            "origin",
            "remote.pushDefault must win over the tracking remote"
        );

        // The per-branch override wins over both.
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str(&format!("branch.{}.pushRemote", branch), "upstream")
                .unwrap();
        }
        assert_eq!(
            resolve_push_remote(&repo, None),
            "upstream",
            "branch.<n>.pushRemote must win over remote.pushDefault"
        );

        assert_eq!(
            resolve_push_remote(&repo, Some("chosen".to_string())),
            "chosen",
            "an explicit remote still wins over everything"
        );
    }

    #[test]
    fn test_resolve_fetch_remote_uses_the_checked_out_branch_upstream() {
        let repo_dir = TestRepo::with_initial_commit();
        let branch = repo_dir.current_branch();
        repo_dir.add_remote("origin", "https://example.test/origin.git");
        repo_dir.add_remote("upstream", "https://example.test/upstream.git");
        let repo = repo_dir.repo();
        let mut config = repo.config().unwrap();
        config
            .set_str(&format!("branch.{}.remote", branch), "upstream")
            .unwrap();
        config
            .set_str(
                &format!("branch.{}.merge", branch),
                &format!("refs/heads/{}", branch),
            )
            .unwrap();

        assert_eq!(resolve_fetch_remote(&repo, None), "upstream");
    }

    #[test]
    fn test_resolve_fetch_remote_uses_the_only_configured_remote() {
        let repo_dir = TestRepo::with_initial_commit();
        repo_dir.add_remote("mirror", "https://example.test/mirror.git");

        assert_eq!(resolve_fetch_remote(&repo_dir.repo(), None), "mirror");
    }

    #[test]
    fn test_resolve_fetch_remote_ignores_local_branch_upstream() {
        let repo_dir = TestRepo::with_initial_commit();
        repo_dir.add_remote("origin", "https://example.test/origin.git");
        let branch = repo_dir.current_branch();
        let mut config = repo_dir.repo().config().unwrap();
        config
            .set_str(&format!("branch.{branch}.remote"), ".")
            .unwrap();
        config
            .set_str(&format!("branch.{branch}.merge"), "refs/heads/main")
            .unwrap();

        assert_eq!(resolve_fetch_remote(&repo_dir.repo(), None), "origin");
    }

    #[test]
    fn test_resolve_fetch_remote_ignores_missing_upstream_remote() {
        let repo_dir = TestRepo::with_initial_commit();
        repo_dir.add_remote("mirror", "https://example.test/mirror.git");
        let branch = repo_dir.current_branch();
        let mut config = repo_dir.repo().config().unwrap();
        config
            .set_str(&format!("branch.{branch}.remote"), "deleted")
            .unwrap();
        config
            .set_str(&format!("branch.{branch}.merge"), "refs/heads/main")
            .unwrap();

        assert_eq!(resolve_fetch_remote(&repo_dir.repo(), None), "mirror");
    }

    #[tokio::test]
    async fn test_get_push_remote_returns_the_resolved_destination() {
        let repo_dir = TestRepo::with_initial_commit();
        repo_dir.add_remote("upstream", "https://example.test/repo.git");

        let remote = get_push_remote(repo_dir.path_str(), None)
            .await
            .expect("the sole remote should resolve");

        assert_eq!(remote, "upstream");
    }

    /// A repo with NO remotes resolves to the "origin" default, which does not
    /// exist. Returning it anyway would send the UI on to push_tag and surface
    /// "Remote not found: origin" from the push instead of from the lookup the
    /// callers gate on.
    #[tokio::test]
    async fn test_get_push_remote_errors_when_the_repo_has_no_remotes() {
        let repo_dir = TestRepo::with_initial_commit();

        let err = get_push_remote(repo_dir.path_str(), None)
            .await
            .expect_err("a repo with no remotes has no push destination");

        assert!(
            matches!(err, GitnadoError::RemoteNotFound(ref name) if name == "origin"),
            "the missing destination is named: {err:?}"
        );
    }

    /// remote.pushDefault can outlive the remote it names (renamed, removed).
    /// The resolver happily returns the stale name, so the existence check is
    /// the only thing standing between the user and a confirm dialog naming a
    /// remote that is not there.
    #[tokio::test]
    async fn test_get_push_remote_errors_when_the_configured_default_is_gone() {
        let repo_dir = TestRepo::with_initial_commit();
        repo_dir.add_remote("origin", "https://example.test/repo.git");
        {
            let repo = git2::Repository::open(&repo_dir.path).unwrap();
            let mut cfg = repo.config().unwrap();
            cfg.set_str("remote.pushDefault", "nope").unwrap();
        }

        let err = get_push_remote(repo_dir.path_str(), None)
            .await
            .expect_err("a pushDefault naming a missing remote must not resolve");

        assert!(
            matches!(err, GitnadoError::RemoteNotFound(ref name) if name == "nope"),
            "the missing destination is named: {err:?}"
        );
    }

    /// Pull must follow the branch's CONFIGURED upstream, not "origin/<name>".
    ///
    /// In the standard fork workflow (origin = your fork, upstream = canonical,
    /// main tracking upstream/main) the rebuilt form fetched and merged the
    /// FORK's branch while the sidebar showed the branch tracking
    /// upstream/main — a working-tree and ref mutation against a ref the user
    /// never chose.
    #[cfg(unix)]
    #[test]
    fn test_resolve_pull_target_follows_the_configured_upstream() {
        let root = tempfile::tempdir().unwrap();
        let canonical = root.path().join("canonical.git");
        let work = root.path().join("work");
        git2::Repository::init_bare(&canonical).unwrap();

        let out = crate::utils::create_command("git")
            .arg("clone")
            .arg(&canonical)
            .arg(&work)
            .output()
            .unwrap();
        assert!(out.status.success());
        git_in(&work, &["config", "user.email", "u@test"]);
        git_in(&work, &["config", "user.name", "u"]);
        std::fs::write(work.join("f.txt"), "base\n").unwrap();
        git_in(&work, &["add", "f.txt"]);
        git_in(&work, &["commit", "-m", "base"]);
        git_in(&work, &["branch", "-M", "main"]);
        git_in(&work, &["push", "-u", "origin", "main"]);

        // Rename the remote away from `origin` — the app's own Remote dialog
        // can do exactly this, and `git clone -o upstream` starts here.
        git_in(&work, &["remote", "rename", "origin", "upstream"]);

        let repo = git2::Repository::open(&work).unwrap();
        let (remote, remote_ref) = resolve_pull_target(&repo, None, "main", "refs/heads/main");

        assert_eq!(
            remote, "upstream",
            "must follow the configured upstream remote"
        );
        assert_eq!(remote_ref, "upstream/main", "and its actual tracking ref");
    }

    /// With no upstream configured at all, fall back to origin as before.
    #[cfg(unix)]
    #[test]
    fn test_resolve_pull_target_falls_back_to_origin() {
        let repo_dir = TestRepo::with_initial_commit();
        let repo = repo_dir.repo();
        let branch = repo_dir.current_branch();
        let (remote, remote_ref) =
            resolve_pull_target(&repo, None, &branch, &format!("refs/heads/{}", branch));
        assert_eq!(remote, "origin");
        assert_eq!(remote_ref, format!("origin/{}", branch));
    }

    /// An explicit remote from the caller still wins.
    #[cfg(unix)]
    #[test]
    fn test_resolve_pull_target_honours_an_explicit_remote() {
        let repo_dir = TestRepo::with_initial_commit();
        let repo = repo_dir.repo();
        let branch = repo_dir.current_branch();
        let (remote, _) = resolve_pull_target(
            &repo,
            Some("chosen".to_string()),
            &branch,
            &format!("refs/heads/{}", branch),
        );
        assert_eq!(remote, "chosen");
    }

    // ---- get_pull_remote / get_push_remote ----
    //
    // The frontend's offline/allowlist gate and its credential scoping both
    // have to know which remote an operation will REACH before it runs. They
    // used to assume "origin"; in the ordinary fork layout that checked the
    // allowlist against the fork's host and offered the fork's token to the
    // upstream's. These commands answer the same question the pull/push paths
    // answer, without touching the network.

    /// A repo with two remotes whose branch tracks the NON-origin one.
    #[cfg(unix)]
    fn repo_tracking_upstream() -> (TestRepo, String) {
        let repo_dir = TestRepo::with_initial_commit();
        repo_dir.add_remote("origin", "https://github.com/me/app.git");
        repo_dir.add_remote("upstream", "https://gitlab.example.test/acme/app.git");
        let branch = repo_dir.current_branch();
        let mut config = repo_dir.repo().config().unwrap();
        config
            .set_str(&format!("branch.{branch}.remote"), "upstream")
            .unwrap();
        config
            .set_str(
                &format!("branch.{branch}.merge"),
                &format!("refs/heads/{branch}"),
            )
            .unwrap();
        drop(config);
        (repo_dir, branch)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_get_pull_remote_follows_the_branch_upstream() {
        let (repo_dir, _) = repo_tracking_upstream();
        let remote = get_pull_remote(repo_dir.path.to_string_lossy().to_string(), None, None)
            .await
            .unwrap();
        assert_eq!(remote, "upstream", "a pull follows the branch's upstream");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_get_pull_remote_falls_back_to_origin() {
        let repo_dir = TestRepo::with_initial_commit();
        repo_dir.add_remote("origin", "https://github.com/me/app.git");
        let remote = get_pull_remote(repo_dir.path.to_string_lossy().to_string(), None, None)
            .await
            .unwrap();
        assert_eq!(remote, "origin");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_get_pull_remote_honours_an_explicit_remote() {
        let (repo_dir, _) = repo_tracking_upstream();
        let remote = get_pull_remote(
            repo_dir.path.to_string_lossy().to_string(),
            Some("origin".to_string()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(remote, "origin");
    }

    /// A configured upstream whose remote was deleted must be reported, not
    /// silently downgraded to origin — the gate would then approve a host the
    /// pull is never going to reach anyway.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_get_pull_remote_rejects_a_missing_remote() {
        let repo_dir = TestRepo::with_initial_commit();
        repo_dir.add_remote("origin", "https://github.com/me/app.git");
        let branch = repo_dir.current_branch();
        let mut config = repo_dir.repo().config().unwrap();
        config
            .set_str(&format!("branch.{branch}.remote"), "deleted")
            .unwrap();
        drop(config);

        let err = get_pull_remote(repo_dir.path.to_string_lossy().to_string(), None, None)
            .await
            .unwrap_err();
        assert!(matches!(err, GitnadoError::RemoteNotFound(name) if name == "deleted"));
    }

    /// Detached HEAD: `pull_branch` refuses outright, so this must too rather
    /// than inventing a remote for an operation that cannot run.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_get_pull_remote_refuses_a_detached_head() {
        let repo_dir = TestRepo::with_initial_commit();
        repo_dir.add_remote("origin", "https://github.com/me/app.git");
        let oid = repo_dir.head_oid();
        repo_dir.repo().set_head_detached(oid).unwrap();

        assert!(
            get_pull_remote(repo_dir.path.to_string_lossy().to_string(), None, None)
                .await
                .is_err()
        );
    }

    /// Push follows remote.pushDefault ahead of the branch's upstream — the
    /// fork case where a pull and a push reach DIFFERENT hosts.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_get_push_remote_honours_push_default() {
        let (repo_dir, _) = repo_tracking_upstream();
        let mut config = repo_dir.repo().config().unwrap();
        config.set_str("remote.pushDefault", "origin").unwrap();
        drop(config);

        let path = repo_dir.path.to_string_lossy().to_string();
        assert_eq!(
            get_push_remote(path.clone(), None).await.unwrap(),
            "origin",
            "a push follows pushDefault"
        );
        assert_eq!(
            get_pull_remote(path, None, None).await.unwrap(),
            "upstream",
            "while the pull still follows the upstream"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_get_push_remote_rejects_a_missing_remote() {
        let repo_dir = TestRepo::with_initial_commit();
        repo_dir.add_remote("origin", "https://github.com/me/app.git");
        let mut config = repo_dir.repo().config().unwrap();
        config.set_str("remote.pushDefault", "gone").unwrap();
        drop(config);

        let err = get_push_remote(repo_dir.path.to_string_lossy().to_string(), None)
            .await
            .unwrap_err();
        assert!(matches!(err, GitnadoError::RemoteNotFound(name) if name == "gone"));
    }

    // ---- pull's normal-merge arm (merge_fetched_commit) ----

    /// A repo whose checked-out branch and `refs/remotes/origin/<branch>` have
    /// diverged with NON-conflicting changes — the shape that reaches pull's
    /// normal-merge arm. Returns the repo, the branch name and the remote tip.
    fn repo_diverged_from_origin() -> (TestRepo, String, git2::Oid) {
        let test_repo = TestRepo::with_initial_commit();
        let branch = test_repo.current_branch();
        test_repo.create_commit("base", &[("base.txt", "base\n")]);
        let base = test_repo.head_oid();

        // The remote side: a commit touching a file the local side never has.
        let remote_tip = test_repo.create_commit("remote change", &[("remote.txt", "remote\n")]);
        test_repo.create_remote_branch(&branch, remote_tip);

        // Rewind the branch (and the working tree) to `base`, then diverge
        // locally on a different file.
        {
            let repo = test_repo.repo();
            let refname = format!("refs/heads/{}", branch);
            repo.find_reference(&refname)
                .unwrap()
                .set_target(base, "test")
                .unwrap();
            repo.set_head(&refname).unwrap();
            repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
                .unwrap();
        }
        let _ = std::fs::remove_file(test_repo.path.join("remote.txt"));
        test_repo.create_commit("local change", &[("local.txt", "local\n")]);

        (test_repo, branch, remote_tip)
    }

    fn merge_origin(test_repo: &TestRepo, branch: &str) -> Result<()> {
        let repo = test_repo.repo();
        let remote_ref = format!("origin/{}", branch);
        let fetch_head = repo
            .find_reference(&format!("refs/remotes/{}", remote_ref))
            .unwrap();
        let fetch_commit = repo.reference_to_annotated_commit(&fetch_head).unwrap();
        merge_fetched_commit(&repo, &fetch_commit, &remote_ref, branch)
    }

    /// The happy path: a real two-parent merge commit, and the state cleaned up.
    #[test]
    fn test_pull_merge_creates_a_two_parent_commit() {
        let (test_repo, branch, remote_tip) = repo_diverged_from_origin();
        let local_tip = test_repo.head_oid();

        merge_origin(&test_repo, &branch).expect("a non-conflicting merge must succeed");

        let repo = test_repo.repo();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 2, "a merge commit has two parents");
        assert_eq!(head.parent_id(0).unwrap(), local_tip);
        assert_eq!(head.parent_id(1).unwrap(), remote_tip);
        assert_eq!(
            head.message().unwrap(),
            format!("Merge origin/{} into {}", branch, branch)
        );
        assert_eq!(
            repo.state(),
            git2::RepositoryState::Clean,
            "a completed merge must leave no merge state"
        );
        // Both sides' content is present.
        assert!(test_repo.path.join("local.txt").exists());
        assert!(test_repo.path.join("remote.txt").exists());
    }

    /// A `pre-merge-commit` veto must leave the merge RESUMABLE: MERGE_HEAD on
    /// disk, state() == Merge, and abort_merge still able to undo it.
    ///
    /// This is the bug a `cleanup_state()` on the failure path caused — it
    /// unlinks MERGE_HEAD while repo.merge() has already written the merged
    /// result into the index and tree, so the merge is fully applied but
    /// unmarked: the banner disappears, abort_merge refuses "no merge to
    /// abort", and the whole diff sits staged under a failure toast.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_pull_merge_veto_leaves_the_merge_resumable() {
        let (test_repo, branch, _) = repo_diverged_from_origin();
        test_repo.install_hook(
            "pre-merge-commit",
            "#!/bin/sh\necho policy says no\nexit 1\n",
        );
        let head_before = test_repo.head_oid();

        let err = merge_origin(&test_repo, &branch).expect_err("the hook must veto the merge");
        assert!(
            err.to_string().contains("pre-merge-commit"),
            "the error must name the hook that vetoed: {}",
            err
        );

        assert_eq!(
            test_repo.head_oid(),
            head_before,
            "a vetoed merge must not commit"
        );
        assert!(
            test_repo.path.join(".git/MERGE_HEAD").exists(),
            "MERGE_HEAD must survive so the merge stays resumable"
        );
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Merge);

        // The app's only recovery action must still work.
        crate::commands::merge::abort_merge(test_repo.path_str())
            .await
            .expect("abort_merge must still be able to undo the vetoed merge");
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);
    }

    /// A `commit-msg` veto must behave the same way — resumable, uncommitted.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_pull_merge_commit_msg_veto_leaves_the_merge_resumable() {
        let (test_repo, branch, _) = repo_diverged_from_origin();
        test_repo.install_hook("commit-msg", "#!/bin/sh\necho bad message\nexit 1\n");
        let head_before = test_repo.head_oid();

        let err = merge_origin(&test_repo, &branch).expect_err("the hook must veto the merge");
        assert!(
            err.to_string().contains("commit-msg"),
            "the error must name the hook that vetoed: {}",
            err
        );
        assert_eq!(test_repo.head_oid(), head_before);
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Merge);
        crate::commands::merge::abort_merge(test_repo.path_str())
            .await
            .expect("abort_merge must still work after a commit-msg veto");
    }

    /// `commit-msg` may REWRITE the message in place (a Gerrit Change-Id hook
    /// is the canonical example). The rewritten message is the one that must be
    /// committed — a hook that is merely invoked and then ignored enforces
    /// nothing.
    #[cfg(unix)]
    #[test]
    fn test_pull_merge_commits_the_message_the_commit_msg_hook_rewrote() {
        let (test_repo, branch, _) = repo_diverged_from_origin();
        test_repo.install_hook(
            "commit-msg",
            "#!/bin/sh\nprintf 'rewritten by the hook\\n\\nChange-Id: I1234\\n' > \"$1\"\n",
        );

        merge_origin(&test_repo, &branch).expect("the merge must succeed");

        let repo = test_repo.repo();
        let message = repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .message()
            .unwrap()
            .to_string();
        assert!(
            message.contains("rewritten by the hook") && message.contains("Change-Id: I1234"),
            "the hook's rewritten message must be the committed one, got: {:?}",
            message
        );
        assert!(
            !message.starts_with("Merge origin/"),
            "the default message must have been replaced, got: {:?}",
            message
        );
    }

    /// The hooks must run in git's order: pre-merge-commit, then commit-msg.
    /// A commit-msg hook that ran first would see a message the merge policy
    /// had not yet approved.
    #[cfg(unix)]
    #[test]
    fn test_pull_merge_runs_the_hooks_in_gits_order() {
        let (test_repo, branch, _) = repo_diverged_from_origin();
        let log = test_repo.path.join("hook-order.log");
        for name in ["pre-merge-commit", "commit-msg", "post-merge"] {
            test_repo.install_hook(
                name,
                &format!("#!/bin/sh\necho {} >> {}\n", name, log.to_string_lossy()),
            );
        }

        merge_origin(&test_repo, &branch).expect("the merge must succeed");

        let order = std::fs::read_to_string(&log).expect("the hooks must have run");
        let lines: Vec<&str> = order.lines().collect();
        assert_eq!(
            lines,
            vec!["pre-merge-commit", "commit-msg", "post-merge"],
            "hooks must fire in git's documented order"
        );
    }

    /// A conflicting merge returns MergeConflict with the merge state intact,
    /// so the conflict-resolution flow (and abort_merge) can take over.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_pull_merge_conflict_keeps_the_merge_state() {
        let test_repo = TestRepo::with_initial_commit();
        let branch = test_repo.current_branch();
        test_repo.create_commit("base", &[("shared.txt", "base\n")]);
        let base = test_repo.head_oid();
        let remote_tip = test_repo.create_commit("remote change", &[("shared.txt", "remote\n")]);
        test_repo.create_remote_branch(&branch, remote_tip);
        {
            let repo = test_repo.repo();
            let refname = format!("refs/heads/{}", branch);
            repo.find_reference(&refname)
                .unwrap()
                .set_target(base, "test")
                .unwrap();
            repo.set_head(&refname).unwrap();
            repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
                .unwrap();
        }
        test_repo.create_commit("local change", &[("shared.txt", "local\n")]);
        let head_before = test_repo.head_oid();

        let err = merge_origin(&test_repo, &branch).expect_err("the merge must conflict");
        assert!(matches!(err, GitnadoError::MergeConflict));
        assert_eq!(
            test_repo.head_oid(),
            head_before,
            "nothing may be committed"
        );
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Merge);
        crate::commands::merge::abort_merge(test_repo.path_str())
            .await
            .expect("abort_merge must work after a conflicted pull merge");
    }

    // ---- force push lease must survive the app's own background fetch ----

    fn git_in(dir: &std::path::Path, args: &[&str]) {
        let out = crate::utils::create_command("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git must run");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A colleague pushes, THEN the app's auto-fetch runs, THEN the user force
    /// pushes. The force push must be refused.
    ///
    /// A bare `--force-with-lease` leases against the local remote-tracking
    /// ref, and this app ships a background auto-fetch that updates exactly
    /// that ref on a timer. Without --force-if-includes the lease matched the
    /// colleague's brand-new commit and the push destroyed it — while the
    /// confirm the user had just read promised "the push is refused if the
    /// remote has moved since your last fetch".
    #[cfg(unix)]
    #[test]
    fn test_force_push_refused_after_background_fetch_moved_the_remote() {
        let root = tempfile::tempdir().unwrap();
        let origin = root.path().join("origin.git");
        let alice = root.path().join("alice");
        let bob = root.path().join("bob");
        git2::Repository::init_bare(&origin).unwrap();

        for (dir, email) in [(&alice, "alice@test"), (&bob, "bob@test")] {
            let out = crate::utils::create_command("git")
                .arg("clone")
                .arg(&origin)
                .arg(dir)
                .output()
                .unwrap();
            assert!(out.status.success());
            git_in(dir, &["config", "user.email", email]);
            git_in(dir, &["config", "user.name", email]);
        }

        // Alice publishes `main`.
        std::fs::write(alice.join("f.txt"), "1").unwrap();
        git_in(&alice, &["add", "f.txt"]);
        git_in(&alice, &["commit", "-m", "base"]);
        git_in(&alice, &["branch", "-M", "main"]);
        git_in(&alice, &["push", "-u", "origin", "main"]);
        git_in(&bob, &["fetch"]);
        git_in(&bob, &["checkout", "main"]);

        // Alice amends — the classic reason to force push.
        std::fs::write(alice.join("f.txt"), "2").unwrap();
        git_in(&alice, &["commit", "-am", "amended", "--amend"]);

        // Bob pushes work Alice has never seen.
        std::fs::write(bob.join("g.txt"), "bob").unwrap();
        git_in(&bob, &["add", "g.txt"]);
        git_in(&bob, &["commit", "-m", "bob work"]);
        git_in(&bob, &["push", "origin", "main"]);
        let bob_oid = {
            let repo = git2::Repository::open(&bob).unwrap();
            repo.refname_to_id("refs/heads/main").unwrap()
        };

        // The app's background auto-fetch ticks, updating origin/main.
        git_in(&alice, &["fetch", "origin"]);

        let result = push_via_cli(
            &alice.to_string_lossy(),
            "origin",
            "main",
            false,
            true,
            false,
            false,
            None,
            &TransferMonitor::disabled(),
        );

        assert!(
            result.is_err(),
            "the lease must refuse a remote the user has not integrated"
        );

        let origin_repo = git2::Repository::open(&origin).unwrap();
        assert_eq!(
            origin_repo.refname_to_id("refs/heads/main").unwrap(),
            bob_oid,
            "the colleague's commit must still be the remote tip"
        );
    }

    /// The legitimate case still works: amend, nobody else pushed, force push.
    #[cfg(unix)]
    #[test]
    fn test_force_push_still_succeeds_when_nobody_else_pushed() {
        let root = tempfile::tempdir().unwrap();
        let origin = root.path().join("origin.git");
        let alice = root.path().join("alice");
        git2::Repository::init_bare(&origin).unwrap();

        let out = crate::utils::create_command("git")
            .arg("clone")
            .arg(&origin)
            .arg(&alice)
            .output()
            .unwrap();
        assert!(out.status.success());
        git_in(&alice, &["config", "user.email", "alice@test"]);
        git_in(&alice, &["config", "user.name", "alice"]);

        std::fs::write(alice.join("f.txt"), "1").unwrap();
        git_in(&alice, &["add", "f.txt"]);
        git_in(&alice, &["commit", "-m", "base"]);
        git_in(&alice, &["branch", "-M", "main"]);
        git_in(&alice, &["push", "-u", "origin", "main"]);

        // An auto-fetch tick that changes nothing, then an amend.
        git_in(&alice, &["fetch", "origin"]);
        std::fs::write(alice.join("f.txt"), "2").unwrap();
        git_in(&alice, &["commit", "-am", "amended", "--amend"]);

        push_via_cli(
            &alice.to_string_lossy(),
            "origin",
            "main",
            false,
            true,
            false,
            false,
            None,
            &TransferMonitor::disabled(),
        )
        .expect("an uncontested force push must still go through");

        let alice_oid = git2::Repository::open(&alice)
            .unwrap()
            .refname_to_id("refs/heads/main")
            .unwrap();
        let origin_repo = git2::Repository::open(&origin).unwrap();
        assert_eq!(
            origin_repo.refname_to_id("refs/heads/main").unwrap(),
            alice_oid
        );
    }

    /// Force push is the ONLY route through `push_via_cli`, and it is the one
    /// path that hands a token to the git CLI. Every other test here pushes
    /// with `None`, so the token's host scoping — the part that decides whether
    /// a token-authenticated force push works at all — went uncovered.
    #[test]
    fn test_push_remote_url_prefers_the_push_url() {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://fetch-host.test/r.git");
        git_in(
            &repo.path,
            &[
                "config",
                "remote.origin.pushurl",
                "https://push-host.test/r.git",
            ],
        );

        assert_eq!(
            push_remote_url(&repo.path_str(), "origin").as_deref(),
            Some("https://push-host.test/r.git"),
            "a push contacts the pushurl's host, so the token must be scoped there"
        );

        // ...and that is the host the credential actually lands under.
        let mut cmd = crate::utils::create_command("git");
        crate::utils::apply_token_credential_helper(
            &mut cmd,
            "ghp_secret",
            &push_remote_url(&repo.path_str(), "origin").unwrap(),
        );
        let envs: std::collections::HashMap<String, String> = cmd
            .get_envs()
            .filter_map(|(k, v)| {
                Some((
                    k.to_string_lossy().to_string(),
                    v?.to_string_lossy().to_string(),
                ))
            })
            .collect();
        assert_eq!(
            envs.get("GIT_CONFIG_KEY_0").map(String::as_str),
            Some("credential.https://push-host.test.helper")
        );
        assert_eq!(
            envs.get("GITNADO_GIT_TOKEN").map(String::as_str),
            Some("ghp_secret")
        );
    }

    /// With no pushurl configured the fetch url is the one git contacts.
    #[test]
    fn test_push_remote_url_falls_back_to_the_fetch_url() {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://only-host.test/r.git");

        assert_eq!(
            push_remote_url(&repo.path_str(), "origin").as_deref(),
            Some("https://only-host.test/r.git")
        );
    }

    /// An unknown remote names no host, so nothing may be injected — a guessed
    /// scope would offer the token to a host it does not belong to.
    #[test]
    fn test_push_remote_url_is_none_for_an_unknown_remote() {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://only-host.test/r.git");

        assert!(push_remote_url(&repo.path_str(), "nope").is_none());
    }

    // ---- first push sets upstream tracking ----

    /// A repo with a local bare "origin" it can really push to.
    fn repo_with_bare_origin() -> (TestRepo, tempfile::TempDir) {
        let repo = TestRepo::with_initial_commit();
        let bare = tempfile::tempdir().unwrap();
        git2::Repository::init_bare(bare.path()).unwrap();
        repo.add_remote("origin", &bare.path().to_string_lossy());
        (repo, bare)
    }

    /// The upstream a branch tracks, as "<remote>/<branch>".
    fn upstream_of(repo: &TestRepo, branch: &str) -> Option<String> {
        let git_repo = repo.repo();
        let local = git_repo.find_branch(branch, git2::BranchType::Local).ok()?;
        let upstream = local.upstream().ok()?;
        upstream.name().ok().flatten().map(|s| s.to_string())
    }

    /// Publishing a branch must leave it tracking the remote it was published
    /// to, the way `git push -u` does.
    ///
    /// No push surface passes set_upstream, so after "create branch → commit →
    /// Push" the branch was left untracked: no tracking arrow, no ahead/behind
    /// badge ever, pulls falling back to name-matching, and the cleanup dialog
    /// later calling it "No upstream configured — may contain unmerged work".
    #[test]
    fn test_first_push_sets_upstream() {
        let (repo, _bare) = repo_with_bare_origin();
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature work", &[("feature.txt", "content")]);

        assert_eq!(upstream_of(&repo, "feature"), None, "no upstream yet");

        push_branch(
            &repo.path_str(),
            None,
            Some("feature".to_string()),
            false,
            false,
            false,
            false,
            None,
            TransferMonitor::disabled(),
        )
        .expect("push should succeed");

        assert_eq!(
            upstream_of(&repo, "feature").as_deref(),
            Some("origin/feature"),
            "the push that published the branch must set its upstream"
        );
    }

    /// A configured upstream survives even when its remote-tracking ref is gone.
    ///
    /// `Branch::upstream()` fails BOTH when no upstream is configured and when a
    /// configured one no longer resolves — a pruned remote-tracking ref, or a
    /// removed remote. Treating those alike silently re-pointed a deliberate
    /// upstream at whatever remote the user pushed to next, which is exactly
    /// what leaving established upstreams alone is meant to prevent.
    #[test]
    fn test_push_keeps_a_configured_upstream_whose_tracking_ref_is_gone() {
        let (repo, _bare) = repo_with_bare_origin();
        let fork = tempfile::tempdir().unwrap();
        git2::Repository::init_bare(fork.path()).unwrap();
        repo.add_remote("fork", &fork.path().to_string_lossy());

        let branch = repo.current_branch();
        push_branch(
            &repo.path_str(),
            Some("fork".to_string()),
            Some(branch.clone()),
            false,
            false,
            false,
            false,
            None,
            TransferMonitor::disabled(),
        )
        .expect("first push should succeed");
        assert_eq!(
            upstream_of(&repo, &branch).as_deref(),
            Some(format!("fork/{}", branch).as_str())
        );

        // The remote-tracking ref is pruned — the CONFIG still names fork.
        {
            let git_repo = repo.repo();
            let mut tracking = git_repo
                .find_reference(&format!("refs/remotes/fork/{}", branch))
                .expect("tracking ref should exist");
            tracking.delete().expect("prune the tracking ref");
        }

        push_branch(
            &repo.path_str(),
            Some("origin".to_string()),
            Some(branch.clone()),
            false,
            false,
            false,
            false,
            None,
            TransferMonitor::disabled(),
        )
        .expect("second push should succeed");

        let config = repo.repo().config().unwrap();
        assert_eq!(
            config
                .get_string(&format!("branch.{}.remote", branch))
                .unwrap(),
            "fork",
            "a pruned tracking ref must not re-point a configured upstream"
        );
    }

    /// A branch that already tracks something keeps tracking it: pushing to a
    /// second remote must not re-point the upstream behind the user's back.
    #[test]
    fn test_push_does_not_repoint_an_existing_upstream() {
        let (repo, _bare) = repo_with_bare_origin();
        let fork = tempfile::tempdir().unwrap();
        git2::Repository::init_bare(fork.path()).unwrap();
        repo.add_remote("fork", &fork.path().to_string_lossy());

        let branch = repo.current_branch();
        push_branch(
            &repo.path_str(),
            Some("origin".to_string()),
            Some(branch.clone()),
            false,
            false,
            false,
            false,
            None,
            TransferMonitor::disabled(),
        )
        .expect("first push should succeed");
        assert_eq!(
            upstream_of(&repo, &branch).as_deref(),
            Some(format!("origin/{}", branch).as_str())
        );

        push_branch(
            &repo.path_str(),
            Some("fork".to_string()),
            Some(branch.clone()),
            false,
            false,
            false,
            false,
            None,
            TransferMonitor::disabled(),
        )
        .expect("second push should succeed");

        assert_eq!(
            upstream_of(&repo, &branch).as_deref(),
            Some(format!("origin/{}", branch).as_str()),
            "an established upstream must survive a push to another remote"
        );
    }

    // ---- pre-push hook parity (git2 push path) ----

    #[cfg(unix)]
    #[test]
    fn test_push_single_remote_pre_push_hook_aborts() {
        let repo = TestRepo::with_initial_commit();
        let bare = tempfile::tempdir().unwrap();
        git2::Repository::init_bare(bare.path()).unwrap();
        repo.add_remote("origin", &bare.path().to_string_lossy());
        let branch = repo.current_branch();

        // Hook drains stdin then rejects the push.
        repo.install_hook(
            "pre-push",
            "#!/bin/sh\ncat >/dev/null\necho prepush-denied 1>&2\nexit 1\n",
        );

        let result = push_single_remote(
            &repo.path_str(),
            "origin",
            &branch,
            false,
            false,
            false,
            None,
        );
        assert!(result.is_err(), "pre-push exit 1 must abort the push");
        assert!(result.unwrap_err().contains("prepush-denied"));

        // The remote must not have received the ref.
        let bare_repo = git2::Repository::open(bare.path()).unwrap();
        assert!(bare_repo
            .refname_to_id(&format!("refs/heads/{}", branch))
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn test_push_single_remote_pre_push_receives_ref_line() {
        let repo = TestRepo::with_initial_commit();
        let bare = tempfile::tempdir().unwrap();
        git2::Repository::init_bare(bare.path()).unwrap();
        repo.add_remote("origin", &bare.path().to_string_lossy());
        let branch = repo.current_branch();
        let local_oid = repo.head_oid();

        let marker = repo.path.join("prepush-stdin.log");
        repo.install_hook(
            "pre-push",
            &format!("#!/bin/sh\ncat > \"{}\"\n", marker.display()),
        );

        push_single_remote(
            &repo.path_str(),
            "origin",
            &branch,
            false,
            false,
            false,
            None,
        )
        .unwrap();

        let stdin = std::fs::read_to_string(&marker).expect("pre-push must run");
        let zero = crate::commands::hooks::ZERO_OID;
        assert_eq!(
            stdin.trim(),
            format!(
                "refs/heads/{b} {oid} refs/heads/{b} {zero}",
                b = branch,
                oid = local_oid,
                zero = zero
            )
        );
    }

    #[tokio::test]
    async fn test_add_remote() {
        let repo = TestRepo::with_initial_commit();
        let result = add_remote(
            repo.path_str(),
            "origin".to_string(),
            "https://github.com/test/repo.git".to_string(),
        )
        .await;

        assert!(result.is_ok());
        let remote = result.unwrap();
        assert_eq!(remote.name, "origin");
        assert_eq!(remote.url, "https://github.com/test/repo.git");
        assert!(remote.push_url.is_none());
    }

    #[tokio::test]
    async fn test_add_remote_duplicate_fails() {
        let repo = TestRepo::with_initial_commit();
        add_remote(
            repo.path_str(),
            "origin".to_string(),
            "https://github.com/test/repo.git".to_string(),
        )
        .await
        .unwrap();

        // Adding same remote name again should fail
        let result = add_remote(
            repo.path_str(),
            "origin".to_string(),
            "https://github.com/test/other.git".to_string(),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_remotes_empty() {
        let repo = TestRepo::with_initial_commit();
        let result = get_remotes(repo.path_str()).await;

        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_get_remotes_returns_added() {
        let repo = TestRepo::with_initial_commit();
        add_remote(
            repo.path_str(),
            "origin".to_string(),
            "https://github.com/test/repo.git".to_string(),
        )
        .await
        .unwrap();
        add_remote(
            repo.path_str(),
            "upstream".to_string(),
            "https://github.com/upstream/repo.git".to_string(),
        )
        .await
        .unwrap();

        let result = get_remotes(repo.path_str()).await;
        assert!(result.is_ok());
        let remotes = result.unwrap();
        assert_eq!(remotes.len(), 2);

        let names: Vec<&str> = remotes.iter().map(|r| r.name.as_str()).collect();
        assert!(names.contains(&"origin"));
        assert!(names.contains(&"upstream"));
    }

    #[tokio::test]
    async fn test_remove_remote() {
        let repo = TestRepo::with_initial_commit();
        add_remote(
            repo.path_str(),
            "origin".to_string(),
            "https://github.com/test/repo.git".to_string(),
        )
        .await
        .unwrap();

        let result = remove_remote(repo.path_str(), "origin".to_string()).await;
        assert!(result.is_ok());

        // Verify it's gone
        let remotes = get_remotes(repo.path_str()).await.unwrap();
        assert!(remotes.is_empty());
    }

    #[tokio::test]
    async fn test_remove_remote_not_found() {
        let repo = TestRepo::with_initial_commit();
        let result = remove_remote(repo.path_str(), "nonexistent".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_rename_remote() {
        let repo = TestRepo::with_initial_commit();
        add_remote(
            repo.path_str(),
            "origin".to_string(),
            "https://github.com/test/repo.git".to_string(),
        )
        .await
        .unwrap();

        let result = rename_remote(
            repo.path_str(),
            "origin".to_string(),
            "upstream".to_string(),
        )
        .await;

        assert!(result.is_ok());
        let renamed = result.unwrap();
        assert_eq!(renamed.name, "upstream");
        assert_eq!(renamed.url, "https://github.com/test/repo.git");

        // Verify old name is gone
        let remotes = get_remotes(repo.path_str()).await.unwrap();
        assert_eq!(remotes.len(), 1);
        assert_eq!(remotes[0].name, "upstream");
    }

    #[tokio::test]
    async fn test_rename_remote_not_found() {
        let repo = TestRepo::with_initial_commit();
        let result = rename_remote(
            repo.path_str(),
            "nonexistent".to_string(),
            "newname".to_string(),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_rename_remote_to_existing_fails() {
        let repo = TestRepo::with_initial_commit();
        add_remote(
            repo.path_str(),
            "origin".to_string(),
            "https://github.com/test/repo.git".to_string(),
        )
        .await
        .unwrap();
        add_remote(
            repo.path_str(),
            "upstream".to_string(),
            "https://github.com/upstream/repo.git".to_string(),
        )
        .await
        .unwrap();

        // Renaming origin to upstream should fail since upstream exists
        let result = rename_remote(
            repo.path_str(),
            "origin".to_string(),
            "upstream".to_string(),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_set_remote_url() {
        let repo = TestRepo::with_initial_commit();
        add_remote(
            repo.path_str(),
            "origin".to_string(),
            "https://github.com/test/repo.git".to_string(),
        )
        .await
        .unwrap();

        let result = set_remote_url(
            repo.path_str(),
            "origin".to_string(),
            "https://github.com/newowner/repo.git".to_string(),
            None,
        )
        .await;

        assert!(result.is_ok());
        let remote = result.unwrap();
        assert_eq!(remote.url, "https://github.com/newowner/repo.git");
    }

    #[tokio::test]
    async fn test_set_remote_push_url() {
        let repo = TestRepo::with_initial_commit();
        add_remote(
            repo.path_str(),
            "origin".to_string(),
            "https://github.com/test/repo.git".to_string(),
        )
        .await
        .unwrap();

        let result = set_remote_url(
            repo.path_str(),
            "origin".to_string(),
            "git@github.com:test/repo.git".to_string(),
            Some(true),
        )
        .await;

        assert!(result.is_ok());
        let remote = result.unwrap();
        // Fetch URL unchanged
        assert_eq!(remote.url, "https://github.com/test/repo.git");
        // Push URL set
        assert_eq!(
            remote.push_url,
            Some("git@github.com:test/repo.git".to_string())
        );
    }

    #[tokio::test]
    async fn test_clear_remote_push_url() {
        let repo = TestRepo::with_initial_commit();
        add_remote(
            repo.path_str(),
            "origin".to_string(),
            "https://github.com/test/repo.git".to_string(),
        )
        .await
        .unwrap();

        let remote = set_remote_url(
            repo.path_str(),
            "origin".to_string(),
            "git@github.com:test/repo.git".to_string(),
            Some(true),
        )
        .await
        .unwrap();
        assert_eq!(
            remote.push_url,
            Some("git@github.com:test/repo.git".to_string())
        );

        // Clearing the field must remove the push URL, not store an empty one
        let result = set_remote_url(
            repo.path_str(),
            "origin".to_string(),
            String::new(),
            Some(true),
        )
        .await;

        assert!(result.is_ok(), "clearing push URL failed: {result:?}");
        let remote = result.unwrap();
        assert_eq!(remote.push_url, None);
        assert_eq!(remote.url, "https://github.com/test/repo.git");

        // And it must actually be gone from the config, not just the response
        let remotes = get_remotes(repo.path_str()).await.unwrap();
        let origin = remotes.iter().find(|r| r.name == "origin").unwrap();
        assert_eq!(origin.push_url, None);
        assert_eq!(origin.url, "https://github.com/test/repo.git");
    }

    #[tokio::test]
    async fn test_set_remote_url_rejects_an_empty_fetch_url() {
        let repo = TestRepo::with_initial_commit();
        add_remote(
            repo.path_str(),
            "origin".to_string(),
            "https://github.com/test/repo.git".to_string(),
        )
        .await
        .unwrap();

        let result = set_remote_url(
            repo.path_str(),
            "origin".to_string(),
            "   ".to_string(),
            None,
        )
        .await;

        assert!(result.is_err());
        assert!(
            result.unwrap_err().to_string().contains("cannot be empty"),
            "expected an empty-URL error"
        );

        let remotes = get_remotes(repo.path_str()).await.unwrap();
        let origin = remotes.iter().find(|r| r.name == "origin").unwrap();
        assert_eq!(origin.url, "https://github.com/test/repo.git");
    }

    #[tokio::test]
    async fn test_clearing_a_push_url_that_was_never_set_is_a_no_op() {
        let repo = TestRepo::with_initial_commit();
        add_remote(
            repo.path_str(),
            "origin".to_string(),
            "https://github.com/test/repo.git".to_string(),
        )
        .await
        .unwrap();

        let result = set_remote_url(
            repo.path_str(),
            "origin".to_string(),
            String::new(),
            Some(true),
        )
        .await;

        assert!(
            result.is_ok(),
            "clearing an unset push URL failed: {result:?}"
        );
        let remote = result.unwrap();
        assert_eq!(remote.push_url, None);
        assert_eq!(remote.url, "https://github.com/test/repo.git");
    }

    #[tokio::test]
    async fn test_set_remote_url_not_found() {
        let repo = TestRepo::with_initial_commit();
        let result = set_remote_url(
            repo.path_str(),
            "nonexistent".to_string(),
            "https://github.com/test/repo.git".to_string(),
            None,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_add_multiple_remotes() {
        let repo = TestRepo::with_initial_commit();

        add_remote(
            repo.path_str(),
            "origin".to_string(),
            "https://github.com/owner/repo.git".to_string(),
        )
        .await
        .unwrap();

        add_remote(
            repo.path_str(),
            "fork".to_string(),
            "https://github.com/fork/repo.git".to_string(),
        )
        .await
        .unwrap();

        add_remote(
            repo.path_str(),
            "upstream".to_string(),
            "https://github.com/upstream/repo.git".to_string(),
        )
        .await
        .unwrap();

        let remotes = get_remotes(repo.path_str()).await.unwrap();
        assert_eq!(remotes.len(), 3);
    }

    #[tokio::test]
    async fn test_remote_with_ssh_url() {
        let repo = TestRepo::with_initial_commit();
        let result = add_remote(
            repo.path_str(),
            "origin".to_string(),
            "git@github.com:test/repo.git".to_string(),
        )
        .await;

        assert!(result.is_ok());
        let remote = result.unwrap();
        assert_eq!(remote.url, "git@github.com:test/repo.git");
    }

    #[tokio::test]
    async fn test_get_fetch_status_empty() {
        let repo = TestRepo::with_initial_commit();
        let result = get_fetch_status(repo.path_str()).await;

        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_get_fetch_status_with_remotes() {
        let repo = TestRepo::with_initial_commit();
        add_remote(
            repo.path_str(),
            "origin".to_string(),
            "https://github.com/test/repo.git".to_string(),
        )
        .await
        .unwrap();
        add_remote(
            repo.path_str(),
            "upstream".to_string(),
            "https://github.com/upstream/repo.git".to_string(),
        )
        .await
        .unwrap();

        let result = get_fetch_status(repo.path_str()).await;
        assert!(result.is_ok());

        let statuses = result.unwrap();
        assert_eq!(statuses.len(), 2);

        let remote_names: Vec<&str> = statuses.iter().map(|s| s.remote.as_str()).collect();
        assert!(remote_names.contains(&"origin"));
        assert!(remote_names.contains(&"upstream"));

        // Verify URLs are correct
        for status in &statuses {
            if status.remote == "origin" {
                assert_eq!(status.url, "https://github.com/test/repo.git");
            } else if status.remote == "upstream" {
                assert_eq!(status.url, "https://github.com/upstream/repo.git");
            }
        }
    }

    #[tokio::test]
    async fn test_fetch_single_remote_not_found() {
        let repo = TestRepo::with_initial_commit();
        let result = fetch_single_remote(&repo.path_str(), "nonexistent", false, false, None);

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_push_single_remote_not_found() {
        let repo = TestRepo::with_initial_commit();
        let result = push_single_remote(
            &repo.path_str(),
            "nonexistent",
            "main",
            false,
            false,
            false,
            None,
        );

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_push_single_remote_validates_remote() {
        let repo = TestRepo::with_initial_commit();
        add_remote(
            repo.path_str(),
            "origin".to_string(),
            "https://github.com/test/repo.git".to_string(),
        )
        .await
        .unwrap();

        // Push will fail because we can't actually connect, but it should find the remote
        let result = push_single_remote(
            &repo.path_str(),
            "origin",
            "main",
            false,
            false,
            false,
            None,
        );

        // This will error since we can't connect to the remote, but it should not
        // error with "Remote not found"
        if let Err(ref e) = result {
            assert!(
                !e.contains("not found"),
                "Expected connection error, not 'not found': {}",
                e
            );
        }
    }

    #[test]
    fn test_multi_push_result_serialization() {
        use crate::models::{MultiPushResult, RemotePushResult};

        let result = MultiPushResult {
            results: vec![
                RemotePushResult {
                    remote: "origin".to_string(),
                    success: true,
                    message: Some("Pushed to origin/main".to_string()),
                },
                RemotePushResult {
                    remote: "upstream".to_string(),
                    success: false,
                    message: Some("Authentication failed".to_string()),
                },
            ],
            total_success: 1,
            total_failed: 1,
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"totalSuccess\":1"));
        assert!(json.contains("\"totalFailed\":1"));
        assert!(json.contains("\"remote\":\"origin\""));
        assert!(json.contains("\"remote\":\"upstream\""));

        // Verify deserialization roundtrip
        let deserialized: MultiPushResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.total_success, 1);
        assert_eq!(deserialized.total_failed, 1);
        assert_eq!(deserialized.results.len(), 2);
        assert!(deserialized.results[0].success);
        assert!(!deserialized.results[1].success);
    }

    #[test]
    fn test_remote_push_result_serialization() {
        use crate::models::RemotePushResult;

        let result = RemotePushResult {
            remote: "origin".to_string(),
            success: true,
            message: Some("Pushed successfully".to_string()),
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"remote\":\"origin\""));
        assert!(json.contains("\"success\":true"));
        assert!(json.contains("\"message\":\"Pushed successfully\""));

        // Test with None message
        let result_no_msg = RemotePushResult {
            remote: "upstream".to_string(),
            success: false,
            message: None,
        };

        let json2 = serde_json::to_string(&result_no_msg).unwrap();
        assert!(json2.contains("\"message\":null"));
    }

    // ---- cancelling a fetch / pull / push ----
    //
    // A REAL cancelled network transfer is not reproducible offline, so these
    // pin down everything around it that is: that a cancelled operation never
    // reaches the network at all, that libgit2's generic abort error is
    // reported as a cancellation rather than a failure, that the registry is
    // left empty afterwards, and that a cancelled pull leaves the repository
    // in the state a plain fetch would have.

    use crate::services::cancellation::{CancellationRegistry, CancellationToken};
    use crate::services::transfer_monitor::OperationProgress;

    /// A monitor wired to a live token, plus the events it emitted.
    fn cancellable_monitor(
        operation_id: &str,
    ) -> (
        TransferMonitor,
        CancellationToken,
        Arc<Mutex<Vec<OperationProgress>>>,
    ) {
        let events: Arc<Mutex<Vec<OperationProgress>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_events = Arc::clone(&events);
        let token = CancellationToken::new();
        let monitor = TransferMonitor::new(
            Some(operation_id.to_string()),
            "Fetching",
            token.clone(),
            Arc::new(move |p| sink_events.lock().unwrap().push(p)),
        );
        (monitor, token, events)
    }

    /// The mapping the UI depends on: a cancelled transfer must read as a
    /// cancellation, not as a timeout and not as a raw libgit2 failure.
    #[test]
    fn a_cancelled_transfer_is_reported_as_a_cancellation() {
        let abort = TransferAbort::default();
        let raw = || git2::Error::from_str("early EOF");

        // Neither flag: the real error survives untouched.
        let plain = transfer_failure(&abort, raw(), "Fetch operation timed out");
        assert!(matches!(plain, GitnadoError::Git(_)));

        abort
            .timed_out
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let timed_out = transfer_failure(&abort, raw(), "Fetch operation timed out");
        assert!(matches!(timed_out, GitnadoError::OperationTimeout(_)));

        // Cancellation wins over a deadline that also expired: the user is
        // told what they did, not what the clock did.
        abort
            .cancelled
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let cancelled = transfer_failure(&abort, raw(), "Fetch operation timed out");
        assert!(matches!(cancelled, GitnadoError::OperationCancelled));
        assert_eq!(
            crate::error::ErrorResponse::from(cancelled).code,
            "OPERATION_CANCELLED",
            "the frontend keys its 'Cancelled' toast off this code"
        );
    }

    /// A cancel that arrives while the fetch is still queued must stop it
    /// before it opens a socket. The remote here is a URL that would take a
    /// long time to fail; the test passing instantly is the assertion.
    #[test]
    fn a_pre_cancelled_fetch_never_reaches_the_network() {
        let local = TestRepo::with_initial_commit();
        local.add_remote("origin", "https://192.0.2.1/unreachable.git");

        let (monitor, token, events) = cancellable_monitor("op-1");
        token.cancel();

        let err = fetch_internal(&local.path_str(), "origin", false, None, None, monitor)
            .expect_err("a cancelled fetch must not succeed");

        assert!(matches!(err, GitnadoError::OperationCancelled));
        assert!(
            events.lock().unwrap().is_empty(),
            "nothing transferred, so nothing to report"
        );
    }

    /// The same for push: nothing may reach the remote.
    #[test]
    fn a_pre_cancelled_push_never_reaches_the_network() {
        let local = TestRepo::with_initial_commit();
        local.add_remote("origin", "https://192.0.2.1/unreachable.git");

        let (monitor, token, _events) = cancellable_monitor("op-2");
        token.cancel();

        let err = push_branch(
            &local.path_str(),
            Some("origin".to_string()),
            None,
            false,
            false,
            false,
            false,
            None,
            monitor,
        )
        .expect_err("a cancelled push must not succeed");

        assert!(matches!(err, GitnadoError::OperationCancelled));
    }

    /// And for the git-CLI push path force push uses — there the child process
    /// is what has to not be spawned.
    #[test]
    fn a_pre_cancelled_cli_push_never_spawns_git() {
        let local = TestRepo::with_initial_commit();
        local.add_remote("origin", "https://192.0.2.1/unreachable.git");

        let (monitor, token, _events) = cancellable_monitor("op-3");
        token.cancel();

        let err = push_via_cli(
            &local.path_str(),
            "origin",
            "main",
            false,
            true,
            false,
            false,
            None,
            &monitor,
        )
        .expect_err("a cancelled force push must not succeed");

        assert!(matches!(err, GitnadoError::OperationCancelled));
    }

    /// A cancelled pull must leave the working tree exactly where it was —
    /// never half-merged. Cancelling before the fetch is the easy half of
    /// that; the merge itself is deliberately not interruptible.
    #[test]
    fn a_cancelled_pull_leaves_the_working_tree_alone() {
        let (upstream, local, branch) = pull_fixture();
        upstream.create_commit("second", &[("b.txt", "b")]);
        let before = local.head_oid();

        let (monitor, token, _events) = cancellable_monitor("op-4");
        token.cancel();

        let err = pull_with_monitor(&local, &branch, None, monitor)
            .expect_err("a cancelled pull must not succeed");

        assert!(matches!(err, GitnadoError::OperationCancelled));
        assert_eq!(local.head_oid(), before, "HEAD must not have moved");
        assert!(
            !local.path.join("b.txt").exists(),
            "the upstream commit must not have been merged into the tree"
        );
        assert_eq!(
            local.repo().state(),
            git2::RepositoryState::Clean,
            "no half-finished merge may be left behind"
        );
    }

    /// The registration half of the contract: while a fetch is registered
    /// `cancel_operation` finds it, and once the operation ends nothing is
    /// left behind for a later id to collide with.
    #[tokio::test]
    async fn cancel_operation_finds_a_registered_operation_and_the_registry_empties() {
        let registry = CancellationRegistry::default();

        // Nothing registered: this is the state that made every Cancel click a
        // no-op before this change.
        assert!(!registry.cancel("op-5"));

        {
            let guard = registry.guard(Some("op-5".to_string()));
            assert!(registry.cancel("op-5"), "a registered id is cancellable");
            assert!(guard.is_cancelled());
        }

        assert!(
            registry.is_empty(),
            "the operation must be deregistered when it ends"
        );
        assert!(!registry.cancel("op-5"));
    }

    /// The guard travels into the blocking task, so the id stays cancellable
    /// for as long as the work is really running — including after a caller
    /// that timed out has gone away — and is released when it ends.
    #[tokio::test]
    async fn the_registration_outlives_a_caller_that_gave_up() {
        let registry = CancellationRegistry::default();
        let guard = registry.guard(Some("op-6".to_string()));
        let (tx, rx) = std::sync::mpsc::channel::<()>();

        let handle = tokio::task::spawn_blocking(move || {
            let _guard = guard;
            rx.recv().ok();
        });

        assert!(
            registry.cancel("op-6"),
            "still cancellable while the work runs"
        );

        tx.send(()).unwrap();
        handle.await.unwrap();
        assert!(registry.is_empty(), "released when the work really ends");
    }
}

// ========================================================================
// Shallow/Partial Clone Operations
// ========================================================================

/// Deepen a shallow repository by fetching more history
#[command]
pub async fn deepen_repository(path: String, depth: u32) -> Result<()> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(&path)
        .arg("fetch")
        .arg(format!("--deepen={}", depth))
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to deepen: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "Deepen failed: {}",
            stderr.trim()
        )));
    }

    Ok(())
}

/// Convert a shallow repository to a full clone by fetching all history
#[command]
pub async fn unshallow_repository(path: String) -> Result<()> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(&path)
        .arg("fetch")
        .arg("--unshallow")
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to unshallow: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "Unshallow failed: {}",
            stderr.trim()
        )));
    }

    Ok(())
}
