/**
 * Tests for the repository tab bar: labels/tooltips, duplicate-name
 * disambiguation, active styling, status badges, the all-repos dropdown,
 * middle-click close, and the tab context menu.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
let cbId = 0;
let mockInvoke: (command: string, args?: unknown) => Promise<unknown> = () => Promise.resolve(null);
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
  transformCallback: () => cbId++,
};
(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  convertCallback: () => 0,
  unregisterListener: () => {},
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import type { LvToolbar } from '../lv-toolbar.ts';
import '../lv-toolbar.ts';
import { repositoryStore, uiStore } from '../../../stores/index.ts';
import type { Repository, Branch, Remote, StatusEntry } from '../../../types/git.types.ts';
import {
  resetRefOpLocks,
  tryAcquireRefOp,
  tryAcquirePush,
  releaseRefOp,
  releasePush,
} from '../../../utils/ref-lock.ts';
import { settingsStore } from '../../../stores/settings.store.ts';
import { runFetch, runPush } from '../../../services/remote-operations.service.ts';
import { collectUnhandledRejections } from '../../../test-utils/unhandled-rejections.ts';

/**
 * Commands parked until the test releases them, so a real operation can be
 * held open across an assertion.
 *
 * The in-flight states below are driven by starting the SHARED runner, not by
 * poking a lock key by hand: fetch, pull and push claim one per-repository
 * slot inside remote-operations.service and register which of the three holds
 * it, and only a claim made that way is visible to `runningRemoteOperation` —
 * which is what both this toolbar and the context dashboard read. A test that
 * claimed a key directly would pass against a toolbar reading a key nothing
 * claims.
 */
let parkedCommands = new Map<string, Array<(value: unknown) => void>>();

/** Hold `command` open until `releaseCommand` lets it finish. */
function parkCommand(command: string): void {
  parkedCommands.set(command, []);
}

function releaseCommand(command: string): void {
  for (const resolve of parkedCommands.get(command) ?? []) resolve(null);
  parkedCommands.delete(command);
}

/** An invoke that resolves everything with null, except parked commands. */
function parkingInvoke(command: string): Promise<unknown> {
  const waiting = parkedCommands.get(command);
  if (waiting) {
    return new Promise((resolve) => {
      waiting.push(resolve);
    });
  }
  return Promise.resolve(null);
}

/**
 * Wait until `command` reached the Tauri boundary.
 *
 * git.service resolves the remote, checks the security gate and looks up a
 * credential before it invokes, each behind its own await.
 */
function waitForInvoke(command: string): Promise<void> {
  return waitUntil(
    () => Boolean(parkedCommands.get(command)?.length),
    `Timed out waiting for ${command}`,
  );
}

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

function mockBranch(aheadBehind?: { ahead: number; behind: number }): Branch {
  return {
    name: 'main',
    shorthand: 'main',
    isHead: true,
    isRemote: false,
    upstream: 'origin/main',
    targetOid: 'abc123',
    aheadBehind,
    isStale: false,
  };
}

const dirtyEntry = { path: 'a.txt', status: 'modified', isStaged: false } as unknown as StatusEntry;

const originRemote: Remote = {
  name: 'origin',
  url: 'https://example.com/test/repo.git',
  pushUrl: null,
};

async function createToolbar(): Promise<LvToolbar> {
  return fixture<LvToolbar>(html`<lv-toolbar></lv-toolbar>`);
}

function tabs(el: LvToolbar): HTMLButtonElement[] {
  return Array.from(el.shadowRoot!.querySelectorAll('.tab'));
}

