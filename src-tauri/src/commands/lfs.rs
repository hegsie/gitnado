//! Git LFS command handlers
//! Manage large files with Git Large File Storage

use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::utils::{apply_token_credential_helper, create_command};

/// LFS file tracking pattern
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsPattern {
    /// The file pattern (e.g., "*.psd")
    pub pattern: String,
}

/// LFS file information
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsFile {
    /// File path
    pub path: String,
    /// LFS object ID (OID)
    pub oid: Option<String>,
    /// File size in bytes
    pub size: Option<u64>,
    /// Whether the file is downloaded (pointer vs actual)
    pub downloaded: bool,
}

/// LFS status information
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsStatus {
    /// Whether Git LFS is installed
    pub installed: bool,
    /// Git LFS version
    pub version: Option<String>,
    /// Whether LFS is enabled for this repo
    pub enabled: bool,
    /// Tracked patterns
    pub patterns: Vec<LfsPattern>,
    /// Number of LFS files
    pub file_count: u32,
    /// Total size of LFS files
    pub total_size: u64,
}

/// URL of the remote `git lfs` will talk to: the current branch's upstream
/// remote, else `origin`, matching how git-lfs itself picks one.
///
/// Used only to scope the injected credential helper. `None` — an unborn or
/// detached HEAD with no `origin`, or an unreadable repository — installs no
/// helper at all, which is the safe direction: the transfer fails to
/// authenticate instead of offering the token to an unknown host.
fn lfs_remote_url(repo_path: &Path) -> Option<String> {
    let repo = git2::Repository::open(repo_path).ok()?;

    let head = repo.head().ok();
    let upstream_remote = head
        .as_ref()
        .filter(|head| head.is_branch())
        .and_then(|head| head.name().ok())
        .and_then(|ref_name| repo.branch_upstream_remote(ref_name).ok())
        .and_then(|buf| buf.as_str().ok().map(|name| name.to_owned()));

    let remote_name = upstream_remote.unwrap_or_else(|| "origin".to_owned());

    let remote = repo.find_remote(&remote_name).ok()?;
    remote.url().ok().map(|url| url.to_owned())
}

/// Build the `git lfs <args>` invocation, optionally authenticated.
///
/// `git lfs` resolves credentials by shelling out to `git credential`, which
/// inherits this process's environment — so the helper installed here reaches
/// the LFS API endpoint as well as the transfer itself.
///
/// That reach is exactly why the helper is scoped to the remote's host. The LFS
/// endpoint is NOT necessarily the remote: git-lfs reads `lfs.url` from
/// `.lfsconfig`, a file committed to the repository, so the host git asks about
/// is attacker-controlled in any repo the user merely cloned.
fn build_lfs_command(
    repo_path: &Path,
    args: &[&str],
    token: Option<&str>,
) -> std::process::Command {
    let mut cmd = create_command("git");
    cmd.current_dir(repo_path).arg("lfs").args(args);

    if let Some(token_value) = token {
        if let Some(remote_url) = lfs_remote_url(repo_path) {
            apply_token_credential_helper(&mut cmd, token_value, &remote_url);
        }
    }

    cmd
}

/// Helper to run git-lfs commands
fn run_lfs_command(repo_path: &Path, args: &[&str]) -> Result<String> {
    run_lfs_command_with_token(repo_path, args, None)
}

/// Helper to run git-lfs commands against an authenticated remote
fn run_lfs_command_with_token(
    repo_path: &Path,
    args: &[&str],
    token: Option<&str>,
) -> Result<String> {
    let output = build_lfs_command(repo_path, args, token)
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run git-lfs: {}", e)))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(stdout.trim().to_string())
    } else {
        Err(GitnadoError::OperationFailed(
            if stderr.is_empty() { stdout } else { stderr }
                .trim()
                .to_string(),
        ))
    }
}

