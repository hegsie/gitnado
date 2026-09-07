//! Clean command handlers
//! Remove untracked and ignored files from the working directory

use std::fs;
use std::path::Path;
use tauri::command;

use super::path_utils::validate_path_within_repo;
use crate::error::Result;

/// Entry representing a file that can be cleaned
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanEntry {
    pub path: String,
    pub is_directory: bool,
    pub is_ignored: bool,
    /// True when this entry is an untracked nested git repository (a directory
    /// containing a `.git` entry). Deleting it destroys the embedded repo's
    /// history, so `git clean` only removes it with a second `-f`; the UI must
    /// confirm and pass `force_nested` before it can be cleaned.
    pub is_nested_repo: bool,
    pub size: Option<u64>,
}

/// Get list of files that would be cleaned (dry run)
#[command]
pub async fn get_cleanable_files(
    path: String,
    include_ignored: Option<bool>,
    include_directories: Option<bool>,
) -> Result<Vec<CleanEntry>> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let workdir = repo.workdir().ok_or_else(|| {
        crate::error::GitnadoError::OperationFailed("Repository has no working directory".into())
    })?;

    let include_ignored = include_ignored.unwrap_or(false);
    let include_directories = include_directories.unwrap_or(true);

    let mut entries = Vec::new();

    // Get status to find untracked files.
    //
    // Do NOT recurse into fully-untracked directories: canonical `git clean`
    // without `-d` never touches files inside untracked directories, and with
    // `-d` it removes the whole directory as a single unit (printing
    // "Removing dir/"), not file-by-file. Reporting untracked directories as a
    // single entry lets `include_directories` behave exactly like `-d`
    // (dropping them when off) and lets a full clean remove the directory
    // itself instead of leaving an empty husk behind.
    let statuses = repo.statuses(Some(
        git2::StatusOptions::new()
            .include_untracked(true)
            .include_ignored(include_ignored)
            .recurse_untracked_dirs(false),
    ))?;

    for entry in statuses.iter() {
        let status = entry.status();
        let file_path = entry.path().unwrap_or("");

        // Check if file is untracked or ignored
        let is_untracked = status.contains(git2::Status::WT_NEW);
        let is_ignored = status.contains(git2::Status::IGNORED);

        if !is_untracked && !is_ignored {
            continue;
        }

        // Skip ignored files if not requested
        if is_ignored && !include_ignored {
            continue;
        }

        let full_path = workdir.join(file_path);
        let is_directory = full_path.is_dir();

        // Skip directories if not requested
        if is_directory && !include_directories {
            continue;
        }

        // A directory that itself contains a `.git` entry is an untracked
        // nested repository; deleting it destroys its history. Flag it so the
        // UI can require an explicit confirmation (mirroring `git clean`'s
        // second `-f`).
        // At ANY depth, not just the selected directory — see
        // utils::contains_nested_repo.
        let is_nested_repo = is_directory && crate::utils::contains_nested_repo(&full_path);

        // Get file size
        let size = if is_directory {
            None
        } else {
            fs::metadata(&full_path).ok().map(|m| m.len())
        };

        entries.push(CleanEntry {
            path: file_path.to_string(),
            is_directory,
            is_ignored,
            is_nested_repo,
            size,
        });
    }

    // Sort: directories first, then by path
    entries.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.path.cmp(&b.path),
    });

    Ok(entries)
}

/// Return true if the repository index tracks any path at or under `dir_rel`.
///
/// Used to guarantee we never `remove_dir_all` a directory that contains
/// version-controlled content — `git clean` only ever removes untracked files.
fn dir_contains_tracked(index: &git2::Index, dir_rel: &str) -> bool {
    let trimmed = dir_rel.trim_end_matches('/');
    if trimmed.is_empty() {
        // The work-tree root itself — treat as containing tracked content so we
        // never recursively delete the whole repository.
        return !index.is_empty();
    }
    let prefix = format!("{}/", trimmed);
    index.iter().any(|entry| {
        let p = String::from_utf8_lossy(&entry.path);
        p == trimmed || p.starts_with(&prefix)
    })
}

