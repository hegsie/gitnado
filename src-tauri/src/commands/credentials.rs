//! Credential management command handlers
//! Manage git credential helpers and stored credentials

use std::path::Path;
use tauri::command;

use crate::commands::config::{run_git_config_raw, run_git_config_unset};
use crate::error::{GitnadoError, Result};
use crate::utils::create_command;

// ========================================================================
// URL Sanitization (M2)
// ========================================================================

/// Strip userinfo (credentials) from a URL before logging.
///
/// Authenticated remotes like `https://ghp_secret@github.com/org/repo` would
/// otherwise leak the token in INFO-level logs.  We keep only the
/// scheme + host + path so logs remain useful without exposing secrets.
///
/// The function is intentionally simple (no external dep) — it splits on
/// `://` to isolate scheme, then strips anything before the first `/` that
/// contains an `@` (the userinfo component).
pub(crate) fn sanitize_url_for_log(url: &str) -> String {
    // Split off scheme (e.g. "https")
    if let Some((scheme, rest)) = url.split_once("://") {
        // `rest` is e.g. "ghp_secret@github.com/org/repo"
        // If there is an `@` before the first `/`, drop everything up to and
        // including the `@`.
        let authority_and_path = if let Some(at_pos) = rest.find('@') {
            // Only strip if the `@` occurs in the authority (before any `/`)
            let slash_pos = rest.find('/').unwrap_or(rest.len());
            if at_pos < slash_pos {
                &rest[at_pos + 1..]
            } else {
                rest
            }
        } else {
            rest
        };
        format!("{}://{}", scheme, authority_and_path)
    } else {
        // No scheme — return as-is (SSH git@ URLs don't carry a password)
        url.to_string()
    }
}

