/**
 * Focus entry tests for the three destructive dialogs that build their own
 * overlay instead of using <gn-modal>.
 *
 * None of them contained a single focus(), autofocus or tabindex: opening one
 * from the command palette left focus on <body> (the palette restores focus to
 * a host that carries no tabindex), so Tab started at the skip link and walked
 * the toolbar, dashboard, sidebar and graph — every Enter on the way acting on
 * a live control UNDERNEATH the backdrop — before ever reaching the dialog.
 *
 * Also covers the conflict dialog's abort confirm, which rendered last over a
 * still-live dialog: focus stayed on the button underneath it, Escape was
 * swallowed, and "Complete Merge" still committed.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invokeHistory: Array<{ command: string; args?: unknown }> = [];

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import '../gn-clean-dialog.ts';
import '../gn-reflog-dialog.ts';
import '../gn-conflict-resolution-dialog.ts';
import type { GnCleanDialog } from '../gn-clean-dialog.ts';
import type { GnReflogDialog } from '../gn-reflog-dialog.ts';
import type { GnConflictResolutionDialog } from '../gn-conflict-resolution-dialog.ts';
import type { ConflictFile, ReflogEntry } from '../../../types/git.types.ts';
import { deepActiveElement } from '../../../utils/focus.ts';
import { resetOverlayStack } from '../../../utils/overlay-stack.ts';
import { resetRefOpLocks } from '../../../utils/ref-lock.ts';
import { uiStore } from '../../../stores/ui.store.ts';

const REPO_PATH = '/test/repo';

const REFLOG_ENTRY = {
  oid: 'deadbeef1234',
  shortId: 'deadbee',
  refName: 'HEAD',
  message: 'commit: something',
  operation: 'commit',
  committer: { name: 'T', email: 't@example.com', timestamp: 1 },
  timestamp: 1,
  index: 0,
} as unknown as ReflogEntry;

function makeConflict(path: string): ConflictFile {
  return {
    path,
    ancestor: { oid: 'base', path, mode: 0o100644 },
    ours: { oid: 'ours', path, mode: 0o100644 },
    theirs: { oid: 'theirs', path, mode: 0o100644 },
    isBinary: false,
  };
}

/** Resolve after the dialogs' requestAnimationFrame focus pass. */
function afterFocusPass(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function pressKey(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  return event;
}

describe('destructive dialogs take focus when they open', () => {
  beforeEach(() => {
    resetOverlayStack();
    resetRefOpLocks();
    invokeHistory.length = 0;
    uiStore.setState({ toasts: [] });
    mockInvoke = async (command: string) => {
      switch (command) {
        case 'get_cleanable_files':
          return [{ path: 'junk.txt', isDirectory: false, isIgnored: false, isNestedRepo: false, size: 12 }];
        case 'get_reflog':
          return [REFLOG_ENTRY];
        case 'get_conflicts':
          return [makeConflict('src/main.ts')];
        default:
          return null;
      }
    };
    document.body.focus();
  });

  // ── gn-clean-dialog ──────────────────────────────────────────────────────
  it('clean dialog focuses Cancel — not the delete button — on open', async () => {
    const el = await fixture<GnCleanDialog>(
      html`<gn-clean-dialog .repositoryPath=${REPO_PATH}></gn-clean-dialog>`,
    );
    await el.updateComplete;
    expect(deepActiveElement() === null, 'focus starts outside the dialog, on <body>').to.be.true;

    el.open = true;
    await el.updateComplete;
    await afterFocusPass();

    const cancelBtn = el.shadowRoot!.querySelector('.footer-right .btn-secondary');
    const deleteBtn = el.shadowRoot!.querySelector('.footer-right .btn-danger');
    expect(cancelBtn, 'the dialog rendered its Cancel button').to.exist;
    expect(deepActiveElement() === cancelBtn, 'Cancel holds focus').to.be.true;
    expect(deepActiveElement() === deleteBtn, 'the destructive button is not one Enter away').to.be
      .false;
  });

  it('clean dialog leaves focus alone when the user already moved it into the dialog', async () => {
    const el = await fixture<GnCleanDialog>(
      html`<gn-clean-dialog .repositoryPath=${REPO_PATH}></gn-clean-dialog>`,
    );
    await el.updateComplete;

    el.open = true;
    await el.updateComplete;
    // Same window a real user has: the dialog is on screen but the deferred
    // focus pass has not run yet.
    const closeBtn = el.shadowRoot!.querySelector('.header .close-btn') as HTMLElement;
    closeBtn.focus();
    await afterFocusPass();

    expect(deepActiveElement() === closeBtn, 'the deferred pass did not yank focus').to.be.true;
  });

  // ── gn-reflog-dialog ─────────────────────────────────────────────────────
  it('reflog dialog focuses its close button on open', async () => {
    const el = await fixture<GnReflogDialog>(
      html`<gn-reflog-dialog .repositoryPath=${REPO_PATH}></gn-reflog-dialog>`,
    );
    await el.updateComplete;
    expect(deepActiveElement() === null, 'focus starts outside the dialog').to.be.true;

    el.open = true;
    await el.updateComplete;
    await afterFocusPass();

    const closeBtn = el.shadowRoot!.querySelector('.close-btn');
    expect(closeBtn, 'the dialog rendered its close button').to.exist;
    expect(deepActiveElement() === closeBtn, 'the close button holds focus').to.be.true;
  });

  // ── gn-conflict-resolution-dialog ────────────────────────────────────────
  it('conflict dialog moves focus inside itself on open', async () => {
    const el = await fixture<GnConflictResolutionDialog>(html`
      <gn-conflict-resolution-dialog
        .repositoryPath=${REPO_PATH}
        .operationType=${'merge'}
      ></gn-conflict-resolution-dialog>
    `);
    await el.updateComplete;
    expect(deepActiveElement() === null, 'focus starts outside the dialog').to.be.true;

    el.open = true;
    await el.updateComplete;
    await afterFocusPass();

    const dialog = el.shadowRoot!.querySelector('.dialog');
    expect(dialog, 'the dialog rendered').to.exist;
    const active = deepActiveElement();
    expect(active !== null, 'focus is no longer on <body>').to.be.true;
    expect(
      active !== null && el.shadowRoot!.contains(active),
      'focus is inside the dialog, so Tab starts there and not at the skip link',
    ).to.be.true;
  });
});

describe('conflict dialog abort confirm', () => {
  async function openWithConfirm(): Promise<GnConflictResolutionDialog> {
    const el = await fixture<GnConflictResolutionDialog>(html`
      <gn-conflict-resolution-dialog
        .repositoryPath=${REPO_PATH}
        .operationType=${'merge'}
      ></gn-conflict-resolution-dialog>
    `);
    el.open = true;
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 50));
    await el.updateComplete;
    await afterFocusPass();

    // Every conflict resolved, so nothing but the confirm stands between the
    // user and a committed merge.
    (el as unknown as { resolvedFiles: Set<string> }).resolvedFiles = new Set(['src/main.ts']);
    await el.updateComplete;

    const abortBtn = Array.from(el.shadowRoot!.querySelectorAll('.footer-actions .btn')).find((b) =>
      /^Abort/.test(b.textContent!.trim()),
    ) as HTMLButtonElement;
    abortBtn.focus();
    abortBtn.click();
    await el.updateComplete;
    await afterFocusPass();
    return el;
  }

  beforeEach(() => {
    resetOverlayStack();
    resetRefOpLocks();
    invokeHistory.length = 0;
    uiStore.setState({ toasts: [] });
    mockInvoke = async (command: string) => {
      if (command === 'get_conflicts') return [makeConflict('src/main.ts')];
      return null;
    };
    document.body.focus();
  });

  it('focuses Cancel instead of leaving focus on the button underneath', async () => {
    const el = await openWithConfirm();

    const confirmOverlay = el.shadowRoot!.querySelector('.confirm-overlay');
    expect(confirmOverlay, 'the confirm is up').to.exist;

    const cancelBtn = el.shadowRoot!.querySelector('.confirm-actions .btn:not(.btn-danger)');
    const confirmAbort = el.shadowRoot!.querySelector('.confirm-actions .btn-danger');
    expect(deepActiveElement() === cancelBtn, 'Cancel holds focus').to.be.true;
    expect(deepActiveElement() === confirmAbort, 'the Abort button is not focused').to.be.false;
  });

  it('Escape dismisses the confirm and keeps the dialog open', async () => {
    const el = await openWithConfirm();

    const event = pressKey('Escape');
    await el.updateComplete;

    expect(event.defaultPrevented, 'the dialog still owns Escape').to.be.true;
    // Compared as a boolean on purpose: a failing chai assertion whose ACTUAL
    // value is a DOM node tries to serialize this dialog's whole subtree.
    expect(
      el.shadowRoot!.querySelector('.confirm-overlay') === null,
      'the confirm is gone',
    ).to.be.true;
    expect(el.open, 'the dialog itself stays open').to.be.true;
    expect(
      invokeHistory.some((h) => h.command === 'abort_merge'),
      'Escape cancels, it does not abort',
    ).to.be.false;
  });

  it('Escape with no confirm up still does not close the dialog', async () => {
    const el = await fixture<GnConflictResolutionDialog>(html`
      <gn-conflict-resolution-dialog
        .repositoryPath=${REPO_PATH}
        .operationType=${'merge'}
      ></gn-conflict-resolution-dialog>
    `);
    el.open = true;
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 50));
    await el.updateComplete;

    const event = pressKey('Escape');
    await el.updateComplete;

    expect(event.defaultPrevented).to.be.true;
    expect(el.open, 'Escape never closes the dialog outright').to.be.true;
  });

  it('Complete Merge is inert while the confirm is up', async () => {
    const el = await openWithConfirm();

    const completeBtn = Array.from(
      el.shadowRoot!.querySelectorAll('.footer-actions .btn'),
    ).find((b) => b.textContent!.trim() === 'Complete Merge') as HTMLButtonElement;
    expect(completeBtn, 'the Complete button rendered').to.exist;
    expect(completeBtn.disabled, 'Complete is disabled behind the confirm').to.be.true;
  });

  it('Complete Merge cannot commit the merge while the confirm is up', async () => {
    const el = await openWithConfirm();
    invokeHistory.length = 0;

    await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.call(el);

    expect(
      invokeHistory.some((h) => h.command === 'commit_merge'),
      'no merge was committed out from under the "cannot be undone" confirm',
    ).to.be.false;
    expect(el.shadowRoot!.querySelector('.confirm-overlay'), 'the confirm is still up').to.exist;
  });

  it('Complete Merge still commits once the confirm is cancelled', async () => {
    const el = await openWithConfirm();

    pressKey('Escape');
    await el.updateComplete;
    invokeHistory.length = 0;

    await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.call(el);

    expect(
      invokeHistory.some((h) => h.command === 'commit_merge'),
      'the guard only blocks while the confirm is displayed',
    ).to.be.true;
  });
});
