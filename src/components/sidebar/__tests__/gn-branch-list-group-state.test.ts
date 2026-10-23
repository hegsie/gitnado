/**
 * Two branch-list defects.
 *
 * 1. Collapsed groups re-expanded on every refresh. loadBranches auto-expands
 *    every group it finds, and it runs after every checkout, delete, rename,
 *    merge and rebase, and on every repository-refresh event — so a collapsed
 *    group snapped back open the moment the user did anything.
 *
 * 2. "Track remote branch" left the UI stale when set-upstream failed. The
 *    branch had already been created, but the refresh was skipped, so the
 *    sidebar never showed it — and retrying then failed at createBranch with
 *    "branch already exists" and never reached the upstream step.
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

import { expect, fixture, html } from '@open-wc/testing';
import { uiStore } from '../../../stores/ui.store.ts';
import type { GnBranchList } from '../gn-branch-list.ts';
import '../gn-branch-list.ts';
import { resetRefOpLocks } from '../../../utils/ref-lock.ts';

const REPO_PATH = '/test/repo';

/** Local branches under a "feature/" prefix, so a prefix group exists. */
const BRANCHES = [
  { name: 'main', shorthand: 'main', isHead: true, isRemote: false, upstream: null },
  { name: 'feature/one', shorthand: 'feature/one', isHead: false, isRemote: false, upstream: null },
  { name: 'feature/two', shorthand: 'feature/two', isHead: false, isRemote: false, upstream: null },
];

function defaultMocks(overrides: Record<string, unknown> = {}): void {
  mockInvoke = async (command: string) => {
    if (command in overrides) {
      const value = overrides[command];
      if (typeof value === 'function') return (value as () => unknown)();
      return value;
    }
    switch (command) {
      case 'get_branches':
        return BRANCHES;
      case 'get_remotes':
      case 'get_hidden_branches':
        return [];
      case 'get_branch_sort_mode':
        return 'name';
      default:
        return null;
    }
  };
}

async function createList(): Promise<GnBranchList> {
  const el = await fixture<GnBranchList>(
    html`<gn-branch-list .repositoryPath=${REPO_PATH}></gn-branch-list>`,
  );
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
  return el;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('gn-branch-list group collapse state', () => {
  beforeEach(() => {
    resetRefOpLocks();
    invokeCalls.length = 0;
    uiStore.setState({ toasts: [] });
    defaultMocks();
  });

  it('keeps a group collapsed across a refresh', async () => {
    const el = await createList();

    // Collapse the prefix group the way a click does.
    (el as any).toggleGroup('local-feature');
    await el.updateComplete;
    expect((el as any).expandedGroups.has('local-feature'), 'collapsed').to.be.false;

    // Any mutation triggers this; previously it forced the group open again.
    await (el as any).loadBranches();
    await el.updateComplete;

    expect(
      (el as any).expandedGroups.has('local-feature'),
      'a deliberately collapsed group must stay collapsed',
    ).to.be.false;
  });

  it('re-expands a group the user opens again, and keeps it open', async () => {
    const el = await createList();

    (el as any).toggleGroup('local-feature');
    await el.updateComplete;
    (el as any).toggleGroup('local-feature');
    await el.updateComplete;

    await (el as any).loadBranches();
    await el.updateComplete;

    expect((el as any).expandedGroups.has('local-feature')).to.be.true;
  });

  it('still auto-expands a group seen for the first time', async () => {
    const el = await createList();

    expect(
      (el as any).expandedGroups.has('local-feature'),
      'new groups open by default',
    ).to.be.true;
  });

  // The panel REBINDS `repositoryPath` on a tab switch rather than remounting
  // this component, so collapse intent recorded under a bare group id held the
  // same-named group shut in every other repository the user opened.
  it('does not carry a collapse into another repository', async () => {
    const el = await createList();

    (el as any).toggleGroup('local-feature');
    await el.updateComplete;
    expect((el as any).expandedGroups.has('local-feature'), 'collapsed in repo A').to.be.false;

    // User switches tabs; the same component now shows another repository.
    el.repositoryPath = '/test/other-repo';
    await el.updateComplete;
    await (el as any).loadBranches();
    await el.updateComplete;

    expect(
      (el as any).expandedGroups.has('local-feature'),
      'a group collapsed in repo A must still open by default in repo B',
    ).to.be.true;
  });

  it('remembers the collapse when the user comes back to that repository', async () => {
    const el = await createList();

    (el as any).toggleGroup('local-feature');
    await el.updateComplete;

    el.repositoryPath = '/test/other-repo';
    await el.updateComplete;
    await (el as any).loadBranches();
    await el.updateComplete;

    el.repositoryPath = REPO_PATH;
    await el.updateComplete;
    await (el as any).loadBranches();
    await el.updateComplete;

    expect(
      (el as any).expandedGroups.has('local-feature'),
      'returning to repo A must find the group as the user left it',
    ).to.be.false;
  });
});

describe('gn-branch-list track remote branch', () => {
  beforeEach(() => {
    resetRefOpLocks();
    invokeCalls.length = 0;
    uiStore.setState({ toasts: [] });
  });

  it('refreshes and reports the partial outcome when set-upstream fails', async () => {
    defaultMocks({
      create_branch: () => null,
      set_upstream_branch: () => {
        throw { code: 'ERR', message: 'no such remote ref' };
      },
    });

    const el = await createList();
    (el as any).contextMenu = {
      visible: true,
      x: 0,
      y: 0,
      branch: { name: 'origin/feature', shorthand: 'feature', isRemote: true, isHead: false },
    };
    await el.updateComplete;

    invokeCalls.length = 0;
    await (el as any).handleTrackRemoteBranch();
    await el.updateComplete;

    // The branch exists now, so the list must show it.
    expect(
      invokeCalls.some((c) => c.command === 'get_branches'),
      'the branch was created, so the sidebar must reload',
    ).to.be.true;

    // And the message must say the branch exists, not just that something failed.
    const messages = uiStore.getState().toasts.map((t) => t.message);
    expect(
      messages.some((m) => /created\s+feature/i.test(m) && /upstream/i.test(m)),
      `expected a partial-outcome message, got: ${messages.join(' | ')}`,
    ).to.be.true;
  });

  it('refreshes on the fully successful path too', async () => {
    defaultMocks({ create_branch: () => null, set_upstream_branch: () => null });

    const el = await createList();
    (el as any).contextMenu = {
      visible: true,
      x: 0,
      y: 0,
      branch: { name: 'origin/feature', shorthand: 'feature', isRemote: true, isHead: false },
    };
    await el.updateComplete;

    invokeCalls.length = 0;
    await (el as any).handleTrackRemoteBranch();
    await el.updateComplete;

    expect(invokeCalls.some((c) => c.command === 'get_branches')).to.be.true;
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
