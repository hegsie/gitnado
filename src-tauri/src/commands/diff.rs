//! Diff command handlers

use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::Path;
use tauri::command;

use super::path_utils::validate_path_within_repo;
use crate::error::Result;
use crate::models::diff::{get_image_type, is_image_file};
use crate::models::{DiffFile, DiffHunk, DiffLine, DiffLineOrigin, FileStatus};

/// Apply whitespace and algorithm options to a git2::DiffOptions
fn apply_diff_options(
    opts: &mut git2::DiffOptions,
    ignore_whitespace: &Option<String>,
    context_lines: Option<u32>,
    patience: Option<bool>,
    histogram: Option<bool>,
) {
    // Apply whitespace mode
    if let Some(ref ws_mode) = ignore_whitespace {
        match ws_mode.as_str() {
            "all" => {
                opts.ignore_whitespace(true);
            }
            "change" => {
                opts.ignore_whitespace_change(true);
            }
            "eol" => {
                opts.ignore_whitespace_eol(true);
            }
            // "none" or unknown: do nothing (default behavior)
            _ => {}
        }
    }

    // Apply context lines
    if let Some(lines) = context_lines {
        opts.context_lines(lines);
    }

    // Apply diff algorithm
    if patience.unwrap_or(false) {
        opts.patience(true);
    } else if histogram.unwrap_or(false) {
        // git2 does not have a direct histogram() method, but minimal diff
        // is the closest available. Use patience as the advanced option.
        // In practice, git2's libgit2 supports patience but not histogram directly.
        opts.minimal(true);
    }
}

/// Resolve the HEAD tree, tolerating an unborn HEAD (a repository with no
/// commits yet). Returns `None` when HEAD is unborn/missing so callers can diff
/// against the empty tree, exactly as `git diff --cached` does before the first
/// commit.
fn head_tree_opt(repo: &git2::Repository) -> Result<Option<git2::Tree<'_>>> {
    match repo.head() {
        Ok(head) => Ok(Some(head.peel_to_tree()?)),
        Err(e)
            if e.code() == git2::ErrorCode::UnbornBranch
                || e.code() == git2::ErrorCode::NotFound =>
        {
            Ok(None)
        }
        Err(e) => Err(e.into()),
    }
}

/// Enable rename detection on a diff, mirroring git's default `diff.renames`
/// (on by default since git 2.9). Without this, libgit2 reports a rename as a
/// delete + add pair and never yields `Delta::Renamed`.
fn detect_renames(diff: &mut git2::Diff) -> Result<()> {
    let mut find_opts = git2::DiffFindOptions::new();
    find_opts.renames(true);
    diff.find_similar(Some(&mut find_opts))?;
    Ok(())
}

// NOTE: git's binary detection is now reported faithfully. The former
// `is_known_text_extension` override faked `is_binary = false` for
// text-extension files that libgit2 flagged binary (e.g. UTF-16 JSON),
// which produced an empty, non-binary diff with no indication.

/// Get diff for all changed files
#[command]
pub async fn get_diff(
    path: String,
    staged: Option<bool>,
    commit: Option<String>,
    compare_with: Option<String>,
) -> Result<Vec<DiffFile>> {
    let repo = git2::Repository::open(Path::new(&path))?;

    let mut diff = if let Some(ref commit_oid) = commit {
        // Diff between two commits or commit and parent
        let commit = repo.find_commit(git2::Oid::from_str(commit_oid)?)?;

        if let Some(ref compare_oid) = compare_with {
            let compare_commit = repo.find_commit(git2::Oid::from_str(compare_oid)?)?;
            repo.diff_tree_to_tree(Some(&compare_commit.tree()?), Some(&commit.tree()?), None)?
        } else {
            let parent = commit.parent(0).ok();
            let parent_tree = parent.as_ref().map(|p| p.tree()).transpose()?;
            repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit.tree()?), None)?
        }
    } else if staged.unwrap_or(false) {
        // Staged changes (index vs HEAD, or the empty tree on an unborn HEAD)
        let head_tree = head_tree_opt(&repo)?;
        repo.diff_tree_to_index(head_tree.as_ref(), None, None)?
    } else {
        // Unstaged changes (working directory vs index)
        repo.diff_index_to_workdir(None, None)?
    };

    // Detect renames/copies (git's default) so a move is one entry, not add+del.
    detect_renames(&mut diff)?;

    parse_diff(&diff)
}

/// Get diff with advanced options (whitespace handling, context lines, algorithm)
///
/// This is a more flexible version of `get_diff` that supports:
/// - Whitespace handling: "all" (-w), "change" (-b), "eol" (--ignore-space-at-eol), "none"
/// - Custom context lines (default: 3)
/// - Diff algorithm selection: patience or minimal (histogram approximation)
/// - Optional file path filter
/// - Word-level diff (returns word-granularity changes in line content)
#[command]
#[allow(clippy::too_many_arguments)]
pub async fn get_diff_with_options(
    path: String,
    file_path: Option<String>,
    staged: Option<bool>,
    commit: Option<String>,
    compare_with: Option<String>,
    context_lines: Option<u32>,
    ignore_whitespace: Option<String>,
    patience: Option<bool>,
    histogram: Option<bool>,
    max_lines: Option<u32>,
) -> Result<Vec<DiffFile>> {
    let repo = git2::Repository::open(Path::new(&path))?;

    let mut opts = git2::DiffOptions::new();

    // Apply file path filter if specified
    if let Some(ref fp) = file_path {
        let normalized = fp.replace('\\', "/");
        opts.pathspec(&normalized);
    }

    // Apply whitespace, context, and algorithm options
    apply_diff_options(
        &mut opts,
        &ignore_whitespace,
        context_lines,
        patience,
        histogram,
    );

    // Include untracked files for working directory diffs
    if commit.is_none() {
        opts.include_untracked(true);
        opts.recurse_untracked_dirs(true);
        opts.show_untracked_content(true);
    }

    let mut diff = if let Some(ref commit_oid) = commit {
        // Diff between two commits or commit and parent
        let commit_obj = repo.find_commit(git2::Oid::from_str(commit_oid)?)?;

        if let Some(ref compare_oid) = compare_with {
            let compare_commit = repo.find_commit(git2::Oid::from_str(compare_oid)?)?;
            repo.diff_tree_to_tree(
                Some(&compare_commit.tree()?),
                Some(&commit_obj.tree()?),
                Some(&mut opts),
            )?
        } else {
            let parent = commit_obj.parent(0).ok();
            let parent_tree = parent.as_ref().map(|p| p.tree()).transpose()?;
            repo.diff_tree_to_tree(
                parent_tree.as_ref(),
                Some(&commit_obj.tree()?),
                Some(&mut opts),
            )?
        }
    } else if staged.unwrap_or(false) {
        // Staged changes (index vs HEAD, or the empty tree on an unborn HEAD)
        let head_tree = head_tree_opt(&repo)?;
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))?
    } else {
        // Unstaged changes (working directory vs index)
        repo.diff_index_to_workdir(None, Some(&mut opts))?
    };

    detect_renames(&mut diff)?;

    let files = parse_diff(&diff)?;
    Ok(files
        .into_iter()
        .map(|f| maybe_truncate_diff(f, max_lines))
        .collect())
}

/// Get diff for a specific file
#[command]
pub async fn get_file_diff(
    path: String,
    file_path: String,
    staged: Option<bool>,
    max_lines: Option<u32>,
) -> Result<DiffFile> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Normalize path separators for git (always use forward slashes)
    let normalized_file_path = file_path.replace('\\', "/");

    let mut opts = git2::DiffOptions::new();
    opts.pathspec(&normalized_file_path);
    // Include untracked files so we can show diff for new files
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);
    opts.show_untracked_content(true);

    let is_staged = staged.unwrap_or(false);

    let mut diff = if is_staged {
        // Staged changes: compare HEAD to index (empty tree on an unborn HEAD)
        let head_tree = head_tree_opt(&repo)?;
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))?
    } else {
        // Unstaged changes: compare index to workdir
        repo.diff_index_to_workdir(None, Some(&mut opts))?
    };

    detect_renames(&mut diff)?;

    let files = parse_diff(&diff)?;

    // If we found the file, return it
    // pathspec should have filtered to just our file, but it may be empty
    // if case-sensitivity caused a mismatch
    if let Some(file) = files.into_iter().next() {
        return Ok(maybe_truncate_diff(file, max_lines));
    }

    // Fallback: pathspec may have failed due to case sensitivity on Windows
    // Try getting full diff and finding the file with case-insensitive match
    let mut fallback_opts = git2::DiffOptions::new();
    fallback_opts.include_untracked(true);
    fallback_opts.recurse_untracked_dirs(true);
    fallback_opts.show_untracked_content(true);

    let mut fallback_diff = if is_staged {
        let head_tree = head_tree_opt(&repo)?;
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut fallback_opts))?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut fallback_opts))?
    };

    detect_renames(&mut fallback_diff)?;

    let all_files = parse_diff(&fallback_diff)?;

    // Try exact match first
    if let Some(file) = all_files.iter().find(|f| f.path == normalized_file_path) {
        return Ok(maybe_truncate_diff(file.clone(), max_lines));
    }

    // Try case-insensitive match (handles case-sensitivity mismatches on
    // Windows). We deliberately do NOT fall back to a filename-suffix match or
    // to the opposite staging area: `git diff [--cached] -- <path>` is strict
    // about the path and never substitutes a different file's diff. Doing so
    // here previously returned an unrelated file (e.g. vendor/foo.c for a
    // request of src/foo.c) or presented staged hunks as unstaged.
    if let Some(file) = all_files
        .iter()
        .find(|f| f.path.eq_ignore_ascii_case(&normalized_file_path))
    {
        return Ok(maybe_truncate_diff(file.clone(), max_lines));
    }

    // Log available files for debugging
    let available_paths: Vec<&str> = all_files.iter().map(|f| f.path.as_str()).collect();
    tracing::warn!(
        "File '{}' not found in diff. Staged: {}. Available files ({}):\n{}",
        normalized_file_path,
        is_staged,
        available_paths.len(),
        available_paths.join("\n")
    );

    // File not found in diff - it might be untracked or have no changes
    // Try to read the file and generate a synthetic diff for new/untracked files
    let full_path = validate_path_within_repo(Path::new(&path), &normalized_file_path)?;
    if full_path.exists() {
        // Check if file is untracked
        let statuses = repo.statuses(Some(
            git2::StatusOptions::new()
                .pathspec(&normalized_file_path)
                .include_untracked(true)
                .recurse_untracked_dirs(true),
        ))?;

        for entry in statuses.iter() {
            if let Ok(entry_path) = entry.path() {
                let normalized_entry_path = entry_path.replace('\\', "/");
                // Case-insensitive comparison on Windows
                #[cfg(target_os = "windows")]
                let paths_match = normalized_entry_path.eq_ignore_ascii_case(&normalized_file_path);
                #[cfg(not(target_os = "windows"))]
                let paths_match = normalized_entry_path == normalized_file_path;

                if paths_match {
                    let status = entry.status();
                    if status.is_wt_new() || status.is_index_new() {
                        // It's a new/untracked file - generate diff from file content
                        return generate_new_file_diff(&full_path, &normalized_file_path)
                            .map(|f| maybe_truncate_diff(f, max_lines));
                    }
                }
            }
        }
    }

    // If we get here, the file might have changes that git considers empty
    // (e.g., only whitespace/line-ending changes being ignored)
    // Include debug info in error message for troubleshooting
    let sample_paths: String = available_paths
        .iter()
        .take(10)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let suffix = if available_paths.len() > 10 {
        format!("... and {} more", available_paths.len() - 10)
    } else {
        String::new()
    };
    Err(crate::error::GitnadoError::OperationFailed(format!(
        "File '{}' not found in diff. Staged: {}. Found {} files: [{}{}]",
        normalized_file_path,
        is_staged,
        available_paths.len(),
        sample_paths,
        suffix
    )))
}

