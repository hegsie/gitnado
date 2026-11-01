//! Conflict inspection, marker detection, and resolution command handlers

use std::path::Path;
use tauri::command;

use super::super::path_utils::validate_path_within_repo;
use crate::error::{GitnadoError, Result};
use crate::models::{
    ConflictDetails, ConflictEntry, ConflictFile, ConflictHunk, ConflictMarker, ConflictMarkerFile,
};

/// Get list of conflicted files
#[command]
pub async fn get_conflicts(path: String) -> Result<Vec<ConflictFile>> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let index = repo.index()?;

    tracing::debug!(
        "get_conflicts: repo_state={:?}, has_conflicts={}",
        repo.state(),
        index.has_conflicts()
    );

    let mut conflicts = Vec::new();

    for conflict in index.conflicts()? {
        let conflict = conflict?;

        let get_entry = |entry: Option<git2::IndexEntry>| -> Option<ConflictEntry> {
            entry.map(|e| ConflictEntry {
                oid: e.id.to_string(),
                path: String::from_utf8_lossy(&e.path).to_string(),
                mode: e.mode,
            })
        };

        let file_path = conflict
            .our
            .as_ref()
            .or(conflict.their.as_ref())
            .or(conflict.ancestor.as_ref())
            .map(|e| String::from_utf8_lossy(&e.path).to_string())
            .unwrap_or_default();

        // Submodule (gitlink) conflicts have COMMIT OIDs, not blobs — every
        // blob-based affordance (text editor, side panes, verbatim buttons)
        // would dead-end on them. Flag them so the frontend routes to a
        // commit-pointer chooser instead.
        let is_submodule = [&conflict.our, &conflict.their, &conflict.ancestor]
            .iter()
            .filter_map(|e| e.as_ref())
            .any(|e| e.mode == 0o160000);

        // Binary conflicts must not be routed through the text merge editor.
        // SYMLINK conflicts must not either: their blobs are text (the link
        // target path), but resolving them means recreating a LINK, not
        // writing text — the whole-blob chooser (take-side, which is
        // symlink-aware) is the only correct affordance.
        let is_binary = !is_submodule
            && [&conflict.our, &conflict.their, &conflict.ancestor]
                .iter()
                .filter_map(|e| e.as_ref())
                .any(|e| {
                    e.mode == 0o120000
                        || repo.find_blob(e.id).map(|b| b.is_binary()).unwrap_or(false)
                });

        // How this file's conflict hunks were actually written. The
        // conflict-marker-size attribute and merge.conflictStyle config only
        // describe what git's CLI writes — libgit2's own merge/checkout
        // ignores both and always emits 7-char merge-style markers — so the
        // emission must be verified against the working file, not assumed.
        // Binary conflicts have no marker hunks to detect (and libgit2's
        // binary merge result has no content to replay against) — report
        // the defaults; the text merge editor never parses them anyway.
        // Submodule conflicts have no text either (the workdir path is a
        // directory).
        let (marker_size, conflict_style, conflict_hunks) = if is_binary || is_submodule {
            (
                crate::models::conflict::default_marker_size(),
                crate::models::conflict::default_conflict_style(),
                Vec::new(),
            )
        } else {
            detect_conflict_emission(
                &repo,
                Path::new(&path),
                &file_path,
                conflict.ancestor.as_ref(),
                conflict.our.as_ref(),
                conflict.their.as_ref(),
            )
        };

        conflicts.push(ConflictFile {
            path: file_path,
            ancestor: get_entry(conflict.ancestor),
            ours: get_entry(conflict.our),
            theirs: get_entry(conflict.their),
            is_binary,
            is_submodule,
            marker_size,
            conflict_style,
            conflict_hunks,
        });
    }

    tracing::debug!("get_conflicts: returning {} conflicts", conflicts.len());
    Ok(conflicts)
}

/// True when `line` is a marker run of `ch`: EXACTLY `size` characters
/// followed by a space or end-of-line.
fn is_marker_run(line: &str, ch: char, size: usize) -> bool {
    let n = line.chars().take_while(|&c| c == ch).count();
    n == size && matches!(line.chars().nth(n), None | Some(' '))
}

/// The `conflict-marker-size` gitattribute for a path, defaulting to 7.
/// Parsed as u16: real sizes are tiny, and the cap also bounds the
/// separator-string allocations downstream — a hostile
/// `conflict-marker-size=4000000000` in a cloned repo's .gitattributes must
/// not make the backend try to allocate gigabytes.
fn attr_marker_size(repo: &git2::Repository, file_path: &str) -> u32 {
    repo.get_attr(
        Path::new(file_path),
        "conflict-marker-size",
        git2::AttrCheckFlags::default(),
    )
    .ok()
    .flatten()
    .and_then(|v| v.parse::<u16>().ok())
    .map(u32::from)
    .filter(|&n| n >= 1)
    .unwrap_or_else(crate::models::conflict::default_marker_size)
}

