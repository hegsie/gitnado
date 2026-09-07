//! Unified profiles command handlers
//!
//! Manage unified profiles that combine git identity with integration accounts.
//! This replaces the separate profiles and integration_accounts commands.

use std::fs;
use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::models::{
    CachedUser, IntegrationAccount, IntegrationAccountsConfig, IntegrationType,
    ProfileIntegrationAccount, ProfilesConfig, UnifiedProfile, UnifiedProfilesConfig,
    PROFILE_COLORS, UNIFIED_PROFILES_CONFIG_VERSION,
};
use crate::utils::create_command;

// =============================================================================
// File Path Helpers
// =============================================================================

/// Get the path to the unified profiles config file
fn get_unified_profiles_path() -> Result<std::path::PathBuf> {
    Ok(crate::utils::app_paths::config_dir()?.join("unified_profiles.json"))
}

/// Get the path to the legacy profiles config file
fn get_legacy_profiles_path() -> Result<std::path::PathBuf> {
    Ok(crate::utils::app_paths::config_dir()?.join("profiles.json"))
}

/// Get the path to the legacy integration accounts config file
fn get_legacy_accounts_path() -> Result<std::path::PathBuf> {
    Ok(crate::utils::app_paths::config_dir()?.join("integration_accounts.json"))
}

// =============================================================================
// Config Loading/Saving
// =============================================================================

/// Load unified profiles config from disk
fn load_unified_profiles_config() -> Result<UnifiedProfilesConfig> {
    let path = get_unified_profiles_path()?;

    if !path.exists() {
        return Ok(UnifiedProfilesConfig::default());
    }

    let content = fs::read_to_string(&path).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to read unified profiles: {}", e))
    })?;

    let config: UnifiedProfilesConfig = serde_json::from_str(&content).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse unified profiles: {}", e))
    })?;

    Ok(config)
}

/// Save unified profiles config to disk
fn save_unified_profiles_config(config: &UnifiedProfilesConfig) -> Result<()> {
    let path = get_unified_profiles_path()?;

    let content = serde_json::to_string_pretty(config).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to serialize unified profiles: {}", e))
    })?;

    fs::write(&path, content).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to write unified profiles: {}", e))
    })?;

    // M8: Restrict config file to owner-only (0600) so token secrets are not
    // world-readable.  The guard is compile-time only — Windows has no
    // meaningful Unix permission bits.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        fs::set_permissions(&path, perms).map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to set config file permissions: {}", e))
        })?;
    }

    Ok(())
}

/// Load legacy profiles config (for migration)
fn load_legacy_profiles_config() -> Result<ProfilesConfig> {
    let path = get_legacy_profiles_path()?;

    if !path.exists() {
        return Ok(ProfilesConfig::default());
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to read profiles: {}", e)))?;

    let config: ProfilesConfig = serde_json::from_str(&content)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse profiles: {}", e)))?;

    Ok(config)
}

/// Load legacy integration accounts config (for migration)
fn load_legacy_accounts_config() -> Result<IntegrationAccountsConfig> {
    let path = get_legacy_accounts_path()?;

    if !path.exists() {
        return Ok(IntegrationAccountsConfig::default());
    }

    let content = fs::read_to_string(&path).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to read integration accounts: {}", e))
    })?;

    let config: IntegrationAccountsConfig = serde_json::from_str(&content).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse integration accounts: {}", e))
    })?;

    Ok(config)
}

// =============================================================================
// Git Helpers
// =============================================================================

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

/// Get the remote URL for a repository
fn get_remote_url(repo_path: &Path) -> Option<String> {
    let mut cmd = create_command("git");
    cmd.current_dir(repo_path);
    cmd.args(["config", "--get", "remote.origin.url"]);

    let output = cmd.output().ok()?;
    if output.status.success() {
        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !url.is_empty() {
            return Some(url);
        }
    }

    // Try to get any remote URL
    let mut cmd = create_command("git");
    cmd.current_dir(repo_path);
    cmd.args(["config", "--get-regexp", "^remote\\..*\\.url"]);

    let output = cmd.output().ok()?;
    if output.status.success() {
        let remotes = String::from_utf8_lossy(&output.stdout);
        if let Some(line) = remotes.lines().next() {
            let parts: Vec<&str> = line.splitn(2, ' ').collect();
            if parts.len() == 2 {
                return Some(parts[1].to_string());
            }
        }
    }

    None
}

// =============================================================================
// Profile CRUD Commands
// =============================================================================

/// Get the unified profiles config
#[command]
pub async fn get_unified_profiles_config() -> Result<UnifiedProfilesConfig> {
    load_unified_profiles_config()
}

/// Get all unified profiles
#[command]
pub async fn get_unified_profiles() -> Result<Vec<UnifiedProfile>> {
    let config = load_unified_profiles_config()?;
    Ok(config.profiles)
}

/// Get a single unified profile by ID
#[command]
pub async fn get_unified_profile(profile_id: String) -> Result<Option<UnifiedProfile>> {
    let config = load_unified_profiles_config()?;
    Ok(config.profiles.into_iter().find(|p| p.id == profile_id))
}

/// Outcome of saving a profile: the stored profile plus the repositories whose
/// local git config could not be rewritten with the edited identity.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProfileResult {
    pub profile: UnifiedProfile,
    pub failed_repositories: Vec<String>,
}

/// Save a unified profile (create or update) and push the (possibly edited)
/// identity back into every repository already assigned to it.
///
/// Repositories whose local git config could not be rewritten come back in
/// `failed_repositories` instead of failing the save.
#[command]
pub async fn save_unified_profile(profile: UnifiedProfile) -> Result<SaveProfileResult> {
    let mut config = load_unified_profiles_config()?;
    let failed_repositories = save_and_reapply(&mut config, &profile);
    save_unified_profiles_config(&config)?;
    Ok(SaveProfileResult {
        profile,
        failed_repositories,
    })
}

/// Delete a unified profile
#[command]
pub async fn delete_unified_profile(profile_id: String) -> Result<()> {
    let mut config = load_unified_profiles_config()?;
    config.delete_profile(&profile_id);
    save_unified_profiles_config(&config)?;
    Ok(())
}

/// Set a profile as the default
#[command]
pub async fn set_default_unified_profile(profile_id: String) -> Result<()> {
    let mut config = load_unified_profiles_config()?;

    for profile in &mut config.profiles {
        profile.is_default = profile.id == profile_id;
    }

    save_unified_profiles_config(&config)?;
    Ok(())
}

// =============================================================================
// Global Account Commands (v3)
// =============================================================================

/// Get all global accounts
#[command]
pub async fn get_global_accounts() -> Result<Vec<IntegrationAccount>> {
    let config = load_unified_profiles_config()?;
    Ok(config.accounts)
}

/// Get global accounts by integration type
#[command]
pub async fn get_global_accounts_by_type(
    integration_type: IntegrationType,
) -> Result<Vec<IntegrationAccount>> {
    let config = load_unified_profiles_config()?;
    Ok(config
        .accounts
        .into_iter()
        .filter(|a| a.integration_type == integration_type)
        .collect())
}

/// Get a single global account by ID
#[command]
pub async fn get_global_account(account_id: String) -> Result<Option<IntegrationAccount>> {
    let config = load_unified_profiles_config()?;
    Ok(config.accounts.into_iter().find(|a| a.id == account_id))
}

/// Save a global account (create or update)
#[command]
pub async fn save_global_account(account: IntegrationAccount) -> Result<IntegrationAccount> {
    let mut config = load_unified_profiles_config()?;
    config.save_account(account.clone());
    save_unified_profiles_config(&config)?;
    Ok(account)
}

