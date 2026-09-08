//! Backend enforcement of the network security settings.
//!
//! "Offline mode" and the "remote allowlist" used to live only in the
//! frontend, in `checkNetworkAllowed` (`src/services/git.service.ts`). That
//! made the guarantee only as good as every call site remembering to ask: two
//! separate holes (cloud AI requests, Gravatar image loads) shipped that way,
//! and the enumeration test written to catch the class missed them both.
//!
//! This module puts the same two rules where the requests actually happen, so
//! a command that forgets the frontend gate still cannot reach the network.
//! The frontend gate stays exactly as it is — it is the half that can explain
//! the refusal in a toast BEFORE any work starts. This half is the backstop,
//! and it deliberately returns the same `BLOCKED` code the frontend gate
//! already returns, so a caller that was written to stay quiet about a refusal
//! does not suddenly show a second error for the same event.
//!
//! ## Matching the frontend exactly
//!
//! The allowlist rules here are a transliteration of `checkNetworkAllowed`
//! and `cloneUrlHost`, and the unit tests below pin the cases those comments
//! call out: an empty list allows everything, a bare entry covers the domain
//! and its subdomains, a look-alike host (`github.com.evil.test`) is refused,
//! and a URL that merely *names* an allowed domain in its path is refused.
//! Being stricter than the frontend would refuse operations the user can see
//! being allowed in Settings, so any change here has to move in step with it.

use crate::error::{GitnadoError, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

/// Where the backend keeps its own copy of the two settings.
///
/// The frontend persists them in `localStorage`, which the backend cannot
/// read. Without a backend-side copy the very first operation after launch
/// would run unguarded — the frontend only pushes the settings once its shell
/// has mounted. So every push is mirrored to this file and read back at
/// startup. The frontend remains the source of truth: its push overwrites this
/// file, it never reads from it.
const SECURITY_FILE: &str = "security_settings.json";

/// The two settings this module enforces.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecuritySettings {
    /// Refuse every outbound request.
    #[serde(default)]
    pub offline_mode: bool,
    /// When non-empty, only these domains (and their subdomains) are allowed.
    #[serde(default)]
    pub remote_allowlist: Vec<String>,
}

#[derive(Debug, Default)]
struct Inner {
    settings: SecuritySettings,
    config_dir: Option<PathBuf>,
    /// Whether `security_settings.json` currently holds `settings`.
    ///
    /// The no-op skip in [`SecurityState::set`] is what makes this necessary.
    /// Keying that skip on memory alone meant a write that failed once — an
    /// unwritable config dir, a full disk — was never retried, because every
    /// later push carried the same settings and returned early. The mirror
    /// exists solely to give the pre-mount window at the NEXT launch the right
    /// policy, and a stale `offlineMode: false` there fails OPEN.
    mirrored: bool,
}

/// Tauri-managed handle to the current security settings.
///
/// Cloneable and cheap: `.manage()` holds one clone, and the process-wide
/// [`global`] handle holds another so a guard can be a single line at the top
/// of a command instead of a new `State` parameter on every one of them.
/// Threading a parameter through would have rewritten the signature of every
/// fetch/pull/push command, which is exactly the surface an in-flight branch
/// is already editing.
#[derive(Debug, Clone, Default)]
pub struct SecurityState {
    inner: Arc<RwLock<Inner>>,
}

impl SecurityState {
    /// The settings as they stand right now.
    ///
    /// A poisoned lock is recovered with `into_inner()` rather than swallowed:
    /// falling back to `SecuritySettings::default()` would fail OPEN — offline
    /// mode off and an empty allowlist is the most permissive state there is,
    /// which is exactly the wrong direction for the module whose job is to
    /// refuse. The critical sections here are a clone and an assignment, so the
    /// settings behind a poisoned lock are still the last ones stored. Same
    /// recovery as `remote_ops.rs` and `mcp/server.rs`.
    pub fn snapshot(&self) -> SecuritySettings {
        self.inner
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .settings
            .clone()
    }

    /// Point the state at the app config directory and adopt whatever was
    /// persisted there by the previous run.
    pub fn init(&self, config_dir: PathBuf) {
        let loaded = load_from_disk(&config_dir);
        let mut inner = self.inner.write().unwrap_or_else(|e| e.into_inner());
        inner.config_dir = Some(config_dir);
        // A mirror that was read back IS in step with memory. A missing or
        // unreadable one is not, so the next push writes it even if it carries
        // exactly the settings already in memory.
        inner.mirrored = loaded.is_some();
        if let Some(settings) = loaded {
            inner.settings = settings;
        }
    }

    /// Replace the settings and mirror them to disk.
    ///
    /// A push that changes nothing AND is already mirrored returns without
    /// touching the file. The frontend re-emits the WHOLE settings object on
    /// every settings write — a theme change, a slider drag, each keystroke in
    /// a text field — and all of those arrive here carrying the security
    /// settings unchanged; without that check each one rewrites
    /// `security_settings.json`.
    ///
    /// The `mirrored` half of the condition is not optional. Keyed on memory
    /// alone, a write that failed once was never retried for the rest of the
    /// session, because every later push was identical and returned early.
    ///
    /// The write happens while the lock is still HELD, and that is deliberate
    /// too: it is a tiny file, and saving outside the lock let two concurrent
    /// `apply_payload` handlers (Tauri runs each `emit` on its own task)
    /// commit memory in one order and the file in the other, leaving the
    /// mirror permanently disagreeing with memory — after which every later
    /// identical push skipped and never repaired it.
    pub fn set(&self, settings: SecuritySettings) {
        let mut inner = self.inner.write().unwrap_or_else(|e| e.into_inner());
        if inner.settings == settings && inner.mirrored {
            return;
        }
        inner.settings = settings;
        let Some(dir) = inner.config_dir.clone() else {
            // Nowhere to mirror to yet (`init` has not run). Memory is
            // updated; `mirrored` stays false so the first push after `init`
            // writes the file even if nothing changed.
            return;
        };
        let written = save_to_disk(&dir, &inner.settings);
        inner.mirrored = written;
    }

    /// Adopt the payload of an `update-security-settings` event.
    ///
    /// Returns the settings that were adopted, or `None` when the payload was
    /// not a security-settings object. A field the payload omits keeps its
    /// current value rather than silently reverting to the permissive default:
    /// a malformed push must never be able to turn offline mode off.
    pub fn apply_payload(&self, payload: &str) -> Option<SecuritySettings> {
        let value: serde_json::Value = serde_json::from_str(payload).ok()?;
        let object = value.as_object()?;
        let mut settings = self.snapshot();
        let mut recognised = false;
        if let Some(offline) = object.get("offlineMode").and_then(|v| v.as_bool()) {
            settings.offline_mode = offline;
            recognised = true;
        }
        if let Some(list) = object.get("remoteAllowlist").and_then(|v| v.as_array()) {
            settings.remote_allowlist = list
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect();
            recognised = true;
        }
        if !recognised {
            return None;
        }
        self.set(settings.clone());
        Some(settings)
    }
}

fn load_from_disk(config_dir: &Path) -> Option<SecuritySettings> {
    let path = config_dir.join(SECURITY_FILE);
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

/// Write the mirror. Returns whether the file now holds `settings`.
///
/// The caller records that answer: a failure that is only logged is a failure
/// nothing ever retries.
fn save_to_disk(config_dir: &Path, settings: &SecuritySettings) -> bool {
    if let Err(e) = std::fs::create_dir_all(config_dir) {
        tracing::warn!("Could not create config dir for security settings: {}", e);
        return false;
    }
    match serde_json::to_string_pretty(settings) {
        Ok(contents) => match std::fs::write(config_dir.join(SECURITY_FILE), contents) {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!("Could not persist security settings: {}", e);
                false
            }
        },
        Err(e) => {
            tracing::warn!("Could not serialize security settings: {}", e);
            false
        }
    }
}

static GLOBAL: Lazy<SecurityState> = Lazy::new(SecurityState::default);

/// The process-wide security state. Same handle Tauri manages.
pub fn global() -> &'static SecurityState {
    &GLOBAL
}

/// Host of a URL, covering the forms git accepts.
///
/// Mirrors `cloneUrlHost` in `src/services/git.service.ts`: `https://host/path`,
/// `ssh://git@host/path`, and the scheme-less scp-like `[user@]host:owner/repo.git`
/// that no URL parser accepts. Matching on the HOST rather than on a substring
/// of the whole URL is the point — `https://github.com.evil.test/x.git`
/// literally contains `github.com`.
pub fn url_host(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if !trimmed.contains("://") {
        return scp_like_host(trimmed);
    }
    parse_url_target(trimmed).map(|target| target.host)
}

/// `[user@]host:path` — the scp-like form. The frontend's `scpLikeHost` is the
/// same rule, bracketed IPv6 literal included.
///
/// Its parenthesis used to read `([^:\/]+)`, and the comment here claimed it
/// "declines rather than mis-reads" the bracketed form. It did not: it stopped
/// at the first colon INSIDE the literal, so `git@[2001:db8::1]:team/app.git`
/// resolved to `[2001` while this half resolved the whole `[2001:db8::1]`. The
/// two gates then disagreed in the direction that cannot be worked around — the
/// backend allowed the remote and the frontend refused it first, naming a
/// remote the allowlist did name, and no entry could make it pass. Any change
/// to either half has to move both.
///
/// The login is OPTIONAL, exactly as it is to git: `gitserver:team/app.git` is
/// an ssh remote, and it is the spelling an `~/.ssh/config` `Host` alias leaves
/// behind. Requiring it resolved that remote to no host at all — no allowlist
/// entry could ever permit it, and the credentials dialog reported a working
/// ssh remote as a broken https one.
fn scp_like_host(value: &str) -> Option<String> {
    split_scp_like(value).map(|scp| scp.host.to_lowercase())
}

/// The parts of an scp-like target, split the way git splits it.
struct ScpLike<'a> {
    /// The login named ahead of the host, if the target names one at all.
    login: Option<&'a str>,
    /// The host, as written.
    host: &'a str,
    /// Everything after the separating colon: the repository PATH, never a
    /// port — `git@host:2222` is the repository `2222`, not port 2222.
    path: &'a str,
}

/// Split `[user@]host:path`, or `None` when `value` is not that form.
///
/// git (`connect.c`, `url_is_local_not_ssh`) reads a target as scp-like as soon
/// as a colon comes before any slash, with the `user@` optional and a Windows
/// drive letter carved out. That is the rule here, with two guards of its own:
///
/// - the login is looked for only AHEAD of the separating colon, because that
///   is where git looks. `git@github.com:x@evil.test:y` is the path
///   `x@evil.test:y` on `github.com`, not a repository on `evil.test`; taking
///   the first `@` in the whole string read the same trick spelled without a
///   login (`gitserver:x@evil.test:y`) as `evil.test`, a host the gate would
///   then judge instead of the one git contacts;
/// - a separator inside the host means the colon is inside a PATH, in either
///   spelling — `./x:y` and `.\x:y` stay paths.
fn split_scp_like(value: &str) -> Option<ScpLike<'_>> {
    // A scheme is not a login-less authority. Every caller checks for one
    // ahead of this and takes the URL parser instead, so this only ever keeps
    // the answer honest for a caller that does not: with the login optional,
    // the first colon of `https://h/x` would otherwise make `https` its host.
    if value.contains("://") {
        return None;
    }
    let (login, rest) = match value.find(['@', ':', '/']) {
        Some(at) if value.as_bytes()[at] == b'@' => {
            if at == 0 {
                // `@host:path` names an empty login: not a form git accepts.
                return None;
            }
            (Some(&value[..at]), &value[at + 1..])
        }
        _ => (None, value),
    };
    // A bracketed IPv6 literal carries colons of its own; only one AFTER the
    // closing bracket separates the host from the path.
    let colon = if rest.starts_with('[') {
        let end = rest.find(']')?;
        rest[end..].find(':').map(|i| end + i)?
    } else {
        rest.find(':')?
    };
    if colon == 0 {
        return None;
    }
    let host = &rest[..colon];
    if host.contains('/') || host.contains('\\') {
        return None;
    }
    // With no login to say otherwise, a one-letter authority is a Windows drive
    // — `C:\repos\app.git`, `C:/repos/app.git`, `c:x` — and git carves the
    // same one out. `git@c:x` keeps its host: a login says a host precedes it.
    if login.is_none() && host.len() == 1 && host.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    Some(ScpLike {
        login,
        host,
        path: &rest[colon + 1..],
    })
}

/// Where a remote URL points: the login it names, the host, and the port.
///
/// The allowlist and the command that then contacts the host have to agree on
/// WHERE the request is going, so both read this one parse. They used to have
/// two. The gate took the host after the first `@` — which is what git does —
/// while `test_credentials` and `test_ssh_connection` took the one after the
/// LAST, so `git@github.com:x@evil.test:y` was approved as `github.com` and
/// then handed to `ssh` as `evil.test`: an outbound connection to a host the
/// allowlist never saw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteTarget {
    /// The login the URL names, if it names one. `git` is deliberately NOT
    /// substituted here: an scp-form remote may authenticate as `deploy`, and
    /// an AWS CodeCommit URL as an access-key id.
    pub user: Option<String>,
    /// Lowercased host — the exact string [`host_allowed`] judges.
    pub host: String,
    /// The port the URL names, if it names one.
    pub port: Option<u16>,
    /// The URL's scheme, lowercased. `None` for the scheme-less forms.
    pub scheme: Option<String>,
    /// Whether git would reach this remote over ssh: an `ssh://`/`git+ssh://`
    /// URL, the scp-like `[user@]host:path` (whose login is optional — a
    /// `~/.ssh/config` alias leaves `gitserver:team/app.git` behind), or a
    /// scheme-less `user@host` whose login says the same thing.
    pub is_ssh: bool,
}

