/**
 * lv-graph-canvas: bounded, horizontally scrollable graph column.
 *
 * A repository with dozens of unmerged branches has more lanes than fit
 * the canvas. The lanes must scroll inside their own column while the
 * commit message, refs and stats columns stay on screen, with the
 * scrollbar, wheel, keyboard, resize handle and hit-testing all agreeing
 * on the column's geometry.
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
import type { Commit, RefsByCommit } from '../../../types/git.types.ts';
import type { GraphColumnLayout } from '../../../graph/graph-column.ts';
import type { HitTestResult } from '../../../graph/spatial-index.ts';

import '../lv-graph-canvas.ts';
import type { LvGraphCanvas } from '../lv-graph-canvas.ts';
import { clearGraphCacheForTests } from '../lv-graph-canvas.ts';

const REPO_PATH = '/test/wide-repo';
const COLUMN_STORAGE_KEY = 'gitnado-graph-columns';
const BRANCH_COUNT = 80;

type Internals = {
  layout: { maxLane: number } | null;
  LANE_WIDTH: number;
  PADDING: number;
  HEADER_HEIGHT: number;
  graphColumnWidth: number | null;
  scrollState: { getScroll(): { scrollTop: number; scrollLeft: number } };
  spatialIndex: { hitTest(x: number, y: number): HitTestResult };
  renderer: { getConfig?: unknown; config: { graphColumnWidth: number | null } };
  getGraphColumn(): GraphColumnLayout | null;
  getResizeHandlePositions(): { graphEnd: number; refsEnd: number; statsStart: number } | null;
  hitTest(e: MouseEvent): HitTestResult;
  canvasEl: HTMLCanvasElement;
  hscrollEl?: HTMLDivElement;
  selectedNode: { oid: string } | null;
};

function makeCommit(overrides: Partial<Commit> = {}): Commit {
  return {
    oid: 'abc1234567890abcdef1234567890abcdef123456',
    shortId: 'abc1234',
    message: 'Commit',
    summary: 'Commit',
    body: '',
    author: { name: 'Test Author', email: 'test@example.com', timestamp: 1700000000 },
    committer: { name: 'Test Author', email: 'test@example.com', timestamp: 1700000000 },
    parentIds: [],
    timestamp: 1700000000,
    ...overrides,
  };
}

const ROOT = makeCommit({
  oid: '0'.repeat(40),
  shortId: '0000000',
  summary: 'Root',
  message: 'Root',
  timestamp: 1700000000,
});

/** One root and BRANCH_COUNT tips that all branch straight off it */
function makeWideHistory(): { commits: Commit[]; refs: RefsByCommit } {
  const tips: Commit[] = [];
  const refs: RefsByCommit = {};
  for (let i = 0; i < BRANCH_COUNT; i++) {
    const oid = (i + 1).toString(16).padStart(40, 'a');
    tips.push(
      makeCommit({
        oid,
        shortId: oid.slice(0, 7),
        summary: `Tip ${i}`,
        message: `Tip ${i}`,
        timestamp: 1700100000 - i,
        parentIds: [ROOT.oid],
      })
    );
    refs[oid] = [
      {
        name: `refs/heads/pr-${i}`,
        shorthand: `pr-${i}`,
        refType: 'localBranch',
        isHead: i === 0,
      },
    ];
  }
  return { commits: [...tips, ROOT], refs };
}

const NARROW: Commit[] = [
  makeCommit({ oid: 'b'.repeat(40), shortId: 'bbbbbbb', summary: 'Second', parentIds: ['a'.repeat(40)] }),
  makeCommit({ oid: 'a'.repeat(40), shortId: 'aaaaaaa', summary: 'First' }),
];

function setupMocks(commits: Commit[], refs: RefsByCommit = {}): void {
  mockInvoke = async (command: string) => {
    switch (command) {
      case 'get_commit_history':
        return commits;
      case 'get_commit_total':
        return commits.length;
      case 'get_refs_by_commit':
        return refs;
      case 'get_commits_stats':
      case 'get_commits_signatures':
      case 'search_commits':
        return [];
      default:
        return null;
    }
  };
}

