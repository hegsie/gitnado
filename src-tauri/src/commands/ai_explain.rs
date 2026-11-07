//! AI "Explain Anything" (#621) and AI Branch & Stash Naming (#622) commands.
//!
//! Provides structured explanations for commits, branch comparisons, and
//! working tree changes, as well as AI-powered branch name and stash message
//! suggestions grounded in working tree diffs and repository conventions.

use crate::services::ai::{
    truncate_at_char_boundary, AiProviderType, AiService, AiState, MAX_DIFF_BYTES,
};
use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Emitter, State};

/// Structured AI explanation for a commit, branch comparison, or working tree diff.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiExplanation {
    pub title: String,
    pub summary: String,
    pub intent: String,
    pub key_changes: Vec<String>,
    pub risks: Vec<String>,
    pub provider_used: String,
    pub is_local: bool,
}

/// Event payload emitted during streaming explanation generation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiExplainTokenPayload {
    pub target_id: String,
    pub token: String,
    pub done: bool,
}

/// AI-generated branch name suggestion and alternatives.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchNameSuggestion {
    pub name: String,
    pub alternatives: Vec<String>,
    pub rationale: String,
}

/// Raw JSON shape parsed from the model before attaching provider metadata.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAiExplanation {
    #[serde(default)]
    title: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    intent: String,
    #[serde(default)]
    key_changes: Vec<String>,
    #[serde(default)]
    risks: Vec<String>,
}

/// Raw JSON shape parsed from the model for branch naming.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawBranchNameSuggestion {
    #[serde(default)]
    name: String,
    #[serde(default)]
    alternatives: Vec<String>,
    #[serde(default)]
    rationale: String,
}

const EXPLAIN_SYSTEM_PROMPT: &str = r#"You are a senior software engineer explaining git changes clearly and concisely.
Analyze the provided git target metadata, changed files, and diff context.

Return ONLY a valid JSON object (no markdown code fences) with this exact schema:
{
  "title": "short headline summarizing the change (under 70 chars)",
  "intent": "1-2 sentences explaining WHY this change was made and the problem it solves",
  "summary": "2-3 sentences explaining WHAT changed at a high level",
  "keyChanges": ["concise bullet point for each notable technical change"],
  "risks": ["potential side effects, edge cases, migration concerns, or 'None identified — low-risk change'"]
}

Rules:
- Focus on architectural intent and semantic behavior rather than repeating line-by-line diffs
- Keep `keyChanges` to 2-6 crisp, high-signal bullets
- Keep `risks` realistic and grounded in the diff (1-4 bullets)"#;

const BRANCH_NAME_SYSTEM_PROMPT: &str = r#"You are a git workflow assistant that suggests clean, conventional git branch names from working tree diffs.

Return ONLY a valid JSON object (no markdown code fences) with this exact schema:
{
  "name": "feat/short-kebab-slug",
  "alternatives": ["fix/alternative-slug", "refactor/another-option"],
  "rationale": "One concise sentence explaining why this branch name fits the changes."
}

