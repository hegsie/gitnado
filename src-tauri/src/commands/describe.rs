//! Git describe command handlers
//!
//! Provides functionality to describe commits using tags

use std::path::Path;
use std::process::Command;
use tauri::command;

use crate::error::{GitnadoError, Result};

/// Result of a git describe operation
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DescribeResult {
    /// The full describe string (e.g., "v1.0.0-5-gabcdef1")
    pub description: String,
    /// The tag name if found
    pub tag: Option<String>,
    /// Number of commits ahead of the tag (if any)
    pub commits_ahead: Option<u32>,
    /// The abbreviated commit hash (if not exactly on a tag)
    pub commit_hash: Option<String>,
    /// Whether the working tree is dirty
    pub is_dirty: bool,
}

/// Parse a git describe output into structured result
fn parse_describe_output(output: &str) -> DescribeResult {
    let output = output.trim();
    let is_dirty = output.ends_with("-dirty");
    let clean_output = if is_dirty {
        output.strip_suffix("-dirty").unwrap_or(output)
    } else {
        output
    };

    // Try to parse the format: tag-N-gHASH
    // where N is commits ahead and HASH is abbreviated commit hash
    let parts: Vec<&str> = clean_output.rsplitn(3, '-').collect();

    if parts.len() == 3 && parts[0].starts_with('g') {
        // Format: tag-N-gHASH
        let commit_hash = parts[0].strip_prefix('g').map(|s| s.to_string());
        let commits_ahead = parts[1].parse::<u32>().ok();
        let tag = Some(parts[2].to_string());

        DescribeResult {
            description: output.to_string(),
            tag,
            commits_ahead,
            commit_hash,
            is_dirty,
        }
    } else {
        // Exactly on a tag or long format with 0 commits ahead
        // Check if it looks like a long format on a tag (tag-0-gHASH)
        if parts.len() == 3 && parts[0].starts_with('g') && parts[1].parse::<u32>().ok() == Some(0)
        {
            let commit_hash = parts[0].strip_prefix('g').map(|s| s.to_string());
            let tag = Some(parts[2].to_string());

            DescribeResult {
                description: output.to_string(),
                tag,
                commits_ahead: Some(0),
                commit_hash,
                is_dirty,
            }
        } else {
            // Exactly on a tag (short format)
            DescribeResult {
                description: output.to_string(),
                tag: Some(clean_output.to_string()),
                commits_ahead: Some(0),
                commit_hash: None,
                is_dirty,
            }
        }
    }
}

/// Whether a failed `git describe` failed only because nothing names the commit.
///
/// git words this case three ways depending on which refs exist and which
/// flags are in play:
///   "fatal: No names found, cannot describe anything."
///   "fatal: No annotated tags can describe '<oid>'."
///   "fatal: No tags can describe '<oid>'."
/// Every other failure (bad revision, unreadable repository) is a real fault.
/// The command below runs under LC_ALL=C so these stay in English on a
/// localized machine.
fn is_no_names_found(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("no names found") || lower.contains("can describe")
}

