#[cfg(test)]
mod tests {
    use super::super::*;
    use crate::test_utils::TestRepo;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    // ---- the push gate judges the push URL, the fetch gate the fetch URL ----
    //
    // git2 and `git push` contact `remote.<n>.pushurl` when one is set; the
    // token scoping (`push_remote_url`) knew that and the allowlist did not.

    /// origin fetches from github.com and pushes to gitlab.example.
    fn repo_with_split_push_url() -> TestRepo {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://github.com/org/x.git");
        repo.add_remote("mirror", "https://github.com/org/mirror.git");
        repo.repo()
            .config()
            .unwrap()
            .set_str("remote.origin.pushurl", "https://gitlab.example/org/x.git")
            .unwrap();
        repo
    }

    fn blocked_host(result: Result<()>) -> String {
        match result {
            Err(GitnadoError::NetworkBlocked(message)) => message,
            other => panic!("expected a NetworkBlocked refusal, got {:?}", other),
        }
    }

    #[test]
    fn a_push_is_refused_on_its_push_url_while_a_fetch_passes_on_its_fetch_url() {
        let repo = repo_with_split_push_url();
        let _guard = crate::services::security::test_support::allowlist(&["github.com"]);

        let fetch = guard_remote_op(&repo.path_str(), false, |repo| {
            Some(resolve_fetch_remote(repo, None))
        });
        assert!(fetch.is_ok(), "the fetch URL is on the list: {:?}", fetch);

        let push = guard_remote_op(&repo.path_str(), true, |repo| {
            Some(resolve_push_remote(repo, None))
        });
        assert!(
            blocked_host(push).contains("gitlab.example"),
            "the refusal must name the host the push would have reached"
        );
    }

    #[test]
    fn a_push_to_a_remote_without_a_push_url_is_judged_on_its_url() {
        let repo = repo_with_split_push_url();
        let _guard = crate::services::security::test_support::allowlist(&["github.com"]);

        let push = guard_remote_op(&repo.path_str(), true, |repo| {
            Some(resolve_push_remote(repo, Some("mirror".to_string())))
        });
        assert!(push.is_ok(), "no pushurl falls back to the url: {:?}", push);
    }

    #[test]
    fn a_multi_remote_push_is_refused_when_any_push_url_is_off_the_allowlist() {
        let repo = repo_with_split_push_url();
        let _guard = crate::services::security::test_support::allowlist(&["github.com"]);

        assert!(guard_push_destinations(&repo.path_str(), &["mirror".to_string()]).is_ok());
        let refused = guard_push_destinations(
            &repo.path_str(),
            &["mirror".to_string(), "origin".to_string()],
        );
        assert!(blocked_host(refused).contains("gitlab.example"));
    }

    /// `origin` on github.com, `backup` on a USB disk, and the current branch
    /// tracking whichever `tracks` names.
    fn repo_tracking(tracks: &str) -> TestRepo {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://github.com/me/app.git");
        repo.add_remote("backup", "/mnt/usb/app.git");
        let branch = repo.current_branch();
        let git = repo.repo();
        let mut cfg = git.config().unwrap();
        cfg.set_str(&format!("branch.{}.remote", branch), tracks)
            .unwrap();
        cfg.set_str(
            &format!("branch.{}.merge", branch),
            &format!("refs/heads/{}", branch),
        )
        .unwrap();
        drop(cfg);
        repo
    }

    /// Offline mode used to short-circuit this guard to
    /// `guard_remote(path, None)` on the belief that it "refuses everything" —
    /// which stopped being true when `check` grew the local-target carve-out.
    /// The short-circuit threw away both the remote the caller had just
    /// resolved and the push/fetch distinction, and judged the CURRENT
    /// BRANCH's tracking remote and its FETCH url instead.
    ///
    /// The serious direction is fail-OPEN: with the branch tracking a remote on
    /// a USB disk, a `fetch` from `origin` on github.com was judged on
    /// `/mnt/usb/app.git`, found local, and permitted — with offline mode on.
    /// Nothing downstream re-checks it: fetch and pull have no LFS guard behind
    /// them, so this backstop was the only gate left.
    #[test]
    fn offline_mode_judges_the_remote_the_caller_named_not_the_tracked_one() {
        let repo = repo_tracking("backup");
        let _guard = crate::services::security::test_support::offline();

        let fetch = guard_remote_op(&repo.path_str(), false, |repo| {
            Some(resolve_fetch_remote(repo, Some("origin".to_string())))
        });
        assert!(
            blocked_host(fetch).contains("Offline mode"),
            "a fetch from github.com is not excused by a local tracking remote"
        );
    }

