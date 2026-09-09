/**
 * Repository Discovery Service
 *
 * Thin wrapper over the backend's repository-discovery commands: classifying a
 * dropped path, and scanning a folder for repositories (with progress and
 * cancellation, since the folder a user picks can be their whole home
 * directory).
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invokeCommand } from './tauri-api.ts';
import type { CommandResult } from '../types/api.types.ts';

export interface DiscoveredRepository {
  path: string;
  name: string;
  isBare: boolean;
}

export interface RepositoryScanResult {
  root: string;
  repositories: DiscoveredRepository[];
  scannedDirectories: number;
  /** The scan hit a limit (results or directories) and stopped early. */
  truncated: boolean;
  /** The user cancelled; `repositories` holds what was found so far. */
  cancelled: boolean;
}

export interface RepositoryScanProgress {
  scannedDirectories: number;
  found: number;
  currentPath: string;
}

export interface PathClassification {
  path: string;
  name: string;
  exists: boolean;
  isDirectory: boolean;
  isRepository: boolean;
  isBare: boolean;
}

/** What a path dropped on the window is, so each case can be reported. */
export async function classifyRepositoryPath(
  path: string,
): Promise<CommandResult<PathClassification>> {
  return invokeCommand<PathClassification>('classify_repository_path', { path });
}

/** Walk `path` looking for repositories. Bounded and cancellable in the backend. */
export async function scanForRepositories(
  path: string,
  maxDepth?: number,
): Promise<CommandResult<RepositoryScanResult>> {
  return invokeCommand<RepositoryScanResult>('scan_for_repositories', { path, maxDepth });
}

/** Ask the in-flight scan to stop. It still returns what it found. */
export async function cancelRepositoryScan(): Promise<CommandResult<null>> {
  return invokeCommand<null>('cancel_repository_scan');
}

/**
 * Subscribe to scan progress. Resolves to a no-op unlisten outside Tauri (unit
 * tests, the Vite dev server) so callers never have to branch on the
 * environment.
 */
export async function onRepositoryScanProgress(
  handler: (progress: RepositoryScanProgress) => void,
): Promise<UnlistenFn> {
  try {
    const unlisten = await listen<RepositoryScanProgress>('repository-scan-progress', (event) => {
      handler(event.payload);
    });
    // Teardown must never throw at the caller: `unlisten` reaches into the
    // event plugin's internals, which are absent outside a real webview.
    return () => {
      void (async () => {
        try {
          await unlisten();
        } catch {
          /* the listener dies with the webview anyway */
        }
      })();
    };
  } catch {
    return () => {};
  }
}
