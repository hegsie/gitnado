//! Hunk-Level AI Staging (#619) and AI Fixup Targeting (#620)
//!
//! Provides commands for:
//! - Grouping unstaged/staged diff hunks into logical atomic commits (including
//!   splitting hunks from a single file across multiple commits) and staging a
//!   selected hunk group directly into the git index.
//! - Suggesting `fixup!` target commits by combining deterministic hunk/line
//!   overlap analysis (`git absorb`-style) with optional AI rationale and
//!   reranking.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::Path;

use git2::{BranchType, DiffOptions, Patch, Repository};
use serde::{Deserialize, Serialize};
use tauri::{command, State};

use crate::services::ai::{truncate_at_char_boundary, AiService, AiState, MAX_DIFF_BYTES};
use crate::utils::create_command;

/// Reference to a specific diff hunk within a file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HunkRef {
    pub file_path: String,
    pub hunk_index: usize,
    pub header: String,
    pub summary: String,
}

/// A logical atomic commit group containing one or more hunks.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiHunkSplitGroup {
    pub commit_message: String,
    pub description: String,
    pub hunks: Vec<HunkRef>,
}

/// Suggested commit target for a `fixup!` commit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FixupTargetSuggestion {
    pub commit_oid: String,
    pub short_oid: String,
    pub commit_summary: String,
    pub author: String,
    pub confidence: f32,
    pub overlapping_files: Vec<String>,
    pub overlapping_hunks: usize,
    pub rationale: String,
}

/// Internal representation of an extracted diff hunk.
#[derive(Debug, Clone)]
struct ExtractedHunk {
    file_path: String,
    hunk_index: usize,
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
    header: String,
    summary: String,
    lines: Vec<(char, String)>,
    snippet: String,
    from_staged: bool,
}

const HUNK_SPLIT_SYSTEM_PROMPT: &str = r#"You are a git staging assistant that groups diff hunks into logical, atomic commits.
You will receive a numbered list of diff hunks across modified files. Note that different hunks within the SAME file may belong to different logical commits (for example, a bug fix and an unrelated refactor in the same file).

Return ONLY a JSON array (no markdown fences) with this structure:
[
  {
    "commitMessage": "type(scope): concise imperative summary",
    "description": "Brief explanation of why these hunks belong together",
    "hunks": [
      { "filePath": "path/to/file", "hunkIndex": 0 }
    ]
  }
]

Rules:
- Every input hunk must appear in exactly one group
- Use conventional commit format (feat:, fix:, refactor:, test:, docs:, chore:) for commitMessage
- Keep commitMessage under 72 characters
- Split hunks from the same file into separate groups when they address distinct concerns
"#;

const FIXUP_TARGET_SYSTEM_PROMPT: &str = r#"You are a git history assistant helping identify the best recent commit to target with `git commit --fixup`.
You will receive a summary of the current uncommitted changes and a list of candidate recent commits with their deterministic line-overlap scores.

Return ONLY a JSON array (no markdown fences) with this structure:
[
  {
    "commitOid": "full_commit_oid",
    "confidence": 0.92,
    "rationale": "Concise explanation of why the current changes belong as a fixup to this commit"
  }
]

Rules:
- Preserve only the provided commitOid values
- Confidence must be a float between 0.0 and 1.0
- Keep each rationale to one concise sentence
"#;

/// Enforce the outbound network security gate for the active AI provider.
fn guard_ai_request(service: &AiService) -> Result<(), String> {
    match service.active_provider_endpoint() {
        Some(endpoint) => {
            crate::services::security::guard_endpoint(&endpoint).map_err(|e| e.to_string())
        }
        None => Ok(()),
    }
}

/// Strip markdown code fences if present around JSON output.
fn strip_code_fences(s: &str) -> &str {
    let trimmed = s.trim();
    if trimmed.starts_with("```") {
        let inner = trimmed
            .strip_prefix("```json")
            .or_else(|| trimmed.strip_prefix("```"))
            .unwrap_or(trimmed);
        inner.strip_suffix("```").unwrap_or(inner).trim()
    } else {
        trimmed
    }
}

/// Summarize a hunk's lines into a human-readable one-line preview.
fn summarize_hunk_lines(header: &str, lines: &[(char, String)]) -> String {
    let mut additions = 0usize;
    let mut deletions = 0usize;
    let mut first_meaningful: Option<String> = None;

    for (origin, content) in lines {
        match *origin {
            '+' => {
                additions += 1;
                if first_meaningful.is_none() {
                    let trimmed = content.trim();
                    if !trimmed.is_empty() {
                        first_meaningful = Some(trimmed.chars().take(60).collect());
                    }
                }
            }
            '-' => {
                deletions += 1;
                if first_meaningful.is_none() {
                    let trimmed = content.trim();
                    if !trimmed.is_empty() {
                        first_meaningful = Some(trimmed.chars().take(60).collect());
                    }
                }
            }
            _ => {}
        }
    }

    let context_hint = header
        .split("@@")
        .nth(2)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    match (context_hint, first_meaningful) {
        (Some(ctx), Some(preview)) => {
            format!("+{additions}/-{deletions} in `{ctx}`: {preview}")
        }
        (None, Some(preview)) => format!("+{additions}/-{deletions}: {preview}"),
        (Some(ctx), None) => format!("+{additions}/-{deletions} in `{ctx}`"),
        (None, None) => format!("+{additions}/-{deletions} lines"),
    }
}

