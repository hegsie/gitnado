/**
 * Tests for the app-shell half of the content-search wiring.
 *
 * The search backend was unreachable because nothing opened a surface for it:
 * these pin the three palette entries to the dialog and its mode, pin them to
 * requiresRepository (so they warn instead of dying on the welcome screen),
 * and pin the diff-result navigation — including the miss, which must report
 * itself rather than being a dead click.
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
import { uiStore } from '../stores/ui.store.ts';
import '../app-shell.ts';
import { dialogs } from '../stores/dialog.store.ts';

interface PaletteCommand {
  id: string;
  label: string;
  action: () => void;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function createAppShell(withRepo: boolean): AppShell {
  const el = document.createElement('lv-app-shell') as AppShell;
  (el as any).activeRepository = withRepo
    ? {
        repository: { path: '/repo/a', name: 'a' },
        status: [
          { path: 'src/a.ts', status: 'modified', isStaged: false, isConflicted: false },
          { path: 'src/b.ts', status: 'modified', isStaged: true, isConflicted: false },
        ],
      }
    : null;
  return el;
}

function getCommand(el: AppShell, id: string): PaletteCommand {
  const commands: PaletteCommand[] = (el as any).getPaletteCommands();
  const cmd = commands.find((c) => c.id === id);
  if (!cmd) throw new Error(`palette command "${id}" not found`);
  return cmd;
}

const MODES: Array<{ id: string; mode: string }> = [
  { id: 'search-in-files', mode: 'files' },
  { id: 'search-in-diff', mode: 'diff' },
  { id: 'search-commit-content', mode: 'commits' },
];

// Which dialogs are open is module state, and several tests here drive a shell
// that is never connected to the document (so its connectedCallback reset never
// runs). Clear it per test to keep the isolation each instance used to get for
// free from its own `@state()` flags.
beforeEach(() => {
  dialogs.reset();
});

describe('app-shell search dialog wiring', () => {
  beforeEach(() => {
    uiStore.setState({ toasts: [] });
  });

  for (const { id, mode } of MODES) {
    it(`"${id}" opens the search dialog in ${mode} mode`, () => {
      const el = createAppShell(true);
      getCommand(el, id).action();

      expect(dialogs.isOpen('search'), 'dialog opened').to.equal(true);
      expect((el as any).searchDialogMode, 'mode preselected').to.equal(mode);
    });

    it(`"${id}" warns instead of opening with no repository`, () => {
      const el = createAppShell(false);
      getCommand(el, id).action();

      expect(dialogs.isOpen('search'), 'dialog stays shut').to.not.equal(true);
      const warnings = uiStore
        .getState()
        .toasts.filter((t) => t.message === 'Please open a repository first');
      expect(warnings.length, 'requiresRepository warning shown').to.equal(1);
    });
  }

  it('records the mode the dialog moved to, so the next open is not dirty-checked away', async () => {
    // `.mode` is a dirty-checked binding: if app-shell keeps pushing the mode
    // it last set while the dialog sits on another one, reopening in that mode
    // assigns nothing and the dialog stays where the user left it.
    const el = createAppShell(true);
    document.body.appendChild(el);
    await (el as any).updateComplete;
    getCommand(el, 'search-in-files').action();
    await (el as any).updateComplete;

    const dialog = el.shadowRoot!.querySelector('lv-search-dialog');
    expect(dialog === null, 'the search dialog is rendered').to.be.false;
    dialog!.dispatchEvent(
      new CustomEvent('mode-changed', {
        detail: { mode: 'commits' },
        bubbles: true,
        composed: true,
      })
    );

    expect((el as any).searchDialogMode, 'app-shell owns the mode').to.equal('commits');
    el.remove();
  });

  it('show-working-diff opens the matching working-tree entry', () => {
    const el = createAppShell(true);
    (el as any).handleShowWorkingDiff(
      new CustomEvent('show-working-diff', { detail: { filePath: 'src/a.ts', staged: false } })
    );

    expect(dialogs.isOpen('diff'), 'diff pane opened').to.equal(true);
    expect((el as any).diffFile?.path).to.equal('src/a.ts');
    expect((el as any).diffFile?.isStaged, 'matched the staged flag from the search').to.equal(false);
  });

  it('show-working-diff prefers the entry with the searched staged flag', () => {
    const el = createAppShell(true);
    (el as any).handleShowWorkingDiff(
      new CustomEvent('show-working-diff', { detail: { filePath: 'src/b.ts', staged: true } })
    );

    expect((el as any).diffFile?.path).to.equal('src/b.ts');
    expect((el as any).diffFile?.isStaged).to.equal(true);
  });

  it('show-working-diff reports a file that is no longer changed', () => {
    const el = createAppShell(true);
    (el as any).handleShowWorkingDiff(
      new CustomEvent('show-working-diff', { detail: { filePath: 'gone.ts', staged: false } })
    );

    expect(dialogs.isOpen('diff'), 'no diff opened').to.not.equal(true);
    const infos = uiStore
      .getState()
      .toasts.filter((t) => t.message.includes('no longer in the working-tree changes'));
    expect(infos.length, 'the miss is reported, not silent').to.equal(1);
  });
});
