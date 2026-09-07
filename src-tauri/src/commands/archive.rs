//! Archive command handlers
//! Export repository snapshots as zip/tar archives

use std::path::Path;
use std::process::Command;
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::utils::reject_flag_like;

/// Map a user-supplied format string to the value understood by
/// `git archive --format=<fmt>`. Returns an error for unsupported formats.
fn resolve_format(format: Option<&str>) -> Result<&'static str> {
    match format.unwrap_or("zip") {
        "zip" => Ok("zip"),
        "tar" => Ok("tar"),
        "tar.gz" | "tgz" => Ok("tar.gz"),
        other => Err(GitnadoError::OperationFailed(format!(
            "Unsupported archive format: {}",
            other
        ))),
    }
}

/// Create an archive of the repository at a given commit/ref.
///
/// This delegates to `git archive`, which correctly preserves executable
/// file modes, emits committed symlinks as symlink entries, and honours the
/// `export-ignore` / `export-subst` gitattributes — behaviour a hand-rolled
/// tree walk does not reproduce.
#[command]
pub async fn create_archive(
    path: String,
    output_path: String,
    tree_ref: Option<String>,
    format: Option<String>,
    prefix: Option<String>,
) -> Result<String> {
    let repo_path = Path::new(&path);
    let repo = git2::Repository::open(repo_path)?;

    // Resolve the reference to a tree so we can surface a clear error for an
    // invalid ref before shelling out to git.
    let ref_str = tree_ref.as_deref().unwrap_or("HEAD");
    let obj = repo.revparse_single(ref_str)?;
    obj.peel_to_tree().map_err(|_| {
        GitnadoError::OperationFailed(format!("Cannot resolve '{}' to a tree", ref_str))
    })?;

    let format_arg = resolve_format(format.as_deref())?;

    // Defend every user-controlled value that reaches the CLI.
    reject_flag_like(&output_path, "Output path")?;
    reject_flag_like(ref_str, "Reference")?;
    let prefix_str = prefix.unwrap_or_default();
    if !prefix_str.is_empty() {
        reject_flag_like(&prefix_str, "Prefix")?;
    }

    let mut cmd = Command::new("git");
    cmd.current_dir(repo_path)
        .arg("archive")
        .arg(format!("--format={}", format_arg))
        .arg(format!("--output={}", output_path));
    if !prefix_str.is_empty() {
        // git archive requires a trailing slash to nest entries under a
        // directory, matching the previous "<prefix>/<file>" layout.
        cmd.arg(format!("--prefix={}/", prefix_str));
    }
    // `--` terminates options so a ref cannot be reinterpreted as a flag.
    cmd.arg("--").arg(ref_str);

    let output = cmd.output().map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to execute git archive: {}", e))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "git archive failed: {}",
            stderr.trim()
        )));
    }

    Ok(output_path)
}

