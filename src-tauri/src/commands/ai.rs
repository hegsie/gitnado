//! AI commit message generation commands
//!
//! Provides commands for managing AI providers and generating commit messages.

use crate::error::{GitnadoError, Result};
use crate::services::ai::{
    AiProviderInfo, AiProviderType, AiState, AiUnavailable, AnalysisFinding, CommitSplitSuggestion,
    ConflictExplanation, ConflictResolutionSuggestion, FindingCategory, GeneratedChangelog,
    GeneratedCommitMessage, GeneratedPrDescription, ReflogMatch, RiskLevel, Severity,
    StagedAnalysis, CHANGELOG_PROMPT, COMMIT_SPLIT_PROMPT, CONFLICT_EXPLAIN_PROMPT,
    CONFLICT_RESOLUTION_PROMPT, MAX_CHANGELOG_BYTES, MAX_CONFLICT_CONTEXT_BYTES, MAX_DIFF_BYTES,
    PR_DESCRIPTION_PROMPT, REFLOG_MATCH_PROMPT, VIBE_CHECK_PROMPT,
};
use tauri::{command, State};

/// Get list of all AI providers with their status
#[command]
pub async fn get_ai_providers(state: State<'_, AiState>) -> Result<Vec<AiProviderInfo>> {
    let service = state.read().await;
    Ok(service.get_providers_info().await)
}

/// Get the currently active AI provider
#[command]
pub async fn get_active_ai_provider(state: State<'_, AiState>) -> Result<Option<AiProviderType>> {
    let service = state.read().await;
    Ok(service.get_config().active_provider)
}

/// Set the active AI provider
#[command]
pub async fn set_ai_provider(
    state: State<'_, AiState>,
    provider_type: AiProviderType,
) -> Result<()> {
    let mut service = state.write().await;
    service
        .set_active_provider(provider_type)
        .map_err(GitnadoError::OperationFailed)
}

/// Set API key for a provider
#[command]
pub async fn set_ai_api_key(
    state: State<'_, AiState>,
    provider_type: AiProviderType,
    api_key: Option<String>,
) -> Result<()> {
    let mut service = state.write().await;
    service
        .set_api_key(provider_type, api_key)
        .map_err(GitnadoError::OperationFailed)
}

/// Set the model for a provider
#[command]
pub async fn set_ai_model(
    state: State<'_, AiState>,
    provider_type: AiProviderType,
    model: Option<String>,
) -> Result<()> {
    let mut service = state.write().await;
    service
        .set_model(provider_type, model)
        .map_err(GitnadoError::OperationFailed)
}

/// Test if a provider is available
#[command]
pub async fn test_ai_provider(
    state: State<'_, AiState>,
    provider_type: AiProviderType,
) -> Result<bool> {
    let service = state.read().await;
    service
        .test_provider(provider_type)
        .await
        .map_err(GitnadoError::OperationFailed)
}

/// Auto-detect available local AI providers (Ollama, LM Studio)
#[command]
pub async fn auto_detect_ai_providers(state: State<'_, AiState>) -> Result<Vec<AiProviderType>> {
    let service = state.read().await;
    Ok(service.auto_detect_providers().await)
}

/// Generate a commit message from staged changes
#[command]
pub async fn generate_commit_message(
    state: State<'_, AiState>,
    repo_path: String,
) -> Result<GeneratedCommitMessage> {
    // Get staged diff
    let diff = get_staged_diff(&repo_path)?;

    if diff.is_empty() {
        return Err(GitnadoError::OperationFailed(
            "No staged changes to generate commit message for".to_string(),
        ));
    }

    // Generate message using the active provider
    let service = state.read().await;
    service
        .generate_commit_message(diff)
        .await
        .map_err(GitnadoError::OperationFailed)
}

/// Check if AI is available (a provider is configured and reachable, or a
/// local model is downloaded and will be loaded on the first request)
#[command]
pub async fn is_ai_available(state: State<'_, AiState>) -> Result<bool> {
    let service = state.read().await;
    let result = service.has_available_provider().await;
    tracing::debug!("is_ai_available check: {}", result);
    Ok(result)
}

/// Why an AI request would fail right now, or `None` when AI is usable.
///
/// `is_ai_available` only answers yes/no; when the answer is no the UI needs to
/// say which provider is unavailable, because a provider chosen in Settings is
/// never substituted with another one.
#[command]
pub async fn ai_unavailable_reason(state: State<'_, AiState>) -> Result<Option<AiUnavailable>> {
    let service = state.read().await;
    Ok(service
        .unavailable_reason()
        .await
        .map(|reason| AiUnavailable {
            reason,
            provider_selected: service.get_config().active_provider.is_some(),
        }))
}

