//! File system watcher commands
//!
//! Any number of repositories can be watched at once (one per open tab).
//! Events emitted to the frontend carry the repository path they belong to.
//! A single poller thread serves all watchers; it exits when the last
//! watcher is removed and is restarted on demand, so threads never
//! accumulate no matter how often watching starts and stops.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{command, AppHandle, Emitter, State};

use crate::error::Result;
use crate::services::WatcherService;

/// Managed state for the file watcher
pub struct WatcherState {
    pub service: Arc<Mutex<WatcherService>>,
    /// True while the poller thread is alive. Guards against spawning more
    /// than one poller.
    pub poller_running: Arc<AtomicBool>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self {
            service: Arc::new(Mutex::new(WatcherService::new())),
            poller_running: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// Events emitted to the frontend
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeEvent {
    pub repo_path: String,
    pub event_type: String,
    pub paths: Vec<String>,
}

/// Start watching a repository for file changes. Repositories already being
/// watched are unaffected; watching the same repository twice is a no-op.
#[command]
pub async fn start_watching(
    app: AppHandle,
    state: State<'_, WatcherState>,
    path: String,
) -> Result<()> {
    {
        let mut service = state.service.lock().map_err(|_| {
            crate::error::GitnadoError::OperationFailed("Watcher lock poisoned".to_string())
        })?;
        service.watch(Path::new(&path))?;
    }

    // Spawn the shared poller thread if it isn't already running. The
    // compare_exchange guarantees at most one poller exists regardless of how
    // many repos are watched or how often watching is toggled.
    if state
        .poller_running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let service = Arc::clone(&state.service);
        let poller_running = Arc::clone(&state.poller_running);

        thread::spawn(move || {
            loop {
                // Poll for events; exit when the last watcher is gone.
                //
                // The exit flag MUST be flipped while the service lock is
                // still held: start_watching registers its watcher under this
                // same lock BEFORE checking the flag, so either it sees the
                // flag already false (and spawns a replacement poller) or
                // this thread sees the new watcher and keeps running. Storing
                // the flag after releasing the lock would open a window where
                // a watcher is registered but no poller ever serves it.
                let events = {
                    let Ok(service) = service.lock() else {
                        // Mutex poisoned — nothing sane left to do
                        poller_running.store(false, Ordering::SeqCst);
                        break;
                    };
                    if service.watcher_count() == 0 {
                        poller_running.store(false, Ordering::SeqCst);
                        break;
                    }
                    service.poll_events()
                };

                // Emit events to frontend
                for (repo_path, event) in events {
                    let (event_type, paths) = match event {
                        crate::services::watcher_service::WatcherEvent::WorkdirChanged(p) => (
                            "workdir-changed",
                            p.iter().map(|p| p.to_string_lossy().to_string()).collect(),
                        ),
                        crate::services::watcher_service::WatcherEvent::IndexChanged => {
                            ("index-changed", vec![])
                        }
                        crate::services::watcher_service::WatcherEvent::RefsChanged => {
                            ("refs-changed", vec![])
                        }
                        crate::services::watcher_service::WatcherEvent::ConfigChanged => {
                            ("config-changed", vec![])
                        }
                    };

                    let _ = app.emit(
                        "file-change",
                        FileChangeEvent {
                            repo_path: repo_path.clone(),
                            event_type: event_type.to_string(),
                            paths,
                        },
                    );
                }

                // Sleep before next poll
                thread::sleep(Duration::from_millis(500));
            }
        });
    }

    Ok(())
}

/// Stop watching a repository. With no path, stop watching all repositories
/// (used on app shutdown).
#[command]
pub async fn stop_watching(state: State<'_, WatcherState>, path: Option<String>) -> Result<()> {
    let mut service = state.service.lock().map_err(|_| {
        crate::error::GitnadoError::OperationFailed("Watcher lock poisoned".to_string())
    })?;

    match path {
        Some(p) => service.unwatch(Path::new(&p))?,
        None => service.unwatch_all(),
    }
    // When the last watcher is removed the poller thread notices
    // watcher_count() == 0 on its next tick and exits.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::watcher_service::WatcherEvent;
    use crate::test_utils::TestRepo;

    #[test]
    fn test_watcher_state_default() {
        let state = WatcherState::default();

        // Should have an empty watcher service
        let service = state.service.lock().unwrap();
        assert!(service.poll_events().is_empty());
        assert_eq!(service.watcher_count(), 0);

        // No poller thread yet
        assert!(!state.poller_running.load(Ordering::SeqCst));
    }

    #[test]
    fn test_file_change_event_serialization() {
        let event = FileChangeEvent {
            repo_path: "/repo/one".to_string(),
            event_type: "workdir-changed".to_string(),
            paths: vec![
                "/path/to/file.txt".to_string(),
                "/path/to/other.rs".to_string(),
            ],
        };

        let json = serde_json::to_string(&event).unwrap();

        // Check camelCase serialization
        assert!(json.contains("repoPath"));
        assert!(json.contains("/repo/one"));
        assert!(json.contains("eventType"));
        assert!(json.contains("workdir-changed"));
        assert!(json.contains("paths"));
        assert!(json.contains("/path/to/file.txt"));
    }

    #[test]
    fn test_file_change_event_empty_paths() {
        let event = FileChangeEvent {
            repo_path: "/repo/one".to_string(),
            event_type: "index-changed".to_string(),
            paths: vec![],
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("index-changed"));
        assert!(json.contains("[]"));
    }

    #[test]
    fn test_watcher_service_watch_valid_path() {
        let repo = TestRepo::with_initial_commit();
        let mut service = WatcherService::new();

        let result = service.watch(&repo.path);
        assert!(result.is_ok());
        assert_eq!(service.watcher_count(), 1);

        // Should be able to unwatch
        let unwatch_result = service.unwatch(&repo.path);
        assert!(unwatch_result.is_ok());
        assert_eq!(service.watcher_count(), 0);
    }

    #[test]
    fn test_watcher_service_watch_multiple_repos_concurrently() {
        let repo1 = TestRepo::with_initial_commit();
        let repo2 = TestRepo::with_initial_commit();
        let mut service = WatcherService::new();

        service.watch(&repo1.path).unwrap();
        service.watch(&repo2.path).unwrap();
        assert_eq!(service.watcher_count(), 2);

        // Unwatching one repo must not affect the other
        service.unwatch(&repo1.path).unwrap();
        assert_eq!(service.watcher_count(), 1);

        service.unwatch(&repo2.path).unwrap();
        assert_eq!(service.watcher_count(), 0);
    }

    #[test]
    fn test_watcher_service_watch_same_repo_twice_is_noop() {
        let repo = TestRepo::with_initial_commit();
        let mut service = WatcherService::new();

        service.watch(&repo.path).unwrap();
        service.watch(&repo.path).unwrap();
        assert_eq!(service.watcher_count(), 1);
    }

    #[test]
    fn test_watcher_service_unwatch_all() {
        let repo1 = TestRepo::with_initial_commit();
        let repo2 = TestRepo::with_initial_commit();
        let mut service = WatcherService::new();

        service.watch(&repo1.path).unwrap();
        service.watch(&repo2.path).unwrap();
        service.unwatch_all();
        assert_eq!(service.watcher_count(), 0);
    }

    #[test]
    fn test_watcher_service_watch_invalid_path() {
        let mut service = WatcherService::new();
        let invalid_path = Path::new("/this/path/definitely/does/not/exist");

        let result = service.watch(invalid_path);
        // This might succeed on some systems (notify creates the path)
        // or fail if the path is truly invalid
        // The important thing is it doesn't panic
        let _ = result;
    }

    #[test]
    fn test_watcher_service_poll_events_empty() {
        let service = WatcherService::new();

        // Should return empty events when nothing is being watched
        let events = service.poll_events();
        assert!(events.is_empty());
    }

    #[test]
    fn test_watcher_service_unwatch_when_not_watching() {
        let mut service = WatcherService::new();
        let path = Path::new("/some/path");

        // Unwatching when not watching should be a no-op, not a panic
        let result = service.unwatch(path);
        assert!(result.is_ok());
    }

    #[test]
    fn test_watcher_service_default() {
        let service = WatcherService::default();
        assert!(service.poll_events().is_empty());
    }

    #[test]
    fn test_watcher_service_multiple_watch_unwatch() {
        let repo = TestRepo::with_initial_commit();
        let mut service = WatcherService::new();

        // Watch
        service.watch(&repo.path).unwrap();

        // Unwatch
        service.unwatch(&repo.path).unwrap();

        // Watch again should work
        service.watch(&repo.path).unwrap();

        // Unwatch again
        service.unwatch(&repo.path).unwrap();
    }

    #[test]
    fn test_watcher_events_are_tagged_with_repo_path() {
        let repo = TestRepo::with_initial_commit();
        let mut service = WatcherService::new();
        service.watch(&repo.path).unwrap();

        // Touch a file in the working directory
        std::fs::write(repo.path.join("watched-file.txt"), "hello").unwrap();

        // The notify backend delivers asynchronously; poll with a deadline
        let expected_key = repo.path.to_string_lossy().to_string();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut tagged_correctly = false;
        while std::time::Instant::now() < deadline {
            for (repo_path, _event) in service.poll_events() {
                assert_eq!(repo_path, expected_key);
                tagged_correctly = true;
            }
            if tagged_correctly {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        assert!(tagged_correctly, "expected at least one tagged event");
    }

    #[test]
    fn test_watcher_event_workdir_changed() {
        use std::path::PathBuf;

        let paths = vec![
            PathBuf::from("/repo/file1.txt"),
            PathBuf::from("/repo/src/main.rs"),
        ];
        let event = WatcherEvent::WorkdirChanged(paths.clone());

        // Test that we can pattern match the event
        match event {
            WatcherEvent::WorkdirChanged(p) => {
                assert_eq!(p.len(), 2);
                assert_eq!(p[0], PathBuf::from("/repo/file1.txt"));
            }
            _ => panic!("Expected WorkdirChanged event"),
        }
    }

    #[test]
    fn test_watcher_event_index_changed() {
        let event = WatcherEvent::IndexChanged;

        match event {
            WatcherEvent::IndexChanged => {}
            _ => panic!("Expected IndexChanged event"),
        }
    }

    #[test]
    fn test_watcher_event_refs_changed() {
        let event = WatcherEvent::RefsChanged;

        match event {
            WatcherEvent::RefsChanged => {}
            _ => panic!("Expected RefsChanged event"),
        }
    }

    #[test]
    fn test_watcher_event_config_changed() {
        let event = WatcherEvent::ConfigChanged;

        match event {
            WatcherEvent::ConfigChanged => {}
            _ => panic!("Expected ConfigChanged event"),
        }
    }

    #[test]
    fn test_watcher_state_concurrent_access() {
        use std::thread;

        let state = WatcherState::default();
        let service_clone = Arc::clone(&state.service);

        // Spawn a thread that reads the state
        let handle = thread::spawn(move || {
            let service = service_clone.lock().unwrap();
            let events = service.poll_events();
            events.is_empty()
        });

        // Main thread also reads
        {
            let service = state.service.lock().unwrap();
            let _ = service.poll_events();
        }

        let result = handle.join().unwrap();
        assert!(result);
    }

    // Note: Testing the actual start_watching and stop_watching commands requires
    // a Tauri State wrapper which is only available in a running Tauri application context.
    // These functions are better tested through integration tests.
    // However, we can test the underlying WatcherService functionality directly.
}
