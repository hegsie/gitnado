/**
 * Tests that lv-file-status never stages conflicted files raw.
 *
 * Staging a conflicted file would write git's conflict-marker text into the
 * index and clear the conflict entries — git would then treat the file as
 * "resolved" with markers in it, bypassing the merge editor entirely.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invokeHistory: Array<{ command: string; args?: unknown }> = [];

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import '../lv-file-status.ts';
import type { LvFileStatus } from '../lv-file-status.ts';
import { uiStore } from '../../../stores/ui.store.ts';
import type { StatusEntry } from '../../../types/git.types.ts';

// ── Test data ──────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

function makeEntry(overrides: Partial<StatusEntry> = {}): StatusEntry {
  return {
    path: 'src/main.ts',
    status: 'modified',
    isStaged: false,
    isConflicted: false,
    ...overrides,
  };
}

interface FileStatusInternal {
  stagedFiles: StatusEntry[];
  unstagedFiles: StatusEntry[];
  selectedFiles: Set<string>;
  handleStageFile: (file: StatusEntry, e: Event) => Promise<void>;
  /**
   * "Stage everything the list shows" — what the section button, the s
   * shortcut and the palette's "Stage all changes" all reach. With no path
   * filter typed (as here) the shown set is the whole unstaged list.
   */
  handleStageAllShown: () => Promise<void>;
  handleUnstageAllShown: () => Promise<void>;
  handleStageSelected: () => Promise<void>;
  filterQuery: string;
}

function internalOf(el: LvFileStatus): FileStatusInternal {
  return el as unknown as FileStatusInternal;
}

function stageCalls(): Array<{ command: string; args?: unknown }> {
  return invokeHistory.filter((h) => h.command === 'stage_files');
}

