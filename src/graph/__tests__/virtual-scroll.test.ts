/**
 * Unit tests for the virtual scrolling system: edge visibility queries over
 * the numeric edge index, and direct (momentum-free) wheel scrolling.
 */
import { expect } from '@open-wc/testing';
import { VirtualScrollManager, ScrollStateManager, type Viewport } from '../virtual-scroll.ts';
import {
  assignLanes,
  type GraphCommit,
  type GraphLayout,
  type LayoutEdge,
  type LayoutNode,
} from '../lane-assignment.ts';

function makeCommit(oid: string, parentIds: string[], timestamp: number): GraphCommit {
  return { oid, parentIds, timestamp, message: `Commit ${oid}`, author: 'Test' };
}

/** Linear chain of n commits, c0 (newest tip) ... c{n-1} (root) */
function makeChain(n: number): GraphCommit[] {
  const commits: GraphCommit[] = [];
  for (let i = 0; i < n; i++) {
    commits.push(makeCommit(`c${i}`, i < n - 1 ? [`c${i + 1}`] : [], (n - i) * 1000));
  }
  return commits;
}

describe('VirtualScrollManager', () => {
  const ROW_HEIGHT = 22;

  function makeManager(commits: GraphCommit[]): VirtualScrollManager {
    const manager = new VirtualScrollManager({
      rowHeight: ROW_HEIGHT,
      laneWidth: 14,
      padding: 20,
      overscanRows: 2,
    });
    manager.setLayout(assignLanes(commits, { headOid: commits[0]?.oid }));
    return manager;
  }

  it('returns only nodes and edges near the viewport', () => {
    const manager = makeManager(makeChain(100));

    const data = manager.getRenderData({
      scrollTop: 0,
      scrollLeft: 0,
      width: 800,
      height: 10 * ROW_HEIGHT,
    });

    // ~10 visible rows + 2 overscan + padding slack, far fewer than 100
    expect(data.nodes.length).to.be.greaterThan(5);
    expect(data.nodes.length).to.be.lessThan(20);
    // Linear chain: an edge is visible iff it touches the visible rows
    expect(data.edges.length).to.be.greaterThan(0);
    expect(data.edges.length).to.be.lessThan(20);
  });

  it('includes long edges that span across the viewport', () => {
    // c0 tip merges c50 directly: edge spans rows 0..~50
    const commits = makeChain(100);
    commits[0] = makeCommit('c0', ['c1', 'c50'], 100 * 1000);
    const manager = makeManager(commits);

    // Scroll to the middle: rows ~20-30 visible; the long c0->c50 edge
    // spans across them and must be returned even though neither endpoint
    // is visible
    const data = manager.getRenderData({
      scrollTop: 25 * ROW_HEIGHT,
      scrollLeft: 0,
      width: 800,
      height: 5 * ROW_HEIGHT,
    });

    const longEdge = data.edges.find((e) => e.fromOid === 'c50' && e.toOid === 'c0');
    expect(longEdge).to.not.be.undefined;
  });

  it('returns edges below the viewport start but not past its end', () => {
    const manager = makeManager(makeChain(100));

    const data = manager.getRenderData({
      scrollTop: 50 * ROW_HEIGHT,
      scrollLeft: 0,
      width: 800,
      height: 10 * ROW_HEIGHT,
    });

    for (const edge of data.edges) {
      const minRow = Math.min(edge.fromRow, edge.toRow);
      const maxRow = Math.max(edge.fromRow, edge.toRow);
      // Every returned edge intersects the (overscanned) visible range
      expect(maxRow).to.be.greaterThan(40);
      expect(minRow).to.be.lessThan(70);
    }
  });
});

describe('ScrollStateManager', () => {
  it('applies wheel deltas immediately with clamping', () => {
    const changes: Array<{ top: number; left: number }> = [];
    const manager = new ScrollStateManager((top, left) => changes.push({ top, left }));

    manager.handleWheel(10, 30, 100, 200);
    expect(manager.getScroll()).to.deep.equal({ scrollTop: 30, scrollLeft: 10 });
    expect(changes).to.have.length(1);

    // Clamp at max
    manager.handleWheel(500, 500, 100, 200);
    expect(manager.getScroll()).to.deep.equal({ scrollTop: 200, scrollLeft: 100 });

    // Clamp at 0
    manager.handleWheel(-999, -999, 100, 200);
    expect(manager.getScroll()).to.deep.equal({ scrollTop: 0, scrollLeft: 0 });
  });

  it('does not keep scrolling after the wheel event (no synthetic momentum)', async () => {
    const manager = new ScrollStateManager();
    manager.handleWheel(0, 50, 1000, 1000);
    const after = manager.getScroll();

    // Wait a few frames — position must not drift
    await new Promise((r) => setTimeout(r, 100));
    expect(manager.getScroll()).to.deep.equal(after);
    manager.destroy();
  });
});

