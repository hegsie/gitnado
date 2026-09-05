/**
 * Update Service
 * Handles application update checking, downloading, and installation
 *
 * The updater contacts the release host (`plugins.updater.endpoints` in
 * `src-tauri/tauri.conf.json`) and can download and install a binary, so both
 * commands that reach it are gated on offline mode and the remote allowlist
 * exactly as the model downloads and the GitHub App endpoints are. This half
 * is the one that can explain the refusal before any work starts; the backend
 * refuses too (`src-tauri/src/services/update_service.rs`), which is what
 * covers the unattended 24-hour loop that no frontend gate ever sees.
 *
 * The BINARY's host is deliberately not checked here and has no counterpart
 * below: `latest.json` chooses it, so it is not knowable until the manifest
 * has been fetched — inside the backend, mid-command. `guard_update_download`
 * over there is the only place that check can live, and a refusal from it
 * arrives here as the same `BLOCKED` code these guards return.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invokeCommand } from './tauri-api.ts';
import { checkOutboundHostAllowed } from './git.service.ts';
import type { CommandResult } from '../types/api.types.ts';

/**
 * Update check result from backend
 */
export interface UpdateCheckEvent {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseNotes?: string;
}

/**
 * Update download progress event
 */
export interface UpdateProgressEvent {
  downloaded: number;
  total?: number;
  progressPercent: number;
}

/**
 * Update error event
 */
export interface UpdateErrorEvent {
  message: string;
}

/**
 * The host the updater contacts, kept in step with `plugins.updater.endpoints`
 * in `src-tauri/tauri.conf.json`. The backend reads that field directly; the
 * frontend cannot, so this is the one place the host is restated — and the
 * only thing it is used for is naming the host in the refusal.
 */
const UPDATE_HOST = 'https://github.com';

/**
 * Refuse an update operation that offline mode or the allowlist forbids.
 *
 * Silent, matching `invokeProviderCommand` in git.service and the GitHub App
 * guard in credential.service: the caller renders `error.message`, and a toast
 * as well would say the same thing twice.
 *
 * Returns the refusal to hand back, or null when the operation may proceed.
 */
async function guardUpdateNetwork(operation: string): Promise<CommandResult<never> | null> {
  const reason = await checkOutboundHostAllowed(UPDATE_HOST);
  if (!reason) return null;
  return {
    success: false,
    error: {
      // The code every other refusal uses, so `isNetworkGateRefusal`
      // recognises it and no caller reports it as a red failure twice.
      code: 'BLOCKED',
      message:
        reason === 'allowlist'
          ? `${operation} needs github.com, which is not in your remote allowlist. Add it in Settings > Security.`
          : `${operation} needs github.com, and offline mode is enabled. Turn it off in Settings > Security.`,
    },
  };
}

/**
 * Check for updates manually.
 *
 * Returns the full `CommandResult` rather than `UpdateCheckEvent | null`: a
 * refusal and a failed check used to collapse into the same `null`, which the
 * Settings dialog rendered as nothing at all.
 */
export async function checkForUpdate(): Promise<CommandResult<UpdateCheckEvent>> {
  const blocked = await guardUpdateNetwork('Checking for updates');
  if (blocked) return blocked;
  return invokeCommand<UpdateCheckEvent>('check_for_update');
}

/**
 * Download and install the available update
 */
export async function downloadAndInstallUpdate(): Promise<CommandResult<void>> {
  const blocked = await guardUpdateNetwork('Downloading an update');
  if (blocked) return blocked;
  return invokeCommand<void>('download_and_install_update');
}

/**
 * Start automatic update checking
 */
export async function startAutoUpdateCheck(
  intervalHours: number = 24
): Promise<boolean> {
  const result = await invokeCommand<void>('start_auto_update_check', {
    intervalHours,
  });
  return result.success;
}

/**
 * Stop automatic update checking
 */
export async function stopAutoUpdateCheck(): Promise<boolean> {
  const result = await invokeCommand<void>('stop_auto_update_check');
  return result.success;
}

/**
 * Check if auto-update is running
 */
export async function isAutoUpdateRunning(): Promise<boolean> {
  const result = await invokeCommand<boolean>('is_auto_update_running');
  return result.success && result.data === true;
}

/**
 * Get current application version
 */
export async function getAppVersion(): Promise<string> {
  const result = await invokeCommand<string>('get_app_version');
  return result.data ?? '0.0.0';
}

/**
 * Subscribe to update available events
 */
export async function onUpdateAvailable(
  handler: (event: UpdateCheckEvent) => void
): Promise<UnlistenFn> {
  return listen<UpdateCheckEvent>('update-available', (event) => {
    handler(event.payload);
  });
}

/**
 * Subscribe to update checked events (when no update available)
 */
export async function onUpdateChecked(
  handler: (event: UpdateCheckEvent) => void
): Promise<UnlistenFn> {
  return listen<UpdateCheckEvent>('update-checked', (event) => {
    handler(event.payload);
  });
}

/**
 * Subscribe to update downloading events
 */
export async function onUpdateDownloading(
  handler: () => void
): Promise<UnlistenFn> {
  return listen<void>('update-downloading', () => {
    handler();
  });
}

/**
 * Subscribe to download progress events
 */
export async function onDownloadProgress(
  handler: (progress: UpdateProgressEvent) => void
): Promise<UnlistenFn> {
  return listen<UpdateProgressEvent>('update-download-progress', (event) => {
    handler(event.payload);
  });
}

/**
 * Subscribe to update ready events
 */
export async function onUpdateReady(handler: () => void): Promise<UnlistenFn> {
  return listen<void>('update-ready', () => {
    handler();
  });
}

/**
 * Subscribe to update error events
 */
export async function onUpdateError(
  handler: (error: UpdateErrorEvent) => void
): Promise<UnlistenFn> {
  return listen<UpdateErrorEvent>('update-error', (event) => {
    handler(event.payload);
  });
}
