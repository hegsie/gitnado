//! Agent guardrails (roadmap 4.1, issue #609): scan what a push is about to
//! publish before it leaves the machine.
//!
//! "Outgoing" is every commit reachable from the branch that no remote-tracking
//! ref has yet (`git log <branch> --not --remotes`), so a brand-new branch with
//! no upstream is covered as well as one that is simply ahead. Only lines those
//! commits ADD are scanned: a commit that removes a leaked key is the fix, not
//! the leak.
//!
//! The scan is the Vibe Check's local secret scan — regex only, no model and
//! no network — so it is fast and deterministic enough to sit in front of
//! every push.

use std::path::Path;

use serde::Serialize;
use tauri::command;

use crate::commands::ai::detect_secrets;
use crate::error::{GitnadoError, Result};
use crate::services::ai::{AnalysisFinding, RiskLevel, Severity};
use crate::utils::create_command;

/// Diff text beyond this is not scanned; the result says so.
const MAX_SCAN_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingScan {
    /// The branch that was scanned.
    pub branch: String,
    /// Commits the push would publish.
    pub commits: usize,
    pub findings: Vec<AnalysisFinding>,
    pub risk_level: RiskLevel,
    /// The outgoing diff was larger than the scan limit; the tail was skipped.
    pub truncated: bool,
}

fn git(repo: &str, args: &[&str]) -> Result<std::process::Output> {
    create_command("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run git: {e}")))
}

/// Only file headers and added lines, in a shape `detect_secrets` can attribute
/// to a file (it looks back for the nearest `\n+++ b/` header).
fn added_lines_only(patch: &str) -> String {
    let mut out = String::with_capacity(patch.len() / 2);
    for line in patch.lines() {
        if line.starts_with("+++ ") || (line.starts_with('+') && !line.starts_with("+++")) {
            out.push('\n');
            out.push_str(line);
        }
    }
    out.push('\n');
    out
}

fn risk_of(findings: &[AnalysisFinding]) -> RiskLevel {
    if findings
        .iter()
        .any(|f| matches!(f.severity, Severity::Error))
    {
        RiskLevel::High
    } else if findings
        .iter()
        .any(|f| matches!(f.severity, Severity::Warning))
    {
        RiskLevel::Medium
    } else {
        RiskLevel::Low
    }
}

pub fn scan_outgoing_in(repo: &str, branch: &str) -> Result<OutgoingScan> {
    if branch.starts_with('-') {
        return Err(GitnadoError::OperationFailed(
            "Branch name must not start with '-'".into(),
        ));
    }
    if !Path::new(repo).exists() {
        return Err(GitnadoError::RepositoryNotFound(repo.to_string()));
    }
    let refname = format!("refs/heads/{branch}");

    let count = git(
        repo,
        &["rev-list", "--count", &refname, "--not", "--remotes"],
    )?;
    if !count.status.success() {
        return Err(GitnadoError::OperationFailed(format!(
            "Could not list the commits to push: {}",
            String::from_utf8_lossy(&count.stderr).trim()
        )));
    }
    let commits: usize = String::from_utf8_lossy(&count.stdout)
        .trim()
        .parse()
        .unwrap_or(0);
    if commits == 0 {
        return Ok(OutgoingScan {
            branch: branch.to_string(),
            commits: 0,
            findings: vec![],
            risk_level: RiskLevel::Low,
            truncated: false,
        });
    }

    let log = git(
        repo,
        &[
            "log",
            "-p",
            "--no-color",
            "--no-ext-diff",
            "--format=",
            &refname,
            "--not",
            "--remotes",
        ],
    )?;
    if !log.status.success() {
        return Err(GitnadoError::OperationFailed(format!(
            "Could not read the commits to push: {}",
            String::from_utf8_lossy(&log.stderr).trim()
        )));
    }
    let truncated = log.stdout.len() > MAX_SCAN_BYTES;
    let bytes = &log.stdout[..log.stdout.len().min(MAX_SCAN_BYTES)];
    let added = added_lines_only(&String::from_utf8_lossy(bytes));

    let mut findings = detect_secrets(&added);
    // One finding per (file, message): the same key repeated across several
    // commits of one push is one problem to fix.
    let mut seen = std::collections::HashSet::new();
    findings.retain(|f| seen.insert((f.file_path.clone(), f.message.clone())));

    Ok(OutgoingScan {
        branch: branch.to_string(),
        commits,
        risk_level: risk_of(&findings),
        findings,
        truncated,
    })
}