describe('VirtualScrollManager virtual total rows', () => {
  const ROW_HEIGHT = 22;
  const PADDING = 20;

  function makeManager(loadedRows: number): VirtualScrollManager {
    const manager = new VirtualScrollManager({
      rowHeight: ROW_HEIGHT,
      laneWidth: 14,
      padding: PADDING,
      overscanRows: 2,
    });
    manager.setLayout(assignLanes(makeChain(loadedRows)));
    return manager;
  }

  it('extends the content height to the virtual total', () => {
    const manager = makeManager(10);
    expect(manager.getContentSize().height).to.equal(10 * ROW_HEIGHT + PADDING * 2);

    manager.setVirtualTotalRows(500);
    expect(manager.getContentSize().height).to.equal(500 * ROW_HEIGHT + PADDING * 2);
  });

  it('never shrinks below the loaded rows', () => {
    const manager = makeManager(10);
    manager.setVirtualTotalRows(5); // stale/smaller total
    expect(manager.getContentSize().height).to.equal(10 * ROW_HEIGHT + PADDING * 2);
  });

  it('clearing the virtual total restores the loaded height', () => {
    const manager = makeManager(10);
    manager.setVirtualTotalRows(500);
    manager.setVirtualTotalRows(null);
    expect(manager.getContentSize().height).to.equal(10 * ROW_HEIGHT + PADDING * 2);
  });

  it('does not render rows in the unloaded region', () => {
    const manager = makeManager(10);
    manager.setVirtualTotalRows(500);

    // Viewport scrolled deep into the unloaded region
    const data = manager.getRenderData({
      scrollTop: 300 * ROW_HEIGHT,
      scrollLeft: 0,
      width: 800,
      height: 10 * ROW_HEIGHT,
    });
    expect(data.nodes).to.have.length(0);
    expect(data.edges).to.have.length(0);
  });
});

/**
 * The graph is drawn mirrored — lane 0 (the HEAD mainline) sits at the RIGHT
 * edge of the graph and higher lanes extend left — so the visible range has to
 * be converted out of drawn-column space before anything is culled by lane.
 */
