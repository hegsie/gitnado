/**
 * Tests for gn-conflict-resolution-dialog component
 *
 * Tests conflict file rendering, navigation, resolution tracking,
 * abort/continue flows, keyboard shortcuts, and event dispatching.
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
import '../gn-conflict-resolution-dialog.ts';
import type { GnConflictResolutionDialog } from '../gn-conflict-resolution-dialog.ts';
import type { ConflictFile } from '../../../types/git.types.ts';
import { uiStore } from '../../../stores/ui.store.ts';

// ── Test data ──────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

function makeConflict(path: string): ConflictFile {
  return {
    path,
    ancestor: { oid: 'base123', path, mode: 0o100644 },
    ours: { oid: 'ours123', path, mode: 0o100644 },
    theirs: { oid: 'theirs123', path, mode: 0o100644 },
    isBinary: false,
  };
}

function clearToasts(): void {
  const state = uiStore.getState();
  state.toasts.forEach((t) => state.removeToast(t.id));
}

/** What `continue_rebase` resolves with — see setupDefaultMocks. */
let continueRebaseSkipped: unknown = 0;

const TEST_CONFLICTS: ConflictFile[] = [
  makeConflict('src/main.ts'),
  makeConflict('src/utils.ts'),
  makeConflict('src/app.ts'),
];

// ── Helpers ────────────────────────────────────────────────────────────────
function setupDefaultMocks(conflicts: ConflictFile[] = TEST_CONFLICTS): void {
  mockInvoke = async (command: string) => {
    switch (command) {
      case 'get_conflicts':
        return conflicts;
      case 'get_merge_tool_config':
        return null;
      case 'auto_detect_merge_tool':
        return null;
      case 'abort_merge':
      case 'abort_rebase':
      case 'abort_cherry_pick':
      case 'abort_revert':
        return { success: true };
      // The backend resolves continue_rebase with the number of commits the
      // rebase dropped as already applied upstream — 0 for a clean continue.
      case 'continue_rebase':
        return continueRebaseSkipped;
      case 'continue_cherry_pick':
      case 'continue_revert':
        return { success: true };
      case 'skip_cherry_pick':
      case 'skip_revert':
        return null;
      default:
        return null;
    }
  };
}

