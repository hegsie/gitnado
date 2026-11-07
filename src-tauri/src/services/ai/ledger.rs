//! AI Privacy & Activity Ledger
//!
//! Maintains an in-memory bounded ring buffer of recent AI calls so users can
//! audit which features invoked AI, whether execution stayed 100% local or went
//! to a cloud provider, estimated token counts, latency, and a redacted prompt
//! preview.

use super::config::AiTaskTier;
use super::AiProviderType;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// Maximum number of AI activity entries retained in the ring buffer.
pub const MAX_LEDGER_ENTRIES: usize = 200;

/// Maximum character length for a stored prompt preview.
pub const MAX_PROMPT_PREVIEW_CHARS: usize = 300;

/// A single recorded AI invocation in the privacy and activity ledger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLedgerEntry {
    pub id: u64,
    pub timestamp: i64,
    pub feature: String,
    pub task_tier: AiTaskTier,
    pub provider_type: AiProviderType,
    pub model: String,
    pub is_local: bool,
    pub prompt_bytes: usize,
    pub response_bytes: usize,
    pub estimated_tokens: usize,
    pub duration_ms: u64,
    pub success: bool,
    pub error_message: Option<String>,
    pub prompt_preview: String,
}

/// Aggregated privacy and activity statistics across the ledger.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPrivacySummary {
    pub total_calls: usize,
    pub local_calls: usize,
    pub cloud_calls: usize,
    pub total_estimated_tokens: usize,
    pub local_percentage: f64,
}

/// Input parameters for recording a ledger entry.
#[derive(Debug, Clone)]
pub struct NewAiLedgerEntry {
    pub feature: String,
    pub task_tier: AiTaskTier,
    pub provider_type: AiProviderType,
    pub model: String,
    pub is_local: bool,
    pub prompt_bytes: usize,
    pub response_bytes: usize,
    pub duration_ms: u64,
    pub success: bool,
    pub error_message: Option<String>,
    pub prompt: String,
}

/// Bounded ring buffer tracking AI operations.
#[derive(Debug)]
pub struct AiLedger {
    entries: VecDeque<AiLedgerEntry>,
    next_id: u64,
}

impl Default for AiLedger {
    fn default() -> Self {
        Self::new()
    }
}

impl AiLedger {
    pub fn new() -> Self {
        Self {
            entries: VecDeque::with_capacity(MAX_LEDGER_ENTRIES),
            next_id: 1,
        }
    }

    /// Record a new AI operation in the ring buffer.
    pub fn record(&mut self, input: NewAiLedgerEntry) -> AiLedgerEntry {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let estimated_tokens = (input.prompt_bytes.saturating_add(input.response_bytes)) / 4;
        let prompt_preview = redact_prompt_preview(&input.prompt);

        let entry = AiLedgerEntry {
            id,
            timestamp,
            feature: input.feature,
            task_tier: input.task_tier,
            provider_type: input.provider_type,
            model: input.model,
            is_local: input.is_local,
            prompt_bytes: input.prompt_bytes,
            response_bytes: input.response_bytes,
            estimated_tokens,
            duration_ms: input.duration_ms,
            success: input.success,
            error_message: input.error_message,
            prompt_preview,
        };

        if self.entries.len() >= MAX_LEDGER_ENTRIES {
            self.entries.pop_front();
        }
        self.entries.push_back(entry.clone());

        entry
    }

    /// Return all entries in reverse chronological order (newest first).
    pub fn list(&self) -> Vec<AiLedgerEntry> {
        self.entries.iter().rev().cloned().collect()
    }

    /// Clear all recorded entries.
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Compute the privacy and token usage summary.
    pub fn summary(&self) -> AiPrivacySummary {
        let total_calls = self.entries.len();
        let local_calls = self.entries.iter().filter(|e| e.is_local).count();
        let cloud_calls = total_calls.saturating_sub(local_calls);
        let total_estimated_tokens = self.entries.iter().map(|e| e.estimated_tokens).sum();
        let local_percentage = if total_calls == 0 {
            100.0
        } else {
            (local_calls as f64 / total_calls as f64) * 100.0
        };

        AiPrivacySummary {
            total_calls,
            local_calls,
            cloud_calls,
            total_estimated_tokens,
            local_percentage,
        }
    }
}

