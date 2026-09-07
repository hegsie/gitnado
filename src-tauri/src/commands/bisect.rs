//! Bisect command handlers
//! Binary search through commits to find bug-introducing changes

use std::path::{Path, PathBuf};
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::utils::create_command;

/// Current state of a bisect session
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectStatus {
    /// Whether a bisect session is in progress
    pub active: bool,
    /// Current commit being tested (if active)
    pub current_commit: Option<String>,
    /// The bad (newer) commit
    pub bad_commit: Option<String>,
    /// The good (older) commit
    pub good_commit: Option<String>,
    /// Number of revisions left to test (approximate)
    pub remaining: Option<u32>,
    /// Total steps (approximate)
    pub total_steps: Option<u32>,
    /// Current step number
    pub current_step: Option<u32>,
    /// Log of bisect operations
    pub log: Vec<BisectLogEntry>,
    /// The first bad commit, once the search has converged. The session stays
    /// active in git until `bisect reset`, so without this the result is lost
    /// the moment the dialog is closed at its result screen.
    pub culprit: Option<CulpritCommit>,
}

/// A single entry in the bisect log
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectLogEntry {
    pub commit_oid: String,
    pub action: String,
    pub message: Option<String>,
}

/// Result from a bisect step
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectStepResult {
    pub status: BisectStatus,
    /// If bisect is complete, this is the first bad commit
    pub culprit: Option<CulpritCommit>,
    /// Message from git about the current state
    pub message: String,
}

/// The commit that introduced the bug
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CulpritCommit {
    pub oid: String,
    pub summary: String,
    pub author: String,
    pub email: String,
}

/// The `git` invocation every bisect shell-out is built from.
///
/// `LC_ALL=C` is not cosmetic: every caller below matches git's English output
/// ("is the first bad commit", "We cannot bisect more"). Under a localized git
/// those strings are translated, so the culprit parsed as `None`, the dialog
/// never advanced to its result step, and the finished search was reachable
/// only through the danger-styled "Abort Bisect" that discards it. The sibling
/// CLI shell-outs in merge.rs and worktree.rs already pin this.
fn git_command(repo_path: &Path) -> std::process::Command {
    let mut cmd = create_command("git");
    cmd.current_dir(repo_path).env("LC_ALL", "C");
    cmd
}

/// Helper to run git commands
/// Whether git's output announces the culprit.
///
/// git prints "<sha> is the first <term> commit", where <term> is the session's
/// BAD term — "bad" by default, whatever `--term-new` named otherwise. Matching
/// the literal "is the first bad commit" therefore missed the completion of
/// every custom-term session, so the one result a bisect exists to produce came
/// back as an error. Matched term-independently here because this helper runs
/// every bisect command and has no session context of its own.
fn announces_culprit(output: &str) -> bool {
    output.lines().any(|line| {
        line.split_once("is the first ")
            .map(|(_, rest)| rest.split_whitespace().nth(1) == Some("commit"))
            .unwrap_or(false)
    })
}

fn run_git_command(repo_path: &Path, args: &[&str]) -> Result<String> {
    let output = git_command(repo_path)
        .args(args)
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run git: {}", e)))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(stdout.trim().to_string())
    } else {
        // A few bisect outcomes exit non-zero yet are legitimate results the UI
        // must display rather than swallow: skip-exhaustion ("We cannot bisect
        // more!", exit 2) and, on some git versions, the first-bad-commit summary.
        // Everything else (e.g. swapped good/bad: "Some good revs are not
        // ancestors of the bad rev.") is a real failure and must surface as an error.
        let combined = format!("{}\n{}", stdout, stderr);
        if combined.contains("We cannot bisect more") || announces_culprit(&combined) {
            Ok(stdout.trim().to_string())
        } else {
            let message = if stderr.trim().is_empty() {
                stdout.trim()
            } else {
                stderr.trim()
            };
            Err(GitnadoError::OperationFailed(message.to_string()))
        }
    }
}

