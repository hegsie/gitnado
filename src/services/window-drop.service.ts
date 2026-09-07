/**
 * Window Drop Service
 *
 * Opens repositories dropped onto the application window. This is the OS-level
 * drop (a folder dragged from Finder/Explorer), which Tauri reports on the
 * webview as `tauri://drag-*` — not the in-app branch/commit/file drags handled
 * by `drag-drop.service.ts`.
 *
 * Every dropped path is classified in the backend first so each case can be
 * reported for what it is: a repository is opened, a folder that is not a
 * repository offers a scan or an init, and a file, a missing path, a failed
 * open or a drop that arrives while the previous one is still opening says so
 * instead of failing silently.
 */

import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { classifyRepositoryPath } from './repo-scan.service.ts';
import { openRepositoryPath } from './repository-open.service.ts';
import { showToast } from './notification.service.ts';
import { loggers } from '../utils/logger.ts';

const log = loggers.ui;

/**
 * Window event asking the UI to offer a scan (or an init) for a dropped folder
 * that is not a repository. Listened to by `app-shell`.
 */
export const REPOSITORY_SCAN_OFFER_EVENT = 'repository-scan-offer';

/**
 * Window event announcing that a dropped folder IS a repository and has been
 * opened (or its tab focused). Listened to by `app-shell`.
 *
 * The scan offer for that same folder can still be on screen: the offer is the
 * reason the user went and created or cloned a repository in it, and dropping
 * it again is how they come back. Without this the app would open the tab
 * behind a modal that still says "This folder is not a Git repository" and
 * still offers to initialize one there.
 */
export const REPOSITORY_SCAN_RESOLVED_EVENT = 'repository-scan-resolved';

export interface DroppedPathsOutcome {
  /** Repositories opened as new tabs. */
  opened: string[];
  /** Repositories that already had a tab; their tab was focused. */
  alreadyOpen: string[];
  /** Existing folders that are not repositories. */
  notRepositories: string[];
  /** Paths that do not exist any more. */
  missing: string[];
  /** Paths that exist but are files, not folders. */
  files: string[];
  /** Paths whose open (or classification) failed, with the reason. */
  failures: { path: string; message: string }[];
}

function emptyOutcome(): DroppedPathsOutcome {
  return {
    opened: [],
    alreadyOpen: [],
    notRepositories: [],
    missing: [],
    files: [],
    failures: [],
  };
}

function baseName(path: string): string {
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] || path;
}

/** Ask the shell to offer a scan/init for `path`. */
export function offerDirectoryScan(path: string): void {
  window.dispatchEvent(
    new CustomEvent<{ path: string }>(REPOSITORY_SCAN_OFFER_EVENT, { detail: { path } }),
  );
}

/** Tell the shell that `path` resolved to a repository after all. */
function reportResolvedRepository(path: string): void {
  window.dispatchEvent(
    new CustomEvent<{ path: string }>(REPOSITORY_SCAN_RESOLVED_EVENT, { detail: { path } }),
  );
}

/** Guards against a second drop landing while the first is still opening. */
let dropInFlight = false;

/**
 * Open every repository among `paths`, and report everything else.
 *
 * Sequential on purpose: opening repositories concurrently would interleave
 * their store writes and their index builds, and a handful of dropped folders
 * is never enough work to need the parallelism.
 */
export async function handleDroppedPaths(paths: string[]): Promise<DroppedPathsOutcome> {
  const outcome = emptyOutcome();
  if (paths.length === 0) return outcome;

  // A second drop landing while the first is still opening would interleave
  // two batches of store writes and two sets of toasts. Refusing is right;
  // refusing SILENTLY was not — opening a large repository takes seconds, and
  // the dropped folder simply vanished with no toast and no log. The guard
  // lives here rather than in the listener so every entry point into a drop
  // batch is covered by it, and so it can be exercised without a webview.
  if (dropInFlight) {
    showToast('Still opening the previous drop — try again in a moment', 'info');
    log.warn('Ignored a drop while another was still being opened:', paths);
    return outcome;
  }
  dropInFlight = true;

  try {
    await classifyAndOpen(paths, outcome);
  } finally {
    dropInFlight = false;
  }

  reportOutcome(outcome);
  return outcome;
}

