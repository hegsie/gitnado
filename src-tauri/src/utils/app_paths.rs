//! Application directory names, and adoption of the directories the app wrote
//! under its previous name.
//!
//! The app was called Leviathan until 0.9.0. Every on-disk location that embeds
//! the app name — the user-level config and data directories, the Tauri
//! identifier directories, and the per-repository `<gitdir>/<app>` folder —
//! resolves through this module, so an existing installation keeps its
//! settings, profiles, downloaded models and repo-level rules: the first time
//! a `gitnado` directory is wanted and only the `leviathan` one exists, the old
//! directory is renamed into place. When both exist a newer version has
//! already run and the old directory is left alone.

use std::path::{Path, PathBuf};

use crate::error::{GitnadoError, Result};

/// Directory name under the platform config/data roots and inside a git dir.
pub const APP_DIR_NAME: &str = "gitnado";
/// The directory name used before the rename; only ever read, never written.
pub const LEGACY_APP_DIR_NAME: &str = "leviathan";
/// The bundle identifier before the rename. Tauri's `app_config_dir` /
/// `app_data_dir` are named after the identifier, so the old one is the
/// sibling of the current one.
pub const LEGACY_APP_IDENTIFIER: &str = "io.github.hegsie.leviathan";

/// Rename `legacy` to `current` when only `legacy` exists.
///
/// Returns `current` either way. A rename that fails (permissions, a file where
/// the directory should be) is logged and `current` is used fresh rather than
/// failing the caller: losing old settings is recoverable, refusing to start is
/// not.
fn adopt_legacy_dir(legacy: &Path, current: &Path) -> PathBuf {
    if !current.exists() && legacy.is_dir() {
        match std::fs::rename(legacy, current) {
            Ok(()) => tracing::info!(
                "Adopted legacy directory {} as {}",
                legacy.display(),
                current.display()
            ),
            Err(e) => tracing::warn!(
                "Could not adopt legacy directory {} as {}: {}",
                legacy.display(),
                current.display(),
                e
            ),
        }
    }
    current.to_path_buf()
}

/// `base/gitnado`, adopting `base/leviathan` if that is all there is.
/// Does not create the directory.
pub fn app_subdir(base: &Path) -> PathBuf {
    adopt_legacy_dir(&base.join(LEGACY_APP_DIR_NAME), &base.join(APP_DIR_NAME))
}

/// The app's private directory inside a repository's git dir
/// (`<gitdir>/gitnado`), adopting `<gitdir>/leviathan`. Pass the *common* dir
/// for state that should be shared by every worktree of the repository.
/// Does not create the directory.
pub fn repo_dir(git_dir: &Path) -> PathBuf {
    app_subdir(git_dir)
}