/// Clean (remove) specified files.
///
/// Mirrors `git clean`'s safety guarantees:
/// - Paths that escape the work tree (`..`, absolute) are rejected outright,
///   matching git's fatal "is outside repository"; the whole operation refuses
///   before deleting anything.
/// - Tracked/version-controlled paths are silently skipped (git clean never
///   deletes tracked content, even when named explicitly).
/// - Untracked nested git repositories are refused unless `force_nested` is set,
///   mirroring git's requirement of a second `-f` before destroying an embedded
///   repo's history.
#[command]
pub async fn clean_files(
    path: String,
    paths: Vec<String>,
    force_nested: Option<bool>,
) -> Result<u32> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let workdir = repo.workdir().ok_or_else(|| {
        crate::error::GitnadoError::OperationFailed("Repository has no working directory".into())
    })?;

    let force_nested = force_nested.unwrap_or(false);

    // Validate containment for EVERY path up front. git rejects pathspecs that
    // escape the work tree with a fatal error and deletes nothing; do the same
    // so a single bad ("../x") path can never destroy data outside the repo.
    let mut validated: Vec<(String, std::path::PathBuf)> = Vec::with_capacity(paths.len());
    for file_path in &paths {
        let full_path = validate_path_within_repo(workdir, file_path)?;
        validated.push((file_path.clone(), full_path));
    }

    let index = repo.index()?;
    let mut removed_count = 0;

    for (file_path, full_path) in &validated {
        if full_path.is_dir() {
            // Refuse to destroy an untracked nested repository unless the caller
            // explicitly opted in (git clean needs a second `-f`).
            if crate::utils::contains_nested_repo(full_path) && !force_nested {
                tracing::warn!(
                    "Refusing to remove nested git repository without force: {}",
                    file_path
                );
                continue;
            }
            // Never recursively delete a directory that holds tracked content.
            if dir_contains_tracked(&index, file_path) {
                tracing::warn!(
                    "Refusing to remove directory with tracked files: {}",
                    file_path
                );
                continue;
            }
            if fs::remove_dir_all(full_path).is_ok() {
                removed_count += 1;
                tracing::info!("Removed directory: {}", file_path);
            } else {
                tracing::warn!("Failed to remove directory: {}", file_path);
            }
        } else if full_path.is_file() {
            // Only remove untracked or ignored files. git clean silently skips
            // tracked paths (including staged ones) and never deletes
            // version-controlled content.
            let removable = matches!(
                repo.status_file(Path::new(file_path)),
                Ok(s) if s.contains(git2::Status::WT_NEW) || s.contains(git2::Status::IGNORED)
            );
            if !removable {
                tracing::warn!("Refusing to remove tracked path: {}", file_path);
                continue;
            }
            if fs::remove_file(full_path).is_ok() {
                removed_count += 1;
                tracing::info!("Removed file: {}", file_path);
            } else {
                tracing::warn!("Failed to remove file: {}", file_path);
            }
        }
    }

    Ok(removed_count)
}

/// Clean all untracked files
#[command]
pub async fn clean_all(
    path: String,
    include_ignored: Option<bool>,
    include_directories: Option<bool>,
) -> Result<u32> {
    let entries = get_cleanable_files(path.clone(), include_ignored, include_directories).await?;

    let paths: Vec<String> = entries.into_iter().map(|e| e.path).collect();
    clean_files(path, paths, None).await
}

#[cfg(test)]
mod tests {

    /// A nested repo BELOW the top level must be flagged and refused.
    ///
    /// git clean -fd skips a nested repository at any depth. Checking only
    /// `dir/.git` matched the selected directory alone, so an untracked
    /// `build/` holding `build/vendor/lib/.git` was reported as an ordinary
    /// directory, included in Select-all, and remove_dir_all'd — destroying a
    /// repository with no confirmation naming it.
    #[tokio::test]
    async fn test_clean_refuses_a_repo_nested_below_the_selected_dir() {
        let test_repo = TestRepo::with_initial_commit();
        let nested = test_repo.path.join("build/vendor/lib");
        std::fs::create_dir_all(&nested).unwrap();
        git2::Repository::init(&nested).unwrap();
        std::fs::write(test_repo.path.join("build/plain.txt"), "x").unwrap();

        let listed = get_cleanable_files(test_repo.path_str(), None, Some(true))
            .await
            .unwrap();
        let build = listed
            .iter()
            .find(|e| e.path.starts_with("build"))
            .expect("build/ must be listed");
        assert!(
            build.is_nested_repo,
            "a repo nested below the selected directory must still flag it"
        );

        clean_files(test_repo.path_str(), vec![build.path.clone()], None)
            .await
            .unwrap();

        assert!(
            nested.join(".git").exists(),
            "the nested repository must survive a clean that did not force it"
        );
    }
    use super::*;
    use crate::test_utils::TestRepo;

