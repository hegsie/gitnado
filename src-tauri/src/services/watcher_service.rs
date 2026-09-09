//! File system watcher service
//!
//! Watches any number of repositories at once. Every event is tagged with the
//! repository path it came from so consumers can route it to the right repo.
//!
//! # Watch scopes
//!
//! A repository is watched through TWO narrow scopes instead of one blanket
//! recursive watch over the whole tree:
//!
//! 1. **The git directory** — the git dir itself, non-recursively (`HEAD`,
//!    `index`, `config`, `packed-refs`, `ORIG_HEAD`, …) plus `refs/`
//!    recursively. `objects/` and `lfs/` are therefore never watched at all: a
//!    `fetch` or a `git gc` writes thousands of loose objects there and
//!    nothing in the UI reacts to individual objects. Inside a linked worktree
//!    the shared common dir is watched too, so branch changes made elsewhere
//!    are still noticed.
//! 2. **The working tree** — every directory except well-known heavy
//!    build/dependency directories (`node_modules`, `target`, `dist`, `.venv`,
//!    …) *that git also ignores*. Requiring the ignore match means a repo that
//!    genuinely tracks a `dist/` or vendors `node_modules` keeps working.
//!
//! On Linux every watched directory costs one inotify watch descriptor, so a
//! blanket recursive watch over a monorepo exhausts `fs.inotify.max_user_watches`
//! and auto-refresh dies. Pruning keeps the descriptor count proportional to
//! the source tree rather than to the build output.
//!
//! Raw back-end events are coalesced by `notify-debouncer-full`, and the
//! debounced batches are further collapsed here into at most one event of each
//! kind per repository, so a burst of thousands of file writes reaches the
//! frontend as a handful of IPC messages.
//!
//! Events inside a git directory are classified by their path RELATIVE to that
//! directory, matching whole path components: a repository living in
//! `~/dev/index-service` must not have every event misfiled as an index
//! change, and `logs/HEAD` or `index.lock` must not be mistaken for the real
//! `HEAD` or `index`.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{Config, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};

use crate::error::{GitnadoError, Result};

/// How long raw file system events are collected before a batch is delivered.
/// A `git gc` or `fetch` fires its events far faster than this, so the whole
/// burst arrives as one batch.
const DEBOUNCE_TIMEOUT: Duration = Duration::from_millis(400);

/// Upper bound on how many working-tree paths are forwarded with a single
/// `WorkdirChanged` event. Consumers only use the event to know *that*
/// something changed, so truncating keeps the IPC payload bounded.
const MAX_WORKDIR_PATHS: usize = 256;

/// Safety valve on the number of watch roots registered for one repository.
/// The pruning plan normally produces a few dozen; this only bites on
/// pathological trees and stops us from melting the machine.
const MAX_WATCH_ROOTS: usize = 4096;

/// How deep the working-tree plan descends before it gives up and registers a
/// plain recursive watch. Guards against unbounded recursion on deep trees.
const MAX_PLAN_DEPTH: usize = 32;

/// Directory names inside the git directory that are never worth watching.
/// They are pure object storage: enormous, extremely high-churn, and nothing
/// in the UI reacts to an individual object file.
const EXCLUDED_GIT_DIRS: &[&str] = &["objects", "lfs"];

/// Heavy build/dependency directory names skipped in the working tree — but
/// only when git ignores them as well (see `should_skip_worktree_dir`).
const HEAVY_DIR_NAMES: &[&str] = &[
    "node_modules",
    "bower_components",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    "vendor",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".parcel-cache",
    ".turbo",
    ".gradle",
    ".terraform",
    ".cargo",
];

/// Platform-specific advice shown when the OS refuses more watches.
#[cfg(target_os = "linux")]
const WATCH_LIMIT_HINT: &str =
    "Raise the inotify limit to restore it, e.g. `sudo sysctl fs.inotify.max_user_watches=524288`.";
#[cfg(not(target_os = "linux"))]
const WATCH_LIMIT_HINT: &str =
    "Close some repositories or raise the operating system's file-watch limit to restore it.";

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

/// Everything the event side needs to know about a watched repository. Sent
/// along with each batch so classification never has to reach back into the
/// (mutex-guarded) service.
#[derive(Debug)]
struct RepoScope {
    /// Key events are tagged with — the repository path as the caller gave it
    key: String,
    /// Absolute path of this repository's git directory
    git_dir: PathBuf,
    /// Shared git directory; differs from `git_dir` inside a linked worktree
    common_dir: PathBuf,
}

type WatchMessage = (Arc<RepoScope>, DebounceEventResult);

/// One repository's debounced watcher plus the roots registered for it.
struct RepoWatch {
    debouncer: Debouncer<RecommendedWatcher, NoCache>,
    /// Working tree root, re-opened lazily when new directories appear
    worktree_root: PathBuf,
    /// Every path currently registered with the debouncer, with its mode
    roots: Vec<(PathBuf, RecursiveMode)>,
}

impl RepoWatch {
    /// True when `path` already falls inside something we watch.
    fn covers(&self, path: &Path) -> bool {
        self.roots.iter().any(|(root, mode)| match mode {
            RecursiveMode::Recursive => path.starts_with(root),
            RecursiveMode::NonRecursive => path == root,
        })
    }

    /// Register a planned set of watches, skipping anything already covered.
    /// Individual failures are logged rather than fatal: a directory can
    /// disappear between planning and registration.
    fn apply(&mut self, plan: Vec<(PathBuf, RecursiveMode)>) {
        for (path, mode) in plan {
            if self.roots.len() >= MAX_WATCH_ROOTS {
                tracing::warn!(
                    "watcher: watch-root limit ({}) reached for {}; deeper directories are not watched",
                    MAX_WATCH_ROOTS,
                    self.worktree_root.display()
                );
                break;
            }
            if self.covers(&path) {
                continue;
            }
            match self.debouncer.watch(&path, mode) {
                Ok(()) => self.roots.push((path, mode)),
                Err(e) => tracing::warn!("watcher: failed to watch {}: {}", path.display(), e),
            }
        }
    }

    /// Drop the watch on a path (and anything below it) that no longer exists.
    fn forget(&mut self, path: &Path) {
        if !self.roots.iter().any(|(root, _)| root.starts_with(path)) {
            return;
        }
        let _ = self.debouncer.unwatch(path);
        self.roots.retain(|(root, _)| !root.starts_with(path));
    }

    /// Keep the working-tree watch in step with directories created or removed
    /// since registration. Directories under a recursive root are handled by
    /// the back end itself; this only covers the non-recursive roots that the
    /// pruning plan produces around excluded directories.
    fn sync_directories(&mut self, paths: &[PathBuf]) {
        // Opening the repository is only worth it if a new directory actually
        // showed up, so do it lazily and at most once per batch.
        let mut repo: Option<Option<git2::Repository>> = None;

        for path in paths {
            if path.is_dir() {
                if self.covers(path) {
                    continue;
                }
                let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                    continue;
                };
                let repo =
                    repo.get_or_insert_with(|| git2::Repository::open(&self.worktree_root).ok());
                let root = self.worktree_root.as_path();
                let skip = |candidate: &Path, name: &str| {
                    should_skip_worktree_dir(repo.as_ref(), root, candidate, name)
                };
                if skip(path, &name) {
                    continue;
                }
                let plan = plan_worktree_watches(path, &skip);
                self.apply(plan);
            } else if !path.exists() {
                self.forget(path);
            }
        }
    }
}

