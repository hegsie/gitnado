/**
 * Tests for lv-file-status component.
 *
 * Renders the REAL lv-file-status component, mocks only the Tauri invoke
 * layer, and verifies the actual component code renders the correct DOM
 * and calls the right commands.
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
import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import type { LvFileStatus } from '../sidebar/lv-file-status.ts';
import '../sidebar/lv-file-status.ts';
import { repositoryStore } from '../../stores/repository.store.ts';
import { uiStore } from '../../stores/ui.store.ts';
import type { Repository } from '../../types/git.types.ts';

// ── Test data ──────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

const mockStatusEntries = [
  { path: 'src/app.ts', status: 'modified', isStaged: true, isConflicted: false },
  { path: 'src/utils/helper.ts', status: 'modified', isStaged: false, isConflicted: false },
  { path: 'src/new-file.ts', status: 'new', isStaged: true, isConflicted: false },
  { path: 'README.md', status: 'deleted', isStaged: false, isConflicted: false },
  { path: 'src/renamed.ts', status: 'renamed', isStaged: true, isConflicted: false },
  { path: 'temp.log', status: 'untracked', isStaged: false, isConflicted: false },
  // Partially staged file - same path in both staged and unstaged:
  { path: 'src/partial.ts', status: 'modified', isStaged: true, isConflicted: false },
  { path: 'src/partial.ts', status: 'modified', isStaged: false, isConflicted: false },
];

// ── Helpers ────────────────────────────────────────────────────────────────
function clearHistory(): void {
  invokeHistory.length = 0;
}

function findCommands(name: string): Array<{ command: string; args?: unknown }> {
  return invokeHistory.filter((h) => h.command === name);
}

function isConfirmCommand(command: string): boolean {
  return command === 'plugin:dialog|message' || command === 'plugin:dialog|confirm';
}

function setupDefaultMocks(
  opts: { entries?: typeof mockStatusEntries; postStageEntries?: typeof mockStatusEntries } = {},
): void {
  let stageDone = false;
  const entries = opts.entries ?? mockStatusEntries;

  mockInvoke = async (command: string) => {
    switch (command) {
      case 'get_status':
        if (stageDone && opts.postStageEntries) {
          return opts.postStageEntries;
        }
        return entries;
      case 'stage_files':
        stageDone = true;
        return null;
      case 'unstage_files':
        stageDone = true;
        return null;
      case 'discard_changes':
        return null;
      case 'start_watching':
        return null;
      case 'plugin:dialog|message':
      case 'plugin:dialog|confirm':
        return 'Ok';
      default:
        return null;
    }
  };
}

async function renderFileStatus(): Promise<LvFileStatus> {
  const el = await fixture<LvFileStatus>(
    html`<lv-file-status .repositoryPath=${REPO_PATH}></lv-file-status>`,
  );
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
  return el;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('lv-file-status', () => {
  beforeEach(() => {
    clearHistory();
    setupDefaultMocks();
  });

  // ── 1. Rendering ──────────────────────────────────────────────────────
  describe('rendering', () => {
    it('renders staged section with title "Staged" and correct count', async () => {
      const el = await renderFileStatus();

      const sections = el.shadowRoot!.querySelectorAll('.section');
      expect(sections.length).to.equal(2);

      const stagedSection = sections[0];
      const title = stagedSection.querySelector('.section-title');
      expect(title).to.not.be.null;
      expect(title!.textContent).to.include('Staged');

      const count = stagedSection.querySelector('.section-count');
      expect(count).to.not.be.null;
      // Staged files: src/app.ts, src/new-file.ts, src/renamed.ts, src/partial.ts = 4
      expect(count!.textContent!.trim()).to.equal('4');
    });

    it('renders unstaged section with title "Changes" and correct count', async () => {
      const el = await renderFileStatus();

      const sections = el.shadowRoot!.querySelectorAll('.section');
      const unstagedSection = sections[1];
      const title = unstagedSection.querySelector('.section-title');
      expect(title).to.not.be.null;
      expect(title!.textContent).to.include('Changes');

      const count = unstagedSection.querySelector('.section-count');
      expect(count).to.not.be.null;
      // Unstaged files: src/utils/helper.ts, README.md, temp.log, src/partial.ts = 4
      expect(count!.textContent!.trim()).to.equal('4');
    });

    it('renders each file with file-name and file-dir', async () => {
      const el = await renderFileStatus();

      const fileItems = el.shadowRoot!.querySelectorAll('.file-item');
      expect(fileItems.length).to.be.greaterThanOrEqual(1);

      // Check first staged file: src/app.ts
      const firstItem = fileItems[0];
      const fileName = firstItem.querySelector('.file-name');
      expect(fileName).to.not.be.null;
      expect(fileName!.textContent).to.include('app.ts');

      const fileDir = firstItem.querySelector('.file-dir');
      expect(fileDir).to.not.be.null;
      expect(fileDir!.textContent).to.include('src');
    });

    it('shows clean state when no changes', async () => {
      setupDefaultMocks({ entries: [] });
      const el = await renderFileStatus();

      const cleanState = el.shadowRoot!.querySelector('.clean-state');
      expect(cleanState).to.not.be.null;
      expect(cleanState!.textContent).to.include('Working tree clean');
    });
  });

  // ── 2. Status badges ─────────────────────────────────────────────────
  describe('status badges', () => {
    it('shows "M" badge for modified file', async () => {
      const el = await renderFileStatus();

      const fileItems = el.shadowRoot!.querySelectorAll('.file-item');
      // First staged file is src/app.ts (modified)
      const statusBadge = fileItems[0].querySelector('.file-status');
      expect(statusBadge).to.not.be.null;
      expect(statusBadge!.classList.contains('modified')).to.be.true;
      expect(statusBadge!.textContent!.trim()).to.equal('M');
    });

    it('shows "A" badge for new/added file', async () => {
      const el = await renderFileStatus();

      const fileItems = el.shadowRoot!.querySelectorAll('.file-item');
      // Second staged file is src/new-file.ts (new)
      const statusBadge = fileItems[1].querySelector('.file-status');
      expect(statusBadge).to.not.be.null;
      expect(statusBadge!.classList.contains('new')).to.be.true;
      expect(statusBadge!.textContent!.trim()).to.equal('A');
    });

    it('shows "D" badge for deleted file', async () => {
      const el = await renderFileStatus();

      // Find the unstaged deleted file (README.md)
      const fileItems = el.shadowRoot!.querySelectorAll('.file-item');
      const deletedItem = Array.from(fileItems).find(
        (item) => item.querySelector('.file-status.deleted'),
      );
      expect(deletedItem).to.not.be.undefined;
      const badge = deletedItem!.querySelector('.file-status');
      expect(badge!.textContent!.trim()).to.equal('D');
    });

    it('shows "R" badge for renamed file', async () => {
      const el = await renderFileStatus();

      const fileItems = el.shadowRoot!.querySelectorAll('.file-item');
      const renamedItem = Array.from(fileItems).find(
        (item) => item.querySelector('.file-status.renamed'),
      );
      expect(renamedItem).to.not.be.undefined;
      const badge = renamedItem!.querySelector('.file-status');
      expect(badge!.textContent!.trim()).to.equal('R');
    });

    it('shows "?" badge for untracked file', async () => {
      const el = await renderFileStatus();

      const fileItems = el.shadowRoot!.querySelectorAll('.file-item');
      const untrackedItem = Array.from(fileItems).find(
        (item) => item.querySelector('.file-status.untracked'),
      );
      expect(untrackedItem).to.not.be.undefined;
      const badge = untrackedItem!.querySelector('.file-status');
      expect(badge!.textContent!.trim()).to.equal('?');
    });
  });

  // ── 3. Section collapse ──────────────────────────────────────────────
  describe('section collapse', () => {
    it('collapses staged section when header is clicked', async () => {
      const el = await renderFileStatus();

      const sections = el.shadowRoot!.querySelectorAll('.section');
      const stagedHeader = sections[0].querySelector('.section-header')!;
      const chevron = stagedHeader.querySelector('.chevron')!;

      // Initially expanded
      expect(chevron.classList.contains('expanded')).to.be.true;

      // Click to collapse
      stagedHeader.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await el.updateComplete;

      const chevronAfter = sections[0].querySelector('.section-header .chevron')!;
      expect(chevronAfter.classList.contains('expanded')).to.be.false;
    });

    it('expands collapsed section when header is clicked again', async () => {
      const el = await renderFileStatus();

      const sections = el.shadowRoot!.querySelectorAll('.section');
      const stagedHeader = sections[0].querySelector('.section-header')!;

      // Click once to collapse
      stagedHeader.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await el.updateComplete;

      // Click again to expand
      const headerAgain = el.shadowRoot!.querySelectorAll('.section')[0].querySelector('.section-header')!;
      headerAgain.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await el.updateComplete;

      const chevronAfter = el.shadowRoot!.querySelectorAll('.section')[0].querySelector('.section-header .chevron')!;
      expect(chevronAfter.classList.contains('expanded')).to.be.true;
    });
  });

  // ── 4. Tree view ─────────────────────────────────────────────────────
  describe('tree view', () => {
    it('switches from flat to tree view when view toggle is clicked', async () => {
      const el = await renderFileStatus();

      const viewToggle = el.shadowRoot!.querySelector('.view-toggle')!;
      expect(viewToggle.textContent).to.include('Flat');

      viewToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await el.updateComplete;

      const viewToggleAfter = el.shadowRoot!.querySelector('.view-toggle')!;
      expect(viewToggleAfter.classList.contains('active')).to.be.true;
      expect(viewToggleAfter.textContent).to.include('Tree');
    });

    it('shows folder items in tree view', async () => {
      const el = await renderFileStatus();

      const viewToggle = el.shadowRoot!.querySelector('.view-toggle')!;
      viewToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await el.updateComplete;

      const folderItems = el.shadowRoot!.querySelectorAll('.folder-item');
      expect(folderItems.length).to.be.greaterThan(0);

      const folderNames = Array.from(folderItems).map(
        (item) => item.querySelector('.folder-name')!.textContent!.trim(),
      );
      expect(folderNames).to.include('src');
    });

    it('shows file count in folder-count', async () => {
      const el = await renderFileStatus();

      const viewToggle = el.shadowRoot!.querySelector('.view-toggle')!;
      viewToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await el.updateComplete;

      const folderItems = el.shadowRoot!.querySelectorAll('.folder-item');
      const srcFolder = Array.from(folderItems).find(
        (item) => item.querySelector('.folder-name')!.textContent!.trim() === 'src',
      );
      expect(srcFolder).to.not.be.undefined;
      const folderCount = srcFolder!.querySelector('.folder-count');
      expect(folderCount).to.not.be.null;
      const count = parseInt(folderCount!.textContent!.trim(), 10);
      expect(count).to.be.greaterThan(0);
    });
  });

  // ── 5. File selection ────────────────────────────────────────────────
  describe('file selection', () => {
    it('dispatches file-selected event when a file is clicked', async () => {
      const el = await renderFileStatus();

      let eventDetail: unknown = null;
      el.addEventListener('file-selected', ((e: CustomEvent) => {
        eventDetail = e.detail;
      }) as EventListener);

      const fileItems = el.shadowRoot!.querySelectorAll('.file-item');
      fileItems[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await el.updateComplete;

      expect(eventDetail).to.not.be.null;
      expect((eventDetail as { file: { path: string } }).file.path).to.equal('src/app.ts');
    });

    it('adds selected class to clicked file', async () => {
      const el = await renderFileStatus();

      const fileItems = el.shadowRoot!.querySelectorAll('.file-item');
      fileItems[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await el.updateComplete;

      const updatedItems = el.shadowRoot!.querySelectorAll('.file-item');
      expect(updatedItems[0].classList.contains('selected')).to.be.true;
    });

    it('ctrl+click adds to selection for multiple selected items', async () => {
      const el = await renderFileStatus();

      const fileItems = el.shadowRoot!.querySelectorAll('.file-item');
      // Click first file
      fileItems[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await el.updateComplete;

      // Ctrl+click second file
      fileItems[1].dispatchEvent(
        new MouseEvent('click', { bubbles: true, ctrlKey: true }),
      );
      await el.updateComplete;

      const selectedItems = el.shadowRoot!.querySelectorAll('.file-item.selected');
      expect(selectedItems.length).to.equal(2);
    });

    it('shows selection-actions bar when files are selected', async () => {
      const el = await renderFileStatus();

      // Click an unstaged file to select it
      const fileItems = el.shadowRoot!.querySelectorAll('.file-item');
      // Find an unstaged file item (after the staged ones)
      const stagedCount = 4; // 4 staged files
      fileItems[stagedCount].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await el.updateComplete;

      const selectionActions = el.shadowRoot!.querySelector('.selection-actions');
      expect(selectionActions).to.not.be.null;

      const selectionCount = selectionActions!.querySelector('.selection-count');
      expect(selectionCount).to.not.be.null;
      expect(selectionCount!.textContent).to.include('1 selected');
    });
  });

  // ── 6. Stage / Unstage ───────────────────────────────────────────────
  describe('stage and unstage', () => {
    it('calls stage_files when stage button is clicked on unstaged file', async () => {
      const el = await renderFileStatus();
      clearHistory();

      // Find an unstaged file's stage button (file-action with title "Stage")
      const sections = el.shadowRoot!.querySelectorAll('.section');
      const unstagedSection = sections[1];
      const fileItems = unstagedSection.querySelectorAll('.file-item');
      const firstUnstagedItem = fileItems[0];

      // Hover to make actions visible, then find the Stage button
      const actions = firstUnstagedItem.querySelectorAll('.file-action');
      const stageBtn = Array.from(actions).find(
        (btn) => btn.getAttribute('title') === 'Stage',
      );
      expect(stageBtn).to.not.be.undefined;

      stageBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const stageCalls = findCommands('stage_files');
      expect(stageCalls.length).to.be.greaterThan(0);
      const stageArgs = stageCalls[0].args as { path: string; paths: string[] };
      expect(stageArgs.path).to.equal(REPO_PATH);
      expect(stageArgs.paths).to.include('src/utils/helper.ts');
    });

    it('calls unstage_files when unstage button is clicked on staged file', async () => {
      const el = await renderFileStatus();
      clearHistory();

      // Find a staged file's unstage button
      const sections = el.shadowRoot!.querySelectorAll('.section');
      const stagedSection = sections[0];
      const fileItems = stagedSection.querySelectorAll('.file-item');
      const firstStagedItem = fileItems[0];

      const actions = firstStagedItem.querySelectorAll('.file-action');
      const unstageBtn = Array.from(actions).find(
        (btn) => btn.getAttribute('title') === 'Unstage',
      );
      expect(unstageBtn).to.not.be.undefined;

      unstageBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const unstageCalls = findCommands('unstage_files');
      expect(unstageCalls.length).to.be.greaterThan(0);
      const unstageArgs = unstageCalls[0].args as { path: string; paths: string[] };
      expect(unstageArgs.path).to.equal(REPO_PATH);
      expect(unstageArgs.paths).to.include('src/app.ts');
    });

    it('calls stage_files with all unstaged paths when Stage All button is clicked', async () => {
      const el = await renderFileStatus();
      clearHistory();

      // Find the Stage All button in the unstaged section header
      const sections = el.shadowRoot!.querySelectorAll('.section');
      const unstagedSection = sections[1];
      const sectionActions = unstagedSection.querySelector('.section-actions');
      expect(sectionActions).to.not.be.null;

      const stageAllBtn = sectionActions!.querySelector('.section-action');
      expect(stageAllBtn).to.not.be.null;

      stageAllBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const stageCalls = findCommands('stage_files');
      expect(stageCalls.length).to.be.greaterThan(0);
      const stageArgs = stageCalls[0].args as { path: string; paths: string[] };
      expect(stageArgs.paths.length).to.equal(4); // 4 unstaged files
    });

    it('calls unstage_files with all staged paths when Unstage All button is clicked', async () => {
      const el = await renderFileStatus();
      clearHistory();

      // Find the Unstage All button in the staged section header
      const sections = el.shadowRoot!.querySelectorAll('.section');
      const stagedSection = sections[0];
      const sectionActions = stagedSection.querySelector('.section-actions');
      expect(sectionActions).to.not.be.null;

      const unstageAllBtn = sectionActions!.querySelector('.section-action');
      expect(unstageAllBtn).to.not.be.null;

      unstageAllBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const unstageCalls = findCommands('unstage_files');
      expect(unstageCalls.length).to.be.greaterThan(0);
      const unstageArgs = unstageCalls[0].args as { path: string; paths: string[] };
      expect(unstageArgs.paths.length).to.equal(4); // 4 staged files
    });

    it('refreshes status after staging a file', async () => {
      const el = await renderFileStatus();
      clearHistory();

      // Stage a file via file action button
      const sections = el.shadowRoot!.querySelectorAll('.section');
      const unstagedSection = sections[1];
      const fileItems = unstagedSection.querySelectorAll('.file-item');
      const stageBtn = fileItems[0].querySelector('.file-action[title="Stage"]');
      expect(stageBtn).to.not.be.null;

      stageBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      // Verify get_status was called again after staging
      const statusCalls = findCommands('get_status');
      expect(statusCalls.length).to.be.greaterThan(0);
    });

    it('stages selected files when stage button on a selected file is clicked', async () => {
      const el = await renderFileStatus();

      // Select two unstaged files
      const fileItems = el.shadowRoot!.querySelectorAll('.file-item');
      const stagedCount = 4;
      // Click first unstaged file
      fileItems[stagedCount].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await el.updateComplete;
      // Ctrl+click second unstaged file
      fileItems[stagedCount + 1].dispatchEvent(
        new MouseEvent('click', { bubbles: true, ctrlKey: true }),
      );
      await el.updateComplete;

      clearHistory();

      // Click the stage button on one of the selected files - should stage all selected
      const updatedItems = el.shadowRoot!.querySelectorAll('.file-item');
      const stageBtn = updatedItems[stagedCount].querySelector('.file-action[title="Stage"]');
      expect(stageBtn).to.not.be.null;

      stageBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const stageCalls = findCommands('stage_files');
      expect(stageCalls.length).to.be.greaterThan(0);
      const stageArgs = stageCalls[0].args as { path: string; paths: string[] };
      expect(stageArgs.paths.length).to.equal(2);
    });
  });

  // ── 7. Partial staging ───────────────────────────────────────────────
  describe('partial staging', () => {
    it('marks file with partial-staged class when it appears in both staged and unstaged', async () => {
      const el = await renderFileStatus();

      const partialItems = el.shadowRoot!.querySelectorAll('.file-item.partial-staged');
      // src/partial.ts should appear in both staged and unstaged
      expect(partialItems.length).to.be.greaterThanOrEqual(1);
    });

    it('shows partial-indicator or partial-badge for partially staged files', async () => {
      const el = await renderFileStatus();

      const partialItems = el.shadowRoot!.querySelectorAll('.file-item.partial-staged');
      expect(partialItems.length).to.be.greaterThan(0);

      const firstPartial = partialItems[0];
      const hasIndicator = firstPartial.querySelector('.partial-indicator') !== null;
      const hasBadge = firstPartial.querySelector('.partial-badge') !== null;
      expect(hasIndicator || hasBadge).to.be.true;
    });
  });

  // ── 8. Context menu ──────────────────────────────────────────────────
  describe('context menu', () => {
    it('shows context menu on right-click', async () => {
      const el = await renderFileStatus();

      const fileItems = el.shadowRoot!.querySelectorAll('.file-item');
      fileItems[0].dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
      );
      await el.updateComplete;

      const contextMenu = el.shadowRoot!.querySelector('.context-menu');
      expect(contextMenu).to.not.be.null;
    });

    it('shows "Unstage" menu item for staged file context menu', async () => {
      const el = await renderFileStatus();

      // Right-click on first staged file
      const sections = el.shadowRoot!.querySelectorAll('.section');
      const stagedFiles = sections[0].querySelectorAll('.file-item');
      stagedFiles[0].dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
      );
      await el.updateComplete;

      const menuItems = el.shadowRoot!.querySelectorAll('.context-menu-item');
      const unstageItem = Array.from(menuItems).find(
        (item) => item.textContent!.trim().includes('Unstage'),
      );
      expect(unstageItem).to.not.be.undefined;
    });

    it('shows "Stage" menu item for unstaged file context menu', async () => {
      const el = await renderFileStatus();

      // Right-click on first unstaged file
      const sections = el.shadowRoot!.querySelectorAll('.section');
      const unstagedFiles = sections[1].querySelectorAll('.file-item');
      unstagedFiles[0].dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
      );
      await el.updateComplete;

      const menuItems = el.shadowRoot!.querySelectorAll('.context-menu-item');
      const stageItem = Array.from(menuItems).find(
        (item) => item.textContent!.trim().includes('Stage'),
      );
      expect(stageItem).to.not.be.undefined;
    });

    it('reveals the selected file through the native file-manager command', async () => {
      const el = await renderFileStatus();
      const windowsPath = String.raw`C:\repo\src\app.ts`;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'plugin:path|join') return windowsPath;
        if (command === 'reveal_in_file_manager') {
          return { success: true, message: null };
        }
        return baseMock(command, args);
      };

      const stagedItem = el.shadowRoot!.querySelector('.section .file-item')!;
      stagedItem.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
      );
      await el.updateComplete;
      const revealItem = Array.from(
        el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.context-menu-item'),
      ).find((item) => item.textContent?.includes('Reveal'));
      expect(revealItem).to.not.be.undefined;

      revealItem!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const revealCalls = findCommands('reveal_in_file_manager');
      expect(revealCalls).to.have.length(1);
      expect((revealCalls[0].args as { path: string }).path).to.equal(windowsPath);
      expect(findCommands('plugin:shell|open')).to.have.length(0);
    });

    it('shows an error toast when the reveal command is rejected', async () => {
      const el = await renderFileStatus();
      const windowsPath = String.raw`C:\repo\src\app.ts`;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'plugin:path|join') return windowsPath;
        if (command === 'reveal_in_file_manager') {
          return Promise.reject({
            code: 'INVALID_PATH',
            message: String.raw`Invalid path: C:\repo\src\app.ts`,
          });
        }
        return baseMock(command, args);
      };

      uiStore.setState({ toasts: [] });

      const stagedItem = el.shadowRoot!.querySelector('.section .file-item')!;
      stagedItem.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
      );
      await el.updateComplete;
      const revealItem = Array.from(
        el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.context-menu-item'),
      ).find((item) => item.textContent?.includes('Reveal'));
      expect(revealItem).to.not.be.undefined;

      revealItem!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const toasts = uiStore.getState().toasts;
      expect(toasts).to.have.length(1);
      expect(toasts[0].type).to.equal('error');
      expect(toasts[0].message).to.equal(String.raw`Invalid path: C:\repo\src\app.ts`);
    });

    it('does not offer Reveal for a deleted file that no longer exists', async () => {
      const el = await renderFileStatus();
      const deletedItem = Array.from(el.shadowRoot!.querySelectorAll<HTMLElement>('.file-item')).find(
        (item) => item.textContent?.includes('README.md'),
      )!;
      deletedItem.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
      );
      await el.updateComplete;

      const menuText = Array.from(
        el.shadowRoot!.querySelectorAll<HTMLElement>('.context-menu-item'),
      ).map((item) => item.textContent ?? '');
      expect(menuText.some((text) => text.includes('Copy file path'))).to.be.true;
      expect(menuText.some((text) => text.includes('Reveal'))).to.be.false;
    });

    it('shows "Discard changes" menu item with danger class on an unstaged row', async () => {
      const el = await renderFileStatus();

      // Section 0 is Staged, section 1 is Changes. Discard is meaningful only
      // on the latter: for a path already in the index, discard_changes
      // restores the worktree FROM the index, so on a staged row it is a
      // byte-identical rewrite that does nothing.
      const unstagedItems = el.shadowRoot!.querySelectorAll('.section')[1].querySelectorAll('.file-item');
      unstagedItems[0].dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
      );
      await el.updateComplete;

      const dangerItems = el.shadowRoot!.querySelectorAll('.context-menu-item.danger');
      expect(dangerItems.length).to.be.greaterThan(0);
      const discardItem = Array.from(dangerItems).find(
        (item) => item.textContent!.trim().includes('Discard'),
      );
      expect(discardItem).to.not.be.undefined;
    });

    it('does not offer Discard on a staged row', async () => {
      const el = await renderFileStatus();

      const stagedItems = el.shadowRoot!.querySelectorAll('.section')[0].querySelectorAll('.file-item');
      stagedItems[0].dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
      );
      await el.updateComplete;

      const items = Array.from(el.shadowRoot!.querySelectorAll('.context-menu-item'));
      expect(items.some((i) => i.textContent!.includes('Discard'))).to.equal(false);
    });
  });

  // ── 8b. File history and blame ───────────────────────────────────────
  describe('file history and blame', () => {
    function openMenuFor(el: LvFileStatus, pathText: string): void {
      const item = Array.from(
        el.shadowRoot!.querySelectorAll<HTMLElement>('.file-item'),
      ).find((row) => row.getAttribute('title')?.startsWith(pathText));
      expect(item, `no file row for ${pathText}`).to.not.be.undefined;
      item!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }),
      );
    }

    function menuItem(el: LvFileStatus, label: string): HTMLButtonElement | undefined {
      return Array.from(
        el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.context-menu-item'),
      ).find((item) => item.textContent!.trim().startsWith(label));
    }

    it('offers "File history" and "Blame" for a tracked modified file', async () => {
      const el = await renderFileStatus();

      openMenuFor(el, 'src/utils/helper.ts');
      await el.updateComplete;

      const history = menuItem(el, 'File history');
      const blame = menuItem(el, 'Blame');
      expect(history).to.not.be.undefined;
      expect(blame).to.not.be.undefined;
      expect(history!.getAttribute('aria-disabled')).to.equal('false');
      expect(blame!.getAttribute('aria-disabled')).to.equal('false');
    });

    it('dispatches show-file-history with the file path', async () => {
      const el = await renderFileStatus();
      let detail: { filePath: string } | null = null;
      el.addEventListener('show-file-history', (e) => {
        detail = (e as CustomEvent).detail;
      });

      openMenuFor(el, 'src/utils/helper.ts');
      await el.updateComplete;
      menuItem(el, 'File history')!.click();
      await el.updateComplete;

      expect(detail).to.not.be.null;
      expect(detail!.filePath).to.equal('src/utils/helper.ts');
      // The menu closes on the same gesture, like every sibling item.
      expect(el.shadowRoot!.querySelector('.context-menu')).to.be.null;
    });

    it('dispatches show-blame with the file path and no commit oid', async () => {
      const el = await renderFileStatus();
      let detail: { filePath: string; commitOid?: string } | null = null;
      el.addEventListener('show-blame', (e) => {
        detail = (e as CustomEvent).detail;
      });

      openMenuFor(el, 'src/utils/helper.ts');
      await el.updateComplete;
      menuItem(el, 'Blame')!.click();
      await el.updateComplete;

      expect(detail).to.not.be.null;
      expect(detail!.filePath).to.equal('src/utils/helper.ts');
      // No oid: the backend blames the working copy against HEAD.
      expect(detail!.commitOid).to.equal(undefined);
      expect(el.shadowRoot!.querySelector('.context-menu')).to.be.null;
    });

    it('offers both on a staged tracked file too', async () => {
      const el = await renderFileStatus();
      let detail: { filePath: string } | null = null;
      el.addEventListener('show-file-history', (e) => {
        detail = (e as CustomEvent).detail;
      });

      openMenuFor(el, 'src/app.ts');
      await el.updateComplete;
      expect(menuItem(el, 'Blame')).to.not.be.undefined;
      menuItem(el, 'File history')!.click();
      await el.updateComplete;

      expect(detail!.filePath).to.equal('src/app.ts');
    });

    it('marks both unavailable for an untracked file', async () => {
      const el = await renderFileStatus();

      openMenuFor(el, 'temp.log');
      await el.updateComplete;

      const history = menuItem(el, 'File history')!;
      const blame = menuItem(el, 'Blame')!;
      expect(history.getAttribute('aria-disabled')).to.equal('true');
      expect(blame.getAttribute('aria-disabled')).to.equal('true');
      expect(history.classList.contains('disabled')).to.be.true;
      expect(blame.classList.contains('disabled')).to.be.true;
      expect(history.getAttribute('title')).to.contain('no history');
    });

    it('explains rather than dispatching when an untracked file is picked', async () => {
      const el = await renderFileStatus();
      uiStore.setState({ toasts: [] });
      let dispatched = false;
      el.addEventListener('show-file-history', () => {
        dispatched = true;
      });

      openMenuFor(el, 'temp.log');
      await el.updateComplete;
      menuItem(el, 'File history')!.click();
      await el.updateComplete;

      expect(dispatched).to.be.false;
      const toasts = uiStore.getState().toasts;
      expect(toasts).to.have.length(1);
      expect(toasts[0].type).to.equal('warning');
      expect(toasts[0].message).to.contain('temp.log');
      expect(toasts[0].message).to.contain('no history');
    });

    it('marks both unavailable for a path staged as new', async () => {
      const el = await renderFileStatus();

      openMenuFor(el, 'src/new-file.ts');
      await el.updateComplete;

      expect(menuItem(el, 'File history')!.getAttribute('aria-disabled')).to.equal('true');
      expect(menuItem(el, 'Blame')!.getAttribute('aria-disabled')).to.equal('true');
    });

    it('offers history but not blame for a deleted file', async () => {
      const el = await renderFileStatus();

      openMenuFor(el, 'README.md');
      await el.updateComplete;

      expect(menuItem(el, 'File history')).to.not.be.undefined;
      expect(menuItem(el, 'Blame')).to.be.undefined;
    });

    it('h and b open history and blame for the focused file', async () => {
      const el = await renderFileStatus();
      let historyPath: string | null = null;
      let blamePath: string | null = null;
      el.addEventListener('show-file-history', (e) => {
        historyPath = (e as CustomEvent).detail.filePath;
      });
      el.addEventListener('show-blame', (e) => {
        blamePath = (e as CustomEvent).detail.filePath;
      });

      // First press moves focus onto the first row (the staged src/app.ts).
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await el.updateComplete;

      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
      await el.updateComplete;

      expect(historyPath).to.equal('src/app.ts');
      expect(blamePath).to.equal('src/app.ts');
    });

    it('leaves Ctrl+B to the panel shortcut instead of opening blame', async () => {
      const el = await renderFileStatus();
      let dispatched = false;
      el.addEventListener('show-blame', () => {
        dispatched = true;
      });

      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await el.updateComplete;
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }),
      );
      await el.updateComplete;

      expect(dispatched).to.be.false;
    });
  });

  // ── 9. Error handling ────────────────────────────────────────────────
  describe('error handling', () => {
    it('shows error element when get_status throws', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_status':
            throw new Error('Repository not found');
          case 'start_watching':
            return null;
          default:
            return null;
        }
      };

      const el = await renderFileStatus();

      const errorEl = el.shadowRoot!.querySelector('.error');
      expect(errorEl).to.not.be.null;
      expect(errorEl!.textContent).to.include('Repository not found');
    });

    it('shows error when get_status returns unsuccessful result', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_status':
            // invokeCommand wraps errors as CommandResult, but the raw invoke
            // just returns data or throws. The component calls gitService.getStatus
            // which calls invokeCommand, which catches the throw and returns
            // { success: false, error: { message: ... } }.
            // So throwing here simulates the Tauri invoke failing.
            throw new Error('Permission denied');
          case 'start_watching':
            return null;
          default:
            return null;
        }
      };

      const el = await renderFileStatus();

      const errorEl = el.shadowRoot!.querySelector('.error');
      expect(errorEl).to.not.be.null;
    });
  });

  // ── 10. Loading state ────────────────────────────────────────────────
  describe('loading state', () => {
    it('shows loading element during initial fetch', async () => {
      // Use a slow mock to catch the loading state
      let resolveStatus: ((value: unknown) => void) | null = null;
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_status':
            return new Promise((resolve) => {
              resolveStatus = resolve;
            });
          case 'start_watching':
            return null;
          default:
            return null;
        }
      };

      const el = await fixture<LvFileStatus>(
        html`<lv-file-status .repositoryPath=${REPO_PATH}></lv-file-status>`,
      );
      await el.updateComplete;

      // While status is loading, should show loading indicator
      const loadingEl = el.shadowRoot!.querySelector('.loading');
      expect(loadingEl).to.not.be.null;
      expect(loadingEl!.textContent).to.include('Loading');

      // Resolve to clean up
      if (resolveStatus) {
        (resolveStatus as (value: unknown) => void)(mockStatusEntries);
      }
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;
    });
  });

  // ── 11. Status changed event ─────────────────────────────────────────
  describe('status-changed event', () => {
    it('dispatches status-changed with correct counts on initial load', async () => {
      let eventDetail: { stagedCount: number; totalCount: number } | null = null;

      const el = await fixture<LvFileStatus>(
        html`<lv-file-status
          .repositoryPath=${REPO_PATH}
          @status-changed=${(e: CustomEvent) => {
            eventDetail = e.detail;
          }}
        ></lv-file-status>`,
      );
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(eventDetail).to.not.be.null;
      expect(eventDetail!.stagedCount).to.equal(4); // 4 staged files
      expect(eventDetail!.totalCount).to.equal(8); // 8 total entries
    });

    it('dispatches updated counts after stage operation', async () => {
      const postStageEntries = [
        // After staging src/utils/helper.ts, it moves from unstaged to staged
        { path: 'src/app.ts', status: 'modified', isStaged: true, isConflicted: false },
        { path: 'src/utils/helper.ts', status: 'modified', isStaged: true, isConflicted: false },
        { path: 'src/new-file.ts', status: 'new', isStaged: true, isConflicted: false },
        { path: 'README.md', status: 'deleted', isStaged: false, isConflicted: false },
        { path: 'src/renamed.ts', status: 'renamed', isStaged: true, isConflicted: false },
        { path: 'temp.log', status: 'untracked', isStaged: false, isConflicted: false },
        { path: 'src/partial.ts', status: 'modified', isStaged: true, isConflicted: false },
        { path: 'src/partial.ts', status: 'modified', isStaged: false, isConflicted: false },
      ];

      setupDefaultMocks({ postStageEntries });
      const events: Array<{ stagedCount: number; totalCount: number }> = [];

      const el = await fixture<LvFileStatus>(
        html`<lv-file-status
          .repositoryPath=${REPO_PATH}
          @status-changed=${(e: CustomEvent) => {
            events.push(e.detail);
          }}
        ></lv-file-status>`,
      );
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      // Should have received initial event
      expect(events.length).to.be.greaterThanOrEqual(1);
      const initialEvent = events[0];
      expect(initialEvent.stagedCount).to.equal(4);

      // Now stage a file
      const sections = el.shadowRoot!.querySelectorAll('.section');
      const unstagedSection = sections[1];
      const fileItems = unstagedSection.querySelectorAll('.file-item');
      const stageBtn = fileItems[0].querySelector('.file-action[title="Stage"]');
      expect(stageBtn).to.not.be.null;

      stageBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      await el.updateComplete;

      // Should have received another event with updated counts
      expect(events.length).to.be.greaterThan(1);
      const lastEvent = events[events.length - 1];
      expect(lastEvent.stagedCount).to.equal(5); // 5 staged files now
    });
  });

  // ── Multi-repo behavior ──────────────────────────────────────────────
  // ── Path filter ──────────────────────────────────────────────────────
  describe('path filter', () => {
    function filterInput(el: LvFileStatus): HTMLInputElement {
      const input = el.shadowRoot!.querySelector('.filter-input');
      expect(input, 'filter input is rendered').to.not.be.null;
      return input as HTMLInputElement;
    }

    async function typeFilter(el: LvFileStatus, value: string): Promise<void> {
      const input = filterInput(el);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      await el.updateComplete;
    }

    function filePaths(el: LvFileStatus, sectionIndex?: number): string[] {
      const root =
        sectionIndex === undefined
          ? (el.shadowRoot! as ParentNode)
          : el.shadowRoot!.querySelectorAll('.section')[sectionIndex];
      return Array.from(root.querySelectorAll('.file-item')).map((item) =>
        (item.getAttribute('title') ?? '').replace(' (partially staged)', ''),
      );
    }

    async function switchToTree(el: LvFileStatus): Promise<void> {
      const viewToggle = el.shadowRoot!.querySelector('.view-toggle')!;
      viewToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await el.updateComplete;
    }

    it('narrows the flat list to files whose path matches, case-insensitively', async () => {
      const el = await renderFileStatus();

      await typeFilter(el, 'HELP');

      expect(filePaths(el)).to.deep.equal(['src/utils/helper.ts']);
    });

    it('matches on the full path so a directory fragment narrows the list', async () => {
      const el = await renderFileStatus();

      await typeFilter(el, 'src/utils/');

      expect(filePaths(el)).to.deep.equal(['src/utils/helper.ts']);
    });

    it('keeps a file whose basename matches even with no directory in the query', async () => {
      const el = await renderFileStatus();

      await typeFilter(el, 'readme.md');

      expect(filePaths(el)).to.deep.equal(['README.md']);
    });

    it('keeps ancestor directories and shows no empty ones in tree view', async () => {
      const el = await renderFileStatus();
      await switchToTree(el);

      await typeFilter(el, 'helper');

      const folderNames = Array.from(
        el.shadowRoot!.querySelectorAll('.folder-item'),
      ).map((item) => item.querySelector('.folder-name')!.textContent!.trim());
      // src and utils are the ancestors of the single match; no other folder
      // (and no empty folder) survives.
      expect(folderNames).to.deep.equal(['src', 'utils']);
      expect(filePaths(el)).to.deep.equal(['src/utils/helper.ts']);
    });

    it('reveals matches buried in collapsed folders in tree view', async () => {
      const el = await renderFileStatus();
      await switchToTree(el);

      // Collapse every folder first, so a match would otherwise stay hidden.
      const folders = el.shadowRoot!.querySelectorAll('.folder-item');
      for (const folder of Array.from(folders)) {
        folder.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await el.updateComplete;
      }

      await typeFilter(el, 'helper');

      expect(filePaths(el)).to.deep.equal(['src/utils/helper.ts']);
    });

    it('shows "matches of total" counts without hiding the real totals', async () => {
      const el = await renderFileStatus();

      await typeFilter(el, 'helper');

      const sections = el.shadowRoot!.querySelectorAll('.section');
      const stagedCount = sections[0].querySelector('.section-count')!;
      const unstagedCount = sections[1].querySelector('.section-count')!;
      expect(stagedCount.textContent!.trim()).to.equal('0 of 4');
      expect(unstagedCount.textContent!.trim()).to.equal('1 of 4');

      // Header labels stay truthful for assistive tech too
      const unstagedHeader = sections[1].querySelector('.section-header')!;
      expect(unstagedHeader.getAttribute('aria-label')).to.equal(
        'Unstaged changes, 1 of 4 files match the filter',
      );
    });

    it('restores the plain totals once the filter is cleared', async () => {
      const el = await renderFileStatus();
      await typeFilter(el, 'helper');
      await typeFilter(el, '');

      const sections = el.shadowRoot!.querySelectorAll('.section');
      expect(sections[0].querySelector('.section-count')!.textContent!.trim()).to.equal(
        '4',
      );
      expect(sections[1].querySelector('.section-count')!.textContent!.trim()).to.equal(
        '4',
      );
      expect(filePaths(el).length).to.equal(8);
    });

    it('clears the filter with the x button', async () => {
      const el = await renderFileStatus();
      await typeFilter(el, 'helper');
      expect(filePaths(el).length).to.equal(1);

      const clearBtn = el.shadowRoot!.querySelector('.filter-clear');
      expect(clearBtn).to.not.be.null;
      clearBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await el.updateComplete;

      expect(filterInput(el).value).to.equal('');
      expect(filePaths(el).length).to.equal(8);
      expect(el.shadowRoot!.querySelector('.filter-clear')).to.be.null;
    });

    it('clears the filter when Escape is pressed in the input', async () => {
      const el = await renderFileStatus();
      await typeFilter(el, 'helper');

      const input = filterInput(el);
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }),
      );
      await el.updateComplete;

      expect(filterInput(el).value).to.equal('');
      expect(filePaths(el).length).to.equal(8);
    });

    it('lets Escape through when the filter is already empty', async () => {
      const el = await renderFileStatus();

      const input = filterInput(el);
      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      input.dispatchEvent(escape);
      await el.updateComplete;

      expect(escape.defaultPrevented).to.be.false;
    });

    it('does not treat typing in the filter as a bare keyboard shortcut', async () => {
      const el = await renderFileStatus();
      clearHistory();

      const input = filterInput(el);
      // "s" and "u" are the bare stage/unstage shortcuts on the host element.
      for (const key of ['s', 'u']) {
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, composed: true }),
        );
      }
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(findCommands('stage_files').length).to.equal(0);
      expect(findCommands('unstage_files').length).to.equal(0);
    });

    it('shows an empty-result state with a clear action when nothing matches', async () => {
      const el = await renderFileStatus();

      await typeFilter(el, 'nothing-here');

      const empty = el.shadowRoot!.querySelector('.no-match-state');
      expect(empty).to.not.be.null;
      expect(empty!.textContent).to.include('No files match');
      expect(empty!.textContent).to.include('nothing-here');
      expect(filePaths(el).length).to.equal(0);

      const clear = empty!.querySelector('.no-match-clear')!;
      clear.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.no-match-state')).to.be.null;
      expect(filePaths(el).length).to.equal(8);
    });

    it('announces the match count in the polite live region', async () => {
      const el = await renderFileStatus();
      await typeFilter(el, 'helper');

      const live = el.shadowRoot!.querySelector('[aria-live="polite"]')!;
      expect(live.textContent).to.include('1 of 8 files match helper');

      await typeFilter(el, 'nothing-here');
      const liveAfter = el.shadowRoot!.querySelector('[aria-live="polite"]')!;
      expect(liveAfter.textContent).to.include('No files match nothing-here');
    });

    it('exposes a labelled, focusable filter input', async () => {
      const el = await renderFileStatus();
      const input = filterInput(el);

      expect(input.getAttribute('aria-label')).to.equal(
        'Filter changed files by path',
      );
      input.focus();
      expect(el.shadowRoot!.activeElement).to.equal(input);
    });

    it('resets the filter when the repository changes', async () => {
      const el = await renderFileStatus();
      await typeFilter(el, 'helper');
      expect(filePaths(el).length).to.equal(1);

      el.repositoryPath = '/other/repo';
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 60));
      await el.updateComplete;

      expect(filterInput(el).value).to.equal('');
      expect(filePaths(el).length).to.equal(8);
    });

    it('scopes the section Stage-all button to the filtered files only', async () => {
      const el = await renderFileStatus();
      await typeFilter(el, 'helper');
      clearHistory();

      const unstagedSection = el.shadowRoot!.querySelectorAll('.section')[1];
      const stageAllBtn = unstagedSection.querySelector(
        '.section-actions .section-action',
      )!;
      // The label says what it will act on, so the scope is not a surprise
      expect(stageAllBtn.getAttribute('title')).to.equal(
        'Stage 1 file matching the filter',
      );

      stageAllBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const stageCalls = findCommands('stage_files');
      expect(stageCalls.length).to.equal(1);
      const args = stageCalls[0].args as { paths: string[] };
      expect(args.paths).to.deep.equal(['src/utils/helper.ts']);
    });

    it('scopes the section Unstage-all button to the filtered files only', async () => {
      const el = await renderFileStatus();
      await typeFilter(el, 'app.ts');
      clearHistory();

      const stagedSection = el.shadowRoot!.querySelectorAll('.section')[0];
      const unstageAllBtn = stagedSection.querySelector(
        '.section-actions .section-action',
      )!;
      expect(unstageAllBtn.getAttribute('title')).to.equal(
        'Unstage 1 file matching the filter',
      );

      unstageAllBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const args = findCommands('unstage_files')[0].args as { paths: string[] };
      expect(args.paths).to.deep.equal(['src/app.ts']);
    });

    it('gives the global "stage-all" event the same set as the header button', async () => {
      // The palette entry and the s shortcut arrive as this window event.
      // They used to stage EVERYTHING while the header button next to the list
      // staged only the matches, so "stage all" meant two different things in
      // the same repo at the same moment.
      const el = await renderFileStatus();
      await typeFilter(el, 'helper');
      clearHistory();
      uiStore.setState({ toasts: [] });

      window.dispatchEvent(new CustomEvent('stage-all'));
      await waitUntil(() => uiStore.getState().toasts.length > 0, 'the scope toast');
      await el.updateComplete;

      const args = findCommands('stage_files')[0].args as { paths: string[] };
      expect(args.paths).to.deep.equal(['src/utils/helper.ts']);

      // And says what "all" meant, because the surface that fired it says ALL.
      const messages = uiStore.getState().toasts.map((t) => t.message);
      expect(messages.some((m) => m.includes('Staged 1 of 4 files'))).to.equal(true);
      expect(messages.some((m) => m.includes('helper'))).to.equal(true);
    });

    it('gives the global "unstage-all" event the same set as the header button', async () => {
      const el = await renderFileStatus();
      await typeFilter(el, 'app.ts');
      clearHistory();
      uiStore.setState({ toasts: [] });

      window.dispatchEvent(new CustomEvent('unstage-all'));
      await waitUntil(() => uiStore.getState().toasts.length > 0, 'the scope toast');
      await el.updateComplete;

      const args = findCommands('unstage_files')[0].args as { paths: string[] };
      expect(args.paths).to.deep.equal(['src/app.ts']);

      const messages = uiStore.getState().toasts.map((t) => t.message);
      expect(messages.some((m) => m.includes('Unstaged 1 of 4 files'))).to.equal(true);
    });

    it('says nothing extra when the filter is not hiding anything', async () => {
      const el = await renderFileStatus();
      clearHistory();
      uiStore.setState({ toasts: [] });

      window.dispatchEvent(new CustomEvent('stage-all'));
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const args = findCommands('stage_files')[0].args as { paths: string[] };
      expect(args.paths.length).to.equal(4);
      expect(uiStore.getState().toasts.length).to.equal(0);
    });

    it('reports a global stage-all that a filter narrowed to nothing', async () => {
      // Previously this staged all 4 unstaged files; now it stages none, so
      // the shortcut must not simply do nothing in silence.
      const el = await renderFileStatus();
      await typeFilter(el, 'no-such-file');
      clearHistory();
      uiStore.setState({ toasts: [] });

      window.dispatchEvent(new CustomEvent('stage-all'));
      await waitUntil(() => uiStore.getState().toasts.length > 0, 'the scope toast');
      await el.updateComplete;

      expect(findCommands('stage_files').length).to.equal(0);
      const messages = uiStore.getState().toasts.map((t) => t.message);
      expect(messages.some((m) => m.includes('Nothing to stage'))).to.equal(true);
      expect(messages.some((m) => m.includes('no-such-file'))).to.equal(true);
    });

    it('says what the section header button covered too, so all three agree', async () => {
      const el = await renderFileStatus();
      await typeFilter(el, 'helper');
      clearHistory();
      uiStore.setState({ toasts: [] });

      const unstagedSection = el.shadowRoot!.querySelectorAll('.section')[1];
      unstagedSection
        .querySelector('.section-actions .section-action')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await waitUntil(() => uiStore.getState().toasts.length > 0, 'the scope toast');
      await el.updateComplete;

      const args = findCommands('stage_files')[0].args as { paths: string[] };
      expect(args.paths).to.deep.equal(['src/utils/helper.ts']);
      expect(
        uiStore
          .getState()
          .toasts.map((t) => t.message)
          .some((m) => m.includes('Staged 1 of 4 files')),
      ).to.equal(true);
    });

    it('drops selected files the filter hides, so batch actions cannot reach them', async () => {
      const el = await renderFileStatus();

      const unstagedSection = el.shadowRoot!.querySelectorAll('.section')[1];
      const items = Array.from(unstagedSection.querySelectorAll('.file-item'));
      for (const item of items) {
        item.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
        await el.updateComplete;
      }
      expect(
        el
          .shadowRoot!.querySelectorAll('.section')[1]
          .querySelector('.selection-count')!.textContent,
      ).to.include(`${items.length} selected`);

      await typeFilter(el, 'helper');

      const sectionAfter = el.shadowRoot!.querySelectorAll('.section')[1];
      expect(sectionAfter.querySelector('.selection-count')!.textContent).to.include(
        '1 selected',
      );

      clearHistory();
      const stageSelected = Array.from(
        sectionAfter.querySelectorAll('.selection-action-btn'),
      ).find((b) => b.textContent!.trim() === 'Stage')!;
      stageSelected.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const args = findCommands('stage_files')[0].args as { paths: string[] };
      expect(args.paths).to.deep.equal(['src/utils/helper.ts']);
    });

    it('scopes a tree-view directory action to the filtered files under it', async () => {
      const el = await renderFileStatus();
      await switchToTree(el);
      await typeFilter(el, 'helper');
      clearHistory();

      const unstagedSection = el.shadowRoot!.querySelectorAll('.section')[1];
      const srcFolder = Array.from(
        unstagedSection.querySelectorAll('.folder-item'),
      ).find(
        (f) => f.querySelector('.folder-name')!.textContent!.trim() === 'src',
      )!;
      // The folder count reflects the filtered subtree
      expect(srcFolder.querySelector('.folder-count')!.textContent!.trim()).to.equal(
        '1',
      );

      const stageDirBtn = Array.from(
        srcFolder.querySelectorAll('.file-action'),
      ).find((b) => b.getAttribute('title') === 'Stage directory')!;
      stageDirBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const args = findCommands('stage_files')[0].args as { paths: string[] };
      expect(args.paths).to.deep.equal(['src/utils/helper.ts']);
    });
  });

  describe('multi-repo behavior', () => {
    function openRepoInStore(path: string): void {
      repositoryStore.getState().addRepository({
        path,
        name: path.split('/').pop() ?? path,
        isValid: true,
        isBare: false,
        headRef: 'main',
        state: 'clean',
        isShallow: false,
        isPartialClone: false,
        cloneFilter: null,
      } as Repository);
    }

    beforeEach(() => {
      repositoryStore.getState().reset();
    });

    it('mirrors loaded status into the repository store for the tab dirty badge', async () => {
      openRepoInStore(REPO_PATH);
      setupDefaultMocks();
      const el = await renderFileStatus();
      await el.updateComplete;

      const repo = repositoryStore.getState().openRepositories[0];
      expect(repo.status.length).to.equal(mockStatusEntries.length);
      expect(repo.stagedFiles.length).to.equal(4);
      expect(repo.unstagedFiles.length).to.equal(4);
    });

    it('ignores watcher events from OTHER repos', async () => {
      setupDefaultMocks();
      const el = await renderFileStatus();
      clearHistory();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).handleWatcherEvent({
        repoPath: '/some/other/repo',
        eventType: 'workdir-changed',
        paths: [],
      });
      await new Promise((r) => setTimeout(r, 400)); // past the 300ms debounce

      expect(findCommands('get_status').length).to.equal(0);
    });

    it('a stale status result must not overwrite the newly active repo panel', async () => {
      // Regression: switch tabs while a slow get_status for the OLD repo is
      // in flight; its late result used to overwrite the panel now showing
      // the NEW repo (destructive-action risk on same-named files).
      openRepoInStore(REPO_PATH);
      let releaseSlow!: () => void;
      const slowGate = new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      const slowEntries = [
        { path: 'stale-repo-file.ts', status: 'modified', isStaged: false, isConflicted: false },
      ];
      const fastEntries = [
        { path: 'fresh-repo-file.ts', status: 'modified', isStaged: true, isConflicted: false },
      ];
      let statusCalls = 0;
      mockInvoke = async (command: string) => {
        if (command === 'get_status') {
          statusCalls++;
          if (statusCalls === 1) {
            await slowGate;
            return slowEntries;
          }
          return fastEntries;
        }
        return null;
      };

      // First load (for REPO_PATH) hangs on the gate
      const el = await fixture<LvFileStatus>(
        html`<lv-file-status .repositoryPath=${REPO_PATH}></lv-file-status>`,
      );
      await el.updateComplete;

      // Switch tabs; the second load resolves immediately
      el.repositoryPath = '/other/repo';
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 20));

      // Now the stale first load lands
      releaseSlow();
      await new Promise((r) => setTimeout(r, 20));

      // The visible panel keeps the ACTIVE repo's data
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const staged = (el as any).stagedFiles as Array<{ path: string }>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const unstaged = (el as any).unstagedFiles as Array<{ path: string }>;
      expect(staged.map((f) => f.path)).to.deep.equal(['fresh-repo-file.ts']);
      expect(unstaged).to.deep.equal([]);

      // ...while the stale result still reached the store for ITS repo
      const repoA = repositoryStore
        .getState()
        .openRepositories.find((r) => r.repository.path === REPO_PATH);
      expect(repoA!.status.map((s) => s.path)).to.deep.equal(['stale-repo-file.ts']);
    });

    it('an A -> B -> A switch discards the outdated first A load', async () => {
      // Regression: path-equality guards let a REORDERED pair of loads for
      // the same repo apply the older result (reverting a staging change
      // until the next watcher tick).
      openRepoInStore(REPO_PATH);
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const outdatedEntries = [
        { path: 'outdated.ts', status: 'modified', isStaged: false, isConflicted: false },
      ];
      const freshEntries = [
        { path: 'fresh.ts', status: 'modified', isStaged: true, isConflicted: false },
      ];
      let statusCalls = 0;
      mockInvoke = async (command: string) => {
        if (command === 'get_status') {
          statusCalls++;
          if (statusCalls === 1) {
            await firstGate; // A's FIRST load is slow
            return outdatedEntries;
          }
          return freshEntries; // B's load and A's second load are fast
        }
        return null;
      };

      const el = await fixture<LvFileStatus>(
        html`<lv-file-status .repositoryPath=${REPO_PATH}></lv-file-status>`,
      );
      await el.updateComplete;

      // A -> B -> A
      el.repositoryPath = '/other/repo';
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 20));
      el.repositoryPath = REPO_PATH;
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 20));

      // Now A's outdated first load finally lands — it must be discarded
      releaseFirst();
      await new Promise((r) => setTimeout(r, 20));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const staged = (el as any).stagedFiles as Array<{ path: string }>;
      expect(staged.map((f) => f.path)).to.deep.equal(['fresh.ts']);

      const repoA = repositoryStore
        .getState()
        .openRepositories.find((r) => r.repository.path === REPO_PATH);
      expect(repoA!.status.map((s) => s.path)).to.deep.equal(['fresh.ts']);
    });

    it('reloads status on watcher events for ITS repo', async () => {
      setupDefaultMocks();
      const el = await renderFileStatus();
      clearHistory();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).handleWatcherEvent({
        repoPath: REPO_PATH,
        eventType: 'workdir-changed',
        paths: [],
      });
      await new Promise((r) => setTimeout(r, 400));

      expect(findCommands('get_status').length).to.equal(1);
    });

    it('discards against the origin repo even if the user switches tabs during the confirm', async () => {
      // Discard is irreversible. The confirm is an OS dialog wrapper whose
      // await can yield; a tab switch during it rebinds this.repositoryPath.
      // The discard must still run against the repo it was invoked on — else
      // it silently destroys the WRONG repo's uncommitted work.
      openRepoInStore(REPO_PATH);
      const el = await renderFileStatus();

      let resolveConfirm!: (v: unknown) => void;
      mockInvoke = async (command: string) => {
        if (isConfirmCommand(command)) {
          return new Promise((resolve) => {
            resolveConfirm = resolve;
          });
        }
        if (command === 'get_status') return mockStatusEntries;
        return null;
      };

      clearHistory();
      const file = {
        path: 'src/utils/helper.ts',
        status: 'modified',
        isStaged: false,
        isConflicted: false,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const promise = (el as any).handleDiscardFile(file, new Event('click'));

      // The confirm is now in flight; the user switches tabs.
      await new Promise((r) => setTimeout(r, 10));
      el.repositoryPath = '/other/repo';

      resolveConfirm('Ok');
      await promise;

      const discard = findCommands('discard_changes')[0];
      expect(discard, 'discard_changes was called').to.not.be.undefined;
      expect((discard.args as { path: string }).path).to.equal(REPO_PATH);
    });
  });
});
