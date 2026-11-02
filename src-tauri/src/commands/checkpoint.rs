//! Working-tree checkpoints (roadmap 4.1, issue #607).
//!
//! A checkpoint is a snapshot of the working tree — tracked changes AND
//! untracked, non-ignored files — stored as a commit under
//! `refs/gitnado/checkpoints/<id>`. Taking one never touches the index, HEAD
//! or the reflog, so it is safe to take before and after every agent turn.
//! The ref keeps the objects alive; the graph and ref lists skip the
//! namespace (see `utils::internal_refs`).
//!
//! Restoring makes the working tree match the snapshot (removing files created
//! since, never touching ignored files) and leaves HEAD where it is, with the
//! difference shown as unstaged changes. A restore first takes an automatic
//! "before restore" checkpoint, so it can itself be undone.

use std::path::Path;

use git2::{build::CheckoutBuilder, IndexAddOption, Oid, Repository, Signature};
use serde::Serialize;
use tauri::command;

use crate::error::{GitnadoError, Result};

pub const CHECKPOINT_REF_PREFIX: &str = "refs/gitnado/checkpoints/";
const MAX_LABEL_LEN: usize = 200;

/// A stored checkpoint.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    /// Identifier (the ref name after the prefix).
    pub id: String,
    pub oid: String,
    pub label: String,
    /// Agent session that created it, when taken on an agent's behalf.
    pub session_id: Option<String>,
    /// HEAD commit when the checkpoint was taken (`None` on an unborn branch).
    pub head_oid: Option<String>,
    /// Branch checked out when the checkpoint was taken.
    pub branch: Option<String>,
    /// Unix timestamp (seconds).
    pub created_at: i64,
    /// Files that differ from HEAD-at-the-time.
    pub files_changed: usize,
}

/// One file in a checkpoint, relative to the HEAD it was taken on.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFile {
    pub path: String,
    /// "added", "modified", "deleted", "renamed" or "typechange".
    pub status: String,
}

/// Outcome of a restore.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreCheckpointResult {
    pub restored: Checkpoint,
    /// The automatic checkpoint of the state that was replaced.
    pub backup: Checkpoint,
}

fn validate_id(id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(GitnadoError::OperationFailed(format!(
            "Invalid checkpoint id: {id}"
        )))
    }
}

fn ref_name(id: &str) -> String {
    format!("{CHECKPOINT_REF_PREFIX}{id}")
}

fn signature(repo: &Repository) -> Result<Signature<'static>> {
    Ok(repo
        .signature()
        .or_else(|_| Signature::now("Gitnado", "gitnado@localhost"))?
        .to_owned())
}

fn trailer<'a>(message: &'a str, key: &str) -> Option<&'a str> {
    message.lines().find_map(|line| {
        line.strip_prefix(key)
            .and_then(|rest| rest.strip_prefix(": "))
            .map(str::trim)
            .filter(|v| !v.is_empty())
    })
}

/// Snapshot the working tree into a tree object without touching the
/// on-disk index.
fn snapshot_tree(repo: &Repository) -> Result<Oid> {
    if repo.is_bare() {
        return Err(GitnadoError::OperationFailed(
            "Checkpoints need a working tree".to_string(),
        ));
    }
    let mut index = repo.index()?;
    // In-memory only: add everything (respecting .gitignore), drop entries
    // whose files are gone, write the tree, then discard the changes by
    // reloading from disk. index.write() is never called.
    let result = (|| -> std::result::Result<Oid, git2::Error> {
        index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None)?;
        index.update_all(["*"].iter(), None)?;
        index.write_tree_to(repo)
    })();
    index.read(true)?;
    Ok(result?)
}

fn changed_files(repo: &Repository, commit: &git2::Commit<'_>) -> Result<Vec<CheckpointFile>> {
    let tree = commit.tree()?;
    let base = match commit.parent_count() {
        0 => None,
        _ => Some(commit.parent(0)?.tree()?),
    };
    let mut diff = repo.diff_tree_to_tree(base.as_ref(), Some(&tree), None)?;
    diff.find_similar(None)?;
    let mut files = Vec::new();
    for delta in diff.deltas() {
        let status = match delta.status() {
            git2::Delta::Added => "added",
            git2::Delta::Deleted => "deleted",
            git2::Delta::Renamed => "renamed",
            git2::Delta::Typechange => "typechange",
            _ => "modified",
        };
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        files.push(CheckpointFile {
            path,
            status: status.to_string(),
        });
    }
    Ok(files)
}

