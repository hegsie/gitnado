/**
 * Guards on two destructive gestures in app-shell.
 *
 * Amend ONLY ever rewrites HEAD — create_commit re-parents
 * `repo.head()?.peel_to_commit()` regardless of which commit the UI believes
 * it is amending. The graph's Amend entry trusted the clicked commit, so
 * amending an older one replaced HEAD instead: HEAD's message became the
 * clicked commit's, staged changes were folded into HEAD, and the commit the
 * user right-clicked was untouched. Reword had always performed the HEAD
 * check; amend was left behind.
 *
 * The Abort banner's double-click flag was claimed AFTER its confirm, so it
 * did not guard the case its own comment named.
 */

const invokeCallArgs: Array<{ command: string; args: Record<string, unknown> }> = [];
const mockResponses: Record<string, (args: Record<string, unknown>) => unknown> = {};

let cbId = 0;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: Record<string, unknown>) => {
    invokeCallArgs.push({ command, args: args || {} });
    const handler = mockResponses[command];
    return Promise.resolve(handler ? handler(args || {}) : null);
  },
  transformCallback: () => cbId++,
};

import { expect } from '@open-wc/testing';
import type { AppShell } from '../app-shell.ts';
import '../app-shell.ts';
import { dialogs } from '../stores/dialog.store.ts';
// Side-effect import so showPrompt finds the singleton already in the DOM.
import '../components/dialogs/lv-prompt-dialog.ts';
import type { LvPromptDialog } from '../components/dialogs/lv-prompt-dialog.ts';
import { uiStore, repositoryStore } from '../stores/index.ts';
import type { Repository, StatusEntry } from '../types/git.types.ts';
import { tryAcquireRefOp, isRefOpRunning, resetRefOpLocks } from '../utils/ref-lock.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The stash shortcut/palette path asks for an optional stash message. '' is
 * "OK with nothing typed", which keeps git's default naming; null is a
 * dismissal.
 */
function setupMockPrompt(value: string | null): void {
  let dialog = document.querySelector<LvPromptDialog>('lv-prompt-dialog');
  if (!dialog) {
    dialog = document.createElement('lv-prompt-dialog') as LvPromptDialog;
    document.body.appendChild(dialog);
  }
  dialog.open = async () => value;
}

function cleanupMockPrompt(): void {
  const dialog = document.querySelector('lv-prompt-dialog');
  if (dialog) dialog.remove();
}

function mockRepo(path: string, name: string, state = 'clean'): Repository {
  return {
    path,
    name,
    isValid: true,
    isBare: false,
    headRef: 'main',
    detachedHeadOid: null,
    state,
    isShallow: false,
    isPartialClone: false,
    cloneFilter: null,
  } as Repository;
}

/** The shape repositoryStore keeps per open repository. */
function emptyRepoData(repo: Repository) {
  return {
    repository: repo,
    branches: [],
    currentBranch: null,
    remotes: [],
    tags: [],
    stashes: [],
    status: [] as StatusEntry[],
    stagedFiles: [],
    unstagedFiles: [],
  };
}

function commit(oid: string) {
  return { oid, summary: `summary of ${oid}`, body: null };
}

// Which dialogs are open is module state, and several tests here drive a shell
// that is never connected to the document (so its connectedCallback reset never
// runs). Clear it per test to keep the isolation each instance used to get for
// free from its own `@state()` flags.
beforeEach(() => {
  dialogs.reset();
});

