/**
 * Local AI Service
 * Manages local model inference, downloads, and system capabilities
 */

import { msg } from '@lit/localize';

import { invokeCommand, listenToEvent } from './tauri-api.ts';
import { showToast } from './notification.service.ts';
import { checkOutboundHostAllowed } from './git.service.ts';
import type { CommandResult } from '../types/api.types.ts';
import type { UnlistenFn } from '@tauri-apps/api/event';

/**
 * Where a model's weights come from
 * (`model_download_url` in src-tauri/src/services/ai/local/model_manager.rs).
 *
 * Running the model afterwards never leaves the machine, but FETCHING it is a
 * multi-gigabyte transfer to a third party — exactly what offline mode and the
 * allowlist exist to refuse. The backend guards the same URL; this half is the
 * one that can refuse before anything starts.
 */
const MODEL_DOWNLOAD_HOST = 'https://huggingface.co';

/**
 * GPU vendor types
 */
export type GpuVendor = 'apple' | 'nvidia' | 'amd' | 'intel' | 'unknown';

/**
 * Model tier based on system capabilities
 */
export type ModelTier = 'ultra_light' | 'standard' | 'none';

/**
 * GPU information
 */
export interface GpuInfo {
  name: string;
  vendor: GpuVendor;
  vramBytes: number | null;
  metalSupported: boolean;
  cudaSupported: boolean;
}

/**
 * System capabilities for local AI
 */
export interface SystemCapabilities {
  totalRamBytes: number;
  availableRamBytes: number;
  gpuInfo: GpuInfo | null;
  recommendedTier: ModelTier;
  gpuAccelerationAvailable: boolean;
}

/**
 * Model entry from the registry
 */
export interface ModelEntry {
  id: string;
  displayName: string;
  hfRepo: string;
  hfFilename: string;
  sha256: string;
  sizeBytes: number;
  minRamBytes: number;
  tier: ModelTier;
  architecture: string;
  contextLength: number;
}

/**
 * Status of a local model
 */
export type ModelStatus = 'not_downloaded' | 'downloading' | 'downloaded' | 'loading' | 'ready' | 'error';

/**
 * Status of the local inference engine
 */
export type LocalModelStatus = 'unloaded' | 'loading' | 'ready' | 'error';

/**
 * Downloaded model information
 */
export interface DownloadedModel {
  id: string;
  displayName: string;
  sizeBytes: number;
  path: string;
  status: ModelStatus;
}

/**
 * Model download progress event payload
 */
export interface DownloadProgress {
  modelId: string;
  downloadedBytes: number;
  totalBytes: number;
  progressPercent: number;
}

/**
 * Get system capabilities (RAM, GPU, recommended tier)
 */
export async function getSystemCapabilities(): Promise<CommandResult<SystemCapabilities>> {
  return invokeCommand<SystemCapabilities>('get_system_capabilities');
}

/**
 * Get all available models from the registry
 */
export async function getAvailableModels(): Promise<CommandResult<ModelEntry[]>> {
  return invokeCommand<ModelEntry[]>('get_available_models');
}

/**
 * Get locally downloaded models
 */
export async function getDownloadedModels(): Promise<CommandResult<DownloadedModel[]>> {
  return invokeCommand<DownloadedModel[]>('get_downloaded_models');
}

/**
 * Start downloading a model (returns immediately, progress via events)
 *
 * Gated: `download_model` spawns the transfer in the background and returns at
 * once, so an ungated call gave no refusal, no toast and no way back — just
 * gigabytes leaving a machine the user had told the app to keep offline.
 * `BLOCKED` is the code every other refusal uses, so `isNetworkGateRefusal`
 * recognises it; the caller renders `error.message`, hence no toast here.
 */
export async function downloadModel(modelId: string): Promise<CommandResult<void>> {
  const reason = await checkOutboundHostAllowed(MODEL_DOWNLOAD_HOST);
  if (reason) {
    return {
      success: false,
      error: {
        code: 'BLOCKED',
        message:
          reason === 'allowlist'
            ? `Downloading a model needs huggingface.co, which is not in your remote allowlist. Add it in Settings > Security.`
            : 'Offline mode is enabled, so the model cannot be downloaded. Turn it off in Settings > Security.',
      },
    };
  }
  return invokeCommand<void>('download_model', { modelId });
}