/// Suggest a conflict resolution using AI
#[command]
pub async fn suggest_conflict_resolution(
    state: State<'_, AiState>,
    file_path: String,
    ours_content: String,
    theirs_content: String,
    base_content: Option<String>,
    context_before: Option<String>,
    context_after: Option<String>,
) -> Result<ConflictResolutionSuggestion> {
    let service = state.read().await;

    // Build the user prompt with file context
    let mut user_prompt = String::new();

    // Add file path for language context
    user_prompt.push_str(&format!("File: {}\n\n", file_path));

    // Add surrounding context if available
    if let Some(ref before) = context_before {
        let truncated = truncate_content(before, MAX_CONFLICT_CONTEXT_BYTES / 4);
        if !truncated.is_empty() {
            user_prompt.push_str(&format!(
                "Context before the conflict:\n```\n{}\n```\n\n",
                truncated
            ));
        }
    }

    // Add base content if available
    if let Some(ref base) = base_content {
        let truncated = truncate_content(base, MAX_CONFLICT_CONTEXT_BYTES / 4);
        if !truncated.is_empty() {
            user_prompt.push_str(&format!(
                "Base (common ancestor):\n```\n{}\n```\n\n",
                truncated
            ));
        }
    }

    // Add ours and theirs
    let ours_truncated = truncate_content(&ours_content, MAX_CONFLICT_CONTEXT_BYTES / 3);
    let theirs_truncated = truncate_content(&theirs_content, MAX_CONFLICT_CONTEXT_BYTES / 3);

    user_prompt.push_str(&format!(
        "Ours (current branch):\n```\n{}\n```\n\n",
        ours_truncated
    ));
    user_prompt.push_str(&format!(
        "Theirs (incoming branch):\n```\n{}\n```\n",
        theirs_truncated
    ));

    if let Some(ref after) = context_after {
        let truncated = truncate_content(after, MAX_CONFLICT_CONTEXT_BYTES / 4);
        if !truncated.is_empty() {
            user_prompt.push_str(&format!(
                "\nContext after the conflict:\n```\n{}\n```\n",
                truncated
            ));
        }
    }

    let response = service
        .generate_text(CONFLICT_RESOLUTION_PROMPT, &user_prompt, None)
        .await
        .map_err(GitnadoError::OperationFailed)?;

    // Try to parse as JSON
    parse_conflict_suggestion(&response)
}

/// Generate a changelog from commits between two refs
#[command]
pub async fn generate_changelog(
    state: State<'_, AiState>,
    repo_path: String,
    base_ref: String,
    compare_ref: String,
    max_commits: Option<u32>,
) -> Result<GeneratedChangelog> {
    let max_commits = max_commits.unwrap_or(200);

    // Get commits between the two refs using git log
    let commits_text = get_commits_between_refs(&repo_path, &base_ref, &compare_ref, max_commits)?;

    if commits_text.is_empty() {
        return Err(GitnadoError::OperationFailed(
            "No commits found between the specified refs".to_string(),
        ));
    }

    // Truncate if too long
    let truncated = truncate_content(&commits_text, MAX_CHANGELOG_BYTES);

    let service = state.read().await;
    let response = service
        .generate_text(CHANGELOG_PROMPT, truncated, Some(2000))
        .await
        .map_err(GitnadoError::OperationFailed)?;

    Ok(GeneratedChangelog {
        content: response.trim().to_string(),
    })
}

// ========================================================================
// Phase 4: "Rebase Pilot" commands
// ========================================================================

/// Explain why a conflict occurred in plain language
#[command]
pub async fn explain_conflict(
    state: State<'_, AiState>,
    file_path: String,
    ours_content: String,
    theirs_content: String,
    base_content: Option<String>,
    our_ref: Option<String>,
    their_ref: Option<String>,
) -> Result<ConflictExplanation> {
    let mut user_prompt = format!("File: {}\n\n", file_path);

    if let Some(ref our_branch) = our_ref {
        user_prompt.push_str(&format!("Current branch: {}\n", our_branch));
    }
    if let Some(ref their_branch) = their_ref {
        user_prompt.push_str(&format!("Incoming branch: {}\n\n", their_branch));
    }

    if let Some(ref base) = base_content {
        let truncated = truncate_content(base, MAX_CONFLICT_CONTEXT_BYTES / 4);
        if !truncated.is_empty() {
            user_prompt.push_str(&format!(
                "Base (common ancestor):\n```\n{}\n```\n\n",
                truncated
            ));
        }
    }

    let ours_truncated = truncate_content(&ours_content, MAX_CONFLICT_CONTEXT_BYTES / 3);
    let theirs_truncated = truncate_content(&theirs_content, MAX_CONFLICT_CONTEXT_BYTES / 3);

    user_prompt.push_str(&format!(
        "Ours (current branch):\n```\n{}\n```\n\n",
        ours_truncated
    ));
    user_prompt.push_str(&format!(
        "Theirs (incoming branch):\n```\n{}\n```\n",
        theirs_truncated
    ));

    let service = state.read().await;
    let response = service
        .generate_text(CONFLICT_EXPLAIN_PROMPT, &user_prompt, Some(500))
        .await
        .map_err(GitnadoError::OperationFailed)?;

    parse_conflict_explanation(&response)
}

