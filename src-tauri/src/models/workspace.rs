//! Workspace models for multi-repository workspaces
//! Persisted globally at ~/.config/gitnado/workspaces.json

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A workspace grouping related repositories
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub repositories: Vec<WorkspaceRepository>,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub last_opened: Option<DateTime<Utc>>,
}

/// A repository within a workspace
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRepository {
    pub path: String,
    pub name: String,
}

/// Top-level config persisted to disk
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacesConfig {
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
}

/// Status information for a repository within a workspace
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRepoStatus {
    pub path: String,
    pub name: String,
    pub exists: bool,
    pub is_valid_repo: bool,
    pub changed_files_count: usize,
    pub current_branch: Option<String>,
    /// True when HEAD is detached — the dialog renders that state rather than
    /// a branch name, since `shorthand()` reports the literal "HEAD" there
    pub is_detached: bool,
    pub ahead: usize,
    pub behind: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_workspace_serialization_roundtrip() {
        let workspace = Workspace {
            id: "test-id".to_string(),
            name: "My Workspace".to_string(),
            description: "A test workspace".to_string(),
            color: "#4fc3f7".to_string(),
            repositories: vec![
                WorkspaceRepository {
                    path: "/home/user/repo1".to_string(),
                    name: "repo1".to_string(),
                },
                WorkspaceRepository {
                    path: "/home/user/repo2".to_string(),
                    name: "repo2".to_string(),
                },
            ],
            created_at: Utc::now(),
            last_opened: Some(Utc::now()),
        };

        let json = serde_json::to_string(&workspace).unwrap();
        let deserialized: Workspace = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.id, "test-id");
        assert_eq!(deserialized.name, "My Workspace");
        assert_eq!(deserialized.description, "A test workspace");
        assert_eq!(deserialized.color, "#4fc3f7");
        assert_eq!(deserialized.repositories.len(), 2);
        assert_eq!(deserialized.repositories[0].name, "repo1");
        assert!(deserialized.last_opened.is_some());
    }

    #[test]
    fn test_workspace_camel_case_serialization() {
        let workspace = Workspace {
            id: "id1".to_string(),
            name: "Test".to_string(),
            description: String::new(),
            color: String::new(),
            repositories: vec![],
            created_at: Utc::now(),
            last_opened: None,
        };

        let json = serde_json::to_string(&workspace).unwrap();
        assert!(json.contains("createdAt"));
        assert!(json.contains("lastOpened"));
        assert!(!json.contains("created_at"));
        assert!(!json.contains("last_opened"));
    }

    #[test]
    fn test_workspace_repo_status_serialization() {
        let status = WorkspaceRepoStatus {
            path: "/test".to_string(),
            name: "test".to_string(),
            exists: true,
            is_valid_repo: true,
            changed_files_count: 5,
            current_branch: Some("main".to_string()),
            is_detached: false,
            ahead: 2,
            behind: 1,
        };

        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("isValidRepo"));
        assert!(json.contains("changedFilesCount"));
        assert!(json.contains("currentBranch"));

        let deserialized: WorkspaceRepoStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.changed_files_count, 5);
        assert_eq!(deserialized.current_branch, Some("main".to_string()));
        assert_eq!(deserialized.ahead, 2);
        assert_eq!(deserialized.behind, 1);
    }

    /// A detached HEAD ships as `isDetached` with no branch name, so the
    /// dialog can render the state instead of a branch called "HEAD".
    #[test]
    fn test_workspace_repo_status_detached_head_serialization() {
        let status = WorkspaceRepoStatus {
            path: "/test".to_string(),
            name: "test".to_string(),
            exists: true,
            is_valid_repo: true,
            changed_files_count: 0,
            current_branch: None,
            is_detached: true,
            ahead: 0,
            behind: 0,
        };

        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("isDetached"));
        assert!(!json.contains("is_detached"));

        let deserialized: WorkspaceRepoStatus = serde_json::from_str(&json).unwrap();
        assert!(deserialized.is_detached);
        assert_eq!(deserialized.current_branch, None);
    }

    #[test]
    fn test_workspaces_config_default() {
        let config = WorkspacesConfig::default();
        assert!(config.workspaces.is_empty());
    }

    #[test]
    fn test_workspaces_config_roundtrip() {
        let config = WorkspacesConfig {
            workspaces: vec![Workspace {
                id: "ws1".to_string(),
                name: "Workspace 1".to_string(),
                description: String::new(),
                color: "#ff0000".to_string(),
                repositories: vec![WorkspaceRepository {
                    path: "/repo".to_string(),
                    name: "repo".to_string(),
                }],
                created_at: Utc::now(),
                last_opened: None,
            }],
        };

        let json = serde_json::to_string_pretty(&config).unwrap();
        let deserialized: WorkspacesConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.workspaces.len(), 1);
        assert_eq!(deserialized.workspaces[0].name, "Workspace 1");
    }
}