/// Generate a diff for a new/untracked file (entire content as additions)
fn generate_new_file_diff(full_path: &Path, file_path: &str) -> Result<DiffFile> {
    let content = std::fs::read_to_string(full_path).map_err(|e| {
        crate::error::GitnadoError::OperationFailed(format!("Failed to read file: {}", e))
    })?;

    let lines: Vec<DiffLine> = content
        .lines()
        .enumerate()
        .map(|(i, line)| DiffLine {
            origin: DiffLineOrigin::Addition,
            content: line.to_string(),
            old_line_no: None,
            new_line_no: Some((i + 1) as u32),
        })
        .collect();

    let additions = lines.len();

    let hunk = DiffHunk {
        header: format!("@@ -0,0 +1,{} @@", additions),
        old_start: 0,
        old_lines: 0,
        new_start: 1,
        new_lines: additions as u32,
        lines,
    };

    let is_image = is_image_file(file_path);
    let image_type = get_image_type(file_path);

    Ok(DiffFile {
        path: file_path.to_string(),
        old_path: None,
        status: FileStatus::New,
        hunks: vec![hunk],
        is_binary: false,
        is_image,
        image_type,
        additions,
        deletions: 0,
        truncated: None,
        total_lines: None,
    })
}

fn maybe_truncate_diff(mut file: DiffFile, max_lines: Option<u32>) -> DiffFile {
    let max_lines = match max_lines {
        Some(m) if m > 0 => m as usize,
        _ => return file,
    };
    let total: usize = file.hunks.iter().map(|h| h.lines.len()).sum();
    if total <= max_lines {
        return file;
    }
    // Truncate at HUNK boundaries only. A hunk is all-or-nothing: including a
    // partial hunk would leave its `@@ -a,b +c,d @@` header describing more
    // lines than the body actually contains, which git rejects as a "corrupt
    // patch" when the user tries to stage that hunk. Include only hunks that
    // fit completely; stop at the first hunk that doesn't. (If even the first
    // hunk exceeds the cap, we keep zero hunks and flag truncated — the UI
    // offers a "Load full diff" affordance for that case.)
    let mut remaining = max_lines;
    let mut kept_hunks = Vec::new();
    for hunk in file.hunks.drain(..) {
        if hunk.lines.len() > remaining {
            break;
        }
        remaining -= hunk.lines.len();
        kept_hunks.push(hunk);
    }
    file.hunks = kept_hunks;
    file.truncated = Some(true);
    file.total_lines = Some(total);
    file
}

fn parse_diff(diff: &git2::Diff) -> Result<Vec<DiffFile>> {
    let mut files: Vec<DiffFile> = Vec::new();

    diff.print(git2::DiffFormat::Patch, |delta, hunk, line| {
        let file_path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        // Find or create file entry
        let file_entry = if let Some(entry) = files.iter_mut().find(|f| f.path == file_path) {
            entry
        } else {
            let status = match delta.status() {
                git2::Delta::Added => FileStatus::New,
                git2::Delta::Deleted => FileStatus::Deleted,
                git2::Delta::Modified => FileStatus::Modified,
                git2::Delta::Renamed => FileStatus::Renamed,
                git2::Delta::Copied => FileStatus::Copied,
                git2::Delta::Typechange => FileStatus::Typechange,
                _ => FileStatus::Modified,
            };

            let is_image = is_image_file(&file_path);
            let image_type = get_image_type(&file_path);
            // Report git's binary status faithfully. libgit2 may only set the
            // binary flag on a later callback (after inspecting the blob), so
            // this is refreshed below for existing entries too.
            let is_binary = delta.flags().is_binary();

            files.push(DiffFile {
                path: file_path.clone(),
                old_path: delta
                    .old_file()
                    .path()
                    .map(|p| p.to_string_lossy().to_string()),
                status,
                hunks: Vec::new(),
                is_binary,
                is_image,
                image_type,
                additions: 0,
                deletions: 0,
                truncated: None,
                total_lines: None,
            });

            files
                .last_mut()
                .expect("files vec must be non-empty after push")
        };

        // The binary flag may only be raised on a later callback for this
        // file (once libgit2 has loaded the blob), so keep it current. This
        // prevents a binary file from being rendered as an empty text diff.
        if delta.flags().is_binary() {
            file_entry.is_binary = true;
        }

        // Handle hunk header
        if let Some(hunk) = hunk {
            let header = String::from_utf8_lossy(hunk.header()).to_string();

            // Check if this hunk already exists
            let hunk_exists = file_entry.hunks.iter().any(|h| h.header == header);

            if !hunk_exists {
                file_entry.hunks.push(DiffHunk {
                    header,
                    old_start: hunk.old_start(),
                    old_lines: hunk.old_lines(),
                    new_start: hunk.new_start(),
                    new_lines: hunk.new_lines(),
                    lines: Vec::new(),
                });
            }
        }

        // Handle line
        let origin = line.origin();
        let content = String::from_utf8_lossy(line.content()).to_string();

        let line_origin = DiffLineOrigin::from(origin);

        match origin {
            '+' => file_entry.additions += 1,
            '-' => file_entry.deletions += 1,
            _ => {}
        }

        if let Some(hunk) = file_entry.hunks.last_mut() {
            hunk.lines.push(DiffLine {
                content,
                origin: line_origin,
                old_line_no: line.old_lineno(),
                new_line_no: line.new_lineno(),
            });
        }

        true
    })?;

    Ok(files)
}

/// A file entry in a commit (simplified, without diff hunks)
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileEntry {
    pub path: String,
    /// For a renamed/copied file, the previous path; `None` otherwise.
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub additions: usize,
    pub deletions: usize,
}

/// Get list of files changed in a commit
#[command]
pub async fn get_commit_files(path: String, commit_oid: String) -> Result<Vec<CommitFileEntry>> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let commit = repo.find_commit(git2::Oid::from_str(&commit_oid)?)?;

    let parent = commit.parent(0).ok();
    let parent_tree = parent.as_ref().map(|p| p.tree()).transpose()?;
    let commit_tree = commit.tree()?;

    let mut diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)?;

    // Detect renames/copies (git's default) so a moved file is a single
    // "renamed" entry instead of a delete + add pair.
    detect_renames(&mut diff)?;

    // First pass: collect file info
    let mut files: Vec<CommitFileEntry> = Vec::new();
    for delta in diff.deltas() {
        let file_path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let status = match delta.status() {
            git2::Delta::Added => FileStatus::New,
            git2::Delta::Deleted => FileStatus::Deleted,
            git2::Delta::Modified => FileStatus::Modified,
            git2::Delta::Renamed => FileStatus::Renamed,
            git2::Delta::Copied => FileStatus::Copied,
            git2::Delta::Typechange => FileStatus::Typechange,
            _ => FileStatus::Modified,
        };

        // Surface the previous path for renames/copies so the UI can show it.
        let old_path = match delta.status() {
            git2::Delta::Renamed | git2::Delta::Copied => delta
                .old_file()
                .path()
                .map(|p| p.to_string_lossy().to_string()),
            _ => None,
        };

        files.push(CommitFileEntry {
            path: file_path,
            old_path,
            status,
            additions: 0,
            deletions: 0,
        });
    }

    // Second pass: count additions/deletions
    let stats = diff.stats()?;
    for i in 0..stats.files_changed() {
        if i < files.len() {
            // Get stats for this file from the diff
            if let Some(patch) = git2::Patch::from_diff(&diff, i).ok().flatten() {
                let (_, additions, deletions) = patch.line_stats()?;
                files[i].additions = additions;
                files[i].deletions = deletions;
            }
        }
    }

    Ok(files)
}

/// Stats for a single commit
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitStats {
    pub oid: String,
    pub additions: usize,
    pub deletions: usize,
    pub files_changed: usize,
}

