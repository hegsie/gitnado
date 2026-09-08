/**
 * A `.git/config` change reaching the store.
 *
 * The five surfaces that fetch, pull and push refuse outright on a repository
 * the store says has no remote — and the store's `remotes` had only two
 * writers: `handleRefresh` (which the Remotes dialog asks for) and tab
 * activation. Neither fires for the repository the user is LOOKING at, so a
 * `git remote add origin …` typed into a terminal never reached it: the
 * backend classified the write as `config-changed`, emitted it, the frontend
 * typed it — and nobody listened. All five surfaces went on refusing, while
 * the refusal's own "Add a remote…" button opened a dialog that reads fresh
 * from git and listed the remote. A BACKGROUND repository self-healed through
 * `staleRepoPaths`; the active one, the common case, did not.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
const invokeCallArgs: Array<{ command: string; args: Record<string, unknown> }> = [];
const mockResponses: Record<string, (args: Record<string, unknown>) => unknown> = {};

let cbId = 0;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: Record<string, unknown>) => {
    invokeCallArgs.push({ command, args: args || {} });
    const handler = mockResponses[command];
    return Promise.resolve(handler ? handler(args || {}) : null);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, waitUntil } from '@open-wc/testing';
import type { AppShell } from '../app-shell.ts';
import '../app-shell.ts';
import { repositoryStore } from '../stores/index.ts';
import type { Repository } from '../types/git.types.ts';
import { knownToHaveNoRemote } from '../utils/remote-availability.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

const REPO = '/repo/one';
const ORIGIN = { name: 'origin', url: 'https://example.test/o/r.git', pushUrl: null };

function mockRepo(path: string, name: string): Repository {
  return {
    path,
    name,
    isValid: true,
    isBare: false,
    headRef: 'main',
    detachedHeadOid: null,
    state: 'clean',
    isShallow: false,
    isPartialClone: false,
    cloneFilter: null,
  } as unknown as Repository;
}

/** A repository open in the store whose remotes have been READ and are none. */
function openRemotelessRepo(): void {
  repositoryStore.setState({
    openRepositories: [
      {
        repository: mockRepo(REPO, 'one'),
        branches: [],
        currentBranch: null,
        remotes: [],
        remotesLoaded: true,
        tags: [],
        stashes: [],
      },
    ],
    activeIndex: 0,
  } as any);
}

/**
 * A shell watching `REPO`, with `REPO` active.
 *
 * The right panel is marked visible so the badge hydration the same handler
 * schedules stays out of the way: `lv-file-status` owns it while the panel is
 * mounted, and this test is about the remotes read.
 */
function shellWatchingRepo(): AppShell {
  const el = document.createElement('lv-app-shell') as AppShell;
  (el as any).activeRepository = repositoryStore.getState().getActiveRepository();
  (el as any).rightPanelVisible = true;
  (el as any).watchedRepoPaths = new Set([REPO]);
  return el;
}

function configChanged(el: AppShell, repoPath = REPO): void {
  (el as any).handleWatcherEvent({ repoPath, eventType: 'config-changed', paths: [] });
}

function remoteReads(): number {
  return invokeCallArgs.filter((c) => c.command === 'get_remotes').length;
}

/**
 * Close a tab the way the repository-store subscription does.
 *
 * The order matters and is the order of `app-shell.ts:1881-1886`: every path
 * that is no longer open is torn down FIRST, and only then is
 * `watchedRepoPaths` replaced with the set that is still open. Nothing else
 * writes that set, so a test that edits it by hand is not closing a tab — it
 * is deciding the outcome itself, which is how the pending-read assertion
 * below used to pass with the teardown's timer cleanup deleted outright.
 */
function closeRepoTab(el: AppShell, path: string): void {
  repositoryStore.setState({
    openRepositories: repositoryStore
      .getState()
      .openRepositories.filter((r) => r.repository.path !== path),
    activeIndex: -1,
  } as any);
  const openPaths = new Set(
    repositoryStore.getState().openRepositories.map((r) => r.repository.path),
  );
  for (const watched of (el as any).watchedRepoPaths as Set<string>) {
    if (!openPaths.has(watched)) (el as any).teardownRepoServices(watched);
  }
  (el as any).watchedRepoPaths = openPaths;
}

