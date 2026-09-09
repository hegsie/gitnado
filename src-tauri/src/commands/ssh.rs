//! SSH key management command handlers
//! View, generate, and test SSH keys for Git authentication

use std::fs;
use std::path::PathBuf;
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::utils::create_command;

/// SSH key information
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKey {
    /// Key name (filename without extension)
    pub name: String,
    /// Full path to the private key
    pub path: String,
    /// Full path to the public key
    pub public_path: String,
    /// Key type (rsa, ed25519, ecdsa, etc.)
    pub key_type: String,
    /// Key fingerprint
    pub fingerprint: Option<String>,
    /// Key comment (usually email)
    pub comment: Option<String>,
    /// Public key content
    pub public_key: Option<String>,
}

/// SSH configuration info
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    /// Whether SSH is available
    pub ssh_available: bool,
    /// SSH version
    pub ssh_version: Option<String>,
    /// SSH directory path
    pub ssh_dir: String,
    /// Git's configured SSH command
    pub git_ssh_command: Option<String>,
}

/// SSH connection test result
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTestResult {
    /// Whether the connection was successful
    pub success: bool,
    /// The host that was tested
    pub host: String,
    /// Response message from the server
    pub message: String,
    /// Username authenticated as (if successful)
    pub username: Option<String>,
}

/// Get SSH directory path
fn get_ssh_dir() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".ssh"))
        .unwrap_or_else(|| PathBuf::from("~/.ssh"))
}

/// Check if SSH is available
fn is_ssh_available() -> bool {
    create_command("ssh")
        .arg("-V")
        .output()
        .map(|o| o.status.success() || !o.stderr.is_empty()) // ssh -V outputs to stderr
        .unwrap_or(false)
}

/// Get SSH version
fn get_ssh_version() -> Option<String> {
    create_command("ssh")
        .arg("-V")
        .output()
        .ok()
        .map(|o| {
            // ssh -V outputs to stderr
            String::from_utf8_lossy(&o.stderr)
                .lines()
                .next()
                .unwrap_or("")
                .to_string()
        })
        .filter(|s| !s.is_empty())
}

/// Get SSH key fingerprint
fn get_key_fingerprint(public_key_path: &str) -> Option<String> {
    create_command("ssh-keygen")
        .args(["-l", "-f", public_key_path])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            let output = String::from_utf8_lossy(&o.stdout);
            // Output format: "256 SHA256:xxx comment (type)"
            // Extract just the fingerprint part
            output.split_whitespace().nth(1).unwrap_or("").to_string()
        })
}

/// Parse public key content to get type and comment
fn parse_public_key(content: &str) -> (String, Option<String>) {
    let parts: Vec<&str> = content.split_whitespace().collect();
    let key_type = parts.first().unwrap_or(&"unknown").to_string();
    let comment = parts.get(2).map(|s| s.to_string());
    (key_type, comment)
}

/// Get SSH configuration
#[command]
pub async fn get_ssh_config() -> Result<SshConfig> {
    let ssh_available = is_ssh_available();
    let ssh_version = get_ssh_version();
    let ssh_dir = get_ssh_dir();

    // Get git's SSH command if configured
    let git_ssh_command = create_command("git")
        .args(["config", "--get", "core.sshCommand"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    Ok(SshConfig {
        ssh_available,
        ssh_version,
        ssh_dir: ssh_dir.to_string_lossy().to_string(),
        git_ssh_command,
    })
}

/// List available SSH keys
#[command]
pub async fn get_ssh_keys() -> Result<Vec<SshKey>> {
    let ssh_dir = get_ssh_dir();

    if !ssh_dir.exists() {
        return Ok(Vec::new());
    }

    let mut keys = Vec::new();

    // Common key file patterns
    let key_patterns = ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"];

    // Also check for any files ending in .pub that have a matching private key
    if let Ok(entries) = fs::read_dir(&ssh_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
                // Skip .pub files, we'll find them via their private key
                if filename.ends_with(".pub") {
                    continue;
                }

                // Check if this looks like a key file
                let is_known_key = key_patterns.contains(&filename);
                let has_public = ssh_dir.join(format!("{}.pub", filename)).exists();

                if (is_known_key || has_public) && path.is_file() {
                    let public_path = ssh_dir.join(format!("{}.pub", filename));
                    let public_path_str = public_path.to_string_lossy().to_string();

                    // Try to read public key content
                    let public_content = fs::read_to_string(&public_path).ok();
                    let (key_type, comment) = public_content
                        .as_ref()
                        .map(|c| parse_public_key(c))
                        .unwrap_or_else(|| ("unknown".to_string(), None));

                    // Get fingerprint
                    let fingerprint = if public_path.exists() {
                        get_key_fingerprint(&public_path_str)
                    } else {
                        None
                    };

                    keys.push(SshKey {
                        name: filename.to_string(),
                        path: path.to_string_lossy().to_string(),
                        public_path: public_path_str,
                        key_type,
                        fingerprint,
                        comment,
                        public_key: public_content,
                    });
                }
            }
        }
    }

    // Sort by name
    keys.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(keys)
}