/// Scan the commits a push of `branch` would publish for secrets.
#[command]
pub async fn scan_outgoing_changes(path: String, branch: String) -> Result<OutgoingScan> {
    crate::utils::blocking_git(move || scan_outgoing_in(&path, &branch)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    const AWS: &str = "aws_key = AKIAABCDEFGHIJKLMNOP\n";

    /// A repo whose main is "pushed" (a remote-tracking ref points at it).
    fn pushed_repo() -> TestRepo {
        let t = TestRepo::with_initial_commit();
        let head = t.repo().head().unwrap().target().unwrap();
        t.repo()
            .reference("refs/remotes/origin/main", head, true, "test")
            .unwrap();
        t
    }

    #[tokio::test]
    async fn nothing_outgoing_is_clean() {
        let t = pushed_repo();
        let scan = scan_outgoing_changes(t.path_str(), "main".into())
            .await
            .unwrap();
        assert_eq!(scan.commits, 0);
        assert!(scan.findings.is_empty());
    }

    #[tokio::test]
    async fn a_secret_added_in_an_unpushed_commit_is_found_with_its_file() {
        let t = pushed_repo();
        t.create_commit("add config", &[("config/aws.env", AWS)]);
        t.create_commit("unrelated", &[("notes.txt", "hello")]);
        let scan = scan_outgoing_changes(t.path_str(), "main".into())
            .await
            .unwrap();
        assert_eq!(scan.commits, 2);
        assert_eq!(scan.findings.len(), 1);
        assert_eq!(
            scan.findings[0].file_path.as_deref(),
            Some("config/aws.env")
        );
        assert!(matches!(scan.risk_level, RiskLevel::High));
    }

    #[tokio::test]
    async fn a_new_branch_without_upstream_is_scanned_from_where_it_left_the_remote() {
        let t = pushed_repo();
        t.create_branch("agent/task");
        t.checkout_branch("agent/task");
        t.create_commit(
            "leak",
            &[("k.pem", "-----BEGIN RSA PRIVATE KEY-----\nabc\n")],
        );
        let scan = scan_outgoing_changes(t.path_str(), "agent/task".into())
            .await
            .unwrap();
        assert_eq!(scan.commits, 1);
        assert_eq!(scan.findings[0].message, "Private key detected in diff");
    }

    #[tokio::test]
    async fn removing_a_secret_is_not_flagged_and_already_pushed_secrets_are_not_rescanned() {
        let t = TestRepo::with_initial_commit();
        t.create_commit("old leak", &[("aws.env", AWS)]);
        let head = t.repo().head().unwrap().target().unwrap();
        t.repo()
            .reference("refs/remotes/origin/main", head, true, "test")
            .unwrap();
        t.create_commit("remove leak", &[("aws.env", "aws_key = from-vault\n")]);
        let scan = scan_outgoing_changes(t.path_str(), "main".into())
            .await
            .unwrap();
        assert_eq!(scan.commits, 1);
        assert!(scan.findings.is_empty(), "{:?}", scan.findings);
    }

    #[tokio::test]
    async fn the_same_secret_in_several_commits_is_reported_once() {
        let t = pushed_repo();
        t.create_commit("one", &[("a.env", AWS)]);
        t.create_commit("two", &[("a.env", format!("{AWS}x = 1\n").as_str())]);
        t.create_commit("three", &[("b.env", AWS)]);
        let scan = scan_outgoing_changes(t.path_str(), "main".into())
            .await
            .unwrap();
        let mut files: Vec<String> = scan
            .findings
            .iter()
            .map(|f| f.file_path.clone().unwrap())
            .collect();
        files.sort();
        assert_eq!(files, vec!["a.env".to_string(), "b.env".to_string()]);
    }

    #[tokio::test]
    async fn flag_like_and_unknown_branches_are_errors() {
        let t = pushed_repo();
        assert!(scan_outgoing_changes(t.path_str(), "--all".into())
            .await
            .is_err());
        assert!(scan_outgoing_changes(t.path_str(), "nope".into())
            .await
            .is_err());
    }

    #[test]
    fn only_added_lines_and_headers_are_kept() {
        let patch =
            "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old secret\n+new line\n context\n";
        assert_eq!(added_lines_only(patch), "\n+++ b/x\n+new line\n");
    }
}
