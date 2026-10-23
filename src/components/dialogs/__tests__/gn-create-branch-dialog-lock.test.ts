/**
 * "Checkout new branch after creation" is this dialog's default, and that path
 * runs checkout_tree + set_head in the backend — the same working-tree mutation
 * every other surface serializes on the shared lock. This dialog was the last
 * one outside it, so a create+checkout could run beside a graph reset or a
 * sidebar discard against the same tree.
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
import '../gn-create-branch-dialog.ts';
import type { GnCreateBranchDialog } from '../gn-create-branch-dialog.ts';
import {
  tryAcquireRefOp,
  isRefOpRunning,
  resetRefOpLocks,
} from '../../../utils/ref-lock.ts';

const REPO_PATH = '/test/repo';

interface Internal {
  branchName: string;
  checkoutAfterCreate: boolean;
  error: string;
  handleCreate: () => Promise<void>;
}

async function openDialog(checkout: boolean): Promise<GnCreateBranchDialog> {
  const el = await fixture<GnCreateBranchDialog>(
    html`<gn-create-branch-dialog .repositoryPath=${REPO_PATH}></gn-create-branch-dialog>`
  );
  el.open();
  await el.updateComplete;
  const internal = el as unknown as Internal;
  internal.branchName = 'feature/x';
  internal.checkoutAfterCreate = checkout;
  await el.updateComplete;
  return el;
}

describe('gn-create-branch-dialog and the working-tree lock', () => {
  beforeEach(() => {
    resetRefOpLocks();
    invokeHistory.length = 0;
    mockInvoke = () => Promise.resolve(null);
  });

  afterEach(() => {
    resetRefOpLocks();
  });

  it('refuses a create+checkout while another surface holds the lock', async () => {
    const el = await openDialog(true);
    tryAcquireRefOp(REPO_PATH);
    invokeHistory.length = 0;

    await (el as unknown as Internal).handleCreate();

    expect(
      invokeHistory.some((h) => h.command === 'create_branch'),
      'the checkout would have run beside another working-tree operation',
    ).to.equal(false);
    expect(
      (el as unknown as Internal).error,
      'a silent refusal loses the name the user typed',
    ).to.contain('Another operation');
  });

  it('holds the lock for the duration of a create+checkout', async () => {
    const el = await openDialog(true);

    let heldDuringCreate = false;
    mockInvoke = (command: string) => {
      if (command === 'create_branch') {
        heldDuringCreate = isRefOpRunning(REPO_PATH);
      }
      return Promise.resolve(null);
    };

    await (el as unknown as Internal).handleCreate();

    expect(heldDuringCreate, 'other surfaces would have seen a free lock').to.equal(true);
    expect(
      isRefOpRunning(REPO_PATH),
      'a stuck claim would freeze every ref operation for the session',
    ).to.equal(false);
  });

  it('does NOT take the lock when the branch is created without checking out', async () => {
    // Creating a ref touches no working tree, so it must not block on — or
    // block — an unrelated operation.
    const el = await openDialog(false);
    tryAcquireRefOp(REPO_PATH);
    invokeHistory.length = 0;

    await (el as unknown as Internal).handleCreate();

    expect(
      invokeHistory.some((h) => h.command === 'create_branch'),
      'a plain ref creation must not be blocked',
    ).to.equal(true);
  });
});
