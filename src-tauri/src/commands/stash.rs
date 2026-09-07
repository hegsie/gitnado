//! Stash command handlers

use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::models::Stash;

/// Result of showing stash contents
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashShowResult {
    pub index: u32,
    /// The stash commit this result describes.
    ///
    /// Echoed so the caller can prove the preview belongs to the entry it
    /// asked for: `index` is a POSITION that shifts whenever any stash is
    /// created or dropped, and the caller resolves the index in a separate
    /// round trip. lv-stash-list compares this against the row's oid and
    /// refuses to render a mismatched preview.
    pub oid: String,
    pub message: String,
    pub files: Vec<StashFile>,
    pub total_additions: u32,
    pub total_deletions: u32,
    pub patch: Option<String>,
}

/// A file in a stash
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashFile {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
    pub status: String,
}

/// Get all stashes
#[command]
pub async fn get_stashes(path: String) -> Result<Vec<Stash>> {
    let mut repo = git2::Repository::open(Path::new(&path))?;
    let mut stashes = Vec::new();

    repo.stash_foreach(|index, message, oid| {
        stashes.push(Stash {
            index,
            message: message.to_string(),
            oid: oid.to_string(),
        });
        true
    })?;

    Ok(stashes)
}

/// Create a new stash
///
/// Returns `Ok(None)` when the working tree is clean and there is nothing to
/// stash. This mirrors `git stash push`, which prints "No local changes to
/// save" and exits 0 — a benign informational no-op, not a failure. libgit2
/// reports nothing-to-stash as `ErrorCode::NotFound`; we translate that into a
/// `None` result so the UI can show an informational toast instead of an error.
#[command]
pub async fn create_stash(
    path: String,
    message: Option<String>,
    include_untracked: Option<bool>,
) -> Result<Option<Stash>> {
    let mut repo = git2::Repository::open(Path::new(&path))?;
    let signature = repo.signature()?;

    let mut flags = git2::StashFlags::DEFAULT;
    if include_untracked.unwrap_or(false) {
        flags |= git2::StashFlags::INCLUDE_UNTRACKED;
    }

    let oid = match repo.stash_save(&signature, message.as_deref().unwrap_or("WIP"), Some(flags)) {
        Ok(oid) => oid,
        Err(e) if e.code() == git2::ErrorCode::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };

    Ok(Some(Stash {
        index: 0,
        message: message.unwrap_or_else(|| "WIP".to_string()),
        oid: oid.to_string(),
    }))
}

/// Apply a stash
#[command]
pub async fn apply_stash(path: String, index: usize, drop_after: Option<bool>) -> Result<()> {
    let mut repo = git2::Repository::open(Path::new(&path))?;

    repo.stash_apply(index, None)?;

    // git_stash_apply returns success (0) even when the apply lands merge
    // conflicts. Surface the conflict so the UI opens the resolution flow, and
    // keep the stash regardless — `drop_after` is only honoured on a CLEAN apply.
    if repo.index()?.has_conflicts() {
        return Err(GitnadoError::MergeConflict);
    }

    if drop_after.unwrap_or(false) {
        repo.stash_drop(index)?;
    }

    Ok(())
}

/// Drop a stash
#[command]
pub async fn drop_stash(path: String, index: usize) -> Result<()> {
    let mut repo = git2::Repository::open(Path::new(&path))?;
    repo.stash_drop(index)?;
    Ok(())
}

/// Pop a stash (apply and drop)
#[command]
pub async fn pop_stash(path: String, index: usize) -> Result<()> {
    let mut repo = git2::Repository::open(Path::new(&path))?;

    // Do NOT use stash_pop: git_stash_pop drops the stash even when the apply
    // lands conflicts (git_stash_apply returns 0 on a conflicted apply), which
    // silently loses the stashed changes. Apply first, and only drop when the
    // apply was clean — on a conflict, surface it and keep the stash so the user
    // can resolve (and the entry remains recoverable).
    repo.stash_apply(index, None)?;

    if repo.index()?.has_conflicts() {
        return Err(GitnadoError::MergeConflict);
    }

    repo.stash_drop(index)?;
    Ok(())
}

