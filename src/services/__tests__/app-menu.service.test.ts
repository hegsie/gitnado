/**
 * Application menu service: the table that maps native menu ids onto actions
 * the app already has, the accelerators printed next to those items, the
 * enabled state pushed to the native menu, and the guard that stops one key
 * press running an action twice.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
const invokeCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
let invokeFails = false;

let cbId = 0;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: Record<string, unknown>) => {
    invokeCalls.push({ command, args: args ?? {} });
    if (invokeFails) return Promise.reject(new Error('no menu'));
    return Promise.resolve(null);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect } from '@open-wc/testing';
import {
  APP_MENU_ACTIONS,
  MENU_ACTION_EVENT,
  acceleratorForMenuItem,
  acceleratorFromEvent,
  buildMenuUpdates,
  noteAcceleratorKeydown,
  resetAcceleratorGuard,
  resolveMenuAction,
  shouldSuppressMenuAction,
  startAcceleratorWatch,
  syncAppMenu,
  toAccelerator,
  type MenuShellHandlers,
} from '../app-menu.service.ts';
import { keyboardService, registerDefaultShortcuts } from '../keyboard.service.ts';
import type { PaletteCommand } from '../../components/dialogs/lv-command-palette.ts';

function noop(): void {
  /* stub action */
}

function registerShortcuts(): void {
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
    openCommandPalette: noop,
    fetch: noop,
    pull: noop,
    push: noop,
    createBranch: noop,
    createStash: noop,
  });
}

function paletteCommand(id: string, action: () => void): PaletteCommand {
  return { id, label: id, category: 'action', action };
}

function shellHandlers(record: string[]): MenuShellHandlers {
  return {
    openRepository: () => record.push('openRepository'),
    cloneRepository: () => record.push('cloneRepository'),
    initRepository: () => record.push('initRepository'),
    closeRepositoryTab: () => record.push('closeRepositoryTab'),
    switchBranch: () => record.push('switchBranch'),
    commandPalette: () => record.push('commandPalette'),
    keyboardShortcuts: () => record.push('keyboardShortcuts'),
    about: () => record.push('about'),
  };
}