fn checkpoint_from_commit(
    repo: &Repository,
    id: &str,
    commit: &git2::Commit<'_>,
) -> Result<Checkpoint> {
    let message = commit.message().unwrap_or("");
    let label = message.lines().next().unwrap_or("").to_string();
    Ok(Checkpoint {
        id: id.to_string(),
        oid: commit.id().to_string(),
        label,
        session_id: trailer(message, "Session").map(str::to_string),
        head_oid: trailer(message, "Head").map(str::to_string),
        branch: trailer(message, "Branch").map(str::to_string),
        created_at: commit.time().seconds(),
        files_changed: changed_files(repo, commit)?.len(),
    })
}

fn find_checkpoint<'r>(repo: &'r Repository, id: &str) -> Result<git2::Commit<'r>> {
    validate_id(id)?;
    let reference = repo
        .find_reference(&ref_name(id))
        .map_err(|_| GitnadoError::OperationFailed(format!("Checkpoint {id} not found")))?;
    Ok(reference.peel_to_commit()?)
}

fn new_id(repo: &Repository) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut id = format!("{millis}");
    let mut n = 1;
    // Two checkpoints in the same millisecond (before/after a no-op turn).
    while repo.find_reference(&ref_name(&id)).is_ok() {
        n += 1;
        id = format!("{millis}-{n}");
    }
    id
}

/// Take a checkpoint of `repo`'s working tree.
pub fn create_checkpoint_in(
    repo: &Repository,
    label: Option<&str>,
    session_id: Option<&str>,
) -> Result<Checkpoint> {
    if let Some(session) = session_id {
        validate_id(session)
            .map_err(|_| GitnadoError::OperationFailed(format!("Invalid session id: {session}")))?;
    }
    let tree = repo.find_tree(snapshot_tree(repo)?)?;

    let head_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().ok().map(str::to_string));

    let label = label
        .map(|l| l.lines().next().unwrap_or("").trim().to_string())
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| "Checkpoint".to_string());
    let label: String = label.chars().take(MAX_LABEL_LEN).collect();

    let mut message = format!("{label}\n\n");
    if let Some(session) = session_id {
        message.push_str(&format!("Session: {session}\n"));
    }
    if let Some(head) = &head_commit {
        message.push_str(&format!("Head: {}\n", head.id()));
    }
    if let Some(branch) = &branch {
        message.push_str(&format!("Branch: {branch}\n"));
    }

    let sig = signature(repo)?;
    let parents: Vec<&git2::Commit<'_>> = head_commit.iter().collect();
    // update_ref = None: the commit is written without moving HEAD.
    let oid = repo.commit(None, &sig, &sig, &message, &tree, &parents)?;

    let id = new_id(repo);
    repo.reference(&ref_name(&id), oid, false, "gitnado: checkpoint")?;
    let commit = repo.find_commit(oid)?;
    checkpoint_from_commit(repo, &id, &commit)
}

