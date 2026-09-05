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

use crate::error::{LeviathanError, Result};
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
/// `ssh://git@host/path`, and the scheme-less scp-like `git@host:owner/repo.git`
/// that no URL parser accepts. Matching on the HOST rather than on a substring
/// of the whole URL is the point — `https://github.com.evil.test/x.git`
/// literally contains `github.com`.
pub fn url_host(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if !trimmed.contains("://") {
        return scp_like_host(trimmed);
    }
    url::Url::parse(trimmed)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host.to_lowercase()))
        .filter(|host| !host.is_empty())
}

/// `user@host:path` — the scp-like form. Equivalent to the frontend's
/// `/^[^@\/]+@([^:\/]+):/`.
fn scp_like_host(value: &str) -> Option<String> {
    let at = value.find('@')?;
    if at == 0 {
        return None;
    }
    if value[..at].contains('/') {
        return None;
    }
    let rest = &value[at + 1..];
    let colon = rest.find(':')?;
    if colon == 0 {
        return None;
    }
    let host = &rest[..colon];
    if host.contains('/') {
        return None;
    }
    Some(host.to_lowercase())
}

/// The host a target string resolves to, trying it as written and then as an
/// https URL — the fallback is what lets the bare `git@host` and `host` forms
/// resolve, exactly as the frontend does.
fn target_host(target: &str) -> Option<String> {
    url_host(target).or_else(|| url_host(&format!("https://{}", target.trim())))
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
pub fn check(settings: &SecuritySettings, target: Option<&str>) -> Result<()> {
    if settings.offline_mode {
        return Err(LeviathanError::NetworkBlocked(
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
        return Err(LeviathanError::NetworkBlocked(
            "Could not determine the remote URL, and an allowlist is configured".to_string(),
        ));
    };
    match target_host(target) {
        Some(host) if host_allowed(&host, &settings.remote_allowlist) => Ok(()),
        Some(_) => Err(LeviathanError::NetworkBlocked(format!(
            "Remote \"{}\" is not in your allowlist",
            target
        ))),
        None => Err(LeviathanError::NetworkBlocked(
            "Could not determine the remote URL, and an allowlist is configured".to_string(),
        )),
    }
}

/// Guard an operation whose destination the caller already knows as a URL or
/// bare host — clone, `add_submodule`, a provider's API base.
pub fn guard_url(url: &str) -> Result<()> {
    check(&global().snapshot(), Some(url))
}

/// Guard an operation against a remote of `repo_path`.
///
/// `remote` is a remote NAME (`origin`) or a URL; `None` means the operation
/// targets the repository's default remote. Offline mode short-circuits before
/// the repository is opened, so the common refusal costs nothing.
pub fn guard_remote(repo_path: &str, remote: Option<&str>) -> Result<()> {
    let settings = global().snapshot();
    if settings.offline_mode {
        return check(&settings, None);
    }
    if settings.remote_allowlist.is_empty() {
        return Ok(());
    }
    let url = resolve_remote_url(repo_path, remote);
    check(&settings, url.as_deref())
}

/// The URL an operation against `remote` will contact.
///
/// Mirrors `resolveRemoteUrl` in the frontend: a value that already looks like
/// a URL is passed through, a named remote is looked up, and a caller that
/// named none falls back to `origin` and then to whatever remote exists.
fn resolve_remote_url(repo_path: &str, remote: Option<&str>) -> Option<String> {
    if let Some(remote) = remote {
        if looks_like_url(remote) {
            return Some(remote.to_string());
        }
    }
    let repo = git2::Repository::open(Path::new(repo_path)).ok()?;
    let wanted = remote.unwrap_or("origin");
    if let Ok(found) = repo.find_remote(wanted) {
        return found.url().ok().map(|u| u.to_string());
    }
    if remote.is_none() {
        let names = repo.remotes().ok()?;
        let first = names.iter().filter_map(|s| s.ok().flatten()).next()?;
        return repo
            .find_remote(first)
            .ok()
            .and_then(|r| r.url().ok().map(|u| u.to_string()));
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
/// tests in parallel threads, so those tests have to take turns. Holding the
/// returned guard both pins the settings and serializes against every other
/// test doing the same; dropping it restores the permissive default.
#[cfg(test)]
pub(crate) mod test_support {
    use super::{global, SecuritySettings};
    use std::sync::{Mutex, MutexGuard};

    static SERIAL: Mutex<()> = Mutex::new(());

    pub(crate) struct GlobalSettingsGuard {
        _lock: MutexGuard<'static, ()>,
    }

    impl Drop for GlobalSettingsGuard {
        fn drop(&mut self) {
            global().set(SecuritySettings::default());
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

    pub(crate) fn with(settings: SecuritySettings) -> GlobalSettingsGuard {
        // A test that panicked while holding the lock poisoned it; the state is
        // reset on drop regardless, so the poison carries no information here.
        let lock = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        global().set(settings);
        GlobalSettingsGuard { _lock: lock }
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
            Err(LeviathanError::NetworkBlocked(message)) => message,
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

    #[test]
    fn an_unresolvable_target_is_refused_when_an_allowlist_exists() {
        let message = blocked(check(&settings(false, &["github.com"]), None));
        assert!(message.contains("Could not determine"), "{message}");
        assert!(check(
            &settings(false, &["github.com"]),
            Some("/srv/repos/local.git")
        )
        .is_err());
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
            LeviathanError::NetworkBlocked("nope".to_string()).into();
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
            Err(LeviathanError::NetworkBlocked(_)) => {}
            Ok(value) => panic!("{what} was allowed to run offline: {value:?}"),
            Err(other) => panic!("{what} failed for the wrong reason: {other}"),
        }
    }

    #[tokio::test]
    async fn offline_mode_refuses_remote_git_operations() {
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://github.com/me/app.git");
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
        // GitHub is allowed through the gate. It then fails on the network,
        // which is a different error — and that is the point: the guard is not
        // what stopped it.
        let allowed =
            crate::commands::github::check_github_connection(Some("token".to_string())).await;
        assert!(
            !matches!(allowed, Err(LeviathanError::NetworkBlocked(_))),
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

        let allowed = crate::commands::github::list_github_repositories(
            Some(10),
            Some(1),
            Some("token".to_string()),
        )
        .await;
        assert!(
            !matches!(allowed, Err(LeviathanError::NetworkBlocked(_))),
            "an allowlisted host must not be refused by the gate"
        );
    }

    #[test]
    fn a_named_remote_resolves_to_its_url() {
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://github.com/me/app.git");
        repo.add_remote("upstream", "git@gitlab.example.test:acme/app.git");

        assert_eq!(
            resolve_remote_url(&repo.path_str(), Some("upstream")).as_deref(),
            Some("git@gitlab.example.test:acme/app.git")
        );
        // No name given means the repository's default remote.
        assert_eq!(
            resolve_remote_url(&repo.path_str(), None).as_deref(),
            Some("https://github.com/me/app.git")
        );
        // A URL passed where a name was expected travels through untouched.
        assert_eq!(
            resolve_remote_url(&repo.path_str(), Some("https://other.test/x.git")).as_deref(),
            Some("https://other.test/x.git")
        );
    }
}
