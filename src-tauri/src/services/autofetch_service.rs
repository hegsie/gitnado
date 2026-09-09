//! Auto-fetch service for periodic repository fetching

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::Notify;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

const FETCH_REMOTE_CHANGED: &str = "FETCH_REMOTE_CHANGED";

/// Auto-fetch state for a single repository
struct RepoFetchState {
    task: JoinHandle<()>,
    trigger: Arc<Notify>,
}

/// Global auto-fetch service state
pub struct AutoFetchService {
    repos: HashMap<String, RepoFetchState>,
}

impl Default for AutoFetchService {
    fn default() -> Self {
        Self::new()
    }
}

impl AutoFetchService {
    pub fn new() -> Self {
        Self {
            repos: HashMap::new(),
        }
    }

    /// Start auto-fetching for a repository
    pub fn start(
        &mut self,
        repo_path: String,
        interval_minutes: u32,
        remote: String,
        remote_url: String,
        token: Option<String>,
        app_handle: tauri::AppHandle,
    ) {
        // Stop any existing task for this repo
        self.stop(&repo_path);

        let path = repo_path.clone();
        let interval = Duration::from_secs(interval_minutes as u64 * 60);
        let initial_delay = interval + stagger_offset(&repo_path, interval);
        let trigger = Arc::new(Notify::new());
        let task_trigger = Arc::clone(&trigger);

        let task = tokio::spawn(async move {
            // The first tick is staggered per repo so that many open repos
            // don't all fetch at the same instant (thundering herd on every
            // interval boundary); afterwards each repo keeps its own cadence.
            tokio::select! {
                _ = tokio::time::sleep(initial_delay) => {}
                _ = task_trigger.notified() => {}
            }
            loop {
                // Perform fetch
                tracing::info!("Auto-fetching repository: {}", path);

                match perform_fetch(&path, &remote, &remote_url, token.clone()).await {
                    Ok(status) => {
                        tracing::info!("Auto-fetch complete for {}: {:?}", path, status);

                        // Emit event about remote status
                        let _ = app_handle.emit(
                            "autofetch-completed",
                            AutoFetchEvent {
                                repo_path: path.clone(),
                                success: true,
                                behind: status.behind,
                                ahead: status.ahead,
                                message: None,
                            },
                        );

                        // If there are remote updates, emit a separate event
                        if status.behind > 0 {
                            let _ = app_handle.emit(
                                "remote-updates-available",
                                RemoteUpdatesEvent {
                                    repo_path: path.clone(),
                                    behind: status.behind,
                                    ahead: status.ahead,
                                },
                            );
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Auto-fetch failed for {}: {}", path, e);

                        let _ = app_handle.emit(
                            "autofetch-completed",
                            AutoFetchEvent {
                                repo_path: path.clone(),
                                success: false,
                                behind: 0,
                                ahead: 0,
                                message: Some(e.to_string()),
                            },
                        );
                    }
                }

                tokio::select! {
                    _ = tokio::time::sleep(interval) => {}
                    _ = task_trigger.notified() => {}
                }
            }
        });

        self.repos
            .insert(repo_path, RepoFetchState { task, trigger });
    }

    pub fn trigger(&self, repo_path: &str) -> bool {
        let Some(state) = self.repos.get(repo_path) else {
            return false;
        };
        state.trigger.notify_one();
        true
    }

    /// Stop auto-fetching for a repository
    pub fn stop(&mut self, repo_path: &str) {
        if let Some(state) = self.repos.remove(repo_path) {
            state.task.abort();
        }
    }

    /// Stop all auto-fetch tasks
    pub fn stop_all(&mut self) {
        for (_, state) in self.repos.drain() {
            state.task.abort();
        }
    }

    /// Check if auto-fetch is running for a repository
    pub fn is_running(&self, repo_path: &str) -> bool {
        self.repos.contains_key(repo_path)
    }
}

/// Remote status information
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub ahead: usize,
    pub behind: usize,
    pub has_upstream: bool,
    pub upstream_name: Option<String>,
}

/// Auto-fetch completion event
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoFetchEvent {
    repo_path: String,
    success: bool,
    behind: usize,
    ahead: usize,
    message: Option<String>,
}

/// Remote updates available event
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteUpdatesEvent {
    repo_path: String,
    behind: usize,
    ahead: usize,
}

/// Deterministic per-repo stagger within [0, interval/2), derived from the
/// repo path. Keeps simultaneous fetches for many open repos spread out
/// without needing shared state or randomness.
fn stagger_offset(repo_path: &str, interval: Duration) -> Duration {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let half = interval.as_secs() / 2;
    if half == 0 {
        return Duration::ZERO;
    }
    let mut hasher = DefaultHasher::new();
    repo_path.hash(&mut hasher);
    Duration::from_secs(hasher.finish() % half)
}

