/**
 * Tests for gn-branch-list conflict-dialog dispatch and hidden-branch behavior.
 *
 * - Context-menu merge/rebase conflicts must dispatch the same events as the
 *   drag-drop path ('merge-conflict' / 'open-conflict-dialog') so the conflict
 *   resolution dialog opens consistently across entry points.
 * - Hidden branches must get the .hidden-branch class and persist to
 *   localStorage keyed by repository path (surviving reconnect).
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

// ── Helpers ────────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

function makeBranch(overrides: Partial<{
  name: string;
  shorthand: string;
  isHead: boolean;
  isRemote: boolean;
  upstream: string | null;
  targetOid: string;
}> = {}) {
  return {
    name: overrides.name ?? 'feature/test',
    shorthand: overrides.shorthand ?? 'feature/test',
    isHead: overrides.isHead ?? false,
    isRemote: overrides.isRemote ?? false,
    upstream: overrides.upstream ?? null,
    targetOid: overrides.targetOid ?? 'abc123',
  };
}

function defaultMockInvoke(command: string): Promise<unknown> {
  if (command === 'get_branches') return Promise.resolve([]);
  if (command === 'get_remotes') return Promise.resolve([]);
  // Confirmation dialogs route through plugin:dialog|message and return the
  // clicked button label; 'Ok' means confirmed.
  if (command === 'plugin:dialog|message') return Promise.resolve('Ok');
  return Promise.resolve(null);
}

async function createComponent(branches: ReturnType<typeof makeBranch>[] = []): Promise<GnBranchList> {
  mockInvoke = (command: string) => {
    if (command === 'get_branches') return Promise.resolve(branches);
    return defaultMockInvoke(command);
  };
  const el = await fixture<GnBranchList>(
    html`<gn-branch-list .repositoryPath=${REPO_PATH}></gn-branch-list>`
  );
  await el.updateComplete;
  return el;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-branch-list conflict dispatch', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    localStorage.clear();
  });

  it('handleMergeBranch dispatches "merge-conflict" on MERGE_CONFLICT (no abort confirm)', async () => {
    const el = await createComponent();

    mockInvoke = (command: string) => {
      if (command === 'merge') {
        return Promise.reject({ code: 'MERGE_CONFLICT', message: 'conflicts' });
      }
      return defaultMockInvoke(command);
    };

    const branch = makeBranch({ name: 'feature/merge-me' });
    (el as unknown as { contextMenu: { visible: boolean; x: number; y: number; branch: typeof branch | null } }).contextMenu = {
      visible: true, x: 0, y: 0, branch,
    };

    let conflictEvent: CustomEvent | null = null;
    el.addEventListener('merge-conflict', (e) => { conflictEvent = e as CustomEvent; });

    invokeCalls.length = 0;
    await (el as unknown as { handleMergeBranch: () => Promise<void> }).handleMergeBranch();

    expect(conflictEvent, 'merge-conflict should be dispatched').to.not.be.null;
    expect(conflictEvent!.bubbles).to.be.true;
    expect(conflictEvent!.composed).to.be.true;
    // The abort-confirm flow must be gone — no abort_merge call.
    expect(invokeCalls.filter(c => c.command === 'abort_merge')).to.have.length(0);
  });

  it('handleRebaseBranch dispatches "open-conflict-dialog" with rebase detail on REBASE_CONFLICT', async () => {
    const el = await createComponent();

    mockInvoke = (command: string) => {
      if (command === 'rebase') {
        return Promise.reject({ code: 'REBASE_CONFLICT', message: 'conflicts' });
      }
      return defaultMockInvoke(command);
    };

    const branch = makeBranch({ name: 'feature/rebase-me' });
    (el as unknown as { contextMenu: { visible: boolean; x: number; y: number; branch: typeof branch | null } }).contextMenu = {
      visible: true, x: 0, y: 0, branch,
    };

    let conflictEvent: CustomEvent | null = null;
    el.addEventListener('open-conflict-dialog', (e) => { conflictEvent = e as CustomEvent; });

    invokeCalls.length = 0;
    await (el as unknown as { handleRebaseBranch: () => Promise<void> }).handleRebaseBranch();

    expect(conflictEvent, 'open-conflict-dialog should be dispatched').to.not.be.null;
    // The event carries the repo the rebase ran on so the dialog pins to it
    // even if the active tab changed while the rebase was in flight.
    expect(conflictEvent!.detail).to.deep.equal({
      operationType: 'rebase',
      repositoryPath: '/test/repo',
    });
    expect(conflictEvent!.bubbles).to.be.true;
    expect(conflictEvent!.composed).to.be.true;
    expect(invokeCalls.filter(c => c.command === 'abort_rebase')).to.have.length(0);
  });
});

describe('gn-branch-list hidden branches', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    localStorage.clear();
  });

  it('applies .hidden-branch class and persists to localStorage', async () => {
    const el = await createComponent([makeBranch({ name: 'main', shorthand: 'main' })]);

    (el as unknown as { toggleHideBranch: (n: string) => void }).toggleHideBranch('main');
    await el.updateComplete;

    const hidden = el.shadowRoot!.querySelector('.branch-item.hidden-branch');
    expect(hidden, 'branch item should carry hidden-branch class').to.not.be.null;

    const stored = localStorage.getItem(`gn-hidden-branches:${REPO_PATH}`);
    expect(stored).to.not.be.null;
    expect(JSON.parse(stored!)).to.include('main');
  });

  it('un-hiding removes the class and updates localStorage', async () => {
    const el = await createComponent([makeBranch({ name: 'main', shorthand: 'main' })]);

    const toggle = (el as unknown as { toggleHideBranch: (n: string) => void }).toggleHideBranch;
    toggle.call(el, 'main');
    await el.updateComplete;
    toggle.call(el, 'main');
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('.branch-item.hidden-branch')).to.be.null;
    const stored = localStorage.getItem(`gn-hidden-branches:${REPO_PATH}`);
    expect(JSON.parse(stored!)).to.not.include('main');
  });

  it('restores hidden branches from localStorage on a fresh component (reconnect)', async () => {
    localStorage.setItem(`gn-hidden-branches:${REPO_PATH}`, JSON.stringify(['main']));

    const el = await createComponent([makeBranch({ name: 'main', shorthand: 'main' })]);
    await el.updateComplete;

    expect(
      (el as unknown as { hiddenBranches: Set<string> }).hiddenBranches.has('main')
    ).to.be.true;
    expect(el.shadowRoot!.querySelector('.branch-item.hidden-branch')).to.not.be.null;
  });
});
