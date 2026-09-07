/**
 * What a `repository-scan-resolved` does to the scan dialog.
 *
 * The event fires when a folder the dialog is talking about turns out to be a
 * repository after all — the user ran `git init` in it (or cloned into it) and
 * dropped it again, which opens it as a tab. The offer on screen ("This folder
 * is not a Git repository", with an Initialize action) is then false, so it
 * goes.
 *
 * A LIST OF RESULTS is not that: it is a walk the user asked for and a set of
 * ticks they made, and there is no way back to it but a full rescan. Closing
 * the dialog in that phase threw both away — and in `scanning` it aborted a
 * walk the user was waiting on.
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
import { expect } from '@open-wc/testing';
import type { AppShell } from '../app-shell.ts';
import '../app-shell.ts';
import { dialogs } from '../stores/dialog.store.ts';
import { uiStore, repositoryStore } from '../stores/index.ts';
import {
  REPOSITORY_SCAN_OFFER_EVENT,
  REPOSITORY_SCAN_RESOLVED_EVENT,
} from '../services/window-drop.service.ts';
import type { LvScanRepositoriesDialog } from '../components/dialogs/lv-scan-repositories-dialog.ts';
import type { RepositoryScanResult } from '../services/repo-scan.service.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DROPPED = '/home/user/projects';

function scanResult(over: Partial<RepositoryScanResult> = {}): RepositoryScanResult {
  return {
    root: DROPPED,
    repositories: [
      { path: `${DROPPED}/alpha`, name: 'alpha', isBare: false },
      { path: `${DROPPED}/beta`, name: 'beta', isBare: false },
    ],
    scannedDirectories: 40,
    truncated: false,
    cancelled: false,
    ...over,
  };
}

async function mountShell(): Promise<AppShell> {
  const el = document.createElement('lv-app-shell') as AppShell;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

function scanDialog(el: AppShell): LvScanRepositoriesDialog {
  const dialog = el.shadowRoot!.querySelector('lv-scan-repositories-dialog');
  if (!dialog) throw new Error('the shell renders no scan dialog');
  return dialog;
}

/** Drop a folder that is not a repository, as the drop service does. */
async function openOffer(el: AppShell): Promise<LvScanRepositoriesDialog> {
  window.dispatchEvent(
    new CustomEvent<{ path: string }>(REPOSITORY_SCAN_OFFER_EVENT, { detail: { path: DROPPED } }),
  );
  await el.updateComplete;
  const dialog = scanDialog(el);
  await dialog.updateComplete;
  return dialog;
}

/** Take the offer, and wait for the phase the mocked scan produces. */
async function scanFromOffer(
  dialog: LvScanRepositoriesDialog,
  ready: (dialog: LvScanRepositoriesDialog) => boolean,
): Promise<void> {
  const scanButton = [
    ...dialog.shadowRoot!.querySelectorAll<HTMLButtonElement>('.offer-actions button'),
  ].find((b) => b.textContent?.includes('Scan it for repositories'));
  if (!scanButton) throw new Error('no "Scan it for repositories" action on the offer');
  scanButton.click();
  await waitFor(() => ready(dialog));
  await dialog.updateComplete;
}

async function waitFor(predicate: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The folder became a repository and was opened, as the drop service reports. */
async function reportResolved(el: AppShell, path = DROPPED): Promise<void> {
  window.dispatchEvent(
    new CustomEvent<{ path: string }>(REPOSITORY_SCAN_RESOLVED_EVENT, { detail: { path } }),
  );
  await el.updateComplete;
  await scanDialog(el).updateComplete;
}

describe('app-shell: a folder that became a repository', () => {
  let shell: AppShell | null = null;

  beforeEach(() => {
    dialogs.reset();
    invokeCallArgs.length = 0;
    for (const key of Object.keys(mockResponses)) delete mockResponses[key];
    uiStore.setState({ toasts: [] });
    repositoryStore.setState({ openRepositories: [], activeIndex: -1 } as any);
  });

  afterEach(() => {
    shell?.remove();
    shell = null;
    dialogs.reset();
  });

  it('closes the offer, which is now asking a question with a false premise', async () => {
    shell = await mountShell();
    await openOffer(shell);
    expect(dialogs.isOpen('repositoryScan'), 'the offer is up').to.be.true;

    await reportResolved(shell);

    // "This folder is not a Git repository" is no longer true, and its
    // Initialize action would hand a real repository to `init`.
    expect(dialogs.isOpen('repositoryScan'), 'the offer goes').to.be.false;
  });

  it('keeps a list of results, and the ticks made on it', async () => {
    mockResponses['scan_for_repositories'] = () => scanResult();
    shell = await mountShell();
    const dialog = await openOffer(shell);
    await scanFromOffer(dialog, (d) => d.shadowRoot!.querySelector('.result-item') !== null);

    const boxes = dialog.shadowRoot!.querySelectorAll<HTMLInputElement>(
      '.results-list input[type="checkbox"]',
    );
    expect(boxes.length, 'both repositories listed').to.equal(2);
    boxes[0].click();
    await dialog.updateComplete;

    await reportResolved(shell);

    // The walk and the tick are the user's work; the only way back to them is
    // a full rescan, and the drop already said what it did ("Opened …").
    expect(dialogs.isOpen('repositoryScan'), 'the results stay').to.be.true;
    expect(
      dialog.shadowRoot!.querySelectorAll('.result-item').length,
      'the results are still on screen',
    ).to.equal(2);
    expect(
      dialog.shadowRoot!.querySelectorAll<HTMLInputElement>(
        '.results-list input[type="checkbox"]',
      )[0].checked,
      'the selection survives',
    ).to.be.true;
  });

  it('closes the empty-results screen, whose only action is Initialize', async () => {
    mockResponses['scan_for_repositories'] = () => scanResult({ repositories: [] });
    shell = await mountShell();
    const dialog = await openOffer(shell);
    await scanFromOffer(dialog, (d) =>
      (d.shadowRoot!.textContent ?? '').includes('No Git repositories were found'),
    );

    expect(
      dialog.shadowRoot!.textContent,
      'the empty-results screen is up',
    ).to.include('No Git repositories were found');

    await reportResolved(shell);

    expect(dialogs.isOpen('repositoryScan'), 'nothing left to ask').to.be.false;
  });

  it('does not abort a scan the user is waiting on', async () => {
    let finishScan: (() => void) | null = null;
    mockResponses['scan_for_repositories'] = () =>
      new Promise((resolve) => {
        finishScan = () => resolve(scanResult());
      });
    shell = await mountShell();
    const dialog = await openOffer(shell);
    await scanFromOffer(dialog, (d) => d.shadowRoot!.querySelector('.progress') !== null);

    await reportResolved(shell);

    expect(dialogs.isOpen('repositoryScan'), 'the walk carries on').to.be.true;
    expect(
      invokeCallArgs.some((c) => c.command === 'cancel_repository_scan'),
      'nothing cancelled the walk',
    ).to.be.false;

    (finishScan as unknown as () => void)?.();
    await waitFor(() => dialog.shadowRoot!.querySelector('.result-item') !== null);
  });

  it('ignores a folder other than the one on screen', async () => {
    shell = await mountShell();
    await openOffer(shell);

    await reportResolved(shell, '/home/user/somewhere-else');

    expect(dialogs.isOpen('repositoryScan'), 'another folder is not this one').to.be.true;
  });
});
