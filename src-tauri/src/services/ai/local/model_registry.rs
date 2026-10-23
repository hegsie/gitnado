//! Model registry for locally available GGUF models
//!
//! Contains the curated list of models available for download and local inference.

use serde::{Deserialize, Serialize};

use super::system_detect::SystemCapabilities;

/// Model quality/size tier
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelTier {
    /// Small models (~1B params) for systems with >= 8GB RAM
    UltraLight,
    /// Medium models (~3-4B params) for systems with >= 16GB RAM and capable GPU
    Standard,
    /// Large coding/reasoning models (~7-8B params) for systems with >= 32GB RAM and >= 8GB VRAM / Unified Memory
    Pro,
    /// System does not meet minimum requirements
    None,
}

/// A known model entry in the registry
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub display_name: String,
    pub hf_repo: String,
    pub hf_filename: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub min_ram_bytes: u64,
    pub tier: ModelTier,
    pub architecture: String,
    pub context_length: u32,
}

const GB: u64 = 1_073_741_824;

/// Registry of known local AI models
pub struct ModelRegistry {
    models: Vec<ModelEntry>,
}

impl Default for ModelRegistry {
    fn default() -> Self {
        Self {
            models: vec![
                ModelEntry {
                    id: "gemma-3-1b-q4km".to_string(),
                    display_name: "Gemma 3 1B (Q4_K_M)".to_string(),
                    hf_repo: "unsloth/gemma-3-1b-it-GGUF".to_string(),
                    hf_filename: "gemma-3-1b-it-Q4_K_M.gguf".to_string(),
                    sha256: "8270790f3ab69fdfe860b7b64008d9a19986d8df7e407bb018184caa08798ebd"
                        .to_string(),
                    size_bytes: 806_058_272,
                    min_ram_bytes: 8 * GB,
                    tier: ModelTier::UltraLight,
                    architecture: "gemma3".to_string(),
                    context_length: 8192,
                },
                ModelEntry {
                    id: "llama-3.2-1b-q4km".to_string(),
                    display_name: "Llama 3.2 1B (Q4_K_M)".to_string(),
                    hf_repo: "unsloth/Llama-3.2-1B-Instruct-GGUF".to_string(),
                    hf_filename: "Llama-3.2-1B-Instruct-Q4_K_M.gguf".to_string(),
                    sha256: "3f5a22426976ab26cfe84dba63c1d08391717abb1af893e10f1b2968d862dcc1"
                        .to_string(),
                    size_bytes: 750 * 1_048_576,
                    min_ram_bytes: 8 * GB,
                    tier: ModelTier::UltraLight,
                    architecture: "llama".to_string(),
                    context_length: 8192,
                },
                ModelEntry {
                    id: "phi-4-mini-q4km".to_string(),
                    display_name: "Phi-4 Mini 3.8B (Q4_K_M)".to_string(),
                    hf_repo: "unsloth/Phi-4-mini-instruct-GGUF".to_string(),
                    hf_filename: "Phi-4-mini-instruct-Q4_K_M.gguf".to_string(),
                    sha256: "88c00229914083cd112853aab84ed51b87bdf6b9ce42f532d8c85c7c63b1730a"
                        .to_string(),
                    size_bytes: 2_300 * 1_048_576,
                    min_ram_bytes: 16 * GB,
                    tier: ModelTier::Standard,
                    architecture: "phi".to_string(),
                    context_length: 4096,
                },
                ModelEntry {
                    id: "gemma-3-4b-q4km".to_string(),
                    display_name: "Gemma 3 4B (Q4_K_M)".to_string(),
                    hf_repo: "unsloth/gemma-3-4b-it-GGUF".to_string(),
                    hf_filename: "gemma-3-4b-it-Q4_K_M.gguf".to_string(),
                    sha256: "04a43a22e8d2003deda5acc262f68ec1005fa76c735a9962a8c77042a74a7d19"
                        .to_string(),
                    size_bytes: 2_500 * 1_048_576,
                    min_ram_bytes: 16 * GB,
                    tier: ModelTier::Standard,
                    architecture: "gemma3".to_string(),
                    context_length: 8192,
                },
                ModelEntry {
                    id: "qwen-2.5-coder-7b-q4km".to_string(),
                    display_name: "Qwen 2.5 Coder 7B (Q4_K_M)".to_string(),
                    hf_repo: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF".to_string(),
                    hf_filename: "qwen2.5-coder-7b-instruct-q4_k_m.gguf".to_string(),
                    sha256: String::new(),
                    size_bytes: 4_680 * 1_048_576,
                    min_ram_bytes: 32 * GB,
                    tier: ModelTier::Pro,
                    architecture: "qwen2".to_string(),
                    context_length: 8192,
                },
            ],
        }
    }
}