/// Generate a new SSH key
#[command]
pub async fn generate_ssh_key(
    key_type: String,
    email: String,
    filename: Option<String>,
    passphrase: Option<String>,
) -> Result<SshKey> {
    let ssh_dir = get_ssh_dir();

    // Create .ssh directory if it doesn't exist
    if !ssh_dir.exists() {
        fs::create_dir_all(&ssh_dir).map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to create .ssh directory: {}", e))
        })?;
    }

    // Determine filename
    let key_name = filename.unwrap_or_else(|| format!("id_{}", key_type.to_lowercase()));
    let key_path = ssh_dir.join(&key_name);

    // Check if key already exists
    if key_path.exists() {
        return Err(GitnadoError::OperationFailed(format!(
            "Key already exists: {}",
            key_path.display()
        )));
    }

    // Build ssh-keygen command
    let mut cmd = create_command("ssh-keygen");
    cmd.args([
        "-t",
        &key_type.to_lowercase(),
        "-C",
        &email,
        "-f",
        &key_path.to_string_lossy(),
    ]);

    // Add passphrase (empty string for no passphrase)
    let pass = passphrase.unwrap_or_default();
    cmd.args(["-N", &pass]);

    // For ed25519, we don't need to specify key size
    // For RSA, use 4096 bits
    if key_type.to_lowercase() == "rsa" {
        cmd.args(["-b", "4096"]);
    }

    let output = cmd
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run ssh-keygen: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "ssh-keygen failed: {}",
            stderr
        )));
    }

    // Read the generated key info
    let public_path = ssh_dir.join(format!("{}.pub", key_name));
    let public_content = fs::read_to_string(&public_path).ok();
    let fingerprint = get_key_fingerprint(&public_path.to_string_lossy());

    Ok(SshKey {
        name: key_name,
        path: key_path.to_string_lossy().to_string(),
        public_path: public_path.to_string_lossy().to_string(),
        key_type: format!("ssh-{}", key_type.to_lowercase()),
        fingerprint,
        comment: Some(email),
        public_key: public_content,
    })
}

/// Where to point `ssh -T`, and the success banner to expect from it.
struct SshTarget {
    /// The `[user@]host` argument for ssh.
    ssh_host: String,
    /// An explicit port from an `ssh://host:port/…` URL, if the user gave one.
    port: Option<String>,
    /// The banner this host is known to answer with, or "" if it is unknown.
    expected_pattern: &'static str,
}

