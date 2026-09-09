/**
 * Unit tests for canvas-renderer utility functions.
 * Covers sortRefsForDisplay (most important refs shown first when the refs
 * column has limited space), renderer state getters used by graph export,
 * and the avatar cache (LRU + failure retry + fetch opt-out).
 */
import { expect } from '@open-wc/testing';
import { CanvasRenderer, sortRefsForDisplay } from '../canvas-renderer.ts';
import type { RefInfo } from '../../types/git.types.ts';

function makeRef(overrides: Partial<RefInfo>): RefInfo {
  return {
    name: `refs/heads/${overrides.shorthand ?? 'main'}`,
    shorthand: 'main',
    refType: 'localBranch',
    isHead: false,
    ...overrides,
  };
}

describe('sortRefsForDisplay', () => {
  it('returns the same array for 0 or 1 refs', () => {
    expect(sortRefsForDisplay([])).to.deep.equal([]);

    const single = [makeRef({ shorthand: 'main', isHead: true })];
    expect(sortRefsForDisplay(single)).to.deep.equal(single);
  });

  it('puts HEAD branch first', () => {
    const refs = [
      makeRef({ shorthand: 'origin/main', refType: 'remoteBranch', isHead: false }),
      makeRef({ shorthand: 'develop', isHead: false }),
      makeRef({ shorthand: 'main', isHead: true }),
    ];

    const sorted = sortRefsForDisplay(refs);
    expect(sorted[0].shorthand).to.equal('main');
    expect(sorted[0].isHead).to.be.true;
  });

  it('puts local branches before remote branches', () => {
    const refs = [
      makeRef({ shorthand: 'origin/feature/foo', refType: 'remoteBranch' }),
      makeRef({ shorthand: 'feature/foo', refType: 'localBranch' }),
    ];

    const sorted = sortRefsForDisplay(refs);
    expect(sorted[0].refType).to.equal('localBranch');
    expect(sorted[1].refType).to.equal('remoteBranch');
  });

  it('puts remote-only branches before remote duplicates of local branches', () => {
    // Scenario: feature/github-azure-devops-interop (local, HEAD) +
    // origin/feature/github-azure-devops-interop (remote duplicate) +
    // origin/new-nonprod-cert-dv3 (remote-only, no local counterpart)
    const refs = [
      makeRef({
        shorthand: 'feature/github-azure-devops-interop-vhDvn',
        refType: 'localBranch',
        isHead: true,
      }),
      makeRef({
        shorthand: 'origin/feature/github-azure-devops-interop-vhDvn',
        refType: 'remoteBranch',
      }),
      makeRef({
        shorthand: 'origin/new-nonprod-cert-dv3',
        refType: 'remoteBranch',
      }),
    ];

    const sorted = sortRefsForDisplay(refs);

    // HEAD local branch first
    expect(sorted[0].shorthand).to.equal('feature/github-azure-devops-interop-vhDvn');
    expect(sorted[0].isHead).to.be.true;

    // Remote-only branch (dv3) second — this is the crucial fix
    expect(sorted[1].shorthand).to.equal('origin/new-nonprod-cert-dv3');
    expect(sorted[1].refType).to.equal('remoteBranch');

    // Remote duplicate last
    expect(sorted[2].shorthand).to.equal('origin/feature/github-azure-devops-interop-vhDvn');
  });

  it('puts tags after branches', () => {
    const refs = [
      makeRef({ shorthand: 'v1.0.0', refType: 'tag' }),
      makeRef({ shorthand: 'main', refType: 'localBranch' }),
      makeRef({ shorthand: 'origin/main', refType: 'remoteBranch' }),
    ];

    const sorted = sortRefsForDisplay(refs);
    expect(sorted[0].refType).to.equal('localBranch');
    expect(sorted[1].refType).to.equal('remoteBranch');
    expect(sorted[2].refType).to.equal('tag');
  });

  it('within the same priority, shorter names come first', () => {
    const refs = [
      makeRef({ shorthand: 'origin/very-long-branch-name', refType: 'remoteBranch' }),
      makeRef({ shorthand: 'origin/short', refType: 'remoteBranch' }),
    ];

    const sorted = sortRefsForDisplay(refs);
    expect(sorted[0].shorthand).to.equal('origin/short');
    expect(sorted[1].shorthand).to.equal('origin/very-long-branch-name');
  });

  it('handles multiple local branches sorted by length', () => {
    const refs = [
      makeRef({ shorthand: 'feature/very-long-name', refType: 'localBranch' }),
      makeRef({ shorthand: 'main', refType: 'localBranch', isHead: true }),
      makeRef({ shorthand: 'dev', refType: 'localBranch' }),
    ];

    const sorted = sortRefsForDisplay(refs);
    expect(sorted[0].shorthand).to.equal('main'); // HEAD first
    expect(sorted[1].shorthand).to.equal('dev'); // shorter name
    expect(sorted[2].shorthand).to.equal('feature/very-long-name');
  });

  it('does not mutate the original array', () => {
    const refs = [
      makeRef({ shorthand: 'origin/main', refType: 'remoteBranch' }),
      makeRef({ shorthand: 'main', refType: 'localBranch', isHead: true }),
    ];
    const original = [...refs];

    sortRefsForDisplay(refs);

    expect(refs[0].shorthand).to.equal(original[0].shorthand);
    expect(refs[1].shorthand).to.equal(original[1].shorthand);
  });

  it('handles remote-only branch without slash in shorthand', () => {
    // Edge case: remote shorthand with no slash (shouldn't happen in practice
    // but should not crash)
    const refs = [
      makeRef({ shorthand: 'main', refType: 'localBranch' }),
      makeRef({ shorthand: 'somebranch', refType: 'remoteBranch' }),
    ];

    const sorted = sortRefsForDisplay(refs);
    expect(sorted[0].refType).to.equal('localBranch');
    // Remote branch 'somebranch' matches local 'main'? No.
    // With no slash, branchName = shorthand = 'somebranch' — not in local set
    // So it's remote-only (priority 2)
    expect(sorted[1].refType).to.equal('remoteBranch');
  });

  it('full scenario: multiple branch types on same commit', () => {
    const refs = [
      makeRef({ shorthand: 'v2.0', refType: 'tag', isAnnotated: true }),
      makeRef({ shorthand: 'origin/release/v2', refType: 'remoteBranch' }),
      makeRef({ shorthand: 'origin/main', refType: 'remoteBranch' }),
      makeRef({ shorthand: 'main', refType: 'localBranch', isHead: true }),
      makeRef({ shorthand: 'release/v2', refType: 'localBranch' }),
    ];

    const sorted = sortRefsForDisplay(refs);

    expect(sorted[0].shorthand).to.equal('main'); // HEAD
    expect(sorted[1].shorthand).to.equal('release/v2'); // local branch
    expect(sorted[2].shorthand).to.equal('origin/main'); // remote duplicate (main exists locally)
    expect(sorted[3].shorthand).to.equal('origin/release/v2'); // remote duplicate (release/v2 exists locally)
    expect(sorted[4].shorthand).to.equal('v2.0'); // tag
  });
});