describe('VirtualScrollManager wide-graph lane culling', () => {
  const ROW_HEIGHT = 22;
  const LANE_WIDTH = 14;
  const PADDING = 20;
  const MAX_LANE = 60;
  const VIEW_W = 400;
  const CONTENT_W = (MAX_LANE + 1) * LANE_WIDTH + PADDING * 2;
  const SCROLL_RIGHT = CONTENT_W - VIEW_W; // scrolled fully right, to the message column

  /**
   * Wide layout: rows alternate between the mainline (lane 0, drawn at the
   * right of the mirrored graph) and a far side branch (lane maxLane, drawn at
   * the far left), each with a straight edge to the previous row in its lane.
   */
  function makeWideLayout(rows: number, maxLane: number): GraphLayout {
    const nodes = new Map<string, LayoutNode>();
    const edges: LayoutEdge[] = [];

    for (let row = 0; row < rows; row++) {
      const lane = row % 2 === 0 ? 0 : maxLane;
      const colorIndex = row % 2 === 0 ? 0 : 1;
      const oid = `n${row}`;
      nodes.set(oid, {
        oid,
        row,
        lane,
        commit: {
          oid,
          parentIds: [],
          timestamp: rows - row,
          message: `Commit ${row}`,
          author: 'Test',
        },
        childLanes: [],
        parentLanes: [],
        colorIndex,
        hasMissingParents: false,
      });
      if (row >= 2) {
        edges.push({
          fromOid: oid,
          toOid: `n${row - 2}`,
          fromRow: row,
          toRow: row - 2,
          fromLane: lane,
          toLane: lane,
          isMerge: false,
          colorIndex,
        });
      }
    }

    return { nodes, edges, maxLane, totalRows: rows };
  }

  function makeManager(rows: number, maxLane: number): VirtualScrollManager {
    const manager = new VirtualScrollManager({
      rowHeight: ROW_HEIGHT,
      laneWidth: LANE_WIDTH,
      padding: PADDING,
      overscanRows: 2,
    });
    manager.setLayout(makeWideLayout(rows, maxLane));
    return manager;
  }

  it('reports the visible range in lane space, not drawn columns', () => {
    const range = makeManager(40, MAX_LANE).getVisibleRange({
      scrollTop: 0,
      scrollLeft: SCROLL_RIGHT,
      width: VIEW_W,
      height: 10 * ROW_HEIGHT,
    });

    // The computed column window is 31..65 (viewport plus the +/-2 overscan and
    // ceil() slack; the graph itself only has drawn columns 0..60). Mirrored
    // back, maxLane - endColumn clamps to lane 0 and maxLane - startColumn
    // gives lane 29.
    expect(range.startLane).to.equal(0);
    expect(range.endLane).to.equal(29);
  });

  it('keeps the mainline visible when scrolled right on a wide graph', () => {
    const data = makeManager(40, MAX_LANE).getRenderData({
      scrollTop: 0,
      scrollLeft: SCROLL_RIGHT,
      width: VIEW_W,
      height: 10 * ROW_HEIGHT,
    });

    expect(data.nodes.some((n) => n.lane === 0)).to.be.true;
    expect(data.edges.length).to.be.greaterThan(0);
    expect(data.edges.every((e) => e.fromLane === 0 && e.toLane === 0)).to.be.true;
  });

  it("returns every visible row's node at any horizontal scroll", () => {
    const manager = makeManager(40, MAX_LANE);

    for (const scrollLeft of [0, 250, SCROLL_RIGHT]) {
      const data = manager.getRenderData({
        scrollTop: 4 * ROW_HEIGHT,
        scrollLeft,
        width: VIEW_W,
        height: 10 * ROW_HEIGHT,
      });

      // A node carries its whole row's text, so no row may be lane-culled
      const expectedRows = data.range.endRow - data.range.startRow + 1;
      expect(data.nodes.length, `scrollLeft ${scrollLeft}`).to.equal(expectedRows);
      expect(new Set(data.nodes.map((n) => n.row)).size).to.equal(expectedRows);
    }
  });

  it('culls the mainline edges when scrolled to the far left of a wide graph', () => {
    const data = makeManager(40, MAX_LANE).getRenderData({
      scrollTop: 0,
      scrollLeft: 0,
      width: VIEW_W,
      height: 10 * ROW_HEIGHT,
    });

    // Only the far side branch is drawn on screen at the left end
    expect(data.edges.length).to.be.greaterThan(0);
    expect(data.edges.every((e) => e.fromLane === MAX_LANE)).to.be.true;
    // ...but the rows themselves still render
    expect(data.nodes.some((n) => n.lane === 0)).to.be.true;
  });

  it('does not cull horizontally when the whole graph fits the viewport', () => {
    const data = makeManager(20, 1).getRenderData({
      scrollTop: 0,
      scrollLeft: 0,
      width: 800,
      height: 10 * ROW_HEIGHT,
    });

    expect(data.nodes.length).to.equal(data.range.endRow - data.range.startRow + 1);
    expect(data.edges.length).to.be.greaterThan(0);
    expect(data.edges.some((e) => e.fromLane === 0)).to.be.true;
    expect(data.edges.some((e) => e.fromLane === 1)).to.be.true;
    expect(
      data.edges.every(
        (e) =>
          Math.min(e.fromRow, e.toRow) <= data.range.endRow &&
          Math.max(e.fromRow, e.toRow) >= data.range.startRow
      )
    ).to.be.true;
  });
});

/**
 * With a bounded graph column the lanes scroll inside the column, so the
 * horizontally visible strip is [scrollLeft, scrollLeft + column width]
 * rather than the whole viewport.
 */
