//! Command utilities for cross-platform process spawning
//!
//! This module provides helpers to create commands that don't show
//! console windows on Windows.
//!
//! Every `git` subprocess in the app goes through [`create_command`], which
//! hands back a [`GitCommand`] rather than a bare [`Command`]. That wrapper is
//! what lets the Output panel show the real `git` invocation together with its
//! stdout/stderr: it times the run and reports it to the sink `lib.rs`
//! installs. Because the wrapper owns `output()`/`status()`, a NEW shell-out is
//! reported automatically — nothing has to be added to a hand-kept list.

use std::ffi::OsStr;
use std::io;
use std::ops::{Deref, DerefMut};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::OnceLock;
use std::time::Instant;

/// One executed `git` invocation, as the Output panel shows it.
///
/// `command` is the effective command line with secrets redacted — see
/// [`redact_secrets`]. Environment variables are deliberately NOT included:
/// the token credential helper reaches git through the ENVIRONMENT (see
/// [`apply_token_credential_helper`]), so leaving env out of this payload is
/// what keeps tokens out of the panel by construction rather than by filtering.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommandLog {
    /// The effective, redacted command line (e.g. `git push --force origin main`)
    pub command: String,
    /// Combined stderr/stdout of the run, redacted and truncated
    pub output: String,
    pub success: bool,
    pub duration_ms: u64,
    /// Repository the command ran in, when it can be determined
    pub repo_path: Option<String>,
}

type LogSink = Box<dyn Fn(GitCommandLog) + Send + Sync + 'static>;

static LOG_SINK: OnceLock<LogSink> = OnceLock::new();

/// Install the sink executed `git` invocations are reported to.
///
/// Called once from `lib.rs` setup with a closure that emits the
/// `git-command-executed` Tauri event. Installing is idempotent: a second call
/// is ignored, so nothing can displace the real sink once the app is running.
pub fn set_git_command_log_sink(sink: impl Fn(GitCommandLog) + Send + Sync + 'static) {
    let _ = LOG_SINK.set(Box::new(sink));
}

/// How much of a command's output is kept. A `git fetch` on a large repo can
/// print megabytes; the panel only needs enough to be readable, and the event
/// crosses the IPC boundary on every command.
const MAX_OUTPUT_CHARS: usize = 8_000;

/// git subcommands whose runs are worth showing in the Output panel.
///
/// An ALLOWLIST rather than a denylist of reads on purpose: the app shells out
/// to `git rev-parse`, `git for-each-ref` and friends constantly, and a
/// denylist that misses one floods the 100-entry panel with noise the user
/// never asked for. `config` and `credential` are deliberately absent — they
/// are plumbing reads, and they are the two subcommands whose arguments are
/// most likely to name a secret.
const LOGGED_SUBCOMMANDS: &[&str] = &[
    "add",
    "am",
    "apply",
    "archive",
    "bisect",
    "branch",
    "bundle",
    "checkout",
    "cherry-pick",
    "clean",
    "clone",
    "commit",
    "difftool",
    "fetch",
    "filter-branch",
    "gc",
    "init",
    "lfs",
    "maintenance",
    "merge",
    "mergetool",
    "mv",
    "notes",
    "prune",
    "pull",
    "push",
    "rebase",
    "reflog",
    "remote",
    "repack",
    "replace",
    "reset",
    "restore",
    "revert",
    "rm",
    "sparse-checkout",
    "stash",
    "submodule",
    "switch",
    "tag",
    "update-index",
    "update-ref",
    "worktree",
];

/// git's own options that take a SEPARATE value argument, so the subcommand
/// scan skips two slots rather than mistaking the value for the subcommand.
const GLOBAL_OPTS_WITH_VALUE: &[&str] = &[
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--exec-path",
    "--config-env",
];

/// The subcommand of a `git` invocation — the first argument that is neither a
/// global option nor a global option's value.
fn git_subcommand(args: &[String]) -> Option<&str> {
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if GLOBAL_OPTS_WITH_VALUE.contains(&arg) {
            i += 2;
        } else if arg.starts_with('-') {
            i += 1;
        } else {
            return Some(arg);
        }
    }
    None
}

/// The repository a `git` invocation targets: its working directory, or the
/// value of a `-C <path>` global option when no working directory is set.
fn git_repo_path(cwd: Option<&Path>, args: &[String]) -> Option<String> {
    if let Some(dir) = cwd {
        return Some(dir.to_string_lossy().to_string());
    }
    args.iter()
        .position(|a| a == "-C")
        .and_then(|i| args.get(i + 1))
        .cloned()
}

