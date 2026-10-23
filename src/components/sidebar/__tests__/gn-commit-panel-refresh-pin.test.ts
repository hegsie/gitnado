/**
 * A commit must refresh the repo it ran IN, not whichever tab is active when
 * it lands.
 *
 * `handleCommit` already captures the repo path before the create_commit await
 * (for the ref lock), but the follow-up window `repository-refresh` went out
 * bare. The host falls back to refreshing the ACTIVE repository when the event
 * names no repo, so a user who switched tabs during the IPC round-trip left the
 * committed repo stale — graph, branch list and badges all unchanged until the
 * file watcher happened to notice — while an unrelated repo got a pointless
 * full refresh. The same hole existed one hop out: the panel's `commit-created`
 * detail carried no repo, so the right panel's re-broadcast could not pin either.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const invoked: string[] = [];

interface Deferred {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
}

/** When set, create_commit blocks on this until the test resolves it. */
let pendingCommit: Deferred | null = null;
/** When set, create_commit rejects with this (the Rust error shape). */
let commitFailure: { code: string; message: string } | null = null;

const COMMIT = { oid: 'abc0000000', shortId: 'abc123d', summary: 's' };

const mockInvoke: MockInvoke = async (command: string) => {
  invoked.push(command);
  if (command === 'plugin:notification|is_permission_granted') return false;
  if (command === 'get_status') return { staged: [], unstaged: [], untracked: [] };
  if (command === 'create_commit') {
    if (pendingCommit) await pendingCommit.promise;
    if (commitFailure) throw commitFailure;
    return COMMIT;
  }
  return null;
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import '../gn-commit-panel.ts';
import type { GnRightPanel } from '../gn-right-panel.ts';
import '../gn-right-panel.ts';
import { resetRefOpLocks } from '../../../utils/ref-lock.ts';
import { uiStore } from '../../../stores/ui.store.ts';

const REPO_A = '/test/repo-a';
const REPO_B = '/test/repo-b';

interface Panel extends HTMLElement {
  repositoryPath: string;
  updateComplete: Promise<unknown>;
}

/** The panel's own live state, which a mid-commit tab switch rebinds. */
interface PanelState {
  summary: string;
  description: string;
  amend: boolean;
  success: string | null;
  error: string | null;
}

function stateOf(el: Panel): PanelState {
  return el as unknown as PanelState;
}

function toasts(): string[] {
  return uiStore.getState().toasts.map((t) => `${t.type}:${t.message}`);
}

type RefreshDetail = { repoPath?: string; source?: string } | undefined;

let refreshes: RefreshDetail[] = [];
const collectRefresh = (e: Event): void => {
  refreshes.push((e as CustomEvent).detail as RefreshDetail);
};

async function renderPanel(): Promise<Panel> {
  const el = await fixture<Panel>(html`
    <gn-commit-panel .repositoryPath=${REPO_A} .stagedCount=${2}></gn-commit-panel>
  `);
  await el.updateComplete;
  (el as unknown as { summary: string }).summary = 'feat: a commit message';
  await el.updateComplete;
  return el;
}

function commitOf(el: Panel): Promise<void> {
  return (el as unknown as { handleCommit: () => Promise<void> }).handleCommit();
}

function makeDeferred(): Deferred {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('gn-commit-panel pins its post-commit refresh to the committed repo', () => {
  beforeEach(() => {
    resetRefOpLocks();
    invoked.length = 0;
    refreshes = [];
    pendingCommit = null;
    commitFailure = null;
    window.addEventListener('repository-refresh', collectRefresh);
  });

  afterEach(() => {
    window.removeEventListener('repository-refresh', collectRefresh);
    resetRefOpLocks();
    pendingCommit = null;
    commitFailure = null;
  });

  it('names the repo the commit ran in', async () => {
    const el = await renderPanel();

    await commitOf(el);

    const pinned = refreshes.filter((d) => d?.source !== 'app-shell');
    expect(pinned, 'the commit must ask for a refresh').to.have.length.greaterThan(0);
    for (const detail of pinned) {
      expect(detail?.repoPath, 'an unpinned refresh lands on whichever tab is active').to.equal(
        REPO_A
      );
    }
  });

  it('keeps the pin when the user switches tabs mid-commit', async () => {
    const el = await renderPanel();
    pendingCommit = makeDeferred();

    const inFlight = commitOf(el);

    // The user Ctrl+Tabs to another repository while create_commit is still out.
    el.repositoryPath = REPO_B;
    await el.updateComplete;

    pendingCommit.resolve(null);
    await inFlight;

    const pinned = refreshes.filter((d) => d?.source !== 'app-shell');
    expect(pinned).to.have.length.greaterThan(0);
    for (const detail of pinned) {
      expect(detail?.repoPath, 'the refresh must follow the commit, not the active tab').to.equal(
        REPO_A
      );
      expect(detail?.repoPath).to.not.equal(REPO_B);
    }
  });

  it('carries the originating repo on commit-created so forwarders stay pinned', async () => {
    const el = await renderPanel();
    const details: Array<{ repositoryPath?: string }> = [];
    el.addEventListener('commit-created', (e) => {
      details.push((e as CustomEvent).detail as { repositoryPath?: string });
    });

    await commitOf(el);

    expect(details, 'a successful commit must announce itself').to.have.length(1);
    expect(details[0]?.repositoryPath).to.equal(REPO_A);
  });

  it('forwards that pin through the right panel re-broadcast', async () => {
    const el = await fixture<GnRightPanel>(html`<gn-right-panel></gn-right-panel>`);
    await el.updateComplete;
    refreshes = [];

    (
      el as unknown as { handleCommitCreated: (e?: Event) => void }
    ).handleCommitCreated(
      new CustomEvent('commit-created', {
        detail: { commit: COMMIT, repositoryPath: REPO_A },
      })
    );

    const pinned = refreshes.filter((d) => d?.source !== 'app-shell');
    expect(pinned, 'the right panel re-broadcasts a refresh of its own').to.have.length(1);
    expect(pinned[0]?.repoPath).to.equal(REPO_A);
  });

  // Guard, not proof: this passes before and after the fix. It exists so the
  // pin cannot be implemented as an unconditional dispatch outside the
  // success branch.
  it('dispatches neither commit-created nor a refresh when the commit fails', async () => {
    const el = await renderPanel();
    commitFailure = { code: 'COMMAND_ERROR', message: 'pre-commit hook rejected' };
    const created: Event[] = [];
    el.addEventListener('commit-created', (e) => created.push(e));

    await commitOf(el);

    expect(created, 'a failed commit created nothing to announce').to.have.length(0);
    expect(refreshes.filter((d) => d?.source !== 'app-shell')).to.have.length(0);
    expect((el as unknown as { error: string | null }).error).to.equal('pre-commit hook rejected');
  });
});

/**
 * Pinning the refresh EVENT was only half of it. The commit panel outlives a
 * repository tab switch — `willUpdate` stashes the outgoing repo's draft in
 * `draftCache` and swaps the incoming repo's draft into the live fields — so
 * the completion path running against whatever repo happens to be on screen
 * wiped an uncommitted draft belonging to a repo that never committed, hung
 * the success banner off it, and left the committed repo's cached draft
 * holding the message it had just committed.
 */
describe('gn-commit-panel pins its post-commit state to the committed repo', () => {
  beforeEach(() => {
    resetRefOpLocks();
    invoked.length = 0;
    refreshes = [];
    pendingCommit = null;
    commitFailure = null;
    uiStore.setState({ toasts: [] });
  });

  afterEach(() => {
    resetRefOpLocks();
    pendingCommit = null;
    commitFailure = null;
    uiStore.setState({ toasts: [] });
  });

  /** Commit in A, switch to B mid-flight and type a draft there, then land. */
  async function commitInAWhileViewingB(el: Panel, bDraft: string): Promise<void> {
    pendingCommit = makeDeferred();
    const inFlight = commitOf(el);

    el.repositoryPath = REPO_B;
    await el.updateComplete;
    stateOf(el).summary = bDraft;
    await el.updateComplete;

    pendingCommit.resolve(null);
    await inFlight;
    await el.updateComplete;
  }

  it("leaves the repo now on screen holding its own draft", async () => {
    const el = await renderPanel();

    await commitInAWhileViewingB(el, 'wip: half-written repo-b message');

    expect(stateOf(el).summary, "repo B's draft was never committed").to.equal(
      'wip: half-written repo-b message'
    );
    expect(stateOf(el).success, 'no banner may claim repo B committed').to.equal(null);
    expect(
      toasts().some((t) => t.startsWith('success:') && t.includes('repo-a')),
      `the result must name the repo it landed in: ${toasts().join(' | ')}`
    ).to.equal(true);
  });

  it('does not hand the committed message back as a draft on return', async () => {
    const el = await renderPanel();

    await commitInAWhileViewingB(el, 'wip: half-written repo-b message');

    el.repositoryPath = REPO_A;
    await el.updateComplete;

    expect(stateOf(el).summary, 'the committed message must not come back').to.equal('');
  });

  it('still clears its own fields when the committed repo is the one on screen', async () => {
    const el = await renderPanel();

    await commitOf(el);
    await el.updateComplete;

    expect(stateOf(el).summary, 'the committed draft is spent').to.equal('');
    expect(stateOf(el).amend).to.equal(false);
    expect(stateOf(el).success).to.contain('abc123d');
    expect(
      toasts().filter((t) => t.startsWith('success:')),
      'the banner already says it — a toast would double-report'
    ).to.have.length(0);
  });

  it('blames the repo that failed, not the tab now on screen', async () => {
    const el = await renderPanel();
    commitFailure = { code: 'COMMAND_ERROR', message: 'pre-commit hook rejected' };
    pendingCommit = makeDeferred();

    const inFlight = commitOf(el);
    el.repositoryPath = REPO_B;
    await el.updateComplete;
    pendingCommit.resolve(null);
    await inFlight;
    await el.updateComplete;

    expect(stateOf(el).error, "repo B's panel must not show repo A's failure").to.equal(null);
    expect(
      toasts().some(
        (t) =>
          t.startsWith('error:') && t.includes('repo-a') && t.includes('pre-commit hook rejected')
      ),
      `the failure must name the repo it happened in: ${toasts().join(' | ')}`
    ).to.equal(true);
  });
});