/// True when `content` holds a complete conflict written at `size`: a start
/// run, then a separator, then an end run — each exactly `size` marker
/// characters followed by a space or end-of-line, in git's emission order.
/// Fallback signal only — content that QUOTES a complete conflict (docs,
/// fixtures) fools it, which is why detect_conflict_emission replays the
/// merge first. Test oracle for the single-size completion semantics that
/// `detected_marker_sizes` (the production path) computes across all sizes.
#[cfg(test)]
pub(super) fn has_complete_conflict(content: &str, size: usize) -> bool {
    let sep: String = "=".repeat(size);
    let mut stage = 0u8; // 0 = want start, 1 = want separator, 2 = want end
    for line in content.lines() {
        match stage {
            0 if is_marker_run(line, '<', size) => stage = 1,
            1 if line == sep => stage = 2,
            2 if is_marker_run(line, '>', size) => return true,
            _ => {}
        }
    }
    false
}

/// A crafted file can demonstrate thousands of distinct sizes (escalating
/// marker runs); each one downstream becomes up to three merge replays, so
/// an uncapped list would let a hostile repo stall get_conflicts for
/// minutes. Real emissions demonstrate one or two sizes; the earliest-seen
/// ones are kept because the first complete conflict is git's own. The
/// SMALLEST demonstrated size is always retained on top of the cap (see
/// below) — dropping a small real size is the one dangerous direction.
pub(super) const MAX_DETECTED_SIZES: usize = 16;

/// Marker sizes the file's content DEMONSTRATES: distinct start-run lengths
/// (space/EOL-terminated) that form a complete conflict (start, then
/// separator, then end) at their own size. Used when the
/// conflict-marker-size attribute no longer matches what git wrote (it can
/// change mid-operation via .gitattributes' own resolution). Callers pass
/// `min_size` 7 for structural use (avoiding false positives on `< quoted`
/// lines) or 1 for replay candidates (replay rejects wrong sizes safely).
///
/// Single pass: every marker-shaped line advances a per-size completeness
/// state machine. Rescanning the file per distinct size would be
/// O(sizes × lines) — a hostile file with escalating run lengths turns
/// that into a multi-minute hang of get_conflicts.
pub(super) fn detected_marker_sizes(content: &str, min_size: usize) -> Vec<u32> {
    use std::collections::HashMap;
    // 0 = want start, 1 = want separator, 2 = want end, 3 = complete.
    let mut stage: HashMap<usize, u8> = HashMap::new();
    let mut sizes: Vec<u32> = Vec::new();
    let mut min_complete: Option<u32> = None;
    let mut min_complete_ge3: Option<u32> = None;
    for line in content.lines() {
        let (ch, exact) = match line.chars().next() {
            Some('<') => ('<', false),
            Some('=') => ('=', true),
            Some('>') => ('>', false),
            _ => continue,
        };
        let n = line.chars().take_while(|&c| c == ch).count();
        if n < min_size || n > u16::MAX as usize {
            continue;
        }
        // Start/end markers allow a trailing label; the separator is the
        // bare run only (same shape has_complete_conflict matches).
        if exact {
            if line.chars().nth(n).is_some() {
                continue;
            }
        } else if !matches!(line.chars().nth(n), None | Some(' ')) {
            continue;
        }
        let s = stage.entry(n).or_insert(0);
        match (ch, *s) {
            ('<', 0) => *s = 1,
            ('=', 1) => *s = 2,
            ('>', 2) => {
                *s = 3;
                let sz = n as u32;
                min_complete = Some(min_complete.map_or(sz, |m| m.min(sz)));
                if sz >= 3 {
                    min_complete_ge3 = Some(min_complete_ge3.map_or(sz, |m| m.min(sz)));
                }
                if sizes.len() < MAX_DETECTED_SIZES {
                    sizes.push(sz);
                }
            }
            _ => {}
        }
    }
    // Always retain the smallest demonstrated complete size, even if the cap
    // already filled with larger (possibly hostile/quoted) ones. A small real
    // conflict size (git honors conflict-marker-size as low as 1) evicted from
    // the list would make the structural fallback floor to 7, and the frontend
    // would then parse the real sub-7 markers as plain content and stage them
    // silently. Retain the smallest complete size >= 3 SEPARATELY: the
    // structural fallback filters to >= 3, so a sub-3 decoy occupying the
    // global-min slot would be dropped there while a cap-evicted real size in
    // [3,6] is not retained — floating the reported size above the real markers
    // and leaking them. Retaining both closes that hole for at most one extra
    // entry.
    for m in [min_complete, min_complete_ge3].into_iter().flatten() {
        if !sizes.contains(&m) {
            sizes.push(m);
        }
    }
    sizes.sort_unstable();
    sizes
}

/// True when the FIRST complete conflict at `size` contains a base marker
/// (`|||||||` run of the same size) between its start and separator —
/// the structural signature of diff3 emission. Fallback signal only.
pub(super) fn diff3_within_first_conflict(content: &str, size: usize) -> bool {
    let sep: String = "=".repeat(size);
    let mut in_ours = false;
    let mut saw_base = false;
    for line in content.lines() {
        if !in_ours {
            if is_marker_run(line, '<', size) {
                in_ours = true;
            }
        } else if line == sep {
            return saw_base;
        } else if is_marker_run(line, '|', size) {
            saw_base = true;
        }
    }
    false
}

