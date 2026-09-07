//! Pull request template detection commands
//!
//! Detects PR/MR templates in GitHub and GitLab repositories by searching
//! well-known template locations.

use crate::error::{GitnadoError, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::command;

/// A detected pull request template
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrTemplate {
    /// Display name derived from the file name
    pub name: String,
    /// Relative path to the template from the repo root
    pub path: String,
    /// Whether this is the default template (single-file templates are default)
    pub is_default: bool,
}

/// Well-known single-file PR template locations (checked in order).
/// The first match found in this list is considered the default template.
const SINGLE_FILE_TEMPLATES: &[&str] = &[
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/pull_request_template.md",
    "docs/pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md",
];

/// Well-known directories containing multiple PR templates.
const TEMPLATE_DIRECTORIES: &[&str] = &[
    ".github/PULL_REQUEST_TEMPLATE",
    ".gitlab/merge_request_templates",
];

/// Common markdown extensions to look for in template directories
const TEMPLATE_EXTENSIONS: &[&str] = &["md", "txt"];

/// Detect and list all PR/MR templates in a repository
#[command]
pub async fn get_pr_templates(path: String) -> Result<Vec<PrTemplate>> {
    let repo_path = PathBuf::from(&path);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err(GitnadoError::InvalidPath(format!(
            "Repository path does not exist: {}",
            path
        )));
    }

    let mut templates = Vec::new();
    let mut found_default = false;
    // Track canonical paths to avoid duplicates on case-insensitive file systems
    let mut seen_paths = std::collections::HashSet::new();

    // Check single-file template locations
    for template_rel in SINGLE_FILE_TEMPLATES {
        let full_path = repo_path.join(template_rel);
        if full_path.is_file() {
            // On case-insensitive file systems, multiple entries may resolve to the same file
            if let Ok(canonical) = full_path.canonicalize() {
                if !seen_paths.insert(canonical) {
                    continue;
                }
            }
            let name = derive_template_name(template_rel);
            let is_default = !found_default;
            if is_default {
                found_default = true;
            }
            templates.push(PrTemplate {
                name,
                path: template_rel.to_string(),
                is_default,
            });
        }
    }

    // Check template directories
    for dir_rel in TEMPLATE_DIRECTORIES {
        let dir_path = repo_path.join(dir_rel);
        if dir_path.is_dir() {
            if let Ok(entries) = fs::read_dir(&dir_path) {
                let mut dir_templates: Vec<PrTemplate> = entries
                    .filter_map(|entry| entry.ok())
                    .filter(|entry| {
                        let path = entry.path();
                        if !path.is_file() {
                            return false;
                        }
                        match path.extension().and_then(|e| e.to_str()) {
                            Some(ext) => TEMPLATE_EXTENSIONS.contains(&ext),
                            None => false,
                        }
                    })
                    .map(|entry| {
                        let file_name = entry.file_name().to_string_lossy().to_string();
                        let rel_path = format!("{}/{}", dir_rel, file_name);
                        let name = derive_template_name_from_file(&file_name);
                        PrTemplate {
                            name,
                            path: rel_path,
                            is_default: false,
                        }
                    })
                    .collect();

                // Sort directory templates by name for consistent ordering
                dir_templates.sort_by(|a, b| a.name.cmp(&b.name));

                // If no default found yet and there are directory templates,
                // mark the first one as default
                if !found_default {
                    if let Some(first) = dir_templates.first_mut() {
                        first.is_default = true;
                        found_default = true;
                    }
                }

                templates.extend(dir_templates);
            }
        }
    }

    Ok(templates)
}