/// Service for watching file system changes across open repositories
pub struct WatcherService {
    watchers: HashMap<String, RepoWatch>,
    event_tx: Sender<WatchMessage>,
    event_rx: Arc<Mutex<Receiver<WatchMessage>>>,
}

/// Blocking view onto the watcher's event queue.
///
/// Handed to the poller thread so it can wait for debounced batches WITHOUT
/// holding the service mutex — the old implementation slept in a fixed 500 ms
/// loop and forwarded every raw event individually.
#[derive(Clone)]
pub struct WatcherEventStream {
    rx: Arc<Mutex<Receiver<WatchMessage>>>,
}

impl WatcherEventStream {
    /// Wait up to `timeout` for the next debounced batch, then drain and
    /// coalesce everything else already queued. Returns an empty vector when
    /// nothing arrived.
    pub fn wait_events(&self, timeout: Duration) -> Vec<(String, WatcherEvent)> {
        let Ok(rx) = self.rx.lock() else {
            // Poisoned queue: back off instead of spinning
            std::thread::sleep(timeout);
            return Vec::new();
        };

        let mut messages = Vec::new();
        match rx.recv_timeout(timeout) {
            Ok(message) => messages.push(message),
            Err(RecvTimeoutError::Timeout) => return Vec::new(),
            Err(RecvTimeoutError::Disconnected) => {
                // The service is gone; back off so the caller can notice
                std::thread::sleep(timeout);
                return Vec::new();
            }
        }
        while let Ok(message) = rx.try_recv() {
            messages.push(message);
        }

        coalesce(messages)
    }
}

impl WatcherService {
    /// Create a new WatcherService
    pub fn new() -> Self {
        let (event_tx, event_rx) = channel();
        Self {
            watchers: HashMap::new(),
            event_tx,
            event_rx: Arc::new(Mutex::new(event_rx)),
        }
    }

    /// Start watching a repository. Watching the same path again is a no-op;
    /// other repositories already being watched are unaffected.
    pub fn watch(&mut self, repo_path: &Path) -> Result<()> {
        let key = repo_path.to_string_lossy().to_string();
        if self.watchers.contains_key(&key) {
            return Ok(());
        }

        let repo = git2::Repository::open(repo_path).ok();
        let (git_dir, common_dir) = resolve_git_dirs(repo.as_ref(), repo_path);

        let scope = Arc::new(RepoScope {
            key: key.clone(),
            git_dir: git_dir.clone(),
            common_dir: common_dir.clone(),
        });

        let config = Config::default().with_poll_interval(Duration::from_secs(1));
        let tx = self.event_tx.clone();
        let event_scope = Arc::clone(&scope);
        let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
            DEBOUNCE_TIMEOUT,
            None,
            move |result: DebounceEventResult| {
                let _ = tx.send((Arc::clone(&event_scope), result));
            },
            NoCache::new(),
            config,
        )
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to create watcher: {}", e)))?;

        let mut roots: Vec<(PathBuf, RecursiveMode)> = Vec::new();

        // Scope 1: the git directory. The first target (the git dir itself) is
        // mandatory — without it nothing would ever report a commit or a
        // branch switch.
        for (index, (path, mode)) in git_watch_targets(&git_dir, &common_dir)
            .into_iter()
            .enumerate()
        {
            match debouncer.watch(&path, mode) {
                Ok(()) => roots.push((path, mode)),
                Err(e) if index == 0 || is_watch_limit(&e) => return Err(watch_error(&path, &e)),
                Err(e) => tracing::warn!("watcher: failed to watch {}: {}", path.display(), e),
            }
        }

        // Scope 2: the working tree, pruned of heavy ignored directories.
        let skip = |candidate: &Path, name: &str| {
            should_skip_worktree_dir(repo.as_ref(), repo_path, candidate, name)
        };
        for (path, mode) in plan_worktree_watches(repo_path, &skip) {
            if roots.len() >= MAX_WATCH_ROOTS {
                tracing::warn!(
                    "watcher: watch-root limit ({}) reached for {}; deeper directories are not watched",
                    MAX_WATCH_ROOTS,
                    repo_path.display()
                );
                break;
            }
            match debouncer.watch(&path, mode) {
                Ok(()) => roots.push((path, mode)),
                Err(e) if path == repo_path || is_watch_limit(&e) => {
                    return Err(watch_error(&path, &e))
                }
                Err(e) => tracing::warn!("watcher: failed to watch {}: {}", path.display(), e),
            }
        }

        self.watchers.insert(
            key,
            RepoWatch {
                debouncer,
                worktree_root: repo_path.to_path_buf(),
                roots,
            },
        );
        Ok(())
    }

    /// Stop watching a repository. Other repositories keep their watchers.
    pub fn unwatch(&mut self, repo_path: &Path) -> Result<()> {
        let key = repo_path.to_string_lossy().to_string();
        // Dropping the debouncer stops its thread and releases every watch
        self.watchers.remove(&key);
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

    /// A blocking handle on the event queue for the poller thread.
    pub fn event_stream(&self) -> WatcherEventStream {
        WatcherEventStream {
            rx: Arc::clone(&self.event_rx),
        }
    }

    /// Get pending events (non-blocking), each tagged with the repository
    /// path the event came from.
    pub fn poll_events(&self) -> Vec<(String, WatcherEvent)> {
        let Ok(rx) = self.event_rx.lock() else {
            return Vec::new();
        };
        let mut messages = Vec::new();
        while let Ok(message) = rx.try_recv() {
            messages.push(message);
        }
        drop(rx);
        coalesce(messages)
    }

    /// Extend or trim the working-tree watch after directories appeared or
    /// disappeared. Call this with the events about to be forwarded.
    pub fn sync_directories(&mut self, events: &[(String, WatcherEvent)]) {
        for (key, event) in events {
            let WatcherEvent::WorkdirChanged(paths) = event else {
                continue;
            };
            if let Some(watch) = self.watchers.get_mut(key) {
                watch.sync_directories(paths);
            }
        }
    }
}

impl Default for WatcherService {
    fn default() -> Self {
        Self::new()
    }
}

/// Locate the git directory (and the shared common directory) for a path.
/// Falls back to `<path>/.git` when the repository cannot be opened, so an
/// unreadable or not-yet-created repository still produces a sane plan.
fn resolve_git_dirs(repo: Option<&git2::Repository>, repo_path: &Path) -> (PathBuf, PathBuf) {
    match repo {
        Some(repo) => (repo.path().to_path_buf(), repo.commondir().to_path_buf()),
        None => {
            let git_dir = repo_path.join(".git");
            (git_dir.clone(), git_dir)
        }
    }
}