    /// ...and the fail-CLOSED direction of the same line: the branch tracks
    /// `origin` on github.com, the user pushes to the USB disk, and the guard
    /// judged origin's github url and refused a push that never leaves the
    /// machine — the refusal the local-target carve-out exists to remove.
    #[test]
    fn offline_mode_permits_a_push_to_a_local_remote_the_branch_does_not_track() {
        let repo = repo_tracking("origin");
        let _guard = crate::services::security::test_support::offline();

        let push = guard_remote_op(&repo.path_str(), true, |repo| {
            Some(resolve_push_remote(repo, Some("backup".to_string())))
        });
        assert!(
            push.is_ok(),
            "a push to a USB disk opens no socket: {:?}",
            push
        );
    }

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

    /// A blocking task that cannot finish until the test says so.
    ///
    /// The timing these tests care about is causal, not measured: the caller
    /// gives up FIRST, the work lands LATER. A task that sleeps for "long
    /// enough" only reproduces that order when the machine honours the
    /// numbers, and under a loaded test run it does not — the blocking pool
    /// may not even have started the task by the time the timeout fires, or
    /// may finish it after the fixed wait the test then spends looking for
    /// the late report. Gating the task on a channel makes the order a fact:
    /// the timeout has already been reported when `release` is sent.
    fn gated_task<T: Send + 'static>(
        outcome: impl FnOnce() -> Result<T> + Send + 'static,
    ) -> (
        std::sync::mpsc::Sender<()>,
        tokio::task::JoinHandle<Result<T>>,
    ) {
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let handle = tokio::task::spawn_blocking(move || {
            let _ = gate.recv();
            outcome()
        });
        (release, handle)
    }

    /// A short timeout that the gated task above is guaranteed to miss.
    const ELAPSES_FIRST: Option<Duration> = Some(Duration::from_millis(10));

    /// Hand a task back once it has really finished, so awaiting it under a
    /// timeout exercises the "made the deadline" branch deterministically
    /// instead of racing the blocking pool against the clock.
    async fn settled<T>(handle: tokio::task::JoinHandle<T>) -> tokio::task::JoinHandle<T> {
        for _ in 0..1500 {
            if handle.is_finished() {
                return handle;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the blocking task never finished");
    }

    /// Panic out of a task the way `panic!` does — tokio catches the unwind
    /// and the `JoinError` reports it as a panic — but WITHOUT the panic hook.
    /// The hook is process-global: with `RUST_BACKTRACE` set it symbolicates
    /// the whole stack under a lock every other panicking test contends for,
    /// which on this binary costs seconds — spent before the task's join
    /// handle resolves, inside the window these tests are timing.
    fn unwind<T>(message: &'static str) -> T {
        std::panic::resume_unwind(Box::new(message))
    }

    /// `tokio::time::timeout` only DROPS the future it wraps — a
    /// `spawn_blocking` task keeps running. The merge landed minutes after the
    /// user was told the pull timed out, with no event and no refresh.
    #[tokio::test]
    async fn test_timed_out_task_still_reports_its_completion() {
        let (seen, on_late) = late_slot::<String>();
        let (release, handle) = gated_task(|| Ok("Merge completed".to_string()));

        let result = await_remote_task(ELAPSES_FIRST, "Pull", handle, on_late).await;

        match result {
            Err(GitnadoError::OperationTimeout(m)) => {
                assert_eq!(m, "Pull operation timed out");
            }
            other => panic!("expected a Pull timeout, got {:?}", other.map(|_| ())),
        }

        release.send(()).unwrap();
        match late_outcome(&seen).await {
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

        let result = await_remote_task(ELAPSES_FIRST, "Push", handle, on_late).await;
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
        let handle = settled(tokio::task::spawn_blocking(|| Ok(7u32))).await;

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
        let ended = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mark_ended = Arc::clone(&ended);
        let (release, handle) = gated_task(move || {
            mark_ended.store(true, std::sync::atomic::Ordering::SeqCst);
            Err(GitnadoError::OperationTimeout(
                "Pull operation timed out".to_string(),
            ))
        });

        let result = await_remote_task(ELAPSES_FIRST, "Pull", handle, on_late).await;
        assert!(matches!(result, Err(GitnadoError::OperationTimeout(_))));

        // Let the abandoned task end, and give the reporter its turn to
        // decide what to do with the outcome.
        release.send(()).unwrap();
        for _ in 0..250 {
            if ended.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(seen.lock().unwrap().is_none());
    }

    /// A timeout raised AFTER the fetch already wrote refs and FETCH_HEAD is
    /// not the "nothing happened" outcome the caller was told about: the
    /// repository changed, so the late reporter must still fire and the
    /// frontend must still refresh it.
    #[tokio::test]
    async fn test_a_timeout_after_the_repository_changed_is_still_reported() {
        let (seen, on_late) = late_slot::<()>();
        let (release, handle) = gated_task(|| {
            Err(GitnadoError::OperationTimeoutAfterChange(
                "Pull operation timed out".to_string(),
            ))
        });

        let result = await_remote_task(ELAPSES_FIRST, "Pull", handle, on_late).await;
        assert!(matches!(result, Err(GitnadoError::OperationTimeout(_))));

        release.send(()).unwrap();
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
        let (release, handle) = gated_task(|| -> Result<()> { unwind("boom") });

        let result = await_remote_task(ELAPSES_FIRST, "Pull", handle, on_late).await;
        assert!(matches!(result, Err(GitnadoError::OperationTimeout(_))));

        release.send(()).unwrap();
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
        let handle = settled(tokio::task::spawn_blocking(|| -> Result<()> {
            unwind("boom")
        }))
        .await;

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

    // ---- the push poll: reap first, cancel only what is still running ----
    //
    // `run_push_command` drives the `git push` child by hand so a Cancel can
    // kill it. Which of the two things it looks at first — the exit status or
    // the cancel flag — decides whether a push that already landed on the
    // remote is reported as the success it was.

    /// A child that has already exited, along with the status it exited with.
    fn already_exited_child(repo: &TestRepo) -> (std::process::Child, i32) {
        // Exits 128 without touching the network or the working tree.
        let mut child = std::process::Command::new("git")
            .arg("-C")
            .arg(repo.path_str())
            .arg("rev-parse")
            .arg("--verify")
            .arg("refs/heads/gitnado-no-such-branch")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("git must be on PATH");
        let status = child.wait().expect("the child must exit");
        (child, status.code().expect("a normal exit"))
    }

    /// A child that is still running, and stays running until it is killed.
    fn still_running_child() -> std::process::Child {
        // Reads stdin until EOF; the pipe is held open here, so EOF never
        // comes and the child is reliably alive when the cancel lands.
        std::process::Command::new("git")
            .arg("hash-object")
            .arg("--stdin")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("git must be on PATH")
    }

    /// The regression. The poll sleeps 100ms between iterations, so a push can
    /// finish during a sleep and the user can click Cancel before the loop
    /// wakes. Reading the flag first turned that into `OperationCancelled` for
    /// a `--force-with-lease` that HAD already overwritten the remote branch:
    /// "Push cancelled" in the toast, no Output panel entry, no refresh, and a
    /// user who believes nothing reached the remote. The real exit status must
    /// win over a cancel that arrived too late.
    #[test]
    fn a_push_that_already_exited_is_reported_with_its_real_status() {
        let repo = TestRepo::with_initial_commit();
        let (mut child, real_code) = already_exited_child(&repo);

        let (monitor, token, _events) = cancellable_monitor("op-late-cancel");
        token.cancel();

        match poll_push_child(&mut child, &monitor) {
            PushOutcome::Finished(status) => assert_eq!(
                status.code(),
                Some(real_code),
                "the status the push really exited with must survive"
            ),
            PushOutcome::Cancelled => panic!(
                "a push that had already finished was reported as cancelled — \
                 the remote has been written, the user is told it was not"
            ),
            PushOutcome::WaitFailed(e) => panic!("unexpected wait failure: {}", e),
        }
    }

    /// The other direction, which the fix above must not break: a Cancel that
    /// arrives while the push is genuinely still running still stops it.
    #[test]
    fn a_push_still_running_when_the_cancel_arrives_is_cancelled() {
        let mut child = still_running_child();

        let (monitor, token, _events) = cancellable_monitor("op-live-cancel");
        token.cancel();

        let outcome = poll_push_child(&mut child, &monitor);

        // Clean up before asserting, so a failure does not leak the child.
        let _ = child.kill();
        let _ = child.wait();

        assert!(
            matches!(outcome, PushOutcome::Cancelled),
            "a push still in flight must be stoppable"
        );
    }

    /// A child that exited successfully, already reaped.
    fn exited_successfully_child(repo: &TestRepo) -> std::process::Child {
        let mut child = std::process::Command::new("git")
            .arg("-C")
            .arg(repo.path_str())
            .arg("rev-parse")
            .arg("HEAD")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("git must be on PATH");
        assert!(child.wait().expect("the child must exit").success());
        child
    }

    /// The residual window the reap-first ordering left open: the poll reads
    /// the cancel flag AFTER `try_wait` reports the child still running, and a
    /// push that exits between those two reads is handed over as `Cancelled`.
    /// That interleaving is a few instructions wide and cannot be driven
    /// deterministically from outside the loop, so the property is pinned at
    /// the point of decision: a child handed over as cancelled that `wait`
    /// then reports as a success is a push that landed, and is reported with
    /// that status rather than as "Push cancelled".
    #[test]
    fn a_push_that_exited_successfully_before_the_kill_is_reported_as_finished() {
        let repo = TestRepo::with_initial_commit();
        let mut child = exited_successfully_child(&repo);

        match reap_abandoned_push(&mut child, PushOutcome::Cancelled) {
            PushOutcome::Finished(status) => assert!(status.success()),
            PushOutcome::Cancelled => panic!(
                "a push that had exited 0 was reported as cancelled — the remote has been \
                 written, the user is told it was not"
            ),
            PushOutcome::WaitFailed(e) => panic!("unexpected wait failure: {}", e),
        }
    }

    /// The balancing half: a child that really was still running is killed,
    /// and the kill's status must not be mistaken for a landed push.
    #[test]
    fn a_push_killed_while_still_running_stays_cancelled() {
        let mut child = still_running_child();

        let outcome = reap_abandoned_push(&mut child, PushOutcome::Cancelled);

        assert!(
            matches!(outcome, PushOutcome::Cancelled),
            "a killed push must not be reported as landed"
        );
        assert!(
            child.try_wait().expect("reaped").is_some(),
            "the child must have been reaped"
        );
    }

    /// An uncancelled run reaches the end of `run_push_command`: the output is
    /// collected from the drain threads and the run is reported to the Output
    /// panel (`report_run`), which is exactly what the late-cancel bug skipped.
    #[test]
    fn a_finished_push_command_returns_its_captured_output() {
        let repo = TestRepo::with_initial_commit();
        let mut cmd = create_command("git");
        cmd.arg("-C")
            .arg(repo.path_str())
            .arg("rev-parse")
            .arg("--verify")
            .arg("refs/heads/gitnado-no-such-branch");

        let output = run_push_command(cmd, &TransferMonitor::disabled())
            .expect("a completed command must be returned, not an error");

        assert_eq!(output.status.code(), Some(128));
        assert!(
            !output.stderr.is_empty(),
            "stderr must be drained and carried into the reported output"
        );
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

    #[test]
    fn test_pull_with_deleted_upstream_reports_clear_error() {
        let (_upstream, local, _branch) = pull_fixture();
        // Create a local branch configured to track a remote branch that was
        // deleted on origin (matching `git branch -vv` -> `[origin/gone-branch: gone]`).
        local.create_branch("gone-branch");
        local.checkout_branch("gone-branch");
        let repo = local.repo();
        let mut config = repo.config().unwrap();
        config
            .set_str("branch.gone-branch.remote", "origin")
            .unwrap();
        config
            .set_str("branch.gone-branch.merge", "refs/heads/gone-branch")
            .unwrap();
        drop(config);
        drop(repo);

        let err = pull_with_deadline(&local, "gone-branch", None)
            .expect_err("pulling a branch whose upstream was deleted on remote must fail");
        let msg = err.to_string();
        assert!(
            msg.contains("no longer exists on remote"),
            "expected clear gone-upstream message, got: {msg}"
        );
    }
}
