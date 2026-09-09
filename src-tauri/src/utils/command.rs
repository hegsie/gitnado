//! Command utilities for cross-platform process spawning
//!
//! This module provides helpers to create commands that don't show
//! console windows on Windows.
//!
//! Every `git` subprocess that performs a USER OPERATION goes through
//! [`create_command`], which hands back a [`GitCommand`] rather than a bare
//! [`Command`]. That wrapper is what lets the Output panel show the real `git`
//! invocation together with its stdout/stderr: it times the run and reports it
//! to the sink `lib.rs` installs. Because the wrapper owns
//! `output()`/`status()`, a NEW shell-out is reported automatically — nothing
//! has to be added to a hand-kept list.
//!
//! The invariant is deliberately narrower than "every git subprocess". A
//! handful of sites still spawn a bare `Command`, and
//! `test_the_header_names_every_bare_git_command_site` keeps this list and the
//! code in step:
//!
//! - `search.rs`, `advanced_search.rs`, `workspace.rs` — the `git grep`,
//!   `git log` and `git diff` behind the search panes.
//! - `describe.rs` — `git describe`.
//! - `repository.rs` — `git ls-files`.
//! - `ai.rs` — the AI helpers' `git reflog`, `git log` and `git diff --stat`.
//! - `credentials.rs` — `detect_credential_manager`'s probes,
//!   `git credential-manager --version` and `git config --get
//!   credential.helper`.
//! - `merge.rs` — `preview_rebase`.
//!
//! Every one of those but `merge.rs` is a pure READ that parses its own stdout
//! rather than showing it and changes nothing. Most could not reach the panel
//! in any case: `grep`, `log`, `diff`, `describe`, `ls-files`, `config` and
//! `credential-manager` are absent from [`LOGGED_SUBCOMMANDS`]. `ai.rs`'s
//! `git reflog` is the exception that proves the rule — `reflog` IS logged, and
//! what keeps that listing off the panel is [`is_read_only_form`], not the
//! allowlist. `test_a_bare_git_command_site_can_never_reach_the_panel` checks
//! that for every site rather than trusting this paragraph.
//!
//! `merge.rs` is a real exception, not a read. `preview_rebase` spawns SIX bare
//! commands. Two are writes to the PRIMARY repository: it OBTAINS its throwaway
//! checkout with `git worktree add --detach` and gives it back with `git
//! worktree remove --force`, both `-C <the user's repository>`, so both touch
//! `<repo>/.git/worktrees/`. Two mutate only the throwaway tree: the ghost
//! `git rebase` and, on failure, `git rebase --abort` (which parses nothing —
//! `let _ = …output()`), both `-C <the temp checkout>`. The remaining two are
//! reads, and they read DIFFERENT trees: `git diff --name-only
//! --diff-filter=U -z` asks the temp checkout which paths are unmerged, while
//! `git log --oneline` counts `{onto}..HEAD` in the USER'S repository. Neither
//! subcommand is in [`LOGGED_SUBCOMMANDS`].
//!
//! The four that write belong on [`create_command`]. They are still bare only
//! because the command has no caller today — `previewRebase` in
//! `git.service.ts` is unwired — and because moving them while
//! `add_worktree`/`remove_worktree` name `worktree` as their claimable
//! subcommand would let a ghost worktree's row replace a real worktree
//! operation's in the panel. Wiring `preview_rebase` up means moving them
//! first.
//!
//! `advanced_search.rs` builds a `Command` and hands it to `execute_git_log`,
//! so its three spawns run outside the function that assembles them. That is
//! the ONLY file whose builder escapes its own statement; the scan cannot read
//! such a site's arguments, so it is acknowledged here by name rather than
//! silently passed.
//!
//! Reads that DO come through here (because they share a helper with a write)
//! are filtered out by [`is_read_only_form`] instead, so a `git worktree list`
//! never masquerades as an executed operation.
//!
//! The NUMBERS the two paragraphs above state — the six spawns, the four of
//! them that write, the three whose builders escape their function — are read
//! back out of this prose by
//! `test_a_bare_git_command_site_can_never_reach_the_panel` and pinned to what
//! the code does. Keyed on the file and the form alone, an exemption also
//! covers the NEXT spawn added to that file in that form, and those are the
//! files where such a spawn gets written: a seventh bare command in
//! `merge.rs`, or a fourth escaping builder, has to be justified by editing
//! the sentence that exempts it, not merely written.

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

/// Whether this invocation of a reported subcommand is one of its READ-ONLY
/// forms — a listing or a probe that shares a subcommand (and usually a helper
/// function) with the writes the panel exists to show.
///
/// The allowlist above is keyed by subcommand, and `lfs`, `worktree`,
/// `submodule`, `bisect` and `bundle` each carry both kinds: `git worktree
/// list --porcelain` runs every time the Worktrees dialog opens, `git lfs
/// version` twice per LFS-dialog open — and with no working directory, so it
/// landed in EVERY repository's panel. Worse than noise: such a run has no
/// pending IPC operation, so on the frontend it took the late-claim path and
/// could replace a real operation's row. `rest` is everything after the
/// subcommand.
fn is_read_only_form(subcommand: &str, rest: &[String]) -> bool {
    let positional: Vec<&str> = rest
        .iter()
        .map(String::as_str)
        .filter(|a| !a.starts_with('-'))
        .collect();
    let first = positional.first().copied();
    match subcommand {
        // `git lfs track` with no pattern lists the tracked patterns; with one
        // it rewrites .gitattributes.
        "lfs" => {
            matches!(
                first,
                Some("version" | "env" | "ls-files" | "status" | "locks")
            ) || (first == Some("track") && positional.len() == 1)
        }
        "worktree" => first == Some("list"),
        "submodule" => matches!(first, Some("status" | "summary")),
        "bisect" => matches!(first, Some("log" | "visualize" | "view")),
        "bundle" => first == Some("list-heads"),
        "sparse-checkout" => first == Some("list"),
        "stash" => matches!(first, Some("list" | "show")),
        "remote" => first.is_none() || matches!(first, Some("show" | "get-url")),
        "reflog" => first.is_none() || first == Some("show"),
        // `git archive` with no output file streams the archive to stdout —
        // the way the archive dialog lists what an export would contain.
        "archive" => !rest
            .iter()
            .any(|a| a == "-o" || a == "--output" || a.starts_with("--output=")),
        _ => false,
    }
}

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
/// global option nor a global option's value — and its position in `args`.
fn git_subcommand_at(args: &[String]) -> Option<(usize, &str)> {
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if GLOBAL_OPTS_WITH_VALUE.contains(&arg) {
            i += 2;
        } else if arg.starts_with('-') {
            i += 1;
        } else {
            return Some((i, arg));
        }
    }
    None
}