// ── Renderer state (export support + avatar cache) ─────────────────────────
type RendererInternals = {
  avatarCache: Map<string, HTMLImageElement>;
  failedAvatars: Map<string, number>;
  avatarLoadingSet: Set<string>;
  pendingAvatarImages: Set<HTMLImageElement>;
  loadAvatar(email: string): void;
  getCachedAvatar(email: string): HTMLImageElement | undefined;
};

function makeRenderer(config: Record<string, unknown> = {}): CanvasRenderer {
  const canvas = document.createElement('canvas');
  canvas.width = 100;
  canvas.height = 100;
  return new CanvasRenderer(canvas, config);
}

describe('CanvasRenderer state getters', () => {
  it('returns commit stats set via setCommitStats (used by PNG export)', () => {
    const renderer = makeRenderer();
    const stats = new Map([
      ['abc', { additions: 5, deletions: 2, filesChanged: 1 }],
    ]);
    renderer.setCommitStats(stats);
    expect(renderer.getCommitStats().get('abc')).to.deep.equal({
      additions: 5,
      deletions: 2,
      filesChanged: 1,
    });
    renderer.destroy();
  });

  it('returns commit signatures set via setCommitSignatures (used by PNG export)', () => {
    const renderer = makeRenderer();
    const sigs = new Map([['abc', { signed: true, valid: true }]]);
    renderer.setCommitSignatures(sigs);
    expect(renderer.getCommitSignatures().get('abc')).to.deep.equal({
      signed: true,
      valid: true,
    });
    renderer.destroy();
  });
});

