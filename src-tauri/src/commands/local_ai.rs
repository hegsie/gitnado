//! Tauri commands for local AI model management
//!
//! Provides commands for system capability detection, model registry browsing,
//! model downloading/deletion, and model status queries.

use crate::error::{GitnadoError, Result};
use crate::services::ai::local::{ModelEntry, ModelManager, ModelRegistry, SystemCapabilities};
use crate::services::ai::providers::{LoadedModelMeta, LocalModelStatus};
use crate::services::ai::AiState;
use std::sync::Arc;
use tauri::{command, AppHandle, Emitter, State};
use tokio::sync::RwLock;

/// State for local AI model management
pub struct LocalAiState {
    pub model_manager: Arc<ModelManager>,
    pub registry: ModelRegistry,
}

pub type SharedLocalAiState = Arc<RwLock<LocalAiState>>;

/// Create a new shared local AI state instance with the given models directory
pub fn create_local_ai_state(models_dir: std::path::PathBuf) -> SharedLocalAiState {
    Arc::new(RwLock::new(LocalAiState {
        model_manager: Arc::new(ModelManager::new(models_dir)),
        registry: ModelRegistry::default(),
    }))
}

#[command]
pub async fn get_system_capabilities() -> Result<SystemCapabilities> {
    Ok(crate::services::ai::local::system_detect::detect())
}

#[command]
pub async fn get_available_models(state: State<'_, SharedLocalAiState>) -> Result<Vec<ModelEntry>> {
    let state = state.read().await;
    Ok(state.registry.get_all().to_vec())
}

#[command]
pub async fn get_downloaded_models(
    state: State<'_, SharedLocalAiState>,
) -> Result<Vec<crate::services::ai::local::model_manager::DownloadedModel>> {
    let state = state.read().await;
    state
        .model_manager
        .list_downloaded()
        .map_err(GitnadoError::OperationFailed)
}

#[command]
pub async fn download_model(
    state: State<'_, SharedLocalAiState>,
    ai_state: State<'_, AiState>,
    app_handle: AppHandle,
    model_id: String,
) -> Result<()> {
    let local = state.read().await;
    let entry = local
        .registry
        .get_by_id(&model_id)
        .ok_or_else(|| {
            GitnadoError::OperationFailed(format!("Model '{}' not found in registry", model_id))
        })?
        .clone();
    let manager = local.model_manager.clone();
    let model_path = local.model_manager.get_model_path(&model_id);
    drop(local);

    // Offline mode / the remote allowlist, checked BEFORE the download is
    // spawned so the user gets a refusal from the click rather than a silent
    // multi-gigabyte transfer to huggingface.co. `do_download` guards the same
    // URL again at the socket; this half is the one that can answer the
    // command (see services/security.rs).
    crate::services::ai::local::model_manager::guard_model_download(&entry)?;

    // Clone AI state Arc for use in the background task
    let ai_state_inner = ai_state.inner().clone();

    // Spawn download in background so the command returns immediately
    tokio::spawn(async move {
        match manager.download_model(&entry, app_handle.clone()).await {
            Ok(()) => {
                // Auto-load the model into the inference engine
                let meta = Some(LoadedModelMeta {
                    tier: entry.tier,
                    architecture: entry.architecture.clone(),
                    context_length: entry.context_length,
                });
                let load_result = {
                    let service = ai_state_inner.read().await;
                    service
                        .load_local_model(&model_path, entry.display_name.clone(), meta)
                        .await
                };

                match load_result {
                    Ok(()) => {
                        // Auto-select LocalInference as active provider if none is set
                        {
                            let mut service = ai_state_inner.write().await;
                            if service.get_config().active_provider.is_none() {
                                let _ = service.set_active_provider(
                                    crate::services::ai::AiProviderType::LocalInference,
                                );
                            }
                        }
                        let _ = app_handle.emit(
                            "model-download-complete",
                            serde_json::json!({ "modelId": entry.id, "loaded": true }),
                        );
                    }
                    Err(load_err) => {
                        tracing::warn!("Model downloaded but failed to load: {}", load_err);
                        let _ = app_handle.emit(
                            "model-download-complete",
                            serde_json::json!({
                                "modelId": entry.id,
                                "loaded": false,
                                "loadError": load_err
                            }),
                        );
                    }
                }
            }
            Err(e) => {
                tracing::error!("Model download failed: {}", e);
                let _ = app_handle.emit(
                    "model-download-error",
                    serde_json::json!({
                        "modelId": entry.id,
                        "error": e
                    }),
                );
            }
        }
    });

    Ok(())
}

#[command]
pub async fn cancel_model_download(
    state: State<'_, SharedLocalAiState>,
    model_id: String,
) -> Result<()> {
    let state = state.read().await;
    state
        .model_manager
        .cancel_download(&model_id)
        .await
        .map_err(GitnadoError::OperationFailed)
}

#[command]
pub async fn delete_model(state: State<'_, SharedLocalAiState>, model_id: String) -> Result<()> {
    let state = state.read().await;
    state
        .model_manager
        .delete_model(&model_id)
        .map_err(GitnadoError::OperationFailed)
}