/// Read the content of a specific PR template
#[command]
pub async fn get_pr_template_content(path: String, template_path: String) -> Result<String> {
    let repo_path = PathBuf::from(&path);

    if !repo_path.exists() || !repo_path.is_dir() {
        return Err(GitnadoError::InvalidPath(format!(
            "Repository path does not exist: {}",
            path
        )));
    }

    // Sanitize the template path to prevent directory traversal
    let template_rel = Path::new(&template_path);
    if template_rel.is_absolute() || template_path.contains("..") {
        return Err(GitnadoError::InvalidPath(
            "Template path must be relative and cannot contain '..'".to_string(),
        ));
    }

    let full_path = repo_path.join(template_rel);

    // Verify the resolved path is still within the repo
    let canonical_repo = repo_path.canonicalize().map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to resolve repo path: {}", e))
    })?;
    let canonical_template = full_path.canonicalize().map_err(|_| {
        GitnadoError::OperationFailed(format!("Template not found: {}", template_path))
    })?;

    if !canonical_template.starts_with(&canonical_repo) {
        return Err(GitnadoError::InvalidPath(
            "Template path is outside the repository".to_string(),
        ));
    }

    fs::read_to_string(&full_path)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to read template file: {}", e)))
}

/// Derive a display name from a template file's relative path.
/// For single-file templates, uses a standard name.
fn derive_template_name(rel_path: &str) -> String {
    let lower = rel_path.to_lowercase();
    if lower.contains("merge_request") {
        "Merge Request Template".to_string()
    } else {
        "Pull Request Template".to_string()
    }
}

