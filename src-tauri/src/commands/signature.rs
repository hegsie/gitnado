//! Commit signature verification command handlers
//!
//! Provides detailed commit signature verification including
//! GPG, SSH, and X.509 signature support with rich status reporting.

use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::utils::create_command;

/// Detailed commit signature information
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitSignatureInfo {
    /// The commit ID this signature belongs to
    pub commit_id: String,
    /// Whether the commit has a signature
    pub is_signed: bool,
    /// Verification status of the signature
    pub signature_status: SignatureStatus,
    /// Name of the signer (from GPG/SSH key)
    pub signer_name: Option<String>,
    /// Email of the signer
    pub signer_email: Option<String>,
    /// Key ID used for signing
    pub key_id: Option<String>,
    /// Type of signature: "gpg", "ssh", "x509"
    pub signature_type: Option<String>,
}

/// Signature verification status
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SignatureStatus {
    /// Valid signature from a trusted key
    Good,
    /// Invalid signature (tampered or corrupt)
    Bad,
    /// Cannot verify (missing key or unknown issuer)
    Unknown,
    /// Commit has no signature
    Unsigned,
    /// Error occurred during verification
    Error,
}

/// Signing configuration for a repository
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SigningConfig {
    /// Whether commit signing is enabled (commit.gpgsign)
    pub signing_enabled: bool,
    /// The configured signing key (user.signingkey)
    pub signing_key: Option<String>,
    /// The signing format: "gpg", "ssh", "x509" (gpg.format)
    pub signing_format: Option<String>,
}

use serde::Serialize;

/// Run a git command in a repository directory and return stdout
fn run_git(repo_path: &Path, args: &[&str]) -> Result<String> {
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

/// Run a git command and return combined stdout+stderr regardless of exit status
fn run_git_combined(repo_path: &Path, args: &[&str]) -> Result<(bool, String)> {
    let output = create_command("git")
        .current_dir(repo_path)
        .args(args)
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run git: {}", e)))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = format!("{}\n{}", stdout, stderr);

    Ok((output.status.success(), combined))
}

/// Parse the single-character signature status from git log %G?
fn parse_status_char(ch: &str) -> SignatureStatus {
    match ch.trim() {
        "G" => SignatureStatus::Good,
        "B" => SignatureStatus::Bad,
        "U" => SignatureStatus::Unknown, // good signature with unknown validity
        "X" => SignatureStatus::Good,    // good signature that has expired
        "Y" => SignatureStatus::Good,    // good signature made by an expired key
        "R" => SignatureStatus::Bad,     // good signature made by a revoked key
        "E" => SignatureStatus::Error,
        "N" | "" => SignatureStatus::Unsigned,
        _ => SignatureStatus::Error,
    }
}

/// Parse signer name and email from a signer string like "Name <email>"
fn parse_signer(signer: &str) -> (Option<String>, Option<String>) {
    let signer = signer.trim();
    if signer.is_empty() {
        return (None, None);
    }

    if let Some(start) = signer.find('<') {
        if let Some(end) = signer.find('>') {
            let name = signer[..start].trim().to_string();
            let email = signer[start + 1..end].trim().to_string();
            return (
                if name.is_empty() { None } else { Some(name) },
                if email.is_empty() { None } else { Some(email) },
            );
        }
    }

    // No angle brackets - treat the whole string as a name
    (Some(signer.to_string()), None)
}

/// Detect signature type from GPG status output or git config
fn detect_signature_type(raw_output: &str, repo_path: &Path) -> Option<String> {
    let lower = raw_output.to_lowercase();
    if lower.contains("ssh") || lower.contains("ssh-") {
        return Some("ssh".to_string());
    }
    if lower.contains("x509") || lower.contains("x.509") || lower.contains("smime") {
        return Some("x509".to_string());
    }
    if lower.contains("gpg")
        || lower.contains("gnupg")
        || lower.contains("rsa")
        || lower.contains("dsa")
        || lower.contains("eddsa")
        || lower.contains("ecdsa")
    {
        return Some("gpg".to_string());
    }

    // Fall back to checking the configured format
    run_git(repo_path, &["config", "--get", "gpg.format"])
        .ok()
        .filter(|s| !s.is_empty())
}

/// Verify the signature of a single commit
#[command]
pub async fn verify_commit_signature(
    path: String,
    commit_id: String,
) -> Result<CommitSignatureInfo> {
    let repo_path = Path::new(&path);

    // First, get structured signature info via git log format
    let log_output = run_git(
        repo_path,
        &["log", "-1", "--format=%G?|%GK|%GS|%GG", &commit_id],
    );

    match log_output {
        Ok(line) => {
            let parts: Vec<&str> = line.splitn(4, '|').collect();
            let status_char = parts.first().unwrap_or(&"N");
            let status = parse_status_char(status_char);
            let is_signed = status != SignatureStatus::Unsigned;

            let key_id = parts
                .get(1)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());

            let signer_str = parts.get(2).unwrap_or(&"").trim();
            let (signer_name, signer_email) = parse_signer(signer_str);

            let raw_output = parts.get(3).unwrap_or(&"").to_string();

            // Also try verify-commit for more detailed output
            let verify_output =
                run_git_combined(repo_path, &["verify-commit", "--raw", &commit_id]);
            let combined_raw = match verify_output {
                Ok((_, ref output)) => format!("{}\n{}", raw_output, output),
                Err(_) => raw_output.clone(),
            };

            let signature_type = if is_signed {
                detect_signature_type(&combined_raw, repo_path)
            } else {
                None
            };

            Ok(CommitSignatureInfo {
                commit_id,
                is_signed,
                signature_status: status,
                signer_name,
                signer_email,
                key_id,
                signature_type,
            })
        }
        Err(_) => Ok(CommitSignatureInfo {
            commit_id,
            is_signed: false,
            signature_status: SignatureStatus::Unsigned,
            signer_name: None,
            signer_email: None,
            key_id: None,
            signature_type: None,
        }),
    }
}

