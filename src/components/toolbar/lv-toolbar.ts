/**
 * Main Toolbar Component
 * Contains menu buttons and repository tabs
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { repositoryStore, type OpenRepository } from '../../stores/index.ts';
import { openRepository } from '../../services/git.service.ts';
import { openRepositoryDialog } from '../../services/dialog.service.ts';
import { showToast } from '../../services/notification.service.ts';
import {
  openRepositoryInTerminal,
  openRepositoryInFileManager,
  openRepositoryInEditor,
} from '../../services/open-location.service.ts';
import { searchIndexService } from '../../services/search-index.service.ts';
import { embeddingIndexService } from '../../services/embedding-index.service.ts';
import { loggers } from '../../utils/logger.ts';

const log = loggers.ui;
import '../dialogs/lv-clone-dialog.ts';
import '../dialogs/lv-init-dialog.ts';
import './lv-search-bar.ts';
// Profile selector moved to context dashboard
import type { LvCloneDialog } from '../dialogs/lv-clone-dialog.ts';
import type { LvInitDialog } from '../dialogs/lv-init-dialog.ts';
import type { LvSearchBar, SearchFilter } from './lv-search-bar.ts';
import { isTopOverlay } from '../../utils/overlay-stack.ts';
import { RefLockController, isPushRunning } from '../../utils/ref-lock.ts';
import { runningRemoteOperation } from '../../services/remote-operations.service.ts';

/** The three remote operations the toolbar exposes. */
type RemoteOp = 'fetch' | 'pull' | 'push';

/**
 * The shortcut key registered for each operation in keyboard.service.ts
 * (Ctrl+Shift+F/P/U). Kept next to the buttons so the tooltip and the
 * aria-keyshortcuts value can never drift apart: both are built from THIS
 * table and the same `isMacPlatform` test, so a screen reader is never told
 * Control while the tooltip shows ⌘.
 */
const REMOTE_SHORTCUT_KEYS: Record<RemoteOp, string> = {
  fetch: 'F',
  pull: 'P',
  push: 'U',
};

