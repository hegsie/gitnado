//! Commit Composer / Recompose (roadmap 4.4, issue #618).
//!
//! Take a range of commits (`base..HEAD` on the current branch) or the
//! working tree's changes and rewrite them as a new series of commits, each
//! holding a chosen group of files with its own message.
//!
//! Applying never goes through a merge or rebase: every new commit's tree is
//! built directly — the previous new commit's tree with this group's files set
//! to their final content. In range mode the last new commit therefore has
//! exactly the original tip's tree, so the working tree and index are never
//! touched and nothing can conflict. In working-tree mode the commits take the
//! files' on-disk content and the index is brought in line afterwards.
//!
//! Undo: the branch's previous tip is recorded in `<gitdir>/gitnado/
//! recompose.json` (and stays reachable through the branch's reflog), and
//! `undo_recompose` moves the branch back as long as nothing was committed on
//! top since.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use git2::{build::TreeUpdateBuilder, Delta, DiffOptions, FileMode, Oid, Repository};
use serde::{Deserialize, Serialize};
use tauri::command;

use crate::error::{GitnadoError, Result};

/// Commits beyond this many are refused: recompose is for a branch's work,
/// not for rewriting long histories.
const MAX_RANGE_COMMITS: usize = 200;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecomposeFile {
    pub path: String,
    /// "added" | "modified" | "deleted"
    pub status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecomposeCommit {
    pub oid: String,
    pub summary: String,
    pub files: Vec<String>,
}

/// What would be recomposed: the "before" side of the preview.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecomposeSource {
    /// "range" (commits base..HEAD) or "worktree" (uncommitted changes).
    pub mode: String,
    pub branch: String,
    pub head_oid: String,
    /// The commit the new series starts from.
    pub base_oid: String,
    /// The commits being replaced (range mode), oldest first.
    pub commits: Vec<RecomposeCommit>,
    /// Every file changed between base and the final state.
    pub files: Vec<RecomposeFile>,
}

/// One commit of the new series.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecomposeGroup {
    pub message: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecomposeRecord {
    pub branch: String,
    /// The branch tip before recomposing.
    pub before: String,
    /// The branch tip the recompose produced.
    pub after: String,
    pub mode: String,
    pub created_at: i64,
}

fn record_path(repo: &Repository) -> PathBuf {
    repo.path().join("gitnado").join("recompose.json")
}

pub fn last_record(repo: &Repository) -> Option<RecomposeRecord> {
    let text = std::fs::read_to_string(record_path(repo)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_record(repo: &Repository, record: &RecomposeRecord) -> Result<()> {
    let path = record_path(repo);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, serde_json::to_vec_pretty(record)?)?;
    Ok(())
}

fn current_branch(repo: &Repository) -> Result<(String, Oid)> {
    let head = repo.head().map_err(|_| {
        GitnadoError::OperationFailed("The repository has no commits yet".to_string())
    })?;
    if !head.is_branch() {
        return Err(GitnadoError::OperationFailed(
            "HEAD is detached; check out a branch to recompose its commits".to_string(),
        ));
    }
    let name = head
        .shorthand()
        .map_err(|_| GitnadoError::OperationFailed("Unreadable branch name".to_string()))?
        .to_string();
    let oid = head
        .target()
        .ok_or_else(|| GitnadoError::OperationFailed("HEAD has no target".to_string()))?;
    Ok((name, oid))
}

fn status_name(delta: Delta) -> &'static str {
    match delta {
        Delta::Added | Delta::Untracked | Delta::Copied => "added",
        Delta::Deleted => "deleted",
        _ => "modified",
    }
}

fn diff_files(diff: &git2::Diff) -> Vec<RecomposeFile> {
    let mut files = BTreeMap::new();
    for delta in diff.deltas() {
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().replace('\\', "/"));
        if let Some(path) = path {
            files.insert(path, status_name(delta.status()).to_string());
        }
    }
    files
        .into_iter()
        .map(|(path, status)| RecomposeFile { path, status })
        .collect()
}

fn no_renames_opts() -> DiffOptions {
    let mut opts = DiffOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    opts
}