/// Find a reflog entry matching a natural language query
#[command]
pub async fn find_reflog_entry(
    state: State<'_, AiState>,
    repo_path: String,
    query: String,
) -> Result<ReflogMatch> {
    // Get reflog entries
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(&repo_path)
        .arg("reflog")
        .arg("--format=%H %gd %gs %ci")
        .arg("-50")
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to get reflog: {}", e)))?;

    if !output.status.success() {
        return Err(GitnadoError::OperationFailed(
            "Failed to get reflog".to_string(),
        ));
    }

    let reflog_text = String::from_utf8_lossy(&output.stdout).to_string();

    if reflog_text.trim().is_empty() {
        return Err(GitnadoError::OperationFailed("Reflog is empty".to_string()));
    }

    let system_prompt = REFLOG_MATCH_PROMPT.replace("{query}", &query);

    let service = state.read().await;
    let response = service
        .generate_text(&system_prompt, &reflog_text, Some(300))
        .await
        .map_err(GitnadoError::OperationFailed)?;

    parse_reflog_match(&response)
}

/// Parse conflict explanation JSON response
fn parse_conflict_explanation(response: &str) -> Result<ConflictExplanation> {
    let json_str = strip_code_fences(response.trim());
    serde_json::from_str::<ConflictExplanation>(json_str)
        .map_err(|_| {
            // Fallback: treat entire response as explanation
            GitnadoError::Custom("Failed to parse explanation".to_string())
        })
        .or_else(|_| {
            Ok(ConflictExplanation {
                explanation: response.trim().to_string(),
                ours_summary: String::new(),
                theirs_summary: String::new(),
            })
        })
}

/// Parse reflog match JSON response
fn parse_reflog_match(response: &str) -> Result<ReflogMatch> {
    let json_str = strip_code_fences(response.trim());
    serde_json::from_str::<ReflogMatch>(json_str)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to parse reflog match: {}", e)))
}

/// Get commit messages between two refs as a formatted text block
fn get_commits_between_refs(
    repo_path: &str,
    base_ref: &str,
    compare_ref: &str,
    max_commits: u32,
) -> Result<String> {
    // Reject refs that could be parsed as flags (e.g., `--output=/tmp/x`).
    // We do NOT add a `--` separator because in `git log` `--` denotes
    // "remaining args are pathspecs", which would then make git treat the
    // rev range as a path. The leading-`-` rejection is the right defense.
    crate::utils::reject_flag_like(base_ref, "Base ref")?;
    crate::utils::reject_flag_like(compare_ref, "Compare ref")?;
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .arg("log")
        .arg("--format=%h %s%n%b%n---")
        .arg(format!("-{}", max_commits))
        .arg(format!("{}..{}", base_ref, compare_ref))
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run git log: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "git log failed: {}",
            stderr.trim()
        )));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ========================================================================
// Phase 3: "Local Bouncer" commands
// ========================================================================

/// Analyze staged changes for potential issues (secrets, complexity, quality)
#[command]
pub async fn analyze_staged_changes(
    state: State<'_, AiState>,
    repo_path: String,
) -> Result<StagedAnalysis> {
    let diff = get_staged_diff(&repo_path)?;

    if diff.is_empty() {
        return Ok(StagedAnalysis {
            findings: vec![],
            summary: "No staged changes".to_string(),
            risk_level: RiskLevel::Low,
            // Nothing to analyse, so nothing failed.
            ai_analysis_ran: true,
            ai_error: None,
        });
    }

    // Fast regex-based secret detection (no AI needed)
    let mut findings = detect_secrets(&diff);

    // AI analysis for complexity and quality
    let truncated = truncate_content(&diff, MAX_DIFF_BYTES);
    let service = state.read().await;

    // Both failure arms used to be dropped on the floor. A provider that had
    // stopped since the availability check, a missing model, a dead network or
    // an unparseable response all left the command returning success with only
    // the regex secret findings — rendered as a completed check reading "No
    // issues found". The user was told their staged changes had been reviewed
    // when nothing had reviewed them.
    let ai_error = match service
        .generate_text(VIBE_CHECK_PROMPT, truncated, Some(1000))
        .await
    {
        Ok(response) => match parse_vibe_check_response(&response) {
            Ok(ai_analysis) => {
                findings.extend(ai_analysis.findings);
                None
            }
            Err(e) => Some(format!("could not read the model's response: {}", e)),
        },
        Err(e) => Some(e.to_string()),
    };
    let ai_analysis_ran = ai_error.is_none();

    let risk_level = if findings
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
    };

    let found = if findings.is_empty() {
        "No issues found".to_string()
    } else {
        format!(
            "{} issue{} found",
            findings.len(),
            if findings.len() == 1 { "" } else { "s" }
        )
    };
    // Say what was actually checked. "No issues found" over a failed AI pass
    // is the false assurance this exists to prevent.
    let summary = if ai_analysis_ran {
        found
    } else {
        format!("{} (secret scan only — AI analysis failed)", found)
    };

    Ok(StagedAnalysis {
        findings,
        summary,
        risk_level,
        ai_analysis_ran,
        ai_error,
    })
}

