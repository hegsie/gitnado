//! AI-powered branch/PR review, comment-to-patch resolution, and CI failure diagnostics
//!
//! Implements:
//! - Local AI Branch / PR Review (#623)
//! - PR Review Comment -> Suggested Patch (#624)
//! - "Explain This CI Failure" (#626)

use std::collections::HashSet;
use std::path::Path;
use std::result::Result;

use serde::{Deserialize, Serialize};
use tauri::{command, State};

use crate::commands::path_utils::validate_path_within_repo;
use crate::services::ai::{truncate_at_char_boundary, AiService, AiState, MAX_DIFF_BYTES};

/// A single finding from an AI branch or pull-request diff review (#623)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiReviewFinding {
    pub file_path: String,
    pub line: Option<u32>,
    /// `"critical" | "warning" | "suggestion"`
    pub severity: String,
    /// `"bug" | "security" | "performance" | "maintainability"`
    pub category: String,
    pub title: String,
    pub message: String,
    pub suggested_fix: Option<String>,
}

/// Structured result of an AI branch / PR diff review (#623)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiBranchReviewResult {
    pub summary: String,
    /// `"low" | "medium" | "high"`
    pub risk_level: String,
    pub findings: Vec<AiReviewFinding>,
    pub files_reviewed: usize,
}

/// Suggested unified diff patch to resolve a PR/MR review comment (#624)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommentResolutionPatch {
    pub file_path: String,
    pub explanation: String,
    pub unified_diff: String,
    pub can_apply_cleanly: bool,
}

/// Structured root-cause diagnosis and fix suggestion for a failing CI check (#626)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CiFailureExplanation {
    pub check_name: String,
    pub root_cause: String,
    pub failing_step: Option<String>,
    pub suggested_fix: String,
    pub relevant_files: Vec<String>,
}

/// System prompt for AI branch / PR review
pub const BRANCH_REVIEW_PROMPT: &str = r#"You are a senior staff code reviewer analyzing a git branch diff.
Identify concrete bugs, security vulnerabilities, performance regressions, and maintainability issues.

Return ONLY a JSON object (no markdown fences) with this exact structure:
{
  "summary": "concise 1-2 sentence overview of the branch changes and overall quality",
  "riskLevel": "low|medium|high",
  "findings": [
    {
      "filePath": "path/to/file.ext",
      "line": 42,
      "severity": "critical|warning|suggestion",
      "category": "bug|security|performance|maintainability",
      "title": "short 3-7 word title",
      "message": "clear explanation of the issue and why it matters",
      "suggestedFix": "optional concrete code snippet or instruction to fix"
    }
  ]
}

Rules:
- Focus on high-signal issues; avoid nitpicking formatting
- severity MUST be one of: "critical", "warning", "suggestion"
- category MUST be one of: "bug", "security", "performance", "maintainability"
- riskLevel MUST be one of: "low", "medium", "high"
- If no issues are found, return an empty findings array with riskLevel "low"
"#;

/// System prompt for turning a PR review comment into a suggested patch
pub const COMMENT_RESOLUTION_PROMPT: &str = r#"You are an expert software engineer resolving a code review comment on a pull request.
You will be given the target file path, line number, reviewer comment, and the file content around that line.

Return ONLY a JSON object (no markdown fences) with this exact structure:
{
  "explanation": "1-2 sentence explanation of how the change addresses the reviewer's comment",
  "unifiedDiff": "valid unified diff (with --- a/path, +++ b/path, and @@ ... @@ hunks) OR leave empty if providing updatedSnippet",
  "originalSnippet": "exact contiguous lines from the file to replace (optional fallback)",
  "updatedSnippet": "replacement lines for originalSnippet (optional fallback)"
}

Rules:
- Preserve existing indentation and code style
- Only change the lines necessary to address the review comment
- Prefer providing both a valid unifiedDiff and originalSnippet/updatedSnippet so the patch can be verified cleanly
"#;

/// System prompt for explaining a CI failure
pub const CI_FAILURE_EXPLAIN_PROMPT: &str = r#"You are a CI/CD and build diagnostics specialist.
Given a failing CI check name, its log output or failure summary, and optional recent commit diff context, identify the root cause and provide a concrete fix.

Return ONLY a JSON object (no markdown fences) with this exact structure:
{
  "checkName": "name of the check",
  "rootCause": "concise explanation of why the CI check failed",
  "failingStep": "name of the failing job/step/command or null",
  "suggestedFix": "actionable steps or code changes to fix the failure",
  "relevantFiles": ["path/to/file1", "path/to/file2"]
}

Rules:
- Be specific and actionable
- Extract any file paths implicated by stack traces, compiler errors, test failures, or recent commit changes into relevantFiles
"#;

/// Refuse an AI request when the active provider's endpoint is blocked by security policy.
fn guard_ai_request(service: &AiService) -> Result<(), String> {
    match service.active_provider_endpoint() {
        Some(endpoint) => {
            crate::services::security::guard_endpoint(&endpoint).map_err(|e| e.to_string())
        }
        None => Ok(()),
    }
}

/// Strip markdown code fences from an LLM response if present.
pub(crate) fn strip_code_fences(s: &str) -> &str {
    let trimmed = s.trim();
    if trimmed.starts_with("```") {
        let after_open = trimmed
            .strip_prefix("```json")
            .or_else(|| trimmed.strip_prefix("```diff"))
            .or_else(|| trimmed.strip_prefix("```patch"))
            .or_else(|| trimmed.strip_prefix("```"))
            .unwrap_or(trimmed);
        after_open.strip_suffix("```").unwrap_or(after_open).trim()
    } else {
        trimmed
    }
}

