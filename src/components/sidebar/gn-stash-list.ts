/**
 * Stash List Component
 * Displays and manages stash entries
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showConfirm, showPrompt } from '../../services/dialog.service.ts';
import { showToast } from '../../services/notification.service.ts';
import type { Stash, StashShowResult } from '../../types/git.types.ts';
import { isTopOverlay } from '../../utils/overlay-stack.ts';
import {
  tryAcquireRefOpOrWarn,
  releaseRefOp,
  isRefOpRunning,
  subscribeRefOps,
} from '../../utils/ref-lock.ts';

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  stash: Stash | null;
}

@customElement('gn-stash-list')
export class GnStashList extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .stash-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      /* Full-bleed row inside a scrolling list: draw the shared keyboard
         focus ring inside the row so the scroll container cannot clip it. */
      .stash-item {
        --gn-focus-ring-offset: -2px;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 12px;
        cursor: pointer;
        font-size: var(--font-size-sm);
      }

      .stash-item:hover {
        background: var(--color-bg-hover);
      }

      .stash-icon {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        color: var(--color-text-muted);
      }

      .stash-info {
        flex: 1;
        min-width: 0;
      }

      .stash-message {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .stash-index {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .stash-chevron {
        width: 12px;
        height: 12px;
        flex-shrink: 0;
        color: var(--color-text-muted);
        transition: transform 0.15s ease;
      }

      .stash-chevron.expanded {
        transform: rotate(90deg);
      }

      .stash-details {
        padding: 2px 12px 6px 32px;
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .stash-details-status {
        color: var(--color-text-muted);
      }

      .stash-details-error {
        color: var(--color-error);
        overflow-wrap: anywhere;
      }

      .stash-details-total {
        display: flex;
        gap: var(--spacing-sm);
        padding-bottom: 2px;
        color: var(--color-text-muted);
        font-family: var(--font-family-mono);
      }

      .stash-details-total .additions {
        color: var(--color-success);
      }

      .stash-details-total .deletions {
        color: var(--color-error);
      }

      .stash-file {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .stash-file-status {
        width: 1em;
        flex-shrink: 0;
        text-align: center;
        color: var(--color-text-muted);
        font-family: var(--font-family-mono);
      }

      .stash-file-path {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--font-family-mono);
      }

      .stash-file-stats {
        display: flex;
        flex-shrink: 0;
        gap: 6px;
        font-family: var(--font-family-mono);
      }

      .stash-file-stats .additions {
        color: var(--color-success);
      }

      .stash-file-stats .deletions {
        color: var(--color-error);
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

      .stash-actions {
        display: flex;
        justify-content: center;
        padding: 4px 12px 6px;
      }

      .stash-btn {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 4px 8px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        font-family: inherit;
        font-size: var(--font-size-sm);
        cursor: pointer;
      }

      .stash-btn:hover:not(:disabled) {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .stash-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }

      .stash-btn svg {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
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

      .context-menu-item:hover:not(:disabled) {
        background: var(--color-bg-hover);
      }

      .context-menu-item:disabled {
        opacity: 0.5;
        cursor: not-allowed;
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
    `,
  ];

  @property({ type: String }) repositoryPath: string = '';

  @state() private stashes: Stash[] = [];
  @state() private loading = true;
  @state() private isStashing = false;
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

  @state() private contextMenu: ContextMenuState = { visible: false, x: 0, y: 0, stash: null };

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
    // Conflicted applies/pops complete inside the shared conflict dialog
    // (which drops the stash there), so reload when the app-level refresh
    // fires — otherwise the dropped entry stays listed.
    window.addEventListener('repository-refresh', this.handleRepositoryRefresh);
    await this.loadStashes();
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
    void this.loadStashes();
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

  private handleStashItemKeydown(e: KeyboardEvent, stash: Stash): void {
    // Enter/Space must do what a click does. The context menu keeps a keyboard
    // route through the platform-standard keys rather than losing one.
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void this.handleToggleDetails(stash);
      return;
    }
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      this.handleContextMenu(
        new MouseEvent('contextmenu', { clientX: 0, clientY: 0 }),
        stash,
      );
    }
  }

  async updated(changedProperties: Map<string, unknown>): Promise<void> {
    if (changedProperties.has('repositoryPath') && this.repositoryPath) {
      // A menu entry acts on the stash it was opened over, but resolves the
      // repo from `this.repositoryPath` at click time — and a keyboard tab
      // switch produces neither a document click nor Escape, so the menu would
      // survive the rebind and drop repo A's stash inside repo B.
      this.contextMenu = { ...this.contextMenu, visible: false };
      // A preview belongs to the repo it was opened in.
      this.collapseDetails();
      await this.loadStashes();
    }
  }

  public async refresh(): Promise<void> {
    await this.loadStashes();
  }

  /**
   * Per-path load generation. gn-left-panel keeps ONE instance of this element
   * across tabs and only rebinds `.repositoryPath`, and Lit does not await an
   * async `updated()` — so Ctrl+Tab twice quickly (A→B→A) starts overlapping
   * loads with nothing sequencing them, and whichever resolved last won.
   * Repo B's stashes rendering under repo A's tab is not cosmetic: the rows
   * are what Apply/Pop/Drop act on. Same shape as
   * gn-branch-list.branchesLoadSeq and gn-file-status.statusLoadSeq.
   */
  private stashesLoadSeq = new Map<string, number>();

  /**
   * The load for the CURRENT repo failed. Rendered, because the alternative —
   * leaving the previous repo's rows on screen — is indistinguishable from
   * real data and invites a Drop against a stash the user is not looking at.
   */
  @state() private error: string | null = null;

  /**
   * The stash whose contents are expanded inline, keyed by OID.
   *
   * Not by index: `Stash.index` is a position that shifts whenever an entry is
   * added or dropped (see resolveStashIndex), so an index key would follow the
   * wrong row after any list change.
   */
  @state() private expandedOid: string | null = null;
  @state() private stashDetails: StashShowResult | null = null;
  @state() private detailsLoading = false;
  @state() private detailsError: string | null = null;

  private async loadStashes(): Promise<void> {
    if (!this.repositoryPath) return;

    // Captured before the await so a mid-flight tab switch still resolves this
    // result against the repo it was loaded FROM.
    const loadedPath = this.repositoryPath;
    const seq = (this.stashesLoadSeq.get(loadedPath) ?? 0) + 1;
    this.stashesLoadSeq.set(loadedPath, seq);
    /** Latest load for this path AND this path is still the bound one. */
    const isFresh = (): boolean =>
      this.stashesLoadSeq.get(loadedPath) === seq && this.repositoryPath === loadedPath;

    this.loading = true;

    try {
      const result = await gitService.getStashes(loadedPath);
      // A superseded load must touch NOTHING: not the rows, not the count
      // badge, not the loading flag the live load owns.
      if (!isFresh()) return;

      if (result.success) {
        this.error = null;
        this.stashes = result.data!;
        // The expanded row may have been dropped or popped (here or from a
        // terminal); a preview with no row above it is orphaned UI.
        if (this.expandedOid && !this.stashes.some(s => s.oid === this.expandedOid)) {
          this.collapseDetails();
        }
        // Emit count changed event
        this.dispatchEvent(new CustomEvent('stash-count-changed', {
          detail: { count: this.stashes.length },
          bubbles: true,
          composed: true,
        }));
      } else {
        this.error = result.error?.message || 'Failed to load stashes';
        this.stashes = [];
        this.collapseDetails();
        this.dispatchEvent(new CustomEvent('stash-count-changed', {
          detail: { count: 0 },
          bubbles: true,
          composed: true,
        }));
        showToast(this.error, 'error');
      }
    } catch (err) {
      console.error('Failed to load stashes:', err);
      if (isFresh()) {
        this.error = err instanceof Error ? err.message : 'Failed to load stashes';
        this.stashes = [];
        this.collapseDetails();
        this.dispatchEvent(new CustomEvent('stash-count-changed', {
          detail: { count: 0 },
          bubbles: true,
          composed: true,
        }));
        showToast('Failed to load stashes', 'error');
      }
    } finally {
      if (isFresh()) {
        this.loading = false;
      }
    }
  }

  private async handleCreateStash(): Promise<void> {
    if (this.isStashing || !this.repositoryPath) return;

    const repoPath = this.repositoryPath;
    // The SHARED lock, like every sibling handler here. `git stash push` resets
    // the working tree to HEAD and prepends to the stash list, renumbering
    // every entry — the same mutation app-shell wraps in runRefExclusive for
    // the keyboard shortcut. `isStashing` alone only ever guarded this one
    // component.
    if (!this.claimOperation(repoPath)) return;

    // Claimed BEFORE this prompt, like gn-branch-list's rename: showPrompt is
    // an await, and a claim taken after it does not serialize a double-click.
    // repoPath is already pinned above — showPrompt is an in-app Lit overlay,
    // NOT a native modal, so the window stays interactive and the user can
    // switch repo tabs while it is open.
    //
    // Without a message every stash git2 creates falls back to
    // "WIP on <branch>: <sha> <subject>", which describes the commit the stash
    // was based on and not the stashed work — three stashes on one branch were
    // indistinguishable before a destructive Pop/Drop.
    const message = await showPrompt(
      'Stash Changes',
      'Message for this stash (optional):',
      '',
      'WIP'
    );
    // null is a dismissal; '' is "OK with nothing typed" and must still stash,
    // keeping git's default "WIP on <branch>" name.
    if (message === null) {
      this.releaseOperation(repoPath);
      return;
    }
    const stashMessage = message.trim();

    this.isStashing = true;

    try {
      const result = await gitService.createStash({
        path: repoPath,
        // Undefined, not '': the backend only falls back to git's WIP name when
        // no message is sent (src-tauri/src/commands/stash.rs).
        message: stashMessage || undefined,
        includeUntracked: true,
      });

      if (result.success) {
        if (result.data === null) {
          // Clean working tree: nothing to stash — informational, not an error.
          showToast('No local changes to save', 'info');
          return;
        }
        // The shortcut and the palette both toast "Stash created"; this
        // surface reloaded the list and said nothing, so the same operation
        // reported differently depending on where it was started.
        showToast('Stash created', 'success');
        await this.loadStashes();
        this.dispatchEvent(new CustomEvent('stash-created', {
          detail: { repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));
      } else {
        console.error('Failed to create stash:', result.error);
        showToast(result.error?.message ?? 'Failed to create stash', 'error');
      }
    } catch (err) {
      console.error('Failed to create stash:', err);
      showToast('Failed to create stash', 'error');
    } finally {
      this.isStashing = false;
      this.releaseOperation(repoPath);
    }
  }

  private handleContextMenu(e: MouseEvent, stash: Stash): void {
    e.preventDefault();
    e.stopPropagation();

    this.contextMenu = {
      visible: true,
      x: e.clientX,
      y: e.clientY,
      stash,
    };
  }

  /**
   * Re-resolve a stash captured at context-menu time to its CURRENT index in
   * `repoPath`'s stash list.
   *
   * `Stash.index` is a POSITION, not an identity: creating or dropping any
   * stash shifts every entry below it. The context menu caches the Stash object
   * from when it opened and survives list reloads — `repository-refresh`
   * reloads the list without closing the menu (handleRepositoryRefresh), and
   * only Escape or a click dismisses it — so the cached index can name a
   * different stash by the time the user clicks an action, or by the time a
   * confirm is dismissed. Match on `oid`, which is stable.
   *
   * Reads the list from `repoPath` rather than `this.stashes`: the caller pins
   * repoPath before its confirm, and on a mid-confirm tab switch `this.stashes`
   * holds the OTHER repo's entries — resolving against it would produce an
   * index into the wrong list.
   *
   * Returns the live index, or null if the caller must abort (already toasted).
   */
  private async resolveStashIndex(
    repoPath: string,
    stash: Stash,
    action: 'applied' | 'popped' | 'dropped' | 'shown'
  ): Promise<number | null> {
    const result = await gitService.getStashes(repoPath);

    if (!result.success || !result.data) {
      showToast(
        result.error?.message ?? `Could not read the stash list — nothing was ${action}`,
        'error'
      );
      return null;
    }

    const index = result.data.findIndex(s => s.oid === stash.oid);

    if (index < 0) {
      showToast(
        `"${stash.message}" is no longer in the stash list — nothing was ${action}`,
        'warning'
      );
      await this.loadStashes();
      return null;
    }

    return index;
  }

  /**
   * Toggle the inline contents preview for a stash — `git stash show`'s
   * diffstat, in the panel.
   *
   * Apply, Pop and Drop all act on content the user could not see: Drop
   * irreversibly, Pop asking them to accept conflicts sight unseen. Applying a
   * stash just to find out what was in it was the only way to look.
   *
   * Read-only, so it deliberately does NOT claim the working-tree lock — there
   * is nothing to serialize, and inspecting a stash while another operation
   * runs is exactly when it is most useful.
   */
  private async handleToggleDetails(stash: Stash): Promise<void> {
    if (this.expandedOid === stash.oid) {
      this.collapseDetails();
      return;
    }

    this.expandedOid = stash.oid;
    this.stashDetails = null;
    this.detailsError = null;
    this.detailsLoading = true;

    // Captured before the await, like every handler here: the prop rebinds on a
    // tab switch, and a result resolved against another repo would describe a
    // different stash entirely.
    const repoPath = this.repositoryPath;
    /** Still the same repo AND still the row the user opened. */
    const isFresh = (): boolean =>
      this.repositoryPath === repoPath && this.expandedOid === stash.oid;

    try {
      // By oid, for the same reason the action handlers do it: the cached row
      // can name a different stash by now, and previewing the WRONG entry
      // before a Drop is worse than previewing nothing.
      const index = await this.resolveStashIndex(repoPath, stash, 'shown');
      if (!isFresh()) return;
      if (index === null) {
        // resolveStashIndex already toasted and reloaded the list.
        this.collapseDetails();
        return;
      }

      const result = await gitService.stashShow({
        path: repoPath,
        index,
        stat: true,
        patch: false,
      });
      if (!isFresh()) return;

      if (result.success && result.data) {
        // The index was live when resolveStashIndex read it, but stash_show is
        // a SECOND round trip: a create or drop in between (this panel's own
        // Stash button, another window, a terminal) renumbers the list, and the
        // index we asked for can now name a different entry. Rendering that as
        // this row's contents is the exact failure the preview exists to
        // prevent — someone Dropping a stash after reading another one's diff.
        if (result.data.oid !== stash.oid) {
          // Toast, not this.detailsError: the usual cause of a renumber is a
          // drop, and if the dropped entry was OURS the reload below collapses
          // this preview — taking an inline error with it and leaving the row
          // to just silently close. Same channel the other staleness paths use.
          showToast(
            `"${stash.message}" moved in the stash list while it was being read — open it again`,
            'warning'
          );
          this.collapseDetails();
          void this.loadStashes();
          return;
        }
        this.stashDetails = result.data;
      } else {
        this.detailsError = result.error?.message ?? 'Failed to read stash contents';
      }
    } catch (err) {
      console.error('Failed to read stash contents:', err);
      if (isFresh()) {
        this.detailsError = err instanceof Error ? err.message : 'Failed to read stash contents';
      }
    } finally {
      if (isFresh()) {
        this.detailsLoading = false;
      }
    }
  }

  private collapseDetails(): void {
    this.expandedOid = null;
    this.stashDetails = null;
    this.detailsError = null;
    this.detailsLoading = false;
  }

  /** Open (never toggle) the preview — the context-menu entry point. */
  private handleShowContents(): void {
    const stash = this.contextMenu.stash;
    if (!stash) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    if (this.expandedOid !== stash.oid) {
      void this.handleToggleDetails(stash);
    }
  }

  /** `git status`-style single-letter label for a stash_show delta status. */
  private stashFileStatusLabel(status: string): string {
    switch (status) {
      case 'added':
        return 'A';
      case 'deleted':
        return 'D';
      case 'renamed':
        return 'R';
      case 'copied':
        return 'C';
      case 'typechange':
        return 'T';
      default:
        return 'M';
    }
  }

  private async handleApplyStash(): Promise<void> {
    const stash = this.contextMenu.stash;
    if (!stash) return;
    const lockedRepo = this.repositoryPath;
    if (!this.claimOperation(lockedRepo)) return;

    this.contextMenu = { ...this.contextMenu, visible: false };

    // Captured BEFORE the await: the conflict event must carry the repo the
    // apply actually ran on, even if the prop is rebound mid-flight.
    const repoPath = this.repositoryPath;
    try {
      const index = await this.resolveStashIndex(repoPath, stash, 'applied');
      if (index === null) return;

      const result = await gitService.applyStash({
        path: repoPath,
        index,
        dropAfter: false,
      });

      if (result.success) {
        // Reports itself, like Create and like branch/tag delete. The only
        // signal these ran at all was a row changing or vanishing.
        showToast('Stash applied', 'success');
        await this.loadStashes();
        this.dispatchEvent(new CustomEvent('stash-applied', {
          detail: { repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));
      } else {
        console.error('Failed to apply stash:', result.error);
        // A conflict is not a failure: the stash content DID land in the
        // working tree and the resolution dialog is about to open. A red
        // "Merge conflict" beside it reads as "nothing happened" — the same
        // reason pull, the dashboard and every auto-stash path warn instead.
        if (this.isConflictError(result.error)) {
          showToast('Stash applied — conflicts need resolution', 'warning');
        } else {
          showToast(result.error?.message ?? 'Failed to apply stash', 'error');
        }
        // A conflicting apply left the changes in the working tree; open the
        // conflict resolution dialog. The stash was NOT dropped (apply, not pop),
        // so completion must keep it.
        if (this.isConflictError(result.error)) {
          this.dispatchEvent(new CustomEvent('open-conflict-dialog', {
            bubbles: true,
            composed: true,
            detail: {
              operationType: 'stash',
              // The oid, not just the position: the dialog's identity capture
              // is an async round trip, and a stash pushed in the meantime —
              // from a terminal, or Ctrl+Shift+S — prepends and renumbers the
              // list, so Complete would drop the wrong entry. Same threading
              // the auto-stash dispatchers already do.
              stashOid: stash.oid,
              stashIndex: index,
              dropStashOnComplete: false,
              repositoryPath: repoPath,
            },
          }));
        }
      }
    } finally {
      this.releaseOperation(lockedRepo);
    }
  }

  /** True when a stash apply/pop error indicates a merge conflict. */
  private isConflictError(error: { code?: string; message?: string } | undefined): boolean {
    if (!error) return false;
    // Prefer the structured error code; keep the message match as a fallback.
    if (error.code === 'MERGE_CONFLICT') return true;
    return !!error.message && error.message.toLowerCase().includes('conflict');
  }

  private async handlePopStash(): Promise<void> {
    const stash = this.contextMenu.stash;
    if (!stash) return;
    const lockedRepo = this.repositoryPath;
    if (!this.claimOperation(lockedRepo)) return;

    this.contextMenu = { ...this.contextMenu, visible: false };

    // Captured BEFORE the confirm await: stash.index is from THIS repo's list,
    // so the pop must run on this repo even if the user switches tabs while the
    // confirm is up — applying stash.index against another repo pops the wrong
    // stash.
    const repoPath = this.repositoryPath;
    const confirmed = await showConfirm(
      'Pop Stash',
      `This will apply the stash "${stash.message}" and remove it from the stash list. Any conflicts will need to be resolved manually. Continue?`,
      'warning'
    );
    if (!confirmed) {
      this.releaseOperation(lockedRepo);
      return;
    }


    try {
      const index = await this.resolveStashIndex(repoPath, stash, 'popped');
      if (index === null) return;

      const result = await gitService.popStash({
        path: repoPath,
        index,
      });

      if (result.success) {
        // Reports itself, like Create and like branch/tag delete. The only
        // signal these ran at all was a row changing or vanishing.
        showToast('Stash popped', 'success');
        await this.loadStashes();
        this.dispatchEvent(new CustomEvent('stash-applied', {
          detail: { repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));
      } else {
        console.error('Failed to pop stash:', result.error);
        // A conflict is not a failure: the stash content DID land in the
        // working tree and the resolution dialog is about to open. A red
        // "Merge conflict" beside it reads as "nothing happened" — the same
        // reason pull, the dashboard and every auto-stash path warn instead.
        if (this.isConflictError(result.error)) {
          showToast('Stash popped — conflicts need resolution', 'warning');
        } else {
          showToast(result.error?.message ?? 'Failed to pop stash', 'error');
        }
        // A conflicting pop left the changes in the working tree AND left the
        // stash entry in place. Open the conflict resolution dialog; completion
        // must drop the stash (pop semantics) once conflicts are resolved.
        if (this.isConflictError(result.error)) {
          this.dispatchEvent(new CustomEvent('open-conflict-dialog', {
            bubbles: true,
            composed: true,
            detail: {
              operationType: 'stash',
              // The oid, not just the position: the dialog's identity capture
              // is an async round trip, and a stash pushed in the meantime —
              // from a terminal, or Ctrl+Shift+S — prepends and renumbers the
              // list, so Complete would drop the wrong entry. Same threading
              // the auto-stash dispatchers already do.
              stashOid: stash.oid,
              stashIndex: index,
              dropStashOnComplete: true,
              repositoryPath: repoPath,
            },
          }));
        }
      }
    } finally {
      this.releaseOperation(lockedRepo);
    }
  }

  private async handleDropStash(): Promise<void> {
    const stash = this.contextMenu.stash;
    if (!stash) return;
    const lockedRepo = this.repositoryPath;
    if (!this.claimOperation(lockedRepo)) return;

    this.contextMenu = { ...this.contextMenu, visible: false };

    // Captured BEFORE the confirm await: dropping is irreversible and stash.index
    // is from THIS repo's list, so it must target this repo even if the user
    // switches tabs while the confirm is up — otherwise a different, unrelated
    // stash is dropped in the wrong repo.
    const repoPath = this.repositoryPath;
    const confirmed = await showConfirm(
      'Drop Stash',
      `Are you sure you want to drop "${stash.message}"?\n\nThis action cannot be undone.`,
      'warning'
    );

    if (!confirmed) {
      this.releaseOperation(lockedRepo);
      return;
    }


    try {
      const index = await this.resolveStashIndex(repoPath, stash, 'dropped');
      if (index === null) return;

      const result = await gitService.dropStash({
        path: repoPath,
        index,
      });

      if (result.success) {
        // Reports itself, like Create and like branch/tag delete. The only
        // signal these ran at all was a row changing or vanishing.
        showToast('Stash dropped', 'success');
        await this.loadStashes();
        this.dispatchEvent(new CustomEvent('stash-dropped', {
          detail: { stash, repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));
      } else {
        console.error('Failed to drop stash:', result.error);
        showToast(result.error?.message ?? 'Failed to drop stash', 'error');
      }
    } finally {
      this.releaseOperation(lockedRepo);
    }
  }

  private renderStashDetails() {
    if (this.detailsLoading) {
      return html`<div class="stash-details stash-details-status">Loading contents...</div>`;
    }
    if (this.detailsError) {
      return html`<div class="stash-details stash-details-error" role="alert">${this.detailsError}</div>`;
    }
    if (!this.stashDetails) return nothing;

    const { files, totalAdditions, totalDeletions } = this.stashDetails;
    if (files.length === 0) {
      return html`<div class="stash-details stash-details-status">No file changes</div>`;
    }

    return html`
      <div class="stash-details">
        <div class="stash-details-total">
          <span>${files.length} ${files.length === 1 ? 'file' : 'files'}</span>
          <span class="additions">+${totalAdditions}</span>
          <span class="deletions">-${totalDeletions}</span>
        </div>
        ${files.map(file => html`
          <div class="stash-file" title="${file.path}">
            <span class="stash-file-status">${this.stashFileStatusLabel(file.status)}</span>
            <span class="stash-file-path">${file.path}</span>
            <span class="stash-file-stats">
              ${file.additions > 0 ? html`<span class="additions">+${file.additions}</span>` : nothing}
              ${file.deletions > 0 ? html`<span class="deletions">-${file.deletions}</span>` : nothing}
            </span>
          </div>
        `)}
      </div>
    `;
  }

  private renderContextMenu() {
    if (!this.contextMenu.visible || !this.contextMenu.stash) return nothing;

    return html`
      <div
        class="context-menu"
        role="menu"
        aria-label="Stash actions"
        style="left: ${this.contextMenu.x}px; top: ${this.contextMenu.y}px;"
        @click=${(e: Event) => e.stopPropagation()}
        @keydown=${(e: KeyboardEvent) => this.handleContextMenuKeydown(e)}
      >
        <!-- Read-only, so no ?disabled on the shared working-tree lock: this is
             exactly when the user most wants to look before acting. -->
        <button class="context-menu-item" role="menuitem" @click=${this.handleShowContents}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
          Show Contents
        </button>
        <div class="context-menu-divider" role="separator"></div>
        <button class="context-menu-item" role="menuitem" ?disabled=${this.operationInProgress} @click=${this.handleApplyStash}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          Apply
        </button>
        <button class="context-menu-item" role="menuitem" ?disabled=${this.operationInProgress} @click=${this.handlePopStash}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 3v18"></path>
            <path d="M5 8l7-7 7 7"></path>
          </svg>
          Pop
        </button>
        <div class="context-menu-divider" role="separator"></div>
        <button class="context-menu-item danger" role="menuitem" ?disabled=${this.operationInProgress} @click=${this.handleDropStash}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path>
          </svg>
          Drop
        </button>
      </div>
    `;
  }

  render() {
    return html`
      ${this.loading
        ? html`<div class="loading">Loading stashes...</div>`
        : this.error
          ? html`<div class="error" role="alert">${this.error}</div>`
          : this.stashes.length === 0
          ? html`<div class="empty">No stashes</div>`
          : html`
              <ul class="stash-list" role="list">
                ${this.stashes.map((stash) => html`
                  <!-- title is the full message: .stash-message is ellipsized,
                       and since stashes can be named this is the only way to
                       read a truncated one. The chevron and aria-expanded
                       already say the row opens. -->
                  <li
                    class="stash-item"
                    role="listitem"
                    tabindex="0"
                    aria-label="Stash: ${stash.message}"
                    aria-expanded=${this.expandedOid === stash.oid ? 'true' : 'false'}
                    title=${stash.message}
                    @click=${() => this.handleToggleDetails(stash)}
                    @contextmenu=${(e: MouseEvent) => this.handleContextMenu(e, stash)}
                    @keydown=${(e: KeyboardEvent) => this.handleStashItemKeydown(e, stash)}
                  >
                    <svg class="stash-chevron ${this.expandedOid === stash.oid ? 'expanded' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                      <polyline points="9 18 15 12 9 6"></polyline>
                    </svg>
                    <svg class="stash-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                      <rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect>
                      <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"></path>
                    </svg>
                    <div class="stash-info">
                      <div class="stash-message">${stash.message}</div>
                      <div class="stash-index">stash@{${stash.index}}</div>
                    </div>
                  </li>
                  <!-- A SIBLING row, not nested: nesting would bubble clicks
                       inside the preview back to the row handler and collapse
                       it, and would change .stash-item subtree matching.
                       role="presentation" keeps it out of the list's a11y
                       semantics so expanding a stash does not change the
                       announced item count (and an empty transient row is not
                       announced at all); its .stash-details children stay
                       exposed. -->
                  ${this.expandedOid === stash.oid
                    ? html`<li class="stash-details-row" role="presentation">${this.renderStashDetails()}</li>`
                    : nothing}
                `)}
              </ul>
            `}

      ${this.loading
        ? nothing
        : html`
            <div class="stash-actions">
              <button
                class="stash-btn"
                title="Save your uncommitted changes to a new stash"
                ?disabled=${this.isStashing || this.operationInProgress}
                @click=${this.handleCreateStash}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect>
                  <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"></path>
                </svg>
                ${this.isStashing ? 'Stashing...' : 'Stash Changes'}
              </button>
            </div>
          `}

      ${this.renderContextMenu()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-stash-list': GnStashList;
  }
}