/// Get the list of files that would be included in the archive.
///
/// The list is produced by asking `git archive` for a tar stream and reading
/// the entry names, so it reflects the exact set of files the archive will
/// contain — including the effect of `export-ignore` gitattributes.
#[command]
pub async fn get_archive_files(path: String, tree_ref: Option<String>) -> Result<Vec<String>> {
    let repo_path = Path::new(&path);
    let repo = git2::Repository::open(repo_path)?;

    let ref_str = tree_ref.as_deref().unwrap_or("HEAD");
    let obj = repo.revparse_single(ref_str)?;
    obj.peel_to_tree().map_err(|_| {
        GitnadoError::OperationFailed(format!("Cannot resolve '{}' to a tree", ref_str))
    })?;

    reject_flag_like(ref_str, "Reference")?;

    let output = Command::new("git")
        .current_dir(repo_path)
        .arg("archive")
        .arg("--format=tar")
        .arg("--")
        .arg(ref_str)
        .output()
        .map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to execute git archive: {}", e))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "git archive failed: {}",
            stderr.trim()
        )));
    }

    let mut files = Vec::new();
    let mut archive = tar::Archive::new(output.stdout.as_slice());
    for entry in archive
        .entries()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to read archive: {}", e)))?
    {
        let entry = entry.map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to read archive entry: {}", e))
        })?;
        // Skip directory entries; report only files and symlinks.
        if entry.header().entry_type().is_dir() {
            continue;
        }
        let entry_path = entry
            .path()
            .map_err(|e| GitnadoError::OperationFailed(format!("Invalid archive path: {}", e)))?;
        files.push(entry_path.to_string_lossy().to_string());
    }

    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;
    use std::io::Read;

    /// Read all entries from a tar archive file into (path, header) pairs.
    fn read_tar_entries(path: &Path) -> Vec<(String, tar::Header, Option<String>)> {
        let file = std::fs::File::open(path).expect("open tar");
        let mut archive = tar::Archive::new(file);
        let mut out = Vec::new();
        for entry in archive.entries().expect("entries") {
            let mut entry = entry.expect("entry");
            let p = entry.path().expect("path").to_string_lossy().to_string();
            let header = entry.header().clone();
            let link = entry
                .link_name()
                .ok()
                .flatten()
                .map(|l| l.to_string_lossy().to_string());
            // Drain the entry body so the reader advances.
            let mut buf = Vec::new();
            let _ = entry.read_to_end(&mut buf);
            out.push((p, header, link));
        }
        out
    }

    #[tokio::test]
    async fn test_create_zip_archive() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit(
            "Add files",
            &[
                ("src/main.rs", "fn main() {}"),
                ("Cargo.toml", "[package]\nname = \"test\""),
            ],
        );

        let output = repo.path.join("archive.zip");
        let result = create_archive(
            repo.path_str(),
            output.to_string_lossy().to_string(),
            None,
            Some("zip".to_string()),
            None,
        )
        .await;

        assert!(result.is_ok());
        assert!(output.exists());
        assert!(std::fs::metadata(&output).unwrap().len() > 0);
    }

    #[tokio::test]
    async fn test_create_tar_archive() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add files", &[("file.txt", "content")]);

        let output = repo.path.join("archive.tar");
        let result = create_archive(
            repo.path_str(),
            output.to_string_lossy().to_string(),
            None,
            Some("tar".to_string()),
            None,
        )
        .await;

        assert!(result.is_ok());
        assert!(output.exists());
    }

    #[tokio::test]
    async fn test_create_tar_gz_archive() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add files", &[("file.txt", "content")]);

        let output = repo.path.join("archive.tar.gz");
        let result = create_archive(
            repo.path_str(),
            output.to_string_lossy().to_string(),
            None,
            Some("tar.gz".to_string()),
            None,
        )
        .await;

        assert!(result.is_ok());
        assert!(output.exists());
    }

    #[tokio::test]
    async fn test_create_archive_with_prefix() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add file", &[("file.txt", "content")]);

        let output = repo.path.join("prefixed.tar");
        let result = create_archive(
            repo.path_str(),
            output.to_string_lossy().to_string(),
            None,
            Some("tar".to_string()),
            Some("myproject-v1.0".to_string()),
        )
        .await;

        assert!(result.is_ok());
        assert!(output.exists());
        let entries = read_tar_entries(&output);
        assert!(
            entries
                .iter()
                .any(|(p, _, _)| p == "myproject-v1.0/file.txt"),
            "entries: {:?}",
            entries.iter().map(|(p, _, _)| p).collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn test_create_archive_at_specific_ref() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid();
        repo.create_commit("Second commit", &[("new.txt", "new content")]);

        let output = repo.path.join("at-ref.zip");
        let result = create_archive(
            repo.path_str(),
            output.to_string_lossy().to_string(),
            Some(first_oid.to_string()),
            Some("zip".to_string()),
            None,
        )
        .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_get_archive_files() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit(
            "Add files",
            &[("src/main.rs", "fn main() {}"), ("README.md", "# Hello")],
        );

        let result = get_archive_files(repo.path_str(), None).await;
        assert!(result.is_ok());
        let files = result.unwrap();
        // After with_initial_commit (README.md) + second commit (src/main.rs, README.md),
        // the tree contains README.md and src/main.rs = 2 files
        assert!(files.iter().any(|f| f == "README.md"));
        assert!(files.iter().any(|f| f == "src/main.rs"));
    }

    #[tokio::test]
    async fn test_create_archive_invalid_format() {
        let repo = TestRepo::with_initial_commit();
        let output = repo.path.join("bad.format");

        let result = create_archive(
            repo.path_str(),
            output.to_string_lossy().to_string(),
            None,
            Some("invalid".to_string()),
            None,
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_create_archive_invalid_ref() {
        let repo = TestRepo::with_initial_commit();
        let output = repo.path.join("bad-ref.zip");

        let result = create_archive(
            repo.path_str(),
            output.to_string_lossy().to_string(),
            Some("nonexistent-ref".to_string()),
            Some("zip".to_string()),
            None,
        )
        .await;

        assert!(result.is_err());
    }

    // Finding 74: git archive preserves executable file mode (100755).
    #[cfg(unix)]
    #[tokio::test]
    async fn test_archive_preserves_executable_mode() {
        use std::os::unix::fs::PermissionsExt;

        let repo = TestRepo::with_initial_commit();
        // Write an executable script and stage it so the index records 100755.
        repo.create_file("run.sh", "#!/bin/sh\necho hi\n");
        let script = repo.path.join("run.sh");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .expect("chmod run.sh");
        repo.stage_file("run.sh");
        // Commit the staged executable.
        {
            let git_repo = repo.repo();
            let mut index = git_repo.index().unwrap();
            let tree_oid = index.write_tree().unwrap();
            let tree = git_repo.find_tree(tree_oid).unwrap();
            let sig = git_repo.signature().unwrap();
            let parent = git_repo.head().unwrap().peel_to_commit().unwrap();
            git_repo
                .commit(Some("HEAD"), &sig, &sig, "add script", &tree, &[&parent])
                .unwrap();
        }

        let output = repo.path.join("exec.tar");
        create_archive(
            repo.path_str(),
            output.to_string_lossy().to_string(),
            None,
            Some("tar".to_string()),
            None,
        )
        .await
        .expect("archive");

        let entries = read_tar_entries(&output);
        let (_, header, _) = entries
            .iter()
            .find(|(p, _, _)| p == "run.sh")
            .expect("run.sh in archive");
        let mode = header.mode().expect("mode");
        assert!(
            mode & 0o111 != 0,
            "run.sh should be executable, got mode {:o}",
            mode
        );
    }

    // Finding 75: committed symlinks are emitted as symlink entries.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_archive_preserves_symlink() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file("plain.txt", "hello");
        repo.stage_file("plain.txt");
        std::os::unix::fs::symlink("plain.txt", repo.path.join("link.txt")).expect("symlink");
        repo.stage_file("link.txt");
        {
            let git_repo = repo.repo();
            let mut index = git_repo.index().unwrap();
            let tree_oid = index.write_tree().unwrap();
            let tree = git_repo.find_tree(tree_oid).unwrap();
            let sig = git_repo.signature().unwrap();
            let parent = git_repo.head().unwrap().peel_to_commit().unwrap();
            git_repo
                .commit(Some("HEAD"), &sig, &sig, "add symlink", &tree, &[&parent])
                .unwrap();
        }

        let output = repo.path.join("symlink.tar");
        create_archive(
            repo.path_str(),
            output.to_string_lossy().to_string(),
            None,
            Some("tar".to_string()),
            None,
        )
        .await
        .expect("archive");

        let entries = read_tar_entries(&output);
        let (_, header, link) = entries
            .iter()
            .find(|(p, _, _)| p == "link.txt")
            .expect("link.txt in archive");
        assert_eq!(
            header.entry_type(),
            tar::EntryType::Symlink,
            "link.txt should be a symlink entry"
        );
        assert_eq!(link.as_deref(), Some("plain.txt"));
    }

    // Finding 76: export-ignore files are excluded from the archive and the
    // preview file list.
    #[tokio::test]
    async fn test_archive_honors_export_ignore() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit(
            "Add files with export-ignore",
            &[
                (".gitattributes", "private.txt export-ignore\n"),
                ("private.txt", "secret"),
                ("public.txt", "public"),
            ],
        );

        // Creation excludes the export-ignored file.
        let output = repo.path.join("ignore.tar");
        create_archive(
            repo.path_str(),
            output.to_string_lossy().to_string(),
            None,
            Some("tar".to_string()),
            None,
        )
        .await
        .expect("archive");
        let entries = read_tar_entries(&output);
        let names: Vec<&String> = entries.iter().map(|(p, _, _)| p).collect();
        assert!(
            !names.iter().any(|p| p.as_str() == "private.txt"),
            "private.txt must be excluded, got {:?}",
            names
        );
        assert!(names.iter().any(|p| p.as_str() == "public.txt"));

        // The preview list reflects the same exclusion.
        let files = get_archive_files(repo.path_str(), None).await.unwrap();
        assert!(
            !files.iter().any(|f| f == "private.txt"),
            "preview must exclude private.txt, got {:?}",
            files
        );
        assert!(files.iter().any(|f| f == "public.txt"));
    }
}