impl ModelRegistry {
    /// Get all known models
    pub fn get_all(&self) -> &[ModelEntry] {
        &self.models
    }

    /// Get a model by its ID
    pub fn get_by_id(&self, id: &str) -> Option<&ModelEntry> {
        self.models.iter().find(|m| m.id == id)
    }

    /// Get all models matching a tier
    pub fn get_for_tier(&self, tier: ModelTier) -> Vec<&ModelEntry> {
        self.models.iter().filter(|m| m.tier == tier).collect()
    }

    /// Get the recommended model for the given system capabilities.
    ///
    /// Returns the first model matching the recommended tier, preferring
    /// Gemma or Qwen2 models as the default choice. Returns `None` if the system
    /// doesn't meet minimum requirements.
    ///
    /// If GPU acceleration is not available, caps at UltraLight (1B models)
    /// since larger models are impractically slow on CPU.
    pub fn get_recommended(&self, capabilities: &SystemCapabilities) -> Option<&ModelEntry> {
        let tier = if !capabilities.gpu_acceleration_available
            && matches!(
                capabilities.recommended_tier,
                ModelTier::Standard | ModelTier::Pro
            ) {
            ModelTier::UltraLight
        } else {
            capabilities.recommended_tier
        };

        if tier == ModelTier::None {
            return None;
        }

        let tier_models = self.get_for_tier(tier);

        // Prefer Gemma or Qwen2 as default recommendation
        tier_models
            .iter()
            .find(|m| m.architecture == "gemma3" || m.architecture == "qwen2")
            .or(tier_models.first())
            .copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::ai::local::ComputeBackend;

    fn registry() -> ModelRegistry {
        ModelRegistry::default()
    }

    #[test]
    fn test_get_all_returns_known_models() {
        let reg = registry();
        let all = reg.get_all();
        assert_eq!(all.len(), 5);
    }

    #[test]
    fn test_get_by_id_found() {
        let reg = registry();
        let entry = reg.get_by_id("gemma-3-1b-q4km");
        assert!(entry.is_some());
        assert_eq!(entry.unwrap().display_name, "Gemma 3 1B (Q4_K_M)");
    }

    #[test]
    fn test_get_by_id_not_found() {
        let reg = registry();
        assert!(reg.get_by_id("nonexistent-model").is_none());
    }

    #[test]
    fn test_get_for_tier_ultralight() {
        let reg = registry();
        let models = reg.get_for_tier(ModelTier::UltraLight);
        assert_eq!(models.len(), 2);
        for m in &models {
            assert_eq!(m.tier, ModelTier::UltraLight);
        }
    }

    #[test]
    fn test_get_for_tier_standard() {
        let reg = registry();
        let models = reg.get_for_tier(ModelTier::Standard);
        assert_eq!(models.len(), 2);
        for m in &models {
            assert_eq!(m.tier, ModelTier::Standard);
        }
    }

    #[test]
    fn test_get_for_tier_pro() {
        let reg = registry();
        let models = reg.get_for_tier(ModelTier::Pro);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "qwen-2.5-coder-7b-q4km");
        assert_eq!(models[0].tier, ModelTier::Pro);
    }

    #[test]
    fn test_get_for_tier_none_empty() {
        let reg = registry();
        let models = reg.get_for_tier(ModelTier::None);
        assert!(models.is_empty());
    }

    #[test]
    fn test_get_recommended_pro() {
        let reg = registry();
        let caps = SystemCapabilities {
            total_ram_bytes: 32 * GB,
            available_ram_bytes: 16 * GB,
            gpu_info: None,
            recommended_tier: ModelTier::Pro,
            gpu_acceleration_available: true,
            active_backend: ComputeBackend::Metal,
            supported_backends: vec![ComputeBackend::Metal, ComputeBackend::Cpu],
            npu_info: None,
            unified_memory: true,
        };
        let recommended = reg.get_recommended(&caps);
        assert!(recommended.is_some());
        let model = recommended.unwrap();
        assert_eq!(model.tier, ModelTier::Pro);
        assert_eq!(model.id, "qwen-2.5-coder-7b-q4km");
    }

