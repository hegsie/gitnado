//! AI provider configuration management

use super::AiProviderType;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

const CONFIG_FILE: &str = "ai_config.json";

/// OS keyring service under which provider API keys are stored.
pub const AI_KEYRING_SERVICE: &str = "gitnado-ai";

/// Secret storage for provider API keys. The production implementation is the
/// OS keyring; tests substitute an in-memory store.
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// [`SecretStore`] backed by the same OS keyring helpers as integration tokens.
pub struct KeyringSecretStore;

impl SecretStore for KeyringSecretStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        crate::commands::credentials::read_keyring_token(AI_KEYRING_SERVICE, account)
            .map_err(|e| e.to_string())
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        crate::commands::credentials::write_keyring_token(AI_KEYRING_SERVICE, account, secret)
            .map_err(|e| e.to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        crate::commands::credentials::remove_keyring_token(AI_KEYRING_SERVICE, account)
            .map_err(|e| e.to_string())
    }
}

/// Keyring account name holding the API key of `provider`.
pub fn api_key_account(provider: AiProviderType) -> String {
    let name = serde_json::to_value(provider)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    format!("api-key:{name}")
}

/// Why loading the configuration failed. A secret failure carries the parsed
/// configuration so callers can retain non-secret settings; saving remains
/// blocked so a legacy plaintext key cannot be destroyed.
#[derive(Debug)]
pub enum ConfigLoadError {
    Parse(String),
    Secret {
        message: String,
        config: Box<AiConfig>,
    },
}

impl std::fmt::Display for ConfigLoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Parse(m) => f.write_str(m),
            Self::Secret { message, .. } => f.write_str(message),
        }
    }
}

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

    /// API key for this provider. Held in memory only: it is persisted in the
    /// OS keyring, never serialized. It is still deserialized so that keys
    /// written to `ai_config.json` by older versions can be migrated.
    #[serde(default, skip_serializing)]
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

    /// Provider-specific keyring read failures. This is runtime state only;
    /// non-secret AI settings remain usable when one provider's key is unreadable.
    #[serde(skip)]
    pub key_errors: HashMap<AiProviderType, String>,
}

impl AiConfig {
    /// Load configuration from disk, with API keys resolved from the OS keyring
    pub fn load(config_dir: &Path) -> Result<Self, String> {
        Self::load_with(config_dir, &KeyringSecretStore).map_err(|e| e.to_string())
    }

    /// Load configuration, migrating legacy plaintext API keys into `store`.
    ///
    /// The file is rewritten without keys only after every legacy key has been
    /// stored. A read failure is recorded per provider so unrelated settings
    /// remain available; a failed migration still leaves the file untouched.
    pub fn load_with(config_dir: &Path, store: &dyn SecretStore) -> Result<Self, ConfigLoadError> {
        let config_path = config_dir.join(CONFIG_FILE);

        if !config_path.exists() {
            return Ok(Self::default());
        }

        let contents = std::fs::read_to_string(&config_path)
            .map_err(|e| ConfigLoadError::Parse(format!("Failed to read AI config: {}", e)))?;

        let mut config: Self = serde_json::from_str(&contents)
            .map_err(|e| ConfigLoadError::Parse(format!("Failed to parse AI config: {}", e)))?;

        let mut migrated = false;
        let mut migration_error = None;
        for (provider, settings) in config.providers.iter_mut() {
            if !provider.requires_api_key() {
                if settings.api_key.take().is_some() {
                    // This provider cannot use API keys. Drop any legacy value
                    // and scrub it from the file without requiring a keyring.
                    migrated = true;
                }
                continue;
            }

            let account = api_key_account(*provider);
            match settings.api_key.take().filter(|k| !k.is_empty()) {
                Some(legacy) => {
                    if let Err(e) = store.set(&account, &legacy) {
                        settings.api_key = Some(legacy);
                        migration_error = Some(format!(
                            "Failed to move the {} API key into the OS keyring: {}. \
                             ai_config.json was left unchanged.",
                            account, e
                        ));
                        break;
                    }
                    settings.api_key = Some(legacy);
                    migrated = true;
                }
                None => match store.get(&account) {
                    Ok(api_key) => settings.api_key = api_key,
                    Err(e) => {
                        config.key_errors.insert(
                            *provider,
                            format!(
                                "Failed to read the {} API key from the OS keyring: {}",
                                account, e
                            ),
                        );
                        settings.api_key = None;
                    }
                },
            }
        }

        if let Some(message) = migration_error {
            return Err(ConfigLoadError::Secret {
                message,
                config: Box::new(config),
            });
        }

        if migrated {
            if let Err(message) = config.save(config_dir) {
                return Err(ConfigLoadError::Secret {
                    message,
                    config: Box::new(config),
                });
            }
        }

        Ok(config)
    }