/// Describe a commit using tags
///
/// Returns the most recent tag reachable from a commit, with additional
/// information about commits since the tag and the commit hash.
#[command]
#[allow(clippy::too_many_arguments)]
pub async fn describe(
    path: String,
    commitish: Option<String>,
    tags: Option<bool>,
    all: Option<bool>,
    long: Option<bool>,
    abbrev: Option<u32>,
    match_pattern: Option<String>,
    exclude_pattern: Option<String>,
    first_parent: Option<bool>,
    dirty: Option<bool>,
) -> Result<DescribeResult> {
    // Verify the repository exists
    let repo_path = Path::new(&path);
    if !repo_path.join(".git").exists() && !repo_path.join("HEAD").exists() {
        return Err(GitnadoError::RepositoryNotFound(path));
    }

    // Build the git describe command
    let mut cmd = Command::new("git");
    cmd.current_dir(&path);
    // Pinned to the C locale so the "nothing tags this commit" failure below
    // is recognizable by its wording on a machine with git's translations
    // installed — that case is an empty state in the UI, not an error.
    cmd.env("LC_ALL", "C");
    cmd.arg("describe");

    // Add flags based on options
    if tags.unwrap_or(false) {
        cmd.arg("--tags");
    }

    if all.unwrap_or(false) {
        cmd.arg("--all");
    }

    if long.unwrap_or(false) {
        cmd.arg("--long");
    }

    if let Some(abbrev_len) = abbrev {
        cmd.arg(format!("--abbrev={}", abbrev_len));
    }

    if let Some(ref pattern) = match_pattern {
        cmd.arg(format!("--match={}", pattern));
    }

    if let Some(ref pattern) = exclude_pattern {
        cmd.arg(format!("--exclude={}", pattern));
    }

    if first_parent.unwrap_or(false) {
        cmd.arg("--first-parent");
    }

    if dirty.unwrap_or(false) {
        cmd.arg("--dirty");
    }

    // Add the commitish if provided (must be last)
    if let Some(ref commit) = commitish {
        cmd.arg(commit);
    }

    // Execute the command
    let output = cmd.output().map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to execute git describe: {}", e))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        // A commit with no tag above it is the normal state of every commit in
        // a repository nobody has tagged yet, so it is reported separately
        // from the failures that mean the request itself was wrong.
        if is_no_names_found(stderr) {
            return Err(GitnadoError::NoTagsReachable(
                commitish.unwrap_or_else(|| "HEAD".to_string()),
            ));
        }
        return Err(GitnadoError::OperationFailed(format!(
            "git describe failed: {}",
            stderr
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_describe_output(&stdout))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[test]
    fn test_parse_describe_on_tag() {
        let result = parse_describe_output("v1.0.0");
        assert_eq!(result.description, "v1.0.0");
        assert_eq!(result.tag, Some("v1.0.0".to_string()));
        assert_eq!(result.commits_ahead, Some(0));
        assert_eq!(result.commit_hash, None);
        assert!(!result.is_dirty);
    }

    #[test]
    fn test_parse_describe_ahead_of_tag() {
        let result = parse_describe_output("v1.0.0-5-gabcdef1");
        assert_eq!(result.description, "v1.0.0-5-gabcdef1");
        assert_eq!(result.tag, Some("v1.0.0".to_string()));
        assert_eq!(result.commits_ahead, Some(5));
        assert_eq!(result.commit_hash, Some("abcdef1".to_string()));
        assert!(!result.is_dirty);
    }

    #[test]
    fn test_parse_describe_dirty() {
        let result = parse_describe_output("v1.0.0-dirty");
        assert_eq!(result.description, "v1.0.0-dirty");
        assert_eq!(result.tag, Some("v1.0.0".to_string()));
        assert!(result.is_dirty);
    }

    #[test]
    fn test_parse_describe_ahead_and_dirty() {
        let result = parse_describe_output("v1.0.0-3-g1234567-dirty");
        assert_eq!(result.description, "v1.0.0-3-g1234567-dirty");
        assert_eq!(result.tag, Some("v1.0.0".to_string()));
        assert_eq!(result.commits_ahead, Some(3));
        assert_eq!(result.commit_hash, Some("1234567".to_string()));
        assert!(result.is_dirty);
    }

    #[test]
    fn test_parse_describe_long_format_on_tag() {
        let result = parse_describe_output("v1.0.0-0-gabcdef1");
        assert_eq!(result.description, "v1.0.0-0-gabcdef1");
        assert_eq!(result.tag, Some("v1.0.0".to_string()));
        assert_eq!(result.commits_ahead, Some(0));
        assert_eq!(result.commit_hash, Some("abcdef1".to_string()));
        assert!(!result.is_dirty);
    }

    #[test]
    fn test_parse_describe_tag_with_dashes() {
        let result = parse_describe_output("v1.0.0-beta-2-g1234567");
        assert_eq!(result.description, "v1.0.0-beta-2-g1234567");
        assert_eq!(result.tag, Some("v1.0.0-beta".to_string()));
        assert_eq!(result.commits_ahead, Some(2));
        assert_eq!(result.commit_hash, Some("1234567".to_string()));
        assert!(!result.is_dirty);
    }

    #[tokio::test]
    async fn test_describe_no_tags() {
        let repo = TestRepo::with_initial_commit();
        let result = describe(
            repo.path_str(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;

        // Nothing tags this commit. That is reported as its own error so the
        // UI can show an empty state rather than a failure.
        assert!(matches!(
            result,
            Err(GitnadoError::NoTagsReachable(ref target)) if target == "HEAD"
        ));
    }

    #[tokio::test]
    async fn test_describe_no_tags_names_the_commit_it_was_asked_about() {
        let repo = TestRepo::with_initial_commit();
        let oid = repo.head_oid().to_string();

        let result = describe(
            repo.path_str(),
            Some(oid.clone()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;

        assert!(matches!(
            result,
            Err(GitnadoError::NoTagsReachable(ref target)) if *target == oid
        ));
    }

    #[tokio::test]
    async fn test_describe_bad_revision_is_not_an_empty_result() {
        let repo = TestRepo::with_initial_commit();
        repo.create_tag("v1.0.0");

        // A revision that does not resolve is a real fault, not "nothing tags
        // this commit" — the two must not collapse into the same report.
        let result = describe(
            repo.path_str(),
            Some("no-such-revision".to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;

        assert!(matches!(result, Err(GitnadoError::OperationFailed(_))));
    }

    #[test]
    fn test_is_no_names_found_wordings() {
        assert!(is_no_names_found(
            "fatal: No names found, cannot describe anything."
        ));
        assert!(is_no_names_found(
            "fatal: No annotated tags can describe '0123456789abcdef'."
        ));
        assert!(is_no_names_found(
            "fatal: No tags can describe '0123456789abcdef'."
        ));
        // Real faults must not be mistaken for the empty case.
        assert!(!is_no_names_found(
            "fatal: Not a valid object name no-such-revision"
        ));
        assert!(!is_no_names_found(
            "fatal: not a git repository (or any of the parent directories): .git"
        ));
    }

    #[tokio::test]
    async fn test_describe_with_tag() {
        let repo = TestRepo::with_initial_commit();
        repo.create_tag("v1.0.0");

        let result = describe(
            repo.path_str(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_ok());

        let desc = result.unwrap();
        assert!(desc.tag.is_some());
        assert_eq!(desc.tag.unwrap(), "v1.0.0");
    }

    #[tokio::test]
    async fn test_describe_with_lightweight_tag() {
        let repo = TestRepo::with_initial_commit();
        repo.create_lightweight_tag("v0.1.0");

        // Without --tags flag, lightweight tags are not found. git's wording
        // there ("No annotated tags can describe ...") is still the empty
        // case, and the UI offers --tags as the way out of it.
        let result = describe(
            repo.path_str(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(matches!(result, Err(GitnadoError::NoTagsReachable(_))));

        // With --tags flag, lightweight tags are found
        let result = describe(
            repo.path_str(),
            None,
            Some(true),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_ok());

        let desc = result.unwrap();
        assert_eq!(desc.tag, Some("v0.1.0".to_string()));
    }

    #[tokio::test]
    async fn test_describe_commits_ahead() {
        let repo = TestRepo::with_initial_commit();
        repo.create_tag("v1.0.0");

        // Create additional commits
        repo.create_commit("Second commit", &[("file.txt", "content")]);
        repo.create_commit("Third commit", &[("file2.txt", "content2")]);

        let result = describe(
            repo.path_str(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_ok());

        let desc = result.unwrap();
        assert_eq!(desc.tag, Some("v1.0.0".to_string()));
        assert_eq!(desc.commits_ahead, Some(2));
        assert!(desc.commit_hash.is_some());
    }

    #[tokio::test]
    async fn test_describe_long_format() {
        let repo = TestRepo::with_initial_commit();
        repo.create_tag("v1.0.0");

        // With long format, even on a tag we get the hash
        let result = describe(
            repo.path_str(),
            None,
            None,
            None,
            Some(true),
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_ok());

        let desc = result.unwrap();
        assert!(desc.description.contains("-0-g"));
    }

    #[tokio::test]
    async fn test_describe_specific_commit() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid().to_string();
        repo.create_tag("v1.0.0");

        repo.create_commit("Second commit", &[("file.txt", "content")]);
        repo.create_tag("v2.0.0");

        // Describe the first commit (should get v1.0.0)
        let result = describe(
            repo.path_str(),
            Some(first_oid),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_ok());

        let desc = result.unwrap();
        assert_eq!(desc.tag, Some("v1.0.0".to_string()));
    }

    #[tokio::test]
    async fn test_describe_match_pattern() {
        let repo = TestRepo::with_initial_commit();
        repo.create_tag("v1.0.0");

        repo.create_commit("Second commit", &[("file.txt", "content")]);
        repo.create_tag("release-2.0.0");

        // Match only release-* tags
        let result = describe(
            repo.path_str(),
            None,
            None,
            None,
            None,
            None,
            Some("release-*".to_string()),
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_ok());

        let desc = result.unwrap();
        assert_eq!(desc.tag, Some("release-2.0.0".to_string()));
    }

    #[tokio::test]
    async fn test_describe_exclude_pattern() {
        let repo = TestRepo::with_initial_commit();
        repo.create_tag("v1.0.0");

        repo.create_commit("Second commit", &[("file.txt", "content")]);
        repo.create_tag("v2.0.0-rc1");

        // Exclude rc tags
        let result = describe(
            repo.path_str(),
            None,
            None,
            None,
            None,
            None,
            None,
            Some("*-rc*".to_string()),
            None,
            None,
        )
        .await;
        assert!(result.is_ok());

        let desc = result.unwrap();
        // Should find v1.0.0 since v2.0.0-rc1 is excluded
        assert_eq!(desc.tag, Some("v1.0.0".to_string()));
    }

    #[tokio::test]
    async fn test_describe_abbrev() {
        let repo = TestRepo::with_initial_commit();
        repo.create_tag("v1.0.0");
        repo.create_commit("Second commit", &[("file.txt", "content")]);

        // Use a specific abbrev length
        let result = describe(
            repo.path_str(),
            None,
            None,
            None,
            None,
            Some(10),
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_ok());

        let desc = result.unwrap();
        if let Some(hash) = desc.commit_hash {
            assert_eq!(hash.len(), 10);
        }
    }

    #[tokio::test]
    async fn test_describe_dirty() {
        let repo = TestRepo::with_initial_commit();
        repo.create_tag("v1.0.0");

        // Modify a tracked file to make the working tree dirty
        // (untracked files don't count as dirty for git describe)
        repo.create_file("README.md", "modified content");

        // Without dirty flag
        let result = describe(
            repo.path_str(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_ok());
        let desc = result.unwrap();
        assert!(!desc.is_dirty);

        // With dirty flag
        let result = describe(
            repo.path_str(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(true),
        )
        .await;
        assert!(result.is_ok());
        let desc = result.unwrap();
        assert!(desc.is_dirty);
    }

    #[tokio::test]
    async fn test_describe_invalid_path() {
        let result = describe(
            "/nonexistent/path".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_describe_all_refs() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("feature");

        // With --all flag, can describe using branches
        let result = describe(
            repo.path_str(),
            None,
            None,
            Some(true),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_ok());

        let desc = result.unwrap();
        // The description should include heads/ or similar ref prefix
        assert!(
            desc.description.contains("heads/")
                || desc.description.contains("master")
                || desc.description.contains("main")
        );
    }
}
