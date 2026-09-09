/**
 * Unit tests for the graph column geometry: the bounded, horizontally
 * scrollable lane area that keeps the text columns on screen however many
 * lanes the graph has.
 */
import { expect } from '@open-wc/testing';
import {
  AUTO_GRAPH_COLUMN_SHARE,
  MIN_VISIBLE_LANES,
  clampScrollLeft,
  computeGraphColumnLayout,
  hiddenLaneCounts,
  isInsideGraphColumn,
  laneScreenX,
  reconcileScrollLeft,
} from '../graph-column.ts';

const LANE = 16;
const LEFT = 20;

describe('computeGraphColumnLayout', () => {
  it('hugs the lanes when they fit, so narrow graphs are unchanged', () => {
    const layout = computeGraphColumnLayout({
      maxLane: 2,
      laneWidth: LANE,
      left: LEFT,
      preferredWidth: 400,
      maxWidth: 600,
    });

    expect(layout.fullLaneWidth).to.equal(3 * LANE);
    expect(layout.width).to.equal(3 * LANE);
    expect(layout.left).to.equal(LEFT);
    expect(layout.right).to.equal(LEFT + 3 * LANE);
    expect(layout.maxScrollLeft).to.equal(0);
  });

  it('caps a wide graph at the preferred width and exposes the overflow', () => {
    const layout = computeGraphColumnLayout({
      maxLane: 79,
      laneWidth: LANE,
      left: LEFT,
      preferredWidth: 300,
      maxWidth: 600,
    });

    expect(layout.fullLaneWidth).to.equal(80 * LANE);
    expect(layout.width).to.equal(300);
    expect(layout.right).to.equal(LEFT + 300);
    expect(layout.maxScrollLeft).to.equal(80 * LANE - 300);
  });

  it('never exceeds the cap that keeps the text columns on screen', () => {
    const layout = computeGraphColumnLayout({
      maxLane: 79,
      laneWidth: LANE,
      left: LEFT,
      preferredWidth: 900,
      maxWidth: 250,
    });

    expect(layout.width).to.equal(250);
  });

  it('keeps a few lanes visible even when the cap is tiny', () => {
    const layout = computeGraphColumnLayout({
      maxLane: 79,
      laneWidth: LANE,
      left: LEFT,
      preferredWidth: 900,
      maxWidth: 5,
    });

    expect(layout.width).to.equal(MIN_VISIBLE_LANES * LANE);
    expect(layout.maxScrollLeft).to.equal(80 * LANE - MIN_VISIBLE_LANES * LANE);
  });

  it('does not force the minimum on a graph with fewer lanes than it', () => {
    const layout = computeGraphColumnLayout({
      maxLane: 0,
      laneWidth: LANE,
      left: LEFT,
      preferredWidth: 900,
      maxWidth: 5,
    });

    expect(layout.width).to.equal(LANE);
    expect(layout.maxScrollLeft).to.equal(0);
  });

  it('rounds the width down to whole pixels', () => {
    const layout = computeGraphColumnLayout({
      maxLane: 79,
      laneWidth: LANE,
      left: LEFT,
      preferredWidth: 300.7,
      maxWidth: 600,
    });

    expect(layout.width).to.equal(300);
  });

  it('treats a negative maxLane as a single lane', () => {
    const layout = computeGraphColumnLayout({
      maxLane: -1,
      laneWidth: LANE,
      left: LEFT,
      preferredWidth: 300,
      maxWidth: 600,
    });

    expect(layout.fullLaneWidth).to.equal(LANE);
  });

  it('exports the automatic share used for the default width', () => {
    expect(AUTO_GRAPH_COLUMN_SHARE).to.be.greaterThan(0).and.lessThan(1);
  });
});

describe('laneScreenX', () => {
  const layout = computeGraphColumnLayout({
    maxLane: 79,
    laneWidth: LANE,
    left: LEFT,
    preferredWidth: 300,
    maxWidth: 600,
  });

  it('puts lane 0 against the right edge at the home position', () => {
    const x = laneScreenX(layout, LANE, 79, 0, layout.maxScrollLeft);
    expect(x).to.equal(layout.right - LANE / 2);
  });

  it('puts the highest lane against the left edge when scrolled fully left', () => {
    const x = laneScreenX(layout, LANE, 79, 79, 0);
    expect(x).to.equal(layout.left + LANE / 2);
  });

  it('matches the spatial index coordinate minus the scroll offset', () => {
    // The spatial index places lane L at left + (maxLane - L) * lane + lane/2
    const scrollLeft = 123;
    for (const lane of [0, 7, 79]) {
      const indexX = LEFT + (79 - lane) * LANE + LANE / 2;
      expect(laneScreenX(layout, LANE, 79, lane, scrollLeft)).to.equal(indexX - scrollLeft);
    }
  });

  it('is unaffected by scrolling when every lane fits', () => {
    const small = computeGraphColumnLayout({
      maxLane: 1,
      laneWidth: LANE,
      left: LEFT,
      preferredWidth: 300,
      maxWidth: 600,
    });
    expect(laneScreenX(small, LANE, 1, 0, 0)).to.equal(small.right - LANE / 2);
    expect(laneScreenX(small, LANE, 1, 1, 0)).to.equal(small.left + LANE / 2);
  });
});

