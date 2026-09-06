/**
 * lv-graph-canvas announces changes to its loaded commit/ref set.
 *
 * app-shell used to call getLoadedCommits() and getTagTips() from inside its
 * render(), copying up to a full page of commits and walking the whole ref map
 * on every update. It now mirrors both into state and refreshes that mirror
 * from the `graph-commits-changed` event this component fires — so the event
 * has to fire on every path that changes those two structures, or the palette
 * and the export dialog go stale.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import type { Commit, RefsByCommit } from '../../../types/git.types.ts';
import '../lv-graph-canvas.ts';
import type { LvGraphCanvas } from '../lv-graph-canvas.ts';
import { clearGraphCacheForTests } from '../lv-graph-canvas.ts';

const REPO_PATH = '/test/commits-changed-repo';

function makeCommit(oid: string, summary: string, parents: string[] = []): Commit {
  return {
    oid,
    shortId: oid.substring(0, 7),
    message: summary,
    summary,
    body: '',
    author: { name: 'A', email: 'a@example.com', timestamp: 1700000000 },
    committer: { name: 'A', email: 'a@example.com', timestamp: 1700000000 },
    parentIds: parents,
    timestamp: 1700000000,
  };
}

const commitA = makeCommit('a'.repeat(40), 'First commit');
const commitB = makeCommit('b'.repeat(40), 'Second commit', [commitA.oid]);

const refs: RefsByCommit = {
  [commitB.oid]: [
    { name: 'refs/heads/main', shorthand: 'main', refType: 'localBranch', isHead: true },
    { name: 'refs/tags/v1.0.0', shorthand: 'v1.0.0', refType: 'tag', isHead: false },
  ],
  [commitA.oid]: [
    { name: 'refs/tags/v0.9.0', shorthand: 'v0.9.0', refType: 'tag', isHead: false },
  ],
};

function setupMocks(commits: Commit[]): void {
  mockInvoke = async (command: string) => {
    switch (command) {
      case 'get_commit_history':
        return commits;
      case 'get_commit_total':
        return commits.length;
      case 'get_refs_by_commit':
        return refs;
      default:
        return null;
    }
  };
}

async function renderCanvas(): Promise<{ el: LvGraphCanvas; events: () => number }> {
  let count = 0;
  const el = await fixture<LvGraphCanvas>(
    html`<lv-graph-canvas
      .repositoryPath=${REPO_PATH}
      .commitCount=${1000}
      @graph-commits-changed=${() => { count++; }}
    ></lv-graph-canvas>`
  );
  await loaded(el, 2);
  return { el, events: () => count };
}

/**
 * Wait for a load to land. The commit map is filled and the refs assigned in
 * one synchronous block with the event queued a microtask behind them, so a
 * populated map followed by any await means both are in place and the event
 * has fired.
 */
async function loaded(el: LvGraphCanvas, commitCount: number): Promise<void> {
  await waitUntil(
    () => el.getLoadedCommits().length === commitCount,
    `the graph to load ${commitCount} commits`,
  );
  await el.updateComplete;
}

describe('lv-graph-canvas graph-commits-changed', () => {
  beforeEach(() => {
    clearGraphCacheForTests();
    setupMocks([commitB, commitA]);
    try {
      localStorage.removeItem(`leviathan-hidden-branches-${REPO_PATH}`);
    } catch {
      // Ignore
    }
  });

  it('fires once the initial load has populated the commits and refs', async () => {
    const { el, events } = await renderCanvas();

    expect(events()).to.be.greaterThan(0);
    expect(el.getLoadedCommits()).to.have.length(2);
    expect(el.getTagTips().map((t) => t.name)).to.deep.equal(['v0.9.0', 'v1.0.0']);
  });

  it('fires again when a refresh reloads the graph', async () => {
    const { el, events } = await renderCanvas();
    const before = events();

    setupMocks([commitB, commitA, makeCommit('c'.repeat(40), 'Third commit')]);
    el.refresh();
    await loaded(el, 3);

    expect(events()).to.be.greaterThan(before);
    expect(el.getLoadedCommits()).to.have.length(3);
  });

  it('coalesces bursts into a single dispatch per microtask', async () => {
    const { el, events } = await renderCanvas();
    const before = events();

    const notify = (el as unknown as { notifyLoadedCommitsChanged: () => void });
    notify.notifyLoadedCommitsChanged();
    notify.notifyLoadedCommitsChanged();
    notify.notifyLoadedCommitsChanged();
    await Promise.resolve();
    await Promise.resolve();

    expect(events()).to.equal(before + 1);
  });
});
