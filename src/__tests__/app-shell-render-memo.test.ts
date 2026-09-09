/**
 * Render-path performance guards for app-shell.
 *
 * render() used to rebuild the whole command-palette command list, copy every
 * loaded commit out of the graph canvas and walk its entire ref map on EVERY
 * update of a component with ~90 reactive fields — and it handed the palette
 * and the export/import dialog a fresh array identity each time, so both
 * rebuilt their lists even while closed. Dragging a panel divider made that
 * happen at pointer-event rate.
 *
 * These tests pin the fix WITHOUT allowing the behaviour to change: the
 * memoised list must still be rebuilt when its real input changes, the
 * mirrored commits/tags must still track the graph, and a drag must still end
 * on exactly the width the pointer was released at.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
let cbId = 0;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve(null),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect } from '@open-wc/testing';
import type { AppShell } from '../app-shell.ts';
import '../app-shell.ts';
import { repositoryStore } from '../stores/index.ts';
import { dialogs } from '../stores/dialog.store.ts';
import type { Commit, Repository } from '../types/git.types.ts';
import type { PaletteCommand } from '../components/dialogs/lv-command-palette.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

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

function makeCommit(oid: string, summary: string): Commit {
  return {
    oid,
    shortId: oid.substring(0, 7),
    message: summary,
    summary,
    body: '',
    author: { name: 'A', email: 'a@example.com', timestamp: 1700000000 },
    committer: { name: 'A', email: 'a@example.com', timestamp: 1700000000 },
    parentIds: [],
    timestamp: 1700000000,
  };
}

/** A detached shell: connectedCallback (and all its backend work) never runs. */
function makeShell(): AppShell {
  return document.createElement('lv-app-shell') as AppShell;
}

/** Force navigator.platform for the duration of a test. */
function stubPlatform(value: string): void {
  Object.defineProperty(window.navigator, 'platform', {
    value,
    configurable: true,
  });
}

function restorePlatform(): void {
  delete (window.navigator as unknown as Record<string, unknown>).platform;
}

/**
 * Count assignments to a reactive field. Lit defines its reactive properties
 * as accessors on the prototype, so an own accessor on the instance can
 * delegate to them and tally the writes — one write is exactly one re-render
 * request, which is what the throttling is about.
 */
function countWrites(el: AppShell, name: string): () => number {
  const proto = Object.getPrototypeOf(el) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, name);
  expect(desc, `expected a reactive accessor for ${name}`).to.not.be.undefined;
  let writes = 0;
  Object.defineProperty(el, name, {
    configurable: true,
    get: () => desc!.get!.call(el),
    set: (v: unknown) => {
      writes++;
      desc!.set!.call(el, v);
    },
  });
  return () => writes;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function shortcutOf(commands: PaletteCommand[], id: string): string | undefined {
  return commands.find((c) => c.id === id)?.shortcut;
}

