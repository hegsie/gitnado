//! Repository discovery.
//!
//! Two entry points, both used by the "open by dropping a folder on the
//! window" and "scan a folder for repositories" flows:
//!
//! * [`classify_repository_path`] — what IS this path? The drop handler needs
//!   to tell "gone", "a file", "a plain directory" and "a repository" apart so
//!   it can report each case instead of showing one generic failure.
//! * [`scan_for_repositories`] — walk a directory tree looking for
//!   repositories. Bounded on every axis (depth, visited directories, results)
//!   and cancellable, because the natural thing for a user to pick is their
//!   home directory and a naive full walk of that would hang the app.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{command, AppHandle, Emitter};

use crate::error::{GitnadoError, Result};

/// How deep below the chosen folder the scan looks, by default.
///
/// 4 covers the usual layouts (`~/code/<repo>`, `~/code/<org>/<repo>`,
/// `~/dev/<lang>/<org>/<repo>`) without walking a whole home directory.
pub const DEFAULT_MAX_DEPTH: usize = 4;

/// Hard ceiling on the requested depth. A caller asking for more is clamped
/// rather than rejected — the scan stays bounded whatever the UI sends.
pub const MAX_ALLOWED_DEPTH: usize = 8;

/// Most repositories reported from a single scan. Beyond this the result is
/// flagged `truncated` so the UI can tell the user to narrow the folder.
pub const MAX_RESULTS: usize = 200;

/// Most directories visited before the walk gives up. Also reported as
/// `truncated`; it is the backstop for a tree that is wide rather than deep.
pub const MAX_VISITED_DIRECTORIES: usize = 20_000;

/// Emit a progress event at most every this many directories, so a big scan
/// does not flood the webview with IPC traffic.
const PROGRESS_EVERY: usize = 50;

/// Directory names never descended into.
///
/// Two groups: dependency/build output that can hold thousands of entries (and
/// whose vendored copies are not repositories the user means to open), and OS
/// directories that are slow or refuse access. Hidden directories are skipped
/// separately by name prefix.
const SKIPPED_DIRECTORY_NAMES: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "bin",
    "obj",
    "vendor",
    "venv",
    "__pycache__",
    "Pods",
    "Carthage",
    "DerivedData",
    "Library",
    "Applications",
    "System",
    "AppData",
    "Windows",
    "Program Files",
    "Program Files (x86)",
    "$RECYCLE.BIN",
    "System Volume Information",
];

/// A repository found by a scan.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredRepository {
    pub path: String,
    pub name: String,
    pub is_bare: bool,
}

/// The outcome of a scan. `truncated` and `cancelled` are reported rather than
/// turned into an error: the repositories found before the limit are still
/// worth showing.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryScanResult {
    pub root: String,
    pub repositories: Vec<DiscoveredRepository>,
    pub scanned_directories: usize,
    pub truncated: bool,
    pub cancelled: bool,
}

/// Progress event payload, emitted as `repository-scan-progress`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryScanProgress {
    pub scanned_directories: usize,
    pub found: usize,
    pub current_path: String,
}

/// What a dropped (or picked) path actually is.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathClassification {
    pub path: String,
    pub name: String,
    pub exists: bool,
    pub is_directory: bool,
    pub is_repository: bool,
    pub is_bare: bool,
}

/// Bounds for one walk. Separated from the command so the tests can drive the
/// walk directly with small limits.
#[derive(Debug, Clone, Copy)]
pub struct ScanOptions {
    pub max_depth: usize,
    pub max_results: usize,
    pub max_visited_directories: usize,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            max_depth: DEFAULT_MAX_DEPTH,
            max_results: MAX_RESULTS,
            max_visited_directories: MAX_VISITED_DIRECTORIES,
        }
    }
}

/// Set when the user cancels the in-flight scan.
///
/// One flag is enough: the scan dialog runs a single scan at a time and blocks
/// further input while it is running. Cleared at the start of every scan so a
/// stale cancellation cannot kill the next one — the same shape as
/// `CLONE_CANCELLED` in `commands::repository`.
static SCAN_CANCELLED: AtomicBool = AtomicBool::new(false);

