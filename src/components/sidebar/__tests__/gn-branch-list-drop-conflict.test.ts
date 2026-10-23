/**
 * Tests for gn-branch-list drag-drop stash-conflict handling (Fix 4).
 *
 * When dropping a branch onto a non-HEAD branch, the component checks out the
 * target (auto-stashing uncommitted changes) before merging/rebasing. If that
 * auto-stash pop conflicts, the working tree is conflicted — the component must
 * open the conflict dialog and STOP, not fall through and run the merge/rebase
 * on a conflicted tree.
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
import '../gn-branch-list.ts';
import { uiStore } from '../../../stores/ui.store.ts';

// ── Helpers ────────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

function makeBranch(name: string, isHead = false) {
  return {
    name,
    shorthand: name,
    isHead,
    isRemote: false,
    upstream: null,
    targetOid: 'abc123',
    isStale: false,
  };
}

function defaultMockInvoke(command: string): Promise<unknown> {
  if (command === 'get_branches') return Promise.resolve([]);
  if (command === 'get_remotes') return Promise.resolve([]);
  if (command === 'get_hidden_branches') return Promise.resolve([]);
  if (command === 'get_branch_sort_mode') return Promise.resolve('name');
  if (command === 'plugin:dialog|message') return Promise.resolve('Ok');
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

interface ConflictDetail {
  operationType: string;
  stashIndex: number;
  dropStashOnComplete: boolean;
}

// A minimal DragEvent stand-in.
function fakeDragEvent(altKey = false): DragEvent {
  return { preventDefault() {}, altKey } as unknown as DragEvent;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-branch-list drop stash-conflict (Fix 4)', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
  });

  it('opens the conflict dialog and does NOT merge when the checkout auto-stash conflicts', async () => {
    const el = await createComponent();

    let detail: ConflictDetail | null = null;
    el.addEventListener('open-conflict-dialog', (e) => {
      detail = (e as CustomEvent<ConflictDetail>).detail;
    });

    const source = makeBranch('feature/source');
    const target = makeBranch('feature/target', /* isHead */ false);
    (el as unknown as { draggingBranch: unknown }).draggingBranch = source;

    mockInvoke = (command: string) => {
      if (command === 'checkout_with_autostash') {
        return Promise.resolve({
          success: true,
          stashed: true,
          stashApplied: false,
          stashConflict: true,
          message: 'stash conflict',
        });
      }
      return defaultMockInvoke(command);
    };

    await (el as unknown as { handleDrop: (e: DragEvent, b: unknown) => Promise<void> }).handleDrop(
      fakeDragEvent(false),
      target
    );

    // Conflict dialog opened with pop semantics.
    expect(detail, 'open-conflict-dialog dispatched').to.not.be.null;
    expect(detail!.operationType).to.equal('stash');
    expect(detail!.stashIndex).to.equal(0);
    expect(detail!.dropStashOnComplete).to.be.true;

    // Crucially: the merge must NOT have run on the conflicted tree.
    expect(invokeCalls.some((c) => c.command === 'merge'), 'merge NOT called').to.be.false;
    expect(invokeCalls.some((c) => c.command === 'rebase'), 'rebase NOT called').to.be.false;
  });

  it('warns that the merge was NOT started and should be re-run after resolving the stash conflict', async () => {
    const el = await createComponent();
    const state = uiStore.getState();
    state.toasts.forEach((t) => state.removeToast(t.id));

    const source = makeBranch('feature/source');
    const target = makeBranch('feature/target', false);
    (el as unknown as { draggingBranch: unknown }).draggingBranch = source;

    mockInvoke = (command: string) => {
      if (command === 'checkout_with_autostash') {
        return Promise.resolve({
          success: true,
          stashed: true,
          stashApplied: false,
          stashConflict: true,
          message: 'stash conflict',
        });
      }
      return defaultMockInvoke(command);
    };

    await (el as unknown as { handleDrop: (e: DragEvent, b: unknown) => Promise<void> }).handleDrop(
      fakeDragEvent(false),
      target
    );

    const warnToast = uiStore.getState().toasts.find((t) => t.type === 'warning');
    expect(warnToast, 'warning toast shown').to.not.be.undefined;
    // The message must make clear the merge was abandoned and needs re-running.
    expect(warnToast!.message).to.contain('NOT started');
    expect(warnToast!.message.toLowerCase()).to.contain('re-run');
  });

  it('still merges after a clean checkout (no auto-stash conflict)', async () => {
    const el = await createComponent();

    const source = makeBranch('feature/source');
    const target = makeBranch('feature/target', false);
    (el as unknown as { draggingBranch: unknown }).draggingBranch = source;

    mockInvoke = (command: string) => {
      if (command === 'checkout_with_autostash') {
        return Promise.resolve({
          success: true,
          stashed: false,
          stashApplied: false,
          stashConflict: false,
          message: 'ok',
        });
      }
      return defaultMockInvoke(command);
    };

    await (el as unknown as { handleDrop: (e: DragEvent, b: unknown) => Promise<void> }).handleDrop(
      fakeDragEvent(false),
      target
    );

    expect(invokeCalls.some((c) => c.command === 'merge'), 'merge ran on clean tree').to.be.true;
  });

  // The checkout ALREADY landed by the time the merge fails, so the list must
  // be reloaded even on the failure arm — otherwise every isHead flag is stale:
  // Delete branch stays offered on the branch that is now HEAD, and the old
  // HEAD's row runs a no-op checkout that parks the whole working tree in a
  // stash. Three of the four exits after that checkout refreshed; this was the
  // fourth.
  it('reloads the branch list when the merge fails after a successful checkout', async () => {
    const el = await createComponent();

    const source = makeBranch('feature/source');
    const target = makeBranch('feature/target', false);
    (el as unknown as { draggingBranch: unknown }).draggingBranch = source;

    mockInvoke = (command: string) => {
      if (command === 'checkout_with_autostash') {
        return Promise.resolve({
          success: true,
          stashed: false,
          stashApplied: false,
          stashConflict: false,
          message: 'ok',
        });
      }
      if (command === 'merge') {
        return Promise.reject({
          code: 'COMMAND_ERROR',
          message: 'refusing to merge unrelated histories',
        });
      }
      return defaultMockInvoke(command);
    };

    uiStore.setState({ toasts: [] });
    invokeCalls.length = 0;
    await (el as unknown as { handleDrop: (e: DragEvent, b: unknown) => Promise<void> }).handleDrop(
      fakeDragEvent(false),
      target
    );

    expect(
      invokeCalls.some((c) => c.command === 'get_branches'),
      'the list must be reloaded — the checkout happened'
    ).to.be.true;
    expect(
      uiStore.getState().toasts.some((t) => /switched to/i.test(t.message)),
      'and the message must name the half that succeeded'
    ).to.be.true;
  });
});