function storedRemotes(): unknown[] {
  return repositoryStore.getState().openRepositories[0]?.remotes ?? [];
}

/** Past the config debounce, so "nothing was read" is a real absence. */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 400);
  });
}

describe('app-shell and a config change under the active repository', () => {
  beforeEach(() => {
    invokeCallArgs.length = 0;
    for (const k of Object.keys(mockResponses)) delete mockResponses[k];
    mockResponses['get_remotes'] = () => [ORIGIN];
    repositoryStore.getState().reset();
    openRemotelessRepo();
  });

  afterEach(() => {
    repositoryStore.getState().reset();
  });

  it('re-reads the remotes when .git/config changes', async () => {
    const el = shellWatchingRepo();

    configChanged(el);

    await waitUntil(() => remoteReads() === 1, 'the config change asks git for the remotes');
    await waitUntil(() => storedRemotes().length === 1, 'and the answer reaches the store');
  });

  it('lifts the refusal a remote added outside the app has already remedied', async () => {
    // The user-visible half: `knownToHaveNoRemote` is what greys out the six
    // buttons and what the runner behind the shortcuts, the palette and the
    // native menu refuses on. Without this the refusal outlived its own
    // remedy — the dialog its toast offers listed the remote the app went on
    // saying did not exist.
    const el = shellWatchingRepo();
    expect(
      knownToHaveNoRemote(repositoryStore.getState().getActiveRepository()),
      'refused to begin with',
    ).to.equal(true);

    configChanged(el);

    await waitUntil(
      () => !knownToHaveNoRemote(repositoryStore.getState().getActiveRepository()),
      'the operation is available again',
    );
  });

  it('collapses a burst of config writes into one read', async () => {
    // git rewrites .git/config for a great many operations, and the watcher
    // reports every one of them.
    const el = shellWatchingRepo();

    configChanged(el);
    configChanged(el);
    configChanged(el);
    await waitUntil(() => remoteReads() === 1, 'the remotes are read');
    await settle();

    expect(remoteReads(), 'and read exactly once for the burst').to.equal(1);
  });

  // Two guards stand between a closed tab and a read it no longer wants:
  // `teardownRepoServices` cancels the pending timer, and the timer callback
  // re-checks `watchedRepoPaths` before reading. Either alone hides the loss of
  // the other, so each is pinned here with the other one out of the way.

  it('cancels the pending remotes read when the tab is closed', async () => {
    // Drives the real close path, in the real order, so the teardown's timer
    // cleanup is what decides this — not the test rewriting `watchedRepoPaths`
    // itself, which the timer callback's own check would then have answered.
    const el = shellWatchingRepo();

    configChanged(el);
    expect((el as any).remotesReloadTimers.has(REPO), 'a read is pending').to.equal(true);

    closeRepoTab(el, REPO);

    expect(
      (el as any).remotesReloadTimers.has(REPO),
      'teardownRepoServices cancels it rather than leaving a timer behind',
    ).to.equal(false);
    await settle();
    expect(remoteReads(), 'the pending read went with the tab').to.equal(0);
  });

  it('refuses a scheduled read for a repository nobody watches any more', async () => {
    // The other half, deliberately belt-and-braces: a reload scheduled AFTER
    // the teardown has run has no timer left for it to cancel. That is a real
    // arrival order — `teardownRepoServices` asks the backend to stop watching
    // fire-and-forget, so an event already in flight still lands — and the
    // callback's own `watchedRepoPaths` check is all that stops it.
    const el = shellWatchingRepo();

    (el as any).scheduleRemotesReload(REPO);
    (el as any).watchedRepoPaths = new Set<string>();
    await settle();

    expect(remoteReads(), 'a repository nobody watches is not read').to.equal(0);
  });

  it('leaves a background repository to the stale-tab path it already had', async () => {
    // Events for a repo that is not active are marked stale and refreshed on
    // activation; that path already re-reads the remotes, and doing it here
    // as well would read them twice for every background config write.
    const el = shellWatchingRepo();
    (el as any).watchedRepoPaths = new Set([REPO, '/repo/two']);

    configChanged(el, '/repo/two');
    await settle();

    expect(remoteReads()).to.equal(0);
    expect((el as any).staleRepoPaths.has('/repo/two'), 'it is marked stale instead').to.equal(
      true,
    );
  });
});
