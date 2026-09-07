//! Shared path validation utilities for Tauri command handlers.
//!
//! Prevents directory traversal attacks (CWE-22) by ensuring
//! user-provided file paths stay within the repository directory.

use std::path::{Component, Path, PathBuf};

use crate::error::{GitnadoError, Result};

/// Validate that a file path stays within the repository directory.
///
/// Rejects absolute paths and paths containing a `..` (parent-directory)
/// component. Note this is a *component* check, not a substring check: a
/// filename such as `v1..v2.diff` or `...` is a legitimate pathname that git
/// tracks normally, so it must be accepted — only a literal `..` path segment
/// is rejected.
/// Canonicalizes the deepest existing ancestor to detect symlink-based escapes.
/// Works for both existing files and paths where the file may not exist yet.
pub fn validate_path_within_repo(repo_path: &Path, file_path: &str) -> Result<PathBuf> {
    let rel = Path::new(file_path);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(GitnadoError::InvalidPath(
            "File path must be relative and cannot contain '..'".to_string(),
        ));
    }

    let abs_path = repo_path.join(rel);

    // Canonicalize the repo path as our trust boundary
    let canonical_repo = repo_path.canonicalize().map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to resolve repo path: {}", e))
    })?;

    // Walk up until we find an existing ancestor we can canonicalize
    let mut check = abs_path.clone();
    loop {
        if check.exists() {
            let canonical = check.canonicalize().map_err(|e| {
                GitnadoError::OperationFailed(format!("Failed to resolve path: {}", e))
            })?;
            if !canonical.starts_with(&canonical_repo) {
                return Err(GitnadoError::InvalidPath(
                    "File path resolves to outside the repository".to_string(),
                ));
            }
            break;
        }
        if !check.pop() {
            return Err(GitnadoError::InvalidPath(
                "Cannot resolve file path".to_string(),
            ));
        }
    }

    Ok(abs_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[test]
    fn test_allows_filename_with_double_dot_substring() {
        // `git add 'v1..v2.diff'` succeeds; the validator must not reject it.
        let repo = TestRepo::new();
        let result = validate_path_within_repo(&repo.path, "v1..v2.diff");
        assert!(
            result.is_ok(),
            "filename containing '..' as a substring must be allowed"
        );
    }

    #[test]
    fn test_allows_double_dot_in_subdir_filename() {
        let repo = TestRepo::new();
        let result = validate_path_within_repo(&repo.path, "sub/a..b.txt");
        assert!(result.is_ok());
    }

    #[test]
    fn test_allows_triple_dot_filename() {
        // `...` is a valid path component, not a parent-directory reference.
        let repo = TestRepo::new();
        let result = validate_path_within_repo(&repo.path, "...");
        assert!(result.is_ok());
    }

    #[test]
    fn test_rejects_parent_dir_component() {
        let repo = TestRepo::new();
        let result = validate_path_within_repo(&repo.path, "../escape.txt");
        assert!(result.is_err());
    }

    #[test]
    fn test_rejects_nested_parent_dir_component() {
        let repo = TestRepo::new();
        let result = validate_path_within_repo(&repo.path, "sub/../../escape.txt");
        assert!(result.is_err());
    }

    #[test]
    fn test_rejects_absolute_path() {
        let repo = TestRepo::new();
        let result = validate_path_within_repo(&repo.path, "/etc/passwd");
        assert!(result.is_err());
    }
}