describe('VirtualScrollManager bounded graph column', () => {
  const ROW_HEIGHT = 22;
  const LANE_WIDTH = 16;
  const PADDING = 20;
  const MAX_LANE = 99;
  const COLUMN_W = 20 * LANE_WIDTH;
  const FULL_W = (MAX_LANE + 1) * LANE_WIDTH;
  const HOME = FULL_W - COLUMN_W;

  function makeNode(row: number, lane: number): LayoutNode {
    const oid = `n${row}`;
    return {
      oid,
      row,
      lane,
      commit: { oid, parentIds: [], timestamp: 100 - row, message: `Commit ${row}`, author: 'T' },
      childLanes: [],
      parentLanes: [],
      colorIndex: lane,
      hasMissingParents: false,
    };
  }

  function makeManager(): VirtualScrollManager {
    // One node per row: rows cycle through lanes 0, 50 and 99 with a
    // straight edge back to the previous row in the same lane
    const nodes = new Map<string, LayoutNode>();
    const edges: LayoutEdge[] = [];
    const lanes = [0, 50, MAX_LANE];
    for (let row = 0; row < 30; row++) {
      const lane = lanes[row % 3];
      nodes.set(`n${row}`, makeNode(row, lane));
      if (row >= 3) {
        edges.push({
          fromOid: `n${row}`,
          toOid: `n${row - 3}`,
          fromRow: row,
          toRow: row - 3,
          fromLane: lane,
          toLane: lane,
          isMerge: false,
          colorIndex: lane,
        });
      }
    }
    const manager = new VirtualScrollManager({
      rowHeight: ROW_HEIGHT,
      laneWidth: LANE_WIDTH,
      padding: PADDING,
      overscanRows: 2,
    });
    manager.setLayout({ nodes, edges, maxLane: MAX_LANE, totalRows: 30 });
    return manager;
  }

  function viewport(scrollLeft: number): Viewport {
    return {
      scrollTop: 0,
      scrollLeft,
      width: 1200,
      height: 10 * ROW_HEIGHT,
      graphColumnWidth: COLUMN_W,
    };
  }

  it('culls to the lanes inside the column at the home position', () => {
    const range = makeManager().getVisibleRange(viewport(HOME));

    // Columns 80..99 are on screen (plus 2 of overscan each side):
    // lanes 0..19, widened to 0..21
    expect(range.startLane).to.equal(0);
    expect(range.endLane).to.equal(21);
  });

  it('culls to the far lanes when scrolled fully left', () => {
    const range = makeManager().getVisibleRange(viewport(0));

    expect(range.endLane).to.equal(MAX_LANE);
    expect(range.startLane).to.equal(MAX_LANE - 22);
  });

  it('drops edges of lanes hidden beyond the column', () => {
    const home = makeManager().getRenderData(viewport(HOME));
    expect(home.edges.length).to.be.greaterThan(0);
    expect(home.edges.every((e) => e.fromLane === 0)).to.be.true;

    const left = makeManager().getRenderData(viewport(0));
    expect(left.edges.length).to.be.greaterThan(0);
    expect(left.edges.every((e) => e.fromLane === MAX_LANE)).to.be.true;
  });

  it('still returns every visible row at any scroll', () => {
    const manager = makeManager();
    for (const scrollLeft of [0, HOME / 2, HOME]) {
      const data = manager.getRenderData(viewport(scrollLeft));
      const expectedRows = data.range.endRow - data.range.startRow + 1;
      expect(data.nodes.length, `scrollLeft ${scrollLeft}`).to.equal(expectedRows);
    }
  });

  it('passes the scroll offset through unchanged and keeps offsetX at the padding', () => {
    const data = makeManager().getRenderData(viewport(123));

    expect(data.scrollLeft).to.equal(123);
    expect(data.offsetX).to.equal(PADDING);
  });

  it('falls back to viewport-wide culling without a column width', () => {
    const wide = makeManager().getVisibleRange({
      scrollTop: 0,
      scrollLeft: 0,
      width: 5000,
      height: 10 * ROW_HEIGHT,
    });

    expect(wide.startLane).to.equal(0);
    expect(wide.endLane).to.equal(MAX_LANE);
  });

  describe('scrollToNode', () => {
    it('leaves a lane that already fits alone (no overflow)', () => {
      const manager = new VirtualScrollManager({
        rowHeight: ROW_HEIGHT,
        laneWidth: LANE_WIDTH,
        padding: PADDING,
        overscanRows: 2,
      });
      const nodes = new Map([['n0', makeNode(0, 1)]]);
      manager.setLayout({ nodes, edges: [], maxLane: 1, totalRows: 1 });

      const { scrollLeft } = manager.scrollToNode(makeNode(0, 1), {
        scrollTop: 0,
        scrollLeft: 0,
        width: 800,
        height: 200,
        graphColumnWidth: 2 * LANE_WIDTH,
      });
      expect(scrollLeft).to.equal(0);
    });

    it('brings the mainline to the right edge of the column', () => {
      const { scrollLeft } = makeManager().scrollToNode(makeNode(0, 0), viewport(0), 'end');
      expect(scrollLeft).to.equal(HOME);
    });

    it('brings the far lane to the left edge of the column', () => {
      const { scrollLeft } = makeManager().scrollToNode(
        makeNode(2, MAX_LANE),
        viewport(HOME),
        'start'
      );
      expect(scrollLeft).to.equal(0);
    });

    it('centres a middle lane and clamps into the scroll range', () => {
      const { scrollLeft } = makeManager().scrollToNode(makeNode(1, 50), viewport(HOME));
      // Lane 50 is drawn at column 49; centred means its middle sits at
      // half the column width
      expect(scrollLeft).to.equal(49 * LANE_WIDTH + LANE_WIDTH / 2 - COLUMN_W / 2);

      const clamped = makeManager().scrollToNode(makeNode(0, 0), viewport(0));
      expect(clamped.scrollLeft).to.equal(HOME);
    });
  });
});