/// The commits base..head, oldest first, refusing merges.
fn range_commits(repo: &Repository, base: Oid, head: Oid) -> Result<Vec<RecomposeCommit>> {
    let mut walk = repo.revwalk()?;
    walk.push(head)?;
    walk.hide(base)?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::REVERSE)?;
    let mut commits = Vec::new();
    for oid in walk {
        let oid = oid?;
        let commit = repo.find_commit(oid)?;
        if commit.parent_count() > 1 {
            return Err(GitnadoError::OperationFailed(format!(
                "{} is a merge commit; recompose works on a straight run of commits",
                &oid.to_string()[..7]
            )));
        }
        let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
        let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit.tree()?), None)?;
        commits.push(RecomposeCommit {
            oid: oid.to_string(),
            summary: commit.summary().ok().flatten().unwrap_or("").to_string(),
            files: diff_files(&diff).into_iter().map(|f| f.path).collect(),
        });
        if commits.len() > MAX_RANGE_COMMITS {
            return Err(GitnadoError::OperationFailed(format!(
                "More than {MAX_RANGE_COMMITS} commits; choose a closer base"
            )));
        }
    }
    Ok(commits)
}

pub fn source_in(repo: &Repository, base: Option<&str>) -> Result<RecomposeSource> {
    let (branch, head) = current_branch(repo)?;
    let head_commit = repo.find_commit(head)?;
    match base {
        Some(base) => {
            crate::utils::reject_flag_like(base, "Base")?;
            let base_oid = repo
                .revparse_single(base)
                .and_then(|o| o.peel_to_commit())
                .map_err(|_| GitnadoError::OperationFailed(format!("Unknown base {base}")))?
                .id();
            if base_oid == head {
                return Err(GitnadoError::OperationFailed(
                    "The base is the branch tip: there are no commits to recompose".to_string(),
                ));
            }
            if !repo.graph_descendant_of(head, base_oid)? {
                return Err(GitnadoError::OperationFailed(format!(
                    "{base} is not an ancestor of {branch}"
                )));
            }
            let commits = range_commits(repo, base_oid, head)?;
            let diff = repo.diff_tree_to_tree(
                Some(&repo.find_commit(base_oid)?.tree()?),
                Some(&head_commit.tree()?),
                None,
            )?;
            Ok(RecomposeSource {
                mode: "range".to_string(),
                branch,
                head_oid: head.to_string(),
                base_oid: base_oid.to_string(),
                commits,
                files: diff_files(&diff),
            })
        }
        None => {
            let mut opts = no_renames_opts();
            let diff =
                repo.diff_tree_to_workdir_with_index(Some(&head_commit.tree()?), Some(&mut opts))?;
            Ok(RecomposeSource {
                mode: "worktree".to_string(),
                branch,
                head_oid: head.to_string(),
                base_oid: head.to_string(),
                commits: vec![],
                files: diff_files(&diff),
            })
        }
    }
}

/// Every group non-empty and messaged; every file changed and used once; in
/// range mode every changed file assigned (the series must end on the tip).
fn validate(source: &RecomposeSource, groups: &[RecomposeGroup]) -> Result<()> {
    if groups.is_empty() {
        return Err(GitnadoError::OperationFailed(
            "Add at least one commit".to_string(),
        ));
    }
    let changed: BTreeSet<&str> = source.files.iter().map(|f| f.path.as_str()).collect();
    let mut seen = BTreeSet::new();
    for (i, group) in groups.iter().enumerate() {
        if group.message.trim().is_empty() {
            return Err(GitnadoError::OperationFailed(format!(
                "Commit {} has no message",
                i + 1
            )));
        }
        if group.files.is_empty() {
            return Err(GitnadoError::OperationFailed(format!(
                "Commit {} has no files",
                i + 1
            )));
        }
        for file in &group.files {
            if !changed.contains(file.as_str()) {
                return Err(GitnadoError::OperationFailed(format!(
                    "{file} has no changes to commit"
                )));
            }
            if !seen.insert(file.as_str()) {
                return Err(GitnadoError::OperationFailed(format!(
                    "{file} is in more than one commit"
                )));
            }
        }
    }
    if source.mode == "range" {
        let missing: Vec<&str> = changed.difference(&seen).copied().collect();
        if !missing.is_empty() {
            return Err(GitnadoError::OperationFailed(format!(
                "Every changed file must be in a commit; not yet assigned: {}",
                missing.join(", ")
            )));
        }
    }
    Ok(())
}

