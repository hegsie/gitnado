//! Command utilities for cross-platform process spawning
//!
//! This module provides helpers to create commands that don't show
//! console windows on Windows.

use std::process::Command;

/// Creates a Command with platform-specific settings to hide console windows.
///
/// On Windows, this sets the CREATE_NO_WINDOW flag to prevent CMD popups.
/// On other platforms, it returns a standard Command.
pub fn create_command(program: &str) -> Command {
    let mut cmd = Command::new(program);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW = 0x08000000
        // This prevents the console window from appearing
        cmd.creation_flags(0x08000000);
    }

    // Prevent git credential popup dialogs
    if program == "git" {
        cmd.env("GIT_TERMINAL_PROMPT", "0");

        // Every git subprocess in this app has its output PARSED, never shown
        // raw. git translates its porcelain-adjacent strings, so on a localized
        // machine a match like "[would prune]" simply never fires — and the
        // caller concludes nothing happened while the command in fact did the
        // work. bisect.rs, worktree.rs and merge.rs each pinned this locally
        // with a comment saying why; maintenance.rs was missed, which is the
        // hand-enumerated-list failure again. Set once, here, so the next
        // shell-out inherits it.
        cmd.env("LC_ALL", "C");

        // Under test, cut the child off from the developer's (or CI
        // container's) real git config.
        //
        // Several commands read settings by shelling out to `git config
        // --get`, so a test asserting a DEFAULT was really asserting something
        // about whoever's machine it ran on. This container's global gitconfig
        // sets commit.gpgsign=true and a signing key, which made the gpg,
        // signature and jira tests fail here while passing elsewhere. Done in
        // the one factory every git subprocess goes through, rather than at
        // each call site — the sibling isolation for libgit2's own config
        // search path lives in test_utils::isolate_git_config.
        #[cfg(test)]
        {
            cmd.env("GIT_CONFIG_GLOBAL", "/dev/null");
            cmd.env("GIT_CONFIG_SYSTEM", "/dev/null");
            cmd.env("GIT_CONFIG_NOSYSTEM", "1");
        }
    }

    cmd
}

/// The host of an SSH remote, in either the `ssh://[user@]host[:port]/path`
/// form or the scp-like `[user@]host:path` form git also accepts, lowercased.
///
/// Any port is dropped: it describes the SSH endpoint and has nothing to do
/// with the HTTPS request git makes for the same provider.
fn ssh_remote_host(remote_url: &str) -> Option<String> {
    let host = match url::Url::parse(remote_url) {
        // A parseable scheme settles it — only `ssh://` is an SSH remote.
        // Without this, `https://host/path` would read as host `https` below.
        Ok(parsed) => {
            if parsed.scheme() != "ssh" {
                return None;
            }
            parsed.host_str()?.to_lowercase()
        }
        // No scheme: scp-like when a colon comes before any slash, which is
        // exactly how git tells the two apart. What follows the colon is a
        // PATH, never a port.
        Err(_) => {
            let (authority, path) = remote_url.split_once(':')?;
            if path.is_empty() || authority.contains('/') {
                return None;
            }
            authority.rsplit('@').next()?.to_lowercase()
        }
    };

    // Only a plausible hostname becomes a config key; anything else would make
    // a key that can never match a real credential request anyway.
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return None;
    }
    Some(host)
}

/// The `credential.<url>.helper` config key the token helper is installed
/// under for `remote_url`, or `None` when no host can be determined and a
/// token would have nowhere it demonstrably belongs.
///
/// The port is kept when it is not the scheme's default, because git includes
/// it in the `host=` field of a credential request and only a config URL
/// carrying the same port matches. An explicitly written default port is not:
/// `Url::port()` normalizes 443/80 away, exactly as git's own request does.
///
/// An SSH remote maps to the SAME host over https on purpose. The token is a
/// PROVIDER credential, not a transport one, and the frontend's detection
/// hands one back for an SSH remote too (`parse_github_url` takes the
/// `git@github.com:` form). A superproject cloned over SSH routinely lists
/// submodules whose .gitmodules url is https on that same provider, and those
/// children ask git for https credentials for that host — so refusing to scope
/// the token there left the common SSH-superproject case authenticating with
/// nothing, which is the failure this whole path exists to fix.
fn credential_url_key(remote_url: &str) -> Option<String> {
    if let Some(host) = ssh_remote_host(remote_url) {
        return Some(format!("credential.https://{}.helper", host));
    }

    let parsed = url::Url::parse(remote_url).ok()?;
    let scheme = match parsed.scheme() {
        "https" => "https",
        "http" => "http",
        _ => return None,
    };
    let host = parsed.host_str()?.to_lowercase();
    if host.is_empty() {
        return None;
    }
    let authority = match parsed.port() {
        Some(port) => format!("{}:{}", host, port),
        None => host,
    };
    Some(format!("credential.{}://{}.helper", scheme, authority))
}