/// Truncate content to at most `max_bytes` on a UTF-8 char and line boundary.
pub(crate) fn truncate_content(content: &str, max_bytes: usize) -> &str {
    if content.len() <= max_bytes {
        return content;
    }
    let head = truncate_at_char_boundary(content, max_bytes);
    match head.rfind('\n') {
        Some(pos) => &head[..pos],
        None => head,
    }
}

/// Resolve a git ref name (branch, `refs/heads/...`, `origin/...`, tag, or SHA) to a commit tree.
fn resolve_ref_tree<'repo>(
    repo: &'repo git2::Repository,
    ref_name: &str,
) -> Result<git2::Tree<'repo>, String> {
    let trimmed = ref_name.trim();
    if trimmed.is_empty() {
        return Err("Reference name cannot be empty".to_string());
    }
    crate::utils::reject_flag_like(trimmed, "Git ref").map_err(|e| e.to_string())?;

    let stripped = trimmed.trim_start_matches("refs/heads/");
    let candidates = [
        trimmed.to_string(),
        stripped.to_string(),
        format!("refs/heads/{}", stripped),
        format!("refs/remotes/origin/{}", stripped),
        format!("origin/{}", stripped),
    ];

    for candidate in &candidates {
        if let Ok(obj) = repo.revparse_single(candidate) {
            if let Ok(tree) = obj.peel_to_tree() {
                return Ok(tree);
            }
        }
    }

    Err(format!("Could not resolve git reference '{}'", trimmed))
}