describe('lv-toolbar repository tabs', () => {
  beforeEach(() => {
    repositoryStore.getState().reset();
    mockInvoke = () => Promise.resolve(null);
  });

  describe('tab rendering', () => {
    it('shows the full path as a tooltip on every tab', async () => {
      repositoryStore.getState().addRepository(mockRepo('/work/api', 'api'));
      const el = await createToolbar();

      expect(tabs(el)[0].title).to.equal('/work/api');
    });

    it('disambiguates duplicate repo names on Windows-style paths', async () => {
      repositoryStore.getState().addRepository(mockRepo('C:\\work\\client-a\\api', 'api'));
      repositoryStore.getState().addRepository(mockRepo('C:\\work\\client-b\\api', 'api'));
      const el = await createToolbar();

      const hints = tabs(el).map((t) => t.querySelector('.tab-hint')?.textContent?.trim() ?? null);
      expect(hints[0]).to.equal('client-a');
      expect(hints[1]).to.equal('client-b');
    });

    it('disambiguates duplicate repo names with the parent directory', async () => {
      repositoryStore.getState().addRepository(mockRepo('/client-a/api', 'api'));
      repositoryStore.getState().addRepository(mockRepo('/client-b/api', 'api'));
      repositoryStore.getState().addRepository(mockRepo('/work/web', 'web'));
      const el = await createToolbar();

      const hints = tabs(el).map((t) => t.querySelector('.tab-hint')?.textContent?.trim() ?? null);
      expect(hints[0]).to.equal('client-a');
      expect(hints[1]).to.equal('client-b');
      expect(hints[2]).to.equal(null, 'unique names need no hint');
    });

    it('marks the active tab with class, aria-selected and an accent', async () => {
      repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
      repositoryStore.getState().addRepository(mockRepo('/repo/two', 'two'));
      const el = await createToolbar();

      const [first, second] = tabs(el);
      expect(second.classList.contains('active')).to.be.true;
      expect(second.getAttribute('aria-selected')).to.equal('true');
      expect(first.classList.contains('active')).to.be.false;
      expect(first.getAttribute('aria-selected')).to.equal('false');
    });
  });

  describe('tab badges', () => {
    it('shows a dirty dot when the repo has uncommitted changes', async () => {
      repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
      repositoryStore.getState().updateRepoData('/repo/one', { status: [dirtyEntry] });
      const el = await createToolbar();

      expect(tabs(el)[0].querySelector('.tab-dirty')).to.exist;
    });

    it('shows no dirty dot for a clean repo', async () => {
      repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
      const el = await createToolbar();

      expect(tabs(el)[0].querySelector('.tab-dirty')).to.not.exist;
    });

    it('shows ahead/behind counts when the branch diverges from upstream', async () => {
      repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
      repositoryStore.getState().updateRepoData('/repo/one', {
        currentBranch: mockBranch({ ahead: 2, behind: 1 }),
      });
      const el = await createToolbar();

      const badge = tabs(el)[0].querySelector('.tab-ahead-behind');
      expect(badge).to.exist;
      expect(badge!.textContent).to.contain('↑2');
      expect(badge!.textContent).to.contain('↓1');
    });

    it('shows no ahead/behind badge when in sync', async () => {
      repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
      repositoryStore.getState().updateRepoData('/repo/one', {
        currentBranch: mockBranch({ ahead: 0, behind: 0 }),
      });
      const el = await createToolbar();

      expect(tabs(el)[0].querySelector('.tab-ahead-behind')).to.not.exist;
    });
  });

  describe('all-repositories dropdown', () => {
    it('lists every open repo with its path and activates on click', async () => {
      repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
      repositoryStore.getState().addRepository(mockRepo('/repo/two', 'two'));
      const el = await createToolbar();

      (el.shadowRoot!.querySelector('.tab-list-btn') as HTMLButtonElement).click();
      await el.updateComplete;

      const items = Array.from(el.shadowRoot!.querySelectorAll('.tab-list-item'));
      expect(items.length).to.equal(2);
      expect(items[0].textContent).to.contain('one');
      expect(items[0].querySelector('.item-path')!.textContent).to.contain('/repo/one');
      // Active repo (two) carries the check mark
      expect(items[1].querySelector('.check svg')).to.exist;
      expect(items[0].querySelector('.check svg')).to.not.exist;

      (items[0] as HTMLButtonElement).click();
      await el.updateComplete;

      expect(repositoryStore.getState().activeIndex).to.equal(0);
      expect(el.shadowRoot!.querySelector('.tab-list-menu')).to.not.exist;
    });

    it('is hidden when no repositories are open', async () => {
      const el = await createToolbar();
      expect(el.shadowRoot!.querySelector('.tab-list-btn')).to.not.exist;
    });
  });

  describe('middle-click close', () => {
    it('closes the tab on middle click', async () => {
      repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
      repositoryStore.getState().addRepository(mockRepo('/repo/two', 'two'));
      const el = await createToolbar();

      tabs(el)[0].dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
      await el.updateComplete;

      const state = repositoryStore.getState();
      expect(state.openRepositories.length).to.equal(1);
      expect(state.openRepositories[0].repository.path).to.equal('/repo/two');
    });

    it('ignores non-middle auxclicks', async () => {
      repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
      const el = await createToolbar();

      tabs(el)[0].dispatchEvent(new MouseEvent('auxclick', { button: 2, bubbles: true }));
      await el.updateComplete;

      expect(repositoryStore.getState().openRepositories.length).to.equal(1);
    });
  });

  describe('tab context menu', () => {
    async function openContextMenu(el: LvToolbar, tabIndex: number): Promise<HTMLElement> {
      tabs(el)[tabIndex].dispatchEvent(
        new MouseEvent('contextmenu', { clientX: 50, clientY: 50, bubbles: true, cancelable: true })
      );
      await el.updateComplete;
      const menu = el.shadowRoot!.querySelector('.tab-context-menu');
      expect(menu).to.exist;
      return menu as HTMLElement;
    }

    function menuItem(menu: HTMLElement, label: string): HTMLButtonElement {
      const item = Array.from(menu.querySelectorAll('.context-menu-item')).find((b) =>
        b.textContent!.includes(label)
      );
      expect(item, `menu item "${label}"`).to.exist;
      return item as HTMLButtonElement;
    }

    beforeEach(() => {
      repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
      repositoryStore.getState().addRepository(mockRepo('/repo/two', 'two'));
      repositoryStore.getState().addRepository(mockRepo('/repo/three', 'three'));
    });

    it('Close closes only that tab', async () => {
      const el = await createToolbar();
      const menu = await openContextMenu(el, 1);

      menuItem(menu, 'Close').click();
      await el.updateComplete;

      const paths = repositoryStore.getState().openRepositories.map((r) => r.repository.path);
      expect(paths).to.deep.equal(['/repo/one', '/repo/three']);
    });

    it('Close Others keeps only the clicked tab', async () => {
      const el = await createToolbar();
      const menu = await openContextMenu(el, 1);

      menuItem(menu, 'Close Others').click();
      await el.updateComplete;

      const paths = repositoryStore.getState().openRepositories.map((r) => r.repository.path);
      expect(paths).to.deep.equal(['/repo/two']);
      expect(repositoryStore.getState().activeIndex).to.equal(0);
    });

    it('Close Tabs to the Right closes everything after the clicked tab', async () => {
      const el = await createToolbar();
      const menu = await openContextMenu(el, 0);

      menuItem(menu, 'Close Tabs to the Right').click();
      await el.updateComplete;

      const paths = repositoryStore.getState().openRepositories.map((r) => r.repository.path);
      expect(paths).to.deep.equal(['/repo/one']);
    });

    it('Close All closes every tab', async () => {
      const el = await createToolbar();
      const menu = await openContextMenu(el, 0);

      menuItem(menu, 'Close All').click();
      await el.updateComplete;

      expect(repositoryStore.getState().openRepositories.length).to.equal(0);
      expect(repositoryStore.getState().activeIndex).to.equal(-1);
    });

    it('disables Close Tabs to the Right on the last tab', async () => {
      const el = await createToolbar();
      const menu = await openContextMenu(el, 2);

      expect(menuItem(menu, 'Close Tabs to the Right').disabled).to.be.true;
    });

    it('closes on Escape without touching any tab', async () => {
      const el = await createToolbar();
      await openContextMenu(el, 0);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.tab-context-menu')).to.not.exist;
      expect(repositoryStore.getState().openRepositories.length).to.equal(3);
    });

    it('the all-repositories dropdown also closes on Escape', async () => {
      const el = await createToolbar();
      (el.shadowRoot!.querySelector('.tab-list-btn') as HTMLButtonElement).click();
      await el.updateComplete;
      expect(el.shadowRoot!.querySelector('.tab-list-menu')).to.exist;

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.tab-list-menu')).to.not.exist;
    });

    describe('open this repository elsewhere', () => {
      /** Let the click handler's awaited service call settle. */
      async function settle(el: LvToolbar): Promise<void> {
        await new Promise((r) => setTimeout(r, 0));
        await el.updateComplete;
      }

      let invoked: Array<{ command: string; args: Record<string, unknown> }>;

      beforeEach(() => {
        invoked = [];
        uiStore.setState({ toasts: [] });
        mockInvoke = (command: string, args?: unknown) => {
          invoked.push({ command, args: (args as Record<string, unknown>) ?? {} });
          // open_in_configured_editor resolves with an OpenResult payload.
          if (command === 'open_in_configured_editor') {
            return Promise.resolve({ success: true, message: 'Opened in code' });
          }
          return Promise.resolve(null);
        };
      });

      function errorToasts(): Array<{ message: string; type: string }> {
        return uiStore.getState().toasts.filter((t) => t.type === 'error') as Array<{
          message: string;
          type: string;
        }>;
      }

      it('offers all three actions on the menu', async () => {
        const el = await createToolbar();
        const menu = await openContextMenu(el, 1);

        expect(menuItem(menu, 'Open in Terminal')).to.exist;
        expect(menuItem(menu, 'Reveal in File Manager')).to.exist;
        expect(menuItem(menu, 'Open in Editor')).to.exist;
      });

      it('Open in Terminal opens the CLICKED tab, not the active one', async () => {
        const el = await createToolbar();
        // The third tab is active; the menu is opened on the second.
        expect(repositoryStore.getState().activeIndex).to.equal(2);
        const menu = await openContextMenu(el, 1);

        menuItem(menu, 'Open in Terminal').click();
        await settle(el);

        const call = invoked.find((c) => c.command === 'open_terminal');
        expect(call, 'open_terminal should be invoked').to.exist;
        expect(call!.args.path).to.equal('/repo/two');
        expect(errorToasts()).to.have.lengthOf(0);
        expect(el.shadowRoot!.querySelector('.tab-context-menu')).to.not.exist;
      });

      it('Reveal in File Manager opens the clicked tab in the file manager', async () => {
        const el = await createToolbar();
        const menu = await openContextMenu(el, 0);

        menuItem(menu, 'Reveal in File Manager').click();
        await settle(el);

        const call = invoked.find((c) => c.command === 'open_file_manager');
        expect(call, 'open_file_manager should be invoked').to.exist;
        expect(call!.args.path).to.equal('/repo/one');
        expect(errorToasts()).to.have.lengthOf(0);
      });

      it('Open in Editor targets the repository root of the clicked tab', async () => {
        const el = await createToolbar();
        const menu = await openContextMenu(el, 2);

        menuItem(menu, 'Open in Editor').click();
        await settle(el);

        const call = invoked.find((c) => c.command === 'open_in_configured_editor');
        expect(call, 'open_in_configured_editor should be invoked').to.exist;
        expect(call!.args.path).to.equal('/repo/three');
        expect(call!.args.filePath).to.equal('/repo/three');
        expect(errorToasts()).to.have.lengthOf(0);
      });

      it('surfaces the backend reason when no terminal emulator is found', async () => {
        mockInvoke = (command: string) => {
          if (command === 'open_terminal') {
            return Promise.reject({
              code: 'OPERATION_FAILED',
              message: 'Operation failed: No terminal emulator found',
            });
          }
          return Promise.resolve(null);
        };

        const el = await createToolbar();
        const menu = await openContextMenu(el, 0);

        menuItem(menu, 'Open in Terminal').click();
        await settle(el);

        const errors = errorToasts();
        expect(errors, 'a failed terminal launch must not be silent').to.have.lengthOf(1);
        expect(errors[0].message).to.contain('No terminal emulator found');
      });

      it('surfaces the backend reason when the file manager cannot open', async () => {
        mockInvoke = (command: string) => {
          if (command === 'open_file_manager') {
            return Promise.reject({ code: 'INVALID_PATH', message: 'Invalid path: /repo/one' });
          }
          return Promise.resolve(null);
        };

        const el = await createToolbar();
        const menu = await openContextMenu(el, 0);

        menuItem(menu, 'Reveal in File Manager').click();
        await settle(el);

        const errors = errorToasts();
        expect(errors).to.have.lengthOf(1);
        expect(errors[0].message).to.contain('Invalid path: /repo/one');
      });

      it('reports an editor that resolves with success:false', async () => {
        mockInvoke = (command: string) => {
          if (command === 'open_in_configured_editor') {
            return Promise.resolve({ success: false, message: 'No editor configured' });
          }
          return Promise.resolve(null);
        };

        const el = await createToolbar();
        const menu = await openContextMenu(el, 0);

        menuItem(menu, 'Open in Editor').click();
        await settle(el);

        const errors = errorToasts();
        expect(errors, 'OpenResult.success === false must be reported').to.have.lengthOf(1);
        expect(errors[0].message).to.contain('No editor configured');
      });
    });

    it('closes via the backdrop without touching any tab', async () => {
      const el = await createToolbar();
      await openContextMenu(el, 0);

      (el.shadowRoot!.querySelector('.menu-backdrop') as HTMLElement).click();
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.tab-context-menu')).to.not.exist;
      expect(repositoryStore.getState().openRepositories.length).to.equal(3);
    });
  });

  describe('remote operation buttons', () => {
    /** A repo with a remote and an upstream branch — the normal case. */
    function openRemoteRepo(aheadBehind?: { ahead: number; behind: number }): string {
      const path = '/repo/one';
      repositoryStore.getState().addRepository(mockRepo(path, 'one'));
      repositoryStore.getState().updateRepoData(path, {
        remotes: [originRemote],
        currentBranch: mockBranch(aheadBehind),
      });
      return path;
    }

    function remoteBtn(el: LvToolbar, op: 'fetch' | 'pull' | 'push'): HTMLButtonElement {
      const btn = el.shadowRoot!.querySelector(`.remote-btn.${op}`);
      expect(btn, `${op} button`).to.exist;
      return btn as HTMLButtonElement;
    }

    beforeEach(() => {
      parkedCommands = new Map();
      mockInvoke = (command: string) => parkingInvoke(command);
      settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
    });

    afterEach(() => {
      // Release anything still parked first: a runner left awaiting its
      // invoke would hold the shared slot into the next test.
      for (const command of [...parkedCommands.keys()]) releaseCommand(command);
      resetRefOpLocks();
      settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
    });

    it('renders Fetch, Pull and Push with labels and shortcut hints', async () => {
      openRemoteRepo({ ahead: 0, behind: 0 });
      const el = await createToolbar();

      const group = el.shadowRoot!.querySelector('.remote-actions');
      expect(group, 'remote actions group').to.exist;
      expect(group!.getAttribute('role')).to.equal('group');

      for (const op of ['fetch', 'pull', 'push'] as const) {
        const btn = remoteBtn(el, op);
        // Accessible name and tooltip agree, and both name the operation
        expect(btn.getAttribute('aria-label')).to.equal(btn.title);
        expect(btn.getAttribute('aria-label')!.toLowerCase()).to.contain(op);
        expect(btn.getAttribute('aria-keyshortcuts')).to.contain('Control+Shift+');
        // Native buttons: reachable and activatable from the keyboard
        expect(btn.tagName).to.equal('BUTTON');
      }
    });

    it('advertises the macOS chord it shows, rather than Control', async () => {
      // aria-keyshortcuts was hard-coded to Control+Shift+… while the visible
      // tooltip was platform-aware, so a macOS screen-reader user was told a
      // chord the tooltip beside it contradicted. keyboard.service hashes ctrl
      // and meta to the same "mod", so ⌘⇧ really is bound.
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
      try {
        openRemoteRepo({ ahead: 0, behind: 0 });
        const el = await createToolbar();

        for (const [op, key] of [['fetch', 'F'], ['pull', 'P'], ['push', 'U']] as const) {
          const btn = remoteBtn(el, op);
          expect(btn.getAttribute('aria-keyshortcuts'), `${op} chord`).to.equal(
            `Meta+Shift+${key}`,
          );
          expect(btn.title, 'and the visible tooltip agrees').to.contain(`⌘⇧${key}`);
        }
      } finally {
        Reflect.deleteProperty(navigator, 'platform');
      }
    });

    it('advertises Control+Shift off macOS, matching its tooltip', async () => {
      Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true });
      try {
        openRemoteRepo({ ahead: 0, behind: 0 });
        const el = await createToolbar();

        for (const [op, key] of [['fetch', 'F'], ['pull', 'P'], ['push', 'U']] as const) {
          const btn = remoteBtn(el, op);
          expect(btn.getAttribute('aria-keyshortcuts'), `${op} chord`).to.equal(
            `Control+Shift+${key}`,
          );
          expect(btn.title).to.contain(`Ctrl+Shift+${key}`);
        }
      } finally {
        Reflect.deleteProperty(navigator, 'platform');
      }
    });

    it('disables all three with an explanation when no repository is open', async () => {
      const el = await createToolbar();

      for (const op of ['fetch', 'pull', 'push'] as const) {
        const btn = remoteBtn(el, op);
        expect(btn.disabled, `${op} disabled`).to.be.true;
        expect(btn.title).to.contain('open a repository first');
      }
    });

    it('disables all three when the repository has no remote', async () => {
      repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'));
      repositoryStore.getState().updateRepoData('/repo/one', {
        currentBranch: mockBranch({ ahead: 1, behind: 1 }),
      });
      const el = await createToolbar();

      for (const op of ['fetch', 'pull', 'push'] as const) {
        const btn = remoteBtn(el, op);
        expect(btn.disabled, `${op} disabled`).to.be.true;
        expect(btn.title).to.contain('no remote configured');
      }
    });

    it('shows the behind count on Pull and the ahead count on Push', async () => {
      openRemoteRepo({ ahead: 2, behind: 5 });
      const el = await createToolbar();

      const pull = remoteBtn(el, 'pull');
      const push = remoteBtn(el, 'push');
      expect(pull.querySelector('.remote-count')!.textContent!.trim()).to.equal('5');
      expect(push.querySelector('.remote-count')!.textContent!.trim()).to.equal('2');
      expect(pull.title).to.contain('5 incoming commits');
      expect(push.title).to.contain('2 local commits');
      // Something to do — neither is dimmed
      expect(pull.classList.contains('idle')).to.be.false;
      expect(push.classList.contains('idle')).to.be.false;
      // Fetch never carries a count
      expect(remoteBtn(el, 'fetch').querySelector('.remote-count')).to.not.exist;
    });

    it('dims Pull and Push, without disabling them, when there is nothing to do', async () => {
      openRemoteRepo({ ahead: 0, behind: 0 });
      const el = await createToolbar();

      const pull = remoteBtn(el, 'pull');
      const push = remoteBtn(el, 'push');
      expect(pull.classList.contains('idle')).to.be.true;
      expect(push.classList.contains('idle')).to.be.true;
      expect(pull.disabled).to.be.false;
      expect(push.disabled).to.be.false;
      expect(pull.title).to.contain('nothing to pull');
      expect(push.title).to.contain('nothing to push');
      expect(pull.querySelector('.remote-count')).to.not.exist;
      expect(push.querySelector('.remote-count')).to.not.exist;
    });

    it('keeps Push undimmed for a branch that has no upstream yet', async () => {
      const path = '/repo/one';
      repositoryStore.getState().addRepository(mockRepo(path, 'one'));
      repositoryStore.getState().updateRepoData(path, {
        remotes: [originRemote],
        currentBranch: { ...mockBranch(), upstream: null },
      });
      const el = await createToolbar();

      const push = remoteBtn(el, 'push');
      expect(push.disabled).to.be.false;
      expect(push.classList.contains('idle')).to.be.false;
      expect(push.title).to.contain('no upstream yet');
    });

    it('disables Fetch while a fetch is in flight and re-enables it after', async () => {
      const path = openRemoteRepo({ ahead: 0, behind: 0 });
      const el = await createToolbar();

      // Started through the shared runner — the way EVERY surface starts a
      // fetch (the dashboard button, Ctrl+Shift+F, the palette and this
      // toolbar all land in remote-operations.service). Claiming a key by
      // hand would prove nothing about the key production actually uses.
      parkCommand('fetch');
      const running = runFetch(path);
      await waitForInvoke('fetch');
      await el.updateComplete;

      expect(remoteBtn(el, 'fetch').disabled, 'Fetch is refused while it runs').to.be.true;
      expect(remoteBtn(el, 'fetch').title).to.contain('already in progress');

      releaseCommand('fetch');
      await running;
      await el.updateComplete;
      expect(remoteBtn(el, 'fetch').disabled).to.be.false;
      expect(remoteBtn(el, 'fetch').title).to.contain('Fetch from remote');
    });

    it('disables Pull and Push too while a fetch holds the repository, naming it', async () => {
      // The three share ONE per-repository slot, so a running fetch refuses a
      // pull and a push as well. The toolbar used to leave both lit: the click
      // reached the runner, which refused it — a pointless toast at best, and
      // for Fetch a completely silent no-op.
      const path = openRemoteRepo({ ahead: 2, behind: 3 });
      const el = await createToolbar();

      parkCommand('fetch');
      const running = runFetch(path);
      await waitForInvoke('fetch');
      await el.updateComplete;

      for (const op of ['pull', 'push'] as const) {
        const btn = remoteBtn(el, op);
        expect(btn.disabled, `${op} is refused while a fetch runs`).to.be.true;
        // Named, so the tooltip says what the app is actually doing.
        expect(btn.title).to.contain('a fetch is already running');
      }

      releaseCommand('fetch');
      await running;
      await el.updateComplete;
      expect(remoteBtn(el, 'pull').disabled).to.be.false;
      expect(remoteBtn(el, 'push').disabled).to.be.false;
    });

    it('disables Fetch and Pull while a push started elsewhere holds the repository', async () => {
      const path = openRemoteRepo({ ahead: 2, behind: 1 });
      const el = await createToolbar();

      parkCommand('push');
      const running = runPush(path);
      await waitForInvoke('push');
      await el.updateComplete;

      expect(remoteBtn(el, 'fetch').disabled).to.be.true;
      expect(remoteBtn(el, 'fetch').title).to.contain('a push is already running');
      expect(remoteBtn(el, 'pull').disabled).to.be.true;
      expect(remoteBtn(el, 'push').disabled).to.be.true;
      expect(remoteBtn(el, 'push').title).to.contain('already in progress');

      releaseCommand('push');
      await running;
      await el.updateComplete;
      expect(remoteBtn(el, 'fetch').disabled).to.be.false;
    });

    it('disables Pull while any working-tree operation holds the repository', async () => {
      const path = openRemoteRepo({ ahead: 0, behind: 3 });
      const el = await createToolbar();

      tryAcquireRefOp(path);
      await el.updateComplete;
      const pull = remoteBtn(el, 'pull');
      expect(pull.disabled).to.be.true;
      expect(pull.title).to.contain('already running in this repository');

      releaseRefOp(path);
      await el.updateComplete;
      expect(remoteBtn(el, 'pull').disabled).to.be.false;
    });

    it('disables Push while a push holds the repository push slot', async () => {
      const path = openRemoteRepo({ ahead: 2, behind: 0 });
      const el = await createToolbar();

      tryAcquirePush(path);
      await el.updateComplete;
      expect(remoteBtn(el, 'push').disabled).to.be.true;
      // A force push holds this slot too, and the toolbar cannot tell which —
      // so the tooltip must not claim a plain push specifically.
      expect(remoteBtn(el, 'push').title).to.contain('already running in this repository');

      releasePush(path);
      await el.updateComplete;
      expect(remoteBtn(el, 'push').disabled).to.be.false;
    });

    it('dispatches the matching remote event so app-shell runs the operation', async () => {
      openRemoteRepo({ ahead: 2, behind: 2 });
      const el = await createToolbar();

      for (const op of ['fetch', 'pull', 'push'] as const) {
        let detected: CustomEvent | null = null;
        const listener = (e: Event) => { detected = e as CustomEvent; };
        el.addEventListener(`remote-${op}`, listener);
        remoteBtn(el, op).click();
        el.removeEventListener(`remote-${op}`, listener);

        expect(detected, `remote-${op} dispatched`).to.not.be.null;
        expect(detected!.bubbles, 'reaches app-shell').to.be.true;
        expect(detected!.composed, 'crosses the shadow boundary').to.be.true;
      }
    });

    it('warns instead of failing silently if a click lands with no remote', async () => {
      const path = openRemoteRepo({ ahead: 1, behind: 0 });
      const el = await createToolbar();
      uiStore.setState({ toasts: [] });

      // The remote disappears (removed from another surface) between the
      // render and the click — the button is still the one the user pressed.
      repositoryStore.getState().updateRepoData(path, { remotes: [] });
      let dispatched = false;
      el.addEventListener('remote-push', () => { dispatched = true; });
      (el as unknown as { handleRemoteAction: (op: string) => void }).handleRemoteAction('push');

      expect(dispatched, 'no operation is started').to.be.false;
      const toast = uiStore.getState().toasts.at(-1);
      expect(toast, 'a warning is shown').to.exist;
      expect(toast!.message).to.contain('No remote configured');
    });

    it('warns instead of failing silently if a click lands with no repository', async () => {
      const el = await createToolbar();
      uiStore.setState({ toasts: [] });

      let dispatched = false;
      el.addEventListener('remote-fetch', () => { dispatched = true; });
      (el as unknown as { handleRemoteAction: (op: string) => void }).handleRemoteAction('fetch');

      expect(dispatched, 'no operation is started').to.be.false;
      const toast = uiStore.getState().toasts.at(-1);
      expect(toast, 'a warning is shown').to.exist;
      expect(toast!.message).to.contain('open a repository');
    });
  });

  describe('event surface', () => {
    // app-shell used to carry an `@repository-refresh` binding on <lv-toolbar>
    // that could never fire: neither the toolbar nor the clone/init dialogs it
    // hosts dispatch that event, so the binding was dead code. This pins the
    // toolbar's outgoing event surface — if a toolbar action ever does need to
    // ask the shell to refresh, this test fails and whoever adds the dispatch
    // must also restore the binding in app-shell's render().
    it('never dispatches repository-refresh from any toolbar action', async () => {
      mockInvoke = (command: string) => {
        // The folder picker is cancelled, so "Open Repository" is a no-op.
        if (command === 'plugin:dialog|open') return Promise.resolve(null);
        return Promise.resolve(null);
      };

      const el = await createToolbar();
      let refreshes = 0;
      el.addEventListener('repository-refresh', () => {
        refreshes += 1;
      });

      const buttons = Array.from(
        el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.menu-btn')
      );
      expect(buttons.length, 'the toolbar renders its menu buttons').to.be.greaterThan(0);

      for (const button of buttons) {
        button.click();
        await el.updateComplete;
      }

      expect(refreshes, 'no toolbar action asks the shell to refresh').to.equal(0);
    });
  });

  describe('open repository failures', () => {
    it('shows a toast (not just a silent store error) when opening fails', async () => {
      // Dialog returns a folder; the open then fails (e.g. not a git repo).
      mockInvoke = (command: string) => {
        if (command === 'plugin:dialog|open') return Promise.resolve('/not/a/repo');
        if (command === 'open_repository') {
          return Promise.reject({ message: 'not a git repository' });
        }
        return Promise.resolve(null);
      };
      uiStore.setState({ toasts: [] });

      const el = await createToolbar();
      await (el as unknown as { handleOpenRepo: () => Promise<void> }).handleOpenRepo();

      const toasts = uiStore.getState().toasts;
      const errorToast = toasts.find(t => t.type === 'error');
      expect(errorToast, 'an error toast is surfaced to the user').to.exist;
      expect(errorToast!.message).to.contain('not a git repository');
      // And the store error is still set for any listener.
      expect(repositoryStore.getState().error).to.contain('not a git repository');
    });
  });
});