/// Line-based comparison of the working file against a replayed merge,
/// tolerant of the two things that legitimately differ between engines:
/// marker LABELS (git's CLI writes branch names/commit subjects, libgit2
/// writes index-entry paths) and CR line endings (checkout filters).
/// Content lines must match exactly.
fn matches_replay(workdir: &str, replay: &str, size: usize) -> bool {
    let marker_kind = |line: &str| -> Option<char> {
        ['<', '>', '|']
            .into_iter()
            .find(|&ch| is_marker_run(line, ch, size))
    };
    let a: Vec<&str> = workdir.lines().collect();
    let b: Vec<&str> = replay.lines().collect();
    a.len() == b.len()
        && a.iter().zip(b.iter()).all(|(x, y)| {
            x == y || matches!((marker_kind(x), marker_kind(y)), (Some(p), Some(q)) if p == q)
        })
}

/// Determine the marker size and conflict style this file's hunks were
/// ACTUALLY written with. The gitattribute/config only describe what git's
/// CLI writes; libgit2 (the in-app merge engine) ignores both and always
/// emits 7-char merge-style markers, and the same bytes can be a real
/// conflict at one size and quoted content at another. So: replay the merge
/// from the index blobs at each candidate size × style and accept a
/// (label/CR tolerant) match as definitive; fall back to structural scans
/// only when replay cannot decide (user-edited file, missing side).
fn detect_conflict_emission(
    repo: &git2::Repository,
    repo_root: &Path,
    file_path: &str,
    ancestor: Option<&git2::IndexEntry>,
    ours: Option<&git2::IndexEntry>,
    theirs: Option<&git2::IndexEntry>,
) -> (u32, String, Vec<ConflictHunk>) {
    let attr_size = attr_marker_size(repo, file_path);
    let content = match std::fs::read_to_string(repo_root.join(file_path)) {
        Ok(c) => c,
        // Unreadable working file (deleted side, binary) — size and style
        // are moot for parsing; report the attribute value.
        Err(_) => {
            return (
                attr_size,
                crate::models::conflict::default_conflict_style(),
                Vec::new(),
            )
        }
    };

    // Sizes actually WRITTEN in the file. The attribute reflects the repo's
    // configuration NOW, not when git wrote the markers — resolving
    // .gitattributes' own conflict mid-operation can change it under the
    // markers' feet, and trusting only the attribute would then report a
    // size the file does not use (the frontend would find zero conflicts
    // and let Mark Resolved stage the raw markers as resolved content).
    // Git emits runs as small as 1, so the REPLAY candidates take every
    // demonstrated size — a wrong size simply fails the replay match, so
    // sub-7 candidates cannot cause false positives there. The structural
    // fallback below (when no replay matches) also uses these demonstrated
    // sizes: a quoted `< text` / `= text` block that coincidentally forms a
    // complete structure only makes the fallback prefer a size at which the
    // frontend renders a spurious-but-blob-validated conflict block — the
    // SAFE direction — whereas ignoring a real sub-7 size would leak its raw
    // markers.
    let detected_all = detected_marker_sizes(&content, 1);
    let mut candidates: Vec<u32> = vec![attr_size];
    if attr_size != 7 {
        candidates.push(7);
    }
    for &d in &detected_all {
        if !candidates.contains(&d) {
            candidates.push(d);
        }
    }

    // Replay from blob CONTENTS (not index entries): a missing ancestor —
    // an add/add conflict — is merged against an empty base, exactly as git
    // does, so those files still get replay verification instead of falling
    // through to the ambiguous structural scan.
    let blob = |e: Option<&git2::IndexEntry>| -> Option<Vec<u8>> {
        e.and_then(|e| repo.find_blob(e.id).ok().map(|b| b.content().to_vec()))
    };
    let anc_bytes = blob(ancestor).unwrap_or_default();
    if let (Some(our_bytes), Some(their_bytes)) = (blob(ours), blob(theirs)) {
        let mut anc_in = git2::MergeFileInput::new();
        anc_in.content(&anc_bytes);
        let mut our_in = git2::MergeFileInput::new();
        our_in.content(&our_bytes);
        let mut their_in = git2::MergeFileInput::new();
        their_in.content(&their_bytes);
        for &size in &candidates {
            for style in ["merge", "diff3", "zdiff3"] {
                let mut opts = git2::MergeFileOptions::new();
                opts.marker_size(size as u16);
                opts.style_diff3(style == "diff3");
                opts.style_zdiff3(style == "zdiff3");
                let Ok(result) = git2::merge_file(&anc_in, &our_in, &their_in, Some(&mut opts))
                else {
                    continue;
                };
                let replay = String::from_utf8_lossy(result.content());
                if matches_replay(&content, &replay, size as usize) {
                    // zdiff3 emits the same structure as diff3 to a parser.
                    let reported = if style == "merge" { "merge" } else { "diff3" };
                    // The replay matched line-for-line, so marker positions
                    // in the replay ARE positions in the working file. But
                    // the replay's own content can quote marker-shaped
                    // lines just like the file — re-replay at a size no
                    // blob line collides with, where marker detection is
                    // unambiguous, and hand the frontend AUTHORITATIVE
                    // hunk positions instead of shape heuristics.
                    let replay_line_count = replay.lines().count();
                    // None when no collision-free size fits in u16 (a
                    // pathological ~65k-char marker-char run) — fall back to
                    // the frontend's blob-validated heuristics rather than
                    // hand it a size that might itself collide.
                    let hunks =
                        collision_free_size(&[&anc_bytes, &our_bytes, &their_bytes], size as usize)
                            .and_then(|star| {
                                let mut star_opts = git2::MergeFileOptions::new();
                                star_opts.marker_size(star);
                                star_opts.style_diff3(style == "diff3");
                                star_opts.style_zdiff3(style == "zdiff3");
                                git2::merge_file(&anc_in, &our_in, &their_in, Some(&mut star_opts))
                                    .ok()
                                    .and_then(|star_result| {
                                        let star_replay =
                                            String::from_utf8_lossy(star_result.content())
                                                .to_string();
                                        // Marker lines are one line each at any
                                        // size, so the line counts must agree —
                                        // bail to heuristics if they somehow don't.
                                        if star_replay.lines().count() != replay_line_count {
                                            return None;
                                        }
                                        replay_hunks(&star_replay, star as usize, style != "merge")
                                    })
                            })
                            .unwrap_or_default();
                    return (size, reported.to_string(), hunks);
                }
            }
        }
    }

    // Structural fallback (hand-edited files, missing sides). Choose the
    // reported size. The frontend parses markers of EXACTLY this size, and its
    // orphan safety-net matches runs of `>=` this size. Reporting a size LARGER
    // than a real marker makes BOTH miss it — raw markers leak into the pane and
    // round-trip to disk; reporting SMALLER is safe, because a real LARGER
    // marker is still caught by the `>=` net (which collapses to a clean
    // whole-file conflict). So take the SMALLEST candidate:
    //  - every DEMONSTRATED complete size (`detected_all`) — this recovers a
    //    real sub-7 size even when the current attribute has drifted back to the
    //    default 7 (.gitattributes' own conflict resolved after git wrote the
    //    markers), which a two-candidate attr-vs-7 check blind-spots; and
    //  - the EXPLICIT attribute size (`attr_size != 7`) — because this fallback
    //    runs only for HAND-EDITED files, and a hand edit that breaks the real
    //    conflict's structure (e.g. deletes its separator) removes its size from
    //    `detected_all`, so without the attribute a real sub-7 size would be
    //    floored UP to a larger quoted-but-complete block and leak. `attr_size`
    //    is only a real signal when it names a non-default size; a bare 7 is
    //    indistinguishable from "no attribute", so folding it would wrongly cap
    //    a genuine raised size (e.g. 12) down to 7.
    // Exclude runs of 1-2 chars: git's practical minimum conflict-marker-size is
    // 3, and a lone `<`/`=`/`>` content line forming a "complete" size-1
    // structure would otherwise make the whole file parse as markers. A quoted
    // LARGER conflict block only yields a spurious, blob-validated conflict block
    // the frontend already contains. When nothing >=3 remains, fall back to the
    // attribute size (default 7).
    // Residual (accepted): if the attribute ALSO drifted to the default 7 AND
    // the real markers are sub-7 AND a hand edit broke their structure, no
    // signal of the real size survives; the min still floors >=7 and sub-7
    // markers leak. Closing it would need the frontend echo-net floor below 7,
    // which the design avoids (3-6-char `===`/`>>>` content dividers would then
    // false-positive).
    let size = detected_all
        .iter()
        .copied()
        .chain((attr_size != 7).then_some(attr_size))
        .filter(|&n| n >= 3)
        .min()
        // Nothing >=3 survived. attr_size is only reached here when it is 7 or
        // sub-3 (a 3-6 attr would have passed the filter above); reporting a
        // sub-3 attr would make the frontend parse `<<`/`==`/`>>` in ordinary
        // prose as markers. Fall back to the safe default (7).
        .unwrap_or_else(crate::models::conflict::default_marker_size);
    let style = if diff3_within_first_conflict(&content, size as usize) {
        "diff3"
    } else {
        "merge"
    };
    // No replay match — the file was hand-edited; positions would be
    // guesses, so the frontend's validated heuristics take over.
    (size, style.to_string(), Vec::new())
}