/// Strip userinfo from every URL embedded in free-form text.
///
/// `sanitize_url_for_log` takes a string that IS a URL; git's stderr wraps the
/// URL in prose — `fatal: unable to access
/// 'https://x-access-token:TOKEN@github.com/o/r.git/': ...` — and that text is
/// handed straight to the UI on a failed clone. Recent git anonymizes the URL
/// in its own messages; older git, and messages produced by a remote helper,
/// do not, and a URL the user typed with credentials in it reaches us intact
/// either way.
pub(crate) fn redact_credentials_in_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(idx) = rest.find("://") {
        let (head, tail) = rest.split_at(idx + 3);
        out.push_str(head);
        // The authority ends at the first delimiter; everything after it is
        // path or surrounding prose and must survive untouched.
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '/' | '?' | '#' | '\'' | '"'))
            .unwrap_or(tail.len());
        let authority = &tail[..end];
        match authority.rfind('@') {
            // rfind, not find: a password may itself contain '@'.
            Some(at) => out.push_str(&authority[at + 1..]),
            None => out.push_str(authority),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// Credential helper configuration
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialHelper {
    /// Helper name (e.g., "osxkeychain", "manager-core", "store")
    pub name: String,
    /// Full helper command
    pub command: String,
    /// Scope (global, local, or url-specific)
    pub scope: String,
    /// Config file the helper is written in ("system", "global", "local", ...),
    /// as reported by `git config --show-scope`. A URL-scoped helper can live
    /// in any file, and that is the file a removal has to target.
    pub config_scope: String,
    /// URL pattern if url-specific
    pub url_pattern: Option<String>,
}

/// Credential test result
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialTestResult {
    /// Whether credentials are configured and working
    pub success: bool,
    /// The host that was tested
    pub host: String,
    /// Protocol used (https or ssh)
    pub protocol: String,
    /// Username if available
    pub username: Option<String>,
    /// Message describing the result
    pub message: String,
}

/// Available credential helper
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableHelper {
    /// Helper name
    pub name: String,
    /// Description
    pub description: String,
    /// Whether it's available on this system
    pub available: bool,
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

/// Get configured credential helpers
#[command]
pub async fn get_credential_helpers(path: String) -> Result<Vec<CredentialHelper>> {
    let repo_path = Path::new(&path);
    let mut helpers = Vec::new();

    // Get global credential helper
    if let Ok(helper) = run_git_config(None, &["--global", "--get", "credential.helper"]) {
        if !helper.is_empty() {
            helpers.push(CredentialHelper {
                name: extract_helper_name(&helper),
                command: helper,
                scope: "global".to_string(),
                config_scope: "global".to_string(),
                url_pattern: None,
            });
        }
    }

    // Get local credential helper
    if let Ok(helper) = run_git_config(Some(repo_path), &["--local", "--get", "credential.helper"])
    {
        if !helper.is_empty() {
            helpers.push(CredentialHelper {
                name: extract_helper_name(&helper),
                command: helper,
                scope: "local".to_string(),
                config_scope: "local".to_string(),
                url_pattern: None,
            });
        }
    }

    // Get URL-specific credential helpers. They can be written in any config
    // file, so ask git which one each came from — `--unset` has to be aimed at
    // that exact scope. `--show-scope --null` emits `scope\0key\nvalue` records.
    if let Ok(raw) = run_git_config_raw(
        Some(repo_path),
        &[
            "--show-scope",
            "--null",
            "--get-regexp",
            "^credential\\..+\\.helper",
        ],
    ) {
        let mut fields = raw.split('\0');
        while let Some(scope) = fields.next() {
            if scope.is_empty() {
                continue;
            }
            let Some(record) = fields.next() else {
                break;
            };
            let (key, command) = match record.split_once('\n') {
                Some((k, v)) => (k, v),
                None => (record, ""),
            };
            // Extract URL pattern from key (credential.https://github.com.helper)
            let Some(url) = key
                .strip_prefix("credential.")
                .and_then(|s| s.strip_suffix(".helper"))
            else {
                continue;
            };
            helpers.push(CredentialHelper {
                name: extract_helper_name(command),
                command: command.to_string(),
                scope: "url".to_string(),
                config_scope: scope.to_string(),
                url_pattern: Some(url.to_string()),
            });
        }
    }

    Ok(helpers)
}

/// Extract helper name from command
fn extract_helper_name(cmd: &str) -> String {
    // Handle common formats:
    // - "osxkeychain" -> "osxkeychain"
    // - "manager-core" -> "manager-core"
    // - "/path/to/helper" -> "helper"
    // - "!helper" -> "helper"
    // - "cache --timeout=3600" -> "cache"
    // - "store --file ~/.git-credentials" -> "store"
    let clean = cmd.trim_start_matches('!');
    // First split by whitespace to isolate the command from its arguments
    let command_part = clean.split_whitespace().next().unwrap_or(clean);
    // Then extract basename from path
    command_part
        .split('/')
        .next_back()
        .unwrap_or(command_part)
        .to_string()
}

// ========================================================================
// Input validation helpers (M4)
// ========================================================================

/// Validate a git config key component (url_pattern or helper string).
///
/// Git config keys are interpolated directly into the git config command line.
/// A malicious caller could inject newlines or shell metacharacters to write
/// arbitrary config sections (e.g. `\n[core]\n  sshCommand=evil`).
///
/// Allowed character set for `url_pattern`:
///   letters, digits, `.` `:` `/` `-` `_` `*` `+` `%` `@` (for scheme://host)
/// Allowed for `helper`:
///   letters, digits, `.` `-` `_` `/` ` ` (space between cmd and flags) `=`
///
/// Both reject control characters and quotes outright.
fn validate_url_pattern(pat: &str) -> Result<()> {
    if pat.is_empty() {
        return Err(GitnadoError::OperationFailed(
            "url_pattern must not be empty".to_string(),
        ));
    }
    for ch in pat.chars() {
        if ch.is_control() {
            return Err(GitnadoError::OperationFailed(format!(
                "url_pattern contains invalid control character U+{:04X}",
                ch as u32
            )));
        }
        // Allow only a conservative set of characters needed for URL patterns
        // like `https://github.com` or `github.com/*`
        if !matches!(ch,
            'a'..='z' | 'A'..='Z' | '0'..='9'
            | '.' | ':' | '/' | '-' | '_' | '*' | '+' | '%' | '@'
        ) {
            return Err(GitnadoError::OperationFailed(format!(
                "url_pattern contains disallowed character {:?} — only letters, digits, and .:-/_*+%@ are permitted",
                ch
            )));
        }
    }
    Ok(())
}

fn validate_helper(helper: &str) -> Result<()> {
    if helper.is_empty() {
        return Err(GitnadoError::OperationFailed(
            "helper must not be empty".to_string(),
        ));
    }
    // A credential helper may be a bare name (`manager`), an absolute path
    // (including Windows `C:\...` / `C:/...`), or a shell command (`!aws ... $@`).
    // The value is passed as a non-shell argument and git escapes it when
    // writing the config, so we do NOT restrict the character set (an allowlist
    // would break legitimate Windows paths and shell helpers). We only reject
    // control characters (newlines, NULs, etc.) that could corrupt the config
    // file or inject additional lines.
    for ch in helper.chars() {
        if ch.is_control() {
            return Err(GitnadoError::OperationFailed(format!(
                "helper contains invalid control character U+{:04X}",
                ch as u32
            )));
        }
    }
    Ok(())
}

/// Set credential helper
#[command]
pub async fn set_credential_helper(
    path: Option<String>,
    helper: String,
    global: Option<bool>,
    url_pattern: Option<String>,
) -> Result<()> {
    // M4: validate inputs before they are interpolated into git config keys
    validate_helper(&helper)?;
    if let Some(ref pat) = url_pattern {
        validate_url_pattern(pat)?;
    }

    let repo_path = path.as_ref().map(|p| Path::new(p.as_str()));

    if let Some(url) = url_pattern {
        // URL-specific helper
        let key = format!("credential.{}.helper", url);
        let scope = if global.unwrap_or(false) {
            "--global"
        } else {
            "--local"
        };
        run_git_config(repo_path, &[scope, &key, &helper])?;
    } else {
        // Global or local helper
        let scope = if global.unwrap_or(false) {
            "--global"
        } else {
            "--local"
        };
        run_git_config(repo_path, &[scope, "credential.helper", &helper])?;
    }

    Ok(())
}

/// Unset credential helper
#[command]
pub async fn unset_credential_helper(
    path: Option<String>,
    global: Option<bool>,
    url_pattern: Option<String>,
) -> Result<()> {
    let repo_path = path.as_ref().map(|p| Path::new(p.as_str()));
    let global = global.unwrap_or(false);

    // Without `--global`, git config edits the repository's own file — which,
    // with no path, is whatever directory the app process happens to be in,
    // not the repository on screen. Refuse instead of guessing.
    if !global && repo_path.is_none() {
        return Err(GitnadoError::OperationFailed(
            "A repository path is required to remove a repository-scoped credential helper"
                .to_string(),
        ));
    }

    let scope = if global { "--global" } else { "--local" };
    let key = match url_pattern {
        Some(url) => format!("credential.{}.helper", url),
        None => "credential.helper".to_string(),
    };

    // Surface git's failure: the dialog reloads the list right after this
    // returns, so a swallowed error is indistinguishable from a dead button.
    run_git_config_unset(repo_path, &[scope, "--unset", &key])?;

    // `--unset` only ever edits the canonical file for the scope. A helper that
    // git attributes to this scope but that actually lives in an `include`d
    // file survives, and git reports the very same "key not set" exit as a
    // genuine no-op — so the removal has to be confirmed, not assumed.
    let scope_name = if global { "global" } else { "local" };
    if let Some(origin) = key_origin_in_scope(repo_path, scope_name, &key) {
        return Err(GitnadoError::OperationFailed(format!(
            "\"{}\" is still set by {}, a file included from the {} git config. \
             Edit that file to remove it.",
            key, origin, scope_name
        )));
    }

    Ok(())
}

/// The config file a `credential.*` key still resolves to within `scope`, if any.
///
/// `git config --show-scope` reports the scope of the file that *pulled in* an
/// `include`/`includeIf` file, not the file the value was written in, so a
/// helper defined in an included file is listed as `local` (or `global`) while
/// `--unset` cannot reach it. Reading the key back after a removal is what
/// tells "already gone" apart from "unreachable from here".
///
/// `--show-scope --show-origin --null` emits `scope\0origin\0key\nvalue\0`
/// records; the key is compared exactly, so the loose `--get-regexp` prefix
/// cannot match a neighbouring `credential.*` setting.
fn key_origin_in_scope(repo_path: Option<&Path>, scope: &str, key: &str) -> Option<String> {
    let raw = run_git_config_raw(
        repo_path,
        &[
            "--show-scope",
            "--show-origin",
            "--null",
            "--get-regexp",
            "^credential\\.",
        ],
    )
    .ok()?;

    let mut fields = raw.split('\0');
    while let Some(entry_scope) = fields.next() {
        if entry_scope.is_empty() {
            continue;
        }
        let Some(origin) = fields.next() else { break };
        let Some(record) = fields.next() else { break };
        let entry_key = record.split_once('\n').map_or(record, |(k, _)| k);
        if entry_scope == scope && entry_key == key {
            // Origins read "file:<path>"; show just the path to the user.
            return Some(origin.strip_prefix("file:").unwrap_or(origin).to_string());
        }
    }
    None
}

/// Get available credential helpers on this system
#[command]
pub async fn get_available_helpers() -> Result<Vec<AvailableHelper>> {
    let mut helpers = Vec::new();

    // Common credential helpers by platform
    #[cfg(target_os = "macos")]
    {
        helpers.push(AvailableHelper {
            name: "osxkeychain".to_string(),
            description: "macOS Keychain (recommended)".to_string(),
            available: check_helper_available("osxkeychain"),
        });
    }

    #[cfg(target_os = "windows")]
    {
        helpers.push(AvailableHelper {
            name: "manager".to_string(),
            description: "Git Credential Manager".to_string(),
            available: check_helper_available("manager"),
        });
        helpers.push(AvailableHelper {
            name: "wincred".to_string(),
            description: "Windows Credential Store".to_string(),
            available: check_helper_available("wincred"),
        });
    }

    #[cfg(target_os = "linux")]
    {
        helpers.push(AvailableHelper {
            name: "libsecret".to_string(),
            description: "GNOME Keyring / libsecret".to_string(),
            available: check_helper_available("libsecret"),
        });
        helpers.push(AvailableHelper {
            name: "store".to_string(),
            description: "Store credentials in plain text (not recommended)".to_string(),
            available: true, // Always available as fallback
        });
    }

    // Cross-platform helpers
    helpers.push(AvailableHelper {
        name: "cache".to_string(),
        description: "Cache credentials in memory temporarily".to_string(),
        available: true,
    });

    helpers.push(AvailableHelper {
        name: "store".to_string(),
        description: "Store credentials in plain text file".to_string(),
        available: true,
    });

    Ok(helpers)
}

/// Check if a credential helper is available
fn check_helper_available(helper: &str) -> bool {
    create_command("git")
        .arg(format!("credential-{}", helper))
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
        || create_command(&format!("git-credential-{}", helper))
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
}

/// Test credentials for a remote URL
#[command]
pub async fn test_credentials(path: String, remote_url: String) -> Result<CredentialTestResult> {
    let repo_path = Path::new(&path);

    // Determine protocol and host from URL
    let (protocol, host) = if remote_url.starts_with("git@") || remote_url.starts_with("ssh://") {
        ("ssh".to_string(), extract_host(&remote_url))
    } else {
        ("https".to_string(), extract_host(&remote_url))
    };

    if protocol == "ssh" {
        // For SSH, test the connection
        let output = create_command("ssh")
            .args([
                "-T",
                "-o",
                "StrictHostKeyChecking=accept-new",
                "-o",
                "BatchMode=yes",
                &format!("git@{}", host),
            ])
            .output()
            .map_err(|e| {
                GitnadoError::OperationFailed(format!("Failed to test SSH connection: {}", e))
            })?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = if stdout.is_empty() {
            stderr.to_string()
        } else {
            stdout.to_string()
        };

        let success = message.contains("successfully authenticated")
            || message.contains("Welcome")
            || message.contains("logged in as");

        let username = extract_ssh_username(&message);

        Ok(CredentialTestResult {
            success,
            host,
            protocol,
            username,
            message: message.trim().to_string(),
        })
    } else {
        // For HTTPS, use git credential fill
        let mut cmd = create_command("git");
        cmd.current_dir(repo_path);
        cmd.args(["credential", "fill"]);
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to run git credential: {}", e))
        })?;

        // Send credential request
        use std::io::Write;
        if let Some(mut stdin) = child.stdin.take() {
            let input = format!("protocol=https\nhost={}\n\n", host);
            let _ = stdin.write_all(input.as_bytes());
        }

        let output = child.wait_with_output().map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to get credential output: {}", e))
        })?;

        let stdout = String::from_utf8_lossy(&output.stdout);

        // Parse response
        let mut username = None;
        let mut has_password = false;

        for line in stdout.lines() {
            if let Some(u) = line.strip_prefix("username=") {
                username = Some(u.to_string());
            } else if line.starts_with("password=") {
                has_password = true;
            }
        }

        let success = username.is_some() && has_password;
        let message = if success {
            format!("Credentials found for {}", host)
        } else if username.is_some() {
            format!("Username found but no password for {}", host)
        } else {
            format!("No credentials found for {}", host)
        };

        Ok(CredentialTestResult {
            success,
            host,
            protocol,
            username,
            message,
        })
    }
}

