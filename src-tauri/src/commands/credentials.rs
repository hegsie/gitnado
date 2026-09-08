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
    /// Whether `host` is the remote AS TYPED — a path standing in for a host
    /// there is none of — rather than a hostname to connect to.
    ///
    /// The dialog labels the field "Path" instead of "Host" and says nothing
    /// is stored for it, and it used to work this out from `protocol == "file"`
    /// alone. That is not the rule: `file://server/share/repo.git` keeps its
    /// `file` scheme while resolving a real host, which is exactly the target
    /// the network gate refuses as one that leaves the machine — and the
    /// dialog drew it as a local path anyway. Only the backend can tell the
    /// two apart (`resolved`), so it says so here instead of leaving the
    /// frontend to guess.
    pub is_path_target: bool,
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
    // The SSH branch below opens a real connection to the remote, exactly as
    // `test_ssh_connection` does — and that one guards here as well as in the
    // frontend. This command was gated on the frontend only, leaving the one
    // network-reaching path in the app whose enforcement had no backstop.
    //
    // The HTTPS branch is guarded too, deliberately. `git credential fill` is
    // not reliably local: a configured `credential.helper` such as Git
    // Credential Manager performs an OAuth round trip to the host on a cache
    // miss, so "HTTPS stays on this machine" is a property of the user's
    // helper configuration rather than of this command. Under an explicitly
    // configured policy, refusing is the right side to err on.
    crate::services::security::guard_remote_url(&remote_url)?;

    let repo_path = Path::new(&path);

    let target = credential_target(&remote_url);
    // Worked out from the whole target, before it is taken apart, so the
    // question put to the credential helper is the one the result reports.
    let lookup = credential_lookup_query(&target);
    // What the dialog needs and cannot work out for itself: whether the `host`
    // it is about to print is a hostname or the remote as typed.
    let is_path_target = target.is_path();
    let CredentialTarget {
        protocol,
        display_host: host,
        ssh_destination,
        port,
        resolved,
    } = target;

    // `resolved` guards the probe: an unresolved target's "destination" is the
    // remote string itself, which is not a host to connect to.
    if protocol == "ssh" && resolved {
        // For SSH, test the connection
        let mut command = create_command("ssh");
        command.args(ssh_probe_args());
        if let Some(port) = port {
            command.args(["-p".to_string(), port.to_string()]);
        }
        let output = command.arg(&ssh_destination).output().map_err(|e| {
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
            is_path_target,
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
            let _ = stdin.write_all(lookup.as_bytes());
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
            is_path_target,
        })
    }
}

/// Where a credential test is going.
///
/// Worked out with the SAME parse the network gate above uses, so the host the
/// allowlist judged is the host that is then contacted. Deciding the protocol on
/// `starts_with("git@")` instead reported every scp-form remote with another
/// login — `deploy@git.example.test:team/app.git`, an ordinary corporate remote
/// — as HTTPS: `git credential fill` was asked about a host that has no HTTPS
/// credentials, the dialog reported "No credentials found" for a remote that
/// works, and the erase button then offered to drop `https` credentials that
/// were never in play. Reading the host after the LAST `@` was worse still —
/// the gate reads the FIRST, as git does — so a URL whose two differ passed the
/// allowlist as one host and opened a connection to another.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CredentialTarget {
    /// `ssh`, or the URL's own scheme. The dialog shows it and hands it back to
    /// `erase_credentials`, so it has to name the protocol the credential was
    /// actually looked up under.
    protocol: String,
    /// What the dialog shows, and what `git credential` is asked about. git's
    /// `host` field carries the port, so this does too.
    display_host: String,
    /// `[user@]host` for `ssh`, keeping the login the URL named.
    ssh_destination: String,
    /// The port for `ssh -p`, when the URL named one.
    port: Option<u16>,
    /// Whether `parse_target` recognised the remote at all.
    ///
    /// When it did not, `ssh_destination` is the whole remote string standing
    /// in for a host it has none of, so an `ssh`-schemed one must never reach
    /// the ssh probe: `ssh -T ssh://` has nothing to connect to.
    resolved: bool,
}

impl CredentialTarget {
    /// Whether `display_host` is the remote AS TYPED — a path standing in for a
    /// host there is none of — rather than a hostname to connect to.
    ///
    /// Not `protocol == "file"` on its own: `file://server/share/repo.git`
    /// keeps its `file` scheme while resolving a real host, and that is
    /// precisely the target the network gate refuses as one that leaves the
    /// machine. `resolved` is the half that tells them apart, and it never
    /// crossed the IPC boundary — so the dialog drew that URL as a local path.
    fn is_path(&self) -> bool {
        !self.resolved && self.protocol == "file"
    }
}

