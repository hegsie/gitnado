/**
 * Reflog Browser Dialog
 * Shows reflog entries and allows undo operations
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import { showToast } from '../../services/notification.service.ts';
import type { ReflogEntry } from '../../types/git.types.ts';
import { pushOverlay, removeOverlay, isTopOverlay } from '../../utils/overlay-stack.ts';
import { containsDeepActiveElement } from '../../utils/focus.ts';
import {
  tryAcquireRefOp,
  releaseRefOp,
  isRefOpRunning,
  subscribeRefOps,
} from '../../utils/ref-lock.ts';

interface ReflogContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  entry: ReflogEntry | null;
}

/**
 * Entries one page of the listing asks for. HEAD reflogs routinely hold
 * hundreds of entries and this dialog is the app's recovery surface, so the
 * first page has to be followed by a way to reach the rest.
 */
const REFLOG_PAGE_SIZE = 50;

@customElement('gn-reflog-dialog')
export class GnReflogDialog extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: var(--z-modal, 200);
      }

      :host([open]) {
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(2px);
      }

      .dialog {
        position: relative;
        display: flex;
        flex-direction: column;
        width: 700px;
        max-width: 90vw;
        max-height: 80vh;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        overflow: hidden;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-md) var(--spacing-lg);
        border-bottom: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .header-icon {
        width: 20px;
        height: 20px;
        color: var(--color-primary);
      }

      .title {
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
      }

      .subtitle {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .close-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .close-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .close-btn svg {
        width: 16px;
        height: 16px;
      }

      .content {
        flex: 1;
        overflow-y: auto;
        padding: var(--spacing-sm);
      }

      .loading, .empty {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xl);
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }

      .entry-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .list-footer {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm);
      }

      .list-note {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .show-more-btn {
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: var(--font-size-xs);
        border-radius: var(--radius-sm);
        cursor: pointer;
        transition: all var(--transition-fast);
        border: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
        color: var(--color-text-primary);
      }

      .show-more-btn:hover:not(:disabled) {
        background: var(--color-primary);
        border-color: var(--color-primary);
        color: white;
      }

      .show-more-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }

      .entry {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-md);
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: background var(--transition-fast);
      }

      .entry:hover {
        background: var(--color-bg-hover);
      }

      .entry.selected {
        background: var(--color-bg-selected);
      }

      .entry-index {
        font-family: var(--font-mono);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        min-width: 50px;
        flex-shrink: 0;
      }

      .entry-main {
        flex: 1;
        min-width: 0;
      }

      .entry-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        margin-bottom: 2px;
      }

      .entry-oid {
        font-family: var(--font-mono);
        font-size: var(--font-size-xs);
        color: var(--color-primary);
        background: var(--color-bg-tertiary);
        padding: 2px 6px;
        border-radius: var(--radius-sm);
      }

      .entry-action {
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
        text-transform: capitalize;
      }

      .entry-message {
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .entry-meta {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        margin-top: 4px;
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .entry-actions {
        display: flex;
        gap: var(--spacing-xs);
        flex-shrink: 0;
        opacity: 0;
        transition: opacity var(--transition-fast);
      }

      .entry:hover .entry-actions {
        opacity: 1;
      }

      .reset-btn {
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: var(--font-size-xs);
        border-radius: var(--radius-sm);
        cursor: pointer;
        transition: all var(--transition-fast);
        border: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
        color: var(--color-text-primary);
      }

      .reset-btn:hover {
        background: var(--color-primary);
        border-color: var(--color-primary);
        color: white;
      }

      .reset-btn.hard {
        border-color: var(--color-error);
        color: var(--color-error);
      }

      .reset-btn.hard:hover {
        background: var(--color-error);
        color: white;
      }

      .current-badge {
        font-size: var(--font-size-xs);
        padding: 2px 6px;
        background: var(--color-success-bg);
        color: var(--color-success);
        border-radius: var(--radius-sm);
        font-weight: var(--font-weight-medium);
      }

      .help-text {
        padding: var(--spacing-sm) var(--spacing-md);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        border-top: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
      }

      .help-text strong {
        color: var(--color-text-secondary);
      }

      /* Context menu */
      .context-menu {
        position: fixed;
        z-index: var(--z-dropdown, 300);
        min-width: 180px;
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

      .context-menu-item svg {
        width: 14px;
        height: 14px;
        color: var(--color-text-muted);
      }

      .context-menu-divider {
        height: 1px;
        background: var(--color-border);
        margin: var(--spacing-xs) 0;
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: String }) repositoryPath = '';

  @state() private entries: ReflogEntry[] = [];
  @state() private loading = false;
  @state() private selectedIndex: number | null = null;
  @state() private resetting = false;

  /** Entries the CURRENT listing asked for; grows one page per "Show more". */
  @state() private entryLimit = REFLOG_PAGE_SIZE;
  @state() private loadingMore = false;

  /**
   * The OBSERVATION half of the shared lock, which this dialog was missing.
   *
   * handleReset already CLAIMS the lock and correctly refuses when another
   * surface holds it — but the Undo and Hard buttons were bound to `resetting`
   * alone, a flag that only ever tracked this dialog. So while a checkout or a
   * merge ran elsewhere, "Hard reset (discard all changes)" stayed fully
   * clickable and did nothing but raise a refusal toast: exactly the dead
   * control the rest of the lock rollout exists to eliminate. isRefOpRunning is
   * plain module state Lit cannot observe, so the subscription is what makes
   * the binding re-render on a transition.
   */
  @state() private refOpsVersion = 0;
  private unsubscribeRefOps?: () => void;

  private get repositoryBusy(): boolean {
    void this.refOpsVersion;
    return isRefOpRunning(this.pinnedRepoPath || this.repositoryPath);
  }
  @state() private contextMenu: ReflogContextMenuState = { visible: false, x: 0, y: 0, entry: null };

  private handleDocumentClick = (): void => {
    if (this.contextMenu.visible) {
      this.contextMenu = { ...this.contextMenu, visible: false };
    }
  };

  /**
   * Repo captured when the dialog opened. `repositoryPath` is live-bound to
   * the ACTIVE repository and rebinds the instant the user Ctrl+Tabs — a
   * document-level shortcut this dialog's overlay does not block. The entries
   * on screen belong to the repo that was active at open, so a reset must
   * target THAT repo: reading the live prop aimed the reset at whichever repo
   * the user had switched to, while the confirm still named the old repo's
   * commit.
   */
  private pinnedRepoPath = '';

  /**
   * Identifies the listing a reflog read belongs to, so a read that has been
   * superseded cannot write its page into a listing that no longer wants it.
   *
   * Pinning the repo was not enough: every read here re-fetches from HEAD@{0}
   * at the CURRENT limit, so two reads of the SAME repo can be in flight at
   * once — a "Show more" (100) racing the fresh 50-entry read of a reopened
   * session, or racing the refresh a failed reset fires. Whichever lands last
   * wins `entries`, while `entryLimit` keeps the other read's number; the two
   * then disagree and `hasMoreEntries` goes false on a list that is still
   * truncated, so the footer claims "Showing all 50" and withdraws Show more
   * on a reflog that demonstrably holds more. Every fetch takes a generation
   * and discards its result if a newer one has started since.
   */
  private fetchGeneration = 0;

  /** The repo this dialog is pinned to while open, or null when closed. */
  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.open ? this.pinnedRepoPath : null;
  }

  /**
   * True while the reflog reset is running. A hard reset discards uncommitted
   * work, so the host's tab-close sweep must not report "undo history closed"
   * over one that is still in flight.
   */
  public get operationInFlight(): boolean {
    return this.resetting;
  }

  async updated(changedProps: Map<string, unknown>): Promise<void> {
    // Announce/withdraw overlay ownership of Escape.
    if (changedProps.has('open')) {
      if (this.open) { pushOverlay(this); } else { removeOverlay(this); }
    }
    if (changedProps.has('open') && this.open) {
      // A prior operation may still be running against this component; its
      // completion handler will close the dialog, so do not start a fresh
      // session on top of it.
      if (this.resetting) return;
      this.pinnedRepoPath = this.repositoryPath;
      // A new session starts at the first page. loadReflog deliberately does
      // NOT reset this — it doubles as the post-failed-reset refresh, which
      // must keep whatever the user has expanded to.
      this.entryLimit = REFLOG_PAGE_SIZE;
      this.focusInitialControl();
      await this.loadReflog();
    }
  }

  /**
   * Move focus into the dialog once it is on screen.
   *
   * This dialog builds its own overlay instead of using <gn-modal>, and had no
   * focus() anywhere: opening it from the command palette left focus on
   * <body>, so Tab started at the skip link and walked the whole app
   * UNDERNEATH the backdrop before ever reaching the reflog's own controls —
   * every Enter on the way acting on a live control behind the dialog.
   *
   * The close button is the dialog's only non-destructive control (the entry
   * rows carry Undo and Hard reset), so focus starts there.
   */
  private focusInitialControl(): void {
    requestAnimationFrame(() => {
      if (!this.open) return;
      if (containsDeepActiveElement(this)) return;
      const closeBtn = this.shadowRoot?.querySelector('.close-btn') as HTMLElement | null;
      closeBtn?.focus();
    });
  }

  /**
   * get_reflog reports no total and takes no cursor — it just stops at
   * `limit` — so a full page is the only signal that older entries may exist.
   * A reflog whose length is an exact multiple of the page size therefore
   * shows one "Show more" that comes back with nothing new; the footer then
   * settles on "Showing all N". Same heuristic the graph canvas uses for its
   * commit batches.
   */
  private get hasMoreEntries(): boolean {
    return this.entries.length >= this.entryLimit;
  }

  private async loadReflog(): Promise<void> {
    if (!this.pinnedRepoPath) return;

    const gen = ++this.fetchGeneration;
    const repoPath = this.pinnedRepoPath;
    // The limit this read actually asked for. `entryLimit` can move under the
    // await (a concurrent "Show more" advances it on success), and publishing
    // a page under someone else's number is exactly what makes the footer lie.
    const requestedLimit = this.entryLimit;

    this.loading = true;
    this.entries = [];
    // This read supersedes any "Show more" still in flight, and that page's
    // own cleanup is generation-scoped so it will not run. Without clearing
    // the flag here a reopened session renders its footer button as a
    // disabled "Loading..." for a request nobody is waiting on any more.
    this.loadingMore = false;

    try {
      const result = await gitService.getReflog(repoPath, requestedLimit);
      if (gen !== this.fetchGeneration) return;
      if (result.success && result.data) {
        this.entries = result.data;
        // Keep the two halves of `hasMoreEntries` describing the SAME read.
        this.entryLimit = requestedLimit;
      } else if (!result.success) {
        showToast(`Failed to load reflog: ${result.error?.message ?? 'Unknown error'}`, 'error');
      }
    } catch (err) {
      if (gen !== this.fetchGeneration) return;
      console.error('Failed to load reflog:', err);
      showToast(
        `Failed to load reflog: ${err instanceof Error ? err.message : 'Unknown error'}`,
        'error',
      );
    } finally {
      // A superseded read must not clear the spinner the live read raised.
      if (gen === this.fetchGeneration) this.loading = false;
    }
  }

  /**
   * Pull the next page. get_reflog has no skip parameter, so this re-reads
   * from HEAD@{0} with a bigger limit and REPLACES the list rather than
   * appending — appending would duplicate every entry already on screen, and a
   * fresh read keeps entry.index consistent with what a reset is sent.
   *
   * `entries` is deliberately not cleared and `entryLimit` only advances on
   * success: a transient failure must leave the list and the control exactly
   * as they were so the user can retry.
   */
  private async loadMoreEntries(): Promise<void> {
    if (this.loading || this.loadingMore || !this.pinnedRepoPath) return;

    // Pinned like every other fetch here: the dialog may be closed and
    // reopened on another repo while this round trip is in flight, and the
    // stale page must not overwrite the fresh listing.
    const repoPath = this.pinnedRepoPath;
    const nextLimit = this.entryLimit + REFLOG_PAGE_SIZE;
    const gen = ++this.fetchGeneration;
    this.loadingMore = true;

    try {
      const result = await gitService.getReflog(repoPath, nextLimit);
      if (gen !== this.fetchGeneration) return;
      if (!this.open || this.pinnedRepoPath !== repoPath) return;
      if (result.success && result.data) {
        this.entries = result.data;
        this.entryLimit = nextLimit;
      } else if (!result.success) {
        showToast(
          `Failed to load more reflog entries: ${result.error?.message ?? 'Unknown error'}`,
          'error',
        );
      }
    } catch (err) {
      if (gen !== this.fetchGeneration) return;
      console.error('Failed to load more reflog entries:', err);
      showToast(
        `Failed to load more reflog entries: ${err instanceof Error ? err.message : 'Unknown error'}`,
        'error',
      );
    } finally {
      // A superseded page must not clear the flag the live read raised.
      if (gen === this.fetchGeneration) this.loadingMore = false;
    }
  }

  /**
   * User-initiated dismissal. Blocked while the operation is in flight:
   * closing mid-reset leaves it running with no visible surface, and when it
   * finishes its success path calls close() — yanking shut whatever session
   * the user had reopened in the meantime and discarding their new selection.
   * close() itself stays unguarded because that success path needs it.
   */
  private dismiss(): void {
    if (this.resetting) return;
    this.close();
  }

  private handleOverlayClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) {
      this.dismiss();
    }
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    // Only the topmost overlay owns Escape: every dialog listens on
    // `document`, so without this one keypress ran all of them.
    if (!this.open || !isTopOverlay(this)) return;
    if (e.key === 'Escape') {
      this.dismiss();
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this.handleKeyDown);
    document.addEventListener('click', this.handleDocumentClick);
    this.unsubscribeRefOps = subscribeRefOps(() => {
      this.refOpsVersion++;
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    removeOverlay(this);
    document.removeEventListener('keydown', this.handleKeyDown);
    document.removeEventListener('click', this.handleDocumentClick);
    this.unsubscribeRefOps?.();
    this.unsubscribeRefOps = undefined;
  }

  public close(): void {
    this.open = false;
    // Closing ends the session, so nothing still in flight for it may land:
    // without this a "Show more" left running would be free to publish its
    // page into the next session the moment that session reopens the SAME
    // repo, since `open` and `pinnedRepoPath` both match again by then.
    this.fetchGeneration++;
    // Only handleDocumentClick clears this, and Escape is not a click — so a
    // menu left open at dismissal was repainted at its old coordinates over
    // the next session's freshly loaded list, still holding the PREVIOUS
    // entry. Clicking it ran a reset the user never re-selected.
    this.contextMenu = { visible: false, x: 0, y: 0, entry: null };
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  /**
   * The ref a "checkout: moving from X to Y" entry landed on, if this entry is
   * a checkout.
   *
   * Reflog entries record HEAD movements, so a checkout entry's oid is the tip
   * of the branch that was switched TO. Resetting onto it is not "going back
   * there" — it repoints the CURRENT branch at another branch's commit.
   */
  private checkoutTarget(entry: ReflogEntry): string | null {
    if (entry.action !== 'checkout') return null;
    const match = /moving from\s+(\S+)\s+to\s+(\S+)/.exec(entry.message);
    return match ? match[2] : null;
  }

  /**
   * Switch to the branch a checkout entry moved to — what "go back to that
   * state" means for a checkout, and what `git switch -` does.
   *
   * Routing these through a reset instead moved the current branch's ref to the
   * other branch's commit, orphaning every commit past the merge base (and,
   * with Hard, overwriting the working tree with the other branch's content).
   */
  private async handleSwitchTo(entry: ReflogEntry): Promise<void> {
    const target = this.checkoutTarget(entry);
    if (!target || this.resetting) return;

    // The repo the dialog was OPENED on, like the reset path uses.
    // `repositoryPath` is live-bound to the active tab, so reading it here ran
    // the checkout against whatever repo the user switched to while the dialog
    // was up — a switch to a branch name that means something different there.
    const repoPath = this.pinnedRepoPath;
    if (!repoPath) return;

    this.resetting = true;
    if (!tryAcquireRefOp(repoPath)) {
      this.resetting = false;
      showToast('Another operation is already running in this repository.', 'warning');
      return;
    }

    try {
      const result = await gitService.checkoutWithAutoStash(repoPath, target);
      if (result.success && result.data?.success) {
        const data = result.data;
        // The switch auto-stashes, so it can land with the user's changes still
        // shelved or in conflict. Reporting a bare "Switched to X" hid that:
        // the work looked lost, with the only clue in a stash entry nobody was
        // told about. Same reporting the branch and tag lists give.
        if (data.stashed && data.stashConflict) {
          showToast(`Switched to ${target} — stash conflicts need resolution`, 'warning');
          this.dispatchEvent(
            new CustomEvent('open-conflict-dialog', {
              bubbles: true,
              composed: true,
              // Auto-stash is pop semantics: drop it once resolved. Identified
              // by oid, not position — another surface can push a stash in
              // between and renumber the list.
              detail: {
                operationType: 'stash',
                stashOid: data.stashOid ?? null,
                stashIndex: 0,
                dropStashOnComplete: true,
                repositoryPath: repoPath,
              },
            }),
          );
        } else if (data.stashed && !data.stashApplied) {
          showToast(data.message, 'warning');
        } else if (data.stashed) {
          showToast(
            data.message,
            data.message.includes('staged status was not preserved') ? 'warning' : 'info',
          );
        } else {
          showToast(`Switched to ${target}`, 'success');
        }
        // Same event the reset path emits, so the host refreshes the repo the
        // switch ran on even if the user changed tabs during the IPC await.
        this.dispatchEvent(
          new CustomEvent('undo-complete', {
            detail: { entry: null, mode: 'checkout', repositoryPath: repoPath },
            bubbles: true,
            composed: true,
          }),
        );
        this.close();
      } else {
        showToast(
          result.error?.message ?? result.data?.message ?? `Failed to switch to ${target}`,
          'error',
        );
      }
    } catch (err) {
      showToast(
        `Failed to switch to ${target}: ${err instanceof Error ? err.message : 'Unknown error'}`,
        'error',
      );
    } finally {
      this.resetting = false;
      releaseRefOp(repoPath);
    }
  }

  private async handleReset(entry: ReflogEntry, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    if (this.resetting) return;
    // Claimed BEFORE the confirm, not after. Unlike the context-menu surfaces —
    // which close their menu synchronously and so cannot be clicked twice — the
    // reflog rows stay on screen through the confirm, and showConfirm is an IPC
    // round trip before the native dialog takes focus. A double-click stacked
    // two reset prompts, and a hard reset run twice discards uncommitted work
    // against a branch that has already moved.
    this.resetting = true;

    // The repo the listed entries were read from — NOT the live prop. Pinning
    // only at click time still reset the wrong repository whenever the tab
    // switch happened before the click rather than during the confirm.
    const repoPath = this.pinnedRepoPath;

    // `resetting` only guards THIS dialog. The sidebar lists and the graph menu
    // gate on the shared working-tree lock, so without claiming it a checkout
    // stayed clickable while this reset was moving the branch.
    if (!tryAcquireRefOp(repoPath)) {
      this.resetting = false;
      showToast('Another operation is already running in this repository.', 'warning');
      return;
    }

    // EVERY mode is a reset — the "Undo" button runs a mixed one — so every
    // mode repoints the branch and drops commits off it. Gating the confirm on
    // `hard` alone meant clicking Undo in a dialog opened just to LOOK at
    // history silently reset the branch. The same operation from the graph
    // context menu confirms for all three modes; this surface must match.
    const droppedNote =
      `This branch will point at ${entry.shortId}. Any commit no longer reachable ` +
      `from it is recoverable only through the reflog.`;

    // A checkout entry belongs to a DIFFERENT branch, so resetting onto it
    // moves the current branch to that branch's commit. "This branch will
    // point at <oid>" is true but does not say whose commit that is.
    const checkoutTarget = this.checkoutTarget(entry);
    const crossBranchNote = checkoutTarget
      ? `\n\nThis entry is a checkout of "${checkoutTarget}", not a state of the ` +
        `current branch. Resetting moves the current branch onto that commit. To ` +
        `go back to "${checkoutTarget}", close this and use Switch instead.`
      : '';

    const modeNote =
      mode === 'hard'
        ? 'All uncommitted changes are also discarded permanently — those are not in the reflog and cannot be recovered.'
        : mode === 'mixed'
          ? 'Your working-directory changes are kept, but unstaged.'
          : 'Your changes remain staged.';

    const titles = { hard: 'Hard Reset', mixed: 'Undo to This State', soft: 'Soft Reset' };

    const confirmed = await showConfirm(
      titles[mode],
      `Reset to ${entry.shortId}?\n\n${droppedNote}${crossBranchNote}\n\n${modeNote}`,
      'warning'
    );
    if (!confirmed) {
      this.resetting = false;
      releaseRefOp(repoPath);
      return;
    }

    try {
      // entry.oid pins the reset to the commit the user was actually shown:
      // this dialog loads the reflog once and never reloads, so an external
      // commit or checkout shifts entry.index onto a different commit.
      const result = await gitService.resetToReflog(repoPath, entry.index, mode, entry.oid);

      if (result.success) {
        // The graph's reset toasts this exact line and Smart Undo toasts too;
        // this surface closed in silence, so the strongest signal after the
        // most destructive action here was nothing — indistinguishable from
        // having pressed Escape.
        showToast(`Reset to ${entry.shortId} (${mode})`, 'success');
        this.dispatchEvent(new CustomEvent('undo-complete', {
          // repositoryPath so the host refreshes the repo the reset ran on —
          // the user may have switched tabs during the IPC await.
          detail: { entry: result.data, mode, repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));
        this.close();
      } else {
        showToast(`Reset failed: ${result.error?.message ?? 'Unknown error'}`, 'error');
        // The backend refuses when the reflog shifted under us and tells the
        // user to "refresh and try again" — but this dialog loads once and has
        // no refresh affordance, so without this the stale indices persist and
        // every retry fails identically. Reload so the advice is actionable.
        // Safe unconditionally now the dialog is pinned: the reload reads the
        // same repo the failed reset targeted, whichever tab is active.
        await this.loadReflog();
      }
    } catch (err) {
      console.error('Reset failed:', err);
      showToast(
        `Reset failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        'error',
      );
    } finally {
      this.resetting = false;
      releaseRefOp(repoPath);
    }
  }

  private formatDate(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  // Context menu handlers
  private handleEntryContextMenu(e: MouseEvent, entry: ReflogEntry): void {
    e.preventDefault();
    e.stopPropagation();
    this.contextMenu = { visible: true, x: e.clientX, y: e.clientY, entry };
  }

  private handleContextCheckout(): void {
    const entry = this.contextMenu.entry;
    if (!entry) return;
    this.contextMenu = { ...this.contextMenu, visible: false };

    // For a checkout entry, "go back there" is a switch — a reset would move
    // the current branch onto another branch's commit.
    if (this.checkoutTarget(entry)) {
      void this.handleSwitchTo(entry);
      return;
    }

    this.handleReset(entry, 'mixed');
  }

  private async handleContextCopyHash(): Promise<void> {
    const entry = this.contextMenu.entry;
    if (!entry) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    try {
      await navigator.clipboard.writeText(entry.oid);
    } catch (err) {
      console.error('Failed to copy hash:', err);
      showToast('Failed to copy hash to clipboard', 'error');
    }
  }

  private handleContextShowCommit(): void {
    const entry = this.contextMenu.entry;
    if (!entry) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    this.dispatchEvent(new CustomEvent('show-commit', {
      detail: { oid: entry.oid },
      bubbles: true,
      composed: true,
    }));
  }

  private renderEntry(entry: ReflogEntry) {
    const isCurrent = entry.index === 0;

    return html`
      <div
        class="entry ${this.selectedIndex === entry.index ? 'selected' : ''}"
        @click=${() => { this.selectedIndex = entry.index; }}
        @contextmenu=${(e: MouseEvent) => this.handleEntryContextMenu(e, entry)}
      >
        <span class="entry-index">HEAD@{${entry.index}}</span>

        <div class="entry-main">
          <div class="entry-header">
            <span class="entry-oid">${entry.shortId}</span>
            <span class="entry-action">${entry.action}</span>
            ${isCurrent ? html`<span class="current-badge">Current</span>` : nothing}
          </div>
          <div class="entry-message">${entry.message}</div>
          <div class="entry-meta">
            <span>${entry.author}</span>
            <span>${this.formatDate(entry.timestamp)}</span>
          </div>
        </div>

        ${!isCurrent && this.checkoutTarget(entry) ? html`
          <div class="entry-actions">
            <button
              class="reset-btn"
              @click=${(e: Event) => { e.stopPropagation(); this.handleSwitchTo(entry); }}
              ?disabled=${this.resetting || this.repositoryBusy}
              title="Switch back to ${this.checkoutTarget(entry)}"
            >
              Switch to ${this.checkoutTarget(entry)}
            </button>
          </div>
        ` : nothing}

        ${!isCurrent && !this.checkoutTarget(entry) ? html`
          <div class="entry-actions">
            <button
              class="reset-btn"
              @click=${(e: Event) => { e.stopPropagation(); this.handleReset(entry, 'mixed'); }}
              ?disabled=${this.resetting || this.repositoryBusy}
              title="Reset (keep changes unstaged)"
            >
              Undo
            </button>
            <button
              class="reset-btn hard"
              @click=${(e: Event) => { e.stopPropagation(); this.handleReset(entry, 'hard'); }}
              ?disabled=${this.resetting || this.repositoryBusy}
              title="Hard reset (discard all changes)"
            >
              Hard
            </button>
          </div>
        ` : nothing}
      </div>
    `;
  }

  render() {
    return html`
      <div class="overlay" @click=${this.handleOverlayClick}></div>
      <div class="dialog">
        <div class="header">
          <div class="header-left">
            <svg class="header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="1 4 1 10 7 10"></polyline>
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
            </svg>
            <div>
              <div class="title">Undo History</div>
              <div class="subtitle">Reflog - recover previous states</div>
            </div>
          </div>
          <button class="close-btn" @click=${this.dismiss}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="content">
          ${this.loading
            ? html`<div class="loading">Loading reflog...</div>`
            : this.entries.length === 0
              ? html`<div class="empty">No reflog entries found</div>`
              : html`
                  <div class="entry-list">
                    ${this.entries.map(entry => this.renderEntry(entry))}
                  </div>
                  <div class="list-footer">
                    ${this.hasMoreEntries
                      ? html`
                          <span class="list-note">
                            Showing the first ${this.entries.length} entries
                          </span>
                          <button
                            class="show-more-btn"
                            @click=${this.loadMoreEntries}
                            ?disabled=${this.loadingMore || this.resetting}
                          >
                            ${this.loadingMore ? 'Loading...' : 'Show more'}
                          </button>
                        `
                      : html`<span class="list-note">Showing all ${this.entries.length} entries</span>`}
                  </div>
                `}
        </div>

        <div class="help-text">
          <strong>Undo</strong> resets HEAD but keeps your changes. <strong>Hard</strong> discards all changes.
        </div>
      </div>
      ${this.renderContextMenu()}
    `;
  }

  private renderContextMenu() {
    if (!this.contextMenu.visible || !this.contextMenu.entry) return nothing;

    const { x, y, entry } = this.contextMenu;
    const isCurrent = entry.index === 0;

    return html`
      <div class="context-menu" style="left: ${x}px; top: ${y}px">
        ${!isCurrent ? html`
          <button
            class="context-menu-item"
            ?disabled=${this.resetting || this.repositoryBusy}
            @click=${this.handleContextCheckout}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="1 4 1 10 7 10"></polyline>
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
            </svg>
            Undo to this state
          </button>
          <div class="context-menu-divider"></div>
        ` : nothing}
        <button class="context-menu-item" @click=${this.handleContextShowCommit}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"></circle>
            <line x1="12" y1="3" x2="12" y2="9"></line>
            <line x1="12" y1="15" x2="12" y2="21"></line>
          </svg>
          Show commit details
        </button>
        <button class="context-menu-item" @click=${this.handleContextCopyHash}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          Copy commit hash
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-reflog-dialog': GnReflogDialog;
  }
}
