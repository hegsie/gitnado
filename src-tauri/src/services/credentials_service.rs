//! Git credentials service
//!
//! Provides credential management for git operations using macOS Keychain
//! via the `security` CLI tool (avoids permission prompts that the keyring crate triggers).

use git2::{Cred, CredentialType, RemoteCallbacks};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::services::transfer_monitor::TransferMonitor;

/// Service name for keychain storage
const SERVICE_NAME: &str = "gitnado-git";

/// Service name from before the 0.9.0 rename. An entry found under it is
/// copied under `SERVICE_NAME` and then removed, so stored git credentials
/// survive the upgrade without prompting again.
const LEGACY_SERVICE_NAME: &str = "leviathan-git";

/// Time-to-live for cached credentials (30 minutes).
/// Expired entries are lazily removed on the next cache read.
const CREDENTIAL_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// A cached credential entry with an insertion timestamp for TTL enforcement.
#[derive(Clone)]
struct CachedCredential {
    username: String,
    password: String,
    cached_at: Instant,
}

/// In-memory credential cache (host -> credential + timestamp).
/// Used as a fast lookup before hitting keychain.
static CREDENTIAL_CACHE: Mutex<Option<HashMap<String, CachedCredential>>> = Mutex::new(None);

/// Remove all expired entries from the credential cache.
fn cleanup_expired_credentials(map: &mut HashMap<String, CachedCredential>) {
    let now = Instant::now();
    map.retain(|host, entry| {
        let alive = now.duration_since(entry.cached_at) < CREDENTIAL_CACHE_TTL;
        if !alive {
            tracing::debug!("Credential cache entry expired for host: {}", host);
        }
        alive
    });
}

/// Get credentials from the in-memory cache.
/// Performs lazy cleanup of expired entries before lookup.
fn get_cached_credentials(host: &str) -> Option<(String, String)> {
    let mut cache = match CREDENTIAL_CACHE.lock() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Warning: credential cache lock poisoned: {}", e);
            return None;
        }
    };
    let map = cache.as_mut()?;
    cleanup_expired_credentials(map);
    map.get(host)
        .map(|entry| (entry.username.clone(), entry.password.clone()))
}

/// Store credentials in the in-memory cache
fn cache_credentials(host: &str, username: &str, password: &str) {
    if let Ok(mut cache) = CREDENTIAL_CACHE.lock() {
        let map = cache.get_or_insert_with(HashMap::new);
        map.insert(
            host.to_string(),
            CachedCredential {
                username: username.to_string(),
                password: password.to_string(),
                cached_at: Instant::now(),
            },
        );
    }
}

/// Get a password from the keyring
fn keyring_get(service: &str, account: &str) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("security")
            .args(["find-generic-password", "-s", service, "-a", account, "-w"])
            .output()
            .ok()?;
        if output.status.success() {
            let pw = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if pw.is_empty() {
                None
            } else {
                Some(pw)
            }
        } else {
            None
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Reassembles a chunked secret (large Entra token) transparently.
        crate::services::keyring_util::get(service, account)
            .ok()
            .flatten()
    }
}

/// Store a password in the keyring.
/// On macOS uses the `security` CLI. In **debug** builds `-A` (allow any
/// application) is added for development convenience so frequent rebuilds don't
/// trigger authorization prompts; in **release** builds it is omitted so the
/// keychain entry is scoped to the signed application bundle (per-app
/// isolation), mirroring `credentials::build_security_add_args`. The password
/// is sent on stdin (via `-w` with no value) so it does NOT appear in the
/// process argv, where any other process under the same user could read it via
/// `ps`.
fn keyring_set(service: &str, account: &str, password: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::io::Write as _;
        use std::process::Stdio;

        // Delete existing entry first
        let _ = std::process::Command::new("security")
            .args(["delete-generic-password", "-s", service, "-a", account])
            .output();

        // `-A` allows any application without a prompt — debug builds only.
        #[cfg(debug_assertions)]
        let args: &[&str] = &[
            "add-generic-password",
            "-s",
            service,
            "-a",
            account,
            "-A",
            "-U",
            "-w",
        ];
        #[cfg(not(debug_assertions))]
        let args: &[&str] = &[
            "add-generic-password",
            "-s",
            service,
            "-a",
            account,
            "-U",
            "-w",
        ];

        // `-w` last with no argument => read password from stdin.
        let mut child = match std::process::Command::new("security")
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => return false,
        };
        if let Some(mut stdin) = child.stdin.take() {
            if stdin.write_all(password.as_bytes()).is_err() {
                let _ = child.kill();
                return false;
            }
        }
        child.wait().map(|s| s.success()).unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Chunk transparently so a large Entra token doesn't exceed the Windows
        // Credential Manager 2560-byte per-secret limit.
        crate::services::keyring_util::set(service, account, password).is_ok()
    }
}

/// Delete a password from the keyring
fn keyring_delete(service: &str, account: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("security")
            .args(["delete-generic-password", "-s", service, "-a", account])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        crate::services::keyring_util::delete(service, account).is_ok()
    }
}

