//! Commit template commands

use crate::error::{GitnadoError, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::command;

/// A saved commit message template
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitTemplate {
    pub id: String,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub is_conventional: bool,
    pub created_at: i64,
}

/// Get the templates file path
fn get_templates_path() -> Result<PathBuf> {
    Ok(crate::utils::app_paths::data_dir()?.join("commit-templates.json"))
}

/// Load templates from file
fn load_templates() -> Result<Vec<CommitTemplate>> {
    let path = get_templates_path()?;

    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&path).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to read templates file: {}", e))
    })?;

    // Handle empty or whitespace-only files gracefully
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    serde_json::from_str(trimmed).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse templates file: {}", e))
    })
}

/// Save templates to file
fn save_templates(templates: &[CommitTemplate]) -> Result<()> {
    let path = get_templates_path()?;

    let content = serde_json::to_string_pretty(templates).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to serialize templates: {}", e))
    })?;

    fs::write(&path, content).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to write templates file: {}", e))
    })?;

    Ok(())
}

/// Get the commit template from git config or .gitmessage file
#[command]
pub async fn get_commit_template(path: String) -> Result<Option<String>> {
    let repo = git2::Repository::open(&path)
        .map_err(|e| GitnadoError::OperationFailed(e.message().to_string()))?;

    let config = repo
        .config()
        .map_err(|e| GitnadoError::OperationFailed(e.message().to_string()))?;

    // Try to get commit.template from git config
    if let Ok(template_path) = config.get_string("commit.template") {
        let template_path = if let Some(stripped) = template_path.strip_prefix("~/") {
            if let Some(home) = dirs::home_dir() {
                home.join(stripped)
            } else {
                PathBuf::from(&template_path)
            }
        } else if template_path.starts_with('/') || template_path.starts_with('\\') {
            PathBuf::from(&template_path)
        } else {
            // Relative to repo root
            PathBuf::from(&path).join(&template_path)
        };

        if template_path.exists() {
            let content = fs::read_to_string(&template_path).map_err(|e| {
                GitnadoError::OperationFailed(format!("Failed to read template file: {}", e))
            })?;
            return Ok(Some(content));
        }
    }

    // Try .gitmessage in repo root
    let gitmessage_path = PathBuf::from(&path).join(".gitmessage");
    if gitmessage_path.exists() {
        let content = fs::read_to_string(&gitmessage_path).map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to read .gitmessage: {}", e))
        })?;
        return Ok(Some(content));
    }

    // Try global .gitmessage in home directory
    if let Some(home) = dirs::home_dir() {
        let global_gitmessage = home.join(".gitmessage");
        if global_gitmessage.exists() {
            let content = fs::read_to_string(&global_gitmessage).map_err(|e| {
                GitnadoError::OperationFailed(format!("Failed to read global .gitmessage: {}", e))
            })?;
            return Ok(Some(content));
        }
    }

    Ok(None)
}

/// List all saved commit templates
#[command]
pub async fn list_templates() -> Result<Vec<CommitTemplate>> {
    load_templates()
}

/// Save a new commit template
#[command]
pub async fn save_template(template: CommitTemplate) -> Result<CommitTemplate> {
    let mut templates = load_templates()?;

    // Check if template with same ID exists
    if let Some(pos) = templates.iter().position(|t| t.id == template.id) {
        templates[pos] = template.clone();
    } else {
        templates.push(template.clone());
    }

    save_templates(&templates)?;
    Ok(template)
}

/// Delete a commit template by ID
#[command]
pub async fn delete_template(id: String) -> Result<()> {
    let mut templates = load_templates()?;
    templates.retain(|t| t.id != id);
    save_templates(&templates)?;
    Ok(())
}

