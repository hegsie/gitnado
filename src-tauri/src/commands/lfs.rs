//! Git LFS command handlers
//! Manage large files with Git Large File Storage
//!
//! # Where an LFS transfer goes, and what the network gate can see
//!
//! `git lfs` does not simply talk to the git remote: its endpoint comes from
//! `lfs.url` / `lfs.pushurl` / `remote.<r>.lfsurl` / `remote.<r>.lfspushurl`,
//! any of which a COMMITTED `.lfsconfig` may set, before it falls back to the
//! remote's url. [`resolve_lfs_endpoint`] follows that order, and the gate on
//! `lfs_pull` / `lfs_fetch` (downloads) and on every push-class command
//! (uploads, through the git-lfs pre-push hook) judges that endpoint.
//!
//! Two residuals are accepted and documented rather than closed here:
//!
//! - With `filter.lfs` installed globally (what `git lfs install` does), the
//!   CLI clone and every later checkout SMUDGE pointers, and that smudge
//!   fetches from `lfs.url` too — a host the clone gate, which sees only the
//!   clone URL, cannot judge until the repository exists. Setting
//!   `GIT_LFS_SKIP_SMUDGE=1` on the clone child would close the clone half
//!   at the cost of every LFS clone arriving as pointers; that is a clone-path
//!   decision (`repository.rs`) and is not made here.
//! - For an SSH remote the endpoint is whatever `git-lfs-authenticate` on
//!   that SSH host returns. The allowlist judges the SSH host, which is the
//!   party the user trusted; the URL it hands back is not re-checked.

use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::utils::{apply_token_credential_helper, create_command};

/// LFS file tracking pattern
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsPattern {
    /// The file pattern (e.g., "*.psd")
    pub pattern: String,
}

/// LFS file information
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsFile {
    /// File path
    pub path: String,
    /// LFS object ID (OID)
    pub oid: Option<String>,
    /// File size in bytes
    pub size: Option<u64>,
    /// Whether the file is downloaded (pointer vs actual)
    pub downloaded: bool,
}

/// LFS status information
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsStatus {
    /// Whether Git LFS is installed
    pub installed: bool,
    /// Git LFS version
    pub version: Option<String>,
    /// Whether LFS is enabled for this repo
    pub enabled: bool,
    /// Tracked patterns
    pub patterns: Vec<LfsPattern>,
    /// Number of LFS files
    pub file_count: u32,
    /// Total size of LFS files
    pub total_size: u64,
}

/// The configuration git-lfs reads: git's own config, with the repository's
/// `.lfsconfig` layered UNDERNEATH it.
///
/// From git-lfs-config(5): "Settings from Git configuration files override
/// the `.lfsconfig` file", and "If the `.lfsconfig` file is missing, the
/// index is checked for a version of the file, and that is used instead. If
/// both are missing, `HEAD` is checked for the file." The file is picked
/// once, by that order — a working-tree `.lfsconfig` that lacks a key does not
/// fall through to the committed one.
struct LfsConfig {
    git: Option<git2::Config>,
    /// The `.lfsconfig` git-lfs would use, parsed. Kept alive as a temp file
    /// when it had to be materialised from the index or HEAD.
    lfsconfig: Option<(git2::Config, Option<tempfile::NamedTempFile>)>,
}

impl LfsConfig {
    fn load(repo: &git2::Repository) -> Self {
        LfsConfig {
            git: repo.config().ok(),
            lfsconfig: Self::open_lfsconfig(repo),
        }
    }

    fn open_lfsconfig(
        repo: &git2::Repository,
    ) -> Option<(git2::Config, Option<tempfile::NamedTempFile>)> {
        if let Some(workdir) = repo.workdir() {
            let file = workdir.join(".lfsconfig");
            if file.is_file() {
                return git2::Config::open(&file).ok().map(|cfg| (cfg, None));
            }
        }
        let bytes = Self::index_blob(repo).or_else(|| Self::head_blob(repo))?;
        // libgit2 parses config from a file, so a committed `.lfsconfig` is
        // materialised in a private temp file for as long as this is alive.
        let mut file = tempfile::Builder::new()
            .prefix("leviathan-lfsconfig-")
            .tempfile()
            .ok()?;
        std::io::Write::write_all(&mut file, &bytes).ok()?;
        std::io::Write::flush(&mut file).ok()?;
        let cfg = git2::Config::open(file.path()).ok()?;
        Some((cfg, Some(file)))
    }

    fn index_blob(repo: &git2::Repository) -> Option<Vec<u8>> {
        let index = repo.index().ok()?;
        let entry = index.get_path(Path::new(".lfsconfig"), 0)?;
        repo.find_blob(entry.id).ok().map(|b| b.content().to_vec())
    }

    fn head_blob(repo: &git2::Repository) -> Option<Vec<u8>> {
        let tree = repo.head().ok()?.peel_to_tree().ok()?;
        let entry = tree.get_path(Path::new(".lfsconfig")).ok()?;
        entry
            .to_object(repo)
            .ok()?
            .as_blob()
            .map(|b| b.content().to_vec())
    }

    /// `key` as git-lfs would see it: git config first, `.lfsconfig` second.
    fn get(&self, key: &str) -> Option<String> {
        let from_git = self
            .git
            .as_ref()
            .and_then(|cfg| cfg.get_string(key).ok())
            .filter(|v| !v.trim().is_empty());
        from_git.or_else(|| {
            self.lfsconfig
                .as_ref()
                .and_then(|(cfg, _)| cfg.get_string(key).ok())
                .filter(|v| !v.trim().is_empty())
        })
    }
}