Rules:
- Always prefix with a conventional category such as `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, or `chore/`
- Use lowercase ASCII letters, digits, and single hyphens inside the slug (e.g. `feat/ai-explain-drawer`)
- Keep the total branch name under 45 characters
- Provide 2-3 distinct, meaningful alternatives"#;

const STASH_MESSAGE_SYSTEM_PROMPT: &str = r#"Generate a single concise, descriptive git stash message for the following working tree changes.

Rules:
- Format: `WIP on <branch>: <concise summary of changes>` (or `<concise summary of changes>` if no branch is given)
- Keep under 72 characters
- Use imperative mood ("validate OAuth state parameter", not "validated")
- Return ONLY the single-line stash message with no quotes or markdown fences"#;

/// Check security policy for the active provider before making an AI request.
fn guard_ai_request(service: &AiService) -> Result<(), String> {
    match service.active_provider_endpoint() {
        Some(endpoint) => {
            crate::services::security::guard_endpoint(&endpoint).map_err(|e| e.to_string())
        }
        None => Ok(()),
    }
}

/// Whether a provider runs locally on this machine.
pub fn is_local_provider(provider_type: AiProviderType) -> bool {
    matches!(
        provider_type,
        AiProviderType::Ollama | AiProviderType::LmStudio | AiProviderType::LocalInference
    )
}

/// Explain a commit, branch comparison, or working tree diff using the active AI provider.
#[command]
pub async fn explain_git_target(
    state: State<'_, AiState>,
    path: String,
    target_type: String,
    target_id: String,
    base_ref: Option<String>,
    file_path: Option<String>,
) -> Result<AiExplanation, String> {
    let prompt_context = crate::utils::blocking_git({
        let path = path.clone();
        let target_type = target_type.clone();
        let target_id = target_id.clone();
        let base_ref = base_ref.clone();
        let file_path = file_path.clone();
        move || {
            let repo = git2::Repository::open(&path)?;
            build_target_prompt(
                &repo,
                &target_type,
                &target_id,
                base_ref.as_deref(),
                file_path.as_deref(),
            )
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    let service = state.read().await;
    guard_ai_request(&service)?;

    let (_provider, provider_type, _model) = service
        .resolve_provider_for_tier(crate::services::ai::AiTaskTier::CodeReview)
        .await?;
    let provider_used = provider_type.display_name().to_string();
    let is_local = service.is_local_provider(provider_type);

    let response = service
        .generate_text_for_feature(
            "explain_git_target",
            crate::services::ai::AiTaskTier::CodeReview,
            EXPLAIN_SYSTEM_PROMPT,
            &prompt_context,
            Some(1200),
        )
        .await?;

    Ok(parse_ai_explanation(
        &response,
        &target_type,
        &target_id,
        &provider_used,
        is_local,
    ))
}

/// Stream an AI explanation for a git target, emitting `"ai-explain-token"` events
/// as explanation text arrives and returning the final structured `AiExplanation`.
#[command]
pub async fn explain_git_target_stream(
    app_handle: AppHandle,
    state: State<'_, AiState>,
    path: String,
    target_type: String,
    target_id: String,
    base_ref: Option<String>,
) -> Result<AiExplanation, String> {
    let explanation =
        explain_git_target(state, path, target_type, target_id.clone(), base_ref, None).await?;

    // Emit progressive sections as tokens so the drawer can render streaming updates
    // seamlessly across both non-streaming and streaming provider backends.
    let preview_chunks = format_explanation_stream_chunks(&explanation);
    for chunk in preview_chunks {
        let _ = app_handle.emit(
            "ai-explain-token",
            AiExplainTokenPayload {
                target_id: target_id.clone(),
                token: chunk,
                done: false,
            },
        );
    }

    let _ = app_handle.emit(
        "ai-explain-token",
        AiExplainTokenPayload {
            target_id,
            token: String::new(),
            done: true,
        },
    );

    Ok(explanation)
}

/// Suggest a git branch name (and alternatives) from working tree changes.
#[command]
pub async fn suggest_branch_name(
    state: State<'_, AiState>,
    path: String,
    issue_context: Option<String>,
) -> Result<BranchNameSuggestion, String> {
    let user_prompt = crate::utils::blocking_git({
        let path = path.clone();
        let issue_context = issue_context.clone();
        move || {
            let repo = git2::Repository::open(&path)?;
            build_branch_name_prompt(&repo, issue_context.as_deref())
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    let service = state.read().await;
    guard_ai_request(&service)?;

    let response = service
        .generate_text_for_feature(
            "suggest_branch_name",
            crate::services::ai::AiTaskTier::FastText,
            BRANCH_NAME_SYSTEM_PROMPT,
            &user_prompt,
            Some(400),
        )
        .await?;

    Ok(parse_branch_name_suggestion(&response))
}

/// Suggest a concise git stash message from working tree changes.
#[command]
pub async fn suggest_stash_message(
    state: State<'_, AiState>,
    path: String,
    include_untracked: Option<bool>,
) -> Result<String, String> {
    let include_untracked = include_untracked.unwrap_or(false);
    let (user_prompt, branch_name) = crate::utils::blocking_git({
        let path = path.clone();
        move || {
            let repo = git2::Repository::open(&path)?;
            build_stash_message_prompt(&repo, include_untracked)
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    let service = state.read().await;
    guard_ai_request(&service)?;

    let response = service
        .generate_text_for_feature(
            "suggest_stash_message",
            crate::services::ai::AiTaskTier::FastText,
            STASH_MESSAGE_SYSTEM_PROMPT,
            &user_prompt,
            Some(150),
        )
        .await?;

    Ok(clean_stash_message(&response, branch_name.as_deref()))
}

/// Assemble the prompt context for `explain_git_target`.
pub fn build_target_prompt(
    repo: &git2::Repository,
    target_type: &str,
    target_id: &str,
    base_ref: Option<&str>,
    file_path: Option<&str>,
) -> crate::error::Result<String> {
    match target_type {
        "commit" => build_commit_explain_prompt(repo, target_id, file_path),
        "branch_compare" => {
            let base = base_ref.filter(|s| !s.trim().is_empty()).unwrap_or("HEAD");
            build_branch_compare_explain_prompt(repo, base, target_id, file_path)
        }
        "working_tree" => build_working_tree_explain_prompt(repo, file_path),
        other => Err(crate::error::GitnadoError::OperationFailed(format!(
            "Unsupported explain target_type: '{}'",
            other
        ))),
    }
}

fn build_commit_explain_prompt(
    repo: &git2::Repository,
    commit_ref: &str,
    file_path: Option<&str>,
) -> crate::error::Result<String> {
    let obj = repo.revparse_single(commit_ref)?;
    let commit = obj.peel_to_commit()?;
    let commit_tree = commit.tree()?;
    let parent_tree = if commit.parent_count() > 0 {
        commit.parent(0).ok().and_then(|p| p.tree().ok())
    } else {
        None
    };

    let mut diff_opts = git2::DiffOptions::new();
    if let Some(fp) = file_path.filter(|s| !s.trim().is_empty()) {
        diff_opts.pathspec(fp);
    }

    let diff = repo.diff_tree_to_tree(
        parent_tree.as_ref(),
        Some(&commit_tree),
        Some(&mut diff_opts),
    )?;

    let (files_summary, patch_text) = render_diff(&diff, MAX_DIFF_BYTES)?;
    let author = commit.author();
    let author_name = author.name().unwrap_or("Unknown");
    let author_email = author.email().unwrap_or("");
    let message = commit.message().unwrap_or("").trim();

    let mut prompt = String::new();
    prompt.push_str(&format!("Target: Commit {}\n", commit.id()));
    prompt.push_str(&format!("Author: {} <{}>\n", author_name, author_email));
    if let Some(fp) = file_path.filter(|s| !s.trim().is_empty()) {
        prompt.push_str(&format!("Focused File: {}\n", fp));
    }
    prompt.push_str(&format!("\nCommit Message:\n{}\n", message));
    prompt.push_str(&format!("\nChanged Files:\n{}\n", files_summary));
    prompt.push_str(&format!("\nDiff:\n{}\n", patch_text));

    Ok(prompt)
}

fn build_branch_compare_explain_prompt(
    repo: &git2::Repository,
    base_ref: &str,
    compare_ref: &str,
    file_path: Option<&str>,
) -> crate::error::Result<String> {
    let base_commit = repo.revparse_single(base_ref)?.peel_to_commit()?;
    let compare_commit = repo.revparse_single(compare_ref)?.peel_to_commit()?;

    // Prefer diffing from the merge base when one exists so the explanation
    // focuses on what `compare_ref` introduces relative to `base_ref`.
    let base_tree = match repo.merge_base(base_commit.id(), compare_commit.id()) {
        Ok(merge_base_oid) => repo
            .find_commit(merge_base_oid)
            .and_then(|c| c.tree())
            .unwrap_or(base_commit.tree()?),
        Err(_) => base_commit.tree()?,
    };
    let compare_tree = compare_commit.tree()?;

    let mut diff_opts = git2::DiffOptions::new();
    if let Some(fp) = file_path.filter(|s| !s.trim().is_empty()) {
        diff_opts.pathspec(fp);
    }

    let diff =
        repo.diff_tree_to_tree(Some(&base_tree), Some(&compare_tree), Some(&mut diff_opts))?;

    let (files_summary, patch_text) = render_diff(&diff, MAX_DIFF_BYTES)?;

    // Collect up to 50 commits in base_ref..compare_ref
    let mut revwalk = repo.revwalk()?;
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
    revwalk.push(compare_commit.id())?;
    let _ = revwalk.hide(base_commit.id());

    let mut commit_lines = Vec::new();
    for oid in revwalk.take(50).flatten() {
        if let Ok(c) = repo.find_commit(oid) {
            let short_id = &oid.to_string()[..7.min(oid.to_string().len())];
            let summary = c.summary().ok().flatten().unwrap_or("");
            let author = c.author().name().unwrap_or("Unknown").to_string();
            commit_lines.push(format!("- {} {} ({})", short_id, summary, author));
        }
    }

    let commits_section = if commit_lines.is_empty() {
        "No commits unique to compare ref.".to_string()
    } else {
        commit_lines.join("\n")
    };

    let mut prompt = String::new();
    prompt.push_str(&format!(
        "Target: Branch Comparison ({} .. {})\n",
        base_ref, compare_ref
    ));
    prompt.push_str(&format!(
        "\nCommits ({}):\n{}\n",
        commit_lines.len(),
        commits_section
    ));
    prompt.push_str(&format!("\nChanged Files:\n{}\n", files_summary));
    prompt.push_str(&format!("\nDiff:\n{}\n", patch_text));

    Ok(prompt)
}

fn build_working_tree_explain_prompt(
    repo: &git2::Repository,
    file_path: Option<&str>,
) -> crate::error::Result<String> {
    let (files_summary, patch_text) =
        collect_working_tree_diff(repo, file_path, false, MAX_DIFF_BYTES)?;
    if files_summary.is_empty() && patch_text.trim().is_empty() {
        return Err(crate::error::GitnadoError::OperationFailed(
            "Working tree has no changes to explain".to_string(),
        ));
    }

    let mut prompt = String::new();
    prompt.push_str("Target: Working Tree Changes (staged + unstaged)\n");
    if let Some(fp) = file_path.filter(|s| !s.trim().is_empty()) {
        prompt.push_str(&format!("Focused File: {}\n", fp));
    }
    prompt.push_str(&format!("\nChanged Files:\n{}\n", files_summary));
    prompt.push_str(&format!("\nDiff:\n{}\n", patch_text));

    Ok(prompt)
}

fn build_branch_name_prompt(
    repo: &git2::Repository,
    issue_context: Option<&str>,
) -> crate::error::Result<String> {
    let (files_summary, patch_text) = collect_working_tree_diff(repo, None, true, MAX_DIFF_BYTES)?;
    let has_issue = issue_context.map(|s| !s.trim().is_empty()).unwrap_or(false);

    if files_summary.is_empty() && patch_text.trim().is_empty() && !has_issue {
        return Err(crate::error::GitnadoError::OperationFailed(
            "No working tree changes found to suggest a branch name from".to_string(),
        ));
    }

    let recent_commits = collect_recent_commit_summaries(repo, 5);

    let mut prompt = String::new();
    if let Some(ctx) = issue_context.filter(|s| !s.trim().is_empty()) {
        prompt.push_str(&format!("Issue / Task Context:\n{}\n\n", ctx.trim()));
    }
    if !recent_commits.is_empty() {
        prompt.push_str(&format!(
            "Recent Repository Commits (for naming convention context):\n{}\n\n",
            recent_commits.join("\n")
        ));
    }
    if !files_summary.is_empty() {
        prompt.push_str(&format!("Changed Files:\n{}\n\n", files_summary));
    }
    if !patch_text.trim().is_empty() {
        prompt.push_str(&format!("Working Tree Diff:\n{}\n", patch_text));
    }

    Ok(prompt)
}

fn build_stash_message_prompt(
    repo: &git2::Repository,
    include_untracked: bool,
) -> crate::error::Result<(String, Option<String>)> {
    let (files_summary, patch_text) =
        collect_working_tree_diff(repo, None, include_untracked, MAX_DIFF_BYTES)?;

    if files_summary.is_empty() && patch_text.trim().is_empty() {
        return Err(crate::error::GitnadoError::OperationFailed(
            "No working tree changes to generate a stash message for".to_string(),
        ));
    }

    let branch_name = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().ok().map(|s| s.to_string()));

    let mut prompt = String::new();
    if let Some(ref branch) = branch_name {
        prompt.push_str(&format!("Current Branch: {}\n\n", branch));
    }
    prompt.push_str(&format!("Changed Files:\n{}\n\n", files_summary));
    prompt.push_str(&format!("Diff:\n{}\n", patch_text));

    Ok((prompt, branch_name))
}

/// Collect combined staged + unstaged diff (and optionally untracked file paths).
fn collect_working_tree_diff(
    repo: &git2::Repository,
    file_path: Option<&str>,
    include_untracked: bool,
    max_bytes: usize,
) -> crate::error::Result<(String, String)> {
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let index = repo.index()?;

    let mut staged_opts = git2::DiffOptions::new();
    let mut unstaged_opts = git2::DiffOptions::new();
    if include_untracked {
        unstaged_opts
            .include_untracked(true)
            .recurse_untracked_dirs(true);
    }
    if let Some(fp) = file_path.filter(|s| !s.trim().is_empty()) {
        staged_opts.pathspec(fp);
        unstaged_opts.pathspec(fp);
    }

    let staged_diff =
        repo.diff_tree_to_index(head_tree.as_ref(), Some(&index), Some(&mut staged_opts))?;
    let unstaged_diff = repo.diff_index_to_workdir(Some(&index), Some(&mut unstaged_opts))?;

    let (staged_files, staged_patch) = render_diff(&staged_diff, max_bytes / 2)?;
    let remaining_budget = max_bytes.saturating_sub(staged_patch.len());
    let (unstaged_files, unstaged_patch) = render_diff(&unstaged_diff, remaining_budget)?;

    let mut files = Vec::new();
    if !staged_files.is_empty() && staged_files != "(none)" {
        for line in staged_files.lines() {
            files.push(format!("{} (staged)", line));
        }
    }
    if !unstaged_files.is_empty() && unstaged_files != "(none)" {
        for line in unstaged_files.lines() {
            files.push(line.to_string());
        }
    }

    let mut combined_patch = String::new();
    if !staged_patch.is_empty() {
        combined_patch.push_str(&staged_patch);
    }
    if !unstaged_patch.is_empty() {
        if !combined_patch.is_empty() && !combined_patch.ends_with('\n') {
            combined_patch.push('\n');
        }
        combined_patch.push_str(&unstaged_patch);
    }

    Ok((files.join("\n"), combined_patch))
}

fn collect_recent_commit_summaries(repo: &git2::Repository, limit: usize) -> Vec<String> {
    let mut summaries = Vec::new();
    if let Ok(mut revwalk) = repo.revwalk() {
        if revwalk.push_head().is_ok() {
            for oid in revwalk.take(limit).flatten() {
                if let Ok(commit) = repo.find_commit(oid) {
                    if let Ok(Some(summary)) = commit.summary() {
                        summaries.push(format!("- {}", summary));
                    }
                }
            }
        }
    }
    summaries
}

/// Render a `git2::Diff` into a changed-file list and a truncated unified patch string.
fn render_diff(diff: &git2::Diff<'_>, max_bytes: usize) -> crate::error::Result<(String, String)> {
    let mut files = Vec::new();
    for delta in diff.deltas() {
        let status = match delta.status() {
            git2::Delta::Added => "A",
            git2::Delta::Deleted => "D",
            git2::Delta::Modified => "M",
            git2::Delta::Renamed => "R",
            git2::Delta::Copied => "C",
            git2::Delta::Untracked => "?",
            _ => "M",
        };
        if let Some(path) = delta.new_file().path().or_else(|| delta.old_file().path()) {
            files.push(format!("{} {}", status, path.display()));
        }
    }

    let mut patch = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        if let Ok(content) = std::str::from_utf8(line.content()) {
            let prefix = match line.origin() {
                '+' => "+",
                '-' => "-",
                ' ' => " ",
                _ => "",
            };
            patch.push_str(prefix);
            patch.push_str(content);
        }
        patch.len() <= max_bytes.saturating_add(1024)
    })?;

    let truncated_patch = if patch.len() > max_bytes {
        let cut = truncate_at_char_boundary(&patch, max_bytes);
        let line_cut = cut.rfind('\n').map(|pos| &cut[..pos]).unwrap_or(cut);
        format!("{}\n...[Diff truncated at 12KB]", line_cut)
    } else {
        patch
    };

    let files_summary = if files.is_empty() {
        "(none)".to_string()
    } else {
        files.join("\n")
    };

    Ok((files_summary, truncated_patch))
}

/// Strip markdown code fences (e.g. ```json ... ```) and extract the JSON object if embedded.
pub fn extract_json_object(raw: &str) -> &str {
    let trimmed = raw.trim();
    let stripped = if trimmed.starts_with("```") {
        let inner = trimmed
            .strip_prefix("```json")
            .or_else(|| trimmed.strip_prefix("```JSON"))
            .or_else(|| trimmed.strip_prefix("```"))
            .unwrap_or(trimmed);
        inner.strip_suffix("```").unwrap_or(inner).trim()
    } else {
        trimmed
    };

    if let (Some(start), Some(end)) = (stripped.find('{'), stripped.rfind('}')) {
        if start < end {
            return &stripped[start..=end];
        }
    }
    stripped
}

