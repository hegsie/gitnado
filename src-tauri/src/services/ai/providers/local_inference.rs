//! Local inference AI provider
//!
//! Provides AI capabilities using a locally loaded model via llama.cpp.
//! No external services or API keys required.

use crate::services::ai::local::ModelTier;
use crate::services::ai::{AiProvider, AiProviderType, GeneratedCommitMessage};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Metadata about a loaded model, plumbed from the registry into inference.
#[derive(Debug, Clone)]
pub struct LoadedModelMeta {
    pub tier: ModelTier,
    pub architecture: String,
    pub context_length: u32,
}

/// Status of the local model
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalModelStatus {
    Unloaded,
    Loading,
    Ready,
    Error,
}

/// Trait for the inference engine (allows mocking in tests)
#[async_trait]
pub trait InferenceEngine: Send + Sync {
    /// Generate text given a prompt
    async fn generate(&self, prompt: &str, max_tokens: u32) -> Result<String, String>;
    /// Get the name of the loaded model
    fn model_name(&self) -> &str;
    /// Check if a model is loaded and ready
    fn is_ready(&self) -> bool;
    /// Get metadata about the loaded model (tier, architecture, context length)
    fn model_meta(&self) -> Option<&LoadedModelMeta> {
        None
    }
}

/// Format a prompt using the correct chat template for the model architecture.
fn format_prompt(arch: &str, system: &str, user: &str) -> String {
    match arch {
        "llama" => format!(
            "<|start_header_id|>system<|end_header_id|>\n\n{system}<|eot_id|>\
             <|start_header_id|>user<|end_header_id|>\n\n{user}<|eot_id|>\
             <|start_header_id|>assistant<|end_header_id|>\n\n"
        ),
        "gemma3" => format!(
            "<start_of_turn>user\n{system}\n\n{user}<end_of_turn>\n\
             <start_of_turn>model\n"
        ),
        "phi" => format!(
            "<|system|>\n{system}<|end|>\n\
             <|user|>\n{user}<|end|>\n\
             <|assistant|>\n"
        ),
        "qwen2" | "qwen3" | "qwen" => format!(
            "<|im_start|>system\n{system}<|im_end|>\n\
             <|im_start|>user\n{user}<|im_end|>\n\
             <|im_start|>assistant\n"
        ),
        "mistral" => format!("[INST] {system}\n\n{user} [/INST]"),
        _ => format!("{system}\n\n{user}"),
    }
}

/// Per-tier pipeline configuration controlling token budgets and condensing behavior.
struct PipelineConfig {
    per_file_tokens: u32,
    summary_tokens: u32,
    max_body_bullets: usize,
    enable_condensing: bool,
    condensing_tokens: u32,
    condensing_threshold: usize,
}

impl PipelineConfig {
    fn for_tier(tier: ModelTier) -> Self {
        match tier {
            ModelTier::UltraLight => Self {
                per_file_tokens: 25,
                summary_tokens: 30,
                max_body_bullets: 0,
                enable_condensing: false,
                condensing_tokens: 0,
                condensing_threshold: 0,
            },
            ModelTier::Pro => Self {
                per_file_tokens: 40,
                summary_tokens: 50,
                max_body_bullets: 12,
                enable_condensing: true,
                condensing_tokens: 200,
                condensing_threshold: 4,
            },
            _ => Self {
                per_file_tokens: 30,
                summary_tokens: 40,
                max_body_bullets: 10,
                enable_condensing: true,
                condensing_tokens: 150,
                condensing_threshold: 4,
            },
        }
    }
}

// System prompts for the commit message pipeline
const PERFILE_SYSTEM: &str = "In under 12 words, what is the purpose of this code change? \
    Use imperative mood (e.g. \"add\", \"fix\", \"update\", \"remove\"). \
    Output ONLY the description, no prefixes.";

const CONDENSE_SYSTEM: &str = "Group these file changes into 4-6 bullet points. \
    Combine related changes. Each line must start with \"- \". Imperative mood. \
    Output ONLY the bullets.";

const SUMMARY_SYSTEM_STANDARD: &str = "Synthesize ALL these changes into ONE conventional \
    commit summary. Do NOT repeat any single bullet. \
    Format: type(scope): description\n\
    Under 60 chars. Imperative mood. Output ONLY the summary line.";

/// Local inference provider implementation
///
/// All fields use Arc, so cloning shares state across instances.
#[derive(Clone)]
pub struct LocalInferenceProvider {
    engine: Arc<RwLock<Option<Box<dyn InferenceEngine>>>>,
    status: Arc<RwLock<LocalModelStatus>>,
    model_name: Arc<RwLock<Option<String>>>,
}

impl Default for LocalInferenceProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalInferenceProvider {
    pub fn new() -> Self {
        Self {
            engine: Arc::new(RwLock::new(None)),
            status: Arc::new(RwLock::new(LocalModelStatus::Unloaded)),
            model_name: Arc::new(RwLock::new(None)),
        }
    }

    /// Set the inference engine (called when a model is loaded)
    pub async fn set_engine(&self, engine: Box<dyn InferenceEngine>) {
        let name = engine.model_name().to_string();
        *self.engine.write().await = Some(engine);
        *self.status.write().await = LocalModelStatus::Ready;
        *self.model_name.write().await = Some(name);
    }

    /// Clear the engine (called when model is unloaded)
    pub async fn clear_engine(&self) {
        *self.engine.write().await = None;
        *self.status.write().await = LocalModelStatus::Unloaded;
        *self.model_name.write().await = None;
    }

    /// Get the current model status
    pub async fn get_status(&self) -> LocalModelStatus {
        *self.status.read().await
    }

    /// Set status to loading (called during model load)
    pub async fn set_loading(&self) {
        *self.status.write().await = LocalModelStatus::Loading;
    }

    /// Set status to error
    pub async fn set_error(&self) {
        *self.status.write().await = LocalModelStatus::Error;
    }