describe('CanvasRenderer contrast color', () => {
  type ContrastInternals = {
    getContrastingIconColor(bgColor: string): string;
  };

  it('returns a dark color for light hsl() backgrounds', () => {
    const renderer = makeRenderer();
    const internals = renderer as unknown as ContrastInternals;

    // Very light background — must NOT return white
    const color = internals.getContrastingIconColor('hsl(210, 100%, 90%)');
    expect(color).to.not.equal('#ffffff');
    renderer.destroy();
  });

  it('returns white for dark hsl() backgrounds', () => {
    const renderer = makeRenderer();
    const internals = renderer as unknown as ContrastInternals;

    expect(internals.getContrastingIconColor('hsl(210, 35%, 20%)')).to.equal('#ffffff');
    renderer.destroy();
  });

  it('still handles hex backgrounds', () => {
    const renderer = makeRenderer();
    const internals = renderer as unknown as ContrastInternals;

    expect(internals.getContrastingIconColor('#101010')).to.equal('#ffffff');
    expect(internals.getContrastingIconColor('#f0f0f0')).to.not.equal('#ffffff');
    renderer.destroy();
  });
});

describe('CanvasRenderer theme', () => {
  it('exposes theme-derived row/stats/badge colors with dark fallbacks', async () => {
    const { getThemeFromCSS } = await import('../canvas-renderer.ts');
    const theme = getThemeFromCSS();

    expect(theme.rowColors.selectedBg).to.be.a('string').and.to.not.equal('');
    expect(theme.rowColors.hoveredBg).to.be.a('string').and.to.not.equal('');
    expect(theme.statsColors.additions).to.be.a('string').and.to.not.equal('');
    expect(theme.statsColors.deletions).to.be.a('string').and.to.not.equal('');
    expect(theme.badgeColors.verified).to.be.a('string').and.to.not.equal('');
    expect(theme.prColors.merged).to.be.a('string').and.to.not.equal('');
  });

  it('uses 16 distinct branch colors (no duplicated palette entries)', async () => {
    const { getThemeFromCSS } = await import('../canvas-renderer.ts');
    const theme = getThemeFromCSS();

    expect(theme.laneColors).to.have.length(16);
    expect(new Set(theme.laneColors).size).to.equal(16);
  });
});

describe('CanvasRenderer text truncation cache', () => {
  type TruncationInternals = {
    ctx: CanvasRenderingContext2D;
    truncationCache: Map<string, string>;
    truncateToWidth(text: string, maxWidth: number): string;
  };

  it('truncates long text with an ellipsis and caches the result', () => {
    const renderer = makeRenderer();
    const internals = renderer as unknown as TruncationInternals;
    internals.ctx.font = '13px sans-serif';

    const longText = 'A very long commit message that cannot possibly fit';
    const truncated = internals.truncateToWidth(longText, 60);
    expect(truncated.endsWith('…')).to.be.true;
    expect(truncated.length).to.be.lessThan(longText.length);
    expect(internals.truncationCache.size).to.equal(1);

    // Second call is served from the cache
    expect(internals.truncateToWidth(longText, 60)).to.equal(truncated);
    expect(internals.truncationCache.size).to.equal(1);
    renderer.destroy();
  });

  it('returns short text unchanged', () => {
    const renderer = makeRenderer();
    const internals = renderer as unknown as TruncationInternals;
    internals.ctx.font = '13px sans-serif';

    expect(internals.truncateToWidth('short', 500)).to.equal('short');
    renderer.destroy();
  });

  it('keys the cache on width so resizes re-truncate', () => {
    const renderer = makeRenderer();
    const internals = renderer as unknown as TruncationInternals;
    internals.ctx.font = '13px sans-serif';

    const text = 'A very long commit message that cannot possibly fit';
    const narrow = internals.truncateToWidth(text, 60);
    const wide = internals.truncateToWidth(text, 200);
    expect(wide.length).to.be.greaterThan(narrow.length);
    expect(internals.truncationCache.size).to.equal(2);
    renderer.destroy();
  });
});