/// Check if Git LFS is installed
fn is_lfs_installed() -> bool {
    create_command("git")
        .arg("lfs")
        .arg("version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Whether an attributes file's contents turn the LFS filter on for some
/// pattern. Comment lines do not count: a commented-out rule is not config.
fn enables_lfs(content: &str) -> bool {
    content.lines().any(|line| {
        let line = line.trim();
        !line.starts_with('#') && line.contains("filter=lfs")
    })
}

/// Whether the attributes file at `path` enables LFS. A missing or unreadable
/// file simply does not.
fn file_enables_lfs(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|c| enables_lfs(&c))
        .unwrap_or(false)
}

/// Whether LFS is configured for this repository.
///
/// Git reads attributes from a `.gitattributes` in every directory of the
/// tree, not just the root, plus `.git/info/attributes`. A monorepo that keeps
/// its rules in e.g. `assets/.gitattributes` is an LFS repo just the same;
/// looking only at the root file reported those repos as "not configured",
/// which hid the file list and the pull/prune actions in the UI.
fn is_lfs_enabled(repo_path: &Path) -> bool {
    // The root file is read straight from disk: `git lfs track` writes it long
    // before it is ever committed.
    if file_enables_lfs(&repo_path.join(".gitattributes")) {
        return true;
    }

    let Ok(repo) = git2::Repository::open(repo_path) else {
        return false;
    };

    // Not part of the tree; repo.path() resolves the git dir for linked
    // worktrees too.
    if file_enables_lfs(&repo.path().join("info").join("attributes")) {
        return true;
    }

    // Nested attributes files, taken from the index rather than a directory
    // walk: it costs no directory IO and still sees files that are not checked
    // out. The working-tree copy is what git actually applies, so when the file
    // is there it is the only thing consulted -- `git lfs untrack` empties a
    // rule long before that removal is committed, and falling through to the
    // old blob would keep reporting the repo as configured. The committed blob
    // is only for entries with no file on disk at all (sparse/partial clones).
    let Ok(index) = repo.index() else {
        return false;
    };
    index.iter().any(|entry| {
        let rel = String::from_utf8_lossy(&entry.path).to_string();
        let rel = Path::new(&rel);
        if rel.file_name() != Some(std::ffi::OsStr::new(".gitattributes")) {
            return false;
        }
        let checked_out = repo_path.join(rel);
        if checked_out.exists() {
            return file_enables_lfs(&checked_out);
        }
        repo.find_blob(entry.id)
            .map(|b| enables_lfs(&String::from_utf8_lossy(b.content())))
            .unwrap_or(false)
    })
}

/// The pattern a `git lfs track` listing line reports, and the attributes file
/// that defines it. Lines look like `    assets/*.psd (assets/.gitattributes)`,
/// optionally with a ` [lockable]` marker before the source.
fn parse_track_line(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    let (left, source) = line.rsplit_once('(')?;
    let source = source.strip_suffix(')')?.trim();
    let pattern = left.split_whitespace().next()?;
    Some((pattern, source))
}

/// Whether a `git lfs track` listing still reports `pattern`.
fn lists_pattern(track_output: &str, pattern: &str) -> bool {
    track_output
        .lines()
        .any(|line| parse_track_line(line).is_some_and(|(listed, _)| listed == pattern))
}

/// Where `git lfs untrack` has to run to remove `pattern`, and the pattern as
/// written in the attributes file it lives in.
///
/// `git lfs track` reports patterns relative to the repository root and names
/// the file that defines each one, so a rule written as `*.psd` in
/// `assets/.gitattributes` is listed as `assets/*.psd`. `git lfs untrack` only
/// rewrites the `.gitattributes` in its own working directory, and matches
/// lines by the pattern exactly as written there. Run from the root with the
/// listed name it therefore rewrites the root file, leaves the nested rule
/// alone and still exits 0 -- which is what made Remove report success and
/// change nothing.
///
/// Returns the directory relative to the repository root ("" for the root
/// itself) and the pattern to pass. `None` when the listing does not mention
/// the pattern, or when it comes from inside the git directory
/// (`.git/info/attributes`), which `git lfs untrack` cannot rewrite at all --
/// the caller falls back to the root and the check afterwards reports the
/// pattern is still tracked.
fn resolve_untrack_target(track_output: &str, pattern: &str) -> Option<(String, String)> {
    let source = track_output.lines().find_map(|line| {
        parse_track_line(line).and_then(|(listed, source)| (listed == pattern).then_some(source))
    })?;

    let dir = Path::new(source)
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();

    if dir.is_empty() || dir == "." {
        return Some((String::new(), pattern.to_string()));
    }

    if dir == ".git" || dir.starts_with(".git/") {
        return None;
    }

    let raw = pattern
        .strip_prefix(&format!("{}/", dir))
        .unwrap_or(pattern)
        .to_string();
    Some((dir, raw))
}

/// Get LFS version
fn get_lfs_version() -> Option<String> {
    create_command("git")
        .arg("lfs")
        .arg("version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .lines()
                .next()
                .unwrap_or("")
                .to_string()
        })
}

