//! Candle-based sentence embedding engine
//!
//! Loads an all-MiniLM-L6-v2 model via candle (pure Rust) and produces
//! 384-dimensional normalized embeddings from text input.

use std::path::Path;

use candle_core::{Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config};
use tokenizers::Tokenizer;

/// Candle-based sentence embedding engine
pub struct OnnxEmbeddingEngine {
    model: BertModel,
    tokenizer: Tokenizer,
    device: Device,
    embedding_dim: usize,
}

impl OnnxEmbeddingEngine {
    /// Select the best available hardware accelerator for Candle embeddings.
    ///
    /// Prefers Metal on macOS and CUDA when compiled with the `cuda` feature,
    /// falling back gracefully to CPU if initialization fails.
    pub fn select_best_device() -> Device {
        #[cfg(target_os = "macos")]
        {
            match Device::new_metal(0) {
                Ok(device) => {
                    tracing::info!("Using Metal GPU acceleration for embeddings");
                    return device;
                }
                Err(e) => {
                    tracing::warn!(
                        "Metal device unavailable for embeddings ({e}), falling back to CPU"
                    );
                }
            }
        }

        #[cfg(feature = "cuda")]
        {
            match Device::new_cuda(0) {
                Ok(device) => {
                    tracing::info!("Using CUDA GPU acceleration for embeddings");
                    return device;
                }
                Err(e) => {
                    tracing::warn!(
                        "CUDA device unavailable for embeddings ({e}), falling back to CPU"
                    );
                }
            }
        }

        Device::Cpu
    }

    /// Return the name of the compute device currently backing this engine.
    pub fn device_name(&self) -> &'static str {
        match &self.device {
            Device::Metal(_) => "metal",
            Device::Cuda(_) => "cuda",
            Device::Cpu => "cpu",
        }
    }

    /// Load the model and tokenizer from a directory.
    ///
    /// The directory must contain `model.safetensors` (or `pytorch_model.bin`),
    /// `tokenizer.json`, and `config.json`.
    pub fn load(model_dir: &Path) -> Result<Self, String> {
        let preferred_device = Self::select_best_device();
        match Self::load_with_device(model_dir, preferred_device) {
            Ok(engine) => Ok(engine),
            Err(err) => {
                // If loading on an accelerated device failed, retry on CPU
                tracing::warn!(
                    "Failed to load embedding model on preferred device ({err}), retrying on CPU"
                );
                Self::load_with_device(model_dir, Device::Cpu)
            }
        }
    }

    fn load_with_device(model_dir: &Path, device: Device) -> Result<Self, String> {
        // Load config
        let config_path = model_dir.join("config.json");
        if !config_path.exists() {
            return Err(format!("Config file not found: {}", config_path.display()));
        }
        let config_str = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        let config: Config = serde_json::from_str(&config_str)
            .map_err(|e| format!("Failed to parse config: {}", e))?;

        let embedding_dim = config.hidden_size;

        // Load model weights
        let weights_path = model_dir.join("model.safetensors");
        let vb = if weights_path.exists() {
            unsafe {
                VarBuilder::from_mmaped_safetensors(
                    &[weights_path],
                    candle_core::DType::F32,
                    &device,
                )
                .map_err(|e| format!("Failed to load safetensors: {}", e))?
            }
        } else {
            return Err("Model weights not found. Expected model.safetensors".to_string());
        };

        let model = BertModel::load(vb, &config)
            .map_err(|e| format!("Failed to load BERT model: {}", e))?;

        // Load tokenizer
        let tokenizer_path = model_dir.join("tokenizer.json");
        if !tokenizer_path.exists() {
            return Err(format!(
                "Tokenizer file not found: {}",
                tokenizer_path.display()
            ));
        }
        let tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| format!("Failed to load tokenizer: {}", e))?;

        Ok(Self {
            model,
            tokenizer,
            device,
            embedding_dim,
        })
    }

    /// Get the embedding dimension (384 for all-MiniLM-L6-v2)
    pub fn dim(&self) -> usize {
        self.embedding_dim
    }

    /// Embed a single text string, returns a normalized vector.
    pub fn embed(&mut self, text: &str) -> Result<Vec<f32>, String> {
        let batch = self.embed_batch(&[text], 1)?;
        batch
            .into_iter()
            .next()
            .ok_or_else(|| "Empty embedding result".to_string())
    }

    /// Batch embed multiple texts for efficiency.
    pub fn embed_batch(
        &mut self,
        texts: &[&str],
        batch_size: usize,
    ) -> Result<Vec<Vec<f32>>, String> {
        let mut all_embeddings = Vec::with_capacity(texts.len());

        for chunk in texts.chunks(batch_size) {
            let chunk_embeddings = self.embed_chunk(chunk)?;
            all_embeddings.extend(chunk_embeddings);
        }

        Ok(all_embeddings)
    }

    /// Embed a single chunk of texts
    fn embed_chunk(&mut self, texts: &[&str]) -> Result<Vec<Vec<f32>>, String> {
        let batch_size = texts.len();
        if batch_size == 0 {
            return Ok(Vec::new());
        }

        // Tokenize all texts
        let encodings = self
            .tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(|e| format!("Tokenization failed: {}", e))?;

        // Find max length for padding
        let max_len = encodings
            .iter()
            .map(|e| e.get_ids().len())
            .max()
            .unwrap_or(0)
            .min(512);

        if max_len == 0 {
            return Ok(vec![vec![0.0; self.embedding_dim]; batch_size]);
        }

        // Build input tensors
        let mut input_ids_vec = vec![0u32; batch_size * max_len];
        let mut attention_mask_vec = vec![0u32; batch_size * max_len];
        let mut token_type_ids_vec = vec![0u32; batch_size * max_len];

        for (i, encoding) in encodings.iter().enumerate() {
            let ids = encoding.get_ids();
            let mask = encoding.get_attention_mask();
            let types = encoding.get_type_ids();
            let len = ids.len().min(max_len);

            for j in 0..len {
                input_ids_vec[i * max_len + j] = ids[j];
                attention_mask_vec[i * max_len + j] = mask[j];
                token_type_ids_vec[i * max_len + j] = types[j];
            }
        }

        let input_ids = Tensor::from_vec(input_ids_vec, (batch_size, max_len), &self.device)
            .map_err(|e| format!("Failed to create input_ids tensor: {}", e))?;
        let attention_mask = Tensor::from_vec(
            attention_mask_vec.clone(),
            (batch_size, max_len),
            &self.device,
        )
        .map_err(|e| format!("Failed to create attention_mask tensor: {}", e))?;
        let token_type_ids =
            Tensor::from_vec(token_type_ids_vec, (batch_size, max_len), &self.device)
                .map_err(|e| format!("Failed to create token_type_ids tensor: {}", e))?;

        // Run inference
        let output = self
            .model
            .forward(&input_ids, &token_type_ids, Some(&attention_mask))
            .map_err(|e| format!("Model forward pass failed: {}", e))?;

        // Mean pooling with attention mask
        let mut embeddings = Vec::with_capacity(batch_size);

        for i in 0..batch_size {
            let hidden = output
                .get(i)
                .map_err(|e| format!("Failed to get batch element: {}", e))?;

            // Build mask for this sample
            let mask_start = i * max_len;
            let mask_slice = &attention_mask_vec[mask_start..mask_start + max_len];

            let pooled = mean_pool_tensor(&hidden, mask_slice, self.embedding_dim)?;
            let normalized = l2_normalize(&pooled);
            embeddings.push(normalized);
        }

        Ok(embeddings)
    }
}

