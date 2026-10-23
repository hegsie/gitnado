/**
 * Workspace Manager Dialog Tests
 *
 * These render the REAL gn-workspace-manager-dialog component, mock only the
 * Tauri invoke layer, and verify the actual component code calls the right
 * commands in the right order and updates its DOM accordingly.
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
import type {
  Workspace,
  WorkspaceRepoStatus,
  WorkspaceSearchResponse,
  WorkspaceSearchResult,
} from '../../../types/git.types.ts';
import type { GnWorkspaceManagerDialog } from '../gn-workspace-manager-dialog.ts';

// Import the actual component — registers <gn-workspace-manager-dialog>
import '../gn-workspace-manager-dialog.ts';
import { uiStore, repositoryStore } from '../../../stores/index.ts';

// ── Test data ──────────────────────────────────────────────────────────────
function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'My Workspace',
    description: 'Test workspace',
    color: '#4fc3f7',
    repositories: [],
    createdAt: '2025-01-01T00:00:00Z',
    lastOpened: null,
    ...overrides,
  };
}

function makeRepoStatus(overrides: Partial<WorkspaceRepoStatus> = {}): WorkspaceRepoStatus {
  return {
    path: '/repos/alpha',
    name: 'alpha',
    exists: true,
    isValidRepo: true,
    changedFilesCount: 0,
    currentBranch: 'main',
    isDetached: false,
    ahead: 0,
    behind: 0,
    ...overrides,
  };
}

const WS_ALPHA: Workspace = makeWorkspace({
  id: 'ws-1',
  name: 'Alpha Workspace',
  description: 'First workspace',
  color: '#4fc3f7',
  repositories: [
    { path: '/repos/alpha', name: 'alpha' },
    { path: '/repos/beta', name: 'beta' },
  ],
});

const WS_BETA: Workspace = makeWorkspace({
  id: 'ws-2',
  name: 'Beta Workspace',
  description: 'Second workspace',
  color: '#81c784',
  repositories: [{ path: '/repos/gamma', name: 'gamma' }],
});

const WS_EMPTY: Workspace = makeWorkspace({
  id: 'ws-3',
  name: 'Empty Workspace',
  description: '',
  color: '#ef5350',
  repositories: [],
});

const STATUS_ALPHA = makeRepoStatus({ path: '/repos/alpha', name: 'alpha', currentBranch: 'main' });
const STATUS_BETA = makeRepoStatus({
  path: '/repos/beta',
  name: 'beta',
  currentBranch: 'develop',
  changedFilesCount: 3,
  ahead: 1,
});
const STATUS_GAMMA = makeRepoStatus({ path: '/repos/gamma', name: 'gamma', currentBranch: 'main' });

// ── Helpers ────────────────────────────────────────────────────────────────
function clearHistory(): void {
  invokeHistory.length = 0;
}

function findCommands(name: string): Array<{ command: string; args?: unknown }> {
  return invokeHistory.filter((h) => h.command === name);
}

/**
 * Answer for the confirm dialog. showConfirm() resolves to
 * (plugin:dialog|message result === okLabel), and the default ok label is 'Ok'.
 */
let confirmAnswer = 'Ok';
/** Result to return from the next plugin:dialog|open invoke (repo picker / file picker). */
let dialogOpenResult: string | null = null;
/** Result to return from the next plugin:dialog|save invoke (save dialog). */
let dialogSaveResult: string | null = null;

function setupDefaultMocks(opts: {
  workspaces?: Workspace[];
  statuses?: WorkspaceRepoStatus[];
  savedWorkspace?: Workspace;
  deleteFails?: boolean;
  searchResults?: WorkspaceSearchResult[];
  searchFailures?: string[];
  searchError?: string;
  exportData?: string;
} = {}): void {
  const workspaces = opts.workspaces ?? [WS_ALPHA, WS_BETA];
  const statuses = opts.statuses ?? [STATUS_ALPHA, STATUS_BETA, STATUS_GAMMA];

  mockInvoke = async (command: string, args?: unknown) => {
    const params = args as Record<string, unknown> | undefined;

    switch (command) {
      // ── Workspace CRUD ────────────────────────────────────────────
      case 'get_workspaces':
        return workspaces;
      case 'save_workspace': {
        const ws = params?.workspace as Workspace | undefined;
        if (opts.savedWorkspace) return opts.savedWorkspace;
        if (ws) {
          return { ...ws, id: ws.id || 'ws-new-1' };
        }
        return null;
      }
      case 'delete_workspace':
        if (opts.deleteFails) throw new Error('Delete failed');
        return undefined;
      case 'validate_workspace_repositories':
        return statuses;
      case 'add_repository_to_workspace':
        return workspaces[0] ?? null;
      case 'remove_repository_from_workspace':
        return workspaces[0] ?? null;
      case 'search_workspace':
        if (opts.searchError) throw new Error(opts.searchError);
        return {
          results: opts.searchResults ?? [],
          failures: opts.searchFailures ?? [],
        };
      case 'export_workspace':
        return opts.exportData ?? '{"id":"ws-1","name":"Alpha"}';
      case 'import_workspace':
        return makeWorkspace({ id: 'ws-imported', name: 'Imported WS' });
      case 'update_workspace_last_opened':
        return undefined;

      // ── Git operations (batch fetch / pull) ───────────────────────
      case 'open_repository':
        return { path: params?.path as string, name: 'repo' };
      case 'fetch':
        return undefined;
      case 'pull':
        return undefined;

      // ── Tauri plugins ─────────────────────────────────────────────
      case 'plugin:notification|is_permission_granted':
        return false;
      case 'plugin:dialog|message':
        return confirmAnswer;
      case 'plugin:dialog|open':
        return dialogOpenResult;
      case 'plugin:dialog|save':
        return dialogSaveResult;
      case 'plugin:fs|read_text_file':
        return '{"id":"ws-file","name":"From File"}';
      case 'plugin:fs|write_text_file':
        return undefined;

      default:
        return null;
    }
  };
}

