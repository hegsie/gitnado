/**
 * Native menu bar routing in app-shell.
 *
 * A native menu cannot be driven from a test, so what is pinned here is the
 * half that can go wrong: an `app-menu-action` id must run the SAME handler its
 * command-palette twin runs, repository-scoped ids must stay guarded when no
 * repository is open, and the enabled state pushed to the native menu must
 * follow the repository-open state.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
const invokeCalls: Array<{ command: string; args: Record<string, unknown> }> = [];

let cbId = 0;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: Record<string, unknown>) => {
    invokeCalls.push({ command, args: args ?? {} });
    return Promise.resolve(null);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, waitUntil } from '@open-wc/testing';
import type { AppShell } from '../app-shell.ts';
import '../app-shell.ts';
import { repositoryStore, uiStore } from '../stores/index.ts';
import { dialogs, type DialogId } from '../stores/dialog.store.ts';
import {
  APP_MENU_ACTIONS,
  noteAcceleratorKeydown,
  resetAcceleratorGuard,
} from '../services/app-menu.service.ts';
import { keyboardService, registerDefaultShortcuts } from '../services/keyboard.service.ts';
import type { Repository } from '../types/git.types.ts';

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

function noop(): void {
  /* stub action */
}

/* eslint-disable @typescript-eslint/no-explicit-any */

interface PaletteCommandLike {
  id: string;
  label: string;
  action: () => void;
}