/// The final content of `path`: from the tip's tree (range) or from disk
/// (worktree). None when the file is deleted.
fn final_entry(
    repo: &Repository,
    tip_tree: Option<&git2::Tree>,
    path: &str,
) -> Result<Option<(Oid, FileMode)>> {
    if let Some(tree) = tip_tree {
        return Ok(match tree.get_path(Path::new(path)) {
            Ok(entry) => Some((entry.id(), file_mode(entry.filemode()))),
            Err(_) => None,
        });
    }
    let workdir = repo
        .workdir()
        .ok_or_else(|| GitnadoError::OperationFailed("Bare repository".to_string()))?;
    let full = workdir.join(path);
    let meta = match std::fs::symlink_metadata(&full) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(&full)?;
        let oid = repo.blob(target.to_string_lossy().as_bytes())?;
        return Ok(Some((oid, FileMode::Link)));
    }
    let oid = repo.blob_path(&full)?;
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 != 0 {
            FileMode::BlobExecutable
        } else {
            FileMode::Blob
        }
    };
    #[cfg(not(unix))]
    let mode = FileMode::Blob;
    Ok(Some((oid, mode)))
}

fn file_mode(raw: i32) -> FileMode {
    match raw {
        0o100755 => FileMode::BlobExecutable,
        0o120000 => FileMode::Link,
        0o160000 => FileMode::Commit,
        _ => FileMode::Blob,
    }
}

pub fn apply_in(
    repo: &Repository,
    base: Option<&str>,
    groups: &[RecomposeGroup],
) -> Result<RecomposeRecord> {
    if repo.state() != git2::RepositoryState::Clean {
        return Err(GitnadoError::OperationFailed(
            "Finish or abort the operation in progress first".to_string(),
        ));
    }
    let source = source_in(repo, base)?;
    validate(&source, groups)?;

    let head = Oid::from_str(&source.head_oid)?;
    let base_oid = Oid::from_str(&source.base_oid)?;
    let tip_tree = if source.mode == "range" {
        Some(repo.find_commit(head)?.tree()?)
    } else {
        None
    };
    let signature = repo.signature()?;

    let mut parent = repo.find_commit(base_oid)?;
    for group in groups {
        let mut builder = TreeUpdateBuilder::new();
        for file in &group.files {
            match final_entry(repo, tip_tree.as_ref(), file)? {
                Some((oid, mode)) => {
                    builder.upsert(file.as_str(), oid, mode);
                }
                None => {
                    builder.remove(file.as_str());
                }
            }
        }
        let tree_oid = builder.create_updated(repo, &parent.tree()?)?;
        let tree = repo.find_tree(tree_oid)?;
        let oid = repo.commit(
            None,
            &signature,
            &signature,
            group.message.trim(),
            &tree,
            &[&parent],
        )?;
        parent = repo.find_commit(oid)?;
    }

    if let Some(tip) = &tip_tree {
        // Belt and braces: the series must end exactly where the branch was.
        if parent.tree_id() != tip.id() {
            return Err(GitnadoError::OperationFailed(
                "The new commits do not add up to the branch tip; nothing was changed".to_string(),
            ));
        }
    }

    let refname = format!("refs/heads/{}", source.branch);
    repo.reference_matching(
        &refname,
        parent.id(),
        true,
        head,
        "gitnado: recompose commits",
    )
    .map_err(|e| {
        GitnadoError::OperationFailed(format!(
            "{} moved while recomposing: {}",
            source.branch,
            e.message()
        ))
    })?;

    if source.mode == "worktree" {
        // The committed paths now match HEAD; make the index agree so they do
        // not show as staged changes. Other paths keep whatever was staged.
        let paths: Vec<&str> = groups
            .iter()
            .flat_map(|g| g.files.iter().map(String::as_str))
            .collect();
        repo.reset_default(Some(parent.as_object()), paths)?;
    }

    let record = RecomposeRecord {
        branch: source.branch,
        before: head.to_string(),
        after: parent.id().to_string(),
        mode: source.mode,
        created_at: chrono::Utc::now().timestamp(),
    };
    write_record(repo, &record)?;
    Ok(record)
}

