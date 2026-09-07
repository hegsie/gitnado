//! Integration tests for the local AI pipeline.
//!
//! These tests download a real GGUF model from HuggingFace, load it with
//! the llama.cpp inference engine, and verify end-to-end generation works.
//!
//! **These tests are `#[ignore]`'d by default** because they:
//! - Download ~750MB from HuggingFace on first run (Llama 3.2 1B Q4_K_M)
//! - Require ~1GB RAM for model loading
//! - Take 30-120 seconds depending on network/CPU
//!
//! Run them explicitly:
//! ```sh
//! cd src-tauri && cargo test --test local_ai_integration -- --ignored --nocapture
//! ```
//!
//! The model is cached under `target/test-models/` to avoid re-downloading.

use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

/// Use the Llama 3.2 1B model from the app's registry — it's the same model
/// users actually download, and it's known to work with llama.cpp.
/// ~750MB download, ~1GB RAM during inference.
const TEST_MODEL_REPO: &str = "unsloth/Llama-3.2-1B-Instruct-GGUF";
const TEST_MODEL_FILE: &str = "Llama-3.2-1B-Instruct-Q4_K_M.gguf";

/// Cache directory for downloaded models (persists across test runs).
fn cache_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("test-models")
        .join("llama-3.2-1b")
}

/// Stream-download a file from HuggingFace to `dest`, with progress logging.
/// Skips download if `dest` already exists and is non-empty.
async fn download_hf_to_file(repo: &str, filename: &str, dest: &Path) {
    if dest.exists() && dest.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        eprintln!(
            "Using cached {} ({} bytes)",
            dest.display(),
            dest.metadata().unwrap().len()
        );
        return;
    }

    let url = format!("https://huggingface.co/{repo}/resolve/main/{filename}");
    eprintln!("Downloading {url} → {} ...", dest.display());

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("User-Agent", "Gitnado-Integration-Test")
        .send()
        .await
        .unwrap_or_else(|e| panic!("Failed to download {url}: {e}"));

    assert!(
        response.status().is_success(),
        "HTTP {} downloading {url}",
        response.status()
    );

    let total = response.content_length().unwrap_or(0);
    let mut stream = response.bytes_stream();
    let mut file = std::fs::File::create(dest)
        .unwrap_or_else(|e| panic!("Failed to create {}: {e}", dest.display()));

    let mut downloaded: u64 = 0;
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.expect("Error reading download stream");
        file.write_all(&chunk).expect("Failed to write to file");
        downloaded += chunk.len() as u64;

        // Log progress every ~50MB
        if total > 0 && downloaded % (50 * 1024 * 1024) < chunk.len() as u64 {
            eprintln!(
                "  {:.0}% ({:.1} / {:.1} MB)",
                (downloaded as f64 / total as f64) * 100.0,
                downloaded as f64 / 1_048_576.0,
                total as f64 / 1_048_576.0,
            );
        }
    }
    file.flush().expect("Failed to flush file");
    eprintln!("Downloaded {} bytes to {}", downloaded, dest.display());
}

/// Set up the model file, using a persistent cache.
/// Returns the model_path.
async fn setup_test_model() -> PathBuf {
    let dir = cache_dir();
    std::fs::create_dir_all(&dir).expect("Failed to create cache dir");

    let model_path = dir.join("model.gguf");

    // Download model (skips if cached)
    download_hf_to_file(TEST_MODEL_REPO, TEST_MODEL_FILE, &model_path).await;

    model_path
}

/// Test: Download → Load GGUF → Generate text
///
/// Verifies the core inference pipeline works end-to-end with llama.cpp.
#[tokio::test]
#[ignore]
async fn test_download_load_and_generate_text() {
    let model_path = setup_test_model().await;

    // Load the model (this is what GgufEngine::load does)
    eprintln!("Loading model...");
    let mp = model_path.clone();
    let engine = tokio::task::spawn_blocking(move || {
        gitnado_lib::services::ai::local::GgufEngine::load(&mp, "Llama-3.2-1B".to_string(), None)
    })
    .await
    .expect("spawn_blocking panicked")
    .expect("GgufEngine::load failed");

    eprintln!("Model loaded successfully: {}", engine.model_name());
    assert_eq!(engine.model_name(), "Llama-3.2-1B");
    assert!(engine.is_ready());

    // Generate some text
    eprintln!("Generating text...");
    use gitnado_lib::services::ai::providers::InferenceEngine;
    let output = engine
        .generate("Write a haiku about git:", 50)
        .await
        .expect("Text generation failed");

    eprintln!("Generated: {output}");
    assert!(!output.is_empty(), "Generated text should not be empty");
}