/// Parse the model response into a structured `AiExplanation`, falling back gracefully
/// if a small local model returns plain text or Markdown instead of strict JSON.
pub fn parse_ai_explanation(
    response: &str,
    target_type: &str,
    target_id: &str,
    provider_used: &str,
    is_local: bool,
) -> AiExplanation {
    let json_candidate = extract_json_object(response);
    if let Ok(parsed) = serde_json::from_str::<RawAiExplanation>(json_candidate) {
        let default_title = default_explanation_title(target_type, target_id);
        let title = if parsed.title.trim().is_empty() {
            default_title
        } else {
            parsed.title.trim().to_string()
        };
        let summary = if parsed.summary.trim().is_empty() {
            parsed.intent.trim().to_string()
        } else {
            parsed.summary.trim().to_string()
        };
        let intent = if parsed.intent.trim().is_empty() {
            summary.clone()
        } else {
            parsed.intent.trim().to_string()
        };
        let key_changes: Vec<String> = parsed
            .key_changes
            .into_iter()
            .map(|s| {
                s.trim()
                    .trim_start_matches(['-', '*', '•'])
                    .trim()
                    .to_string()
            })
            .filter(|s| !s.is_empty())
            .collect();
        let risks: Vec<String> = parsed
            .risks
            .into_iter()
            .map(|s| {
                s.trim()
                    .trim_start_matches(['-', '*', '•'])
                    .trim()
                    .to_string()
            })
            .filter(|s| !s.is_empty())
            .collect();

        return AiExplanation {
            title,
            summary,
            intent,
            key_changes: if key_changes.is_empty() {
                vec!["Updated implementation details as shown in diff".to_string()]
            } else {
                key_changes
            },
            risks: if risks.is_empty() {
                vec!["None identified — low-risk change".to_string()]
            } else {
                risks
            },
            provider_used: provider_used.to_string(),
            is_local,
        };
    }

    // Graceful fallback for markdown / plain-text responses from small local models
    fallback_parse_explanation(response, target_type, target_id, provider_used, is_local)
}