    /// Get the loaded model name
    pub async fn get_model_name(&self) -> Option<String> {
        self.model_name.read().await.clone()
    }
}

#[async_trait]
impl AiProvider for LocalInferenceProvider {
    fn provider_type(&self) -> AiProviderType {
        AiProviderType::LocalInference
    }

    fn name(&self) -> &str {
        "Local AI (Embedded)"
    }

    async fn is_available(&self) -> bool {
        let engine = self.engine.read().await;
        engine.as_ref().is_some_and(|e| e.is_ready())
    }

    async fn list_models(&self) -> Result<Vec<String>, String> {
        let name = self.model_name.read().await;
        match name.as_ref() {
            Some(n) => Ok(vec![n.clone()]),
            None => Ok(vec![]),
        }
    }

    async fn generate_commit_message(
        &self,
        diff: &str,
        _model: Option<&str>,
    ) -> Result<GeneratedCommitMessage, String> {
        let engine = self.engine.read().await;
        let engine = engine
            .as_ref()
            .ok_or("No model loaded. Please download and load a model in Settings > Local AI.")?;

        // Get model metadata for architecture-aware prompting and tier-based pipeline
        let meta = engine.model_meta();
        let arch = meta.map(|m| m.architecture.as_str()).unwrap_or("llama");
        let tier = meta.map(|m| m.tier).unwrap_or(ModelTier::Standard);
        let config = PipelineConfig::for_tier(tier);

        // Multi-pass approach for accurate commit messages:
        // Pass 1: Summarize every file's diff individually
        // Pass 2: If many summaries, condense into grouped higher-level bullets (Standard only)
        // Pass 3: Generate the summary line from the final bullet list
        let file_diffs = extract_file_diffs(diff);

        if file_diffs.is_empty() {
            return Err("No changes to summarize".to_string());
        }

        // Pass 1: Summarize every file (~1-2s per file on Apple Silicon)
        let mut file_summaries = Vec::new();
        for file_diff in &file_diffs {
            let user_content = format!("File: {}\n{}", file_diff.path, file_diff.content);
            let prompt = format_prompt(arch, PERFILE_SYSTEM, &user_content);
            match engine.generate(&prompt, config.per_file_tokens).await {
                Ok(desc) => {
                    let desc = clean_bullet_text(&desc);
                    if !desc.is_empty() {
                        file_summaries.push(format!("- {}", desc));
                    }
                }
                Err(e) => {
                    tracing::warn!("Failed to summarize {}: {e}", file_diff.path);
                }
            }
        }

        if file_summaries.is_empty() {
            return Err("No changes to summarize".to_string());
        }

        tracing::debug!(
            "Per-file summaries ({}):\n{}",
            file_summaries.len(),
            file_summaries.join("\n")
        );

        // Deduplicate near-identical summaries and cap the total.
        // UltraLight models produce short, generic summaries that trigger false
        // positives in dedup — skip it entirely and just cap the list.
        // Standard models get light dedup (cap only, no word-overlap checks)
        // since the condensing pass handles grouping.
        let mut body_bullets = match tier {
            ModelTier::UltraLight => file_summaries,
            _ => {
                let cap = if config.max_body_bullets == 0 {
                    usize::MAX
                } else {
                    config.max_body_bullets
                };
                if file_summaries.len() > cap {
                    file_summaries.into_iter().take(cap).collect()
                } else {
                    file_summaries
                }
            }
        };

        // Pass 2: Condense (Standard tier only, when above threshold)
        if config.enable_condensing && body_bullets.len() > config.condensing_threshold {
            let raw_list = body_bullets.join("\n");
            let prompt = format_prompt(arch, CONDENSE_SYSTEM, &raw_list);

            match engine.generate(&prompt, config.condensing_tokens).await {
                Ok(response) => {
                    let condensed: Vec<String> = response
                        .lines()
                        .map(|l| l.trim())
                        .filter(|l| l.starts_with('-') || l.starts_with('*'))
                        .map(|l| {
                            let s = l
                                .strip_prefix("- ")
                                .or_else(|| l.strip_prefix("* "))
                                .unwrap_or(l)
                                .trim();
                            format!("- {s}")
                        })
                        .filter(|l| l.len() > 2)
                        .collect();

                    // Require at least 3 bullets to accept condensing, otherwise keep originals
                    if condensed.len() >= 3 {
                        tracing::debug!(
                            "Condensed {} bullets to {}",
                            body_bullets.len(),
                            condensed.len()
                        );
                        body_bullets = condensed;
                    } else {
                        tracing::debug!(
                            "Condensing returned {} bullets (< 3), keeping originals",
                            condensed.len()
                        );
                    }
                }
                Err(e) => {
                    tracing::warn!("Condensing pass failed: {e}, keeping original bullets");
                }
            }
        }

        let changes_text = body_bullets.join("\n");
        tracing::debug!(
            "After dedup: {} bullets (tier={:?}):\n{}",
            body_bullets.len(),
            tier,
            changes_text
        );

        // Pass 3: Generate the summary line
        let summary = if tier == ModelTier::UltraLight {
            // 1B models can't synthesize — build summary heuristically from bullets + file paths
            let file_paths: Vec<&str> = file_diffs.iter().map(|f| f.path.as_str()).collect();
            build_summary_from_bullets(&body_bullets, &file_paths)
        } else {
            let prompt = format_prompt(arch, SUMMARY_SYSTEM_STANDARD, &changes_text);
            let response = engine.generate(&prompt, config.summary_tokens).await?;
            tracing::debug!("Raw summary response:\n{response}");
            clean_summary_line(&response)
        };

        // Use the bullet list as the commit body (only if 2+ bullets add value)
        let body = if body_bullets.len() >= 2 {
            tracing::debug!("Including body with {} bullets", body_bullets.len());
            Some(changes_text)
        } else {
            tracing::debug!(
                "Omitting body ({} bullet(s) < 2 threshold)",
                body_bullets.len()
            );
            None
        };

        Ok(GeneratedCommitMessage { summary, body })
    }