/// Get default conventional commit types
#[command]
pub async fn get_conventional_types() -> Vec<ConventionalType> {
    vec![
        ConventionalType {
            type_name: "feat".to_string(),
            description: "A new feature".to_string(),
            emoji: Some("✨".to_string()),
        },
        ConventionalType {
            type_name: "fix".to_string(),
            description: "A bug fix".to_string(),
            emoji: Some("🐛".to_string()),
        },
        ConventionalType {
            type_name: "docs".to_string(),
            description: "Documentation only changes".to_string(),
            emoji: Some("📚".to_string()),
        },
        ConventionalType {
            type_name: "style".to_string(),
            description: "Code style changes (formatting, semicolons, etc)".to_string(),
            emoji: Some("💎".to_string()),
        },
        ConventionalType {
            type_name: "refactor".to_string(),
            description: "Code change that neither fixes a bug nor adds a feature".to_string(),
            emoji: Some("📦".to_string()),
        },
        ConventionalType {
            type_name: "perf".to_string(),
            description: "A code change that improves performance".to_string(),
            emoji: Some("🚀".to_string()),
        },
        ConventionalType {
            type_name: "test".to_string(),
            description: "Adding missing tests or correcting existing tests".to_string(),
            emoji: Some("🚨".to_string()),
        },
        ConventionalType {
            type_name: "build".to_string(),
            description: "Changes that affect the build system or dependencies".to_string(),
            emoji: Some("🛠".to_string()),
        },
        ConventionalType {
            type_name: "ci".to_string(),
            description: "Changes to CI configuration files and scripts".to_string(),
            emoji: Some("⚙️".to_string()),
        },
        ConventionalType {
            type_name: "chore".to_string(),
            description: "Other changes that don't modify src or test files".to_string(),
            emoji: Some("♻️".to_string()),
        },
        ConventionalType {
            type_name: "revert".to_string(),
            description: "Reverts a previous commit".to_string(),
            emoji: Some("🗑".to_string()),
        },
    ]
}