/// Resolve `target` the way [`check`] judges it — the same rule, with the rest
/// of the answer the callers need to contact it.
///
/// This is the reading for a string that may be an SSH DESTINATION rather than
/// a git remote — the Settings > SSH host field, which is the only input in the
/// app that accepts the scheme-less `host:port` form. git has no such REMOTE
/// form, so a caller holding a remote must take [`parse_remote_target`]
/// instead. The two answer the same HOST for every string; only the port, the
/// scheme and `is_ssh` can differ, and only for a login-less `host:<u16>`.
pub fn parse_target(target: &str) -> Option<RemoteTarget> {
    parse_target_inner(target, true)
}

/// [`parse_target`] for a string the caller knows is a git REMOTE.
///
/// The colon of a scheme-less remote separates the host from the PATH, whatever
/// that path looks like: `gitserver:2024` is the repository `2024` on the
/// `~/.ssh/config` alias `gitserver`, exactly as `git@host:2222` already was.
/// Reading it as port 2024 made it a login-less target with no scheme, so
/// `credential_target` called it `https` and `resolved`, the `protocol == "ssh"
/// && resolved` guard skipped the ssh probe, and the dialog drew a red "No
/// Credentials Found / Protocol: https / Host: gitserver:2024" for a working
/// ssh remote — or, where an unrelated `https://gitserver:2024` credential
/// existed, "Credentials Working" with an Erase button pointed at it.
///
/// The GATE is unaffected either way: both readings resolve the host
/// `gitserver`, which is the only part [`check`] judges.
pub fn parse_remote_target(target: &str) -> Option<RemoteTarget> {
    parse_target_inner(target, false)
}

/// `bare_host_port` says which question is being asked of a login-less
/// `host:<u16>`: the SSH host field's `host:port` (true), or a repository whose
/// name happens to parse as a number (false). Nothing else differs.
fn parse_target_inner(target: &str, bare_host_port: bool) -> Option<RemoteTarget> {
    let trimmed = target.trim();
    if !trimmed.contains("://") {
        if let Some(scp) = split_scp_like(trimmed) {
            // `host:port` is the one scheme-less spelling whose colon is a
            // PORT rather than the scp separator: it is what the SSH settings
            // dialog's host field accepts, and dropping the port there sends
            // `ssh -T` to :22 of a server that does not listen on it. It is
            // read below, exactly as it always was — the HOST is the same
            // either way, so the allowlist sees no change — and a login says
            // it is not that form: `git@host:2222` is the repository `2222`.
            // A caller that holds a REMOTE says so by taking
            // `parse_remote_target`, for which no such form exists at all.
            if bare_host_port && scp.login.is_none() && scp.path.parse::<u16>().is_ok() {
                if let Some(mut resolved) = parse_url_target(&format!("https://{}", trimmed)) {
                    resolved.is_ssh = resolved.user.is_some();
                    resolved.scheme = None;
                    return Some(resolved);
                }
            }
            return Some(RemoteTarget {
                user: scp.login.map(|login| login.to_string()),
                host: scp.host.to_lowercase(),
                port: None,
                scheme: None,
                is_ssh: true,
            });
        }
        // Bare `host`, `host:port` and `user@host` — the forms the SSH settings
        // dialog accepts. Reading them as an https URL is what this gate has
        // always done; a login and no scheme means an ssh destination.
        let mut resolved = parse_url_target(&format!("https://{}", trimmed))?;
        resolved.is_ssh = resolved.user.is_some();
        resolved.scheme = None;
        return Some(resolved);
    }
    parse_url_target(trimmed)
}

/// The `[user@]host[:port]` of a target that carries a scheme.
fn parse_url_target(url: &str) -> Option<RemoteTarget> {
    let parsed = url::Url::parse(url.trim()).ok()?;
    let host = parsed
        .host_str()
        .filter(|host| !host.is_empty())?
        .to_lowercase();
    let user = parsed.username();
    let scheme = parsed.scheme().to_lowercase();
    Some(RemoteTarget {
        user: (!user.is_empty()).then(|| user.to_string()),
        host,
        port: parsed.port(),
        is_ssh: scheme == "ssh" || scheme == "git+ssh",
        scheme: Some(scheme),
    })
}

/// The host a target string resolves to, trying it as written and then as an
/// https URL — the fallback is what lets the bare `git@host` and `host` forms
/// resolve, exactly as the frontend does.
fn target_host(target: &str) -> Option<String> {
    parse_target(target).map(|resolved| resolved.host)
}

/// Whether `host` is covered by `allowlist`.
///
/// Entries are domains, so a bare `github.com` covers `github.com` and
/// `*.github.com` but not `github.com.evil.test`. A leading `*.` is accepted
/// and means the same thing a bare entry already means.
pub fn host_allowed(host: &str, allowlist: &[String]) -> bool {
    allowlist.iter().any(|entry| {
        let normalized = entry.trim().to_lowercase();
        let normalized = normalized.strip_prefix("*.").unwrap_or(&normalized);
        let allowed_host = if normalized.contains("://") {
            url_host(normalized)
        } else {
            url_host(&format!("https://{}", normalized))
        }
        .unwrap_or_else(|| normalized.to_string());
        if allowed_host.is_empty() {
            return false;
        }
        host == allowed_host || host.ends_with(&format!(".{}", allowed_host))
    })
}

/// The core check. `target` is the URL (or bare host) the operation will
/// contact; `None` means the caller could not work one out.
///
/// This is the reading for a target that may be a bare host or a scheme-less
/// endpoint. A caller holding a git REMOTE takes [`check_remote`], which adds
/// the one carve-out only a remote can claim — see [`is_local_remote_target`].
pub fn check(settings: &SecuritySettings, target: Option<&str>) -> Result<()> {
    check_target(settings, target, is_local_target)
}

/// [`check`] for a target the caller knows is a git REMOTE.
pub fn check_remote(settings: &SecuritySettings, target: Option<&str>) -> Result<()> {
    check_target(settings, target, is_local_remote_target)
}

fn check_target(
    settings: &SecuritySettings,
    target: Option<&str>,
    is_local: fn(&str) -> bool,
) -> Result<()> {
    // A filesystem remote never leaves the machine, so neither setting applies
    // — the same carve-out `is_loopback_host` makes for an endpoint, and ahead
    // of the offline branch for the same reason.
    if target.is_some_and(is_local) {
        return Ok(());
    }
    if settings.offline_mode {
        return Err(GitnadoError::NetworkBlocked(
            "Offline mode is enabled. Disable in Settings > Security.".to_string(),
        ));
    }
    if settings.remote_allowlist.is_empty() {
        return Ok(());
    }
    // An allowlist that cannot see the URL must refuse, not wave the operation
    // through: silently allowing is the failure mode that made this setting
    // decorative in the first place.
    let Some(target) = target.filter(|t| !t.trim().is_empty()) else {
        return Err(GitnadoError::NetworkBlocked(
            "Could not determine the remote URL, and an allowlist is configured".to_string(),
        ));
    };
    match target_host(target) {
        Some(host) if host_allowed(&host, &settings.remote_allowlist) => Ok(()),
        Some(_) => Err(GitnadoError::NetworkBlocked(format!(
            "Remote \"{}\" is not in your allowlist",
            target
        ))),
        None => Err(GitnadoError::NetworkBlocked(
            "Could not determine the remote URL, and an allowlist is configured".to_string(),
        )),
    }
}

/// Guard an operation whose destination the caller already knows as a URL or
/// bare host — clone, `add_submodule`, a provider's API base.
pub fn guard_url(url: &str) -> Result<()> {
    check(&global().snapshot(), Some(url))
}

/// [`guard_url`] for a URL the caller knows is a git REMOTE — a clone URL, a
/// submodule url, the auto-fetch loop's resolved remote, the remote the
/// credentials dialog is testing.
///
/// Same rule, plus the bare relative path only a remote can be
/// ([`is_local_remote_target`]). Splitting the two is what keeps that carve-out
/// off a scheme-less endpoint or provider instance URL, where it would fail
/// open.
pub fn guard_remote_url(url: &str) -> Result<()> {
    check_remote(&global().snapshot(), Some(url))
}

/// Guard an operation against a remote of `repo_path`.
///
/// `remote` is a remote NAME (`origin`) or a URL; `None` means the operation
/// targets the repository's default remote. With no policy in force nothing is
/// resolved at all, so the common case costs nothing; once one is, the remote's
/// URL is read from the local config so a filesystem remote can be told apart
/// from one that leaves the machine.
pub fn guard_remote(repo_path: &str, remote: Option<&str>) -> Result<()> {
    guard_remote_for(repo_path, remote, false)
}

/// [`guard_remote`] for a PUSH-class operation — push, push tag, delete
/// remote tag, multi-remote push.
///
/// A push contacts `remote.<name>.pushurl` when one is configured, and git2
/// and `git push` both honour it; the fetch URL says nothing about where the
/// objects are going. The token scoping in `remote.rs::push_remote_url`
/// already knew this; the allowlist did not, so `url = github.com` with
/// `pushurl = gitlab.example` passed a `github.com` allowlist and pushed to
/// gitlab.example.
pub fn guard_push_remote(repo_path: &str, remote: Option<&str>) -> Result<()> {
    guard_remote_for(repo_path, remote, true)
}

fn guard_remote_for(repo_path: &str, remote: Option<&str>, for_push: bool) -> Result<()> {
    let settings = global().snapshot();
    if !settings.offline_mode && settings.remote_allowlist.is_empty() {
        return Ok(());
    }
    // Offline mode used to refuse here without ever looking at the target, so
    // a push to `/mnt/usb/repo.git` was refused as if it were leaving the
    // machine. `check` makes that judgement now, and it needs the URL to make
    // it — the lookup is a local config read, and only on a path a policy is
    // in force on.
    let url = resolve_remote_url(repo_path, remote, for_push);
    check_remote(&settings, url.as_deref())
}

/// The URL an operation against `remote` will contact.
///
/// Mirrors `resolveRemoteUrl` / `resolveRemotePushUrl` in the frontend: a
/// value that already looks like a URL is passed through, a named remote is
/// looked up, and a caller that named none gets the remote git itself would
/// use. With `for_push` the remote's `pushurl` wins when it has one, because
/// that is the URL a push actually reaches.
///
/// "Named none" does NOT mean `origin`. A `git fetch` with no remote, a
/// relative submodule url, and `git lfs pull` all go to the current branch's
/// tracking remote first (`branch.<n>.remote`), and only then to `origin` —
/// the rule `remote::resolve_fetch_remote` already applies for fetch and pull.
/// Assuming `origin` here judged the wrong host in the ordinary fork layout:
/// origin on github.com, the branch tracking `upstream` on gitlab.com, and a
/// `github.com` allowlist waving through a fetch that went to gitlab.
fn resolve_remote_url(repo_path: &str, remote: Option<&str>, for_push: bool) -> Option<String> {
    if let Some(remote) = remote {
        if looks_like_url(remote) {
            return Some(remote.to_string());
        }
    }
    let url_of = |found: git2::Remote<'_>| -> Option<String> {
        if for_push {
            if let Ok(Some(push_url)) = found.pushurl() {
                return Some(push_url.to_string());
            }
        }
        found.url().ok().map(|u| u.to_string())
    };
    let repo = git2::Repository::open(Path::new(repo_path)).ok()?;
    let wanted = match remote {
        Some(name) => name.to_string(),
        None => crate::commands::remote::resolve_fetch_remote(&repo, None),
    };
    if let Ok(found) = repo.find_remote(&wanted) {
        return url_of(found);
    }
    if remote.is_none() {
        let names = repo.remotes().ok()?;
        let first = names.iter().filter_map(|s| s.ok().flatten()).next()?;
        return repo.find_remote(first).ok().and_then(url_of);
    }
    None
}

fn looks_like_url(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.contains("://") || scp_like_host(trimmed).is_some()
}

/// Whether a host is the machine itself.
///
/// A request to loopback never leaves the machine, so offline mode has no
/// business refusing it — that is what keeps a locally hosted AI model (Ollama,
/// LM Studio) usable with offline mode on, which is the whole point of running
/// one.
fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host == "localhost"
        || host.ends_with(".localhost")
        || host == "::1"
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