/// Extract host from URL
fn extract_host(url: &str) -> String {
    // Handle various URL formats:
    // - https://github.com/user/repo.git
    // - git@github.com:user/repo.git
    // - ssh://git@github.com/user/repo.git

    if let Some(rest) = url.strip_prefix("https://") {
        rest.split('/').next().unwrap_or("").to_string()
    } else if let Some(rest) = url.strip_prefix("http://") {
        rest.split('/').next().unwrap_or("").to_string()
    } else if let Some(rest) = url.strip_prefix("ssh://") {
        rest.split('@')
            .next_back()
            .and_then(|s| s.split('/').next())
            .unwrap_or("")
            .to_string()
    } else if url.contains('@') && url.contains(':') {
        // git@host:path format
        url.split('@')
            .next_back()
            .and_then(|s| s.split(':').next())
            .unwrap_or("")
            .to_string()
    } else {
        url.to_string()
    }
}

/// Extract username from SSH response
fn extract_ssh_username(message: &str) -> Option<String> {
    if message.contains("Hi ") {
        message
            .split("Hi ")
            .nth(1)
            .and_then(|s| s.split('!').next())
            .map(|s| s.to_string())
    } else if message.contains("Welcome to GitLab, @") {
        message
            .split('@')
            .nth(1)
            .and_then(|s| s.split('!').next())
            .map(|s| s.to_string())
    } else if message.contains("logged in as ") {
        message
            .split("logged in as ")
            .nth(1)
            .and_then(|s| s.split('.').next())
            .map(|s| s.to_string())
    } else {
        None
    }
}

/// Store git credentials in the system keyring
/// This is used for HTTPS authentication with git operations
#[command]
pub async fn store_git_credentials(url: String, username: String, password: String) -> Result<()> {
    use crate::services::credentials_service;

    // M2: log only the sanitized URL (strip userinfo such as tokens embedded in
    // https://token@host/... remotes so they are never written to the log).
    let safe_url = sanitize_url_for_log(&url);
    tracing::info!("Storing git credentials for URL: {}", safe_url);
    credentials_service::store_credentials(&url, &username, &password).map_err(|e| {
        tracing::error!("Failed to store credentials for {}: {}", safe_url, e);
        GitnadoError::OperationFailed(format!("Failed to store credentials: {}", e))
    })?;
    tracing::info!("Successfully stored git credentials for URL: {}", safe_url);
    Ok(())
}