/// Test: Full commit message generation pipeline
///
/// Exercises the same code path as the UI:
/// AiService → LocalInferenceProvider → GgufEngine → llama.cpp inference
#[tokio::test]
#[ignore]
async fn test_full_commit_message_generation() {
    let model_path = setup_test_model().await;

    // Create AiService the same way the app does
    let config_dir = TempDir::new().expect("Failed to create config dir");
    let ai_state = gitnado_lib::services::ai::create_ai_state(config_dir.path().to_path_buf());

    // Load the model through AiService (same path as the load_model Tauri command)
    {
        let service = ai_state.read().await;
        service
            .load_local_model(&model_path, "Llama-3.2-1B".to_string(), None)
            .await
            .expect("load_local_model failed");
    }

    // Set LocalInference as active provider (same as auto-select after download)
    {
        let mut service = ai_state.write().await;
        service
            .set_active_provider(gitnado_lib::services::ai::AiProviderType::LocalInference)
            .expect("set_active_provider failed");
    }

    // Verify provider is available
    {
        let service = ai_state.read().await;
        let available = service.find_available_provider().await;
        assert!(
            available.is_some(),
            "LocalInference should be available after loading model"
        );
        let (_, provider_type) = available.unwrap();
        assert_eq!(
            provider_type,
            gitnado_lib::services::ai::AiProviderType::LocalInference
        );
    }

    // Generate a commit message with a real diff
    let diff = r#"diff --git a/src/auth.rs b/src/auth.rs
index 1234567..abcdefg 100644
--- a/src/auth.rs
+++ b/src/auth.rs
@@ -42,7 +42,12 @@ pub fn validate_token(token: &str) -> bool {
-    token.len() > 0
+    if token.is_empty() {
+        return false;
+    }
+    // Verify token has not expired
+    let claims = decode_jwt(token)?;
+    claims.exp > Utc::now().timestamp()
 }"#;

    eprintln!("Generating commit message from diff...");
    let result = {
        let service = ai_state.read().await;
        service.generate_commit_message(diff.to_string()).await
    };

    let message = result.expect("generate_commit_message failed");
    eprintln!("Summary: {}", message.summary);
    if let Some(ref body) = message.body {
        eprintln!("Body: {body}");
    }

    assert!(
        !message.summary.is_empty(),
        "Commit summary should not be empty"
    );
    // Summary should be reasonably short (conventional commit format)
    assert!(
        message.summary.len() < 200,
        "Summary should be concise, got {} chars: {}",
        message.summary.len(),
        message.summary
    );
}

/// Test: Model load → unload → verify unavailable
///
/// Verifies the lifecycle that the UI Load/Unload buttons exercise.
#[tokio::test]
#[ignore]
async fn test_load_unload_lifecycle() {
    let model_path = setup_test_model().await;

    let config_dir = TempDir::new().expect("Failed to create config dir");
    let ai_state = gitnado_lib::services::ai::create_ai_state(config_dir.path().to_path_buf());

    // Initially no provider available
    {
        let service = ai_state.read().await;
        assert!(
            service.find_available_provider().await.is_none(),
            "No provider should be available before loading"
        );
    }

    // Load model
    {
        let service = ai_state.read().await;
        service
            .load_local_model(&model_path, "Llama-3.2-1B".to_string(), None)
            .await
            .expect("load_local_model failed");
    }

    // Provider should now be available
    {
        let service = ai_state.read().await;
        let status = service.get_local_model_status().await;
        assert_eq!(
            status,
            gitnado_lib::services::ai::providers::LocalModelStatus::Ready,
            "Model should be Ready after loading"
        );
    }

    // Unload model
    {
        let service = ai_state.read().await;
        service.unload_local_model().await;
    }

    // Provider should be unavailable again
    {
        let service = ai_state.read().await;
        let status = service.get_local_model_status().await;
        assert_eq!(
            status,
            gitnado_lib::services::ai::providers::LocalModelStatus::Unloaded,
            "Model should be Unloaded after unloading"
        );
    }
}

/// Test: Verify each registry model's GGUF file is publicly accessible.
///
/// Does NOT download the full file — only sends a HEAD request to check
/// the URL resolves and is not gated.
#[tokio::test]
#[ignore]
async fn test_all_registry_models_are_accessible() {
    let registry = gitnado_lib::services::ai::local::ModelRegistry::default();
    let client = reqwest::Client::new();

    for model in registry.get_all() {
        let url = format!(
            "https://huggingface.co/{}/resolve/main/{}",
            model.hf_repo, model.hf_filename
        );
        eprintln!("Checking model file for {}: {url}", model.id);

        let response = client
            .head(&url)
            .header("User-Agent", "Gitnado-Integration-Test")
            .send()
            .await
            .unwrap_or_else(|e| panic!("Failed to reach {url}: {e}"));

        assert!(
            response.status().is_success(),
            "Model file for {} returned HTTP {} — repo '{}' / file '{}' may be gated or missing",
            model.id,
            response.status(),
            model.hf_repo,
            model.hf_filename,
        );
    }
    eprintln!(
        "All {} model files are accessible",
        registry.get_all().len()
    );
}