describe('CanvasRenderer optional columns', () => {
  type ColumnInternals = {
    getRightColumnLayout(): {
      timeColumnX: number;
      statsColumnX: number;
      dateColumnX: number | null;
      authorColumnX: number | null;
      messageRightEdge: number;
    };
    formatAbsoluteDate(timestamp: number): string;
  };

  it('reserves no space for author/date when disabled', () => {
    const renderer = makeRenderer();
    const layout = (renderer as unknown as ColumnInternals).getRightColumnLayout();

    expect(layout.authorColumnX).to.be.null;
    expect(layout.dateColumnX).to.be.null;
    expect(layout.messageRightEdge).to.equal(layout.statsColumnX - 8);
    renderer.destroy();
  });

  it('places author and date columns left of the stats column when enabled', () => {
    const renderer = makeRenderer({ showAuthorColumn: true, showDateColumn: true });
    const layout = (renderer as unknown as ColumnInternals).getRightColumnLayout();

    expect(layout.dateColumnX).to.be.a('number');
    expect(layout.authorColumnX).to.be.a('number');
    expect(layout.dateColumnX!).to.be.lessThan(layout.statsColumnX);
    expect(layout.authorColumnX!).to.be.lessThan(layout.dateColumnX!);
    // Message space shrinks to end before the author column
    expect(layout.messageRightEdge).to.equal(layout.authorColumnX! - 8);
    renderer.destroy();
  });

  it('drops optional columns instead of squeezing the message on narrow canvases', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 100;
    const renderer = new CanvasRenderer(canvas, {
      showAuthorColumn: true,
      showDateColumn: true,
    });
    const internals = renderer as unknown as ColumnInternals & {
      getRightColumnLayout(messageColumnX?: number): {
        statsColumnX: number;
        dateColumnX: number | null;
        authorColumnX: number | null;
        messageRightEdge: number;
      };
    };

    // Plenty of room: both columns reserved
    const roomy = internals.getRightColumnLayout(100);
    expect(roomy.dateColumnX).to.be.a('number');
    expect(roomy.authorColumnX).to.be.a('number');

    // Message starts late: the author column yields first
    const tight = internals.getRightColumnLayout(450);
    expect(tight.dateColumnX).to.be.a('number');
    expect(tight.authorColumnX).to.be.null;

    // Tighter still: both optional columns yield, message keeps its width
    const cramped = internals.getRightColumnLayout(620);
    expect(cramped.dateColumnX).to.be.null;
    expect(cramped.authorColumnX).to.be.null;
    expect(cramped.messageRightEdge - 620).to.be.at.least(0);
    renderer.destroy();
  });

  it('formats and caches absolute dates', () => {
    const renderer = makeRenderer();
    const internals = renderer as unknown as ColumnInternals;

    const first = internals.formatAbsoluteDate(1700000000);
    expect(first).to.be.a('string').and.to.not.equal('');
    expect(internals.formatAbsoluteDate(1700000000)).to.equal(first);
    renderer.destroy();
  });
});