/// Delete git credentials from the system keyring
#[command]
pub async fn delete_git_credentials(url: String) -> Result<()> {
    use crate::services::credentials_service;

    credentials_service::delete_credentials(&url)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to delete credentials: {}", e)))
}

/// Erase stored credentials for a host
#[command]
pub async fn erase_credentials(path: String, host: String, protocol: String) -> Result<()> {
    let repo_path = Path::new(&path);

    let mut cmd = create_command("git");
    cmd.current_dir(repo_path);
    cmd.args(["credential", "reject"]);
    cmd.stdin(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to run git credential: {}", e))
    })?;

    // Send credential info to reject
    use std::io::Write;
    if let Some(mut stdin) = child.stdin.take() {
        let input = format!("protocol={}\nhost={}\n\n", protocol, host);
        let _ = stdin.write_all(input.as_bytes());
    }

    let _ = child.wait();

    Ok(())
}

const INTEGRATION_SERVICE: &str = "gitnado-integrations";

/// Service name from before the 0.9.0 rename. A token found under it is
/// re-stored under `INTEGRATION_SERVICE` and the old entry removed, so existing
/// integration sign-ins survive the upgrade.
const LEGACY_INTEGRATION_SERVICE: &str = "leviathan-integrations";

/// Build the macOS `security add-generic-password` argument list (M3).
///
/// `-A` (allow any application) is included only in **debug** builds for
/// development convenience — it prevents repeated authorization prompts when
/// the binary is rebuilt frequently.  In **release** builds the flag is
/// omitted so the keychain entry is scoped to the signed application bundle,
/// providing proper per-app isolation.
#[cfg(target_os = "macos")]
pub(crate) fn build_security_add_args<'a>(service: &'a str, key: &'a str) -> Vec<&'a str> {
    #[cfg(debug_assertions)]
    {
        vec![
            "add-generic-password",
            "-s",
            service,
            "-a",
            key,
            "-A", // allow any application (debug only)
            "-U", // Update if exists
            "-w", // Read password from stdin (avoids exposure in argv / ps output)
        ]
    }
    #[cfg(not(debug_assertions))]
    {
        vec!["add-generic-password", "-s", service, "-a", key, "-U", "-w"]
    }
}

/// Write `value` under `key` for `service`.
///
/// On macOS, uses the `security` CLI. In debug builds `-A` is added so that
/// any application can access the item without triggering authorization
/// prompts (development convenience — the binary changes on every rebuild).
/// In release builds `-A` is omitted for proper per-app keychain isolation.
fn write_keyring_token(service: &str, key: &str, value: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        // Delete existing entry first (add-generic-password fails if it exists)
        let _ = std::process::Command::new("security")
            .args(["delete-generic-password", "-s", service, "-a", key])
            .output();

        // `-w` last with no value => password read from stdin. This avoids
        // exposing the token via argv (`ps -E` is readable by any process
        // running under the same user).
        use std::io::Write as _;
        let security_args = build_security_add_args(service, key);
        let mut child = std::process::Command::new("security")
            .args(&security_args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run security: {e}")))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(value.as_bytes()).map_err(|e| {
                GitnadoError::OperationFailed(format!("Failed to write token: {e}"))
            })?;
        }
        let output = child
            .wait_with_output()
            .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run security: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(GitnadoError::OperationFailed(format!(
                "Failed to store token: {stderr}"
            )));
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Chunk transparently: Windows Credential Manager caps a secret at 2560
        // bytes, which large Entra tokens exceed.
        crate::services::keyring_util::set(service, key, value)
            .map_err(|e| GitnadoError::OperationFailed(format!("Failed to store token: {e}")))?;
    }

    Ok(())
}

/// Read `key` from `service`; `Ok(None)` when absent.
fn read_keyring_token(service: &str, key: &str) -> Result<Option<String>> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("security")
            .args(["find-generic-password", "-s", service, "-a", key, "-w"])
            .output()
            .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run security: {e}")))?;

        if output.status.success() {
            let password = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if password.is_empty() {
                Ok(None)
            } else {
                Ok(Some(password))
            }
        } else {
            // Item not found
            Ok(None)
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        crate::services::keyring_util::get(service, key)
            .map_err(|e| GitnadoError::OperationFailed(format!("Failed to get token: {e}")))
    }
}

/// Remove `key` from `service`. A missing entry is not an error.
fn remove_keyring_token(service: &str, key: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("security")
            .args(["delete-generic-password", "-s", service, "-a", key])
            .output();
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Removes the primary entry and any chunk entries a large token created.
        crate::services::keyring_util::delete(service, key)
            .map_err(|e| GitnadoError::OperationFailed(format!("Failed to delete token: {e}")))
    }
}

/// Read `key` under `service`, falling back to `legacy_service`. A legacy hit is
/// re-stored under `service` and the old entry removed, so the fallback is taken
/// once per key. The backend is passed in so the logic is unit-tested.
fn read_with_legacy_fallback(
    service: &str,
    legacy_service: &str,
    key: &str,
    read: impl Fn(&str, &str) -> Result<Option<String>>,
    write: impl Fn(&str, &str, &str) -> Result<()>,
    remove: impl Fn(&str, &str) -> Result<()>,
) -> Result<Option<String>> {
    if let Some(value) = read(service, key)? {
        return Ok(Some(value));
    }
    let Some(value) = read(legacy_service, key)? else {
        return Ok(None);
    };
    write(service, key, &value)?;
    if let Err(e) = remove(legacy_service, key) {
        tracing::warn!(
            "Adopted legacy keyring token for {} but could not remove the old entry: {}",
            key,
            e
        );
    }
    Ok(Some(value))
}

/// Store an integration token in the system keyring.
#[command]
pub async fn store_keyring_token(key: String, value: String) -> Result<()> {
    write_keyring_token(INTEGRATION_SERVICE, &key, &value)?;
    tracing::debug!("Stored keyring token for key: {}", key);
    Ok(())
}

/// Retrieve an integration token from the system keyring, adopting one stored
/// under the pre-rename service name if that is where it lives.
#[command]
pub async fn get_keyring_token(key: String) -> Result<Option<String>> {
    read_with_legacy_fallback(
        INTEGRATION_SERVICE,
        LEGACY_INTEGRATION_SERVICE,
        &key,
        read_keyring_token,
        write_keyring_token,
        remove_keyring_token,
    )
}

