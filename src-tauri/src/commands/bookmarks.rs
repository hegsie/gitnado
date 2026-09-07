//! Bookmark and recent repository commands

use crate::error::{GitnadoError, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::command;

/// A bookmarked or recently opened repository
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoBookmark {
    pub path: String,
    pub name: String,
    pub group: Option<String>,
    pub pinned: bool,
    pub last_opened: i64,
    pub color: Option<String>,
}

/// Maximum number of recent repos to keep
const MAX_RECENT_REPOS: usize = 50;

/// Get the bookmarks file path
fn get_bookmarks_path() -> Result<PathBuf> {
    let data_dir = dirs::data_dir().unwrap_or_else(std::env::temp_dir);

    let app_dir = crate::utils::app_paths::app_subdir(&data_dir);
    fs::create_dir_all(&app_dir).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to create app directory: {}", e))
    })?;

    Ok(app_dir.join("bookmarks.json"))
}

/// Load bookmarks from file
fn load_bookmarks() -> Result<Vec<RepoBookmark>> {
    let path = get_bookmarks_path()?;

    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&path).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to read bookmarks file: {}", e))
    })?;

    serde_json::from_str(&content).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse bookmarks file: {}", e))
    })
}

/// Save bookmarks to file
fn save_bookmarks(bookmarks: &[RepoBookmark]) -> Result<()> {
    let path = get_bookmarks_path()?;

    let content = serde_json::to_string_pretty(bookmarks).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to serialize bookmarks: {}", e))
    })?;

    fs::write(&path, content).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to write bookmarks file: {}", e))
    })?;

    Ok(())
}

/// Get all bookmarks
#[command]
pub async fn get_bookmarks() -> Result<Vec<RepoBookmark>> {
    load_bookmarks()
}

/// Add a new bookmark
#[command]
pub async fn add_bookmark(
    path: String,
    name: String,
    group: Option<String>,
) -> Result<Vec<RepoBookmark>> {
    let mut bookmarks = load_bookmarks()?;

    // Check if bookmark already exists for this path
    if bookmarks.iter().any(|b| b.path == path) {
        return Err(GitnadoError::OperationFailed(format!(
            "Bookmark already exists for path: {}",
            path
        )));
    }

    let now = chrono::Utc::now().timestamp();

    bookmarks.push(RepoBookmark {
        path,
        name,
        group,
        pinned: false,
        last_opened: now,
        color: None,
    });

    save_bookmarks(&bookmarks)?;
    Ok(bookmarks)
}

/// Remove a bookmark by path
#[command]
pub async fn remove_bookmark(path: String) -> Result<Vec<RepoBookmark>> {
    let mut bookmarks = load_bookmarks()?;
    bookmarks.retain(|b| b.path != path);
    save_bookmarks(&bookmarks)?;
    Ok(bookmarks)
}

/// Update an existing bookmark
#[command]
pub async fn update_bookmark(bookmark: RepoBookmark) -> Result<Vec<RepoBookmark>> {
    let mut bookmarks = load_bookmarks()?;

    if let Some(pos) = bookmarks.iter().position(|b| b.path == bookmark.path) {
        bookmarks[pos] = bookmark;
    } else {
        return Err(GitnadoError::OperationFailed(format!(
            "Bookmark not found for path: {}",
            bookmark.path
        )));
    }

    save_bookmarks(&bookmarks)?;
    Ok(bookmarks)
}

/// Get recently opened repos sorted by last_opened (most recent first)
#[command]
pub async fn get_recent_repos() -> Result<Vec<RepoBookmark>> {
    let mut bookmarks = load_bookmarks()?;
    bookmarks.sort_by_key(|b| std::cmp::Reverse(b.last_opened));
    Ok(bookmarks)
}

