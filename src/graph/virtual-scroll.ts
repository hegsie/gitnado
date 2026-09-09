/**
 * Virtual Scrolling System for Graph Rendering
 *
 * Only renders visible content plus an overscan buffer.
 * Essential for maintaining 60fps with large graphs.
 */

import type { LayoutNode, LayoutEdge, GraphLayout } from './lane-assignment.ts';
import type { RefsByCommit } from '../types/git.types.ts';

export interface VirtualScrollConfig {
  /** Height of each row in pixels */
  rowHeight: number;
  /** Width of each lane in pixels */
  laneWidth: number;
  /** Padding around the graph */
  padding: number;
  /** Number of rows to render outside viewport (overscan) */
  overscanRows: number;
}

export interface Viewport {
  /** Scroll position from top */
  scrollTop: number;
  /**
   * Horizontal scroll of the graph (lane) column, in pixels over the full
   * lane strip: 0 shows the highest-numbered lanes, the maximum shows
   * lane 0 against the column's right edge. See `graph-column.ts`.
   */
  scrollLeft: number;
  /** Visible width */
  width: number;
  /** Visible height */
  height: number;
  /**
   * On-screen width of the graph column. Lanes outside it are clipped, so
   * horizontal culling uses this instead of `width` when set.
   */
  graphColumnWidth?: number;
}

export interface VisibleRange {
  /** First visible row (inclusive) */
  startRow: number;
  /** Last visible row (inclusive) */
  endRow: number;
  /**
   * First visible lane (inclusive). A lane number, NOT a drawn column — the
   * graph is mirrored, so lane 0 is drawn at the far right.
   */
  startLane: number;
  /** Last visible lane (inclusive). A lane number, not a drawn column. */
  endLane: number;
}

/** Pull request info for graph display */
export interface GraphPullRequest {
  /** PR number */
  number: number;
  /** PR state (open, closed, merged) */
  state: string;
  /** Whether it's a draft */
  draft: boolean;
  /** URL to open in browser */
  url: string;
}

export interface RenderData {
  /** Nodes to render */
  nodes: LayoutNode[];
  /** Edges to render */
  edges: LayoutEdge[];
  /** Visible range */
  range: VisibleRange;
  /**
   * Screen x of the graph column's left edge (the graph padding). Unlike
   * `offsetY` it does NOT include the scroll: the renderer scrolls lanes
   * inside the column using `scrollLeft`.
   */
  offsetX: number;
  /** Vertical offset for rendering (accounts for scroll position) */
  offsetY: number;
  /** Horizontal scroll of the graph column (see `Viewport.scrollLeft`) */
  scrollLeft: number;
  /** Refs by commit OID */
  refsByCommit: RefsByCommit;
  /** Author emails by commit OID for avatar loading */
  authorEmails: Record<string, string>;
  /** Maximum lane in the graph (for label positioning) */
  maxLane: number;
  /** Pull requests by commit SHA (head commit of PR) */
  pullRequestsByCommit?: Record<string, GraphPullRequest[]>;
}

const DEFAULT_CONFIG: VirtualScrollConfig = {
  rowHeight: 22,
  laneWidth: 14,
  padding: 20,
  overscanRows: 15,
};

/**
 * Browsers cap element heights around ~33.5M px; past that the scrollable
 * range silently clamps and deep rows become unreachable. Content height is
 * capped below the browser limit — repos big enough to hit this (~1.3M+
 * commits at default zoom) degrade to a shorter scrollbar instead of a
 * broken one.
 */
const MAX_CONTENT_HEIGHT_PX = 30_000_000;

/**
 * Virtual scroll manager for graph rendering
 */
export class VirtualScrollManager {
  private config: VirtualScrollConfig;
  private layout: GraphLayout | null = null;
  private virtualTotalRows: number | null = null;
  private nodesByRow: Map<number, LayoutNode[]> = new Map();
  // Edges sorted by their min row so visibility queries can early-exit —
  // numeric fields instead of parsed string keys
  private edgeIndex: Array<{ minRow: number; maxRow: number; edge: LayoutEdge }> = [];
  private refsByCommit: RefsByCommit = {};
  private authorEmails: Record<string, string> = {};
  private pullRequestsByCommit: Record<string, GraphPullRequest[]> = {};