/// Request cancellation of the in-flight repository scan.
#[command]
pub async fn cancel_repository_scan() -> Result<()> {
    SCAN_CANCELLED.store(true, Ordering::SeqCst);
    Ok(())
}

/// Last path segment, falling back to the whole path for a root directory.
fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string())
}

/// True when `dir` is the working directory of a repository.
///
/// `.git` is checked with `symlink_metadata` rather than `is_dir` because a
/// linked worktree and a submodule both store a `.git` FILE pointing at the
/// real git directory — treating those as "not a repository" would hide every
/// worktree from the scan.
fn is_worktree_repository(dir: &Path) -> bool {
    dir.join(".git").symlink_metadata().is_ok()
}

/// True when `dir` looks like a bare repository (`HEAD` + `objects/` +
/// `refs/`). Checked structurally rather than by opening it with git2: the
/// scan visits thousands of directories and must not pay for a repository
/// open on each one.
fn is_bare_repository(dir: &Path) -> bool {
    dir.join("HEAD").is_file() && dir.join("objects").is_dir() && dir.join("refs").is_dir()
}

/// Classify a directory as a repository, if it is one.
fn as_repository(dir: &Path) -> Option<DiscoveredRepository> {
    let is_bare = if is_worktree_repository(dir) {
        false
    } else if is_bare_repository(dir) {
        true
    } else {
        return None;
    };
    Some(DiscoveredRepository {
        path: dir.display().to_string(),
        name: display_name(dir),
        is_bare,
    })
}

/// True for a directory the walk must not descend into.
///
/// Hidden directories are skipped wholesale: `.git` itself, and the caches
/// (`.cache`, `.venv`, `.gradle`, `.cargo`, …) that make a home-directory scan
/// crawl. A repository whose own name starts with a dot is still reachable
/// when the user picks it directly — the root is never filtered.
fn should_skip_directory(name: &str) -> bool {
    name.starts_with('.') || SKIPPED_DIRECTORY_NAMES.contains(&name)
}

/// Walk `root` looking for repositories.
///
/// Iterative (no recursion, so a deep tree cannot blow the stack), never
/// follows symlinks (`file_type()` reports the LINK, and a link is skipped
/// before it is either descended into or reported — a `~/link -> ~` loop would
/// otherwise walk forever), and stops at the first repository on a branch
/// instead of descending into its working tree.
pub fn scan_directory_for_repositories(
    root: &Path,
    options: ScanOptions,
    cancelled: &AtomicBool,
    mut on_progress: impl FnMut(&RepositoryScanProgress),
) -> RepositoryScanResult {
    let mut result = RepositoryScanResult {
        root: root.display().to_string(),
        repositories: Vec::new(),
        scanned_directories: 0,
        truncated: false,
        cancelled: false,
    };

    // The chosen folder may itself be a repository — the most likely case when
    // it arrives from a drop. Report it and do not walk its working tree.
    if let Some(repo) = as_repository(root) {
        result.repositories.push(repo);
        result.scanned_directories = 1;
        return result;
    }

    let mut stack: Vec<(std::path::PathBuf, usize)> = vec![(root.to_path_buf(), 0)];

    // Labelled so the result-cap exit inside the inner loop can leave the walk
    // with a `break` instead of a `return`: every exit has to fall through to
    // the sort at the end of this function.
    'walk: while let Some((dir, depth)) = stack.pop() {
        if cancelled.load(Ordering::SeqCst) {
            result.cancelled = true;
            break;
        }
        if result.scanned_directories >= options.max_visited_directories {
            result.truncated = true;
            break;
        }

        result.scanned_directories += 1;
        if result.scanned_directories.is_multiple_of(PROGRESS_EVERY) {
            on_progress(&RepositoryScanProgress {
                scanned_directories: result.scanned_directories,
                found: result.repositories.len(),
                current_path: dir.display().to_string(),
            });
        }

        // A directory that cannot be read (permission denied, removed while
        // the scan ran) is skipped, not fatal: one unreadable folder must not
        // throw away every repository found around it.
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };

        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            // Symlinks are never followed, in either direction: not descended
            // into, and not reported as a found repository.
            if file_type.is_symlink() || !file_type.is_dir() {
                continue;
            }

            let child = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();

            if let Some(repo) = as_repository(&child) {
                if result.repositories.len() >= options.max_results {
                    result.truncated = true;
                    // `break 'walk`, never `return`: an early return here would
                    // hand back the repositories in `read_dir` order (inode
                    // order on ext4/APFS), so a scan large enough to hit the cap
                    // would list scrambled and differently on every run, while a
                    // smaller one listed alphabetically.
                    break 'walk;
                }
                result.repositories.push(repo);
                // Do not descend into a repository: its submodules and vendored
                // copies are not what the user asked for.
                continue;
            }

            if should_skip_directory(&name) {
                continue;
            }
            if depth + 1 < options.max_depth {
                stack.push((child, depth + 1));
            }
        }
    }

    // Deterministic order regardless of the filesystem's own iteration order,
    // so the same folder always lists the same way.
    result.repositories.sort_by(|a, b| a.path.cmp(&b.path));
    result
}

