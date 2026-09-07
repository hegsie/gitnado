//! Checkout file from a specific commit or branch
//! Allows users to restore a file to its state at a specific commit,
//! checkout from a branch, or view file contents at a specific commit.

use std::path::Path;
use tauri::command;

use super::path_utils::validate_path_within_repo;
use crate::error::{GitnadoError, Result};

/// Result of viewing a file at a specific commit
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAtCommitResult {
    pub file_path: String,
    pub commit_oid: String,
    pub content: String,
    pub is_binary: bool,
    pub size: u64,
}

/// Resolve a commit-ish string (OID, branch name, tag, HEAD~N, etc.) to a commit
fn resolve_commit<'repo>(
    repo: &'repo git2::Repository,
    commit_ish: &str,
) -> Result<git2::Commit<'repo>> {
    let obj = repo.revparse_single(commit_ish).map_err(|_| {
        GitnadoError::CommitNotFound(format!("Cannot resolve reference: {}", commit_ish))
    })?;
    obj.peel_to_commit().map_err(|_| {
        GitnadoError::CommitNotFound(format!("Reference is not a commit: {}", commit_ish))
    })
}

/// Git's filemode for a symlink tree entry.
const FILEMODE_LINK: i32 = 0o120000;
/// Git's filemode for an executable blob tree entry.
const FILEMODE_BLOB_EXECUTABLE: i32 = 0o100755;

/// Find a blob for a file path in a commit's tree, with the entry's filemode.
///
/// The mode is not decoration: a 0o100755 entry has to come back executable and
/// a 0o120000 entry is a SYMLINK whose blob content is the link target, not a
/// file to write. Only the tree entry knows which of the three this is, so the
/// mode has to travel with the blob rather than being dropped here.
fn find_blob_in_commit<'repo>(
    repo: &'repo git2::Repository,
    commit: &git2::Commit,
    file_path: &str,
) -> Result<(git2::Blob<'repo>, i32)> {
    let tree = commit
        .tree()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to get commit tree: {}", e)))?;

    // Normalize path separators to forward slashes for git
    let normalized_path = file_path.replace('\\', "/");

    let entry = tree.get_path(Path::new(&normalized_path)).map_err(|_| {
        GitnadoError::OperationFailed(format!(
            "File '{}' not found in commit {}",
            file_path,
            commit.id()
        ))
    })?;

    let filemode = entry.filemode();

    let object = entry
        .to_object(repo)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to get file object: {}", e)))?;

    let blob = object.into_blob().map_err(|_| {
        GitnadoError::OperationFailed(format!(
            "'{}' is not a file (might be a directory)",
            file_path
        ))
    })?;

    Ok((blob, filemode))
}

/// Materialise a blob in the working tree with the mode it had in the tree,
/// then stage it with that same mode.
///
/// Shared by both checkout entry points so the two cannot drift apart on how a
/// mode is honoured.
fn restore_blob_to_worktree(
    repo: &git2::Repository,
    repo_path: &str,
    file_path: &str,
    blob: &git2::Blob,
    filemode: i32,
) -> Result<()> {
    let content = blob.content();

    // Validate path stays within repository (prevents directory traversal)
    let abs_path = validate_path_within_repo(Path::new(repo_path), file_path)?;
    if let Some(parent) = abs_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to create parent directories: {}", e))
        })?;
    }

    // Whatever sits at the path now may itself be a symlink, and std::fs::write
    // FOLLOWS one — it would clobber the link's target instead of replacing the
    // link. Unlink first in that case, and always before recreating a link.
    let replacing_link =
        std::fs::symlink_metadata(&abs_path).is_ok_and(|meta| meta.file_type().is_symlink());
    if replacing_link || filemode == FILEMODE_LINK {
        match std::fs::remove_file(&abs_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(GitnadoError::OperationFailed(format!(
                    "Failed to replace existing file: {}",
                    e
                )))
            }
        }
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        if filemode == FILEMODE_LINK {
            // A symlink entry's blob content IS the link target.
            let target = String::from_utf8_lossy(content).to_string();
            std::os::unix::fs::symlink(&target, &abs_path).map_err(|e| {
                GitnadoError::OperationFailed(format!("Failed to create symlink: {}", e))
            })?;
        } else {
            std::fs::write(&abs_path, content).map_err(|e| {
                GitnadoError::OperationFailed(format!("Failed to write file: {}", e))
            })?;
            // Both directions: an executable version must come back executable,
            // and a non-executable one restored over an executable working copy
            // must drop the bit, exactly as git checkout does.
            let mut perms = std::fs::metadata(&abs_path)
                .map_err(|e| {
                    GitnadoError::OperationFailed(format!("Failed to read file mode: {}", e))
                })?
                .permissions();
            let mode = perms.mode();
            let wanted = if filemode == FILEMODE_BLOB_EXECUTABLE {
                mode | 0o111
            } else {
                mode & !0o111
            };
            if wanted != mode {
                perms.set_mode(wanted);
                std::fs::set_permissions(&abs_path, perms).map_err(|e| {
                    GitnadoError::OperationFailed(format!("Failed to set file mode: {}", e))
                })?;
            }
        }
    }
    #[cfg(not(unix))]
    {
        // Windows has no execute bit and no symlinks without a privilege; git
        // writes the link target as a plain file there, so do the same.
        std::fs::write(&abs_path, content)
            .map_err(|e| GitnadoError::OperationFailed(format!("Failed to write file: {}", e)))?;
    }

    // Stage the mode from the TREE rather than letting index.add_path stat the
    // working file: core.filemode is off on plenty of checkouts (and always on
    // Windows), so a stat there silently downgrades 100755/120000 to 100644.
    let mut index = repo
        .index()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to get index: {}", e)))?;
    let normalized_path = file_path.replace('\\', "/");
    let entry = git2::IndexEntry {
        ctime: git2::IndexTime::new(0, 0),
        mtime: git2::IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode: filemode as u32,
        uid: 0,
        gid: 0,
        file_size: content.len() as u32,
        id: blob.id(),
        flags: 0,
        flags_extended: 0,
        path: normalized_path.into_bytes(),
    };
    index
        .add(&entry)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to update index: {}", e)))?;
    index
        .write()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to write index: {}", e)))?;

    Ok(())
}

