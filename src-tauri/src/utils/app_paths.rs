//! Application directory paths for Gitnado.
//!
//! Every on-disk location that embeds the app name — the user-level config and
//! data directories and the per-repository `<gitdir>/<app>` folder — resolves
//! through this module.

use std::path::{Path, PathBuf};

use crate::error::{GitnadoError, Result};

/// Directory name under the platform config/data roots and inside a git dir.
pub const APP_DIR_NAME: &str = "gitnado";

/// The bundle identifier the app ships with.
pub const APP_IDENTIFIER: &str = "io.github.hegsie.gitnado";

/// `base/gitnado`. Does not create the directory.
pub fn app_subdir(base: &Path) -> PathBuf {
    base.join(APP_DIR_NAME)
}

/// The app's private directory inside a repository's git dir (`<gitdir>/gitnado`).
/// Pass the *common* dir for state that should be shared by every worktree of
/// the repository. Does not create the directory.
pub fn repo_dir(git_dir: &Path) -> PathBuf {
    app_subdir(git_dir)
}

/// The user-level config directory (`<config root>/gitnado`), created if missing.
pub fn config_dir() -> Result<PathBuf> {
    let root = dirs::config_dir().ok_or_else(|| {
        GitnadoError::OperationFailed("Could not find config directory".to_string())
    })?;
    ensure_app_subdir(&root, "config")
}

/// The user-level data directory (`<data root>/gitnado`), created if missing.
pub fn data_dir() -> Result<PathBuf> {
    let root = dirs::data_dir().ok_or_else(|| {
        GitnadoError::OperationFailed("Could not find data directory".to_string())
    })?;
    ensure_app_subdir(&root, "app")
}

fn ensure_app_subdir(root: &Path, what: &str) -> Result<PathBuf> {
    let dir = app_subdir(root);
    std::fs::create_dir_all(&dir).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to create {} directory: {}", what, e))
    })?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn the_shipped_identifier_matches_the_bundle() {
        let config = include_str!("../../tauri.conf.json");
        let needle = format!("\"identifier\": \"{APP_IDENTIFIER}\"");
        assert!(
            config.contains(&needle),
            "tauri.conf.json does not declare {APP_IDENTIFIER}"
        );
    }

    #[test]
    fn app_subdir_returns_gitnado_path_without_creating_it() {
        let base = TempDir::new().unwrap();
        let dir = app_subdir(base.path());
        assert_eq!(dir, base.path().join("gitnado"));
        assert!(!dir.exists(), "resolving a path must not create it");
    }

    #[test]
    fn repo_dir_returns_gitnado_folder_inside_git_dir() {
        let repo = crate::test_utils::TestRepo::new();
        let git_dir = repo.repo().path().to_path_buf();
        let dir = repo_dir(&git_dir);
        assert_eq!(dir, git_dir.join("gitnado"));
    }

    #[test]
    fn ensure_app_subdir_creates_directory() {
        let fresh = TempDir::new().unwrap();
        let dir = ensure_app_subdir(fresh.path(), "app").unwrap();
        assert_eq!(dir, fresh.path().join("gitnado"));
        assert!(dir.is_dir());
    }
}