/// Derive a display name from a template filename (in a directory).
/// Strips extension and converts underscores/hyphens to spaces, title-cased.
fn derive_template_name_from_file(filename: &str) -> String {
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename);

    stem.replace(['_', '-'], " ")
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => {
                    let upper: String = first.to_uppercase().collect();
                    upper + &chars.as_str().to_lowercase()
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    // ========================================================================
    // Template Name Derivation Tests
    // ========================================================================

    #[test]
    fn test_derive_template_name_github() {
        assert_eq!(
            derive_template_name(".github/PULL_REQUEST_TEMPLATE.md"),
            "Pull Request Template"
        );
    }

    #[test]
    fn test_derive_template_name_gitlab() {
        assert_eq!(
            derive_template_name(".gitlab/merge_request_templates/default.md"),
            "Merge Request Template"
        );
    }

    #[test]
    fn test_derive_template_name_from_file_simple() {
        assert_eq!(derive_template_name_from_file("bug_fix.md"), "Bug Fix");
    }

    #[test]
    fn test_derive_template_name_from_file_hyphens() {
        assert_eq!(
            derive_template_name_from_file("feature-request.md"),
            "Feature Request"
        );
    }

    #[test]
    fn test_derive_template_name_from_file_mixed() {
        assert_eq!(
            derive_template_name_from_file("my_cool-template.txt"),
            "My Cool Template"
        );
    }

    #[test]
    fn test_derive_template_name_from_file_uppercase() {
        assert_eq!(
            derive_template_name_from_file("FEATURE_REQUEST.md"),
            "Feature Request"
        );
    }

    #[test]
    fn test_derive_template_name_from_file_no_extension() {
        assert_eq!(derive_template_name_from_file("template"), "Template");
    }

    // ========================================================================
    // PrTemplate Serialization Tests
    // ========================================================================

    #[test]
    fn test_pr_template_serialization() {
        let template = PrTemplate {
            name: "Pull Request Template".to_string(),
            path: ".github/PULL_REQUEST_TEMPLATE.md".to_string(),
            is_default: true,
        };

        let json = serde_json::to_string(&template).unwrap();
        assert!(json.contains("isDefault")); // camelCase
        assert!(json.contains("Pull Request Template"));

        let deserialized: PrTemplate = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.name, "Pull Request Template");
        assert_eq!(deserialized.path, ".github/PULL_REQUEST_TEMPLATE.md");
        assert!(deserialized.is_default);
    }

    #[test]
    fn test_pr_template_deserialization() {
        let json = r#"{"name":"Bug Fix","path":".github/PULL_REQUEST_TEMPLATE/bug_fix.md","isDefault":false}"#;
        let template: PrTemplate = serde_json::from_str(json).unwrap();

        assert_eq!(template.name, "Bug Fix");
        assert_eq!(template.path, ".github/PULL_REQUEST_TEMPLATE/bug_fix.md");
        assert!(!template.is_default);
    }

    // ========================================================================
    // get_pr_templates Integration Tests
    // ========================================================================

    #[tokio::test]
    async fn test_get_pr_templates_no_templates() {
        let repo = TestRepo::with_initial_commit();
        let result = get_pr_templates(repo.path_str()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_get_pr_templates_github_default() {
        let repo = TestRepo::with_initial_commit();

        // Create the default GitHub template
        repo.create_file(
            ".github/PULL_REQUEST_TEMPLATE.md",
            "## Description\n\nPlease describe your changes.",
        );

        let result = get_pr_templates(repo.path_str()).await;
        assert!(result.is_ok());

        let templates = result.unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].name, "Pull Request Template");
        assert_eq!(templates[0].path, ".github/PULL_REQUEST_TEMPLATE.md");
        assert!(templates[0].is_default);
    }

    #[tokio::test]
    async fn test_get_pr_templates_lowercase_github() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file(
            ".github/pull_request_template.md",
            "## Changes\n\nDescribe changes here.",
        );

        let result = get_pr_templates(repo.path_str()).await;
        assert!(result.is_ok());

        let templates = result.unwrap();
        assert_eq!(templates.len(), 1);
        // On case-insensitive file systems (Windows/macOS), the first matching
        // entry in the search order wins, which is the uppercase variant.
        // On case-sensitive file systems (Linux), only the exact match is found.
        let path_lower = templates[0].path.to_lowercase();
        assert!(path_lower.contains("pull_request_template.md"));
        assert!(templates[0].is_default);
    }

    #[tokio::test]
    async fn test_get_pr_templates_root_level() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file("PULL_REQUEST_TEMPLATE.md", "## PR Description");

        let result = get_pr_templates(repo.path_str()).await;
        assert!(result.is_ok());

        let templates = result.unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].path, "PULL_REQUEST_TEMPLATE.md");
        assert!(templates[0].is_default);
    }

    #[tokio::test]
    async fn test_get_pr_templates_docs_directory() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file("docs/pull_request_template.md", "## Documentation PR");

        let result = get_pr_templates(repo.path_str()).await;
        assert!(result.is_ok());

        let templates = result.unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].path, "docs/pull_request_template.md");
        assert!(templates[0].is_default);
    }

    #[tokio::test]
    async fn test_get_pr_templates_multiple_directory_templates() {
        let repo = TestRepo::with_initial_commit();

        // Create directory with multiple templates
        repo.create_file(
            ".github/PULL_REQUEST_TEMPLATE/bug_fix.md",
            "## Bug Fix\n\nDescribe the bug.",
        );
        repo.create_file(
            ".github/PULL_REQUEST_TEMPLATE/feature_request.md",
            "## Feature Request\n\nDescribe the feature.",
        );

        let result = get_pr_templates(repo.path_str()).await;
        assert!(result.is_ok());

        let templates = result.unwrap();
        assert_eq!(templates.len(), 2);

        // Should be sorted by name
        assert_eq!(templates[0].name, "Bug Fix");
        assert_eq!(templates[1].name, "Feature Request");

        // First one should be default since no single-file template exists
        assert!(templates[0].is_default);
        assert!(!templates[1].is_default);
    }

    #[tokio::test]
    async fn test_get_pr_templates_single_and_directory() {
        let repo = TestRepo::with_initial_commit();

        // Create a single-file default template
        repo.create_file(".github/PULL_REQUEST_TEMPLATE.md", "## Default Template");

        // Also create directory templates
        repo.create_file(".github/PULL_REQUEST_TEMPLATE/bug_fix.md", "## Bug Fix");
        repo.create_file(".github/PULL_REQUEST_TEMPLATE/feature.md", "## Feature");

        let result = get_pr_templates(repo.path_str()).await;
        assert!(result.is_ok());

        let templates = result.unwrap();
        assert_eq!(templates.len(), 3);

        // The single-file template should be the default
        let default_templates: Vec<_> = templates.iter().filter(|t| t.is_default).collect();
        assert_eq!(default_templates.len(), 1);
        assert_eq!(
            default_templates[0].path,
            ".github/PULL_REQUEST_TEMPLATE.md"
        );
    }

    #[tokio::test]
    async fn test_get_pr_templates_gitlab_merge_request() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file(
            ".gitlab/merge_request_templates/default.md",
            "## Merge Request\n\nDescription here.",
        );
        repo.create_file(
            ".gitlab/merge_request_templates/hotfix.md",
            "## Hotfix\n\nDescribe the hotfix.",
        );

        let result = get_pr_templates(repo.path_str()).await;
        assert!(result.is_ok());

        let templates = result.unwrap();
        assert_eq!(templates.len(), 2);

        // Sorted by name
        assert_eq!(templates[0].name, "Default");
        assert_eq!(templates[1].name, "Hotfix");

        // Paths should reference the gitlab directory
        assert!(templates[0]
            .path
            .starts_with(".gitlab/merge_request_templates/"));
    }

    #[tokio::test]
    async fn test_get_pr_templates_ignores_non_template_files() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file(
            ".github/PULL_REQUEST_TEMPLATE/valid.md",
            "## Valid Template",
        );
        // Create a file with an unsupported extension
        repo.create_file(".github/PULL_REQUEST_TEMPLATE/notes.json", "{}");

        let result = get_pr_templates(repo.path_str()).await;
        assert!(result.is_ok());

        let templates = result.unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].name, "Valid");
    }

    #[tokio::test]
    async fn test_get_pr_templates_invalid_path() {
        let result = get_pr_templates("/nonexistent/path".to_string()).await;
        assert!(result.is_err());
    }

    // ========================================================================
    // get_pr_template_content Integration Tests
    // ========================================================================

    #[tokio::test]
    async fn test_get_pr_template_content_success() {
        let repo = TestRepo::with_initial_commit();

        let content =
            "## Description\n\nPlease describe your changes.\n\n## Testing\n\nHow was this tested?";
        repo.create_file(".github/PULL_REQUEST_TEMPLATE.md", content);

        let result = get_pr_template_content(
            repo.path_str(),
            ".github/PULL_REQUEST_TEMPLATE.md".to_string(),
        )
        .await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), content);
    }

    #[tokio::test]
    async fn test_get_pr_template_content_directory_template() {
        let repo = TestRepo::with_initial_commit();

        let content = "## Bug Fix\n\n### Root Cause\n\n### Fix Description";
        repo.create_file(".github/PULL_REQUEST_TEMPLATE/bug_fix.md", content);

        let result = get_pr_template_content(
            repo.path_str(),
            ".github/PULL_REQUEST_TEMPLATE/bug_fix.md".to_string(),
        )
        .await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), content);
    }

    #[tokio::test]
    async fn test_get_pr_template_content_not_found() {
        let repo = TestRepo::with_initial_commit();

        let result = get_pr_template_content(
            repo.path_str(),
            ".github/PULL_REQUEST_TEMPLATE.md".to_string(),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_pr_template_content_invalid_repo_path() {
        let result = get_pr_template_content(
            "/nonexistent/path".to_string(),
            ".github/PULL_REQUEST_TEMPLATE.md".to_string(),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_pr_template_content_rejects_absolute_path() {
        let repo = TestRepo::with_initial_commit();

        let result = get_pr_template_content(repo.path_str(), "/etc/passwd".to_string()).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_pr_template_content_rejects_directory_traversal() {
        let repo = TestRepo::with_initial_commit();

        let result =
            get_pr_template_content(repo.path_str(), "../../../etc/passwd".to_string()).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_pr_template_content_gitlab_template() {
        let repo = TestRepo::with_initial_commit();

        let content = "## Merge Request\n\nDescription of changes.";
        repo.create_file(".gitlab/merge_request_templates/default.md", content);

        let result = get_pr_template_content(
            repo.path_str(),
            ".gitlab/merge_request_templates/default.md".to_string(),
        )
        .await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), content);
    }
}