/// Perform a fetch operation
async fn perform_fetch(
    repo_path: &str,
    remote_name: &str,
    expected_remote_url: &str,
    token: Option<String>,
) -> Result<RemoteStatus, String> {
    let path = repo_path.to_string();
    let remote_name = remote_name.to_string();
    let expected_remote_url = expected_remote_url.to_string();

    // Re-checked every cycle, not just when the loop was started: this is a
    // long-lived task, and turning offline mode on mid-session used to leave it
    // fetching every N minutes regardless.
    if let Err(e) = crate::services::security::guard_remote_url(&expected_remote_url) {
        return Err(e.to_string());
    }

    tokio::task::spawn_blocking(move || {
        let repo =
            git2::Repository::open(&path).map_err(|e| format!("Failed to open repo: {}", e))?;

        // A branch switch can change the fetch destination. Stop before using
        // credentials authorized for the previous remote; the frontend will
        // restart this loop after re-running permission and token resolution.
        let current_remote = crate::commands::remote::resolve_fetch_remote(&repo, None);
        if current_remote != remote_name {
            return Err(FETCH_REMOTE_CHANGED.to_string());
        }

        let mut remote = repo
            .find_remote(&remote_name)
            .map_err(|e| format!("Failed to find remote: {}", e))?;
        if remote.url().ok() != Some(expected_remote_url.as_str()) {
            return Err(FETCH_REMOTE_CHANGED.to_string());
        }

        // Use the shared credentials helper (reads from OS keyring via `security` CLI
        // on macOS, avoiding Keychain authorization dialogs)
        // Hard-coding None here meant the background loop could only ever
        // authenticate via SSH or an OS-keyring credential: on a
        // token-authenticated HTTPS remote every cycle failed, and the failure
        // was swallowed by the UI, so the ahead/behind badge silently froze.
        let mut fetch_opts = crate::services::credentials_service::get_fetch_options(token);

        // Perform fetch
        remote
            .fetch(&[] as &[&str], Some(&mut fetch_opts), None)
            .map_err(|e| format!("Fetch failed: {}", e))?;

        // Get remote status
        get_remote_status_internal(&repo)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Get remote status (ahead/behind counts)
fn get_remote_status_internal(repo: &git2::Repository) -> Result<RemoteStatus, String> {
    let head = repo.head().map_err(|e| format!("No HEAD: {}", e))?;

    // A detached HEAD has no branch, so it has no upstream to compare against —
    // that is "nothing to report", not a failure.
    //
    // shorthand() returns the literal "HEAD" when detached, so find_branch
    // missed and perform_fetch returned Err AFTER the network fetch had already
    // succeeded. The loop then reported success:false and the user got
    // "auto-fetch failed — Branch not found" simply for checking out a commit
    // or a tag, which is a routine way to inspect history in this app.
    if !head.is_branch() {
        return Ok(RemoteStatus {
            ahead: 0,
            behind: 0,
            has_upstream: false,
            upstream_name: None,
        });
    }

    let branch_name = head
        .shorthand()
        .map_err(|_| "Invalid branch name".to_string())?;

    // Try to find upstream
    let local_branch = repo
        .find_branch(branch_name, git2::BranchType::Local)
        .map_err(|e| format!("Branch not found: {}", e))?;

    let upstream = match local_branch.upstream() {
        Ok(upstream) => upstream,
        Err(_) => {
            return Ok(RemoteStatus {
                ahead: 0,
                behind: 0,
                has_upstream: false,
                upstream_name: None,
            });
        }
    };

    let upstream_name = upstream.name().ok().flatten().map(|s| s.to_string());

    let local_oid = head.target().ok_or_else(|| "No local target".to_string())?;

    let upstream_oid = upstream
        .get()
        .target()
        .ok_or_else(|| "No upstream target".to_string())?;

    let (ahead, behind) = repo
        .graph_ahead_behind(local_oid, upstream_oid)
        .map_err(|e| format!("Failed to compare: {}", e))?;

    Ok(RemoteStatus {
        ahead,
        behind,
        has_upstream: true,
        upstream_name,
    })
}

/// Global auto-fetch state
pub type AutoFetchState = Arc<RwLock<AutoFetchService>>;

/// Create default auto-fetch state
pub fn create_autofetch_state() -> AutoFetchState {
    Arc::new(RwLock::new(AutoFetchService::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    /// A detached HEAD has no branch and therefore no upstream. Reporting that
    /// as an ERROR made auto-fetch return failure AFTER the network fetch had
    /// already succeeded, so checking out a commit or a tag — a routine way to
    /// inspect history here — produced "auto-fetch failed — Branch not found".
    #[test]
    fn test_remote_status_on_detached_head_is_not_an_error() {
        let test_repo = TestRepo::with_initial_commit();
        let repo = test_repo.repo();

        let head_oid = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.set_head_detached(head_oid).unwrap();
        assert!(!repo.head().unwrap().is_branch(), "HEAD should be detached");

        let status = get_remote_status_internal(&repo).expect("detached HEAD must not error");

        assert_eq!(status.ahead, 0);
        assert_eq!(status.behind, 0);
        assert!(!status.has_upstream);
        assert!(status.upstream_name.is_none());
    }

    /// The timer must use the remote resolved by the frontend for its permission
    /// check and token selection.
    #[tokio::test]
    async fn test_perform_fetch_uses_the_resolved_remote() {
        let upstream = TestRepo::with_initial_commit();
        let consumer = TestRepo::with_initial_commit();

        {
            let repo = consumer.repo();
            repo.remote("upstream", &upstream.path.to_string_lossy())
                .unwrap();
            assert!(repo.find_remote("origin").is_err(), "origin must not exist");
        }

        let result = perform_fetch(
            &consumer.path_str(),
            "upstream",
            &upstream.path.to_string_lossy(),
            None,
        )
        .await;

        assert!(
            result.is_ok(),
            "auto-fetch must use the resolved remote, got: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_perform_fetch_rejects_a_changed_remote() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo
            .repo()
            .remote("upstream", "https://example.com/repo.git")
            .unwrap();

        let error = perform_fetch(
            &test_repo.path_str(),
            "origin",
            "https://example.com/repo.git",
            None,
        )
        .await
        .unwrap_err();

        assert_eq!(error, FETCH_REMOTE_CHANGED);
    }

    #[tokio::test]
    async fn test_perform_fetch_rejects_a_changed_remote_url() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo
            .repo()
            .remote("origin", "https://attacker.example/repo.git")
            .unwrap();

        let error = perform_fetch(
            &test_repo.path_str(),
            "origin",
            "https://github.com/example/repo.git",
            Some("secret".to_string()),
        )
        .await
        .unwrap_err();

        assert_eq!(error, FETCH_REMOTE_CHANGED);
    }

    /// The frontend restarts the loop after a fetch-remote change and then
    /// triggers it, so the badge refreshes now instead of a full interval
    /// later. A trigger for a repo with no loop must report that rather than
    /// pretend it worked — the command turns that `false` into the error the
    /// caller logs.
    #[tokio::test]
    async fn test_trigger_wakes_a_parked_loop_and_reports_unknown_repos() {
        let mut service = AutoFetchService::new();
        assert!(
            !service.trigger("/repo/one"),
            "a repo with no loop has nothing to wake"
        );

        let trigger = Arc::new(Notify::new());
        let waiter = Arc::clone(&trigger);
        // Stands in for the loop's `select!` arm: parked until the trigger fires.
        let task = tokio::spawn(async move { waiter.notified().await });
        service
            .repos
            .insert("/repo/one".to_string(), RepoFetchState { task, trigger });

        assert!(service.trigger("/repo/one"), "a running loop is woken");

        // `notify_one` stores a permit when nobody is waiting yet, so a trigger
        // issued right after `start` — before the task has reached its first
        // await — is not lost.
        let state = service.repos.remove("/repo/one").unwrap();
        tokio::time::timeout(Duration::from_secs(5), state.task)
            .await
            .expect("the parked loop must wake on a trigger")
            .expect("the loop task must not panic");

        assert!(
            !service.trigger("/repo/one"),
            "a stopped loop is no longer triggerable"
        );
    }

    #[test]
    fn test_stagger_offset_is_deterministic() {
        let interval = Duration::from_secs(300);
        assert_eq!(
            stagger_offset("/repo/one", interval),
            stagger_offset("/repo/one", interval)
        );
    }

    #[test]
    fn test_stagger_offset_within_half_interval() {
        let interval = Duration::from_secs(300);
        for path in ["/a", "/b", "/c/deep/path", "/repo with spaces"] {
            let offset = stagger_offset(path, interval);
            assert!(
                offset < Duration::from_secs(150),
                "offset {offset:?} for {path}"
            );
        }
    }

    #[test]
    fn test_stagger_offset_spreads_different_repos() {
        let interval = Duration::from_secs(600);
        let offsets: std::collections::HashSet<u64> = (0..20)
            .map(|i| stagger_offset(&format!("/repo/{i}"), interval).as_secs())
            .collect();
        // 20 repos over a 300s window: requiring at least a few distinct
        // slots keeps the test robust while catching a constant offset.
        assert!(offsets.len() > 5, "expected spread, got {offsets:?}");
    }

    #[test]
    fn test_stagger_offset_zero_interval() {
        assert_eq!(stagger_offset("/repo", Duration::ZERO), Duration::ZERO);
        assert_eq!(
            stagger_offset("/repo", Duration::from_secs(1)),
            Duration::ZERO
        );
    }
}