/// Get stats (additions/deletions) for multiple commits in bulk
/// This is optimized for the graph view to show commit sizes
#[command]
pub async fn get_commits_stats(path: String, commit_oids: Vec<String>) -> Result<Vec<CommitStats>> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let mut results = Vec::with_capacity(commit_oids.len());
    let mut skipped_oid_parse = 0;
    let mut skipped_commit_find = 0;
    let mut skipped_tree = 0;
    let mut skipped_diff = 0;
    let mut skipped_stats = 0;
    let mut zero_stats = 0;

    for oid_str in &commit_oids {
        let oid = match git2::Oid::from_str(oid_str) {
            Ok(o) => o,
            Err(_) => {
                skipped_oid_parse += 1;
                continue;
            }
        };

        let commit = match repo.find_commit(oid) {
            Ok(c) => c,
            Err(_) => {
                skipped_commit_find += 1;
                continue;
            }
        };

        let parent = commit.parent(0).ok();
        let parent_tree = parent.as_ref().and_then(|p| p.tree().ok());
        let commit_tree = match commit.tree() {
            Ok(t) => t,
            Err(_) => {
                skipped_tree += 1;
                continue;
            }
        };

        let mut diff = match repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)
        {
            Ok(d) => d,
            Err(_) => {
                skipped_diff += 1;
                continue;
            }
        };

        // Detect renames so a pure rename reports 0/0 like git, rather than
        // over-counting the full file as +N/-N (delete + add).
        if detect_renames(&mut diff).is_err() {
            skipped_diff += 1;
            continue;
        }

        let (additions, deletions, files_changed) = match diff.stats() {
            Ok(s) => (s.insertions(), s.deletions(), s.files_changed()),
            Err(e) => {
                // Stats can fail for binary-only diffs or very large diffs
                // Return 0/0/0 instead of skipping to avoid missing commits
                tracing::debug!("get_commits_stats: stats failed for {}: {}", oid_str, e);
                skipped_stats += 1;
                (0, 0, 0)
            }
        };

        // Track commits with zero stats (may be merge commits or empty commits)
        if additions == 0 && deletions == 0 && files_changed == 0 {
            zero_stats += 1;
        }

        results.push(CommitStats {
            oid: oid_str.clone(),
            additions,
            deletions,
            files_changed,
        });
    }

    let total_skipped =
        skipped_oid_parse + skipped_commit_find + skipped_tree + skipped_diff + skipped_stats;
    if total_skipped > 0 || zero_stats > 0 {
        tracing::warn!(
            "get_commits_stats: processed {}/{} commits for {}. Skipped: oid_parse={}, commit_find={}, tree={}, diff={}, stats={}. Zero stats: {}",
            results.len(),
            commit_oids.len(),
            path,
            skipped_oid_parse,
            skipped_commit_find,
            skipped_tree,
            skipped_diff,
            skipped_stats,
            zero_stats
        );
    }

    Ok(results)
}

/// Get diff for a specific file in a commit
#[command]
pub async fn get_commit_file_diff(
    path: String,
    commit_oid: String,
    file_path: String,
    max_lines: Option<u32>,
) -> Result<DiffFile> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let commit = repo.find_commit(git2::Oid::from_str(&commit_oid)?)?;

    let parent = commit.parent(0).ok();
    let parent_tree = parent.as_ref().map(|p| p.tree()).transpose()?;
    let commit_tree = commit.tree()?;

    // Normalize path separators for git (always use forward slashes)
    let normalized_file_path = file_path.replace('\\', "/");

    let mut opts = git2::DiffOptions::new();
    opts.pathspec(&normalized_file_path);

    let mut diff =
        repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), Some(&mut opts))?;

    detect_renames(&mut diff)?;

    let filtered = parse_diff(&diff)?.into_iter().next();

    // The two halves of a rename live at different paths, so the pathspec above
    // keeps only one of them and `find_similar` has nothing left to pair it
    // with: the file comes back as a whole-file add (or delete). Re-diff the
    // whole tree, where both halves are present, and pick our file out of the
    // rename-aware result — the same view the file list gets from
    // `get_commit_files`. Only those two statuses can be half of a rename, so
    // every other file still costs a single path-filtered diff.
    //
    // A root commit has no parent tree, so its diff holds nothing but `Added`
    // deltas; a rename needs a deleted side, and `detect_renames` does not
    // enable copy detection, so no `Renamed`/`Copied` delta can exist. Skip the
    // whole fallback there rather than re-diffing the largest tree in the repo
    // only to hand back what `filtered` already holds.
    if parent_tree.is_some()
        && filtered
            .as_ref()
            .is_some_and(|f| matches!(f.status, FileStatus::New | FileStatus::Deleted))
    {
        let mut full_diff =
            repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)?;
        detect_renames(&mut full_diff)?;

        // Decide from delta metadata alone. `deltas()` walks the delta list
        // without generating a patch, whereas `parse_diff` prints every hunk of
        // every file in the commit — so resolving one path used to cost a full
        // render of the whole commit, which `max_lines` (applied only after the
        // parse) could not bound.
        //
        // libgit2 reports the new path in `old_file()` for a plain addition, so
        // the old-path match must stay gated on Renamed/Copied or unrelated
        // added files would match it. Prefer a delta owning this path as its
        // new path: only when that delta is itself a rename/copy, or no such
        // delta exists, does the old-path side apply.
        let target = normalized_file_path.as_str();
        let rename_paths = full_diff
            .deltas()
            .find(|delta| {
                delta
                    .new_file()
                    .path()
                    .map(|p| p.to_string_lossy())
                    .as_deref()
                    == Some(target)
            })
            .filter(|delta| matches!(delta.status(), git2::Delta::Renamed | git2::Delta::Copied))
            .or_else(|| {
                full_diff.deltas().find(|delta| {
                    matches!(delta.status(), git2::Delta::Renamed | git2::Delta::Copied)
                        && delta
                            .old_file()
                            .path()
                            .map(|p| p.to_string_lossy())
                            .as_deref()
                            == Some(target)
                })
            })
            .and_then(|delta| {
                let old_path = delta.old_file().path()?.to_string_lossy().into_owned();
                let new_path = delta.new_file().path()?.to_string_lossy().into_owned();
                Some((old_path, new_path))
            });

        // Both halves of the pair are in this diff, so `find_similar` can still
        // match them, but the patch we render is bounded to the one file.
        if let Some((old_path, new_path)) = rename_paths {
            let mut pair_opts = git2::DiffOptions::new();
            pair_opts.pathspec(&old_path);
            pair_opts.pathspec(&new_path);
            let mut pair_diff = repo.diff_tree_to_tree(
                parent_tree.as_ref(),
                Some(&commit_tree),
                Some(&mut pair_opts),
            )?;
            detect_renames(&mut pair_diff)?;

            let matched = parse_diff(&pair_diff)?.into_iter().find(|f| {
                f.path == normalized_file_path
                    || (matches!(f.status, FileStatus::Renamed | FileStatus::Copied)
                        && f.old_path.as_deref() == Some(target))
            });
            if let Some(found) = matched {
                return Ok(maybe_truncate_diff(found, max_lines));
            }
        }
    }

    filtered
        .map(|f| maybe_truncate_diff(f, max_lines))
        .ok_or_else(|| {
            crate::error::GitnadoError::OperationFailed("File not found in commit".to_string())
        })
}

/// A single line of blame output
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line_number: usize,
    pub content: String,
    pub commit_oid: String,
    pub commit_short_id: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub summary: String,
    pub is_boundary: bool,
}

/// Blame result for a file
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameResult {
    pub path: String,
    pub lines: Vec<BlameLine>,
    pub total_lines: u32,
}

/// Get blame information for a file
///
/// # Arguments
/// * `path` - Repository path
/// * `file_path` - Path to the file to blame
/// * `commit_oid` - Optional commit to blame at (default: HEAD)
/// * `start_line` - Optional start line for range blame (1-indexed)
/// * `end_line` - Optional end line for range blame (1-indexed, inclusive)
#[command]
pub async fn get_file_blame(
    path: String,
    file_path: String,
    commit_oid: Option<String>,
    start_line: Option<u32>,
    end_line: Option<u32>,
) -> Result<BlameResult> {
    let repo = git2::Repository::open(Path::new(&path))?;

    let mut blame_opts = git2::BlameOptions::new();

    // If a specific commit is provided, blame up to that commit
    if let Some(ref oid_str) = commit_oid {
        let oid = git2::Oid::from_str(oid_str)?;
        blame_opts.newest_commit(oid);
    }

    // Apply line range if provided (git2 uses 1-indexed lines)
    if let Some(start) = start_line {
        blame_opts.min_line(start as usize);
    }
    if let Some(end) = end_line {
        blame_opts.max_line(end as usize);
    }

    let blame = repo.blame_file(Path::new(&file_path), Some(&mut blame_opts))?;

    // Read the file content
    let file_content = if let Some(ref oid_str) = commit_oid {
        // Read from specific commit
        let commit = repo.find_commit(git2::Oid::from_str(oid_str)?)?;
        let tree = commit.tree()?;
        let entry = tree.get_path(Path::new(&file_path))?;
        let blob = repo.find_blob(entry.id())?;
        String::from_utf8_lossy(blob.content()).to_string()
    } else {
        // Read from working directory
        let full_path = validate_path_within_repo(Path::new(&path), &file_path)?;
        std::fs::read_to_string(full_path).unwrap_or_default()
    };

    // For a working-tree blame (no explicit commit), libgit2 blamed the file
    // as of HEAD, which misaligns with a modified working copy. Reconcile the
    // committed blame with the actual working-tree buffer so inserted/deleted
    // lines stay aligned and uncommitted lines are attributed to the zero OID
    // (git's "Not Committed Yet"). libgit2 has no direct working-tree blame.
    let buffer_blame = if commit_oid.is_none() {
        Some(blame.blame_buffer(file_content.as_bytes())?)
    } else {
        None
    };
    let active_blame = buffer_blame.as_ref().unwrap_or(&blame);

    let content_lines: Vec<&str> = file_content.lines().collect();
    let total_lines = content_lines.len() as u32;

    // Determine the line range to process
    let start_idx = start_line
        .map(|l| (l as usize).saturating_sub(1))
        .unwrap_or(0);
    let end_idx = end_line
        .map(|l| (l as usize).min(content_lines.len()))
        .unwrap_or(content_lines.len());

    let mut lines = Vec::new();

    for (i, line_content) in content_lines
        .iter()
        .enumerate()
        .skip(start_idx)
        .take(end_idx - start_idx)
    {
        let line_num = i + 1;

        if let Some(hunk) = active_blame.get_line(line_num) {
            let commit_id = hunk.final_commit_id();
            let short_id = commit_id.to_string()[..7].to_string();

            // A zero OID means the line differs from HEAD, i.e. it is not yet
            // committed (git shows "Not Committed Yet").
            if commit_id.is_zero() {
                lines.push(BlameLine {
                    line_number: line_num,
                    content: line_content.to_string(),
                    commit_oid: commit_id.to_string(),
                    commit_short_id: short_id,
                    author_name: "Not Committed Yet".to_string(),
                    author_email: String::new(),
                    timestamp: 0,
                    summary: String::new(),
                    is_boundary: hunk.is_boundary(),
                });
                continue;
            }

            // Get commit details
            let (author_name, author_email, timestamp, summary) =
                if let Ok(commit) = repo.find_commit(commit_id) {
                    let author = commit.author();
                    (
                        author.name().unwrap_or("Unknown").to_string(),
                        author.email().unwrap_or("").to_string(),
                        author.when().seconds(),
                        commit.summary().ok().flatten().unwrap_or("").to_string(),
                    )
                } else {
                    ("Unknown".to_string(), "".to_string(), 0, "".to_string())
                };

            lines.push(BlameLine {
                line_number: line_num,
                content: line_content.to_string(),
                commit_oid: commit_id.to_string(),
                commit_short_id: short_id,
                author_name,
                author_email,
                timestamp,
                summary,
                is_boundary: hunk.is_boundary(),
            });
        }
    }

    Ok(BlameResult {
        path: file_path,
        lines,
        total_lines,
    })
}