/// All checkpoints, newest first.
pub fn list_checkpoints_in(repo: &Repository) -> Result<Vec<Checkpoint>> {
    let mut out = Vec::new();
    for reference in repo
        .references_glob(&format!("{CHECKPOINT_REF_PREFIX}*"))?
        .flatten()
    {
        let Ok(name) = reference.name() else {
            continue;
        };
        let id = name.trim_start_matches(CHECKPOINT_REF_PREFIX).to_string();
        if validate_id(&id).is_err() {
            continue;
        }
        if let Ok(commit) = reference.peel_to_commit() {
            out.push(checkpoint_from_commit(repo, &id, &commit)?);
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    Ok(out)
}

/// Make the working tree match checkpoint `id`; HEAD stays put.
pub fn restore_checkpoint_in(repo: &Repository, id: &str) -> Result<RestoreCheckpointResult> {
    let target = find_checkpoint(repo, id)?;
    if repo.index()?.has_conflicts() {
        return Err(GitnadoError::OperationFailed(
            "Resolve merge conflicts before restoring a checkpoint".to_string(),
        ));
    }
    let restored = checkpoint_from_commit(repo, id, &target)?;
    let backup = create_checkpoint_in(
        repo,
        Some(&format!("Before restoring \"{}\"", restored.label)),
        None,
    )?;

    let mut checkout = CheckoutBuilder::new();
    checkout.force().remove_untracked(true);
    repo.checkout_tree(target.as_object(), Some(&mut checkout))?;

    // checkout_tree also loaded the snapshot into the index. Put the index
    // back on HEAD so the restored state shows up as unstaged changes rather
    // than silently staged ones.
    let mut index = repo.index()?;
    match repo.head().ok().and_then(|h| h.peel_to_tree().ok()) {
        Some(head_tree) => index.read_tree(&head_tree)?,
        None => index.clear()?,
    }
    index.write()?;

    Ok(RestoreCheckpointResult { restored, backup })
}

fn open(path: &str) -> Result<Repository> {
    Ok(Repository::open(Path::new(path))?)
}

#[command]
pub async fn create_checkpoint(
    path: String,
    label: Option<String>,
    session_id: Option<String>,
) -> Result<Checkpoint> {
    crate::utils::blocking_git(move || {
        let repo = open(&path)?;
        create_checkpoint_in(&repo, label.as_deref(), session_id.as_deref())
    })
    .await
}

#[command]
pub async fn list_checkpoints(path: String) -> Result<Vec<Checkpoint>> {
    crate::utils::blocking_git(move || list_checkpoints_in(&open(&path)?)).await
}

#[command]
pub async fn get_checkpoint_files(path: String, id: String) -> Result<Vec<CheckpointFile>> {
    crate::utils::blocking_git(move || {
        let repo = open(&path)?;
        let commit = find_checkpoint(&repo, &id)?;
        changed_files(&repo, &commit)
    })
    .await
}

#[command]
pub async fn restore_checkpoint(path: String, id: String) -> Result<RestoreCheckpointResult> {
    crate::utils::blocking_git(move || restore_checkpoint_in(&open(&path)?, &id)).await
}

#[command]
pub async fn delete_checkpoint(path: String, id: String) -> Result<()> {
    crate::utils::blocking_git(move || {
        let repo = open(&path)?;
        validate_id(&id)?;
        let mut reference = repo
            .find_reference(&ref_name(&id))
            .map_err(|_| GitnadoError::OperationFailed(format!("Checkpoint {id} not found")))?;
        reference.delete()?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;
    use std::fs;

    fn read(t: &TestRepo, name: &str) -> Option<String> {
        fs::read_to_string(t.path.join(name)).ok()
    }

    #[tokio::test]
    async fn create_snapshots_tracked_and_untracked_without_touching_index_or_head() {
        let t = TestRepo::with_initial_commit();
        let head_before = t.head_oid();
        fs::write(t.path.join("README.md"), "edited").unwrap();
        fs::write(t.path.join("new.txt"), "untracked").unwrap();
        fs::write(t.path.join(".gitignore"), "ignored.log\n").unwrap();
        fs::write(t.path.join("ignored.log"), "noise").unwrap();
        let index_before = fs::read(t.path.join(".git/index")).unwrap();

        let cp = create_checkpoint(
            t.path_str(),
            Some("Before turn".into()),
            Some("sess-1".into()),
        )
        .await
        .unwrap();

        assert_eq!(cp.label, "Before turn");
        assert_eq!(cp.session_id.as_deref(), Some("sess-1"));
        assert_eq!(cp.head_oid, Some(head_before.to_string()));
        assert_eq!(cp.branch.as_deref(), Some("main"));
        assert_eq!(t.head_oid(), head_before, "HEAD must not move");
        assert_eq!(
            fs::read(t.path.join(".git/index")).unwrap(),
            index_before,
            "the on-disk index must be untouched"
        );

        let files = get_checkpoint_files(t.path_str(), cp.id.clone())
            .await
            .unwrap();
        let paths: Vec<_> = files
            .iter()
            .map(|f| (f.path.as_str(), f.status.as_str()))
            .collect();
        assert!(paths.contains(&("README.md", "modified")));
        assert!(paths.contains(&("new.txt", "added")));
        assert!(paths.contains(&(".gitignore", "added")));
        assert!(
            !paths.iter().any(|(p, _)| *p == "ignored.log"),
            "ignored files are not captured"
        );
        assert_eq!(cp.files_changed, files.len());

        // The working tree status is unchanged (still untracked / unstaged).
        let repo = t.repo();
        let st = repo.status_file(Path::new("new.txt")).unwrap();
        assert!(st.contains(git2::Status::WT_NEW));
    }

    #[tokio::test]
    async fn checkpoints_are_listed_newest_first_and_hidden_from_history() {
        let t = TestRepo::with_initial_commit();
        let a = create_checkpoint(t.path_str(), Some("first".into()), None)
            .await
            .unwrap();
        fs::write(t.path.join("x.txt"), "x").unwrap();
        let b = create_checkpoint(t.path_str(), Some("second".into()), None)
            .await
            .unwrap();
        assert_ne!(a.id, b.id);

        let list = list_checkpoints(t.path_str()).await.unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, b.id);
        assert_eq!(list[1].id, a.id);

        // Not shown as a ref label in the sidebar/graph.
        let refs = crate::commands::refs::get_refs_by_commit(t.path_str())
            .await
            .unwrap();
        let json = serde_json::to_string(&refs).unwrap();
        assert!(
            !json.contains("refs/gitnado"),
            "checkpoint leaked into refs: {json}"
        );
    }

    #[tokio::test]
    async fn checkpoint_commits_never_appear_in_the_graph_or_search() {
        let t = TestRepo::with_initial_commit();
        fs::write(t.path.join("x.txt"), "x").unwrap();
        let cp = create_checkpoint(t.path_str(), Some("secret-label".into()), None)
            .await
            .unwrap();

        let graph = crate::commands::commit::get_commit_history(
            t.path_str(),
            None,
            Some(100),
            None,
            Some(true),
        )
        .await
        .unwrap();
        assert!(graph.iter().all(|c| c.oid != cp.oid), "checkpoint in graph");
        assert_eq!(
            crate::commands::commit::get_commit_total(t.path_str())
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn restore_brings_back_the_snapshot_and_removes_later_files() {
        let t = TestRepo::with_initial_commit();
        fs::write(t.path.join("README.md"), "agent turn 1").unwrap();
        fs::write(t.path.join("kept.txt"), "kept").unwrap();
        fs::write(t.path.join(".gitignore"), "build/\n").unwrap();
        let cp = create_checkpoint(t.path_str(), Some("after turn 1".into()), None)
            .await
            .unwrap();

        // Agent turn 2 makes a mess.
        fs::write(t.path.join("README.md"), "agent turn 2").unwrap();
        fs::remove_file(t.path.join("kept.txt")).unwrap();
        fs::write(t.path.join("junk.txt"), "junk").unwrap();
        fs::create_dir_all(t.path.join("build")).unwrap();
        fs::write(t.path.join("build/out.bin"), "artifact").unwrap();
        let head = t.head_oid();

        let result = restore_checkpoint(t.path_str(), cp.id.clone())
            .await
            .unwrap();

        assert_eq!(read(&t, "README.md").as_deref(), Some("agent turn 1"));
        assert_eq!(read(&t, "kept.txt").as_deref(), Some("kept"));
        assert_eq!(
            read(&t, "junk.txt"),
            None,
            "files created after the checkpoint are removed"
        );
        assert_eq!(
            read(&t, "build/out.bin").as_deref(),
            Some("artifact"),
            "ignored files are never touched"
        );
        assert_eq!(t.head_oid(), head, "HEAD stays put");

        // Restored changes are unstaged, not staged.
        let repo = t.repo();
        let st = repo.status_file(Path::new("README.md")).unwrap();
        assert!(st.contains(git2::Status::WT_MODIFIED));
        assert!(!st.contains(git2::Status::INDEX_MODIFIED));

        // The replaced state was backed up and can be restored in turn.
        assert!(result.backup.label.starts_with("Before restoring"));
        restore_checkpoint(t.path_str(), result.backup.id.clone())
            .await
            .unwrap();
        assert_eq!(read(&t, "README.md").as_deref(), Some("agent turn 2"));
        assert_eq!(read(&t, "junk.txt").as_deref(), Some("junk"));
        assert_eq!(read(&t, "kept.txt"), None);
    }

    #[tokio::test]
    async fn restore_works_after_head_moved() {
        let t = TestRepo::with_initial_commit();
        fs::write(t.path.join("a.txt"), "draft").unwrap();
        let cp = create_checkpoint(t.path_str(), None, None).await.unwrap();
        // The agent then commits something else.
        t.create_commit("agent commit", &[("b.txt", "b")]);
        let head = t.head_oid();

        restore_checkpoint(t.path_str(), cp.id).await.unwrap();
        assert_eq!(read(&t, "a.txt").as_deref(), Some("draft"));
        assert_eq!(t.head_oid(), head);
        // b.txt is committed at HEAD but absent from the snapshot: it shows as
        // a working-tree deletion rather than vanishing from history.
        let st = t.repo().status_file(Path::new("b.txt")).unwrap();
        assert!(st.contains(git2::Status::WT_DELETED));
    }

    #[tokio::test]
    async fn delete_removes_the_ref() {
        let t = TestRepo::with_initial_commit();
        let cp = create_checkpoint(t.path_str(), None, None).await.unwrap();
        assert_eq!(cp.label, "Checkpoint");
        delete_checkpoint(t.path_str(), cp.id.clone())
            .await
            .unwrap();
        assert!(list_checkpoints(t.path_str()).await.unwrap().is_empty());
        assert!(delete_checkpoint(t.path_str(), cp.id).await.is_err());
    }

    #[tokio::test]
    async fn works_on_an_unborn_branch() {
        let t = TestRepo::new();
        fs::write(t.path.join("first.txt"), "hello").unwrap();
        let cp = create_checkpoint(t.path_str(), None, None).await.unwrap();
        assert_eq!(cp.head_oid, None);
        assert_eq!(cp.files_changed, 1);
        fs::write(t.path.join("first.txt"), "changed").unwrap();
        restore_checkpoint(t.path_str(), cp.id).await.unwrap();
        assert_eq!(read(&t, "first.txt").as_deref(), Some("hello"));
    }

    #[tokio::test]
    async fn rejects_bad_ids_and_unknown_checkpoints() {
        let t = TestRepo::with_initial_commit();
        for bad in ["", "../heads/main", "a/b", "x y"] {
            assert!(
                restore_checkpoint(t.path_str(), bad.into()).await.is_err(),
                "{bad:?}"
            );
            assert!(
                delete_checkpoint(t.path_str(), bad.into()).await.is_err(),
                "{bad:?}"
            );
        }
        let err = restore_checkpoint(t.path_str(), "123".into())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not found"), "{err}");
        assert!(
            create_checkpoint(t.path_str(), None, Some("bad/session".into()))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn multi_line_label_keeps_the_first_line() {
        let t = TestRepo::with_initial_commit();
        let cp = create_checkpoint(t.path_str(), Some("line one\nSession: forged".into()), None)
            .await
            .unwrap();
        assert_eq!(cp.label, "line one");
        assert_eq!(cp.session_id, None, "a label cannot forge trailers");
    }

    #[test]
    fn checkpoint_serializes_camel_case() {
        let cp = Checkpoint {
            id: "1".into(),
            oid: "abc".into(),
            label: "l".into(),
            session_id: Some("s".into()),
            head_oid: None,
            branch: None,
            created_at: 1,
            files_changed: 2,
        };
        let json = serde_json::to_string(&cp).unwrap();
        for key in ["sessionId", "headOid", "createdAt", "filesChanged"] {
            assert!(json.contains(key), "{json}");
        }
    }
}
