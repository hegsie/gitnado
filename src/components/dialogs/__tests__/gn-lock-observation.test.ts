/**
 * Every surface that CLAIMS the working-tree lock must also OBSERVE it.
 *
 * The two halves are separable, and only the claim kept getting applied. A
 * component that claims but never subscribes still refuses correctly — the
 * data stays safe — but its buttons stay lit through the other operation and
 * do nothing except raise a refusal toast. That dead control is the thing the
 * whole mechanism exists to remove, and it was the state of six dialogs at
 * once, found by sweeping rather than by any single report.
 *
 * These assertions are on RENDERED DOM. The `busy` getter calls isRefOpRunning
 * on every access, so it reports the truth whether or not the host ever
 * subscribed — reading it would pass with the subscription deleted.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const mockInvoke: MockInvoke = async (command: string) => {
  if (command === 'plugin:notification|is_permission_granted') return false;
  switch (command) {
    case 'get_branches':
    case 'get_remotes':
    case 'get_hidden_branches':
    case 'get_cleanup_candidates':
    case 'get_commits':
      return [];
    case 'get_branch_sort_mode':
      return 'name';
    default:
      return null;
  }
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import '../gn-interactive-rebase-dialog.ts';
import '../gn-bisect-dialog.ts';
import '../gn-create-branch-dialog.ts';
import '../gn-cherry-pick-dialog.ts';
import '../gn-branch-cleanup-dialog.ts';
import '../../dashboard/gn-context-dashboard.ts';
import { tryAcquireRefOp, releaseRefOp, resetRefOpLocks } from '../../../utils/ref-lock.ts';

const REPO_PATH = '/test/repo';

interface Updatable extends HTMLElement {
  updateComplete: Promise<unknown>;
}

/**
 * The minimal state each surface needs before its primary action is reachable
 * at all — a bisect with no commits entered, or a cherry-pick with no commit
 * selected, renders nothing to assert on.
 */
const SEED: Record<string, (el: Updatable) => void> = {
  'gn-interactive-rebase-dialog': (el) => {
    (el as unknown as { commits: unknown[] }).commits = [
      { oid: 'abc1234', shortId: 'abc1234', summary: 'a commit', action: 'pick' },
    ];
  },
  'gn-create-branch-dialog': (el) => {
    const internal = el as unknown as { branchName: string; checkoutAfterCreate: boolean };
    internal.branchName = 'feature/x';
    internal.checkoutAfterCreate = true;
  },
  'gn-branch-cleanup-dialog': (el) => {
    const internal = el as unknown as {
      mergedBranches: unknown[];
      selectedBranches: Set<string>;
    };
    internal.mergedBranches = [
      {
        branch: { name: 'feature/done', shorthand: 'feature/done', isHead: false, isRemote: false },
        category: 'merged',
        lastCommitDate: 0,
        aheadBehind: null,
      },
    ];
    internal.selectedBranches = new Set(['feature/done']);
    (el as unknown as { loading: boolean }).loading = false;
    (el as unknown as { activeTab: string }).activeTab = 'merged';
  },
  'gn-bisect-dialog': (el) => {
    const internal = el as unknown as { badCommitInput: string; goodCommitInput: string };
    internal.badCommitInput = 'abc1234';
    internal.goodCommitInput = 'def5678';
  },
  'gn-cherry-pick-dialog': (el) => {
    (el as unknown as { open: (c: unknown) => void }).open({
      oid: 'abc1234',
      shortId: 'abc1234',
      summary: 'a commit',
      message: 'a commit',
      author: { name: 'T', email: 't@example.test', timestamp: 0 },
      committer: { name: 'T', email: 't@example.test', timestamp: 0 },
      parentIds: ['0000000'],
      timestamp: 0,
    });
  },
};

