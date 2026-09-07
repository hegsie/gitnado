//! Search index command handlers
//!
//! Indexes are kept per repository path so multiple open repositories never
//! share (or corrupt) each other's index.

use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::services::commit_index::{CommitIndex, IndexedCommit, SharedCommitIndex};

/// Build the search index for a repository
#[command]
pub async fn build_search_index(
    index_state: tauri::State<'_, SharedCommitIndex>,
    path: String,
) -> Result<usize> {
    // Capture the path's generation BEFORE the (slow) blocking build. If the
    // tab is closed while we build, drop_search_index bumps the generation
    // and our result is discarded on insert — so a build that started before
    // a close-then-reopen can't clobber the index the reopen build created.
    let start_generation = {
        let guard = index_state.read().await;
        guard.generation(&path)
    };

    let path_clone = path.clone();
    let index = tokio::task::spawn_blocking(move || CommitIndex::build(&path_clone))
        .await
        .map_err(|e| GitnadoError::Custom(format!("Index build failed: {}", e)))??;

    let count = index.len();
    let mut guard = index_state.write().await;
    if !guard.insert_if_current(path, index, start_generation) {
        // A drop (tab close) bumped the generation while we were building, so
        // this index was NOT stored. Report it so the frontend leaves the
        // repo un-ready instead of marking it ready over an empty backend
        // slot — it will rebuild on next activation.
        return Err(GitnadoError::OperationFailed(
            "Search index build superseded by a newer generation".to_string(),
        ));
    }
    Ok(count)
}

/// Search the commit index of a specific repository
#[command]
pub async fn search_index(
    index_state: tauri::State<'_, SharedCommitIndex>,
    path: String,
    query: Option<String>,
    author: Option<String>,
    date_from: Option<i64>,
    date_to: Option<i64>,
    limit: Option<usize>,
) -> Result<Vec<IndexedCommit>> {
    let guard = index_state.read().await;
    let index = guard
        .get(&path)
        .ok_or_else(|| GitnadoError::OperationFailed("Search index not built yet".to_string()))?;

    let results = index.search(
        query.as_deref(),
        author.as_deref(),
        date_from,
        date_to,
        limit,
    );

    Ok(results.into_iter().cloned().collect())
}

/// Refresh the search index of a repository incrementally
#[command]
pub async fn refresh_search_index(
    index_state: tauri::State<'_, SharedCommitIndex>,
    path: String,
) -> Result<usize> {
    // Take this repo's index out for updating so the lock isn't held across
    // the blocking revwalk; other repos' indexes stay available meanwhile.
    // Capture the generation with it so a close during the walk discards the
    // reinsert (same guard as build_search_index).
    let (existing, start_generation) = {
        let mut guard = index_state.write().await;
        (guard.take(&path), guard.generation(&path))
    };

    if let Some(mut index) = existing {
        let path_clone = path.clone();
        let updated = tokio::task::spawn_blocking(move || {
            index.update_incremental(&path_clone)?;
            Ok::<_, GitnadoError>(index)
        })
        .await
        .map_err(|e| GitnadoError::Custom(format!("Index refresh failed: {}", e)))??;

        let count = updated.len();
        let mut guard = index_state.write().await;
        if !guard.insert_if_current(path, updated, start_generation) {
            return Err(GitnadoError::OperationFailed(
                "Search index refresh superseded by a newer generation".to_string(),
            ));
        }
        Ok(count)
    } else {
        // No index exists, build from scratch
        build_search_index(index_state, path).await
    }
}

/// Drop the search index of a repository (e.g., when its tab is closed)
#[command]
pub async fn drop_search_index(
    index_state: tauri::State<'_, SharedCommitIndex>,
    path: String,
) -> Result<()> {
    let mut guard = index_state.write().await;
    guard.drop_index(&path);
    Ok(())
}