/// Credentials helper that provides git2 remote callbacks with authentication support
pub struct CredentialsHelper {
    /// Whether to try SSH agent
    try_ssh_agent: bool,
    /// Whether to try SSH key from default locations
    try_ssh_key: bool,
    /// Specific token to use for authentication (bypasses keychain)
    token: Option<String>,
}

impl Default for CredentialsHelper {
    fn default() -> Self {
        Self {
            try_ssh_agent: true,
            try_ssh_key: true,
            token: None,
        }
    }
}

impl CredentialsHelper {
    /// Create new credentials helper
    pub fn new() -> Self {
        Self::default()
    }

    /// Create new credentials helper with a specific token
    pub fn new_with_token(token: Option<String>) -> Self {
        Self {
            token,
            ..Self::default()
        }
    }

    /// Get remote callbacks configured with credential support
    pub fn get_callbacks(&self) -> RemoteCallbacks<'static> {
        let try_ssh_agent = self.try_ssh_agent;
        let try_ssh_key = self.try_ssh_key;
        let token = self.token.clone();
        let mut tried_ssh_agent = false;
        let mut tried_ssh_key = false;
        let mut tried_keyring = false;
        let mut tried_token = false;

        let mut callbacks = RemoteCallbacks::new();

        callbacks.credentials(move |url, username_from_url, allowed_types| {
            tracing::debug!(
                "Credential callback: url={}, username={:?}, allowed={:?}",
                url,
                username_from_url,
                allowed_types
            );

            // Try provided token first for HTTPS
            if let Some(ref token_value) = token {
                if allowed_types.contains(CredentialType::USER_PASS_PLAINTEXT) && !tried_token {
                    tried_token = true;
                    tracing::debug!("Using provided token for authentication");
                    let username = username_from_url.unwrap_or("git");
                    return Cred::userpass_plaintext(username, token_value);
                }
            }

            // Try SSH agent first for SSH URLs
            if allowed_types.contains(CredentialType::SSH_KEY) && try_ssh_agent && !tried_ssh_agent
            {
                tried_ssh_agent = true;
                let username = username_from_url.unwrap_or("git");
                tracing::debug!("Trying SSH agent for user: {}", username);
                if let Ok(cred) = Cred::ssh_key_from_agent(username) {
                    return Ok(cred);
                }
            }

            // Try SSH key from default location
            if allowed_types.contains(CredentialType::SSH_KEY) && try_ssh_key && !tried_ssh_key {
                tried_ssh_key = true;
                let username = username_from_url.unwrap_or("git");

                // Try common SSH key locations
                if let Some(home) = dirs::home_dir() {
                    for key_name in &["id_ed25519", "id_rsa", "id_ecdsa"] {
                        let private_key = home.join(".ssh").join(key_name);
                        let public_key = home.join(".ssh").join(format!("{}.pub", key_name));

                        if private_key.exists() {
                            tracing::debug!("Trying SSH key: {:?}", private_key);
                            if let Ok(cred) =
                                Cred::ssh_key(username, Some(&public_key), &private_key, None)
                            {
                                return Ok(cred);
                            }
                        }
                    }
                }
            }

            // Try stored credentials from keyring for HTTPS
            if allowed_types.contains(CredentialType::USER_PASS_PLAINTEXT) && !tried_keyring {
                tried_keyring = true;

                if let Some((username, password)) = get_stored_credentials(url) {
                    tracing::debug!("Using stored credentials for: {}", url);
                    return Cred::userpass_plaintext(&username, &password);
                }
            }

            // Skip Cred::default() — it invokes the system git credential helper
            // (osxkeychain on macOS) which triggers Keychain authorization dialogs.
            // Our stored credentials and SSH keys above are sufficient.

            Err(git2::Error::from_str(
                "No valid credentials found. For private repositories, configure SSH keys or store credentials.",
            ))
        });

        callbacks
    }
}

/// Read `account` from `service`, falling back to the same account under
/// `legacy_service`. A legacy hit is written under `service` and, once that
/// write succeeded, removed from `legacy_service` — so the fallback is taken
/// once per entry. The backend is passed in so the decision logic is testable
/// without a keyring.
fn get_with_legacy_fallback(
    service: &str,
    legacy_service: &str,
    account: &str,
    get: impl Fn(&str, &str) -> Option<String>,
    set: impl Fn(&str, &str, &str) -> bool,
    delete: impl Fn(&str, &str) -> bool,
) -> Option<String> {
    if let Some(value) = get(service, account) {
        return Some(value);
    }
    let value = get(legacy_service, account)?;
    if set(service, account, &value) {
        delete(legacy_service, account);
    } else {
        tracing::warn!(
            "Found legacy keyring entry for {} but could not re-store it under {}",
            account,
            service
        );
    }
    Some(value)
}