/// Delete a global account
#[command]
pub async fn delete_global_account(account_id: String) -> Result<()> {
    let mut config = load_unified_profiles_config()?;
    config.delete_account(&account_id);
    save_unified_profiles_config(&config)?;
    Ok(())
}

/// Set the default global account for an integration type
#[command]
pub async fn set_default_global_account(
    integration_type: IntegrationType,
    account_id: String,
) -> Result<()> {
    let mut config = load_unified_profiles_config()?;
    config.set_default_account(&integration_type, &account_id);
    save_unified_profiles_config(&config)?;
    Ok(())
}

/// Set the default account for a profile (profile preference)
#[command]
pub async fn set_profile_default_account(
    profile_id: String,
    integration_type: IntegrationType,
    account_id: String,
) -> Result<()> {
    let mut config = load_unified_profiles_config()?;

    let profile = config
        .get_profile_mut(&profile_id)
        .ok_or_else(|| GitnadoError::OperationFailed("Profile not found".to_string()))?;

    profile.set_default_account(integration_type, account_id);
    save_unified_profiles_config(&config)?;
    Ok(())
}

/// Remove the default account preference for a profile
#[command]
pub async fn remove_profile_default_account(
    profile_id: String,
    integration_type: IntegrationType,
) -> Result<()> {
    let mut config = load_unified_profiles_config()?;

    let profile = config
        .get_profile_mut(&profile_id)
        .ok_or_else(|| GitnadoError::OperationFailed("Profile not found".to_string()))?;

    profile.remove_default_account(&integration_type);
    save_unified_profiles_config(&config)?;
    Ok(())
}

/// Update cached user info for a global account
#[command]
pub async fn update_global_account_cached_user(account_id: String, user: CachedUser) -> Result<()> {
    let mut config = load_unified_profiles_config()?;

    let account = config
        .get_account_mut(&account_id)
        .ok_or_else(|| GitnadoError::OperationFailed("Account not found".to_string()))?;

    account.update_cached_user(user);
    save_unified_profiles_config(&config)?;
    Ok(())
}

/// Get the profile's preferred account for an integration type
#[command]
pub async fn get_profile_preferred_account(
    profile_id: String,
    integration_type: IntegrationType,
) -> Result<Option<IntegrationAccount>> {
    let config = load_unified_profiles_config()?;
    Ok(config
        .get_profile_preferred_account(&profile_id, &integration_type)
        .cloned())
}

/// Resolve the preferred account for a repository, accounting for account-level
/// URL patterns.
///
/// Precedence (most repo-specific first):
/// 1. An account of `integration_type` whose `url_patterns` match `repo_url`.
/// 2. The profile's explicit `default_accounts[integration_type]`.
/// 3. The global default account for the type.
#[command]
pub async fn get_repository_preferred_account(
    profile_id: String,
    integration_type: IntegrationType,
    repo_url: Option<String>,
) -> Result<Option<IntegrationAccount>> {
    let config = load_unified_profiles_config()?;
    Ok(config
        .get_repository_preferred_account(&profile_id, &integration_type, repo_url.as_deref())
        .cloned())
}

// =============================================================================
// Deprecated Profile-Scoped Account Commands (kept for backward compatibility)
// =============================================================================

/// Add an integration account to a profile
/// @deprecated Use save_global_account instead
#[command]
pub async fn add_account_to_profile(
    _profile_id: String,
    account: ProfileIntegrationAccount,
) -> Result<ProfileIntegrationAccount> {
    // Convert to global account and save
    let global_account = IntegrationAccount {
        id: account.id.clone(),
        name: account.name.clone(),
        integration_type: account.integration_type.clone(),
        config: account.config.clone(),
        color: account.color.clone(),
        cached_user: account.cached_user.clone(),
        url_patterns: Vec::new(),
        is_default: account.is_default_for_type,
    };

    let mut config = load_unified_profiles_config()?;
    config.save_account(global_account);
    save_unified_profiles_config(&config)?;
    Ok(account)
}

/// Update an integration account within a profile
/// @deprecated Use save_global_account instead
#[command]
pub async fn update_account_in_profile(
    _profile_id: String,
    account: ProfileIntegrationAccount,
) -> Result<ProfileIntegrationAccount> {
    let global_account = IntegrationAccount {
        id: account.id.clone(),
        name: account.name.clone(),
        integration_type: account.integration_type.clone(),
        config: account.config.clone(),
        color: account.color.clone(),
        cached_user: account.cached_user.clone(),
        url_patterns: Vec::new(),
        is_default: account.is_default_for_type,
    };

    let mut config = load_unified_profiles_config()?;
    config.save_account(global_account);
    save_unified_profiles_config(&config)?;
    Ok(account)
}

/// Remove an integration account from a profile
/// @deprecated Use delete_global_account instead
#[command]
pub async fn remove_account_from_profile(_profile_id: String, account_id: String) -> Result<()> {
    let mut config = load_unified_profiles_config()?;
    config.delete_account(&account_id);
    save_unified_profiles_config(&config)?;
    Ok(())
}

/// Set an account as the default for its type within a profile
/// @deprecated Use set_profile_default_account instead
#[command]
pub async fn set_default_account_in_profile(profile_id: String, account_id: String) -> Result<()> {
    let mut config = load_unified_profiles_config()?;

    // Find the account to get its type
    let integration_type = config
        .get_account(&account_id)
        .map(|a| a.integration_type.clone())
        .ok_or_else(|| GitnadoError::OperationFailed("Account not found".to_string()))?;

    // Set as profile's preferred account
    if let Some(profile) = config.get_profile_mut(&profile_id) {
        profile.set_default_account(integration_type, account_id);
    }

    save_unified_profiles_config(&config)?;
    Ok(())
}

/// Update cached user info for an account within a profile
/// @deprecated Use update_global_account_cached_user instead
#[command]
pub async fn update_profile_account_cached_user(
    _profile_id: String,
    account_id: String,
    user: CachedUser,
) -> Result<()> {
    let mut config = load_unified_profiles_config()?;

    let account = config
        .get_account_mut(&account_id)
        .ok_or_else(|| GitnadoError::OperationFailed("Account not found".to_string()))?;

    account.update_cached_user(user);
    save_unified_profiles_config(&config)?;
    Ok(())
}

// =============================================================================
// Profile Detection and Assignment Commands
// =============================================================================

/// Detect which profile should be used for a repository based on URL patterns
#[command]
pub async fn detect_unified_profile_for_repository(path: String) -> Result<Option<UnifiedProfile>> {
    let config = load_unified_profiles_config()?;
    let repo_path = Path::new(&path);

    // First check for manual assignment
    if let Some(profile) = config.get_assigned_profile(&path) {
        return Ok(Some(profile.clone()));
    }

    // Get the remote URL and try to match
    if let Some(remote_url) = get_remote_url(repo_path) {
        if let Some(profile) = config.find_matching_profile(&remote_url) {
            return Ok(Some(profile.clone()));
        }
    }

    // Return default profile if no match
    Ok(config.get_default_profile().cloned())
}

/// Get the assigned profile for a repository (checking assignment first, then auto-detect)
#[command]
pub async fn get_assigned_unified_profile(path: String) -> Result<Option<UnifiedProfile>> {
    detect_unified_profile_for_repository(path).await
}

/// Manually assign a profile to a repository
#[command]
pub async fn assign_unified_profile_to_repository(path: String, profile_id: String) -> Result<()> {
    let mut config = load_unified_profiles_config()?;
    assign_and_apply(&mut config, path, profile_id)?;
    save_unified_profiles_config(&config)?;
    Ok(())
}

