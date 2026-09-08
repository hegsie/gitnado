/**
 * Regression tests for verified branch correctness bugs in lv-branch-list:
 *
 *  - Finding 13: "Delete Merged Branches" must use the backend's real merged
 *    detection (`get_cleanup_candidates` category==='merged'), not an
 *    ahead-of-UPSTREAM===0 heuristic that both over- and under-selects.
 *  - Finding 14: "Create branch from here" on a REMOTE branch must pass the
 *    full remote-tracking name ("origin/feature") as the start point, not the
 *    stripped shorthand ("feature").
 *  - Finding 16: drag-drop merge/rebase onto a REMOTE target must check out the
 *    full "origin/topic" reference, not the stripped shorthand ("topic").
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
import type { LvBranchList } from '../lv-branch-list.ts';
import '../lv-branch-list.ts';
import { repositoryStore } from '../../../stores/repository.store.ts';
import type { Repository } from '../../../types/git.types.ts';

// ── Helpers ────────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

interface MockBranch {
  name: string;
  shorthand: string;
  isHead?: boolean;
  isRemote?: boolean;
  upstream?: string | null;
  targetOid?: string;
  aheadBehind?: { ahead: number; behind: number } | null;
  isStale?: boolean;
}

function makeBranch(b: MockBranch) {
  return {
    isHead: false,
    isRemote: false,
    upstream: null,
    targetOid: 'abc123',
    aheadBehind: null,
    isStale: false,
    ...b,
  };
}

async function createComponent(
  branches: ReturnType<typeof makeBranch>[],
  cleanupCandidates: Array<{ name: string; shorthand: string; category: string }> = [],
  failCleanup = false,
): Promise<LvBranchList> {
  mockInvoke = (command: string) => {
    if (command === 'get_branches') return Promise.resolve(branches);
    if (command === 'get_remotes') return Promise.resolve([]);
    if (command === 'get_hidden_branches') return Promise.resolve([]);
    if (command === 'get_branch_sort_mode') return Promise.resolve('name');
    if (command === 'get_cleanup_candidates') {
      return failCleanup
        ? Promise.reject(new Error('candidate scan failed'))
        : Promise.resolve(cleanupCandidates);
    }
    if (command === 'plugin:dialog|message') return Promise.resolve('Ok');
    return Promise.resolve(null);
  };
  const el = await fixture<LvBranchList>(
    html`<lv-branch-list .repositoryPath=${REPO_PATH}></lv-branch-list>`
  );
  await el.updateComplete;
  // connectedCallback -> loadBranches is async; wait a microtask turn for it.
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

function fakeDragEvent(altKey = false): DragEvent {
  return { preventDefault() {}, altKey } as unknown as DragEvent;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('lv-branch-list merged detection (Finding 13)', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
  });

  it('uses backend merged detection, not the ahead-of-upstream heuristic', async () => {
    // "merged-no-upstream": merged into HEAD but has no upstream (aheadBehind
    //   null) — the OLD heuristic would MISS it.
    // "pushed-unmerged": ahead-of-upstream 0 (fully pushed) but NOT merged —
    //   the OLD heuristic would WRONGLY include it.
    const el = await createComponent(
      [
        makeBranch({ name: 'main', shorthand: 'main', isHead: true }),
        makeBranch({ name: 'merged-no-upstream', shorthand: 'merged-no-upstream', aheadBehind: null }),
        makeBranch({
          name: 'pushed-unmerged',
          shorthand: 'pushed-unmerged',
          upstream: 'origin/pushed-unmerged',
          aheadBehind: { ahead: 0, behind: 0 },
        }),
      ],
      // Backend truth: only merged-no-upstream is merged into HEAD.
      [{ name: 'merged-no-upstream', shorthand: 'merged-no-upstream', category: 'merged' }],
    );

    // Assert the user-visible surface rather than a private helper: the
    // Clean up badge is driven by the backend's candidate list, so a branch
    // that is merely fully pushed must not be counted, and one that is merged
    // without an upstream must be.
    const candidates = (el as unknown as { cleanupCandidateNames: Set<string> })
      .cleanupCandidateNames;
    expect([...candidates].sort()).to.deep.equal(['merged-no-upstream']);

    const badge = el.shadowRoot!.querySelector('.cleanup-btn .badge');
    expect(badge, 'Clean up button rendered').to.not.be.null;
    expect(badge!.textContent!.trim()).to.equal('1');
  });

  // A failed candidate scan is NOT the same as "no candidates". Collapsing
  // both to an empty set made the Clean up button vanish from the sidebar with
  // no error, telling the user there is nothing to clean up when we simply
  // could not find out.
  it('keeps the Clean up button reachable when the candidate scan fails', async () => {
    const el = await createComponent(
      [
        makeBranch({ name: 'main', shorthand: 'main', isHead: true }),
        makeBranch({ name: 'feature', shorthand: 'feature' }),
      ],
      [],
      true,
    );

    const btn = el.shadowRoot!.querySelector('.cleanup-btn');
    expect(btn, 'Clean up button still rendered after a failed scan').to.not.be.null;
    expect(btn!.getAttribute('title')).to.contain('Could not check');
    // No count is known, so no badge may claim one.
    expect(el.shadowRoot!.querySelector('.cleanup-btn .badge')).to.be.null;
  });

  it('hides the Clean up button when the scan succeeds with no candidates', async () => {
    const el = await createComponent([
      makeBranch({ name: 'main', shorthand: 'main', isHead: true }),
    ]);

    expect(el.shadowRoot!.querySelector('.cleanup-btn')).to.be.null;
  });
});

describe('lv-branch-list create-branch-from remote (Finding 14)', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
  });

  it('passes the full remote name as the start point for a remote branch', async () => {
    const el = await createComponent([
      makeBranch({ name: 'main', shorthand: 'main', isHead: true }),
    ]);

    const remoteBranch = makeBranch({
      name: 'origin/feature',
      shorthand: 'feature',
      isRemote: true,
    });

    // The list no longer mounts its own dialog — it asks the host to open the
    // single instance, carrying the start point.
    let openedWith: string | undefined;
    el.addEventListener('create-branch', (e) => {
      openedWith = (e as CustomEvent<{ startPoint?: string }>).detail?.startPoint;
    });

    (el as unknown as { contextMenu: unknown }).contextMenu = {
      visible: true,
      x: 0,
      y: 0,
      branch: remoteBranch,
    };
    (el as unknown as { handleCreateBranchFrom: () => void }).handleCreateBranchFrom();

    expect(openedWith).to.equal('origin/feature');
  });

  it('passes the (full) local branch name for a local branch', async () => {
    const el = await createComponent([
      makeBranch({ name: 'main', shorthand: 'main', isHead: true }),
    ]);

    const localBranch = makeBranch({ name: 'feature/x', shorthand: 'feature/x' });

    let openedWith: string | undefined;
    el.addEventListener('create-branch', (e) => {
      openedWith = (e as CustomEvent<{ startPoint?: string }>).detail?.startPoint;
    });

    (el as unknown as { contextMenu: unknown }).contextMenu = {
      visible: true,
      x: 0,
      y: 0,
      branch: localBranch,
    };
    (el as unknown as { handleCreateBranchFrom: () => void }).handleCreateBranchFrom();

    expect(openedWith).to.equal('feature/x');
  });
});

describe('lv-branch-list drop onto remote target (Finding 16)', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
  });

  it('checks out the full remote name (origin/topic), not the shorthand', async () => {
    const el = await createComponent([
      makeBranch({ name: 'main', shorthand: 'main', isHead: true }),
    ]);

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
      if (command === 'plugin:dialog|message') return Promise.resolve('Ok');
      if (command === 'merge') return Promise.resolve(null);
      return Promise.resolve(null);
    };
    invokeCalls.length = 0;

    const source = makeBranch({ name: 'feature/source', shorthand: 'feature/source' });
    const remoteTarget = makeBranch({ name: 'origin/topic', shorthand: 'topic', isRemote: true });
    (el as unknown as { draggingBranch: unknown }).draggingBranch = source;

    await (el as unknown as { handleDrop: (e: DragEvent, b: unknown) => Promise<void> }).handleDrop(
      fakeDragEvent(false),
      remoteTarget
    );

    const checkoutCall = invokeCalls.find((c) => c.command === 'checkout_with_autostash');
    expect(checkoutCall, 'checkout_with_autostash was called').to.not.be.undefined;
    expect((checkoutCall!.args as { refName: string }).refName).to.equal('origin/topic');
  });
});

describe('lv-branch-list remote-branch operations use the full ref', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
  });

  /**
   * The backend resolves `refs/heads/<ref>` BEFORE `refs/remotes/<ref>`, so
   * sending the shorthand for a remote branch silently hits the LOCAL branch of
   * the same name — merging or rebasing onto a different commit than the row
   * the user right-clicked, with a confirm that named the shorthand so nothing
   * looked wrong.
   */
  const remoteBranch = () =>
    makeBranch({ name: 'origin/topic', shorthand: 'topic', isRemote: true });

  async function withRemoteContextMenu(): Promise<LvBranchList> {
    const el = await createComponent([
      makeBranch({ name: 'main', shorthand: 'main', isHead: true }),
    ]);
    (el as unknown as { contextMenu: unknown }).contextMenu = {
      visible: true,
      x: 0,
      y: 0,
      branch: remoteBranch(),
    };
    return el;
  }

  it('merges origin/topic, not the local topic', async () => {
    const el = await withRemoteContextMenu();
    invokeCalls.length = 0;

    await (el as unknown as { handleMergeBranch: () => Promise<void> }).handleMergeBranch();

    const call = invokeCalls.find((c) => c.command === 'merge');
    expect(call, 'merge invoked').to.not.be.undefined;
    expect((call!.args as { sourceRef: string }).sourceRef).to.equal('origin/topic');
  });

  it('rebases onto origin/topic, not the local topic', async () => {
    const el = await withRemoteContextMenu();
    invokeCalls.length = 0;

    await (el as unknown as { handleRebaseBranch: () => Promise<void> }).handleRebaseBranch();

    const call = invokeCalls.find((c) => c.command === 'rebase');
    expect(call, 'rebase invoked').to.not.be.undefined;
    expect((call!.args as { onto: string }).onto).to.equal('origin/topic');
  });

  it('asks the host for an interactive rebase onto origin/topic', async () => {
    const el = await withRemoteContextMenu();
    let onto: string | undefined;
    el.addEventListener('interactive-rebase', (e) => {
      onto = (e as CustomEvent<{ onto?: string }>).detail?.onto;
    });

    (el as unknown as { handleInteractiveRebase: () => void }).handleInteractiveRebase();

    expect(onto).to.equal('origin/topic');
  });

  it('a local branch still sends its own name', async () => {
    const el = await createComponent([
      makeBranch({ name: 'main', shorthand: 'main', isHead: true }),
    ]);
    (el as unknown as { contextMenu: unknown }).contextMenu = {
      visible: true,
      x: 0,
      y: 0,
      branch: makeBranch({ name: 'feature/x', shorthand: 'feature/x' }),
    };
    invokeCalls.length = 0;

    await (el as unknown as { handleMergeBranch: () => Promise<void> }).handleMergeBranch();

    const call = invokeCalls.find((c) => c.command === 'merge');
    expect((call!.args as { sourceRef: string }).sourceRef).to.equal('feature/x');
  });
});

