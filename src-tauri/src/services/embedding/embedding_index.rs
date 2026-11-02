//! Embedding index orchestrator
//!
//! Ties together the embedding engine, commit walking, and vector store
//! to build and query a semantic search index for a repository.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

use super::embedding_model;
use super::onnx_engine::OnnxEmbeddingEngine;
use super::vector_store::{EmbeddingIndexStatus, VectorSearchResult, VectorStore};

/// Shared embedding index state (managed by Tauri)
pub type SharedEmbeddingIndex = Arc<RwLock<EmbeddingIndexState>>;

/// Progress of an embedding index build
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingIndexProgress {
    pub repo_path: String,
    pub indexed_count: usize,
    pub total_count: usize,
    pub percent: f64,
}

/// State for the embedding index system
pub struct EmbeddingIndexState {
    models_dir: PathBuf,
    indexes_dir: PathBuf,
    engine: Option<OnnxEmbeddingEngine>,
    active_builds: HashMap<String, Arc<AtomicBool>>,
}

impl EmbeddingIndexState {
    /// Create a new embedding index state
    pub fn new(models_dir: PathBuf, indexes_dir: PathBuf) -> Self {
        Self {
            models_dir,
            indexes_dir,
            engine: None,
            active_builds: HashMap::new(),
        }
    }

    /// Check if the embedding model is downloaded
    pub fn is_model_downloaded(&self) -> bool {
        embedding_model::is_model_downloaded(&self.models_dir)
    }

    /// Get the models directory
    pub fn models_dir(&self) -> &PathBuf {
        &self.models_dir
    }

    /// Get the database path for a given repository
    pub fn db_path_for_repo(&self, repo_path: &str) -> PathBuf {
        let mut hasher = Sha256::new();
        hasher.update(repo_path.as_bytes());
        let result = hasher.finalize();
        let hash: String = result.iter().map(|b| format!("{:02x}", b)).collect();
        let short_hash = &hash[..16];
        self.indexes_dir.join(format!("{}.db", short_hash))
    }

    /// Ensure the embedding engine is loaded (lazy init).
    fn ensure_engine(&mut self) -> Result<&mut OnnxEmbeddingEngine, String> {
        if self.engine.is_none() {
            if !self.is_model_downloaded() {
                return Err("Embedding model not downloaded. Please download it first.".to_string());
            }

            let model_dir = embedding_model::get_model_dir(&self.models_dir);
            let engine = OnnxEmbeddingEngine::load(&model_dir)?;
            self.engine = Some(engine);
        }

        Ok(self.engine.as_mut().unwrap())
    }

    /// Register a build as active
    pub fn register_build(&mut self, repo_path: &str) -> Arc<AtomicBool> {
        let cancel = Arc::new(AtomicBool::new(false));
        self.active_builds
            .insert(repo_path.to_string(), cancel.clone());
        cancel
    }

    /// Check if a build is active for a repo
    pub fn is_building(&self, repo_path: &str) -> bool {
        self.active_builds.contains_key(repo_path)
    }

    /// Remove a build from active tracking
    pub fn finish_build(&mut self, repo_path: &str) {
        self.active_builds.remove(repo_path);
    }

