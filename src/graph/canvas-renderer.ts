/**
 * Canvas Renderer for Git Graph
 *
 * Renders the virtualized viewport (edges, nodes, ref labels, column
 * headers) in a single full repaint per dirty frame. Includes FPS
 * monitoring, HiDPI scaling, a Gravatar cache, and a text-truncation cache
 * to keep per-frame measureText cost down.
 */

import type { RenderData, GraphPullRequest } from './virtual-scroll.ts';
import type { RefInfo, RefType } from '../types/git.types.ts';
import { md5 } from '../utils/md5.ts';

export interface RenderConfig {
  /** Row height in pixels */
  rowHeight: number;
  /** Lane width in pixels */
  laneWidth: number;
  /** Node radius in pixels */
  nodeRadius: number;
  /** Minimum node radius for size scaling */
  minNodeRadius: number;
  /** Maximum node radius for size scaling */
  maxNodeRadius: number;
  /**
   * Scale node radius by the commit's change volume. Driven by the
   * "Show Commit Size" app setting; when false every node is drawn at
   * `nodeRadius` regardless of stats.
   */
  scaleNodesByCommitSize: boolean;
  /** Line width for edges */
  lineWidth: number;
  /** Show node labels */
  showLabels: boolean;
  /** Show FPS counter */
  showFps: boolean;
  /** Show avatars inside nodes */
  showAvatars: boolean;
  /**
   * Fetch author avatars from Gravatar. When false no network requests are
   * made for avatars and colored initials are drawn instead (privacy/offline
   * opt-out).
   *
   * The effective value is computed by `utils/avatar-policy.ts`, not read from
   * the "Show Avatars" setting directly: these are `new Image()` loads, so
   * they bypass the Tauri-command network gate and Offline Mode / the remote
   * allowlist have to be applied here instead.
   */
  fetchAvatars: boolean;
  /** Show icons in ref labels */
  showRefIcons: boolean;
  /** Width of the refs column in pixels (default 200) */
  refsColumnWidth: number;
  /** Width of the stats column in pixels (default 80) */
  statsColumnWidth: number;
  /** Show the author-name column */
  showAuthorColumn: boolean;
  /** Show the absolute-date column */
  showDateColumn: boolean;
}

export interface RenderTheme {
  /** Background color */
  background: string;
  /** Node colors by lane */
  laneColors: string[];
  /** Text color */
  textColor: string;
  /** Selected node color */
  selectedColor: string;
  /** Hovered node color */
  hoveredColor: string;
  /** FPS counter color */
  fpsColor: string;
  /** Ref label colors */
  refColors: {
    localBranch: string;
    localBranchText: string;
    remoteBranch: string;
    remoteBranchText: string;
    tag: string;
    tagText: string;
    /** Annotated tag background (brighter than lightweight) */
    annotatedTag: string;
    annotatedTagText: string;
    /** Version tag (semver) background - special highlight */
    versionTag: string;
    versionTagText: string;
    head: string;
    headText: string;
  };
  /** Pull request label colors */
  prColors: {
    open: string;
    openText: string;
    closed: string;
    closedText: string;
    merged: string;
    mergedText: string;
    draft: string;
    draftText: string;
  };
  /** Row highlight colors for selection/hover (theme-aware washes) */
  rowColors: {
    selectedBg: string;
    hoveredBg: string;
  };
  /** Stats column colors */
  statsColors: {
    additions: string;
    deletions: string;
  };
  /** Signature badge colors */
  badgeColors: {
    verified: string;
    unverified: string;
    icon: string;
  };
}

const DEFAULT_CONFIG: RenderConfig = {
  rowHeight: 36,
  laneWidth: 14,
  nodeRadius: 6,
  minNodeRadius: 5,
  maxNodeRadius: 10,
  scaleNodesByCommitSize: true,
  lineWidth: 2,
  showLabels: false,
  showFps: false,
  showAvatars: false,
  // Default-deny: a renderer built without an explicit policy decision must
  // not reach out to gravatar.com. The on-screen renderer passes an effective
  // value computed by `utils/avatar-policy.ts`; the export renderer passes a
  // literal `false` because it paints once, synchronously.
  fetchAvatars: false,
  showRefIcons: true,
  refsColumnWidth: 200,
  statsColumnWidth: 80,
  showAuthorColumn: false,
  showDateColumn: false,
};

/**
 * Get a CSS variable value from the document root
 */
function getCSSVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Build theme from CSS variables for dynamic light/dark mode support
 */
export function getThemeFromCSS(): RenderTheme {
  return {
    background: getCSSVar('--color-bg-primary', '#1e1e1e'),
    laneColors: [
      getCSSVar('--color-branch-1', '#4fc3f7'),
      getCSSVar('--color-branch-2', '#81c784'),
      getCSSVar('--color-branch-3', '#ef5350'),
      getCSSVar('--color-branch-4', '#ffb74d'),
      getCSSVar('--color-branch-5', '#ce93d8'),
      getCSSVar('--color-branch-6', '#4dd0e1'),
      getCSSVar('--color-branch-7', '#ff8a65'),
      getCSSVar('--color-branch-8', '#aed581'),
      getCSSVar('--color-branch-9', '#f48fb1'),
      getCSSVar('--color-branch-10', '#80cbc4'),
      getCSSVar('--color-branch-11', '#9fa8da'),
      getCSSVar('--color-branch-12', '#bcaaa4'),
      getCSSVar('--color-branch-13', '#dce775'),
      getCSSVar('--color-branch-14', '#90a4ae'),
      getCSSVar('--color-branch-15', '#ffd54f'),
      getCSSVar('--color-branch-16', '#b39ddb'),
    ],
    textColor: getCSSVar('--graph-text-color', '#c8c8c8'),
    selectedColor: getCSSVar('--graph-selected-color', '#ffffff'),
    hoveredColor: getCSSVar('--graph-hover-color', '#e0e0e0'),
    fpsColor: getCSSVar('--color-warning', '#fbbc04'),
    refColors: {
      localBranch: getCSSVar('--ref-local-bg', '#2e5730'),
      localBranchText: getCSSVar('--ref-local-text', '#a5d6a7'),
      remoteBranch: getCSSVar('--ref-remote-bg', '#1a3a5c'),
      remoteBranchText: getCSSVar('--ref-remote-text', '#90caf9'),
      tag: getCSSVar('--ref-tag-bg', '#5c4020'),
      tagText: getCSSVar('--ref-tag-text', '#ffe082'),
      // Annotated tags: brighter, more vibrant orange
      annotatedTag: getCSSVar('--ref-tag-annotated-bg', '#7a5525'),
      annotatedTagText: getCSSVar('--ref-tag-annotated-text', '#ffd54f'),
      // Version tags (semver): special purple highlight
      versionTag: getCSSVar('--ref-tag-version-bg', '#4a3060'),
      versionTagText: getCSSVar('--ref-tag-version-text', '#ce93d8'),
      head: getCSSVar('--ref-head-bg', '#5c3020'),
      headText: getCSSVar('--ref-head-text', '#ffab91'),
    },
    prColors: {
      open: getCSSVar('--color-success-bg', '#1a3d1a'),
      openText: getCSSVar('--color-success', '#4caf50'),
      closed: getCSSVar('--color-error-bg', '#3d1a1a'),
      closedText: getCSSVar('--color-error', '#ef5350'),
      merged: getCSSVar('--pr-merged-bg', '#2d1f4e'),
      mergedText: getCSSVar('--pr-merged-text', '#a371f7'),
      draft: getCSSVar('--color-bg-hover', '#2d2d2d'),
      draftText: getCSSVar('--color-text-muted', '#888888'),
    },
    rowColors: {
      selectedBg: getCSSVar('--graph-row-selected-bg', 'rgba(255, 255, 255, 0.15)'),
      hoveredBg: getCSSVar('--graph-row-hovered-bg', 'rgba(255, 255, 255, 0.05)'),
    },
    statsColors: {
      additions: getCSSVar('--graph-stat-additions', '#3fb950'),
      deletions: getCSSVar('--graph-stat-deletions', '#f85149'),
    },
    badgeColors: {
      verified: getCSSVar('--badge-verified-bg', '#238636'),
      unverified: getCSSVar('--badge-unverified-bg', '#8b949e'),
      icon: getCSSVar('--badge-icon-color', '#ffffff'),
    },
  };
}

// Fallback theme for SSR or when CSS vars aren't available
const DEFAULT_THEME: RenderTheme = {
  background: '#1e1e1e',
  laneColors: [
    '#4fc3f7', '#81c784', '#ef5350', '#ffb74d',
    '#ce93d8', '#4dd0e1', '#ff8a65', '#aed581',
    '#f48fb1', '#80cbc4', '#9fa8da', '#bcaaa4',
    '#dce775', '#90a4ae', '#ffd54f', '#b39ddb',
  ],
  textColor: '#c8c8c8',
  selectedColor: '#ffffff',
  hoveredColor: '#e0e0e0',
  fpsColor: '#fbbc04',
  refColors: {
    localBranch: '#2e5730',
    localBranchText: '#a5d6a7',
    remoteBranch: '#1a3a5c',
    remoteBranchText: '#90caf9',
    tag: '#5c4020',
    tagText: '#ffe082',
    annotatedTag: '#7a5525',
    annotatedTagText: '#ffd54f',
    versionTag: '#4a3060',
    versionTagText: '#ce93d8',
    head: '#5c3020',
    headText: '#ffab91',
  },
  prColors: {
    open: '#1a3d1a',
    openText: '#4caf50',
    closed: '#3d1a1a',
    closedText: '#ef5350',
    merged: '#2d1f4e',
    mergedText: '#a371f7',
    draft: '#2d2d2d',
    draftText: '#888888',
  },
  rowColors: {
    selectedBg: 'rgba(255, 255, 255, 0.15)',
    hoveredBg: 'rgba(255, 255, 255, 0.05)',
  },
  statsColors: {
    additions: '#3fb950',
    deletions: '#f85149',
  },
  badgeColors: {
    verified: '#238636',
    unverified: '#8b949e',
    icon: '#ffffff',
  },
};