/// For a Tauri identifier directory (`app_config_dir()` / `app_data_dir()`),
/// adopt the sibling named after the previous identifier. Returns `current`.
pub fn adopt_legacy_identifier_dir(current: &Path) -> PathBuf {
    match current.parent() {
        Some(parent) if current.file_name().is_some() => {
            adopt_legacy_dir(&parent.join(LEGACY_APP_IDENTIFIER), current)
        }
        _ => current.to_path_buf(),
    }
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
    fn app_subdir_returns_new_name_when_nothing_exists() {
        let base = TempDir::new().unwrap();
        let dir = app_subdir(base.path());
        assert_eq!(dir, base.path().join("gitnado"));
        assert!(!dir.exists(), "resolving a path must not create it");
        assert!(!base.path().join("leviathan").exists());
    }

    #[test]
    fn app_subdir_adopts_legacy_directory_with_its_contents() {
        let base = TempDir::new().unwrap();
        let legacy = base.path().join("leviathan");
        std::fs::create_dir_all(legacy.join("nested")).unwrap();
        std::fs::write(legacy.join("profiles.json"), "{}").unwrap();

        let dir = app_subdir(base.path());

        assert_eq!(dir, base.path().join("gitnado"));
        assert_eq!(
            std::fs::read_to_string(dir.join("profiles.json")).unwrap(),
            "{}"
        );
        assert!(dir.join("nested").is_dir());
        assert!(
            !legacy.exists(),
            "the legacy directory is moved, not copied"
        );
    }

    #[test]
    fn app_subdir_leaves_both_alone_when_new_already_exists() {
        let base = TempDir::new().unwrap();
        let legacy = base.path().join("leviathan");
        let current = base.path().join("gitnado");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::create_dir_all(&current).unwrap();
        std::fs::write(legacy.join("old.json"), "old").unwrap();
        std::fs::write(current.join("new.json"), "new").unwrap();

        let dir = app_subdir(base.path());

        assert_eq!(dir, current);
        assert!(legacy.join("old.json").exists());
        assert!(current.join("new.json").exists());
        assert!(!current.join("old.json").exists());
    }

    #[test]
    fn app_subdir_is_idempotent() {
        let base = TempDir::new().unwrap();
        std::fs::create_dir_all(base.path().join("leviathan")).unwrap();
        let first = app_subdir(base.path());
        let second = app_subdir(base.path());
        assert_eq!(first, second);
        assert!(first.is_dir());
    }

    #[test]
    fn app_subdir_ignores_a_legacy_file_that_is_not_a_directory() {
        let base = TempDir::new().unwrap();
        std::fs::write(base.path().join("leviathan"), "not a dir").unwrap();
        let dir = app_subdir(base.path());
        assert_eq!(dir, base.path().join("gitnado"));
        assert!(!dir.exists());
        assert!(base.path().join("leviathan").is_file());
    }

    #[test]
    fn repo_dir_adopts_legacy_folder_inside_git_dir() {
        let repo = crate::test_utils::TestRepo::new();
        let git_dir = repo.repo().path().to_path_buf();
        let legacy = git_dir.join("leviathan");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("branch_rules.json"), "[]").unwrap();

        let dir = repo_dir(&git_dir);

        assert_eq!(dir, git_dir.join("gitnado"));
        assert_eq!(
            std::fs::read_to_string(dir.join("branch_rules.json")).unwrap(),
            "[]"
        );
        assert!(!legacy.exists());
    }

    #[test]
    fn adopt_legacy_identifier_dir_renames_sibling() {
        let root = TempDir::new().unwrap();
        let legacy = root.path().join("io.github.hegsie.leviathan");
        std::fs::create_dir_all(legacy.join("models")).unwrap();
        std::fs::write(legacy.join("models").join("m.gguf"), "weights").unwrap();
        let current = root.path().join("io.github.hegsie.gitnado");

        let dir = adopt_legacy_identifier_dir(&current);

        assert_eq!(dir, current);
        assert!(current.join("models").join("m.gguf").exists());
        assert!(!legacy.exists());
    }

    #[test]
    fn adopt_legacy_identifier_dir_keeps_existing_current() {
        let root = TempDir::new().unwrap();
        let legacy = root.path().join("io.github.hegsie.leviathan");
        let current = root.path().join("io.github.hegsie.gitnado");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::create_dir_all(&current).unwrap();

        adopt_legacy_identifier_dir(&current);

        assert!(legacy.exists());
        assert!(current.exists());
    }

    #[test]
    fn adopt_legacy_identifier_dir_tolerates_paths_without_parent() {
        // Tauri returns an empty path when the platform dir cannot be resolved;
        // that must not panic or touch the filesystem.
        assert_eq!(
            adopt_legacy_identifier_dir(Path::new("")),
            PathBuf::from("")
        );
        assert_eq!(
            adopt_legacy_identifier_dir(Path::new("/")),
            PathBuf::from("/")
        );
    }

    #[test]
    fn ensure_app_subdir_creates_and_adopts() {
        let root = TempDir::new().unwrap();
        std::fs::create_dir_all(root.path().join("leviathan")).unwrap();
        std::fs::write(root.path().join("leviathan").join("w.json"), "w").unwrap();

        let dir = ensure_app_subdir(root.path(), "config").unwrap();

        assert_eq!(dir, root.path().join("gitnado"));
        assert!(dir.join("w.json").exists());

        // Fresh root: created from nothing.
        let fresh = TempDir::new().unwrap();
        let dir = ensure_app_subdir(fresh.path(), "app").unwrap();
        assert!(dir.is_dir());
    }
}