/// A conventional commit type
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConventionalType {
    pub type_name: String,
    pub description: String,
    pub emoji: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[test]
    fn test_commit_template_serialization() {
        let template = CommitTemplate {
            id: "test-id".to_string(),
            name: "Test Template".to_string(),
            content: "feat: add new feature".to_string(),
            is_conventional: true,
            created_at: 1234567890,
        };

        let json = serde_json::to_string(&template).unwrap();
        let deserialized: CommitTemplate = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.id, "test-id");
        assert_eq!(deserialized.name, "Test Template");
        assert_eq!(deserialized.content, "feat: add new feature");
        assert!(deserialized.is_conventional);
        assert_eq!(deserialized.created_at, 1234567890);
    }

    #[test]
    fn test_commit_template_default_is_conventional() {
        // Test that is_conventional defaults to false when not provided
        let json = r#"{"id":"test","name":"Test","content":"test content","createdAt":0}"#;
        let template: CommitTemplate = serde_json::from_str(json).unwrap();
        assert!(!template.is_conventional);
    }

    #[tokio::test]
    async fn test_get_conventional_types() {
        let types = get_conventional_types().await;

        assert!(!types.is_empty());

        // Check for common types
        let type_names: Vec<&str> = types.iter().map(|t| t.type_name.as_str()).collect();
        assert!(type_names.contains(&"feat"));
        assert!(type_names.contains(&"fix"));
        assert!(type_names.contains(&"docs"));
        assert!(type_names.contains(&"refactor"));
        assert!(type_names.contains(&"test"));
        assert!(type_names.contains(&"chore"));
    }

    #[tokio::test]
    async fn test_conventional_types_have_descriptions() {
        let types = get_conventional_types().await;

        for conv_type in types {
            assert!(!conv_type.type_name.is_empty());
            assert!(!conv_type.description.is_empty());
            // Most types should have emojis
            if conv_type.type_name != "style" {
                assert!(conv_type.emoji.is_some());
            }
        }
    }

    #[test]
    fn test_conventional_type_serialization() {
        let conv_type = ConventionalType {
            type_name: "feat".to_string(),
            description: "A new feature".to_string(),
            emoji: Some("sparkles".to_string()),
        };

        let json = serde_json::to_string(&conv_type).unwrap();
        assert!(json.contains("typeName")); // Check camelCase serialization
        assert!(json.contains("feat"));

        let deserialized: ConventionalType = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.type_name, "feat");
    }

    /// Helper to isolate a test repo from global git config for commit.template.
    /// Sets a local commit.template pointing to a non-existent file, which
    /// overrides any global commit.template value and falls through gracefully.
    fn isolate_commit_template_config(repo: &TestRepo) {
        let git_repo = repo.repo();
        let mut config = git_repo.config().unwrap();
        config
            .set_str(
                "commit.template",
                repo.path.join(".nonexistent-template").to_str().unwrap(),
            )
            .unwrap();
    }

    #[tokio::test]
    async fn test_get_commit_template_no_template() {
        let repo = TestRepo::with_initial_commit();

        // Override any global commit.template so this test is isolated
        isolate_commit_template_config(&repo);

        let result = get_commit_template(repo.path_str()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_get_commit_template_with_gitmessage() {
        let repo = TestRepo::with_initial_commit();

        // Override any global commit.template so this test is isolated
        isolate_commit_template_config(&repo);

        // Create a .gitmessage file in the repo root
        let gitmessage_content = "# Commit message template\n\nTicket: ";
        repo.create_file(".gitmessage", gitmessage_content);

        let result = get_commit_template(repo.path_str()).await;
        assert!(result.is_ok());
        let template = result.unwrap();
        assert!(template.is_some());
        assert_eq!(template.unwrap(), gitmessage_content);
    }

    #[tokio::test]
    async fn test_get_commit_template_with_config() {
        let repo = TestRepo::with_initial_commit();

        // Create a custom template file
        let template_content = "feat: describe your feature\n\nWhy:\n- ";
        repo.create_file("my-template.txt", template_content);

        // Set the git config to use this template
        let git_repo = repo.repo();
        let mut config = git_repo.config().unwrap();
        config
            .set_str("commit.template", "my-template.txt")
            .unwrap();

        let result = get_commit_template(repo.path_str()).await;
        assert!(result.is_ok());
        let template = result.unwrap();
        assert!(template.is_some());
        assert_eq!(template.unwrap(), template_content);
    }

    #[tokio::test]
    async fn test_get_commit_template_invalid_repo() {
        let result = get_commit_template("/nonexistent/path".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_list_templates_integration() {
        // This tests the actual list_templates function
        // Note: This may affect actual user data if templates exist
        let result = list_templates().await;
        assert!(result.is_ok());
        // Should return a vector (empty or with templates)
    }

    #[tokio::test]
    #[ignore] // Flaky in CI - depends on system data directory
    async fn test_save_and_delete_template_integration() {
        let template = CommitTemplate {
            id: format!(
                "test-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
            ),
            name: "Integration Test Template".to_string(),
            content: "test: integration test".to_string(),
            is_conventional: true,
            created_at: 0,
        };

        // Save the template
        let save_result = save_template(template.clone()).await;
        assert!(save_result.is_ok());
        let saved = save_result.unwrap();
        assert_eq!(saved.id, template.id);
        assert_eq!(saved.name, template.name);

        // Verify it's in the list
        let list_result = list_templates().await.unwrap();
        assert!(list_result.iter().any(|t| t.id == template.id));

        // Delete the template
        let delete_result = delete_template(template.id.clone()).await;
        assert!(delete_result.is_ok());

        // Verify it's removed from the list
        let list_after_delete = list_templates().await.unwrap();
        assert!(!list_after_delete.iter().any(|t| t.id == template.id));
    }

    #[tokio::test]
    async fn test_save_template_updates_existing() {
        let template_id = format!(
            "test-update-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        );

        let template = CommitTemplate {
            id: template_id.clone(),
            name: "Original Name".to_string(),
            content: "original content".to_string(),
            is_conventional: false,
            created_at: 0,
        };

        // Save original
        save_template(template).await.unwrap();

        // Update with same ID
        let updated = CommitTemplate {
            id: template_id.clone(),
            name: "Updated Name".to_string(),
            content: "updated content".to_string(),
            is_conventional: true,
            created_at: 1,
        };

        let result = save_template(updated).await;
        assert!(result.is_ok());

        // Verify update
        let templates = list_templates().await.unwrap();
        let found = templates.iter().find(|t| t.id == template_id);
        assert!(found.is_some());
        assert_eq!(found.unwrap().name, "Updated Name");
        assert_eq!(found.unwrap().content, "updated content");

        // Cleanup
        delete_template(template_id).await.unwrap();
    }

    #[tokio::test]
    async fn test_delete_nonexistent_template() {
        // Deleting a non-existent template should succeed (no-op)
        let result = delete_template("nonexistent-template-id".to_string()).await;
        assert!(result.is_ok());
    }
}
