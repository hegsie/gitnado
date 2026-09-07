//! Git service for managing repository state

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use crate::error::{GitnadoError, Result};

/// Service for managing git repository state
pub struct GitService {
    current_repo_path: Arc<RwLock<Option<PathBuf>>>,
}

impl GitService {
    /// Create a new GitService
    pub fn new() -> Self {
        Self {
            current_repo_path: Arc::new(RwLock::new(None)),
        }
    }

    /// Set the current repository path
    pub fn set_current_repo(&self, path: &Path) -> Result<()> {
        let mut current = self
            .current_repo_path
            .write()
            .map_err(|_| GitnadoError::OperationFailed("Lock poisoned".to_string()))?;
        *current = Some(path.to_path_buf());
        Ok(())
    }

    /// Get the current repository path
    pub fn get_current_repo(&self) -> Result<Option<PathBuf>> {
        let current = self
            .current_repo_path
            .read()
            .map_err(|_| GitnadoError::OperationFailed("Lock poisoned".to_string()))?;
        Ok(current.clone())
    }

    /// Clear the current repository
    pub fn clear_current_repo(&self) -> Result<()> {
        let mut current = self
            .current_repo_path
            .write()
            .map_err(|_| GitnadoError::OperationFailed("Lock poisoned".to_string()))?;
        *current = None;
        Ok(())
    }

    /// Check if a path is a valid git repository
    pub fn is_valid_repo(path: &Path) -> bool {
        git2::Repository::open(path).is_ok()
    }

    /// Find the repository root from a given path
    pub fn find_repo_root(path: &Path) -> Option<PathBuf> {
        git2::Repository::discover(path)
            .ok()
            .map(|repo| repo.workdir().unwrap_or(repo.path()).to_path_buf())
    }
}

impl Default for GitService {
    fn default() -> Self {
        Self::new()
    }
}
