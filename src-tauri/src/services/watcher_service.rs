//! File system watcher service
//!
//! Watches any number of repositories at once. Every event is tagged with the
//! repository path it came from so consumers can route it to the right repo.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::Duration;

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};

use crate::error::{GitnadoError, Result};

/// Events emitted by the watcher
#[derive(Debug, Clone)]
pub enum WatcherEvent {
    /// Files in the working directory changed
    WorkdirChanged(Vec<PathBuf>),
    /// The git index changed
    IndexChanged,
    /// References (branches, tags) changed
    RefsChanged,
    /// Configuration changed
    ConfigChanged,
}

/// Service for watching file system changes across open repositories
pub struct WatcherService {
    watchers: HashMap<String, RecommendedWatcher>,
    event_tx: Sender<(String, Result<Event>)>,
    event_rx: Receiver<(String, Result<Event>)>,
}

impl WatcherService {
    /// Create a new WatcherService
    pub fn new() -> Self {
        let (event_tx, event_rx) = channel();
        Self {
            watchers: HashMap::new(),
            event_tx,
            event_rx,
        }
    }

    /// Start watching a repository. Watching the same path again is a no-op;
    /// other repositories already being watched are unaffected.
    pub fn watch(&mut self, repo_path: &Path) -> Result<()> {
        let key = repo_path.to_string_lossy().to_string();
        if self.watchers.contains_key(&key) {
            return Ok(());
        }

        let config = Config::default().with_poll_interval(Duration::from_secs(1));

        let tx = self.event_tx.clone();
        let event_key = key.clone();
        let mut watcher = RecommendedWatcher::new(
            move |result: std::result::Result<Event, notify::Error>| {
                let event = result
                    .map_err(|e| GitnadoError::OperationFailed(format!("Watch error: {}", e)));
                let _ = tx.send((event_key.clone(), event));
            },
            config,
        )
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to create watcher: {}", e)))?;

        watcher
            .watch(repo_path, RecursiveMode::Recursive)
            .map_err(|e| GitnadoError::OperationFailed(format!("Failed to watch: {}", e)))?;

        self.watchers.insert(key, watcher);
        Ok(())
    }

    /// Stop watching a repository. Other repositories keep their watchers.
    pub fn unwatch(&mut self, repo_path: &Path) -> Result<()> {
        let key = repo_path.to_string_lossy().to_string();
        if let Some(mut watcher) = self.watchers.remove(&key) {
            let _ = watcher.unwatch(repo_path);
        }
        Ok(())
    }

    /// Stop watching all repositories
    pub fn unwatch_all(&mut self) {
        self.watchers.clear();
    }

    /// Number of repositories currently being watched
    pub fn watcher_count(&self) -> usize {
        self.watchers.len()
    }

    /// Get pending events (non-blocking), each tagged with the repository
    /// path the event came from
    pub fn poll_events(&self) -> Vec<(String, WatcherEvent)> {
        let mut events = Vec::new();

        while let Ok((repo_path, result)) = self.event_rx.try_recv() {
            if let Ok(event) = result {
                if let Some(watcher_event) = Self::classify_event(&event) {
                    events.push((repo_path, watcher_event));
                }
            }
        }

        events
    }

    /// Classify a path inside a `.git` directory by its location relative to
    /// that directory.
    ///
    /// Returns `None` for the `.git` internals we do not act on (objects,
    /// logs, lock files, ...), so they fall through to the same "no event"
    /// outcome as before.
    fn classify_git_path(path: &Path) -> Option<WatcherEvent> {
        let components: Vec<&OsStr> = path.components().map(|c| c.as_os_str()).collect();
        // Use the LAST `.git` component so a nested repository or submodule is
        // classified against its own git directory, not an enclosing one.
        let git_index = components.iter().rposition(|c| *c == ".git")?;
        let relative = &components[git_index + 1..];
        let first = relative.first()?.to_string_lossy();

        match first.as_ref() {
            // Anything under refs/ (heads, remotes, tags, ...) is a ref update.
            "refs" => Some(WatcherEvent::RefsChanged),
            // Whole-name matches only, so "HEADER.md" or "index.lock" inside
            // the git directory are not mistaken for ref or index changes.
            "HEAD" | "ORIG_HEAD" | "FETCH_HEAD" | "MERGE_HEAD" | "packed-refs"
                if relative.len() == 1 =>
            {
                Some(WatcherEvent::RefsChanged)
            }
            "index" if relative.len() == 1 => Some(WatcherEvent::IndexChanged),
            "config" if relative.len() == 1 => Some(WatcherEvent::ConfigChanged),
            _ => None,
        }
    }

