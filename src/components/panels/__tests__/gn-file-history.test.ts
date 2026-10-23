/**
 * Unit tests for gn-file-history component.
 *
 * Verifies:
 *   - diff and blame actions use the path the file had AT THAT COMMIT, which
 *     differs from the file's current path for entries older than a rename.
 *   - the historical path is surfaced on those rows.
 *   - a failed history load shows an error and lists nothing.
 *   - clipboard copy failures show an error toast instead of failing silently.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);

/** Every invoke made during a test, so a restore can be asserted end to end. */
const invokeHistory: Array<{ command: string; args?: unknown }> = [];
/** Button label the mocked confirm resolves with. 'Ok' means accepted. */
let confirmAnswer = 'Ok';

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    // plugin-dialog 2.x routes confirm() through `message` and reads true only
    // from the OK button label.
    if (command === 'plugin:dialog|message') return Promise.resolve(confirmAnswer);
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import { uiStore } from '../../../stores/ui.store.ts';
import type { Commit, FileHistoryEntry } from '../../../types/git.types.ts';
import type { GnFileHistory } from '../gn-file-history.ts';
import '../gn-file-history.ts';
import { resetRefOpLocks } from '../../../utils/ref-lock.ts';

const REPO_PATH = '/test/repo';
const CURRENT_PATH = 'src/main.ts';
const OLD_PATH = 'src/old-main.ts';

const now = Math.floor(Date.now() / 1000);

function commit(oid: string, shortId: string, summary: string): Commit {
  return {
    oid,
    shortId,
    summary,
    message: summary,
    body: null,
    timestamp: now,
    author: { name: 'Test User', email: 'test@example.com', timestamp: now },
    committer: { name: 'Test User', email: 'test@example.com', timestamp: now },
    parentIds: [],
  };
}

/** Entry from after the rename — its path is the file's current path. */
const postRename: FileHistoryEntry = {
  commit: commit('aaa111', 'aaa111a', 'Edit after rename'),
  pathAtCommit: CURRENT_PATH,
};

/** Entry from before the rename — the file lived under a different name. */
const preRename: FileHistoryEntry = {
  commit: commit('bbb222', 'bbb222b', 'Add original'),
  pathAtCommit: OLD_PATH,
};

async function renderHistory(): Promise<GnFileHistory> {
  const el = await fixture<GnFileHistory>(
    html`<gn-file-history
      .repositoryPath=${REPO_PATH}
      .filePath=${CURRENT_PATH}
    ></gn-file-history>`
  );
  await waitUntil(
    () => el.shadowRoot!.querySelectorAll('.commit-item').length === 2,
    'file history entries never rendered'
  );
  return el;
}