/**
 * The remotes this panel loads are STORE data too.
 *
 * Every `loadBranches()` asks git for the remotes (remote branches are grouped
 * by them) and used to drop the answer on the floor — while the store field it
 * would have filled, the one that decides whether Fetch/Pull/Push are offered
 * at all, had a single writer that runs only when a tab is activated.
 */
describe('lv-branch-list mirrors the remotes it loads', () => {
  const ORIGIN = { name: 'origin', url: 'https://example.test/o/r.git', pushUrl: null };

  function openRepo(): void {
    repositoryStore.getState().addRepository({
      path: REPO_PATH,
      name: 'repo',
      isValid: true,
      isBare: false,
      headRef: 'refs/heads/main',
      detachedHeadOid: null,
      state: 'clean',
      isShallow: false,
      isPartialClone: false,
      cloneFilter: null,
    } satisfies Repository);
  }

  function storedRepo() {
    return repositoryStore.getState().openRepositories[0];
  }

  async function mount(remotes: () => Promise<unknown>): Promise<LvBranchList> {
    mockInvoke = (command: string) => {
      if (command === 'get_branches') return Promise.resolve([]);
      if (command === 'get_remotes') return remotes();
      if (command === 'get_hidden_branches') return Promise.resolve([]);
      if (command === 'get_branch_sort_mode') return Promise.resolve('name');
      if (command === 'get_cleanup_candidates') return Promise.resolve([]);
      return Promise.resolve(null);
    };
    const el = await fixture<LvBranchList>(
      html`<lv-branch-list .repositoryPath=${REPO_PATH}></lv-branch-list>`,
    );
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
    return el;
  }

  beforeEach(() => {
    repositoryStore.getState().reset();
  });

  afterEach(() => {
    repositoryStore.getState().reset();
  });

  it('writes them into the open repository instead of discarding them', async () => {
    openRepo();

    await mount(() => Promise.resolve([ORIGIN]));

    expect(storedRepo().remotes, 'the answer reached the store').to.have.lengthOf(1);
    expect(storedRepo().remotesLoaded, 'and counts as an answer').to.equal(true);
  });

  it('records an empty answer as an answer', async () => {
    openRepo();

    await mount(() => Promise.resolve([]));

    expect(storedRepo().remotes).to.deep.equal([]);
    expect(storedRepo().remotesLoaded).to.equal(true);
  });

  it('leaves the store alone when the read fails', async () => {
    // A failed read is not "no remotes": writing an empty list here would tell
    // every remote surface the repository has nowhere to push.
    openRepo();
    repositoryStore.getState().updateRepoData(REPO_PATH, { remotes: [ORIGIN] });

    await mount(() => Promise.reject(new Error('cannot read config')));

    expect(storedRepo().remotes, 'the last known answer survives').to.have.lengthOf(1);
  });
});