/// The remote git-lfs resolves a download against, per `config.Remote()` in
/// git-lfs: `branch.<current>.remote`, then `remote.lfsdefault`, then the
/// only remote if there is exactly one, then `origin`.
fn lfs_default_remote(repo: &git2::Repository, cfg: &LfsConfig) -> String {
    let tracking = repo
        .head()
        .ok()
        .filter(|head| head.is_branch())
        .and_then(|head| head.shorthand().ok().map(str::to_string))
        .and_then(|branch| cfg.get(&format!("branch.{}.remote", branch)));
    if let Some(remote) = tracking {
        return remote;
    }
    if let Some(remote) = cfg.get("remote.lfsdefault") {
        return remote;
    }
    let names: Vec<String> = repo
        .remotes()
        .ok()
        .map(|list| {
            list.iter()
                .filter_map(|name| name.ok().flatten().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if names.len() == 1 {
        return names[0].clone();
    }
    "origin".to_string()
}

/// Which way an LFS transfer moves objects. git-lfs consults the push-side
/// keys (`lfs.pushurl`, `remote.<r>.lfspushurl`, `remote.<r>.pushurl`) first
/// for an upload and never for a download.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum LfsOperation {
    Download,
    Upload,
}

/// The endpoint a transfer against `remote` reaches, per `RemoteEndpoint` in
/// git-lfs: `remote.<r>.lfspushurl` (uploads only), `remote.<r>.lfsurl`, else
/// derived from `remote.<r>.pushurl` (uploads only) or `remote.<r>.url`.
///
/// The derived endpoint (`<url>.git/info/lfs`, or the https form of an ssh
/// remote) is on the SAME host as the clone URL, which is all the allowlist
/// judges — so the clone URL itself is what comes back.
fn lfs_remote_endpoint(
    repo: &git2::Repository,
    cfg: &LfsConfig,
    remote: &str,
    operation: LfsOperation,
) -> Option<String> {
    if operation == LfsOperation::Upload {
        if let Some(url) = cfg.get(&format!("remote.{}.lfspushurl", remote)) {
            return Some(url);
        }
    }
    if let Some(url) = cfg.get(&format!("remote.{}.lfsurl", remote)) {
        return Some(url);
    }
    let found = repo.find_remote(remote).ok()?;
    if operation == LfsOperation::Upload {
        if let Ok(Some(push_url)) = found.pushurl() {
            return Some(push_url.to_string());
        }
    }
    found.url().ok().map(str::to_string)
}

/// The URL an LFS transfer will actually contact.
///
/// git-lfs does NOT simply talk to the git remote. Its endpoint finder
/// (`lfsapi/endpoint_finder.go`, `getEndpoint`) takes, in order: `lfs.pushurl`
/// (uploads only), then `lfs.url`; then the endpoint for the resolved remote
/// ([`lfs_remote_endpoint`]), falling back to `origin`'s. And every one of the
/// `lfs.*` / `remote.<r>.lfs*` keys may come from `.lfsconfig` — a file
/// COMMITTED TO THE REPOSITORY. So the host an LFS transfer reaches is chosen
/// by whoever pushed the repository, and gating the transfer on the git
/// remote (all it used to do) let an allowlist of `github.com` sit there
/// while `git lfs pull` in a github.com clone transferred from wherever its
/// `.lfsconfig` said. This is what the allowlist has to judge.
///
/// `remote` is the remote the caller already resolved — a push knows its
/// destination, and the pre-push hook hands git-lfs that same name — or
/// `None` for git-lfs's own choice (`lfs_default_remote`).
///
/// `None` when nothing names an endpoint — the gate then fails closed, as it
/// does for any target it cannot see. git-lfs's last resort, `FETCH_HEAD`,
/// is deliberately not followed: it names whichever remote was fetched last,
/// and a guess is not something to admit through an allowlist.
pub(crate) fn resolve_lfs_endpoint(
    repo_path: &Path,
    operation: LfsOperation,
    remote: Option<&str>,
) -> Option<String> {
    let repo = git2::Repository::open(repo_path).ok()?;
    let cfg = LfsConfig::load(&repo);
    if operation == LfsOperation::Upload {
        if let Some(url) = cfg.get("lfs.pushurl") {
            return Some(url);
        }
    }
    if let Some(url) = cfg.get("lfs.url") {
        return Some(url);
    }
    let remote = remote
        .map(str::to_string)
        .unwrap_or_else(|| lfs_default_remote(&repo, &cfg));
    if remote != "origin" {
        if let Some(url) = lfs_remote_endpoint(&repo, &cfg, &remote, operation) {
            return Some(url);
        }
    }
    lfs_remote_endpoint(&repo, &cfg, "origin", operation)
}

/// The offline/allowlist gate for an LFS UPLOAD riding a push.
///
/// git-lfs installs a `pre-push` hook, and both push paths run it — so a
/// push in an LFS repository uploads objects to the LFS endpoint before git
/// sends a single ref, and that endpoint is chosen by the same committed
/// `.lfsconfig` as a download's. Called by every push-class command after
/// its own remote gate; `remote` is the destination that gate just judged.
///
/// A push is waved through only when NOTHING names an LFS endpoint and no LFS
/// filter is in force. `.gitattributes` alone is not the test: a repository can
/// hold committed LFS pointers with no filter rule left in the tree, and
/// `.lfsconfig` naming an `lfs.url` is itself evidence of LFS use — so waving
/// the push through on the filter alone skipped the one endpoint this guard
/// exists to judge, exactly where it differs from the git remote the push gate
/// already judged. The endpoint is resolved first for that reason; when one is
/// resolvable it is judged whether or not a filter is in force, and a repository
/// with neither pays nothing beyond the resolution.
///
/// Shaped exactly like `security::guard_remote_for`, and for the same reason:
/// offline mode used to answer here BEFORE the endpoint was resolved
/// (`check(&settings, None)`), so with offline mode on this refused every push
/// in every repository — LFS or not — after each push path's own remote gate
/// had already permitted it. A push to `/mnt/usb/app.git` was refused by this
/// guard alone, and a local `lfs.url` could never take the local-target
/// carve-out `check` makes. Only a path with a policy in force pays for the
/// resolution.
pub(crate) fn guard_lfs_upload(path: &str, remote: Option<&str>) -> Result<()> {
    let settings = crate::services::security::global().snapshot();
    if !settings.offline_mode && settings.remote_allowlist.is_empty() {
        return Ok(());
    }
    let repo_path = Path::new(path);
    // The hook is handed the remote git resolved for the push, so with none
    // named the destination is the push remote, not git-lfs's own default.
    let push_remote = match remote {
        Some(name) => name.to_string(),
        None => {
            let repo = git2::Repository::open(repo_path)?;
            crate::commands::remote::resolve_push_remote(&repo, None)
        }
    };
    let endpoint = resolve_lfs_endpoint(repo_path, LfsOperation::Upload, Some(&push_remote));
    // Nothing to contact and no filter in force: this push uploads no LFS
    // object, and refusing on a target that does not exist would refuse every
    // push in every repository — which is the defect this guard's shape was
    // rewritten to stop.
    if endpoint.is_none() && !is_lfs_enabled(repo_path) {
        return Ok(());
    }
    crate::services::security::check(&settings, endpoint.as_deref())
}

/// The offline/allowlist gate for an LFS transfer, judged on the endpoint
/// git-lfs will contact rather than on the git remote.
///
/// Nothing is resolved until a policy is in force, exactly as
/// `security::guard_remote_for` does — and then the endpoint IS resolved, even
/// under offline mode. Answering `check(&settings, None)` there refused a
/// transfer to a local `lfs.url` (`/srv/lfs`, `file:///…`) that opens no
/// socket, which is the one thing the local-target carve-out exists to stop.
///
/// Unlike [`guard_lfs_upload`] this does NOT wave through a repository with no
/// LFS filter in force: this is the ONLY gate on `lfs_pull`/`lfs_fetch`, which
/// the user invoked as LFS transfers, and a repository can hold LFS pointers
/// that `is_lfs_enabled` does not see. There is no second gate behind it.
fn guard_lfs_transfer(path: &str) -> Result<()> {
    let settings = crate::services::security::global().snapshot();
    if !settings.offline_mode && settings.remote_allowlist.is_empty() {
        return Ok(());
    }
    let endpoint = resolve_lfs_endpoint(Path::new(path), LfsOperation::Download, None);
    crate::services::security::check(&settings, endpoint.as_deref())
}

/// The URL an LFS transfer in this repository will contact, for the
/// frontend's half of the gate — so its allowlist toast can name the LFS
/// endpoint a committed `.lfsconfig` chose, rather than the git remote it
/// would otherwise (wrongly) judge. `None` when no endpoint can be resolved.
#[command]
pub async fn get_lfs_endpoint(path: String) -> Result<Option<String>> {
    Ok(resolve_lfs_endpoint(
        Path::new(&path),
        LfsOperation::Download,
        None,
    ))
}

/// URL of the remote `git lfs` will talk to: the current branch's upstream
/// remote, else `origin`, matching how git-lfs itself picks one.
///
/// Used only to scope the injected credential helper. `None` — an unborn or
/// detached HEAD with no `origin`, or an unreadable repository — installs no
/// helper at all, which is the safe direction: the transfer fails to
/// authenticate instead of offering the token to an unknown host.
fn lfs_remote_url(repo_path: &Path) -> Option<String> {
    let repo = git2::Repository::open(repo_path).ok()?;

    let head = repo.head().ok();
    let upstream_remote = head
        .as_ref()
        .filter(|head| head.is_branch())
        .and_then(|head| head.name().ok())
        .and_then(|ref_name| repo.branch_upstream_remote(ref_name).ok())
        .and_then(|buf| buf.as_str().ok().map(|name| name.to_owned()));

    let remote_name = upstream_remote.unwrap_or_else(|| "origin".to_owned());

    let remote = repo.find_remote(&remote_name).ok()?;
    remote.url().ok().map(|url| url.to_owned())
}

/// Build the `git lfs <args>` invocation, optionally authenticated.
///
/// `git lfs` resolves credentials by shelling out to `git credential`, which
/// inherits this process's environment — so the helper installed here reaches
/// the LFS API endpoint as well as the transfer itself.
///
/// That reach is exactly why the helper is scoped to the remote's host. The LFS
/// endpoint is NOT necessarily the remote: git-lfs reads `lfs.url` from
/// `.lfsconfig`, a file committed to the repository, so the host git asks about
/// is attacker-controlled in any repo the user merely cloned.
fn build_lfs_command(
    repo_path: &Path,
    args: &[&str],
    token: Option<&str>,
) -> crate::utils::GitCommand {
    build_lfs_command_in(repo_path, None, args, token)
}

/// [`build_lfs_command`] for a run that must happen in a subdirectory of the
/// repository.
///
/// `subdir` becomes `git -C <subdir>` rather than the process's working
/// directory, because the working directory is what the Output panel files the
/// row under: a run made from `<repo>/<subdir>` is attributed to a path no
/// panel renders (`lv-output-panel` keeps only rows whose repository is the
/// open one), so the user is left with the generic IPC row and never sees the
/// invocation. `-C` is a global option applied before git reads anything, so
/// the run itself is unchanged and the rendered line stays honest.
fn build_lfs_command_in(
    repo_path: &Path,
    subdir: Option<&str>,
    args: &[&str],
    token: Option<&str>,
) -> crate::utils::GitCommand {
    let mut cmd = create_command("git");
    cmd.current_dir(repo_path);
    if let Some(subdir) = subdir.filter(|value| !value.is_empty()) {
        cmd.arg("-C").arg(subdir);
    }
    cmd.arg("lfs").args(args);

    if let Some(token_value) = token {
        if let Some(remote_url) = lfs_remote_url(repo_path) {
            apply_token_credential_helper(&mut cmd, token_value, &remote_url);
        }
    }

    cmd
}

/// Helper to run git-lfs commands
fn run_lfs_command(repo_path: &Path, args: &[&str]) -> Result<String> {
    run_lfs_command_with_token(repo_path, args, None)
}

/// [`run_lfs_command`] for a run that belongs in a subdirectory. See
/// [`build_lfs_command_in`] for why this is `-C` and not a working directory.
fn run_lfs_command_in(repo_path: &Path, subdir: &str, args: &[&str]) -> Result<String> {
    finish_lfs_command(build_lfs_command_in(repo_path, Some(subdir), args, None))
}

/// Helper to run git-lfs commands against an authenticated remote
fn run_lfs_command_with_token(
    repo_path: &Path,
    args: &[&str],
    token: Option<&str>,
) -> Result<String> {
    finish_lfs_command(build_lfs_command(repo_path, args, token))
}

fn finish_lfs_command(mut command: crate::utils::GitCommand) -> Result<String> {
    let output = command
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run git-lfs: {}", e)))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(stdout.trim().to_string())
    } else {
        Err(GitnadoError::OperationFailed(
            if stderr.is_empty() { stdout } else { stderr }
                .trim()
                .to_string(),
        ))
    }
}

/// Check if Git LFS is installed
fn is_lfs_installed() -> bool {
    create_command("git")
        .arg("lfs")
        .arg("version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Whether an attributes file's contents turn the LFS filter on for some
/// pattern. Comment lines do not count: a commented-out rule is not config.
fn enables_lfs(content: &str) -> bool {
    content.lines().any(|line| {
        let line = line.trim();
        !line.starts_with('#') && line.contains("filter=lfs")
    })
}

/// Whether the attributes file at `path` enables LFS. A missing or unreadable
/// file simply does not.
fn file_enables_lfs(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|c| enables_lfs(&c))
        .unwrap_or(false)
}

/// Whether LFS is configured for this repository.
///
/// Git reads attributes from a `.gitattributes` in every directory of the
/// tree, not just the root, plus `.git/info/attributes`. A monorepo that keeps
/// its rules in e.g. `assets/.gitattributes` is an LFS repo just the same;
/// looking only at the root file reported those repos as "not configured",
/// which hid the file list and the pull/prune actions in the UI.
fn is_lfs_enabled(repo_path: &Path) -> bool {
    // The root file is read straight from disk: `git lfs track` writes it long
    // before it is ever committed.
    if file_enables_lfs(&repo_path.join(".gitattributes")) {
        return true;
    }

    let Ok(repo) = git2::Repository::open(repo_path) else {
        return false;
    };

    // Not part of the tree; repo.path() resolves the git dir for linked
    // worktrees too.
    if file_enables_lfs(&repo.path().join("info").join("attributes")) {
        return true;
    }

    // Nested attributes files, taken from the index rather than a directory
    // walk: it costs no directory IO and still sees files that are not checked
    // out. The working-tree copy is what git actually applies, so when the file
    // is there it is the only thing consulted -- `git lfs untrack` empties a
    // rule long before that removal is committed, and falling through to the
    // old blob would keep reporting the repo as configured. The committed blob
    // is only for entries with no file on disk at all (sparse/partial clones).
    let Ok(index) = repo.index() else {
        return false;
    };
    index.iter().any(|entry| {
        let rel = String::from_utf8_lossy(&entry.path).to_string();
        let rel = Path::new(&rel);
        if rel.file_name() != Some(std::ffi::OsStr::new(".gitattributes")) {
            return false;
        }
        let checked_out = repo_path.join(rel);
        if checked_out.exists() {
            return file_enables_lfs(&checked_out);
        }
        repo.find_blob(entry.id)
            .map(|b| enables_lfs(&String::from_utf8_lossy(b.content())))
            .unwrap_or(false)
    })
}

/// The pattern a `git lfs track` listing line reports, and the attributes file
/// that defines it. Lines look like `    assets/*.psd (assets/.gitattributes)`,
/// optionally with a ` [lockable]` marker before the source.
fn parse_track_line(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    let (left, source) = line.rsplit_once('(')?;
    let source = source.strip_suffix(')')?.trim();
    let pattern = left.split_whitespace().next()?;
    Some((pattern, source))
}

/// Whether a `git lfs track` listing still reports `pattern`.
fn lists_pattern(track_output: &str, pattern: &str) -> bool {
    track_output
        .lines()
        .any(|line| parse_track_line(line).is_some_and(|(listed, _)| listed == pattern))
}

/// Where `git lfs untrack` has to run to remove `pattern`, and the pattern as
/// written in the attributes file it lives in.
///
/// `git lfs track` reports patterns relative to the repository root and names
/// the file that defines each one, so a rule written as `*.psd` in
/// `assets/.gitattributes` is listed as `assets/*.psd`. `git lfs untrack` only
/// rewrites the `.gitattributes` in its own working directory, and matches
/// lines by the pattern exactly as written there. Run from the root with the
/// listed name it therefore rewrites the root file, leaves the nested rule
/// alone and still exits 0 -- which is what made Remove report success and
/// change nothing.
///
/// Returns the directory relative to the repository root ("" for the root
/// itself) and the pattern to pass. `None` when the listing does not mention
/// the pattern, or when it comes from inside the git directory
/// (`.git/info/attributes`), which `git lfs untrack` cannot rewrite at all --
/// the caller falls back to the root and the check afterwards reports the
/// pattern is still tracked.
fn resolve_untrack_target(track_output: &str, pattern: &str) -> Option<(String, String)> {
    let source = track_output.lines().find_map(|line| {
        parse_track_line(line).and_then(|(listed, source)| (listed == pattern).then_some(source))
    })?;

    let dir = Path::new(source)
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();

    if dir.is_empty() || dir == "." {
        return Some((String::new(), pattern.to_string()));
    }

    if dir == ".git" || dir.starts_with(".git/") {
        return None;
    }

    let raw = pattern
        .strip_prefix(&format!("{}/", dir))
        .unwrap_or(pattern)
        .to_string();
    Some((dir, raw))
}

/// Get LFS version
fn get_lfs_version() -> Option<String> {
    create_command("git")
        .arg("lfs")
        .arg("version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .lines()
                .next()
                .unwrap_or("")
                .to_string()
        })
}

/// Get LFS status for the repository
#[command]
pub async fn get_lfs_status(path: String) -> Result<LfsStatus> {
    let repo_path = Path::new(&path);
    let installed = is_lfs_installed();
    let version = get_lfs_version();

    if !installed {
        return Ok(LfsStatus {
            installed: false,
            version: None,
            enabled: false,
            patterns: Vec::new(),
            file_count: 0,
            total_size: 0,
        });
    }

    // Check if LFS is enabled (attributes anywhere in the repo, not just root)
    let enabled = is_lfs_enabled(repo_path);

    // Get tracked patterns
    let patterns = if enabled {
        run_lfs_command(repo_path, &["track"])
            .ok()
            .map(|output| {
                output
                    .lines()
                    .filter_map(|line| {
                        // Lines like "    *.psd (.gitattributes)"
                        let line = line.trim();
                        if line.starts_with('*') || line.contains('.') {
                            Some(LfsPattern {
                                pattern: line.split_whitespace().next().unwrap_or(line).to_string(),
                            })
                        } else {
                            None
                        }
                    })
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    // Get file count and size
    let (file_count, total_size) = if enabled {
        run_lfs_command(repo_path, &["ls-files", "-s"])
            .ok()
            .map(|output| {
                let mut count = 0u32;
                let mut size = 0u64;
                for line in output.lines() {
                    // Format: "oid - path (size)"
                    count += 1;
                    // Try to extract size from parentheses
                    if let Some(size_start) = line.rfind('(') {
                        if let Some(size_str) = line[size_start + 1..].strip_suffix(')') {
                            size += parse_size(size_str);
                        }
                    }
                }
                (count, size)
            })
            .unwrap_or((0, 0))
    } else {
        (0, 0)
    };

    Ok(LfsStatus {
        installed,
        version,
        enabled,
        patterns,
        file_count,
        total_size,
    })
}

/// Parse size string like "1.5 MB" or "500 KB"
fn parse_size(s: &str) -> u64 {
    let s = s.trim();
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 2 {
        return 0;
    }

    let num: f64 = parts[0].parse().unwrap_or(0.0);
    let unit = parts[1].to_uppercase();

    let multiplier = match unit.as_str() {
        "B" => 1,
        "KB" => 1024,
        "MB" => 1024 * 1024,
        "GB" => 1024 * 1024 * 1024,
        _ => 1,
    };

    (num * multiplier as f64) as u64
}

/// Initialize Git LFS in the repository
#[command]
pub async fn init_lfs(path: String) -> Result<()> {
    let repo_path = Path::new(&path);

    if !is_lfs_installed() {
        return Err(GitnadoError::OperationFailed(
            "Git LFS is not installed. Please install it first.".to_string(),
        ));
    }

    run_lfs_command(repo_path, &["install"])?;
    Ok(())
}

/// Track files matching a pattern with LFS
#[command]
pub async fn lfs_track(path: String, pattern: String) -> Result<()> {
    let repo_path = Path::new(&path);
    run_lfs_command(repo_path, &["track", &pattern])?;
    Ok(())
}

/// Untrack a file pattern from LFS
#[command]
pub async fn lfs_untrack(path: String, pattern: String) -> Result<()> {
    let repo_path = Path::new(&path);

    // A rule defined in a nested `.gitattributes` has to be removed from the
    // directory that defines it -- see `resolve_untrack_target`. When the
    // listing is unavailable, or does not name the pattern, fall back to the
    // repository root, which is where every pattern used to be removed from.
    let (dir, raw) = run_lfs_command(repo_path, &["track"])
        .ok()
        .and_then(|output| resolve_untrack_target(&output, &pattern))
        .unwrap_or_else(|| (String::new(), pattern.clone()));

    // `-C <dir>`, not a working directory below the repository: the row has to
    // be filed under the repository the user has open or the panel drops it.
    run_lfs_command_in(repo_path, &dir, &["untrack", &raw])?;

    // `git lfs untrack` rewrites the attributes file in its working directory
    // and exits 0 even when it matched nothing, so a success here is not proof
    // the rule is gone. Confirm it, rather than letting the dialog report
    // "No longer tracking ..." over a pattern that is still there.
    if let Ok(output) = run_lfs_command(repo_path, &["track"]) {
        if lists_pattern(&output, &pattern) {
            return Err(GitnadoError::OperationFailed(format!(
                "{} is still tracked. Remove it from the .gitattributes that defines it.",
                pattern
            )));
        }
    }

    Ok(())
}

/// Get list of LFS files in the repository
#[command]
pub async fn get_lfs_files(path: String) -> Result<Vec<LfsFile>> {
    let repo_path = Path::new(&path);

    let output = run_lfs_command(repo_path, &["ls-files", "-l"])?;

    let files = output
        .lines()
        .filter_map(|line| {
            // Format: "oid * path" or "oid - path"
            let parts: Vec<&str> = line.splitn(3, ' ').collect();
            if parts.len() >= 3 {
                let oid = parts[0].to_string();
                let downloaded = parts[1] == "*";
                let file_path = parts[2].to_string();

                Some(LfsFile {
                    path: file_path,
                    oid: Some(oid),
                    size: None,
                    downloaded,
                })
            } else {
                None
            }
        })
        .collect();

    Ok(files)
}

/// Pull (download) LFS files
#[command]
pub async fn lfs_pull(path: String, token: Option<String>) -> Result<String> {
    // Behind the same offline/allowlist gate as fetch and pull — judged on
    // the LFS endpoint, not the git remote; see `resolve_lfs_endpoint`.
    guard_lfs_transfer(&path)?;
    let repo_path = Path::new(&path);

    run_lfs_command_with_token(repo_path, &["pull"], token.as_deref())
}

/// Fetch LFS files from remote
#[command]
pub async fn lfs_fetch(
    path: String,
    refs: Option<Vec<String>>,
    token: Option<String>,
) -> Result<String> {
    guard_lfs_transfer(&path)?;
    let repo_path = Path::new(&path);
    let token = token.as_deref();

    let mut args = vec!["fetch"];

    let refs_owned: Vec<String>;
    if let Some(r) = refs {
        refs_owned = r;
        for ref_name in &refs_owned {
            args.push(ref_name);
        }
    }

    run_lfs_command_with_token(repo_path, &args, token)
}

/// Prune old LFS files
#[command]
pub async fn lfs_prune(path: String, dry_run: Option<bool>) -> Result<String> {
    let repo_path = Path::new(&path);

    let mut args = vec!["prune"];

    if dry_run.unwrap_or(false) {
        args.push("--dry-run");
    }

    run_lfs_command(repo_path, &args)
}

/// Migrate existing files to LFS
#[command]
pub async fn lfs_migrate(
    path: String,
    pattern: String,
    include_refs: Option<Vec<String>>,
) -> Result<String> {
    let repo_path = Path::new(&path);

    let include_arg = format!("--include={}", pattern);
    let mut args = vec!["migrate", "import", &include_arg];

    // Add refs if specified
    let refs_owned: Vec<String>;
    if let Some(refs) = include_refs {
        refs_owned = refs;
        for r in &refs_owned {
            args.push(r);
        }
    }

    run_lfs_command(repo_path, &args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[test]
    fn test_parse_size_bytes() {
        assert_eq!(parse_size("100 B"), 100);
    }

    #[test]
    fn test_parse_size_kilobytes() {
        assert_eq!(parse_size("1 KB"), 1024);
        assert_eq!(parse_size("2 KB"), 2048);
    }

    #[test]
    fn test_parse_size_megabytes() {
        assert_eq!(parse_size("1 MB"), 1024 * 1024);
        assert_eq!(parse_size("1.5 MB"), (1.5 * 1024.0 * 1024.0) as u64);
    }

    #[test]
    fn test_parse_size_gigabytes() {
        assert_eq!(parse_size("1 GB"), 1024 * 1024 * 1024);
    }

    #[test]
    fn test_parse_size_invalid() {
        assert_eq!(parse_size("invalid"), 0);
        assert_eq!(parse_size(""), 0);
        assert_eq!(parse_size("100"), 0); // Missing unit
    }

    #[test]
    fn test_parse_size_whitespace() {
        assert_eq!(parse_size("  100 KB  "), 100 * 1024);
    }

    #[tokio::test]
    async fn test_get_lfs_status_no_lfs() {
        let repo = TestRepo::with_initial_commit();

        let result = get_lfs_status(repo.path_str()).await;
        assert!(result.is_ok());

        let status = result.unwrap();
        // LFS might or might not be installed on the test system
        // but the function should not fail
        if !status.installed {
            assert!(!status.enabled);
            assert!(status.patterns.is_empty());
            assert_eq!(status.file_count, 0);
            assert_eq!(status.total_size, 0);
        }
    }

    #[tokio::test]
    async fn test_get_lfs_status_with_gitattributes() {
        let repo = TestRepo::with_initial_commit();

        // Create a .gitattributes file with LFS filter
        repo.create_file(
            ".gitattributes",
            "*.bin filter=lfs diff=lfs merge=lfs -text\n",
        );

        let result = get_lfs_status(repo.path_str()).await;
        assert!(result.is_ok());

        let status = result.unwrap();
        if status.installed {
            assert!(status.enabled);
        }
    }

    #[test]
    fn test_lfs_enabled_from_nested_gitattributes() {
        let repo = TestRepo::with_initial_commit();

        // Monorepo layout: the LFS rules live in a subdirectory, with no
        // .gitattributes at the repo root at all.
        repo.create_commit(
            "Track assets",
            &[(
                "assets/.gitattributes",
                "*.psd filter=lfs diff=lfs merge=lfs -text\n",
            )],
        );
        assert!(!repo.path.join(".gitattributes").exists());

        assert!(is_lfs_enabled(&repo.path));
    }

    #[test]
    fn test_lfs_enabled_from_nested_gitattributes_not_checked_out() {
        let repo = TestRepo::with_initial_commit();

        repo.create_commit(
            "Track assets",
            &[(
                "assets/.gitattributes",
                "*.psd filter=lfs diff=lfs merge=lfs -text\n",
            )],
        );

        // Sparse/partial checkout: the entry is in the index and the committed
        // tree, but there is no file on disk to read.
        std::fs::remove_file(repo.path.join("assets/.gitattributes")).unwrap();

        assert!(is_lfs_enabled(&repo.path));
    }

    #[test]
    fn test_lfs_enabled_from_info_attributes() {
        let repo = TestRepo::with_initial_commit();

        // Repo-local attributes, deliberately not part of the tree.
        std::fs::create_dir_all(repo.path.join(".git/info")).unwrap();
        std::fs::write(
            repo.path.join(".git/info/attributes"),
            "*.bin filter=lfs diff=lfs merge=lfs -text\n",
        )
        .unwrap();
        assert!(!repo.path.join(".gitattributes").exists());

        assert!(is_lfs_enabled(&repo.path));
    }

    #[test]
    fn test_lfs_enabled_from_root_gitattributes() {
        let repo = TestRepo::with_initial_commit();

        // Uncommitted, as `git lfs track` leaves it.
        repo.create_file(
            ".gitattributes",
            "*.bin filter=lfs diff=lfs merge=lfs -text\n",
        );

        assert!(is_lfs_enabled(&repo.path));
    }

    #[test]
    fn test_lfs_not_enabled_without_lfs_filter() {
        let repo = TestRepo::with_initial_commit();

        // Attributes files exist at the root and nested, but none of them
        // mention the LFS filter.
        repo.create_file(".gitattributes", "*.txt text\n");
        repo.create_commit("Docs attributes", &[("docs/.gitattributes", "*.md text\n")]);

        assert!(!is_lfs_enabled(&repo.path));
    }

    #[test]
    fn test_lfs_not_enabled_for_commented_out_filter() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file(
            ".gitattributes",
            "# *.psd filter=lfs diff=lfs merge=lfs -text\n",
        );

        assert!(!is_lfs_enabled(&repo.path));
    }

    #[test]
    fn test_lfs_not_enabled_when_nested_attributes_emptied_in_working_tree() {
        let repo = TestRepo::with_initial_commit();

        repo.create_commit(
            "Track assets",
            &[(
                "assets/.gitattributes",
                "*.psd filter=lfs diff=lfs merge=lfs -text\n",
            )],
        );

        // What `git lfs untrack` leaves behind: the file is still checked out,
        // the rule is gone, and the removal is not committed yet. The stale
        // blob must not keep the repo reading as configured.
        repo.create_file("assets/.gitattributes", "\n");

        assert!(!is_lfs_enabled(&repo.path));
    }

    #[test]
    fn test_lfs_not_enabled_when_root_attributes_emptied_in_working_tree() {
        let repo = TestRepo::with_initial_commit();

        repo.create_commit(
            "Track binaries",
            &[(
                ".gitattributes",
                "*.bin filter=lfs diff=lfs merge=lfs -text\n",
            )],
        );

        repo.create_file(".gitattributes", "*.txt text\n");

        assert!(!is_lfs_enabled(&repo.path));
    }

    #[test]
    fn test_parse_track_line_root_and_nested() {
        assert_eq!(
            parse_track_line("    *.psd (.gitattributes)"),
            Some(("*.psd", ".gitattributes"))
        );
        assert_eq!(
            parse_track_line("    assets/*.psd (assets/.gitattributes)"),
            Some(("assets/*.psd", "assets/.gitattributes"))
        );
        assert_eq!(
            parse_track_line("    assets/*.psd [lockable] (assets/.gitattributes)"),
            Some(("assets/*.psd", "assets/.gitattributes"))
        );
        assert_eq!(parse_track_line("Listing tracked patterns"), None);
        assert_eq!(parse_track_line(""), None);
    }

    #[test]
    fn test_resolve_untrack_target_nested_runs_from_defining_directory() {
        let output = "Listing tracked patterns\n    *.bin (.gitattributes)\n    assets/*.psd (assets/.gitattributes)\n";

        // The listed name is repo-relative; the file itself says "*.psd".
        assert_eq!(
            resolve_untrack_target(output, "assets/*.psd"),
            Some(("assets".to_string(), "*.psd".to_string()))
        );
    }

    #[test]
    fn test_resolve_untrack_target_deeply_nested() {
        let output = "    a/b/c/*.psd (a/b/c/.gitattributes)\n";

        assert_eq!(
            resolve_untrack_target(output, "a/b/c/*.psd"),
            Some(("a/b/c".to_string(), "*.psd".to_string()))
        );
    }

    #[test]
    fn test_resolve_untrack_target_root_stays_at_root() {
        let output = "Listing tracked patterns\n    *.bin (.gitattributes)\n";

        assert_eq!(
            resolve_untrack_target(output, "*.bin"),
            Some((String::new(), "*.bin".to_string()))
        );
    }

    #[test]
    fn test_resolve_untrack_target_lockable_pattern() {
        let output = "    assets/*.psd [lockable] (assets/.gitattributes)\n";

        assert_eq!(
            resolve_untrack_target(output, "assets/*.psd"),
            Some(("assets".to_string(), "*.psd".to_string()))
        );
    }

    #[test]
    fn test_resolve_untrack_target_unknown_pattern() {
        let output = "Listing tracked patterns\n    *.bin (.gitattributes)\n";

        // Nothing to redirect to; the caller falls back to the repository root.
        assert_eq!(resolve_untrack_target(output, "*.psd"), None);
    }

    #[test]
    fn test_resolve_untrack_target_ignores_git_dir_source() {
        // `.git/info/attributes` is not a file `git lfs untrack` can rewrite,
        // and its directory is not a place to run from.
        let output = "    .git/info/*.psd (.git/info/attributes)\n";

        assert_eq!(resolve_untrack_target(output, ".git/info/*.psd"), None);
    }

    #[test]
    fn test_lists_pattern() {
        let output = "Listing tracked patterns\n    *.bin (.gitattributes)\n    assets/*.psd (assets/.gitattributes)\n";

        assert!(lists_pattern(output, "*.bin"));
        assert!(lists_pattern(output, "assets/*.psd"));
        assert!(!lists_pattern(output, "*.psd"));
        assert!(!lists_pattern(output, ""));
        assert!(!lists_pattern("", "*.bin"));
    }

    #[test]
    fn test_lfs_enabled_false_for_missing_repo() {
        assert!(!is_lfs_enabled(std::path::Path::new("/nonexistent/path")));
    }

    #[tokio::test]
    async fn test_get_lfs_status_invalid_path() {
        let result = get_lfs_status("/nonexistent/path".to_string()).await;
        // Should return status with installed info but not crash
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_init_lfs_when_not_installed() {
        let repo = TestRepo::with_initial_commit();

        let result = init_lfs(repo.path_str()).await;
        // Result depends on whether LFS is installed on the system
        // If not installed, should return error
        if !is_lfs_installed() {
            assert!(result.is_err());
            let err = result.unwrap_err();
            assert!(err.to_string().contains("not installed"));
        }
    }

    #[tokio::test]
    async fn test_lfs_track_pattern() {
        let repo = TestRepo::with_initial_commit();

        // Skip if LFS is not installed
        if !is_lfs_installed() {
            return;
        }

        // Initialize LFS first
        let _ = init_lfs(repo.path_str()).await;

        let result = lfs_track(repo.path_str(), "*.bin".to_string()).await;
        assert!(result.is_ok());

        // Verify the pattern was added to .gitattributes
        let gitattributes = std::fs::read_to_string(repo.path.join(".gitattributes"));
        assert!(gitattributes.is_ok());
        assert!(gitattributes.unwrap().contains("*.bin filter=lfs"));
    }

    #[tokio::test]
    async fn test_lfs_untrack_pattern() {
        let repo = TestRepo::with_initial_commit();

        // Skip if LFS is not installed
        if !is_lfs_installed() {
            return;
        }

        // Initialize and track a pattern first
        let _ = init_lfs(repo.path_str()).await;
        let _ = lfs_track(repo.path_str(), "*.bin".to_string()).await;

        let result = lfs_untrack(repo.path_str(), "*.bin".to_string()).await;
        assert!(result.is_ok());

        // Verify the pattern was removed from .gitattributes
        let gitattributes = std::fs::read_to_string(repo.path.join(".gitattributes"));
        assert!(gitattributes.is_ok());
        assert!(!gitattributes.unwrap().contains("*.bin filter=lfs"));
    }

    #[tokio::test]
    async fn test_get_lfs_files_empty_repo() {
        let repo = TestRepo::with_initial_commit();

        // Skip if LFS is not installed
        if !is_lfs_installed() {
            return;
        }

        let result = get_lfs_files(repo.path_str()).await;
        // Should either succeed with empty list or fail gracefully
        if let Ok(files) = result {
            assert!(files.is_empty());
        }
    }

    #[tokio::test]
    async fn test_lfs_prune_dry_run() {
        let repo = TestRepo::with_initial_commit();

        // Skip if LFS is not installed
        if !is_lfs_installed() {
            return;
        }

        let _ = init_lfs(repo.path_str()).await;

        let result = lfs_prune(repo.path_str(), Some(true)).await;
        // Should succeed or fail gracefully (no LFS files to prune)
        // The command itself should not crash
        let _ = result;
    }

    #[tokio::test]
    async fn test_lfs_status_struct_serialization() {
        let status = LfsStatus {
            installed: true,
            version: Some("git-lfs/3.0.0".to_string()),
            enabled: true,
            patterns: vec![LfsPattern {
                pattern: "*.bin".to_string(),
            }],
            file_count: 5,
            total_size: 1024 * 1024,
        };

        let json = serde_json::to_string(&status);
        assert!(json.is_ok());
        let json_str = json.unwrap();
        assert!(json_str.contains("\"installed\":true"));
        assert!(json_str.contains("\"enabled\":true"));
        assert!(json_str.contains("\"fileCount\":5"));
        assert!(json_str.contains("\"totalSize\":1048576"));
    }

    #[tokio::test]
    async fn test_lfs_file_struct_serialization() {
        let file = LfsFile {
            path: "large-file.bin".to_string(),
            oid: Some("abc123".to_string()),
            size: Some(1024),
            downloaded: true,
        };

        let json = serde_json::to_string(&file);
        assert!(json.is_ok());
        let json_str = json.unwrap();
        assert!(json_str.contains("\"path\":\"large-file.bin\""));
        assert!(json_str.contains("\"downloaded\":true"));
    }

    #[tokio::test]
    async fn test_lfs_pattern_struct_serialization() {
        let pattern = LfsPattern {
            pattern: "*.psd".to_string(),
        };

        let json = serde_json::to_string(&pattern);
        assert!(json.is_ok());
        assert!(json.unwrap().contains("\"pattern\":\"*.psd\""));
    }

    /// A repo whose `origin` is an https remote — the host an injected
    /// credential helper is allowed to answer for.
    fn repo_with_https_origin() -> TestRepo {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://git.example.com/o/r.git");
        repo
    }

    /// Value of `key` in the env `cmd` will spawn with, as a String.
    fn env_of(cmd: &std::process::Command, key: &str) -> Option<String> {
        cmd.get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new(key))
            .and_then(|(_, v)| v)
            .map(|v| v.to_string_lossy().to_string())
    }

    #[test]
    fn test_lfs_pull_command_carries_the_token_credential_helper() {
        // The frontend looks the repo's credential up and sends it, so a pull
        // that drops it dead-ends on every private LFS remote: the child runs
        // unauthenticated with GIT_TERMINAL_PROMPT=0 and the dialog shows a raw
        // "could not read Username" in a repo the app can otherwise push.
        let repo = repo_with_https_origin();
        let cmd = build_lfs_command(&repo.path, &["pull"], Some("s3cr3t"));

        assert_eq!(
            env_of(&cmd, "GIT_CONFIG_COUNT").as_deref(),
            Some("2"),
            "a token must install exactly two config overrides: an empty \
             reset then the helper"
        );
        assert_eq!(
            env_of(&cmd, "GIT_CONFIG_KEY_0").as_deref(),
            Some("credential.https://git.example.com.helper"),
            "the override must be the credential helper git asks for auth, \
             scoped to the remote's own host"
        );
        assert_eq!(
            env_of(&cmd, "GITNADO_GIT_TOKEN").as_deref(),
            Some("s3cr3t"),
            "the helper reads the token from this env var"
        );

        // The token must reach git ONLY through the env var: argv is readable
        // by every other user on the machine.
        let helper = env_of(&cmd, "GIT_CONFIG_VALUE_1").expect("helper must be set");
        assert!(helper.contains("GITNADO_GIT_TOKEN"));
        assert!(!helper.contains("s3cr3t"));
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(args, vec!["lfs", "pull"]);
    }

    /// What real git answers when asked for a credential for `host`, given the
    /// environment `build_lfs_command` prepared. Env vars being present proves
    /// nothing if the helper string is not one git honours, and the scoping
    /// lives in a config key only git knows how to match — so ask git itself.
    ///
    /// This is exactly what `git lfs` does to authenticate: it shells out to
    /// `git credential fill` for its endpoint's host.
    #[cfg(unix)]
    fn credential_fill_for(repo: &TestRepo, host: &str) -> String {
        let built = build_lfs_command(&repo.path, &["pull"], Some("s3cr3t"));

        let mut probe = create_command("git");
        probe.current_dir(&repo.path);
        for (key, value) in built.get_envs() {
            if let Some(value) = value {
                probe.env(key, value);
            }
        }

        let mut child = probe
            .arg("credential")
            .arg("fill")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("git credential fill must start");
        {
            use std::io::Write;
            child
                .stdin
                .as_mut()
                .expect("stdin is piped")
                .write_all(format!("protocol=https\nhost={}\n\n", host).as_bytes())
                .expect("the request must be writable");
        }
        let out = child.wait_with_output().expect("git must terminate");
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    #[cfg(unix)]
    #[test]
    fn test_injected_helper_answers_git_with_the_token() {
        let repo = repo_with_https_origin();
        let stdout = credential_fill_for(&repo, "git.example.com");

        assert!(
            stdout.contains("password=s3cr3t"),
            "git must resolve the token as the password, got: {}",
            stdout
        );
        assert!(stdout.contains("username=git"), "got: {}", stdout);
    }

    #[cfg(unix)]
    #[test]
    fn test_injected_helper_refuses_a_foreign_lfs_host() {
        // The endpoint `git lfs` authenticates against is NOT necessarily the
        // remote: it reads `lfs.url` from `.lfsconfig`, which is COMMITTED TO
        // THE REPOSITORY. Clone a hostile repo, click Pull, and an unscoped
        // `credential.helper` would hand that repo's own server the user's
        // provider token — a token that is usually good for every repo they can
        // reach. Committing the hostile `.lfsconfig` here as well, so the test
        // fails the way a user would actually be attacked.
        let repo = repo_with_https_origin();
        repo.create_commit(
            "add a hostile .lfsconfig",
            &[(
                ".lfsconfig",
                "[lfs]\n\turl = https://evil.example.net/o/r.git/info/lfs\n",
            )],
        );

        // A helper IS installed for this repo — otherwise the assertions below
        // would pass simply because nothing answered, proving nothing.
        let cmd = build_lfs_command(&repo.path, &["pull"], Some("s3cr3t"));
        assert_eq!(
            env_of(&cmd, "GITNADO_GIT_TOKEN").as_deref(),
            Some("s3cr3t"),
            "the token IS installed here; what follows is about who git offers it to"
        );

        let stdout = credential_fill_for(&repo, "evil.example.net");

        assert!(
            !stdout.contains("s3cr3t"),
            "the token must never be offered to a host the repository chose: {}",
            stdout
        );
        assert!(
            !stdout.contains("password="),
            "git must supply no password at all for a foreign host: {}",
            stdout
        );
    }

    #[test]
    fn test_ssh_remote_scopes_the_helper_to_the_provider_https_host() {
        // The LFS endpoint for a github.com repo is always https regardless of
        // the git remote's own transport, and the token is a PROVIDER
        // credential rather than a transport one — so an ssh origin must still
        // get a helper, scoped to that same provider over https, or a private
        // LFS repo cloned over ssh could never authenticate its LFS transfers.
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "git@github.com:o/r.git");

        let cmd = build_lfs_command(&repo.path, &["pull"], Some("s3cr3t"));

        assert_eq!(
            env_of(&cmd, "GIT_CONFIG_KEY_0").as_deref(),
            Some("credential.https://github.com.helper"),
            "an ssh remote must map to its provider's https host"
        );
        assert_eq!(env_of(&cmd, "GITNADO_GIT_TOKEN").as_deref(), Some("s3cr3t"));
    }

    #[test]
    fn test_repository_without_a_remote_installs_no_helper() {
        // Nothing says which host the token belongs to, so it must go nowhere.
        let repo = TestRepo::with_initial_commit();

        let cmd = build_lfs_command(&repo.path, &["pull"], Some("s3cr3t"));

        assert_eq!(env_of(&cmd, "GITNADO_GIT_TOKEN"), None);
        assert_eq!(env_of(&cmd, "GIT_CONFIG_KEY_0"), None);
    }

    #[test]
    fn test_lfs_fetch_with_refs_still_authenticates() {
        let repo = repo_with_https_origin();
        let cmd = build_lfs_command(&repo.path, &["fetch", "main"], Some("tok"));

        assert_eq!(
            env_of(&cmd, "GIT_CONFIG_KEY_0").as_deref(),
            Some("credential.https://git.example.com.helper"),
            "fetch shares the runner, so it must authenticate too"
        );

        // Authenticating must not disturb ref assembly.
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(args, vec!["lfs", "fetch", "main"]);
    }

    #[test]
    fn test_lfs_command_without_a_token_installs_no_helper() {
        // Local-only commands (prune, track, ls-files) must never override the
        // user's own credential helper.
        let repo = repo_with_https_origin();
        let cmd = build_lfs_command(&repo.path, &["prune"], None);

        for key in [
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_VALUE_0",
            "GITNADO_GIT_TOKEN",
        ] {
            assert_eq!(env_of(&cmd, key), None, "{} must not be set", key);
        }
    }

    #[test]
    fn test_blank_token_installs_no_helper() {
        // A helper answering with an empty password turns "no credentials" into
        // "login rejected" — a wronger error than no token at all.
        let repo = repo_with_https_origin();
        let cmd = build_lfs_command(&repo.path, &["pull"], Some("   "));

        for key in [
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_VALUE_0",
            "GITNADO_GIT_TOKEN",
        ] {
            assert_eq!(env_of(&cmd, key), None, "{} must not be set", key);
        }
    }

    #[tokio::test]
    async fn test_lfs_pull_error_does_not_leak_the_token() {
        // No remote is configured, so this pull fails (with git's "not a git
        // command" where LFS is absent). Either way the text goes straight to
        // the dialog's error banner, so it must never carry the token.
        //
        // Deliberately not gated on is_lfs_installed(): the leak guard is worth
        // more when it actually runs, and both failure modes exercise it.
        let repo = TestRepo::with_initial_commit();

        let result = lfs_pull(repo.path_str(), Some("s3cr3t".to_string())).await;

        let text = match result {
            Ok(output) => output,
            Err(err) => {
                let message = err.to_string();
                assert!(!message.is_empty(), "the failure must say something");
                message
            }
        };
        assert!(
            !text.contains("s3cr3t"),
            "the token must not reach a user-visible message: {}",
            text
        );
    }

    // ---- the allowlist judges the LFS endpoint, not the git remote ----
    //
    // git-lfs resolves its endpoint from `lfs.url` / `remote.<r>.lfsurl`,
    // both of which a committed `.lfsconfig` may set, and only then from the
    // git remote. A gate on the git remote alone therefore let a github.com
    // clone transfer to whatever host its `.lfsconfig` named.

    use crate::services::security::test_support;

    fn blocked_message<T: std::fmt::Debug>(result: Result<T>) -> String {
        match result {
            Err(GitnadoError::NetworkBlocked(message)) => message,
            other => panic!("expected a NetworkBlocked refusal, got {:?}", other),
        }
    }

    fn assert_not_blocked<T: std::fmt::Debug>(result: &Result<T>, what: &str) {
        assert!(
            !matches!(result, Err(GitnadoError::NetworkBlocked(_))),
            "{} must not be refused by the gate, got {:?}",
            what,
            result
        );
    }

    const HOSTILE_LFSCONFIG: &str = "[lfs]\n\turl = https://evil.example.net/o/r.git/info/lfs\n";

    #[tokio::test]
    async fn a_committed_lfsconfig_pointing_off_the_allowlist_is_refused() {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://github.com/o/r.git");
        repo.create_commit("hostile .lfsconfig", &[(".lfsconfig", HOSTILE_LFSCONFIG)]);
        let _guard = test_support::allowlist(&["github.com"]);

        let message = blocked_message(lfs_pull(repo.path_str(), None).await);
        assert!(
            message.contains("evil.example.net"),
            "the refusal should name the LFS host, got: {}",
            message
        );
        let message = blocked_message(lfs_fetch(repo.path_str(), None, None).await);
        assert!(message.contains("evil.example.net"), "got: {}", message);
    }

    #[tokio::test]
    async fn a_lfsconfig_present_only_in_the_index_or_head_still_counts() {
        // git-lfs falls back to the index's copy, then HEAD's, when the
        // working-tree file is missing — so deleting it locally must not open
        // the gate.
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://github.com/o/r.git");
        repo.create_commit("hostile .lfsconfig", &[(".lfsconfig", HOSTILE_LFSCONFIG)]);
        std::fs::remove_file(repo.path.join(".lfsconfig")).unwrap();
        let _guard = test_support::allowlist(&["github.com"]);

        let message = blocked_message(lfs_pull(repo.path_str(), None).await);
        assert!(
            message.contains("evil.example.net"),
            "index copy: {}",
            message
        );

        // Gone from the index too: HEAD still has it.
        {
            let git_repo = repo.repo();
            let mut index = git_repo.index().unwrap();
            index.remove_path(Path::new(".lfsconfig")).unwrap();
            index.write().unwrap();
        }
        let message = blocked_message(lfs_pull(repo.path_str(), None).await);
        assert!(
            message.contains("evil.example.net"),
            "HEAD copy: {}",
            message
        );
    }

    #[tokio::test]
    async fn a_remote_lfsurl_off_the_allowlist_is_refused() {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://github.com/o/r.git");
        repo.repo()
            .config()
            .unwrap()
            .set_str("remote.origin.lfsurl", "https://evil.example.net/lfs")
            .unwrap();
        let _guard = test_support::allowlist(&["github.com"]);

        let message = blocked_message(lfs_pull(repo.path_str(), None).await);
        assert!(message.contains("evil.example.net"), "got: {}", message);
    }

    #[tokio::test]
    async fn with_no_lfs_override_the_git_remote_is_judged_as_before() {
        let allowed = TestRepo::with_initial_commit();
        allowed.add_remote("origin", "https://github.com/o/r.git");
        let refused = TestRepo::with_initial_commit();
        refused.add_remote("origin", "https://gitlab.com/o/r.git");
        let _guard = test_support::allowlist(&["github.com"]);

        // Passes the gate, then fails or succeeds on git-lfs itself — either
        // way not a NetworkBlocked.
        assert_not_blocked(
            &lfs_pull(allowed.path_str(), None).await,
            "an LFS pull whose only endpoint is the allowlisted remote",
        );
        let message = blocked_message(lfs_pull(refused.path_str(), None).await);
        assert!(message.contains("gitlab.com"), "got: {}", message);
    }

    #[tokio::test]
    async fn offline_mode_refuses_a_transfer_whose_endpoint_cannot_be_resolved() {
        let _guard = test_support::offline();

        // `guard_lfs_transfer` DOES resolve under offline mode, deliberately:
        // answering `check(&settings, None)` ahead of the lookup refused a
        // transfer to a local `lfs.url` (`/srv/lfs`, `file:///…`) that opens
        // no socket, which is the one thing the local-target carve-out exists
        // to stop. So this test does NOT say offline mode answers before
        // anything is looked at — "restoring" that would reinstate the defect
        // the guard's shape was rewritten to fix. It pins the other half of
        // that design: a resolution yielding NOTHING fails closed. Not a
        // repository at all, so no endpoint resolves, no local-target
        // carve-out applies, and offline mode refuses.
        let result = lfs_pull("/definitely/not/a/repository".to_string(), None).await;
        blocked_message(result);
        let result = lfs_fetch("/definitely/not/a/repository".to_string(), None, None).await;
        blocked_message(result);
    }

    // ---- resolve_lfs_endpoint follows git-lfs's own order ----

    #[test]
    fn git_config_overrides_a_committed_lfsconfig() {
        // "Settings from Git configuration files override the .lfsconfig
        // file" — so a user's local `lfs.url` wins over the repository's.
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://github.com/o/r.git");
        repo.create_commit("hostile .lfsconfig", &[(".lfsconfig", HOSTILE_LFSCONFIG)]);
        assert_eq!(
            resolve_lfs_endpoint(&repo.path, LfsOperation::Download, None).as_deref(),
            Some("https://evil.example.net/o/r.git/info/lfs")
        );

        repo.repo()
            .config()
            .unwrap()
            .set_str("lfs.url", "https://lfs.corp.example/o/r")
            .unwrap();
        assert_eq!(
            resolve_lfs_endpoint(&repo.path, LfsOperation::Download, None).as_deref(),
            Some("https://lfs.corp.example/o/r")
        );
    }

    #[test]
    fn the_remote_is_the_branch_remote_then_lfsdefault_then_the_sole_remote_then_origin() {
        let repo = TestRepo::with_initial_commit();

        // The only remote wins over "origin" when origin does not exist.
        repo.add_remote("upstream", "https://github.com/up/r.git");
        assert_eq!(
            resolve_lfs_endpoint(&repo.path, LfsOperation::Download, None).as_deref(),
            Some("https://github.com/up/r.git")
        );

        // With several remotes and nothing else configured, origin.
        repo.add_remote("origin", "https://github.com/o/r.git");
        assert_eq!(
            resolve_lfs_endpoint(&repo.path, LfsOperation::Download, None).as_deref(),
            Some("https://github.com/o/r.git")
        );

        // remote.lfsdefault beats origin...
        let git_repo = repo.repo();
        let mut cfg = git_repo.config().unwrap();
        cfg.set_str("remote.lfsdefault", "upstream").unwrap();
        assert_eq!(
            resolve_lfs_endpoint(&repo.path, LfsOperation::Download, None).as_deref(),
            Some("https://github.com/up/r.git")
        );

        // ...and the current branch's tracking remote beats lfsdefault, with
        // that remote's lfsurl taking precedence over its clone url.
        repo.add_remote("fork", "https://github.com/me/r.git");
        let branch = repo.current_branch();
        cfg.set_str(&format!("branch.{}.remote", branch), "fork")
            .unwrap();
        cfg.set_str("remote.fork.lfsurl", "https://lfs.fork.example/me/r")
            .unwrap();
        assert_eq!(
            resolve_lfs_endpoint(&repo.path, LfsOperation::Download, None).as_deref(),
            Some("https://lfs.fork.example/me/r")
        );
    }

    #[test]
    fn a_repository_with_no_remote_and_no_override_has_no_endpoint() {
        // Nothing names a host, so the gate fails closed rather than guessing.
        let repo = TestRepo::with_initial_commit();
        assert_eq!(
            resolve_lfs_endpoint(&repo.path, LfsOperation::Download, None),
            None
        );
    }

    #[tokio::test]
    async fn get_lfs_endpoint_reports_what_the_gate_will_judge() {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://github.com/o/r.git");
        repo.create_commit("hostile .lfsconfig", &[(".lfsconfig", HOSTILE_LFSCONFIG)]);

        assert_eq!(
            get_lfs_endpoint(repo.path_str()).await.unwrap().as_deref(),
            Some("https://evil.example.net/o/r.git/info/lfs")
        );
    }

    // ---- reads never reach the Output panel ----

    #[tokio::test]
    async fn get_lfs_status_and_get_lfs_files_report_nothing_to_the_output_panel() {
        // Opening the LFS dialog used to add FOUR rows per open — `git lfs
        // version` twice, with no repository, so in EVERY repository's panel —
        // plus `git lfs track` and `git lfs ls-files`.
        crate::utils::test_sink::install();
        let repo = TestRepo::with_initial_commit();
        repo.create_file(
            ".gitattributes",
            "*.bin filter=lfs diff=lfs merge=lfs -text\n",
        );

        get_lfs_status(repo.path_str()).await.unwrap();
        let _ = get_lfs_files(repo.path_str()).await;

        let reported = crate::utils::test_sink::recorded_for(&repo.path_str());
        assert!(reported.is_empty(), "reads were reported: {:?}", reported);
        assert!(
            !crate::utils::test_sink::recorded()
                .iter()
                .any(|entry| entry.command.starts_with("git lfs version")),
            "`git lfs version` must never be reported"
        );

        // A write next to those reads still is — whether or not git-lfs is
        // installed here, the invocation ran and the panel is told.
        let _ = lfs_track(repo.path_str(), "*.psd".to_string()).await;
        let reported = crate::utils::test_sink::recorded_for(&repo.path_str());
        assert!(
            reported
                .iter()
                .any(|entry| entry.command == "git lfs track *.psd"),
            "the write was not reported: {:?}",
            reported
        );
    }

    #[test]
    fn a_nested_untrack_is_reported_against_the_repository_the_user_has_open() {
        // The rule lives in `assets/.gitattributes`, so the removal has to
        // happen there. Running it FROM that directory filed the row under
        // `<repo>/assets`, and `lv-output-panel` renders only rows whose
        // repository is the open one — so the invocation that rewrote the
        // user's `.gitattributes` appeared in no panel at all, and the pending
        // operation could not claim it either (the repository axis is compared
        // before the subcommand). Same defect as the nested submodule update.
        //
        // This drives the helper rather than `lfs_untrack`, on purpose: git-lfs
        // is not installed in CI, so `git lfs track` fails there, the target
        // resolves to the repository root, and a test that went through the
        // command would never reach the nested path at all — it would pass
        // whether or not the defect was fixed.
        crate::utils::test_sink::install();
        let repo = TestRepo::with_initial_commit();

        let _ = run_lfs_command_in(&repo.path, "assets", &["untrack", "*.psd"]);

        let root = repo.path_str();
        let nested = format!("{root}/assets");
        let recorded = crate::utils::test_sink::recorded();
        assert!(
            !recorded
                .iter()
                .any(|entry| entry.repo_path.as_deref() == Some(nested.as_str())),
            "no row may be filed under the subdirectory: {recorded:?}"
        );
        let ours: Vec<_> = crate::utils::test_sink::recorded_for(&root)
            .into_iter()
            .filter(|entry| entry.command.contains("untrack"))
            .collect();
        assert_eq!(
            ours.len(),
            1,
            "the untrack must be reported once, against the open repository: {ours:?}"
        );
        assert!(
            ours[0].command.contains("-C assets"),
            "the rendered line must still say which directory it rewrote: {}",
            ours[0].command
        );
    }

    #[test]
    fn a_pattern_declared_in_a_subdirectory_resolves_to_that_subdirectory() {
        // The other half of the same behaviour: the dispatch that decides a
        // nested untrack is nested at all.
        assert_eq!(
            resolve_untrack_target("    *.psd (assets/.gitattributes)", "*.psd"),
            Some(("assets".to_string(), "*.psd".to_string()))
        );
        assert_eq!(
            resolve_untrack_target("    *.psd (.gitattributes)", "*.psd"),
            Some((String::new(), "*.psd".to_string()))
        );
    }

    // ---- uploads: the push-side keys come first, and only for uploads ----

    #[test]
    fn an_upload_prefers_the_push_side_keys_and_a_download_ignores_them() {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://github.com/o/r.git");
        let git_repo = repo.repo();
        let mut cfg = git_repo.config().unwrap();

        // remote.<r>.pushurl: where a push goes, so where its LFS upload goes.
        cfg.set_str("remote.origin.pushurl", "https://push.example/o/r.git")
            .unwrap();
        assert_eq!(
            resolve_lfs_endpoint(&repo.path, LfsOperation::Upload, Some("origin")).as_deref(),
            Some("https://push.example/o/r.git")
        );
        assert_eq!(
            resolve_lfs_endpoint(&repo.path, LfsOperation::Download, Some("origin")).as_deref(),
            Some("https://github.com/o/r.git")
        );

        // remote.<r>.lfspushurl beats that for uploads only.
        cfg.set_str("remote.origin.lfspushurl", "https://lfs-push.example/o/r")
            .unwrap();
        assert_eq!(
            resolve_lfs_endpoint(&repo.path, LfsOperation::Upload, Some("origin")).as_deref(),
            Some("https://lfs-push.example/o/r")
        );
        assert_eq!(
            resolve_lfs_endpoint(&repo.path, LfsOperation::Download, Some("origin")).as_deref(),
            Some("https://github.com/o/r.git")
        );

        // lfs.pushurl beats everything for uploads; lfs.url for downloads.
        cfg.set_str("lfs.pushurl", "https://lfs-global-push.example/o/r")
            .unwrap();
        cfg.set_str("lfs.url", "https://lfs-global.example/o/r")
            .unwrap();
        assert_eq!(
            resolve_lfs_endpoint(&repo.path, LfsOperation::Upload, Some("origin")).as_deref(),
            Some("https://lfs-global-push.example/o/r")
        );
        assert_eq!(
            resolve_lfs_endpoint(&repo.path, LfsOperation::Download, None).as_deref(),
            Some("https://lfs-global.example/o/r")
        );
    }

    /// A push in an LFS repository uploads through the pre-push hook to the
    /// endpoint a committed `.lfsconfig` chose — so the push gate has to see
    /// it, WHETHER OR NOT a filter rule is in force.
    ///
    /// This used to wave the no-filter case through, and asserted that as
    /// intended: "nothing would be uploaded, nothing refused". Both halves of
    /// that are wrong. `.gitattributes` governs which NEW files are converted
    /// to pointers, not which existing pointers the pre-push hook uploads, so a
    /// repository can hold committed pointers with no rule left in the tree —
    /// and the rule is committed too, so the same person who chose the hostile
    /// endpoint chooses whether the rule is there. An `lfs.pushurl` naming
    /// another host is itself the evidence that matters.
    #[test]
    fn guard_lfs_upload_judges_the_upload_endpoint_of_an_lfs_repository() {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://github.com/o/r.git");
        repo.create_commit(
            "hostile push endpoint",
            &[(
                ".lfsconfig",
                "[lfs]\n\tpushurl = https://evil.example.net/o/r.git/info/lfs\n",
            )],
        );
        let _guard = test_support::allowlist(&["github.com"]);

        // No LFS filter in force, and the endpoint still names a host the
        // allowlist does not.
        let message = blocked_message(guard_lfs_upload(&repo.path_str(), Some("origin")));
        assert!(
            message.contains("evil.example.net"),
            "an explicit lfs.pushurl is judged with no filter rule in force; got: {}",
            message
        );

        repo.create_file(
            ".gitattributes",
            "*.bin filter=lfs diff=lfs merge=lfs -text\n",
        );
        let message = blocked_message(guard_lfs_upload(&repo.path_str(), Some("origin")));
        assert!(message.contains("evil.example.net"), "got: {}", message);
    }

    /// The other half of that rule: with nothing naming an LFS endpoint the
    /// guard judges what the push gate in front of it already judged, so it
    /// never becomes the one thing that refuses a permitted push.
    #[test]
    fn guard_lfs_upload_adds_no_refusal_of_its_own_without_an_lfs_endpoint() {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("backup", "/mnt/usb/app.git");
        let _guard = test_support::allowlist(&["github.com"]);

        assert_not_blocked(
            &guard_lfs_upload(&repo.path_str(), Some("backup")),
            "a push to a path on this machine, in a repository with no LFS at all",
        );
    }

    /// Offline mode answered here BEFORE the endpoint was resolved
    /// (`check(&settings, None)`), so this guard refused EVERY push, in every
    /// repository, LFS or not — and it runs on every push path AFTER that
    /// path's own remote gate has already permitted the destination. With
    /// offline mode on and `remote.backup.url = /mnt/usb/app.git` the frontend
    /// permitted the push, `guard_push_remote` permitted it, and then this
    /// refused it with "Offline mode is enabled": exactly the refusal the
    /// local-target carve-out exists to remove.
    #[test]
    fn offline_mode_does_not_refuse_a_push_that_uploads_no_lfs_object() {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("backup", "/mnt/usb/app.git");
        repo.add_remote("origin", "https://github.com/o/r.git");
        let _guard = test_support::offline();

        assert_not_blocked(
            &guard_lfs_upload(&repo.path_str(), Some("backup")),
            "a push in a repository with no LFS filter in force",
        );
        // Deliberately NOT asserted here: that a push to `origin` is waved
        // through by this guard. With nothing naming an LFS endpoint the guard
        // judges the push destination itself, so for a destination offline mode
        // refuses it agrees with the push gate rather than disagreeing — and
        // asserting otherwise pinned "this guard alone permits a push that is
        // refused anyway", which is not a property worth having and is what hid
        // an explicit `lfs.pushurl` from it.
    }

    /// ...and in an LFS repository offline mode judges the ENDPOINT, so a
    /// local one is permitted and one that leaves the machine is not.
    #[test]
    fn offline_mode_judges_the_lfs_endpoint_it_would_reach() {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("backup", "/mnt/usb/app.git");
        repo.create_file(
            ".gitattributes",
            "*.bin filter=lfs diff=lfs merge=lfs -text\n",
        );
        let _guard = test_support::offline();

        let set_lfs_url = |value: &str| {
            repo.repo()
                .config()
                .unwrap()
                .set_str("lfs.url", value)
                .unwrap();
        };

        set_lfs_url("/mnt/usb/app.git/lfs");
        assert_not_blocked(
            &guard_lfs_upload(&repo.path_str(), Some("backup")),
            "an LFS upload to a path on this machine",
        );
        assert_not_blocked(
            &guard_lfs_transfer(&repo.path_str()),
            "an LFS download from a path on this machine",
        );

        set_lfs_url("https://lfs.example.net/o/r");
        assert!(
            blocked_message(guard_lfs_upload(&repo.path_str(), Some("backup")))
                .contains("Offline mode"),
            "an endpoint that leaves the machine is still refused"
        );
        assert!(
            blocked_message(guard_lfs_transfer(&repo.path_str())).contains("Offline mode"),
            "an endpoint that leaves the machine is still refused"
        );
    }

    /// An LFS transfer the user asked for is the only gate on `lfs_pull` /
    /// `lfs_fetch`, so — unlike a push, which has its own remote gate in front
    /// of it — it is NOT waved through for a repository whose `.gitattributes`
    /// names no filter. It resolves the endpoint and judges that.
    #[test]
    fn an_lfs_transfer_is_gated_even_without_a_tracked_pattern() {
        let repo = TestRepo::with_initial_commit();
        repo.add_remote("origin", "https://lfs.example.net/o/r.git");
        let _guard = test_support::offline();

        assert!(
            blocked_message(guard_lfs_transfer(&repo.path_str())).contains("Offline mode"),
            "an explicit LFS transfer to another machine is refused"
        );
    }
}