/// Verify signatures for multiple commits in a batch
#[command]
pub async fn get_commits_signature_info(
    path: String,
    commit_ids: Vec<String>,
) -> Result<Vec<CommitSignatureInfo>> {
    let repo_path = Path::new(&path);

    if commit_ids.is_empty() {
        return Ok(Vec::new());
    }

    // Build a git log command to get signature info for all requested commits
    // Use %H to get full commit hash so we can match results
    let format = "%H|%G?|%GK|%GS";

    // We need to iterate over the commits to get their info
    // Use git log with specific revisions
    let mut results = Vec::new();

    // For efficiency, try a single git log call with all commits
    // We'll pass them as revision arguments
    let mut args = vec![
        "log".to_string(),
        format!("--format={}", format),
        "--no-walk".to_string(),
    ];
    for id in &commit_ids {
        args.push(id.clone());
    }

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let log_output = run_git(repo_path, &arg_refs);

    match log_output {
        Ok(output) => {
            // Build a map of commit_id -> parsed info
            let mut info_map = std::collections::HashMap::new();

            for line in output.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }

                let parts: Vec<&str> = line.splitn(4, '|').collect();
                if parts.is_empty() {
                    continue;
                }

                let full_hash = parts[0].trim().to_string();
                let status_char = parts.get(1).unwrap_or(&"N");
                let status = parse_status_char(status_char);
                let is_signed = status != SignatureStatus::Unsigned;

                let key_id = parts
                    .get(2)
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());

                let signer_str = parts.get(3).unwrap_or(&"").trim();
                let (signer_name, signer_email) = parse_signer(signer_str);

                // Detect signature type from config if signed
                let signature_type = if is_signed {
                    run_git(repo_path, &["config", "--get", "gpg.format"])
                        .ok()
                        .filter(|s| !s.is_empty())
                        .or_else(|| Some("gpg".to_string()))
                } else {
                    None
                };

                info_map.insert(
                    full_hash.clone(),
                    CommitSignatureInfo {
                        commit_id: full_hash,
                        is_signed,
                        signature_status: status,
                        signer_name,
                        signer_email,
                        key_id,
                        signature_type,
                    },
                );
            }

            // Return results in the same order as the input commit_ids
            for id in &commit_ids {
                if let Some(info) = info_map.remove(id) {
                    results.push(info);
                } else {
                    // Check if a short hash matches
                    let matched = info_map.keys().find(|k| k.starts_with(id)).cloned();

                    if let Some(full_hash) = matched {
                        if let Some(mut info) = info_map.remove(&full_hash) {
                            info.commit_id = id.clone();
                            results.push(info);
                        }
                    } else {
                        // Commit not found in batch output, return unsigned
                        results.push(CommitSignatureInfo {
                            commit_id: id.clone(),
                            is_signed: false,
                            signature_status: SignatureStatus::Unsigned,
                            signer_name: None,
                            signer_email: None,
                            key_id: None,
                            signature_type: None,
                        });
                    }
                }
            }
        }
        Err(_) => {
            // Fallback: process each commit individually
            for id in &commit_ids {
                let info = verify_commit_signature(path.clone(), id.clone()).await?;
                results.push(info);
            }
        }
    }

    Ok(results)
}