async function renderDialog(open = true): Promise<GnWorkspaceManagerDialog> {
  const el = await fixture<GnWorkspaceManagerDialog>(
    html`<gn-workspace-manager-dialog ?open=${open}></gn-workspace-manager-dialog>`,
  );
  await el.updateComplete;
  // Wait for async loadWorkspaces triggered by open=true
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
  return el;
}

async function tick(el: GnWorkspaceManagerDialog, ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  await el.updateComplete;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-workspace-manager-dialog', () => {
  beforeEach(() => {
    clearHistory();
    dialogOpenResult = null;
    dialogSaveResult = null;
    setupDefaultMocks();
    confirmAnswer = 'Ok';
  });

  // ── Rendering ──────────────────────────────────────────────────────────
  describe('Rendering', () => {
    it('renders the dialog with header, body and footer when open', async () => {
      const el = await renderDialog();

      const header = el.shadowRoot!.querySelector('.header');
      const body = el.shadowRoot!.querySelector('.body');
      const footer = el.shadowRoot!.querySelector('.footer');

      expect(header).to.not.be.null;
      expect(body).to.not.be.null;
      expect(footer).to.not.be.null;
    });

    it('renders workspace list with names in the left panel', async () => {
      const el = await renderDialog();

      const items = el.shadowRoot!.querySelectorAll('.workspace-item');
      expect(items.length).to.equal(2);

      const names = Array.from(items).map(
        (i) => i.querySelector('.workspace-item-name')?.textContent?.trim(),
      );
      expect(names).to.include('Alpha Workspace');
      expect(names).to.include('Beta Workspace');
    });

    it('renders color dots for each workspace', async () => {
      const el = await renderDialog();

      const dots = el.shadowRoot!.querySelectorAll('.workspace-color-dot');
      expect(dots.length).to.equal(2);
    });

    it('auto-selects the first workspace and shows its repo count', async () => {
      const el = await renderDialog();

      const activeItem = el.shadowRoot!.querySelector('.workspace-item.active');
      expect(activeItem).to.not.be.null;
      expect(activeItem!.textContent).to.include('Alpha Workspace');

      const reposTitle = el.shadowRoot!.querySelector('.repos-title');
      expect(reposTitle).to.not.be.null;
      expect(reposTitle!.textContent).to.include('2');
    });

    it('shows empty state when no workspace is selected', async () => {
      setupDefaultMocks({ workspaces: [] });
      const el = await renderDialog();

      const emptyState = el.shadowRoot!.querySelector('.empty-state');
      expect(emptyState).to.not.be.null;
      expect(emptyState!.textContent).to.include('Select a workspace');
    });

    it('shows "No repositories added yet" for workspace with no repos', async () => {
      setupDefaultMocks({ workspaces: [WS_EMPTY] });
      const el = await renderDialog();

      const noRepos = el.shadowRoot!.querySelector('.no-repos');
      expect(noRepos).to.not.be.null;
      expect(noRepos!.textContent).to.include('No repositories added yet');
    });
  });

  // ── Create Workspace ──────────────────────────────────────────────────
  describe('Create Workspace', () => {
    it('calls save_workspace when "New Workspace" is clicked', async () => {
      const el = await renderDialog();
      clearHistory();

      const newBtn = el.shadowRoot!.querySelector('.new-btn') as HTMLButtonElement;
      expect(newBtn).to.not.be.null;
      expect(newBtn.textContent).to.include('New Workspace');

      newBtn.click();
      await tick(el, 100);

      const saveCalls = findCommands('save_workspace');
      expect(saveCalls.length).to.be.greaterThan(0);

      const savedArg = saveCalls[0].args as Record<string, unknown>;
      const workspace = savedArg.workspace as Workspace;
      expect(workspace.name).to.equal('New Workspace');
      expect(workspace.repositories).to.deep.equal([]);
    });

    it('reloads workspace list after creating a new workspace', async () => {
      const el = await renderDialog();
      clearHistory();

      const newBtn = el.shadowRoot!.querySelector('.new-btn') as HTMLButtonElement;
      newBtn.click();
      await tick(el, 100);

      // After save, should reload workspaces
      const getCalls = findCommands('get_workspaces');
      expect(getCalls.length).to.be.greaterThan(0);
    });
  });

  // ── Edit Workspace ────────────────────────────────────────────────────
  describe('Edit Workspace', () => {
    it('populates editor fields with selected workspace data', async () => {
      const el = await renderDialog();

      const nameInput = el.shadowRoot!.querySelector('.form-input') as HTMLInputElement;
      expect(nameInput).to.not.be.null;
      expect(nameInput.value).to.equal('Alpha Workspace');

      const descTextarea = el.shadowRoot!.querySelector('.form-textarea') as HTMLTextAreaElement;
      expect(descTextarea).to.not.be.null;
      expect(descTextarea.value).to.equal('First workspace');
    });

    it('saves workspace on name input blur', async () => {
      const el = await renderDialog();
      clearHistory();

      const nameInput = el.shadowRoot!.querySelector('.form-input') as HTMLInputElement;
      // Simulate typing a new name
      nameInput.value = 'Renamed Workspace';
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      // Trigger blur to save
      nameInput.dispatchEvent(new Event('blur', { bubbles: true }));
      await tick(el, 100);

      const saveCalls = findCommands('save_workspace');
      expect(saveCalls.length).to.be.greaterThan(0);

      const savedArg = saveCalls[0].args as Record<string, unknown>;
      const workspace = savedArg.workspace as Workspace;
      expect(workspace.name).to.equal('Renamed Workspace');
    });

    it('saves workspace when a color swatch is clicked', async () => {
      const el = await renderDialog();
      clearHistory();

      const swatches = el.shadowRoot!.querySelectorAll('.color-swatch');
      expect(swatches.length).to.equal(8);

      // Click the second swatch (different color)
      (swatches[1] as HTMLButtonElement).click();
      await tick(el, 100);

      const saveCalls = findCommands('save_workspace');
      expect(saveCalls.length).to.be.greaterThan(0);

      const savedArg = saveCalls[0].args as Record<string, unknown>;
      const workspace = savedArg.workspace as Workspace;
      expect(workspace.color).to.equal('#81c784');
    });

    it('switches editor fields when selecting a different workspace', async () => {
      const el = await renderDialog();

      // Click the second workspace
      const items = el.shadowRoot!.querySelectorAll('.workspace-item');
      (items[1] as HTMLButtonElement).click();
      await tick(el);

      const nameInput = el.shadowRoot!.querySelector('.form-input') as HTMLInputElement;
      expect(nameInput.value).to.equal('Beta Workspace');

      const reposTitle = el.shadowRoot!.querySelector('.repos-title');
      expect(reposTitle!.textContent).to.include('1');
    });
  });

  // ── Delete Workspace ──────────────────────────────────────────────────
  describe('Delete Workspace', () => {
    it('asks before dropping a saved workspace, and declining blocks it', async () => {
      // One click used to permanently drop a named multi-repo configuration
      // with no undo, while the sibling profile manager confirmed first.
      const el = await renderDialog();
      clearHistory();
      confirmAnswer = 'Cancel';

      const deleteBtn = el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement;
      deleteBtn.click();
      await tick(el, 100);

      expect(findCommands('delete_workspace').length).to.equal(0);
    });

    it('calls delete_workspace when Delete button is clicked', async () => {
      const el = await renderDialog();
      clearHistory();

      const deleteBtn = el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement;
      expect(deleteBtn).to.not.be.null;
      expect(deleteBtn.textContent).to.include('Delete');

      deleteBtn.click();
      await tick(el, 100);

      const deleteCalls = findCommands('delete_workspace');
      expect(deleteCalls.length).to.equal(1);
      expect((deleteCalls[0].args as Record<string, unknown>).workspaceId).to.equal('ws-1');
    });

    it('reloads workspaces after successful delete', async () => {
      const el = await renderDialog();
      clearHistory();

      const deleteBtn = el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement;
      deleteBtn.click();
      await tick(el, 100);

      const getCalls = findCommands('get_workspaces');
      expect(getCalls.length).to.be.greaterThan(0);
    });

    it('clears selection after deleting a workspace', async () => {
      const el = await renderDialog();

      // Initially a workspace is selected
      let activeItem = el.shadowRoot!.querySelector('.workspace-item.active');
      expect(activeItem).to.not.be.null;

      // After delete, the deletion sets selectedWorkspaceId = null then reloads.
      // Switch mock so reload returns only WS_BETA.
      setupDefaultMocks({ workspaces: [WS_BETA] });
      const deleteBtn = el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement;
      deleteBtn.click();
      await tick(el, 100);

      // After reload, the remaining workspace should be auto-selected
      activeItem = el.shadowRoot!.querySelector('.workspace-item.active');
      expect(activeItem).to.not.be.null;
      expect(activeItem!.textContent).to.include('Beta Workspace');
    });
  });

  // ── Add / Remove Repos ────────────────────────────────────────────────
  describe('Add/Remove Repos', () => {
    it('calls add_repository_to_workspace when a repo is selected via dialog', async () => {
      dialogOpenResult = '/repos/new-repo';
      const el = await renderDialog();
      clearHistory();

      const addBtn = el.shadowRoot!.querySelector('.add-repo-btn') as HTMLButtonElement;
      expect(addBtn).to.not.be.null;
      expect(addBtn.textContent).to.include('Add Repo');

      addBtn.click();
      await tick(el, 100);

      const addCalls = findCommands('add_repository_to_workspace');
      expect(addCalls.length).to.equal(1);

      const addArgs = addCalls[0].args as Record<string, unknown>;
      expect(addArgs.workspaceId).to.equal('ws-1');
      expect(addArgs.path).to.equal('/repos/new-repo');
      expect(addArgs.name).to.equal('new-repo');
    });

    it('does not call add_repository_to_workspace when dialog is cancelled', async () => {
      dialogOpenResult = null;
      const el = await renderDialog();
      clearHistory();

      const addBtn = el.shadowRoot!.querySelector('.add-repo-btn') as HTMLButtonElement;
      addBtn.click();
      await tick(el, 100);

      const addCalls = findCommands('add_repository_to_workspace');
      expect(addCalls.length).to.equal(0);
    });

    it('renders repo items with names', async () => {
      const el = await renderDialog();

      const repoItems = el.shadowRoot!.querySelectorAll('.repo-item');
      expect(repoItems.length).to.equal(2);

      const repoNames = Array.from(repoItems).map(
        (r) => r.querySelector('.repo-name')?.textContent?.trim(),
      );
      expect(repoNames).to.include('alpha');
      expect(repoNames).to.include('beta');
    });

    it('calls remove_repository_from_workspace when remove button is clicked', async () => {
      const el = await renderDialog();
      clearHistory();

      const removeButtons = el.shadowRoot!.querySelectorAll('.repo-remove');
      expect(removeButtons.length).to.equal(2);

      // Remove the first repo
      (removeButtons[0] as HTMLButtonElement).click();
      await tick(el, 100);

      const removeCalls = findCommands('remove_repository_from_workspace');
      expect(removeCalls.length).to.equal(1);

      const removeArgs = removeCalls[0].args as Record<string, unknown>;
      expect(removeArgs.workspaceId).to.equal('ws-1');
      expect(removeArgs.path).to.equal('/repos/alpha');
    });
  });

  // ── Search / Filter ───────────────────────────────────────────────────
  describe('Search/Filter Repos', () => {
    it('renders search input when workspace has repos', async () => {
      const el = await renderDialog();

      const searchInput = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
      expect(searchInput).to.not.be.null;
      expect(searchInput.placeholder).to.include('Search across all repos');
    });

    it('calls search_workspace when search button is clicked', async () => {
      const searchResults: WorkspaceSearchResult[] = [
        {
          repoName: 'alpha',
          repoPath: '/repos/alpha',
          filePath: 'src/main.ts',
          lineNumber: 42,
          lineContent: 'const foo = "bar"',
          matchStart: 6,
          matchEnd: 9,
        },
      ];
      setupDefaultMocks({ searchResults });
      const el = await renderDialog();
      clearHistory();

      const searchInput = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
      searchInput.value = 'foo';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      const searchBtn = el.shadowRoot!.querySelector('.search-btn') as HTMLButtonElement;
      searchBtn.click();
      await tick(el, 100);

      const searchCalls = findCommands('search_workspace');
      expect(searchCalls.length).to.equal(1);

      const searchArgs = searchCalls[0].args as Record<string, unknown>;
      expect(searchArgs.workspaceId).to.equal('ws-1');
      expect(searchArgs.query).to.equal('foo');
    });

    it('renders search results grouped by repo', async () => {
      const searchResults: WorkspaceSearchResult[] = [
        {
          repoName: 'alpha',
          repoPath: '/repos/alpha',
          filePath: 'src/main.ts',
          lineNumber: 42,
          lineContent: 'const foo = "bar"',
          matchStart: 6,
          matchEnd: 9,
        },
        {
          repoName: 'alpha',
          repoPath: '/repos/alpha',
          filePath: 'src/utils.ts',
          lineNumber: 10,
          lineContent: 'export function foo() {}',
          matchStart: 16,
          matchEnd: 19,
        },
      ];
      setupDefaultMocks({ searchResults });
      const el = await renderDialog();

      // Type and search
      const searchInput = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
      searchInput.value = 'foo';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      const searchBtn = el.shadowRoot!.querySelector('.search-btn') as HTMLButtonElement;
      searchBtn.click();
      await tick(el, 150);

      const resultGroups = el.shadowRoot!.querySelectorAll('.search-result-group');
      expect(resultGroups.length).to.equal(1);

      const repoLabel = el.shadowRoot!.querySelector('.search-result-repo');
      expect(repoLabel!.textContent).to.include('alpha');

      const resultItems = el.shadowRoot!.querySelectorAll('.search-result-item');
      expect(resultItems.length).to.equal(2);
    });

    it('calls search_workspace on Enter key in search input', async () => {
      const el = await renderDialog();
      clearHistory();

      const searchInput = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
      searchInput.value = 'test';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick(el, 100);

      const searchCalls = findCommands('search_workspace');
      expect(searchCalls.length).to.equal(1);
    });

    it('shows the repository search failure to the user', async () => {
      setupDefaultMocks({ searchError: 'Failed to search repository "beta": not a git repository' });
      uiStore.setState({ toasts: [] });
      const el = await renderDialog();

      const searchInput = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
      searchInput.value = 'test';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      (el.shadowRoot!.querySelector('.search-btn') as HTMLButtonElement).click();
      await tick(el, 100);

      const toasts = uiStore.getState().toasts;
      expect(toasts[toasts.length - 1].message).to.include('beta');
      expect(toasts[toasts.length - 1].type).to.equal('error');
      expect(el.shadowRoot!.querySelector('.search-failures')!.textContent).to.include('beta');
      expect(el.shadowRoot!.querySelector('.search-no-results')).to.be.null;
    });

    it('reports an empty search only once it has completed', async () => {
      setupDefaultMocks({ searchResults: [], searchFailures: [] });
      const el = await renderDialog();

      const searchInput = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
      searchInput.value = 'nowhere';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      // Typing is not a search: claiming "no results" on the first keystroke
      // would answer a question the user has not asked yet.
      expect(el.shadowRoot!.querySelector('.search-no-results')).to.be.null;

      (el.shadowRoot!.querySelector('.search-btn') as HTMLButtonElement).click();
      await tick(el, 100);

      expect(el.shadowRoot!.querySelector('.search-no-results')!.textContent).to.include(
        'No results found',
      );
    });

    it('says the searched repositories had no matches when one repository failed', async () => {
      setupDefaultMocks({
        searchResults: [],
        searchFailures: ['Failed to search repository "beta": repository path does not exist'],
      });
      const el = await renderDialog();

      const searchInput = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
      searchInput.value = 'test';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;
      (el.shadowRoot!.querySelector('.search-btn') as HTMLButtonElement).click();
      await tick(el, 100);

      // Both halves of the story: beta could not be searched, and the
      // repositories that were searched held nothing. Showing only the red
      // panel reads as a wholly failed search.
      expect(el.shadowRoot!.querySelector('.search-failures')!.textContent).to.include('beta');
      expect(el.shadowRoot!.querySelector('.search-no-results')!.textContent).to.include(
        'No results found',
      );
    });

    it('keeps successful results while showing skipped repositories', async () => {
      setupDefaultMocks({
        searchResults: [
          {
            repoName: 'alpha',
            repoPath: '/repos/alpha',
            filePath: 'src/main.ts',
            lineNumber: 42,
            lineContent: 'const test = true',
            matchStart: 6,
            matchEnd: 10,
          },
        ],
        searchFailures: ['Failed to search repository "beta": not a git repository'],
      });
      uiStore.setState({ toasts: [] });
      const el = await renderDialog();

      const searchInput = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
      searchInput.value = 'test';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;
      (el.shadowRoot!.querySelector('.search-btn') as HTMLButtonElement).click();
      await tick(el, 100);

      expect(el.shadowRoot!.querySelectorAll('.search-result-item')).to.have.length(1);
      expect(el.shadowRoot!.querySelector('.search-failures')!.textContent).to.include('beta');
      expect(uiStore.getState().toasts.at(-1)?.type).to.equal('warning');
    });

    it('summarises several failures in the toast and lists them in the panel', async () => {
      setupDefaultMocks({
        searchFailures: [
          'Failed to search repository "beta": repository path does not exist',
          'Failed to search repository "gamma": not a git repository',
        ],
      });
      uiStore.setState({ toasts: [] });
      const el = await renderDialog();

      const searchInput = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
      searchInput.value = 'test';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;
      (el.shadowRoot!.querySelector('.search-btn') as HTMLButtonElement).click();
      await tick(el, 100);

      // The toast collapses newlines, so it must summarise rather than concatenate.
      const message = uiStore.getState().toasts.at(-1)!.message;
      expect(message).to.not.include('\n');
      expect(message).to.include('2 problems');
      expect(message).to.not.include('gamma');

      // The panel keeps the per-repository detail, one line each.
      const failureLines = el.shadowRoot!.querySelectorAll('.search-failures div');
      expect(failureLines.length).to.equal(2);
      expect(failureLines[0].textContent).to.include('beta');
      expect(failureLines[1].textContent).to.include('gamma');

      // The panel is a container, not bare red text: it must paint a tinted
      // background rather than relying on color-mix() for its outline.
      const panel = el.shadowRoot!.querySelector('.search-failures') as HTMLElement;
      expect(getComputedStyle(panel).backgroundColor).to.not.equal('rgba(0, 0, 0, 0)');
    });

    it('shows a single failure verbatim in the toast', async () => {
      setupDefaultMocks({
        searchFailures: ['Failed to search repository "beta": repository path does not exist'],
      });
      uiStore.setState({ toasts: [] });
      const el = await renderDialog();

      const searchInput = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
      searchInput.value = 'test';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;
      (el.shadowRoot!.querySelector('.search-btn') as HTMLButtonElement).click();
      await tick(el, 100);

      expect(uiStore.getState().toasts.at(-1)!.message).to.equal(
        'Failed to search repository "beta": repository path does not exist',
      );
    });

    it('stays silent when the dialog is closed before the search resolves', async () => {
      setupDefaultMocks();
      const el = await renderDialog();

      // Hold the search open so the dialog can be closed while it is in flight.
      const base = mockInvoke;
      let releaseSearch: (response: WorkspaceSearchResponse) => void = () => {};
      mockInvoke = (command: string, args?: unknown) => {
        if (command === 'search_workspace') {
          return new Promise<unknown>((resolve) => {
            releaseSearch = resolve as (response: WorkspaceSearchResponse) => void;
          });
        }
        return base(command, args);
      };

      const searchInput = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
      searchInput.value = 'test';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;
      (el.shadowRoot!.querySelector('.search-btn') as HTMLButtonElement).click();
      await el.updateComplete;

      uiStore.setState({ toasts: [] });
      el.close();
      await el.updateComplete;

      releaseSearch({
        results: [],
        failures: [
          'Failed to search repository "beta": repository path does not exist',
          'Failed to search repository "gamma": not a git repository',
        ],
      });
      await tick(el, 100);

      // A toast saying "see the details below" would point at a panel that is
      // no longer on screen.
      expect(uiStore.getState().toasts).to.have.length(0);
      expect(el.shadowRoot!.querySelector('.search-failures')).to.be.null;
    });

    it('clears a stale failure banner and query when the dialog is reopened', async () => {
      setupDefaultMocks({
        searchFailures: ['Failed to search repository "beta": repository path does not exist'],
      });
      const el = await renderDialog();

      const searchInput = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
      searchInput.value = 'test';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;
      (el.shadowRoot!.querySelector('.search-btn') as HTMLButtonElement).click();
      await tick(el, 100);
      expect(el.shadowRoot!.querySelectorAll('.search-failures').length).to.equal(1);

      el.close();
      await tick(el, 20);
      el.open = true;
      await tick(el, 100);

      expect(el.shadowRoot!.querySelectorAll('.search-failures').length).to.equal(0);
      expect(
        (el.shadowRoot!.querySelector('.search-input') as HTMLInputElement).value,
      ).to.equal('');
    });

    it('keeps the newest result when searches complete out of order', async () => {
      setupDefaultMocks();
      const defaultInvoke = mockInvoke;
      const pending = new Map<string, (response: WorkspaceSearchResponse) => void>();
      mockInvoke = (command: string, args?: unknown) => {
        if (command !== 'search_workspace') return defaultInvoke(command, args);
        const query = (args as Record<string, string>).query;
        return new Promise((resolve) => pending.set(query, resolve));
      };
      const el = await renderDialog();
      const searchInput = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;

      searchInput.value = 'first';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;
      searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      searchInput.value = 'second';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;
      searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      pending.get('second')!({
        results: [{
          repoName: 'alpha',
          repoPath: '/repos/alpha',
          filePath: 'second.txt',
          lineNumber: 1,
          lineContent: 'second',
          matchStart: 0,
          matchEnd: 6,
        }],
        failures: [],
      });
      await tick(el, 20);
      pending.get('first')!({
        results: [{
          repoName: 'alpha',
          repoPath: '/repos/alpha',
          filePath: 'first.txt',
          lineNumber: 1,
          lineContent: 'first',
          matchStart: 0,
          matchEnd: 5,
        }],
        failures: [],
      });
      await tick(el, 20);

      expect(el.shadowRoot!.querySelector('.search-result-file')!.textContent).to.equal('second.txt');
    });

    it('does not show search section for workspace with no repos', async () => {
      setupDefaultMocks({ workspaces: [WS_EMPTY] });
      const el = await renderDialog();

      const searchInput = el.shadowRoot!.querySelector('.search-input');
      expect(searchInput).to.be.null;
    });
  });

  // ── Import / Export ───────────────────────────────────────────────────
  describe('Import/Export Workspace', () => {
    it('calls export_workspace when Export button is clicked', async () => {
      dialogSaveResult = '/tmp/workspace-export.json';
      const el = await renderDialog();
      clearHistory();

      const exportBtn = el.shadowRoot!.querySelector('.ie-btn') as HTMLButtonElement;
      expect(exportBtn).to.not.be.null;
      expect(exportBtn.textContent).to.include('Export');

      exportBtn.click();
      await tick(el, 100);

      const exportCalls = findCommands('export_workspace');
      expect(exportCalls.length).to.equal(1);
      expect((exportCalls[0].args as Record<string, unknown>).workspaceId).to.equal('ws-1');
    });

    it('calls import_workspace when Import button is clicked with a file', async () => {
      dialogOpenResult = '/tmp/workspace.json';
      const el = await renderDialog();
      clearHistory();

      // The Import button is the second .new-btn in the left panel
      const leftPanelButtons = el.shadowRoot!.querySelectorAll('.new-btn');
      const importBtn = Array.from(leftPanelButtons).find(
        (btn) => btn.textContent?.includes('Import'),
      ) as HTMLButtonElement;
      expect(importBtn).to.not.be.null;

      importBtn.click();
      await tick(el, 100);

      const importCalls = findCommands('import_workspace');
      expect(importCalls.length).to.equal(1);
    });

    it('does not call import_workspace when dialog is cancelled', async () => {
      dialogOpenResult = null;
      const el = await renderDialog();
      clearHistory();

      const leftPanelButtons = el.shadowRoot!.querySelectorAll('.new-btn');
      const importBtn = Array.from(leftPanelButtons).find(
        (btn) => btn.textContent?.includes('Import'),
      ) as HTMLButtonElement;

      importBtn.click();
      await tick(el, 100);

      const importCalls = findCommands('import_workspace');
      expect(importCalls.length).to.equal(0);
    });
  });

  // ── Validation (repo status) ──────────────────────────────────────────
  describe('Validation: repo status', () => {
    it('calls validate_workspace_repositories on workspace select', async () => {
      await renderDialog();

      const validateCalls = findCommands('validate_workspace_repositories');
      expect(validateCalls.length).to.be.greaterThan(0);
    });

    it('shows the branch name for an attached repo and "detached HEAD" for a detached one', async () => {
      setupDefaultMocks({
        statuses: [
          makeRepoStatus({ path: '/repos/alpha', name: 'alpha', currentBranch: 'main' }),
          makeRepoStatus({
            path: '/repos/beta',
            name: 'beta',
            currentBranch: null,
            isDetached: true,
          }),
        ],
      });

      const el = await renderDialog();
      await tick(el, 100);

      const branches = el.shadowRoot!.querySelectorAll('.repo-branch');
      expect(branches.length).to.equal(2);
      expect(branches[0].textContent?.trim()).to.equal('main');
      expect(branches[0].classList.contains('detached')).to.be.false;

      const detached = el.shadowRoot!.querySelector('.repo-branch.detached');
      expect(detached).to.not.be.null;
      expect(detached!.textContent?.trim()).to.equal('detached HEAD');
    });

    it('shows no branch chip when a repo has no branch and is not detached', async () => {
      setupDefaultMocks({
        statuses: [
          makeRepoStatus({
            path: '/repos/alpha',
            name: 'alpha',
            exists: false,
            isValidRepo: false,
            currentBranch: null,
            isDetached: false,
          }),
        ],
      });

      const el = await renderDialog();
      await tick(el, 100);

      expect(el.shadowRoot!.querySelectorAll('.repo-branch').length).to.equal(0);
    });

    it('renders repo status badges from validation result', async () => {
      setupDefaultMocks({
        statuses: [
          makeRepoStatus({ path: '/repos/alpha', name: 'alpha', changedFilesCount: 0 }),
          makeRepoStatus({ path: '/repos/beta', name: 'beta', changedFilesCount: 3 }),
        ],
      });

      const el = await renderDialog();
      await tick(el, 100);

      const statusBadges = el.shadowRoot!.querySelectorAll('.repo-status');
      expect(statusBadges.length).to.be.greaterThan(0);
    });

    it('marks missing repos with "missing" class on repo-item', async () => {
      setupDefaultMocks({
        statuses: [
          makeRepoStatus({ path: '/repos/alpha', name: 'alpha', exists: false, isValidRepo: false }),
          makeRepoStatus({ path: '/repos/beta', name: 'beta', exists: true, isValidRepo: true }),
        ],
      });

      const el = await renderDialog();
      await tick(el, 100);

      const missingItems = el.shadowRoot!.querySelectorAll('.repo-item.missing');
      expect(missingItems.length).to.equal(1);
    });

    it('shows "missing" status text for repos that do not exist on disk', async () => {
      setupDefaultMocks({
        statuses: [
          makeRepoStatus({ path: '/repos/alpha', name: 'alpha', exists: false, isValidRepo: false }),
          makeRepoStatus({ path: '/repos/beta', name: 'beta', exists: true, isValidRepo: true }),
        ],
      });

      const el = await renderDialog();
      await tick(el, 100);

      const missingStatus = el.shadowRoot!.querySelector('.repo-status.missing');
      expect(missingStatus).to.not.be.null;
      expect(missingStatus!.textContent?.trim()).to.equal('missing');
    });

    it('shows "clean" status for repos with no changes', async () => {
      setupDefaultMocks({
        statuses: [
          makeRepoStatus({ path: '/repos/alpha', name: 'alpha', changedFilesCount: 0 }),
          makeRepoStatus({ path: '/repos/beta', name: 'beta', changedFilesCount: 0 }),
        ],
      });

      const el = await renderDialog();
      await tick(el, 100);

      const cleanStatuses = el.shadowRoot!.querySelectorAll('.repo-status.clean');
      expect(cleanStatuses.length).to.equal(2);
    });

    it('shows changed files count for repos with uncommitted changes', async () => {
      setupDefaultMocks({
        statuses: [
          makeRepoStatus({ path: '/repos/alpha', name: 'alpha', changedFilesCount: 5 }),
          makeRepoStatus({ path: '/repos/beta', name: 'beta', changedFilesCount: 0 }),
        ],
      });

      const el = await renderDialog();
      await tick(el, 100);

      const changedStatus = el.shadowRoot!.querySelector('.repo-status.changed');
      expect(changedStatus).to.not.be.null;
      expect(changedStatus!.textContent).to.include('5');
    });

    it('refreshes status when Refresh Status button is clicked', async () => {
      const el = await renderDialog();
      await tick(el, 100);
      clearHistory();

      const batchBtns = el.shadowRoot!.querySelectorAll('.batch-btn');
      const refreshBtn = Array.from(batchBtns).find(
        (btn) => btn.textContent?.includes('Refresh Status'),
      ) as HTMLButtonElement;
      expect(refreshBtn).to.not.be.null;

      refreshBtn.click();
      await tick(el, 100);

      const validateCalls = findCommands('validate_workspace_repositories');
      expect(validateCalls.length).to.be.greaterThan(0);
    });
  });

  // ── Error handling ────────────────────────────────────────────────────
  describe('Error handling', () => {
    it('handles save_workspace returning no data gracefully', async () => {
      setupDefaultMocks();
      // Override to return null from save (simulating backend not returning data)
      const origMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'save_workspace') return null;
        return origMock(command, args);
      };

      const el = await renderDialog();
      clearHistory();

      const nameInput = el.shadowRoot!.querySelector('.form-input') as HTMLInputElement;
      nameInput.value = 'Updated';
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      nameInput.dispatchEvent(new Event('blur', { bubbles: true }));
      await tick(el, 100);

      // Should not crash; workspace list should remain
      const items = el.shadowRoot!.querySelectorAll('.workspace-item');
      expect(items.length).to.be.greaterThan(0);
    });

    it('handles delete_workspace failure gracefully', async () => {
      setupDefaultMocks({ deleteFails: true });
      const el = await renderDialog();
      clearHistory();

      const deleteBtn = el.shadowRoot!.querySelector('.btn-danger') as HTMLButtonElement;

      // The delete throws but the component should not crash
      deleteBtn.click();
      await tick(el, 100);

      // Workspace list should still be intact
      const items = el.shadowRoot!.querySelectorAll('.workspace-item');
      expect(items.length).to.be.greaterThan(0);
    });
  });

  // ── Dialog open/close behavior ────────────────────────────────────────
  describe('Dialog open/close behavior', () => {
    it('calls get_workspaces when dialog is opened', async () => {
      clearHistory();
      await renderDialog(true);

      const getCalls = findCommands('get_workspaces');
      expect(getCalls.length).to.be.greaterThan(0);
    });

    it('closes dialog when close button is clicked', async () => {
      const el = await renderDialog();
      expect(el.open).to.be.true;

      const closeBtn = el.shadowRoot!.querySelector('.close-btn') as HTMLButtonElement;
      closeBtn.click();
      await el.updateComplete;

      expect(el.open).to.be.false;
    });

    it('closes dialog when Close footer button is clicked', async () => {
      const el = await renderDialog();
      expect(el.open).to.be.true;

      const footerBtns = el.shadowRoot!.querySelectorAll('.btn-secondary');
      const closeBtn = Array.from(footerBtns).find(
        (btn) => btn.textContent?.trim() === 'Close',
      ) as HTMLButtonElement;
      expect(closeBtn).to.not.be.null;

      closeBtn.click();
      await el.updateComplete;

      expect(el.open).to.be.false;
    });

    it('closes dialog when overlay is clicked', async () => {
      const el = await renderDialog();
      expect(el.open).to.be.true;

      const overlay = el.shadowRoot!.querySelector('.overlay') as HTMLDivElement;
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await el.updateComplete;

      expect(el.open).to.be.false;
    });

    it('closes dialog on Escape key', async () => {
      const el = await renderDialog();
      expect(el.open).to.be.true;

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await el.updateComplete;

      expect(el.open).to.be.false;
    });

    it('dispatches close event when dialog closes', async () => {
      const el = await renderDialog();

      let closeFired = false;
      el.addEventListener('close', () => {
        closeFired = true;
      });

      const closeBtn = el.shadowRoot!.querySelector('.close-btn') as HTMLButtonElement;
      closeBtn.click();
      await el.updateComplete;

      expect(closeFired).to.be.true;
    });
  });

  describe('open workspace partial-failure feedback', () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    function selectWorkspaceWithRepos(
      el: GnWorkspaceManagerDialog,
      paths: string[],
    ): void {
      const ws = makeWorkspace({
        id: 'ws-open',
        name: 'OpenMe',
        repositories: paths.map((p) => ({ path: p, name: p.split('/').pop() ?? p })),
      });
      (el as any).workspaces = [ws];
      (el as any).selectedWorkspaceId = 'ws-open';
      // Mark every repo as existing + valid so the pre-check passes and the
      // open attempt itself decides success/failure
      const statuses = new Map<string, WorkspaceRepoStatus>();
      for (const p of paths) {
        statuses.set(p, { exists: true, isValidRepo: true } as unknown as WorkspaceRepoStatus);
      }
      (el as any).repoStatuses = statuses;
    }

    it('warns (not plain success) when some repos fail to open', async () => {
      uiStore.setState({ toasts: [] });
      repositoryStore.getState().reset();
      setupDefaultMocks({});
      mockInvoke = (command: string, args?: unknown) => {
        const params = args as Record<string, unknown> | undefined;
        if (command === 'open_repository') {
          if (params?.path === '/ws/gone') return Promise.reject(new Error('not found'));
          return Promise.resolve({ path: params?.path as string, name: 'repo' });
        }
        if (command === 'update_workspace_last_opened') return Promise.resolve(undefined);
        return Promise.resolve(null);
      };

      const el = await renderDialog();
      selectWorkspaceWithRepos(el, ['/ws/ok', '/ws/gone']);

      await (el as any).handleOpenWorkspace();
      await tick(el);

      const toasts = uiStore.getState().toasts;
      const last = toasts[toasts.length - 1];
      expect(last.type).to.equal('warning');
      expect(last.message).to.contain('1 of 2');
      // The repo that opened is still added
      expect(
        repositoryStore.getState().openRepositories.map((r) => r.repository.path),
      ).to.deep.equal(['/ws/ok']);
    });

    it('errors when NO repo in the workspace could be opened', async () => {
      uiStore.setState({ toasts: [] });
      repositoryStore.getState().reset();
      setupDefaultMocks({});
      mockInvoke = (command: string) => {
        if (command === 'open_repository') return Promise.reject(new Error('not found'));
        if (command === 'update_workspace_last_opened') return Promise.resolve(undefined);
        return Promise.resolve(null);
      };

      const el = await renderDialog();
      selectWorkspaceWithRepos(el, ['/ws/gone-1', '/ws/gone-2']);

      await (el as any).handleOpenWorkspace();
      await tick(el);

      const toasts = uiStore.getState().toasts;
      expect(toasts[toasts.length - 1].type).to.equal('error');
      expect(repositoryStore.getState().openRepositories.length).to.equal(0);
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });
});