async function renderDialog(
  operationType: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'stash' = 'merge'
): Promise<GnConflictResolutionDialog> {
  const el = await fixture<GnConflictResolutionDialog>(html`
    <gn-conflict-resolution-dialog
      .repositoryPath=${REPO_PATH}
      .operationType=${operationType}
    ></gn-conflict-resolution-dialog>
  `);
  return el;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-conflict-resolution-dialog', () => {
  beforeEach(() => {
    invokeHistory.length = 0;
    continueRebaseSkipped = 0;
    setupDefaultMocks();
  });

  // ── Rendering ──────────────────────────────────────────────────────────
  describe('rendering', () => {
    it('renders without errors', async () => {
      const el = await renderDialog();
      expect(el).to.exist;
      expect(el.tagName.toLowerCase()).to.equal('gn-conflict-resolution-dialog');
    });

    it('is hidden when not open', async () => {
      const el = await renderDialog();
      expect(el.open).to.be.false;

      // Should not render any visible content when not open
      const dialog = el.shadowRoot!.querySelector('.dialog');
      expect(dialog).to.be.null;
    });

    it('shows dialog when open is set', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      // Wait for loadConflicts
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const dialog = el.shadowRoot!.querySelector('.dialog');
      expect(dialog).to.exist;
    });

    it('shows correct operation title for merge', async () => {
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const title = el.shadowRoot!.querySelector('.header-title');
      expect(title?.textContent).to.include('Merge');
    });

    it('shows correct operation title for rebase', async () => {
      const el = await renderDialog('rebase');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const title = el.shadowRoot!.querySelector('.header-title');
      expect(title?.textContent).to.include('Rebase');
    });

    it('shows correct operation title for cherry-pick', async () => {
      const el = await renderDialog('cherry-pick');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const title = el.shadowRoot!.querySelector('.header-title');
      expect(title?.textContent).to.include('Cherry-pick');
    });

    it('shows correct operation title for revert', async () => {
      const el = await renderDialog('revert');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const title = el.shadowRoot!.querySelector('.header-title');
      expect(title?.textContent).to.include('Revert');
    });
  });

  // ── Conflict file list ─────────────────────────────────────────────────
  describe('conflict file list', () => {
    it('renders conflict files after loading', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const fileItems = el.shadowRoot!.querySelectorAll('.file-item');
      expect(fileItems.length).to.equal(3);
    });

    it('shows file names from paths', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const fileNames = el.shadowRoot!.querySelectorAll('.file-name');
      const names = Array.from(fileNames).map(n => n.textContent!.replace(/\s+/g, ' ').trim());
      expect(names.some(n => n.startsWith('main.ts'))).to.be.true;
      expect(names.some(n => n.startsWith('utils.ts'))).to.be.true;
      expect(names.some(n => n.startsWith('app.ts'))).to.be.true;
    });

    it('shows the directory hint for files in subdirectories', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const dirs = Array.from(el.shadowRoot!.querySelectorAll('.file-dir')).map(
        n => n.textContent!.trim()
      );
      expect(dirs).to.include('src');
    });

    it('marks first file as selected by default', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const selectedItems = el.shadowRoot!.querySelectorAll('.file-item.selected');
      expect(selectedItems.length).to.equal(1);
    });

    it('shows conflict icon for unresolved files', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const conflictIcons = el.shadowRoot!.querySelectorAll('.file-icon.conflict');
      expect(conflictIcons.length).to.equal(3);
    });

    it('shows resolved count in subtitle', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const subtitle = el.shadowRoot!.querySelector('.header-subtitle');
      expect(subtitle?.textContent).to.include('0 of 3');
    });
  });

  // ── File selection ─────────────────────────────────────────────────────
  describe('file selection', () => {
    it('selects file on click', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const fileItems = el.shadowRoot!.querySelectorAll('.file-item');
      (fileItems[1] as HTMLElement).click();
      await el.updateComplete;

      const internal = el as unknown as { selectedIndex: number };
      expect(internal.selectedIndex).to.equal(1);
    });
  });

  // ── Navigation ─────────────────────────────────────────────────────────
  describe('navigation', () => {
    it('has previous and next buttons', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const navBtns = el.shadowRoot!.querySelectorAll('.nav-btn');
      expect(navBtns.length).to.equal(2);
    });

    it('disables previous button on first file', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const prevBtn = el.shadowRoot!.querySelectorAll('.nav-btn')[0] as HTMLButtonElement;
      expect(prevBtn.disabled).to.be.true;
    });

    it('enables next button when not on last file', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const nextBtn = el.shadowRoot!.querySelectorAll('.nav-btn')[1] as HTMLButtonElement;
      expect(nextBtn.disabled).to.be.false;
    });

    it('navigates to next file', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const nextBtn = el.shadowRoot!.querySelectorAll('.nav-btn')[1] as HTMLButtonElement;
      nextBtn.click();
      await el.updateComplete;

      const internal = el as unknown as { selectedIndex: number };
      expect(internal.selectedIndex).to.equal(1);
    });

    it('navigates to previous file', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      // Navigate to second file first
      const internal = el as unknown as { selectedIndex: number };
      internal.selectedIndex = 2;
      await el.updateComplete;

      const prevBtn = el.shadowRoot!.querySelectorAll('.nav-btn')[0] as HTMLButtonElement;
      prevBtn.click();
      await el.updateComplete;

      expect(internal.selectedIndex).to.equal(1);
    });

    it('does not go below index 0', () => {
      const el = document.createElement('gn-conflict-resolution-dialog') as GnConflictResolutionDialog;
      const internal = el as unknown as {
        selectedIndex: number;
        handlePrevious: () => void;
      };
      internal.selectedIndex = 0;
      internal.handlePrevious();
      expect(internal.selectedIndex).to.equal(0);
    });

    it('stacked Next calls behind one confirm cannot push the selection out of bounds', async () => {
      // Alt+ArrowDown auto-repeat stacks several handleNext calls behind a
      // single unsaved-work confirm; each read the same stale index. Without
      // the post-await bound re-check they drive selectedIndex past the last
      // file and Prev/Next go permanently inert.
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as {
        selectedIndex: number;
        handleNext: () => Promise<void>;
        confirmLeaveInProgress: () => Promise<boolean>;
        selectedConflict: ConflictFile | null;
      };
      internal.selectedIndex = 1; // one below the last file (index 2 of 3)
      const release: Array<(v: boolean) => void> = [];
      internal.confirmLeaveInProgress = () =>
        new Promise<boolean>((res) => release.push(res));

      const p1 = internal.handleNext.call(el);
      const p2 = internal.handleNext.call(el);
      release.forEach((r) => r(true));
      await Promise.all([p1, p2]);

      expect(internal.selectedIndex, 'must stop at the last file').to.equal(2);
      expect(internal.selectedConflict, 'selection must stay valid').to.not.be.null;
    });

    it('stacked Previous calls behind one confirm cannot go below index 0', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as {
        selectedIndex: number;
        handlePrevious: () => Promise<void>;
        confirmLeaveInProgress: () => Promise<boolean>;
        selectedConflict: ConflictFile | null;
      };
      internal.selectedIndex = 1;
      const release: Array<(v: boolean) => void> = [];
      internal.confirmLeaveInProgress = () =>
        new Promise<boolean>((res) => release.push(res));

      const p1 = internal.handlePrevious.call(el);
      const p2 = internal.handlePrevious.call(el);
      release.forEach((r) => r(true));
      await Promise.all([p1, p2]);

      expect(internal.selectedIndex, 'must stop at the first file').to.equal(0);
      expect(internal.selectedConflict).to.not.be.null;
    });

    it('file-select re-validates the index after the confirm await against a shrunken list', async () => {
      // A runContinue reload can replace/shrink this.conflicts while the
      // leave confirm is up; the stacked select must not point past the new
      // array and collapse the editor to "Select a file".
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as {
        selectedIndex: number;
        conflicts: ConflictFile[];
        handleFileSelect: (i: number) => Promise<void>;
        confirmLeaveInProgress: () => Promise<boolean>;
        selectedConflict: ConflictFile | null;
      };
      internal.selectedIndex = 0;
      let release!: (v: boolean) => void;
      internal.confirmLeaveInProgress = () =>
        new Promise<boolean>((res) => { release = res; });

      // Select the last file (index 2 of 3); the confirm is pending.
      const pending = internal.handleFileSelect.call(el, 2);
      // A reload shrinks the list to one file while the confirm is up.
      internal.conflicts = internal.conflicts.slice(0, 1);
      release(true);
      await pending;

      expect(internal.selectedIndex, 'stale index must be rejected').to.equal(0);
      expect(internal.selectedConflict, 'selection stays valid').to.not.be.null;
    });
  });

  // ── Pinned repository visibility ─────────────────────────────────────────
  describe('pinned repository visibility', () => {
    it('names the repository it operates on in the header subtitle', async () => {
      // The dialog stays pinned to the repo the operation started on even
      // when another tab is active — without naming it, the user cannot
      // tell whose merge Complete/Abort will hit.
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const subtitle = el.shadowRoot!.querySelector('.header-subtitle');
      expect(subtitle?.textContent).to.include('· repo');
    });
  });

  // ── Fresh conflict metadata adoption ─────────────────────────────────────
  describe('fresh conflict metadata adoption', () => {
    it('adopts the fresh ConflictFile when the editor tool session ends', async () => {
      // The external tool can change what get_conflicts reports for the
      // file (markerSize, hunks); keeping the stale object would misparse
      // the tool's output on the next load.
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const editor = el.shadowRoot!.querySelector('gn-merge-editor')!;
      const fresh = { ...makeConflict('src/main.ts'), markerSize: 12 };
      editor.dispatchEvent(
        new CustomEvent('external-tool-finished', {
          detail: { filePath: 'src/main.ts', freshConflicts: [fresh] },
          bubbles: true,
          composed: true,
        })
      );
      await el.updateComplete;

      const internal = el as unknown as {
        conflicts: ConflictFile[];
        editorToolActive: boolean;
      };
      expect(internal.editorToolActive).to.be.false;
      expect(internal.conflicts[0].markerSize).to.equal(12);
    });

    it('the dialog launcher adopts the re-fetched ConflictFile for a still-conflicted file', async () => {
      setupDefaultMocks();
      const freshEntry = { ...makeConflict('src/main.ts'), markerSize: 9 };
      let conflictsCalls = 0;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'launch_merge_tool') return { success: true, message: null };
        if (command === 'get_conflicts') {
          conflictsCalls++;
          // First call: dialog open. Later calls: post-tool re-check.
          return conflictsCalls === 1 ? TEST_CONFLICTS : [freshEntry];
        }
        return baseMock(command, args);
      };
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as {
        conflicts: ConflictFile[];
        handleOpenExternalTool: (path: string) => Promise<void>;
      };
      await internal.handleOpenExternalTool.call(el, 'src/main.ts');
      await el.updateComplete;

      expect(internal.conflicts[0].markerSize, 'fresh metadata adopted').to.equal(9);
      clearToasts();
    });
  });

  // ── Conflict resolution tracking ───────────────────────────────────────
  describe('resolution tracking', () => {
    it('tracks resolved files', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      // Simulate conflict resolution
      const internal = el as unknown as { resolvedFiles: Set<string> };
      internal.resolvedFiles = new Set(['src/main.ts']);
      el.requestUpdate();
      await el.updateComplete;

      const resolvedIcons = el.shadowRoot!.querySelectorAll('.file-icon.resolved');
      expect(resolvedIcons.length).to.equal(1);
    });

    it('updates resolved count after resolution', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as { resolvedFiles: Set<string> };
      internal.resolvedFiles = new Set(['src/main.ts', 'src/utils.ts']);
      el.requestUpdate();
      await el.updateComplete;

      const subtitle = el.shadowRoot!.querySelector('.header-subtitle');
      expect(subtitle?.textContent).to.include('2 of 3');
    });

    it('handles conflict-resolved event by adding to resolved set', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const handleConflictResolved = (el as unknown as {
        handleConflictResolved: (e: CustomEvent) => void;
      }).handleConflictResolved.bind(el);

      handleConflictResolved(
        new CustomEvent('conflict-resolved', {
          detail: { file: makeConflict('src/main.ts') },
        })
      );
      await el.updateComplete;

      const internal = el as unknown as { resolvedFiles: Set<string> };
      expect(internal.resolvedFiles.has('src/main.ts')).to.be.true;
    });

    it('auto-advances to next unresolved file after resolution', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      // Mark first file as selected, resolve it
      const internal = el as unknown as {
        selectedIndex: number;
        resolvedFiles: Set<string>;
      };
      internal.selectedIndex = 0;

      const handleConflictResolved = (el as unknown as {
        handleConflictResolved: (e: CustomEvent) => void;
      }).handleConflictResolved.bind(el);

      // Also mark second as resolved to test it advances past it
      internal.resolvedFiles = new Set(['src/utils.ts']);
      el.requestUpdate();

      handleConflictResolved(
        new CustomEvent('conflict-resolved', {
          detail: { file: makeConflict('src/main.ts') },
        })
      );

      // Should advance to index 2 (src/app.ts), skipping resolved src/utils.ts
      expect(internal.selectedIndex).to.equal(2);
    });

    it('does not yank selection when a mid-flight resolution lands for another file', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as {
        selectedIndex: number;
        resolvedFiles: Set<string>;
      };
      // User clicked Mark Resolved on main.ts (index 0), then switched to
      // utils.ts (index 1) and is working there when the call completes.
      internal.selectedIndex = 1;

      const handleConflictResolved = (el as unknown as {
        handleConflictResolved: (e: CustomEvent) => void;
      }).handleConflictResolved.bind(el);

      handleConflictResolved(
        new CustomEvent('conflict-resolved', {
          detail: { file: makeConflict('src/main.ts') },
        })
      );

      // main.ts is marked resolved but the selection stays on the file the
      // user is actively editing.
      expect(internal.resolvedFiles.has('src/main.ts')).to.be.true;
      expect(internal.selectedIndex).to.equal(1);
    });

    it('refreshes the embedded editor when the external tool resolves the selected file', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as {
        selectedIndex: number;
        conflicts: ConflictFile[];
        resolvedFiles: Set<string>;
        handleOpenExternalTool: (path: string) => Promise<void>;
      };
      const before = internal.conflicts[0];
      expect(internal.selectedIndex).to.equal(0);

      mockInvoke = async (command: string) => {
        if (command === 'launch_merge_tool') return { success: true };
        // After the tool, the file is no longer conflicted.
        if (command === 'get_conflicts') return TEST_CONFLICTS.slice(1);
        return null;
      };

      await internal.handleOpenExternalTool.call(el, 'src/main.ts');
      await el.updateComplete;

      // The conflict object identity changed (forcing the editor to reload
      // the tool's output instead of a stale parse), the file is resolved,
      // and selection advanced off it.
      expect(internal.conflicts[0]).to.not.equal(before);
      expect(internal.resolvedFiles.has('src/main.ts')).to.be.true;
      expect(internal.selectedIndex).to.equal(1);
    });

    it('confirms before a file switch that would discard in-progress picks', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as {
        selectedIndex: number;
        handleFileSelect: (index: number) => Promise<void>;
      };
      // Give the embedded editor unsaved in-memory picks.
      const editor = el.shadowRoot!.querySelector('gn-merge-editor') as unknown as {
        segments: Array<Record<string, unknown>>;
        userTouched: boolean;
        updateComplete: Promise<boolean>;
      };
      editor.segments = [
        { id: 1, type: 'resolved', lines: ['picked'], oursLines: ['a'], theirsLines: ['b'], oursLabel: '', theirsLabel: '', origin: 'ours', fromConflict: true },
      ];
      editor.userTouched = true;
      await editor.updateComplete;

      // Confirm declined → the switch is cancelled and the picks survive.
      let confirmCalls = 0;
      const prevMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'plugin:dialog|message') {
          confirmCalls++;
          return false;
        }
        return prevMock(command, args);
      };
      await internal.handleFileSelect.call(el, 2);
      expect(confirmCalls).to.be.greaterThan(0);
      expect(internal.selectedIndex).to.equal(0);

      // Confirm accepted → the switch proceeds. (The plugin maps the native
      // dialog's button label: 'Ok' means confirmed.)
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'plugin:dialog|message') return 'Ok';
        return prevMock(command, args);
      };
      await internal.handleFileSelect.call(el, 2);
      expect(internal.selectedIndex).to.equal(2);
    });

    it('wraps around to earlier unresolved files after resolving the last one', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as {
        selectedIndex: number;
        resolvedFiles: Set<string>;
      };
      // User skipped ahead and resolved the LAST file first; the earlier
      // files (index 0, 1) are still unresolved and must be reachable.
      internal.selectedIndex = 2;

      const handleConflictResolved = (el as unknown as {
        handleConflictResolved: (e: CustomEvent) => void;
      }).handleConflictResolved.bind(el);

      handleConflictResolved(
        new CustomEvent('conflict-resolved', {
          detail: { file: makeConflict('src/app.ts') },
        })
      );

      expect(internal.selectedIndex).to.equal(0);
    });
  });

  // ── Abort flow ─────────────────────────────────────────────────────────
  describe('abort flow', () => {
    it('shows abort confirmation dialog', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      // Click abort
      const abortBtn = el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement;
      abortBtn.click();
      await el.updateComplete;

      const confirmOverlay = el.shadowRoot!.querySelector('.confirm-overlay');
      expect(confirmOverlay).to.exist;
    });

    it('can cancel the abort confirmation', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as { showAbortConfirm: boolean };
      internal.showAbortConfirm = true;
      await el.updateComplete;

      // Click cancel in confirmation
      const cancelBtn = el.shadowRoot!.querySelector('.confirm-overlay .btn:not(.btn-danger)') as HTMLButtonElement;
      cancelBtn.click();
      await el.updateComplete;

      expect(internal.showAbortConfirm).to.be.false;
    });

    it('dispatches operation-aborted on successful abort', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      let abortedFired = false;
      el.addEventListener('operation-aborted', () => { abortedFired = true; });

      // Trigger abort confirm
      const internal = el as unknown as {
        showAbortConfirm: boolean;
        aborting: boolean;
      };
      internal.showAbortConfirm = true;
      await el.updateComplete;

      const confirmAbortBtn = el.shadowRoot!.querySelector('.confirm-overlay .btn-danger') as HTMLButtonElement;
      confirmAbortBtn.click();
      await new Promise(r => setTimeout(r, 100));

      expect(abortedFired).to.be.true;
    });

    it('calls abort_merge for merge type', async () => {
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      invokeHistory.length = 0;

      const handleAbortConfirm = (el as unknown as {
        handleAbortConfirm: () => Promise<void>;
      }).handleAbortConfirm.bind(el);

      await handleAbortConfirm();

      const abortCall = invokeHistory.find(h => h.command === 'abort_merge');
      expect(abortCall).to.exist;
    });

    it('calls abort_rebase for rebase type', async () => {
      const el = await renderDialog('rebase');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      invokeHistory.length = 0;

      const handleAbortConfirm = (el as unknown as {
        handleAbortConfirm: () => Promise<void>;
      }).handleAbortConfirm.bind(el);

      await handleAbortConfirm();

      const abortCall = invokeHistory.find(h => h.command === 'abort_rebase');
      expect(abortCall).to.exist;
    });
  });

  // ── Continue flow ──────────────────────────────────────────────────────
  describe('continue flow', () => {
    it('disables continue button when not all resolved', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const continueBtn = el.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement;
      expect(continueBtn.disabled).to.be.true;
    });

    it('enables continue button when all resolved', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as { resolvedFiles: Set<string> };
      internal.resolvedFiles = new Set(['src/main.ts', 'src/utils.ts', 'src/app.ts']);
      el.requestUpdate();
      await el.updateComplete;

      const continueBtn = el.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement;
      expect(continueBtn.disabled).to.be.false;
    });

    it('Complete confirms when the editor holds unsaved rework', async () => {
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as {
        resolvedFiles: Set<string>;
        conflicts: ConflictFile[];
        handleContinue: () => Promise<void>;
      };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));

      // The selected file was Mark-Resolved earlier, then reworked: an
      // unsaved pick sits on screen. Complete must not silently commit the
      // older on-disk content.
      const editor = el.shadowRoot!.querySelector('gn-merge-editor')!;
      const editorInternal = editor as unknown as {
        segments: Array<Record<string, unknown>>;
        userTouched: boolean;
      };
      editorInternal.segments = [
        {
          id: 1,
          type: 'resolved',
          lines: ['rework'],
          oursLines: [],
          theirsLines: [],
          oursLabel: '',
          theirsLabel: '',
          origin: 'ours',
          fromConflict: true,
        },
      ];
      editorInternal.userTouched = true;

      let confirmAnswer: unknown = false;
      let confirmCalls = 0;
      let completedFired = false;
      el.addEventListener('operation-completed', () => {
        completedFired = true;
      });
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'plugin:dialog|message') {
          confirmCalls++;
          return confirmAnswer;
        }
        return baseMock(command, args);
      };

      // Declined: nothing commits, the dialog stays open with the rework.
      await internal.handleContinue.call(el);
      expect(confirmCalls).to.equal(1);
      expect(completedFired).to.be.false;

      // Accepted: the continue proceeds normally.
      confirmAnswer = 'Ok';
      await internal.handleContinue.call(el);
      expect(completedFired).to.be.true;
    });

    // A rebase that paused on a conflict finishes HERE, not in rebase(). Every
    // commit it drops as already-applied — before the pause and after it —
    // disappears from the branch, and this toast is the only place the user can
    // find out. The four direct-rebase toasts already say so.
    it('names the commits a continued rebase dropped', async () => {
      const el = await renderDialog('rebase');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as {
        resolvedFiles: Set<string>;
        conflicts: ConflictFile[];
        handleContinue: () => Promise<void>;
      };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));

      continueRebaseSkipped = 2;
      clearToasts();
      await internal.handleContinue.call(el);

      const success = uiStore.getState().toasts.find(t => t.type === 'success');
      expect(success?.message).to.equal(
        'Rebase completed, skipped 2 commit(s) already applied upstream'
      );
    });

    it('keeps the plain completion when a continued rebase dropped nothing', async () => {
      const el = await renderDialog('rebase');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as {
        resolvedFiles: Set<string>;
        conflicts: ConflictFile[];
        handleContinue: () => Promise<void>;
      };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));

      continueRebaseSkipped = 0;
      clearToasts();
      await internal.handleContinue.call(el);

      const success = uiStore.getState().toasts.find(t => t.type === 'success');
      expect(success?.message).to.equal('Rebase completed');
    });

    // The other operations share this toast and have no such count; an
    // undefined `data` must never render as "skipped undefined".
    it('leaves a merge completion untouched', async () => {
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as {
        resolvedFiles: Set<string>;
        conflicts: ConflictFile[];
        handleContinue: () => Promise<void>;
      };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));

      clearToasts();
      await internal.handleContinue.call(el);

      const success = uiStore.getState().toasts.find(t => t.type === 'success');
      expect(success?.message).to.equal('Merge completed');
    });

    it('dispatches operation-completed on successful continue', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as { resolvedFiles: Set<string>; conflicts: ConflictFile[] };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));

      let completedFired = false;
      el.addEventListener('operation-completed', () => { completedFired = true; });

      const handleContinue = (el as unknown as {
        handleContinue: () => Promise<void>;
      }).handleContinue.bind(el);

      await handleContinue();

      expect(completedFired).to.be.true;
    });

    it('shows merge-specific button text', async () => {
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const continueBtn = el.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement;
      expect(continueBtn.textContent!.trim()).to.include('Complete Merge');
    });

    it('shows rebase-specific button text', async () => {
      const el = await renderDialog('rebase');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const continueBtn = el.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement;
      expect(continueBtn.textContent!.trim()).to.include('Continue Rebase');
    });
  });

  // ── Computed properties ────────────────────────────────────────────────
  describe('computed properties', () => {
    it('selectedConflict returns correct file', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      const internal = el as unknown as {
        selectedIndex: number;
        selectedConflict: ConflictFile | null;
      };
      internal.selectedIndex = 1;

      expect(internal.selectedConflict?.path).to.equal('src/utils.ts');
    });

    it('resolvedCount returns correct value', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      const internal = el as unknown as {
        resolvedFiles: Set<string>;
        resolvedCount: number;
      };
      internal.resolvedFiles = new Set(['src/main.ts', 'src/utils.ts']);

      expect(internal.resolvedCount).to.equal(2);
    });

    it('totalCount returns number of conflicts', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      const internal = el as unknown as { totalCount: number };
      expect(internal.totalCount).to.equal(3);
    });
  });

  // ── Empty state ────────────────────────────────────────────────────────
  describe('empty state', () => {
    it('shows empty state when no conflicts', async () => {
      setupDefaultMocks([]);
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const emptyState = el.shadowRoot!.querySelector('.empty-state');
      expect(emptyState).to.exist;
      expect(emptyState!.textContent).to.include('No conflicts');
    });
  });

  // ── Open/close behavior ─────────────────────────────────────────────────
  describe('open/close', () => {
    it('resets state and loads conflicts once when opened', async () => {
      const el = await renderDialog();
      invokeHistory.length = 0;

      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      expect(el.open).to.be.true;
      const internal = el as unknown as { selectedIndex: number };
      expect(internal.selectedIndex).to.equal(0);
      // The open transition must trigger exactly one conflicts load — a
      // second load would race the first.
      const loads = invokeHistory.filter(h => h.command === 'get_conflicts');
      expect(loads.length).to.equal(1);
    });

    it('preselects the file the user clicked to enter the flow', async () => {
      const el = await renderDialog();
      el.initialFilePath = 'src/app.ts';
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as { selectedIndex: number };
      // TEST_CONFLICTS order: main.ts (0), utils.ts (1), app.ts (2)
      expect(internal.selectedIndex).to.equal(2);
      const selected = el.shadowRoot!.querySelector('.file-item.selected');
      expect(selected!.textContent).to.include('app.ts');
    });

    it('uses honest non-stash wording when the stash source is only inferred', async () => {
      const el = await renderDialog('stash');
      el.stashSourceCertain = false;
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      // Open the abort confirm and check its message doesn't promise the
      // changes are safe in a stash entry that may not exist.
      const abortBtn = el.shadowRoot!.querySelector('.footer-actions .btn-danger') as HTMLElement;
      abortBtn.click();
      await el.updateComplete;

      const msg = el.shadowRoot!.querySelector('.confirm-message')!;
      expect(msg.textContent).to.include('not saved anywhere else');
      expect(msg.textContent).to.not.include('remains in the stash list');
    });

    it('keeps the reassuring stash wording when the stash source is known', async () => {
      const el = await renderDialog('stash');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const abortBtn = el.shadowRoot!.querySelector('.footer-actions .btn-danger') as HTMLElement;
      abortBtn.click();
      await el.updateComplete;

      const msg = el.shadowRoot!.querySelector('.confirm-message')!;
      expect(msg.textContent).to.include('remains in the stash list');
    });

    it('falls back to the first conflict when the clicked file is not conflicted', async () => {
      const el = await renderDialog();
      el.initialFilePath = 'src/not-conflicted.ts';
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      const internal = el as unknown as { selectedIndex: number };
      expect(internal.selectedIndex).to.equal(0);
    });

    it('cleans up state on close', async () => {
      const el = await renderDialog();
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      const close = (el as unknown as { close: () => void }).close.bind(el);
      close();

      expect(el.open).to.be.false;
      const internal = el as unknown as { conflicts: ConflictFile[] };
      expect(internal.conflicts.length).to.equal(0);
    });
  });

  // ── Continue re-entry guard ──────────────────────────────────────────────
  describe('continue re-entry guard', () => {
    it('a double-click on Complete drops the stash only once', async () => {
      const el = await renderDialog('stash');
      el.dropStashOnComplete = true;
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as {
        resolvedFiles: Set<string>;
        conflicts: ConflictFile[];
        handleContinue: () => Promise<void>;
      };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));
      await el.updateComplete;

      let dropCalls = 0;
      mockInvoke = async (command: string) => {
        if (command === 'get_conflicts') return TEST_CONFLICTS;
        if (command === 'get_stashes')
          return [{ index: 0, message: 'popped', oid: 'oid-drop-me' }];
        if (command === 'drop_stash') {
          dropCalls++;
          // Slow backend call — the second click arrives while this awaits.
          await new Promise(r => setTimeout(r, 30));
          return null;
        }
        return null;
      };
      // Identity captured at open (drops are identity-verified, never blind).
      (el as unknown as { stashOidToDrop: string | null }).stashOidToDrop = 'oid-drop-me';

      // Double-click: both invocations start before the first completes. A
      // second dropStash would delete an UNRELATED entry after indices shift.
      const first = internal.handleContinue.call(el);
      const second = internal.handleContinue.call(el);
      await Promise.all([first, second]);

      expect(dropCalls).to.equal(1);
    });

    it('a double-click on Complete with unsaved rework shows only ONE confirm', async () => {
      // The Complete claim is taken BEFORE the unsaved-rework confirm await,
      // so a fast second click is swallowed by the entry guard rather than
      // stacking a second confirm dialog.
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as {
        resolvedFiles: Set<string>;
        conflicts: ConflictFile[];
        handleContinue: () => Promise<void>;
      };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));
      await el.updateComplete;

      const editor = el.shadowRoot!.querySelector('gn-merge-editor') as unknown as {
        hasUnsavedResolutions: () => boolean;
      };
      expect(editor, 'the embedded editor is present').to.exist;
      editor.hasUnsavedResolutions = () => true;

      let confirmCalls = 0;
      let releaseConfirm: (() => void) | null = null;
      mockInvoke = async (command: string) => {
        if (command === 'get_conflicts') return TEST_CONFLICTS;
        if (command === 'plugin:dialog|message') {
          confirmCalls++;
          return new Promise((res) => { releaseConfirm = () => res(false); });
        }
        return { success: true };
      };

      const first = internal.handleContinue.call(el);
      const second = internal.handleContinue.call(el);
      await new Promise(r => setTimeout(r, 30));
      expect(confirmCalls, 'only one confirm may be shown').to.equal(1);
      releaseConfirm!();
      await Promise.all([first, second]);
    });

    it('blocks Abort while Complete is running (and vice versa)', async () => {
      const el = await renderDialog('stash');
      el.dropStashOnComplete = true;
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as {
        resolvedFiles: Set<string>;
        conflicts: ConflictFile[];
        showAbortConfirm: boolean;
        handleContinue: () => Promise<void>;
        handleAbort: () => void;
      };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));
      await el.updateComplete;

      let release: (() => void) | null = null;
      mockInvoke = async (command: string) => {
        if (command === 'get_conflicts') return TEST_CONFLICTS;
        if (command === 'get_stashes')
          return [{ index: 0, message: 'popped', oid: 'oid-drop-me' }];
        if (command === 'drop_stash') {
          await new Promise<void>(r => { release = r; });
          return null;
        }
        return null;
      };
      (el as unknown as { stashOidToDrop: string | null }).stashOidToDrop = 'oid-drop-me';

      const completing = internal.handleContinue.call(el);
      await el.updateComplete;
      // The identity verification awaits getStashes before dropping — poll
      // until the drop call is actually in flight.
      for (let i = 0; i < 50 && !release; i++) {
        await new Promise(r => setTimeout(r, 10));
      }

      // While Complete awaits the backend, Abort must be inert — aborting now
      // would revert the files AND lose the stash entry, with a false toast.
      const abortBtn = el.shadowRoot!.querySelector(
        '.footer-actions .btn-danger'
      ) as HTMLButtonElement;
      expect(abortBtn.disabled).to.be.true;
      internal.handleAbort.call(el);
      expect(internal.showAbortConfirm).to.be.false;

      release!();
      await completing;
    });

    it('blocks Abort and Complete while the external merge tool is open', async () => {
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as {
        launchingExternalTool: string | null;
        showAbortConfirm: boolean;
        handleAbort: () => void;
      };
      // Simulate an external tool session in flight (launchMergeTool blocks
      // until the tool exits).
      internal.launchingExternalTool = 'src/main.ts';
      await el.updateComplete;

      const abortBtn = el.shadowRoot!.querySelector(
        '.footer-actions .btn-danger'
      ) as HTMLButtonElement;
      const continueBtn = el.shadowRoot!.querySelector(
        '.footer-actions .btn-primary'
      ) as HTMLButtonElement;
      expect(abortBtn.disabled).to.be.true;
      expect(continueBtn.disabled).to.be.true;

      // Aborting under an open tool would let its later save re-dirty the
      // just-aborted working tree.
      internal.handleAbort.call(el);
      expect(internal.showAbortConfirm).to.be.false;
    });

    it("blocks Abort and Complete while the EDITOR's external tool is open", async () => {
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      // The embedded merge editor announces its tool session with an event.
      const editor = el.shadowRoot!.querySelector('gn-merge-editor')!;
      editor.dispatchEvent(
        new CustomEvent('external-tool-started', { bubbles: true, composed: true })
      );
      await el.updateComplete;

      const internal = el as unknown as {
        showAbortConfirm: boolean;
        handleAbort: () => void;
      };
      const abortBtn = el.shadowRoot!.querySelector(
        '.footer-actions .btn-danger'
      ) as HTMLButtonElement;
      const continueBtn = el.shadowRoot!.querySelector(
        '.footer-actions .btn-primary'
      ) as HTMLButtonElement;
      expect(abortBtn.disabled).to.be.true;
      expect(continueBtn.disabled).to.be.true;
      internal.handleAbort.call(el);
      expect(internal.showAbortConfirm).to.be.false;

      // The lock releases when the tool session ends.
      editor.dispatchEvent(
        new CustomEvent('external-tool-finished', { bubbles: true, composed: true })
      );
      await el.updateComplete;
      expect(abortBtn.disabled).to.be.false;
    });

    it("footer buttons disable while the editor's resolve write is in flight", async () => {
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const editor = el.shadowRoot!.querySelector('gn-merge-editor')!;
      editor.dispatchEvent(
        new CustomEvent('resolve-started', { bubbles: true, composed: true })
      );
      await el.updateComplete;

      const abortBtn = el.shadowRoot!.querySelector(
        '.footer-actions .btn-danger'
      ) as HTMLButtonElement;
      const continueBtn = el.shadowRoot!.querySelector(
        '.footer-actions .btn-primary'
      ) as HTMLButtonElement;
      expect(abortBtn.disabled).to.be.true;
      expect(continueBtn.disabled).to.be.true;

      editor.dispatchEvent(
        new CustomEvent('resolve-finished', { bubbles: true, composed: true })
      );
      await el.updateComplete;
      expect(abortBtn.disabled).to.be.false;
    });

    it('overlapping resolve writes keep the guards held until the LAST one finishes', async () => {
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      // Two writes can be in flight at once by design: a file switch resets
      // the editor's own flag so the new file can resolve while the old
      // file's write drains. Each write dispatches its own started/finished
      // pair — the first finish must NOT unlock Abort/Complete.
      const editor = el.shadowRoot!.querySelector('gn-merge-editor')!;
      const fire = (name: string) =>
        editor.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
      fire('resolve-started');
      fire('resolve-started');
      fire('resolve-finished');
      await el.updateComplete;

      const abortBtn = el.shadowRoot!.querySelector(
        '.footer-actions .btn-danger'
      ) as HTMLButtonElement;
      expect(
        abortBtn.disabled,
        'the first finish must not unlock while a second write is in flight'
      ).to.be.true;
      const internal = el as unknown as { showAbortConfirm: boolean; handleAbort: () => void };
      internal.handleAbort.call(el);
      expect(internal.showAbortConfirm).to.be.false;

      fire('resolve-finished');
      await el.updateComplete;
      expect(abortBtn.disabled).to.be.false;

      // A stray extra finish must not underflow into a negative depth that
      // a later started could no-op against.
      fire('resolve-finished');
      fire('resolve-started');
      await el.updateComplete;
      expect(abortBtn.disabled, 'depth must floor at zero').to.be.true;
      fire('resolve-finished');
      await el.updateComplete;
      expect(abortBtn.disabled).to.be.false;
    });

    it('file navigation is blocked while a resolve write is in flight', async () => {
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      // Navigating away mid-write and back lets a SECOND write start against
      // the same file — two overlapping writes, last-to-land wins silently.
      const editor = el.shadowRoot!.querySelector('gn-merge-editor')!;
      editor.dispatchEvent(
        new CustomEvent('resolve-started', { bubbles: true, composed: true })
      );
      await el.updateComplete;

      const internal = el as unknown as {
        selectedIndex: number;
        handleFileSelect: (i: number) => Promise<void>;
        handleNext: () => Promise<void>;
      };
      expect(internal.selectedIndex).to.equal(0);
      await internal.handleFileSelect.call(el, 1);
      expect(internal.selectedIndex, 'file-list click must be inert mid-write').to.equal(0);
      await internal.handleNext.call(el);
      expect(internal.selectedIndex, 'Next must be inert mid-write').to.equal(0);

      const nextBtn = Array.from(el.shadowRoot!.querySelectorAll('.nav-btn')).find(
        (b) => b.textContent?.includes('Next')
      ) as HTMLButtonElement;
      expect(nextBtn.disabled, 'Next renders disabled mid-write').to.be.true;

      editor.dispatchEvent(
        new CustomEvent('resolve-finished', { bubbles: true, composed: true })
      );
      await el.updateComplete;
      await internal.handleNext.call(el);
      expect(internal.selectedIndex, 'navigation works again after the write').to.equal(1);
    });

    it('a double-click on External during the confirm window launches one tool session', async () => {
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      let confirmCalls = 0;
      let launchCalls = 0;
      let releaseConfirm: (() => void) | null = null;
      let confirmMessage = '';
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'plugin:dialog|message') {
          confirmCalls++;
          confirmMessage = String((args as { message?: unknown })?.message ?? '');
          return new Promise(res => {
            releaseConfirm = () => res('Ok');
          });
        }
        if (command === 'launch_merge_tool') {
          launchCalls++;
          return { success: true };
        }
        if (command === 'get_conflicts') return TEST_CONFLICTS;
        return null;
      };

      // The selected file has unsaved picks, so launching on it confirms.
      const editor = el.shadowRoot!.querySelector('gn-merge-editor')!;
      const editorInternal = editor as unknown as {
        segments: Array<Record<string, unknown>>;
        userTouched: boolean;
      };
      editorInternal.segments = [
        {
          id: 1,
          type: 'resolved',
          lines: ['x'],
          oursLines: [],
          theirsLines: [],
          oursLabel: '',
          theirsLabel: '',
          origin: 'ours',
          fromConflict: true,
        },
      ];
      editorInternal.userTouched = true;

      const internal = el as unknown as {
        selectedConflict: ConflictFile | null;
        handleOpenExternalTool: (path: string) => Promise<void>;
      };
      const selectedPath = internal.selectedConflict!.path;
      const first = internal.handleOpenExternalTool.call(el, selectedPath);
      const second = internal.handleOpenExternalTool.call(el, selectedPath);
      await new Promise(r => setTimeout(r, 30));
      expect(confirmCalls, 'only one confirm may be shown').to.equal(1);
      expect(
        confirmMessage,
        'the confirm must use tool wording, not the file-switch copy'
      ).to.include('external tool works on the file as saved on disk');
      releaseConfirm!();
      await Promise.all([first, second]);
      await new Promise(r => setTimeout(r, 30));
      expect(launchCalls, 'only one tool session may launch').to.equal(1);
    });

    it('the two tool launchers are mutually exclusive in both directions', async () => {
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as {
        launchingExternalTool: string | null;
        editorToolActive: boolean;
        hasMergeTool: boolean;
      };
      internal.hasMergeTool = true;

      // Dialog tool session open → the editor's launcher must be locked.
      internal.launchingExternalTool = 'src/main.ts';
      await el.updateComplete;
      const editor = el.shadowRoot!.querySelector('gn-merge-editor') as HTMLElement & {
        externalToolLocked: boolean;
      };
      expect(editor.externalToolLocked).to.be.true;
      internal.launchingExternalTool = null;

      // Editor tool session open → the dialog's file-list launchers must
      // render disabled, matching their handler guard.
      internal.editorToolActive = true;
      await el.updateComplete;
      const fileToolBtns = el.shadowRoot!.querySelectorAll('.file-item button');
      for (const btn of Array.from(fileToolBtns)) {
        expect((btn as HTMLButtonElement).disabled).to.be.true;
      }
    });
  });

  // ── Merge completion ─────────────────────────────────────────────────────
  describe('merge completion', () => {
    beforeEach(() => clearToasts());

    it('calls commit_merge and completes only on success', async () => {
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      const internal = el as unknown as { resolvedFiles: Set<string>; conflicts: ConflictFile[] };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));

      let completedFired = false;
      el.addEventListener('operation-completed', () => { completedFired = true; });

      invokeHistory.length = 0;
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      expect(invokeHistory.some(h => h.command === 'commit_merge')).to.be.true;
      expect(completedFired).to.be.true;
      expect(el.open).to.be.false;
    });

    it('stays open and shows error when commit_merge fails without new conflicts', async () => {
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      const internal = el as unknown as { resolvedFiles: Set<string>; conflicts: ConflictFile[] };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));

      // commit_merge fails with a non-conflict error; reload finds no conflicts.
      mockInvoke = async (command: string) => {
        if (command === 'commit_merge') throw { code: 'COMMAND_ERROR', message: 'index locked' };
        if (command === 'get_conflicts') return TEST_CONFLICTS;
        return null;
      };

      let completedFired = false;
      el.addEventListener('operation-completed', () => { completedFired = true; });

      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      expect(completedFired).to.be.false;
      expect(el.open).to.be.true;
      const errorToast = uiStore.getState().toasts.find(t => t.type === 'error');
      expect(errorToast, 'error toast shown').to.not.be.undefined;
      expect(errorToast!.message).to.contain('index locked');
    });
  });

  // ── Failed continue with no new conflicts ──────────────────────────────────
  describe('failed continue keeps dialog open', () => {
    beforeEach(() => clearToasts());

    it('rebase: failed continue with no new conflicts stays open + error toast', async () => {
      const el = await renderDialog('rebase');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      const internal = el as unknown as { resolvedFiles: Set<string>; conflicts: ConflictFile[] };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));

      mockInvoke = async (command: string) => {
        if (command === 'continue_rebase') throw { code: 'COMMAND_ERROR', message: 'patch failed' };
        if (command === 'get_conflicts') return []; // no new conflicts
        return null;
      };

      let completedFired = false;
      el.addEventListener('operation-completed', () => { completedFired = true; });

      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      expect(completedFired).to.be.false;
      expect(el.open).to.be.true;
      const errorToast = uiStore.getState().toasts.find(t => t.type === 'error');
      expect(errorToast, 'error toast shown').to.not.be.undefined;
      expect(errorToast!.message).to.contain('patch failed');
    });
  });

  // ── Abort failure feedback ─────────────────────────────────────────────────
  describe('abort failure feedback', () => {
    beforeEach(() => clearToasts());

    it('shows an error toast and allows retry when abort fails', async () => {
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      mockInvoke = async (command: string) => {
        if (command === 'abort_merge') throw { code: 'COMMAND_ERROR', message: 'cannot abort' };
        if (command === 'get_conflicts') return TEST_CONFLICTS;
        return null;
      };

      let abortedFired = false;
      el.addEventListener('operation-aborted', () => { abortedFired = true; });

      await (el as unknown as { handleAbortConfirm: () => Promise<void> }).handleAbortConfirm.bind(el)();

      expect(abortedFired).to.be.false;
      const internal = el as unknown as { aborting: boolean };
      expect(internal.aborting).to.be.false; // retry allowed
      const errorToast = uiStore.getState().toasts.find(t => t.type === 'error');
      expect(errorToast, 'error toast shown').to.not.be.undefined;
    });

    it('closes the dialog (not a dead-end) when the operation was concluded outside the app', async () => {
      // The user ran `git merge --abort` in a terminal, so the backend abort
      // reports the operation no longer exists. Escape is suppressed and
      // Complete may be disabled, so the dialog must recognize this and
      // close rather than trap the user.
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      mockInvoke = async (command: string) => {
        if (command === 'abort_merge')
          throw { code: 'COMMAND_ERROR', message: 'There is no merge to abort (MERGE_HEAD missing).' };
        if (command === 'get_conflicts') return TEST_CONFLICTS;
        return null;
      };

      let abortedFired = false;
      el.addEventListener('operation-aborted', () => { abortedFired = true; });

      await (el as unknown as { handleAbortConfirm: () => Promise<void> }).handleAbortConfirm.bind(el)();

      expect(abortedFired, 'operation-aborted dispatched so the host cleans up').to.be.true;
      expect(el.open, 'dialog closed instead of trapping the user').to.be.false;
      const warn = uiStore.getState().toasts.find(t => t.type === 'warning');
      expect(warn?.message).to.contain('concluded outside the app');
    });
  });

  // ── Skip flow ──────────────────────────────────────────────────────────
  // The backend's empty-pick error tells the user to "Skip or abort"; these pin
  // the Skip half, which keeps already-applied picks instead of rewinding them.
  describe('skip flow', () => {
    beforeEach(() => {
      clearToasts();
      // Skip is behind showConfirm() -> plugin-dialog's confirm(), which
      // resolves to `result === okLabel`. Accept by default so these tests
      // exercise the skip itself; the decline case overrides this.
      const base = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) =>
        command === 'plugin:dialog|message' ? 'Ok' : base(command, args);
    });

    async function openDialog(
      operationType: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'stash'
    ): Promise<GnConflictResolutionDialog> {
      const el = await renderDialog(operationType);
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;
      return el;
    }

    function skipButton(el: GnConflictResolutionDialog): HTMLButtonElement | null {
      const buttons = Array.from(
        el.shadowRoot!.querySelectorAll('.footer-actions .btn')
      ) as HTMLButtonElement[];
      return buttons.find(b => /^Skip/.test(b.textContent!.trim())) ?? null;
    }

    it('renders Skip only for cherry-pick and revert', async () => {
      for (const type of ['cherry-pick', 'revert'] as const) {
        const el = await openDialog(type);
        expect(skipButton(el), `Skip offered for ${type}`).to.not.be.null;
      }
      for (const type of ['merge', 'rebase', 'stash'] as const) {
        const el = await openDialog(type);
        expect(skipButton(el), `no Skip for ${type} — no backend skip`).to.be.null;
      }
    });

    it('Skip invokes skip_cherry_pick and closes with a success toast', async () => {
      const el = await openDialog('cherry-pick');
      let completedFired = false;
      el.addEventListener('operation-completed', () => { completedFired = true; });

      invokeHistory.length = 0;
      skipButton(el)!.click();
      await new Promise(r => setTimeout(r, 50));
      await el.updateComplete;

      const call = invokeHistory.find(c => c.command === 'skip_cherry_pick');
      expect(call, 'skip_cherry_pick invoked').to.not.be.undefined;
      expect(call!.args).to.deep.equal({ path: REPO_PATH });
      expect(completedFired, 'operation-completed dispatched').to.be.true;
      expect(el.open, 'dialog closed').to.be.false;
      const success = uiStore.getState().toasts.find(t => t.type === 'success');
      expect(success?.message).to.contain('Skipped');
    });

    it('Skip uses skip_revert for a revert', async () => {
      const el = await openDialog('revert');
      invokeHistory.length = 0;
      skipButton(el)!.click();
      await new Promise(r => setTimeout(r, 50));

      expect(invokeHistory.find(c => c.command === 'skip_revert')).to.not.be.undefined;
      expect(invokeHistory.find(c => c.command === 'skip_cherry_pick')).to.be.undefined;
    });

    it('a skip that stops again on a conflict keeps the dialog open', async () => {
      const el = await openDialog('cherry-pick');
      mockInvoke = async (command: string) => {
        if (command === 'skip_cherry_pick')
          throw { code: 'CHERRY_PICK_CONFLICT', message: 'Cherry-pick conflict' };
        if (command === 'get_conflicts') return [makeConflict('src/next.ts')];
        if (command === 'plugin:dialog|message') return 'Ok';
        return null;
      };

      await (el as unknown as { handleSkip: () => Promise<void> }).handleSkip.bind(el)();
      await el.updateComplete;

      expect(el.open, 'stays open on the next conflict').to.be.true;
      const internal = el as unknown as { resolvedFiles: Set<string>; skipping: boolean };
      expect(internal.resolvedFiles.size, 'resolution state reset for the new stop').to.equal(0);
      expect(internal.skipping, 'flag cleared so Skip can run again').to.be.false;
      expect(uiStore.getState().toasts.find(t => t.type === 'success')).to.be.undefined;
    });

    it('asks before discarding the resolution work Skip throws away', async () => {
      // Abort in this dialog is behind an explicit confirm because it loses
      // every resolution made here; Skip loses the same work for the stopped
      // pick and was a single click. The banner's Skip already confirms as
      // soon as the repo has conflicted files.
      const el = await openDialog('cherry-pick');
      expect(
        (el as unknown as { conflicts: ConflictFile[] }).conflicts.length,
        'the dialog is showing resolution work',
      ).to.be.greaterThan(0);

      mockInvoke = async (command: string) => {
        if (command === 'get_conflicts') return TEST_CONFLICTS;
        if (command === 'plugin:dialog|message') return 'Cancel';
        return null;
      };
      invokeHistory.length = 0;

      await (el as unknown as { handleSkip: () => Promise<void> }).handleSkip.bind(el)();
      await el.updateComplete;

      expect(
        invokeHistory.some(c => c.command === 'plugin:dialog|message'),
        'the user is asked first',
      ).to.be.true;
      expect(
        invokeHistory.find(c => c.command === 'skip_cherry_pick'),
        'a declined confirm must not run the skip',
      ).to.be.undefined;
      expect(el.open, 'the dialog stays open').to.be.true;
      expect(
        (el as unknown as { skipping: boolean }).skipping,
        'declining must not wedge the button',
      ).to.be.false;
    });

    it('skips an empty stop without a confirm', async () => {
      // No conflicts and nothing marked resolved means nothing to lose — a
      // scary prompt there is pure friction, exactly as on the banner.
      setupDefaultMocks([]);
      const el = await openDialog('cherry-pick');
      invokeHistory.length = 0;

      await (el as unknown as { handleSkip: () => Promise<void> }).handleSkip.bind(el)();
      await el.updateComplete;

      expect(
        invokeHistory.some(c => c.command === 'plugin:dialog|message'),
        'nothing to confirm away',
      ).to.be.false;
      expect(invokeHistory.find(c => c.command === 'skip_cherry_pick')).to.not.be.undefined;
    });

    it('a failed skip surfaces the error and keeps the dialog open', async () => {
      const el = await openDialog('cherry-pick');
      mockInvoke = async (command: string) => {
        if (command === 'skip_cherry_pick')
          throw { code: 'COMMAND_ERROR', message: 'Repository is busy' };
        if (command === 'get_conflicts') return TEST_CONFLICTS;
        if (command === 'plugin:dialog|message') return 'Ok';
        return null;
      };

      await (el as unknown as { handleSkip: () => Promise<void> }).handleSkip.bind(el)();
      await el.updateComplete;

      const errorToast = uiStore.getState().toasts.find(t => t.type === 'error');
      expect(errorToast?.message, 'error path is never silent').to.contain('Repository is busy');
      expect(el.open, 'dialog stays open so the user can retry').to.be.true;
    });
  });

  // ── External merge tool verification ───────────────────────────────────────
  describe('external tool resolution verification', () => {
    beforeEach(() => clearToasts());

    it('does not mark resolved when tool exits 0 but file still conflicted', async () => {
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      mockInvoke = async (command: string) => {
        if (command === 'launch_merge_tool') return { success: true };
        if (command === 'get_conflicts') return TEST_CONFLICTS; // still conflicted
        return null;
      };

      await (el as unknown as {
        handleOpenExternalTool: (p: string) => Promise<void>;
      }).handleOpenExternalTool.bind(el)('src/main.ts');

      const internal = el as unknown as { resolvedFiles: Set<string> };
      expect(internal.resolvedFiles.has('src/main.ts')).to.be.false;
      const warnToast = uiStore.getState().toasts.find(t => t.type === 'warning');
      expect(warnToast, 'warning toast shown').to.not.be.undefined;
    });

    it('marks resolved when tool exits 0 and file no longer conflicted', async () => {
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      mockInvoke = async (command: string) => {
        if (command === 'launch_merge_tool') return { success: true };
        // main.ts no longer in the conflict list
        if (command === 'get_conflicts') return [makeConflict('src/utils.ts')];
        return null;
      };

      await (el as unknown as {
        handleOpenExternalTool: (p: string) => Promise<void>;
      }).handleOpenExternalTool.bind(el)('src/main.ts');

      const internal = el as unknown as { resolvedFiles: Set<string> };
      expect(internal.resolvedFiles.has('src/main.ts')).to.be.true;
    });
  });

  // ── Stash pop conflict flow ────────────────────────────────────────────────
  describe('stash pop conflict flow', () => {
    beforeEach(() => clearToasts());

    it('shows "Complete" button label for stash', async () => {
      const el = await renderDialog('stash');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const continueBtn = el.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement;
      expect(continueBtn.textContent!.trim()).to.equal('Complete');
    });

    it('drops the stash and completes on continue', async () => {
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_stashes')
          return [{ index: 0, message: 'popped', oid: 'oid-popped' }];
        return baseMock(command, args);
      };
      const el = await renderDialog('stash');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      const internal = el as unknown as { resolvedFiles: Set<string>; conflicts: ConflictFile[] };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));

      let completedFired = false;
      el.addEventListener('operation-completed', () => { completedFired = true; });

      invokeHistory.length = 0;
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      const dropCall = invokeHistory.find(h => h.command === 'drop_stash');
      expect(dropCall, 'drop_stash called').to.exist;
      expect((dropCall!.args as Record<string, unknown>).index).to.equal(0);
      expect(completedFired).to.be.true;
      expect(el.open).to.be.false;
    });

    it('drops the stash by IDENTITY when the list shifted while the dialog was open', async () => {
      // An external `git stash drop` in a terminal mid-resolution shifts
      // the indices — dropping blindly by the open-time index would delete
      // an UNRELATED stash.
      let stashList = [
        { index: 0, message: 'the conflicted stash', oid: 'oid-target' },
        { index: 1, message: 'other', oid: 'oid-other' },
      ];
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_stashes') return stashList;
        return baseMock(command, args);
      };

      const el = await renderDialog('stash');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      // The external drop removes an entry ABOVE ours: our stash is now index 0.
      stashList = [{ index: 0, message: 'the conflicted stash', oid: 'oid-target' }];

      const internal = el as unknown as { resolvedFiles: Set<string>; conflicts: ConflictFile[] };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));
      invokeHistory.length = 0;
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      const dropCall = invokeHistory.find(h => h.command === 'drop_stash');
      expect(dropCall, 'drop_stash called').to.exist;
      expect(
        (dropCall!.args as Record<string, unknown>).index,
        'dropped at the RE-LOCATED index'
      ).to.equal(0);
    });

    it('a late identity capture from a PREVIOUS dialog session cannot cross over', async () => {
      // Session 1 opens for stashIndex=1 and its getStashes hangs; the
      // dialog closes and reopens (session 2, stashIndex=0). When session
      // 1's response finally lands it must be discarded — pairing its list
      // with session 2's index would capture the wrong entry's identity.
      let releaseFirst: ((v: unknown) => void) | null = null;
      let call = 0;
      const stale = [
        { index: 0, message: 'other', oid: 'oid-wrong' },
        { index: 1, message: 'first session target', oid: 'oid-session1' },
      ];
      const fresh = [{ index: 0, message: 'second session target', oid: 'oid-session2' }];
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_stashes') {
          call++;
          if (call === 1) {
            return new Promise((res) => {
              releaseFirst = () => res(stale);
            });
          }
          return fresh;
        }
        return baseMock(command, args);
      };

      const el = await renderDialog('stash');
      (el as unknown as { stashIndex: number }).stashIndex = 1;
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 50));

      // Close and reopen for a different stash.
      (el as unknown as { close: () => void }).close.call(el);
      await el.updateComplete;
      (el as unknown as { stashIndex: number }).stashIndex = 0;
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 50));

      // Session 2's capture landed.
      expect(
        (el as unknown as { stashOidToDrop: string | null }).stashOidToDrop
      ).to.equal('oid-session2');

      // Session 1's response arrives late — it must not overwrite.
      releaseFirst!(stale);
      await new Promise(r => setTimeout(r, 20));
      expect(
        (el as unknown as { stashOidToDrop: string | null }).stashOidToDrop,
        "a stale session's list must not pair with the new session's index"
      ).to.equal('oid-session2');
    });

    it('skips the drop with a warning when the stash entry vanished mid-dialog', async () => {
      let stashList: Array<{ index: number; message: string; oid: string }> = [
        { index: 0, message: 'the conflicted stash', oid: 'oid-target' },
      ];
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_stashes') return stashList;
        return baseMock(command, args);
      };

      const el = await renderDialog('stash');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      // The entry is gone entirely (dropped externally).
      stashList = [];

      const internal = el as unknown as { resolvedFiles: Set<string>; conflicts: ConflictFile[] };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));
      let completedFired = false;
      el.addEventListener('operation-completed', () => {
        completedFired = true;
      });
      clearToasts();
      invokeHistory.length = 0;
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      expect(
        invokeHistory.some(h => h.command === 'drop_stash'),
        'nothing may be dropped'
      ).to.be.false;
      expect(completedFired, 'the resolution itself still completes').to.be.true;
      const warn = uiStore.getState().toasts.find(t => t.type === 'warning');
      expect(warn?.message).to.include('left in the stash list');
    });

    it('a FAILED drop_stash still completes the operation (the apply already succeeded)', async () => {
      // The conflict resolution and stash APPLY succeeded; only removing the
      // redundant stash entry failed. That must NOT dead-end the dialog —
      // it should warn but complete, or the pinned repo never refreshes.
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_stashes')
          return [{ index: 0, message: 'the conflicted stash', oid: 'oid-target' }];
        if (command === 'drop_stash')
          return Promise.reject({ code: 'IO_ERROR', message: 'disk error' });
        return baseMock(command, args);
      };

      const el = await renderDialog('stash');
      el.dropStashOnComplete = true;
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      (el as unknown as { stashOidToDrop: string | null }).stashOidToDrop = 'oid-target';
      const internal = el as unknown as { resolvedFiles: Set<string>; conflicts: ConflictFile[] };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));
      let completedFired = false;
      el.addEventListener('operation-completed', () => {
        completedFired = true;
      });
      clearToasts();
      invokeHistory.length = 0;
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      expect(invokeHistory.some(h => h.command === 'drop_stash'), 'drop was attempted').to.be.true;
      expect(completedFired, 'the operation still completes so the repo refreshes').to.be.true;
      const warn = uiStore.getState().toasts.find(t => t.type === 'warning');
      expect(warn?.message, 'warns the stash was left behind').to.include('left in the stash list');
    });

    it('an unverifiable identity NEVER falls back to a blind index drop', async () => {
      // The open-time capture failed (get_stashes errored); meanwhile an
      // external `git stash push` put unrelated WIP at index 0. A blind
      // index drop would permanently delete that WIP.
      let allowStashList = false;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_stashes') {
          if (!allowStashList) throw new Error('transient failure');
          return [{ index: 0, message: 'unrelated WIP', oid: 'oid-wip' }];
        }
        return baseMock(command, args);
      };
      const el = await renderDialog('stash');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      allowStashList = true;

      const internal = el as unknown as {
        resolvedFiles: Set<string>;
        conflicts: ConflictFile[];
        handleContinue: () => Promise<void>;
      };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));
      let completedFired = false;
      el.addEventListener('operation-completed', () => {
        completedFired = true;
      });
      clearToasts();
      invokeHistory.length = 0;
      await internal.handleContinue.call(el);

      expect(
        invokeHistory.some(h => h.command === 'drop_stash'),
        'no identity, no drop — never a blind index'
      ).to.be.false;
      expect(completedFired).to.be.true;
      const warn = uiStore.getState().toasts.find(t => t.type === 'warning');
      expect(warn?.message).to.include('left in the stash list');
    });

    it('aborts a stash conflict by restoring ONLY the conflicted files (no hard reset, stash kept)', async () => {
      const el = await renderDialog('stash');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      let abortedFired = false;
      el.addEventListener('operation-aborted', () => { abortedFired = true; });

      invokeHistory.length = 0;
      await (el as unknown as { handleAbortConfirm: () => Promise<void> }).handleAbortConfirm.bind(el)();

      const conflictPaths = TEST_CONFLICTS.map(c => c.path);
      // Path-scoped restore: unstage + discard the conflicted files only.
      const unstageCall = invokeHistory.find(h => h.command === 'unstage_files');
      expect(unstageCall, 'unstage_files called for conflicted paths').to.exist;
      expect((unstageCall!.args as Record<string, unknown>).paths).to.deep.equal(conflictPaths);
      const discardCall = invokeHistory.find(h => h.command === 'discard_changes');
      expect(discardCall, 'discard_changes called for conflicted paths').to.exist;
      expect((discardCall!.args as Record<string, unknown>).paths).to.deep.equal(conflictPaths);
      // Must NOT hard-reset (would destroy unrelated changes) and must NOT drop the stash.
      expect(invokeHistory.some(h => h.command === 'reset'), 'no hard reset').to.be.false;
      expect(invokeHistory.some(h => h.command === 'drop_stash'), 'stash kept').to.be.false;
      expect(abortedFired).to.be.true;
      const infoToast = uiStore.getState().toasts.find(t => t.type === 'info');
      expect(infoToast, 'info toast shown').to.not.be.undefined;
    });

    it('stash abort re-fetches the real conflict paths even when the client list is empty (load in flight)', async () => {
      // The conflict load can still be in flight (empty this.conflicts,
      // loadFailed false) when the user hits Abort. Trusting the empty
      // client list would no-op and falsely report success while the tree
      // stays conflicted — the abort must re-fetch the authoritative list.
      const el = await renderDialog('stash');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      // Simulate an in-flight load: the index IS conflicted but the client
      // list has not populated yet.
      const internal = el as unknown as { conflicts: ConflictFile[]; loadFailed: boolean };
      internal.conflicts = [];
      internal.loadFailed = false;
      await el.updateComplete;

      invokeHistory.length = 0;
      await (el as unknown as { handleAbortConfirm: () => Promise<void> }).handleAbortConfirm.bind(el)();

      // The abort re-fetched and restored the REAL paths, not no-opped.
      const unstageCall = invokeHistory.find(h => h.command === 'unstage_files');
      expect(unstageCall, 'unstage_files called for the re-fetched paths').to.exist;
      expect((unstageCall!.args as Record<string, unknown>).paths).to.deep.equal(
        TEST_CONFLICTS.map(c => c.path),
      );
      expect(invokeHistory.some(h => h.command === 'discard_changes'), 'files restored').to.be.true;
    });

    it('stash abort restores files ALREADY resolved this session, not just still-conflicted ones', async () => {
      // A file resolved in-session (Mark Resolved → staged, or take-side
      // deletion) is no longer index-conflicted, so the refetch alone would
      // EXCLUDE it. Abort must restore the UNION so it doesn't leave that
      // resolution staged while claiming everything was reverted.
      const el = await renderDialog('stash');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      const internal = el as unknown as { conflicts: ConflictFile[] };
      // Two files were originally conflicted...
      const originalPaths = internal.conflicts.map((c) => c.path);
      expect(originalPaths.length).to.be.greaterThan(1);

      // ...but the refetch reports only ONE still conflicted (the other was
      // resolved in-session and is now staged).
      const stillConflicted = originalPaths[0];
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_conflicts') return [{ path: stillConflicted }];
        return baseMock(command, args);
      };

      invokeHistory.length = 0;
      await (el as unknown as { handleAbortConfirm: () => Promise<void> }).handleAbortConfirm.bind(el)();

      const unstageCall = invokeHistory.find((h) => h.command === 'unstage_files');
      expect(unstageCall, 'unstage called').to.exist;
      const paths = (unstageCall!.args as { paths: string[] }).paths;
      // The UNION: every originally-conflicted path, including the resolved one.
      for (const p of originalPaths) {
        expect(paths, `resolved file ${p} must be restored`).to.include(p);
      }
    });
  });

  // ── Stash: empty conflict list must NOT drop (never-applied changes) ────────
  describe('stash with empty conflict list', () => {
    beforeEach(() => clearToasts());

    it('auto-closes (escaping the trap) without dropping when a stash conflict applied nothing', async () => {
      setupDefaultMocks([]);
      const el = await renderDialog('stash');
      let abortedFired = false;
      el.addEventListener('operation-aborted', () => { abortedFired = true; });

      // Opening loads zero conflicts; the dialog must auto-run the safe exit
      // instead of trapping the user (Complete disabled, Escape suppressed).
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      expect(invokeHistory.some(h => h.command === 'drop_stash'), 'drop_stash NOT called').to.be.false;
      expect(invokeHistory.some(h => h.command === 'reset'), 'no hard reset').to.be.false;
      expect(invokeHistory.some(h => h.command === 'unstage_files'), 'nothing restored').to.be.false;
      expect(abortedFired, 'operation-aborted dispatched').to.be.true;
      expect(el.open, 'dialog auto-closed').to.be.false;
      const warnToast = uiStore.getState().toasts.find(t => t.type === 'warning');
      expect(warnToast, 'warning toast shown').to.not.be.undefined;
      expect(warnToast!.message).to.contain('still in the stash');
    });

    it('handleContinue with no conflicts refuses to drop and closes safely', async () => {
      // Render WITH conflicts (so no auto-close), then drive the empty-conflict
      // continue branch directly to prove it stays non-destructive.
      const el = await renderDialog('stash');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      const internal = el as unknown as { conflicts: ConflictFile[] };
      internal.conflicts = [];
      let abortedFired = false;
      el.addEventListener('operation-aborted', () => { abortedFired = true; });

      invokeHistory.length = 0;
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      expect(invokeHistory.some(h => h.command === 'drop_stash'), 'drop_stash NOT called').to.be.false;
      expect(abortedFired, 'operation-aborted dispatched').to.be.true;
      expect(el.open, 'dialog closed').to.be.false;
    });
  });

  // ── Stash: index + drop semantics ───────────────────────────────────────────
  describe('stash index / drop-on-complete semantics', () => {
    beforeEach(() => clearToasts());

    it('drops stash@{stashIndex} when dropStashOnComplete is true', async () => {
      // Four entries; the popped one is index 3. Its identity is captured
      // at open and the drop is verified against it.
      const stashList = [0, 1, 2, 3].map((i) => ({
        index: i,
        message: `stash ${i}`,
        oid: `oid-${i}`,
      }));
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_stashes') return stashList;
        return baseMock(command, args);
      };
      const el = await renderDialog('stash');
      el.stashIndex = 3;
      el.dropStashOnComplete = true;
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      const internal = el as unknown as { resolvedFiles: Set<string>; conflicts: ConflictFile[] };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));

      let completedFired = false;
      el.addEventListener('operation-completed', () => { completedFired = true; });

      invokeHistory.length = 0;
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      const dropCall = invokeHistory.find(h => h.command === 'drop_stash');
      expect(dropCall, 'drop_stash called').to.exist;
      expect((dropCall!.args as Record<string, unknown>).index).to.equal(3);
      expect(completedFired).to.be.true;
      expect(el.open).to.be.false;
    });

    it('does NOT drop the stash when dropStashOnComplete is false (apply semantics)', async () => {
      const el = await renderDialog('stash');
      el.stashIndex = 2;
      el.dropStashOnComplete = false;
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      const internal = el as unknown as { resolvedFiles: Set<string>; conflicts: ConflictFile[] };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));

      let completedFired = false;
      el.addEventListener('operation-completed', () => { completedFired = true; });

      invokeHistory.length = 0;
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      expect(invokeHistory.some(h => h.command === 'drop_stash'), 'drop_stash NOT called').to.be.false;
      expect(completedFired, 'still completes').to.be.true;
      expect(el.open).to.be.false;
    });
  });

  // ── Squash merge completion ─────────────────────────────────────────────────
  describe('squash merge completion', () => {
    beforeEach(() => clearToasts());

    it('completes a squash merge via commit_merge when squashMerge is set', async () => {
      const el = await renderDialog('merge');
      el.squashMerge = true;
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));

      const internal = el as unknown as { resolvedFiles: Set<string>; conflicts: ConflictFile[] };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));

      let completedFired = false;
      el.addEventListener('operation-completed', () => { completedFired = true; });

      invokeHistory.length = 0;
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      expect(invokeHistory.some(h => h.command === 'commit_merge'), 'commit_merge called').to.be.true;
      expect(completedFired).to.be.true;
      expect(el.open).to.be.false;
    });
  });

  // ── Git-flow finish completion after conflict resolution ────────────────────
  describe('gitflow finish completion', () => {
    beforeEach(() => clearToasts());

    async function openWithFinish(
      finish: import('../gn-conflict-resolution-dialog.ts').GitflowFinishContext,
      squash = false,
    ): Promise<GnConflictResolutionDialog> {
      const el = await renderDialog('merge');
      el.squashMerge = squash;
      el.gitflowFinish = finish;
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      const internal = el as unknown as { resolvedFiles: Set<string>; conflicts: ConflictFile[] };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));
      return el;
    }

    it('retries skip the already-committed merge when the finish step failed', async () => {
      const el = await openWithFinish({
        kind: 'release',
        name: '1.0.0',
        branchName: 'release/1.0.0',
        deleteBranch: true,
      });

      // First Continue: merge commits, but the finish re-invocation fails
      // non-conflictingly — the dialog must stay open for retry.
      mockInvoke = async (command: string) => {
        if (command === 'gitflow_finish_release') {
          throw { code: 'OPERATION_FAILED', message: 'branch checked out elsewhere' };
        }
        if (command === 'get_conflicts') return [];
        return null;
      };
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();
      expect(el.open, 'dialog stays open after failed finish step').to.be.true;

      // Second Continue: commitMerge must NOT run again (it would fail with
      // "No merge in progress"); the finish step is retried directly.
      mockInvoke = async (command: string) => {
        if (command === 'get_conflicts') return [];
        return null;
      };
      invokeHistory.length = 0;
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      expect(invokeHistory.some(h => h.command === 'commit_merge'), 'commit_merge NOT re-run').to.be.false;
      expect(invokeHistory.some(h => h.command === 'gitflow_finish_release'), 'finish retried').to.be.true;
      expect(el.open, 'dialog closes after successful retry').to.be.false;
    });

    it('refuses to fake an abort once the merge commit has landed', async () => {
      const el = await openWithFinish({
        kind: 'release',
        name: '1.0.0',
        branchName: 'release/1.0.0',
        deleteBranch: true,
      });

      // Merge commits, finish step fails non-conflictingly → mergeCommitted.
      mockInvoke = async (command: string) => {
        if (command === 'gitflow_finish_release') {
          throw { code: 'OPERATION_FAILED', message: 'branch checked out elsewhere' };
        }
        if (command === 'get_conflicts') return [];
        return null;
      };
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();
      expect(el.open).to.be.true;

      // Abort must NOT run abort_merge (a no-op on the clean repo) and must
      // NOT claim a rollback — the commit exists; only the finish is pending.
      clearToasts();
      invokeHistory.length = 0;
      const internal = el as unknown as {
        showAbortConfirm: boolean;
        handleAbortConfirm: () => Promise<void>;
      };
      internal.showAbortConfirm = true;
      await internal.handleAbortConfirm.call(el);

      expect(invokeHistory.some(h => h.command === 'abort_merge'), 'abort_merge NOT called').to.be.false;
      // The dialog must NOT trap the user (Complete may fail persistently,
      // e.g. branch checked out in a worktree) — it closes with an honest
      // warning; the idempotent finish can be retried from the panel.
      expect(el.open, 'dialog closes instead of trapping the user').to.be.false;
      const toasts = uiStore.getState().toasts;
      expect(toasts.some(t => t.type === 'warning' && /already committed/i.test(t.message))).to.be.true;
    });

    it('warns that master merge and tag survive an abort at the develop stage', async () => {
      const el = await openWithFinish({
        kind: 'release',
        name: '1.0.0',
        branchName: 'release/1.0.0',
        deleteBranch: true,
      });

      // Master merge commits; finish re-run hits the develop-side conflict —
      // the master merge and version tag have already landed.
      mockInvoke = async (command: string) => {
        if (command === 'gitflow_finish_release') {
          throw { code: 'MERGE_CONFLICT', message: 'develop conflicts' };
        }
        if (command === 'get_conflicts') {
          return [{ path: 'dev.txt', ancestor: null, ours: null, theirs: null, isBinary: false }];
        }
        return null;
      };
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();
      expect(el.open).to.be.true;

      // Aborting now rolls back ONLY the develop merge — the toast must say
      // the master merge and tag are already committed, not imply a full undo.
      clearToasts();
      mockInvoke = async () => null;
      const internal = el as unknown as {
        showAbortConfirm: boolean;
        handleAbortConfirm: () => Promise<void>;
      };
      internal.showAbortConfirm = true;
      await internal.handleAbortConfirm.call(el);

      expect(el.open, 'dialog closes after the abort').to.be.false;
      const toasts = uiStore.getState().toasts;
      expect(
        toasts.some(t => t.type === 'warning' && /master merge and version tag.*already committed/i.test(t.message)),
        'honest partial-abort warning shown'
      ).to.be.true;
    });

    it('resets the committed marker even when the re-conflict load fails', async () => {
      const el = await openWithFinish({
        kind: 'release',
        name: '1.0.0',
        branchName: 'release/1.0.0',
        deleteBranch: true,
      });

      // First Continue: master merge commits; the finish re-run hits the
      // develop-side conflict AND the conflict load fails.
      mockInvoke = async (command: string) => {
        if (command === 'gitflow_finish_release') {
          throw { code: 'MERGE_CONFLICT', message: 'develop conflicts' };
        }
        if (command === 'get_conflicts') {
          throw { code: 'COMMAND_ERROR', message: 'read failed' };
        }
        return null;
      };
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();
      expect(el.open, 'dialog stays open on failed re-conflict load').to.be.true;

      // User clicks Retry (load now succeeds), then Complete: the develop
      // merge MUST be committed (marker was reset before the failed load).
      mockInvoke = async (command: string) => {
        if (command === 'get_conflicts') return [];
        return null;
      };
      (el as unknown as { handleRetryLoad: () => void }).handleRetryLoad();
      await new Promise(r => setTimeout(r, 50));
      invokeHistory.length = 0;
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      expect(invokeHistory.some(h => h.command === 'commit_merge'), 'develop merge committed').to.be.true;
      expect(el.open, 'dialog closes after completion').to.be.false;
    });

    it('commits the develop-side merge after a re-conflict instead of skipping it', async () => {
      const el = await openWithFinish({
        kind: 'release',
        name: '1.0.0',
        branchName: 'release/1.0.0',
        deleteBranch: true,
      });

      // First Continue: master merge commits, finish re-run hits the
      // develop-side conflict and reopens the dialog with new conflicts.
      mockInvoke = async (command: string) => {
        if (command === 'gitflow_finish_release') {
          throw { code: 'MERGE_CONFLICT', message: 'develop conflicts' };
        }
        if (command === 'get_conflicts') {
          return [{ path: 'dev.txt', ancestor: null, ours: null, theirs: null, isBinary: false }];
        }
        return null;
      };
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();
      expect(el.open, 'dialog stays open for the develop side').to.be.true;

      // Second Continue (develop conflicts resolved): commitMerge must run
      // AGAIN for the develop merge — the committed-merge marker was reset.
      mockInvoke = async (command: string) => {
        if (command === 'get_conflicts') return [];
        return null;
      };
      const internal = el as unknown as { resolvedFiles: Set<string>; conflicts: Array<{ path: string }> };
      internal.resolvedFiles = new Set(internal.conflicts.map(c => c.path));
      invokeHistory.length = 0;
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      expect(invokeHistory.some(h => h.command === 'commit_merge'), 'develop merge committed').to.be.true;
      expect(invokeHistory.some(h => h.command === 'gitflow_finish_release'), 'finish re-invoked').to.be.true;
      expect(el.open, 'dialog closes after full completion').to.be.false;
    });

    it('re-invokes gitflow_finish_release after commit_merge for a release finish', async () => {
      const el = await openWithFinish({
        kind: 'release',
        name: '1.0.0',
        branchName: 'release/1.0.0',
        deleteBranch: true,
        tagMessage: 'Release 1.0.0',
      });

      let completedFired = false;
      el.addEventListener('operation-completed', () => { completedFired = true; });

      invokeHistory.length = 0;
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      const mergeIdx = invokeHistory.findIndex(h => h.command === 'commit_merge');
      const finishIdx = invokeHistory.findIndex(h => h.command === 'gitflow_finish_release');
      expect(mergeIdx, 'commit_merge called').to.be.greaterThan(-1);
      expect(finishIdx, 'gitflow_finish_release called').to.be.greaterThan(-1);
      expect(finishIdx, 'finish re-invoked AFTER commit_merge').to.be.greaterThan(mergeIdx);

      const finishCall = invokeHistory[finishIdx];
      const args = finishCall.args as Record<string, unknown>;
      expect(args.version).to.equal('1.0.0');
      expect(args.tagMessage).to.equal('Release 1.0.0');
      expect(args.deleteBranch).to.equal(true);

      expect(completedFired).to.be.true;
      expect(el.open).to.be.false;
    });

    it('re-invokes gitflow_finish_hotfix after commit_merge for a hotfix finish', async () => {
      const el = await openWithFinish({
        kind: 'hotfix',
        name: '1.0.1',
        branchName: 'hotfix/1.0.1',
        deleteBranch: true,
        tagMessage: 'Hotfix 1.0.1',
      });

      invokeHistory.length = 0;
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      expect(invokeHistory.some(h => h.command === 'gitflow_finish_hotfix'), 'gitflow_finish_hotfix called').to.be.true;
      expect(el.open).to.be.false;
    });

    it('deletes the feature branch (not re-finish) for a squash feature finish', async () => {
      const el = await openWithFinish(
        { kind: 'feature', name: 'x', branchName: 'feature/x', deleteBranch: true },
        true, // squashMerge
      );

      let completedFired = false;
      el.addEventListener('operation-completed', () => { completedFired = true; });

      invokeHistory.length = 0;
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      // Squash completes as a single-parent commit via commit_merge, then the
      // feature branch is deleted directly — re-invoking finish would loop forever.
      expect(invokeHistory.some(h => h.command === 'commit_merge'), 'commit_merge called').to.be.true;
      const delCall = invokeHistory.find(h => h.command === 'delete_branch');
      expect(delCall, 'delete_branch called').to.exist;
      expect((delCall!.args as Record<string, unknown>).name).to.equal('feature/x');
      expect((delCall!.args as Record<string, unknown>).force).to.equal(true);
      expect(invokeHistory.some(h => h.command === 'gitflow_finish_feature'), 'finish NOT re-invoked for squash').to.be.false;

      // The squash commit was made here, so the backend must be told about it —
      // BEFORE the optional delete, since a blocked delete leaves the feature
      // listed and the user's retry has to find the marker.
      const recordIndex = invokeHistory.findIndex(h => h.command === 'gitflow_record_squash_finish');
      expect(recordIndex, 'gitflow_record_squash_finish called').to.be.greaterThan(-1);
      expect((invokeHistory[recordIndex].args as Record<string, unknown>).name).to.equal('x');
      const deleteIndex = invokeHistory.findIndex(h => h.command === 'delete_branch');
      expect(recordIndex, 'squash recorded before the delete attempt').to.be.lessThan(deleteIndex);

      expect(completedFired).to.be.true;
      expect(el.open).to.be.false;
    });

    it('records the completed squash even when the branch delete is blocked', async () => {
      const el = await openWithFinish(
        { kind: 'feature', name: 'blocked', branchName: 'feature/blocked', deleteBranch: true },
        true, // squashMerge
      );

      mockInvoke = async (command: string) => {
        if (command === 'delete_branch') {
          throw { code: 'OPERATION_FAILED', message: 'Branch rule prevents deletion' };
        }
        if (command === 'get_conflicts') return [];
        return null;
      };

      clearToasts();
      invokeHistory.length = 0;
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      expect(
        invokeHistory.some(h => h.command === 'gitflow_record_squash_finish'),
        'squash recorded despite the blocked delete',
      ).to.be.true;
      const warn = uiStore.getState().toasts.find(t => t.type === 'warning');
      expect(warn, 'blocked delete warned about').to.not.be.undefined;
      expect(warn!.message).to.contain('Branch rule prevents deletion');
      expect(el.open, 'a blocked delete still completes the finish').to.be.false;
    });

    it('warns when the completed squash could not be recorded', async () => {
      const el = await openWithFinish(
        { kind: 'feature', name: 'unrecorded', branchName: 'feature/unrecorded', deleteBranch: false },
        true, // squashMerge
      );

      mockInvoke = async (command: string) => {
        if (command === 'gitflow_record_squash_finish') {
          throw { code: 'OPERATION_FAILED', message: 'marker directory is read-only' };
        }
        if (command === 'get_conflicts') return [];
        return null;
      };

      clearToasts();
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      const warn = uiStore.getState().toasts.find(t => t.type === 'warning');
      expect(warn, 'unrecorded squash warned about').to.not.be.undefined;
      expect(warn!.message).to.contain('marker directory is read-only');
      expect(warn!.message).to.contain('unrecorded');
      expect(el.open, 'the squash commit landed, so the dialog still completes').to.be.false;
    });

    it('re-invokes gitflow_finish_feature (not delete) for a NON-squash feature finish', async () => {
      const el = await openWithFinish(
        { kind: 'feature', name: 'y', branchName: 'feature/y', deleteBranch: true },
        false,
      );

      invokeHistory.length = 0;
      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      expect(invokeHistory.some(h => h.command === 'gitflow_finish_feature'), 'gitflow_finish_feature called').to.be.true;
      expect(el.open).to.be.false;
    });

    it('stays open and reloads conflicts when the finish re-run hits a develop-side conflict', async () => {
      const el = await openWithFinish({
        kind: 'release',
        name: '2.0.0',
        branchName: 'release/2.0.0',
        deleteBranch: true,
      });

      // commit_merge succeeds; the finish re-run conflicts on the develop side and
      // get_conflicts then returns fresh conflicts to resolve.
      mockInvoke = async (command: string) => {
        if (command === 'commit_merge') return null;
        if (command === 'gitflow_finish_release') throw { code: 'MERGE_CONFLICT', message: 'develop conflict' };
        if (command === 'get_conflicts') return [makeConflict('src/develop.ts')];
        return null;
      };

      let completedFired = false;
      el.addEventListener('operation-completed', () => { completedFired = true; });

      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      expect(completedFired, 'must NOT complete while develop conflict pending').to.be.false;
      expect(el.open, 'dialog stays open for the develop-side conflict').to.be.true;
      const internal = el as unknown as { conflicts: ConflictFile[]; resolvedFiles: Set<string> };
      expect(internal.conflicts.map(c => c.path)).to.deep.equal(['src/develop.ts']);
      expect(internal.resolvedFiles.size, 'resolution reset for new conflict').to.equal(0);
    });

    it('surfaces an error toast and stays open when the finish re-run fails non-conflict', async () => {
      const el = await openWithFinish({
        kind: 'release',
        name: '3.0.0',
        branchName: 'release/3.0.0',
        deleteBranch: true,
      });

      mockInvoke = async (command: string) => {
        if (command === 'commit_merge') return null;
        if (command === 'gitflow_finish_release') throw { code: 'COMMAND_ERROR', message: 'tag failed' };
        if (command === 'get_conflicts') return TEST_CONFLICTS;
        return null;
      };

      let completedFired = false;
      el.addEventListener('operation-completed', () => { completedFired = true; });

      await (el as unknown as { handleContinue: () => Promise<void> }).handleContinue.bind(el)();

      expect(completedFired).to.be.false;
      expect(el.open).to.be.true;
      const errorToast = uiStore.getState().toasts.find(t => t.type === 'error');
      expect(errorToast, 'error toast shown').to.not.be.undefined;
      expect(errorToast!.message).to.contain('tag failed');
    });
  });

  // ── Failed conflict load keeps dialog open with retry (Fix 3) ───────────────
  describe('failed conflict load', () => {
    beforeEach(() => clearToasts());

    it('keeps a stash dialog OPEN with a Retry when the initial load FAILS', async () => {
      // The backend opened this dialog because it reported a conflict. A failed
      // load must NOT trigger the "stash not applied" auto-exit — the index IS
      // conflicted, we just could not read it.
      mockInvoke = async (command: string) => {
        if (command === 'get_conflicts') throw { code: 'COMMAND_ERROR', message: 'read failed' };
        return null;
      };
      const el = await renderDialog('stash');
      let abortedFired = false;
      el.addEventListener('operation-aborted', () => { abortedFired = true; });

      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      expect(abortedFired, 'must NOT auto-exit on a failed load').to.be.false;
      expect(el.open, 'dialog stays open').to.be.true;
      const internal = el as unknown as { loadFailed: boolean };
      expect(internal.loadFailed).to.be.true;

      // A Retry affordance is offered.
      const retryBtn = Array.from(el.shadowRoot!.querySelectorAll('button'))
        .find(b => b.textContent!.trim() === 'Retry');
      expect(retryBtn, 'Retry button rendered').to.exist;

      // Complete stays disabled while the load is failed.
      const continueBtn = el.shadowRoot!.querySelector('.footer-actions .btn-primary') as HTMLButtonElement;
      expect(continueBtn.disabled).to.be.true;
    });

    it('Abort under loadFailed re-fetches conflicts and restores the real paths', async () => {
      // Open a stash dialog whose initial conflict load fails.
      mockInvoke = async (command: string) => {
        if (command === 'get_conflicts') throw { code: 'COMMAND_ERROR', message: 'read failed' };
        return null;
      };
      const el = await renderDialog('stash');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      expect((el as unknown as { loadFailed: boolean }).loadFailed).to.be.true;

      // Abort must re-fetch the REAL conflict list and restore those paths,
      // not no-op on the empty local list with a false success message.
      mockInvoke = async (command: string) => {
        if (command === 'get_conflicts') {
          return [{ path: 'a.txt', ancestor: null, ours: null, theirs: null, isBinary: false }];
        }
        return null;
      };
      invokeHistory.length = 0;
      const internal = el as unknown as {
        showAbortConfirm: boolean;
        handleAbortConfirm: () => Promise<void>;
      };
      internal.showAbortConfirm = true;
      await internal.handleAbortConfirm.call(el);

      const unstage = invokeHistory.find(h => h.command === 'unstage_files');
      expect(unstage, 'unstage_files called with re-fetched paths').to.exist;
      expect((unstage!.args as { paths?: string[] }).paths).to.deep.equal(['a.txt']);
      expect(invokeHistory.some(h => h.command === 'discard_changes'), 'discard_changes called').to.be.true;
    });

    it('Retry re-loads conflicts and recovers when the backend succeeds', async () => {
      let calls = 0;
      mockInvoke = async (command: string) => {
        if (command === 'get_conflicts') {
          calls++;
          if (calls === 1) throw { code: 'COMMAND_ERROR', message: 'read failed' };
          return TEST_CONFLICTS;
        }
        return null;
      };
      const el = await renderDialog('merge');
      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      const internal = el as unknown as { loadFailed: boolean; conflicts: ConflictFile[] };
      expect(internal.loadFailed).to.be.true;

      const retryBtn = Array.from(el.shadowRoot!.querySelectorAll('button'))
        .find(b => b.textContent!.trim() === 'Retry') as HTMLButtonElement;
      retryBtn.click();
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      expect(internal.loadFailed).to.be.false;
      expect(internal.conflicts.length).to.equal(3);
    });

    it('a SUCCESSFUL empty load still auto-exits a stash dialog', async () => {
      // Regression guard for the Fix 3 distinction: a genuine zero-conflict load
      // (not a failure) must still run the safe auto-exit.
      setupDefaultMocks([]);
      const el = await renderDialog('stash');
      let abortedFired = false;
      el.addEventListener('operation-aborted', () => { abortedFired = true; });

      el.open = true;
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 100));
      await el.updateComplete;

      expect(abortedFired, 'auto-exit on successful empty load').to.be.true;
      expect(el.open).to.be.false;
      const internal = el as unknown as { loadFailed: boolean };
      expect(internal.loadFailed).to.be.false;
    });
  });
});