/** Classify every dropped path and open the repositories among them. */
async function classifyAndOpen(
  paths: string[],
  outcome: DroppedPathsOutcome,
): Promise<void> {
  for (const path of paths) {
    const classification = await classifyRepositoryPath(path);
    if (!classification.success || !classification.data) {
      outcome.failures.push({
        path,
        message: classification.error?.message ?? 'Could not inspect the dropped path',
      });
      continue;
    }

    const info = classification.data;
    if (!info.exists) {
      outcome.missing.push(path);
      continue;
    }
    if (!info.isDirectory) {
      outcome.files.push(path);
      continue;
    }
    if (!info.isRepository) {
      outcome.notRepositories.push(path);
      continue;
    }

    const result = await openRepositoryPath(path);
    if (result.status === 'opened') {
      outcome.opened.push(path);
      reportResolvedRepository(path);
    } else if (result.status === 'already-open') {
      // Focusing an existing tab answers "is this a repository?" just as much
      // as opening a new one does, so a stale offer for it must go too.
      outcome.alreadyOpen.push(path);
      reportResolvedRepository(path);
    } else {
      outcome.failures.push({ path, message: result.message ?? 'Failed to open repository' });
    }
  }
}

/** Turn an outcome into user-visible feedback. Every branch must say something. */
function reportOutcome(outcome: DroppedPathsOutcome): void {
  const { opened, alreadyOpen, notRepositories, missing, files, failures } = outcome;

  if (opened.length === 1) {
    showToast(`Opened ${baseName(opened[0])}`, 'success');
  } else if (opened.length > 1) {
    showToast(`Opened ${opened.length} repositories`, 'success');
  }

  if (alreadyOpen.length === 1) {
    showToast(`${baseName(alreadyOpen[0])} is already open`, 'info');
  } else if (alreadyOpen.length > 1) {
    showToast(`${alreadyOpen.length} of the dropped repositories were already open`, 'info');
  }

  if (missing.length > 0) {
    showToast(
      missing.length === 1
        ? `${missing[0]} no longer exists`
        : `${missing.length} dropped paths no longer exist`,
      'error',
    );
  }

  if (files.length > 0) {
    showToast(
      files.length === 1
        ? `${baseName(files[0])} is a file — drop a folder to open it as a repository`
        : `${files.length} dropped items are files — drop a folder to open it as a repository`,
      'warning',
    );
  }

  for (const failure of failures) {
    showToast(`${baseName(failure.path)}: ${failure.message}`, 'error');
  }

  if (notRepositories.length === 0) return;

  // A single folder that is not a repository, with nothing else going on, is
  // the common case (someone dropped their projects folder): take them
  // straight to the offer instead of making them read a toast first.
  const nothingElseHappened =
    opened.length === 0 &&
    alreadyOpen.length === 0 &&
    missing.length === 0 &&
    files.length === 0 &&
    failures.length === 0;

  if (notRepositories.length === 1 && nothingElseHappened) {
    offerDirectoryScan(notRepositories[0]);
    return;
  }

  showToast(
    notRepositories.length === 1
      ? `${baseName(notRepositories[0])} is not a Git repository`
      : `${notRepositories.length} dropped folders are not Git repositories`,
    'warning',
    8000,
    {
      label: 'Scan folder',
      callback: () => offerDirectoryScan(notRepositories[0]),
    },
  );
}

/** True when the Tauri IPC bridge is present (i.e. not a plain browser). */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Listen for OS folder drops on this window.
 *
 * `onDragActiveChange` drives the drop affordance, so the user can see the
 * window will accept the folder before letting go.
 */
export async function startRepositoryDropListener(
  onDragActiveChange: (active: boolean) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};

  try {
    return await getCurrentWebview().onDragDropEvent(async (event) => {
      const payload = event.payload;
      if (payload.type === 'enter' || payload.type === 'over') {
        onDragActiveChange(true);
        return;
      }

      onDragActiveChange(false);
      if (payload.type !== 'drop') return;

      // handleDroppedPaths owns the re-entrancy guard (and reports a refused
      // drop), so the listener just hands it the batch.
      await handleDroppedPaths(payload.paths ?? []);
    });
  } catch (error) {
    // A webview that refuses the listener must not take the app down with it;
    // the picker and the recent list still work.
    log.error('Failed to listen for window file drops:', error);
    return () => {};
  }
}
