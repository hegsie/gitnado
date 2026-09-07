//! GPG command handlers
//! Manage GPG signing for commits and tags

use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::utils::create_command;

/// GPG key information
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpgKey {
    /// Key ID (short form)
    pub key_id: String,
    /// Key ID (long form)
    pub key_id_long: String,
    /// User ID (name and email)
    pub user_id: String,
    /// Email address
    pub email: String,
    /// Key creation date
    pub created: Option<String>,
    /// Key expiration date (if set)
    pub expires: Option<String>,
    /// Whether this is the currently configured signing key
    pub is_signing_key: bool,
    /// Key type (RSA, DSA, etc.)
    pub key_type: String,
    /// Key size in bits
    pub key_size: u32,
    /// Trust level
    pub trust: String,
}

/// GPG signing configuration
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpgConfig {
    /// Whether GPG is available
    pub gpg_available: bool,
    /// GPG version
    pub gpg_version: Option<String>,
    /// Currently configured signing key
    pub signing_key: Option<String>,
    /// Whether commit signing is enabled
    pub sign_commits: bool,
    /// Whether tag signing is enabled
    pub sign_tags: bool,
    /// GPG program path
    pub gpg_program: Option<String>,
    /// Signature format (gpg.format): "openpgp" (default), "ssh", or "x509"
    pub gpg_format: Option<String>,
}

/// Commit signature information
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSignature {
    /// Whether the commit is signed
    pub signed: bool,
    /// Signature status (G=good, B=bad, U=unknown, X=expired, etc.)
    pub status: Option<String>,
    /// Signer's key ID
    pub key_id: Option<String>,
    /// Signer's name
    pub signer: Option<String>,
    /// Whether the signature is valid
    pub valid: bool,
    /// Trust level of the key
    pub trust: Option<String>,
}

/// Signing status for a repository - indicates if signing is configured and available
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningStatus {
    /// Whether commit signing is enabled (commit.gpgsign = true)
    pub gpg_sign_enabled: bool,
    /// The configured signing key (user.signingkey)
    pub signing_key: Option<String>,
    /// The configured GPG program (gpg.program)
    pub gpg_program: Option<String>,
    /// Whether signing is possible (GPG available and key configured)
    pub can_sign: bool,
}

/// Run a command and capture output
fn run_command(cmd: &str, args: &[&str]) -> Result<String> {
    let output = create_command(cmd)
        .args(args)
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run {}: {}", cmd, e)))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(stdout)
    } else {
        Err(GitnadoError::OperationFailed(
            if stderr.is_empty() { stdout } else { stderr }
                .trim()
                .to_string(),
        ))
    }
}

/// Run git command in a repository
fn run_git_command(repo_path: &Path, args: &[&str]) -> Result<String> {
    let output = create_command("git")
        .current_dir(repo_path)
        .args(args)
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run git: {}", e)))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(stdout.trim().to_string())
    } else {
        Err(GitnadoError::OperationFailed(
            if stderr.is_empty() { stdout } else { stderr }
                .trim()
                .to_string(),
        ))
    }
}

/// Check if GPG is available
fn is_gpg_available() -> bool {
    gpg_binary_available("gpg")
}

/// Check whether a given OpenPGP program (gpg.program, default "gpg") is runnable.
fn gpg_binary_available(program: &str) -> bool {
    create_command(program)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Expand a leading "~/" to the user's home directory.
fn expand_tilde(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return Path::new(&home).join(rest).to_string_lossy().to_string();
        }
    }
    p.to_string()
}

/// Whether `key` is an inline OpenSSH signing-key literal (any key type git
/// accepts for `user.signingkey` when `gpg.format=ssh`), as opposed to a path to
/// a key file. Single source of truth for SSH key-shape detection, shared with
/// `unified_profiles::detect_gpg_format` so the two can't drift.
pub(crate) fn is_ssh_literal_key(key: &str) -> bool {
    const SSH_PREFIXES: &[&str] = &["ssh-", "ecdsa-sha2-", "sk-ssh-", "sk-ecdsa-", "key::"];
    let key = key.trim();
    SSH_PREFIXES.iter().any(|p| key.starts_with(p))
}