/// Resolve the real git directory for `repo_path`. In a linked worktree `.git`
/// is a plain file, so per-worktree bisect state lives under
/// `<main>/.git/worktrees/<name>` rather than `<repo>/.git`.
fn git_dir(repo_path: &Path) -> Option<PathBuf> {
    run_git_command(repo_path, &["rev-parse", "--absolute-git-dir"])
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Read the recorded bisect terms (term for bad/new, term for good/old) from
/// BISECT_TERMS. Defaults to ("bad", "good") when the file is absent.
fn read_bisect_terms(git_dir: &Path) -> (String, String) {
    let default = || ("bad".to_string(), "good".to_string());
    match std::fs::read_to_string(git_dir.join("BISECT_TERMS")) {
        Ok(content) => {
            let mut lines = content.lines();
            let bad = lines.next().map(|s| s.trim().to_string());
            let good = lines.next().map(|s| s.trim().to_string());
            match (bad, good) {
                (Some(b), Some(g)) if !b.is_empty() && !g.is_empty() => (b, g),
                _ => default(),
            }
        }
        Err(_) => default(),
    }
}

/// git's estimate for the number of remaining bisection steps (mirrors
/// `estimate_bisect_steps` in git's bisect.c so the UI shows the same figure).
fn estimate_bisect_steps(all: u32) -> u32 {
    if all < 3 {
        return 0;
    }
    let n = 31 - all.leading_zeros(); // floor(log2(all))
    let e = 1u32 << n;
    let x = all - e;
    if e < 3 * x {
        n
    } else {
        n - 1
    }
}

/// Strip surrounding quotes that `git bisect log` puts around start arguments.
fn unquote(s: &str) -> String {
    s.trim_matches('\'').trim_matches('"').to_string()
}

/// Check if a bisect session is active
fn is_bisect_active(repo_path: &Path) -> bool {
    git_dir(repo_path)
        .map(|d| d.join("BISECT_START").exists())
        .unwrap_or(false)
}

/// Parse the bisect log file
fn parse_bisect_log(repo_path: &Path) -> Vec<BisectLogEntry> {
    let log_path = match git_dir(repo_path) {
        Some(d) => d.join("BISECT_LOG"),
        None => return Vec::new(),
    };
    if !log_path.exists() {
        return Vec::new();
    }

    let content = match std::fs::read_to_string(&log_path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    content
        .lines()
        .filter(|line| !line.starts_with('#') && !line.is_empty())
        .filter_map(|line| {
            // Format: "git bisect <term|skip> <commit>". Custom terms produce
            // e.g. "git bisect broken <sha>"; the bookkeeping "git bisect start
            // '--term-new=broken' ..." line must be skipped, not shown as history.
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 4 && parts[0] == "git" && parts[1] == "bisect" {
                let action = unquote(parts[2]);
                let commit = unquote(parts[3]);
                if action == "start" || commit.is_empty() || commit.starts_with('-') {
                    None
                } else {
                    Some(BisectLogEntry {
                        commit_oid: commit,
                        action,
                        message: None,
                    })
                }
            } else {
                None
            }
        })
        .collect()
}

/// Whether one BISECT_LOG line is git's converged-result comment for `term_bad`.
///
/// git quotes the term in this comment as of 2.44 and did not before, so the
/// same converged session writes either of:
///
/// ```text
/// # first bad commit: [<oid>] <subject>      (git 2.43)
/// # first 'bad' commit: [<oid>] <subject>    (git 2.55)
/// ```
///
/// Matching the line's SHAPE and comparing the term with any quoting stripped
/// reads both. An exact-string marker read only whichever git the author
/// happened to have: built against 2.43, it silently reported every converged
/// search as unfinished on 2.44+.
fn log_announces_culprit(line: &str, term_bad: &str) -> bool {
    let Some(comment) = line.trim_start().strip_prefix('#') else {
        return false;
    };
    let mut tokens = comment.split_whitespace();
    if tokens.next() != Some("first") {
        return false;
    }
    // git rejects a term containing whitespace, so the term is always one token.
    let Some(term) = tokens.next() else {
        return false;
    };
    if term.trim_matches('\'') != term_bad {
        return false;
    }
    tokens.next() == Some("commit:")
}

/// Whether git has already announced the answer for this session.
///
/// Once the search converges git appends its result to BISECT_LOG as a comment
/// and leaves the session ACTIVE until `git bisect reset`. That comment is the
/// only on-disk record that the search finished, so it is what tells a reopened
/// dialog to show the result rather than another Good/Bad/Skip round.
fn bisect_finished(git_dir: &Path, term_bad: &str) -> bool {
    std::fs::read_to_string(git_dir.join("BISECT_LOG"))
        .map(|c| c.lines().any(|l| log_announces_culprit(l, term_bad)))
        .unwrap_or(false)
}

/// Describe `oid` for the culprit card. Unit-separated so an empty subject
/// cannot shift the fields.
fn culprit_commit(repo_path: &Path, oid: &str) -> Option<CulpritCommit> {
    let out = run_git_command(
        repo_path,
        &["log", "-1", "--format=%H%x1f%s%x1f%an%x1f%ae", oid, "--"],
    )
    .ok()?;
    let mut parts = out.split('\u{1f}');
    let oid = parts.next()?.trim().to_string();
    let summary = parts.next()?.to_string();
    let author = parts.next()?.to_string();
    let email = parts.next()?.trim().to_string();
    if oid.is_empty() {
        return None;
    }
    Some(CulpritCommit {
        oid,
        summary,
        author,
        email,
    })
}

/// The status returned when no bisect session is in progress.
fn inactive_status() -> BisectStatus {
    BisectStatus {
        active: false,
        current_commit: None,
        bad_commit: None,
        good_commit: None,
        remaining: None,
        total_steps: None,
        current_step: None,
        log: Vec::new(),
        culprit: None,
    }
}

/// Get the current bisect status
#[command]
pub async fn get_bisect_status(path: String) -> Result<BisectStatus> {
    let repo_path = Path::new(&path);

    if !is_bisect_active(repo_path) {
        return Ok(inactive_status());
    }

    let gdir = match git_dir(repo_path) {
        Some(d) => d,
        None => return Ok(inactive_status()),
    };

    // Honor custom terms (git bisect start --term-new/--term-old, or new/old).
    let (term_bad, term_good) = read_bisect_terms(&gdir);

    // Get current HEAD (the commit currently being tested)
    let current_commit = run_git_command(repo_path, &["rev-parse", "HEAD"]).ok();

    // Read the bad/new ref via git so it resolves in linked worktrees and honors
    // packed refs (raw .git/refs/bisect/* file reads break in both cases).
    let bad_ref = format!("refs/bisect/{}", term_bad);
    let bad_commit = run_git_command(repo_path, &["rev-parse", "--verify", "--quiet", &bad_ref])
        .ok()
        .filter(|s| !s.is_empty());

    // Collect all good/old refs (there can be several: <term_good>-<sha>).
    let good_prefix = format!("refs/bisect/{}-", term_good);
    let good_refs: Vec<String> = run_git_command(
        repo_path,
        &["for-each-ref", "--format=%(refname)", "refs/bisect"],
    )
    .map(|out| {
        out.lines()
            .map(|l| l.trim().to_string())
            .filter(|l| l.starts_with(&good_prefix))
            .collect()
    })
    .unwrap_or_default();

    let good_commit = good_refs
        .first()
        .and_then(|r| run_git_command(repo_path, &["rev-parse", r]).ok())
        .filter(|s| !s.is_empty());

    // Parse the log
    let log = parse_bisect_log(repo_path);

    // git records the answer against refs/bisect/<term_bad> — already resolved
    // into `bad_commit` above; the log comment is only the signal that the
    // search got there. Do not parse the oid out of that comment: its bracket
    // formatting has drifted across git versions.
    let culprit = if bisect_finished(&gdir, &term_bad) {
        bad_commit
            .as_deref()
            .and_then(|oid| culprit_commit(repo_path, oid))
    } else {
        None
    };

    // Estimate remaining work exactly as git prints it:
    //   "Bisecting: N revisions left to test after this (roughly M steps)"
    // where N = all - reaches - 1 (all = candidate commits in the range,
    // reaches = commits reachable from the current midpoint) and
    // M = estimate_bisect_steps(all).
    let remaining_info = if bad_commit.is_some() && !good_refs.is_empty() {
        let count = |start: &str| -> Option<u32> {
            let mut args: Vec<&str> = vec!["rev-list", "--count", start, "--not"];
            for r in &good_refs {
                args.push(r.as_str());
            }
            run_git_command(repo_path, &args)
                .ok()
                .and_then(|s| s.trim().parse::<u32>().ok())
        };
        match (count(&bad_ref), count("HEAD")) {
            (Some(all), Some(reaches)) if all > 0 => {
                let remaining = all.saturating_sub(reaches).saturating_sub(1);
                Some((remaining, estimate_bisect_steps(all)))
            }
            _ => None,
        }
    } else {
        None
    };

    Ok(BisectStatus {
        active: true,
        current_commit,
        bad_commit,
        good_commit,
        remaining: remaining_info.map(|(r, _)| r),
        total_steps: remaining_info.map(|(_, t)| t),
        current_step: Some(log.len() as u32),
        log,
        culprit,
    })
}

/// Start a new bisect session
#[command]
pub async fn bisect_start(
    path: String,
    bad_commit: Option<String>,
    good_commit: Option<String>,
) -> Result<BisectStepResult> {
    let repo_path = Path::new(&path);

    // Start bisect
    run_git_command(repo_path, &["bisect", "start"])?;

    // The two marking steps take free-text refs straight from the dialog, so a
    // typo fails them — but `git bisect start` has already written BISECT_LOG,
    // and libgit2 keys RepositoryState::Bisect off that file. Reporting the
    // failure and leaving the state behind meant ensure_checkoutable and
    // ensure_resettable then refused EVERY checkout, reset and git-flow
    // operation in the app, while the dialog said the bisect had not started.
    // Rolled back the way create_branch and the git-flow starts are.
    let marked = (|| -> Result<()> {
        if let Some(bad) = &bad_commit {
            run_git_command(repo_path, &["bisect", "bad", bad])?;
        }
        if let Some(good) = &good_commit {
            run_git_command(repo_path, &["bisect", "good", good])?;
        }
        Ok(())
    })();
    if let Err(e) = marked {
        let _ = run_git_command(repo_path, &["bisect", "reset"]);
        return Err(e);
    }

    let status = get_bisect_status(path.clone()).await?;

    Ok(BisectStepResult {
        status,
        culprit: None,
        message: "Bisect session started".to_string(),
    })
}

/// The terms this bisect session was started with.
///
/// A session started with `--term-new`/`--term-old` (say "broken"/"working")
/// REJECTS the literal `git bisect bad`: git dies with "Invalid command: you're
/// currently in a broken/working bisect". get_bisect_status already reads these
/// terms, so the dialog happily showed such a session as in progress while its
/// Good and Bad buttons could not advance it at all — including a session the
/// user started in their own terminal.
fn session_terms(repo_path: &Path) -> (String, String) {
    match git_dir(repo_path) {
        Some(dir) => read_bisect_terms(&dir),
        None => ("bad".to_string(), "good".to_string()),
    }
}

/// Join stdout and stderr into one block, adding a separator only when one is
/// missing.
///
/// An unconditional "\n" between them inserts a blank line whenever stdout
/// already ends in one — which it usually does. The parser tolerates that, but
/// the output is also shown to the user as the step's message, so the blank
/// line is real noise for no gain.
fn join_streams(stdout: &str, stderr: &str) -> String {
    if stdout.is_empty() {
        return stderr.to_string();
    }
    if stderr.is_empty() {
        return stdout.to_string();
    }
    if stdout.ends_with('\n') {
        format!("{}{}", stdout, stderr)
    } else {
        format!("{}\n{}", stdout, stderr)
    }
}

/// Run a bisect STEP and return stdout and stderr together.
///
/// Which stream git announces the culprit on, and whether it exits zero doing
/// so, both vary by git version — 2.43 exits zero with the summary on stdout;
/// CI's 2.55 does not, which is how a test that passed locally went red there.
/// The step handlers care only about the text, so they get both streams and
/// stop depending on either choice.
fn run_bisect_step(repo_path: &Path, args: &[&str]) -> Result<String> {
    let output = git_command(repo_path)
        .args(args)
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run git: {}", e)))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = join_streams(&stdout, &stderr);

    if output.status.success()
        || combined.contains("We cannot bisect more")
        || announces_culprit(&combined)
    {
        Ok(combined.trim().to_string())
    } else {
        let message = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        Err(GitnadoError::OperationFailed(message.to_string()))
    }
}

/// Mark the current commit (or specified commit) as bad
#[command]
pub async fn bisect_bad(path: String, commit: Option<String>) -> Result<BisectStepResult> {
    let repo_path = Path::new(&path);

    let (term_bad, _) = session_terms(repo_path);

    let args: Vec<&str> = match &commit {
        Some(c) => vec!["bisect", term_bad.as_str(), c.as_str()],
        None => vec!["bisect", term_bad.as_str()],
    };

    let output = run_bisect_step(repo_path, &args)?;

    // Check if we found the culprit
    let culprit = if announces_culprit(&output) {
        // Parse the culprit commit info
        parse_culprit_from_output(&output)
    } else {
        None
    };

    let status = get_bisect_status(path.clone()).await?;

    Ok(BisectStepResult {
        status,
        culprit,
        message: output,
    })
}

/// Mark the current commit (or specified commit) as good
#[command]
pub async fn bisect_good(path: String, commit: Option<String>) -> Result<BisectStepResult> {
    let repo_path = Path::new(&path);

    let (_, term_good) = session_terms(repo_path);

    let args: Vec<&str> = match &commit {
        Some(c) => vec!["bisect", term_good.as_str(), c.as_str()],
        None => vec!["bisect", term_good.as_str()],
    };

    let output = run_bisect_step(repo_path, &args)?;

    // Marking good is what usually NARROWS the range to the culprit, so this
    // handler must recognise the announcement just as much as marking bad.
    let culprit = if announces_culprit(&output) {
        parse_culprit_from_output(&output)
    } else {
        None
    };

    let status = get_bisect_status(path.clone()).await?;

    Ok(BisectStepResult {
        status,
        culprit,
        message: output,
    })
}

/// Skip the current commit (can't be tested)
#[command]
pub async fn bisect_skip(path: String, commit: Option<String>) -> Result<BisectStepResult> {
    let repo_path = Path::new(&path);

    let args: Vec<&str> = match &commit {
        Some(c) => vec!["bisect", "skip", c.as_str()],
        None => vec!["bisect", "skip"],
    };

    let output = run_git_command(repo_path, &args)?;

    let status = get_bisect_status(path.clone()).await?;

    Ok(BisectStepResult {
        status,
        culprit: None,
        message: output,
    })
}

/// Reset/end the bisect session
#[command]
pub async fn bisect_reset(path: String) -> Result<BisectStepResult> {
    let repo_path = Path::new(&path);

    let output = run_git_command(repo_path, &["bisect", "reset"])?;

    let status = get_bisect_status(path.clone()).await?;

    Ok(BisectStepResult {
        status,
        culprit: None,
        message: if output.is_empty() {
            "Bisect session ended".to_string()
        } else {
            output
        },
    })
}

/// Parse culprit commit info from git bisect output
fn parse_culprit_from_output(output: &str) -> Option<CulpritCommit> {
    // Output format:
    // <oid> is the first bad commit
    // commit <oid>
    // Author: Name <email>
    // Date:   ...
    //
    //     commit message

    let lines: Vec<&str> = output.lines().collect();

    // FIND the announcing line rather than assuming it is line 0. It is not
    // always first: git may put it on stderr, so combined output can lead with
    // stdout, and the term in it is the session's, not always "bad".
    let announce_at = lines.iter().position(|l| announces_culprit(l))?;
    let oid = lines[announce_at].split_whitespace().next()?.to_string();

    // Find the Author line AFTER the announcement, so anything printed before
    // it cannot be mistaken for the culprit's.
    let author_line = lines[announce_at..]
        .iter()
        .find(|l| l.trim().starts_with("Author:"))?;
    let author_part = author_line.trim().strip_prefix("Author:")?.trim();

    // Parse "Name <email>"
    let (author, email) = if let Some(email_start) = author_part.find('<') {
        let name = author_part[..email_start].trim().to_string();
        let email = author_part[email_start + 1..]
            .trim_end_matches('>')
            .to_string();
        (name, email)
    } else {
        (author_part.to_string(), String::new())
    };

    // Find the commit summary (first non-empty line after empty line)
    let summary = lines
        .iter()
        .skip_while(|l| !l.is_empty())
        .skip(1)
        .find(|l| !l.is_empty())
        .map(|l| l.trim().to_string())
        .unwrap_or_default();

    Some(CulpritCommit {
        oid,
        summary,
        author,
        email,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    /// `git bisect start` writes BISECT_LOG before the marking steps run, and
    /// libgit2 keys RepositoryState::Bisect off that file. A failed start that
    /// left it behind put the repo in a state where ensure_checkoutable and
    /// ensure_resettable refuse every checkout and reset in the app.
    #[tokio::test]
    async fn test_bisect_start_rolls_back_when_a_ref_is_bogus() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("second", &[("f.txt", "b\n")]);

        let result = bisect_start(
            repo.path_str(),
            Some("HEAD".to_string()),
            Some("no-such-ref".to_string()),
        )
        .await;

        assert!(result.is_err(), "an unresolvable ref must fail the start");
        assert_eq!(
            repo.repo().state(),
            git2::RepositoryState::Clean,
            "a start that reports failure must leave the repo as it was"
        );
    }

    #[tokio::test]
    async fn test_bisect_start_succeeds_with_valid_refs() {
        let repo = TestRepo::with_initial_commit();
        let first = repo.head_oid().to_string();
        repo.create_commit("second", &[("f.txt", "b\n")]);

        bisect_start(repo.path_str(), Some("HEAD".to_string()), Some(first))
            .await
            .expect("a valid start must not be rolled back");
        assert_eq!(repo.repo().state(), git2::RepositoryState::Bisect);
    }

    #[test]
    fn test_git_command_pins_the_locale() {
        // Every parse in this module matches git's English output. Under a
        // localized git those strings are translated, the culprit parses as
        // None, and the dialog never leaves its Good/Bad/Skip step.
        let repo = TestRepo::with_initial_commit();
        let cmd = git_command(&repo.path);

        let lc_all = cmd
            .get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new("LC_ALL"))
            .and_then(|(_, v)| v)
            .expect("LC_ALL must be set, or a localized git breaks every parse below");
        assert_eq!(lc_all, std::ffi::OsStr::new("C"));
    }

    #[tokio::test]
    async fn test_get_bisect_status_inactive() {
        let repo = TestRepo::with_initial_commit();
        let result = get_bisect_status(repo.path_str()).await;

        assert!(result.is_ok());
        let status = result.unwrap();
        assert!(!status.active);
        assert!(status.current_commit.is_none());
        assert!(status.bad_commit.is_none());
        assert!(status.good_commit.is_none());
        assert!(status.log.is_empty());
    }

    #[tokio::test]
    async fn test_bisect_start_simple() {
        let repo = TestRepo::with_initial_commit();

        let result = bisect_start(repo.path_str(), None, None).await;

        assert!(result.is_ok());
        let step_result = result.unwrap();
        assert!(step_result.status.active);
        assert_eq!(step_result.message, "Bisect session started");
        assert!(step_result.culprit.is_none());
    }

    #[tokio::test]
    async fn test_bisect_start_with_commits() {
        let repo = TestRepo::with_initial_commit();
        let good_oid = repo.head_oid().to_string();

        // Create a "bad" commit
        repo.create_commit("Bad commit", &[("bad.txt", "bad content")]);
        let bad_oid = repo.head_oid().to_string();

        let result = bisect_start(
            repo.path_str(),
            Some(bad_oid.clone()),
            Some(good_oid.clone()),
        )
        .await;

        assert!(result.is_ok());
        let step_result = result.unwrap();
        assert!(step_result.status.active);
    }

    #[tokio::test]
    async fn test_bisect_reset() {
        let repo = TestRepo::with_initial_commit();

        // Start bisect session
        bisect_start(repo.path_str(), None, None).await.unwrap();

        // Verify it's active
        let status = get_bisect_status(repo.path_str()).await.unwrap();
        assert!(status.active);

        // Reset bisect
        let result = bisect_reset(repo.path_str()).await;

        assert!(result.is_ok());
        let step_result = result.unwrap();
        assert!(!step_result.status.active);
    }

    #[tokio::test]
    async fn test_bisect_good_and_bad() {
        let repo = TestRepo::with_initial_commit();
        let good_oid = repo.head_oid().to_string();

        // Create more commits for bisect to work with
        repo.create_commit("Commit 2", &[("file2.txt", "content 2")]);
        repo.create_commit("Commit 3", &[("file3.txt", "content 3")]);
        repo.create_commit("Commit 4", &[("file4.txt", "content 4")]);
        let bad_oid = repo.head_oid().to_string();

        // Start bisect with bad and good commits
        bisect_start(repo.path_str(), Some(bad_oid), Some(good_oid))
            .await
            .unwrap();

        // Mark current as bad
        let bad_result = bisect_bad(repo.path_str(), None).await;
        assert!(bad_result.is_ok());

        // Reset for cleanup
        bisect_reset(repo.path_str()).await.unwrap();
    }

    /// A session started with custom terms must still be advanceable.
    ///
    /// get_bisect_status already reads BISECT_TERMS, so the dialog shows such a
    /// session as in progress — including one the user started in their own
    /// terminal. But the handlers ran the literal `git bisect bad`/`good`,
    /// which git REJECTS in a custom-term session ("Invalid command: you're
    /// currently in a broken/working bisect"). The user could see the session
    /// and could not advance it at all.
    #[tokio::test]
    async fn test_bisect_good_and_bad_honour_custom_terms() {
        let repo = TestRepo::with_initial_commit();
        let good_oid = repo.head_oid().to_string();
        repo.create_commit("Commit 2", &[("file2.txt", "content 2")]);
        repo.create_commit("Commit 3", &[("file3.txt", "content 3")]);
        repo.create_commit("Commit 4", &[("file4.txt", "content 4")]);
        let bad_oid = repo.head_oid().to_string();

        // Start the session the way a terminal user would, with custom terms.
        run_git_command(
            repo.path.as_path(),
            &["bisect", "start", "--term-new=broken", "--term-old=working"],
        )
        .expect("start a custom-term bisect");
        run_git_command(repo.path.as_path(), &["bisect", "broken", &bad_oid])
            .expect("mark the bad end");
        run_git_command(repo.path.as_path(), &["bisect", "working", &good_oid])
            .expect("mark the good end");

        // The dialog shows this session, so its buttons must work on it.
        let bad_result = bisect_bad(repo.path_str(), None).await;
        assert!(
            bad_result.is_ok(),
            "marking bad must use the session's term: {:?}",
            bad_result.err()
        );

        let good_result = bisect_good(repo.path_str(), None).await;
        assert!(
            good_result.is_ok(),
            "marking good must use the session's term: {:?}",
            good_result.err()
        );

        bisect_reset(repo.path_str()).await.unwrap();
    }

    /// The default-term session keeps working unchanged.
    #[tokio::test]
    async fn test_bisect_good_and_bad_still_work_with_default_terms() {
        let repo = TestRepo::with_initial_commit();
        let good_oid = repo.head_oid().to_string();
        // Enough commits that the range still has somewhere to go after the
        // first step — with a three-commit history the session finishes
        // immediately and there is no second step left to exercise.
        for i in 2..=8 {
            repo.create_commit(
                &format!("Commit {}", i),
                &[(&format!("file{}.txt", i), "content")],
            );
        }
        let bad_oid = repo.head_oid().to_string();

        bisect_start(repo.path_str(), Some(bad_oid), Some(good_oid))
            .await
            .unwrap();

        assert!(
            bisect_bad(repo.path_str(), None).await.is_ok(),
            "marking bad must work on a default-term session"
        );
        assert!(
            bisect_good(repo.path_str(), None).await.is_ok(),
            "marking good must work too — the name says both"
        );
        bisect_reset(repo.path_str()).await.unwrap();
    }

    /// Reaching the culprit in a custom-term session must be a RESULT, not an
    /// error.
    ///
    /// git announces it as "is the first <term> commit". run_git_command
    /// whitelisted the literal "is the first bad commit" among the non-zero
    /// exits it lets through, so in a custom-term session the announcement fell
    /// through to the error arm — the commands used the right terms and the one
    /// answer a bisect exists to produce still came back as a failure.
    #[tokio::test]
    async fn test_custom_term_bisect_reports_the_culprit_rather_than_failing() {
        let repo = TestRepo::with_initial_commit();
        let good_oid = repo.head_oid().to_string();
        let culprit = repo.create_commit("The bad one", &[("bug.txt", "boom")]);
        let bad_oid = repo.head_oid().to_string();

        run_git_command(
            repo.path.as_path(),
            &["bisect", "start", "--term-new=broken", "--term-old=working"],
        )
        .expect("start a custom-term bisect");
        run_git_command(repo.path.as_path(), &["bisect", "broken", &bad_oid]).unwrap();

        // Marking the parent good narrows it to a single commit, so git
        // announces the culprit right here.
        let result = bisect_good(repo.path_str(), Some(good_oid))
            .await
            .expect("reaching the culprit must not be reported as a failure");

        let found = result.culprit.expect("the culprit must be reported");
        assert_eq!(
            found.oid,
            culprit.to_string(),
            "the reported culprit must be the commit that introduced the bug"
        );

        bisect_reset(repo.path_str()).await.unwrap();
    }

    /// The culprit must be found wherever the announcement sits.
    ///
    /// The parser used to take line 0 as the announcement. git may print it on
    /// stderr — so in combined output it can follow stdout rather than lead —
    /// and the term in it is the session's, not always "bad". CI's git 2.55
    /// exposed exactly this after it passed on 2.43 locally.
    #[test]
    fn test_parse_culprit_finds_the_announcement_anywhere() {
        let stderr_first = "Bisecting: 0 revisions left to test after this\n\
             abc123def is the first broken commit\n\
             commit abc123def\n\
             Author: Alice <alice@example.com>\n\
             Date:   Mon Jan 1 00:00:00 2026 +0000\n\
             \n    Broke the thing\n";

        let culprit = parse_culprit_from_output(stderr_first)
            .expect("the announcement is not on line 0, and must still be found");
        assert_eq!(culprit.oid, "abc123def");
        assert_eq!(culprit.author, "Alice");
        assert_eq!(culprit.email, "alice@example.com");
    }

    /// Output with no announcement yields no culprit.
    #[test]
    fn test_parse_culprit_returns_none_without_an_announcement() {
        assert!(parse_culprit_from_output("Bisecting: 3 revisions left").is_none());
        assert!(parse_culprit_from_output("").is_none());
    }

    /// Joining the streams must not introduce a blank line.
    #[test]
    fn test_join_streams_adds_a_separator_only_when_needed() {
        assert_eq!(join_streams("out\n", "err\n"), "out\nerr\n");
        assert_eq!(join_streams("out", "err"), "out\nerr");
        assert_eq!(join_streams("", "err"), "err");
        assert_eq!(join_streams("out\n", ""), "out\n");
    }

    /// git rejects a multi-word bisect term, so the matcher need not handle one.
    ///
    /// Checked against git directly:
    ///     $ git bisect start --term-new="very broken" --term-old=working
    ///     error: 'very broken' is not a valid term
    /// A session with such a term cannot exist, so requiring a single word
    /// after "is the first " costs nothing.
    #[test]
    fn test_announces_culprit_handles_the_terms_git_actually_allows() {
        assert!(announces_culprit("abc123 is the first bad commit"));
        assert!(announces_culprit("abc123 is the first broken commit"));
        assert!(announces_culprit("abc123 is the first regressed commit"));
    }

    /// The term-independent match accepts any term, and nothing else.
    #[test]
    fn test_announces_culprit_matches_any_term() {
        assert!(announces_culprit("abc123 is the first bad commit"));
        assert!(announces_culprit("abc123 is the first broken commit"));
        assert!(announces_culprit(
            "some preamble\nabc123 is the first regressed commit\nmore"
        ));
        // Not a culprit announcement.
        assert!(!announces_culprit(
            "Some good revs are not ancestors of the bad rev."
        ));
        assert!(!announces_culprit("is the first thing you should know"));
        assert!(!announces_culprit(""));
    }

    #[tokio::test]
    async fn test_bisect_skip() {
        let repo = TestRepo::with_initial_commit();
        let good_oid = repo.head_oid().to_string();

        // Create more commits
        repo.create_commit("Commit 2", &[("file2.txt", "content 2")]);
        repo.create_commit("Commit 3", &[("file3.txt", "content 3")]);
        let bad_oid = repo.head_oid().to_string();

        // Start bisect
        bisect_start(repo.path_str(), Some(bad_oid), Some(good_oid))
            .await
            .unwrap();

        // Skip current commit
        let skip_result = bisect_skip(repo.path_str(), None).await;
        assert!(skip_result.is_ok());

        // Reset for cleanup
        bisect_reset(repo.path_str()).await.unwrap();
    }

    #[tokio::test]
    async fn test_bisect_full_session() {
        let repo = TestRepo::with_initial_commit();
        let good_oid = repo.head_oid().to_string();

        // Create several commits
        repo.create_commit("Commit 2", &[("file2.txt", "content 2")]);
        repo.create_commit("Bug introduced", &[("bug.txt", "bug")]);
        repo.create_commit("Commit 4", &[("file4.txt", "content 4")]);
        let bad_oid = repo.head_oid().to_string();

        // Start bisect
        let start_result = bisect_start(repo.path_str(), Some(bad_oid), Some(good_oid)).await;
        assert!(start_result.is_ok());

        // Get status - should be active
        let status = get_bisect_status(repo.path_str()).await.unwrap();
        assert!(status.active);
        assert!(status.current_commit.is_some());

        // Reset to clean up
        let reset_result = bisect_reset(repo.path_str()).await;
        assert!(reset_result.is_ok());
        assert!(!reset_result.unwrap().status.active);
    }

    #[tokio::test]
    async fn test_bisect_bad_with_specific_commit() {
        let repo = TestRepo::with_initial_commit();
        let good_oid = repo.head_oid().to_string();

        repo.create_commit("Commit 2", &[("file2.txt", "content 2")]);
        let specific_oid = repo.head_oid().to_string();
        repo.create_commit("Commit 3", &[("file3.txt", "content 3")]);

        // Start bisect
        bisect_start(repo.path_str(), None, None).await.unwrap();

        // Mark specific commit as bad
        let bad_result = bisect_bad(repo.path_str(), Some(specific_oid)).await;
        assert!(bad_result.is_ok());

        // Mark good commit
        let good_result = bisect_good(repo.path_str(), Some(good_oid)).await;
        assert!(good_result.is_ok());

        // Reset for cleanup
        bisect_reset(repo.path_str()).await.unwrap();
    }

    #[test]
    fn test_parse_bisect_log_empty_repo() {
        let repo = TestRepo::with_initial_commit();
        let log = parse_bisect_log(&repo.path);
        assert!(log.is_empty());
    }

    #[test]
    fn test_is_bisect_active_false() {
        let repo = TestRepo::with_initial_commit();
        assert!(!is_bisect_active(&repo.path));
    }

    #[test]
    fn test_parse_culprit_from_output_valid() {
        let output = r#"abc123def456 is the first bad commit
commit abc123def456
Author: Test User <test@example.com>
Date:   Mon Jan 1 12:00:00 2024 +0000

    Bug introduced here

:100644 100644 abc123 def456 M  file.txt"#;

        let culprit = parse_culprit_from_output(output);
        assert!(culprit.is_some());

        let culprit = culprit.unwrap();
        assert_eq!(culprit.oid, "abc123def456");
        assert_eq!(culprit.author, "Test User");
        assert_eq!(culprit.email, "test@example.com");
        assert_eq!(culprit.summary, "Bug introduced here");
    }

    #[test]
    fn test_parse_culprit_from_output_empty() {
        let output = "";
        let culprit = parse_culprit_from_output(output);
        assert!(culprit.is_none());
    }

    #[test]
    fn test_parse_culprit_from_output_no_author() {
        let output = "abc123def456 is the first bad commit\ncommit abc123def456";
        let culprit = parse_culprit_from_output(output);
        assert!(culprit.is_none());
    }

    // Finding 94: swapped good/bad must surface an error rather than silently
    // reporting a started session the user is then stuck in.
    #[tokio::test]
    async fn test_bisect_start_rejects_swapped_good_bad() {
        let repo = TestRepo::with_initial_commit();
        for i in 2..=6 {
            repo.create_commit(
                &format!("Commit {}", i),
                &[(format!("f{}.txt", i).as_str(), "x")],
            );
        }
        // Mark an ancestor as "bad" and its descendant HEAD as "good" (swapped).
        let bad_oid = run_git_command(&repo.path, &["rev-parse", "HEAD~4"]).unwrap();
        let good_oid = repo.head_oid().to_string();

        let result = bisect_start(repo.path_str(), Some(bad_oid), Some(good_oid)).await;
        assert!(
            result.is_err(),
            "swapped good/bad must surface an error, not a silent success"
        );

        let _ = run_git_command(&repo.path, &["bisect", "reset"]);
    }

    // Finding 95: remaining / total_steps must be populated (they were always None
    // because `git bisect visualize --oneline --count` never emits a bare count).
    #[tokio::test]
    async fn test_bisect_status_populates_progress() {
        let repo = TestRepo::with_initial_commit();
        let good_oid = repo.head_oid().to_string();
        for i in 2..=9 {
            repo.create_commit(
                &format!("Commit {}", i),
                &[(format!("f{}.txt", i).as_str(), "x")],
            );
        }
        let bad_oid = repo.head_oid().to_string();

        bisect_start(repo.path_str(), Some(bad_oid), Some(good_oid))
            .await
            .unwrap();

        let status = get_bisect_status(repo.path_str()).await.unwrap();
        assert!(status.active);
        assert!(status.remaining.is_some(), "remaining should be populated");
        assert!(
            status.total_steps.is_some(),
            "total_steps should be populated"
        );

        let _ = run_git_command(&repo.path, &["bisect", "reset"]);
    }

    // Finding 96: bisect state must be detected inside a linked worktree, where
    // `.git` is a file and per-worktree state lives under the resolved git dir.
    #[tokio::test]
    async fn test_bisect_status_in_worktree() {
        let repo = TestRepo::with_initial_commit();
        let good_oid = repo.head_oid().to_string();
        for i in 2..=6 {
            repo.create_commit(
                &format!("Commit {}", i),
                &[(format!("f{}.txt", i).as_str(), "x")],
            );
        }
        let bad_oid = repo.head_oid().to_string();

        let wt_parent = tempfile::TempDir::new().unwrap();
        let wt_path = wt_parent.path().join("wt");
        let out = std::process::Command::new("git")
            .current_dir(&repo.path)
            .args([
                "worktree",
                "add",
                "--detach",
                wt_path.to_str().unwrap(),
                "HEAD",
            ])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "worktree add failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        // In a linked worktree `.git` is a file, not a directory.
        assert!(wt_path.join(".git").is_file());

        let wt_str = wt_path.to_string_lossy().to_string();
        bisect_start(wt_str.clone(), Some(bad_oid), Some(good_oid))
            .await
            .unwrap();

        let status = get_bisect_status(wt_str).await.unwrap();
        assert!(
            status.active,
            "bisect must be detected as active in a linked worktree"
        );
        assert!(status.bad_commit.is_some());

        let _ = run_git_command(&wt_path, &["bisect", "reset"]);
    }

    // Finding 97: sessions started with custom terms must resolve bad/good via
    // the recorded terms, and the bookkeeping "start" line must not pollute history.
    #[tokio::test]
    async fn test_bisect_status_custom_terms() {
        let repo = TestRepo::with_initial_commit();
        let good_oid = repo.head_oid().to_string();
        for i in 2..=6 {
            repo.create_commit(
                &format!("Commit {}", i),
                &[(format!("f{}.txt", i).as_str(), "x")],
            );
        }
        let bad_oid = repo.head_oid().to_string();

        run_git_command(
            &repo.path,
            &[
                "bisect",
                "start",
                "--term-new=broken",
                "--term-old=working",
                bad_oid.as_str(),
                good_oid.as_str(),
            ],
        )
        .unwrap();

        let status = get_bisect_status(repo.path_str()).await.unwrap();
        assert!(status.active);
        assert!(
            status.bad_commit.is_some(),
            "bad commit should resolve via custom term refs/bisect/broken"
        );
        assert!(
            status.good_commit.is_some(),
            "good commit should resolve via custom term refs/bisect/working-*"
        );
        assert!(
            status
                .log
                .iter()
                .all(|e| e.action != "start" && !e.commit_oid.starts_with('-')),
            "the start bookkeeping line must not appear as a history entry"
        );

        let _ = run_git_command(&repo.path, &["bisect", "reset"]);
    }

    /// Both spellings git has used for the converged-result comment must read as
    /// converged. The unquoted form is what git <= 2.43 writes and the quoted
    /// form is what 2.44+ writes; a build that understands only the local git's
    /// spelling reports every converged search as unfinished on the other, which
    /// is exactly how this shipped red.
    #[test]
    fn test_log_announces_culprit_reads_both_git_spellings() {
        let oid = "d2598a42cba989fc57a7dd16fe321404bfa66177";

        assert!(
            log_announces_culprit(&format!("# first bad commit: [{}] Bug", oid), "bad"),
            "git 2.43 writes the term unquoted"
        );
        assert!(
            log_announces_culprit(&format!("# first 'bad' commit: [{}] Bug", oid), "bad"),
            "git 2.55 writes the term quoted"
        );
        assert!(
            log_announces_culprit(&format!("# first 'broken' commit: [{}] Bug", oid), "broken"),
            "a custom --term-new is quoted the same way"
        );

        // The other comments in BISECT_LOG must not read as the result, or a
        // session would look converged the moment it started.
        assert!(!log_announces_culprit(
            &format!("# bad: [{}] Bug", oid),
            "bad"
        ));
        assert!(!log_announces_culprit(
            &format!("# good: [{}] initial", oid),
            "bad"
        ));
        assert!(!log_announces_culprit(
            &format!("git bisect start '{}' 'x'", oid),
            "bad"
        ));
        // A different session's term is not this session's answer.
        assert!(!log_announces_culprit(
            &format!("# first 'broken' commit: [{}] Bug", oid),
            "bad"
        ));
    }

    // The session stays active in git until `bisect reset`, so a status that
    // cannot say the search is over presents a finished bisect as unfinished —
    // the dialog reopens on Good/Bad/Skip and the answer is gone.
    #[tokio::test]
    async fn test_get_bisect_status_reports_the_culprit_once_the_search_converges() {
        let repo = TestRepo::with_initial_commit();
        let good = repo.head_oid().to_string();
        repo.create_commit("Bug introduced", &[("bug.txt", "bug")]);
        let bad = repo.head_oid().to_string();

        // With a single candidate git converges inside the start itself.
        bisect_start(repo.path_str(), Some(bad.clone()), Some(good))
            .await
            .unwrap();

        let status = get_bisect_status(repo.path_str()).await.unwrap();
        assert!(
            status.active,
            "git keeps the session open until reset, which is exactly the problem"
        );
        let culprit = status
            .culprit
            .as_ref()
            .expect("a converged search must report its answer");
        assert_eq!(culprit.oid, bad);
        assert_eq!(culprit.summary, "Bug introduced");

        let _ = run_git_command(&repo.path, &["bisect", "reset"]);
    }

    // `git bisect start` converges on the spot when the range holds a single
    // candidate, and the session stays active until reset. The dialog builds
    // its screen out of what this call returns, so the answer has to be on it
    // — otherwise the start lands the user on Good/Bad/Skip for a search git
    // has already finished.
    #[tokio::test]
    async fn test_bisect_start_carries_the_culprit_when_it_converges_immediately() {
        let repo = TestRepo::with_initial_commit();
        let good = repo.head_oid().to_string();
        repo.create_commit("Bug introduced", &[("bug.txt", "bug")]);
        let bad = repo.head_oid().to_string();

        let result = bisect_start(repo.path_str(), Some(bad.clone()), Some(good))
            .await
            .unwrap();

        assert!(
            result.status.active,
            "git holds the session open until reset"
        );
        let culprit = result
            .status
            .culprit
            .as_ref()
            .expect("a start that already converged must carry the answer");
        assert_eq!(culprit.oid, bad);
        assert_eq!(culprit.summary, "Bug introduced");

        let _ = run_git_command(&repo.path, &["bisect", "reset"]);
    }

    // The guard against reporting the range endpoint as the answer on step one.
    #[tokio::test]
    async fn test_get_bisect_status_has_no_culprit_mid_search() {
        let repo = TestRepo::with_initial_commit();
        let good = repo.head_oid().to_string();
        for i in 2..=5 {
            repo.create_commit(
                &format!("Commit {}", i),
                &[(format!("f{}.txt", i).as_str(), "x")],
            );
        }
        let bad = repo.head_oid().to_string();

        bisect_start(repo.path_str(), Some(bad), Some(good))
            .await
            .unwrap();

        let status = get_bisect_status(repo.path_str()).await.unwrap();
        assert!(status.active);
        assert!(
            status.culprit.is_none(),
            "a search still in flight has no answer to report"
        );

        let _ = run_git_command(&repo.path, &["bisect", "reset"]);
    }

    #[test]
    fn test_bisect_finished_matches_the_recorded_term() {
        let repo = TestRepo::with_initial_commit();
        let gdir = repo.path.join(".git");
        std::fs::write(
            gdir.join("BISECT_LOG"),
            "git bisect start\n# first broken commit: [abc123] Broke it\n",
        )
        .unwrap();

        assert!(
            bisect_finished(&gdir, "broken"),
            "a --term-new=broken session records its result under that term"
        );
        assert!(
            !bisect_finished(&gdir, "bad"),
            "a mismatched term must not be read as a result"
        );
        assert!(
            parse_bisect_log(&repo.path)
                .iter()
                .all(|e| e.action != "first"),
            "the result comment must stay out of the Bisect History list"
        );

        // Skip-exhaustion writes "# possible first bad commit:" for EACH
        // candidate — git has no answer there, and reading one as final would
        // put the dialog on a result screen naming an arbitrary candidate.
        std::fs::write(
            gdir.join("BISECT_LOG"),
            "git bisect start\n# only skipped commits left to test\n\
             # possible first bad commit: [abc123] Maybe\n\
             # possible first bad commit: [def456] Or maybe\n",
        )
        .unwrap();
        assert!(
            !bisect_finished(&gdir, "bad"),
            "\"only skipped commits left\" is not a converged search"
        );
    }

    #[test]
    fn test_culprit_commit_ignores_an_unresolvable_oid() {
        let repo = TestRepo::with_initial_commit();
        assert!(
            culprit_commit(&repo.path, "0000000000000000000000000000000000000000").is_none(),
            "status must stay Ok with no culprit rather than erroring"
        );
    }
}
