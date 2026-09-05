/**
 * Integration test for the output panel wiring in app-shell:
 * the command palette exposes "Toggle Output Panel", and its action flips
 * the panel state that renders <lv-output-panel closable> in the center panel.
 *
 * The panel is rendered ONLY inside the active-repository layout, so the
 * toggle is repository-scoped on both menu halves and in the palette. These
 * tests pin the rendered panel — not just the flag — because a toggle that
 * only flipped `dialogs.isOpen('outputPanel')` looked correct while being a
 * silent no-op on the welcome screen (and armed the flag for the next
 * repository the user opened).
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
import { expect } from '@open-wc/testing';
import type { AppShell } from '../app-shell.ts';
import '../app-shell.ts';
import { dialogs } from '../stores/dialog.store.ts';
import { uiStore } from '../stores/ui.store.ts';
import type { Repository } from '../types/git.types.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface PaletteCommandLike {
  id: string;
  label: string;
  action: () => void;
}

function mockRepo(): Repository {
  return {
    path: '/repo/one',
    name: 'one',
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

/** A shell on the welcome screen (no repository) unless `withRepo` is set. */
function createAppShell(withRepo = false): AppShell {
  const el = document.createElement('lv-app-shell') as AppShell;
  if (withRepo) {
    (el as any).activeRepository = { repository: mockRepo() };
  }
  return el;
}

function outputPanel(el: AppShell): Element | null {
  return el.shadowRoot!.querySelector('lv-output-panel');
}

function getPaletteCommands(el: AppShell): PaletteCommandLike[] {
  return (el as any).getPaletteCommands();
}

// Which dialogs are open is module state, and several tests here drive a shell
// that is never connected to the document (so its connectedCallback reset never
// runs). Clear it per test to keep the isolation each instance used to get for
// free from its own `@state()` flags.
beforeEach(() => {
  dialogs.reset();
  uiStore.setState({ toasts: [] });
});

describe('app-shell output panel wiring', () => {
  it('exposes a Toggle Output Panel palette command', () => {
    const el = createAppShell();
    const cmd = getPaletteCommands(el).find((c) => c.id === 'toggle-output-panel');
    expect(cmd).to.exist;
    expect(cmd!.label).to.equal('Toggle Output Panel');
  });

  it('the palette action toggles the rendered panel on and off', async () => {
    const el = createAppShell(true);
    document.body.appendChild(el);
    try {
      await el.updateComplete;
      const cmd = getPaletteCommands(el).find((c) => c.id === 'toggle-output-panel')!;

      expect(dialogs.isOpen('outputPanel')).to.be.false;
      expect(outputPanel(el), 'no panel before the toggle').to.equal(null);

      cmd.action();
      expect(dialogs.isOpen('outputPanel')).to.be.true;
      await el.updateComplete;
      // The flag is only half the wiring: the panel has to actually be on
      // screen, which it can only be inside the active-repository layout.
      expect(outputPanel(el), 'the panel is rendered').to.not.equal(null);
      expect(outputPanel(el)!.hasAttribute('closable')).to.be.true;

      cmd.action();
      expect(dialogs.isOpen('outputPanel')).to.be.false;
      await el.updateComplete;
      expect(outputPanel(el), 'the panel is gone again').to.equal(null);
    } finally {
      el.remove();
    }
  });

  it('on the welcome screen it warns instead of arming an invisible panel', async () => {
    const el = createAppShell(false);
    document.body.appendChild(el);
    try {
      await el.updateComplete;
      const cmd = getPaletteCommands(el).find((c) => c.id === 'toggle-output-panel')!;

      cmd.action();
      await el.updateComplete;

      // Nothing rendered, nothing armed: the flag must not survive to pop the
      // panel open on the next repository the user opens.
      expect(outputPanel(el), 'nothing to render with no repository').to.equal(null);
      expect(dialogs.isOpen('outputPanel'), 'the flag stays off').to.be.false;
      const warnings = uiStore.getState().toasts.filter((t) => t.type === 'warning');
      expect(warnings.length, 'the user is told why nothing happened').to.equal(1);
      expect(warnings[0].message).to.match(/open a repository/i);
    } finally {
      el.remove();
    }
  });
});