/// Compute unified diff and count of changed files between `base_ref` and `head_ref` (or `HEAD`).
pub(crate) fn compute_branch_diff(
    repo_path: &Path,
    base_ref: &str,
    head_ref: Option<&str>,
) -> Result<(String, usize), String> {
    let repo = git2::Repository::open(repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let base_tree = resolve_ref_tree(&repo, base_ref)?;
    let head_target = head_ref
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("HEAD");
    let head_tree = resolve_ref_tree(&repo, head_target)?;

    let mut diff_opts = git2::DiffOptions::new();
    diff_opts.context_lines(3);

    // Compute diff from merge-base if available, otherwise directly from base_tree to head_tree
    let effective_base_tree = if let (Ok(base_obj), Ok(head_obj)) = (
        repo.revparse_single(base_ref.trim())
            .or_else(|_| repo.revparse_single(base_ref.trim().trim_start_matches("refs/heads/"))),
        repo.revparse_single(head_target)
            .or_else(|_| repo.revparse_single(head_target.trim_start_matches("refs/heads/"))),
    ) {
        if let (Ok(base_commit), Ok(head_commit)) =
            (base_obj.peel_to_commit(), head_obj.peel_to_commit())
        {
            if let Ok(merge_base_oid) = repo.merge_base(base_commit.id(), head_commit.id()) {
                if let Ok(mb_commit) = repo.find_commit(merge_base_oid) {
                    mb_commit.tree().ok()
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    let diff = repo
        .diff_tree_to_tree(
            Some(effective_base_tree.as_ref().unwrap_or(&base_tree)),
            Some(&head_tree),
            Some(&mut diff_opts),
        )
        .map_err(|e| format!("Failed to compute branch diff: {}", e))?;

    let files_reviewed = diff.deltas().len();
    let mut diff_str = String::new();

    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        if let Ok(content) = std::str::from_utf8(line.content()) {
            let prefix = match line.origin() {
                '+' => "+",
                '-' => "-",
                ' ' => " ",
                _ => "",
            };
            diff_str.push_str(prefix);
            diff_str.push_str(content);
        }
        true
    })
    .map_err(|e| format!("Failed to format diff: {}", e))?;

    Ok((diff_str, files_reviewed))
}

/// Fast local regex scanner for secrets, debug leftovers, and conflict markers in a unified diff.
pub(crate) fn scan_diff_local(diff: &str) -> Vec<AiReviewFinding> {
    let mut findings = Vec::new();

    let secret_patterns: Vec<(regex::Regex, &str, &str, &str)> = vec![
        (
            regex::Regex::new(r"AKIA[0-9A-Z]{16}").unwrap(),
            "Hardcoded AWS Access Key",
            "Possible AWS Access Key ID detected in added code.",
            "Move the AWS key to environment variables or a secret manager and rotate the exposed key.",
        ),
        (
            regex::Regex::new(r"-----BEGIN[A-Z ]*PRIVATE KEY-----").unwrap(),
            "Private Key in Diff",
            "A PEM-encoded private key was added to the repository.",
            "Remove the private key from version control, add the file to .gitignore, and revoke/rotate the key.",
        ),
        (
            regex::Regex::new(r#"(?i)(password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]"#).unwrap(),
            "Hardcoded Password",
            "Possible hardcoded password literal detected in added code.",
            "Read the password from secure configuration or OS keyring instead of hardcoding it.",
        ),
        (
            regex::Regex::new(r#"(?i)(api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]"#).unwrap(),
            "Hardcoded API Key",
            "Possible hardcoded API or secret key detected in added code.",
            "Store API keys in environment variables or secure credential storage.",
        ),
        (
            regex::Regex::new(r#"(?i)(token|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_\-.]{20,}['"]"#).unwrap(),
            "Hardcoded Auth Token",
            "Possible hardcoded authentication token detected in added code.",
            "Retrieve tokens dynamically or from the system keychain.",
        ),
    ];

    let debug_patterns: Vec<(regex::Regex, &str, &str, &str, &str, &str)> = vec![
        (
            regex::Regex::new(r"^(?:<{7}|={7}|>{7})(?:\s|$)").unwrap(),
            "critical",
            "bug",
            "Unresolved Merge Conflict Marker",
            "Unresolved git merge conflict marker found in added line.",
            "Resolve the merge conflict and remove the conflict markers before merging.",
        ),
        (
            regex::Regex::new(r"\bdebugger\s*;").unwrap(),
            "warning",
            "bug",
            "Leftover debugger Statement",
            "A `debugger;` statement was left in added code.",
            "Remove the `debugger;` statement before merging.",
        ),
        (
            regex::Regex::new(r"\b(?:todo!|unimplemented!)\s*\(").unwrap(),
            "warning",
            "bug",
            "Unimplemented Panic Macro",
            "A `todo!()` or `unimplemented!()` macro was added and will panic at runtime if reached.",
            "Implement the missing logic or return a handled error instead of panicking.",
        ),
        (
            regex::Regex::new(r"\bconsole\.(?:log|debug)\s*\(").unwrap(),
            "suggestion",
            "maintainability",
            "Leftover Console Debug Log",
            "Debug `console.log`/`console.debug` call detected in added code.",
            "Remove temporary console logging or replace with the structured logger.",
        ),
    ];

    let hunk_re = regex::Regex::new(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@").unwrap();

    let mut current_file = String::new();
    let mut current_new_line: Option<u32> = None;

    for raw_line in diff.lines() {
        if let Some(rest) = raw_line.strip_prefix("+++ b/") {
            current_file = rest.trim().to_string();
            current_new_line = None;
            continue;
        }
        if raw_line.starts_with("+++ ") || raw_line.starts_with("--- ") {
            continue;
        }
        if let Some(caps) = hunk_re.captures(raw_line) {
            if let Some(m) = caps.get(1) {
                current_new_line = m.as_str().parse::<u32>().ok();
            }
            continue;
        }

        if let Some(added) = raw_line.strip_prefix('+') {
            let line_no = current_new_line;
            let file_path = if current_file.is_empty() {
                "unknown".to_string()
            } else {
                current_file.clone()
            };

            for (re, title, message, fix) in &secret_patterns {
                if re.is_match(added) {
                    findings.push(AiReviewFinding {
                        file_path: file_path.clone(),
                        line: line_no,
                        severity: "critical".to_string(),
                        category: "security".to_string(),
                        title: (*title).to_string(),
                        message: (*message).to_string(),
                        suggested_fix: Some((*fix).to_string()),
                    });
                }
            }

            for (re, severity, category, title, message, fix) in &debug_patterns {
                if re.is_match(added) {
                    findings.push(AiReviewFinding {
                        file_path: file_path.clone(),
                        line: line_no,
                        severity: (*severity).to_string(),
                        category: (*category).to_string(),
                        title: (*title).to_string(),
                        message: (*message).to_string(),
                        suggested_fix: Some((*fix).to_string()),
                    });
                }
            }

            if let Some(n) = current_new_line {
                current_new_line = Some(n.saturating_add(1));
            }
        } else if raw_line.starts_with(' ') {
            if let Some(n) = current_new_line {
                current_new_line = Some(n.saturating_add(1));
            }
        }
    }

    findings
}

fn normalize_severity(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "critical" | "error" | "high" => "critical".to_string(),
        "warning" | "warn" | "medium" => "warning".to_string(),
        _ => "suggestion".to_string(),
    }
}

fn normalize_category(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "bug" | "correctness" | "defect" => "bug".to_string(),
        "security" | "secret" | "vulnerability" => "security".to_string(),
        "performance" | "perf" => "performance".to_string(),
        _ => "maintainability".to_string(),
    }
}

fn normalize_risk_level(raw: &str, findings: &[AiReviewFinding]) -> String {
    let has_critical = findings.iter().any(|f| f.severity == "critical");
    let has_warning = findings.iter().any(|f| f.severity == "warning");

    match raw.trim().to_ascii_lowercase().as_str() {
        "high" => "high".to_string(),
        "medium" if !has_critical => "medium".to_string(),
        "low" if !has_critical && !has_warning => "low".to_string(),
        _ => {
            if has_critical {
                "high".to_string()
            } else if has_warning {
                "medium".to_string()
            } else {
                "low".to_string()
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAiReviewFinding {
    #[serde(default)]
    file_path: String,
    #[serde(default)]
    line: Option<u32>,
    #[serde(default)]
    severity: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    suggested_fix: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAiBranchReview {
    #[serde(default)]
    summary: String,
    #[serde(default)]
    risk_level: String,
    #[serde(default)]
    findings: Vec<RawAiReviewFinding>,
}

/// Parse the AI response for branch review and merge with local findings.
pub(crate) fn parse_branch_review_response(
    response: &str,
    local_findings: Vec<AiReviewFinding>,
    files_reviewed: usize,
) -> Result<AiBranchReviewResult, String> {
    let json_str = strip_code_fences(response);
    let raw: RawAiBranchReview = serde_json::from_str(json_str)
        .map_err(|e| format!("Failed to parse AI branch review response: {}", e))?;

    let mut combined = local_findings;
    let mut seen: HashSet<(String, Option<u32>, String)> = combined
        .iter()
        .map(|f| (f.file_path.clone(), f.line, f.title.to_lowercase()))
        .collect();

    for item in raw.findings {
        if item.message.trim().is_empty() && item.title.trim().is_empty() {
            continue;
        }
        let title = if item.title.trim().is_empty() {
            "Code Review Finding".to_string()
        } else {
            item.title.trim().to_string()
        };
        let message = if item.message.trim().is_empty() {
            title.clone()
        } else {
            item.message.trim().to_string()
        };
        let file_path = item
            .file_path
            .trim()
            .trim_start_matches("b/")
            .trim_start_matches("a/")
            .to_string();
        let key = (file_path.clone(), item.line, title.to_lowercase());
        if seen.insert(key) {
            combined.push(AiReviewFinding {
                file_path,
                line: item.line,
                severity: normalize_severity(&item.severity),
                category: normalize_category(&item.category),
                title,
                message,
                suggested_fix: item
                    .suggested_fix
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty()),
            });
        }
    }

    let risk_level = normalize_risk_level(&raw.risk_level, &combined);
    let summary = if raw.summary.trim().is_empty() {
        if combined.is_empty() {
            format!(
                "Reviewed {} file(s); no significant issues found.",
                files_reviewed
            )
        } else {
            format!(
                "Reviewed {} file(s) and found {} issue(s).",
                files_reviewed,
                combined.len()
            )
        }
    } else {
        raw.summary.trim().to_string()
    };

    Ok(AiBranchReviewResult {
        summary,
        risk_level,
        findings: combined,
        files_reviewed,
    })
}

/// Review a branch or PR diff using both fast local secret/debug scanning and the active AI provider (#623).
#[command]
pub async fn review_branch_diff(
    state: State<'_, AiState>,
    path: String,
    base_ref: String,
    head_ref: Option<String>,
) -> Result<AiBranchReviewResult, String> {
    let service = state.read().await;
    guard_ai_request(&service)?;

    let repo_path = path.clone();
    let base = base_ref.clone();
    let head = head_ref.clone();

    let (diff_text, files_reviewed) = tokio::task::spawn_blocking(move || {
        compute_branch_diff(Path::new(&repo_path), &base, head.as_deref())
    })
    .await
    .map_err(|e| format!("Diff task failed: {}", e))??;

    if diff_text.trim().is_empty() {
        return Ok(AiBranchReviewResult {
            summary: "No changes found between the specified refs.".to_string(),
            risk_level: "low".to_string(),
            findings: vec![],
            files_reviewed: 0,
        });
    }

    let local_findings = scan_diff_local(&diff_text);
    let truncated_diff = truncate_content(&diff_text, MAX_DIFF_BYTES);
    let user_prompt = format!(
        "Base ref: {}\nHead ref: {}\nFiles changed: {}\n\nDiff:\n{}",
        base_ref.trim(),
        head_ref.as_deref().unwrap_or("HEAD").trim(),
        files_reviewed,
        truncated_diff
    );

    match service
        .generate_text_for_feature(
            "review_branch_diff",
            crate::services::ai::AiTaskTier::CodeReview,
            BRANCH_REVIEW_PROMPT,
            &user_prompt,
            Some(1500),
        )
        .await
    {
        Ok(response) => parse_branch_review_response(&response, local_findings, files_reviewed),
        Err(ai_err) => {
            if !local_findings.is_empty() {
                let risk_level = normalize_risk_level("", &local_findings);
                let summary = format!(
                    "Found {} issue(s) via local static scan across {} file(s) (AI provider unavailable: {}).",
                    local_findings.len(),
                    files_reviewed,
                    ai_err
                );
                Ok(AiBranchReviewResult {
                    summary,
                    risk_level,
                    findings: local_findings,
                    files_reviewed,
                })
            } else {
                Err(ai_err)
            }
        }
    }
}

// ============================================================================
// PR Review Comment -> Suggested Patch (#624)
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCommentResolution {
    #[serde(default)]
    explanation: String,
    #[serde(default)]
    unified_diff: String,
    #[serde(default)]
    original_snippet: Option<String>,
    #[serde(default)]
    updated_snippet: Option<String>,
}

/// Generate a unified diff between `old_content` and `new_content` for `file_path` using libgit2.
pub(crate) fn create_unified_diff_from_buffers(
    file_path: &str,
    old_content: &str,
    new_content: &str,
) -> Result<String, String> {
    let mut diff_opts = git2::DiffOptions::new();
    diff_opts.context_lines(3);

    let mut patch = git2::Patch::from_buffers(
        old_content.as_bytes(),
        Some(Path::new(file_path)),
        new_content.as_bytes(),
        Some(Path::new(file_path)),
        Some(&mut diff_opts),
    )
    .map_err(|e| format!("Failed to generate unified diff: {}", e))?;

    let buf = patch
        .to_buf()
        .map_err(|e| format!("Failed to serialize patch buffer: {}", e))?;
    std::str::from_utf8(&buf)
        .map(|s| s.to_string())
        .map_err(|e| format!("Patch contains invalid UTF-8: {}", e))
}

/// Check whether `unified_diff` parses as a valid git diff and applies cleanly to `repo_path`'s working tree.
pub(crate) fn check_patch_applies_cleanly(repo_path: &Path, unified_diff: &str) -> bool {
    if unified_diff.trim().is_empty() {
        return false;
    }
    let Ok(repo) = git2::Repository::open(repo_path) else {
        return false;
    };
    let Ok(diff) = git2::Diff::from_buffer(unified_diff.as_bytes()) else {
        return false;
    };
    if diff.deltas().len() == 0 {
        return false;
    }
    for delta in diff.deltas() {
        for p in [delta.old_file().path(), delta.new_file().path()]
            .into_iter()
            .flatten()
        {
            if let Some(s) = p.to_str() {
                if validate_path_within_repo(repo_path, s).is_err() {
                    return false;
                }
            } else {
                return false;
            }
        }
    }
    let mut apply_opts = git2::ApplyOptions::new();
    apply_opts.check(true);
    repo.apply(&diff, git2::ApplyLocation::WorkDir, Some(&mut apply_opts))
        .is_ok()
}

/// Apply `unified_diff` to the working tree of `repo_path` after validating all delta paths.
pub(crate) fn apply_unified_diff_to_workdir(
    repo_path: &Path,
    unified_diff: &str,
) -> Result<(), String> {
    if unified_diff.trim().is_empty() {
        return Err("Unified diff cannot be empty".to_string());
    }
    let repo = git2::Repository::open(repo_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;
    let diff = git2::Diff::from_buffer(unified_diff.as_bytes())
        .map_err(|e| format!("Invalid unified diff format: {}", e))?;

    if diff.deltas().len() == 0 {
        return Err("Unified diff contains no file changes".to_string());
    }

    for delta in diff.deltas() {
        for p in [delta.old_file().path(), delta.new_file().path()]
            .into_iter()
            .flatten()
        {
            let path_str = p
                .to_str()
                .ok_or_else(|| "Invalid UTF-8 in patch file path".to_string())?;
            validate_path_within_repo(repo_path, path_str).map_err(|e| e.to_string())?;
        }
    }

    // Dry-run check first so partial changes are never written on failure
    let mut check_opts = git2::ApplyOptions::new();
    check_opts.check(true);
    repo.apply(&diff, git2::ApplyLocation::WorkDir, Some(&mut check_opts))
        .map_err(|e| format!("Patch does not apply cleanly to working tree: {}", e))?;

    repo.apply(&diff, git2::ApplyLocation::WorkDir, None)
        .map_err(|e| format!("Failed to apply patch: {}", e))?;

    Ok(())
}

/// Extract surrounding lines around a 1-based line number from file content.
pub(crate) fn extract_file_window(
    file_content: &str,
    target_line: Option<u32>,
    radius: usize,
) -> (usize, usize, String) {
    let lines: Vec<&str> = file_content.lines().collect();
    if lines.is_empty() {
        return (1, 1, String::new());
    }
    let total = lines.len();
    let center_idx = target_line
        .and_then(|l| l.checked_sub(1))
        .map(|idx| (idx as usize).min(total.saturating_sub(1)))
        .unwrap_or(0);

    let start_idx = if target_line.is_some() {
        center_idx.saturating_sub(radius)
    } else {
        0
    };
    let end_idx = if target_line.is_some() {
        (center_idx + radius + 1).min(total)
    } else {
        total.min(radius * 2 + 1)
    };

    let mut numbered = String::new();
    for (i, line) in lines[start_idx..end_idx].iter().enumerate() {
        let line_num = start_idx + i + 1;
        numbered.push_str(&format!("{:>4} | {}\n", line_num, line));
    }
    (start_idx + 1, end_idx, numbered)
}

/// Build a `CommentResolutionPatch` from the AI response and the current file content.
pub(crate) fn build_comment_resolution_patch(
    repo_path: &Path,
    file_path: &str,
    original_content: &str,
    ai_response: &str,
) -> Result<CommentResolutionPatch, String> {
    let cleaned = strip_code_fences(ai_response);

    let (explanation, candidate_diff, original_snippet, updated_snippet) =
        if let Ok(parsed) = serde_json::from_str::<RawCommentResolution>(cleaned) {
            (
                parsed.explanation,
                strip_code_fences(&parsed.unified_diff).to_string(),
                parsed.original_snippet,
                parsed.updated_snippet,
            )
        } else if cleaned.contains("--- ") && cleaned.contains("+++ ") && cleaned.contains("@@") {
            (
                "Generated patch from review comment.".to_string(),
                cleaned.to_string(),
                None,
                None,
            )
        } else {
            return Err("Could not parse AI patch suggestion response".to_string());
        };

    let mut final_diff = candidate_diff;
    let mut applies = check_patch_applies_cleanly(repo_path, &final_diff);

    // If the raw unified diff from the model does not apply cleanly (e.g. slightly wrong hunk counts)
    // and we have original_snippet + updated_snippet, synthesize an exact diff with libgit2!
    if !applies {
        if let (Some(orig), Some(updated)) =
            (original_snippet.as_deref(), updated_snippet.as_deref())
        {
            if !orig.is_empty() && original_content.contains(orig) {
                let new_full = original_content.replacen(orig, updated, 1);
                if let Ok(synthesized) =
                    create_unified_diff_from_buffers(file_path, original_content, &new_full)
                {
                    if !synthesized.trim().is_empty() {
                        applies = check_patch_applies_cleanly(repo_path, &synthesized);
                        final_diff = synthesized;
                    }
                }
            }
        }
    }

    let explanation = if explanation.trim().is_empty() {
        format!("Suggested fix for review comment on {}", file_path)
    } else {
        explanation.trim().to_string()
    };

    Ok(CommentResolutionPatch {
        file_path: file_path.to_string(),
        explanation,
        unified_diff: final_diff,
        can_apply_cleanly: applies,
    })
}

/// Generate a suggested unified diff patch from a PR review comment (#624).
#[command]
pub async fn suggest_comment_resolution_patch(
    state: State<'_, AiState>,
    path: String,
    file_path: String,
    line: Option<u32>,
    comment_body: String,
) -> Result<CommentResolutionPatch, String> {
    let trimmed_comment = comment_body.trim();
    if trimmed_comment.is_empty() {
        return Err("Review comment body cannot be empty".to_string());
    }
    let trimmed_file = file_path.trim();
    if trimmed_file.is_empty() {
        return Err("File path cannot be empty".to_string());
    }

    let repo_root = Path::new(&path);
    let abs_file = validate_path_within_repo(repo_root, trimmed_file).map_err(|e| e.to_string())?;
    if !abs_file.exists() {
        return Err(format!(
            "Target file '{}' does not exist in the working tree",
            trimmed_file
        ));
    }

    let original_content = std::fs::read_to_string(&abs_file)
        .map_err(|e| format!("Failed to read '{}': {}", trimmed_file, e))?;

    let (start_line, end_line, numbered_window) = extract_file_window(&original_content, line, 25);
    let raw_window: String = original_content
        .lines()
        .skip(start_line.saturating_sub(1))
        .take(end_line.saturating_sub(start_line) + 1)
        .collect::<Vec<_>>()
        .join("\n");

    let service = state.read().await;
    guard_ai_request(&service)?;

    let user_prompt = format!(
        "File path: {}\nTarget line: {}\nReviewer comment:\n{}\n\nNumbered context (lines {}..={}):\n```\n{}\n```\n\nRaw excerpt (lines {}..={}):\n```\n{}\n```",
        trimmed_file,
        line.map(|l| l.to_string()).unwrap_or_else(|| "general".to_string()),
        trimmed_comment,
        start_line,
        end_line,
        numbered_window,
        start_line,
        end_line,
        truncate_content(&raw_window, MAX_DIFF_BYTES / 2),
    );

    let ai_response = service
        .generate_text_for_feature(
            "suggest_comment_resolution_patch",
            crate::services::ai::AiTaskTier::CodeReview,
            COMMENT_RESOLUTION_PROMPT,
            &user_prompt,
            Some(1500),
        )
        .await?;

    let repo_path_buf = repo_root.to_path_buf();
    let file_path_owned = trimmed_file.to_string();
    tokio::task::spawn_blocking(move || {
        build_comment_resolution_patch(
            &repo_path_buf,
            &file_path_owned,
            &original_content,
            &ai_response,
        )
    })
    .await
    .map_err(|e| format!("Patch verification task failed: {}", e))?
}

/// Apply a generated unified diff patch to the working tree (#624).
#[command]
pub async fn apply_comment_resolution_patch(
    path: String,
    unified_diff: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        apply_unified_diff_to_workdir(Path::new(&path), &unified_diff)
    })
    .await
    .map_err(|e| format!("Apply patch task failed: {}", e))?
}

// ============================================================================
// "Explain This CI Failure" (#626)
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCiFailureExplanation {
    #[serde(default)]
    check_name: String,
    #[serde(default)]
    root_cause: String,
    #[serde(default)]
    failing_step: Option<String>,
    #[serde(default)]
    suggested_fix: String,
    #[serde(default)]
    relevant_files: Vec<String>,
}

/// Get recent HEAD commit diff and changed file paths for CI failure context.
fn get_recent_head_context(repo_path: &Path) -> (String, Vec<String>) {
    let Ok(repo) = git2::Repository::open(repo_path) else {
        return (String::new(), Vec::new());
    };
    let Ok(head) = repo.head() else {
        return (String::new(), Vec::new());
    };
    let Ok(commit) = head.peel_to_commit() else {
        return (String::new(), Vec::new());
    };
    let Ok(head_tree) = commit.tree() else {
        return (String::new(), Vec::new());
    };
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());

    let mut diff_opts = git2::DiffOptions::new();
    diff_opts.context_lines(2);

    let Ok(diff) =
        repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&head_tree), Some(&mut diff_opts))
    else {
        return (String::new(), Vec::new());
    };

    let mut files = Vec::new();
    for delta in diff.deltas() {
        if let Some(p) = delta.new_file().path().or_else(|| delta.old_file().path()) {
            if let Some(s) = p.to_str() {
                files.push(s.to_string());
            }
        }
    }

    let mut diff_text = String::new();
    let _ = diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        if let Ok(content) = std::str::from_utf8(line.content()) {
            let prefix = match line.origin() {
                '+' => "+",
                '-' => "-",
                ' ' => " ",
                _ => "",
            };
            diff_text.push_str(prefix);
            diff_text.push_str(content);
        }
        true
    });

    (diff_text, files)
}

/// Extract file paths and failing step hints heuristically from a CI log or summary.
pub(crate) fn extract_ci_heuristics(
    log_text: &str,
    recent_files: &[String],
) -> (Option<String>, Vec<String>) {
    let file_re = regex::Regex::new(
        r"\b([A-Za-z0-9_./\-]+\.(?:rs|ts|tsx|js|jsx|py|go|java|cs|cpp|c|h|hpp|json|yml|yaml|toml|md|css|html))\b",
    )
    .unwrap();

    let mut files = Vec::new();
    let mut seen = HashSet::new();

    for cap in file_re.captures_iter(log_text) {
        if let Some(m) = cap.get(1) {
            let candidate = m.as_str().trim_start_matches("./").to_string();
            if seen.insert(candidate.clone()) {
                files.push(candidate);
            }
        }
    }

    for f in recent_files {
        if files.len() >= 8 {
            break;
        }
        if seen.insert(f.clone()) {
            files.push(f.clone());
        }
    }

    let mut failing_step = None;
    for line in log_text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("fail ")
            || lower.starts_with("failed:")
            || lower.starts_with("error:")
            || lower.starts_with("error[")
            || lower.contains("panicked at")
            || lower.contains("exit code")
            || lower.contains("step failed")
        {
            failing_step = Some(trimmed.chars().take(120).collect());
            break;
        }
    }

    (failing_step, files)
}

/// Parse the AI response for `explain_ci_failure`.
pub(crate) fn parse_ci_failure_response(
    response: &str,
    check_name: &str,
    fallback_step: Option<String>,
    fallback_files: Vec<String>,
) -> Result<CiFailureExplanation, String> {
    let json_str = strip_code_fences(response);
    let raw: RawCiFailureExplanation = serde_json::from_str(json_str)
        .map_err(|e| format!("Failed to parse CI failure explanation: {}", e))?;

    let root_cause = if raw.root_cause.trim().is_empty() {
        format!("Check '{}' reported a failure.", check_name)
    } else {
        raw.root_cause.trim().to_string()
    };

    let suggested_fix = if raw.suggested_fix.trim().is_empty() {
        "Inspect the failing step output and run the corresponding check locally.".to_string()
    } else {
        raw.suggested_fix.trim().to_string()
    };

    let failing_step = raw
        .failing_step
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or(fallback_step);

    let mut relevant_files: Vec<String> = raw
        .relevant_files
        .into_iter()
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .collect();
    if relevant_files.is_empty() {
        relevant_files = fallback_files;
    }

    Ok(CiFailureExplanation {
        check_name: if raw.check_name.trim().is_empty() {
            check_name.to_string()
        } else {
            raw.check_name.trim().to_string()
        },
        root_cause,
        failing_step,
        suggested_fix,
        relevant_files,
    })
}

/// Analyze a failing CI check or pipeline log and return structured root cause + actionable fix (#626).
#[command]
pub async fn explain_ci_failure(
    state: State<'_, AiState>,
    path: Option<String>,
    check_name: String,
    failure_log_or_summary: String,
) -> Result<CiFailureExplanation, String> {
    let trimmed_name = check_name.trim();
    if trimmed_name.is_empty() {
        return Err("Check name cannot be empty".to_string());
    }

    let service = state.read().await;
    guard_ai_request(&service)?;

    let (recent_diff, recent_files) = if let Some(ref repo_path) = path {
        let p = repo_path.trim().to_string();
        if !p.is_empty() {
            tokio::task::spawn_blocking(move || get_recent_head_context(Path::new(&p)))
                .await
                .unwrap_or_default()
        } else {
            (String::new(), Vec::new())
        }
    } else {
        (String::new(), Vec::new())
    };

    let (heuristic_step, heuristic_files) =
        extract_ci_heuristics(&failure_log_or_summary, &recent_files);

    let truncated_log = truncate_content(&failure_log_or_summary, MAX_DIFF_BYTES);
    let mut user_prompt = format!(
        "Check Name: {}\n\nFailure Log / Summary:\n{}\n",
        trimmed_name,
        if truncated_log.trim().is_empty() {
            "(No detailed log output provided; only check name and status available)"
        } else {
            truncated_log
        }
    );

    if !recent_diff.trim().is_empty() {
        let truncated_diff = truncate_content(&recent_diff, MAX_DIFF_BYTES / 2);
        user_prompt.push_str(&format!(
            "\nRecent HEAD commit diff:\n```diff\n{}\n```\n",
            truncated_diff
        ));
    }

    let response = service
        .generate_text_for_feature(
            "explain_ci_failure",
            crate::services::ai::AiTaskTier::CodeReview,
            CI_FAILURE_EXPLAIN_PROMPT,
            &user_prompt,
            Some(1000),
        )
        .await?;

    parse_ci_failure_response(&response, trimmed_name, heuristic_step, heuristic_files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[test]
    fn test_scan_diff_local_detects_secrets_and_debug_statements() {
        let sample_diff = r#"diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,3 +10,6 @@ export function login() {
   const user = getUser();
+  const awsKey = "AKIAIOSFODNN7EXAMPLE";
+  debugger;
+  console.log("debug user", user);
   return user;
 }
"#;

        let findings = scan_diff_local(sample_diff);
        assert_eq!(findings.len(), 3);

        let secret = findings.iter().find(|f| f.category == "security").unwrap();
        assert_eq!(secret.file_path, "src/auth.ts");
        assert_eq!(secret.line, Some(11));
        assert_eq!(secret.severity, "critical");

        let dbg = findings
            .iter()
            .find(|f| f.title.contains("debugger"))
            .unwrap();
        assert_eq!(dbg.file_path, "src/auth.ts");
        assert_eq!(dbg.line, Some(12));
        assert_eq!(dbg.severity, "warning");

        let log = findings
            .iter()
            .find(|f| f.title.contains("Console"))
            .unwrap();
        assert_eq!(log.file_path, "src/auth.ts");
        assert_eq!(log.line, Some(13));
        assert_eq!(log.severity, "suggestion");
    }

    #[test]
    fn test_parse_branch_review_response_merges_and_deduplicates() {
        let local = vec![AiReviewFinding {
            file_path: "src/app.ts".to_string(),
            line: Some(5),
            severity: "warning".to_string(),
            category: "bug".to_string(),
            title: "Leftover debugger Statement".to_string(),
            message: "Debugger found".to_string(),
            suggested_fix: Some("Remove debugger;".to_string()),
        }];

        let ai_json = r#"```json
{
  "summary": "Reviewed branch changes.",
  "riskLevel": "low",
  "findings": [
    {
      "filePath": "b/src/app.ts",
      "line": 5,
      "severity": "warning",
      "category": "bug",
      "title": "Leftover debugger statement",
      "message": "Duplicate from AI"
    },
    {
      "filePath": "src/db.rs",
      "line": 42,
      "severity": "critical",
      "category": "performance",
      "title": "Unbounded query in loop",
      "message": "N+1 query inside loop",
      "suggestedFix": "Batch the query outside the loop"
    }
  ]
}
```"#;

        let result = parse_branch_review_response(ai_json, local, 2).unwrap();
        assert_eq!(result.files_reviewed, 2);
        assert_eq!(result.findings.len(), 2);
        // Critical finding elevates risk level to "high" even if AI said "low"
        assert_eq!(result.risk_level, "high");
        assert_eq!(result.summary, "Reviewed branch changes.");
    }

    #[test]
    fn test_compute_branch_diff_between_branches() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("feature-review");
        repo.checkout_branch("feature-review");
        repo.create_commit(
            "Add feature module",
            &[("src/feature.ts", "export const x = 42;\n")],
        );

        let (diff, files_reviewed) =
            compute_branch_diff(&repo.path, "main", Some("feature-review")).unwrap();
        assert_eq!(files_reviewed, 1);
        assert!(diff.contains("+++ b/src/feature.ts"));
        assert!(diff.contains("+export const x = 42;"));
    }

    #[test]
    fn test_build_and_apply_comment_resolution_patch() {
        let repo = TestRepo::with_initial_commit();
        let initial_code = "function greet(name: string) {\n  return 'Hello ' + name;\n}\n";
        repo.create_commit("Add greet", &[("src/greet.ts", initial_code)]);

        let ai_response = r#"{
  "explanation": "Use template literal and trim the input name.",
  "unifiedDiff": "",
  "originalSnippet": "  return 'Hello ' + name;",
  "updatedSnippet": "  return `Hello ${name.trim()}`;"
}"#;

        let patch =
            build_comment_resolution_patch(&repo.path, "src/greet.ts", initial_code, ai_response)
                .unwrap();

        assert_eq!(patch.file_path, "src/greet.ts");
        assert!(patch.can_apply_cleanly);
        assert!(patch.unified_diff.contains("-  return 'Hello ' + name;"));
        assert!(patch
            .unified_diff
            .contains("+  return `Hello ${name.trim()}`;"));

        // Apply patch to working tree
        apply_unified_diff_to_workdir(&repo.path, &patch.unified_diff).unwrap();
        let updated_on_disk = std::fs::read_to_string(repo.path.join("src/greet.ts")).unwrap();
        assert!(updated_on_disk.contains("return `Hello ${name.trim()}`;"));
    }

    #[test]
    fn test_apply_unified_diff_rejects_path_traversal() {
        let repo = TestRepo::with_initial_commit();
        let malicious_diff = "\
--- a/../escape.txt
+++ b/../escape.txt
@@ -0,0 +1 @@
+pwned
";
        assert!(!check_patch_applies_cleanly(&repo.path, malicious_diff));
        let res = apply_unified_diff_to_workdir(&repo.path, malicious_diff);
        assert!(res.is_err());
    }

    #[test]
    fn test_parse_ci_failure_response_and_heuristics() {
        let log_text = "FAIL src/components/button.test.ts\nError: expected true to be false at src/components/button.ts:18:5";
        let recent = vec!["src/styles/theme.ts".to_string()];
        let (step, files) = extract_ci_heuristics(log_text, &recent);

        assert_eq!(step.as_deref(), Some("FAIL src/components/button.test.ts"));
        assert!(files.contains(&"src/components/button.test.ts".to_string()));
        assert!(files.contains(&"src/components/button.ts".to_string()));
        assert!(files.contains(&"src/styles/theme.ts".to_string()));

        let ai_json = r#"{
  "checkName": "unit-tests",
  "rootCause": "Assertion failed in button.test.ts because disabled state was inverted.",
  "failingStep": null,
  "suggestedFix": "Update disabled prop check in src/components/button.ts line 18.",
  "relevantFiles": []
}"#;

        let explanation = parse_ci_failure_response(ai_json, "unit-tests", step, files).unwrap();
        assert_eq!(explanation.check_name, "unit-tests");
        assert!(explanation.root_cause.contains("Assertion failed"));
        assert_eq!(
            explanation.failing_step.as_deref(),
            Some("FAIL src/components/button.test.ts")
        );
        assert_eq!(explanation.relevant_files.len(), 3);
    }
}
