/**
 * File Watcher Service
 * Watches for file system changes across all open repositories and emits
 * events tagged with the repository they came from.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invokeCommand } from './tauri-api.ts';
import { showToast } from './notification.service.ts';

export interface FileChangeEvent {
  repoPath: string;
  eventType: 'workdir-changed' | 'index-changed' | 'refs-changed' | 'config-changed';
  paths: string[];
}

export type FileChangeHandler = (event: FileChangeEvent) => void;

let unlisten: UnlistenFn | null = null;
// In-flight listener registration. Concurrent startWatching calls (e.g. the
// startup restore watching N repos at once) must share ONE registration —
// checking `unlisten` alone is not atomic across the await and used to leak
// N-1 duplicate listeners that each dispatched every event again.
let listenerSetup: Promise<void> | null = null;
const handlers: Set<FileChangeHandler> = new Set();

// Repositories the user has already been told about. A failed watch is
// retried by every caller that touches the repo (tab restore, panel remount,
// repo switch), and one toast per attempt would bury the app in warnings.
const warnedPaths: Set<string> = new Set();

/** Last path segment, so the toast names the repository the user knows. */
function repositoryLabel(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/**
 * Tell the user that auto-refresh is not running for a repository.
 *
 * Watch registration fails silently as far as the UI is concerned — the
 * commonest cause on Linux is an exhausted `fs.inotify.max_user_watches`
 * budget — and without this the app just quietly stops noticing outside
 * changes. The backend error already names the watch limit (and the sysctl to
 * raise) when that is the cause, so it is passed straight through.
 */
function reportWatchFailure(path: string, error: unknown): void {
  if (warnedPaths.has(path)) return;
  warnedPaths.add(path);

  const raw = error instanceof Error ? error.message : String(error);
  const detail = raw.trim().replace(/\.$/, '');
  showToast(
    `Auto-refresh is unavailable for "${repositoryLabel(path)}" — ${detail}. ` +
      'Changes made outside Gitnado will not appear until you refresh manually.',
    'warning',
    15000,
    {
      label: 'Retry',
      callback: () => {
        // Allow a fresh warning if the retry fails too
        warnedPaths.delete(path);
        void startWatching(path).catch(() => {
          /* reported by reportWatchFailure */
        });
      },
    }
  );
}

/**
 * Start watching a repository for file changes. Other repositories already
 * being watched are unaffected.
 *
 * A failure is surfaced to the user as a warning toast (see
 * `reportWatchFailure`) as well as rejecting, so callers only need to log.
 */
export async function startWatching(path: string): Promise<void> {
  // Set up the (single) event listener if not already done
  if (!listenerSetup) {
    listenerSetup = listen<FileChangeEvent>('file-change', (event) => {
      // Notify all registered handlers
      for (const handler of handlers) {
        try {
          handler(event.payload);
        } catch (err) {
          console.error('Error in file change handler:', err);
        }
      }
    }).then(
      (fn) => {
        unlisten = fn;
      },
      (err) => {
        // Don't cache a failed registration — the next call retries
        listenerSetup = null;
        throw err;
      }
    );
  }
  try {
    await listenerSetup;

    // Start watching on the backend
    const result = await invokeCommand<void>('start_watching', { path });
    if (!result.success) {
      throw new Error(result.error?.message ?? 'Failed to start watching');
    }
  } catch (err) {
    reportWatchFailure(path, err);
    throw err;
  }

  // Watching works again — a later failure may warn afresh
  warnedPaths.delete(path);
}

/**
 * Stop watching a repository. With no path, stop watching all repositories.
 */
export async function stopWatching(path?: string): Promise<void> {
  // A repo the user closed and reopens later deserves a fresh warning if it
  // still can't be watched
  if (path) {
    warnedPaths.delete(path);
  } else {
    warnedPaths.clear();
  }
  const result = await invokeCommand<void>('stop_watching', { path: path ?? null });
  if (!result.success) {
    throw new Error(result.error?.message ?? 'Failed to stop watching');
  }
}

/**
 * Register a handler for file change events
 * Returns an unsubscribe function
 */
export function onFileChange(handler: FileChangeHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/**
 * Clean up the watcher (call on app shutdown)
 */
export async function cleanup(): Promise<void> {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
  listenerSetup = null;
  handlers.clear();
  warnedPaths.clear();
  await stopWatching();
}