describe('app-shell render-path memoisation', () => {
  afterEach(() => {
    restorePlatform();
    repositoryStore.getState().reset();
  });

  describe('palette command list', () => {
    it('returns the same list instance on repeated calls', () => {
      const el = makeShell();
      const first = (el as any).getPaletteCommands();
      const second = (el as any).getPaletteCommands();
      expect(second).to.equal(first);
    });

    it('is NOT rebuilt when unrelated state changes', () => {
      const el = makeShell();
      const first = (el as any).getPaletteCommands();

      // A representative spread of the ~90 reactive fields that change while
      // the app is simply being used.
      dialogs.open('outputPanel');
      (el as any).refOpsVersion = 7;
      (el as any).leftPanelWidth = 300;
      (el as any).selectedCommit = makeCommit('a'.repeat(40), 'Some commit');
      (el as any).activeRepository = { repository: mockRepo('/repo/one', 'one') };

      expect((el as any).getPaletteCommands()).to.equal(first);
    });

    it('IS rebuilt when the modifier-key label changes', () => {
      const el = makeShell();
      stubPlatform('Win32');
      const windowsCommands = (el as any).getPaletteCommands() as PaletteCommand[];
      expect(shortcutOf(windowsCommands, 'refresh')).to.equal('CtrlR');

      stubPlatform('MacIntel');
      const macCommands = (el as any).getPaletteCommands() as PaletteCommand[];
      expect(macCommands).to.not.equal(windowsCommands);
      expect(shortcutOf(macCommands, 'refresh')).to.equal('⌘R');
      expect(shortcutOf(macCommands, 'settings')).to.equal('⌘,');
    });

    it('still reflects the live repository state when a command runs', () => {
      const el = makeShell();
      const commands = (el as any).getPaletteCommands() as PaletteCommand[];
      const toggleOutput = commands.find((c) => c.id === 'toggle-output-panel');
      expect(toggleOutput).to.not.be.undefined;

      // The cached closures must read state at INVOCATION time, not at build
      // time — otherwise memoising would freeze the palette's behaviour.
      // The output panel lives inside the repository layout, so the toggle is
      // repository-scoped: give the shell one before invoking.
      (el as any).activeRepository = { repository: mockRepo('/repo/one', 'one') };
      dialogs.close('outputPanel');
      toggleOutput!.action();
      expect(dialogs.isOpen('outputPanel')).to.equal(true);

      const settings = commands.find((c) => c.id === 'settings');
      settings!.action();
      expect(dialogs.isOpen('settings')).to.equal(true);
    });

    it('guards a repository-only command with the live repository state', () => {
      const el = makeShell();
      const commands = (el as any).getPaletteCommands() as PaletteCommand[];
      const clean = commands.find((c) => c.id === 'clean');

      // No repository: refused (and the cached closure said so).
      dialogs.reset();
      (el as any).activeRepository = null;
      clean!.action();
      expect(dialogs.isOpen('clean')).to.equal(false);

      // Same cached closure, repository now open: allowed.
      (el as any).activeRepository = { repository: mockRepo('/repo/one', 'one') };
      clean!.action();
      expect(dialogs.isOpen('clean')).to.equal(true);
    });
  });

  describe('graph commits/tags mirror', () => {
    function stubCanvas(
      el: AppShell,
      canvas: {
        repositoryPath: string;
        getLoadedCommits: () => Commit[];
        getTagTips: () => Array<{ name: string; oid: string }>;
      } | null,
    ): void {
      Object.defineProperty(el, 'graphCanvas', {
        configurable: true,
        get: () => canvas ?? undefined,
      });
    }

    it('starts empty and mirrors the graph when it announces a change', () => {
      const el = makeShell();
      expect((el as any).graphPaletteCommits).to.deep.equal([]);
      expect((el as any).graphPaletteTags).to.deep.equal([]);
      expect((el as any).graphPaletteRepositoryPath).to.equal('');

      const commits = [makeCommit('b'.repeat(40), 'First')];
      const tags = [{ name: 'v1.0.0', oid: 'b'.repeat(40) }];
      stubCanvas(el, {
        repositoryPath: '/repo/one',
        getLoadedCommits: () => commits,
        getTagTips: () => tags,
      });

      (el as any).handleGraphCommitsChanged();

      expect((el as any).graphPaletteCommits).to.deep.equal(commits);
      expect((el as any).graphPaletteTags).to.deep.equal(tags);
      expect((el as any).graphPaletteRepositoryPath).to.equal('/repo/one');
    });

    it('picks up commits appended by a later load', () => {
      const el = makeShell();
      let commits = [makeCommit('c'.repeat(40), 'First')];
      stubCanvas(el, {
        repositoryPath: '/repo/one',
        getLoadedCommits: () => commits,
        getTagTips: () => [],
      });

      (el as any).handleGraphCommitsChanged();
      expect((el as any).graphPaletteCommits).to.have.length(1);

      commits = [...commits, makeCommit('d'.repeat(40), 'Second')];
      (el as any).handleGraphCommitsChanged();
      expect((el as any).graphPaletteCommits).to.have.length(2);
      expect((el as any).graphPaletteCommits[1].summary).to.equal('Second');
    });

    it('samples the repository path together with the two lists', () => {
      const el = makeShell();
      stubCanvas(el, {
        repositoryPath: '/repo/two',
        getLoadedCommits: () => [makeCommit('e'.repeat(40), 'Only')],
        getTagTips: () => [{ name: 'v2', oid: 'e'.repeat(40) }],
      });

      (el as any).syncGraphPaletteData();

      // The export dialog decides whether the lists belong to the repo it is
      // showing by comparing exactly these three, so they must never be
      // sampled at different moments.
      expect((el as any).graphPaletteRepositoryPath).to.equal('/repo/two');
      expect((el as any).graphPaletteCommits).to.have.length(1);
      expect((el as any).graphPaletteTags).to.have.length(1);
    });

    it('clears the mirror when there is no graph canvas', () => {
      const el = makeShell();
      stubCanvas(el, {
        repositoryPath: '/repo/one',
        getLoadedCommits: () => [makeCommit('f'.repeat(40), 'Only')],
        getTagTips: () => [{ name: 'v1', oid: 'f'.repeat(40) }],
      });
      (el as any).syncGraphPaletteData();
      expect((el as any).graphPaletteCommits).to.have.length(1);

      stubCanvas(el, null);
      (el as any).syncGraphPaletteData();
      expect((el as any).graphPaletteCommits).to.deep.equal([]);
      expect((el as any).graphPaletteTags).to.deep.equal([]);
      expect((el as any).graphPaletteRepositoryPath).to.equal('');
    });

    it('re-takes the mirror when the command palette opens', async () => {
      const el = makeShell();
      const commits = [makeCommit('a'.repeat(40), 'Loaded later')];
      stubCanvas(el, {
        repositoryPath: '/repo/one',
        getLoadedCommits: () => commits,
        getTagTips: () => [{ name: 'v9', oid: 'a'.repeat(40) }],
      });

      // No repository open: openCommandPalette takes the no-repo branch and
      // still has to leave the palette showing what the graph holds.
      (el as any).activeRepository = null;
      await (el as any).openCommandPalette();

      expect(dialogs.isOpen('commandPalette')).to.equal(true);
      expect((el as any).graphPaletteCommits).to.deep.equal(commits);
      expect((el as any).graphPaletteTags).to.have.length(1);
    });
  });

  describe('panel resize throttling', () => {
    function startDrag(el: AppShell, type: 'left' | 'right', clientX: number): void {
      (el as any).handleResizeStart(new MouseEvent('mousedown', { clientX }), type);
    }

    function move(clientX: number): void {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX }));
    }

    afterEach(() => {
      // Any test that leaves a drag open would keep document listeners alive.
      document.dispatchEvent(new MouseEvent('mouseup'));
    });

    it('coalesces a burst of mousemove events into a single width update', async () => {
      const el = makeShell();
      const writes = countWrites(el, 'leftPanelWidth');
      startDrag(el, 'left', 100);

      for (let i = 1; i <= 25; i++) move(100 + i);
      // Nothing applied yet — the frame has not run.
      expect(writes()).to.equal(0);

      await nextFrame();
      expect(writes()).to.equal(1);
      expect((el as any).leftPanelWidth).to.equal(245);

      document.dispatchEvent(new MouseEvent('mouseup'));
      expect(writes()).to.equal(1);
    });

    it('updates far fewer times than there are mousemove events across frames', async () => {
      const el = makeShell();
      const writes = countWrites(el, 'leftPanelWidth');
      startDrag(el, 'left', 100);

      const MOVES = 12;
      for (let frame = 0; frame < 4; frame++) {
        for (let i = 0; i < MOVES; i++) move(101 + frame * MOVES + i);
        await nextFrame();
      }
      const total = 4 * MOVES;
      expect(writes()).to.be.lessThan(total);
      expect(writes()).to.be.at.most(4);

      document.dispatchEvent(new MouseEvent('mouseup'));
    });

    it('lands on the final pointer position when mouseup shares the last frame', () => {
      const el = makeShell();
      startDrag(el, 'left', 100);

      move(150);
      move(190); // last move of the drag — never got its own frame
      document.dispatchEvent(new MouseEvent('mouseup'));

      // 220 (start) + 90 (delta), applied synchronously by the mouseup flush.
      expect((el as any).leftPanelWidth).to.equal(310);
    });

    it('keeps the right panel clamped and inverted, flushing on mouseup', () => {
      const el = makeShell();
      startDrag(el, 'right', 500);

      move(400); // dragging left widens the right panel
      document.dispatchEvent(new MouseEvent('mouseup'));
      expect((el as any).rightPanelWidth).to.equal(450);

      startDrag(el, 'right', 500);
      move(1000); // far past the minimum
      document.dispatchEvent(new MouseEvent('mouseup'));
      expect((el as any).rightPanelWidth).to.equal(280);
    });

    it('clamps the left panel to its bounds', () => {
      const el = makeShell();
      startDrag(el, 'left', 100);
      move(1000);
      document.dispatchEvent(new MouseEvent('mouseup'));
      expect((el as any).leftPanelWidth).to.equal(400);

      startDrag(el, 'left', 100);
      move(-1000);
      document.dispatchEvent(new MouseEvent('mouseup'));
      expect((el as any).leftPanelWidth).to.equal(150);
    });

    it('ignores mousemove once the drag has ended', async () => {
      const el = makeShell();
      startDrag(el, 'left', 100);
      move(150);
      document.dispatchEvent(new MouseEvent('mouseup'));
      const settled = (el as any).leftPanelWidth;

      // The listener is gone, but a queued frame must not resurrect a width
      // either.
      (el as any).handleResizeMove(new MouseEvent('mousemove', { clientX: 900 }));
      await nextFrame();
      expect((el as any).leftPanelWidth).to.equal(settled);
    });
  });
});
