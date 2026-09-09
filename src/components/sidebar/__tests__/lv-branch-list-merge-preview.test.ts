/**
 * Tests for the merge-conflict prediction shown in lv-branch-list's confirms.
 *
 * Every surface that starts a merge has to predict it BEFORE the user commits
 * to it — the context menu and both drag-to-merge arms. The prediction must
 * also never gate the merge: if preview_merge fails, the confirm still appears
 * and the merge still runs.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invokeCalls: Array<{ command: string; args?: unknown }> = [];
/** Button label the mocked confirm resolves with. 'Ok' means accepted. */
let confirmAnswer = 'Ok';

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    if (command === 'plugin:dialog|message') return Promise.resolve(confirmAnswer);
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import type { LvBranchList } from '../lv-branch-list.ts';
import '../lv-branch-list.ts';
import { resetRefOpLocks } from '../../../utils/ref-lock.ts';
import { uiStore } from '../../../stores/ui.store.ts';

const REPO_PATH = '/test/repo';

interface PreviewShape {
  outcome: string;
  conflictCount: number;
  conflictingFiles: string[];
  unrelatedHistories: boolean;
  operationInProgress: string | null;
}

function preview(overrides: Partial<PreviewShape> = {}): PreviewShape {
  return {
    outcome: 'normal',
    conflictCount: 0,
    conflictingFiles: [],
    unrelatedHistories: false,
    operationInProgress: null,
    ...overrides,
  };
}

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

function baseMock(command: string, _args?: unknown): Promise<unknown> {
  if (command === 'get_branches') return Promise.resolve([]);
  if (command === 'get_remotes') return Promise.resolve([]);
  if (command === 'get_hidden_branches') return Promise.resolve([]);
  if (command === 'get_branch_sort_mode') return Promise.resolve('name');
  return Promise.resolve(null);
}

async function createComponent(): Promise<LvBranchList> {
  mockInvoke = baseMock;
  const el = await fixture<LvBranchList>(
    html`<lv-branch-list .repositoryPath=${REPO_PATH}></lv-branch-list>`
  );
  await el.updateComplete;
  invokeCalls.length = 0;
  return el;
}

/** The message text of the confirm dialog, or null when none was shown. */
function confirmMessage(): string | null {
  const call = invokeCalls.find((c) => c.command === 'plugin:dialog|message');
  return call ? ((call.args as { message?: string }).message ?? null) : null;
}

function indexOfCommand(command: string): number {
  return invokeCalls.findIndex((c) => c.command === command);
}

function fakeDragEvent(altKey = false): DragEvent {
  return { preventDefault() {}, altKey } as unknown as DragEvent;
}

type MergeMenuHost = { contextMenu: { branch: unknown; visible: boolean }; handleMergeBranch(): Promise<void> };
type DropHost = { draggingBranch: unknown; handleDrop(e: DragEvent, b: unknown): Promise<void> };

async function mergeFromContextMenu(el: LvBranchList, branchName: string): Promise<void> {
  const host = el as unknown as MergeMenuHost;
  host.contextMenu = { branch: makeBranch(branchName), visible: true };
  await host.handleMergeBranch();
}

