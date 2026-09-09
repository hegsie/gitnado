/**
 * Multi-repo correctness tests for app-shell:
 * - autofetch results are written per-repo, so a BACKGROUND repo's counts land
 *   on its own tab badge and never under the active tab
 * - remote-update toasts must name the repo they belong to
 * - watcher events for background repos mark them stale instead of refreshing
 * - closing a repo tears down its watcher and search index
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
const invokeCallArgs: Array<{ command: string; args: Record<string, unknown> }> = [];
// Per-command mock responses; commands without a handler resolve to null
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
import { dialogs, DIALOG_REGISTRY, type DialogId } from '../stores/dialog.store.ts';
import { uiStore, repositoryStore, settingsStore } from '../stores/index.ts';
import { searchIndexService } from '../services/search-index.service.ts';
import type { Repository } from '../types/git.types.ts';

function createAppShell(): AppShell {
  return document.createElement('lv-app-shell') as AppShell;
}

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
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function mockBranch(aheadBehind?: { ahead: number; behind: number }) {
  return {
    name: 'main',
    shorthand: 'main',
    isHead: true,
    isRemote: false,
    upstream: 'origin/main',
    targetOid: 'abc',
    isStale: false,
    ...(aheadBehind ? { aheadBehind } : {}),
  };
}

/** Seed an OPEN repo with a current branch so ahead/behind has somewhere to land. */
function seedRepo(path: string, name: string, aheadBehind?: { ahead: number; behind: number }) {
  repositoryStore.getState().addRepository(mockRepo(path, name));
  repositoryStore.getState().updateRepoData(path, { currentBranch: mockBranch(aheadBehind) as any });
}

/** The status bar's ↑/↓ spans, if rendered. */
function statusBadges(el: AppShell) {
  const footer = el.shadowRoot!.querySelector('footer.status-bar');
  return {
    ahead: footer?.querySelector('.status-ahead') ?? null,
    behind: footer?.querySelector('.status-behind') ?? null,
  };
}

function aheadBehindOf(path: string) {
  return repositoryStore
    .getState()
    .openRepositories.find((r) => r.repository.path === path)?.currentBranch?.aheadBehind;
}

/**
 * Make a REAL dialog element in app-shell's shadow root look open and pinned
 * to `pinnedTo`, optionally with work in flight, and report whether the sweep
 * dismissed it.
 *
 * Stubbing the @query field with a plain object instead would be vacuous: the
 * sweep discovers dialogs from the DOM via `pinnedRepositoryPathIfOpen`.
 */
function stubPinnedDialog(
  el: AppShell,
  tag: string,
  pinnedTo: string | null,
  operationInFlight = false
): { closed: () => boolean } {
  const dialog = el.shadowRoot!.querySelector(tag);
  expect(dialog, `${tag} is rendered`).to.exist;
  let closed = false;
  Object.defineProperty(dialog!, 'pinnedRepositoryPathIfOpen', {
    configurable: true,
    get: () => pinnedTo,
  });
  Object.defineProperty(dialog!, 'operationInFlight', {
    configurable: true,
    get: () => operationInFlight,
  });
  (dialog as unknown as { close: () => void }).close = () => {
    closed = true;
  };
  return { closed: () => closed };
}


// Which dialogs are open is module state, and several tests here drive a shell
// that is never connected to the document (so its connectedCallback reset never
// runs). Clear it per test to keep the isolation each instance used to get for
// free from its own `@state()` flags.
beforeEach(() => {
  dialogs.reset();
});

