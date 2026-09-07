//! Staging command handlers

use std::io::Write;
use std::path::Path;
use tauri::command;

use super::path_utils::validate_path_within_repo;
use crate::error::Result;
use crate::models::{
    FileHunks, FileStatus, HunkDiffLine, IndexedDiffHunk, SortedFileStatus, SortedStatusEntry,
    StatusEntry,
};
use crate::utils::create_command;

/// Get repository status
#[command]
pub async fn get_status(path: String) -> Result<Vec<StatusEntry>> {
    let repo = git2::Repository::open(Path::new(&path))?;

    let mut opts = git2::StatusOptions::new();
    // update_index(true): refresh racy-git entries so files whose content
    // matches the index drop out of status. Without it, a rewrite with
    // identical content (common after checkout/rebase) shows as "M" in the
    // UI but produces an empty content-diff — the user then hits
    // "File not found in diff" when they click it.
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .include_unmodified(false)
        .update_index(true);

    let statuses = repo.statuses(Some(&mut opts))?;
    let mut entries = Vec::new();

    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let status = entry.status();

        // A file can have both staged AND unstaged changes
        // We need to return separate entries for each
        let staged_entry = get_staged_status(status, &path);
        let unstaged_entry = get_unstaged_status(status, &path);

        if let Some(entry) = staged_entry {
            entries.push(entry);
        }
        if let Some(entry) = unstaged_entry {
            entries.push(entry);
        }
    }

    Ok(entries)
}

/// Get sorted file status with enriched metadata for file tree display
///
/// Supports sorting by name, status, path (directory), or extension,
/// with optional grouping by directory.
#[command]
pub async fn get_sorted_file_status(
    path: String,
    sort_by: String,
    sort_direction: Option<String>,
    group_by_directory: bool,
) -> Result<SortedFileStatus> {
    let entries = get_status(path).await?;

    let direction = sort_direction.unwrap_or_else(|| "asc".to_string());
    let ascending = direction != "desc";

    // Convert StatusEntry to SortedStatusEntry with enriched metadata
    let mut sorted_entries: Vec<SortedStatusEntry> = entries
        .iter()
        .map(|entry| {
            let file_path = std::path::Path::new(&entry.path);
            let filename = file_path
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_else(|| entry.path.clone());
            let directory = file_path
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let extension = file_path
                .extension()
                .map(|e| e.to_string_lossy().to_string());
            let status = format!("{:?}", entry.status).to_lowercase();

            SortedStatusEntry {
                path: entry.path.clone(),
                filename,
                directory,
                extension,
                status,
                is_staged: entry.is_staged,
                is_conflicted: entry.is_conflicted,
            }
        })
        .collect();

    // Sort based on the requested criteria
    match sort_by.as_str() {
        "name" => {
            sorted_entries.sort_by(|a, b| {
                let cmp = a.filename.to_lowercase().cmp(&b.filename.to_lowercase());
                if ascending {
                    cmp
                } else {
                    cmp.reverse()
                }
            });
        }
        "status" => {
            sorted_entries.sort_by(|a, b| {
                let status_order = |s: &str| -> u8 {
                    match s {
                        "conflicted" => 0,
                        "modified" => 1,
                        "new" => 2,
                        "deleted" => 3,
                        "renamed" => 4,
                        "untracked" => 5,
                        "typechange" => 6,
                        "copied" => 7,
                        "ignored" => 8,
                        _ => 9,
                    }
                };
                let cmp = status_order(&a.status)
                    .cmp(&status_order(&b.status))
                    .then_with(|| a.filename.to_lowercase().cmp(&b.filename.to_lowercase()));
                if ascending {
                    cmp
                } else {
                    cmp.reverse()
                }
            });
        }
        "path" => {
            sorted_entries.sort_by(|a, b| {
                let cmp = a
                    .directory
                    .to_lowercase()
                    .cmp(&b.directory.to_lowercase())
                    .then_with(|| a.filename.to_lowercase().cmp(&b.filename.to_lowercase()));
                if ascending {
                    cmp
                } else {
                    cmp.reverse()
                }
            });
        }
        "extension" => {
            sorted_entries.sort_by(|a, b| {
                let ext_a = a.extension.as_deref().unwrap_or("");
                let ext_b = b.extension.as_deref().unwrap_or("");
                let cmp = ext_a
                    .to_lowercase()
                    .cmp(&ext_b.to_lowercase())
                    .then_with(|| a.filename.to_lowercase().cmp(&b.filename.to_lowercase()));
                if ascending {
                    cmp
                } else {
                    cmp.reverse()
                }
            });
        }
        _ => {
            // Default: sort by name ascending
            sorted_entries.sort_by_key(|a| a.filename.to_lowercase());
        }
    }

    // If group_by_directory is enabled, ensure files are grouped by directory
    // while maintaining the sort order within each group
    if group_by_directory {
        sorted_entries.sort_by(|a, b| {
            let dir_cmp = a.directory.to_lowercase().cmp(&b.directory.to_lowercase());
            if dir_cmp != std::cmp::Ordering::Equal {
                return if ascending {
                    dir_cmp
                } else {
                    dir_cmp.reverse()
                };
            }
            // Within the same directory, maintain the existing sort order
            // by re-applying the sort_by criterion
            match sort_by.as_str() {
                "name" | "path" => {
                    let cmp = a.filename.to_lowercase().cmp(&b.filename.to_lowercase());
                    if ascending {
                        cmp
                    } else {
                        cmp.reverse()
                    }
                }
                "status" => {
                    let status_order = |s: &str| -> u8 {
                        match s {
                            "conflicted" => 0,
                            "modified" => 1,
                            "new" => 2,
                            "deleted" => 3,
                            "renamed" => 4,
                            "untracked" => 5,
                            "typechange" => 6,
                            "copied" => 7,
                            "ignored" => 8,
                            _ => 9,
                        }
                    };
                    let cmp = status_order(&a.status)
                        .cmp(&status_order(&b.status))
                        .then_with(|| a.filename.to_lowercase().cmp(&b.filename.to_lowercase()));
                    if ascending {
                        cmp
                    } else {
                        cmp.reverse()
                    }
                }
                "extension" => {
                    let ext_a = a.extension.as_deref().unwrap_or("");
                    let ext_b = b.extension.as_deref().unwrap_or("");
                    let cmp = ext_a
                        .to_lowercase()
                        .cmp(&ext_b.to_lowercase())
                        .then_with(|| a.filename.to_lowercase().cmp(&b.filename.to_lowercase()));
                    if ascending {
                        cmp
                    } else {
                        cmp.reverse()
                    }
                }
                _ => {
                    let cmp = a.filename.to_lowercase().cmp(&b.filename.to_lowercase());
                    if ascending {
                        cmp
                    } else {
                        cmp.reverse()
                    }
                }
            }
        });
    }

    // Compute summary counts from the original entries
    let total_count = entries.len() as u32;
    let staged_count = entries.iter().filter(|e| e.is_staged).count() as u32;
    let unstaged_count = entries
        .iter()
        .filter(|e| !e.is_staged && !e.is_conflicted && e.status != FileStatus::Untracked)
        .count() as u32;
    let untracked_count = entries
        .iter()
        .filter(|e| e.status == FileStatus::Untracked)
        .count() as u32;
    let conflicted_count = entries.iter().filter(|e| e.is_conflicted).count() as u32;

    Ok(SortedFileStatus {
        files: sorted_entries,
        total_count,
        staged_count,
        unstaged_count,
        untracked_count,
        conflicted_count,
    })
}

/// Get the staged (index) status for a file, if any
fn get_staged_status(status: git2::Status, path: &str) -> Option<StatusEntry> {
    if status.is_conflicted() {
        return Some(StatusEntry {
            path: path.to_string(),
            status: FileStatus::Conflicted,
            is_staged: false,
            is_conflicted: true,
        });
    }

    let file_status = if status.is_index_new() {
        Some(FileStatus::New)
    } else if status.is_index_modified() {
        Some(FileStatus::Modified)
    } else if status.is_index_deleted() {
        Some(FileStatus::Deleted)
    } else if status.is_index_renamed() {
        Some(FileStatus::Renamed)
    } else if status.is_index_typechange() {
        Some(FileStatus::Typechange)
    } else {
        None
    };

    file_status.map(|s| StatusEntry {
        path: path.to_string(),
        status: s,
        is_staged: true,
        is_conflicted: false,
    })
}