/// Generate a PR description from branch commits
#[command]
pub async fn generate_pr_description(
    state: State<'_, AiState>,
    repo_path: String,
    base_ref: String,
    head_ref: String,
    title: String,
) -> Result<GeneratedPrDescription> {
    // Get commits between refs
    let commits_text = get_commits_between_refs(&repo_path, &base_ref, &head_ref, 100)?;

    if commits_text.is_empty() {
        return Err(GitnadoError::OperationFailed(
            "No commits found between the specified refs".to_string(),
        ));
    }

    // Get diff stats
    let stats = get_diff_stats(&repo_path, &base_ref, &head_ref)?;

    let user_prompt = format!("{}\n\nDiff statistics:\n{}", commits_text, stats);
    let truncated = truncate_content(&user_prompt, MAX_CHANGELOG_BYTES);

    // Replace {title} placeholder in prompt
    let system_prompt = PR_DESCRIPTION_PROMPT.replace("{title}", &title);

    let service = state.read().await;
    let response = service
        .generate_text(&system_prompt, truncated, Some(1500))
        .await
        .map_err(GitnadoError::OperationFailed)?;

    Ok(GeneratedPrDescription {
        body: response.trim().to_string(),
    })
}

/// Suggest splitting staged changes into multiple commits
#[command]
pub async fn suggest_commit_splits(
    state: State<'_, AiState>,
    repo_path: String,
) -> Result<CommitSplitSuggestion> {
    let diff = get_staged_diff(&repo_path)?;

    if diff.is_empty() {
        return Ok(CommitSplitSuggestion {
            should_split: false,
            groups: vec![],
            explanation: "No staged changes".to_string(),
        });
    }

    // Only suggest splits for substantial changes
    let line_count = diff.lines().count();
    if line_count < 30 {
        return Ok(CommitSplitSuggestion {
            should_split: false,
            groups: vec![],
            explanation: "Changes are small enough for a single commit".to_string(),
        });
    }

    let truncated = truncate_content(&diff, MAX_DIFF_BYTES);

    let service = state.read().await;
    let response = service
        .generate_text(COMMIT_SPLIT_PROMPT, truncated, Some(1500))
        .await
        .map_err(GitnadoError::OperationFailed)?;

    parse_split_suggestion(&response)
}

/// Get diff stats between two refs
fn get_diff_stats(repo_path: &str, base_ref: &str, compare_ref: &str) -> Result<String> {
    crate::utils::reject_flag_like(base_ref, "Base ref")?;
    crate::utils::reject_flag_like(compare_ref, "Compare ref")?;
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .arg("diff")
        .arg("--stat")
        .arg(format!("{}..{}", base_ref, compare_ref))
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run git diff: {}", e)))?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Detect secrets in a diff using regex patterns (fast, no AI needed)
fn detect_secrets(diff: &str) -> Vec<AnalysisFinding> {
    let mut findings = Vec::new();

    let patterns: Vec<(&str, &str)> = vec![
        (r"AKIA[0-9A-Z]{16}", "Possible AWS Access Key ID detected"),
        (
            r"-----BEGIN[A-Z ]*PRIVATE KEY-----",
            "Private key detected in diff",
        ),
        (
            r#"(?i)(password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]"#,
            "Possible hardcoded password detected",
        ),
        (
            r#"(?i)(api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*['"][A-Za-z0-9]{16,}['"]"#,
            "Possible hardcoded API key detected",
        ),
        (
            r#"(?i)(token)\s*[:=]\s*['"][A-Za-z0-9_\-.]{20,}['"]"#,
            "Possible hardcoded token detected",
        ),
    ];

    for (pattern, message) in patterns {
        if let Ok(re) = regex::Regex::new(pattern) {
            for mat in re.find_iter(diff) {
                // Try to find the file path from the nearest diff header
                let before = &diff[..mat.start()];
                let file_path = before
                    .rfind("\n+++ b/")
                    .and_then(|pos| {
                        let line_start = pos + 7; // skip "\n+++ b/"
                        before[line_start..]
                            .find('\n')
                            .map(|end| before[line_start..line_start + end].to_string())
                    })
                    .or_else(|| {
                        before.rfind("\n+++ ").map(|pos| {
                            let line_start = pos + 5;
                            before[line_start..]
                                .find('\n')
                                .map(|end| before[line_start..line_start + end].to_string())
                                .unwrap_or_default()
                        })
                    });

                findings.push(AnalysisFinding {
                    category: FindingCategory::Secret,
                    severity: Severity::Error,
                    message: message.to_string(),
                    file_path,
                });
            }
        }
    }

    findings
}

/// Parse the AI vibe check response
fn parse_vibe_check_response(response: &str) -> Result<StagedAnalysis> {
    let trimmed = response.trim();
    let json_str = strip_code_fences(trimmed);

    serde_json::from_str::<StagedAnalysis>(json_str).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse vibe check response: {}", e))
    })
}