/// Delete an integration token from the system keyring, under both the current
/// and the pre-rename service name.
#[command]
pub async fn delete_keyring_token(key: String) -> Result<()> {
    remove_keyring_token(INTEGRATION_SERVICE, &key)?;
    remove_keyring_token(LEGACY_INTEGRATION_SERVICE, &key)?;
    tracing::debug!("Deleted keyring token for key: {}", key);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;
    use tempfile::TempDir;

    #[test]
    fn test_extract_helper_name_simple() {
        assert_eq!(extract_helper_name("osxkeychain"), "osxkeychain");
        assert_eq!(extract_helper_name("manager-core"), "manager-core");
        assert_eq!(extract_helper_name("store"), "store");
        assert_eq!(extract_helper_name("cache"), "cache");
    }

    #[test]
    fn test_extract_helper_name_with_path() {
        assert_eq!(
            extract_helper_name("/usr/local/bin/git-credential-helper"),
            "git-credential-helper"
        );
        assert_eq!(
            extract_helper_name("/path/to/custom-helper"),
            "custom-helper"
        );
    }

    #[test]
    fn test_extract_helper_name_with_bang() {
        assert_eq!(extract_helper_name("!helper"), "helper");
        assert_eq!(extract_helper_name("!/path/to/helper"), "helper");
    }

    #[test]
    fn test_extract_helper_name_with_args() {
        assert_eq!(extract_helper_name("cache --timeout=3600"), "cache");
        assert_eq!(
            extract_helper_name("store --file ~/.git-credentials"),
            "store"
        );
    }

    #[test]
    fn test_extract_host_https() {
        assert_eq!(
            extract_host("https://github.com/user/repo.git"),
            "github.com"
        );
        assert_eq!(extract_host("https://gitlab.com/user/repo"), "gitlab.com");
        assert_eq!(
            extract_host("https://bitbucket.org/user/repo.git"),
            "bitbucket.org"
        );
    }

    #[test]
    fn test_extract_host_http() {
        assert_eq!(
            extract_host("http://github.com/user/repo.git"),
            "github.com"
        );
        assert_eq!(
            extract_host("http://internal-git.company.com/repo"),
            "internal-git.company.com"
        );
    }

    #[test]
    fn test_extract_host_ssh() {
        assert_eq!(extract_host("git@github.com:user/repo.git"), "github.com");
        assert_eq!(
            extract_host("git@gitlab.com:group/project.git"),
            "gitlab.com"
        );
    }

    #[test]
    fn test_extract_host_ssh_url() {
        assert_eq!(
            extract_host("ssh://git@github.com/user/repo.git"),
            "github.com"
        );
    }

    #[test]
    fn test_extract_ssh_username_github() {
        assert_eq!(
            extract_ssh_username("Hi testuser! You've successfully authenticated"),
            Some("testuser".to_string())
        );
    }

    #[test]
    fn test_extract_ssh_username_gitlab() {
        assert_eq!(
            extract_ssh_username("Welcome to GitLab, @testuser!"),
            Some("testuser".to_string())
        );
    }

    #[test]
    fn test_extract_ssh_username_bitbucket() {
        assert_eq!(
            extract_ssh_username("logged in as testuser."),
            Some("testuser".to_string())
        );
    }

    #[test]
    fn test_extract_ssh_username_no_match() {
        assert_eq!(extract_ssh_username("Connection refused"), None);
        assert_eq!(extract_ssh_username("Permission denied"), None);
    }

    #[tokio::test]
    async fn test_get_credential_helpers() {
        let repo = TestRepo::with_initial_commit();
        let result = get_credential_helpers(repo.path_str()).await;
        assert!(result.is_ok());
        // Result may or may not have helpers depending on system config
        let _helpers = result.unwrap();
    }

    #[tokio::test]
    async fn test_set_credential_helper_local() {
        let repo = TestRepo::with_initial_commit();

        // Set a local credential helper
        let result = set_credential_helper(
            Some(repo.path_str()),
            "cache".to_string(),
            Some(false),
            None,
        )
        .await;
        assert!(result.is_ok());

        // Verify it was set
        let helpers = get_credential_helpers(repo.path_str()).await.unwrap();
        let local_helper = helpers.iter().find(|h| h.scope == "local");
        assert!(local_helper.is_some());
        assert_eq!(local_helper.unwrap().name, "cache");
    }

    #[tokio::test]
    async fn test_unset_credential_helper_local() {
        let repo = TestRepo::with_initial_commit();

        // First set a helper
        set_credential_helper(
            Some(repo.path_str()),
            "cache".to_string(),
            Some(false),
            None,
        )
        .await
        .unwrap();

        // Then unset it
        let result = unset_credential_helper(Some(repo.path_str()), Some(false), None).await;
        assert!(result.is_ok());

        // Verify it was unset
        let helpers = get_credential_helpers(repo.path_str()).await.unwrap();
        let local_helper = helpers.iter().find(|h| h.scope == "local");
        assert!(local_helper.is_none());
    }

    #[tokio::test]
    async fn test_url_credential_helper_reports_config_scope() {
        let repo = TestRepo::with_initial_commit();

        set_credential_helper(
            Some(repo.path_str()),
            "cache".to_string(),
            Some(false),
            Some("https://gitnado-scope.example".to_string()),
        )
        .await
        .unwrap();

        let helpers = get_credential_helpers(repo.path_str()).await.unwrap();
        let url_helper = helpers
            .iter()
            .find(|h| {
                h.scope == "url"
                    && h.url_pattern.as_deref() == Some("https://gitnado-scope.example")
            })
            .expect("URL-scoped helper should be listed");

        // The helper was written to the repository's own config file, so that
        // is the file a removal has to target.
        assert_eq!(url_helper.config_scope, "local");
    }

    #[tokio::test]
    async fn test_unset_credential_helper_requires_repo_path() {
        // No path and not global: there is no repository to edit, and git would
        // fall back to the process's working directory.
        let result = unset_credential_helper(
            None,
            Some(false),
            Some("https://gitnado-scope.example".to_string()),
        )
        .await;

        assert!(
            result.is_err(),
            "removal without a repository must be refused"
        );
    }

    #[tokio::test]
    async fn test_unset_credential_helper_surfaces_git_failure() {
        // A plain directory, not a repository: `git config --local` fails here.
        let dir = TempDir::new().unwrap();

        let result = unset_credential_helper(
            Some(dir.path().to_string_lossy().into_owned()),
            Some(false),
            Some("https://gitnado-scope.example".to_string()),
        )
        .await;

        let err = result.expect_err("git's failure must reach the caller");
        assert!(
            !err.to_string().is_empty(),
            "the error must carry a message for the UI"
        );
    }

    #[tokio::test]
    async fn test_unset_credential_helper_missing_key_is_noop() {
        let repo = TestRepo::with_initial_commit();

        // Removing a helper that was never configured is a no-op, not an error
        // (git exits 5 for an unset key).
        let result = unset_credential_helper(
            Some(repo.path_str()),
            Some(false),
            Some("https://never.example".to_string()),
        )
        .await;

        assert!(result.is_ok(), "unsetting a missing key should succeed");
    }

    #[tokio::test]
    async fn test_unset_url_credential_helper_removes_local_entry() {
        let repo = TestRepo::with_initial_commit();

        set_credential_helper(
            Some(repo.path_str()),
            "cache".to_string(),
            Some(false),
            Some("https://gitnado-remove.example".to_string()),
        )
        .await
        .unwrap();

        unset_credential_helper(
            Some(repo.path_str()),
            Some(false),
            Some("https://gitnado-remove.example".to_string()),
        )
        .await
        .unwrap();

        let helpers = get_credential_helpers(repo.path_str()).await.unwrap();
        assert!(
            !helpers
                .iter()
                .any(|h| h.url_pattern.as_deref() == Some("https://gitnado-remove.example")),
            "the URL-scoped helper should be gone from the listing"
        );
    }

    #[tokio::test]
    async fn test_unset_credential_helper_in_included_file_is_refused() {
        let repo = TestRepo::with_initial_commit();

        // A helper written in a file that the repository config merely
        // `include`s. git attributes it to the "local" scope, but `--local
        // --unset` only edits .git/config, so it cannot reach this value.
        let included = repo.path.join("included.config");
        std::fs::write(
            &included,
            "[credential \"https://included.example\"]\n\thelper = cache\n",
        )
        .unwrap();
        run_git_config(
            Some(&repo.path),
            &["--local", "include.path", "../included.config"],
        )
        .unwrap();

        let listed = get_credential_helpers(repo.path_str()).await.unwrap();
        let helper = listed
            .iter()
            .find(|h| h.url_pattern.as_deref() == Some("https://included.example"))
            .expect("an included helper is still part of the merged config");
        assert_eq!(
            helper.config_scope, "local",
            "git reports the including file's scope, which is what makes this silent"
        );

        let err = unset_credential_helper(
            Some(repo.path_str()),
            Some(false),
            Some("https://included.example".to_string()),
        )
        .await
        .expect_err("a removal that cannot reach the value must not report success");

        let message = err.to_string();
        assert!(
            message.contains("included.config"),
            "the error must name the file to edit, got: {}",
            message
        );

        // The real point: the helper is still active, so claiming success would
        // send the user round the same dialog forever.
        let after = get_credential_helpers(repo.path_str()).await.unwrap();
        assert!(
            after
                .iter()
                .any(|h| h.url_pattern.as_deref() == Some("https://included.example")),
            "the helper is still configured after the failed removal"
        );
    }

    #[tokio::test]
    async fn test_unset_credential_helper_ignores_other_scopes() {
        let repo = TestRepo::with_initial_commit();

        // A URL helper genuinely in .git/config, plus an unrelated included
        // credential key. The removal must succeed: the leftover check has to
        // match the key exactly and only within the scope it aimed at.
        let included = repo.path.join("other.config");
        std::fs::write(&included, "[credential]\n\tuseHttpPath = true\n").unwrap();
        run_git_config(
            Some(&repo.path),
            &["--local", "include.path", "../other.config"],
        )
        .unwrap();

        set_credential_helper(
            Some(repo.path_str()),
            "cache".to_string(),
            Some(false),
            Some("https://plain.example".to_string()),
        )
        .await
        .unwrap();

        unset_credential_helper(
            Some(repo.path_str()),
            Some(false),
            Some("https://plain.example".to_string()),
        )
        .await
        .expect("a reachable helper must still be removable");

        let after = get_credential_helpers(repo.path_str()).await.unwrap();
        assert!(
            !after
                .iter()
                .any(|h| h.url_pattern.as_deref() == Some("https://plain.example")),
            "the helper should be gone"
        );
    }

    #[tokio::test]
    async fn test_set_credential_helper_with_url_pattern() {
        let repo = TestRepo::with_initial_commit();

        // Set a URL-specific helper
        let result = set_credential_helper(
            Some(repo.path_str()),
            "cache".to_string(),
            Some(false),
            Some("https://github.com".to_string()),
        )
        .await;
        assert!(result.is_ok());

        // Verify it was set
        let helpers = get_credential_helpers(repo.path_str()).await.unwrap();
        let url_helper = helpers
            .iter()
            .find(|h| h.scope == "url" && h.url_pattern.as_deref() == Some("https://github.com"));
        assert!(url_helper.is_some());
    }

    #[tokio::test]
    async fn test_get_available_helpers() {
        let result = get_available_helpers().await;
        assert!(result.is_ok());

        let helpers = result.unwrap();
        // Should always have cache and store as available
        let cache_helper = helpers.iter().find(|h| h.name == "cache");
        let store_helper = helpers.iter().find(|h| h.name == "store");

        assert!(cache_helper.is_some());
        assert!(store_helper.is_some());
        assert!(cache_helper.unwrap().available);
        assert!(store_helper.unwrap().available);
    }

    #[tokio::test]
    async fn test_erase_credentials() {
        let repo = TestRepo::with_initial_commit();

        // This should not fail even if no credentials exist
        let result = erase_credentials(
            repo.path_str(),
            "github.com".to_string(),
            "https".to_string(),
        )
        .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_credential_helper_struct() {
        let helper = CredentialHelper {
            name: "cache".to_string(),
            command: "cache --timeout=3600".to_string(),
            scope: "local".to_string(),
            config_scope: "local".to_string(),
            url_pattern: None,
        };

        assert_eq!(helper.name, "cache");
        assert_eq!(helper.scope, "local");
        assert_eq!(helper.config_scope, "local");
        assert!(helper.url_pattern.is_none());
    }

    #[tokio::test]
    async fn test_credential_test_result_struct() {
        let result = CredentialTestResult {
            success: true,
            host: "github.com".to_string(),
            protocol: "https".to_string(),
            username: Some("testuser".to_string()),
            message: "Credentials found".to_string(),
        };

        assert!(result.success);
        assert_eq!(result.host, "github.com");
        assert_eq!(result.protocol, "https");
        assert_eq!(result.username, Some("testuser".to_string()));
    }

    #[tokio::test]
    async fn test_available_helper_struct() {
        let helper = AvailableHelper {
            name: "osxkeychain".to_string(),
            description: "macOS Keychain".to_string(),
            available: true,
        };

        assert_eq!(helper.name, "osxkeychain");
        assert!(helper.available);
    }

    // ========================================================================
    // M2: URL sanitization tests
    // ========================================================================

    /// A URL carrying a PAT/token in the userinfo component must not appear
    /// verbatim in the sanitized form.  The logged string must contain neither
    /// the secret token nor the `@` separator that precedes the host.
    #[test]
    fn test_sanitize_url_strips_token() {
        let url = "https://ghp_secret@github.com/org/repo";
        let sanitized = sanitize_url_for_log(url);

        assert!(
            !sanitized.contains("ghp_secret"),
            "secret token must not appear in log: {}",
            sanitized
        );
        assert!(
            !sanitized.contains('@'),
            "@ separator must not appear in log: {}",
            sanitized
        );
        // Useful host/path information must be retained.
        assert!(
            sanitized.contains("github.com"),
            "host must be retained: {}",
            sanitized
        );
        assert!(
            sanitized.contains("org/repo"),
            "path must be retained: {}",
            sanitized
        );
    }

    /// A plain URL without credentials must pass through unchanged.
    #[test]
    fn test_sanitize_url_plain_url_unchanged() {
        let url = "https://github.com/org/repo";
        let sanitized = sanitize_url_for_log(url);
        assert_eq!(sanitized, url);
    }

    /// SSH `git@host:path` URLs contain an `@` but carry no password; the
    /// function must not strip the host (the `@` is in the authority, not in
    /// a `scheme://` segment).
    #[test]
    fn test_sanitize_url_ssh_git_at_host() {
        let url = "git@github.com:org/repo.git";
        // No scheme means the function returns the URL unchanged.
        let sanitized = sanitize_url_for_log(url);
        assert_eq!(sanitized, url);
    }

    /// When there is no `@` in the authority the URL must be returned verbatim.
    #[test]
    fn test_sanitize_url_no_credentials() {
        let url = "https://example.com/path";
        assert_eq!(sanitize_url_for_log(url), url);
    }

    /// git's stderr embeds the URL in prose. The credential must be stripped
    /// while the surrounding text — which is the whole diagnostic value of the
    /// message — survives intact.
    #[test]
    fn test_redact_credentials_in_text_strips_userinfo_from_embedded_urls() {
        assert_eq!(
            redact_credentials_in_text(
                "fatal: repository 'https://x-access-token:ghp_s3cret@github.com/o/r.git' not found"
            ),
            "fatal: repository 'https://github.com/o/r.git' not found"
        );
    }

    /// Several URLs in one message must all be redacted, and a password that
    /// itself contains `@` must not leave its tail behind.
    #[test]
    fn test_redact_credentials_in_text_handles_multiple_urls_and_at_in_password() {
        let redacted = redact_credentials_in_text(
            "warning: https://u:p@ss@host.example/a failed, retrying https://tok:s3cret@other.example/b",
        );

        assert!(!redacted.contains("p@ss"), "password leaked: {}", redacted);
        assert!(!redacted.contains("s3cret"), "token leaked: {}", redacted);
        assert!(redacted.contains("https://host.example/a"), "{}", redacted);
        assert!(redacted.contains("https://other.example/b"), "{}", redacted);
    }

    /// No false positives: text with no credentials must come back byte-for-byte.
    #[test]
    fn test_redact_credentials_in_text_leaves_credential_free_text_untouched() {
        for text in [
            "error: pathspec 'foo' did not match",
            "https://github.com/o/r.git",
            // The `@` is in the path, not the authority.
            "https://github.com/o/a@b.txt",
            // SCP form carries no password.
            "git@github.com:o/r.git",
        ] {
            assert_eq!(redact_credentials_in_text(text), text);
        }
    }

    // ========================================================================
    // M3: build_security_add_args tests (macOS-targeted; run on all platforms
    // since the function is pub(crate) and available everywhere)
    // ========================================================================

    #[cfg(target_os = "macos")]
    #[test]
    fn test_build_security_add_args_release_omits_a_flag() {
        // We cannot change the compilation mode at test time, but we can
        // document and assert the expected shape for the current build type.
        let args = build_security_add_args("svc", "key");

        // `-A` should be present only in debug builds.
        let has_a = args.contains(&"-A");
        if cfg!(debug_assertions) {
            assert!(has_a, "debug build: -A should be present");
        } else {
            assert!(!has_a, "release build: -A must be absent");
        }

        // Common args must always be present regardless of build type.
        assert!(args.contains(&"add-generic-password"));
        assert!(args.contains(&"-s"));
        assert!(args.contains(&"svc"));
        assert!(args.contains(&"-a"));
        assert!(args.contains(&"key"));
        assert!(args.contains(&"-U"));
        assert!(args.contains(&"-w"));
    }

    // ========================================================================
    // M4: input validation tests
    // ========================================================================

    /// A newline embedded in `url_pattern` must be rejected (git config injection).
    #[test]
    fn test_validate_url_pattern_rejects_newline() {
        let result = validate_url_pattern("https://github.com\n[core]\n  sshCommand=evil");
        assert!(result.is_err(), "newline must be rejected");
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("invalid control character") || msg.contains("disallowed character"),
            "unexpected error message: {}",
            msg
        );
    }

    /// A quote character in `url_pattern` must be rejected.
    #[test]
    fn test_validate_url_pattern_rejects_quote() {
        let result = validate_url_pattern("https://github.com\"injection");
        assert!(result.is_err(), "double-quote must be rejected");

        let result2 = validate_url_pattern("https://github.com'injection");
        assert!(result2.is_err(), "single-quote must be rejected");
    }

    /// A whitespace character (space/tab) in `url_pattern` must be rejected.
    #[test]
    fn test_validate_url_pattern_rejects_whitespace() {
        let result = validate_url_pattern("https://github.com evil");
        assert!(result.is_err(), "space must be rejected");
    }

    /// A well-formed URL pattern that uses only the allowed character set must pass.
    #[test]
    fn test_validate_url_pattern_accepts_valid() {
        assert!(validate_url_pattern("https://github.com").is_ok());
        assert!(validate_url_pattern("github.com").is_ok());
        assert!(validate_url_pattern("https://github.com/org/repo*").is_ok());
        assert!(validate_url_pattern("ssh://git@github.com").is_ok());
    }

    /// Empty pattern must be rejected.
    #[test]
    fn test_validate_url_pattern_rejects_empty() {
        assert!(validate_url_pattern("").is_err());
    }

    /// A newline in `helper` must be rejected.
    #[test]
    fn test_validate_helper_rejects_newline() {
        let result = validate_helper("osxkeychain\nevil");
        assert!(result.is_err(), "newline in helper must be rejected");
    }

    /// A carriage return (control char) in `helper` must be rejected — this is
    /// the real config-injection vector, not punctuation like quotes/colons.
    #[test]
    fn test_validate_helper_rejects_control_char() {
        assert!(validate_helper("osxkeychain\revil").is_err());
        assert!(validate_helper("osxkeychain\u{0000}evil").is_err());
    }

    /// Normal names, paths (incl. Windows), flags, and shell helpers — which can
    /// legitimately contain `:`, `\`, quotes, `$` — must all be accepted.
    #[test]
    fn test_validate_helper_accepts_valid() {
        assert!(validate_helper("osxkeychain").is_ok());
        assert!(validate_helper("manager-core").is_ok());
        assert!(validate_helper("cache --timeout=3600").is_ok());
        assert!(validate_helper("/usr/local/bin/git-credential-manager").is_ok());
        assert!(validate_helper("!/path/to/helper").is_ok());
        // Windows absolute paths (the regression the reviewer flagged).
        assert!(validate_helper("C:\\Program Files\\Git\\git-credential-manager.exe").is_ok());
        assert!(validate_helper("C:/Program Files/Git/git-credential-manager.exe").is_ok());
        // Shell credential helpers may contain quotes / `$` / `:`.
        assert!(validate_helper("!aws codecommit credential-helper $@").is_ok());
        assert!(validate_helper("!f() { echo \"username=x\"; }; f").is_ok());
    }

    /// Empty helper must be rejected.
    #[test]
    fn test_validate_helper_rejects_empty() {
        assert!(validate_helper("").is_err());
    }

    /// `set_credential_helper` must reject a url_pattern containing a newline.
    #[tokio::test]
    async fn test_set_credential_helper_rejects_injected_url_pattern() {
        let result = set_credential_helper(
            None,
            "osxkeychain".to_string(),
            None,
            Some("https://github.com\nevil".to_string()),
        )
        .await;
        assert!(result.is_err(), "injected url_pattern must be rejected");
    }

    /// `set_credential_helper` must reject a helper containing a newline.
    #[tokio::test]
    async fn test_set_credential_helper_rejects_injected_helper() {
        let result = set_credential_helper(None, "osxkeychain\nevil".to_string(), None, None).await;
        assert!(result.is_err(), "injected helper must be rejected");
    }
    // --- legacy service-name fallback -------------------------------------

    type FakeKeyring =
        std::rc::Rc<std::cell::RefCell<std::collections::HashMap<(String, String), String>>>;

    fn read_fallback(store: &FakeKeyring, key: &str, write_fails: bool) -> Result<Option<String>> {
        let r = store.clone();
        let w = store.clone();
        let d = store.clone();
        read_with_legacy_fallback(
            "gitnado-integrations",
            "leviathan-integrations",
            key,
            move |s, k| Ok(r.borrow().get(&(s.to_string(), k.to_string())).cloned()),
            move |s, k, v| {
                if write_fails {
                    return Err(GitnadoError::OperationFailed("write failed".into()));
                }
                w.borrow_mut()
                    .insert((s.to_string(), k.to_string()), v.to_string());
                Ok(())
            },
            move |s, k| {
                d.borrow_mut().remove(&(s.to_string(), k.to_string()));
                Ok(())
            },
        )
    }

    #[test]
    fn token_fallback_prefers_current_service() {
        let store: FakeKeyring = Default::default();
        store.borrow_mut().insert(
            ("gitnado-integrations".into(), "github".into()),
            "new".into(),
        );
        store.borrow_mut().insert(
            ("leviathan-integrations".into(), "github".into()),
            "old".into(),
        );
        assert_eq!(
            read_fallback(&store, "github", false).unwrap().as_deref(),
            Some("new")
        );
        assert_eq!(store.borrow().len(), 2, "nothing is touched");
    }

    #[test]
    fn token_fallback_adopts_legacy_token_once() {
        let store: FakeKeyring = Default::default();
        store.borrow_mut().insert(
            ("leviathan-integrations".into(), "gitlab".into()),
            "tok".into(),
        );

        assert_eq!(
            read_fallback(&store, "gitlab", false).unwrap().as_deref(),
            Some("tok")
        );
        {
            let s = store.borrow();
            assert_eq!(
                s.get(&("gitnado-integrations".into(), "gitlab".into()))
                    .map(String::as_str),
                Some("tok")
            );
            assert!(!s.contains_key(&("leviathan-integrations".into(), "gitlab".into())));
        }
        // Second read is served from the current service.
        assert_eq!(
            read_fallback(&store, "gitlab", false).unwrap().as_deref(),
            Some("tok")
        );
    }

    #[test]
    fn token_fallback_propagates_write_failure_and_keeps_legacy() {
        let store: FakeKeyring = Default::default();
        store.borrow_mut().insert(
            ("leviathan-integrations".into(), "jira".into()),
            "tok".into(),
        );
        assert!(read_fallback(&store, "jira", true).is_err());
        assert!(store
            .borrow()
            .contains_key(&("leviathan-integrations".into(), "jira".into())));
    }

    #[test]
    fn token_fallback_none_when_absent_everywhere() {
        let store: FakeKeyring = Default::default();
        assert_eq!(read_fallback(&store, "bitbucket", false).unwrap(), None);
        assert!(store.borrow().is_empty());
    }
}