/// The request written to `git credential fill`'s stdin for a target.
///
/// The protocol is the target's own, not a fixed `https`. Asking about `https`
/// while REPORTING the URL's scheme made the two halves disagree: an
/// `http://` remote with a working stored credential came back "No Credentials
/// Found", and an unrelated `https` credential for the same host came back
/// "Credentials Working / Protocol: http" — with an erase button pointed at
/// `protocol=http`, which matches nothing.
fn credential_lookup_query(target: &CredentialTarget) -> String {
    credential_query(&target.protocol, &target.display_host)
}

/// A `git credential` request for one protocol/host pair. `erase_credentials`
/// writes the same shape, so a credential found by the test is the credential
/// the erase button then rejects.
fn credential_query(protocol: &str, host: &str) -> String {
    format!("protocol={}\nhost={}\n\n", protocol, host)
}

fn credential_target(remote_url: &str) -> CredentialTarget {
    let trimmed_url = remote_url.trim();
    // A scheme-less path is a repository on this machine, and `git clone
    // /srv/git/bare.git` leaves `origin` in exactly that form. `parse_target`
    // resolves one all the same — its fallback reads the string as
    // `https://{}` and the WHATWG special-scheme parse skips the extra slashes
    // — so this reported a host invented from a path: `srv` for
    // `/srv/git/repo.git`, `c` for `C:\repos\x.git`, `..` for a relative
    // submodule remote. The user was sent to fix HTTPS credentials for a host
    // that appears nowhere in their config, while the SAME repository spelled
    // `file:///srv/git/repo.git` was correctly told nothing is stored for it.
    //
    // WHICH strings are paths is `security::is_local_target`'s answer, not a
    // second parse of this question: the gate uses it to decide that a target
    // never leaves the machine, and a private copy here disagreed with it in
    // both directions. `\\server\share\repo.git` and `//server/share/repo.git`
    // are SMB and `~deploy@host:team/app.git` is an scp-form ssh remote — the
    // gate refuses all three under offline mode as things that DO leave the
    // machine, while this dialog called them local repositories that "do not
    // authenticate", and silently skipped the ssh probe for a working ssh
    // remote. One string, one answer.
    //
    // The GATE is untouched: `parse_target` is still the one parse the
    // allowlist and the destination share, and it still resolves these to the
    // host it always did. This is what the DIALOG reports, and it must not
    // name a value the user cannot find anywhere.
    if crate::services::security::is_local_remote_target(trimmed_url) {
        return CredentialTarget {
            protocol: "file".to_string(),
            ssh_destination: trimmed_url.to_string(),
            display_host: trimmed_url.to_string(),
            port: None,
            resolved: false,
        };
    }

    // A UNC path is the one string the gate calls non-local that git still
    // opens as a PATH. `is_local_target` excludes it on purpose — SMB puts
    // bytes on the wire, so offline mode has to go on refusing it — but git
    // never consults a credential helper for `\\server\share\repo.git`: the OS
    // redirector opens it, under git's own `file` protocol (the one
    // `protocol.file.allow` names). Falling through to `parse_target` invented
    // an https host out of it: the scheme-less fallback parses
    // `https://\\server\share\repo.git`, WHATWG "special authority ignore
    // slashes" eats the backslashes, and the dialog reported "host: server,
    // protocol: https". A working share was drawn in the failure colours, and
    // where the user really did have an `https://server/…` credential — an
    // internal Gitea on the same box name — the panel said "Credentials
    // Working" and offered an Erase button that rejected THAT credential.
    //
    // The GATE is untouched: `is_local_target` still refuses UNC under offline
    // mode, and `parse_target` still resolves it to the host the allowlist has
    // always judged. This is what the DIALOG reports.
    if is_unc_path(trimmed_url) {
        return CredentialTarget {
            protocol: "file".to_string(),
            ssh_destination: trimmed_url.to_string(),
            display_host: trimmed_url.to_string(),
            port: None,
            resolved: false,
        };
    }

    let Some(target) = crate::services::security::parse_remote_target(remote_url) else {
        // Nothing a URL parser recognises as `[user@]host`, and not a place on
        // this machine either — a remote too malformed for either half to make
        // sense of. Report it as typed rather than invent a host for it, and
        // keep the scheme the user wrote: substituting `https` reported a
        // scheme-carrying remote as "No credentials found ... Protocol: https"
        // under a protocol it does not use, and the dialog reads the protocol
        // reported here to decide whether a missing credential is a fault at
        // all — so a transport that stores nothing could never reach the
        // branch that says so.
        //
        // The GATE is untouched by this: `parse_target` above is still the one
        // parse the allowlist and the destination share, and a host-less remote
        // still resolves to no host and is still refused wherever an allowlist
        // is configured.
        let as_typed = remote_url.trim().to_string();
        return CredentialTarget {
            protocol: url_scheme(&as_typed).unwrap_or_else(|| "https".to_string()),
            ssh_destination: as_typed.clone(),
            display_host: as_typed,
            port: None,
            resolved: false,
        };
    };

    let display_host = match target.port {
        Some(port) => format!("{}:{}", target.host, port),
        None => target.host.clone(),
    };
    let protocol = if target.is_ssh {
        "ssh".to_string()
    } else {
        target.scheme.unwrap_or_else(|| "https".to_string())
    };
    // A remote that names no login is handed to `ssh` as the BARE host, which
    // is what git does with it: `ssh` then applies the `User` its own config
    // has for that host. Substituting `git` probed a different account than the
    // remote authenticates as — and the remote whose login lives in
    // `~/.ssh/config` rather than in the URL (`gitserver:team/app.git`, the
    // scp-like form with the login left off) is exactly the one that has none
    // to read here.
    let ssh_destination = match target.user.as_deref() {
        Some(login) => format!("{}@{}", login, target.host),
        None => target.host.clone(),
    };

    CredentialTarget {
        protocol,
        ssh_destination,
        display_host,
        port: target.port,
        resolved: true,
    }
}

