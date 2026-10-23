/**
 * Tests for operationInProgress guards in gn-branch-list.
 *
 * Verifies that async handlers (checkout, rename, delete, merge, rebase)
 * are protected against double-click / re-entry while an operation is
 * already in progress.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invokeCalls: Array<{ command: string; args?: unknown }> = [];

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import type { GnBranchList } from '../gn-branch-list.ts';
import { repositoryStore, uiStore } from '../../../stores/index.ts';
import type { Repository } from '../../../types/git.types.ts';

// Import the actual component
import '../gn-branch-list.ts';
import { tryAcquireRefOp, resetRefOpLocks } from '../../../utils/ref-lock.ts';

function mockRepo(path: string, name: string): Repository {
  return {
    path,
    name,
    isValid: true,
    isBare: false,
    headRef: 'main',
    detachedHeadOid: null,
    state: 'clean',
    isShallow: false,
    isPartialClone: false,
    cloneFilter: null,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

function makeBranch(overrides: Partial<{
  name: string;
  shorthand: string;
  isHead: boolean;
  isRemote: boolean;
  upstream: string | null;
  targetOid: string;
  isStale: boolean;
}> = {}) {
  return {
    name: overrides.name ?? 'feature/test',
    shorthand: overrides.shorthand ?? 'feature/test',
    isHead: overrides.isHead ?? false,
    isRemote: overrides.isRemote ?? false,
    upstream: overrides.upstream ?? null,
    targetOid: overrides.targetOid ?? 'abc123',
    isStale: overrides.isStale ?? false,
  };
}

/** Returns a promise that never resolves (blocks the handler). */
function neverResolve(): Promise<never> {
  return new Promise(() => {});
}

/** plugin-dialog's confirm() treats the OK button label as "confirmed". */
let confirmResult = true;

function defaultMockInvoke(command: string): Promise<unknown> {
  if (command === 'plugin:dialog|confirm' || command === 'plugin:dialog|message') {
    return Promise.resolve(confirmResult ? 'Ok' : 'Cancel');
  }
  if (command === 'get_branches') {
    return Promise.resolve([]);
  }
  if (command === 'get_remotes') {
    return Promise.resolve([]);
  }
  if (command === 'get_hidden_branches') {
    return Promise.resolve([]);
  }
  if (command === 'get_branch_sort_mode') {
    return Promise.resolve('name');
  }
  return Promise.resolve(null);
}

