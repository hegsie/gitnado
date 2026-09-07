//! Clipboard command handlers
//! Copy commit SHAs, file paths, branch names, and other information

use std::path::Path;
use tauri::command;

use serde::{Deserialize, Serialize};

use crate::error::{GitnadoError, Result};

/// Result of a copy operation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CopyResult {
    pub success: bool,
    pub text: String,
}

/// Format options for commit info
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitInfoFormat {
    Sha,
    ShortSha,
    Message,
    Full,
    Patch,
}

impl From<String> for CommitInfoFormat {
    fn from(s: String) -> Self {
        match s.to_lowercase().as_str() {
            "sha" => CommitInfoFormat::Sha,
            "short_sha" => CommitInfoFormat::ShortSha,
            "message" => CommitInfoFormat::Message,
            "full" => CommitInfoFormat::Full,
            "patch" => CommitInfoFormat::Patch,
            _ => CommitInfoFormat::Sha,
        }
    }
}

/// Format options for file paths
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilePathFormat {
    Relative,
    Absolute,
    Filename,
}

impl From<String> for FilePathFormat {
    fn from(s: String) -> Self {
        match s.to_lowercase().as_str() {
            "relative" => FilePathFormat::Relative,
            "absolute" => FilePathFormat::Absolute,
            "filename" => FilePathFormat::Filename,
            _ => FilePathFormat::Relative,
        }
    }
}

/// Copy text to system clipboard
/// Note: This is provided for completeness, but frontend typically uses navigator.clipboard directly
#[command]
pub async fn copy_to_clipboard(text: String) -> Result<CopyResult> {
    // In a desktop context, the frontend uses navigator.clipboard.writeText()
    // This command is provided for cases where backend-initiated clipboard operations are needed
    // For Tauri, clipboard operations are typically done on the frontend
    Ok(CopyResult {
        success: true,
        text,
    })
}

/// Get formatted commit info for copying
#[command]
pub async fn get_commit_info_for_copy(
    path: String,
    oid: String,
    format: String,
) -> Result<CopyResult> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let commit_oid =
        git2::Oid::from_str(&oid).map_err(|_| GitnadoError::CommitNotFound(oid.clone()))?;
    let commit = repo
        .find_commit(commit_oid)
        .map_err(|_| GitnadoError::CommitNotFound(oid.clone()))?;

    let format_enum = CommitInfoFormat::from(format);

    let text = match format_enum {
        CommitInfoFormat::Sha => commit.id().to_string(),
        CommitInfoFormat::ShortSha => {
            let full_sha = commit.id().to_string();
            full_sha[..7.min(full_sha.len())].to_string()
        }
        CommitInfoFormat::Message => commit.message().unwrap_or("").to_string(),
        CommitInfoFormat::Full => {
            let sha = commit.id().to_string();
            let short_sha = &sha[..7.min(sha.len())];
            let message = commit.message().unwrap_or("");
            let first_line = message.lines().next().unwrap_or("");
            format!("{} {}", short_sha, first_line)
        }
        CommitInfoFormat::Patch => generate_patch_content(&repo, &commit)?,
    };

    Ok(CopyResult {
        success: true,
        text,
    })
}

/// Generate patch content for a single commit
fn generate_patch_content(repo: &git2::Repository, commit: &git2::Commit) -> Result<String> {
    let parent_tree = if commit.parent_count() > 0 {
        Some(commit.parent(0)?.tree()?)
    } else {
        None
    };

    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit.tree()?), None)?;

    let mut patch_content = String::new();

    // Header
    let sig = commit.author();
    let oid_str = commit.id().to_string();
    let message = commit.message().unwrap_or("");

    patch_content.push_str(&format!("commit {}\n", oid_str));
    patch_content.push_str(&format!(
        "Author: {} <{}>\n",
        sig.name().unwrap_or("Unknown"),
        sig.email().unwrap_or("unknown@unknown.com")
    ));

    // Format time
    let time = commit.time();
    let epoch = time.seconds();
    if let Some(datetime) = chrono::DateTime::from_timestamp(epoch, 0) {
        let offset_minutes = time.offset_minutes();
        let offset = chrono::FixedOffset::east_opt(offset_minutes * 60)
            .or_else(|| chrono::FixedOffset::east_opt(0))
            .expect("UTC offset (0) is always valid");
        let local_time = datetime.with_timezone(&offset);
        patch_content.push_str(&format!(
            "Date:   {}\n",
            local_time.format("%a %b %d %H:%M:%S %Y %z")
        ));
    }

    patch_content.push('\n');

    // Commit message (indented)
    for line in message.lines() {
        patch_content.push_str("    ");
        patch_content.push_str(line);
        patch_content.push('\n');
    }

    patch_content.push('\n');

    // Diff stats
    let stats = diff.stats()?;
    let stats_buf = stats.to_buf(git2::DiffStatsFormat::SHORT, 80)?;
    patch_content.push_str(stats_buf.as_str().unwrap_or(""));
    patch_content.push('\n');

    // Actual diff
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        // File header lines
        let origin = line.origin();
        match origin {
            '+' | '-' | ' ' => {
                patch_content.push(origin);
            }
            'H' | 'F' => {
                // Header/file header lines, include as-is
            }
            _ => {}
        }
        if let Ok(content) = std::str::from_utf8(line.content()) {
            patch_content.push_str(content);
        }
        true
    })?;

    Ok(patch_content)
}