    async fn generate_text(
        &self,
        system_prompt: &str,
        user_prompt: &str,
        _model: Option<&str>,
        max_tokens: Option<u32>,
    ) -> Result<String, String> {
        let engine = self.engine.read().await;
        let engine = engine
            .as_ref()
            .ok_or("No model loaded. Please download and load a model in Settings > Local AI.")?;

        let arch = engine
            .model_meta()
            .map(|m| m.architecture.as_str())
            .unwrap_or("llama");
        let prompt = format_prompt(arch, system_prompt, user_prompt);
        engine.generate(&prompt, max_tokens.unwrap_or(512)).await
    }
}

/// Extract per-file diffs from a unified diff string.
///
/// Each file gets its own diff chunk (added/removed lines with some context)
/// so it can be independently summarized by the model.
fn extract_file_diffs(diff: &str) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_lines: Vec<String> = Vec::new();
    // Track the path from "diff --git" for binary files that lack "+++ b/" lines
    let mut pending_diff_path: Option<String> = None;

    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            // Extract path from "diff --git a/foo b/foo" — take the "b/" part
            if let Some(b_path) = rest.split(" b/").last() {
                pending_diff_path = Some(b_path.to_string());
            }
            continue;
        } else if let Some(path) = line.strip_prefix("+++ b/") {
            // Flush previous file
            if let Some(prev) = current_path.take() {
                files.push(FileDiff {
                    path: prev,
                    content: std::mem::take(&mut current_lines).join("\n"),
                });
            }
            current_path = Some(path.to_string());
            pending_diff_path = None;
        } else if line.contains("Binary files") || line.contains("GIT binary patch") {
            // Binary file — use the path from the preceding "diff --git" line
            if let Some(path) = pending_diff_path.take() {
                // Flush any previous file first
                if let Some(prev) = current_path.take() {
                    files.push(FileDiff {
                        path: prev,
                        content: std::mem::take(&mut current_lines).join("\n"),
                    });
                }
                files.push(FileDiff {
                    path,
                    content: "[binary file modified]".to_string(),
                });
            }
        } else if line.starts_with("--- ") {
            continue;
        } else if current_path.is_some() {
            // Keep +/- lines, @@ headers, and surrounding context lines
            // so the model can understand what the changed code relates to
            current_lines.push(line.to_string());
        }
    }

    // Flush last file
    if let Some(path) = current_path {
        files.push(FileDiff {
            path,
            content: current_lines.join("\n"),
        });
    }

    // Truncate each file's content to keep batches within model context.
    // Each batch has ~3 files, and the model has ~8192 tokens (~32K chars).
    // Budget ~2000 chars per file to leave room for the prompt template.
    let max_bytes_per_file = if files.len() > 10 { 1500 } else { 2500 };
    for file in &mut files {
        if file.content.len() > max_bytes_per_file {
            // On a char boundary: the budget is a BYTE count, and slicing a
            // &str mid-character panics — which killed the whole local-model
            // summary for any diff carrying non-ASCII text.
            file.content =
                crate::services::ai::truncate_at_char_boundary(&file.content, max_bytes_per_file)
                    .to_string();
            file.content.push_str("\n[truncated]");
        }
    }

    files
}

struct FileDiff {
    path: String,
    content: String,
}

/// Clean a model response into a single bullet description.
///
/// Strips preamble like "Here is the description:", bullet markers, quotes,
/// and takes only the first meaningful line.
fn clean_bullet_text(text: &str) -> String {
    let text = text.trim();

    // Take only the first non-empty, meaningful line
    let line = text
        .lines()
        .map(|l| l.trim())
        .find(|l| {
            !l.is_empty()
                && !l.to_lowercase().starts_with("here is")
                && !l.to_lowercase().starts_with("the purpose")
                && !l.to_lowercase().starts_with("this code")
                && !l.to_lowercase().starts_with("file:")
                && !l.starts_with("@@")
                && !l.starts_with("diff ")
                && !l.starts_with("+++")
                && !l.starts_with("---")
                && !l.ends_with(':')
        })
        .unwrap_or("");

    // Strip bullet markers, quotes, backticks
    let line = line
        .strip_prefix("- ")
        .or_else(|| line.strip_prefix("* "))
        .unwrap_or(line);
    let line = line.trim_matches('"').trim_matches('\'').trim_matches('`');

    // Reject single-word responses and raw diff artifacts
    let word_count = line.split_whitespace().count();
    if word_count < 2 || line.starts_with("@@") || line.contains("<|") {
        return String::new();
    }

    // Capitalize first letter
    let mut chars = line.chars();
    match chars.next() {
        Some(c) => {
            let first = c.to_uppercase().to_string();
            format!("{first}{}", chars.as_str())
        }
        None => String::new(),
    }
}

/// Extract and clean the first meaningful line from a model's summary response.
///
/// Strips leading bullet markers, quotes, backticks, and preamble so we get
/// a clean conventional-commit summary line.
fn clean_summary_line(response: &str) -> String {
    let line = response
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .unwrap_or("chore: update code");

    // Strip leading bullet markers
    let line = line
        .strip_prefix("- ")
        .or_else(|| line.strip_prefix("* "))
        .unwrap_or(line);

    // Strip surrounding quotes and backticks
    let line = line
        .trim_matches('"')
        .trim_matches('\'')
        .trim_matches('`')
        .trim();

    if line.is_empty() {
        "chore: update code".to_string()
    } else {
        line.to_string()
    }
}

