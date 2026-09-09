/**
 * Repository Open Service
 *
 * The single way a repository path becomes an open tab. The welcome screen,
 * the window drop handler and the scan results list all go through here, so
 * tabs, persistence and the recent list stay in step no matter which entry
 * point the user used — and so an already-open repository focuses its tab
 * instead of being opened twice.
 */

import { openRepository } from './git.service.ts';
import { searchIndexService } from './search-index.service.ts';
import { repositoryStore } from '../stores/index.ts';

export type OpenRepositoryStatus = 'opened' | 'already-open' | 'error';

export interface OpenRepositoryOutcome {
  path: string;
  status: OpenRepositoryStatus;
  /** Repository name, once it is known (opened or already open). */
  name?: string;
  /** Set only for `error`. */
  message?: string;
}

/**
 * Open `path` as a repository tab.
 *
 * Never throws: every failure comes back as an `error` outcome carrying the
 * message, so batch callers (a multi-path drop, a scan result selection) can
 * report a summary instead of one toast per path. The store's `error` field is
 * still written for parity with the rest of the app, but it has no render sink
 * — callers MUST surface `message` themselves.
 */
export async function openRepositoryPath(path: string): Promise<OpenRepositoryOutcome> {
  const store = repositoryStore.getState();

  // Focus, never duplicate: addRepository would activate the existing tab
  // anyway, but going through it would also re-run the index build and reorder
  // the recent list for a repository that is already right there.
  const existing = store.openRepositories.find((repo) => repo.repository.path === path);
  if (existing) {
    store.setActiveByPath(path);
    return { path, status: 'already-open', name: existing.repository.name };
  }

  store.setLoading(true);
  try {
    const result = await openRepository({ path });
    if (result.success && result.data) {
      store.addRepository(result.data);
      // Build the search index in the background (non-blocking).
      searchIndexService.buildIndex(path);
      return { path, status: 'opened', name: result.data.name };
    }
    const message = result.error?.message ?? 'Failed to open repository';
    store.setError(message);
    return { path, status: 'error', message };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    store.setError(message);
    return { path, status: 'error', message };
  } finally {
    repositoryStore.getState().setLoading(false);
  }
}
