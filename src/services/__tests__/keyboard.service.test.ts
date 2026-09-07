import { expect } from '@open-wc/testing';
import type { Shortcut } from '../keyboard.service.ts';
import { keyboardService } from '../keyboard.service.ts';
import { pushOverlay, removeOverlay, resetOverlayStack } from '../../utils/overlay-stack.ts';

// Clear localStorage before tests
const STORAGE_KEY = 'gitnado-keyboard-settings';

describe('keyboard.service', () => {
  beforeEach(() => {
    // Clear keyboard settings before each test
    localStorage.removeItem(STORAGE_KEY);
  });

  // Helper to create a mock shortcut
  function createShortcut(overrides: Partial<Shortcut> = {}): Shortcut {
    return {
      key: 'a',
      action: () => {},
      description: 'Test shortcut',
      category: 'Test',
      ...overrides,
    };
  }

  describe('formatShortcut', () => {
    // We need to test the formatting logic in isolation
    // Since formatShortcut is a method on the service, we'll test the behavior

    it('formats simple key shortcuts', async () => {
      const { keyboardService } = await import('../keyboard.service.ts');
      const shortcut = createShortcut({ key: 'a' });
      const formatted = keyboardService.formatShortcut(shortcut);
      expect(formatted).to.equal('A');
    });

    it('formats ctrl+key shortcuts', async () => {
      const { keyboardService } = await import('../keyboard.service.ts');
      const shortcut = createShortcut({ key: 'a', ctrl: true });
      const formatted = keyboardService.formatShortcut(shortcut);
      // Result depends on platform
      expect(formatted).to.match(/A$/);
    });

    it('formats shift+key shortcuts', async () => {
      const { keyboardService } = await import('../keyboard.service.ts');
      const shortcut = createShortcut({ key: 'a', shift: true });
      const formatted = keyboardService.formatShortcut(shortcut);
      expect(formatted).to.include('A');
    });

    it('formats arrow keys', async () => {
      const { keyboardService } = await import('../keyboard.service.ts');
      expect(keyboardService.formatShortcut(createShortcut({ key: 'ArrowUp' }))).to.equal('↑');
      expect(keyboardService.formatShortcut(createShortcut({ key: 'ArrowDown' }))).to.equal('↓');
      expect(keyboardService.formatShortcut(createShortcut({ key: 'ArrowLeft' }))).to.equal('←');
      expect(keyboardService.formatShortcut(createShortcut({ key: 'ArrowRight' }))).to.equal('→');
    });

    it('formats special keys', async () => {
      const { keyboardService } = await import('../keyboard.service.ts');
      expect(keyboardService.formatShortcut(createShortcut({ key: 'Enter' }))).to.equal('↵');
      expect(keyboardService.formatShortcut(createShortcut({ key: 'Escape' }))).to.equal('Esc');
      expect(keyboardService.formatShortcut(createShortcut({ key: ' ' }))).to.equal('Space');
    });

    it('formats complex shortcuts with multiple modifiers', async () => {
      const { keyboardService } = await import('../keyboard.service.ts');
      const shortcut = createShortcut({ key: 's', ctrl: true, shift: true });
      const formatted = keyboardService.formatShortcut(shortcut);
      expect(formatted).to.include('S');
    });
  });

  describe('register and unregister', () => {
    it('can register a shortcut', async () => {
      const { keyboardService } = await import('../keyboard.service.ts');
      const initialCount = keyboardService.getAllShortcuts().length;

      keyboardService.register('test-shortcut', createShortcut({ key: 'x', description: 'Test X' }));

      const shortcuts = keyboardService.getAllShortcuts();
      expect(shortcuts.length).to.be.greaterThan(initialCount);
    });

    it('can unregister a shortcut', async () => {
      const { keyboardService } = await import('../keyboard.service.ts');
      keyboardService.register('unregister-test', createShortcut({ key: 'y', description: 'unregister-test' }));
      const countBefore = keyboardService.getAllShortcuts().length;

      keyboardService.unregister('unregister-test');

      const countAfter = keyboardService.getAllShortcuts().length;
      expect(countAfter).to.equal(countBefore - 1);
    });
  });

  describe('getAllShortcuts', () => {
    it('returns array of shortcuts', async () => {
      const { keyboardService } = await import('../keyboard.service.ts');
      const shortcuts = keyboardService.getAllShortcuts();
      expect(Array.isArray(shortcuts)).to.be.true;
    });
  });

  describe('getShortcutsByCategory', () => {
    it('returns map of categories', async () => {
      const { keyboardService } = await import('../keyboard.service.ts');
      const byCategory = keyboardService.getShortcutsByCategory();
      expect(byCategory instanceof Map).to.be.true;
    });

    it('groups shortcuts by category', async () => {
      const { keyboardService } = await import('../keyboard.service.ts');
      keyboardService.register('cat-test-1', createShortcut({ key: '1', category: 'TestCategory' }));
      keyboardService.register('cat-test-2', createShortcut({ key: '2', category: 'TestCategory' }));

      const byCategory = keyboardService.getShortcutsByCategory();
      const testCat = byCategory.get('TestCategory');
      expect(testCat).to.exist;
      expect(testCat!.length).to.be.greaterThanOrEqual(2);
    });
  });

  describe('vim mode', () => {
    it('can enable vim mode', async () => {
      const { keyboardService } = await import('../keyboard.service.ts');
      keyboardService.setVimMode(true);
      expect(keyboardService.isVimMode()).to.be.true;
    });

    it('can disable vim mode', async () => {
      const { keyboardService } = await import('../keyboard.service.ts');
      keyboardService.setVimMode(false);
      expect(keyboardService.isVimMode()).to.be.false;
    });

    it('persists vim mode setting', async () => {
      const { keyboardService } = await import('../keyboard.service.ts');
      keyboardService.setVimMode(true);

      // Check localStorage was updated
      const stored = localStorage.getItem('gitnado-keyboard-settings');
      expect(stored).to.exist;
      const settings = JSON.parse(stored!);
      expect(settings.vimMode).to.be.true;
    });

    it('can set vim actions', async () => {
      const { keyboardService } = await import('../keyboard.service.ts');
      let upCalled = false;
      let downCalled = false;

      keyboardService.setVimActions({
        navigateUp: () => { upCalled = true; },
        navigateDown: () => { downCalled = true; },
      });

      // Actions are set but not called until key events
      expect(upCalled).to.be.false;
      expect(downCalled).to.be.false;
    });
  });

  describe('setEnabled', () => {
    it('can disable keyboard shortcuts', async () => {
      const { keyboardService } = await import('../keyboard.service.ts');

      let fired = 0;
      keyboardService.register('test-disabled', {
        key: 'y', action: () => { fired++; }, description: 'disabled probe', category: 'Test',
      });

      try {
        keyboardService.setEnabled(false);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y' }));
        expect(fired, 'disabled shortcuts must not fire').to.equal(0);

        // Re-enabled in the same test, and asserted. This used to be
        // `expect(() => setEnabled(true)).to.not.throw` — a property access,
        // never invoked — so the service was left DISABLED for every later
        // test in this file, silently neutering any that dispatch a key.
        keyboardService.setEnabled(true);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y' }));
        expect(fired, 'shortcuts fire again once re-enabled').to.equal(1);
      } finally {
        keyboardService.setEnabled(true);
        keyboardService.unregister('test-disabled');
      }
    });
  });

  describe('addListener', () => {
    it('returns unsubscribe function', async () => {
      const { keyboardService } = await import('../keyboard.service.ts');
      const listener = () => {};
      const unsubscribe = keyboardService.addListener(listener);
      expect(typeof unsubscribe).to.equal('function');

      // Clean up
      unsubscribe();
    });
  });
});

