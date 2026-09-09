/**
 * Right-clicking a commit has to move the WHOLE selection, not just the
 * primary one.
 *
 * `handleContextMenu` used to set only `selectedNode`. Everything the graph
 * actually paints as selected comes from `selectedNodes` (the renderer's
 * `setMultiSelection`), and the `commits` array on `commit-selected` is built
 * from the same set — so right-clicking commit C while commit A was selected
 * left the highlight on A while the context menu and the details panel both
 * named C. `lastClickedNode` (the Shift+click range anchor) was stale too, so
 * the next Shift+click ranged from a commit the user had left two actions ago.
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
import { expect, fixture, html } from '@open-wc/testing';
import type { Commit } from '../../../types/git.types.ts';
import '../lv-graph-canvas.ts';
import type { LvGraphCanvas } from '../lv-graph-canvas.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

const REPO_PATH = '/test/repo/context-menu-selection';

function makeCommit(oid: string, summary: string, parentIds: string[], timestamp: number): Commit {
  return {
    oid,
    shortId: oid.substring(0, 7),
    message: summary,
    summary,
    body: '',
    author: { name: 'Test Author', email: 'test@example.com', timestamp },
    committer: { name: 'Test Author', email: 'test@example.com', timestamp },
    parentIds,
    timestamp,
  };
}

const commitA = makeCommit('aaaaaaa111111111111111111111111111111111', 'Commit A', [], 1700000000);
const commitB = makeCommit('bbbbbbb222222222222222222222222222222222', 'Commit B', [commitA.oid], 1700001000);
const commitC = makeCommit('ccccccc333333333333333333333333333333333', 'Commit C', [commitB.oid], 1700002000);

/** An oid the component never loaded, so `realCommits` has no entry for it. */
const UNKNOWN_OID = 'fffffff999999999999999999999999999999999';

interface HitTestResultLike {
  type: string;
  node?: unknown;
  distance: number;
}

interface Harness {
  el: LvGraphCanvas;
  /** What the stubbed hitTest reports under the cursor for the next event. */
  setHit: (oid: string | null) => void;
  /** Look a laid-out node up by oid. */
  nodeFor: (oid: string) => any;
  rightClick: () => Promise<void>;
  click: (modifiers?: { ctrlKey?: boolean; shiftKey?: boolean }) => Promise<void>;
  selectedOids: () => string[];
  primaryOid: () => string | null;
  anchorOid: () => string | null;
  rendererOids: () => string[];
}