/**
 * Performance monitor for FPS tracking
 */
export class PerformanceMonitor {
  private frameTimes: number[] = [];
  private lastFrameTime = 0;
  private maxSamples = 60;

  /**
   * Record a frame
   */
  recordFrame(): void {
    const now = performance.now();
    if (this.lastFrameTime > 0) {
      this.frameTimes.push(now - this.lastFrameTime);
      if (this.frameTimes.length > this.maxSamples) {
        this.frameTimes.shift();
      }
    }
    this.lastFrameTime = now;
  }

  /**
   * Get current FPS
   */
  getFps(): number {
    if (this.frameTimes.length === 0) return 0;
    const avgFrameTime =
      this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return Math.round(1000 / avgFrameTime);
  }

  /**
   * Get frame time statistics
   */
  getStats(): { fps: number; avgMs: number; minMs: number; maxMs: number } {
    if (this.frameTimes.length === 0) {
      return { fps: 0, avgMs: 0, minMs: 0, maxMs: 0 };
    }

    const avgMs =
      this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    const minMs = Math.min(...this.frameTimes);
    const maxMs = Math.max(...this.frameTimes);

    return {
      fps: Math.round(1000 / avgMs),
      avgMs: Math.round(avgMs * 100) / 100,
      minMs: Math.round(minMs * 100) / 100,
      maxMs: Math.round(maxMs * 100) / 100,
    };
  }

  reset(): void {
    this.frameTimes = [];
    this.lastFrameTime = 0;
  }
}

/**
 * High-performance canvas renderer for git graphs
 */