describe('registerDefaultShortcuts', () => {
  it('registers navigation shortcuts', async () => {
    const { keyboardService, registerDefaultShortcuts } = await import('../keyboard.service.ts');

    const mockActions = {
      navigateUp: () => {},
      navigateDown: () => {},
      selectCommit: () => {},
      stageAll: () => {},
      unstageAll: () => {},
      commit: () => {},
      refresh: () => {},
      search: () => {},
      openSettings: () => {},
      toggleLeftPanel: () => {},
      toggleRightPanel: () => {},
    };

    registerDefaultShortcuts(mockActions);

    const shortcuts = keyboardService.getAllShortcuts();
    const categories = shortcuts.map(s => s.category);

    expect(categories).to.include('Navigation');
    expect(categories).to.include('Staging');
    expect(categories).to.include('Commit');
    expect(categories).to.include('General');
    expect(categories).to.include('View');
  });

  it('sets vim navigation actions', async () => {
    const { keyboardService, registerDefaultShortcuts } = await import('../keyboard.service.ts');

    let upCalled = false;
    let downCalled = false;

    const mockActions = {
      navigateUp: () => { upCalled = true; },
      navigateDown: () => { downCalled = true; },
      selectCommit: () => {},
      stageAll: () => {},
      unstageAll: () => {},
      commit: () => {},
      refresh: () => {},
      search: () => {},
      openSettings: () => {},
      toggleLeftPanel: () => {},
      toggleRightPanel: () => {},
    };

    registerDefaultShortcuts(mockActions);

    // Vim actions are set
    keyboardService.setVimMode(true);
    // Actions would be called on key events
    expect(upCalled).to.be.false; // Not called until key event
    expect(downCalled).to.be.false;
  });

  it('registers optional shortcuts when provided', async () => {
    const { keyboardService, registerDefaultShortcuts } = await import('../keyboard.service.ts');

    const mockActions = {
      navigateUp: () => {},
      navigateDown: () => {},
      selectCommit: () => {},
      stageAll: () => {},
      unstageAll: () => {},
      commit: () => {},
      refresh: () => {},
      search: () => {},
      openSettings: () => {},
      toggleLeftPanel: () => {},
      toggleRightPanel: () => {},
      fetch: () => {},
      pull: () => {},
      push: () => {},
      createBranch: () => {},
      createStash: () => {},
    };

    registerDefaultShortcuts(mockActions);

    const shortcuts = keyboardService.getAllShortcuts();
    const descriptions = shortcuts.map(s => s.description);

    expect(descriptions).to.include('Fetch from remote');
    expect(descriptions).to.include('Pull from remote');
    expect(descriptions).to.include('Push to remote');
    expect(descriptions).to.include('Create new branch');
    expect(descriptions).to.include('Create stash');
  });

  describe('shifted punctuation shortcuts', () => {
    beforeEach(() => {
      keyboardService.setEnabled(true);
    });

    // "?" cannot be typed without a modifier, and which modifier depends on the
    // layout. Hashing the shift state into the binding made the shortcut match
    // only when the event happened to carry shiftKey — so a keypress that
    // produced the character still missed the binding.
    it('fires a "?" shortcut whether or not the event carries shiftKey', () => {
      let fired = 0;
      keyboardService.register('test-question', {
        key: '?',
        shift: true,
        action: () => { fired++; },
        description: 'Test question mark',
        category: 'Test',
      });

      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', shiftKey: true }));
        expect(fired, 'with shiftKey').to.equal(1);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', shiftKey: false }));
        expect(fired, 'without shiftKey').to.equal(2);
      } finally {
        keyboardService.unregister('test-question');
      }
    });

    // Space reports ' ' shifted or not, so shift is NOT redundant there — the
    // first version of this rule collapsed them and made Shift+Space unbindable.
    it('keeps shift significant for Space', () => {
      let plain = 0;
      let shifted = 0;
      keyboardService.register('test-space', {
        key: ' ', action: () => { plain++; }, description: 'space', category: 'Test',
      });
      keyboardService.register('test-shift-space', {
        key: ' ', shift: true, action: () => { shifted++; }, description: 'shift space', category: 'Test',
      });

      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', shiftKey: false }));
        expect(plain, 'Space').to.equal(1);
        expect(shifted, 'Shift+Space must not fire on plain Space').to.equal(0);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', shiftKey: true }));
        expect(shifted, 'Shift+Space').to.equal(1);
        expect(plain, 'Space must not fire again').to.equal(1);
      } finally {
        keyboardService.unregister('test-space');
        keyboardService.unregister('test-shift-space');
      }
    });

    // Accented and non-Latin letters have case, so shift stays significant.
    it('keeps shift significant for non-ASCII letters', () => {
      let plain = 0;
      keyboardService.register('test-umlaut', {
        key: 'ü', action: () => { plain++; }, description: 'umlaut', category: 'Test',
      });

      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ü', shiftKey: true }));
        expect(plain, 'Shift+ü must not fire the plain ü binding').to.equal(0);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ü', shiftKey: false }));
        expect(plain, 'plain ü').to.equal(1);
      } finally {
        keyboardService.unregister('test-umlaut');
      }
    });

    // Letters must keep the distinction: shift+a and a are different bindings.
    it('keeps shift significant for letter shortcuts', () => {
      let plain = 0;
      let shifted = 0;
      keyboardService.register('test-plain', {
        key: 'q', action: () => { plain++; }, description: 'plain', category: 'Test',
      });
      keyboardService.register('test-shifted', {
        key: 'q', shift: true, action: () => { shifted++; }, description: 'shifted', category: 'Test',
      });

      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', shiftKey: false }));
        expect(plain, 'plain q').to.equal(1);
        expect(shifted, 'shifted must not fire').to.equal(0);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', shiftKey: true }));
        expect(shifted, 'shift+q').to.equal(1);
        expect(plain, 'plain must not fire again').to.equal(1);
      } finally {
        keyboardService.unregister('test-plain');
        keyboardService.unregister('test-shifted');
      }
    });
  });
});
describe('keyboard shortcuts must not hijack a <select>', () => {
  // A <select>'s native keyboard interaction IS arrow keys and type-ahead
  // letters, and this handler preventDefault()s the ones it matches — so every
  // select in the app was keyboard-inoperable and its type-ahead ran a global
  // shortcut instead. On the interactive-rebase action select the select IS
  // the destructive control: pressing `s` for "squash" left the value on
  // `pick` and silently ran stage-all behind the modal.
  it('ignores keys originating in a select', async () => {
    const select = document.createElement('select');
    for (const v of ['pick', 'squash']) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      select.appendChild(o);
    }
    document.body.appendChild(select);

    let fired = 0;
    keyboardService.register('test-select-guard', {
      key: 's',
      description: 'test',
      category: 'General',
      action: () => {
        fired++;
      },
    });

    try {
      select.focus();
      const ev = new KeyboardEvent('keydown', {
        key: 's',
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      select.dispatchEvent(ev);

      expect(fired, 'a shortcut must not fire from inside a select').to.equal(0);
      expect(ev.defaultPrevented, 'and the native type-ahead must not be cancelled').to.be
        .false;
    } finally {
      keyboardService.unregister('test-select-guard');
      select.remove();
    }
  });
});


describe('shortcut customization has a single source of truth', () => {
  const STORAGE_KEY = 'gitnado-keyboard-settings';

  function storedSettings(): { vimMode?: boolean; customBindings?: Record<string, unknown> } {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  }

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it('exposes no backend keyboard-shortcut IPC wrappers', async () => {
    // Shortcut customization is owned entirely by keyboardService and its
    // localStorage store. A second store reachable over IPC would carry its own
    // table of action IDs, which drifts from what registerDefaultShortcuts
    // registers with nothing able to reconcile the two.
    const gitService = await import('../git.service.ts');
    const shortcutIpc = Object.keys(gitService).filter((k) => /shortcut/i.test(k));
    expect(
      shortcutIpc,
      'git.service.ts must not expose a parallel keyboard-shortcut store',
    ).to.deep.equal([]);
  });

  it('persists a rebind into the keyboard settings store', async () => {
    const { keyboardService } = await import('../keyboard.service.ts');
    keyboardService.register('test-persist', {
      key: 'a',
      action: () => {},
      description: 'Persist test',
      category: 'Test',
    });

    try {
      expect(keyboardService.rebind('test-persist', { key: 'q', ctrl: true })).to.be.true;

      expect(storedSettings().customBindings?.['test-persist']).to.deep.equal({
        key: 'q',
        ctrl: true,
      });
      expect(keyboardService.isCustomized('test-persist')).to.be.true;
    } finally {
      keyboardService.unregister('test-persist');
    }
  });

  it('refuses a rebind onto a combo another shortcut owns and stores nothing', async () => {
    const { keyboardService } = await import('../keyboard.service.ts');
    keyboardService.register('test-conflict-a', {
      key: 'q',
      ctrl: true,
      action: () => {},
      description: 'Conflict owner',
      category: 'Test',
    });
    keyboardService.register('test-conflict-b', {
      key: 'a',
      action: () => {},
      description: 'Conflict challenger',
      category: 'Test',
    });

    try {
      expect(keyboardService.rebind('test-conflict-b', { key: 'q', ctrl: true })).to.be.false;

      expect(storedSettings().customBindings ?? {}).to.not.have.property('test-conflict-b');
      expect(keyboardService.isCustomized('test-conflict-b')).to.be.false;
      expect(keyboardService.getBinding('test-conflict-b')?.key).to.equal('a');
    } finally {
      keyboardService.unregister('test-conflict-a');
      keyboardService.unregister('test-conflict-b');
    }
  });

  it('removes the custom binding from the store on reset', async () => {
    const { keyboardService } = await import('../keyboard.service.ts');
    keyboardService.register('test-reset', {
      key: 'a',
      action: () => {},
      description: 'Reset test',
      category: 'Test',
    });

    try {
      expect(keyboardService.rebind('test-reset', { key: 'q', ctrl: true })).to.be.true;
      keyboardService.resetBinding('test-reset');

      expect(storedSettings().customBindings ?? {}).to.not.have.property('test-reset');
      expect(keyboardService.isCustomized('test-reset')).to.be.false;
      expect(keyboardService.getBinding('test-reset')?.key).to.equal('a');
    } finally {
      keyboardService.unregister('test-reset');
    }
  });

  it('clears every custom binding on reset-all while keeping other settings', async () => {
    const { keyboardService } = await import('../keyboard.service.ts');
    keyboardService.register('test-reset-all-a', {
      key: 'a',
      action: () => {},
      description: 'Reset all A',
      category: 'Test',
    });
    keyboardService.register('test-reset-all-b', {
      key: 'b',
      action: () => {},
      description: 'Reset all B',
      category: 'Test',
    });
    const previousVimMode = keyboardService.isVimMode();

    try {
      keyboardService.setVimMode(true);
      expect(keyboardService.rebind('test-reset-all-a', { key: 'q', ctrl: true })).to.be.true;
      expect(keyboardService.rebind('test-reset-all-b', { key: 'w', ctrl: true })).to.be.true;

      keyboardService.resetAllBindings();

      expect(storedSettings().customBindings).to.deep.equal({});
      expect(storedSettings().vimMode).to.be.true;
      expect(keyboardService.isCustomized('test-reset-all-a')).to.be.false;
      expect(keyboardService.isCustomized('test-reset-all-b')).to.be.false;
    } finally {
      keyboardService.setVimMode(previousVimMode);
      keyboardService.unregister('test-reset-all-a');
      keyboardService.unregister('test-reset-all-b');
    }
  });
});

describe('modal overlays own the keyboard', () => {
  // Every shortcut lives on `document`, so a plain `s` behind an open dialog
  // staged the whole working tree and `u` unstaged it — with the file-status
  // panel hidden behind the overlay, so nothing visibly happened.
  afterEach(() => {
    resetOverlayStack();
    keyboardService.setEnabled(true);
  });

  it('does not run a plain-key shortcut while a dialog covers the app, and restores it on close', () => {
    let fired = 0;
    keyboardService.register('test-overlay-plain', {
      key: 'y',
      description: 'destructive probe',
      category: 'Test',
      action: () => {
        fired++;
      },
    });

    const dialog = {};
    try {
      pushOverlay(dialog);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y' }));
      expect(fired, 'no shortcut may run behind an overlay').to.equal(0);

      removeOverlay(dialog);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y' }));
      expect(fired, 'and it works again once the dialog closes').to.equal(1);
    } finally {
      keyboardService.unregister('test-overlay-plain');
    }
  });

  it('keeps blocking while a dialog remains under the one that closed', () => {
    let fired = 0;
    keyboardService.register('test-overlay-nested', {
      key: 'y',
      description: 'destructive probe',
      category: 'Test',
      action: () => {
        fired++;
      },
    });

    const dialog = {};
    const palette = {};
    try {
      pushOverlay(dialog);
      pushOverlay(palette);
      removeOverlay(palette);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y' }));

      expect(fired, 'the dialog underneath still covers the app').to.equal(0);
    } finally {
      keyboardService.unregister('test-overlay-nested');
    }
  });

  it('does not drive vim navigation behind a dialog', () => {
    let down = 0;
    keyboardService.setVimMode(true);
    keyboardService.setVimActions({
      navigateDown: () => {
        down++;
      },
    });

    const dialog = {};
    try {
      pushOverlay(dialog);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
      expect(down, 'j must not move the graph behind a modal').to.equal(0);

      removeOverlay(dialog);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
      expect(down, 'and it moves again once the dialog closes').to.equal(1);
    } finally {
      keyboardService.setVimMode(false);
      keyboardService.setVimActions({});
    }
  });

  it('still runs Ctrl/Cmd combos while a dialog covers the app', () => {
    // The guard must not kill Cmd+P, Cmd+, or Ctrl+Enter from inside a dialog:
    // those are deliberate and unambiguous.
    let fired = 0;
    keyboardService.register('test-overlay-mod', {
      key: 'r',
      ctrl: true,
      description: 'mod probe',
      category: 'Test',
      action: () => {
        fired++;
      },
    });

    try {
      pushOverlay({});
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true }));
      expect(fired, 'modifier combos stay live behind an overlay').to.equal(1);
    } finally {
      keyboardService.unregister('test-overlay-mod');
    }
  });
});