@customElement('lv-toolbar')
export class LvToolbar extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: flex;
        align-items: center;
        height: 48px;
        padding-left: 78px; /* Space for macOS traffic light buttons */
        background: var(--color-bg-secondary);
        border-bottom: 1px solid var(--color-border);
        -webkit-app-region: drag;
      }

      .toolbar-section {
        display: flex;
        align-items: center;
        -webkit-app-region: no-drag;
      }

      .menu-buttons {
        display: flex;
        gap: var(--spacing-xs);
        padding: 0 var(--spacing-sm);
        border-right: 1px solid var(--color-border);
      }

      .menu-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .menu-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .menu-btn svg {
        width: 18px;
        height: 18px;
      }

      .tabs-container {
        display: flex;
        align-items: center;
        flex: 1;
        min-width: 0;
        position: relative;
      }

      .tabs {
        display: flex;
        flex: 1;
        min-width: 0;
        overflow-x: auto;
        padding: 0 var(--spacing-xs);
        gap: var(--spacing-xs);
        scroll-behavior: smooth;
        /* Scrolling happens via wheel/trackpad and the arrow buttons; a
           scrollbar in a 32px-high strip is just noise */
        scrollbar-width: none;
      }

      .tabs::-webkit-scrollbar {
        display: none;
      }

      .scroll-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        border-radius: var(--radius-sm);
        background: var(--color-bg-tertiary);
        color: var(--color-text-secondary);
        cursor: pointer;
        flex-shrink: 0;
        transition: all var(--transition-fast);
        opacity: 0;
        pointer-events: none;
      }

      .scroll-btn.visible {
        opacity: 1;
        pointer-events: auto;
      }

      .scroll-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .scroll-btn svg {
        width: 14px;
        height: 14px;
      }

      .tab {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: 0 var(--spacing-sm);
        height: 32px;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        cursor: pointer;
        transition: all var(--transition-fast);
        white-space: nowrap;
        /* Tabs shrink (with ellipsis) before the strip overflows */
        flex: 0 1 auto;
        min-width: 90px;
        max-width: 200px;
      }

      .tab:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .tab.active {
        background: var(--color-bg-tertiary);
        color: var(--color-text-primary);
        font-weight: 600;
        box-shadow: inset 0 -2px 0 var(--color-accent, var(--color-primary));
      }

      .tab-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: left;
      }

      .tab-hint {
        color: var(--color-text-muted);
        font-size: var(--font-size-xs);
        font-weight: normal;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 70px;
      }

      .tab-dirty {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--color-warning, #e5a50a);
        flex-shrink: 0;
      }

      .tab-ahead-behind {
        color: var(--color-text-muted);
        font-size: var(--font-size-xs);
        font-weight: normal;
        flex-shrink: 0;
      }

      .provider-icon {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
      }

      .provider-icon.github {
        color: var(--color-text-secondary);
      }

      .provider-icon.ado {
        color: #0078d4;
      }

      .provider-icon.gitlab {
        color: #fc6d26;
      }

      .provider-icon.bitbucket {
        color: #0052cc;
      }

      /* Sits flush inside the tab, which clips its overflow: draw the shared
         keyboard focus ring inside the hit area so it is not cut off. */
      .tab-close {
        --lv-focus-ring-offset: -2px;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: var(--radius-sm);
        opacity: 0.5;
        transition: opacity var(--transition-fast);
        margin-left: auto;
        flex-shrink: 0;
      }

      .tab:hover .tab-close {
        opacity: 1;
      }

      .tab-close:hover {
        background: var(--color-bg-hover);
      }

      .tab-close svg {
        width: 12px;
        height: 12px;
      }

      .no-repos {
        padding: 0 var(--spacing-md);
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
        font-style: italic;
      }

      .menu-backdrop {
        position: fixed;
        inset: 0;
        z-index: 999;
      }

      .tab-list-menu,
      .tab-context-menu {
        position: fixed;
        z-index: 1000;
        min-width: 220px;
        max-width: 360px;
        max-height: 60vh;
        overflow-y: auto;
        padding: var(--spacing-xs);
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      }

      .tab-list-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        width: 100%;
        padding: var(--spacing-xs) var(--spacing-sm);
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        cursor: pointer;
        text-align: left;
      }

      .tab-list-item:hover {
        background: var(--color-bg-hover);
      }

      .tab-list-item .check {
        width: 14px;
        flex-shrink: 0;
        color: var(--color-accent, var(--color-primary));
      }

      .tab-list-item .item-texts {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }

      .tab-list-item .item-path {
        color: var(--color-text-muted);
        font-size: var(--font-size-xs);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        direction: rtl;
        text-align: left;
      }

      .context-menu-item {
        display: block;
        width: 100%;
        padding: var(--spacing-xs) var(--spacing-sm);
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        cursor: pointer;
        text-align: left;
      }

      .context-menu-item:hover {
        background: var(--color-bg-hover);
      }

      .context-menu-item:disabled {
        color: var(--color-text-muted);
        cursor: default;
      }

      .context-menu-item:disabled:hover {
        background: transparent;
      }

      .context-menu-separator {
        height: 1px;
        margin: var(--spacing-xs) 0;
        background: var(--color-border);
      }

      /* Fetch / Pull / Push — the same 32px menu-btn density as every other
         toolbar button, plus room for the ahead/behind count badge. */
      .remote-actions {
        gap: var(--spacing-xs);
        padding: 0 var(--spacing-sm);
        border-left: 1px solid var(--color-border);
      }

      .remote-btn {
        position: relative;
      }

      /* Nothing to pull/push right now: still clickable (the counts are only
         as fresh as the last fetch), but visibly not calling for a click. */
      .remote-btn.idle {
        opacity: 0.55;
      }

      .remote-btn.idle:hover {
        opacity: 1;
      }

      .remote-btn:disabled {
        opacity: 0.35;
        cursor: default;
      }

      .remote-btn:disabled:hover {
        background: transparent;
        color: var(--color-text-secondary);
      }

      /* Same shape and the same two colours the dashboard badges use, so the
         two surfaces read as one thing: primary for incoming, success for
         outgoing. */
      .remote-count {
        position: absolute;
        top: -1px;
        right: -1px;
        min-width: 14px;
        height: 14px;
        padding: 0 3px;
        border-radius: var(--radius-full, 7px);
        color: white;
        font-size: 9px;
        font-weight: 600;
        line-height: 14px;
        text-align: center;
      }

      .remote-btn.pull .remote-count {
        background: var(--color-primary);
      }

      .remote-btn.push .remote-count {
        background: var(--color-success);
      }
    `,
  ];

  @state() private openRepositories: OpenRepository[] = [];
  @state() private activeIndex = -1;
  @state() private isLoading = false;

  @query('lv-clone-dialog') private cloneDialog!: LvCloneDialog;
  @query('lv-init-dialog') private initDialog!: LvInitDialog;
  @query('lv-search-bar') private searchBar!: LvSearchBar;
  @query('.tabs') private tabsContainer!: HTMLElement;

  @state() private showSearch = false;
  @state() private semanticAvailable = false;
  @state() private canScrollLeft = false;
  @state() private canScrollRight = false;
  // Anchor for the "all open repositories" dropdown (null = closed)
  @state() private tabListAnchor: { x: number; y: number } | null = null;
  // Right-click context menu on a tab (null = closed)
  @state() private tabContextMenu: { x: number; y: number; index: number } | null = null;

  private unsubscribe?: () => void;
  private _resizeObserver?: ResizeObserver;

  connectedCallback(): void {
    super.connectedCallback();
    // Seed from current store state — repos may already be open if the
    // toolbar (re)mounts after startup restore
    const initial = repositoryStore.getState();
    this.openRepositories = initial.openRepositories;
    this.activeIndex = initial.activeIndex;
    this.isLoading = initial.isLoading;
    // Subscribe to store changes
    this.unsubscribe = repositoryStore.subscribe((state) => {
      this.openRepositories = state.openRepositories;
      const prevIndex = this.activeIndex;
      this.activeIndex = state.activeIndex;
      this.isLoading = state.isLoading;

      // Check semantic availability when active repo changes
      if (state.activeIndex !== prevIndex && state.activeIndex >= 0 && state.activeIndex < state.openRepositories.length) {
        const activeRepo = state.openRepositories[state.activeIndex];
        if (activeRepo) {
          this.checkSemanticAvailability(activeRepo.repository.path);
        }
      }
    });

    // Listen for focus-search event from app-shell
    this.addEventListener('focus-search', () => {
      this.showSearch = true;
      this.updateComplete.then(() => {
        this.searchBar?.focus();
      });
    });

    // The native menu bar's File items are routed here by app-shell rather
    // than reimplemented: these are the same handlers the toolbar buttons run,
    // dialogs and error toasts included.
    this.addEventListener('open-repository', this.handleMenuOpenRepo);
    this.addEventListener('clone-repository', this.handleMenuCloneRepo);
    this.addEventListener('init-repository', this.handleMenuInitRepo);
  }

  private handleMenuOpenRepo = (): void => {
    void this.handleOpenRepo();
  };

  private handleMenuCloneRepo = (): void => {
    this.handleCloneRepo();
  };

  private handleMenuInitRepo = (): void => {
    this.handleInitRepo();
  };

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this._resizeObserver?.disconnect();
    this.removeEventListener('open-repository', this.handleMenuOpenRepo);
    this.removeEventListener('clone-repository', this.handleMenuCloneRepo);
    this.removeEventListener('init-repository', this.handleMenuInitRepo);
    if (this.menuEscapeListenerAttached) {
      document.removeEventListener('keydown', this.handleMenuEscape, { capture: true });
      this.menuEscapeListenerAttached = false;
    }
  }

  private async handleOpenRepo(): Promise<void> {
    log.debug('handleOpenRepo called');
    try {
      const path = await openRepositoryDialog();
      log.debug('Got path:', path);
      if (!path) return;

      const store = repositoryStore.getState();
      store.setLoading(true);

      try {
        const result = await openRepository({ path });
        if (result.success && result.data) {
          store.addRepository(result.data);
          // Build search index in background (non-blocking)
          searchIndexService.buildIndex(path);
          // Build embedding index and check semantic availability
          embeddingIndexService.buildIndex(path).then(() => {
            this.checkSemanticAvailability(path);
          }).catch((err) => {
            console.error('Failed to build embedding index:', err);
          });
        } else {
          const message = result.error?.message ?? 'Failed to open repository';
          store.setError(message);
          // repositoryStore.error has no render sink, so surface it directly.
          showToast(message, 'error');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        store.setError(message);
        showToast(message, 'error');
      } finally {
        store.setLoading(false);
      }
    } catch (error) {
      log.error('Error in handleOpenRepo:', error);
      showToast(error instanceof Error ? error.message : 'Failed to open repository', 'error');
    }
  }

  private handleCloneRepo(): void {
    this.cloneDialog.open();
  }

  private handleInitRepo(): void {
    this.initDialog.open();
  }

  private handleTabClick(index: number): void {
    repositoryStore.getState().setActiveIndex(index);
  }

  private handleTabClose(e: Event, path: string): void {
    e.stopPropagation();
    repositoryStore.getState().removeRepository(path);
  }

  // Middle-click closes a tab (browser-tab convention)
  private handleTabAuxClick(e: MouseEvent, path: string): void {
    if (e.button === 1) {
      e.preventDefault();
      repositoryStore.getState().removeRepository(path);
    }
  }

  private handleTabContextMenu(e: MouseEvent, index: number): void {
    e.preventDefault();
    e.stopPropagation();
    this.tabListAnchor = null;
    this.tabContextMenu = { x: e.clientX, y: e.clientY, index };
  }

  private handleCloseOtherTabs(index: number): void {
    const keep = repositoryStore.getState().openRepositories[index]?.repository.path;
    this.tabContextMenu = null;
    if (!keep) return;
    const others = repositoryStore
      .getState()
      .openRepositories.filter((r) => r.repository.path !== keep)
      .map((r) => r.repository.path);
    for (const path of others) {
      repositoryStore.getState().removeRepository(path);
    }
  }

  private handleCloseTabsToRight(index: number): void {
    this.tabContextMenu = null;
    const toClose = repositoryStore
      .getState()
      .openRepositories.slice(index + 1)
      .map((r) => r.repository.path);
    for (const path of toClose) {
      repositoryStore.getState().removeRepository(path);
    }
  }

  private handleCloseAllTabs(): void {
    this.tabContextMenu = null;
    const toClose = repositoryStore
      .getState()
      .openRepositories.map((r) => r.repository.path);
    for (const path of toClose) {
      repositoryStore.getState().removeRepository(path);
    }
  }

  private async handleCopyTabPath(index: number): Promise<void> {
    const path = repositoryStore.getState().openRepositories[index]?.repository.path;
    this.tabContextMenu = null;
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      showToast('Repository path copied', 'success');
    } catch {
      showToast('Failed to copy path', 'error');
    }
  }

  /**
   * The three "open this repository elsewhere" tab actions. Like Copy Path
   * they act on the CLICKED tab, not the active one, so the path is read from
   * the store by the context menu's index before the menu closes.
   * Success is the OS opening something; only failures are reported, by the
   * shared service, using the backend's own message.
   */
  private async handleOpenTabInTerminal(index: number): Promise<void> {
    const path = repositoryStore.getState().openRepositories[index]?.repository.path;
    this.tabContextMenu = null;
    if (!path) return;
    await openRepositoryInTerminal(path);
  }

  private async handleRevealTabInFileManager(index: number): Promise<void> {
    const path = repositoryStore.getState().openRepositories[index]?.repository.path;
    this.tabContextMenu = null;
    if (!path) return;
    await openRepositoryInFileManager(path);
  }

  private async handleOpenTabInEditor(index: number): Promise<void> {
    const path = repositoryStore.getState().openRepositories[index]?.repository.path;
    this.tabContextMenu = null;
    if (!path) return;
    await openRepositoryInEditor(path);
  }

  private handleToggleTabList(e: MouseEvent): void {
    if (this.tabListAnchor) {
      this.tabListAnchor = null;
      return;
    }
    this.tabContextMenu = null;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.tabListAnchor = { x: rect.right, y: rect.bottom + 4 };
  }

  private handleTabListSelect(index: number): void {
    this.tabListAnchor = null;
    repositoryStore.getState().setActiveIndex(index);
  }

  /**
   * When several open repos share a name (two clones of "api"), the bare
   * name can't identify a tab — disambiguate with the parent directory.
   */
  private getTabHint(repo: OpenRepository): string | null {
    const name = repo.repository.name;
    const sameName = this.openRepositories.filter((r) => r.repository.name === name);
    if (sameName.length < 2) return null;
    // Split on both separators — Windows paths use backslashes
    const parts = repo.repository.path.split(/[\\/]/).filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2] : null;
  }

  private handleTabCloseKeydown(e: KeyboardEvent, path: string): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      repositoryStore.getState().removeRepository(path);
    }
  }

  private get activeRepo(): OpenRepository | undefined {
    return this.openRepositories[this.activeIndex];
  }

  /**
   * Observe the shared operation locks so the remote buttons re-render when
   * an operation starts or ends anywhere in the app.
   *
   * The locks are module state Lit cannot see (src/utils/ref-lock.ts); the
   * controller's subscription fires on every claim and release of BOTH the
   * working-tree lock and the push slot, which is what makes the in-flight
   * disabled states below reactive. `busy` itself is the working-tree lock —
   * the one a pull claims.
   */
  private lock = new RefLockController(this, () => this.activeRepo?.repository.path);

  /**
   * macOS, tested exactly the way keyboard.service.ts tests it.
   *
   * Case-insensitive on purpose: `navigator.platform` reports "MacIntel" and
   * "MacPPC" but also "iPad"/"iPhone" for a WKWebView, and the old
   * `includes('Mac')` here disagreed with keyboard.service's
   * `toLowerCase().includes('mac')` — the two must answer the same question
   * the same way or the tooltip teaches a shortcut the service never bound.
   */
  private get isMacPlatform(): boolean {
    return navigator.platform.toLowerCase().includes('mac');
  }

  /**
   * The keyboard shortcut for each remote operation, formatted the way
   * keyboard.service.ts formats it, so the tooltip teaches the shortcut.
   */
  private remoteShortcut(op: RemoteOp): string {
    const key = REMOTE_SHORTCUT_KEYS[op];
    return this.isMacPlatform ? `⌘⇧${key}` : `Ctrl+Shift+${key}`;
  }

  /**
   * The same shortcut, in the modifier tokens `aria-keyshortcuts` defines.
   *
   * Platform-aware for the same reason the tooltip is: on macOS the combo the
   * tooltip shows is ⌘⇧, which is Meta+Shift — and keyboard.service really does
   * accept it, because getShortcutKey() hashes ctrl and meta to the same
   * "mod". A hard-coded Control+Shift+… announced a chord the visible tooltip
   * contradicted, which is the one thing a screen-reader user cannot check.
   */
  private remoteAriaShortcut(op: RemoteOp): string {
    return `${this.isMacPlatform ? 'Meta' : 'Control'}+Shift+${REMOTE_SHORTCUT_KEYS[op]}`;
  }

  /**
   * Label, tooltip, count badge and disabled state for one remote button.
   *
   * The ahead/behind numbers come from the SAME place the repository tabs
   * already read them (repo.currentBranch.aheadBehind — see renderTabBadges),
   * so the toolbar never asks the backend for them twice and the two can
   * never disagree.
   *
   * The in-flight flags read the SAME source the context dashboard's copies of
   * these buttons read (`runningRemoteOperation`, lv-context-dashboard.ts):
   * fetch, pull and push share ONE per-repository slot inside
   * remote-operations.service, because they are not independent — a pull moves
   * HEAD under a push, and a pruning fetch rewrites the refs a pull just
   * resolved. Reading that one slot is what keeps the two mouse surfaces from
   * disagreeing about what the app is doing, and stops a click landing on a
   * button the runner will only refuse.
   *
   * The two extra locks are the ones the runner also takes and other features
   * hold on their own: the working-tree lock a pull needs (any sidebar
   * checkout, reset or discard holds it too) and the per-repo push slot that
   * makes Push and Force Push mutually exclusive across the force-push
   * confirm.
   */
  private remoteButtonState(op: RemoteOp): {
    disabled: boolean;
    idle: boolean;
    count: number;
    label: string;
  } {
    const repo = this.activeRepo;
    const path = repo?.repository.path;
    const shortcut = this.remoteShortcut(op);
    const name = { fetch: 'Fetch', pull: 'Pull', push: 'Push' }[op];

    if (!repo) {
      return { disabled: true, idle: false, count: 0, label: `${name} — open a repository first` };
    }
    if ((repo.remotes ?? []).length === 0) {
      return {
        disabled: true,
        idle: false,
        count: 0,
        label: `${name} — this repository has no remote configured`,
      };
    }

    const running = runningRemoteOperation(path);
    const inFlight =
      running !== undefined ||
      (op === 'pull' && this.lock.busy) ||
      (op === 'push' && isPushRunning(path));
    if (inFlight) {
      // Name the operation that is actually holding the repository. All three
      // buttons go down together on the shared slot, so "Push already in
      // progress…" on the Push button during a fetch would be a lie; and the
      // working-tree and push slots can be held by a checkout or a force push,
      // which this surface cannot name at all.
      const reason =
        running === op
          ? `${name} already in progress…`
          : running !== undefined
            ? `${name} — a ${running} is already running in this repository`
            : `${name} — an operation is already running in this repository`;
      return { disabled: true, idle: false, count: 0, label: reason };
    }

    const ab = repo.currentBranch?.aheadBehind;
    const ahead = ab?.ahead ?? 0;
    const behind = ab?.behind ?? 0;
    const branch = repo.currentBranch?.shorthand ?? 'HEAD';

    if (op === 'fetch') {
      return { disabled: false, idle: false, count: 0, label: `Fetch from remote (${shortcut})` };
    }
    if (op === 'pull') {
      return {
        disabled: false,
        idle: behind === 0,
        count: behind,
        label:
          behind > 0
            ? `Pull ${behind} incoming commit${behind === 1 ? '' : 's'} into ${branch} (${shortcut})`
            : `Pull from remote — nothing to pull right now (${shortcut})`,
      };
    }
    // Push. A branch with no upstream has no ahead count and is never "up to
    // date": pushing it publishes it (the backend sets the upstream), so it
    // must not be dimmed as if there were nothing to do.
    const hasUpstream = Boolean(repo.currentBranch?.upstream);
    if (!hasUpstream) {
      return {
        disabled: false,
        idle: false,
        count: 0,
        label: `Push ${branch} to remote — it has no upstream yet (${shortcut})`,
      };
    }
    return {
      disabled: false,
      idle: ahead === 0,
      count: ahead,
      label:
        ahead > 0
          ? `Push ${ahead} local commit${ahead === 1 ? '' : 's'} from ${branch} (${shortcut})`
          : `Push to remote — nothing to push (${shortcut})`,
    };
  }

  /**
   * Run a remote operation through the path that already owns it.
   *
   * These three operations are implemented once, in
   * remote-operations.service, which app-shell's handleFetch/handlePull/
   * handlePush hand off to: it claims the shared locks, drives the progress
   * row, routes failures through the suggestion service and asks for the
   * refresh. The toolbar must not grow a second copy of any of that — it
   * dispatches, app-shell runs it.
   */
  private handleRemoteAction(op: RemoteOp): void {
    const repo = this.activeRepo;
    // The buttons carry ?disabled for both of these, so they are only
    // reachable in the race window between a render and the click — but a
    // silent return there would look like a dead button.
    if (!repo) {
      showToast('Please open a repository first', 'warning');
      return;
    }
    if ((repo.remotes ?? []).length === 0) {
      showToast('No remote configured for this repository — add one first.', 'warning');
      return;
    }
    this.dispatchEvent(
      new CustomEvent(`remote-${op}`, {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleToggleSearch(): void {
    this.showSearch = !this.showSearch;
    if (this.showSearch) {
      this.updateComplete.then(() => {
        this.searchBar?.focus();
      });
    }
  }

  private async checkSemanticAvailability(repoPath: string): Promise<void> {
    try {
      const status = await embeddingIndexService.getStatus(repoPath);
      this.semanticAvailable = status.isReady;
    } catch {
      this.semanticAvailable = false;
    }
  }

  private handleSearchChange(e: CustomEvent<SearchFilter>): void {
    this.dispatchEvent(new CustomEvent('search-change', {
      detail: { filter: e.detail },
      bubbles: true,
      composed: true,
    }));
  }

  private handleSearchClose(): void {
    this.showSearch = false;
    // Clear search
    this.dispatchEvent(new CustomEvent('search-change', {
      detail: { filter: { query: '', author: '', dateFrom: '', dateTo: '', filePath: '', branch: '', searchMode: 'keyword' as const } },
      bubbles: true,
      composed: true,
    }));
  }

  private detectProvider(repo: OpenRepository): 'github' | 'ado' | 'gitlab' | 'bitbucket' | null {
    // The store seeds `remotes` as [] and the backend returns a Vec, so it is
    // never missing in the app — but this runs inside render(), where a throw
    // rejects the whole toolbar update. Tolerate a missing collection.
    const remotes = repo.remotes ?? [];
    const originRemote = remotes.find(r => r.name === 'origin') ?? remotes[0];
    if (!originRemote?.url) return null;

    const url = originRemote.url.toLowerCase();
    if (url.includes('github.com') || url.includes('github.')) return 'github';
    if (url.includes('dev.azure.com') || url.includes('visualstudio.com')) return 'ado';
    if (url.includes('gitlab.com') || url.includes('gitlab.')) return 'gitlab';
    if (url.includes('bitbucket.org') || url.includes('bitbucket.')) return 'bitbucket';
    return null;
  }

  private renderProviderIcon(repo: OpenRepository) {
    const provider = this.detectProvider(repo);
    if (!provider) return null;

    switch (provider) {
      case 'github':
        return html`<svg class="provider-icon github" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
        </svg>`;
      case 'ado':
        return html`<svg class="provider-icon ado" viewBox="0 0 24 24" fill="currentColor">
          <path d="M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z"/>
        </svg>`;
      case 'gitlab':
        return html`<svg class="provider-icon gitlab" viewBox="0 0 24 24" fill="currentColor">
          <path d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 00-.867 0L16.418 9.45H7.582L4.918 1.263a.455.455 0 00-.867 0L1.386 9.452.044 13.587a.924.924 0 00.331 1.023L12 23.054l11.625-8.443a.92.92 0 00.33-1.024"/>
        </svg>`;
      case 'bitbucket':
        return html`<svg class="provider-icon bitbucket" viewBox="0 0 24 24" fill="currentColor">
          <path d="M.778 1.211a.768.768 0 00-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 00.77-.646l3.27-20.03a.768.768 0 00-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z"/>
        </svg>`;
    }
  }

  private handleOpenSettings(): void {
    this.dispatchEvent(new CustomEvent('open-settings', {
      bubbles: true,
      composed: true,
    }));
  }

  private handleOpenShortcuts(): void {
    this.dispatchEvent(new CustomEvent('open-shortcuts', {
      bubbles: true,
      composed: true,
    }));
  }

  private handleOpenCommandPalette(): void {
    this.dispatchEvent(new CustomEvent('open-command-palette', {
      bubbles: true,
      composed: true,
    }));
  }

  private handleOpenProfileManager(): void {
    this.dispatchEvent(new CustomEvent('open-profile-manager', {
      bubbles: true,
      composed: true,
    }));
  }

  private handleOpenWorkspaceManager(): void {
    this.dispatchEvent(new CustomEvent('open-workspace-manager', {
      bubbles: true,
      composed: true,
    }));
  }

  private updateScrollButtons(): void {
    if (!this.tabsContainer) return;
    const { scrollLeft, scrollWidth, clientWidth } = this.tabsContainer;
    this.canScrollLeft = scrollLeft > 0;
    this.canScrollRight = scrollLeft + clientWidth < scrollWidth - 1;
  }

  private handleScrollLeft(): void {
    if (!this.tabsContainer) return;
    this.tabsContainer.scrollBy({ left: -150, behavior: 'smooth' });
  }

  private handleScrollRight(): void {
    if (!this.tabsContainer) return;
    this.tabsContainer.scrollBy({ left: 150, behavior: 'smooth' });
  }

  private handleTabsScroll(): void {
    this.updateScrollButtons();
  }

  // Close the tab menus on Escape, matching the other context menus in the
  // app (e.g. lv-file-status). Registered only while a menu is open.
  private handleMenuEscape = (e: KeyboardEvent): void => {
    // Capture phase on `document` runs before every dialog's listener, and
    // this handler calls stopPropagation() — so without this check, closing
    // the tab menu swallowed an Escape aimed at whatever dialog was open on
    // top, and that dialog simply stopped responding to the key.
    if (!isTopOverlay(this)) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.tabListAnchor = null;
      this.tabContextMenu = null;
    }
  };

  private menuEscapeListenerAttached = false;

  private syncMenuEscapeListener(): void {
    const menuOpen = this.tabListAnchor !== null || this.tabContextMenu !== null;
    if (menuOpen && !this.menuEscapeListenerAttached) {
      document.addEventListener('keydown', this.handleMenuEscape, { capture: true });
      this.menuEscapeListenerAttached = true;
    } else if (!menuOpen && this.menuEscapeListenerAttached) {
      document.removeEventListener('keydown', this.handleMenuEscape, { capture: true });
      this.menuEscapeListenerAttached = false;
    }
  }

  protected updated(changedProperties: Map<string, unknown>): void {
    super.updated(changedProperties);
    this.syncMenuEscapeListener();
    if (changedProperties.has('openRepositories')) {
      this.updateComplete.then(() => this.updateScrollButtons());
    }
    // Keep the active tab visible when activated from anywhere (keyboard
    // shortcut, command palette, dropdown) — not just direct clicks.
    if (changedProperties.has('activeIndex') && this.activeIndex >= 0) {
      this.updateComplete.then(() => {
        this.tabsContainer
          ?.querySelector('.tab.active')
          ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    }
  }

  private renderTabBadges(repo: OpenRepository) {
    // Same tolerance as detectProvider: never missing in the app, but a
    // render function must not throw on a missing collection.
    const dirty = (repo.status ?? []).length > 0;
    const ab = repo.currentBranch?.aheadBehind;
    const showAheadBehind = ab && (ab.ahead > 0 || ab.behind > 0);
    return html`
      ${showAheadBehind
        ? html`<span
            class="tab-ahead-behind"
            title="${ab.ahead} ahead, ${ab.behind} behind upstream"
            >${ab.ahead > 0 ? `↑${ab.ahead}` : ''}${ab.behind > 0 ? `↓${ab.behind}` : ''}</span
          >`
        : nothing}
      ${dirty
        ? html`<span class="tab-dirty" title="Uncommitted changes" aria-label="Uncommitted changes"></span>`
        : nothing}
    `;
  }

  private renderRemoteButton(op: RemoteOp) {
    const { disabled, idle, count, label } = this.remoteButtonState(op);
    const icon = {
      fetch: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
        <path d="M3 3v5h5"></path>
        <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"></path>
        <path d="M16 16h5v5"></path>
      </svg>`,
      pull: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M12 3v18"></path>
        <path d="M5 16l7 7 7-7"></path>
      </svg>`,
      push: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M12 3v18"></path>
        <path d="M5 8l7-7 7 7"></path>
      </svg>`,
    }[op];
    return html`
      <button
        class="menu-btn remote-btn ${op} ${idle ? 'idle' : ''}"
        title="${label}"
        aria-label="${label}"
        aria-keyshortcuts=${this.remoteAriaShortcut(op)}
        ?disabled=${disabled}
        @click=${() => this.handleRemoteAction(op)}
      >
        ${icon}
        ${count > 0
          ? html`<span class="remote-count" aria-hidden="true">${count}</span>`
          : nothing}
      </button>
    `;
  }

  private renderRemoteActions() {
    return html`
      <div class="toolbar-section remote-actions" role="group" aria-label="Remote operations">
        ${this.renderRemoteButton('fetch')} ${this.renderRemoteButton('pull')}
        ${this.renderRemoteButton('push')}
      </div>
    `;
  }

  private renderTabListMenu() {
    if (!this.tabListAnchor) return nothing;
    return html`
      <div class="menu-backdrop" @click=${() => (this.tabListAnchor = null)}></div>
      <div
        class="tab-list-menu"
        role="menu"
        aria-label="Open repositories"
        style="top: ${this.tabListAnchor.y}px; left: ${this.tabListAnchor.x}px; transform: translateX(-100%);"
      >
        ${this.openRepositories.map(
          (repo, index) => html`
            <button
              class="tab-list-item"
              role="menuitem"
              @click=${() => this.handleTabListSelect(index)}
            >
              <span class="check">
                ${index === this.activeIndex
                  ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>`
                  : nothing}
              </span>
              <span class="item-texts">
                <span>${repo.repository.name}</span>
                <span class="item-path">${repo.repository.path}</span>
              </span>
            </button>
          `
        )}
      </div>
    `;
  }

  private renderTabContextMenu() {
    if (!this.tabContextMenu) return nothing;
    const { x, y, index } = this.tabContextMenu;
    const repo = this.openRepositories[index];
    if (!repo) return nothing;
    const isLast = index === this.openRepositories.length - 1;
    const isOnly = this.openRepositories.length === 1;
    return html`
      <div class="menu-backdrop" @click=${() => (this.tabContextMenu = null)}></div>
      <div
        class="tab-context-menu"
        role="menu"
        aria-label="Tab actions for ${repo.repository.name}"
        style="top: ${y}px; left: ${x}px;"
      >
        <button
          class="context-menu-item"
          role="menuitem"
          @click=${() => {
            this.tabContextMenu = null;
            repositoryStore.getState().removeRepository(repo.repository.path);
          }}
        >
          Close
        </button>
        <button
          class="context-menu-item"
          role="menuitem"
          ?disabled=${isOnly}
          @click=${() => this.handleCloseOtherTabs(index)}
        >
          Close Others
        </button>
        <button
          class="context-menu-item"
          role="menuitem"
          ?disabled=${isLast}
          @click=${() => this.handleCloseTabsToRight(index)}
        >
          Close Tabs to the Right
        </button>
        <button class="context-menu-item" role="menuitem" @click=${() => this.handleCloseAllTabs()}>
          Close All
        </button>
        <div class="context-menu-separator"></div>
        <button
          class="context-menu-item"
          role="menuitem"
          @click=${() => void this.handleOpenTabInTerminal(index)}
        >
          Open in Terminal
        </button>
        <button
          class="context-menu-item"
          role="menuitem"
          @click=${() => void this.handleRevealTabInFileManager(index)}
        >
          Reveal in File Manager
        </button>
        <button
          class="context-menu-item"
          role="menuitem"
          @click=${() => void this.handleOpenTabInEditor(index)}
        >
          Open in Editor
        </button>
        <div class="context-menu-separator"></div>
        <button class="context-menu-item" role="menuitem" @click=${() => this.handleCopyTabPath(index)}>
          Copy Path
        </button>
      </div>
    `;
  }

  protected firstUpdated(): void {
    this.updateScrollButtons();
    // Listen for resize to update scroll buttons
    this._resizeObserver = new ResizeObserver(() => this.updateScrollButtons());
    this._resizeObserver.observe(this);
  }

  render() {
    return html`
      <lv-clone-dialog></lv-clone-dialog>
      <lv-init-dialog></lv-init-dialog>

      <div class="toolbar-section menu-buttons">
        <button
          class="menu-btn"
          title="Open Repository"
          aria-label="Open Repository"
          @click=${this.handleOpenRepo}
          ?disabled=${this.isLoading}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
        </button>
        <button
          class="menu-btn"
          title="Clone Repository"
          aria-label="Clone Repository"
          @click=${this.handleCloneRepo}
          ?disabled=${this.isLoading}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
            <polyline points="10 9 13 12 10 15"></polyline>
          </svg>
        </button>
        <button
          class="menu-btn"
          title="Init Repository"
          aria-label="Init Repository"
          @click=${this.handleInitRepo}
          ?disabled=${this.isLoading}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
        <button
          class="menu-btn"
          title="Workspaces"
          aria-label="Workspaces"
          @click=${this.handleOpenWorkspaceManager}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7"></rect>
            <rect x="14" y="3" width="7" height="7"></rect>
            <rect x="3" y="14" width="7" height="7"></rect>
            <rect x="14" y="14" width="7" height="7"></rect>
          </svg>
        </button>
      </div>

      <div class="tabs-container toolbar-section">
        <button
          class="scroll-btn ${this.canScrollLeft ? 'visible' : ''}"
          @click=${this.handleScrollLeft}
          title="Scroll left"
          aria-label="Scroll tabs left"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>
        <div class="tabs" role="tablist" @scroll=${this.handleTabsScroll}>
          ${this.openRepositories.length === 0
            ? html`<span class="no-repos">No repositories open</span>`
            : this.openRepositories.map(
                (repo, index) => html`
                  <button
                    class="tab ${index === this.activeIndex ? 'active' : ''}"
                    role="tab"
                    aria-selected=${index === this.activeIndex}
                    aria-label="${repo.repository.name}"
                    title="${repo.repository.path}"
                    @click=${() => this.handleTabClick(index)}
                    @auxclick=${(e: MouseEvent) => this.handleTabAuxClick(e, repo.repository.path)}
                    @contextmenu=${(e: MouseEvent) => this.handleTabContextMenu(e, index)}
                  >
                    ${this.renderProviderIcon(repo)}
                    <span class="tab-name">${repo.repository.name}</span>
                    ${this.getTabHint(repo)
                      ? html`<span class="tab-hint">${this.getTabHint(repo)}</span>`
                      : nothing}
                    ${this.renderTabBadges(repo)}
                    <span
                      class="tab-close"
                      role="button"
                      tabindex="0"
                      aria-label="Close ${repo.repository.name} tab"
                      @click=${(e: Event) => this.handleTabClose(e, repo.repository.path)}
                      @keydown=${(e: KeyboardEvent) => this.handleTabCloseKeydown(e, repo.repository.path)}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                      </svg>
                    </span>
                  </button>
                `
              )}
        </div>
        <button
          class="scroll-btn ${this.canScrollRight ? 'visible' : ''}"
          @click=${this.handleScrollRight}
          title="Scroll right"
          aria-label="Scroll tabs right"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
        ${this.openRepositories.length > 0
          ? html`
              <button
                class="menu-btn tab-list-btn"
                title="All open repositories"
                aria-label="List all open repositories"
                aria-expanded=${this.tabListAnchor !== null}
                @click=${this.handleToggleTabList}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </button>
            `
          : nothing}
      </div>

      ${this.renderRemoteActions()}

      ${this.renderTabListMenu()} ${this.renderTabContextMenu()}

      <div class="toolbar-section">
        ${this.activeRepo ? html`
          <button
            class="menu-btn ${this.showSearch ? 'active' : ''}"
            title="Search commits (Ctrl+F)"
            aria-label="Search commits"
            @click=${this.handleToggleSearch}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="11" cy="11" r="8"></circle>
              <path d="M21 21l-4.35-4.35"></path>
            </svg>
          </button>
        ` : ''}
        <button
          class="menu-btn"
          title="Command Palette (Cmd+P)"
          aria-label="Command Palette"
          @click=${this.handleOpenCommandPalette}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="9" y1="9" x2="15" y2="9"></line>
            <line x1="9" y1="15" x2="15" y2="15"></line>
            <line x1="9" y1="12" x2="13" y2="12"></line>
          </svg>
        </button>
        <button
          class="menu-btn"
          title="Keyboard Shortcuts (?)"
          aria-label="Keyboard Shortcuts"
          @click=${this.handleOpenShortcuts}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <rect x="2" y="4" width="20" height="16" rx="2" ry="2"></rect>
            <path d="M6 8h.01"></path>
            <path d="M10 8h.01"></path>
            <path d="M14 8h.01"></path>
            <path d="M18 8h.01"></path>
            <path d="M8 12h.01"></path>
            <path d="M12 12h.01"></path>
            <path d="M16 12h.01"></path>
            <path d="M7 16h10"></path>
          </svg>
        </button>
        <button
          class="menu-btn"
          title="Settings"
          aria-label="Settings"
          @click=${this.handleOpenSettings}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        </button>
      </div>

      ${this.showSearch && this.activeRepo ? html`
        <lv-search-bar
          ?semanticAvailable=${this.semanticAvailable}
          @search-change=${this.handleSearchChange}
          @close=${this.handleSearchClose}
        ></lv-search-bar>
      ` : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-toolbar': LvToolbar;
  }
}