/// Extract hunks from a `git2::Diff`.
fn collect_hunks_from_diff(
    diff: &git2::Diff<'_>,
    from_staged: bool,
    per_file_counts: &mut BTreeMap<String, usize>,
) -> Vec<ExtractedHunk> {
    let mut extracted = Vec::new();
    let num_deltas = diff.deltas().len();

    for delta_idx in 0..num_deltas {
        let Some(delta) = diff.get_delta(delta_idx) else {
            continue;
        };
        let file_path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if file_path.is_empty() {
            continue;
        }

        let Ok(Some(patch)) = Patch::from_diff(diff, delta_idx) else {
            continue;
        };

        let num_hunks = patch.num_hunks();
        for local_hunk_idx in 0..num_hunks {
            let Ok((hunk, num_lines)) = patch.hunk(local_hunk_idx) else {
                continue;
            };

            let header = String::from_utf8_lossy(hunk.header()).trim().to_string();
            let mut lines = Vec::new();
            let mut snippet = String::new();

            for line_idx in 0..num_lines {
                if let Ok(diff_line) = patch.line_in_hunk(local_hunk_idx, line_idx) {
                    let origin = diff_line.origin();
                    if matches!(origin, '+' | '-' | ' ') {
                        let content = String::from_utf8_lossy(diff_line.content()).to_string();
                        if snippet.len() < 600 {
                            snippet.push(origin);
                            snippet.push_str(&content);
                            if !content.ends_with('\n') {
                                snippet.push('\n');
                            }
                        }
                        lines.push((origin, content));
                    }
                }
            }

            let entry_idx = per_file_counts.entry(file_path.clone()).or_insert(0);
            let hunk_index = *entry_idx;
            *entry_idx += 1;

            let summary = summarize_hunk_lines(&header, &lines);

            extracted.push(ExtractedHunk {
                file_path: file_path.clone(),
                hunk_index,
                old_start: hunk.old_start(),
                old_lines: hunk.old_lines(),
                new_start: hunk.new_start(),
                new_lines: hunk.new_lines(),
                header,
                summary,
                lines,
                snippet,
                from_staged,
            });
        }
    }

    extracted
}

/// Extract all unstaged and staged hunks across modified files in the repository.
fn extract_all_repo_hunks(repo: &Repository) -> Result<Vec<ExtractedHunk>, String> {
    let mut per_file_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut all_hunks = Vec::new();

    // 1. Collect unstaged hunks (index -> workdir), including untracked text files.
    let mut workdir_opts = DiffOptions::new();
    workdir_opts
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);

    let index = repo.index().map_err(|e| e.to_string())?;
    let unstaged_diff = repo
        .diff_index_to_workdir(Some(&index), Some(&mut workdir_opts))
        .map_err(|e| e.to_string())?;
    all_hunks.extend(collect_hunks_from_diff(
        &unstaged_diff,
        false,
        &mut per_file_counts,
    ));

    // 2. Collect staged hunks (HEAD -> index) for any staged changes.
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut staged_opts = DiffOptions::new();
    let staged_diff = repo
        .diff_tree_to_index(head_tree.as_ref(), Some(&index), Some(&mut staged_opts))
        .map_err(|e| e.to_string())?;
    all_hunks.extend(collect_hunks_from_diff(
        &staged_diff,
        true,
        &mut per_file_counts,
    ));

    Ok(all_hunks)
}

/// Infer a conventional commit type and scope from a file path and hunk content.
fn infer_commit_prefix(file_path: &str, snippet: &str) -> (&'static str, String) {
    let lower_path = file_path.to_lowercase();
    let file_stem = Path::new(file_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| file_path.to_string());
    let scope = file_stem
        .trim_end_matches(".test")
        .trim_end_matches(".spec")
        .trim_end_matches("_test")
        .to_string();

    let commit_type = if lower_path.contains("test")
        || lower_path.contains("spec")
        || snippet.contains("#[test]")
        || snippet.contains("describe(")
    {
        "test"
    } else if lower_path.ends_with(".md") || lower_path.starts_with("docs/") {
        "docs"
    } else if lower_path.ends_with(".json")
        || lower_path.ends_with(".toml")
        || lower_path.ends_with(".yml")
        || lower_path.ends_with(".yaml")
    {
        "chore"
    } else if snippet.to_lowercase().contains("fix")
        || snippet.to_lowercase().contains("bug")
        || snippet.to_lowercase().contains("error")
    {
        "fix"
    } else {
        "feat"
    };

    (commit_type, scope)
}