async function renderCanvas(): Promise<{ el: LvGraphCanvas; internals: Internals }> {
  const el = await fixture<LvGraphCanvas>(
    html`<lv-graph-canvas
      style="display: block; width: 1000px; height: 400px"
      .repositoryPath=${REPO_PATH}
      .commitCount=${100}
    ></lv-graph-canvas>`
  );
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 200));
  await el.updateComplete;
  return { el, internals: el as unknown as Internals };
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

function wheel(canvas: HTMLCanvasElement, init: WheelEventInit): void {
  canvas.dispatchEvent(new WheelEvent('wheel', { cancelable: true, bubbles: true, ...init }));
}

describe('lv-graph-canvas graph column', () => {
  beforeEach(() => {
    clearGraphCacheForTests();
    try {
      localStorage.removeItem(COLUMN_STORAGE_KEY);
    } catch {
      // Ignore
    }
  });

  describe('with more lanes than fit', () => {
    let el: LvGraphCanvas;
    let internals: Internals;
    let column: GraphColumnLayout;

    beforeEach(async () => {
      const { commits, refs } = makeWideHistory();
      setupMocks(commits, refs);
      ({ el, internals } = await renderCanvas());
      expect(internals.layout, 'layout').to.not.be.null;
      expect(internals.layout!.maxLane).to.be.at.least(BRANCH_COUNT - 1);
      column = internals.getGraphColumn()!;
      expect(column.maxScrollLeft).to.be.greaterThan(0);
    });

    it('bounds the column so the text columns stay on the canvas', () => {
      const canvasWidth = internals.canvasEl.width / (window.devicePixelRatio || 1);
      expect(column.fullLaneWidth).to.be.greaterThan(canvasWidth);
      expect(column.width).to.be.lessThan(canvasWidth / 2);

      const handles = internals.getResizeHandlePositions()!;
      expect(handles.graphEnd).to.equal(column.right);
      expect(handles.refsEnd).to.be.greaterThan(handles.graphEnd);
      expect(handles.statsStart).to.be.greaterThan(handles.refsEnd);
      expect(handles.statsStart).to.be.lessThan(canvasWidth);
    });

    it('starts parked on the mainline (lane 0 at the right edge)', () => {
      expect(internals.scrollState.getScroll().scrollLeft).to.equal(column.maxScrollLeft);
    });

    it('renders a horizontal scrollbar sized to the column and its lanes', () => {
      const hscroll = el.shadowRoot!.querySelector<HTMLDivElement>('.hscroll-container');
      expect(hscroll).to.not.be.null;
      expect(hscroll!.style.left).to.equal(`${column.left}px`);
      expect(hscroll!.style.width).to.equal(`${column.width}px`);

      const content = hscroll!.querySelector<HTMLDivElement>('.hscroll-content');
      expect(content!.style.width).to.equal(`${column.fullLaneWidth}px`);
      // Native scroll range matches the column's own
      expect(hscroll!.scrollWidth - hscroll!.clientWidth).to.equal(column.maxScrollLeft);
      expect(hscroll!.scrollLeft).to.equal(column.maxScrollLeft);
    });

    it('scrolls the lanes with a sideways wheel and clamps at both ends', async () => {
      wheel(internals.canvasEl, { deltaX: -100 });
      expect(internals.scrollState.getScroll().scrollLeft).to.equal(column.maxScrollLeft - 100);

      wheel(internals.canvasEl, { deltaX: -100000 });
      expect(internals.scrollState.getScroll().scrollLeft).to.equal(0);

      wheel(internals.canvasEl, { deltaX: 100000 });
      expect(internals.scrollState.getScroll().scrollLeft).to.equal(column.maxScrollLeft);

      // The native scrollbar follows
      await nextFrame();
      expect(internals.hscrollEl!.scrollLeft).to.equal(column.maxScrollLeft);
    });

    it('treats shift+wheel reported as a vertical delta as sideways', () => {
      const before = internals.scrollState.getScroll();
      wheel(internals.canvasEl, { deltaY: -60, shiftKey: true });
      const after = internals.scrollState.getScroll();

      expect(after.scrollLeft).to.equal(before.scrollLeft - 60);
      expect(after.scrollTop).to.equal(before.scrollTop);
    });

    it('never scrolls the text columns: a plain wheel only moves rows', () => {
      const before = internals.scrollState.getScroll();
      wheel(internals.canvasEl, { deltaY: 40 });
      const after = internals.scrollState.getScroll();

      expect(after.scrollLeft).to.equal(before.scrollLeft);
      expect(after.scrollTop).to.equal(before.scrollTop + 40);
    });

    it('follows the native horizontal scrollbar', async () => {
      const hscroll = internals.hscrollEl!;
      // Let any programmatic sync settle so the scroll event is treated
      // as the user's
      await nextFrame();
      await nextFrame();

      hscroll.scrollLeft = 48;
      hscroll.dispatchEvent(new Event('scroll'));
      expect(internals.scrollState.getScroll().scrollLeft).to.equal(48);
    });

    it('steps sideways by a few lanes with the arrow keys', () => {
      const step = 3 * internals.LANE_WIDTH;
      internals.canvasEl.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true })
      );
      expect(internals.scrollState.getScroll().scrollLeft).to.equal(column.maxScrollLeft - step);

      internals.canvasEl.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true })
      );
      expect(internals.scrollState.getScroll().scrollLeft).to.equal(column.maxScrollLeft);

      // Arrow keys never touch the row selection
      expect(internals.selectedNode).to.be.null;
    });

    it('only hit-tests lanes inside the column', () => {
      const calls: number[] = [];
      const original = internals.spatialIndex.hitTest.bind(internals.spatialIndex);
      internals.spatialIndex.hitTest = (x: number, y: number) => {
        calls.push(x);
        return original(x, y);
      };

      const rect = internals.canvasEl.getBoundingClientRect();
      const rowY = rect.top + internals.HEADER_HEIGHT + internals.PADDING;

      // Over the avatar/refs columns: a hidden lane may sit "under" here
      internals.hitTest(
        new MouseEvent('mousemove', { clientX: rect.left + column.right + 40, clientY: rowY })
      );
      expect(calls).to.have.length(0);

      // Inside the column
      internals.hitTest(
        new MouseEvent('mousemove', { clientX: rect.left + column.right - 8, clientY: rowY })
      );
      expect(calls).to.have.length(1);
    });

    it('still selects the row when clicking in the message column', () => {
      const rect = internals.canvasEl.getBoundingClientRect();
      const rowY = rect.top + internals.HEADER_HEIGHT + internals.PADDING;
      const result = internals.hitTest(
        new MouseEvent('click', { clientX: rect.left + column.right + 200, clientY: rowY })
      );

      expect(result.type).to.equal('node');
      expect(result.node?.row).to.equal(0);
    });

    it('resizes the column with its handle, persists it and stays parked', async () => {
      const handle = el.shadowRoot!.querySelector<HTMLDivElement>(
        '.resize-handle[title="Resize graph column"]'
      );
      expect(handle).to.not.be.null;
      expect(handle!.style.left).to.equal(`${column.right}px`);

      handle!.dispatchEvent(new MouseEvent('mousedown', { clientX: 300, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 340 }));
      document.dispatchEvent(new MouseEvent('mouseup'));
      await el.updateComplete;

      const widened = internals.getGraphColumn()!;
      expect(internals.graphColumnWidth).to.equal(column.width + 40);
      expect(widened.width).to.equal(column.width + 40);
      expect(internals.renderer.config.graphColumnWidth).to.equal(column.width + 40);
      expect(JSON.parse(localStorage.getItem(COLUMN_STORAGE_KEY)!).graph).to.equal(
        column.width + 40
      );

      // The wider column reveals more lanes on the left; lane 0 stays put
      expect(internals.scrollState.getScroll().scrollLeft).to.equal(widened.maxScrollLeft);
      expect(widened.maxScrollLeft).to.equal(column.maxScrollLeft - 40);

      // DOM follows the new geometry
      const hscroll = el.shadowRoot!.querySelector<HTMLDivElement>('.hscroll-container')!;
      expect(hscroll.style.width).to.equal(`${widened.width}px`);
      expect(handle!.style.left).to.equal(`${widened.right}px`);
    });

    it('never shrinks the column below a few lanes', async () => {
      const handle = el.shadowRoot!.querySelector<HTMLDivElement>(
        '.resize-handle[title="Resize graph column"]'
      )!;
      handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 300, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: -5000 }));
      document.dispatchEvent(new MouseEvent('mouseup'));
      await el.updateComplete;

      expect(internals.getGraphColumn()!.width).to.equal(3 * internals.LANE_WIDTH);
    });

    it('keeps a scrolled-away view in place while resizing the refs column', async () => {
      wheel(internals.canvasEl, { deltaX: -200 });
      const scrolled = internals.scrollState.getScroll().scrollLeft;

      const refsHandle = el.shadowRoot!.querySelectorAll<HTMLDivElement>('.resize-handle')[1];
      refsHandle.dispatchEvent(new MouseEvent('mousedown', { clientX: 500, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 520 }));
      document.dispatchEvent(new MouseEvent('mouseup'));
      await el.updateComplete;

      expect(internals.scrollState.getScroll().scrollLeft).to.equal(scrolled);
    });

    it('keeps the home position across a zoom and scales a scrolled view', async () => {
      el.setZoom(1.5);
      await el.updateComplete;
      const zoomed = internals.getGraphColumn()!;
      expect(internals.scrollState.getScroll().scrollLeft).to.equal(zoomed.maxScrollLeft);

      wheel(internals.canvasEl, { deltaX: -300 });
      const scrolled = internals.scrollState.getScroll().scrollLeft;
      const laneWidthBefore = internals.LANE_WIDTH;

      el.setZoom(1);
      await el.updateComplete;
      const ratio = internals.LANE_WIDTH / laneWidthBefore;
      expect(internals.scrollState.getScroll().scrollLeft).to.be.closeTo(scrolled * ratio, 1);
    });
  });

  describe('with lanes that fit', () => {
    it('renders no horizontal scrollbar and hugs the lanes', async () => {
      setupMocks(NARROW);
      const { el, internals } = await renderCanvas();

      const column = internals.getGraphColumn()!;
      expect(column.maxScrollLeft).to.equal(0);
      expect(column.width).to.equal(column.fullLaneWidth);
      expect(el.shadowRoot!.querySelector('.hscroll-container')).to.be.null;

      // Sideways input is a no-op
      wheel(internals.canvasEl, { deltaX: -100 });
      internals.canvasEl.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true })
      );
      expect(internals.scrollState.getScroll().scrollLeft).to.equal(0);
    });
  });

  describe('persisted column width', () => {
    it('restores the saved graph column width', async () => {
      localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify({ refs: 200, stats: 80, graph: 150 }));
      const { commits, refs } = makeWideHistory();
      setupMocks(commits, refs);
      const { internals } = await renderCanvas();

      expect(internals.graphColumnWidth).to.equal(150);
      expect(internals.getGraphColumn()!.width).to.equal(150);
    });

    it('falls back to the automatic width for older saved settings', async () => {
      localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify({ refs: 200, stats: 80 }));
      const { commits, refs } = makeWideHistory();
      setupMocks(commits, refs);
      const { internals } = await renderCanvas();

      expect(internals.graphColumnWidth).to.be.null;
      expect(internals.getGraphColumn()!.maxScrollLeft).to.be.greaterThan(0);
    });
  });
});