/// Get the unstaged (worktree) status for a file, if any
fn get_unstaged_status(status: git2::Status, path: &str) -> Option<StatusEntry> {
    if status.is_conflicted() {
        return None; // Already handled in staged
    }

    let file_status = if status.is_wt_new() {
        Some(FileStatus::Untracked)
    } else if status.is_wt_modified() {
        Some(FileStatus::Modified)
    } else if status.is_wt_deleted() {
        Some(FileStatus::Deleted)
    } else if status.is_wt_renamed() {
        Some(FileStatus::Renamed)
    } else if status.is_wt_typechange() {
        Some(FileStatus::Typechange)
    } else if status.is_ignored() {
        Some(FileStatus::Ignored)
    } else {
        None
    };

    file_status.map(|s| StatusEntry {
        path: path.to_string(),
        status: s,
        is_staged: false,
        is_conflicted: false,
    })
}

/// Stage files
#[command]
pub async fn stage_files(path: String, paths: Vec<String>) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let mut index = repo.index()?;

    for file_path in paths {
        let full_path = validate_path_within_repo(Path::new(&path), &file_path)?;
        // Use symlink_metadata (does NOT follow symlinks) rather than
        // Path::exists (which follows them). A dangling symlink — one whose
        // target does not exist — must still be staged as a 120000 blob
        // containing the link target, exactly as `git add` does; treating it
        // as a deletion would silently stage the symlink's removal.
        if std::fs::symlink_metadata(&full_path).is_ok() {
            index.add_path(Path::new(&file_path))?;
        } else {
            index.remove_path(Path::new(&file_path))?;
        }
    }

    index.write()?;
    Ok(())
}

/// Unstage files
#[command]
pub async fn unstage_files(path: String, paths: Vec<String>) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Resolve the HEAD commit. On an unborn branch (a freshly initialized
    // repository with no commits yet) there is no HEAD, and `git reset --
    // <paths>` resolves against the empty tree — equivalent to removing the
    // requested paths from the index. Propagating repo.head()'s error here
    // would wrongly make unstaging impossible until the first commit exists.
    let head_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());

    let mut index = repo.index()?;

    for file_path in paths {
        let path_obj = Path::new(&file_path);

        match &head_commit {
            Some(commit) => {
                let head_tree = commit.tree()?;
                if head_tree.get_path(path_obj).is_ok() {
                    // Reset to HEAD version
                    repo.reset_default(Some(commit.as_object()), [path_obj])?;
                } else {
                    // Remove from index (was newly added)
                    index.remove_path(path_obj)?;
                }
            }
            None => {
                // Unborn HEAD: reset against the empty tree == drop from index.
                index.remove_path(path_obj)?;
            }
        }
    }

    index.write()?;
    Ok(())
}

/// Discard changes in working directory
#[command]
pub async fn discard_changes(path: String, paths: Vec<String>) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let repo_path = Path::new(&path);

    // Get HEAD tree (may not exist for initial commit)
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let index = repo.index()?;

    // "Discard changes" mirrors `git checkout -- <pathspec>`, which restores
    // the working tree from the INDEX — never from HEAD. Restoring from HEAD
    // would silently overwrite staged content (e.g. a file with staged edits
    // plus later unstaged edits would lose the staged version, which is never
    // committed and has no reflog: unrecoverable data loss). So:
    //   1. Tracked (present in the index): restore the worktree from the index.
    //   2. Untracked (not in the index and not in HEAD): delete it.
    // A path in HEAD but absent from the index is a staged deletion; there is
    // no worktree change to discard, so it is left untouched.
    let mut index_paths: Vec<&str> = Vec::new();
    let mut untracked_paths: Vec<std::path::PathBuf> = Vec::new();

    for file_path in &paths {
        // Validate BEFORE any git2 lookup. git2's Index::get_path panics
        // outright on a path beginning with `..`, so an unvalidated traversal
        // crashes this command across the IPC boundary rather than returning an
        // error. It also guards the untracked branch below, which is the only
        // place in this file that deletes recursively.
        let full_path = validate_path_within_repo(repo_path, file_path)?;

        let path_obj = Path::new(file_path);

        // Check if file exists in HEAD
        let in_head = head_tree
            .as_ref()
            .map(|t| t.get_path(path_obj).is_ok())
            .unwrap_or(false);

        // Check if file exists in index
        let in_index = index.get_path(path_obj, 0).is_some();

        if in_index {
            // Tracked - restore the worktree from the staged (index) version.
            index_paths.push(file_path);
        } else if !in_head {
            // Untracked - need to delete it.
            untracked_paths.push(full_path);
        }
        // in_head && !in_index: staged deletion, nothing to discard.
    }

    // An untracked ENTRY can be an entire repository: libgit2 does not descend
    // into a directory holding .git, so a nested repo surfaces in the file list
    // as one ordinary row. Discarding it would remove its objects, refs and
    // unpushed commits with nothing recoverable — and unlike Clean, which is a
    // deliberate confirmed dialog, discarding a row in the sidebar reads as
    // "throw away my edit".
    //
    // Scanned for ALL selected paths BEFORE anything is deleted, the same
    // all-or-nothing shape clean_files uses for its containment validation.
    // The check used to live inside the deletion loop, so a ten-file
    // "Discard all selected" whose fifth entry was a nested repo deleted the
    // first four — untracked, so no object, no reflog, no trash — and then
    // returned the error, while the user read "would destroy its history" and
    // reasonably concluded nothing had happened.
    for full_path in &untracked_paths {
        // symlink_metadata, not is_dir(): a symlink to a directory must never
        // be descended into, only unlinked.
        let is_dir = std::fs::symlink_metadata(full_path)
            .map(|m| m.file_type().is_dir())
            .unwrap_or(false);
        if is_dir && crate::utils::contains_nested_repo(full_path) {
            return Err(crate::error::GitnadoError::OperationFailed(format!(
                "'{}' contains a git repository — discarding it would destroy its history. \
                 Nothing was discarded. Use the Clean Working Directory dialog, which asks \
                 for confirmation before removing a nested repository.",
                full_path.display()
            )));
        }
    }

    // Restore tracked files from the index (matches `git checkout -- <path>`).
    if !index_paths.is_empty() {
        let mut checkout_opts = git2::build::CheckoutBuilder::new();
        checkout_opts.force();
        checkout_opts.remove_untracked(false);
        // CheckoutBuilder::path() adds a PATHSPEC, not a literal path: without
        // this, a filename containing a glob metacharacter (`*`, `?`, `[`, `\`)
        // also matches its neighbours. Discarding `report[1].md` would then
        // force-restore `report1.md` too, silently destroying uncommitted work
        // in a file the confirm never named.
        checkout_opts.disable_pathspec_match(true);

        for file_path in &index_paths {
            checkout_opts.path(file_path);
        }

        let mut fresh_index = repo.index()?;
        repo.checkout_index(Some(&mut fresh_index), Some(&mut checkout_opts))?;
    }

    // Delete untracked files. symlink_metadata, not exists()/is_dir(): both
    // FOLLOW symlinks, so a dangling link would be skipped (left on disk)
    // and a link to a directory would be reported as a directory. The
    // symlink itself is what must go — never its target.
    // Paths were containment-checked during classification above, and
    // nested-repo-checked immediately above.
    for full_path in untracked_paths {
        if let Ok(meta) = std::fs::symlink_metadata(&full_path) {
            if meta.file_type().is_dir() {
                std::fs::remove_dir_all(&full_path)?;
            } else {
                std::fs::remove_file(&full_path)?;
            }
        }
    }

    Ok(())
}

/// Apply a patch to the index. Internal helper shared by stage_hunk /
/// unstage_hunk; uses a unique temp file per call so concurrent invocations
/// don't clobber each other's patch on disk.
fn apply_patch_to_index(repo_path: &str, patch: &str, reverse: bool) -> Result<()> {
    // NamedTempFile produces a unique name (random suffix) and removes
    // the file on drop, so concurrent calls cannot collide.
    let mut tmp = tempfile::Builder::new()
        .prefix("gitnado_hunk_")
        .suffix(".patch")
        .tempfile()?;
    tmp.write_all(patch.as_bytes())?;
    tmp.flush()?;

    let mut cmd = create_command("git");
    if reverse {
        cmd.args(["apply", "--cached", "--reverse", "--unidiff-zero"]);
    } else {
        cmd.args(["apply", "--cached", "--unidiff-zero"]);
    }
    let output = cmd.arg(tmp.path()).current_dir(repo_path).output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let label = if reverse { "unstage" } else { "stage" };
        return Err(crate::error::GitnadoError::OperationFailed(format!(
            "Failed to {} hunk: {}",
            label, stderr
        )));
    }

    Ok(())
}