/// Deterministic fallback grouping when no AI provider is available or the LLM
/// output is malformed.
///
/// Handles both multi-file repositories and single-file multi-hunk changes
/// (splitting distinct hunks in a single file into separate atomic groups).
fn deterministic_hunk_groups(hunks: &[ExtractedHunk]) -> Vec<AiHunkSplitGroup> {
    if hunks.is_empty() {
        return Vec::new();
    }

    let distinct_files: BTreeSet<&str> = hunks.iter().map(|h| h.file_path.as_str()).collect();

    // If a single file has multiple hunks, or if hunks within a file address
    // different concerns (e.g. test vs production code or distant line ranges),
    // split them into atomic hunk groups.
    let mut groups: Vec<AiHunkSplitGroup> = Vec::new();

    if distinct_files.len() == 1 && hunks.len() > 1 {
        for hunk in hunks {
            let (commit_type, scope) = infer_commit_prefix(&hunk.file_path, &hunk.snippet);
            let context_label = hunk
                .header
                .split("@@")
                .nth(2)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| format!("update {s}"))
                .unwrap_or_else(|| {
                    format!(
                        "update {} (lines {}-{})",
                        hunk.file_path,
                        hunk.new_start,
                        hunk.new_start + hunk.new_lines.saturating_sub(1)
                    )
                });
            let commit_message = if scope.is_empty() {
                format!("{commit_type}: {context_label}")
            } else {
                format!("{commit_type}({scope}): {context_label}")
            };

            groups.push(AiHunkSplitGroup {
                commit_message,
                description: format!("Atomic change in {} ({})", hunk.file_path, hunk.summary),
                hunks: vec![HunkRef {
                    file_path: hunk.file_path.clone(),
                    hunk_index: hunk.hunk_index,
                    header: hunk.header.clone(),
                    summary: hunk.summary.clone(),
                }],
            });
        }
        return groups;
    }

    // Group hunks by file and cluster distant or test-vs-impl hunks within each file.
    let mut by_file: BTreeMap<&str, Vec<&ExtractedHunk>> = BTreeMap::new();
    for hunk in hunks {
        by_file.entry(&hunk.file_path).or_default().push(hunk);
    }

    for (file_path, file_hunks) in by_file {
        let mut clusters: Vec<Vec<&ExtractedHunk>> = Vec::new();

        for hunk in file_hunks {
            let (hunk_type, _) = infer_commit_prefix(file_path, &hunk.snippet);
            let should_split_from_prev = clusters.last().is_some_and(|cluster| {
                let prev = cluster.last().unwrap();
                let (prev_type, _) = infer_commit_prefix(file_path, &prev.snippet);
                let prev_end = prev.old_start.saturating_add(prev.old_lines);
                let line_gap = hunk.old_start.saturating_sub(prev_end);
                hunk_type != prev_type || line_gap >= 25
            });

            if should_split_from_prev || clusters.is_empty() {
                clusters.push(vec![hunk]);
            } else if let Some(last) = clusters.last_mut() {
                last.push(hunk);
            }
        }

        let total_clusters = clusters.len();
        for (cluster_idx, cluster) in clusters.into_iter().enumerate() {
            let combined_snippet: String = cluster
                .iter()
                .map(|h| h.snippet.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let (commit_type, scope) = infer_commit_prefix(file_path, &combined_snippet);
            let suffix = if total_clusters > 1 {
                format!(" (part {})", cluster_idx + 1)
            } else {
                String::new()
            };
            let commit_message = if scope.is_empty() {
                format!("{commit_type}: update {file_path}{suffix}")
            } else {
                format!("{commit_type}({scope}): update {file_path}{suffix}")
            };

            let hunk_refs: Vec<HunkRef> = cluster
                .iter()
                .map(|h| HunkRef {
                    file_path: h.file_path.clone(),
                    hunk_index: h.hunk_index,
                    header: h.header.clone(),
                    summary: h.summary.clone(),
                })
                .collect();

            let description = format!(
                "{} hunk{} in {}",
                hunk_refs.len(),
                if hunk_refs.len() == 1 { "" } else { "s" },
                file_path
            );

            groups.push(AiHunkSplitGroup {
                commit_message,
                description,
                hunks: hunk_refs,
            });
        }
    }

    groups
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmHunkRef {
    file_path: String,
    hunk_index: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmHunkGroup {
    commit_message: String,
    #[serde(default)]
    description: String,
    hunks: Vec<LlmHunkRef>,
}

/// Parse LLM JSON output into validated `AiHunkSplitGroup`s against the real
/// repository hunks. Returns `None` if the JSON is malformed or produces no
/// valid hunk references.
fn parse_llm_hunk_groups(
    response: &str,
    extracted: &[ExtractedHunk],
) -> Option<Vec<AiHunkSplitGroup>> {
    let json_str = strip_code_fences(response);
    let parsed: Vec<LlmHunkGroup> = serde_json::from_str(json_str).ok()?;
    if parsed.is_empty() {
        return None;
    }

    let mut assigned: BTreeSet<(String, usize)> = BTreeSet::new();
    let mut groups: Vec<AiHunkSplitGroup> = Vec::new();

    for raw_group in parsed {
        let mut group_hunks = Vec::new();
        for raw_ref in raw_group.hunks {
            let key = (raw_ref.file_path.clone(), raw_ref.hunk_index);
            if assigned.contains(&key) {
                continue;
            }
            if let Some(found) = extracted
                .iter()
                .find(|h| h.file_path == raw_ref.file_path && h.hunk_index == raw_ref.hunk_index)
            {
                assigned.insert(key);
                group_hunks.push(HunkRef {
                    file_path: found.file_path.clone(),
                    hunk_index: found.hunk_index,
                    header: found.header.clone(),
                    summary: found.summary.clone(),
                });
            }
        }

        if !group_hunks.is_empty() {
            let commit_message = if raw_group.commit_message.trim().is_empty() {
                format!("chore: update {}", group_hunks[0].file_path)
            } else {
                raw_group.commit_message.trim().to_string()
            };
            let description = if raw_group.description.trim().is_empty() {
                format!("Grouped {} hunk(s)", group_hunks.len())
            } else {
                raw_group.description.trim().to_string()
            };
            groups.push(AiHunkSplitGroup {
                commit_message,
                description,
                hunks: group_hunks,
            });
        }
    }

    if groups.is_empty() {
        return None;
    }

    // Ensure no extracted hunk was left behind by the model.
    let unassigned: Vec<&ExtractedHunk> = extracted
        .iter()
        .filter(|h| !assigned.contains(&(h.file_path.clone(), h.hunk_index)))
        .collect();

    if !unassigned.is_empty() {
        let remaining_refs: Vec<HunkRef> = unassigned
            .into_iter()
            .map(|h| HunkRef {
                file_path: h.file_path.clone(),
                hunk_index: h.hunk_index,
                header: h.header.clone(),
                summary: h.summary.clone(),
            })
            .collect();
        groups.push(AiHunkSplitGroup {
            commit_message: format!(
                "chore: remaining changes in {}",
                remaining_refs[0].file_path
            ),
            description: "Additional unassigned hunks".to_string(),
            hunks: remaining_refs,
        });
    }

    Some(groups)
}

/// Suggest hunk-level atomic commit splits across modified files in the repository.
#[command]
pub async fn suggest_hunk_splits(
    state: State<'_, AiState>,
    path: String,
) -> Result<Vec<AiHunkSplitGroup>, String> {
    let repo_path = path.clone();
    let extracted = crate::utils::blocking_git(move || {
        let repo = Repository::open(Path::new(&repo_path))?;
        extract_all_repo_hunks(&repo).map_err(crate::error::GitnadoError::OperationFailed)
    })
    .await
    .map_err(|e| e.to_string())?;

    if extracted.is_empty() {
        return Ok(Vec::new());
    }

    // Build numbered hunk prompt for the AI provider.
    let mut prompt = String::new();
    for (global_idx, hunk) in extracted.iter().enumerate() {
        prompt.push_str(&format!(
            "Hunk #{global_idx}: file=\"{}\" hunkIndex={} header=\"{}\"\nSummary: {}\n```diff\n{}```\n\n",
            hunk.file_path, hunk.hunk_index, hunk.header, hunk.summary, hunk.snippet
        ));
    }
    let truncated_prompt = truncate_at_char_boundary(&prompt, MAX_DIFF_BYTES);

    let service = state.read().await;

    if guard_ai_request(&service).is_ok() && service.has_available_provider().await {
        if let Ok(response) = service
            .generate_text_for_feature(
                "suggest_hunk_splits",
                crate::services::ai::AiTaskTier::ReasoningMerge,
                HUNK_SPLIT_SYSTEM_PROMPT,
                truncated_prompt,
                Some(1500),
            )
            .await
        {
            if let Some(groups) = parse_llm_hunk_groups(&response, &extracted) {
                return Ok(groups);
            }
        }
    }

    Ok(deterministic_hunk_groups(&extracted))
}

/// Append one unified-diff line (`prefix` + `content`) to `patch`, preserving
/// missing-EOF-newline markers.
fn push_diff_line(patch: &mut String, prefix: char, content: &str) {
    patch.push(prefix);
    patch.push_str(content);
    if content.ends_with('\n') {
        return;
    }
    patch.push('\n');
    patch.push_str("\\ No newline at end of file\n");
}

/// Build a unified diff patch for a set of hunks belonging to `file_path`.
fn build_file_hunks_patch(file_path: &str, hunks: &[&ExtractedHunk]) -> String {
    let mut sorted: Vec<&ExtractedHunk> = hunks.to_vec();
    sorted.sort_by_key(|h| (h.old_start, h.new_start, h.hunk_index));

    let is_new_file = sorted
        .first()
        .is_some_and(|h| h.old_start == 0 && h.old_lines == 0);
    let is_deleted_file = sorted
        .first()
        .is_some_and(|h| h.new_start == 0 && h.new_lines == 0);

    let mut patch = String::new();
    if is_new_file {
        patch.push_str("new file mode 100644\n");
        patch.push_str("--- /dev/null\n");
        patch.push_str(&format!("+++ b/{file_path}\n"));
    } else if is_deleted_file {
        patch.push_str("deleted file mode 100644\n");
        patch.push_str(&format!("--- a/{file_path}\n"));
        patch.push_str("+++ /dev/null\n");
    } else {
        patch.push_str(&format!("--- a/{file_path}\n"));
        patch.push_str(&format!("+++ b/{file_path}\n"));
    }

    let mut cumulative_delta: i64 = 0;
    for hunk in sorted {
        let adjusted_new_start = if is_new_file {
            hunk.new_start
        } else if is_deleted_file {
            0
        } else {
            ((hunk.old_start as i64) + cumulative_delta).max(1) as u32
        };

        patch.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            hunk.old_start, hunk.old_lines, adjusted_new_start, hunk.new_lines
        ));

        for (origin, content) in &hunk.lines {
            push_diff_line(&mut patch, *origin, content);
        }

        cumulative_delta += (hunk.new_lines as i64) - (hunk.old_lines as i64);
    }

    patch
}