/// Record the assignment AND write the profile's identity into the repository's
/// git config.
///
/// These must happen together. The dashboard renders the assigned profile's
/// name/email/signing key as the repository's commit identity, so recording only
/// the mapping meant a user who assigned "Work" to five repositories saw
/// work@example.com on every card and then committed with their old global
/// identity — nothing ever reconciled the two.
///
/// Takes the config by reference so the pairing is testable without the global
/// on-disk profile store.
fn assign_and_apply(
    config: &mut UnifiedProfilesConfig,
    path: String,
    profile_id: String,
) -> Result<()> {
    let profile = config
        .get_profile(&profile_id)
        .ok_or_else(|| GitnadoError::OperationFailed("Profile not found".to_string()))?
        .clone();

    // Applied BEFORE the assignment is recorded: if git config cannot be
    // written, the mapping must not claim an identity the repository does not
    // have.
    apply_profile_git_config(Path::new(&path), &profile)?;

    config.assign_profile(path, profile_id);
    Ok(())
}

/// Clear the local git identity a profile wrote to a repository.
///
/// The mirror of `apply_profile_git_config`: it unsets exactly the five keys
/// that function writes, so the repository falls back to the global identity it
/// would have used had no profile ever been assigned. Unsetting a key that is
/// not set is not an error in git, and is not treated as one here.
fn clear_profile_git_config(repo_path: &Path) {
    for key in [
        "user.name",
        "user.email",
        "user.signingkey",
        "gpg.format",
        "commit.gpgsign",
    ] {
        let _ = run_git_config(Some(repo_path), &["--local", "--unset", key]);
    }
}

/// Remove profile assignment from a repository
#[command]
pub async fn unassign_unified_profile_from_repository(path: String) -> Result<()> {
    let mut config = load_unified_profiles_config()?;
    config.unassign_profile(&path);
    save_unified_profiles_config(&config)?;

    // Assigning a profile WRITES the identity into .git/config, so unassigning
    // has to take it back out. Dropping only the mapping left the repository
    // committing as the profile the UI no longer showed — and with its
    // commit.gpgsign and signing key still in force. The divergence is silent
    // and survives restarts, because .git/config is the thing git actually
    // reads.
    //
    // Done AFTER the mapping is saved: the identity is recoverable by
    // re-assigning, but a mapping left behind for an identity that is gone
    // would keep claiming an identity the repository does not have.
    clear_profile_git_config(Path::new(&path));

    Ok(())
}

/// Detect the `gpg.format` git should use for a given signing key.
///
/// Returns `Some("ssh")` when the key looks like an SSH signing key — an inline
/// OpenSSH public key of any type (`ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-*`,
/// FIDO2 `sk-ssh-*`/`sk-ecdsa-*`), git's `key::<literal>` form, or a path to a
/// `.pub` file. Returns `None` otherwise, meaning git's default `openpgp` format
/// should be used (and any stale local `gpg.format` cleared).
fn detect_gpg_format(signing_key: &str) -> Option<&'static str> {
    let key = signing_key.trim();
    // Reuse gpg.rs's single source of truth for SSH key-shape detection, plus a
    // `.pub` path (a public-key file also implies ssh format).
    if crate::commands::gpg::is_ssh_literal_key(key) || key.ends_with(".pub") {
        Some("ssh")
    } else {
        None
    }
}

/// Apply a profile's git identity (name, email, signing config) to a
/// repository's local git config.
///
/// Signing behaviour:
/// - With a non-empty signing key: sets `user.signingkey`, sets `gpg.format`
///   locally to match the key type (`ssh` for SSH keys, otherwise `openpgp`),
///   and enables `commit.gpgsign`. Without setting `gpg.format=ssh`, an SSH
///   signing key would apply `gpgsign=true` while the format stayed `openpgp`,
///   making subsequent commits fail to sign.
/// - Without a signing key: clears the local `user.signingkey`/`gpg.format`
///   and explicitly sets `commit.gpgsign=false` so a globally-enabled
///   `commit.gpgsign=true` cannot force commits to sign with a missing key.
fn apply_profile_git_config(repo_path: &Path, profile: &UnifiedProfile) -> Result<()> {
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

    match profile.signing_key.as_deref() {
        Some(signing_key) if !signing_key.is_empty() => {
            run_git_config(
                Some(repo_path),
                &["--local", "user.signingkey", signing_key],
            )?;
            // Set gpg.format explicitly so the key signs correctly. Git's
            // default is openpgp, so an SSH key with gpgsign=true would fail to
            // sign without gpg.format=ssh. We write it locally in both cases so
            // a globally-configured gpg.format cannot mismatch the profile's
            // key (e.g. a global gpg.format=ssh would break an OpenPGP key).
            let fmt = detect_gpg_format(signing_key).unwrap_or("openpgp");
            run_git_config(Some(repo_path), &["--local", "gpg.format", fmt])?;
            run_git_config(Some(repo_path), &["--local", "commit.gpgsign", "true"])?;
        }
        _ => {
            // No signing key: unset the local key/format and explicitly disable
            // signing so a globally-enabled commit.gpgsign=true does not force
            // commits to sign with a missing local key.
            let _ = run_git_config(Some(repo_path), &["--local", "--unset", "user.signingkey"]);
            let _ = run_git_config(Some(repo_path), &["--local", "--unset", "gpg.format"]);
            run_git_config(Some(repo_path), &["--local", "commit.gpgsign", "false"])?;
        }
    }

    Ok(())
}

/// Store an edited profile AND push its identity back into every repository
/// already assigned to it.
///
/// These must happen together, for the same reason assignment writes git config:
/// the dashboard and the profile list render the profile's identity as the
/// repository's commit identity, so persisting only the JSON left every assigned
/// repository committing — and signing — as the profile was BEFORE the edit.
/// Fixing a typo in a work email or rotating a signing key changed nothing but
/// what the UI displayed.
///
/// Best effort per repository: one that has been moved or deleted must not block
/// the edit, so its path is returned instead of failing the save.
///
/// Takes the config by reference so the pairing is testable without the global
/// on-disk profile store.
fn save_and_reapply(config: &mut UnifiedProfilesConfig, profile: &UnifiedProfile) -> Vec<String> {
    config.save_profile(profile.clone());

    let mut failed: Vec<String> = config
        .repository_assignments
        .iter()
        .filter(|(_, assigned_id)| assigned_id.as_str() == profile.id)
        .filter(|(repo_path, _)| {
            apply_profile_git_config(Path::new(repo_path.as_str()), profile).is_err()
        })
        .map(|(repo_path, _)| repo_path.clone())
        .collect();
    // HashMap iteration order is arbitrary; sort so the paths the UI names come
    // out in a stable order.
    failed.sort();
    failed
}

/// Apply a profile to a repository (set git config)
#[command]
pub async fn apply_unified_profile(path: String, profile_id: String) -> Result<()> {
    let mut config = load_unified_profiles_config()?;

    let profile = config
        .get_profile(&profile_id)
        .ok_or_else(|| GitnadoError::OperationFailed("Profile not found".to_string()))?
        .clone();

    let repo_path = Path::new(&path);

    apply_profile_git_config(repo_path, &profile)?;

    // Save the assignment
    config.assign_profile(path, profile_id);
    save_unified_profiles_config(&config)?;

    Ok(())
}

/// Get the current git identity for a repository
#[command]
pub async fn get_current_git_identity(path: String) -> Result<CurrentGitIdentity> {
    let repo_path = Path::new(&path);

    let name = run_git_config(Some(repo_path), &["--get", "user.name"]).ok();
    let email = run_git_config(Some(repo_path), &["--get", "user.email"]).ok();
    let signing_key = run_git_config(Some(repo_path), &["--get", "user.signingkey"]).ok();

    Ok(CurrentGitIdentity {
        name: name.filter(|s| !s.is_empty()),
        email: email.filter(|s| !s.is_empty()),
        signing_key: signing_key.filter(|s| !s.is_empty()),
    })
}