/// Whether a configured SSH signing key is usable: either an inline public key
/// literal (see `is_ssh_literal_key`) or a path to an existing key file. SSH
/// signing does not involve the gpg binary at all.
fn ssh_key_is_usable(key: &str) -> bool {
    let key = key.trim();
    if key.is_empty() {
        return false;
    }
    if is_ssh_literal_key(key) {
        return true;
    }
    Path::new(&expand_tilde(key)).exists()
}

/// Get GPG version
fn get_gpg_version() -> Option<String> {
    create_command("gpg")
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .to_string()
        })
}

/// Get GPG signing configuration
#[command]
pub async fn get_gpg_config(path: String) -> Result<GpgConfig> {
    let repo_path = Path::new(&path);
    let gpg_available = is_gpg_available();
    let gpg_version = get_gpg_version();

    // Always read config values - they can be set even when GPG is not installed
    // Get signing key from git config
    let signing_key = run_git_command(repo_path, &["config", "--get", "user.signingkey"])
        .ok()
        .filter(|s| !s.is_empty());

    // Check if commit signing is enabled
    let sign_commits = run_git_command(repo_path, &["config", "--get", "commit.gpgsign"])
        .ok()
        .map(|s| s.trim() == "true")
        .unwrap_or(false);

    // Check if tag signing is enabled
    let sign_tags = run_git_command(repo_path, &["config", "--get", "tag.gpgsign"])
        .ok()
        .map(|s| s.trim() == "true")
        .unwrap_or(false);

    // Get GPG program if configured
    let gpg_program = run_git_command(repo_path, &["config", "--get", "gpg.program"])
        .ok()
        .filter(|s| !s.is_empty());

    // Get the configured signature format (openpgp / ssh / x509)
    let gpg_format = run_git_command(repo_path, &["config", "--get", "gpg.format"])
        .ok()
        .filter(|s| !s.is_empty());

    Ok(GpgConfig {
        gpg_available,
        gpg_version,
        signing_key,
        sign_commits,
        sign_tags,
        gpg_program,
        gpg_format,
    })
}