/// Whether a target is a place on THIS machine — a filesystem path or a
/// host-less `file://` URL.
///
/// Same principle as [`is_loopback_host`], one layer further in: a push to
/// `/mnt/usb/repo.git` or `file:///srv/git/app.git` opens no socket at all, so
/// offline mode ("block every operation that leaves this machine") and the
/// remote allowlist (a list of HOSTS) have no business refusing it. They both
/// did: offline mode refused a push to a USB disk, and the allowlist read
/// `/mnt/usb/repo.git` as the host `mnt` — so the only way to permit it was to
/// allowlist the literal string `mnt`, and no entry at all could permit a
/// `file://` URL, whose host is empty.
///
/// Deliberately EXCLUDED, because they do leave the machine:
///
/// - a UNC path (`\\server\share`, and its `//server/share` spelling), which
///   is SMB;
/// - `file://host/path` naming ANOTHER machine — git hands it to the transport
///   with that host, and on Windows it is the UNC form again. This machine is
///   an empty host (`file:///…`, and `file://localhost/…`, which the URL spec
///   folds to the same thing) and every host [`is_loopback_host`] recognises —
///   `file://127.0.0.1/…`, `file://[::1]/…`, `file://build.localhost/…` — which
///   is the same carve-out an AI endpoint on loopback already gets, for the
///   same reason: loopback is definitively this machine;
/// - anything [`scp_like_host`] recognises, so `~user@host:repo.git` is read as
///   the ssh remote git would read it rather than as a `~` path — and so is
///   `gitserver:team/app.git`, whose login an `~/.ssh/config` `Host` alias
///   supplies rather than the URL;
/// - anything else carrying a scheme, so a path with a URL embedded in it
///   cannot smuggle one past this.
///
/// A path that is really a network MOUNT (NFS, or a mapped `Z:` drive) is not
/// excluded, because nothing in the string says so — telling it apart needs the
/// OS mount table. The kernel, not this app, does that I/O, and git opens no
/// socket for it; the same is already true of every local operation the gate
/// permits.
///
/// A BARE relative path (`sub/mybackup.git`, with no leading `./`) is excluded
/// here too, and that is deliberate rather than an oversight: this function
/// also judges strings that are not remotes at all — a bare host, a scheme-less
/// AI endpoint or provider instance URL — where reading a separator as "this is
/// a path" would wave an outbound request through unjudged. A caller that KNOWS
/// it holds a git remote takes [`is_local_remote_target`], which adds it.
///
/// The frontend mirror is `isLocalTarget` in `src/services/git.service.ts`; any
/// change to either half has to move both.
pub(crate) fn is_local_target(target: &str) -> bool {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return false;
    }
    // UNC, in either spelling.
    if trimmed.starts_with("//") || trimmed.starts_with(r"\\") {
        return false;
    }
    if trimmed
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"))
    {
        return match url::Url::parse(trimmed) {
            Ok(parsed) => parsed
                .host_str()
                .is_none_or(|host| host.is_empty() || is_loopback_host(host)),
            Err(_) => false,
        };
    }
    if trimmed.contains("://") || scp_like_host(trimmed).is_some() {
        return false;
    }
    trimmed.starts_with('/')
        // `.` and `..` are `./` and `../` without the separator — the spelling
        // `git remote add local .` leaves behind.
        || trimmed == "."
        || trimmed == ".."
        || trimmed.starts_with("./")
        || trimmed.starts_with("../")
        || trimmed.starts_with(".\\")
        || trimmed.starts_with("..\\")
        || trimmed.starts_with('~')
        || is_windows_drive_path(trimmed)
}

/// [`is_local_target`] for a string the caller knows is a git REMOTE: the same
/// rule, plus the BARE relative path only a remote can be.
///
/// `git init --bare sub/mybackup.git && git remote add b2 sub/mybackup.git` is
/// purely local — git's `url_is_local_not_ssh` (`connect.c`) reads a target with
/// no colon, or with a slash before its colon, as a path, and the push that
/// follows opens no socket. [`is_local_target`] refuses it, so offline mode
/// blocked a push that never leaves the machine, the allowlist read the host as
/// `sub` (the only workaround being to allowlist the literal string `sub`), and
/// the credentials dialog drew "Host: sub / Protocol: https / No Credentials
/// Found" for a repository on the same disk.
///
/// WHY THIS IS A SECOND FUNCTION rather than a widening of the first: the rule
/// is only safe where the string is known to be a remote. [`is_local_target`]
/// is also asked about a bare host (`checkOutboundHostAllowed("api.github.com")`,
/// the SSH settings host field, [`guard_endpoint`]) and about a scheme-less
/// endpoint or provider instance URL — `gitlab.example.com/gitlab`, which the
/// GitLab dialog's free-text instance field accepts and `providerApiHost` hands
/// straight to the gate. Calling THAT local would fail OPEN: the request would
/// be waved through as "never leaves the machine" and its host never judged. A
/// bare host carries no separator; a scheme-less instance URL with a path
/// segment does. So the separator rule lives here, behind a caller that has
/// said which question it is asking.
///
/// `mybackup.git` — no separator at all — stays NON-local even here, and is
/// pinned that way: nothing in that string tells it apart from a bare host, so
/// reading it as a path would wave a bare host through with its host never
/// judged. A user who wants it treated as local writes `./mybackup.git`, which
/// git accepts and both halves already read that way.
///
/// The frontend mirror is `isLocalRemoteTarget` in
/// `src/services/git.service.ts`; any change to either half has to move both.
pub(crate) fn is_local_remote_target(target: &str) -> bool {
    is_local_target(target) || is_bare_relative_path(target)
}

/// A relative path written without a `./` — `sub/mybackup.git`, `sub\backup`.
///
/// Everything [`is_local_target`] excludes is excluded here first, and for the
/// same reasons: a UNC path is SMB, a scheme is the URL parser's business, and
/// the scp-like form is an ssh remote whose colon comes BEFORE any separator.
/// What is left carrying a separator is a path relative to the working
/// directory, which is what git makes of it.
fn is_bare_relative_path(target: &str) -> bool {
    let trimmed = target.trim();
    if trimmed.starts_with("//") || trimmed.starts_with(r"\\") {
        return false;
    }
    // `file://…` is caught by the scheme test, and [`is_local_target`] has
    // already given it the answer its host deserves.
    if trimmed.contains("://") || scp_like_host(trimmed).is_some() {
        return false;
    }
    trimmed.contains('/') || trimmed.contains('\\')
}

/// `C:\repos\app.git` / `C:/repos/app.git`.
fn is_windows_drive_path(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(
        (chars.next(), chars.next(), chars.next()),
        (Some(drive), Some(':'), Some('/' | '\\')) if drive.is_ascii_alphabetic()
    )
}

/// Whether an AI provider endpoint may be contacted.
///
/// An empty endpoint is the embedded local model, which has no endpoint at all.
pub fn endpoint_allowed(endpoint: &str) -> bool {
    guard_endpoint(endpoint).is_ok()
}

/// [`endpoint_allowed`], but returning the refusal so a command can report it.
pub fn guard_endpoint(endpoint: &str) -> Result<()> {
    if endpoint.trim().is_empty() {
        return Ok(());
    }
    if target_host(endpoint).is_some_and(|host| is_loopback_host(&host)) {
        return Ok(());
    }
    guard_url(endpoint)
}