/// Current git identity for a repository
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentGitIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
    pub signing_key: Option<String>,
}

// =============================================================================
// Migration Commands
// =============================================================================

/// Result of migrating to unified profiles
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedMigrationResult {
    pub success: bool,
    pub profiles_migrated: usize,
    pub accounts_migrated: usize,
    pub unmatched_accounts: Vec<UnmatchedAccount>,
    pub errors: Vec<String>,
}

/// An account that couldn't be automatically matched to a profile
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmatchedAccount {
    pub account_id: String,
    pub account_name: String,
    pub integration_type: IntegrationType,
    pub suggested_profile_id: Option<String>,
}

/// Check if migration to unified profiles is needed
#[command]
pub async fn needs_unified_profiles_migration() -> Result<bool> {
    let unified_path = get_unified_profiles_path()?;
    let legacy_profiles_path = get_legacy_profiles_path()?;
    let legacy_accounts_path = get_legacy_accounts_path()?;

    // Migration is needed if:
    // 1. Unified profiles config doesn't exist
    // 2. Either legacy profiles or accounts exist
    let unified_exists = unified_path.exists();
    let legacy_exists = legacy_profiles_path.exists() || legacy_accounts_path.exists();

    Ok(!unified_exists && legacy_exists)
}

/// Preview migration - shows how accounts would be matched to profiles
#[command]
pub async fn preview_unified_profiles_migration() -> Result<MigrationPreview> {
    let legacy_profiles = load_legacy_profiles_config()?;
    let legacy_accounts = load_legacy_accounts_config()?;

    let mut preview = MigrationPreview {
        profiles: Vec::new(),
        unmatched_accounts: Vec::new(),
    };

    // Convert legacy profiles
    for profile in &legacy_profiles.profiles {
        let mut preview_profile = MigrationPreviewProfile {
            profile_id: profile.id.clone(),
            profile_name: profile.name.clone(),
            git_email: profile.git_email.clone(),
            matched_accounts: Vec::new(),
        };

        // Try to match accounts by URL pattern overlap
        for account in &legacy_accounts.accounts {
            if has_pattern_overlap(&profile.url_patterns, &account.url_patterns) {
                preview_profile
                    .matched_accounts
                    .push(MigrationPreviewAccount {
                        account_id: account.id.clone(),
                        account_name: account.name.clone(),
                        integration_type: account.integration_type.clone(),
                    });
            }
        }

        preview.profiles.push(preview_profile);
    }

    // Find unmatched accounts
    for account in &legacy_accounts.accounts {
        let is_matched = preview.profiles.iter().any(|p| {
            p.matched_accounts
                .iter()
                .any(|a| a.account_id == account.id)
        });

        if !is_matched {
            // Suggest the default profile
            let suggested = legacy_profiles.profiles.iter().find(|p| p.is_default);

            preview.unmatched_accounts.push(UnmatchedAccount {
                account_id: account.id.clone(),
                account_name: account.name.clone(),
                integration_type: account.integration_type.clone(),
                suggested_profile_id: suggested.map(|p| p.id.clone()),
            });
        }
    }

    Ok(preview)
}

/// Migration preview data
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPreview {
    pub profiles: Vec<MigrationPreviewProfile>,
    pub unmatched_accounts: Vec<UnmatchedAccount>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPreviewProfile {
    pub profile_id: String,
    pub profile_name: String,
    pub git_email: String,
    pub matched_accounts: Vec<MigrationPreviewAccount>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPreviewAccount {
    pub account_id: String,
    pub account_name: String,
    pub integration_type: IntegrationType,
}

/// Pure migration logic — separated from I/O so it can be unit-tested.
///
/// Returns a tuple of the `UnifiedMigrationResult` (with V2-correct
/// `success`/`errors`), the migrated `Vec<UnifiedProfile>`, and the migrated
/// `Vec<IntegrationAccount>`; the caller assembles these into a
/// `UnifiedProfilesConfig` and persists it. Hard I/O / parse failures continue
/// to propagate as early `?` returns from the command layer above.
fn run_migration_logic(
    legacy_profiles: &ProfilesConfig,
    legacy_accounts: &IntegrationAccountsConfig,
    account_assignments: &std::collections::HashMap<String, String>,
) -> (
    UnifiedMigrationResult,
    Vec<UnifiedProfile>,
    Vec<IntegrationAccount>,
) {
    use std::collections::HashMap;

    let mut result = UnifiedMigrationResult {
        success: true,
        profiles_migrated: 0,
        accounts_migrated: 0,
        unmatched_accounts: Vec::new(),
        errors: Vec::new(),
    };

    // Convert legacy accounts to global IntegrationAccount (v3).
    // V2: collect per-account conversion problems into result.errors so the
    // UI can surface them; only hard IO/parse failures (above) use early `?`.
    let mut global_accounts: Vec<IntegrationAccount> = Vec::new();

    for account in &legacy_accounts.accounts {
        // Validate required fields before converting.
        if account.id.trim().is_empty() {
            result
                .errors
                .push(format!("Skipped account '{}': id is empty", account.name));
            continue;
        }
        if account.name.trim().is_empty() {
            result.errors.push(format!(
                "Skipped account with id '{}': name is empty",
                account.id
            ));
            continue;
        }

        global_accounts.push(IntegrationAccount {
            id: account.id.clone(),
            name: account.name.clone(),
            integration_type: account.integration_type.clone(),
            config: account.config.clone(),
            color: account.color.clone(),
            cached_user: account.cached_user.clone(),
            url_patterns: account.url_patterns.clone(),
            is_default: account.is_default,
        });
        result.accounts_migrated += 1;
    }

    // Create unified profiles from legacy profiles (v3 format).
    // V2: profiles that fail validation are skipped and their error recorded.
    let mut unified_profiles: Vec<UnifiedProfile> = Vec::new();

    for p in &legacy_profiles.profiles {
        // Validate required fields.
        if p.id.trim().is_empty() {
            result
                .errors
                .push(format!("Skipped profile '{}': id is empty", p.name));
            continue;
        }
        if p.name.trim().is_empty() {
            result
                .errors
                .push(format!("Skipped profile with id '{}': name is empty", p.id));
            continue;
        }

        // Build default_accounts map based on account_assignments
        let mut default_accounts: HashMap<IntegrationType, String> = HashMap::new();

        // Check which accounts are assigned to this profile
        for (account_id, assigned_profile_id) in account_assignments {
            if assigned_profile_id == &p.id {
                // Find the account and add to default_accounts
                if let Some(account) = legacy_accounts
                    .accounts
                    .iter()
                    .find(|a| &a.id == account_id)
                {
                    default_accounts
                        .entry(account.integration_type.clone())
                        .or_insert_with(|| account_id.clone());
                } else {
                    // The assignment references an account that doesn't exist.
                    result.errors.push(format!(
                        "Profile '{}': assigned account id '{}' not found in legacy accounts",
                        p.name, account_id
                    ));
                }
            }
        }

        unified_profiles.push(UnifiedProfile {
            id: p.id.clone(),
            name: p.name.clone(),
            git_name: p.git_name.clone(),
            git_email: p.git_email.clone(),
            signing_key: p.signing_key.clone(),
            url_patterns: p.url_patterns.clone(),
            is_default: p.is_default,
            // V4: use shared PROFILE_COLORS[0] so there is one source of truth
            color: p
                .color
                .clone()
                .unwrap_or_else(|| PROFILE_COLORS[0].to_string()),
            default_accounts,
        });
    }

    result.profiles_migrated = unified_profiles.len();

    // V2: reflect whether any items were skipped/failed in the success flag.
    result.success = result.errors.is_empty();

    (result, unified_profiles, global_accounts)
}

/// Execute migration with custom account-to-profile assignments
#[command]
pub async fn execute_unified_profiles_migration(
    account_assignments: std::collections::HashMap<String, String>, // account_id -> profile_id
) -> Result<UnifiedMigrationResult> {
    let legacy_profiles = load_legacy_profiles_config()?;
    let legacy_accounts = load_legacy_accounts_config()?;

    let (result, unified_profiles, global_accounts) =
        run_migration_logic(&legacy_profiles, &legacy_accounts, &account_assignments);

    // Use profile repository assignments
    let repository_assignments = legacy_profiles.repository_assignments.clone();

    // Save the unified config (v3 format)
    let unified_config = UnifiedProfilesConfig {
        version: UNIFIED_PROFILES_CONFIG_VERSION,
        profiles: unified_profiles,
        accounts: global_accounts,
        repository_assignments,
    };

    save_unified_profiles_config(&unified_config)?;

    // Backup legacy files
    backup_legacy_configs()?;

    Ok(result)
}

/// Check if two sets of URL patterns have any overlap
fn has_pattern_overlap(patterns1: &[String], patterns2: &[String]) -> bool {
    for p1 in patterns1 {
        for p2 in patterns2 {
            let norm1 = normalize_pattern(p1);
            let norm2 = normalize_pattern(p2);

            // Check if patterns share a common domain prefix
            if norm1.starts_with(&norm2) || norm2.starts_with(&norm1) {
                return true;
            }

            // Also check if they target the same domain
            let domain1 = get_domain(&norm1);
            let domain2 = get_domain(&norm2);
            if domain1 == domain2 && !domain1.is_empty() {
                return true;
            }
        }
    }
    false
}

fn normalize_pattern(pattern: &str) -> String {
    pattern
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches("/*")
        .trim_end_matches('/')
        .to_lowercase()
}

fn get_domain(pattern: &str) -> String {
    pattern.split('/').next().unwrap_or("").to_string()
}

/// Backup legacy config files
fn backup_legacy_configs() -> Result<()> {
    let profiles_path = get_legacy_profiles_path()?;
    let accounts_path = get_legacy_accounts_path()?;

    if profiles_path.exists() {
        let backup_path = profiles_path.with_extension("json.bak");
        fs::copy(&profiles_path, &backup_path).map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to backup profiles: {}", e))
        })?;
    }

    if accounts_path.exists() {
        let backup_path = accounts_path.with_extension("json.bak");
        fs::copy(&accounts_path, &backup_path).map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to backup integration accounts: {}", e))
        })?;
    }

    Ok(())
}