/// A marker size that cannot collide with any content line: strictly longer
/// than every leading `<`/`=`/`>`/`|` run in any input blob. None when no
/// such size fits in u16 (merge_file's marker_size is a u16) — the caller
/// then falls back to heuristics rather than using a size that could itself
/// collide with content.
pub(super) fn collision_free_size(blobs: &[&[u8]], at_least: usize) -> Option<u16> {
    let mut max_run = at_least;
    for bytes in blobs {
        // Byte-level scan: merge_file works on raw bytes, so the run count
        // must too (a lossy string decode could in principle diverge).
        for line in bytes.split(|&b| b == b'\n') {
            for ch in *b"<=>|" {
                let n = line.iter().take_while(|&&b| b == ch).count();
                if n > max_run {
                    max_run = n;
                }
            }
        }
    }
    let size = max_run + 3;
    if size > u16::MAX as usize {
        None
    } else {
        Some(size as u16)
    }
}

/// Extract hunk marker positions from a replay generated at a
/// collision-free size — every marker-shaped line is a REAL marker there.
/// Returns None on any malformed structure (never expected).
pub(super) fn replay_hunks(replay: &str, size: usize, has_base: bool) -> Option<Vec<ConflictHunk>> {
    let sep: String = "=".repeat(size);
    let mut hunks: Vec<ConflictHunk> = Vec::new();
    let mut cur: Option<(u32, Option<u32>, Option<u32>)> = None; // (start, base, separator)
    for (i, line) in replay.lines().enumerate() {
        let i = i as u32;
        match cur {
            None => {
                if is_marker_run(line, '<', size) {
                    cur = Some((i, None, None));
                }
            }
            Some((start, base, separator)) => {
                if separator.is_none()
                    && has_base
                    && base.is_none()
                    && is_marker_run(line, '|', size)
                {
                    cur = Some((start, Some(i), None));
                } else if separator.is_none() && line == sep {
                    cur = Some((start, base, Some(i)));
                } else if let Some(sep_idx) = separator {
                    if is_marker_run(line, '>', size) {
                        hunks.push(ConflictHunk {
                            start,
                            separator: sep_idx,
                            end: i,
                            base,
                        });
                        cur = None;
                    }
                }
            }
        }
    }
    if cur.is_some() {
        return None;
    }
    Some(hunks)
}

