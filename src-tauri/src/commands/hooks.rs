//! Git Hooks management command handlers
//! View, edit, enable/disable git hooks
//!
//! In addition to the management commands (list/edit/toggle), this module
//! provides a small hook *runner* used by the git2-based write paths so they
//! invoke client-side hooks with the same semantics as canonical git
//! (githooks(5)). libgit2 runs no hooks, so without this the app would
//! silently bypass pre-commit/commit-msg/pre-push/etc. on its default paths.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::command;

use crate::error::{GitnadoError, Result};

/// Resolve the hooks directory exactly as git does:
/// - `core.hooksPath` if set. A leading `~` is expanded to `$HOME`; a relative
///   path resolves against the repository working directory (git resolves it
///   against the repo's top-level working tree).
/// - otherwise `<commondir>/hooks` (using `commondir()`, NOT `path()`, so
///   linked worktrees share the main repo's hooks like git).
fn resolve_hooks_dir(repo: &git2::Repository) -> PathBuf {
    if let Ok(config) = repo.config() {
        if let Ok(hooks_path) = config.get_string("core.hooksPath") {
            if !hooks_path.is_empty() {
                let expanded = expand_tilde(&hooks_path);
                let p = Path::new(&expanded);
                if p.is_absolute() {
                    return p.to_path_buf();
                }
                // Relative: resolve against the working directory (git's rule).
                if let Some(workdir) = repo.workdir() {
                    return workdir.join(p);
                }
                return p.to_path_buf();
            }
        }
    }
    repo.commondir().join("hooks")
}

/// Expand a leading `~` (or `~/`) to the user's home directory, like git.
fn expand_tilde(path: &str) -> String {
    if path == "~" {
        if let Some(home) = home_dir() {
            return home.to_string_lossy().to_string();
        }
    } else if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    path.to_string()
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    #[cfg(not(unix))]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
}

/// Whether `path` is an existing, executable regular file.
///
/// On non-unix platforms executability cannot be reliably determined from the
/// filesystem, so hooks are best-effort skipped there (documented deviation).
#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && (m.permissions().mode() & 0o111 != 0))
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_path: &Path) -> bool {
    false
}

/// Would this hook actually run?
///
/// The management commands used to report `enabled` from file existence while
/// the runner (and git) additionally require the executable bit, so the two
/// disagreed about the same word. On Windows `is_executable` is always false,
/// so existence is the only meaningful signal there.
fn hook_exists_and_runs(hook_path: &Path) -> bool {
    #[cfg(unix)]
    {
        is_executable(hook_path)
    }
    #[cfg(not(unix))]
    {
        hook_path.exists()
    }
}

/// Outcome of attempting to run a hook.
pub struct HookOutcome {
    /// The hook existed, was executable, and was executed.
    pub ran: bool,
    /// Exit status success (true when the hook did not run).
    pub success: bool,
    /// Combined stdout+stderr the hook produced (empty when it did not run).
    pub output: String,
}

/// Run a single git hook with githooks(5) semantics.
///
/// - Resolves the hook via [`resolve_hooks_dir`] and runs it only if the file
///   exists and is executable.
/// - Executes with the current directory set to the repository working tree.
/// - `args` are passed as positional arguments; `stdin_data`, when `Some`, is
///   fed on the hook's stdin (otherwise stdin is `/dev/null` so a hook that
///   reads stdin can never hang the GUI on inherited process stdin).
pub fn run_hook(
    repo: &git2::Repository,
    name: &str,
    args: &[&str],
    stdin_data: Option<&str>,
) -> Result<HookOutcome> {
    let not_run = HookOutcome {
        ran: false,
        success: true,
        output: String::new(),
    };

    // Bare repositories have no working tree to run hooks against.
    let workdir = match repo.workdir() {
        Some(w) => w.to_path_buf(),
        None => return Ok(not_run),
    };

    let hook_path = resolve_hooks_dir(repo).join(name);
    if !is_executable(&hook_path) {
        return Ok(not_run);
    }

    let mut cmd = std::process::Command::new(&hook_path);
    cmd.current_dir(&workdir);
    cmd.args(args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    if stdin_data.is_some() {
        cmd.stdin(Stdio::piped());
    } else {
        cmd.stdin(Stdio::null());
    }

    // Do NOT export GIT_DIR/GIT_WORK_TREE: hooks (e.g. husky, lint-staged)
    // discover the repository from the working directory, and a stale GIT_DIR
    // would misdirect them (and break linked worktrees). cwd = workdir is
    // exactly what git relies on.

    let mut child = cmd.spawn().map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to run {} hook: {}", name, e))
    })?;

    if let Some(data) = stdin_data {
        use std::io::Write;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(data.as_bytes());
        }
        // stdin dropped here -> EOF for the hook.
    }

    let output = child.wait_with_output().map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to run {} hook: {}", name, e))
    })?;

    let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.is_empty() {
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str(&stderr);
    }

    Ok(HookOutcome {
        ran: true,
        success: output.status.success(),
        output: combined,
    })
}