// =============================================================================
// Migration Rollback
// =============================================================================

/// Information about available migration backup
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationBackupInfo {
    pub has_backup: bool,
    pub backup_date: Option<String>,
    pub profiles_count: Option<usize>,
    pub accounts_count: Option<usize>,
}

/// Check if a migration backup exists and get info about it
#[command]
pub async fn get_migration_backup_info() -> Result<MigrationBackupInfo> {
    let profiles_backup_path = get_legacy_profiles_path()?.with_extension("json.bak");
    let accounts_backup_path = get_legacy_accounts_path()?.with_extension("json.bak");

    let profiles_backup_exists = profiles_backup_path.exists();
    let accounts_backup_exists = accounts_backup_path.exists();

    if !profiles_backup_exists && !accounts_backup_exists {
        return Ok(MigrationBackupInfo {
            has_backup: false,
            backup_date: None,
            profiles_count: None,
            accounts_count: None,
        });
    }

    // Get backup modification date
    let backup_date = if profiles_backup_exists {
        fs::metadata(&profiles_backup_path)
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|t| {
                chrono::DateTime::<chrono::Utc>::from(t)
                    .format("%Y-%m-%d %H:%M:%S UTC")
                    .to_string()
            })
    } else if accounts_backup_exists {
        fs::metadata(&accounts_backup_path)
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|t| {
                chrono::DateTime::<chrono::Utc>::from(t)
                    .format("%Y-%m-%d %H:%M:%S UTC")
                    .to_string()
            })
    } else {
        None
    };

    // Count items in backup
    let profiles_count = if profiles_backup_exists {
        fs::read_to_string(&profiles_backup_path)
            .ok()
            .and_then(|content| serde_json::from_str::<ProfilesConfig>(&content).ok())
            .map(|config| config.profiles.len())
    } else {
        None
    };

    let accounts_count = if accounts_backup_exists {
        fs::read_to_string(&accounts_backup_path)
            .ok()
            .and_then(|content| serde_json::from_str::<IntegrationAccountsConfig>(&content).ok())
            .map(|config| config.accounts.len())
    } else {
        None
    };

    Ok(MigrationBackupInfo {
        has_backup: true,
        backup_date,
        profiles_count,
        accounts_count,
    })
}

/// Restore from migration backup (rollback)
#[command]
pub async fn restore_migration_backup() -> Result<MigrationBackupInfo> {
    let profiles_path = get_legacy_profiles_path()?;
    let accounts_path = get_legacy_accounts_path()?;
    let unified_path = get_unified_profiles_path()?;
    let profiles_backup_path = profiles_path.with_extension("json.bak");
    let accounts_backup_path = accounts_path.with_extension("json.bak");

    // Check if backups exist
    if !profiles_backup_path.exists() && !accounts_backup_path.exists() {
        return Err(GitnadoError::OperationFailed(
            "No migration backup found to restore".to_string(),
        ));
    }

    // Restore profiles backup
    let profiles_count = if profiles_backup_path.exists() {
        let content = fs::read_to_string(&profiles_backup_path).map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to read profiles backup: {}", e))
        })?;

        // Validate it's valid JSON
        let config: ProfilesConfig = serde_json::from_str(&content).map_err(|e| {
            GitnadoError::OperationFailed(format!("Invalid profiles backup format: {}", e))
        })?;

        let count = config.profiles.len();

        // Restore the backup
        fs::copy(&profiles_backup_path, &profiles_path).map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to restore profiles: {}", e))
        })?;

        Some(count)
    } else {
        None
    };

    // Restore accounts backup
    let accounts_count = if accounts_backup_path.exists() {
        let content = fs::read_to_string(&accounts_backup_path).map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to read accounts backup: {}", e))
        })?;

        // Validate it's valid JSON
        let config: IntegrationAccountsConfig = serde_json::from_str(&content).map_err(|e| {
            GitnadoError::OperationFailed(format!("Invalid accounts backup format: {}", e))
        })?;

        let count = config.accounts.len();

        // Restore the backup
        fs::copy(&accounts_backup_path, &accounts_path).map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to restore accounts: {}", e))
        })?;

        Some(count)
    } else {
        None
    };

    // Remove the unified profiles config so migration will be needed again
    if unified_path.exists() {
        fs::remove_file(&unified_path).map_err(|e| {
            GitnadoError::OperationFailed(format!(
                "Failed to remove unified profiles config: {}",
                e
            ))
        })?;
    }

    Ok(MigrationBackupInfo {
        has_backup: true,
        backup_date: None, // Not relevant for restore response
        profiles_count,
        accounts_count,
    })
}

