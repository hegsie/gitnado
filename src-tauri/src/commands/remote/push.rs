//! Push command handlers, push CLI runner, and push remote resolution helpers

use std::path::Path;
use tauri::{command, AppHandle, Emitter, State};

use super::{
    await_remote_task, guard_push_destinations, guard_remote_op, late_failure, network_timeout,
    operation_monitor, transfer_failure,
};
use crate::error::{GitnadoError, Result};
use crate::models::{MultiPushResult, RemoteOperationResult, RemotePushResult};
use crate::services::cancellation::CancellationRegistry;
use crate::services::credentials_service;
use crate::services::remote_ops::{self, RemoteOp, RemoteOpRegistry};
use crate::services::transfer_monitor::TransferMonitor;
use crate::utils::{create_command, reject_flag_like};

/// The remote a push would target, without performing it.
#[tauri::command]
pub async fn get_push_remote(path: String, remote: Option<String>) -> Result<String> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let remote_name = resolve_push_remote(&repo, remote);
    repo.find_remote(&remote_name)
        .map_err(|_| GitnadoError::RemoteNotFound(remote_name.clone()))?;
    Ok(remote_name)
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
    guard_remote_op(&path, true, |repo| {
        Some(resolve_push_remote(repo, remote.clone()))
    })?;
    // In an LFS repository the pre-push hook uploads objects BEFORE any ref
    // is sent, to an endpoint a committed `.lfsconfig` may choose — gated on
    // that endpoint, for the same destination the gate above just judged.
    crate::commands::lfs::guard_lfs_upload(&path, remote.as_deref())?;

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
pub(super) fn push_remote_url(path: &str, remote_name: &str) -> Option<String> {
    let repo = git2::Repository::open(path).ok()?;
    let remote = repo.find_remote(remote_name).ok()?;
    remote
        .pushurl()
        .ok()
        .flatten()
        .or_else(|| remote.url().ok())
        .map(|u| u.to_string())
}

/// How polling a spawned `git push` ended.
pub(super) enum PushOutcome {
    Finished(std::process::ExitStatus),
    Cancelled,
    WaitFailed(String),
}

/// Poll a spawned `git push` to completion, honouring a cancellation only for
/// as long as the child is genuinely still running.
///
/// The reap comes FIRST and the sleep last, deliberately. Reading the cancel
/// flag before `try_wait` reported pushes that had already landed as
/// cancelled: the poll sleeps 100ms between iterations, so a push that exited
/// during a sleep, followed by a Cancel click before the loop woke, took the
/// cancel branch on the next iteration — `kill` was a no-op on the exited
/// child, the real exit status was thrown away, and the user was told "Push
/// cancelled" for a `--force-with-lease` that had already overwritten the
/// remote branch (no Output panel entry, no sidebar refresh). Reaping first
/// keeps the invariant the frontend is documented on in
/// `services/git.service.ts`: OPERATION_CANCELLED is only ever returned for a
/// push that really was aborted. `commands::repository`'s CLI clone polls the
/// same way.
pub(super) fn poll_push_child(
    child: &mut std::process::Child,
    monitor: &TransferMonitor,
) -> PushOutcome {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return PushOutcome::Finished(status),
            Ok(None) => {}
            Err(e) => return PushOutcome::WaitFailed(e.to_string()),
        }

        if monitor.is_cancelled() {
            return PushOutcome::Cancelled;
        }

        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// Kill and reap a child the poll gave up on, and say what it really was.
///
/// `poll_push_child` reads the cancel flag AFTER `try_wait` reports the child
/// still running, so a push that exits between those two reads is handed over
/// as `Cancelled`: the kill below is a no-op on it, and reaping it as
/// cancelled would throw its real exit status away — the same misreport the
/// reap-first ordering exists to prevent, shrunk from the 100ms sleep to a
/// few instructions but not closed. The status `wait` returns after the kill
/// is the truth: a `success()` there is a push that landed on the remote, and
/// the user has to be told so. A killed child does not report success (it is
/// signalled on Unix and exits non-zero on Windows), so a push that really
/// was stopped stays cancelled.
pub(super) fn reap_abandoned_push(
    child: &mut std::process::Child,
    abnormal: PushOutcome,
) -> PushOutcome {
    let _ = child.kill();
    match child.wait() {
        Ok(status) if status.success() => PushOutcome::Finished(status),
        _ => abnormal,
    }
}

/// Run a prepared `git push` to completion, killing it if the user cancels.
///
/// `Command::output()` blocks until the child exits, which is why the force
/// push had no cancellation point at all. Spawning and polling gives it one.
/// Both pipes are drained on their own threads: git push writes its progress
/// to stderr, and leaving a piped stream unread deadlocks the child once the
/// pipe buffer fills — the same trap `clone_repository` documents.
pub(super) fn run_push_command(
    mut cmd: crate::utils::GitCommand,
    monitor: &TransferMonitor,
) -> Result<std::process::Output> {
    if monitor.is_cancelled() {
        return Err(GitnadoError::OperationCancelled);
    }

    // The child is driven by hand below so a cancellation can kill it, which
    // means `GitCommand::output()` never runs and never reports the push to the
    // Output panel. Time it here and report the result explicitly instead.
    let started = std::time::Instant::now();

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

    // Single exit path for every abnormal outcome, the shape the CLI clone in
    // `commands::repository` uses: kill the child and join the drain threads
    // once, instead of repeating that in each early return.
    let outcome = match poll_push_child(&mut child, monitor) {
        finished @ PushOutcome::Finished(_) => finished,
        // Killed and reaped before returning: an orphaned `git push` would
        // keep talking to the remote after the user was told it stopped.
        abnormal => reap_abandoned_push(&mut child, abnormal),
    };
    let status = match outcome {
        PushOutcome::Finished(status) => status,
        abnormal => {
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(match abnormal {
                PushOutcome::Cancelled => GitnadoError::OperationCancelled,
                PushOutcome::WaitFailed(e) => {
                    GitnadoError::OperationFailed(format!("Failed to wait for git push: {}", e))
                }
                PushOutcome::Finished(_) => unreachable!("handled above"),
            });
        }
    };

    let output = std::process::Output {
        status,
        stdout: stdout_reader.join().unwrap_or_default(),
        stderr: stderr_reader.join().unwrap_or_default(),
    };
    cmd.report_run(started, &output);
    Ok(output)
}

/// Push via git CLI (used for --force-with-lease and --tags which git2 doesn't support)
///
/// Unlike the git2 path this one CAN be stopped mid-transfer: the child is
/// spawned rather than run to completion, and a cancellation kills it — the
/// same shape `clone_repository`'s CLI path uses.
#[allow(clippy::too_many_arguments)]
pub(super) fn push_via_cli(
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
pub(super) fn push_single_remote(
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
    guard_push_destinations(&path, &remotes)?;

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