/// The paths that make up the git scope. `objects/` and `lfs/` are excluded by
/// construction: the git dir is watched non-recursively, so only its direct
/// children (`HEAD`, `index`, `config`, `packed-refs`, …) plus `refs/` are
/// registered.
fn git_watch_targets(git_dir: &Path, common_dir: &Path) -> Vec<(PathBuf, RecursiveMode)> {
    let mut targets = vec![(git_dir.to_path_buf(), RecursiveMode::NonRecursive)];

    let refs = git_dir.join("refs");
    if refs.is_dir() {
        targets.push((refs, RecursiveMode::Recursive));
    }

    // A linked worktree keeps HEAD/index in its own git dir but shares refs
    // with the main repository, so both have to be watched.
    if common_dir != git_dir {
        targets.push((common_dir.to_path_buf(), RecursiveMode::NonRecursive));
        let common_refs = common_dir.join("refs");
        if common_refs.is_dir() {
            targets.push((common_refs, RecursiveMode::Recursive));
        }
    }

    targets
}

/// True for directory names that are pure build/dependency output.
fn is_heavy_dir_name(name: &str) -> bool {
    HEAVY_DIR_NAMES.contains(&name)
}

/// Whether a working-tree directory should be left unwatched.
///
/// `.git` always is (it has its own scope). A heavy directory is skipped only
/// when git ignores it too — a repository that really does track `dist/` or
/// vendors `node_modules` still gets live status for those files.
fn should_skip_worktree_dir(
    repo: Option<&git2::Repository>,
    root: &Path,
    path: &Path,
    name: &str,
) -> bool {
    if name == ".git" {
        return true;
    }
    if !is_heavy_dir_name(name) {
        return false;
    }
    git_ignores_dir(repo, root, path)
}

/// Ask git whether a directory is ignored. `root` is the working-tree root the
/// walk started from, and `path` one of its descendants.
fn git_ignores_dir(repo: Option<&git2::Repository>, root: &Path, path: &Path) -> bool {
    let Some(repo) = repo else {
        return false;
    };
    let Some(relative) = worktree_relative(repo, root, path) else {
        return false;
    };
    if repo.is_path_ignored(relative).unwrap_or(false) {
        return true;
    }
    // `node_modules/` style patterns only match when the candidate is
    // presented as a directory.
    let mut as_dir = relative.as_os_str().to_os_string();
    as_dir.push("/");
    repo.is_path_ignored(Path::new(&as_dir)).unwrap_or(false)
}

/// `path` expressed relative to the working tree, for an ignore query.
///
/// `path` is produced by walking down from `root` — the path the repository was
/// opened with — while `repo.workdir()` is libgit2's own normalisation of that
/// same directory. On Windows the two routinely differ: `Path::strip_prefix`
/// compares components byte for byte, so an 8.3 short name (`C:\Users\RUNNER~1\…`
/// against the `runneradmin` libgit2 resolves it to) or a directory whose case
/// differs from the one on disk made stripping the workdir fail. It failed
/// silently, and the caller read that as "git does not ignore this", so every
/// ignored `node_modules` was walked and watched after all — the exact cost the
/// heavy-directory rule exists to avoid.
///
/// Stripping the caller's own root cannot drift that way, because `path` was
/// built from it. The workdir stays as a fallback for a `path` that came from
/// somewhere else.
fn worktree_relative<'a>(repo: &git2::Repository, root: &Path, path: &'a Path) -> Option<&'a Path> {
    if let Ok(relative) = path.strip_prefix(root) {
        return Some(relative);
    }
    path.strip_prefix(repo.workdir()?).ok()
}

/// Plan the working-tree watches for `root`.
///
/// Directories whose whole subtree is watchable get a single recursive watch;
/// only the ancestors of an excluded directory need a non-recursive watch of
/// their own. That keeps the number of registered roots small (which matters:
/// the debouncer scans its roots for every raw event) while still never
/// registering a watch inside an excluded directory.
fn plan_worktree_watches(
    root: &Path,
    skip: &dyn Fn(&Path, &str) -> bool,
) -> Vec<(PathBuf, RecursiveMode)> {
    let mut plan = Vec::new();
    if plan_dir(root, 0, skip, &mut plan) {
        plan.push((root.to_path_buf(), RecursiveMode::Recursive));
    }
    plan
}

/// Returns true when the whole subtree below `dir` can be covered by a single
/// recursive watch on `dir`; otherwise pushes the needed watches into `plan`.
fn plan_dir(
    dir: &Path,
    depth: usize,
    skip: &dyn Fn(&Path, &str) -> bool,
    plan: &mut Vec<(PathBuf, RecursiveMode)>,
) -> bool {
    if depth >= MAX_PLAN_DEPTH {
        return true;
    }
    // An unreadable directory is watched recursively rather than dropped: the
    // back end may still be able to watch it, and losing events is worse than
    // one extra watch.
    let Ok(entries) = std::fs::read_dir(dir) else {
        return true;
    };

    let mut coverable = true;
    let mut children = Vec::new();

    for entry in entries.flatten() {
        // `file_type()` does not follow symlinks, so symlinked directories are
        // never descended into — the same rule the back end applies, and it
        // keeps link cycles from hanging the plan.
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if skip(&path, &name) {
            coverable = false;
            continue;
        }
        let mut nested = Vec::new();
        if plan_dir(&path, depth + 1, skip, &mut nested) {
            children.push((path, RecursiveMode::Recursive));
        } else {
            coverable = false;
            children.extend(nested);
        }
    }

    if coverable {
        return true;
    }

    // Deepest first, so `RepoWatch::covers` and the debouncer's own root scan
    // hit the most specific match first.
    plan.extend(children);
    plan.push((dir.to_path_buf(), RecursiveMode::NonRecursive));
    false
}

/// True when the OS refused to register more watches.
fn is_watch_limit(error: &notify::Error) -> bool {
    match &error.kind {
        notify::ErrorKind::MaxFilesWatch => true,
        // inotify reports an exhausted watch budget as ENOSPC
        #[cfg(target_os = "linux")]
        notify::ErrorKind::Io(io) => io.raw_os_error() == Some(28),
        _ => false,
    }
}

/// Build the error the frontend turns into a user-visible warning. The watch
/// limit is called out by name because it is the one cause the user can
/// actually fix.
fn watch_error(path: &Path, error: &notify::Error) -> GitnadoError {
    if is_watch_limit(error) {
        GitnadoError::OperationFailed(format!(
            "the system file-watch limit was reached while watching {}. {}",
            path.display(),
            WATCH_LIMIT_HINT
        ))
    } else {
        GitnadoError::OperationFailed(format!("failed to watch {}: {}", path.display(), error))
    }
}

/// The part of a path that follows its LAST `.git` component, so a nested
/// repository or submodule is classified against its own git directory rather
/// than an enclosing one. `None` when the path has no `.git` component.
fn strip_to_last_git(path: &Path) -> Option<PathBuf> {
    let mut split = None;
    for (index, component) in path.components().enumerate() {
        if component.as_os_str() == ".git" {
            split = Some(index);
        }
    }
    Some(path.components().skip(split? + 1).collect::<PathBuf>())
}