    /// Save configuration to disk. API keys are never written.
    pub fn save(&self, config_dir: &Path) -> Result<(), String> {
        // Ensure config directory exists
        std::fs::create_dir_all(config_dir)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;

        let config_path = config_dir.join(CONFIG_FILE);

        let contents = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize AI config: {}", e))?;

        // Write-then-rename so a crash cannot leave a truncated config.
        let tmp_path = config_dir.join(format!("{}.tmp", CONFIG_FILE));
        std::fs::write(&tmp_path, contents)
            .map_err(|e| format!("Failed to write AI config: {}", e))?;
        std::fs::rename(&tmp_path, &config_path)
            .map_err(|e| format!("Failed to write AI config: {}", e))
    }
}

#[cfg(test)]
pub(crate) mod tests {
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

    use std::sync::Mutex;

    #[derive(Default)]
    pub(crate) struct MemorySecretStore {
        pub secrets: Mutex<HashMap<String, String>>,
        pub fail: std::sync::atomic::AtomicBool,
    }

    impl MemorySecretStore {
        fn check(&self) -> Result<(), String> {
            if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
                Err("keyring unavailable".to_string())
            } else {
                Ok(())
            }
        }
    }

    impl SecretStore for MemorySecretStore {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            self.check()?;
            Ok(self.secrets.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            self.check()?;
            self.secrets
                .lock()
                .unwrap()
                .insert(account.to_string(), secret.to_string());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.check()?;
            self.secrets.lock().unwrap().remove(account);
            Ok(())
        }
    }

    const LEGACY_JSON: &str = r#"{"activeProvider":"open_ai","providers":{"open_ai":{"enabled":true,"model":"gpt","apiKey":"sk-legacy"}}}"#;

    #[test]
    fn test_save_never_serializes_api_key() {
        let dir = TempDir::new().unwrap();
        let mut config = AiConfig::default();
        config.providers.insert(
            AiProviderType::OpenAi,
            ProviderSettings {
                enabled: true,
                api_key: Some("sk-secret".to_string()),
                ..Default::default()
            },
        );
        config.save(dir.path()).unwrap();
        let raw = std::fs::read_to_string(dir.path().join(CONFIG_FILE)).unwrap();
        assert!(!raw.contains("sk-secret"));
        assert!(!raw.to_lowercase().contains("apikey"));
    }

    #[test]
    fn test_legacy_key_migrates_to_store_and_is_scrubbed_from_disk() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(CONFIG_FILE), LEGACY_JSON).unwrap();
        let store = MemorySecretStore::default();

        let loaded = AiConfig::load_with(dir.path(), &store).unwrap();

        let settings = &loaded.providers[&AiProviderType::OpenAi];
        assert_eq!(settings.api_key.as_deref(), Some("sk-legacy"));
        assert_eq!(settings.model.as_deref(), Some("gpt"));
        assert_eq!(
            store
                .secrets
                .lock()
                .unwrap()
                .get("api-key:open_ai")
                .map(String::as_str),
            Some("sk-legacy")
        );
        let raw = std::fs::read_to_string(dir.path().join(CONFIG_FILE)).unwrap();
        assert!(!raw.contains("sk-legacy"));

        // A second load reads the key back from the store.
        let again = AiConfig::load_with(dir.path(), &store).unwrap();
        assert_eq!(
            again.providers[&AiProviderType::OpenAi].api_key.as_deref(),
            Some("sk-legacy")
        );
    }

    #[test]
    fn test_failed_migration_errors_and_keeps_legacy_file() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(CONFIG_FILE), LEGACY_JSON).unwrap();
        let store = MemorySecretStore::default();
        store.fail.store(true, std::sync::atomic::Ordering::SeqCst);

        let err = AiConfig::load_with(dir.path(), &store).unwrap_err();

        assert!(matches!(err, ConfigLoadError::Secret { .. }));
        assert!(err.to_string().contains("keyring unavailable"));
        let ConfigLoadError::Secret { config, .. } = err else {
            unreachable!();
        };
        assert_eq!(
            config.active_provider,
            Some(AiProviderType::OpenAi),
            "the loaded provider selection remains available"
        );
        assert_eq!(
            config.providers[&AiProviderType::OpenAi].api_key.as_deref(),
            Some("sk-legacy")
        );
        let raw = std::fs::read_to_string(dir.path().join(CONFIG_FILE)).unwrap();
        assert!(raw.contains("sk-legacy"));
    }

    #[test]
    fn test_keyring_read_failure_is_recorded_per_provider() {
        let dir = TempDir::new().unwrap();
        std::fs::write(
            dir.path().join(CONFIG_FILE),
            r#"{"activeProvider":"ollama","providers":{"ollama":{"enabled":true,"model":"llama3.2"},"open_ai":{"enabled":false}}}"#,
        )
        .unwrap();
        let store = MemorySecretStore::default();
        store.fail.store(true, std::sync::atomic::Ordering::SeqCst);

        let config = AiConfig::load_with(dir.path(), &store).unwrap();
        assert_eq!(config.active_provider, Some(AiProviderType::Ollama));
        assert_eq!(
            config.providers[&AiProviderType::Ollama].model.as_deref(),
            Some("llama3.2")
        );
        assert!(config.providers[&AiProviderType::OpenAi].api_key.is_none());
        assert!(config
            .key_errors
            .get(&AiProviderType::OpenAi)
            .unwrap()
            .contains("keyring unavailable"));
        assert!(!config.key_errors.contains_key(&AiProviderType::Ollama));
    }

    #[test]
    fn keyless_provider_drops_legacy_key_without_using_keyring() {
        let dir = TempDir::new().unwrap();
        std::fs::write(
            dir.path().join(CONFIG_FILE),
            r#"{"activeProvider":"ollama","providers":{"ollama":{"enabled":true,"model":"llama3.2","apiKey":"unused"}}}"#,
        )
        .unwrap();
        let store = MemorySecretStore::default();
        store.fail.store(true, std::sync::atomic::Ordering::SeqCst);

        let config = AiConfig::load_with(dir.path(), &store).unwrap();

        assert_eq!(config.active_provider, Some(AiProviderType::Ollama));
        assert_eq!(
            config.providers[&AiProviderType::Ollama].model.as_deref(),
            Some("llama3.2")
        );
        assert!(config.providers[&AiProviderType::Ollama].api_key.is_none());
        let raw = std::fs::read_to_string(dir.path().join(CONFIG_FILE)).unwrap();
        assert!(!raw.contains("unused"));
        assert!(!raw.to_lowercase().contains("apikey"));
    }

    #[test]
    fn test_parse_error_is_not_a_secret_error() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(CONFIG_FILE), "{not json").unwrap();
        let err = AiConfig::load_with(dir.path(), &MemorySecretStore::default()).unwrap_err();
        assert!(matches!(err, ConfigLoadError::Parse(_)));
    }
}
