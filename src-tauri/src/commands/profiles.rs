//! Git profile command handlers
//! Manage git identity profiles for easy switching between different identities

use std::fs;
use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::models::{GitProfile, ProfilesConfig};
use crate::utils::create_command;

/// Get the path to the profiles config file
fn get_profiles_path() -> Result<std::path::PathBuf> {
    Ok(crate::utils::app_paths::config_dir()?.join("profiles.json"))
}

/// Load profiles config from disk
fn load_profiles_config() -> Result<ProfilesConfig> {
    let path = get_profiles_path()?;

    if !path.exists() {
        return Ok(ProfilesConfig::default());
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to read profiles: {}", e)))?;

    let config: ProfilesConfig = serde_json::from_str(&content)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse profiles: {}", e)))?;

    Ok(config)
}

/// Save profiles config to disk
fn save_profiles_config(config: &ProfilesConfig) -> Result<()> {
    let path = get_profiles_path()?;

    let content = serde_json::to_string_pretty(config).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to serialize profiles: {}", e))
    })?;

    fs::write(&path, content)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to write profiles: {}", e)))?;

    Ok(())
}

/// Run git config command
fn run_git_config(repo_path: Option<&Path>, args: &[&str]) -> Result<String> {
    let mut cmd = create_command("git");

    if let Some(path) = repo_path {
        cmd.current_dir(path);
    }

    cmd.arg("config");
    cmd.args(args);

    let output = cmd
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run git config: {}", e)))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        Ok(stdout)
    } else if output.status.code() == Some(1) && stderr.is_empty() && stdout.is_empty() {
        Ok(String::new())
    } else {
        Err(GitnadoError::OperationFailed(if stderr.is_empty() {
            stdout
        } else {
            stderr
        }))
    }
}

/// Get all saved profiles
#[command]
pub async fn get_profiles() -> Result<Vec<GitProfile>> {
    let config = load_profiles_config()?;
    Ok(config.profiles)
}

/// Get profiles config including repository assignments
#[command]
pub async fn get_profiles_config() -> Result<ProfilesConfig> {
    load_profiles_config()
}

/// Save a profile (create or update)
#[command]
pub async fn save_profile(profile: GitProfile) -> Result<GitProfile> {
    let mut config = load_profiles_config()?;

    // If this profile is set as default, unset other defaults
    if profile.is_default {
        for p in &mut config.profiles {
            p.is_default = false;
        }
    }

    // Check if profile exists (update) or is new (create)
    if let Some(idx) = config.profiles.iter().position(|p| p.id == profile.id) {
        config.profiles[idx] = profile.clone();
    } else {
        config.profiles.push(profile.clone());
    }

    save_profiles_config(&config)?;
    Ok(profile)
}

/// Delete a profile
#[command]
pub async fn delete_profile(profile_id: String) -> Result<()> {
    let mut config = load_profiles_config()?;

    // Remove the profile
    config.profiles.retain(|p| p.id != profile_id);

    // Remove any repository assignments for this profile
    config
        .repository_assignments
        .retain(|_, v| *v != profile_id);

    save_profiles_config(&config)?;
    Ok(())
}

/// Apply a profile to a repository (set git config)
#[command]
pub async fn apply_profile(path: String, profile_id: String) -> Result<()> {
    let config = load_profiles_config()?;

    let profile = config
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| GitnadoError::OperationFailed("Profile not found".to_string()))?;

    let repo_path = Path::new(&path);

    // Set user.name
    run_git_config(
        Some(repo_path),
        &["--local", "user.name", &profile.git_name],
    )?;

    // Set user.email
    run_git_config(
        Some(repo_path),
        &["--local", "user.email", &profile.git_email],
    )?;

    // Set signing key if specified
    if let Some(ref signing_key) = profile.signing_key {
        if !signing_key.is_empty() {
            run_git_config(
                Some(repo_path),
                &["--local", "user.signingkey", signing_key],
            )?;
            run_git_config(Some(repo_path), &["--local", "commit.gpgsign", "true"])?;
        }
    } else {
        // Unset signing key if not specified
        let _ = run_git_config(Some(repo_path), &["--local", "--unset", "user.signingkey"]);
        let _ = run_git_config(Some(repo_path), &["--local", "--unset", "commit.gpgsign"]);
    }

    // Save the assignment
    let mut updated_config = config.clone();
    updated_config
        .repository_assignments
        .insert(path, profile_id);
    save_profiles_config(&updated_config)?;

    Ok(())
}