    /// Classify a notify event into our event types
    fn classify_event(event: &Event) -> Option<WatcherEvent> {
        let paths: Vec<PathBuf> = event.paths.clone();

        if paths.is_empty() {
            return None;
        }

        // Check if any path is in .git directory
        let git_paths: Vec<&PathBuf> = paths
            .iter()
            .filter(|p| p.components().any(|c| c.as_os_str() == ".git"))
            .collect();

        // Classify by the path RELATIVE to the .git directory. Substring
        // matching on the absolute path would misclassify every event in a
        // repository whose own path contains "index", "refs" or "HEAD"
        // (e.g. ~/dev/index-service).
        for path in &git_paths {
            if let Some(event) = Self::classify_git_path(path) {
                return Some(event);
            }
        }

        // Working directory changes
        let workdir_paths: Vec<PathBuf> = paths
            .into_iter()
            .filter(|p| !p.components().any(|c| c.as_os_str() == ".git"))
            .collect();

        if !workdir_paths.is_empty() {
            return Some(WatcherEvent::WorkdirChanged(workdir_paths));
        }

        None
    }
}

impl Default for WatcherService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::EventKind;

    fn event_for(paths: &[&str]) -> Event {
        let mut event = Event::new(EventKind::Any);
        event.paths = paths.iter().map(PathBuf::from).collect();
        event
    }

    fn classify(paths: &[&str]) -> Option<WatcherEvent> {
        WatcherService::classify_event(&event_for(paths))
    }

    fn workdir_paths(event: Option<WatcherEvent>) -> Vec<PathBuf> {
        match event {
            Some(WatcherEvent::WorkdirChanged(paths)) => paths,
            other => panic!("expected WorkdirChanged, got {:?}", other),
        }
    }

    #[test]
    fn test_classify_empty_paths_is_none() {
        assert!(classify(&[]).is_none());
    }

    // --- repository paths that used to poison the substring match ---

    #[test]
    fn test_repo_path_containing_index_still_classifies_refs() {
        assert!(matches!(
            classify(&["/home/user/dev/index-service/.git/refs/heads/main"]),
            Some(WatcherEvent::RefsChanged)
        ));
    }

    #[test]
    fn test_repo_path_containing_index_still_classifies_config() {
        assert!(matches!(
            classify(&["/home/user/dev/index-service/.git/config"]),
            Some(WatcherEvent::ConfigChanged)
        ));
    }

    #[test]
    fn test_repo_path_containing_refs_still_classifies_index() {
        assert!(matches!(
            classify(&["/home/user/prefs-editor/.git/index"]),
            Some(WatcherEvent::IndexChanged)
        ));
    }

    #[test]
    fn test_repo_path_containing_head_still_classifies_index() {
        assert!(matches!(
            classify(&["/home/user/HEADlines/.git/index"]),
            Some(WatcherEvent::IndexChanged)
        ));
    }

    // --- refs ---

    #[test]
    fn test_refs_heads_is_refs_changed() {
        assert!(matches!(
            classify(&["/repo/.git/refs/heads/feature/login"]),
            Some(WatcherEvent::RefsChanged)
        ));
    }

    #[test]
    fn test_refs_remotes_is_refs_changed() {
        assert!(matches!(
            classify(&["/repo/.git/refs/remotes/origin/main"]),
            Some(WatcherEvent::RefsChanged)
        ));
    }

    #[test]
    fn test_refs_tags_is_refs_changed() {
        assert!(matches!(
            classify(&["/repo/.git/refs/tags/v1.0.0"]),
            Some(WatcherEvent::RefsChanged)
        ));
    }

    #[test]
    fn test_packed_refs_is_refs_changed() {
        assert!(matches!(
            classify(&["/repo/.git/packed-refs"]),
            Some(WatcherEvent::RefsChanged)
        ));
    }

    #[test]
    fn test_head_files_are_refs_changed() {
        for path in [
            "/repo/.git/HEAD",
            "/repo/.git/ORIG_HEAD",
            "/repo/.git/FETCH_HEAD",
            "/repo/.git/MERGE_HEAD",
        ] {
            assert!(
                matches!(classify(&[path]), Some(WatcherEvent::RefsChanged)),
                "{} should be a ref change",
                path
            );
        }
    }

    // --- index / config ---

    #[test]
    fn test_index_is_index_changed() {
        assert!(matches!(
            classify(&["/repo/.git/index"]),
            Some(WatcherEvent::IndexChanged)
        ));
    }

    #[test]
    fn test_config_is_config_changed() {
        assert!(matches!(
            classify(&["/repo/.git/config"]),
            Some(WatcherEvent::ConfigChanged)
        ));
    }

    // --- git internals we deliberately ignore ---

    #[test]
    fn test_other_git_internals_are_ignored() {
        for path in [
            "/repo/.git/objects/ab/cdef0123456789",
            "/repo/.git/logs/HEAD",
            "/repo/.git/index.lock",
            "/repo/.git/config.lock",
            "/repo/.git/COMMIT_EDITMSG",
            "/repo/.git/modules/sub/index",
        ] {
            assert!(
                classify(&[path]).is_none(),
                "{} should not be classified",
                path
            );
        }
    }

    #[test]
    fn test_submodule_git_dir_classifies_against_its_own_git_dir() {
        assert!(matches!(
            classify(&["/repo/.git/modules/sub/.git/refs/heads/main"]),
            Some(WatcherEvent::RefsChanged)
        ));
    }

    // --- working directory files that look like git files ---

    #[test]
    fn test_worktree_index_html_is_workdir_change() {
        let paths = workdir_paths(classify(&["/repo/src/index.html"]));
        assert_eq!(paths, vec![PathBuf::from("/repo/src/index.html")]);
    }

    #[test]
    fn test_worktree_file_named_index_is_workdir_change() {
        let paths = workdir_paths(classify(&["/repo/index"]));
        assert_eq!(paths, vec![PathBuf::from("/repo/index")]);
    }

    #[test]
    fn test_worktree_file_named_config_is_workdir_change() {
        let paths = workdir_paths(classify(&["/repo/config"]));
        assert_eq!(paths, vec![PathBuf::from("/repo/config")]);
    }

    #[test]
    fn test_worktree_config_json_and_refs_dir_are_workdir_changes() {
        let paths = workdir_paths(classify(&["/repo/config.json", "/repo/refs/HEAD.md"]));
        assert_eq!(
            paths,
            vec![
                PathBuf::from("/repo/config.json"),
                PathBuf::from("/repo/refs/HEAD.md"),
            ]
        );
    }

    // --- mixed events ---

    #[test]
    fn test_git_classification_wins_over_workdir_paths() {
        assert!(matches!(
            classify(&["/repo/src/main.rs", "/repo/.git/refs/heads/main"]),
            Some(WatcherEvent::RefsChanged)
        ));
    }

    #[test]
    fn test_unclassified_git_path_falls_through_to_workdir_paths() {
        let paths = workdir_paths(classify(&[
            "/repo/.git/objects/ab/cdef0123456789",
            "/repo/src/main.rs",
        ]));
        assert_eq!(paths, vec![PathBuf::from("/repo/src/main.rs")]);
    }

    #[test]
    fn test_git_only_unclassified_event_is_none() {
        assert!(classify(&["/repo/.git/objects/pack/pack-abc.idx"]).is_none());
    }
}