fn default_explanation_title(target_type: &str, target_id: &str) -> String {
    match target_type {
        "commit" => {
            let short = &target_id[..7.min(target_id.len())];
            format!("Explanation for commit {}", short)
        }
        "branch_compare" => format!("Comparison explanation for {}", target_id),
        "working_tree" => "Working tree changes explanation".to_string(),
        _ => "Change explanation".to_string(),
    }
}

fn fallback_parse_explanation(
    response: &str,
    target_type: &str,
    target_id: &str,
    provider_used: &str,
    is_local: bool,
) -> AiExplanation {
    let trimmed = response.trim();
    let mut title = String::new();
    let mut paragraphs = Vec::new();
    let mut bullets = Vec::new();
    let mut risk_bullets = Vec::new();
    let mut in_risks_section = false;

    for raw_line in trimmed.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with("```") {
            continue;
        }

        let lower = line.to_lowercase();
        if lower.starts_with("#") {
            let heading = line.trim_start_matches('#').trim();
            if heading.to_lowercase().contains("risk") {
                in_risks_section = true;
            } else if heading.to_lowercase().contains("change") {
                in_risks_section = false;
            } else if title.is_empty() {
                title = heading.to_string();
            }
            continue;
        }

        if lower.starts_with("risks:") || lower.starts_with("potential risks:") {
            in_risks_section = true;
            let rest = line.split_once(':').map(|x| x.1).unwrap_or("").trim();
            if !rest.is_empty() {
                risk_bullets.push(rest.to_string());
            }
            continue;
        }

        if line.starts_with("- ") || line.starts_with("* ") || line.starts_with("• ") {
            let item = line[line.chars().next().unwrap().len_utf8()..]
                .trim()
                .to_string();
            if !item.is_empty() {
                if in_risks_section {
                    risk_bullets.push(item);
                } else {
                    bullets.push(item);
                }
            }
        } else {
            paragraphs.push(line.to_string());
        }
    }

    if title.is_empty() {
        title = paragraphs
            .first()
            .map(|first| {
                let end = truncate_at_char_boundary(first, 72);
                end.to_string()
            })
            .unwrap_or_else(|| default_explanation_title(target_type, target_id));
    }

    let intent = paragraphs
        .first()
        .cloned()
        .or_else(|| bullets.first().cloned())
        .unwrap_or_else(|| "Explains the selected git changes.".to_string());

    let summary = if paragraphs.len() > 1 {
        paragraphs[1..].join(" ")
    } else {
        intent.clone()
    };

    if bullets.is_empty() {
        bullets.push(summary.clone());
    }

    if risk_bullets.is_empty() {
        risk_bullets.push("None identified — low-risk change".to_string());
    }

    AiExplanation {
        title,
        summary,
        intent,
        key_changes: bullets,
        risks: risk_bullets,
        provider_used: provider_used.to_string(),
        is_local,
    }
}