/// Apply a unified diff patch string to the repository's index using
/// `git apply --cached --unidiff-zero`.
fn apply_patch_to_index(repo_path: &str, patch: &str) -> Result<(), String> {
    let mut tmp = tempfile::Builder::new()
        .prefix("gitnado_ai_hunk_")
        .suffix(".patch")
        .tempfile()
        .map_err(|e| format!("Failed to create temporary patch file: {e}"))?;
    tmp.write_all(patch.as_bytes())
        .map_err(|e| format!("Failed to write patch file: {e}"))?;
    tmp.flush()
        .map_err(|e| format!("Failed to flush patch file: {e}"))?;

    let output = create_command("git")
        .args(["apply", "--cached", "--unidiff-zero"])
        .arg(tmp.path())
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to invoke git apply: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to stage hunk group: {}", stderr.trim()));
    }

    Ok(())
}

/// Extract `(new_start, new_lines)` from a unified diff hunk header (`@@ -a,b +c,d @@`).
///
/// When an earlier hunk in the same file is staged into the index, the index (`-a,b`)
/// line numbers of later unstaged hunks shift, whereas the working-tree (`+c,d`) line
/// numbers remain unchanged.
fn parse_new_range_from_header(header: &str) -> Option<(u32, u32)> {
    let body = header.strip_prefix("@@")?.split("@@").next()?.trim();
    let plus_part = body.split_whitespace().find(|tok| tok.starts_with('+'))?;
    let nums = plus_part.strip_prefix('+')?;
    if let Some((start_str, count_str)) = nums.split_once(',') {
        Some((start_str.parse().ok()?, count_str.parse().ok()?))
    } else {
        Some((nums.parse().ok()?, 1))
    }
}

/// Match a requested `HunkRef` against the extracted hunks of `file_path`.
fn find_matching_hunk<'a>(
    candidates: &'a [&'a ExtractedHunk],
    target: &HunkRef,
    already_picked: &BTreeSet<usize>,
) -> Option<&'a ExtractedHunk> {
    // 1. Exact index match when header is empty or matches.
    if let Some(exact) = candidates.iter().copied().find(|h| {
        h.hunk_index == target.hunk_index
            && !already_picked.contains(&h.hunk_index)
            && (target.header.is_empty() || h.header == target.header)
    }) {
        return Some(exact);
    }

    if !target.header.is_empty() {
        // 2. Match by exact header string (handles shifted hunk indices when an earlier
        //    group had net-zero line delta).
        if let Some(by_header) = candidates.iter().copied().find(|h| {
            !already_picked.contains(&h.hunk_index)
                && (h.header == target.header || h.header.starts_with(target.header.trim()))
        }) {
            return Some(by_header);
        }

        // 3. Match by working-tree (`+new_start,new_lines`) range, which is invariant
        //    when earlier hunks in the same file are staged into the index and shift `-old_start`.
        if let Some((new_start, new_lines)) = parse_new_range_from_header(&target.header) {
            if let Some(by_new_range) = candidates.iter().copied().find(|h| {
                !already_picked.contains(&h.hunk_index)
                    && h.new_start == new_start
                    && h.new_lines == new_lines
            }) {
                return Some(by_new_range);
            }
        }

        return None;
    }

    // 4. Only when no header was provided, match by index.
    candidates
        .iter()
        .copied()
        .find(|h| h.hunk_index == target.hunk_index && !already_picked.contains(&h.hunk_index))
}