/// Run a blocking hook (pre-commit, commit-msg, pre-merge-commit, pre-push).
/// A non-zero exit aborts the operation with the hook's output in the error,
/// mirroring canonical git.
pub fn run_hook_blocking(
    repo: &git2::Repository,
    name: &str,
    args: &[&str],
    stdin_data: Option<&str>,
) -> Result<()> {
    let outcome = run_hook(repo, name, args, stdin_data)?;
    if outcome.ran && !outcome.success {
        let detail = outcome.output.trim();
        return Err(GitnadoError::OperationFailed(if detail.is_empty() {
            format!("{} hook failed", name)
        } else {
            format!("{} hook failed:\n{}", name, detail)
        }));
    }
    Ok(())
}

/// Run a non-blocking hook (post-commit, post-checkout, post-merge). Failures
/// are logged but never abort the operation, mirroring canonical git.
pub fn run_hook_noblock(repo: &git2::Repository, name: &str, args: &[&str]) {
    run_hook_noblock_with_stdin(repo, name, args, None)
}

/// As `run_hook_noblock`, but feeds the hook stdin.
///
/// `post-rewrite` reads `<old-sha> <new-sha>` lines from stdin, so it cannot
/// use the no-stdin form.
pub fn run_hook_noblock_with_stdin(
    repo: &git2::Repository,
    name: &str,
    args: &[&str],
    stdin_data: Option<&str>,
) {
    match run_hook(repo, name, args, stdin_data) {
        Ok(outcome) => {
            if outcome.ran && !outcome.success {
                tracing::warn!("{} hook exited non-zero: {}", name, outcome.output.trim());
            }
        }
        Err(e) => tracing::warn!("failed to run {} hook: {}", name, e),
    }
}

/// Run the commit-msg hook: write `message` to the per-worktree
/// `COMMIT_EDITMSG` file, pass its path to the hook (which may rewrite it),
/// and return the possibly-modified message. A non-zero exit aborts the commit.
pub fn run_commit_msg_hook(repo: &git2::Repository, message: &str) -> Result<String> {
    let hook_path = resolve_hooks_dir(repo).join("commit-msg");
    if !is_executable(&hook_path) {
        return Ok(message.to_string());
    }

    let msg_file = repo.path().join("COMMIT_EDITMSG");
    std::fs::write(&msg_file, message)?;

    let arg = msg_file.to_string_lossy().to_string();
    run_hook_blocking(repo, "commit-msg", &[arg.as_str()], None)?;

    // The hook may have edited the message file in place.
    Ok(std::fs::read_to_string(&msg_file).unwrap_or_else(|_| message.to_string()))
}

/// Convenience wrapper for the post-checkout hook.
/// `branch_switch` selects the flag argument git passes (1 = branch checkout,
/// 0 = file checkout).
pub fn run_post_checkout(
    repo: &git2::Repository,
    old_oid: &str,
    new_oid: &str,
    branch_switch: bool,
) {
    let flag = if branch_switch { "1" } else { "0" };
    run_hook_noblock(repo, "post-checkout", &[old_oid, new_oid, flag]);
}

/// The all-zeros object id git uses for a missing ref (e.g. unborn HEAD or a
/// remote ref that does not yet exist).
pub const ZERO_OID: &str = "0000000000000000000000000000000000000000";

/// Resolve HEAD to a full oid string, or [`ZERO_OID`] when HEAD is unborn.
pub fn head_oid_string(repo: &git2::Repository) -> String {
    repo.head()
        .ok()
        .and_then(|h| h.target())
        .map(|o| o.to_string())
        .unwrap_or_else(|| ZERO_OID.to_string())
}

/// The remote's fetch URL, falling back to the remote name (git passes the
/// name as the second pre-push argument when no URL is configured).
fn remote_url(repo: &git2::Repository, remote_name: &str) -> String {
    let url = repo
        .find_remote(remote_name)
        .ok()
        .map(|r| r.url().unwrap_or("").to_string())
        .unwrap_or_default();
    if url.is_empty() {
        remote_name.to_string()
    } else {
        url
    }
}

/// Run the pre-push hook for a branch push (blocking, git parity).
///
/// Passes `<remote-name> <remote-url>` as arguments and feeds the ref update
/// line `<local ref> <local oid> <remote ref> <remote oid>` on stdin, per
/// githooks(5). The remote oid is the known remote-tracking value or all-zeros
/// when the remote ref does not exist yet. A non-zero exit aborts the push.
pub fn run_pre_push_branch(
    repo: &git2::Repository,
    remote_name: &str,
    branch_name: &str,
) -> Result<()> {
    let url = remote_url(repo, remote_name);

    let local_ref = format!("refs/heads/{}", branch_name);
    let local_oid = repo
        .refname_to_id(&local_ref)
        .map(|o| o.to_string())
        .unwrap_or_else(|_| ZERO_OID.to_string());
    let remote_ref = format!("refs/heads/{}", branch_name);
    let remote_oid = repo
        .refname_to_id(&format!("refs/remotes/{}/{}", remote_name, branch_name))
        .map(|o| o.to_string())
        .unwrap_or_else(|_| ZERO_OID.to_string());

    let stdin = format!(
        "{} {} {} {}\n",
        local_ref, local_oid, remote_ref, remote_oid
    );
    run_hook_blocking(repo, "pre-push", &[remote_name, &url], Some(&stdin))
}