#[command]
pub async fn get_model_status(ai_state: State<'_, AiState>) -> Result<LocalModelStatus> {
    let service = ai_state.read().await;
    Ok(service.get_local_model_status().await)
}

/// Get the display name of the currently loaded model, if any.
#[command]
pub async fn get_loaded_model_name(ai_state: State<'_, AiState>) -> Result<Option<String>> {
    let service = ai_state.read().await;
    Ok(service.get_loaded_model_name().await)
}

/// Resolve `(display_name, LoadedModelMeta)` for a model ID from registry or downloaded metadata.
fn resolve_model_meta_for_load(
    local: &LocalAiState,
    model_id: &str,
) -> Result<(String, LoadedModelMeta)> {
    if let Some(entry) = local.registry.get_by_id(model_id) {
        return Ok((
            entry.display_name.clone(),
            LoadedModelMeta {
                tier: entry.tier,
                architecture: entry.architecture.clone(),
                context_length: entry.context_length,
            },
        ));
    }

    if let Some((display_name, architecture, context_length)) =
        local.model_manager.get_downloaded_meta(model_id)
    {
        return Ok((
            display_name,
            LoadedModelMeta {
                tier: crate::services::ai::local::ModelTier::Standard,
                architecture,
                context_length,
            },
        ));
    }

    Err(GitnadoError::OperationFailed(format!(
        "Model '{}' not found in registry",
        model_id
    )))
}

/// Load a downloaded model into the inference engine, making it ready for use.
#[command]
pub async fn load_model(
    app: tauri::AppHandle,
    local_state: State<'_, SharedLocalAiState>,
    ai_state: State<'_, AiState>,
    model_id: String,
) -> Result<()> {
    let local = local_state.read().await;

    // Verify the model is downloaded
    if !local.model_manager.is_downloaded(&model_id) {
        return Err(GitnadoError::OperationFailed(format!(
            "Model '{}' is not downloaded",
            model_id
        )));
    }

    let (display_name, meta) = resolve_model_meta_for_load(&local, &model_id)?;
    let model_path = local.model_manager.get_model_path(&model_id);
    drop(local);

    // Load the model engine (read lock is sufficient — engine uses interior mutability)
    {
        let service = ai_state.read().await;
        service
            .load_local_model(&model_path, display_name, Some(meta))
            .await
            .map_err(GitnadoError::OperationFailed)?;
    }

    // Auto-select LocalInference as active provider if none is set
    {
        let mut service = ai_state.write().await;
        if service.get_config().active_provider.is_none() {
            let _ =
                service.set_active_provider(crate::services::ai::AiProviderType::LocalInference);
        }
    }

    // Notify frontend so the commit panel can update its AI availability state
    let _ = app.emit(
        "model-download-complete",
        serde_json::json!({ "modelId": model_id, "loaded": true }),
    );

    Ok(())
}

/// Import a custom `.gguf` model file from disk into the local model store.
#[command]
pub async fn import_custom_model(
    state: State<'_, SharedLocalAiState>,
    path: String,
    display_name: Option<String>,
    architecture: Option<String>,
) -> Result<crate::services::ai::local::model_manager::DownloadedModel> {
    let local = state.read().await;
    let manager = local.model_manager.clone();
    drop(local);

    tokio::task::spawn_blocking(move || {
        manager.import_custom_model(
            std::path::Path::new(&path),
            display_name,
            architecture,
            None,
        )
    })
    .await
    .map_err(|e| GitnadoError::OperationFailed(format!("Import task failed: {e}")))?
    .map_err(GitnadoError::OperationFailed)
}

/// Unload the current local model from memory.
#[command]
pub async fn unload_model(ai_state: State<'_, AiState>) -> Result<()> {
    let service = ai_state.read().await;
    service.unload_local_model().await;
    Ok(())
}

#[command]
pub async fn get_recommended_model(
    state: State<'_, SharedLocalAiState>,
) -> Result<Option<ModelEntry>> {
    let state = state.read().await;
    let caps = crate::services::ai::local::system_detect::detect();
    Ok(state.registry.get_recommended(&caps).cloned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_create_local_ai_state() {
        let state = create_local_ai_state(std::path::PathBuf::from("/tmp/test-models"));
        // Verify it creates without panicking
        assert!(Arc::strong_count(&state) == 1);
    }

    #[tokio::test]
    async fn test_resolve_model_meta_fallback_for_custom_imported_model() {
        let tmp = TempDir::new().unwrap();
        let src_dir = TempDir::new().unwrap();
        let gguf_file = src_dir.path().join("custom-coder.gguf");
        std::fs::write(&gguf_file, b"GGUF test").unwrap();

        let state = create_local_ai_state(tmp.path().to_path_buf());
        let local = state.read().await;
        let imported = local
            .model_manager
            .import_custom_model(
                &gguf_file,
                Some("Custom Coder".to_string()),
                Some("qwen2".to_string()),
                Some(16384),
            )
            .unwrap();

        let (display_name, meta) = resolve_model_meta_for_load(&local, &imported.id).unwrap();
        assert_eq!(display_name, "Custom Coder");
        assert_eq!(meta.tier, crate::services::ai::local::ModelTier::Standard);
        assert_eq!(meta.architecture, "qwen2");
        assert_eq!(meta.context_length, 16384);
    }
}