fn format_explanation_stream_chunks(explanation: &AiExplanation) -> Vec<String> {
    let mut chunks = Vec::new();
    chunks.push(format!("## {}\n\n", explanation.title));
    chunks.push(format!("**Intent:** {}\n\n", explanation.intent));
    chunks.push(format!("{}\n\n", explanation.summary));
    if !explanation.key_changes.is_empty() {
        chunks.push("### Key Changes\n".to_string());
        for change in &explanation.key_changes {
            chunks.push(format!("- {}\n", change));
        }
        chunks.push("\n".to_string());
    }
    if !explanation.risks.is_empty() {
        chunks.push("### Potential Risks\n".to_string());
        for risk in &explanation.risks {
            chunks.push(format!("- {}\n", risk));
        }
    }
    chunks
}

/// Sanitize an arbitrary candidate string into a valid, conventional git branch ref slug.
pub fn sanitize_branch_slug(raw: &str) -> String {
    let trimmed = raw
        .trim()
        .trim_matches(['"', '\'', '`'])
        .trim_start_matches("refs/heads/")
        .trim();

    let mut out = String::new();
    let mut last_was_sep = false;
    let mut last_was_slash = false;

    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_was_sep = false;
            last_was_slash = false;
        } else if ch == '/' {
            // Trim trailing hyphen right before a slash
            while out.ends_with('-') {
                out.pop();
            }
            if !out.is_empty() && !last_was_slash {
                out.push('/');
                last_was_slash = true;
                last_was_sep = true;
            }
        } else if matches!(ch, '-' | '_' | ' ' | '.' | ':')
            && !out.is_empty()
            && !last_was_sep
            && !last_was_slash
        {
            out.push('-');
            last_was_sep = true;
        }
    }

    while out.ends_with(['-', '/']) {
        out.pop();
    }

    if out.is_empty() {
        return "feat/update".to_string();
    }

    // Ensure conventional prefix if none is present
    let known_prefixes = [
        "feat/",
        "fix/",
        "refactor/",
        "docs/",
        "test/",
        "chore/",
        "perf/",
        "style/",
        "ci/",
        "build/",
        "hotfix/",
        "bugfix/",
        "feature/",
    ];
    if !out.contains('/') {
        // Check if it starts with `feat-` or `fix-` and convert the first hyphen to `/`
        for prefix in ["feat", "fix", "refactor", "docs", "test", "chore", "perf"] {
            let hyphenated = format!("{}-", prefix);
            if let Some(rest) = out.strip_prefix(&hyphenated) {
                if !rest.is_empty() {
                    out = format!("{}/{}", prefix, rest);
                    break;
                }
            }
        }
        if !out.contains('/') {
            out = format!("feat/{}", out);
        }
    } else if !known_prefixes.iter().any(|p| out.starts_with(p)) {
        // Keep existing valid category prefix, just ensure no trailing/empty parts
        let parts: Vec<&str> = out.split('/').filter(|p| !p.is_empty()).collect();
        out = parts.join("/");
    }

    // Enforce reasonable max length without trailing hyphen/slash
    if out.len() > 60 {
        out.truncate(60);
        while out.ends_with(['-', '/']) {
            out.pop();
        }
    }

    out
}

