/**
 * Sidebar context menus must not survive a repository switch.
 *
 * gn-left-panel keeps ONE instance of each list across tabs and only rebinds
 * `.repositoryPath`. The only close paths a menu has are a document click and
 * Escape, and a Ctrl+digit / Ctrl+Tab switch produces neither — so an open menu
 * stayed on screen over the new repo's rows while its entries still resolved
 * the repo from `this.repositoryPath` at click time. Right-click `v1.0.0` in
 * repo A, Ctrl+2, click Delete, and the irreversible operation ran against
 * repo B — which routinely has a tag by the same name.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: Record<string, unknown>) => mockInvoke(command, args),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture } from '@open-wc/testing';
import '../gn-branch-list.ts';
import '../gn-file-status.ts';
import '../gn-stash-list.ts';
import '../gn-tag-list.ts';

type Loadable = HTMLElement & { repositoryPath: string; updateComplete: Promise<unknown> };

/** Rows loaded per repo path, keyed by the command that fetches them. */
let rows: Record<string, Record<string, unknown[]>> = {};
/** Commands whose next call must reject, simulating a failed load. */
let failing = new Set<string>();
/** Every invoke, so a test can assert WHICH paths an operation actually hit. */
let calls: Array<{ command: string; args: Record<string, unknown> }> = [];

function installMock(): void {
  mockInvoke = (command, args) => {
    const path = String((args as { path?: string })?.path ?? '');
    calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
    if (failing.has(command)) {
      return Promise.reject({ code: 'COMMAND_ERROR', message: 'repository is locked' });
    }
    const forCommand = rows[path]?.[command];
    if (forCommand) return Promise.resolve(forCommand);
    if (command === 'get_tag_sort_mode') return Promise.resolve('name');
    return Promise.resolve(null);
  };
}

/** Let an un-awaited async `updated()`/load settle. */
async function flush(el: Loadable): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
  }
  await el.updateComplete;
}

/** Right-click the first row matching `selector`, as a user would. */
function rightClickRow(el: HTMLElement, selector: string): void {
  const row = el.shadowRoot!.querySelector(selector);
  if (!row) throw new Error(`no ${selector} row to right-click`);
  row.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, composed: true, clientX: 40, clientY: 60 })
  );
}

function menuOf(el: HTMLElement): Element | null {
  return el.shadowRoot!.querySelector('.context-menu');
}

/** Asserted on instead of the element itself: a failed `.to.be.null` on a DOM
 * node makes chai deep-inspect the whole menu subtree, which drowns the
 * reporter and turns a one-line failure into a runner timeout. */
function menuCount(el: HTMLElement): number {
  return el.shadowRoot!.querySelectorAll('.context-menu').length;
}

function makeTag(name: string) {
  return { name, targetOid: `oid-${name}`, message: null, tagger: null, isAnnotated: false };
}

function makeBranch(name: string) {
  return {
    name,
    shorthand: name,
    isHead: false,
    isRemote: false,
    upstream: null,
    targetOid: `oid-${name}`,
    isStale: false,
  };
}

function makeStash(index: number, message: string) {
  return { index, message, oid: `oid-${index}`, branch: 'main', timestamp: 0 };
}

function makeEntry(path: string) {
  return { path, status: 'modified', isStaged: false, isConflicted: false };
}

/**
 * One table-driven case per list: how to seed its rows, which row to
 * right-click, and the label the menu carries so the assertions are about the
 * REAL menu and not some other node.
 */
const cases = [
  {
    name: 'gn-tag-list',
    tag: 'gn-tag-list',
    command: 'get_tags',
    row: '.tag-item',
    menuLabel: 'Tag actions',
    // The same name in both repos: the exact collision that makes a leaked
    // menu destructive rather than merely confusing.
    a: [makeTag('v1.0.0')],
    b: [makeTag('v1.0.0')],
  },
  {
    name: 'gn-branch-list',
    tag: 'gn-branch-list',
    command: 'get_branches',
    row: '.branch-item',
    menuLabel: 'Branch actions',
    a: [makeBranch('develop')],
    b: [makeBranch('develop')],
  },
  {
    name: 'gn-stash-list',
    tag: 'gn-stash-list',
    command: 'get_stashes',
    row: '.stash-item',
    menuLabel: 'Stash actions',
    a: [makeStash(0, 'WIP on develop')],
    b: [makeStash(0, 'WIP on develop')],
  },
  {
    name: 'gn-file-status',
    tag: 'gn-file-status',
    command: 'get_status',
    row: '.file-item',
    menuLabel: 'File actions',
    a: [makeEntry('src/main.ts')],
    b: [makeEntry('src/main.ts')],
  },
] as const;