/** Render `tag` open and pinned to REPO_PATH. */
async function open(tag: string): Promise<Updatable> {
  const node = document.createElement(tag) as Updatable & {
    repositoryPath: string;
    open: boolean;
  };
  node.repositoryPath = REPO_PATH;
  // gn-cherry-pick-dialog has no `open` PROPERTY — `open(commit)` is a method,
  // and it is what puts the dialog on screen. Everything else takes the flag.
  if (tag !== 'gn-cherry-pick-dialog') node.open = true;
  const el = await fixture<Updatable>(node);
  await el.updateComplete;
  SEED[tag]?.(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

/**
 * At least one rendered control must go from enabled to disabled and back as
 * another surface claims and releases the lock, with no gesture in between.
 */
async function expectSomeControlTracksLock(el: Updatable, what: string): Promise<void> {
  const enabledNow = (): HTMLButtonElement[] =>
    Array.from(el.shadowRoot!.querySelectorAll('button')).filter((b) => !b.disabled);

  const before = enabledNow();
  expect(before.length, `${what}: some control must be enabled while idle`).to.be.greaterThan(0);

  tryAcquireRefOp(REPO_PATH);
  await el.updateComplete;
  const during = enabledNow();

  expect(
    during.length,
    `${what}: a claim from another surface must disable at least one control`,
  ).to.be.lessThan(before.length);

  releaseRefOp(REPO_PATH);
  await el.updateComplete;
  expect(enabledNow().length, `${what}: the release must revive them`).to.equal(before.length);
}

const SURFACES = [
  'gn-interactive-rebase-dialog',
  'gn-bisect-dialog',
  'gn-create-branch-dialog',
  'gn-cherry-pick-dialog',
  'gn-branch-cleanup-dialog',
] as const;

describe('every lock-claiming surface observes the lock', () => {
  beforeEach(() => {
    resetRefOpLocks();
  });

  afterEach(() => {
    resetRefOpLocks();
  });

  for (const tag of SURFACES) {
    it(`${tag} greys a control out on a claim taken elsewhere`, async () => {
      const el = await open(tag);
      await expectSomeControlTracksLock(el, tag);
    });
  }

  // The negative half, and it is not symmetric with the above. `busy` reflects
  // ANY operation anywhere in the repo, so binding it to Cancel greys out the
  // most obvious way to leave a dialog for a reason that has nothing to do
  // with the dialog — the decision gn-clean-dialog and
  // gn-repository-health-dialog already carry in comments, and that applying
  // the controller uniformly to every footer binding walked straight back
  // into.
  for (const tag of SURFACES) {
    it(`${tag} keeps its dismiss control clickable`, async () => {
      const el = await open(tag);
      const cancel = Array.from(el.shadowRoot!.querySelectorAll('button')).find((b) =>
        /^(cancel|close)$/i.test((b.textContent ?? '').trim()),
      );
      if (!cancel) return; // this surface dismisses some other way

      expect(cancel.disabled, `${tag}: Cancel enabled while idle`).to.equal(false);
      tryAcquireRefOp(REPO_PATH);
      await el.updateComplete;
      expect(
        cancel.disabled,
        `${tag}: Cancel must stay clickable while an unrelated operation runs`,
      ).to.equal(false);
      releaseRefOp(REPO_PATH);
    });
  }

  // handleCreate claims the lock ONLY when it will also check out — creating a
  // ref without checking it out touches no working tree. The binding said
  // otherwise, so Create Branch sat greyed out for the whole of an unrelated
  // checkout even with "Checkout after creation" unticked.
  it('gn-create-branch-dialog allows a no-checkout create while the repo is busy', async () => {
    const el = await open('gn-create-branch-dialog');
    const internal = el as unknown as { branchName: string; checkoutAfterCreate: boolean };
    internal.checkoutAfterCreate = false;
    await el.updateComplete;

    const create = Array.from(el.shadowRoot!.querySelectorAll('button')).find((b) =>
      /create/i.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    expect(create, 'the Create button must be rendered').to.not.be.undefined;
    expect(create.disabled, 'enabled while idle').to.equal(false);

    tryAcquireRefOp(REPO_PATH);
    await el.updateComplete;
    expect(
      create.disabled,
      'a create that will not check out must not wait on the working tree',
    ).to.equal(false);

    internal.checkoutAfterCreate = true;
    await el.updateComplete;
    expect(create.disabled, 'but one that WILL check out must wait').to.equal(true);

    releaseRefOp(REPO_PATH);
  });
});