/// Classify a path so the caller can tell the user exactly what is wrong with
/// it (gone, a file, a plain folder) instead of a single generic failure.
#[command]
pub async fn classify_repository_path(path: String) -> Result<PathClassification> {
    let candidate = std::path::PathBuf::from(&path);
    let name = display_name(&candidate);

    // `fs::metadata` FOLLOWS symlinks, deliberately: a dangling symlink then
    // reports `exists: false`, so the drop handler tells the user the path is
    // gone. `fs::symlink_metadata` would report the link itself as an existing
    // non-directory, and `window-drop.service.ts` would answer a broken link
    // with "… is a file — drop a folder", which is not what happened.
    let metadata = std::fs::metadata(&candidate).ok();
    let exists = metadata.is_some();
    let is_directory = metadata.as_ref().is_some_and(|m| m.is_dir());

    let repository = if is_directory {
        as_repository(&candidate)
    } else {
        None
    };

    Ok(PathClassification {
        path,
        name,
        exists,
        is_directory,
        is_repository: repository.is_some(),
        is_bare: repository.is_some_and(|r| r.is_bare),
    })
}

/// Reject a scan root that is gone or is not a folder, naming which it is —
/// "no repositories found" would be a lie for a path that never existed.
fn validate_scan_root(root: &Path) -> Result<()> {
    if !root.exists() {
        return Err(GitnadoError::InvalidPath(format!(
            "{} no longer exists",
            root.display()
        )));
    }
    if !root.is_dir() {
        return Err(GitnadoError::InvalidPath(format!(
            "{} is not a folder",
            root.display()
        )));
    }
    Ok(())
}