describe('sidebar context menus across a repository switch', () => {
  beforeEach(() => {
    rows = {};
    failing = new Set();
    calls = [];
    installMock();
  });

  for (const c of cases) {
    describe(c.name, () => {
      async function mounted(): Promise<Loadable> {
        rows['/repo/a'] = { [c.command]: [...c.a] };
        rows['/repo/b'] = { [c.command]: [...c.b] };
        const list = await fixture<Loadable>(`<${c.tag}></${c.tag}>`);
        list.repositoryPath = '/repo/a';
        await flush(list);
        return list;
      }

      it('closes an open menu when the tab switch rebinds the repository', async () => {
        const el = await mounted();
        rightClickRow(el, c.row);
        await el.updateComplete;

        expect(menuCount(el), 'the menu opens on right-click').to.equal(1);
        expect(menuOf(el)!.getAttribute('aria-label')).to.equal(c.menuLabel);

        // Exactly what a Ctrl+digit switch does: gn-left-panel rebinds the
        // property on the SAME element. No click, no Escape.
        el.repositoryPath = '/repo/b';
        await flush(el);

        expect(menuCount(el), 'no menu survives into the new repository').to.equal(0);
      });

      it('keeps the menu open across a refresh of the same repository', async () => {
        // The guard must key off a repo CHANGE, not any re-render: a refresh
        // must not yank the menu out from under the user's click. Re-assigning
        // the SAME path would prove nothing — `repositoryPath` is a plain
        // @property, so Lit's `!==` check requests no update at all. Drive the
        // component's own refresh instead, which re-renders with
        // `changedProperties.has('repositoryPath')` false.
        const el = await mounted();
        rightClickRow(el, c.row);
        await el.updateComplete;
        expect(menuCount(el), 'the menu opens on right-click').to.equal(1);

        await (el as unknown as { refresh: () => unknown }).refresh();
        // A load that happens to produce identical state re-renders nothing, so
        // force one update cycle to guarantee `updated()` actually runs.
        (el as unknown as { requestUpdate: () => void }).requestUpdate();
        await flush(el);

        expect(menuCount(el), 'a same-repo refresh leaves the menu alone').to.equal(1);
        expect(
          (el as unknown as { contextMenu: { visible: boolean } }).contextMenu.visible,
          'a same-repo refresh leaves the menu armed'
        ).to.equal(true);
      });

      it('closes the menu even when the new repository fails to load', async () => {
        // The close must happen BEFORE the reload await, or a failing load
        // leaves the menu armed: gn-branch-list and gn-file-status swap the
        // whole body for an error state, so the node is merely hidden and comes
        // straight back — still holding repo A's row — the moment a later
        // refresh succeeds. Hence the assertion is on the state the entries
        // actually read, not on the DOM, which cannot tell the two apart.
        const el = await mounted();
        rightClickRow(el, c.row);
        await el.updateComplete;
        expect(menuCount(el), 'the menu opens on right-click').to.equal(1);

        failing.add(c.command);
        el.repositoryPath = '/repo/b';
        await flush(el);

        expect(
          (el as unknown as { contextMenu: { visible: boolean } }).contextMenu.visible,
          'a failed load still disarms the menu'
        ).to.equal(false);
      });
    });
  }
});

/**
 * The multi-file selection must not survive a repository switch either.
 *
 * `selectedFiles` holds PATHS, and the row buttons redirect to the batch
 * handlers whenever the clicked file is in it. Several worktrees of one project
 * open as tabs share paths by construction, so a selection carried across the
 * rebind silently re-selects the new repo's same-named files — and the × on one
 * row then discards every one of them.
 */