pub fn undo_in(repo: &Repository) -> Result<RecomposeRecord> {
    let record = last_record(repo).ok_or_else(|| {
        GitnadoError::OperationFailed("There is no recompose to undo".to_string())
    })?;
    let refname = format!("refs/heads/{}", record.branch);
    let after = Oid::from_str(&record.after)?;
    let before = Oid::from_str(&record.before)?;
    let current = repo
        .find_reference(&refname)
        .ok()
        .and_then(|r| r.target())
        .ok_or_else(|| GitnadoError::BranchNotFound(record.branch.clone()))?;
    if current != after {
        return Err(GitnadoError::OperationFailed(format!(
            "{} has changed since it was recomposed; undo is no longer available",
            record.branch
        )));
    }
    repo.find_commit(before)?;
    repo.reference_matching(&refname, before, true, after, "gitnado: undo recompose")?;
    if record.mode == "worktree" {
        // Back to uncommitted changes: the files on disk never moved, so a
        // mixed reset of the index to the old tip restores the starting point.
        let head = repo.head()?;
        if head.name().ok() == Some(refname.as_str()) {
            let commit = repo.find_commit(before)?;
            repo.reset(commit.as_object(), git2::ResetType::Mixed, None)?;
        }
    }
    std::fs::remove_file(record_path(repo)).ok();
    Ok(record)
}

/// The changes a recompose covers as text for the AI: the file list, then
/// the patch (untracked files included with their content).
pub fn changes_text(repo: &Repository, base: Option<&str>) -> Result<String> {
    let source = source_in(repo, base)?;
    let head_tree = repo.find_commit(Oid::from_str(&source.head_oid)?)?.tree()?;
    let diff = match base {
        Some(_) => {
            let base_tree = repo.find_commit(Oid::from_str(&source.base_oid)?)?.tree()?;
            repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), None)?
        }
        None => {
            let mut opts = no_renames_opts();
            opts.show_untracked_content(true);
            repo.diff_tree_to_workdir_with_index(Some(&head_tree), Some(&mut opts))?
        }
    };
    let mut text = String::from("Changed files:\n");
    for f in &source.files {
        text.push_str(&format!("- {} ({})\n", f.path, f.status));
    }
    text.push_str("\nDiff:\n");
    diff.print(git2::DiffFormat::Patch, |_, _, line| {
        let origin = line.origin();
        if matches!(origin, '+' | '-' | ' ') {
            text.push(origin);
        }
        text.push_str(&String::from_utf8_lossy(line.content()));
        true
    })?;
    Ok(text)
}

fn open(path: &str) -> Result<Repository> {
    Ok(Repository::open(Path::new(path))?)
}

/// The commits (or working-tree changes) a recompose would replace.
#[command]
pub async fn get_recompose_source(path: String, base: Option<String>) -> Result<RecomposeSource> {
    crate::utils::blocking_git(move || source_in(&open(&path)?, base.as_deref())).await
}

/// Rewrite `base..HEAD` (or the working tree when `base` is None) as `groups`.
#[command]
pub async fn apply_recompose(
    path: String,
    base: Option<String>,
    groups: Vec<RecomposeGroup>,
) -> Result<RecomposeRecord> {
    crate::utils::blocking_git(move || apply_in(&open(&path)?, base.as_deref(), &groups)).await
}

/// The last recompose, while it can still be undone.
#[command]
pub async fn get_last_recompose(path: String) -> Result<Option<RecomposeRecord>> {
    crate::utils::blocking_git(move || {
        let repo = open(&path)?;
        Ok(last_record(&repo).filter(|r| {
            repo.find_reference(&format!("refs/heads/{}", r.branch))
                .ok()
                .and_then(|x| x.target())
                .map(|t| t.to_string())
                .as_deref()
                == Some(r.after.as_str())
        }))
    })
    .await
}

