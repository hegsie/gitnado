import { LitElement, html, css } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { loggers, openExternalUrl } from '../../utils/index.ts';

const log = loggers.graph;
import {
  computeGraphLayout,
  type GraphLayout,
  type LayoutNode,
} from '../../graph/graph-layout.service.ts';
import { appendLanes, type GraphCommit } from '../../graph/lane-assignment.ts';
import { SpatialIndex, type HitTestResult } from '../../graph/spatial-index.ts';
import {
  VirtualScrollManager,
  ScrollStateManager,
  type Viewport,
  type RenderData,
} from '../../graph/virtual-scroll.ts';
import { CanvasRenderer, getThemeFromCSS } from '../../graph/canvas-renderer.ts';
import {
  getCommitHistory,
  getCommitTotal,
  getRefsByCommit,
  getCommitsStats,
  getCommitsSignatures,
  searchCommits,
  detectGitHubRepo,
  listPullRequests,
  checkGitHubConnection,
} from '../../services/git.service.ts';
import type { Commit, RefsByCommit, RefInfo } from '../../types/git.types.ts';
import type { GraphPullRequest } from '../../graph/virtual-scroll.ts';
import { searchIndexService } from '../../services/search-index.service.ts';
import { embeddingIndexService } from '../../services/embedding-index.service.ts';
import { settingsStore } from '../../stores/settings.store.ts';

/**
 * Per-repository cache of the last loaded commit page. Switching back to an
 * already-visited tab renders instantly from this cache while a background
 * reload revalidates it — without it every tab switch pays a full backend
 * history walk. Bounded LRU so many open repos can't grow memory unbounded.
 */
interface GraphCacheEntry {
  commits: Commit[];
  refsByCommit: RefsByCommit;
  hasMore: boolean;
}

const GRAPH_CACHE_MAX_REPOS = 8;
// Map iteration order is insertion order; re-inserting on write keeps the
// oldest entry first for LRU eviction.
const graphCache = new Map<string, GraphCacheEntry>();

function cacheGraphPage(path: string, entry: GraphCacheEntry): void {
  graphCache.delete(path);
  graphCache.set(path, entry);
  if (graphCache.size > GRAPH_CACHE_MAX_REPOS) {
    const oldest = graphCache.keys().next().value;
    if (oldest !== undefined) {
      graphCache.delete(oldest);
    }
  }
}

/**
 * Evict a repo's cached graph page — called when its tab closes so a
 * different repository later opened at the same path can't flash the old
 * repo's graph before revalidation.
 */
export function evictGraphCache(path: string): void {
  graphCache.delete(path);
}

/** Test hook: clear the module-level graph cache */
export function clearGraphCacheForTests(): void {
  graphCache.clear();
}

export interface CommitSelectedEvent {
  commit: Commit | null;
  commits: Commit[]; // All selected commits for multi-select
  refs: RefInfo[];
}

/**
 * Convert a real git Commit to GraphCommit format for graph layout
 */
function commitToGraphCommit(commit: Commit): GraphCommit {
  return {
    oid: commit.oid,
    parentIds: commit.parentIds,
    timestamp: commit.timestamp,
    message: commit.summary,
    author: commit.author.name,
  };
}

/**
 * Optimized Graph Canvas Component
 *
 * High-performance graph visualization with:
 * - Virtual scrolling (only renders visible content)
 * - Spatial index for O(1) hit testing
 * - 60fps rendering with FPS monitoring
 * - Smooth momentum scrolling
 */
