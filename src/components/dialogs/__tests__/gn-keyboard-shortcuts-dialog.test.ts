/**
 * Tests for gn-keyboard-shortcuts-dialog's key-recording mode.
 *
 * KeyboardService registers its `document` keydown listener at MODULE
 * evaluation, so it always runs before this dialog's (registered in
 * connectedCallback) — and stopPropagation() cannot suppress a listener on the
 * same node. So the key being recorded was executed first: pressing "s" to
 * rebind a shortcut staged the whole working tree, Ctrl+Shift+S stashed
 * including untracked files, Ctrl+Shift+U pushed. It also swallowed the
 * "Esc to cancel" the dialog advertises, closing the entire dialog instead.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import { keyboardService } from '../../../services/keyboard.service.ts';
import { resetOverlayStack } from '../../../utils/overlay-stack.ts';
import type { GnKeyboardShortcutsDialog } from '../gn-keyboard-shortcuts-dialog.ts';
import '../gn-keyboard-shortcuts-dialog.ts';

interface Internal {
  editingId: string | null;
  startEditing: (id: string) => void;
  cancelEditing: () => void;
}

function internalOf(el: GnKeyboardShortcutsDialog): Internal {
  return el as unknown as Internal;
}

async function openDialog(): Promise<GnKeyboardShortcutsDialog> {
  const el = await fixture<GnKeyboardShortcutsDialog>(
    html`<gn-keyboard-shortcuts-dialog ?open=${true}></gn-keyboard-shortcuts-dialog>`
  );
  await el.updateComplete;
  return el;
}

describe('gn-keyboard-shortcuts-dialog recording mode', () => {
  afterEach(() => {
    // Never leave the service disabled — or an overlay registered — for the
    // next test.
    keyboardService.setEnabled(true);
    resetOverlayStack();
  });

  it('does not run a shortcut while capturing its replacement', async () => {
    let fired = 0;
    keyboardService.register('test-destructive', {
      key: 'y',
      action: () => { fired++; },
      description: 'destructive probe',
      category: 'Test',
    });

    const el = await openDialog();
    try {
      internalOf(el).startEditing('test-destructive');
      await el.updateComplete;

      // The key the user is recording must be captured, NOT executed. This is
      // the whole bug: "s" staged the working tree before being recorded.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y' }));

      expect(fired, 'the shortcut must not run while being rebound').to.equal(0);
    } finally {
      keyboardService.unregister('test-destructive');
    }
  });

  it('re-enables shortcuts once recording is cancelled', async () => {
    let fired = 0;
    keyboardService.register('test-restore', {
      key: 'y',
      action: () => { fired++; },
      description: 'restore probe',
      category: 'Test',
    });

    const el = await openDialog();
    try {
      internalOf(el).startEditing('test-restore');
      await el.updateComplete;
      internalOf(el).cancelEditing();
      await el.updateComplete;

      // The assertion is that cancelEditing re-enabled the service. The dialog
      // has to be closed to see it: an open dialog now blocks plain keys on
      // purpose, so that reading "S — Stage all changes" and pressing S does
      // not stage the working tree.
      el.open = false;
      await el.updateComplete;

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y' }));

      expect(fired, 'shortcuts work again after cancelling').to.equal(1);
    } finally {
      keyboardService.unregister('test-restore');
    }
  });

  // The inverse failure: leaving the service disabled kills every shortcut in
  // the app with no way back.
  it('re-enables shortcuts if torn down mid-recording', async () => {
    let fired = 0;
    keyboardService.register('test-teardown', {
      key: 'y',
      action: () => { fired++; },
      description: 'teardown probe',
      category: 'Test',
    });

    const el = await openDialog();
    try {
      internalOf(el).startEditing('test-teardown');
      await el.updateComplete;

      el.remove();
      await new Promise((r) => setTimeout(r, 0));

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y' }));

      expect(fired, 'shortcuts must survive a mid-recording teardown').to.equal(1);
    } finally {
      keyboardService.unregister('test-teardown');
    }
  });

  // The finding: the dialog silenced the service only while RECORDING. Merely
  // reading the shortcut list and trying a key ran it — on the one screen
  // built for pressing keys to see what they do.
  it('does not run a plain-key shortcut while the dialog is merely open', async () => {
    let fired = 0;
    keyboardService.register('test-merely-open', {
      key: 'y',
      action: () => { fired++; },
      description: 'destructive probe',
      category: 'Test',
    });

    const el = await openDialog();
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y' }));
      expect(fired, 'no shortcut may run behind the open dialog').to.equal(0);

      el.open = false;
      await el.updateComplete;

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y' }));
      expect(fired, 'and it works again once the dialog closes').to.equal(1);
    } finally {
      keyboardService.unregister('test-merely-open');
    }
  });
});
