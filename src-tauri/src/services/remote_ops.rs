//! Per-repository exclusion for the remote operations (fetch / pull / push).
//!
//! The frontend already refuses a second push or pull while one is running
//! (`src/utils/ref-lock.ts`), but that lock is released the moment `invoke`
//! returns — and `invoke` returns EARLY when the network timeout fires.
//! `tokio::time::timeout` only drops the caller's future; it cannot cancel the
//! `spawn_blocking` task underneath, and git2 push has no abort point at all.
//! So after a timeout the frontend slot is free while the original push is
//! still live against the remote, and the user's retry ran alongside it.
//!
//! The fix is a claim the BLOCKING TASK owns: `run_holding` moves the guard
//! into the closure it hands to `spawn_blocking`, so the slot is released when
//! that task finishes rather than when the command's future is dropped. The
//! frontend locks stay as the fast path — they keep a second click from ever
//! reaching IPC — and this registry is the actual guarantee.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::error::{GitnadoError, Result};

/// The remote operations that share one per-repository slot.
///
/// They share a single slot rather than one each because they are not
/// independent: a pull moves HEAD and the working tree under a push that is
/// reading refs, and a fetch that is pruning rewrites the very remote-tracking
/// refs a pull just resolved.
///
/// The one exception is the background (window-focus) fetch, which yields to
/// the slot but never takes it — see `run_holding`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteOp {
    Fetch,
    Pull,
    Push,
}

impl RemoteOp {
    /// The operation as the refusal message names it to the user.
    pub fn label(self) -> &'static str {
        match self {
            RemoteOp::Fetch => "fetch",
            RemoteOp::Pull => "pull",
            RemoteOp::Push => "push",
        }
    }

    /// Capitalised form used in the "<Op> task failed" join error, which
    /// predates this module and is worth keeping byte-for-byte.
    fn task_label(self) -> &'static str {
        match self {
            RemoteOp::Fetch => "Fetch",
            RemoteOp::Pull => "Pull",
            RemoteOp::Push => "Push",
        }
    }
}

type InFlight = Arc<Mutex<HashMap<PathBuf, RemoteOp>>>;

/// Recover rather than propagate a poisoned lock.
///
/// Nothing but `HashMap` insert/remove/get runs while the lock is held, so
/// poisoning takes a panic elsewhere in the process. Failing to release on a
/// poisoned lock would wedge the repository's slot for the rest of the
/// session, which is strictly worse than continuing.
fn lock(in_flight: &InFlight) -> MutexGuard<'_, HashMap<PathBuf, RemoteOp>> {
    in_flight.lock().unwrap_or_else(|e| e.into_inner())
}

/// Repositories with a remote operation in flight, and which operation it is.
///
/// Registered as Tauri managed state; the `fetch`, `pull` and `push` commands
/// take it as a `State` parameter.
#[derive(Default)]
pub struct RemoteOpRegistry {
    in_flight: InFlight,
}

impl RemoteOpRegistry {
    /// Claim `repo_path`'s slot, or report which operation already holds it.
    ///
    /// Rejects rather than queues: the caller is a user action that already
    /// showed a spinner, and silently waiting behind a push to an unreachable
    /// remote is indistinguishable from a hang.
    pub fn acquire(&self, repo_path: &Path, op: RemoteOp) -> Result<RemoteOpGuard> {
        let key = normalize(repo_path);
        let mut in_flight = lock(&self.in_flight);
        if let Some(running) = in_flight.get(&key) {
            // Names the operation, and says the part the user cannot work
            // out for themselves: after a network timeout the app looks idle
            // — every spinner and lock was released — while the abandoned
            // blocking task is still talking to the remote.
            return Err(GitnadoError::RemoteOperationInFlight(format!(
                "A {} is already running for this repository. Wait for it to \
                 finish and try again — an operation that timed out can still \
                 be finishing in the background.",
                running.label()
            )));
        }
        in_flight.insert(key.clone(), op);
        Ok(RemoteOpGuard {
            in_flight: Arc::clone(&self.in_flight),
            key,
        })
    }

    /// Which operation holds `repo_path`'s slot, if any.
    ///
    /// For the background fetch, which yields to the slot without taking it —
    /// see `run_holding`.
    pub fn running(&self, repo_path: &Path) -> Option<RemoteOp> {
        // Resolved before the lock is taken: normalize() hits the filesystem.
        let key = normalize(repo_path);
        lock(&self.in_flight).get(&key).copied()
    }
}

/// Releases the repository's slot on drop.
///
/// Held by the blocking task, not by the command's future — see the module
/// docs. Dropping a `JoinHandle` does not cancel a `spawn_blocking` task, so
/// tying the claim to the closure is what makes a timed-out operation keep
/// holding its slot until it really finishes.
#[derive(Debug)]
pub struct RemoteOpGuard {
    in_flight: InFlight,
    key: PathBuf,
}