/// Quote an argument so the rendered line reads as the tokens git received.
fn quote_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "\"\"".to_string();
    }
    if arg
        .chars()
        .any(|c| c.is_whitespace() || c == '"' || c == '\'' || c == '\\')
    {
        format!("\"{}\"", arg.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        arg.to_string()
    }
}

/// Render a `git` invocation the way a user would type it, with every argument
/// passed through [`redact_secrets`].
fn format_command_line(program: &str, args: &[String]) -> String {
    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push(program.to_string());
    for arg in args {
        parts.push(quote_arg(&redact_secrets(arg)));
    }
    parts.join(" ")
}

/// Patterns for the secrets that can reach a command line or a command's
/// output, compiled once.
///
/// Redaction is a SAFETY NET, not the primary defence: the app's own tokens
/// reach git through the environment and never as arguments, and env is never
/// logged. But a user's own remote URL can carry `user:token@host`, and git
/// echoes remote URLs in its progress and error messages, so everything on its
/// way to the panel is scrubbed.
fn secret_patterns() -> &'static [(regex::Regex, &'static str)] {
    static PATTERNS: OnceLock<Vec<(regex::Regex, &'static str)>> = OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            vec![
                // Credentials embedded in a URL: https://user:token@host,
                // ssh://user@host. The userinfo goes; the host stays so the
                // line still says which remote it was.
                (
                    regex::Regex::new(r"(?i)\b([a-z][a-z0-9+.\-]*://)[^/\s@]+@").unwrap(),
                    "${1}***@",
                ),
                // Provider tokens, by their documented prefixes.
                (
                    regex::Regex::new(r"\bgh[pousr]_[A-Za-z0-9]{16,}").unwrap(),
                    "***",
                ),
                (
                    regex::Regex::new(r"\bgithub_pat_[A-Za-z0-9_]{20,}").unwrap(),
                    "***",
                ),
                (
                    regex::Regex::new(r"\bglpat-[A-Za-z0-9_\-]{16,}").unwrap(),
                    "***",
                ),
                (
                    regex::Regex::new(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}").unwrap(),
                    "***",
                ),
                (regex::Regex::new(r"\bsk-[A-Za-z0-9_\-]{16,}").unwrap(), "***"),
                (regex::Regex::new(r"\bAKIA[0-9A-Z]{16}\b").unwrap(), "***"),
                // JSON Web Tokens (three base64url segments).
                (
                    regex::Regex::new(
                        r"\bey[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",
                    )
                    .unwrap(),
                    "***",
                ),
                // `Bearer <token>` — matched BEFORE the named-secret rule
                // below, which would otherwise consume the word `Bearer` as
                // `Authorization`'s value and leave the token itself standing.
                (
                    regex::Regex::new(r"(?i)\bbearer\s+[A-Za-z0-9._\-+/=]{6,}").unwrap(),
                    "Bearer ***",
                ),
                // Anything explicitly NAMED as a secret, whatever its shape.
                (
                    regex::Regex::new(
                        r"(?i)\b(password|passwd|token|access[_\-]?token|api[_\-]?key|secret|authorization)([=:]\s*|\s+)\S+",
                    )
                    .unwrap(),
                    "${1}=***",
                ),
            ]
        })
        .as_slice()
}

/// Replace anything that looks like a credential with `***`.
///
/// Applied to every command line and every captured output before it leaves
/// the backend, so a credentialed remote URL or a token echoed by git can
/// never reach the Output panel.
pub fn redact_secrets(text: &str) -> String {
    let mut out = text.to_string();
    for (pattern, replacement) in secret_patterns() {
        out = pattern.replace_all(&out, *replacement).into_owned();
    }
    out
}

/// Trim captured output to something the panel can hold, keeping the head.
fn truncate_output(text: &str) -> String {
    if text.chars().count() <= MAX_OUTPUT_CHARS {
        return text.to_string();
    }
    let kept: String = text.chars().take(MAX_OUTPUT_CHARS).collect();
    format!("{}\n… (output truncated)", kept)
}

/// A `Command` that reports its `git` runs to the Output panel.
///
/// Deliberately NOT a bare `Command`: the builder methods return `&mut Self`,
/// so a chained `create_command("git").arg(..).output()` stays on this type and
/// gets reported. `Deref`/`DerefMut` still expose everything else on `Command`
/// (`get_args`, `get_envs`, platform extension traits) and let a
/// `&mut GitCommand` be passed wherever a `&mut Command` is expected.
pub struct GitCommand {
    inner: Command,
    /// Only `git` invocations are reported; `ssh`, `gpg`, `where`/`which` and
    /// friends are not git commands and have no place in a panel of them.
    is_git: bool,
}