describe('app-menu service', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    invokeFails = false;
    resetAcceleratorGuard();
    registerShortcuts();
  });

  afterEach(() => {
    keyboardService.resetAllBindings();
    resetAcceleratorGuard();
  });

  describe('the action table', () => {
    it('gives every menu item exactly one action source', () => {
      for (const action of APP_MENU_ACTIONS) {
        const sources = [action.paletteId, action.shell].filter(Boolean);
        expect(sources, `menu item "${action.id}"`).to.have.lengthOf(1);
      }
    });

    it('has no duplicate ids', () => {
      const ids = APP_MENU_ACTIONS.map((a) => a.id);
      expect(new Set(ids).size).to.equal(ids.length);
    });

    it('marks every repository action as repository-scoped', () => {
      const scoped = new Set(
        APP_MENU_ACTIONS.filter((a) => a.repositoryScoped).map((a) => a.id)
      );
      for (const id of [
        'fetch',
        'pull',
        'push',
        'clean',
        'bisect',
        'worktrees',
        'submodules',
        'lfs',
        'hooks',
        'config',
        'gitignore',
        'repository-health',
        'create-branch',
        'switch-branch',
        'compare-branches',
        'branch-cleanup',
        'close-repository-tab',
        // The output panel only exists inside the active-repository layout.
        'toggle-output-panel',
      ]) {
        expect(scoped.has(id), `"${id}" must be repository-scoped`).to.be.true;
      }
      for (const id of [
        'open-repository',
        'clone-repository',
        'init-repository',
        'toggle-left-panel',
        'toggle-right-panel',
        'command-palette',
        'keyboard-shortcuts',
        'about',
      ]) {
        expect(scoped.has(id), `"${id}" must work with no repository open`).to.be.false;
      }
    });

    it('listens on the event name the backend emits', () => {
      expect(MENU_ACTION_EVENT).to.equal('app-menu-action');
    });
  });

  describe('accelerators', () => {
    it('formats a modified letter binding', () => {
      expect(toAccelerator({ key: 'f', ctrl: true, shift: true })).to.equal(
        'CmdOrCtrl+Shift+F'
      );
      expect(toAccelerator({ key: 'b', ctrl: true })).to.equal('CmdOrCtrl+B');
      expect(toAccelerator({ key: 'p', meta: true })).to.equal('CmdOrCtrl+P');
      expect(toAccelerator({ key: 'ArrowUp', alt: true })).to.equal('Alt+ArrowUp');
    });

    it('names punctuation and special keys the way the native layer expects', () => {
      expect(toAccelerator({ key: ',', ctrl: true })).to.equal('CmdOrCtrl+Comma');
      expect(toAccelerator({ key: 'Escape', ctrl: true })).to.equal('CmdOrCtrl+Escape');
      expect(toAccelerator({ key: '1', ctrl: true })).to.equal('CmdOrCtrl+1');
    });

    it('refuses combos a native menu would misappropriate or cannot express', () => {
      // A bare letter accelerator would swallow that letter app-wide.
      expect(toAccelerator({ key: 's' })).to.equal(null);
      expect(toAccelerator({ key: '?', shift: true })).to.equal(null);
      expect(toAccelerator({ key: 'F13', ctrl: true })).to.equal(null);
      expect(toAccelerator(undefined)).to.equal(null);
    });

    it('shows the binding a user has customised, not the default', () => {
      expect(acceleratorForMenuItem('fetch')).to.equal('CmdOrCtrl+Shift+F');

      expect(keyboardService.rebind('fetch', { key: 'g', ctrl: true, shift: true })).to.be
        .true;
      expect(acceleratorForMenuItem('fetch')).to.equal('CmdOrCtrl+Shift+G');
    });

    it('has no accelerator for items with no keyboard binding', () => {
      expect(acceleratorForMenuItem('bisect')).to.equal(null);
      expect(acceleratorForMenuItem('not-a-menu-item')).to.equal(null);
    });

    it('derives the same notation from a key press', () => {
      const event = new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true });
      expect(acceleratorFromEvent(event)).to.equal('CmdOrCtrl+Shift+F');
    });
  });

  describe('enabled state', () => {
    it('disables every repository-scoped item with no repository open', () => {
      const updates = buildMenuUpdates(false);
      expect(updates).to.have.lengthOf(APP_MENU_ACTIONS.length);

      for (const action of APP_MENU_ACTIONS) {
        const update = updates.find((u) => u.id === action.id)!;
        expect(update.enabled, `"${action.id}" enabled`).to.equal(!action.repositoryScoped);
      }
    });

    it('enables everything once a repository is open', () => {
      for (const update of buildMenuUpdates(true)) {
        expect(update.enabled, `"${update.id}" enabled`).to.be.true;
      }
    });

    it('carries the current accelerators', () => {
      const updates = buildMenuUpdates(true);
      expect(updates.find((u) => u.id === 'push')!.accelerator).to.equal('CmdOrCtrl+Shift+U');
      expect(updates.find((u) => u.id === 'bisect')!.accelerator).to.equal(null);
    });

    it('sends the payload to the backend command', async () => {
      const result = await syncAppMenu(false);

      expect(result.success).to.be.true;
      const call = invokeCalls.find((c) => c.command === 'sync_app_menu');
      expect(call, 'sync_app_menu should be invoked').to.exist;
      const items = call!.args.items as Array<{ id: string; enabled: boolean }>;
      expect(items.find((i) => i.id === 'fetch')!.enabled).to.be.false;
      expect(items.find((i) => i.id === 'about')!.enabled).to.be.true;
    });

    it('reports a failed sync instead of throwing', async () => {
      invokeFails = true;
      const result = await syncAppMenu(true);
      expect(result.success).to.be.false;
      expect(result.error?.message).to.contain('no menu');
    });
  });

  describe('resolving an action', () => {
    it('returns the palette command’s own action, not a copy', () => {
      const action = () => undefined;
      const commands = [paletteCommand('clean', action)];

      expect(resolveMenuAction('clean', commands, shellHandlers([]))).to.equal(action);
    });

    it('runs the shell handler for items with no palette twin', () => {
      const record: string[] = [];
      resolveMenuAction('about', [], shellHandlers(record))!();
      resolveMenuAction('close-repository-tab', [], shellHandlers(record))!();

      expect(record).to.deep.equal(['about', 'closeRepositoryTab']);
    });

    it('returns null for an unknown id or a missing palette command', () => {
      expect(resolveMenuAction('nope', [], shellHandlers([]))).to.equal(null);
      expect(resolveMenuAction('clean', [], shellHandlers([]))).to.equal(null);
    });
  });

  describe('duplicate suppression', () => {
    it('drops a menu action whose own accelerator was just pressed', () => {
      noteAcceleratorKeydown(
        new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true })
      );
      expect(shouldSuppressMenuAction('fetch')).to.be.true;
    });

    it('suppresses at most one menu event per key press', () => {
      noteAcceleratorKeydown(
        new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true })
      );
      expect(shouldSuppressMenuAction('fetch')).to.be.true;
      // Choosing Fetch from the menu straight afterwards must still work.
      expect(shouldSuppressMenuAction('fetch')).to.be.false;
    });

    it('does not drop a different action, or the same one later', () => {
      const now = 1_000_000;
      noteAcceleratorKeydown(
        new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true }),
        now
      );
      expect(shouldSuppressMenuAction('pull', now)).to.be.false;
      expect(shouldSuppressMenuAction('fetch', now + 5000)).to.be.false;
    });

    it('never drops an item that has no accelerator at all', () => {
      noteAcceleratorKeydown(
        new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true })
      );
      expect(shouldSuppressMenuAction('bisect')).to.be.false;
    });

    it('watches key presses until it is disposed', () => {
      const dispose = startAcceleratorWatch();
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'B', ctrlKey: true, bubbles: true })
      );
      expect(shouldSuppressMenuAction('toggle-left-panel')).to.be.true;

      dispose();
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'B', ctrlKey: true, bubbles: true })
      );
      expect(shouldSuppressMenuAction('toggle-left-panel')).to.be.false;
    });
  });
});
