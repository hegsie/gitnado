/**
 * Unit tests for lv-diff-view component.
 *
 * Renders the REAL lv-diff-view component, mocks only the Tauri invoke
 * layer, and verifies the actual component behavior and DOM output.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const invokeHistory: Array<{ command: string; args?: unknown }> = [];
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import type { DiffFile, DiffHunk, DiffLine, StatusEntry } from '../../../types/git.types.ts';
import type { LvDiffView } from '../lv-diff-view.ts';

// Import the actual component — registers <lv-diff-view> custom element
import '../lv-diff-view.ts';
import { uiStore } from '../../../stores/ui.store.ts';
import { settingsStore } from '../../../stores/settings.store.ts';

// ── Test data ──────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

function makeStatusEntry(overrides: Partial<StatusEntry> = {}): StatusEntry {
  return {
    path: 'src/main.ts',
    status: 'modified',
    isStaged: false,
    isConflicted: false,
    ...overrides,
  };
}

function makeDiffLine(overrides: Partial<DiffLine> = {}): DiffLine {
  return {
    content: 'some content',
    origin: 'context',
    oldLineNo: 1,
    newLineNo: 1,
    ...overrides,
  };
}

function makeDiffHunk(overrides: Partial<DiffHunk> = {}): DiffHunk {
  return {
    header: '@@ -1,5 +1,6 @@',
    oldStart: 1,
    oldLines: 5,
    newStart: 1,
    newLines: 6,
    lines: [
      makeDiffLine({ content: 'unchanged line', origin: 'context', oldLineNo: 1, newLineNo: 1 }),
      makeDiffLine({ content: 'old line', origin: 'deletion', oldLineNo: 2, newLineNo: null }),
      makeDiffLine({ content: 'new line', origin: 'addition', oldLineNo: null, newLineNo: 2 }),
      makeDiffLine({ content: 'another unchanged', origin: 'context', oldLineNo: 3, newLineNo: 3 }),
    ],
    ...overrides,
  };
}

function makeDiffFile(overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path: 'src/main.ts',
    oldPath: null,
    status: 'modified',
    hunks: [makeDiffHunk()],
    isBinary: false,
    isImage: false,
    imageType: null,
    additions: 1,
    deletions: 1,
    ...overrides,
  };
}

const CONFLICT_CONTENT = [
  'line before conflict',
  '<<<<<<< HEAD',
  'our change line 1',
  'our change line 2',
  '=======',
  'their change line 1',
  '>>>>>>> feature-branch',
  'line after conflict',
].join('\n');

// ── Helpers ────────────────────────────────────────────────────────────────
function clearHistory(): void {
  invokeHistory.length = 0;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncUpdates(el: LvDiffView): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await el.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Flush repeatedly so a chain of awaited invokes settles before asserting. */
async function settleAsyncUpdates(el: LvDiffView, times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await flushAsyncUpdates(el);
}

function findCommands(name: string): Array<{ command: string; args?: unknown }> {
  return invokeHistory.filter((h) => h.command === name);
}

/** Answer for the next confirm dialog. 'Ok' confirms, anything else declines. */
let confirmAnswer = 'Ok';

function setupDefaultMocks(opts: {
  diff?: DiffFile;
  fileContent?: string;
  diffToolConfig?: { tool: string | null };
  readFails?: { code?: string; message: string };
} = {}): void {
  const diff = opts.diff ?? makeDiffFile();
  mockInvoke = async (command: string) => {
    switch (command) {
      case 'get_file_diff':
        return diff;
      case 'get_commit_file_diff':
        return diff;
      case 'read_file_content':
        if (opts.readFails) throw opts.readFails;
        return opts.fileContent ?? 'file content here';
      case 'write_file_content':
        return undefined;
      case 'get_diff_tool':
        return opts.diffToolConfig ?? { tool: null };
      // showConfirm() resolves to (this result === okLabel); default ok is 'Ok'.
      case 'plugin:dialog|message':
        return confirmAnswer;
      default:
        return null;
    }
  };
}

async function renderDiffView(props: {
  file?: StatusEntry | null;
  commitFile?: { commitOid: string; filePath: string } | null;
  hasPartialStaging?: boolean;
} = {}): Promise<LvDiffView> {
  const file = props.file !== undefined ? props.file : makeStatusEntry();
  const commitFile = props.commitFile ?? null;
  const hasPartialStaging = props.hasPartialStaging ?? false;

  const el = await fixture<LvDiffView>(
    html`<lv-diff-view
      .repositoryPath=${REPO_PATH}
      .file=${file}
      .commitFile=${commitFile}
      .hasPartialStaging=${hasPartialStaging}
    ></lv-diff-view>`
  );

  // Wait for initial loadWorkingDiff / loadCommitDiff to complete
  // Shiki highlighter init can take longer than 100ms in test environment
  await el.updateComplete;
  const maxWait = 3000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, 50));
    await el.updateComplete;
    // Check if diff has loaded (loading is false and either diff is set or error is set)
    if (!(el as unknown as { loading: boolean }).loading) break;
  }
  await el.updateComplete;
  return el;
}

function findWordWrapButton(el: LvDiffView): HTMLElement | null {
  const viewBtns = el.shadowRoot!.querySelectorAll('.view-btn');
  return (
    (Array.from(viewBtns).find((btn) => btn.getAttribute('title') === 'Toggle word wrap') as
      | HTMLElement
      | undefined) ?? null
  );
}