impl GitCommand {
    pub fn arg<S: AsRef<OsStr>>(&mut self, arg: S) -> &mut Self {
        self.inner.arg(arg);
        self
    }

    pub fn args<I, S>(&mut self, args: I) -> &mut Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.inner.args(args);
        self
    }

    pub fn env<K, V>(&mut self, key: K, val: V) -> &mut Self
    where
        K: AsRef<OsStr>,
        V: AsRef<OsStr>,
    {
        self.inner.env(key, val);
        self
    }

    pub fn envs<I, K, V>(&mut self, vars: I) -> &mut Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<OsStr>,
        V: AsRef<OsStr>,
    {
        self.inner.envs(vars);
        self
    }

    pub fn env_remove<K: AsRef<OsStr>>(&mut self, key: K) -> &mut Self {
        self.inner.env_remove(key);
        self
    }

    pub fn env_clear(&mut self) -> &mut Self {
        self.inner.env_clear();
        self
    }

    pub fn current_dir<P: AsRef<Path>>(&mut self, dir: P) -> &mut Self {
        self.inner.current_dir(dir);
        self
    }

    pub fn stdin<S: Into<Stdio>>(&mut self, cfg: S) -> &mut Self {
        self.inner.stdin(cfg);
        self
    }

    pub fn stdout<S: Into<Stdio>>(&mut self, cfg: S) -> &mut Self {
        self.inner.stdout(cfg);
        self
    }

    pub fn stderr<S: Into<Stdio>>(&mut self, cfg: S) -> &mut Self {
        self.inner.stderr(cfg);
        self
    }

    /// The redacted command line for this invocation and the repository it
    /// runs in, or `None` when it is not a git subcommand worth showing.
    fn loggable_command_line(&self) -> Option<(String, Option<String>)> {
        if !self.is_git {
            return None;
        }
        let args: Vec<String> = self
            .inner
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let subcommand = git_subcommand(&args)?;
        if !LOGGED_SUBCOMMANDS.contains(&subcommand) {
            return None;
        }
        let program = self.inner.get_program().to_string_lossy().to_string();
        Some((
            format_command_line(&program, &args),
            git_repo_path(self.inner.get_current_dir(), &args),
        ))
    }

    fn report(&self, started: Instant, output: String, success: bool) {
        let Some(sink) = LOG_SINK.get() else {
            return;
        };
        let Some((command, repo_path)) = self.loggable_command_line() else {
            return;
        };
        sink(GitCommandLog {
            command,
            output: truncate_output(&redact_secrets(output.trim())),
            success,
            duration_ms: started.elapsed().as_millis() as u64,
            repo_path,
        });
    }

    /// Run to completion capturing output, reporting the run to the panel.
    pub fn output(&mut self) -> io::Result<Output> {
        let started = Instant::now();
        let result = self.inner.output();
        match &result {
            Ok(out) => {
                // stderr first: git puts progress and the failure reason there,
                // which is what a user opening the panel is looking for.
                let stderr = String::from_utf8_lossy(&out.stderr);
                let stdout = String::from_utf8_lossy(&out.stdout);
                let combined = match (stderr.trim().is_empty(), stdout.trim().is_empty()) {
                    (true, true) => String::new(),
                    (true, false) => stdout.to_string(),
                    (false, true) => stderr.to_string(),
                    (false, false) => format!("{}\n{}", stderr.trim_end(), stdout),
                };
                self.report(started, combined, out.status.success());
            }
            Err(e) => self.report(started, e.to_string(), false),
        }
        result
    }

    /// Run to completion with inherited stdio. Nothing is captured, so the
    /// panel entry carries the command and its exit status only.
    pub fn status(&mut self) -> io::Result<ExitStatus> {
        let started = Instant::now();
        let result = self.inner.status();
        match &result {
            Ok(status) => self.report(started, String::new(), status.success()),
            Err(e) => self.report(started, e.to_string(), false),
        }
        result
    }

    /// Start the process without waiting for it. The outcome is unknown here,
    /// so nothing is reported — a caller that drives the child itself should
    /// call [`GitCommand::report_run`] once it has the result.
    pub fn spawn(&mut self) -> io::Result<Child> {
        self.inner.spawn()
    }

    /// Report a run this command performed OUTSIDE `output()`/`status()`.
    ///
    /// Two callers spawn the child themselves so a cancellation can kill it
    /// mid-transfer: `remote::run_push_command` and
    /// `repository::run_clone_command`. Without this hook the operations users
    /// most want to read in the panel — a force push and the remote's rejection
    /// of it, a shallow clone and why it failed — would be the ones that never
    /// appear. Both call it on success AND on a non-zero exit, never on
    /// cancel/timeout.
    pub fn report_run(&self, started: Instant, output: &Output) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let combined = match (stderr.trim().is_empty(), stdout.trim().is_empty()) {
            (true, true) => String::new(),
            (true, false) => stdout.to_string(),
            (false, true) => stderr.to_string(),
            (false, false) => format!("{}\n{}", stderr.trim_end(), stdout),
        };
        self.report(started, combined, output.status.success());
    }
}