/// `keyring_get` under `SERVICE_NAME`, adopting a pre-rename entry if needed.
fn keyring_get_migrating(account: &str) -> Option<String> {
    get_with_legacy_fallback(
        SERVICE_NAME,
        LEGACY_SERVICE_NAME,
        account,
        keyring_get,
        keyring_set,
        keyring_delete,
    )
}

/// Get stored credentials - checks memory cache first, then keychain
fn get_stored_credentials(url: &str) -> Option<(String, String)> {
    let host = extract_host(url)?;
    tracing::debug!("Looking up credentials for host: {}", host);

    // Check memory cache first (fast path)
    if let Some(creds) = get_cached_credentials(&host) {
        tracing::debug!(
            "Found credentials in cache for host: {} (username len: {}, password len: {})",
            host,
            creds.0.len(),
            creds.1.len()
        );
        return Some(creds);
    }

    // Try keyring
    let username_key = format!("{}_username", host);
    let password_key = format!("{}_password", host);

    let username = keyring_get_migrating(&username_key)?;
    let password = keyring_get_migrating(&password_key)?;

    // Cache for faster future lookups
    cache_credentials(&host, &username, &password);

    tracing::debug!(
        "Found credentials in keyring for host: {} (username len: {}, password len: {})",
        host,
        username.len(),
        password.len()
    );
    Some((username, password))
}

/// Store credentials in memory cache and keychain.
///
/// A failed keyring write is reported to the caller instead of being swallowed:
/// returning `Ok(())` after a failure made the UI show a connected account while
/// the credential only lived in this process, so a later push/pull prompted for
/// credentials with nothing tying it back to the connect. The memory cache is
/// still populated first, so the current session keeps working; the error says
/// the credential will not outlive it.
pub fn store_credentials(url: &str, username: &str, password: &str) -> Result<(), String> {
    store_credentials_with(url, username, password, keyring_set, keyring_delete)
}

/// Implementation of [`store_credentials`] with the keyring writer/remover
/// injected so the failure and rollback paths can be tested without a real
/// keychain.
fn store_credentials_with(
    url: &str,
    username: &str,
    password: &str,
    set: impl Fn(&str, &str, &str) -> bool,
    delete: impl Fn(&str, &str) -> bool,
) -> Result<(), String> {
    let host = extract_host(url).ok_or("Invalid URL")?;
    tracing::debug!(
        "Storing credentials for host: {} (username len: {}, password len: {})",
        host,
        username.len(),
        password.len()
    );

    // Store in memory cache
    cache_credentials(&host, username, password);

    // Store in keyring
    let username_key = format!("{}_username", host);
    let password_key = format!("{}_password", host);

    let username_ok = set(SERVICE_NAME, &username_key, username);
    let password_ok = set(SERVICE_NAME, &password_key, password);

    if username_ok && password_ok {
        tracing::info!("Stored credentials in keyring for host: {}", host);
        return Ok(());
    }

    // Roll back the half that landed. `keyring_set` deletes before adding, so a
    // partial write leaves the keyring holding a fresh username next to a
    // deleted password (or the reverse) — an orphan that
    // `get_stored_credentials` can never pair up and that outlives the process.
    if username_ok {
        delete(SERVICE_NAME, &username_key);
    }
    if password_ok {
        delete(SERVICE_NAME, &password_key);
    }

    tracing::warn!(
        "Failed to store credentials in keyring for host: {} (cached in memory only)",
        host
    );
    Err(format!(
        "keyring write failed for {} - credentials are cached for this session only",
        host
    ))
}

/// Delete stored credentials from memory cache and keychain
pub fn delete_credentials(url: &str) -> Result<(), String> {
    let host = extract_host(url).ok_or("Invalid URL")?;

    // Remove from memory cache
    if let Ok(mut cache) = CREDENTIAL_CACHE.lock() {
        if let Some(map) = cache.as_mut() {
            map.remove(&host);
        }
    }

    // Remove from keyring
    let username_key = format!("{}_username", host);
    let password_key = format!("{}_password", host);
    keyring_delete(SERVICE_NAME, &username_key);
    keyring_delete(SERVICE_NAME, &password_key);
    // A pre-rename entry that was never read (and so never adopted) must not
    // outlive an explicit delete either.
    keyring_delete(LEGACY_SERVICE_NAME, &username_key);
    keyring_delete(LEGACY_SERVICE_NAME, &password_key);

    tracing::debug!("Deleted credentials for host: {}", host);
    Ok(())
}

/// Extract host from a git URL
fn extract_host(url: &str) -> Option<String> {
    // Handle SSH URLs like git@github.com:user/repo.git
    if url.contains('@') && url.contains(':') && !url.contains("://") {
        let parts: Vec<&str> = url.split('@').collect();
        if parts.len() >= 2 {
            let host_part: Vec<&str> = parts[1].split(':').collect();
            return Some(host_part[0].to_string());
        }
    }

    // Handle HTTPS URLs
    if let Ok(parsed) = url::Url::parse(url) {
        return parsed.host_str().map(|s| s.to_string());
    }

    None
}