/// Test-only control over the process-wide state.
///
/// The guards read [`global`] rather than taking a `State` parameter, so a test
/// that wants a command to refuse has to set the real thing — and Rust runs
/// tests in parallel threads, so a policy one test switches on is seen by
/// every test running beside it. Two kinds of test therefore have to take
/// turns:
///
/// - a WRITER ([`test_support::offline`], [`test_support::allowlist`],
///   [`test_support::with`]) pins a restrictive policy and expects refusals;
/// - a READER ([`test_support::no_policy`], taken by every
///   [`crate::test_utils::TestRepo`]) pins the permissive default and expects
///   guarded operations to go through.
///
/// Readers share the lock with each other and exclude writers; a writer
/// excludes everyone. A reader that runs unlocked passes on an idle machine and
/// fails under load, the moment it overlaps a writer, with a `NetworkBlocked`
/// it never anticipated — that is what `TestRepo` taking the reader guard is
/// for, and `scripts/security-lock.test.mjs` names any test that reaches the
/// gate without holding either guard.
///
/// Both guards nest on the thread that holds them: a test may build a
/// `TestRepo` before or after switching a policy on, and a writer may open a
/// second, inner policy. Dropping a writer restores what it replaced.
///
/// Two shapes no test uses today, named so a future CI hang is a message
/// rather than a mystery:
///
/// - Nesting is PER THREAD. A test that holds a writer and then spawns a
///   thread which builds a `TestRepo` (or takes `no_policy()`) and joins it
///   deadlocks silently: the reader on the new thread waits for the writer
///   the joining thread will never drop.
/// - `Hold::UnderWriter` keeps the OUTER writer alive for as long as a
///   `TestRepo` built under it lives, so a `TestRepo` that outlives the
///   writer guard's scope keeps that policy pinned — and every other writer
///   waiting — until the repo itself is dropped.
#[cfg(test)]
pub(crate) mod test_support {
    use super::{global, SecuritySettings};
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};

    /// The reader/writer count behind the lock. A plain `RwLock` cannot be
    /// used: a writer has to be able to take over from a reader share its own
    /// thread already holds (a `TestRepo` built before `offline()`), and to
    /// hand it back afterwards.
    struct LockState {
        readers: usize,
        writer: bool,
    }

    static LOCK: Mutex<LockState> = Mutex::new(LockState {
        readers: 0,
        writer: false,
    });
    static CHANGED: Condvar = Condvar::new();

    /// A test that panicked while holding the lock poisoned it; the counts are
    /// maintained by RAII so they are still right, and the poison carries no
    /// information here.
    fn lock_state() -> MutexGuard<'static, LockState> {
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// One share of the reader count, co-owned by every reader guard taken on
    /// a thread while it is alive. Released when the last co-owner drops,
    /// whichever thread that happens on.
    struct ReaderShare {
        /// Set while a writer on the same thread has borrowed the share's
        /// count; the drop then leaves the count alone, and the writer
        /// notices the share is gone and does not hand it back.
        suspended: AtomicBool,
    }

    impl Drop for ReaderShare {
        fn drop(&mut self) {
            let mut state = lock_state();
            if !self.suspended.load(Ordering::SeqCst) {
                state.readers -= 1;
                CHANGED.notify_all();
            }
        }
    }

    /// The writer's hold on the lock, with what it has to put back.
    struct WriterHold {
        /// What the previous policy was: the default for an outermost writer,
        /// the outer writer's settings for a nested one.
        previous: SecuritySettings,
        /// An inner writer keeps its outer alive and never touches the lock.
        outer: Option<Arc<WriterHold>>,
        /// The reader share this thread held when the writer took over.
        suspended_reader: Option<Weak<ReaderShare>>,
    }

    impl Drop for WriterHold {
        fn drop(&mut self) {
            let mut state = lock_state();
            global().set(self.previous.clone());
            if self.outer.is_some() {
                return;
            }
            state.writer = false;
            if let Some(share) = self.suspended_reader.as_ref().and_then(Weak::upgrade) {
                share.suspended.store(false, Ordering::SeqCst);
                state.readers += 1;
            }
            CHANGED.notify_all();
        }
    }

    thread_local! {
        /// The live reader share of this thread, if any.
        static READER: RefCell<Weak<ReaderShare>> = const { RefCell::new(Weak::new()) };
        /// The outermost live writer of this thread, if any.
        static WRITER: RefCell<Weak<WriterHold>> = const { RefCell::new(Weak::new()) };
    }

    enum Hold {
        Reader(#[allow(dead_code)] Arc<ReaderShare>),
        /// A reader taken while this thread's writer is in force: it keeps
        /// the writer's policy pinned rather than replacing it, because the
        /// writer test is the one that asked for it.
        UnderWriter(#[allow(dead_code)] Arc<WriterHold>),
        Writer(#[allow(dead_code)] Arc<WriterHold>),
    }

    /// Holds the policy lock for the lifetime of the value. `Send`, so a
    /// `TestRepo` can be moved into a task; the lock is released wherever the
    /// last holder drops.
    pub(crate) struct GlobalSettingsGuard {
        _hold: Hold,
    }

    /// Pin the permissive default — no offline mode, no allowlist — for the
    /// lifetime of the guard, and take a turn against every test that switches
    /// a policy on.
    ///
    /// Every `TestRepo` holds one; a test that reaches a guarded command
    /// without a repository takes its own.
    pub(crate) fn no_policy() -> GlobalSettingsGuard {
        if let Some(writer) = WRITER.with(|w| w.borrow().upgrade()) {
            return GlobalSettingsGuard {
                _hold: Hold::UnderWriter(writer),
            };
        }
        if let Some(share) = READER.with(|r| r.borrow().upgrade()) {
            return GlobalSettingsGuard {
                _hold: Hold::Reader(share),
            };
        }
        let mut state = lock_state();
        while state.writer {
            state = CHANGED.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        state.readers += 1;
        drop(state);
        // Every writer restores the default on drop; this only makes the
        // pinned state explicit rather than inherited.
        global().set(SecuritySettings::default());
        let share = Arc::new(ReaderShare {
            suspended: AtomicBool::new(false),
        });
        READER.with(|r| *r.borrow_mut() = Arc::downgrade(&share));
        GlobalSettingsGuard {
            _hold: Hold::Reader(share),
        }
    }

    /// Put the process into offline mode for the lifetime of the guard.
    pub(crate) fn offline() -> GlobalSettingsGuard {
        with(SecuritySettings {
            offline_mode: true,
            remote_allowlist: Vec::new(),
        })
    }

    /// Apply an allowlist for the lifetime of the guard.
    pub(crate) fn allowlist(entries: &[&str]) -> GlobalSettingsGuard {
        with(SecuritySettings {
            offline_mode: false,
            remote_allowlist: entries.iter().map(|s| s.to_string()).collect(),
        })
    }

    /// Apply `settings` for the lifetime of the guard, excluding every other
    /// reader and writer. Dropping it restores what it replaced.
    pub(crate) fn with(settings: SecuritySettings) -> GlobalSettingsGuard {
        if let Some(outer) = WRITER.with(|w| w.borrow().upgrade()) {
            let previous = global().snapshot();
            global().set(settings);
            return GlobalSettingsGuard {
                _hold: Hold::Writer(Arc::new(WriterHold {
                    previous,
                    outer: Some(outer),
                    suspended_reader: None,
                })),
            };
        }

        let mut state = lock_state();
        // A reader share this thread already holds would wait for itself.
        // Borrow its count for the duration of the writer instead.
        let own_reader = READER.with(|r| r.borrow().upgrade());
        if let Some(share) = &own_reader {
            share.suspended.store(true, Ordering::SeqCst);
            state.readers -= 1;
        }
        while state.writer || state.readers > 0 {
            state = CHANGED.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        state.writer = true;
        global().set(settings);
        drop(state);

        let hold = Arc::new(WriterHold {
            previous: SecuritySettings::default(),
            outer: None,
            suspended_reader: own_reader.as_ref().map(Arc::downgrade),
        });
        WRITER.with(|w| *w.borrow_mut() = Arc::downgrade(&hold));
        GlobalSettingsGuard {
            _hold: Hold::Writer(hold),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(offline: bool, allowlist: &[&str]) -> SecuritySettings {
        SecuritySettings {
            offline_mode: offline,
            remote_allowlist: allowlist.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn blocked(result: Result<()>) -> String {
        match result {
            Err(GitnadoError::NetworkBlocked(message)) => message,
            other => panic!("expected a NetworkBlocked refusal, got {:?}", other.err()),
        }
    }

    // ---- host extraction ----

    #[test]
    fn https_url_yields_its_host() {
        assert_eq!(
            url_host("https://github.com/o/r.git").as_deref(),
            Some("github.com")
        );
    }

    #[test]
    fn ssh_url_yields_its_host_without_the_user() {
        assert_eq!(
            url_host("ssh://git@gitlab.example.test:22/o/r.git").as_deref(),
            Some("gitlab.example.test")
        );
    }

    #[test]
    fn scp_like_url_yields_its_host() {
        assert_eq!(
            url_host("git@github.com:owner/repo.git").as_deref(),
            Some("github.com")
        );
    }

    /// A self-hosted box with no DNS is reached by literal address, and git
    /// accepts the bracketed IPv6 scp form. This half has always read it whole;
    /// the frontend's `[^:\/]+` stopped at the first colon inside the literal
    /// and read `[2001`, so the gate the user could see (Settings > Security)
    /// listed a host its own frontend could never match. Both halves read the
    /// same host now, with and without a port.
    #[test]
    fn a_bracketed_ipv6_scp_remote_yields_the_whole_literal() {
        assert_eq!(
            url_host("git@[2001:db8::1]:team/app.git").as_deref(),
            Some("[2001:db8::1]")
        );
        // No path: no colon after the closing bracket, so this falls through to
        // the `https://` fallback — and lands on the same host. The frontend's
        // `?? cloneUrlHost('https://' + url)` is that same fallback.
        assert_eq!(
            target_host("git@[2001:db8::1]").as_deref(),
            Some("[2001:db8::1]")
        );
        assert_eq!(
            url_host("ssh://git@[2001:db8::1]:2222/team/app.git").as_deref(),
            Some("[2001:db8::1]")
        );
        assert_eq!(
            parse_target("ssh://git@[2001:db8::1]:2222/team/app.git")
                .map(|t| (t.host, t.port, t.is_ssh)),
            Some(("[2001:db8::1]".to_string(), Some(2222), true))
        );
    }

    /// ...and the allowlist entry the user writes for it works. `[2001:db8::1]`
    /// is the form both halves normalise to; a bare `2001:db8::1` is not a
    /// parseable authority on EITHER side, so both refuse it alike rather than
    /// one allowing what the other blocks.
    #[test]
    fn a_bracketed_ipv6_allowlist_entry_matches_that_remote() {
        assert!(check(
            &settings(false, &["[2001:db8::1]"]),
            Some("git@[2001:db8::1]:team/app.git")
        )
        .is_ok());
        assert!(check(
            &settings(false, &["[2001:db8::1]"]),
            Some("ssh://git@[2001:db8::1]:2222/team/app.git")
        )
        .is_ok());
        // A different address is a different host.
        assert!(check(
            &settings(false, &["[2001:db8::1]"]),
            Some("git@[2001:db8::2]:team/app.git")
        )
        .is_err());
    }

    /// git's scp-like form is `[user@]host:path`, and the LOGIN IS OPTIONAL:
    /// `gitserver:team/app.git` is an ssh remote on `gitserver`, and it is the
    /// spelling an `~/.ssh/config` `Host` alias leaves behind — very common on
    /// a corporate host. Requiring the `@` resolved it to no host at all, so
    /// the allowlist branch was never even reached.
    #[test]
    fn an_scp_remote_that_names_no_login_still_yields_its_host() {
        assert_eq!(
            url_host("gitserver:team/app.git").as_deref(),
            Some("gitserver")
        );
        assert_eq!(
            parse_target("gitserver:team/app.git").map(|t| (t.user, t.host, t.port, t.is_ssh)),
            Some((None, "gitserver".to_string(), None, true)),
            "no login is not the login `git`: ssh reads that from its own config"
        );
    }

    /// ...so an allowlist entry naming that host permits it, and one that does
    /// not refuses it BY NAME. Neither could happen before: `target_host`
    /// yielded nothing, and the gate said "Could not determine the remote URL,
    /// and an allowlist is configured" — a refusal no entry could work around.
    #[test]
    fn an_allowlist_entry_permits_an_scp_remote_that_names_no_login() {
        assert!(check(
            &settings(false, &["gitserver"]),
            Some("gitserver:team/app.git")
        )
        .is_ok());
        let message = blocked(check(
            &settings(false, &["elsewhere.test"]),
            Some("gitserver:team/app.git"),
        ));
        assert!(message.contains("is not in your allowlist"), "{message}");
        assert!(message.contains("gitserver"), "{message}");
    }

    /// ...and it is still a remote that LEAVES the machine, so offline mode
    /// goes on refusing it. Widening the scp form necessarily narrows what
    /// counts as a path, and this is the direction that must not move.
    #[test]
    fn an_scp_remote_that_names_no_login_is_not_a_path() {
        assert!(!is_local_target("gitserver:team/app.git"));
        let message = blocked(check(&settings(true, &[]), Some("gitserver:team/app.git")));
        assert!(message.contains("Offline mode"), "{message}");
    }

    /// The `@` AFTER the separating colon belongs to the PATH.
    ///
    /// git reads `gitserver:x@evil.test:y` as the path `x@evil.test:y` on
    /// `gitserver` — the colon comes first — so the login has to be looked for
    /// ahead of that colon. Taking the first `@` in the whole string judged
    /// (and, through `parse_target`, would have contacted) `evil.test`: the
    /// login-less spelling of the smuggling case `git@github.com:x@evil.test:y`
    /// is already pinned for.
    #[test]
    fn the_login_is_read_from_ahead_of_the_separating_colon() {
        let url = "gitserver:x@evil.test:y";
        assert_eq!(url_host(url).as_deref(), Some("gitserver"));
        assert_eq!(
            parse_target(url).map(|t| (t.user, t.host)),
            Some((None, "gitserver".to_string()))
        );
        assert!(check(&settings(false, &["gitserver"]), Some(url)).is_ok());
        assert!(check(&settings(false, &["evil.test"]), Some(url)).is_err());
    }

    /// `host:port` is the one scheme-less form whose colon is a PORT — the SSH
    /// settings dialog's host field accepts it, and `resolve_ssh_target` reads
    /// the port straight off this parse for `ssh -p`. Letting the widened scp
    /// branch swallow it would have dropped the port silently, and probed :22
    /// of a server that does not listen there.
    #[test]
    fn a_bare_host_and_port_keeps_its_port() {
        assert_eq!(
            parse_target("git.example.test:2222").map(|t| (t.host, t.port, t.is_ssh)),
            Some(("git.example.test".to_string(), Some(2222), false))
        );
        // The HOST is the same either way, so the allowlist reads it alike.
        assert_eq!(
            target_host("git.example.test:2222").as_deref(),
            Some("git.example.test")
        );
        assert!(check(
            &settings(false, &["git.example.test"]),
            Some("git.example.test:2222")
        )
        .is_ok());
        // A login says it is not that form: `git@host:2222` is the repository
        // `2222`, which is how git reads it and how this half always has.
        assert_eq!(
            parse_target("git@git.example.test:2222").map(|t| (t.host, t.port, t.is_ssh)),
            Some(("git.example.test".to_string(), None, true))
        );
    }

    /// The whole differential of reading the login as optional, pinned.
    ///
    /// [`is_local_target`] excludes everything [`scp_like_host`] recognises, so
    /// widening the scp form necessarily narrows what counts as a filesystem
    /// path and as a Windows drive. Every row is one verdict from each of the
    /// three, and the frontend mirror (`scpLikeHost` in
    /// `src/services/git.service.ts`) answers the same for all of them.
    #[test]
    fn widening_the_scp_form_leaves_paths_and_drives_alone() {
        for (target, local, scp, parsed) in [
            // The finding, and its neighbours that already worked.
            (
                "gitserver:team/app.git",
                false,
                Some("gitserver"),
                Some(("gitserver", None, true)),
            ),
            (
                "server.example.com:repo.git",
                false,
                Some("server.example.com"),
                Some(("server.example.com", None, true)),
            ),
            (
                "git@host:x",
                false,
                Some("host"),
                Some(("host", None, true)),
            ),
            (
                "deploy@host:x",
                false,
                Some("host"),
                Some(("host", None, true)),
            ),
            (
                "~deploy@host:x",
                false,
                Some("host"),
                Some(("host", None, true)),
            ),
            (
                "git@github.com:x@evil.test:y",
                false,
                Some("github.com"),
                Some(("github.com", None, true)),
            ),
            (
                "gitserver:x@evil.test:y",
                false,
                Some("gitserver"),
                Some(("gitserver", None, true)),
            ),
            // Bracketed IPv6, with and without a login.
            ("[::1]:x", false, Some("[::1]"), Some(("[::1]", None, true))),
            (
                "git@[::1]:x",
                false,
                Some("[::1]"),
                Some(("[::1]", None, true)),
            ),
            // Windows drives: a one-letter authority with no login is a drive,
            // not a host — and `x:22` is a host, because a port is not a path.
            (r"C:\repos\x.git", true, None, Some(("c", None, false))),
            ("C:/repos/x.git", true, None, Some(("c", None, false))),
            ("c:x", false, None, None),
            ("x:22", false, None, Some(("x", Some(22), false))),
            (
                "host:22",
                false,
                Some("host"),
                Some(("host", Some(22), false)),
            ),
            // Paths, in every spelling `is_local_target` accepts. A colon
            // inside one of these is inside the PATH.
            ("/srv/git/x.git", true, None, Some(("srv", None, false))),
            ("./x.git", true, None, Some((".", None, false))),
            ("../x.git", true, None, Some(("..", None, false))),
            ("~/x.git", true, None, Some(("~", None, false))),
            (".", true, None, Some((".", None, false))),
            ("..", true, None, Some(("..", None, false))),
            (r".\x:y", true, None, Some((".", None, false))),
            (
                "mybackup.git",
                false,
                None,
                Some(("mybackup.git", None, false)),
            ),
            // UNC is not a path to this gate: SMB leaves the machine.
            (
                r"\\server\share\x",
                false,
                None,
                Some(("server", None, false)),
            ),
            (
                "//server/share/x",
                false,
                None,
                Some(("server", None, false)),
            ),
            // Anything carrying a scheme is the URL parser's business.
            ("file:///x", true, None, None),
            ("file://localhost/x", true, None, None),
            (
                "file://server/share/x",
                false,
                None,
                Some(("server", None, false)),
            ),
            ("https://h/x", false, None, Some(("h", None, false))),
            ("ssh://h/x", false, None, Some(("h", None, true))),
            // Neither half is a form git accepts.
            ("@host:x", false, None, None),
            ("x@:y", false, None, None),
        ] {
            assert_eq!(is_local_target(target), local, "{target}: is_local_target");
            assert_eq!(
                scp_like_host(target).as_deref(),
                scp,
                "{target}: scp_like_host"
            );
            assert_eq!(
                parse_target(target).map(|t| (t.host, t.port, t.is_ssh)),
                parsed.map(|(host, port, is_ssh)| (host.to_string(), port, is_ssh)),
                "{target}: parse_target"
            );
        }
    }

    /// EVERY target shape, through EVERY parse that survives.
    ///
    /// This area produced a finding in eight consecutive review rounds, each
    /// time for a spelling the previous fix's list did not include — a bare
    /// relative remote, a login-less scp remote, a bracketed IPv6 literal, an
    /// `@` inside a path, a repository whose name parses as a port. The cause
    /// was never one bad rule; it was several rules answering "what kind of
    /// target is this string" independently, so a fix to one left the others
    /// behind. This table is the countermeasure: one row per shape, one column
    /// per parse, so a change that moves any of them has to say here what it
    /// did to all the rest.
    ///
    /// Two parses answering the SAME question differently on any row is a bug.
    /// Where two answers differ on purpose the row carries the reason, and
    /// there are exactly three such places:
    ///
    /// - [`is_local_target`] vs [`is_local_remote_target`], which differ only
    ///   for a bare relative path, because only a caller holding a git remote
    ///   can know that `sub/x.git` is a path and not `host/path`;
    /// - [`parse_target`] vs [`parse_remote_target`], which differ only for a
    ///   login-less `host:<u16>`, because only the SSH settings host field has
    ///   a `host:port` form at all. The HOST never differs, so the gate cannot;
    /// - [`url_host`] vs [`target_host`], which differ only where a string
    ///   names no host: `url_host` declines, `target_host` applies the
    ///   bare-authority fallback [`check`] needs. Every row where `url_host`
    ///   answers at all, `target_host` answers the same.
    ///
    /// The frontend mirrors — `isLocalTarget`, `isLocalRemoteTarget`,
    /// `scpLikeHost`, `cloneUrlHost` and `looksLikeUrl` in
    /// `src/services/git.service.ts` — are pinned to the same rows by
    /// `src/services/__tests__/target-parse-differential.test.ts`.
    #[test]
    fn every_target_shape_through_every_parse() {
        // target, is_local_target, is_local_remote_target, scp_like_host,
        // parse_target, parse_remote_target, url_host, target_host,
        // looks_like_url.
        #[allow(clippy::type_complexity)]
        let rows: &[(
            &str,
            bool,
            bool,
            Option<&str>,
            Option<(&str, Option<u16>, bool)>,
            Option<(&str, Option<u16>, bool)>,
            Option<&str>,
            Option<&str>,
            bool,
        )] = &[
            // absolute path
            (
                "/srv/git/x.git",
                true,
                true,
                None,
                Some(("srv", None, false)),
                Some(("srv", None, false)),
                None,
                Some("srv"),
                false,
            ),
            (
                "./x.git",
                true,
                true,
                None,
                Some((".", None, false)),
                Some((".", None, false)),
                None,
                Some("."),
                false,
            ),
            (
                "../x.git",
                true,
                true,
                None,
                Some(("..", None, false)),
                Some(("..", None, false)),
                None,
                Some(".."),
                false,
            ),
            // `git remote add local .`
            (
                ".",
                true,
                true,
                None,
                Some((".", None, false)),
                Some((".", None, false)),
                None,
                Some("."),
                false,
            ),
            (
                "..",
                true,
                true,
                None,
                Some(("..", None, false)),
                Some(("..", None, false)),
                None,
                Some(".."),
                false,
            ),
            // a colon INSIDE a path
            (
                ".\\x:y",
                true,
                true,
                None,
                Some((".", None, false)),
                Some((".", None, false)),
                None,
                Some("."),
                false,
            ),
            (
                "~/x.git",
                true,
                true,
                None,
                Some(("~", None, false)),
                Some(("~", None, false)),
                None,
                Some("~"),
                false,
            ),
            // no separator: indistinguishable from a bare host, so NOT local even for a
            // remote. `./mybackup.git` is the spelling that says otherwise.
            (
                "mybackup.git",
                false,
                false,
                None,
                Some(("mybackup.git", None, false)),
                Some(("mybackup.git", None, false)),
                None,
                Some("mybackup.git"),
                false,
            ),
            // the bare relative remote: local as a REMOTE, not as a bare host
            (
                "sub/mybackup.git",
                false,
                true,
                None,
                Some(("sub", None, false)),
                Some(("sub", None, false)),
                None,
                Some("sub"),
                false,
            ),
            (
                "sub\\mybackup.git",
                false,
                true,
                None,
                Some(("sub", None, false)),
                Some(("sub", None, false)),
                None,
                Some("sub"),
                false,
            ),
            // a scheme-less provider instance URL has the same SHAPE as the row above,
            // which is why the widened rule is asked for by the caller and never
            // applied to a bare host or an endpoint.
            (
                "gitlab.example.com/gitlab",
                false,
                true,
                None,
                Some(("gitlab.example.com", None, false)),
                Some(("gitlab.example.com", None, false)),
                None,
                Some("gitlab.example.com"),
                false,
            ),
            // Windows drive
            (
                "C:\\repos\\x.git",
                true,
                true,
                None,
                Some(("c", None, false)),
                Some(("c", None, false)),
                None,
                Some("c"),
                false,
            ),
            (
                "C:/repos/x.git",
                true,
                true,
                None,
                Some(("c", None, false)),
                Some(("c", None, false)),
                None,
                Some("c"),
                false,
            ),
            // a one-letter authority with no login is a drive, and `x` is no path
            ("c:x", false, false, None, None, None, None, None, false),
            // UNC is SMB
            (
                "\\\\server\\share\\x",
                false,
                false,
                None,
                Some(("server", None, false)),
                Some(("server", None, false)),
                None,
                Some("server"),
                false,
            ),
            (
                "//server/share/x",
                false,
                false,
                None,
                Some(("server", None, false)),
                Some(("server", None, false)),
                None,
                Some("server"),
                false,
            ),
            // scp, with a login
            (
                "git@host:x",
                false,
                false,
                Some("host"),
                Some(("host", None, true)),
                Some(("host", None, true)),
                Some("host"),
                Some("host"),
                true,
            ),
            (
                "deploy@host:x",
                false,
                false,
                Some("host"),
                Some(("host", None, true)),
                Some(("host", None, true)),
                Some("host"),
                Some("host"),
                true,
            ),
            // a `~` does not make an scp remote a path
            (
                "~deploy@host:x",
                false,
                false,
                Some("host"),
                Some(("host", None, true)),
                Some(("host", None, true)),
                Some("host"),
                Some("host"),
                true,
            ),
            // scp with the login left to ~/.ssh/config
            (
                "gitserver:team/app.git",
                false,
                false,
                Some("gitserver"),
                Some(("gitserver", None, true)),
                Some(("gitserver", None, true)),
                Some("gitserver"),
                Some("gitserver"),
                true,
            ),
            // THE one shape the two parses answer differently, on purpose: the SSH
            // settings host field means port 2024, a git remote means the repository
            // `2024`. The HOST — all the gate reads — is the same either way.
            (
                "gitserver:2024",
                false,
                false,
                Some("gitserver"),
                Some(("gitserver", Some(2024), false)),
                Some(("gitserver", None, true)),
                Some("gitserver"),
                Some("gitserver"),
                true,
            ),
            (
                "host:22",
                false,
                false,
                Some("host"),
                Some(("host", Some(22), false)),
                Some(("host", None, true)),
                Some("host"),
                Some("host"),
                true,
            ),
            // a login says it is not the host:port form
            (
                "git@host:2222",
                false,
                false,
                Some("host"),
                Some(("host", None, true)),
                Some(("host", None, true)),
                Some("host"),
                Some("host"),
                true,
            ),
            // the drive carve-out puts this past `split_scp_like` and into the shared
            // bare-authority fallback, so the remote reading cannot tell it from a
            // port either. Not a remote anyone writes, and the dialog prints it as
            // typed; pinned so a future change to the carve-out is noticed here.
            (
                "x:22",
                false,
                false,
                None,
                Some(("x", Some(22), false)),
                Some(("x", Some(22), false)),
                None,
                Some("x"),
                false,
            ),
            // bracketed IPv6
            (
                "[::1]:x",
                false,
                false,
                Some("[::1]"),
                Some(("[::1]", None, true)),
                Some(("[::1]", None, true)),
                Some("[::1]"),
                Some("[::1]"),
                true,
            ),
            (
                "git@[::1]:x",
                false,
                false,
                Some("[::1]"),
                Some(("[::1]", None, true)),
                Some(("[::1]", None, true)),
                Some("[::1]"),
                Some("[::1]"),
                true,
            ),
            (
                "[::1]:22",
                false,
                false,
                Some("[::1]"),
                Some(("[::1]", Some(22), false)),
                Some(("[::1]", None, true)),
                Some("[::1]"),
                Some("[::1]"),
                true,
            ),
            // the `@` is in the PATH — every parse must say `gitserver`
            (
                "gitserver:x@evil.test:y",
                false,
                false,
                Some("gitserver"),
                Some(("gitserver", None, true)),
                Some(("gitserver", None, true)),
                Some("gitserver"),
                Some("gitserver"),
                true,
            ),
            (
                "git@github.com:x@evil.test:y",
                false,
                false,
                Some("github.com"),
                Some(("github.com", None, true)),
                Some(("github.com", None, true)),
                Some("github.com"),
                Some("github.com"),
                true,
            ),
            // schemes
            (
                "https://h/x",
                false,
                false,
                None,
                Some(("h", None, false)),
                Some(("h", None, false)),
                Some("h"),
                Some("h"),
                true,
            ),
            (
                "http://h:8443/x",
                false,
                false,
                None,
                Some(("h", Some(8443), false)),
                Some(("h", Some(8443), false)),
                Some("h"),
                Some("h"),
                true,
            ),
            (
                "git://h/x",
                false,
                false,
                None,
                Some(("h", None, false)),
                Some(("h", None, false)),
                Some("h"),
                Some("h"),
                true,
            ),
            (
                "ssh://h/x",
                false,
                false,
                None,
                Some(("h", None, true)),
                Some(("h", None, true)),
                Some("h"),
                Some("h"),
                true,
            ),
            (
                "ssh://git@h:2222/x",
                false,
                false,
                None,
                Some(("h", Some(2222), true)),
                Some(("h", Some(2222), true)),
                Some("h"),
                Some("h"),
                true,
            ),
            // host-less file:// is this machine
            ("file:///x", true, true, None, None, None, None, None, true),
            (
                "file://localhost/x",
                true,
                true,
                None,
                None,
                None,
                None,
                None,
                true,
            ),
            // …another machine is not
            (
                "file://server/share/x",
                false,
                false,
                None,
                Some(("server", None, false)),
                Some(("server", None, false)),
                Some("server"),
                Some("server"),
                true,
            ),
            // bare hosts, which is why the separator rule cannot be unconditional
            (
                "api.github.com",
                false,
                false,
                None,
                Some(("api.github.com", None, false)),
                Some(("api.github.com", None, false)),
                None,
                Some("api.github.com"),
                false,
            ),
            (
                "git@github.com",
                false,
                false,
                None,
                Some(("github.com", None, true)),
                Some(("github.com", None, true)),
                None,
                Some("github.com"),
                false,
            ),
            // the host is after the `@`, not before it
            (
                "github.com@evil.test",
                false,
                false,
                None,
                Some(("evil.test", None, true)),
                Some(("evil.test", None, true)),
                None,
                Some("evil.test"),
                false,
            ),
            // forms git does not accept
            ("@host:x", false, false, None, None, None, None, None, false),
            ("x@:y", false, false, None, None, None, None, None, false),
            ("ssh://", false, false, None, None, None, None, None, true),
            ("", false, false, None, None, None, None, None, false),
        ];

        let owned = |v: Option<(&str, Option<u16>, bool)>| {
            v.map(|(host, port, is_ssh)| (host.to_string(), port, is_ssh))
        };
        for &(target, local, local_remote, scp, parsed, parsed_remote, uh, th, lu) in rows {
            assert_eq!(is_local_target(target), local, "{target}: is_local_target");
            assert_eq!(
                is_local_remote_target(target),
                local_remote,
                "{target}: is_local_remote_target"
            );
            assert_eq!(
                scp_like_host(target).as_deref(),
                scp,
                "{target}: scp_like_host"
            );
            assert_eq!(
                parse_target(target).map(|t| (t.host, t.port, t.is_ssh)),
                owned(parsed),
                "{target}: parse_target"
            );
            assert_eq!(
                parse_remote_target(target).map(|t| (t.host, t.port, t.is_ssh)),
                owned(parsed_remote),
                "{target}: parse_remote_target"
            );
            assert_eq!(url_host(target).as_deref(), uh, "{target}: url_host");
            assert_eq!(target_host(target).as_deref(), th, "{target}: target_host");
            assert_eq!(looks_like_url(target), lu, "{target}: looks_like_url");
            // `url_host` and `target_host` are allowed to differ only by the
            // bare-authority fallback: where the first answers, the second must
            // answer the same.
            if let Some(host) = url_host(target) {
                assert_eq!(
                    target_host(target),
                    Some(host),
                    "{target}: url_host and target_host disagree"
                );
            }
            // The two local rules may differ only in the widening direction.
            assert!(
                !local || local_remote,
                "{target}: is_local_remote_target must never narrow is_local_target"
            );
            // The two parses may differ in port/scheme/is_ssh, never in HOST —
            // that is what keeps the gate single-parse.
            assert_eq!(
                parse_target(target).map(|t| t.host),
                parse_remote_target(target).map(|t| t.host),
                "{target}: the two parses disagree about the HOST"
            );
        }
    }

    #[test]
    fn scp_like_host_is_lowercased() {
        assert_eq!(
            url_host("Git@GitHub.COM:owner/repo.git").as_deref(),
            Some("github.com")
        );
    }

    #[test]
    fn a_bare_path_has_no_host() {
        assert_eq!(url_host("/srv/repos/local.git"), None);
        assert_eq!(url_host("../sibling.git"), None);
    }

    // ---- allowlist matching ----

    #[test]
    fn an_empty_allowlist_allows_everything() {
        assert!(check(&settings(false, &[]), Some("https://anywhere.test/x.git")).is_ok());
        // Including a target the caller could not resolve.
        assert!(check(&settings(false, &[]), None).is_ok());
    }

    #[test]
    fn an_exact_host_is_allowed() {
        assert!(check(
            &settings(false, &["github.com"]),
            Some("https://github.com/o/r.git")
        )
        .is_ok());
    }

    #[test]
    fn a_subdomain_of_an_allowed_domain_is_allowed() {
        assert!(check(
            &settings(false, &["example.test"]),
            Some("https://git.eu.example.test/o/r.git")
        )
        .is_ok());
    }

    #[test]
    fn a_leading_wildcard_entry_means_the_same_thing() {
        assert!(check(
            &settings(false, &["*.example.test"]),
            Some("https://git.example.test/o/r.git")
        )
        .is_ok());
        assert!(check(
            &settings(false, &["*.example.test"]),
            Some("https://example.test/o/r.git")
        )
        .is_ok());
    }

    #[test]
    fn a_look_alike_host_is_refused() {
        let message = blocked(check(
            &settings(false, &["github.com"]),
            Some("https://github.com.evil.test/o/r.git"),
        ));
        assert!(message.contains("not in your allowlist"), "{message}");
    }

    #[test]
    fn a_domain_named_only_in_the_path_is_refused() {
        assert!(check(
            &settings(false, &["github.com"]),
            Some("https://evil.test/github.com/o/r.git")
        )
        .is_err());
    }

    #[test]
    fn a_scp_like_url_is_matched_on_its_host() {
        assert!(check(
            &settings(false, &["github.com"]),
            Some("git@github.com:o/r.git")
        )
        .is_ok());
        assert!(check(
            &settings(false, &["github.com"]),
            Some("git@github.com.evil.test:o/r.git")
        )
        .is_err());
    }

    #[test]
    fn a_bare_host_target_is_matched() {
        // The SSH connection test hands over `git@github.com` with no path, and
        // the provider guards hand over a bare API host.
        assert!(check(&settings(false, &["github.com"]), Some("git@github.com")).is_ok());
        assert!(check(&settings(false, &["github.com"]), Some("github.com")).is_ok());
    }

    #[test]
    fn an_allowlist_entry_may_itself_be_a_url() {
        assert!(check(
            &settings(false, &["https://gitlab.example.test/"]),
            Some("https://gitlab.example.test/o/r.git")
        )
        .is_ok());
    }

    /// Two refusals that used to be pinned as one. This asserted only
    /// `is_err()` on `/srv/repos/local.git` under the label "unresolvable" —
    /// but that target resolved perfectly well (to the host `srv`) and was
    /// refused by the allowlist branch instead, which `is_err()` cannot tell
    /// apart. It is a filesystem path, and it is permitted now; the two
    /// refusals are pinned separately, on their messages.
    #[test]
    fn an_unresolvable_target_is_refused_when_an_allowlist_exists() {
        let message = blocked(check(&settings(false, &["github.com"]), None));
        assert!(message.contains("Could not determine"), "{message}");
        // No authority at all: nothing to match an allowlist entry against.
        let message = blocked(check(&settings(false, &["github.com"]), Some("https://")));
        assert!(message.contains("Could not determine"), "{message}");
    }

    #[test]
    fn a_host_missing_from_the_allowlist_is_refused_by_name() {
        let message = blocked(check(
            &settings(false, &["github.com"]),
            Some("https://gitlab.example.test/o/r.git"),
        ));
        assert!(message.contains("is not in your allowlist"), "{message}");
        assert!(message.contains("gitlab.example.test"), "{message}");
    }

    /// The exclusions from [`is_local_target`]: every one of these can reach
    /// another machine, so none of them may take the carve-out.
    #[test]
    fn a_target_that_can_leave_the_machine_is_not_local() {
        for target in [
            // UNC — SMB, in both spellings.
            r"\\server\share\repo.git",
            "//server/share/repo.git",
            // a `file://` URL whose host is another machine
            "file://server/share/repo.git",
            // the loopback carve-out needs a real `.localhost` suffix
            "file://localhost.evil.test/share/repo.git",
            // git reads this as an ssh remote on `host`, not as a `~` path
            "~user@host:repo.git",
            // ordinary remotes
            "https://github.com/o/r.git",
            "ssh://git@github.com/o/r.git",
            "git@github.com:o/r.git",
            "github.com",
            // a path with a URL embedded in it
            "/srv/repos/https://evil.test",
            "",
        ] {
            assert!(!is_local_target(target), "{target} is not on this machine");
        }

        for target in [
            "/mnt/usb/repo.git",
            "./sub/repo.git",
            "../sibling/repo.git",
            "~/backups/app.git",
            r"C:\repos\app.git",
            "C:/repos/app.git",
            // `.` and `..` are the separator-less spelling of `./` and `../`.
            ".",
            "..",
            "file:///srv/git/app.git",
            "file://localhost/srv/git/app.git",
            // ...and every other loopback host, which is this machine too. The
            // frontend mirror accepted only the two above, so it toasted
            // "Offline mode is enabled" for a target this gate had already
            // decided never leaves the machine — with no allowlist entry able
            // to work around it under offline mode.
            "file://127.0.0.1/srv/git/app.git",
            "file://127.1.2.3/srv/git/app.git",
            "file://[::1]/srv/git/app.git",
            "file://build.localhost/srv/git/app.git",
        ] {
            assert!(is_local_target(target), "{target} never leaves the machine");
        }
    }

    #[test]
    fn a_blank_allowlist_entry_matches_nothing() {
        assert!(check(
            &settings(false, &["  "]),
            Some("https://github.com/o/r.git")
        )
        .is_err());
    }

    // ---- offline mode ----

    #[test]
    fn offline_mode_refuses_everything_including_allowlisted_hosts() {
        let message = blocked(check(
            &settings(true, &["github.com"]),
            Some("https://github.com/o/r.git"),
        ));
        assert!(message.contains("Offline mode"), "{message}");
    }

    #[test]
    fn the_refusal_is_reported_with_the_blocked_code() {
        let response: crate::error::ErrorResponse =
            GitnadoError::NetworkBlocked("nope".to_string()).into();
        assert_eq!(response.code, "BLOCKED");
    }

    // ---- loopback / AI endpoints ----

    #[test]
    fn loopback_endpoints_are_never_blocked() {
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("[::1]"));
        assert!(!is_loopback_host("example.test"));
    }

    // ---- filesystem remotes ----

    #[test]
    fn offline_mode_permits_a_filesystem_remote() {
        assert!(check(&settings(true, &[]), Some("/mnt/usb/repo.git")).is_ok());
        assert!(check(&settings(true, &[]), Some("file:///srv/git/app.git")).is_ok());
        assert!(check(&settings(true, &[]), Some("~/backups/app.git")).is_ok());
        assert!(check(&settings(true, &[]), Some("C:\\repos\\app.git")).is_ok());
    }

    #[test]
    fn an_allowlist_permits_a_filesystem_remote() {
        assert!(check(&settings(false, &["github.com"]), Some("/mnt/usb/repo.git")).is_ok());
        assert!(check(
            &settings(false, &["github.com"]),
            Some("file:///srv/git/app.git")
        )
        .is_ok());
    }

    /// A BARE relative remote is a place on this machine, and a push to it
    /// opens no socket.
    ///
    /// `git init --bare sub/mybackup.git && git remote add b2 sub/mybackup.git`
    /// is an ordinary local backup remote, and git reads it as a path (no
    /// colon, so `url_is_local_not_ssh` says local). Offline mode refused the
    /// push anyway, and the allowlist read the host as `sub` — so the only
    /// workaround was to allowlist the literal string `sub`.
    ///
    /// The carve-out is asked for by the caller, because the same SHAPE is a
    /// scheme-less provider instance URL when the string is not a remote. The
    /// second half of each pair is what keeps that from failing open.
    #[test]
    fn offline_mode_permits_a_bare_relative_remote_but_not_a_bare_endpoint() {
        for remote in ["sub/mybackup.git", "backups/app.git", r"sub\mybackup.git"] {
            assert!(
                check_remote(&settings(true, &[]), Some(remote)).is_ok(),
                "{remote} never leaves the machine"
            );
            assert!(
                check_remote(&settings(false, &["github.com"]), Some(remote)).is_ok(),
                "{remote} is no host for an allowlist to judge"
            );
        }
        // ...and the same shape read as a host is still judged as one: a
        // scheme-less instance URL with a path segment must not be waved
        // through as "a place on this machine".
        assert!(check(&settings(true, &[]), Some("gitlab.example.com/gitlab")).is_err());
        assert!(check(
            &settings(false, &["github.com"]),
            Some("gitlab.example.com/gitlab")
        )
        .is_err());
        assert!(check(
            &settings(false, &["gitlab.example.com"]),
            Some("gitlab.example.com/gitlab")
        )
        .is_ok());
    }

    /// End to end, on a real repository: the remote git would push to.
    #[test]
    fn a_bare_relative_remote_is_permitted_while_offline_end_to_end() {
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        repo.add_remote("b2", "sub/mybackup.git");
        let _guard = test_support::offline();

        assert!(guard_remote(&repo.path_str(), Some("b2")).is_ok());
        assert!(guard_push_remote(&repo.path_str(), Some("b2")).is_ok());
        assert!(guard_remote_url("sub/mybackup.git").is_ok());
        // The endpoint-flavoured guard is unchanged, and still refuses.
        assert!(guard_url("sub/mybackup.git").is_err());
    }

    #[test]
    fn a_filesystem_remote_is_permitted_while_offline_end_to_end() {
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        repo.add_remote("backup", "/mnt/usb/repo.git");
        repo.add_remote("archive", "file:///srv/git/app.git");
        let _guard = test_support::offline();

        assert!(guard_remote(&repo.path_str(), Some("backup")).is_ok());
        assert!(guard_push_remote(&repo.path_str(), Some("backup")).is_ok());
        assert!(guard_remote(&repo.path_str(), Some("archive")).is_ok());
        assert!(guard_push_remote(&repo.path_str(), Some("archive")).is_ok());
    }

    #[test]
    fn a_filesystem_remote_is_permitted_by_an_allowlist_end_to_end() {
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        repo.add_remote("backup", "/mnt/usb/repo.git");
        let _guard = test_support::allowlist(&["github.com"]);

        assert!(guard_remote(&repo.path_str(), Some("backup")).is_ok());
        assert!(guard_push_remote(&repo.path_str(), Some("backup")).is_ok());
    }

    // ---- state syncing ----

    #[test]
    fn a_payload_updates_both_settings() {
        let state = SecurityState::default();
        let applied = state
            .apply_payload(r#"{"offlineMode":true,"remoteAllowlist":["github.com"]}"#)
            .expect("payload should be recognised");
        assert!(applied.offline_mode);
        assert_eq!(applied.remote_allowlist, vec!["github.com".to_string()]);
        assert_eq!(state.snapshot(), applied);
    }

    #[test]
    fn a_payload_omitting_a_field_leaves_it_alone() {
        let state = SecurityState::default();
        state.set(settings(true, &["github.com"]));
        state
            .apply_payload(r#"{"remoteAllowlist":["gitlab.com"]}"#)
            .expect("payload should be recognised");
        // Offline mode must not be turned off by a push that never mentioned it.
        assert!(state.snapshot().offline_mode);
        assert_eq!(
            state.snapshot().remote_allowlist,
            vec!["gitlab.com".to_string()]
        );
    }

    #[test]
    fn an_unrelated_payload_is_ignored() {
        let state = SecurityState::default();
        state.set(settings(true, &[]));
        assert!(state.apply_payload(r#"{"minimizeToTray":true}"#).is_none());
        assert!(state.apply_payload("not json").is_none());
        assert!(state.snapshot().offline_mode);
    }

    #[test]
    fn settings_survive_a_restart() {
        let dir = tempfile::TempDir::new().unwrap();
        let first = SecurityState::default();
        first.init(dir.path().to_path_buf());
        first
            .apply_payload(r#"{"offlineMode":true,"remoteAllowlist":["example.test"]}"#)
            .unwrap();

        // A fresh process reads what the last one was told.
        let second = SecurityState::default();
        second.init(dir.path().to_path_buf());
        assert!(second.snapshot().offline_mode);
        assert_eq!(
            second.snapshot().remote_allowlist,
            vec!["example.test".to_string()]
        );
    }

    #[test]
    fn a_push_that_changes_nothing_is_not_written_to_disk() {
        let dir = tempfile::TempDir::new().unwrap();
        let state = SecurityState::default();
        state.init(dir.path().to_path_buf());
        state.set(settings(true, &["github.com"]));

        let path = dir.path().join(SECURITY_FILE);
        assert!(path.exists(), "the first push is mirrored to disk");
        // Removing the mirror makes a rewrite unmistakable: if the identical
        // push below saves again, the file comes back.
        std::fs::remove_file(&path).unwrap();

        // The frontend re-emits the whole settings object on EVERY settings
        // write, so this is what a theme change or a keystroke elsewhere in
        // Settings looks like from here.
        state.set(settings(true, &["github.com"]));
        assert!(
            !path.exists(),
            "an identical push must not rewrite the mirror"
        );

        // A real change still is written.
        state.set(settings(false, &["github.com"]));
        assert!(path.exists(), "a changed setting is still mirrored");
        assert_eq!(state.snapshot(), settings(false, &["github.com"]));
    }

    #[test]
    fn a_mirror_write_that_failed_is_retried_by_the_next_identical_push() {
        // The no-op skip is keyed on memory AND on whether the file actually
        // holds it. Without the second half, one failed write — an unwritable
        // config dir, a full disk — was never retried for the rest of the
        // session, because every later push carried the same settings and
        // returned early. The next launch then ran its pre-mount window on a
        // stale mirror, and a stale `offlineMode: false` fails OPEN.
        let root = tempfile::TempDir::new().unwrap();
        let config_dir = root.path().join("config");
        // A FILE where the config directory belongs: `create_dir_all` fails,
        // so the mirror cannot be written.
        std::fs::write(&config_dir, "not a directory").unwrap();

        let state = SecurityState::default();
        state.init(config_dir.clone());
        state.set(settings(true, &["github.com"]));
        assert!(
            !config_dir.is_dir(),
            "the write really must have failed for this test to mean anything"
        );

        // The obstruction clears — and the very next push carries exactly the
        // same settings, which is what every unrelated Settings write looks
        // like from here.
        std::fs::remove_file(&config_dir).unwrap();
        state.set(settings(true, &["github.com"]));

        assert_eq!(
            load_from_disk(&config_dir),
            Some(settings(true, &["github.com"])),
            "an identical push must repair a mirror that was never written"
        );
    }

    #[test]
    fn a_repaired_mirror_then_goes_back_to_skipping_identical_pushes() {
        // The retry must not turn into "write on every push": that is the
        // behaviour the skip was added to stop.
        let dir = tempfile::TempDir::new().unwrap();
        let state = SecurityState::default();
        state.init(dir.path().to_path_buf());
        state.set(settings(true, &["github.com"]));

        let path = dir.path().join(SECURITY_FILE);
        assert!(path.exists());
        std::fs::remove_file(&path).unwrap();
        state.set(settings(true, &["github.com"]));
        assert!(
            !path.exists(),
            "a mirror this process wrote successfully is not rewritten by an identical push"
        );
    }

    #[test]
    fn concurrent_pushes_cannot_leave_the_mirror_disagreeing_with_memory() {
        // Tauri runs each JS `emit` on its own task, so two `apply_payload`
        // handlers really do race. Committing memory under the lock and the
        // file outside it let them land in opposite orders — memory ends on
        // one value, the file on the other — after which every later identical
        // push skipped and nothing ever repaired it.
        for round in 0..20 {
            let dir = tempfile::TempDir::new().unwrap();
            let state = SecurityState::default();
            state.init(dir.path().to_path_buf());

            let handles: Vec<_> = (0..8)
                .map(|worker| {
                    let state = state.clone();
                    std::thread::spawn(move || {
                        for i in 0..25 {
                            state.set(settings((worker + i) % 2 == 0, &["github.com"]));
                        }
                    })
                })
                .collect();
            for handle in handles {
                handle.join().unwrap();
            }

            assert_eq!(
                load_from_disk(dir.path()),
                Some(state.snapshot()),
                "round {}: the mirror must hold what memory holds",
                round
            );
        }
    }

    #[test]
    fn a_poisoned_lock_does_not_fail_open() {
        let state = SecurityState::default();
        state.set(settings(true, &["github.com"]));

        // Poison the lock the way a panic inside a critical section would.
        // The hook is silenced only for the duration of that deliberate panic
        // so a passing run does not print a backtrace that looks like a failure.
        let poisoner = state.clone();
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let _ = std::thread::spawn(move || {
            let _held = poisoner.inner.write().unwrap();
            panic!("poison the security lock");
        })
        .join();
        std::panic::set_hook(previous_hook);
        assert!(state.inner.read().is_err(), "the lock really is poisoned");

        // Failing open here would hand back the permissive default.
        let snapshot = state.snapshot();
        assert!(
            snapshot.offline_mode,
            "offline mode survives a poisoned lock"
        );
        assert_eq!(snapshot.remote_allowlist, vec!["github.com".to_string()]);
        assert_eq!(
            blocked(check(&snapshot, Some("https://github.com/o/r.git"))),
            "Offline mode is enabled. Disable in Settings > Security.",
            "the guard still refuses"
        );

        // And a write through the poisoned lock still lands.
        state.set(settings(false, &["example.test"]));
        assert_eq!(state.snapshot(), settings(false, &["example.test"]));
    }

    // ---- the guarded commands actually refuse ----
    //
    // A representative sample across the three families the gate covers: a git
    // remote operation, a hosting-provider API, and an AI request. Each one is
    // reached through the real command, so a guard that is deleted or moved
    // below the network call fails here.

    /// The refusal a guarded command returns, or a panic naming what it did
    /// instead. `Ok` is the failure that matters: it means the request went out.
    fn expect_blocked<T: std::fmt::Debug>(result: Result<T>, what: &str) {
        match result {
            Err(GitnadoError::NetworkBlocked(_)) => {}
            Ok(value) => panic!("{what} was allowed to run offline: {value:?}"),
            Err(other) => panic!("{what} failed for the wrong reason: {other}"),
        }
    }

    #[tokio::test]
    async fn offline_mode_refuses_remote_git_operations() {
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://github.com/me/app.git");
        // `update_submodules` is judged on the hosts it will actually contact,
        // not on the superproject — offline mode answering before anything was
        // listed is what refused an update of a submodule on a filesystem
        // path. So the repository needs a submodule that DOES leave the
        // machine for the refusal below to mean anything.
        repo.create_commit(
            "Add .gitmodules",
            &[(
                ".gitmodules",
                "[submodule \"vendor/dep\"]\n\tpath = vendor/dep\n\turl = https://github.com/x/dep.git\n",
            )],
        );
        let _guard = test_support::offline();

        expect_blocked(
            crate::commands::remote::deepen_repository(repo.path_str(), 10).await,
            "deepen_repository",
        );
        expect_blocked(
            crate::commands::remote::unshallow_repository(repo.path_str()).await,
            "unshallow_repository",
        );
        expect_blocked(
            crate::commands::lfs::lfs_pull(repo.path_str(), None).await,
            "lfs_pull",
        );
        expect_blocked(
            crate::commands::submodule::update_submodules(
                repo.path_str(),
                None,
                Some(true),
                None,
                None,
                None,
                None,
            )
            .await,
            "update_submodules",
        );
        expect_blocked(
            crate::commands::submodule::add_submodule(
                repo.path_str(),
                "https://github.com/me/dep.git".to_string(),
                "vendor/dep".to_string(),
                None,
            )
            .await,
            "add_submodule",
        );
        expect_blocked(
            crate::commands::maintenance::prune_remote_tracking_branches(
                repo.path_str(),
                vec!["origin".to_string()],
                None,
            )
            .await,
            "prune_remote_tracking_branches",
        );
        expect_blocked(
            crate::commands::tags::push_tag(
                repo.path_str(),
                "v1".to_string(),
                Some("origin".to_string()),
                None,
                None,
            )
            .await,
            "push_tag",
        );
    }

    #[tokio::test]
    async fn offline_mode_refuses_hosting_provider_apis() {
        let _guard = test_support::offline();

        expect_blocked(
            crate::commands::github::check_github_connection(Some("token".to_string())).await,
            "check_github_connection",
        );
        expect_blocked(
            crate::commands::gitlab::check_gitlab_connection(
                "https://gitlab.example.test".to_string(),
                Some("token".to_string()),
            )
            .await,
            "check_gitlab_connection",
        );
        expect_blocked(
            crate::commands::bitbucket::check_bitbucket_connection_with_token(Some(
                "token".to_string(),
            ))
            .await,
            "check_bitbucket_connection_with_token",
        );
        expect_blocked(
            crate::commands::azure_devops::list_ado_organizations(Some("token".to_string())).await,
            "list_ado_organizations",
        );
        expect_blocked(
            crate::commands::ssh::test_ssh_connection("git@github.com".to_string()).await,
            "test_ssh_connection",
        );
        // `test_credentials` runs the same `ssh -T` handshake as the command
        // above it. It was gated on the frontend only, so this sample — which
        // exists precisely because it is a sample and not an enumeration — did
        // not name it and nothing on this side noticed.
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        expect_blocked(
            crate::commands::credentials::test_credentials(
                repo.path_str(),
                "git@github.com:me/app.git".to_string(),
            )
            .await,
            "test_credentials",
        );
    }

    /// The credential test reaches a host, so an allowlist has to judge it —
    /// including the scp form with a login that is not `git`, which is an
    /// ordinary corporate remote rather than an exotic one.
    #[tokio::test]
    async fn the_credential_test_is_judged_on_the_host_it_would_contact() {
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        let _guard = test_support::allowlist(&["github.com"]);

        expect_blocked(
            crate::commands::credentials::test_credentials(
                repo.path_str(),
                "deploy@git.example.test:team/app.git".to_string(),
            )
            .await,
            "test_credentials off the allowlist",
        );

        // The allowed direction is asserted on the guard itself. Calling the
        // command here really ran `ssh -T -o StrictHostKeyChecking=accept-new
        // git@github.com`: an outbound connection out of the unit suite, and
        // `accept-new` ADDS github.com's host key to the developer's
        // ~/.ssh/known_hosts. It stayed green only because `ssh` is absent on
        // CI and the failed spawn is not a NetworkBlocked error — a pass for a
        // reason that has nothing to do with the gate.
        assert!(
            guard_url("git@github.com:me/app.git").is_ok(),
            "github.com is allowlisted, so the guard must not be what stops it"
        );
    }

    /// A URL the gate approves cannot then be contacted somewhere else.
    ///
    /// The gate reads the host after the FIRST `@` — `git@github.com:x@evil.test:y`
    /// is, to git, the path `x@evil.test:y` on `github.com` — while the commands
    /// that go on to contact it read the host after the LAST. Two parses meant a
    /// `github.com` allowlist approved an ssh connection to `evil.test`; the
    /// destination now comes from this one.
    #[test]
    fn a_gate_approved_url_cannot_smuggle_in_a_second_host() {
        let url = "git@github.com:x@evil.test:y";
        let _guard = test_support::allowlist(&["github.com"]);

        assert!(
            guard_url(url).is_ok(),
            "the gate reads the host git reads, so this URL is allowlisted"
        );
        let target = parse_target(url).expect("an scp-form remote resolves");
        assert_eq!(
            target.host, "github.com",
            "the destination must be the host the gate approved"
        );
        assert_eq!(target.user.as_deref(), Some("git"));
        assert!(target.is_ssh);
    }

    /// An allowlist refuses the provider it does not name while still allowing
    /// the one it does — the case that makes an allowlist worth setting.
    #[tokio::test]
    async fn an_allowlist_refuses_only_the_providers_it_does_not_name() {
        let _guard = test_support::allowlist(&["github.com"]);

        expect_blocked(
            crate::commands::gitlab::check_gitlab_connection(
                "https://gitlab.example.test".to_string(),
                Some("token".to_string()),
            )
            .await,
            "check_gitlab_connection",
        );
        // GitHub is allowed through the gate. Asserted on the guard rather than
        // by calling the command: `check_github_connection` would issue a real
        // request to api.github.com from the unit suite, and then "pass"
        // because the network error it fails with is not a NetworkBlocked one.
        // `api_client()` in commands/github.rs guards this exact URL.
        assert!(
            guard_url("https://api.github.com").is_ok(),
            "an allowlisted host must not be refused by the gate"
        );
    }

    /// Item (3): listing providers must not itself be a network request.
    ///
    /// Settings has to enumerate providers in order to offer the switch that
    /// turns the cloud one off, so the list still comes back — with the cloud
    /// entries marked unprobed rather than probed over the wire.
    #[tokio::test]
    async fn listing_ai_providers_offline_skips_the_cloud_probe() {
        use crate::services::ai::{AiProviderType, AiService};
        let dir = tempfile::TempDir::new().unwrap();
        let service = AiService::new(dir.path().to_path_buf());
        let _guard = test_support::offline();

        let infos = service.get_providers_info().await;
        assert!(
            !infos.is_empty(),
            "Settings must still be able to list providers while offline"
        );

        let openai = infos
            .iter()
            .find(|i| i.provider_type == AiProviderType::OpenAi)
            .expect("the cloud provider is still listed");
        assert!(
            !openai.probed,
            "a cloud provider must not be probed offline"
        );
        assert!(!openai.available);
        assert!(openai.models.is_empty());
        assert_eq!(openai.endpoint, AiProviderType::OpenAi.default_endpoint());

        // A provider on this machine is unaffected: offline mode is about
        // requests LEAVING the machine.
        let ollama = infos
            .iter()
            .find(|i| i.provider_type == AiProviderType::Ollama)
            .expect("the local provider is still listed");
        assert!(ollama.probed, "a loopback provider is still probed offline");
    }

    #[tokio::test]
    async fn an_ai_endpoint_is_gated_by_where_it_points() {
        use crate::services::ai::{AiProviderType, AiService};
        let dir = tempfile::TempDir::new().unwrap();
        let service = AiService::new(dir.path().to_path_buf());

        let _guard = test_support::offline();
        assert!(!service.provider_network_allowed(AiProviderType::OpenAi));
        assert!(service.provider_network_allowed(AiProviderType::Ollama));
        // The embedded model has no endpoint at all.
        assert!(service.provider_network_allowed(AiProviderType::LocalInference));
    }

    // ---- the paths that used to have NEITHER gate ----
    //
    // Model downloads and the GitHub App endpoints each built their own
    // `reqwest::Client`, so they reached huggingface.co / api.github.com with
    // offline mode on and no refusal anywhere. These pin the backstop.

    /// A PEM the GitHub App commands will actually accept.
    ///
    /// `configure_github_app` and `list_github_app_installations` sign a JWT
    /// before they reach the network, so an obviously fake key would fail on
    /// PEM parsing and never exercise the guard at all.
    fn test_private_key_pem() -> String {
        use aws_lc_rs::encoding::{AsDer, Pkcs8V1Der};
        use aws_lc_rs::rsa::{KeyPair, KeySize};

        let keypair = KeyPair::generate(KeySize::Rsa2048).expect("generate RSA key");
        let der: Pkcs8V1Der = keypair.as_der().expect("private key DER");
        pem::encode(&pem::Pem::new("PRIVATE KEY", der.as_ref()))
    }

    /// The first model the registry offers — any entry will do, they all come
    /// from the same host.
    fn a_registry_model() -> crate::services::ai::local::ModelEntry {
        crate::services::ai::local::ModelRegistry::default()
            .get_all()
            .first()
            .expect("the registry ships at least one model")
            .clone()
    }

    #[test]
    fn offline_mode_refuses_ai_model_downloads() {
        use crate::services::ai::local::model_manager::guard_model_download;
        use crate::services::embedding::embedding_model::guard_embedding_model_download;

        let entry = a_registry_model();
        let _guard = test_support::offline();

        // Both the command that starts the download and the request that opens
        // the socket run exactly these.
        expect_blocked(guard_model_download(&entry), "download_model");
        expect_blocked(guard_embedding_model_download(), "download_embedding_model");
    }

    #[test]
    fn an_allowlist_without_huggingface_refuses_model_downloads() {
        use crate::services::ai::local::model_manager::guard_model_download;
        use crate::services::embedding::embedding_model::guard_embedding_model_download;

        let entry = a_registry_model();

        {
            let _guard = test_support::allowlist(&["github.com"]);
            expect_blocked(guard_model_download(&entry), "download_model");
            expect_blocked(guard_embedding_model_download(), "download_embedding_model");
        }

        // Naming the host is what makes the download possible again — a guard
        // that refused either way would just be offline mode by another name.
        let _guard = test_support::allowlist(&["huggingface.co"]);
        assert!(guard_model_download(&entry).is_ok());
        assert!(guard_embedding_model_download().is_ok());
    }

    // ---- the auto-updater ----
    //
    // The last unguarded outbound path in the tree, and the one that mattered
    // most: it runs 30 seconds after every launch, unattended, and installs a
    // binary. Nothing about `updater.check()` is visible to the frontend gate,
    // so the backstop is the only thing standing between offline mode and a
    // request to the release host.

    #[test]
    fn offline_mode_refuses_the_updater() {
        use crate::services::update_service::{guard_update_endpoints, shipped_update_endpoints};

        let endpoints = shipped_update_endpoints();
        let _guard = test_support::offline();

        // Exactly the guard `check_and_install_update` (the periodic loop and
        // `download_and_install_update`) and `check_for_update_manual` (the
        // Settings button) run before they build the updater.
        expect_blocked(guard_update_endpoints(&endpoints), "check_for_update");
    }

    #[test]
    fn an_allowlist_without_the_update_host_refuses_the_updater() {
        use crate::services::security::url_host;
        use crate::services::update_service::{guard_update_endpoints, shipped_update_endpoints};

        let endpoints = shipped_update_endpoints();
        let host = url_host(&endpoints[0]).expect("the configured endpoint has a host");

        {
            let _guard = test_support::allowlist(&["example.test"]);
            expect_blocked(guard_update_endpoints(&endpoints), "check_for_update");
        }

        // Naming the release host is what makes updates possible again — a
        // guard that refused either way would just be offline mode by another
        // name.
        let _guard = test_support::allowlist(&[host.as_str()]);
        assert!(guard_update_endpoints(&endpoints).is_ok());
    }

    #[tokio::test]
    async fn offline_mode_refuses_the_github_app_endpoints() {
        let pem = test_private_key_pem();
        let _guard = test_support::offline();

        expect_blocked(
            crate::commands::github::configure_github_app(1, pem.clone(), 2).await,
            "configure_github_app",
        );
        expect_blocked(
            crate::commands::github::list_github_app_installations(1, pem).await,
            "list_github_app_installations",
        );
        // The two service functions the commands share, including the one
        // `check_github_connection` falls back to when no user token is stored.
        expect_blocked(
            crate::services::github_app::get_installation_token("jwt", 2).await,
            "get_installation_token",
        );
        expect_blocked(
            crate::services::github_app::list_installations("jwt").await,
            "list_installations",
        );
    }

    /// Every provider's "list my repositories" command, which the clone
    /// dialog's account picker calls.
    #[tokio::test]
    async fn offline_mode_refuses_provider_repository_listings() {
        let _guard = test_support::offline();

        expect_blocked(
            crate::commands::github::list_github_repositories(
                Some(10),
                Some(1),
                Some("token".to_string()),
            )
            .await,
            "list_github_repositories",
        );
        expect_blocked(
            crate::commands::gitlab::list_gitlab_projects(
                "https://gitlab.com".to_string(),
                Some(10),
                Some(1),
                Some("token".to_string()),
            )
            .await,
            "list_gitlab_projects",
        );
        expect_blocked(
            crate::commands::bitbucket::list_bitbucket_repositories(
                None,
                Some(10),
                Some(1),
                Some("token".to_string()),
                None,
                None,
            )
            .await,
            "list_bitbucket_repositories",
        );
        expect_blocked(
            crate::commands::azure_devops::list_ado_repositories(
                "org".to_string(),
                Some(10),
                Some(1),
                Some("token".to_string()),
            )
            .await,
            "list_ado_repositories",
        );
    }

    /// An allowlist naming only GitHub refuses the other three listings and
    /// lets GitHub's through to fail on the network instead.
    #[tokio::test]
    async fn an_allowlist_refuses_only_the_repository_listings_it_does_not_name() {
        let _guard = test_support::allowlist(&["github.com"]);

        expect_blocked(
            crate::commands::bitbucket::list_bitbucket_repositories(
                None,
                Some(10),
                Some(1),
                Some("token".to_string()),
                None,
                None,
            )
            .await,
            "list_bitbucket_repositories",
        );
        expect_blocked(
            crate::commands::azure_devops::list_ado_repositories(
                "org".to_string(),
                Some(10),
                Some(1),
                Some("token".to_string()),
            )
            .await,
            "list_ado_repositories",
        );

        // GitHub's listing is allowed through — asserted on the guard, for the
        // same reason as above: calling the command would put a real request to
        // api.github.com in the unit suite and then pass on its network error.
        assert!(
            guard_url("https://api.github.com").is_ok(),
            "an allowlisted host must not be refused by the gate"
        );
    }

    #[test]
    fn a_named_remote_resolves_to_its_url() {
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://github.com/me/app.git");
        repo.add_remote("upstream", "git@gitlab.example.test:acme/app.git");

        assert_eq!(
            resolve_remote_url(&repo.path_str(), Some("upstream"), false).as_deref(),
            Some("git@gitlab.example.test:acme/app.git")
        );
        // No name given means the repository's default remote.
        assert_eq!(
            resolve_remote_url(&repo.path_str(), None, false).as_deref(),
            Some("https://github.com/me/app.git")
        );
        // A URL passed where a name was expected travels through untouched.
        assert_eq!(
            resolve_remote_url(&repo.path_str(), Some("https://other.test/x.git"), false)
                .as_deref(),
            Some("https://other.test/x.git")
        );
    }

    /// A push goes to `pushurl` when the remote has one — git2 and `git push`
    /// both contact it — so that is the URL a push-class guard must judge.
    /// A fetch keeps judging the fetch URL, and a remote with no `pushurl`
    /// pushes to its one URL.
    #[test]
    fn a_push_resolves_the_push_url_and_a_fetch_the_fetch_url() {
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://github.com/org/x.git");
        repo.add_remote("mirror", "https://github.com/org/mirror.git");
        repo.repo()
            .config()
            .unwrap()
            .set_str("remote.origin.pushurl", "https://gitlab.example/org/x.git")
            .unwrap();

        assert_eq!(
            resolve_remote_url(&repo.path_str(), Some("origin"), true).as_deref(),
            Some("https://gitlab.example/org/x.git")
        );
        assert_eq!(
            resolve_remote_url(&repo.path_str(), None, true).as_deref(),
            Some("https://gitlab.example/org/x.git"),
            "the default remote's pushurl counts too"
        );
        assert_eq!(
            resolve_remote_url(&repo.path_str(), Some("origin"), false).as_deref(),
            Some("https://github.com/org/x.git")
        );
        assert_eq!(
            resolve_remote_url(&repo.path_str(), Some("mirror"), true).as_deref(),
            Some("https://github.com/org/mirror.git"),
            "no pushurl falls back to the remote's url"
        );
    }

    /// The ordinary fork layout: `origin` is the user's fork on github.com,
    /// the branch tracks `upstream` on gitlab.com. git's default remote for
    /// a fetch with no remote named is the tracking remote — and so is the
    /// gate's now, rather than `origin`.
    fn fork_layout_tracking_upstream() -> crate::test_utils::TestRepo {
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://github.com/me/app.git");
        repo.add_remote("upstream", "https://gitlab.com/acme/app.git");
        let git_repo = repo.repo();
        let branch = repo.current_branch();
        let mut cfg = git_repo.config().unwrap();
        cfg.set_str(&format!("branch.{}.remote", branch), "upstream")
            .unwrap();
        cfg.set_str(
            &format!("branch.{}.merge", branch),
            &format!("refs/heads/{}", branch),
        )
        .unwrap();
        repo
    }

    #[test]
    fn no_remote_named_means_the_tracking_remote_not_origin() {
        let repo = fork_layout_tracking_upstream();
        assert_eq!(
            resolve_remote_url(&repo.path_str(), None, false).as_deref(),
            Some("https://gitlab.com/acme/app.git")
        );
        // Naming a remote still means that remote.
        assert_eq!(
            resolve_remote_url(&repo.path_str(), Some("origin"), false).as_deref(),
            Some("https://github.com/me/app.git")
        );
    }

    /// End to end: `git fetch --deepen` names no remote, so it goes to the
    /// tracking remote, and the gate must refuse it by THAT host.
    #[tokio::test]
    async fn a_remote_less_fetch_is_judged_on_the_tracking_remote() {
        let repo = fork_layout_tracking_upstream();
        let _guard = test_support::allowlist(&["github.com"]);

        let refused = blocked(crate::commands::remote::deepen_repository(repo.path_str(), 5).await);
        assert!(refused.contains("gitlab.com"), "got: {refused}");
        let refused = blocked(crate::commands::remote::unshallow_repository(repo.path_str()).await);
        assert!(refused.contains("gitlab.com"), "got: {refused}");
    }

    /// The gate itself: the same repository passes a `github.com` allowlist
    /// for a fetch and is refused for a push, naming the host it would have
    /// reached.
    #[test]
    fn the_push_guard_judges_the_push_url() {
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://github.com/org/x.git");
        repo.repo()
            .config()
            .unwrap()
            .set_str("remote.origin.pushurl", "https://gitlab.example/org/x.git")
            .unwrap();
        let _guard = test_support::allowlist(&["github.com"]);

        assert!(guard_remote(&repo.path_str(), Some("origin")).is_ok());
        let refused = blocked(guard_push_remote(&repo.path_str(), Some("origin")));
        assert!(refused.contains("gitlab.example"), "got: {refused}");
    }

    // ---- the test-support lock itself ----
    //
    // Every guarded-command test in the crate relies on these semantics, so
    // they are pinned here rather than discovered the next time the suite
    // goes red under load.

    use std::sync::mpsc;
    use std::time::Duration;

    /// Run `f` on its own thread and wait for it, failing rather than hanging
    /// if it does not finish.
    fn on_another_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        rx.recv_timeout(Duration::from_secs(10))
            .expect("the other thread must finish: the lock is stuck")
    }

    fn policy_is_default() -> bool {
        global().snapshot() == SecuritySettings::default()
    }

    #[test]
    fn a_reader_holds_off_a_writer_until_it_drops() {
        let reader = test_support::no_policy();
        assert!(policy_is_default());

        let (acquired_tx, acquired_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let writer = std::thread::spawn(move || {
            let _guard = test_support::offline();
            acquired_tx.send(global().snapshot().offline_mode).unwrap();
            let _ = release_rx.recv();
        });

        // The writer cannot get in while the reader pins the default.
        assert!(
            acquired_rx
                .recv_timeout(Duration::from_millis(300))
                .is_err(),
            "a writer must wait for the reader"
        );
        assert!(policy_is_default(), "the reader still sees the default");

        drop(reader);
        assert!(
            acquired_rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            "the writer runs with its policy once the reader is gone"
        );
        drop(release_tx);
        writer.join().unwrap();
        // Read back under a reader of our own: another test's writer may
        // otherwise be in force by now, which is the lock working, not failing.
        let _reader = test_support::no_policy();
        assert!(policy_is_default(), "the writer restored the default");
    }

    #[test]
    fn readers_share_the_lock_with_each_other() {
        let _mine = test_support::no_policy();
        // Another thread's reader is not made to wait.
        assert!(on_another_thread(|| {
            let _theirs = test_support::no_policy();
            policy_is_default()
        }));
    }

    #[test]
    fn a_writer_takes_over_a_reader_share_its_own_thread_holds() {
        // The order every refusal test uses: the repository first, then the
        // policy. Without the takeover this would wait for itself forever.
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        let reader = test_support::no_policy();
        {
            let _offline = test_support::offline();
            assert!(global().snapshot().offline_mode);
            assert!(guard_remote(&repo.path_str(), None).is_err());
        }
        assert!(
            policy_is_default(),
            "dropping the writer restores the default"
        );
        // And the share is handed back: a writer elsewhere waits again.
        assert!(
            on_another_thread(|| {
                let (tx, rx) = mpsc::channel();
                std::thread::spawn(move || {
                    let _g = test_support::offline();
                    let _ = tx.send(());
                });
                rx.recv_timeout(Duration::from_millis(300)).is_err()
            }),
            "the reader share is back in force after the writer drops"
        );
        drop(reader);
        drop(repo);
    }

    #[test]
    fn a_reader_share_dropped_under_a_writer_leaves_the_count_consistent() {
        let reader = test_support::no_policy();
        let writer = test_support::offline();
        drop(reader);
        drop(writer);
        {
            let _reader = test_support::no_policy();
            assert!(policy_is_default());
        }
        // Nothing is left counted: a writer on another thread gets straight in.
        assert!(on_another_thread(|| {
            let _g = test_support::offline();
            global().snapshot().offline_mode
        }));
    }

    #[test]
    fn a_reader_taken_under_a_writer_keeps_the_writer_policy() {
        let _offline = test_support::offline();
        // The refusal tests build repositories after switching the policy on;
        // that must not quietly turn it back off.
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        let _reader = test_support::no_policy();
        assert!(global().snapshot().offline_mode);
        assert!(guard_remote(&repo.path_str(), None).is_err());
    }

    #[test]
    fn nested_writers_restore_the_policy_they_replaced() {
        let _outer = test_support::allowlist(&["github.com"]);
        {
            let _inner = test_support::offline();
            assert!(global().snapshot().offline_mode);
        }
        assert_eq!(
            global().snapshot(),
            settings(false, &["github.com"]),
            "dropping the inner writer restores the outer policy"
        );
    }

    #[test]
    fn a_test_repo_pins_the_default_for_as_long_as_it_lives() {
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        // A writer elsewhere waits until the repository is gone.
        let (tx, rx) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            let _g = test_support::offline();
            let _ = tx.send(());
        });
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
        assert!(guard_remote(&repo.path_str(), None).is_ok());
        drop(repo);
        rx.recv_timeout(Duration::from_secs(10))
            .expect("the writer gets in once the repository is dropped");
        writer.join().unwrap();
    }
}