/// Get content of a blob by OID
#[command]
pub async fn get_blob_content(path: String, oid: String) -> Result<String> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let blob_oid = git2::Oid::from_str(&oid)?;
    let blob = repo.find_blob(blob_oid)?;

    if blob.is_binary() {
        return Err(GitnadoError::OperationFailed(
            "Cannot display binary file".to_string(),
        ));
    }

    // STRICT decoding, matching read_file_content: a lossy read would put
    // U+FFFD substitutions on screen, and resolving from such a pane (Use
    // Base on a legacy-encoded ancestor) would silently bake the corrupted
    // text into the resolved file. The caller treats the error like any
    // other unreadable side and offers verbatim (raw-bytes) resolution.
    String::from_utf8(blob.content().to_vec())
        .map_err(|_| GitnadoError::OperationFailed("File content is not valid UTF-8".to_string()))
}

/// Mark a file as resolved with the given content.
/// When `delete_file` is true the resolution is the file's REMOVAL (e.g. the
/// deleted side of a modify/delete conflict): the working file is deleted and
/// the deletion is staged, instead of writing+staging an empty file.
#[command]
pub async fn resolve_conflict(
    path: String,
    file_path: String,
    content: String,
    delete_file: Option<bool>,
) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let full_path = validate_path_within_repo(Path::new(&path), &file_path)?;
    let mut index = repo.index()?;

    // Inspect this file's conflict entries once. Two invariants are enforced
    // server-side rather than trusting the frontend's routing:
    //  - a NON-UTF-8 filename cannot round-trip through the String API
    //    (get_conflicts already lossy-encoded it), so building a path from
    //    file_path here would target a DIFFERENT (U+FFFD-mangled) file —
    //    silently creating a ghost and leaving the real file conflicted.
    //  - a SYMLINK/SUBMODULE conflict must be resolved by choosing a side
    //    (take-side), never by writing text content over it.
    let mut special_mode = false;
    for c in index.conflicts()?.filter_map(|r| r.ok()) {
        for entry in [&c.our, &c.their, &c.ancestor].into_iter().flatten() {
            if String::from_utf8_lossy(&entry.path) == file_path.as_str() {
                if std::str::from_utf8(&entry.path).is_err() {
                    return Err(GitnadoError::OperationFailed(format!(
                        "'{}' has a non-UTF-8 name and can't be resolved in the app — resolve it with git in a terminal",
                        file_path
                    )));
                }
                if entry.mode == 0o120000 || entry.mode == 0o160000 {
                    special_mode = true;
                }
            }
        }
    }
    if special_mode && !delete_file.unwrap_or(false) {
        return Err(GitnadoError::OperationFailed(format!(
            "'{}' is a symlink or submodule conflict — choose a side instead of writing text",
            file_path
        )));
    }

    if delete_file.unwrap_or(false) {
        // symlink_metadata, not exists(): exists() FOLLOWS symlinks, so a
        // dangling link reports false and would be left on disk while the
        // index stages its deletion — an untracked leftover that blocks
        // later checkouts. A DIRECTORY here is a submodule worktree — git
        // leaves it behind on `git rm` of a submodule, so never delete the
        // tree (and remove_file would error on it anyway).
        if let Ok(meta) = std::fs::symlink_metadata(&full_path) {
            if !meta.file_type().is_dir() {
                std::fs::remove_file(&full_path)?;
            }
        }
        index.remove_path(Path::new(&file_path))?;
    } else {
        // Write the resolved content to the working directory. NEVER write
        // THROUGH an existing symlink — fs::write follows it and would
        // corrupt the link's target file (and stage the wrong blob).
        remove_if_symlink(&full_path)?;
        // The parent directory can be missing (deleted out-of-band, or a
        // file↔directory resolution) — create it so the write gives a
        // sensible result instead of a raw NotFound.
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&full_path, &content)?;
        index.add_path(Path::new(&file_path))?;
    }
    index.write()?;

    Ok(())
}

/// Remove `path` when it is a symlink, so a subsequent write creates a new
/// file instead of following the link into its target.
fn remove_if_symlink(path: &Path) -> Result<()> {
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            std::fs::remove_file(path)?;
        }
    }
    Ok(())
}