describe('lv-toolbar menu bar routed actions', () => {
  // The native menu bar's File items are forwarded here by app-shell instead of
  // being reimplemented, so each one must land on the toolbar's own handler.
  beforeEach(() => {
    repositoryStore.getState().reset();
    mockInvoke = () => Promise.resolve(null);
  });

  it('opens the clone dialog for the Clone Repository menu item', async () => {
    const el = await createToolbar();
    const dialog = el.shadowRoot!.querySelector('lv-clone-dialog')!;
    let opened = 0;
    (dialog as unknown as { open: () => void }).open = () => {
      opened++;
    };

    el.dispatchEvent(new CustomEvent('clone-repository'));

    expect(opened).to.equal(1);
  });

  it('opens the init dialog for the New Repository menu item', async () => {
    const el = await createToolbar();
    const dialog = el.shadowRoot!.querySelector('lv-init-dialog')!;
    let opened = 0;
    (dialog as unknown as { open: () => void }).open = () => {
      opened++;
    };

    el.dispatchEvent(new CustomEvent('init-repository'));

    expect(opened).to.equal(1);
  });

  it('runs the same folder picker for the Open Repository menu item', async () => {
    const calls: string[] = [];
    mockInvoke = (command: string) => {
      calls.push(command);
      return Promise.resolve(null);
    };
    const el = await createToolbar();

    el.dispatchEvent(new CustomEvent('open-repository'));
    await waitUntil(
      () => calls.some((c) => c.startsWith('plugin:dialog|open')),
      'the folder picker to open',
    );
  });

  it('stops listening once the toolbar is disconnected', async () => {
    const el = await createToolbar();
    const dialog = el.shadowRoot!.querySelector('lv-clone-dialog')!;
    let opened = 0;
    (dialog as unknown as { open: () => void }).open = () => {
      opened++;
    };

    el.remove();
    el.dispatchEvent(new CustomEvent('clone-repository'));

    expect(opened).to.equal(0);
  });
});