@customElement('lv-graph-canvas')
export class LvGraphCanvas extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }

      .container {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: var(--color-bg-primary);
      }

      .canvas-container {
        flex: 1;
        overflow: hidden;
        position: relative;
      }

      canvas {
        display: block;
        position: absolute;
        top: 0;
        left: 0;
        cursor: default;
        outline: none;
        z-index: 2; /* Above scroll container but scrollbar is outside canvas bounds */
      }

      canvas:focus {
        outline: 2px solid var(--color-primary);
        outline-offset: -2px;
      }

      canvas.pointer {
        cursor: pointer;
      }

      .scroll-container {
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        width: 12px;
        overflow-y: scroll;
        overflow-x: hidden;
        z-index: 3; /* Above canvas for scrollbar interaction */
      }

      .scroll-container::-webkit-scrollbar {
        width: 12px;
      }

      .scroll-container::-webkit-scrollbar-track {
        background: var(--color-bg-secondary);
        border-left: 1px solid var(--color-border);
      }

      .scroll-container::-webkit-scrollbar-thumb {
        background: var(--color-text-muted);
        border-radius: 6px;
        border: 3px solid var(--color-bg-secondary);
      }

      .scroll-container::-webkit-scrollbar-thumb:hover {
        background: var(--color-text-secondary);
      }

      .scroll-content {
        position: relative;
      }

      .overlay-canvas {
        position: absolute;
        top: 0;
        left: 0;
        pointer-events: none;
      }

      .info-panel {
        position: absolute;
        bottom: var(--spacing-md);
        left: var(--spacing-md);
        /*
         * The canvas sits at z-index 2 and paints an opaque background, so
         * without this the panel (and its Retry button) is drawn UNDER the
         * graph — invisible and unclickable.
         */
        z-index: 10;
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        font-size: var(--font-size-sm);
        max-width: 350px;
        box-shadow: var(--shadow-md);
      }

      .info-panel .oid {
        font-family: var(--font-family-mono);
        color: var(--color-primary);
        font-size: var(--font-size-xs);
      }

      .info-panel .message {
        margin-top: var(--spacing-xs);
        color: var(--color-text-primary);
        font-weight: var(--font-weight-medium);
      }

      .info-panel .meta {
        margin-top: var(--spacing-xs);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .info-panel.error-panel {
        background: var(--color-error-bg);
        border-color: var(--color-error);
      }

      .info-panel .error-title {
        color: var(--color-error);
        font-weight: var(--font-weight-bold);
      }

      .info-panel .panel-actions {
        margin-top: var(--spacing-sm);
        display: flex;
        justify-content: flex-end;
      }

      .retry-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-xs);
        cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease;
      }

      .retry-btn:hover:not(:disabled) {
        background: var(--color-bg-hover);
      }

      .retry-btn:disabled {
        opacity: 0.6;
        cursor: default;
      }

      /*
       * Centered overlay for the two whole-graph states (loading the first
       * page, and a repository with no commits at all). Deliberately NOT the
       * bottom-right .loading-indicator slot, which belongs to the
       * incremental stats/pagination spinners and would otherwise stack.
       */
      .graph-overlay {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--spacing-xs);
        padding: var(--spacing-md) var(--spacing-lg);
        max-width: 320px;
        text-align: center;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-md);
        pointer-events: none;
        z-index: 5;
      }

      .graph-overlay .overlay-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
      }

      .graph-overlay .overlay-hint {
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        line-height: 1.5;
      }

      .graph-overlay .spinner {
        width: 16px;
        height: 16px;
        border: 2px solid var(--color-border);
        border-top-color: var(--color-primary);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      @media (prefers-reduced-motion: reduce) {
        .graph-overlay .spinner,
        .loading-indicator .spinner {
          animation-duration: 2s;
        }
      }

      .avatar-tooltip {
        position: fixed;
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
        box-shadow: var(--shadow-md);
        pointer-events: none;
        z-index: var(--z-tooltip, 1000);
        white-space: nowrap;
        opacity: 0;
        transition: opacity 0.15s ease;
      }

      .avatar-tooltip.visible {
        opacity: 1;
      }

      .avatar-tooltip .author-name {
        font-weight: var(--font-weight-medium);
      }

      .avatar-tooltip .author-email {
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        margin-top: 2px;
      }

      .loading-indicator {
        position: absolute;
        bottom: var(--spacing-md);
        right: calc(var(--spacing-md) + 12px); /* Account for scrollbar */
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        box-shadow: var(--shadow-sm);
        opacity: 0.9;
        z-index: 10;
      }

      .loading-indicator .spinner {
        width: 12px;
        height: 12px;
        border: 2px solid var(--color-border);
        border-top-color: var(--color-primary);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      .graph-toolbar {
        position: absolute;
        top: 0;
        right: calc(var(--spacing-md) + 12px);
        height: 28px;
        display: flex;
        align-items: center;
        gap: 2px;
        z-index: 10;
      }

      .toolbar-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 22px;
        padding: 0 var(--spacing-xs);
        gap: 4px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-secondary);
        color: var(--color-text-secondary);
        cursor: pointer;
        font-size: 10px;
        transition: background 0.15s ease, color 0.15s ease;
      }

      .toolbar-btn svg {
        width: 12px;
        height: 12px;
      }

      .toolbar-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .toolbar-btn.active {
        background: var(--color-primary);
        color: white;
      }

      .branch-panel {
        position: absolute;
        top: 36px;
        right: calc(var(--spacing-md) + 12px);
        width: 260px;
        max-height: 400px;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        z-index: 20;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      .branch-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm) var(--spacing-md);
        border-bottom: 1px solid var(--color-border);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
      }

      .branch-panel-actions {
        display: flex;
        gap: var(--spacing-xs);
      }

      .branch-panel-actions button {
        font-size: var(--font-size-xs);
        padding: 2px 6px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-secondary);
        cursor: pointer;
      }

      .branch-panel-actions button:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .branch-panel-list {
        overflow-y: auto;
        padding: var(--spacing-xs) 0;
        flex: 1;
      }

      .branch-group-label {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        padding: var(--spacing-xs) var(--spacing-md);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        font-weight: var(--font-weight-medium);
      }

      .branch-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: 3px var(--spacing-md);
        cursor: pointer;
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
      }

      .branch-item:hover {
        background: var(--color-bg-hover);
      }

      .branch-item input[type="checkbox"] {
        margin: 0;
        cursor: pointer;
      }

      .branch-item .branch-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
      }

      .export-menu {
        position: absolute;
        top: 36px;
        right: calc(var(--spacing-md) + 12px + 32px);
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        z-index: 20;
        overflow: hidden;
        min-width: 160px;
      }

      .export-menu-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
        cursor: pointer;
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
        border: none;
        background: none;
        width: 100%;
        text-align: left;
      }

      .export-menu-item:hover {
        background: var(--color-bg-hover);
      }

      .minimap-canvas {
        position: absolute;
        top: 28px; /* Below the column headers */
        bottom: 0;
        /* The shared canvas rule sets left: 0; without this override the
           box is over-constrained and right is ignored, parking the
           minimap on the LEFT over the graph */
        left: auto;
        right: 12px; /* Left of the scrollbar */
        width: 56px;
        background: var(--color-bg-secondary);
        border-left: 1px solid var(--color-border);
        opacity: 0.92;
        z-index: 4;
        cursor: pointer;
      }

      /* Visually hidden but exposed to assistive technology */
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

      .resize-handle {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 6px;
        cursor: col-resize;
        background: transparent;
        z-index: 10;
        margin-left: -3px;
      }

      .resize-handle:hover,
      .resize-handle.dragging {
        background: var(--color-primary);
        opacity: 0.5;
      }

      /* ===========================================================
         Forced colors (Windows High Contrast Mode)
         The graph itself is canvas pixels the OS cannot recolor —
         that is handled by auto-selecting the high-contrast palette
         in settings.store.ts. This block only keeps the DOM chrome
         around the canvas usable: focus rings and the states that
         are otherwise shown by a custom background alone.
         =========================================================== */
      @media (forced-colors: active) {
        canvas:focus,
        canvas:focus-visible {
          outline: 3px solid Highlight;
          outline-offset: -3px;
        }

        .toolbar-btn:focus-visible,
        .export-menu-item:focus-visible,
        .branch-item:focus-within {
          outline: 2px solid Highlight;
          outline-offset: -2px;
        }

        .toolbar-btn.active,
        .toolbar-btn:hover,
        .branch-item:hover,
        .export-menu-item:hover,
        .branch-panel-actions button:hover {
          background: Highlight;
          color: HighlightText;
        }

        /* The minimap is a canvas overlay: forced colors leaves its pixels
           alone, so give it a real edge and full opacity instead of the
           translucent seam that disappears against a forced background. */
        .minimap-canvas {
          opacity: 1;
          border-left: 1px solid CanvasText;
        }

        .resize-handle:hover,
        .resize-handle.dragging {
          background: Highlight;
          opacity: 1;
        }
      }
    `,
  ];

  @property({ type: Number }) commitCount = 1000;
  @property({ type: String }) repositoryPath = '';
  @property({ type: Object }) searchFilter: { query: string; author: string; dateFrom: string; dateTo: string; filePath: string; branch: string; searchMode?: string } | null = null;

  @state() private layout: GraphLayout | null = null;
  @state() private selectedNode: LayoutNode | null = null; // Primary selection (for details panel)
  @state() private selectedNodes: Set<string> = new Set(); // All selected OIDs (for multi-select)
  @state() private lastClickedNode: LayoutNode | null = null; // For Shift-click range selection
  @state() private hoveredNode: LayoutNode | null = null;
  @state() private fps = 0;
  @state() private renderTimeMs = 0;
  @state() private visibleNodes = 0;
  @state() private isLoading = false;
  @state() private isLoadingStats = false;
  @state() private loadError: string | null = null;
  // True once a load for the CURRENT repository has run to completion
  // (success, failure, or an instant cached render). Without it the very
  // first render — before firstUpdated has had a chance to start the load —
  // would flash the "no commits yet" panel over every repository.
  @state() private hasCompletedLoad = false;
  @state() private tooltipVisible = false;
  @state() private tooltipX = 0;
  @state() private tooltipY = 0;
  @state() private tooltipAuthorName = '';
  @state() private tooltipAuthorEmail = '';

  // Branch visibility
  @state() private hiddenBranches: Set<string> = new Set();
  @state() private showBranchPanel = false;

  // Export
  @state() private showExportMenu = false;

  // Dropdown menus anchor to the toolbar button that opened them. Measured
  // at open time (not hardcoded) so adding/reordering toolbar buttons can't
  // silently detach a menu from its trigger.
  @state() private exportMenuRight: number | null = null;
  @state() private columnsMenuRight: number | null = null;

  /** Distance from the container's right edge to the trigger's right edge */
  private menuRightOffset(e: MouseEvent): number {
    const button = e.currentTarget as HTMLElement | null;
    if (!button || !this.containerEl) return 0;
    const containerRect = this.containerEl.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    return Math.max(0, containerRect.right - buttonRect.right);
  }

  // Optional columns (author name, absolute date)
  @state() private showColumnsMenu = false;
  @state() private showAuthorColumn = false;
  @state() private showDateColumn = false;
  private readonly OPTIONAL_COLUMNS_KEY = 'gitnado-graph-optional-columns';

  // Minimap
  @state() private showMinimap = true;
  private readonly MINIMAP_KEY = 'gitnado-graph-minimap';
  private readonly MINIMAP_WIDTH = 56;
  /** Offscreen layer with one dot per commit, rebuilt on layout changes */
  private minimapDots: HTMLCanvasElement | null = null;
  private minimapDragging = false;

  // Infinite scroll pagination
  @state() private isLoadingMore = false;
  @state() private hasMoreCommits = true;
  // True total commit count across all refs (null until fetched)
  @state() private commitTotal: number | null = null;
  // @state so the empty-state panel and the canvas aria-label repaint when a
  // load lands on zero commits (nothing else in that path changes)
  @state() private totalLoadedCommits = 0;
  // How many commits were loaded the last time the selection was validated
  // against the layout — the high-water mark validateSelection() needs to
  // tell "this commit is gone" apart from "this page isn't back yet"
  private validatedCommitCount = 0;

  // Screen-reader mirror of the visible rows + selection announcements.
  // The canvas itself has no DOM semantics, so a hidden listbox mirrors the
  // virtual scroll window and a live region announces selection changes.
  @state() private mirrorNodes: LayoutNode[] = [];
  @state() private srAnnouncement = '';
  private lastMirrorKey = '';

  // Column resize state
  @state() private refsColumnWidth = 200;
  @state() private statsColumnWidth = 80;
  @state() private resizing: 'refs' | 'stats' | null = null;
  private resizeStartX = 0;
  private resizeStartWidth = 0;
  private readonly COLUMN_STORAGE_KEY = 'gitnado-graph-columns';
  private readonly BRANCH_VISIBILITY_KEY = 'gitnado-hidden-branches';

  @query('.canvas-container') private containerEl!: HTMLDivElement;
  @query('canvas[role="img"]') private canvasEl!: HTMLCanvasElement;
  @query('.scroll-container') private scrollEl!: HTMLDivElement;
  @query('.minimap-canvas') private minimapEl?: HTMLCanvasElement;

  private commits: GraphCommit[] = [];
  private realCommits: Map<string, Commit> = new Map();
  private matchedCommitOids: Set<string> = new Set(); // For search highlighting
  // Semantic search re-runs on every keystroke (the search bar has no
  // debounce), so the "semantic search unavailable" notice is shown once per
  // repo and re-armed only when a semantic search succeeds again.
  private semanticFailureNotifiedFor: string | null = null;
  // Same no-debounce reasoning for the direct commit search: a failing
  // pathspec or branch name would otherwise toast once per keystroke.
  private searchFailureNotifiedFor: string | null = null;
  private refsByCommit: RefsByCommit = {};
  private loadVersion = 0; // Incremented on each load to cancel stale requests
  private statsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Periodic repaint so relative timestamps ("2m", "5h") don't go stale
  private relativeTimeTimer: ReturnType<typeof setInterval> | null = null;
  private lastLoadedRepoPath: string | null = null; // Track the last repo that completed loading
  private inFlightLoadPath: string | null = null; // Repo whose loadCommits is currently in flight
  // A refresh arrived while a load was in flight; that load's snapshot may
  // predate the mutation the refresh was for, so one follow-up load runs
  // when it finishes
  private reloadQueued = false;
  private pullRequestsByCommit: Record<string, GraphPullRequest[]> = {};
  private githubRepo: { owner: string; repo: string } | null = null;
  private renderer: CanvasRenderer | null = null;
  private virtualScroll: VirtualScrollManager | null = null;
  private spatialIndex: SpatialIndex | null = null;
  private scrollState: ScrollStateManager | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private settingsUnsubscribe: (() => void) | null = null;
  private mediaQuery: MediaQueryList | null = null;
  private animationFrame = 0;
  private lastRenderData: RenderData | null = null;
  private sortedNodesByRow: LayoutNode[] = [];

  // Stats/signatures accumulated per commit OID. Fetched lazily for the
  // visible row range only (a commit's stats never change for a given OID,
  // so entries stay valid across reloads of the same repo).
  private commitStatsMap: Map<string, { additions: number; deletions: number; filesChanged: number }> = new Map();
  private commitSignaturesMap: Map<string, { signed: boolean; valid: boolean }> = new Map();
  private statsFetchedOids: Set<string> = new Set();
  private signaturesFetchedOids: Set<string> = new Set();

  // Config - base metrics at zoom 1.0 (compact size)
  private static readonly BASE_ROW_HEIGHT = 22;
  private static readonly BASE_LANE_WIDTH = 16;
  private static readonly BASE_NODE_RADIUS = 6;
  private static readonly MIN_ZOOM = 0.6;
  private static readonly MAX_ZOOM = 2;
  private readonly ZOOM_STORAGE_KEY = 'gitnado-graph-zoom';
  /** Density factor applied to row height / lane width / node radius */
  private zoomLevel = 1;
  // Wheel-zoom ticks accumulate here and apply once per animation frame
  private pendingZoomTarget: number | null = null;
  private zoomFrame = 0;
  private readonly PADDING = 20;
  private readonly HEADER_HEIGHT = 28; // Must match canvas-renderer.ts
  // Rows beyond the viewport whose stats/signatures are prefetched
  private readonly DATA_FETCH_OVERSCAN_ROWS = 100;

  private get ROW_HEIGHT(): number {
    return Math.round(LvGraphCanvas.BASE_ROW_HEIGHT * this.zoomLevel);
  }
  private get LANE_WIDTH(): number {
    return Math.round(LvGraphCanvas.BASE_LANE_WIDTH * this.zoomLevel);
  }
  private get NODE_RADIUS(): number {
    return Math.max(3, Math.round(LvGraphCanvas.BASE_NODE_RADIUS * this.zoomLevel));
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.loadColumnWidths();
    this.loadHiddenBranches();
    this.loadZoomLevel();
    this.loadOptionalColumns();
    this.loadMinimapPreference();
  }

  private loadMinimapPreference(): void {
    try {
      const saved = localStorage.getItem(this.MINIMAP_KEY);
      if (saved !== null) {
        this.showMinimap = saved === 'true';
      }
    } catch {
      // Ignore storage errors, keep default
    }
  }

  /** Toggle the minimap overview strip */
  public async toggleMinimap(): Promise<void> {
    this.showMinimap = !this.showMinimap;
    try {
      localStorage.setItem(this.MINIMAP_KEY, String(this.showMinimap));
    } catch {
      // Ignore storage errors
    }
    await this.updateComplete;
    if (this.showMinimap) {
      this.resizeMinimap();
      this.rebuildMinimapDots();
      this.renderMinimap();
    }
  }

  private loadOptionalColumns(): void {
    try {
      const saved = localStorage.getItem(this.OPTIONAL_COLUMNS_KEY);
      if (saved) {
        const { author, date } = JSON.parse(saved);
        this.showAuthorColumn = author === true;
        this.showDateColumn = date === true;
      }
    } catch {
      // Ignore parse errors, keep defaults
    }
  }

  private saveOptionalColumns(): void {
    try {
      localStorage.setItem(
        this.OPTIONAL_COLUMNS_KEY,
        JSON.stringify({ author: this.showAuthorColumn, date: this.showDateColumn })
      );
    } catch {
      // Ignore storage errors
    }
  }

  /** Toggle the optional author/date columns */
  public toggleOptionalColumn(column: 'author' | 'date'): void {
    if (column === 'author') {
      this.showAuthorColumn = !this.showAuthorColumn;
    } else {
      this.showDateColumn = !this.showDateColumn;
    }
    this.saveOptionalColumns();
    this.renderer?.setConfig({
      showAuthorColumn: this.showAuthorColumn,
      showDateColumn: this.showDateColumn,
    });
    this.renderer?.markDirty();
    this.scheduleRender();
  }

  private loadZoomLevel(): void {
    try {
      const saved = localStorage.getItem(this.ZOOM_STORAGE_KEY);
      if (saved) {
        const zoom = parseFloat(saved);
        if (Number.isFinite(zoom)) {
          this.zoomLevel = Math.min(
            LvGraphCanvas.MAX_ZOOM,
            Math.max(LvGraphCanvas.MIN_ZOOM, zoom)
          );
        }
      }
    } catch {
      // Ignore storage errors, keep default zoom
    }
  }

  private saveZoomLevel(): void {
    try {
      localStorage.setItem(this.ZOOM_STORAGE_KEY, String(this.zoomLevel));
    } catch {
      // Ignore storage errors
    }
  }

  /** Current zoom/density factor */
  public getZoom(): number {
    return this.zoomLevel;
  }

  /**
   * Set the zoom/density factor (clamped). Scales row height, lane width
   * and node radius, keeps the viewport anchored, and persists the value.
   */
  public setZoom(zoom: number): void {
    const clamped = Math.min(
      LvGraphCanvas.MAX_ZOOM,
      Math.max(LvGraphCanvas.MIN_ZOOM, zoom)
    );
    if (Math.abs(clamped - this.zoomLevel) < 0.001) return;

    const previousScroll = this.scrollState?.getScroll();
    const previousRowHeight = this.ROW_HEIGHT;
    const previousLaneWidth = this.LANE_WIDTH;

    this.zoomLevel = clamped;
    this.saveZoomLevel();

    // Reconfigure every subsystem that bakes the metrics in
    this.virtualScroll?.setConfig({
      rowHeight: this.ROW_HEIGHT,
      laneWidth: this.LANE_WIDTH,
    });
    this.renderer?.setConfig({
      rowHeight: this.ROW_HEIGHT,
      laneWidth: this.LANE_WIDTH,
      nodeRadius: this.NODE_RADIUS,
      minNodeRadius: Math.max(3, Math.round(5 * this.zoomLevel)),
      maxNodeRadius: Math.max(4, Math.round(10 * this.zoomLevel)),
    });
    this.buildSpatialIndex();
    this.updateScrollContentSize();

    // Keep the viewport anchored on the same rows AND lanes across the
    // zoom change (both axes scale with the zoom factor)
    if (previousScroll && this.scrollState && this.virtualScroll) {
      const ratioY = this.ROW_HEIGHT / previousRowHeight;
      const ratioX = this.LANE_WIDTH / previousLaneWidth;
      const size = this.virtualScroll.getContentSize();
      const viewport = this.getViewport();
      const maxScrollY = Math.max(0, size.height - viewport.height);
      const maxScrollX = Math.max(0, size.width - viewport.width);
      this.scrollState.setScroll(
        Math.min(previousScroll.scrollTop * ratioY, maxScrollY),
        Math.min(previousScroll.scrollLeft * ratioX, maxScrollX)
      );
      this.syncScrollbarPosition();
    }

    this.renderer?.markDirty();
    this.scheduleRender();
    // zoomLevel is not a reactive property, but the DOM resize handles are
    // positioned from renderer config inside render() — re-render so their
    // hit targets track the new column boundaries
    this.requestUpdate();
  }

  async firstUpdated(): Promise<void> {
    await this.updateComplete;
    this.initializeSystems();
    this.generateAndLayout();
    this.setupEventListeners();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.cleanup();
  }

  willUpdate(changedProperties: Map<string, unknown>): void {
    // Reload when repository path changes
    if (changedProperties.has('repositoryPath') && changedProperties.get('repositoryPath') !== undefined) {
      // Clear existing state when switching repositories
      this.layout = null;
      this.selectedNode = null;
      this.selectedNodes.clear();
      this.lastClickedNode = null;
      this.hoveredNode = null;
      this.realCommits.clear();
      this.refsByCommit = {};
      // A catch-up load in flight for the previous repo must not block the
      // new repo's pagination (its own version guard discards its results)
      this.isLoadingMore = false;

      // Stats/signatures are keyed by commit OID, which is repo-specific —
      // drop the previous repo's data so memory stays bounded
      this.commitStatsMap.clear();
      this.commitSignaturesMap.clear();
      this.statsFetchedOids.clear();
      this.signaturesFetchedOids.clear();
      this.renderer?.setCommitStats(this.commitStatsMap);
      this.renderer?.setCommitSignatures(this.commitSignaturesMap);

      // The previous repo's search matches must not dim the new repo's
      // cached graph (a stale non-empty set dims EVERY node because none of
      // the new repo's OIDs are in it). loadCommits clears this too, but
      // only after its IPC round-trip — the cached render is synchronous.
      this.matchedCommitOids.clear();
      this.renderer?.setHighlightedCommits(this.matchedCommitOids);

      // Keyboard navigation and the SR mirror must not act on the previous
      // repo's rows during the load gap (an arrow key would select a node
      // whose commit no longer exists in realCommits)
      this.sortedNodesByRow = [];
      this.mirrorNodes = [];
      this.lastMirrorKey = '';

      // PRs are keyed by OID; on a fork/upstream switch the shared OIDs
      // would show (clickable!) badges for the WRONG repository's pull
      // requests on the cached render until the background GitHub fetch
      // resolves
      this.pullRequestsByCommit = {};
      this.githubRepo = null;
      this.virtualScroll?.setPullRequests(this.pullRequestsByCommit);

      // Toolbar dropdowns belong to the previous repo's context — don't
      // leave them floating open over the new repo's graph
      this.showBranchPanel = false;
      this.showExportMenu = false;
      this.showColumnsMenu = false;

      // The previous repo's completed load says nothing about this one — and
      // its commit count is about to be replaced, so clear both before the
      // load starts or the empty state would flash between repositories
      this.hasCompletedLoad = false;
      this.totalLoadedCommits = 0;

      // Reload hidden branches for the new repository
      this.loadHiddenBranches();

      // A reload queued for the PREVIOUS repo must not leak into this one
      this.reloadQueued = false;
      this.commitTotal = null;
      // The new repo's first page must be free to prune its own selection —
      // the previous repo's paging depth says nothing about this one
      this.validatedCommitCount = 0;
      // Clear any stats spinner owned by the previous repo — the new repo's
      // fetch (if any) will set it again; a repo with no stats to fetch must
      // not inherit the old spinner
      this.isLoadingStats = false;

      // Render instantly from the per-repo cache when switching back to a
      // visited tab, then revalidate in the background (no spinner). A repo
      // seen for the first time takes the normal loading path.
      const cached = graphCache.get(this.repositoryPath);
      if (cached) {
        this.applyCachedGraph(cached);
        this.loadCommits({ background: true });
      } else {
        this.loadCommits();
      }
    }

    // Reload when search filter changes. Skip when the repository changed in
    // the same update (app-shell clears the filter on tab switch): the
    // repositoryPath branch above already started the right load, and a
    // second FOREGROUND load here would cancel the instant cached render
    // with a spinner.
    if (changedProperties.has('searchFilter') && !changedProperties.has('repositoryPath')) {
      this.loadCommits();
    }
  }

  private initializeSystems(): void {
    // Initialize virtual scroll manager
    this.virtualScroll = new VirtualScrollManager({
      rowHeight: this.ROW_HEIGHT,
      laneWidth: this.LANE_WIDTH,
      padding: this.PADDING,
      overscanRows: 15,
    });

    // Initialize spatial index
    this.spatialIndex = new SpatialIndex({
      cellSize: 60,
      nodeRadius: this.NODE_RADIUS + 6,
      edgeTolerance: 6,
    });
    this.spatialIndex.configure({
      offsetX: this.PADDING,
      offsetY: this.PADDING,
      rowHeight: this.ROW_HEIGHT,
      laneWidth: this.LANE_WIDTH,
    });

    // Initialize renderer with theme from CSS variables
    this.renderer = new CanvasRenderer(
      this.canvasEl,
      {
        rowHeight: this.ROW_HEIGHT,
        laneWidth: this.LANE_WIDTH,
        nodeRadius: this.NODE_RADIUS,
        lineWidth: 2,
        showLabels: true,
        showFps: false, // We show our own FPS
        refsColumnWidth: this.refsColumnWidth,
        statsColumnWidth: this.statsColumnWidth,
        showAuthorColumn: this.showAuthorColumn,
        showDateColumn: this.showDateColumn,
        // The "Show Avatars" app setting controls whether author avatars
        // are fetched from Gravatar (off = colored initials only)
        fetchAvatars: settingsStore.getState().showAvatars,
        // The "Show Commit Size" app setting scales node radius by how much
        // each commit changed (off = uniform nodes)
        scaleNodesByCommitSize: settingsStore.getState().showCommitSize,
      },
      getThemeFromCSS()
    );

    // Keep avatar fetching and node scaling in sync with the settings toggles
    this.settingsUnsubscribe = settingsStore.subscribe((state) => {
      this.renderer?.setConfig({
        fetchAvatars: state.showAvatars,
        scaleNodesByCommitSize: state.showCommitSize,
      });
      this.renderer?.markDirty();
      this.scheduleRender();
    });

    // Listen for theme changes via data-theme attribute, and for graph colour
    // scheme changes via data-graph-scheme — the lane colours live in CSS
    // variables the canvas only re-reads through setTheme(), so without this
    // the palette (including the automatic high-contrast switch) would not
    // reach the already-painted graph.
    this.themeObserver = new MutationObserver(() => {
      this.renderer?.setTheme(getThemeFromCSS());
      this.rebuildMinimapDots();
      this.scheduleRender();
    });
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-graph-scheme'],
    });

    // Also listen for system theme changes
    this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.mediaQuery.addEventListener('change', this.handleThemeChange);

    // Initialize scroll state
    this.scrollState = new ScrollStateManager((scrollTop, scrollLeft) => {
      this.onScroll(scrollTop, scrollLeft);
    });

    // Setup resize observer
    this.resizeObserver = new ResizeObserver(() => {
      this.onResize();
    });
    this.resizeObserver.observe(this.containerEl);

    // The TIME column renders relative timestamps against "now" — repaint
    // periodically so they don't freeze at their initial values
    this.relativeTimeTimer = setInterval(() => {
      this.renderer?.markDirty();
      this.scheduleRender();
    }, 30_000);

    // Initial resize
    this.onResize();
  }

  private setupEventListeners(): void {
    if (!this.containerEl || !this.canvasEl) {
      return;
    }

    // Wheel scrolling on canvas
    this.canvasEl.addEventListener('wheel', this.handleWheel, { passive: false });

    // Native scroll on scrollbar container - sync with internal state
    this.scrollEl.addEventListener('scroll', this.handleNativeScroll);

    // Mouse interactions
    this.canvasEl.addEventListener('mousemove', this.handleMouseMove);
    this.canvasEl.addEventListener('click', this.handleClick);
    this.canvasEl.addEventListener('mouseleave', this.handleMouseLeave);
    this.canvasEl.addEventListener('contextmenu', this.handleContextMenu);

    // Keyboard navigation
    this.canvasEl.addEventListener('keydown', this.handleKeyDown);
  }

  // SAFETY: All observers (ResizeObserver, MutationObserver) and event listeners are
  // properly disconnected/removed in cleanup(), which is called from disconnectedCallback().
  private cleanup(): void {
    // Remove canvas event listeners
    this.canvasEl?.removeEventListener('wheel', this.handleWheel);
    this.scrollEl?.removeEventListener('scroll', this.handleNativeScroll);
    this.canvasEl?.removeEventListener('mousemove', this.handleMouseMove);
    this.canvasEl?.removeEventListener('click', this.handleClick);
    this.canvasEl?.removeEventListener('mouseleave', this.handleMouseLeave);
    this.canvasEl?.removeEventListener('contextmenu', this.handleContextMenu);
    this.canvasEl?.removeEventListener('keydown', this.handleKeyDown);

    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }
    if (this.zoomFrame) {
      cancelAnimationFrame(this.zoomFrame);
      this.zoomFrame = 0;
    }
    if (this.statsDebounceTimer) {
      clearTimeout(this.statsDebounceTimer);
    }
    if (this.relativeTimeTimer) {
      clearInterval(this.relativeTimeTimer);
      this.relativeTimeTimer = null;
    }
    // Clean up resize listeners if still attached
    document.removeEventListener('mousemove', this.handleResizeMove);
    document.removeEventListener('mouseup', this.handleResizeEnd);
    document.removeEventListener('mousemove', this.handleMinimapPointerMove);
    document.removeEventListener('mouseup', this.handleMinimapPointerUp);
    this.renderer?.destroy();
    this.scrollState?.destroy();
    this.resizeObserver?.disconnect();
    this.themeObserver?.disconnect();
    this.settingsUnsubscribe?.();
    this.settingsUnsubscribe = null;
    this.mediaQuery?.removeEventListener('change', this.handleThemeChange);
  }

  private handleThemeChange = (): void => {
    this.renderer?.setTheme(getThemeFromCSS());
  };

  private async generateAndLayout(): Promise<void> {
    await this.loadCommits();
  }

  private hasActiveSearch(): boolean {
    if (!this.searchFilter) return false;
    return !!(
      this.searchFilter.query ||
      this.searchFilter.author ||
      this.searchFilter.dateFrom ||
      this.searchFilter.dateTo ||
      this.searchFilter.filePath ||
      this.searchFilter.branch
    );
  }

  /** Populate the graph synchronously from a cached page (no spinner) */
  private applyCachedGraph(cached: GraphCacheEntry): void {
    this.realCommits.clear();
    for (const commit of cached.commits) {
      this.realCommits.set(commit.oid, commit);
    }
    this.refsByCommit = cached.refsByCommit;
    this.commits = cached.commits.map(commitToGraphCommit);
    this.totalLoadedCommits = cached.commits.length;
    this.hasMoreCommits = cached.hasMore;
    this.isLoading = false;
    this.loadError = null;
    // A cached page is a completed load for this repo: an empty cached page
    // is a genuinely empty repository, so the empty state may show
    this.hasCompletedLoad = true;
    this.processLayout();
  }

  private async loadCommits(options: { background?: boolean } = {}): Promise<void> {
    if (!this.repositoryPath) {
      this.loadError = 'No repository path specified';
      // Nothing was loaded and nothing will be — the error panel owns this
      // state, so the empty-state panel must stay out of it
      this.hasCompletedLoad = false;
      return;
    }

    // Increment version to cancel any in-flight requests from previous loads
    this.loadVersion++;
    const currentVersion = this.loadVersion;
    const repoPath = this.repositoryPath;
    this.inFlightLoadPath = repoPath;
    // This full reload supersedes any in-flight load-more; its (now stale)
    // finally block deliberately won't touch the flag, so reset it here
    this.isLoadingMore = false;

    // A background revalidation keeps showing the (cached) graph instead of
    // flashing the loading state — and its failure must not paint an error
    // banner over a perfectly good cached graph, so loadError is only
    // touched by foreground loads.
    if (!options.background) {
      this.isLoading = true;
      this.loadError = null;
    }
    const startTime = performance.now();

    try {
      const hasSearch = this.hasActiveSearch();

      // Always fetch all commits first
      const [commitsResult, refsResult, githubRepoResult] = await Promise.all([
        getCommitHistory({
          path: repoPath,
          limit: this.commitCount,
          allBranches: true,
        }),
        getRefsByCommit(repoPath),
        detectGitHubRepo(repoPath),
      ]);

      // Abort if a newer load has started
      if (this.loadVersion !== currentVersion) return;

      // Check if we have a GitHub repo and fetch PRs
      if (githubRepoResult.success && githubRepoResult.data) {
        this.githubRepo = {
          owner: githubRepoResult.data.owner,
          repo: githubRepoResult.data.repo,
        };
        // Load PRs in background (don't block render)
        this.loadPullRequests();
      } else {
        this.githubRepo = null;
        this.pullRequestsByCommit = {};
      }

      if (!commitsResult.success || !commitsResult.data) {
        if (options.background) {
          log.warn('Background graph revalidation failed:', commitsResult.error?.message);
        } else {
          this.loadError = commitsResult.error?.message ?? 'Failed to load commits';
        }
        this.isLoading = false;
        return;
      }

      // Store real commits for details panel
      this.realCommits.clear();
      for (const commit of commitsResult.data) {
        this.realCommits.set(commit.oid, commit);
      }

      // Store refs
      this.refsByCommit = refsResult.success && refsResult.data ? refsResult.data : {};

      // If search is active, also fetch matching commits for highlighting
      this.matchedCommitOids.clear();
      // A semantic search that never RAN (model missing, embedding index not
      // built, ONNX error) must not read as "no matches" — remember it so the
      // keyword block below still runs.
      let semanticFailed = false;
      if (hasSearch && this.searchFilter?.searchMode === 'semantic' && this.searchFilter?.query) {
        // Semantic search via embedding index
        try {
          const semanticResults = await embeddingIndexService.semanticSearch(
            repoPath,
            this.searchFilter.query,
            this.commitCount,
          );

          // Abort if a newer load has started
          if (this.loadVersion !== currentVersion) return;

          for (const result of semanticResults) {
            this.matchedCommitOids.add(result.oid);
          }
          // Semantic search works again — re-arm the unavailable notice
          this.semanticFailureNotifiedFor = null;
          log.debug(`Semantic search matched ${this.matchedCommitOids.size} commits`);
        } catch (err) {
          log.warn('Semantic search failed, falling back to keyword search:', err);
          // A superseded load must not notify over the newest one
          if (this.loadVersion !== currentVersion) return;
          semanticFailed = true;
          // The component can't toast itself — app-shell listens for
          // graph-notice (same wiring as the jump-to-HEAD notice).
          if (this.semanticFailureNotifiedFor !== repoPath) {
            this.semanticFailureNotifiedFor = repoPath;
            this.dispatchEvent(
              new CustomEvent('graph-notice', {
                detail: {
                  message: 'Semantic search is unavailable — showing keyword results instead',
                  type: 'info',
                },
                bubbles: true,
                composed: true,
              })
            );
          }
        }
      }
      if (
        hasSearch &&
        this.matchedCommitOids.size === 0 &&
        (this.searchFilter?.searchMode !== 'semantic' || semanticFailed)
      ) {
        // Keyword search: try the search index first for faster results.
        // The index has no file or branch dimension, so a path/branch filter
        // must go straight to the direct search below — asking the index
        // would silently drop that filter and highlight every loaded commit.
        const indexCanAnswer = !this.searchFilter?.filePath && !this.searchFilter?.branch;
        const indexResults = indexCanAnswer
          ? await searchIndexService.search(repoPath, {
              query: this.searchFilter?.query || undefined,
              author: this.searchFilter?.author || undefined,
              dateFrom: this.searchFilter?.dateFrom
                ? new Date(this.searchFilter.dateFrom).getTime() / 1000
                : undefined,
              dateTo: this.searchFilter?.dateTo
                ? new Date(this.searchFilter.dateTo).getTime() / 1000
                : undefined,
              limit: this.commitCount,
            })
          : null;

        // Abort if a newer load has started
        if (this.loadVersion !== currentVersion) return;

        if (indexResults) {
          // A search that answered re-arms the failure notice
          this.searchFailureNotifiedFor = null;
          for (const commit of indexResults) {
            this.matchedCommitOids.add(commit.oid);
          }
        } else {
          // Fallback to direct search
          const matchResult = await searchCommits(repoPath, {
            query: this.searchFilter?.query || undefined,
            author: this.searchFilter?.author || undefined,
            dateFrom: this.searchFilter?.dateFrom
              ? new Date(this.searchFilter.dateFrom).getTime() / 1000
              : undefined,
            dateTo: this.searchFilter?.dateTo
              ? new Date(this.searchFilter.dateTo).getTime() / 1000
              : undefined,
            filePath: this.searchFilter?.filePath || undefined,
            branch: this.searchFilter?.branch || undefined,
            limit: this.commitCount,
          });

          // Abort if a newer load has started
          if (this.loadVersion !== currentVersion) return;

          if (matchResult.success && matchResult.data) {
            // A search that answered re-arms the failure notice
            this.searchFailureNotifiedFor = null;
            for (const commit of matchResult.data) {
              this.matchedCommitOids.add(commit.oid);
            }
          } else {
            // A failed search (bad pathspec, unknown branch, backend error)
            // must not render as a legitimate zero-match search. The
            // component can't toast itself — app-shell listens for
            // graph-notice (same wiring as the semantic-unavailable notice).
            log.warn('Commit search failed:', matchResult.error?.message);
            if (this.searchFailureNotifiedFor !== repoPath) {
              this.searchFailureNotifiedFor = repoPath;
              this.dispatchEvent(
                new CustomEvent('graph-notice', {
                  detail: {
                    message: `Search failed: ${matchResult.error?.message ?? 'unknown error'}`,
                    type: 'error',
                  },
                  bubbles: true,
                  composed: true,
                })
              );
            }
          }
        }
        log.debug(`Search matched ${this.matchedCommitOids.size} commits`);
      }

      // Convert commits to GraphCommit format for layout
      this.commits = commitsResult.data.map(commitToGraphCommit);
      this.totalLoadedCommits = commitsResult.data.length;
      this.hasMoreCommits = commitsResult.data.length >= this.commitCount;

      // Fetch the true total in the background (cheap: served from the
      // backend walk cache) so pagination and the a11y label are exact
      getCommitTotal(repoPath).then((totalResult) => {
        if (this.loadVersion !== currentVersion) return;
        if (totalResult.success && typeof totalResult.data === 'number') {
          this.commitTotal = totalResult.data;
          this.hasMoreCommits = this.totalLoadedCommits < totalResult.data;
          // Grow the scrollbar to span the full history, and re-spread the
          // minimap dots over the new total so they aren't stretched over
          // the whole strip
          this.updateVirtualTotalRows();
          this.rebuildMinimapDots();
          this.renderMinimap();
        }
      });
      // Cache this page so switching back to the tab renders instantly
      cacheGraphPage(repoPath, {
        commits: commitsResult.data,
        refsByCommit: this.refsByCommit,
        hasMore: this.hasMoreCommits,
      });
      // Any successful load clears a previous failure — including a queued
      // background reload succeeding after a failed foreground load, which
      // would otherwise leave the error panel painted over a healthy graph
      this.loadError = null;
      this.processLayout();
      // A reload replaces the loaded set with just the FIRST page while the
      // scrollbar still spans the whole history, so a viewport that had been
      // paginated deep now sits below the last loaded row with nothing
      // painted in it — and checkLoadMore only ever runs from a scroll, so
      // it would stay blank until the user nudged the wheel
      this.recoverViewportAfterReload();
      const searchInfo = hasSearch ? ` (${this.matchedCommitOids.size} matches highlighted)` : '';
      log.debug(`Loaded ${this.commits.length} commits${searchInfo} in ${(performance.now() - startTime).toFixed(2)}ms`);
    } catch (err) {
      if (options.background) {
        log.warn('Background graph revalidation failed:', err);
      } else {
        this.loadError = err instanceof Error ? err.message : 'Unknown error loading commits';
      }
    } finally {
      // Only the NEWEST load owns the shared state. A superseded load (the
      // user switched tabs again before this one resolved) must not clear
      // isLoading — that would drop the spinner while the newest load is
      // still running, flashing a stale/empty graph under the new tab.
      if (this.loadVersion === currentVersion) {
        this.isLoading = false;
        this.inFlightLoadPath = null;
        // The newest load has run to completion (success or failure), so the
        // empty-state panel is now allowed to make a judgement about zero
        // commits instead of flashing before the first walk ever finished
        this.hasCompletedLoad = true;
        if (this.reloadQueued) {
          // A refresh was requested mid-load. reloadQueued is only ever set
          // by refresh() — i.e. a user/mutation-triggered reload (commit,
          // pull, merge, watcher refs-changed) — so run it in the FOREGROUND
          // so its failures surface (a silent background reload would hide
          // errors the user expects to see after acting). Tab-switch cache
          // revalidation uses a separate direct background load, not this
          // queue.
          this.reloadQueued = false;
          this.loadCommits();
        }
      }
    }
  }

  /** True when the viewport extends past the bottom of the loaded rows */
  private isViewportBeyondLoaded(): boolean {
    const scrollTop = this.scrollState?.getScroll().scrollTop ?? 0;
    const viewportHeight = this.containerEl?.clientHeight ?? 0;
    const loadedBottom = this.PADDING + (this.layout?.totalRows ?? 0) * this.ROW_HEIGHT;
    return scrollTop + viewportHeight > loadedBottom;
  }

  /**
   * True when the WHOLE viewport sits past the loaded rows, so getVisibleRange
   * returns an empty window and the canvas paints nothing at all.
   */
  private isViewportEntirelyBeyondLoaded(): boolean {
    const scrollTop = this.scrollState?.getScroll().scrollTop ?? 0;
    const loadedBottom = this.PADDING + (this.layout?.totalRows ?? 0) * this.ROW_HEIGHT;
    return scrollTop >= loadedBottom;
  }

  /**
   * Pull the scroll back onto the rows that are actually loaded. The content
   * height can still span the FULL history (updateVirtualTotalRows pads the
   * scroller out to commitTotal while hasMoreCommits), so the browser never
   * clamps for us and a viewport parked past the last loaded row would paint
   * nothing.
   */
  private clampScrollOntoLoadedRows(): void {
    if (!this.scrollState || !this.virtualScroll) return;
    const { scrollTop, scrollLeft } = this.scrollState.getScroll();
    const loadedHeight = this.PADDING * 2 + (this.layout?.totalRows ?? 0) * this.ROW_HEIGHT;
    // getContentSize() caps very long histories, so never scroll past it either
    const height = Math.min(loadedHeight, this.virtualScroll.getContentSize().height);
    const maxScrollY = Math.max(0, height - this.getViewport().height);
    this.scrollState.setScroll(Math.min(scrollTop, maxScrollY), scrollLeft);
    this.syncScrollbarPosition();
  }

  private async loadMoreCommits(): Promise<void> {
    if (this.isLoadingMore || !this.hasMoreCommits || !this.repositoryPath) return;
    this.isLoadingMore = true;
    // Larger batches while catching up to a distant scrollbar/minimap
    // position: each batch pays a layout/index rebuild over ALL loaded
    // commits, so fewer, bigger batches keep deep drags responsive
    const batchSize = this.isViewportBeyondLoaded() ? 2000 : 500;
    const currentVersion = this.loadVersion;
    let failed = false;

    try {
      const result = await getCommitHistory({
        path: this.repositoryPath,
        limit: batchSize,
        skip: this.totalLoadedCommits,
        allBranches: true,
      });

      if (this.loadVersion !== currentVersion) return;
      if (!result.success) {
        // Transient failure: keep hasMoreCommits so a later scroll retries,
        // but stop the catch-up chain to avoid a hot retry loop
        failed = true;
        log.warn('loadMoreCommits: fetch failed:', result.error?.message);
        // The chain stops here, so a viewport parked past the loaded rows
        // would sit on a blank canvas with nothing on screen to explain it
        if (this.isViewportEntirelyBeyondLoaded()) {
          this.clampScrollOntoLoadedRows();
        }
        // A console warning is not feedback — the component has no toast of
        // its own, so app-shell surfaces graph-notice for it
        this.dispatchEvent(
          new CustomEvent('graph-notice', {
            detail: {
              message: `Could not load more commits: ${result.error?.message ?? 'unknown error'}`,
              type: 'error',
            },
            bubbles: true,
            composed: true,
          })
        );
        return;
      }
      if (!result.data?.length) {
        // Genuinely no more commits: shrink the scroller back onto the loaded
        // rows (a stale commitTotal had it spanning a longer history) and pull
        // a viewport that was parked out there back onto real rows
        this.hasMoreCommits = false;
        this.updateVirtualTotalRows();
        this.clampScrollOntoLoadedRows();
        return;
      }

      for (const commit of result.data) {
        this.realCommits.set(commit.oid, commit);
      }
      const newGraphCommits = result.data.map(commitToGraphCommit);
      this.commits = [...this.commits, ...newGraphCommits];
      this.totalLoadedCommits += result.data.length;
      this.hasMoreCommits = this.commitTotal !== null
        ? this.totalLoadedCommits < this.commitTotal
        : result.data.length >= batchSize;

      // Incremental append keeps rows/lanes/colors of already-visible
      // commits stable. A branch filter or active search changes which
      // commits are laid out, so those paths take the full recompute.
      if (this.layout?.appendState && this.hiddenBranches.size === 0 && !this.hasActiveSearch()) {
        this.layout = appendLanes(this.layout, newGraphCommits);
        this.applyLayout();
      } else {
        this.processLayout();
      }
    } finally {
      // Only the load that still owns the current version clears the flag.
      // A superseded fetch (repo switch or full reload happened mid-flight)
      // must not clear a NEWER load's in-progress state — that would let a
      // second overlapping load-more start and double-count
      // totalLoadedCommits. willUpdate/loadCommits reset the flag when they
      // take ownership.
      if (this.loadVersion === currentVersion) {
        this.isLoadingMore = false;
      }
    }

    // The scrollbar spans the FULL history, so the user may have scrolled
    // far past the loaded rows — keep loading pages until the viewport is
    // caught up (each call loads one batch, then re-checks). Only when
    // unfiltered: with a branch filter or search active the scrollbar does
    // NOT span the full history, and chaining here would silently pull the
    // whole repository just because the filtered graph is short.
    if (!failed && this.hiddenBranches.size === 0 && !this.hasActiveSearch()) {
      this.checkLoadMore();
    }
  }

  private checkLoadMore(): void {
    if (!this.virtualScroll || !this.hasMoreCommits || this.isLoadingMore) return;
    const scrollTop = this.scrollState?.getScroll().scrollTop ?? 0;
    const viewportHeight = this.containerEl?.clientHeight ?? 0;
    // Distance from the bottom of the viewport to the end of the LOADED
    // rows (the content height itself now spans the full history)
    const loadedBottom = this.PADDING + (this.layout?.totalRows ?? 0) * this.ROW_HEIGHT;
    if (loadedBottom - (scrollTop + viewportHeight) < 500) {
      this.loadMoreCommits();
    }
  }

  /**
   * Bring the viewport back onto real rows after a full reload. Restart the
   * catch-up chain so the loaded rows reach the viewport again, or — when
   * there is nothing left to load — pull the scroll back onto the rows that
   * remain, so a reload can never leave a blank canvas behind.
   */
  private recoverViewportAfterReload(): void {
    if (!this.scrollState || !this.virtualScroll) return;
    // Only when the WHOLE viewport is past the loaded rows: a viewport that
    // still shows rows recovers on the next scroll, which runs checkLoadMore
    if (!this.isViewportEntirelyBeyondLoaded()) return;

    // Only paginate while unfiltered — with a branch filter or an active
    // search the scrollbar does not span the full history
    // (updateVirtualTotalRows), so chaining pages there would pull in the
    // whole repository; clamping is the right recovery instead
    const unfiltered = this.hiddenBranches.size === 0 && !this.hasActiveSearch();
    if (this.hasMoreCommits && unfiltered) {
      this.checkLoadMore();
      return;
    }

    this.clampScrollOntoLoadedRows();
  }

  /**
   * Load pull requests for GitHub repositories
   * Maps PRs to their head commit SHA for display
   */
  private async loadPullRequests(): Promise<void> {
    // Capture the repo identity at the start: a repo switch while the
    // fetches are in flight must not attach this repo's PRs to the new
    // repo's commits (the branch-name fallback below would happily match
    // a same-named branch like "main" in an unrelated repository)
    const requestedRepo = this.githubRepo;
    if (!requestedRepo) {
      return;
    }

    try {
      // Check if GitHub is connected
      const connectionResult = await checkGitHubConnection();
      if (!connectionResult.success || !connectionResult.data?.connected) {
        return; // Not connected, skip PR loading
      }

      // Fetch open PRs (and recently closed for context)
      const [openPrs, closedPrs] = await Promise.all([
        listPullRequests(requestedRepo.owner, requestedRepo.repo, 'open', 50),
        listPullRequests(requestedRepo.owner, requestedRepo.repo, 'closed', 20),
      ]);

      // Abort if the repository changed while the fetches were in flight
      if (this.githubRepo !== requestedRepo) {
        return;
      }

      const prsByCommit: Record<string, GraphPullRequest[]> = {};

      // Build a set of all commit OIDs in the graph for fast lookup
      const graphCommitOids = new Set(this.commits.map(c => c.oid));

      // Helper to add PR to commit map
      const addPr = (headSha: string, headRef: string, pr: GraphPullRequest) => {
        // Primary: Match by commit SHA directly
        if (graphCommitOids.has(headSha)) {
          if (!prsByCommit[headSha]) {
            prsByCommit[headSha] = [];
          }
          if (!prsByCommit[headSha].some(p => p.number === pr.number)) {
            prsByCommit[headSha].push(pr);
          }
          return;
        }

        // Fallback: Match by branch ref name (for PRs whose commits aren't directly in graph)
        for (const [oid, refs] of Object.entries(this.refsByCommit)) {
          const hasMatchingRef = refs.some(ref =>
            ref.shorthand === headRef ||
            ref.shorthand.endsWith('/' + headRef)
          );
          if (hasMatchingRef) {
            if (!prsByCommit[oid]) {
              prsByCommit[oid] = [];
            }
            if (!prsByCommit[oid].some(p => p.number === pr.number)) {
              prsByCommit[oid].push(pr);
            }
            break;
          }
        }
      };

      // Process open PRs
      if (openPrs.success && openPrs.data) {
        for (const pr of openPrs.data) {
          addPr(pr.headSha, pr.headRef, {
            number: pr.number,
            state: pr.state,
            draft: pr.draft,
            url: pr.htmlUrl,
          });
        }
      }

      // Process closed PRs - use mergedAt to determine actual state
      if (closedPrs.success && closedPrs.data) {
        for (const pr of closedPrs.data) {
          addPr(pr.headSha, pr.headRef, {
            number: pr.number,
            state: pr.mergedAt ? 'merged' : pr.state,
            draft: pr.draft,
            url: pr.htmlUrl,
          });
        }
      }

      this.pullRequestsByCommit = prsByCommit;

      // Update virtual scroll and re-render
      this.virtualScroll?.setPullRequests(this.pullRequestsByCommit);
      this.renderer?.markDirty();
      this.scheduleRender();
    } catch {
      // Failed to load pull requests, continue without them
    }
  }

  /**
   * Commits to lay out after applying the branch-visibility filter.
   *
   * A commit stays visible when it is reachable (via parent links within the
   * loaded window) from any visible branch tip, from HEAD, or from a tag.
   * With no hidden branches this is all loaded commits.
   */
  private getVisibleCommits(): GraphCommit[] {
    if (this.hiddenBranches.size === 0) {
      return this.commits;
    }

    // Walk starts from HEAD, tags, and branches that are not hidden
    const tips: string[] = [];
    let hasBranchRefs = false;
    for (const [oid, refs] of Object.entries(this.refsByCommit)) {
      for (const ref of refs) {
        const isBranch = ref.refType === 'localBranch' || ref.refType === 'remoteBranch';
        if (isBranch) {
          hasBranchRefs = true;
        }
        const isVisibleBranch = isBranch && !this.hiddenBranches.has(ref.shorthand);
        if (isVisibleBranch || ref.isHead || ref.refType === 'tag') {
          tips.push(oid);
          break;
        }
      }
    }
    // Without any branch refs there is nothing meaningful to filter against
    if (!hasBranchRefs) {
      return this.commits;
    }

    const commitByOid = new Map(this.commits.map((c) => [c.oid, c]));
    const visible = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (visible.has(oid)) continue;
      const commit = commitByOid.get(oid);
      if (!commit) continue;
      visible.add(oid);
      for (const pid of commit.parentIds) {
        stack.push(pid);
      }
    }
    return this.commits.filter((c) => visible.has(c.oid));
  }

  /**
   * OID of the commit HEAD points at, from the loaded refs.
   * The layout pins its first-parent chain to lane 0. Public so callers of
   * jumpToHead() can give accurate feedback on a miss.
   */
  public getHeadOid(): string | undefined {
    for (const [oid, refs] of Object.entries(this.refsByCommit)) {
      if (refs.some((ref) => ref.isHead)) {
        return oid;
      }
    }
    return undefined;
  }

  private processLayout(): void {
    const result = computeGraphLayout(this.getVisibleCommits(), { headOid: this.getHeadOid() });
    this.layout = result.layout;
    this.applyLayout();
  }

  /**
   * Push the current layout into the render/scroll/hit-test subsystems.
   * Shared by full recomputes (processLayout) and incremental appends.
   */
  private applyLayout(): void {
    if (!this.layout) return;

    // Build sorted nodes array for keyboard navigation
    this.sortedNodesByRow = [...this.layout.nodes.values()].sort((a, b) => a.row - b.row);

    // Extract author emails for avatar loading
    const authorEmails: Record<string, string> = {};
    for (const [oid, commit] of this.realCommits) {
      authorEmails[oid] = commit.author.email;
    }

    // Update virtual scroll
    this.virtualScroll?.setLayout(this.layout);
    this.virtualScroll?.setRefs(this.refsByCommit);
    this.virtualScroll?.setAuthorEmails(authorEmails);
    this.virtualScroll?.setPullRequests(this.pullRequestsByCommit);

    // Update scroll content size (spans the full history when unfiltered)
    this.updateVirtualTotalRows();

    // Build spatial index (once per layout — scroll-independent)
    this.buildSpatialIndex();

    // Refresh the minimap dots for the new layout
    this.resizeMinimap();
    this.rebuildMinimapDots();

    // Drop/rebind the selection against the new layout before painting
    this.validateSelection();

    // Set highlighted commits for search results
    this.renderer?.setHighlightedCommits(this.matchedCommitOids);

    // Mark dirty and render
    this.renderer?.markDirty();
    this.scheduleRender();

    // Fetch stats and signatures for the visible rows asynchronously
    // (don't block initial render). Debounced to let rapid changes settle.
    this.scheduleVisibleDataFetch();
  }

  /**
   * Reconcile the selection with the layout that was just built. A reload
   * after an amend, rebase, squash or branch delete (and a branch-filter
   * change) rebuilds the graph around different OIDs and different rows:
   * without this the details panel would keep showing a commit that is gone
   * from the repository — and its actions would run against a dead OID —
   * while survivors would keep pointing at their OLD nodes, so range-select
   * and the screen-reader position would work off stale rows.
   */
  private validateSelection(): void {
    if (!this.layout) return;

    // A reload always restarts from the newest commitCount commits, so a
    // graph that had already paged deeper is missing those rows only
    // because they have not been fetched again yet — their absence is no
    // proof the commits are gone. Wait for the catch-up pages (each append
    // lands here too) to reach the depth the selection was last checked
    // against before pruning anything.
    if (this.hasMoreCommits && this.totalLoadedCommits < this.validatedCommitCount) return;
    this.validatedCommitCount = this.totalLoadedCommits;

    let selectionChanged = false;
    for (const oid of [...this.selectedNodes]) {
      if (!this.layout.nodes.has(oid)) {
        this.selectedNodes.delete(oid);
        selectionChanged = true;
      }
    }
    if (this.selectedNode) {
      // Rebind a survivor to its node in the NEW layout (same commit, new row)
      let node = this.layout.nodes.get(this.selectedNode.oid) ?? null;
      if (!node) {
        // The primary commit is gone but the rest of a multi-selection can
        // survive: promote one (as ctrl+click does when it removes the
        // primary) so the details panel and keyboard navigation keep an
        // anchor matching what stays highlighted
        const remaining = [...this.selectedNodes];
        node = remaining.length > 0
          ? this.layout.nodes.get(remaining[remaining.length - 1]) ?? null
          : null;
        selectionChanged = true;
      }
      this.selectedNode = node;
    }
    if (this.lastClickedNode) {
      this.lastClickedNode = this.layout.nodes.get(this.lastClickedNode.oid) ?? null;
    }

    // Only a real change is announced — an ordinary reload that keeps the
    // selection must not churn the details panel. markDirty/scheduleRender
    // are left to applyLayout(), which runs them on the very next lines.
    if (selectionChanged) {
      this.dispatchSelectionEvent();
      this.renderer?.setMultiSelection(this.selectedNodes, this.hoveredNode?.oid ?? null);
    }
  }

  /**
   * Schedule a stats/signatures fetch for the visible rows, debounced so
   * rapid repo switches and fast scrolling settle before hitting the backend
   */
  private scheduleVisibleDataFetch(): void {
    const repoPath = this.repositoryPath;

    if (this.statsDebounceTimer) {
      clearTimeout(this.statsDebounceTimer);
    }

    this.statsDebounceTimer = setTimeout(() => {
      this.statsDebounceTimer = null;
      // Check if repo is still the same before fetching
      if (this.repositoryPath === repoPath) {
        this.queueDataFetch(() => this.fetchVisibleCommitData());
      }
    }, 300);
  }

  // All stats/signature fetches run through this queue. The fetched-OID
  // marker sets are claimed synchronously at fetch START (to dedupe), so a
  // consumer that needs the DATA (e.g. export) must not race a fetch that
  // has claimed OIDs but hasn't resolved — serializing the jobs makes
  // "claimed by a completed job" equivalent to "data present or unclaimed
  // again after failure".
  private dataFetchQueue: Promise<void> = Promise.resolve();

  private queueDataFetch(job: () => Promise<void>): Promise<void> {
    const run = this.dataFetchQueue.then(job, job);
    // Keep the chain alive even if a job rejects
    this.dataFetchQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Fetch stats and signatures for the given OIDs in batches, accumulating
   * into the per-repo maps. Aborts silently on a repo switch; failed
   * batches are unmarked so a later fetch retries them.
   */
  private async fetchCommitDataBatches(
    repoPath: string,
    statsOids: string[],
    signatureOids: string[]
  ): Promise<void> {
    // Mark as requested up-front so overlapping fetches don't duplicate
    for (const oid of statsOids) this.statsFetchedOids.add(oid);
    for (const oid of signatureOids) this.signaturesFetchedOids.add(oid);

    const statsBatchSize = 100;
    for (let i = 0; i < statsOids.length; i += statsBatchSize) {
      // Abort if we switched to a different repository
      if (this.repositoryPath !== repoPath) return;

      const batch = statsOids.slice(i, i + statsBatchSize);
      const result = await getCommitsStats(repoPath, batch);
      if (result.success && result.data) {
        for (const stat of result.data) {
          this.commitStatsMap.set(stat.oid, {
            additions: stat.additions,
            deletions: stat.deletions,
            filesChanged: stat.filesChanged,
          });
        }
      } else {
        log.warn(`fetchCommitDataBatches: stats batch failed: ${result.error}`);
        // Allow a retry on the next fetch for this range
        for (const oid of batch) this.statsFetchedOids.delete(oid);
      }
    }

    const signatureBatchSize = 50;
    for (let i = 0; i < signatureOids.length; i += signatureBatchSize) {
      if (this.repositoryPath !== repoPath) return;

      const batch = signatureOids.slice(i, i + signatureBatchSize);
      const result = await getCommitsSignatures(repoPath, batch);
      if (result.success && result.data) {
        for (const [oid, sig] of result.data) {
          this.commitSignaturesMap.set(oid, { signed: sig.signed, valid: sig.valid });
        }
      } else {
        for (const oid of batch) this.signaturesFetchedOids.delete(oid);
      }
    }
  }

  /**
   * OIDs of the commits in the visible row range plus overscan
   */
  private getVisibleDataOids(): string[] {
    if (!this.virtualScroll || this.sortedNodesByRow.length === 0) return [];
    const range = this.virtualScroll.getVisibleRange(this.getViewport());
    const start = Math.max(0, range.startRow - this.DATA_FETCH_OVERSCAN_ROWS);
    const end = Math.min(
      this.sortedNodesByRow.length,
      range.endRow + this.DATA_FETCH_OVERSCAN_ROWS + 1
    );
    return this.sortedNodesByRow.slice(start, end).map((n) => n.oid);
  }

  /**
   * Fetch commit stats and signatures for the VISIBLE rows only (plus
   * overscan), instead of every loaded commit. Results accumulate per OID —
   * a commit's stats never change for a given OID — so scrolling back over
   * fetched rows costs nothing.
   */
  private async fetchVisibleCommitData(): Promise<void> {
    if (!this.repositoryPath) return;
    const repoPath = this.repositoryPath;
    const visibleOids = this.getVisibleDataOids();

    const statsOids = visibleOids.filter((oid) => !this.statsFetchedOids.has(oid));
    const signatureOids = visibleOids.filter((oid) => !this.signaturesFetchedOids.has(oid));
    if (statsOids.length === 0 && signatureOids.length === 0) return;

    // Only the very first fetch for a repo shows the spinner — subsequent
    // scroll-driven fetches are incremental and shouldn't flash UI
    const isInitialFetch = this.commitStatsMap.size === 0 && statsOids.length > 0;
    const startTime = Date.now();
    const MIN_LOADING_DISPLAY_MS = 400;
    if (isInitialFetch) {
      this.isLoadingStats = true;
    }

    try {
      await this.fetchCommitDataBatches(repoPath, statsOids, signatureOids);

      if (this.repositoryPath === repoPath) {
        this.renderer?.setCommitStats(this.commitStatsMap);
        this.renderer?.setCommitSignatures(this.commitSignaturesMap);
        this.renderer?.markDirty();
        this.scheduleRender();
      }
    } finally {
      if (isInitialFetch) {
        // Enforce the minimum-visible delay only while still on the same repo
        if (this.repositoryPath === repoPath) {
          const elapsed = Date.now() - startTime;
          if (elapsed < MIN_LOADING_DISPLAY_MS) {
            await new Promise(resolve => setTimeout(resolve, MIN_LOADING_DISPLAY_MS - elapsed));
          }
          // Re-check AFTER the delay: a repo switch during it means the
          // spinner now belongs to the NEW repo's fetch and must stay on
          if (this.repositoryPath === repoPath) {
            this.isLoadingStats = false;
          }
        }
        // A repo switch mid-fetch resets the flag in willUpdate, so the
        // spinner never sticks for the new repo
      }
    }
  }

  /**
   * Make the scrollable area span the TRUE history length (not just the
   * loaded rows) so the scrollbar is honest about repo size. Only when the
   * graph is unfiltered — a branch filter or search changes which commits
   * are shown, so the backend total no longer matches the row count.
   */
  private updateVirtualTotalRows(): void {
    const unfiltered = this.hiddenBranches.size === 0 && !this.hasActiveSearch();
    this.virtualScroll?.setVirtualTotalRows(
      unfiltered && this.hasMoreCommits ? this.commitTotal : null
    );
    this.updateScrollContentSize();
  }

  // ── Minimap ──────────────────────────────────────────────────────────

  /** Rows the minimap spans (matches the scrollable area, incl. unloaded) */
  private getMinimapTotalRows(): number {
    const loaded = this.layout?.totalRows ?? 0;
    const unfiltered = this.hiddenBranches.size === 0 && !this.hasActiveSearch();
    const virtual = unfiltered && this.hasMoreCommits ? this.commitTotal ?? 0 : 0;
    return Math.max(1, loaded, virtual);
  }

  /** CSS-pixel size of the minimap (backing store is DPR-scaled) */
  private getMinimapCssSize(): { width: number; height: number } {
    const height = this.containerEl
      ? Math.max(0, this.containerEl.clientHeight - this.HEADER_HEIGHT)
      : 0;
    return { width: this.MINIMAP_WIDTH, height };
  }

  private resizeMinimap(): void {
    if (!this.minimapEl || !this.containerEl) return;
    // DPR-scaled backing store so the minimap is crisp on HiDPI displays
    // (drawing code works in CSS pixels via a scaled transform)
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.getMinimapCssSize();
    this.minimapEl.width = Math.round(width * dpr);
    this.minimapEl.height = Math.round(height * dpr);
  }

  /**
   * Rebuild the offscreen dots layer: one branch-colored dot per commit,
   * positioned by row (vertically, over the FULL history span) and lane
   * (horizontally, mirrored like the graph). Rebuilt on layout changes;
   * per-frame rendering just composites it under the viewport indicator.
   */
  private rebuildMinimapDots(): void {
    if (!this.showMinimap || !this.minimapEl || !this.layout) return;

    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.getMinimapCssSize();
    if (width === 0 || height === 0) return;

    const dots = document.createElement('canvas');
    dots.width = Math.round(width * dpr);
    dots.height = Math.round(height * dpr);
    const ctx = dots.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const theme = getThemeFromCSS();
    const totalRows = this.getMinimapTotalRows();
    const laneCount = this.layout.maxLane + 1;
    const usableWidth = width - 10;

    for (const node of this.layout.nodes.values()) {
      const y = ((node.row + 0.5) / totalRows) * height;
      // Mirrored like the graph: lane 0 on the right
      const x = width - 5 - ((node.lane + 0.5) / laneCount) * usableWidth;
      ctx.fillStyle = theme.laneColors[node.colorIndex % theme.laneColors.length];
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }

    this.minimapDots = dots;
  }

  /** Composite the dots layer with the viewport indicator */
  private renderMinimap(): void {
    if (!this.showMinimap || !this.minimapEl || !this.virtualScroll) return;
    const ctx = this.minimapEl.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.getMinimapCssSize();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (this.minimapDots) {
      ctx.drawImage(this.minimapDots, 0, 0, width, height);
    }

    // Viewport indicator
    const contentHeight = this.virtualScroll.getContentSize().height;
    if (contentHeight <= 0) return;
    const viewport = this.getViewport();
    const indicatorY = (viewport.scrollTop / contentHeight) * height;
    const indicatorH = Math.max(8, (viewport.height / contentHeight) * height);

    const theme = getThemeFromCSS();
    ctx.fillStyle = theme.textColor;
    ctx.globalAlpha = 0.12;
    ctx.fillRect(0, indicatorY, width, indicatorH);
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = theme.textColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, indicatorY + 0.5, width - 1, indicatorH - 1);
    ctx.globalAlpha = 1.0;
  }

  /** Map a minimap Y coordinate (CSS px) to a scrollTop (viewport centered) */
  private minimapYToScrollTop(y: number): number {
    if (!this.minimapEl || !this.virtualScroll) return 0;
    const height = this.getMinimapCssSize().height;
    if (height <= 0) return 0;
    const contentHeight = this.virtualScroll.getContentSize().height;
    const viewport = this.getViewport();
    const target = (y / height) * contentHeight - viewport.height / 2;
    const maxScroll = Math.max(0, contentHeight - viewport.height);
    return Math.max(0, Math.min(target, maxScroll));
  }

  private handleMinimapPointerDown = (e: MouseEvent): void => {
    e.preventDefault();
    this.minimapDragging = true;
    this.scrollMinimapTo(e);
    document.addEventListener('mousemove', this.handleMinimapPointerMove);
    document.addEventListener('mouseup', this.handleMinimapPointerUp);
  };

  private handleMinimapPointerMove = (e: MouseEvent): void => {
    if (!this.minimapDragging) return;
    this.scrollMinimapTo(e);
  };

  private handleMinimapPointerUp = (): void => {
    this.minimapDragging = false;
    document.removeEventListener('mousemove', this.handleMinimapPointerMove);
    document.removeEventListener('mouseup', this.handleMinimapPointerUp);
  };

  private scrollMinimapTo(e: MouseEvent): void {
    if (!this.minimapEl || !this.scrollState) return;
    const rect = this.minimapEl.getBoundingClientRect();
    const scrollTop = this.minimapYToScrollTop(e.clientY - rect.top);
    const scroll = this.scrollState.getScroll();
    this.scrollState.setScroll(scrollTop, scroll.scrollLeft);
    this.syncScrollbarPosition();
  }

  private updateScrollContentSize(): void {
    if (!this.virtualScroll || !this.scrollEl) return;

    const size = this.virtualScroll.getContentSize();
    const scrollContent = this.scrollEl.querySelector('.scroll-content') as HTMLDivElement;
    if (scrollContent) {
      scrollContent.style.width = `${size.width}px`;
      scrollContent.style.height = `${size.height}px`;
    }
  }

  /**
   * Build the spatial index for the whole layout. The index lives in graph
   * coordinates (scroll-independent), so it is built ONCE per layout instead
   * of being rebuilt on every scroll event — hitTest() translates the query
   * point by the current scroll offset.
   */
  private buildSpatialIndex(): void {
    if (!this.layout || !this.spatialIndex) return;

    // Configure spatial index with current maxLane for mirrored coordinates
    this.spatialIndex.configure({
      offsetX: this.PADDING,
      offsetY: this.PADDING,
      rowHeight: this.ROW_HEIGHT,
      laneWidth: this.LANE_WIDTH,
      maxLane: this.layout.maxLane,
      nodeRadius: this.NODE_RADIUS + 6,
    });

    this.spatialIndex.build([...this.layout.nodes.values()], this.layout.edges);
  }

  private getViewport(): Viewport {
    const scroll = this.scrollState?.getScroll() ?? { scrollTop: 0, scrollLeft: 0 };
    return {
      scrollTop: scroll.scrollTop,
      scrollLeft: scroll.scrollLeft,
      width: this.containerEl?.clientWidth ?? 800,
      height: this.containerEl?.clientHeight ?? 600,
    };
  }

  private onResize(): void {
    if (!this.containerEl || !this.renderer) return;

    const scrollbarWidth = 12; // Match CSS scrollbar width
    const width = this.containerEl.clientWidth - scrollbarWidth;
    const height = this.containerEl.clientHeight;

    this.renderer.resize(width, height);
    this.resizeMinimap();
    this.rebuildMinimapDots();
    this.scheduleRender();
  }

  private onScroll(_scrollTop: number, _scrollLeft: number): void {
    // The spatial index lives in graph coordinates and needs no rebuild here
    // Mark renderer dirty so it actually redraws
    this.renderer?.markDirty();
    this.scheduleRender();
    this.checkLoadMore();
    // Newly revealed rows may need their stats/signatures fetched
    this.scheduleVisibleDataFetch();
  }

  private handleWheel = (e: WheelEvent): void => {
    e.preventDefault();

    // Ctrl/Cmd + wheel zooms the graph density instead of scrolling.
    // Wheel ticks arrive far faster than zoom application is cheap (each
    // zoom rebuilds the spatial index), so ticks accumulate into a target
    // applied once per animation frame.
    if (e.ctrlKey || e.metaKey) {
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const base = this.pendingZoomTarget ?? this.zoomLevel;
      this.pendingZoomTarget = Math.min(
        LvGraphCanvas.MAX_ZOOM,
        Math.max(LvGraphCanvas.MIN_ZOOM, base * factor)
      );
      if (!this.zoomFrame) {
        this.zoomFrame = requestAnimationFrame(() => {
          this.zoomFrame = 0;
          if (this.pendingZoomTarget !== null) {
            const target = this.pendingZoomTarget;
            this.pendingZoomTarget = null;
            this.setZoom(target);
          }
        });
      }
      return;
    }

    if (!this.scrollState || !this.virtualScroll) {
      return;
    }

    const size = this.virtualScroll.getContentSize();
    const viewport = this.getViewport();

    const maxScrollX = Math.max(0, size.width - viewport.width);
    const maxScrollY = Math.max(0, size.height - viewport.height);

    this.scrollState.handleWheel(e.deltaX, e.deltaY, maxScrollX, maxScrollY);

    // Sync the native scrollbar position
    this.syncScrollbarPosition();
  }

  private handleNativeScroll = (): void => {
    if (!this.scrollEl || !this.scrollState || this.isSyncingScroll) {
      return;
    }

    // Update internal scroll state from native scrollbar
    const scrollTop = this.scrollEl.scrollTop;
    const scrollLeft = this.scrollEl.scrollLeft;

    this.scrollState.setScroll(scrollTop, scrollLeft);
    this.checkLoadMore();
  }

  private isSyncingScroll = false;

  private syncScrollbarPosition(): void {
    if (!this.scrollEl || !this.scrollState) return;

    const scroll = this.scrollState.getScroll();

    // Prevent feedback loop
    this.isSyncingScroll = true;
    this.scrollEl.scrollTop = scroll.scrollTop;
    this.scrollEl.scrollLeft = scroll.scrollLeft;

    // Reset flag after scroll event processes
    requestAnimationFrame(() => {
      this.isSyncingScroll = false;
    });
  }

  private handleMouseMove = (e: MouseEvent): void => {
    const result = this.hitTest(e);

    if (result.type === 'node' && result.node) {
      this.hoveredNode = result.node;
      this.canvasEl.classList.add('pointer');
    } else {
      this.hoveredNode = null;
      this.canvasEl.classList.remove('pointer');
    }

    // Check for avatar or ref label hover for tooltip
    if (this.renderer) {
      const rect = this.canvasEl.getBoundingClientRect();

      // Convert screen coords to canvas coords (hitboxes are in canvas space)
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;

      // Check avatars first
      const avatarHit = this.renderer.getAvatarAtPoint(canvasX, canvasY);
      if (avatarHit) {
        this.tooltipVisible = true;
        this.tooltipX = e.clientX + 12;
        this.tooltipY = e.clientY - 8;
        this.tooltipAuthorName = avatarHit.authorName;
        this.tooltipAuthorEmail = avatarHit.authorEmail;
      } else {
        // Check ref labels
        const refLabelHit = this.renderer.getRefLabelAtPoint(canvasX, canvasY);
        if (refLabelHit) {
          this.tooltipVisible = true;
          this.tooltipX = e.clientX + 12;
          this.tooltipY = e.clientY - 8;
          this.tooltipAuthorName = refLabelHit.fullName;
          this.tooltipAuthorEmail = refLabelHit.refType === 'pullRequest'
            ? 'Click to open'
            : this.getRefTypeLabel(refLabelHit.refType);
        } else {
          // Check overflow indicator
          const overflowHit = this.renderer.getOverflowAtPoint(canvasX, canvasY);
          if (overflowHit) {
            this.tooltipVisible = true;
            this.tooltipX = e.clientX + 12;
            this.tooltipY = e.clientY - 8;
            this.tooltipAuthorName = 'Hidden labels:';
            this.tooltipAuthorEmail = overflowHit.hiddenLabels.join(', ');
          } else {
            this.tooltipVisible = false;
          }
        }
      }
    }

    this.renderer?.setMultiSelection(
      this.selectedNodes,
      this.hoveredNode?.oid ?? null
    );
    this.renderer?.markDirty();
    this.scheduleRender();
  }

  private handleClick = (e: MouseEvent): void => {
    // Check for ref label click first (checkout on branch label click)
    if (this.renderer) {
      const rect = this.canvasEl.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;

      const refLabelHit = this.renderer.getRefLabelAtPoint(canvasX, canvasY);
      if (refLabelHit && refLabelHit.refType === 'localBranch') {
        // Clicking the branch already checked out is a no-op worth skipping,
        // not performing: with a dirty tree it would still run a full
        // stash -> checkout-to-the-same-commit -> apply -> drop cycle, parking
        // the user's whole working tree in a stash for the duration. The
        // sidebar's checkout returns early on isHead for the same reason.
        if (refLabelHit.isHead) return;
        // Dispatch checkout event for local branches
        this.dispatchEvent(
          new CustomEvent('checkout-branch', {
            detail: { branchName: refLabelHit.label },
            bubbles: true,
            composed: true,
          })
        );
        return;
      }

      // Handle PR label click - open in browser
      if (refLabelHit && refLabelHit.refType === 'pullRequest') {
        const prUrl = refLabelHit.fullName;
        if (prUrl && prUrl.startsWith('http')) {
          openExternalUrl(prUrl);
        }
        return;
      }
    }

    const result = this.hitTest(e);

    if (result.type === 'node' && result.node) {
      const clickedOid = result.node.oid;

      if (e.shiftKey && this.lastClickedNode) {
        // Shift+click: Range selection between last clicked and current
        this.handleRangeSelect(result.node);
        this.selectedNode = result.node;
      } else if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd+click: Toggle individual selection
        if (this.selectedNodes.has(clickedOid)) {
          this.selectedNodes.delete(clickedOid);
          // If we removed the primary selection, pick another
          if (this.selectedNode?.oid === clickedOid) {
            const remaining = Array.from(this.selectedNodes);
            this.selectedNode = remaining.length > 0
              ? this.sortedNodesByRow.find(n => n.oid === remaining[remaining.length - 1]) ?? null
              : null;
          }
        } else {
          this.selectedNodes.add(clickedOid);
          this.selectedNode = result.node;
        }
        this.lastClickedNode = result.node;
      } else {
        // Regular click: Clear selection and select single node
        this.selectedNodes.clear();
        this.selectedNodes.add(clickedOid);
        this.selectedNode = result.node;
        this.lastClickedNode = result.node;
      }
    } else {
      // Click on empty space: Clear selection (unless Ctrl/Cmd held)
      if (!e.ctrlKey && !e.metaKey) {
        this.selectedNodes.clear();
        this.selectedNode = null;
        this.lastClickedNode = null;
      }
    }

    // Focus canvas for keyboard navigation
    this.canvasEl.focus();

    // Dispatch selection event
    this.dispatchSelectionEvent();

    this.renderer?.setMultiSelection(
      this.selectedNodes,
      this.hoveredNode?.oid ?? null
    );
    this.renderer?.markDirty();
    this.scheduleRender();
  }

  private handleRangeSelect(endNode: LayoutNode): void {
    if (!this.lastClickedNode) return;

    const startRow = this.lastClickedNode.row;
    const endRow = endNode.row;
    const minRow = Math.min(startRow, endRow);
    const maxRow = Math.max(startRow, endRow);

    // Select all nodes in the row range
    for (const node of this.sortedNodesByRow) {
      if (node.row >= minRow && node.row <= maxRow) {
        this.selectedNodes.add(node.oid);
      }
    }
  }

  private handleMouseLeave = (): void => {
    this.hoveredNode = null;
    this.tooltipVisible = false;
    this.canvasEl.classList.remove('pointer');
    this.renderer?.setMultiSelection(this.selectedNodes, null);
    this.renderer?.markDirty();
    this.scheduleRender();
  }

  private handleContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();

    // Check for ref label right-click first
    if (this.renderer) {
      const rect = this.canvasEl.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;

      const refLabelHit = this.renderer.getRefLabelAtPoint(canvasX, canvasY);
      // A detached HEAD is a STATE, not a ref you can act on. Its label reads
      // "HEAD (detached)", which names no ref, so letting it through opened the
      // branch/tag menu offering Checkout, Delete, Merge and Rename against a
      // name git would reject.
      if (
        refLabelHit &&
        refLabelHit.refType !== 'pullRequest' &&
        refLabelHit.refType !== 'detachedHead'
      ) {
        // Dispatch ref context menu event for branches and tags
        this.dispatchEvent(
          new CustomEvent('ref-context-menu', {
            detail: {
              refName: refLabelHit.label,
              fullName: refLabelHit.fullName,
              refType: refLabelHit.refType,
              isHead: refLabelHit.isHead,
              position: {
                x: e.clientX,
                y: e.clientY,
              },
            },
            bubbles: true,
            composed: true,
          })
        );
        return;
      }
    }

    const result = this.hitTest(e);

    if (result.type === 'node' && result.node) {
      const commit = this.realCommits.get(result.node.oid);
      if (commit) {
        // A right-click is a selection too, so it has to move ALL of the
        // selection state, not just the primary one. `selectedNodes` drives
        // both the painted highlight and the `commits` array on
        // `commit-selected`, and `lastClickedNode` is the Shift+click range
        // anchor — leaving them behind highlighted one commit while the menu
        // and the details panel named another. Right-clicking a commit that is
        // already part of a multi-selection keeps that selection: acting on the
        // whole set is exactly why the user built it.
        this.selectedNode = result.node;
        if (!this.selectedNodes.has(result.node.oid)) {
          this.selectedNodes.clear();
          this.selectedNodes.add(result.node.oid);
        }
        this.lastClickedNode = result.node;
        this.dispatchSelectionEvent();

        // Dispatch context menu event
        this.dispatchEvent(
          new CustomEvent('commit-context-menu', {
            detail: {
              commit,
              refs: this.refsByCommit[result.node.oid] || [],
              position: {
                x: e.clientX,
                y: e.clientY,
              },
            },
            bubbles: true,
            composed: true,
          })
        );

        this.renderer?.setMultiSelection(
          this.selectedNodes,
          this.hoveredNode?.oid ?? null
        );
        this.renderer?.markDirty();
        this.scheduleRender();
      }
    }
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (this.sortedNodesByRow.length === 0) return;

    let newIndex = -1;
    const currentIndex = this.selectedNode
      ? this.sortedNodesByRow.findIndex((n) => n.oid === this.selectedNode!.oid)
      : -1;

    switch (e.key) {
      case 'ArrowDown':
      case 'j': // Vim-style navigation
        e.preventDefault();
        if (currentIndex === -1) {
          newIndex = 0;
        } else if (currentIndex < this.sortedNodesByRow.length - 1) {
          newIndex = currentIndex + 1;
        }
        break;

      case 'ArrowUp':
      case 'k': // Vim-style navigation
        e.preventDefault();
        if (currentIndex === -1) {
          newIndex = 0;
        } else if (currentIndex > 0) {
          newIndex = currentIndex - 1;
        }
        break;

      case 'Home':
        e.preventDefault();
        newIndex = 0;
        break;

      case 'End':
        e.preventDefault();
        newIndex = this.sortedNodesByRow.length - 1;
        break;

      case 'PageDown':
        e.preventDefault();
        if (currentIndex === -1) {
          newIndex = 0;
        } else {
          const pageSize = Math.floor((this.containerEl?.clientHeight ?? 600) / this.ROW_HEIGHT);
          newIndex = Math.min(currentIndex + pageSize, this.sortedNodesByRow.length - 1);
        }
        break;

      case 'PageUp':
        e.preventDefault();
        if (currentIndex === -1) {
          newIndex = 0;
        } else {
          const pageSize = Math.floor((this.containerEl?.clientHeight ?? 600) / this.ROW_HEIGHT);
          newIndex = Math.max(currentIndex - pageSize, 0);
        }
        break;

      case 'Escape':
        e.preventDefault();
        this.selectedNode = null;
        this.selectedNodes.clear();
        this.lastClickedNode = null;
        this.dispatchSelectionEvent();
        this.renderer?.setMultiSelection(this.selectedNodes, this.hoveredNode?.oid ?? null);
        this.renderer?.markDirty();
        this.scheduleRender();
        return;

      case 'c':
        // Copy commit SHA to clipboard (Ctrl/Cmd+C)
        if ((e.ctrlKey || e.metaKey) && this.selectedNode) {
          e.preventDefault();
          navigator.clipboard.writeText(this.selectedNode.oid);
          // Dispatch event for toast notification
          this.dispatchEvent(
            new CustomEvent('copy-sha', {
              detail: { sha: this.selectedNode.oid.substring(0, 7) },
              bubbles: true,
              composed: true,
            })
          );
        }
        return;

      default:
        return;
    }

    if (newIndex >= 0 && newIndex !== currentIndex) {
      this.selectedNode = this.sortedNodesByRow[newIndex];
      // Keyboard nav clears multi-select unless Shift is held
      this.selectedNodes.clear();
      this.selectedNodes.add(this.selectedNode.oid);
      this.lastClickedNode = this.selectedNode;
      this.dispatchSelectionEvent();
      this.scrollToNode(this.selectedNode);
      this.renderer?.setMultiSelection(this.selectedNodes, this.hoveredNode?.oid ?? null);
      this.renderer?.markDirty();
      this.scheduleRender();
    }
  }

  private scrollToNode(node: LayoutNode): void {
    if (!this.scrollState || !this.virtualScroll) return;

    const viewport = this.getViewport();
    const nodeY = this.PADDING + node.row * this.ROW_HEIGHT;
    const nodeX = this.PADDING + node.lane * this.LANE_WIDTH;

    // Calculate visible area
    const visibleTop = viewport.scrollTop;
    const visibleBottom = viewport.scrollTop + viewport.height;
    const visibleLeft = viewport.scrollLeft;
    const visibleRight = viewport.scrollLeft + viewport.width;

    // Scroll margins for keeping node comfortably in view
    const marginY = this.ROW_HEIGHT * 2;
    const marginX = this.LANE_WIDTH * 2;

    let targetScrollTop = viewport.scrollTop;
    let targetScrollLeft = viewport.scrollLeft;

    // Vertical scrolling
    if (nodeY < visibleTop + marginY) {
      targetScrollTop = Math.max(0, nodeY - marginY);
    } else if (nodeY > visibleBottom - marginY - this.ROW_HEIGHT) {
      const size = this.virtualScroll.getContentSize();
      const maxScrollY = Math.max(0, size.height - viewport.height);
      targetScrollTop = Math.min(maxScrollY, nodeY - viewport.height + marginY + this.ROW_HEIGHT);
    }

    // Horizontal scrolling
    if (nodeX < visibleLeft + marginX) {
      targetScrollLeft = Math.max(0, nodeX - marginX);
    } else if (nodeX > visibleRight - marginX - this.LANE_WIDTH) {
      const size = this.virtualScroll.getContentSize();
      const maxScrollX = Math.max(0, size.width - viewport.width);
      targetScrollLeft = Math.min(maxScrollX, nodeX - viewport.width + marginX + this.LANE_WIDTH);
    }

    // Apply scroll if needed
    if (targetScrollTop !== viewport.scrollTop || targetScrollLeft !== viewport.scrollLeft) {
      this.scrollState.setScroll(targetScrollTop, targetScrollLeft);
      this.syncScrollbarPosition();
    }
  }

  /**
   * Public method to get all loaded commits (for command palette search)
   */
  public getLoadedCommits(): Commit[] {
    return Array.from(this.realCommits.values());
  }

  /**
   * Whether a commit is loaded (fetched from the backend), regardless of
   * whether the branch-visibility filter currently shows it. Lets callers
   * distinguish "not loaded yet — scroll/load more" from "loaded but
   * hidden by a filter" when selectCommit() returns false.
   */
  public hasLoadedCommit(oid: string): boolean {
    return this.realCommits.has(oid);
  }

  /**
   * Public method to select and scroll to a commit by OID
   * Used by other components (like commit details panel) to navigate the graph
   */
  public selectCommit(oid: string): boolean {
    if (!this.layout) {
      return false;
    }

    const node = this.layout.nodes.get(oid);
    if (!node) {
      return false;
    }

    // Update selection state first
    this.selectedNode = node;
    this.selectedNodes.clear();
    this.selectedNodes.add(node.oid);
    this.lastClickedNode = node;
    this.renderer?.setMultiSelection(this.selectedNodes, this.hoveredNode?.oid ?? null);

    // Scroll to node - this updates scroll state
    this.scrollToNode(node);

    // Focus canvas for keyboard navigation
    this.canvasEl.focus();

    // Dispatch selection event after scroll is set
    this.dispatchSelectionEvent();

    this.renderer?.markDirty();
    this.scheduleRender();

    return true;
  }

  private handleJumpToHeadClick = (): void => {
    if (this.jumpToHead()) {
      return;
    }
    // Same loaded-but-filtered vs not-loaded distinction as the shared
    // revealCommitInGraph path in app-shell (sibling reveal flows must give
    // consistent guidance). The component can't toast itself — app-shell
    // listens for graph-notice (same wiring as copy-sha).
    const headOid = this.getHeadOid();
    const message =
      headOid !== undefined && this.hasLoadedCommit(headOid)
        ? 'HEAD commit is hidden by the branch visibility filter — show its branch to reveal it'
        : 'HEAD commit is not loaded in the graph';
    this.dispatchEvent(
      new CustomEvent('graph-notice', {
        detail: { message, type: 'info' },
        bubbles: true,
        composed: true,
      })
    );
  };

  /**
   * Select and scroll to the commit HEAD points at.
   * Returns false when HEAD's commit is not in the loaded graph.
   */
  public jumpToHead(): boolean {
    const headOid = this.getHeadOid();
    if (!headOid) {
      return false;
    }
    return this.selectCommit(headOid);
  }

  /**
   * Tag tips from the loaded refs (for command-palette navigation)
   */
  public getTagTips(): Array<{ name: string; oid: string }> {
    const tips: Array<{ name: string; oid: string }> = [];
    for (const [oid, refs] of Object.entries(this.refsByCommit)) {
      for (const ref of refs) {
        if (ref.refType === 'tag') {
          tips.push({ name: ref.shorthand, oid });
        }
      }
    }
    return tips.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Navigate to the previous commit (up in the list)
   */
  public navigatePrevious(): void {
    if (this.sortedNodesByRow.length === 0) return;

    const currentIndex = this.selectedNode
      ? this.sortedNodesByRow.findIndex((n) => n.oid === this.selectedNode!.oid)
      : -1;

    if (currentIndex === -1) {
      this.selectByIndex(0);
    } else if (currentIndex > 0) {
      this.selectByIndex(currentIndex - 1);
    }
  }

  /**
   * Navigate to the next commit (down in the list)
   */
  public navigateNext(): void {
    if (this.sortedNodesByRow.length === 0) return;

    const currentIndex = this.selectedNode
      ? this.sortedNodesByRow.findIndex((n) => n.oid === this.selectedNode!.oid)
      : -1;

    if (currentIndex === -1) {
      this.selectByIndex(0);
    } else if (currentIndex < this.sortedNodesByRow.length - 1) {
      this.selectByIndex(currentIndex + 1);
    }

    // Load more when navigating near the end
    if (currentIndex >= this.sortedNodesByRow.length - 5) {
      this.checkLoadMore();
    }
  }

  /**
   * Navigate to the first commit (top of the list)
   */
  public navigateFirst(): void {
    if (this.sortedNodesByRow.length === 0) return;
    this.selectByIndex(0);
  }

  /**
   * Navigate to the last commit (bottom of the list)
   */
  public navigateLast(): void {
    if (this.sortedNodesByRow.length === 0) return;
    this.selectByIndex(this.sortedNodesByRow.length - 1);
  }

  /**
   * Navigate up by a page (half viewport height worth of commits)
   */
  public navigatePageUp(): void {
    if (this.sortedNodesByRow.length === 0) return;

    const currentIndex = this.selectedNode
      ? this.sortedNodesByRow.findIndex((n) => n.oid === this.selectedNode!.oid)
      : 0;

    // Calculate page size based on viewport (roughly half the visible rows)
    const viewport = this.getViewport();
    const pageSize = Math.max(1, Math.floor(viewport.height / this.ROW_HEIGHT / 2));
    const newIndex = Math.max(0, currentIndex - pageSize);
    this.selectByIndex(newIndex);
  }

  /**
   * Navigate down by a page (half viewport height worth of commits)
   */
  public navigatePageDown(): void {
    if (this.sortedNodesByRow.length === 0) return;

    const currentIndex = this.selectedNode
      ? this.sortedNodesByRow.findIndex((n) => n.oid === this.selectedNode!.oid)
      : 0;

    // Calculate page size based on viewport (roughly half the visible rows)
    const viewport = this.getViewport();
    const pageSize = Math.max(1, Math.floor(viewport.height / this.ROW_HEIGHT / 2));
    const newIndex = Math.min(this.sortedNodesByRow.length - 1, currentIndex + pageSize);
    this.selectByIndex(newIndex);
  }

  /**
   * Refresh the commit graph
   */
  public refresh(): void {
    // A load for this repo is already in flight (e.g. the cache
    // revalidation kicked off by a tab switch) — starting another now would
    // just cancel it and repeat the same backend walk with a spinner. But
    // the in-flight snapshot may predate whatever this refresh is about
    // (a commit, a pull), so queue exactly one follow-up load instead of
    // dropping the request.
    if (this.inFlightLoadPath === this.repositoryPath) {
      this.reloadQueued = true;
      return;
    }
    this.loadCommits();
  }

  private selectByIndex(index: number): void {
    if (index < 0 || index >= this.sortedNodesByRow.length) return;

    this.selectedNode = this.sortedNodesByRow[index];
    this.selectedNodes.clear();
    this.selectedNodes.add(this.selectedNode.oid);
    this.lastClickedNode = this.selectedNode;
    this.dispatchSelectionEvent();
    this.scrollToNode(this.selectedNode);
    this.renderer?.setMultiSelection(this.selectedNodes, this.hoveredNode?.oid ?? null);
    this.renderer?.markDirty();
    this.scheduleRender();
  }

  private hitTest(e: MouseEvent): HitTestResult {
    const rect = this.canvasEl.getBoundingClientRect();
    const viewport = this.getViewport();

    // Convert screen coords to graph coords, accounting for header offset
    const graphX = e.clientX - rect.left + viewport.scrollLeft;
    const graphY = e.clientY - rect.top + viewport.scrollTop - this.HEADER_HEIGHT;

    // First check spatial index for node hits
    if (this.spatialIndex) {
      const result = this.spatialIndex.hitTest(graphX, graphY);
      if (result.type === 'node' && result.node) {
        return result;
      }
    }

    // If no node hit, check if we clicked in a row (for message/label area)
    // Calculate which row was clicked based on Y coordinate
    // Use Math.round so the click region is centered around each node
    const adjustedY = graphY - this.PADDING;
    if (adjustedY >= 0 && this.layout) {
      const row = Math.round(adjustedY / this.ROW_HEIGHT);

      // One commit per row, rows are contiguous — O(1) lookup
      const node = this.sortedNodesByRow[row];
      if (node && node.row === row) {
        return { type: 'node', node, distance: 0 };
      }
    }

    return { type: 'none', distance: Infinity };
  }

  /**
   * Get human-readable label for ref type
   */
  private getRefTypeLabel(refType: string): string {
    switch (refType) {
      case 'localBranch':
        return 'Local branch';
      case 'remoteBranch':
        return 'Remote branch';
      case 'tag':
        return 'Tag';
      case 'pullRequest':
        return 'Pull request';
      case 'detachedHead':
        return 'Detached HEAD';
      default:
        return 'Reference';
    }
  }

  private dispatchSelectionEvent(): void {
    let commit: Commit | null = null;
    let refs: RefInfo[] = [];
    const commits: Commit[] = [];

    // Get all selected commits
    for (const oid of this.selectedNodes) {
      const c = this.realCommits.get(oid);
      if (c) {
        commits.push(c);
      }
    }

    if (this.selectedNode) {
      // Get real commit data if available (primary selection for details panel)
      commit = this.realCommits.get(this.selectedNode.oid) ?? null;
      // Get refs for this commit
      refs = this.refsByCommit[this.selectedNode.oid] ?? [];
    }

    this.dispatchEvent(
      new CustomEvent<CommitSelectedEvent>('commit-selected', {
        detail: { commit, commits, refs },
        bubbles: true,
        composed: true,
      })
    );

    // Announce the selection to assistive technology
    if (this.selectedNode && commit) {
      const position = this.selectedNode.row + 1;
      const total = this.layout?.totalRows ?? this.sortedNodesByRow.length;
      this.srAnnouncement = `Commit ${position} of ${total}: ${commit.summary} by ${commit.author.name}`;
    } else {
      this.srAnnouncement = '';
    }
  }

  private scheduleRender(): void {
    if (this.animationFrame) return;

    this.animationFrame = requestAnimationFrame(() => {
      this.animationFrame = 0;
      this.renderGraph();
    });
  }

  // Column resize methods
  private loadColumnWidths(): void {
    try {
      const saved = localStorage.getItem(this.COLUMN_STORAGE_KEY);
      if (saved) {
        const { refs, stats } = JSON.parse(saved);
        this.refsColumnWidth = refs ?? 200;
        this.statsColumnWidth = stats ?? 80;
      }
    } catch {
      // Ignore parse errors, use defaults
    }
  }

  private saveColumnWidths(): void {
    try {
      localStorage.setItem(this.COLUMN_STORAGE_KEY, JSON.stringify({
        refs: this.refsColumnWidth,
        stats: this.statsColumnWidth,
      }));
    } catch {
      // Ignore storage errors
    }
  }

  // Branch visibility methods
  private getBranchStorageKey(): string {
    return `${this.BRANCH_VISIBILITY_KEY}-${this.repositoryPath}`;
  }

  private loadHiddenBranches(): void {
    // Always reset first: a repo with no saved entry must NOT inherit the
    // previous repo's hidden branches
    this.hiddenBranches = new Set();
    try {
      const saved = localStorage.getItem(this.getBranchStorageKey());
      if (saved) {
        this.hiddenBranches = new Set(JSON.parse(saved));
      }
    } catch {
      // Ignore parse errors
    }
  }

  private saveHiddenBranches(): void {
    try {
      localStorage.setItem(
        this.getBranchStorageKey(),
        JSON.stringify([...this.hiddenBranches])
      );
    } catch {
      // Ignore storage errors
    }
  }

  /**
   * Get all available branch names from refs data
   */
  public getAvailableBranches(): { local: string[]; remote: string[] } {
    const localBranches = new Set<string>();
    const remoteBranches = new Set<string>();

    for (const refs of Object.values(this.refsByCommit)) {
      for (const ref of refs) {
        if (ref.refType === 'localBranch') {
          localBranches.add(ref.shorthand);
        } else if (ref.refType === 'remoteBranch') {
          remoteBranches.add(ref.shorthand);
        }
      }
    }

    return {
      local: [...localBranches].sort(),
      remote: [...remoteBranches].sort(),
    };
  }

  /**
   * Toggle branch visibility and re-filter the graph
   */
  public toggleBranch(branch: string): void {
    if (this.hiddenBranches.has(branch)) {
      this.hiddenBranches.delete(branch);
    } else {
      this.hiddenBranches.add(branch);
    }
    this.hiddenBranches = new Set(this.hiddenBranches); // trigger reactivity
    this.saveHiddenBranches();
    this.applyBranchFilter();
  }

  private showAllBranches(): void {
    this.hiddenBranches = new Set();
    this.saveHiddenBranches();
    this.applyBranchFilter();
  }

  private hideAllBranches(): void {
    const branches = this.getAvailableBranches();
    this.hiddenBranches = new Set([...branches.local, ...branches.remote]);
    this.saveHiddenBranches();
    this.applyBranchFilter();
  }

  private applyBranchFilter(): void {
    // processLayout() applies the branch-visibility filter via
    // getVisibleCommits(), rebuilds the indices, drops a selection the
    // filter just hid (applyLayout -> validateSelection), and schedules a
    // render
    this.processLayout();
  }

  // Export methods
  /**
   * Export graph as PNG image
   */
  public async exportAsImage(): Promise<void> {
    if (!this.renderer || !this.virtualScroll || !this.layout) return;
    const repoPath = this.repositoryPath;
    // Close the menu immediately — the data fill below is async and leaving
    // the item clickable would allow overlapping exports
    this.showExportMenu = false;

    // Viewport-lazy fetching may not have covered all loaded rows yet — the
    // export renders EVERY loaded row, so fill in missing stats/signature
    // data first or unscrolled rows would export with blank stats columns.
    // Queued behind any in-flight fetch: the marker sets are claimed at
    // fetch START, so checking them outside the queue could skip OIDs that
    // are claimed but whose data hasn't arrived yet.
    const allOids = [...this.layout.nodes.keys()];
    this.isLoadingStats = true;
    try {
      await this.queueDataFetch(async () => {
        const missingStats = allOids.filter((oid) => !this.statsFetchedOids.has(oid));
        const missingSignatures = allOids.filter(
          (oid) => !this.signaturesFetchedOids.has(oid)
        );
        if (missingStats.length === 0 && missingSignatures.length === 0) return;
        await this.fetchCommitDataBatches(repoPath, missingStats, missingSignatures);
      });
      if (this.repositoryPath === repoPath) {
        this.renderer.setCommitStats(this.commitStatsMap);
        this.renderer.setCommitSignatures(this.commitSignaturesMap);
      }
    } finally {
      if (this.repositoryPath === repoPath) {
        this.isLoadingStats = false;
      }
    }
    // The repository changed while fetching — abort the export
    if (this.repositoryPath !== repoPath || !this.layout) {
      return;
    }

    const contentSize = this.virtualScroll.getContentSize();

    // Size the export to the LOADED rows, not the virtual full-history
    // height — only loaded commits can be drawn, and sizing to the virtual
    // total would produce a mostly-blank image on large repos
    const loadedHeight = this.layout.totalRows * this.ROW_HEIGHT + this.PADDING * 2;
    // Limit export size for very large graphs
    const maxHeight = Math.min(loadedHeight + this.HEADER_HEIGHT + 40, 50000);
    const width = Math.max(contentSize.width, this.containerEl?.clientWidth ?? 800);

    // Create offscreen canvas
    const offscreen = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    offscreen.width = width * dpr;
    offscreen.height = maxHeight * dpr;

    // Create temporary renderer on offscreen canvas. Avatar fetching is
    // disabled: the export renders synchronously once, so kicking off
    // network loads would never paint into it.
    const tempRenderer = new CanvasRenderer(
      offscreen,
      {
        rowHeight: this.ROW_HEIGHT,
        laneWidth: this.LANE_WIDTH,
        nodeRadius: this.NODE_RADIUS,
        lineWidth: 2,
        showLabels: true,
        showFps: false,
        fetchAvatars: false,
        refsColumnWidth: this.refsColumnWidth,
        statsColumnWidth: this.statsColumnWidth,
        showAuthorColumn: this.showAuthorColumn,
        showDateColumn: this.showDateColumn,
        scaleNodesByCommitSize: settingsStore.getState().showCommitSize,
      },
      getThemeFromCSS()
    );

    // Copy state to temp renderer so the export matches what is on screen
    if (this.renderer) {
      tempRenderer.setCommitStats(this.renderer.getCommitStats());
      tempRenderer.setCommitSignatures(this.renderer.getCommitSignatures());
      tempRenderer.setHighlightedCommits(this.matchedCommitOids);
      tempRenderer.setMultiSelection(this.selectedNodes, null);
    }

    // Generate full render data (entire graph, no viewport clipping)
    const fullViewport = {
      scrollTop: 0,
      scrollLeft: 0,
      width,
      height: maxHeight,
    };
    const renderData = this.virtualScroll.getRenderData(fullViewport);
    tempRenderer.render(renderData);

    // Convert to blob and download
    offscreen.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `graph-${new Date().toISOString().slice(0, 10)}.png`;
      a.click();
      URL.revokeObjectURL(url);
      tempRenderer.destroy();
    }, 'image/png');

    this.showExportMenu = false;
  }

  /**
   * Export graph as SVG
   */
  public exportAsSvg(): void {
    if (!this.layout || !this.virtualScroll) return;

    const contentSize = this.virtualScroll.getContentSize();
    const width = Math.max(contentSize.width, this.containerEl?.clientWidth ?? 800);
    // Loaded rows only — see exportAsImage
    const loadedHeight = this.layout.totalRows * this.ROW_HEIGHT + this.PADDING * 2;
    const height = loadedHeight + this.HEADER_HEIGHT + 40;
    const theme = getThemeFromCSS();

    const svgParts: string[] = [];
    svgParts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
    svgParts.push(`<rect width="100%" height="100%" fill="${theme.background}"/>`);

    const offsetX = this.PADDING;
    const offsetY = this.PADDING + this.HEADER_HEIGHT;
    const maxLane = this.layout.maxLane;

    // Draw edges
    for (const edge of this.layout.edges) {
      const fromX = offsetX + (maxLane - edge.fromLane) * this.LANE_WIDTH;
      const fromY = offsetY + edge.fromRow * this.ROW_HEIGHT;
      const toX = offsetX + (maxLane - edge.toLane) * this.LANE_WIDTH;
      const toY = offsetY + edge.toRow * this.ROW_HEIGHT;
      const color = theme.laneColors[edge.colorIndex % theme.laneColors.length];

      if (edge.fromLane === edge.toLane) {
        svgParts.push(`<line x1="${fromX}" y1="${fromY}" x2="${toX}" y2="${toY}" stroke="${color}" stroke-width="2" stroke-linecap="round"/>`);
      } else {
        const midY = fromY + (toY - fromY) * 0.5;
        svgParts.push(`<path d="M${fromX},${fromY} C${fromX},${midY} ${toX},${midY} ${toX},${toY}" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round"/>`);
      }
    }

    // Draw nodes
    for (const node of this.layout.nodes.values()) {
      const x = offsetX + (maxLane - node.lane) * this.LANE_WIDTH;
      const y = offsetY + node.row * this.ROW_HEIGHT;
      const color = theme.laneColors[node.colorIndex % theme.laneColors.length];
      const commit = this.realCommits.get(node.oid);
      const isMerge = commit && commit.parentIds.length > 1;
      // Reuse the renderer's radius so the export matches what is on screen,
      // including the "Show Commit Size" setting
      const radius = this.renderer?.getNodeRadius(node.oid) ?? this.NODE_RADIUS;

      if (isMerge) {
        svgParts.push(`<circle cx="${x}" cy="${y}" r="${radius}" fill="${theme.background}" stroke="${color}" stroke-width="2"/>`);
      } else {
        svgParts.push(`<circle cx="${x}" cy="${y}" r="${radius}" fill="${color}"/>`);
      }

      // Add commit message text
      if (commit) {
        const textX = offsetX + (maxLane + 1) * this.LANE_WIDTH + 50;
        const escapedMessage = commit.summary
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        svgParts.push(`<text x="${textX}" y="${y + 4}" fill="${theme.textColor}" font-family="system-ui, sans-serif" font-size="12">${escapedMessage}</text>`);
      }

      // Add ref labels
      const refs = this.refsByCommit[node.oid];
      if (refs?.length) {
        const labelX = offsetX + (maxLane + 1) * this.LANE_WIDTH + 30;
        for (let i = 0; i < Math.min(refs.length, 3); i++) {
          const ref = refs[i];
          const lx = labelX + i * 80;
          const escapedLabel = ref.shorthand
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
          let bgColor = theme.refColors.localBranch;
          if (ref.refType === 'remoteBranch') bgColor = theme.refColors.remoteBranch;
          else if (ref.refType === 'tag') bgColor = theme.refColors.tag;
          svgParts.push(`<rect x="${lx}" y="${y - 8}" width="70" height="16" rx="3" fill="${bgColor}" opacity="0.8"/>`);
          svgParts.push(`<text x="${lx + 4}" y="${y + 3}" fill="white" font-family="system-ui, sans-serif" font-size="10">${escapedLabel}</text>`);
        }
      }
    }

    svgParts.push('</svg>');

    const svgContent = svgParts.join('\n');
    const blob = new Blob([svgContent], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `graph-${new Date().toISOString().slice(0, 10)}.svg`;
    a.click();
    URL.revokeObjectURL(url);

    this.showExportMenu = false;
  }

  private updateRendererColumnWidths(): void {
    this.renderer?.setConfig({
      refsColumnWidth: this.refsColumnWidth,
      statsColumnWidth: this.statsColumnWidth,
    });
  }

  private handleResizeStart(e: MouseEvent, column: 'refs' | 'stats'): void {
    e.preventDefault();
    e.stopPropagation();
    this.resizing = column;
    this.resizeStartX = e.clientX;
    this.resizeStartWidth = column === 'refs'
      ? this.refsColumnWidth
      : this.statsColumnWidth;

    document.addEventListener('mousemove', this.handleResizeMove);
    document.addEventListener('mouseup', this.handleResizeEnd);
  }

  private handleResizeMove = (e: MouseEvent): void => {
    if (!this.resizing) return;

    const delta = e.clientX - this.resizeStartX;

    if (this.resizing === 'refs') {
      // Refs column: wider when dragging right
      this.refsColumnWidth = Math.max(80, Math.min(400, this.resizeStartWidth + delta));
    } else {
      // Stats column: wider when dragging left (inverted)
      this.statsColumnWidth = Math.max(50, Math.min(150, this.resizeStartWidth - delta));
    }

    this.updateRendererColumnWidths();
    this.renderer?.markDirty();
    this.scheduleRender();
  };

  private handleResizeEnd = (): void => {
    this.resizing = null;
    document.removeEventListener('mousemove', this.handleResizeMove);
    document.removeEventListener('mouseup', this.handleResizeEnd);
    this.saveColumnWidths();
  };

  private getResizeHandlePositions(): { refsEnd: number; statsStart: number } | null {
    if (!this.renderer || !this.layout) return null;
    return this.renderer.getColumnBoundaries(this.layout.maxLane, this.PADDING);
  }

  private renderGraph(): void {
    if (!this.renderer || !this.virtualScroll || !this.layout) return;

    const startTime = performance.now();

    const viewport = this.getViewport();
    const renderData = this.virtualScroll.getRenderData(viewport);

    this.lastRenderData = renderData;
    this.visibleNodes = renderData.nodes.length;
    this.renderMinimap();

    // Refresh the screen-reader mirror only when the visible window changed
    const mirrorKey = `${renderData.range.startRow}-${renderData.range.endRow}-${this.layout.totalRows}`;
    if (mirrorKey !== this.lastMirrorKey) {
      this.lastMirrorKey = mirrorKey;
      this.mirrorNodes = [...renderData.nodes].sort((a, b) => a.row - b.row);
    }

    this.renderer.render(renderData);

    const stats = this.renderer.getPerformanceStats();
    this.fps = stats.fps;
    this.renderTimeMs = performance.now() - startTime;
  }

  private renderBranchPanel() {
    const branches = this.getAvailableBranches();

    return html`
      <div class="branch-panel">
        <div class="branch-panel-header">
          <span>Branch Visibility</span>
          <div class="branch-panel-actions">
            <button @click=${() => this.showAllBranches()}>Show All</button>
            <button @click=${() => this.hideAllBranches()}>Hide All</button>
          </div>
        </div>
        <div class="branch-panel-list">
          ${branches.local.length > 0
            ? html`
                <div class="branch-group-label">Local</div>
                ${branches.local.map(
                  (branch) => html`
                    <label class="branch-item">
                      <input
                        type="checkbox"
                        .checked=${!this.hiddenBranches.has(branch)}
                        @change=${() => this.toggleBranch(branch)}
                      />
                      <span class="branch-name">${branch}</span>
                    </label>
                  `
                )}
              `
            : ''}
          ${branches.remote.length > 0
            ? html`
                <div class="branch-group-label">Remote</div>
                ${branches.remote.map(
                  (branch) => html`
                    <label class="branch-item">
                      <input
                        type="checkbox"
                        .checked=${!this.hiddenBranches.has(branch)}
                        @change=${() => this.toggleBranch(branch)}
                      />
                      <span class="branch-name">${branch}</span>
                    </label>
                  `
                )}
              `
            : ''}
        </div>
      </div>
    `;
  }

  private renderExportMenu() {
    return html`
      <div
        class="export-menu"
        style=${this.exportMenuRight !== null ? `right: ${this.exportMenuRight}px` : ''}
      >
        <button class="export-menu-item" @click=${() => this.exportAsImage()}>
          Export as PNG
        </button>
        <button class="export-menu-item" @click=${() => this.exportAsSvg()}>
          Export as SVG
        </button>
      </div>
    `;
  }

  private renderColumnsMenu() {
    return html`
      <div
        class="export-menu columns-menu"
        style=${this.columnsMenuRight !== null ? `right: ${this.columnsMenuRight}px` : ''}
      >
        <label class="branch-item">
          <input
            type="checkbox"
            .checked=${this.showAuthorColumn}
            @change=${() => this.toggleOptionalColumn('author')}
          />
          <span class="branch-name">Author</span>
        </label>
        <label class="branch-item">
          <input
            type="checkbox"
            .checked=${this.showDateColumn}
            @change=${() => this.toggleOptionalColumn('date')}
          />
          <span class="branch-name">Date</span>
        </label>
      </div>
    `;
  }

  /**
   * True when the repository genuinely has nothing to draw: the first load
   * for THIS repository has finished, nothing is in flight, no error is
   * showing, and the walk came back with zero commits — i.e. a repository
   * that has just been `init`ed. Gated on hasCompletedLoad so the panel can
   * never flash before the first load has had its chance to run.
   */
  private showEmptyState(): boolean {
    return (
      this.hasCompletedLoad &&
      !this.isLoading &&
      !this.loadError &&
      this.totalLoadedCommits === 0
    );
  }

  /**
   * Canvas label for the three states the graph can be in. "Loading commit
   * graph..." is reserved for an actual in-flight load — an empty repository
   * used to announce it forever because the label was keyed only on the
   * commit count.
   */
  private canvasAriaLabel(): string {
    if (this.isLoading) return 'Loading commit graph...';
    if (this.totalLoadedCommits > 0) {
      const total = this.commitTotal !== null ? ` of ${this.commitTotal}` : '';
      return `Git commit history showing ${this.totalLoadedCommits}${total} commits`;
    }
    if (this.loadError) return 'Commit graph failed to load';
    return 'No commits';
  }

  /** Re-run the failed load from the error panel's Retry button */
  private handleRetryLoad = (): void => {
    if (this.isLoading) return;
    // loadCommits() clears loadError and raises isLoading itself, so the
    // panel swaps to "Retrying..." and the centered spinner appears
    this.loadCommits();
  };

  render() {
    const handlePositions = this.getResizeHandlePositions();

    return html`
      <div class="container">
        <div class="canvas-container">
          <div class="scroll-container">
            <div class="scroll-content"></div>
          </div>
          <canvas
            tabindex="0"
            role="img"
            aria-label="${this.canvasAriaLabel()}"
          ></canvas>

          ${this.showMinimap
            ? html`
                <canvas
                  class="minimap-canvas"
                  aria-hidden="true"
                  @mousedown=${this.handleMinimapPointerDown}
                ></canvas>
              `
            : ''}

          ${handlePositions
            ? html`
                <div
                  class="resize-handle ${this.resizing === 'refs' ? 'dragging' : ''}"
                  style="left: ${handlePositions.refsEnd}px"
                  @mousedown=${(e: MouseEvent) => this.handleResizeStart(e, 'refs')}
                ></div>
                <div
                  class="resize-handle ${this.resizing === 'stats' ? 'dragging' : ''}"
                  style="left: ${handlePositions.statsStart}px"
                  @mousedown=${(e: MouseEvent) => this.handleResizeStart(e, 'stats')}
                ></div>
              `
            : ''}

          ${this.loadError
            ? html`
                <div class="info-panel error-panel" role="alert">
                  <div class="error-title">Error</div>
                  <div class="message">${this.loadError}</div>
                  <div class="panel-actions">
                    <button
                      class="retry-btn"
                      title="Retry loading the commit graph"
                      ?disabled=${this.isLoading}
                      @click=${this.handleRetryLoad}
                    >
                      ${this.isLoading ? 'Retrying...' : 'Retry'}
                    </button>
                  </div>
                </div>
              `
            : ''}

          ${this.isLoading
            ? html`
                <!--
                  Purely visual: the canvas aria-label already announces
                  "Loading commit graph...", and a second live region would
                  re-announce on every commit/pull/watcher refresh.
                -->
                <div class="graph-overlay loading-state" aria-hidden="true">
                  <div class="spinner"></div>
                  <div class="overlay-title">Loading commits...</div>
                </div>
              `
            : this.showEmptyState()
              ? html`
                  <div class="graph-overlay empty-state" role="status">
                    <div class="overlay-title">No commits yet</div>
                    <div class="overlay-hint">
                      Stage a file and write a message in the Commit panel to
                      create the first commit in this repository.
                    </div>
                  </div>
                `
              : ''}

          <div
            class="avatar-tooltip ${this.tooltipVisible ? 'visible' : ''}"
            style="left: ${this.tooltipX}px; top: ${this.tooltipY}px;"
          >
            <div class="author-name">${this.tooltipAuthorName}</div>
            ${this.tooltipAuthorEmail
              ? html`<div class="author-email">${this.tooltipAuthorEmail}</div>`
              : ''}
          </div>

          ${this.isLoadingStats
            ? html`
                <div class="loading-indicator">
                  <div class="spinner"></div>
                  <span>Loading stats...</span>
                </div>
              `
            : ''}

          ${this.isLoadingMore
            ? html`
                <div class="loading-indicator">
                  <div class="spinner"></div>
                  <span>
                    Loading more commits...${this.commitTotal !== null
                      ? ` (${this.totalLoadedCommits} of ${this.commitTotal})`
                      : ''}
                  </span>
                </div>
              `
            : ''}

          <div class="graph-toolbar">
            <button
              class="toolbar-btn"
              title="Jump to HEAD"
              @click=${this.handleJumpToHeadClick}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3"></circle>
                <circle cx="12" cy="12" r="9"></circle>
                <line x1="12" y1="1" x2="12" y2="5"></line>
                <line x1="12" y1="19" x2="12" y2="23"></line>
                <line x1="1" y1="12" x2="5" y2="12"></line>
                <line x1="19" y1="12" x2="23" y2="12"></line>
              </svg>
              HEAD
            </button>
            <button
              class="toolbar-btn ${this.showMinimap ? 'active' : ''}"
              title="Toggle minimap"
              @click=${() => this.toggleMinimap()}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2"></rect>
                <line x1="16" y1="3" x2="16" y2="21"></line>
                <line x1="19" y1="7" x2="19" y2="9"></line>
                <line x1="19" y1="13" x2="19" y2="16"></line>
              </svg>
              Map
            </button>
            <button
              class="toolbar-btn ${this.showColumnsMenu ? 'active' : ''}"
              title="Toggle optional columns"
              @click=${(e: MouseEvent) => {
                this.columnsMenuRight = this.menuRightOffset(e);
                this.showColumnsMenu = !this.showColumnsMenu;
                this.showBranchPanel = false;
                this.showExportMenu = false;
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2"></rect>
                <line x1="9" y1="3" x2="9" y2="21"></line>
                <line x1="15" y1="3" x2="15" y2="21"></line>
              </svg>
              Columns
            </button>
            <button
              class="toolbar-btn ${this.showBranchPanel ? 'active' : ''}"
              title="Toggle branch visibility"
              @click=${() => { this.showBranchPanel = !this.showBranchPanel; this.showExportMenu = false; this.showColumnsMenu = false; }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="6" y1="3" x2="6" y2="15"></line>
                <circle cx="18" cy="6" r="3"></circle>
                <circle cx="6" cy="18" r="3"></circle>
                <path d="M18 9a9 9 0 01-9 9"></path>
              </svg>
              Branches
            </button>
            <button
              class="toolbar-btn ${this.showExportMenu ? 'active' : ''}"
              title="Export graph"
              @click=${(e: MouseEvent) => {
                this.exportMenuRight = this.menuRightOffset(e);
                this.showExportMenu = !this.showExportMenu;
                this.showBranchPanel = false;
                this.showColumnsMenu = false;
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              Export
            </button>
          </div>

          ${this.showBranchPanel ? this.renderBranchPanel() : ''}
          ${this.showExportMenu ? this.renderExportMenu() : ''}
          ${this.showColumnsMenu ? this.renderColumnsMenu() : ''}

          <div class="sr-only" role="listbox" aria-label="Commits" aria-multiselectable="true">
            ${this.mirrorNodes.map((node) => {
              const commit = this.realCommits.get(node.oid);
              return html`
                <div
                  role="option"
                  aria-selected=${this.selectedNodes.has(node.oid) ? 'true' : 'false'}
                  aria-setsize=${this.layout?.totalRows ?? this.mirrorNodes.length}
                  aria-posinset=${node.row + 1}
                >
                  ${commit?.summary ?? node.commit.message} by
                  ${commit?.author.name ?? node.commit.author}
                </div>
              `;
            })}
          </div>
          <div class="sr-only" role="status" aria-live="polite">
            ${this.srAnnouncement}
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-graph-canvas': LvGraphCanvas;
  }
}