/// Resolve a conflict by taking one side's blob verbatim (binary-safe).
/// `side` is "ours" or "theirs". If the chosen side has no entry (the file
/// was deleted on that side), the resolution is the file's removal.
#[command]
pub async fn resolve_conflict_take_side(
    path: String,
    file_path: String,
    side: String,
) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let full_path = validate_path_within_repo(Path::new(&path), &file_path)?;

    let mut index = repo.index()?;
    let conflict = index
        .conflicts()?
        .filter_map(|c| c.ok())
        .find(|c| {
            c.our
                .as_ref()
                .or(c.their.as_ref())
                .or(c.ancestor.as_ref())
                .map(|e| String::from_utf8_lossy(&e.path) == file_path.as_str())
                .unwrap_or(false)
        })
        .ok_or_else(|| {
            GitnadoError::OperationFailed(format!("No conflict found for '{}'", file_path))
        })?;

    // A NON-UTF-8 filename cannot round-trip through the String API — the
    // matched-by-lossy path here differs from the entry's real bytes, so
    // every fs/index op below would target a DIFFERENT (mangled) path,
    // silently creating a ghost file and leaving the real one conflicted.
    // Refuse honestly instead.
    if [&conflict.our, &conflict.their, &conflict.ancestor]
        .into_iter()
        .flatten()
        .any(|e| std::str::from_utf8(&e.path).is_err())
    {
        return Err(GitnadoError::OperationFailed(format!(
            "'{}' has a non-UTF-8 name and can't be resolved in the app — resolve it with git in a terminal",
            file_path
        )));
    }

    let entry = match side.as_str() {
        "ours" => conflict.our,
        "theirs" => conflict.their,
        other => {
            return Err(GitnadoError::OperationFailed(format!(
                "Invalid side '{}': expected 'ours' or 'theirs'",
                other
            )));
        }
    };

    match entry {
        Some(e) if e.mode == 0o160000 => {
            // Submodule (gitlink) pointer — there is no blob to write. Stage
            // the chosen COMMIT pointer directly (like `git checkout --ours`
            // + `git add`). The submodule's own files come from a later
            // `git submodule update`; here we only make the WORKTREE match
            // what git does for a gitlink checkout — an empty directory at
            // the path. Without this, a submodule↔file type conflict leaves
            // the OTHER side's regular file (or a symlink) on disk while the
            // index holds the gitlink, so `git status` reports the
            // just-"resolved" path as dirty.
            // create_dir_all, not create_dir: a NESTED gitlink (e.g.
            // `vendor/sub`) may have no parent directory on disk yet.
            if let Ok(meta) = std::fs::symlink_metadata(&full_path) {
                if !meta.file_type().is_dir() {
                    std::fs::remove_file(&full_path)?;
                    std::fs::create_dir_all(&full_path)?;
                }
                // An existing directory is left as-is (it may already be the
                // submodule's populated worktree).
            } else {
                std::fs::create_dir_all(&full_path)?;
            }
            let resolved = git2::IndexEntry {
                // Clear the stage bits — this is the resolution entry.
                flags: e.flags & !0x3000,
                ..e
            };
            index.remove_path(Path::new(&file_path))?;
            index.add(&resolved)?;
        }
        Some(e) => {
            let blob = repo.find_blob(e.id)?;
            // NEVER write through an existing symlink: fs::write follows
            // it, which would corrupt the link's TARGET file and stage the
            // pre-existing (wrong) link blob instead of the chosen side.
            remove_if_symlink(&full_path)?;
            // A DIRECTORY here is the other side's submodule worktree
            // (gitlink↔file/symlink type conflict) — fs::write/symlink on
            // it fails with a raw EISDIR/EEXIST. An empty placeholder dir
            // (uninitialized submodule) is removed; a populated one is
            // refused with an actionable message — never delete a tree
            // that may hold uncommitted submodule work.
            if let Ok(meta) = std::fs::symlink_metadata(&full_path) {
                // The same branch is reached by a file↔directory (D/F)
                // conflict with no submodule involved, so the message must
                // not assume one.
                if meta.file_type().is_dir() && std::fs::remove_dir(&full_path).is_err() {
                    return Err(GitnadoError::OperationFailed(format!(
                        "'{}' is a directory with files in it (the other side made this path a directory) — move or remove it, then take this side again",
                        file_path
                    )));
                }
            }
            // A NESTED conflicted path (e.g. `vendor/pkg/file`) may have no
            // parent directory on disk — create it so the write/symlink
            // below gives a sensible result instead of a raw NotFound.
            if let Some(parent) = full_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if e.mode == 0o120000 {
                // The chosen side IS a symlink — its blob content is the
                // link target path; recreate the link rather than writing
                // a regular file containing the target as text.
                #[cfg(unix)]
                {
                    use std::os::unix::ffi::OsStrExt;
                    // remove_if_symlink only cleared a symlink; in a
                    // file↔symlink type conflict the workdir holds a REGULAR
                    // file, and symlink() refuses to replace it (EEXIST).
                    if std::fs::symlink_metadata(&full_path).is_ok() {
                        std::fs::remove_file(&full_path)?;
                    }
                    // A symlink target is an arbitrary byte string, not
                    // necessarily UTF-8 — from_utf8_lossy would replace odd
                    // bytes with U+FFFD and silently break the link. Write
                    // the exact bytes git recorded.
                    std::os::unix::fs::symlink(
                        std::ffi::OsStr::from_bytes(blob.content()),
                        &full_path,
                    )?;
                }
                #[cfg(not(unix))]
                std::fs::write(&full_path, blob.content())?;
            } else {
                // Write the chosen side's raw blob bytes (works for binary
                // files).
                std::fs::write(&full_path, blob.content())?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    // Apply the chosen side's mode in BOTH directions:
                    // fs::write keeps the existing file's permissions, so
                    // taking a non-executable side over an executable
                    // on-disk file must chmod DOWN too, or the resolved
                    // file is staged with the mode of the side the user
                    // rejected.
                    let mode = if e.mode == 0o100755 { 0o755 } else { 0o644 };
                    std::fs::set_permissions(&full_path, std::fs::Permissions::from_mode(mode))?;
                }
            }
            index.add_path(Path::new(&file_path))?;
        }
        None => {
            // The chosen side deleted the file — the resolution is removal.
            // symlink_metadata, not exists(): a DANGLING symlink (common for
            // links into ignored/generated trees) reports exists()==false
            // and would survive on disk as an untracked leftover while the
            // UI says the file was deleted.
            if let Ok(meta) = std::fs::symlink_metadata(&full_path) {
                // A DIRECTORY here is a submodule worktree (gitlink
                // deletion) — git itself leaves it behind on `git rm`
                // of a submodule; never delete a whole tree from a
                // conflict resolution.
                if !meta.file_type().is_dir() {
                    std::fs::remove_file(&full_path)?;
                }
            }
            index.remove_path(Path::new(&file_path))?;
        }
    }
    index.write()?;

    Ok(())
}

