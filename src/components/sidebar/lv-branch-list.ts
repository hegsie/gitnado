import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showConfirm, showPrompt } from '../../services/dialog.service.ts';
import { mergePreviewSummary } from '../../utils/merge-preview.ts';
import { showToast } from '../../services/notification.service.ts';
import { sweepRepoScopedDialogs } from '../../utils/repo-scoped-dialogs.ts';
import { showErrorWithSuggestion } from '../../services/error-suggestion.service.ts';
import { dragDropService, type DragItem } from '../../services/drag-drop.service.ts';
import { settingsStore } from '../../stores/settings.store.ts';
import {
  detectPullRequestProvider,
  invalidateProviderDetection,
  type PullRequestProviderTarget,
} from '../../services/pull-request.service.ts';
import { repositoryStore } from '../../stores/repository.store.ts';
import { fuzzyScore } from '../../utils/fuzzy-search.ts';
import '../dialogs/lv-branch-cleanup-dialog.ts';
import type { LvBranchCleanupDialog } from '../dialogs/lv-branch-cleanup-dialog.ts';
import type { Branch } from '../../types/git.types.ts';
import { isTopOverlay } from '../../utils/overlay-stack.ts';
import { rebasedOntoMessage } from '../../utils/rebase-messages.ts';
import {
  tryAcquireRefOpOrWarn,
  releaseRefOp,
  isRefOpRunning,
  subscribeRefOps,
} from '../../utils/ref-lock.ts';

type BranchSortMode = 'name' | 'date' | 'date-asc';

interface BranchSubgroup {
  prefix: string | null;
  displayName: string;
  branches: Branch[];
}

interface BranchGroup {
  name: string;
  branches: Branch[];
  subgroups?: BranchSubgroup[];
  expanded: boolean;
}

interface LocalBranchGroup {
  prefix: string | null; // null means no prefix (e.g., main, develop)
  displayName: string;
  branches: Branch[];
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  branch: Branch | null;
}

/**
 * Branch list component
 * Displays local and remote branches with checkout and management functionality
 */