/**
 * A drag is the least deliberate of the three gestures that reach a rebase —
 * alt-drag is easy to trigger by accident — and it was the one surface whose
 * confirm omitted the history-rewrite disclosure the branch context menu and
 * the graph's ref menu both carry.
 */
describe('the drag-drop rebase confirm says what a rebase does', () => {
  let prompts: string[] = [];

  function mockWithPromptCapture(command: string, args?: unknown): Promise<unknown> {
    if (command === 'plugin:dialog|message') {
      prompts.push(String((args as { message?: string })?.message ?? ''));
      return Promise.resolve('Cancel');
    }
    return defaultMockInvoke(command);
  }

  beforeEach(() => {
    invokeCalls.length = 0;
    prompts = [];
  });

  it('warns about the rewrite when dropping onto the current branch', async () => {
    const el = await createComponent();
    const source = makeBranch('feature/source');
    const head = makeBranch('main', /* isHead */ true);
    (el as unknown as { draggingBranch: unknown }).draggingBranch = source;
    mockInvoke = mockWithPromptCapture;

    // Alt-drag onto HEAD is the rebase gesture.
    await (el as unknown as { handleDrop: (e: DragEvent, b: unknown) => Promise<void> }).handleDrop(
      fakeDragEvent(true),
      head
    );

    expect(prompts.join(' ')).to.contain('rewrite commit history');
    expect(invokeCalls.some((c) => c.command === 'rebase'), 'declining blocks it').to.be.false;
  });

  it('warns about the rewrite when dropping onto another branch', async () => {
    const el = await createComponent();
    const source = makeBranch('feature/source');
    const target = makeBranch('feature/target', /* isHead */ false);
    (el as unknown as { draggingBranch: unknown }).draggingBranch = source;
    mockInvoke = mockWithPromptCapture;

    await (el as unknown as { handleDrop: (e: DragEvent, b: unknown) => Promise<void> }).handleDrop(
      fakeDragEvent(true),
      target
    );

    expect(prompts.join(' ')).to.contain('rewrite commit history');
  });

  it('a merge drop is not labelled a history rewrite', async () => {
    const el = await createComponent();
    const source = makeBranch('feature/source');
    const target = makeBranch('feature/target', /* isHead */ false);
    (el as unknown as { draggingBranch: unknown }).draggingBranch = source;
    mockInvoke = mockWithPromptCapture;

    await (el as unknown as { handleDrop: (e: DragEvent, b: unknown) => Promise<void> }).handleDrop(
      fakeDragEvent(false),
      target
    );

    expect(prompts.join(' ')).to.not.contain('rewrite commit history');
  });
});