describe('clampScrollLeft', () => {
  const layout = computeGraphColumnLayout({
    maxLane: 79,
    laneWidth: LANE,
    left: LEFT,
    preferredWidth: 300,
    maxWidth: 600,
  });

  it('clamps into [0, maxScrollLeft]', () => {
    expect(clampScrollLeft(layout, -5)).to.equal(0);
    expect(clampScrollLeft(layout, 50)).to.equal(50);
    expect(clampScrollLeft(layout, 99999)).to.equal(layout.maxScrollLeft);
  });

  it('falls back to the home position for a non-finite value', () => {
    expect(clampScrollLeft(layout, Number.NaN)).to.equal(layout.maxScrollLeft);
  });
});

describe('reconcileScrollLeft', () => {
  const before = computeGraphColumnLayout({
    maxLane: 39,
    laneWidth: LANE,
    left: LEFT,
    preferredWidth: 300,
    maxWidth: 600,
  });
  const after = computeGraphColumnLayout({
    maxLane: 79,
    laneWidth: LANE,
    left: LEFT,
    preferredWidth: 300,
    maxWidth: 600,
  });

  it('keeps a view parked on the mainline parked there as lanes arrive', () => {
    const next = reconcileScrollLeft(after, before.maxScrollLeft, before.maxScrollLeft);
    expect(next).to.equal(after.maxScrollLeft);
  });

  it('treats the very first layout (no previous overflow) as home', () => {
    expect(reconcileScrollLeft(after, 0, 0)).to.equal(after.maxScrollLeft);
  });

  it('keeps a scrolled-away view where it was', () => {
    const next = reconcileScrollLeft(after, 100, before.maxScrollLeft);
    expect(next).to.equal(100);
  });

  it('clamps a scrolled-away view when the graph shrinks', () => {
    const next = reconcileScrollLeft(before, after.maxScrollLeft - 10, after.maxScrollLeft);
    expect(next).to.equal(before.maxScrollLeft);
  });

  it('scales a scrolled-away view with the lane width on zoom', () => {
    const zoomed = computeGraphColumnLayout({
      maxLane: 79,
      laneWidth: LANE * 2,
      left: LEFT,
      preferredWidth: 300,
      maxWidth: 600,
    });
    expect(reconcileScrollLeft(zoomed, 100, after.maxScrollLeft, 2)).to.equal(200);
  });

  it('keeps a home view at home across a zoom', () => {
    const zoomed = computeGraphColumnLayout({
      maxLane: 79,
      laneWidth: LANE * 2,
      left: LEFT,
      preferredWidth: 300,
      maxWidth: 600,
    });
    expect(reconcileScrollLeft(zoomed, after.maxScrollLeft, after.maxScrollLeft, 2)).to.equal(
      zoomed.maxScrollLeft
    );
  });
});

describe('hiddenLaneCounts', () => {
  const layout = computeGraphColumnLayout({
    maxLane: 79,
    laneWidth: LANE,
    left: LEFT,
    preferredWidth: 20 * LANE,
    maxWidth: 600,
  });

  it('reports every overflowing lane on the left at the home position', () => {
    expect(hiddenLaneCounts(layout, LANE, layout.maxScrollLeft)).to.deep.equal({
      left: 60,
      right: 0,
    });
  });

  it('reports the mainline side hidden when scrolled fully left', () => {
    expect(hiddenLaneCounts(layout, LANE, 0)).to.deep.equal({ left: 0, right: 60 });
  });

  it('counts whole lanes only', () => {
    expect(hiddenLaneCounts(layout, LANE, 5 * LANE + 3)).to.deep.equal({
      left: 5,
      right: 54,
    });
  });

  it('reports nothing hidden when every lane fits', () => {
    const small = computeGraphColumnLayout({
      maxLane: 1,
      laneWidth: LANE,
      left: LEFT,
      preferredWidth: 300,
      maxWidth: 600,
    });
    expect(hiddenLaneCounts(small, LANE, 0)).to.deep.equal({ left: 0, right: 0 });
  });
});

describe('isInsideGraphColumn', () => {
  const layout = computeGraphColumnLayout({
    maxLane: 79,
    laneWidth: LANE,
    left: LEFT,
    preferredWidth: 300,
    maxWidth: 600,
  });

  it('accepts the column and its edges, rejects the text columns', () => {
    expect(isInsideGraphColumn(layout, layout.left)).to.be.true;
    expect(isInsideGraphColumn(layout, layout.right)).to.be.true;
    expect(isInsideGraphColumn(layout, layout.left - 1)).to.be.false;
    expect(isInsideGraphColumn(layout, layout.right + 30)).to.be.false;
  });
});