/// Feed a token to a `git` subprocess as a one-shot credential helper, scoped
/// to the host `remote_url` points at.
///
/// `create_command` sets GIT_TERMINAL_PROMPT=0, so a git subprocess that needs
/// HTTPS credentials and has none simply fails — there is no prompt to fall
/// back to. This hands git the token the app already holds, the same way the
/// git2 paths hand it to `Cred::userpass_plaintext`.
///
/// Configured through GIT_CONFIG_* rather than `-c` on purpose: those are
/// ENVIRONMENT variables, so every child git process inherits them. `git
/// submodule update` clones and fetches each submodule in a child process, and
/// a `-c` on the outer command would not reach them.
///
/// That inheritance is also why the helper MUST be url-scoped rather than
/// installed as a plain `credential.helper`. The helper snippet never reads the
/// credential request on stdin, so an unscoped one answers with this token for
/// whatever host git happens to ask about — and the children `git submodule
/// update` spawns ask for each submodule's OWN url from .gitmodules, which the
/// superproject does not control. Scoped to `credential.https://<host>.helper`,
/// git offers the token only for the host it belongs to and leaves every other
/// host to the user's own helpers.
///
/// Two entries are exported for that one url: an empty value first (git treats
/// an empty `helper` as "clear the list", and because the key is url-scoped it
/// clears only the helpers inherited FOR THIS URL — the user's helpers stay
/// intact for every other host), then the token helper. Without the reset the
/// injected helper is queried last, since GIT_CONFIG_* is applied after the
/// user's config; git stops at the first helper returning a complete
/// credential, so a stale or wrong-account entry in the user's keychain would
/// win and the app's token would never be tried.
/// A blank token is ignored: installing a helper that answers with an empty
/// password would shadow a real authentication failure with a rejected login,
/// giving the user a wronger error than no token at all.
pub fn apply_token_credential_helper(cmd: &mut Command, token: &str, remote_url: &str) {
    if token.trim().is_empty() {
        return;
    }

    let Some(key) = credential_url_key(remote_url) else {
        return;
    };

    cmd.env("GITNADO_GIT_TOKEN", token);
    cmd.env("GIT_CONFIG_COUNT", "2");
    cmd.env("GIT_CONFIG_KEY_0", &key);
    cmd.env("GIT_CONFIG_VALUE_0", "");
    cmd.env("GIT_CONFIG_KEY_1", &key);
    // `git` as the username matches the git2 path's fallback; every provider we
    // support authenticates a token as the password and ignores the username.
    // The token stays in the environment and never enters the URL, so it cannot
    // leak into .git/config, the reflog, or a git error message.
    cmd.env(
        "GIT_CONFIG_VALUE_1",
        "!f() { echo username=git; echo \"password=$GITNADO_GIT_TOKEN\"; }; f",
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_credential_url_key_scopes_to_the_host() {
        assert_eq!(
            credential_url_key("https://github.com/owner/repo.git").as_deref(),
            Some("credential.https://github.com.helper")
        );
    }

    /// Userinfo must not end up in the config key — git's own credential
    /// request carries the host alone in `host=`.
    #[test]
    fn test_credential_url_key_drops_userinfo_and_normalizes_case() {
        assert_eq!(
            credential_url_key("https://someone@GitHub.COM/owner/repo.git").as_deref(),
            Some("credential.https://github.com.helper")
        );
    }

    /// A non-default port is part of git's `host=` field, so it has to be part
    /// of the config url too or the scope never matches.
    #[test]
    fn test_credential_url_key_keeps_a_non_default_port() {
        assert_eq!(
            credential_url_key("https://gitlab.example.com:8443/group/repo.git").as_deref(),
            Some("credential.https://gitlab.example.com:8443.helper")
        );
    }

    /// An explicitly written DEFAULT port must be normalized away, because
    /// git's own credential request omits it — a `credential.https://host:443`
    /// scope would simply never match and the token would go unoffered.
    #[test]
    fn test_credential_url_key_drops_an_explicit_default_port() {
        assert_eq!(
            credential_url_key("https://github.com:443/owner/repo.git").as_deref(),
            Some("credential.https://github.com.helper")
        );
        assert_eq!(
            credential_url_key("http://internal.example:80/owner/repo.git").as_deref(),
            Some("credential.http://internal.example.helper")
        );
    }

    /// A token is a PROVIDER credential: an SSH superproject on github.com
    /// still carries a GitHub token, and its submodules' .gitmodules urls are
    /// routinely https on that same host. Both SSH spellings must therefore
    /// scope the token to the provider's https host.
    #[test]
    fn test_credential_url_key_maps_ssh_remotes_to_the_provider_https_host() {
        assert_eq!(
            credential_url_key("git@github.com:owner/repo.git").as_deref(),
            Some("credential.https://github.com.helper")
        );
        assert_eq!(
            credential_url_key("ssh://git@GitHub.com/owner/repo.git").as_deref(),
            Some("credential.https://github.com.helper")
        );
    }

    /// The ssh PORT describes the ssh endpoint; git's https credential request
    /// never carries it, so keeping it would produce a scope that never fires.
    #[test]
    fn test_credential_url_key_drops_the_ssh_port() {
        assert_eq!(
            credential_url_key("ssh://git@gitlab.example.com:2222/group/repo.git").as_deref(),
            Some("credential.https://gitlab.example.com.helper")
        );
    }

    /// Transports with no host to name, and anything that is not a remote at
    /// all, get nothing injected — a scope we cannot determine is one the token
    /// must not be offered under.
    #[test]
    fn test_credential_url_key_ignores_urls_with_no_provider_host() {
        assert!(credential_url_key("/srv/git/repo.git").is_none());
        assert!(credential_url_key("../sibling/repo.git").is_none());
        assert!(credential_url_key("file:///srv/git/repo.git").is_none());
        assert!(credential_url_key("git://example.com/repo.git").is_none());
        assert!(credential_url_key("").is_none());
    }

    /// A Windows drive path parses as a scheme (`c:`), so it must not be
    /// mistaken for the scp-like form and turned into a host named `c`.
    #[test]
    fn test_credential_url_key_ignores_a_windows_drive_path() {
        assert!(credential_url_key("C:/Users/dev/repo.git").is_none());
        assert!(credential_url_key("C:\\Users\\dev\\repo.git").is_none());
    }

    /// The whole point of the scoping: the injected keys must name the host, so
    /// git cannot offer the token for a request about any other one.
    #[test]
    fn test_apply_token_credential_helper_exports_url_scoped_keys() {
        let mut cmd = Command::new("git");
        apply_token_credential_helper(&mut cmd, "ghp_secret", "https://example.com/super.git");

        let envs: std::collections::HashMap<String, String> = cmd
            .get_envs()
            .filter_map(|(k, v)| {
                Some((
                    k.to_string_lossy().to_string(),
                    v?.to_string_lossy().to_string(),
                ))
            })
            .collect();

        assert_eq!(envs.get("GIT_CONFIG_COUNT").map(String::as_str), Some("2"));
        assert_eq!(
            envs.get("GIT_CONFIG_KEY_0").map(String::as_str),
            Some("credential.https://example.com.helper")
        );
        // The url-scoped reset, so the injected helper is not queried last.
        assert_eq!(envs.get("GIT_CONFIG_VALUE_0").map(String::as_str), Some(""));
        assert_eq!(
            envs.get("GIT_CONFIG_KEY_1").map(String::as_str),
            Some("credential.https://example.com.helper")
        );
        assert_eq!(
            envs.get("GITNADO_GIT_TOKEN").map(String::as_str),
            Some("ghp_secret")
        );
    }

    /// Nothing may be injected for a URL that names no provider host — in
    /// particular the token must not be exported into the environment.
    #[test]
    fn test_apply_token_credential_helper_injects_nothing_without_a_host() {
        let mut cmd = Command::new("git");
        apply_token_credential_helper(&mut cmd, "ghp_secret", "/srv/git/repo.git");

        let keys: Vec<String> = cmd
            .get_envs()
            .map(|(k, _)| k.to_string_lossy().to_string())
            .collect();
        assert!(!keys.iter().any(|k| k == "GIT_CONFIG_COUNT"));
        assert!(!keys.iter().any(|k| k == "GITNADO_GIT_TOKEN"));
    }

    /// An SSH remote DOES name a provider host, and the token is a provider
    /// credential, so it is scoped to that host over https — the transport the
    /// submodule children actually ask credentials for.
    #[test]
    fn test_apply_token_credential_helper_scopes_ssh_to_the_provider_https_host() {
        let mut cmd = Command::new("git");
        apply_token_credential_helper(&mut cmd, "ghp_secret", "git@github.com:owner/repo.git");

        let envs: std::collections::HashMap<String, String> = cmd
            .get_envs()
            .filter_map(|(k, v)| {
                Some((
                    k.to_string_lossy().to_string(),
                    v?.to_string_lossy().to_string(),
                ))
            })
            .collect();

        assert_eq!(
            envs.get("GIT_CONFIG_KEY_1").map(String::as_str),
            Some("credential.https://github.com.helper")
        );
        assert_eq!(
            envs.get("GITNADO_GIT_TOKEN").map(String::as_str),
            Some("ghp_secret")
        );
    }

    /// A blank token must install nothing, even for an otherwise valid host:
    /// a helper that answers with an empty password would shadow a real
    /// authentication failure with a rejected login rather than no token at
    /// all.
    #[test]
    fn test_apply_token_credential_helper_ignores_a_blank_token() {
        let mut cmd = Command::new("git");
        apply_token_credential_helper(&mut cmd, "   ", "https://github.com/o/r.git");

        let keys: Vec<String> = cmd
            .get_envs()
            .map(|(k, _)| k.to_string_lossy().to_string())
            .collect();
        assert!(!keys.iter().any(|k| k == "GIT_CONFIG_COUNT"));
        assert!(!keys.iter().any(|k| k == "GITNADO_GIT_TOKEN"));
    }
}