/// Check if content appears to be binary
fn is_binary_content(content: &[u8]) -> bool {
    // Check first 8000 bytes for null bytes (same heuristic as git)
    let check_len = content.len().min(8000);
    content[..check_len].contains(&0)
}

/// Checkout a file from a specific commit, restoring it in the working directory
///
/// This overwrites the file in the working directory with its contents from the specified commit.
#[command]
pub async fn checkout_file_from_commit(
    path: String,
    #[allow(non_snake_case)] filePath: String,
    commit: String,
) -> Result<FileAtCommitResult> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let resolved_commit = resolve_commit(&repo, &commit)?;
    let (blob, filemode) = find_blob_in_commit(&repo, &resolved_commit, &filePath)?;

    let content = blob.content();
    let is_binary = is_binary_content(content);
    let size = content.len() as u64;

    restore_blob_to_worktree(&repo, &path, &filePath, &blob, filemode)?;

    // File checkout (retrieving a file from a commit): git runs post-checkout
    // with flag=0 and HEAD unchanged as both old and new ref. Non-blocking.
    let head = crate::commands::hooks::head_oid_string(&repo);
    crate::commands::hooks::run_post_checkout(&repo, &head, &head, false);

    let content_str = if is_binary {
        String::new()
    } else {
        String::from_utf8_lossy(content).to_string()
    };

    Ok(FileAtCommitResult {
        file_path: filePath,
        commit_oid: resolved_commit.id().to_string(),
        content: content_str,
        is_binary,
        size,
    })
}

/// Checkout a file from a specific branch, restoring it in the working directory
///
/// This resolves the branch to its tip commit and checks out the file from that commit.
#[command]
pub async fn checkout_file_from_branch(
    path: String,
    #[allow(non_snake_case)] filePath: String,
    branch: String,
) -> Result<FileAtCommitResult> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Try to resolve as a local branch first, then as a remote branch
    let branch_ref = repo
        .find_branch(&branch, git2::BranchType::Local)
        .or_else(|_| repo.find_branch(&branch, git2::BranchType::Remote))
        .map_err(|_| GitnadoError::BranchNotFound(branch.clone()))?;

    let commit = branch_ref.get().peel_to_commit().map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to resolve branch to commit: {}", e))
    })?;

    let (blob, filemode) = find_blob_in_commit(&repo, &commit, &filePath)?;

    let content = blob.content();
    let is_binary = is_binary_content(content);
    let size = content.len() as u64;

    restore_blob_to_worktree(&repo, &path, &filePath, &blob, filemode)?;

    // File checkout (retrieving a file from a branch tip): git runs
    // post-checkout with flag=0 and HEAD unchanged. Non-blocking.
    let head = crate::commands::hooks::head_oid_string(&repo);
    crate::commands::hooks::run_post_checkout(&repo, &head, &head, false);

    let content_str = if is_binary {
        String::new()
    } else {
        String::from_utf8_lossy(content).to_string()
    };

    Ok(FileAtCommitResult {
        file_path: filePath,
        commit_oid: commit.id().to_string(),
        content: content_str,
        is_binary,
        size,
    })
}