/// Get signing status for a repository
///
/// Returns whether GPG signing is enabled, the configured signing key,
/// the GPG program path, and whether signing is actually possible.
#[command]
pub async fn get_signing_status(path: String) -> Result<SigningStatus> {
    let repo_path = Path::new(&path);

    // Check if commit signing is enabled
    let gpg_sign_enabled = run_git_command(repo_path, &["config", "--get", "commit.gpgsign"])
        .ok()
        .map(|s| s.trim() == "true")
        .unwrap_or(false);

    // Get signing key from git config
    let signing_key = run_git_command(repo_path, &["config", "--get", "user.signingkey"])
        .ok()
        .filter(|s| !s.is_empty());

    // Get GPG program if configured
    let gpg_program = run_git_command(repo_path, &["config", "--get", "gpg.program"])
        .ok()
        .filter(|s| !s.is_empty());

    // Signature format determines HOW we sign: SSH keys never touch the gpg binary.
    let gpg_format = run_git_command(repo_path, &["config", "--get", "gpg.format"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // Determine if signing is possible.
    let can_sign = if gpg_format.as_deref() == Some("ssh") {
        // SSH signing: git signs with the configured key (a literal key or a key
        // file); gpg is irrelevant. A usable signing key is sufficient.
        signing_key
            .as_ref()
            .map(|k| ssh_key_is_usable(k))
            .unwrap_or(false)
    } else {
        // OpenPGP (default) / x509: invoke the configured gpg program.
        let program = gpg_program.as_deref().unwrap_or("gpg");
        if !gpg_binary_available(program) {
            false
        } else if let Some(key_id) = signing_key.as_ref() {
            // A signing key is configured - verify it exists in the keyring.
            run_command(program, &["--list-secret-keys", key_id]).is_ok()
        } else {
            // No signing key configured - check if there are any secret keys.
            run_command(program, &["--list-secret-keys"])
                .ok()
                .map(|output| output.contains("sec"))
                .unwrap_or(false)
        }
    };

    Ok(SigningStatus {
        gpg_sign_enabled,
        signing_key,
        gpg_program,
        can_sign,
    })
}

/// Get list of available GPG keys
#[command]
pub async fn get_gpg_keys(path: String) -> Result<Vec<GpgKey>> {
    let repo_path = Path::new(&path);

    if !is_gpg_available() {
        return Ok(Vec::new());
    }

    // Get current signing key
    let current_signing_key =
        run_git_command(repo_path, &["config", "--get", "user.signingkey"]).ok();

    // List secret keys (ones we can sign with)
    let output = run_command(
        "gpg",
        &["--list-secret-keys", "--keyid-format=long", "--with-colons"],
    )?;

    let mut keys = Vec::new();
    let mut current_key: Option<GpgKey> = None;

    for line in output.lines() {
        let fields: Vec<&str> = line.split(':').collect();
        if fields.is_empty() {
            continue;
        }

        match fields[0] {
            "sec" => {
                // Save previous key
                if let Some(key) = current_key.take() {
                    keys.push(key);
                }

                // Parse key info
                // Format: sec:validity:size:type:keyid:created:expires:...
                let key_size: u32 = fields.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
                let key_type = match *fields.get(3).unwrap_or(&"") {
                    "1" => "RSA",
                    "17" => "DSA",
                    "18" => "ECDH",
                    "19" => "ECDSA",
                    "22" => "EdDSA",
                    _ => "Unknown",
                }
                .to_string();
                let key_id_long = fields.get(4).unwrap_or(&"").to_string();
                let key_id = key_id_long
                    .get(key_id_long.len().saturating_sub(8)..)
                    .unwrap_or(&key_id_long)
                    .to_string();
                let created = fields.get(5).map(|s| s.to_string());
                let expires = fields.get(6).and_then(|s| {
                    if s.is_empty() {
                        None
                    } else {
                        Some(s.to_string())
                    }
                });
                let trust = match *fields.get(1).unwrap_or(&"") {
                    "u" => "Ultimate",
                    "f" => "Full",
                    "m" => "Marginal",
                    "n" => "Never",
                    "e" => "Expired",
                    "r" => "Revoked",
                    _ => "Unknown",
                }
                .to_string();

                let is_signing_key = current_signing_key
                    .as_ref()
                    .map(|sk| key_id_long.ends_with(sk) || sk.ends_with(&key_id))
                    .unwrap_or(false);

                current_key = Some(GpgKey {
                    key_id,
                    key_id_long,
                    user_id: String::new(),
                    email: String::new(),
                    created,
                    expires,
                    is_signing_key,
                    key_type,
                    key_size,
                    trust,
                });
            }
            "uid" => {
                // Parse user ID
                if let Some(ref mut key) = current_key {
                    if key.user_id.is_empty() {
                        let uid = fields.get(9).unwrap_or(&"").to_string();
                        key.user_id = uid.clone();

                        // Extract email from "Name <email>"
                        if let Some(start) = uid.find('<') {
                            if let Some(end) = uid.find('>') {
                                key.email = uid[start + 1..end].to_string();
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    // Don't forget the last key
    if let Some(key) = current_key {
        keys.push(key);
    }

    Ok(keys)
}

/// Set the signing key
#[command]
pub async fn set_signing_key(
    path: String,
    key_id: Option<String>,
    global: Option<bool>,
) -> Result<()> {
    let repo_path = Path::new(&path);
    let scope = if global.unwrap_or(false) {
        "--global"
    } else {
        "--local"
    };

    if let Some(key) = key_id {
        run_git_command(repo_path, &["config", scope, "user.signingkey", &key])?;
    } else {
        // Unset the signing key
        let _ = run_git_command(repo_path, &["config", scope, "--unset", "user.signingkey"]);
    }

    Ok(())
}

/// Enable or disable commit signing
#[command]
pub async fn set_commit_signing(path: String, enabled: bool, global: Option<bool>) -> Result<()> {
    let repo_path = Path::new(&path);
    let scope = if global.unwrap_or(false) {
        "--global"
    } else {
        "--local"
    };

    let value = if enabled { "true" } else { "false" };
    run_git_command(repo_path, &["config", scope, "commit.gpgsign", value])?;

    Ok(())
}

/// Enable or disable tag signing
#[command]
pub async fn set_tag_signing(path: String, enabled: bool, global: Option<bool>) -> Result<()> {
    let repo_path = Path::new(&path);
    let scope = if global.unwrap_or(false) {
        "--global"
    } else {
        "--local"
    };

    let value = if enabled { "true" } else { "false" };
    run_git_command(repo_path, &["config", scope, "tag.gpgsign", value])?;

    Ok(())
}

/// Whether a commit object carries a signature blob (gpgsig header), regardless
/// of whether it can be verified locally. Covers both PGP and SSH signatures.
fn commit_has_signature(repo_path: &Path, oid: &str) -> bool {
    let repo = match git2::Repository::open(repo_path) {
        Ok(r) => r,
        Err(_) => return false,
    };
    let oid = match git2::Oid::from_str(oid) {
        Ok(o) => o,
        Err(_) => return false,
    };
    repo.extract_signature(&oid, None).is_ok()
}

/// Get signature information for a commit
#[command]
pub async fn get_commit_signature(path: String, commit_oid: String) -> Result<CommitSignature> {
    let repo_path = Path::new(&path);

    // Use git log with signature format
    let output = run_git_command(
        repo_path,
        &["log", "-1", "--format=%G?|%GK|%GS|%GT", &commit_oid],
    );

    match output {
        Ok(line) => {
            let parts: Vec<&str> = line.split('|').collect();
            let mut status = parts.first().map(|s| s.to_string());

            let mut signed = status
                .as_ref()
                .map(|s| !s.is_empty() && s != "N")
                .unwrap_or(false);

            // A %G? of 'N' is ambiguous: it means either "no signature" OR
            // "signature present but unverifiable" (e.g. an SSH signature with no
            // gpg.ssh.allowedSignersFile configured). Distinguish by checking for
            // an actual signature blob on the object; if one exists the commit IS
            // signed, just not locally verifiable ('E' = cannot check).
            if !signed && commit_has_signature(repo_path, &commit_oid) {
                signed = true;
                status = Some("E".to_string());
            }

            let valid = status
                .as_ref()
                .map(|s| s == "G" || s == "U")
                .unwrap_or(false);

            let key_id = parts
                .get(1)
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty());
            let signer = parts
                .get(2)
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty());
            let trust = parts
                .get(3)
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty());

            Ok(CommitSignature {
                signed,
                status,
                key_id,
                signer,
                valid,
                trust,
            })
        }
        Err(_) => Ok(CommitSignature {
            signed: false,
            status: None,
            key_id: None,
            signer: None,
            valid: false,
            trust: None,
        }),
    }
}

/// Verify signatures for multiple commits (batch operation)
#[command]
pub async fn get_commits_signatures(
    path: String,
    commit_oids: Vec<String>,
) -> Result<Vec<(String, CommitSignature)>> {
    let mut results = Vec::new();

    for oid in commit_oids {
        let sig = get_commit_signature(path.clone(), oid.clone()).await?;
        results.push((oid, sig));
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[test]
    fn test_is_gpg_available() {
        // This test just checks that the function runs without panicking
        // The actual availability depends on the system configuration
        let _result = is_gpg_available();
    }

    #[test]
    fn test_get_gpg_version() {
        // This test just checks that the function runs without panicking
        // Returns Some if GPG is installed, None otherwise
        let _result = get_gpg_version();
    }

    #[tokio::test]
    async fn test_get_gpg_config() {
        let repo = TestRepo::with_initial_commit();
        let result = get_gpg_config(repo.path_str()).await;
        assert!(result.is_ok());

        let config = result.unwrap();
        // gpg_available depends on system; other fields should have default values
        // sign_commits and sign_tags should be false by default
        assert!(!config.sign_commits);
        assert!(!config.sign_tags);
    }

    #[tokio::test]
    async fn test_get_gpg_keys() {
        let repo = TestRepo::with_initial_commit();
        let result = get_gpg_keys(repo.path_str()).await;
        assert!(result.is_ok());
        // The list may be empty if no GPG keys are configured on the system
        let _keys = result.unwrap();
    }

    #[tokio::test]
    async fn test_set_signing_key() {
        let repo = TestRepo::with_initial_commit();

        // Set a signing key (doesn't need to be a real key for config purposes)
        let result =
            set_signing_key(repo.path_str(), Some("ABCD1234".to_string()), Some(false)).await;
        assert!(result.is_ok());

        // Verify it was set
        let config = get_gpg_config(repo.path_str()).await.unwrap();
        assert_eq!(config.signing_key, Some("ABCD1234".to_string()));
    }

    #[tokio::test]
    async fn test_set_signing_key_unset() {
        let repo = TestRepo::with_initial_commit();

        // First set a key
        set_signing_key(repo.path_str(), Some("ABCD1234".to_string()), Some(false))
            .await
            .unwrap();

        // Then unset it
        let result = set_signing_key(repo.path_str(), None, Some(false)).await;
        assert!(result.is_ok());

        // Verify it was unset
        let config = get_gpg_config(repo.path_str()).await.unwrap();
        assert!(config.signing_key.is_none());
    }

    #[tokio::test]
    async fn test_set_commit_signing_enabled() {
        let repo = TestRepo::with_initial_commit();

        let result = set_commit_signing(repo.path_str(), true, Some(false)).await;
        assert!(result.is_ok());

        let config = get_gpg_config(repo.path_str()).await.unwrap();
        assert!(config.sign_commits);
    }

    #[tokio::test]
    async fn test_set_commit_signing_disabled() {
        let repo = TestRepo::with_initial_commit();

        // First enable
        set_commit_signing(repo.path_str(), true, Some(false))
            .await
            .unwrap();

        // Then disable
        let result = set_commit_signing(repo.path_str(), false, Some(false)).await;
        assert!(result.is_ok());

        let config = get_gpg_config(repo.path_str()).await.unwrap();
        assert!(!config.sign_commits);
    }

    #[tokio::test]
    async fn test_set_tag_signing_enabled() {
        let repo = TestRepo::with_initial_commit();

        let result = set_tag_signing(repo.path_str(), true, Some(false)).await;
        assert!(result.is_ok());

        let config = get_gpg_config(repo.path_str()).await.unwrap();
        assert!(config.sign_tags);
    }

    #[tokio::test]
    async fn test_set_tag_signing_disabled() {
        let repo = TestRepo::with_initial_commit();

        // First enable
        set_tag_signing(repo.path_str(), true, Some(false))
            .await
            .unwrap();

        // Then disable
        let result = set_tag_signing(repo.path_str(), false, Some(false)).await;
        assert!(result.is_ok());

        let config = get_gpg_config(repo.path_str()).await.unwrap();
        assert!(!config.sign_tags);
    }

    #[tokio::test]
    async fn test_get_commit_signature_unsigned() {
        let repo = TestRepo::with_initial_commit();
        let head_oid = repo.head_oid().to_string();

        let result = get_commit_signature(repo.path_str(), head_oid).await;
        assert!(result.is_ok());

        let sig = result.unwrap();
        // Commits created by TestRepo are unsigned
        assert!(!sig.signed);
        assert!(!sig.valid);
    }

    #[tokio::test]
    async fn test_get_commit_signature_invalid_oid() {
        let repo = TestRepo::with_initial_commit();

        // Use an invalid OID
        let result = get_commit_signature(
            repo.path_str(),
            "0000000000000000000000000000000000000000".to_string(),
        )
        .await;
        assert!(result.is_ok());

        let sig = result.unwrap();
        // Should return a "not signed" result for invalid commits
        assert!(!sig.signed);
    }

    #[tokio::test]
    async fn test_get_commits_signatures() {
        let repo = TestRepo::with_initial_commit();
        let oid1 = repo.head_oid().to_string();

        // Create another commit
        repo.create_commit("Second commit", &[("file2.txt", "content2")]);
        let oid2 = repo.head_oid().to_string();

        let result =
            get_commits_signatures(repo.path_str(), vec![oid1.clone(), oid2.clone()]).await;
        assert!(result.is_ok());

        let signatures = result.unwrap();
        assert_eq!(signatures.len(), 2);
        assert_eq!(signatures[0].0, oid1);
        assert_eq!(signatures[1].0, oid2);
    }

    #[tokio::test]
    async fn test_get_commits_signatures_empty_list() {
        let repo = TestRepo::with_initial_commit();

        let result = get_commits_signatures(repo.path_str(), vec![]).await;
        assert!(result.is_ok());

        let signatures = result.unwrap();
        assert!(signatures.is_empty());
    }

    #[test]
    fn test_gpg_key_struct() {
        let key = GpgKey {
            key_id: "ABCD1234".to_string(),
            key_id_long: "1234567890ABCD1234".to_string(),
            user_id: "Test User <test@example.com>".to_string(),
            email: "test@example.com".to_string(),
            created: Some("2024-01-01".to_string()),
            expires: None,
            is_signing_key: true,
            key_type: "RSA".to_string(),
            key_size: 4096,
            trust: "Ultimate".to_string(),
        };

        assert_eq!(key.key_id, "ABCD1234");
        assert_eq!(key.key_size, 4096);
        assert!(key.is_signing_key);
        assert!(key.expires.is_none());
    }

    #[test]
    fn test_gpg_config_struct() {
        let config = GpgConfig {
            gpg_available: true,
            gpg_version: Some("gpg (GnuPG) 2.2.27".to_string()),
            signing_key: Some("ABCD1234".to_string()),
            sign_commits: true,
            sign_tags: false,
            gpg_program: None,
            gpg_format: None,
        };

        assert!(config.gpg_available);
        assert!(config.sign_commits);
        assert!(!config.sign_tags);
        assert!(config.gpg_program.is_none());
    }

    #[test]
    fn test_commit_signature_struct() {
        let sig = CommitSignature {
            signed: true,
            status: Some("G".to_string()),
            key_id: Some("ABCD1234".to_string()),
            signer: Some("Test User".to_string()),
            valid: true,
            trust: Some("ultimate".to_string()),
        };

        assert!(sig.signed);
        assert!(sig.valid);
        assert_eq!(sig.status, Some("G".to_string()));
    }

    #[test]
    fn test_commit_signature_unsigned() {
        let sig = CommitSignature {
            signed: false,
            status: None,
            key_id: None,
            signer: None,
            valid: false,
            trust: None,
        };

        assert!(!sig.signed);
        assert!(!sig.valid);
        assert!(sig.key_id.is_none());
    }

    #[tokio::test]
    async fn test_gpg_config_with_no_gpg() {
        // This test verifies the structure works even when GPG isn't available
        let config = GpgConfig {
            gpg_available: false,
            gpg_version: None,
            signing_key: None,
            sign_commits: false,
            sign_tags: false,
            gpg_program: None,
            gpg_format: None,
        };

        assert!(!config.gpg_available);
        assert!(config.gpg_version.is_none());
        assert!(config.signing_key.is_none());
    }

    #[test]
    fn test_run_command_git() {
        // Test that we can run basic git commands
        let result = run_command("git", &["--version"]);
        assert!(result.is_ok());
        assert!(result.unwrap().contains("git version"));
    }

    #[tokio::test]
    async fn test_run_git_command_in_repo() {
        let repo = TestRepo::with_initial_commit();
        let result = run_git_command(&repo.path, &["status", "--porcelain"]);
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_run_git_command_config() {
        let repo = TestRepo::with_initial_commit();
        let result = run_git_command(&repo.path, &["config", "--get", "user.name"]);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "Test User");
    }

    #[tokio::test]
    async fn test_get_signing_status_defaults() {
        let repo = TestRepo::with_initial_commit();
        let result = get_signing_status(repo.path_str()).await;
        assert!(result.is_ok());

        let status = result.unwrap();
        // By default, signing should not be enabled
        assert!(!status.gpg_sign_enabled);
        // No signing key configured by default
        assert!(status.signing_key.is_none());
        // No custom GPG program by default
        assert!(status.gpg_program.is_none());
        // can_sign depends on whether GPG is available on the system
    }

    #[tokio::test]
    async fn test_get_signing_status_with_signing_enabled() {
        let repo = TestRepo::with_initial_commit();

        // Enable commit signing
        set_commit_signing(repo.path_str(), true, Some(false))
            .await
            .unwrap();

        let result = get_signing_status(repo.path_str()).await;
        assert!(result.is_ok());

        let status = result.unwrap();
        assert!(status.gpg_sign_enabled);
    }

    #[tokio::test]
    async fn test_get_signing_status_with_signing_key() {
        let repo = TestRepo::with_initial_commit();

        // Set a signing key
        set_signing_key(repo.path_str(), Some("ABCD1234".to_string()), Some(false))
            .await
            .unwrap();

        let result = get_signing_status(repo.path_str()).await;
        assert!(result.is_ok());

        let status = result.unwrap();
        assert_eq!(status.signing_key, Some("ABCD1234".to_string()));
        // can_sign should be false because the key doesn't actually exist
        assert!(!status.can_sign);
    }

    #[test]
    fn test_signing_status_struct() {
        let status = SigningStatus {
            gpg_sign_enabled: true,
            signing_key: Some("ABCD1234".to_string()),
            gpg_program: Some("/usr/bin/gpg".to_string()),
            can_sign: true,
        };

        assert!(status.gpg_sign_enabled);
        assert_eq!(status.signing_key, Some("ABCD1234".to_string()));
        assert_eq!(status.gpg_program, Some("/usr/bin/gpg".to_string()));
        assert!(status.can_sign);
    }

    #[test]
    fn test_signing_status_struct_defaults() {
        let status = SigningStatus {
            gpg_sign_enabled: false,
            signing_key: None,
            gpg_program: None,
            can_sign: false,
        };

        assert!(!status.gpg_sign_enabled);
        assert!(status.signing_key.is_none());
        assert!(status.gpg_program.is_none());
        assert!(!status.can_sign);
    }

    // Finding 98: an SSH signing key configured via gpg.format=ssh must be
    // recognized as usable, without any gpg keyring being present.
    #[tokio::test]
    async fn test_get_signing_status_ssh_key_file() {
        let repo = TestRepo::with_initial_commit();
        let key_path = repo.path.join("signing_key.pub");
        std::fs::write(&key_path, "ssh-ed25519 AAAAC3NzTEST test@example.com\n").unwrap();

        run_git_command(&repo.path, &["config", "gpg.format", "ssh"]).unwrap();
        run_git_command(
            &repo.path,
            &["config", "user.signingkey", key_path.to_str().unwrap()],
        )
        .unwrap();

        let status = get_signing_status(repo.path_str()).await.unwrap();
        assert_eq!(status.signing_key.as_deref(), key_path.to_str());
        assert!(
            status.can_sign,
            "SSH signing with an existing key file must be reported as possible"
        );
    }

    #[tokio::test]
    async fn test_get_signing_status_ssh_literal_key() {
        let repo = TestRepo::with_initial_commit();
        run_git_command(&repo.path, &["config", "gpg.format", "ssh"]).unwrap();
        run_git_command(
            &repo.path,
            &["config", "user.signingkey", "ssh-ed25519 AAAAC3NzLITERAL"],
        )
        .unwrap();

        let status = get_signing_status(repo.path_str()).await.unwrap();
        assert!(
            status.can_sign,
            "a literal SSH public key must be reported as usable"
        );
    }

    #[test]
    fn test_is_ssh_literal_key_covers_all_shapes() {
        assert!(is_ssh_literal_key("ssh-ed25519 AAAA..."));
        assert!(is_ssh_literal_key("ssh-rsa AAAA..."));
        assert!(is_ssh_literal_key("ecdsa-sha2-nistp256 AAAA..."));
        assert!(is_ssh_literal_key("sk-ssh-ed25519@openssh.com AAAA..."));
        assert!(is_ssh_literal_key(
            "sk-ecdsa-sha2-nistp256@openssh.com AAAA..."
        ));
        assert!(is_ssh_literal_key("key::ssh-ed25519 AAAA..."));
        assert!(!is_ssh_literal_key("ABCDEF1234567890")); // OpenPGP key id
        assert!(!is_ssh_literal_key("/home/me/.ssh/id.pub")); // a path, not a literal
    }

    #[tokio::test]
    async fn test_get_signing_status_ecdsa_literal_key() {
        // An inline ECDSA SSH key must be reported usable, not misread as a path.
        let repo = TestRepo::with_initial_commit();
        run_git_command(&repo.path, &["config", "gpg.format", "ssh"]).unwrap();
        run_git_command(
            &repo.path,
            &[
                "config",
                "user.signingkey",
                "ecdsa-sha2-nistp256 AAAAE2ECDSA",
            ],
        )
        .unwrap();

        let status = get_signing_status(repo.path_str()).await.unwrap();
        assert!(
            status.can_sign,
            "an inline ECDSA SSH public key must be reported as usable"
        );
    }

    #[tokio::test]
    async fn test_get_gpg_config_reports_ssh_format() {
        let repo = TestRepo::with_initial_commit();
        run_git_command(&repo.path, &["config", "gpg.format", "ssh"]).unwrap();

        let config = get_gpg_config(repo.path_str()).await.unwrap();
        assert_eq!(config.gpg_format.as_deref(), Some("ssh"));
    }

    // Finding 101: an SSH-signed commit with no gpg.ssh.allowedSignersFile
    // configured (%G? == 'N') must still be reported as signed.
    #[tokio::test]
    async fn test_get_commit_signature_ssh_signed_no_allowed_signers() {
        let keydir = tempfile::TempDir::new().unwrap();
        let key = keydir.path().join("id");
        let gen = std::process::Command::new("ssh-keygen")
            .args(["-t", "ed25519", "-N", "", "-f", key.to_str().unwrap(), "-q"])
            .output();
        if gen.map(|o| !o.status.success()).unwrap_or(true) {
            // ssh-keygen unavailable in this environment; nothing to exercise.
            return;
        }

        let repo = TestRepo::with_initial_commit();
        let pubkey = format!("{}.pub", key.to_str().unwrap());
        run_git_command(&repo.path, &["config", "gpg.format", "ssh"]).unwrap();
        run_git_command(&repo.path, &["config", "user.signingkey", &pubkey]).unwrap();

        repo.create_file("s.txt", "x");
        repo.stage_file("s.txt");
        let out = std::process::Command::new("git")
            .current_dir(&repo.path)
            .args(["commit", "-S", "-m", "signed"])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "ssh-signed commit failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );

        let head = repo.head_oid().to_string();
        let sig = get_commit_signature(repo.path_str(), head).await.unwrap();
        assert!(
            sig.signed,
            "an SSH-signed commit must be reported as signed even with no allowedSignersFile"
        );
    }
}