/// The path a delta refers to, preferring the new side — a deletion only has an
/// old side.
fn delta_path(delta: &git2::DiffDelta<'_>) -> String {
    delta
        .new_file()
        .path()
        .or_else(|| delta.old_file().path())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Append one diff's files (with per-file line counts) to `files`, returning
/// that diff's total insertions and deletions.
///
/// Deltas whose path is in `skip` are left out of both the file list and the
/// returned totals. The per-file line map is built and applied per diff — the
/// entries this diff contributed are `files[start..]` — so a path present in
/// two diffs keeps two independent sets of counts.
fn collect_diff_files(
    diff: &git2::Diff<'_>,
    skip: &std::collections::HashSet<String>,
    files: &mut Vec<StashFile>,
) -> Result<(u32, u32)> {
    let stats = diff.stats()?;
    let start = files.len();

    diff.foreach(
        &mut |delta, _| {
            let file_path = delta_path(&delta);
            if skip.contains(&file_path) {
                return true;
            }

            let status = match delta.status() {
                git2::Delta::Added => "added",
                git2::Delta::Deleted => "deleted",
                git2::Delta::Modified => "modified",
                git2::Delta::Renamed => "renamed",
                git2::Delta::Copied => "copied",
                git2::Delta::Typechange => "typechange",
                _ => "modified",
            };

            files.push(StashFile {
                path: file_path,
                additions: 0, // Will be filled in later
                deletions: 0,
                status: status.to_string(),
            });
            true
        },
        None,
        None,
        None,
    )?;

    // Get per-file stats by iterating through lines
    // Use RefCell to allow mutable borrow inside closures
    let file_stats: std::cell::RefCell<std::collections::HashMap<String, (u32, u32)>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    diff.foreach(
        &mut |_delta, _| true,
        None,
        None,
        Some(&mut |delta, _hunk, line| {
            let path = delta_path(&delta);

            let mut stats = file_stats.borrow_mut();
            let entry = stats.entry(path).or_insert((0, 0));
            match line.origin() {
                '+' => entry.0 += 1,
                '-' => entry.1 += 1,
                _ => {}
            }
            true
        }),
    )?;
    let file_stats = file_stats.into_inner();

    // Update the entries this diff contributed with their stats
    for file in &mut files[start..] {
        if let Some((adds, dels)) = file_stats.get(&file.path) {
            file.additions = *adds;
            file.deletions = *dels;
        }
    }

    // `diff.stats()` covers every delta, including the ones `skip` dropped, so
    // take those files' lines back out before reporting this diff's totals.
    let mut insertions = stats.insertions() as u32;
    let mut deletions = stats.deletions() as u32;
    for path in skip {
        if let Some((adds, dels)) = file_stats.get(path) {
            insertions = insertions.saturating_sub(*adds);
            deletions = deletions.saturating_sub(*dels);
        }
    }

    Ok((insertions, deletions))
}

/// Show stash contents
#[command]
pub async fn stash_show(
    path: String,
    index: u32,
    stat: Option<bool>,
    patch: Option<bool>,
) -> Result<StashShowResult> {
    let mut repo = git2::Repository::open(Path::new(&path))?;

    // Get stash info (message and oid) by iterating through stashes
    let mut stash_info: Option<(String, git2::Oid)> = None;
    repo.stash_foreach(|i, message, oid| {
        if i as u32 == index {
            stash_info = Some((message.to_string(), *oid));
            false // Stop iterating
        } else {
            true // Continue
        }
    })?;

    let (message, stash_oid) = stash_info.ok_or_else(|| {
        crate::error::GitnadoError::Git(git2::Error::from_str(&format!(
            "Stash entry {} not found",
            index
        )))
    })?;

    // Get the stash commit
    let stash_commit = repo.find_commit(stash_oid)?;

    // Get parent commit (the commit the stash was based on)
    let parent_commit = stash_commit.parent(0)?;

    // Get the diff between parent and stash commit
    let parent_tree = parent_commit.tree()?;
    let stash_tree = stash_commit.tree()?;

    let diff = repo.diff_tree_to_tree(Some(&parent_tree), Some(&stash_tree), None)?;

    // Untracked files stashed with INCLUDE_UNTRACKED are not in the stash
    // commit's tree — git records them in a third parent commit whose tree holds
    // only those files. Diff an empty tree against it so the preview shows what
    // `git stash show -u` would; the app's stash-creation surfaces request
    // untracked capture, so without this a stash of nothing but new files
    // reports no files at all. `create_stash` leaves `include_untracked`
    // optional (defaulting to false), so a stash created without untracked
    // capture has only two parents — hence the guard below. libgit2 also
    // writes an EMPTY third parent when untracked capture was
    // requested but nothing was untracked — which simply yields no deltas.
    //
    // One path can land in BOTH trees: stage a deletion of a tracked file and
    // then recreate it on disk, and libgit2 records it in the worktree tree (as
    // a modification of the committed version) AND in the untracked parent.
    // Git itself refuses to preview such a stash at all ("worktree and
    // untracked commit have duplicate entries"), but `git stash apply` restores
    // the worktree copy and leaves the untracked one unused — so the worktree
    // delta is the one that describes what applying actually produces. Report
    // that row alone rather than emitting the same path twice and
    // double-counting its lines in the totals.
    let mut diffs: Vec<(git2::Diff<'_>, std::collections::HashSet<String>)> =
        vec![(diff, std::collections::HashSet::new())];
    if stash_commit.parent_count() >= 3 {
        let untracked_tree = stash_commit.parent(2)?.tree()?;
        let duplicates: std::collections::HashSet<String> =
            diffs[0].0.deltas().map(|d| delta_path(&d)).collect();
        diffs.push((
            repo.diff_tree_to_tree(None, Some(&untracked_tree), None)?,
            duplicates,
        ));
    }

    // Collect file stats
    let mut files: Vec<StashFile> = Vec::new();
    let mut total_additions: u32 = 0;
    let mut total_deletions: u32 = 0;

    // Get stats if requested (default true)
    if stat.unwrap_or(true) {
        for (diff, skip) in &diffs {
            let (additions, deletions) = collect_diff_files(diff, skip, &mut files)?;
            total_additions += additions;
            total_deletions += deletions;
        }
    }

    // Generate patch if requested
    let patch_output = if patch.unwrap_or(false) {
        let mut patch_buf = Vec::new();
        for (diff, skip) in &diffs {
            diff.print(git2::DiffFormat::Patch, |delta, _hunk, line| {
                // Skip the duplicate-path deltas left out of the file list, so
                // the patch shows the same set of files the stat does.
                if !skip.is_empty() && skip.contains(&delta_path(&delta)) {
                    return true;
                }

                // Add the origin character for context/add/delete lines
                let origin = line.origin();
                if origin == '+' || origin == '-' || origin == ' ' {
                    patch_buf.push(origin as u8);
                }
                patch_buf.extend_from_slice(line.content());
                true
            })?;
        }
        Some(String::from_utf8_lossy(&patch_buf).to_string())
    } else {
        None
    };

    Ok(StashShowResult {
        index,
        oid: stash_oid.to_string(),
        message,
        files,
        total_additions,
        total_deletions,
        patch: patch_output,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    /// Helper to create a commit with a tracked file for stash tests
    fn setup_tracked_file(repo: &TestRepo, filename: &str, content: &str) {
        repo.create_file(filename, content);
        repo.stage_file(filename);
        repo.create_commit(&format!("Add {}", filename), &[]);
    }

    #[tokio::test]
    async fn test_get_stashes_empty() {
        let repo = TestRepo::with_initial_commit();
        let result = get_stashes(repo.path_str()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_create_stash_with_changes() {
        let repo = TestRepo::with_initial_commit();
        // Create and commit a tracked file
        setup_tracked_file(&repo, "tracked.txt", "original");

        // Modify the tracked file
        repo.create_file("tracked.txt", "modified");

        let result = create_stash(repo.path_str(), Some("Test stash".to_string()), None).await;
        assert!(result.is_ok());
        let stash = result.unwrap().expect("clean tree? expected a stash");
        assert_eq!(stash.index, 0);
        assert_eq!(stash.message, "Test stash");
    }

    #[tokio::test]
    async fn test_create_stash_default_message() {
        let repo = TestRepo::with_initial_commit();
        // Create and commit a tracked file
        setup_tracked_file(&repo, "file.txt", "content");

        // Modify to have something to stash
        repo.create_file("file.txt", "modified");

        let result = create_stash(repo.path_str(), None, None).await;
        assert!(result.is_ok());
        let stash = result.unwrap().expect("expected a stash");
        assert_eq!(stash.message, "WIP");
    }

    #[tokio::test]
    async fn test_create_stash_no_changes_is_noop() {
        let repo = TestRepo::with_initial_commit();
        // No changes to stash. Canonical `git stash push` on a clean tree prints
        // "No local changes to save" and exits 0 — a benign no-op, not a failure.
        let result = create_stash(repo.path_str(), Some("Empty stash".to_string()), None).await;
        assert!(
            matches!(result, Ok(None)),
            "stashing a clean tree must be a successful no-op (Ok(None)), got {:?}",
            result
        );

        // And no stash entry should have been created.
        let stashes = get_stashes(repo.path_str()).await.unwrap();
        assert!(stashes.is_empty());
    }

    #[tokio::test]
    async fn test_get_stashes_returns_created() {
        let repo = TestRepo::with_initial_commit();
        // Create and commit a tracked file
        setup_tracked_file(&repo, "file.txt", "content");

        // Modify and stash
        repo.create_file("file.txt", "modified");
        create_stash(repo.path_str(), Some("First stash".to_string()), None)
            .await
            .unwrap();

        let stashes = get_stashes(repo.path_str()).await.unwrap();
        assert_eq!(stashes.len(), 1);
        assert!(stashes[0].message.contains("First stash"));
    }

    #[tokio::test]
    async fn test_drop_stash() {
        let repo = TestRepo::with_initial_commit();
        // Create and commit a tracked file
        setup_tracked_file(&repo, "file.txt", "content");

        // Modify and stash
        repo.create_file("file.txt", "modified");
        create_stash(repo.path_str(), Some("To drop".to_string()), None)
            .await
            .unwrap();

        // Verify stash exists
        let stashes = get_stashes(repo.path_str()).await.unwrap();
        assert_eq!(stashes.len(), 1);

        // Drop it
        let result = drop_stash(repo.path_str(), 0).await;
        assert!(result.is_ok());

        // Verify it's gone
        let stashes = get_stashes(repo.path_str()).await.unwrap();
        assert!(stashes.is_empty());
    }

    #[tokio::test]
    async fn test_drop_stash_invalid_index() {
        let repo = TestRepo::with_initial_commit();
        let result = drop_stash(repo.path_str(), 999).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_apply_stash() {
        let repo = TestRepo::with_initial_commit();
        // Create and commit a tracked file
        setup_tracked_file(&repo, "file.txt", "original");

        // Modify and stash
        repo.create_file("file.txt", "stashed content");
        create_stash(repo.path_str(), Some("Apply test".to_string()), None)
            .await
            .unwrap();

        // File should be back to original
        let content = std::fs::read_to_string(repo.path.join("file.txt")).unwrap();
        assert_eq!(content, "original");

        // Apply stash
        let result = apply_stash(repo.path_str(), 0, Some(false)).await;
        assert!(result.is_ok());

        // File should have stashed content
        let content = std::fs::read_to_string(repo.path.join("file.txt")).unwrap();
        assert_eq!(content, "stashed content");

        // Stash should still exist (we didn't drop it)
        let stashes = get_stashes(repo.path_str()).await.unwrap();
        assert_eq!(stashes.len(), 1);
    }

    #[tokio::test]
    async fn test_apply_stash_with_drop() {
        let repo = TestRepo::with_initial_commit();
        // Create and commit a tracked file
        setup_tracked_file(&repo, "file.txt", "original");

        // Modify and stash
        repo.create_file("file.txt", "stashed");
        create_stash(repo.path_str(), Some("Apply and drop".to_string()), None)
            .await
            .unwrap();

        // Apply with drop
        let result = apply_stash(repo.path_str(), 0, Some(true)).await;
        assert!(result.is_ok());

        // Stash should be gone
        let stashes = get_stashes(repo.path_str()).await.unwrap();
        assert!(stashes.is_empty());
    }

    #[tokio::test]
    async fn test_pop_stash() {
        let repo = TestRepo::with_initial_commit();
        // Create and commit a tracked file
        setup_tracked_file(&repo, "file.txt", "original");

        // Modify and stash
        repo.create_file("file.txt", "popped content");
        create_stash(repo.path_str(), Some("Pop test".to_string()), None)
            .await
            .unwrap();

        // Pop stash
        let result = pop_stash(repo.path_str(), 0).await;
        assert!(result.is_ok());

        // File should have stashed content
        let content = std::fs::read_to_string(repo.path.join("file.txt")).unwrap();
        assert_eq!(content, "popped content");

        // Stash should be gone (pop = apply + drop)
        let stashes = get_stashes(repo.path_str()).await.unwrap();
        assert!(stashes.is_empty());
    }

    #[tokio::test]
    async fn test_pop_stash_conflict_retains_stash() {
        let repo = TestRepo::with_initial_commit();
        setup_tracked_file(&repo, "file.txt", "base");

        // Stash a modification; working tree reverts to "base".
        repo.create_file("file.txt", "stashed content");
        create_stash(repo.path_str(), Some("Conflicting".to_string()), None)
            .await
            .unwrap();

        // Commit a divergent change so applying the stash triggers a 3-way merge
        // conflict (working tree is clean, so stash_apply merges instead of
        // refusing). git_stash_apply returns success even with the conflict.
        repo.create_commit("Diverge", &[("file.txt", "committed change")]);

        let result = pop_stash(repo.path_str(), 0).await;
        assert!(
            matches!(result, Err(GitnadoError::MergeConflict)),
            "conflicted pop must return MergeConflict, got {:?}",
            result
        );

        // Stash must be retained (NOT dropped) on a conflicted pop.
        let stashes = get_stashes(repo.path_str()).await.unwrap();
        assert_eq!(stashes.len(), 1, "stash must survive a conflicted pop");

        // Index must reflect the conflict.
        let git_repo = git2::Repository::open(&repo.path).unwrap();
        assert!(git_repo.index().unwrap().has_conflicts());
    }

    #[tokio::test]
    async fn test_apply_stash_conflict_keeps_stash_even_with_drop() {
        let repo = TestRepo::with_initial_commit();
        setup_tracked_file(&repo, "file.txt", "base");

        repo.create_file("file.txt", "stashed content");
        create_stash(repo.path_str(), Some("Conflicting".to_string()), None)
            .await
            .unwrap();

        repo.create_commit("Diverge", &[("file.txt", "committed change")]);

        // Even with drop_after=true, a conflicted apply must NOT drop the stash.
        let result = apply_stash(repo.path_str(), 0, Some(true)).await;
        assert!(
            matches!(result, Err(GitnadoError::MergeConflict)),
            "conflicted apply must return MergeConflict, got {:?}",
            result
        );
        let stashes = get_stashes(repo.path_str()).await.unwrap();
        assert_eq!(stashes.len(), 1, "stash must survive a conflicted apply");
    }

    #[tokio::test]
    async fn test_multiple_stashes() {
        let repo = TestRepo::with_initial_commit();
        // Create and commit a tracked file
        setup_tracked_file(&repo, "file.txt", "original");

        // Create first stash
        repo.create_file("file.txt", "first change");
        create_stash(repo.path_str(), Some("First".to_string()), None)
            .await
            .unwrap();

        // Create second stash
        repo.create_file("file.txt", "second change");
        create_stash(repo.path_str(), Some("Second".to_string()), None)
            .await
            .unwrap();

        // Should have 2 stashes, newest first
        let stashes = get_stashes(repo.path_str()).await.unwrap();
        assert_eq!(stashes.len(), 2);
        assert!(stashes[0].message.contains("Second")); // index 0 is newest
        assert!(stashes[1].message.contains("First")); // index 1 is older
    }

    #[tokio::test]
    async fn test_stash_show_basic() {
        let repo = TestRepo::with_initial_commit();
        // Create and commit a tracked file
        setup_tracked_file(&repo, "file.txt", "original content");

        // Modify and stash.
        //
        // The edit must change the file's SIZE. "modified content" is the same
        // 16 bytes as "original content", and the write lands in the same
        // timestamp granularity bucket as the index git just wrote — the
        // racily-clean case, where a same-size edit can be judged unchanged by
        // stat alone. The stash then captured nothing and this test failed on
        // `files.len()` with 0, on CI only and only sometimes.
        repo.create_file("file.txt", "modified content, now a different length");
        create_stash(repo.path_str(), Some("Show test".to_string()), None)
            .await
            .unwrap();

        // Show stash contents
        let result = stash_show(repo.path_str(), 0, Some(true), Some(false)).await;
        assert!(result.is_ok());
        let show = result.unwrap();
        assert_eq!(show.index, 0);
        assert_eq!(show.oid, get_stashes(repo.path_str()).await.unwrap()[0].oid);
        assert!(show.message.contains("Show test"));
        assert_eq!(show.files.len(), 1);
        assert_eq!(show.files[0].path, "file.txt");
        assert_eq!(show.files[0].status, "modified");
        assert!(show.patch.is_none());
    }

    #[tokio::test]
    async fn test_stash_show_with_patch() {
        let repo = TestRepo::with_initial_commit();
        // Create and commit a tracked file
        setup_tracked_file(&repo, "file.txt", "line1\nline2\nline3");

        // Modify and stash
        repo.create_file("file.txt", "line1\nmodified\nline3");
        create_stash(repo.path_str(), Some("Patch test".to_string()), None)
            .await
            .unwrap();

        // Show stash with patch
        let result = stash_show(repo.path_str(), 0, Some(true), Some(true)).await;
        assert!(result.is_ok());
        let show = result.unwrap();
        assert!(show.patch.is_some());
        let patch = show.patch.unwrap();
        assert!(patch.contains("-line2"));
        assert!(patch.contains("+modified"));
    }

    #[tokio::test]
    async fn test_stash_show_multiple_files() {
        let repo = TestRepo::with_initial_commit();
        // Create and commit multiple files
        setup_tracked_file(&repo, "file1.txt", "content1");
        setup_tracked_file(&repo, "file2.txt", "content2");

        // Modify both files and stash
        repo.create_file("file1.txt", "modified1");
        repo.create_file("file2.txt", "modified2");
        create_stash(repo.path_str(), Some("Multi file".to_string()), None)
            .await
            .unwrap();

        // Show stash
        let result = stash_show(repo.path_str(), 0, Some(true), Some(false)).await;
        assert!(result.is_ok());
        let show = result.unwrap();
        assert_eq!(show.files.len(), 2);

        // Both files should be present
        let paths: Vec<&str> = show.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"file1.txt"));
        assert!(paths.contains(&"file2.txt"));
    }

    #[tokio::test]
    async fn test_stash_show_invalid_index() {
        let repo = TestRepo::with_initial_commit();
        // Try to show non-existent stash
        let result = stash_show(repo.path_str(), 999, Some(true), Some(false)).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_stash_show_additions_deletions() {
        let repo = TestRepo::with_initial_commit();
        // Create and commit a tracked file
        setup_tracked_file(&repo, "file.txt", "line1\nline2\nline3\nline4");

        // Modify: remove line2, add two new lines
        repo.create_file("file.txt", "line1\nnew1\nnew2\nline3\nline4");
        create_stash(repo.path_str(), Some("Stats test".to_string()), None)
            .await
            .unwrap();

        // Show stash
        let result = stash_show(repo.path_str(), 0, Some(true), Some(false)).await;
        assert!(result.is_ok());
        let show = result.unwrap();

        // Check total stats
        assert!(show.total_additions > 0);
        assert!(show.total_deletions > 0);

        // Check file stats
        assert_eq!(show.files.len(), 1);
        assert!(show.files[0].additions > 0);
        assert!(show.files[0].deletions > 0);
    }

    #[tokio::test]
    async fn test_stash_show_staged_new_file() {
        let repo = TestRepo::with_initial_commit();
        // Create and commit a tracked file
        setup_tracked_file(&repo, "existing.txt", "content");

        // Create a new file and stage it
        repo.create_file("new_file.txt", "new content");
        repo.stage_file("new_file.txt");

        // Stash the staged new file
        create_stash(repo.path_str(), Some("New file stash".to_string()), None)
            .await
            .unwrap();

        // Show stash
        let result = stash_show(repo.path_str(), 0, Some(true), Some(false)).await;
        assert!(result.is_ok());
        let show = result.unwrap();

        // Should have the new file
        let new_file = show.files.iter().find(|f| f.path == "new_file.txt");
        assert!(new_file.is_some());
        assert_eq!(new_file.unwrap().status, "added");
    }

    #[tokio::test]
    async fn test_stash_show_deleted_file() {
        let repo = TestRepo::with_initial_commit();
        // Create and commit a tracked file
        setup_tracked_file(&repo, "to_delete.txt", "content");

        // Delete the file and stage the deletion
        std::fs::remove_file(repo.path.join("to_delete.txt")).unwrap();
        let git_repo = git2::Repository::open(&repo.path).unwrap();
        let mut index = git_repo.index().unwrap();
        index
            .remove_path(std::path::Path::new("to_delete.txt"))
            .unwrap();
        index.write().unwrap();

        // Stash the deletion
        create_stash(repo.path_str(), Some("Delete file stash".to_string()), None)
            .await
            .unwrap();

        // Show stash
        let result = stash_show(repo.path_str(), 0, Some(true), Some(false)).await;
        assert!(result.is_ok());
        let show = result.unwrap();

        // Should have the deleted file
        let deleted_file = show.files.iter().find(|f| f.path == "to_delete.txt");
        assert!(deleted_file.is_some());
        assert_eq!(deleted_file.unwrap().status, "deleted");
    }

    #[tokio::test]
    async fn test_stash_show_includes_untracked_files() {
        let repo = TestRepo::with_initial_commit();
        setup_tracked_file(&repo, "tracked.txt", "content");

        // The ONLY change is a brand-new untracked file — exactly what the UI
        // stashes (both creation paths force includeUntracked).
        repo.create_file("untracked.txt", "brand new\n");
        create_stash(
            repo.path_str(),
            Some("Untracked stash".to_string()),
            Some(true),
        )
        .await
        .unwrap()
        .expect("an untracked-only change must still produce a stash");

        let show = stash_show(repo.path_str(), 0, Some(true), Some(false))
            .await
            .unwrap();

        let untracked = show
            .files
            .iter()
            .find(|f| f.path == "untracked.txt")
            .expect("untracked file must appear in the stash preview");
        assert_eq!(untracked.status, "added");
        assert_eq!(untracked.additions, 1);
        assert_eq!(untracked.deletions, 0);
        assert_eq!(show.total_additions, 1);
        assert_eq!(show.total_deletions, 0);
    }

    #[tokio::test]
    async fn test_stash_show_untracked_alongside_tracked_changes() {
        let repo = TestRepo::with_initial_commit();
        setup_tracked_file(&repo, "tracked.txt", "line1\nline2\n");

        // Size-changing edit: a same-size rewrite can be judged racily-clean and
        // captured as nothing (see the note on test_stash_show_basic).
        repo.create_file("tracked.txt", "line1\nline2 changed and longer\n");
        repo.create_file("new.txt", "new line\n");
        create_stash(repo.path_str(), Some("Mixed stash".to_string()), Some(true))
            .await
            .unwrap()
            .expect("expected a stash");

        let show = stash_show(repo.path_str(), 0, Some(true), Some(true))
            .await
            .unwrap();

        let paths: Vec<&str> = show.files.iter().map(|f| f.path.as_str()).collect();
        assert!(
            paths.contains(&"tracked.txt"),
            "tracked change missing: {:?}",
            paths
        );
        assert!(
            paths.contains(&"new.txt"),
            "untracked file missing: {:?}",
            paths
        );
        assert_eq!(
            show.files
                .iter()
                .find(|f| f.path == "tracked.txt")
                .unwrap()
                .status,
            "modified"
        );
        assert_eq!(
            show.files
                .iter()
                .find(|f| f.path == "new.txt")
                .unwrap()
                .status,
            "added"
        );

        // The patch must cover the untracked file too (`git stash show -p -u`).
        let patch = show.patch.expect("patch requested");
        assert!(
            patch.contains("+line2 changed and longer"),
            "patch: {}",
            patch
        );
        assert!(patch.contains("+new line"), "patch: {}", patch);

        // Totals sum both diffs: 1 tracked addition + 1 untracked line.
        assert_eq!(show.total_additions, 2);
        assert_eq!(show.total_deletions, 1);
    }

    #[tokio::test]
    async fn test_stash_show_include_untracked_with_no_untracked_files() {
        let repo = TestRepo::with_initial_commit();
        setup_tracked_file(&repo, "file.txt", "line1\nline2\n");

        // includeUntracked is on, but there is nothing untracked. libgit2 still
        // writes an (empty) untracked parent, which must contribute no files.
        repo.create_file("file.txt", "line1\nline2 changed and longer\n");
        create_stash(
            repo.path_str(),
            Some("No untracked".to_string()),
            Some(true),
        )
        .await
        .unwrap()
        .expect("expected a stash");

        let show = stash_show(repo.path_str(), 0, Some(true), Some(false))
            .await
            .unwrap();

        assert_eq!(show.files.len(), 1, "unexpected files: {:?}", show.files);
        assert_eq!(show.files[0].path, "file.txt");
        assert_eq!(show.files[0].status, "modified");
    }

    #[tokio::test]
    async fn test_stash_show_path_in_both_tracked_and_untracked_trees() {
        let repo = TestRepo::with_initial_commit();
        setup_tracked_file(&repo, "dup.txt", "old line\n");

        // Stage the file's deletion, then recreate it on disk. It is now
        // untracked (gone from the index) while HEAD still has it, so libgit2
        // records it in the worktree tree AND in the untracked parent.
        std::fs::remove_file(repo.path.join("dup.txt")).unwrap();
        let git_repo = repo.repo();
        let mut index = git_repo.index().unwrap();
        index.remove_path(std::path::Path::new("dup.txt")).unwrap();
        index.write().unwrap();
        repo.create_file("dup.txt", "brand new\ncontent\n");

        create_stash(repo.path_str(), Some("Overlap".to_string()), Some(true))
            .await
            .unwrap()
            .expect("expected a stash");

        let show = stash_show(repo.path_str(), 0, Some(true), Some(true))
            .await
            .unwrap();

        // One row, not two: `git stash apply` restores the worktree copy, so
        // that is the delta the preview must describe.
        let rows: Vec<&StashFile> = show.files.iter().filter(|f| f.path == "dup.txt").collect();
        assert_eq!(
            rows.len(),
            1,
            "duplicate rows for one path: {:?}",
            show.files
        );
        assert_eq!(rows[0].status, "modified");
        assert_eq!(rows[0].additions, 2);
        assert_eq!(rows[0].deletions, 1);

        // Totals count the file once — not the +4/-1 two independent diffs give.
        assert_eq!(show.total_additions, 2);
        assert_eq!(show.total_deletions, 1);

        // The patch must not carry the file twice either.
        let patch = show.patch.expect("patch requested");
        assert_eq!(
            patch.matches("diff --git a/dup.txt b/dup.txt").count(),
            1,
            "patch repeats the file: {}",
            patch
        );
        assert!(patch.contains("-old line"), "patch: {}", patch);
        assert!(patch.contains("+brand new"), "patch: {}", patch);
    }
}