/// View a file at a specific commit without modifying the working directory
///
/// Returns the file content at the specified commit for display purposes.
#[command]
pub async fn get_file_at_commit(
    path: String,
    #[allow(non_snake_case)] filePath: String,
    commit: String,
) -> Result<FileAtCommitResult> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let resolved_commit = resolve_commit(&repo, &commit)?;
    let (blob, _filemode) = find_blob_in_commit(&repo, &resolved_commit, &filePath)?;

    let content = blob.content();
    let is_binary = is_binary_content(content);
    let size = content.len() as u64;

    let content_str = if is_binary {
        String::new()
    } else {
        String::from_utf8_lossy(content).to_string()
    };

    Ok(FileAtCommitResult {
        file_path: filePath,
        commit_oid: resolved_commit.id().to_string(),
        content: content_str,
        is_binary,
        size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[tokio::test]
    async fn test_get_file_at_commit() {
        let repo = TestRepo::with_initial_commit();
        let oid = repo.head_oid();

        let result =
            get_file_at_commit(repo.path_str(), "README.md".to_string(), oid.to_string()).await;

        assert!(result.is_ok());
        let file_result = result.unwrap();
        assert_eq!(file_result.file_path, "README.md");
        assert_eq!(file_result.commit_oid, oid.to_string());
        assert_eq!(file_result.content, "# Test Repo");
        assert!(!file_result.is_binary);
        assert_eq!(file_result.size, 11); // "# Test Repo" is 11 bytes
    }

    #[tokio::test]
    async fn test_get_file_at_commit_with_ref() {
        let repo = TestRepo::with_initial_commit();

        // Use "HEAD" as a ref instead of an OID
        let result =
            get_file_at_commit(repo.path_str(), "README.md".to_string(), "HEAD".to_string()).await;

        assert!(result.is_ok());
        let file_result = result.unwrap();
        assert_eq!(file_result.content, "# Test Repo");
    }

    #[tokio::test]
    async fn test_get_file_at_commit_file_not_found() {
        let repo = TestRepo::with_initial_commit();
        let oid = repo.head_oid();

        let result = get_file_at_commit(
            repo.path_str(),
            "nonexistent.txt".to_string(),
            oid.to_string(),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_file_at_commit_invalid_commit() {
        let repo = TestRepo::with_initial_commit();

        let result = get_file_at_commit(
            repo.path_str(),
            "README.md".to_string(),
            "0000000000000000000000000000000000000000".to_string(),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_file_at_older_commit() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid();

        // Create a second commit that modifies the file
        repo.create_commit("Second commit", &[("README.md", "# Updated Repo")]);

        // Get file at the first commit - should have original content
        let result = get_file_at_commit(
            repo.path_str(),
            "README.md".to_string(),
            first_oid.to_string(),
        )
        .await;

        assert!(result.is_ok());
        let file_result = result.unwrap();
        assert_eq!(file_result.content, "# Test Repo");
        assert_eq!(file_result.commit_oid, first_oid.to_string());
    }

    #[tokio::test]
    async fn test_get_file_at_commit_subdirectory() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add nested file", &[("src/main.rs", "fn main() {}")]);
        let oid = repo.head_oid();

        let result =
            get_file_at_commit(repo.path_str(), "src/main.rs".to_string(), oid.to_string()).await;

        assert!(result.is_ok());
        let file_result = result.unwrap();
        assert_eq!(file_result.content, "fn main() {}");
    }

    #[tokio::test]
    async fn test_checkout_file_from_commit() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid();

        // Modify the file
        repo.create_commit("Update README", &[("README.md", "# Updated Repo")]);

        // Verify working directory has updated content
        let current_content = std::fs::read_to_string(repo.path.join("README.md")).unwrap();
        assert_eq!(current_content, "# Updated Repo");

        // Checkout file from the first commit
        let result = checkout_file_from_commit(
            repo.path_str(),
            "README.md".to_string(),
            first_oid.to_string(),
        )
        .await;

        assert!(result.is_ok());
        let file_result = result.unwrap();
        assert_eq!(file_result.content, "# Test Repo");
        assert_eq!(file_result.commit_oid, first_oid.to_string());

        // Verify working directory was updated
        let restored_content = std::fs::read_to_string(repo.path.join("README.md")).unwrap();
        assert_eq!(restored_content, "# Test Repo");
    }

    #[tokio::test]
    async fn test_checkout_file_from_commit_invalid_commit() {
        let repo = TestRepo::with_initial_commit();

        let result = checkout_file_from_commit(
            repo.path_str(),
            "README.md".to_string(),
            "invalid_ref".to_string(),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_checkout_file_from_commit_file_not_found() {
        let repo = TestRepo::with_initial_commit();
        let oid = repo.head_oid();

        let result = checkout_file_from_commit(
            repo.path_str(),
            "nonexistent.txt".to_string(),
            oid.to_string(),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_checkout_file_from_branch() {
        let repo = TestRepo::with_initial_commit();

        // Record the main branch name before switching
        let main = repo.current_branch();

        // Create a feature branch with different file content
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("README.md", "# Feature Branch")]);

        // Switch back to main
        repo.checkout_branch(&main);

        // Verify we're on main with original content
        let current_content = std::fs::read_to_string(repo.path.join("README.md")).unwrap();
        assert_eq!(current_content, "# Test Repo");

        // Checkout file from feature branch
        let result = checkout_file_from_branch(
            repo.path_str(),
            "README.md".to_string(),
            "feature".to_string(),
        )
        .await;

        assert!(result.is_ok());
        let file_result = result.unwrap();
        assert_eq!(file_result.content, "# Feature Branch");

        // Verify working directory was updated
        let restored_content = std::fs::read_to_string(repo.path.join("README.md")).unwrap();
        assert_eq!(restored_content, "# Feature Branch");
    }

    #[tokio::test]
    async fn test_checkout_file_from_branch_not_found() {
        let repo = TestRepo::with_initial_commit();

        let result = checkout_file_from_branch(
            repo.path_str(),
            "README.md".to_string(),
            "nonexistent-branch".to_string(),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_checkout_file_from_branch_file_not_found() {
        let repo = TestRepo::with_initial_commit();

        let result = checkout_file_from_branch(
            repo.path_str(),
            "nonexistent.txt".to_string(),
            repo.current_branch(),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_file_at_commit_binary_detection() {
        let repo = TestRepo::with_initial_commit();

        // Create a file with binary content (contains null bytes)
        let mut binary_content = vec![0u8; 100];
        binary_content[0] = 0x89; // PNG header byte
        binary_content[1] = 0x50;
        binary_content[10] = 0x00; // null byte
        std::fs::write(repo.path.join("image.png"), &binary_content).unwrap();
        repo.stage_file("image.png");

        let git_repo = repo.repo();
        let mut index = git_repo.index().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = git_repo.find_tree(tree_oid).unwrap();
        let sig = git_repo.signature().unwrap();
        let parent = git_repo.head().unwrap().peel_to_commit().unwrap();
        git_repo
            .commit(
                Some("HEAD"),
                &sig,
                &sig,
                "Add binary file",
                &tree,
                &[&parent],
            )
            .unwrap();

        let oid = repo.head_oid();
        let result =
            get_file_at_commit(repo.path_str(), "image.png".to_string(), oid.to_string()).await;

        assert!(result.is_ok());
        let file_result = result.unwrap();
        assert!(file_result.is_binary);
        assert!(file_result.content.is_empty()); // Binary content is not returned as text
        assert_eq!(file_result.size, 100);
    }

    #[tokio::test]
    async fn test_checkout_file_creates_parent_directories() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit(
            "Add nested file",
            &[("deep/nested/dir/file.txt", "nested content")],
        );
        let oid = repo.head_oid();

        // Remove the directory
        let _ = std::fs::remove_dir_all(repo.path.join("deep"));

        // Checkout should recreate the directories
        let result = checkout_file_from_commit(
            repo.path_str(),
            "deep/nested/dir/file.txt".to_string(),
            oid.to_string(),
        )
        .await;

        assert!(result.is_ok());
        let restored = std::fs::read_to_string(repo.path.join("deep/nested/dir/file.txt")).unwrap();
        assert_eq!(restored, "nested content");
    }

    #[tokio::test]
    async fn test_get_file_at_commit_with_tag() {
        let repo = TestRepo::with_initial_commit();
        repo.create_tag("v1.0.0");

        // Modify the file
        repo.create_commit("Update README", &[("README.md", "# Updated Repo")]);

        // Use tag to get old content
        let result = get_file_at_commit(
            repo.path_str(),
            "README.md".to_string(),
            "v1.0.0".to_string(),
        )
        .await;

        assert!(result.is_ok());
        let file_result = result.unwrap();
        assert_eq!(file_result.content, "# Test Repo");
    }

    #[tokio::test]
    async fn test_checkout_file_from_commit_updates_index() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid();

        // Create a second commit
        repo.create_commit("Update README", &[("README.md", "# Updated Repo")]);

        // Checkout file from first commit
        let result = checkout_file_from_commit(
            repo.path_str(),
            "README.md".to_string(),
            first_oid.to_string(),
        )
        .await;
        assert!(result.is_ok());

        // Verify the index was updated (file should be staged)
        let git_repo = repo.repo();
        let index = git_repo.index().unwrap();
        let entry = index.get_path(Path::new("README.md"), 0);
        assert!(entry.is_some());
    }

    // ---- filemode parity: exec bit and symlinks survive a restore ----

    /// Commit a single top-level entry with an EXPLICIT tree filemode.
    ///
    /// index.add_path would stat the working file, which is exactly the
    /// mechanism under test — the tree has to be built directly so the mode in
    /// the commit is the one the test asked for.
    #[cfg(unix)]
    fn commit_entry_with_mode(repo: &TestRepo, name: &str, content: &str, mode: i32) -> git2::Oid {
        let git_repo = repo.repo();
        let blob = git_repo.blob(content.as_bytes()).unwrap();
        let parent = git_repo.head().unwrap().peel_to_commit().unwrap();
        let mut builder = git_repo.treebuilder(Some(&parent.tree().unwrap())).unwrap();
        builder.insert(name, blob, mode).unwrap();
        let tree = git_repo.find_tree(builder.write().unwrap()).unwrap();
        let sig = git_repo.signature().unwrap();
        git_repo
            .commit(
                Some("HEAD"),
                &sig,
                &sig,
                &format!("Set {} to {:o}", name, mode),
                &tree,
                &[&parent],
            )
            .unwrap()
    }

    #[cfg(unix)]
    fn worktree_mode(repo: &TestRepo, name: &str) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(repo.path.join(name))
            .unwrap()
            .permissions()
            .mode()
    }

    #[cfg(unix)]
    fn index_mode(repo: &TestRepo, name: &str) -> u32 {
        repo.repo()
            .index()
            .unwrap()
            .get_path(Path::new(name), 0)
            .unwrap_or_else(|| panic!("{} must be staged", name))
            .mode
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_checkout_file_from_commit_restores_executable_bit() {
        use std::os::unix::fs::PermissionsExt;
        let repo = TestRepo::with_initial_commit();

        let exec_oid = commit_entry_with_mode(&repo, "run.sh", "#!/bin/sh\necho hi\n", 0o100755);
        // A later commit drops it back to a plain, non-executable blob.
        commit_entry_with_mode(&repo, "run.sh", "#!/bin/sh\necho bye\n", 0o100644);
        std::fs::write(repo.path.join("run.sh"), "#!/bin/sh\necho bye\n").unwrap();
        let mut perms = std::fs::metadata(repo.path.join("run.sh"))
            .unwrap()
            .permissions();
        perms.set_mode(0o644);
        std::fs::set_permissions(repo.path.join("run.sh"), perms).unwrap();

        checkout_file_from_commit(repo.path_str(), "run.sh".to_string(), exec_oid.to_string())
            .await
            .unwrap();

        let mode = worktree_mode(&repo, "run.sh");
        assert!(
            mode & 0o111 != 0,
            "restored executable must be executable, got {:o}",
            mode
        );
        assert_eq!(
            index_mode(&repo, "run.sh"),
            0o100755,
            "the staged mode must be the executable one from the tree"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_checkout_file_from_commit_drops_a_stale_executable_bit() {
        use std::os::unix::fs::PermissionsExt;
        let repo = TestRepo::with_initial_commit();

        commit_entry_with_mode(&repo, "run.sh", "#!/bin/sh\necho hi\n", 0o100755);
        let plain_oid = commit_entry_with_mode(&repo, "run.sh", "#!/bin/sh\necho hi\n", 0o100644);

        std::fs::write(repo.path.join("run.sh"), "#!/bin/sh\necho hi\n").unwrap();
        let mut perms = std::fs::metadata(repo.path.join("run.sh"))
            .unwrap()
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(repo.path.join("run.sh"), perms).unwrap();

        checkout_file_from_commit(repo.path_str(), "run.sh".to_string(), plain_oid.to_string())
            .await
            .unwrap();

        let mode = worktree_mode(&repo, "run.sh");
        assert!(
            mode & 0o111 == 0,
            "restoring a non-executable version must drop the execute bit, got {:o}",
            mode
        );
        assert_eq!(index_mode(&repo, "run.sh"), 0o100644);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_checkout_file_from_commit_restores_a_symlink_as_a_symlink() {
        let repo = TestRepo::with_initial_commit();

        let link_oid = commit_entry_with_mode(&repo, "link", "README.md", 0o120000);

        checkout_file_from_commit(repo.path_str(), "link".to_string(), link_oid.to_string())
            .await
            .unwrap();

        let meta = std::fs::symlink_metadata(repo.path.join("link")).unwrap();
        assert!(
            meta.file_type().is_symlink(),
            "a 120000 entry must come back as a symlink, not a file holding its target"
        );
        assert_eq!(
            std::fs::read_link(repo.path.join("link")).unwrap(),
            Path::new("README.md")
        );
        assert_eq!(index_mode(&repo, "link"), 0o120000);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_checkout_file_from_commit_replaces_a_symlink_instead_of_writing_through_it() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid();

        repo.create_commit("Add target", &[("target.txt", "target contents")]);
        // The working copy of README.md is now a symlink into the repo. Writing
        // to it without unlinking first would clobber target.txt.
        std::fs::remove_file(repo.path.join("README.md")).unwrap();
        std::os::unix::fs::symlink("target.txt", repo.path.join("README.md")).unwrap();

        checkout_file_from_commit(
            repo.path_str(),
            "README.md".to_string(),
            first_oid.to_string(),
        )
        .await
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(repo.path.join("target.txt")).unwrap(),
            "target contents",
            "restore must replace the symlink, not write through it"
        );
        assert!(!std::fs::symlink_metadata(repo.path.join("README.md"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_to_string(repo.path.join("README.md")).unwrap(),
            "# Test Repo"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_checkout_file_from_branch_restores_executable_bit() {
        let repo = TestRepo::with_initial_commit();
        let main = repo.current_branch();

        repo.create_branch("feature");
        repo.checkout_branch("feature");
        commit_entry_with_mode(&repo, "run.sh", "#!/bin/sh\necho hi\n", 0o100755);
        repo.checkout_branch(&main);

        checkout_file_from_branch(repo.path_str(), "run.sh".to_string(), "feature".to_string())
            .await
            .unwrap();

        let mode = worktree_mode(&repo, "run.sh");
        assert!(
            mode & 0o111 != 0,
            "restored executable must be executable, got {:o}",
            mode
        );
        assert_eq!(index_mode(&repo, "run.sh"), 0o100755);
    }

    // ---- post-checkout (flag=0) hook parity for file checkouts ----

    #[cfg(unix)]
    #[tokio::test]
    async fn test_checkout_file_from_commit_runs_post_checkout_flag0() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid();
        repo.create_commit("Update README", &[("README.md", "# Updated Repo")]);
        let head = repo.head_oid();

        let marker = repo.path.join("pc.log");
        repo.install_hook(
            "post-checkout",
            &format!("#!/bin/sh\necho \"$1 $2 $3\" > \"{}\"\n", marker.display()),
        );

        checkout_file_from_commit(
            repo.path_str(),
            "README.md".to_string(),
            first_oid.to_string(),
        )
        .await
        .unwrap();

        let logged = std::fs::read_to_string(&marker).expect("post-checkout must run");
        // File checkout: HEAD unchanged on both sides, flag 0.
        assert_eq!(logged.trim(), format!("{} {} 0", head, head));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_checkout_file_from_branch_runs_post_checkout_flag0() {
        let repo = TestRepo::with_initial_commit();
        let main = repo.current_branch();
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("README.md", "# Feature")]);
        repo.checkout_branch(&main);
        let head = repo.head_oid();

        let marker = repo.path.join("pc.log");
        repo.install_hook(
            "post-checkout",
            &format!("#!/bin/sh\necho \"$3\" > \"{}\"\n", marker.display()),
        );

        checkout_file_from_branch(
            repo.path_str(),
            "README.md".to_string(),
            "feature".to_string(),
        )
        .await
        .unwrap();

        let logged = std::fs::read_to_string(&marker).expect("post-checkout must run");
        assert_eq!(logged.trim(), "0", "file checkout flag must be 0");
        let _ = head;
    }
}