/// Build a conventional commit summary heuristically from per-file bullets and paths.
///
/// Used for UltraLight (1B) models that can't synthesize a summary from bullets.
/// Determines the commit type from bullet text, scope from file paths, and
/// picks the most representative bullet as the description.
fn build_summary_from_bullets(bullets: &[String], file_paths: &[&str]) -> String {
    // Count action verbs to determine commit type
    let bullet_text: Vec<&str> = bullets
        .iter()
        .map(|b| b.strip_prefix("- ").unwrap_or(b))
        .collect();

    let (mut adds, mut fixes, mut updates, mut removes) = (0u32, 0u32, 0u32, 0u32);
    for text in &bullet_text {
        let lower = text.to_lowercase();
        if lower.starts_with("add") || lower.starts_with("implement") || lower.starts_with("create")
        {
            adds += 1;
        } else if lower.starts_with("fix") || lower.starts_with("resolve") {
            fixes += 1;
        } else if lower.starts_with("update")
            || lower.starts_with("change")
            || lower.starts_with("modify")
            || lower.starts_with("refactor")
        {
            updates += 1;
        } else if lower.starts_with("remove") || lower.starts_with("delete") {
            removes += 1;
        } else {
            updates += 1; // default
        }
    }

    let commit_type = if fixes > adds && fixes > updates {
        "fix"
    } else if adds >= updates && adds >= removes {
        "feat"
    } else if removes > adds && removes > updates {
        "refactor"
    } else {
        "chore"
    };

    // Derive scope from file paths — find the most common top-level directory
    let scope = derive_scope(file_paths);

    // Pick the most descriptive bullet (longest that isn't too long)
    let description = bullet_text
        .iter()
        .filter(|b| b.len() >= 10 && b.len() <= 60)
        .max_by_key(|b| b.len())
        .or(bullet_text.first())
        .map(|b| {
            // Lowercase the first char for conventional commit style
            let mut chars = b.chars();
            match chars.next() {
                Some(c) => format!("{}{}", c.to_lowercase(), chars.as_str()),
                None => b.to_string(),
            }
        })
        .unwrap_or_else(|| "update code".to_string());

    // Strip trailing period
    let description = description.trim_end_matches('.');

    let summary = if scope.is_empty() {
        format!("{commit_type}: {description}")
    } else {
        format!("{commit_type}({scope}): {description}")
    };

    // Truncate to 72 chars
    if summary.len() > 72 {
        format!("{}...", &summary[..69])
    } else {
        summary
    }
}

/// Derive a scope name from file paths by finding the most common directory.
fn derive_scope(paths: &[&str]) -> String {
    if paths.is_empty() {
        return String::new();
    }

    // Count occurrences of each top-level meaningful directory segment
    let mut dir_counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for path in paths {
        // Skip common prefixes and find the meaningful directory
        let segments: Vec<&str> = path.split('/').collect();
        // Look for a meaningful segment (skip "src", "src-tauri", "lib", etc.)
        let scope_segment = segments
            .iter()
            .find(|s| {
                !matches!(
                    **s,
                    "src"
                        | "src-tauri"
                        | "lib"
                        | "app"
                        | "tests"
                        | "test"
                        | "e2e"
                        | "components"
                        | "services"
                        | "commands"
                        | "models"
                        | "utils"
                        | "fixtures"
                        | "pages"
                        | "__tests__"
                )
            })
            .or(segments.get(1).or(segments.first()));

        if let Some(seg) = scope_segment {
            // Strip file extension if it's a file
            let name = if seg.contains('.') {
                seg.split('.').next().unwrap_or(seg)
            } else {
                seg
            };
            if !name.is_empty() {
                *dir_counts.entry(name).or_default() += 1;
            }
        }
    }

    // Return the most common segment if it covers >40% of files
    dir_counts
        .iter()
        .max_by_key(|(_, count)| *count)
        .filter(|(_, count)| **count * 100 / paths.len() > 40)
        .map(|(name, _)| name.to_string())
        .unwrap_or_default()
}

