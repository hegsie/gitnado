/**
 * Commit Details Panel Tests
 *
 * Tests error handling on loadFiles failure.
 */

import { expect, fixture, html } from '@open-wc/testing';
import { uiStore } from '../../../stores/ui.store.ts';
import type { Commit } from '../../../types/git.types.ts';
import { resetRefOpLocks } from '../../../utils/ref-lock.ts';

let failingCommands: Set<string> = new Set();
let mockFiles: unknown[] = [];
let cbId = 0;
/** Every invoke made during a test, so restore can be asserted end to end. */
const invokeHistory: Array<{ command: string; args?: unknown }> = [];
/** Button label the mocked confirm resolves with. 'Ok' means accepted. */
let confirmAnswer = 'Ok';

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

const mockInvoke: MockInvoke = async (command: string) => {
  if (command === 'plugin:notification|is_permission_granted') return false;

  // plugin-dialog 2.x routes confirm() through `message` and reads true only
  // from the OK button label.
  if (command === 'plugin:dialog|message') return confirmAnswer;

  if (failingCommands.has(command)) {
    throw { code: 'COMMAND_ERROR', message: 'Failed to get files' };
  }

  if (command === 'get_commit_files') {
    return mockFiles;
  }

  return null;
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// Import AFTER setting up the mock
import '../gn-commit-details.ts';
import type { GnCommitDetails } from '../gn-commit-details.ts';

const mockCommit: Commit = {
  oid: 'abc123def456',
  shortId: 'abc123d',
  summary: 'Test commit',
  message: 'Test commit',
  body: null,
  timestamp: Math.floor(Date.now() / 1000),
  author: { name: 'Test User', email: 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
  committer: { name: 'Test User', email: 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
  parentIds: [],
};

describe('gn-commit-details', () => {
  beforeEach(() => {
    failingCommands = new Set();
    mockFiles = [];
    invokeHistory.length = 0;
    confirmAnswer = 'Ok';
    uiStore.setState({ toasts: [] });
    resetRefOpLocks();
  });

  afterEach(() => {
    resetRefOpLocks();
  });

  it('shows the previous path for a renamed file', async () => {
    mockFiles = [
      {
        path: 'src/new-name.ts',
        oldPath: 'src/old-name.ts',
        status: 'renamed',
        additions: 3,
        deletions: 1,
      },
    ];

    const el = await fixture<GnCommitDetails>(
      html`<gn-commit-details .repositoryPath=${'/test/repo'} .commit=${mockCommit}></gn-commit-details>`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).loadFiles();
    await el.updateComplete;

    const renamedFrom = el.shadowRoot!.querySelector('.file-renamed-from');
    expect(renamedFrom).to.not.be.null;
    expect(renamedFrom!.textContent).to.contain('src/old-name.ts');
  });

  it('renders with a commit', async () => {
    const el = await fixture<GnCommitDetails>(
      html`<gn-commit-details .repositoryPath=${'/test/repo'} .commit=${mockCommit}></gn-commit-details>`,
    );

    expect(el).to.not.be.null;
  });

  it('handles loadFiles failure gracefully', async () => {
    failingCommands.add('get_commit_files');

    const el = await fixture<GnCommitDetails>(
      html`<gn-commit-details .repositoryPath=${'/test/repo'} .commit=${mockCommit}></gn-commit-details>`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).loadFiles();

    // Files should remain empty after failure
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).files).to.have.length(0);
    // Loading state should be cleared
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).loadingFiles).to.be.false;
  });

  it('shows an error message (not "No files changed") when loadFiles fails', async () => {
    failingCommands.add('get_commit_files');

    const el = await fixture<GnCommitDetails>(
      html`<gn-commit-details .repositoryPath=${'/test/repo'} .commit=${mockCommit}></gn-commit-details>`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).loadFiles();
    await el.updateComplete;

    // filesError state is set to the backend message
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).filesError).to.contain('Failed to get files');

    // The error is rendered, and the misleading "No files changed" is NOT shown
    const errorNode = el.shadowRoot!.querySelector('.files-error');
    expect(errorNode).to.not.be.null;
    expect(errorNode!.textContent).to.contain('Failed to get files');

    const text = el.shadowRoot!.textContent ?? '';
    expect(text).to.not.contain('No files changed');
  });

  it('clears filesError and shows files on a subsequent successful load', async () => {
    const el = await fixture<GnCommitDetails>(
      html`<gn-commit-details .repositoryPath=${'/test/repo'} .commit=${mockCommit}></gn-commit-details>`,
    );

    // First load fails
    failingCommands.add('get_commit_files');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).loadFiles();
    await el.updateComplete;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).filesError).to.not.be.null;

    // Second load succeeds -> error must clear
    failingCommands.delete('get_commit_files');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).loadFiles();
    await el.updateComplete;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).filesError).to.be.null;
    expect(el.shadowRoot!.querySelector('.files-error')).to.be.null;
  });

  it('dispatches copy-sha after copying the full SHA', async () => {
    const el = await fixture<GnCommitDetails>(
      html`<gn-commit-details .repositoryPath=${'/test/repo'} .commit=${mockCommit}></gn-commit-details>`,
    );

    let received: { sha: string } | null = null;
    el.addEventListener('copy-sha', (e) => {
      received = (e as CustomEvent).detail;
    });

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).copyFullSha();

    expect(received).to.not.be.null;
    expect(received!.sha).to.equal(mockCommit.oid.substring(0, 7));
  });

  it('shows an error toast when copying the SHA fails', async () => {
    uiStore.setState({ toasts: [] });

    const el = await fixture<GnCommitDetails>(
      html`<gn-commit-details .repositoryPath=${'/test/repo'} .commit=${mockCommit}></gn-commit-details>`,
    );

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).copyFullSha();

    const toasts = uiStore.getState().toasts;
    expect(toasts.some((t) => t.type === 'error' && /copy sha/i.test(t.message))).to.be.true;
  });
  describe('restore a file from this commit', () => {
    const RESTORE_LABEL = /restore this version/i;

    async function renderWithFiles(files: unknown[]): Promise<GnCommitDetails> {
      mockFiles = files;
      const el = await fixture<GnCommitDetails>(
        html`<gn-commit-details .repositoryPath=${'/test/repo'} .commit=${mockCommit}></gn-commit-details>`,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).loadFiles();
      await el.updateComplete;
      return el;
    }

    /** Right-click a file row and return the rendered context menu items. */
    async function openMenuOn(el: GnCommitDetails, path: string): Promise<HTMLButtonElement[]> {
      // The row shows only the basename; the full path is the title attribute.
      const rows = Array.from(el.shadowRoot!.querySelectorAll('.file-item'));
      const row = rows.find((r) => r.getAttribute('title') === path);
      expect(row, `no file row for ${path}`).to.not.be.undefined;
      row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await el.updateComplete;
      return Array.from(el.shadowRoot!.querySelectorAll('.context-menu .context-menu-item'));
    }

    function itemMatching(items: HTMLButtonElement[], re: RegExp): HTMLButtonElement | undefined {
      return items.find((i) => re.test(i.textContent ?? ''));
    }

    function restoreCalls(): Array<{ command: string; args?: unknown }> {
      return invokeHistory.filter((c) => c.command === 'checkout_file_from_commit');
    }

    it('offers Restore this version for a file the commit changed, and not for one it deleted', async () => {
      const el = await renderWithFiles([
        { path: 'src/main.ts', status: 'modified', additions: 2, deletions: 1 },
        { path: 'src/gone.ts', status: 'deleted', additions: 0, deletions: 9 },
      ]);

      const modifiedItems = await openMenuOn(el, 'src/main.ts');
      expect(itemMatching(modifiedItems, RESTORE_LABEL), 'modified file offers restore').to.not.be
        .undefined;

      const deletedItems = await openMenuOn(el, 'src/gone.ts');
      // The blob is not in this commit's tree, so restoring it cannot work.
      expect(itemMatching(deletedItems, RESTORE_LABEL), 'deleted file hides restore').to.be
        .undefined;
    });

    it('restores the file from the displayed commit after the confirm', async () => {
      const el = await renderWithFiles([
        { path: 'src/main.ts', status: 'modified', additions: 2, deletions: 1 },
      ]);

      const items = await openMenuOn(el, 'src/main.ts');
      const restore = itemMatching(items, RESTORE_LABEL);
      expect(restore).to.not.be.undefined;
      restore!.click();
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 0));

      const calls = restoreCalls();
      expect(calls).to.have.lengthOf(1);
      expect(calls[0].args).to.deep.equal({
        path: '/test/repo',
        filePath: 'src/main.ts',
        commit: mockCommit.oid,
      });

      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'success' && t.message.includes('src/main.ts'))).to.be
        .true;
    });

    it('shows the backend error and refreshes nothing when the restore fails', async () => {
      const el = await renderWithFiles([
        { path: 'src/main.ts', status: 'modified', additions: 2, deletions: 1 },
      ]);
      failingCommands.add('checkout_file_from_commit');

      let refreshed = false;
      const onRefresh = (): void => {
        refreshed = true;
      };
      window.addEventListener('repository-refresh', onRefresh);

      try {
        const items = await openMenuOn(el, 'src/main.ts');
        itemMatching(items, RESTORE_LABEL)!.click();
        await el.updateComplete;
        await new Promise((r) => setTimeout(r, 0));

        const toasts = uiStore.getState().toasts;
        expect(toasts.some((t) => t.type === 'error')).to.be.true;
        expect(refreshed, 'a failed restore must not claim the repo changed').to.be.false;
      } finally {
        window.removeEventListener('repository-refresh', onRefresh);
      }
    });
  });

  /**
   * gn-right-panel keeps ONE gn-commit-details across tabs and only rebinds
   * `.repositoryPath`/`.commit`. A Ctrl+digit switch produces no document
   * click, and app-shell clears the selected commit — so the panel falls back
   * to its empty state and the menu merely LOOKS closed while still armed with
   * repo A's file. Selecting any commit in repo B brought it straight back, and
   * Restore/Open then joined repo B's path with repo A's file.
   */
  describe('file context menu across a repository switch', () => {
    const otherCommit: Commit = { ...mockCommit, oid: 'fed987cba654', shortId: 'fed987c' };

    /** Let the un-awaited work `updated()` kicks off settle. */
    async function flush(el: GnCommitDetails): Promise<void> {
      for (let i = 0; i < 5; i++) {
        await el.updateComplete;
        await new Promise((r) => setTimeout(r, 0));
      }
      await el.updateComplete;
    }

    function menuCount(el: GnCommitDetails): number {
      return el.shadowRoot!.querySelectorAll('.context-menu').length;
    }

    /** The state the menu entries actually read at click time. */
    function menuState(el: GnCommitDetails): { visible: boolean; file: { path: string } | null } {
      return (el as unknown as { contextMenu: { visible: boolean; file: { path: string } | null } })
        .contextMenu;
    }

    async function mountedWithOpenMenu(): Promise<GnCommitDetails> {
      mockFiles = [{ path: 'src/main.ts', status: 'modified', additions: 2, deletions: 1 }];
      const el = await fixture<GnCommitDetails>(
        html`<gn-commit-details
          .repositoryPath=${'/repo/a'}
          .commit=${mockCommit}
        ></gn-commit-details>`,
      );
      await flush(el);

      const row = el.shadowRoot!.querySelector('.file-item[title="src/main.ts"]');
      expect(row, 'no file row to right-click').to.not.be.null;
      row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await el.updateComplete;

      expect(menuCount(el), 'the menu opens on right-click').to.equal(1);
      expect(menuState(el).visible).to.be.true;
      return el;
    }

    it('disarms the menu on the switch, so selecting a commit in the new repo does not bring it back', async () => {
      const el = await mountedWithOpenMenu();

      // Exactly what a Ctrl+digit switch does: app-shell clears the selection
      // and gn-right-panel rebinds the path on the SAME element. No click.
      el.commit = null;
      el.repositoryPath = '/repo/b';
      await flush(el);

      // The empty state hides the menu node either way, so assert on the state
      // the entries read — that is what tells the two cases apart.
      expect(menuState(el).visible, 'the switch disarms the menu').to.be.false;

      // Selecting a commit in the new repo re-renders the full panel.
      el.commit = otherCommit;
      await flush(el);

      expect(menuCount(el), "repo A's menu must not return over repo B").to.equal(0);
    });

    it('leaves the menu alone on a re-render that does not change the repository', async () => {
      const el = await mountedWithOpenMenu();

      // A real re-render with `changedProperties.has('repositoryPath')` false:
      // the guard must key off a repo CHANGE, not off any update cycle, or a
      // routine refresh yanks the menu out from under the user's click.
      el.githubOwner = 'hegsie';
      await flush(el);

      expect(menuCount(el), 'an unrelated re-render keeps the menu').to.equal(1);
      expect(menuState(el).visible).to.be.true;
      expect(menuState(el).file?.path).to.equal('src/main.ts');
    });

    it('disarms the menu even when the new repository fails to load its files', async () => {
      const el = await mountedWithOpenMenu();

      // The close must land before any await, or a failed load leaves the menu
      // armed behind an error state and it reappears on the next good render.
      failingCommands.add('get_commit_files');
      el.commit = otherCommit;
      el.repositoryPath = '/repo/b';
      await flush(el);

      expect(menuState(el).visible, 'a failed load still disarms the menu').to.be.false;
      expect(menuCount(el), 'no menu is rendered over the error state').to.equal(0);
    });
  });
});