/**
 * Cancel an in-progress model download
 */
export async function cancelModelDownload(modelId: string): Promise<CommandResult<void>> {
  return invokeCommand<void>('cancel_model_download', { modelId });
}

/**
 * Delete a downloaded model
 */
export async function deleteModel(modelId: string): Promise<CommandResult<void>> {
  return invokeCommand<void>('delete_model', { modelId });
}

/**
 * Get the current status of the local inference engine
 */
export async function getModelStatus(): Promise<CommandResult<LocalModelStatus>> {
  return invokeCommand<LocalModelStatus>('get_model_status');
}

/**
 * Get the display name of the currently loaded model, if any
 */
export async function getLoadedModelName(): Promise<CommandResult<string | null>> {
  return invokeCommand<string | null>('get_loaded_model_name');
}

/**
 * Get the recommended model based on system capabilities
 */
export async function getRecommendedModel(): Promise<CommandResult<ModelEntry | null>> {
  return invokeCommand<ModelEntry | null>('get_recommended_model');
}

/**
 * Load a downloaded model into the inference engine
 */
export async function loadModel(modelId: string): Promise<CommandResult<void>> {
  const result = await invokeCommand<void>('load_model', { modelId });
  if (result.success) {
    // Notify other components that AI is now available
    window.dispatchEvent(new CustomEvent('ai-settings-changed'));
  }
  return result;
}

/**
 * Unload the current local model from memory
 */
export async function unloadModel(): Promise<CommandResult<void>> {
  const result = await invokeCommand<void>('unload_model');
  if (result.success) {
    window.dispatchEvent(new CustomEvent('ai-settings-changed'));
  }
  return result;
}

/**
 * The backend's error text for a download the user asked to cancel.
 * A cancel is reported on the same event as a genuine failure, so it has to be
 * recognised by its message and left un-toasted.
 */
const CANCELLED_ERROR = 'Download cancelled';

/**
 * Report background model download/load failures for the life of the app.
 *
 * `download_model` returns as soon as the download is spawned and only reports
 * the outcome minutes later over a Tauri event. The Settings dialog that
 * started the download is destroyed when it closes, taking its listeners with
 * it, so without an app-level listener a failed download is completely silent
 * and the user is left with no model and no explanation.
 *
 * Returns a single unlisten that removes both listeners.
 */
export async function listenForModelDownloadFailures(): Promise<UnlistenFn> {
  const unlistenError = await listenToEvent<{ modelId: string; error: string }>(
    'model-download-error',
    ({ modelId, error }) => {
      // A user-requested cancel arrives on this event too - not a failure.
      if (error === CANCELLED_ERROR) return;
      showToast(`Model download failed for ${modelId}: ${error}`, 'error', 8000);
    }
  );

  const unlistenComplete = await listenToEvent<{
    modelId: string;
    loaded?: boolean;
    loadError?: string;
  }>('model-download-complete', ({ modelId, loaded, loadError }) => {
    // Only an explicit `loaded: false` is a failure; the success emitters send
    // `loaded: true` and other callers may omit the flag entirely.
    if (loaded !== false) return;
    showToast(
      `${modelId} downloaded but failed to load: ${loadError ?? 'unknown error'}`,
      'error',
      8000
    );
  });

  return () => {
    unlistenError();
    unlistenComplete();
  };
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/**
 * Get display name for a model tier
 */
export function getTierDisplayName(tier: ModelTier): string {
  // Called from the render, not cached, so it re-resolves when the locale
  // changes. These are UI labels rather than registry data: the settings
  // dialog shows them in the Local AI status pill and in every model row,
  // beside text that is already localised.
  switch (tier) {
    case 'ultra_light':
      return msg('Ultra-Light (8GB+ RAM)');
    case 'standard':
      return msg('Standard (16GB+ RAM)');
    case 'none':
      return msg('Not Supported');
  }
}