describe('app-shell multi-repo behavior', () => {
  beforeEach(() => {
    invokeCallArgs.length = 0;
    for (const key of Object.keys(mockResponses)) {
      delete mockResponses[key];
    }
    mockResponses.get_fetch_remote = () => 'origin';
    mockResponses.get_remotes = () => [
      { name: 'origin', url: 'https://github.com/example/repo.git', pushUrl: null },
    ];
    uiStore.setState({ toasts: [] });
    repositoryStore.getState().reset();
    searchIndexService.invalidate();
  });

  // Both remote badges (tab bar and status bar) render the store's
  // currentBranch.aheadBehind, so these assert on that one field.
  describe('autofetch badge scoping', () => {
    it("updates the ACTIVE repo's counts when it fetched", () => {
      const el = createAppShell();
      seedRepo('/repo/active', 'active', { ahead: 0, behind: 0 });
      (el as any).activeRepository = { repository: mockRepo('/repo/active', 'active') };

      (el as any).handleAutoFetchCompleted({
        repoPath: '/repo/active',
        success: true,
        ahead: 1,
        behind: 2,
      });

      expect(aheadBehindOf('/repo/active')).to.deep.equal({ ahead: 1, behind: 2 });
    });

    it("a BACKGROUND repo's result never lands on the active repo", () => {
      const el = createAppShell();
      seedRepo('/repo/active', 'active', { ahead: 0, behind: 0 });
      seedRepo('/repo/background', 'background', { ahead: 0, behind: 0 });
      (el as any).activeRepository = { repository: mockRepo('/repo/active', 'active') };

      (el as any).handleAutoFetchCompleted({
        repoPath: '/repo/background',
        success: true,
        ahead: 9,
        behind: 9,
      });

      expect(aheadBehindOf('/repo/background')).to.deep.equal({ ahead: 9, behind: 9 });
      expect(aheadBehindOf('/repo/active')).to.deep.equal({ ahead: 0, behind: 0 });
    });

    it('ignores failed fetches', () => {
      const el = createAppShell();
      seedRepo('/repo/active', 'active', { ahead: 0, behind: 0 });
      (el as any).activeRepository = { repository: mockRepo('/repo/active', 'active') };

      (el as any).handleAutoFetchCompleted({
        repoPath: '/repo/active',
        success: false,
        ahead: 5,
        behind: 5,
      });

      expect(aheadBehindOf('/repo/active')).to.deep.equal({ ahead: 0, behind: 0 });
    });
  });

  describe('remote-updates toast', () => {
    it('names the repo the commits arrived in', () => {
      const el = createAppShell();

      (el as any).handleRemoteUpdatesAvailable({
        repoPath: '/home/user/projects/api-server',
        behind: 3,
        ahead: 0,
      });

      const toasts = uiStore.getState().toasts;
      expect(toasts.length).to.equal(1);
      expect(toasts[0].message).to.contain('api-server');
      expect(toasts[0].message).to.contain('3 new commits');
    });

    it('uses singular wording for one commit', () => {
      const el = createAppShell();

      (el as any).handleRemoteUpdatesAvailable({
        repoPath: '/home/user/projects/api-server',
        behind: 1,
        ahead: 0,
      });

      const toasts = uiStore.getState().toasts;
      expect(toasts[0].message).to.contain('1 new commit available');
    });
  });

  /** start_auto_fetch now resolves a credential token first, so the invoke
   * lands a microtask later than a bare `setTimeout(0)` observes. */
  const waitForCommand = async (command: string): Promise<{ command: string; args: any } | undefined> => {
    // Generous, because it returns the instant the call lands: the whole
    // budget is only ever spent on a genuine failure. A tight one flaked when
    // the full suite ran the browser under load.
    for (let i = 0; i < 200; i++) {
      const call = invokeCallArgs.find((c) => c.command === command);
      if (call) return call;
      await new Promise((r) => setTimeout(r, 10));
    }
    return undefined;
  };

  describe('auto-fetch lifecycle across open repos', () => {
    it('starts auto-fetch for newly opened repos when an interval is set', async () => {
      settingsStore.setState({ autoFetchInterval: 5 });
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));

        const startCall = await waitForCommand('start_auto_fetch');
        expect(startCall).to.not.be.undefined;
        expect(startCall!.args.path).to.equal('/repo/one');
      } finally {
        el.remove();
        settingsStore.setState({ autoFetchInterval: 0 });
      }
    });

    it('does not start auto-fetch when the interval is disabled', async () => {
      settingsStore.setState({ autoFetchInterval: 0 });
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
        await new Promise((r) => setTimeout(r, 0));

        expect(invokeCallArgs.find((c) => c.command === 'start_auto_fetch')).to.be.undefined;
      } finally {
        el.remove();
      }
    });

    it('does not restart auto-fetch timers on unrelated settings changes', async () => {
      // Regression: every settings write (theme, tray, ...) restarted every
      // repo's fetch timer, indefinitely deferring the first fetch for users
      // who tweak settings often.
      settingsStore.setState({ autoFetchInterval: 5 });
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
        // Let the initial start land before clearing, or its late arrival reads
        // as a restart triggered by the settings write below.
        await waitForCommand('start_auto_fetch');
        invokeCallArgs.length = 0;

        settingsStore.setState({ minimizeToTray: true });
        await new Promise((r) => setTimeout(r, 0));
        expect(invokeCallArgs.find((c) => c.command === 'start_auto_fetch')).to.be.undefined;

        // An ACTUAL interval change does restart
        settingsStore.setState({ autoFetchInterval: 10 });
        const startCall = await waitForCommand('start_auto_fetch');
        expect(startCall).to.not.be.undefined;
        expect(startCall!.args.intervalMinutes).to.equal(10);
      } finally {
        el.remove();
        settingsStore.setState({ autoFetchInterval: 0, minimizeToTray: false });
      }
    });

    it('turning offline mode on stops the running loops', async () => {
      // The gate only guarded the START call; the loop it started is a Tokio
      // task with no re-check, so it kept fetching every N minutes after the
      // user went offline.
      settingsStore.setState({ autoFetchInterval: 5, offlineMode: false });
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
        await waitForCommand('start_auto_fetch');
        invokeCallArgs.length = 0;

        settingsStore.setState({ offlineMode: true });
        const stopCall = await waitForCommand('stop_auto_fetch');

        expect(stopCall, 'the running loop is stopped').to.not.be.undefined;
        expect(stopCall!.args.path).to.equal('/repo/one');
      } finally {
        el.remove();
        settingsStore.setState({ autoFetchInterval: 0, offlineMode: false });
      }
    });

    it('turning offline mode back off restarts auto-fetch', async () => {
      // Without this the repo stayed dead until the interval changed or the app
      // restarted, with no indication.
      settingsStore.setState({ autoFetchInterval: 5, offlineMode: true });
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
        await new Promise((r) => setTimeout(r, 20));
        invokeCallArgs.length = 0;

        settingsStore.setState({ offlineMode: false });
        const startCall = await waitForCommand('start_auto_fetch');

        expect(startCall, 'auto-fetch resumes').to.not.be.undefined;
        expect(startCall!.args.intervalMinutes).to.equal(5);
      } finally {
        el.remove();
        settingsStore.setState({ autoFetchInterval: 0, offlineMode: false });
      }
    });

    it('stops auto-fetch when a repo tab is closed', async () => {
      settingsStore.setState({ autoFetchInterval: 5 });
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
        repositoryStore.getState().addRepository(mockRepo('/repo/two', 'two'));
        // Wait for the START to land, not a fixed macrotask: stops are queued
        // behind the in-flight start for the same repo, and that start resolves
        // a remote, a URL and a credential first. A `setTimeout(0)` here beat
        // the stop to the assertion whenever the machine was loaded.
        await waitForCommand('start_auto_fetch');
        invokeCallArgs.length = 0;

        repositoryStore.getState().removeRepository('/repo/one');

        const stopCall = await waitForCommand('stop_auto_fetch');
        expect(stopCall).to.not.be.undefined;
        expect(stopCall!.args.path).to.equal('/repo/one');
      } finally {
        el.remove();
        settingsStore.setState({ autoFetchInterval: 0 });
      }
    });

    /** Lifecycle commands in the order the backend saw them. */
    const lifecycleOrder = () =>
      invokeCallArgs
        .filter((c) =>
          ['start_auto_fetch', 'stop_auto_fetch', 'trigger_auto_fetch'].includes(c.command)
        )
        .map((c) => c.command);

    it('restarts every open repo when the remote allowlist changes', async () => {
      // The allowlist decides which remotes the loop may reach, and the loop
      // is a Tokio task with no re-check — so a running loop must be torn down
      // and re-approved, not left running under the old decision.
      settingsStore.setState({ autoFetchInterval: 5, remoteAllowlist: [] });
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
        await waitForCommand('start_auto_fetch');
        invokeCallArgs.length = 0;

        settingsStore.setState({ remoteAllowlist: ['github.com'] });
        await waitForCommand('start_auto_fetch');

        expect(lifecycleOrder()).to.deep.equal(['stop_auto_fetch', 'start_auto_fetch']);
      } finally {
        el.remove();
        settingsStore.setState({ autoFetchInterval: 0, remoteAllowlist: [] });
      }
    });

    it('restarts and immediately triggers a fetch when the fetch remote changed', async () => {
      // A branch switch can move the fetch destination. The backend refuses to
      // reuse credentials authorized for the old remote and reports
      // FETCH_REMOTE_CHANGED; the frontend must re-run permission and token
      // resolution and then fetch NOW, or the badge stays stale for a full
      // interval.
      settingsStore.setState({ autoFetchInterval: 5 });
      const el = createAppShell();
      seedRepo('/repo/one', 'one');
      try {
        (el as any).handleAutoFetchCompleted({
          repoPath: '/repo/one',
          success: false,
          ahead: 0,
          behind: 0,
          message: 'FETCH_REMOTE_CHANGED',
        });

        const trigger = await waitForCommand('trigger_auto_fetch');
        expect(trigger!.args.path).to.equal('/repo/one');
        expect(lifecycleOrder()).to.deep.equal(['start_auto_fetch', 'trigger_auto_fetch']);
        expect(uiStore.getState().toasts, 'a remote change is not a failure to report').to.have
          .length(0);
      } finally {
        settingsStore.setState({ autoFetchInterval: 0 });
      }
    });

    it('reports and clears the loop when the fetch-remote restart fails', async () => {
      // The backend keeps its loop parked on the timer after
      // FETCH_REMOTE_CHANGED. If the restart cannot re-approve it — here the
      // branch's upstream remote is gone — the old loop would re-report the
      // same change every interval, forever, with the badge frozen and nothing
      // shown to the user.
      settingsStore.setState({ autoFetchInterval: 5 });
      mockResponses.get_remotes = () => [];
      const el = createAppShell();
      seedRepo('/repo/one', 'one');
      try {
        (el as any).handleAutoFetchCompleted({
          repoPath: '/repo/one',
          success: false,
          ahead: 0,
          behind: 0,
          message: 'FETCH_REMOTE_CHANGED',
        });

        const stopCall = await waitForCommand('stop_auto_fetch');
        expect(stopCall, 'the loop that cannot be restarted is torn down').to.not.be.undefined;
        expect(stopCall!.args.path).to.equal('/repo/one');
        expect(
          invokeCallArgs.find((c) => c.command === 'start_auto_fetch'),
          'the refused start never reached the backend'
        ).to.be.undefined;

        const toast = uiStore.getState().toasts.find((t) => t.message.includes('auto-fetch failed'));
        expect(toast, 'the user is told the ahead/behind counts are stale').to.not.be.undefined;
        expect(toast!.message).to.contain('one');
      } finally {
        settingsStore.setState({ autoFetchInterval: 0 });
      }
    });

    it('does not restart a fetch-remote change for a repo that is no longer open', async () => {
      settingsStore.setState({ autoFetchInterval: 5 });
      const el = createAppShell();
      try {
        (el as any).handleAutoFetchCompleted({
          repoPath: '/repo/closed',
          success: false,
          ahead: 0,
          behind: 0,
          message: 'FETCH_REMOTE_CHANGED',
        });
        await new Promise((r) => setTimeout(r, 20));

        expect(lifecycleOrder(), 'a closed repo has no loop to revive').to.deep.equal([]);
      } finally {
        settingsStore.setState({ autoFetchInterval: 0 });
      }
    });

    it('does not restart a fetch-remote change while offline, or with no interval', async () => {
      const el = createAppShell();
      seedRepo('/repo/one', 'one');
      const event = {
        repoPath: '/repo/one',
        success: false,
        ahead: 0,
        behind: 0,
        message: 'FETCH_REMOTE_CHANGED',
      };
      try {
        settingsStore.setState({ autoFetchInterval: 5, offlineMode: true });
        (el as any).handleAutoFetchCompleted(event);
        await new Promise((r) => setTimeout(r, 20));
        expect(lifecycleOrder(), 'offline mode must not start a fetch loop').to.deep.equal([]);

        settingsStore.setState({ autoFetchInterval: 0, offlineMode: false });
        (el as any).handleAutoFetchCompleted(event);
        await new Promise((r) => setTimeout(r, 20));
        expect(lifecycleOrder(), 'auto-fetch turned off must stay off').to.deep.equal([]);
      } finally {
        settingsStore.setState({ autoFetchInterval: 0, offlineMode: false });
      }
    });

    it('a stop issued before a start resolves leaves the repo stopped', async () => {
      // `startAutoFetch` resolves the remote, its URL and a credential before
      // it reaches the backend. A stop that lands inside that window — closing
      // a tab, or going offline — must supersede it, not be overtaken by a
      // start that was already obsolete when it was issued.
      const el = createAppShell();
      seedRepo('/repo/one', 'one');

      (el as any).startAutoFetchLogged('/repo/one', 5);
      (el as any).stopAutoFetchLogged('/repo/one');

      await waitForCommand('stop_auto_fetch');
      await new Promise((r) => setTimeout(r, 20));

      expect(
        invokeCallArgs.find((c) => c.command === 'start_auto_fetch'),
        'the superseded start must never reach the backend'
      ).to.be.undefined;
      expect(lifecycleOrder()).to.deep.equal(['stop_auto_fetch']);
    });

    it('stays quiet when a superseded fetch-remote restart fails', async () => {
      // The restart's own resolution is several IPC round trips long, and the
      // user can close the tab (or a newer start can be issued) inside that
      // window. Reporting the failure then toasts about a repo that is already
      // gone and tears down a loop the supersession owns — so the failure
      // branch has to check the sequence exactly as the success branch does.
      settingsStore.setState({ autoFetchInterval: 5 });
      const el = createAppShell();
      seedRepo('/repo/one', 'one');
      try {
        // The supersession has to land WHILE the restart is resolving, which
        // is the only window that can go wrong: `get_remotes` is one of the
        // round trips `startAutoFetch` makes before it reaches the backend.
        // Returning nothing then fails that restart.
        mockResponses.get_remotes = () => {
          (el as any).stopAutoFetchLogged('/repo/one');
          return [];
        };

        (el as any).startAutoFetchLogged('/repo/one', 5, true);

        await waitForCommand('stop_auto_fetch');
        await new Promise((r) => setTimeout(r, 20));

        expect(
          uiStore.getState().toasts.filter((t) => t.message.includes('auto-fetch failed')),
          'a superseded restart must not report its failure'
        ).to.have.length(0);
        expect(
          lifecycleOrder(),
          'only the supersession stops the loop — the dead restart must not stop it again'
        ).to.deep.equal(['stop_auto_fetch']);
      } finally {
        settingsStore.setState({ autoFetchInterval: 0 });
      }
    });
  });

  describe('background autofetch results update tab badge data', () => {
    it("writes a background repo's ahead/behind into the store", () => {
      const el = createAppShell();
      repositoryStore.getState().addRepository(mockRepo('/repo/bg', 'bg'));
      repositoryStore.getState().updateRepoData('/repo/bg', {
        currentBranch: {
          name: 'main',
          shorthand: 'main',
          isHead: true,
          isRemote: false,
          upstream: 'origin/main',
          targetOid: 'abc',
          isStale: false,
        },
      });
      (el as any).activeRepository = { repository: mockRepo('/repo/active', 'active') };

      (el as any).handleAutoFetchCompleted({
        repoPath: '/repo/bg',
        success: true,
        ahead: 3,
        behind: 7,
      });

      const bg = repositoryStore.getState().openRepositories[0];
      expect(bg.currentBranch?.aheadBehind).to.deep.equal({ ahead: 3, behind: 7 });
    });
  });

  describe('badge hydration throttling', () => {
    it('caps concurrent hydrations instead of firing one per repo at once', async () => {
      let releaseStatuses!: () => void;
      const statusGate = new Promise<void>((resolve) => {
        releaseStatuses = resolve;
      });
      mockResponses['get_status'] = () => statusGate.then(() => []);
      mockResponses['get_branches'] = () => statusGate.then(() => []);

      const el = createAppShell();
      document.body.appendChild(el);
      try {
        for (let i = 0; i < 5; i++) {
          repositoryStore
            .getState()
            .addRepository(mockRepo(`/repo/${i}`, `r${i}`), { activate: false });
        }
        await new Promise((r) => setTimeout(r, 10));

        // Only 2 hydrations (one get_status each) may be in flight at once
        const inFlight = invokeCallArgs.filter((c) => c.command === 'get_status').length;
        expect(inFlight).to.equal(2);

        releaseStatuses();
        await waitUntil(
          () => invokeCallArgs.filter((c) => c.command === 'get_status').length === 5,
          'expected the queue to drain all five hydrations'
        );
      } finally {
        el.remove();
      }
    });
  });

  describe('batch tab open (workspace-style)', () => {
    it('runs activation work only for the repo activated at the end', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        searchIndexService.invalidate();
        // Open three repos the way workspace-open now does
        for (const p of ['/ws/one', '/ws/two', '/ws/three']) {
          repositoryStore.getState().addRepository(mockRepo(p, p), { activate: false });
        }
        repositoryStore.getState().setActiveByPath('/ws/three');
        await new Promise((r) => setTimeout(r, 10));

        const buildPaths = invokeCallArgs
          .filter((c) => c.command === 'build_search_index')
          .map((c) => c.args.path);
        expect(buildPaths).to.deep.equal(['/ws/three']);
      } finally {
        el.remove();
      }
    });
  });

  describe('tab close teardown extras', () => {
    it('cancels an in-flight embedding build for the closed repo', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
        repositoryStore.getState().addRepository(mockRepo('/repo/two', 'two'));
        await new Promise((r) => setTimeout(r, 0));
        invokeCallArgs.length = 0;

        repositoryStore.getState().removeRepository('/repo/one');
        await new Promise((r) => setTimeout(r, 0));

        const cancelCall = invokeCallArgs.find((c) => c.command === 'cancel_embedding_build');
        expect(cancelCall).to.not.be.undefined;
        expect(cancelCall!.args.path).to.equal('/repo/one');
      } finally {
        el.remove();
      }
    });

    it('disconnect tears down the SAME per-repo services as closing a tab', async () => {
      // Regression: disconnectedCallback used to stop only the watcher and
      // auto-fetch, leaking commit indexes and in-flight embedding builds on
      // remount. It now runs the same teardown as a tab close.
      const el = createAppShell();
      document.body.appendChild(el);
      repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
      await new Promise((r) => setTimeout(r, 0));
      invokeCallArgs.length = 0;

      el.remove(); // triggers disconnectedCallback
      await new Promise((r) => setTimeout(r, 0));

      const cmds = invokeCallArgs.map((c) => c.command);
      expect(cmds).to.include('stop_watching');
      expect(cmds).to.include('cancel_embedding_build');
      expect(cmds).to.include('stop_auto_fetch');
    });
  });

  describe('lazy embedding build guard', () => {
    it('does not start an embedding build for a repo closed during getStatus', async () => {
      // Regression: a close landing during ensureRepoIndexes' getStatus
      // round-trip could still launch a multi-minute ONNX build for a gone
      // repo (cancelBuild can't cancel a build that hadn't started).
      let releaseStatus!: (v: unknown) => void;
      mockResponses['get_embedding_index_status'] = () =>
        new Promise((resolve) => {
          releaseStatus = resolve;
        });

      const el = createAppShell();
      (el as any).activeRepository = { repository: mockRepo('/repo/one', 'one') };
      // repo is NOT in the store → treated as closed when status resolves
      (el as any).ensureRepoIndexes('/repo/one');
      await new Promise((r) => setTimeout(r, 0));
      invokeCallArgs.length = 0;

      releaseStatus({ isReady: false, isBuilding: false, indexedCommits: 0, totalCommits: 0 });
      await new Promise((r) => setTimeout(r, 0));

      expect(invokeCallArgs.find((c) => c.command === 'build_embedding_index')).to.be.undefined;
    });
  });

  describe('active repo badge liveness', () => {
    it('schedules a badge refresh for the ACTIVE repo when the right panel is hidden', () => {
      const el = createAppShell();
      (el as any).activeRepository = { repository: mockRepo('/repo/active', 'active') };
      (el as any).watchedRepoPaths = new Set(['/repo/active']);
      (el as any).rightPanelVisible = false;

      (el as any).handleWatcherEvent({
        repoPath: '/repo/active',
        eventType: 'workdir-changed',
        paths: [],
      });

      expect((el as any).badgeHydrationTimers.has('/repo/active')).to.be.true;
      // Cleanup the pending timer
      clearTimeout((el as any).badgeHydrationTimers.get('/repo/active'));
    });

    it('skips the badge refresh while the right panel is mounted (it already mirrors status)', () => {
      const el = createAppShell();
      (el as any).activeRepository = { repository: mockRepo('/repo/active', 'active') };
      (el as any).watchedRepoPaths = new Set(['/repo/active']);
      (el as any).rightPanelVisible = true;

      (el as any).handleWatcherEvent({
        repoPath: '/repo/active',
        eventType: 'workdir-changed',
        paths: [],
      });

      expect((el as any).badgeHydrationTimers.has('/repo/active')).to.be.false;
    });
  });

  describe('status-bar ahead/behind badge on tab switch', () => {
    it("follows the newly active repo's counts", async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'));
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        repositoryStore.getState().updateRepoData('/repo/a', {
          currentBranch: mockBranch({ ahead: 0, behind: 3 }) as any,
        });

        repositoryStore.getState().setActiveIndex(0);
        await waitUntil(
          () => statusBadges(el).behind?.textContent?.includes('3') === true,
          "repo A's counts reach the status bar",
        );

        // Switching to a repo with no known counts clears the badge instead
        // of showing the previous repo's numbers
        repositoryStore.getState().setActiveIndex(1);
        await waitUntil(
          () => !statusBadges(el).behind && !statusBadges(el).ahead,
          "repo A's counts do not paint under repo B",
        );
      } finally {
        el.remove();
      }
    });
  });

  describe('tab badge hydration', () => {
    const oneBranch = [
      {
        name: 'main',
        shorthand: 'main',
        isHead: true,
        isRemote: false,
        upstream: 'origin/main',
        targetOid: 'abc',
        isStale: false,
      },
    ];

    it('hydrates BOTH status and branches for a background repo', async () => {
      mockResponses['get_status'] = () => [
        { path: 'a.txt', status: 'modified', isStaged: false, isConflicted: false },
      ];
      mockResponses['get_branches'] = () => oneBranch;

      const el = createAppShell();
      document.body.appendChild(el);
      try {
        // Open the way restore/workspace does: activate: false keeps /repo/bg
        // a background tab that is never transiently active.
        repositoryStore.getState().addRepository(mockRepo('/repo/active', 'active'));
        repositoryStore.getState().addRepository(mockRepo('/repo/bg', 'bg'), { activate: false });
        await waitUntil(
          () => {
            const bg = repositoryStore
              .getState()
              .openRepositories.find((r) => r.repository.path === '/repo/bg');
            return !!bg && bg.status.length > 0;
          },
          'expected the background repo status to be hydrated'
        );

        const bg = repositoryStore
          .getState()
          .openRepositories.find((r) => r.repository.path === '/repo/bg')!;
        expect(bg.status.length).to.equal(1);
        expect(bg.unstagedFiles.length).to.equal(1);
        // Background repos have no mounted branch list — hydration supplies it
        expect(bg.currentBranch?.name).to.equal('main');
      } finally {
        el.remove();
      }
    });

    it('hydrates status but NOT branches for the active repo (the branch list owns branches)', async () => {
      // Drive hydrateRepoBadges directly on a disconnected shell so only the
      // hydration path runs (a mounted branch list would also call
      // get_branches, masking whether hydration itself skips it).
      let branchCalls = 0;
      mockResponses['get_status'] = () => [
        { path: 'a.txt', status: 'modified', isStaged: false, isConflicted: false },
      ];
      mockResponses['get_branches'] = () => {
        branchCalls++;
        return oneBranch;
      };

      repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
      const el = createAppShell();
      (el as any).activeRepository = { repository: mockRepo('/repo/one', 'one') };

      await (el as any).hydrateRepoBadges('/repo/one');

      const repo = repositoryStore.getState().openRepositories[0];
      expect(repo.status.length).to.equal(1);
      // Active repo's branches come from the branch list, not hydration
      expect(branchCalls).to.equal(0);
      expect(invokeCallArgs.some((c) => c.command === 'get_status')).to.be.true;
    });
  });

  describe('search filter does not leak across tab switches', () => {
    it("clears the graph canvas's searchFilter when the active repo changes", async () => {
      // Regression: the canvas searchFilter was set imperatively and never
      // bound in the template, so a tab switch left it holding the previous
      // repo's filter — dimming the new repo's graph for a query never
      // applied to it. It's now a reactive `.searchFilter` binding cleared
      // by app-shell's repo-change handler.
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'));
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        repositoryStore.getState().setActiveByPath('/repo/a');
        await el.updateComplete;

        // Apply a filter on repo A
        (el as any).handleSearchChange(
          new CustomEvent('search-change', {
            detail: { filter: { query: 'wip', author: '', dateFrom: '', dateTo: '', filePath: '', branch: '', searchMode: 'keyword' } },
          })
        );
        await el.updateComplete;
        const canvas = el.shadowRoot!.querySelector('lv-graph-canvas') as unknown as {
          searchFilter: unknown;
        };
        expect(canvas.searchFilter, 'filter applied to active repo').to.not.be.null;

        // Switch to repo B — the binding must clear the canvas filter
        repositoryStore.getState().setActiveByPath('/repo/b');
        await el.updateComplete;
        expect((el as any).searchFilter, 'app-shell clears its filter on switch').to.be.null;
        expect(canvas.searchFilter, 'canvas filter cleared via binding').to.be.null;
      } finally {
        el.remove();
      }
    });
  });

  describe('watcher lifecycle across open repos', () => {
    it('starts a watcher for every opened repo, not just the active one', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
        repositoryStore.getState().addRepository(mockRepo('/repo/two', 'two'));
        await new Promise((r) => setTimeout(r, 0));

        const watched = invokeCallArgs
          .filter((c) => c.command === 'start_watching')
          .map((c) => c.args.path);
        expect(watched).to.include('/repo/one');
        expect(watched).to.include('/repo/two');
      } finally {
        el.remove();
      }
    });

    it('closing a repo stops its watcher and drops its search index', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
        repositoryStore.getState().addRepository(mockRepo('/repo/two', 'two'));
        await new Promise((r) => setTimeout(r, 0));
        invokeCallArgs.length = 0;

        repositoryStore.getState().removeRepository('/repo/one');
        await new Promise((r) => setTimeout(r, 0));

        const stopCall = invokeCallArgs.find((c) => c.command === 'stop_watching');
        expect(stopCall).to.not.be.undefined;
        expect(stopCall!.args.path).to.equal('/repo/one');

        const dropCall = invokeCallArgs.find((c) => c.command === 'drop_search_index');
        expect(dropCall).to.not.be.undefined;
        expect(dropCall!.args.path).to.equal('/repo/one');
      } finally {
        el.remove();
      }
    });
  });

  describe('startup restore', () => {
    afterEach(() => {
      settingsStore.setState({ openLastRepository: true });
    });

    it('opens every persisted repo but builds indexes only for the active one', async () => {
      mockResponses['open_repository'] = (args) => mockRepo(args.path as string, 'restored');
      repositoryStore.setState({
        persistedOpenRepos: [
          { path: '/repo/one', name: 'one' },
          { path: '/repo/two', name: 'two' },
          { path: '/repo/three', name: 'three' },
        ],
      });

      const el = createAppShell();
      document.body.appendChild(el);
      try {
        await waitUntil(
          () => repositoryStore.getState().openRepositories.length === 3,
          'expected all three persisted repos to be restored'
        );
        // Allow post-restore async work (remotes, index kick-off) to settle
        await new Promise((r) => setTimeout(r, 50));

        const openedPaths = invokeCallArgs
          .filter((c) => c.command === 'open_repository')
          .map((c) => c.args.path);
        expect(openedPaths).to.have.members(['/repo/one', '/repo/two', '/repo/three']);

        // Index builds are lazy: only the ACTIVE repo (last restored) gets
        // one at startup — a search-index walk plus an embedding pass per
        // background repo made startup CPU-bound with many tabs.
        const buildPaths = invokeCallArgs
          .filter((c) => c.command === 'build_search_index')
          .map((c) => c.args.path);
        expect(buildPaths).to.deep.equal(['/repo/three']);
      } finally {
        el.remove();
      }
    });

    it('restores the tab that was active last session', async () => {
      mockResponses['open_repository'] = (args) => mockRepo(args.path as string, 'restored');
      repositoryStore.setState({
        persistedOpenRepos: [
          { path: '/repo/one', name: 'one' },
          { path: '/repo/two', name: 'two' },
          { path: '/repo/three', name: 'three' },
        ],
        persistedActivePath: '/repo/two',
      });

      const el = createAppShell();
      document.body.appendChild(el);
      try {
        await waitUntil(
          () => repositoryStore.getState().openRepositories.length === 3,
          'expected all three persisted repos to be restored'
        );
        await new Promise((r) => setTimeout(r, 50));

        expect(repositoryStore.getState().activeIndex).to.equal(1);
      } finally {
        el.remove();
      }
    });

    it('reports and prunes repos that fail to restore', async () => {
      mockResponses['open_repository'] = (args) => {
        if (args.path === '/repo/gone') {
          throw new Error('repository not found');
        }
        return mockRepo(args.path as string, 'restored');
      };
      repositoryStore.setState({
        persistedOpenRepos: [
          { path: '/repo/one', name: 'one' },
          { path: '/repo/gone', name: 'gone' },
        ],
      });

      const el = createAppShell();
      document.body.appendChild(el);
      try {
        await waitUntil(
          () => repositoryStore.getState().openRepositories.length === 1,
          'expected the healthy repo to be restored'
        );
        await waitUntil(
          () => uiStore.getState().toasts.length > 0,
          'expected a toast for the failed restore'
        );

        const toasts = uiStore.getState().toasts;
        expect(toasts[0].message).to.contain('gone');
        expect(toasts[0].type).to.equal('error');
        // Pruned: the failure is not silently retried on every launch
        const persisted = repositoryStore.getState().persistedOpenRepos.map((r) => r.path);
        expect(persisted).to.deep.equal(['/repo/one']);
      } finally {
        el.remove();
      }
    });

    it('opens nothing when "Reopen Last Repositories" is off, and keeps the list', async () => {
      mockResponses['open_repository'] = (args) => mockRepo(args.path as string, 'restored');
      settingsStore.setState({ openLastRepository: false });
      repositoryStore.setState({
        persistedOpenRepos: [
          { path: '/repo/one', name: 'one' },
          { path: '/repo/two', name: 'two' },
        ],
        persistedActivePath: '/repo/two',
      });

      const el = createAppShell();
      document.body.appendChild(el);
      try {
        // The restore pass starts synchronously from connectedCallback and the
        // setting guard returns before its first await, so once the first
        // render has completed there is nothing left in flight.
        await el.updateComplete;

        expect(
          invokeCallArgs.filter((c) => c.command === 'open_repository'),
          'no repository is opened — the app starts on the welcome screen'
        ).to.have.length(0);
        expect(repositoryStore.getState().openRepositories).to.have.length(0);
        expect(uiStore.getState().toasts, 'nothing is reported as a failed restore').to.have.length(
          0
        );

        // The remembered tabs must SURVIVE: the toggle is reversible, not a
        // one-way wipe of the session.
        expect(repositoryStore.getState().persistedOpenRepos.map((r) => r.path)).to.deep.equal([
          '/repo/one',
          '/repo/two',
        ]);
        expect(repositoryStore.getState().persistedActivePath).to.equal('/repo/two');
      } finally {
        el.remove();
      }
    });

    it('restores again once the setting is turned back on', async () => {
      mockResponses['open_repository'] = (args) => mockRepo(args.path as string, 'restored');
      settingsStore.setState({ openLastRepository: false });
      repositoryStore.setState({
        persistedOpenRepos: [{ path: '/repo/one', name: 'one' }],
      });

      const off = createAppShell();
      document.body.appendChild(off);
      // As above: the guard has already returned by the first render.
      await off.updateComplete;
      off.remove();
      expect(repositoryStore.getState().openRepositories).to.have.length(0);

      settingsStore.setState({ openLastRepository: true });
      const on = createAppShell();
      document.body.appendChild(on);
      try {
        await waitUntil(
          () => repositoryStore.getState().openRepositories.length === 1,
          'expected the still-persisted repo to be restored once the setting is on'
        );
        expect(
          repositoryStore.getState().openRepositories[0].repository.path
        ).to.equal('/repo/one');
      } finally {
        on.remove();
      }
    });

    it('builds a repo index lazily when its tab is first activated', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
        repositoryStore.getState().addRepository(mockRepo('/repo/two', 'two'));
        await new Promise((r) => setTimeout(r, 0));
        // Simulate repos restored without indexes (the startup path skips
        // background repos' builds)
        searchIndexService.invalidate();
        invokeCallArgs.length = 0;

        repositoryStore.getState().setActiveIndex(0);
        await new Promise((r) => setTimeout(r, 0));

        const buildPaths = invokeCallArgs
          .filter((c) => c.command === 'build_search_index')
          .map((c) => c.args.path);
        expect(buildPaths).to.deep.equal(['/repo/one']);
      } finally {
        el.remove();
      }
    });
  });

  describe('tab cycling shortcuts', () => {
    it('cycles forward and wraps at the end', () => {
      const el = createAppShell();
      repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
      repositoryStore.getState().addRepository(mockRepo('/repo/two', 'two'));
      repositoryStore.getState().addRepository(mockRepo('/repo/three', 'three'));
      // active is 2 (last added)

      (el as any).cycleRepositoryTab(1);
      expect(repositoryStore.getState().activeIndex).to.equal(0);
      (el as any).cycleRepositoryTab(1);
      expect(repositoryStore.getState().activeIndex).to.equal(1);
    });

    it('cycles backward and wraps at the start', () => {
      const el = createAppShell();
      repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
      repositoryStore.getState().addRepository(mockRepo('/repo/two', 'two'));
      repositoryStore.getState().setActiveIndex(0);

      (el as any).cycleRepositoryTab(-1);
      expect(repositoryStore.getState().activeIndex).to.equal(1);
    });

    it('is a no-op with fewer than two repos', () => {
      const el = createAppShell();
      repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));

      (el as any).cycleRepositoryTab(1);
      expect(repositoryStore.getState().activeIndex).to.equal(0);
    });
  });

  describe('background repo staleness', () => {
    it('marks a background repo stale on watcher events instead of refreshing it', () => {
      const el = createAppShell();
      (el as any).activeRepository = { repository: mockRepo('/repo/active', 'active') };
      (el as any).watchedRepoPaths = new Set(['/repo/active', '/repo/background']);

      let refreshed = 0;
      (el as any).handleRefresh = () => {
        refreshed++;
        return Promise.resolve();
      };

      (el as any).handleWatcherEvent({
        repoPath: '/repo/background',
        eventType: 'refs-changed',
        paths: [],
      });

      expect(refreshed).to.equal(0);
      expect((el as any).staleRepoPaths.has('/repo/background')).to.be.true;
    });

    it('debounce-refreshes when the ACTIVE repo has ref changes', async () => {
      const el = createAppShell();
      (el as any).activeRepository = { repository: mockRepo('/repo/active', 'active') };

      let refreshed = 0;
      (el as any).handleRefresh = () => {
        refreshed++;
        return Promise.resolve();
      };

      (el as any).handleWatcherEvent({
        repoPath: '/repo/active',
        eventType: 'refs-changed',
        paths: [],
      });

      // refs-changed refresh is debounced by 200ms
      await new Promise((r) => setTimeout(r, 250));
      expect(refreshed).to.equal(1);
    });

    it('refreshes a stale repo when its tab becomes active', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        let refreshed = 0;
        (el as any).handleRefresh = () => {
          refreshed++;
          return Promise.resolve();
        };

        repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
        repositoryStore.getState().addRepository(mockRepo('/repo/two', 'two'));
        await new Promise((r) => setTimeout(r, 0));

        // Repo one changes while it's a background tab
        (el as any).handleWatcherEvent({
          repoPath: '/repo/one',
          eventType: 'refs-changed',
          paths: [],
        });
        expect(refreshed).to.equal(0);

        // Activating repo one triggers exactly one refresh and clears staleness
        repositoryStore.getState().setActiveIndex(0);
        await new Promise((r) => setTimeout(r, 0));
        expect(refreshed).to.equal(1);
        expect((el as any).staleRepoPaths.has('/repo/one')).to.be.false;

        // Switching back and forth again without new events does NOT re-refresh
        repositoryStore.getState().setActiveIndex(1);
        repositoryStore.getState().setActiveIndex(0);
        await new Promise((r) => setTimeout(r, 0));
        expect(refreshed).to.equal(1);
      } finally {
        el.remove();
      }
    });
  });

  describe('handleRefresh tab-switch race', () => {
    it('does not write refreshed data into a different tab if the user switches during the IPC await', async () => {
      repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'));
      repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
      repositoryStore.getState().setActiveIndex(0);

      const el = createAppShell();
      document.body.appendChild(el);
      try {
        (el as any).activeRepository = { repository: mockRepo('/repo/a', 'a') };

        // Defer the open_repository resolution so we can switch tabs mid-flight.
        let resolveOpen: (v: unknown) => void = () => {};
        mockResponses['open_repository'] = () =>
          new Promise((res) => {
            resolveOpen = res;
          });

        const refreshPromise = (el as any).handleRefresh();
        await new Promise((r) => setTimeout(r, 0));

        // User switches to repo B while repo A's refresh is still in flight.
        repositoryStore.getState().setActiveIndex(1);

        // Repo A's fetch now resolves with (stale-for-B) repo A data.
        resolveOpen(mockRepo('/repo/a', 'a-refreshed'));
        await refreshPromise;

        // Repo B's tab slot must still hold repo B — not repo A's identity.
        const repoB = repositoryStore.getState().openRepositories[1];
        expect(repoB.repository.path).to.equal('/repo/b');
        expect(repoB.repository.name).to.equal('b');
      } finally {
        el.remove();
      }
    });
  });

  describe('describe → create-tag handoff', () => {
    it('creates the tag in the repo describe was pinned to, not the active tab', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        repositoryStore.getState().setActiveByPath('/repo/a');
        await el.updateComplete;

        const describeDialog = el.shadowRoot!.querySelector('lv-describe-dialog');
        expect(describeDialog, 'describe dialog is rendered').to.exist;

        // Describe was opened on a commit in repo A; the user then switched
        // tabs, which repoints every live `.repositoryPath` binding at B.
        repositoryStore.getState().setActiveByPath('/repo/b');
        await el.updateComplete;

        // "Create a tag here" from describe's empty state.
        describeDialog!.dispatchEvent(
          new CustomEvent('describe-create-tag', {
            detail: { target: 'abc123def456', repositoryPath: '/repo/a' },
            bubbles: true,
            composed: true,
          }),
        );
        await el.updateComplete;

        const tagDialog = el.shadowRoot!.querySelector('lv-create-tag-dialog') as HTMLElement & {
          pinnedRepositoryPathIfOpen: string | null;
          updateComplete: Promise<unknown>;
        };
        expect(tagDialog, 'create-tag dialog is rendered').to.exist;
        await tagDialog.updateComplete;

        // The oid only exists in repo A, so the tag must be created there —
        // tagging it against the active tab would fail, or worse, hit a
        // different commit that happens to share the prefix.
        expect(tagDialog.pinnedRepositoryPathIfOpen).to.equal('/repo/a');

        const input = tagDialog.shadowRoot!.querySelector('#target-input') as
          | HTMLInputElement
          | null;
        expect(input, 'target field is rendered').to.exist;
        expect(input!.value).to.equal('abc123def456');
      } finally {
        el.remove();
      }
    });
  });

  describe('conflict dialog repo pinning', () => {
    it('keeps operating on the repo it was opened for after a tab switch', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        repositoryStore.getState().setActiveByPath('/repo/a');
        await el.updateComplete;

        // Stash-apply conflicts on repo A (clean state) open the dialog.
        (el as any).openConflictDialogFromState();
        await el.updateComplete;
        const dialog = () =>
          el.shadowRoot!.querySelector('lv-conflict-resolution-dialog') as HTMLElement & {
            repositoryPath: string;
          };
        expect(dialog(), 'dialog should open').to.exist;
        expect(dialog().repositoryPath).to.equal('/repo/a');

        // Ctrl+Tab still works behind the full-screen dialog — the dialog
        // must NOT retarget to repo B, or its abort/resolve commands would
        // destroy repo B's unrelated work.
        repositoryStore.getState().setActiveByPath('/repo/b');
        await el.updateComplete;
        expect(dialog(), 'dialog stays open').to.exist;
        expect(dialog().repositoryPath).to.equal('/repo/a');
      } finally {
        el.remove();
      }
    });

    it('refuses to open for a repo whose tab was closed mid-operation', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        await el.updateComplete;

        // The merge ran on repo A; the user closed A's tab during the
        // await. A dialog pinned to a closed repo would float over the
        // wrong screen with dead completion plumbing.
        repositoryStore.getState().removeRepository('/repo/a');
        await el.updateComplete;
        (el as any).handleMergeConflictEvent(
          new CustomEvent('merge-conflict', { detail: { repositoryPath: '/repo/a' } })
        );
        await el.updateComplete;

        expect(dialogs.isOpen('conflict')).to.be.false;
        expect(el.shadowRoot!.querySelector('lv-conflict-resolution-dialog')).to.be.null;
        const toasts = uiStore.getState().toasts;
        expect(toasts.some((t) => t.type === 'warning' && t.message.includes('tab was closed')))
          .to.be.true;
      } finally {
        el.remove();
      }
    });

    it('closing the pinned repo tab while the dialog is OPEN closes it with a warning', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        repositoryStore.getState().setActiveByPath('/repo/a');
        await el.updateComplete;

        (el as any).openConflictDialogFromState();
        await el.updateComplete;
        expect(dialogs.isOpen('conflict')).to.be.true;

        // The user clicks the × on repo A's tab with the dialog up. The
        // dialog must not stay floating over whatever renders next.
        repositoryStore.getState().removeRepository('/repo/a');
        await el.updateComplete;

        expect(dialogs.isOpen('conflict')).to.be.false;
        expect(el.shadowRoot!.querySelector('lv-conflict-resolution-dialog')).to.be.null;
        const toasts = uiStore.getState().toasts;
        expect(
          toasts.some((t) => t.type === 'warning' && t.message.includes('reopen it'))
        ).to.be.true;
      } finally {
        el.remove();
      }
    });

    it('closing an UNRELATED tab leaves the dialog alone', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        repositoryStore.getState().setActiveByPath('/repo/a');
        await el.updateComplete;

        (el as any).openConflictDialogFromState();
        await el.updateComplete;
        repositoryStore.getState().removeRepository('/repo/b');
        await el.updateComplete;

        expect(dialogs.isOpen('conflict')).to.be.true;
      } finally {
        el.remove();
      }
    });

    it('a second conflict event cannot hijack an open dialog', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        repositoryStore.getState().setActiveByPath('/repo/a');
        await el.updateComplete;

        (el as any).openConflictDialogFromState();
        await el.updateComplete;

        // User Ctrl+Tabs to repo B behind the dialog, then a NEW merge
        // conflict fires there. It must not retarget the open dialog's
        // repo or operation — that would aim repo A's picks at repo B.
        repositoryStore.getState().setActiveByPath('/repo/b');
        await el.updateComplete;
        (el as any).handleMergeConflictEvent(new CustomEvent('merge-conflict'));
        await el.updateComplete;

        const dialog = el.shadowRoot!.querySelector(
          'lv-conflict-resolution-dialog'
        ) as HTMLElement & { repositoryPath: string; operationType: string };
        expect(dialog.repositoryPath).to.equal('/repo/a');
        expect(dialog.operationType).to.equal('stash');
        // The refusal is not silent.
        const toasts = uiStore.getState().toasts;
        expect(toasts.some((t) => t.message.includes('already in progress'))).to.be.true;
      } finally {
        el.remove();
      }
    });

    it('a conflict OPENING on a background-tabbed repo refreshes the pinned repo too', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        // The merge ran on repo A, but the user switched to B during its
        // await — the conflict event still carries A's path, and A (not B)
        // must be the repo that gets refreshed.
        repositoryStore.getState().setActiveByPath('/repo/b');
        await el.updateComplete;

        (el as any).handleMergeConflictEvent(
          new CustomEvent('merge-conflict', { detail: { repositoryPath: '/repo/a' } })
        );
        await el.updateComplete;

        expect((el as any).staleRepoPaths.has('/repo/a')).to.be.true;
        const dialog = el.shadowRoot!.querySelector(
          'lv-conflict-resolution-dialog'
        ) as HTMLElement & { repositoryPath: string };
        expect(dialog.repositoryPath).to.equal('/repo/a');
      } finally {
        el.remove();
      }
    });

    it('completing on a background-tabbed repo refreshes the PINNED repo, not the active one', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        repositoryStore.getState().setActiveByPath('/repo/a');
        await el.updateComplete;

        (el as any).openConflictDialogFromState();
        await el.updateComplete;

        // User tabs to B, then completes the operation on pinned repo A.
        repositoryStore.getState().setActiveByPath('/repo/b');
        await el.updateComplete;
        (el as any).handleConflictResolved();
        await el.updateComplete;

        // A is backgrounded — it must be marked stale (refreshed when
        // re-activated) so its tab doesn't keep showing merge state.
        expect((el as any).staleRepoPaths.has('/repo/a')).to.be.true;
        expect(dialogs.isOpen('conflict')).to.be.false;
      } finally {
        el.remove();
      }
    });

    it('does not mark a repository stale once its tab is closed', async () => {
      // A slow operation started on A can land after the user closed A's tab.
      // teardownRepoServices() has already dropped the path; adding it back
      // here left an entry nothing ever removes — it survived the rest of the
      // session, made a later reopen of the same path do a spurious extra
      // refresh, and grew without bound across close/reopen cycles.
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        repositoryStore.getState().setActiveByPath('/repo/b');
        await el.updateComplete;

        // Control: while A is merely backgrounded it does get marked.
        (el as any).refreshConflictDialogRepo('/repo/a');
        expect((el as any).staleRepoPaths.has('/repo/a'), 'open background repo marked').to.be
          .true;
        (el as any).staleRepoPaths.delete('/repo/a');

        repositoryStore.getState().removeRepository('/repo/a');
        await el.updateComplete;

        (el as any).refreshConflictDialogRepo('/repo/a');

        expect(
          (el as any).staleRepoPaths.has('/repo/a'),
          'a closed repo has no tab to refresh and no one to clear the entry',
        ).to.be.false;
      } finally {
        el.remove();
      }
    });

    it('cherry-pick-complete on a background-tabbed repo refreshes the PINNED repo, not the active one', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        // The pick ran on B; the user has tabbed back to A by completion.
        repositoryStore.getState().setActiveByPath('/repo/a');
        await el.updateComplete;

        (el as any).handleCherryPickComplete(
          new CustomEvent('cherry-pick-complete', {
            detail: {
              sourceCommit: { oid: 'abcdef1234567890' },
              noCommit: false,
              repositoryPath: '/repo/b',
            },
          })
        );
        await el.updateComplete;

        expect((el as any).staleRepoPaths.has('/repo/b'), 'pinned repo marked stale').to.be.true;
      } finally {
        el.remove();
      }
    });

    it('a window repository-refresh carrying repoPath pins to that repo (sidebar success paths)', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        repositoryStore.getState().setActiveByPath('/repo/b');
        await el.updateComplete;

        const pinnedCalls: Array<string | null> = [];
        (el as any).refreshConflictDialogRepo = (p: string | null) => pinnedCalls.push(p);
        let plainRefreshCalled = false;
        (el as any).handleRefresh = () => { plainRefreshCalled = true; };

        // A stash/tag/branch success on backgrounded repo A forwards its
        // repo path through the window refresh.
        window.dispatchEvent(
          new CustomEvent('repository-refresh', { detail: { repoPath: '/repo/a' } })
        );
        await el.updateComplete;

        expect(pinnedCalls, 'pinned to the originating repo').to.deep.equal(['/repo/a']);
        expect(plainRefreshCalled, 'not the unpinned active-tab refresh').to.be.false;
      } finally {
        el.remove();
      }
    });

    it('gitflow-operation on a background-tabbed repo refreshes the PINNED repo, not the active one', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        repositoryStore.getState().setActiveByPath('/repo/a');
        await el.updateComplete;

        (el as any).handleGitflowEvent(
          new CustomEvent('gitflow-operation', {
            detail: { type: 'finish-feature', name: 'login', repositoryPath: '/repo/b' },
          })
        );
        await el.updateComplete;

        expect((el as any).staleRepoPaths.has('/repo/b'), 'pinned repo marked stale').to.be.true;
      } finally {
        el.remove();
      }
    });

    it('a successful pull refreshes via the PINNED path, not the unconditional active-tab refresh', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        mockResponses['pull'] = () => null; // success (invokeCommand wraps)
        (el as any).activeRepository = { repository: mockRepo('/repo/a', 'a') };
        // Spy: the fix routes the success path through refreshConflictDialogRepo
        // with the captured repo path, not the unpinned handleRefresh().
        const pinnedCalls: Array<string | null> = [];
        (el as any).refreshConflictDialogRepo = (p: string | null) => pinnedCalls.push(p);
        let plainRefreshCalled = false;
        (el as any).handleRefresh = () => { plainRefreshCalled = true; };

        await (el as any).handlePull();

        expect(pinnedCalls, 'success routes through the pinned refresh').to.deep.equal(['/repo/a']);
        expect(plainRefreshCalled, 'the unpinned handleRefresh is not used').to.be.false;
      } finally {
        el.remove();
      }
    });

    it('a successful branch checkout refreshes via the PINNED path', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        mockResponses['checkout_with_autostash'] = () => ({ success: true });
        (el as any).activeRepository = { repository: mockRepo('/repo/a', 'a') };
        const pinnedCalls: Array<string | null> = [];
        (el as any).refreshConflictDialogRepo = (p: string | null) => pinnedCalls.push(p);
        let plainRefreshCalled = false;
        (el as any).handleRefresh = () => { plainRefreshCalled = true; };

        await (el as any).handleCheckoutBranch(
          new CustomEvent('checkout-branch', {
            detail: { branch: 'feature', repositoryPath: '/repo/a' },
          })
        );

        expect(pinnedCalls).to.deep.equal(['/repo/a']);
        expect(plainRefreshCalled).to.be.false;
      } finally {
        el.remove();
      }
    });

    it('ref-menu Checkout and graph Checkout both refresh via the PINNED path (sibling consistency)', async () => {
      for (const handler of ['handleRefCheckout', 'handleCheckoutBranchFromGraph'] as const) {
        const el = createAppShell();
        document.body.appendChild(el);
        try {
          mockResponses['checkout_with_autostash'] = () => ({ success: true });
          (el as any).activeRepository = { repository: mockRepo('/repo/a', 'a') };
          (el as any).refContextMenu = { visible: true, refName: 'feature' };
          const pinnedCalls: Array<string | null> = [];
          (el as any).refreshConflictDialogRepo = (p: string | null) => pinnedCalls.push(p);
          let plainRefreshCalled = false;
          (el as any).handleRefresh = () => { plainRefreshCalled = true; };

          await (el as any)[handler](
            new CustomEvent('x', { detail: { branchName: 'feature' } })
          );

          expect(pinnedCalls, `${handler} routes through the pinned refresh`).to.deep.equal(['/repo/a']);
          expect(plainRefreshCalled, `${handler} avoids the unpinned refresh`).to.be.false;
        } finally {
          el.remove();
        }
      }
    });

    it('closing the pinned tab cancels an open cherry-pick or interactive-rebase dialog', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        repositoryStore.getState().setActiveByPath('/repo/b');
        await el.updateComplete;

        // Fake the two REAL elements as open and pinned to repo A. The sweep
        // discovers dialogs from the DOM, so a plain object hung off the @query
        // field would never be seen — and the test would pass whatever the
        // sweep did.
        const cp = stubPinnedDialog(el, 'lv-cherry-pick-dialog', '/repo/a');
        const rb = stubPinnedDialog(el, 'lv-interactive-rebase-dialog', '/repo/a');

        // Close repo A's tab — the store subscription must dismiss both.
        repositoryStore.getState().removeRepository('/repo/a');
        await el.updateComplete;

        expect(cp.closed(), 'cherry-pick dialog closed').to.be.true;
        expect(rb.closed(), 'rebase dialog closed').to.be.true;
      } finally {
        el.remove();
      }
    });

    it('does NOT dismiss — or claim to cancel — a clean that is mid-delete', async () => {
      // The repro: select thousands of untracked files, Delete, confirm, then
      // close the tab while clean_files runs. The sweep used to set
      // the clean dialog's flag directly, bypassing its own `cleaning`
      // guard, and toast "clean cancelled" — seconds before "Deleted 4,913
      // items" landed. Untracked files have no trash and no recovery path.
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        repositoryStore.getState().setActiveByPath('/repo/b');
        await el.updateComplete;

        dialogs.open('clean');
        await el.updateComplete;
        const clean = stubPinnedDialog(el, 'lv-clean-dialog', '/repo/a', true);
        uiStore.setState({ toasts: [] });

        repositoryStore.getState().removeRepository('/repo/a');
        await el.updateComplete;

        expect(clean.closed(), 'an in-flight clean is not force-dismissed').to.be.false;
        expect(
          dialogs.isOpen('clean'),
          'the host flag stays set — clearing it unmounts the dialog and orphans the delete',
        ).to.be.true;
        const messages = uiStore.getState().toasts.map((t) => t.message);
        expect(
          messages.some((m) => /clean cancelled/i.test(m)),
          `no toast may announce a cancellation that did not happen: ${JSON.stringify(messages)}`,
        ).to.be.false;
        expect(
          messages.some((m) => /the clean is still running against the closed repository/i.test(m)),
          `the truth is toasted instead: ${JSON.stringify(messages)}`,
        ).to.be.true;
      } finally {
        el.remove();
      }
    });

    it('does dismiss an IDLE clean dialog and says so', async () => {
      // The other half of the same guard: when nothing is running the sweep
      // must still close the dialog, or it floats over another repo.
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        repositoryStore.getState().setActiveByPath('/repo/b');
        await el.updateComplete;

        dialogs.open('clean');
        await el.updateComplete;
        const clean = stubPinnedDialog(el, 'lv-clean-dialog', '/repo/a', false);
        uiStore.setState({ toasts: [] });

        repositoryStore.getState().removeRepository('/repo/a');
        await el.updateComplete;

        expect(clean.closed(), 'an idle clean dialog is dismissed').to.be.true;
        expect(dialogs.isOpen('clean'), 'and its host flag cleared').to.be.false;
        const messages = uiStore.getState().toasts.map((t) => t.message);
        expect(
          messages.some((m) => /clean cancelled/i.test(m)),
          `and the dismissal is announced: ${JSON.stringify(messages)}`,
        ).to.be.true;
      } finally {
        el.remove();
      }
    });

    it('does NOT dismiss an interactive rebase that is mid-execute', async () => {
      // close() on this dialog is a bare `modal.open = false`; the `executing`
      // re-assert lives only in handleModalClose(), which the sweep never
      // reached — so "interactive rebase cancelled" was followed by "Rebased
      // onto main".
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        repositoryStore.getState().setActiveByPath('/repo/b');
        await el.updateComplete;

        const rb = stubPinnedDialog(el, 'lv-interactive-rebase-dialog', '/repo/a', true);
        uiStore.setState({ toasts: [] });

        repositoryStore.getState().removeRepository('/repo/a');
        await el.updateComplete;

        expect(rb.closed(), 'an in-flight rebase is not force-dismissed').to.be.false;
        const messages = uiStore.getState().toasts.map((t) => t.message);
        expect(
          messages.some((m) => /interactive rebase cancelled/i.test(m)),
          `no cancellation may be announced: ${JSON.stringify(messages)}`,
        ).to.be.false;
        expect(
          messages.some((m) => /still running against the closed repository/i.test(m)),
          `the truth is toasted instead: ${JSON.stringify(messages)}`,
        ).to.be.true;
      } finally {
        el.remove();
      }
    });

    it('keeps every flag-gated destructive dialog mounted while its operation runs', async () => {
      // Each of these was its own hand-written arm (or table row) that cleared
      // the host flag unconditionally: worktree remove --force, submodule
      // deinit -f, git lfs prune, and the reflog hard reset all kept running
      // behind a toast saying they had been closed.
      const cases: Array<[string, DialogId, string]> = [
        ['lv-worktree-dialog', 'worktrees', 'worktree removal'],
        ['lv-submodule-dialog', 'submodules', 'submodule removal'],
        ['lv-lfs-dialog', 'lfs', 'LFS prune'],
        ['lv-reflog-dialog', 'reflog', 'reset'],
      ];
      for (const [tag, flag, running] of cases) {
        const el = createAppShell();
        document.body.appendChild(el);
        try {
          repositoryStore.getState().reset();
          repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
          repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
          repositoryStore.getState().setActiveByPath('/repo/b');
          await el.updateComplete;

          dialogs.open(flag);
          await el.updateComplete;
          stubPinnedDialog(el, tag, '/repo/a', true);
          uiStore.setState({ toasts: [] });

          repositoryStore.getState().removeRepository('/repo/a');
          await el.updateComplete;

          expect(dialogs.isOpen(flag), `${tag}: host flag survives an in-flight operation`).to.be.true;
          const messages = uiStore.getState().toasts.map((t) => t.message);
          expect(
            messages.some((m) => m.includes(`the ${running} is still running`)),
            `${tag}: names the running work: ${JSON.stringify(messages)}`,
          ).to.be.true;
        } finally {
          el.remove();
        }
      }
    });

    it('tells the truth on the LAST tab: the operation finishes in the background', async () => {
      // With no tabs left the host unmounts every repo-scoped dialog on the
      // next render regardless, so promising a later dismissal would describe
      // something that did not happen.
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        await el.updateComplete;

        dialogs.open('clean');
        await el.updateComplete;
        stubPinnedDialog(el, 'lv-clean-dialog', '/repo/a', true);
        uiStore.setState({ toasts: [] });

        repositoryStore.getState().removeRepository('/repo/a');
        await el.updateComplete;

        const messages = uiStore.getState().toasts.map((t) => t.message);
        expect(
          messages.some((m) => /the clean will finish in the background/i.test(m)),
          `background wording on the last tab: ${JSON.stringify(messages)}`,
        ).to.be.true;
        expect(
          messages.some((m) => /clean cancelled/i.test(m)),
          `still no false cancellation: ${JSON.stringify(messages)}`,
        ).to.be.false;
      } finally {
        el.remove();
      }
    });

    it('a rebase-complete event bubbling from a nested dialog reaches the host pinned refresh', async () => {
      // Interactive rebase is dispatched by the branch-list's OWN embedded
      // dialog too, not just the app-shell one — the host-level listener
      // must catch either.
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        repositoryStore.getState().setActiveByPath('/repo/a');
        await el.updateComplete;

        // Dispatch from a descendant so it bubbles to the host listener.
        const child = el.shadowRoot!.querySelector('*') ?? el;
        child.dispatchEvent(
          new CustomEvent('rebase-complete', {
            detail: { repositoryPath: '/repo/b' },
            bubbles: true,
            composed: true,
          })
        );
        await el.updateComplete;

        expect((el as any).staleRepoPaths.has('/repo/b')).to.be.true;
      } finally {
        el.remove();
      }
    });

    it('rebase-complete on a background-tabbed repo refreshes the PINNED repo, not the active one', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        repositoryStore.getState().setActiveByPath('/repo/a');
        await el.updateComplete;

        (el as any).handleRebaseComplete(
          new CustomEvent('rebase-complete', {
            detail: { repositoryPath: '/repo/b' },
          })
        );
        await el.updateComplete;

        expect((el as any).staleRepoPaths.has('/repo/b'), 'pinned repo marked stale').to.be.true;
      } finally {
        el.remove();
      }
    });

    it('re-pins to the repo active at the NEXT open', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        repositoryStore.getState().setActiveByPath('/repo/a');
        await el.updateComplete;

        (el as any).openConflictDialogFromState();
        await el.updateComplete;
        (el as any).closeConflictDialog();
        repositoryStore.getState().setActiveByPath('/repo/b');
        await el.updateComplete;

        (el as any).openConflictDialogFromState();
        await el.updateComplete;
        const dialog = el.shadowRoot!.querySelector(
          'lv-conflict-resolution-dialog'
        ) as HTMLElement & { repositoryPath: string };
        expect(dialog.repositoryPath).to.equal('/repo/b');
      } finally {
        el.remove();
      }
    });
  });

  describe('context-menu operation pinning', () => {
    it('closes commit and ref context menus when the active repository changes', async () => {
      // Append BEFORE adding repos so connectedCallback's restore pass sees an
      // empty persistedOpenRepos and returns early — otherwise its async prune
      // writes drive the store subscription and land the element on /repo/b
      // before the switch below, making it a no-op.
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));
        // addRepository activates by default, so /repo/b is active here; pin
        // back to /repo/a so the switch below is a real A -> B transition.
        repositoryStore.getState().setActiveByPath('/repo/a');
        await el.updateComplete;
        expect((el as any).activeRepository?.repository.path).to.equal('/repo/a');

        (el as any).contextMenu = {
          visible: true,
          x: 0,
          y: 0,
          commit: { oid: 'commit-from-a', summary: 'A commit', shortId: 'commit-f' },
        };
        (el as any).refContextMenu = {
          visible: true,
          x: 0,
          y: 0,
          refName: 'branch-from-a',
          fullName: 'refs/heads/branch-from-a',
          refType: 'localBranch',
          isHead: false,
        };

        repositoryStore.getState().setActiveByPath('/repo/b');
        await el.updateComplete;

        expect((el as any).contextMenu.visible).to.be.false;
        expect((el as any).refContextMenu.visible).to.be.false;
      } finally {
        el.remove();
      }
    });

    it('handleResetToCommit hard-resets the origin repo, not the tab switched to during the confirm', async () => {
      // A hard reset discards uncommitted work — it must never run against a
      // repo the user did not confirm. The confirm await yields; a mid-confirm
      // tab switch rebinds activeRepository.
      // No appendChild: the handler operates on @state + gitService (mocked)
      // and does not need rendering; a full render cascade only adds noise.
      const el = createAppShell();
      (el as any).activeRepository = { repository: mockRepo('/repo/a', 'a') };
      (el as any).contextMenu = {
        visible: true,
        x: 0,
        y: 0,
        commit: { oid: 'deadbeef', summary: 'a commit', shortId: 'deadbee' },
      };

      let resolveConfirm: (v: unknown) => void = () => {};
      // showConfirm() goes through @tauri-apps/plugin-dialog's confirm(), which
      // is a wrapper over the message command — there is no dedicated
      // `plugin:dialog|confirm` IPC command to mock.
      mockResponses['plugin:dialog|message'] = () =>
        new Promise((res) => {
          resolveConfirm = res;
        });

      const promise = (el as any).handleResetToCommit('hard');
      await new Promise((r) => setTimeout(r, 0));

      // User switches to repo B while the confirm is up.
      (el as any).activeRepository = { repository: mockRepo('/repo/b', 'b') };
      resolveConfirm('Ok');
      await promise;

      const resetCall = invokeCallArgs.find((c) => c.command === 'reset');
      expect(resetCall, 'reset was called').to.not.be.undefined;
      expect(resetCall!.args.path).to.equal('/repo/a');
    });

    it('handleFixupCommit creates the fixup in the origin repo, not the tab switched to during the status check', async () => {
      const el = createAppShell();
      (el as any).activeRepository = { repository: mockRepo('/repo/a', 'a') };
      (el as any).contextMenu = {
        visible: true,
        x: 0,
        y: 0,
        commit: { oid: 'deadbeef', summary: 'a commit', shortId: 'deadbee' },
      };

      let resolveStatus: (v: unknown) => void = () => {};
      mockResponses['get_status'] = () =>
        new Promise((res) => {
          resolveStatus = res;
        });

      const promise = (el as any).handleFixupCommit();
      await new Promise((r) => setTimeout(r, 0));

      // User switches tabs while the status check is in flight.
      (el as any).activeRepository = { repository: mockRepo('/repo/b', 'b') };
      resolveStatus([{ path: 'f.ts', isStaged: true }]);
      await promise;

      const commitCall = invokeCallArgs.find((c) => c.command === 'create_commit');
      expect(commitCall, 'create_commit was called').to.not.be.undefined;
      expect(commitCall!.args.path).to.equal('/repo/a');
      expect((commitCall!.args.message as string)).to.contain('fixup!');
    });
  });

  describe('reword pinning', () => {
    it('handleRewordCommit does not open the rebase dialog if the user switched repos during the history await', async () => {
      // The interactive-rebase dialog pins to the LIVE active-repo prop at
      // open(); opening it after a mid-await tab switch would configure a
      // reword of repo A's commit against repo B. The handler must cancel.
      repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'));
      repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));

      const el = createAppShell();
      (el as any).activeRepository = { repository: mockRepo('/repo/a', 'a') };
      (el as any).contextMenu = {
        visible: true,
        x: 0,
        y: 0,
        commit: { oid: 'commitA', summary: 'a commit', shortId: 'commitA' },
      };

      // Shadow the @query dialog getter with a spy.
      let opened = false;
      Object.defineProperty(el, 'interactiveRebaseDialog', {
        configurable: true,
        value: {
          open: () => {
            opened = true;
          },
        },
      });

      let resolveHistory: (v: unknown) => void = () => {};
      mockResponses['get_commit_history'] = () =>
        new Promise((res) => {
          resolveHistory = res;
        });
      // Reword now refuses a commit that is not in HEAD's history — this test
      // is about the repo-switch pinning, so the commit is on this branch.
      mockResponses['is_ancestor_of_head'] = () => true;

      const promise = (el as any).handleRewordCommit();
      await new Promise((r) => setTimeout(r, 0));

      // User switches to repo B while the history IPC is in flight.
      (el as any).activeRepository = { repository: mockRepo('/repo/b', 'b') };
      // History resolves; commit is non-HEAD (different oid) → else branch.
      resolveHistory([{ oid: 'headOfA' }]);
      await promise;

      expect(opened, 'rebase dialog must NOT open against the switched-to repo').to.be.false;
      const warn = uiStore.getState().toasts.find((t) => t.type === 'warning');
      expect(warn, 'a warning toast explains the cancellation').to.not.be.undefined;
    });

    it('handleRewordCommit opens the rebase dialog when the repo did not change', async () => {
      repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'));

      const el = createAppShell();
      (el as any).activeRepository = { repository: mockRepo('/repo/a', 'a') };
      (el as any).contextMenu = {
        visible: true,
        x: 0,
        y: 0,
        commit: { oid: 'commitA', summary: 'a commit', shortId: 'commitA' },
      };

      let opened = false;
      Object.defineProperty(el, 'interactiveRebaseDialog', {
        configurable: true,
        value: {
          open: () => {
            opened = true;
          },
        },
      });

      mockResponses['get_commit_history'] = () => [{ oid: 'headOfA' }];
      // On this branch — the off-branch refusal is covered in
      // app-shell-destructive-guards.test.ts.
      mockResponses['is_ancestor_of_head'] = () => true;

      await (el as any).handleRewordCommit();

      expect(opened, 'rebase dialog opens for a non-HEAD commit on the same repo').to.be.true;
    });
  });

  describe('conflict operation derivation for external operations', () => {
    for (const state of ['apply-mailbox', 'apply-mailbox-or-rebase', 'bisect'] as const) {
      it(`refuses to open the dialog for an external ${state} operation`, async () => {
        const el = createAppShell();
        document.body.appendChild(el);
        try {
          const repo = { ...mockRepo('/repo/a', 'a'), state };
          repositoryStore.getState().addRepository(repo, { activate: true });
          await el.updateComplete;

          // The dialog cannot drive am/bisect: Complete would not run their
          // --continue and the inferred-stash Abort would discard the
          // conflicted files while the operation stays wedged.
          (el as any).openConflictDialogFromState();
          await el.updateComplete;

          expect(dialogs.isOpen('conflict')).to.be.false;
          expect(el.shadowRoot!.querySelector('lv-conflict-resolution-dialog')).to.be.null;
          const toasts = uiStore.getState().toasts;
          expect(toasts.some((t) => t.type === 'warning' && t.message.includes(state))).to.be
            .true;
        } finally {
          el.remove();
        }
      });
    }

    it('still infers a stash conflict for a clean state', async () => {
      const el = createAppShell();
      document.body.appendChild(el);
      try {
        repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'), { activate: true });
        await el.updateComplete;
        (el as any).openConflictDialogFromState();
        await el.updateComplete;
        expect(dialogs.isOpen('conflict')).to.be.true;
        expect((el as any).conflictOperationType).to.equal('stash');
      } finally {
        el.remove();
      }
    });
  });
});
describe('closing the last repository closes its dialogs', () => {
  // These dialogs render inside the `${this.activeRepository ? ... }` block, so
  // closing the last tab destroys the ELEMENT while its show* flag stays true.
  // Open the next repository and the element is reconstructed with ?open=true —
  // a full-screen overlay springing up unbidden over a repo the user just
  // opened. lv-repository-health-dialog carried that story already, and
  // lv-bisect-dialog then reproduced it because it has no pinned path and so
  // was in neither hand-written sweep. The fix is an EXCLUSION list, so a
  // newly added dialog defaults to the safe behaviour.
  it('clears every repo-scoped dialog flag when the last tab closes', async () => {
    const el = createAppShell();
    document.body.appendChild(el);
    await el.updateComplete;

    repositoryStore.setState({
      openRepositories: [
        { repository: mockRepo('/repo/a', 'a'), branches: [], currentBranch: null },
      ] as never,
      activeIndex: 0,
    });
    await el.updateComplete;

    dialogs.open('bisect');
    dialogs.open('worktrees');
    dialogs.open('lfs');
    // Not repo-scoped — must survive.
    dialogs.open('settings');
    await el.updateComplete;

    repositoryStore.setState({ openRepositories: [] as never, activeIndex: -1 });
    await el.updateComplete;

    expect(dialogs.isOpen('bisect'), 'bisect must not outlive its repository').to.be.false;
    expect(dialogs.isOpen('worktrees'), 'worktrees must not outlive its repository').to.be.false;
    expect(dialogs.isOpen('lfs'), 'LFS must not outlive its repository').to.be.false;
    expect(dialogs.isOpen('settings'), 'settings is not repo-scoped').to.be.true;

    el.remove();
  });

  // The mirror image: these dialogs render OUTSIDE the activeRepository block,
  // so their element is never destroyed and the spring-back-open failure the
  // sweep exists to prevent cannot happen to them. Every one is reachable with
  // zero repositories — the welcome screen offers the profile manager, and the
  // palette's SSH, profiles and provider entries are not repo-guarded — so
  // clearing their flags only kills a session the user deliberately started.
  it('leaves repo-independent dialogs open when the last tab closes', async () => {
    const el = createAppShell();
    document.body.appendChild(el);
    await el.updateComplete;

    repositoryStore.setState({
      openRepositories: [
        { repository: mockRepo('/repo/a', 'a'), branches: [], currentBranch: null },
      ] as never,
      activeIndex: 0,
    });
    await el.updateComplete;

    const repoIndependent: DialogId[] = [
      'ssh',
      'profileManager',
      'migration',
      'gitHub',
      'gitLab',
      'bitbucket',
      'azureDevOps',
      'oidc',
    ];
    for (const key of repoIndependent) dialogs.open(key);
    // Control: GPG renders inside the activeRepository block, so it must still
    // be swept — proof the exclusion did not simply disable the sweep.
    dialogs.open('gpg');
    await el.updateComplete;

    repositoryStore.setState({ openRepositories: [] as never, activeIndex: -1 });
    await el.updateComplete;

    for (const key of repoIndependent) {
      expect(dialogs.isOpen(key), `${key} is not repo-scoped`).to.be.true;
    }
    expect(dialogs.isOpen('gpg'), 'GPG must not outlive its repository').to.be.false;

    el.remove();
  });

  it('keeps an in-progress account connect alive when the last tab closes', async () => {
    const el = createAppShell();
    document.body.appendChild(el);
    await el.updateComplete;

    repositoryStore.setState({
      openRepositories: [
        { repository: mockRepo('/repo/a', 'a'), branches: [], currentBranch: null },
      ] as never,
      activeIndex: 0,
    });
    await el.updateComplete;

    const internal = el as unknown as Record<string, unknown>;
    dialogs.open('profileManager');
    await el.updateComplete;

    // Drive the REAL handler: the manager stacks a provider dialog on itself to
    // connect an account to a profile. The listener is bound directly on the
    // element, so the event does not need to bubble.
    el.shadowRoot!.querySelector('lv-profile-manager-dialog')!.dispatchEvent(
      new CustomEvent('open-github', {
        detail: {
          returnTo: 'profile-manager',
          integrationType: 'github',
          profileId: 'p1',
          profileName: 'Work',
          attach: true,
        },
      })
    );
    await el.updateComplete;

    expect(dialogs.isOpen('gitHub'), 'the connect flow opened the provider dialog').to.be.true;
    expect(internal.integrationContext, 'the connect flow recorded its return context').to.not.be
      .null;

    repositoryStore.setState({ openRepositories: [] as never, activeIndex: -1 });
    await el.updateComplete;

    const gh = el.shadowRoot!.querySelector('lv-github-dialog') as HTMLElement & {
      open: boolean;
    };
    expect(gh.open, 'the connect dialog survives the tab close').to.be.true;
    const pm = el.shadowRoot!.querySelector('lv-profile-manager-dialog') as HTMLElement & {
      open: boolean;
    };
    expect(pm.open, 'the manager underneath stays open').to.be.true;
    expect(internal.integrationContext, 'return context is not stranded without a dialog').to.not
      .be.null;

    el.remove();
  });

  /**
   * Which dialogs app-shell consults `dialogs.isOpen` for while rendering —
   * observed from the render itself, not typed by hand. A dialog consulted
   * only when a repository is open is rendered inside the
   * `${this.activeRepository ? ...}` block; one consulted with nothing open
   * renders outside it. Lit re-runs the whole `render()` on every update, so
   * one forced update sees every `isOpen` call the template makes.
   */
  async function dialogsConsultedByRender(el: AppShell): Promise<Set<DialogId>> {
    const seen = new Set<DialogId>();
    const original = dialogs.isOpen;
    dialogs.isOpen = (id: DialogId): boolean => {
      seen.add(id);
      return original(id);
    };
    try {
      el.requestUpdate();
      await el.updateComplete;
    } finally {
      dialogs.isOpen = original;
    }
    return seen;
  }

  // The registry's contract, checked against app-shell's actual render rather
  // than a second hand-typed list: a dialog whose element lives inside the
  // repository block is destroyed with the last tab while its flag would
  // survive, so it MUST be declared repo-scoped. This is what caught the
  // output panel being declared repo-independent while rendering in the
  // repository layout (and would catch the next one). The reverse direction
  // is a product choice, not a rendering fact: a dialog rendered outside the
  // block may still be declared repo-scoped if it is meaningless without one.
  it('declares every dialog rendered inside the repository block as repo-scoped', async () => {
    const el = createAppShell();
    document.body.appendChild(el);
    await el.updateComplete;

    repositoryStore.setState({ openRepositories: [] as never, activeIndex: -1 });
    await el.updateComplete;
    const withoutRepo = await dialogsConsultedByRender(el);

    repositoryStore.setState({
      openRepositories: [
        { repository: mockRepo('/repo/a', 'a'), branches: [], currentBranch: null },
      ] as never,
      activeIndex: 0,
    });
    await el.updateComplete;
    const withRepo = await dialogsConsultedByRender(el);

    const insideRepoBlock = [...withRepo].filter((id) => !withoutRepo.has(id));
    // Guard against a vacuous pass: the derivation must actually see the
    // render on both sides of the repository block.
    expect(withoutRepo.size, 'dialogs are rendered outside the repository block').to.be.greaterThan(0);
    expect(insideRepoBlock.length, 'dialogs are rendered inside the repository block').to.be.greaterThan(0);

    for (const id of insideRepoBlock) {
      expect(
        DIALOG_REGISTRY[id].repoScoped,
        `${id} renders inside the repository block, so it must be repo-scoped`,
      ).to.equal(true);
    }

    el.remove();
  });

  // Over-reach guard. This passes with or without the exclusions above; it is
  // here so that widening REPO_INDEPENDENT_DIALOGS to a dialog that really does
  // render inside the activeRepository block fails loudly.
  it('still sweeps every dialog that renders inside the repository block', async () => {
    const el = createAppShell();
    document.body.appendChild(el);
    await el.updateComplete;

    repositoryStore.setState({
      openRepositories: [
        { repository: mockRepo('/repo/a', 'a'), branches: [], currentBranch: null },
      ] as never,
      activeIndex: 0,
    });
    await el.updateComplete;

    const repoScoped: DialogId[] = [
      'remotes',
      'clean',
      'bisect',
      'submodules',
      'worktrees',
      'lfs',
      'gpg',
      'config',
      'credentials',
      'hooks',
      'repositoryHealth',
      'reflog',
      'outputPanel',
    ];
    for (const key of repoScoped) dialogs.open(key);
    await el.updateComplete;

    repositoryStore.setState({ openRepositories: [] as never, activeIndex: -1 });
    await el.updateComplete;

    for (const key of repoScoped) {
      expect(dialogs.isOpen(key), `${key} must not outlive its repository`).to.be.false;
    }

    el.remove();
  });
});
describe('the toolbar command-palette button loads the active repo', () => {
  // Opening the palette dialog directly skipped openCommandPalette(), the only
  // place branches and files are loaded. Cold start: a palette with no branch
  // entries at all. After a tab switch: the PREVIOUS repo's branches, offering
  // "Switch to <current branch>" and running a checkout against the wrong repo.
  it('populates branches through openCommandPalette, not the bare flag', async () => {
    const el = createAppShell();
    document.body.appendChild(el);
    await el.updateComplete;

    repositoryStore.setState({
      openRepositories: [
        { repository: mockRepo('/repo/a', 'a'), branches: [], currentBranch: null },
      ] as never,
      activeIndex: 0,
    });
    await el.updateComplete;

    const internal = el as unknown as {
      paletteBranches: unknown[];
    };
    internal.paletteBranches = [];
    invokeCallArgs.length = 0;

    const toolbar = el.shadowRoot!.querySelector('lv-toolbar');
    expect(toolbar, 'the toolbar must be rendered').to.not.be.null;
    toolbar!.dispatchEvent(
      new CustomEvent('open-command-palette', { bubbles: true, composed: true })
    );
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));

    expect(dialogs.isOpen('commandPalette'), 'the palette opens').to.be.true;
    expect(
      // list_tracked_files is loaded ONLY by openCommandPalette, so it is the
      // unambiguous signal that the loader ran (get_branches is also issued by
      // background refreshes).
      invokeCallArgs.some((c) => c.command === 'list_tracked_files'),
      'and it must have run the palette loader for the ACTIVE repo'
    ).to.be.true;

    el.remove();
  });

  it('does not reopen or populate the palette with a superseded repository load', async () => {
    const branchResolvers: Array<(value: unknown[]) => void> = [];
    const fileResolvers: Array<(value: string[]) => void> = [];
    mockResponses['get_branches'] = (args) =>
      args.path === '/repo/a'
        ? new Promise<unknown[]>((resolve) => branchResolvers.push(resolve))
        : [];
    mockResponses['list_tracked_files'] = (args) =>
      args.path === '/repo/a'
        ? new Promise<string[]>((resolve) => fileResolvers.push(resolve))
        : [];

    const el = createAppShell();
    document.body.appendChild(el);
    await el.updateComplete;
    repositoryStore.setState({
      openRepositories: [
        { repository: mockRepo('/repo/a', 'a'), branches: [], currentBranch: null },
        { repository: mockRepo('/repo/b', 'b'), branches: [], currentBranch: null },
      ] as never,
      activeIndex: 0,
    });
    await el.updateComplete;

    const internal = el as unknown as {
      paletteBranches: Array<{ name: string }>;
      paletteTrackedFiles: string[];
      openCommandPalette: () => Promise<void>;
    };
    const pendingOpen = internal.openCommandPalette();
    await waitUntil(() => branchResolvers.length > 0 && fileResolvers.length > 0);

    repositoryStore.setState({ activeIndex: 1 });
    await el.updateComplete;
    branchResolvers.forEach((resolve) => resolve([{ name: 'only-in-a' }]));
    fileResolvers.forEach((resolve) => resolve(['only-in-a.txt']));
    await pendingOpen;
    await el.updateComplete;

    expect(dialogs.isOpen('commandPalette'), 'the stale request must not reopen the overlay').to.be.false;
    expect(internal.paletteBranches.some((branch) => branch.name === 'only-in-a')).to.be.false;
    expect(internal.paletteTrackedFiles).not.to.include('only-in-a.txt');

    el.remove();
  });

  // Every palette action carries `repositoryPath` and app-shell drops the ones
  // that do not match the active tab, so the binding that feeds the palette
  // that path is load-bearing: leave it empty and Switch/Reveal/Open silently
  // do nothing.
  it('hands the palette the repository its data was loaded from', async () => {
    mockResponses['get_branches'] = () => [];
    mockResponses['list_tracked_files'] = () => [];
    const el = createAppShell();
    document.body.appendChild(el);
    await el.updateComplete;
    repositoryStore.setState({
      openRepositories: [
        { repository: mockRepo('/repo/a', 'a'), branches: [], currentBranch: null },
      ] as never,
      activeIndex: 0,
    });
    await el.updateComplete;

    await (el as unknown as { openCommandPalette: () => Promise<void> }).openCommandPalette();
    await el.updateComplete;

    const palette = el.shadowRoot!.querySelector('lv-command-palette');
    expect(palette, 'the palette must be rendered').to.not.be.null;
    expect((palette as unknown as { repositoryPath: string }).repositoryPath).to.equal('/repo/a');

    el.remove();
  });

  // Ctrl+P stays live while the palette is up (keyboard.service lets Ctrl/Cmd
  // combos through an open overlay), so a second press starts another loader.
  // Escape before it settled cleared the flag and the loader — same requestId,
  // same repository — set it straight back.
  it('a dismissal during an in-flight reload does not spring the palette back open', async () => {
    const branchResolvers: Array<(value: unknown[]) => void> = [];
    const fileResolvers: Array<(value: string[]) => void> = [];
    let deferLoads = false;
    mockResponses['get_branches'] = () =>
      deferLoads ? new Promise<unknown[]>((resolve) => branchResolvers.push(resolve)) : [];
    mockResponses['list_tracked_files'] = () =>
      deferLoads ? new Promise<string[]>((resolve) => fileResolvers.push(resolve)) : [];

    const el = createAppShell();
    document.body.appendChild(el);
    await el.updateComplete;
    repositoryStore.setState({
      openRepositories: [
        { repository: mockRepo('/repo/a', 'a'), branches: [], currentBranch: null },
      ] as never,
      activeIndex: 0,
    });
    await el.updateComplete;

    const internal = el as unknown as {
      openCommandPalette: () => Promise<void>;
    };
    await internal.openCommandPalette();
    await el.updateComplete;
    expect(dialogs.isOpen('commandPalette'), 'the palette is up to begin with').to.be.true;

    deferLoads = true;
    const pendingOpen = internal.openCommandPalette();
    await waitUntil(() => branchResolvers.length > 0 && fileResolvers.length > 0);

    // Escape: the palette dismisses itself and reports it through `close`.
    const palette = el.shadowRoot!.querySelector('lv-command-palette');
    expect(palette, 'the palette must be rendered').to.not.be.null;
    (palette as unknown as { close: () => void }).close();
    await el.updateComplete;
    expect(dialogs.isOpen('commandPalette'), 'the dismissal takes effect').to.be.false;

    branchResolvers.forEach((resolve) => resolve([]));
    fileResolvers.forEach((resolve) => resolve([]));
    await pendingOpen;
    await el.updateComplete;

    expect(dialogs.isOpen('commandPalette'), 'the superseded load must not reopen it').to.be.false;
    expect(
      (palette as unknown as { open: boolean }).open,
      'and the overlay itself stays down'
    ).to.be.false;

    el.remove();
  });

  it('closes an open palette when the active repository changes', async () => {
    mockResponses['get_branches'] = () => [];
    mockResponses['list_tracked_files'] = () => [];
    const el = createAppShell();
    document.body.appendChild(el);
    await el.updateComplete;
    repositoryStore.setState({
      openRepositories: [
        { repository: mockRepo('/repo/a', 'a'), branches: [], currentBranch: null },
        { repository: mockRepo('/repo/b', 'b'), branches: [], currentBranch: null },
      ] as never,
      activeIndex: 0,
    });
    await el.updateComplete;

    const internal = el as unknown as {
      openCommandPalette: () => Promise<void>;
    };
    await internal.openCommandPalette();
    await el.updateComplete;
    expect(dialogs.isOpen('commandPalette')).to.be.true;

    repositoryStore.setState({ activeIndex: 1 });
    await el.updateComplete;

    expect(dialogs.isOpen('commandPalette')).to.be.false;
    el.remove();
  });

  it('rejects a palette action whose repository no longer matches the active tab', async () => {
    const el = createAppShell();
    repositoryStore.setState({
      openRepositories: [
        { repository: mockRepo('/repo/b', 'b'), branches: [], currentBranch: null },
      ] as never,
      activeIndex: 0,
    });
    document.body.appendChild(el);
    await el.updateComplete;
    invokeCallArgs.length = 0;

    await (el as unknown as {
      handleCheckoutBranch: (
        event: CustomEvent<{ branch: string; repositoryPath: string }>
      ) => Promise<void>;
    }).handleCheckoutBranch(
      new CustomEvent('checkout-branch', {
        detail: { branch: 'feature-a', repositoryPath: '/repo/a' },
      })
    );

    expect(invokeCallArgs.some((call) => call.command === 'checkout_with_autostash')).to.be.false;
    el.remove();
  });

  it('clears failed datasets and reports both load failures', async () => {
    mockResponses['get_branches'] = () => {
      throw new Error('branches unavailable');
    };
    mockResponses['list_tracked_files'] = () => {
      throw new Error('files unavailable');
    };
    const el = createAppShell();
    (el as unknown as { activeRepository: unknown }).activeRepository = {
      repository: mockRepo('/repo/a', 'a'),
    };
    const internal = el as unknown as {
      paletteBranches: unknown[];
      paletteTrackedFiles: string[];
      openCommandPalette: () => Promise<void>;
    };
    internal.paletteBranches = [{ name: 'stale-a' }];
    internal.paletteTrackedFiles = ['stale-a.txt'];
    uiStore.setState({ toasts: [] });

    await internal.openCommandPalette();

    expect(internal.paletteBranches).to.deep.equal([]);
    expect(internal.paletteTrackedFiles).to.deep.equal([]);
    const messages = uiStore.getState().toasts.map((toast) => toast.message);
    expect(messages.join('|')).to.contain('Failed to load branches');
    expect(messages.join('|')).to.contain('Failed to load tracked files');
  });

  // A succeeded command with an empty payload is not a failure. Gating the
  // success path on `result.data` being truthy sent a repository with no
  // branches and no tracked files down the error branch, so every palette
  // open raised two "Unknown error" toasts nothing had gone wrong in.
  it('reports no failure when both loads succeed with an empty payload', async () => {
    mockResponses['get_branches'] = () => null;
    mockResponses['list_tracked_files'] = () => null;
    const el = createAppShell();
    (el as unknown as { activeRepository: unknown }).activeRepository = {
      repository: mockRepo('/repo/a', 'a'),
    };
    const internal = el as unknown as {
      paletteBranches: unknown[];
      paletteTrackedFiles: string[];
      openCommandPalette: () => Promise<void>;
    };
    uiStore.setState({ toasts: [] });

    await internal.openCommandPalette();

    expect(internal.paletteBranches).to.deep.equal([]);
    expect(internal.paletteTrackedFiles).to.deep.equal([]);
    expect(dialogs.isOpen('commandPalette')).to.be.true;
    expect(uiStore.getState().toasts).to.deep.equal([]);
  });
});
