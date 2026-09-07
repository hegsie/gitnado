/**
 * Tests for opening repositories dropped onto the window.
 *
 * The webview's `tauri://drag-drop` event cannot be produced in this
 * environment, so the listener wiring is covered by the E2E suite (which can
 * emit backend events through the Tauri mock) and everything the drop DOES is
 * covered here, against the same handler the listener calls.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
const invokeCallArgs: Array<{ command: string; args: Record<string, unknown> }> = [];
const mockResponses: Record<string, (args: Record<string, unknown>) => unknown> = {};

let cbId = 0;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: Record<string, unknown>) => {
    invokeCallArgs.push({ command, args: args || {} });
    const handler = mockResponses[command];
    try {
      return Promise.resolve(handler ? handler(args || {}) : null);
    } catch (err) {
      return Promise.reject(err);
    }
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect } from '@open-wc/testing';
import {
  handleDroppedPaths,
  offerDirectoryScan,
  REPOSITORY_SCAN_OFFER_EVENT,
  REPOSITORY_SCAN_RESOLVED_EVENT,
} from '../window-drop.service.ts';
import { repositoryStore, uiStore } from '../../stores/index.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

function classification(
  path: string,
  overrides: Partial<{
    exists: boolean;
    isDirectory: boolean;
    isRepository: boolean;
    isBare: boolean;
  }> = {},
) {
  return {
    path,
    name: path.split('/').pop(),
    exists: true,
    isDirectory: true,
    isRepository: true,
    isBare: false,
    ...overrides,
  };
}

function mockRepoPayload(path: string) {
  return {
    path,
    name: path.split('/').pop(),
    isValid: true,
    isBare: false,
    headRef: 'main',
    state: 'clean',
    isShallow: false,
    isPartialClone: false,
    cloneFilter: null,
  };
}

/** Classify every path with the same shape unless `perPath` overrides it. */
function mockClassifications(perPath: Record<string, ReturnType<typeof classification>>): void {
  mockResponses['classify_repository_path'] = (args) => {
    const path = args.path as string;
    return perPath[path] ?? classification(path);
  };
}

function toastMessages(): string[] {
  return uiStore.getState().toasts.map((t) => t.message);
}

/** Collect the paths announced as "this dropped folder IS a repository". */
function captureResolved(): { paths: string[]; stop: () => void } {
  const paths: string[] = [];
  const listener = (e: Event) => paths.push((e as CustomEvent<{ path: string }>).detail.path);
  window.addEventListener(REPOSITORY_SCAN_RESOLVED_EVENT, listener);
  return { paths, stop: () => window.removeEventListener(REPOSITORY_SCAN_RESOLVED_EVENT, listener) };
}