/// Run the pre-push hook for a tag push (blocking, git parity).
pub fn run_pre_push_tag(repo: &git2::Repository, remote_name: &str, tag_name: &str) -> Result<()> {
    let url = remote_url(repo, remote_name);

    let local_ref = format!("refs/tags/{}", tag_name);
    let local_oid = repo
        .refname_to_id(&local_ref)
        .map(|o| o.to_string())
        .unwrap_or_else(|_| ZERO_OID.to_string());
    // Tag refs are not mirrored into refs/remotes, so the remote side is
    // treated as absent (all-zeros), matching a first-time tag push.
    let stdin = format!("{} {} {} {}\n", local_ref, local_oid, local_ref, ZERO_OID);
    run_hook_blocking(repo, "pre-push", &[remote_name, &url], Some(&stdin))
}

/// Run the pre-push hook for a tag DELETION (blocking, git parity).
///
/// git spells a deletion with the literal local ref `(delete)` and an all-zero
/// local oid, per githooks(5). Only the LOCAL side is zeroed: the remote object
/// name is still the value the remote advertised for the ref, because that is
/// what the ref is being deleted FROM. Callers pass it in `remote_oid` (see
/// `advertised_tag_oid` in commands/tags.rs); [`ZERO_OID`] is correct there
/// only when the remote does not have the tag at all. A non-zero exit aborts
/// the deletion.
pub fn run_pre_push_tag_delete(
    repo: &git2::Repository,
    remote_name: &str,
    tag_name: &str,
    remote_oid: &str,
) -> Result<()> {
    let url = remote_url(repo, remote_name);
    let remote_ref = format!("refs/tags/{}", tag_name);
    let stdin = format!("(delete) {} {} {}\n", ZERO_OID, remote_ref, remote_oid);
    run_hook_blocking(repo, "pre-push", &[remote_name, &url], Some(&stdin))
}

/// A git hook
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHook {
    pub name: String,
    pub path: String,
    pub exists: bool,
    pub enabled: bool,
    pub content: Option<String>,
    pub description: String,
}

/// Known hook names and their descriptions
const HOOKS: &[(&str, &str)] = &[
    (
        "pre-commit",
        "Run before a commit is created. Can prevent the commit.",
    ),
    (
        "prepare-commit-msg",
        // Honest about reachability: git runs this to seed the message the
        // editor opens on, and Gitnado commits from its own message box with
        // no editor, so it has no point to call it from. Advertising it
        // unqualified — and shipping a one-click template for it — meant a hook
        // could be installed, badged Enabled and counted as active while no
        // commit made in the app would ever run it.
        "Run by git before the commit editor opens. Gitnado commits without an editor, so it does not run this hook.",
    ),
    (
        "commit-msg",
        "Run after the commit message is entered. Can modify or reject it.",
    ),
    (
        "post-commit",
        "Run after a commit is created. Used for notifications.",
    ),
    ("pre-rebase", "Run before rebase. Can prevent the rebase."),
    (
        "post-rewrite",
        "Run after commands that rewrite commits (rebase, amend).",
    ),
    (
        "post-checkout",
        "Run after checkout. Used for environment setup.",
    ),
    (
        "pre-merge-commit",
        // Gitnado runs this as a blocking hook on merge and on the merge leg
        // of pull, exactly as git does. Leaving it out of this list meant the
        // dialog never listed it: a merge vetoed by a broken hook (husky
        // installs these under core.hooksPath) had no entry to read, edit or
        // toggle off — the toggle is the only way to disable a hook — and the
        // footer's "N of M hooks configured" undercounted the hooks that
        // actually gate the user's operations.
        "Run before the automatic merge commit. A non-zero exit stops the commit and leaves the merge to be completed or aborted.",
    ),
    (
        "post-merge",
        "Run after a merge. Used for dependency installation.",
    ),
    ("pre-push", "Run before push. Can prevent the push."),
    ("pre-receive", "Server-side. Run before accepting a push."),
    ("update", "Server-side. Run once per branch being pushed."),
    ("post-receive", "Server-side. Run after accepting a push."),
    ("pre-auto-gc", "Run before automatic garbage collection."),
    ("pre-applypatch", "Run before applying a patch with git am."),
    ("post-applypatch", "Run after applying a patch with git am."),
];