describe('CanvasRenderer merge edge dashing', () => {
  it('draws merge edges dashed and first-parent edges solid', () => {
    const renderer = makeRenderer();
    const internals = renderer as unknown as { ctx: CanvasRenderingContext2D };

    const dashCalls: number[][] = [];
    const originalSetLineDash = internals.ctx.setLineDash.bind(internals.ctx);
    internals.ctx.setLineDash = (segments: number[]) => {
      dashCalls.push([...segments]);
      originalSetLineDash(segments);
    };

    const commit = {
      oid: 'child',
      parentIds: ['p1', 'p2'],
      timestamp: 1,
      message: 'msg',
      author: 'a',
    };
    const makeNode = (oid: string, row: number) => ({
      oid,
      row,
      lane: 0,
      commit: { ...commit, oid },
      childLanes: [],
      parentLanes: [],
      colorIndex: 0,
      hasMissingParents: false,
    });

    renderer.render({
      nodes: [makeNode('child', 0), makeNode('p1', 1), makeNode('p2', 2)],
      edges: [
        {
          fromOid: 'p1', toOid: 'child', fromRow: 1, toRow: 0,
          fromLane: 0, toLane: 0, isMerge: false, colorIndex: 0,
        },
        {
          fromOid: 'p2', toOid: 'child', fromRow: 2, toRow: 0,
          fromLane: 1, toLane: 0, isMerge: true, colorIndex: 1,
        },
      ],
      range: { startRow: 0, endRow: 2, startLane: 0, endLane: 1 },
      offsetX: 20,
      offsetY: 20,
      refsByCommit: {},
      authorEmails: {},
      maxLane: 1,
    });

    // Solid for the first-parent edge, dashed for the merge edge, plus the
    // trailing reset to solid
    expect(dashCalls).to.deep.include([]);
    expect(dashCalls.some((d) => d.length === 2)).to.be.true;
    // Last call restores solid strokes
    expect(dashCalls[dashCalls.length - 1]).to.deep.equal([]);
    renderer.destroy();
  });
});

describe('CanvasRenderer avatar cache', () => {
  it('does not start avatar loads when fetchAvatars is false', () => {
    const renderer = makeRenderer({ fetchAvatars: false });
    const internals = renderer as unknown as RendererInternals;

    internals.loadAvatar('someone@example.com');
    expect(internals.avatarLoadingSet.size).to.equal(0);
    expect(internals.pendingAvatarImages.size, 'no Image() request created').to.equal(0);
    renderer.destroy();
  });

  it('defaults to NOT fetching when no policy is supplied', () => {
    // Default-deny: a renderer built without an explicit decision must not
    // reach out to gravatar.com.
    const renderer = makeRenderer();
    const internals = renderer as unknown as RendererInternals;

    internals.loadAvatar('someone@example.com');
    expect(internals.pendingAvatarImages.size).to.equal(0);
    expect(internals.avatarLoadingSet.size).to.equal(0);
    renderer.destroy();
  });

  it('creates exactly one Image request per author when fetching is allowed', () => {
    const renderer = makeRenderer({ fetchAvatars: true });
    const internals = renderer as unknown as RendererInternals;

    internals.loadAvatar('someone@example.com');
    internals.loadAvatar('someone@example.com');

    expect(internals.pendingAvatarImages.size).to.equal(1);
    expect(internals.avatarLoadingSet.has('someone@example.com')).to.be.true;
    renderer.destroy();
  });

  it('stops loads and aborts in-flight requests when fetching is turned off', () => {
    // Switching Offline Mode on mid-session must stop the requests already on
    // the wire, not just the next ones.
    const renderer = makeRenderer({ fetchAvatars: true });
    const internals = renderer as unknown as RendererInternals;

    internals.loadAvatar('someone@example.com');
    const inFlight = [...internals.pendingAvatarImages][0];
    expect(inFlight, 'a request was started').to.not.be.undefined;

    renderer.setConfig({ fetchAvatars: false });

    expect(internals.pendingAvatarImages.size, 'in-flight requests aborted').to.equal(0);
    expect(internals.avatarLoadingSet.size).to.equal(0);
    expect(inFlight.onload, 'callbacks released').to.equal(null);

    // And no new request starts afterwards
    internals.loadAvatar('another@example.com');
    expect(internals.pendingAvatarImages.size).to.equal(0);
    renderer.destroy();
  });

  it('keeps in-flight requests when an unrelated config change lands', () => {
    const renderer = makeRenderer({ fetchAvatars: true });
    const internals = renderer as unknown as RendererInternals;

    internals.loadAvatar('someone@example.com');
    renderer.setConfig({ scaleNodesByCommitSize: false });

    expect(internals.pendingAvatarImages.size).to.equal(1);
    renderer.destroy();
  });

  it('does not retry a recently failed avatar load', () => {
    const renderer = makeRenderer({ fetchAvatars: true });
    const internals = renderer as unknown as RendererInternals;

    internals.failedAvatars.set('someone@example.com', Date.now());
    internals.loadAvatar('someone@example.com');
    expect(internals.avatarLoadingSet.size).to.equal(0);
    renderer.destroy();
  });

  it('retries a failed avatar load after the retry window has passed', () => {
    const renderer = makeRenderer({ fetchAvatars: true });
    const internals = renderer as unknown as RendererInternals;

    // Failure recorded 10 minutes ago — outside the 5-minute retry window
    internals.failedAvatars.set('someone@example.com', Date.now() - 10 * 60 * 1000);
    internals.loadAvatar('someone@example.com');
    expect(internals.avatarLoadingSet.has('someone@example.com')).to.be.true;
    renderer.destroy();
  });

  it('refreshes LRU position when a cached avatar is read', () => {
    const renderer = makeRenderer();
    const internals = renderer as unknown as RendererInternals;

    internals.avatarCache.set('first@example.com', new Image());
    internals.avatarCache.set('second@example.com', new Image());

    // Reading the oldest entry moves it to the most-recent end
    internals.getCachedAvatar('first@example.com');
    const keys = [...internals.avatarCache.keys()];
    expect(keys).to.deep.equal(['second@example.com', 'first@example.com']);
    renderer.destroy();
  });

  it('bounds the failed-avatar map when loads keep failing', () => {
    const renderer = makeRenderer({ fetchAvatars: true });
    const internals = renderer as unknown as RendererInternals & {
      pendingAvatarImages: Set<HTMLImageElement>;
    };

    // Simulate a long offline session with many distinct failed authors
    for (let i = 0; i < 500; i++) {
      internals.failedAvatars.set(`author${i}@example.com`, Date.now());
    }

    // The next failure must evict rather than grow unbounded
    internals.loadAvatar('one-more@example.com');
    const img = [...internals.pendingAvatarImages][0];
    expect(img).to.not.be.undefined;
    img.onerror?.(new Event('error'));

    expect(internals.failedAvatars.size).to.be.at.most(500);
    expect(internals.failedAvatars.has('one-more@example.com')).to.be.true;
    renderer.destroy();
  });

  it('returns undefined for uncached avatars without touching the cache', () => {
    const renderer = makeRenderer();
    const internals = renderer as unknown as RendererInternals;

    expect(internals.getCachedAvatar('missing@example.com')).to.be.undefined;
    expect(internals.avatarCache.size).to.equal(0);
    renderer.destroy();
  });
});