    #[tokio::test]
    async fn test_get_cleanable_files_empty() {
        let repo = TestRepo::with_initial_commit();
        let result = get_cleanable_files(repo.path_str(), None, None).await;

        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_get_cleanable_files_untracked_file() {
        let repo = TestRepo::with_initial_commit();

        // Create an untracked file
        repo.create_file("untracked.txt", "untracked content");

        let result = get_cleanable_files(repo.path_str(), None, None).await;

        assert!(result.is_ok());
        let entries = result.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "untracked.txt");
        assert!(!entries[0].is_directory);
        assert!(!entries[0].is_ignored);
        assert!(entries[0].size.is_some());
    }

    #[tokio::test]
    async fn test_get_cleanable_files_untracked_directory() {
        let repo = TestRepo::with_initial_commit();

        // Create an untracked directory with files
        repo.create_file("untracked_dir/file1.txt", "content 1");
        repo.create_file("untracked_dir/file2.txt", "content 2");

        let result = get_cleanable_files(repo.path_str(), None, Some(true)).await;

        assert!(result.is_ok());
        let entries = result.unwrap();
        // Should contain the files (directories are typically not listed separately)
        assert!(!entries.is_empty());
    }

    #[tokio::test]
    async fn test_get_cleanable_files_excludes_tracked() {
        let repo = TestRepo::with_initial_commit();

        // The README.md is tracked, so it shouldn't appear
        let result = get_cleanable_files(repo.path_str(), None, None).await;

        assert!(result.is_ok());
        let entries = result.unwrap();
        // Should not contain README.md
        assert!(!entries.iter().any(|e| e.path == "README.md"));
    }

    #[tokio::test]
    async fn test_get_cleanable_files_includes_ignored_when_requested() {
        let repo = TestRepo::with_initial_commit();

        // Create a .gitignore
        repo.create_file(".gitignore", "*.log\n");
        repo.stage_file(".gitignore");
        repo.create_commit("Add gitignore", &[]);

        // Create an ignored file
        repo.create_file("debug.log", "log content");

        // Without include_ignored, should not include ignored files
        let result_without = get_cleanable_files(repo.path_str(), Some(false), None).await;
        assert!(result_without.is_ok());
        let entries_without = result_without.unwrap();
        assert!(!entries_without.iter().any(|e| e.path == "debug.log"));

        // With include_ignored, should include ignored files
        let result_with = get_cleanable_files(repo.path_str(), Some(true), None).await;
        assert!(result_with.is_ok());
        let entries_with = result_with.unwrap();
        let ignored_entry = entries_with.iter().find(|e| e.path == "debug.log");
        assert!(ignored_entry.is_some());
        assert!(ignored_entry.unwrap().is_ignored);
    }

    #[tokio::test]
    async fn test_clean_files_removes_file() {
        let repo = TestRepo::with_initial_commit();

        // Create an untracked file
        repo.create_file("to_delete.txt", "delete me");

        // Verify file exists
        assert!(repo.path.join("to_delete.txt").exists());

        let result = clean_files(repo.path_str(), vec!["to_delete.txt".to_string()], None).await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 1);