describe('window drop handler', () => {
  beforeEach(() => {
    invokeCallArgs.length = 0;
    for (const key of Object.keys(mockResponses)) {
      delete mockResponses[key];
    }
    uiStore.setState({ toasts: [] });
    repositoryStore.getState().reset();
    mockResponses['open_repository'] = (args) => mockRepoPayload(args.path as string);
  });

  it('opens a dropped repository and says so', async () => {
    mockClassifications({});

    const outcome = await handleDroppedPaths(['/repos/alpha']);

    expect(outcome.opened).to.deep.equal(['/repos/alpha']);
    const state = repositoryStore.getState();
    expect(state.openRepositories.length).to.equal(1);
    expect(state.openRepositories[0].repository.path).to.equal('/repos/alpha');
    const toasts = uiStore.getState().toasts;
    expect(toasts.length).to.equal(1);
    expect(toasts[0].type).to.equal('success');
    expect(toasts[0].message).to.contain('alpha');
  });

  it('offers a scan for a folder that is not a repository', async () => {
    mockClassifications({
      '/projects': classification('/projects', { isRepository: false }),
    });

    const offers: string[] = [];
    const listener = (e: Event) => offers.push((e as CustomEvent<{ path: string }>).detail.path);
    window.addEventListener(REPOSITORY_SCAN_OFFER_EVENT, listener);
    try {
      const outcome = await handleDroppedPaths(['/projects']);
      expect(outcome.notRepositories).to.deep.equal(['/projects']);
    } finally {
      window.removeEventListener(REPOSITORY_SCAN_OFFER_EVENT, listener);
    }

    expect(offers).to.deep.equal(['/projects']);
    expect(repositoryStore.getState().openRepositories.length).to.equal(0);
    // The offer dialog IS the feedback; a toast on top of it would be noise.
    expect(uiStore.getState().toasts.length).to.equal(0);
  });

  it('announces a dropped folder that turned out to be a repository', async () => {
    // The scan offer for this folder may still be on screen saying it is NOT a
    // repository — the user was told to create one and did. Nothing else in the
    // drop tells the shell that the answer to that question has changed.
    mockClassifications({});
    const resolved = captureResolved();
    try {
      await handleDroppedPaths(['/repos/alpha']);
    } finally {
      resolved.stop();
    }

    expect(resolved.paths).to.deep.equal(['/repos/alpha']);
  });

  it('announces a re-dropped repository whose tab was merely focused', async () => {
    // "Already open" is just as much an answer to "is this a repository?" as a
    // fresh tab is, so the stale offer must go in that case too.
    mockClassifications({});
    await handleDroppedPaths(['/repos/alpha']);
    const resolved = captureResolved();
    try {
      const outcome = await handleDroppedPaths(['/repos/alpha']);
      expect(outcome.alreadyOpen).to.deep.equal(['/repos/alpha']);
    } finally {
      resolved.stop();
    }

    expect(resolved.paths).to.deep.equal(['/repos/alpha']);
  });

  it('announces nothing for a folder that is still not a repository', async () => {
    mockClassifications({
      '/projects': classification('/projects', { isRepository: false }),
    });
    const resolved = captureResolved();
    try {
      await handleDroppedPaths(['/projects']);
    } finally {
      resolved.stop();
    }

    expect(resolved.paths).to.deep.equal([]);
  });

  it('focuses the existing tab instead of opening a repository twice', async () => {
    mockClassifications({});
    await handleDroppedPaths(['/repos/alpha']);
    await handleDroppedPaths(['/repos/beta']);
    uiStore.setState({ toasts: [] });
    const openCallsBefore = invokeCallArgs.filter((c) => c.command === 'open_repository').length;

    const outcome = await handleDroppedPaths(['/repos/alpha']);

    expect(outcome.alreadyOpen).to.deep.equal(['/repos/alpha']);
    expect(outcome.opened).to.deep.equal([]);
    const state = repositoryStore.getState();
    expect(state.openRepositories.length).to.equal(2, 'no duplicate tab');
    expect(state.openRepositories[state.activeIndex].repository.path).to.equal('/repos/alpha');
    expect(
      invokeCallArgs.filter((c) => c.command === 'open_repository').length,
      'an already-open repository is not re-opened over IPC',
    ).to.equal(openCallsBefore);
    const toasts = uiStore.getState().toasts;
    expect(toasts.length).to.equal(1);
    expect(toasts[0].type).to.equal('info');
    expect(toasts[0].message).to.contain('already open');
  });

  it('handles a mixed drop: opens the repositories and reports the rest', async () => {
    mockClassifications({
      '/repos/beta': classification('/repos/beta', { isRepository: false }),
      '/repos/notes.txt': classification('/repos/notes.txt', {
        isDirectory: false,
        isRepository: false,
      }),
      '/repos/gone': classification('/repos/gone', {
        exists: false,
        isDirectory: false,
        isRepository: false,
      }),
    });

    const outcome = await handleDroppedPaths([
      '/repos/alpha',
      '/repos/gamma',
      '/repos/beta',
      '/repos/notes.txt',
      '/repos/gone',
    ]);

    expect(outcome.opened).to.deep.equal(['/repos/alpha', '/repos/gamma']);
    expect(outcome.notRepositories).to.deep.equal(['/repos/beta']);
    expect(outcome.files).to.deep.equal(['/repos/notes.txt']);
    expect(outcome.missing).to.deep.equal(['/repos/gone']);
    expect(repositoryStore.getState().openRepositories.length).to.equal(2);

    const messages = toastMessages();
    expect(messages.some((m) => m.includes('Opened 2 repositories'))).to.equal(true);
    expect(messages.some((m) => m.includes('no longer exists'))).to.equal(true);
    expect(messages.some((m) => m.includes('is a file'))).to.equal(true);
    expect(messages.some((m) => m.includes('not a Git repository'))).to.equal(true);
  });

  it('offers a scan from the toast when several folders are not repositories', async () => {
    mockClassifications({
      '/a': classification('/a', { isRepository: false }),
      '/b': classification('/b', { isRepository: false }),
    });

    await handleDroppedPaths(['/a', '/b']);

    const toasts = uiStore.getState().toasts;
    expect(toasts.length).to.equal(1);
    expect(toasts[0].message).to.contain('2 dropped folders');
    expect(toasts[0].action?.label).to.equal('Scan folder');

    const offers: string[] = [];
    const listener = (e: Event) => offers.push((e as CustomEvent<{ path: string }>).detail.path);
    window.addEventListener(REPOSITORY_SCAN_OFFER_EVENT, listener);
    try {
      toasts[0].action?.callback();
    } finally {
      window.removeEventListener(REPOSITORY_SCAN_OFFER_EVENT, listener);
    }
    expect(offers).to.deep.equal(['/a']);
  });

  it('reports a repository that cannot be opened', async () => {
    mockClassifications({});
    mockResponses['open_repository'] = () => {
      throw new Error('failed to open repository: permission denied');
    };

    const outcome = await handleDroppedPaths(['/repos/locked']);

    expect(outcome.failures.length).to.equal(1);
    expect(outcome.failures[0].message).to.contain('permission denied');
    expect(repositoryStore.getState().openRepositories.length).to.equal(0);
    const toasts = uiStore.getState().toasts;
    expect(toasts.length).to.equal(1);
    expect(toasts[0].type).to.equal('error');
    expect(toasts[0].message).to.contain('permission denied');
  });

  it('reports a path that could not even be inspected', async () => {
    mockResponses['classify_repository_path'] = () => {
      throw new Error('backend unavailable');
    };

    const outcome = await handleDroppedPaths(['/repos/alpha']);

    expect(outcome.failures.length).to.equal(1);
    expect(uiStore.getState().toasts[0].type).to.equal('error');
    expect(uiStore.getState().toasts[0].message).to.contain('backend unavailable');
  });

  it('does nothing for an empty drop', async () => {
    const outcome = await handleDroppedPaths([]);

    expect(outcome.opened).to.deep.equal([]);
    expect(uiStore.getState().toasts.length).to.equal(0);
    expect(invokeCallArgs.length).to.equal(0);
  });

  it('says so when a drop arrives while the previous one is still opening', async () => {
    mockClassifications({});
    // Hold the first drop inside open_repository so the second one lands while
    // it is still in flight.
    let releaseFirst: () => void = () => {};
    const firstOpened = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let opens = 0;
    mockResponses['open_repository'] = (args) => {
      opens++;
      const payload = mockRepoPayload(args.path as string);
      return opens === 1 ? firstOpened.then(() => payload) : payload;
    };

    const first = handleDroppedPaths(['/repos/alpha']);
    const second = await handleDroppedPaths(['/repos/beta']);

    // The refused drop opened nothing and, crucially, SAID so.
    expect(second.opened).to.deep.equal([]);
    expect(toastMessages().some((m) => m.includes('Still opening the previous drop'))).to.equal(
      true,
    );
    expect(uiStore.getState().toasts[0].type).to.equal('info');
    expect(repositoryStore.getState().openRepositories.length).to.equal(0);

    releaseFirst();
    const firstOutcome = await first;
    expect(firstOutcome.opened).to.deep.equal(['/repos/alpha']);
    expect(repositoryStore.getState().openRepositories.length).to.equal(1);

    // And the guard released: a later drop works normally.
    const third = await handleDroppedPaths(['/repos/gamma']);
    expect(third.opened).to.deep.equal(['/repos/gamma']);
  });

  it('dispatches the scan offer on the window', () => {
    const offers: string[] = [];
    const listener = (e: Event) => offers.push((e as CustomEvent<{ path: string }>).detail.path);
    window.addEventListener(REPOSITORY_SCAN_OFFER_EVENT, listener);
    try {
      offerDirectoryScan('/somewhere');
    } finally {
      window.removeEventListener(REPOSITORY_SCAN_OFFER_EVENT, listener);
    }
    expect(offers).to.deep.equal(['/somewhere']);
  });
});