describe('lv-branch-list merge preview', () => {
  beforeEach(() => {
    resetRefOpLocks();
    invokeCalls.length = 0;
    confirmAnswer = 'Ok';
    uiStore.setState({ toasts: [] });
  });

  afterEach(() => {
    resetRefOpLocks();
  });

  it('names the conflicting files in the confirm BEFORE the merge runs', async () => {
    const el = await createComponent();
    mockInvoke = (command, args) => {
      if (command === 'preview_merge') {
        return Promise.resolve(
          preview({ conflictCount: 2, conflictingFiles: ['src/a.ts', 'src/b.ts'] })
        );
      }
      return baseMock(command, args);
    };

    await mergeFromContextMenu(el, 'feature');

    const message = confirmMessage();
    expect(message, 'the merge confirm was shown').to.not.be.null;
    expect(message!).to.contain('2 files would conflict:');
    expect(message!).to.contain('src/a.ts');
    expect(message!).to.contain('src/b.ts');

    // The prediction is worthless if it arrives after the merge started.
    const previewAt = indexOfCommand('preview_merge');
    const confirmAt = indexOfCommand('plugin:dialog|message');
    const mergeAt = indexOfCommand('merge');
    expect(previewAt).to.be.greaterThan(-1);
    expect(confirmAt).to.be.greaterThan(previewAt);
    expect(mergeAt).to.be.greaterThan(confirmAt);
  });

  it('previews against HEAD, using the full ref name of the row', async () => {
    const el = await createComponent();
    mockInvoke = (command, args) => {
      if (command === 'preview_merge') return Promise.resolve(preview());
      return baseMock(command, args);
    };

    await mergeFromContextMenu(el, 'origin/feature');

    const call = invokeCalls.find((c) => c.command === 'preview_merge');
    expect(call!.args).to.deep.equal({
      path: REPO_PATH,
      sourceRef: 'origin/feature',
      intoRef: undefined,
    });
  });

  it('says a fast-forward will fast-forward', async () => {
    const el = await createComponent();
    mockInvoke = (command, args) => {
      if (command === 'preview_merge') {
        return Promise.resolve(preview({ outcome: 'fastForward' }));
      }
      return baseMock(command, args);
    };

    await mergeFromContextMenu(el, 'feature');
    expect(confirmMessage()!).to.contain('fast-forward');
  });

  it('says a divergent clean merge will create a merge commit', async () => {
    const el = await createComponent();
    mockInvoke = (command, args) => {
      if (command === 'preview_merge') return Promise.resolve(preview());
      return baseMock(command, args);
    };

    await mergeFromContextMenu(el, 'feature');
    expect(confirmMessage()!).to.contain('merge commit');
  });

  it('still confirms and merges when the preview fails', async () => {
    const el = await createComponent();
    mockInvoke = (command, args) => {
      if (command === 'preview_merge') return Promise.reject(new Error('no preview'));
      return baseMock(command, args);
    };

    await mergeFromContextMenu(el, 'feature');

    const message = confirmMessage();
    expect(message, 'the confirm is shown without a prediction').to.not.be.null;
    expect(message!).to.contain('Merge "feature" into the current branch?');
    expect(message!).to.not.contain('would conflict');
    expect(invokeCalls.some((c) => c.command === 'merge'), 'merge still ran').to.be.true;
  });

  it('does not merge when the user declines the predicted conflict', async () => {
    const el = await createComponent();
    confirmAnswer = 'Cancel';
    mockInvoke = (command, args) => {
      if (command === 'preview_merge') {
        return Promise.resolve(preview({ conflictCount: 1, conflictingFiles: ['src/a.ts'] }));
      }
      return baseMock(command, args);
    };

    await mergeFromContextMenu(el, 'feature');

    expect(confirmMessage()!).to.contain('1 file would conflict:');
    expect(invokeCalls.some((c) => c.command === 'merge'), 'merge NOT called').to.be.false;
  });

  it('predicts a drag-merge onto the current branch', async () => {
    const el = await createComponent();
    mockInvoke = (command, args) => {
      if (command === 'preview_merge') {
        return Promise.resolve(preview({ conflictCount: 1, conflictingFiles: ['shared.txt'] }));
      }
      return baseMock(command, args);
    };

    (el as unknown as DropHost).draggingBranch = makeBranch('feature');
    await (el as unknown as DropHost).handleDrop(fakeDragEvent(false), makeBranch('main', true));

    const call = invokeCalls.find((c) => c.command === 'preview_merge');
    expect(call, 'the drop path previews too').to.not.be.undefined;
    expect((call!.args as { intoRef?: string }).intoRef).to.be.undefined;
    expect(confirmMessage()!).to.contain('shared.txt');
  });

  it('predicts a drag-merge onto another branch against THAT branch', async () => {
    const el = await createComponent();
    mockInvoke = (command, args) => {
      if (command === 'preview_merge') {
        return Promise.resolve(preview({ conflictCount: 1, conflictingFiles: ['shared.txt'] }));
      }
      if (command === 'checkout_with_autostash') {
        return Promise.resolve({ success: true, stashed: false, message: '' });
      }
      return baseMock(command, args);
    };

    (el as unknown as DropHost).draggingBranch = makeBranch('feature');
    await (el as unknown as DropHost).handleDrop(fakeDragEvent(false), makeBranch('develop'));

    const call = invokeCalls.find((c) => c.command === 'preview_merge');
    expect(call, 'the checkout-then-merge arm previews too').to.not.be.undefined;
    expect(call!.args).to.deep.equal({
      path: REPO_PATH,
      sourceRef: 'feature',
      intoRef: 'develop',
    });

    // Predicted BEFORE the checkout, which is the point of no return here.
    const previewAt = indexOfCommand('preview_merge');
    const checkoutAt = indexOfCommand('checkout_with_autostash');
    expect(previewAt).to.be.greaterThan(-1);
    expect(checkoutAt).to.be.greaterThan(previewAt);
    expect(confirmMessage()!).to.contain('shared.txt');
  });

  it('does not preview an alt-drag rebase', async () => {
    const el = await createComponent();
    mockInvoke = (command, args) => {
      if (command === 'checkout_with_autostash') {
        return Promise.resolve({ success: true, stashed: false, message: '' });
      }
      return baseMock(command, args);
    };

    (el as unknown as DropHost).draggingBranch = makeBranch('feature');
    await (el as unknown as DropHost).handleDrop(fakeDragEvent(true), makeBranch('develop'));

    expect(
      invokeCalls.some((c) => c.command === 'preview_merge'),
      'a rebase is not a merge'
    ).to.be.false;
  });
});