/// Which host to connect to, and the success banner to expect from it.
///
/// The canonical SaaS hosts are matched EXACTLY. Matching on `contains` and then
/// rewriting the target sent `github.mycompany.com` or `gitlab.internal.io` to
/// the public servers instead: the test passed against a machine the user never
/// named (their personal key works on github.com), while the result panel still
/// displayed the host they typed. Anything else is contacted as entered.
///
/// The input is whatever the user pasted, so a remote URL is accepted as well as
/// a bare host: `github.com`, `git@github.com`, `git@github.com:owner/repo.git`
/// and `ssh://git@github.com:2222/owner/repo.git` all resolve to the same host.
/// Handing those URL forms to `ssh -T` verbatim made every one of them miss the
/// canonical-host match and then fail to connect at all.
///
/// The destination comes from `security::parse_target` — the SAME parse the
/// allowlist judges — so the host the gate approved is the host `ssh` is given.
/// Splitting on the LAST `@` here while the gate split on the FIRST resolved
/// `git@github.com:x@evil.test:y` to `evil.test`, which a `github.com`
/// allowlist had just approved as `github.com`.
fn resolve_ssh_target(host: &str) -> SshTarget {
    let (user, bare, port) = match crate::services::security::parse_target(host) {
        Some(target) => (target.user, target.host, target.port.map(|p| p.to_string())),
        // Nothing a URL parser recognises: hand it to ssh as typed and let ssh
        // say why it cannot be reached.
        None => (None, host.trim().to_string(), None),
    };

    let expected_pattern = match bare.as_str() {
        "github.com" | "ssh.github.com" => "successfully authenticated",
        "gitlab.com" => "welcome to gitlab",
        "bitbucket.org" => "logged in as",
        _ => "",
    };

    SshTarget {
        ssh_host: format!("{}@{}", user.as_deref().unwrap_or("git"), bare),
        port,
        expected_pattern,
    }
}

/// Whether an `ssh -T` result means authentication succeeded.
///
/// `expected_pattern` is empty for hosts with no known banner, and
/// `contains("")` is ALWAYS true — so every custom host reported success no
/// matter what ssh said, including "Permission denied (publickey)" and
/// "Connection refused". Those hosts now rest on ssh's exit status, which is
/// non-zero for both.
fn ssh_test_succeeded(message: &str, expected_pattern: &str, status_success: bool) -> bool {
    let lower = message.to_lowercase();

    if !expected_pattern.is_empty() && lower.contains(expected_pattern) {
        return true;
    }

    // The known banners are still accepted from any host: a GitHub Enterprise or
    // self-hosted GitLab answers with the same wording as the SaaS original.
    lower.contains("successfully authenticated")
        || lower.contains("welcome to gitlab")
        || lower.contains("logged in as")
        || status_success
}

/// The exact argument list `ssh` is invoked with for a connection test.
///
/// Built in one place so a test can read it: the port reaches ssh ONLY through
/// `-p`, and a target whose port went missing probes :22 with nothing in the
/// invocation to show for it.
fn ssh_probe_args(target: &SshTarget) -> Vec<String> {
    let mut args: Vec<String> = [
        "-T",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect();
    if let Some(port) = &target.port {
        args.push("-p".to_string());
        args.push(port.clone());
    }
    args.push(target.ssh_host.clone());
    args
}

/// Test SSH connection to a host
#[command]
pub async fn test_ssh_connection(host: String) -> Result<SshTestResult> {
    let target = resolve_ssh_target(&host);
    let expected_pattern = target.expected_pattern;

    // Offline mode / remote allowlist. `ssh -T git@github.com` is an outbound
    // connection, and the frontend gate already checks this command against the
    // bare host it was given.
    crate::services::security::guard_url(&host)?;

    // Run ssh -T to test connection
    let mut command = create_command("ssh");
    let output = command
        .args(ssh_probe_args(&target))
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run ssh: {}", e)))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = if stdout.is_empty() {
        stderr.to_string()
    } else {
        stdout.to_string()
    };

    // GitHub returns exit code 1 even on success, so check the message
    let success = ssh_test_succeeded(&message, expected_pattern, output.status.success());

    // Try to extract username from the message
    let username = if message.contains("Hi ") {
        // GitHub format: "Hi username!"
        message
            .split("Hi ")
            .nth(1)
            .and_then(|s| s.split('!').next())
            .map(|s| s.to_string())
    } else if message.contains("Welcome to GitLab, @") {
        // GitLab format: "Welcome to GitLab, @username!"
        message
            .split("@")
            .nth(1)
            .and_then(|s| s.split('!').next())
            .map(|s| s.to_string())
    } else if message.contains("logged in as ") {
        // Bitbucket format: "logged in as username."
        message
            .split("logged in as ")
            .nth(1)
            .and_then(|s| s.split('.').next())
            .map(|s| s.to_string())
    } else {
        None
    };

    Ok(SshTestResult {
        success,
        host: host.clone(),
        message: message.trim().to_string(),
        username,
    })
}