export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: RenderConfig;
  private theme: RenderTheme;
  private dpr: number;
  private dprMediaQuery: MediaQueryList | null = null;
  private lastCssWidth = 0;
  private lastCssHeight = 0;

  private perfMonitor = new PerformanceMonitor();

  // Selection state
  private selectedOid: string | null = null; // Single selection (for backward compat)
  private selectedOids: Set<string> = new Set(); // Multi-selection
  private hoveredOid: string | null = null;

  // Dirty tracking
  private isDirty = true;
  private pendingFrame: number = 0;

  // Avatar cache (LRU: reads re-insert entries so hot avatars stay cached)
  private static readonly MAX_AVATAR_CACHE_SIZE = 500;
  // Failed loads are retried after this long instead of being cached forever
  private static readonly AVATAR_RETRY_MS = 5 * 60 * 1000;
  private avatarCache: Map<string, HTMLImageElement> = new Map();
  private failedAvatars: Map<string, number> = new Map();
  private avatarLoadingSet: Set<string> = new Set();
  private pendingAvatarImages: Set<HTMLImageElement> = new Set();

  // Commit stats for size scaling and display (oid -> {additions, deletions, filesChanged})
  private commitStats: Map<string, { additions: number; deletions: number; filesChanged: number }> = new Map();

  // Commit signatures (oid -> {signed, valid})
  private commitSignatures: Map<string, { signed: boolean; valid: boolean }> = new Map();

  // Highlighted commits for search result dimming
  private highlightedOids: Set<string> = new Set();

  // Truncated-text cache keyed by font, width and text. Char-by-char
  // truncation calls measureText per character, which is a per-frame hot
  // spot without this.
  private static readonly MAX_TRUNCATION_CACHE = 4000;
  private truncationCache: Map<string, string> = new Map();

  // Header height for offsetting content
  private readonly HEADER_HEIGHT = 28;

  // Optional right-aligned column widths
  private static readonly AUTHOR_COLUMN_WIDTH = 110;
  private static readonly DATE_COLUMN_WIDTH = 85;

  // Formatted absolute dates cached per timestamp
  private absoluteDateCache: Map<number, string> = new Map();

  // Avatar hitboxes for tooltip detection
  private avatarHitboxes: Array<{
    x: number;
    y: number;
    radius: number;
    authorName: string;
    authorEmail: string;
    oid: string;
  }> = [];

  // Ref label hitboxes for tooltip detection
  private refLabelHitboxes: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    label: string;
    fullName: string;
    refType: string;
    /** For local branches: whether this is the checked-out branch. */
    isHead?: boolean;
    /** For tags: whether the tag is annotated */
    isAnnotated?: boolean;
    /** For tags: the tag message */
    tagMessage?: string;
  }> = [];

  // Overflow indicator hitboxes for showing hidden labels
  private overflowHitboxes: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    hiddenLabels: string[];
  }> = [];

  constructor(
    canvas: HTMLCanvasElement,
    config: Partial<RenderConfig> = {},
    theme: Partial<RenderTheme> = {}
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) {
      throw new Error('Failed to get 2D context');
    }
    this.ctx = ctx;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.theme = { ...DEFAULT_THEME, ...theme };
    this.dpr = window.devicePixelRatio || 1;
    this.watchDprChanges();
  }

  /**
   * Track devicePixelRatio changes (window dragged to a monitor with a
   * different pixel density, OS zoom) so the canvas doesn't go blurry.
   * The media query only matches the CURRENT ratio, so it is re-armed
   * after every change.
   */
  private watchDprChanges(): void {
    if (typeof window.matchMedia !== 'function') return;
    this.dprMediaQuery?.removeEventListener('change', this.handleDprChange);
    this.dprMediaQuery = window.matchMedia(`(resolution: ${this.dpr}dppx)`);
    this.dprMediaQuery.addEventListener('change', this.handleDprChange);
  }

  private handleDprChange = (): void => {
    this.dpr = window.devicePixelRatio || 1;
    if (this.lastCssWidth > 0 && this.lastCssHeight > 0) {
      this.resize(this.lastCssWidth, this.lastCssHeight);
    }
    this.watchDprChanges();
  };

  /**
   * Update configuration
   */
  setConfig(config: Partial<RenderConfig>): void {
    const wasFetching = this.config.fetchAvatars;
    this.config = { ...this.config, ...config };
    // Turning avatar fetching off (Offline Mode switched on mid-session, say)
    // must stop the requests that are already on the wire too, not just the
    // next ones — otherwise enabling Offline Mode still leaks the authors
    // currently on screen to gravatar.com.
    if (wasFetching && !this.config.fetchAvatars) {
      this.abortPendingAvatarLoads();
    }
    this.markDirty();
  }

  /**
   * Cancel every in-flight avatar request and forget that they were loading,
   * so a later re-enable starts them again from scratch.
   */
  private abortPendingAvatarLoads(): void {
    for (const img of this.pendingAvatarImages) {
      img.onload = null;
      img.onerror = null;
      img.src = '';
    }
    this.pendingAvatarImages.clear();
    this.avatarLoadingSet.clear();
  }

  /**
   * Update theme
   */
  setTheme(theme: Partial<RenderTheme>): void {
    this.theme = { ...this.theme, ...theme };
    this.markDirty();
  }

  /**
   * Set selection state (single selection - backward compat)
   */
  setSelection(selectedOid: string | null, hoveredOid: string | null): void {
    if (this.selectedOid !== selectedOid || this.hoveredOid !== hoveredOid) {
      this.selectedOid = selectedOid;
      this.selectedOids.clear();
      if (selectedOid) {
        this.selectedOids.add(selectedOid);
      }
      this.hoveredOid = hoveredOid;
      this.markDirty();
    }
  }

  /**
   * Set multi-selection state
   */
  setMultiSelection(selectedOids: Set<string>, hoveredOid: string | null): void {
    this.selectedOids = new Set(selectedOids);
    this.selectedOid = selectedOids.size > 0 ? Array.from(selectedOids)[selectedOids.size - 1] : null;
    this.hoveredOid = hoveredOid;
    this.markDirty();
  }

  /**
   * Set commit stats for size-based node scaling and display
   */
  setCommitStats(stats: Map<string, { additions: number; deletions: number; filesChanged: number }>): void {
    this.commitStats = stats;
    this.markDirty();
  }

  /**
   * Set commit signatures for verified badge display
   */
  setCommitSignatures(signatures: Map<string, { signed: boolean; valid: boolean }>): void {
    this.commitSignatures = signatures;
    this.markDirty();
  }

  /**
   * Get current commit stats (e.g. for copying state to an export renderer)
   */
  getCommitStats(): Map<string, { additions: number; deletions: number; filesChanged: number }> {
    return this.commitStats;
  }

  /**
   * Get current commit signatures (e.g. for copying state to an export renderer)
   */
  getCommitSignatures(): Map<string, { signed: boolean; valid: boolean }> {
    return this.commitSignatures;
  }

  /**
   * Set highlighted commits for search result display
   * When set, non-highlighted commits will be dimmed
   */
  setHighlightedCommits(oids: Set<string>): void {
    this.highlightedOids = oids;
    this.markDirty();
  }

  /**
   * Get Gravatar URL from email using proper MD5 hash
   */
  private getGravatarUrl(email: string, size: number = 64): string {
    const hash = md5(email.toLowerCase().trim());
    return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=404`;
  }

  /**
   * Load avatar image for an email.
   * No-op when avatar fetching is disabled, a load is in flight, the avatar
   * is already cached, or a recent load failed (failures retry after a TTL
   * so a transient network error doesn't blank an author for the session).
   */
  private loadAvatar(email: string): void {
    if (!this.config.fetchAvatars) {
      return;
    }
    if (this.avatarCache.has(email) || this.avatarLoadingSet.has(email)) {
      return;
    }
    const failedAt = this.failedAvatars.get(email);
    if (failedAt !== undefined && Date.now() - failedAt < CanvasRenderer.AVATAR_RETRY_MS) {
      return;
    }

    this.avatarLoadingSet.add(email);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    this.pendingAvatarImages.add(img);

    img.onload = () => {
      this.pendingAvatarImages.delete(img);
      this.failedAvatars.delete(email);
      this.avatarCache.set(email, img);
      this.avatarLoadingSet.delete(email);
      // Evict least-recently-used entry when cache exceeds limit
      if (this.avatarCache.size > CanvasRenderer.MAX_AVATAR_CACHE_SIZE) {
        const firstKey = this.avatarCache.keys().next().value;
        if (firstKey) this.avatarCache.delete(firstKey);
      }
      this.markDirty();
    };

    img.onerror = () => {
      this.pendingAvatarImages.delete(img);
      this.failedAvatars.set(email, Date.now());
      this.avatarLoadingSet.delete(email);
      // Bound the failure map like the success cache — offline sessions
      // with many distinct authors must not grow it for the renderer's
      // lifetime
      if (this.failedAvatars.size > CanvasRenderer.MAX_AVATAR_CACHE_SIZE) {
        const firstKey = this.failedAvatars.keys().next().value;
        if (firstKey) this.failedAvatars.delete(firstKey);
      }
    };

    img.src = this.getGravatarUrl(email, 64);
  }

  /**
   * Get a cached avatar and refresh its LRU position
   */
  private getCachedAvatar(email: string): HTMLImageElement | undefined {
    const img = this.avatarCache.get(email);
    if (img) {
      // Map iteration order is insertion order; re-inserting keeps
      // frequently-drawn avatars away from the eviction end
      this.avatarCache.delete(email);
      this.avatarCache.set(email, img);
    }
    return img;
  }

  /**
   * Truncate text with an ellipsis to fit maxWidth using the CURRENT
   * ctx.font, caching results so repeated frames skip the measure loop
   */
  private truncateToWidth(text: string, maxWidth: number): string {
    const key = `${this.ctx.font}|${Math.round(maxWidth)}|${text}`;
    const cached = this.truncationCache.get(key);
    if (cached !== undefined) return cached;

    let result = text;
    if (this.ctx.measureText(text).width > maxWidth) {
      let truncated = text;
      while (truncated.length > 0 && this.ctx.measureText(truncated + '…').width > maxWidth) {
        truncated = truncated.slice(0, -1);
      }
      result = truncated + '…';
    }

    if (this.truncationCache.size >= CanvasRenderer.MAX_TRUNCATION_CACHE) {
      this.truncationCache.clear();
    }
    this.truncationCache.set(key, result);
    return result;
  }

  /**
   * Get node radius based on commit stats (if available).
   * Public so the SVG export can draw the same node sizes as the canvas.
   */
  public getNodeRadius(oid: string): number {
    if (!this.config.scaleNodesByCommitSize) {
      return this.config.nodeRadius;
    }

    const stats = this.commitStats.get(oid);
    if (!stats) {
      return this.config.nodeRadius;
    }

    // Scale based on number of changes (log scale to prevent huge nodes)
    const totalChanges = stats.additions + stats.deletions;
    const minRadius = this.config.minNodeRadius;
    const maxRadius = this.config.maxNodeRadius;
    const logStats = Math.log10(totalChanges + 1);
    const normalizedSize = Math.min(logStats / 4, 1); // 10000 changes = max size

    return minRadius + (maxRadius - minRadius) * normalizedSize;
  }

  /**
   * Format a timestamp as relative time (e.g., "2h ago", "3 days ago")
   */
  private formatRelativeTime(timestamp: number): string {
    const now = Date.now() / 1000; // Convert to seconds
    const diff = now - timestamp;

    if (diff < 60) {
      return 'now';
    } else if (diff < 3600) {
      const mins = Math.floor(diff / 60);
      return `${mins}m`;
    } else if (diff < 86400) {
      const hours = Math.floor(diff / 3600);
      return `${hours}h`;
    } else if (diff < 604800) {
      const days = Math.floor(diff / 86400);
      return `${days}d`;
    } else if (diff < 2592000) {
      const weeks = Math.floor(diff / 604800);
      return `${weeks}w`;
    } else if (diff < 31536000) {
      const months = Math.floor(diff / 2592000);
      return `${months}mo`;
    } else {
      const years = Math.floor(diff / 31536000);
      return `${years}y`;
    }
  }

  /** Minimum usable commit-message width before optional columns yield */
  private static readonly MIN_MESSAGE_WIDTH = 160;

  /**
   * X positions of the right-aligned columns (time, stats, and the optional
   * date/author columns), plus the right edge available to the message
   * column. Shared by headers, row rendering, and resize-handle placement.
   *
   * When `messageColumnX` is provided, an optional column is only reserved
   * if the message column keeps a usable width — on narrow windows the
   * author/date columns yield rather than squeezing the message to nothing.
   */
  private getRightColumnLayout(messageColumnX?: number): {
    timeColumnX: number;
    timeColumnWidth: number;
    statsColumnX: number;
    dateColumnX: number | null;
    authorColumnX: number | null;
    messageRightEdge: number;
  } {
    const canvasWidth = this.canvas.width / this.dpr;
    const rightPadding = 16;
    const timeColumnWidth = 40;
    const statsColumnWidth = this.config.statsColumnWidth;

    const timeColumnX = canvasWidth - rightPadding - timeColumnWidth;
    const statsColumnX = timeColumnX - statsColumnWidth - 8;

    const fitsMessage = (edge: number): boolean =>
      messageColumnX === undefined ||
      edge - 8 - messageColumnX >= CanvasRenderer.MIN_MESSAGE_WIDTH;

    let cursor = statsColumnX;
    let dateColumnX: number | null = null;
    if (this.config.showDateColumn) {
      const candidate = cursor - CanvasRenderer.DATE_COLUMN_WIDTH - 8;
      if (fitsMessage(candidate)) {
        dateColumnX = candidate;
        cursor = candidate;
      }
    }
    let authorColumnX: number | null = null;
    if (this.config.showAuthorColumn) {
      const candidate = cursor - CanvasRenderer.AUTHOR_COLUMN_WIDTH - 8;
      if (fitsMessage(candidate)) {
        authorColumnX = candidate;
        cursor = candidate;
      }
    }

    return {
      timeColumnX,
      timeColumnWidth,
      statsColumnX,
      dateColumnX,
      authorColumnX,
      messageRightEdge: cursor - 8,
    };
  }

  /**
   * Format a timestamp as an absolute date (e.g. "12 Jan 25"), cached per
   * timestamp
   */
  private formatAbsoluteDate(timestamp: number): string {
    const cached = this.absoluteDateCache.get(timestamp);
    if (cached !== undefined) return cached;

    const formatted = new Date(timestamp * 1000).toLocaleDateString(undefined, {
      day: '2-digit',
      month: 'short',
      year: '2-digit',
    });
    if (this.absoluteDateCache.size >= 5000) {
      this.absoluteDateCache.clear();
    }
    this.absoluteDateCache.set(timestamp, formatted);
    return formatted;
  }

  /**
   * Format commit stats as "+N -M" string, or special cases for no changes
   */
  private formatStats(oid: string): string | null {
    const stats = this.commitStats.get(oid);
    if (!stats) {
      return null; // Stats not yet loaded
    }
    if (stats.additions === 0 && stats.deletions === 0) {
      if (stats.filesChanged > 0) {
        // Binary files changed - show file count
        return `${stats.filesChanged} file${stats.filesChanged === 1 ? '' : 's'}`;
      }
      return '—'; // No direct changes (e.g., merge commit)
    }
    return `+${stats.additions} -${stats.deletions}`;
  }

  /**
   * Draw a verified signature badge (checkmark icon)
   */
  private drawVerifiedBadge(x: number, y: number, isValid: boolean): void {
    const { ctx, theme } = this;
    const size = 12;

    // Badge background: green for verified, gray for unverified
    ctx.fillStyle = isValid ? theme.badgeColors.verified : theme.badgeColors.unverified;
    ctx.beginPath();
    ctx.arc(x, y, size / 2 + 1, 0, Math.PI * 2);
    ctx.fill();

    // Checkmark icon
    ctx.strokeStyle = theme.badgeColors.icon;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x - 3, y);
    ctx.lineTo(x - 1, y + 2);
    ctx.lineTo(x + 3, y - 2);
    ctx.stroke();
  }

  /**
   * Mark canvas as needing redraw
   */
  markDirty(): void {
    this.isDirty = true;
  }

  /**
   * Resize canvas
   */
  resize(width: number, height: number): void {
    this.lastCssWidth = width;
    this.lastCssHeight = height;
    // Setting canvas dimensions resets the context state, including transforms
    this.canvas.width = width * this.dpr;
    this.canvas.height = height * this.dpr;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    // Re-apply DPR scaling after dimension change
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.markDirty();
  }

  /**
   * Ensure canvas context is in correct state for rendering
   */
  private prepareContext(): void {
    // Reset transform to identity, then apply DPR scale
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /**
   * Render the graph
   */
  render(data: RenderData): void {
    if (!this.isDirty) return;

    this.perfMonitor.recordFrame();

    // Ensure context is in correct state before rendering
    this.prepareContext();

    const { ctx, config, theme } = this;
    const width = this.canvas.width / this.dpr;
    const height = this.canvas.height / this.dpr;

    // Clear canvas
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, width, height);

    // Clear hitboxes for this frame
    this.avatarHitboxes = [];
    this.refLabelHitboxes = [];
    this.overflowHitboxes = [];

    // Clip content area below header to prevent overlap
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, this.HEADER_HEIGHT, width, height - this.HEADER_HEIGHT);
    ctx.clip();

    // Draw edges (behind nodes)
    this.renderEdges(data);

    // Draw nodes
    this.renderNodes(data);

    // Draw ref labels (on top of nodes)
    this.renderRefLabels(data);

    // Restore context (remove clipping)
    ctx.restore();

    // Draw column headers LAST (on top of everything)
    this.renderColumnHeaders(data);

    // Draw FPS counter
    if (config.showFps) {
      this.renderFps();
    }

    this.isDirty = false;
  }

  /**
   * Render column headers (GRAPH, COMMIT MESSAGE, STATS, TIME)
   */
  private renderColumnHeaders(data: RenderData): void {
    const { ctx, config, theme } = this;
    const { offsetX, maxLane } = data;

    const headerY = this.HEADER_HEIGHT / 2;
    const canvasWidth = this.canvas.width / this.dpr;

    // Calculate column positions
    const graphEndX = offsetX + (maxLane + 1) * config.laneWidth;
    const avatarColumnX = graphEndX + 20;
    const avatarSize = 22;
    const messageColumnX = avatarColumnX + avatarSize + 12;
    // Rows start the message AFTER the refs column — the optional-column
    // drop decision must use the same origin as renderRefLabels or headers
    // and cells could disagree about which columns exist
    const rowMessageColumnX = avatarColumnX + avatarSize + 8 + config.refsColumnWidth + 12;

    // Right-aligned columns (use config values)
    const { timeColumnX, timeColumnWidth, statsColumnX, dateColumnX, authorColumnX } =
      this.getRightColumnLayout(rowMessageColumnX);
    const statsColumnWidth = config.statsColumnWidth;

    // Draw header background
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, canvasWidth, this.HEADER_HEIGHT);

    ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = theme.textColor;
    ctx.globalAlpha = 0.5;
    ctx.textBaseline = 'middle';

    // Graph header - centered over graph area
    const graphCenterX = offsetX + ((maxLane + 1) * config.laneWidth) / 2;
    ctx.textAlign = 'center';
    ctx.fillText('GRAPH', graphCenterX, headerY);

    // Commit message header
    ctx.textAlign = 'left';
    ctx.fillText('COMMIT', messageColumnX, headerY);

    // Optional author/date headers
    if (authorColumnX !== null) {
      ctx.fillText('AUTHOR', authorColumnX, headerY);
    }
    if (dateColumnX !== null) {
      ctx.fillText('DATE', dateColumnX, headerY);
    }

    // Stats header - center aligned in its column
    ctx.textAlign = 'center';
    ctx.fillText('CHANGES', statsColumnX + statsColumnWidth / 2, headerY);

    // Time header - center aligned in its column
    ctx.fillText('TIME', timeColumnX + timeColumnWidth / 2, headerY);

    ctx.globalAlpha = 1.0;

    // Draw subtle separator line under headers
    ctx.strokeStyle = theme.textColor;
    ctx.globalAlpha = 0.15;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, this.HEADER_HEIGHT - 0.5);
    ctx.lineTo(canvasWidth, this.HEADER_HEIGHT - 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }

  /**
   * Render edges with smooth bezier curves (GitKraken style)
   */
  private renderEdges(data: RenderData): void {
    const { ctx, config } = this;
    const { edges, offsetX, offsetY, maxLane } = data;

    ctx.lineWidth = config.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Graph is mirrored: lane 0 is on the right, higher lanes extend left
    const graphEndX = offsetX + (maxLane + 1) * config.laneWidth;

    for (const edge of edges) {
      const fromX = graphEndX - (edge.fromLane + 1) * config.laneWidth + config.laneWidth / 2;
      const fromY = offsetY + edge.fromRow * config.rowHeight + this.HEADER_HEIGHT;
      const toX = graphEndX - (edge.toLane + 1) * config.laneWidth + config.laneWidth / 2;
      const toY = offsetY + edge.toRow * config.rowHeight + this.HEADER_HEIGHT;

      ctx.strokeStyle = this.getBranchColor(edge.colorIndex);
      // Merge edges are dashed — a non-color cue distinguishing the merged
      // branch's edge for color-blind users
      ctx.setLineDash(edge.isMerge ? [5, 4] : []);
      ctx.beginPath();

      if (edge.fromLane === edge.toLane) {
        // Straight line for same lane
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
      } else {
        // Smooth bezier curve for lane changes (GitKraken style)
        const rowDiff = Math.abs(edge.toRow - edge.fromRow);
        const goingDown = toY > fromY;

        ctx.moveTo(fromX, fromY);

        if (rowDiff === 1) {
          // Single row difference: simple S-curve
          const midY = (fromY + toY) / 2;
          ctx.bezierCurveTo(
            fromX, midY,      // Control point 1: straight down from start
            toX, midY,        // Control point 2: straight up from end
            toX, toY          // End point
          );
        } else if (goingDown) {
          // Multiple rows going down: curve out then straight down then curve in
          const curveHeight = config.rowHeight * 0.8;
          const midY = fromY + curveHeight;

          // First curve: from start going down and sideways
          ctx.bezierCurveTo(
            fromX, fromY + curveHeight * 0.5,  // Control 1
            toX, midY - curveHeight * 0.5,     // Control 2
            toX, midY                           // End of curve
          );

          // Straight line to near the end
          ctx.lineTo(toX, toY);
        } else {
          // Multiple rows going up: straight then curve
          const curveHeight = config.rowHeight * 0.8;
          const startCurveY = toY + curveHeight;

          // Straight line from start
          ctx.lineTo(fromX, startCurveY);

          // Curve to end
          ctx.bezierCurveTo(
            fromX, startCurveY - curveHeight * 0.5,
            toX, toY + curveHeight * 0.5,
            toX, toY
          );
        }
      }

      ctx.stroke();
    }

    // Restore solid strokes for everything drawn after the edges
    ctx.setLineDash([]);
  }

  /**
   * Render nodes with avatars
   */
  private renderNodes(data: RenderData): void {
    const { ctx, config, theme } = this;
    const { nodes, offsetX, offsetY, authorEmails, maxLane } = data;

    // Graph is mirrored: lane 0 is on the right, higher lanes extend left
    const graphEndX = offsetX + (maxLane + 1) * config.laneWidth;

    // Check if search highlighting is active
    const hasHighlighting = this.highlightedOids.size > 0;

    for (const node of nodes) {
      const x = graphEndX - (node.lane + 1) * config.laneWidth + config.laneWidth / 2;
      const y = offsetY + node.row * config.rowHeight + this.HEADER_HEIGHT;
      const color = this.getBranchColor(node.colorIndex);
      const radius = this.getNodeRadius(node.oid);

      const isSelected = this.selectedOids.has(node.oid);
      const isHovered = node.oid === this.hoveredOid;
      const isHighlighted = !hasHighlighting || this.highlightedOids.has(node.oid);

      // Dim non-matching commits during search (but don't dim selected/hovered)
      if (hasHighlighting && !isHighlighted && !isSelected && !isHovered) {
        ctx.globalAlpha = 0.25;
      }

      // History continues below (parents not loaded / filtered out):
      // draw a short fading stub instead of dead-ending the line
      if (node.hasMissingParents) {
        const stubLength = config.rowHeight * 0.8;
        const gradient = ctx.createLinearGradient(x, y, x, y + radius + stubLength);
        gradient.addColorStop(0, color);
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.strokeStyle = gradient;
        ctx.lineWidth = config.lineWidth;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + radius + stubLength);
        ctx.stroke();
      }

      // Get author email for avatar
      const authorEmail = authorEmails?.[node.oid];

      // Try to draw avatar if enabled and email available
      let avatarDrawn = false;
      if (config.showAvatars && authorEmail) {
        const avatar = this.getCachedAvatar(authorEmail);
        if (avatar) {
          // Draw circular avatar
          ctx.save();
          ctx.beginPath();
          ctx.arc(x, y, radius - 2, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(avatar, x - radius + 2, y - radius + 2, (radius - 2) * 2, (radius - 2) * 2);
          ctx.restore();
          avatarDrawn = true;
        } else {
          // Trigger avatar load
          this.loadAvatar(authorEmail);
        }
      }

      // Check if this is a merge commit (has multiple parents)
      const isMergeCommit = node.commit.parentIds.length > 1;

      // Draw node circle (border or full if no avatar)
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);

      if (isSelected) {
        // Selected: white fill with thick colored border
        if (!avatarDrawn) {
          ctx.fillStyle = theme.selectedColor;
          ctx.fill();
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.stroke();
      } else if (isHovered) {
        // Hovered: colored fill with white border
        if (!avatarDrawn) {
          ctx.fillStyle = color;
          ctx.fill();
        }
        ctx.strokeStyle = theme.hoveredColor;
        ctx.lineWidth = 3;
        ctx.stroke();
      } else if (isMergeCommit) {
        // Merge commit: hollow circle with thick border (GitKraken style)
        if (!avatarDrawn) {
          ctx.fillStyle = theme.background;
          ctx.fill();
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      } else {
        // Normal: colored fill or border around avatar
        if (avatarDrawn) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.stroke();
        } else {
          ctx.fillStyle = color;
          ctx.fill();
        }
      }

      // Draw initials if no avatar and node is large enough
      if (!avatarDrawn && radius >= 12 && authorEmail) {
        const initials = this.getInitials(node.commit.author);
        ctx.fillStyle = isSelected ? color : this.getContrastingIconColor(color);
        ctx.font = `bold ${Math.floor(radius * 0.8)}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(initials, x, y + 1);
      }

      // Draw label for selected/hovered (to the left since graph is mirrored)
      if ((isSelected || isHovered) && config.showLabels) {
        ctx.fillStyle = theme.textColor;
        ctx.font = '11px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(node.oid.substring(0, 7), x - radius - 6, y);
      }

      // Reset alpha for next node
      ctx.globalAlpha = 1.0;
    }
  }

  /**
   * Get a consistent color for a user based on their name
   * Generates unique colors using HSL for better distribution
   * Colors are muted so graph lane colors stand out more
   */
  private getUserColor(name: string): string {
    // Generate hash using djb2 algorithm
    let hash = 5381;
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 5) + hash) ^ name.charCodeAt(i);
    }
    hash = Math.abs(hash);

    // Use golden ratio to spread hues evenly
    // This ensures consecutive hash values produce visually distinct colors
    const goldenRatio = 0.618033988749895;
    const hue = ((hash * goldenRatio) % 1) * 360;

    // Muted colors: lower saturation so graph colors pop
    const saturation = 35;
    const lightness = 45;

    return `hsl(${Math.round(hue)}, ${saturation}%, ${lightness}%)`;
  }

  /**
   * Draw the colored initials circle used when no avatar image is available
   */
  private drawInitialsAvatar(
    centerX: number,
    centerY: number,
    radius: number,
    size: number,
    author: string
  ): void {
    const { ctx } = this;
    const userColor = this.getUserColor(author);
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius - 1, 0, Math.PI * 2);
    ctx.fillStyle = userColor;
    ctx.fill();
    const initials = this.getInitials(author);
    ctx.fillStyle = this.getContrastingIconColor(userColor);
    ctx.font = `bold ${Math.floor(size * 0.45)}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, centerX, centerY + 1);
  }

  /**
   * Get initials from author name
   */
  private getInitials(name: string): string {
    // Filter out parts that start with non-letters (like "(External)")
    const parts = name.trim().split(/\s+/).filter(p => /^[a-zA-Z]/.test(p));
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    if (parts.length === 1 && parts[0].length >= 2) {
      return parts[0].substring(0, 2).toUpperCase();
    }
    // Fallback: first two letters of original name
    const letters = name.replace(/[^a-zA-Z]/g, '');
    return letters.substring(0, 2).toUpperCase() || '??';
  }

  /**
   * Render ref labels and commit messages in fixed columns
   * Layout: [Branch Labels] | [Graph] | [Avatar] | [Message + Refs]
   */
  private renderRefLabels(data: RenderData): void {
    const { ctx, config, theme } = this;
    const { nodes, offsetX, offsetY, refsByCommit, maxLane } = data;

    // Get canvas width for responsive layout
    const canvasWidth = this.canvas.width / this.dpr;

    // Calculate column positions (left to right)
    const graphEndX = offsetX + (maxLane + 1) * config.laneWidth;
    const avatarColumnX = graphEndX + 20;
    const avatarSize = 22;
    const refsColumnX = avatarColumnX + avatarSize + 8;
    const refsColumnWidth = config.refsColumnWidth;
    const messageColumnX = refsColumnX + refsColumnWidth + 12;

    // Right-aligned columns (use config values)
    const {
      timeColumnX,
      timeColumnWidth,
      statsColumnX,
      dateColumnX,
      authorColumnX,
      messageRightEdge,
    } = this.getRightColumnLayout(messageColumnX);
    const statsColumnWidth = config.statsColumnWidth;

    // Message column fills space up to the first right-aligned column
    const availableMessageWidth = messageRightEdge - messageColumnX;

    // Check if search highlighting is active
    const hasHighlighting = this.highlightedOids.size > 0;

    for (const node of nodes) {
      const y = offsetY + node.row * config.rowHeight + this.HEADER_HEIGHT;
      const refs = refsByCommit?.[node.oid] ?? [];
      const laneColor = this.getBranchColor(node.colorIndex);

      const isSelected = this.selectedOids.has(node.oid);
      const isHovered = node.oid === this.hoveredOid;
      const isHighlighted = !hasHighlighting || this.highlightedOids.has(node.oid);

      // Dim non-matching commits during search (but don't dim selected/hovered)
      if (hasHighlighting && !isHighlighted && !isSelected && !isHovered) {
        ctx.globalAlpha = 0.25;
      }

      // Draw subtle row highlighting for selected/hovered rows
      if (isSelected || isHovered) {
        const rowTop = y - config.rowHeight / 2;
        ctx.fillStyle = isSelected ? theme.rowColors.selectedBg : theme.rowColors.hoveredBg;
        ctx.fillRect(0, rowTop, canvasWidth, config.rowHeight);

        // Draw left border stripe matching lane color
        ctx.fillStyle = laneColor;
        ctx.globalAlpha = isSelected ? 0.8 : 0.5;
        ctx.fillRect(0, rowTop, 4, config.rowHeight);
        ctx.globalAlpha = 1.0;
      }

      // Render avatar in avatar column
      const authorEmail = data.authorEmails?.[node.oid];
      const avatarRadius = avatarSize / 2;
      const avatarCenterX = avatarColumnX + avatarRadius;

      // Store avatar hitbox for tooltip detection
      this.avatarHitboxes.push({
        x: avatarCenterX,
        y,
        radius: avatarRadius,
        authorName: node.commit.author,
        authorEmail: authorEmail ?? '',
        oid: node.oid,
      });

      const avatar = authorEmail && config.fetchAvatars
        ? this.getCachedAvatar(authorEmail)
        : undefined;
      if (avatar) {
        // Draw actual Gravatar image
        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarCenterX, y, avatarRadius - 1, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(avatar, avatarCenterX - avatarRadius + 1, y - avatarRadius + 1, avatarSize - 2, avatarSize - 2);
        ctx.restore();
      } else {
        if (authorEmail) {
          // Kick off a load; no-ops when fetching is disabled, already in
          // flight, or a recent attempt failed
          this.loadAvatar(authorEmail);
        }
        this.drawInitialsAvatar(avatarCenterX, y, avatarRadius, avatarSize, node.commit.author);
      }

      // Draw signature badge if commit is signed
      const signature = this.commitSignatures.get(node.oid);
      if (signature?.signed) {
        this.drawVerifiedBadge(avatarCenterX + avatarRadius - 2, y + avatarRadius - 2, signature.valid);
      }

      const prs = data.pullRequestsByCommit?.[node.oid] ?? [];

      // Render commit message (full width now, refs are in separate column)
      const message = node.commit.message;
      ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = laneColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      // Truncate message to fit available space (cached)
      const displayMessage = this.truncateToWidth(message, availableMessageWidth);
      ctx.fillText(displayMessage, messageColumnX, y);

      // Render refs in refs column - show as many as fit
      // Sort refs so the most important ones render first when space is limited:
      // HEAD > local branches > remote-only branches > remote duplicates > tags
      const sortedRefs = this.sortRefsForDisplay(refs);
      const allRefs = [...sortedRefs, ...prs.map(pr => ({ ...pr, isPR: true }))];
      const smallLabelHeight = 16;
      const smallLabelPadding = 6;
      const smallIconSize = 10;
      const labelGapSize = 4;
      const hiddenLabels: string[] = [];

      if (allRefs.length > 0) {
        const labelY = y;
        let currentX = refsColumnX;
        let renderedCount = 0;

        // Calculate how many labels we can fit
        for (let i = 0; i < allRefs.length; i++) {
          const item = allRefs[i];
          const isPR = 'isPR' in item && item.isPR;

          // Calculate this label's width
          ctx.font = '500 11px -apple-system, BlinkMacSystemFont, sans-serif';
          const hasIcon = config.showRefIcons;
          const iconWidth = hasIcon ? smallIconSize + 3 : 0;

          let labelText: string;
          if (isPR) {
            labelText = `#${(item as GraphPullRequest & { isPR: boolean }).number}`;
          } else {
            labelText = (item as RefInfo).shorthand;
          }


          // Check if we have room for at least a truncated label plus "+N" badge
          const remainingRefs = allRefs.length - i - 1;
          const needsBadge = remainingRefs > 0;
          const badgeSpace = needsBadge ? 30 : 0;
          const minTruncatedLabelWidth = 50;
          const minSpaceNeeded = minTruncatedLabelWidth + (i > 0 ? labelGapSize : 0) + badgeSpace;

          if (currentX + minSpaceNeeded > refsColumnX + refsColumnWidth && i > 0) {
            // No room for even a truncated label, stop here
            break;
          }

          // Render this label
          if (i > 0) {
            currentX += labelGapSize;
          }

          // Proportionally allocate column space among remaining labels
          const totalRemainingLabels = allRefs.length - i;
          const futureGaps = Math.max(0, totalRemainingLabels - 1) * labelGapSize;
          const remainingSpace = refsColumnX + refsColumnWidth - currentX - badgeSpace - futureGaps;
          const proportionalWidth = Math.floor(remainingSpace / totalRemainingLabels);
          const maxPillWidth = Math.max(50, proportionalWidth);

          if (isPR) {
            // Render PR badge
            const pr = item as GraphPullRequest & { isPR: boolean };
            const { bgColor, textColor: prTextColor } = this.getPrColors(pr);
            const prLabel = `#${pr.number}`;
            const prIconWidth = smallIconSize + 3;
            const prPillWidth = Math.min(
              ctx.measureText(prLabel).width + smallLabelPadding * 2 + prIconWidth,
              maxPillWidth
            );

            // Draw pill
            ctx.fillStyle = bgColor;
            this.drawRoundedRect(currentX, labelY - smallLabelHeight / 2, prPillWidth, smallLabelHeight, 4);

            // Draw PR icon
            ctx.strokeStyle = prTextColor;
            ctx.fillStyle = prTextColor;
            this.drawPrIcon(currentX + smallLabelPadding, labelY, smallIconSize);

            // Draw PR number
            ctx.fillStyle = prTextColor;
            ctx.font = '500 11px -apple-system, BlinkMacSystemFont, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(prLabel, currentX + smallLabelPadding + prIconWidth, labelY);

            // Store hitbox
            this.refLabelHitboxes.push({
              x: currentX,
              y: labelY - smallLabelHeight / 2,
              width: prPillWidth,
              height: smallLabelHeight,
              label: prLabel,
              fullName: pr.url ?? `Pull Request ${prLabel}`,
              refType: 'pullRequest',
            });

            currentX += prPillWidth;
          } else {
            // Render ref badge
            const ref = item as RefInfo;
            const { bgColor, textColor } = this.getRefColors(ref);

            // Truncate label if needed (cached)
            const maxTextWidth = maxPillWidth - smallLabelPadding * 2 - iconWidth;
            const displayLabel = this.truncateToWidth(labelText, maxTextWidth);
            const actualTextWidth = ctx.measureText(displayLabel).width;

            const actualPillWidth = actualTextWidth + smallLabelPadding * 2 + iconWidth;

            // Draw pill
            ctx.fillStyle = bgColor;
            this.drawRoundedRect(currentX, labelY - smallLabelHeight / 2, actualPillWidth, smallLabelHeight, 4);

            // Draw HEAD indicator
            if (ref.isHead) {
              ctx.strokeStyle = theme.refColors.headText;
              ctx.lineWidth = 1.5;
              this.strokeRoundedRect(currentX, labelY - smallLabelHeight / 2, actualPillWidth, smallLabelHeight, 4);
            }

            // Draw icon
            let textStartX = currentX + smallLabelPadding;
            if (hasIcon) {
              ctx.strokeStyle = textColor;
              ctx.fillStyle = textColor;
              this.drawRefIcon(ref.refType, currentX + smallLabelPadding, labelY, smallIconSize, ref.isAnnotated);
              textStartX = currentX + smallLabelPadding + smallIconSize + 3;
            }

            // Draw label text
            ctx.fillStyle = textColor;
            ctx.font = '500 11px -apple-system, BlinkMacSystemFont, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(displayLabel, textStartX, labelY);

            // Store hitbox (include tag metadata for tooltips)
            this.refLabelHitboxes.push({
              x: currentX,
              y: labelY - smallLabelHeight / 2,
              width: actualPillWidth,
              height: smallLabelHeight,
              label: ref.shorthand,
              fullName: ref.name,
              refType: ref.refType,
              // Carried so the context menu can hide Delete on the checked-out
              // branch: delete_branch can never succeed there (libgit2 refuses
              // the current HEAD), so offering it only ever produced a confirm
              // followed by an error.
              isHead: ref.isHead,
              isAnnotated: ref.isAnnotated,
              tagMessage: ref.tagMessage,
            });

            currentX += actualPillWidth;
          }

          renderedCount++;
        }

        // Show "+N" count badge if there are more refs that didn't fit
        const remainingCount = allRefs.length - renderedCount;
        if (remainingCount > 0) {
          // Collect hidden labels for tooltip
          for (let j = renderedCount; j < allRefs.length; j++) {
            const hiddenItem = allRefs[j];
            if ('isPR' in hiddenItem && hiddenItem.isPR) {
              hiddenLabels.push(`#${(hiddenItem as GraphPullRequest).number}`);
            } else {
              hiddenLabels.push((hiddenItem as RefInfo).shorthand);
            }
          }

          const moreText = `+${remainingCount}`;
          ctx.font = 'bold 9px -apple-system, BlinkMacSystemFont, sans-serif';
          const moreWidth = ctx.measureText(moreText).width + 6;
          const badgeX = currentX + labelGapSize;

          ctx.fillStyle = theme.textColor;
          ctx.globalAlpha = 0.4;
          this.drawRoundedRect(badgeX, y - 8, moreWidth, 16, 4);
          ctx.globalAlpha = 1.0;

          ctx.fillStyle = theme.textColor;
          ctx.globalAlpha = 0.8;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(moreText, badgeX + moreWidth / 2, y);
          ctx.globalAlpha = 1.0;

          // Store hitbox for tooltip
          this.overflowHitboxes.push({
            x: badgeX,
            y: y - 8,
            width: moreWidth,
            height: 16,
            hiddenLabels,
          });
        }
      }

      // Render optional author column
      if (authorColumnX !== null) {
        ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillStyle = theme.textColor;
        ctx.globalAlpha = 0.75;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const authorName = this.truncateToWidth(
          node.commit.author,
          CanvasRenderer.AUTHOR_COLUMN_WIDTH
        );
        ctx.fillText(authorName, authorColumnX, y);
        ctx.globalAlpha = 1.0;
      }

      // Render optional absolute-date column
      if (dateColumnX !== null) {
        ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillStyle = theme.textColor;
        ctx.globalAlpha = 0.75;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(this.formatAbsoluteDate(node.commit.timestamp), dateColumnX, y);
        ctx.globalAlpha = 1.0;
      }

      // Render stats column (right-aligned)
      const statsText = this.formatStats(node.oid);
      if (statsText) {
        ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';

        if (statsText === '—' || statsText.endsWith('file') || statsText.endsWith('files')) {
          // No line changes - show in muted color (merge commit or binary files)
          ctx.fillStyle = theme.textColor;
          ctx.globalAlpha = 0.5;
          ctx.fillText(statsText, statsColumnX + statsColumnWidth, y);
          ctx.globalAlpha = 1.0;
        } else {
          // Split into additions and deletions for colored display
          const stats = this.commitStats.get(node.oid);
          if (stats) {
            const addText = `+${stats.additions}`;
            const delText = `-${stats.deletions}`;

            // Draw deletions first (further right)
            ctx.fillStyle = theme.statsColors.deletions;
            const delWidth = ctx.measureText(delText).width;
            ctx.fillText(delText, statsColumnX + statsColumnWidth, y);

            // Draw additions
            ctx.fillStyle = theme.statsColors.additions;
            ctx.fillText(addText + ' ', statsColumnX + statsColumnWidth - delWidth - 4, y);
          }
        }
      }

      // Render timestamp column (right-aligned)
      const relativeTime = this.formatRelativeTime(node.commit.timestamp);
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = theme.textColor;
      ctx.globalAlpha = 0.6;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(relativeTime, timeColumnX + timeColumnWidth, y);
      ctx.globalAlpha = 1.0;
    }
  }

  private sortRefsForDisplay(refs: RefInfo[]): RefInfo[] {
    return sortRefsForDisplay(refs);
  }

  /**
   * Draw an icon for a ref type - matches sidebar branch icons exactly
   * SVG viewBox is 0 0 24 24, scaled to iconSize
   * @param isAnnotated For tags: whether the tag is annotated (filled) or lightweight (hollow)
   */
  private drawRefIcon(refType: RefType, x: number, y: number, size: number, isAnnotated?: boolean): void {
    const { ctx } = this;
    const s = size / 24;  // Scale factor from SVG viewBox (24x24) to icon size
    const top = y - size / 2;  // Top of icon area
    const left = x;  // Left of icon area

    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    switch (refType) {
      case 'localBranch':
        // Matches sidebar exactly:
        // <line x1="6" y1="3" x2="6" y2="15"></line>
        // <circle cx="18" cy="6" r="3"></circle>
        // <circle cx="6" cy="18" r="3"></circle>
        // <path d="M18 9a9 9 0 01-9 9"></path>

        // Vertical line
        ctx.beginPath();
        ctx.moveTo(left + 6 * s, top + 3 * s);
        ctx.lineTo(left + 6 * s, top + 15 * s);
        ctx.stroke();

        // Top-right circle (stroked, not filled)
        ctx.beginPath();
        ctx.arc(left + 18 * s, top + 6 * s, 3 * s, 0, Math.PI * 2);
        ctx.stroke();

        // Bottom-left circle (stroked)
        ctx.beginPath();
        ctx.arc(left + 6 * s, top + 18 * s, 3 * s, 0, Math.PI * 2);
        ctx.stroke();

        // Curved path from (18, 9) arcing to (9, 18)
        // SVG: M18 9a9 9 0 01-9 9 is an arc from (18,9) to (9,18) with radius 9
        ctx.beginPath();
        ctx.moveTo(left + 18 * s, top + 9 * s);
        ctx.bezierCurveTo(
          left + 18 * s, top + 14 * s,  // control point 1
          left + 14 * s, top + 18 * s,  // control point 2
          left + 9 * s, top + 18 * s    // end point
        );
        ctx.stroke();
        break;

      case 'remoteBranch':
        // Same structure as local branch with arrow indicator
        // Vertical line
        ctx.beginPath();
        ctx.moveTo(left + 6 * s, top + 3 * s);
        ctx.lineTo(left + 6 * s, top + 15 * s);
        ctx.stroke();

        // Top-right circle
        ctx.beginPath();
        ctx.arc(left + 18 * s, top + 6 * s, 3 * s, 0, Math.PI * 2);
        ctx.stroke();

        // Bottom-left circle
        ctx.beginPath();
        ctx.arc(left + 6 * s, top + 18 * s, 3 * s, 0, Math.PI * 2);
        ctx.stroke();

        // Curved path
        ctx.beginPath();
        ctx.moveTo(left + 18 * s, top + 9 * s);
        ctx.bezierCurveTo(
          left + 18 * s, top + 14 * s,
          left + 14 * s, top + 18 * s,
          left + 9 * s, top + 18 * s
        );
        ctx.stroke();

        // Small arrow indicating remote (up-right)
        ctx.beginPath();
        ctx.moveTo(left + 21 * s, top + 3 * s);
        ctx.lineTo(left + 23 * s, top + 1 * s);
        ctx.moveTo(left + 23 * s, top + 1 * s);
        ctx.lineTo(left + 21 * s, top + 1 * s);
        ctx.moveTo(left + 23 * s, top + 1 * s);
        ctx.lineTo(left + 23 * s, top + 3 * s);
        ctx.stroke();
        break;

      case 'tag': {
        // Tag icon - pentagon shape
        // Annotated tags are filled, lightweight tags are hollow
        const cx = left + size / 2;
        const cy = y;
        const ts = size / 11;  // Tag-specific scale

        ctx.beginPath();
        ctx.moveTo(cx + 4 * ts, cy - 4 * ts);
        ctx.lineTo(cx + 4 * ts, cy + 1 * ts);
        ctx.lineTo(cx, cy + 5 * ts);
        ctx.lineTo(cx - 4 * ts, cy + 1 * ts);
        ctx.lineTo(cx - 4 * ts, cy - 4 * ts);
        ctx.closePath();

        if (isAnnotated) {
          // Filled tag for annotated tags
          ctx.fill();
          // Draw hole in contrasting color
          ctx.save();
          ctx.globalCompositeOperation = 'destination-out';
          ctx.beginPath();
          ctx.arc(cx, cy - 2 * ts, 1.5 * ts, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else {
          // Hollow tag for lightweight tags
          ctx.stroke();
          // Small hole in tag
          ctx.beginPath();
          ctx.arc(cx, cy - 2 * ts, 1.5 * ts, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      }

      case 'detachedHead': {
        // A "you are here" locator, deliberately unlike the branch icon: a
        // detached HEAD is a position in history, not a branch. Without a case
        // of its own it fell to the default circle and read as an unlabelled
        // branch pill.
        const cx = left + size / 2;
        ctx.beginPath();
        ctx.arc(cx, y, size / 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, y, size / 8, 0, Math.PI * 2);
        ctx.fill();
        break;
      }

      default:
        // Default: simple circle
        ctx.beginPath();
        ctx.arc(left + size / 2, y, size / 4, 0, Math.PI * 2);
        ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Convert HSL components to RGB (0-255 per channel)
   */
  private hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
    const sat = s / 100;
    const light = l / 100;
    const c = (1 - Math.abs(2 * light - 1)) * sat;
    const hp = ((h % 360) + 360) % 360 / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r1 = 0, g1 = 0, b1 = 0;
    if (hp < 1) [r1, g1, b1] = [c, x, 0];
    else if (hp < 2) [r1, g1, b1] = [x, c, 0];
    else if (hp < 3) [r1, g1, b1] = [0, c, x];
    else if (hp < 4) [r1, g1, b1] = [0, x, c];
    else if (hp < 5) [r1, g1, b1] = [x, 0, c];
    else [r1, g1, b1] = [c, 0, x];
    const m = light - c / 2;
    return {
      r: Math.round((r1 + m) * 255),
      g: Math.round((g1 + m) * 255),
      b: Math.round((b1 + m) * 255),
    };
  }

  /**
   * Get a contrasting icon color based on the background
   */
  private getContrastingIconColor(bgColor: string): string {
    let r = 0, g = 0, b = 0;

    // Parse hex color
    if (bgColor.startsWith('#')) {
      const hex = bgColor.replace('#', '');
      r = parseInt(hex.substr(0, 2), 16);
      g = parseInt(hex.substr(2, 2), 16);
      b = parseInt(hex.substr(4, 2), 16);
    }
    // Parse rgba/rgb color
    else if (bgColor.startsWith('rgba') || bgColor.startsWith('rgb')) {
      const match = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (match) {
        r = parseInt(match[1], 10);
        g = parseInt(match[2], 10);
        b = parseInt(match[3], 10);
      }
    }
    // Parse hsl/hsla color — getUserColor produces hsl(), which previously
    // fell through as black and made this function always return white
    else if (bgColor.startsWith('hsl')) {
      const match = bgColor.match(/hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/);
      if (match) {
        const rgb = this.hslToRgb(
          parseFloat(match[1]),
          parseFloat(match[2]),
          parseFloat(match[3])
        );
        ({ r, g, b } = rgb);
      }
    }

    // Calculate relative luminance
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

    // Return dark color for light backgrounds, light for dark
    if (luminance > 0.5) {
      // Light background - use darker version of the color
      return `rgb(${Math.floor(r * 0.4)}, ${Math.floor(g * 0.4)}, ${Math.floor(b * 0.4)})`;
    } else {
      // Dark background - use lighter/white
      return '#ffffff';
    }
  }

  /**
   * Get colors for a ref based on its type
   */
  private getRefColors(ref: RefInfo): { bgColor: string; textColor: string } {
    const { theme } = this;

    if (ref.isHead) {
      // HEAD gets special treatment - use local branch color with head indicator
      return {
        bgColor: theme.refColors.localBranch,
        textColor: theme.refColors.localBranchText,
      };
    }

    switch (ref.refType) {
      case 'localBranch':
        return {
          bgColor: theme.refColors.localBranch,
          textColor: theme.refColors.localBranchText,
        };
      case 'remoteBranch':
        return {
          bgColor: theme.refColors.remoteBranch,
          textColor: theme.refColors.remoteBranchText,
        };
      case 'tag': {
        // Check if this is a version tag (semver pattern: v1.0.0, 1.0.0, etc.)
        // Match semver-like version tags (e.g., v1.2.3, 1.0.0-beta.1, 2.0.0+build.123)
        // Requires at least one alphanumeric after - or + to prevent matching "1.2.3-" or "1.2.3+"
        const isVersionTag = /^v?\d+\.\d+(\.\d+)?(-[a-zA-Z0-9][a-zA-Z0-9.]*)?(\+[a-zA-Z0-9][a-zA-Z0-9.]*)?$/.test(ref.shorthand);

        if (isVersionTag) {
          // Version tags get special purple highlighting
          return {
            bgColor: theme.refColors.versionTag,
            textColor: theme.refColors.versionTagText,
          };
        } else if (ref.isAnnotated) {
          // Annotated tags are brighter/more vibrant
          return {
            bgColor: theme.refColors.annotatedTag,
            textColor: theme.refColors.annotatedTagText,
          };
        }
        // Lightweight tags use default tag color
        return {
          bgColor: theme.refColors.tag,
          textColor: theme.refColors.tagText,
        };
      }
      default:
        return {
          bgColor: theme.refColors.localBranch,
          textColor: theme.refColors.localBranchText,
        };
    }
  }

  /**
   * Get colors for a pull request based on its state
   */
  private getPrColors(pr: GraphPullRequest): { bgColor: string; textColor: string } {
    const { theme } = this;

    if (pr.draft) {
      return {
        bgColor: theme.prColors.draft,
        textColor: theme.prColors.draftText,
      };
    }

    switch (pr.state.toLowerCase()) {
      case 'open':
        return {
          bgColor: theme.prColors.open,
          textColor: theme.prColors.openText,
        };
      case 'closed':
        return {
          bgColor: theme.prColors.closed,
          textColor: theme.prColors.closedText,
        };
      case 'merged':
        return {
          bgColor: theme.prColors.merged,
          textColor: theme.prColors.mergedText,
        };
      default:
        return {
          bgColor: theme.prColors.open,
          textColor: theme.prColors.openText,
        };
    }
  }

  /**
   * Draw a pull request icon (merge request style)
   */
  private drawPrIcon(x: number, y: number, size: number): void {
    const { ctx } = this;
    const s = size / 24;
    const top = y - size / 2;
    const left = x;

    ctx.save();
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Draw merge/PR icon - two circles connected by curved line
    // Top circle
    ctx.beginPath();
    ctx.arc(left + 6 * s, top + 6 * s, 3 * s, 0, Math.PI * 2);
    ctx.stroke();

    // Bottom circle
    ctx.beginPath();
    ctx.arc(left + 18 * s, top + 18 * s, 3 * s, 0, Math.PI * 2);
    ctx.stroke();

    // Connecting line with arrow
    ctx.beginPath();
    ctx.moveTo(left + 6 * s, top + 9 * s);
    ctx.lineTo(left + 6 * s, top + 12 * s);
    ctx.quadraticCurveTo(left + 6 * s, top + 18 * s, left + 15 * s, top + 18 * s);
    ctx.stroke();

    // Arrow head
    ctx.beginPath();
    ctx.moveTo(left + 12 * s, top + 15 * s);
    ctx.lineTo(left + 15 * s, top + 18 * s);
    ctx.lineTo(left + 12 * s, top + 21 * s);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Draw a filled rounded rectangle
   */
  private drawRoundedRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number
  ): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Stroke a rounded rectangle
   */
  private strokeRoundedRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number
  ): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.stroke();
  }

  /**
   * Render FPS counter
   */
  private renderFps(): void {
    const { ctx, theme } = this;
    const stats = this.perfMonitor.getStats();

    ctx.fillStyle = stats.fps >= 55 ? theme.fpsColor : stats.fps >= 30 ? '#f59e0b' : '#ef4444';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${stats.fps} FPS`, 8, 8);

    ctx.fillStyle = theme.textColor;
    ctx.font = '10px monospace';
    ctx.fillText(`${stats.avgMs.toFixed(1)}ms`, 8, 24);
  }

  /**
   * Get color for a branch line by its stable color index
   */
  private getBranchColor(colorIndex: number): string {
    return this.theme.laneColors[colorIndex % this.theme.laneColors.length];
  }

  /**
   * Get performance stats
   */
  getPerformanceStats(): ReturnType<PerformanceMonitor['getStats']> {
    return this.perfMonitor.getStats();
  }

  /**
   * Check if a point is over an avatar and return author info
   * @param x X coordinate relative to canvas (accounting for scroll)
   * @param y Y coordinate relative to canvas (accounting for scroll)
   * @returns Author info if hovering over avatar, null otherwise
   */
  getAvatarAtPoint(x: number, y: number): { authorName: string; authorEmail: string; oid: string } | null {
    for (const hitbox of this.avatarHitboxes) {
      const dx = x - hitbox.x;
      const dy = y - hitbox.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance <= hitbox.radius) {
        return {
          authorName: hitbox.authorName,
          authorEmail: hitbox.authorEmail,
          oid: hitbox.oid,
        };
      }
    }
    return null;
  }

  /**
   * Check if a point is over a ref label and return label info
   * @param x X coordinate relative to canvas
   * @param y Y coordinate relative to canvas
   * @returns Label info if hovering over ref label, null otherwise
   */
  getRefLabelAtPoint(x: number, y: number): {
    label: string;
    fullName: string;
    refType: string;
    isHead?: boolean;
    isAnnotated?: boolean;
    tagMessage?: string;
  } | null {
    for (const hitbox of this.refLabelHitboxes) {
      if (x >= hitbox.x && x <= hitbox.x + hitbox.width &&
          y >= hitbox.y && y <= hitbox.y + hitbox.height) {
        return {
          label: hitbox.label,
          fullName: hitbox.fullName,
          refType: hitbox.refType,
          isHead: hitbox.isHead,
          isAnnotated: hitbox.isAnnotated,
          tagMessage: hitbox.tagMessage,
        };
      }
    }
    return null;
  }

  /**
   * Check if a point is over an overflow indicator and return hidden labels
   * @param x X coordinate relative to canvas
   * @param y Y coordinate relative to canvas
   * @returns Hidden labels if hovering over overflow indicator, null otherwise
   */
  getOverflowAtPoint(x: number, y: number): { hiddenLabels: string[] } | null {
    for (const hitbox of this.overflowHitboxes) {
      if (x >= hitbox.x && x <= hitbox.x + hitbox.width &&
          y >= hitbox.y && y <= hitbox.y + hitbox.height) {
        return {
          hiddenLabels: hitbox.hiddenLabels,
        };
      }
    }
    return null;
  }

  /**
   * Reset performance monitoring
   */
  resetPerformance(): void {
    this.perfMonitor.reset();
  }

  /**
   * Schedule a render on next animation frame
   */
  scheduleRender(data: RenderData): void {
    if (this.pendingFrame) return;

    this.pendingFrame = requestAnimationFrame(() => {
      this.pendingFrame = 0;
      this.render(data);
    });
  }

  /**
   * Cancel pending render
   */
  cancelRender(): void {
    if (this.pendingFrame) {
      cancelAnimationFrame(this.pendingFrame);
      this.pendingFrame = 0;
    }
  }

  /**
   * Get column boundary positions for resize handle placement
   * @param maxLane The maximum lane number from the graph layout
   * @param offsetX The X offset for the graph
   * @returns Object with column boundary X positions
   */
  getColumnBoundaries(maxLane: number, offsetX: number): {
    refsEnd: number;
    statsStart: number;
  } {
    const { config } = this;

    // Calculate column positions (must match renderRefLabels logic)
    const graphEndX = offsetX + (maxLane + 1) * config.laneWidth;
    const avatarColumnX = graphEndX + 20;
    const avatarSize = 22;
    const refsColumnX = avatarColumnX + avatarSize + 8;
    const refsColumnWidth = config.refsColumnWidth;

    const { statsColumnX } = this.getRightColumnLayout();

    return {
      refsEnd: refsColumnX + refsColumnWidth,
      statsStart: statsColumnX,
    };
  }

  /**
   * Get current column widths from config
   */
  getColumnWidths(): { refsColumnWidth: number; statsColumnWidth: number } {
    return {
      refsColumnWidth: this.config.refsColumnWidth,
      statsColumnWidth: this.config.statsColumnWidth,
    };
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.cancelRender();
    this.dprMediaQuery?.removeEventListener('change', this.handleDprChange);
    this.dprMediaQuery = null;
    // Abort pending avatar loads to release closure references
    this.abortPendingAvatarLoads();
    this.avatarCache.clear();
    this.failedAvatars.clear();
    this.commitStats.clear();
    this.commitSignatures.clear();
    this.highlightedOids.clear();
    this.truncationCache.clear();
    this.absoluteDateCache.clear();
  }
}

/**
 * Sort refs so the most important ones display first when space is limited.
 * Priority: HEAD > local branches > remote-only branches > remote duplicates > tags
 *
 * A "remote-only" branch is one like origin/new-nonprod-cert-dv3 where there's
 * no corresponding local branch. A "remote duplicate" is like origin/feature/foo
 * when local feature/foo already exists on the same commit.
 */
export function sortRefsForDisplay(refs: RefInfo[]): RefInfo[] {
  if (refs.length <= 1) return refs;

  // Build a set of local branch shorthands for duplicate detection
  const localBranchNames = new Set<string>();
  for (const ref of refs) {
    if (ref.refType === 'localBranch') {
      localBranchNames.add(ref.shorthand);
    }
  }

  return [...refs].sort((a, b) => {
    const aPriority = getRefSortPriority(a, localBranchNames);
    const bPriority = getRefSortPriority(b, localBranchNames);
    if (aPriority !== bPriority) return aPriority - bPriority;
    // Within the same priority, shorter names first (more likely to fit)
    return a.shorthand.length - b.shorthand.length;
  });
}

/**
 * Get sort priority for a ref (lower = higher priority).
 */
function getRefSortPriority(ref: RefInfo, localBranchNames: Set<string>): number {
  if (ref.isHead) return 0;
  if (ref.refType === 'localBranch') return 1;
  if (ref.refType === 'remoteBranch') {
    // Check if this remote branch has a local counterpart
    // Remote shorthand is like "origin/feature/foo", strip remote prefix
    const slashIndex = ref.shorthand.indexOf('/');
    const branchName = slashIndex >= 0 ? ref.shorthand.substring(slashIndex + 1) : ref.shorthand;
    return localBranchNames.has(branchName) ? 3 : 2;
  }
  return 4; // tags
}