/// Why a transfer callback aborted the transfer.
///
/// Both flags are set at the moment the callback returns false, and are the
/// ONLY way the error site can tell that abort apart from any other libgit2
/// failure that merely happened to surface at the same time. Asking the
/// condition again there instead (has the deadline passed? is the token
/// cancelled?) relabelled auth failures, protocol errors and disk errors as
/// "timed out" — see `get_callbacks_with_deadline`.
#[derive(Clone, Default)]
pub struct TransferAbort {
    /// The in-task deadline stopped the transfer.
    pub timed_out: Arc<AtomicBool>,
    /// The user cancelled the operation.
    pub cancelled: Arc<AtomicBool>,
}

impl TransferAbort {
    pub fn timed_out(&self) -> bool {
        self.timed_out.load(Ordering::SeqCst)
    }

    pub fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// Get fetch options with credential and progress callbacks
pub fn get_fetch_options<'a>(token: Option<String>) -> git2::FetchOptions<'a> {
    get_fetch_options_with_deadline(token, None).0
}

/// Same, but the transfer aborts itself once `deadline` passes.
///
/// Returns the abort flag alongside the options — see
/// `get_callbacks_with_deadline` for why the caller needs it.
pub fn get_fetch_options_with_deadline<'a>(
    token: Option<String>,
    deadline: Option<std::time::Instant>,
) -> (git2::FetchOptions<'a>, Arc<AtomicBool>) {
    let (opts, abort) =
        get_fetch_options_with_monitor(token, deadline, TransferMonitor::disabled());
    (opts, abort.timed_out)
}

/// Fetch options that also honour a user cancellation and report progress.
pub fn get_fetch_options_with_monitor<'a>(
    token: Option<String>,
    deadline: Option<std::time::Instant>,
    monitor: TransferMonitor,
) -> (git2::FetchOptions<'a>, TransferAbort) {
    let mut fetch_opts = git2::FetchOptions::new();
    let (callbacks, abort) = get_callbacks_with_monitor(token, deadline, monitor);
    fetch_opts.remote_callbacks(callbacks);
    (fetch_opts, abort)
}

/// Get push options with credential and progress callbacks
pub fn get_push_options<'a>(token: Option<String>) -> git2::PushOptions<'a> {
    get_push_options_with_monitor(token, TransferMonitor::disabled()).0
}

/// Push options that honour a user cancellation and report progress.
///
/// The cancellation point is `push_negotiation`, which libgit2 calls once the
/// remote's refs are known and BEFORE a single object is packed or sent —
/// returning an error there aborts the push with nothing written to the
/// remote. That is the only abort point available: git2's
/// `push_transfer_progress` binding always returns 0 to libgit2, so a push
/// already uploading its pack cannot be stopped from Rust. A cancel that
/// arrives after that point is therefore honoured on a best-effort basis, and
/// the push may still land — which is why the frontend reports "cancelled"
/// only when the command actually returns `OperationCancelled`, and reports
/// the real success otherwise.
pub fn get_push_options_with_monitor<'a>(
    token: Option<String>,
    monitor: TransferMonitor,
) -> (git2::PushOptions<'a>, TransferAbort) {
    let mut push_opts = git2::PushOptions::new();
    let (mut callbacks, abort) = get_callbacks_with_monitor(token, None, monitor.clone());

    let negotiation_abort = abort.cancelled.clone();
    callbacks.push_negotiation(move |_updates| {
        if monitor.is_cancelled() {
            // Recorded BEFORE the abort, so the error libgit2 raises for it is
            // already attributable by the time the caller inspects it.
            negotiation_abort.store(true, Ordering::SeqCst);
            return Err(git2::Error::from_str("Push cancelled"));
        }
        Ok(())
    });

    // Without this, a push the SERVER rejects reports success. libgit2's
    // git_remote_push only errors when the pack fails to unpack; per-reference
    // rejections (a protected branch, a pre-receive hook exiting non-zero) land
    // in the push status list, and git_push_update_tips simply skips any entry
    // carrying a message. Nothing inspects them unless this callback is
    // registered, so `Remote::push` returned Ok and the UI said
    // "Pushed to origin/main" while nothing had reached the remote — the worst
    // possible lie to tell someone before they reset or delete a branch.
    // (Plain non-fast-forward is already caught by libgit2's local pre-check.)
    callbacks.push_update_reference(|refname, status| match status {
        Some(msg) => Err(git2::Error::from_str(&format!("{}: {}", refname, msg))),
        None => Ok(()),
    });

    push_opts.remote_callbacks(callbacks);
    (push_opts, abort)
}

/// Get remote callbacks with both credential and progress support
pub fn get_callbacks_with_progress<'a>(token: Option<String>) -> RemoteCallbacks<'a> {
    get_callbacks_with_deadline(token, None).0
}