describe('gn-file-history', () => {
  beforeEach(() => {
    uiStore.setState({ toasts: [] });
    invokeHistory.length = 0;
    confirmAnswer = 'Ok';
    resetRefOpLocks();
    mockInvoke = async (command: string) => {
      if (command === 'get_file_history') return [postRename, preRename];
      return null;
    };
  });

  afterEach(() => {
    resetRefOpLocks();
  });

  describe('view-diff event', () => {
    it('dispatches view-diff with the path the file had at that commit', async () => {
      const el = await renderHistory();

      let received: { commitOid: string; filePath: string } | null = null;
      el.addEventListener('view-diff', (e) => {
        received = (e as CustomEvent).detail;
      });

      const buttons = el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.view-diff-btn');
      buttons[1].click();

      expect(received).to.not.be.null;
      expect(received!.commitOid).to.equal(preRename.commit.oid);
      expect(received!.filePath).to.equal(OLD_PATH);
    });

    it('uses the current path for an entry that was not renamed', async () => {
      const el = await renderHistory();

      let received: { commitOid: string; filePath: string } | null = null;
      el.addEventListener('view-diff', (e) => {
        received = (e as CustomEvent).detail;
      });

      const buttons = el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.view-diff-btn');
      buttons[0].click();

      expect(received).to.not.be.null;
      expect(received!.filePath).to.equal(CURRENT_PATH);
    });
  });

  describe('show-blame event', () => {
    it('dispatches show-blame with the path the file had at that commit', async () => {
      const el = await renderHistory();

      let received: { filePath: string; commitOid: string } | null = null;
      el.addEventListener('show-blame', (e) => {
        received = (e as CustomEvent).detail;
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).contextMenu = { visible: true, x: 0, y: 0, entry: preRename };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).handleContextViewBlame();

      expect(received).to.not.be.null;
      expect(received!.filePath).to.equal(OLD_PATH);
      expect(received!.commitOid).to.equal(preRename.commit.oid);
    });

    it('uses the current path when the file was not renamed', async () => {
      const el = await renderHistory();

      let received: { filePath: string; commitOid: string } | null = null;
      el.addEventListener('show-blame', (e) => {
        received = (e as CustomEvent).detail;
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).contextMenu = { visible: true, x: 0, y: 0, entry: postRename };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).handleContextViewBlame();

      expect(received).to.not.be.null;
      expect(received!.filePath).to.equal(CURRENT_PATH);
      expect(received!.commitOid).to.equal(postRename.commit.oid);
    });
  });

  describe('historical path display', () => {
    it('shows the historical path only on entries whose path differs', async () => {
      const el = await renderHistory();

      const items = el.shadowRoot!.querySelectorAll('.commit-item');
      expect(items[0].querySelector('.commit-path')).to.be.null;

      const historical = items[1].querySelector('.commit-path');
      expect(historical).to.not.be.null;
      expect(historical!.textContent!.trim()).to.equal(OLD_PATH);
    });
  });

  describe('error handling', () => {
    it('shows the error message and no entries when history fails', async () => {
      mockInvoke = async (command: string) => {
        if (command === 'get_file_history') throw new Error('boom');
        return null;
      };

      const el = await fixture<GnFileHistory>(
        html`<gn-file-history
          .repositoryPath=${REPO_PATH}
          .filePath=${CURRENT_PATH}
        ></gn-file-history>`
      );
      await waitUntil(
        () => el.shadowRoot!.querySelector('.error') !== null,
        'error state never rendered'
      );

      expect(el.shadowRoot!.querySelectorAll('.commit-item').length).to.equal(0);
      expect(el.shadowRoot!.querySelector('.error')!.textContent).to.contain('boom');
    });
  });

  describe('clipboard error feedback', () => {
    it('shows an error toast when copying a hash fails', async () => {
      const el = await renderHistory();

      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error('denied')) },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).contextMenu = { visible: true, x: 0, y: 0, entry: postRename };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleContextCopyHash();

      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'error' && /copy hash/i.test(t.message))).to.be.true;
    });
  });
  describe('restore this version', () => {
    const RESTORE_LABEL = /restore this version/i;

    async function openMenu(el: GnFileHistory, rowIndex = 0): Promise<HTMLButtonElement[]> {
      const rows = el.shadowRoot!.querySelectorAll('.commit-item');
      expect(rows.length, 'no commit row rendered').to.be.greaterThan(rowIndex);
      rows[rowIndex].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await el.updateComplete;
      return Array.from(el.shadowRoot!.querySelectorAll('.context-menu .context-menu-item'));
    }

    function restoreCalls(): Array<{ command: string; args?: unknown }> {
      return invokeHistory.filter((c) => c.command === 'checkout_file_from_commit');
    }

    it("restores the panel's file from the right-clicked commit", async () => {
      const el = await renderHistory();

      const items = await openMenu(el, 0);
      const restore = items.find((i) => RESTORE_LABEL.test(i.textContent ?? ''));
      expect(restore, 'the commit menu offers a restore').to.not.be.undefined;
      restore!.click();
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 0));

      // The path comes from the entry the user right-clicked, the version
      // from that entry's commit.
      const calls = restoreCalls();
      expect(calls).to.have.lengthOf(1);
      expect(calls[0].args).to.deep.equal({
        path: REPO_PATH,
        filePath: CURRENT_PATH,
        commit: postRename.commit.oid,
      });
      expect(
        uiStore.getState().toasts.some((t) => t.type === 'success' && t.message.includes(CURRENT_PATH))
      ).to.be.true;
    });

    it('reports a commit that does not contain the file', async () => {
      const el = await renderHistory();
      mockInvoke = async (command: string) => {
        if (command === 'checkout_file_from_commit') {
          throw {
            code: 'COMMAND_ERROR',
            message: `File '${CURRENT_PATH}' not found in commit ${postRename.commit.shortId}`,
          };
        }
        return command === 'get_file_history' ? [postRename, preRename] : null;
      };

      const items = await openMenu(el, 0);
      items.find((i) => RESTORE_LABEL.test(i.textContent ?? ''))!.click();
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 0));

      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'error' && /not found in commit/.test(t.message))).to.be
        .true;
    });

    it('restores a pre-rename commit under the path the file had then', async () => {
      // The panel loads with follow=true, so rows from before a rename hold the
      // file under its OLD name — the current name is not in those trees at
      // all, and restoring it could only fail.
      const el = await renderHistory();

      const items = await openMenu(el, 1);
      items.find((i) => RESTORE_LABEL.test(i.textContent ?? ''))!.click();
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 0));

      const calls = restoreCalls();
      expect(calls).to.have.lengthOf(1);
      expect(calls[0].args).to.deep.equal({
        path: REPO_PATH,
        filePath: OLD_PATH,
        commit: preRename.commit.oid,
      });
      expect(
        uiStore
          .getState()
          .toasts.some((t) => t.type === 'success' && t.message.includes(OLD_PATH))
      ).to.be.true;
    });

    it('does nothing when the confirm is declined', async () => {
      const el = await renderHistory();
      confirmAnswer = 'Cancel';

      const items = await openMenu(el, 0);
      items.find((i) => RESTORE_LABEL.test(i.textContent ?? ''))!.click();
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 0));

      expect(restoreCalls()).to.have.lengthOf(0);
      expect(uiStore.getState().toasts).to.have.lengthOf(0);
    });
  });
});
