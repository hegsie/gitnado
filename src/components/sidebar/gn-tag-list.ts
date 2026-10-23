/**
 * Tag List Component
 * Displays and manages repository tags with filtering, sorting, and version grouping
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { showErrorWithSuggestion } from '../../services/error-suggestion.service.ts';
import { repositoryStore } from '../../stores/repository.store.ts';
import type { Tag, Remote } from '../../types/git.types.ts';
import { isTopOverlay } from '../../utils/overlay-stack.ts';
import { confirmDeleteTag, offerRemoteTagDelete } from '../../utils/tag-delete.ts';
import {
  tryAcquireRefOpOrWarn,
  releaseRefOp,
  isRefOpRunning,
  subscribeRefOps,
  pushTagKey,
  tryAcquirePush,
  releasePush,
  warnRepositoryBusy,
  isPushRunning,
} from '../../utils/ref-lock.ts';

type TagSortMode = 'name' | 'date' | 'date-asc';

interface TagGroup {
  name: string;
  tags: Tag[];
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  tag: Tag | null;
}

@customElement('gn-tag-list')
export class GnTagList extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .tag-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      /* Full-bleed row inside a scrolling list: draw the shared keyboard
         focus ring inside the row so the scroll container cannot clip it. */
      .tag-item {
        --gn-focus-ring-offset: -2px;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 12px;
        cursor: pointer;
        font-size: var(--font-size-sm);
      }

      .tag-item:hover {
        background: var(--color-bg-hover);
      }

      .tag-icon {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        color: var(--color-warning);
      }

      .tag-info {
        flex: 1;
        min-width: 0;
      }

      .tag-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .tag-type {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .empty {
        padding: 4px 8px;
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
        text-align: center;
      }

      /* A failed load renders THIS, never the previous repository's rows. */
      .error {
        padding: 4px 8px;
        color: var(--color-error);
        font-size: var(--font-size-sm);
        text-align: center;
        overflow-wrap: anywhere;
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-md);
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }

      /* Context menu */
      .context-menu {
        position: fixed;
        z-index: var(--z-dropdown, 100);
        min-width: 140px;
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

      .context-menu-item.push-remote-item {
        padding-left: calc(var(--spacing-md) * 2);
        color: var(--color-text-secondary);
      }

      .context-menu-item svg {
        width: 14px;
        height: 14px;
        color: var(--color-text-muted);
      }

      .context-menu-item.danger svg {
        color: var(--color-error);
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

      /* Group headers.
         Full-bleed row inside a scrolling list: draw the shared keyboard
         focus ring inside the row so the scroll container cannot clip it. */
      .group-header {
        --gn-focus-ring-offset: -2px;
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
    `,
  ];

  @property({ type: String }) repositoryPath: string = '';

  @state() private tags: Tag[] = [];
  @state() private loading = true;
  @state() private contextMenu: ContextMenuState = { visible: false, x: 0, y: 0, tag: null };
  @state() private filterText = '';
  @state() private sortMode: TagSortMode = 'name';
  @state() private showFilter = false;
  @state() private showSortMenu = false;
  @state() private collapsedGroups = new Set<string>();
  /**
   * The bound repo's remotes, loaded when the context menu opens.
   *
   * null = not known yet, or the read failed: the menu then keeps the old
   * behaviour and lets the backend resolve the push destination.
   */
  @state() private remotes: Remote[] | null = null;
  /**
   * The remote read for the open context menu, while it is still in flight.
   *
   * A Push click that lands before it resolves waits for it, rather than
   * pushing to whatever the backend resolves.
   */
  private remotesLoad: Promise<void> | null = null;
  /** The multi-remote push item's sub-list is open. */
  @state() private pushRemotesExpanded = false;
  /**
   * The working-tree lock, shared with app-shell and the other sidebar lists.
   *
   * This was a component-local boolean, so a hard reset started from the graph
   * and a checkout started here ran concurrently against the same working
   * tree. See utils/ref-lock.ts.
   */
  @state() private refOpsVersion = 0;
  private unsubscribeRefOps?: () => void;

  /**
   * True when the right-clicked tag already has a push in flight.
   *
   * The tag-push slot is separate from the working-tree lock, so
   * operationInProgress cannot see it: Force Push Tag — from the rejected-push
   * suggestion toast — holds only the push slot, and holds it across its
   * confirm. Without this the Push item stayed lit through that window and the
   * click did nothing but raise a refusal toast. subscribeRefOps already fires
   * on push-slot transitions (both share notify()), so the binding re-renders.
   */
  private get tagPushInFlight(): boolean {
    void this.refOpsVersion;
    const name = this.contextMenu.tag?.name;
    return name !== undefined && isPushRunning(pushTagKey(this.repositoryPath, name));
  }

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
    // Keep in sync with app-level refreshes (e.g. a gitflow release finish
    // creating a tag completes inside the shared conflict dialog) — same
    // subscription as the sibling branch/stash/gitflow lists.
    window.addEventListener('repository-refresh', this.handleRepositoryRefresh);
    await this.loadTags();
    document.addEventListener('click', this.handleDocumentClick);
    document.addEventListener('keydown', this.handleKeydown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeRefOps?.();
    this.unsubscribeRefOps = undefined;
    window.removeEventListener('repository-refresh', this.handleRepositoryRefresh);
    document.removeEventListener('click', this.handleDocumentClick);
    document.removeEventListener('keydown', this.handleKeydown);
  }

  private handleRepositoryRefresh = (): void => {
    void this.loadTags();
  };

  private handleDocumentClick = (): void => {
    if (this.contextMenu.visible) {
      this.contextMenu = { ...this.contextMenu, visible: false };
    }
    if (this.showSortMenu) {
      this.showSortMenu = false;
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

  private handleTagItemKeydown(e: KeyboardEvent, tag: Tag): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.handleTagClick(tag);
    }
  }

  async updated(changedProperties: Map<string, unknown>): Promise<void> {
    if (changedProperties.has('repositoryPath') && this.repositoryPath) {
      // A menu entry acts on the tag it was opened over, but resolves the repo
      // from `this.repositoryPath` at click time — and a keyboard tab switch
      // produces neither a document click nor Escape, so the menu would survive
      // the rebind and delete repo A's `v1.0.0` inside repo B.
      this.contextMenu = { ...this.contextMenu, visible: false };
      // Drop the previous repo's remotes before the reload: they must never
      // label the new repo's menu.
      this.remotes = null;
      await this.loadTags();
    }
  }

  public async refresh(): Promise<void> {
    await this.loadTags();
  }

  /**
   * Per-path load generation. gn-left-panel keeps ONE instance of this element
   * across tabs and only rebinds `.repositoryPath`, and Lit does not await an
   * async `updated()` — so Ctrl+Tab twice quickly (A→B→A) starts overlapping
   * loads with nothing sequencing them, and whichever resolved last won.
   *
   * This is the worst case in the sidebar: handleDeleteTag / handleCheckoutTag
   * pass the clicked row's `tag.name` straight to the ACTIVE repo, and tag
   * names collide across repositories routinely (`v1.0.0`) — so a stale row
   * meant the confirm quoted a tag the user was not looking at and the delete
   * landed on a different commit. Same shape as
   * gn-branch-list.branchesLoadSeq and gn-file-status.statusLoadSeq.
   */
  private tagsLoadSeq = new Map<string, number>();

  /**
   * The load for the CURRENT repo failed. Rendered, because the alternative —
   * leaving the previous repo's rows on screen — is indistinguishable from
   * real data and every one of those rows is a live delete/checkout target.
   */
  @state() private error: string | null = null;

  private async loadTags(): Promise<void> {
    if (!this.repositoryPath) return;

    // Captured before the await so a mid-flight tab switch still resolves this
    // result against the repo it was loaded FROM.
    const loadedPath = this.repositoryPath;
    const seq = (this.tagsLoadSeq.get(loadedPath) ?? 0) + 1;
    this.tagsLoadSeq.set(loadedPath, seq);
    /** Latest load for this path AND this path is still the bound one. */
    const isFresh = (): boolean =>
      this.tagsLoadSeq.get(loadedPath) === seq && this.repositoryPath === loadedPath;

    this.loading = true;

    try {
      const result = await gitService.getTags(loadedPath);
      // A superseded load must touch NOTHING: not the rows, not the count
      // badge, not the loading flag the live load owns.
      if (!isFresh()) return;

      if (result.success) {
        this.error = null;
        this.tags = result.data!;
        // Emit count changed event
        this.dispatchEvent(new CustomEvent('tag-count-changed', {
          detail: { count: this.tags.length },
          bubbles: true,
          composed: true,
        }));
      } else {
        this.error = result.error?.message || 'Failed to load tags';
        this.tags = [];
        this.dispatchEvent(new CustomEvent('tag-count-changed', {
          detail: { count: 0 },
          bubbles: true,
          composed: true,
        }));
        showToast(this.error, 'error');
      }
    } catch (err) {
      console.error('Failed to load tags:', err);
      if (isFresh()) {
        this.error = err instanceof Error ? err.message : 'Failed to load tags';
        this.tags = [];
        this.dispatchEvent(new CustomEvent('tag-count-changed', {
          detail: { count: 0 },
          bubbles: true,
          composed: true,
        }));
        showToast('Failed to load tags', 'error');
      }
    } finally {
      if (isFresh()) {
        this.loading = false;
      }
    }
  }

  private filterTags(tags: Tag[]): Tag[] {
    if (!this.filterText) return tags;
    const lower = this.filterText.toLowerCase();
    return tags.filter((t) => t.name.toLowerCase().includes(lower));
  }

  private sortTags(tags: Tag[]): Tag[] {
    return [...tags].sort((a, b) => {
      switch (this.sortMode) {
        case 'date': {
          // Newest first; lightweight tags (no tagger) sort to end
          const aTime = a.tagger?.timestamp ?? 0;
          const bTime = b.tagger?.timestamp ?? 0;
          if (aTime === 0 && bTime === 0) return a.name.localeCompare(b.name);
          if (aTime === 0) return 1;
          if (bTime === 0) return -1;
          return bTime - aTime;
        }
        case 'date-asc': {
          // Oldest first; lightweight tags (no tagger) sort to end
          const aTime = a.tagger?.timestamp ?? 0;
          const bTime = b.tagger?.timestamp ?? 0;
          if (aTime === 0 && bTime === 0) return a.name.localeCompare(b.name);
          if (aTime === 0) return 1;
          if (bTime === 0) return -1;
          return aTime - bTime;
        }
        case 'name':
        default:
          return a.name.localeCompare(b.name);
      }
    });
  }

  private groupTags(tags: Tag[]): TagGroup[] {
    const versionRegex = /^v?(\d+)\./;
    const groupMap = new Map<string, Tag[]>();

    for (const tag of tags) {
      const match = tag.name.match(versionRegex);
      const key = match ? `v${match[1]}.x` : 'Other';
      if (!groupMap.has(key)) {
        groupMap.set(key, []);
      }
      groupMap.get(key)!.push(tag);
    }

    // If only one group, return flat (no headers needed)
    if (groupMap.size <= 1) {
      return [{ name: '', tags }];
    }

    // Sort groups: newest major version first, "Other" last
    const groups = Array.from(groupMap.entries()).map(([name, tags]) => ({ name, tags }));
    groups.sort((a, b) => {
      if (a.name === 'Other') return 1;
      if (b.name === 'Other') return -1;
      // Extract version number for comparison
      const aNum = parseInt(a.name.replace('v', ''));
      const bNum = parseInt(b.name.replace('v', ''));
      return bNum - aNum; // Newest first
    });

    return groups;
  }

  private handleContextMenu(e: MouseEvent, tag: Tag): void {
    e.preventDefault();
    e.stopPropagation();

    this.contextMenu = {
      visible: true,
      x: e.clientX,
      y: e.clientY,
      tag,
    };
    this.pushRemotesExpanded = false;
    // Re-read on every open, so a remote just added or renamed in the Remote
    // dialog labels the menu correctly without a reload. Kept, not discarded:
    // a Push click landing before it resolves awaits it.
    this.remotesLoad = this.loadRemotes();
  }

  /**
   * Load the bound repo's remotes so the Push item can name its destination.
   *
   * get_remotes reads local config only — no network — so this is safe to run
   * on every context-menu open.
   */
  private async loadRemotes(): Promise<void> {
    if (!this.repositoryPath) return;
    // Pinned like loadTags: a mid-flight tab switch must not let repo A's
    // remotes label repo B's menu.
    const loadedPath = this.repositoryPath;
    try {
      const result = await gitService.getRemotes(loadedPath);
      if (this.repositoryPath !== loadedPath) return;
      this.remotes = result.success ? (result.data ?? []) : null;
    } catch (err) {
      console.error('Failed to load remotes:', err);
      if (this.repositoryPath !== loadedPath) return;
      this.remotes = null;
    }
  }

  private async handleCheckoutTag(): Promise<void> {
    const tag = this.contextMenu.tag;
    if (!tag) return;
    const lockedRepo = this.repositoryPath;
    if (!this.claimOperation(lockedRepo)) return;

    this.contextMenu = { ...this.contextMenu, visible: false };

    // Captured BEFORE the confirm await: the checkout must run on the repo it
    // was invoked on (and the conflict event must carry it), even if the user
    // switches tabs while the confirm is up and the prop rebinds.
    const repoPath = this.repositoryPath;
    const confirmed = await showConfirm(
      'Checkout Tag',
      `Checking out tag "${tag.name}" will put you in 'detached HEAD' state. Any new commits won't belong to any branch. Continue?`,
      'warning'
    );
    if (!confirmed) {
      this.releaseOperation(lockedRepo);
      return;
    }


    try {
      // Fully-qualified, not the bare tag name.
      //
      // The backend resolvers try find_branch(ref_name, Local) FIRST and only
      // fall back to revparse_single. So a bare name that a branch also uses —
      // routine with names like "release" or "v2" — checked out the BRANCH,
      // attached at its tip, which can be a completely different commit. The
      // user had just confirmed a "detached HEAD" warning, and the app reported
      // success with no hint that it had checked out something else.
      //
      // This also restores git's own disambiguation, which prefers
      // refs/tags/<name> over refs/heads/<name>.
      const result = await gitService.checkoutWithAutoStash(repoPath, `refs/tags/${tag.name}`);

      if (result.success && result.data?.success) {
        const data = result.data;
        if (data.stashed && data.stashConflict) {
          showToast(`Switched to ${tag.name} — stash conflicts need resolution`, 'warning');
          // Open the conflict resolution dialog so the user can resolve the failed
          // auto-stash pop (pop semantics: drop it once resolved). Identified by
          // oid, not position — another surface or a terminal can push a stash
          // in between and renumber the list.
          this.dispatchEvent(new CustomEvent('open-conflict-dialog', {
            bubbles: true,
            composed: true,
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
        this.dispatchEvent(new CustomEvent('tag-checkout', {
          detail: { tag, repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));
      } else {
        const errorMsg = result.data?.message || result.error?.message || '';
        console.error('Failed to checkout tag:', errorMsg);
        // Same translation the branch and graph checkout paths get.
        showErrorWithSuggestion(errorMsg, 'Failed to checkout tag');
      }
    } finally {
      this.releaseOperation(lockedRepo);
    }
  }

  private async handleDeleteTag(): Promise<void> {
    const tag = this.contextMenu.tag;
    if (!tag) return;
    const lockedRepo = this.repositoryPath;
    if (!this.claimOperation(lockedRepo)) return;

    this.contextMenu = { ...this.contextMenu, visible: false };

    // Captured BEFORE the confirm await: tag deletion is irreversible and must
    // target the repo it was invoked on, even if the user switches tabs (to a
    // repo that may have a same-named tag) while the confirm is up.
    const repoPath = this.repositoryPath;
    const confirmed = await confirmDeleteTag(tag.name);

    if (!confirmed) {
      this.releaseOperation(lockedRepo);
      return;
    }


    try {
      const result = await gitService.deleteTag({
        path: repoPath,
        name: tag.name,
      });

      if (result.success) {
        await this.loadTags();
        // The same delete from the graph's ref menu toasts (app-shell
        // handleDeleteTag). Here the row just vanished from a list that is
        // often filtered or scrolled away from the deleted row, so the only
        // signal the destructive operation ran at all was absence.
        showToast(`Deleted tag ${tag.name}`, 'success');
        this.dispatchEvent(new CustomEvent('tags-changed', {
          detail: { repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));
        // The local ref is gone; the remote copy is not, and the tag fetch
        // refspec would restore it. Asked here, inside the claim, so the
        // follow-up push is serialized with the rest of this repo's ref ops.
        await offerRemoteTagDelete(repoPath, tag.name);
      } else {
        console.error('Failed to delete tag:', result.error);
        showToast(`Failed to delete tag: ${result.error?.message ?? 'Unknown error'}`, 'error');
      }
    } finally {
      this.releaseOperation(lockedRepo);
    }
  }

  private handleTagClick(tag: Tag): void {
    this.dispatchEvent(new CustomEvent('tag-selected', {
      detail: { tag },
      bubbles: true,
      composed: true,
    }));
  }

  private handleCreateTagFromContext(): void {
    const tag = this.contextMenu.tag;
    this.contextMenu = { ...this.contextMenu, visible: false };
    // Ask app-shell to open THE create-tag dialog, aimed at the selected tag's
    // target. This list used to mount a second instance of its own: with two
    // copies alive, each `open()`'s "already open, don't wipe the input" guard
    // only knew about itself, so opening from here and then from the palette
    // stacked two dialogs with different pinned targets over each other.
    this.dispatchEvent(new CustomEvent('create-tag', {
      bubbles: true,
      composed: true,
      detail: { targetRef: tag?.targetOid },
    }));
  }

  /**
   * Push the right-clicked tag.
   *
   * `remote` is the destination the user picked in the menu. When it is
   * undefined the destination is resolved up front via `get_push_remote`, so
   * the success toast and the force-push retry can both name where the tag
   * actually went.
   */
  private async handlePushTag(remote?: string): Promise<void> {
    const tag = this.contextMenu.tag;
    if (!tag) return;

    let destination = remote;
    // The menu opened and was clicked before its remote read landed. Pushing
    // now would leave the destination to the backend resolver — on a fork
    // checkout that is `origin`, and the picker the menu was about to render
    // would never be offered. Wait for the answer instead.
    // Captured as a boolean so the check below does not narrow the field: it
    // is re-read after the await, and the narrowing would survive it.
    const destinationUnknown = this.remotes === null;
    if (destination === undefined && destinationUnknown && this.remotesLoad) {
      await this.remotesLoad;
      // Dismissed, or moved to another tag, while waiting.
      if (!this.contextMenu.visible || this.contextMenu.tag !== tag) return;
      if ((this.remotes?.length ?? 0) > 1) {
        // Ask, exactly as a click landing after the read would have.
        this.pushRemotesExpanded = true;
        return;
      }
      if (this.remotes?.length === 1) destination = this.remotes[0].name;
    }

    // A repo with no remote cannot push a tag anywhere. The backend's answer —
    // "Remote not found: origin" — names a remote the user never configured,
    // which reads as a bug rather than as missing setup.
    if (destination === undefined && this.remotes?.length === 0) {
      this.contextMenu = { ...this.contextMenu, visible: false };
      showToast('No remotes configured. Add a remote before pushing tags.', 'error');
      return;
    }
    const lockedRepo = this.repositoryPath;
    if (!this.claimOperation(lockedRepo)) return;

    // Also the shared tag-push key. Force Push Tag — reachable from the
    // rejected-push suggestion toast — holds this across its "moves the remote
    // tag" confirm and takes no working-tree claim, so without it a click here
    // pushed the same tag out from under the force push being authorised.
    const tagKey = pushTagKey(lockedRepo, tag.name);
    if (!tryAcquirePush(tagKey)) {
      this.releaseOperation(lockedRepo);
      warnRepositoryBusy();
      return;
    }

    this.contextMenu = { ...this.contextMenu, visible: false };

    // Captured BEFORE the push await: the push and its refresh must pin to the
    // repo it was invoked on, even if the user switches tabs during the (often
    // slow) network push, which rebinds this.repositoryPath.
    const repoPath = this.repositoryPath;
    try {
      if (!destination) {
        const remoteResult = await gitService.getPushRemote(repoPath);
        if (!remoteResult.success || !remoteResult.data) {
          showToast(
            `Could not determine the tag destination: ${remoteResult.error?.message ?? 'Unknown error'}`,
            'error',
          );
          return;
        }
        destination = remoteResult.data;
      }
      const result = await gitService.pushTag({
        path: repoPath,
        name: tag.name,
        // Always explicit: the destination was resolved above, so the toast,
        // the force retry and git.service's allowlist/token lookups all key off
        // the same remote.
        remote: destination,
      });

      if (result.success) {
        await this.loadTags();
        showToast(
          `Pushed tag ${tag.name} to ${destination}`,
          'success',
        );
        this.dispatchEvent(new CustomEvent('tags-changed', {
          detail: { repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));
      } else if (!gitService.isNetworkGateRefusal(result.error)) {
        console.error('Failed to push tag:', result.error);
        // Same routing the graph's push-tag gesture gets — this was the last
        // push surface still building a raw toast.
        showErrorWithSuggestion(result.error?.message ?? '', 'Failed to push tag', {
          operation: 'push-tag',
          // The Force Push Tag action needs the tag name; without it the
          // suggestion renders a button that dispatches an undefined target.
          branchName: tag.name,
          repoPath,
          // And the destination: a force retry that re-resolved it would move
          // the tag on a remote the user never aimed at.
          remote: destination,
        });
      }
    } finally {
      releasePush(tagKey);
      this.releaseOperation(lockedRepo);
    }
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

  private toggleSortMenu(e: Event): void {
    e.stopPropagation();
    this.showSortMenu = !this.showSortMenu;
  }

  private setSortMode(mode: TagSortMode): void {
    this.sortMode = mode;
    this.showSortMenu = false;
  }

  private toggleGroupCollapse(groupName: string): void {
    if (this.collapsedGroups.has(groupName)) {
      this.collapsedGroups.delete(groupName);
    } else {
      this.collapsedGroups.add(groupName);
    }
    this.requestUpdate();
  }

  private togglePushRemotes = (): void => {
    this.pushRemotesExpanded = !this.pushRemotesExpanded;
  };

  /**
   * The Push item, and the remote picker it expands into.
   *
   * One remote: name it, so the item says where the tag goes. Several: ask,
   * because silently picking one is how a fork's tag ends up on the canonical
   * repo. Unknown (not loaded yet, or the read failed): the backend resolves
   * the destination, exactly as before.
   */
  private renderPushMenuItems() {
    const remotes = this.remotes;
    const busy = this.operationInProgress || this.tagPushInFlight;
    const sole = remotes?.length === 1 ? remotes[0].name : undefined;
    const many = (remotes?.length ?? 0) > 1;

    return html`
      <button
        class="context-menu-item"
        role="menuitem"
        aria-expanded=${many ? String(this.pushRemotesExpanded) : nothing}
        ?disabled=${busy}
        @click=${many ? this.togglePushRemotes : (): void => void this.handlePushTag(sole)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <line x1="12" y1="19" x2="12" y2="5"></line>
          <polyline points="5 12 12 5 19 12"></polyline>
        </svg>
        ${sole ? `Push to ${sole}` : 'Push to Remote'}
      </button>
      ${many && this.pushRemotesExpanded
        ? remotes!.map(
            (r) => html`
              <button
                class="context-menu-item push-remote-item"
                role="menuitem"
                ?disabled=${busy}
                @click=${(): void => void this.handlePushTag(r.name)}
              >
                ${r.name}
              </button>
            `
          )
        : nothing}
    `;
  }

  private renderContextMenu() {
    if (!this.contextMenu.visible || !this.contextMenu.tag) return nothing;

    return html`
      <div
        class="context-menu"
        role="menu"
        aria-label="Tag actions"
        style="left: ${this.contextMenu.x}px; top: ${this.contextMenu.y}px;"
        @click=${(e: Event) => e.stopPropagation()}
        @keydown=${(e: KeyboardEvent) => this.handleContextMenuKeydown(e)}
      >
        <button class="context-menu-item" role="menuitem" ?disabled=${this.operationInProgress} @click=${this.handleCheckoutTag}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          Checkout
        </button>
        <button class="context-menu-item" role="menuitem" @click=${this.handleCreateTagFromContext}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"></path>
            <line x1="7" y1="7" x2="7.01" y2="7"></line>
            <line x1="12" y1="8" x2="12" y2="14"></line>
            <line x1="9" y1="11" x2="15" y2="11"></line>
          </svg>
          Create Tag Here
        </button>
        ${this.renderPushMenuItems()}
        <div class="context-menu-divider" role="separator" style="height: 1px; background: var(--color-border); margin: var(--spacing-xs) 0;"></div>
        <button class="context-menu-item danger" role="menuitem" ?disabled=${this.operationInProgress} @click=${this.handleDeleteTag}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path>
          </svg>
          Delete
        </button>
      </div>
    `;
  }

  private renderTagItem(tag: Tag) {
    return html`
      <li
        class="tag-item"
        role="listitem"
        tabindex="0"
        @click=${() => this.handleTagClick(tag)}
        @contextmenu=${(e: MouseEvent) => this.handleContextMenu(e, tag)}
        @keydown=${(e: KeyboardEvent) => this.handleTagItemKeydown(e, tag)}
        title="${tag.message || tag.name}"
      >
        <svg class="tag-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"></path>
          <line x1="7" y1="7" x2="7.01" y2="7"></line>
        </svg>
        <div class="tag-info">
          <div class="tag-name">${tag.name}</div>
          <div class="tag-type">${tag.isAnnotated ? 'annotated' : 'lightweight'}</div>
        </div>
      </li>
    `;
  }

  private renderControls() {
    return html`
      <div class="controls" style="position: relative;">
        <button
          class="controls-btn ${this.showFilter ? 'active' : ''}"
          title="Filter tags"
          aria-label="Filter tags"
          @click=${this.toggleFilter}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
        </button>
        <button
          class="controls-btn ${this.showSortMenu ? 'active' : ''}"
          title="Sort tags"
          aria-label="Sort tags"
          @click=${(e: Event) => this.toggleSortMenu(e)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="4" y1="6" x2="20" y2="6"></line>
            <line x1="4" y1="12" x2="16" y2="12"></line>
            <line x1="4" y1="18" x2="12" y2="18"></line>
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
            placeholder="Filter tags..."
            aria-label="Filter tags"
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
    // Single stable outer template: the create-tag dialog must live at ONE
    // template position, or an open dialog would be destroyed (losing its
    // pinned repo, in-progress input, and open modal) when the tag list flips
    // empty<->non-empty (e.g. a watcher refresh after an external `git tag`).
    // Lit re-clones a subtree when the enclosing template literal changes, so
    // the varying content goes through renderBody() while the dialog stays put.
    return html`
      ${this.renderBody()}
      ${this.renderContextMenu()}
    `;
  }

  private renderBody() {
    if (this.loading) {
      return html`<div class="loading">Loading tags...</div>`;
    }

    // Before the empty check: "No tags" over a repo whose tag load failed is a
    // lie the user would act on (and the previous repo's rows would be worse).
    if (this.error) {
      return html`<div class="error" role="alert">${this.error}</div>`;
    }

    if (this.tags.length === 0) {
      return html`
        ${this.renderControls()}
        <div class="empty">No tags</div>
      `;
    }

    const filtered = this.filterTags(this.tags);
    const sorted = this.sortTags(filtered);
    const groups = this.groupTags(sorted);

    return html`
      ${this.renderControls()}

      ${filtered.length === 0
        ? html`<div class="empty">No matching tags</div>`
        : groups.length === 1 && groups[0].name === ''
          ? html`
              <ul class="tag-list" role="list">
                ${groups[0].tags.map((tag) => this.renderTagItem(tag))}
              </ul>
            `
          : groups.map((group) => {
              const collapsed = this.collapsedGroups.has(group.name);
              return html`
                <div class="group-header"
                  role="button"
                  tabindex="0"
                  aria-expanded=${!collapsed}
                  aria-label="${group.name} tags group, ${group.tags.length} tags"
                  @click=${() => this.toggleGroupCollapse(group.name)}
                  @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggleGroupCollapse(group.name); } }}
                >
                  <svg class="chevron ${collapsed ? '' : 'expanded'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <polyline points="9 18 15 12 9 6"></polyline>
                  </svg>
                  <span class="group-name">${group.name}</span>
                  <span class="group-count">${group.tags.length}</span>
                </div>
                ${!collapsed ? html`
                  <ul class="tag-list" role="list">
                    ${group.tags.map((tag) => this.renderTagItem(tag))}
                  </ul>
                ` : nothing}
              `;
            })}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-tag-list': GnTagList;
  }
}