/// The subcommand of a `git` invocation, see [`git_subcommand_at`].
#[cfg(test)]
fn git_subcommand(args: &[String]) -> Option<&str> {
    git_subcommand_at(args).map(|(_, subcommand)| subcommand)
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
        let (at, subcommand) = git_subcommand_at(&args)?;
        if !LOGGED_SUBCOMMANDS.contains(&subcommand) {
            return None;
        }
        if is_read_only_form(subcommand, &args[at + 1..]) {
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

            // And from the developer's (or CI container's) real EDITOR. This
            // container exports GIT_EDITOR=true, which git prefers over
            // core.editor, so a test proving that a command supplies its own
            // GIT_EDITOR could not fail even once the command stopped doing
            // so. The test that covered exactly that used to scrub the
            // variables with `std::env::remove_var` — process-global state,
            // mutated while 2959 tests run in parallel, and on macOS a
            // concurrent unsetenv/getenv (libgit2 reads GIT_* constantly, from
            // outside std's env lock) corrupted the environ block and aborted
            // the whole harness with no message. Removing them per child is
            // the same isolation without the race; a caller that sets
            // GIT_EDITOR does so with `.env` after this factory, which wins.
            cmd.env_remove("GIT_EDITOR");
            cmd.env_remove("VISUAL");
            cmd.env_remove("EDITOR");
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

/// Test-only view of what the Output panel would have been told.
///
/// The sink is a process-wide `OnceLock`, so a test cannot install its own;
/// instead the first test that asks installs ONE recorder and every later one
/// shares it. Tests therefore filter the recording by their own repository
/// path (unique per `TestRepo`), or assert the absence of a line that no test
/// may produce once the fix under test is in place.
#[cfg(test)]
pub(crate) mod test_sink {
    use super::{set_git_command_log_sink, GitCommandLog};
    use std::sync::Mutex;

    static RECORDED: Mutex<Vec<GitCommandLog>> = Mutex::new(Vec::new());

    /// Install the recorder. Idempotent, and a no-op once any sink is set —
    /// so it must be called BEFORE the invocation a test wants to observe.
    pub(crate) fn install() {
        set_git_command_log_sink(|entry| {
            RECORDED
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(entry);
        });
    }

    /// Every reported invocation so far, across all tests in the binary.
    pub(crate) fn recorded() -> Vec<GitCommandLog> {
        RECORDED.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The reported invocations attributed to `repo_path`.
    pub(crate) fn recorded_for(repo_path: &str) -> Vec<GitCommandLog> {
        recorded()
            .into_iter()
            .filter(|entry| entry.repo_path.as_deref() == Some(repo_path))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Output panel: which invocations are reported -------------------

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// One production site that spawns `git` outside [`create_command`].
    #[derive(Debug)]
    struct BareSite {
        /// Path relative to `src/`, e.g. `commands/merge.rs`.
        file: String,
        /// 1-based line of the spawn.
        line: usize,
        /// The string literals of the builder chain, in order.
        argv: Vec<String>,
        /// Whether the scan actually reached this spawn's `.output()`/
        /// `.status()`/`.spawn(`. A site whose builder is handed to a helper
        /// ends without one, and its arguments may be built out of this
        /// function's sight.
        terminated: bool,
        /// Whether an argument was DROPPED because the source does not spell
        /// it out — a macro assembles it (`format!("{}", sub)`) or, far
        /// commoner, it is a variable (`.arg(&action)`, `.args(&refs)`) — so
        /// `argv` is incomplete. When such a word could be the subcommand the
        /// site counts as unterminated instead (see above), but one AFTER a
        /// literal subcommand still hides the FORM — and the form is what
        /// [`is_read_only_form`] judges, so a `git remote <action>` would read
        /// as the argument-less listing.
        unread_argument: bool,
    }

    /// The last path segment of a site's file, e.g. `merge.rs`.
    ///
    /// The exemptions below are keyed on this and must compare it WHOLE:
    /// `ends_with("merge.rs")` also matches `auto_merge.rs`, and
    /// `contains("search.rs")` also matches `advanced_search.rs`, so a suffix
    /// test hands a brand-new file another file's exemption.
    fn file_name(path: &str) -> &str {
        path.rsplit('/').next().expect("a file name")
    }

    /// The byte offsets at which `name` occurs in `code` as a WHOLE
    /// identifier.
    ///
    /// Matched as a bare substring instead, a binding called `cmd` is also
    /// found inside `cmd_cache`, `cmdline` and `second_cmd` — and a line that
    /// merely CONTAINS the name was enough to credit that line's `.output()`
    /// to the builder. The site was then judged on a PREFIX of its arguments:
    /// one reading `worktree list` before the break and running `push
    /// --force` after it passed as the read-only listing.
    fn identifier_positions(code: &str, name: &str) -> Vec<usize> {
        fn boundary(c: Option<char>) -> bool {
            !c.is_some_and(|c| c.is_alphanumeric() || c == '_')
        }
        code.match_indices(name)
            .filter(|(at, _)| {
                boundary(code[..*at].chars().next_back())
                    && boundary(code[at + name.len()..].chars().next())
            })
            .map(|(at, _)| at)
            .collect()
    }

    /// The ONE `//!` paragraph of the header containing `anchor`, or `None`
    /// when the anchor is absent or occurs more than once.
    ///
    /// Both the exempted FORMS and the counts that cap them are read out of
    /// the paragraph that GRANTS the exemption, so the two are scoped
    /// identically. Read out of the whole header instead, the FIRST occurrence
    /// of a phrase wins, and a paragraph of unrelated narrative added anywhere
    /// above it ("historically these files held seven bare commands, of which
    /// five that write belong on the wrapper") raised every cap without
    /// touching a single word of the sentence that claims the exemption is
    /// safe. Refusing an ambiguous anchor rather than picking the first is
    /// what makes that edit fail here instead of passing.
    fn header_paragraph<'a>(header: &'a str, anchor: &str) -> Option<&'a str> {
        const BREAK: &str = "\n//!\n";
        let at = header.find(anchor)?;
        if header[at + anchor.len()..].contains(anchor) {
            return None;
        }
        let start = header[..at].rfind(BREAK).map_or(0, |b| b + BREAK.len());
        let end = header[at..].find(BREAK).map_or(header.len(), |b| at + b);
        Some(&header[start..end])
    }

    /// A count the module header spells out in words — the `SIX` in "spawns
    /// SIX bare commands" — read out of the prose that justifies an exemption
    /// rather than duplicated here as a magic number.
    ///
    /// Every exemption below is capped by one of these. Keyed on file and form
    /// alone, an exemption silently covers the NEXT spawn added to that file
    /// in that form — and it is exactly the file where such a spawn gets
    /// written. Capped by the header's own count, adding one means editing the
    /// sentence that claims the exemption is safe.
    ///
    /// `scope` is that sentence's own paragraph (see [`header_paragraph`]),
    /// never the whole header, and the phrase must occur EXACTLY ONCE inside
    /// it: an ambiguous read returns `None`, which fails every assertion that
    /// uses it rather than quietly taking whichever number came first.
    fn declared_count(scope: &str, phrase: &str) -> Option<usize> {
        const WORDS: [&str; 11] = [
            "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
        ];
        // Read as prose, not line by line: rustfmt wraps these sentences, and
        // "spawns SIX bare commands" is split across two `//!` lines.
        let prose = scope
            .lines()
            .map(|line| line.trim_start_matches("//!").trim())
            .collect::<Vec<_>>()
            .join(" ");
        let (before, after) = prose.split_once(phrase)?;
        if after.contains(phrase) {
            return None;
        }
        before
            .split_whitespace()
            .next_back()
            .and_then(|word| WORDS.iter().position(|w| w.eq_ignore_ascii_case(word)))
    }

    /// `line` with its `/* … */` comments removed, honouring one left open by
    /// an earlier line, plus whether a comment is still open after it.
    ///
    /// A `/*` inside a string literal opens nothing — the same quote-parity
    /// reading the `//` strip uses — so a literal argument that contains one
    /// is not mistaken for the start of a comment and its own words dropped.
    fn strip_block_comments(line: &str, open: bool) -> (String, bool) {
        let mut visible = String::new();
        let mut rest = line;
        let mut open = open;
        loop {
            if open {
                match rest.find("*/") {
                    Some(at) => rest = &rest[at + "*/".len()..],
                    None => return (visible, true),
                }
                open = false;
                continue;
            }
            let Some(at) = rest.find("/*") else {
                visible.push_str(rest);
                return (visible, false);
            };
            visible.push_str(&rest[..at]);
            rest = &rest[at + "/*".len()..];
            if visible.matches('"').count().is_multiple_of(2) {
                open = true;
            } else {
                // Inside a string literal: not a comment, so put it back.
                visible.push_str("/*");
            }
        }
    }

    /// Every production `Command::new("git")` under `src/`.
    ///
    /// Recursive on purpose: an earlier version read only `src/commands/*.rs`,
    /// so a bare spawn added under `services/`, `utils/` or `ai/` would have
    /// been invisible to both tests below while the header's claim is written
    /// without any such scope.
    fn bare_git_command_sites() -> Vec<BareSite> {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).expect("a source directory") {
                let path = entry.expect("a directory entry").path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                    out.push(path);
                }
            }
        }

        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        walk(&src, &mut files);
        files.sort();

        let mut sites = Vec::new();
        for path in files {
            let relative = path
                .strip_prefix(&src)
                .expect("under src")
                .to_string_lossy()
                .replace('\\', "/");
            // This file's own tests quote the literal they scan for, but the
            // `mod tests` filter below already excludes those — and skipping
            // the whole file is the same exemption-by-file shape that was
            // hiding a second mutating spawn in `merge.rs`. Only the wrapper's
            // own `Command::new(program)` lives here, and that is not the
            // literal being scanned for.
            let source = std::fs::read_to_string(&path).expect("a source file");
            sites.extend(scan_source(&relative, &source));
        }
        sites
    }

    /// The bare `git` spawns in ONE source file.
    ///
    /// Split out from the walk above so the SHAPES this scan has to read —
    /// a call whose parenthesis wrapped, an unrelated statement that merely
    /// names the binding, a block comment, a spawn inside an `impl`, a test
    /// module whose brace carries a trailing comment — can be tested
    /// directly. Read only against the tree, every one of them is judged by
    /// whatever the tree happens to contain today, and each was a silent
    /// pass until someone thought to write it out.
    fn scan_source(relative: &str, source: &str) -> Vec<BareSite> {
        let lines: Vec<&str> = source.lines().collect();
        let mut sites = Vec::new();

        // rustfmt puts a top-level test module and its closing brace at
        // column 0, which tells test scaffolding apart from production.
        // The `#[cfg(test)]` above it is what makes it scaffolding at all:
        // a module that merely happens to be CALLED `tests` is compiled
        // into the shipped binary, so skipping it on the name alone hides
        // a production spawn. All 116 of this crate's test modules carry
        // the attribute on the line directly above.
        let mut in_tests = false;
        for (index, line) in lines.iter().enumerate() {
            if *line == "mod tests {" && index > 0 && lines[index - 1].trim() == "#[cfg(test)]" {
                in_tests = true;
                continue;
            }
            if in_tests {
                // Its closing brace, not the literal line `}`: written
                // `} // end of tests` the module never closed, and every
                // production spawn BELOW it in the file was skipped in
                // silence — the one direction this scan must never fail
                // in.
                if line.starts_with('}') {
                    in_tests = false;
                }
                continue;
            }
            // `Command::new( "git" )` is the same spawn, and so is one whose
            // argument rustfmt wrapped onto the next line: matched as one
            // fixed string, either made the site INVISIBLE rather than merely
            // unreadable — the one direction this scan must never fail in.
            // What follows the paren decides, which also reads
            // `Command::new("git".to_string())`.
            let spawns_git = line.match_indices("Command::new(").any(|(at, needle)| {
                let after = line[at + needle.len()..].trim_start();
                if after.is_empty() {
                    // Wrapped: the program is the next line's first word.
                    lines[index + 1..]
                        .iter()
                        .map(|next| next.trim())
                        .find(|next| !next.is_empty())
                        .is_some_and(|next| next.starts_with("\"git\""))
                } else {
                    after.starts_with("\"git\"")
                }
            });
            if !spawns_git {
                continue;
            }

            // Collect the builder's literals. Two shapes occur, and both
            // have caught this scanner out. A chained
            // `let x = Command::new("git").arg(..).output()` ends at the
            // terminator. A `let mut cmd = Command::new("git");` followed by
            // separate `cmd.arg(..)` statements does not: reading to a fixed
            // line count swallowed unrelated literals from whatever followed
            // (once, strings from `mod tests`), and breaking at the first
            // `;` stopped before the subcommand — `describe.rs`'s
            // `cmd.current_dir(&path);` sits between the spawn and its
            // `cmd.arg("describe")`, so the site was read as taking no
            // arguments at all and waved through unchecked.
            //
            // So: follow the BINDING. Lines that mention it contribute their
            // literals; anything else is skipped, and the terminator ends it.
            // Which shape this is: a spawn line that ends the statement is
            // the `let mut cmd = …;` form and the arguments arrive later
            // through the binding; anything else is a chain whose own
            // continuation lines carry them.
            let binding = line
                .trim_end()
                .ends_with(';')
                .then(|| {
                    line.split_once("let ")
                        .map(|(_, rest)| rest.trim_start_matches("mut "))
                        .and_then(|rest| rest.split_once('='))
                        .map(|(name, _)| name.trim().to_string())
                        .filter(|name| {
                            !name.is_empty()
                                && name.chars().all(|c| c.is_alphanumeric() || c == '_')
                        })
                })
                .flatten();

            let mut argv: Vec<String> = Vec::new();
            // Set while the last literal read was a global option that
            // takes a SEPARATE value (`-C`, `-c`, `--git-dir`, …), so the
            // unreadable word that follows is a path or a config pair —
            // not an argument whose FORM anything here judges.
            let mut expects_option_value = false;
            // Set once a literal has been read that is neither a global
            // option nor a global option's VALUE — that is, once the
            // subcommand slot has been filled. Asking `argv` instead
            // ("does any token not start with `-`?") answered yes for a
            // global option's value, so `git -c credential.helper=`
            // followed by a subcommand this scan cannot read counted as a
            // site whose subcommand HAD been read: the unreadable word was
            // not treated as opaque and the site passed unjudged while
            // running whatever that word held. `git_subcommand_at` — this
            // crate's production answer to the same question — skips those
            // values, and so does this.
            let mut subcommand_read = false;
            // A statement that names the binding may CONTINUE onto chained
            // lines that do not — `cmd.arg("-C")` then `.arg(&path)` then
            // `.arg("log")`. Crediting only lines containing the name read
            // the first of those and skipped the rest, so nine of this
            // crate's spawns were judged without their subcommand ever
            // being seen.
            let mut in_statement = false;
            // The window ends at the enclosing block, not after a fixed
            // line count: three sites hand their builder to a helper, so
            // the terminator is in another function entirely and a fixed
            // window ran past the end and collected the NEXT function's
            // arguments — one command's argv attributed to another site.
            //
            // Which brace closes that block is a question about INDENT,
            // not about column 0. Read as the first line `}` at column
            // zero, a spawn inside an `impl` ran on past the end of its
            // own method to the end of the impl: the NEXT method's
            // `.arg("list")` joined this site's `argv` and its
            // `cmd.output()` marked this site terminated, so a builder
            // handed out of its function — which has to be acknowledged
            // in the header — read as a self-contained `git worktree
            // list` and passed.
            let indent = line.len() - line.trim_start().len();
            let function_end = lines
                .iter()
                .enumerate()
                .skip(index)
                .find(|(_, text)| {
                    text.trim_start().starts_with('}')
                        && text.len() - text.trim_start().len() < indent
                })
                .map(|(at, _)| at - index)
                .unwrap_or(usize::MAX);
            let mut terminated = false;
            // Set when an unreadable argument sits where the subcommand
            // itself could, so nothing about this site can be judged.
            let mut opaque_argument = false;
            // Set whenever such an argument is dropped, wherever it sits.
            let mut unread_argument = false;
            // Whether a `/* … */` comment opened on an earlier line of
            // this window and has not closed yet.
            let mut in_block_comment = false;
            for (offset, text) in lines.iter().skip(index).enumerate() {
                if offset > function_end {
                    break;
                }
                // Comments quote argv words too (one file's comment names
                // `"push"`), and reading them would fail this check for a
                // command that never runs.
                //
                // A `/* … */` comment is the dangerous one, and it was not
                // stripped at all: unlike `//` it sits in the MIDDLE of a
                // builder, so a commented-out `/* .arg("list") */` between
                // `.arg("worktree")` and `.arg("remove")` put a word into
                // `argv` that git never receives — and `worktree list` is
                // the read-only form that clears the site. Stripped
                // first, so a `//` inside one cannot swallow the rest of
                // the line either.
                let (visible, still_open) = strip_block_comments(text, in_block_comment);
                in_block_comment = still_open;
                let text: &str = &visible;
                let code = match text.split_once("//") {
                    Some((before, _)) if before.matches('"').count() % 2 == 0 => before,
                    _ => text,
                };
                let terminator = [".output()", ".status()", ".spawn("]
                    .iter()
                    .filter_map(|needle| code.find(needle))
                    .min();
                // Every use of the binding on this line, as a whole
                // identifier (see [`identifier_positions`]).
                let uses = binding
                    .as_deref()
                    .map(|name| identifier_positions(code, name))
                    .unwrap_or_default();
                // Whether the PREVIOUS line left its statement open, so
                // this one continues it. Read before it is overwritten,
                // because the terminator below asks the same question.
                let continues = in_statement;
                let mentions_binding = binding
                    .as_deref()
                    .is_none_or(|_| offset == 0 || continues || !uses.is_empty());
                in_statement = mentions_binding && !code.trim_end().ends_with(';');
                if mentions_binding {
                    let scanned = &code[..terminator.unwrap_or(code.len())];
                    // ONLY the literals inside `.arg(`/`.args(`. Harvesting
                    // every literal on the line let an `.env("LC_ALL", "C")`
                    // pair, a `.current_dir(…)` or a `format!` template
                    // satisfy the "has a real argument" guard on its own —
                    // so a site whose actual arguments the scanner never
                    // read still looked judged.
                    for (at, _) in scanned.match_indices(".arg") {
                        let rest = &scanned[at..];
                        // What follows decides whether this is a call at
                        // all. `.arg(` and `.args(` are; a FIELD of the
                        // same name (`action.arguments.as_deref()`) is
                        // not, and reading on to whatever paren came next
                        // harvested an unrelated call's literals as
                        // arguments. `.arg` with nothing after it is the
                        // third case: a call whose parenthesis sits on the
                        // NEXT line.
                        let tail = rest[".arg".len()..]
                            .trim_start_matches(|c: char| c.is_alphanumeric() || c == '_')
                            .trim_start();
                        if !tail.is_empty() && !tail.starts_with('(') {
                            continue;
                        }
                        // A call rustfmt wrapped across lines closes on a
                        // LATER one, and one whose OPENING paren wrapped
                        // holds none of it either, so this line holds none
                        // of what it passes. Skipping such a call outright
                        // counted as having READ it: `.arg("remote")`
                        // followed by a wrapped `.arg(` holding `set-url`
                        // left `argv` saying `remote` alone — the
                        // argument-less listing `is_read_only_form`
                        // clears. Either `None` here falls into the
                        // unreadable-argument branch below with every
                        // other word this scan cannot make out.
                        let open = tail.starts_with('(').then(|| rest.len() - tail.len());
                        let closed =
                            open.and_then(|open| rest[open..].find(')').map(|at| open + at));
                        let inside = match (open, closed) {
                            (Some(open), Some(close)) => &rest[open..close],
                            _ => "",
                        };
                        // Anything OUTSIDE this call's string literals: a
                        // macro's name (`format!("{}", sub)`), a variable
                        // (`.arg(&action)`, `.args(&refs)`), or the
                        // variable items of a MIXED array — `.args(["-C",
                        // &path, "remote", &action])` harvests as its two
                        // literals alone, and the words between them leave
                        // no trace in `argv` at all.
                        let unread = open.is_none()
                            || closed.is_none()
                            || inside.split('"').step_by(2).any(|outside| {
                                outside.chars().any(|c| c.is_alphanumeric() || c == '_')
                            })
                            // An EMPTY literal is a word passed to git that
                            // says nothing about what runs, yet it satisfied
                            // the "a subcommand was read" guard below all on
                            // its own — leaving the real subcommand free to
                            // sit in a variable, checked by nothing. A
                            // literal holding a BACKSLASH is the same word
                            // in disguise: the source text is not what git
                            // receives (`"pu\x73h"` runs `push`), and an
                            // escaped quote inside one splits this scan's
                            // tokens somewhere git never would.
                            || inside
                                .split('"')
                                .skip(1)
                                .step_by(2)
                                .any(|token| token.trim().is_empty() || token.contains('\\'));
                        if unread {
                            // Reading such a word as NO argument is how
                            // `git remote set-url origin <url>` read as
                            // the argument-less listing and was waved
                            // through. Its literals are dropped with it:
                            // half a call is not a read. The one word that
                            // is NOT an argument to judge is the VALUE of
                            // a global option that takes one:
                            // `.arg("-C")` then `.arg(&path)` names the
                            // repository, not a form.
                            //
                            // Only BEFORE the subcommand: git's global
                            // options all precede it, so a second `-C`
                            // written after one is not a global option and
                            // must not be allowed to forgive the word
                            // behind it (`remote` `-C` `<action>`).
                            if expects_option_value && !subcommand_read {
                                expects_option_value = false;
                                continue;
                            }
                            // Unreadable BEFORE any literal subcommand, it
                            // could BE the subcommand and the site is
                            // unjudgeable outright; after one (`log
                            // --format=…` then `format!("-{}", n)`) only
                            // the FORM goes unread — which still matters
                            // wherever the verdict turns on it.
                            if !subcommand_read {
                                opaque_argument = true;
                            }
                            unread_argument = true;
                            continue;
                        }
                        // One literal at a time, so a global option and
                        // the value that belongs to it are told apart
                        // exactly as `git_subcommand_at` tells them apart.
                        // Reading the whole call at once and then asking
                        // only what its LAST token was could not do that.
                        for token in inside
                            .split('"')
                            .skip(1)
                            .step_by(2)
                            .filter(|token| *token != "git")
                        {
                            if expects_option_value {
                                expects_option_value = false;
                            } else if !token.starts_with('-') {
                                subcommand_read = true;
                            } else if GLOBAL_OPTS_WITH_VALUE.contains(&token) {
                                expects_option_value = true;
                            }
                            argv.push(token.to_string());
                        }
                    }
                }
                // A terminator ends THIS builder only when it is reached
                // on a line that continues the builder's OWN statement:
                // the spawn line, a chained continuation of the line
                // before it, or a call whose receiver is the binding
                // (`cmd.output()`). A line that merely names it —
                // `let cached = wrap(cmd).output();` — runs something
                // else, and crediting its terminator stopped the read
                // before the arguments that came after.
                let terminates = terminator.is_some_and(|terminator| {
                    binding.as_deref().is_none_or(|name| {
                        offset == 0
                            || continues
                            || uses.iter().any(|at| {
                                *at < terminator && code[at + name.len()..].starts_with('.')
                            })
                    })
                });
                if terminates {
                    terminated = true;
                    break;
                }
                // Without a binding there is nothing to follow, so the
                // chained shape ends at its own statement.
                if binding.is_none() && offset > 0 && code.trim_end().ends_with(';') {
                    break;
                }
            }

            sites.push(BareSite {
                file: relative.to_string(),
                line: index + 1,
                argv,
                terminated: terminated && !opaque_argument,
                unread_argument,
            });
        }
        sites
    }

    /// One synthetic source, scanned exactly as a real file is.
    fn scan(lines: &[&str]) -> Vec<BareSite> {
        scan_source("commands/probe.rs", &lines.join("\n"))
    }

    /// These sources are built out of `&str` lines rather than written as raw
    /// string literals on purpose: a raw string holding a line `}` at column
    /// zero would end THIS module's own `#[cfg(test)]` skip, and the spawns in
    /// the tests below it would be scanned as production code.
    #[test]
    fn test_the_scan_cannot_read_a_call_whose_parenthesis_wrapped() {
        // `.arg` with its `(` on the next line passes a word this line does
        // not hold. Skipped in silence, `git remote set-url` read as the
        // argument-less listing that `is_read_only_form` clears.
        let sites = scan(&[
            "fn f() {",
            "    let out = Command::new(\"git\")",
            "        .arg(\"remote\")",
            "        .arg",
            "        (\"set-url\")",
            "        .output();",
            "}",
        ]);
        assert_eq!(sites.len(), 1, "{sites:?}");
        assert_eq!(sites[0].argv, vec!["remote".to_string()]);
        assert!(
            sites[0].unread_argument,
            "a call whose parenthesis wrapped is a word this scan did not read"
        );
    }

    #[test]
    fn test_a_field_named_like_the_call_is_not_a_call() {
        // `.arg`/`.args` also occur as FIELD names, and reading on to whatever
        // parenthesis came next then harvested an unrelated call's literal as
        // an argument: the word `list` here is a lookup KEY, not a word git
        // receives, and `worktree list` is the read-only form.
        let sites = scan(&[
            "fn f() {",
            "    let mut cmd = Command::new(\"git\");",
            "    cmd.arg(\"worktree\");",
            "    cmd.arg(map.arg_index.get(\"list\").unwrap());",
            "    cmd.arg(\"remove\");",
            "    cmd.output()",
            "}",
        ]);
        assert_eq!(sites.len(), 1, "{sites:?}");
        assert_eq!(sites[0].argv, args(&["worktree", "remove"]));
        assert!(
            sites[0].unread_argument,
            "the argument itself is a variable, which is a word this scan did not read"
        );
    }

    #[test]
    fn test_a_terminator_on_an_unrelated_statement_does_not_end_the_builder() {
        // The binding matched as a bare substring, `cmd_probe` counted as
        // `cmd`: the builder was cut short there and judged on a PREFIX of
        // its arguments — a read-only `worktree list` that goes on to run
        // `push --force`.
        let sites = scan(&[
            "fn f() {",
            "    let mut cmd = Command::new(\"git\");",
            "    cmd.arg(\"worktree\");",
            "    cmd.arg(\"list\");",
            "    let cmd_probe = probe().output();",
            "    cmd.arg(\"push\");",
            "    cmd.arg(\"--force\");",
            "    cmd.output()",
            "}",
        ]);
        assert_eq!(sites.len(), 1, "{sites:?}");
        assert_eq!(
            sites[0].argv,
            args(&["worktree", "list", "push", "--force"])
        );
        assert!(sites[0].terminated);

        // Nor does a statement that merely NAMES the binding: the terminator
        // has to be reached on the builder's own statement.
        let sites = scan(&[
            "fn f() {",
            "    let mut cmd = Command::new(\"git\");",
            "    cmd.arg(\"worktree\");",
            "    cmd.arg(\"list\");",
            "    let cached = wrap(cmd).output();",
            "    cmd.arg(\"push\");",
            "    cmd.output()",
            "}",
        ]);
        assert_eq!(sites.len(), 1, "{sites:?}");
        assert_eq!(sites[0].argv, args(&["worktree", "list", "push"]));
    }

    #[test]
    fn test_arguments_inside_a_block_comment_are_not_read_as_arguments() {
        // Unlike `//`, a `/* … */` sits in the MIDDLE of a builder, so a
        // commented-out argument put a word into `argv` that git never
        // receives — and `worktree list` is the form that clears the site.
        let sites = scan(&[
            "fn f() {",
            "    let out = Command::new(\"git\")",
            "        .arg(\"worktree\")",
            "        /* .arg(\"list\") */",
            "        .arg(\"remove\")",
            "        .output();",
            "}",
        ]);
        assert_eq!(sites.len(), 1, "{sites:?}");
        assert_eq!(sites[0].argv, args(&["worktree", "remove"]));

        // The same across lines, and a `/*` INSIDE a literal opens nothing.
        let sites = scan(&[
            "fn f() {",
            "    let out = Command::new(\"git\")",
            "        .arg(\"worktree\")",
            "        /* .arg(\"list\")",
            "           .arg(\"prune\") */",
            "        .arg(\"--pretty=/*x*/\")",
            "        .arg(\"remove\")",
            "        .output();",
            "}",
        ]);
        assert_eq!(sites.len(), 1, "{sites:?}");
        assert_eq!(
            sites[0].argv,
            args(&["worktree", "--pretty=/*x*/", "remove"])
        );
    }

    #[test]
    fn test_the_window_ends_at_the_method_the_spawn_is_in() {
        // Ended at the first line `}` at column zero, a spawn inside an
        // `impl` ran on to the end of the IMPL: the next method's literals
        // joined this site's `argv` and its terminator marked this site
        // terminated, so a builder handed out of its function — which the
        // header has to acknowledge — read as a self-contained `git worktree
        // list` and passed.
        let sites = scan(&[
            "impl Runner {",
            "    fn build(&self) -> Command {",
            "        let mut cmd = Command::new(\"git\");",
            "        cmd.arg(\"worktree\");",
            "        handoff(cmd)",
            "    }",
            "",
            "    fn unrelated(&self) -> io::Result<Output> {",
            "        let mut cmd = Command::new(\"true\");",
            "        cmd.arg(\"list\");",
            "        cmd.output()",
            "    }",
            "}",
        ]);
        assert_eq!(sites.len(), 1, "{sites:?}");
        assert_eq!(sites[0].argv, vec!["worktree".to_string()]);
        assert!(
            !sites[0].terminated,
            "this builder leaves its method, so the scan has not read what it runs"
        );
    }

    #[test]
    fn test_a_test_module_closed_with_a_trailing_comment_hides_nothing_below_it() {
        // The skip ended on the literal line `}`, so `} // end of tests` never
        // closed it and every production spawn below was skipped in silence.
        let sites = scan(&[
            "#[cfg(test)]",
            "mod tests {",
            "    #[test]",
            "    fn t() {",
            "        let _ = Command::new(\"git\").arg(\"status\").output();",
            "    }",
            "} // end of tests",
            "",
            "fn production() {",
            "    let _ = Command::new(\"git\").arg(\"push\").arg(\"--force\").output();",
            "}",
        ]);
        assert_eq!(sites.len(), 1, "{sites:?}");
        assert_eq!(sites[0].argv, args(&["push", "--force"]));
    }

    #[test]
    fn test_a_spawn_written_with_spaces_is_still_a_spawn() {
        // Matched as one fixed string, a single space made the site INVISIBLE
        // rather than merely unreadable — the one direction this scan must
        // never fail in.
        let sites = scan(&[
            "fn f() {",
            "    let out = Command::new( \"git\" )",
            "        .arg(\"push\")",
            "        .output();",
            "}",
        ]);
        assert_eq!(sites.len(), 1, "{sites:?}");
        assert_eq!(sites[0].argv, vec!["push".to_string()]);

        // Nor does wrapping the program itself onto the next line hide one.
        let sites = scan(&[
            "fn f() {",
            "    let out = Command::new(",
            "        \"git\",",
            "    )",
            "    .arg(\"push\")",
            "    .output();",
            "}",
        ]);
        assert_eq!(sites.len(), 1, "{sites:?}");
        assert_eq!(sites[0].argv, vec!["push".to_string()]);
    }

    /// The module header keeps a list of the files that spawn `git` outside
    /// [`create_command`]. This keeps that list and the code in step.
    #[test]
    fn test_the_header_names_every_bare_git_command_site() {
        let header = module_header();
        assert!(
            header.contains("bare `Command`"),
            "the module header is missing; this test guards it"
        );

        let sites = bare_git_command_sites();
        assert!(
            !sites.is_empty(),
            "the scan found nothing at all, so it proves nothing"
        );

        let mut found: Vec<String> = sites
            .iter()
            .map(|site| file_name(&site.file).to_string())
            .collect();
        found.sort();
        found.dedup();

        for file in &found {
            assert!(
                header.contains(&format!("`{file}`")),
                "{file} spawns a bare git Command in production but the header does not name it"
            );
        }

        // ...and nothing the header names may have stopped doing it.
        for (index, token) in header.split('`').enumerate() {
            if index % 2 == 0 || !token.ends_with(".rs") {
                continue;
            }
            // Whole name, not a suffix: `advanced_search.rs` must not stand
            // in for the header's `search.rs`.
            if !sites.iter().any(|site| file_name(&site.file) == token) {
                assert!(
                    !std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("src/commands")
                        .join(token)
                        .exists(),
                    "the header names {token} as spawning a bare git Command; it no longer does"
                );
            }
        }
    }

    fn module_header() -> String {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/utils/command.rs"),
        )
        .expect("command.rs must be readable")
        .lines()
        .take_while(|line| line.starts_with("//!"))
        .collect::<Vec<_>>()
        .join("\n")
    }

    /// The header claims the bare-`Command` sites cannot reach the panel. That
    /// is a claim about SUBCOMMANDS, and the file-name test above cannot see
    /// one, so a site that started running a logged, mutating form would slip
    /// past it. (One already had: the header said every one of those
    /// subcommands was absent from `LOGGED_SUBCOMMANDS` while naming `ai.rs`'s
    /// `git reflog`, which is in it.)
    #[test]
    fn test_a_bare_git_command_site_can_never_reach_the_panel() {
        // The header declares ONE exception that does run a logged, mutating
        // form: `preview_rebase`'s worktree add/remove. Both the file AND the
        // form are read out of the header rather than hard-coded, so a
        // different mutating spawn added to that same file is NOT exempt, and
        // deleting the paragraph fails this test instead of widening it.
        let header = module_header();
        // ONE paragraph, not the rest of the header: reading on meant an
        // innocent edit to a later paragraph could add a form here and
        // silently widen the exemption. `header_paragraph` also refuses an
        // anchor that occurs twice, so the paragraph cannot be impersonated.
        let exception_paragraph = header_paragraph(&header, "`merge.rs` is a real exception");
        // The exempted FORMS are read out of that paragraph, not just the
        // file: every ``git <subcommand>`` it quotes. A file-wide exemption hid
        // the ghost `git rebase` from this test entirely, which is exactly the
        // shape it exists to catch.
        let exception = exception_paragraph.map(|paragraph| {
            let forms: Vec<String> = paragraph
                .split('`')
                .skip(1)
                .step_by(2)
                .filter_map(|quoted| quoted.strip_prefix("git "))
                .filter_map(|rest| rest.split_whitespace().next())
                .map(str::to_string)
                .collect();
            ("merge.rs", forms)
        });
        // File AND form are still not enough: `merge.rs` is precisely the file
        // where the NEXT bare `git rebase` or `git worktree` gets written, and
        // a fifth one inherited this exemption in silence. So the header's own
        // COUNTS cap it — the six spawns the paragraph credits to
        // `preview_rebase`, and the four of them it calls writes.
        // Each count comes out of the paragraph that states it — the spawn
        // count out of the very paragraph the FORMS above come from — so a
        // number can only be raised by editing the sentence that grants the
        // exemption it caps.
        let declared_spawns =
            exception_paragraph.and_then(|paragraph| declared_count(paragraph, " bare commands"));
        let declared_writes = header_paragraph(&header, " that write belong on")
            .and_then(|paragraph| declared_count(paragraph, " that write belong on"));
        let mut exempted = 0usize;
        // The other exemption — a builder that leaves its function unread — is
        // capped the same way, by the count its own sentence states.
        let declared_unreadable = header_paragraph(&header, " spawns run outside")
            .and_then(|paragraph| declared_count(paragraph, " spawns run outside"));
        let mut unreadable = 0usize;

        let sites = bare_git_command_sites();
        assert!(
            !sites.is_empty(),
            "the scan found no bare git Command sites at all, so it proves nothing"
        );

        for site in &sites {
            // A site whose arguments the scanner could not read is not a site
            // that passes — it is a site nobody checked. `describe.rs` sat in
            // exactly that state: the window stopped at the `current_dir` line
            // before the `arg("describe")`, so it was read as taking no
            // arguments and waved through by the "nothing logged here" branch.
            // A site whose builder is handed to a helper never reaches its
            // own terminator, so its arguments may be assembled somewhere this
            // scan cannot see. Three sites are in that shape; they are named in
            // the header so the exemption is visible rather than accidental.
            if !site.terminated {
                // Exempted by a DEDICATED sentence, not by the header naming
                // the file somewhere: every bare-`Command` file is named in
                // the header by construction, so that test was no test at all.
                // The name has to appear WHOLE and quoted. Matched as a bare
                // substring, the sentence naming `advanced_search.rs` also
                // acknowledged `search.rs` — a file holding six builders of
                // the same shape, one refactor from escaping their functions —
                // and exempted it from this test entirely.
                let acknowledged = header
                    .split("hands it to `execute_git_log`")
                    .next()
                    .is_some_and(|before| {
                        before.rsplit("//!").next().is_some_and(|sentence| {
                            sentence.contains(&format!("`{}`", file_name(&site.file)))
                        })
                    })
                    && header.contains("hands it to `execute_git_log`");
                assert!(
                    acknowledged,
                    "{}:{}: this spawn's builder leaves the function before it runs (or the \
                     subcommand itself is not a literal), so the scan cannot read what it \
                     runs. Run the builder where it is assembled, use literal arguments, or \
                     acknowledge this file in the header's own sentence about builders that \
                     escape.",
                    site.file, site.line
                );
                unreadable += 1;
                continue;
            }

            // Not merely non-empty: a site read as `["-C"]` is a global flag
            // and nothing else, which is just as unjudgeable as reading
            // nothing, and it used to satisfy an is_empty check.
            assert!(
                site.argv.iter().any(|token| !token.starts_with('-')),
                "{}:{}: the scanner read no subcommand for this spawn ({:?}), so it cannot judge \
                 it. Widen the window rather than trusting the pass.",
                site.file,
                site.line,
                site.argv
            );

            let Some(position) = site
                .argv
                .iter()
                .position(|token| LOGGED_SUBCOMMANDS.contains(&token.as_str()))
            else {
                // Nothing this site runs is reported, so it cannot appear.
                continue;
            };

            let subcommand = site.argv[position].clone();
            let rest: Vec<String> = site.argv[position + 1..].to_vec();
            if is_read_only_form(&subcommand, &rest) {
                // `is_read_only_form` judges the FORM, so it may only be
                // trusted when the form was actually read. An argument the
                // source does not spell out — a macro, or a variable — is
                // dropped from `argv`, and dropping one is enough to turn
                // `git remote set-url origin <url>` into the argument-less
                // listing or `git archive --output=<file>` into the stdout
                // stream.
                assert!(
                    !site.unread_argument,
                    "{}:{} reads as a read-only `{subcommand}` ({:?}) only because an argument \
                     the source does not spell out (a macro, or a variable) could not be read. \
                     Pass literal arguments so the form can be judged.",
                    site.file, site.line, site.argv
                );
                // `argv` is the literals in SOURCE order, which is not always
                // the order git sees: a builder that adds `list` in one branch
                // and `push` in the other reads as the listing, and a logged
                // word passed as a global option's value (`--exec-path
                // archive`) is picked up before the real subcommand. So the
                // read that clears this site is only trustworthy while nothing
                // after it is a logged mutating form either.
                let shadowed = rest.iter().enumerate().find_map(|(at, token)| {
                    (LOGGED_SUBCOMMANDS.contains(&token.as_str())
                        && !is_read_only_form(token, &rest[at + 1..]))
                    .then_some(token)
                });
                assert!(
                    shadowed.is_none(),
                    "{}:{} reads as a read-only `{subcommand}` ({:?}), but `{}` later in the \
                     same builder is a logged mutating form. The scan cannot tell which of them \
                     runs - assemble the arguments in one order, or route the mutating form \
                     through create_command.",
                    site.file,
                    site.line,
                    site.argv,
                    shadowed.map(String::as_str).unwrap_or_default()
                );
                continue;
            }

            if let Some((file, allowed)) = exception.as_ref() {
                if file_name(&site.file) == *file && allowed.contains(&subcommand) {
                    exempted += 1;
                    continue;
                }
            }

            panic!(
                "{}:{} spawns a bare git Command running `{subcommand}`, which IS in \
                 LOGGED_SUBCOMMANDS and is not a read-only form. Either route it through \
                 create_command so the panel sees it, or explain here why it may not be \
                 reported - the module header's claim that these sites cannot reach the \
                 panel is now false.",
                site.file, site.line
            );
        }

        // And the declared exception must still BE one: if `preview_rebase`
        // moves onto `create_command`, this paragraph has to go with it.
        if let Some((file, _)) = exception.as_ref() {
            assert!(
                exempted > 0,
                "the header still declares merge.rs a real exception, but nothing there runs a \
                 logged mutating form any more - delete that paragraph"
            );
            // Both counts come out of that paragraph, so widening the
            // exemption means saying so there. A seventh spawn fails the
            // first; swapping one of the two reads for another `git worktree`
            // keeps the total at six and fails the second.
            let spawns = sites
                .iter()
                .filter(|site| file_name(&site.file) == *file)
                .count();
            assert_eq!(
                Some(spawns),
                declared_spawns,
                "{file} now holds {spawns} bare git spawns, but the header's exception paragraph \
                 accounts for {declared_spawns:?}. Route the new one through create_command, or \
                 say in that paragraph what it is and why it may not be reported."
            );
            assert_eq!(
                Some(exempted),
                declared_writes,
                "{exempted} spawns in {file} are exempted as declared writes, but the header \
                 says {declared_writes:?}. The exemption may not grow without the sentence that \
                 justifies it growing too."
            );
        }

        // Same for the sites whose builders the scan cannot follow: the
        // sentence acknowledging them states how many there are, so a fourth
        // one in that file is a new unjudged spawn, not a covered one.
        // `unwrap_or(0)`, so that removing the sentence is only allowed once
        // no site needs it: with sites still escaping, a deleted or reworded
        // count reads as zero and fails here.
        assert_eq!(
            unreadable,
            declared_unreadable.unwrap_or(0),
            "{unreadable} bare spawns hand their builder out of the function (or hide the \
             subcommand behind a non-literal argument), but the header acknowledges \
             {declared_unreadable:?}. Assemble and run the new one in the same place, or amend \
             that sentence."
        );
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

    /// A listing that shares its subcommand with a write is still a read, and
    /// a read must not appear in the panel as an executed operation — nor,
    /// with no pending IPC operation of its own, be free to take over a real
    /// operation's row on the frontend's late-claim path.
    #[test]
    fn test_read_only_forms_of_reported_subcommands_are_not_reported() {
        for read in [
            vec!["lfs", "version"],
            vec!["lfs", "env"],
            vec!["lfs", "ls-files", "-s"],
            vec!["lfs", "ls-files", "-l"],
            vec!["lfs", "track"],
            vec!["worktree", "list", "--porcelain"],
            vec!["submodule", "status", "--", "vendor/dep"],
            vec!["bisect", "log"],
            vec!["bisect", "visualize"],
            vec!["bundle", "list-heads", "--", "/tmp/x.bundle"],
            vec!["sparse-checkout", "list"],
            vec!["stash", "list"],
            vec!["remote", "-v"],
            vec!["remote", "get-url", "origin"],
            vec!["reflog"],
            vec!["archive", "--format=tar", "--", "HEAD"],
        ] {
            let mut cmd = create_command("git");
            cmd.current_dir("/work/repo").args(&read);
            assert!(
                cmd.loggable_command_line().is_none(),
                "git {} is a read and must not be reported",
                read.join(" ")
            );
        }
    }

    /// The writes next to those reads keep being reported — the exclusion is
    /// by FORM, not by subcommand, or the LFS and worktree operations users
    /// most want to see would vanish along with the listings.
    #[test]
    fn test_mutating_forms_of_the_same_subcommands_are_still_reported() {
        for write in [
            vec!["lfs", "track", "*.psd"],
            vec!["lfs", "pull"],
            vec!["lfs", "fetch", "main"],
            vec!["lfs", "prune"],
            vec!["worktree", "add", "-b", "feat", "/tmp/wt"],
            vec!["worktree", "remove", "/tmp/wt"],
            vec!["submodule", "update", "--init"],
            vec!["bisect", "start"],
            vec!["bundle", "create", "--", "/tmp/x.bundle", "--all"],
            vec!["bundle", "verify", "--", "/tmp/x.bundle"],
            vec!["sparse-checkout", "set", "src"],
            vec!["stash", "push", "-m", "x"],
            vec!["remote", "prune", "origin"],
            vec!["reflog", "expire", "--all"],
            vec![
                "archive",
                "--format=zip",
                "--output=/tmp/x.zip",
                "--",
                "HEAD",
            ],
        ] {
            let mut cmd = create_command("git");
            cmd.current_dir("/work/repo").args(&write);
            assert!(
                cmd.loggable_command_line().is_some(),
                "git {} is a write and must be reported",
                write.join(" ")
            );
        }
    }

    /// End to end through the sink: a read run to completion reaches the panel
    /// exactly never, a write exactly once.
    #[test]
    fn test_sink_receives_writes_but_not_read_only_forms() {
        test_sink::install();
        let repo = crate::test_utils::TestRepo::with_initial_commit();
        let path = repo.path_str();

        // `git stash list` is a read of a reported subcommand.
        let _ = create_command("git")
            .current_dir(&repo.path)
            .args(["stash", "list"])
            .output()
            .expect("git must run");
        assert!(
            test_sink::recorded_for(&path).is_empty(),
            "git stash list must not be reported: {:?}",
            test_sink::recorded_for(&path)
        );

        // `git reflog expire` is a write of one.
        let _ = create_command("git")
            .current_dir(&repo.path)
            .args(["reflog", "expire", "--expire=now", "--all"])
            .output()
            .expect("git must run");
        let reported = test_sink::recorded_for(&path);
        assert_eq!(reported.len(), 1, "got {:?}", reported);
        assert_eq!(reported[0].command, "git reflog expire --expire=now --all");
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