    #[test]
    fn test_get_recommended_standard() {
        let reg = registry();
        let caps = SystemCapabilities {
            total_ram_bytes: 32 * GB,
            available_ram_bytes: 16 * GB,
            gpu_info: None,
            recommended_tier: ModelTier::Standard,
            gpu_acceleration_available: true,
            active_backend: ComputeBackend::Metal,
            supported_backends: vec![ComputeBackend::Metal, ComputeBackend::Cpu],
            npu_info: None,
            unified_memory: true,
        };
        let recommended = reg.get_recommended(&caps);
        assert!(recommended.is_some());
        let model = recommended.unwrap();
        assert_eq!(model.tier, ModelTier::Standard);
        // Should prefer Gemma
        assert_eq!(model.id, "gemma-3-4b-q4km");
    }

    #[test]
    fn test_get_recommended_ultralight() {
        let reg = registry();
        let caps = SystemCapabilities {
            total_ram_bytes: 8 * GB,
            available_ram_bytes: 4 * GB,
            gpu_info: None,
            recommended_tier: ModelTier::UltraLight,
            gpu_acceleration_available: false,
            active_backend: ComputeBackend::Cpu,
            supported_backends: vec![ComputeBackend::Cpu],
            npu_info: None,
            unified_memory: false,
        };
        let recommended = reg.get_recommended(&caps);
        assert!(recommended.is_some());
        let model = recommended.unwrap();
        assert_eq!(model.tier, ModelTier::UltraLight);
        assert_eq!(model.id, "gemma-3-1b-q4km");
    }

    #[test]
    fn test_get_recommended_none() {
        let reg = registry();
        let caps = SystemCapabilities {
            total_ram_bytes: 4 * GB,
            available_ram_bytes: 2 * GB,
            gpu_info: None,
            recommended_tier: ModelTier::None,
            gpu_acceleration_available: false,
            active_backend: ComputeBackend::Cpu,
            supported_backends: vec![ComputeBackend::Cpu],
            npu_info: None,
            unified_memory: false,
        };
        assert!(reg.get_recommended(&caps).is_none());
    }

    #[test]
    fn test_get_recommended_cpu_only_caps_at_ultralight() {
        let reg = registry();
        // Even though tier says Standard, CPU-only should cap at UltraLight
        let caps = SystemCapabilities {
            total_ram_bytes: 48 * GB,
            available_ram_bytes: 32 * GB,
            gpu_info: None,
            recommended_tier: ModelTier::Standard,
            gpu_acceleration_available: false,
            active_backend: ComputeBackend::Cpu,
            supported_backends: vec![ComputeBackend::Cpu],
            npu_info: None,
            unified_memory: false,
        };
        let recommended = reg.get_recommended(&caps);
        assert!(recommended.is_some());
        let model = recommended.unwrap();
        assert_eq!(model.tier, ModelTier::UltraLight);

        // Pro tier on CPU-only should also cap at UltraLight
        let pro_cpu_caps = SystemCapabilities {
            recommended_tier: ModelTier::Pro,
            ..caps
        };
        let pro_recommended = reg.get_recommended(&pro_cpu_caps).unwrap();
        assert_eq!(pro_recommended.tier, ModelTier::UltraLight);
    }

    #[test]
    fn test_model_entry_serialization() {
        let reg = registry();
        let entry = reg.get_by_id("gemma-3-1b-q4km").unwrap();
        let json = serde_json::to_string(entry).unwrap();
        assert!(json.contains("\"displayName\""));
        assert!(json.contains("\"hfRepo\""));
        assert!(json.contains("\"sizeBytes\""));
        assert!(json.contains("\"contextLength\""));
    }

    #[test]
    fn test_model_tier_serialization() {
        let json = serde_json::to_string(&ModelTier::UltraLight).unwrap();
        assert_eq!(json, "\"ultra_light\"");

        let json = serde_json::to_string(&ModelTier::Standard).unwrap();
        assert_eq!(json, "\"standard\"");

        let json = serde_json::to_string(&ModelTier::Pro).unwrap();
        assert_eq!(json, "\"pro\"");

        let json = serde_json::to_string(&ModelTier::None).unwrap();
        assert_eq!(json, "\"none\"");
    }
}