describe('app-shell application menu routing', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    uiStore.setState({ toasts: [] });
    repositoryStore.getState().reset();
    resetAcceleratorGuard();
  });

  afterEach(() => {
    repositoryStore.getState().reset();
    keyboardService.resetAllBindings();
    resetAcceleratorGuard();
  });

  function shell(path: string | null = '/repo/active'): AppShell {
    const el = document.createElement('lv-app-shell') as AppShell;
    if (path) {
      (el as any).activeRepository = { repository: mockRepo(path, 'active') };
    }
    return el;
  }

  function toasts(type: string): Array<{ message: string }> {
    return uiStore.getState().toasts.filter((t) => t.type === type) as Array<{
      message: string;
    }>;
  }

  function paletteCommands(el: AppShell): PaletteCommandLike[] {
    return (el as any).getPaletteCommands() as PaletteCommandLike[];
  }

  function runMenuAction(el: AppShell, id: string): void {
    (el as any).handleAppMenuAction(id);
  }

  it('every palette-backed menu item names a palette command that exists', () => {
    // The anti-drift guard: renaming or dropping a palette command must fail
    // here rather than leaving a menu item that quietly does nothing.
    const ids = new Set(paletteCommands(shell()).map((c) => c.id));

    for (const action of APP_MENU_ACTIONS) {
      if (!action.paletteId) continue;
      expect(ids.has(action.paletteId), `palette command "${action.paletteId}"`).to.be.true;
    }
  });

  it('runs the same handler as the palette twin for repository dialogs', () => {
    const cases: Array<[string, DialogId]> = [
      ['clean', 'clean'],
      ['bisect', 'bisect'],
      ['worktrees', 'worktrees'],
      ['submodules', 'submodules'],
      ['lfs', 'lfs'],
      ['hooks', 'hooks'],
      ['config', 'config'],
      ['gitignore', 'gitignore'],
      ['repository-health', 'repositoryHealth'],
    ];

    for (const [id, dialogId] of cases) {
      // What the palette does…
      const viaPalette = shell();
      dialogs.reset();
      paletteCommands(viaPalette).find((c) => c.id === id)!.action();
      expect(dialogs.isOpen(dialogId), `palette "${id}" opens ${dialogId}`).to.be.true;

      // …the menu must do too.
      const viaMenu = shell();
      dialogs.reset();
      runMenuAction(viaMenu, id);
      expect(dialogs.isOpen(dialogId), `menu "${id}" opens ${dialogId}`).to.be.true;
    }
  });

  it('keeps the repository guard when no repository is open', () => {
    const el = shell(null);
    dialogs.reset();

    runMenuAction(el, 'clean');

    expect(dialogs.isOpen('clean'), 'no dialog without a repository').to.be.false;
    const warnings = toasts('warning');
    expect(warnings, 'the user must be told why nothing happened').to.have.lengthOf(1);
    expect(warnings[0].message).to.contain('open a repository');
  });

  it('opens the palette as a branch switcher, not the bare command list', async () => {
    // "Switch Branch…" used to resolve to a plain openCommandPalette(), so the
    // user landed on every command the app has and had to type the branch
    // filter themselves — a menu item that names one job and then does not do
    // it. The palette IS the switcher; it just has to open on the branches.
    const el = shell('/repo/active');
    dialogs.reset();

    runMenuAction(el, 'switch-branch');
    await waitUntil(() => dialogs.isOpen('commandPalette'), 'the palette to open');

    expect(dialogs.isOpen('commandPalette'), 'the palette opens').to.be.true;
    // Matches the "Switch to <branch>" label lv-command-palette gives every
    // branch entry, which is what pre-filters it to the branches.
    expect((el as any).commandPaletteQuery).to.equal('Switch to ');
  });

  it('leaves the palette unfiltered for the plain Command Palette item', async () => {
    const el = shell('/repo/active');
    dialogs.reset();

    runMenuAction(el, 'command-palette');
    await waitUntil(() => dialogs.isOpen('commandPalette'), 'the palette to open');

    expect(dialogs.isOpen('commandPalette')).to.be.true;
    expect((el as any).commandPaletteQuery, 'every other entry point is unchanged').to.equal('');
  });

  it('opens the keyboard shortcuts dialog from Help', () => {
    const el = shell(null);
    dialogs.reset();
    runMenuAction(el, 'keyboard-shortcuts');
    expect(dialogs.isOpen('shortcuts')).to.be.true;
  });

  it('closes the active repository tab from File', () => {
    const el = shell('/repo/active');
    repositoryStore.getState().addRepository(mockRepo('/repo/active', 'active'));
    repositoryStore.getState().addRepository(mockRepo('/repo/other', 'other'));

    runMenuAction(el, 'close-repository-tab');

    const paths = repositoryStore.getState().openRepositories.map((r) => r.repository.path);
    expect(paths).to.deep.equal(['/repo/other']);
  });

  it('reports a menu id it cannot route instead of doing nothing', () => {
    const el = shell();

    runMenuAction(el, 'not-a-real-menu-item');

    expect(toasts('error'), 'an unroutable menu item must not be silent').to.have.lengthOf(1);
  });

  it('reports when the toolbar that owns Open/Clone/Init is unavailable', () => {
    // Never rendered, so there is no toolbar in the shadow root.
    const el = shell(null);

    runMenuAction(el, 'open-repository');

    const errors = toasts('error');
    expect(errors).to.have.lengthOf(1);
    expect(errors[0].message).to.contain('Open Repository');
  });

  it('pushes the disabled state to the native menu and skips no-op syncs', async () => {
    const el = shell(null);

    (el as any).syncAppMenuState(false);
    await waitUntil(
      () => invokeCalls.some((c) => c.command === 'sync_app_menu'),
      'the first sync to reach the backend',
    );

    const first = invokeCalls.filter((c) => c.command === 'sync_app_menu');
    expect(first, 'the first sync must reach the backend').to.have.lengthOf(1);
    const items = first[0].args.items as Array<{ id: string; enabled: boolean }>;
    expect(items.find((i) => i.id === 'fetch')!.enabled).to.be.false;
    expect(items.find((i) => i.id === 'command-palette')!.enabled).to.be.true;

    // Same state again: no IPC. The no-op guard returns before anything is
    // scheduled, so there is nothing to wait for.
    (el as any).syncAppMenuState(false);
    expect(invokeCalls.filter((c) => c.command === 'sync_app_menu')).to.have.lengthOf(1);

    // A repository opens: everything becomes clickable.
    (el as any).syncAppMenuState(true);
    await waitUntil(
      () => invokeCalls.filter((c) => c.command === 'sync_app_menu').length === 2,
      'the second sync to reach the backend',
    );
    const second = invokeCalls.filter((c) => c.command === 'sync_app_menu');
    expect(second).to.have.lengthOf(2);
    const enabled = second[1].args.items as Array<{ id: string; enabled: boolean }>;
    expect(enabled.every((i) => i.enabled)).to.be.true;
  });

  it('does not run an action twice when the webview also saw the accelerator', () => {
    registerDefaultShortcuts({
      navigateUp: noop,
      navigateDown: noop,
      selectCommit: noop,
      stageAll: noop,
      unstageAll: noop,
      commit: noop,
      refresh: noop,
      search: noop,
      openSettings: noop,
      openShortcuts: noop,
      toggleLeftPanel: noop,
      toggleRightPanel: noop,
    });

    const el = shell();
    const visible = () => uiStore.getState().panels.right.isVisible;
    const before = visible();

    // The keyboard route has just toggled the right panel for this key press.
    noteAcceleratorKeydown(new KeyboardEvent('keydown', { key: 'J', ctrlKey: true }));

    runMenuAction(el, 'toggle-right-panel');
    expect(visible(), 'the menu event for that same press is dropped').to.equal(before);

    // The next visit to the menu works normally.
    runMenuAction(el, 'toggle-right-panel');
    expect(visible()).to.equal(!before);
  });
});