impl Deref for GitCommand {
    type Target = Command;

    fn deref(&self) -> &Command {
        &self.inner
    }
}

impl DerefMut for GitCommand {
    fn deref_mut(&mut self) -> &mut Command {
        &mut self.inner
    }
}

/// Creates a Command with platform-specific settings to hide console windows.
///
/// On Windows, this sets the CREATE_NO_WINDOW flag to prevent CMD popups.
/// On other platforms, it returns a standard Command.
pub fn create_command(program: &str) -> GitCommand {
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

    GitCommand {
        inner: cmd,
        is_git: program == "git",
    }
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

    cmd.env("LEVIATHAN_GIT_TOKEN", token);
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
        "!f() { echo username=git; echo \"password=$LEVIATHAN_GIT_TOKEN\"; }; f",
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Output panel: which invocations are reported -------------------

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// The subcommand has to be found past git's own global options, or a
    /// `git -C <path> push` would be filed under the path.
    #[test]
    fn test_git_subcommand_skips_global_options_and_their_values() {
        assert_eq!(git_subcommand(&args(&["push", "origin"])).unwrap(), "push");
        assert_eq!(
            git_subcommand(&args(&["-C", "/repo", "commit", "-m", "x"])).unwrap(),
            "commit"
        );
        assert_eq!(
            git_subcommand(&args(&["-c", "core.pager=cat", "--no-pager", "rebase"])).unwrap(),
            "rebase"
        );
        assert!(git_subcommand(&args(&["--version"])).is_none());
        assert!(git_subcommand(&[]).is_none());
    }

    /// Reads must not reach the panel: they run constantly and would push every
    /// real operation out of the 100-entry buffer.
    #[test]
    fn test_only_mutating_subcommands_are_reported() {
        for mutating in ["push", "commit", "rebase", "difftool", "lfs", "stash"] {
            assert!(
                LOGGED_SUBCOMMANDS.contains(&mutating),
                "{mutating} should be reported"
            );
        }
        for read in [
            "rev-parse",
            "log",
            "status",
            "for-each-ref",
            "config",
            "ls-remote",
        ] {
            assert!(
                !LOGGED_SUBCOMMANDS.contains(&read),
                "{read} should not be reported"
            );
        }
    }

    #[test]
    fn test_git_repo_path_prefers_the_working_directory_then_dash_c() {
        assert_eq!(
            git_repo_path(Some(Path::new("/work/repo")), &args(&["status"])).as_deref(),
            Some("/work/repo")
        );
        assert_eq!(
            git_repo_path(None, &args(&["-C", "/other/repo", "push"])).as_deref(),
            Some("/other/repo")
        );
        assert!(git_repo_path(None, &args(&["push"])).is_none());
    }

    /// A commit message with spaces has to survive as ONE token, or the panel
    /// line reads as a completely different command.
    #[test]
    fn test_format_command_line_quotes_multiword_arguments() {
        assert_eq!(
            format_command_line("git", &args(&["commit", "-m", "fix the thing"])),
            "git commit -m \"fix the thing\""
        );
        assert_eq!(
            format_command_line("git", &args(&["push", "--force", "origin", "main"])),
            "git push --force origin main"
        );
    }

    /// A real invocation, end to end: the wrapper must render exactly what it
    /// is about to run.
    #[test]
    fn test_loggable_command_line_renders_the_effective_invocation() {
        let mut cmd = create_command("git");
        cmd.current_dir("/work/repo")
            .arg("push")
            .args(["--force-with-lease", "origin", "main"]);

        let (line, repo) = cmd.loggable_command_line().expect("push is reported");
        assert_eq!(line, "git push --force-with-lease origin main");
        assert_eq!(repo.as_deref(), Some("/work/repo"));
    }

    /// Non-git programs (ssh, gpg, which) are not git invocations and must
    /// never appear in a panel of them.
    #[test]
    fn test_non_git_programs_are_never_reported() {
        let mut cmd = create_command("ssh");
        cmd.arg("push");
        assert!(cmd.loggable_command_line().is_none());
    }

    #[test]
    fn test_read_only_git_invocations_are_not_reported() {
        let mut cmd = create_command("git");
        cmd.args(["rev-parse", "HEAD"]);
        assert!(cmd.loggable_command_line().is_none());
    }

    // ---- Output panel: redaction ---------------------------------------

    /// The single most likely leak: a user's own remote URL with the token
    /// baked into it, which git echoes back in its progress and error output.
    #[test]
    fn test_redact_secrets_strips_credentials_from_remote_urls() {
        assert_eq!(
            redact_secrets("git push https://someone:ghp_abcdefghijklmnopqrst@github.com/o/r.git"),
            "git push https://***@github.com/o/r.git"
        );
        assert_eq!(
            redact_secrets("remote: https://x-access-token:v1.9f8e7d@github.com/o/r"),
            "remote: https://***@github.com/o/r"
        );
        // The host must SURVIVE — the entry is useless if it cannot say which
        // remote was involved.
        assert!(
            redact_secrets("https://u:p@gitlab.example.com/g/r.git").contains("gitlab.example.com")
        );
    }

    /// A URL with no userinfo is not a secret and must be left readable.
    #[test]
    fn test_redact_secrets_leaves_plain_urls_alone() {
        assert_eq!(
            redact_secrets("git fetch https://github.com/owner/repo.git"),
            "git fetch https://github.com/owner/repo.git"
        );
        assert_eq!(
            redact_secrets("git commit -m \"fix login for user@example.com\""),
            "git commit -m \"fix login for user@example.com\""
        );
    }

    /// Bare provider tokens, wherever they turn up.
    #[test]
    fn test_redact_secrets_strips_bare_provider_tokens() {
        for secret in [
            "ghp_0123456789abcdefghij",
            "gho_0123456789abcdefghij",
            "github_pat_11ABCDEFG0abcdefghijklmnop",
            "glpat-abcdefghij0123456789",
            "xoxb-1234567890-abcdefghij",
            "sk-abcdefghijklmnopqrstuvwx",
            "AKIAIOSFODNN7EXAMPLE",
        ] {
            let redacted = redact_secrets(&format!("failed with {secret} here"));
            assert!(
                !redacted.contains(secret),
                "{secret} survived redaction: {redacted}"
            );
        }
    }

    #[test]
    fn test_redact_secrets_strips_jwts_and_named_secrets() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
        assert!(!redact_secrets(jwt).contains(jwt));

        assert!(!redact_secrets("--password=hunter2").contains("hunter2"));
        assert!(!redact_secrets("Authorization: Bearer abc123def").contains("abc123def"));
        assert!(!redact_secrets("api_key=abcd1234").contains("abcd1234"));
        assert!(!redact_secrets("token: s3cr3tvalue").contains("s3cr3tvalue"));
    }

    /// Redaction happens while the line is BUILT, so a credentialed URL cannot
    /// reach the panel even for a command that legitimately takes one.
    #[test]
    fn test_command_line_redacts_a_credentialed_url_argument() {
        let mut cmd = create_command("git");
        cmd.args([
            "remote",
            "add",
            "origin",
            "https://user:ghp_abcdefghijklmnopqrst@github.com/o/r.git",
        ]);

        let (line, _) = cmd.loggable_command_line().expect("remote is reported");
        assert!(!line.contains("ghp_"), "token survived: {line}");
        assert!(!line.contains("user:"), "userinfo survived: {line}");
        assert!(line.contains("github.com/o/r.git"));
    }

    /// Output is capped so one noisy fetch cannot ship megabytes over IPC.
    #[test]
    fn test_truncate_output_caps_long_output() {
        let long = "x".repeat(MAX_OUTPUT_CHARS + 500);
        let truncated = truncate_output(&long);
        assert!(truncated.len() < long.len());
        assert!(truncated.ends_with("(output truncated)"));
        assert_eq!(truncate_output("short"), "short");
    }

    /// The wrapper must still behave like a Command: run the process and hand
    /// back its real output.
    #[test]
    fn test_git_command_still_runs_and_captures_output() {
        let out = create_command("git")
            .args(["--version"])
            .output()
            .expect("git must be installed for the test suite");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).starts_with("git version"));
    }

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
            envs.get("LEVIATHAN_GIT_TOKEN").map(String::as_str),
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
        assert!(!keys.iter().any(|k| k == "LEVIATHAN_GIT_TOKEN"));
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
            envs.get("LEVIATHAN_GIT_TOKEN").map(String::as_str),
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
        assert!(!keys.iter().any(|k| k == "LEVIATHAN_GIT_TOKEN"));
    }
}