/// Detect conflict markers in files
///
/// Scans for Git conflict markers (<<<<<<< ======= >>>>>>>) in working directory files.
/// If file_path is provided, only scans that file. Otherwise, scans all conflicted files.
#[command]
pub async fn detect_conflict_markers(
    path: String,
    file_path: Option<String>,
) -> Result<Vec<ConflictMarkerFile>> {
    let repo = git2::Repository::open(Path::new(&path))?;

    let files_to_check: Vec<String> = if let Some(fp) = file_path {
        vec![fp]
    } else {
        // Get all conflicted files from the index
        let index = repo.index()?;
        let mut conflict_paths = Vec::new();
        for conflict in index.conflicts()? {
            let conflict = conflict?;
            if let Some(entry) = conflict.our.or(conflict.their).or(conflict.ancestor) {
                let p = String::from_utf8_lossy(&entry.path).to_string();
                if !conflict_paths.contains(&p) {
                    conflict_paths.push(p);
                }
            }
        }
        conflict_paths
    };

    let mut result = Vec::new();

    for file in files_to_check {
        let full_path = match validate_path_within_repo(Path::new(&path), &file) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !full_path.exists() {
            continue;
        }

        let content = match std::fs::read_to_string(&full_path) {
            Ok(c) => c,
            Err(_) => continue, // Skip binary files or unreadable files
        };

        let markers = parse_conflict_markers(&content);
        if !markers.is_empty() {
            result.push(ConflictMarkerFile {
                path: file,
                conflict_count: markers.len() as u32,
                markers,
            });
        }
    }

    Ok(result)
}

/// Get detailed conflict information for a specific file
///
/// Returns conflict details including ref names and marker positions
#[command]
pub async fn get_conflict_details(path: String, file_path: String) -> Result<ConflictDetails> {
    let repo = git2::Repository::open(Path::new(&path))?;

    // Determine ref names based on repository state
    let (our_ref, their_ref, base_ref) = get_conflict_refs(&repo)?;

    // Read file content and parse markers
    let full_path = validate_path_within_repo(Path::new(&path), &file_path)?;
    let content = std::fs::read_to_string(&full_path)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to read file: {}", e)))?;

    let markers = parse_conflict_markers(&content);

    Ok(ConflictDetails {
        file_path,
        our_ref,
        their_ref,
        base_ref,
        markers,
    })
}

/// Parse conflict markers from file content
pub(super) fn parse_conflict_markers(content: &str) -> Vec<ConflictMarker> {
    let mut markers = Vec::new();
    let lines: Vec<&str> = content.lines().collect();

    let mut i = 0;
    while i < lines.len() {
        if lines[i].starts_with("<<<<<<<") {
            // Found start of conflict
            let start_line = i as u32 + 1; // 1-indexed
            let mut ours_content = String::new();
            let mut base_content: Option<String> = None;
            let mut theirs_content = String::new();
            let mut separator_line: Option<u32> = None;
            let mut end_line: Option<u32> = None;
            let mut in_base = false;

            i += 1;
            while i < lines.len() {
                let line = lines[i];

                if line.starts_with("|||||||") {
                    // diff3 style - base content marker
                    in_base = true;
                    base_content = Some(String::new());
                    i += 1;
                    continue;
                }

                if line.starts_with("=======") {
                    separator_line = Some(i as u32 + 1);
                    in_base = false;
                    i += 1;
                    continue;
                }

                if line.starts_with(">>>>>>>") {
                    end_line = Some(i as u32 + 1);
                    break;
                }

                if separator_line.is_some() {
                    // After separator, collecting theirs content
                    if !theirs_content.is_empty() {
                        theirs_content.push('\n');
                    }
                    theirs_content.push_str(line);
                } else if in_base {
                    // In base section (diff3 style)
                    if let Some(ref mut base) = base_content {
                        if !base.is_empty() {
                            base.push('\n');
                        }
                        base.push_str(line);
                    }
                } else {
                    // Before separator, collecting ours content
                    if !ours_content.is_empty() {
                        ours_content.push('\n');
                    }
                    ours_content.push_str(line);
                }

                i += 1;
            }

            if let (Some(sep), Some(end)) = (separator_line, end_line) {
                markers.push(ConflictMarker {
                    start_line,
                    separator_line: sep,
                    end_line: end,
                    ours_content,
                    theirs_content,
                    base_content,
                });
            }
        }
        i += 1;
    }

    markers
}