describe('gn-file-status selection across a repository switch', () => {
  beforeEach(() => {
    rows = {};
    failing = new Set();
    calls = [];
    installMock();
  });

  const entries = [makeEntry('src/main.ts'), makeEntry('README.md')];

  /** Ctrl+click a row by path, as a user building a multi-selection would. */
  function ctrlClickRow(el: HTMLElement, path: string): void {
    const row = el.shadowRoot!.querySelector(`.file-item[title="${path}"]`);
    if (!row) throw new Error(`no row for ${path}`);
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, ctrlKey: true }));
  }

  function selectedPaths(el: HTMLElement): string[] {
    return Array.from((el as unknown as { selectedFiles: Set<string> }).selectedFiles).sort();
  }

  function selectedRowCount(el: HTMLElement): number {
    return el.shadowRoot!.querySelectorAll('.file-item.selected').length;
  }

  /** Mounted on /repo/a with both files selected; /repo/b has the same paths. */
  async function twoSelectedInRepoA(): Promise<Loadable> {
    rows['/repo/a'] = { get_status: [...entries] };
    rows['/repo/b'] = { get_status: [...entries] };
    const el = await fixture<Loadable>('<gn-file-status></gn-file-status>');
    el.repositoryPath = '/repo/a';
    await flush(el);

    ctrlClickRow(el, 'src/main.ts');
    ctrlClickRow(el, 'README.md');
    await el.updateComplete;

    expect(selectedPaths(el), 'both rows are selected in repo A').to.deep.equal([
      'README.md',
      'src/main.ts',
    ]);
    expect(selectedRowCount(el), 'both rows render selected').to.equal(2);
    return el;
  }

  it('clears the selection when the tab switch rebinds the repository', async () => {
    const el = await twoSelectedInRepoA();

    el.repositoryPath = '/repo/b';
    await flush(el);

    expect(selectedPaths(el), 'no selection survives into the new repository').to.deep.equal([]);
    expect(selectedRowCount(el), 'no row in the new repository renders selected').to.equal(0);
    expect(
      (el as unknown as { lastSelectedFile: string | null }).lastSelectedFile,
      'the shift-range anchor is dropped with the selection'
    ).to.equal(null);
  });

  it('keeps a single-file stage single-file after the switch', async () => {
    // The user-visible failure: handleStageFile redirects to the BATCH handler
    // whenever the clicked file is in a >1 selection, so a leaked selection
    // turns one row's + button into an operation over files never selected here.
    const el = await twoSelectedInRepoA();

    el.repositoryPath = '/repo/b';
    await flush(el);

    calls = [];
    const stage = el.shadowRoot!.querySelector<HTMLButtonElement>(
      'button[aria-label="Stage main.ts"]'
    );
    expect(stage, 'the row keeps its stage button').to.not.equal(null);
    stage!.click();
    await flush(el);

    const staged = calls.filter((c) => c.command === 'stage_files');
    expect(staged.length, 'exactly one stage command runs').to.equal(1);
    expect(staged[0].args.path, 'it targets the repository on screen').to.equal('/repo/b');
    expect(staged[0].args.paths, 'it stages only the clicked file').to.deep.equal([
      'src/main.ts',
    ]);
  });

  it('keeps the selection across a refresh of the same repository', async () => {
    // The guard keys off a repo CHANGE, not any re-render: a watcher-driven
    // refresh must not wipe a selection the user is still building.
    const el = await twoSelectedInRepoA();

    await (el as unknown as { refresh: () => unknown }).refresh();
    (el as unknown as { requestUpdate: () => void }).requestUpdate();
    await flush(el);

    expect(selectedPaths(el), 'a same-repo refresh leaves the selection alone').to.deep.equal([
      'README.md',
      'src/main.ts',
    ]);
  });

  it('clears the selection even when the new repository fails to load', async () => {
    // The clear must happen BEFORE the reload await, or a failing load leaves
    // repo A's paths armed behind the error state — ready to fire the moment a
    // later refresh succeeds.
    const el = await twoSelectedInRepoA();

    failing.add('get_status');
    el.repositoryPath = '/repo/b';
    await flush(el);

    expect(selectedPaths(el), 'a failed load still drops the selection').to.deep.equal([]);
  });
});