/// Parse a raw AI response into a structured commit message.
///
/// Strips common boilerplate that small models produce, then takes the first
/// line that looks like a commit message as the summary.
#[cfg(test)]
fn parse_commit_message(text: &str) -> Result<GeneratedCommitMessage, String> {
    let cleaned = clean_response(text);
    let lines: Vec<&str> = cleaned.lines().collect();

    if lines.is_empty() {
        return Err("Empty response from AI".to_string());
    }

    // First non-empty line is the summary — strip surrounding quotes
    let summary = lines
        .iter()
        .find(|l| !l.trim().is_empty())
        .map(|s| {
            let s = s.trim();
            // Strip surrounding quotes (single or double)
            let s = s.strip_prefix('"').unwrap_or(s);
            let s = s.strip_suffix('"').unwrap_or(s);
            let s = s.strip_prefix('\'').unwrap_or(s);
            let s = s.strip_suffix('\'').unwrap_or(s);
            // Strip backtick wrapping
            let s = s.strip_prefix('`').unwrap_or(s);
            let s = s.strip_suffix('`').unwrap_or(s);
            s.trim().to_string()
        })
        .ok_or("No commit message generated")?;

    // Find the summary line index
    let summary_idx = lines.iter().position(|l| !l.trim().is_empty()).unwrap_or(0);

    // Rest becomes the body. Look for content after the summary:
    // 1. Prefer content after a blank line (standard git format)
    // 2. Fall back to the very next line if it exists (model skipped blank line)
    let body = if lines.len() > summary_idx + 1 {
        // Check if there's a blank line after summary
        let body_start =
            if summary_idx + 1 < lines.len() && lines[summary_idx + 1].trim().is_empty() {
                // Standard format: summary, blank line, body
                summary_idx + 2
            } else {
                // No blank line — body starts immediately after summary
                summary_idx + 1
            };

        if body_start < lines.len() {
            let body_text: String = lines[body_start..]
                .iter()
                .map(|s| s.trim())
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string();

            if !body_text.is_empty() {
                Some(body_text)
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    Ok(GeneratedCommitMessage { summary, body })
}

/// Strip boilerplate that small models commonly produce around commit messages.
#[cfg(test)]
fn clean_response(text: &str) -> String {
    let text = text.trim();

    // Remove markdown code fences
    let text = text
        .strip_prefix("```")
        .unwrap_or(text)
        .strip_suffix("```")
        .unwrap_or(text)
        .trim();

    // Skip preamble lines like "Here is...", "Sure...", "Commit message:", etc.
    let lines: Vec<&str> = text.lines().collect();
    let skip = lines
        .iter()
        .position(|l| {
            let trimmed = l.trim();
            // Strip leading quotes/backticks so we detect `"feat(...)` as a commit line
            let stripped = trimmed
                .strip_prefix('"')
                .or_else(|| trimmed.strip_prefix('\''))
                .or_else(|| trimmed.strip_prefix('`'))
                .unwrap_or(trimmed);
            let lower = stripped.to_lowercase();
            // A real commit line starts with a conventional commit type or looks like one
            lower.starts_with("feat")
                || lower.starts_with("fix")
                || lower.starts_with("docs")
                || lower.starts_with("style")
                || lower.starts_with("refactor")
                || lower.starts_with("test")
                || lower.starts_with("chore")
                || lower.starts_with("build")
                || lower.starts_with("ci")
                || lower.starts_with("perf")
        })
        .unwrap_or(0);

    let result: String = lines[skip..].join("\n");

    // Strip trailing repetition / filler after double newline followed by non-body content
    // (e.g. "Let me know if..." or "---" separators)
    if let Some(pos) = result.find("\n---") {
        result[..pos].trim().to_string()
    } else {
        result.trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockEngine {
        response: String,
        meta: Option<LoadedModelMeta>,
    }

    impl MockEngine {
        fn new(response: &str) -> Self {
            Self {
                response: response.to_string(),
                meta: None,
            }
        }

        fn with_meta(mut self, meta: LoadedModelMeta) -> Self {
            self.meta = Some(meta);
            self
        }
    }

    #[async_trait]
    impl InferenceEngine for MockEngine {
        async fn generate(&self, prompt: &str, _max_tokens: u32) -> Result<String, String> {
            if prompt.contains("purpose of this code change") {
                // Pass 1: per-file summary — vary by file to avoid dedup collapsing all
                if prompt.contains("f0") {
                    Ok("add new feature line".to_string())
                } else if prompt.contains("f1") {
                    Ok("update configuration settings".to_string())
                } else if prompt.contains("f2") {
                    Ok("fix error handling logic".to_string())
                } else if prompt.contains("f3") {
                    Ok("improve test coverage".to_string())
                } else if prompt.contains("f4") {
                    Ok("refactor module structure".to_string())
                } else if prompt.contains("f5") {
                    Ok("add logging statements".to_string())
                } else if prompt.contains("f6") {
                    Ok("update documentation comments".to_string())
                } else if prompt.contains("f7") {
                    Ok("remove deprecated code".to_string())
                } else {
                    Ok("add new feature line".to_string())
                }
            } else if prompt.contains("Group these file changes") {
                // Pass 2: condensing
                Ok(
                    "- Add new features\n- Update configuration\n- Improve test coverage"
                        .to_string(),
                )
            } else if prompt.contains("commit summary")
                || prompt.contains("git commit summary")
                || prompt.contains("conventional")
            {
                // Pass 3: summary line generation
                Ok(self.response.clone())
            } else {
                Ok(self.response.clone())
            }
        }
        fn model_name(&self) -> &str {
            "mock-model"
        }
        fn is_ready(&self) -> bool {
            true
        }
        fn model_meta(&self) -> Option<&LoadedModelMeta> {
            self.meta.as_ref()
        }
    }

    #[tokio::test]
    async fn test_provider_not_available_without_engine() {
        let provider = LocalInferenceProvider::new();
        assert!(!provider.is_available().await);
    }

    #[tokio::test]
    async fn test_provider_available_with_engine() {
        let provider = LocalInferenceProvider::new();
        let engine = MockEngine::new("test");
        provider.set_engine(Box::new(engine)).await;
        assert!(provider.is_available().await);
    }

    #[tokio::test]
    async fn test_generate_commit_message() {
        let provider = LocalInferenceProvider::new();
        let engine = MockEngine::new("feat: add new feature").with_meta(LoadedModelMeta {
            tier: ModelTier::UltraLight,
            architecture: "llama".to_string(),
            context_length: 8192,
        });
        provider.set_engine(Box::new(engine)).await;

        let diff = "diff --git a/src/main.rs b/src/main.rs\n--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1,1 +1,2 @@\n+new_line";
        let result = provider.generate_commit_message(diff, None).await;
        assert!(result.is_ok());
        let msg = result.unwrap();
        // UltraLight builds summary heuristically from bullets
        assert!(msg.summary.starts_with("feat"));
        assert!(msg.summary.contains("add new feature line"));
        // Single file diff — body is omitted (1 bullet adds nothing over summary)
        assert!(msg.body.is_none());
    }

    #[tokio::test]
    async fn test_generate_without_engine_fails() {
        let provider = LocalInferenceProvider::new();
        let result = provider.generate_commit_message("diff", None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_clear_engine() {
        let provider = LocalInferenceProvider::new();
        let engine = MockEngine::new("test");
        provider.set_engine(Box::new(engine)).await;
        assert!(provider.is_available().await);

        provider.clear_engine().await;
        assert!(!provider.is_available().await);
        assert_eq!(provider.get_status().await, LocalModelStatus::Unloaded);
    }

    #[tokio::test]
    async fn test_list_models_empty() {
        let provider = LocalInferenceProvider::new();
        let models = provider.list_models().await.unwrap();
        assert!(models.is_empty());
    }

    #[tokio::test]
    async fn test_list_models_with_engine() {
        let provider = LocalInferenceProvider::new();
        let engine = MockEngine::new("test");
        provider.set_engine(Box::new(engine)).await;
        let models = provider.list_models().await.unwrap();
        assert_eq!(models, vec!["mock-model"]);
    }

    #[tokio::test]
    async fn test_status_transitions() {
        let provider = LocalInferenceProvider::new();
        assert_eq!(provider.get_status().await, LocalModelStatus::Unloaded);

        provider.set_loading().await;
        assert_eq!(provider.get_status().await, LocalModelStatus::Loading);

        provider.set_error().await;
        assert_eq!(provider.get_status().await, LocalModelStatus::Error);

        let engine = MockEngine::new("test");
        provider.set_engine(Box::new(engine)).await;
        assert_eq!(provider.get_status().await, LocalModelStatus::Ready);
    }

    #[tokio::test]
    async fn test_get_model_name() {
        let provider = LocalInferenceProvider::new();
        assert!(provider.get_model_name().await.is_none());

        let engine = MockEngine::new("test");
        provider.set_engine(Box::new(engine)).await;
        assert_eq!(
            provider.get_model_name().await,
            Some("mock-model".to_string())
        );
    }

    #[tokio::test]
    async fn test_provider_type() {
        let provider = LocalInferenceProvider::new();
        assert_eq!(provider.provider_type(), AiProviderType::LocalInference);
    }

    #[tokio::test]
    async fn test_provider_name() {
        let provider = LocalInferenceProvider::new();
        assert_eq!(provider.name(), "Local AI (Embedded)");
    }

    #[tokio::test]
    async fn test_generate_text_without_engine_fails() {
        let provider = LocalInferenceProvider::new();
        let result = provider.generate_text("system", "user", None, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_generate_text_with_engine() {
        let provider = LocalInferenceProvider::new();
        let engine = MockEngine::new("generated text");
        provider.set_engine(Box::new(engine)).await;

        let result = provider
            .generate_text("system prompt", "user prompt", None, Some(100))
            .await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "generated text");
    }

    #[test]
    fn test_parse_commit_message_summary_only() {
        let result = parse_commit_message("fix: resolve crash on startup").unwrap();
        assert_eq!(result.summary, "fix: resolve crash on startup");
        assert!(result.body.is_none());
    }

    #[test]
    fn test_parse_commit_message_with_body() {
        let result =
            parse_commit_message("feat: add new feature\n\nDetailed description here").unwrap();
        assert_eq!(result.summary, "feat: add new feature");
        assert_eq!(result.body, Some("Detailed description here".to_string()));
    }

    #[test]
    fn test_parse_commit_message_empty() {
        let result = parse_commit_message("");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_commit_message_whitespace_only() {
        let result = parse_commit_message("   \n  \n  ");
        assert!(result.is_err());
    }

    #[test]
    fn test_clean_response_strips_preamble() {
        let input = "Here is the commit message:\n\nfeat: add login page";
        let result = parse_commit_message(input).unwrap();
        assert_eq!(result.summary, "feat: add login page");
    }

    #[test]
    fn test_clean_response_strips_code_fences() {
        let input = "```\nfix: resolve null pointer\n```";
        let result = parse_commit_message(input).unwrap();
        assert_eq!(result.summary, "fix: resolve null pointer");
    }

    #[test]
    fn test_clean_response_strips_trailing_separator() {
        let input =
            "refactor: extract helper\n\nSimplify logic\n---\nLet me know if you need changes";
        let result = parse_commit_message(input).unwrap();
        assert_eq!(result.summary, "refactor: extract helper");
        assert_eq!(result.body, Some("Simplify logic".to_string()));
    }

    #[test]
    fn test_clean_response_no_conventional_prefix() {
        // If model doesn't use conventional format, still take the first line
        let input = "Update the readme file";
        let result = parse_commit_message(input).unwrap();
        assert_eq!(result.summary, "Update the readme file");
    }

    #[test]
    fn test_parse_quoted_commit_with_preamble() {
        // Model wraps commit in quotes and adds preamble — both should be handled
        let input =
            "Here is the commit message:\n\n\"feat(auth): add token validation\"\n\nImprove authentication by checking token expiry.";
        let result = parse_commit_message(input).unwrap();
        assert_eq!(result.summary, "feat(auth): add token validation");
        assert_eq!(
            result.body,
            Some("Improve authentication by checking token expiry.".to_string())
        );
    }

    #[test]
    fn test_parse_quoted_summary_no_body() {
        let input = "\"fix: resolve null pointer\"";
        let result = parse_commit_message(input).unwrap();
        assert_eq!(result.summary, "fix: resolve null pointer");
        assert!(result.body.is_none());
    }

    #[test]
    fn test_parse_backtick_wrapped_summary() {
        let input = "`chore: update dependencies`";
        let result = parse_commit_message(input).unwrap();
        assert_eq!(result.summary, "chore: update dependencies");
        assert!(result.body.is_none());
    }

    #[test]
    fn test_parse_body_without_blank_line() {
        // Model produces bullets immediately after summary (no blank line)
        let input = "refactor(tests): update test imports\n- Refactored e2e tests\n- Removed unused imports";
        let result = parse_commit_message(input).unwrap();
        assert_eq!(result.summary, "refactor(tests): update test imports");
        assert_eq!(
            result.body,
            Some("- Refactored e2e tests\n- Removed unused imports".to_string())
        );
    }

    #[test]
    fn test_clean_summary_line_basic() {
        assert_eq!(clean_summary_line("feat: add login"), "feat: add login");
    }

    #[test]
    fn test_clean_summary_line_strips_quotes() {
        assert_eq!(
            clean_summary_line("\"fix: resolve crash\""),
            "fix: resolve crash"
        );
        assert_eq!(
            clean_summary_line("`chore: update deps`"),
            "chore: update deps"
        );
    }

    #[test]
    fn test_clean_summary_line_strips_bullet() {
        assert_eq!(
            clean_summary_line("- feat: add feature"),
            "feat: add feature"
        );
    }

    #[test]
    fn test_clean_summary_line_empty_response() {
        assert_eq!(clean_summary_line(""), "chore: update code");
        assert_eq!(clean_summary_line("   \n  "), "chore: update code");
    }

    #[test]
    fn test_clean_summary_line_multiline_takes_first() {
        assert_eq!(
            clean_summary_line("feat: add login\n\nsome body text"),
            "feat: add login"
        );
    }

    #[tokio::test]
    async fn test_generate_commit_message_many_files() {
        // 7 files with Standard tier should trigger the condensing pass (threshold=6)
        let provider = LocalInferenceProvider::new();
        let engine =
            MockEngine::new("feat(ai): update inference pipeline").with_meta(LoadedModelMeta {
                tier: ModelTier::Standard,
                architecture: "llama".to_string(),
                context_length: 8192,
            });
        provider.set_engine(Box::new(engine)).await;

        let mut diff = String::new();
        for i in 0..7 {
            diff.push_str(&format!(
                "diff --git a/src/f{i}.rs b/src/f{i}.rs\n--- a/src/f{i}.rs\n+++ b/src/f{i}.rs\n@@ -1,1 +1,2 @@\n+line{i}\n"
            ));
        }

        let result = provider.generate_commit_message(&diff, None).await;
        assert!(result.is_ok());
        let msg = result.unwrap();
        assert_eq!(msg.summary, "feat(ai): update inference pipeline");
        // Condensing pass returns 3 bullets
        assert!(msg.body.is_some());
        let body = msg.body.unwrap();
        assert!(body.contains("Add new features"));
        assert!(body.contains("Update configuration"));
        assert!(body.contains("Improve test coverage"));
    }

    #[tokio::test]
    async fn test_generate_commit_ultralight_many_files() {
        // UltraLight should NOT condense even with many files
        let provider = LocalInferenceProvider::new();
        let engine = MockEngine::new("chore: update multiple files").with_meta(LoadedModelMeta {
            tier: ModelTier::UltraLight,
            architecture: "gemma3".to_string(),
            context_length: 8192,
        });
        provider.set_engine(Box::new(engine)).await;

        let mut diff = String::new();
        for i in 0..8 {
            diff.push_str(&format!(
                "diff --git a/src/f{i}.rs b/src/f{i}.rs\n--- a/src/f{i}.rs\n+++ b/src/f{i}.rs\n@@ -1,1 +1,2 @@\n+line{i}\n"
            ));
        }

        let result = provider.generate_commit_message(&diff, None).await;
        assert!(result.is_ok());
        let msg = result.unwrap();
        // UltraLight builds summary heuristically
        assert!(
            msg.summary.contains(':'),
            "Expected conventional commit format, got: {}",
            msg.summary
        );
        // UltraLight: no condensing pass, all unique bullets pass through
        assert!(msg.body.is_some());
        let body = msg.body.unwrap();
        // Verify original per-file bullets are present (not condensed)
        assert!(body.contains("Add new feature line"));
        assert!(body.contains("Update configuration settings"));
        assert!(body.contains("Refactor module structure"));
    }

    #[test]
    fn test_extract_file_diffs_single_file() {
        let diff = "\
diff --git a/src/auth.rs b/src/auth.rs
--- a/src/auth.rs
+++ b/src/auth.rs
@@ -1,3 +1,5 @@
-    token.len() > 0
+    if token.is_empty() {
+        return false;
+    }
+    claims.exp > Utc::now().timestamp()";

        let files = extract_file_diffs(diff);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/auth.rs");
        assert!(files[0].content.contains("token.len() > 0"));
        assert!(files[0].content.contains("token.is_empty()"));
    }

    #[test]
    fn test_extract_file_diffs_multiple_files() {
        let diff = "\
diff --git a/src/a.rs b/src/a.rs
--- a/src/a.rs
+++ b/src/a.rs
@@ -1,1 +1,1 @@
-old_line
+new_line
diff --git a/src/b.rs b/src/b.rs
--- a/src/b.rs
+++ b/src/b.rs
@@ -1,1 +1,1 @@
-another_old
+another_new";

        let files = extract_file_diffs(diff);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "src/a.rs");
        assert_eq!(files[1].path, "src/b.rs");
        assert!(files[0].content.contains("old_line"));
        assert!(files[1].content.contains("another_new"));
    }

    #[test]
    fn test_extract_file_diffs_empty() {
        let files = extract_file_diffs("");
        assert!(files.is_empty());
    }

    /// The per-file budget is a BYTE count, so a multi-byte character sitting
    /// across it panicked — killing the local-model commit summary for any diff
    /// with an accent, a CJK identifier or an emoji in it, which is routine.
    #[test]
    fn test_extract_file_diffs_truncates_multibyte_content_without_panicking() {
        // 'é' is two bytes, so the 2500-byte cut lands mid-character for one of
        // these lengths whatever the header adds.
        for pad in 0..4 {
            let body = format!("{}{}", "a".repeat(pad), "é".repeat(4000));
            let diff = format!(
                "diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -0,0 +1 @@\n+{}",
                body
            );

            let files = extract_file_diffs(&diff);
            assert_eq!(files.len(), 1);
            assert!(
                files[0].content.ends_with("\n[truncated]"),
                "oversized content must be truncated"
            );
            assert!(
                files[0].content.len() <= 2500 + "\n[truncated]".len(),
                "truncation must respect the budget"
            );
        }
    }

    #[test]
    fn test_extract_file_diffs_binary_file() {
        let diff = "\
diff --git a/project.xcuserstate b/project.xcuserstate
Binary files a/project.xcuserstate and b/project.xcuserstate differ";

        let files = extract_file_diffs(diff);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "project.xcuserstate");
        assert_eq!(files[0].content, "[binary file modified]");
    }

    #[test]
    fn test_extract_file_diffs_mixed_text_and_binary() {
        let diff = "\
diff --git a/src/main.rs b/src/main.rs
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,1 +1,1 @@
-old_code
+new_code
diff --git a/assets/icon.png b/assets/icon.png
Binary files a/assets/icon.png and b/assets/icon.png differ";

        let files = extract_file_diffs(diff);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "src/main.rs");
        assert!(files[0].content.contains("new_code"));
        assert_eq!(files[1].path, "assets/icon.png");
        assert_eq!(files[1].content, "[binary file modified]");
    }

    #[test]
    fn test_format_prompt_llama() {
        let result = format_prompt("llama", "sys", "usr");
        assert!(result.contains("<|start_header_id|>system<|end_header_id|>"));
        assert!(result.contains("sys"));
        assert!(result.contains("usr"));
        assert!(result.contains("<|eot_id|>"));
        assert!(result.ends_with("<|start_header_id|>assistant<|end_header_id|>\n\n"));
    }

    #[test]
    fn test_format_prompt_gemma3() {
        let result = format_prompt("gemma3", "sys", "usr");
        assert!(result.contains("<start_of_turn>user"));
        assert!(result.contains("sys\n\nusr"));
        assert!(result.contains("<end_of_turn>"));
        assert!(result.ends_with("<start_of_turn>model\n"));
    }

    #[test]
    fn test_format_prompt_phi() {
        let result = format_prompt("phi", "sys", "usr");
        assert!(result.contains("<|system|>"));
        assert!(result.contains("<|user|>"));
        assert!(result.contains("<|assistant|>"));
        assert!(result.contains("<|end|>"));
    }

    #[test]
    fn test_format_prompt_qwen() {
        for arch in ["qwen", "qwen2", "qwen3"] {
            let result = format_prompt(arch, "sys", "usr");
            assert!(result.contains("<|im_start|>system\nsys<|im_end|>"));
            assert!(result.contains("<|im_start|>user\nusr<|im_end|>"));
            assert!(result.ends_with("<|im_start|>assistant\n"));
        }
    }

    #[test]
    fn test_format_prompt_mistral() {
        let result = format_prompt("mistral", "sys", "usr");
        assert_eq!(result, "[INST] sys\n\nusr [/INST]");
    }

    #[test]
    fn test_format_prompt_fallback() {
        let result = format_prompt("unknown-arch", "sys", "usr");
        assert_eq!(result, "sys\n\nusr");
    }

    #[test]
    fn test_pipeline_config_ultralight() {
        let config = PipelineConfig::for_tier(ModelTier::UltraLight);
        assert_eq!(config.per_file_tokens, 25);
        assert_eq!(config.summary_tokens, 30);
        assert_eq!(config.max_body_bullets, 0); // unlimited
        assert!(!config.enable_condensing);
    }

    #[test]
    fn test_pipeline_config_standard() {
        let config = PipelineConfig::for_tier(ModelTier::Standard);
        assert_eq!(config.per_file_tokens, 30);
        assert_eq!(config.summary_tokens, 40);
        assert_eq!(config.max_body_bullets, 10);
        assert!(config.enable_condensing);
        assert_eq!(config.condensing_tokens, 150);
        assert_eq!(config.condensing_threshold, 4);
    }

    #[test]
    fn test_pipeline_config_pro() {
        let config = PipelineConfig::for_tier(ModelTier::Pro);
        assert_eq!(config.per_file_tokens, 40);
        assert_eq!(config.summary_tokens, 50);
        assert_eq!(config.max_body_bullets, 12);
        assert!(config.enable_condensing);
        assert_eq!(config.condensing_tokens, 200);
        assert_eq!(config.condensing_threshold, 4);
    }

    #[test]
    fn test_build_summary_adds() {
        let bullets = vec![
            "- Add new login page".to_string(),
            "- Add auth middleware".to_string(),
            "- Add user model".to_string(),
        ];
        let paths = vec![
            "src/auth/login.rs",
            "src/auth/middleware.rs",
            "src/auth/model.rs",
        ];
        let summary = build_summary_from_bullets(&bullets, &paths);
        assert!(summary.starts_with("feat(auth):"), "got: {summary}");
    }

    #[test]
    fn test_build_summary_fixes() {
        let bullets = vec![
            "- Fix crash on empty input".to_string(),
            "- Resolve null pointer in parser".to_string(),
        ];
        let paths = vec!["src/parser/main.rs", "src/parser/util.rs"];
        let summary = build_summary_from_bullets(&bullets, &paths);
        assert!(summary.starts_with("fix(parser):"), "got: {summary}");
    }

    #[test]
    fn test_build_summary_no_scope() {
        let bullets = vec![
            "- Add feature A".to_string(),
            "- Update feature B".to_string(),
            "- Fix feature C".to_string(),
        ];
        let paths = vec!["src/alpha/foo.rs", "src/beta/bar.rs", "src/gamma/baz.rs"];
        let summary = build_summary_from_bullets(&bullets, &paths);
        // No dominant directory — no scope
        assert!(!summary.contains('('), "got: {summary}");
    }

    #[test]
    fn test_build_summary_truncates_long() {
        let bullets = vec![
            "- Add a very long description that goes on and on about what was changed in this file"
                .to_string(),
        ];
        let paths = vec!["src/main.rs"];
        let summary = build_summary_from_bullets(&bullets, &paths);
        assert!(
            summary.len() <= 72,
            "got {} chars: {summary}",
            summary.len()
        );
    }

    #[test]
    fn test_derive_scope_dominant() {
        let paths = vec!["src/ai/foo.rs", "src/ai/bar.rs", "src/ai/baz.rs"];
        assert_eq!(derive_scope(&paths), "ai");
    }

    #[test]
    fn test_derive_scope_no_dominant() {
        let paths = vec!["src/a/foo.rs", "src/b/bar.rs", "src/c/baz.rs"];
        assert_eq!(derive_scope(&paths), "");
    }

    #[test]
    fn test_clean_bullet_rejects_single_word() {
        assert_eq!(clean_bullet_text("Update"), "");
        assert_eq!(clean_bullet_text("Add"), "");
    }

    #[test]
    fn test_clean_bullet_rejects_diff_artifacts() {
        assert_eq!(clean_bullet_text("@@ -668,7 +668,51 @@ struct Foo"), "");
    }
}
