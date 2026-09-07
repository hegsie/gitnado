/**
 * Tests for the "Scan for Repositories" dialog: the results list the user
 * picks from, the offer step for a dropped folder that is not a repository,
 * and the failure paths (scan error, open error, cancellation).
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
(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => {},
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { aTimeout, expect, fixture, html, waitUntil } from '@open-wc/testing';
import '../lv-scan-repositories-dialog.ts';
import type { LvScanRepositoriesDialog } from '../lv-scan-repositories-dialog.ts';
import { repositoryStore, uiStore } from '../../../stores/index.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

function scanResult(overrides: Record<string, unknown> = {}) {
  return {
    root: '/code',
    repositories: [
      { path: '/code/alpha', name: 'alpha', isBare: false },
      { path: '/code/beta', name: 'beta', isBare: false },
    ],
    scannedDirectories: 12,
    truncated: false,
    cancelled: false,
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

async function openDialog(
  el: LvScanRepositoriesDialog,
  mode: 'scan' | 'offer',
  path = '/code',
): Promise<void> {
  el.scanPath = path;
  el.mode = mode;
  el.open = true;
  await el.updateComplete;
}

function query<T extends Element>(el: LvScanRepositoriesDialog, selector: string): T | null {
  return el.shadowRoot!.querySelector<T>(selector);
}

/** Lit interpolation leaves newlines between values; compare on one line. */
function text(el: LvScanRepositoriesDialog, selector: string): string {
  return (query(el, selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function allText(el: LvScanRepositoriesDialog): string {
  return (el.shadowRoot?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function queryAll<T extends Element>(el: LvScanRepositoriesDialog, selector: string): T[] {
  return Array.from(el.shadowRoot!.querySelectorAll<T>(selector));
}

function buttonWithText(el: LvScanRepositoriesDialog, text: string): HTMLButtonElement {
  const match = queryAll<HTMLButtonElement>(el, 'button').find((b) =>
    (b.textContent ?? '').trim().includes(text),
  );
  if (!match) throw new Error(`no button containing "${text}"`);
  return match;
}

describe('lv-scan-repositories-dialog', () => {
  beforeEach(() => {
    invokeCallArgs.length = 0;
    for (const key of Object.keys(mockResponses)) {
      delete mockResponses[key];
    }
    uiStore.setState({ toasts: [] });
    repositoryStore.getState().reset();
    mockResponses['open_repository'] = (args) => mockRepoPayload(args.path as string);
  });

  it('scans the chosen folder and lists what it found', async () => {
    mockResponses['scan_for_repositories'] = () => scanResult();
    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );

    await openDialog(el, 'scan');
    await waitUntil(() => queryAll(el, '.result-item').length > 0, 'the results list');

    const scanCall = invokeCallArgs.find((c) => c.command === 'scan_for_repositories');
    expect(scanCall?.args.path).to.equal('/code');
    expect(queryAll(el, '.result-item').length).to.equal(2);
    expect(text(el, '.results-toolbar')).to.contain('2 repositories');
    expect(text(el, '.results-toolbar')).to.contain('12 folders');
  });

  it('opens only the selected repositories and closes', async () => {
    mockResponses['scan_for_repositories'] = () => scanResult();
    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );
    let closed = false;
    el.addEventListener('close', () => {
      closed = true;
    });

    await openDialog(el, 'scan');
    await waitUntil(() => queryAll(el, '.result-item').length > 0, 'the results list');

    // Nothing is selected until the user says so.
    expect(buttonWithText(el, 'Open selected').disabled).to.equal(true);

    const firstCheckbox = queryAll<HTMLInputElement>(el, '.result-item input')[0];
    firstCheckbox.click();
    await el.updateComplete;
    expect(buttonWithText(el, 'Open selected (1)').disabled).to.equal(false);

    buttonWithText(el, 'Open selected').click();
    await waitUntil(() => closed, 'the dialog to close after opening');

    const opened = invokeCallArgs
      .filter((c) => c.command === 'open_repository')
      .map((c) => c.args.path);
    expect(opened).to.deep.equal(['/code/alpha']);
    const state = repositoryStore.getState();
    expect(state.openRepositories.map((r) => r.repository.path)).to.deep.equal(['/code/alpha']);
    expect(el.open).to.equal(false);
    const toasts = uiStore.getState().toasts;
    expect(toasts[0].type).to.equal('success');
    expect(toasts[0].message).to.contain('Opened 1 repository');
  });

  it('selects and clears every result', async () => {
    mockResponses['scan_for_repositories'] = () => scanResult();
    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );

    await openDialog(el, 'scan');
    await waitUntil(() => queryAll(el, '.result-item').length > 0, 'the results list');

    buttonWithText(el, 'Select all').click();
    await el.updateComplete;
    expect(buttonWithText(el, 'Open selected (2)')).to.exist;

    buttonWithText(el, 'Clear').click();
    await el.updateComplete;
    expect(buttonWithText(el, 'Open selected (0)').disabled).to.equal(true);
  });

  it('marks a repository that is already open', async () => {
    mockResponses['scan_for_repositories'] = () => scanResult();
    repositoryStore.getState().addRepository(mockRepoPayload('/code/alpha') as any);

    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );
    await openDialog(el, 'scan');
    await waitUntil(() => queryAll(el, '.result-item').length > 0, 'the results list');

    const badges = queryAll(el, '.result-item .badge').map((b) => b.textContent?.trim());
    expect(badges).to.deep.equal(['already open']);
  });

  it('keeps the dialog open and explains when a repository cannot be opened', async () => {
    mockResponses['scan_for_repositories'] = () => scanResult();
    mockResponses['open_repository'] = () => {
      throw new Error('permission denied');
    };
    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );

    await openDialog(el, 'scan');
    await waitUntil(() => queryAll(el, '.result-item').length > 0, 'the results list');
    buttonWithText(el, 'Select all').click();
    await el.updateComplete;
    buttonWithText(el, 'Open selected').click();

    await waitUntil(() => query(el, '.error-message') !== null, 'the failure message');
    expect(text(el, '.error-message')).to.contain('permission denied');
    expect(el.open).to.equal(true, 'the dialog stays open so the user can retry');
    expect(uiStore.getState().toasts[0].type).to.equal('error');
  });

  it('reports an empty scan and offers to initialize the folder', async () => {
    mockResponses['scan_for_repositories'] = () =>
      scanResult({ repositories: [], scannedDirectories: 40 });
    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );

    let initPath: string | undefined;
    el.addEventListener('initialize-repository', (e) => {
      initPath = (e as CustomEvent<{ path: string }>).detail.path;
    });

    await openDialog(el, 'scan');
    await waitUntil(() => text(el, '.explanation').includes('No Git repositories'), 'the empty state');
    expect(text(el, '.notice')).to.contain('Searched 40 folders');

    buttonWithText(el, 'Initialize a repository here').click();
    expect(initPath).to.equal('/code');
    expect(el.open).to.equal(false);
  });

  it('shows the truncation and cancellation notices with the partial results', async () => {
    mockResponses['scan_for_repositories'] = () =>
      scanResult({ truncated: true, cancelled: true });
    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );

    await openDialog(el, 'scan');
    await waitUntil(() => queryAll(el, '.result-item').length > 0, 'the partial results');

    const notices = queryAll(el, '.notice').map((n) => n.textContent ?? '');
    expect(notices.some((n) => n.includes('Scan cancelled'))).to.equal(true);
    expect(notices.some((n) => n.includes('stopped early'))).to.equal(true);
  });

  it('surfaces a scan failure instead of an empty list', async () => {
    mockResponses['scan_for_repositories'] = () => {
      throw new Error('/code no longer exists');
    };
    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );

    await openDialog(el, 'scan');
    await waitUntil(() => query(el, '.error-message') !== null, 'the scan error');
    expect(text(el, '.error-message')).to.contain('no longer exists');
  });

  it('offers a retry when the scan fails', async () => {
    let attempts = 0;
    mockResponses['scan_for_repositories'] = (args) => {
      attempts += 1;
      if (attempts === 1) throw new Error('/code no longer exists');
      return scanResult({ root: args.path as string });
    };
    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );

    await openDialog(el, 'scan');
    await waitUntil(() => query(el, '.error-message') !== null, 'the scan error');

    // Without this the only way out of a failed scan was Close, the welcome
    // screen, Scan, and picking the folder again in an OS picker.
    buttonWithText(el, 'Try again').click();
    await waitUntil(() => queryAll(el, '.result-item').length > 0, 'the retry results');

    expect(
      invokeCallArgs.filter((c) => c.command === 'scan_for_repositories').map((c) => c.args.path),
    ).to.deep.equal(['/code', '/code']);
    expect(query(el, '.error-message'), 'the failure is cleared').to.equal(null);
  });

  it('does not offer a retry when there is no folder to scan', async () => {
    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );

    // The only way into that branch: the offer step with nothing to scan.
    await openDialog(el, 'offer', '');
    buttonWithText(el, 'Scan it for repositories').click();
    await waitUntil(() => query(el, '.error-message') !== null, 'the missing-folder error');
    expect(text(el, '.error-message')).to.contain('No folder was chosen');
    expect(
      queryAll<HTMLButtonElement>(el, 'button').map((b) => (b.textContent ?? '').trim()),
      'retrying nothing would just fail again',
    ).to.deep.equal(['Close']);
  });

  it('cancels a running scan', async () => {
    let finishScan: (value: unknown) => void = () => {};
    mockResponses['scan_for_repositories'] = () =>
      new Promise((resolve) => {
        finishScan = resolve;
      });
    mockResponses['cancel_repository_scan'] = () => null;

    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );
    await openDialog(el, 'scan');
    await waitUntil(() => query(el, '.spinner') !== null, 'the scanning state');
    await waitUntil(
      () => invokeCallArgs.some((c) => c.command === 'scan_for_repositories'),
      'the scan to reach the backend',
    );

    buttonWithText(el, 'Cancel scan').click();
    await waitUntil(
      () => invokeCallArgs.some((c) => c.command === 'cancel_repository_scan'),
      'the cancel command',
    );
    await el.updateComplete;
    expect(buttonWithText(el, 'Cancelling…').disabled).to.equal(true);

    finishScan(scanResult({ repositories: [], cancelled: true }));
    await waitUntil(
      () => allText(el).includes('before the scan was cancelled'),
      'the cancelled empty state',
    );
  });

  it('never starts a scan the user cancelled before it was sent', async () => {
    // Hold the progress-listener registration open, which is what runs before
    // the scan command is sent.
    let releaseListen: (value: unknown) => void = () => {};
    mockResponses['plugin:event|listen'] = () =>
      new Promise((resolve) => {
        releaseListen = resolve;
      });
    mockResponses['scan_for_repositories'] = () => scanResult();
    mockResponses['cancel_repository_scan'] = () => null;

    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );
    await openDialog(el, 'scan');
    await waitUntil(() => query(el, '.spinner') !== null, 'the scanning state');

    buttonWithText(el, 'Cancel scan').click();
    releaseListen(1);

    await waitUntil(
      () => allText(el).includes('before the scan was cancelled'),
      'the cancelled empty state',
    );
    expect(
      invokeCallArgs.some((c) => c.command === 'scan_for_repositories'),
      'no scan is started once the user has cancelled',
    ).to.equal(false);
  });

  it('offers a scan or an init for a dropped folder that is not a repository', async () => {
    mockResponses['scan_for_repositories'] = () => scanResult();
    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );

    await openDialog(el, 'offer', '/projects');
    expect(text(el, '.explanation')).to.contain('not a Git repository');
    expect(text(el, '.folder-path')).to.contain('/projects');
    // Nothing is scanned until the user asks for it.
    expect(invokeCallArgs.some((c) => c.command === 'scan_for_repositories')).to.equal(false);

    buttonWithText(el, 'Scan it for repositories').click();
    await waitUntil(() => queryAll(el, '.result-item').length > 0, 'the results list');
    expect(
      invokeCallArgs.find((c) => c.command === 'scan_for_repositories')?.args.path,
    ).to.equal('/projects');
  });

  it('re-scans a folder dropped while the dialog is already open', async () => {
    mockResponses['scan_for_repositories'] = (args) =>
      scanResult({ root: args.path as string });
    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );

    await openDialog(el, 'scan', '/code');
    await waitUntil(() => queryAll(el, '.result-item').length > 0, 'the first results list');

    // A second OS drop: the shell writes the new folder and asks the dialog
    // store to open a dialog that is already open, so `open` never changes.
    el.scanPath = '/other';
    await el.updateComplete;

    await waitUntil(
      () =>
        invokeCallArgs.filter((c) => c.command === 'scan_for_repositories').length === 2,
      'the second folder to be scanned',
    );
    expect(
      invokeCallArgs.filter((c) => c.command === 'scan_for_repositories').map((c) => c.args.path),
    ).to.deep.equal(['/code', '/other']);
    await waitUntil(() => text(el, '.folder-path').includes('/other'), 'the new folder on screen');
    // The drop must not be silent (CLAUDE.md: every user-initiated operation
    // gives feedback).
    expect(uiStore.getState().toasts.map((t: any) => t.message).join(' ')).to.contain('other');
  });

  it('never lets the previous folder\'s scan land on the folder that replaced it', async () => {
    let finishFirst: (value: unknown) => void = () => {};
    mockResponses['scan_for_repositories'] = (args) =>
      (args.path as string) === '/code'
        ? new Promise((resolve) => {
            finishFirst = resolve;
          })
        : scanResult({ root: args.path as string });
    mockResponses['cancel_repository_scan'] = () => null;

    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );
    await openDialog(el, 'scan', '/code');
    await waitUntil(
      () => invokeCallArgs.some((c) => c.command === 'scan_for_repositories'),
      'the first scan to reach the backend',
    );

    // Re-targeted at a folder that only wants the offer step.
    el.scanPath = '/other';
    el.mode = 'offer';
    await el.updateComplete;
    await waitUntil(
      () => query(el, '.offer-actions') !== null,
      'the offer for the new folder',
    );

    // The abandoned scan finishes now: its repositories belong to /code and
    // must never appear under /other.
    finishFirst(scanResult({ root: '/code' }));
    await aTimeout(0);
    await el.updateComplete;

    expect(queryAll(el, '.result-item').length, 'no stale results').to.equal(0);
    expect(text(el, '.folder-path')).to.contain('/other');
    expect(allText(el)).to.not.contain('/code/alpha');
  });

  it('issues exactly one cancel when a running scan is re-targeted', async () => {
    // Two cancels for one re-target is not just noise: the backend clears its
    // cancellation flag when a scan STARTS, so a second cancel still in flight
    // can land after the new scan has started and abort the folder the user
    // just dropped. The re-target waits for the cancel it actually fired.
    mockResponses['scan_for_repositories'] = (args) =>
      (args.path as string) === '/code'
        ? new Promise(() => {})
        : scanResult({ root: args.path as string });
    mockResponses['cancel_repository_scan'] = () => null;

    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );
    await openDialog(el, 'scan', '/code');
    await waitUntil(
      () => invokeCallArgs.some((c) => c.command === 'scan_for_repositories'),
      'the first scan to reach the backend',
    );

    el.scanPath = '/other';
    await el.updateComplete;
    await waitUntil(() => queryAll(el, '.result-item').length > 0, 'the new folder\'s results');

    expect(
      invokeCallArgs.filter((c) => c.command === 'cancel_repository_scan').length,
      'one cancel for one abandoned scan',
    ).to.equal(1);
    // And it is ordered before the scan it was waiting to make room for.
    const commands = invokeCallArgs.map((c) => c.command);
    expect(commands.indexOf('cancel_repository_scan')).to.be.lessThan(
      commands.lastIndexOf('scan_for_repositories'),
    );
  });

  it('initializes the folder it is showing after being re-targeted', async () => {
    mockResponses['scan_for_repositories'] = (args) =>
      scanResult({ root: args.path as string, repositories: [], scannedDirectories: 3 });
    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );

    let initPath: string | undefined;
    el.addEventListener('initialize-repository', (e) => {
      initPath = (e as CustomEvent<{ path: string }>).detail.path;
    });

    await openDialog(el, 'scan', '/code');
    await waitUntil(() => text(el, '.explanation').includes('No Git repositories'), 'the first empty state');

    el.scanPath = '/other';
    await el.updateComplete;
    await waitUntil(
      () => text(el, '.folder-path') === '/other',
      'the empty state for the new folder',
    );

    const onScreen = text(el, '.folder-path');
    buttonWithText(el, 'Initialize a repository here').click();
    expect(initPath, 'init acts on the folder named on screen').to.equal(onScreen);
    expect(initPath).to.equal('/other');
  });

  /**
   * The open loop takes seconds per repository, and an OS folder drop is not
   * blocked by the modal: the dialog can be re-pointed at another folder while
   * it is still opening. The loop that no longer owns the dialog must not write
   * its outcome — or its close — over what the user is looking at now.
   */
  it('does not close the re-targeted dialog when an abandoned open finishes', async () => {
    let finishAlpha: (value: unknown) => void = () => {};
    mockResponses['scan_for_repositories'] = (args) => scanResult({ root: args.path as string });
    mockResponses['open_repository'] = (args) => {
      const path = args.path as string;
      if (path === '/code/alpha') {
        return new Promise((resolve) => {
          finishAlpha = () => resolve(mockRepoPayload(path));
        });
      }
      return mockRepoPayload(path);
    };

    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );
    let closed = 0;
    el.addEventListener('close', () => {
      closed += 1;
    });

    await openDialog(el, 'scan', '/code');
    await waitUntil(() => queryAll(el, '.result-item').length > 0, 'the first results list');
    buttonWithText(el, 'Select all').click();
    await el.updateComplete;
    buttonWithText(el, 'Open selected').click();
    await waitUntil(
      () => invokeCallArgs.some((c) => c.command === 'open_repository'),
      'the open loop to start',
    );

    // A second folder is dropped while the repositories are still opening.
    el.scanPath = '/other';
    await el.updateComplete;
    await waitUntil(
      () => text(el, '.folder-path').includes('/other'),
      'the dialog re-targeted at the dropped folder',
    );

    // The abandoned loop finishes now.
    finishAlpha(null);
    await waitUntil(
      () =>
        invokeCallArgs.filter((c) => c.command === 'open_repository').length === 2,
      'the abandoned loop to open the rest of its selection',
    );
    await aTimeout(0);
    await el.updateComplete;

    expect(closed, 'the re-targeted dialog is never closed by the old loop').to.equal(0);
    expect(el.open).to.equal(true);
    expect(text(el, '.folder-path')).to.contain('/other');
    expect(query(el, '.error-message'), 'no stale error over the new folder').to.equal(null);
    // The repositories DID open, so that is still reported — as a toast, which
    // says what happened without touching the screen the user moved on to.
    expect(uiStore.getState().toasts.map((t: any) => t.message).join(' ')).to.contain(
      'Opened 2 repositories',
    );
    expect(
      repositoryStore.getState().openRepositories.map((r) => r.repository.path),
    ).to.deep.equal(['/code/alpha', '/code/beta']);
  });

  it('reports an abandoned open that failed instead of dropping it', async () => {
    let failAlpha: () => void = () => {};
    mockResponses['scan_for_repositories'] = (args) => scanResult({ root: args.path as string });
    mockResponses['open_repository'] = (args) => {
      const path = args.path as string;
      if (path === '/code/alpha') {
        return new Promise((_resolve, reject) => {
          failAlpha = () => reject(new Error('permission denied'));
        });
      }
      return mockRepoPayload(path);
    };

    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );
    await openDialog(el, 'scan', '/code');
    await waitUntil(() => queryAll(el, '.result-item').length > 0, 'the first results list');
    queryAll<HTMLInputElement>(el, '.result-item input')[0].click();
    await el.updateComplete;
    buttonWithText(el, 'Open selected').click();
    await waitUntil(
      () => invokeCallArgs.some((c) => c.command === 'open_repository'),
      'the open loop to start',
    );

    el.scanPath = '/other';
    await el.updateComplete;
    await waitUntil(
      () => text(el, '.folder-path').includes('/other'),
      'the dialog re-targeted at the dropped folder',
    );
    uiStore.setState({ toasts: [] });

    failAlpha();
    await waitUntil(
      () => uiStore.getState().toasts.length > 0,
      'the abandoned failure to be reported',
    );

    const toast = uiStore.getState().toasts[0] as any;
    expect(toast.type).to.equal('error');
    expect(toast.message).to.contain('permission denied');
    // The failure belongs to the folder the user left, so it must not be
    // written into the new folder's screen.
    expect(query(el, '.error-message'), 'no stale error over the new folder').to.equal(null);
    expect(el.open).to.equal(true);
  });

  it('refuses Escape while repositories are still being opened', async () => {
    let finishAlpha: (value: unknown) => void = () => {};
    mockResponses['scan_for_repositories'] = () => scanResult();
    mockResponses['open_repository'] = (args) => {
      const path = args.path as string;
      if (path === '/code/alpha') {
        return new Promise((resolve) => {
          finishAlpha = () => resolve(mockRepoPayload(path));
        });
      }
      return mockRepoPayload(path);
    };

    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );
    let closed = 0;
    el.addEventListener('close', () => {
      closed += 1;
    });

    await openDialog(el, 'scan', '/code');
    await waitUntil(() => queryAll(el, '.result-item').length > 0, 'the results list');
    queryAll<HTMLInputElement>(el, '.result-item input')[0].click();
    await el.updateComplete;
    buttonWithText(el, 'Open selected').click();
    await waitUntil(
      () => invokeCallArgs.some((c) => c.command === 'open_repository'),
      'the open loop to start',
    );

    // Escape, the overlay and the × all arrive as the modal's close event.
    query(el, 'lv-modal')!.dispatchEvent(new CustomEvent('close'));
    await el.updateComplete;
    expect(closed, 'Escape is refused while repositories are opening').to.equal(0);
    expect(el.open).to.equal(true);

    finishAlpha(null);
    await waitUntil(() => closed === 1, 'the dialog closes once the open finishes');
  });

  /**
   * Dropping the SAME folder again changes neither `scanPath` nor `mode`, and
   * the dialog is already open, so the only thing that says the drop happened
   * is the shell's request counter. Without it the drop was completely silent —
   * the one drop outcome in the app that said nothing at all.
   */
  it('rescans and says so when the same folder is dropped again', async () => {
    mockResponses['scan_for_repositories'] = (args) => scanResult({ root: args.path as string });
    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );

    await openDialog(el, 'scan', '/code');
    await waitUntil(() => queryAll(el, '.result-item').length > 0, 'the first results list');
    uiStore.setState({ toasts: [] });

    el.requestId = 1;
    await el.updateComplete;

    await waitUntil(
      () => invokeCallArgs.filter((c) => c.command === 'scan_for_repositories').length === 2,
      'the folder to be scanned again',
    );
    expect(
      invokeCallArgs.filter((c) => c.command === 'scan_for_repositories').map((c) => c.args.path),
    ).to.deep.equal(['/code', '/code']);
    expect(uiStore.getState().toasts.map((t: any) => t.message).join(' ')).to.contain(
      'Rescanning code',
    );
  });

  it('restates the offer when a folder that is not a repository is dropped again', async () => {
    mockResponses['scan_for_repositories'] = () => scanResult();
    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );

    await openDialog(el, 'offer', '/projects');
    expect(text(el, '.explanation')).to.contain('not a Git repository');
    uiStore.setState({ toasts: [] });

    el.requestId = 1;
    await el.updateComplete;
    await aTimeout(0);

    // Nothing was scanned: the offer is what the user has to answer.
    expect(invokeCallArgs.some((c) => c.command === 'scan_for_repositories')).to.equal(false);
    expect(query(el, '.offer-actions'), 'still on the offer').to.not.equal(null);
    expect(uiStore.getState().toasts.map((t: any) => t.message).join(' ')).to.contain(
      'projects is still not a Git repository',
    );
  });

  it('rescans a dropped folder that has already been scanned once', async () => {
    mockResponses['scan_for_repositories'] = (args) => scanResult({ root: args.path as string });
    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );

    await openDialog(el, 'offer', '/projects');
    buttonWithText(el, 'Scan it for repositories').click();
    await waitUntil(() => queryAll(el, '.result-item').length > 0, 'the first results list');
    uiStore.setState({ toasts: [] });

    // Re-dropping a folder whose results are on screen means "look again" —
    // the user has just created (or cloned) something in it.
    el.requestId = 1;
    await el.updateComplete;

    await waitUntil(
      () => invokeCallArgs.filter((c) => c.command === 'scan_for_repositories').length === 2,
      'the folder to be scanned again',
    );
    expect(uiStore.getState().toasts.map((t: any) => t.message).join(' ')).to.contain(
      'Rescanning projects',
    );
  });

  it('recovers from a failed scan when the folder is dropped again', async () => {
    let attempts = 0;
    mockResponses['scan_for_repositories'] = (args) => {
      attempts += 1;
      if (attempts === 1) throw new Error('/code no longer exists');
      return scanResult({ root: args.path as string });
    };
    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );

    await openDialog(el, 'scan', '/code');
    await waitUntil(() => query(el, '.error-message') !== null, 'the scan error');

    el.requestId = 1;
    await el.updateComplete;

    await waitUntil(() => queryAll(el, '.result-item').length > 0, 'the retry results');
    expect(query(el, '.error-message'), 'the error is cleared').to.equal(null);
  });

  it('asks the backend to stop a scan the user closed', async () => {
    mockResponses['scan_for_repositories'] = () => new Promise(() => {});
    mockResponses['cancel_repository_scan'] = () => null;

    const el = await fixture<LvScanRepositoriesDialog>(
      html`<lv-scan-repositories-dialog></lv-scan-repositories-dialog>`,
    );
    await openDialog(el, 'scan');
    await waitUntil(
      () => invokeCallArgs.some((c) => c.command === 'scan_for_repositories'),
      'the scan to reach the backend',
    );

    el.open = false;
    await el.updateComplete;

    await waitUntil(
      () => invokeCallArgs.some((c) => c.command === 'cancel_repository_scan'),
      'the scan to be cancelled on close',
    );
  });
});
