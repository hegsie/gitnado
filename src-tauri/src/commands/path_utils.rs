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

    // Resolve the deepest existing entry and check where it actually lands. A
    // dangling symlink is followed to its target so that an in-repository link
    // is still accepted while one pointing outside the repository is refused.
    let resolved = resolve_existing_prefix(&abs_path, 0)?;
    if !resolved.starts_with(&canonical_repo) {
        return Err(GitnadoError::InvalidPath(
            "File path resolves to outside the repository".to_string(),
        ));
    }

    Ok(abs_path)
}

/// Escape Git pathspec metacharacters so only the named path matches.
pub fn literal_git_pathspec(path: &str) -> String {
    let mut escaped = String::with_capacity(path.len());
    for character in path.chars() {
        if matches!(character, '\\' | '*' | '?' | '[' | ']') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

const MAX_SYMLINK_DEPTH: u8 = 32;

/// Canonicalize `path` as far as it exists, then re-append the missing tail.
///
/// `Path::exists()` follows symlinks, so it reads a dangling link as absent and
/// a walk built on it would skip past the link. This instead inspects each
/// entry with `symlink_metadata`. A dangling link is resolved through its
/// target. Relative targets are based at the canonical parent so `..`
/// components resolve through symlinked parents before containment is checked.
fn resolve_existing_prefix(path: &Path, depth: u8) -> Result<PathBuf> {
    let unresolvable = || GitnadoError::InvalidPath("Cannot resolve file path".to_string());
    if depth > MAX_SYMLINK_DEPTH {
        return Err(GitnadoError::InvalidPath(
            "Too many levels of symbolic links".to_string(),
        ));
    }

    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        match std::fs::symlink_metadata(&current) {
            Ok(meta) => {
                let mut base = if meta.file_type().is_symlink() && current.canonicalize().is_err() {
                    let target = std::fs::read_link(&current).map_err(|e| {
                        GitnadoError::InvalidPath(format!("Cannot resolve file path: {}", e))
                    })?;
                    let target = if target.is_absolute() {
                        target
                    } else {
                        let parent = current
                            .parent()
                            .ok_or_else(unresolvable)?
                            .canonicalize()
                            .map_err(|e| {
                                GitnadoError::InvalidPath(format!(
                                    "Cannot resolve file path: {}",
                                    e
                                ))
                            })?;
                        parent.join(target)
                    };
                    resolve_existing_prefix(&target, depth + 1)?
                } else {
                    current.canonicalize().map_err(|e| {
                        GitnadoError::InvalidPath(format!("Cannot resolve file path: {}", e))
                    })?
                };
                for part in tail.iter().rev() {
                    base.push(part);
                }
                return Ok(base);
            }
            Err(_) => {
                let name = current.file_name().ok_or_else(unresolvable)?.to_owned();
                tail.push(name);
                if !current.pop() {
                    return Err(unresolvable());
                }
            }
        }
    }
}

/// Resolve a caller-supplied path for a repository-scoped command.
///
/// Relative paths go through [`validate_path_within_repo`]. An absolute path is
/// accepted only when it lies inside the repository (matched against both the
/// given and the canonical repo path, so a symlinked prefix such as macOS
/// `/var` works); it is then validated as the repo-relative remainder.
pub fn resolve_path_within_repo(repo_path: &Path, file_path: &str) -> Result<PathBuf> {
    let given = Path::new(file_path);
    if !given.is_absolute() {
        return validate_path_within_repo(repo_path, file_path);
    }

    let canonical_repo = repo_path.canonicalize().map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to resolve repo path: {}", e))
    })?;
    let rel = given
        .strip_prefix(repo_path)
        .or_else(|_| given.strip_prefix(&canonical_repo))
        .map_err(|_| {
            GitnadoError::InvalidPath("File path is outside the repository".to_string())
        })?;
    let rel = rel
        .to_str()
        .ok_or_else(|| GitnadoError::InvalidPath("File path is not valid UTF-8".to_string()))?;
    if rel.is_empty() {
        return Err(GitnadoError::InvalidPath(
            "File path must name a file inside the repository".to_string(),
        ));
    }
    validate_path_within_repo(repo_path, rel)
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

    #[cfg(unix)]
    #[test]
    fn test_rejects_dangling_symlink_to_outside_missing_file() {
        let repo = TestRepo::new();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("created-by-attacker.txt");
        std::os::unix::fs::symlink(&target, repo.path.join("link.txt")).unwrap();

        assert!(
            validate_path_within_repo(&repo.path, "link.txt").is_err(),
            "a dangling symlink pointing outside the repo must be refused"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_rejects_new_file_under_symlinked_dir_outside_repo() {
        let repo = TestRepo::new();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), repo.path.join("dirlink")).unwrap();

        assert!(validate_path_within_repo(&repo.path, "dirlink/new.txt").is_err());
        assert!(validate_path_within_repo(&repo.path, "dirlink/sub/new.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn test_rejects_dangling_intermediate_symlink() {
        let repo = TestRepo::new();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("missing-dir");
        std::os::unix::fs::symlink(&target, repo.path.join("dl")).unwrap();

        assert!(validate_path_within_repo(&repo.path, "dl/new.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn test_allows_symlink_that_stays_inside_repo() {
        let repo = TestRepo::new();
        repo.create_file("real.txt", "content");
        std::os::unix::fs::symlink(repo.path.join("real.txt"), repo.path.join("alias.txt"))
            .unwrap();
        std::os::unix::fs::symlink("real.txt", repo.path.join("rel-alias.txt")).unwrap();

        assert!(validate_path_within_repo(&repo.path, "alias.txt").is_ok());
        assert!(validate_path_within_repo(&repo.path, "rel-alias.txt").is_ok());
    }

    #[test]
    fn test_resolve_accepts_absolute_path_inside_repo() {
        let repo = TestRepo::new();
        let abs = repo.path.join("sub").join("file.txt");
        let resolved = resolve_path_within_repo(&repo.path, abs.to_str().unwrap()).unwrap();
        assert_eq!(resolved, repo.path.join("sub").join("file.txt"));
    }

    #[test]
    fn test_resolve_rejects_absolute_path_outside_repo() {
        let repo = TestRepo::new();
        let outside = tempfile::tempdir().unwrap();
        let abs = outside.path().join("victim.txt");
        assert!(resolve_path_within_repo(&repo.path, abs.to_str().unwrap()).is_err());
    }

    #[test]
    fn test_resolve_rejects_absolute_path_with_parent_components() {
        let repo = TestRepo::new();
        let escape = repo.path.join("..").join("victim.txt");
        assert!(resolve_path_within_repo(&repo.path, escape.to_str().unwrap()).is_err());
    }

    #[test]
    fn test_resolve_rejects_repo_root_itself() {
        let repo = TestRepo::new();
        assert!(resolve_path_within_repo(&repo.path, repo.path.to_str().unwrap()).is_err());
    }
}