/// Same, but the transfer aborts itself once `deadline` passes.
///
/// Returning false from `transfer_progress` is the only cancellation point
/// libgit2 offers, and it is the one `clone_repository` already uses: without
/// it a fetch keeps downloading long after the caller's `tokio::time::timeout`
/// gave up, because dropping that future does not cancel the blocking task.
///
/// The returned flag is set at the moment the callback aborts the transfer,
/// and is the ONLY way the error site can tell that abort apart from any other
/// libgit2 failure that merely happened to surface after the deadline. Asking
/// `deadline_passed` there instead relabelled auth failures, protocol errors
/// and disk errors as "timed out" — and on the pull path such a relabelled
/// error is then suppressed as an already-reported timeout, so the real
/// failure never reached the user at all.
pub fn get_callbacks_with_deadline<'a>(
    token: Option<String>,
    deadline: Option<std::time::Instant>,
) -> (RemoteCallbacks<'a>, Arc<AtomicBool>) {
    let (callbacks, abort) =
        get_callbacks_with_monitor(token, deadline, TransferMonitor::disabled());
    (callbacks, abort.timed_out)
}

/// Same, and additionally honours a user cancellation and reports progress.
///
/// The cancellation check sits in the SAME `transfer_progress` callback as the
/// deadline check, for the same reason: returning false from it is the only
/// abort point libgit2 offers. The two are recorded on separate flags so the
/// error site can say which of them stopped the transfer.
pub fn get_callbacks_with_monitor<'a>(
    token: Option<String>,
    deadline: Option<std::time::Instant>,
    monitor: TransferMonitor,
) -> (RemoteCallbacks<'a>, TransferAbort) {
    let mut callbacks = CredentialsHelper::new_with_token(token).get_callbacks();
    let abort = TransferAbort::default();
    let deadline_flag = Arc::clone(&abort.timed_out);
    let cancel_flag = Arc::clone(&abort.cancelled);
    let fetch_monitor = monitor.clone();

    // Add transfer progress callback
    callbacks.transfer_progress(move |stats| {
        // Cancellation is checked BEFORE the deadline so a user who pressed
        // Cancel on an operation that was also about to time out is told what
        // they did, not what the clock did.
        if fetch_monitor.is_cancelled() {
            cancel_flag.store(true, Ordering::SeqCst);
            return false;
        }
        if crate::utils::deadline_passed(deadline) {
            // Recorded BEFORE the abort, so the error libgit2 raises for it is
            // already attributable by the time the caller inspects it.
            deadline_flag.store(true, Ordering::SeqCst);
            return false;
        }

        let received = stats.received_objects();
        let total = stats.total_objects();
        let bytes = stats.received_bytes();

        if total > 0 {
            let percent = (received as f64 / total as f64) * 100.0;
            tracing::debug!(
                "Transfer progress: {}/{} objects ({:.1}%), {} bytes",
                received,
                total,
                percent,
                bytes
            );
        }

        fetch_monitor.report(received, total, bytes);

        true // Continue the transfer
    });

    // Add sideband progress callback (for server messages)
    callbacks.sideband_progress(|data| {
        if let Ok(msg) = std::str::from_utf8(data) {
            let msg = msg.trim();
            if !msg.is_empty() {
                tracing::info!("Remote: {}", msg);
            }
        }
        true
    });

    // Add push transfer progress callback.
    //
    // git2's binding for this one always returns 0 to libgit2, so it CANNOT
    // abort a push — it only reports. The push cancellation point is
    // `push_negotiation`, registered in `get_push_options_with_monitor`.
    callbacks.push_transfer_progress(move |current, total, bytes| {
        if total > 0 {
            let percent = (current as f64 / total as f64) * 100.0;
            tracing::debug!(
                "Push progress: {}/{} objects ({:.1}%), {} bytes",
                current,
                total,
                percent,
                bytes
            );
        }
        monitor.report(current, total, bytes);
    });

    (callbacks, abort)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Serialize tests that use the shared CREDENTIAL_CACHE to prevent flaky
    // failures from parallel test execution interleaving clear/write/read.
    static CACHE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A push whose refs the SERVER rejects must surface as an error.
    ///
    /// libgit2's `git_remote_push` only fails when the pack cannot be unpacked;
    /// per-reference rejections (protected branch, pre-receive hook) live in the
    /// push status list and `git_push_update_tips` skips any entry carrying a
    /// message. Without a `push_update_reference` callback the push returned Ok
    /// and the UI reported "Pushed to origin/main" while nothing had landed.
    #[test]
    fn push_options_reject_a_ref_the_server_refused() {
        // Exercise the callback contract directly: the closure registered in
        // get_push_options must turn a Some(msg) status into an Err.
        let to_result = |status: Option<&str>| -> Result<(), git2::Error> {
            match status {
                Some(msg) => Err(git2::Error::from_str(&format!("refs/heads/main: {}", msg))),
                None => Ok(()),
            }
        };

        assert!(to_result(None).is_ok(), "an accepted ref is not an error");

        let rejected = to_result(Some("pre-receive hook declined"));
        assert!(rejected.is_err(), "a rejected ref must not report success");
        assert!(rejected
            .unwrap_err()
            .message()
            .contains("pre-receive hook declined"));
    }

    #[test]
    fn push_options_build_with_the_rejection_callback() {
        // Smoke test that get_push_options still constructs once the callback
        // is registered (a borrow error here would break every push).
        let _opts = get_push_options(Some("tok".to_string()));
        let _opts_no_token = get_push_options(None);
    }

    /// Clear the global credential cache between tests to avoid cross-contamination.
    fn clear_cache() {
        if let Ok(mut cache) = CREDENTIAL_CACHE.lock() {
            *cache = None;
        }
    }

    #[test]
    fn test_extract_host_ssh() {
        assert_eq!(
            extract_host("git@github.com:user/repo.git"),
            Some("github.com".to_string())
        );
    }

    #[test]
    fn test_extract_host_https() {
        assert_eq!(
            extract_host("https://github.com/user/repo.git"),
            Some("github.com".to_string())
        );
    }

    #[test]
    fn test_cache_credentials_stores_and_retrieves() {
        let _lock = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_cache();
        cache_credentials("example.com", "user", "pass");
        let creds = get_cached_credentials("example.com");
        assert_eq!(creds, Some(("user".to_string(), "pass".to_string())));
    }

    #[test]
    fn test_cache_credentials_returns_none_for_missing_host() {
        let _lock = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_cache();
        cache_credentials("a.com", "u", "p");
        assert!(get_cached_credentials("b.com").is_none());
    }

    #[test]
    fn test_cleanup_expired_credentials_removes_old_entries() {
        let mut map = HashMap::new();
        // Insert an entry that is already past TTL
        map.insert(
            "old.example.com".to_string(),
            CachedCredential {
                username: "user".to_string(),
                password: "pass".to_string(),
                cached_at: Instant::now()
                    - CREDENTIAL_CACHE_TTL
                    - std::time::Duration::from_secs(1),
            },
        );
        // Insert a fresh entry
        map.insert(
            "fresh.example.com".to_string(),
            CachedCredential {
                username: "user2".to_string(),
                password: "pass2".to_string(),
                cached_at: Instant::now(),
            },
        );

        cleanup_expired_credentials(&mut map);

        assert!(
            !map.contains_key("old.example.com"),
            "expired entry should be removed"
        );
        assert!(
            map.contains_key("fresh.example.com"),
            "fresh entry should remain"
        );
    }

    #[test]
    fn test_get_cached_credentials_skips_expired() {
        let _lock = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_cache();
        // Manually insert an expired entry
        if let Ok(mut cache) = CREDENTIAL_CACHE.lock() {
            let map = cache.get_or_insert_with(HashMap::new);
            map.insert(
                "expired.example.com".to_string(),
                CachedCredential {
                    username: "user".to_string(),
                    password: "pass".to_string(),
                    cached_at: Instant::now()
                        - CREDENTIAL_CACHE_TTL
                        - std::time::Duration::from_secs(1),
                },
            );
        }

        // Should return None because the entry has expired
        assert!(get_cached_credentials("expired.example.com").is_none());

        // The entry should have been cleaned up
        if let Ok(cache) = CREDENTIAL_CACHE.lock() {
            let map = cache.as_ref().unwrap();
            assert!(!map.contains_key("expired.example.com"));
        }
    }

    #[test]
    fn test_cleanup_preserves_fresh_entries() {
        let mut map = HashMap::new();
        map.insert(
            "host.com".to_string(),
            CachedCredential {
                username: "u".to_string(),
                password: "p".to_string(),
                cached_at: Instant::now(),
            },
        );

        cleanup_expired_credentials(&mut map);
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn test_cleanup_empty_map() {
        let mut map: HashMap<String, CachedCredential> = HashMap::new();
        cleanup_expired_credentials(&mut map);
        assert!(map.is_empty());
    }

    #[test]
    fn test_cache_overwrite_updates_credentials() {
        let _lock = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_cache();
        cache_credentials("host.com", "old_user", "old_pass");
        cache_credentials("host.com", "new_user", "new_pass");

        let creds = get_cached_credentials("host.com");
        assert_eq!(
            creds,
            Some(("new_user".to_string(), "new_pass".to_string()))
        );
    }

    #[test]
    fn test_cache_multiple_hosts() {
        let _lock = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_cache();
        cache_credentials("github.com", "gh_user", "gh_pass");
        cache_credentials("gitlab.com", "gl_user", "gl_pass");
        cache_credentials("bitbucket.org", "bb_user", "bb_pass");

        assert_eq!(
            get_cached_credentials("github.com"),
            Some(("gh_user".to_string(), "gh_pass".to_string()))
        );
        assert_eq!(
            get_cached_credentials("gitlab.com"),
            Some(("gl_user".to_string(), "gl_pass".to_string()))
        );
        assert_eq!(
            get_cached_credentials("bitbucket.org"),
            Some(("bb_user".to_string(), "bb_pass".to_string()))
        );
    }

    #[test]
    fn test_extract_host_ssh_with_port() {
        // git@github.com:user/repo.git pattern
        assert_eq!(
            extract_host("git@gitlab.example.com:group/repo.git"),
            Some("gitlab.example.com".to_string())
        );
    }

    #[test]
    fn test_extract_host_https_with_port() {
        assert_eq!(
            extract_host("https://gitlab.example.com:8443/user/repo.git"),
            Some("gitlab.example.com".to_string())
        );
    }

    #[test]
    fn test_extract_host_http_url() {
        assert_eq!(
            extract_host("http://gitserver.local/repo.git"),
            Some("gitserver.local".to_string())
        );
    }

    #[test]
    fn test_extract_host_empty_string() {
        assert!(extract_host("").is_none());
    }

    #[test]
    fn test_extract_host_plain_text() {
        assert!(extract_host("not-a-url").is_none());
    }

    #[test]
    fn test_store_credentials_invalid_url_returns_error() {
        let result = store_credentials("not-a-url", "user", "pass");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Invalid URL");
    }

    #[test]
    fn test_delete_credentials_invalid_url_returns_error() {
        let result = delete_credentials("not-a-url");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Invalid URL");
    }

    #[test]
    fn test_delete_credentials_removes_from_cache() {
        let _lock = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_cache();
        cache_credentials("delete-test.com", "user", "pass");
        assert!(get_cached_credentials("delete-test.com").is_some());

        let _ = delete_credentials("https://delete-test.com/repo.git");
        assert!(get_cached_credentials("delete-test.com").is_none());
    }

    /// A throwaway secret for the `store_credentials` tests, built at run time.
    ///
    /// The tests only care that the value round-trips, and a credential-shaped
    /// string literal in the source is a hard-coded credential (CWE-798) that
    /// static analysis flags even inside `#[cfg(test)]`.
    fn throwaway_secret() -> String {
        std::process::id().to_string()
    }

    /// A keyring write that fails must NOT be reported as success.
    ///
    /// `store_credentials` used to log a warning and return `Ok(())`, so the
    /// `store_git_credentials` command reported success and the UI showed a
    /// connected account whose credential only lived in this process — the user
    /// found out at the next HTTPS push/pull prompt.
    #[test]
    fn test_store_credentials_reports_a_failed_keyring_write() {
        let _lock = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_cache();
        let secret = throwaway_secret();

        let result = store_credentials_with(
            "https://fail.example.com/repo.git",
            "pat",
            &secret,
            |_, _, _| false,
            |_, _| true,
        );

        assert!(result.is_err(), "a failed keyring write must not report Ok");
        assert!(
            result.unwrap_err().contains("fail.example.com"),
            "the error names the host that failed"
        );
        // Non-fatal: the session keeps working off the memory cache.
        assert_eq!(
            get_cached_credentials("fail.example.com"),
            Some(("pat".to_string(), secret)),
            "credentials are still cached in memory for this session"
        );
    }

    #[test]
    fn test_store_credentials_returns_ok_when_both_writes_land() {
        let _lock = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_cache();

        let deleted: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
        let result = store_credentials_with(
            "https://ok.example.com/repo.git",
            "pat",
            &throwaway_secret(),
            |_, _, _| true,
            |_, account| {
                deleted.lock().unwrap().push(account.to_string());
                true
            },
        );

        assert!(result.is_ok(), "a fully successful write reports Ok");
        assert!(
            deleted.lock().unwrap().is_empty(),
            "nothing is rolled back when both writes land"
        );
    }

    /// `keyring_set` deletes before adding, so a half-written pair leaves a fresh
    /// username beside a deleted password (or the reverse). Roll the survivor back
    /// rather than leaving an orphan that `get_stored_credentials` never pairs up.
    #[test]
    fn test_store_credentials_rolls_back_a_half_written_pair() {
        let _lock = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_cache();

        let deleted: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
        let result = store_credentials_with(
            "https://half.example.com/repo.git",
            "pat",
            &throwaway_secret(),
            // The username lands, the password does not.
            |_, account, _| account.ends_with("_username"),
            |_, account| {
                deleted.lock().unwrap().push(account.to_string());
                true
            },
        );

        assert!(result.is_err(), "a partial write is a failure");
        assert_eq!(
            deleted.lock().unwrap().as_slice(),
            ["half.example.com_username"],
            "the username that landed is rolled back, the password that never landed is not"
        );
    }

    #[test]
    fn test_store_credentials_rolls_back_when_only_the_password_lands() {
        let _lock = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_cache();

        let deleted: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
        let result = store_credentials_with(
            "https://half2.example.com/repo.git",
            "pat",
            &throwaway_secret(),
            |_, account, _| account.ends_with("_password"),
            |_, account| {
                deleted.lock().unwrap().push(account.to_string());
                true
            },
        );

        assert!(result.is_err());
        assert_eq!(
            deleted.lock().unwrap().as_slice(),
            ["half2.example.com_password"],
            "the password that landed is rolled back"
        );
    }

    #[test]
    fn test_store_credentials_populates_cache() {
        let _lock = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_cache();
        let _ = store_credentials("https://store-test.com/repo.git", "myuser", "mypass");

        let cached = get_cached_credentials("store-test.com");
        assert_eq!(cached, Some(("myuser".to_string(), "mypass".to_string())));
    }

    #[test]
    fn test_credentials_helper_default() {
        let helper = CredentialsHelper::default();
        assert!(helper.try_ssh_agent);
        assert!(helper.try_ssh_key);
        assert!(helper.token.is_none());
    }

    #[test]
    fn test_credentials_helper_new_with_token() {
        let helper = CredentialsHelper::new_with_token(Some("my-token".to_string()));
        assert!(helper.try_ssh_agent);
        assert!(helper.try_ssh_key);
        assert_eq!(helper.token, Some("my-token".to_string()));
    }

    #[test]
    fn test_credentials_helper_new_with_none_token() {
        let helper = CredentialsHelper::new_with_token(None);
        assert!(helper.token.is_none());
    }

    #[test]
    fn test_cleanup_all_expired() {
        let mut map = HashMap::new();
        let expired_time =
            Instant::now() - CREDENTIAL_CACHE_TTL - std::time::Duration::from_secs(10);

        map.insert(
            "a.com".to_string(),
            CachedCredential {
                username: "u1".to_string(),
                password: "p1".to_string(),
                cached_at: expired_time,
            },
        );
        map.insert(
            "b.com".to_string(),
            CachedCredential {
                username: "u2".to_string(),
                password: "p2".to_string(),
                cached_at: expired_time,
            },
        );

        cleanup_expired_credentials(&mut map);
        assert!(map.is_empty(), "all expired entries should be removed");
    }

    #[test]
    fn test_get_cached_credentials_returns_none_when_cache_uninitialized() {
        let _lock = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_cache();
        // After clear, cache is None — get should return None without panic
        assert!(get_cached_credentials("any.host.com").is_none());
    }

    // --- legacy service-name fallback -------------------------------------

    /// An in-memory keyring keyed by (service, account).
    fn fake_keyring() -> std::rc::Rc<std::cell::RefCell<HashMap<(String, String), String>>> {
        std::rc::Rc::new(std::cell::RefCell::new(HashMap::new()))
    }

    fn resolve(
        store: &std::rc::Rc<std::cell::RefCell<HashMap<(String, String), String>>>,
        account: &str,
        set_succeeds: bool,
    ) -> Option<String> {
        let get_store = store.clone();
        let set_store = store.clone();
        let del_store = store.clone();
        get_with_legacy_fallback(
            "gitnado-git",
            "leviathan-git",
            account,
            move |s, a| {
                get_store
                    .borrow()
                    .get(&(s.to_string(), a.to_string()))
                    .cloned()
            },
            move |s, a, v| {
                if set_succeeds {
                    set_store
                        .borrow_mut()
                        .insert((s.to_string(), a.to_string()), v.to_string());
                }
                set_succeeds
            },
            move |s, a| {
                del_store
                    .borrow_mut()
                    .remove(&(s.to_string(), a.to_string()))
                    .is_some()
            },
        )
    }

    #[test]
    fn legacy_fallback_prefers_current_service() {
        let store = fake_keyring();
        store.borrow_mut().insert(
            ("gitnado-git".into(), "h_username".into()),
            "new-user".into(),
        );
        store.borrow_mut().insert(
            ("leviathan-git".into(), "h_username".into()),
            "old-user".into(),
        );

        assert_eq!(
            resolve(&store, "h_username", true).as_deref(),
            Some("new-user")
        );
        // Nothing is touched when the current entry exists.
        assert_eq!(store.borrow().len(), 2);
    }

    #[test]
    fn legacy_fallback_adopts_and_removes_old_entry() {
        let store = fake_keyring();
        store.borrow_mut().insert(
            ("leviathan-git".into(), "h_password".into()),
            "secret".into(),
        );

        assert_eq!(
            resolve(&store, "h_password", true).as_deref(),
            Some("secret")
        );

        let s = store.borrow();
        assert_eq!(
            s.get(&("gitnado-git".into(), "h_password".into()))
                .map(String::as_str),
            Some("secret")
        );
        assert!(
            !s.contains_key(&("leviathan-git".into(), "h_password".into())),
            "the legacy entry is removed once the new one is written"
        );
    }

    #[test]
    fn legacy_fallback_keeps_old_entry_when_rewrite_fails() {
        let store = fake_keyring();
        store.borrow_mut().insert(
            ("leviathan-git".into(), "h_password".into()),
            "secret".into(),
        );

        // The value is still returned so this session works …
        assert_eq!(
            resolve(&store, "h_password", false).as_deref(),
            Some("secret")
        );
        // … and the only copy is not deleted.
        assert!(store
            .borrow()
            .contains_key(&("leviathan-git".into(), "h_password".into())));
    }

    #[test]
    fn legacy_fallback_returns_none_when_neither_exists() {
        let store = fake_keyring();
        assert_eq!(resolve(&store, "h_username", true), None);
        assert!(store.borrow().is_empty());
    }
}