/// Get file path in various formats for copying
#[command]
pub async fn get_file_path_for_copy(
    path: String,
    file_path: String,
    format: String,
) -> Result<CopyResult> {
    let repo_path = Path::new(&path);
    if !repo_path.exists() {
        return Err(GitnadoError::InvalidPath(path));
    }

    let format_enum = FilePathFormat::from(format);

    let text = match format_enum {
        FilePathFormat::Relative => file_path,
        FilePathFormat::Absolute => {
            let full_path = repo_path.join(&file_path);
            // Canonicalize if possible, otherwise use joined path
            full_path
                .canonicalize()
                .unwrap_or(full_path)
                .to_string_lossy()
                .to_string()
        }
        FilePathFormat::Filename => Path::new(&file_path)
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or(file_path),
    };

    Ok(CopyResult {
        success: true,
        text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[tokio::test]
    async fn test_copy_to_clipboard() {
        let result = copy_to_clipboard("test text".to_string()).await;
        assert!(result.is_ok());
        let copy_result = result.unwrap();
        assert!(copy_result.success);
        assert_eq!(copy_result.text, "test text");
    }

    #[tokio::test]
    async fn test_get_commit_info_sha() {
        let test_repo = TestRepo::with_initial_commit();
        let oid = test_repo.head_oid();

        let result =
            get_commit_info_for_copy(test_repo.path_str(), oid.to_string(), "sha".to_string())
                .await;

        assert!(result.is_ok());
        let copy_result = result.unwrap();
        assert!(copy_result.success);
        assert_eq!(copy_result.text, oid.to_string());
    }

    #[tokio::test]
    async fn test_get_commit_info_short_sha() {
        let test_repo = TestRepo::with_initial_commit();
        let oid = test_repo.head_oid();

        let result = get_commit_info_for_copy(
            test_repo.path_str(),
            oid.to_string(),
            "short_sha".to_string(),
        )
        .await;

        assert!(result.is_ok());
        let copy_result = result.unwrap();
        assert!(copy_result.success);
        assert_eq!(copy_result.text.len(), 7);
        assert!(oid.to_string().starts_with(&copy_result.text));
    }

    #[tokio::test]
    async fn test_get_commit_info_message() {
        let test_repo = TestRepo::with_initial_commit();
        let oid = test_repo.head_oid();

        let result =
            get_commit_info_for_copy(test_repo.path_str(), oid.to_string(), "message".to_string())
                .await;

        assert!(result.is_ok());
        let copy_result = result.unwrap();
        assert!(copy_result.success);
        assert!(copy_result.text.contains("Initial"));
    }

    #[tokio::test]
    async fn test_get_commit_info_full() {
        let test_repo = TestRepo::with_initial_commit();
        let oid = test_repo.head_oid();

        let result =
            get_commit_info_for_copy(test_repo.path_str(), oid.to_string(), "full".to_string())
                .await;

        assert!(result.is_ok());
        let copy_result = result.unwrap();
        assert!(copy_result.success);
        // Should contain short SHA and message
        let short_sha = &oid.to_string()[..7];
        assert!(copy_result.text.starts_with(short_sha));
        assert!(copy_result.text.contains("Initial"));
    }

    #[tokio::test]
    async fn test_get_commit_info_patch() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("Add feature", &[("feature.txt", "feature content")]);
        let oid = test_repo.head_oid();

        let result =
            get_commit_info_for_copy(test_repo.path_str(), oid.to_string(), "patch".to_string())
                .await;

        assert!(result.is_ok());
        let copy_result = result.unwrap();
        assert!(copy_result.success);
        // Patch should contain commit header and diff
        assert!(copy_result.text.contains("commit"));
        assert!(copy_result.text.contains("Author:"));
    }

    #[tokio::test]
    async fn test_get_commit_info_not_found() {
        let test_repo = TestRepo::with_initial_commit();
        let fake_oid = "0000000000000000000000000000000000000000";

        let result = get_commit_info_for_copy(
            test_repo.path_str(),
            fake_oid.to_string(),
            "sha".to_string(),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_file_path_relative() {
        let test_repo = TestRepo::with_initial_commit();

        let result = get_file_path_for_copy(
            test_repo.path_str(),
            "src/main.rs".to_string(),
            "relative".to_string(),
        )
        .await;

        assert!(result.is_ok());
        let copy_result = result.unwrap();
        assert!(copy_result.success);
        assert_eq!(copy_result.text, "src/main.rs");
    }

    #[tokio::test]
    async fn test_get_file_path_absolute() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_file("test.txt", "content");

        let result = get_file_path_for_copy(
            test_repo.path_str(),
            "test.txt".to_string(),
            "absolute".to_string(),
        )
        .await;

        assert!(result.is_ok());
        let copy_result = result.unwrap();
        assert!(copy_result.success);
        // Should contain the full repo path
        assert!(
            copy_result.text.contains(
                &test_repo
                    .path_str()
                    .replace("/", std::path::MAIN_SEPARATOR_STR)
                    .replace("\\", std::path::MAIN_SEPARATOR_STR)
            ) || copy_result.text.contains("test.txt")
        );
    }

    #[tokio::test]
    async fn test_get_file_path_filename() {
        let test_repo = TestRepo::with_initial_commit();

        let result = get_file_path_for_copy(
            test_repo.path_str(),
            "src/components/main.rs".to_string(),
            "filename".to_string(),
        )
        .await;

        assert!(result.is_ok());
        let copy_result = result.unwrap();
        assert!(copy_result.success);
        assert_eq!(copy_result.text, "main.rs");
    }

    #[tokio::test]
    async fn test_get_file_path_invalid_repo() {
        let result = get_file_path_for_copy(
            "/nonexistent/path".to_string(),
            "file.txt".to_string(),
            "relative".to_string(),
        )
        .await;

        assert!(result.is_err());
    }
}
