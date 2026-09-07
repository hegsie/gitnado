//! Patch command handlers
//! Create and apply patch files

use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};

/// Create a patch from commits
#[command]
pub async fn create_patch(
    path: String,
    commit_oids: Vec<String>,
    output_path: String,
) -> Result<Vec<String>> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let mut patch_files = Vec::new();

    for (i, oid_str) in commit_oids.iter().enumerate() {
        let oid = git2::Oid::from_str(oid_str)
            .map_err(|_| GitnadoError::CommitNotFound(oid_str.clone()))?;
        let commit = repo.find_commit(oid)?;

        // Get the diff for this commit
        let parent = if commit.parent_count() > 0 {
            Some(commit.parent(0)?.tree()?)
        } else {
            None
        };

        // Enable binary patch output and full (40-char) blob ids so that
        // patches touching binary files contain a real "GIT binary patch"
        // section that `git am`/`git apply` can apply, rather than an
        // unapplyable "Binary files ... differ" placeholder.
        let mut diff_opts = git2::DiffOptions::new();
        diff_opts.show_binary(true);
        diff_opts.id_abbrev(40);
        let mut diff =
            repo.diff_tree_to_tree(parent.as_ref(), Some(&commit.tree()?), Some(&mut diff_opts))?;

        // Detect renames/copies so a moved file is emitted as a compact
        // "rename from/to" instead of a full delete + add (git's default).
        let mut find_opts = git2::DiffFindOptions::new();
        find_opts.renames(true);
        diff.find_similar(Some(&mut find_opts))?;

        // Format patch
        let mut patch_content = String::new();

        // Email header format
        let sig = commit.author();
        let time = commit.time();
        let message = commit.message().unwrap_or("");

        // RFC 2822 date format
        let epoch = time.seconds();
        let offset = time.offset_minutes();
        let offset_hours = offset / 60;
        let offset_mins = (offset % 60).abs();
        let sign = if offset >= 0 { "+" } else { "-" };

        patch_content.push_str(&format!("From {} Mon Sep 17 00:00:00 2001\n", oid_str));
        patch_content.push_str(&format!(
            "From: {} <{}>\n",
            sig.name().unwrap_or("Unknown"),
            sig.email().unwrap_or("unknown@unknown.com")
        ));
        patch_content.push_str(&format!(
            "Date: {}{}{:02}{:02}\n",
            epoch,
            sign,
            offset_hours.abs(),
            offset_mins
        ));

        // Subject from first line of message
        let first_line = message.lines().next().unwrap_or("");
        patch_content.push_str(&format!(
            "Subject: [PATCH {}/{}] {}\n\n",
            i + 1,
            commit_oids.len(),
            first_line
        ));

        // Remaining message lines
        let remaining: Vec<&str> = message.lines().skip(1).collect();
        if !remaining.is_empty() {
            for line in &remaining {
                patch_content.push_str(line);
                patch_content.push('\n');
            }
            patch_content.push('\n');
        }

        patch_content.push_str("---\n");

        // Diff stats
        let stats = diff.stats()?;
        let stats_buf = stats.to_buf(git2::DiffStatsFormat::FULL, 80)?;
        patch_content.push_str(stats_buf.as_str().unwrap_or(""));
        patch_content.push('\n');

        // Actual diff. Accumulate as raw bytes so that non-UTF8 content
        // (Latin-1, Shift-JIS, binary literal data, ...) is written verbatim
        // instead of being silently dropped, which would corrupt the patch.
        let mut patch_bytes = patch_content.into_bytes();
        diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
            let origin = line.origin();
            if origin == '+' || origin == '-' || origin == ' ' {
                patch_bytes.push(origin as u8);
            }
            patch_bytes.extend_from_slice(line.content());
            true
        })?;

        patch_bytes.extend_from_slice(b"\n-- \n");

        // Write patch file
        let short_id = &oid_str[..8.min(oid_str.len())];
        let sanitized_subject = first_line
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '-'
                }
            })
            .collect::<String>();
        let filename = format!("{:04}-{}-{}.patch", i + 1, short_id, sanitized_subject);
        let patch_path = Path::new(&output_path).join(&filename);

        if let Some(parent_dir) = patch_path.parent() {
            std::fs::create_dir_all(parent_dir)?;
        }
        std::fs::write(&patch_path, &patch_bytes)?;
        patch_files.push(patch_path.to_string_lossy().to_string());
    }

    Ok(patch_files)
}

