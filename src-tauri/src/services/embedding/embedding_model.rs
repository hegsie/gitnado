//! Embedding model download and management
//!
//! Handles downloading, storing, and verifying the ONNX embedding model
//! (all-MiniLM-L6-v2) from HuggingFace.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

/// Known embedding model entry
pub struct EmbeddingModelEntry {
    pub id: &'static str,
    pub display_name: &'static str,
    pub hf_repo: &'static str,
    pub weights_filename: &'static str,
    pub tokenizer_filename: &'static str,
    pub config_filename: &'static str,
    pub size_bytes: u64,
    pub embedding_dim: usize,
}

/// Download progress for the embedding model
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingModelDownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub progress_percent: f64,
    pub file_name: String,
}

/// Returns the default embedding model entry (all-MiniLM-L6-v2)
pub fn default_embedding_model() -> EmbeddingModelEntry {
    EmbeddingModelEntry {
        id: "all-minilm-l6-v2",
        display_name: "all-MiniLM-L6-v2",
        hf_repo: "sentence-transformers/all-MiniLM-L6-v2",
        weights_filename: "model.safetensors",
        tokenizer_filename: "tokenizer.json",
        config_filename: "config.json",
        size_bytes: 90_000_000, // ~90MB for safetensors
        embedding_dim: 384,
    }
}

/// Get the directory where the embedding model is stored
pub fn get_model_dir(models_dir: &Path) -> PathBuf {
    models_dir.join("embedding-minilm-l6-v2")
}

/// Check if the embedding model files are downloaded
pub fn is_model_downloaded(models_dir: &Path) -> bool {
    let model_dir = get_model_dir(models_dir);
    model_dir.join("model.safetensors").exists()
        && model_dir.join("tokenizer.json").exists()
        && model_dir.join("config.json").exists()
}

/// Download the embedding model files from HuggingFace.
///
/// Downloads `model.onnx` and `tokenizer.json` from the
/// `sentence-transformers/all-MiniLM-L6-v2` repository.
/// Emits `embedding-model-download-progress` Tauri events.
pub async fn download_embedding_model(
    models_dir: &Path,
    app_handle: &AppHandle,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<(), String> {
    let model = default_embedding_model();
    let model_dir = get_model_dir(models_dir);

    std::fs::create_dir_all(&model_dir)
        .map_err(|e| format!("Failed to create model directory: {}", e))?;

    // Download model.safetensors
    download_hf_file(
        model.hf_repo,
        model.weights_filename,
        &model_dir.join("model.safetensors"),
        "model.safetensors",
        app_handle,
        cancel_flag,
    )
    .await?;

    if cancel_flag.load(Ordering::Relaxed) {
        let _ = std::fs::remove_dir_all(&model_dir);
        return Err("Download cancelled".to_string());
    }

    // Download tokenizer.json
    download_hf_file(
        model.hf_repo,
        model.tokenizer_filename,
        &model_dir.join("tokenizer.json"),
        "tokenizer.json",
        app_handle,
        cancel_flag,
    )
    .await?;

    if cancel_flag.load(Ordering::Relaxed) {
        let _ = std::fs::remove_dir_all(&model_dir);
        return Err("Download cancelled".to_string());
    }

    // Download config.json
    download_hf_file(
        model.hf_repo,
        model.config_filename,
        &model_dir.join("config.json"),
        "config.json",
        app_handle,
        cancel_flag,
    )
    .await?;

    if cancel_flag.load(Ordering::Relaxed) {
        let _ = std::fs::remove_dir_all(&model_dir);
        return Err("Download cancelled".to_string());
    }

    Ok(())
}

/// Download a single file from a HuggingFace repository
async fn download_hf_file(
    repo: &str,
    filename: &str,
    dest: &Path,
    display_name: &str,
    app_handle: &AppHandle,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<(), String> {
    let url = format!("https://huggingface.co/{}/resolve/main/{}", repo, filename);

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("User-Agent", "Gitnado-Git-Client")
        .send()
        .await
        .map_err(|e| format!("Failed to download {}: {}", display_name, e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download {}: HTTP {}",
            display_name,
            response.status()
        ));
    }

    let total_bytes = response.content_length().unwrap_or(0);
    let mut downloaded_bytes: u64 = 0;

    let mut file = std::fs::File::create(dest)
        .map_err(|e| format!("Failed to create file {}: {}", display_name, e))?;

    use futures_util::StreamExt;
    use std::io::Write;

    let mut stream = response.bytes_stream();
    let mut hasher = Sha256::new();

    while let Some(chunk) = stream.next().await {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err("Download cancelled".to_string());
        }

        let chunk = chunk.map_err(|e| format!("Download error: {}", e))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Failed to write {}: {}", display_name, e))?;
        hasher.update(&chunk);

        downloaded_bytes += chunk.len() as u64;

        let progress = if total_bytes > 0 {
            (downloaded_bytes as f64 / total_bytes as f64) * 100.0
        } else {
            0.0
        };

        let _ = app_handle.emit(
            "embedding-model-download-progress",
            EmbeddingModelDownloadProgress {
                downloaded_bytes,
                total_bytes,
                progress_percent: progress,
                file_name: display_name.to_string(),
            },
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_model_entry() {
        let model = default_embedding_model();
        assert_eq!(model.id, "all-minilm-l6-v2");
        assert_eq!(model.embedding_dim, 384);
    }

    #[test]
    fn test_model_dir_path() {
        let models_dir = Path::new("/tmp/models");
        let dir = get_model_dir(models_dir);
        assert!(dir.to_string_lossy().contains("embedding-minilm-l6-v2"));
    }

    #[test]
    fn test_is_model_downloaded_false() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!is_model_downloaded(tmp.path()));
    }

    #[test]
    fn test_is_model_downloaded_true() {
        let tmp = tempfile::tempdir().unwrap();
        let model_dir = get_model_dir(tmp.path());
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join("model.safetensors"), b"fake").unwrap();
        std::fs::write(model_dir.join("tokenizer.json"), b"fake").unwrap();
        std::fs::write(model_dir.join("config.json"), b"fake").unwrap();
        assert!(is_model_downloaded(tmp.path()));
    }
}