async function createComponent(): Promise<GnBranchList> {
  mockInvoke = defaultMockInvoke;
  const el = await fixture<GnBranchList>(
    html`<gn-branch-list .repositoryPath=${REPO_PATH}></gn-branch-list>`
  );
  await el.updateComplete;
  return el;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-branch-list operationInProgress guards', () => {
  beforeEach(() => {
    resetRefOpLocks();
    invokeCalls.length = 0;
  });

  it('should have operationInProgress initially false', async () => {
    const el = await createComponent();
    // Access private via cast
    expect((el as unknown as { operationInProgress: boolean }).operationInProgress).to.equal(false);
  });

  it('preserves the branch-cleanup dialog ELEMENT across a loading toggle', async () => {
    // A background refresh flips loading true→false. With a single stable
    // outer template the dialog element instance must survive the toggle —
    // recreating it (as three distinct top-level templates did) would reset
    // its state and silently discard what the user had built there.
    const el = await createComponent();
    const internal = el as unknown as { loading: boolean };
    const dialogBefore = el.shadowRoot!.querySelector('gn-branch-cleanup-dialog');
    expect(dialogBefore, 'dialog present when loaded').to.not.be.null;

    internal.loading = true;
    await el.updateComplete;
    expect(
      el.shadowRoot!.querySelector('gn-branch-cleanup-dialog'),
      'same element instance while loading',
    ).to.equal(dialogBefore);

    internal.loading = false;
    await el.updateComplete;
    expect(
      el.shadowRoot!.querySelector('gn-branch-cleanup-dialog'),
      'same element instance after loading clears',
    ).to.equal(dialogBefore);
  });

  it('mounts no create-branch or interactive-rebase dialog of its own', async () => {
    // Two live copies of a dialog meant two independent `isOpen` guards, so
    // opening from the sidebar and then from the command palette stacked two
    // dialogs holding different pinned targets. app-shell owns the only
    // instance; this list asks it to open one.
    const el = await createComponent();
    expect(el.shadowRoot!.querySelector('gn-create-branch-dialog')).to.be.null;
    expect(el.shadowRoot!.querySelector('gn-interactive-rebase-dialog')).to.be.null;
  });

  it('asks the host to open the create-branch dialog instead of opening its own', async () => {
    const el = await createComponent();
    let fired = 0;
    el.addEventListener('create-branch', () => { fired++; });

    (el as unknown as { handleCreateBranch: () => void }).handleCreateBranch();

    expect(fired, 'create-branch dispatched to the host').to.equal(1);
    expect(
      invokeCalls.filter((c) => c.command === 'create_branch'),
      'nothing created directly',
    ).to.have.length(0);
  });

  it('asks the host to open interactive rebase, carrying the target branch', async () => {
    const el = await createComponent();
    let onto: string | undefined;
    el.addEventListener('interactive-rebase', (e) => {
      onto = (e as CustomEvent<{ onto?: string }>).detail?.onto;
    });

    (el as unknown as { contextMenu: unknown }).contextMenu = {
      visible: true,
      x: 0,
      y: 0,
      branch: makeBranch({ name: 'feature/x', shorthand: 'feature/x' }),
    };
    (el as unknown as { handleInteractiveRebase: () => void }).handleInteractiveRebase();

    expect(onto).to.equal('feature/x');
  });

  it('does not ask for interactive rebase while an operation is in flight', async () => {
    // The only context-menu item that was still live during an in-flight
    // operation while its five neighbours were greyed out.
    const el = await createComponent();
    tryAcquireRefOp(REPO_PATH);
    let fired = 0;
    el.addEventListener('interactive-rebase', () => { fired++; });

    (el as unknown as { contextMenu: unknown }).contextMenu = {
      visible: true,
      x: 0,
      y: 0,
      branch: makeBranch({ name: 'feature/x', shorthand: 'feature/x' }),
    };
    (el as unknown as { handleInteractiveRebase: () => void }).handleInteractiveRebase();

    expect(fired).to.equal(0);
  });

  it('drag-drop merge is inert while another operation is in flight', async () => {
    // Every context-menu handler took operationInProgress before starting;
    // drop did not, so a drag-merge could land on top of an in-flight merge or
    // checkout from the menu — two git operations mutating one worktree.
    const el = await createComponent();
    const internal = el as unknown as {
      operationInProgress: boolean;
      draggingBranch: unknown;
      handleDrop: (e: DragEvent, target: ReturnType<typeof makeBranch>) => Promise<void>;
    };

    internal.draggingBranch = makeBranch({ name: 'feature-b', shorthand: 'feature-b' });
    tryAcquireRefOp(REPO_PATH);
    invokeCalls.length = 0;

    await internal.handleDrop(
      new DragEvent('drop'),
      makeBranch({ name: 'main', shorthand: 'main', isHead: true }),
    );

    expect(invokeCalls.filter((c) => c.command === 'merge'), 'no concurrent merge').to.have.length(0);
    expect(
      invokeCalls.filter((c) => c.command === 'checkout_with_autostash'),
      'no concurrent checkout',
    ).to.have.length(0);
  });

  it('drag-drop takes and releases the operation lock around its own work', async () => {
    const el = await createComponent();
    const internal = el as unknown as {
      operationInProgress: boolean;
      draggingBranch: unknown;
      handleDrop: (e: DragEvent, target: ReturnType<typeof makeBranch>) => Promise<void>;
    };

    internal.draggingBranch = makeBranch({ name: 'feature-b', shorthand: 'feature-b' });
    // Decline the confirm: the drop returns early, and the lock must still be
    // released — a stuck lock would freeze every branch operation afterwards.
    confirmResult = false;
    try {
      await internal.handleDrop(
        new DragEvent('drop'),
        makeBranch({ name: 'main', shorthand: 'main', isHead: true }),
      );
    } finally {
      confirmResult = true;
    }

    expect(internal.operationInProgress, 'lock released').to.equal(false);
  });

  it('handleCheckout should skip when operationInProgress is true', async () => {
    const el = await createComponent();

    // Set operationInProgress = true to simulate an in-flight operation
    tryAcquireRefOp(REPO_PATH);

    // Reset call tracking
    invokeCalls.length = 0;

    const branch = makeBranch({ name: 'feature/blocked', isHead: false });

    // Call handleCheckout — it should bail early
    await (el as unknown as { handleCheckout: (b: typeof branch) => Promise<void> }).handleCheckout(branch);

    // No checkout_with_autostash call should have been made
    const checkoutCalls = invokeCalls.filter(c => c.command === 'checkout_with_autostash');
    expect(checkoutCalls).to.have.length(0);
  });

  it('handleCheckout should set operationInProgress during the operation', async () => {
    const el = await createComponent();

    let resolveCheckout!: (v: unknown) => void;
    mockInvoke = (command: string) => {
      if (command === 'checkout_with_autostash') {
        return new Promise((resolve) => { resolveCheckout = resolve; });
      }
      return defaultMockInvoke(command);
    };

    const branch = makeBranch({ name: 'feature/progress', isHead: false });

    // Start checkout (won't resolve yet)
    const promise = (el as unknown as { handleCheckout: (b: typeof branch) => Promise<void> }).handleCheckout(branch);

    // Should be in progress now
    expect((el as unknown as { operationInProgress: boolean }).operationInProgress).to.equal(true);

    // Resolve the checkout
    resolveCheckout({ success: true, data: { success: true, message: 'ok', stashed: false, stashApplied: false, stashConflict: false } });
    await promise;

    // Should be cleared after completion
    expect((el as unknown as { operationInProgress: boolean }).operationInProgress).to.equal(false);
  });

  it('handleRenameBranch should skip when operationInProgress is true', async () => {
    const el = await createComponent();

    // Set context menu with a branch
    const branch = makeBranch({ name: 'feature/rename-me', isHead: false, isRemote: false });
    (el as unknown as { contextMenu: { visible: boolean; x: number; y: number; branch: typeof branch | null } }).contextMenu = {
      visible: true, x: 0, y: 0, branch,
    };
    tryAcquireRefOp(REPO_PATH);

    invokeCalls.length = 0;

    await (el as unknown as { handleRenameBranch: () => Promise<void> }).handleRenameBranch();

    const renameCalls = invokeCalls.filter(c => c.command === 'rename_branch');
    expect(renameCalls).to.have.length(0);
  });

  it('handleDeleteBranch should skip when operationInProgress is true', async () => {
    const el = await createComponent();

    const branch = makeBranch({ name: 'feature/delete-me', isHead: false });
    (el as unknown as { contextMenu: { visible: boolean; x: number; y: number; branch: typeof branch | null } }).contextMenu = {
      visible: true, x: 0, y: 0, branch,
    };
    tryAcquireRefOp(REPO_PATH);

    invokeCalls.length = 0;

    await (el as unknown as { handleDeleteBranch: () => Promise<void> }).handleDeleteBranch();

    const deleteCalls = invokeCalls.filter(c => c.command === 'delete_branch');
    expect(deleteCalls).to.have.length(0);
  });

  it('handleMergeBranch should skip when operationInProgress is true', async () => {
    const el = await createComponent();

    const branch = makeBranch({ name: 'feature/merge-me', isHead: false });
    (el as unknown as { contextMenu: { visible: boolean; x: number; y: number; branch: typeof branch | null } }).contextMenu = {
      visible: true, x: 0, y: 0, branch,
    };
    tryAcquireRefOp(REPO_PATH);

    invokeCalls.length = 0;

    await (el as unknown as { handleMergeBranch: () => Promise<void> }).handleMergeBranch();

    const mergeCalls = invokeCalls.filter(c => c.command === 'merge');
    expect(mergeCalls).to.have.length(0);
  });

  it('handleRebaseBranch should skip when operationInProgress is true', async () => {
    const el = await createComponent();

    const branch = makeBranch({ name: 'feature/rebase-me', isHead: false });
    (el as unknown as { contextMenu: { visible: boolean; x: number; y: number; branch: typeof branch | null } }).contextMenu = {
      visible: true, x: 0, y: 0, branch,
    };
    tryAcquireRefOp(REPO_PATH);

    invokeCalls.length = 0;

    await (el as unknown as { handleRebaseBranch: () => Promise<void> }).handleRebaseBranch();

    const rebaseCalls = invokeCalls.filter(c => c.command === 'rebase');
    expect(rebaseCalls).to.have.length(0);
  });

  /**
   * Stub the REAL embedded dialog element in the shadow root — the sweep
   * discovers dialogs from the DOM, so a plain object hung off the @query field
   * would never be seen (and a test that stubbed one would pass no matter what
   * the sweep did).
   */
  async function stubCleanupDialog(
    el: GnBranchList,
    pinnedTo: string | null,
    operationInFlight = false
  ): Promise<{ closed: () => boolean }> {
    const dialog = el.shadowRoot!.querySelector('gn-branch-cleanup-dialog')!;
    expect(dialog, 'branch list embeds a real cleanup dialog').to.exist;
    let closed = false;
    Object.defineProperty(dialog, 'pinnedRepositoryPathIfOpen', {
      configurable: true,
      get: () => pinnedTo,
    });
    Object.defineProperty(dialog, 'operationInFlight', {
      configurable: true,
      get: () => operationInFlight,
    });
    (dialog as unknown as { close: () => void }).close = () => {
      closed = true;
    };
    // The subscription is registered after loadBranches() resolves.
    for (let i = 0; i < 50; i++) {
      if ((el as unknown as { storeUnsubscribe?: () => void }).storeUnsubscribe) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    return { closed: () => closed };
  }

  it('closes its embedded branch-cleanup dialog when the pinned repo tab is removed', async () => {
    // Branch cleanup force-deletes branches + prunes remotes on the pinned repo;
    // a closed tab must dismiss it, or Delete would mutate a repo not in the tab
    // bar. app-shell's guard can't reach this sidebar-embedded instance.
    repositoryStore.getState().reset();
    repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'));
    repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));

    const el = await createComponent();
    const spy = await stubCleanupDialog(el, '/repo/a');

    repositoryStore.getState().removeRepository('/repo/a');
    await el.updateComplete;

    expect(spy.closed(), 'branch-cleanup dialog closed when its pinned tab was removed').to.be.true;
    repositoryStore.getState().reset();
  });

  it('leaves the dialog open when a DIFFERENT repo tab is removed', async () => {
    // Only the pinned repo's removal cancels the cleanup; unrelated tab churn
    // must not disrupt an in-progress plan.
    repositoryStore.getState().reset();
    repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'));
    repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));

    const el = await createComponent();
    const spy = await stubCleanupDialog(el, '/repo/a');

    repositoryStore.getState().removeRepository('/repo/b');
    await el.updateComplete;

    expect(spy.closed(), 'dialog stays open when an unrelated tab is removed').to.be.false;

    repositoryStore.getState().reset();
  });

  it('does NOT close (or claim to cancel) a branch cleanup that is mid force-delete', async () => {
    // The force-delete + prune loop keeps running whatever the sweep does:
    // close() here is a bare `isOpen = false` that bypasses handleModalClose's
    // `deleting` guard. Reporting "branch cleanup cancelled" over a loop still
    // deleting branches is the exact lie this guard exists to stop.
    repositoryStore.getState().reset();
    repositoryStore.getState().addRepository(mockRepo('/repo/a', 'a'));
    repositoryStore.getState().addRepository(mockRepo('/repo/b', 'b'));

    const el = await createComponent();
    const spy = await stubCleanupDialog(el, '/repo/a', true);
    uiStore.setState({ toasts: [] });

    repositoryStore.getState().removeRepository('/repo/a');
    await el.updateComplete;

    expect(spy.closed(), 'an in-flight cleanup is not force-dismissed').to.be.false;
    const messages = uiStore.getState().toasts.map((t) => t.message);
    expect(
      messages.some((m) => /cleanup cancelled/i.test(m)),
      `no toast may claim a cancellation that did not happen: ${JSON.stringify(messages)}`
    ).to.be.false;
    expect(
      messages.some((m) => /still running/i.test(m)),
      `the truth is toasted instead: ${JSON.stringify(messages)}`
    ).to.be.true;

    repositoryStore.getState().reset();
  });

  it('branches-changed carries the originating repositoryPath so refreshes pin correctly', async () => {
    // The host pins its refresh to detail.repositoryPath (the repo the mutation
    // ran on), not the active tab. A branches-changed with no repositoryPath
    // would refresh whichever tab happens to be active after a mid-op switch.
    const el = await createComponent();

    let detail: { repositoryPath?: string } | null = null;
    el.addEventListener('branches-changed', (e) => {
      detail = (e as CustomEvent<{ repositoryPath?: string }>).detail;
    });

    (el as unknown as { dispatchBranchesChanged: (p: string) => void }).dispatchBranchesChanged(
      '/repo/origin'
    );

    expect(detail, 'branches-changed dispatched').to.not.be.null;
    expect(detail!.repositoryPath).to.equal('/repo/origin');
  });

  it('handleTrackRemoteBranch runs create AND set-upstream against the origin repo after a mid-op switch', async () => {
    // Both git ops must target the repo the operation was invoked on. The
    // second op (set-upstream) runs AFTER the create IPC await — a tab switch
    // during that await must not split the two operations across repos.
    const el = await createComponent();

    let resolveCreate!: (v: unknown) => void;
    mockInvoke = (command: string) => {
      if (command === 'create_branch') {
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      }
      return defaultMockInvoke(command);
    };

    const branch = makeBranch({ name: 'origin/feature/x', shorthand: 'feature/x', isRemote: true });
    (
      el as unknown as {
        contextMenu: { visible: boolean; x: number; y: number; branch: typeof branch | null };
      }
    ).contextMenu = { visible: true, x: 0, y: 0, branch };

    invokeCalls.length = 0;
    const promise = (
      el as unknown as { handleTrackRemoteBranch: () => Promise<void> }
    ).handleTrackRemoteBranch();

    // The create IPC is now in flight; user switches tabs.
    await new Promise((r) => setTimeout(r, 10));
    (el as unknown as { repositoryPath: string }).repositoryPath = '/other/repo';

    resolveCreate({ name: 'feature/x' });
    await promise;

    const createCall = invokeCalls.find((c) => c.command === 'create_branch');
    const upstreamCall = invokeCalls.find((c) => c.command === 'set_upstream_branch');
    expect(createCall, 'create_branch called').to.not.be.undefined;
    expect(upstreamCall, 'set_upstream_branch called').to.not.be.undefined;
    expect((createCall!.args as { path: string }).path).to.equal(REPO_PATH);
    expect((upstreamCall!.args as { path: string }).path).to.equal(REPO_PATH);
  });

  it('handleRenameBranch renames the origin repo, not the tab switched to during the prompt', async () => {
    // showPrompt is an in-app Lit overlay, not a native modal: the window stays
    // interactive, so the user can switch tabs while the rename prompt is open.
    // The rename must still run against the repo it was invoked on.
    const el = await createComponent();

    mockInvoke = (command: string) => defaultMockInvoke(command);

    const branch = makeBranch({ name: 'feature/old', shorthand: 'feature/old', isHead: false, isRemote: false });
    (
      el as unknown as {
        contextMenu: { visible: boolean; x: number; y: number; branch: typeof branch | null };
      }
    ).contextMenu = { visible: true, x: 0, y: 0, branch };

    invokeCalls.length = 0;
    const promise = (
      el as unknown as { handleRenameBranch: () => Promise<void> }
    ).handleRenameBranch();

    // Wait for the in-app prompt dialog to mount.
    let dialog: (Element & { value: string }) | null = null;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 10));
      dialog = document.querySelector('gn-prompt-dialog') as (Element & { value: string }) | null;
      if (dialog && (dialog as unknown as { resolve: unknown }).resolve) break;
    }
    expect(dialog, 'prompt dialog mounted').to.not.be.null;

    // User switches tabs while the prompt is open, then confirms a new name.
    (el as unknown as { repositoryPath: string }).repositoryPath = '/other/repo';
    (dialog as unknown as { value: string }).value = 'feature/new';
    await (dialog as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    const confirmBtn = dialog!.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement;
    confirmBtn.click();

    await promise;

    const renameCall = invokeCalls.find((c) => c.command === 'rename_branch');
    expect(renameCall, 'rename_branch called').to.not.be.undefined;
    expect((renameCall!.args as { path: string }).path).to.equal(REPO_PATH);
    expect((renameCall!.args as { newName: string }).newName).to.equal('feature/new');
  });

  it('handleMergeBranch merges the origin repo, not the tab switched to during the confirm', async () => {
    // showConfirm's await yields; a tab switch during it rebinds
    // this.repositoryPath. The merge must run on the repo it was invoked on.
    const el = await createComponent();

    let resolveConfirm!: (v: unknown) => void;
    mockInvoke = (command: string) => {
      if (command === 'plugin:dialog|message') {
        return new Promise((resolve) => {
          resolveConfirm = resolve;
        });
      }
      if (command === 'merge') return Promise.resolve({ success: true });
      return defaultMockInvoke(command);
    };

    const branch = makeBranch({ name: 'feature/m', shorthand: 'feature/m', isHead: false });
    (
      el as unknown as {
        contextMenu: { visible: boolean; x: number; y: number; branch: typeof branch | null };
      }
    ).contextMenu = { visible: true, x: 0, y: 0, branch };

    invokeCalls.length = 0;
    const promise = (
      el as unknown as { handleMergeBranch: () => Promise<void> }
    ).handleMergeBranch();

    await new Promise((r) => setTimeout(r, 10));
    (el as unknown as { repositoryPath: string }).repositoryPath = '/other/repo';

    resolveConfirm('Ok');
    await promise;

    const mergeCall = invokeCalls.find((c) => c.command === 'merge');
    expect(mergeCall, 'merge called').to.not.be.undefined;
    expect((mergeCall!.args as { path: string }).path).to.equal(REPO_PATH);
  });

  it('handleUnsetUpstream emits branches-changed pinned to the origin repo after a mid-op switch', async () => {
    // Regression: these context-menu handlers previously dispatched a bare
    // branches-changed with no repositoryPath, so a mid-op tab switch made the
    // host refresh the wrong (newly active) repo. repoPath is captured
    // pre-await; the event must still name the origin repo.
    const el = await createComponent();

    let resolveUnset!: (v: unknown) => void;
    mockInvoke = (command: string) => {
      if (command === 'unset_upstream_branch') {
        return new Promise((resolve) => {
          resolveUnset = resolve;
        });
      }
      return defaultMockInvoke(command);
    };

    let detail: { repositoryPath?: string } | null = null;
    el.addEventListener('branches-changed', (e) => {
      detail = (e as CustomEvent<{ repositoryPath?: string }>).detail;
    });

    const branch = makeBranch({ name: 'feature/up', isRemote: false, upstream: 'origin/feature/up' });
    (
      el as unknown as {
        contextMenu: { visible: boolean; x: number; y: number; branch: typeof branch | null };
      }
    ).contextMenu = { visible: true, x: 0, y: 0, branch };

    const promise = (
      el as unknown as { handleUnsetUpstream: () => Promise<void> }
    ).handleUnsetUpstream();

    // User switches tabs mid-operation.
    (el as unknown as { repositoryPath: string }).repositoryPath = '/other/repo';

    resolveUnset({ success: true });
    await promise;
    await el.updateComplete;

    expect(detail, 'branches-changed dispatched').to.not.be.null;
    expect(detail!.repositoryPath).to.equal(REPO_PATH);
  });

  it('handleCheckout should clear operationInProgress even on error', async () => {
    const el = await createComponent();

    mockInvoke = (command: string) => {
      if (command === 'checkout_with_autostash') {
        return Promise.reject(new Error('Network error'));
      }
      return defaultMockInvoke(command);
    };

    const branch = makeBranch({ name: 'feature/error', isHead: false });

    try {
      await (el as unknown as { handleCheckout: (b: typeof branch) => Promise<void> }).handleCheckout(branch);
    } catch {
      // expected
    }

    expect((el as unknown as { operationInProgress: boolean }).operationInProgress).to.equal(false);
  });
});