/// Scan `path` for git repositories, emitting `repository-scan-progress`
/// while it runs.
#[command]
pub async fn scan_for_repositories(
    app: AppHandle,
    path: String,
    max_depth: Option<usize>,
) -> Result<RepositoryScanResult> {
    let root = std::path::PathBuf::from(&path);
    validate_scan_root(&root)?;

    // A cancellation requested against a previous scan must not kill this one.
    SCAN_CANCELLED.store(false, Ordering::SeqCst);

    let options = ScanOptions {
        max_depth: max_depth
            .unwrap_or(DEFAULT_MAX_DEPTH)
            .clamp(1, MAX_ALLOWED_DEPTH),
        ..ScanOptions::default()
    };

    // The walk is blocking filesystem work; running it inline would stall an
    // async worker for the whole scan.
    tokio::task::spawn_blocking(move || {
        scan_directory_for_repositories(&root, options, &SCAN_CANCELLED, |progress| {
            let _ = app.emit("repository-scan-progress", progress.clone());
        })
    })
    .await
    .map_err(|e| GitnadoError::OperationFailed(format!("Repository scan failed: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    use tempfile::TempDir;

    /// Create `dir` and give it a `.git` directory, so the scan sees a
    /// repository without paying for a real git2 init.
    fn make_repo(root: &Path, relative: &str) -> PathBuf {
        // One component at a time. `Path::join("aaa/repo")` keeps the embedded
        // forward slash verbatim on Windows, so the expected path would read
        // `root\aaa/repo` while the scan, which joins a component per
        // directory it walks into, reports `root\aaa\repo`.
        let dir = relative
            .split('/')
            .fold(root.to_path_buf(), |path, part| path.join(part));
        fs::create_dir_all(dir.join(".git")).unwrap();
        dir
    }

    fn scan(root: &Path, options: ScanOptions) -> RepositoryScanResult {
        let flag = AtomicBool::new(false);
        scan_directory_for_repositories(root, options, &flag, |_| {})
    }

    fn paths(result: &RepositoryScanResult) -> Vec<String> {
        result.repositories.iter().map(|r| r.path.clone()).collect()
    }

    #[test]
    fn finds_repositories_at_several_depths() {
        let tmp = TempDir::new().unwrap();
        let a = make_repo(tmp.path(), "a");
        let b = make_repo(tmp.path(), "org/b");
        fs::create_dir_all(tmp.path().join("empty")).unwrap();

        let result = scan(tmp.path(), ScanOptions::default());

        assert_eq!(
            paths(&result),
            {
                let mut expected = vec![a.display().to_string(), b.display().to_string()];
                expected.sort();
                expected
            },
            "both repositories are reported, sorted by path"
        );
        assert!(!result.truncated);
        assert!(!result.cancelled);
    }

    #[test]
    fn stops_at_the_depth_limit() {
        let tmp = TempDir::new().unwrap();
        make_repo(tmp.path(), "one/two/three/deep");

        let shallow = scan(
            tmp.path(),
            ScanOptions {
                max_depth: 2,
                ..ScanOptions::default()
            },
        );
        assert!(
            shallow.repositories.is_empty(),
            "a repository below the depth limit is not reported"
        );

        let deep = scan(
            tmp.path(),
            ScanOptions {
                max_depth: 5,
                ..ScanOptions::default()
            },
        );
        assert_eq!(deep.repositories.len(), 1, "raising the limit finds it");
    }

    #[test]
    fn does_not_descend_into_a_repository() {
        let tmp = TempDir::new().unwrap();
        let outer = make_repo(tmp.path(), "outer");
        make_repo(&outer, "vendor-copy");

        let result = scan(tmp.path(), ScanOptions::default());

        assert_eq!(
            paths(&result),
            vec![outer.display().to_string()],
            "the nested copy inside a repository's working tree is not listed"
        );
    }

    #[test]
    fn skips_heavy_and_hidden_directories() {
        let tmp = TempDir::new().unwrap();
        make_repo(tmp.path(), "node_modules/dep");
        make_repo(tmp.path(), "target/debug/thing");
        make_repo(tmp.path(), ".cache/thing");
        let real = make_repo(tmp.path(), "real");

        let result = scan(tmp.path(), ScanOptions::default());

        assert_eq!(
            paths(&result),
            vec![real.display().to_string()],
            "only the repository outside the ignored directories is reported"
        );
    }

    #[test]
    fn reports_a_bare_repository() {
        let tmp = TempDir::new().unwrap();
        let bare = tmp.path().join("mirror.git");
        fs::create_dir_all(bare.join("objects")).unwrap();
        fs::create_dir_all(bare.join("refs")).unwrap();
        fs::write(bare.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        let result = scan(tmp.path(), ScanOptions::default());

        assert_eq!(result.repositories.len(), 1);
        assert!(result.repositories[0].is_bare);
        assert_eq!(result.repositories[0].name, "mirror.git");
    }

    #[test]
    fn reports_the_root_itself_when_it_is_a_repository() {
        let tmp = TempDir::new().unwrap();
        let repo = make_repo(tmp.path(), "repo");
        make_repo(&repo, "nested");

        let result = scan(&repo, ScanOptions::default());

        assert_eq!(paths(&result), vec![repo.display().to_string()]);
    }

    /// A tree whose discovery order is deliberately NOT its sorted order: the
    /// root-level `zzz-repo` is found while the root is read, and the two under
    /// `aaa/` only afterwards, so anything that skips the final sort hands back
    /// `zzz-repo` first. Returns the paths in the order they must be reported.
    fn tree_found_out_of_order(root: &Path) -> Vec<String> {
        let zzz = make_repo(root, "zzz-repo");
        let nested = make_repo(root, "aaa/repo");
        make_repo(root, "aaa/deeper/repo");
        vec![nested.display().to_string(), zzz.display().to_string()]
    }

    fn assert_sorted(result: &RepositoryScanResult) {
        let listed = paths(result);
        let mut expected = listed.clone();
        expected.sort();
        assert_eq!(listed, expected, "results are always sorted by path");
    }

    #[test]
    fn caps_the_number_of_results() {
        let tmp = TempDir::new().unwrap();
        for i in 0..6 {
            make_repo(tmp.path(), &format!("repo{}", i));
        }

        let result = scan(
            tmp.path(),
            ScanOptions {
                max_results: 3,
                ..ScanOptions::default()
            },
        );

        assert_eq!(result.repositories.len(), 3);
        assert!(result.truncated, "hitting the cap is reported as truncated");
    }

    #[test]
    fn a_result_capped_scan_is_still_sorted() {
        let tmp = TempDir::new().unwrap();
        let expected = tree_found_out_of_order(tmp.path());

        // Two repositories fit; the third trips the cap.
        let result = scan(
            tmp.path(),
            ScanOptions {
                max_results: 2,
                ..ScanOptions::default()
            },
        );

        assert!(result.truncated, "hitting the cap is reported as truncated");
        assert_eq!(
            paths(&result),
            expected,
            "a truncated scan is sorted like any other, not left in read_dir order"
        );
    }

    #[test]
    fn caps_the_number_of_visited_directories() {
        let tmp = TempDir::new().unwrap();
        for i in 0..10 {
            fs::create_dir_all(tmp.path().join(format!("plain{}", i))).unwrap();
        }

        let result = scan(
            tmp.path(),
            ScanOptions {
                max_visited_directories: 3,
                ..ScanOptions::default()
            },
        );

        assert!(result.truncated);
        assert!(result.scanned_directories <= 3);
    }

    #[test]
    fn a_directory_capped_scan_is_still_sorted() {
        let tmp = TempDir::new().unwrap();
        let expected = tree_found_out_of_order(tmp.path());

        // The root and `aaa` are visited; `aaa/deeper` trips the cap.
        let result = scan(
            tmp.path(),
            ScanOptions {
                max_visited_directories: 2,
                ..ScanOptions::default()
            },
        );

        assert!(result.truncated);
        assert_eq!(paths(&result), expected);
    }

    #[test]
    fn stops_when_cancelled() {
        let tmp = TempDir::new().unwrap();
        make_repo(tmp.path(), "a/b");

        let flag = AtomicBool::new(true);
        let result =
            scan_directory_for_repositories(tmp.path(), ScanOptions::default(), &flag, |_| {});

        assert!(result.cancelled);
        assert!(result.repositories.is_empty());
    }

    #[test]
    fn a_cancelled_scan_is_still_sorted() {
        let tmp = TempDir::new().unwrap();
        for i in 0..6 {
            make_repo(tmp.path(), &format!("repo{}", i));
        }
        // Enough plain directories that a progress update fires, which is the
        // only hook a test has for cancelling mid-walk. Every repository is
        // already found by then: they all sit in the root, which is read first.
        for i in 0..PROGRESS_EVERY + 5 {
            fs::create_dir_all(tmp.path().join(format!("plain{}", i))).unwrap();
        }

        let flag = AtomicBool::new(false);
        let result =
            scan_directory_for_repositories(tmp.path(), ScanOptions::default(), &flag, |_| {
                flag.store(true, Ordering::SeqCst)
            });

        assert!(result.cancelled);
        assert_eq!(result.repositories.len(), 6);
        assert_sorted(&result);
    }

    #[test]
    fn reports_progress_for_a_wide_tree() {
        let tmp = TempDir::new().unwrap();
        for i in 0..PROGRESS_EVERY + 5 {
            fs::create_dir_all(tmp.path().join(format!("plain{}", i))).unwrap();
        }

        let flag = AtomicBool::new(false);
        let mut seen = Vec::new();
        scan_directory_for_repositories(tmp.path(), ScanOptions::default(), &flag, |p| {
            seen.push(p.scanned_directories)
        });

        assert!(
            !seen.is_empty(),
            "a scan crossing the progress interval emits at least one update"
        );
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let real = make_repo(tmp.path(), "outside/real");
        let inside = tmp.path().join("inside");
        fs::create_dir_all(&inside).unwrap();
        // A link to a repository, and a link back to the scan root: following
        // either would list a repository twice or loop forever.
        symlink(&real, inside.join("link-to-repo")).unwrap();
        symlink(tmp.path(), inside.join("link-to-root")).unwrap();

        let result = scan(&inside, ScanOptions::default());

        assert!(
            result.repositories.is_empty(),
            "symlinked repositories are neither followed nor reported"
        );
    }

    #[tokio::test]
    async fn classify_reports_a_missing_path() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("gone");

        let info = classify_repository_path(missing.display().to_string())
            .await
            .unwrap();

        assert!(!info.exists);
        assert!(!info.is_directory);
        assert!(!info.is_repository);
        assert_eq!(info.name, "gone");
    }

    #[tokio::test]
    async fn classify_reports_a_file() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("notes.txt");
        fs::write(&file, "hello").unwrap();

        let info = classify_repository_path(file.display().to_string())
            .await
            .unwrap();

        assert!(info.exists);
        assert!(!info.is_directory);
        assert!(!info.is_repository);
    }

    #[tokio::test]
    async fn classify_separates_plain_directories_from_repositories() {
        let tmp = TempDir::new().unwrap();
        let plain = tmp.path().join("plain");
        fs::create_dir_all(&plain).unwrap();
        let repo = make_repo(tmp.path(), "repo");

        let plain_info = classify_repository_path(plain.display().to_string())
            .await
            .unwrap();
        assert!(plain_info.is_directory);
        assert!(!plain_info.is_repository);

        let repo_info = classify_repository_path(repo.display().to_string())
            .await
            .unwrap();
        assert!(repo_info.is_directory);
        assert!(repo_info.is_repository);
        assert!(!repo_info.is_bare);
        assert_eq!(repo_info.name, "repo");
    }

    #[test]
    fn scan_root_must_exist_and_be_a_folder() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("notes.txt");
        fs::write(&file, "hello").unwrap();

        let missing = validate_scan_root(&tmp.path().join("gone")).unwrap_err();
        assert!(
            missing.to_string().contains("no longer exists"),
            "got: {missing}"
        );

        let not_a_folder = validate_scan_root(&file).unwrap_err();
        assert!(
            not_a_folder.to_string().contains("is not a folder"),
            "got: {not_a_folder}"
        );

        assert!(validate_scan_root(tmp.path()).is_ok());
    }

    #[test]
    fn requested_depth_is_clamped_to_the_ceiling() {
        let clamped = 10_000_usize.clamp(1, MAX_ALLOWED_DEPTH);
        assert_eq!(clamped, MAX_ALLOWED_DEPTH);
        assert_eq!(0_usize.clamp(1, MAX_ALLOWED_DEPTH), 1);
    }
}