/// Drop the `worktrees/<name>` or `modules/<name>` pair this scope owns from a
/// path that was only resolved by its last `.git` component.
///
/// A linked worktree's git dir is `<repo>/.git/worktrees/<name>` and a
/// submodule opened as its own repository has `<super>/.git/modules/<name>`, so
/// the text after the last `.git` still carries that pair —
/// `worktrees/wt/index` rather than `index` — and `classify_git_relative`
/// matches on the FIRST component, which would drop the event.
///
/// Only the pair belonging to THIS scope's git dir is removed, so the main
/// repository (whose git dir has no such suffix) keeps ignoring
/// `modules/sub/index`, and a linked worktree's events in the shared common dir
/// (`refs/heads/main`) are left untouched.
fn strip_scope_git_dir_suffix(scope: &RepoScope, relative: PathBuf) -> PathBuf {
    let Some(suffix) = strip_to_last_git(&scope.git_dir) else {
        return relative;
    };
    if suffix.as_os_str().is_empty() {
        return relative;
    }
    match relative.strip_prefix(&suffix) {
        Ok(stripped) => stripped.to_path_buf(),
        Err(_) => relative,
    }
}

/// The path of an event relative to the repository's git directory, if it is
/// inside it.
fn git_relative<'a>(scope: &RepoScope, path: &'a Path) -> Option<Cow<'a, Path>> {
    let relative = if let Ok(relative) = path.strip_prefix(&scope.git_dir) {
        Cow::Borrowed(relative)
    } else if let Ok(relative) = path.strip_prefix(&scope.common_dir) {
        Cow::Borrowed(relative)
    } else {
        // Some back ends report a differently normalised prefix than libgit2
        // hands us (`/private/var` vs `/var` on macOS, for one), so fall back
        // to the last `.git` component in the path. That leaves a linked
        // worktree or a submodule's own git dir prefixed with the pair it
        // lives under, which has to go before the path can be classified.
        Cow::Owned(strip_scope_git_dir_suffix(scope, strip_to_last_git(path)?))
    };

    // A submodule or nested repository below the git directory carries a
    // `.git` of its own; classify against that innermost one.
    let nested = strip_to_last_git(relative.as_ref());
    Some(match nested {
        Some(nested) => Cow::Owned(nested),
        None => relative,
    })
}

/// True for git-dir-relative paths that are pure object storage.
fn is_excluded_git_relative(relative: &Path) -> bool {
    relative
        .components()
        .next()
        .and_then(|c| c.as_os_str().to_str())
        .map(|first| EXCLUDED_GIT_DIRS.contains(&first))
        .unwrap_or(false)
}

/// Classify a path expressed RELATIVE to the git directory.
///
/// Matching on the relative path (rather than the absolute one) keeps a
/// repository that happens to live in `/home/me/index/` or `/srv/config/` from
/// having every `.git` event misfiled, and matching whole path components
/// (rather than substrings) keeps `logs/HEAD`, `index.lock` and
/// `modules/sub/index` from being mistaken for a real ref or index change.
///
/// Returns `None` for the `.git` internals we do not act on (objects, logs,
/// lock files, ...), which are then dropped rather than forwarded.
fn classify_git_relative(relative: &Path) -> Option<WatcherEvent> {
    if is_excluded_git_relative(relative) {
        return None;
    }

    let components: Vec<Cow<'_, str>> = relative
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect();
    let first = components.first()?;

    match first.as_ref() {
        // Anything under refs/ (heads, remotes, tags, ...) is a ref update.
        "refs" => Some(WatcherEvent::RefsChanged),
        // Whole-name matches only, so "HEADER.md" or "index.lock" inside the
        // git directory are not mistaken for ref or index changes.
        "HEAD" | "ORIG_HEAD" | "FETCH_HEAD" | "MERGE_HEAD" | "packed-refs"
            if components.len() == 1 =>
        {
            Some(WatcherEvent::RefsChanged)
        }
        "index" if components.len() == 1 => Some(WatcherEvent::IndexChanged),
        "config" if components.len() == 1 => Some(WatcherEvent::ConfigChanged),
        _ => None,
    }
}

/// Per-repository accumulator used while collapsing a batch.
#[derive(Default)]
struct RepoAccumulator {
    index: bool,
    refs: bool,
    config: bool,
    workdir: bool,
    paths: Vec<PathBuf>,
    seen: HashSet<PathBuf>,
}

impl RepoAccumulator {
    fn push_workdir(&mut self, path: &Path) {
        self.workdir = true;
        if self.paths.len() >= MAX_WORKDIR_PATHS {
            return;
        }
        if self.seen.insert(path.to_path_buf()) {
            self.paths.push(path.to_path_buf());
        }
    }

    fn drain(self) -> Vec<WatcherEvent> {
        let mut events = Vec::new();
        if self.index {
            events.push(WatcherEvent::IndexChanged);
        }
        if self.refs {
            events.push(WatcherEvent::RefsChanged);
        }
        if self.config {
            events.push(WatcherEvent::ConfigChanged);
        }
        if self.workdir {
            events.push(WatcherEvent::WorkdirChanged(self.paths));
        }
        events
    }
}

