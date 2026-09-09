/**
 * Embedding Index Service
 * Provides semantic commit searching via ONNX-based embeddings
 * and SQLite vector storage on the Rust backend
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { checkOutboundHostAllowed } from './git.service.ts';

/**
 * Where the embedding model's files come from
 * (`hf_file_url` in src-tauri/src/services/embedding/embedding_model.rs).
 *
 * Building and searching the index are local; downloading the model is not.
 */
const MODEL_DOWNLOAD_HOST = 'https://huggingface.co';

export interface VectorSearchResult {
  oid: string;
  distance: number;
  summary: string;
}

export interface EmbeddingIndexStatus {
  totalCommits: number;
  indexedCommits: number;
  isBuilding: boolean;
  isReady: boolean;
  modelDownloaded: boolean;
}

export interface EmbeddingIndexProgress {
  repoPath: string;
  indexedCount: number;
  totalCount: number;
  percent: number;
}

class EmbeddingIndexService {
  // Builds are tracked per repo, keyed by the cancel epoch they started
  // under. Concurrent builds for DIFFERENT repos must both run (a global
  // flag silently dropped every build after the first). Dedup is
  // epoch-aware (mirroring searchIndexService): after a cancel (tab close)
  // bumps the epoch, a reopen's build is a new epoch, and the cancelled
  // build's late completion must not clear the reopen build's marker.
  private buildingRepos = new Map<string, number>();
  // Bumped by cancelBuild() so a build cancelled mid-flight doesn't dedupe
  // away or clobber a subsequent reopen build.
  private cancelEpochs = new Map<string, number>();

  /**
   * Build the embedding index for a repository.
   * Non-blocking - meant to be called fire-and-forget.
   */
  async buildIndex(repoPath: string): Promise<void> {
    const epoch = this.cancelEpochs.get(repoPath) ?? 0;
    // Dedupe only builds from the SAME epoch: a cancelled pre-close build
    // still unwinding must not block the rebuild for a reopened tab.
    if (this.buildingRepos.get(repoPath) === epoch) return;
    this.buildingRepos.set(repoPath, epoch);

    try {
      const count = await invoke<number>('build_embedding_index', { path: repoPath });
      console.log(`[EmbeddingIndex] Built index for ${repoPath} with ${count} commits`);
    } catch (err) {
      console.warn('[EmbeddingIndex] Failed to build index:', err);
    } finally {
      // Only clear the marker if it still belongs to THIS build — a newer
      // (post-cancel) build may have replaced it
      if (this.buildingRepos.get(repoPath) === epoch) {
        this.buildingRepos.delete(repoPath);
      }
    }
  }

  /**
   * Incrementally refresh the embedding index after repo mutations
   */
  async refreshIndex(repoPath: string): Promise<void> {
    try {
      await invoke<number>('refresh_embedding_index', { path: repoPath });
    } catch (err) {
      console.warn('[EmbeddingIndex] Failed to refresh index:', err);
    }
  }

  /**
   * Perform a semantic search on the embedding index
   */
  async semanticSearch(
    repoPath: string,
    query: string,
    limit?: number,
  ): Promise<VectorSearchResult[]> {
    const results = await invoke<VectorSearchResult[]>('semantic_search', {
      path: repoPath,
      query,
      limit: limit ?? 100,
    });
    return results;
  }

  /**
   * Get the status of the embedding index for a repository
   */
  async getStatus(repoPath: string): Promise<EmbeddingIndexStatus> {
    return invoke<EmbeddingIndexStatus>('get_embedding_index_status', {
      path: repoPath,
    });
  }

  /**
   * Cancel an in-progress embedding build (e.g. the tab was closed).
   * Bumps the epoch and clears the in-flight marker so a reopened tab can
   * start a fresh build, and the cancelled build's late completion can't
   * clear the reopen build's marker.
   */
  async cancelBuild(repoPath: string): Promise<void> {
    this.cancelEpochs.set(repoPath, (this.cancelEpochs.get(repoPath) ?? 0) + 1);
    this.buildingRepos.delete(repoPath);
    await invoke<void>('cancel_embedding_build', { path: repoPath });
  }

  /**
   * Check if the embedding model is downloaded
   */
  async isModelDownloaded(): Promise<boolean> {
    return invoke<boolean>('is_embedding_model_downloaded');
  }

  /**
   * Download the embedding model
   *
   * Gated for the same reason the local-AI model download is: it is a ~90MB
   * transfer to huggingface.co, and offline mode promises to stop it. The
   * refusal is thrown rather than returned because every other method here
   * reports failure that way.
   */
  async downloadModel(): Promise<void> {
    const reason = await checkOutboundHostAllowed(MODEL_DOWNLOAD_HOST);
    if (reason) {
      throw new Error(
        reason === 'allowlist'
          ? 'Downloading the embedding model needs huggingface.co, which is not in your remote allowlist. Add it in Settings > Security.'
          : 'Offline mode is enabled, so the embedding model cannot be downloaded. Turn it off in Settings > Security.',
      );
    }
    await invoke<void>('download_embedding_model');
  }

  /**
   * Listen for embedding index progress events
   */
  async onProgress(
    callback: (progress: EmbeddingIndexProgress) => void,
  ): Promise<UnlistenFn> {
    return listen<EmbeddingIndexProgress>('embedding-index-progress', (event) => {
      callback(event.payload);
    });
  }

}

export const embeddingIndexService = new EmbeddingIndexService();