impl Drop for RemoteOpGuard {
    fn drop(&mut self) {
        lock(&self.in_flight).remove(&self.key);
    }
}

/// Key repositories by their resolved path.
///
/// `/repo`, `/repo/` and `/repo/.` are the same repository, and the app builds
/// paths from several sources (the tab store, a drag-and-drop, a recent-repos
/// entry). Keying on the raw string would hand out two slots for one working
/// tree. Falls back to the path as given when it cannot be resolved — a repo
/// that has been deleted mid-operation still needs its slot released under the
/// same key it was claimed with.
fn normalize(repo_path: &Path) -> PathBuf {
    repo_path
        .canonicalize()
        .unwrap_or_else(|_| repo_path.to_path_buf())
}

/// Run `work` on the blocking pool, carrying the repository's claim with it.
///
/// The guard is moved INTO the closure, so the slot outlives a caller that
/// gave up: `tokio::time::timeout` drops the command's future, the blocking
/// task carries on, and the next fetch/pull/push is refused until the work
/// really finishes. Holding the guard anywhere else — in this function's own
/// body, or in the command's future — frees it the instant the timeout fires,
/// which is the bug.
///
/// `slot` is `None` for a caller that deliberately holds nothing: the
/// window-focus background fetch, which yields to a running operation but must
/// never hold the repository against one. The timer auto-fetch
/// (`services/autofetch_service.rs`) has always run alongside whatever the user
/// is doing, so making its window-focus twin the one background operation that
/// can refuse a push would be a regression rather than a fix.
pub async fn run_holding<T, F>(slot: Option<RemoteOpGuard>, op: RemoteOp, work: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    spawn_holding(slot, work)
        .await
        .map_err(|e| GitnadoError::Custom(format!("{} task failed: {}", op.task_label(), e)))?
}