    /// Cancel an active build
    pub fn cancel_build(&self, repo_path: &str) -> bool {
        if let Some(flag) = self.active_builds.get(repo_path) {
            flag.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    }
}

/// Build the full embedding index for a repository.
pub async fn build_embedding_index(
    state: &SharedEmbeddingIndex,
    repo_path: String,
    app_handle: AppHandle,
) -> Result<usize, String> {
    let (cancel_flag, db_path) = {
        let mut guard = state.write().await;
        guard.ensure_engine()?;
        let cancel = guard.register_build(&repo_path);
        let db_path = guard.db_path_for_repo(&repo_path);
        (cancel, db_path)
    };

    let repo_path_clone = repo_path.clone();
    let commits = tokio::task::spawn_blocking(move || collect_commits(&repo_path_clone))
        .await
        .map_err(|e| format!("Failed to walk commits: {}", e))??;

    let total_count = commits.len();
    let store = VectorStore::open(&db_path)?;
    let indexed_oids = store.get_indexed_oids()?;

    let new_commits: Vec<_> = commits
        .into_iter()
        .filter(|c| !indexed_oids.contains(&c.0))
        .collect();

    if new_commits.is_empty() {
        let mut guard = state.write().await;
        guard.finish_build(&repo_path);
        return Ok(total_count);
    }

    let batch_size = 32;
    let mut indexed_count = indexed_oids.len();

    for chunk in new_commits.chunks(batch_size) {
        if cancel_flag.load(Ordering::Relaxed) {
            let mut guard = state.write().await;
            guard.finish_build(&repo_path);
            return Err("Build cancelled".to_string());
        }

        let texts: Vec<&str> = chunk.iter().map(|c| c.1.as_str()).collect();

        let embeddings = {
            let mut guard = state.write().await;
            let engine = guard.ensure_engine()?;
            engine.embed_batch(&texts, batch_size)?
        };

        let items: Vec<(String, String, Vec<f32>)> = chunk
            .iter()
            .zip(embeddings)
            .map(|(c, emb)| (c.0.clone(), c.2.clone(), emb))
            .collect();

        store.upsert_embeddings_batch(&items)?;
        indexed_count += chunk.len();

        let percent = if total_count > 0 {
            (indexed_count as f64 / total_count as f64) * 100.0
        } else {
            100.0
        };

        let _ = app_handle.emit(
            "embedding-index-progress",
            EmbeddingIndexProgress {
                repo_path: repo_path.clone(),
                indexed_count,
                total_count,
                percent,
            },
        );
    }

    let mut guard = state.write().await;
    guard.finish_build(&repo_path);
    Ok(total_count)
}

/// Incrementally update the embedding index with new commits.
pub async fn update_embedding_index(
    state: &SharedEmbeddingIndex,
    repo_path: String,
    app_handle: AppHandle,
) -> Result<usize, String> {
    build_embedding_index(state, repo_path, app_handle).await
}

/// Perform a semantic search on the embedding index.
pub async fn semantic_search(
    state: &SharedEmbeddingIndex,
    repo_path: String,
    query: String,
    limit: usize,
) -> Result<Vec<VectorSearchResult>, String> {
    let query_embedding = {
        let mut guard = state.write().await;
        let engine = guard.ensure_engine()?;
        engine.embed(&query)?
    };

    let db_path = {
        let guard = state.read().await;
        guard.db_path_for_repo(&repo_path)
    };

    let store = VectorStore::open(&db_path)?;
    store.search_similar(&query_embedding, limit, 0.2)
}

/// Get the status of the embedding index for a repository.
pub async fn get_embedding_status(
    state: &SharedEmbeddingIndex,
    repo_path: String,
) -> Result<EmbeddingIndexStatus, String> {
    let guard = state.read().await;
    let model_downloaded = guard.is_model_downloaded();
    let is_building = guard.is_building(&repo_path);
    let db_path = guard.db_path_for_repo(&repo_path);

    let (indexed_commits, total_commits) = if db_path.exists() {
        let store = VectorStore::open(&db_path)?;
        let count = store.count()?;
        (count, count)
    } else {
        (0, 0)
    };

    Ok(EmbeddingIndexStatus {
        total_commits,
        indexed_commits,
        is_building,
        is_ready: indexed_commits > 0 && model_downloaded && !is_building,
        model_downloaded,
    })
}

/// Collect all commits from a repository as (oid, text_for_embedding, summary) tuples.
fn collect_commits(repo_path: &str) -> Result<Vec<(String, String, String)>, String> {
    let repo =
        git2::Repository::open(repo_path).map_err(|e| format!("Failed to open repo: {}", e))?;

    let mut revwalk = repo
        .revwalk()
        .map_err(|e| format!("Failed to create revwalk: {}", e))?;

    crate::utils::push_visible_refs(&repo, &mut revwalk)
        .map_err(|e| format!("Failed to push refs: {}", e))?;
    revwalk
        .set_sorting(git2::Sort::TIME)
        .map_err(|e| format!("Failed to set sorting: {}", e))?;

    let max_commits = 100_000;
    let mut commits = Vec::new();

    for oid_result in revwalk {
        if commits.len() >= max_commits {
            break;
        }

        let oid = match oid_result {
            Ok(o) => o,
            Err(_) => continue,
        };

        let commit = match repo.find_commit(oid) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let oid_str = oid.to_string();
        let summary = commit.summary().ok().flatten().unwrap_or("").to_string();
        let message = commit.message().ok().unwrap_or("").to_string();

        let text = if message.len() > summary.len() {
            message
        } else {
            summary.clone()
        };

        commits.push((oid_str, text, summary));
    }

    Ok(commits)
}
