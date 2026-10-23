/**
 * Commit and Amend must wait on the shared working-tree lock.
 *
 * The graph's Amend menu entry was gated on the lock, but that entry runs no
 * git command — it only reveals this panel in amend mode. The command that
 * actually rewrites HEAD is this panel's Commit button, and the panel never
 * observed the lock at all. So during a graph-initiated rebase, merge, hard
 * reset or discard — with every list, menu and dialog correctly greyed out —
 * Commit stayed live and create_commit ran against the tree those commands
 * were rewriting.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const invoked: string[] = [];
const mockInvoke: MockInvoke = async (command: string) => {
  invoked.push(command);
  if (command === 'plugin:notification|is_permission_granted') return false;
  if (command === 'get_status') return { staged: [], unstaged: [], untracked: [] };
  return null;
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import '../gn-commit-panel.ts';
import { tryAcquireRefOp, releaseRefOp, resetRefOpLocks } from '../../../utils/ref-lock.ts';

const REPO_PATH = '/test/repo';

interface Panel extends HTMLElement {
  updateComplete: Promise<unknown>;
}

async function render(): Promise<Panel> {
  const el = await fixture<Panel>(html`
    <gn-commit-panel .repositoryPath=${REPO_PATH} .stagedCount=${2}></gn-commit-panel>
  `);
  await el.updateComplete;
  (el as unknown as { summary: string }).summary = 'a commit message';
  await el.updateComplete;
  return el;
}

describe('gn-commit-panel waits on the shared working-tree lock', () => {
  beforeEach(() => {
    resetRefOpLocks();
    invoked.length = 0;
  });

  afterEach(() => {
    resetRefOpLocks();
  });

  it('disables Commit while another surface holds the tree', async () => {
    const el = await render();
    const internal = el as unknown as { canCommit: boolean };

    expect(internal.canCommit, 'committable while the repo is idle').to.be.true;

    tryAcquireRefOp(REPO_PATH);
    await el.updateComplete;
    expect(internal.canCommit, 'a rebase or reset elsewhere must block a commit').to.be.false;

    releaseRefOp(REPO_PATH);
    await el.updateComplete;
    expect(internal.canCommit, 'and the release must revive it').to.be.true;
  });

  it('refuses to commit even if the gate is bypassed', async () => {
    const el = await render();
    tryAcquireRefOp(REPO_PATH);

    invoked.length = 0;
    await (el as unknown as { handleCommit: () => Promise<void> }).handleCommit();

    expect(
      invoked.filter((c) => c === 'create_commit'),
      'no commit may run against a tree another operation is rewriting'
    ).to.have.length(0);
  });
});
