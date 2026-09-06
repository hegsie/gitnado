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
import { expect, fixture, html, waitUntil } from '@open-wc/testing';
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