async function mountCanvas(): Promise<Harness> {
  mockInvoke = async (command: string) => {
    switch (command) {
      case 'get_commit_history':
        return [commitC, commitB, commitA];
      case 'get_commit_total':
        return 3;
      case 'get_refs_by_commit':
        return {};
      case 'detect_github_repo':
        return null;
      case 'get_commits_stats':
      case 'get_commits_signatures':
      case 'search_commits':
        return [];
      default:
        return null;
    }
  };

  const el = await fixture<LvGraphCanvas>(
    html`<lv-graph-canvas .repositoryPath=${REPO_PATH} .commitCount=${100}></lv-graph-canvas>`
  );
  await el.updateComplete;

  // firstUpdated() creates the renderer and attaches the listeners
  // asynchronously, and the layout lands after get_commit_history resolves —
  // one tick is not enough. Poll until both exist.
  const deadline = Date.now() + 4000;
  while (!(el as any).renderer || (el as any).sortedNodesByRow.length < 3) {
    if (Date.now() > deadline) throw new Error('graph never finished laying out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await el.updateComplete;

  // Never report a ref label under the cursor — this suite is about commits.
  (el as any).renderer.getRefLabelAtPoint = () => null;

  const nodeFor = (oid: string): any =>
    (el as any).sortedNodesByRow.find((n: any) => n.oid === oid) ?? null;

  let hit: HitTestResultLike = { type: 'none', distance: Infinity };
  (el as any).hitTest = (): HitTestResultLike => hit;

  const setHit = (oid: string | null): void => {
    if (oid === null) {
      hit = { type: 'none', distance: Infinity };
      return;
    }
    const node = nodeFor(oid) ?? { ...nodeFor(commitC.oid), oid };
    hit = { type: 'node', node, distance: 0 };
  };

  const canvas = el.shadowRoot!.querySelector('canvas');
  expect(canvas, 'the canvas must be rendered').to.not.be.null;

  const dispatch = async (type: string, init: MouseEventInit = {}): Promise<void> => {
    canvas!.dispatchEvent(new MouseEvent(type, { clientX: 40, clientY: 40, bubbles: true, ...init }));
    await el.updateComplete;
  };

  return {
    el,
    setHit,
    nodeFor,
    rightClick: () => dispatch('contextmenu'),
    click: (modifiers = {}) => dispatch('click', modifiers),
    selectedOids: () => Array.from((el as any).selectedNodes as Set<string>),
    primaryOid: () => ((el as any).selectedNode?.oid as string) ?? null,
    anchorOid: () => ((el as any).lastClickedNode?.oid as string) ?? null,
    rendererOids: () => Array.from((el as any).renderer.selectedOids as Set<string>),
  };
}

describe('lv-graph-canvas right-click selection', () => {
  it('replaces the previous selection when right-clicking another commit', async () => {
    const h = await mountCanvas();

    h.el.selectCommit(commitA.oid);
    expect(h.selectedOids(), 'precondition: A is the whole selection').to.deep.equal([commitA.oid]);

    h.setHit(commitC.oid);
    await h.rightClick();

    expect(
      h.selectedOids(),
      'the right-clicked commit must become the selection, not just the primary',
    ).to.deep.equal([commitC.oid]);
    expect(h.primaryOid()).to.equal(commitC.oid);
  });

  it('paints the highlight on the commit the menu is for', async () => {
    const h = await mountCanvas();

    h.el.selectCommit(commitA.oid);
    h.setHit(commitC.oid);
    await h.rightClick();

    expect(
      h.rendererOids(),
      'the graph must highlight the commit whose context menu just opened',
    ).to.deep.equal([commitC.oid]);
    expect((h.el as any).renderer.selectedOid).to.equal(commitC.oid);
  });

  it('carries the right-clicked commit in the multi-select payload', async () => {
    const h = await mountCanvas();

    h.el.selectCommit(commitA.oid);

    const selections: CustomEvent[] = [];
    h.el.addEventListener('commit-selected', (e) => selections.push(e as CustomEvent));

    h.setHit(commitC.oid);
    await h.rightClick();

    expect(selections.length, 'right-click must announce the new selection').to.equal(1);
    const detail = selections[0].detail as { commit: Commit; commits: Commit[] };
    expect(detail.commit.oid).to.equal(commitC.oid);
    expect(
      detail.commits.map((c) => c.oid),
      'commits[] must agree with commit — not still list the old selection',
    ).to.deep.equal([commitC.oid]);
  });

  it('keeps an existing multi-selection and moves the anchor into it', async () => {
    const h = await mountCanvas();

    h.setHit(commitC.oid);
    await h.click();
    h.setHit(commitB.oid);
    await h.click({ ctrlKey: true });

    expect(h.selectedOids().sort(), 'precondition: B and C are both selected').to.deep.equal(
      [commitB.oid, commitC.oid].sort()
    );
    expect(h.anchorOid(), 'precondition: the anchor is the last Ctrl+clicked commit').to.equal(commitB.oid);

    h.setHit(commitC.oid);
    await h.rightClick();

    expect(
      h.selectedOids().sort(),
      'right-clicking inside a deliberate multi-selection must not collapse it',
    ).to.deep.equal([commitB.oid, commitC.oid].sort());
    expect(h.primaryOid()).to.equal(commitC.oid);
    expect(h.anchorOid(), 'the anchor follows the commit the user just right-clicked').to.equal(commitC.oid);
  });

  it('ranges from the right-clicked commit on a later Shift+click', async () => {
    const h = await mountCanvas();

    h.el.selectCommit(commitA.oid);
    h.setHit(commitC.oid);
    await h.rightClick();

    h.setHit(commitA.oid);
    await h.click({ shiftKey: true });

    const selected = h.selectedOids();
    expect(selected.length, 'the range must run from C down to A, not A to A').to.equal(3);
    expect(selected).to.include(commitA.oid);
    expect(selected).to.include(commitB.oid);
    expect(selected).to.include(commitC.oid);
  });

  it('changes nothing when the right-click misses a commit', async () => {
    const h = await mountCanvas();

    h.el.selectCommit(commitA.oid);

    const selections: CustomEvent[] = [];
    const menus: CustomEvent[] = [];
    h.el.addEventListener('commit-selected', (e) => selections.push(e as CustomEvent));
    h.el.addEventListener('commit-context-menu', (e) => menus.push(e as CustomEvent));

    // Empty space.
    h.setHit(null);
    await h.rightClick();

    // A laid-out node whose commit was never loaded.
    h.setHit(UNKNOWN_OID);
    await h.rightClick();

    expect(h.selectedOids(), 'a miss must leave the selection alone').to.deep.equal([commitA.oid]);
    expect(h.primaryOid()).to.equal(commitA.oid);
    expect(selections.length, 'a miss announces no selection change').to.equal(0);
    expect(menus.length, 'a miss opens no commit context menu').to.equal(0);
  });
});


/**
 * A multi-selection has to be AUDIBLE, not just painted.
 *
 * The live region named only the primary commit, so Ctrl+clicking a second,
 * third and fourth commit announced four ordinary single selections — the size
 * of the set the context menu's batch actions run over was invisible to a
 * screen reader.
 */
describe('lv-graph-canvas multi-selection announcement', () => {
  const statusText = (h: Harness): string =>
    h.el.shadowRoot!.querySelector('[role="status"]')?.textContent?.trim() ?? '';

  it('names only the commit for a single selection', async () => {
    const h = await mountCanvas();

    h.setHit(commitC.oid);
    await h.click();

    expect(statusText(h)).to.contain('Commit C');
    expect(statusText(h), 'one commit is not a set').to.not.contain('selected');
  });

  it('leads with the count once a second commit is Ctrl+clicked', async () => {
    const h = await mountCanvas();

    h.setHit(commitC.oid);
    await h.click();
    h.setHit(commitB.oid);
    await h.click({ ctrlKey: true });

    expect(statusText(h)).to.contain('2 commits selected');
    expect(statusText(h), 'the primary is still named after the count').to.contain('Commit B');
  });

  it('counts a Shift+click range', async () => {
    const h = await mountCanvas();

    h.setHit(commitC.oid);
    await h.click();
    h.setHit(commitA.oid);
    await h.click({ shiftKey: true });

    expect(statusText(h)).to.contain('3 commits selected');
  });

  it('drops the count when the selection falls back to one commit', async () => {
    const h = await mountCanvas();

    h.setHit(commitC.oid);
    await h.click();
    h.setHit(commitB.oid);
    await h.click({ ctrlKey: true });
    expect(statusText(h)).to.contain('2 commits selected');

    // Ctrl+click the same commit again to deselect it.
    await h.click({ ctrlKey: true });

    expect(h.selectedOids(), 'precondition: one commit left').to.have.length(1);
    expect(statusText(h)).to.not.contain('selected');
  });
});