/// Parse the AI split suggestion response
fn parse_split_suggestion(response: &str) -> Result<CommitSplitSuggestion> {
    let trimmed = response.trim();
    let json_str = strip_code_fences(trimmed);

    serde_json::from_str::<CommitSplitSuggestion>(json_str).map_err(|e| {
        // Fallback: no split needed
        tracing::warn!("Failed to parse split suggestion: {}", e);
        GitnadoError::OperationFailed(format!("Failed to parse split suggestion: {}", e))
    })
}

/// Strip markdown code fences from a response
fn strip_code_fences(s: &str) -> &str {
    if s.starts_with("```") {
        let inner = s
            .strip_prefix("```json")
            .or_else(|| s.strip_prefix("```"))
            .unwrap_or(s);
        inner.strip_suffix("```").unwrap_or(inner).trim()
    } else {
        s
    }
}

/// Truncate content to at most `max_bytes`, preferring a line boundary.
///
/// The limit is a BYTE count, and slicing a `&str` mid-character panics. Both
/// this slice and the rfind slice below used the raw index, so a large diff
/// containing any non-ASCII text could kill the command task.
fn truncate_content(content: &str, max_bytes: usize) -> &str {
    if content.len() <= max_bytes {
        return content;
    }
    let head = crate::services::ai::truncate_at_char_boundary(content, max_bytes);
    // Prefer a line boundary within that.
    match head.rfind('\n') {
        Some(pos) => &head[..pos],
        None => head,
    }
}

/// Parse the AI response into a ConflictResolutionSuggestion
fn parse_conflict_suggestion(response: &str) -> Result<ConflictResolutionSuggestion> {
    let trimmed = response.trim();

    // Strip markdown code fences if present
    let json_str = if trimmed.starts_with("```") {
        let inner = trimmed
            .strip_prefix("```json")
            .or_else(|| trimmed.strip_prefix("```"))
            .unwrap_or(trimmed);
        inner.strip_suffix("```").unwrap_or(inner).trim()
    } else {
        trimmed
    };

    // Try JSON parse
    if let Ok(suggestion) = serde_json::from_str::<ConflictResolutionSuggestion>(json_str) {
        return Ok(suggestion);
    }

    // Fallback: treat entire response as resolved content
    Ok(ConflictResolutionSuggestion {
        resolved_content: trimmed.to_string(),
        explanation: String::new(),
    })
}

