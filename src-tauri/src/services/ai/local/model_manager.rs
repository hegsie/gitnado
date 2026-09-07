//! Model download and lifecycle management
//!
//! Handles downloading, storing, verifying, and deleting local GGUF model files.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

use super::model_registry::ModelEntry;

/// Status of a model in the local store
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelStatus {
    NotDownloaded,
    Downloading,
    Downloaded,
    Loading,
    Ready,
    Error,
}

/// A model that has been downloaded to disk
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedModel {
    pub id: String,
    pub display_name: String,
    pub size_bytes: u64,
    pub path: PathBuf,
    pub status: ModelStatus,
}

/// Progress of an in-flight model download
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub model_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub progress_percent: f64,
}

/// Metadata written alongside a downloaded model file
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelMeta {
    id: String,
    display_name: String,
    size_bytes: u64,
    sha256: String,
    architecture: String,
    context_length: u32,
}

/// Manages downloading, storing, and verifying local GGUF models.
pub struct ModelManager {
    models_dir: PathBuf,
    /// Map of model_id → cancellation flag for in-progress downloads
    downloading: Arc<RwLock<HashMap<String, Arc<AtomicBool>>>>,
}

impl ModelManager {
    /// Create a new ModelManager that stores models under `models_dir`.
    pub fn new(models_dir: PathBuf) -> Self {
        Self {
            models_dir,
            downloading: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// List all models that have been downloaded (have a `model_meta.json`).
    pub fn list_downloaded(&self) -> Result<Vec<DownloadedModel>, String> {
        if !self.models_dir.exists() {
            return Ok(Vec::new());
        }

        let mut models = Vec::new();
        let entries = std::fs::read_dir(&self.models_dir)
            .map_err(|e| format!("Failed to read models directory: {e}"))?;

        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            let meta_path = entry.path().join("model_meta.json");
            if !meta_path.exists() {
                continue;
            }

            let meta_content = std::fs::read_to_string(&meta_path)
                .map_err(|e| format!("Failed to read model metadata: {e}"))?;

            let meta: ModelMeta = serde_json::from_str(&meta_content)
                .map_err(|e| format!("Failed to parse model metadata: {e}"))?;

            let model_path = entry.path().join("model.gguf");
            let status = if model_path.exists() {
                ModelStatus::Downloaded
            } else {
                ModelStatus::Error
            };

            models.push(DownloadedModel {
                id: meta.id,
                display_name: meta.display_name,
                size_bytes: meta.size_bytes,
                path: model_path,
                status,
            });
        }

        Ok(models)
    }

    /// Check if a model has been downloaded.
    pub fn is_downloaded(&self, model_id: &str) -> bool {
        let model_dir = self.models_dir.join(model_id);
        model_dir.join("model_meta.json").exists() && model_dir.join("model.gguf").exists()
    }

    /// Get the path where a model's GGUF file would be stored.
    pub fn get_model_path(&self, model_id: &str) -> PathBuf {
        self.models_dir.join(model_id).join("model.gguf")
    }

    /// Download a model from HuggingFace.
    ///
    /// Emits `model-download-progress` events on the app handle during download.
    /// The download can be cancelled via [`cancel_download`].
    pub async fn download_model(
        &self,
        entry: &ModelEntry,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        // Prevent concurrent downloads — single write lock for check-and-insert (avoids TOCTOU)
        let cancel_flag = Arc::new(AtomicBool::new(false));
        {
            let mut downloading = self.downloading.write().await;
            if downloading.contains_key(&entry.id) {
                return Err(format!("Model '{}' is already being downloaded", entry.id));
            }
            downloading.insert(entry.id.clone(), cancel_flag.clone());
        }

        let model_dir = self.models_dir.join(&entry.id);
        std::fs::create_dir_all(&model_dir)
            .map_err(|e| format!("Failed to create model directory: {e}"))?;

        let result = self
            .do_download(entry, &model_dir, &app_handle, &cancel_flag)
            .await;

        // Clean up cancellation token
        {
            let mut downloading = self.downloading.write().await;
            downloading.remove(&entry.id);
        }

        if let Err(ref _e) = result {
            // Clean up partial download on any error (cancelled or otherwise)
            let _ = std::fs::remove_dir_all(&model_dir);
        }

        result
    }

    async fn do_download(
        &self,
        entry: &ModelEntry,
        model_dir: &std::path::Path,
        app_handle: &AppHandle,
        cancel_flag: &Arc<AtomicBool>,
    ) -> Result<(), String> {
        let url = format!(
            "https://huggingface.co/{}/resolve/main/{}",
            entry.hf_repo, entry.hf_filename
        );

        let client = reqwest::Client::new();
        let response = client
            .get(&url)
            .header("User-Agent", "Gitnado-Git-GUI")
            .send()
            .await
            .map_err(|e| format!("Failed to start download: {e}"))?;

        if !response.status().is_success() {
            return Err(format!(
                "Download failed with status: {}",
                response.status()
            ));
        }

        let total_bytes = response.content_length().unwrap_or(entry.size_bytes);

        let model_path = model_dir.join("model.gguf");
        let mut file = std::fs::File::create(&model_path)
            .map_err(|e| format!("Failed to create model file: {e}"))?;

        let mut downloaded_bytes: u64 = 0;
        let mut stream = response.bytes_stream();

        use futures_util::StreamExt;
        use std::io::Write;

        while let Some(chunk_result) = stream.next().await {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err("Download cancelled".to_string());
            }

            let chunk = chunk_result.map_err(|e| format!("Error reading download stream: {e}"))?;

            file.write_all(&chunk)
                .map_err(|e| format!("Failed to write model data: {e}"))?;

            downloaded_bytes += chunk.len() as u64;

            let progress = DownloadProgress {
                model_id: entry.id.clone(),
                downloaded_bytes,
                total_bytes,
                progress_percent: if total_bytes > 0 {
                    (downloaded_bytes as f64 / total_bytes as f64) * 100.0
                } else {
                    0.0
                },
            };

            let _ = app_handle.emit("model-download-progress", &progress);
        }

        file.flush()
            .map_err(|e| format!("Failed to flush model file: {e}"))?;

        // Verify SHA-256 hash if a real hash is provided (not a placeholder)
        if !entry.sha256.is_empty() && !entry.sha256.starts_with("placeholder") {
            let model_path_for_hash = model_dir.join("model.gguf");
            let mut hash_file = std::fs::File::open(&model_path_for_hash)
                .map_err(|e| format!("Failed to open model file for verification: {e}"))?;
            let mut hasher = Sha256::new();
            let mut buf = [0u8; 8192];
            loop {
                let n = std::io::Read::read(&mut hash_file, &mut buf)
                    .map_err(|e| format!("Failed to hash model file: {e}"))?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            let hash = hasher.finalize();
            let hex_hash: String = hash.iter().map(|b| format!("{:02x}", b)).collect();
            if hex_hash != entry.sha256 {
                return Err(format!(
                    "SHA-256 verification failed: expected {}, got {}",
                    entry.sha256, hex_hash
                ));
            }
        }

        // Write metadata
        let meta = ModelMeta {
            id: entry.id.clone(),
            display_name: entry.display_name.clone(),
            size_bytes: entry.size_bytes,
            sha256: entry.sha256.clone(),
            architecture: entry.architecture.clone(),
            context_length: entry.context_length,
        };

        let meta_json = serde_json::to_string_pretty(&meta)
            .map_err(|e| format!("Failed to serialize model metadata: {e}"))?;

        std::fs::write(model_dir.join("model_meta.json"), meta_json)
            .map_err(|e| format!("Failed to write model metadata: {e}"))?;

        Ok(())
    }

    /// Cancel an in-progress download.
    pub async fn cancel_download(&self, model_id: &str) -> Result<(), String> {
        let downloading = self.downloading.read().await;
        if let Some(flag) = downloading.get(model_id) {
            flag.store(true, Ordering::Relaxed);
            Ok(())
        } else {
            Err(format!("No active download for model '{model_id}'"))
        }
    }

    /// Delete a downloaded model from disk.
    pub fn delete_model(&self, model_id: &str) -> Result<(), String> {
        let model_dir = self.models_dir.join(model_id);
        if model_dir.exists() {
            std::fs::remove_dir_all(&model_dir)
                .map_err(|e| format!("Failed to delete model '{model_id}': {e}"))?;
        }
        Ok(())
    }

    /// Verify a downloaded model file against its expected SHA-256 hash.
    pub fn verify_model(&self, model_id: &str, expected_sha256: &str) -> Result<bool, String> {
        let model_path = self.get_model_path(model_id);
        if !model_path.exists() {
            return Err(format!("Model file not found for '{model_id}'"));
        }

        let mut file = std::fs::File::open(&model_path)
            .map_err(|e| format!("Failed to open model file: {e}"))?;

        let mut hasher = Sha256::new();
        let mut buf = [0u8; 8192];
        loop {
            let n = std::io::Read::read(&mut file, &mut buf)
                .map_err(|e| format!("Failed to read model file for hashing: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        let hash = hasher.finalize();
        let hex_hash: String = hash.iter().map(|b| format!("{:02x}", b)).collect();

        Ok(hex_hash == expected_sha256)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_manager() -> (ModelManager, TempDir) {
        let tmp = TempDir::new().unwrap();
        let manager = ModelManager::new(tmp.path().to_path_buf());
        (manager, tmp)
    }

    #[test]
    fn test_list_downloaded_empty_dir() {
        let (manager, _tmp) = create_test_manager();
        let models = manager.list_downloaded().unwrap();
        assert!(models.is_empty());
    }

    #[test]
    fn test_list_downloaded_nonexistent_dir() {
        let manager = ModelManager::new(PathBuf::from("/tmp/nonexistent_gitnado_test_dir"));
        let models = manager.list_downloaded().unwrap();
        assert!(models.is_empty());
    }

    #[test]
    fn test_is_downloaded_false() {
        let (manager, _tmp) = create_test_manager();
        assert!(!manager.is_downloaded("some-model"));
    }

    #[test]
    fn test_is_downloaded_true() {
        let (manager, tmp) = create_test_manager();
        let model_dir = tmp.path().join("test-model");
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join("model.gguf"), b"fake gguf data").unwrap();
        std::fs::write(
            model_dir.join("model_meta.json"),
            r#"{"id":"test-model","displayName":"Test","sizeBytes":100,"sha256":"abc","architecture":"test","contextLength":1024}"#,
        )
        .unwrap();
        assert!(manager.is_downloaded("test-model"));
    }

    #[test]
    fn test_get_model_path() {
        let (manager, tmp) = create_test_manager();
        let path = manager.get_model_path("my-model");
        assert_eq!(path, tmp.path().join("my-model").join("model.gguf"));
    }

    #[test]
    fn test_delete_model() {
        let (manager, tmp) = create_test_manager();
        let model_dir = tmp.path().join("to-delete");
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join("model.gguf"), b"data").unwrap();

        assert!(model_dir.exists());
        manager.delete_model("to-delete").unwrap();
        assert!(!model_dir.exists());
    }

    #[test]
    fn test_delete_model_nonexistent_is_ok() {
        let (manager, _tmp) = create_test_manager();
        // Deleting a non-existent model should succeed silently
        assert!(manager.delete_model("does-not-exist").is_ok());
    }

    #[test]
    fn test_verify_model_correct_hash() {
        let (manager, tmp) = create_test_manager();
        let model_dir = tmp.path().join("hash-test");
        std::fs::create_dir_all(&model_dir).unwrap();

        let content = b"hello world";
        std::fs::write(model_dir.join("model.gguf"), content).unwrap();

        // SHA-256 of "hello world"
        let expected = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
        assert!(manager.verify_model("hash-test", expected).unwrap());
    }

    #[test]
    fn test_verify_model_wrong_hash() {
        let (manager, tmp) = create_test_manager();
        let model_dir = tmp.path().join("hash-test-bad");
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join("model.gguf"), b"hello world").unwrap();

        assert!(!manager.verify_model("hash-test-bad", "wrong_hash").unwrap());
    }

    #[test]
    fn test_verify_model_missing_file() {
        let (manager, _tmp) = create_test_manager();
        let result = manager.verify_model("nonexistent", "abc");
        assert!(result.is_err());
    }

    #[test]
    fn test_list_downloaded_with_model() {
        let (manager, tmp) = create_test_manager();
        let model_dir = tmp.path().join("listed-model");
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join("model.gguf"), b"fake data").unwrap();

        let meta = r#"{
            "id": "listed-model",
            "displayName": "Listed Model",
            "sizeBytes": 1000,
            "sha256": "abc",
            "architecture": "test",
            "contextLength": 2048
        }"#;
        std::fs::write(model_dir.join("model_meta.json"), meta).unwrap();

        let models = manager.list_downloaded().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "listed-model");
        assert_eq!(models[0].display_name, "Listed Model");
        assert_eq!(models[0].status, ModelStatus::Downloaded);
    }

    #[test]
    fn test_list_downloaded_missing_gguf_shows_error() {
        let (manager, tmp) = create_test_manager();
        let model_dir = tmp.path().join("broken-model");
        std::fs::create_dir_all(&model_dir).unwrap();
        // Only metadata, no model.gguf
        let meta = r#"{
            "id": "broken-model",
            "displayName": "Broken",
            "sizeBytes": 500,
            "sha256": "xyz",
            "architecture": "test",
            "contextLength": 1024
        }"#;
        std::fs::write(model_dir.join("model_meta.json"), meta).unwrap();

        let models = manager.list_downloaded().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].status, ModelStatus::Error);
    }
}