/// Detect which profile should be used for a repository based on URL patterns
#[command]
pub async fn detect_profile_for_repository(path: String) -> Result<Option<GitProfile>> {
    let config = load_profiles_config()?;
    let repo_path = Path::new(&path);

    // Get the remote URL
    let remote_url =
        run_git_config(Some(repo_path), &["--get", "remote.origin.url"]).unwrap_or_default();

    if remote_url.is_empty() {
        // Check for other remotes
        let remotes = run_git_config(Some(repo_path), &["--get-regexp", "^remote\\..*\\.url"])
            .unwrap_or_default();

        if remotes.is_empty() {
            // No remotes, try to find a matching profile or return default
            return Ok(config.profiles.iter().find(|p| p.is_default).cloned());
        }

        // Get the first remote URL
        if let Some(line) = remotes.lines().next() {
            let parts: Vec<&str> = line.splitn(2, ' ').collect();
            if parts.len() == 2 {
                let url = parts[1];

                // Find matching profile
                if let Some(profile) = config.profiles.iter().find(|p| p.matches_url(url)) {
                    return Ok(Some(profile.clone()));
                }
            }
        }
    } else {
        // Find matching profile
        if let Some(profile) = config.profiles.iter().find(|p| p.matches_url(&remote_url)) {
            return Ok(Some(profile.clone()));
        }
    }

    // Return default profile if no match
    Ok(config.profiles.iter().find(|p| p.is_default).cloned())
}

/// Get the assigned profile for a repository
#[command]
pub async fn get_assigned_profile(path: String) -> Result<Option<GitProfile>> {
    let config = load_profiles_config()?;

    // Check if there's a manual assignment
    if let Some(profile_id) = config.repository_assignments.get(&path) {
        if let Some(profile) = config.profiles.iter().find(|p| &p.id == profile_id) {
            return Ok(Some(profile.clone()));
        }
    }

    // Try auto-detection
    detect_profile_for_repository(path).await
}

/// Manually assign a profile to a repository (without applying git config)
#[command]
pub async fn assign_profile_to_repository(path: String, profile_id: String) -> Result<()> {
    let mut config = load_profiles_config()?;
    config.repository_assignments.insert(path, profile_id);
    save_profiles_config(&config)?;
    Ok(())
}

/// Remove profile assignment from a repository
#[command]
pub async fn unassign_profile_from_repository(path: String) -> Result<()> {
    let mut config = load_profiles_config()?;
    config.repository_assignments.remove(&path);
    save_profiles_config(&config)?;
    Ok(())
}

/// Get the current git identity for a repository
#[command]
pub async fn get_current_identity(path: String) -> Result<CurrentIdentity> {
    let repo_path = Path::new(&path);

    let name = run_git_config(Some(repo_path), &["--get", "user.name"]).ok();
    let email = run_git_config(Some(repo_path), &["--get", "user.email"]).ok();
    let signing_key = run_git_config(Some(repo_path), &["--get", "user.signingkey"]).ok();

    Ok(CurrentIdentity {
        name: name.filter(|s| !s.is_empty()),
        email: email.filter(|s| !s.is_empty()),
        signing_key: signing_key.filter(|s| !s.is_empty()),
    })
}

/// Current git identity for a repository
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
    pub signing_key: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_profile_creation() {
        let profile = GitProfile::new(
            "Test".to_string(),
            "Test User".to_string(),
            "test@example.com".to_string(),
        );

        assert_eq!(profile.name, "Test");
        assert_eq!(profile.git_name, "Test User");
        assert_eq!(profile.git_email, "test@example.com");
        assert!(!profile.is_default);
        assert!(profile.url_patterns.is_empty());
    }
}
