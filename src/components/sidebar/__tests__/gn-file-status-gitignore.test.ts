/**
 * Tests the "Add to .gitignore" entry point in gn-file-status's context menu.
 *
 * The gitignore backend shipped fully implemented and completely unreachable:
 * nothing in the UI ever invoked `add_to_gitignore`, so a user could not ignore
 * an untracked file from the app at all. These tests cover the menu item, the
 * pattern it writes, and the failure path.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let failWith: { code?: string; message: string } | null = null;
const invokeHistory: Array<{ command: string; args?: unknown }> = [];

const mockInvoke: MockInvoke = async (command: string) => {
  if (command === 'plugin:notification|is_permission_granted') return false;
  if (command === 'add_to_gitignore' && failWith) throw failWith;
  if (command === 'get_status') return currentEntries;
  return null;
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import '../gn-file-status.ts';
import type { GnFileStatus } from '../gn-file-status.ts';
import type { StatusEntry } from '../../../types/git.types.ts';
import { uiStore } from '../../../stores/ui.store.ts';

const REPO_PATH = '/test/repo';
let currentEntries: StatusEntry[] = [];

function makeEntry(overrides: Partial<StatusEntry> = {}): StatusEntry {
  return {
    path: 'src/new-file.ts',
    status: 'untracked',
    isStaged: false,
    isConflicted: false,
    ...overrides,
  };
}

interface FileStatusInternal {
  stagedFiles: StatusEntry[];
  unstagedFiles: StatusEntry[];
  contextMenu: {
    visible: boolean;
    x: number;
    y: number;
    file: StatusEntry | null;
    isStaged: boolean;
  };
}

function internalOf(el: GnFileStatus): FileStatusInternal {
  return el as unknown as FileStatusInternal;
}

async function renderFileStatus(entries: StatusEntry[]): Promise<GnFileStatus> {
  currentEntries = entries;
  const el = await fixture<GnFileStatus>(html`
    <gn-file-status .repositoryPath=${REPO_PATH}></gn-file-status>
  `);
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
  const internal = internalOf(el);
  internal.unstagedFiles = entries.filter((f) => !f.isStaged);
  internal.stagedFiles = entries.filter((f) => f.isStaged);
  await el.updateComplete;
  return el;
}

async function openMenuFor(
  el: GnFileStatus,
  file: StatusEntry,
  isStaged = false,
): Promise<void> {
  internalOf(el).contextMenu = { visible: true, x: 0, y: 0, file, isStaged };
  await el.updateComplete;
}

function menuLabels(el: GnFileStatus): string[] {
  return Array.from(el.shadowRoot!.querySelectorAll('.context-menu-item')).map(
    (b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );
}

function menuItemMatching(el: GnFileStatus, text: string): HTMLElement | undefined {
  return Array.from(
    el.shadowRoot!.querySelectorAll<HTMLElement>('.context-menu-item'),
  ).find((b) => (b.textContent ?? '').replace(/\s+/g, ' ').includes(text));
}

function ignoreCalls(): Array<{ command: string; args?: unknown }> {
  return invokeHistory.filter((h) => h.command === 'add_to_gitignore');
}

describe('gn-file-status "Add to .gitignore"', () => {
  beforeEach(() => {
    invokeHistory.length = 0;
    failWith = null;
    const state = uiStore.getState();
    state.toasts.forEach((t) => state.removeToast(t.id));
  });

  it('offers Add to .gitignore for an untracked file and withholds it otherwise', async () => {
    const untracked = makeEntry();
    const modified = makeEntry({ path: 'src/edited.ts', status: 'modified' });
    const staged = makeEntry({ path: 'src/staged.ts', status: 'new', isStaged: true });
    const el = await renderFileStatus([untracked, modified, staged]);

    await openMenuFor(el, untracked);
    expect(menuLabels(el).some((l) => l.includes('Add to .gitignore'))).to.be
      .true;

    // gitignore rules never apply to a tracked file, so offering it there would
    // be a control that silently does nothing.
    await openMenuFor(el, modified);
    expect(menuLabels(el).some((l) => l.includes('Add to .gitignore'))).to.be
      .false;

    await openMenuFor(el, staged, true);
    expect(menuLabels(el).some((l) => l.includes('Add to .gitignore'))).to.be
      .false;
  });

  it('writes the root-anchored pattern, closes the menu and reloads the status', async () => {
    const untracked = makeEntry();
    const el = await renderFileStatus([untracked]);
    await openMenuFor(el, untracked);

    invokeHistory.length = 0;
    menuItemMatching(el, 'Add to .gitignore')!.click();
    await new Promise((r) => setTimeout(r, 50));
    await el.updateComplete;

    const calls = ignoreCalls();
    expect(calls.length).to.equal(1);
    expect(calls[0].args).to.deep.equal({
      path: REPO_PATH,
      patterns: ['/src/new-file.ts'],
    });

    // The file list must reload, and the reload must land AFTER the write.
    const writeAt = invokeHistory.findIndex((h) => h.command === 'add_to_gitignore');
    const reloadAt = invokeHistory.findIndex(
      (h, i) => i > writeAt && h.command === 'get_status',
    );
    expect(reloadAt, 'get_status must follow add_to_gitignore').to.be.greaterThan(
      writeAt,
    );

    expect(internalOf(el).contextMenu.visible).to.be.false;
  });

  it('never fails silently when add_to_gitignore rejects', async () => {
    failWith = { code: 'OPERATION_FAILED', message: 'permission denied' };
    const untracked = makeEntry();
    const el = await renderFileStatus([untracked]);
    await openMenuFor(el, untracked);

    invokeHistory.length = 0;
    menuItemMatching(el, 'Add to .gitignore')!.click();
    await new Promise((r) => setTimeout(r, 50));
    await el.updateComplete;

    const errorToast = uiStore
      .getState()
      .toasts.find((t) => t.type === 'error');
    expect(errorToast, 'a failed write must reach the user').to.not.be.undefined;
    expect(errorToast!.message).to.include('permission denied');

    // Nothing changed on disk, so nothing should have been reloaded.
    const reloaded = invokeHistory.filter((h) => h.command === 'get_status');
    expect(reloaded.length).to.equal(0);
  });

  it('escapes glob metacharacters and a trailing space in the pattern', async () => {
    const weird = makeEntry({ path: 'weird[1] draft.txt ' });
    const el = await renderFileStatus([weird]);
    await openMenuFor(el, weird);

    invokeHistory.length = 0;
    menuItemMatching(el, 'Add to .gitignore')!.click();
    await new Promise((r) => setTimeout(r, 50));

    expect((ignoreCalls()[0].args as { patterns: string[] }).patterns).to.deep.equal(
      ['/weird\\[1\\] draft.txt\\ '],
    );

    const starred = makeEntry({ path: 'logs/a*b.txt' });
    const el2 = await renderFileStatus([starred]);
    await openMenuFor(el2, starred);

    invokeHistory.length = 0;
    menuItemMatching(el2, 'Add to .gitignore')!.click();
    await new Promise((r) => setTimeout(r, 50));

    expect((ignoreCalls()[0].args as { patterns: string[] }).patterns).to.deep.equal(
      ['/logs/a\\*b.txt'],
    );
  });

  it('offers the extension rule only when the file name has an extension', async () => {
    const log = makeEntry({ path: 'logs/run.log' });
    const el = await renderFileStatus([log]);
    await openMenuFor(el, log);

    expect(menuLabels(el).some((l) => l.includes('Ignore all *.log files'))).to
      .be.true;

    invokeHistory.length = 0;
    menuItemMatching(el, 'Ignore all *.log files')!.click();
    await new Promise((r) => setTimeout(r, 50));

    expect((ignoreCalls()[0].args as { patterns: string[] }).patterns).to.deep.equal(
      ['*.log'],
    );

    for (const path of ['Makefile', '.env']) {
      const noExt = makeEntry({ path });
      const el2 = await renderFileStatus([noExt]);
      await openMenuFor(el2, noExt);
      expect(
        menuLabels(el2).some((l) => l.includes('Ignore all')),
        `${path} has no extension to offer`,
      ).to.be.false;
      // The plain per-file item is still there.
      expect(menuLabels(el2).some((l) => l.includes('Add to .gitignore'))).to.be
        .true;
    }
  });
});