/// Apply a patch file to the working directory
#[command]
pub async fn apply_patch(path: String, patch_path: String, check_only: Option<bool>) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let patch_content = std::fs::read(&patch_path)?;

    let diff = git2::Diff::from_buffer(&patch_content)?;

    if check_only.unwrap_or(false) {
        // Dry run - just check if patch applies cleanly. Without
        // ApplyOptions::check(true) libgit2 performs a REAL apply and writes
        // the changes to the working tree (git apply --check must not modify
        // anything).
        let mut apply_opts = git2::ApplyOptions::new();
        apply_opts.check(true);
        repo.apply(&diff, git2::ApplyLocation::WorkDir, Some(&mut apply_opts))
            .map_err(|e| {
                GitnadoError::OperationFailed(format!("Patch would not apply cleanly: {}", e))
            })?;
    } else {
        repo.apply(&diff, git2::ApplyLocation::WorkDir, None)?;
    }

    Ok(())
}

/// Apply a patch to the index (staging area)
#[command]
pub async fn apply_patch_to_index(path: String, patch_path: String) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let patch_content = std::fs::read(&patch_path)?;

    let diff = git2::Diff::from_buffer(&patch_content)?;
    repo.apply(&diff, git2::ApplyLocation::Index, None)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[tokio::test]
    async fn test_create_patch_single_commit() {
        let test_repo = TestRepo::with_initial_commit();
        let oid = test_repo.create_commit("Add feature", &[("feature.txt", "feature content")]);

        let output_dir = test_repo.path.join("patches");
        std::fs::create_dir_all(&output_dir).unwrap();

        let result = create_patch(
            test_repo.path_str(),
            vec![oid.to_string()],
            output_dir.to_string_lossy().to_string(),
        )
        .await;

        assert!(result.is_ok());
        let files = result.unwrap();
        assert_eq!(files.len(), 1);
        assert!(Path::new(&files[0]).exists());
    }

    #[tokio::test]
    async fn test_create_patch_multiple_commits() {
        let test_repo = TestRepo::with_initial_commit();
        let oid1 = test_repo.create_commit("First change", &[("file1.txt", "content1")]);
        let oid2 = test_repo.create_commit("Second change", &[("file2.txt", "content2")]);

        let output_dir = test_repo.path.join("patches");
        std::fs::create_dir_all(&output_dir).unwrap();

        let result = create_patch(
            test_repo.path_str(),
            vec![oid1.to_string(), oid2.to_string()],
            output_dir.to_string_lossy().to_string(),
        )
        .await;

        assert!(result.is_ok());
        let files = result.unwrap();
        assert_eq!(files.len(), 2);
    }

    #[tokio::test]
    async fn test_create_and_apply_patch() {
        // Create a repo with a commit
        let source_repo = TestRepo::with_initial_commit();
        let oid = source_repo.create_commit("Add file", &[("new.txt", "hello world")]);

        let output_dir = source_repo.path.join("patches");
        std::fs::create_dir_all(&output_dir).unwrap();

        let files = create_patch(
            source_repo.path_str(),
            vec![oid.to_string()],
            output_dir.to_string_lossy().to_string(),
        )
        .await
        .unwrap();

        // Apply to a different repo
        let target_repo = TestRepo::with_initial_commit();
        let result = apply_patch(target_repo.path_str(), files[0].clone(), None).await;

        assert!(result.is_ok());

        // Verify the file exists in the target
        let target_file = target_repo.path.join("new.txt");
        assert!(target_file.exists());
    }

    #[tokio::test]
    async fn test_apply_patch_check_only() {
        let source_repo = TestRepo::with_initial_commit();
        let oid = source_repo.create_commit("Add file", &[("check.txt", "check content")]);

        let output_dir = source_repo.path.join("patches");
        std::fs::create_dir_all(&output_dir).unwrap();

        let files = create_patch(
            source_repo.path_str(),
            vec![oid.to_string()],
            output_dir.to_string_lossy().to_string(),
        )
        .await
        .unwrap();

        let target_repo = TestRepo::with_initial_commit();
        let result = apply_patch(
            target_repo.path_str(),
            files[0].clone(),
            Some(true), // Check only
        )
        .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_create_patch_invalid_commit() {
        let test_repo = TestRepo::with_initial_commit();
        let output_dir = test_repo.path.join("patches");
        std::fs::create_dir_all(&output_dir).unwrap();

        let result = create_patch(
            test_repo.path_str(),
            vec!["0000000000000000000000000000000000000000".to_string()],
            output_dir.to_string_lossy().to_string(),
        )
        .await;

        assert!(result.is_err());
    }

    /// Finding 58: `check_only` must NOT modify the working tree (git apply --check).
    #[tokio::test]
    async fn test_apply_patch_check_only_does_not_modify_worktree() {
        let source = TestRepo::with_initial_commit();
        source.create_commit("base", &[("f.txt", "base\n")]);
        let oid = source.create_commit("change", &[("f.txt", "base\nadded line\n")]);

        let output_dir = source.path.join("patches");
        std::fs::create_dir_all(&output_dir).unwrap();
        let files = create_patch(
            source.path_str(),
            vec![oid.to_string()],
            output_dir.to_string_lossy().to_string(),
        )
        .await
        .unwrap();

        // Target repo whose working tree matches the patch's base ("base\n").
        let target = TestRepo::with_initial_commit();
        target.create_commit("base", &[("f.txt", "base\n")]);
        let target_file = target.path.join("f.txt");
        let before = std::fs::read_to_string(&target_file).unwrap();

        let result = apply_patch(target.path_str(), files[0].clone(), Some(true)).await;
        assert!(result.is_ok(), "check-only should report the patch applies");

        let after = std::fs::read_to_string(&target_file).unwrap();
        assert_eq!(
            before, after,
            "check_only=true must leave the working tree byte-identical"
        );
        assert_eq!(after, "base\n");
    }

    /// Finding 64: a patch touching a binary file must contain a real
    /// "GIT binary patch" section, not an unapplyable placeholder.
    #[tokio::test]
    async fn test_create_patch_binary_file_produces_git_binary_patch() {
        let source = TestRepo::with_initial_commit();

        // Commit a binary blob (contains NUL / high bytes -> git treats as binary).
        let binary: Vec<u8> = (0u16..256).map(|b| (b % 256) as u8).collect();
        let bin_path = source.path.join("blob.bin");
        std::fs::write(&bin_path, &binary).unwrap();
        let repo = source.repo();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("blob.bin")).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = repo.signature().unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        let oid = repo
            .commit(Some("HEAD"), &sig, &sig, "add binary", &tree, &[&parent])
            .unwrap();

        let output_dir = source.path.join("patches");
        std::fs::create_dir_all(&output_dir).unwrap();
        let files = create_patch(
            source.path_str(),
            vec![oid.to_string()],
            output_dir.to_string_lossy().to_string(),
        )
        .await
        .unwrap();

        let contents = std::fs::read_to_string(&files[0]).unwrap();
        assert!(
            contents.contains("GIT binary patch"),
            "binary patch section missing; got:\n{}",
            contents
        );
        assert!(
            !contents.contains("Binary files"),
            "should not emit the unapplyable 'Binary files differ' placeholder"
        );

        // The exported patch must be applyable to a fresh repo.
        let target = TestRepo::with_initial_commit();
        let apply_result = apply_patch(target.path_str(), files[0].clone(), None).await;
        assert!(
            apply_result.is_ok(),
            "binary patch should apply cleanly: {:?}",
            apply_result.err()
        );
        let applied = std::fs::read(target.path.join("blob.bin")).unwrap();
        assert_eq!(applied, binary, "applied binary content must round-trip");
    }

    /// Finding 65: non-UTF8 diff content must be written verbatim, not dropped.
    #[tokio::test]
    async fn test_create_patch_preserves_non_utf8_bytes() {
        let source = TestRepo::with_initial_commit();

        // A file containing a Latin-1 0xE9 byte ("café" in ISO-8859-1).
        let latin1: Vec<u8> = vec![b'c', b'a', b'f', 0xE9, b'\n'];
        let file_path = source.path.join("latin1.txt");
        std::fs::write(&file_path, &latin1).unwrap();
        let repo = source.repo();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("latin1.txt")).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = repo.signature().unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        let oid = repo
            .commit(Some("HEAD"), &sig, &sig, "add latin1", &tree, &[&parent])
            .unwrap();

        let output_dir = source.path.join("patches");
        std::fs::create_dir_all(&output_dir).unwrap();
        let files = create_patch(
            source.path_str(),
            vec![oid.to_string()],
            output_dir.to_string_lossy().to_string(),
        )
        .await
        .unwrap();

        let bytes = std::fs::read(&files[0]).unwrap();
        // The raw 0xE9 byte must survive into the patch body.
        assert!(
            bytes.windows(1).any(|w| w == [0xE9]),
            "non-UTF8 byte 0xE9 was dropped from the patch"
        );
        // And it must be preceded by the '+' add marker + "caf".
        assert!(
            bytes
                .windows(5)
                .any(|w| w == [b'+', b'c', b'a', b'f', 0xE9]),
            "the '+' marker and content must stay glued to the byte"
        );
    }

    #[tokio::test]
    async fn test_apply_patch_to_index() {
        let source_repo = TestRepo::with_initial_commit();
        let oid = source_repo.create_commit("Add file", &[("indexed.txt", "indexed content")]);

        let output_dir = source_repo.path.join("patches");
        std::fs::create_dir_all(&output_dir).unwrap();

        let files = create_patch(
            source_repo.path_str(),
            vec![oid.to_string()],
            output_dir.to_string_lossy().to_string(),
        )
        .await
        .unwrap();

        let target_repo = TestRepo::with_initial_commit();
        let result = apply_patch_to_index(target_repo.path_str(), files[0].clone()).await;

        assert!(result.is_ok());
    }
}