/// The same claim-carrying spawn as `run_holding`, but handing back the
/// `JoinHandle` instead of awaiting it.
///
/// The remote commands need the handle itself: they poll it under
/// `tokio::time::timeout` and, when the timeout wins, hand the still-running
/// handle to a detached reporter so a completion that lands late is still
/// announced (`commands::remote::await_remote_task`). Awaiting it here, as
/// `run_holding` does, throws that handle away — and a dropped handle is
/// exactly how a late fetch/pull/push came to mutate the repository in
/// silence.
pub fn spawn_holding<T, F>(
    slot: Option<RemoteOpGuard>,
    work: F,
) -> tokio::task::JoinHandle<Result<T>>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        // Named so it is unmistakably the claim being carried, and dropped
        // only when `work` has returned.
        let _slot = slot;
        work()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorResponse;
    use crate::test_utils::TestRepo;
    use std::sync::mpsc;
    use std::time::Duration;

    /// Poll until `cond` holds, so a release that happens on the blocking pool
    /// does not need a sleep long enough to be flaky.
    async fn wait_until(mut cond: impl FnMut() -> bool) {
        for _ in 0..200 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition never became true");
    }

    #[test]
    fn second_operation_on_the_same_repository_is_refused() {
        let repo = TestRepo::new();
        let registry = RemoteOpRegistry::default();

        let _first = registry.acquire(&repo.path, RemoteOp::Push).unwrap();
        let second = registry.acquire(&repo.path, RemoteOp::Push);

        assert!(second.is_err(), "a second push must be refused");
    }

    #[test]
    fn refusal_names_the_running_operation_and_carries_its_own_code() {
        let repo = TestRepo::new();
        let registry = RemoteOpRegistry::default();

        let _push = registry.acquire(&repo.path, RemoteOp::Push).unwrap();
        let err = registry.acquire(&repo.path, RemoteOp::Pull).unwrap_err();

        let message = err.to_string();
        assert!(
            message.contains("push is already running"),
            "refusal must name the operation that holds the slot: {}",
            message
        );
        // The frontend matches this phrase to keep its timeout and
        // repository-lock rules from rewriting the message — see
        // src/services/error-suggestion.service.ts.
        assert!(
            message.contains("already running for this repository"),
            "message: {}",
            message
        );
        // The refusal is reachable precisely BECAUSE a timed-out operation is
        // still live, so it has to say so.
        assert!(message.contains("timed out"), "message: {}", message);
        assert_eq!(
            ErrorResponse::from(err).code,
            "REMOTE_OPERATION_IN_FLIGHT",
            "the rejection needs a code of its own so the UI can tell it apart"
        );
    }

    #[test]
    fn releasing_the_guard_frees_the_repository() {
        let repo = TestRepo::new();
        let registry = RemoteOpRegistry::default();

        {
            let _first = registry.acquire(&repo.path, RemoteOp::Fetch).unwrap();
            assert_eq!(registry.running(&repo.path), Some(RemoteOp::Fetch));
        }

        assert_eq!(registry.running(&repo.path), None);
        assert!(registry.acquire(&repo.path, RemoteOp::Push).is_ok());
    }

    #[test]
    fn separate_repositories_do_not_block_each_other() {
        let one = TestRepo::new();
        let two = TestRepo::new();
        let registry = RemoteOpRegistry::default();

        let _first = registry.acquire(&one.path, RemoteOp::Push).unwrap();
        assert!(
            registry.acquire(&two.path, RemoteOp::Push).is_ok(),
            "separate repositories have separate remotes and nothing to serialize"
        );
    }

    #[test]
    fn the_same_repository_spelled_differently_shares_one_slot() {
        let repo = TestRepo::new();
        let registry = RemoteOpRegistry::default();

        let _first = registry.acquire(&repo.path, RemoteOp::Push).unwrap();
        let same_repo_other_spelling = repo.path.join(".");

        assert!(
            registry
                .acquire(&same_repo_other_spelling, RemoteOp::Push)
                .is_err(),
            "'/repo' and '/repo/.' are one working tree and must share one slot"
        );
    }

    #[test]
    fn running_reports_the_operation_a_background_fetch_must_yield_to() {
        let repo = TestRepo::new();
        let registry = RemoteOpRegistry::default();

        assert_eq!(registry.running(&repo.path), None);
        let _push = registry.acquire(&repo.path, RemoteOp::Push).unwrap();
        assert_eq!(registry.running(&repo.path), Some(RemoteOp::Push));
    }

    /// A background refresh takes no slot, so it can never refuse a user action.
    #[tokio::test]
    async fn run_holding_without_a_slot_leaves_the_repository_free() {
        let repo = TestRepo::new();
        let registry = RemoteOpRegistry::default();
        let (finish_tx, finish_rx) = mpsc::channel::<()>();

        let background = tokio::spawn(run_holding(None, RemoteOp::Fetch, move || {
            let _ = finish_rx.recv();
            Ok(())
        }));

        // The user can still push while it runs.
        let user_push = registry.acquire(&repo.path, RemoteOp::Push);
        assert!(
            user_push.is_ok(),
            "a background fetch must not hold the repository against a push"
        );

        finish_tx.send(()).unwrap();
        background.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn run_holding_releases_when_the_blocking_task_finishes() {
        let repo = TestRepo::new();
        let registry = RemoteOpRegistry::default();

        let slot = registry.acquire(&repo.path, RemoteOp::Push).unwrap();
        let value = run_holding(Some(slot), RemoteOp::Push, || Ok(7))
            .await
            .unwrap();

        assert_eq!(value, 7);
        assert_eq!(registry.running(&repo.path), None);
    }

    /// The bug this module exists for: a push that timed out is still live.
    ///
    /// `tokio::time::timeout` drops the caller's future but cannot cancel the
    /// `spawn_blocking` task, so the slot must stay claimed until that task
    /// returns. Holding the guard anywhere other than inside the closure
    /// (in `run_holding`'s own body, or in the command's future) frees it the
    /// instant the timeout fires — and the retry races the original push.
    #[tokio::test]
    async fn a_timed_out_operation_keeps_its_slot_until_the_work_really_ends() {
        let repo = TestRepo::new();
        let registry = RemoteOpRegistry::default();
        let (finish_tx, finish_rx) = mpsc::channel::<()>();

        // Exactly what `push` does: claim, then hand the claim to the task.
        let slot = registry.acquire(&repo.path, RemoteOp::Push).unwrap();
        let slow_push = run_holding(Some(slot), RemoteOp::Push, move || {
            // Stands in for git2's push against an unreachable remote:
            // blocking, and with no abort point.
            let _ = finish_rx.recv();
            Ok(())
        });

        // The caller gives up, exactly as the network timeout does.
        assert!(
            tokio::time::timeout(Duration::from_millis(100), slow_push)
                .await
                .is_err(),
            "the slow push should have outlived the timeout"
        );

        // ... but the abandoned task is still pushing, so a retry is refused.
        assert_eq!(
            registry.running(&repo.path),
            Some(RemoteOp::Push),
            "the timed-out push must still hold the slot"
        );
        assert!(
            registry.acquire(&repo.path, RemoteOp::Push).is_err(),
            "a retry after a timeout must not overlap the push that is still running"
        );

        // Once the real work ends the repository is usable again.
        finish_tx.send(()).unwrap();
        wait_until(|| registry.running(&repo.path).is_none()).await;
        assert!(registry.acquire(&repo.path, RemoteOp::Push).is_ok());
    }
}