/// Truncate a prompt to ~300 characters and redact obvious bearer tokens or API keys.
pub fn redact_prompt_preview(prompt: &str) -> String {
    let trimmed = prompt.trim();
    let mut preview: String = trimmed.chars().take(MAX_PROMPT_PREVIEW_CHARS).collect();
    if trimmed.chars().count() > MAX_PROMPT_PREVIEW_CHARS {
        preview.push('…');
    }

    let patterns = [
        (r"(?i)bearer\s+[A-Za-z0-9_\-\.=]{8,}", "Bearer [REDACTED]"),
        (r"sk-[A-Za-z0-9_\-]{12,}", "[REDACTED_KEY]"),
        (r"gh[pousr]_[A-Za-z0-9_]{12,}", "[REDACTED_TOKEN]"),
        (r"AIza[A-Za-z0-9_\-]{12,}", "[REDACTED_KEY]"),
        (r"AKIA[0-9A-Z]{16}", "[REDACTED_AWS_KEY]"),
    ];

    for (pattern, replacement) in patterns {
        if let Ok(re) = regex::Regex::new(pattern) {
            preview = re.replace_all(&preview, replacement).into_owned();
        }
    }

    preview
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_redact_prompt_preview_truncates_and_redacts_tokens() {
        let raw = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 and key sk-proj-1234567890abcdef and ghp_abcdefghijklmnopqrst";
        let preview = redact_prompt_preview(raw);
        assert!(preview.contains("Bearer [REDACTED]"));
        assert!(preview.contains("[REDACTED_KEY]"));
        assert!(preview.contains("[REDACTED_TOKEN]"));
        assert!(!preview.contains("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
        assert!(!preview.contains("sk-proj-1234567890abcdef"));
    }

    #[test]
    fn test_redact_prompt_preview_multibyte_safe_truncation() {
        let long_multibyte = "é".repeat(400);
        let preview = redact_prompt_preview(&long_multibyte);
        assert_eq!(preview.chars().count(), MAX_PROMPT_PREVIEW_CHARS + 1);
        assert!(preview.ends_with('…'));
    }

    #[test]
    fn test_ledger_ring_buffer_and_summary() {
        let mut ledger = AiLedger::new();
        assert_eq!(ledger.summary().total_calls, 0);
        assert_eq!(ledger.summary().local_percentage, 100.0);

        for i in 0..(MAX_LEDGER_ENTRIES + 10) {
            let is_local = i % 2 == 0;
            ledger.record(NewAiLedgerEntry {
                feature: "commit_message".to_string(),
                task_tier: AiTaskTier::FastText,
                provider_type: if is_local {
                    AiProviderType::LocalInference
                } else {
                    AiProviderType::OpenAi
                },
                model: "test-model".to_string(),
                is_local,
                prompt_bytes: 400,
                response_bytes: 100,
                duration_ms: 42,
                success: true,
                error_message: None,
                prompt: format!("diff {i}"),
            });
        }

        let entries = ledger.list();
        assert_eq!(entries.len(), MAX_LEDGER_ENTRIES);
        // Newest entry is first
        assert_eq!(entries[0].id, (MAX_LEDGER_ENTRIES + 10) as u64);
        assert_eq!(entries[0].estimated_tokens, 125);

        let summary = ledger.summary();
        assert_eq!(summary.total_calls, MAX_LEDGER_ENTRIES);
        assert_eq!(summary.local_calls, MAX_LEDGER_ENTRIES / 2);
        assert_eq!(summary.cloud_calls, MAX_LEDGER_ENTRIES / 2);
        assert_eq!(summary.total_estimated_tokens, MAX_LEDGER_ENTRIES * 125);
        assert!((summary.local_percentage - 50.0).abs() < f64::EPSILON);

        ledger.clear();
        assert!(ledger.list().is_empty());
        assert_eq!(ledger.summary().total_calls, 0);
    }
}