/// Collapse a batch of debounced events into at most one event of each kind
/// per repository. A `git gc` touching thousands of files becomes a couple of
/// IPC messages instead of thousands.
fn coalesce(messages: Vec<WatchMessage>) -> Vec<(String, WatcherEvent)> {
    let mut order: Vec<String> = Vec::new();
    let mut per_repo: HashMap<String, RepoAccumulator> = HashMap::new();

    for (scope, result) in messages {
        let events = match result {
            Ok(events) => events,
            Err(errors) => {
                for error in errors {
                    tracing::warn!("watcher: error for {}: {}", scope.key, error);
                }
                continue;
            }
        };

        for event in events {
            for path in &event.paths {
                let accumulator = match per_repo.get_mut(&scope.key) {
                    Some(existing) => existing,
                    None => {
                        order.push(scope.key.clone());
                        per_repo.entry(scope.key.clone()).or_default()
                    }
                };

                match git_relative(&scope, path) {
                    Some(relative) => match classify_git_relative(relative.as_ref()) {
                        Some(WatcherEvent::IndexChanged) => accumulator.index = true,
                        Some(WatcherEvent::RefsChanged) => accumulator.refs = true,
                        Some(WatcherEvent::ConfigChanged) => accumulator.config = true,
                        // Object churn and unclassified git files are dropped
                        _ => {}
                    },
                    None => accumulator.push_workdir(path),
                }
            }
        }
    }

    let mut result = Vec::new();
    for key in order {
        if let Some(accumulator) = per_repo.remove(&key) {
            for event in accumulator.drain() {
                result.push((key.clone(), event));
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::{Event, EventKind};
    use notify_debouncer_full::DebouncedEvent;
    use std::fs;
    use tempfile::TempDir;

    fn scope(root: &Path) -> Arc<RepoScope> {
        let git_dir = root.join(".git");
        Arc::new(RepoScope {
            key: root.to_string_lossy().to_string(),
            git_dir: git_dir.clone(),
            common_dir: git_dir,
        })
    }

    fn debounced(paths: Vec<PathBuf>) -> DebouncedEvent {
        let mut event = Event::new(EventKind::Any);
        event.paths = paths;
        DebouncedEvent::new(event, std::time::Instant::now())
    }

    /// Run one batch of absolute paths through the real pipeline and return
    /// the first event it produces (git events sort before workdir ones).
    fn classify_paths(root: &Path, paths: Vec<PathBuf>) -> Option<WatcherEvent> {
        coalesce(vec![(scope(root), Ok(vec![debounced(paths)]))])
            .into_iter()
            .map(|(_, event)| event)
            .next()
    }

    fn classify_absolute(root: &Path, path: &Path) -> Option<WatcherEvent> {
        classify_paths(root, vec![path.to_path_buf()])
    }

    fn classify_in(root: &str, paths: &[&str]) -> Option<WatcherEvent> {
        classify_paths(Path::new(root), paths.iter().map(PathBuf::from).collect())
    }

    /// A scope whose git dir is not the plain `<root>/.git` — a linked
    /// worktree (`<main>/.git/worktrees/<name>`) or a submodule opened as its
    /// own repository (`<super>/.git/modules/<name>`).
    fn linked_scope(key: &str, git_dir: &str, common_dir: &str) -> Arc<RepoScope> {
        Arc::new(RepoScope {
            key: key.to_string(),
            git_dir: PathBuf::from(git_dir),
            common_dir: PathBuf::from(common_dir),
        })
    }

    fn classify_with(scope: Arc<RepoScope>, paths: &[&str]) -> Option<WatcherEvent> {
        coalesce(vec![(
            scope,
            Ok(vec![debounced(paths.iter().map(PathBuf::from).collect())]),
        )])
        .into_iter()
        .map(|(_, event)| event)
        .next()
    }

    fn workdir_paths(event: Option<WatcherEvent>) -> Vec<PathBuf> {
        match event {
            Some(WatcherEvent::WorkdirChanged(paths)) => paths,
            other => panic!("expected WorkdirChanged, got {other:?}"),
        }
    }

    // ---- exclusion predicates -------------------------------------------

    #[test]
    fn git_objects_and_lfs_are_excluded() {
        assert!(is_excluded_git_relative(Path::new("objects/ab/cdef")));
        assert!(is_excluded_git_relative(Path::new(
            "objects/pack/pack-1.pack"
        )));
        assert!(is_excluded_git_relative(Path::new("lfs/objects/00/11/abc")));
    }

    #[test]
    fn git_metadata_is_not_excluded() {
        assert!(!is_excluded_git_relative(Path::new("index")));
        assert!(!is_excluded_git_relative(Path::new("config")));
        assert!(!is_excluded_git_relative(Path::new("refs/heads/main")));
        assert!(!is_excluded_git_relative(Path::new("HEAD")));
        // A ref literally named `objects` lives under refs/, so it survives
        assert!(!is_excluded_git_relative(Path::new("refs/heads/objects")));
    }

    #[test]
    fn heavy_directory_names_are_recognised() {
        for name in ["node_modules", "target", "dist", ".venv", "__pycache__"] {
            assert!(is_heavy_dir_name(name), "{name} should be heavy");
        }
        for name in ["src", "node_modules.md", "targets", "distribution", "docs"] {
            assert!(!is_heavy_dir_name(name), "{name} should not be heavy");
        }
    }

    #[test]
    fn dot_git_is_always_skipped_but_source_directories_are_not() {
        let root = Path::new("/repo");
        assert!(should_skip_worktree_dir(
            None,
            root,
            Path::new("/repo/.git"),
            ".git"
        ));
        // Without a repository there is no ignore information, so heavy names
        // are kept rather than guessed at
        assert!(!should_skip_worktree_dir(
            None,
            root,
            Path::new("/repo/node_modules"),
            "node_modules"
        ));
        assert!(!should_skip_worktree_dir(
            None,
            root,
            Path::new("/repo/src"),
            "src"
        ));
    }

    #[test]
    fn heavy_directories_are_skipped_only_when_git_ignores_them() {
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        fs::write(repo.path.join(".gitignore"), "node_modules/\n").unwrap();
        fs::create_dir_all(repo.path.join("node_modules")).unwrap();
        fs::create_dir_all(repo.path.join("dist")).unwrap();

        let git_repo = git2::Repository::open(&repo.path).unwrap();

        assert!(should_skip_worktree_dir(
            Some(&git_repo),
            &repo.path,
            &repo.path.join("node_modules"),
            "node_modules"
        ));
        // `dist` is heavy by name but tracked/not ignored here, so it stays
        assert!(!should_skip_worktree_dir(
            Some(&git_repo),
            &repo.path,
            &repo.path.join("dist"),
            "dist"
        ));
    }

    /// The root the repository was opened with and libgit2's own normalisation
    /// of it are two different strings whenever the caller's path reaches the
    /// working tree by another name: a symlink here, an 8.3 short name or a
    /// differently-cased drive on Windows. Stripping the workdir fails for all
    /// of them, and a failed strip used to read as "not ignored".
    #[cfg(unix)]
    #[test]
    fn an_ignored_directory_is_recognised_through_a_differently_named_root() {
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        fs::write(repo.path.join(".gitignore"), "node_modules/\n").unwrap();
        fs::create_dir_all(repo.path.join("node_modules")).unwrap();

        let link_parent = tempfile::tempdir().unwrap();
        let link = link_parent.path().join("by-another-name");
        std::os::unix::fs::symlink(&repo.path, &link).unwrap();

        let git_repo = git2::Repository::open(&link).unwrap();
        assert_ne!(
            git_repo.workdir().unwrap(),
            link.as_path(),
            "the test only means anything if the two forms really differ"
        );

        assert!(should_skip_worktree_dir(
            Some(&git_repo),
            &link,
            &link.join("node_modules"),
            "node_modules"
        ));
    }

    // ---- working tree plan ----------------------------------------------

    #[test]
    fn plan_skips_excluded_directories_but_keeps_similar_names() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("node_modules/left-pad")).unwrap();
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::create_dir_all(root.join("node_modules_helpers")).unwrap();
        // A FILE whose name starts with an excluded directory name must not be
        // affected at all
        fs::write(root.join("node_modules.md"), "docs").unwrap();

        let skip = |_path: &Path, name: &str| name == "node_modules";
        let plan = plan_worktree_watches(root, &skip);
        let watched: Vec<&PathBuf> = plan.iter().map(|(p, _)| p).collect();

        assert!(watched.iter().any(|p| *p == &root.to_path_buf()));
        assert!(watched.iter().any(|p| *p == &root.join("src")));
        assert!(watched
            .iter()
            .any(|p| *p == &root.join("node_modules_helpers")));
        assert!(
            !watched
                .iter()
                .any(|p| p.starts_with(root.join("node_modules"))),
            "node_modules must not be watched: {watched:?}"
        );
    }

    #[test]
    fn plan_uses_one_recursive_watch_for_a_clean_tree() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("a/b/c")).unwrap();

        let skip = |_path: &Path, _name: &str| false;
        let plan = plan_worktree_watches(root, &skip);

        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].0, root.to_path_buf());
        assert_eq!(plan[0].1, RecursiveMode::Recursive);
    }

    #[test]
    fn plan_only_walks_down_to_the_excluded_directory() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("packages/app/node_modules/dep")).unwrap();
        fs::create_dir_all(root.join("packages/app/src")).unwrap();
        fs::create_dir_all(root.join("docs/guide")).unwrap();

        let skip = |_path: &Path, name: &str| name == "node_modules";
        let plan = plan_worktree_watches(root, &skip);
        let modes: HashMap<PathBuf, RecursiveMode> = plan.into_iter().collect();

        // Ancestors of the excluded directory are non-recursive
        assert_eq!(modes.get(root), Some(&RecursiveMode::NonRecursive));
        assert_eq!(
            modes.get(&root.join("packages")),
            Some(&RecursiveMode::NonRecursive)
        );
        assert_eq!(
            modes.get(&root.join("packages/app")),
            Some(&RecursiveMode::NonRecursive)
        );
        // Everything clean is covered by a single recursive watch
        assert_eq!(
            modes.get(&root.join("packages/app/src")),
            Some(&RecursiveMode::Recursive)
        );
        assert_eq!(
            modes.get(&root.join("docs")),
            Some(&RecursiveMode::Recursive)
        );
        assert!(!modes.contains_key(&root.join("docs/guide")));
        assert!(!modes.contains_key(&root.join("packages/app/node_modules")));
    }

    #[test]
    fn plan_does_not_descend_into_symlinked_directories() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("real/child")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("real"), root.join("link")).unwrap();

        let skip = |_path: &Path, name: &str| name == "nothing";
        let plan = plan_worktree_watches(root, &skip);
        assert!(!plan.iter().any(|(p, _)| p.ends_with("link")));
    }

    // ---- classification --------------------------------------------------

    #[test]
    fn git_paths_are_classified_relative_to_the_git_directory() {
        let root = Path::new("/repo");
        assert!(matches!(
            classify_absolute(root, Path::new("/repo/.git/index")),
            Some(WatcherEvent::IndexChanged)
        ));
        assert!(matches!(
            classify_absolute(root, Path::new("/repo/.git/refs/heads/main")),
            Some(WatcherEvent::RefsChanged)
        ));
        assert!(matches!(
            classify_absolute(root, Path::new("/repo/.git/HEAD")),
            Some(WatcherEvent::RefsChanged)
        ));
        assert!(matches!(
            classify_absolute(root, Path::new("/repo/.git/config")),
            Some(WatcherEvent::ConfigChanged)
        ));
    }

    #[test]
    fn repository_directory_names_do_not_leak_into_classification() {
        // The repository lives in a directory literally called `index`; a
        // config change must still classify as a config change.
        let root = Path::new("/home/me/index");
        assert!(matches!(
            classify_absolute(root, Path::new("/home/me/index/.git/config")),
            Some(WatcherEvent::ConfigChanged)
        ));
        // …and a working tree file must not be mistaken for git metadata
        match classify_absolute(root, Path::new("/home/me/index/src/main.rs")) {
            Some(WatcherEvent::WorkdirChanged(paths)) => {
                assert_eq!(paths, vec![PathBuf::from("/home/me/index/src/main.rs")]);
            }
            other => panic!("expected WorkdirChanged, got {other:?}"),
        }
    }

    #[test]
    fn object_churn_produces_no_events() {
        let root = Path::new("/repo");
        let paths: Vec<PathBuf> = (0..2000)
            .map(|i| root.join(format!(".git/objects/{:02x}/{}", i % 256, i)))
            .collect();
        let events = coalesce(vec![(scope(root), Ok(vec![debounced(paths)]))]);
        assert!(
            events.is_empty(),
            "object writes must not reach the frontend"
        );
    }

    #[test]
    fn lfs_churn_produces_no_events() {
        let root = Path::new("/repo");
        let paths: Vec<PathBuf> = (0..500)
            .map(|i| root.join(format!(".git/lfs/objects/aa/bb/{i}")))
            .collect();
        let events = coalesce(vec![(scope(root), Ok(vec![debounced(paths)]))]);
        assert!(events.is_empty());
    }

    #[test]
    fn a_worktree_file_named_like_an_excluded_directory_is_still_reported() {
        let root = Path::new("/repo");
        match classify_absolute(root, &root.join("node_modules.md")) {
            Some(WatcherEvent::WorkdirChanged(paths)) => {
                assert_eq!(paths, vec![root.join("node_modules.md")]);
            }
            other => panic!("expected WorkdirChanged, got {other:?}"),
        }
    }

    // ---- classification by path component (relative to the git dir) ------

    #[test]
    fn test_classify_empty_paths_is_none() {
        assert!(classify_in("/repo", &[]).is_none());
    }

    // --- repository paths that used to poison the substring match ---

    #[test]
    fn test_repo_path_containing_index_still_classifies_refs() {
        assert!(matches!(
            classify_in(
                "/home/user/dev/index-service",
                &["/home/user/dev/index-service/.git/refs/heads/main"]
            ),
            Some(WatcherEvent::RefsChanged)
        ));
    }

    #[test]
    fn test_repo_path_containing_index_still_classifies_config() {
        assert!(matches!(
            classify_in(
                "/home/user/dev/index-service",
                &["/home/user/dev/index-service/.git/config"]
            ),
            Some(WatcherEvent::ConfigChanged)
        ));
    }

    #[test]
    fn test_repo_path_containing_refs_still_classifies_index() {
        assert!(matches!(
            classify_in(
                "/home/user/prefs-editor",
                &["/home/user/prefs-editor/.git/index"]
            ),
            Some(WatcherEvent::IndexChanged)
        ));
    }

    #[test]
    fn test_repo_path_containing_head_still_classifies_index() {
        assert!(matches!(
            classify_in("/home/user/HEADlines", &["/home/user/HEADlines/.git/index"]),
            Some(WatcherEvent::IndexChanged)
        ));
    }

    // --- refs ---

    #[test]
    fn test_refs_heads_is_refs_changed() {
        assert!(matches!(
            classify_in("/repo", &["/repo/.git/refs/heads/feature/login"]),
            Some(WatcherEvent::RefsChanged)
        ));
    }

    #[test]
    fn test_refs_remotes_is_refs_changed() {
        assert!(matches!(
            classify_in("/repo", &["/repo/.git/refs/remotes/origin/main"]),
            Some(WatcherEvent::RefsChanged)
        ));
    }

    #[test]
    fn test_refs_tags_is_refs_changed() {
        assert!(matches!(
            classify_in("/repo", &["/repo/.git/refs/tags/v1.0.0"]),
            Some(WatcherEvent::RefsChanged)
        ));
    }

    #[test]
    fn test_packed_refs_is_refs_changed() {
        assert!(matches!(
            classify_in("/repo", &["/repo/.git/packed-refs"]),
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
                matches!(
                    classify_in("/repo", &[path]),
                    Some(WatcherEvent::RefsChanged)
                ),
                "{} should be a ref change",
                path
            );
        }
    }

    // --- index / config ---

    #[test]
    fn test_index_is_index_changed() {
        assert!(matches!(
            classify_in("/repo", &["/repo/.git/index"]),
            Some(WatcherEvent::IndexChanged)
        ));
    }

    #[test]
    fn test_config_is_config_changed() {
        assert!(matches!(
            classify_in("/repo", &["/repo/.git/config"]),
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
                classify_in("/repo", &[path]).is_none(),
                "{} should not be classified",
                path
            );
        }
    }

    #[test]
    fn test_submodule_git_dir_classifies_against_its_own_git_dir() {
        assert!(matches!(
            classify_in("/repo", &["/repo/.git/modules/sub/.git/refs/heads/main"]),
            Some(WatcherEvent::RefsChanged)
        ));
    }

    // --- linked worktrees and submodules opened as their own repository ---

    fn worktree_scope() -> Arc<RepoScope> {
        linked_scope("/wt", "/main/.git/worktrees/wt", "/main/.git")
    }

    fn submodule_scope() -> Arc<RepoScope> {
        linked_scope(
            "/super/sub",
            "/super/.git/modules/sub",
            "/super/.git/modules/sub",
        )
    }

    #[test]
    fn test_linked_worktree_classifies_on_the_prefix_path() {
        assert!(matches!(
            classify_with(worktree_scope(), &["/main/.git/worktrees/wt/index"]),
            Some(WatcherEvent::IndexChanged)
        ));
        assert!(matches!(
            classify_with(worktree_scope(), &["/main/.git/worktrees/wt/HEAD"]),
            Some(WatcherEvent::RefsChanged)
        ));
        // Refs are shared with the main repository, so they arrive under the
        // common dir instead
        assert!(matches!(
            classify_with(worktree_scope(), &["/main/.git/refs/heads/main"]),
            Some(WatcherEvent::RefsChanged)
        ));
    }

    #[test]
    fn test_linked_worktree_classifies_on_the_fallback_path() {
        // Neither prefix matches (a differently normalised path), so the last
        // `.git` fallback runs and has to drop `worktrees/wt` itself.
        assert!(matches!(
            classify_with(worktree_scope(), &["/private/main/.git/worktrees/wt/index"]),
            Some(WatcherEvent::IndexChanged)
        ));
        assert!(matches!(
            classify_with(worktree_scope(), &["/private/main/.git/worktrees/wt/HEAD"]),
            Some(WatcherEvent::RefsChanged)
        ));
        assert!(matches!(
            classify_with(worktree_scope(), &["/private/main/.git/refs/heads/main"]),
            Some(WatcherEvent::RefsChanged)
        ));
    }

    #[test]
    fn test_submodule_as_its_own_repository_classifies_on_the_fallback_path() {
        assert!(matches!(
            classify_with(
                submodule_scope(),
                &["/private/super/.git/modules/sub/index"]
            ),
            Some(WatcherEvent::IndexChanged)
        ));
        assert!(matches!(
            classify_with(submodule_scope(), &["/private/super/.git/modules/sub/HEAD"]),
            Some(WatcherEvent::RefsChanged)
        ));
        assert!(matches!(
            classify_with(
                submodule_scope(),
                &["/private/super/.git/modules/sub/refs/heads/main"]
            ),
            Some(WatcherEvent::RefsChanged)
        ));
    }

    #[test]
    fn test_submodule_as_its_own_repository_classifies_on_the_prefix_path() {
        assert!(matches!(
            classify_with(submodule_scope(), &["/super/.git/modules/sub/index"]),
            Some(WatcherEvent::IndexChanged)
        ));
    }

    #[test]
    fn test_fallback_only_strips_the_pair_this_scope_owns() {
        // The main repository still ignores a submodule's git dir, whichever
        // branch resolved the path
        assert!(classify_in("/repo", &["/private/repo/.git/modules/sub/index"]).is_none());
        // ... and a worktree scope does not claim a sibling worktree's index
        assert!(classify_with(
            worktree_scope(),
            &["/private/main/.git/worktrees/other/index"]
        )
        .is_none());
    }

    #[test]
    fn test_linked_worktree_working_files_are_still_workdir_changes() {
        let paths = workdir_paths(classify_with(worktree_scope(), &["/wt/src/main.rs"]));
        assert_eq!(paths, vec![PathBuf::from("/wt/src/main.rs")]);
    }

    // --- working directory files that look like git files ---

    #[test]
    fn test_worktree_index_html_is_workdir_change() {
        let paths = workdir_paths(classify_in("/repo", &["/repo/src/index.html"]));
        assert_eq!(paths, vec![PathBuf::from("/repo/src/index.html")]);
    }

    #[test]
    fn test_worktree_file_named_index_is_workdir_change() {
        let paths = workdir_paths(classify_in("/repo", &["/repo/index"]));
        assert_eq!(paths, vec![PathBuf::from("/repo/index")]);
    }

    #[test]
    fn test_worktree_file_named_config_is_workdir_change() {
        let paths = workdir_paths(classify_in("/repo", &["/repo/config"]));
        assert_eq!(paths, vec![PathBuf::from("/repo/config")]);
    }

    #[test]
    fn test_worktree_config_json_and_refs_dir_are_workdir_changes() {
        let paths = workdir_paths(classify_in(
            "/repo",
            &["/repo/config.json", "/repo/refs/HEAD.md"],
        ));
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
            classify_in(
                "/repo",
                &["/repo/src/main.rs", "/repo/.git/refs/heads/main"]
            ),
            Some(WatcherEvent::RefsChanged)
        ));
    }

    #[test]
    fn a_batch_reports_both_the_git_change_and_the_workdir_change() {
        // Coalescing collects a whole debounce window, so a batch that mixes
        // git metadata with working-tree writes reports BOTH kinds (the git
        // event first) instead of dropping the working-tree paths.
        let root = Path::new("/repo");
        let events = coalesce(vec![(
            scope(root),
            Ok(vec![debounced(vec![
                root.join("src/main.rs"),
                root.join(".git/refs/heads/main"),
            ])]),
        )]);

        assert_eq!(events.len(), 2, "got {events:?}");
        assert!(matches!(events[0].1, WatcherEvent::RefsChanged));
        match &events[1].1 {
            WatcherEvent::WorkdirChanged(paths) => {
                assert_eq!(paths, &vec![root.join("src/main.rs")]);
            }
            other => panic!("expected WorkdirChanged, got {other:?}"),
        }
    }

    #[test]
    fn test_unclassified_git_path_falls_through_to_workdir_paths() {
        let paths = workdir_paths(classify_in(
            "/repo",
            &["/repo/.git/objects/ab/cdef0123456789", "/repo/src/main.rs"],
        ));
        assert_eq!(paths, vec![PathBuf::from("/repo/src/main.rs")]);
    }

    #[test]
    fn test_git_only_unclassified_event_is_none() {
        assert!(classify_in("/repo", &["/repo/.git/objects/pack/pack-abc.idx"]).is_none());
    }

    // ---- coalescing ------------------------------------------------------

    #[test]
    fn a_burst_collapses_to_one_event_per_kind() {
        let root = Path::new("/repo");
        let mut paths = Vec::new();
        for i in 0..5000 {
            paths.push(root.join(format!(".git/objects/{:02x}/{}", i % 256, i)));
        }
        for i in 0..200 {
            paths.push(root.join(format!(".git/refs/heads/branch-{i}")));
        }
        for i in 0..200 {
            paths.push(root.join(format!("src/file-{i}.rs")));
        }
        paths.push(root.join(".git/index"));

        let events = coalesce(vec![(scope(root), Ok(vec![debounced(paths)]))]);

        assert_eq!(events.len(), 3, "got {events:?}");
        assert!(matches!(events[0].1, WatcherEvent::IndexChanged));
        assert!(matches!(events[1].1, WatcherEvent::RefsChanged));
        match &events[2].1 {
            WatcherEvent::WorkdirChanged(paths) => {
                assert!(paths.len() <= MAX_WORKDIR_PATHS);
                assert!(!paths.is_empty());
            }
            other => panic!("expected WorkdirChanged, got {other:?}"),
        }
    }

    #[test]
    fn coalescing_keeps_repositories_separate() {
        let one = Path::new("/repo/one");
        let two = Path::new("/repo/two");
        let events = coalesce(vec![
            (
                scope(one),
                Ok(vec![debounced(vec![one.join(".git/index")])]),
            ),
            (scope(two), Ok(vec![debounced(vec![two.join("a.txt")])])),
            (
                scope(one),
                Ok(vec![debounced(vec![one.join(".git/index")])]),
            ),
        ]);

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, one.to_string_lossy());
        assert!(matches!(events[0].1, WatcherEvent::IndexChanged));
        assert_eq!(events[1].0, two.to_string_lossy());
        assert!(matches!(events[1].1, WatcherEvent::WorkdirChanged(_)));
    }

    #[test]
    fn duplicate_workdir_paths_are_reported_once() {
        let root = Path::new("/repo");
        let path = root.join("src/main.rs");
        let events = coalesce(vec![(
            scope(root),
            Ok(vec![
                debounced(vec![path.clone()]),
                debounced(vec![path.clone()]),
                debounced(vec![path.clone()]),
            ]),
        )]);

        assert_eq!(events.len(), 1);
        match &events[0].1 {
            WatcherEvent::WorkdirChanged(paths) => assert_eq!(paths, &vec![path]),
            other => panic!("expected WorkdirChanged, got {other:?}"),
        }
    }

    // ---- error surfacing -------------------------------------------------

    #[test]
    fn watch_limit_errors_name_the_actionable_cause() {
        let error = notify::Error::new(notify::ErrorKind::MaxFilesWatch);
        assert!(is_watch_limit(&error));

        let message = watch_error(Path::new("/repo"), &error).to_string();
        assert!(
            message.contains("file-watch limit"),
            "message should name the limit: {message}"
        );
        #[cfg(target_os = "linux")]
        assert!(
            message.contains("max_user_watches"),
            "Linux message should name the sysctl: {message}"
        );
    }

    #[test]
    fn other_watch_errors_keep_their_original_text() {
        let error = notify::Error::new(notify::ErrorKind::PathNotFound);
        assert!(!is_watch_limit(&error));
        let message = watch_error(Path::new("/repo"), &error).to_string();
        assert!(message.contains("/repo"), "{message}");
        assert!(!message.contains("file-watch limit"), "{message}");
    }

    // ---- registration ----------------------------------------------------

    #[test]
    fn watching_a_repository_never_registers_a_watch_inside_git_objects() {
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        fs::write(repo.path.join(".gitignore"), "node_modules/\n").unwrap();
        fs::create_dir_all(repo.path.join("node_modules/dep")).unwrap();
        fs::create_dir_all(repo.path.join("src")).unwrap();

        let mut service = WatcherService::new();
        service.watch(&repo.path).unwrap();

        let key = repo.path.to_string_lossy().to_string();
        let roots = &service.watchers.get(&key).unwrap().roots;

        // The git scope is registered under the path libgit2 resolves, which is
        // not always `repo.path/.git` spelled the same way (see
        // `worktree_relative`), so ask git2 for it rather than assuming.
        let git_dir = git2::Repository::open(&repo.path)
            .unwrap()
            .path()
            .to_path_buf();

        assert!(
            !roots
                .iter()
                .any(|(p, _)| p.starts_with(git_dir.join("objects"))),
            "objects must never be watched: {roots:?}"
        );
        assert!(
            !roots
                .iter()
                .any(|(p, _)| p.starts_with(repo.path.join("node_modules"))),
            "ignored node_modules must not be watched: {roots:?}"
        );
        assert!(
            roots.iter().any(|(p, _)| p == &repo.path),
            "the working tree root must be watched: {roots:?}"
        );
        assert!(
            roots
                .iter()
                .any(|(p, _)| p.ends_with("refs") && p.starts_with(&git_dir)),
            "refs must be watched: {roots:?}"
        );
    }

    #[test]
    fn new_directories_are_picked_up_after_registration() {
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        fs::write(repo.path.join(".gitignore"), "node_modules/\n").unwrap();
        fs::create_dir_all(repo.path.join("node_modules/dep")).unwrap();

        let mut service = WatcherService::new();
        service.watch(&repo.path).unwrap();

        let created = repo.path.join("brand-new");
        fs::create_dir_all(created.join("nested")).unwrap();

        let key = repo.path.to_string_lossy().to_string();
        service.sync_directories(&[(
            key.clone(),
            WatcherEvent::WorkdirChanged(vec![created.clone()]),
        )]);

        let watch = service.watchers.get(&key).unwrap();
        assert!(
            watch.covers(&created.join("nested/file.txt")),
            "{:?}",
            watch.roots
        );

        // …and a removed directory is dropped again
        fs::remove_dir_all(&created).unwrap();
        service.sync_directories(&[(
            key.clone(),
            WatcherEvent::WorkdirChanged(vec![created.clone()]),
        )]);
        let watch = service.watchers.get(&key).unwrap();
        assert!(!watch.roots.iter().any(|(p, _)| p.starts_with(&created)));
    }

    #[test]
    fn a_newly_created_ignored_directory_is_not_watched() {
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        fs::write(repo.path.join(".gitignore"), "node_modules/\n").unwrap();
        fs::create_dir_all(repo.path.join("keep")).unwrap();

        let mut service = WatcherService::new();
        service.watch(&repo.path).unwrap();

        let ignored = repo.path.join("node_modules");
        fs::create_dir_all(ignored.join("dep")).unwrap();

        let key = repo.path.to_string_lossy().to_string();
        service.sync_directories(&[(
            key.clone(),
            WatcherEvent::WorkdirChanged(vec![ignored.clone()]),
        )]);

        let watch = service.watchers.get(&key).unwrap();
        assert!(
            !watch.roots.iter().any(|(p, _)| p.starts_with(&ignored)),
            "{:?}",
            watch.roots
        );
    }
}
