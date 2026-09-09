/**
 * The graph's multi-selection, from `commit-selected` through to the actions
 * the commit context menu offers over it.
 *
 * The canvas has always shipped every selected commit on `commit-selected`,
 * and app-shell read only `.commit` — so selecting eight commits led to a menu
 * that could act on exactly one of them. These cover the state, the menu the
 * selection grows, and the batch cherry-pick's ordering, confirmation and
 * partial-failure reporting.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
const invokeCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
const mockResponses: Record<string, (args: Record<string, unknown>) => unknown> = {};

let cbId = 0;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: Record<string, unknown>) => {
    invokeCalls.push({ command, args: args || {} });
    const handler = mockResponses[command];
    if (handler) {
      const value = handler(args || {});
      // A Rust command failure arrives as a rejection: an Error for a plain
      // message, or the {code, message} object the backend serialises.
      if (value instanceof Error) return Promise.reject(value);
      if (value && typeof value === 'object' && '__reject__' in (value as object)) {
        return Promise.reject((value as { __reject__: unknown }).__reject__);
      }
      return Promise.resolve(value);
    }
    return Promise.resolve(null);
  },
  transformCallback: () => cbId++,
};

// Tearing a mounted shell down unlistens every Tauri event it registered, and
// the event plugin reaches for this global to do it.
(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => {},
};

// ── Imports (after the Tauri mock) ─────────────────────────────────────────
import { expect } from '@open-wc/testing';
import type { AppShell } from '../app-shell.ts';
import '../app-shell.ts';
import { uiStore, repositoryStore } from '../stores/index.ts';
import { dialogs } from '../stores/dialog.store.ts';
import type { Commit, Repository } from '../types/git.types.ts';
import { resetRefOpLocks, tryAcquireRefOp } from '../utils/ref-lock.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

const REPO_PATH = '/repo/multi';

function makeCommit(oid: string, summary: string, parentIds: string[] = []): Commit {
  return {
    oid: oid.padEnd(40, '0'),
    shortId: oid.substring(0, 7),
    message: summary,
    summary,
    body: null,
    author: { name: 'Test Author', email: 'test@example.com', timestamp: 1700000000 },
    committer: { name: 'Test Author', email: 'test@example.com', timestamp: 1700000000 },
    parentIds,
    timestamp: 1700000000,
  };
}

// The graph's walk is newest first, so `oldest` is the ancestor of all three.
const newest = makeCommit('ccc3333', 'Third commit', ['bbb2222'.padEnd(40, '0')]);
const middle = makeCommit('bbb2222', 'Second commit', ['aaa1111'.padEnd(40, '0')]);
const oldest = makeCommit('aaa1111', 'First commit');
const loadedCommits = [newest, middle, oldest];

function mockRepo(): Repository {
  return {
    path: REPO_PATH,
    name: 'multi',
    isValid: true,
    isBare: false,
    headRef: 'refs/heads/main',
    detachedHeadOid: null,
    state: 'clean',
    isShallow: false,
    isPartialClone: false,
    cloneFilter: null,
  };
}

/**
 * A real AppShell with a repository and a graph whose loaded commits are the
 * three above. `graphCanvas` is a @query getter, so the ordering authority is
 * read through a method the test can stand in for.
 */
function shellOnRepo(): AppShell {
  const el = document.createElement('lv-app-shell') as AppShell;
  (el as any).activeRepository = {
    repository: mockRepo(),
    currentBranch: { name: 'main', shorthand: 'main', isHead: true },
    branches: [],
    remotes: [],
    tags: [],
    stashes: [],
    status: [],
    stagedFiles: [],
    unstagedFiles: [],
  };
  (el as any).loadedGraphCommits = () => loadedCommits;
  return el;
}

/** Put the shell in the state a right-click inside a multi-selection leaves. */
function selectAndOpenMenu(el: AppShell, selection: Commit[], subject: Commit): void {
  (el as any).handleCommitSelected(
    new CustomEvent('commit-selected', {
      detail: { commit: subject, commits: selection, refs: [] },
    }),
  );
  (el as any).contextMenu = { visible: true, x: 10, y: 10, commit: subject };
}

/**
 * Stand in for a dialog `@query` finds. The decorator installs a getter on the
 * prototype, so a plain assignment throws — the property has to be redefined
 * on the instance.
 */
function stubDialog(el: AppShell, name: string, open: (opts: unknown) => void): void {
  Object.defineProperty(el, name, { value: { open }, configurable: true });
}