/// Move the branch back to before the last recompose.
#[command]
pub async fn undo_recompose(path: String) -> Result<RecomposeRecord> {
    crate::utils::blocking_git(move || undo_in(&open(&path)?)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    fn g(message: &str, files: &[&str]) -> RecomposeGroup {
        RecomposeGroup {
            message: message.to_string(),
            files: files.iter().map(|f| f.to_string()).collect(),
        }
    }

    /// main: init, then three commits touching a, b, c (a twice).
    fn three_commits() -> (TestRepo, String) {
        let t = TestRepo::with_initial_commit();
        let base = t.repo().head().unwrap().target().unwrap().to_string();
        t.create_commit("wip 1", &[("a.txt", "a1"), ("b.txt", "b1")]);
        t.create_commit("wip 2", &[("a.txt", "a2"), ("c.txt", "c1")]);
        t.create_commit("wip 3", &[("README.md", "# Changed")]);
        (t, base)
    }

    fn head_tree(t: &TestRepo) -> Oid {
        t.repo().head().unwrap().peel_to_tree().unwrap().id()
    }

    fn log(t: &TestRepo, n: usize) -> Vec<(String, Vec<String>)> {
        let repo = t.repo();
        let mut out = Vec::new();
        let mut c = repo.head().unwrap().peel_to_commit().unwrap();
        for _ in 0..n {
            let parent = c.parent(0).unwrap();
            let diff = repo
                .diff_tree_to_tree(
                    Some(&parent.tree().unwrap()),
                    Some(&c.tree().unwrap()),
                    None,
                )
                .unwrap();
            out.push((
                c.summary().unwrap().unwrap().to_string(),
                diff_files(&diff).into_iter().map(|f| f.path).collect(),
            ));
            c = parent;
        }
        out.reverse();
        out
    }

    #[tokio::test]
    async fn source_lists_the_range_and_its_files() {
        let (t, base) = three_commits();
        let src = get_recompose_source(t.path_str(), Some(base.clone()))
            .await
            .unwrap();
        assert_eq!(src.mode, "range");
        assert_eq!(src.branch, "main");
        assert_eq!(
            src.commits
                .iter()
                .map(|c| c.summary.as_str())
                .collect::<Vec<_>>(),
            vec!["wip 1", "wip 2", "wip 3"]
        );
        assert_eq!(src.commits[1].files, vec!["a.txt", "c.txt"]);
        let files: Vec<_> = src
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status.as_str()))
            .collect();
        assert_eq!(
            files,
            vec![
                ("README.md", "modified"),
                ("a.txt", "added"),
                ("b.txt", "added"),
                ("c.txt", "added")
            ]
        );
    }

    #[tokio::test]
    async fn range_recompose_regroups_commits_and_ends_on_the_same_tree() {
        let (t, base) = three_commits();
        let tree_before = head_tree(&t);
        let record = apply_recompose(
            t.path_str(),
            Some(base.clone()),
            vec![
                g("feat: a and b", &["a.txt", "b.txt"]),
                g("docs: readme and c", &["README.md", "c.txt"]),
            ],
        )
        .await
        .unwrap();
        assert_eq!(head_tree(&t), tree_before, "working state unchanged");
        assert_eq!(
            log(&t, 2),
            vec![
                (
                    "feat: a and b".to_string(),
                    vec!["a.txt".to_string(), "b.txt".to_string()]
                ),
                (
                    "docs: readme and c".to_string(),
                    vec!["README.md".to_string(), "c.txt".to_string()]
                ),
            ]
        );
        let repo = t.repo();
        let new_base = repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .parent(0)
            .unwrap()
            .parent(0)
            .unwrap();
        assert_eq!(new_base.id().to_string(), base);
        assert_eq!(
            record.after,
            t.repo().head().unwrap().target().unwrap().to_string()
        );

        // Undo restores the original three commits.
        let undone = undo_recompose(t.path_str()).await.unwrap();
        assert_eq!(
            t.repo().head().unwrap().target().unwrap().to_string(),
            undone.before
        );
        assert_eq!(log(&t, 3)[2].0, "wip 3");
        assert!(get_last_recompose(t.path_str()).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn range_mode_requires_every_file_once_and_messages() {
        let (t, base) = three_commits();
        let head = t.repo().head().unwrap().target().unwrap();
        let err = |groups| {
            let p = t.path_str();
            let b = base.clone();
            async move {
                apply_recompose(p, Some(b), groups)
                    .await
                    .unwrap_err()
                    .to_string()
            }
        };
        assert!(err(vec![g("x", &["a.txt"])])
            .await
            .contains("not yet assigned"));
        assert!(err(vec![
            g("x", &["a.txt", "b.txt"]),
            g("y", &["a.txt", "c.txt", "README.md"])
        ])
        .await
        .contains("more than one"));
        assert!(
            err(vec![g("  ", &["a.txt", "b.txt", "c.txt", "README.md"])])
                .await
                .contains("no message")
        );
        assert!(err(vec![g("x", &["nope.txt"])])
            .await
            .contains("no changes"));
        assert!(err(vec![]).await.contains("at least one"));
        assert_eq!(
            t.repo().head().unwrap().target().unwrap(),
            head,
            "nothing changed"
        );
    }

    #[tokio::test]
    async fn merges_detached_heads_and_bad_bases_are_refused() {
        let (t, base) = three_commits();
        let head = t.repo().head().unwrap().target().unwrap().to_string();
        assert!(get_recompose_source(t.path_str(), Some(head.clone()))
            .await
            .unwrap_err()
            .to_string()
            .contains("no commits"));
        assert!(get_recompose_source(t.path_str(), Some("--all".into()))
            .await
            .is_err());
        assert!(get_recompose_source(t.path_str(), Some("nope".into()))
            .await
            .is_err());
        t.repo()
            .set_head_detached(Oid::from_str(&base).unwrap())
            .unwrap();
        assert!(get_recompose_source(t.path_str(), None)
            .await
            .unwrap_err()
            .to_string()
            .contains("detached"));
    }

    #[tokio::test]
    async fn worktree_recompose_commits_groups_and_leaves_the_rest_uncommitted() {
        let t = TestRepo::with_initial_commit();
        t.create_commit("tracked", &[("keep.txt", "k"), ("old.txt", "o")]);
        let start = t.repo().head().unwrap().target().unwrap();
        std::fs::write(t.path.join("keep.txt"), "k2").unwrap();
        std::fs::write(t.path.join("new.txt"), "n").unwrap();
        std::fs::remove_file(t.path.join("old.txt")).unwrap();
        std::fs::write(t.path.join("later.txt"), "not yet").unwrap();

        let src = get_recompose_source(t.path_str(), None).await.unwrap();
        assert_eq!(src.mode, "worktree");
        assert_eq!(src.files.len(), 4);

        apply_recompose(
            t.path_str(),
            None,
            vec![
                g("feat: new file", &["new.txt"]),
                g("chore: tidy", &["keep.txt", "old.txt"]),
            ],
        )
        .await
        .unwrap();
        assert_eq!(
            log(&t, 2),
            vec![
                ("feat: new file".to_string(), vec!["new.txt".to_string()]),
                (
                    "chore: tidy".to_string(),
                    vec!["keep.txt".to_string(), "old.txt".to_string()]
                ),
            ]
        );
        // Only later.txt is left as a change; nothing committed shows as staged.
        let left = get_recompose_source(t.path_str(), None).await.unwrap();
        assert_eq!(
            left.files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            vec!["later.txt"]
        );
        let repo = t.repo();
        let head_tree = repo.head().unwrap().peel_to_tree().unwrap();
        let staged = repo
            .diff_tree_to_index(Some(&head_tree), None, None)
            .unwrap();
        assert_eq!(staged.deltas().len(), 0);

        // Undo puts the branch back and the changes back to uncommitted.
        undo_recompose(t.path_str()).await.unwrap();
        assert_eq!(t.repo().head().unwrap().target().unwrap(), start);
        assert_eq!(
            get_recompose_source(t.path_str(), None)
                .await
                .unwrap()
                .files
                .len(),
            4
        );
        assert_eq!(
            std::fs::read_to_string(t.path.join("keep.txt")).unwrap(),
            "k2"
        );
    }

    #[tokio::test]
    async fn undo_is_refused_once_the_branch_has_moved_on() {
        let (t, base) = three_commits();
        apply_recompose(
            t.path_str(),
            Some(base),
            vec![g("all", &["a.txt", "b.txt", "c.txt", "README.md"])],
        )
        .await
        .unwrap();
        t.create_commit("more work", &[("d.txt", "d")]);
        assert!(get_last_recompose(t.path_str()).await.unwrap().is_none());
        let err = undo_recompose(t.path_str()).await.unwrap_err().to_string();
        assert!(err.contains("has changed"), "{err}");
    }

    #[tokio::test]
    async fn changes_text_lists_files_then_the_patch_including_untracked_content() {
        let (t, base) = three_commits();
        let text = changes_text(&t.repo(), Some(&base)).unwrap();
        assert!(text.starts_with("Changed files:\n- README.md (modified)\n- a.txt (added)"));
        assert!(text.contains("+a2"));
        std::fs::write(t.path.join("fresh.txt"), "brand new line").unwrap();
        let wt = changes_text(&t.repo(), None).unwrap();
        assert!(wt.contains("- fresh.txt (added)"));
        assert!(wt.contains("+brand new line"));
    }

    #[test]
    fn record_serializes_camel_case() {
        let json = serde_json::to_string(&RecomposeRecord {
            branch: "main".into(),
            before: "a".into(),
            after: "b".into(),
            mode: "range".into(),
            created_at: 1,
        })
        .unwrap();
        assert!(json.contains("createdAt"));
    }
}