/// Get LFS status for the repository
#[command]
pub async fn get_lfs_status(path: String) -> Result<LfsStatus> {
    let repo_path = Path::new(&path);
    let installed = is_lfs_installed();
    let version = get_lfs_version();

    if !installed {
        return Ok(LfsStatus {
            installed: false,
            version: None,
            enabled: false,
            patterns: Vec::new(),
            file_count: 0,
            total_size: 0,
        });
    }

    // Check if LFS is enabled (attributes anywhere in the repo, not just root)
    let enabled = is_lfs_enabled(repo_path);

    // Get tracked patterns
    let patterns = if enabled {
        run_lfs_command(repo_path, &["track"])
            .ok()
            .map(|output| {
                output
                    .lines()
                    .filter_map(|line| {
                        // Lines like "    *.psd (.gitattributes)"
                        let line = line.trim();
                        if line.starts_with('*') || line.contains('.') {
                            Some(LfsPattern {
                                pattern: line.split_whitespace().next().unwrap_or(line).to_string(),
                            })
                        } else {
                            None
                        }
                    })
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    // Get file count and size
    let (file_count, total_size) = if enabled {
        run_lfs_command(repo_path, &["ls-files", "-s"])
            .ok()
            .map(|output| {
                let mut count = 0u32;
                let mut size = 0u64;
                for line in output.lines() {
                    // Format: "oid - path (size)"
                    count += 1;
                    // Try to extract size from parentheses
                    if let Some(size_start) = line.rfind('(') {
                        if let Some(size_str) = line[size_start + 1..].strip_suffix(')') {
                            size += parse_size(size_str);
                        }
                    }
                }
                (count, size)
            })
            .unwrap_or((0, 0))
    } else {
        (0, 0)
    };

    Ok(LfsStatus {
        installed,
        version,
        enabled,
        patterns,
        file_count,
        total_size,
    })
}

/// Parse size string like "1.5 MB" or "500 KB"
fn parse_size(s: &str) -> u64 {
    let s = s.trim();
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 2 {
        return 0;
    }

    let num: f64 = parts[0].parse().unwrap_or(0.0);
    let unit = parts[1].to_uppercase();

    let multiplier = match unit.as_str() {
        "B" => 1,
        "KB" => 1024,
        "MB" => 1024 * 1024,
        "GB" => 1024 * 1024 * 1024,
        _ => 1,
    };

    (num * multiplier as f64) as u64
}

/// Initialize Git LFS in the repository
#[command]
pub async fn init_lfs(path: String) -> Result<()> {
    let repo_path = Path::new(&path);

    if !is_lfs_installed() {
        return Err(GitnadoError::OperationFailed(
            "Git LFS is not installed. Please install it first.".to_string(),
        ));
    }

    run_lfs_command(repo_path, &["install"])?;
    Ok(())
}

/// Track files matching a pattern with LFS
#[command]
pub async fn lfs_track(path: String, pattern: String) -> Result<()> {
    let repo_path = Path::new(&path);
    run_lfs_command(repo_path, &["track", &pattern])?;
    Ok(())
}

/// Untrack a file pattern from LFS
#[command]
pub async fn lfs_untrack(path: String, pattern: String) -> Result<()> {
    let repo_path = Path::new(&path);

    // A rule defined in a nested `.gitattributes` has to be removed from the
    // directory that defines it -- see `resolve_untrack_target`. When the
    // listing is unavailable, or does not name the pattern, fall back to the
    // repository root, which is where every pattern used to be removed from.
    let (dir, raw) = run_lfs_command(repo_path, &["track"])
        .ok()
        .and_then(|output| resolve_untrack_target(&output, &pattern))
        .unwrap_or_else(|| (String::new(), pattern.clone()));

    let work_dir = if dir.is_empty() {
        repo_path.to_path_buf()
    } else {
        repo_path.join(&dir)
    };

    run_lfs_command(&work_dir, &["untrack", &raw])?;

    // `git lfs untrack` rewrites the attributes file in its working directory
    // and exits 0 even when it matched nothing, so a success here is not proof
    // the rule is gone. Confirm it, rather than letting the dialog report
    // "No longer tracking ..." over a pattern that is still there.
    if let Ok(output) = run_lfs_command(repo_path, &["track"]) {
        if lists_pattern(&output, &pattern) {
            return Err(GitnadoError::OperationFailed(format!(
                "{} is still tracked. Remove it from the .gitattributes that defines it.",
                pattern
            )));
        }
    }

    Ok(())
}

/// Get list of LFS files in the repository
#[command]
pub async fn get_lfs_files(path: String) -> Result<Vec<LfsFile>> {
    let repo_path = Path::new(&path);

    let output = run_lfs_command(repo_path, &["ls-files", "-l"])?;

    let files = output
        .lines()
        .filter_map(|line| {
            // Format: "oid * path" or "oid - path"
            let parts: Vec<&str> = line.splitn(3, ' ').collect();
            if parts.len() >= 3 {
                let oid = parts[0].to_string();
                let downloaded = parts[1] == "*";
                let file_path = parts[2].to_string();

                Some(LfsFile {
                    path: file_path,
                    oid: Some(oid),
                    size: None,
                    downloaded,
                })
            } else {
                None
            }
        })
        .collect();

    Ok(files)
}

/// Pull (download) LFS files
#[command]
pub async fn lfs_pull(path: String, token: Option<String>) -> Result<String> {
    let repo_path = Path::new(&path);

    run_lfs_command_with_token(repo_path, &["pull"], token.as_deref())
}

/// Fetch LFS files from remote
#[command]
pub async fn lfs_fetch(
    path: String,
    refs: Option<Vec<String>>,
    token: Option<String>,
) -> Result<String> {
    let repo_path = Path::new(&path);
    let token = token.as_deref();

    let mut args = vec!["fetch"];

    let refs_owned: Vec<String>;
    if let Some(r) = refs {
        refs_owned = r;
        for ref_name in &refs_owned {
            args.push(ref_name);
        }
    }

    run_lfs_command_with_token(repo_path, &args, token)
}

/// Prune old LFS files
#[command]
pub async fn lfs_prune(path: String, dry_run: Option<bool>) -> Result<String> {
    let repo_path = Path::new(&path);

    let mut args = vec!["prune"];

    if dry_run.unwrap_or(false) {
        args.push("--dry-run");
    }

    run_lfs_command(repo_path, &args)
}

/// Migrate existing files to LFS
#[command]
pub async fn lfs_migrate(
    path: String,
    pattern: String,
    include_refs: Option<Vec<String>>,
) -> Result<String> {
    let repo_path = Path::new(&path);

    let include_arg = format!("--include={}", pattern);
    let mut args = vec!["migrate", "import", &include_arg];

    // Add refs if specified
    let refs_owned: Vec<String>;
    if let Some(refs) = include_refs {
        refs_owned = refs;
        for r in &refs_owned {
            args.push(r);
        }
    }

    run_lfs_command(repo_path, &args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[test]
    fn test_parse_size_bytes() {
        assert_eq!(parse_size("100 B"), 100);
    }

    #[test]
    fn test_parse_size_kilobytes() {
        assert_eq!(parse_size("1 KB"), 1024);
        assert_eq!(parse_size("2 KB"), 2048);
    }

    #[test]
    fn test_parse_size_megabytes() {
        assert_eq!(parse_size("1 MB"), 1024 * 1024);
        assert_eq!(parse_size("1.5 MB"), (1.5 * 1024.0 * 1024.0) as u64);
    }

    #[test]
    fn test_parse_size_gigabytes() {
        assert_eq!(parse_size("1 GB"), 1024 * 1024 * 1024);
    }

    #[test]
    fn test_parse_size_invalid() {
        assert_eq!(parse_size("invalid"), 0);
        assert_eq!(parse_size(""), 0);
        assert_eq!(parse_size("100"), 0); // Missing unit
    }

    #[test]
    fn test_parse_size_whitespace() {
        assert_eq!(parse_size("  100 KB  "), 100 * 1024);
    }

    #[tokio::test]
    async fn test_get_lfs_status_no_lfs() {
        let repo = TestRepo::with_initial_commit();

        let result = get_lfs_status(repo.path_str()).await;
        assert!(result.is_ok());

        let status = result.unwrap();
        // LFS might or might not be installed on the test system
        // but the function should not fail
        if !status.installed {
            assert!(!status.enabled);
            assert!(status.patterns.is_empty());
            assert_eq!(status.file_count, 0);
            assert_eq!(status.total_size, 0);
        }
    }

    #[tokio::test]
    async fn test_get_lfs_status_with_gitattributes() {
        let repo = TestRepo::with_initial_commit();

        // Create a .gitattributes file with LFS filter
        repo.create_file(
            ".gitattributes",
            "*.bin filter=lfs diff=lfs merge=lfs -text\n",
        );

        let result = get_lfs_status(repo.path_str()).await;
        assert!(result.is_ok());

        let status = result.unwrap();
        if status.installed {
            assert!(status.enabled);
        }
    }

    #[test]
    fn test_lfs_enabled_from_nested_gitattributes() {
        let repo = TestRepo::with_initial_commit();

        // Monorepo layout: the LFS rules live in a subdirectory, with no
        // .gitattributes at the repo root at all.
        repo.create_commit(
            "Track assets",
            &[(
                "assets/.gitattributes",
                "*.psd filter=lfs diff=lfs merge=lfs -text\n",
            )],
        );
        assert!(!repo.path.join(".gitattributes").exists());

        assert!(is_lfs_enabled(&repo.path));
    }

    #[test]
    fn test_lfs_enabled_from_nested_gitattributes_not_checked_out() {
        let repo = TestRepo::with_initial_commit();

        repo.create_commit(
            "Track assets",
            &[(
                "assets/.gitattributes",
                "*.psd filter=lfs diff=lfs merge=lfs -text\n",
            )],
        );

        // Sparse/partial checkout: the entry is in the index and the committed
        // tree, but there is no file on disk to read.
        std::fs::remove_file(repo.path.join("assets/.gitattributes")).unwrap();

        assert!(is_lfs_enabled(&repo.path));
    }

    #[test]
    fn test_lfs_enabled_from_info_attributes() {
        let repo = TestRepo::with_initial_commit();

        // Repo-local attributes, deliberately not part of the tree.
        std::fs::create_dir_all(repo.path.join(".git/info")).unwrap();
        std::fs::write(
            repo.path.join(".git/info/attributes"),
            "*.bin filter=lfs diff=lfs merge=lfs -text\n",
        )
        .unwrap();
        assert!(!repo.path.join(".gitattributes").exists());

        assert!(is_lfs_enabled(&repo.path));
    }

    #[test]
    fn test_lfs_enabled_from_root_gitattributes() {
        let repo = TestRepo::with_initial_commit();

        // Uncommitted, as `git lfs track` leaves it.
        repo.create_file(
            ".gitattributes",
            "*.bin filter=lfs diff=lfs merge=lfs -text\n",
        );

        assert!(is_lfs_enabled(&repo.path));
    }

    #[test]
    fn test_lfs_not_enabled_without_lfs_filter() {
        let repo = TestRepo::with_initial_commit();

        // Attributes files exist at the root and nested, but none of them
        // mention the LFS filter.
        repo.create_file(".gitattributes", "*.txt text\n");
        repo.create_commit("Docs attributes", &[("docs/.gitattributes", "*.md text\n")]);

        assert!(!is_lfs_enabled(&repo.path));
    }

    #[test]
    fn test_lfs_not_enabled_for_commented_out_filter() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file(
            ".gitattributes",
            "# *.psd filter=lfs diff=lfs merge=lfs -text\n",
        );

        assert!(!is_lfs_enabled(&repo.path));
    }

    #[test]
    fn test_lfs_not_enabled_when_nested_attributes_emptied_in_working_tree() {
        let repo = TestRepo::with_initial_commit();

        repo.create_commit(
            "Track assets",
            &[(
                "assets/.gitattributes",
                "*.psd filter=lfs diff=lfs merge=lfs -text\n",
            )],
        );

        // What `git lfs untrack` leaves behind: the file is still checked out,
        // the rule is gone, and the removal is not committed yet. The stale
        // blob must not keep the repo reading as configured.
        repo.create_file("assets/.gitattributes", "\n");

        assert!(!is_lfs_enabled(&repo.path));
    }

    #[test]
    fn test_lfs_not_enabled_when_root_attributes_emptied_in_working_tree() {
        let repo = TestRepo::with_initial_commit();

        repo.create_commit(
            "Track binaries",
            &[(
                ".gitattributes",
                "*.bin filter=lfs diff=lfs merge=lfs -text\n",
            )],
        );

        repo.create_file(".gitattributes", "*.txt text\n");

        assert!(!is_lfs_enabled(&repo.path));
    }

    #[test]
    fn test_parse_track_line_root_and_nested() {
        assert_eq!(
            parse_track_line("    *.psd (.gitattributes)"),
            Some(("*.psd", ".gitattributes"))
        );
        assert_eq!(
            parse_track_line("    assets/*.psd (assets/.gitattributes)"),
            Some(("assets/*.psd", "assets/.gitattributes"))
        );
        assert_eq!(
            parse_track_line("    assets/*.psd [lockable] (assets/.gitattributes)"),
            Some(("assets/*.psd", "assets/.gitattributes"))
        );
        assert_eq!(parse_track_line("Listing tracked patterns"), None);
        assert_eq!(parse_track_line(""), None);
    }

    #[test]
    fn test_resolve_untrack_target_nested_runs_from_defining_directory() {
        let output = "Listing tracked patterns\n    *.bin (.gitattributes)\n    assets/*.psd (assets/.gitattributes)\n";

        // The listed name is repo-relative; the file itself says "*.psd".
        assert_eq!(
            resolve_untrack_target(output, "assets/*.psd"),
            Some(("assets".to_string(), "*.psd".to_string()))
        );
    }

    #[test]
    fn test_resolve_untrack_target_deeply_nested() {
        let output = "    a/b/c/*.psd (a/b/c/.gitattributes)\n";

        assert_eq!(
            resolve_untrack_target(output, "a/b/c/*.psd"),
            Some(("a/b/c".to_string(), "*.psd".to_string()))
        );
    }

    #[test]
    fn test_resolve_untrack_target_root_stays_at_root() {
        let output = "Listing tracked patterns\n    *.bin (.gitattributes)\n";

        assert_eq!(
            resolve_untrack_target(output, "*.bin"),
            Some((String::new(), "*.bin".to_string()))
        );
    }

    #[test]
    fn test_resolve_untrack_target_lockable_pattern() {
        let output = "    assets/*.psd [lockable] (assets/.gitattributes)\n";

        assert_eq!(
            resolve_untrack_target(output, "assets/*.psd"),
            Some(("assets".to_string(), "*.psd".to_string()))
        );
    }

    #[test]
    fn test_resolve_untrack_target_unknown_pattern() {
        let output = "Listing tracked patterns\n    *.bin (.gitattributes)\n";

        // Nothing to redirect to; the caller falls back to the repository root.
        assert_eq!(resolve_untrack_target(output, "*.psd"), None);
    }

    #[test]
    fn test_resolve_untrack_target_ignores_git_dir_source() {
        // `.git/info/attributes` is not a file `git lfs untrack` can rewrite,
        // and its directory is not a place to run from.
        let output = "    .git/info/*.psd (.git/info/attributes)\n";

        assert_eq!(resolve_untrack_target(output, ".git/info/*.psd"), None);
    }

    #[test]
    fn test_lists_pattern() {
        let output = "Listing tracked patterns\n    *.bin (.gitattributes)\n    assets/*.psd (assets/.gitattributes)\n";

        assert!(lists_pattern(output, "*.bin"));
        assert!(lists_pattern(output, "assets/*.psd"));
        assert!(!lists_pattern(output, "*.psd"));
        assert!(!lists_pattern(output, ""));
        assert!(!lists_pattern("", "*.bin"));
    }

    #[test]
    fn test_lfs_enabled_false_for_missing_repo() {
        assert!(!is_lfs_enabled(std::path::Path::new("/nonexistent/path")));
    }

    #[tokio::test]
    async fn test_get_lfs_status_invalid_path() {
        let result = get_lfs_status("/nonexistent/path".to_string()).await;
        // Should return status with installed info but not crash
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_init_lfs_when_not_installed() {
        let repo = TestRepo::with_initial_commit();

        let result = init_lfs(repo.path_str()).await;
        // Result depends on whether LFS is installed on the system
        // If not installed, should return error
        if !is_lfs_installed() {
            assert!(result.is_err());
            let err = result.unwrap_err();
            assert!(err.to_string().contains("not installed"));
        }
    }

    #[tokio::test]
    async fn test_lfs_track_pattern() {
        let repo = TestRepo::with_initial_commit();

        // Skip if LFS is not installed
        if !is_lfs_installed() {
            return;
        }

        // Initialize LFS first
        let _ = init_lfs(repo.path_str()).await;

        let result = lfs_track(repo.path_str(), "*.bin".to_string()).await;
        assert!(result.is_ok());

        // Verify the pattern was added to .gitattributes
        let gitattributes = std::fs::read_to_string(repo.path.join(".gitattributes"));
        assert!(gitattributes.is_ok());
        assert!(gitattributes.unwrap().contains("*.bin filter=lfs"));
    }

    #[tokio::test]
    async fn test_lfs_untrack_pattern() {
        let repo = TestRepo::with_initial_commit();

        // Skip if LFS is not installed
        if !is_lfs_installed() {
            return;
        }

        // Initialize and track a pattern first
        let _ = init_lfs(repo.path_str()).await;
        let _ = lfs_track(repo.path_str(), "*.bin".to_string()).await;

        let result = lfs_untrack(repo.path_str(), "*.bin".to_string()).await;
        assert!(result.is_ok());

        // Verify the pattern was removed from .gitattributes
        let gitattributes = std::fs::read_to_string(repo.path.join(".gitattributes"));
        assert!(gitattributes.is_ok());
        assert!(!gitattributes.unwrap().contains("*.bin filter=lfs"));
    }

    #[tokio::test]
    async fn test_get_lfs_files_empty_repo() {
        let repo = TestRepo::with_initial_commit();

        // Skip if LFS is not installed
        if !is_lfs_installed() {
            return;
        }

        let result = get_lfs_files(repo.path_str()).await;
        // Should either succeed with empty list or fail gracefully
        if let Ok(files) = result {
            assert!(files.is_empty());
        }
    }

    #[tokio::test]
    async fn test_lfs_prune_dry_run() {
        let repo = TestRepo::with_initial_commit();

        // Skip if LFS is not installed
        if !is_lfs_installed() {
            return;
        }

        let _ = init_lfs(repo.path_str()).await;

        let result = lfs_prune(repo.path_str(), Some(true)).await;
        // Should succeed or fail gracefully (no LFS files to prune)
        // The command itself should not crash
        let _ = result;
    }

    #[tokio::test]
    async fn test_lfs_status_struct_serialization() {
        let status = LfsStatus {
            installed: true,
            version: Some("git-lfs/3.0.0".to_string()),
            enabled: true,
            patterns: vec![LfsPattern {
                pattern: "*.bin".to_string(),
            }],
            file_count: 5,
            total_size: 1024 * 1024,
        };

        let json = serde_json::to_string(&status);
        assert!(json.is_ok());
        let json_str = json.unwrap();
        assert!(json_str.contains("\"installed\":true"));
        assert!(json_str.contains("\"enabled\":true"));
        assert!(json_str.contains("\"fileCount\":5"));
        assert!(json_str.contains("\"totalSize\":1048576"));
    }

    #[tokio::test]
    async fn test_lfs_file_struct_serialization() {
        let file = LfsFile {
            path: "large-file.bin".to_string(),
            oid: Some("abc123".to_string()),
            size: Some(1024),
            downloaded: true,
        };

        let json = serde_json::to_string(&file);
        assert!(json.is_ok());
        let json_str = json.unwrap();
        assert!(json_str.contains("\"path\":\"large-file.bin\""));
        assert!(json_str.contains("\"downloaded\":true"));
    }

    #[tokio::test]
    async fn test_lfs_pattern_struct_serialization() {
        let pattern = LfsPattern {
            pattern: "*.psd".to_string(),
        };

        let json = serde_json::to_string(&pattern);
        assert!(json.is_ok());
        assert!(json.unwrap().contains("\"pattern\":\"*.psd\""));
    }

    /// A repo whose `origin` is an https remote — the host an injected
    /// credential helper is allowed to answer for.
    fn repo_with_https_origin() -> TestRepo {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://git.example.com/o/r.git");
        repo
    }

    /// Value of `key` in the env `cmd` will spawn with, as a String.
    fn env_of(cmd: &std::process::Command, key: &str) -> Option<String> {
        cmd.get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new(key))
            .and_then(|(_, v)| v)
            .map(|v| v.to_string_lossy().to_string())
    }

    #[test]
    fn test_lfs_pull_command_carries_the_token_credential_helper() {
        // The frontend looks the repo's credential up and sends it, so a pull
        // that drops it dead-ends on every private LFS remote: the child runs
        // unauthenticated with GIT_TERMINAL_PROMPT=0 and the dialog shows a raw
        // "could not read Username" in a repo the app can otherwise push.
        let repo = repo_with_https_origin();
        let cmd = build_lfs_command(&repo.path, &["pull"], Some("s3cr3t"));

        assert_eq!(
            env_of(&cmd, "GIT_CONFIG_COUNT").as_deref(),
            Some("2"),
            "a token must install exactly two config overrides: an empty \
             reset then the helper"
        );
        assert_eq!(
            env_of(&cmd, "GIT_CONFIG_KEY_0").as_deref(),
            Some("credential.https://git.example.com.helper"),
            "the override must be the credential helper git asks for auth, \
             scoped to the remote's own host"
        );
        assert_eq!(
            env_of(&cmd, "GITNADO_GIT_TOKEN").as_deref(),
            Some("s3cr3t"),
            "the helper reads the token from this env var"
        );

        // The token must reach git ONLY through the env var: argv is readable
        // by every other user on the machine.
        let helper = env_of(&cmd, "GIT_CONFIG_VALUE_1").expect("helper must be set");
        assert!(helper.contains("GITNADO_GIT_TOKEN"));
        assert!(!helper.contains("s3cr3t"));
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(args, vec!["lfs", "pull"]);
    }

    /// What real git answers when asked for a credential for `host`, given the
    /// environment `build_lfs_command` prepared. Env vars being present proves
    /// nothing if the helper string is not one git honours, and the scoping
    /// lives in a config key only git knows how to match — so ask git itself.
    ///
    /// This is exactly what `git lfs` does to authenticate: it shells out to
    /// `git credential fill` for its endpoint's host.
    #[cfg(unix)]
    fn credential_fill_for(repo: &TestRepo, host: &str) -> String {
        let built = build_lfs_command(&repo.path, &["pull"], Some("s3cr3t"));

        let mut probe = create_command("git");
        probe.current_dir(&repo.path);
        for (key, value) in built.get_envs() {
            if let Some(value) = value {
                probe.env(key, value);
            }
        }

        let mut child = probe
            .arg("credential")
            .arg("fill")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("git credential fill must start");
        {
            use std::io::Write;
            child
                .stdin
                .as_mut()
                .expect("stdin is piped")
                .write_all(format!("protocol=https\nhost={}\n\n", host).as_bytes())
                .expect("the request must be writable");
        }
        let out = child.wait_with_output().expect("git must terminate");
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    #[cfg(unix)]
    #[test]
    fn test_injected_helper_answers_git_with_the_token() {
        let repo = repo_with_https_origin();
        let stdout = credential_fill_for(&repo, "git.example.com");

        assert!(
            stdout.contains("password=s3cr3t"),
            "git must resolve the token as the password, got: {}",
            stdout
        );
        assert!(stdout.contains("username=git"), "got: {}", stdout);
    }

    #[cfg(unix)]
    #[test]
    fn test_injected_helper_refuses_a_foreign_lfs_host() {
        // The endpoint `git lfs` authenticates against is NOT necessarily the
        // remote: it reads `lfs.url` from `.lfsconfig`, which is COMMITTED TO
        // THE REPOSITORY. Clone a hostile repo, click Pull, and an unscoped
        // `credential.helper` would hand that repo's own server the user's
        // provider token — a token that is usually good for every repo they can
        // reach. Committing the hostile `.lfsconfig` here as well, so the test
        // fails the way a user would actually be attacked.
        let repo = repo_with_https_origin();
        repo.create_commit(
            "add a hostile .lfsconfig",
            &[(
                ".lfsconfig",
                "[lfs]\n\turl = https://evil.example.net/o/r.git/info/lfs\n",
            )],
        );

        // A helper IS installed for this repo — otherwise the assertions below
        // would pass simply because nothing answered, proving nothing.
        let cmd = build_lfs_command(&repo.path, &["pull"], Some("s3cr3t"));
        assert_eq!(
            env_of(&cmd, "GITNADO_GIT_TOKEN").as_deref(),
            Some("s3cr3t"),
            "the token IS installed here; what follows is about who git offers it to"
        );

        let stdout = credential_fill_for(&repo, "evil.example.net");

        assert!(
            !stdout.contains("s3cr3t"),
            "the token must never be offered to a host the repository chose: {}",
            stdout
        );
        assert!(
            !stdout.contains("password="),
            "git must supply no password at all for a foreign host: {}",
            stdout
        );
    }

    #[test]
    fn test_ssh_remote_scopes_the_helper_to_the_provider_https_host() {
        // The LFS endpoint for a github.com repo is always https regardless of
        // the git remote's own transport, and the token is a PROVIDER
        // credential rather than a transport one — so an ssh origin must still
        // get a helper, scoped to that same provider over https, or a private
        // LFS repo cloned over ssh could never authenticate its LFS transfers.
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "git@github.com:o/r.git");

        let cmd = build_lfs_command(&repo.path, &["pull"], Some("s3cr3t"));

        assert_eq!(
            env_of(&cmd, "GIT_CONFIG_KEY_0").as_deref(),
            Some("credential.https://github.com.helper"),
            "an ssh remote must map to its provider's https host"
        );
        assert_eq!(env_of(&cmd, "GITNADO_GIT_TOKEN").as_deref(), Some("s3cr3t"));
    }

    #[test]
    fn test_repository_without_a_remote_installs_no_helper() {
        // Nothing says which host the token belongs to, so it must go nowhere.
        let repo = TestRepo::with_initial_commit();

        let cmd = build_lfs_command(&repo.path, &["pull"], Some("s3cr3t"));

        assert_eq!(env_of(&cmd, "GITNADO_GIT_TOKEN"), None);
        assert_eq!(env_of(&cmd, "GIT_CONFIG_KEY_0"), None);
    }

    #[test]
    fn test_lfs_fetch_with_refs_still_authenticates() {
        let repo = repo_with_https_origin();
        let cmd = build_lfs_command(&repo.path, &["fetch", "main"], Some("tok"));

        assert_eq!(
            env_of(&cmd, "GIT_CONFIG_KEY_0").as_deref(),
            Some("credential.https://git.example.com.helper"),
            "fetch shares the runner, so it must authenticate too"
        );

        // Authenticating must not disturb ref assembly.
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(args, vec!["lfs", "fetch", "main"]);
    }

    #[test]
    fn test_lfs_command_without_a_token_installs_no_helper() {
        // Local-only commands (prune, track, ls-files) must never override the
        // user's own credential helper.
        let repo = repo_with_https_origin();
        let cmd = build_lfs_command(&repo.path, &["prune"], None);

        for key in [
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_VALUE_0",
            "GITNADO_GIT_TOKEN",
        ] {
            assert_eq!(env_of(&cmd, key), None, "{} must not be set", key);
        }
    }

    #[test]
    fn test_blank_token_installs_no_helper() {
        // A helper answering with an empty password turns "no credentials" into
        // "login rejected" — a wronger error than no token at all.
        let repo = repo_with_https_origin();
        let cmd = build_lfs_command(&repo.path, &["pull"], Some("   "));

        for key in [
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_VALUE_0",
            "GITNADO_GIT_TOKEN",
        ] {
            assert_eq!(env_of(&cmd, key), None, "{} must not be set", key);
        }
    }

    #[tokio::test]
    async fn test_lfs_pull_error_does_not_leak_the_token() {
        // No remote is configured, so this pull fails (with git's "not a git
        // command" where LFS is absent). Either way the text goes straight to
        // the dialog's error banner, so it must never carry the token.
        //
        // Deliberately not gated on is_lfs_installed(): the leak guard is worth
        // more when it actually runs, and both failure modes exercise it.
        let repo = TestRepo::with_initial_commit();

        let result = lfs_pull(repo.path_str(), Some("s3cr3t".to_string())).await;

        let text = match result {
            Ok(output) => output,
            Err(err) => {
                let message = err.to_string();
                assert!(!message.is_empty(), "the failure must say something");
                message
            }
        };
        assert!(
            !text.contains("s3cr3t"),
            "the token must not reach a user-visible message: {}",
            text
        );
    }
}