/// Parse the model response into a `BranchNameSuggestion` with sanitized git ref slugs.
pub fn parse_branch_name_suggestion(response: &str) -> BranchNameSuggestion {
    let json_candidate = extract_json_object(response);
    if let Ok(parsed) = serde_json::from_str::<RawBranchNameSuggestion>(json_candidate) {
        let primary = sanitize_branch_slug(&parsed.name);
        let mut alternatives: Vec<String> = parsed
            .alternatives
            .iter()
            .map(|a| sanitize_branch_slug(a))
            .filter(|a| !a.is_empty() && a != &primary)
            .collect();
        alternatives.dedup();

        let rationale = if parsed.rationale.trim().is_empty() {
            "Suggested based on working tree changes.".to_string()
        } else {
            parsed.rationale.trim().to_string()
        };

        return BranchNameSuggestion {
            name: primary,
            alternatives,
            rationale,
        };
    }

    // Fallback when model returns plain text lines instead of JSON
    let mut candidates: Vec<String> = response
        .lines()
        .map(|l| {
            l.trim()
                .trim_start_matches(['-', '*', '1', '2', '3', '.', ')'])
                .trim()
        })
        .filter(|l| !l.is_empty() && !l.starts_with("```"))
        .map(sanitize_branch_slug)
        .collect();
    candidates.dedup();

    let name = candidates
        .first()
        .cloned()
        .unwrap_or_else(|| "feat/working-tree-changes".to_string());
    let alternatives = candidates.into_iter().skip(1).take(3).collect();

    BranchNameSuggestion {
        name,
        alternatives,
        rationale: "Suggested based on working tree changes.".to_string(),
    }
}