/// Mean pooling: average hidden states weighted by attention mask
fn mean_pool_tensor(
    hidden_states: &Tensor,
    attention_mask: &[u32],
    hidden_dim: usize,
) -> Result<Vec<f32>, String> {
    let hidden_data: Vec<f32> = hidden_states
        .flatten_all()
        .map_err(|e| format!("Failed to flatten: {}", e))?
        .to_vec1()
        .map_err(|e| format!("Failed to convert to vec: {}", e))?;

    let seq_len = attention_mask.len();
    let mut sum = vec![0.0f32; hidden_dim];
    let mut count: f32 = 0.0;

    for (i, &mask_val_u32) in attention_mask.iter().enumerate().take(seq_len) {
        let mask_val = mask_val_u32 as f32;
        if mask_val > 0.0 {
            let offset = i * hidden_dim;
            for j in 0..hidden_dim {
                sum[j] += hidden_data[offset + j] * mask_val;
            }
            count += mask_val;
        }
    }

    if count > 0.0 {
        for val in &mut sum {
            *val /= count;
        }
    }

    Ok(sum)
}

/// L2 normalize a vector
fn l2_normalize(v: &[f32]) -> Vec<f32> {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        v.iter().map(|x| x / norm).collect()
    } else {
        v.to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_l2_normalize() {
        let v = vec![3.0, 4.0];
        let result = l2_normalize(&v);
        let norm: f32 = result.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-6);
        assert!((result[0] - 0.6).abs() < 1e-6);
        assert!((result[1] - 0.8).abs() < 1e-6);
    }

    #[test]
    fn test_l2_normalize_zero() {
        let v = vec![0.0, 0.0];
        let result = l2_normalize(&v);
        assert!((result[0]).abs() < 1e-6);
        assert!((result[1]).abs() < 1e-6);
    }

    #[test]
    fn test_mean_pool_tensor_basic() {
        // Create a simple tensor: 3 tokens, 2 dims
        let device = Device::Cpu;
        let data = vec![1.0f32, 2.0, 3.0, 4.0, 5.0, 6.0];
        let hidden = Tensor::from_vec(data, (3, 2), &device).unwrap();
        let mask = vec![1u32, 1, 0]; // Only first two tokens

        let result = mean_pool_tensor(&hidden, &mask, 2).unwrap();
        assert!((result[0] - 2.0).abs() < 1e-6); // (1+3)/2
        assert!((result[1] - 3.0).abs() < 1e-6); // (2+4)/2
    }

    #[test]
    fn test_mean_pool_tensor_all_masked() {
        let device = Device::Cpu;
        let data = vec![1.0f32, 2.0, 3.0, 4.0];
        let hidden = Tensor::from_vec(data, (2, 2), &device).unwrap();
        let mask = vec![0u32, 0];

        let result = mean_pool_tensor(&hidden, &mask, 2).unwrap();
        assert!((result[0]).abs() < 1e-6);
        assert!((result[1]).abs() < 1e-6);
    }

    #[test]
    fn test_select_best_device_succeeds() {
        let device = OnnxEmbeddingEngine::select_best_device();
        match device {
            Device::Metal(_) | Device::Cuda(_) | Device::Cpu => {}
        }
    }
}