describe('app-shell destructive guards', () => {
  beforeEach(() => {
    resetRefOpLocks();
    invokeCallArgs.length = 0;
    for (const k of Object.keys(mockResponses)) delete mockResponses[k];
    uiStore.setState({ toasts: [] });
    repositoryStore.getState().reset();
    setupMockPrompt('');
  });

  afterEach(() => {
    repositoryStore.getState().reset();
    cleanupMockPrompt();
  });

  function shellOnRepo(state = 'clean'): AppShell {
    const el = document.createElement('lv-app-shell') as AppShell;
    (el as any).activeRepository = { repository: mockRepo('/repo/one', 'one', state) };
    return el;
  }

  describe('amend from the graph context menu', () => {
    it('does not put a non-HEAD commit into amend mode', async () => {
      mockResponses['get_commit_history'] = () => [commit('headoid')];
      // The commit is on this branch — the off-branch refusal is covered below.
      mockResponses['is_ancestor_of_head'] = () => true;
      const el = shellOnRepo();
      (el as any).contextMenu = { visible: true, x: 0, y: 0, commit: commit('olderoid') };

      let amended: string | null = null;
      const handler = (e: Event): void => {
        amended = (e as CustomEvent<{ commit: { oid: string } }>).detail.commit.oid;
      };
      window.addEventListener('trigger-amend', handler);
      try {
        await (el as any).handleQuickAmend();
      } finally {
        window.removeEventListener('trigger-amend', handler);
      }

      expect(amended, 'amend mode would have rewritten HEAD, not this commit').to.be.null;
    });

    it('routes a non-HEAD commit to interactive rebase instead of dead-ending', async () => {
      mockResponses['get_commit_history'] = () => [commit('headoid')];
      // The commit is on this branch — the off-branch refusal is covered below.
      mockResponses['is_ancestor_of_head'] = () => true;
      const el = shellOnRepo();
      (el as any).contextMenu = { visible: true, x: 0, y: 0, commit: commit('olderoid') };

      let openedOnto: string | null = null;
      let rewordOid: string | undefined;
      // `interactiveRebaseDialog` is a @query getter, so it has to be shadowed
      // on the instance rather than assigned.
      Object.defineProperty(el, 'interactiveRebaseDialog', {
        configurable: true,
        get: () => ({
          open: (onto: string, opts?: { rewordCommitOid?: string }) => {
            openedOnto = onto;
            rewordOid = opts?.rewordCommitOid;
            return Promise.resolve();
          },
        }),
      });

      await (el as any).handleQuickAmend();

      expect(openedOnto).to.equal('olderoid^');
      expect(rewordOid).to.equal('olderoid');
      expect(
        uiStore.getState().toasts.some((t) => /latest commit can be amended/i.test(t.message)),
        'and says why the gesture was redirected',
      ).to.equal(true);
    });

    it('still amends when the clicked commit IS HEAD', async () => {
      mockResponses['get_commit_history'] = () => [commit('headoid')];
      const el = shellOnRepo();
      (el as any).contextMenu = { visible: true, x: 0, y: 0, commit: commit('headoid') };

      let amended: string | null = null;
      const handler = (e: Event): void => {
        amended = (e as CustomEvent<{ commit: { oid: string } }>).detail.commit.oid;
      };
      window.addEventListener('trigger-amend', handler);
      try {
        await (el as any).handleQuickAmend();
      } finally {
        window.removeEventListener('trigger-amend', handler);
      }

      expect(amended).to.equal('headoid');
    });

    it('reveals the panel that owns the listener before dispatching', async () => {
      // trigger-amend is heard only by lv-commit-panel, in the right panel's
      // Changes tab. Right-clicking a commit selects it first, and a new
      // selection auto-switches that panel to Details — so amend mode was
      // turned on inside a tab-panel with display:none and the gesture looked
      // like it did nothing. With the panel hidden entirely there was no
      // listener at all.
      mockResponses['get_commit_history'] = () => [commit('headoid')];
      const el = shellOnRepo();
      document.body.appendChild(el);
      try {
        await (el as any).updateComplete;
        if ((el as any).rightPanelVisible) {
          const { uiStore: ui } = await import('../stores/index.ts');
          ui.getState().togglePanel('right');
          await (el as any).updateComplete;
        }
        expect((el as any).rightPanelVisible, 'panel starts hidden').to.equal(false);

        (el as any).contextMenu = { visible: true, x: 0, y: 0, commit: commit('headoid') };

        // The ordering is the whole fix: the panel that owns the listener has
        // to be visible BEFORE the event fires, or amend mode is turned on in
        // a component that is unmounted (or in a hidden tab).
        let visibleWhenDispatched: boolean | null = null;
        const onAmend = (): void => {
          visibleWhenDispatched = (el as any).rightPanelVisible;
        };
        window.addEventListener('trigger-amend', onAmend);
        try {
          await (el as any).handleQuickAmend();
        } finally {
          window.removeEventListener('trigger-amend', onAmend);
        }

        expect(visibleWhenDispatched, 'the event fired').to.not.be.null;
        expect(visibleWhenDispatched, 'and the panel was already up').to.equal(true);
        expect((el as any).rightPanelVisible, 'panel revealed').to.equal(true);
      } finally {
        el.remove();
      }
    });

    it('a repository switch during the history lookup cancels the amend', async () => {
      let release!: (v: unknown) => void;
      mockResponses['get_commit_history'] = () =>
        new Promise((r) => {
          release = r;
        });
      const el = shellOnRepo();
      (el as any).contextMenu = { visible: true, x: 0, y: 0, commit: commit('headoid') };

      let amended = false;
      const handler = (): void => {
        amended = true;
      };
      window.addEventListener('trigger-amend', handler);
      try {
        const running = (el as any).handleQuickAmend();
        (el as any).activeRepository = { repository: mockRepo('/repo/two', 'two') };
        release([commit('headoid')]);
        await running;
      } finally {
        window.removeEventListener('trigger-amend', handler);
      }

      expect(amended, 'the commit panel binds to the live repo').to.equal(false);
    });
  });

  describe('the Abort banner double-click guard', () => {
    it('a double-click raises one confirm and runs one abort', async () => {
      // The flag used to be claimed after the confirm, and there is an IPC
      // round trip between the click and the native dialog taking focus — so a
      // second click landed while it was still false.
      let confirms = 0;
      mockResponses['plugin:dialog|message'] = () => {
        confirms++;
        return 'Ok';
      };
      const el = shellOnRepo('merge');

      await Promise.all([
        (el as any).handleAbortOperation(),
        (el as any).handleAbortOperation(),
      ]);

      expect(confirms, 'one prompt, not two').to.equal(1);
      expect(
        invokeCallArgs.filter((c) => c.command === 'abort_merge').length,
        'the second abort would run against an already-restored tree',
      ).to.equal(1);
    });

    it('declining releases the guard so Abort still works afterwards', async () => {
      mockResponses['plugin:dialog|message'] = () => 'Cancel';
      const el = shellOnRepo('merge');

      await (el as any).handleAbortOperation();
      expect(invokeCallArgs.some((c) => c.command === 'abort_merge')).to.equal(false);

      mockResponses['plugin:dialog|message'] = () => 'Ok';
      await (el as any).handleAbortOperation();

      expect(
        invokeCallArgs.filter((c) => c.command === 'abort_merge').length,
        'a declined abort must not wedge the button',
      ).to.equal(1);
    });

    it('an unabortable state is rejected without claiming the guard', async () => {
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const el = shellOnRepo('clean');

      await (el as any).handleAbortOperation();

      expect((el as any).abortInProgress, 'the flag is not left set').to.equal(false);
      expect(invokeCallArgs.some((c) => c.command.startsWith('abort_'))).to.equal(false);
    });
  });

  describe('closing the diff pane with unsaved editor text', () => {
    function shellWithDirtyEditor(path: string): AppShell {
      const el = shellOnRepo();
      // `diffView` is a @query getter, so it has to be shadowed on the
      // instance. This stands in for a mounted lv-diff-view whose inline
      // editor holds typed text.
      Object.defineProperty(el, 'diffView', {
        configurable: true,
        get: () => ({ hasUnsavedEdits: true, editingPath: path }),
      });
      dialogs.open('diff');
      return el;
    }

    it('the × button says the edits were discarded rather than dropping them silently', async () => {
      // The editor guards every teardown it can see — Cancel confirms, a file
      // change warns — but ×, Escape and a tab switch are owned by app-shell
      // and just set showDiff = false, unmounting the editor with the text in
      // it. Escape is the sharpest case: the editor says "Esc to cancel" while
      // the header says "Close diff (Esc)".
      const el = shellWithDirtyEditor('src/main.ts');
      uiStore.setState({ toasts: [] });

      (el as any).handleCloseDiff();

      const warning = uiStore.getState().toasts.find((t) => t.type === 'warning');
      expect(warning, 'the loss is reported').to.not.be.undefined;
      expect(warning!.message).to.contain('src/main.ts');
      expect(dialogs.isOpen('diff'), 'and the pane still closes').to.equal(false);
    });

    it('a clean editor closes quietly', async () => {
      const el = shellOnRepo();
      Object.defineProperty(el, 'diffView', {
        configurable: true,
        get: () => ({ hasUnsavedEdits: false, editingPath: null }),
      });
      dialogs.open('diff');
      uiStore.setState({ toasts: [] });

      (el as any).handleCloseDiff();

      expect(uiStore.getState().toasts.length, 'nothing was lost, so nothing is said').to.equal(0);
    });

    it('opening Blame from the commit panel warns the same way', async () => {
      // A fourth app-shell-owned gesture that unmounts the same pane. The ×
      // and the tab switch were guarded; this one swaps lv-diff-view for
      // lv-blame-view through the same `showDiff = false`.
      const el = shellWithDirtyEditor('src/main.ts');
      uiStore.setState({ toasts: [] });

      (el as any).handleShowBlame(
        new CustomEvent('show-blame', { detail: { filePath: 'src/other.ts' } }),
      );

      const warning = uiStore.getState().toasts.find((t) => t.type === 'warning');
      expect(warning, 'the loss is reported').to.not.be.undefined;
      expect(warning!.message).to.contain('src/main.ts');
      expect(dialogs.isOpen('blame'), 'and blame still opens').to.equal(true);
    });

    it('opening file history from the commit panel warns the same way', async () => {
      // Same swap as Blame: the History button in the commit panel replaces
      // lv-diff-view in the center pane, so it drops the typed text with it.
      const el = shellWithDirtyEditor('src/main.ts');
      uiStore.setState({ toasts: [] });

      (el as any).handleShowFileHistory(
        new CustomEvent('show-file-history', { detail: { filePath: 'src/other.ts' } }),
      );

      const warning = uiStore.getState().toasts.find((t) => t.type === 'warning');
      expect(warning, 'the loss is reported').to.not.be.undefined;
      expect(warning!.message).to.contain('src/main.ts');
      expect(dialogs.isOpen('fileHistory'), 'and the history pane still opens').to.equal(true);
    });

    it('closing with no diff open says nothing', async () => {
      const el = shellOnRepo();
      uiStore.setState({ toasts: [] });

      (el as any).handleCloseDiff();

      expect(uiStore.getState().toasts.length).to.equal(0);
    });
  });

  describe('reword and amend refuse a merge commit', () => {
    // get_rebase_commits skips merge commits (a `pick` of one dies
    // mid-rebase), so the plan loaded for `<merge>^` contains every commit in
    // `<merge>^..HEAD` EXCEPT the one the user asked to reword — including the
    // merged-in side branch — with Start Rebase enabled. One click would
    // linearize that range onto the merge's first parent, destroying the merge
    // and rewriting the side branch, from a gesture that promised only to
    // change a message.
    for (const handler of ['handleRewordCommit', 'handleQuickAmend']) {
      it(`${handler} never opens the rebase dialog for a merge commit`, async () => {
        mockResponses['get_commit_history'] = () => [commit('headoid')];
        mockResponses['is_ancestor_of_head'] = () => true;
        const el = shellOnRepo();
        const merge = { ...commit('mergeoid'), parentIds: ['p1', 'p2'], shortId: 'mergeoi' };
        (el as any).contextMenu = { visible: true, x: 0, y: 0, commit: merge };

        let opened = false;
        Object.defineProperty(el, 'interactiveRebaseDialog', {
          configurable: true,
          get: () => ({ open: () => { opened = true; } }),
        });
        uiStore.setState({ toasts: [] });

        await (el as any)[handler]();

        expect(opened, 'an armed rebase plan that omits the target').to.equal(false);
        expect(
          uiStore.getState().toasts.some((t) => t.message.includes('merge commit')),
          'the refusal must say why',
        ).to.equal(true);
      });
    }

    it('still opens the rebase dialog for an ordinary commit', async () => {
      mockResponses['get_commit_history'] = () => [commit('headoid')];
      mockResponses['is_ancestor_of_head'] = () => true;
      const el = shellOnRepo();
      const ordinary = { ...commit('olderoid'), parentIds: ['p1'], shortId: 'olderoi' };
      (el as any).contextMenu = { visible: true, x: 0, y: 0, commit: ordinary };

      let opened = false;
      Object.defineProperty(el, 'interactiveRebaseDialog', {
        configurable: true,
        get: () => ({ open: () => { opened = true; } }),
      });

      await (el as any).handleRewordCommit();

      expect(opened).to.equal(true);
    });
  });

  describe('the auto-stash conflict identifies its stash by oid', () => {
    // checkout_with_autostash resolves its own entry by oid because a stash
    // pushed by another surface or a terminal renumbers the list. The result
    // struct dropped that oid, so every frontend caller passed stashIndex: 0
    // and the conflict dialog captured whatever sat at position 0 — then
    // dropped it on Complete, destroying a stash the checkout never created.
    it('carries stashOid from the checkout result into the dialog config', async () => {
      const el = shellOnRepo();
      (el as any).handleAutoStashToast(
        {
          success: true,
          stashed: true,
          stashApplied: false,
          stashConflict: true,
          stashOid: 'deadbeefcafe',
          message: 'conflicts',
        },
        'feature',
        '/repo/one',
      );

      expect((el as any).conflictDialogConfig?.stashOid).to.equal('deadbeefcafe');
    });

    it('leaves stashOid null when the backend reported none', async () => {
      const el = shellOnRepo();
      (el as any).handleAutoStashToast(
        {
          success: true,
          stashed: true,
          stashApplied: false,
          stashConflict: true,
          stashOid: null,
          message: 'conflicts',
        },
        'feature',
        '/repo/one',
      );

      expect((el as any).conflictDialogConfig?.stashOid).to.equal(null);
    });
  });

  describe('the operation banner Abort shares the working-tree lock', () => {
    // An abort is a full working-tree restore, and the banner is the only
    // always-visible non-modal destructive control — so a hard reset from the
    // graph could run beside it, and a sidebar discard could start during the
    // abort's confirm round trip.
    it('is inert while another surface holds the lock', async () => {
      mockResponses['plugin:dialog|confirm'] = () => 'Ok';
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const el = shellOnRepo('cherrypick');
      tryAcquireRefOp('/repo/one');
      invokeCallArgs.length = 0;

      await (el as any).handleAbortOperation();

      expect(
        invokeCallArgs.some((c) => /^abort_/.test(c.command)),
        'the abort must not run beside another working-tree operation',
      ).to.equal(false);
    });

    it('claims and releases the lock around its own work', async () => {
      mockResponses['plugin:dialog|confirm'] = () => 'Ok';
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const el = shellOnRepo('cherrypick');

      let heldDuringAbort = false;
      mockResponses['abort_cherry_pick'] = () => {
        heldDuringAbort = isRefOpRunning('/repo/one');
        return null;
      };

      await (el as any).handleAbortOperation();

      expect(heldDuringAbort, 'the sidebar would have seen a free lock').to.equal(true);
      expect(isRefOpRunning('/repo/one'), 'released afterwards').to.equal(false);
    });

    it('a declined confirm releases the lock', async () => {
      mockResponses['plugin:dialog|confirm'] = () => 'Cancel';
      mockResponses['plugin:dialog|message'] = () => 'Cancel';
      const el = shellOnRepo('cherrypick');

      await (el as any).handleAbortOperation();

      expect(isRefOpRunning('/repo/one'), 'a stuck lock would wedge the repo').to.equal(false);
    });
  });

  describe('the keyboard-only surfaces share the working-tree lock', () => {
    // Ctrl+Shift+S and the Force Delete toast action have no rendered control
    // in a list or menu, so the lock sweep never enumerated them — the same
    // stale-enumeration pattern the earlier rounds kept closing. `git stash
    // push` resets the working tree to HEAD and renumbers the stash list; a
    // force delete is the most commit-destructive local operation there is.
    it('create stash is inert while another surface holds the lock', async () => {
      const el = shellOnRepo();
      tryAcquireRefOp('/repo/one');
      invokeCallArgs.length = 0;

      await (el as any).handleCreateStash();

      expect(
        invokeCallArgs.some((c) => c.command === 'create_stash'),
        'a stash must not reset the tree beside another operation',
      ).to.equal(false);
      // Ctrl+Shift+S has no rendered control at all, so a silent refusal is
      // indistinguishable from "the stash was created".
      expect(
        uiStore.getState().toasts.some((t) => /already running/i.test(t.message)),
        'the refusal must be audible',
      ).to.equal(true);
    });

    // Without `-m` every stash falls back to git's "WIP on <branch>: <sha>
    // <subject>" — the commit it was based on, not the stashed work. The panel
    // button and this shortcut run the same operation and report the same
    // "Stash created", so both must be nameable.
    it('a stash started from the shortcut/palette can be named', async () => {
      setupMockPrompt('hotfix wip');
      const el = shellOnRepo();

      await (el as any).handleCreateStash();

      const calls = invokeCallArgs.filter((c) => c.command === 'create_stash');
      expect(calls.length, 'the stash must still be created').to.equal(1);
      expect(calls[0].args.message, 'the typed name must reach git').to.equal('hotfix wip');
    });

    it('cancelling the stash prompt creates no stash and frees the lock', async () => {
      setupMockPrompt(null);
      const el = shellOnRepo();

      await (el as any).handleCreateStash();

      expect(
        invokeCallArgs.some((c) => c.command === 'create_stash'),
        'a dismissed prompt must not reset the working tree',
      ).to.equal(false);
      expect(isRefOpRunning('/repo/one'), 'a stuck lock would wedge the repo').to.equal(false);
    });

    it('create stash holds and releases the lock', async () => {
      const el = shellOnRepo();
      let heldDuringStash = false;
      mockResponses['create_stash'] = () => {
        heldDuringStash = isRefOpRunning('/repo/one');
        return null;
      };

      await (el as any).handleCreateStash();

      expect(heldDuringStash, 'other surfaces would have seen a free lock').to.equal(true);
      expect(isRefOpRunning('/repo/one'), 'released afterwards').to.equal(false);
    });

    it('force delete from a suggestion toast is inert while the lock is held', async () => {
      mockResponses['plugin:dialog|confirm'] = () => 'Ok';
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const el = shellOnRepo();
      tryAcquireRefOp('/repo/one');
      invokeCallArgs.length = 0;

      (el as any).handleForceDeleteBranch(
        new CustomEvent('x', {
          detail: { branchName: 'feature', repoPath: '/repo/one' },
        }),
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(
        invokeCallArgs.some((c) => c.command === 'delete_branch'),
        'an irreversible delete must not run beside a ref rewrite',
      ).to.equal(false);
      // A toast action button has no ?disabled binding, and clicking it
      // destroys the toast — so a silent refusal takes the affordance away
      // with it and the user is left with no branch deleted and no message.
      expect(
        uiStore.getState().toasts.some((t) => /already running/i.test(t.message)),
        'the refusal must be audible',
      ).to.equal(true);
    });
  });

  describe('the graph branch label shares the lock and says so', () => {
    // The canvas draws its ref labels itself, so this control can render no
    // disabled state — a silent refusal is indistinguishable from a dead
    // click. It is also a SINGLE left-click, the easiest checkout in the app
    // to fire twice.
    it('is inert with a message while another surface holds the lock', async () => {
      const el = shellOnRepo();
      tryAcquireRefOp('/repo/one');
      invokeCallArgs.length = 0;
      uiStore.setState({ toasts: [] });

      await (el as any).handleCheckoutBranchFromGraph(
        new CustomEvent('checkout-branch', { detail: { branchName: 'feature' } }),
      );

      expect(
        invokeCallArgs.some((c) => c.command === 'checkout_with_autostash'),
        'two auto-stash checkouts cross-apply each other\u2019s stashes',
      ).to.equal(false);
      expect(
        uiStore.getState().toasts.some((t) => /already running/i.test(t.message)),
        'a dead click with no message is indistinguishable from a broken app',
      ).to.equal(true);
    });

    it('releases the lock so a later checkout works', async () => {
      const el = shellOnRepo();

      await (el as any).handleCheckoutBranchFromGraph(
        new CustomEvent('checkout-branch', { detail: { branchName: 'feature' } }),
      );

      expect(isRefOpRunning('/repo/one'), 'a stuck lock would wedge the repo').to.equal(false);
    });
  });

  describe('push is serialized', () => {
    // The shortcut has no e.repeat guard, so holding Ctrl+Shift+U fires it
    // many times a second. Its force-push sibling was hardened against exactly
    // this and shares the key, so Push and Force Push are mutually exclusive
    // on one repo too.
    it('a second push is refused while the first is in flight', async () => {
      const el = shellOnRepo();
      let started = 0;
      mockResponses['push'] = () => {
        started++;
        return new Promise(() => {});
      };

      void (el as any).handlePush();
      void (el as any).handlePush();
      await new Promise((r) => setTimeout(r, 20));

      expect(started, 'auto-repeat must not launch concurrent pushes').to.equal(1);
    });
  });

  describe('checking out the branch you are already on', () => {
    // A no-op that still parks the entire working tree in a stash and
    // re-applies it. The sidebar and the direct graph-label click both refuse
    // it; the ref menu and the palette were never folded into that guard.
    it('the ref menu refuses it and says why', async () => {
      const el = shellOnRepo();
      (el as any).refContextMenu = {
        visible: true, x: 0, y: 0, fullName: '',
        refType: 'localBranch', refName: 'main', isHead: true,
      };
      invokeCallArgs.length = 0;
      uiStore.setState({ toasts: [] });

      await (el as any).handleRefCheckout();

      expect(
        invokeCallArgs.some((c) => c.command === 'checkout_with_autostash'),
        'no stash round trip for a branch we are already on',
      ).to.equal(false);
      expect(
        uiStore.getState().toasts.some((t) => /already on this branch/i.test(t.message)),
      ).to.equal(true);
    });

    it('still checks out a different branch', async () => {
      mockResponses['plugin:dialog|confirm'] = () => 'Ok';
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const el = shellOnRepo();
      (el as any).refContextMenu = {
        visible: true, x: 0, y: 0, fullName: '',
        refType: 'localBranch', refName: 'feature', isHead: false,
      };
      invokeCallArgs.length = 0;

      await (el as any).handleRefCheckout();

      expect(
        invokeCallArgs.some((c) => c.command === 'checkout_with_autostash'),
      ).to.equal(true);
    });
  });

  describe('pull is serialized', () => {
    // Three surfaces reach handlePull — Ctrl+Shift+P, the palette and the
    // "Pull Now" toast action — and none guarded a second call. The backend's
    // ensure_pullable only refuses when a merge is ALREADY unresolved; two
    // pulls that both start clean both pass it, and the second calls
    // repo.merge() on top of the first, deleting MERGE_HEAD and leaving a
    // conflicted index abort_merge then refuses to clean up. Keyboard
    // auto-repeat alone fires this many times a second.
    it('a second pull is refused while the first is in flight', async () => {
      const el = shellOnRepo();
      let started = 0;
      mockResponses['pull'] = () => {
        started++;
        return new Promise(() => {
          /* never resolves — the first pull is still running */
        });
      };
      invokeCallArgs.length = 0;

      void (el as any).handlePull();
      void (el as any).handlePull();
      await new Promise((r) => setTimeout(r, 20));

      expect(started, 'the second pull must not reach the backend').to.equal(1);
      // Reached from a shortcut, the palette and a toast action — none of
      // which carries a ?disabled binding.
      expect(
        uiStore.getState().toasts.some((t) => /already running/i.test(t.message)),
        'the refusal must be audible',
      ).to.equal(true);
    });

    it('holds the shared working-tree lock, so the sidebar is disabled too', async () => {
      // Keying pull separately serialized pull against pull but left every
      // sidebar checkout, discard and reset enabled beside it — and a
      // fast-forward pull runs checkout_tree and moves the branch ref.
      const el = shellOnRepo();
      let heldDuringPull = false;
      mockResponses['pull'] = () => {
        // What lv-branch-list and lv-file-status read to gate their controls.
        heldDuringPull = isRefOpRunning('/repo/one');
        return null;
      };

      await (el as any).handlePull();

      expect(heldDuringPull, 'the sidebar would have seen a free lock').to.equal(true);
      expect(isRefOpRunning('/repo/one'), 'released afterwards').to.equal(false);
    });

    it('a later pull works once the first finished', async () => {
      const el = shellOnRepo();
      let started = 0;
      mockResponses['pull'] = () => {
        started++;
        return null;
      };

      await (el as any).handlePull();
      await (el as any).handlePull();

      expect(started, 'a stuck claim would block pulling for the session').to.equal(2);
    });
  });

  describe('the graph lock is shared with the sidebar lists', () => {
    // app-shell and lv-branch-list/lv-tag-list/lv-stash-list used to hold two
    // disjoint locks over the same commands, and <lv-left-panel> is rendered
    // with no props, so nothing passed a busy signal between them. A hard
    // reset from the graph and a double-clicked sidebar checkout ran
    // concurrently against the same working tree; the auto-stash checkout
    // saves, applies and drops by position, so the reset landed on the
    // just-applied tree with the stash entry already gone.
    it('a sidebar claim makes the graph menu inert', async () => {
      mockResponses['plugin:dialog|confirm'] = () => 'Ok';
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const el = shellOnRepo();
      (el as any).refContextMenu = {
        visible: true, x: 0, y: 0, fullName: '', refType: 'localBranch', refName: 'feature',
      };
      // What lv-branch-list.handleCheckout does when the user double-clicks a row.
      tryAcquireRefOp('/repo/one');
      invokeCallArgs.length = 0;

      await (el as any).handleRefDeleteBranch();

      expect(
        invokeCallArgs.some((c) => c.command === 'delete_branch'),
        'the graph must not run a second operation on the sidebar\u2019s working tree',
      ).to.equal(false);
    });

    it('a graph claim is visible to the sidebar', async () => {
      mockResponses['plugin:dialog|confirm'] = () => 'Ok';
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const el = shellOnRepo();
      (el as any).refContextMenu = {
        visible: true, x: 0, y: 0, fullName: '', refType: 'localBranch', refName: 'feature',
      };

      let heldDuringOperation = false;
      mockResponses['delete_branch'] = () => {
        // lv-branch-list reads exactly this to gate its own handlers.
        heldDuringOperation = isRefOpRunning('/repo/one');
        return null;
      };

      await (el as any).handleRefDeleteBranch();

      expect(heldDuringOperation, 'the sidebar would have seen a free lock').to.equal(true);
      expect(isRefOpRunning('/repo/one'), 'released afterwards').to.equal(false);
    });
  });

  describe('the graph ref menu serializes its own operations', () => {
    // The ref lock was introduced to stop Merge and Rebase racing each
    // other; delete-branch, delete-tag and push-tag were never folded in, so
    // any of them could run concurrently with a still-running merge or rebase
    // against the same working tree. There is no per-repo lock in the backend —
    // every command opens its own git2 handle — so this flag is the only thing
    // serializing them. The sidebar has always got this right.
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['delete branch', 'handleRefDeleteBranch', { refType: 'localBranch', refName: 'feature' }],
      ['delete tag', 'handleRefDeleteTag', { refType: 'tag', refName: 'v1.0.0' }],
      ['push tag', 'handleRefPushTag', { refType: 'tag', refName: 'v1.0.0' }],
      // Checkout mutates the same working tree and was left out when this flag
      // was extended to the deletes — so it stayed clickable during an
      // in-flight merge and ran concurrently against it.
      ['checkout', 'handleRefCheckout', { refType: 'localBranch', refName: 'feature' }],
    ];

    for (const [label, handler, menu] of cases) {
      it(`${label} is inert while another ref operation is running`, async () => {
        mockResponses['plugin:dialog|confirm'] = () => 'Ok';
        mockResponses['plugin:dialog|message'] = () => 'Ok';
        const el = shellOnRepo();
        (el as any).refContextMenu = { visible: true, x: 0, y: 0, fullName: '', ...menu };
        tryAcquireRefOp('/repo/one');
        invokeCallArgs.length = 0;

        await (el as any)[handler]();

        expect(
          invokeCallArgs.some((c) => /^(delete_branch|delete_tag|push_tag)$/.test(c.command)),
          'nothing reaches the backend',
        ).to.equal(false);
      });

      it(`${label} claims and releases the flag around its own work`, async () => {
        mockResponses['plugin:dialog|confirm'] = () => 'Ok';
        mockResponses['plugin:dialog|message'] = () => 'Ok';
        const el = shellOnRepo();
        (el as any).refContextMenu = { visible: true, x: 0, y: 0, fullName: '', ...menu };

        await (el as any)[handler]();

        expect(
          isRefOpRunning('/repo/one'),
          'released, or the menu wedges for the rest of the session',
        ).to.equal(false);
      });
    }

    it('an operation in one repo does not lock another open repo', async () => {
      // The lock used to be a single boolean, so a rebase running in one repo
      // tab greyed out every mutating control in EVERY other open repo — with
      // no banner to explain why, because those repos are clean. Separate
      // repos have separate working trees and nothing to serialize against.
      mockResponses['plugin:dialog|confirm'] = () => 'Ok';
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const el = shellOnRepo();
      tryAcquireRefOp('/repo/two');
      (el as any).refContextMenu = {
        visible: true, x: 0, y: 0, fullName: '', refType: 'localBranch', refName: 'feature',
      };
      invokeCallArgs.length = 0;

      await (el as any).handleRefDeleteBranch();

      expect(
        invokeCallArgs.some((c) => c.command === 'delete_branch'),
        'an in-flight operation in the other repo must not block this one',
      ).to.equal(true);
      expect((el as any).isRefOperationInFlight(), 'the menu is usable').to.equal(false);
    });

    it('a declined confirm releases the flag', async () => {
      mockResponses['plugin:dialog|confirm'] = () => 'Cancel';
      mockResponses['plugin:dialog|message'] = () => 'Cancel';
      const el = shellOnRepo();
      (el as any).refContextMenu = {
        visible: true, x: 0, y: 0, fullName: '', refType: 'localBranch', refName: 'feature',
      };

      await (el as any).handleRefDeleteBranch();

      expect(isRefOpRunning('/repo/one')).to.equal(false);
      expect(invokeCallArgs.some((c) => c.command === 'delete_branch')).to.equal(false);
    });
  });

  describe('the toast-driven destructive actions claim before their confirm', () => {
    // These three live only on an error-suggestion toast's action button, so
    // they never got the claim-before-confirm guard every dialog-hosted
    // destructive button has. The toast container now guards the double-click
    // itself, but a second dispatch from any source must still be inert.
    function shellWithStoreRepo(): AppShell {
      const el = shellOnRepo();
      repositoryStore.setState({
        openRepositories: [{ repository: mockRepo('/repo/one', 'one') }],
        activeIndex: 0,
      } as any);
      return el;
    }

    it('a second force-push event during the confirm is inert', async () => {
      let confirms = 0;
      mockResponses['plugin:dialog|message'] = () => {
        confirms++;
        return 'Cancel';
      };
      mockResponses['plugin:dialog|confirm'] = () => 'Cancel';
      const el = shellWithStoreRepo();
      document.body.appendChild(el);
      try {
        await (el as any).updateComplete;
        const evt = (): CustomEvent =>
          new CustomEvent('force-push', { detail: { repoPath: '/repo/one' } });
        window.dispatchEvent(evt());
        window.dispatchEvent(evt());
        await new Promise((r) => setTimeout(r, 50));

        expect(confirms, 'one prompt, not two').to.equal(1);
      } finally {
        el.remove();
      }
    });

    it('a second force-delete event during the confirm is inert', async () => {
      let confirms = 0;
      mockResponses['plugin:dialog|message'] = () => {
        confirms++;
        return 'Cancel';
      };
      mockResponses['plugin:dialog|confirm'] = () => 'Cancel';
      const el = shellWithStoreRepo();
      document.body.appendChild(el);
      try {
        await (el as any).updateComplete;
        const evt = (): CustomEvent =>
          new CustomEvent('force-delete-branch', {
            detail: { branchName: 'feature', repoPath: '/repo/one' },
          });
        window.dispatchEvent(evt());
        window.dispatchEvent(evt());
        await new Promise((r) => setTimeout(r, 50));

        expect(confirms).to.equal(1);
      } finally {
        el.remove();
      }
    });

    it('the claim is released, so the action can be retried', async () => {
      let confirms = 0;
      mockResponses['plugin:dialog|message'] = () => {
        confirms++;
        return 'Cancel';
      };
      mockResponses['plugin:dialog|confirm'] = () => 'Cancel';
      const el = shellWithStoreRepo();
      document.body.appendChild(el);
      try {
        await (el as any).updateComplete;
        window.dispatchEvent(
          new CustomEvent('force-push', { detail: { repoPath: '/repo/one' } }),
        );
        await new Promise((r) => setTimeout(r, 50));
        window.dispatchEvent(
          new CustomEvent('force-push', { detail: { repoPath: '/repo/one' } }),
        );
        await new Promise((r) => setTimeout(r, 50));

        expect(confirms, 'declining must not wedge the action forever').to.equal(2);
      } finally {
        el.remove();
      }
    });
  });

  describe('checkout from a graph branch label', () => {
    it('a double-click issues one checkout', async () => {
      // A SINGLE left-click on the label reaches this, so it is the easiest
      // checkout in the app to fire twice. checkout_with_autostash stashes,
      // applies index 0 and drops index 0 — and a stash index is a position, so
      // two runs cross-apply and cross-drop each other's work.
      let resolveCheckout: ((v: unknown) => void) | undefined;
      mockResponses['checkout_with_autostash'] = () =>
        new Promise((r) => {
          resolveCheckout = r;
        });
      const el = shellOnRepo();
      const evt = (): CustomEvent =>
        new CustomEvent('checkout-branch', { detail: { branchName: 'feature' } });

      const first = (el as any).handleCheckoutBranchFromGraph(evt());
      const second = (el as any).handleCheckoutBranchFromGraph(evt());
      await new Promise((r) => setTimeout(r, 10));
      (resolveCheckout as ((v: unknown) => void) | undefined)?.({
        success: true,
        stashed: false,
      });
      await Promise.all([first, second]);

      expect(
        invokeCallArgs.filter((c) => c.command === 'checkout_with_autostash').length,
        'the second click is swallowed',
      ).to.equal(1);
    });

    it('the flag is released so a later checkout still works', async () => {
      mockResponses['checkout_with_autostash'] = () => ({ success: true, stashed: false });
      const el = shellOnRepo();
      const evt = (): CustomEvent =>
        new CustomEvent('checkout-branch', { detail: { branchName: 'feature' } });

      await (el as any).handleCheckoutBranchFromGraph(evt());
      invokeCallArgs.length = 0;
      await (el as any).handleCheckoutBranchFromGraph(evt());

      expect(
        invokeCallArgs.filter((c) => c.command === 'checkout_with_autostash').length,
      ).to.equal(1);
    });
  });

  describe('reword and amend refuse a commit that is not on this branch', () => {
    function offBranchShell(): AppShell {
      const el = shellOnRepo();
      mockResponses['get_commit_history'] = () => [commit('headoid')];
      // The target lives only on another branch.
      mockResponses['is_ancestor_of_head'] = () => false;
      (el as any).contextMenu = { visible: true, x: 0, y: 0, commit: commit('elsewhere') };
      return el;
    }

    it('reword does not open a plan that would rebase onto an unrelated commit', async () => {
      const el = offBranchShell();
      let opened = false;
      Object.defineProperty(el, 'interactiveRebaseDialog', {
        configurable: true,
        get: () => ({ open: () => { opened = true; } }),
      });
      uiStore.setState({ toasts: [] });

      await (el as any).handleRewordCommit();

      expect(opened, 'the dialog never opens').to.equal(false);
      const warning = uiStore.getState().toasts.find((t) => t.type === 'warning');
      expect(warning, 'and the user is told why').to.not.be.undefined;
      expect(warning!.message).to.contain('not on the current branch');
    });

    it('amend refuses before promising to open the rebase dialog', async () => {
      const el = offBranchShell();
      let opened = false;
      Object.defineProperty(el, 'interactiveRebaseDialog', {
        configurable: true,
        get: () => ({ open: () => { opened = true; } }),
      });
      uiStore.setState({ toasts: [] });

      await (el as any).handleQuickAmend();

      expect(opened).to.equal(false);
      const messages = uiStore.getState().toasts.map((t) => t.message).join(' | ');
      expect(
        messages,
        'no "opening interactive rebase" promise the app then breaks',
      ).to.not.contain('opening interactive rebase');
    });

    it('a commit on the current branch still opens the plan', async () => {
      const el = shellOnRepo();
      mockResponses['get_commit_history'] = () => [commit('headoid')];
      mockResponses['is_ancestor_of_head'] = () => true;
      (el as any).contextMenu = { visible: true, x: 0, y: 0, commit: commit('olderoid') };
      let openedOnto: string | null = null;
      Object.defineProperty(el, 'interactiveRebaseDialog', {
        configurable: true,
        get: () => ({ open: (onto: string) => { openedOnto = onto; } }),
      });

      await (el as any).handleRewordCommit();

      expect(openedOnto).to.equal('olderoid^');
    });
  });

  describe('the commit context menu shares the graph working-tree lock', () => {
    // These live in the same canvas as the ref menu and touch the same working
    // tree, but were never added when the flag was extended by hand — the same
    // stale-enumeration pattern that produced the earlier holes.
    const handlers: Array<[string, () => unknown[]]> = [
      ['revert', () => []],
      ['fixup', () => []],
      ['squash', () => []],
      ['reset (hard)', () => ['hard']],
    ];
    const methods: Record<string, string> = {
      revert: 'handleRevertCommit',
      fixup: 'handleFixupCommit',
      squash: 'handleSquashCommit',
      'reset (hard)': 'handleResetToCommit',
    };

    for (const [label, args] of handlers) {
      it(`${label} is inert while another graph operation is running`, async () => {
        mockResponses['plugin:dialog|confirm'] = () => 'Ok';
        mockResponses['plugin:dialog|message'] = () => 'Ok';
        const el = shellOnRepo();
        (el as any).contextMenu = {
          visible: true, x: 0, y: 0,
          commit: { ...commit('olderoid'), parentIds: ['parentoid'] },
        };
        tryAcquireRefOp('/repo/one');
        invokeCallArgs.length = 0;

        await (el as any)[methods[label]](...args());

        expect(
          invokeCallArgs.some((c) =>
            /^(reset|revert|create_commit|get_status)$/.test(c.command),
          ),
          'nothing reaches the backend',
        ).to.equal(false);
      });

      it(`${label} releases the lock when it finishes`, async () => {
        mockResponses['plugin:dialog|confirm'] = () => 'Cancel';
        mockResponses['plugin:dialog|message'] = () => 'Cancel';
        const el = shellOnRepo();
        (el as any).contextMenu = {
          visible: true, x: 0, y: 0,
          commit: { ...commit('olderoid'), parentIds: ['parentoid'] },
        };

        await (el as any)[methods[label]](...args());

        expect(
          isRefOpRunning('/repo/one'),
          'or the whole graph menu wedges for the session',
        ).to.equal(false);
      });
    }

    it('no mutating item in the commit menu is left enabled while locked', async () => {
      // Structural, so a handler added later cannot quietly miss the flag: with
      // the lock held, the ONLY enabled items may be the read-only ones. A new
      // mutating button that forgets the binding fails here without anyone
      // having to remember to add it to a list.
      // Describe only reads: it runs `git describe` and shows the answer.
      // "create patch" only opens the export/import dialog on its Patch tab.
      // Writing .patch files touches a folder the user picks, never the
      // working tree or a ref; the dialog's own Apply — which does — takes
      // this same lock and is bound to it.
      const READ_ONLY = ['create tag', 'create branch', 'describe this commit', 'create patch'];
      const el = shellOnRepo();
      document.body.appendChild(el);
      try {
        (el as any).contextMenu = { visible: true, x: 0, y: 0, commit: commit('olderoid') };
        tryAcquireRefOp('/repo/one');
        await (el as any).updateComplete;

        const items = Array.from(
          (el as any).renderRoot.querySelectorAll('.context-menu-item'),
        ) as HTMLButtonElement[];
        expect(items.length, 'the menu rendered').to.be.greaterThan(0);

        const enabled = items
          .filter((b) => !b.disabled)
          .map((b) => (b.textContent ?? '').trim().toLowerCase())
          .filter((t) => t.length > 0);

        for (const label of enabled) {
          expect(
            READ_ONLY.some((allowed) => label.includes(allowed)),
            `"${label}" mutates the repo but stays clickable while the lock is held`,
          ).to.equal(true);
        }
      } finally {
        el.remove();
      }
    });
  });

  describe('the command palette checkout shares the graph lock', () => {
    it('is inert while another graph operation is running', async () => {
      // The third checkout surface — round 33 folded the ref menu's and the
      // graph label's into this lock and left the palette's out.
      const el = shellOnRepo();
      tryAcquireRefOp('/repo/one');
      invokeCallArgs.length = 0;

      await (el as any).handleCheckoutBranch(
        new CustomEvent('checkout-branch', {
          detail: { branch: 'feature', repositoryPath: '/repo/one' },
        }),
      );

      expect(
        invokeCallArgs.some((c) => c.command === 'checkout_with_autostash'),
        'two auto-stash checkouts cross-apply each other stashes',
      ).to.equal(false);
    });

    it('releases the lock so a later checkout works', async () => {
      mockResponses['checkout_with_autostash'] = () => ({ success: true, stashed: false });
      const el = shellOnRepo();

      await (el as any).handleCheckoutBranch(
        new CustomEvent('checkout-branch', {
          detail: { branch: 'feature', repositoryPath: '/repo/one' },
        }),
      );

      expect(isRefOpRunning('/repo/one')).to.equal(false);
      expect(invokeCallArgs.some((c) => c.command === 'checkout_with_autostash')).to.equal(true);
    });
  });

  // The banner's Skip confirms only when there IS resolution work to lose. That
  // decision has to be made about the repository the skip will run against —
  // handleSkipOperation resolves `state` and `path` from the pinned repo, but
  // the confirm was reading the ACTIVE tab's conflicted files, so with a pinned
  // path the two disagree in both directions.
  describe('the banner Skip confirm follows the repo it is skipping', () => {
    function conflicted(path: string): StatusEntry {
      return { path, status: 'conflicted', isStaged: false, isConflicted: true };
    }

    function twoRepos(
      oneStatus: StatusEntry[],
      twoStatus: StatusEntry[]
    ): AppShell {
      const one = {
        ...emptyRepoData(mockRepo('/repo/one', 'one', 'cherrypick')),
        status: oneStatus,
      };
      const two = {
        ...emptyRepoData(mockRepo('/repo/two', 'two', 'cherrypick')),
        status: twoStatus,
      };
      repositoryStore.setState({ openRepositories: [one, two], activeIndex: 0 });
      const el = document.createElement('lv-app-shell') as AppShell;
      (el as any).activeRepository = one;
      return el;
    }

    it('confirms when the PINNED repo has conflicts, even though the active tab has none', async () => {
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const el = twoRepos([], [conflicted('CONFLICT.md')]);

      await (el as any).handleSkipOperation('/repo/two');

      expect(
        invokeCallArgs.some((c) => c.command === 'plugin:dialog|message'),
        'the resolutions in /repo/two would have been discarded on one click',
      ).to.equal(true);
      const skips = invokeCallArgs.filter((c) => c.command === 'skip_cherry_pick');
      expect(skips.length).to.equal(1);
      expect(skips[0].args).to.deep.equal({ path: '/repo/two' });
    });

    it('does not confirm when only the ACTIVE tab has conflicts', async () => {
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const el = twoRepos([conflicted('CONFLICT.md')], []);

      await (el as any).handleSkipOperation('/repo/two');

      expect(
        invokeCallArgs.some((c) => c.command === 'plugin:dialog|message'),
        'an empty stop must not be gated behind another repo\u2019s conflicts',
      ).to.equal(false);
      expect(invokeCallArgs.filter((c) => c.command === 'skip_cherry_pick').length).to.equal(1);
    });

    it('spells the state the way the rest of the UI does', async () => {
      mockResponses['plugin:dialog|message'] = () => 'Ok';
      const el = twoRepos([], [conflicted('CONFLICT.md')]);

      await (el as any).handleSkipOperation('/repo/two');

      const confirm = invokeCallArgs.find((c) => c.command === 'plugin:dialog|message');
      expect(
        JSON.stringify(confirm?.args),
        'the banner beside this says "Cherry-pick in progress"',
      ).to.contain('cherry-pick');
      expect(JSON.stringify(confirm?.args)).to.not.contain('cherrypick');
      const toast = uiStore.getState().toasts.find((t) => t.type === 'success');
      expect(toast?.message).to.equal('Skipped cherry-pick');
    });
  });
});