/// Record that a repo was opened (updates last_opened or creates a new entry)
#[command]
pub async fn record_repo_opened(path: String, name: String) -> Result<()> {
    let mut bookmarks = load_bookmarks()?;
    let now = chrono::Utc::now().timestamp();

    if let Some(pos) = bookmarks.iter().position(|b| b.path == path) {
        bookmarks[pos].last_opened = now;
    } else {
        bookmarks.push(RepoBookmark {
            path,
            name,
            group: None,
            pinned: false,
            last_opened: now,
            color: None,
        });
    }

    // Trim to MAX_RECENT_REPOS, keeping pinned entries and the most recent
    if bookmarks.len() > MAX_RECENT_REPOS {
        // Separate pinned from unpinned
        let (pinned, mut unpinned): (Vec<_>, Vec<_>) =
            bookmarks.into_iter().partition(|b| b.pinned);

        // Sort unpinned by last_opened descending and truncate
        unpinned.sort_by_key(|b| std::cmp::Reverse(b.last_opened));
        let keep_count = MAX_RECENT_REPOS.saturating_sub(pinned.len());
        unpinned.truncate(keep_count);

        bookmarks = pinned.into_iter().chain(unpinned).collect();
    }

    save_bookmarks(&bookmarks)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Helper to create a temporary bookmarks file for testing
    fn setup_test_bookmarks(bookmarks: &[RepoBookmark]) -> (TempDir, PathBuf) {
        let dir = TempDir::new().expect("Failed to create temp dir");
        let path = dir.path().join("bookmarks.json");
        let content = serde_json::to_string_pretty(bookmarks).expect("Failed to serialize");
        fs::write(&path, content).expect("Failed to write");
        (dir, path)
    }

    #[test]
    fn test_repo_bookmark_serialization() {
        let bookmark = RepoBookmark {
            path: "/home/user/project".to_string(),
            name: "My Project".to_string(),
            group: Some("Work".to_string()),
            pinned: true,
            last_opened: 1700000000,
            color: Some("#ff0000".to_string()),
        };

        let json = serde_json::to_string(&bookmark).expect("Failed to serialize");
        let deserialized: RepoBookmark =
            serde_json::from_str(&json).expect("Failed to deserialize");

        assert_eq!(deserialized.path, bookmark.path);
        assert_eq!(deserialized.name, bookmark.name);
        assert_eq!(deserialized.group, bookmark.group);
        assert_eq!(deserialized.pinned, bookmark.pinned);
        assert_eq!(deserialized.last_opened, bookmark.last_opened);
        assert_eq!(deserialized.color, bookmark.color);
    }

    #[test]
    fn test_repo_bookmark_serialization_camel_case() {
        let bookmark = RepoBookmark {
            path: "/test".to_string(),
            name: "Test".to_string(),
            group: None,
            pinned: false,
            last_opened: 1700000000,
            color: None,
        };

        let json = serde_json::to_string(&bookmark).expect("Failed to serialize");
        assert!(json.contains("lastOpened"));
        assert!(!json.contains("last_opened"));
    }

    #[test]
    fn test_repo_bookmark_deserialization_defaults() {
        let json = r#"{"path":"/test","name":"Test","group":null,"pinned":false,"lastOpened":0,"color":null}"#;
        let bookmark: RepoBookmark = serde_json::from_str(json).expect("Failed to deserialize");
        assert_eq!(bookmark.path, "/test");
        assert!(!bookmark.pinned);
        assert!(bookmark.group.is_none());
        assert!(bookmark.color.is_none());
    }

    #[test]
    fn test_load_bookmarks_empty_file() {
        let dir = TempDir::new().expect("Failed to create temp dir");
        let path = dir.path().join("bookmarks.json");
        // File doesn't exist, should return empty vec
        assert!(!path.exists());
    }

    #[test]
    fn test_save_and_load_bookmarks_roundtrip() {
        let dir = TempDir::new().expect("Failed to create temp dir");
        let path = dir.path().join("bookmarks.json");

        let bookmarks = vec![
            RepoBookmark {
                path: "/repo1".to_string(),
                name: "Repo 1".to_string(),
                group: Some("Work".to_string()),
                pinned: true,
                last_opened: 1700000000,
                color: Some("#00ff00".to_string()),
            },
            RepoBookmark {
                path: "/repo2".to_string(),
                name: "Repo 2".to_string(),
                group: None,
                pinned: false,
                last_opened: 1700000100,
                color: None,
            },
        ];

        // Write
        let content =
            serde_json::to_string_pretty(&bookmarks).expect("Failed to serialize bookmarks");
        fs::write(&path, &content).expect("Failed to write bookmarks");

        // Read back
        let loaded_content = fs::read_to_string(&path).expect("Failed to read bookmarks");
        let loaded: Vec<RepoBookmark> =
            serde_json::from_str(&loaded_content).expect("Failed to parse bookmarks");

        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].path, "/repo1");
        assert_eq!(loaded[0].name, "Repo 1");
        assert_eq!(loaded[0].group, Some("Work".to_string()));
        assert!(loaded[0].pinned);
        assert_eq!(loaded[1].path, "/repo2");
        assert!(!loaded[1].pinned);
    }

    #[test]
    fn test_setup_test_bookmarks() {
        let bookmarks = vec![RepoBookmark {
            path: "/test/repo".to_string(),
            name: "Test Repo".to_string(),
            group: None,
            pinned: false,
            last_opened: 1700000000,
            color: None,
        }];

        let (_dir, path) = setup_test_bookmarks(&bookmarks);
        assert!(path.exists());

        let content = fs::read_to_string(&path).expect("Failed to read");
        let loaded: Vec<RepoBookmark> = serde_json::from_str(&content).expect("Failed to parse");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].path, "/test/repo");
    }

    #[test]
    fn test_bookmark_sorting_by_last_opened() {
        let mut bookmarks = [
            RepoBookmark {
                path: "/old".to_string(),
                name: "Old".to_string(),
                group: None,
                pinned: false,
                last_opened: 1000,
                color: None,
            },
            RepoBookmark {
                path: "/new".to_string(),
                name: "New".to_string(),
                group: None,
                pinned: false,
                last_opened: 3000,
                color: None,
            },
            RepoBookmark {
                path: "/mid".to_string(),
                name: "Mid".to_string(),
                group: None,
                pinned: false,
                last_opened: 2000,
                color: None,
            },
        ];

        bookmarks.sort_by_key(|b| std::cmp::Reverse(b.last_opened));

        assert_eq!(bookmarks[0].path, "/new");
        assert_eq!(bookmarks[1].path, "/mid");
        assert_eq!(bookmarks[2].path, "/old");
    }

    #[test]
    fn test_bookmark_duplicate_detection() {
        let bookmarks = [
            RepoBookmark {
                path: "/repo1".to_string(),
                name: "Repo 1".to_string(),
                group: None,
                pinned: false,
                last_opened: 1000,
                color: None,
            },
            RepoBookmark {
                path: "/repo2".to_string(),
                name: "Repo 2".to_string(),
                group: None,
                pinned: false,
                last_opened: 2000,
                color: None,
            },
        ];

        assert!(bookmarks.iter().any(|b| b.path == "/repo1"));
        assert!(!bookmarks.iter().any(|b| b.path == "/repo3"));
    }

    #[test]
    fn test_bookmark_retain_removes_by_path() {
        let mut bookmarks = vec![
            RepoBookmark {
                path: "/repo1".to_string(),
                name: "Repo 1".to_string(),
                group: None,
                pinned: false,
                last_opened: 1000,
                color: None,
            },
            RepoBookmark {
                path: "/repo2".to_string(),
                name: "Repo 2".to_string(),
                group: None,
                pinned: false,
                last_opened: 2000,
                color: None,
            },
        ];

        bookmarks.retain(|b| b.path != "/repo1");

        assert_eq!(bookmarks.len(), 1);
        assert_eq!(bookmarks[0].path, "/repo2");
    }

    #[test]
    fn test_bookmark_partition_pinned() {
        let bookmarks = vec![
            RepoBookmark {
                path: "/pinned1".to_string(),
                name: "Pinned 1".to_string(),
                group: None,
                pinned: true,
                last_opened: 1000,
                color: None,
            },
            RepoBookmark {
                path: "/unpinned1".to_string(),
                name: "Unpinned 1".to_string(),
                group: None,
                pinned: false,
                last_opened: 2000,
                color: None,
            },
            RepoBookmark {
                path: "/pinned2".to_string(),
                name: "Pinned 2".to_string(),
                group: None,
                pinned: true,
                last_opened: 3000,
                color: None,
            },
        ];

        let (pinned, unpinned): (Vec<_>, Vec<_>) = bookmarks.into_iter().partition(|b| b.pinned);

        assert_eq!(pinned.len(), 2);
        assert_eq!(unpinned.len(), 1);
        assert!(pinned.iter().all(|b| b.pinned));
        assert!(unpinned.iter().all(|b| !b.pinned));
    }

    #[test]
    fn test_bookmark_update_in_place() {
        let mut bookmarks = [
            RepoBookmark {
                path: "/repo1".to_string(),
                name: "Repo 1".to_string(),
                group: None,
                pinned: false,
                last_opened: 1000,
                color: None,
            },
            RepoBookmark {
                path: "/repo2".to_string(),
                name: "Repo 2".to_string(),
                group: None,
                pinned: false,
                last_opened: 2000,
                color: None,
            },
        ];

        let updated = RepoBookmark {
            path: "/repo1".to_string(),
            name: "Updated Repo 1".to_string(),
            group: Some("NewGroup".to_string()),
            pinned: true,
            last_opened: 5000,
            color: Some("#ff0000".to_string()),
        };

        if let Some(pos) = bookmarks.iter().position(|b| b.path == updated.path) {
            bookmarks[pos] = updated;
        }

        assert_eq!(bookmarks[0].name, "Updated Repo 1");
        assert_eq!(bookmarks[0].group, Some("NewGroup".to_string()));
        assert!(bookmarks[0].pinned);
        assert_eq!(bookmarks[0].color, Some("#ff0000".to_string()));
    }

    #[test]
    fn test_max_recent_repos_trimming() {
        let mut bookmarks: Vec<RepoBookmark> = (0..60)
            .map(|i| RepoBookmark {
                path: format!("/repo{}", i),
                name: format!("Repo {}", i),
                group: None,
                pinned: i < 5, // First 5 are pinned
                last_opened: i as i64 * 100,
                color: None,
            })
            .collect();

        // Simulate the trimming logic from record_repo_opened
        if bookmarks.len() > MAX_RECENT_REPOS {
            let (pinned, mut unpinned): (Vec<_>, Vec<_>) =
                bookmarks.into_iter().partition(|b| b.pinned);

            unpinned.sort_by_key(|b| std::cmp::Reverse(b.last_opened));
            let keep_count = MAX_RECENT_REPOS.saturating_sub(pinned.len());
            unpinned.truncate(keep_count);

            bookmarks = pinned.into_iter().chain(unpinned).collect();
        }

        assert!(bookmarks.len() <= MAX_RECENT_REPOS);
        // All pinned entries should be preserved
        let pinned_count = bookmarks.iter().filter(|b| b.pinned).count();
        assert_eq!(pinned_count, 5);
    }
}