/// Stage a specific hunk from a diff
///
/// Takes a patch string containing just the hunk to stage (with proper headers)
/// and applies it to the index using git apply --cached
#[command]
pub async fn stage_hunk(repo_path: String, patch: String) -> Result<()> {
    apply_patch_to_index(&repo_path, &patch, false)
}

/// Unstage a specific hunk from the index
///
/// Takes a patch string and applies it in reverse to unstage
#[command]
pub async fn unstage_hunk(repo_path: String, patch: String) -> Result<()> {
    apply_patch_to_index(&repo_path, &patch, true)
}

/// Write content to a file and optionally stage it
/// Used for inline editing in the diff view
#[command]
pub async fn write_file_content(
    repo_path: String,
    file_path: String,
    content: String,
    stage_after: Option<bool>,
) -> Result<()> {
    let full_path = validate_path_within_repo(Path::new(&repo_path), &file_path)?;

    // Ensure parent directory exists
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Write content to file
    std::fs::write(&full_path, content)?;

    // Optionally stage the file
    if stage_after.unwrap_or(false) {
        let repo = git2::Repository::open(Path::new(&repo_path))?;
        let mut index = repo.index()?;
        index.add_path(Path::new(&file_path))?;
        index.write()?;
    }

    Ok(())
}

/// Read file content from working directory or index
#[command]
pub async fn read_file_content(
    repo_path: String,
    file_path: String,
    from_index: Option<bool>,
) -> Result<String> {
    if from_index.unwrap_or(false) {
        // Read from index
        let repo = git2::Repository::open(Path::new(&repo_path))?;
        let index = repo.index()?;

        if let Some(entry) = index.get_path(Path::new(&file_path), 0) {
            let blob = repo.find_blob(entry.id)?;
            let content = String::from_utf8_lossy(blob.content()).to_string();
            return Ok(content);
        }

        Err(crate::error::GitnadoError::OperationFailed(
            "File not found in index".to_string(),
        ))
    } else {
        // Read from working directory. A MISSING file gets its own error
        // code — callers must be able to tell "the file is gone" (e.g. a
        // staged deletion) from "the file exists but could not be decoded"
        // (legacy encoding), which are presented very differently.
        let full_path = validate_path_within_repo(Path::new(&repo_path), &file_path)?;
        if !full_path.exists() {
            return Err(crate::error::GitnadoError::FileNotFound(file_path));
        }
        let content = std::fs::read_to_string(&full_path)?;
        Ok(content)
    }
}

/// Strip trailing whitespace from files
///
/// Reads each file, removes trailing whitespace from every line, and writes it back.
#[command]
pub async fn strip_trailing_whitespace(path: String, file_paths: Vec<String>) -> Result<()> {
    let repo_path = Path::new(&path);

    for file_path in &file_paths {
        let full_path = validate_path_within_repo(repo_path, file_path)?;

        if !full_path.exists() || !full_path.is_file() {
            continue;
        }

        let content = std::fs::read_to_string(&full_path)?;

        let stripped: String = content
            .lines()
            .map(|line| line.trim_end())
            .collect::<Vec<&str>>()
            .join("\n");

        // Preserve final newline if original file had one
        let result = if content.ends_with('\n') {
            format!("{}\n", stripped)
        } else {
            stripped
        };

        std::fs::write(&full_path, result)?;
    }

    Ok(())
}

/// Get hunks for a file diff (staged or unstaged)
///
/// Returns structured hunk information for partial staging UI.
#[command]
pub async fn get_file_hunks(path: String, file_path: String, staged: bool) -> Result<FileHunks> {
    let repo = git2::Repository::open(Path::new(&path))?;

    let diff = if staged {
        // Staged: diff between HEAD and index
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        let mut opts = git2::DiffOptions::new();
        opts.pathspec(&file_path);
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))?
    } else {
        // Unstaged: diff between index and working directory
        let mut opts = git2::DiffOptions::new();
        opts.pathspec(&file_path);
        repo.diff_index_to_workdir(None, Some(&mut opts))?
    };

    let mut hunks: Vec<IndexedDiffHunk> = Vec::new();
    let mut total_additions: u32 = 0;
    let mut total_deletions: u32 = 0;

    // Iterate through patches for each delta
    let num_deltas = diff.deltas().len();
    for delta_idx in 0..num_deltas {
        if let Ok(Some(patch)) = git2::Patch::from_diff(&diff, delta_idx) {
            let num_hunks = patch.num_hunks();
            for hunk_idx in 0..num_hunks {
                if let Ok((hunk, num_lines)) = patch.hunk(hunk_idx) {
                    let header = String::from_utf8_lossy(hunk.header()).trim().to_string();
                    let mut lines = Vec::new();

                    for line_idx in 0..num_lines {
                        if let Ok(diff_line) = patch.line_in_hunk(hunk_idx, line_idx) {
                            let origin = diff_line.origin();
                            let content = String::from_utf8_lossy(diff_line.content()).to_string();

                            let line_type = match origin {
                                '+' => {
                                    total_additions += 1;
                                    "addition"
                                }
                                '-' => {
                                    total_deletions += 1;
                                    "deletion"
                                }
                                ' ' => "context",
                                _ => continue,
                            };

                            lines.push(HunkDiffLine {
                                line_type: line_type.to_string(),
                                content,
                                old_line_number: diff_line.old_lineno(),
                                new_line_number: diff_line.new_lineno(),
                            });
                        }
                    }

                    hunks.push(IndexedDiffHunk {
                        index: hunks.len() as u32,
                        old_start: hunk.old_start(),
                        old_lines: hunk.old_lines(),
                        new_start: hunk.new_start(),
                        new_lines: hunk.new_lines(),
                        header,
                        lines,
                        is_staged: staged,
                    });
                }
            }
        }
    }

    Ok(FileHunks {
        file_path,
        hunks,
        total_additions,
        total_deletions,
    })
}

/// Append one unified-diff line (`prefix` + `content`) to `patch`.
///
/// When `content` has no trailing newline the line is the file's final line
/// with no end-of-file newline, so a `\ No newline at end of file` marker is
/// emitted immediately after it — exactly as git's own patches do. Without
/// this marker `git apply --cached` either rejects the patch ("patch does not
/// apply", when the pre-image lacks the newline) or stages a blob with a
/// spurious trailing newline.
fn push_diff_line(patch: &mut String, prefix: char, content: &str) {
    patch.push(prefix);
    patch.push_str(content);
    if content.ends_with('\n') {
        return;
    }
    patch.push('\n');
    patch.push_str("\\ No newline at end of file\n");
}

/// Build a unified diff patch string from a single hunk
fn build_hunk_patch(file_path: &str, hunk: &IndexedDiffHunk) -> String {
    let mut patch = String::new();

    // Diff header
    patch.push_str(&format!("--- a/{}\n", file_path));
    patch.push_str(&format!("+++ b/{}\n", file_path));

    // Hunk header
    patch.push_str(&format!(
        "@@ -{},{} +{},{} @@\n",
        hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines
    ));

    // Lines
    for line in &hunk.lines {
        let prefix = match line.line_type.as_str() {
            "addition" => '+',
            "deletion" => '-',
            _ => ' ',
        };
        push_diff_line(&mut patch, prefix, &line.content);
    }

    patch
}

/// Stage a specific hunk by index
///
/// Gets the hunks for a file, finds the one at the given index,
/// builds a patch, and applies it to the index.
#[command]
pub async fn stage_hunk_by_index(path: String, file_path: String, hunk_index: u32) -> Result<()> {
    // Get the unstaged hunks
    let file_hunks = get_file_hunks(path.clone(), file_path.clone(), false).await?;

    let hunk = file_hunks
        .hunks
        .iter()
        .find(|h| h.index == hunk_index)
        .ok_or_else(|| {
            crate::error::GitnadoError::OperationFailed(format!(
                "Hunk index {} not found for file {}",
                hunk_index, file_path
            ))
        })?;

    let patch = build_hunk_patch(&file_path, hunk);
    apply_patch_to_index(&path, &patch, false)
}