/**
 * Deleting a branch from the sidebar was the last delete surface reporting
 * nothing on success. The graph's ref menu toasts, the force escalation
 * toasts, and Branch Cleanup toasts; here the only signal was a row vanishing
 * from a list that is often filtered or scrolled away from the deleted row —
 * the same gap already fixed on the sibling tag list.
 */
describe('gn-branch-list delete feedback', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    confirmResult = true;
    uiStore.setState({ toasts: [] });
  });

  it('confirms the branch is gone', async () => {
    const el = await createComponent();
    const branch = makeBranch({ name: 'feature/gone', shorthand: 'feature/gone' });
    (el as unknown as { contextMenu: { visible: boolean; x: number; y: number; branch: typeof branch | null } }).contextMenu = {
      visible: true, x: 0, y: 0, branch,
    };
    uiStore.setState({ toasts: [] });

    await (el as unknown as { handleDeleteBranch: () => Promise<void> }).handleDeleteBranch();

    const success = uiStore.getState().toasts.find((t) => t.type === 'success');
    expect(success, 'the delete is acknowledged').to.not.be.undefined;
    expect(success!.message).to.equal('Deleted branch feature/gone');
  });

  it('says nothing on success when the delete failed', async () => {
    const el = await createComponent();
    mockInvoke = (command: string) => {
      if (command === 'delete_branch') {
        return Promise.reject({ code: 'COMMAND_ERROR', message: 'branch is checked out' });
      }
      return defaultMockInvoke(command);
    };
    const branch = makeBranch({ name: 'feature/busy', shorthand: 'feature/busy' });
    (el as unknown as { contextMenu: { visible: boolean; x: number; y: number; branch: typeof branch | null } }).contextMenu = {
      visible: true, x: 0, y: 0, branch,
    };
    uiStore.setState({ toasts: [] });

    await (el as unknown as { handleDeleteBranch: () => Promise<void> }).handleDeleteBranch();

    expect(uiStore.getState().toasts.some((t) => t.type === 'success')).to.equal(false);
    expect(uiStore.getState().toasts.some((t) => t.type === 'error')).to.equal(true);
  });
});