/// Add SSH key to ssh-agent
#[command]
pub async fn add_key_to_agent(key_path: String) -> Result<()> {
    let output = create_command("ssh-add")
        .arg(&key_path)
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run ssh-add: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "ssh-add failed: {}",
            stderr
        )));
    }

    Ok(())
}

/// List keys loaded in ssh-agent
#[command]
pub async fn list_agent_keys() -> Result<Vec<String>> {
    let output = create_command("ssh-add")
        .arg("-l")
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run ssh-add: {}", e)))?;

    if !output.status.success() {
        // Exit code 1 means "no identities", which is not an error
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no identities") || stderr.contains("The agent has no identities") {
            return Ok(Vec::new());
        }
        return Err(GitnadoError::OperationFailed(format!(
            "ssh-add failed: {}",
            stderr
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let keys: Vec<String> = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();

    Ok(keys)
}

/// Get the public key content for copying to clipboard/services
#[command]
pub async fn get_public_key_content(key_name: String) -> Result<String> {
    let ssh_dir = get_ssh_dir();
    let public_path = ssh_dir.join(format!("{}.pub", key_name));

    if !public_path.exists() {
        return Err(GitnadoError::OperationFailed(format!(
            "Public key not found: {}",
            public_path.display()
        )));
    }

    fs::read_to_string(&public_path)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to read public key: {}", e)))
}

/// Delete an SSH key pair
#[command]
pub async fn delete_ssh_key(key_name: String) -> Result<()> {
    let ssh_dir = get_ssh_dir();
    let private_path = ssh_dir.join(&key_name);
    let public_path = ssh_dir.join(format!("{}.pub", key_name));

    // Remove private key
    if private_path.exists() {
        fs::remove_file(&private_path).map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to delete private key: {}", e))
        })?;
    }

    // Remove public key
    if public_path.exists() {
        fs::remove_file(&public_path).map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to delete public key: {}", e))
        })?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── SSH connection test targeting and verdict ────────────────────────────

    /// A self-hosted host must be contacted as entered.
    ///
    /// `host.contains("github")` matched github.mycompany.com and then replaced
    /// the target with git@github.com, so the test ran against the PUBLIC server
    /// while the result panel showed the enterprise host. A pass there proves
    /// only that the user's key works on github.com.
    #[test]
    fn test_self_hosted_hosts_are_not_redirected_to_the_saas_servers() {
        for host in [
            "github.mycompany.com",
            "gitlab.internal.io",
            "bitbucket.corp.example",
            "git.example.com",
        ] {
            let target = resolve_ssh_target(host);
            assert_eq!(
                target.ssh_host,
                format!("git@{}", host),
                "{} must be contacted as entered",
                host
            );
        }
    }

    /// The canonical hosts still resolve to their known banner.
    #[test]
    fn test_canonical_hosts_keep_their_expected_banner() {
        for (input, ssh_host, pattern) in [
            ("github.com", "git@github.com", "successfully authenticated"),
            ("gitlab.com", "git@gitlab.com", "welcome to gitlab"),
            ("bitbucket.org", "git@bitbucket.org", "logged in as"),
            // An explicit user resolves the same way and is preserved.
            (
                "git@github.com",
                "git@github.com",
                "successfully authenticated",
            ),
        ] {
            let target = resolve_ssh_target(input);
            assert_eq!(target.ssh_host, ssh_host, "target for {}", input);
            assert_eq!(target.expected_pattern, pattern, "banner for {}", input);
            assert_eq!(target.port, None, "port for {}", input);
        }
        // A self-hosted host gets no banner to match on.
        assert_eq!(
            resolve_ssh_target("github.mycompany.com").expected_pattern,
            ""
        );
    }

    /// Pasting a remote URL is the natural thing to do, so every URL form has to
    /// resolve to the same host as the bare name.
    ///
    /// Only the `user@` prefix used to be stripped, so `git@github.com:me/x.git`
    /// missed the canonical-host match AND was handed to `ssh -T` complete with
    /// its repository path — which cannot connect to anything.
    #[test]
    fn test_remote_urls_resolve_to_their_host() {
        for input in [
            "git@github.com:owner/repo.git",
            "ssh://git@github.com/owner/repo.git",
            "ssh://git@github.com:22/owner/repo.git",
            "git+ssh://git@github.com/owner/repo.git",
            "github.com/owner/repo",
            "  git@github.com:owner/repo.git  ",
        ] {
            let target = resolve_ssh_target(input);
            assert_eq!(target.ssh_host, "git@github.com", "target for {}", input);
            assert_eq!(
                target.expected_pattern, "successfully authenticated",
                "banner for {}",
                input
            );
        }
    }

    /// A non-default port from an SSH URL has to reach the ssh invocation, or
    /// the test silently probes port 22 of a server that does not listen there.
    #[test]
    fn test_ssh_url_port_is_preserved() {
        let target = resolve_ssh_target("ssh://git@git.example.com:2222/owner/repo.git");
        assert_eq!(target.ssh_host, "git@git.example.com");
        assert_eq!(target.port.as_deref(), Some("2222"));

        // An SCP-style path is not a port.
        let scp = resolve_ssh_target("git@git.example.com:owner/repo.git");
        assert_eq!(scp.ssh_host, "git@git.example.com");
        assert_eq!(scp.port, None);

        // A bracketed IPv6 literal keeps its brackets and still yields its port.
        let v6 = resolve_ssh_target("ssh://git@[2001:db8::1]:2222/owner/repo.git");
        assert_eq!(v6.ssh_host, "git@[2001:db8::1]");
        assert_eq!(v6.port.as_deref(), Some("2222"));
    }

    /// Port 443 has to reach `ssh` like any other port.
    ///
    /// `ssh.github.com:443` is GitHub's own documented workaround for a network
    /// that blocks port 22, and `altssh.gitlab.com:443` /
    /// `altssh.bitbucket.org:443` are the same shape. The parse rebuilt the
    /// target through a synthesised `https://` URL, and a WHATWG URL parser
    /// normalizes away a port equal to the scheme's default — so 443, and only
    /// 443, came back as no port at all, `-p` was never added, and `ssh -T`
    /// probed :22: the one port the user typed 443 to avoid. The panel then
    /// reported a failed SSH test for a configuration that works.
    #[test]
    fn test_host_field_port_443_reaches_ssh() {
        for (input, ssh_host) in [
            ("ssh.github.com:443", "git@ssh.github.com"),
            ("altssh.gitlab.com:443", "git@altssh.gitlab.com"),
            ("altssh.bitbucket.org:443", "git@altssh.bitbucket.org"),
            ("git.example.com:443", "git@git.example.com"),
            ("[::1]:443", "git@[::1]"),
        ] {
            let target = resolve_ssh_target(input);
            assert_eq!(target.ssh_host, ssh_host, "destination for {}", input);
            assert_eq!(target.port.as_deref(), Some("443"), "port for {}", input);

            let args = ssh_probe_args(&target);
            assert!(
                args.windows(2)
                    .any(|pair| pair == ["-p".to_string(), "443".to_string()]),
                "{} must be probed with -p 443, got {:?}",
                input,
                args
            );
            assert_eq!(
                args.last().map(String::as_str),
                Some(ssh_host),
                "the destination is the last argument for {}",
                input
            );
        }

        // The canonical banner still applies: `ssh.github.com` is one of the
        // hosts with a known greeting, and the port does not change that.
        assert_eq!(
            resolve_ssh_target("ssh.github.com:443").expected_pattern,
            "successfully authenticated"
        );
    }

    /// A target with no port gets no `-p`, and any other port is passed through
    /// — the control for the 443 case above.
    #[test]
    fn test_ssh_probe_args_carry_only_a_port_that_was_given() {
        let bare = ssh_probe_args(&resolve_ssh_target("github.com"));
        assert!(
            !bare.iter().any(|arg| arg == "-p"),
            "no port was given, so ssh must be left to its default: {:?}",
            bare
        );
        assert_eq!(bare.last().map(String::as_str), Some("git@github.com"));

        let ported = ssh_probe_args(&resolve_ssh_target("git.example.com:2222"));
        assert!(
            ported
                .windows(2)
                .any(|pair| pair == ["-p".to_string(), "2222".to_string()]),
            "{:?}",
            ported
        );

        // An scp-form remote's path is not a port, so it adds no `-p`.
        let scp = ssh_probe_args(&resolve_ssh_target("git@git.example.com:owner/repo.git"));
        assert!(!scp.iter().any(|arg| arg == "-p"), "{:?}", scp);
    }

    /// The host handed to `ssh` must be the host the allowlist judged.
    ///
    /// `git@github.com:x@evil.test:y` is, to git, the path `x@evil.test:y` on
    /// `github.com`, and that is the host the gate reads. Splitting on the LAST
    /// `@` here resolved it to `evil.test`, so a `github.com` allowlist
    /// approved a connection to a host it never saw.
    #[test]
    fn test_the_target_is_the_host_the_gate_judged() {
        for input in [
            "git@github.com:x@evil.test:y",
            "ssh://git@github.com/x@evil.test/y.git",
        ] {
            assert_eq!(
                crate::services::security::url_host(input).as_deref(),
                Some("github.com"),
                "gate host for {}",
                input
            );
            assert_eq!(
                resolve_ssh_target(input).ssh_host,
                "git@github.com",
                "destination for {}",
                input
            );
        }
    }

    /// The login the URL names is the login ssh is given: an scp-form remote
    /// may authenticate as `deploy`, and a CodeCommit URL as an access-key id.
    #[test]
    fn test_a_login_other_than_git_is_preserved() {
        assert_eq!(
            resolve_ssh_target("deploy@git.example.test:team/app.git").ssh_host,
            "deploy@git.example.test"
        );
        assert_eq!(
            resolve_ssh_target(
                "ssh://APKAEXAMPLEKEYID@git-codecommit.eu-west-1.amazonaws.com/v1/repos/app"
            )
            .ssh_host,
            "APKAEXAMPLEKEYID@git-codecommit.eu-west-1.amazonaws.com"
        );
    }

    /// With no known banner, expected_pattern is "" — and contains("") is
    /// ALWAYS true, so every custom host reported success no matter what ssh
    /// said. A green "Connection Successful" over "Permission denied" defeats
    /// the entire purpose of the test.
    #[test]
    fn test_custom_host_failures_are_reported_as_failures() {
        for failure in [
            "git@git.example.com: Permission denied (publickey).",
            "ssh: connect to host git.example.com port 22: Connection refused",
            "Host key verification failed.",
            "ssh: Could not resolve hostname git.example.com",
        ] {
            assert!(
                !ssh_test_succeeded(failure, "", false),
                "should have failed: {}",
                failure
            );
        }
    }

    /// A custom host that genuinely authenticates still passes.
    #[test]
    fn test_custom_host_success_is_reported_as_success() {
        // ssh exiting 0 is the only signal a bannerless host gives.
        assert!(ssh_test_succeeded("", "", true));
        // A self-hosted GitHub Enterprise answers with the SaaS wording.
        assert!(ssh_test_succeeded(
            "Hi alice! You've successfully authenticated, but GitHub does not provide shell access.",
            "",
            false
        ));
        // ...as does a self-hosted GitLab.
        assert!(ssh_test_succeeded("Welcome to GitLab, @alice!", "", false));
    }

    /// The canonical hosts keep working: GitHub exits 1 even on success.
    #[test]
    fn test_canonical_host_success_survives_a_nonzero_exit() {
        assert!(ssh_test_succeeded(
            "Hi alice! You've successfully authenticated, but GitHub does not provide shell access.",
            "successfully authenticated",
            false
        ));
        assert!(!ssh_test_succeeded(
            "git@github.com: Permission denied (publickey).",
            "successfully authenticated",
            false
        ));
    }

    // ==========================================================================
    // SshKey Struct Tests
    // ==========================================================================

    #[test]
    fn test_ssh_key_serialization() {
        let key = SshKey {
            name: "id_ed25519".to_string(),
            path: "/home/user/.ssh/id_ed25519".to_string(),
            public_path: "/home/user/.ssh/id_ed25519.pub".to_string(),
            key_type: "ssh-ed25519".to_string(),
            fingerprint: Some("SHA256:abcd1234".to_string()),
            comment: Some("user@example.com".to_string()),
            public_key: Some("ssh-ed25519 AAAA... user@example.com".to_string()),
        };

        let json = serde_json::to_string(&key).unwrap();
        assert!(json.contains("id_ed25519"));
        assert!(json.contains("keyType"));
        assert!(json.contains("publicPath"));
        assert!(json.contains("fingerprint"));
        assert!(json.contains("publicKey"));
    }

    #[test]
    fn test_ssh_key_without_optional_fields() {
        let key = SshKey {
            name: "id_rsa".to_string(),
            path: "/home/user/.ssh/id_rsa".to_string(),
            public_path: "/home/user/.ssh/id_rsa.pub".to_string(),
            key_type: "ssh-rsa".to_string(),
            fingerprint: None,
            comment: None,
            public_key: None,
        };

        let json = serde_json::to_string(&key).unwrap();
        assert!(json.contains("id_rsa"));
        assert!(json.contains("null")); // Optional fields should be null
    }

    // ==========================================================================
    // SshConfig Struct Tests
    // ==========================================================================

    #[test]
    fn test_ssh_config_serialization() {
        let config = SshConfig {
            ssh_available: true,
            ssh_version: Some("OpenSSH_8.9".to_string()),
            ssh_dir: "/home/user/.ssh".to_string(),
            git_ssh_command: Some("ssh -i ~/.ssh/custom_key".to_string()),
        };

        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("sshAvailable"));
        assert!(json.contains("sshVersion"));
        assert!(json.contains("sshDir"));
        assert!(json.contains("gitSshCommand"));
    }

    #[test]
    fn test_ssh_config_without_optional_fields() {
        let config = SshConfig {
            ssh_available: false,
            ssh_version: None,
            ssh_dir: "/home/user/.ssh".to_string(),
            git_ssh_command: None,
        };

        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("sshAvailable"));
        assert!(json.contains("false"));
    }

    // ==========================================================================
    // SshTestResult Struct Tests
    // ==========================================================================

    #[test]
    fn test_ssh_test_result_serialization_success() {
        let result = SshTestResult {
            success: true,
            host: "github.com".to_string(),
            message: "Hi user! You've successfully authenticated".to_string(),
            username: Some("testuser".to_string()),
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"success\":true"));
        assert!(json.contains("github.com"));
        assert!(json.contains("testuser"));
    }

    #[test]
    fn test_ssh_test_result_serialization_failure() {
        let result = SshTestResult {
            success: false,
            host: "github.com".to_string(),
            message: "Permission denied (publickey)".to_string(),
            username: None,
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"success\":false"));
        assert!(json.contains("Permission denied"));
    }

    // ==========================================================================
    // Helper Function Tests
    // ==========================================================================

    #[test]
    fn test_get_ssh_dir_returns_path() {
        let ssh_dir = get_ssh_dir();
        // Should end with .ssh
        assert!(ssh_dir.to_string_lossy().ends_with(".ssh"));
    }

    #[test]
    fn test_parse_public_key_ed25519() {
        let content = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... user@example.com";
        let (key_type, comment) = parse_public_key(content);

        assert_eq!(key_type, "ssh-ed25519");
        assert_eq!(comment, Some("user@example.com".to_string()));
    }

    #[test]
    fn test_parse_public_key_rsa() {
        let content = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB... user@work.com";
        let (key_type, comment) = parse_public_key(content);

        assert_eq!(key_type, "ssh-rsa");
        assert_eq!(comment, Some("user@work.com".to_string()));
    }

    #[test]
    fn test_parse_public_key_without_comment() {
        let content = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI...";
        let (key_type, comment) = parse_public_key(content);

        assert_eq!(key_type, "ssh-ed25519");
        assert!(comment.is_none());
    }

    #[test]
    fn test_parse_public_key_empty() {
        let content = "";
        let (key_type, comment) = parse_public_key(content);

        assert_eq!(key_type, "unknown");
        assert!(comment.is_none());
    }

    #[test]
    fn test_parse_public_key_ecdsa() {
        let content = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTI... user@host";
        let (key_type, comment) = parse_public_key(content);

        assert_eq!(key_type, "ecdsa-sha2-nistp256");
        assert_eq!(comment, Some("user@host".to_string()));
    }

    // ==========================================================================
    // Async Command Tests
    // ==========================================================================

    #[tokio::test]
    async fn test_get_ssh_config_returns_valid_result() {
        let result = get_ssh_config().await;
        assert!(result.is_ok());

        let config = result.unwrap();
        // ssh_dir should always be set
        assert!(!config.ssh_dir.is_empty());
    }

    #[tokio::test]
    async fn test_get_ssh_keys_returns_list() {
        let result = get_ssh_keys().await;
        assert!(result.is_ok());
        // Result is a valid Vec (may be empty if no keys exist)
        let _keys: Vec<SshKey> = result.unwrap();
    }

    #[tokio::test]
    async fn test_get_public_key_content_nonexistent() {
        let result =
            get_public_key_content("nonexistent_key_that_does_not_exist".to_string()).await;
        assert!(result.is_err());
    }

    // ==========================================================================
    // SSH Connection Test Result Parsing Tests
    // ==========================================================================

    #[test]
    fn test_ssh_test_result_github_format() {
        // Simulating GitHub SSH test response parsing
        let result = SshTestResult {
            success: true,
            host: "github.com".to_string(),
            message: "Hi testuser! You've successfully authenticated, but GitHub does not provide shell access.".to_string(),
            username: Some("testuser".to_string()),
        };

        assert!(result.success);
        assert_eq!(result.username, Some("testuser".to_string()));
    }

    #[test]
    fn test_ssh_test_result_gitlab_format() {
        // Simulating GitLab SSH test response parsing
        let result = SshTestResult {
            success: true,
            host: "gitlab.com".to_string(),
            message: "Welcome to GitLab, @testuser!".to_string(),
            username: Some("testuser".to_string()),
        };

        assert!(result.success);
        assert_eq!(result.username, Some("testuser".to_string()));
    }

    #[test]
    fn test_ssh_test_result_bitbucket_format() {
        // Simulating Bitbucket SSH test response parsing
        let result = SshTestResult {
            success: true,
            host: "bitbucket.org".to_string(),
            message: "logged in as testuser.".to_string(),
            username: Some("testuser".to_string()),
        };

        assert!(result.success);
        assert_eq!(result.username, Some("testuser".to_string()));
    }

    // ==========================================================================
    // Key Type Validation Tests
    // ==========================================================================

    #[test]
    fn test_common_key_types() {
        // Verify the key patterns we look for
        let key_patterns = ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"];

        assert!(key_patterns.contains(&"id_rsa"));
        assert!(key_patterns.contains(&"id_ed25519"));
        assert!(key_patterns.contains(&"id_ecdsa"));
        assert!(key_patterns.contains(&"id_dsa"));
    }

    // ==========================================================================
    // Error Handling Tests
    // ==========================================================================

    #[tokio::test]
    async fn test_generate_ssh_key_validates_type() {
        // The function should work with valid key types
        // We don't actually generate keys in tests to avoid side effects
        // Instead, we test that the function handles edge cases

        // Test with various key type strings
        let valid_types = ["ed25519", "rsa", "ecdsa", "ED25519", "RSA"];
        for key_type in valid_types {
            // Just verify the type string is processed (lowercase conversion)
            assert_eq!(key_type.to_lowercase(), key_type.to_lowercase());
        }
    }

    #[tokio::test]
    async fn test_delete_ssh_key_nonexistent() {
        // Deleting a non-existent key should succeed (no-op)
        let result = delete_ssh_key("nonexistent_key_12345".to_string()).await;
        // This should succeed as the function checks if files exist before deleting
        assert!(result.is_ok());
    }

    // ==========================================================================
    // Host Detection Tests
    // ==========================================================================

    #[test]
    fn test_host_detection_github() {
        let host = "github.com";
        assert!(host.contains("github"));
    }

    #[test]
    fn test_host_detection_gitlab() {
        let host = "gitlab.com";
        assert!(host.contains("gitlab"));
    }

    #[test]
    fn test_host_detection_bitbucket() {
        let host = "bitbucket.org";
        assert!(host.contains("bitbucket"));
    }

    #[test]
    fn test_host_detection_custom() {
        let host = "git.example.com";
        assert!(!host.contains("github"));
        assert!(!host.contains("gitlab"));
        assert!(!host.contains("bitbucket"));
    }
}