/// A UNC path — `\\server\share\repo.git`, and its `//server/share/repo.git`
/// spelling. The same two prefixes [`crate::services::security::is_local_target`]
/// excludes, asked here for the opposite reason: not "does it leave the
/// machine" (it does) but "does git ask a credential helper for it" (it does
/// not — it is a path).
fn is_unc_path(target: &str) -> bool {
    target.starts_with("//") || target.starts_with(r"\\")
}

/// The scheme a remote string carries, if it carries one at all.
///
/// Only the scheme grammar is accepted — a letter followed by letters, digits
/// and `+-.` — so a remote that merely contains `://` somewhere is not read as
/// naming a protocol.
fn url_scheme(remote_url: &str) -> Option<String> {
    let (scheme, _) = remote_url.split_once("://")?;
    let mut chars = scheme.chars();
    if !chars.next()?.is_ascii_alphabetic() {
        return None;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
        return None;
    }
    Some(scheme.to_lowercase())
}

/// The `ssh -T` probe options.
///
/// `ConnectTimeout` counts as much as the rest: without it a user whose network
/// drops outbound :22 waits out the kernel's TCP timeout — around two minutes —
/// with the dialog stuck on "Testing". `test_ssh_connection` runs the same
/// probe and has always set one.
fn ssh_probe_args() -> [&'static str; 7] {
    [
        "-T",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
    ]
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
        let _ = stdin.write_all(credential_query(&protocol, &host).as_bytes());
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
/// re-stored under `service` and, once that write succeeded, removed from
/// `legacy_service` — so the fallback is taken once per key. The backend is
/// passed in so the logic is unit-tested.
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
    // A failed re-store is not a reason to throw away the token that WAS read.
    // `?` here meant an upgrading user whose keyring accepts reads but refuses
    // writes — a keychain that re-locks after a read, an entry-count limit, a
    // re-locked SecretService collection — got an error instead of the
    // credential sitting right there, and a working connected account read as
    // broken. The legacy entry stays put, so the next launch adopts it
    // properly. `credentials_service::get_with_legacy_fallback` does the same.
    if let Err(e) = write(service, key, &value) {
        tracing::warn!(
            "Found a legacy keyring token for {} but could not re-store it under {}: {}",
            key,
            service,
            e
        );
        return Ok(Some(value));
    }
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

    /// An scp-form remote whose login is not `git` is an ordinary corporate
    /// remote, and git reaches it over SSH. Classifying it as HTTPS ran
    /// `git credential fill` against a host that has no HTTPS credentials, told
    /// the user "No credentials found" about a remote that works, and then
    /// offered to erase `https` credentials that were never in play.
    #[test]
    fn an_scp_remote_with_another_login_is_tested_over_ssh_as_that_user() {
        let target = credential_target("deploy@git.example.test:team/app.git");
        assert_eq!(target.protocol, "ssh");
        assert_eq!(target.display_host, "git.example.test");
        assert_eq!(target.ssh_destination, "deploy@git.example.test");
    }

    /// An `ssh://` URL names its login too — CodeCommit's is an access-key id,
    /// and `git@` is not a substitute for it.
    #[test]
    fn an_ssh_url_is_tested_as_the_login_it_names() {
        let target = credential_target(
            "ssh://APKAEXAMPLEKEYID@git-codecommit.eu-west-1.amazonaws.com/v1/repos/app",
        );
        assert_eq!(target.protocol, "ssh");
        assert_eq!(
            target.ssh_destination,
            "APKAEXAMPLEKEYID@git-codecommit.eu-west-1.amazonaws.com"
        );
    }

    /// The host handed to `ssh` must be the host the allowlist judged.
    ///
    /// The gate reads the host after the FIRST `@`, which is the one git reads:
    /// `git@github.com:x@evil.test:y` is the path `x@evil.test:y` on
    /// `github.com`. Reading the LAST one here meant such a URL passed a
    /// `github.com` allowlist and then opened a connection to `evil.test`.
    #[test]
    fn the_host_contacted_is_the_host_the_gate_judged() {
        let url = "git@github.com:x@evil.test:y";
        let target = credential_target(url);
        assert_eq!(
            Some(target.display_host.as_str()),
            crate::services::security::url_host(url).as_deref(),
            "the gate and the destination must read one host"
        );
        assert_eq!(target.ssh_destination, "git@github.com");
    }

    /// A non-default port belongs in git's `host` field and on the ssh command
    /// line; dropping it asks the wrong server.
    #[test]
    fn a_port_survives_into_the_credential_lookup() {
        let https = credential_target("https://gitlab.example.test:8443/team/app.git");
        assert_eq!(https.protocol, "https");
        assert_eq!(https.display_host, "gitlab.example.test:8443");

        let ssh = credential_target("ssh://git@git.example.test:2222/team/app.git");
        assert_eq!(ssh.protocol, "ssh");
        assert_eq!(ssh.ssh_destination, "git@git.example.test");
        assert_eq!(ssh.port, Some(2222));
    }

    /// An `http://` remote is looked up under `http`. Reporting it as `https`
    /// asked the credential helper about a protocol the remote does not use,
    /// and pointed the erase button at that same wrong entry.
    #[test]
    fn an_http_remote_is_not_reported_as_https() {
        let target = credential_target("http://git.internal.test/team/app.git");
        assert_eq!(target.protocol, "http");
        assert_eq!(target.display_host, "git.internal.test");
        // The REPORTED protocol above is only half of it: the lookup handed to
        // `git credential fill` has to name the same one, or the dialog
        // describes an entry the helper was never asked about.
        assert_eq!(
            credential_query(&target.protocol, &target.display_host),
            "protocol=http\nhost=git.internal.test\n\n"
        );
    }

    /// A `file://` remote is not https.
    ///
    /// `parse_target` refuses a host-less URL — deliberately: the allowlist has
    /// to keep refusing one — and this fallback then substituted `https`, so a
    /// local remote was reported as "No credentials found ... Protocol: https"
    /// under a protocol it does not use. The dialog picks the wording AND the
    /// styling off the protocol reported here, so `file://` could never reach
    /// the branch written for it.
    #[test]
    fn a_file_url_keeps_its_own_scheme() {
        let target = credential_target("file:///srv/git/repo.git");
        assert_eq!(target.protocol, "file");
        // Reported as typed: there is no host to invent one from.
        assert_eq!(target.display_host, "file:///srv/git/repo.git");
    }

    /// A scheme-less local path is a path, not a host.
    ///
    /// `parse_target` resolves one all the same: its fallback reads the string
    /// as `https://{}`, and the WHATWG special-scheme parse skips the extra
    /// slashes, so `/srv/git/repo.git` comes back as the host `srv`,
    /// `C:\repos\x.git` as `c` and a relative submodule remote
    /// `../sibling.git` as `..`. `git clone /srv/git/bare.git` leaves `origin`
    /// in exactly that form, so the dialog sent the user off to fix HTTPS
    /// credentials for a host that appears nowhere in their config — while the
    /// SAME repository spelled `file:///srv/git/repo.git` was correctly told
    /// nothing is stored for it. One remote, two contradictory verdicts.
    #[test]
    fn a_bare_local_path_is_reported_as_the_local_path_it_is() {
        for url in [
            "/srv/git/repo.git",
            "~/repos/x.git",
            "../sibling.git",
            "./x.git",
            ".",
            "C:\\repos\\x.git",
            "c:/repos/x.git",
        ] {
            let target = credential_target(url);
            assert_eq!(target.protocol, "file", "{url} is a local path");
            assert_eq!(target.display_host, url, "{url} is reported as typed");
            assert!(!target.resolved, "{url} names no host to contact");
        }
    }

    /// ...and a remote that only LOOKS like a path is reported as the host it
    /// reaches, because that is what the gate says about it.
    ///
    /// This dialog used to answer "is this a path?" with a parse of its own,
    /// and it disagreed with `security::is_local_target` — the gate's answer —
    /// in the direction that hides a real transport. An scp-form remote is
    /// ssh; it leaves the machine, and offline mode refuses it. The dialog
    /// called it a local repository that "does not authenticate, so nothing is
    /// stored", so the same remote was a network host with offline mode on and
    /// a local path with it off — and the ssh probe, the whole point of
    /// testing an ssh remote, was silently skipped.
    #[test]
    fn a_remote_that_only_looks_like_a_path_is_reported_as_the_host_it_reaches() {
        // scp-form ssh, `~` login and all: the probe must run for it.
        let target = credential_target("~deploy@git.example.test:team/app.git");
        assert_eq!(target.protocol, "ssh");
        assert!(target.resolved, "the ssh probe is gated on `resolved`");
        assert_eq!(target.display_host, "git.example.test");
        assert_eq!(target.ssh_destination, "~deploy@git.example.test");
    }

    /// A remote whose login lives in `~/.ssh/config` is ssh, and is probed as
    /// the bare host.
    ///
    /// `gitserver:team/app.git` is git's scp form with the login left off —
    /// what a `Host` alias leaves behind. `parse_target` did not recognise it,
    /// so this fell to the malformed branch: no `://` meant `url_scheme` found
    /// nothing and `https` was substituted, `resolved` stayed false, and the
    /// `protocol == "ssh" && resolved` gate skipped the ssh probe entirely.
    /// `git credential fill` was asked `protocol=https host=gitserver:team/app.git`
    /// and the panel drew a red ✗ "No Credentials Found" over "Protocol: https"
    /// for a remote that works.
    #[test]
    fn an_scp_remote_with_no_login_is_probed_over_ssh_as_the_bare_host() {
        let target = credential_target("gitserver:team/app.git");
        assert_eq!(target.protocol, "ssh");
        assert!(target.resolved, "the ssh probe is gated on `resolved`");
        assert!(!target.is_path(), "an ssh remote is not a local path");
        assert_eq!(target.display_host, "gitserver");
        // The BARE host: with no login named, `ssh gitserver` applies the
        // `User` that `~/.ssh/config` has for the alias — the account git
        // itself will use. `git@gitserver` probes a different one.
        assert_eq!(target.ssh_destination, "gitserver");
        assert_eq!(target.port, None);
        // ...and the destination is the host the gate judged, as ever.
        assert_eq!(
            Some(target.display_host.as_str()),
            crate::services::security::url_host("gitserver:team/app.git").as_deref()
        );
    }

    /// A repository whose NAME parses as a port is still an ssh remote.
    ///
    /// `gitserver:2024` is git's scp form: the repository `2024` on the
    /// `~/.ssh/config` alias `gitserver`, exactly as `git@host:2222` already
    /// was. `parse_target` read the login-less `host:<u16>` as a PORT — which
    /// is right for the SSH settings dialog's host field, the only input that
    /// has that form, and wrong for a remote. `is_ssh` came back false and the
    /// scheme `None`, so `protocol` became `https` with `resolved` true, and
    /// the `protocol == "ssh" && resolved` gate skipped the ssh probe: a red
    /// "No Credentials Found / Protocol: https / Host: gitserver:2024" for a
    /// working ssh remote — and where an unrelated `https://gitserver:2024`
    /// credential existed, "Credentials Working" with an Erase button aimed at
    /// it.
    #[test]
    fn a_repository_named_like_a_port_is_probed_over_ssh() {
        for url in ["gitserver:2024", "git.example.test:8080", "host:22"] {
            let target = credential_target(url);
            assert_eq!(target.protocol, "ssh", "{url} is an scp-form ssh remote");
            assert!(
                target.resolved,
                "{url}: the ssh probe is gated on `resolved`"
            );
            assert_eq!(target.port, None, "{url}: the colon separates a PATH");
        }
        let target = credential_target("gitserver:2024");
        assert_eq!(target.display_host, "gitserver");
        assert_eq!(target.ssh_destination, "gitserver");
        // The GATE is unaffected either way — both readings resolve the same
        // host, which is all it judges.
        assert_eq!(
            crate::services::security::parse_target("gitserver:2024").map(|t| t.host),
            crate::services::security::parse_remote_target("gitserver:2024").map(|t| t.host),
        );
        // ...and the SSH settings dialog's host field keeps its `host:port`
        // reading, which is the only place that form exists.
        assert_eq!(
            crate::services::security::parse_target("gitserver:2024").and_then(|t| t.port),
            Some(2024)
        );
    }

    /// A BARE relative remote is a repository on this disk, not an https host.
    ///
    /// `git remote add b2 sub/mybackup.git` is purely local, but
    /// `is_local_target` — the strict rule, which also judges bare hosts — said
    /// otherwise, so this fell through to the host branch and the panel drew
    /// "Host: sub / Protocol: https / No Credentials Found" for a repository on
    /// the same disk, with no credential anywhere named `sub`.
    #[test]
    fn a_bare_relative_remote_is_reported_as_the_path_it_is() {
        for url in ["sub/mybackup.git", "backups/app.git"] {
            let target = credential_target(url);
            assert_eq!(target.protocol, "file", "{url} asks no credential helper");
            assert!(target.is_path(), "{url} is a path, and the dialog says so");
            assert_eq!(target.display_host, url, "{url} is reported as typed");
            assert!(!target.resolved, "{url} names no host to contact");
        }
        // `mybackup.git` has no separator, so nothing tells it from a bare
        // host; it keeps the answer it has always had, deliberately.
        assert!(!credential_target("mybackup.git").is_path());
    }

    /// A login the remote DOES name is still the login ssh is given.
    #[test]
    fn a_named_login_still_reaches_the_ssh_probe() {
        assert_eq!(
            credential_target("deploy@gitserver:team/app.git").ssh_destination,
            "deploy@gitserver"
        );
    }

    /// A UNC share is reported as the path it is — not as an invented https
    /// host, and above all not as one whose credential the Erase button then
    /// deletes.
    ///
    /// `is_local_target` excludes UNC on purpose (SMB does leave the machine,
    /// and offline mode has to go on refusing it), so this fell through to
    /// `parse_target`, whose scheme-less fallback parses
    /// `https://\\server\share\repo.git` — WHATWG "special authority ignore
    /// slashes" eats the backslashes and yields the host `server` under the
    /// protocol `https`. Both fabricated: git opens a UNC path through the OS
    /// redirector and asks no credential helper about it at all. A working
    /// share was drawn as "No Credentials Found", and a user who really did
    /// have an `https://server/…` credential for an internal host of that name
    /// was shown "Credentials Working" over an Erase button pointed at it.
    #[test]
    fn a_unc_share_is_reported_as_a_path_not_an_invented_https_host() {
        for url in ["\\\\server\\share\\repo.git", "//fileserver/share/repo.git"] {
            let target = credential_target(url);
            assert_eq!(target.protocol, "file", "{url} asks no credential helper");
            assert_ne!(target.protocol, "https", "{url} is not an https remote");
            assert!(
                !target.resolved,
                "{url} names no host to look a credential up under"
            );
            assert_eq!(target.display_host, url, "{url} is reported as typed");
            // The question actually put to `git credential fill`, which is the
            // one the Erase button then rejects: it must not name a real host.
            assert_eq!(
                credential_lookup_query(&target),
                format!("protocol=file\nhost={url}\n\n")
            );
        }
    }

    /// The dialog and the gate answer their two questions off the ONE parse.
    ///
    /// They are not the same question. The gate asks "does this leave the
    /// machine?"; the dialog asks "would git ask a credential helper about
    /// it?". Everything the gate calls local answers no to both, and the
    /// dialog reports it as a path with no host to contact — that direction
    /// holds without exception, and it is the one that used to fail (a bare
    /// path was reported as the host `srv`).
    ///
    /// UNC is the single case where the two answers part, in the only
    /// direction they can: SMB puts bytes on the wire, so the gate refuses it
    /// under offline mode, while git opens it as a path and consults no
    /// helper — so the dialog must not invent a host for it either.
    ///
    /// (Not a biconditional on `protocol` alone in the other direction either:
    /// `file://server/share` keeps its `file` scheme while resolving a host,
    /// which is exactly the case the gate refuses.)
    #[test]
    fn the_dialog_and_the_gate_agree_about_what_is_local() {
        for url in [
            "/srv/git/repo.git",
            "~/repos/x.git",
            "../sibling.git",
            ".",
            "C:\\repos\\x.git",
            "file:///srv/git/repo.git",
            "file://localhost/srv/git/repo.git",
            "file://server/share/repo.git",
            "~deploy@git.example.test:team/app.git",
            // ...and the same form with the login left to `~/.ssh/config`.
            "gitserver:team/app.git",
            "https://github.com/o/r.git",
            "git@github.com:o/r.git",
        ] {
            let target = credential_target(url);
            let local = crate::services::security::is_local_target(url);
            assert_eq!(
                !target.resolved && target.protocol == "file",
                local,
                "{url}: the dialog and the gate must not disagree about this"
            );
            if local {
                assert_eq!(target.display_host, url, "{url} is reported as typed");
            }
        }

        // The one documented exception, pinned in both directions so neither
        // half can drift into the other's answer.
        for url in ["\\\\server\\share\\repo.git", "//fileserver/share/repo.git"] {
            let target = credential_target(url);
            assert!(
                !crate::services::security::is_local_target(url),
                "{url} is SMB: the gate must go on refusing it under offline mode"
            );
            assert!(
                !target.resolved && target.protocol == "file",
                "{url} is a path to git: the dialog must not invent a host for it"
            );
            assert_eq!(target.display_host, url, "{url} is reported as typed");
        }
    }

    /// ...and a single-letter host with a port is still a host: the drive
    /// check needs the separator, or `x:22` reads as a drive.
    #[test]
    fn a_single_letter_host_with_a_port_is_not_a_drive() {
        let target = credential_target("x:22");
        assert_eq!(target.protocol, "https");
        assert_eq!(target.display_host, "x:22");
    }

    /// The DISPLAY above moved; the GATE did not.
    ///
    /// `parse_target` stays the one parse the allowlist and the destination
    /// share, and it still resolves a bare path to the host it always did — the
    /// dialog simply stops repeating a hostname that was invented from a path.
    #[test]
    fn reporting_a_local_path_does_not_move_the_gate() {
        let _policy = crate::services::security::test_support::no_policy();
        let settings = crate::services::security::SecuritySettings {
            offline_mode: false,
            remote_allowlist: vec!["github.com".to_string()],
        };
        assert_eq!(
            crate::services::security::parse_target("/srv/git/repo.git").map(|t| t.host),
            Some("srv".to_string()),
            "the gate's parse is untouched"
        );
        // ...and the gate PERMITS it, because a filesystem remote never leaves
        // the machine — the carve-out `is_local_target` added alongside this.
        // The two changes were made independently and meet here: this one
        // decides what the dialog REPORTS, that one decides what the gate
        // PERMITS, and both agree a local path is local.
        assert!(
            crate::services::security::check(&settings, Some("/srv/git/repo.git")).is_ok(),
            "a filesystem remote opens no socket, so an allowlist has no business refusing it"
        );
    }

    /// Keeping the scheme must not move the GATE.
    ///
    /// `parse_target` stays the single source of truth for both the allowlist
    /// and the destination — this change is about what the DIALOG reports.
    /// A host-less URL still resolves to no host; whether that is then refused
    /// is the gate's own business, and it refuses everything except the local
    /// targets it deliberately carves out.
    #[test]
    fn a_host_less_remote_still_resolves_to_no_target() {
        // The verdict below is computed from the settings passed in, but the
        // gate is reached all the same, and the policy lock is what keeps that
        // from racing a test that switches a policy on.
        let _policy = crate::services::security::test_support::no_policy();
        let settings = crate::services::security::SecuritySettings {
            offline_mode: false,
            remote_allowlist: vec!["github.com".to_string()],
        };
        for url in ["file:///srv/git/repo.git", "ssh://"] {
            assert!(
                crate::services::security::parse_target(url).is_none(),
                "{url} must still resolve to no target"
            );
        }
        // `ssh://` names no host and could reach anywhere, so it is refused.
        assert!(
            crate::services::security::check(&settings, Some("ssh://")).is_err(),
            "a host-less ssh url must still be refused"
        );
        // `file://` is local, so the carve-out permits it — the same rule the
        // loopback exemption has always applied to endpoints.
        assert!(
            crate::services::security::check(&settings, Some("file:///srv/git/repo.git")).is_ok(),
            "a file:// remote never leaves the machine"
        );
    }

    /// A scheme-carrying URL with no host must not be handed to the ssh probe:
    /// what stands in for the destination there is the whole unparsed string,
    /// not a host, so there is nothing to connect to.
    #[test]
    fn a_host_less_ssh_url_is_not_probed_over_ssh() {
        let target = credential_target("ssh://");
        assert_eq!(target.protocol, "ssh");
        assert!(
            !target.resolved,
            "an unresolved target must not reach the ssh probe"
        );
    }

    /// Point a repo at a `store` credential helper holding `entries`, each one
    /// a store-file line (`http://user:pass@host`).
    fn repo_with_stored_credentials(entries: &[&str]) -> TestRepo {
        let repo = TestRepo::with_initial_commit();
        let store = repo.path.join("credential-store");
        std::fs::write(&store, format!("{}\n", entries.join("\n"))).expect("write store");
        repo.repo()
            .config()
            .expect("config")
            .set_str(
                "credential.helper",
                &format!("store --file={}", store.display()),
            )
            .expect("set credential.helper");
        repo
    }

    /// The credential a remote actually uses has to be the one looked up.
    ///
    /// The lookup was pinned to `protocol=https` while the reported protocol
    /// was the URL's own scheme, so an `http://` remote with a working stored
    /// credential came back "No credentials found" — about a remote that works.
    #[tokio::test]
    async fn an_http_remote_finds_its_stored_http_credential() {
        let repo = repo_with_stored_credentials(&["http://http-user:http-pass@git.internal.test"]);

        let result = test_credentials(
            repo.path_str(),
            "http://git.internal.test/team/app.git".to_string(),
        )
        .await
        .expect("test_credentials");

        assert!(result.success, "got: {:?}", result);
        assert_eq!(result.protocol, "http");
        assert_eq!(result.username.as_deref(), Some("http-user"));
    }

    /// ...and a credential stored under a DIFFERENT protocol for the same host
    /// is not it. Reporting one is worse than reporting nothing: the dialog
    /// said "Credentials Working / Protocol: http" about an `https` entry, and
    /// the erase button then rejected `protocol=http`, which matches nothing —
    /// so the user confirmed a re-authentication warning for a no-op.
    #[tokio::test]
    async fn an_http_remote_does_not_report_the_hosts_https_credential() {
        let repo =
            repo_with_stored_credentials(&["https://https-user:https-pass@git.internal.test"]);

        let result = test_credentials(
            repo.path_str(),
            "http://git.internal.test/team/app.git".to_string(),
        )
        .await
        .expect("test_credentials");

        assert!(
            !result.success,
            "an https credential is not an http one: {:?}",
            result
        );
        assert_eq!(result.username, None);
    }

    /// The everyday `https://` remote keeps finding its own credential.
    #[tokio::test]
    async fn an_https_remote_finds_its_stored_https_credential() {
        let repo =
            repo_with_stored_credentials(&["https://https-user:https-pass@git.internal.test"]);

        let result = test_credentials(
            repo.path_str(),
            "https://git.internal.test/team/app.git".to_string(),
        )
        .await
        .expect("test_credentials");

        assert!(result.success, "got: {:?}", result);
        assert_eq!(result.protocol, "https");
        assert_eq!(result.username.as_deref(), Some("https-user"));
    }

    /// A UNC share must not find — and must not then OFFER TO ERASE — the
    /// credential of an unrelated host that happens to share its box name.
    ///
    /// `\\\\server\\share\\repo.git` used to be looked up as `protocol=https
    /// host=server`, so a user with an internal Gitea on `https://server/…`
    /// was shown "Credentials Working / host: server / protocol: https" for a
    /// file share — over an Erase button that would have run
    /// `git credential reject protocol=https host=server` and dropped that
    /// unrelated entry.
    #[tokio::test]
    async fn a_unc_share_does_not_find_the_https_credential_of_a_host_of_that_name() {
        let repo = repo_with_stored_credentials(&["https://alice:secret@server"]);

        let result = test_credentials(repo.path_str(), "\\\\server\\share\\repo.git".to_string())
            .await
            .expect("test_credentials");

        assert!(
            !result.success,
            "git asks no credential helper for a UNC path: {:?}",
            result
        );
        assert_eq!(result.username, None, "no credential of another host's");
        assert_ne!(result.protocol, "https", "the protocol was fabricated");
        assert_eq!(result.protocol, "file");
        assert_eq!(result.host, "\\\\server\\share\\repo.git");
        assert!(result.is_path_target, "the dialog labels this a path");
    }

    /// `is_path_target` is the backend's answer to a question the frontend
    /// used to guess at from `protocol` alone.
    ///
    /// `file://server/share/repo.git` keeps its `file` scheme while resolving a
    /// host — the very target the gate refuses under offline mode — and the
    /// dialog printed "A local repository does not authenticate" for it. A bare
    /// path and a host-less `file://` URL are the ones that really are paths.
    #[tokio::test]
    async fn the_result_says_whether_the_host_it_reports_is_really_a_path() {
        let repo = repo_with_stored_credentials(&[]);

        for (url, expected) in [
            ("/srv/git/repo.git", true),
            ("file:///srv/git/repo.git", true),
            ("\\\\server\\share\\repo.git", true),
            ("file://server/share/repo.git", false),
            ("https://github.com/o/r.git", false),
        ] {
            let result = test_credentials(repo.path_str(), url.to_string())
                .await
                .expect("test_credentials");
            assert_eq!(
                result.is_path_target, expected,
                "{url}: is_path_target must not be guessed from protocol alone (got {:?})",
                result
            );
            if expected {
                assert_eq!(result.host, url, "{url} is reported as typed");
            }
        }
    }

    /// The everyday remote forms still resolve the way they always did.
    #[test]
    fn the_ordinary_remote_forms_keep_their_protocol_and_host() {
        for (url, protocol, host) in [
            ("https://github.com/user/repo.git", "https", "github.com"),
            ("https://gitlab.com/user/repo", "https", "gitlab.com"),
            (
                "https://bitbucket.org/user/repo.git",
                "https",
                "bitbucket.org",
            ),
            ("git@github.com:user/repo.git", "ssh", "github.com"),
            ("git@gitlab.com:group/project.git", "ssh", "gitlab.com"),
            ("ssh://git@github.com/user/repo.git", "ssh", "github.com"),
        ] {
            let target = credential_target(url);
            assert_eq!(target.protocol, protocol, "protocol for {url}");
            assert_eq!(target.display_host, host, "host for {url}");
        }
    }

    /// Without a connect timeout a user whose network drops outbound :22 waits
    /// out the kernel's TCP timeout — around two minutes — with the dialog
    /// stuck on "Testing". `test_ssh_connection` runs the same probe and has
    /// always set one.
    #[test]
    fn the_ssh_probe_gives_up_rather_than_hanging() {
        assert!(
            ssh_probe_args().contains(&"ConnectTimeout=10"),
            "got: {:?}",
            ssh_probe_args()
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
            is_path_target: false,
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

    /// A failed re-store must not throw away the token that WAS read.
    ///
    /// `?` on the write propagated the failure, so an upgrading user whose
    /// keyring accepts reads but refuses writes — a keychain that re-locks
    /// after a read, an entry-count limit, a re-locked SecretService
    /// collection — got an error from `get_keyring_token` instead of the token
    /// sitting right there under the old service name, and a perfectly good
    /// connected account read as broken. The sibling adopter
    /// `credentials_service::get_with_legacy_fallback` warns and returns the
    /// value; these two are written for the same situation and must agree.
    ///
    /// The legacy entry stays put, so the next launch adopts it properly.
    #[test]
    fn token_fallback_returns_the_adopted_token_when_the_re_store_fails() {
        let store: FakeKeyring = Default::default();
        store.borrow_mut().insert(
            ("leviathan-integrations".into(), "jira".into()),
            "tok".into(),
        );
        assert_eq!(
            read_fallback(&store, "jira", true).unwrap().as_deref(),
            Some("tok"),
            "the token was read; a failed re-store is no reason to lose it"
        );
        assert!(
            store
                .borrow()
                .contains_key(&("leviathan-integrations".into(), "jira".into())),
            "the only copy must not be removed after a failed write"
        );
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