/// Get all hooks for a repository
#[command]
pub async fn get_hooks(path: String) -> Result<Vec<GitHook>> {
    let repo = git2::Repository::open(Path::new(&path))?;
    // resolve_hooks_dir, NOT repo.path().join("hooks"): the runner and git
    // itself honour core.hooksPath (husky sets it) and, in a linked worktree,
    // the COMMON dir. Managing a different directory than the one that runs
    // meant every hook read as "not configured" in those repos and every hook
    // saved from this dialog was inert.
    let hooks_dir = resolve_hooks_dir(&repo);

    let mut hooks = Vec::new();

    for (name, description) in HOOKS {
        let hook_path = hooks_dir.join(name);
        let sample_path = hooks_dir.join(format!("{}.sample", name));
        // toggle_hook disables by renaming to `<name>.disabled`. Reporting
        // only on the live path made the disabled state unrepresentable: the
        // hook came back as "never configured", the UI dropped the toggle that
        // is the only way to re-enable it, and re-creating the hook and
        // disabling it again renamed OVER the stranded original, destroying
        // the user's script.
        let disabled_path = hooks_dir.join(format!("{}.disabled", name));

        // "Enabled" must mean what the RUNNER means by it. run_hook skips a
        // hook without the executable bit exactly as git does, so a file
        // present but not +x — what a core.fileMode=false clone, a Windows
        // checkout or a restored backup produces — was shown with the green
        // Enabled badge and counted as active while nothing would ever run it.
        // On Windows is_executable is always false, so fall back to existence
        // there. toggle_hook(true) chmods 0755, which makes the toggle the
        // repair.
        let enabled = hook_exists_and_runs(&hook_path);
        let exists = hook_path.exists() || disabled_path.exists();
        let content = if hook_path.exists() {
            std::fs::read_to_string(&hook_path).ok()
        } else if disabled_path.exists() {
            std::fs::read_to_string(&disabled_path).ok()
        } else if sample_path.exists() {
            // Return sample content as reference
            None
        } else {
            None
        };

        hooks.push(GitHook {
            name: name.to_string(),
            path: hook_path.to_string_lossy().to_string(),
            exists,
            enabled,
            content,
            description: description.to_string(),
        });
    }

    Ok(hooks)
}

/// Get a specific hook
#[command]
pub async fn get_hook(path: String, name: String) -> Result<GitHook> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let hooks_dir = resolve_hooks_dir(&repo);
    let hook_path = hooks_dir.join(&name);
    let disabled_path = hooks_dir.join(format!("{}.disabled", name));

    // A disabled hook still exists — see get_hooks, which also explains why
    // `enabled` tracks the executable bit rather than mere existence.
    let enabled = hook_exists_and_runs(&hook_path);
    let exists = hook_path.exists() || disabled_path.exists();
    let content = if hook_path.exists() {
        std::fs::read_to_string(&hook_path).ok()
    } else if exists {
        std::fs::read_to_string(&disabled_path).ok()
    } else {
        None
    };

    let description = HOOKS
        .iter()
        .find(|(n, _)| *n == name.as_str())
        .map(|(_, d)| d.to_string())
        .unwrap_or_default();

    Ok(GitHook {
        name,
        path: hook_path.to_string_lossy().to_string(),
        exists,
        enabled,
        content,
        description,
    })
}

/// Save a hook script
#[command]
pub async fn save_hook(path: String, name: String, content: String) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let hooks_dir = resolve_hooks_dir(&repo);

    // Ensure hooks directory exists
    std::fs::create_dir_all(&hooks_dir)?;

    let hook_path = hooks_dir.join(&name);
    let disabled_path = hooks_dir.join(format!("{}.disabled", name));

    // Editing a DISABLED hook must not turn it back on. Now that the dialog
    // can load and show a disabled hook's script, writing unconditionally to
    // the live path created a second, enabled copy that git would run on the
    // next commit — from a gesture whose only stated effect was "saved
    // successfully" — and left the `.disabled` original stranded beside it.
    let target = if !hook_path.exists() && disabled_path.exists() {
        disabled_path
    } else {
        hook_path
    };
    // "Disabled" now has TWO representations — renamed to `<name>.disabled`,
    // and present but not executable — and an edit must preserve either. The
    // rename flavour is handled by `target` above; this catches the other, so
    // saving an edit to a hook the dialog shows as Disabled does not arm a
    // blocking pre-commit from a gesture that only claimed to save.
    #[cfg(unix)]
    let was_inert = target.exists() && !is_executable(&target);
    std::fs::write(&target, &content)?;
    let hook_path = target;

    // Make executable on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if !was_inert {
            let mut perms = std::fs::metadata(&hook_path)?.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&hook_path, perms)?;
        }
    }

    Ok(())
}

/// Delete a hook
#[command]
pub async fn delete_hook(path: String, name: String) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let hooks_dir = resolve_hooks_dir(&repo);
    let hook_path = hooks_dir.join(&name);
    // A disabled hook is still the user's script; Delete must remove it too,
    // or the entry reappears on the next load.
    let disabled_path = hooks_dir.join(format!("{}.disabled", name));

    if hook_path.exists() {
        std::fs::remove_file(&hook_path)?;
    }
    if disabled_path.exists() {
        std::fs::remove_file(&disabled_path)?;
    }

    Ok(())
}

