//! AI provider configuration management

use super::AiProviderType;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

const CONFIG_FILE: &str = "ai_config.json";

/// Settings for a single provider
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    /// Whether this provider is enabled
    #[serde(default)]
    pub enabled: bool,

    /// Custom endpoint URL (if not using default)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,

    /// Selected model for this provider
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,

    /// API key for this provider (stored in config for now, could move to OS keyring)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

/// Task tiers for per-feature AI model routing
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiTaskTier {
    /// Commit messages, branch naming, reflog matching
    FastText,
    /// Staged analysis (vibe check), conflict explanation, PR descriptions, changelogs
    CodeReview,
    /// Conflict resolution, commit splitting, history recomposition
    ReasoningMerge,
}

impl AiTaskTier {
    pub fn all() -> Vec<AiTaskTier> {
        vec![
            AiTaskTier::FastText,
            AiTaskTier::CodeReview,
            AiTaskTier::ReasoningMerge,
        ]
    }
}

/// Provider and optional model override for a specific task tier
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTaskRoute {
    pub provider: AiProviderType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// Complete AI configuration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    /// Currently active provider
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_provider: Option<AiProviderType>,

    /// Per-provider settings
    #[serde(default)]
    pub providers: HashMap<AiProviderType, ProviderSettings>,

    /// Per-task tier routing overrides
    #[serde(default)]
    pub task_routes: HashMap<AiTaskTier, AiTaskRoute>,
}

impl AiConfig {
    /// Load configuration from disk
    pub fn load(config_dir: &Path) -> Result<Self, String> {
        let config_path = config_dir.join(CONFIG_FILE);

        if !config_path.exists() {
            return Ok(Self::default());
        }

        let contents = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read AI config: {}", e))?;

        serde_json::from_str(&contents).map_err(|e| format!("Failed to parse AI config: {}", e))
    }

    /// Save configuration to disk
    pub fn save(&self, config_dir: &Path) -> Result<(), String> {
        // Ensure config directory exists
        std::fs::create_dir_all(config_dir)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;

        let config_path = config_dir.join(CONFIG_FILE);

        let contents = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize AI config: {}", e))?;

        std::fs::write(&config_path, contents)
            .map_err(|e| format!("Failed to write AI config: {}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_config_save_and_load() {
        let temp_dir = TempDir::new().unwrap();
        let config_dir = temp_dir.path();

        let mut config = AiConfig {
            active_provider: Some(AiProviderType::Ollama),
            ..Default::default()
        };
        config.providers.insert(
            AiProviderType::Ollama,
            ProviderSettings {
                enabled: true,
                endpoint: None,
                model: Some("llama3.2".to_string()),
                api_key: None,
            },
        );

        // Save
        config.save(config_dir).unwrap();

        // Load
        let loaded = AiConfig::load(config_dir).unwrap();

        assert_eq!(loaded.active_provider, Some(AiProviderType::Ollama));
        assert!(loaded.providers.contains_key(&AiProviderType::Ollama));
    }

    #[test]
    fn test_config_load_nonexistent() {
        let temp_dir = TempDir::new().unwrap();
        let config = AiConfig::load(temp_dir.path()).unwrap();
        assert!(config.active_provider.is_none());
        assert!(config.task_routes.is_empty());
    }

    #[test]
    fn test_task_tier_serialization_and_task_routes_persistence() {
        let temp_dir = TempDir::new().unwrap();
        let config_dir = temp_dir.path();

        assert_eq!(
            serde_json::to_string(&AiTaskTier::FastText).unwrap(),
            "\"fast_text\""
        );
        assert_eq!(
            serde_json::to_string(&AiTaskTier::CodeReview).unwrap(),
            "\"code_review\""
        );
        assert_eq!(
            serde_json::to_string(&AiTaskTier::ReasoningMerge).unwrap(),
            "\"reasoning_merge\""
        );

        let mut config = AiConfig::default();
        config.task_routes.insert(
            AiTaskTier::FastText,
            AiTaskRoute {
                provider: AiProviderType::LocalInference,
                model: None,
            },
        );
        config.task_routes.insert(
            AiTaskTier::ReasoningMerge,
            AiTaskRoute {
                provider: AiProviderType::Anthropic,
                model: Some("claude-sonnet-4-5".to_string()),
            },
        );

        config.save(config_dir).unwrap();
        let loaded = AiConfig::load(config_dir).unwrap();
        assert_eq!(loaded.task_routes.len(), 2);
        assert_eq!(
            loaded.task_routes.get(&AiTaskTier::FastText),
            Some(&AiTaskRoute {
                provider: AiProviderType::LocalInference,
                model: None,
            })
        );
        assert_eq!(
            loaded.task_routes.get(&AiTaskTier::ReasoningMerge),
            Some(&AiTaskRoute {
                provider: AiProviderType::Anthropic,
                model: Some("claude-sonnet-4-5".to_string()),
            })
        );

        // Backwards compatibility with older config files missing `taskRoutes`
        let legacy_json = r#"{"activeProvider":"ollama","providers":{}}"#;
        let legacy: AiConfig = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(legacy.active_provider, Some(AiProviderType::Ollama));
        assert!(legacy.task_routes.is_empty());
    }
}
