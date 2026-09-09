/**
 * Graph column geometry.
 *
 * The lane area of the commit graph used to be as wide as its lane count:
 * a repository with dozens of unmerged branches pushed the commit message,
 * author and stats columns off the right edge of the canvas, and nothing
 * could scroll them back into view. The graph now lives in a bounded
 * column that scrolls horizontally on its own, and every text column is
 * anchored to that column's right edge instead of to the lane count.
 *
 * Coordinate model (all values in CSS pixels):
 *
 * - The lanes are laid out mirrored: lane 0 (the mainline) is the rightmost
 *   drawn column and higher lanes extend to the left, so the most important
 *   lanes sit next to the commit message.
 * - `scrollLeft` is a normal left-to-right scroll offset over the full lane
 *   strip: 0 shows the leftmost (highest-numbered) lanes, `maxScrollLeft`
 *   shows lane 0 against the column's right edge. The "home" position is
 *   `maxScrollLeft`; callers keep the view pinned there while the lane
 *   count grows (see `reconcileScrollLeft`).
 * - The screen x of a lane is `left + (maxLane - lane) * laneWidth +
 *   laneWidth / 2 - scrollLeft`, which is exactly the spatial index's graph
 *   coordinate minus the scroll offset.
 */

/** Fewest lanes the column keeps visible, whatever the text columns need */
export const MIN_VISIBLE_LANES = 3;

/** Share of the canvas width the column takes when the user has not sized it */
export const AUTO_GRAPH_COLUMN_SHARE = 0.35;

export interface GraphColumnParams {
  /** Highest lane number in the layout */
  maxLane: number;
  /** Width of one lane in pixels */
  laneWidth: number;
  /** Screen x of the column's left edge */
  left: number;
  /** Width the user (or the automatic default) asked for */
  preferredWidth: number;
  /**
   * Hard cap that keeps the text columns at their minimum widths. May be
   * smaller than `MIN_VISIBLE_LANES` lanes on tiny canvases; the lane
   * minimum wins then.
   */
  maxWidth: number;
}

export interface GraphColumnLayout {
  /** Screen x of the column's left edge */
  left: number;
  /** Screen x of the column's right edge (text columns start after this) */
  right: number;
  /** On-screen width of the lane area */
  width: number;
  /** Width of every lane laid side by side */
  fullLaneWidth: number;
  /** Largest valid `scrollLeft`; 0 when every lane fits */
  maxScrollLeft: number;
}

/**
 * Size the graph column. The column hugs the lanes when they fit, so
 * narrow graphs look exactly as they did before the cap existed.
 */
export function computeGraphColumnLayout(params: GraphColumnParams): GraphColumnLayout {
  const { maxLane, laneWidth, left, preferredWidth, maxWidth } = params;
  const fullLaneWidth = (Math.max(0, maxLane) + 1) * laneWidth;
  const minWidth = Math.min(fullLaneWidth, MIN_VISIBLE_LANES * laneWidth);
  const capped = Math.min(fullLaneWidth, preferredWidth, maxWidth);
  const width = Math.max(minWidth, Math.floor(capped));

  return {
    left,
    right: left + width,
    width,
    fullLaneWidth,
    maxScrollLeft: Math.max(0, fullLaneWidth - width),
  };
}

/** Clamp a scroll offset into the column's valid range */
export function clampScrollLeft(layout: GraphColumnLayout, scrollLeft: number): number {
  if (!Number.isFinite(scrollLeft)) return layout.maxScrollLeft;
  return Math.max(0, Math.min(scrollLeft, layout.maxScrollLeft));
}

/**
 * Carry a scroll offset across a layout change. A view parked at the home
 * position (lane 0 against the right edge) stays there even when more
 * lanes arrive, because that is where the user expects the mainline; any
 * other offset is scaled (for zoom changes) and clamped.
 *
 * @param previousMaxScrollLeft The old layout's `maxScrollLeft`
 * @param scaleX Ratio of new to old lane width (1 when unchanged)
 */
export function reconcileScrollLeft(
  layout: GraphColumnLayout,
  scrollLeft: number,
  previousMaxScrollLeft: number,
  scaleX = 1
): number {
  const wasHome = scrollLeft >= previousMaxScrollLeft - 0.5;
  if (wasHome) return layout.maxScrollLeft;
  return clampScrollLeft(layout, scrollLeft * scaleX);
}

/** Screen x of a lane's centre for the given scroll offset */
export function laneScreenX(
  layout: GraphColumnLayout,
  laneWidth: number,
  maxLane: number,
  lane: number,
  scrollLeft: number
): number {
  return layout.left + (maxLane - lane) * laneWidth + laneWidth / 2 - scrollLeft;
}

/**
 * How many whole lanes are scrolled out of view on each side. Drives the
 * "N more" hints in the column header.
 */
export function hiddenLaneCounts(
  layout: GraphColumnLayout,
  laneWidth: number,
  scrollLeft: number
): { left: number; right: number } {
  if (layout.maxScrollLeft === 0 || laneWidth <= 0) return { left: 0, right: 0 };
  const clamped = clampScrollLeft(layout, scrollLeft);
  return {
    left: Math.floor(clamped / laneWidth + 1e-6),
    right: Math.floor((layout.maxScrollLeft - clamped) / laneWidth + 1e-6),
  };
}

/** Whether a screen x falls inside the column (where lanes are painted) */
export function isInsideGraphColumn(layout: GraphColumnLayout, x: number): boolean {
  return x >= layout.left && x <= layout.right;
}