describe('CanvasRenderer commit-size node scaling', () => {
  type NodeRadiusInternals = { getNodeRadius(oid: string): number };

  // A fresh Map per test: CanvasRenderer.destroy() clears the Map it was
  // handed, so a shared instance would silently empty out between tests.
  const bigStats = () =>
    new Map([['a', { additions: 5000, deletions: 5000, filesChanged: 20 }]]);

  it('scales the node radius by change volume by default', () => {
    const renderer = makeRenderer({ nodeRadius: 6, minNodeRadius: 5, maxNodeRadius: 10 });
    renderer.setCommitStats(bigStats());
    const internals = renderer as unknown as NodeRadiusInternals;

    expect(internals.getNodeRadius('a')).to.be.greaterThan(6);
    renderer.destroy();
  });

  it('uses the configured node radius when scaleNodesByCommitSize is false', () => {
    const renderer = makeRenderer({
      nodeRadius: 6,
      minNodeRadius: 5,
      maxNodeRadius: 10,
      scaleNodesByCommitSize: false,
    });
    renderer.setCommitStats(bigStats());
    const internals = renderer as unknown as NodeRadiusInternals;

    expect(internals.getNodeRadius('a')).to.equal(6);
    renderer.destroy();
  });

  it('falls back to the configured radius for commits with no stats', () => {
    const renderer = makeRenderer({
      nodeRadius: 6,
      minNodeRadius: 5,
      maxNodeRadius: 10,
      scaleNodesByCommitSize: false,
    });
    renderer.setCommitStats(new Map());
    const internals = renderer as unknown as NodeRadiusInternals;

    expect(internals.getNodeRadius('missing')).to.equal(6);
    renderer.destroy();
  });
});
