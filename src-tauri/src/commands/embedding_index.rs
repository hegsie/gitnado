//! Embedding index command handlers

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::services::embedding::vector_store::{EmbeddingIndexStatus, VectorSearchResult};
use crate::services::embedding::SharedEmbeddingIndex;

/// Build the embedding index for a repository
#[command]
pub async fn build_embedding_index(
    state: tauri::State<'_, SharedEmbeddingIndex>,
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<usize> {
    crate::services::embedding::embedding_index::build_embedding_index(&state, path, app_handle)
        .await
        .map_err(GitnadoError::OperationFailed)
}

/// Incrementally refresh the embedding index
#[command]
pub async fn refresh_embedding_index(
    state: tauri::State<'_, SharedEmbeddingIndex>,
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<usize> {
    crate::services::embedding::embedding_index::update_embedding_index(&state, path, app_handle)
        .await
        .map_err(GitnadoError::OperationFailed)
}

/// Perform a semantic search
#[command]
pub async fn semantic_search(
    state: tauri::State<'_, SharedEmbeddingIndex>,
    path: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<VectorSearchResult>> {
    let limit = limit.unwrap_or(100);
    crate::services::embedding::embedding_index::semantic_search(&state, path, query, limit)
        .await
        .map_err(GitnadoError::OperationFailed)
}

/// Get embedding index status for a repository
#[command]
pub async fn get_embedding_index_status(
    state: tauri::State<'_, SharedEmbeddingIndex>,
    path: String,
) -> Result<EmbeddingIndexStatus> {
    crate::services::embedding::embedding_index::get_embedding_status(&state, path)
        .await
        .map_err(GitnadoError::OperationFailed)
}

/// Cancel an in-progress embedding build
#[command]
pub async fn cancel_embedding_build(
    state: tauri::State<'_, SharedEmbeddingIndex>,
    path: String,
) -> Result<()> {
    let guard = state.read().await;
    guard.cancel_build(&path);
    Ok(())
}

/// Check if the embedding model is downloaded
#[command]
pub async fn is_embedding_model_downloaded(
    state: tauri::State<'_, SharedEmbeddingIndex>,
) -> Result<bool> {
    let guard = state.read().await;
    Ok(guard.is_model_downloaded())
}

/// Download the embedding model
#[command]
pub async fn download_embedding_model(
    state: tauri::State<'_, SharedEmbeddingIndex>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let (models_dir, cancel_flag) = {
        let guard = state.read().await;
        (guard.models_dir().clone(), Arc::new(AtomicBool::new(false)))
    };

    crate::services::embedding::embedding_model::download_embedding_model(
        &models_dir,
        &app_handle,
        &cancel_flag,
    )
    .await
    .map_err(GitnadoError::OperationFailed)
}