/// Get the ref names for conflicts based on repository state
fn get_conflict_refs(repo: &git2::Repository) -> Result<(String, String, Option<String>)> {
    let state = repo.state();

    match state {
        git2::RepositoryState::Merge => {
            // Read MERGE_HEAD for their ref
            let merge_head_path = repo.path().join("MERGE_HEAD");
            let their_ref = if merge_head_path.exists() {
                std::fs::read_to_string(&merge_head_path)
                    .map(|s| s.trim().to_string())
                    .unwrap_or_else(|_| "MERGE_HEAD".to_string())
            } else {
                "MERGE_HEAD".to_string()
            };

            // Try to get MERGE_MSG for more context
            let merge_msg_path = repo.path().join("MERGE_MSG");
            let their_ref = if let Ok(msg) = std::fs::read_to_string(&merge_msg_path) {
                // Parse branch name from merge message like "Merge branch 'feature' into main"
                if let Some(branch) = parse_merge_branch_from_msg(&msg) {
                    branch
                } else if their_ref.len() > 7 {
                    their_ref[..7].to_string()
                } else {
                    their_ref
                }
            } else if their_ref.len() > 7 {
                their_ref[..7].to_string()
            } else {
                their_ref
            };

            let our_ref = get_head_name(repo);

            Ok((our_ref, their_ref, None))
        }
        git2::RepositoryState::Rebase
        | git2::RepositoryState::RebaseInteractive
        | git2::RepositoryState::RebaseMerge => {
            // During rebase, HEAD is the rebased branch, and we're applying commits from another branch
            let rebase_dir = if repo.path().join("rebase-merge").exists() {
                repo.path().join("rebase-merge")
            } else {
                repo.path().join("rebase-apply")
            };

            let their_ref = std::fs::read_to_string(rebase_dir.join("head-name"))
                .map(|s| s.trim().replace("refs/heads/", ""))
                .unwrap_or_else(|_| "HEAD".to_string());

            let our_ref = std::fs::read_to_string(rebase_dir.join("onto"))
                .map(|s| {
                    let oid = s.trim();
                    if oid.len() > 7 {
                        oid[..7].to_string()
                    } else {
                        oid.to_string()
                    }
                })
                .unwrap_or_else(|_| "onto".to_string());

            Ok((our_ref, their_ref, None))
        }
        git2::RepositoryState::CherryPick => {
            let our_ref = get_head_name(repo);
            let cherry_pick_head = repo.path().join("CHERRY_PICK_HEAD");
            let their_ref = std::fs::read_to_string(&cherry_pick_head)
                .map(|s| {
                    let oid = s.trim();
                    if oid.len() > 7 {
                        oid[..7].to_string()
                    } else {
                        oid.to_string()
                    }
                })
                .unwrap_or_else(|_| "CHERRY_PICK_HEAD".to_string());

            Ok((our_ref, their_ref, None))
        }
        git2::RepositoryState::Revert => {
            let our_ref = get_head_name(repo);
            let revert_head = repo.path().join("REVERT_HEAD");
            let their_ref = std::fs::read_to_string(&revert_head)
                .map(|s| {
                    let oid = s.trim();
                    if oid.len() > 7 {
                        oid[..7].to_string()
                    } else {
                        oid.to_string()
                    }
                })
                .unwrap_or_else(|_| "REVERT_HEAD".to_string());

            Ok((our_ref, their_ref, None))
        }
        _ => {
            // Default to HEAD for our ref
            let our_ref = get_head_name(repo);
            Ok((our_ref, "incoming".to_string(), None))
        }
    }
}

/// Get a human-readable name for HEAD
fn get_head_name(repo: &git2::Repository) -> String {
    match repo.head() {
        Ok(head) => {
            if head.is_branch() {
                head.shorthand().unwrap_or("HEAD").to_string()
            } else if let Some(oid) = head.target() {
                let oid_str = oid.to_string();
                if oid_str.len() > 7 {
                    oid_str[..7].to_string()
                } else {
                    oid_str
                }
            } else {
                "HEAD".to_string()
            }
        }
        Err(_) => "HEAD".to_string(),
    }
}

/// Parse branch name from merge commit message
pub(super) fn parse_merge_branch_from_msg(msg: &str) -> Option<String> {
    // Common patterns:
    // "Merge branch 'feature' into main"
    // "Merge branch 'feature/something' into develop"
    // "Merge remote-tracking branch 'origin/feature'"
    let first_line = msg.lines().next()?;

    if first_line.starts_with("Merge branch '") {
        let start = "Merge branch '".len();
        let rest = &first_line[start..];
        if let Some(end) = rest.find('\'') {
            return Some(rest[..end].to_string());
        }
    }

    if first_line.starts_with("Merge remote-tracking branch '") {
        let start = "Merge remote-tracking branch '".len();
        let rest = &first_line[start..];
        if let Some(end) = rest.find('\'') {
            return Some(rest[..end].to_string());
        }
    }

    None
}