/// Get the signing configuration for a repository
#[command]
pub async fn get_signing_config(path: String) -> Result<SigningConfig> {
    let repo_path = Path::new(&path);

    // Check commit.gpgsign
    let signing_enabled = run_git(repo_path, &["config", "--get", "commit.gpgsign"])
        .ok()
        .map(|s| s.trim() == "true")
        .unwrap_or(false);

    // Check user.signingkey
    let signing_key = run_git(repo_path, &["config", "--get", "user.signingkey"])
        .ok()
        .filter(|s| !s.is_empty());

    // Check gpg.format
    let signing_format = run_git(repo_path, &["config", "--get", "gpg.format"])
        .ok()
        .filter(|s| !s.is_empty());

    Ok(SigningConfig {
        signing_enabled,
        signing_key,
        signing_format,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[test]
    fn test_parse_status_char_good() {
        assert_eq!(parse_status_char("G"), SignatureStatus::Good);
    }

    #[test]
    fn test_parse_status_char_bad() {
        assert_eq!(parse_status_char("B"), SignatureStatus::Bad);
    }

    #[test]
    fn test_parse_status_char_unknown() {
        assert_eq!(parse_status_char("U"), SignatureStatus::Unknown);
    }

    #[test]
    fn test_parse_status_char_expired() {
        assert_eq!(parse_status_char("X"), SignatureStatus::Good);
    }

    #[test]
    fn test_parse_status_char_expired_key() {
        assert_eq!(parse_status_char("Y"), SignatureStatus::Good);
    }

    #[test]
    fn test_parse_status_char_revoked() {
        assert_eq!(parse_status_char("R"), SignatureStatus::Bad);
    }

    #[test]
    fn test_parse_status_char_error() {
        assert_eq!(parse_status_char("E"), SignatureStatus::Error);
    }

    #[test]
    fn test_parse_status_char_none() {
        assert_eq!(parse_status_char("N"), SignatureStatus::Unsigned);
    }

    #[test]
    fn test_parse_status_char_empty() {
        assert_eq!(parse_status_char(""), SignatureStatus::Unsigned);
    }

    #[test]
    fn test_parse_status_char_unknown_char() {
        assert_eq!(parse_status_char("Z"), SignatureStatus::Error);
    }

    #[test]
    fn test_parse_signer_with_name_and_email() {
        let (name, email) = parse_signer("John Doe <john@example.com>");
        assert_eq!(name, Some("John Doe".to_string()));
        assert_eq!(email, Some("john@example.com".to_string()));
    }

    #[test]
    fn test_parse_signer_name_only() {
        let (name, email) = parse_signer("John Doe");
        assert_eq!(name, Some("John Doe".to_string()));
        assert_eq!(email, None);
    }

    #[test]
    fn test_parse_signer_empty() {
        let (name, email) = parse_signer("");
        assert_eq!(name, None);
        assert_eq!(email, None);
    }

    #[test]
    fn test_parse_signer_email_only() {
        let (name, email) = parse_signer("<john@example.com>");
        assert_eq!(name, None);
        assert_eq!(email, Some("john@example.com".to_string()));
    }

    #[test]
    fn test_detect_signature_type_gpg() {
        let temp = tempfile::TempDir::new().unwrap();
        let _ = git2::Repository::init(temp.path());
        assert_eq!(
            detect_signature_type("[GNUPG:] GOODSIG ABC123", temp.path()),
            Some("gpg".to_string())
        );
    }

    #[test]
    fn test_detect_signature_type_ssh() {
        let temp = tempfile::TempDir::new().unwrap();
        let _ = git2::Repository::init(temp.path());
        assert_eq!(
            detect_signature_type("Good \"git\" signature with SSH key", temp.path()),
            Some("ssh".to_string())
        );
    }

    #[test]
    fn test_detect_signature_type_x509() {
        let temp = tempfile::TempDir::new().unwrap();
        let _ = git2::Repository::init(temp.path());
        assert_eq!(
            detect_signature_type("Good signature from X509 certificate", temp.path()),
            Some("x509".to_string())
        );
    }

    #[tokio::test]
    async fn test_verify_unsigned_commit() {
        let repo = TestRepo::with_initial_commit();
        let oid = repo.head_oid();

        let result = verify_commit_signature(repo.path_str(), oid.to_string()).await;
        assert!(result.is_ok());
        let sig = result.unwrap();
        assert!(!sig.is_signed);
        assert_eq!(sig.signature_status, SignatureStatus::Unsigned);
        assert!(sig.key_id.is_none());
        assert!(sig.signature_type.is_none());
    }

    #[tokio::test]
    async fn test_get_commits_signature_info_empty() {
        let repo = TestRepo::with_initial_commit();

        let result = get_commits_signature_info(repo.path_str(), Vec::new()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_get_commits_signature_info_unsigned() {
        let repo = TestRepo::with_initial_commit();
        let oid = repo.head_oid();

        let result = get_commits_signature_info(repo.path_str(), vec![oid.to_string()]).await;
        assert!(result.is_ok());
        let sigs = result.unwrap();
        assert_eq!(sigs.len(), 1);
        assert!(!sigs[0].is_signed);
        assert_eq!(sigs[0].signature_status, SignatureStatus::Unsigned);
    }

    #[tokio::test]
    async fn test_get_commits_signature_info_multiple() {
        let repo = TestRepo::with_initial_commit();
        let oid1 = repo.head_oid();
        repo.create_commit("Second commit", &[("file2.txt", "content")]);
        let oid2 = repo.head_oid();

        let result =
            get_commits_signature_info(repo.path_str(), vec![oid1.to_string(), oid2.to_string()])
                .await;
        assert!(result.is_ok());
        let sigs = result.unwrap();
        assert_eq!(sigs.len(), 2);
    }

    #[tokio::test]
    async fn test_get_signing_config_defaults() {
        let repo = TestRepo::with_initial_commit();

        let result = get_signing_config(repo.path_str()).await;
        assert!(result.is_ok());
        let config = result.unwrap();
        assert!(!config.signing_enabled);
        assert!(config.signing_key.is_none());
        assert!(config.signing_format.is_none());
    }

    #[tokio::test]
    async fn test_get_signing_config_enabled() {
        let repo = TestRepo::with_initial_commit();

        // Set commit.gpgsign = true via git config
        let git_repo = repo.repo();
        let mut config = git_repo.config().unwrap();
        config.set_bool("commit.gpgsign", true).unwrap();

        let result = get_signing_config(repo.path_str()).await;
        assert!(result.is_ok());
        let sc = result.unwrap();
        assert!(sc.signing_enabled);
    }

    #[tokio::test]
    async fn test_get_signing_config_with_key() {
        let repo = TestRepo::with_initial_commit();

        let git_repo = repo.repo();
        let mut config = git_repo.config().unwrap();
        config
            .set_str("user.signingkey", "ABCDEF1234567890")
            .unwrap();

        let result = get_signing_config(repo.path_str()).await;
        assert!(result.is_ok());
        let sc = result.unwrap();
        assert_eq!(sc.signing_key, Some("ABCDEF1234567890".to_string()));
    }

    #[tokio::test]
    async fn test_get_signing_config_with_format() {
        let repo = TestRepo::with_initial_commit();

        let git_repo = repo.repo();
        let mut config = git_repo.config().unwrap();
        config.set_str("gpg.format", "ssh").unwrap();

        let result = get_signing_config(repo.path_str()).await;
        assert!(result.is_ok());
        let sc = result.unwrap();
        assert_eq!(sc.signing_format, Some("ssh".to_string()));
    }
}