// ========================================================================
// Git Credential Manager Detection
// ========================================================================

/// Status of the system's credential manager
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialManagerStatus {
    pub gcm_available: bool,
    pub gcm_version: Option<String>,
    pub configured_helper: Option<String>,
    pub using_gitnado_fallback: bool,
}

/// Detect the system's Git Credential Manager and its configuration
#[command]
pub async fn detect_credential_manager(path: String) -> Result<CredentialManagerStatus> {
    // Check for GCM by running `git credential-manager --version`
    let gcm_result = std::process::Command::new("git")
        .arg("credential-manager")
        .arg("--version")
        .output();

    let (gcm_available, gcm_version) = match gcm_result {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            (true, Some(version))
        }
        _ => (false, None),
    };

    // Check configured credential helper in git config
    let helper_result = std::process::Command::new("git")
        .arg("-C")
        .arg(&path)
        .arg("config")
        .arg("--get")
        .arg("credential.helper")
        .output();

    let configured_helper = match helper_result {
        Ok(output) if output.status.success() => {
            let helper = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if helper.is_empty() {
                None
            } else {
                Some(helper)
            }
        }
        _ => None,
    };

    // Also check global config if local didn't find anything
    let configured_helper = configured_helper.or_else(|| {
        std::process::Command::new("git")
            .arg("config")
            .arg("--global")
            .arg("--get")
            .arg("credential.helper")
            .output()
            .ok()
            .and_then(|output| {
                if output.status.success() {
                    let helper = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if helper.is_empty() {
                        None
                    } else {
                        Some(helper)
                    }
                } else {
                    None
                }
            })
    });

    let using_gitnado_fallback = !gcm_available && configured_helper.is_none();

    Ok(CredentialManagerStatus {
        gcm_available,
        gcm_version,
        configured_helper,
        using_gitnado_fallback,
    })
}