function clickWordWrapButton(el: LvDiffView): void {
  const btn = findWordWrapButton(el);
  expect(btn, 'the word wrap toolbar button exists').to.not.be.null;
  btn!.click();
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('lv-diff-view', () => {
  beforeEach(() => {
    clearHistory();
    setupDefaultMocks();
    confirmAnswer = 'Ok';
    // Word wrap is a shared setting now — start every test from a known off.
    settingsStore.getState().setWordWrap(false);
    localStorage.removeItem('gitnado-diff-word-wrap');
  });

  describe('async diff context pinning', () => {
    it('ignores a working diff response for a file that is no longer selected', async () => {
      const el = document.createElement('lv-diff-view') as LvDiffView;
      const first = deferred<DiffFile>();
      const second = deferred<DiffFile>();

      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_file_diff') {
          const filePath = (args as { filePath: string }).filePath;
          return filePath === 'src/first.ts' ? first.promise : second.promise;
        }
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      el.repositoryPath = REPO_PATH;
      (el as unknown as { initCodeLanguage: () => Promise<void> }).initCodeLanguage =
        async () => {};
      el.file = makeStatusEntry({ path: 'src/first.ts' });
      const firstLoad = (
        el as unknown as { loadWorkingDiff: () => Promise<void> }
      ).loadWorkingDiff();
      el.file = makeStatusEntry({ path: 'src/second.ts' });
      const secondLoad = (
        el as unknown as { loadWorkingDiff: () => Promise<void> }
      ).loadWorkingDiff();

      second.resolve(makeDiffFile({ path: 'src/second.ts' }));
      first.resolve(makeDiffFile({ path: 'src/first.ts' }));
      await Promise.all([firstLoad, secondLoad]);
      expect(
        (el as unknown as { diff: DiffFile }).diff.path,
        'the older response replaced the selected file diff',
      ).to.equal('src/second.ts');
    });

    it('ignores a commit diff response for a commit file that is no longer selected', async () => {
      const el = document.createElement('lv-diff-view') as LvDiffView;
      const first = deferred<DiffFile>();
      const second = deferred<DiffFile>();

      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_commit_file_diff') {
          const filePath = (args as { filePath: string }).filePath;
          return filePath === 'src/first.ts' ? first.promise : second.promise;
        }
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      el.repositoryPath = REPO_PATH;
      (el as unknown as { initCodeLanguage: () => Promise<void> }).initCodeLanguage =
        async () => {};
      el.commitFile = { commitOid: 'first', filePath: 'src/first.ts' };
      const firstLoad = (
        el as unknown as { loadCommitDiff: () => Promise<void> }
      ).loadCommitDiff();
      el.commitFile = { commitOid: 'second', filePath: 'src/second.ts' };
      const secondLoad = (
        el as unknown as { loadCommitDiff: () => Promise<void> }
      ).loadCommitDiff();

      second.resolve(makeDiffFile({ path: 'src/second.ts' }));
      first.resolve(makeDiffFile({ path: 'src/first.ts' }));
      await Promise.all([firstLoad, secondLoad]);

      expect(
        (el as unknown as { diff: DiffFile }).diff.path,
        'the older commit response replaced the selected commit file diff',
      ).to.equal('src/second.ts');
    });

    it('does not stage a displayed hunk after the selection changes', async () => {
      const el = await renderDiffView();
      const oldDiff = (el as unknown as { diff: DiffFile }).diff;

      mockInvoke = async (command: string) => {
        if (command === 'get_file_diff') return makeDiffFile({ path: 'src/next.ts' });
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      el.file = makeStatusEntry({ path: 'src/next.ts' });
      clearHistory();

      await (
        el as unknown as {
          handleStageHunk: (hunk: DiffHunk, event: Event) => Promise<void>;
        }
      ).handleStageHunk(oldDiff.hunks[0], new Event('click'));

      expect(
        findCommands('stage_hunk').length,
        'a hunk from the previous file was staged against the new selection',
      ).to.equal(0);
      await flushAsyncUpdates(el);
    });

    it('clears positional line selections before the replacement diff can use them', async () => {
      const el = await renderDiffView();
      (el as unknown as { selectedLines: Set<string> }).selectedLines = new Set(['0-1']);

      mockInvoke = async (command: string) => {
        if (command === 'get_file_diff') return makeDiffFile({ path: 'src/next.ts' });
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      el.file = makeStatusEntry({ path: 'src/next.ts' });
      await flushAsyncUpdates(el);

      clearHistory();
      await (
        el as unknown as { stageSelectedLines: () => Promise<boolean> }
      ).stageSelectedLines();

      expect(
        findCommands('stage_hunk').length,
        'line indexes selected in the previous file were applied to the new diff',
      ).to.equal(0);
    });

    it('does not let an older file read replace a newer edit buffer', async () => {
      const el = document.createElement('lv-diff-view') as LvDiffView;
      const first = deferred<string>();
      const second = deferred<string>();
      let reads = 0;

      mockInvoke = async (command: string) => {
        if (command === 'read_file_content') {
          reads++;
          return reads === 1 ? first.promise : second.promise;
        }
        return null;
      };

      el.repositoryPath = REPO_PATH;
      el.file = makeStatusEntry({ path: 'src/main.ts' });
      const view = el as unknown as {
        loadFileContent: () => Promise<void>;
        editContent: string;
      };
      const firstLoad = view.loadFileContent();
      const secondLoad = view.loadFileContent();

      second.resolve('newer content');
      await secondLoad;
      view.editContent = 'typed after newer load';
      first.resolve('older content');
      await firstLoad;

      expect(view.editContent).to.equal('typed after newer load');
    });

    it('keeps an edit load valid across a same-file status refresh', async () => {
      const el = await renderDiffView();
      const read = deferred<string>();
      mockInvoke = async (command: string) => {
        if (command === 'read_file_content') return read.promise;
        if (command === 'get_file_diff') return makeDiffFile();
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      const view = el as unknown as {
        loadFileContent: () => Promise<void>;
        editMode: boolean;
        editContent: string;
      };
      const load = view.loadFileContent();
      el.file = makeStatusEntry({ path: 'src/main.ts', status: 'modified' });
      await flushAsyncUpdates(el);
      read.resolve('loaded content');
      await load;

      expect(view.editMode).to.be.true;
      expect(view.editContent).to.equal('loaded content');
    });

    it('invalidates an edit load when the same file becomes conflicted', async () => {
      const el = await renderDiffView();
      const read = deferred<string>();
      mockInvoke = async (command: string) => {
        if (command === 'read_file_content') return read.promise;
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      const view = el as unknown as {
        loadFileContent: () => Promise<void>;
        editMode: boolean;
      };
      const load = view.loadFileContent();
      el.file = makeStatusEntry({ path: 'src/main.ts', isConflicted: true });
      await flushAsyncUpdates(el);
      read.resolve('stale content');
      await load;

      expect(view.editMode).to.be.false;
    });

    it('does not restore an old selection when context-menu staging fails after a file switch', async () => {
      const el = await renderDiffView();
      const view = el as unknown as {
        diff: DiffFile;
        selectedLines: Set<string>;
        contextMenu: {
          visible: boolean;
          x: number;
          y: number;
          line: DiffLine | null;
          hunk: DiffHunk | null;
        };
        handleContextStageLine: () => Promise<void>;
      };
      const oldHunk = view.diff.hunks[0];
      const stage = deferred<unknown>();
      view.selectedLines = new Set(['0-2']);
      view.contextMenu = {
        visible: true,
        x: 0,
        y: 0,
        line: oldHunk.lines[1],
        hunk: oldHunk,
      };

      mockInvoke = async (command: string) => {
        if (command === 'stage_hunk') return stage.promise;
        if (command === 'get_file_diff') return makeDiffFile({ path: 'src/next.ts' });
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      const operation = view.handleContextStageLine();
      el.file = makeStatusEntry({ path: 'src/next.ts' });
      await flushAsyncUpdates(el);
      view.selectedLines = new Set(['0-1']);
      stage.reject({ code: 'COMMAND_ERROR', message: 'patch does not apply' });
      await operation;

      expect([...view.selectedLines]).to.deep.equal(['0-1']);
    });

    it('does not let an older save completion discard a newer edit buffer', async () => {
      const el = document.createElement('lv-diff-view') as LvDiffView;
      const write = deferred<unknown>();
      mockInvoke = async (command: string) => {
        if (command === 'write_file_content') return write.promise;
        return null;
      };

      el.repositoryPath = REPO_PATH;
      el.file = makeStatusEntry({ path: 'src/a.ts' });
      const view = el as unknown as {
        editMode: boolean;
        editPath: string | null;
        editRepositoryPath: string | null;
        editRequestId: number;
        editContent: string;
        originalContent: string;
        saveEdit: () => Promise<void>;
      };
      view.editMode = true;
      view.editPath = 'src/a.ts';
      view.editRepositoryPath = REPO_PATH;
      view.editContent = 'save A';
      view.originalContent = 'old A';
      let editedEvents = 0;
      el.addEventListener('file-edited', () => editedEvents++);

      const save = view.saveEdit();
      view.editRequestId++;
      el.file = makeStatusEntry({ path: 'src/b.ts' });
      view.editPath = 'src/b.ts';
      view.editRepositoryPath = REPO_PATH;
      view.editContent = 'unsaved B';
      view.originalContent = 'old B';
      write.resolve(undefined);
      await save;

      expect(view.editMode).to.be.true;
      expect(view.editContent).to.equal('unsaved B');
      expect(view.editPath).to.equal('src/b.ts');
      expect(editedEvents, 'a successful write must still refresh repository status').to.equal(1);
    });

    it('does not restore old line indexes after a same-file diff reload', async () => {
      const el = await renderDiffView();
      const view = el as unknown as {
        diff: DiffFile;
        selectedLines: Set<string>;
        contextMenu: {
          visible: boolean;
          x: number;
          y: number;
          line: DiffLine | null;
          hunk: DiffHunk | null;
        };
        handleContextStageLine: () => Promise<void>;
        loadWorkingDiff: () => Promise<void>;
      };
      const oldHunk = view.diff.hunks[0];
      const stage = deferred<unknown>();
      view.selectedLines = new Set(['0-2']);
      view.contextMenu = {
        visible: true,
        x: 0,
        y: 0,
        line: oldHunk.lines[1],
        hunk: oldHunk,
      };

      mockInvoke = async (command: string) => {
        if (command === 'stage_hunk') return stage.promise;
        if (command === 'get_file_diff') return makeDiffFile();
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      const operation = view.handleContextStageLine();
      await view.loadWorkingDiff();
      view.selectedLines = new Set(['0-1']);
      stage.reject({ code: 'COMMAND_ERROR', message: 'patch does not apply' });
      await operation;

      expect([...view.selectedLines]).to.deep.equal(['0-1']);
    });

    it('clears positional selections when staging a whole hunk reloads the diff', async () => {
      const el = await renderDiffView();
      const view = el as unknown as {
        diff: DiffFile;
        selectedLines: Set<string>;
        handleStageHunk: (hunk: DiffHunk, event: Event) => Promise<void>;
      };
      view.selectedLines = new Set(['0-1']);
      mockInvoke = async (command: string) => {
        if (command === 'stage_hunk') return null;
        if (command === 'get_file_diff') return makeDiffFile();
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      await view.handleStageHunk(view.diff.hunks[0], new Event('click'));

      expect(view.selectedLines.size).to.equal(0);
    });

    it('clears positional selections when a same-file reload starts mid-apply', async () => {
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: false }) });
      const view = el as unknown as {
        selectedLines: Set<string>;
        stageSelectedLines: () => Promise<boolean>;
        handleLoadFullDiff: () => Promise<void>;
      };
      const stage = deferred<unknown>();
      const reload = deferred<DiffFile>();
      view.selectedLines = new Set(['0-2']);

      mockInvoke = async (command: string) => {
        if (command === 'stage_hunk') return stage.promise;
        if (command === 'get_file_diff') return reload.promise;
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      const apply = view.stageSelectedLines();
      // "Load full diff" is not disabled while a mutation is in flight, so it
      // can start a reload of the SAME file mid-apply. That leaves no loaded
      // context, but the pane still shows the file the stage was applied to.
      const full = view.handleLoadFullDiff();
      stage.resolve(undefined);
      // The apply now re-fetches once it lands, so the reload has to be able to
      // answer that request too.
      reload.resolve(makeDiffFile());
      expect(await apply, 'the stage was applied').to.be.true;
      await full;
      await flushAsyncUpdates(el);

      expect(
        view.selectedLines.size,
        'line indexes invalidated by the apply survived into the renumbered diff',
      ).to.equal(0);
    });

    it('clears positional selections when a same-file reload starts mid hunk stage', async () => {
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: false }) });
      const view = el as unknown as {
        diff: DiffFile;
        selectedLines: Set<string>;
        handleStageHunk: (hunk: DiffHunk, event: Event) => Promise<void>;
        handleLoadFullDiff: () => Promise<void>;
      };
      const stage = deferred<unknown>();
      const reload = deferred<DiffFile>();
      view.selectedLines = new Set(['0-2']);

      mockInvoke = async (command: string) => {
        if (command === 'stage_hunk') return stage.promise;
        if (command === 'get_file_diff') return reload.promise;
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      const apply = view.handleStageHunk(view.diff.hunks[0], new Event('click'));
      const full = view.handleLoadFullDiff();
      stage.resolve(undefined);
      reload.resolve(makeDiffFile());
      await apply;
      await full;
      await flushAsyncUpdates(el);

      expect(
        view.selectedLines.size,
        'line indexes invalidated by the hunk stage survived into the renumbered diff',
      ).to.equal(0);
    });

    it('re-fetches after a hunk stage that raced a same-file reload', async () => {
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: false }) });
      const view = el as unknown as {
        diff: DiffFile | null;
        handleStageHunk: (hunk: DiffHunk, event: Event) => Promise<void>;
        handleLoadFullDiff: () => Promise<void>;
      };
      const stage = deferred<unknown>();
      const staleReload = deferred<DiffFile>();
      const staleRequested = deferred<void>();
      const preApply = makeDiffFile({ hunks: [makeDiffHunk({ header: '@@ pre-apply @@' })] });
      const postApply = makeDiffFile({ hunks: [makeDiffHunk({ header: '@@ post-apply @@' })] });
      let diffCalls = 0;

      mockInvoke = async (command: string) => {
        if (command === 'stage_hunk') return stage.promise;
        if (command === 'get_file_diff') {
          diffCalls++;
          // The first reload asked for the diff before the stage landed, so it
          // can only answer with the pre-apply content.
          if (diffCalls === 1) {
            staleRequested.resolve(undefined);
            return staleReload.promise;
          }
          return postApply;
        }
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      const hunk = view.diff!.hunks[0];
      const apply = view.handleStageHunk(hunk, new Event('click'));
      const full = view.handleLoadFullDiff();
      await staleRequested.promise;
      stage.resolve(undefined);
      await apply;
      staleReload.resolve(preApply);
      await full;
      await settleAsyncUpdates(el);

      expect(
        view.diff?.hunks[0]?.header,
        'the pre-apply diff a racing reload had already asked for was left in the pane',
      ).to.equal('@@ post-apply @@');
    });

    it('clears the pane when a stage that raced a same-file reload emptied the file', async () => {
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: false }) });
      const view = el as unknown as {
        diff: DiffFile | null;
        handleStageHunk: (hunk: DiffHunk, event: Event) => Promise<void>;
        handleLoadFullDiff: () => Promise<void>;
      };
      const stage = deferred<unknown>();
      const staleReload = deferred<DiffFile>();
      const staleRequested = deferred<void>();
      let cleared = 0;
      el.addEventListener('file-cleared', () => cleared++);
      let diffCalls = 0;

      mockInvoke = async (command: string) => {
        if (command === 'stage_hunk') return stage.promise;
        if (command === 'get_file_diff') {
          diffCalls++;
          if (diffCalls === 1) {
            staleRequested.resolve(undefined);
            return staleReload.promise;
          }
          // The stage took the file's last unstaged hunk, so there is no
          // unstaged diff left for the backend to answer with.
          throw {
            code: 'COMMAND_ERROR',
            message: "File 'src/main.ts' not found in diff. Staged: false. Found 0 files: []",
          };
        }
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      const hunk = view.diff!.hunks[0];
      const apply = view.handleStageHunk(hunk, new Event('click'));
      const full = view.handleLoadFullDiff();
      await staleRequested.promise;
      stage.resolve(undefined);
      await apply;
      staleReload.resolve(makeDiffFile());
      await full;
      await settleAsyncUpdates(el);

      expect(cleared, 'a fully applied file left the pane bound after a racing reload').to.equal(1);
      expect(el.file, 'the fully applied file stayed bound to the pane').to.be.null;
      expect(view.diff, 'the emptied diff stayed painted in the pane').to.be.null;
      expect(
        el.shadowRoot!.textContent,
        'the backend\'s "not found in diff" text was painted into the pane',
      ).to.not.contain('not found in diff');
    });

    it('keeps a selection made in another file after an apply to the previous one', async () => {
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: false }) });
      const view = el as unknown as {
        selectedLines: Set<string>;
        stageSelectedLines: () => Promise<boolean>;
      };
      const stage = deferred<unknown>();
      view.selectedLines = new Set(['0-2']);

      mockInvoke = async (command: string) => {
        if (command === 'stage_hunk') return stage.promise;
        if (command === 'get_file_diff') return makeDiffFile({ path: 'src/next.ts' });
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      const apply = view.stageSelectedLines();
      el.file = makeStatusEntry({ path: 'src/next.ts' });
      await flushAsyncUpdates(el);
      view.selectedLines = new Set(['0-1']);
      stage.resolve(undefined);
      await apply;
      await flushAsyncUpdates(el);

      expect(
        [...view.selectedLines],
        'an apply to the previous file cleared a selection made in the new one',
      ).to.deep.equal(['0-1']);
    });

    it('serializes overlapping hunk staging operations', async () => {
      const el = await renderDiffView();
      const stage = deferred<unknown>();
      const view = el as unknown as {
        diff: DiffFile;
        handleStageHunk: (hunk: DiffHunk, event: Event) => Promise<void>;
      };
      mockInvoke = async (command: string) => {
        if (command === 'stage_hunk') return stage.promise;
        if (command === 'get_file_diff') return makeDiffFile();
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      clearHistory();
      const first = view.handleStageHunk(view.diff.hunks[0], new Event('click'));
      const second = view.handleStageHunk(view.diff.hunks[0], new Event('click'));
      expect(findCommands('stage_hunk').length).to.equal(1);

      stage.resolve(undefined);
      await Promise.all([first, second]);
    });

    it('disables the hunk Stage button while its stage is in flight', async () => {
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: false }) });
      const stage = deferred<unknown>();
      mockInvoke = async (command: string) => {
        if (command === 'stage_hunk') return stage.promise;
        if (command === 'get_file_diff') return makeDiffFile();
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      clearHistory();
      const stageBtn = el.shadowRoot!.querySelector('.stage-btn.stage') as HTMLButtonElement;
      expect(stageBtn, 'the hunk Stage button renders').to.not.be.null;
      expect(stageBtn.disabled, 'enabled before any mutation').to.be.false;

      stageBtn.click();
      await el.updateComplete;

      expect(
        (el.shadowRoot!.querySelector('.stage-btn.stage') as HTMLButtonElement).disabled,
        'the in-flight stage is visible on the button instead of being silently swallowed'
      ).to.be.true;

      // A second click on the now-disabled button cannot reach the handler.
      (el.shadowRoot!.querySelector('.stage-btn.stage') as HTMLButtonElement).click();
      expect(findCommands('stage_hunk').length).to.equal(1);

      stage.resolve(undefined);
      await flushAsyncUpdates(el);
      await el.updateComplete;

      expect(
        (el.shadowRoot!.querySelector('.stage-btn.stage') as HTMLButtonElement).disabled,
        're-enabled once the stage completes'
      ).to.be.false;
    });

    it('re-enables the hunk Unstage button after its unstage fails', async () => {
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: true }) });
      const unstage = deferred<unknown>();
      mockInvoke = async (command: string) => {
        if (command === 'unstage_hunk') return unstage.promise;
        if (command === 'get_file_diff') return makeDiffFile();
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      const unstageBtn = el.shadowRoot!.querySelector('.stage-btn.unstage') as HTMLButtonElement;
      expect(unstageBtn, 'the hunk Unstage button renders').to.not.be.null;
      unstageBtn.click();
      await el.updateComplete;

      expect(
        (el.shadowRoot!.querySelector('.stage-btn.unstage') as HTMLButtonElement).disabled,
        'disabled while the unstage is in flight'
      ).to.be.true;

      unstage.reject(new Error('patch does not apply'));
      await flushAsyncUpdates(el);
      await el.updateComplete;

      expect(
        (el.shadowRoot!.querySelector('.stage-btn.unstage') as HTMLButtonElement).disabled,
        'a failed unstage leaves the button usable again'
      ).to.be.false;
    });

    it('disables Stage Selected while the bulk stage is in flight', async () => {
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: false }) });
      const selectionBtn = (): HTMLButtonElement =>
        el.shadowRoot!.querySelector('.selection-actions .selection-btn.primary') as HTMLButtonElement;

      const toggle = Array.from(el.shadowRoot!.querySelectorAll('.view-btn')).find(
        (b) => b.getAttribute('title') === 'Toggle line selection mode for staging individual lines'
      ) as HTMLElement;
      expect(toggle, 'the line-selection toggle renders').to.not.be.undefined;
      toggle.click();
      await el.updateComplete;

      (el.shadowRoot!.querySelector('.line.code-addition') as HTMLElement).click();
      await el.updateComplete;
      expect(selectionBtn(), 'the bulk selection bar renders').to.not.be.null;
      expect(selectionBtn().disabled, 'enabled before any mutation').to.be.false;

      const stage = deferred<unknown>();
      mockInvoke = async (command: string) => {
        if (command === 'stage_hunk') return stage.promise;
        if (command === 'get_file_diff') return makeDiffFile();
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      clearHistory();
      selectionBtn().click();
      await el.updateComplete;

      expect(
        selectionBtn().disabled,
        'the in-flight bulk stage is visible on the button'
      ).to.be.true;

      selectionBtn().click();
      expect(findCommands('stage_hunk').length).to.equal(1);

      stage.resolve(undefined);
      await flushAsyncUpdates(el);
      await el.updateComplete;
    });

    it('disables the context-menu stage items while a stage is in flight', async () => {
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: false }) });
      const stage = deferred<unknown>();
      mockInvoke = async (command: string) => {
        if (command === 'stage_hunk') return stage.promise;
        if (command === 'get_file_diff') return makeDiffFile();
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      clearHistory();
      (el.shadowRoot!.querySelector('.stage-btn.stage') as HTMLButtonElement).click();
      await el.updateComplete;

      // A contextmenu event never reaches the document click handler, so the
      // menu still opens while the stage is in flight.
      (el.shadowRoot!.querySelector('.line.code-addition') as HTMLElement).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      );
      await el.updateComplete;

      const menuItem = (label: string): HTMLButtonElement => {
        const item = Array.from(el.shadowRoot!.querySelectorAll('.context-menu-item')).find(
          (b) => (b.textContent ?? '').includes(label)
        ) as HTMLButtonElement | undefined;
        expect(item, `the "${label}" context-menu item renders`).to.not.be.undefined;
        return item!;
      };

      expect(
        menuItem('Stage hunk').disabled,
        'the in-flight stage is visible on the context menu instead of the click being dropped'
      ).to.be.true;
      expect(
        menuItem('Stage line').disabled,
        'the in-flight stage is visible on the context menu instead of the click being dropped'
      ).to.be.true;
      expect(menuItem('Copy line').disabled, 'copy stays usable during a stage').to.be.false;

      stage.resolve(undefined);
      await flushAsyncUpdates(el);
      await el.updateComplete;

      expect(menuItem('Stage hunk').disabled, 're-enabled once the stage completes').to.be.false;
      expect(menuItem('Stage line').disabled, 're-enabled once the stage completes').to.be.false;
    });

    it('disables the context-menu unstage items while an unstage is in flight', async () => {
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: true }) });
      const unstage = deferred<unknown>();
      mockInvoke = async (command: string) => {
        if (command === 'unstage_hunk') return unstage.promise;
        if (command === 'get_file_diff') return makeDiffFile();
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      clearHistory();
      (el.shadowRoot!.querySelector('.stage-btn.unstage') as HTMLButtonElement).click();
      await el.updateComplete;

      (el.shadowRoot!.querySelector('.line.code-addition') as HTMLElement).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      );
      await el.updateComplete;

      const menuItem = (label: string): HTMLButtonElement => {
        const item = Array.from(el.shadowRoot!.querySelectorAll('.context-menu-item')).find(
          (b) => (b.textContent ?? '').includes(label)
        ) as HTMLButtonElement | undefined;
        expect(item, `the "${label}" context-menu item renders`).to.not.be.undefined;
        return item!;
      };

      expect(
        menuItem('Unstage hunk').disabled,
        'the in-flight unstage is visible on the context menu'
      ).to.be.true;
      expect(
        menuItem('Unstage line').disabled,
        'the in-flight unstage is visible on the context menu'
      ).to.be.true;

      unstage.reject(new Error('patch does not apply'));
      await flushAsyncUpdates(el);
      await el.updateComplete;

      expect(
        menuItem('Unstage hunk').disabled,
        'a failed unstage leaves the context-menu item usable again'
      ).to.be.false;
    });

    it('does not clear a newly selected file when a superseded reload reports "not found in diff"', async () => {
      const el = await renderDiffView({
        file: makeStatusEntry({ path: 'src/main.ts', isStaged: false }),
      });
      const view = el as unknown as {
        diff: DiffFile;
        error: string | null;
        initCodeLanguage: (path: string) => Promise<void>;
        handleStageHunk: (hunk: DiffHunk, event: Event) => Promise<void>;
      };
      view.initCodeLanguage = async () => {};
      const hunk = view.diff.hunks[0];

      const reloadOfStagedFile = deferred<DiffFile>();
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'stage_hunk') return null;
        if (command === 'get_file_diff') {
          const filePath = (args as { filePath: string }).filePath;
          if (filePath === 'src/main.ts') return reloadOfStagedFile.promise;
          // The file the user switches to has nothing left to show on its own.
          throw {
            code: 'COMMAND_ERROR',
            message: "File 'src/next.ts' not found in diff. Staged: false.",
          };
        }
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      let cleared = 0;
      el.addEventListener('file-cleared', () => cleared++);

      const operation = view.handleStageHunk(hunk, new Event('click'));
      // Let stage_hunk settle so the reload of src/main.ts is in flight.
      await flushAsyncUpdates(el);

      el.file = makeStatusEntry({ path: 'src/next.ts', isStaged: false });
      await flushAsyncUpdates(el);
      expect(view.error, 'the newly selected file reported its own load error').to.contain(
        'not found in diff'
      );

      reloadOfStagedFile.resolve(makeDiffFile({ path: 'src/main.ts' }));
      await operation;
      await el.updateComplete;

      expect(
        el.file?.path,
        'the superseded reload cleared the file the user had switched to'
      ).to.equal('src/next.ts');
      expect(cleared, 'file-cleared was dispatched for a file that was never staged').to.equal(0);
    });

    it('clears the pane when unstaging the last staged hunk empties the staged diff', async () => {
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: true }) });
      (el as unknown as { initCodeLanguage: (path: string) => Promise<void> }).initCodeLanguage =
        async () => {};

      let unstaged = false;
      mockInvoke = async (command: string) => {
        if (command === 'unstage_hunk') {
          unstaged = true;
          return null;
        }
        if (command === 'get_file_diff') {
          // Nothing is staged for this file any more, so the backend has no
          // staged diff to return.
          if (unstaged) {
            throw {
              code: 'COMMAND_ERROR',
              message:
                "File 'src/main.ts' not found in diff. Staged: true. Found 1 files: [src/other.ts]",
            };
          }
          return makeDiffFile();
        }
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      let cleared = 0;
      el.addEventListener('file-cleared', () => cleared++);

      (el.shadowRoot!.querySelector('.stage-btn.unstage') as HTMLButtonElement).click();
      await settleAsyncUpdates(el);

      expect(
        el.shadowRoot!.textContent,
        'the backend\'s "not found in diff" text was painted into the pane',
      ).to.not.contain('not found in diff');
      expect(el.file, 'the emptied file stayed bound to the pane').to.be.null;
      expect(
        el.shadowRoot!.querySelector('.empty')?.textContent,
        'the pane should fall back to its empty state',
      ).to.contain('No file selected');
      expect(cleared, 'file-cleared closes the diff in app-shell').to.equal(1);
    });

    it('keeps the diff open when unstaging leaves other staged hunks', async () => {
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: true }) });
      (el as unknown as { initCodeLanguage: (path: string) => Promise<void> }).initCodeLanguage =
        async () => {};

      mockInvoke = async (command: string) => {
        if (command === 'unstage_hunk') return null;
        if (command === 'get_file_diff') return makeDiffFile();
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      let cleared = 0;
      el.addEventListener('file-cleared', () => cleared++);

      (el.shadowRoot!.querySelector('.stage-btn.unstage') as HTMLButtonElement).click();
      await settleAsyncUpdates(el);

      expect(el.file?.path, 'a partial unstage must keep the file selected').to.equal('src/main.ts');
      expect(cleared, 'file-cleared was dispatched while hunks were still staged').to.equal(0);
      expect(el.shadowRoot!.querySelectorAll('.line.code-addition').length).to.be.greaterThan(0);
    });

    it('does not clear a newly selected file when a superseded unstage reload reports "not found in diff"', async () => {
      const el = await renderDiffView({
        file: makeStatusEntry({ path: 'src/main.ts', isStaged: true }),
      });
      const view = el as unknown as {
        diff: DiffFile;
        error: string | null;
        initCodeLanguage: (path: string) => Promise<void>;
        handleUnstageHunk: (hunk: DiffHunk, event: Event) => Promise<void>;
      };
      view.initCodeLanguage = async () => {};
      const hunk = view.diff.hunks[0];

      const reloadOfUnstagedFile = deferred<DiffFile>();
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'unstage_hunk') return null;
        if (command === 'get_file_diff') {
          const filePath = (args as { filePath: string }).filePath;
          if (filePath === 'src/main.ts') return reloadOfUnstagedFile.promise;
          // The file the user switches to has nothing left to show on its own.
          throw {
            code: 'COMMAND_ERROR',
            message: "File 'src/next.ts' not found in diff. Staged: true.",
          };
        }
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      let cleared = 0;
      el.addEventListener('file-cleared', () => cleared++);

      const operation = view.handleUnstageHunk(hunk, new Event('click'));
      // Let unstage_hunk settle so the reload of src/main.ts is in flight.
      await flushAsyncUpdates(el);

      el.file = makeStatusEntry({ path: 'src/next.ts', isStaged: true });
      await flushAsyncUpdates(el);
      expect(view.error, 'the newly selected file reported its own load error').to.contain(
        'not found in diff'
      );

      reloadOfUnstagedFile.resolve(makeDiffFile({ path: 'src/main.ts' }));
      await operation;
      await el.updateComplete;

      expect(
        el.file?.path,
        'the superseded reload cleared the file the user had switched to'
      ).to.equal('src/next.ts');
      expect(cleared, 'file-cleared was dispatched for a file that was never unstaged').to.equal(0);
    });

    it('disables every editor exit and input while saving', async () => {
      const el = await renderDiffView();
      (el.shadowRoot!.querySelector('.edit-btn') as HTMLElement).click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await el.updateComplete;

      (el as unknown as { saving: boolean }).saving = true;
      el.requestUpdate();
      await el.updateComplete;

      expect((el.shadowRoot!.querySelector('.edit-btn.active') as HTMLButtonElement).disabled).to.be.true;
      expect((el.shadowRoot!.querySelector('.cancel-btn') as HTMLButtonElement).disabled).to.be.true;
      expect((el.shadowRoot!.querySelector('.editor-textarea') as HTMLTextAreaElement).disabled).to.be.true;
    });
  });

  // ── Rendering ──────────────────────────────────────────────────────────
  describe('rendering', () => {
    it('renders diff content with additions highlighted', async () => {
      const el = await renderDiffView();

      const additionLines = el.shadowRoot!.querySelectorAll('.line.code-addition');
      expect(additionLines.length).to.be.greaterThan(0);

      // Check that the + origin char is present
      const originSpan = additionLines[0].querySelector('.line-origin');
      expect(originSpan).to.not.be.null;
      expect(originSpan!.textContent).to.equal('+');
    });

    it('renders diff content with deletions highlighted', async () => {
      const el = await renderDiffView();

      const deletionLines = el.shadowRoot!.querySelectorAll('.line.code-deletion');
      expect(deletionLines.length).to.be.greaterThan(0);

      // Check that the - origin char is present
      const originSpan = deletionLines[0].querySelector('.line-origin');
      expect(originSpan).to.not.be.null;
      expect(originSpan!.textContent).to.equal('-');
    });

    it('renders context lines without addition/deletion classes', async () => {
      const el = await renderDiffView();

      const contextLines = el.shadowRoot!.querySelectorAll('.line.context');
      expect(contextLines.length).to.be.greaterThan(0);

      // Origin char should be a space for context lines
      const originSpan = contextLines[0].querySelector('.line-origin');
      expect(originSpan).to.not.be.null;
      expect(originSpan!.textContent).to.equal(' ');
    });

    it('shows file additions and deletions stats in the header', async () => {
      const diff = makeDiffFile({ additions: 10, deletions: 5 });
      setupDefaultMocks({ diff });
      const el = await renderDiffView();

      const additions = el.shadowRoot!.querySelector('.additions');
      expect(additions).to.not.be.null;
      expect(additions!.textContent).to.include('+10');

      const deletions = el.shadowRoot!.querySelector('.deletions');
      expect(deletions).to.not.be.null;
      expect(deletions!.textContent).to.include('-5');
    });

    it('renders line numbers for old and new lines', async () => {
      const el = await renderDiffView();

      const lineNumbers = el.shadowRoot!.querySelectorAll('.line-no');
      expect(lineNumbers.length).to.be.greaterThan(0);
    });
  });

  // ── Empty state ──────────────────────────────────────────────────────────
  describe('empty state', () => {
    it('shows "No file selected" when no file or commitFile is set', async () => {
      const el = await renderDiffView({ file: null });

      const empty = el.shadowRoot!.querySelector('.empty');
      expect(empty).to.not.be.null;
      expect(empty!.textContent).to.include('No file selected');
    });

    it('shows "No changes to display" when diff is null after loading', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_file_diff':
            // Simulate a successful result but with no data to keep diff null
            // The invokeCommand wrapper returns { success: true, data } from invoke result
            // Since diff gets set to result.data when success is true, returning null
            // will mean diff = null (the raw invoke returns the value which becomes data)
            return null;
          case 'get_diff_tool':
            return { tool: null };
          default:
            return null;
        }
      };

      const el = await renderDiffView();

      const empty = el.shadowRoot!.querySelector('.empty');
      expect(empty).to.not.be.null;
    });

    it('shows "No changes in this file" when diff has zero hunks', async () => {
      const diff = makeDiffFile({ hunks: [] });
      setupDefaultMocks({ diff });
      const el = await renderDiffView();

      const empty = el.shadowRoot!.querySelector('.empty');
      expect(empty).to.not.be.null;
      expect(empty!.textContent).to.include('No changes in this file');
    });
  });

  // ── View mode toggle ──────────────────────────────────────────────────
  describe('view mode', () => {
    it('defaults to unified view mode', async () => {
      const el = await renderDiffView();

      // Unified view should be present
      const diffContent = el.shadowRoot!.querySelector('.diff-content');
      expect(diffContent).to.not.be.null;

      // Unified button should be active
      const viewBtns = el.shadowRoot!.querySelectorAll('.view-btn');
      const unifiedBtn = Array.from(viewBtns).find(
        (btn) => btn.getAttribute('title') === 'Unified view'
      );
      expect(unifiedBtn).to.not.be.null;
      expect(unifiedBtn!.classList.contains('active')).to.be.true;
    });

    it('toggles to split view when split button is clicked', async () => {
      const el = await renderDiffView();

      // Click the split view button
      const viewBtns = el.shadowRoot!.querySelectorAll('.view-btn');
      const splitBtn = Array.from(viewBtns).find(
        (btn) => btn.getAttribute('title') === 'Split view'
      );
      expect(splitBtn).to.not.be.null;
      (splitBtn as HTMLElement).click();
      await el.updateComplete;

      // Split container should now be visible
      const splitContainer = el.shadowRoot!.querySelector('.split-container');
      expect(splitContainer).to.not.be.null;

      // Split panes should have "Original" and "Modified" headers
      const paneHeaders = el.shadowRoot!.querySelectorAll('.split-pane-header');
      expect(paneHeaders.length).to.equal(2);
      expect(paneHeaders[0].textContent).to.include('Original');
      expect(paneHeaders[1].textContent).to.include('Modified');
    });

    it('toggles back to unified view from split view', async () => {
      const el = await renderDiffView();

      // Switch to split first
      const viewBtns = el.shadowRoot!.querySelectorAll('.view-btn');
      const splitBtn = Array.from(viewBtns).find(
        (btn) => btn.getAttribute('title') === 'Split view'
      );
      (splitBtn as HTMLElement).click();
      await el.updateComplete;

      // Now switch back to unified
      const updatedBtns = el.shadowRoot!.querySelectorAll('.view-btn');
      const unifiedBtn = Array.from(updatedBtns).find(
        (btn) => btn.getAttribute('title') === 'Unified view'
      );
      (unifiedBtn as HTMLElement).click();
      await el.updateComplete;

      // Unified diff-content should be present
      const diffContent = el.shadowRoot!.querySelector('.diff-content');
      expect(diffContent).to.not.be.null;
    });
  });

  // ── Edit mode ──────────────────────────────────────────────────────────
  describe('edit mode', () => {
    it('shows Edit button for working directory files', async () => {
      const el = await renderDiffView();

      const editBtn = el.shadowRoot!.querySelector('.edit-btn');
      expect(editBtn).to.not.be.null;
      expect(editBtn!.textContent).to.include('Edit');
    });

    it('does not show Edit button for commit diffs', async () => {
      const diff = makeDiffFile();
      setupDefaultMocks({ diff });
      const el = await renderDiffView({
        file: null,
        commitFile: { commitOid: 'abc123', filePath: 'src/main.ts' },
      });

      const editBtn = el.shadowRoot!.querySelector('.edit-btn');
      expect(editBtn).to.be.null;
    });

    it('enters edit mode and shows save/cancel buttons when Edit is clicked', async () => {
      setupDefaultMocks({ fileContent: 'file content here' });
      const el = await renderDiffView();

      // Click Edit button
      const editBtn = el.shadowRoot!.querySelector('.edit-btn') as HTMLElement;
      expect(editBtn).to.not.be.null;
      editBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      // Should now see editor toolbar with Cancel and Save buttons
      const cancelBtn = el.shadowRoot!.querySelector('.cancel-btn');
      expect(cancelBtn).to.not.be.null;
      expect(cancelBtn!.textContent).to.include('Cancel');

      const saveBtn = el.shadowRoot!.querySelector('.save-btn');
      expect(saveBtn).to.not.be.null;
      expect(saveBtn!.textContent).to.include('Save');
    });

    it('says why when the file cannot be opened for editing', async () => {
      // Two reachable failures: the file was deleted or renamed on disk since
      // the last status refresh, or it is not valid UTF-8 despite passing the
      // diff's binary heuristic. Both left the Edit button doing nothing at
      // all — and read_file_content is excluded from the Output panel by its
      // `read_` prefix, so the failure was recorded nowhere.
      setupDefaultMocks({ readFails: { code: 'COMMAND_ERROR', message: 'stream did not contain valid UTF-8' } });
      const el = await renderDiffView();
      uiStore.setState({ toasts: [] });

      (el.shadowRoot!.querySelector('.edit-btn') as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.editor-textarea'), 'edit mode is not entered').to.be
        .null;
      const errors = uiStore.getState().toasts.filter((t) => t.type === 'error');
      expect(errors.length, 'the click is not silent').to.equal(1);
      expect(errors[0].message).to.contain('UTF-8');
    });

    it('a file that vanished from disk is named, not reported as a decode error', async () => {
      setupDefaultMocks({ readFails: { code: 'FILE_NOT_FOUND', message: 'src/main.ts' } });
      const el = await renderDiffView();
      uiStore.setState({ toasts: [] });

      (el.shadowRoot!.querySelector('.edit-btn') as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const errors = uiStore.getState().toasts.filter((t) => t.type === 'error');
      expect(errors.length).to.equal(1);
      expect(errors[0].message).to.contain('no longer on disk');
    });

    it('shows textarea in edit mode', async () => {
      setupDefaultMocks({ fileContent: 'file content here' });
      const el = await renderDiffView();

      const editBtn = el.shadowRoot!.querySelector('.edit-btn') as HTMLElement;
      editBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const textarea = el.shadowRoot!.querySelector('.editor-textarea') as HTMLTextAreaElement;
      expect(textarea).to.not.be.null;
      expect(textarea.value).to.equal('file content here');
    });
  });

  // ── Unsaved changes indicator ──────────────────────────────────────────
  describe('unsaved changes', () => {
    it('shows unsaved indicator when edit content differs from original', async () => {
      setupDefaultMocks({ fileContent: 'original content' });
      const el = await renderDiffView();

      // Enter edit mode
      const editBtn = el.shadowRoot!.querySelector('.edit-btn') as HTMLElement;
      editBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      // Modify content
      const textarea = el.shadowRoot!.querySelector('.editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'modified content';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      const indicator = el.shadowRoot!.querySelector('.edit-indicator');
      expect(indicator).to.not.be.null;
      expect(indicator!.textContent).to.include('Unsaved changes');
    });

    it('does not show unsaved indicator when edit content equals original', async () => {
      setupDefaultMocks({ fileContent: 'original content' });
      const el = await renderDiffView();

      // Enter edit mode
      const editBtn = el.shadowRoot!.querySelector('.edit-btn') as HTMLElement;
      editBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      // Content is unchanged
      const indicator = el.shadowRoot!.querySelector('.edit-indicator');
      expect(indicator).to.be.null;
    });

    it('cancel asks before throwing away typed text', async () => {
      // Every other editing surface in the app (lv-hooks-dialog,
      // lv-merge-editor) confirms this; Escape reaches the same handler, and
      // Escape is bound app-wide to "close diff", so it gets pressed
      // reflexively.
      setupDefaultMocks({ fileContent: 'original content' });
      const el = await renderDiffView();

      const editBtn = el.shadowRoot!.querySelector('.edit-btn') as HTMLElement;
      editBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const textarea = el.shadowRoot!.querySelector('.editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'modified content';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      confirmAnswer = 'Cancel';
      (el.shadowRoot!.querySelector('.cancel-btn') as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      const stillEditing = el.shadowRoot!.querySelector('.editor-textarea') as HTMLTextAreaElement;
      expect(stillEditing, 'declining keeps the editor open').to.not.be.null;
      expect(stillEditing.value).to.equal('modified content');
    });

    it('cancel with no edits does not nag', async () => {
      setupDefaultMocks({ fileContent: 'original content' });
      const el = await renderDiffView();

      const editBtn = el.shadowRoot!.querySelector('.edit-btn') as HTMLElement;
      editBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      invokeHistory.length = 0;
      confirmAnswer = 'Cancel';
      (el.shadowRoot!.querySelector('.cancel-btn') as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(
        invokeHistory.some((c) => c.command === 'plugin:dialog|message'),
        'nothing is at stake, so nothing is asked',
      ).to.equal(false);
      expect(el.shadowRoot!.querySelector('.editor-textarea')).to.be.null;
    });

    it('switching repositories closes the editor even when the file path is unchanged', async () => {
      setupDefaultMocks({ fileContent: 'contents from repository A' });
      const el = await renderDiffView({
        file: makeStatusEntry({ path: 'src/main.ts' }),
      });

      (el.shadowRoot!.querySelector('.edit-btn') as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;
      expect(el.shadowRoot!.querySelector('.editor-textarea')).to.not.be.null;

      el.repositoryPath = '/test/other-repo';
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(
        el.shadowRoot!.querySelector('.editor-textarea'),
        'the buffer from repository A remained writable in repository B',
      ).to.be.null;
    });

    it('cancel restores to diff view and discards edits', async () => {
      setupDefaultMocks({ fileContent: 'original content' });
      const el = await renderDiffView();

      // Enter edit mode
      const editBtn = el.shadowRoot!.querySelector('.edit-btn') as HTMLElement;
      editBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      // Modify content
      const textarea = el.shadowRoot!.querySelector('.editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'modified content';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      // Click Cancel — now confirm-gated, so let the dialog round-trip settle.
      const cancelBtn = el.shadowRoot!.querySelector('.cancel-btn') as HTMLElement;
      cancelBtn.click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      // Should be back in diff view
      const diffContent = el.shadowRoot!.querySelector('.diff-content');
      expect(diffContent).to.not.be.null;

      // Editor should be gone
      const editorTextarea = el.shadowRoot!.querySelector('.editor-textarea');
      expect(editorTextarea).to.be.null;
    });

    it('selecting another file closes the editor instead of retargeting it', async () => {
      // This pane is ONE reused element. With the editor open on A and B then
      // selected, the header named B while the textarea still held A's text —
      // and Save writes editContent to this.file.path, i.e. A's content over B,
      // destroying B's uncommitted changes with no git object to recover from.
      setupDefaultMocks({ fileContent: 'contents of A' });
      const el = await renderDiffView({ file: makeStatusEntry({ path: 'A.ts' }) });

      (el.shadowRoot!.querySelector('.edit-btn') as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;
      expect(el.shadowRoot!.querySelector('.editor-textarea')).to.not.be.null;

      el.file = makeStatusEntry({ path: 'B.ts' });
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      expect(
        el.shadowRoot!.querySelector('.editor-textarea'),
        'the editor does not follow the selection',
      ).to.be.null;
    });

    it("a stale buffer can never be written to the newly selected file", async () => {
      setupDefaultMocks({ fileContent: 'contents of A' });
      const el = await renderDiffView({ file: makeStatusEntry({ path: 'A.ts' }) });

      (el.shadowRoot!.querySelector('.edit-btn') as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const textarea = el.shadowRoot!.querySelector('.editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'edits meant for A';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      el.file = makeStatusEntry({ path: 'B.ts' });
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      invokeHistory.length = 0;
      // Reach past the UI: even if a save were somehow triggered, the buffer no
      // longer belongs to the displayed file.
      await (el as unknown as { saveEdit: () => Promise<void> }).saveEdit();

      const writes = invokeHistory.filter((c) => c.command === 'write_file_content');
      expect(writes.length, "B.ts is never written with A's content").to.equal(0);
    });

    it('closes the editor when the file being edited becomes conflicted', async () => {
      // A merge run elsewhere turns the open file conflicted; app-shell swaps in
      // the fresh status entry. The path still matches, so nothing else closes
      // the editor — and the conflict notice hides the textarea, parking the
      // pre-conflict buffer out of sight instead of reporting it.
      setupDefaultMocks({ fileContent: 'contents of main' });
      const el = await renderDiffView({ file: makeStatusEntry({ path: 'src/main.ts' }) });

      (el.shadowRoot!.querySelector('.edit-btn') as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const textarea = el.shadowRoot!.querySelector('.editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'pre-conflict text';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      uiStore.setState({ toasts: [] });
      el.file = makeStatusEntry({ path: 'src/main.ts', isConflicted: true, status: 'conflicted' });
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const view = el as unknown as { editMode: boolean; editContent: string };
      expect(view.editMode, 'the editor closes on the conflicted transition').to.be.false;
      expect(view.editContent).to.equal('');
      const warnings = uiStore.getState().toasts.filter((t) => t.type === 'warning');
      expect(
        warnings.some((t) => t.message.includes('src/main.ts')),
        'the dropped text is reported, not silently parked behind the conflict notice',
      ).to.be.true;

      // Resolving the conflict swaps the entry back — the editor must not
      // reappear holding text from before the merge.
      el.file = makeStatusEntry({ path: 'src/main.ts', isConflicted: false });
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      expect(
        el.shadowRoot!.querySelector('.editor-textarea'),
        'the pre-conflict buffer does not come back over the resolved file',
      ).to.be.null;
      expect(view.editContent).to.equal('');
    });

    it('does not report a save in flight as unsaved edits', async () => {
      // app-shell's teardowns (the x button, Escape, a repository tab switch)
      // read hasUnsavedEdits to warn. A write already on its way to disk is not
      // lost text — saveEdit reports its own failure.
      const write = deferred<unknown>();
      setupDefaultMocks({ fileContent: 'contents of main' });
      const el = await renderDiffView({ file: makeStatusEntry({ path: 'src/main.ts' }) });

      (el.shadowRoot!.querySelector('.edit-btn') as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const textarea = el.shadowRoot!.querySelector('.editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'edited text';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;
      expect(el.hasUnsavedEdits, 'typed text with no save started is unsaved').to.be.true;

      mockInvoke = async (command: string) => {
        if (command === 'write_file_content') return write.promise;
        if (command === 'get_file_diff') return makeDiffFile();
        if (command === 'get_diff_tool') return { tool: null };
        return null;
      };

      const save = (el as unknown as { saveEdit: () => Promise<void> }).saveEdit();
      await el.updateComplete;
      expect(el.hasUnsavedEdits, 'a write in flight is not discarded text').to.be.false;

      write.reject({ code: 'COMMAND_ERROR', message: 'permission denied' });
      await save;
      await el.updateComplete;

      expect(el.hasUnsavedEdits, 'a failed write leaves the text unsaved again').to.be.true;
    });
  });

  // ── Conflicted files ──────────────────────────────────────────────────
  describe('conflicted files', () => {
    it('shows the merge-editor redirect instead of a diff', async () => {
      const diff = makeDiffFile({ status: 'conflicted' });
      setupDefaultMocks({ diff, fileContent: CONFLICT_CONTENT });

      const el = await renderDiffView({
        file: makeStatusEntry({ isConflicted: true, status: 'conflicted' }),
      });

      const redirect = el.shadowRoot!.querySelector('.conflict-redirect');
      expect(redirect).to.not.be.null;
      expect(redirect!.textContent).to.include('merge conflicts');
      // No diff body and no edit affordance for conflicted files.
      expect(el.shadowRoot!.querySelector('.diff-content')).to.be.null;
      expect(el.shadowRoot!.querySelector('.edit-btn')).to.be.null;
    });

    it('never renders raw conflict markers', async () => {
      const diff = makeDiffFile({ status: 'conflicted' });
      setupDefaultMocks({ diff, fileContent: CONFLICT_CONTENT });

      const el = await renderDiffView({
        file: makeStatusEntry({ isConflicted: true, status: 'conflicted' }),
      });

      const text = el.shadowRoot!.textContent ?? '';
      for (const marker of ['<<<<<<<', '=======', '>>>>>>>']) {
        expect(text, `UI must never contain "${marker}"`).to.not.include(marker);
      }
    });

    it('does not load the marker-laden diff at all', async () => {
      const diff = makeDiffFile({ status: 'conflicted' });
      setupDefaultMocks({ diff, fileContent: CONFLICT_CONTENT });

      clearHistory();
      await renderDiffView({
        file: makeStatusEntry({ isConflicted: true, status: 'conflicted' }),
      });

      expect(findCommands('get_file_diff').length).to.equal(0);
    });

    it('dispatches open-conflict-dialog when Open Merge Editor is clicked', async () => {
      const diff = makeDiffFile({ status: 'conflicted' });
      setupDefaultMocks({ diff, fileContent: CONFLICT_CONTENT });

      const el = await renderDiffView({
        file: makeStatusEntry({ isConflicted: true, status: 'conflicted' }),
      });

      let dispatched = false;
      el.addEventListener('open-conflict-dialog', () => {
        dispatched = true;
      });

      const btn = el.shadowRoot!.querySelector('.conflict-redirect-btn') as HTMLElement;
      expect(btn).to.not.be.null;
      btn.click();

      expect(dispatched).to.be.true;
    });

    it('does not show the redirect for non-conflicted files', async () => {
      setupDefaultMocks();
      const el = await renderDiffView();

      expect(el.shadowRoot!.querySelector('.conflict-redirect')).to.be.null;
    });
  });

  // ── Partial staging banner ──────────────────────────────────────────────
  describe('partial staging banner', () => {
    it('shows partial staging info when hasPartialStaging is true and file is unstaged', async () => {
      setupDefaultMocks();
      const el = await renderDiffView({
        file: makeStatusEntry({ isStaged: false }),
        hasPartialStaging: true,
      });

      const banner = el.shadowRoot!.querySelector('.partial-staging-info');
      expect(banner).to.not.be.null;
      expect(banner!.textContent).to.include('staged changes');
    });

    it('does not show partial staging info when hasPartialStaging is false', async () => {
      setupDefaultMocks();
      const el = await renderDiffView({
        file: makeStatusEntry({ isStaged: false }),
        hasPartialStaging: false,
      });

      const banner = el.shadowRoot!.querySelector('.partial-staging-info');
      expect(banner).to.be.null;
    });

    it('does not show partial staging info when file is staged', async () => {
      setupDefaultMocks();
      const el = await renderDiffView({
        file: makeStatusEntry({ isStaged: true }),
        hasPartialStaging: true,
      });

      const banner = el.shadowRoot!.querySelector('.partial-staging-info');
      expect(banner).to.be.null;
    });
  });

  // ── Binary files ──────────────────────────────────────────────────────
  describe('file type detection', () => {
    it('shows binary notice for binary non-image files', async () => {
      const diff = makeDiffFile({ isBinary: true, isImage: false });
      setupDefaultMocks({ diff });
      const el = await renderDiffView();

      const binaryNotice = el.shadowRoot!.querySelector('.binary-notice');
      expect(binaryNotice).to.not.be.null;
      expect(binaryNotice!.textContent).to.include('Binary file');
    });

    it('does not show binary notice for text files', async () => {
      setupDefaultMocks();
      const el = await renderDiffView();

      const binaryNotice = el.shadowRoot!.querySelector('.binary-notice');
      expect(binaryNotice).to.be.null;
    });

    it('does not show Edit button for binary files', async () => {
      const diff = makeDiffFile({ isBinary: true, isImage: false });
      setupDefaultMocks({ diff });
      const el = await renderDiffView();

      // Binary notice replaces the entire header, so no edit button
      const editBtn = el.shadowRoot!.querySelector('.edit-btn');
      expect(editBtn).to.be.null;
    });
  });

  // ── Error handling ──────────────────────────────────────────────────────
  describe('error handling', () => {
    it('shows error message when diff loading fails', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_file_diff':
            throw new Error('Network error');
          case 'get_diff_tool':
            return { tool: null };
          default:
            return null;
        }
      };

      const el = await renderDiffView();

      const errorDiv = el.shadowRoot!.querySelector('.error');
      expect(errorDiv).to.not.be.null;
      expect(errorDiv!.textContent).to.include('Network error');
    });

    it('shows error from failed CommandResult', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_file_diff':
            // invokeCommand wraps thrown errors into { success: false, error: ... }
            // but here we go through invoke directly, which throws and gets caught
            throw { code: 'DIFF_ERROR', message: 'Cannot diff deleted file' };
          case 'get_diff_tool':
            return { tool: null };
          default:
            return null;
        }
      };

      const el = await renderDiffView();

      const errorDiv = el.shadowRoot!.querySelector('.error');
      expect(errorDiv).to.not.be.null;
      expect(errorDiv!.textContent).to.include('Cannot diff deleted file');
    });
  });

  // ── Word wrap toggle ──────────────────────────────────────────────────
  describe('word wrap', () => {
    it('toggles word-wrap class on diff content when word wrap button is clicked', async () => {
      const el = await renderDiffView();

      // Initially no word-wrap
      let diffContent = el.shadowRoot!.querySelector('.diff-content');
      expect(diffContent).to.not.be.null;
      expect(diffContent!.classList.contains('word-wrap')).to.be.false;

      // Click word wrap button
      const viewBtns = el.shadowRoot!.querySelectorAll('.view-btn');
      const wordWrapBtn = Array.from(viewBtns).find(
        (btn) => btn.getAttribute('title') === 'Toggle word wrap'
      );
      expect(wordWrapBtn).to.not.be.null;
      (wordWrapBtn as HTMLElement).click();
      await el.updateComplete;

      diffContent = el.shadowRoot!.querySelector('.diff-content');
      expect(diffContent).to.not.be.null;
      expect(diffContent!.classList.contains('word-wrap')).to.be.true;
    });

    it('toolbar button writes the shared Word Wrap setting', async () => {
      const el = await renderDiffView();

      clickWordWrapButton(el);
      await el.updateComplete;

      expect(settingsStore.getState().wordWrap, 'the app setting is the source of truth').to.be
        .true;
      const diffContent = el.shadowRoot!.querySelector('.diff-content');
      expect(diffContent!.classList.contains('word-wrap')).to.be.true;
    });

    it('renders wrapped when the setting is already on', async () => {
      settingsStore.getState().setWordWrap(true);

      const el = await renderDiffView();

      const diffContent = el.shadowRoot!.querySelector('.diff-content');
      expect(diffContent!.classList.contains('word-wrap')).to.be.true;
      const wordWrapBtn = findWordWrapButton(el);
      expect(wordWrapBtn!.classList.contains('active'), 'the toolbar button reflects it').to.be
        .true;
    });

    it('follows the Settings dialog changing the setting while the diff is open', async () => {
      const el = await renderDiffView();
      let diffContent = el.shadowRoot!.querySelector('.diff-content');
      expect(diffContent!.classList.contains('word-wrap')).to.be.false;

      settingsStore.getState().setWordWrap(true);
      await el.updateComplete;

      diffContent = el.shadowRoot!.querySelector('.diff-content');
      expect(diffContent!.classList.contains('word-wrap')).to.be.true;
    });

    it('no longer writes its own word-wrap storage key', async () => {
      const el = await renderDiffView();

      clickWordWrapButton(el);
      await el.updateComplete;

      expect(localStorage.getItem('gitnado-diff-word-wrap')).to.be.null;
    });

    it('stops following the setting once removed', async () => {
      const el = await renderDiffView();

      el.remove();
      settingsStore.getState().setWordWrap(true);

      expect((el as unknown as { wordWrap: boolean }).wordWrap, 'the subscription is torn down').to
        .be.false;
    });
  });

  // ── Split view rendering ──────────────────────────────────────────────
  describe('split view rendering', () => {
    it('renders deletion lines on the left pane and addition lines on the right pane', async () => {
      const el = await renderDiffView();

      // Switch to split view
      const viewBtns = el.shadowRoot!.querySelectorAll('.view-btn');
      const splitBtn = Array.from(viewBtns).find(
        (btn) => btn.getAttribute('title') === 'Split view'
      );
      (splitBtn as HTMLElement).click();
      await el.updateComplete;

      const splitPanes = el.shadowRoot!.querySelectorAll('.split-pane');
      expect(splitPanes.length).to.equal(2);

      // Left pane (Original) should have deletion lines
      const leftDeletions = splitPanes[0].querySelectorAll('.split-line.code-deletion');
      expect(leftDeletions.length).to.be.greaterThan(0);

      // Right pane (Modified) should have addition lines
      const rightAdditions = splitPanes[1].querySelectorAll('.split-line.code-addition');
      expect(rightAdditions.length).to.be.greaterThan(0);
    });
  });

  // ── Split view staging ────────────────────────────────────────────────
  // Split view used to be read-only: no hunk Stage/Unstage buttons, no line
  // checkboxes, no click-to-select and no selection actions bar — while the
  // header still offered the line-selection toggle that did nothing there.
  describe('split view staging', () => {
    function headerBtn(el: LvDiffView, title: string): HTMLElement {
      const btn = Array.from(el.shadowRoot!.querySelectorAll('.view-btn')).find(
        (b) => b.getAttribute('title') === title
      );
      expect(btn, `header button "${title}"`).to.not.be.undefined;
      return btn as HTMLElement;
    }

    async function switchToSplit(el: LvDiffView): Promise<void> {
      headerBtn(el, 'Split view').click();
      await el.updateComplete;
    }

    async function enterLineSelectionMode(el: LvDiffView): Promise<void> {
      headerBtn(el, 'Toggle line selection mode for staging individual lines').click();
      await el.updateComplete;
    }

    /** The Modified pane, which is where the hunk actions live. */
    function modifiedPane(el: LvDiffView): Element {
      const panes = el.shadowRoot!.querySelectorAll('.split-pane');
      expect(panes.length, 'both split panes render').to.equal(2);
      return panes[1];
    }

    function lastPatch(command: string): string {
      const calls = findCommands(command);
      expect(calls.length, `${command} should have been invoked once`).to.equal(1);
      const args = calls[0].args as Record<string, unknown>;
      const payload = (args?.args ?? args) as Record<string, unknown>;
      return String(payload.patch ?? '');
    }

    it('shows Stage buttons on split-view hunk separators for an unstaged file', async () => {
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: false }) });
      await switchToSplit(el);

      const stageBtn = modifiedPane(el).querySelector('.stage-btn.stage');
      expect(stageBtn, 'the split view offers hunk staging').to.not.be.null;
      expect(stageBtn!.textContent).to.include('Stage');
    });

    it('shows Unstage buttons on split-view hunk separators for a staged file', async () => {
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: true }) });
      await switchToSplit(el);

      const unstageBtn = modifiedPane(el).querySelector('.stage-btn.unstage');
      expect(unstageBtn, 'the split view offers hunk unstaging').to.not.be.null;
      expect(unstageBtn!.textContent).to.include('Unstage');
    });

    it('stages a hunk from split view', async () => {
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: false }) });
      await switchToSplit(el);

      clearHistory();
      (modifiedPane(el).querySelector('.stage-btn.stage') as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      const patch = lastPatch('stage_hunk');
      expect(patch).to.include('+new line');
      expect(patch).to.include('-old line');
    });

    it('does not show stage buttons in split view for commit diffs', async () => {
      const el = await renderDiffView({
        file: null,
        commitFile: { commitOid: 'abc123', filePath: 'src/main.ts' },
      });
      await switchToSplit(el);

      expect(el.shadowRoot!.querySelector('.stage-btn'), 'commit diffs cannot be staged').to.be
        .null;
    });

    it('renders checkboxes on split changed lines in line-selection mode', async () => {
      const el = await renderDiffView();
      await enterLineSelectionMode(el);
      await switchToSplit(el);

      const addCheckbox = el.shadowRoot!.querySelector(
        '.split-line.code-addition .line-checkbox'
      );
      const delCheckbox = el.shadowRoot!.querySelector(
        '.split-line.code-deletion .line-checkbox'
      );
      expect(addCheckbox, 'addition rows are selectable').to.not.be.null;
      expect(delCheckbox, 'deletion rows are selectable').to.not.be.null;
    });

    it('clicking a changed line in split view selects it and shows the selection actions bar', async () => {
      const el = await renderDiffView();
      await enterLineSelectionMode(el);
      await switchToSplit(el);

      const addLine = el.shadowRoot!.querySelector('.split-line.code-addition') as HTMLElement;
      expect(addLine).to.not.be.null;
      addLine.click();
      await el.updateComplete;

      expect(
        el.shadowRoot!.querySelector('.split-line.code-addition')!.classList.contains('selected'),
        'the clicked row is marked selected'
      ).to.be.true;

      const actions = el.shadowRoot!.querySelector('.selection-actions');
      expect(actions, 'the selection actions bar is reachable from split view').to.not.be.null;
      expect(actions!.textContent).to.include('1 line selected');
    });

    it('Stage Selected stages only the lines picked in split view', async () => {
      const el = await renderDiffView();
      await enterLineSelectionMode(el);
      await switchToSplit(el);

      (el.shadowRoot!.querySelector('.split-line.code-addition') as HTMLElement).click();
      await el.updateComplete;

      clearHistory();
      (el.shadowRoot!.querySelector('.selection-actions .selection-btn.primary') as HTMLElement)
        .click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      const lines = lastPatch('stage_hunk').split('\n');
      expect(lines).to.include('+new line');
      // The deletion was not selected, so it stays in the index as context.
      expect(lines.some((l) => l.startsWith('-old line'))).to.be.false;
      expect(lines).to.include(' old line');
    });

    it('a whitespace-only split row selects both of its lines', async () => {
      // One change shown on both sides — selecting it must select the
      // deletion AND the addition, the same rule the unified view applies.
      const diff = makeDiffFile({
        hunks: [
          makeDiffHunk({
            header: '@@ -1,2 +1,2 @@',
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 2,
            lines: [
              makeDiffLine({ content: 'ctx', origin: 'context', oldLineNo: 1, newLineNo: 1 }),
              makeDiffLine({
                content: '    indented',
                origin: 'deletion',
                oldLineNo: 2,
                newLineNo: null,
              }),
              makeDiffLine({
                content: '\tindented',
                origin: 'addition',
                oldLineNo: null,
                newLineNo: 2,
              }),
            ],
          }),
        ],
      });
      setupDefaultMocks({ diff });
      const el = await renderDiffView();
      await enterLineSelectionMode(el);
      await switchToSplit(el);

      const panes = el.shadowRoot!.querySelectorAll('.split-pane');
      const leftCell = panes[0].querySelector('.split-line.code-ws-change') as HTMLElement;
      expect(leftCell, 'the whitespace-only row renders on the Original side').to.not.be.null;
      leftCell.click();
      await el.updateComplete;

      const selected = (el as unknown as { selectedLines: Set<string> }).selectedLines;
      expect(Array.from(selected).sort()).to.deep.equal(['0-1', '0-2']);
      expect(
        panes[0].querySelector('.split-line.code-ws-change')!.classList.contains('selected')
      ).to.be.true;
      expect(
        panes[1].querySelector('.split-line.code-ws-change')!.classList.contains('selected')
      ).to.be.true;
    });

    it('surfaces an error when staging a hunk from split view fails', async () => {
      const diff = makeDiffFile();
      mockInvoke = async (command: string) => {
        if (command === 'stage_hunk') throw new Error('index.lock exists');
        if (command === 'get_file_diff') return diff;
        return null;
      };
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: false }) });
      await switchToSplit(el);
      uiStore.setState({ toasts: [] });

      (modifiedPane(el).querySelector('.stage-btn.stage') as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const errors = uiStore.getState().toasts.filter((t) => t.type === 'error');
      expect(errors.length, 'the failure is not silent').to.equal(1);
      expect(errors[0].message).to.include('Failed to stage hunk');
    });
  });

  // ── Hunk stage/unstage buttons ────────────────────────────────────────
  describe('hunk staging', () => {
    it('shows Stage button for unstaged file hunks', async () => {
      setupDefaultMocks();
      const el = await renderDiffView({
        file: makeStatusEntry({ isStaged: false }),
      });

      const stageBtn = el.shadowRoot!.querySelector('.stage-btn.stage');
      expect(stageBtn).to.not.be.null;
      expect(stageBtn!.textContent).to.include('Stage');
    });

    it('shows Unstage button for staged file hunks', async () => {
      setupDefaultMocks();
      const el = await renderDiffView({
        file: makeStatusEntry({ isStaged: true }),
      });

      const unstageBtn = el.shadowRoot!.querySelector('.stage-btn.unstage');
      expect(unstageBtn).to.not.be.null;
      expect(unstageBtn!.textContent).to.include('Unstage');
    });

    it('does not show stage buttons for commit diffs', async () => {
      const diff = makeDiffFile();
      setupDefaultMocks({ diff });
      const el = await renderDiffView({
        file: null,
        commitFile: { commitOid: 'abc123', filePath: 'src/main.ts' },
      });

      const stageBtn = el.shadowRoot!.querySelector('.stage-btn');
      expect(stageBtn).to.be.null;
    });
  });

  // ── Truncated / full diff ─────────────────────────────────────────────
  describe('truncated diff', () => {
    it('passes a default maxLines cap on the initial working diff fetch', async () => {
      setupDefaultMocks();
      await renderDiffView({ file: makeStatusEntry() });

      const calls = findCommands('get_file_diff');
      expect(calls.length).to.be.greaterThan(0);
      const args = calls[calls.length - 1].args as { maxLines?: number };
      expect(args.maxLines).to.equal(3000);
    });

    it('passes a default maxLines cap on the initial commit diff fetch', async () => {
      setupDefaultMocks();
      await renderDiffView({
        file: null,
        commitFile: { commitOid: 'abc123', filePath: 'src/main.ts' },
      });

      const calls = findCommands('get_commit_file_diff');
      expect(calls.length).to.be.greaterThan(0);
      const args = calls[calls.length - 1].args as { maxLines?: number };
      expect(args.maxLines).to.equal(3000);
    });

    it('shows the "Load full diff" banner when the diff is truncated', async () => {
      const diff = makeDiffFile({ truncated: true, totalLines: 50000 });
      setupDefaultMocks({ diff });
      const el = await renderDiffView();

      const banner = el.shadowRoot!.querySelector('.large-diff-info');
      expect(banner).to.not.be.null;
      const btn = banner!.querySelector('.btn-link');
      expect(btn).to.not.be.null;
      expect(btn!.textContent).to.include('Load full diff');
    });

    it('re-fetches without a maxLines cap and hides the banner when "Load full diff" is clicked', async () => {
      // First load: truncated. Second load (full): not truncated.
      let firstLoad = true;
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_file_diff': {
            if (firstLoad) {
              firstLoad = false;
              return makeDiffFile({ truncated: true, totalLines: 50000 });
            }
            return makeDiffFile({ truncated: false });
          }
          case 'get_diff_tool':
            return { tool: null };
          default:
            return null;
        }
      };

      const el = await renderDiffView();

      // Banner present initially
      expect(el.shadowRoot!.querySelector('.large-diff-info')).to.not.be.null;

      clearHistory();
      const btn = el.shadowRoot!.querySelector('.large-diff-info .btn-link') as HTMLElement;
      btn.click();

      // Wait for the re-fetch to settle
      const start = Date.now();
      while (Date.now() - start < 2000) {
        await new Promise((r) => setTimeout(r, 50));
        await el.updateComplete;
        if (!(el as unknown as { loading: boolean }).loading) break;
      }
      await el.updateComplete;

      // The re-fetch used no maxLines cap
      const calls = findCommands('get_file_diff');
      expect(calls.length).to.be.greaterThan(0);
      const args = calls[calls.length - 1].args as { maxLines?: number };
      expect(args.maxLines).to.equal(undefined);

      // Banner is gone now that the full diff is loaded
      expect(el.shadowRoot!.querySelector('.large-diff-info')).to.be.null;
    });

    it('does not dispatch a load-full-diff event (handled internally)', async () => {
      const diff = makeDiffFile({ truncated: true, totalLines: 50000 });
      setupDefaultMocks({ diff });
      const el = await renderDiffView();

      let eventFired = false;
      el.addEventListener('load-full-diff', () => { eventFired = true; });

      const btn = el.shadowRoot!.querySelector('.large-diff-info .btn-link') as HTMLElement;
      btn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      expect(eventFired).to.be.false;
    });
  });

  // ── File status badge ──────────────────────────────────────────────────
  describe('file status badge', () => {
    it('renders the file status badge with correct class', async () => {
      setupDefaultMocks();
      const el = await renderDiffView();

      const statusBadge = el.shadowRoot!.querySelector('.file-status');
      expect(statusBadge).to.not.be.null;
      expect(statusBadge!.classList.contains('modified')).to.be.true;
      expect(statusBadge!.textContent).to.include('modified');
    });

    it('renders "new" status for new files', async () => {
      const diff = makeDiffFile({ status: 'new' });
      setupDefaultMocks({ diff });
      const el = await renderDiffView({
        file: makeStatusEntry({ status: 'new' }),
      });

      const statusBadge = el.shadowRoot!.querySelector('.file-status');
      expect(statusBadge).to.not.be.null;
      expect(statusBadge!.classList.contains('new')).to.be.true;
    });
  });

  // ── Patch construction: no-newline markers and CRLF content ──────────────
  // Regression tests for hunk/line staging producing patches that byte-match
  // the index (findings: EOFNL markers and CR stripping).
  describe('patch construction', () => {
    async function bareView(): Promise<LvDiffView> {
      const el = await fixture<LvDiffView>(html`<lv-diff-view></lv-diff-view>`);
      await el.updateComplete;
      return el;
    }

    it('buildHunkPatch keeps the \\r in CRLF content lines', async () => {
      const el = await bareView();
      const hunk = makeDiffHunk({
        header: '@@ -1,2 +1,2 @@',
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: [
          makeDiffLine({ content: 'ctx\r\n', origin: 'context', oldLineNo: 1, newLineNo: 1 }),
          makeDiffLine({ content: 'old\r\n', origin: 'deletion', oldLineNo: 2, newLineNo: null }),
          makeDiffLine({ content: 'new\r\n', origin: 'addition', oldLineNo: null, newLineNo: 2 }),
        ],
      });
      (el as unknown as { file: unknown }).file = makeStatusEntry({ path: 'f.txt' });
      (el as unknown as { diff: unknown }).diff = makeDiffFile({ path: 'f.txt', hunks: [hunk] });

      const patch = (el as unknown as { buildHunkPatch: (h: DiffHunk) => string }).buildHunkPatch(hunk);
      const patchLines = patch.split('\n');
      // \r is preserved (part of the file bytes); only the \n terminator is stripped.
      expect(patchLines).to.include(' ctx\r');
      expect(patchLines).to.include('-old\r');
      expect(patchLines).to.include('+new\r');
    });

    // A hunk with BOTH a selected and an unselected change of each kind — the
    // shape that made partial unstaging fail on every mixed hunk.
    function mixedHunk() {
      return makeDiffHunk({
        header: '@@ -1,4 +1,4 @@',
        oldStart: 1,
        oldLines: 4,
        newStart: 1,
        newLines: 4,
        lines: [
          makeDiffLine({ content: 'ctx\n', origin: 'context', oldLineNo: 1, newLineNo: 1 }),
          makeDiffLine({ content: 'del-sel\n', origin: 'deletion', oldLineNo: 2, newLineNo: null }),
          makeDiffLine({ content: 'del-unsel\n', origin: 'deletion', oldLineNo: 3, newLineNo: null }),
          makeDiffLine({ content: 'add-sel\n', origin: 'addition', oldLineNo: null, newLineNo: 2 }),
          makeDiffLine({ content: 'add-unsel\n', origin: 'addition', oldLineNo: null, newLineNo: 3 }),
        ],
      });
    }

    async function viewWithMixedHunk(): Promise<LvDiffView> {
      const el = await bareView();
      (el as unknown as { repositoryPath: string }).repositoryPath = REPO_PATH;
      (el as unknown as { file: unknown }).file = makeStatusEntry({ path: 'f.txt' });
      await el.updateComplete;
      (el as unknown as { diff: unknown }).diff = makeDiffFile({
        path: 'f.txt',
        hunks: [mixedHunk()],
      });
      (el as unknown as {
        loadedWorkingDiffContext: {
          repositoryPath: string;
          filePath: string;
          isStaged: boolean;
        };
      }).loadedWorkingDiffContext = {
        repositoryPath: REPO_PATH,
        filePath: 'f.txt',
        isStaged: false,
      };
      // Select the deletion at index 1 and the addition at index 3.
      (el as unknown as { selectedLines: Set<string> }).selectedLines = new Set(['0-1', '0-3']);
      return el;
    }

    type PatchBuilder = { buildSelectedLinesPatch: (d?: 'stage' | 'unstage') => string };

    it('staging keeps an unselected deletion as context and omits an unselected addition', async () => {
      const el = await viewWithMixedHunk();
      const patch = (el as unknown as PatchBuilder).buildSelectedLinesPatch('stage');
      const lines = patch.split('\n');

      expect(lines).to.include('-del-sel');
      expect(lines).to.include('+add-sel');
      // Still in the index, so it is context on both sides.
      expect(lines).to.include(' del-unsel');
      // Not in the index yet, so it must not appear at all.
      expect(lines.some((l) => l.includes('add-unsel'))).to.be.false;
    });

    it('unstaging omits an unselected deletion and keeps an unselected addition as context', async () => {
      const el = await viewWithMixedHunk();
      const patch = (el as unknown as PatchBuilder).buildSelectedLinesPatch('unstage');
      const lines = patch.split('\n');

      expect(lines).to.include('-del-sel');
      expect(lines).to.include('+add-sel');
      // The deletion is already in the index, so this line is NOT there —
      // emitting it as context makes the reverse apply reject the patch.
      expect(
        lines.some((l) => l.includes('del-unsel')),
        'an unselected deletion must not appear in an unstage patch',
      ).to.be.false;
      // The addition IS in the index and is staying, so it is context.
      expect(lines).to.include(' add-unsel');
    });

    it('unstageSelectedLines sends an unstage-shaped patch to the backend', async () => {
      // The direction must be wired at the CALL SITE, not just supported by the
      // builder: unstage_hunk reverse-applies the patch, so a patch built with
      // the staging transformation is rejected for every mixed hunk.
      const el = await viewWithMixedHunk();
      (el as unknown as { repositoryPath: string }).repositoryPath = '/test/repo';

      clearHistory();
      mockInvoke = () => Promise.resolve(null);
      await (el as unknown as { unstageSelectedLines: () => Promise<boolean> }).unstageSelectedLines();

      const calls = findCommands('unstage_hunk');
      expect(calls.length, 'unstage_hunk should have been invoked').to.equal(1);

      const args = calls[0].args as Record<string, unknown>;
      const payload = (args?.args ?? args) as Record<string, unknown>;
      const patch = String(payload.patch ?? payload.patchText ?? '');
      const lines = patch.split('\n');

      expect(
        lines.some((l) => l.includes('del-unsel')),
        'the patch sent to unstage_hunk still used the staging transformation',
      ).to.be.false;
      expect(lines).to.include(' add-unsel');
    });

    it('hunk header counts match the emitted lines in both directions', async () => {
      const countFor = (patch: string) => {
        const lines = patch.split('\n');
        const header = lines.find((l) => l.startsWith('@@'))!;
        const m = /@@ -\d+,(\d+) \+\d+,(\d+) @@/.exec(header)!;
        const body = lines.slice(lines.indexOf(header) + 1).filter((l) => l.length > 0);
        const oldSide = body.filter((l) => l.startsWith(' ') || l.startsWith('-')).length;
        const newSide = body.filter((l) => l.startsWith(' ') || l.startsWith('+')).length;
        return { declaredOld: Number(m[1]), declaredNew: Number(m[2]), oldSide, newSide };
      };

      for (const direction of ['stage', 'unstage'] as const) {
        const el = await viewWithMixedHunk();
        const c = countFor((el as unknown as PatchBuilder).buildSelectedLinesPatch(direction));
        expect(c.declaredOld, `${direction}: old count`).to.equal(c.oldSide);
        expect(c.declaredNew, `${direction}: new count`).to.equal(c.newSide);
      }
    });

    it('buildSelectedLinesPatch emits "\\ No newline at end of file" markers', async () => {
      const el = await bareView();
      // Mirrors libgit2 output for a file whose last line lacks a trailing
      // newline on both sides: the marker follows the annotated content line.
      const hunk = makeDiffHunk({
        header: '@@ -1,3 +1,3 @@',
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [
          makeDiffLine({ content: 'line1\n', origin: 'context', oldLineNo: 1, newLineNo: 1 }),
          makeDiffLine({ content: 'line2\n', origin: 'context', oldLineNo: 2, newLineNo: 2 }),
          makeDiffLine({ content: 'last', origin: 'deletion', oldLineNo: 3, newLineNo: null }),
          makeDiffLine({ content: '\n\\ No newline at end of file\n', origin: 'add-eofnl', oldLineNo: null, newLineNo: null }),
          makeDiffLine({ content: 'CHANGED', origin: 'addition', oldLineNo: null, newLineNo: 3 }),
          makeDiffLine({ content: '\n\\ No newline at end of file\n', origin: 'del-eofnl', oldLineNo: null, newLineNo: null }),
        ],
      });
      (el as unknown as { file: unknown }).file = makeStatusEntry({ path: 'f.txt' });
      (el as unknown as { diff: unknown }).diff = makeDiffFile({ path: 'f.txt', hunks: [hunk] });
      // Select the deletion (index 2) and the addition (index 4).
      (el as unknown as { selectedLines: Set<string> }).selectedLines = new Set(['0-2', '0-4']);

      const patch = (el as unknown as { buildSelectedLinesPatch: () => string }).buildSelectedLinesPatch();

      // The marker must appear immediately after both the deleted and the added
      // last line — not be dropped.
      expect(patch).to.contain('-last\n\\ No newline at end of file\n');
      expect(patch).to.contain('+CHANGED\n\\ No newline at end of file');
    });

    it('buildSelectedLinesPatch skips the newline marker of an unselected addition', async () => {
      const el = await bareView();
      // Appending a line without a trailing newline: only the new side lacks
      // the newline. If the addition is not selected, its marker must not leak
      // into the patch (which would otherwise fail to apply).
      const hunk = makeDiffHunk({
        header: '@@ -1,1 +1,2 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        lines: [
          makeDiffLine({ content: 'line1\n', origin: 'context', oldLineNo: 1, newLineNo: 1 }),
          makeDiffLine({ content: 'new', origin: 'addition', oldLineNo: null, newLineNo: 2 }),
          makeDiffLine({ content: '\n\\ No newline at end of file\n', origin: 'del-eofnl', oldLineNo: null, newLineNo: null }),
        ],
      });
      (el as unknown as { file: unknown }).file = makeStatusEntry({ path: 'f.txt' });
      (el as unknown as { diff: unknown }).diff = makeDiffFile({ path: 'f.txt', hunks: [hunk] });
      // Select nothing meaningful — the addition (index 1) is NOT selected.
      (el as unknown as { selectedLines: Set<string> }).selectedLines = new Set(['0-0']);

      const patch = (el as unknown as { buildSelectedLinesPatch: () => string }).buildSelectedLinesPatch();
      // No change selected → empty patch, and certainly no stray marker.
      expect(patch).to.not.contain('No newline at end of file');
    });
  });

  // ── Virtualized (very large) diffs ─────────────────────────────────────
  // Once the flattened diff exceeds the virtualization threshold the unified
  // view switches to renderVirtualizedUnifiedView(). That path must keep the
  // same staging affordances, otherwise "Load full diff" on a huge file is a
  // dead end: the user loaded it precisely to stage a hunk past the cap.
  describe('virtualized diff (large file)', () => {
    function makeVirtualizedDiffFile(overrides: Partial<DiffFile> = {}): DiffFile {
      const padLines: DiffLine[] = [];
      for (let i = 0; i < 5100; i++) {
        padLines.push(
          makeDiffLine({ content: `pad ${i}`, origin: 'context', oldLineNo: 900 + i, newLineNo: 900 + i })
        );
      }
      return makeDiffFile({
        hunks: [
          makeDiffHunk({
            header: '@@ -1,4 +1,5 @@',
            oldStart: 1,
            oldLines: 4,
            newStart: 1,
            newLines: 5,
            lines: [
              makeDiffLine({ content: 'alpha', origin: 'context', oldLineNo: 1, newLineNo: 1 }),
              makeDiffLine({ content: 'old first', origin: 'deletion', oldLineNo: 2, newLineNo: null }),
              makeDiffLine({ content: 'first hunk change', origin: 'addition', oldLineNo: null, newLineNo: 2 }),
              makeDiffLine({ content: 'omega', origin: 'context', oldLineNo: 3, newLineNo: 3 }),
            ],
          }),
          makeDiffHunk({
            header: '@@ -80,4 +81,5 @@',
            oldStart: 80,
            oldLines: 4,
            newStart: 81,
            newLines: 5,
            lines: [
              makeDiffLine({ content: 'beta', origin: 'context', oldLineNo: 80, newLineNo: 81 }),
              makeDiffLine({ content: 'old second', origin: 'deletion', oldLineNo: 81, newLineNo: null }),
              makeDiffLine({ content: 'second hunk change', origin: 'addition', oldLineNo: null, newLineNo: 82 }),
              makeDiffLine({ content: 'zeta', origin: 'context', oldLineNo: 82, newLineNo: 83 }),
            ],
          }),
          makeDiffHunk({
            header: '@@ -900,5100 +900,5100 @@',
            oldStart: 900,
            oldLines: 5100,
            newStart: 900,
            newLines: 5100,
            lines: padLines,
          }),
        ],
        ...overrides,
      });
    }

    /** The virtualized scroll container, which only exists on the virtualized path. */
    function container(el: LvDiffView): HTMLElement {
      const node = el.shadowRoot!.querySelector('.diff-virtualized-container');
      expect(node, 'expected the virtualized container to be rendered').to.not.be.null;
      return node as HTMLElement;
    }

    async function settle(el: LvDiffView): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < 2000) {
        await new Promise((r) => setTimeout(r, 25));
        await el.updateComplete;
        if (!(el as unknown as { loading: boolean }).loading) break;
      }
      await el.updateComplete;
    }

    async function enableLineSelectionMode(el: LvDiffView): Promise<void> {
      const toggle = Array.from(el.shadowRoot!.querySelectorAll('button.view-btn')).find((b) =>
        (b.getAttribute('title') ?? '').startsWith('Toggle line selection mode')
      ) as HTMLElement | undefined;
      expect(toggle, 'line selection toggle should exist in the toolbar').to.not.be.undefined;
      toggle!.click();
      await el.updateComplete;
    }

    it('renders per-hunk Stage buttons in the virtualized view', async () => {
      setupDefaultMocks({ diff: makeVirtualizedDiffFile() });
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: false }) });

      // Prove we really are on the virtualized path: no .hunk wrappers exist.
      const c = container(el);
      expect(el.shadowRoot!.querySelector('.hunk'), 'virtualized path should not render .hunk').to.be.null;

      const stageBtns = c.querySelectorAll('.stage-btn.stage');
      expect(stageBtns.length, 'each visible hunk header needs a Stage button').to.be.at.least(2);
      expect(stageBtns[0].getAttribute('title')).to.equal('Stage this hunk');

      // The virtual scroll offsets assume every row is exactly DIFF_LINE_HEIGHT tall.
      const header = c.querySelector('.virtual-hunk-header') as HTMLElement;
      expect(header, 'hunk headers should be rendered in the virtualized view').to.not.be.null;
      expect(Math.round(header.getBoundingClientRect().height)).to.equal(20);
    });

    it('stages the hunk whose Stage button was clicked in the virtualized view', async () => {
      setupDefaultMocks({ diff: makeVirtualizedDiffFile() });
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: false }) });

      let statusChanged = false;
      el.addEventListener('status-changed', () => { statusChanged = true; });

      const stageBtns = container(el).querySelectorAll('.stage-btn.stage');
      expect(stageBtns.length, 'need at least two Stage buttons to pick the second').to.be.at.least(2);
      clearHistory();
      (stageBtns[1] as HTMLElement).click();
      await settle(el);

      const calls = findCommands('stage_hunk');
      expect(calls.length, 'stage_hunk should have been invoked once').to.equal(1);
      const patch = (calls[0].args as { patch: string }).patch;
      expect(patch).to.contain('second hunk change');
      expect(patch).to.not.contain('first hunk change');
      expect(statusChanged, 'status-changed should be dispatched').to.be.true;
    });

    it('shows Unstage buttons in the virtualized view for a staged file', async () => {
      setupDefaultMocks({ diff: makeVirtualizedDiffFile() });
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: true }) });

      const c = container(el);
      const unstageBtn = c.querySelector('.stage-btn.unstage') as HTMLElement | null;
      expect(unstageBtn, 'a staged file should offer Unstage in the virtualized view').to.not.be.null;
      expect(c.querySelector('.stage-btn.stage')).to.be.null;

      clearHistory();
      unstageBtn!.click();
      await settle(el);

      expect(findCommands('unstage_hunk').length).to.equal(1);
    });

    it('reports a failure to stage a hunk from the virtualized view', async () => {
      const diff = makeVirtualizedDiffFile();
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_file_diff':
            return diff;
          case 'stage_hunk':
            throw { message: 'patch does not apply' };
          case 'get_diff_tool':
            return { tool: null };
          default:
            return null;
        }
      };
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: false }) });

      const stageBtn = container(el).querySelector('.stage-btn.stage') as HTMLElement | null;
      expect(stageBtn, 'a Stage button is required to exercise the error path').to.not.be.null;

      uiStore.setState({ toasts: [] });
      stageBtn!.click();
      await settle(el);

      const errors = uiStore.getState().toasts.filter((t) => t.type === 'error');
      expect(errors.length, 'a failed hunk stage must surface an error toast').to.equal(1);
      expect(errors[0].message).to.contain('Failed to stage hunk');
      expect(errors[0].message).to.contain('patch does not apply');
    });

    it('selects and stages individual lines in the virtualized view', async () => {
      setupDefaultMocks({ diff: makeVirtualizedDiffFile() });
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: false }) });

      await enableLineSelectionMode(el);

      const c = container(el);
      expect(c.classList.contains('line-selection-mode'), 'container needs the line-selection-mode class').to.be.true;

      const addition = c.querySelector('.line.code-addition') as HTMLElement | null;
      expect(addition, 'virtualized view should render addition lines').to.not.be.null;
      const checkbox = addition!.querySelector('.line-checkbox') as HTMLInputElement | null;
      expect(checkbox, 'addition lines need a selection checkbox').to.not.be.null;
      expect(getComputedStyle(checkbox!).display).to.not.equal('none');

      checkbox!.click();
      await el.updateComplete;

      const bars = el.shadowRoot!.querySelectorAll('.selection-actions');
      expect(bars.length, 'the bulk selection bar must be rendered exactly once in the virtualized view').to.equal(1);
      const bar = bars[0];
      expect(bar!.querySelector('.selection-info')!.textContent).to.contain('1 line selected');

      clearHistory();
      (bar!.querySelector('.selection-btn.primary') as HTMLElement).click();
      await settle(el);

      const calls = findCommands('stage_hunk');
      expect(calls.length, 'Stage Selected should invoke stage_hunk').to.equal(1);
      const patch = (calls[0].args as { patch: string }).patch;
      expect(patch).to.contain('first hunk change');
      expect(patch).to.not.contain('second hunk change');
    });

    it('opens the line context menu in the virtualized view', async () => {
      setupDefaultMocks({ diff: makeVirtualizedDiffFile() });
      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: false }) });

      const addition = container(el).querySelector('.line.code-addition') as HTMLElement | null;
      expect(addition).to.not.be.null;
      addition!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 10, clientY: 10 })
      );
      await el.updateComplete;

      const menu = el.shadowRoot!.querySelector('.context-menu');
      expect(menu, 'right-clicking a virtualized line should open the context menu').to.not.be.null;
      expect(menu!.textContent).to.contain('Stage hunk');
      expect(menu!.textContent).to.contain('Stage line');
    });

    it('does not offer staging in the virtualized view of a commit diff', async () => {
      setupDefaultMocks({ diff: makeVirtualizedDiffFile() });
      const el = await renderDiffView({
        file: null,
        commitFile: { commitOid: 'abc123', filePath: 'src/main.ts' },
      });

      const c = container(el);
      expect(c.querySelector('.stage-btn'), 'commit diffs are read-only').to.be.null;

      const line = c.querySelector('.line.code-addition') as HTMLElement | null;
      expect(line).to.not.be.null;
      line!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 10, clientY: 10 })
      );
      await el.updateComplete;

      const menu = el.shadowRoot!.querySelector('.context-menu');
      expect(menu, 'the copy actions should still be available on a commit diff').to.not.be.null;
      expect(menu!.textContent).to.contain('Copy line');
      expect(menu!.textContent).to.not.contain('Stage hunk');
    });
  });

  // ── Context-menu line staging ────────────────────────────────────────────
  // Selection keys are positional `${hunkIndex}-${lineIndex}` pairs. A stage or
  // unstage reloads the diff and renumbers those positions, so a selection
  // saved across the call would silently address different code.
  describe('context-menu line staging', () => {
    function stageableHunk(): DiffHunk {
      return makeDiffHunk({
        header: '@@ -1,4 +1,4 @@',
        oldStart: 1,
        oldLines: 4,
        newStart: 1,
        newLines: 4,
        lines: [
          makeDiffLine({ content: 'ctx\n', origin: 'context', oldLineNo: 1, newLineNo: 1 }),
          makeDiffLine({ content: 'del-a\n', origin: 'deletion', oldLineNo: 2, newLineNo: null }),
          makeDiffLine({ content: 'del-b\n', origin: 'deletion', oldLineNo: 3, newLineNo: null }),
          makeDiffLine({ content: 'add-a\n', origin: 'addition', oldLineNo: null, newLineNo: 2 }),
          makeDiffLine({ content: 'add-b\n', origin: 'addition', oldLineNo: null, newLineNo: 3 }),
        ],
      });
    }

    // The same file after one change was applied: one hunk line fewer, so the
    // old key '0-2' now addresses an addition and '0-4' no longer exists.
    function reloadedHunk(): DiffHunk {
      return makeDiffHunk({
        header: '@@ -1,3 +1,3 @@',
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [
          makeDiffLine({ content: 'ctx\n', origin: 'context', oldLineNo: 1, newLineNo: 1 }),
          makeDiffLine({ content: 'del-b\n', origin: 'deletion', oldLineNo: 2, newLineNo: null }),
          makeDiffLine({ content: 'add-a\n', origin: 'addition', oldLineNo: null, newLineNo: 2 }),
        ],
      });
    }

    type Handlers = {
      handleContextStageLine: () => Promise<void>;
      handleContextUnstageLine: () => Promise<void>;
      stageSelectedLines: () => Promise<boolean>;
      selectedLines: Set<string>;
      lineSelectionMode: boolean;
      diff: DiffFile;
      contextMenu: { visible: boolean; x: number; y: number; line: DiffLine | null; hunk: DiffHunk | null };
    };

    /**
     * Renders the view with two lines already selected by the user ('0-2' and
     * '0-4') and the context menu open on a third line.
     */
    async function viewWithOpenContextMenu(
      opts: { isStaged?: boolean; hunkFails?: boolean; emptyAfterApply?: boolean } = {},
    ): Promise<LvDiffView> {
      const original = makeDiffFile({ hunks: [stageableHunk()] });
      const reloaded = makeDiffFile({ hunks: [reloadedHunk()] });
      let applied = false;

      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_file_diff':
            if (applied && opts.emptyAfterApply) {
              // The apply took the file's last change on this side, so the
              // backend has no diff left to return for it.
              throw {
                code: 'COMMAND_ERROR',
                message: `File 'src/main.ts' not found in diff. Staged: ${opts.isStaged ?? false}. Found 0 files: []`,
              };
            }
            return applied ? reloaded : original;
          case 'get_diff_tool':
            return { tool: null };
          case 'read_file_content':
            return 'file content here';
          case 'stage_hunk':
          case 'unstage_hunk':
            if (opts.hunkFails) throw { code: 'COMMAND_ERROR', message: 'patch does not apply' };
            applied = true;
            return null;
          default:
            return null;
        }
      };

      const el = await renderDiffView({ file: makeStatusEntry({ isStaged: opts.isStaged ?? false }) });
      const view = el as unknown as Handlers;
      const loaded = view.diff;
      view.lineSelectionMode = true;
      // The user's own multi-line selection: del-b and add-b.
      view.selectedLines = new Set(['0-2', '0-4']);
      // The objects MUST come from el.diff — the handler locates them by indexOf.
      view.contextMenu = {
        visible: true,
        x: 0,
        y: 0,
        line: loaded.hunks[0].lines[1],
        hunk: loaded.hunks[0],
      };
      await el.updateComplete;
      return el;
    }

    it('clears the selection after a context-menu stage reloads the diff', async () => {
      const el = await viewWithOpenContextMenu();
      await (el as unknown as Handlers).handleContextStageLine();
      await el.updateComplete;

      expect(
        (el as unknown as Handlers).selectedLines.size,
        'a stale positional selection was restored after the diff reloaded',
      ).to.equal(0);
      expect(el.shadowRoot!.querySelector('.selection-actions')).to.be.null;
      expect(el.shadowRoot!.querySelectorAll('.line.selected').length).to.equal(0);
    });

    it('clears the selection after a context-menu unstage reloads the diff', async () => {
      const el = await viewWithOpenContextMenu({ isStaged: true });
      await (el as unknown as Handlers).handleContextUnstageLine();
      await el.updateComplete;

      expect(
        (el as unknown as Handlers).selectedLines.size,
        'a stale positional selection was restored after the diff reloaded',
      ).to.equal(0);
      expect(el.shadowRoot!.querySelector('.selection-actions')).to.be.null;
      expect(el.shadowRoot!.querySelectorAll('.line.selected').length).to.equal(0);
    });

    it('clears the pane when a context-menu stage takes the file\'s last unstaged line', async () => {
      const el = await viewWithOpenContextMenu({ emptyAfterApply: true });
      let cleared = 0;
      el.addEventListener('file-cleared', () => cleared++);

      await (el as unknown as Handlers).handleContextStageLine();
      await el.updateComplete;

      expect(
        el.shadowRoot!.textContent,
        'the backend\'s "not found in diff" text was painted into the pane',
      ).to.not.contain('not found in diff');
      expect(el.file, 'the emptied file stayed bound to the pane').to.be.null;
      expect(cleared, 'file-cleared closes the diff in app-shell').to.equal(1);
    });

    it('clears the pane when a context-menu unstage takes the file\'s last staged line', async () => {
      const el = await viewWithOpenContextMenu({ isStaged: true, emptyAfterApply: true });
      let cleared = 0;
      el.addEventListener('file-cleared', () => cleared++);

      await (el as unknown as Handlers).handleContextUnstageLine();
      await el.updateComplete;

      expect(
        el.shadowRoot!.textContent,
        'the backend\'s "not found in diff" text was painted into the pane',
      ).to.not.contain('not found in diff');
      expect(el.file, 'the emptied file stayed bound to the pane').to.be.null;
      expect(cleared, 'file-cleared closes the diff in app-shell').to.equal(1);
    });

    it('does not let a follow-up Stage Selected act on stale keys', async () => {
      const el = await viewWithOpenContextMenu();
      await (el as unknown as Handlers).handleContextStageLine();
      await el.updateComplete;

      clearHistory();
      await (el as unknown as Handlers).stageSelectedLines();

      expect(
        findCommands('stage_hunk').length,
        'a stale selection let a second stage send a patch built from renumbered keys',
      ).to.equal(0);
    });

    it('keeps the previous selection when the stage fails', async () => {
      const el = await viewWithOpenContextMenu({ hunkFails: true });
      await (el as unknown as Handlers).handleContextStageLine();
      await el.updateComplete;

      // Nothing was applied, so the diff is untouched and the keys still valid.
      expect([...(el as unknown as Handlers).selectedLines]).to.have.members(['0-2', '0-4']);
      expect(findCommands('stage_hunk').length).to.equal(1);
    });

    it('keeps the previous selection when the clicked line produces no patch', async () => {
      const el = await viewWithOpenContextMenu();
      const view = el as unknown as Handlers;
      // A context line yields an empty patch, so nothing is sent or reloaded.
      view.contextMenu = { ...view.contextMenu, line: view.diff.hunks[0].lines[0] };
      await el.updateComplete;

      clearHistory();
      await view.handleContextStageLine();
      await el.updateComplete;

      expect([...view.selectedLines]).to.have.members(['0-2', '0-4']);
      expect(findCommands('stage_hunk').length).to.equal(0);
    });
  });
});
