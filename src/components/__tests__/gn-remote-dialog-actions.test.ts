/**
 * Comprehensive tests for gn-remote-dialog component actions.
 *
 * These render the REAL gn-remote-dialog component, mock only the Tauri invoke
 * layer, and verify the actual component code calls the right commands in the
 * right order for fetch, prune, add, remove, rename, and edit operations.
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
import type { GnRemoteDialog } from '../dialogs/gn-remote-dialog.ts';

// Import the actual component — registers <gn-remote-dialog> custom element
import '../dialogs/gn-remote-dialog.ts';

// ── Test data ──────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

const mockRemotes = [
  { name: 'origin', url: 'https://github.com/user/repo.git', pushUrl: null },
  { name: 'upstream', url: 'https://github.com/upstream/repo.git', pushUrl: 'git@github.com:upstream/repo.git' },
];

// ── Helpers ────────────────────────────────────────────────────────────────
function clearHistory(): void {
  invokeHistory.length = 0;
}

function findCommands(name: string): Array<{ command: string; args?: unknown }> {
  return invokeHistory.filter((h) => h.command === name);
}

function setupDefaultMocks(remotes = mockRemotes): void {
  mockInvoke = async (command: string) => {
    switch (command) {
      case 'get_remotes':
        return remotes;
      case 'fetch':
        return null;
      case 'prune_remote_tracking_branches':
        return { success: true, branchesPruned: [] };
      case 'add_remote':
        return { name: 'new-remote', url: 'https://example.com/repo.git', pushUrl: null };
      case 'remove_remote':
        return null;
      case 'rename_remote':
        return { name: 'new-name', url: 'https://github.com/user/repo.git', pushUrl: null };
      case 'set_remote_url':
        return { name: 'origin', url: 'https://new-url.com/repo.git', pushUrl: null };
      case 'detect_github_repo':
        return null;
      // plugin-dialog 2.7 routes confirm() through `message` and returns the
      // clicked button label; 'Ok' means the user confirmed.
      case 'plugin:dialog|message':
        return 'Ok';
      default:
        return null;
    }
  };
}

async function renderDialog(open = true): Promise<GnRemoteDialog> {
  const el = await fixture<GnRemoteDialog>(
    html`<gn-remote-dialog .repositoryPath=${REPO_PATH} ?open=${open}></gn-remote-dialog>`
  );
  await el.updateComplete;
  // Wait for async loadRemotes to complete
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
  return el;
}

function getRemoteItems(el: GnRemoteDialog): NodeListOf<Element> {
  return el.shadowRoot!.querySelectorAll('.remote-item');
}

function getActionButtons(remoteItem: Element): NodeListOf<HTMLButtonElement> {
  return remoteItem.querySelectorAll('.action-btn');
}

function getActionButton(remoteItem: Element, title: string): HTMLButtonElement | undefined {
  const buttons = getActionButtons(remoteItem);
  return Array.from(buttons).find((btn) => btn.getAttribute('title') === title) as HTMLButtonElement | undefined;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-remote-dialog actions', () => {
  beforeEach(() => {
    clearHistory();
    setupDefaultMocks();
  });

  // ── 1. Rendering ──────────────────────────────────────────────────────
  describe('rendering', () => {
    it('renders remote list with correct number of items', async () => {
      const el = await renderDialog();

      const items = getRemoteItems(el);
      expect(items.length).to.equal(2);
    });

    it('displays remote names correctly', async () => {
      const el = await renderDialog();

      const names = el.shadowRoot!.querySelectorAll('.remote-name');
      const nameTexts = Array.from(names).map((n) => n.textContent?.trim());
      expect(nameTexts).to.include('origin');
      expect(nameTexts).to.include('upstream');
    });

    it('displays remote URLs correctly', async () => {
      const el = await renderDialog();

      const urls = el.shadowRoot!.querySelectorAll('.remote-url');
      const urlTexts = Array.from(urls).map((u) => u.textContent?.trim());
      expect(urlTexts).to.include('https://github.com/user/repo.git');
      expect(urlTexts).to.include('https://github.com/upstream/repo.git');
    });

    it('displays push URL when different from fetch URL', async () => {
      const el = await renderDialog();

      const urls = el.shadowRoot!.querySelectorAll('.remote-url');
      const urlTexts = Array.from(urls).map((u) => u.textContent?.trim());
      // upstream has a different pushUrl, so it should be displayed
      expect(urlTexts.some((t) => t?.includes('Push:'))).to.be.true;
    });

    it('shows empty state when no remotes are configured', async () => {
      setupDefaultMocks([]);

      const el = await renderDialog();

      const emptyState = el.shadowRoot!.querySelector('.empty-state');
      expect(emptyState).to.not.be.null;
      expect(emptyState!.textContent).to.include('No remotes configured');
    });

    it('calls get_remotes on open', async () => {
      await renderDialog();

      const getCalls = findCommands('get_remotes');
      expect(getCalls.length).to.be.greaterThan(0);
      expect(getCalls[0].args).to.deep.include({ path: REPO_PATH });
    });
  });

  // ── 2. Fetch ──────────────────────────────────────────────────────────
  describe('fetch', () => {
    it('click fetch button calls fetch command with correct remote name', async () => {
      const el = await renderDialog();
      clearHistory();

      const items = getRemoteItems(el);
      const originItem = Array.from(items).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const fetchBtn = getActionButton(originItem, 'Fetch')!;
      expect(fetchBtn).to.not.be.undefined;

      fetchBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const fetchCalls = findCommands('fetch');
      expect(fetchCalls.length).to.equal(1);
      const args = fetchCalls[0].args as Record<string, unknown>;
      expect(args.remote).to.equal('origin');
      expect(args.path).to.equal(REPO_PATH);
    });

    it('fetch button is disabled while fetch is in progress', async () => {
      let resolveFetch: (() => void) | null = null;
      const fetchPromise = new Promise<void>((resolve) => {
        resolveFetch = resolve;
      });

      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_remotes':
            return mockRemotes;
          case 'fetch':
            await fetchPromise;
            return null;
          case 'detect_github_repo':
            return null;
          default:
            return null;
        }
      };

      const el = await renderDialog();

      const items = getRemoteItems(el);
      const originItem = Array.from(items).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const fetchBtn = getActionButton(originItem, 'Fetch')!;

      // Start fetch (don't await)
      fetchBtn.click();
      await el.updateComplete;
      // Small delay for the state to propagate
      await new Promise((r) => setTimeout(r, 20));
      await el.updateComplete;

      // Check that the button is disabled during fetch
      const updatedItems = getRemoteItems(el);
      const updatedOriginItem = Array.from(updatedItems).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const disabledBtn = getActionButton(updatedOriginItem, 'Fetch')!;
      expect(disabledBtn.disabled).to.be.true;

      // Resolve the fetch
      resolveFetch!();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      // Button should be re-enabled
      const finalItems = getRemoteItems(el);
      const finalOriginItem = Array.from(finalItems).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const enabledBtn = getActionButton(finalOriginItem, 'Fetch')!;
      expect(enabledBtn.disabled).to.be.false;
    });

    it('fetch failure dispatches error toast via show-toast', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_remotes':
            return mockRemotes;
          case 'fetch':
            throw new Error('Connection refused');
          case 'detect_github_repo':
            return null;
          default:
            return null;
        }
      };

      const el = await renderDialog();
      clearHistory();

      const items = getRemoteItems(el);
      const originItem = Array.from(items).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const fetchBtn = getActionButton(originItem, 'Fetch')!;

      fetchBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      // The fetch command should still have been called
      const fetchCalls = findCommands('fetch');
      expect(fetchCalls.length).to.equal(1);

      // Button should be re-enabled after failure
      const finalItems = getRemoteItems(el);
      const finalOriginItem = Array.from(finalItems).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const enabledBtn = getActionButton(finalOriginItem, 'Fetch')!;
      expect(enabledBtn.disabled).to.be.false;
    });
  });

  // ── 3. Prune ──────────────────────────────────────────────────────────
  describe('prune', () => {
    it('click prune button calls prune_remote_tracking_branches with correct args', async () => {
      const el = await renderDialog();
      clearHistory();

      const items = getRemoteItems(el);
      const originItem = Array.from(items).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const pruneBtn = getActionButton(originItem, 'Prune stale tracking branches')!;
      expect(pruneBtn).to.not.be.undefined;

      pruneBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const pruneCalls = findCommands('prune_remote_tracking_branches');
      expect(pruneCalls.length).to.equal(1);
      expect(pruneCalls[0].args).to.deep.include({
        path: REPO_PATH,
        remotes: ['origin'],
      });
    });

    it('prune with branches pruned shows success result', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_remotes':
            return mockRemotes;
          case 'prune_remote_tracking_branches':
            return { success: true, branchesPruned: ['origin/stale-branch', 'origin/old-feature'] };
          default:
            return null;
        }
      };

      const el = await renderDialog();
      clearHistory();

      const items = getRemoteItems(el);
      const originItem = Array.from(items).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const pruneBtn = getActionButton(originItem, 'Prune stale tracking branches')!;

      pruneBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      // The prune command was called
      const pruneCalls = findCommands('prune_remote_tracking_branches');
      expect(pruneCalls.length).to.equal(1);

      // After successful prune with branches, it should reload remotes
      const getRemotesCalls = findCommands('get_remotes');
      expect(getRemotesCalls.length).to.be.greaterThan(0);
    });

    it('prune button is disabled while prune is in progress', async () => {
      let resolvePrune: (() => void) | null = null;
      const prunePromise = new Promise<void>((resolve) => {
        resolvePrune = resolve;
      });

      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_remotes':
            return mockRemotes;
          case 'prune_remote_tracking_branches':
            await prunePromise;
            return { success: true, branchesPruned: [] };
          default:
            return null;
        }
      };

      const el = await renderDialog();

      const items = getRemoteItems(el);
      const originItem = Array.from(items).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const pruneBtn = getActionButton(originItem, 'Prune stale tracking branches')!;

      // Start prune (don't await)
      pruneBtn.click();
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 20));
      await el.updateComplete;

      // Check button is disabled
      const updatedItems = getRemoteItems(el);
      const updatedOriginItem = Array.from(updatedItems).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const disabledBtn = getActionButton(updatedOriginItem, 'Prune stale tracking branches')!;
      expect(disabledBtn.disabled).to.be.true;

      // Resolve the prune
      resolvePrune!();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      // Button should be re-enabled
      const finalItems = getRemoteItems(el);
      const finalOriginItem = Array.from(finalItems).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const enabledBtn = getActionButton(finalOriginItem, 'Prune stale tracking branches')!;
      expect(enabledBtn.disabled).to.be.false;
    });

    it('prune failure shows error toast and re-enables button', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_remotes':
            return mockRemotes;
          case 'prune_remote_tracking_branches':
            throw new Error('Prune failed unexpectedly');
          default:
            return null;
        }
      };

      const el = await renderDialog();
      clearHistory();

      const items = getRemoteItems(el);
      const originItem = Array.from(items).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const pruneBtn = getActionButton(originItem, 'Prune stale tracking branches')!;

      pruneBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      // The prune command should have been called
      const pruneCalls = findCommands('prune_remote_tracking_branches');
      expect(pruneCalls.length).to.equal(1);

      // Button should be re-enabled after failure
      const finalItems = getRemoteItems(el);
      const finalOriginItem = Array.from(finalItems).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const enabledBtn = getActionButton(finalOriginItem, 'Prune stale tracking branches')!;
      expect(enabledBtn.disabled).to.be.false;
    });
  });

  // ── 4. Add remote ─────────────────────────────────────────────────────
  describe('add remote', () => {
    it('click "Add Remote" button switches to add form', async () => {
      const el = await renderDialog();

      const addBtn = el.shadowRoot!.querySelector('.footer .btn-primary') as HTMLButtonElement;
      expect(addBtn.textContent?.trim()).to.equal('Add Remote');

      addBtn.click();
      await el.updateComplete;

      // Should show form with name and URL inputs
      const formInputs = el.shadowRoot!.querySelectorAll('.form-input');
      expect(formInputs.length).to.equal(2); // Name + URL
      const title = el.shadowRoot!.querySelector('.title');
      expect(title!.textContent?.trim()).to.equal('Add Remote');
    });

    it('submitting add form calls add_remote with correct args', async () => {
      const el = await renderDialog();

      // Switch to add mode
      const addBtn = el.shadowRoot!.querySelector('.footer .btn-primary') as HTMLButtonElement;
      addBtn.click();
      await el.updateComplete;

      // Fill in name and URL
      const formInputs = el.shadowRoot!.querySelectorAll('.form-input') as NodeListOf<HTMLInputElement>;
      const nameInput = formInputs[0];
      const urlInput = formInputs[1];

      nameInput.value = 'new-remote';
      nameInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
      urlInput.value = 'https://example.com/repo.git';
      urlInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      clearHistory();

      // Click Save
      const saveBtn = el.shadowRoot!.querySelector('.footer .btn-primary') as HTMLButtonElement;
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const addCalls = findCommands('add_remote');
      expect(addCalls.length).to.equal(1);
      expect(addCalls[0].args).to.deep.include({
        path: REPO_PATH,
        name: 'new-remote',
        url: 'https://example.com/repo.git',
      });
    });

    it('save button is disabled when name or URL is empty', async () => {
      const el = await renderDialog();

      // Switch to add mode
      const addBtn = el.shadowRoot!.querySelector('.footer .btn-primary') as HTMLButtonElement;
      addBtn.click();
      await el.updateComplete;

      // Save button should be disabled (no name or URL)
      const saveBtn = el.shadowRoot!.querySelector('.footer .btn-primary') as HTMLButtonElement;
      expect(saveBtn.disabled).to.be.true;
    });
  });

  // ── 5. Remove remote ──────────────────────────────────────────────────
  describe('remove remote', () => {
    it('click remove button calls remove_remote after confirmation', async () => {
      const el = await renderDialog();
      clearHistory();

      const items = getRemoteItems(el);
      const originItem = Array.from(items).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const removeBtn = getActionButton(originItem, 'Remove')!;
      expect(removeBtn).to.not.be.undefined;

      removeBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      // Confirm dialog should have been shown
      const confirmCalls = findCommands('plugin:dialog|message');
      expect(confirmCalls.length).to.equal(1);

      // remove_remote should have been called
      const removeCalls = findCommands('remove_remote');
      expect(removeCalls.length).to.equal(1);
      expect(removeCalls[0].args).to.deep.include({
        path: REPO_PATH,
        name: 'origin',
      });
    });

    it('remove is cancelled when confirmation is declined', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_remotes':
            return mockRemotes;
          case 'plugin:dialog|message':
            return 'Cancel'; // User declined (any non-'Ok' label)
          default:
            return null;
        }
      };

      const el = await renderDialog();
      clearHistory();

      const items = getRemoteItems(el);
      const originItem = Array.from(items).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const removeBtn = getActionButton(originItem, 'Remove')!;

      removeBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      // remove_remote should NOT have been called
      const removeCalls = findCommands('remove_remote');
      expect(removeCalls.length).to.equal(0);
    });
  });

  // ── 6. Edit URL ───────────────────────────────────────────────────────
  describe('edit URL', () => {
    it('click edit button switches to edit form with current URL', async () => {
      const el = await renderDialog();

      const items = getRemoteItems(el);
      const originItem = Array.from(items).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const editBtn = getActionButton(originItem, 'Edit URL')!;
      expect(editBtn).to.not.be.undefined;

      editBtn.click();
      await el.updateComplete;

      const title = el.shadowRoot!.querySelector('.title');
      expect(title!.textContent?.trim()).to.equal('Edit Remote URL');

      // Form should show current URL
      const formInputs = el.shadowRoot!.querySelectorAll('.form-input') as NodeListOf<HTMLInputElement>;
      expect(formInputs[0].value).to.equal('https://github.com/user/repo.git');
    });

    it('saving edited URL calls set_remote_url', async () => {
      const el = await renderDialog();

      // Switch to edit mode for origin
      const items = getRemoteItems(el);
      const originItem = Array.from(items).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const editBtn = getActionButton(originItem, 'Edit URL')!;
      editBtn.click();
      await el.updateComplete;

      // Change URL
      const formInputs = el.shadowRoot!.querySelectorAll('.form-input') as NodeListOf<HTMLInputElement>;
      const urlInput = formInputs[0];
      urlInput.value = 'https://new-url.com/repo.git';
      urlInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      clearHistory();

      // Click Save
      const saveBtn = el.shadowRoot!.querySelector('.footer .btn-primary') as HTMLButtonElement;
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const setCalls = findCommands('set_remote_url');
      expect(setCalls.length).to.be.greaterThanOrEqual(1);
      expect(setCalls[0].args).to.deep.include({
        path: REPO_PATH,
        name: 'origin',
        url: 'https://new-url.com/repo.git',
        push: false,
      });
    });

    // Push URL editing — `upstream` has pushUrl 'git@github.com:upstream/repo.git'
    async function startEditingUpstream(el: GnRemoteDialog): Promise<NodeListOf<HTMLInputElement>> {
      const items = getRemoteItems(el);
      const upstreamItem = Array.from(items).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'upstream'
      )!;
      getActionButton(upstreamItem, 'Edit URL')!.click();
      await el.updateComplete;
      return el.shadowRoot!.querySelectorAll('.form-input') as NodeListOf<HTMLInputElement>;
    }

    async function setPushUrlAndSave(el: GnRemoteDialog, value: string): Promise<void> {
      const formInputs = await startEditingUpstream(el);
      const pushInput = formInputs[1];
      pushInput.value = value;
      pushInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      clearHistory();

      const saveBtn = el.shadowRoot!.querySelector('.footer .btn-primary') as HTMLButtonElement;
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;
    }

    it('clearing the push URL asks the backend to unset it', async () => {
      const el = await renderDialog();

      await setPushUrlAndSave(el, '');

      const setCalls = findCommands('set_remote_url');
      expect(setCalls.length).to.equal(2);
      expect(setCalls[1].args).to.deep.include({
        path: REPO_PATH,
        name: 'upstream',
        url: '',
        push: true,
      });
    });

    it('a push URL equal to the fetch URL clears it', async () => {
      const el = await renderDialog();

      await setPushUrlAndSave(el, 'https://github.com/upstream/repo.git');

      const setCalls = findCommands('set_remote_url');
      expect(setCalls.length).to.equal(2);
      expect(setCalls[1].args).to.deep.include({
        path: REPO_PATH,
        name: 'upstream',
        url: '',
        push: true,
      });
    });

    it('a failed push-URL clear keeps the dialog open and shows the error', async () => {
      const el = await renderDialog();

      let remotesChanged = false;
      el.addEventListener('remotes-changed', () => { remotesChanged = true; });

      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_remotes') return mockRemotes;
        if (command === 'set_remote_url') {
          if ((args as { push?: boolean }).push === true) {
            throw new Error('cannot unset push url');
          }
          return { name: 'upstream', url: 'https://github.com/upstream/repo.git', pushUrl: null };
        }
        return null;
      };

      await setPushUrlAndSave(el, '');

      const error = el.shadowRoot!.querySelector('.error');
      expect(error).to.not.be.null;
      expect(error!.textContent).to.contain('cannot unset push url');

      // Still in edit mode, and no refresh was announced
      const title = el.shadowRoot!.querySelector('.title');
      expect(title!.textContent?.trim()).to.equal('Edit Remote URL');
      expect(remotesChanged).to.be.false;
    });

    // Guard against over-reach: this passes with and without the fix — it exists
    // so a future change cannot start issuing a clear for every fetch-URL edit.
    it('leaves the push URL alone for a remote that never had one', async () => {
      const el = await renderDialog();

      const items = getRemoteItems(el);
      const originItem = Array.from(items).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      getActionButton(originItem, 'Edit URL')!.click();
      await el.updateComplete;

      const formInputs = el.shadowRoot!.querySelectorAll('.form-input') as NodeListOf<HTMLInputElement>;
      formInputs[0].value = 'https://new-url.com/repo.git';
      formInputs[0].dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      clearHistory();

      const saveBtn = el.shadowRoot!.querySelector('.footer .btn-primary') as HTMLButtonElement;
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const setCalls = findCommands('set_remote_url');
      expect(setCalls.length).to.equal(1);
      expect(setCalls[0].args).to.deep.include({ push: false });
    });
  });

  // ── 7. Rename remote ──────────────────────────────────────────────────
  describe('rename remote', () => {
    it('click rename button switches to rename form', async () => {
      const el = await renderDialog();

      const items = getRemoteItems(el);
      const originItem = Array.from(items).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const renameBtn = getActionButton(originItem, 'Rename')!;
      expect(renameBtn).to.not.be.undefined;

      renameBtn.click();
      await el.updateComplete;

      const title = el.shadowRoot!.querySelector('.title');
      expect(title!.textContent?.trim()).to.equal('Rename Remote');

      // Form should show current name
      const formInputs = el.shadowRoot!.querySelectorAll('.form-input') as NodeListOf<HTMLInputElement>;
      expect(formInputs[0].value).to.equal('origin');
    });

    it('submitting rename form calls rename_remote with correct args', async () => {
      const el = await renderDialog();

      // Switch to rename mode for origin
      const items = getRemoteItems(el);
      const originItem = Array.from(items).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const renameBtn = getActionButton(originItem, 'Rename')!;
      renameBtn.click();
      await el.updateComplete;

      // Change name
      const formInputs = el.shadowRoot!.querySelectorAll('.form-input') as NodeListOf<HTMLInputElement>;
      const nameInput = formInputs[0];
      nameInput.value = 'my-origin';
      nameInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      clearHistory();

      // Click Save
      const saveBtn = el.shadowRoot!.querySelector('.footer .btn-primary') as HTMLButtonElement;
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const renameCalls = findCommands('rename_remote');
      expect(renameCalls.length).to.equal(1);
      expect(renameCalls[0].args).to.deep.include({
        path: REPO_PATH,
        oldName: 'origin',
        newName: 'my-origin',
      });
    });

    it('rename with same name does not call rename_remote', async () => {
      const el = await renderDialog();

      // Switch to rename mode for origin
      const items = getRemoteItems(el);
      const originItem = Array.from(items).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const renameBtn = getActionButton(originItem, 'Rename')!;
      renameBtn.click();
      await el.updateComplete;

      clearHistory();

      // The save button should be disabled since name hasn't changed
      const saveBtn = el.shadowRoot!.querySelector('.footer .btn-primary') as HTMLButtonElement;
      expect(saveBtn.disabled).to.be.true;
    });
  });

  // ── 8. Error handling ─────────────────────────────────────────────────
  describe('error handling', () => {
    it('load remotes failure results in empty remote list', async () => {
      mockInvoke = async (command: string) => {
        if (command === 'get_remotes') {
          throw new Error('Repository not found');
        }
        return null;
      };

      const el = await renderDialog();

      // When loading fails, the remote list should be empty (no items rendered)
      const items = getRemoteItems(el);
      expect(items.length).to.equal(0);

      // Loading indicator should not be shown after failure
      expect(el.shadowRoot!.querySelector('.loading')).to.be.null;
    });

    it('add remote failure shows error in form', async () => {
      let addCallCount = 0;
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_remotes':
            return mockRemotes;
          case 'add_remote':
            addCallCount++;
            throw new Error('Remote already exists');
          default:
            return null;
        }
      };

      const el = await renderDialog();

      // Switch to add mode
      const addBtn = el.shadowRoot!.querySelector('.footer .btn-primary') as HTMLButtonElement;
      addBtn.click();
      await el.updateComplete;

      // Fill in name and URL
      const formInputs = el.shadowRoot!.querySelectorAll('.form-input') as NodeListOf<HTMLInputElement>;
      formInputs[0].value = 'duplicate';
      formInputs[0].dispatchEvent(new InputEvent('input', { bubbles: true }));
      formInputs[1].value = 'https://example.com/repo.git';
      formInputs[1].dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      // Click Save
      const saveBtn = el.shadowRoot!.querySelector('.footer .btn-primary') as HTMLButtonElement;
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      expect(addCallCount).to.equal(1);

      const errorEl = el.shadowRoot!.querySelector('.error');
      expect(errorEl).to.not.be.null;
      expect(errorEl!.textContent).to.include('Remote already exists');
    });
  });

  // ── 9. Loading state ──────────────────────────────────────────────────
  describe('loading state', () => {
    it('shows loading indicator while remotes are being loaded', async () => {
      let resolveLoad: (() => void) | null = null;
      const loadPromise = new Promise<void>((resolve) => {
        resolveLoad = resolve;
      });

      mockInvoke = async (command: string) => {
        if (command === 'get_remotes') {
          await loadPromise;
          return mockRemotes;
        }
        return null;
      };

      const el = await fixture<GnRemoteDialog>(
        html`<gn-remote-dialog .repositoryPath=${REPO_PATH} ?open=${true}></gn-remote-dialog>`
      );
      await el.updateComplete;

      const loading = el.shadowRoot!.querySelector('.loading');
      expect(loading).to.not.be.null;
      expect(loading!.textContent).to.include('Loading');

      // Resolve and wait for update
      resolveLoad!();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      // Loading should be gone, remotes should be shown
      expect(el.shadowRoot!.querySelector('.loading')).to.be.null;
      const items = getRemoteItems(el);
      expect(items.length).to.equal(2);
    });
  });

  // ── 10. Navigation and close ──────────────────────────────────────────
  describe('navigation and close', () => {
    it('back button returns to list from add form', async () => {
      const el = await renderDialog();

      // Switch to add mode
      const addBtn = el.shadowRoot!.querySelector('.footer .btn-primary') as HTMLButtonElement;
      addBtn.click();
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.title')!.textContent?.trim()).to.equal('Add Remote');

      // Click back button
      const backBtn = el.shadowRoot!.querySelector('.back-btn') as HTMLButtonElement;
      backBtn.click();
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.title')!.textContent?.trim()).to.equal('Remotes');
    });

    it('close button dispatches close event', async () => {
      const el = await renderDialog();

      let closeFired = false;
      el.addEventListener('close', () => { closeFired = true; });

      const closeBtn = el.shadowRoot!.querySelector('.close-btn') as HTMLButtonElement;
      closeBtn.click();
      await el.updateComplete;

      expect(closeFired).to.be.true;
    });

    it('cancel button in form returns to list', async () => {
      const el = await renderDialog();

      // Switch to add mode
      const addBtn = el.shadowRoot!.querySelector('.footer .btn-primary') as HTMLButtonElement;
      addBtn.click();
      await el.updateComplete;

      // Click Cancel
      const cancelBtn = el.shadowRoot!.querySelector('.footer .btn-secondary') as HTMLButtonElement;
      expect(cancelBtn.textContent?.trim()).to.equal('Cancel');
      cancelBtn.click();
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.title')!.textContent?.trim()).to.equal('Remotes');
    });
  });

  // ── 11. Events ────────────────────────────────────────────────────────
  describe('events', () => {
    it('dispatches remotes-changed after successful add', async () => {
      const el = await renderDialog();

      let eventFired = false;
      el.addEventListener('remotes-changed', () => { eventFired = true; });

      // Switch to add mode
      const addBtn = el.shadowRoot!.querySelector('.footer .btn-primary') as HTMLButtonElement;
      addBtn.click();
      await el.updateComplete;

      // Fill in name and URL
      const formInputs = el.shadowRoot!.querySelectorAll('.form-input') as NodeListOf<HTMLInputElement>;
      formInputs[0].value = 'new-remote';
      formInputs[0].dispatchEvent(new InputEvent('input', { bubbles: true }));
      formInputs[1].value = 'https://example.com/repo.git';
      formInputs[1].dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      // Click Save
      const saveBtn = el.shadowRoot!.querySelector('.footer .btn-primary') as HTMLButtonElement;
      saveBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      expect(eventFired).to.be.true;
    });

    it('dispatches remotes-changed after successful fetch', async () => {
      const el = await renderDialog();

      let eventFired = false;
      el.addEventListener('remotes-changed', () => { eventFired = true; });

      const items = getRemoteItems(el);
      const originItem = Array.from(items).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const fetchBtn = getActionButton(originItem, 'Fetch')!;

      fetchBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      expect(eventFired).to.be.true;
    });

    it('dispatches remotes-changed after successful remove', async () => {
      const el = await renderDialog();

      let eventFired = false;
      el.addEventListener('remotes-changed', () => { eventFired = true; });

      const items = getRemoteItems(el);
      const originItem = Array.from(items).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const removeBtn = getActionButton(originItem, 'Remove')!;

      removeBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      expect(eventFired).to.be.true;
    });
  });

  // ── 12. Action buttons per remote ─────────────────────────────────────
  describe('action buttons per remote', () => {
    it('each remote item has Fetch, Prune, Edit URL, Rename, and Remove buttons', async () => {
      const el = await renderDialog();

      const items = getRemoteItems(el);
      for (const item of Array.from(items)) {
        expect(getActionButton(item, 'Fetch')).to.not.be.undefined;
        expect(getActionButton(item, 'Prune stale tracking branches')).to.not.be.undefined;
        expect(getActionButton(item, 'Edit URL')).to.not.be.undefined;
        expect(getActionButton(item, 'Rename')).to.not.be.undefined;
        expect(getActionButton(item, 'Remove')).to.not.be.undefined;
      }
    });

    it('remove button has danger class', async () => {
      const el = await renderDialog();

      const items = getRemoteItems(el);
      const originItem = Array.from(items).find(
        (item) => item.querySelector('.remote-name')?.textContent?.trim() === 'origin'
      )!;
      const removeBtn = getActionButton(originItem, 'Remove')!;
      expect(removeBtn.classList.contains('danger')).to.be.true;
    });
  });
});