// The store seeds every collection (`createEmptyRepoData`) and the backend
// returns `Vec`s, so `remotes`/`status` are never missing in the app. But a
// render function must not throw on a missing collection: a throw inside
// render() rejects the whole toolbar update, and the rejection is charged to
// whichever test happens to be running.
describe('lv-toolbar tabs for a repo missing its collections', () => {
  beforeEach(() => {
    repositoryStore.getState().reset();
    mockInvoke = () => Promise.resolve(null);
  });

  it('renders the tab with no provider icon and no dirty badge, and never throws', async () => {
    const el = await createToolbar();
    const bare = { repository: mockRepo('/repo/bare', 'bare'), branches: [], currentBranch: null };
    repositoryStore.setState({
      openRepositories: [
        bare,
        { ...bare, repository: mockRepo('/repo/nulls', 'nulls'), remotes: null, status: null },
      ] as never,
      activeIndex: 0,
    });

    const rejections = await collectUnhandledRejections(async () => {
      await el.updateComplete;
    });

    expect(rejections, 'the render must not reject').to.deep.equal([]);
    expect(tabs(el)).to.have.length(2);
    expect(el.shadowRoot!.querySelector('.provider-icon')).to.equal(null);
    expect(el.shadowRoot!.querySelector('.tab-dirty')).to.equal(null);
    // The remote buttons read the same collection and must degrade the same
    // way: no remote means the operation is unavailable, not a crash.
    const fetchBtn = el.shadowRoot!.querySelector('.remote-btn.fetch') as HTMLButtonElement | null;
    expect(fetchBtn, 'the fetch button is rendered').to.not.equal(null);
    expect(fetchBtn!.disabled, 'no remote means fetch is unavailable').to.be.true;
    expect(fetchBtn!.getAttribute('title')).to.match(/remote/i);
  });
});