        // Verify file is deleted
        assert!(!repo.path.join("to_delete.txt").exists());
    }

    #[tokio::test]
    async fn test_clean_files_removes_directory() {
        let repo = TestRepo::with_initial_commit();

        // Create an untracked directory
        repo.create_file("temp_dir/file.txt", "content");

        // Verify directory exists
        assert!(repo.path.join("temp_dir").exists());

        let result = clean_files(repo.path_str(), vec!["temp_dir".to_string()], None).await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 1);

        // Verify directory is deleted
        assert!(!repo.path.join("temp_dir").exists());
    }

    #[tokio::test]
    async fn test_clean_files_multiple() {
        let repo = TestRepo::with_initial_commit();

        // Create multiple untracked files
        repo.create_file("file1.txt", "content 1");
        repo.create_file("file2.txt", "content 2");
        repo.create_file("file3.txt", "content 3");

        let result = clean_files(
            repo.path_str(),
            vec![
                "file1.txt".to_string(),
                "file2.txt".to_string(),
                "file3.txt".to_string(),
            ],
            None,
        )
        .await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 3);

        // Verify all files are deleted
        assert!(!repo.path.join("file1.txt").exists());
        assert!(!repo.path.join("file2.txt").exists());
        assert!(!repo.path.join("file3.txt").exists());
    }

    #[tokio::test]
    async fn test_clean_files_nonexistent() {
        let repo = TestRepo::with_initial_commit();

        // Try to clean a file that doesn't exist
        let result = clean_files(repo.path_str(), vec!["nonexistent.txt".to_string()], None).await;

        // Should succeed but with 0 files removed
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 0);
    }

    #[tokio::test]
    async fn test_clean_all_untracked() {
        let repo = TestRepo::with_initial_commit();

        // Create untracked files
        repo.create_file("untracked1.txt", "content 1");
        repo.create_file("untracked2.txt", "content 2");

        let result = clean_all(repo.path_str(), None, None).await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 2);

        // Verify files are deleted
        assert!(!repo.path.join("untracked1.txt").exists());
        assert!(!repo.path.join("untracked2.txt").exists());

        // Tracked file should still exist
        assert!(repo.path.join("README.md").exists());
    }

    #[tokio::test]
    async fn test_clean_all_empty_repo() {
        let repo = TestRepo::with_initial_commit();

        // No untracked files
        let result = clean_all(repo.path_str(), None, None).await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 0);
    }

    #[tokio::test]
    async fn test_get_cleanable_files_file_size() {
        let repo = TestRepo::with_initial_commit();

        // Create a file with known content
        let content = "Hello, World!";
        repo.create_file("sized_file.txt", content);

        let result = get_cleanable_files(repo.path_str(), None, None).await;

        assert!(result.is_ok());
        let entries = result.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].size, Some(content.len() as u64));
    }

    #[tokio::test]
    async fn test_get_cleanable_files_excludes_directories_when_requested() {
        let repo = TestRepo::with_initial_commit();

        // Create an untracked directory and file
        repo.create_file("untracked_dir/file.txt", "content");
        repo.create_file("untracked_file.txt", "content");

        // Exclude directories
        let result = get_cleanable_files(repo.path_str(), None, Some(false)).await;

        assert!(result.is_ok());
        let entries = result.unwrap();
        // Should not contain any directories
        assert!(entries.iter().all(|e| !e.is_directory));
    }

    #[tokio::test]
    async fn test_clean_files_preserves_tracked() {
        let repo = TestRepo::with_initial_commit();

        // Try to clean a tracked file (should not delete it since it's not in workdir as untracked)
        // Actually clean_files will try to delete anything - but the tracked file is restored by git
        // For safety, we test that we don't accidentally delete tracked files
        let readme_content = std::fs::read_to_string(repo.path.join("README.md")).unwrap();

        // Create an untracked file and clean only that
        repo.create_file("untracked.txt", "content");
        let result = clean_files(repo.path_str(), vec!["untracked.txt".to_string()], None).await;

        assert!(result.is_ok());

        // README should still exist and be unchanged
        assert!(repo.path.join("README.md").exists());
        let after_content = std::fs::read_to_string(repo.path.join("README.md")).unwrap();
        assert_eq!(readme_content, after_content);
    }

    // Finding 52: with "include directories" off (== `git clean -f`, no `-d`),
    // files inside untracked directories must NOT be listed — only loose
    // untracked files. Turning directories off must protect everything under
    // untracked directories.
    #[tokio::test]
    async fn test_get_cleanable_files_directories_off_protects_dir_contents() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file("udir/keep.txt", "content");
        repo.create_file("loose.txt", "content");

        let result = get_cleanable_files(repo.path_str(), None, Some(false)).await;
        assert!(result.is_ok());
        let entries = result.unwrap();
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(
            paths.contains(&"loose.txt"),
            "loose untracked file should be listed, got {:?}",
            paths
        );
        assert!(
            !paths.iter().any(|p| p.starts_with("udir")),
            "git clean -f must not list files inside untracked directories, got {:?}",
            paths
        );
    }

    // Finding 56: `git clean -fd` removes an untracked directory entirely
    // ("Removing dir/"), leaving no empty husk. A full clean must remove the
    // directory itself, not just its files.
    #[tokio::test]
    async fn test_clean_removes_untracked_directory_entirely() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file("plaindir/inner.txt", "content");

        let entries = get_cleanable_files(repo.path_str(), None, Some(true))
            .await
            .unwrap();
        let paths: Vec<String> = entries.iter().map(|e| e.path.clone()).collect();

        let removed = clean_files(repo.path_str(), paths, None).await.unwrap();
        assert!(removed >= 1, "expected the directory to be removed");
        assert!(
            !repo.path.join("plaindir").exists(),
            "empty directory husk left behind; git clean -fd removes the directory itself"
        );
    }

    // Finding 51: an untracked nested git repository must be flagged, and must
    // NOT be deleted without an explicit double-force (git clean -fd refuses;
    // only -ff removes it). Deleting it destroys the embedded repo's history.
    #[tokio::test]
    async fn test_clean_refuses_nested_repo_without_force() {
        let repo = TestRepo::with_initial_commit();

        // Create an untracked nested git repository with local content.
        let nested = repo.path.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        git2::Repository::init(&nested).unwrap();
        std::fs::write(nested.join("work.txt"), "local wip").unwrap();

        let entries = get_cleanable_files(repo.path_str(), None, Some(true))
            .await
            .unwrap();
        let nested_entry = entries
            .iter()
            .find(|e| e.path.trim_end_matches('/') == "nested");
        assert!(
            nested_entry.is_some(),
            "nested repo should be listed, got {:?}",
            entries
        );
        assert!(
            nested_entry.unwrap().is_nested_repo,
            "nested repo must be flagged is_nested_repo"
        );

        let paths: Vec<String> = entries.iter().map(|e| e.path.clone()).collect();

        // Without force, the nested repo must survive (git clean -fd leaves it).
        clean_files(repo.path_str(), paths.clone(), Some(false))
            .await
            .unwrap();
        assert!(
            nested.join(".git").exists(),
            "nested repository destroyed without double-force; git clean -fd refuses this"
        );

        // With force (== git clean -ff) it is removed.
        clean_files(repo.path_str(), paths, Some(true))
            .await
            .unwrap();
        assert!(
            !nested.exists(),
            "nested repository should be removed once force_nested is set"
        );
    }

    // Finding 53: clean_files must not delete tracked/version-controlled files,
    // even when named explicitly (git clean -f tracked.txt exits 0 and keeps
    // the file). Simulates the TOCTOU where a listed path became tracked.
    #[tokio::test]
    async fn test_clean_files_skips_tracked_path() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("add tracked", &[("tracked.txt", "v1")]);

        // Stage further edits: the file is now tracked with staged changes.
        repo.create_file("tracked.txt", "v2 edits");
        repo.stage_file("tracked.txt");

        let removed = clean_files(repo.path_str(), vec!["tracked.txt".to_string()], None)
            .await
            .unwrap();
        assert_eq!(removed, 0, "clean must not delete a tracked file");
        assert!(
            repo.path.join("tracked.txt").exists(),
            "tracked file was deleted by clean"
        );
        let content = std::fs::read_to_string(repo.path.join("tracked.txt")).unwrap();
        assert_eq!(content, "v2 edits", "tracked file content was lost");
    }

    // Finding 53: clean_files must reject paths that escape the work tree
    // (git fatals with "is outside repository" and deletes nothing).
    #[tokio::test]
    async fn test_clean_files_rejects_path_outside_repo() {
        let repo = TestRepo::with_initial_commit();

        let outside = repo.path.parent().unwrap().join("outside_secret.txt");
        std::fs::write(&outside, "keep me").unwrap();

        let result = clean_files(
            repo.path_str(),
            vec!["../outside_secret.txt".to_string()],
            None,
        )
        .await;

        assert!(
            result.is_err(),
            "clean must reject a path that escapes the repository"
        );
        assert!(
            outside.exists(),
            "a file outside the repository was deleted"
        );
        std::fs::remove_file(&outside).ok();
    }
}
