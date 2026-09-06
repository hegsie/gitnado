//! Running synchronous git work off the async runtime's worker threads.

use crate::error::{LeviathanError, Result};

/// Run a synchronous, potentially slow git operation on tokio's blocking pool.
///
/// Almost every Tauri command here is `async fn`, but the body is pure
/// `git2` — a revwalk, a diff, an index write, a status scan. Run directly,
/// that work occupies a tokio WORKER thread for its whole duration, and the
/// runtime has a small, fixed number of those. While one command walks a
/// 200k-commit history, the tasks sharing those workers make no progress:
/// auto-fetch, the file watcher's event pump, the MCP server, and every other
/// in-flight command sit behind it. The UI's next request is not merely queued
/// behind one slow request — it cannot even start being polled.
///
/// The blocking pool exists for exactly this: it grows on demand, so parking a
/// thread there for a second costs latency on that one request and nothing
/// else.
///
/// `git2` handles (`Repository`, `Commit`, `Diff`, …) are NOT `Send`, so the
/// repository must be opened INSIDE `f` and only owned values returned.
///
/// A panic inside `f` is turned into an error rather than being left to
/// unwind out of a detached task: the caller gets a failed command it can
/// report, and the runtime keeps running.
pub async fn blocking_git<T, F>(f: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(result) => result,
        Err(join_error) => {
            if join_error.is_panic() {
                let payload = join_error.into_panic();
                Err(LeviathanError::Custom(format!(
                    "Git operation panicked: {}",
                    panic_message(payload.as_ref())
                )))
            } else {
                // Only reachable if the task was aborted; nothing here aborts
                // one, but report it rather than silently succeeding.
                Err(LeviathanError::Custom(format!(
                    "Git operation did not complete: {}",
                    join_error
                )))
            }
        }
    }
}

/// Best-effort text of a caught panic payload.
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::blocking_git;
    use crate::error::LeviathanError;

    #[tokio::test]
    async fn returns_the_closure_value() {
        let value = blocking_git(|| Ok(21 * 2)).await.unwrap();
        assert_eq!(value, 42);
    }

    #[tokio::test]
    async fn propagates_the_closure_error_unchanged() {
        let err = blocking_git::<(), _>(|| Err(LeviathanError::CommitNotFound("abc".into())))
            .await
            .unwrap_err();
        assert!(matches!(err, LeviathanError::CommitNotFound(oid) if oid == "abc"));
    }

    /// A panicking git operation must surface as an ordinary command error.
    /// Left unhandled it would resolve as a `JoinError` the caller cannot
    /// report and the command would look like an unexplained IPC failure.
    #[tokio::test]
    async fn turns_a_panic_into_an_error_carrying_its_message() {
        let err = blocking_git::<(), _>(|| panic!("index is corrupt"))
            .await
            .unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("panicked") && message.contains("index is corrupt"),
            "unexpected message: {}",
            message
        );
    }

    /// A `String` payload (`panic!("{}", x)`) must be reported too, not
    /// flattened to "unknown panic".
    #[tokio::test]
    async fn reports_a_formatted_panic_payload() {
        let detail = "HEAD is unborn".to_string();
        let err = blocking_git::<(), _>(move || panic!("{}", detail))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("HEAD is unborn"));
    }

    /// The runtime keeps working after a panicking task: the next call runs
    /// normally rather than inheriting a poisoned pool.
    #[tokio::test]
    async fn the_runtime_survives_a_panicking_operation() {
        let _ = blocking_git::<(), _>(|| panic!("boom")).await;
        assert_eq!(blocking_git(|| Ok(7)).await.unwrap(), 7);
    }

    /// The work really does leave the worker threads: a single-worker runtime
    /// stays responsive while a long blocking call is in flight. Run inline in
    /// the `async fn`, the second task could not be polled at all.
    #[test]
    fn other_tasks_progress_while_a_blocking_operation_runs() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();

        runtime.block_on(async {
            // The blocking operation cannot finish until the test lets it, so
            // the quick task can only complete if the worker is genuinely
            // free while the blocking call is in flight — not because the
            // clock ran out on a sleep first. The budget only bounds a hang.
            let (release, gate) = std::sync::mpsc::channel::<()>();
            let slow = tokio::spawn(blocking_git(move || {
                let _ = gate.recv();
                Ok(1)
            }));
            let quick = tokio::spawn(async { 2 });

            let quick_value = tokio::time::timeout(std::time::Duration::from_secs(30), quick)
                .await
                .expect("a worker thread was starved by the blocking operation")
                .unwrap();
            assert_eq!(quick_value, 2);

            release.send(()).unwrap();
            assert_eq!(slow.await.unwrap().unwrap(), 1);
        });
    }
}
