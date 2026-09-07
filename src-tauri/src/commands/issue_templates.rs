//! Issue template detection commands
//!
//! Detects issue templates in GitHub and GitLab repositories by searching
//! well-known template locations.

use crate::error::{GitnadoError, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::command;

/// A detected issue template
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueTemplate {
    /// Display name derived from the file name
    pub name: String,
    /// Relative path to the template from the repo root
    pub path: String,
    /// Whether this is the default template (single-file templates are default)
    pub is_default: bool,
    /// Optional description extracted from YAML front matter
    pub description: Option<String>,
}

/// Well-known single-file issue template locations (checked in order).
/// The first match found in this list is considered the default template.
const SINGLE_FILE_TEMPLATES: &[&str] = &[
    ".github/ISSUE_TEMPLATE.md",
    ".github/issue_template.md",
    "docs/issue_template.md",
    "ISSUE_TEMPLATE.md",
    "issue_template.md",
];

/// Well-known directories containing multiple issue templates.
const TEMPLATE_DIRECTORIES: &[&str] = &[".github/ISSUE_TEMPLATE", ".gitlab/issue_templates"];

/// Common markdown extensions to look for in template directories
const TEMPLATE_EXTENSIONS: &[&str] = &["md", "txt", "yml", "yaml"];

/// Detect and list all issue templates in a repository
#[command]
pub async fn get_issue_templates(path: String) -> Result<Vec<IssueTemplate>> {
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
            let description = extract_front_matter_description(&full_path);
            let is_default = !found_default;
            if is_default {
                found_default = true;
            }
            templates.push(IssueTemplate {
                name: "Issue Template".to_string(),
                path: template_rel.to_string(),
                is_default,
                description,
            });
        }
    }

    // Check template directories
    for dir_rel in TEMPLATE_DIRECTORIES {
        let dir_path = repo_path.join(dir_rel);
        if dir_path.is_dir() {
            if let Ok(entries) = fs::read_dir(&dir_path) {
                let mut dir_templates: Vec<IssueTemplate> = entries
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
                        let description = extract_front_matter_description(&entry.path());
                        IssueTemplate {
                            name,
                            path: rel_path,
                            is_default: false,
                            description,
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

/// Read the content of a specific issue template
#[command]
pub async fn get_issue_template_content(path: String, template_path: String) -> Result<String> {
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

/// Extract a description from YAML front matter in a template file.
///
/// GitHub issue templates can contain YAML front matter like:
/// ```yaml
/// ---
/// name: Bug Report
/// about: Create a report to help us improve
/// ---
/// ```
///
/// This function extracts the `about` or `description` field.
fn extract_front_matter_description(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let trimmed = content.trim_start();

    if !trimmed.starts_with("---") {
        return None;
    }

    // Find the closing ---
    let after_opening = &trimmed[3..];
    let end_index = after_opening.find("---")?;
    let front_matter = &after_opening[..end_index];

    // Simple line-by-line parsing for `about:` or `description:` fields
    for line in front_matter.lines() {
        let line = line.trim();
        if let Some(value) = line
            .strip_prefix("about:")
            .or_else(|| line.strip_prefix("description:"))
        {
            let value = value.trim().trim_matches('"').trim_matches('\'');
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    // ========================================================================
    // Template Name Derivation Tests
    // ========================================================================

    #[test]
    fn test_derive_template_name_from_file_simple() {
        assert_eq!(
            derive_template_name_from_file("bug_report.md"),
            "Bug Report"
        );
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

    #[test]
    fn test_derive_template_name_from_file_yml() {
        assert_eq!(
            derive_template_name_from_file("bug_report.yml"),
            "Bug Report"
        );
    }

    // ========================================================================
    // Front Matter Description Extraction Tests
    // ========================================================================

    #[test]
    fn test_extract_front_matter_about() {
        let repo = TestRepo::with_initial_commit();
        let content = "---\nname: Bug Report\nabout: Create a report to help us improve\n---\n\n## Bug Description";
        repo.create_file("template.md", content);

        let path = PathBuf::from(repo.path_str()).join("template.md");
        let desc = extract_front_matter_description(&path);
        assert_eq!(desc, Some("Create a report to help us improve".to_string()));
    }

    #[test]
    fn test_extract_front_matter_description_field() {
        let repo = TestRepo::with_initial_commit();
        let content =
            "---\nname: Feature\ndescription: Suggest an idea for this project\n---\n\n## Feature";
        repo.create_file("template.md", content);

        let path = PathBuf::from(repo.path_str()).join("template.md");
        let desc = extract_front_matter_description(&path);
        assert_eq!(desc, Some("Suggest an idea for this project".to_string()));
    }

    #[test]
    fn test_extract_front_matter_quoted() {
        let repo = TestRepo::with_initial_commit();
        let content = "---\nname: Bug\nabout: \"Report a bug\"\n---\n\n## Bug";
        repo.create_file("template.md", content);

        let path = PathBuf::from(repo.path_str()).join("template.md");
        let desc = extract_front_matter_description(&path);
        assert_eq!(desc, Some("Report a bug".to_string()));
    }

    #[test]
    fn test_extract_front_matter_none_without_front_matter() {
        let repo = TestRepo::with_initial_commit();
        let content = "## Bug Description\n\nPlease describe the bug.";
        repo.create_file("template.md", content);

        let path = PathBuf::from(repo.path_str()).join("template.md");
        let desc = extract_front_matter_description(&path);
        assert_eq!(desc, None);
    }

    // ========================================================================
    // IssueTemplate Serialization Tests
    // ========================================================================

    #[test]
    fn test_issue_template_serialization() {
        let template = IssueTemplate {
            name: "Issue Template".to_string(),
            path: ".github/ISSUE_TEMPLATE.md".to_string(),
            is_default: true,
            description: Some("Default issue template".to_string()),
        };

        let json = serde_json::to_string(&template).unwrap();
        assert!(json.contains("isDefault")); // camelCase
        assert!(json.contains("Issue Template"));
        assert!(json.contains("Default issue template"));

        let deserialized: IssueTemplate = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.name, "Issue Template");
        assert_eq!(deserialized.path, ".github/ISSUE_TEMPLATE.md");
        assert!(deserialized.is_default);
        assert_eq!(
            deserialized.description,
            Some("Default issue template".to_string())
        );
    }

    #[test]
    fn test_issue_template_deserialization_without_description() {
        let json = r#"{"name":"Bug Report","path":".github/ISSUE_TEMPLATE/bug_report.md","isDefault":false,"description":null}"#;
        let template: IssueTemplate = serde_json::from_str(json).unwrap();

        assert_eq!(template.name, "Bug Report");
        assert_eq!(template.path, ".github/ISSUE_TEMPLATE/bug_report.md");
        assert!(!template.is_default);
        assert!(template.description.is_none());
    }

    // ========================================================================
    // get_issue_templates Integration Tests
    // ========================================================================

    #[tokio::test]
    async fn test_get_issue_templates_no_templates() {
        let repo = TestRepo::with_initial_commit();
        let result = get_issue_templates(repo.path_str()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_get_issue_templates_github_default() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file(
            ".github/ISSUE_TEMPLATE.md",
            "## Bug Description\n\nPlease describe the issue.",
        );

        let result = get_issue_templates(repo.path_str()).await;
        assert!(result.is_ok());

        let templates = result.unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].name, "Issue Template");
        assert_eq!(templates[0].path, ".github/ISSUE_TEMPLATE.md");
        assert!(templates[0].is_default);
    }

    #[tokio::test]
    async fn test_get_issue_templates_lowercase_github() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file(
            ".github/issue_template.md",
            "## Issue\n\nDescribe the issue here.",
        );

        let result = get_issue_templates(repo.path_str()).await;
        assert!(result.is_ok());

        let templates = result.unwrap();
        assert_eq!(templates.len(), 1);
        let path_lower = templates[0].path.to_lowercase();
        assert!(path_lower.contains("issue_template.md"));
        assert!(templates[0].is_default);
    }

    #[tokio::test]
    async fn test_get_issue_templates_root_level() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file("ISSUE_TEMPLATE.md", "## Issue Description");

        let result = get_issue_templates(repo.path_str()).await;
        assert!(result.is_ok());

        let templates = result.unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].path, "ISSUE_TEMPLATE.md");
        assert!(templates[0].is_default);
    }

    #[tokio::test]
    async fn test_get_issue_templates_docs_directory() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file("docs/issue_template.md", "## Documentation Issue");

        let result = get_issue_templates(repo.path_str()).await;
        assert!(result.is_ok());

        let templates = result.unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].path, "docs/issue_template.md");
        assert!(templates[0].is_default);
    }

    #[tokio::test]
    async fn test_get_issue_templates_multiple_directory_templates() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file(
            ".github/ISSUE_TEMPLATE/bug_report.md",
            "## Bug Report\n\nDescribe the bug.",
        );
        repo.create_file(
            ".github/ISSUE_TEMPLATE/feature_request.md",
            "## Feature Request\n\nDescribe the feature.",
        );

        let result = get_issue_templates(repo.path_str()).await;
        assert!(result.is_ok());

        let templates = result.unwrap();
        assert_eq!(templates.len(), 2);

        // Should be sorted by name
        assert_eq!(templates[0].name, "Bug Report");
        assert_eq!(templates[1].name, "Feature Request");

        // First one should be default since no single-file template exists
        assert!(templates[0].is_default);
        assert!(!templates[1].is_default);
    }

    #[tokio::test]
    async fn test_get_issue_templates_single_and_directory() {
        let repo = TestRepo::with_initial_commit();

        // Create a single-file default template
        repo.create_file(".github/ISSUE_TEMPLATE.md", "## Default Template");

        // Also create directory templates
        repo.create_file(".github/ISSUE_TEMPLATE/bug_report.md", "## Bug Report");
        repo.create_file(
            ".github/ISSUE_TEMPLATE/feature_request.md",
            "## Feature Request",
        );

        let result = get_issue_templates(repo.path_str()).await;
        assert!(result.is_ok());

        let templates = result.unwrap();
        assert_eq!(templates.len(), 3);

        // The single-file template should be the default
        let default_templates: Vec<_> = templates.iter().filter(|t| t.is_default).collect();
        assert_eq!(default_templates.len(), 1);
        assert_eq!(default_templates[0].path, ".github/ISSUE_TEMPLATE.md");
    }

    #[tokio::test]
    async fn test_get_issue_templates_gitlab_issue_templates() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file(
            ".gitlab/issue_templates/default.md",
            "## Issue\n\nDescription here.",
        );
        repo.create_file(
            ".gitlab/issue_templates/bug.md",
            "## Bug\n\nDescribe the bug.",
        );

        let result = get_issue_templates(repo.path_str()).await;
        assert!(result.is_ok());

        let templates = result.unwrap();
        assert_eq!(templates.len(), 2);

        // Sorted by name
        assert_eq!(templates[0].name, "Bug");
        assert_eq!(templates[1].name, "Default");

        // Paths should reference the gitlab directory
        assert!(templates[0].path.starts_with(".gitlab/issue_templates/"));
    }

    #[tokio::test]
    async fn test_get_issue_templates_with_yaml_front_matter() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file(
            ".github/ISSUE_TEMPLATE/bug_report.md",
            "---\nname: Bug Report\nabout: Create a report to help us improve\n---\n\n## Bug Description",
        );

        let result = get_issue_templates(repo.path_str()).await;
        assert!(result.is_ok());

        let templates = result.unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(
            templates[0].description,
            Some("Create a report to help us improve".to_string())
        );
    }

    #[tokio::test]
    async fn test_get_issue_templates_yml_files() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file(
            ".github/ISSUE_TEMPLATE/bug_report.yml",
            "name: Bug Report\ndescription: File a bug report\nbody:\n  - type: textarea",
        );

        let result = get_issue_templates(repo.path_str()).await;
        assert!(result.is_ok());

        let templates = result.unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].name, "Bug Report");
        assert_eq!(templates[0].path, ".github/ISSUE_TEMPLATE/bug_report.yml");
    }

    #[tokio::test]
    async fn test_get_issue_templates_ignores_non_template_files() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file(".github/ISSUE_TEMPLATE/valid.md", "## Valid Template");
        // Create a file with an unsupported extension
        repo.create_file(".github/ISSUE_TEMPLATE/config.json", "{}");

        let result = get_issue_templates(repo.path_str()).await;
        assert!(result.is_ok());

        let templates = result.unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].name, "Valid");
    }

    #[tokio::test]
    async fn test_get_issue_templates_invalid_path() {
        let result = get_issue_templates("/nonexistent/path".to_string()).await;
        assert!(result.is_err());
    }

    // ========================================================================
    // get_issue_template_content Integration Tests
    // ========================================================================

    #[tokio::test]
    async fn test_get_issue_template_content_success() {
        let repo = TestRepo::with_initial_commit();

        let content =
            "## Bug Description\n\nPlease describe the issue.\n\n## Steps to Reproduce\n\n1. ";
        repo.create_file(".github/ISSUE_TEMPLATE.md", content);

        let result =
            get_issue_template_content(repo.path_str(), ".github/ISSUE_TEMPLATE.md".to_string())
                .await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), content);
    }

    #[tokio::test]
    async fn test_get_issue_template_content_directory_template() {
        let repo = TestRepo::with_initial_commit();

        let content = "## Bug Report\n\n### Description\n\n### Steps to Reproduce";
        repo.create_file(".github/ISSUE_TEMPLATE/bug_report.md", content);

        let result = get_issue_template_content(
            repo.path_str(),
            ".github/ISSUE_TEMPLATE/bug_report.md".to_string(),
        )
        .await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), content);
    }

    #[tokio::test]
    async fn test_get_issue_template_content_not_found() {
        let repo = TestRepo::with_initial_commit();

        let result =
            get_issue_template_content(repo.path_str(), ".github/ISSUE_TEMPLATE.md".to_string())
                .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_issue_template_content_invalid_repo_path() {
        let result = get_issue_template_content(
            "/nonexistent/path".to_string(),
            ".github/ISSUE_TEMPLATE.md".to_string(),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_issue_template_content_rejects_absolute_path() {
        let repo = TestRepo::with_initial_commit();

        let result = get_issue_template_content(repo.path_str(), "/etc/passwd".to_string()).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_issue_template_content_rejects_directory_traversal() {
        let repo = TestRepo::with_initial_commit();

        let result =
            get_issue_template_content(repo.path_str(), "../../../etc/passwd".to_string()).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_issue_template_content_gitlab_template() {
        let repo = TestRepo::with_initial_commit();

        let content = "## Issue\n\nDescription of the issue.";
        repo.create_file(".gitlab/issue_templates/default.md", content);

        let result = get_issue_template_content(
            repo.path_str(),
            ".gitlab/issue_templates/default.md".to_string(),
        )
        .await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), content);
    }
}