/// Clean a generated stash message to a single concise line.
pub fn clean_stash_message(raw: &str, branch_name: Option<&str>) -> String {
    let first_line = raw
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty() && !l.starts_with("```"))
        .unwrap_or("");

    let cleaned = first_line.trim_matches(['"', '\'', '`']).trim();

    if cleaned.is_empty() {
        return match branch_name {
            Some(branch) => format!("WIP on {}: working tree changes", branch),
            None => "WIP: working tree changes".to_string(),
        };
    }

    cleaned.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[test]
    fn test_parse_ai_explanation_valid_json() {
        let raw = r#"```json
        {
          "title": "Add OAuth PKCE state validation",
          "intent": "Prevents CSRF attacks during the OAuth callback handshake.",
          "summary": "Validates the returned state token against the session store before exchanging the code.",
          "keyChanges": [
            "Added state verification in callback handler",
            "Rejected mismatched state tokens with 403"
          ],
          "risks": [
            "Existing in-flight login sessions without state parameter will be rejected"
          ]
        }
        ```"#;

        let explanation = parse_ai_explanation(raw, "commit", "abc1234567", "Ollama", true);
        assert_eq!(explanation.title, "Add OAuth PKCE state validation");
        assert_eq!(
            explanation.intent,
            "Prevents CSRF attacks during the OAuth callback handshake."
        );
        assert_eq!(explanation.key_changes.len(), 2);
        assert_eq!(explanation.risks.len(), 1);
        assert_eq!(explanation.provider_used, "Ollama");
        assert!(explanation.is_local);
    }

    #[test]
    fn test_parse_ai_explanation_markdown_fallback() {
        let raw = r#"# Refactor branch comparison dialog

This change improves the branch comparison dialog by adding AI explanations.
It connects the frontend drawer to the Tauri backend.

- Added Explain Comparison button to header
- Wired gn-ai-explain-drawer component

## Potential Risks
- Streaming events must be cleaned up when switching branches
"#;

        let explanation = parse_ai_explanation(
            raw,
            "branch_compare",
            "feat/ai",
            "Local AI (Embedded)",
            true,
        );
        assert_eq!(explanation.title, "Refactor branch comparison dialog");
        assert!(explanation
            .intent
            .contains("improves the branch comparison dialog"));
        assert_eq!(explanation.key_changes.len(), 2);
        assert_eq!(
            explanation.risks,
            vec!["Streaming events must be cleaned up when switching branches"]
        );
        assert!(explanation.is_local);
    }

    #[test]
    fn test_sanitize_branch_slug_conventions_and_special_chars() {
        assert_eq!(
            sanitize_branch_slug("feat/Add AI Explain Drawer!!"),
            "feat/add-ai-explain-drawer"
        );
        assert_eq!(
            sanitize_branch_slug("fix: oauth state validation_bug"),
            "fix/oauth-state-validation-bug"
        );
        assert_eq!(
            sanitize_branch_slug("refs/heads/refactor/clean..up--lock//"),
            "refactor/clean-up-lock"
        );
        assert_eq!(
            sanitize_branch_slug("implement branch naming"),
            "feat/implement-branch-naming"
        );
        assert_eq!(sanitize_branch_slug("   "), "feat/update");
    }

    #[test]
    fn test_parse_branch_name_suggestion_json_and_fallback() {
        let json = r#"{
            "name": "Feat/AI Explain Drawer!",
            "alternatives": ["feat/ai-explain-drawer", "refactor/explain-panel", "chore/ai_drawer"],
            "rationale": "Adds the explain drawer component and backend command."
        }"#;

        let suggestion = parse_branch_name_suggestion(json);
        assert_eq!(suggestion.name, "feat/ai-explain-drawer");
        // Duplicate of primary should be filtered out
        assert_eq!(
            suggestion.alternatives,
            vec!["refactor/explain-panel", "chore/ai-drawer"]
        );
        assert_eq!(
            suggestion.rationale,
            "Adds the explain drawer component and backend command."
        );

        let plain = "- fix: null pointer in commit details\n- bugfix/commit-details-null";
        let fallback = parse_branch_name_suggestion(plain);
        assert_eq!(fallback.name, "fix/null-pointer-in-commit-details");
        assert_eq!(fallback.alternatives, vec!["bugfix/commit-details-null"]);
    }

    #[test]
    fn test_build_target_prompt_for_commit_and_working_tree() {
        let test_repo = TestRepo::with_initial_commit();
        let oid = test_repo.create_commit(
            "feat: add answer helper",
            &[("src/lib.rs", "pub fn answer() -> u32 { 42 }\n")],
        );

        let repo = test_repo.repo();
        let commit_prompt =
            build_target_prompt(&repo, "commit", &oid.to_string(), None, None).unwrap();
        assert!(commit_prompt.contains("feat: add answer helper"));
        assert!(commit_prompt.contains("src/lib.rs"));
        assert!(commit_prompt.contains("+pub fn answer() -> u32 { 42 }"));

        // Working tree change
        test_repo.create_file("src/lib.rs", "pub fn answer() -> u32 { 99 }\n");
        let wt_prompt = build_target_prompt(&repo, "working_tree", "workdir", None, None).unwrap();
        assert!(wt_prompt.contains("Working Tree Changes"));
        assert!(wt_prompt.contains("+pub fn answer() -> u32 { 99 }"));

        let branch_prompt = build_branch_name_prompt(&repo, Some("Issue #622")).unwrap();
        assert!(branch_prompt.contains("Issue #622"));
        assert!(branch_prompt.contains("src/lib.rs"));
    }

    #[test]
    fn test_clean_stash_message() {
        assert_eq!(
            clean_stash_message(
                "\"WIP on feat/auth: validate OAuth state parameter\"",
                Some("feat/auth")
            ),
            "WIP on feat/auth: validate OAuth state parameter"
        );
        assert_eq!(
            clean_stash_message("   ", Some("main")),
            "WIP on main: working tree changes"
        );
    }
}
