//! Remote command handlers

mod fetch_pull;
#[path = "remote/push.rs"]
mod push_ops;
#[cfg(test)]
#[path = "remote/remote_tests.rs"]
mod test_suite;

pub(crate) use fetch_pull::resolve_fetch_remote;
pub use fetch_pull::*;
#[cfg(test)]
use fetch_pull::{
    fast_forward_to, fetch_internal, fetch_single_remote, merge_fetched_commit, pull_branch,
    pull_should_rebase,
};

#[cfg(test)]
use push_ops::push_branch;
pub(crate) use push_ops::resolve_push_remote;
pub use push_ops::*;
#[cfg(test)]
use push_ops::{
    poll_push_child, push_remote_url, push_single_remote, push_via_cli, reap_abandoned_push,
    run_push_command, PushOutcome,
};

use std::path::Path;
use tauri::{command, AppHandle, Emitter};

use crate::error::{GitnadoError, Result};
use crate::models::{Remote, RemoteOperationResult};
use crate::services::cancellation::CancellationRegistry;
use crate::services::credentials_service::TransferAbort;
#[cfg(test)]
use crate::services::remote_ops::{self, RemoteOp, RemoteOpRegistry};
use crate::services::transfer_monitor::{OperationProgress, ProgressSink, TransferMonitor};
#[cfg(test)]
use crate::utils::create_command;

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

/// Backend half of the offline/allowlist gate for a remote operation.
///
/// The frontend gate (`checkNetworkAllowed`) still runs first and is the half
/// that can explain the refusal before any work starts; this is the backstop
/// for a call site that forgets it. `resolve` names the remote the operation
/// will ACTUALLY contact — assuming "origin" evaluates the allowlist against
/// the wrong host in the ordinary fork layout, which is the same reason
/// `get_pull_remote` and `get_push_remote` exist. `for_push` judges the
/// remote's `pushurl` when it has one, which is where a push really goes.
///
/// Offline mode used to short-circuit here to `guard_remote(path, None)`, on
/// the belief that it "refuses everything" so naming the remote was wasted
/// work. It does not: `check` permits a target that never leaves the machine.
/// That fast path threw away both the remote `resolve` had just named and the
/// push/fetch distinction, and judged the CURRENT BRANCH's tracking remote and
/// its FETCH url instead — so with a branch tracking a local `/mnt/usb` remote
/// it let a `fetch` from `origin` on github.com through (the backstop failing
/// OPEN, with nothing behind it to re-check), and with a branch tracking
/// `origin` it refused a push to `/mnt/usb`. Nothing is paid for on the hot
/// path regardless: `guard_remote`/`guard_push_remote` return immediately when
/// no policy is in force, and the repository is only opened past this point.
fn guard_remote_op(
    path: &str,
    for_push: bool,
    resolve: impl FnOnce(&git2::Repository) -> Option<String>,
) -> Result<()> {
    let settings = crate::services::security::global().snapshot();
    if !settings.offline_mode && settings.remote_allowlist.is_empty() {
        return Ok(());
    }
    let repo = git2::Repository::open(Path::new(path)).ok();
    let remote = repo.as_ref().and_then(resolve);
    if for_push {
        crate::services::security::guard_push_remote(path, remote.as_deref())
    } else {
        crate::services::security::guard_remote(path, remote.as_deref())
    }
}

/// The gate for a push to SEVERAL remotes: every destination is checked
/// before any is contacted, so one disallowed remote refuses the whole
/// gesture rather than half-pushing. Judged on each remote's push URL.
fn guard_push_destinations(path: &str, remotes: &[String]) -> Result<()> {
    for r in remotes {
        crate::services::security::guard_push_remote(path, Some(r))?;
        // ...and the LFS endpoint its pre-push upload would reach.
        crate::commands::lfs::guard_lfs_upload(path, Some(r))?;
    }
    Ok(())
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

/// Cancel an ongoing remote operation
#[command]
pub async fn cancel_operation(
    registry: tauri::State<'_, CancellationRegistry>,
    operation_id: String,
) -> Result<bool> {
    Ok(registry.cancel(&operation_id))
}

// Shallow/Partial Clone Operations
// ========================================================================

/// Deepen a shallow repository by fetching more history
#[command]
pub async fn deepen_repository(path: String, depth: u32) -> Result<()> {
    // `git fetch --deepen` is a fetch.
    crate::services::security::guard_remote(&path, None)?;
    // Through `create_command` like every other user operation: no credential
    // prompt can hang it, and the panel shows the fetch it ran.
    let output = crate::utils::create_command("git")
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
    crate::services::security::guard_remote(&path, None)?;
    let output = crate::utils::create_command("git")
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