function calls(command: string): Array<{ command: string; args: Record<string, unknown> }> {
  return invokeCalls.filter((c) => c.command === command);
}

function toastMessages(): string[] {
  return uiStore.getState().toasts.map((t) => t.message);
}

function lastToast() {
  const toasts = uiStore.getState().toasts;
  return toasts[toasts.length - 1];
}

async function menuItems(el: AppShell): Promise<HTMLButtonElement[]> {
  await (el as any).updateComplete;
  return Array.from(
    (el as any).renderRoot.querySelectorAll('.context-menu-item'),
  ) as HTMLButtonElement[];
}

function labelsOf(items: HTMLButtonElement[]): string[] {
  return items.map((b) => (b.textContent ?? '').trim());
}

describe('app-shell graph multi-selection', () => {
  beforeEach(() => {
    resetRefOpLocks();
    invokeCalls.length = 0;
    for (const key of Object.keys(mockResponses)) delete mockResponses[key];
    mockResponses['plugin:dialog|confirm'] = () => true;
    mockResponses['plugin:dialog|message'] = () => 'Ok';
    mockResponses['cherry_pick'] = () => newest;
    mockResponses['open_repository'] = () => ({
      repository: mockRepo(),
      branches: [],
      currentBranch: null,
      remotes: [],
      tags: [],
      stashes: [],
      status: [],
      stagedFiles: [],
      unstagedFiles: [],
    });
    uiStore.setState({ toasts: [] });
    repositoryStore.getState().reset();
  });

  afterEach(() => {
    repositoryStore.getState().reset();
    resetRefOpLocks();
  });

  describe('selection state', () => {
    it('keeps every selected commit the graph announces', () => {
      const el = shellOnRepo();
      selectAndOpenMenu(el, [newest, oldest], newest);
      expect((el as any).selectedCommits.map((c: Commit) => c.oid)).to.deep.equal([
        newest.oid,
        oldest.oid,
      ]);
    });

    it('clears the list when the graph falls back to a single commit', () => {
      const el = shellOnRepo();
      selectAndOpenMenu(el, [newest, oldest], newest);
      (el as any).handleCommitSelected(
        new CustomEvent('commit-selected', {
          detail: { commit: middle, commits: [middle], refs: [] },
        }),
      );
      expect((el as any).selectedCommits).to.deep.equal([]);
      expect((el as any).menuSelection).to.deep.equal([]);
    });

    it('acts on nobody when the right-clicked commit is outside the selection', () => {
      const el = shellOnRepo();
      selectAndOpenMenu(el, [newest, oldest], newest);
      (el as any).contextMenu = { visible: true, x: 0, y: 0, commit: middle };
      expect((el as any).menuSelection).to.deep.equal([]);
    });

    it('drops commits a graph reload rewrote away', () => {
      const el = shellOnRepo();
      const gone = makeCommit('fff6666', 'Rewritten away');
      selectAndOpenMenu(el, [newest, gone, oldest], newest);
      expect((el as any).menuSelection.map((c: Commit) => c.oid)).to.deep.equal([
        oldest.oid,
        newest.oid,
      ]);
    });

    it('offers nothing when the right-clicked commit is the one that was rewritten away', () => {
      const el = shellOnRepo();
      const gone = makeCommit('fff6666', 'Rewritten away');
      selectAndOpenMenu(el, [gone, newest, oldest], gone);
      expect((el as any).menuSelection).to.deep.equal([]);
    });

    it('orders the selection ancestor first, not click first', () => {
      const el = shellOnRepo();
      selectAndOpenMenu(el, [newest, oldest, middle], middle);
      expect((el as any).menuSelection.map((c: Commit) => c.summary)).to.deep.equal([
        'First commit',
        'Second commit',
        'Third commit',
      ]);
    });
  });

  describe('the commit context menu', () => {
    it('offers only the single-commit actions for one selected commit', async () => {
      const el = shellOnRepo();
      document.body.appendChild(el);
      try {
        selectAndOpenMenu(el, [newest], newest);
        const labels = labelsOf(await menuItems(el));
        expect(labels).to.include('Cherry-pick');
        expect(labels.some((l) => /commits$/.test(l)), 'no batch entries for one commit').to.equal(
          false,
        );
        expect((el as any).renderRoot.querySelector('[data-testid="multi-commit-actions"]')).to.be
          .null;
      } finally {
        el.remove();
      }
    });

    it('offers cherry-pick, patch and compare for exactly two commits', async () => {
      const el = shellOnRepo();
      document.body.appendChild(el);
      try {
        selectAndOpenMenu(el, [newest, oldest], newest);
        const labels = labelsOf(await menuItems(el));
        expect(labels).to.include('Cherry-pick 2 commits');
        expect(labels).to.include('Create patch from 2 commits');
        expect(labels).to.include('Compare these commits');
        const count = (el as any).renderRoot.querySelector('[data-testid="multi-commit-count"]');
        expect(count?.textContent?.trim()).to.equal('2 commits selected');
        // The single-commit items stay, under a label that says whose they are.
        const scope = (el as any).renderRoot.querySelector('[data-testid="single-commit-scope"]');
        expect(scope?.textContent).to.contain(newest.shortId);
        expect(labels).to.include('Cherry-pick');
      } finally {
        el.remove();
      }
    });

    it('drops Compare for three commits — it compares two refs', async () => {
      const el = shellOnRepo();
      document.body.appendChild(el);
      try {
        selectAndOpenMenu(el, [newest, middle, oldest], middle);
        const labels = labelsOf(await menuItems(el));
        expect(labels).to.include('Cherry-pick 3 commits');
        expect(labels).to.include('Create patch from 3 commits');
        expect(labels).to.not.include('Compare these commits');
      } finally {
        el.remove();
      }
    });

    it('greys the batch cherry-pick out while the repository is busy', async () => {
      const el = shellOnRepo();
      document.body.appendChild(el);
      try {
        selectAndOpenMenu(el, [newest, oldest], newest);
        tryAcquireRefOp(REPO_PATH);
        (el as any).refOpsVersion = ((el as any).refOpsVersion ?? 0) + 1;
        const items = await menuItems(el);
        const pick = items.find((b) => b.dataset.testid === 'multi-cherry-pick');
        const patch = items.find((b) => b.dataset.testid === 'multi-create-patch');
        expect(pick?.disabled, 'a batch pick mutates the working tree').to.equal(true);
        expect(patch?.disabled, 'writing patch files does not').to.equal(false);
      } finally {
        el.remove();
      }
    });
  });

  describe('batch cherry-pick', () => {
    it('applies every selected commit ancestor first, whatever the click order', async () => {
      const el = shellOnRepo();
      selectAndOpenMenu(el, [newest, oldest, middle], middle);

      await (el as any).handleCherryPickSelection();

      expect(calls('cherry_pick').map((c) => c.args.commitOid)).to.deep.equal([
        oldest.oid,
        middle.oid,
        newest.oid,
      ]);
      expect((el as any).contextMenu.visible, 'the menu closes on the action').to.equal(false);
    });

    it('confirms first, naming the count and the ordered commits', async () => {
      const el = shellOnRepo();
      selectAndOpenMenu(el, [newest, oldest, middle], middle);

      await (el as any).handleCherryPickSelection();

      const confirms = calls('plugin:dialog|message');
      expect(confirms).to.have.length(1);
      const message = String(confirms[0].args.message);
      expect(message).to.contain('Cherry-pick 3 commits onto main');
      expect(message).to.contain('1. aaa1111 First commit');
      expect(message).to.contain('2. bbb2222 Second commit');
      expect(message).to.contain('3. ccc3333 Third commit');
    });

    it('applies nothing when the confirm is declined', async () => {
      mockResponses['plugin:dialog|message'] = () => 'Cancel';
      mockResponses['plugin:dialog|confirm'] = () => false;
      const el = shellOnRepo();
      selectAndOpenMenu(el, [newest, oldest], newest);

      await (el as any).handleCherryPickSelection();

      expect(calls('cherry_pick')).to.have.length(0);
    });

    it('refreshes the repository and toasts on success', async () => {
      const el = shellOnRepo();
      selectAndOpenMenu(el, [newest, oldest], newest);

      await (el as any).handleCherryPickSelection();

      expect(lastToast()?.type).to.equal('success');
      expect(lastToast()?.message).to.contain('Cherry-picked 2 commits onto main');
      expect(calls('open_repository').length, 'handleRefresh ran').to.be.greaterThan(0);
    });

    it('stops at the first failure and reports what was and was not applied', async () => {
      let seen = 0;
      mockResponses['cherry_pick'] = () => {
        seen += 1;
        if (seen === 2) return new Error('could not apply patch');
        return newest;
      };
      const el = shellOnRepo();
      selectAndOpenMenu(el, [newest, oldest, middle], middle);

      await (el as any).handleCherryPickSelection();

      expect(calls('cherry_pick').map((c) => c.args.commitOid), 'the rest are left alone').to.deep.equal([
        oldest.oid,
        middle.oid,
      ]);
      const error = uiStore.getState().toasts.find((t) => t.type === 'error');
      expect(error, 'a failure is never silent').to.not.be.undefined;
      expect(error?.message).to.contain('Cherry-picked 1 of 3 commits');
      expect(error?.message).to.contain('bbb2222 Second commit');
      expect(error?.message).to.contain('could not apply patch');
      expect(error?.message).to.contain('Still to apply after it: ccc3333');
    });

    it('opens the existing conflict dialog when a pick conflicts', async () => {
      mockResponses['cherry_pick'] = () => ({
        __reject__: { code: 'CHERRY_PICK_CONFLICT', message: 'conflicts detected' },
      });
      const el = shellOnRepo();
      document.body.appendChild(el);
      try {
        selectAndOpenMenu(el, [newest, oldest], newest);

        await (el as any).handleCherryPickSelection();

        expect((el as any).conflictOperationType).to.equal('cherry-pick');
        expect(dialogs.isOpen('conflict'), 'the conflict dialog is the shared one').to.equal(true);
        expect(
          uiStore.getState().toasts.some((t) => t.type === 'error'),
          'the partial report is shown alongside the dialog',
        ).to.equal(true);
      } finally {
        el.remove();
      }
    });

    it('refuses a batch containing a merge commit before applying anything', async () => {
      const merge = makeCommit('ddd4444', 'Merge branch', [
        'aaa1111'.padEnd(40, '0'),
        'bbb2222'.padEnd(40, '0'),
      ]);
      const el = shellOnRepo();
      (el as any).loadedGraphCommits = () => [merge, ...loadedCommits];
      selectAndOpenMenu(el, [merge, oldest], merge);

      await (el as any).handleCherryPickSelection();

      expect(calls('cherry_pick')).to.have.length(0);
      expect(toastMessages().join(' ')).to.contain('merge commit');
    });

    it('refuses to run while another operation holds the repository', async () => {
      const el = shellOnRepo();
      selectAndOpenMenu(el, [newest, oldest], newest);
      tryAcquireRefOp(REPO_PATH);

      await (el as any).handleCherryPickSelection();

      expect(calls('cherry_pick')).to.have.length(0);
      expect(toastMessages().length, 'the refusal is audible').to.be.greaterThan(0);
    });

    it('releases the working-tree lock when it finishes', async () => {
      const el = shellOnRepo();
      selectAndOpenMenu(el, [newest, oldest], newest);

      await (el as any).handleCherryPickSelection();

      const { isRefOpRunning } = await import('../utils/ref-lock.ts');
      expect(isRefOpRunning(REPO_PATH)).to.equal(false);
    });
  });

  describe('batch patch and compare', () => {
    it('deep-links every selected commit into the export dialog', async () => {
      const el = shellOnRepo();
      let opened: unknown = null;
      stubDialog(el, 'exportImportDialog', (opts: unknown) => {
        opened = opts;
      });
      selectAndOpenMenu(el, [newest, oldest, middle], middle);

      (el as any).handleCreatePatchFromSelection();

      expect(opened).to.deep.equal({
        tab: 'patch',
        patchMode: 'create',
        commitOids: [oldest.oid, middle.oid, newest.oid],
      });
      expect((el as any).contextMenu.visible).to.equal(false);
    });

    it('compares two commits with the ancestor as the base', () => {
      const el = shellOnRepo();
      let opened: any = null;
      stubDialog(el, 'compareBranchesDialog', (opts: unknown) => {
        opened = opts;
      });
      selectAndOpenMenu(el, [newest, oldest], newest);

      (el as any).handleCompareSelection();

      expect(opened.baseRef).to.equal(oldest.oid);
      expect(opened.compareRef).to.equal(newest.oid);
      expect(opened.extraRefs.map((r: { ref: string }) => r.ref)).to.deep.equal([
        oldest.oid,
        newest.oid,
      ]);
      expect(opened.extraRefs[0].label).to.contain('aaa1111');
    });

    it('does not compare three commits', () => {
      const el = shellOnRepo();
      let opened: unknown = null;
      stubDialog(el, 'compareBranchesDialog', (opts: unknown) => {
        opened = opts;
      });
      selectAndOpenMenu(el, [newest, oldest, middle], middle);

      (el as any).handleCompareSelection();

      expect(opened).to.be.null;
    });
  });
});