/// Unstage a specific hunk by index
///
/// Gets the staged hunks for a file, finds the one at the given index,
/// builds a patch, and applies it in reverse to unstage.
#[command]
pub async fn unstage_hunk_by_index(path: String, file_path: String, hunk_index: u32) -> Result<()> {
    // Get the staged hunks
    let file_hunks = get_file_hunks(path.clone(), file_path.clone(), true).await?;

    let hunk = file_hunks
        .hunks
        .iter()
        .find(|h| h.index == hunk_index)
        .ok_or_else(|| {
            crate::error::GitnadoError::OperationFailed(format!(
                "Hunk index {} not found for file {}",
                hunk_index, file_path
            ))
        })?;

    let patch = build_hunk_patch(&file_path, hunk);
    apply_patch_to_index(&path, &patch, true)
}

/// Stage specific lines from a diff
///
/// Takes a range of diff line numbers (0-indexed within the file's diff output)
/// and creates a patch containing only those lines.
#[command]
pub async fn stage_lines(
    path: String,
    file_path: String,
    start_line: u32,
    end_line: u32,
) -> Result<()> {
    // Get the unstaged hunks to find lines
    let file_hunks = get_file_hunks(path.clone(), file_path.clone(), false).await?;

    // Collect all lines across all hunks with a global index
    let mut global_line_idx: u32 = 0;
    let mut selected_hunks: Vec<(IndexedDiffHunk, Vec<usize>)> = Vec::new();

    for hunk in &file_hunks.hunks {
        let mut selected_line_indices = Vec::new();
        for (local_idx, _line) in hunk.lines.iter().enumerate() {
            if global_line_idx >= start_line && global_line_idx <= end_line {
                selected_line_indices.push(local_idx);
            }
            global_line_idx += 1;
        }
        if !selected_line_indices.is_empty() {
            selected_hunks.push((hunk.clone(), selected_line_indices));
        }
    }

    if selected_hunks.is_empty() {
        return Err(crate::error::GitnadoError::OperationFailed(
            "No lines found in the specified range".to_string(),
        ));
    }

    // Build a patch that includes only the selected lines
    // For lines not selected, we convert additions to nothing (skip them)
    // and deletions to context lines
    let mut patch = String::new();
    patch.push_str(&format!("--- a/{}\n", file_path));
    patch.push_str(&format!("+++ b/{}\n", file_path));

    for (hunk, selected_indices) in &selected_hunks {
        // Rebuild the hunk with only selected changes
        let mut hunk_body = String::new();
        let mut old_count: u32 = 0;
        let mut new_count: u32 = 0;

        for (idx, line) in hunk.lines.iter().enumerate() {
            let is_selected = selected_indices.contains(&idx);

            match line.line_type.as_str() {
                "context" => {
                    push_diff_line(&mut hunk_body, ' ', &line.content);
                    old_count += 1;
                    new_count += 1;
                }
                "addition" if is_selected => {
                    push_diff_line(&mut hunk_body, '+', &line.content);
                    new_count += 1;
                }
                // Not-selected additions fall through to _ => {} (omitted)
                "deletion" => {
                    if is_selected {
                        push_diff_line(&mut hunk_body, '-', &line.content);
                        old_count += 1;
                    } else {
                        // Not selected deletions become context lines
                        push_diff_line(&mut hunk_body, ' ', &line.content);
                        old_count += 1;
                        new_count += 1;
                    }
                }
                _ => {}
            }
        }

        // Write hunk header
        patch.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            hunk.old_start, old_count, hunk.new_start, new_count
        ));

        patch.push_str(&hunk_body);
    }

    // Apply the patch
    let temp_dir = std::env::temp_dir();
    let patch_file = temp_dir.join(format!("gitnado_stage_lines_{}.patch", std::process::id()));

    let mut file = std::fs::File::create(&patch_file)?;
    file.write_all(patch.as_bytes())?;
    file.flush()?;
    drop(file);

    let output = create_command("git")
        .args(["apply", "--cached", "--unidiff-zero"])
        .arg(&patch_file)
        .current_dir(&path)
        .output()?;

    let _ = std::fs::remove_file(&patch_file);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(crate::error::GitnadoError::OperationFailed(format!(
            "Failed to stage lines: {}",
            stderr
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {

    /// Discarding an untracked directory that IS (or holds) a repository must
    /// be refused. libgit2 does not descend into a directory holding .git, so
    /// a nested repo surfaces in the file list as one ordinary row — and
    /// discarding a row reads as "throw away my edit", not "destroy a repo".
    #[tokio::test]
    async fn test_discard_refuses_an_untracked_nested_repo() {
        let test_repo = TestRepo::with_initial_commit();
        let nested = test_repo.path.join("vendor/lib");
        std::fs::create_dir_all(&nested).unwrap();
        git2::Repository::init(&nested).unwrap();
        std::fs::write(nested.join("code.rs").as_path(), "fn main() {}").unwrap();

        let result = discard_changes(test_repo.path_str(), vec!["vendor/lib/".to_string()]).await;

        assert!(
            result.is_err(),
            "must refuse to discard a nested repository"
        );
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("git repository"),
            "the message must say why: {msg}"
        );
        assert!(
            nested.join(".git").exists(),
            "the nested repository must survive"
        );
    }
    /// The nested-repo refusal must be ALL-OR-NOTHING.
    ///
    /// The guard used to sit inside the deletion loop, so "Discard all
    /// selected" over ten rows deleted every entry up to the nested repo and
    /// then returned the error. Those entries were untracked — no object, no
    /// reflog, no trash — while the message the user read ("would destroy its
    /// history") says nothing happened, and the frontend's error branch does
    /// not reload the list, so rows for deleted files stayed on screen.
    #[tokio::test]
    async fn test_discard_refusing_a_nested_repo_deletes_nothing_at_all() {
        let test_repo = TestRepo::with_initial_commit();

        // A tracked file with an unstaged edit, selected FIRST — the tracked
        // restore also runs before the deletion loop, and it is just as
        // destructive (the edit exists in no git object).
        test_repo.create_file("README.md", "my unsaved edit");

        // Untracked entries, one of them before the nested repo and one after.
        test_repo.create_file("first.txt", "first");
        test_repo.create_file("second.txt", "second");
        let nested = test_repo.path.join("vendor/lib");
        std::fs::create_dir_all(&nested).unwrap();
        git2::Repository::init(&nested).unwrap();
        test_repo.create_file("last.txt", "last");

        let result = discard_changes(
            test_repo.path_str(),
            vec![
                "README.md".to_string(),
                "first.txt".to_string(),
                "second.txt".to_string(),
                "vendor/lib".to_string(),
                "last.txt".to_string(),
            ],
        )
        .await;

        let err = result.expect_err("must refuse the whole batch");
        let msg = err.to_string();
        assert!(
            msg.contains("git repository"),
            "the message must say why: {msg}"
        );
        assert!(
            msg.contains("Nothing was discarded"),
            "the message must state that the batch was refused whole: {msg}"
        );
        assert!(
            msg.contains("Clean Working Directory"),
            "the message must point at the in-app dialog that can do this, \
             not at a terminal: {msg}"
        );

        // Every selected entry survives, in its pre-call state.
        assert_eq!(
            std::fs::read_to_string(test_repo.path.join("README.md")).unwrap(),
            "my unsaved edit",
            "the tracked file must not be restored either"
        );
        for name in ["first.txt", "second.txt", "last.txt"] {
            assert!(
                test_repo.path.join(name).exists(),
                "{name} was deleted before the refusal — untracked, so unrecoverable"
            );
        }
        assert!(
            nested.join(".git").exists(),
            "the nested repository must survive"
        );
    }

    /// A nested repo anywhere in the selection blocks it, even when every
    /// entry before it is a plain file the loop would have removed happily.
    #[tokio::test]
    async fn test_discard_refuses_when_the_nested_repo_is_nested_deeper() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_file("a.txt", "a");
        let deep = test_repo.path.join("build/vendor/lib");
        std::fs::create_dir_all(&deep).unwrap();
        git2::Repository::init(&deep).unwrap();

        let err = discard_changes(
            test_repo.path_str(),
            vec!["a.txt".to_string(), "build".to_string()],
        )
        .await
        .expect_err("a repo at any depth must block the batch");
        assert!(err.to_string().contains("git repository"));
        assert!(
            test_repo.path.join("a.txt").exists(),
            "the earlier entry must not have been deleted"
        );
        assert!(deep.join(".git").exists());
    }

    use super::*;
    use crate::test_utils::TestRepo;

    #[tokio::test]
    async fn test_discard_changes_modified_tracked_file() {
        let repo = TestRepo::with_initial_commit();

        // Modify an existing tracked file
        repo.create_file("README.md", "Modified content");

        // Verify file is modified
        let content = std::fs::read_to_string(repo.path.join("README.md")).unwrap();
        assert_eq!(content, "Modified content");

        // Discard changes
        let result = discard_changes(repo.path_str(), vec!["README.md".to_string()]).await;

        assert!(result.is_ok());

        // File should be restored to original content
        let content = std::fs::read_to_string(repo.path.join("README.md")).unwrap();
        assert_eq!(content, "# Test Repo");
    }

    #[tokio::test]
    async fn test_discard_changes_untracked_file() {
        let repo = TestRepo::with_initial_commit();

        // Create an untracked file
        repo.create_file("untracked.txt", "Untracked content");

        // Verify file exists
        assert!(repo.path.join("untracked.txt").exists());

        // Discard changes (should delete the file)
        let result = discard_changes(repo.path_str(), vec!["untracked.txt".to_string()]).await;

        assert!(result.is_ok());

        // File should be deleted
        assert!(!repo.path.join("untracked.txt").exists());
    }

    #[tokio::test]
    async fn test_discard_changes_staged_new_file() {
        let repo = TestRepo::with_initial_commit();

        // Create and stage a new file (not yet committed)
        repo.create_file("newfile.txt", "New file content");
        repo.stage_file("newfile.txt");

        // Verify file is staged
        let git_repo = repo.repo();
        let index = git_repo.index().unwrap();
        assert!(index.get_path(Path::new("newfile.txt"), 0).is_some());

        // Discard changes - this should restore from index since file is staged
        // but the working tree file should match the staged version
        let result = discard_changes(repo.path_str(), vec!["newfile.txt".to_string()]).await;

        assert!(result.is_ok());

        // File should still exist (it's in the index)
        assert!(repo.path.join("newfile.txt").exists());
    }

    #[tokio::test]
    async fn test_discard_changes_deleted_tracked_file() {
        let repo = TestRepo::with_initial_commit();

        // Delete a tracked file
        std::fs::remove_file(repo.path.join("README.md")).unwrap();

        // Verify file is deleted
        assert!(!repo.path.join("README.md").exists());

        // Discard changes (should restore the file)
        let result = discard_changes(repo.path_str(), vec!["README.md".to_string()]).await;

        assert!(result.is_ok());

        // File should be restored
        assert!(repo.path.join("README.md").exists());
        let content = std::fs::read_to_string(repo.path.join("README.md")).unwrap();
        assert_eq!(content, "# Test Repo");
    }

    #[tokio::test]
    async fn test_discard_changes_untracked_directory() {
        let repo = TestRepo::with_initial_commit();

        // Create an untracked directory with files
        repo.create_file("untracked_dir/file1.txt", "Content 1");
        repo.create_file("untracked_dir/file2.txt", "Content 2");

        // Verify directory exists
        assert!(repo.path.join("untracked_dir").exists());
        assert!(repo.path.join("untracked_dir").is_dir());

        // Discard changes (should delete the directory)
        let result = discard_changes(repo.path_str(), vec!["untracked_dir".to_string()]).await;

        assert!(result.is_ok());

        // Directory should be deleted
        assert!(!repo.path.join("untracked_dir").exists());
    }

    #[tokio::test]
    async fn test_discard_changes_multiple_files() {
        let repo = TestRepo::with_initial_commit();

        // Create various changes
        repo.create_file("README.md", "Modified readme");
        repo.create_file("untracked.txt", "Untracked");
        repo.create_file("another.txt", "Another file");
        repo.stage_file("another.txt");

        // Discard all changes
        let result = discard_changes(
            repo.path_str(),
            vec!["README.md".to_string(), "untracked.txt".to_string()],
        )
        .await;

        assert!(result.is_ok());

        // README should be restored
        let content = std::fs::read_to_string(repo.path.join("README.md")).unwrap();
        assert_eq!(content, "# Test Repo");

        // Untracked file should be deleted
        assert!(!repo.path.join("untracked.txt").exists());

        // Staged file should still exist (wasn't in discard list)
        assert!(repo.path.join("another.txt").exists());
    }

    #[tokio::test]
    async fn test_discard_changes_rejects_path_outside_repo() {
        let repo = TestRepo::with_initial_commit();

        // A path that is in neither the index nor HEAD is classified untracked,
        // which is the branch that DELETES. Without containment validation the
        // traversal would escape the repo and remove an unrelated directory.
        let outside = repo.path.parent().unwrap().join("outside-victim.txt");
        std::fs::write(&outside, "must survive").unwrap();

        let result =
            discard_changes(repo.path_str(), vec!["../outside-victim.txt".to_string()]).await;

        assert!(result.is_err(), "traversing path must be rejected");
        assert!(
            outside.exists(),
            "file outside the repository must not be deleted"
        );

        std::fs::remove_file(&outside).ok();
    }

    #[tokio::test]
    async fn test_discard_changes_does_not_glob_match_sibling() {
        let repo = TestRepo::with_initial_commit();

        // `a[1].txt` is a legitimate filename, but it is also a pathspec that
        // matches `a1.txt`. Discarding the former must not restore the latter.
        repo.create_file("a[1].txt", "original bracket");
        repo.create_file("a1.txt", "original plain");
        repo.stage_file("a[1].txt");
        repo.stage_file("a1.txt");
        repo.create_commit("add both", &[]);

        repo.create_file("a[1].txt", "modified bracket");
        repo.create_file("a1.txt", "UNSAVED WORK");

        let result = discard_changes(repo.path_str(), vec!["a[1].txt".to_string()]).await;
        assert!(result.is_ok());

        assert_eq!(
            std::fs::read_to_string(repo.path.join("a[1].txt")).unwrap(),
            "original bracket",
            "the named file should be restored"
        );
        assert_eq!(
            std::fs::read_to_string(repo.path.join("a1.txt")).unwrap(),
            "UNSAVED WORK",
            "a file that merely glob-matches must be left untouched"
        );
    }

    #[tokio::test]
    async fn test_get_status_shows_untracked() {
        let repo = TestRepo::with_initial_commit();

        // Create an untracked file
        repo.create_file("untracked.txt", "Content");

        let result = get_status(repo.path_str()).await;
        assert!(result.is_ok());

        let entries = result.unwrap();
        let untracked = entries.iter().find(|e| e.path == "untracked.txt");
        assert!(untracked.is_some());
        assert_eq!(untracked.unwrap().status, FileStatus::Untracked);
        assert!(!untracked.unwrap().is_staged);
    }

    #[tokio::test]
    async fn test_get_status_shows_modified() {
        let repo = TestRepo::with_initial_commit();

        // Modify a tracked file
        repo.create_file("README.md", "Modified");

        let result = get_status(repo.path_str()).await;
        assert!(result.is_ok());

        let entries = result.unwrap();
        let modified = entries.iter().find(|e| e.path == "README.md");
        assert!(modified.is_some());
        assert_eq!(modified.unwrap().status, FileStatus::Modified);
        assert!(!modified.unwrap().is_staged);
    }

    // Regression test for "File 'X' not found in diff" error.
    //
    // Sequence: a file is rewritten with identical content (common after
    // checkout/rebase/merge or build steps that touch files). libgit2's
    // status then flags it "racy-modified" on stat alone. Previously
    // get_status returned the entry, the UI rendered it as "M", and
    // clicking it triggered get_file_diff — which found nothing in the
    // content-diff and errored out.
    //
    // With update_index(true) on StatusOptions, libgit2 refreshes the
    // stat info and the entry drops out of status. The UI never sees it.
    #[tokio::test]
    async fn test_get_status_drops_stat_stale_entries() {
        let repo = TestRepo::with_initial_commit();

        // Rewrite README.md with the exact content committed by
        // with_initial_commit(). This bumps mtime without changing content.
        repo.create_file("README.md", "# Test Repo");

        let entries = get_status(repo.path_str()).await.unwrap();
        let entry = entries.iter().find(|e| e.path == "README.md");

        assert!(
            entry.is_none(),
            "Stat-stale entry should not appear in status (content matches index); got {:?}",
            entry
        );
    }

    // Companion test: if the status layer misbehaves and a stat-stale
    // entry ever leaks through, get_file_diff must not panic. It may
    // return an "not found in diff" error (the frontend handles that
    // explicitly for the "fully-staged hunk" case), but it must not
    // surface as an unhandled exception.
    #[tokio::test]
    async fn test_get_file_diff_stat_stale_is_handled() {
        use crate::commands::diff::get_file_diff;

        let repo = TestRepo::with_initial_commit();
        repo.create_file("README.md", "# Test Repo");

        let result =
            get_file_diff(repo.path_str(), "README.md".to_string(), Some(false), None).await;

        // Either Ok (file has no real changes, returned as empty diff via
        // fallback) or Err (the explicit "not found in diff" path). Must
        // not panic or produce a non-Gitnado error.
        match result {
            Ok(_) => {}
            Err(crate::error::GitnadoError::OperationFailed(msg)) => {
                assert!(
                    msg.contains("not found in diff"),
                    "Unexpected error message: {}",
                    msg
                );
            }
            Err(e) => panic!("Unexpected error variant: {:?}", e),
        }
    }

    #[tokio::test]
    async fn test_stage_and_unstage_files() {
        let repo = TestRepo::with_initial_commit();

        // Create and stage a file
        repo.create_file("new.txt", "Content");

        let result = stage_files(repo.path_str(), vec!["new.txt".to_string()]).await;
        assert!(result.is_ok());

        // Verify file is staged
        let status = get_status(repo.path_str()).await.unwrap();
        let staged = status.iter().find(|e| e.path == "new.txt" && e.is_staged);
        assert!(staged.is_some());

        // Unstage the file
        let result = unstage_files(repo.path_str(), vec!["new.txt".to_string()]).await;
        assert!(result.is_ok());

        // Verify file is no longer staged
        let status = get_status(repo.path_str()).await.unwrap();
        let staged = status.iter().find(|e| e.path == "new.txt" && e.is_staged);
        assert!(staged.is_none());
    }

    #[tokio::test]
    async fn test_strip_trailing_whitespace() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file("whitespace.txt", "hello   \nworld  \nfoo\n");

        let result =
            strip_trailing_whitespace(repo.path_str(), vec!["whitespace.txt".to_string()]).await;
        assert!(result.is_ok());

        let content = std::fs::read_to_string(repo.path.join("whitespace.txt")).unwrap();
        assert_eq!(content, "hello\nworld\nfoo\n");
    }

    #[tokio::test]
    async fn test_strip_trailing_whitespace_no_trailing_newline() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file("no_newline.txt", "hello   \nworld  ");

        let result =
            strip_trailing_whitespace(repo.path_str(), vec!["no_newline.txt".to_string()]).await;
        assert!(result.is_ok());

        let content = std::fs::read_to_string(repo.path.join("no_newline.txt")).unwrap();
        assert_eq!(content, "hello\nworld");
    }

    #[tokio::test]
    async fn test_strip_trailing_whitespace_multiple_files() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file("file1.txt", "a   \nb  \n");
        repo.create_file("file2.txt", "c  \nd   \n");

        let result = strip_trailing_whitespace(
            repo.path_str(),
            vec!["file1.txt".to_string(), "file2.txt".to_string()],
        )
        .await;
        assert!(result.is_ok());

        let content1 = std::fs::read_to_string(repo.path.join("file1.txt")).unwrap();
        assert_eq!(content1, "a\nb\n");

        let content2 = std::fs::read_to_string(repo.path.join("file2.txt")).unwrap();
        assert_eq!(content2, "c\nd\n");
    }

    #[tokio::test]
    async fn test_strip_trailing_whitespace_skips_missing_files() {
        let repo = TestRepo::with_initial_commit();

        let result =
            strip_trailing_whitespace(repo.path_str(), vec!["nonexistent.txt".to_string()]).await;

        // Should succeed even if file doesn't exist (just skip it)
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_get_file_hunks_unstaged() {
        let repo = TestRepo::with_initial_commit();

        // Modify the tracked file to create a diff
        repo.create_file("README.md", "# Test Repo\nNew line added\n");

        let result = get_file_hunks(repo.path_str(), "README.md".to_string(), false).await;
        assert!(result.is_ok());

        let file_hunks = result.unwrap();
        assert_eq!(file_hunks.file_path, "README.md");
        assert!(!file_hunks.hunks.is_empty());
        assert_eq!(file_hunks.hunks[0].index, 0);
        assert!(!file_hunks.hunks[0].is_staged);
        assert!(file_hunks.total_additions > 0 || file_hunks.total_deletions > 0);
    }

    #[tokio::test]
    async fn test_get_file_hunks_staged() {
        let repo = TestRepo::with_initial_commit();

        // Modify and stage the file
        repo.create_file("README.md", "# Modified Repo\n");
        repo.stage_file("README.md");

        let result = get_file_hunks(repo.path_str(), "README.md".to_string(), true).await;
        assert!(result.is_ok());

        let file_hunks = result.unwrap();
        assert_eq!(file_hunks.file_path, "README.md");
        assert!(!file_hunks.hunks.is_empty());
        assert!(file_hunks.hunks[0].is_staged);
    }

    #[tokio::test]
    async fn test_get_file_hunks_multiple_hunks() {
        let repo = TestRepo::with_initial_commit();

        // Create a file with multiple lines
        let original_content = (1..=20)
            .map(|i| format!("line {}", i))
            .collect::<Vec<_>>()
            .join("\n");
        repo.create_commit("Add multiline file", &[("multi.txt", &original_content)]);

        // Modify lines at the beginning and end to create multiple hunks
        let mut lines: Vec<String> = (1..=20).map(|i| format!("line {}", i)).collect();
        lines[0] = "modified line 1".to_string();
        lines[19] = "modified line 20".to_string();
        let modified_content = lines.join("\n");
        repo.create_file("multi.txt", &modified_content);

        let result = get_file_hunks(repo.path_str(), "multi.txt".to_string(), false).await;
        assert!(result.is_ok());

        let file_hunks = result.unwrap();
        // Should have at least one hunk (may be 1 or 2 depending on context overlap)
        assert!(!file_hunks.hunks.is_empty());

        // Verify hunk indices are sequential
        for (i, hunk) in file_hunks.hunks.iter().enumerate() {
            assert_eq!(hunk.index, i as u32);
        }
    }

    #[tokio::test]
    async fn test_get_file_hunks_no_changes() {
        let repo = TestRepo::with_initial_commit();

        // No modifications - should return empty hunks
        let result = get_file_hunks(repo.path_str(), "README.md".to_string(), false).await;
        assert!(result.is_ok());

        let file_hunks = result.unwrap();
        assert!(file_hunks.hunks.is_empty());
        assert_eq!(file_hunks.total_additions, 0);
        assert_eq!(file_hunks.total_deletions, 0);
    }

    #[tokio::test]
    async fn test_get_file_hunks_line_types() {
        let repo = TestRepo::with_initial_commit();

        // Create a file with known content
        repo.create_commit("Add test file", &[("test.txt", "line1\nline2\nline3\n")]);

        // Modify to have additions and deletions
        repo.create_file("test.txt", "line1\nmodified_line2\nline3\nnew_line4\n");

        let result = get_file_hunks(repo.path_str(), "test.txt".to_string(), false).await;
        assert!(result.is_ok());

        let file_hunks = result.unwrap();
        assert!(!file_hunks.hunks.is_empty());

        // Check that lines have proper types
        let hunk = &file_hunks.hunks[0];
        let has_addition = hunk.lines.iter().any(|l| l.line_type == "addition");
        let has_deletion = hunk.lines.iter().any(|l| l.line_type == "deletion");
        let has_context = hunk.lines.iter().any(|l| l.line_type == "context");

        assert!(has_addition, "Should have additions");
        assert!(has_deletion, "Should have deletions");
        assert!(has_context, "Should have context lines");
    }

    #[tokio::test]
    async fn test_stage_hunk_by_index() {
        let repo = TestRepo::with_initial_commit();

        // Create a file and commit it
        repo.create_commit("Add test file", &[("test.txt", "line1\nline2\nline3\n")]);

        // Modify the file
        repo.create_file("test.txt", "modified_line1\nline2\nline3\n");

        // Get the hunks first
        let hunks = get_file_hunks(repo.path_str(), "test.txt".to_string(), false)
            .await
            .unwrap();
        assert!(!hunks.hunks.is_empty());

        // Stage the first hunk by index
        let result = stage_hunk_by_index(repo.path_str(), "test.txt".to_string(), 0).await;
        assert!(result.is_ok(), "Failed to stage hunk: {:?}", result.err());

        // Verify the file is now partially staged - check staged hunks
        let staged_hunks = get_file_hunks(repo.path_str(), "test.txt".to_string(), true)
            .await
            .unwrap();
        assert!(
            !staged_hunks.hunks.is_empty(),
            "Should have staged hunks after staging"
        );
    }

    #[tokio::test]
    async fn test_unstage_hunk_by_index() {
        let repo = TestRepo::with_initial_commit();

        // Create a file and commit it
        repo.create_commit("Add test file", &[("test.txt", "line1\nline2\nline3\n")]);

        // Modify and stage the file completely
        repo.create_file("test.txt", "modified_line1\nline2\nline3\n");
        repo.stage_file("test.txt");

        // Get staged hunks
        let staged_hunks = get_file_hunks(repo.path_str(), "test.txt".to_string(), true)
            .await
            .unwrap();
        assert!(!staged_hunks.hunks.is_empty());

        // Unstage the first hunk
        let result = unstage_hunk_by_index(repo.path_str(), "test.txt".to_string(), 0).await;
        assert!(result.is_ok(), "Failed to unstage hunk: {:?}", result.err());

        // Verify no staged hunks remain
        let remaining_staged = get_file_hunks(repo.path_str(), "test.txt".to_string(), true)
            .await
            .unwrap();
        assert!(
            remaining_staged.hunks.is_empty(),
            "Should have no staged hunks after unstaging"
        );
    }

    #[tokio::test]
    async fn test_stage_hunk_by_index_invalid_index() {
        let repo = TestRepo::with_initial_commit();

        // Modify a file
        repo.create_file("README.md", "Modified content\n");

        // Try to stage with an invalid index
        let result = stage_hunk_by_index(repo.path_str(), "README.md".to_string(), 999).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_stage_lines_basic() {
        let repo = TestRepo::with_initial_commit();

        // Create a file with known content
        repo.create_commit(
            "Add test file",
            &[("test.txt", "line1\nline2\nline3\nline4\n")],
        );

        // Modify multiple lines
        repo.create_file("test.txt", "modified_line1\nline2\nmodified_line3\nline4\n");

        // Get hunks to find the line range
        let hunks = get_file_hunks(repo.path_str(), "test.txt".to_string(), false)
            .await
            .unwrap();
        assert!(!hunks.hunks.is_empty());

        // Stage all lines in the first hunk
        let total_lines: u32 = hunks.hunks.iter().map(|h| h.lines.len() as u32).sum();
        let result = stage_lines(
            repo.path_str(),
            "test.txt".to_string(),
            0,
            total_lines.saturating_sub(1),
        )
        .await;
        assert!(result.is_ok(), "Failed to stage lines: {:?}", result.err());
    }

    #[tokio::test]
    async fn test_stage_lines_invalid_range() {
        let repo = TestRepo::with_initial_commit();

        // No modifications
        let result = stage_lines(repo.path_str(), "README.md".to_string(), 1000, 2000).await;

        // Should fail since there are no hunks/lines to select
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_build_hunk_patch() {
        let hunk = IndexedDiffHunk {
            index: 0,
            old_start: 1,
            old_lines: 3,
            new_start: 1,
            new_lines: 3,
            header: "@@ -1,3 +1,3 @@".to_string(),
            lines: vec![
                HunkDiffLine {
                    line_type: "deletion".to_string(),
                    content: "old line\n".to_string(),
                    old_line_number: Some(1),
                    new_line_number: None,
                },
                HunkDiffLine {
                    line_type: "addition".to_string(),
                    content: "new line\n".to_string(),
                    old_line_number: None,
                    new_line_number: Some(1),
                },
                HunkDiffLine {
                    line_type: "context".to_string(),
                    content: "unchanged\n".to_string(),
                    old_line_number: Some(2),
                    new_line_number: Some(2),
                },
            ],
            is_staged: false,
        };

        let patch = build_hunk_patch("test.txt", &hunk);
        assert!(patch.contains("--- a/test.txt"));
        assert!(patch.contains("+++ b/test.txt"));
        assert!(patch.contains("@@ -1,3 +1,3 @@"));
        assert!(patch.contains("-old line"));
        assert!(patch.contains("+new line"));
        assert!(patch.contains(" unchanged"));
    }

    #[tokio::test]
    async fn test_get_sorted_file_status_sort_by_name() {
        let repo = TestRepo::with_initial_commit();

        // Create files with different names
        repo.create_file("charlie.txt", "C");
        repo.create_file("alpha.txt", "A");
        repo.create_file("bravo.txt", "B");

        let result = get_sorted_file_status(repo.path_str(), "name".to_string(), None, false).await;
        assert!(result.is_ok());

        let sorted = result.unwrap();
        assert_eq!(sorted.files.len(), 3);
        assert_eq!(sorted.total_count, 3);
        assert_eq!(sorted.untracked_count, 3);

        // Files should be sorted alphabetically
        assert_eq!(sorted.files[0].filename, "alpha.txt");
        assert_eq!(sorted.files[1].filename, "bravo.txt");
        assert_eq!(sorted.files[2].filename, "charlie.txt");
    }

    #[tokio::test]
    async fn test_get_sorted_file_status_sort_by_name_desc() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file("alpha.txt", "A");
        repo.create_file("bravo.txt", "B");
        repo.create_file("charlie.txt", "C");

        let result = get_sorted_file_status(
            repo.path_str(),
            "name".to_string(),
            Some("desc".to_string()),
            false,
        )
        .await;
        assert!(result.is_ok());

        let sorted = result.unwrap();
        assert_eq!(sorted.files[0].filename, "charlie.txt");
        assert_eq!(sorted.files[1].filename, "bravo.txt");
        assert_eq!(sorted.files[2].filename, "alpha.txt");
    }

    #[tokio::test]
    async fn test_get_sorted_file_status_sort_by_extension() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file("file.rs", "rust");
        repo.create_file("file.js", "javascript");
        repo.create_file("file.ts", "typescript");

        let result =
            get_sorted_file_status(repo.path_str(), "extension".to_string(), None, false).await;
        assert!(result.is_ok());

        let sorted = result.unwrap();
        assert_eq!(sorted.files.len(), 3);

        // Should be sorted by extension: js, rs, ts
        assert_eq!(sorted.files[0].extension, Some("js".to_string()));
        assert_eq!(sorted.files[1].extension, Some("rs".to_string()));
        assert_eq!(sorted.files[2].extension, Some("ts".to_string()));
    }

    #[tokio::test]
    async fn test_get_sorted_file_status_sort_by_status() {
        let repo = TestRepo::with_initial_commit();

        // Create an untracked file (status: untracked)
        repo.create_file("new_file.txt", "new");

        // Modify a tracked file (status: modified)
        repo.create_file("README.md", "Modified");

        let result =
            get_sorted_file_status(repo.path_str(), "status".to_string(), None, false).await;
        assert!(result.is_ok());

        let sorted = result.unwrap();
        assert_eq!(sorted.total_count, 2);

        // Modified should come before untracked in status sort
        assert_eq!(sorted.files[0].status, "modified");
        assert_eq!(sorted.files[1].status, "untracked");
    }

    #[tokio::test]
    async fn test_get_sorted_file_status_sort_by_path() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file("src/main.rs", "main");
        repo.create_file("docs/readme.md", "docs");
        repo.create_file("test.txt", "test");

        let result = get_sorted_file_status(repo.path_str(), "path".to_string(), None, false).await;
        assert!(result.is_ok());

        let sorted = result.unwrap();
        assert_eq!(sorted.files.len(), 3);

        // Empty directory (root) comes first, then "docs", then "src"
        assert_eq!(sorted.files[0].directory, "");
        assert_eq!(sorted.files[1].directory, "docs");
        assert_eq!(sorted.files[2].directory, "src");
    }

    #[tokio::test]
    async fn test_get_sorted_file_status_group_by_directory() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file("src/b.rs", "b");
        repo.create_file("src/a.rs", "a");
        repo.create_file("docs/z.md", "z");
        repo.create_file("docs/a.md", "a");

        let result = get_sorted_file_status(repo.path_str(), "name".to_string(), None, true).await;
        assert!(result.is_ok());

        let sorted = result.unwrap();
        assert_eq!(sorted.files.len(), 4);

        // Should be grouped by directory, then sorted by name within each group
        assert_eq!(sorted.files[0].directory, "docs");
        assert_eq!(sorted.files[0].filename, "a.md");
        assert_eq!(sorted.files[1].directory, "docs");
        assert_eq!(sorted.files[1].filename, "z.md");
        assert_eq!(sorted.files[2].directory, "src");
        assert_eq!(sorted.files[2].filename, "a.rs");
        assert_eq!(sorted.files[3].directory, "src");
        assert_eq!(sorted.files[3].filename, "b.rs");
    }

    #[tokio::test]
    async fn test_get_sorted_file_status_counts() {
        let repo = TestRepo::with_initial_commit();

        // Create and stage a new file
        repo.create_file("staged.txt", "staged content");
        repo.stage_file("staged.txt");

        // Modify a tracked file (unstaged)
        repo.create_file("README.md", "modified");

        // Create an untracked file
        repo.create_file("untracked.txt", "untracked");

        let result = get_sorted_file_status(repo.path_str(), "name".to_string(), None, false).await;
        assert!(result.is_ok());

        let sorted = result.unwrap();
        assert!(sorted.staged_count >= 1);
        assert!(sorted.unstaged_count >= 1);
        assert!(sorted.untracked_count >= 1);
    }

    #[tokio::test]
    async fn test_get_sorted_file_status_enriched_metadata() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file("src/utils/helper.rs", "helper content");

        let result = get_sorted_file_status(repo.path_str(), "name".to_string(), None, false).await;
        assert!(result.is_ok());

        let sorted = result.unwrap();
        assert_eq!(sorted.files.len(), 1);

        let entry = &sorted.files[0];
        assert_eq!(entry.path, "src/utils/helper.rs");
        assert_eq!(entry.filename, "helper.rs");
        assert_eq!(entry.directory, "src/utils");
        assert_eq!(entry.extension, Some("rs".to_string()));
        assert!(!entry.is_staged);
    }

    #[tokio::test]
    async fn test_get_sorted_file_status_no_extension() {
        let repo = TestRepo::with_initial_commit();

        repo.create_file("Makefile", "all:");

        let result = get_sorted_file_status(repo.path_str(), "name".to_string(), None, false).await;
        assert!(result.is_ok());

        let sorted = result.unwrap();
        let makefile = sorted.files.iter().find(|f| f.filename == "Makefile");
        assert!(makefile.is_some());
        assert_eq!(makefile.unwrap().extension, None);
    }

    #[tokio::test]
    async fn test_get_sorted_file_status_empty_repo() {
        let repo = TestRepo::with_initial_commit();

        let result = get_sorted_file_status(repo.path_str(), "name".to_string(), None, false).await;
        assert!(result.is_ok());

        let sorted = result.unwrap();
        assert_eq!(sorted.files.len(), 0);
        assert_eq!(sorted.total_count, 0);
        assert_eq!(sorted.staged_count, 0);
        assert_eq!(sorted.unstaged_count, 0);
        assert_eq!(sorted.untracked_count, 0);
        assert_eq!(sorted.conflicted_count, 0);
    }

    // Finding 21 (data-loss): `discard_changes` on a file with both staged and
    // later unstaged edits must restore the worktree from the INDEX (like
    // `git checkout -- <path>`), NOT from HEAD. Restoring from HEAD destroys
    // the staged version, which is never committed and has no reflog.
    #[tokio::test]
    async fn test_discard_changes_preserves_staged_content() {
        let repo = TestRepo::with_initial_commit();

        // v1 committed
        repo.create_commit("add f", &[("f.txt", "v1\n")]);
        // v2 staged
        repo.create_file("f.txt", "v2-staged\n");
        repo.stage_file("f.txt");
        // v3 unstaged on top
        repo.create_file("f.txt", "v3-worktree\n");

        let result = discard_changes(repo.path_str(), vec!["f.txt".to_string()]).await;
        assert!(result.is_ok(), "discard failed: {:?}", result.err());

        // Worktree must be restored to the STAGED version (v2), not HEAD (v1).
        let content = std::fs::read_to_string(repo.path.join("f.txt")).unwrap();
        assert_eq!(
            content, "v2-staged\n",
            "worktree must be restored from the index (staged v2), not HEAD"
        );

        // The staged index blob must remain v2 — the staged change survives.
        let git_repo = repo.repo();
        let index = git_repo.index().unwrap();
        let entry = index
            .get_path(Path::new("f.txt"), 0)
            .expect("f.txt should still be tracked in the index");
        let blob = git_repo.find_blob(entry.id).unwrap();
        assert_eq!(
            blob.content(),
            b"v2-staged\n",
            "staged content must not be discarded"
        );
    }

    // Finding 25 (wrong-result): staging a dangling symlink (target missing)
    // must stage it as a 120000 blob containing the link target, exactly like
    // `git add`. Deciding via Path::exists() (which follows the link) wrongly
    // treats it as a deletion.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_stage_dangling_symlink() {
        let repo = TestRepo::with_initial_commit();

        std::os::unix::fs::symlink("does-not-exist", repo.path.join("broken"))
            .expect("failed to create symlink");

        let result = stage_files(repo.path_str(), vec!["broken".to_string()]).await;
        assert!(result.is_ok(), "staging failed: {:?}", result.err());

        let git_repo = repo.repo();
        let index = git_repo.index().unwrap();
        let entry = index
            .get_path(Path::new("broken"), 0)
            .expect("dangling symlink should be staged, not treated as a deletion");
        assert_eq!(
            entry.mode, 0o120000,
            "should be staged as a symlink (120000)"
        );
        let blob = git_repo.find_blob(entry.id).unwrap();
        assert_eq!(
            blob.content(),
            b"does-not-exist",
            "symlink blob must contain the link target"
        );
    }

    // Finding 26 (wrong-error): unstaging must work in a repository with no
    // commits (unborn HEAD). `git reset -- <paths>` resolves against the empty
    // tree there, dropping the paths from the index.
    #[tokio::test]
    async fn test_unstage_files_unborn_head() {
        let repo = TestRepo::new(); // freshly initialized, no commits

        repo.create_file("new.txt", "content\n");
        repo.stage_file("new.txt");

        // Sanity: it is staged.
        {
            let git_repo = repo.repo();
            let index = git_repo.index().unwrap();
            assert!(index.get_path(Path::new("new.txt"), 0).is_some());
        }

        let result = unstage_files(repo.path_str(), vec!["new.txt".to_string()]).await;
        assert!(
            result.is_ok(),
            "unstage on unborn HEAD should succeed: {:?}",
            result.err()
        );

        // The file is no longer staged...
        let git_repo = repo.repo();
        let index = git_repo.index().unwrap();
        assert!(
            index.get_path(Path::new("new.txt"), 0).is_none(),
            "file should be removed from the index after unstage"
        );
        // ...but still present in the worktree (now untracked).
        assert!(repo.path.join("new.txt").exists());
    }

    // Finding 30 (wrong-result): staging the last hunk of a file whose final
    // line has no trailing newline must succeed and stage the exact worktree
    // bytes. Without the "\ No newline at end of file" marker the generated
    // patch is rejected by `git apply --cached` ("patch does not apply").
    #[tokio::test]
    async fn test_stage_hunk_by_index_no_trailing_newline() {
        let repo = TestRepo::with_initial_commit();

        // Commit a file whose final line has NO trailing newline.
        repo.create_commit("add nonl", &[("nonl.txt", "line1\nline2")]);

        // Modify the final (no-newline) line, still without a trailing newline.
        repo.create_file("nonl.txt", "line1\nCHANGED");

        let hunks = get_file_hunks(repo.path_str(), "nonl.txt".to_string(), false)
            .await
            .unwrap();
        assert!(!hunks.hunks.is_empty());

        let result = stage_hunk_by_index(repo.path_str(), "nonl.txt".to_string(), 0).await;
        assert!(
            result.is_ok(),
            "staging a no-trailing-newline hunk should succeed: {:?}",
            result.err()
        );

        // The staged blob must be the exact worktree bytes (no spurious \n).
        let git_repo = repo.repo();
        let index = git_repo.index().unwrap();
        let entry = index.get_path(Path::new("nonl.txt"), 0).unwrap();
        let blob = git_repo.find_blob(entry.id).unwrap();
        assert_eq!(
            blob.content(),
            b"line1\nCHANGED",
            "staged content must match the worktree bytes exactly"
        );

        // And the file should now be fully staged (no remaining unstaged hunks).
        let remaining = get_file_hunks(repo.path_str(), "nonl.txt".to_string(), false)
            .await
            .unwrap();
        assert!(
            remaining.hunks.is_empty(),
            "file should be fully staged after staging its only hunk"
        );
    }
}