/// Image version data for comparison
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageVersions {
    pub path: String,
    pub old_data: Option<String>,
    pub new_data: Option<String>,
    pub old_size: Option<(u32, u32)>,
    pub new_size: Option<(u32, u32)>,
    pub image_type: Option<String>,
}

/// Get base64-encoded image data for old and new versions of a file
#[command]
pub async fn get_image_versions(
    path: String,
    file_path: String,
    staged: Option<bool>,
    commit_oid: Option<String>,
) -> Result<ImageVersions> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let is_staged = staged.unwrap_or(false);

    let image_type = get_image_type(&file_path);

    // Get old version (from HEAD or parent commit)
    let old_data = if let Some(ref oid_str) = commit_oid {
        // For commit diff, get from parent
        let commit = repo.find_commit(git2::Oid::from_str(oid_str)?)?;
        if let Ok(parent) = commit.parent(0) {
            get_blob_base64(&repo, &parent.tree()?, &file_path)
        } else {
            None
        }
    } else if is_staged {
        // For staged changes, old is from HEAD
        if let Ok(head) = repo.head() {
            if let Ok(tree) = head.peel_to_tree() {
                get_blob_base64(&repo, &tree, &file_path)
            } else {
                None
            }
        } else {
            None
        }
    } else {
        // For unstaged changes, old is from index
        if let Ok(index) = repo.index() {
            if let Some(entry) = index.get_path(Path::new(&file_path), 0) {
                if let Ok(blob) = repo.find_blob(entry.id) {
                    Some(STANDARD.encode(blob.content()))
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        }
    };

    // Get new version
    let new_data = if let Some(ref oid_str) = commit_oid {
        // For commit diff, get from commit tree
        let commit = repo.find_commit(git2::Oid::from_str(oid_str)?)?;
        get_blob_base64(&repo, &commit.tree()?, &file_path)
    } else if is_staged {
        // The staged diff is HEAD vs INDEX, so "after" is the index blob — not
        // the file on disk.
        //
        // Reading from disk meant that staging an image and then editing it
        // again showed the newer worktree pixels as the staged content: the user
        // commits believing the image on screen is what will be committed, and
        // it is not. The text path (diff_tree_to_index) reads the index, so the
        // image view also contradicted the text view for the same file.
        repo.index()
            .ok()
            .and_then(|index| index.get_path(Path::new(&file_path), 0))
            .and_then(|entry| repo.find_blob(entry.id).ok())
            .map(|blob| STANDARD.encode(blob.content()))
    } else {
        // For working directory changes, read from disk
        let full_path = validate_path_within_repo(Path::new(&path), &file_path)?;
        if full_path.exists() {
            std::fs::read(&full_path)
                .ok()
                .map(|data| STANDARD.encode(&data))
        } else {
            None
        }
    };

    Ok(ImageVersions {
        path: file_path,
        old_data,
        new_data,
        old_size: None, // Size detection would require image parsing
        new_size: None,
        image_type,
    })
}

/// Get base64-encoded blob content from a tree
fn get_blob_base64(repo: &git2::Repository, tree: &git2::Tree, file_path: &str) -> Option<String> {
    let entry = tree.get_path(Path::new(file_path)).ok()?;
    let blob = repo.find_blob(entry.id()).ok()?;
    Some(STANDARD.encode(blob.content()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    /// The staged image diff must show the INDEX blob, not the file on disk.
    ///
    /// The staged diff is HEAD vs index. Reading "after" from disk meant that
    /// staging an image and then editing it again displayed the newer worktree
    /// pixels as the staged content — the user commits believing the image on
    /// screen is what will be committed, and it is not. The text path
    /// (diff_tree_to_index) reads the index, so the image view also contradicted
    /// the text view for the same file.
    #[tokio::test]
    async fn test_staged_image_diff_shows_the_index_blob() {
        // PNG magic bytes are enough: nothing here parses the image.
        const COMMITTED: &[u8] = b"\x89PNG\r\n\x1a\ncommitted-pixels";
        const STAGED: &[u8] = b"\x89PNG\r\n\x1a\nstaged-pixels";
        const WORKTREE: &[u8] = b"\x89PNG\r\n\x1a\nworktree-pixels-newer";

        let repo = TestRepo::with_initial_commit();
        let img = repo.path.join("logo.png");

        std::fs::write(&img, COMMITTED).unwrap();
        repo.stage_file("logo.png");
        repo.create_commit("Add image", &[]);

        // Stage a second version, then keep editing the file on disk.
        std::fs::write(&img, STAGED).unwrap();
        repo.stage_file("logo.png");
        std::fs::write(&img, WORKTREE).unwrap();

        let staged_view =
            get_image_versions(repo.path_str(), "logo.png".to_string(), Some(true), None)
                .await
                .unwrap();

        let decode = |b64: &Option<String>| {
            use base64::Engine;
            STANDARD.decode(b64.as_ref().expect("image data")).unwrap()
        };

        assert_eq!(
            decode(&staged_view.new_data),
            STAGED,
            "staged 'after' must be the index blob, not the newer worktree file"
        );
        assert_eq!(
            decode(&staged_view.old_data),
            COMMITTED,
            "staged 'before' is the committed blob"
        );

        // The unstaged view is the mirror: index -> worktree.
        let unstaged_view =
            get_image_versions(repo.path_str(), "logo.png".to_string(), Some(false), None)
                .await
                .unwrap();

        assert_eq!(decode(&unstaged_view.old_data), STAGED);
        assert_eq!(
            decode(&unstaged_view.new_data),
            WORKTREE,
            "the unstaged view still reads the working tree"
        );
    }

    #[tokio::test]
    async fn test_get_diff_no_changes() {
        let repo = TestRepo::with_initial_commit();
        let result = get_diff(repo.path_str(), None, None, None).await;

        assert!(result.is_ok());
        let files = result.unwrap();
        assert!(files.is_empty());
    }

    #[tokio::test]
    async fn test_get_diff_unstaged_modification() {
        let repo = TestRepo::with_initial_commit();

        // Modify the README
        repo.create_file("README.md", "Modified content");

        let result = get_diff(repo.path_str(), Some(false), None, None).await;

        assert!(result.is_ok());
        let files = result.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "README.md");
        assert_eq!(files[0].status, FileStatus::Modified);
        assert!(files[0].additions > 0 || files[0].deletions > 0);
    }

    #[tokio::test]
    async fn test_get_diff_staged_changes() {
        let repo = TestRepo::with_initial_commit();

        // Create and stage a new file
        repo.create_file("new_file.txt", "New file content");
        repo.stage_file("new_file.txt");

        let result = get_diff(repo.path_str(), Some(true), None, None).await;

        assert!(result.is_ok());
        let files = result.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "new_file.txt");
        assert_eq!(files[0].status, FileStatus::New);
    }

    #[tokio::test]
    async fn test_get_diff_commit() {
        let repo = TestRepo::with_initial_commit();

        // Create a new commit
        let commit_oid = repo.create_commit("Second commit", &[("file.txt", "content")]);

        let result = get_diff(repo.path_str(), None, Some(commit_oid.to_string()), None).await;

        assert!(result.is_ok());
        let files = result.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "file.txt");
        assert_eq!(files[0].status, FileStatus::New);
    }

    #[tokio::test]
    async fn test_get_diff_between_commits() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid();

        repo.create_commit("Second commit", &[("file.txt", "content")]);
        let second_oid = repo.head_oid();

        let result = get_diff(
            repo.path_str(),
            None,
            Some(second_oid.to_string()),
            Some(first_oid.to_string()),
        )
        .await;

        assert!(result.is_ok());
        let files = result.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "file.txt");
    }

    #[tokio::test]
    async fn test_get_file_diff_unstaged() {
        let repo = TestRepo::with_initial_commit();

        // Modify the README
        repo.create_file("README.md", "Modified README content\nWith multiple lines");

        let result =
            get_file_diff(repo.path_str(), "README.md".to_string(), Some(false), None).await;

        assert!(result.is_ok());
        let diff_file = result.unwrap();
        assert_eq!(diff_file.path, "README.md");
        assert_eq!(diff_file.status, FileStatus::Modified);
        assert!(!diff_file.hunks.is_empty());
    }

    #[tokio::test]
    async fn test_get_file_diff_staged() {
        let repo = TestRepo::with_initial_commit();

        // Create and stage a new file
        repo.create_file("staged.txt", "Staged content\nLine 2\nLine 3");
        repo.stage_file("staged.txt");

        let result =
            get_file_diff(repo.path_str(), "staged.txt".to_string(), Some(true), None).await;

        assert!(result.is_ok());
        let diff_file = result.unwrap();
        assert_eq!(diff_file.path, "staged.txt");
        assert_eq!(diff_file.status, FileStatus::New);
        assert_eq!(diff_file.additions, 3);
        assert_eq!(diff_file.deletions, 0);
    }

    #[tokio::test]
    async fn test_get_file_diff_with_hunks() {
        let repo = TestRepo::with_initial_commit();

        // Modify the README with additions and deletions
        repo.create_file("README.md", "# Modified Repo\nNew line added");

        let result = get_file_diff(repo.path_str(), "README.md".to_string(), None, None).await;

        assert!(result.is_ok());
        let diff_file = result.unwrap();
        assert!(!diff_file.hunks.is_empty());

        let hunk = &diff_file.hunks[0];
        assert!(!hunk.header.is_empty());
        assert!(!hunk.lines.is_empty());
    }

    #[tokio::test]
    async fn test_get_commit_files() {
        let repo = TestRepo::with_initial_commit();

        // Create a commit with multiple files
        let commit_oid = repo.create_commit(
            "Multi-file commit",
            &[
                ("file1.txt", "content 1"),
                ("file2.txt", "content 2"),
                ("dir/file3.txt", "content 3"),
            ],
        );

        let result = get_commit_files(repo.path_str(), commit_oid.to_string()).await;

        assert!(result.is_ok());
        let files = result.unwrap();
        assert_eq!(files.len(), 3);

        // All files should be new
        for file in &files {
            assert_eq!(file.status, FileStatus::New);
        }
    }

    #[tokio::test]
    async fn test_get_commit_files_modification() {
        let repo = TestRepo::with_initial_commit();

        // Modify existing file
        let commit_oid = repo.create_commit("Modify README", &[("README.md", "Modified content")]);

        let result = get_commit_files(repo.path_str(), commit_oid.to_string()).await;

        assert!(result.is_ok());
        let files = result.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "README.md");
        assert_eq!(files[0].status, FileStatus::Modified);
    }

    #[tokio::test]
    async fn test_get_commit_file_diff() {
        let repo = TestRepo::with_initial_commit();

        // Create a commit with a specific file
        let commit_oid =
            repo.create_commit("Add file", &[("specific.txt", "Line 1\nLine 2\nLine 3")]);

        let result = get_commit_file_diff(
            repo.path_str(),
            commit_oid.to_string(),
            "specific.txt".to_string(),
            None,
        )
        .await;

        assert!(result.is_ok());
        let diff_file = result.unwrap();
        assert_eq!(diff_file.path, "specific.txt");
        assert_eq!(diff_file.status, FileStatus::New);
        assert_eq!(diff_file.additions, 3);
    }

    #[tokio::test]
    async fn test_get_commit_file_diff_not_found() {
        let repo = TestRepo::with_initial_commit();
        let commit_oid = repo.head_oid();

        let result = get_commit_file_diff(
            repo.path_str(),
            commit_oid.to_string(),
            "nonexistent.txt".to_string(),
            None,
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_file_blame() {
        let repo = TestRepo::with_initial_commit();

        let result =
            get_file_blame(repo.path_str(), "README.md".to_string(), None, None, None).await;

        assert!(result.is_ok());
        let blame_result = result.unwrap();
        assert_eq!(blame_result.path, "README.md");
        assert!(!blame_result.lines.is_empty());
        assert_eq!(blame_result.total_lines, 1);

        // Check first line has blame info
        let first_line = &blame_result.lines[0];
        assert_eq!(first_line.line_number, 1);
        assert_eq!(first_line.content, "# Test Repo");
        assert!(!first_line.commit_oid.is_empty());
        assert!(!first_line.commit_short_id.is_empty());
        assert_eq!(first_line.author_name, "Test User");
        assert_eq!(first_line.author_email, "test@example.com");
    }

    #[tokio::test]
    async fn test_get_file_blame_at_commit() {
        let repo = TestRepo::with_initial_commit();
        let initial_oid = repo.head_oid();

        // Modify the file
        repo.create_commit("Modify README", &[("README.md", "Modified content")]);

        // Blame at the initial commit
        let result = get_file_blame(
            repo.path_str(),
            "README.md".to_string(),
            Some(initial_oid.to_string()),
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
        let blame_result = result.unwrap();
        assert_eq!(blame_result.lines[0].content, "# Test Repo");
    }

    #[tokio::test]
    async fn test_get_file_blame_multiple_commits() {
        let repo = TestRepo::with_initial_commit();

        // Add more content
        repo.create_commit("Add line", &[("README.md", "# Test Repo\nSecond line")]);

        let result =
            get_file_blame(repo.path_str(), "README.md".to_string(), None, None, None).await;

        assert!(result.is_ok());
        let blame_result = result.unwrap();
        assert_eq!(blame_result.lines.len(), 2);
        assert_eq!(blame_result.total_lines, 2);
    }

    #[tokio::test]
    async fn test_get_file_blame_line_range() {
        let repo = TestRepo::with_initial_commit();

        // Create a file with multiple lines
        repo.create_commit(
            "Add multi-line file",
            &[("multiline.txt", "Line 1\nLine 2\nLine 3\nLine 4\nLine 5")],
        );

        // Blame lines 2-4
        let result = get_file_blame(
            repo.path_str(),
            "multiline.txt".to_string(),
            None,
            Some(2),
            Some(4),
        )
        .await;

        assert!(result.is_ok());
        let blame_result = result.unwrap();
        assert_eq!(blame_result.lines.len(), 3);
        assert_eq!(blame_result.total_lines, 5);
        assert_eq!(blame_result.lines[0].line_number, 2);
        assert_eq!(blame_result.lines[0].content, "Line 2");
        assert_eq!(blame_result.lines[2].line_number, 4);
        assert_eq!(blame_result.lines[2].content, "Line 4");
    }

    #[tokio::test]
    async fn test_get_file_blame_start_line_only() {
        let repo = TestRepo::with_initial_commit();

        // Create a file with multiple lines
        repo.create_commit(
            "Add multi-line file",
            &[("multiline.txt", "Line 1\nLine 2\nLine 3\nLine 4\nLine 5")],
        );

        // Blame from line 3 to end
        let result = get_file_blame(
            repo.path_str(),
            "multiline.txt".to_string(),
            None,
            Some(3),
            None,
        )
        .await;

        assert!(result.is_ok());
        let blame_result = result.unwrap();
        assert_eq!(blame_result.lines.len(), 3); // Lines 3, 4, 5
        assert_eq!(blame_result.total_lines, 5);
        assert_eq!(blame_result.lines[0].line_number, 3);
        assert_eq!(blame_result.lines[0].content, "Line 3");
    }

    #[tokio::test]
    async fn test_get_file_blame_end_line_only() {
        let repo = TestRepo::with_initial_commit();

        // Create a file with multiple lines
        repo.create_commit(
            "Add multi-line file",
            &[("multiline.txt", "Line 1\nLine 2\nLine 3\nLine 4\nLine 5")],
        );

        // Blame from start to line 3
        let result = get_file_blame(
            repo.path_str(),
            "multiline.txt".to_string(),
            None,
            None,
            Some(3),
        )
        .await;

        assert!(result.is_ok());
        let blame_result = result.unwrap();
        assert_eq!(blame_result.lines.len(), 3); // Lines 1, 2, 3
        assert_eq!(blame_result.total_lines, 5);
        assert_eq!(blame_result.lines[0].line_number, 1);
        assert_eq!(blame_result.lines[2].line_number, 3);
    }

    #[tokio::test]
    async fn test_get_file_blame_single_line() {
        let repo = TestRepo::with_initial_commit();

        // Create a file with multiple lines
        repo.create_commit(
            "Add multi-line file",
            &[("multiline.txt", "Line 1\nLine 2\nLine 3\nLine 4\nLine 5")],
        );

        // Blame only line 3
        let result = get_file_blame(
            repo.path_str(),
            "multiline.txt".to_string(),
            None,
            Some(3),
            Some(3),
        )
        .await;

        assert!(result.is_ok());
        let blame_result = result.unwrap();
        assert_eq!(blame_result.lines.len(), 1);
        assert_eq!(blame_result.total_lines, 5);
        assert_eq!(blame_result.lines[0].line_number, 3);
        assert_eq!(blame_result.lines[0].content, "Line 3");
    }

    #[tokio::test]
    async fn test_get_commits_stats() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid();

        let second_oid = repo.create_commit("Second", &[("file.txt", "content")]);
        let third_oid = repo.create_commit("Third", &[("another.txt", "more content")]);

        let result = get_commits_stats(
            repo.path_str(),
            vec![
                first_oid.to_string(),
                second_oid.to_string(),
                third_oid.to_string(),
            ],
        )
        .await;

        assert!(result.is_ok());
        let stats = result.unwrap();
        assert_eq!(stats.len(), 3);

        // Each commit should have stats
        for stat in &stats {
            assert!(!stat.oid.is_empty());
        }
    }

    #[tokio::test]
    async fn test_get_commits_stats_empty_list() {
        let repo = TestRepo::with_initial_commit();

        let result = get_commits_stats(repo.path_str(), vec![]).await;

        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_get_commits_stats_invalid_oid() {
        let repo = TestRepo::with_initial_commit();

        let result = get_commits_stats(repo.path_str(), vec!["invalid_oid".to_string()]).await;

        assert!(result.is_ok());
        // Invalid OIDs are skipped
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_diff_file_status_deleted() {
        let repo = TestRepo::with_initial_commit();

        // Delete the README and stage the deletion
        std::fs::remove_file(repo.path.join("README.md")).unwrap();
        let git_repo = repo.repo();
        let mut index = git_repo.index().unwrap();
        index
            .remove_path(std::path::Path::new("README.md"))
            .unwrap();
        index.write().unwrap();

        let result = get_diff(repo.path_str(), Some(true), None, None).await;

        assert!(result.is_ok());
        let files = result.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "README.md");
        assert_eq!(files[0].status, FileStatus::Deleted);
    }

    #[tokio::test]
    async fn test_get_diff_new_untracked_file() {
        let repo = TestRepo::with_initial_commit();

        // Create an untracked file
        repo.create_file("untracked.txt", "untracked content");

        // Get unstaged diff - should show the untracked file
        let result = get_diff(repo.path_str(), Some(false), None, None).await;

        assert!(result.is_ok());
        let _files = result.unwrap();
        // Untracked files may or may not appear in diff depending on options
        // The function includes untracked content
    }

    #[tokio::test]
    async fn test_get_file_diff_binary_detection() {
        let repo = TestRepo::with_initial_commit();

        // Create a text file with a known text extension
        repo.create_file("config.json", r#"{"key": "value"}"#);
        repo.stage_file("config.json");

        let result =
            get_file_diff(repo.path_str(), "config.json".to_string(), Some(true), None).await;

        assert!(result.is_ok());
        let diff_file = result.unwrap();
        assert!(!diff_file.is_binary);
    }

    #[tokio::test]
    async fn test_blame_line_structure() {
        let repo = TestRepo::with_initial_commit();

        let result =
            get_file_blame(repo.path_str(), "README.md".to_string(), None, None, None).await;

        assert!(result.is_ok());
        let blame_result = result.unwrap();

        for line in &blame_result.lines {
            // All lines should have valid structure
            assert!(line.line_number > 0);
            assert!(!line.commit_oid.is_empty());
            assert_eq!(line.commit_short_id.len(), 7);
            assert!(line.timestamp > 0 || line.is_boundary);
        }
    }

    #[tokio::test]
    async fn test_diff_hunk_structure() {
        let repo = TestRepo::with_initial_commit();

        // Create a modification with clear additions
        repo.create_file("README.md", "New line 1\nNew line 2\nNew line 3");

        let result = get_file_diff(repo.path_str(), "README.md".to_string(), None, None).await;

        assert!(result.is_ok());
        let diff_file = result.unwrap();

        for hunk in &diff_file.hunks {
            // Hunk should have valid header
            assert!(hunk.header.starts_with("@@"));
            // Hunk should have lines
            assert!(!hunk.lines.is_empty());
        }
    }

    // Tests for get_diff_with_options

    #[tokio::test]
    async fn test_get_diff_with_options_no_options() {
        let repo = TestRepo::with_initial_commit();

        // Modify a file
        repo.create_file("README.md", "Modified content");

        let result = get_diff_with_options(
            repo.path_str(),
            None,
            Some(false),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
        let files = result.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "README.md");
    }

    #[tokio::test]
    async fn test_get_diff_with_options_ignore_whitespace_all() {
        let repo = TestRepo::with_initial_commit();

        // Modify a file with only whitespace changes
        repo.create_file("README.md", "# Test Repo  ");

        let result = get_diff_with_options(
            repo.path_str(),
            None,
            Some(false),
            None,
            None,
            None,
            Some("all".to_string()),
            None,
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
        let files = result.unwrap();
        // With ignore_whitespace=all, whitespace-only changes should be suppressed
        // The file may still appear but with fewer or no hunks
        if !files.is_empty() {
            // If it appears, it should have no additions/deletions for ws-only changes
            // Note: trailing whitespace may or may not be caught depending on git config
            assert!(files[0].path == "README.md");
        }
    }

    #[tokio::test]
    async fn test_get_diff_with_options_ignore_whitespace_change() {
        let repo = TestRepo::with_initial_commit();

        // Modify a file by adding extra spaces between words
        repo.create_file("README.md", "#  Test  Repo");

        let result = get_diff_with_options(
            repo.path_str(),
            None,
            Some(false),
            None,
            None,
            None,
            Some("change".to_string()),
            None,
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
        // Should succeed regardless of whether changes are detected
    }

    #[tokio::test]
    async fn test_get_diff_with_options_ignore_whitespace_eol() {
        let repo = TestRepo::with_initial_commit();

        // Modify a file with trailing whitespace
        repo.create_file("README.md", "# Test Repo   ");

        let result = get_diff_with_options(
            repo.path_str(),
            None,
            Some(false),
            None,
            None,
            None,
            Some("eol".to_string()),
            None,
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_get_diff_with_options_context_lines() {
        let repo = TestRepo::with_initial_commit();

        // Create a multi-line file and then modify one line
        repo.create_commit(
            "Add multiline file",
            &[(
                "multiline.txt",
                "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10",
            )],
        );
        repo.create_file(
            "multiline.txt",
            "Line 1\nLine 2\nLine 3\nLine 4\nModified 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10",
        );

        // Request 1 context line
        let result_1 = get_diff_with_options(
            repo.path_str(),
            Some("multiline.txt".to_string()),
            Some(false),
            None,
            None,
            Some(1),
            None,
            None,
            None,
            None,
        )
        .await;

        assert!(result_1.is_ok());
        let files_1 = result_1.unwrap();
        assert_eq!(files_1.len(), 1);
        let hunk_1_lines = &files_1[0].hunks[0].lines;

        // Request 5 context lines
        let result_5 = get_diff_with_options(
            repo.path_str(),
            Some("multiline.txt".to_string()),
            Some(false),
            None,
            None,
            Some(5),
            None,
            None,
            None,
            None,
        )
        .await;

        assert!(result_5.is_ok());
        let files_5 = result_5.unwrap();
        assert_eq!(files_5.len(), 1);
        let hunk_5_lines = &files_5[0].hunks[0].lines;

        // More context lines should result in more lines in the hunk
        assert!(hunk_5_lines.len() > hunk_1_lines.len());
    }

    #[tokio::test]
    async fn test_get_diff_with_options_patience_algorithm() {
        let repo = TestRepo::with_initial_commit();

        // Modify a file
        repo.create_file("README.md", "Modified with patience");

        let result = get_diff_with_options(
            repo.path_str(),
            None,
            Some(false),
            None,
            None,
            None,
            None,
            Some(true),
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
        let files = result.unwrap();
        assert_eq!(files.len(), 1);
    }

    #[tokio::test]
    async fn test_get_diff_with_options_histogram_algorithm() {
        let repo = TestRepo::with_initial_commit();

        // Modify a file
        repo.create_file("README.md", "Modified with histogram");

        let result = get_diff_with_options(
            repo.path_str(),
            None,
            Some(false),
            None,
            None,
            None,
            None,
            None,
            Some(true),
            None,
        )
        .await;

        assert!(result.is_ok());
        let files = result.unwrap();
        assert_eq!(files.len(), 1);
    }

    #[tokio::test]
    async fn test_get_diff_with_options_file_path_filter() {
        let repo = TestRepo::with_initial_commit();

        // Create multiple modified files
        repo.create_file("README.md", "Modified README");
        repo.create_commit("Add file2", &[("file2.txt", "initial")]);
        repo.create_file("file2.txt", "modified file2");

        // Filter to only one file
        let result = get_diff_with_options(
            repo.path_str(),
            Some("file2.txt".to_string()),
            Some(false),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
        let files = result.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "file2.txt");
    }

    #[tokio::test]
    async fn test_get_diff_with_options_staged() {
        let repo = TestRepo::with_initial_commit();

        // Create and stage a file
        repo.create_file("staged.txt", "Staged content");
        repo.stage_file("staged.txt");

        let result = get_diff_with_options(
            repo.path_str(),
            None,
            Some(true),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
        let files = result.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "staged.txt");
        assert_eq!(files[0].status, FileStatus::New);
    }

    #[tokio::test]
    async fn test_get_diff_with_options_commit() {
        let repo = TestRepo::with_initial_commit();

        let commit_oid = repo.create_commit("Second commit", &[("file.txt", "content")]);

        let result = get_diff_with_options(
            repo.path_str(),
            None,
            None,
            Some(commit_oid.to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
        let files = result.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "file.txt");
    }

    #[tokio::test]
    async fn test_get_diff_with_options_compare_commits() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid();

        repo.create_commit("Second commit", &[("file.txt", "content")]);
        let second_oid = repo.head_oid();

        let result = get_diff_with_options(
            repo.path_str(),
            None,
            None,
            Some(second_oid.to_string()),
            Some(first_oid.to_string()),
            None,
            None,
            None,
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
        let files = result.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "file.txt");
    }

    #[tokio::test]
    async fn test_get_diff_with_options_whitespace_none() {
        let repo = TestRepo::with_initial_commit();

        // Modify with whitespace changes
        repo.create_file("README.md", "# Test Repo  ");

        let result = get_diff_with_options(
            repo.path_str(),
            None,
            Some(false),
            None,
            None,
            None,
            Some("none".to_string()),
            None,
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
        let files = result.unwrap();
        // With "none" mode, whitespace changes should still be shown
        assert!(!files.is_empty());
    }

    #[tokio::test]
    async fn test_get_diff_with_options_combined() {
        let repo = TestRepo::with_initial_commit();

        // Create a multi-line file and then modify it
        repo.create_commit(
            "Add multiline file",
            &[("combo.txt", "Line 1\nLine 2\nLine 3\nLine 4\nLine 5")],
        );
        repo.create_file("combo.txt", "Line 1\n  Line 2\nLine 3\nModified 4\nLine 5");

        // Combine multiple options: ignore whitespace change + patience + 2 context lines
        let result = get_diff_with_options(
            repo.path_str(),
            Some("combo.txt".to_string()),
            Some(false),
            None,
            None,
            Some(2),
            Some("change".to_string()),
            Some(true),
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
        let files = result.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "combo.txt");
    }

    /// Build a hunk whose `@@` header is consistent with its `line_count`-line
    /// body (all additions), so we can assert header/body consistency after
    /// truncation.
    fn make_hunk(new_start: u32, line_count: u32) -> DiffHunk {
        let lines: Vec<DiffLine> = (0..line_count)
            .map(|i| DiffLine {
                content: format!("line {}\n", i),
                origin: DiffLineOrigin::Addition,
                old_line_no: None,
                new_line_no: Some(new_start + i),
            })
            .collect();
        DiffHunk {
            header: format!("@@ -0,0 +{},{} @@", new_start, line_count),
            old_start: 0,
            old_lines: 0,
            new_start,
            new_lines: line_count,
            lines,
        }
    }

    fn file_with_hunks(hunks: Vec<DiffHunk>) -> DiffFile {
        DiffFile {
            path: "big.txt".to_string(),
            old_path: None,
            status: FileStatus::Modified,
            hunks,
            is_binary: false,
            is_image: false,
            image_type: None,
            additions: 0,
            deletions: 0,
            truncated: None,
            total_lines: None,
        }
    }

    /// Every kept hunk's header must describe exactly as many new lines as its
    /// body contains — a partially-truncated hunk would violate this and git
    /// would reject the patch as corrupt.
    fn assert_header_body_consistent(file: &DiffFile) {
        for hunk in &file.hunks {
            assert_eq!(
                hunk.new_lines as usize,
                hunk.lines.len(),
                "hunk header claims {} new lines but body has {}",
                hunk.new_lines,
                hunk.lines.len()
            );
        }
    }

    #[test]
    fn test_truncate_diff_no_cap_returns_unchanged() {
        let file = file_with_hunks(vec![make_hunk(1, 5), make_hunk(10, 5)]);
        let out = maybe_truncate_diff(file, None);
        assert_eq!(out.hunks.len(), 2);
        assert!(out.truncated.is_none());
    }

    #[test]
    fn test_truncate_diff_under_cap_returns_unchanged() {
        let file = file_with_hunks(vec![make_hunk(1, 5), make_hunk(10, 5)]);
        let out = maybe_truncate_diff(file, Some(20));
        assert_eq!(out.hunks.len(), 2);
        assert!(out.truncated.is_none());
    }

    #[test]
    fn test_truncate_diff_keeps_only_whole_hunks() {
        // Cap of 12 fits the first (5) and second (5) hunk = 10 lines, but not
        // the third (5) which would push to 15. The third must be dropped
        // whole, never partially truncated.
        let file = file_with_hunks(vec![make_hunk(1, 5), make_hunk(10, 5), make_hunk(20, 5)]);
        let total = 15;
        let out = maybe_truncate_diff(file, Some(12));
        assert_eq!(out.hunks.len(), 2, "only whole hunks that fit are kept");
        assert_eq!(out.truncated, Some(true));
        assert_eq!(out.total_lines, Some(total));
        assert_header_body_consistent(&out);
    }

    #[test]
    fn test_truncate_diff_boundary_between_hunks() {
        // Cap exactly equals the first hunk's size: keep just that hunk, drop
        // the rest, no partial inclusion.
        let file = file_with_hunks(vec![make_hunk(1, 5), make_hunk(10, 5)]);
        let out = maybe_truncate_diff(file, Some(5));
        assert_eq!(out.hunks.len(), 1);
        assert_eq!(out.hunks[0].lines.len(), 5);
        assert_eq!(out.truncated, Some(true));
        assert_header_body_consistent(&out);
    }

    #[test]
    fn test_truncate_diff_first_hunk_exceeds_cap_yields_zero_hunks() {
        // A single hunk larger than the cap is dropped entirely (never
        // partially included), leaving zero hunks with the truncated flag set.
        let file = file_with_hunks(vec![make_hunk(1, 100)]);
        let out = maybe_truncate_diff(file, Some(10));
        assert!(out.hunks.is_empty(), "partial hunk must never be included");
        assert_eq!(out.truncated, Some(true));
        assert_eq!(out.total_lines, Some(100));
    }

    /// Commit a single renamed file (delete old + add identical new content).
    fn commit_rename(repo: &TestRepo, old: &str, new: &str, content: &str) -> git2::Oid {
        repo.create_file(new, content);
        std::fs::remove_file(repo.path.join(old)).unwrap();
        let git = repo.repo();
        let mut index = git.index().unwrap();
        index.remove_path(Path::new(old)).unwrap();
        index.add_path(Path::new(new)).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = git.find_tree(tree_oid).unwrap();
        let sig = git.signature().unwrap();
        let parent = git.head().unwrap().peel_to_commit().unwrap();
        git.commit(Some("HEAD"), &sig, &sig, "rename", &tree, &[&parent])
            .unwrap()
    }

    /// Finding 61: a committed rename must be one "renamed" entry with 0/0
    /// stats, not a delete + add pair, matching `git show --name-status`.
    #[tokio::test]
    async fn test_get_commit_files_detects_rename() {
        let repo = TestRepo::with_initial_commit();
        let content = "line1\nline2\nline3\nline4\nline5\n";
        repo.create_commit("add", &[("file_a.txt", content)]);
        let oid = commit_rename(&repo, "file_a.txt", "file_b.txt", content);

        let files = get_commit_files(repo.path_str(), oid.to_string())
            .await
            .unwrap();

        assert_eq!(files.len(), 1, "rename must be a single entry, not add+del");
        assert_eq!(files[0].status, FileStatus::Renamed);
        assert_eq!(files[0].path, "file_b.txt");
        assert_eq!(files[0].old_path.as_deref(), Some("file_a.txt"));
        assert_eq!(files[0].additions, 0, "pure rename has 0 insertions");
        assert_eq!(files[0].deletions, 0, "pure rename has 0 deletions");
    }

    /// Finding 61: get_commits_stats must report 0/0/1 for a pure rename.
    #[tokio::test]
    async fn test_get_commits_stats_rename_is_zero() {
        let repo = TestRepo::with_initial_commit();
        let content = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
        repo.create_commit("add", &[("orig.txt", content)]);
        let oid = commit_rename(&repo, "orig.txt", "moved.txt", content);

        let stats = get_commits_stats(repo.path_str(), vec![oid.to_string()])
            .await
            .unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].additions, 0);
        assert_eq!(stats[0].deletions, 0);
        assert_eq!(stats[0].files_changed, 1);
    }

    /// Clicking a file that the commit's file list badges as "renamed" must
    /// show the rename diff (only the edited lines), not the whole file as
    /// added.
    #[tokio::test]
    async fn test_get_commit_file_diff_renamed_with_edit() {
        let repo = TestRepo::with_initial_commit();
        let before = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n";
        let after = "alpha\nbeta\ngamma-edited\ndelta\nepsilon\nzeta\n";
        repo.create_commit("add", &[("old_name.txt", before)]);
        let oid = commit_rename(&repo, "old_name.txt", "new_name.txt", after);

        let f = get_commit_file_diff(
            repo.path_str(),
            oid.to_string(),
            "new_name.txt".to_string(),
            None,
        )
        .await
        .unwrap();

        assert_eq!(f.status, FileStatus::Renamed);
        assert_eq!(f.path, "new_name.txt");
        assert_eq!(f.old_path.as_deref(), Some("old_name.txt"));
        assert_eq!(f.additions, 1, "only the edited line is added");
        assert_eq!(f.deletions, 1, "only the edited line is removed");
    }

    /// A rename with no content change must report no hunks and 0/0 stats,
    /// matching `git show` for a pure rename.
    #[tokio::test]
    async fn test_get_commit_file_diff_pure_rename_has_no_hunks() {
        let repo = TestRepo::with_initial_commit();
        let content = "line1\nline2\nline3\nline4\nline5\n";
        repo.create_commit("add", &[("a.txt", content)]);
        let oid = commit_rename(&repo, "a.txt", "b.txt", content);

        let f = get_commit_file_diff(repo.path_str(), oid.to_string(), "b.txt".to_string(), None)
            .await
            .unwrap();

        assert_eq!(f.status, FileStatus::Renamed);
        assert_eq!(f.old_path.as_deref(), Some("a.txt"));
        assert_eq!(f.additions, 0, "a pure rename adds no lines");
        assert_eq!(f.deletions, 0);
        assert!(f.hunks.is_empty(), "a pure rename has no hunks");
    }

    /// Asking for the *old* path of a rename must resolve to the same rename
    /// entry, not a whole-file deletion.
    #[tokio::test]
    async fn test_get_commit_file_diff_old_path_of_rename() {
        let repo = TestRepo::with_initial_commit();
        let content = "one\ntwo\nthree\nfour\nfive\nsix\n";
        repo.create_commit("add", &[("src/old.txt", content)]);
        let oid = commit_rename(&repo, "src/old.txt", "src/new.txt", content);

        let f = get_commit_file_diff(
            repo.path_str(),
            oid.to_string(),
            "src/old.txt".to_string(),
            None,
        )
        .await
        .unwrap();

        assert_eq!(f.status, FileStatus::Renamed);
        assert_eq!(f.path, "src/new.txt");
        assert_eq!(f.old_path.as_deref(), Some("src/old.txt"));
        assert_eq!(f.deletions, 0, "the file was moved, not deleted");
    }

    /// Guard: a file added alongside an unrelated deletion must stay a plain
    /// addition — the rename fallback must never hand back the wrong file.
    #[tokio::test]
    async fn test_get_commit_file_diff_add_alongside_unrelated_delete_stays_new() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("add", &[("gone.txt", "qqq\nrrr\nsss\nttt\n")]);
        // Delete gone.txt and add a wholly dissimilar file in the same commit.
        let added = "totally\ndifferent\ncontent\nhere\n";
        let oid = commit_rename(&repo, "gone.txt", "fresh.txt", added);

        let f = get_commit_file_diff(
            repo.path_str(),
            oid.to_string(),
            "fresh.txt".to_string(),
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            f.status,
            FileStatus::New,
            "dissimilar add must not be paired as a rename"
        );
        assert_eq!(f.additions, 4);
        assert_eq!(f.deletions, 0);
    }

    /// Build a commit that rewrites `bulk` large files wholesale and renames
    /// `old` to `new`. Every bulk file is a full-file rewrite, so the commit's
    /// patch is large while the rename's own patch stays tiny.
    fn commit_bulk_rewrite_with_rename(
        repo: &TestRepo,
        bulk: usize,
        lines: usize,
        old: &str,
        new: &str,
        new_content: &str,
    ) -> git2::Oid {
        let git = repo.repo();
        let mut index = git.index().unwrap();

        for i in 0..bulk {
            let name = format!("bulk/f{i:04}.txt");
            let body: String = (0..lines)
                .map(|l| format!("v2 file {i} line {l}\n"))
                .collect();
            repo.create_file(&name, &body);
            index.add_path(Path::new(&name)).unwrap();
        }

        repo.create_file(new, new_content);
        std::fs::remove_file(repo.path.join(old)).unwrap();
        index.remove_path(Path::new(old)).unwrap();
        index.add_path(Path::new(new)).unwrap();
        index.write().unwrap();

        let tree = git.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git.signature().unwrap();
        let parent = git.head().unwrap().peel_to_commit().unwrap();
        git.commit(Some("HEAD"), &sig, &sig, "bulk rewrite", &tree, &[&parent])
            .unwrap()
    }

    /// Opening one renamed file must not render the whole commit's patch. The
    /// rename fallback used to `parse_diff` the entire whole-tree diff — every
    /// hunk of every file — and throw all but one entry away, so viewing a
    /// single file in a large commit cost as much as viewing the whole commit.
    ///
    /// The budget is measured against `get_diff` on the same commit rather than
    /// a fixed duration, so it tracks the machine's own speed instead of
    /// flaking on a slow runner. The single-file call runs first, on the colder
    /// object cache, so the comparison never flatters it.
    #[tokio::test]
    async fn test_get_commit_file_diff_rename_does_not_render_whole_commit() {
        const BULK_FILES: usize = 150;
        const BULK_LINES: usize = 400;

        let repo = TestRepo::with_initial_commit();

        // Base commit: the bulk files plus the file that will be renamed.
        {
            let git = repo.repo();
            let mut index = git.index().unwrap();
            for i in 0..BULK_FILES {
                let name = format!("bulk/f{i:04}.txt");
                let body: String = (0..BULK_LINES)
                    .map(|l| format!("v1 file {i} line {l}\n"))
                    .collect();
                repo.create_file(&name, &body);
                index.add_path(Path::new(&name)).unwrap();
            }
            repo.create_file("old_name.txt", "alpha\nbeta\ngamma\ndelta\n");
            index.add_path(Path::new("old_name.txt")).unwrap();
            index.write().unwrap();
            let tree = git.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = git.signature().unwrap();
            let parent = git.head().unwrap().peel_to_commit().unwrap();
            git.commit(Some("HEAD"), &sig, &sig, "base", &tree, &[&parent])
                .unwrap();
        }

        let oid = commit_bulk_rewrite_with_rename(
            &repo,
            BULK_FILES,
            BULK_LINES,
            "old_name.txt",
            "new_name.txt",
            "alpha\nbeta-edited\ngamma\ndelta\n",
        );

        let started = std::time::Instant::now();
        let f = get_commit_file_diff(
            repo.path_str(),
            oid.to_string(),
            "new_name.txt".to_string(),
            None,
        )
        .await
        .unwrap();
        let single_file = started.elapsed();

        // The rename must still resolve correctly — the fast path is only worth
        // anything if it returns the same answer.
        assert_eq!(f.status, FileStatus::Renamed);
        assert_eq!(f.path, "new_name.txt");
        assert_eq!(f.old_path.as_deref(), Some("old_name.txt"));
        assert_eq!(f.additions, 1, "only the edited line is added");
        assert_eq!(f.deletions, 1, "only the edited line is removed");

        let started = std::time::Instant::now();
        let whole = get_diff(repo.path_str(), None, Some(oid.to_string()), None)
            .await
            .unwrap();
        let whole_commit = started.elapsed();
        assert_eq!(
            whole.len(),
            BULK_FILES + 1,
            "whole-commit diff must cover every rewritten file plus the rename"
        );

        assert!(
            single_file * 4 < whole_commit,
            "one renamed file took {single_file:?}, nearly as long as rendering the \
             whole {BULK_FILES}-file commit ({whole_commit:?}) — the fallback is \
             still parsing the entire commit patch"
        );
    }

    /// A root commit has no parent, so it can hold no rename: every file is an
    /// addition. Skipping the rename fallback there must not change what the
    /// caller sees for an added file in an initial commit.
    #[tokio::test]
    async fn test_get_commit_file_diff_added_file_in_root_commit() {
        let repo = TestRepo::new();
        let oid = repo.create_commit(
            "initial",
            &[("a.txt", "one\ntwo\nthree\n"), ("b.txt", "other\n")],
        );

        let f = get_commit_file_diff(repo.path_str(), oid.to_string(), "a.txt".to_string(), None)
            .await
            .unwrap();

        assert_eq!(f.status, FileStatus::New);
        assert_eq!(f.path, "a.txt");
        assert_eq!(f.additions, 3);
        assert_eq!(f.deletions, 0);
    }

    /// Finding 62: a working-tree blame with an uncommitted inserted line must
    /// attribute that line to "Not Committed Yet" and keep the rest aligned.
    #[tokio::test]
    async fn test_get_file_blame_working_tree_uncommitted_line() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("add", &[("f.txt", "alpha\nbeta\ngamma\n")]);

        // Insert a new line at the top of the working copy only.
        repo.create_file("f.txt", "NEWLINE\nalpha\nbeta\ngamma\n");

        let result = get_file_blame(repo.path_str(), "f.txt".to_string(), None, None, None)
            .await
            .unwrap();

        // All four working-tree lines must be present (no trailing drop).
        assert_eq!(result.lines.len(), 4);
        assert_eq!(result.lines[0].content, "NEWLINE");
        assert_eq!(result.lines[0].author_name, "Not Committed Yet");
        assert_eq!(result.lines[0].commit_oid, "0".repeat(40));
        // Existing lines keep their real attribution, correctly aligned.
        assert_eq!(result.lines[1].content, "alpha");
        assert_ne!(result.lines[1].commit_oid, "0".repeat(40));
        assert_eq!(result.lines[3].content, "gamma");
        assert_ne!(result.lines[3].commit_oid, "0".repeat(40));
    }

    /// Finding 63: staged diff of the first file in a repo with no commits
    /// (unborn HEAD) must succeed against the empty tree, like `git diff --cached`.
    #[tokio::test]
    async fn test_get_file_diff_staged_unborn_head() {
        let repo = TestRepo::new(); // no initial commit -> unborn HEAD
        repo.create_file("first.txt", "hello\nworld\n");
        repo.stage_file("first.txt");

        let result =
            get_file_diff(repo.path_str(), "first.txt".to_string(), Some(true), None).await;
        assert!(
            result.is_ok(),
            "staged diff on unborn HEAD should succeed: {:?}",
            result.err()
        );
        let f = result.unwrap();
        assert_eq!(f.path, "first.txt");
        assert_eq!(f.status, FileStatus::New);
        assert!(f.additions >= 2);
    }

    /// Finding 63: get_diff staged also works on an unborn HEAD.
    #[tokio::test]
    async fn test_get_diff_staged_unborn_head() {
        let repo = TestRepo::new();
        repo.create_file("first.txt", "content\n");
        repo.stage_file("first.txt");

        let result = get_diff(repo.path_str(), Some(true), None, None).await;
        assert!(
            result.is_ok(),
            "unborn HEAD staged diff: {:?}",
            result.err()
        );
        let files = result.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "first.txt");
        assert_eq!(files[0].status, FileStatus::New);
    }

    /// Finding 66: a UTF-16 file that git flags binary must be reported as
    /// binary (git's default), not as an empty non-binary diff.
    #[tokio::test]
    async fn test_utf16_file_reported_as_binary() {
        let repo = TestRepo::with_initial_commit();

        // UTF-16LE bytes for {"a":2} (with BOM), committed.
        let to_utf16le = |s: &str| -> Vec<u8> {
            let mut v = vec![0xFF, 0xFE];
            for u in s.encode_utf16() {
                v.extend_from_slice(&u.to_le_bytes());
            }
            v
        };
        let git = repo.repo();
        std::fs::write(repo.path.join("data.json"), to_utf16le("{\"a\":2}")).unwrap();
        let mut index = git.index().unwrap();
        index.add_path(Path::new("data.json")).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = git.find_tree(tree_oid).unwrap();
        let sig = git.signature().unwrap();
        let parent = git.head().unwrap().peel_to_commit().unwrap();
        git.commit(Some("HEAD"), &sig, &sig, "add utf16", &tree, &[&parent])
            .unwrap();

        // Modify the working copy.
        std::fs::write(repo.path.join("data.json"), to_utf16le("{\"a\":3}")).unwrap();

        let result = get_file_diff(repo.path_str(), "data.json".to_string(), Some(false), None)
            .await
            .unwrap();
        assert!(
            result.is_binary,
            "UTF-16 file must be reported as binary, not an empty text diff"
        );
    }

    /// Finding 67: requesting the diff of an unchanged path must not substitute
    /// another file that merely shares a basename.
    #[tokio::test]
    async fn test_get_file_diff_no_basename_substitution() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit(
            "add",
            &[("vendor/foo.c", "a\nb\nc\n"), ("src/foo.c", "x\ny\nz\n")],
        );
        // Only vendor/foo.c is modified.
        repo.create_file("vendor/foo.c", "a\nb\nMODIFIED\n");

        // Requesting the unchanged src/foo.c must NOT return vendor/foo.c's diff.
        let result =
            get_file_diff(repo.path_str(), "src/foo.c".to_string(), Some(false), None).await;
        assert!(
            result.is_err(),
            "unchanged src/foo.c must not resolve to vendor/foo.c's diff"
        );
    }

    /// Finding 67: the unstaged diff of a fully-staged file must not return the
    /// staged hunks (the opposite staging area).
    #[tokio::test]
    async fn test_get_file_diff_unstaged_does_not_return_staged() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("base", &[("f.txt", "base\n")]);
        // Stage a change; working tree == index (no unstaged change).
        repo.create_file("f.txt", "staged change\n");
        repo.stage_file("f.txt");

        let result = get_file_diff(repo.path_str(), "f.txt".to_string(), Some(false), None).await;
        assert!(
            result.is_err(),
            "unstaged diff of a fully-staged file must not surface the staged hunks"
        );
    }
}