/// Enable or disable a hook (by toggling execute permission or renaming)
#[command]
pub async fn toggle_hook(path: String, name: String, enabled: bool) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let hooks_dir = resolve_hooks_dir(&repo);
    let hook_path = hooks_dir.join(&name);
    let disabled_path = hooks_dir.join(format!("{}.disabled", name));

    if enabled {
        // Enable: rename from .disabled if needed
        if disabled_path.exists() && !hook_path.exists() {
            std::fs::rename(&disabled_path, &hook_path)?;
        }

        // Make executable on Unix
        #[cfg(unix)]
        {
            if hook_path.exists() {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = std::fs::metadata(&hook_path)?.permissions();
                perms.set_mode(0o755);
                std::fs::set_permissions(&hook_path, perms)?;
            }
        }
    } else {
        // Disable: rename to .disabled
        if hook_path.exists() {
            std::fs::rename(&hook_path, &disabled_path)?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[tokio::test]
    async fn test_get_hooks() {
        let repo = TestRepo::with_initial_commit();
        let result = get_hooks(repo.path_str()).await;
        assert!(result.is_ok());
        let hooks = result.unwrap();
        assert!(!hooks.is_empty());

        // All known hooks should be listed
        let names: Vec<&str> = hooks.iter().map(|h| h.name.as_str()).collect();
        assert!(names.contains(&"pre-commit"));
        assert!(names.contains(&"commit-msg"));
        assert!(names.contains(&"pre-push"));
    }

    #[tokio::test]
    async fn test_get_hooks_lists_every_hook_the_app_can_run() {
        // The dialog is data-driven off get_hooks, so a hook the app invokes
        // but does not list is a hook the user cannot inspect, edit, disable or
        // delete — and one the "N of M hooks configured" footer never counts.
        let repo = TestRepo::with_initial_commit();
        let hooks = get_hooks(repo.path_str()).await.unwrap();
        let names: Vec<&str> = hooks.iter().map(|h| h.name.as_str()).collect();

        for blocking in [
            "pre-commit",
            "commit-msg",
            "pre-merge-commit",
            "pre-rebase",
            "pre-push",
        ] {
            assert!(
                names.contains(&blocking),
                "the dialog must list every hook the app runs, missing: {blocking}"
            );
        }
    }

    #[tokio::test]
    async fn test_pre_merge_commit_hook_has_a_description() {
        // get_hook falls back to unwrap_or_default() for an unlisted name, so an
        // omission shows as blank help text rather than an error.
        let repo = TestRepo::with_initial_commit();
        let hook = get_hook(repo.path_str(), "pre-merge-commit".to_string())
            .await
            .unwrap();
        assert!(
            !hook.description.is_empty(),
            "the dialog shows this hook's description"
        );
        assert!(hook.description.to_lowercase().contains("merge"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_pre_merge_commit_hook_can_be_inspected_and_disabled() {
        // The reported dead end: a merge vetoed by a broken pre-merge-commit
        // hook, with no entry in the dialog to read it or toggle it off.
        let repo = TestRepo::with_initial_commit();
        let initial = repo.current_branch();
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature", &[("feature.txt", "content")]);
        repo.checkout_branch(&initial);

        repo.install_hook("pre-merge-commit", "#!/bin/sh\necho denied 1>&2\nexit 1\n");

        let listed = get_hooks(repo.path_str()).await.unwrap();
        let hook = listed
            .iter()
            .find(|h| h.name == "pre-merge-commit")
            .expect("the hook that is blocking merges must appear in the dialog");
        assert!(hook.exists);
        assert!(hook.enabled);
        assert!(
            hook.content.as_deref().unwrap().contains("denied"),
            "its script must be readable"
        );

        // Disable it through the same command the dialog's toggle calls.
        toggle_hook(repo.path_str(), "pre-merge-commit".to_string(), false)
            .await
            .unwrap();
        let listed = get_hooks(repo.path_str()).await.unwrap();
        let hook = listed
            .iter()
            .find(|h| h.name == "pre-merge-commit")
            .expect("a disabled hook stays listed so the toggle can turn it back on");
        assert!(hook.exists);
        assert!(!hook.enabled);

        // The repair is real: the merge the hook was vetoing now completes.
        // no_ff forces the automatic merge commit, so the hook would run.
        crate::commands::merge::merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await
        .unwrap();
        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);
        assert_eq!(
            git_repo
                .head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .parent_count(),
            2,
            "disabling the hook let the merge commit be created"
        );
    }

    #[tokio::test]
    async fn test_save_and_get_hook() {
        let repo = TestRepo::with_initial_commit();
        let script = "#!/bin/sh\necho \"Pre-commit hook\"\nexit 0\n";

        let save_result = save_hook(
            repo.path_str(),
            "pre-commit".to_string(),
            script.to_string(),
        )
        .await;
        assert!(save_result.is_ok());

        let hook = get_hook(repo.path_str(), "pre-commit".to_string())
            .await
            .unwrap();
        assert!(hook.exists);
        assert!(hook.enabled);
        assert_eq!(hook.content.unwrap(), script);
    }

    #[tokio::test]
    async fn test_delete_hook() {
        let repo = TestRepo::with_initial_commit();
        save_hook(
            repo.path_str(),
            "pre-commit".to_string(),
            "#!/bin/sh\nexit 0\n".to_string(),
        )
        .await
        .unwrap();

        let result = delete_hook(repo.path_str(), "pre-commit".to_string()).await;
        assert!(result.is_ok());

        let hook = get_hook(repo.path_str(), "pre-commit".to_string())
            .await
            .unwrap();
        assert!(!hook.exists);
    }

    #[tokio::test]
    async fn test_toggle_hook_disable() {
        let repo = TestRepo::with_initial_commit();
        save_hook(
            repo.path_str(),
            "pre-commit".to_string(),
            "#!/bin/sh\nexit 0\n".to_string(),
        )
        .await
        .unwrap();

        let result = toggle_hook(repo.path_str(), "pre-commit".to_string(), false).await;
        assert!(result.is_ok());

        // Hook should be disabled (renamed to .disabled)
        let git_dir = repo.path.join(".git").join("hooks");
        assert!(!git_dir.join("pre-commit").exists());
        assert!(git_dir.join("pre-commit.disabled").exists());
    }

    #[tokio::test]
    async fn test_toggle_hook_enable() {
        let repo = TestRepo::with_initial_commit();
        save_hook(
            repo.path_str(),
            "pre-commit".to_string(),
            "#!/bin/sh\nexit 0\n".to_string(),
        )
        .await
        .unwrap();

        // Disable first
        toggle_hook(repo.path_str(), "pre-commit".to_string(), false)
            .await
            .unwrap();

        // Enable again
        let result = toggle_hook(repo.path_str(), "pre-commit".to_string(), true).await;
        assert!(result.is_ok());

        let git_dir = repo.path.join(".git").join("hooks");
        assert!(git_dir.join("pre-commit").exists());
        assert!(!git_dir.join("pre-commit.disabled").exists());
    }

    #[tokio::test]
    async fn test_disabled_hook_is_still_reported_as_existing() {
        // Disabling renames to `<name>.disabled`. Reporting only on the live
        // path made the disabled state unrepresentable: the hook came back as
        // "never configured", so the UI dropped the toggle that is the only way
        // back on, and re-creating then disabling again renamed OVER the
        // stranded original and destroyed the user's script.
        let repo = TestRepo::with_initial_commit();
        save_hook(
            repo.path_str(),
            "pre-commit".to_string(),
            "#!/bin/sh\necho original\n".to_string(),
        )
        .await
        .unwrap();
        toggle_hook(repo.path_str(), "pre-commit".to_string(), false)
            .await
            .unwrap();

        let hook = get_hook(repo.path_str(), "pre-commit".to_string())
            .await
            .unwrap();
        assert!(hook.exists, "a disabled hook still exists");
        assert!(!hook.enabled, "and is reported as disabled");
        assert!(
            hook.content.unwrap().contains("original"),
            "its script is still readable, so it can be re-enabled or inspected"
        );

        let listed = get_hooks(repo.path_str()).await.unwrap();
        let pre_commit = listed.iter().find(|h| h.name == "pre-commit").unwrap();
        assert!(pre_commit.exists);
        assert!(!pre_commit.enabled);
    }

    #[tokio::test]
    async fn test_editing_a_disabled_hook_leaves_it_disabled() {
        // The dialog can load and edit a disabled hook's script. Writing to the
        // live path would create a second, ENABLED copy that git runs on the
        // next commit — from a gesture whose only stated effect was "saved".
        let repo = TestRepo::with_initial_commit();
        save_hook(
            repo.path_str(),
            "pre-commit".to_string(),
            "#!/bin/sh\nexit 0\n".to_string(),
        )
        .await
        .unwrap();
        toggle_hook(repo.path_str(), "pre-commit".to_string(), false)
            .await
            .unwrap();

        save_hook(
            repo.path_str(),
            "pre-commit".to_string(),
            "#!/bin/sh\necho edited\n".to_string(),
        )
        .await
        .unwrap();

        let hook = get_hook(repo.path_str(), "pre-commit".to_string())
            .await
            .unwrap();
        assert!(hook.exists);
        assert!(
            !hook.enabled,
            "an edit must not silently re-enable the hook"
        );
        assert!(hook.content.unwrap().contains("edited"), "the edit landed");
        let hooks_dir = repo.path.join(".git").join("hooks");
        assert!(
            !hooks_dir.join("pre-commit").exists(),
            "and no enabled duplicate is left behind for git to run"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_non_executable_hook_is_not_reported_as_enabled() {
        // What a core.fileMode=false clone, a Windows checkout or a restored
        // backup produces. run_hook skips it exactly as git does, so calling it
        // "Enabled" told the user a blocking hook was armed when it was inert.
        use std::os::unix::fs::PermissionsExt;
        let repo = TestRepo::with_initial_commit();
        let hooks_dir = repo.path.join(".git").join("hooks");
        std::fs::create_dir_all(&hooks_dir).unwrap();
        let hook = hooks_dir.join("pre-commit");
        std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o644)).unwrap();

        let reported = get_hook(repo.path_str(), "pre-commit".to_string())
            .await
            .unwrap();
        assert!(reported.exists, "the file is there");
        assert!(!reported.enabled, "but nothing will ever run it");
        assert!(
            reported.content.unwrap().contains("exit 1"),
            "its script is still readable so the user can see what is inert"
        );

        // The toggle is the repair: it chmods 0755.
        toggle_hook(repo.path_str(), "pre-commit".to_string(), true)
            .await
            .unwrap();
        let repaired = get_hook(repo.path_str(), "pre-commit".to_string())
            .await
            .unwrap();
        assert!(repaired.enabled);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_editing_an_inert_hook_does_not_arm_it() {
        // The other flavour of "disabled": present but not executable. Round 28
        // made that read as Disabled; an edit must not silently chmod it into a
        // blocking pre-commit that runs on the next commit.
        use std::os::unix::fs::PermissionsExt;
        let repo = TestRepo::with_initial_commit();
        let hooks_dir = repo.path.join(".git").join("hooks");
        std::fs::create_dir_all(&hooks_dir).unwrap();
        let hook = hooks_dir.join("pre-commit");
        std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o644)).unwrap();

        save_hook(
            repo.path_str(),
            "pre-commit".to_string(),
            "#!/bin/sh\nexit 2\n".to_string(),
        )
        .await
        .unwrap();

        let reported = get_hook(repo.path_str(), "pre-commit".to_string())
            .await
            .unwrap();
        assert!(!reported.enabled, "an edit must not arm an inert hook");
        assert!(
            reported.content.unwrap().contains("exit 2"),
            "the edit landed"
        );
    }

    #[tokio::test]
    async fn test_editing_an_enabled_hook_still_writes_the_live_path() {
        let repo = TestRepo::with_initial_commit();
        save_hook(
            repo.path_str(),
            "pre-commit".to_string(),
            "#!/bin/sh\necho first\n".to_string(),
        )
        .await
        .unwrap();
        save_hook(
            repo.path_str(),
            "pre-commit".to_string(),
            "#!/bin/sh\necho second\n".to_string(),
        )
        .await
        .unwrap();

        let hook = get_hook(repo.path_str(), "pre-commit".to_string())
            .await
            .unwrap();
        assert!(hook.enabled);
        assert!(hook.content.unwrap().contains("second"));
    }

    #[tokio::test]
    async fn test_delete_removes_a_disabled_hook_too() {
        let repo = TestRepo::with_initial_commit();
        save_hook(
            repo.path_str(),
            "pre-commit".to_string(),
            "#!/bin/sh\nexit 0\n".to_string(),
        )
        .await
        .unwrap();
        toggle_hook(repo.path_str(), "pre-commit".to_string(), false)
            .await
            .unwrap();

        delete_hook(repo.path_str(), "pre-commit".to_string())
            .await
            .unwrap();

        let hook = get_hook(repo.path_str(), "pre-commit".to_string())
            .await
            .unwrap();
        assert!(!hook.exists, "otherwise the entry reappears on next load");
    }

    #[tokio::test]
    async fn test_hook_management_follows_core_hookspath() {
        // The runner and git itself honour core.hooksPath (husky sets it).
        // Managing `.git/hooks` instead meant every hook read as "not
        // configured" in such a repo and every hook saved here was inert.
        let repo = TestRepo::with_initial_commit();
        let alt = repo.path.join(".husky");
        std::fs::create_dir_all(&alt).unwrap();
        {
            let git_repo = repo.repo();
            let mut cfg = git_repo.config().unwrap();
            cfg.set_str("core.hooksPath", ".husky").unwrap();
        }

        save_hook(
            repo.path_str(),
            "pre-commit".to_string(),
            "#!/bin/sh\nexit 0\n".to_string(),
        )
        .await
        .unwrap();

        assert!(
            alt.join("pre-commit").exists(),
            "the hook must land where git will look for it"
        );
        assert!(
            !repo
                .path
                .join(".git")
                .join("hooks")
                .join("pre-commit")
                .exists(),
            "and not in a directory nothing consults"
        );

        let hook = get_hook(repo.path_str(), "pre-commit".to_string())
            .await
            .unwrap();
        assert!(hook.exists, "and the dialog must see the hook that runs");
    }

    #[tokio::test]
    async fn test_existing_hookspath_hook_is_visible() {
        // The inverse: a hook installed by husky before Gitnado ever opened
        // the repo must not read as "not configured".
        let repo = TestRepo::with_initial_commit();
        let alt = repo.path.join(".husky");
        std::fs::create_dir_all(&alt).unwrap();
        // Executable, as husky installs them — `enabled` now tracks the
        // executable bit, the same predicate the runner uses.
        std::fs::write(alt.join("pre-push"), "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(alt.join("pre-push"), std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }
        {
            let git_repo = repo.repo();
            let mut cfg = git_repo.config().unwrap();
            cfg.set_str("core.hooksPath", ".husky").unwrap();
        }

        let listed = get_hooks(repo.path_str()).await.unwrap();
        let pre_push = listed.iter().find(|h| h.name == "pre-push").unwrap();
        assert!(pre_push.exists);
        assert!(pre_push.enabled);
    }

    #[tokio::test]
    async fn test_get_hook_nonexistent() {
        let repo = TestRepo::with_initial_commit();
        let hook = get_hook(repo.path_str(), "pre-commit".to_string())
            .await
            .unwrap();
        assert!(!hook.exists);
        assert!(!hook.enabled);
        assert!(hook.content.is_none());
    }

    #[tokio::test]
    async fn test_delete_nonexistent_hook() {
        let repo = TestRepo::with_initial_commit();
        let result = delete_hook(repo.path_str(), "pre-commit".to_string()).await;
        assert!(result.is_ok()); // Should not error
    }

    // ---- Hook runner tests ----

    #[cfg(unix)]
    #[test]
    fn test_run_hook_skips_nonexecutable() {
        let repo = TestRepo::with_initial_commit();
        // Write a hook file WITHOUT the executable bit.
        let hooks_dir = repo.path.join(".git").join("hooks");
        std::fs::create_dir_all(&hooks_dir).unwrap();
        std::fs::write(hooks_dir.join("pre-commit"), "#!/bin/sh\nexit 1\n").unwrap();

        let git_repo = repo.repo();
        let outcome = run_hook(&git_repo, "pre-commit", &[], None).unwrap();
        assert!(!outcome.ran, "non-executable hook must be skipped");
        // Blocking wrapper must NOT abort for a skipped hook.
        assert!(run_hook_blocking(&git_repo, "pre-commit", &[], None).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn test_run_hook_blocking_aborts_on_failure() {
        let repo = TestRepo::with_initial_commit();
        repo.install_hook("pre-commit", "#!/bin/sh\necho nope 1>&2\nexit 1\n");
        let git_repo = repo.repo();
        let err = run_hook_blocking(&git_repo, "pre-commit", &[], None).unwrap_err();
        assert!(
            err.to_string().contains("nope"),
            "hook output missing: {err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_run_hook_noblock_ignores_failure() {
        let repo = TestRepo::with_initial_commit();
        repo.install_hook("post-commit", "#!/bin/sh\nexit 3\n");
        let git_repo = repo.repo();
        // Must not panic or abort.
        run_hook_noblock(&git_repo, "post-commit", &[]);
    }

    #[cfg(unix)]
    #[test]
    fn test_hookspath_absolute() {
        let repo = TestRepo::with_initial_commit();
        let alt = tempfile::tempdir().unwrap();
        // Install an executable pre-commit in the alternate absolute dir.
        {
            use std::os::unix::fs::PermissionsExt;
            let hook = alt.path().join("pre-commit");
            let marker = repo.path.join("abs-marker");
            std::fs::write(
                &hook,
                format!("#!/bin/sh\ntouch \"{}\"\n", marker.display()),
            )
            .unwrap();
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        {
            let git_repo = repo.repo();
            let mut cfg = git_repo.config().unwrap();
            cfg.set_str("core.hooksPath", &alt.path().to_string_lossy())
                .unwrap();
        }
        let git_repo = repo.repo();
        let outcome = run_hook(&git_repo, "pre-commit", &[], None).unwrap();
        assert!(outcome.ran, "hook under absolute core.hooksPath must run");
        assert!(repo.path.join("abs-marker").exists());
    }

    #[cfg(unix)]
    #[test]
    fn test_hookspath_relative_resolves_against_workdir() {
        let repo = TestRepo::with_initial_commit();
        // Relative hooksPath resolves against the working directory.
        {
            use std::os::unix::fs::PermissionsExt;
            let dir = repo.path.join("myhooks");
            std::fs::create_dir_all(&dir).unwrap();
            let hook = dir.join("pre-commit");
            std::fs::write(&hook, "#!/bin/sh\nexit 7\n").unwrap();
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        {
            let git_repo = repo.repo();
            let mut cfg = git_repo.config().unwrap();
            cfg.set_str("core.hooksPath", "myhooks").unwrap();
        }
        let git_repo = repo.repo();
        let outcome = run_hook(&git_repo, "pre-commit", &[], None).unwrap();
        assert!(outcome.ran, "relative core.hooksPath hook must run");
        assert!(!outcome.success, "hook exited 7");
    }

    #[cfg(unix)]
    #[test]
    fn test_commit_msg_hook_rewrites_message() {
        let repo = TestRepo::with_initial_commit();
        // Append a trailer to whatever message is passed.
        repo.install_hook(
            "commit-msg",
            "#!/bin/sh\necho '\nSigned-off-by: hook' >> \"$1\"\nexit 0\n",
        );
        let git_repo = repo.repo();
        let out = run_commit_msg_hook(&git_repo, "original message").unwrap();
        assert!(out.starts_with("original message"));
        assert!(out.contains("Signed-off-by: hook"), "got: {out:?}");
    }

    #[cfg(unix)]
    #[test]
    fn test_commit_msg_hook_can_abort() {
        let repo = TestRepo::with_initial_commit();
        repo.install_hook("commit-msg", "#!/bin/sh\nexit 1\n");
        let git_repo = repo.repo();
        assert!(run_commit_msg_hook(&git_repo, "msg").is_err());
    }
}