  constructor(config: Partial<VirtualScrollConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set refs by commit
   */
  setRefs(refs: RefsByCommit): void {
    this.refsByCommit = refs;
  }

  /**
   * Set author emails by commit OID
   */
  setAuthorEmails(emails: Record<string, string>): void {
    this.authorEmails = emails;
  }

  /**
   * Set pull requests by commit SHA
   */
  setPullRequests(prs: Record<string, GraphPullRequest[]>): void {
    this.pullRequestsByCommit = prs;
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<VirtualScrollConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Set the layout to virtualize
   */
  setLayout(layout: GraphLayout): void {
    this.layout = layout;
    this.buildIndices();
  }

  /**
   * Rows not yet loaded but known to exist (true history total). When set,
   * the content height covers them so the scrollbar reflects the real
   * history length; scrolling into the unloaded region is the caller's cue
   * to load more pages.
   */
  setVirtualTotalRows(totalRows: number | null): void {
    this.virtualTotalRows = totalRows;
  }

  private effectiveTotalRows(): number {
    const loaded = this.layout?.totalRows ?? 0;
    return Math.max(loaded, this.virtualTotalRows ?? 0);
  }

  /**
   * Build row-based indices for fast lookup
   */
  private buildIndices(): void {
    this.nodesByRow.clear();
    this.edgeIndex = [];

    if (!this.layout) return;

    // Index nodes by row
    for (const node of this.layout.nodes.values()) {
      let rowNodes = this.nodesByRow.get(node.row);
      if (!rowNodes) {
        rowNodes = [];
        this.nodesByRow.set(node.row, rowNodes);
      }
      rowNodes.push(node);
    }

    // Index edges by row span, sorted by min row for early-exit queries
    for (const edge of this.layout.edges) {
      this.edgeIndex.push({
        minRow: Math.min(edge.fromRow, edge.toRow),
        maxRow: Math.max(edge.fromRow, edge.toRow),
        edge,
      });
    }
    this.edgeIndex.sort((a, b) => a.minRow - b.minRow);
  }

  /**
   * Calculate total content dimensions
   */
  getContentSize(): { width: number; height: number } {
    if (!this.layout) {
      return { width: 0, height: 0 };
    }

    const width =
      (this.layout.maxLane + 1) * this.config.laneWidth + this.config.padding * 2;
    const height = Math.min(
      this.effectiveTotalRows() * this.config.rowHeight + this.config.padding * 2,
      MAX_CONTENT_HEIGHT_PX
    );

    return { width, height };
  }

  /**
   * Calculate visible range from viewport
   */
  getVisibleRange(viewport: Viewport): VisibleRange {
    if (!this.layout) {
      return { startRow: 0, endRow: 0, startLane: 0, endLane: 0 };
    }

    const { rowHeight, laneWidth, padding, overscanRows } = this.config;

    // Calculate visible rows
    const startRow = Math.max(
      0,
      Math.floor((viewport.scrollTop - padding) / rowHeight) - overscanRows
    );
    const endRow = Math.min(
      this.layout.totalRows - 1,
      Math.ceil((viewport.scrollTop + viewport.height - padding) / rowHeight) + overscanRows
    );

    // Visible drawn columns, measured from the left edge of the graph, +/-2
    // columns of overscan. With a bounded graph column the lanes scroll
    // inside it, so the visible strip is [scrollLeft, scrollLeft + column
    // width]; without one the whole viewport shows lanes.
    let startColumn: number;
    let endColumn: number;
    if (viewport.graphColumnWidth !== undefined) {
      startColumn = Math.floor(viewport.scrollLeft / laneWidth) - 2;
      endColumn = Math.ceil((viewport.scrollLeft + viewport.graphColumnWidth) / laneWidth) + 2;
    } else {
      startColumn = Math.floor((viewport.scrollLeft - padding) / laneWidth) - 2;
      endColumn = Math.ceil((viewport.scrollLeft + viewport.width - padding) / laneWidth) + 2;
    }

    // The graph is mirrored — lane L is DRAWN at column (maxLane - L), lane 0
    // on the right (see renderEdges/renderNodes in canvas-renderer) — so the
    // visible columns are converted back to lanes before anything is culled
    const { maxLane } = this.layout;
    const startLane = Math.max(0, maxLane - endColumn);
    const endLane = Math.min(maxLane, maxLane - startColumn);

    return { startRow, endRow, startLane, endLane };
  }

  /**
   * Get render data for current viewport
   */
  getRenderData(viewport: Viewport): RenderData {
    const range = this.getVisibleRange(viewport);
    const nodes = this.getVisibleNodes(range);
    const edges = this.getVisibleEdges(range);

    return {
      nodes,
      edges,
      range,
      offsetX: this.config.padding,
      offsetY: this.config.padding - viewport.scrollTop,
      scrollLeft: viewport.scrollLeft,
      refsByCommit: this.refsByCommit,
      authorEmails: this.authorEmails,
      maxLane: this.layout?.maxLane ?? 0,
      pullRequestsByCommit: this.pullRequestsByCommit,
    };
  }

  /**
   * Get nodes in visible range.
   *
   * Rows are deliberately NOT culled by lane. A node carries its whole row —
   * avatar, refs, message, stats and time are drawn per-node in fixed columns
   * to the right of the graph, regardless of the node's lane — so dropping a
   * node whose dot is scrolled out of view would blank the commit row (and
   * drop it from the screen-reader mirror). There is exactly one node per row,
   * so the lane test saved nothing anyway.
   */
  private getVisibleNodes(range: VisibleRange): LayoutNode[] {
    const nodes: LayoutNode[] = [];

    for (let row = range.startRow; row <= range.endRow; row++) {
      const rowNodes = this.nodesByRow.get(row);
      if (rowNodes) {
        for (const node of rowNodes) {
          nodes.push(node);
        }
      }
    }

    return nodes;
  }

  /**
   * Get edges that intersect visible range
   */
  private getVisibleEdges(range: VisibleRange): LayoutEdge[] {
    if (!this.layout) return [];

    const edges: LayoutEdge[] = [];

    // Entries are sorted by minRow, so everything after the first entry
    // starting below the viewport can be skipped
    for (const entry of this.edgeIndex) {
      if (entry.minRow > range.endRow) break;
      if (entry.maxRow < range.startRow) continue;

      const minLane = Math.min(entry.edge.fromLane, entry.edge.toLane);
      const maxLane = Math.max(entry.edge.fromLane, entry.edge.toLane);
      if (maxLane >= range.startLane && minLane <= range.endLane) {
        edges.push(entry.edge);
      }
    }

    return edges;
  }

  /**
   * Convert screen coordinates to graph coordinates
   */
  screenToGraph(
    screenX: number,
    screenY: number,
    viewport: Viewport
  ): { row: number; lane: number; x: number; y: number } {
    const graphX = screenX + viewport.scrollLeft - this.config.padding;
    const graphY = screenY + viewport.scrollTop - this.config.padding;

    return {
      row: Math.floor(graphY / this.config.rowHeight),
      lane: Math.floor(graphX / this.config.laneWidth),
      x: graphX,
      y: graphY,
    };
  }

  /**
   * Convert graph coordinates to screen coordinates
   */
  graphToScreen(
    row: number,
    lane: number,
    viewport: Viewport
  ): { x: number; y: number } {
    return {
      x: lane * this.config.laneWidth + this.config.padding - viewport.scrollLeft,
      y: row * this.config.rowHeight + this.config.padding - viewport.scrollTop,
    };
  }

  /**
   * Scroll to bring a specific node into view.
   *
   * Horizontally the node's lane is measured on the mirrored strip (lane 0
   * is the rightmost drawn column) and brought inside the graph column;
   * when every lane already fits, `scrollLeft` is 0.
   */
  scrollToNode(
    node: LayoutNode,
    viewport: Viewport,
    align: 'start' | 'center' | 'end' = 'center'
  ): { scrollTop: number; scrollLeft: number } {
    const { rowHeight, laneWidth, padding } = this.config;
    const maxLane = this.layout?.maxLane ?? 0;
    const nodeY = node.row * rowHeight + padding;
    // Lane offset along the strip, from its left edge
    const laneX = (maxLane - node.lane) * laneWidth;
    const columnWidth = viewport.graphColumnWidth ?? viewport.width - padding * 2;

    let scrollTop: number;
    let scrollLeft: number;

    switch (align) {
      case 'start':
        scrollTop = nodeY - padding;
        scrollLeft = laneX;
        break;
      case 'end':
        scrollTop = nodeY - viewport.height + rowHeight + padding;
        scrollLeft = laneX - columnWidth + laneWidth;
        break;
      case 'center':
      default:
        scrollTop = nodeY - viewport.height / 2;
        scrollLeft = laneX + laneWidth / 2 - columnWidth / 2;
    }

    // Clamp to valid range
    const { height } = this.getContentSize();
    const fullLaneWidth = (maxLane + 1) * laneWidth;
    scrollTop = Math.max(0, Math.min(scrollTop, height - viewport.height));
    scrollLeft = Math.max(0, Math.min(scrollLeft, fullLaneWidth - columnWidth));

    return { scrollTop, scrollLeft };
  }
}

/**
 * Scroll state manager.
 *
 * Wheel deltas are applied directly with no synthetic momentum: trackpads
 * already deliver their own inertia through wheel events, so animating an
 * extra glide on top made scrolling drift after the user stopped (and its
 * per-frame friction decayed twice as fast on 120 Hz displays).
 */
export class ScrollStateManager {
  private scrollTop = 0;
  private scrollLeft = 0;

  private onChange?: (scrollTop: number, scrollLeft: number) => void;

  constructor(onChange?: (scrollTop: number, scrollLeft: number) => void) {
    this.onChange = onChange;
  }

  getScroll(): { scrollTop: number; scrollLeft: number } {
    return { scrollTop: this.scrollTop, scrollLeft: this.scrollLeft };
  }

  setScroll(scrollTop: number, scrollLeft: number): void {
    this.scrollTop = scrollTop;
    this.scrollLeft = scrollLeft;
    this.onChange?.(this.scrollTop, this.scrollLeft);
  }

  /**
   * Apply a wheel delta, clamped to the scrollable area
   */
  handleWheel(deltaX: number, deltaY: number, maxScrollX: number, maxScrollY: number): void {
    this.scrollTop = Math.max(0, Math.min(this.scrollTop + deltaY, maxScrollY));
    this.scrollLeft = Math.max(0, Math.min(this.scrollLeft + deltaX, maxScrollX));
    this.onChange?.(this.scrollTop, this.scrollLeft);
  }

  destroy(): void {
    // Nothing to clean up — kept for API compatibility with callers
  }
}