async function renderFileStatus(entries: StatusEntry[]): Promise<LvFileStatus> {
  mockInvoke = async (command: string) => {
    switch (command) {
      case 'get_status':
        return entries;
      case 'stage_files':
      case 'unstage_files':
        return null;
      default:
        return null;
    }
  };

  const el = await fixture<LvFileStatus>(html`
    <lv-file-status .repositoryPath=${REPO_PATH}></lv-file-status>
  `);
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
  const internal = internalOf(el);
  internal.unstagedFiles = entries.filter((f) => !f.isStaged);
  internal.stagedFiles = entries.filter((f) => f.isStaged);
  await el.updateComplete;
  return el;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('lv-file-status conflicted staging guards', () => {
  beforeEach(() => {
    invokeHistory.length = 0;
    const state = uiStore.getState();
    state.toasts.forEach((t) => state.removeToast(t.id));
  });

  it('staging a conflicted file opens the conflict flow instead of staging markers', async () => {
    const conflicted = makeEntry({ path: 'src/conflict.ts', status: 'conflicted', isConflicted: true });
    const el = await renderFileStatus([conflicted]);

    let dialogRequestedFor: string | null = null;
    el.addEventListener('open-conflict-dialog', ((e: CustomEvent) => {
      dialogRequestedFor = e.detail?.filePath ?? null;
    }) as EventListener);

    invokeHistory.length = 0;
    await internalOf(el).handleStageFile(conflicted, new Event('click'));

    expect(stageCalls().length, 'stage_files must not be called').to.equal(0);
    expect(dialogRequestedFor).to.equal('src/conflict.ts');
  });

  it('stage-all skips conflicted files and stages the rest', async () => {
    const clean = makeEntry({ path: 'src/ok.ts' });
    const conflicted = makeEntry({ path: 'src/conflict.ts', status: 'conflicted', isConflicted: true });
    const el = await renderFileStatus([clean, conflicted]);

    invokeHistory.length = 0;
    await internalOf(el).handleStageAllShown();

    const calls = stageCalls();
    expect(calls.length).to.equal(1);
    expect((calls[0].args as { paths: string[] }).paths).to.deep.equal(['src/ok.ts']);
  });

  it('stage-all with only conflicted files stages nothing', async () => {
    const conflicted = makeEntry({ path: 'src/conflict.ts', status: 'conflicted', isConflicted: true });
    const el = await renderFileStatus([conflicted]);

    invokeHistory.length = 0;
    await internalOf(el).handleStageAllShown();

    expect(stageCalls().length).to.equal(0);
  });

  it('stage-click on a conflicted file in a multi-selection stages the clean subset', async () => {
    const clean = makeEntry({ path: 'src/ok.ts' });
    const conflicted = makeEntry({ path: 'src/conflict.ts', status: 'conflicted', isConflicted: true });
    const el = await renderFileStatus([clean, conflicted]);

    const internal = internalOf(el);
    internal.selectedFiles = new Set(['src/ok.ts', 'src/conflict.ts']);

    // Clicking the stage button on the CONFLICTED row of a multi-selection
    // must still stage the other selected files (skipping the conflicted
    // one), not silently drop them.
    invokeHistory.length = 0;
    await internal.handleStageFile(conflicted, new Event('click'));

    const calls = stageCalls();
    expect(calls.length).to.equal(1);
    expect((calls[0].args as { paths: string[] }).paths).to.deep.equal(['src/ok.ts']);
  });

  it('stage-selected skips conflicted files', async () => {
    const clean = makeEntry({ path: 'src/ok.ts' });
    const conflicted = makeEntry({ path: 'src/conflict.ts', status: 'conflicted', isConflicted: true });
    const el = await renderFileStatus([clean, conflicted]);

    const internal = internalOf(el);
    internal.selectedFiles = new Set(['src/ok.ts', 'src/conflict.ts']);
    invokeHistory.length = 0;
    await internal.handleStageSelected();

    const calls = stageCalls();
    expect(calls.length).to.equal(1);
    expect((calls[0].args as { paths: string[] }).paths).to.deep.equal(['src/ok.ts']);
  });

  // ── Discard guards (siblings of the stage guards above) ────────────────
  // Discarding a conflicted path either silently no-ops or DELETES the
  // merged working file (no stage-0 index entry) while the index stays
  // conflicted — it must be routed to the merge editor / skipped instead.

  function discardCalls(): Array<{ command: string; args?: unknown }> {
    return invokeHistory.filter((h) => h.command === 'discard_changes');
  }

  it('discarding a conflicted file opens the conflict flow instead', async () => {
    const conflicted = makeEntry({
      path: 'src/conflict.ts',
      status: 'conflicted',
      isConflicted: true,
    });
    const el = await renderFileStatus([conflicted]);

    let dialogRequestedFor: string | null = null;
    el.addEventListener('open-conflict-dialog', ((e: CustomEvent) => {
      dialogRequestedFor = e.detail?.filePath ?? null;
    }) as EventListener);

    invokeHistory.length = 0;
    await (
      el as unknown as { handleDiscardFile: (f: StatusEntry, e: Event) => Promise<void> }
    ).handleDiscardFile(conflicted, new Event('click'));

    expect(discardCalls().length, 'discard_changes must not be called').to.equal(0);
    expect(dialogRequestedFor).to.equal('src/conflict.ts');
  });

  it('discard-selected skips conflicted files and discards the rest', async () => {
    const clean = makeEntry({ path: 'src/ok.ts' });
    const conflicted = makeEntry({
      path: 'src/conflict.ts',
      status: 'conflicted',
      isConflicted: true,
    });
    const el = await renderFileStatus([clean, conflicted]);
    const internal = el as unknown as FileStatusInternal & {
      handleDiscardSelected: () => Promise<void>;
    };
    internal.selectedFiles = new Set(['src/ok.ts', 'src/conflict.ts']);

    // The destructive confirm must be accepted for the clean file's discard.
    const baseMock = mockInvoke;
    mockInvoke = async (command: string, args?: unknown) => {
      if (command === 'plugin:dialog|message') return 'Ok';
      return baseMock(command, args);
    };

    invokeHistory.length = 0;
    await internal.handleDiscardSelected();

    const calls = discardCalls();
    expect(calls.length).to.equal(1);
    expect((calls[0].args as { paths: string[] }).paths).to.deep.equal(['src/ok.ts']);
  });

  // ── The filtered-scope toast must count what was really staged ─────────
  // A conflicted file inside the filtered set is dropped before the backend
  // call, so counting the SHOWN files would have the toast claim more than
  // was staged — and contradict the "conflicted file skipped" warning that
  // goes out alongside it.

  function toastMessages(): string[] {
    return uiStore.getState().toasts.map((t) => t.message);
  }

  it('reports the staged count, not the shown count, when the filter hides a conflict', async () => {
    const entries = [
      makeEntry({ path: 'src/feat-a.ts' }),
      makeEntry({ path: 'src/feat-b.ts', status: 'conflicted', isConflicted: true }),
      makeEntry({ path: 'src/other-c.ts' }),
      makeEntry({ path: 'src/other-d.ts' }),
    ];
    const el = await renderFileStatus(entries);
    const internal = internalOf(el);
    internal.filterQuery = 'feat';
    await el.updateComplete;

    invokeHistory.length = 0;
    const state = uiStore.getState();
    state.toasts.forEach((t) => state.removeToast(t.id));
    await internal.handleStageAllShown();

    const calls = stageCalls();
    expect(calls.length).to.equal(1);
    expect((calls[0].args as { paths: string[] }).paths).to.deep.equal(['src/feat-a.ts']);

    const messages = toastMessages();
    expect(
      messages.some((m) => m.includes('Staged 1 of 4 files')),
      `expected a "Staged 1 of 4 files" toast, got: ${JSON.stringify(messages)}`,
    ).to.be.true;
    expect(messages.some((m) => m.includes('Staged 2 of 4 files'))).to.be.false;
    // The skipped-conflict warning still goes out and no longer contradicts it.
    expect(messages.some((m) => m.includes('1 conflicted file skipped'))).to.be.true;
  });

  it('does not blame the filter for a file only the conflict guard skipped', async () => {
    // The filter shows BOTH unstaged files, so it is hiding nothing: the one
    // file left unstaged was skipped by the conflict guard, which said so in
    // its own warning. A "the filter is hiding the rest" toast here would
    // contradict that warning and name a filter that withheld nothing.
    const entries = [
      makeEntry({ path: 'src/feat-a.ts' }),
      makeEntry({ path: 'src/feat-b.ts', status: 'conflicted', isConflicted: true }),
    ];
    const el = await renderFileStatus(entries);
    const internal = internalOf(el);
    internal.filterQuery = 'feat';
    await el.updateComplete;

    invokeHistory.length = 0;
    const state = uiStore.getState();
    state.toasts.forEach((t) => state.removeToast(t.id));
    await internal.handleStageAllShown();

    const calls = stageCalls();
    expect(calls.length).to.equal(1);
    expect((calls[0].args as { paths: string[] }).paths).to.deep.equal(['src/feat-a.ts']);

    const messages = toastMessages();
    expect(
      messages.some((m) => m.includes('is hiding the rest')),
      `the filter hid nothing, so no filtered-scope toast is due; got: ${JSON.stringify(messages)}`,
    ).to.be.false;
    // The conflict warning is still the one and only explanation.
    expect(messages.some((m) => m.includes('1 conflicted file skipped'))).to.be.true;
  });

  it('reports the unstaged count for a filtered unstage', async () => {
    const entries = [
      makeEntry({ path: 'src/feat-a.ts', isStaged: true }),
      makeEntry({ path: 'src/other-c.ts', isStaged: true }),
      makeEntry({ path: 'src/other-d.ts', isStaged: true }),
    ];
    const el = await renderFileStatus(entries);
    const internal = internalOf(el);
    internal.filterQuery = 'feat';
    await el.updateComplete;

    const state = uiStore.getState();
    state.toasts.forEach((t) => state.removeToast(t.id));
    await internal.handleUnstageAllShown();

    expect(
      toastMessages().some((m) => m.includes('Unstaged 1 of 3 files')),
      `expected an "Unstaged 1 of 3 files" toast, got: ${JSON.stringify(toastMessages())}`,
    ).to.be.true;
  });

  it('discard-selected with only conflicted files discards nothing', async () => {
    const conflicted = makeEntry({
      path: 'src/conflict.ts',
      status: 'conflicted',
      isConflicted: true,
    });
    const el = await renderFileStatus([conflicted]);
    const internal = el as unknown as FileStatusInternal & {
      handleDiscardSelected: () => Promise<void>;
    };
    internal.selectedFiles = new Set(['src/conflict.ts']);
    invokeHistory.length = 0;
    await internal.handleDiscardSelected();
    expect(discardCalls().length).to.equal(0);
  });
});