@customElement('lv-branch-list')
export class LvBranchList extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .group {
        border-bottom: 1px solid var(--color-border);
      }

      .group:last-child {
        border-bottom: none;
      }

      /* Full-bleed row inside a scrolling list: draw the shared keyboard
         focus ring inside the row so the scroll container cannot clip it. */
      .group-header {
        --lv-focus-ring-offset: -2px;
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        cursor: pointer;
        user-select: none;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .group-header:hover {
        background: var(--color-bg-hover);
      }

      .chevron {
        width: 16px;
        height: 16px;
        transition: transform var(--transition-fast);
      }

      .chevron.expanded {
        transform: rotate(90deg);
      }

      .group-icon {
        width: 16px;
        height: 16px;
        color: var(--color-text-muted);
      }

      .group-name {
        flex: 1;
        font-weight: var(--font-weight-medium);
      }

      .group-count {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        background: var(--color-bg-tertiary);
        padding: 1px 6px;
        border-radius: var(--radius-full);
      }

      .branch-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .local-section {
        padding: 2px 0;
      }

      .branch-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 12px;
        cursor: pointer;
        font-size: var(--font-size-sm);
      }

      .branch-item.nested {
        padding-left: 32px;
      }

      .subgroup {
        margin-left: 0;
      }

      /* Full-bleed row inside a scrolling list: draw the shared keyboard
         focus ring inside the row so the scroll container cannot clip it. */
      .subgroup-header {
        --lv-focus-ring-offset: -2px;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 12px;
        cursor: pointer;
        user-select: none;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .subgroup-header:hover {
        background: var(--color-bg-hover);
      }

      .subgroup-name {
        flex: 1;
        font-weight: var(--font-weight-medium);
      }

      .subgroup .chevron {
        width: 14px;
        height: 14px;
      }

      .prefix-icon {
        width: 14px;
        height: 14px;
        color: var(--color-text-muted);
      }

      .branch-item:hover,
      .branch-item.context-target {
        background: var(--color-bg-hover);
      }

      .branch-item.active {
        background: var(--color-primary-bg);
        color: var(--color-primary);
      }

      .branch-item.active .branch-icon {
        color: var(--color-primary);
      }

      .branch-icon {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        color: var(--color-text-muted);
      }

      .branch-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .branch-info {
        flex: 1;
        min-width: 0;
        overflow: hidden;
      }

      .branch-info .branch-name {
        display: block;
        flex: initial;
      }

      .branch-upstream {
        display: block;
        font-size: 10px;
        line-height: 1.3;
        color: var(--color-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .ahead-behind {
        display: flex;
        gap: 4px;
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .ahead {
        color: var(--color-success);
      }

      .behind {
        color: var(--color-warning);
      }

      .stale-indicator {
        display: flex;
        align-items: center;
        color: var(--color-text-muted);
        opacity: 0.7;
      }

      .stale-indicator svg {
        width: 12px;
        height: 12px;
      }

      .branch-item.stale .branch-name {
        color: var(--color-text-muted);
      }

      .branch-item.stale .branch-icon {
        opacity: 0.6;
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-md);
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }

      .error {
        padding: var(--spacing-sm);
        color: var(--color-error);
        font-size: var(--font-size-sm);
      }

      .empty {
        padding: var(--spacing-sm);
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
        text-align: center;
      }

      /* Context menu */
      .context-menu {
        position: fixed;
        z-index: var(--z-dropdown, 100);
        min-width: 160px;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        padding: var(--spacing-xs) 0;
      }

      .context-menu-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        width: 100%;
        padding: var(--spacing-xs) var(--spacing-md);
        border: none;
        background: none;
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        text-align: left;
        cursor: pointer;
      }

      .context-menu-item:hover {
        background: var(--color-bg-hover);
      }

      .context-menu-item.danger {
        color: var(--color-error);
      }

      .context-menu-item svg {
        width: 14px;
        height: 14px;
        color: var(--color-text-muted);
      }

      .context-menu-item.danger svg {
        color: var(--color-error);
      }

      .context-menu-divider {
        height: 1px;
        background: var(--color-border);
        margin: var(--spacing-xs) 0;
      }

      /* Local section header */
      .local-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 2px 8px;
        border-bottom: 1px solid var(--color-border);
      }

      .local-header-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
      }

      .cleanup-btn {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        border: none;
        background: none;
        color: var(--color-text-muted);
        font-size: var(--font-size-xs);
        cursor: pointer;
        border-radius: var(--radius-sm);
        transition: all var(--transition-fast);
      }

      .cleanup-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .cleanup-btn svg {
        width: 12px;
        height: 12px;
      }

      .cleanup-btn .badge {
        background: var(--color-warning-bg);
        color: var(--color-warning);
        padding: 0 4px;
        border-radius: var(--radius-full);
        font-size: 10px;
        font-weight: var(--font-weight-medium);
      }

      /* Drag and drop styles */
      .branch-item[draggable="true"] {
        cursor: grab;
      }

      .branch-item.dragging {
        opacity: 0.5;
        cursor: grabbing;
      }

      .branch-item.drop-target {
        background: var(--color-primary-bg);
        outline: 2px dashed var(--color-primary);
        outline-offset: -2px;
      }

      .branch-item.drop-target-merge {
        outline-color: var(--color-success);
        background: var(--color-success-bg);
      }

      .branch-item.drop-target-rebase {
        outline-color: var(--color-warning);
        background: var(--color-warning-bg);
      }

      .drop-indicator {
        position: absolute;
        right: var(--spacing-sm);
        padding: 2px 6px;
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        border-radius: var(--radius-sm);
        pointer-events: none;
      }

      .drop-indicator.merge {
        background: var(--color-success-bg);
        color: var(--color-success);
      }

      .drop-indicator.rebase {
        background: var(--color-warning-bg);
        color: var(--color-warning);
      }

      /* Filter and sort controls */
      .controls {
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 2px 4px;
        border-bottom: 1px solid var(--color-border);
      }

      .controls-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        padding: 0;
      }

      .controls-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .controls-btn.active {
        color: var(--color-primary);
        background: var(--color-primary-bg);
      }

      .controls-btn svg {
        width: 14px;
        height: 14px;
      }

      .filter-bar {
        display: flex;
        align-items: center;
        padding: 4px 8px;
        border-bottom: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
      }

      .filter-input {
        flex: 1;
        border: none;
        background: transparent;
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        outline: none;
        padding: 2px 0;
      }

      .filter-input::placeholder {
        color: var(--color-text-muted);
      }

      .filter-clear {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-muted);
        cursor: pointer;
        padding: 0;
      }

      .filter-clear:hover {
        color: var(--color-text-primary);
        background: var(--color-bg-hover);
      }

      .filter-clear svg {
        width: 12px;
        height: 12px;
      }

      .sort-menu {
        position: absolute;
        z-index: var(--z-dropdown, 100);
        right: 4px;
        top: 28px;
        min-width: 140px;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        padding: var(--spacing-xs) 0;
      }

      .sort-option {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        width: 100%;
        padding: var(--spacing-xs) var(--spacing-md);
        border: none;
        background: none;
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        text-align: left;
        cursor: pointer;
      }

      .sort-option:hover {
        background: var(--color-bg-hover);
      }

      .sort-option.active {
        color: var(--color-primary);
      }

      .sort-option svg {
        width: 14px;
        height: 14px;
        color: var(--color-text-muted);
      }

      .sort-option.active svg {
        color: var(--color-primary);
      }

      .branch-item.hidden-branch {
        opacity: 0.4;
      }
    `,
  ];

  @property({ type: String }) repositoryPath: string = '';

  @state() private localBranchGroups: LocalBranchGroup[] = [];
  @state() private remoteGroups: BranchGroup[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private expandedGroups = new Set<string>(['local', 'local-ungrouped']);
  /**
   * Groups the user deliberately collapsed, keyed by repository.
   *
   * loadBranches auto-expands every group it finds, and it runs after every
   * mutation and every refresh event — so without a record of intent, a
   * collapsed group re-opened on the user's very next action.
   *
   * Keyed per repo because this component is REUSED across tabs (the panel
   * rebinds `repositoryPath` rather than remounting): a bare group id let
   * collapsing `local-feature` in one repository hold the same-named group shut
   * in every other one.
   */
  private collapsedGroups = new Set<string>();

  /** Collapse intent is per repository, so the group id alone is not the key. */
  private collapseKey(groupId: string): string {
    // NUL cannot occur in a path or a ref name, so the two parts cannot run
    // together into another repository's key.
    return `${this.repositoryPath}\u0000${groupId}`;
  }

  @state() private contextMenu: ContextMenuState = { visible: false, x: 0, y: 0, branch: null };
  @state() private draggingBranch: Branch | null = null;
  @state() private dropTargetBranch: Branch | null = null;
  @state() private dropAction: 'merge' | 'rebase' | null = null;
  @state() private filterText = '';
  @state() private sortMode: BranchSortMode = 'name';
  @state() private showFilter = false;
  @state() private hiddenBranches = new Set<string>();
  @state() private showSortMenu = false;
  /**
   * The working-tree lock, shared with app-shell and the other sidebar lists.
   *
   * This was a component-local boolean, so a hard reset started from the graph
   * and a checkout started here ran concurrently against the same working
   * tree. See utils/ref-lock.ts.
   */
  @state() private refOpsVersion = 0;
  private unsubscribeRefOps?: () => void;

  private get operationInProgress(): boolean {
    void this.refOpsVersion;
    return isRefOpRunning(this.repositoryPath);
  }

  /**
   * Claim the lock for `repoPath`; false when it is already held.
   *
   * The path is passed explicitly rather than read from `this.repositoryPath`
   * at release time: the prop rebinds when the user switches repo tabs
   * mid-operation, so a release that re-read it would free the WRONG repo's
   * lock and wedge the one that is actually running.
   */
  private claimOperation(repoPath: string): boolean {
    // Reports the refusal: these components hold the same lock app-shell does,
    // and a gesture with no disabled binding — the double-clicked branch row —
    // otherwise looked like a hung app for the whole other operation.
    return tryAcquireRefOpOrWarn(repoPath);
  }

  private releaseOperation(repoPath: string): void {
    releaseRefOp(repoPath);
  }

  /**
   * Every branch the cleanup dialog would list, by name and across ALL
   * categories. The button used merged+stale computed locally, which
   * double-counted a branch that is both and hid the button entirely for a
   * repo whose only candidates are gone-upstream — while the command-palette
   * entry still opened the dialog, so the two surfaces disagreed.
   */
  @state() private cleanupCandidateNames = new Set<string>();
  /**
   * The candidate fetch failed for the current repo. Distinct from "no
   * candidates": an empty set renders as "nothing to clean up", which is a
   * lie when we simply could not find out. Keeps the button reachable and
   * says so, instead of the feature silently vanishing from the sidebar.
   */
  @state() private cleanupCheckFailed = false;

  /**
   * The hosting provider backing this repository, once resolved, and null when
   * resolution finished and found none. `providerResolved` is what tells those
   * two apart -- "not detected" and "not looked yet" must not both disable the
   * create-request entry with the same explanation.
   *
   * Resolved eagerly (per repository, through the cache in
   * pull-request.service that the sidebar's Pull Requests section shares) and
   * NOT on menu open: the `detect_*_repo` commands only read this repository's
   * own remote configuration, so they cost no network call, and an entry that
   * flips from disabled to enabled under the user's cursor is worse than one
   * that is simply right when the menu appears.
   */
  @state() private prProvider: PullRequestProviderTarget | null = null;
  @state() private prProviderResolved = false;

  @query('lv-branch-cleanup-dialog') private branchCleanupDialog!: LvBranchCleanupDialog;

  private static readonly HIDDEN_BRANCHES_STORAGE_PREFIX = 'lv-hidden-branches:';

  private storeUnsubscribe?: () => void;

  async connectedCallback(): Promise<void> {
    super.connectedCallback();
    // isRefOpRunning is plain module state Lit cannot observe, so without this
    // the ?disabled bindings never re-render on a lock transition: a context
    // menu opened before an operation started stayed fully enabled through it,
    // and one opened during an operation stayed disabled after it finished —
    // a dead control with no explanation until the menu is reopened.
    this.unsubscribeRefOps = subscribeRefOps(() => {
      this.refOpsVersion++;
    });
    this.loadHiddenBranches();
    // Registered BEFORE the load, not after. loadBranches() awaits three IPC
    // round-trips, and every event dispatched in that window was dropped on
    // the floor: the command palette's "Clean up branches" silently did
    // nothing, and a repository-refresh raised during initial load was lost.
    // None of these handlers depend on branch data being present.
    document.addEventListener('click', this.handleDocumentClick);
    document.addEventListener('keydown', this.handleKeydown);
    window.addEventListener('open-branch-cleanup', this.handleExternalCleanupOpen);
    window.addEventListener('repository-refresh', this.handleRepositoryRefresh);
    // Close the branch-cleanup dialog when its pinned repo's tab is closed: its
    // Delete force-deletes branches + prunes remotes on the PINNED repo, so a
    // dialog left floating over another tab would run against a repository
    // that is no longer in the tab bar.
    //
    // Routed through the same shared sweep app-shell uses — `close()` here is a
    // bare `isOpen = false` that bypasses `handleModalClose()`'s `deleting`
    // guard, so the hand-written arm this replaces reported "branch cleanup
    // cancelled" while the force-delete loop went right on deleting.
    //
    // Registered BEFORE the load, for the same reason as the listeners above:
    // loadBranches() awaits three IPC round trips, and closing the last tab
    // inside that window ran disconnectedCallback() while `storeUnsubscribe`
    // was still undefined — the subscription was then registered on a detached
    // element and leaked, once per open/close cycle.
    this.storeUnsubscribe = repositoryStore.subscribe((state) => {
      sweepRepoScopedDialogs({
        root: this.renderRoot,
        isRepoOpen: (path) =>
          state.openRepositories.some((r) => r.repository.path === path),
        hostHasRepositories: state.openRepositories.length > 0,
        entries: {
          'lv-branch-cleanup-dialog': {
            dismissed: 'branch cleanup cancelled',
            running: 'branch cleanup',
          },
        },
      });
    });
    await this.loadBranches();
    void this.detectProvider();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeRefOps?.();
    this.unsubscribeRefOps = undefined;
    document.removeEventListener('click', this.handleDocumentClick);
    document.removeEventListener('keydown', this.handleKeydown);
    window.removeEventListener('open-branch-cleanup', this.handleExternalCleanupOpen);
    window.removeEventListener('repository-refresh', this.handleRepositoryRefresh);
    this.storeUnsubscribe?.();
    this.storeUnsubscribe = undefined;
  }

  private handleRepositoryRefresh = (): void => {
    this.loadBranches();
    // Adding or re-pointing a remote changes the answer, and a stale "no
    // provider" would silently keep the create-request entry disabled.
    void this.detectProvider(true);
  };

  private handleExternalCleanupOpen = (): void => {
    this.handleOpenCleanupDialog();
  };

  private handleDocumentClick = (): void => {
    if (this.contextMenu.visible) {
      this.contextMenu = { ...this.contextMenu, visible: false };
    }
  };

  private handleKeydown = (e: KeyboardEvent): void => {
    // A context menu must not eat an Escape aimed at a dialog opened over
    // it: every global keydown listener fires on the same keypress.
    if (!isTopOverlay(this)) return;
    if (e.key === 'Escape' && this.contextMenu.visible) {
      this.contextMenu = { ...this.contextMenu, visible: false };
    }
  };

  private handleContextMenuKeydown(e: KeyboardEvent): void {
    const menu = this.renderRoot.querySelector('.context-menu') as HTMLElement;
    if (!menu) return;

    const items = Array.from(menu.querySelectorAll('.context-menu-item:not([disabled])')) as HTMLElement[];
    const currentIndex = items.indexOf(e.target as HTMLElement);

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const next = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
        items[next]?.focus();
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const prev = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
        items[prev]?.focus();
        break;
      }
      case 'Escape':
        e.preventDefault();
        this.contextMenu = { ...this.contextMenu, visible: false };
        break;
    }
  }

  async updated(changedProperties: Map<string, unknown>): Promise<void> {
    if (changedProperties.has('repositoryPath') && this.repositoryPath) {
      // A menu entry acts on the branch it was opened over, but resolves the
      // repo from `this.repositoryPath` at click time — and a keyboard tab
      // switch produces neither a document click nor Escape, so the menu would
      // survive the rebind and delete repo A's branch inside repo B.
      this.contextMenu = { ...this.contextMenu, visible: false };
      this.loadHiddenBranches();
      // Clear before the await: the previous repository's provider must never
      // label -- or enable -- a menu opened over this one's branches.
      this.prProvider = null;
      this.prProviderResolved = false;
      await this.loadBranches();
      await this.detectProvider();
    }
  }

  /**
   * Resolve the hosting provider for the bound repository.
   *
   * `force` re-detects instead of reading the shared cache, for the case where
   * the repository's remotes may have just changed.
   */
  private async detectProvider(force = false): Promise<void> {
    const loadedPath = this.repositoryPath;
    if (!loadedPath) {
      this.prProvider = null;
      this.prProviderResolved = false;
      return;
    }
    if (force) invalidateProviderDetection(loadedPath);
    let target: PullRequestProviderTarget | null = null;
    try {
      target = await detectPullRequestProvider(loadedPath, { force });
    } catch {
      // Detection is best-effort: a failure leaves the entry disabled with the
      // "no provider" explanation rather than breaking the menu. Nothing the
      // user asked for has failed here, so there is nothing to report.
      target = null;
    }
    // A tab switch while detection was in flight: the result belongs to the
    // repository it was requested for, not whichever one is bound now.
    if (this.repositoryPath !== loadedPath) return;
    this.prProvider = target;
    this.prProviderResolved = true;
  }

  /**
   * Label for the create-request entry. GitLab calls them merge requests, and
   * saying "pull request" there would name a thing GitLab does not have.
   */
  private get createRequestLabel(): string {
    return this.prProvider?.provider === 'gitlab'
      ? 'Create merge request...'
      : 'Create pull request...';
  }

  /**
   * Why the create-request entry is disabled, or null when it is enabled.
   *
   * An upstream is required because every provider opens the request from a
   * branch that already exists on the remote -- without one there is nothing
   * on the server to open it from.
   */
  private createRequestBlockedReason(branch: Branch): string | null {
    if (!this.prProviderResolved) return 'Checking for a hosting provider...';
    if (!this.prProvider) {
      return 'No GitHub, GitLab, Bitbucket or Azure DevOps remote was detected for this repository';
    }
    if (!branch.upstream) {
      return `Push ${branch.shorthand} and set its upstream first`;
    }
    return null;
  }

  /**
   * A base branch to prefill the provider's create form with: the first
   * conventional trunk that exists locally, and nothing when none does.
   *
   * A SUGGESTION only -- the dialog applies it just to an empty field, and the
   * user can change it there. Derived from the branches already loaded, so it
   * costs no extra call; the repository's real default branch is only known to
   * the remote.
   */
  private suggestBaseBranch(sourceBranch: string): string | undefined {
    const localNames = new Set(
      this.localBranchGroups.flatMap((group) => group.branches.map((b) => b.shorthand)),
    );
    return ['main', 'master', 'develop', 'trunk'].find(
      (name) => name !== sourceBranch && localNames.has(name),
    );
  }

  /**
   * Hand the branch off to the provider dialog's existing create form.
   *
   * Dispatched rather than handled here on purpose: the four provider dialogs
   * already own the create flow (form, account selection, API call, feedback),
   * and app-shell hosts them. Listener: `@create-pull-request` on app-shell's
   * left-panel aside.
   */
  private handleCreatePullRequest(): void {
    const branch = this.contextMenu.branch;
    const provider = this.prProvider;
    // Re-checked at click time, not just in the disabled binding: the provider
    // is resolved asynchronously and the menu can outlive a repository switch.
    if (!branch || branch.isRemote || !branch.upstream || !provider) return;

    this.contextMenu = { ...this.contextMenu, visible: false };
    this.dispatchEvent(
      new CustomEvent('create-pull-request', {
        bubbles: true,
        composed: true,
        detail: {
          provider: provider.provider,
          sourceBranch: branch.shorthand,
          baseBranch: this.suggestBaseBranch(branch.shorthand),
        },
      }),
    );
  }

  private get hiddenBranchesStorageKey(): string {
    return `${LvBranchList.HIDDEN_BRANCHES_STORAGE_PREFIX}${this.repositoryPath}`;
  }

  private loadHiddenBranches(): void {
    if (!this.repositoryPath) return;
    try {
      const stored = localStorage.getItem(this.hiddenBranchesStorageKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        this.hiddenBranches = new Set(Array.isArray(parsed) ? parsed : []);
      } else {
        this.hiddenBranches = new Set();
      }
    } catch {
      // localStorage unavailable or corrupt - start with an empty set
      this.hiddenBranches = new Set();
    }
  }

  private saveHiddenBranches(): void {
    if (!this.repositoryPath) return;
    try {
      localStorage.setItem(
        this.hiddenBranchesStorageKey,
        JSON.stringify(Array.from(this.hiddenBranches)),
      );
    } catch {
      // localStorage quota exceeded or unavailable - silently ignore
    }
  }

  public async refresh(): Promise<void> {
    await this.loadBranches();
  }

  // Monotonic sequence per repo path: a load only applies its result if no
  // NEWER load for the same path started meanwhile (path equality alone
  // can't catch A -> B -> A switches reordering two loads for A)
  private branchesLoadSeq = new Map<string, number>();

  private async loadBranches(): Promise<void> {
    if (!this.repositoryPath) return;
    // Captured before the await so a mid-flight tab switch still writes the
    // result to the repo it was loaded FROM
    const loadedPath = this.repositoryPath;
    const seq = (this.branchesLoadSeq.get(loadedPath) ?? 0) + 1;
    this.branchesLoadSeq.set(loadedPath, seq);

    this.loading = true;
    this.error = null;

    try {
      const [branchesResult, remotesResult, cleanupResult] = await Promise.all([
        gitService.getBranches(loadedPath),
        gitService.getRemotes(loadedPath),
        // The staleDays argument is what makes the badge and the cleanup
        // dialog agree. Omitting it fell back to the backend's 90-day default,
        // so the badge counted stale branches the dialog's Stale tab did not
        // list (and kept counting them when the user set the window to 0 to
        // disable staleness entirely).
        gitService.getCleanupCandidates(
          loadedPath,
          settingsStore.getState().staleBranchDays,
        ),
      ]);

      // A newer load for the SAME path supersedes this one entirely (its
      // result is fresher for both the store and the panel).
      const isLatestForPath = this.branchesLoadSeq.get(loadedPath) === seq;
      if (!isLatestForPath) return;
      // The tab may have switched while the fetch was in flight. The store
      // write below is path-keyed and always safe; the component's OWN
      // render state belongs to the now-active repo and must not be
      // overwritten with a stale result (showing repo A's branches under
      // repo B's tab would run checkout/delete against the wrong names).
      const isCurrent = this.repositoryPath === loadedPath;

      if (!branchesResult.success) {
        if (isCurrent) {
          this.error = branchesResult.error?.message ?? 'Failed to load branches';
        }
        return;
      }

      const branches = branchesResult.data!;

      // Mirror branches into the repository store so path-keyed consumers
      // (e.g. the tab bar's ahead/behind badge) stay in sync
      repositoryStore.getState().updateRepoData(loadedPath, {
        branches,
        currentBranch: branches.find((b) => b.isHead) ?? null,
        // The remotes this load already asked for, mirrored instead of
        // discarded: the same store field decides whether Fetch/Pull/Push are
        // available, and a failed read is left out rather than written as an
        // empty list, so "could not read" never becomes "has no remote".
        ...(remotesResult.success && remotesResult.data ? { remotes: remotesResult.data } : {}),
      });

      if (!isCurrent) return;

      // Separate local and remote branches
      const localBranches = branches.filter((b) => !b.isRemote);

      // Group local branches by prefix (feature/, fix/, hotfix/, etc.)
      const localGroupMap = new Map<string | null, Branch[]>();

      for (const branch of localBranches) {
        const slashIndex = branch.name.indexOf('/');
        const prefix = slashIndex > 0 ? branch.name.substring(0, slashIndex) : null;

        if (!localGroupMap.has(prefix)) {
          localGroupMap.set(prefix, []);
        }
        localGroupMap.get(prefix)!.push(branch);
      }

      // Sort groups: ungrouped first, then alphabetically by prefix
      const sortedPrefixes = Array.from(localGroupMap.keys()).sort((a, b) => {
        if (a === null) return -1;
        if (b === null) return 1;
        return a.localeCompare(b);
      });

      this.localBranchGroups = sortedPrefixes.map((prefix) => ({
        prefix,
        displayName: prefix ?? 'Branches',
        branches: localGroupMap.get(prefix)!.sort((a, b) => {
          // Sort HEAD branch first, then alphabetically
          if (a.isHead) return -1;
          if (b.isHead) return 1;
          return a.name.localeCompare(b.name);
        }),
      }));

      // Auto-expand prefix groups that have branches
      const newExpandedGroups = new Set(this.expandedGroups);
      // The always-present groups are re-derived too, so their state follows
      // the repository being shown rather than the last one.
      this.autoExpandGroup(newExpandedGroups, 'local');
      this.autoExpandGroup(newExpandedGroups, 'local-ungrouped');
      for (const prefix of sortedPrefixes) {
        if (prefix !== null) {
          this.autoExpandGroup(newExpandedGroups, `local-${prefix}`);
        }
      }
      this.expandedGroups = newExpandedGroups;

      // Group remote branches by remote name, then by prefix
      const remoteBranches = branches.filter((b) => b.isRemote);
      const remoteMap = new Map<string, Branch[]>();

      for (const branch of remoteBranches) {
        // Extract remote name from origin/main -> origin
        // or refs/remotes/origin/main -> origin
        const parts = branch.name.split('/');
        // If it starts with refs/remotes/, the remote is at index 2, otherwise index 0
        const remoteName = parts[0] === 'refs' ? parts[2] : parts[0];

        if (!remoteMap.has(remoteName)) {
          remoteMap.set(remoteName, []);
        }
        remoteMap.get(remoteName)!.push(branch);
      }

      // For each remote, group branches by prefix
      this.remoteGroups = Array.from(remoteMap.entries()).map(([name, branches]) => {
        // Group branches by prefix within this remote
        const prefixMap = new Map<string | null, Branch[]>();

        for (const branch of branches) {
          // shorthand is already stripped of remote name (e.g., "feature/my-fix" not "origin/feature/my-fix")
          const slashIndex = branch.shorthand.indexOf('/');
          const prefix = slashIndex > 0 ? branch.shorthand.substring(0, slashIndex) : null;

          if (!prefixMap.has(prefix)) {
            prefixMap.set(prefix, []);
          }
          prefixMap.get(prefix)!.push(branch);
        }

        // Sort prefixes: ungrouped first, then alphabetically
        const sortedPrefixes = Array.from(prefixMap.keys()).sort((a, b) => {
          if (a === null) return -1;
          if (b === null) return 1;
          return a.localeCompare(b);
        });

        // Create subgroups
        const subgroups = sortedPrefixes.map((prefix) => ({
          prefix,
          displayName: prefix ?? 'branches',
          branches: prefixMap.get(prefix)!.sort((a, b) => a.shorthand.localeCompare(b.shorthand)),
        }));

        // Auto-expand remote groups and prefix subgroups the user has not
        // deliberately collapsed.
        this.autoExpandGroup(this.expandedGroups, `remote-${name}`);
        for (const prefix of sortedPrefixes) {
          if (prefix !== null) {
            this.autoExpandGroup(this.expandedGroups, `remote-${name}-${prefix}`);
          }
        }

        return {
          name,
          branches,
          subgroups,
          expanded: true,
        };
      });

      // The badge and the cleanup dialog share one source of truth: the
      // backend's candidate list. Fetched in the Promise.all above to keep
      // loadBranches to a single await point (extra await points perturb
      // render timing for callers).
      this.cleanupCheckFailed = !cleanupResult.success;
      this.cleanupCandidateNames = cleanupResult.success && cleanupResult.data
        ? new Set(cleanupResult.data.map(c => c.name))
        : new Set();

    } catch (err) {
      if (this.repositoryPath === loadedPath) {
        this.error = err instanceof Error ? err.message : 'Unknown error';
      }
    } finally {
      // A stale load must not stomp the loading state of the load that the
      // now-active repo owns
      if (this.repositoryPath === loadedPath) {
        this.loading = false;
      }
    }
  }

  private toggleGroup(groupId: string): void {
    if (this.expandedGroups.has(groupId)) {
      this.expandedGroups.delete(groupId);
      // Remembered so the next load does not auto-expand it again. loadBranches
      // runs after every checkout, delete, rename, merge and rebase, and on
      // every repository-refresh event, so without this a collapsed group
      // snapped back open the moment the user did anything.
      this.collapsedGroups.add(this.collapseKey(groupId));
    } else {
      this.expandedGroups.add(groupId);
      this.collapsedGroups.delete(this.collapseKey(groupId));
    }
    this.requestUpdate();
  }

  /**
   * Expand a group only if the user has never collapsed it.
   *
   * New groups still open by default; a group the user deliberately closed
   * stays closed across refreshes.
   */
  private autoExpandGroup(groups: Set<string>, groupId: string): void {
    if (this.collapsedGroups.has(this.collapseKey(groupId))) {
      // Collapsed HERE — and expandedGroups may still hold this id from the
      // repository the user was looking at a moment ago, since the panel
      // rebinds this component rather than remounting it.
      groups.delete(groupId);
    } else {
      groups.add(groupId);
    }
  }

  private handleCreateBranch(): void {
    this.requestCreateBranch();
  }

  /** Ask app-shell to open THE create-branch dialog. This list used to mount a
   * second instance of its own: with two copies alive, each `open()`'s "already
   * open, don't wipe the input" guard only knew about itself, so opening from
   * here and then from the palette stacked two dialogs with different pinned
   * start points over each other. */
  private requestCreateBranch(startPoint?: string): void {
    this.dispatchEvent(new CustomEvent('create-branch', {
      bubbles: true,
      composed: true,
      detail: { startPoint },
    }));
  }

  private handleFilterInput(e: InputEvent): void {
    this.filterText = (e.target as HTMLInputElement).value;
  }

  private clearFilter(): void {
    this.filterText = '';
  }

  private toggleFilter(): void {
    this.showFilter = !this.showFilter;
    if (!this.showFilter) {
      this.filterText = '';
    }
  }

  private toggleSortMenu(): void {
    this.showSortMenu = !this.showSortMenu;
  }

  private setSortMode(mode: BranchSortMode): void {
    this.sortMode = mode;
    this.showSortMenu = false;
    // Re-sort branches
    this.loadBranches();
  }

  private toggleHideBranch(branchName: string): void {
    if (this.hiddenBranches.has(branchName)) {
      this.hiddenBranches.delete(branchName);
    } else {
      this.hiddenBranches.add(branchName);
    }
    this.saveHiddenBranches();
    this.requestUpdate();
  }

  private filterBranches(branches: Branch[]): Branch[] {
    let filtered = branches;

    // Apply text filter with fuzzy matching
    if (this.filterText) {
      const query = this.filterText.toLowerCase();
      filtered = filtered
        .map((b) => ({
          branch: b,
          score: Math.max(fuzzyScore(b.name, query), fuzzyScore(b.shorthand, query)),
        }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .map(({ branch }) => branch);
    }

    // Apply hide filter (still show but dimmed)
    return filtered;
  }

  private sortBranches(branches: Branch[]): Branch[] {
    return [...branches].sort((a, b) => {
      // HEAD always first
      if (a.isHead) return -1;
      if (b.isHead) return 1;

      switch (this.sortMode) {
        case 'date':
          // Newest first
          return (b.lastCommitTimestamp ?? 0) - (a.lastCommitTimestamp ?? 0);
        case 'date-asc':
          // Oldest first
          return (a.lastCommitTimestamp ?? 0) - (b.lastCommitTimestamp ?? 0);
        case 'name':
        default:
          return a.name.localeCompare(b.name);
      }
    });
  }

  /**
   * Find all local branches that are merged into HEAD.
   *
   * Uses the backend's real merge detection (graph_descendant_of against HEAD,
   * including tip==HEAD equality) — the same data the cleanup dialog uses —
   * instead of an ahead-of-UPSTREAM==0 heuristic. That heuristic diverged from
   * `git branch --merged` in both directions: it wrongly flagged fully-pushed
   * unmerged branches (ahead-of-upstream 0 right after a push) as merged, and it
   * missed merged branches that have no upstream at all (aheadBehind undefined).
   */
  /**
   * Distinct local branches the cleanup dialog would list.
   *
   * Counted by NAME: merged and stale are independent filters over the same
   * list, so a branch that is both was counted twice by the badge.
   */
  private getCleanupCandidateCount(): number {
    return this.cleanupCandidateNames.size;
  }


  /**
   * Open the branch cleanup dialog
   */
  private handleOpenCleanupDialog(): void {
    this.branchCleanupDialog.open();
  }

  /**
   * Handle cleanup completion by refreshing branches
   */
  private async handleCleanupComplete(e?: CustomEvent<{ repositoryPath?: string }>): Promise<void> {
    // The cleanup dialog pins to the repo it ran on and reports it here. The
    // user may have switched tabs while it was open (rebinding our live
    // repositoryPath), so trust the event's repo and only reload OUR view when
    // it matches.
    const repoPath = e?.detail?.repositoryPath ?? this.repositoryPath;
    if (repoPath === this.repositoryPath) {
      await this.loadBranches();
    }
    this.dispatchBranchesChanged(repoPath);
  }

  private handleBranchClick(branch: Branch): void {
    // Navigate to the branch's commit in the graph
    this.dispatchEvent(new CustomEvent('branch-selected', {
      detail: { branch },
      bubbles: true,
      composed: true,
    }));
  }

  private async handleCheckout(branch: Branch): Promise<void> {
    if (branch.isHead) return;
    const lockedRepo = this.repositoryPath;
    if (!this.claimOperation(lockedRepo)) return;

    // Close context menu immediately
    this.contextMenu = { ...this.contextMenu, visible: false };

    // Captured BEFORE the await: conflict events must carry the repo the
    // operation actually ran on, even if the prop is rebound mid-flight.
    const repoPath = this.repositoryPath;
    try {
      // Use branch.name for both local and remote branches
      // - For local branches: branch.name is the branch name (e.g., "main", "feature/my-branch")
      // - For remote branches: branch.name is the full remote reference (e.g., "origin/feature/my-branch")
      const result = await gitService.checkoutWithAutoStash(repoPath, branch.name);

      if (result.success && result.data?.success) {
        const data = result.data;
        if (data.stashed && data.stashConflict) {
          showToast(`Switched to ${branch.shorthand} — stash conflicts need resolution`, 'warning');
          this.dispatchEvent(new CustomEvent('open-conflict-dialog', {
            bubbles: true,
            composed: true,
            // Auto-stash is pop semantics: drop it once resolved. Identified by
            // oid, not position — another surface or a terminal can push a stash
            // in between and renumber the list.
            detail: {
              operationType: 'stash',
              stashOid: data.stashOid ?? null,
              stashIndex: 0,
              dropStashOnComplete: true,
              repositoryPath: repoPath,
            },
          }));
        } else if (data.stashed && data.stashApplied) {
          showToast(data.message, data.message.includes('staged status was not preserved') ? 'warning' : 'info');
        } else if (data.stashed && !data.stashApplied) {
          showToast(data.message, 'warning');
        }
        await this.loadBranches();
        this.dispatchEvent(new CustomEvent('branch-checkout', {
          detail: { branch, repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));
      } else {
        console.error('Checkout failed:', result.data?.message || result.error);
        // Through the suggestion service, like the graph and palette paths:
        // libgit2's "1 conflict prevents checkout" names neither the files nor
        // a way forward, and this is the surface most checkouts come from.
        showErrorWithSuggestion(
          result.data?.message || result.error?.message || '',
          'Checkout failed',
        );
      }
    } finally {
      this.releaseOperation(lockedRepo);
    }
  }

  private handleContextMenu(e: MouseEvent, branch: Branch): void {
    e.preventDefault();
    e.stopPropagation();

    this.contextMenu = {
      visible: true,
      x: e.clientX,
      y: e.clientY,
      branch,
    };
  }

  private async handleRenameBranch(): Promise<void> {
    const branch = this.contextMenu.branch;
    // Cannot rename HEAD branch or remote branches. Checked before the claim,
    // so a refused gesture never takes the lock.
    if (!branch || branch.isHead || branch.isRemote) return;
    // Claimed BEFORE the prompt: showPrompt is an await, and a claim taken
    // after it does not serialize two dispatches that both passed the check.
    const lockedRepo = this.repositoryPath;
    if (!this.claimOperation(lockedRepo)) return;
    // Captured BEFORE the in-app prompt await (a Lit overlay, NOT a native
    // modal — the window stays interactive, so the user can switch tabs while
    // it is open). The rename must run against the repo it was invoked on, not
    // whichever tab is active when the prompt resolves.
    const repoPath = this.repositoryPath;

    this.contextMenu = { ...this.contextMenu, visible: false };

    const newName = await showPrompt('Rename Branch', `Rename branch "${branch.name}" to:`, branch.name);
    if (!newName || newName === branch.name) {
      this.releaseOperation(lockedRepo);
      return;
    }


    try {
      const result = await gitService.renameBranch(repoPath, {
        oldName: branch.name,
        newName: newName.trim(),
      });

      if (result.success) {
        // Every other mutating handler in this file toasts. Rename did not, and
        // the list is often filtered or scrolled, so the renamed row may not
        // even be on screen — success was the only outcome that said nothing.
        showToast(`Renamed ${branch.shorthand} to ${newName.trim()}`, 'success');
        await this.loadBranches();
        this.dispatchBranchesChanged(repoPath);
      } else {
        console.error('Rename branch failed:', result.error);
        showToast(`Failed to rename branch: ${result.error?.message ?? 'Unknown error'}`, 'error');
      }
    } finally {
      this.releaseOperation(lockedRepo);
    }
  }

  private async handleDeleteBranch(): Promise<void> {
    const branch = this.contextMenu.branch;
    // Cannot delete the HEAD branch. Checked before the claim, so a refused
    // gesture never takes the lock.
    if (!branch || branch.isHead) return;
    // Claimed BEFORE the confirm — see handleRenameBranch.
    const lockedRepo = this.repositoryPath;
    if (!this.claimOperation(lockedRepo)) return;
    const repoPath = this.repositoryPath;

    this.contextMenu = { ...this.contextMenu, visible: false };

    const confirmed = await showConfirm(
      'Delete Branch',
      `Are you sure you want to delete the branch "${branch.shorthand}"?\n\nThis action cannot be undone.`,
      'warning'
    );

    if (!confirmed) {
      this.releaseOperation(lockedRepo);
      return;
    }


    try {
      let result = await gitService.deleteBranch(
        repoPath,
        branch.name,
        false
      );

      // A not-fully-merged branch (e.g. one whose changes were squash-merged,
      // so its tip is not an ancestor of HEAD) can't be deleted without force.
      // Offer force instead of dead-ending — there's no other force path in
      // this menu, and the squash-finish flow directs users here.
      if (!result.success && /not fully merged/i.test(result.error?.message ?? '')) {
        const forceConfirmed = await showConfirm(
          'Branch Not Fully Merged',
          `"${branch.shorthand}" is not fully merged (its changes may have been squash-merged). Force delete it anyway?\n\nThis action cannot be undone.`,
          'warning'
        );
        if (!forceConfirmed) {
          // The user answered YES to the first confirm, so silence here reads
          // as "the delete did nothing and nobody will say why". The unmerged
          // refusal that explains it was consumed by the escalation prompt.
          showToast(
            `"${branch.shorthand}" was not deleted — it is not fully merged`,
            'warning'
          );
          return;
        }
        result = await gitService.deleteBranch(repoPath, branch.name, true);
      }

      if (result.success) {
        await this.loadBranches();
        // The same delete from the graph's ref menu toasts, force-delete
        // toasts, and Branch Cleanup toasts. Here the only signal was a row
        // vanishing from a list that is often filtered or scrolled away from
        // the deleted row — the same gap fixed on the sibling tag list.
        showToast(`Deleted branch ${branch.shorthand}`, 'success');
        this.dispatchBranchesChanged(repoPath);
      } else {
        console.error('Delete branch failed:', result.error);
        showToast(`Failed to delete branch: ${result.error?.message ?? 'Unknown error'}`, 'error');
      }
    } finally {
      this.releaseOperation(lockedRepo);
    }
  }

  private async handleMergeBranch(): Promise<void> {
    const branch = this.contextMenu.branch;
    if (!branch) return;
    const lockedRepo = this.repositoryPath;
    if (!this.claimOperation(lockedRepo)) return;

    this.contextMenu = { ...this.contextMenu, visible: false };

    // Captured BEFORE the confirm await: the merge must run on the repo it was
    // invoked on, even if the user switches tabs while the confirm is up.
    const repoPath = this.repositoryPath;
    // Predicted BEFORE the confirm, inside the claim taken above: the user has
    // to be able to see "N files would conflict" while deciding, not discover
    // it from a working tree that is already conflicted. Read-only and
    // in-memory in the backend, so it cannot race the merge it precedes.
    const prediction = await mergePreviewSummary(repoPath, branch.name);
    const confirmed = await showConfirm(
      'Merge Branch',
      `Merge "${branch.name}" into the current branch?${prediction}`,
      'info'
    );

    if (!confirmed) {
      this.releaseOperation(lockedRepo);
      return;
    }


    try {
      const result = await gitService.merge({
        path: repoPath,
      // `branch.name` (origin/feature), NOT `shorthand` (feature): the backend
      // resolves refs/heads/ FIRST, so a shorthand for a remote branch silently
      // hits the LOCAL branch of the same name — merging/rebasing onto a
      // different commit than the row the user right-clicked.
        sourceRef: branch.name,
      });

      if (result.success) {
        await this.loadBranches();
        // The same operation from the graph's ref label toasts. Here nothing
        // visibly changes on an up-to-date merge or a no-op rebase, so without
        // this the user cannot tell a completed operation from a dead click.
        showToast(`Merged ${branch.shorthand}`, 'success');
        this.dispatchBranchesChanged(repoPath);
      } else if (result.error?.code === 'MERGE_CONFLICT') {
        // Open the conflict-resolution dialog (same flow as the drag-drop path)
        this.dispatchEvent(new CustomEvent('merge-conflict', {
          bubbles: true,
          composed: true,
          detail: { repositoryPath: repoPath },
        }));
      } else {
        console.error('Merge failed:', result.error);
        showToast(`Merge failed: ${result.error?.message ?? 'Unknown error'}`, 'error');
      }
    } finally {
      this.releaseOperation(lockedRepo);
    }
  }

  private async handleRebaseBranch(): Promise<void> {
    const branch = this.contextMenu.branch;
    if (!branch) return;
    const lockedRepo = this.repositoryPath;
    if (!this.claimOperation(lockedRepo)) return;

    this.contextMenu = { ...this.contextMenu, visible: false };

    // Captured BEFORE the confirm await: the rebase must run on the repo it was
    // invoked on, even if the user switches tabs while the confirm is up.
    const repoPath = this.repositoryPath;
    const confirmed = await showConfirm(
      'Rebase Branch',
      `Rebase current branch onto "${branch.name}"?\n\nThis will rewrite commit history.`,
      'warning'
    );

    if (!confirmed) {
      this.releaseOperation(lockedRepo);
      return;
    }


    try {
      const result = await gitService.rebase({
        path: repoPath,
      // `branch.name` (origin/feature), NOT `shorthand` (feature): the backend
      // resolves refs/heads/ FIRST, so a shorthand for a remote branch silently
      // hits the LOCAL branch of the same name — merging/rebasing onto a
      // different commit than the row the user right-clicked.
        onto: branch.name,
      });

      if (result.success) {
        await this.loadBranches();
        showToast(rebasedOntoMessage(branch.shorthand, result.data), 'success');
        this.dispatchBranchesChanged(repoPath);
      } else if (result.error?.code === 'REBASE_CONFLICT') {
        // Open the conflict-resolution dialog (same flow as the drag-drop path)
        this.dispatchEvent(new CustomEvent('open-conflict-dialog', {
          bubbles: true,
          composed: true,
          detail: { operationType: 'rebase', repositoryPath: repoPath },
        }));
      } else {
        console.error('Rebase failed:', result.error);
        showToast(`Rebase failed: ${result.error?.message ?? 'Unknown error'}`, 'error');
      }
    } finally {
      this.releaseOperation(lockedRepo);
    }
  }

  /**
   * Ask the host to open the comparison dialog aimed at this branch.
   *
   * Read-only, so unlike its merge/rebase siblings it is not gated on
   * `operationInProgress`: nothing about looking at a diff conflicts with a
   * running working-tree operation, and disabling it would leave the user
   * without the one entry point that could explain what is going on.
   */
  private handleCompareBranch(): void {
    const branch = this.contextMenu.branch;
    if (!branch) return;

    this.contextMenu = { ...this.contextMenu, visible: false };
    this.dispatchEvent(new CustomEvent('compare-branch', {
      bubbles: true,
      composed: true,
      // Full name, so a remote branch resolves as "origin/x" rather than
      // colliding with a same-named local branch — same reason as merge/rebase.
      detail: { compareRef: branch.name },
    }));
  }

  private handleInteractiveRebase(): void {
    const branch = this.contextMenu.branch;
    // Only opens the dialog — it starts no git operation itself, so it checks
    // the lock rather than taking one it would never release.
    if (!branch || this.operationInProgress) return;

    this.contextMenu = { ...this.contextMenu, visible: false };
    this.dispatchEvent(new CustomEvent('interactive-rebase', {
      bubbles: true,
      composed: true,
      // Full remote name, for the same reason as merge/rebase above.
      detail: { onto: branch.name },
    }));
  }

  /** Dispatch branches-changed carrying the repo the mutating operation ran
   * on (captured pre-await by the caller), so the host pins the refresh to
   * that repo instead of whichever tab is active if the user switched
   * mid-operation. Pass `this.repositoryPath` for synchronous callers. */
  private dispatchBranchesChanged(repoPath: string): void {
    this.dispatchEvent(new CustomEvent('branches-changed', {
      detail: { repositoryPath: repoPath },
      bubbles: true,
      composed: true,
    }));
  }

  private handleCreateBranchFrom(): void {
    const branch = this.contextMenu.branch;
    if (!branch) return;

    this.contextMenu = { ...this.contextMenu, visible: false };
    // For remote branches the start point must be the full remote-tracking name
    // (e.g. "origin/feature"); the stripped shorthand ("feature") either fails to
    // resolve or resolves to a same-named LOCAL branch at a different commit.
    this.requestCreateBranch(branch.isRemote ? branch.name : branch.shorthand);
  }

  private async handleTrackRemoteBranch(): Promise<void> {
    const branch = this.contextMenu.branch;
    if (!branch || !branch.isRemote) return;
    const repoPath = this.repositoryPath;

    this.contextMenu = { ...this.contextMenu, visible: false };

    const localName = branch.shorthand;
    const remoteBranchRef = branch.name;

    try {
      const createResult = await gitService.createBranch(repoPath, {
        name: localName,
        startPoint: remoteBranchRef,
        checkout: false,
      });

      if (!createResult.success) {
        showToast(`Failed to create branch: ${createResult.error?.message ?? 'Unknown error'}`, 'error');
        return;
      }

      const upstreamResult = await gitService.setUpstreamBranch(
        repoPath,
        localName,
        remoteBranchRef,
      );

      if (upstreamResult.success) {
        showToast(`Tracking ${remoteBranchRef} as ${localName}`, 'success');
        await this.loadBranches();
        this.dispatchBranchesChanged(repoPath);
      } else {
        // The branch EXISTS at this point — only the upstream config failed.
        // Skipping the refresh left the sidebar and graph without a branch the
        // repository already has, and the obvious recovery (clicking "Track
        // this branch" again) then failed at createBranch with "branch already
        // exists" and never reached the upstream step: a dead end.
        showToast(
          `Created ${localName} but failed to set upstream: ` +
            `${upstreamResult.error?.message ?? 'Unknown error'}`,
          'warning',
        );
        await this.loadBranches();
        this.dispatchBranchesChanged(repoPath);
      }
    } catch (err) {
      showToast(`Failed to track branch: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    }
  }

  private async handleSetUpstream(): Promise<void> {
    const branch = this.contextMenu.branch;
    if (!branch || branch.isRemote) return;

    this.contextMenu = { ...this.contextMenu, visible: false };

    // Captured BEFORE the in-app prompt await (a Lit overlay, NOT a native
    // modal — the window stays interactive, so the user can switch tabs while
    // it is open). Without this the set-upstream would run against whichever
    // repo is active when the prompt resolves, not the one it was invoked on.
    const repoPath = this.repositoryPath;
    const defaultUpstream = branch.upstream ?? `origin/${branch.shorthand}`;
    const upstream = await showPrompt('Set Upstream', `Set upstream for "${branch.shorthand}":`, defaultUpstream);
    if (!upstream) return;

    try {
      const result = await gitService.setUpstreamBranch(
        repoPath,
        branch.name,
        upstream.trim(),
      );

      if (result.success) {
        showToast(`Upstream set to ${upstream.trim()}`, 'success');
        await this.loadBranches();
        this.dispatchBranchesChanged(repoPath);
      } else {
        showToast(`Failed to set upstream: ${result.error?.message ?? 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showToast(`Failed to set upstream: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    }
  }

  private async handleUnsetUpstream(): Promise<void> {
    const branch = this.contextMenu.branch;
    if (!branch || branch.isRemote) return;

    this.contextMenu = { ...this.contextMenu, visible: false };

    const repoPath = this.repositoryPath;
    try {
      const result = await gitService.unsetUpstreamBranch(
        repoPath,
        branch.name,
      );

      if (result.success) {
        showToast(`Upstream removed for ${branch.shorthand}`, 'success');
        await this.loadBranches();
        this.dispatchBranchesChanged(repoPath);
      } else {
        showToast(`Failed to unset upstream: ${result.error?.message ?? 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showToast(`Failed to unset upstream: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    }
  }

  private renderBranchIcon(isHead: boolean) {
    if (isHead) {
      return html`
        <svg class="branch-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      `;
    }
    return html`
      <svg class="branch-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="6" y1="3" x2="6" y2="15"></line>
        <circle cx="18" cy="6" r="3"></circle>
        <circle cx="6" cy="18" r="3"></circle>
        <path d="M18 9a9 9 0 01-9 9"></path>
      </svg>
    `;
  }

  private renderAheadBehind(branch: Branch) {
    if (!branch.aheadBehind) return nothing;

    const { ahead, behind } = branch.aheadBehind;
    if (ahead === 0 && behind === 0) return nothing;

    return html`
      <span class="ahead-behind">
        ${ahead > 0 ? html`<span class="ahead" title="${ahead} commit${ahead > 1 ? 's' : ''} ahead of remote">↑${ahead}</span>` : nothing}
        ${behind > 0 ? html`<span class="behind" title="${behind} commit${behind > 1 ? 's' : ''} behind remote">↓${behind}</span>` : nothing}
      </span>
    `;
  }

  /**
   * Check if a branch is stale based on user's staleBranchDays setting
   */
  private isBranchStale(branch: Branch): boolean {
    const { staleBranchDays } = settingsStore.getState();

    // If staleBranchDays is 0, feature is disabled
    if (staleBranchDays === 0) return false;

    // HEAD branch is never stale
    if (branch.isHead) return false;

    // Check if lastCommitTimestamp exists
    if (!branch.lastCommitTimestamp) return false;

    const nowSeconds = Date.now() / 1000;
    const staleThresholdSeconds = staleBranchDays * 24 * 60 * 60;

    return branch.lastCommitTimestamp < nowSeconds - staleThresholdSeconds;
  }

  private renderStaleIndicator(branch: Branch) {
    if (!this.isBranchStale(branch)) return nothing;

    // Calculate how long ago the last commit was
    const lastCommit = branch.lastCommitTimestamp;
    let title = 'Stale branch';
    if (lastCommit) {
      const daysAgo = Math.floor((Date.now() / 1000 - lastCommit) / (24 * 60 * 60));
      const months = Math.floor(daysAgo / 30);
      if (months >= 1) {
        title = `Last commit ${months} month${months > 1 ? 's' : ''} ago`;
      } else {
        title = `Last commit ${daysAgo} days ago`;
      }
    }

    return html`
      <span class="stale-indicator" title="${title}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
      </span>
    `;
  }

  private renderBranchItem(branch: Branch, nested = false, stripPrefix: string | null = null) {
    // Determine display name: strip prefix if provided
    let displayName = branch.shorthand;
    if (stripPrefix && displayName.startsWith(stripPrefix + '/')) {
      displayName = displayName.substring(stripPrefix.length + 1);
    }

    const isDragging = this.draggingBranch?.name === branch.name;
    const isDropTarget = this.dropTargetBranch?.name === branch.name;
    const dropClass = isDropTarget ? `drop-target drop-target-${this.dropAction}` : '';
    const staleClass = this.isBranchStale(branch) ? 'stale' : '';
    const hiddenClass = this.hiddenBranches.has(branch.name) ? 'hidden-branch' : '';

    return html`
      <li
        class="branch-item ${branch.isHead ? 'active' : ''} ${nested ? 'nested' : ''} ${isDragging ? 'dragging' : ''} ${dropClass} ${staleClass} ${hiddenClass} ${this.contextMenu.visible && this.contextMenu.branch?.name === branch.name ? 'context-target' : ''}"
        role="listitem"
        draggable=${!branch.isHead && !this.operationInProgress ? 'true' : 'false'}
        @click=${() => this.handleBranchClick(branch)}
        @dblclick=${() => this.handleCheckout(branch)}
        @contextmenu=${(e: MouseEvent) => this.handleContextMenu(e, branch)}
        @dragstart=${(e: DragEvent) => this.handleDragStart(e, branch)}
        @dragend=${() => this.handleDragEnd()}
        @dragover=${(e: DragEvent) => this.handleDragOver(e, branch)}
        @dragenter=${(e: DragEvent) => this.handleDragEnter(e, branch)}
        @dragleave=${(e: DragEvent) => this.handleDragLeave(e, branch)}
        @drop=${(e: DragEvent) => this.handleDrop(e, branch)}
        title="${branch.name}"
      >
        ${this.renderBranchIcon(branch.isHead)}
        ${!branch.isRemote && branch.upstream ? html`
          <div class="branch-info">
            <span class="branch-name">${displayName}</span>
            <span class="branch-upstream" title="Tracking ${branch.upstream}">→ ${branch.upstream}</span>
          </div>
        ` : html`<span class="branch-name">${displayName}</span>`}
        ${this.renderAheadBehind(branch)}
        ${this.renderStaleIndicator(branch)}
        ${isDropTarget ? html`
          <span class="drop-indicator ${this.dropAction}">${this.dropAction === 'merge' ? 'Merge' : 'Rebase'}</span>
        ` : nothing}
      </li>
    `;
  }

  // Drag and drop handlers
  private handleDragStart(e: DragEvent, branch: Branch): void {
    if (branch.isHead) {
      e.preventDefault();
      return;
    }

    this.draggingBranch = branch;
    const item: DragItem = { type: 'branch', data: branch };
    e.dataTransfer?.setData('application/json', JSON.stringify(item));
    e.dataTransfer!.effectAllowed = 'move';
    dragDropService.startDrag(item);
  }

  private handleDragEnd(): void {
    this.draggingBranch = null;
    this.dropTargetBranch = null;
    this.dropAction = null;
    dragDropService.endDrag();
  }

  private handleDragOver(e: DragEvent, branch: Branch): void {
    // Can't drop on self or HEAD
    if (!this.draggingBranch || this.draggingBranch.name === branch.name) return;

    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';

    // Determine action based on alt key (alt = rebase, no alt = merge)
    this.dropAction = e.altKey ? 'rebase' : 'merge';
  }

  private handleDragEnter(e: DragEvent, branch: Branch): void {
    // Can't drop on self
    if (!this.draggingBranch || this.draggingBranch.name === branch.name) return;

    e.preventDefault();
    this.dropTargetBranch = branch;
    this.dropAction = e.altKey ? 'rebase' : 'merge';
  }

  private handleDragLeave(e: DragEvent, branch: Branch): void {
    // Only clear if we're actually leaving this element
    const target = e.currentTarget as HTMLElement;
    if (target.contains(e.relatedTarget as Node)) return;

    if (this.dropTargetBranch?.name === branch.name) {
      this.dropTargetBranch = null;
      this.dropAction = null;
    }
  }

  private async handleDrop(e: DragEvent, targetBranch: Branch): Promise<void> {
    e.preventDefault();

    const sourceBranch = this.draggingBranch;
    if (!sourceBranch || sourceBranch.name === targetBranch.name) return;

    // Every context-menu handler beside this one takes `operationInProgress`
    // before it starts. Drop did not, so a drag-merge landed on top of an
    // in-flight merge/checkout from the menu — two git operations mutating the
    // same worktree at once.
    const lockedRepo = this.repositoryPath;
    if (!this.claimOperation(lockedRepo)) return;
    try {
      await this.runDrop(e, targetBranch, sourceBranch);
    } finally {
      this.releaseOperation(lockedRepo);
    }
  }

  private async runDrop(
    e: DragEvent,
    targetBranch: Branch,
    sourceBranch: Branch,
  ): Promise<void> {

    // Determine action based on alt key
    const action = e.altKey ? 'rebase' : 'merge';

    // Clear drag state
    this.draggingBranch = null;
    this.dropTargetBranch = null;
    this.dropAction = null;
    dragDropService.endDrag();

    // Captured BEFORE the awaits below: conflict events must carry the repo
    // the operation actually ran on, even if the prop is rebound mid-flight.
    const repoPath = this.repositoryPath;

    // If target is HEAD, merge source into current
    if (targetBranch.isHead) {
      if (action === 'merge') {
        // Merge source branch into current (HEAD). Same conflict prediction the
        // context menu shows — a drag is the least deliberate of the merge
        // gestures, so it is the one that most needs the warning.
        const prediction = await mergePreviewSummary(repoPath, sourceBranch.name);
        const confirmed = await showConfirm(
          'Merge Branch',
          `Merge "${sourceBranch.name}" into the current branch?${prediction}`,
          'info'
        );
        if (!confirmed) return;

        const result = await gitService.merge({
          path: repoPath,
          // Full remote name — see handleMergeBranch.
          sourceRef: sourceBranch.name,
        });

        if (result.success) {
          await this.loadBranches();
          showToast(`Merged ${sourceBranch.shorthand}`, 'success');
          this.dispatchBranchesChanged(repoPath);
        } else if (result.error?.code === 'MERGE_CONFLICT') {
          this.dispatchEvent(new CustomEvent('merge-conflict', {
            bubbles: true,
            composed: true,
            detail: { repositoryPath: repoPath },
          }));
        } else {
          // No checkout happens on this arm — the target IS HEAD, so
          // saying "Switched to <branch>" would describe a switch that
          // never occurred and send the user looking for a way back.
          showToast(`Merge failed: ${result.error?.message ?? 'Unknown error'}`, 'error');
        }
      } else {
        // Rebase current branch onto source
        // Same disclosure the context menu and the graph's ref menu carry. A
        // drag is the least deliberate of the three gestures — alt-drag is easy
        // to trigger by accident — so it is the one that most needs it.
        const confirmed = await showConfirm(
          'Rebase Branch',
          `Rebase current branch onto "${sourceBranch.name}"?\n\nThis will rewrite commit history.`,
          'warning'
        );
        if (!confirmed) return;

        const result = await gitService.rebase({
          path: repoPath,
          // Full remote name — see handleMergeBranch.
          onto: sourceBranch.name,
        });

        if (result.success) {
          await this.loadBranches();
          showToast(rebasedOntoMessage(sourceBranch.shorthand, result.data), 'success');
          this.dispatchBranchesChanged(repoPath);
        } else if (result.error?.code === 'REBASE_CONFLICT') {
          this.dispatchEvent(new CustomEvent('open-conflict-dialog', {
            bubbles: true,
            composed: true,
            detail: { operationType: 'rebase', repositoryPath: repoPath },
          }));
        } else {
          // No checkout happens on this arm — the target IS HEAD, so
          // saying "Switched to <branch>" would describe a switch that
          // never occurred and send the user looking for a way back.
          showToast(`Rebase failed: ${result.error?.message ?? 'Unknown error'}`, 'error');
        }
      }
    } else {
      // Dropping on a non-HEAD branch: need to checkout first, then merge/rebase
      const actionText = action === 'merge' ? 'merge' : 'rebase onto';
      // Previewed against the TARGET branch, not HEAD: this arm checks the
      // target out first and merges into that, so a prediction against the
      // branch the user is leaving would describe a different merge.
      const prediction =
        action === 'merge'
          ? await mergePreviewSummary(repoPath, sourceBranch.name, targetBranch.name)
          : '';
      const confirmed = await showConfirm(
        action === 'merge' ? 'Merge Branch' : 'Rebase Branch',
        `This will checkout "${targetBranch.name}" and ${actionText} "${sourceBranch.name}". Continue?` +
          (action === 'rebase' ? `\n\nThis will rewrite commit history.` : '') +
          prediction,
        action === 'merge' ? 'info' : 'warning'
      );
      if (!confirmed) return;

      // First checkout target branch (with auto-stash for uncommitted changes).
      // Use the full branch.name — for remote branches this is the full
      // "origin/topic" reference the backend needs to create/use a local
      // tracking branch; the stripped shorthand ("topic") cannot be resolved.
      const checkoutResult = await gitService.checkoutWithAutoStash(repoPath, targetBranch.name);

      if (!checkoutResult.success || !checkoutResult.data?.success) {
        console.error('Checkout failed:', checkoutResult.data?.message || checkoutResult.error);
        showErrorWithSuggestion(
          checkoutResult.data?.message || checkoutResult.error?.message || '',
          'Checkout failed',
        );
        return;
      }

      if (checkoutResult.data.stashed && checkoutResult.data.stashConflict) {
        const actionName = action === 'merge' ? 'merge' : 'rebase';
        showToast(
          `Switched to ${targetBranch.shorthand}, but re-applying your stashed changes hit conflicts. The ${actionName} was NOT started — resolve the stash conflicts, then re-run the ${actionName}.`,
          'warning',
        );
        this.dispatchEvent(new CustomEvent('open-conflict-dialog', {
          bubbles: true,
          composed: true,
          // Auto-stash is pop semantics: drop it once resolved. Identified by
          // oid, not position — see handleCheckout.
          detail: {
            operationType: 'stash',
            stashOid: checkoutResult.data.stashOid ?? null,
            stashIndex: 0,
            dropStashOnComplete: true,
            repositoryPath: repoPath,
          },
        }));
        // The working tree is conflicted from the failed stash pop; do NOT fall
        // through into merge/rebase on a conflicted tree — the user must resolve
        // the stash conflicts first and re-run the operation.
        return;
      } else if (checkoutResult.data.stashed && checkoutResult.data.stashApplied) {
        showToast(checkoutResult.data.message, checkoutResult.data.message.includes('staged status was not preserved') ? 'warning' : 'info');
      } else if (checkoutResult.data.stashed && !checkoutResult.data.stashApplied) {
        showToast(checkoutResult.data.message, 'warning');
      }

      // Then perform the action
      if (action === 'merge') {
        const result = await gitService.merge({
          path: repoPath,
          // Full remote name — see handleMergeBranch.
          sourceRef: sourceBranch.name,
        });

        if (result.success) {
          await this.loadBranches();
          showToast(`Merged ${sourceBranch.shorthand}`, 'success');
          this.dispatchBranchesChanged(repoPath);
        } else if (result.error?.code === 'MERGE_CONFLICT') {
          this.dispatchEvent(new CustomEvent('merge-conflict', {
            bubbles: true,
            composed: true,
            detail: { repositoryPath: repoPath },
          }));
        } else {
          // The checkout ALREADY landed, so reload even though the
          // follow-up failed — otherwise every isHead flag is stale.
          await this.loadBranches();
          this.dispatchBranchesChanged(repoPath);
          showToast(
            `Switched to ${targetBranch.shorthand}, but the merge failed: ` +
              `${result.error?.message ?? 'Unknown error'}`,
            'error'
          );
        }
      } else {
        const result = await gitService.rebase({
          path: repoPath,
          // Full remote name — see handleMergeBranch.
          onto: sourceBranch.name,
        });

        if (result.success) {
          await this.loadBranches();
          showToast(rebasedOntoMessage(sourceBranch.shorthand, result.data), 'success');
          this.dispatchBranchesChanged(repoPath);
        } else if (result.error?.code === 'REBASE_CONFLICT') {
          this.dispatchEvent(new CustomEvent('open-conflict-dialog', {
            bubbles: true,
            composed: true,
            detail: { operationType: 'rebase', repositoryPath: repoPath },
          }));
        } else {
          // The checkout ALREADY landed, so reload even though the
          // follow-up failed — otherwise every isHead flag is stale.
          await this.loadBranches();
          this.dispatchBranchesChanged(repoPath);
          showToast(
            `Switched to ${targetBranch.shorthand}, but the rebase failed: ` +
              `${result.error?.message ?? 'Unknown error'}`,
            'error'
          );
        }
      }
    }
  }

  private renderLocalGroup(group: LocalBranchGroup) {
    const filteredBranches = this.sortBranches(this.filterBranches(group.branches));

    // Skip empty groups when filtering
    if (filteredBranches.length === 0 && this.filterText) return nothing;

    // For ungrouped branches (no prefix), render them directly
    if (group.prefix === null) {
      return html`
        <ul class="branch-list" role="list">
          ${filteredBranches.map((b) => this.renderBranchItem(b))}
        </ul>
      `;
    }

    // For prefix groups, render as collapsible subgroup
    const groupId = `local-${group.prefix}`;
    const expanded = this.expandedGroups.has(groupId);

    return html`
      <div class="subgroup">
        <div class="subgroup-header"
          role="button"
          tabindex="0"
          aria-expanded=${expanded}
          aria-label="${group.displayName} branch group, ${filteredBranches.length} branches"
          @click=${() => this.toggleGroup(groupId)}
          @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggleGroup(groupId); } }}
        >
          <svg class="chevron ${expanded ? 'expanded' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
          ${this.renderPrefixIcon(group.prefix)}
          <span class="subgroup-name">${group.displayName}</span>
          <span class="group-count">${filteredBranches.length}</span>
        </div>
        ${expanded ? html`
          <ul class="branch-list" role="list">
            ${filteredBranches.map((b) => this.renderBranchItem(b, true, group.prefix))}
          </ul>
        ` : nothing}
      </div>
    `;
  }

  private renderRemoteSubgroup(remoteName: string, subgroup: BranchSubgroup) {
    const filteredBranches = this.sortBranches(this.filterBranches(subgroup.branches));

    // Skip empty groups when filtering
    if (filteredBranches.length === 0 && this.filterText) return nothing;

    // For ungrouped branches (no prefix), render them directly
    if (subgroup.prefix === null) {
      return html`
        <ul class="branch-list" role="list">
          ${filteredBranches.map((b) => this.renderBranchItem(b))}
        </ul>
      `;
    }

    // For prefix groups, render as collapsible subgroup
    const groupId = `remote-${remoteName}-${subgroup.prefix}`;
    const expanded = this.expandedGroups.has(groupId);

    return html`
      <div class="subgroup">
        <div class="subgroup-header"
          role="button"
          tabindex="0"
          aria-expanded=${expanded}
          aria-label="${subgroup.displayName} branch group, ${filteredBranches.length} branches"
          @click=${() => this.toggleGroup(groupId)}
          @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggleGroup(groupId); } }}
        >
          <svg class="chevron ${expanded ? 'expanded' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
          ${this.renderPrefixIcon(subgroup.prefix)}
          <span class="subgroup-name">${subgroup.displayName}</span>
          <span class="group-count">${filteredBranches.length}</span>
        </div>
        ${expanded ? html`
          <ul class="branch-list" role="list">
            ${filteredBranches.map((b) => this.renderBranchItem(b, true, subgroup.prefix))}
          </ul>
        ` : nothing}
      </div>
    `;
  }

  private renderPrefixIcon(prefix: string) {
    // Different icons for common prefixes
    switch (prefix.toLowerCase()) {
      case 'feature':
        return html`<svg class="prefix-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
        </svg>`;
      case 'fix':
      case 'bugfix':
      case 'hotfix':
        return html`<svg class="prefix-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4.93 4.93l4.24 4.24"></path>
          <path d="M14.83 9.17l4.24-4.24"></path>
          <path d="M14.83 14.83l4.24 4.24"></path>
          <path d="M9.17 14.83l-4.24 4.24"></path>
          <circle cx="12" cy="12" r="4"></circle>
        </svg>`;
      case 'release':
        return html`<svg class="prefix-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon>
        </svg>`;
      case 'chore':
        return html`<svg class="prefix-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"></path>
        </svg>`;
      case 'copilot':
      case 'ai':
      case 'claude':
        // Sparkles icon for AI-generated branches
        return html`<svg class="prefix-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"></path>
          <path d="M5 16l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3z"></path>
          <path d="M19 13l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5.5-1.5z"></path>
        </svg>`;
      default:
        return html`<svg class="prefix-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"></path>
        </svg>`;
    }
  }

  private renderContextMenu() {
    if (!this.contextMenu.visible || !this.contextMenu.branch) return nothing;

    const branch = this.contextMenu.branch;
    const isLocal = !branch.isRemote;
    const isHead = branch.isHead;
    const createRequestBlocked = isLocal ? this.createRequestBlockedReason(branch) : null;

    return html`
      <div
        class="context-menu"
        role="menu"
        aria-label="Branch actions"
        style="left: ${this.contextMenu.x}px; top: ${this.contextMenu.y}px;"
        @click=${(e: Event) => e.stopPropagation()}
        @keydown=${(e: KeyboardEvent) => this.handleContextMenuKeydown(e)}
      >
        ${!isHead ? html`
          <button class="context-menu-item" role="menuitem" ?disabled=${this.operationInProgress} @click=${() => this.handleCheckout(branch)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            Checkout
          </button>
        ` : ''}

        <button class="context-menu-item" role="menuitem" @click=${this.handleCreateBranchFrom}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          Create branch from here
        </button>

        ${!isHead ? html`
          <button class="context-menu-item" role="menuitem" @click=${this.handleCompareBranch}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="6" cy="6" r="3"></circle>
              <circle cx="18" cy="18" r="3"></circle>
              <line x1="6" y1="9" x2="6" y2="21"></line>
              <line x1="18" y1="3" x2="18" y2="15"></line>
            </svg>
            Compare with current branch
          </button>
        ` : ''}

        ${!isLocal ? html`
          <button class="context-menu-item" role="menuitem" @click=${this.handleTrackRemoteBranch}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"></path>
              <circle cx="8.5" cy="7" r="4"></circle>
              <line x1="20" y1="8" x2="20" y2="14"></line>
              <line x1="23" y1="11" x2="17" y2="11"></line>
            </svg>
            Track this branch
          </button>
        ` : ''}

        ${isLocal ? html`
          <button
            class="context-menu-item"
            role="menuitem"
            ?disabled=${createRequestBlocked !== null}
            title=${createRequestBlocked ?? `Open a ${this.prProvider?.itemNoun ?? 'pull request'} for ${branch.shorthand} on ${this.prProvider?.providerName ?? 'the remote'}`}
            @click=${this.handleCreatePullRequest}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="18" cy="18" r="3"></circle>
              <circle cx="6" cy="6" r="3"></circle>
              <path d="M13 6h3a2 2 0 0 1 2 2v7"></path>
              <line x1="6" y1="9" x2="6" y2="21"></line>
            </svg>
            ${this.createRequestLabel}
          </button>
        ` : ''}

        <button class="context-menu-item" role="menuitem" @click=${() => { this.toggleHideBranch(branch.name); this.contextMenu = { ...this.contextMenu, visible: false }; }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            ${this.hiddenBranches.has(branch.name)
              ? html`<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>`
              : html`<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>`
            }
          </svg>
          ${this.hiddenBranches.has(branch.name) ? 'Show branch' : 'Hide branch'}
        </button>

        ${!isHead ? html`
          <button class="context-menu-item" role="menuitem" ?disabled=${this.operationInProgress} @click=${this.handleMergeBranch}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="18" cy="18" r="3"></circle>
              <circle cx="6" cy="6" r="3"></circle>
              <path d="M6 21V9a9 9 0 009 9"></path>
            </svg>
            Merge into current branch
          </button>
          <button class="context-menu-item" role="menuitem" ?disabled=${this.operationInProgress} @click=${this.handleRebaseBranch}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="6" cy="6" r="3"></circle>
              <circle cx="6" cy="18" r="3"></circle>
              <line x1="6" y1="9" x2="6" y2="15"></line>
              <path d="M18 6h-6a3 3 0 00-3 3v3"></path>
            </svg>
            Rebase current onto this
          </button>
          <button class="context-menu-item" role="menuitem" ?disabled=${this.operationInProgress} @click=${this.handleInteractiveRebase}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="9" y1="9" x2="15" y2="9"></line>
              <line x1="9" y1="13" x2="15" y2="13"></line>
              <line x1="9" y1="17" x2="12" y2="17"></line>
            </svg>
            Interactive rebase onto this
          </button>
        ` : ''}

        ${isLocal && !isHead ? html`
          <div class="context-menu-divider" role="separator"></div>
          <button class="context-menu-item" role="menuitem" @click=${this.handleSetUpstream}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="21" y1="3" x2="14" y2="10"></line>
              <path d="M10 14L3 21"></path>
            </svg>
            ${branch.upstream ? 'Change Upstream...' : 'Set Upstream...'}
          </button>
          ${branch.upstream ? html`
            <button class="context-menu-item" role="menuitem" @click=${this.handleUnsetUpstream}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
              Unset Upstream
            </button>
          ` : ''}
          <div class="context-menu-divider" role="separator"></div>
          <button class="context-menu-item" role="menuitem" ?disabled=${this.operationInProgress} @click=${this.handleRenameBranch}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
            </svg>
            Rename
          </button>
          <button class="context-menu-item danger" role="menuitem" ?disabled=${this.operationInProgress} @click=${this.handleDeleteBranch}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path>
            </svg>
            Delete branch
          </button>
        ` : ''}
      </div>
    `;
  }

  private renderControls() {
    return html`
      <div class="controls" style="position: relative;">
        <button
          class="controls-btn ${this.showFilter ? 'active' : ''}"
          title="Filter branches"
          aria-label="Filter branches"
          @click=${this.toggleFilter}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
        </button>
        <button
          class="controls-btn ${this.showSortMenu ? 'active' : ''}"
          title="Sort branches"
          aria-label="Sort branches"
          @click=${this.toggleSortMenu}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="4" y1="6" x2="20" y2="6"></line>
            <line x1="4" y1="12" x2="16" y2="12"></line>
            <line x1="4" y1="18" x2="12" y2="18"></line>
          </svg>
        </button>
        <div style="flex:1"></div>
        <button
          class="controls-btn"
          title="Create branch"
          aria-label="Create branch"
          @click=${this.handleCreateBranch}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
        ${this.showSortMenu ? html`
          <div class="sort-menu" role="menu" aria-label="Sort options" @click=${(e: Event) => e.stopPropagation()}>
            <button class="sort-option ${this.sortMode === 'name' ? 'active' : ''}" role="menuitem" @click=${() => this.setSortMode('name')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M4 6h7M4 12h5M4 18h3M17 6v12M14 18l3 3 3-3"></path>
              </svg>
              Name (A-Z)
            </button>
            <button class="sort-option ${this.sortMode === 'date' ? 'active' : ''}" role="menuitem" @click=${() => this.setSortMode('date')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
              </svg>
              Date (Newest)
            </button>
            <button class="sort-option ${this.sortMode === 'date-asc' ? 'active' : ''}" role="menuitem" @click=${() => this.setSortMode('date-asc')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
              </svg>
              Date (Oldest)
            </button>
          </div>
        ` : nothing}
      </div>
      ${this.showFilter ? html`
        <div class="filter-bar">
          <svg style="width:14px;height:14px;color:var(--color-text-muted);margin-right:4px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            class="filter-input"
            type="text"
            placeholder="Filter branches..."
            aria-label="Filter branches"
            .value=${this.filterText}
            @input=${this.handleFilterInput}
          />
          ${this.filterText ? html`
            <button class="filter-clear" aria-label="Clear filter" @click=${this.clearFilter}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          ` : nothing}
        </div>
      ` : nothing}
    `;
  }

  render() {
    // The dialogs are rendered UNCONDITIONALLY and FIRST so a background
    // refresh (which flips `loading` true→false and would otherwise swap the
    // whole template for the loading placeholder) cannot tear down and
    // recreate the embedded interactive-rebase dialog — that would silently
    // discard an in-progress rebase plan the user built before switching
    // tabs. Keeping them at a stable template position preserves the element
    // instances across loading/error toggles.
    const dialogs = html`
      <lv-branch-cleanup-dialog
        .repositoryPath=${this.repositoryPath}
        @cleanup-complete=${this.handleCleanupComplete}
      ></lv-branch-cleanup-dialog>
    `;

    // ONE stable outer template: the dialogs sit at a FIXED position and the
    // loading/error/content choice is a nested conditional slot. Returning
    // three DIFFERENT top-level templates (as before) made lit-html re-clone
    // the whole subtree on every loading toggle — recreating the dialogs in
    // their closed state and discarding an in-progress rebase plan.
    return html`
      ${dialogs}
      ${this.loading
        ? html`<div class="loading">Loading branches...</div>`
        : this.error
          ? html`<div class="error">${this.error}</div>`
          : this.renderBody()}
    `;
  }

  private renderBody(): ReturnType<typeof html> {
    return html`
      ${this.renderControls()}

      <!-- Local branches -->
      ${this.localBranchGroups.length > 0 ? html`
        <div class="local-header">
          <span class="local-header-title">Local Branches</span>
          ${this.getCleanupCandidateCount() > 0 || this.cleanupCheckFailed ? html`
            <button
              class="cleanup-btn"
              @click=${this.handleOpenCleanupDialog}
              title=${this.cleanupCheckFailed
                ? 'Could not check for cleanup candidates — open to retry'
                : `${this.getCleanupCandidateCount()} branch${this.getCleanupCandidateCount() === 1 ? '' : 'es'} can be reviewed for cleanup`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path>
              </svg>
              Clean up
              ${this.cleanupCheckFailed
                ? nothing
                : html`<span class="badge">${this.getCleanupCandidateCount()}</span>`}
            </button>
          ` : nothing}
        </div>
        <div class="local-section">
          ${this.localBranchGroups.map((group) => this.renderLocalGroup(group))}
        </div>
      ` : nothing}

      <!-- Remote branches -->
      ${this.remoteGroups.map((group) => {
        const groupId = `remote-${group.name}`;
        const expanded = this.expandedGroups.has(groupId);

        return html`
          <div class="group">
            <div class="group-header"
              role="button"
              tabindex="0"
              aria-expanded=${expanded}
              aria-label="${group.name} remote, ${group.branches.length} branches"
              @click=${() => this.toggleGroup(groupId)}
              @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggleGroup(groupId); } }}
            >
              <svg class="chevron ${expanded ? 'expanded' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
              <svg class="group-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"></path>
              </svg>
              <span class="group-name">${group.name}</span>
              <span class="group-count">${group.branches.length}</span>
            </div>
            ${expanded ? html`
              ${group.subgroups?.map((subgroup) => this.renderRemoteSubgroup(group.name, subgroup))}
            ` : nothing}
          </div>
        `;
      })}

      ${this.renderContextMenu()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-branch-list': LvBranchList;
  }
}