/// Reset a single path in the index back to HEAD (or remove if unborn/new).
fn reset_file_in_index(repo: &Repository, file_path: &str) -> Result<(), String> {
    let path_obj = Path::new(file_path);
    let head_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let mut index = repo.index().map_err(|e| e.to_string())?;

    match head_commit {
        Some(commit) => {
            let head_tree = commit.tree().map_err(|e| e.to_string())?;
            if head_tree.get_path(path_obj).is_ok() {
                repo.reset_default(Some(commit.as_object()), [path_obj])
                    .map_err(|e| e.to_string())?;
            } else {
                let _ = index.remove_path(path_obj);
                index.write().map_err(|e| e.to_string())?;
            }
        }
        None => {
            let _ = index.remove_path(path_obj);
            index.write().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Stage the specified hunks into the git index, returning the number of staged hunks.
#[command]
pub async fn stage_hunk_group(path: String, hunks: Vec<HunkRef>) -> Result<usize, String> {
    if hunks.is_empty() {
        return Ok(0);
    }

    crate::utils::blocking_git(move || {
        let repo_path = Path::new(&path);
        for hunk_ref in &hunks {
            super::path_utils::validate_path_within_repo(repo_path, &hunk_ref.file_path)?;
        }

        let repo = Repository::open(repo_path)?;
        let extracted =
            extract_all_repo_hunks(&repo).map_err(crate::error::GitnadoError::OperationFailed)?;

        // Group requested hunks by file_path while preserving order.
        let mut requested_by_file: BTreeMap<String, Vec<HunkRef>> = BTreeMap::new();
        for hunk in hunks {
            requested_by_file
                .entry(hunk.file_path.clone())
                .or_default()
                .push(hunk);
        }

        let mut total_staged = 0usize;

        for (file_path, target_refs) in &requested_by_file {
            let unstaged_candidates: Vec<&ExtractedHunk> = extracted
                .iter()
                .filter(|h| &h.file_path == file_path && !h.from_staged)
                .collect();

            if !unstaged_candidates.is_empty() {
                let mut picked_indices = BTreeSet::new();
                let mut chosen: Vec<&ExtractedHunk> = Vec::new();

                for target in target_refs {
                    let matched = find_matching_hunk(&unstaged_candidates, target, &picked_indices)
                        .ok_or_else(|| {
                            crate::error::GitnadoError::OperationFailed(format!(
                                "Hunk index {} not found in unstaged diff for {}",
                                target.hunk_index, file_path
                            ))
                        })?;
                    picked_indices.insert(matched.hunk_index);
                    chosen.push(matched);
                }

                let patch = build_file_hunks_patch(file_path, &chosen);
                apply_patch_to_index(&path, &patch)
                    .map_err(crate::error::GitnadoError::OperationFailed)?;
                total_staged += chosen.len();
            } else {
                // Hunks for this file were already staged in the index; reset the
                // file in the index to HEAD and stage only the selected hunks.
                let staged_candidates: Vec<&ExtractedHunk> = extracted
                    .iter()
                    .filter(|h| &h.file_path == file_path && h.from_staged)
                    .collect();

                if staged_candidates.is_empty() {
                    return Err(crate::error::GitnadoError::OperationFailed(format!(
                        "No diff hunks found for file {file_path}"
                    )));
                }

                let mut picked_indices = BTreeSet::new();
                let mut chosen: Vec<&ExtractedHunk> = Vec::new();
                for target in target_refs {
                    let matched = find_matching_hunk(&staged_candidates, target, &picked_indices)
                        .ok_or_else(|| {
                        crate::error::GitnadoError::OperationFailed(format!(
                            "Hunk index {} not found for {}",
                            target.hunk_index, file_path
                        ))
                    })?;
                    picked_indices.insert(matched.hunk_index);
                    chosen.push(matched);
                }

                reset_file_in_index(&repo, file_path)
                    .map_err(crate::error::GitnadoError::OperationFailed)?;
                let patch = build_file_hunks_patch(file_path, &chosen);
                apply_patch_to_index(&path, &patch)
                    .map_err(crate::error::GitnadoError::OperationFailed)?;
                total_staged += chosen.len();
            }
        }

        Ok(total_staged)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Line interval `(start, end)` (1-based inclusive) for overlap computation.
#[derive(Debug, Clone, Copy)]
struct LineSpan {
    start: u32,
    end: u32,
}

impl LineSpan {
    fn from_hunk(start: u32, count: u32) -> Self {
        let normalized_start = start.max(1);
        let normalized_end = normalized_start + count.max(1) - 1;
        Self {
            start: normalized_start,
            end: normalized_end,
        }
    }

    /// True if `self` overlaps `other` within `margin` context lines.
    fn overlaps(&self, other: &Self, margin: u32) -> bool {
        let a_start = self.start.saturating_sub(margin);
        let a_end = self.end.saturating_add(margin);
        a_start <= other.end && other.start <= a_end
    }
}

/// Collect active hunks for fixup analysis (staged changes first; falls back to
/// unstaged changes when nothing is staged).
fn collect_active_fixup_hunks(repo: &Repository) -> Result<(Vec<ExtractedHunk>, String), String> {
    let mut per_file_counts = BTreeMap::new();
    let index = repo.index().map_err(|e| e.to_string())?;
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());

    let staged_diff = repo
        .diff_tree_to_index(head_tree.as_ref(), Some(&index), None)
        .map_err(|e| e.to_string())?;
    let mut hunks = collect_hunks_from_diff(&staged_diff, true, &mut per_file_counts);

    if hunks.is_empty() {
        let mut workdir_opts = DiffOptions::new();
        let unstaged_diff = repo
            .diff_index_to_workdir(Some(&index), Some(&mut workdir_opts))
            .map_err(|e| e.to_string())?;
        hunks = collect_hunks_from_diff(&unstaged_diff, false, &mut per_file_counts);
    }

    let mut summary = String::new();
    for h in &hunks {
        summary.push_str(&format!(
            "File: {} ({})\n{}\n",
            h.file_path, h.header, h.snippet
        ));
    }

    Ok((hunks, summary))
}

/// Compute deterministic `FixupTargetSuggestion` candidates by walking recent
/// commits on the current branch and measuring file and line-range overlap.
fn compute_fixup_candidates(
    repo: &Repository,
    active_hunks: &[ExtractedHunk],
    max_commits: usize,
) -> Result<Vec<FixupTargetSuggestion>, String> {
    if active_hunks.is_empty() || max_commits == 0 {
        return Ok(Vec::new());
    }

    let head = repo
        .head()
        .map_err(|_| "Repository has no commits yet".to_string())?;
    let head_oid = head
        .target()
        .ok_or_else(|| "HEAD does not point to a commit".to_string())?;

    // Map each active file to its modified old/new line spans.
    let mut active_by_file: BTreeMap<String, Vec<LineSpan>> = BTreeMap::new();
    for hunk in active_hunks {
        active_by_file
            .entry(hunk.file_path.clone())
            .or_default()
            .push(LineSpan::from_hunk(hunk.old_start, hunk.old_lines));
    }

    let total_active_files = active_by_file.len().max(1);
    let total_active_hunks = active_hunks.len().max(1);

    // Check if the current branch has an upstream tracking branch with unpushed commits.
    let upstream_oid = if head.is_branch() {
        head.shorthand()
            .ok()
            .and_then(|name| repo.find_branch(name, BranchType::Local).ok())
            .and_then(|b| b.upstream().ok())
            .and_then(|u| u.get().target())
            .filter(|&u_oid| u_oid != head_oid)
    } else {
        None
    };

    let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
    walk.push(head_oid).map_err(|e| e.to_string())?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(|e| e.to_string())?;
    if let Some(u_oid) = upstream_oid {
        let _ = walk.hide(u_oid);
    }

    let mut suggestions: Vec<FixupTargetSuggestion> = Vec::new();

    for (distance, oid_res) in walk.take(max_commits).enumerate() {
        let oid = oid_res.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;

        // Skip merge commits (cannot cleanly fixup a merge commit).
        if commit.parent_count() > 1 {
            continue;
        }

        let commit_summary = commit
            .summary()
            .ok()
            .flatten()
            .unwrap_or("")
            .trim()
            .to_string();
        let author = commit.author().name().unwrap_or("Unknown").to_string();
        let commit_oid = oid.to_string();
        let short_oid = commit_oid.chars().take(7).collect::<String>();

        let commit_tree = commit.tree().map_err(|e| e.to_string())?;
        let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
        let diff = repo
            .diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)
            .map_err(|e| e.to_string())?;

        let mut overlapping_files_set: BTreeSet<String> = BTreeSet::new();
        let mut overlapping_hunks_count = 0usize;
        let mut exact_line_overlaps = 0usize;

        let num_deltas = diff.deltas().len();
        for delta_idx in 0..num_deltas {
            let Some(delta) = diff.get_delta(delta_idx) else {
                continue;
            };
            let path_str = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();

            let Some(active_spans) = active_by_file.get(&path_str) else {
                continue;
            };

            overlapping_files_set.insert(path_str);

            if let Ok(Some(patch)) = Patch::from_diff(&diff, delta_idx) {
                let mut commit_spans = Vec::new();
                for h_idx in 0..patch.num_hunks() {
                    if let Ok((hunk, _)) = patch.hunk(h_idx) {
                        commit_spans.push(LineSpan::from_hunk(hunk.new_start(), hunk.new_lines()));
                        commit_spans.push(LineSpan::from_hunk(hunk.old_start(), hunk.old_lines()));
                    }
                }

                for active_span in active_spans {
                    if commit_spans.iter().any(|cs| active_span.overlaps(cs, 0)) {
                        overlapping_hunks_count += 1;
                        exact_line_overlaps += 1;
                    } else if commit_spans.iter().any(|cs| active_span.overlaps(cs, 4)) {
                        overlapping_hunks_count += 1;
                    }
                }
            }
        }

        if overlapping_files_set.is_empty() {
            continue;
        }

        let overlapping_files: Vec<String> = overlapping_files_set.into_iter().collect();
        let file_ratio = (overlapping_files.len() as f32) / (total_active_files as f32);
        let hunk_ratio = ((overlapping_hunks_count as f32) / (total_active_hunks as f32)).min(1.0);
        let recency = (1.0 - (distance as f32) * 0.03).clamp(0.6, 1.0);

        let mut confidence = if overlapping_hunks_count > 0 {
            let exact_bonus = if exact_line_overlaps > 0 { 0.08 } else { 0.0 };
            (0.50 * hunk_ratio + 0.30 * file_ratio + 0.12 * recency + exact_bonus).clamp(0.50, 0.98)
        } else {
            (0.32 * file_ratio + 0.12 * recency).clamp(0.10, 0.48)
        };

        // Down-rank commits that are already fixup!/squash! commits.
        if commit_summary.starts_with("fixup!") || commit_summary.starts_with("squash!") {
            confidence = (confidence * 0.5).clamp(0.05, 0.45);
        }

        let rationale = if overlapping_hunks_count > 0 {
            format!(
                "Modifies {} overlapping hunk{} in {} introduced by `{}` ({})",
                overlapping_hunks_count,
                if overlapping_hunks_count == 1 {
                    ""
                } else {
                    "s"
                },
                overlapping_files.join(", "),
                short_oid,
                commit_summary
            )
        } else {
            format!(
                "Touches the same file{} ({}) in non-overlapping line ranges",
                if overlapping_files.len() == 1 {
                    ""
                } else {
                    "s"
                },
                overlapping_files.join(", ")
            )
        };

        suggestions.push(FixupTargetSuggestion {
            commit_oid,
            short_oid,
            commit_summary,
            author,
            confidence,
            overlapping_files,
            overlapping_hunks: overlapping_hunks_count,
            rationale,
        });
    }

    suggestions.sort_by(|a, b| {
        b.overlapping_hunks
            .cmp(&a.overlapping_hunks)
            .then_with(|| b.overlapping_files.len().cmp(&a.overlapping_files.len()))
            .then_with(|| {
                b.confidence
                    .partial_cmp(&a.confidence)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    Ok(suggestions)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmFixupRerank {
    commit_oid: String,
    confidence: f32,
    rationale: String,
}

/// Apply optional LLM rationale and confidence adjustments onto the
/// deterministic candidates.
fn apply_llm_fixup_enrichment(candidates: &mut [FixupTargetSuggestion], response: &str) {
    let json_str = strip_code_fences(response);
    let Ok(reranks) = serde_json::from_str::<Vec<LlmFixupRerank>>(json_str) else {
        return;
    };

    for item in reranks {
        if let Some(target) = candidates.iter_mut().find(|c| {
            c.commit_oid == item.commit_oid
                || c.short_oid == item.commit_oid
                || c.commit_oid.starts_with(&item.commit_oid)
        }) {
            if !item.rationale.trim().is_empty() {
                target.rationale = item.rationale.trim().to_string();
            }
            // Blend deterministic overlap confidence with AI confidence so line
            // overlap accuracy is preserved.
            let ai_conf = item.confidence.clamp(0.0, 1.0);
            target.confidence = (0.65 * target.confidence + 0.35 * ai_conf).clamp(0.0, 1.0);
        }
    }

    candidates.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.overlapping_hunks.cmp(&a.overlapping_hunks))
    });
}

/// Suggest target commits for a `fixup!` commit by combining `git absorb`-style
/// hunk/line overlap scoring with optional AI rationale enrichment.
#[command]
pub async fn suggest_fixup_targets(
    state: State<'_, AiState>,
    path: String,
    max_commits: Option<usize>,
) -> Result<Vec<FixupTargetSuggestion>, String> {
    let limit = max_commits.unwrap_or(15);
    let repo_path = path.clone();

    let (mut candidates, diff_summary) = crate::utils::blocking_git(move || {
        let repo = Repository::open(Path::new(&repo_path))?;
        let (active_hunks, summary) = collect_active_fixup_hunks(&repo)
            .map_err(crate::error::GitnadoError::OperationFailed)?;
        let candidates = compute_fixup_candidates(&repo, &active_hunks, limit)
            .map_err(crate::error::GitnadoError::OperationFailed)?;
        Ok((candidates, summary))
    })
    .await
    .map_err(|e| e.to_string())?;

    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let service = state.read().await;

    if guard_ai_request(&service).is_ok() && service.has_available_provider().await {
        let mut user_prompt = String::from("Current uncommitted changes:\n");
        user_prompt.push_str(truncate_at_char_boundary(&diff_summary, MAX_DIFF_BYTES / 2));
        user_prompt.push_str("\n\nCandidate recent commits:\n");
        for c in candidates.iter().take(8) {
            user_prompt.push_str(&format!(
                "- commitOid={} shortOid={} summary=\"{}\" overlappingFiles=[{}] overlappingHunks={} deterministicConfidence={:.2}\n",
                c.commit_oid,
                c.short_oid,
                c.commit_summary,
                c.overlapping_files.join(", "),
                c.overlapping_hunks,
                c.confidence
            ));
        }

        if let Ok(response) = service
            .generate_text_for_feature(
                "suggest_fixup_targets",
                crate::services::ai::AiTaskTier::ReasoningMerge,
                FIXUP_TARGET_SYSTEM_PROMPT,
                &user_prompt,
                Some(800),
            )
            .await
        {
            apply_llm_fixup_enrichment(&mut candidates, &response);
        }
    }

    Ok(candidates)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::ai::create_ai_state;
    use crate::test_utils::TestRepo;

    #[test]
    fn test_extract_all_repo_hunks_multiple_hunks_in_single_file() {
        let test_repo = TestRepo::with_initial_commit();
        let mut initial_lines = Vec::new();
        for i in 1..=30 {
            initial_lines.push(format!("line {i}"));
        }
        test_repo.create_commit(
            "Add multi-line file",
            &[("src/module.rs", &(initial_lines.join("\n") + "\n"))],
        );

        // Modify line 2 and line 28 to produce 2 separate hunks in src/module.rs.
        let mut modified_lines = initial_lines.clone();
        modified_lines[1] = "line 2 modified for bugfix".to_string();
        modified_lines[27] = "line 28 modified for feature".to_string();
        test_repo.create_file("src/module.rs", &(modified_lines.join("\n") + "\n"));

        let repo = test_repo.repo();
        let hunks = extract_all_repo_hunks(&repo).expect("should extract hunks");
        assert_eq!(hunks.len(), 2, "expected 2 separate hunks in src/module.rs");
        assert_eq!(hunks[0].file_path, "src/module.rs");
        assert_eq!(hunks[0].hunk_index, 0);
        assert_eq!(hunks[1].file_path, "src/module.rs");
        assert_eq!(hunks[1].hunk_index, 1);

        // Deterministic split should separate the 2 hunks into 2 atomic groups.
        let groups = deterministic_hunk_groups(&hunks);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].hunks.len(), 1);
        assert_eq!(groups[0].hunks[0].hunk_index, 0);
        assert_eq!(groups[1].hunks.len(), 1);
        assert_eq!(groups[1].hunks[0].hunk_index, 1);
    }

    #[tokio::test]
    async fn test_stage_hunk_group_stages_selected_hunk_only() {
        let test_repo = TestRepo::with_initial_commit();
        let mut initial_lines = Vec::new();
        for i in 1..=30 {
            initial_lines.push(format!("line {i}"));
        }
        test_repo.create_commit(
            "Base file",
            &[("src/lib.rs", &(initial_lines.join("\n") + "\n"))],
        );

        let mut modified_lines = initial_lines.clone();
        modified_lines[1] = "line 2 updated in first hunk".to_string();
        modified_lines.insert(2, "extra line in first hunk".to_string());
        let last_idx = modified_lines.len() - 2;
        modified_lines[last_idx] = "line 29 updated in second hunk".to_string();
        test_repo.create_file("src/lib.rs", &(modified_lines.join("\n") + "\n"));

        let repo = test_repo.repo();
        let extracted = extract_all_repo_hunks(&repo).unwrap();
        assert_eq!(extracted.len(), 2);

        // Stage ONLY the second hunk (index 1) first to verify offset adjustment!
        let second_hunk_ref = HunkRef {
            file_path: "src/lib.rs".to_string(),
            hunk_index: 1,
            header: extracted[1].header.clone(),
            summary: extracted[1].summary.clone(),
        };

        let staged_count = stage_hunk_group(test_repo.path_str(), vec![second_hunk_ref])
            .await
            .expect("should stage second hunk cleanly");
        assert_eq!(staged_count, 1);

        // Verify the index contains the second hunk's change but NOT the first hunk's change.
        let repo = test_repo.repo();
        let head_tree = repo.head().unwrap().peel_to_tree().unwrap();
        let index = repo.index().unwrap();
        let staged_diff = repo
            .diff_tree_to_index(Some(&head_tree), Some(&index), None)
            .unwrap();
        let mut staged_counts = BTreeMap::new();
        let staged_hunks = collect_hunks_from_diff(&staged_diff, true, &mut staged_counts);
        assert_eq!(staged_hunks.len(), 1);
        assert!(staged_hunks[0]
            .snippet
            .contains("line 29 updated in second hunk"));
        assert!(!staged_hunks[0]
            .snippet
            .contains("line 2 updated in first hunk"));
    }

    #[test]
    fn test_suggest_fixup_targets_overlap_ranking() {
        let test_repo = TestRepo::with_initial_commit();
        let mut base_a = Vec::new();
        for i in 1..=30 {
            base_a.push(format!("alpha line {i}"));
        }
        test_repo.create_commit(
            "feat: initialize alpha and beta",
            &[
                ("src/alpha.rs", &(base_a.join("\n") + "\n")),
                ("src/beta.rs", "beta line 1\nbeta line 2\n"),
            ],
        );

        // Commit 1 modifies top of src/alpha.rs (lines 2..3).
        let mut alpha_v1 = base_a.clone();
        alpha_v1[1] = "alpha line 2 changed in commit 1".to_string();
        let commit1_oid = test_repo.create_commit(
            "feat(alpha): update header section",
            &[("src/alpha.rs", &(alpha_v1.join("\n") + "\n"))],
        );

        // Commit 2 modifies bottom of src/alpha.rs (line 28).
        let mut alpha_v2 = alpha_v1.clone();
        alpha_v2[27] = "alpha line 28 changed in commit 2".to_string();
        let commit2_oid = test_repo.create_commit(
            "feat(alpha): update footer section",
            &[("src/alpha.rs", &(alpha_v2.join("\n") + "\n"))],
        );

        // Commit 3 modifies unrelated src/beta.rs.
        let _commit3_oid = test_repo.create_commit(
            "feat(beta): tweak beta file",
            &[("src/beta.rs", "beta line 1\nbeta line 2 updated\n")],
        );

        // Now stage a change touching line 2 of src/alpha.rs (overlapping Commit 1's exact hunk!).
        let mut alpha_fixup = alpha_v2.clone();
        alpha_fixup[1] = "alpha line 2 fixed up for commit 1".to_string();
        test_repo.create_file("src/alpha.rs", &(alpha_fixup.join("\n") + "\n"));
        test_repo.stage_file("src/alpha.rs");

        let repo = test_repo.repo();
        let (active_hunks, _) = collect_active_fixup_hunks(&repo).unwrap();
        let suggestions = compute_fixup_candidates(&repo, &active_hunks, 15).unwrap();

        assert!(
            suggestions.len() >= 2,
            "should find overlapping commits for src/alpha.rs"
        );
        // Top suggestion must be Commit 1 because it touched line 2 (overlapping hunk),
        // even though Commit 2 is more recent and touched the same file at line 28!
        assert_eq!(suggestions[0].commit_oid, commit1_oid.to_string());
        assert!(suggestions[0].overlapping_hunks >= 1);
        assert_eq!(
            suggestions[0].overlapping_files,
            vec!["src/alpha.rs".to_string()]
        );

        // Commit 2 touched src/alpha.rs at line 28 (non-overlapping hunk), so it ranks lower.
        let commit2_entry = suggestions
            .iter()
            .find(|s| s.commit_oid == commit2_oid.to_string())
            .expect("commit 2 should also appear as file-level match");
        assert!(suggestions[0].confidence > commit2_entry.confidence);
    }

    #[test]
    fn test_parse_llm_hunk_groups_recovers_unassigned_hunks() {
        let extracted = vec![
            ExtractedHunk {
                file_path: "a.rs".to_string(),
                hunk_index: 0,
                old_start: 1,
                old_lines: 2,
                new_start: 1,
                new_lines: 3,
                header: "@@ -1,2 +1,3 @@".to_string(),
                summary: "+1/-0".to_string(),
                lines: vec![],
                snippet: "+one\n".to_string(),
                from_staged: false,
            },
            ExtractedHunk {
                file_path: "a.rs".to_string(),
                hunk_index: 1,
                old_start: 20,
                old_lines: 2,
                new_start: 21,
                new_lines: 3,
                header: "@@ -20,2 +21,3 @@".to_string(),
                summary: "+1/-0".to_string(),
                lines: vec![],
                snippet: "+two\n".to_string(),
                from_staged: false,
            },
        ];

        // Model only mentions hunk 0; parser must preserve hunk 1 in a fallback group.
        let llm_json = r#"```json
        [
          {
            "commitMessage": "feat: first hunk",
            "description": "First logical change",
            "hunks": [{ "filePath": "a.rs", "hunkIndex": 0 }]
          }
        ]
        ```"#;

        let groups = parse_llm_hunk_groups(llm_json, &extracted).expect("should parse");
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].commit_message, "feat: first hunk");
        assert_eq!(groups[0].hunks[0].hunk_index, 0);
        assert_eq!(groups[1].hunks[0].hunk_index, 1);

        // Confirm AiState can be constructed cleanly for command integration.
        let tmp = tempfile::TempDir::new().unwrap();
        let _ai_state = create_ai_state(tmp.path().to_path_buf());
    }
}