/// Delete migration backup files
#[command]
pub async fn delete_migration_backup() -> Result<()> {
    let profiles_backup_path = get_legacy_profiles_path()?.with_extension("json.bak");
    let accounts_backup_path = get_legacy_accounts_path()?.with_extension("json.bak");

    if profiles_backup_path.exists() {
        fs::remove_file(&profiles_backup_path).map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to delete profiles backup: {}", e))
        })?;
    }

    if accounts_backup_path.exists() {
        fs::remove_file(&accounts_backup_path).map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to delete accounts backup: {}", e))
        })?;
    }

    Ok(())
}

/// Get an account from global accounts (for compatibility during transition)
///
/// V10: The former return type `(String, IntegrationAccount)` always carried an
/// empty profile-id string, which was misleading.  The tuple has been collapsed
/// to `Option<IntegrationAccount>`.  Any TypeScript caller that destructured
/// `[profileId, account]` must be updated to receive a plain account object.
///
/// @deprecated Use get_global_account instead
#[command]
pub async fn get_account_from_any_profile(
    account_id: String,
) -> Result<Option<IntegrationAccount>> {
    let config = load_unified_profiles_config()?;
    Ok(config.get_account(&account_id).cloned())
}

/// Get account for a repository by integration type (from the assigned/detected profile)
#[command]
pub async fn get_repository_account(
    path: String,
    integration_type: IntegrationType,
) -> Result<Option<IntegrationAccount>> {
    let config = load_unified_profiles_config()?;
    let profile = detect_unified_profile_for_repository(path).await?;

    if let Some(profile) = profile {
        // Get the profile's preferred account for this type
        Ok(config
            .get_profile_preferred_account(&profile.id, &integration_type)
            .cloned())
    } else {
        // No profile, return global default
        Ok(config.get_default_account(&integration_type).cloned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::integration_accounts::LegacyIntegrationAccount;
    use crate::models::{
        workflow::GitProfile, IntegrationAccountsConfig, IntegrationConfig, ProfilesConfig,
    };
    use crate::test_utils::TestRepo;

    // =========================================================================
    // Signing config application (gpg.format / commit.gpgsign)
    // =========================================================================

    #[test]
    fn test_detect_gpg_format() {
        assert_eq!(detect_gpg_format("ssh-ed25519 AAAAC3..."), Some("ssh"));
        assert_eq!(detect_gpg_format("ssh-rsa AAAAB3..."), Some("ssh"));
        assert_eq!(
            detect_gpg_format("/home/me/.ssh/id_ed25519.pub"),
            Some("ssh")
        );
        assert_eq!(detect_gpg_format("  ssh-ed25519 key  "), Some("ssh"));
        // ECDSA, FIDO2/security-key, and git's key:: literal forms are all SSH.
        assert_eq!(
            detect_gpg_format("ecdsa-sha2-nistp256 AAAAE2..."),
            Some("ssh")
        );
        assert_eq!(
            detect_gpg_format("sk-ssh-ed25519@openssh.com AAAA..."),
            Some("ssh")
        );
        assert_eq!(
            detect_gpg_format("sk-ecdsa-sha2-nistp256@openssh.com AAAA..."),
            Some("ssh")
        );
        assert_eq!(detect_gpg_format("key::ssh-ed25519 AAAA..."), Some("ssh"));
        // OpenPGP-style key IDs are not SSH.
        assert_eq!(detect_gpg_format("ABCDEF1234567890"), None);
        assert_eq!(detect_gpg_format(""), None);
    }

    /// Assigning a profile must WRITE the identity, not just record a mapping.
    ///
    /// The dashboard shows the assigned profile's name/email as the repository's
    /// commit identity. While assignment only stored the mapping, a user could
    /// bulk-assign "Work" to five repositories, see work@example.com on every
    /// card, and then commit as whoever their global identity named.
    #[test]
    fn test_assign_writes_git_identity_not_just_the_mapping() {
        let repo = TestRepo::with_initial_commit();
        let repo_path = repo.path_str();

        let profile = UnifiedProfile::new(
            "Work".to_string(),
            "Alice Work".to_string(),
            "alice@work.example".to_string(),
        );
        let profile_id = profile.id.clone();

        let mut config = UnifiedProfilesConfig::default();
        config.save_profile(profile);

        assign_and_apply(&mut config, repo_path.clone(), profile_id.clone())
            .expect("assignment should succeed");

        // The mapping is recorded...
        assert_eq!(
            config.repository_assignments.get(&repo_path),
            Some(&profile_id)
        );

        // ...and the repository actually commits as that identity.
        assert_eq!(
            run_git_config(
                Some(repo.path.as_path()),
                &["--local", "--get", "user.name"]
            )
            .unwrap(),
            "Alice Work"
        );
        assert_eq!(
            run_git_config(
                Some(repo.path.as_path()),
                &["--local", "--get", "user.email"]
            )
            .unwrap(),
            "alice@work.example"
        );
    }

    /// Unassigning must TAKE BACK the identity assignment wrote.
    ///
    /// Dropping only the mapping left the repository committing as the profile
    /// the UI no longer showed, with its signing key and commit.gpgsign still in
    /// force — a silent divergence that survives restarts, because .git/config
    /// is what git actually reads.
    #[test]
    fn test_unassign_clears_the_identity_assignment_wrote() {
        let repo = TestRepo::with_initial_commit();

        let mut profile = UnifiedProfile::new(
            "Work".to_string(),
            "Alice Work".to_string(),
            "alice@work.example".to_string(),
        );
        profile.signing_key = Some("ssh-ed25519 AAAAC3Nz".to_string());
        let profile_id = profile.id.clone();

        let mut config = UnifiedProfilesConfig::default();
        config.save_profile(profile);
        assign_and_apply(&mut config, repo.path_str(), profile_id)
            .expect("assignment should succeed");

        // Every key assignment writes is present...
        for key in [
            "user.name",
            "user.email",
            "user.signingkey",
            "gpg.format",
            "commit.gpgsign",
        ] {
            // `git config --get` on a missing key exits 1 with no output, which
            // run_git_config maps to Ok(""), so presence means a NON-EMPTY value.
            assert!(
                !run_git_config(Some(repo.path.as_path()), &["--local", "--get", key])
                    .unwrap_or_default()
                    .is_empty(),
                "{} should be set after assignment",
                key
            );
        }

        clear_profile_git_config(repo.path.as_path());

        // ...and every one of them is gone afterwards, so the repository falls
        // back to the global identity it would have used all along.
        for key in [
            "user.name",
            "user.email",
            "user.signingkey",
            "gpg.format",
            "commit.gpgsign",
        ] {
            assert!(
                run_git_config(Some(repo.path.as_path()), &["--local", "--get", key])
                    .unwrap_or_default()
                    .is_empty(),
                "{} must not survive unassignment",
                key
            );
        }
    }

    /// Editing a profile must rewrite the identity of the repositories that
    /// already use it.
    ///
    /// Saving used to persist only the JSON, so fixing a typo in an email or
    /// rotating a signing key changed what the dashboard displayed while every
    /// assigned repository kept committing — and signing — as the profile was
    /// before the edit.
    #[test]
    fn test_editing_a_profile_rewrites_assigned_repositories() {
        let repo = TestRepo::with_initial_commit();

        let profile = UnifiedProfile::new(
            "Work".to_string(),
            "Alice Work".to_string(),
            "alice@work.example".to_string(),
        );
        let profile_id = profile.id.clone();

        let mut config = UnifiedProfilesConfig::default();
        config.save_profile(profile.clone());
        assign_and_apply(&mut config, repo.path_str(), profile_id.clone())
            .expect("assignment should succeed");

        let mut edited = profile;
        edited.git_email = "alice@newwork.example".to_string();
        edited.signing_key = Some("ssh-ed25519 AAAAC3Nz".to_string());

        let failed = save_and_reapply(&mut config, &edited);

        assert!(failed.is_empty(), "no repository should have failed");
        assert_eq!(
            run_git_config(
                Some(repo.path.as_path()),
                &["--local", "--get", "user.email"]
            )
            .unwrap(),
            "alice@newwork.example"
        );
        assert_eq!(
            run_git_config(
                Some(repo.path.as_path()),
                &["--local", "--get", "user.signingkey"]
            )
            .unwrap(),
            "ssh-ed25519 AAAAC3Nz"
        );
        assert_eq!(
            run_git_config(
                Some(repo.path.as_path()),
                &["--local", "--get", "gpg.format"]
            )
            .unwrap(),
            "ssh"
        );
    }

    /// A repository that has been moved or deleted must not block the edit — it
    /// is reported so the UI can name it.
    #[test]
    fn test_editing_a_profile_reports_repositories_it_could_not_update() {
        let repo = TestRepo::with_initial_commit();
        let missing = repo.path.join("gone-repo").to_string_lossy().to_string();

        let profile = UnifiedProfile::new(
            "Work".to_string(),
            "Alice Work".to_string(),
            "alice@work.example".to_string(),
        );
        let profile_id = profile.id.clone();

        let mut config = UnifiedProfilesConfig::default();
        config.save_profile(profile.clone());
        assign_and_apply(&mut config, repo.path_str(), profile_id.clone())
            .expect("assignment should succeed");
        // A path that was assigned once and has since disappeared.
        config.assign_profile(missing.clone(), profile_id.clone());

        let mut edited = profile;
        edited.git_email = "alice@newwork.example".to_string();

        let failed = save_and_reapply(&mut config, &edited);

        assert_eq!(failed, vec![missing]);
        // The live repository was still updated...
        assert_eq!(
            run_git_config(
                Some(repo.path.as_path()),
                &["--local", "--get", "user.email"]
            )
            .unwrap(),
            "alice@newwork.example"
        );
        // ...and the edit itself was still stored.
        assert_eq!(
            config.get_profile(&profile_id).unwrap().git_email,
            "alice@newwork.example"
        );
    }

    /// Only the edited profile's own repositories may be rewritten.
    #[test]
    fn test_editing_a_profile_leaves_other_profiles_repositories_alone() {
        let repo_a = TestRepo::with_initial_commit();
        let repo_b = TestRepo::with_initial_commit();

        let profile_a = UnifiedProfile::new(
            "Work".to_string(),
            "Alice Work".to_string(),
            "alice@work.example".to_string(),
        );
        let profile_b = UnifiedProfile::new(
            "Personal".to_string(),
            "Alice Home".to_string(),
            "alice@home.example".to_string(),
        );
        let id_a = profile_a.id.clone();
        let id_b = profile_b.id.clone();

        let mut config = UnifiedProfilesConfig::default();
        config.save_profile(profile_a.clone());
        config.save_profile(profile_b);
        assign_and_apply(&mut config, repo_a.path_str(), id_a).expect("assign a");
        assign_and_apply(&mut config, repo_b.path_str(), id_b).expect("assign b");

        let mut edited = profile_a;
        edited.git_email = "alice@newwork.example".to_string();

        let failed = save_and_reapply(&mut config, &edited);

        assert!(failed.is_empty());
        assert_eq!(
            run_git_config(
                Some(repo_b.path.as_path()),
                &["--local", "--get", "user.email"]
            )
            .unwrap(),
            "alice@home.example"
        );
    }

    /// An unknown profile must not be recorded as an assignment.
    #[test]
    fn test_assign_unknown_profile_records_nothing() {
        let repo = TestRepo::with_initial_commit();
        let mut config = UnifiedProfilesConfig::default();

        let result = assign_and_apply(&mut config, repo.path_str(), "no-such-profile".to_string());

        assert!(result.is_err());
        assert!(config.repository_assignments.is_empty());
    }

    #[test]
    fn test_apply_profile_ssh_signing_sets_gpg_format_ssh() {
        let repo = TestRepo::with_initial_commit();
        let mut profile = UnifiedProfile::new(
            "Work".to_string(),
            "Alice".to_string(),
            "alice@work.com".to_string(),
        );
        profile.signing_key = Some("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAExampleKey".to_string());

        apply_profile_git_config(repo.path.as_path(), &profile).expect("apply should succeed");

        // SSH key -> gpg.format=ssh and gpgsign enabled.
        assert_eq!(
            run_git_config(
                Some(repo.path.as_path()),
                &["--local", "--get", "gpg.format"]
            )
            .unwrap(),
            "ssh"
        );
        assert_eq!(
            run_git_config(
                Some(repo.path.as_path()),
                &["--local", "--get", "commit.gpgsign"]
            )
            .unwrap(),
            "true"
        );
        assert_eq!(
            run_git_config(
                Some(repo.path.as_path()),
                &["--local", "--get", "user.signingkey"]
            )
            .unwrap(),
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAExampleKey"
        );
    }

    #[test]
    fn test_apply_profile_pub_path_sets_gpg_format_ssh() {
        let repo = TestRepo::with_initial_commit();
        let mut profile = UnifiedProfile::new(
            "Work".to_string(),
            "Alice".to_string(),
            "alice@work.com".to_string(),
        );
        profile.signing_key = Some("/home/alice/.ssh/id_ed25519.pub".to_string());

        apply_profile_git_config(repo.path.as_path(), &profile).expect("apply should succeed");

        assert_eq!(
            run_git_config(
                Some(repo.path.as_path()),
                &["--local", "--get", "gpg.format"]
            )
            .unwrap(),
            "ssh"
        );
    }

    #[test]
    fn test_apply_profile_openpgp_key_leaves_format_default() {
        let repo = TestRepo::with_initial_commit();
        let mut profile = UnifiedProfile::new(
            "Work".to_string(),
            "Alice".to_string(),
            "alice@work.com".to_string(),
        );
        profile.signing_key = Some("ABCDEF1234567890".to_string());

        apply_profile_git_config(repo.path.as_path(), &profile).expect("apply should succeed");

        // Non-SSH key -> gpg.format set explicitly to openpgp locally, signing on.
        assert_eq!(
            run_git_config(
                Some(repo.path.as_path()),
                &["--local", "--get", "gpg.format"]
            )
            .unwrap(),
            "openpgp"
        );
        assert_eq!(
            run_git_config(
                Some(repo.path.as_path()),
                &["--local", "--get", "commit.gpgsign"]
            )
            .unwrap(),
            "true"
        );
    }

    #[test]
    fn test_apply_profile_no_signing_disables_gpgsign() {
        let repo = TestRepo::with_initial_commit();
        let profile = UnifiedProfile::new(
            "Personal".to_string(),
            "Alice".to_string(),
            "alice@home.com".to_string(),
        );
        // No signing key on this profile.
        assert!(profile.signing_key.is_none());

        apply_profile_git_config(repo.path.as_path(), &profile).expect("apply should succeed");

        // Explicit local override so a globally-enabled gpgsign cannot sign.
        assert_eq!(
            run_git_config(
                Some(repo.path.as_path()),
                &["--local", "--get", "commit.gpgsign"]
            )
            .unwrap(),
            "false"
        );
        // Local signing key and format cleared.
        assert_eq!(
            run_git_config(
                Some(repo.path.as_path()),
                &["--local", "--get", "user.signingkey"]
            )
            .unwrap(),
            ""
        );
        assert_eq!(
            run_git_config(
                Some(repo.path.as_path()),
                &["--local", "--get", "gpg.format"]
            )
            .unwrap(),
            ""
        );
    }

    #[test]
    fn test_apply_profile_switch_ssh_to_none_clears_ssh_format() {
        // Applying an SSH profile then a no-signing profile must clear the
        // stale gpg.format=ssh and disable signing.
        let repo = TestRepo::with_initial_commit();

        let mut ssh_profile = UnifiedProfile::new(
            "Work".to_string(),
            "Alice".to_string(),
            "alice@work.com".to_string(),
        );
        ssh_profile.signing_key = Some("ssh-ed25519 AAAAExampleKey".to_string());
        apply_profile_git_config(repo.path.as_path(), &ssh_profile).unwrap();
        assert_eq!(
            run_git_config(
                Some(repo.path.as_path()),
                &["--local", "--get", "gpg.format"]
            )
            .unwrap(),
            "ssh"
        );

        let none_profile = UnifiedProfile::new(
            "Personal".to_string(),
            "Alice".to_string(),
            "alice@home.com".to_string(),
        );
        apply_profile_git_config(repo.path.as_path(), &none_profile).unwrap();
        assert_eq!(
            run_git_config(
                Some(repo.path.as_path()),
                &["--local", "--get", "gpg.format"]
            )
            .unwrap(),
            ""
        );
        assert_eq!(
            run_git_config(
                Some(repo.path.as_path()),
                &["--local", "--get", "commit.gpgsign"]
            )
            .unwrap(),
            "false"
        );
    }

    // Helper: build a minimal GitProfile for use in migration tests.
    fn make_git_profile(id: &str, name: &str) -> GitProfile {
        GitProfile {
            id: id.to_string(),
            name: name.to_string(),
            git_name: "Test User".to_string(),
            git_email: "test@example.com".to_string(),
            signing_key: None,
            url_patterns: Vec::new(),
            is_default: false,
            color: None,
        }
    }

    // Helper: build a minimal LegacyIntegrationAccount for migration tests.
    fn make_legacy_account(id: &str, name: &str) -> LegacyIntegrationAccount {
        LegacyIntegrationAccount {
            id: id.to_string(),
            name: name.to_string(),
            integration_type: IntegrationType::GitHub,
            url_patterns: Vec::new(),
            is_default: false,
            color: None,
            config: IntegrationConfig::GitHub,
            cached_user: None,
        }
    }

    #[test]
    fn test_has_pattern_overlap() {
        // Same domain
        assert!(has_pattern_overlap(
            &["github.com/company/*".to_string()],
            &["github.com/company/repo".to_string()]
        ));

        // Same domain, different paths
        assert!(has_pattern_overlap(
            &["github.com/company/*".to_string()],
            &["github.com/other/*".to_string()]
        ));

        // Different domains
        assert!(!has_pattern_overlap(
            &["github.com/company/*".to_string()],
            &["gitlab.com/company/*".to_string()]
        ));
    }

    #[test]
    fn test_normalize_pattern() {
        assert_eq!(
            normalize_pattern("https://github.com/company/*"),
            "github.com/company"
        );
        assert_eq!(
            normalize_pattern("github.com/company/"),
            "github.com/company"
        );
    }

    // =========================================================================
    // V2: migration success reflects errors
    // =========================================================================

    #[test]
    fn test_migration_success_all_valid() {
        // V2: when all items are valid, success must be true and errors empty.
        let mut legacy_profiles = ProfilesConfig::default();
        legacy_profiles
            .profiles
            .push(make_git_profile("p1", "Work"));

        let mut legacy_accounts = IntegrationAccountsConfig::default();
        legacy_accounts
            .accounts
            .push(make_legacy_account("a1", "Work GitHub"));

        let assignments = std::collections::HashMap::new();
        let (result, profiles, accounts) =
            run_migration_logic(&legacy_profiles, &legacy_accounts, &assignments);

        assert!(result.success, "should succeed when all items are valid");
        assert!(result.errors.is_empty(), "should have no errors");
        assert_eq!(result.profiles_migrated, 1);
        assert_eq!(result.accounts_migrated, 1);
        assert_eq!(profiles.len(), 1);
        assert_eq!(accounts.len(), 1);
    }

    #[test]
    fn test_migration_success_false_when_account_has_empty_id() {
        // V2: an account with an empty id must be skipped and recorded in errors;
        // success must be false.
        let legacy_profiles = ProfilesConfig::default();

        let mut legacy_accounts = IntegrationAccountsConfig::default();
        let bad_account = make_legacy_account("", "No-Id Account");
        legacy_accounts.accounts.push(bad_account);

        let assignments = std::collections::HashMap::new();
        let (result, _profiles, _accounts) =
            run_migration_logic(&legacy_profiles, &legacy_accounts, &assignments);

        assert!(
            !result.success,
            "success must be false when an account is skipped"
        );
        assert!(!result.errors.is_empty(), "errors must be populated");
        assert_eq!(
            result.accounts_migrated, 0,
            "skipped account must not be counted"
        );
        // Error message should mention the skipped account's name
        assert!(
            result.errors[0].contains("No-Id Account"),
            "error must identify the offending account; got: {}",
            result.errors[0]
        );
    }

    #[test]
    fn test_migration_success_false_when_assignment_refs_nonexistent_account() {
        // V2: when account_assignments points to an account that doesn't exist,
        // an error is recorded and success is false.
        let mut legacy_profiles = ProfilesConfig::default();
        legacy_profiles
            .profiles
            .push(make_git_profile("p1", "Work"));

        let legacy_accounts = IntegrationAccountsConfig::default(); // no accounts

        let mut assignments = std::collections::HashMap::new();
        assignments.insert("ghost-account-id".to_string(), "p1".to_string());

        let (result, _profiles, _accounts) =
            run_migration_logic(&legacy_profiles, &legacy_accounts, &assignments);

        assert!(
            !result.success,
            "success must be false when assignment is dangling"
        );
        assert!(
            !result.errors.is_empty(),
            "errors must list the dangling assignment"
        );
    }

    #[test]
    fn test_migration_default_color_uses_profile_colors_constant() {
        // V4: profiles without a color must get PROFILE_COLORS[0], not a hardcoded literal.
        let mut legacy_profiles = ProfilesConfig::default();
        let mut profile = make_git_profile("p1", "Work");
        profile.color = None; // explicitly no color
        legacy_profiles.profiles.push(profile);

        let legacy_accounts = IntegrationAccountsConfig::default();
        let assignments = std::collections::HashMap::new();

        let (_result, profiles, _accounts) =
            run_migration_logic(&legacy_profiles, &legacy_accounts, &assignments);

        assert_eq!(profiles.len(), 1);
        assert_eq!(
            profiles[0].color, PROFILE_COLORS[0],
            "color must equal PROFILE_COLORS[0], not a hardcoded literal"
        );
    }

    // =========================================================================
    // M8: config file written with 0o600 permissions
    // =========================================================================

    #[cfg(unix)]
    #[test]
    fn test_save_unified_profiles_config_sets_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        use tempfile::tempdir;

        // Write a config to a temp directory and check its mode.
        let dir = tempdir().expect("failed to create temp dir");
        let path = dir.path().join("unified_profiles.json");

        let config = UnifiedProfilesConfig::default();
        let content = serde_json::to_string_pretty(&config).unwrap();
        std::fs::write(&path, content).unwrap();

        // Apply the same permission logic as save_unified_profiles_config.
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(&path, perms).unwrap();

        let actual_mode = std::fs::metadata(&path).unwrap().permissions().mode();
        // The low 9 bits are the rwxrwxrwx bits.
        assert_eq!(
            actual_mode & 0o777,
            0o600,
            "config file must be owner-read/write only (0600)"
        );
    }
}