/// Get the staged diff as a string
fn get_staged_diff(repo_path: &str) -> Result<String> {
    let repo = git2::Repository::open(repo_path)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to open repository: {}", e)))?;

    // Get HEAD tree (for comparing staged changes)
    let head = repo.head().ok();
    let head_tree = head.and_then(|h| h.peel_to_tree().ok());

    // Get the index
    let index = repo
        .index()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to get index: {}", e)))?;

    // Get diff between HEAD and index (staged changes)
    let diff = repo
        .diff_tree_to_index(head_tree.as_ref(), Some(&index), None)
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to get diff: {}", e)))?;

    // Convert diff to string
    let mut diff_str = String::new();

    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        if let Ok(content) = std::str::from_utf8(line.content()) {
            let prefix = match line.origin() {
                '+' => "+",
                '-' => "-",
                ' ' => " ",
                'H' => "", // File header
                'F' => "", // File header
                'B' => "", // Binary file
                _ => "",
            };
            diff_str.push_str(prefix);
            diff_str.push_str(content);
        }
        true
    })
    .map_err(|e| GitnadoError::OperationFailed(format!("Failed to print diff: {}", e)))?;

    Ok(diff_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    /// truncate_content takes a BYTE limit and used it as a slice index twice.
    /// A staged diff over the limit containing non-ASCII text would panic the
    /// command task, so "Generate commit message" / "Vibe Check" died outright
    /// for that user whenever their diff was large.
    #[test]
    fn test_truncate_content_does_not_panic_on_multibyte_input() {
        // No newlines, so the line-boundary path cannot rescue the cut.
        let content = "é".repeat(500);
        assert_eq!(content.len(), 1000);

        for max in [1, 7, 99, 501, 999] {
            let out = truncate_content(&content, max);
            assert!(out.len() <= max);
            assert!(content.starts_with(out));
        }
    }

    /// Emoji land on 4-byte boundaries — the same hazard, one step wider.
    #[test]
    fn test_truncate_content_handles_emoji_and_keeps_line_boundaries() {
        let content = format!("first line\n{}\nlast", "🎉".repeat(100));

        let out = truncate_content(&content, 50);
        assert!(out.len() <= 50);
        assert!(content.starts_with(out));
        // Still prefers a line boundary when one is available within the limit.
        assert_eq!(out, "first line");
    }

    // ========================================================================
    // get_staged_diff Tests
    // ========================================================================

    #[test]
    fn test_get_staged_diff_empty_repo() {
        let repo = TestRepo::new();
        let result = get_staged_diff(&repo.path_str());
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[test]
    fn test_get_staged_diff_no_staged_changes() {
        let repo = TestRepo::with_initial_commit();
        let result = get_staged_diff(&repo.path_str());
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[test]
    fn test_get_staged_diff_with_staged_new_file() {
        let repo = TestRepo::with_initial_commit();

        // Create and stage a new file
        repo.create_file("new_file.txt", "Hello, World!");
        repo.stage_file("new_file.txt");

        let result = get_staged_diff(&repo.path_str());
        assert!(result.is_ok());
        let diff = result.unwrap();
        assert!(!diff.is_empty());
        assert!(diff.contains("+Hello, World!"));
    }

    #[test]
    fn test_get_staged_diff_with_modified_file() {
        let repo = TestRepo::with_initial_commit();

        // Modify the README and stage it
        repo.create_file("README.md", "Modified content");
        repo.stage_file("README.md");

        let result = get_staged_diff(&repo.path_str());
        assert!(result.is_ok());
        let diff = result.unwrap();
        assert!(!diff.is_empty());
        assert!(diff.contains("-# Test Repo"));
        assert!(diff.contains("+Modified content"));
    }

    #[test]
    fn test_get_staged_diff_unstaged_changes_not_included() {
        let repo = TestRepo::with_initial_commit();

        // Create a file but don't stage it
        repo.create_file("unstaged.txt", "This should not appear in diff");

        let result = get_staged_diff(&repo.path_str());
        assert!(result.is_ok());
        let diff = result.unwrap();
        // Unstaged changes should not appear in the diff
        assert!(!diff.contains("unstaged.txt"));
        assert!(!diff.contains("This should not appear"));
    }

    #[test]
    fn test_get_staged_diff_invalid_path() {
        let result = get_staged_diff("/nonexistent/path/to/repo");
        assert!(result.is_err());
    }

    #[test]
    fn test_get_staged_diff_multiple_files() {
        let repo = TestRepo::with_initial_commit();

        // Create and stage multiple files
        repo.create_file("file1.txt", "Content 1");
        repo.create_file("file2.txt", "Content 2");
        repo.stage_file("file1.txt");
        repo.stage_file("file2.txt");

        let result = get_staged_diff(&repo.path_str());
        assert!(result.is_ok());
        let diff = result.unwrap();
        assert!(diff.contains("+Content 1"));
        assert!(diff.contains("+Content 2"));
    }

    // ========================================================================
    // AiProviderType Tests
    // ========================================================================

    #[test]
    fn test_ai_provider_type_serialization() {
        use crate::services::ai::AiProviderType;

        // These exact strings are the IPC wire format and the on-disk key
        // format of the persisted AI config. The TypeScript `AiProviderType`
        // union in src/services/ai.service.ts must match them exactly, and
        // renaming one would invalidate existing config files.
        let expected = [
            (AiProviderType::Ollama, "\"ollama\""),
            (AiProviderType::LmStudio, "\"lm_studio\""),
            (AiProviderType::OpenAi, "\"open_ai\""),
            (AiProviderType::Anthropic, "\"anthropic\""),
            (AiProviderType::GithubCopilot, "\"github_copilot\""),
            (AiProviderType::GoogleGemini, "\"google_gemini\""),
            (AiProviderType::LocalInference, "\"local_inference\""),
        ];

        for (variant, wire) in expected {
            let json = serde_json::to_string(&variant).expect("Failed to serialize");
            assert_eq!(json, wire, "wire format changed for {variant:?}");
            let round_tripped: AiProviderType =
                serde_json::from_str(wire).expect("Failed to deserialize");
            assert_eq!(round_tripped, variant);
        }

        // Every variant must be covered above, so a newly added one fails here
        // until its wire value is asserted.
        assert_eq!(AiProviderType::all().len(), expected.len());

        // "openai" is not a valid wire value — the snake_case rename makes it
        // "open_ai". Guards against the TypeScript side drifting back.
        assert!(
            serde_json::from_str::<AiProviderType>("\"openai\"").is_err(),
            "\"openai\" must not deserialize"
        );
    }

    #[test]
    fn test_ai_provider_type_all() {
        use crate::services::ai::AiProviderType;

        let all = AiProviderType::all();
        assert!(all.len() >= 4); // At least Ollama, LmStudio, OpenAi, Anthropic
        assert!(all.contains(&AiProviderType::Ollama));
        assert!(all.contains(&AiProviderType::OpenAi));
        assert!(all.contains(&AiProviderType::Anthropic));
    }

    #[test]
    fn test_ai_provider_type_requires_api_key() {
        use crate::services::ai::AiProviderType;

        // Local providers don't require API key
        assert!(!AiProviderType::Ollama.requires_api_key());
        assert!(!AiProviderType::LmStudio.requires_api_key());

        // Cloud providers require API key
        assert!(AiProviderType::OpenAi.requires_api_key());
        assert!(AiProviderType::Anthropic.requires_api_key());
    }

    #[test]
    fn test_generated_commit_message_structure() {
        use crate::services::ai::GeneratedCommitMessage;

        let msg = GeneratedCommitMessage {
            summary: "feat: add new feature".to_string(),
            body: Some("This commit adds a new feature\n\nDetails here".to_string()),
        };

        assert_eq!(msg.summary, "feat: add new feature");
        assert!(msg.body.is_some());
        assert!(msg.body.unwrap().contains("This commit adds a new feature"));
    }

    #[test]
    fn test_generated_commit_message_without_body() {
        use crate::services::ai::GeneratedCommitMessage;

        let msg = GeneratedCommitMessage {
            summary: "fix: typo in readme".to_string(),
            body: None,
        };

        assert_eq!(msg.summary, "fix: typo in readme");
        assert!(msg.body.is_none());
    }

    // ========================================================================
    // parse_conflict_suggestion Tests
    // ========================================================================

    #[test]
    fn test_parse_conflict_suggestion_valid_json() {
        let response =
            r#"{"resolvedContent": "merged code here", "explanation": "combined both changes"}"#;
        let result = parse_conflict_suggestion(response);
        assert!(result.is_ok());
        let suggestion = result.unwrap();
        assert_eq!(suggestion.resolved_content, "merged code here");
        assert_eq!(suggestion.explanation, "combined both changes");
    }

    #[test]
    fn test_parse_conflict_suggestion_json_with_code_fences() {
        let response = "```json\n{\"resolvedContent\": \"code\", \"explanation\": \"merged\"}\n```";
        let result = parse_conflict_suggestion(response);
        assert!(result.is_ok());
        let suggestion = result.unwrap();
        assert_eq!(suggestion.resolved_content, "code");
        assert_eq!(suggestion.explanation, "merged");
    }

    #[test]
    fn test_parse_conflict_suggestion_fallback() {
        let response = "some plain text response that is not JSON";
        let result = parse_conflict_suggestion(response);
        assert!(result.is_ok());
        let suggestion = result.unwrap();
        assert_eq!(
            suggestion.resolved_content,
            "some plain text response that is not JSON"
        );
        assert!(suggestion.explanation.is_empty());
    }

    #[test]
    fn test_truncate_content_short() {
        let content = "short";
        assert_eq!(truncate_content(content, 100), "short");
    }

    #[test]
    fn test_truncate_content_long() {
        let content = "line1\nline2\nline3\nline4";
        let truncated = truncate_content(content, 12);
        assert_eq!(truncated, "line1\nline2");
    }

    #[test]
    fn test_generated_commit_message_serialization() {
        use crate::services::ai::GeneratedCommitMessage;

        let msg = GeneratedCommitMessage {
            summary: "test commit".to_string(),
            body: Some("body text".to_string()),
        };

        let json = serde_json::to_string(&msg).expect("Failed to serialize");
        assert!(json.contains("summary"));
        assert!(json.contains("test commit"));
    }

    // ========================================================================
    // detect_secrets Tests
    // ========================================================================

    #[test]
    fn test_detect_secrets_aws_key() {
        let diff = "+++ b/config.ts\n+const key = 'AKIAIOSFODNN7EXAMPLE';";
        let findings = detect_secrets(diff);
        assert!(!findings.is_empty());
        assert!(findings
            .iter()
            .any(|f| matches!(f.category, FindingCategory::Secret)));
    }

    #[test]
    fn test_detect_secrets_private_key() {
        let diff = "+++ b/key.pem\n+-----BEGIN RSA PRIVATE KEY-----\n+MIIEo...";
        let findings = detect_secrets(diff);
        assert!(!findings.is_empty());
    }

    #[test]
    fn test_detect_secrets_password() {
        let diff = r#"+++ b/config.ts
+const password = "super_secret_123";"#;
        let findings = detect_secrets(diff);
        assert!(!findings.is_empty());
    }

    #[test]
    fn test_detect_secrets_clean_diff() {
        let diff = "+++ b/main.ts\n+console.log('hello world');";
        let findings = detect_secrets(diff);
        assert!(findings.is_empty());
    }

    // ========================================================================
    // parse_vibe_check_response Tests
    // ========================================================================

    #[test]
    fn test_parse_vibe_check_valid_json() {
        let response = r#"{"findings": [{"category": "quality", "severity": "info", "message": "TODO added", "filePath": "main.ts"}], "summary": "1 issue found", "riskLevel": "low"}"#;
        let result = parse_vibe_check_response(response);
        assert!(result.is_ok());
        let analysis = result.unwrap();
        assert_eq!(analysis.findings.len(), 1);
    }

    /// The model's JSON does not carry the reporting fields, and must not have
    /// to.
    ///
    /// StagedAnalysis is both the command's RESULT type and the shape the
    /// model's response is parsed into. Adding a required field to it would
    /// make every model response fail to parse — taking down the AI pass, which
    /// is exactly the failure those fields exist to report.
    #[test]
    fn test_parse_vibe_check_tolerates_a_response_without_the_reporting_fields() {
        let response = r#"{"findings": [], "summary": "No issues", "riskLevel": "low"}"#;
        let analysis = parse_vibe_check_response(response)
            .expect("a model response without the reporting fields must still parse");
        assert!(analysis.findings.is_empty());
    }

    #[test]
    fn test_parse_vibe_check_with_code_fences() {
        let response =
            "```json\n{\"findings\": [], \"summary\": \"No issues\", \"riskLevel\": \"low\"}\n```";
        let result = parse_vibe_check_response(response);
        assert!(result.is_ok());
    }

    // ========================================================================
    // parse_split_suggestion Tests
    // ========================================================================

    #[test]
    fn test_parse_split_suggestion_should_split() {
        let response = r#"{"shouldSplit": true, "groups": [{"label": "Bug fix", "files": ["auth.rs"], "suggestedMessage": "fix: resolve auth bug"}], "explanation": "Separate concerns"}"#;
        let result = parse_split_suggestion(response);
        assert!(result.is_ok());
        let suggestion = result.unwrap();
        assert!(suggestion.should_split);
        assert_eq!(suggestion.groups.len(), 1);
    }

    #[test]
    fn test_parse_split_suggestion_no_split() {
        let response =
            r#"{"shouldSplit": false, "groups": [], "explanation": "Changes are cohesive"}"#;
        let result = parse_split_suggestion(response);
        assert!(result.is_ok());
        assert!(!result.unwrap().should_split);
    }

    #[test]
    fn test_strip_code_fences() {
        assert_eq!(strip_code_fences("```json\n{}\n```"), "{}");
        assert_eq!(strip_code_fences("```\nhello\n```"), "hello");
        assert_eq!(strip_code_fences("no fences"), "no fences");
    }

    // ========================================================================
    // Phase 4: parse_conflict_explanation Tests
    // ========================================================================

    #[test]
    fn test_parse_conflict_explanation_valid() {
        let response = r#"{"explanation": "Both branches modified the same function", "oursSummary": "Added a timeout parameter", "theirsSummary": "Renamed the function"}"#;
        let result = parse_conflict_explanation(response);
        assert!(result.is_ok());
        let explanation = result.unwrap();
        assert!(explanation.explanation.contains("Both branches"));
        assert!(explanation.ours_summary.contains("timeout"));
        assert!(explanation.theirs_summary.contains("Renamed"));
    }

    #[test]
    fn test_parse_conflict_explanation_fallback() {
        let response = "This conflict happened because both branches changed the same line.";
        let result = parse_conflict_explanation(response);
        assert!(result.is_ok());
        let explanation = result.unwrap();
        assert!(explanation.explanation.contains("both branches"));
    }

    // ========================================================================
    // Phase 4: parse_reflog_match Tests
    // ========================================================================

    #[test]
    fn test_parse_reflog_match_valid() {
        let response =
            r#"{"index": 3, "description": "This will reset to the state before the rebase"}"#;
        let result = parse_reflog_match(response);
        assert!(result.is_ok());
        let m = result.unwrap();
        assert_eq!(m.index, 3);
        assert!(m.description.contains("before the rebase"));
    }

    #[test]
    fn test_parse_reflog_match_with_fences() {
        let response = "```json\n{\"index\": 5, \"description\": \"Undo last commit\"}\n```";
        let result = parse_reflog_match(response);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().index, 5);
    }
}
