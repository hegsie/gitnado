/**
 * Worktree Dialog Component
 * Manage git worktrees for working on multiple branches
 */

import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import { showToast } from '../../services/notification.service.ts';
import type { Worktree } from '../../services/git.service.ts';
import type { Branch } from '../../types/git.types.ts';
import { pushOverlay, removeOverlay, isTopOverlay } from '../../utils/overlay-stack.ts';
import {
  tryAcquireRefOpOrWarn,
  releaseRefOp,
  isRefOpRunning,
  subscribeRefOps,
} from '../../utils/ref-lock.ts';
import { samePath } from '../../utils/path-compare.ts';

type DialogMode = 'list' | 'add';

@customElement('gn-worktree-dialog')
export class GnWorktreeDialog extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .dialog-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: var(--z-modal);
      }

      .dialog {
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        width: 550px;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        box-shadow: var(--shadow-xl);
      }

      .dialog-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-md);
        border-bottom: 1px solid var(--color-border);
      }

      .dialog-title {
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-semibold);
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .dialog-content {
        flex: 1;
        overflow-y: auto;
        padding: var(--spacing-md);
      }

      .dialog-footer {
        display: flex;
        justify-content: space-between;
        gap: var(--spacing-sm);
        padding: var(--spacing-md);
        border-top: 1px solid var(--color-border);
      }

      .dialog-footer-right {
        display: flex;
        gap: var(--spacing-sm);
      }

      .close-btn {
        background: none;
        border: none;
        padding: var(--spacing-xs);
        cursor: pointer;
        color: var(--color-text-secondary);
        border-radius: var(--radius-sm);
      }

      .close-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      /* Worktree list */
      .worktree-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .empty-state {
        text-align: center;
        padding: var(--spacing-xl);
        color: var(--color-text-muted);
      }

      .worktree-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm);
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }

      .worktree-item.main {
        border-color: var(--color-primary);
        background: rgba(59, 130, 246, 0.05);
      }

      .worktree-item.locked {
        opacity: 0.7;
      }

      .worktree-icon {
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-sm);
        flex-shrink: 0;
      }

      .worktree-icon svg {
        width: 16px;
        height: 16px;
        color: var(--color-text-secondary);
      }

      .worktree-info {
        flex: 1;
        min-width: 0;
      }

      .worktree-branch {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .main-badge {
        padding: 1px 6px;
        background: var(--color-primary);
        color: white;
        border-radius: var(--radius-xs);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
      }

      .locked-badge {
        padding: 1px 6px;
        background: var(--color-bg-tertiary);
        color: var(--color-text-muted);
        border-radius: var(--radius-xs);
        font-size: var(--font-size-xs);
      }

      .worktree-path {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        font-family: var(--font-family-mono);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .worktree-actions {
        display: flex;
        gap: var(--spacing-xs);
        flex-shrink: 0;
      }

      .action-btn {
        padding: var(--spacing-xs);
        background: none;
        border: none;
        color: var(--color-text-secondary);
        cursor: pointer;
        border-radius: var(--radius-sm);
      }

      .action-btn:hover {
        background: var(--color-bg-tertiary);
        color: var(--color-text-primary);
      }

      .action-btn.danger:hover {
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      .action-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .action-btn svg {
        width: 14px;
        height: 14px;
      }

      /* Add form */
      .form-group {
        margin-bottom: var(--spacing-md);
      }

      .form-label {
        display: block;
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-xs);
      }

      .form-input {
        width: 100%;
        padding: var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
      }

      .form-input::placeholder {
        color: var(--color-text-muted);
      }

      .form-hint {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        margin-top: var(--spacing-xs);
      }

      .form-select {
        width: 100%;
        padding: var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
      }

      .form-checkbox {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        font-size: var(--font-size-sm);
      }

      /* Buttons */
      .btn {
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        transition: all var(--transition-fast);
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .btn-secondary {
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        color: var(--color-text-primary);
      }

      .btn-secondary:hover {
        background: var(--color-bg-hover);
      }

      .btn-primary {
        background: var(--color-primary);
        border: 1px solid var(--color-primary);
        color: white;
      }

      .btn-primary:hover {
        background: var(--color-primary-hover);
      }

      .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn svg {
        width: 14px;
        height: 14px;
      }

      .message {
        padding: var(--spacing-sm);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-sm);
        margin-bottom: var(--spacing-md);
      }

      .message.error {
        background: var(--color-error-bg);
        border: 1px solid var(--color-error);
        color: var(--color-error);
      }

      .message.success {
        background: var(--color-success-bg);
        border: 1px solid var(--color-success);
        color: var(--color-success);
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-lg);
        color: var(--color-text-secondary);
      }
    `,
  ];

  @property({ type: Boolean }) open = false;
  @property({ type: String }) repositoryPath = '';

  @state() private mode: DialogMode = 'list';
  @state() private worktrees: Worktree[] = [];
  @state() private branches: Branch[] = [];
  @state() private loading = false;
  /** Re-entrancy guard for Remove, kept separate from the load spinner. */
  @state() private removingPath: string | null = null;

  /**
   * The shared working-tree lock, which this dialog was missing entirely.
   *
   * `git worktree add -b <name>` CREATES a branch and `git worktree remove`
   * deletes a checkout and prunes the shared worktree metadata — both write
   * refs the sidebar branch list, the graph ref menu and the branch-cleanup
   * dialog all take this lock for. There is no per-repo lock in the backend, so
   * without it a removal ran with every one of those surfaces still live.
   */
  @state() private refOpsVersion = 0;
  private unsubscribeRefOps?: () => void;

  private get repositoryBusy(): boolean {
    void this.refOpsVersion;
    return isRefOpRunning(this.pinnedRepoPath || this.repositoryPath);
  }
  @state() private error = '';
  @state() private success = '';

  // Add form
  @state() private addPath = '';
  @state() private addBranch = '';
  @state() private createNewBranch = false;
  @state() private newBranchName = '';

  /**
   * This dialog paints its own overlay instead of using gn-modal, so it had no
   * Escape handling at all — and app-shell's Escape chain now stops at the
   * dialog layer (so a keypress cannot also close the diff behind it), which
   * made Escape a completely dead key here. Dismiss like every sibling.
   */
  private handleKeyDown = (e: KeyboardEvent): void => {
    // Only the topmost overlay owns Escape: every dialog listens on
    // `document`, so without this one keypress ran all of them.
    if (!this.open || !isTopOverlay(this)) return;
    if (e.key === 'Escape') {
      this.handleClose();
    }
  };

  async connectedCallback(): Promise<void> {
    super.connectedCallback();
    document.addEventListener('keydown', this.handleKeyDown);
    this.unsubscribeRefOps = subscribeRefOps(() => {
      this.refOpsVersion++;
    });
    if (this.open) {
      await this.loadWorktrees();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    removeOverlay(this);
    document.removeEventListener('keydown', this.handleKeyDown);
    this.unsubscribeRefOps?.();
    this.unsubscribeRefOps = undefined;
  }

  /**
   * Repo captured when the dialog opened. `repositoryPath` is live-bound to
   * the ACTIVE repository and rebinds the instant the user Ctrl+Tabs — a
   * document-level shortcut this dialog's overlay does not block — while the
   * data on screen still belongs to the repo that was active at open. Every
   * read and every mutation must use THIS value, or the dialog acts on a
   * repository the user is not looking at.
   */
  private pinnedRepoPath = '';

  /** The repo this dialog is pinned to while open, or null when closed. */
  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.open ? this.pinnedRepoPath : null;
  }

  /**
   * True while `worktree remove --force` is running. The host's tab-close sweep
   * must not hide it behind a "worktrees closed" toast — the removal deletes a
   * working tree from disk and goes right on doing it.
   */
  public get operationInFlight(): boolean {
    return this.removingPath !== null;
  }

  async updated(changedProperties: Map<string, unknown>): Promise<void> {
    // Announce/withdraw overlay ownership of Escape.
    if (changedProperties.has('open')) {
      if (this.open) { pushOverlay(this); } else { removeOverlay(this); }
    }
    if (changedProperties.has('open') && this.open) {
      // A removal started against the previous pin may still be running (the
      // host can clear ?open without going through handleClose). Re-pinning
      // under it would point every post-await read and the `-changed` event at
      // a repository the removal never touched, while the one whose worktree
      // was just deleted from disk went unrefreshed.
      if (this.operationInFlight) return;
      this.pinnedRepoPath = this.repositoryPath;
      // Cleared on the OPEN transition, not just per handler. These dialogs
      // stay mounted (app-shell only toggles ?open), so `success` survived
      // close/reopen — and a Ctrl+Tab in between meant "Worktree removed" was
      // replayed above a DIFFERENT repository's untouched list. `error` never
      // leaked because every loader resets it; this is the third entry point
      // in the same sweep, after the handlers and the mode-switch buttons.
      this.success = '';
      this.error = '';
      this.mode = 'list';
      await this.loadWorktrees();
      await this.loadBranches();
    }
  }

  /**
   * @param repoPath The repo to read. Handlers pass the path they CAPTURED
   * before their await: reading the live pin here refetched — and repainted —
   * whichever repository the dialog had since been re-pinned to. A reload
   * whose path no longer matches the pin is dropped rather than painted over
   * the repository now on screen; its `worktrees-changed` event still routes
   * the refresh to the repo that actually changed.
   */
  private async loadWorktrees(repoPath: string = this.pinnedRepoPath): Promise<void> {
    if (repoPath !== this.pinnedRepoPath) return;

    this.loading = true;
    this.error = '';

    const result = await gitService.getWorktrees(repoPath);

    if (repoPath !== this.pinnedRepoPath) return;

    if (result.success && result.data) {
      this.worktrees = result.data;
    } else {
      this.error = result.error?.message || 'Failed to load worktrees';
    }

    this.loading = false;
  }

  /** @param repoPath See loadWorktrees. */
  private async loadBranches(repoPath: string = this.pinnedRepoPath): Promise<void> {
    if (repoPath !== this.pinnedRepoPath) return;

    const result = await gitService.getBranches(repoPath);

    if (repoPath !== this.pinnedRepoPath) return;

    if (result.success && result.data) {
      // LOCAL branches only, and only those free.
      //
      // get_branches returns remotes too, and they rendered here as plain rows
      // — `origin/main` sitting among the local names, visually identical.
      // `git worktree add <path> origin/main` exits 0 having created a
      // DETACHED worktree: the DWIM that creates a tracking branch fires only
      // for a bare name, not `remote/name`. So the dialog reported "Worktree
      // added successfully" and the row it then drew read `detached HEAD`,
      // not the branch the user had picked.
      const usedBranches = new Set(this.worktrees.map((wt) => wt.branch).filter(Boolean));
      this.branches = result.data.filter((b) => !b.isRemote && !usedBranches.has(b.name));
    } else {
      showToast(result.error?.message || 'Failed to load branches', 'error');
    }
  }

  private async handleAdd(): Promise<void> {
    if (!this.addPath) {
      this.error = 'Path is required';
      return;
    }

    if (!this.createNewBranch && !this.addBranch) {
      this.error = 'Please select a branch or create a new one';
      return;
    }

    if (this.createNewBranch && !this.newBranchName) {
      this.error = 'New branch name is required';
      return;
    }

    const repoPath = this.pinnedRepoPath;
    if (!tryAcquireRefOpOrWarn(repoPath)) return;

    this.loading = true;
    this.error = '';
    this.success = '';

    try {
    const result = await gitService.addWorktree(repoPath, this.addPath, {
      branch: this.createNewBranch ? undefined : this.addBranch,
      newBranch: this.createNewBranch ? this.newBranchName : undefined,
    });

    if (result.success) {
      this.success = 'Worktree added successfully';
      this.addPath = '';
      this.addBranch = '';
      this.newBranchName = '';
      this.createNewBranch = false;
      this.mode = 'list';
      await this.loadWorktrees(repoPath);
      // The dropdown's "only branches not checked out elsewhere" filter is
      // derived from this.worktrees at LOAD time, so without this the branch
      // just consumed stayed listed and the next Add dead-ended on git's raw
      // "already used by worktree at ..." — and a freed branch stayed missing
      // until the dialog was closed and reopened.
      await this.loadBranches(repoPath);
      this.dispatchEvent(new CustomEvent('worktrees-changed', {
        detail: { repositoryPath: repoPath || this.repositoryPath },
      }));
    } else {
      this.error = result.error?.message || 'Failed to add worktree';
    }
    } finally {
      this.loading = false;
      releaseRefOp(repoPath);
    }
  }

  /**
   * True when `worktree` is the one this dialog's repository points at.
   *
   * `isCurrent` is resolved by the backend against the filesystem — the only
   * place a symlinked repo path (/var vs /private/var) can be settled. The
   * path compare stays as the fallback, and normalizes what a string can: git
   * prints Windows paths with forward slashes (C:/work/repo) while the OS file
   * dialog hands back C:\work\repo. Comparing the raw strings left this guard
   * — and the disabled Remove button that shares it — dead on Windows.
   *
   * The two layers are OR'd on purpose: a `false` from the backend is NOT
   * authoritative, because `get_worktrees` itself falls back to a raw string
   * compare when canonicalize fails on either side, and that fallback can only
   * produce a false negative. Trusting it would re-open the bug.
   */
  private isCurrentWorktree(worktree: { path: string; isCurrent?: boolean }): boolean {
    if (worktree.isCurrent) return true;
    const repoPath = this.pinnedRepoPath || this.repositoryPath;
    if (!repoPath) return false;
    return samePath(worktree.path, repoPath);
  }

  private async handleRemove(worktree: Worktree): Promise<void> {
    if (worktree.isMain) {
      this.error = 'Cannot remove the main worktree';
      return;
    }
    // `git worktree remove` deliberately allows removing the worktree you are
    // standing IN — it refuses only the main one. This app has a second
    // constraint git does not: repositoryPath must keep existing. Opening a
    // linked worktree as the repository is supported, and `git worktree list`
    // always prints the MAIN worktree first regardless of where it runs, so the
    // open one gets isMain:false and its Remove button was live — with a
    // confirm that never said this was the repository you have open. Removing
    // it left every subsequent command failing on a directory that was gone.
    if (this.isCurrentWorktree(worktree)) {
      this.error =
        'Cannot remove the worktree you currently have open. Open a different worktree first.';
      return;
    }
    // A DEDICATED flag, not `loading`: that one also tracks background list
    // reloads, and a refresh in flight must not swallow the user's click.
    //
    // Claimed BEFORE the confirm, not after. showConfirm is an IPC round trip
    // before the native dialog opens and takes focus, and the button stays
    // enabled through that window — so a double-click stacked two prompts for
    // the same worktree, and the second removal then failed against a directory
    // that was already gone, contradicting the success the user just read.
    if (this.removingPath === worktree.path) return;

    // Captured BEFORE the confirm await: this dialog is bound to the active
    // repository and rebinds live, so a mid-confirm tab switch would otherwise
    // run the removal against the repo the user switched TO.
    const repoPath = this.pinnedRepoPath;

    // The SHARED lock, not just this dialog's flag — see repositoryBusy.
    if (!tryAcquireRefOpOrWarn(repoPath)) return;
    this.removingPath = worktree.path;

    const confirmed = await showConfirm(
      'Remove Worktree',
      `Remove the worktree at "${worktree.path}"? Its working directory will be deleted; committed work stays in the repository.`,
      'warning'
    );

    if (!confirmed) {
      this.removingPath = null;
      releaseRefOp(repoPath);
      return;
    }

    this.loading = true;
    this.error = '';
    this.success = '';

    try {
    let result = await gitService.removeWorktree(repoPath, worktree.path);

    // git refuses to remove a worktree holding uncommitted or untracked work
    // and tells the user to pass --force — a flag this dialog never exposed, so
    // the flow dead-ended on a raw CLI error with no way to finish. Offer the
    // same force escalation the branch-delete paths do, naming what is at stake.
    if (!result.success && this.isDirtyWorktreeError(result.error?.message)) {
      // `loading` deliberately stays claimed across this second confirm: the
      // escalation discards uncommitted work, so it is the last place that
      // should be re-enterable.
      const forced = await showConfirm(
        'Remove Worktree',
        `The worktree at "${worktree.path}" contains modified or untracked files. Removing it will permanently discard that work. Continue?`,
        'error'
      );
      if (!forced) {
        // NOT cleared. Blanking it left the list unchanged with no message at
        // all, so the git refusal that explains why the worktree is still
        // there — the only thing that makes the outcome legible — vanished
        // with the prompt.
        this.error =
          'Removal cancelled — the worktree still contains modified or untracked files.';
        return;
      }
      result = await gitService.removeWorktree(repoPath, worktree.path, true);
    }

    if (result.success) {
      this.success = 'Worktree removed';
      this.error = '';
      await this.loadWorktrees(repoPath);
      await this.loadBranches(repoPath);
      this.dispatchEvent(new CustomEvent('worktrees-changed', {
        detail: { repositoryPath: repoPath || this.repositoryPath },
      }));
    } else {
      this.error = result.error?.message || 'Failed to remove worktree';
    }
    } finally {
      this.loading = false;
      this.removingPath = null;
      releaseRefOp(repoPath);
    }
  }

  /** git's refusal when a worktree still holds working-tree state. */
  private isDirtyWorktreeError(message?: string): boolean {
    if (!message) return false;
    return /contains modified or untracked files/i.test(message);
  }

  private async handleLock(worktree: Worktree): Promise<void> {
    const repoPath = this.pinnedRepoPath;
    // Claims like Add and Remove do. These share the single `loading` flag
    // with a removal, and Remove holds the lock across its confirm with
    // `loading` still false — so this could set loading true, hide the list,
    // then set it false and re-run loadWorktrees() while the removal was
    // still in flight, repainting from a half-removed state.
    if (!tryAcquireRefOpOrWarn(repoPath)) return;

    this.loading = true;
    this.error = '';
    this.success = '';

    try {
      const result = await gitService.lockWorktree(repoPath, worktree.path);

      if (result.success) {
        this.success = 'Worktree locked successfully';
        await this.loadWorktrees(repoPath);
        this.dispatchEvent(new CustomEvent('worktrees-changed', {
        detail: { repositoryPath: repoPath || this.repositoryPath },
      }));
      } else {
        this.error = result.error?.message || 'Failed to lock worktree';
      }
    } finally {
      this.loading = false;
      releaseRefOp(repoPath);
    }
  }

  private async handleUnlock(worktree: Worktree): Promise<void> {
    const repoPath = this.pinnedRepoPath;
    // Claims like Add and Remove do. These share the single `loading` flag
    // with a removal, and Remove holds the lock across its confirm with
    // `loading` still false — so this could set loading true, hide the list,
    // then set it false and re-run loadWorktrees() while the removal was
    // still in flight, repainting from a half-removed state.
    if (!tryAcquireRefOpOrWarn(repoPath)) return;

    this.loading = true;
    this.error = '';
    this.success = '';

    try {
      const result = await gitService.unlockWorktree(repoPath, worktree.path);

      if (result.success) {
        this.success = 'Worktree unlocked successfully';
        await this.loadWorktrees(repoPath);
        this.dispatchEvent(new CustomEvent('worktrees-changed', {
        detail: { repositoryPath: repoPath || this.repositoryPath },
      }));
      } else {
        this.error = result.error?.message || 'Failed to unlock worktree';
      }
    } finally {
      this.loading = false;
      releaseRefOp(repoPath);
    }
  }

  private handleClose(): void {
    // Escape, the overlay and the x must honour the same rule the Remove
    // button does: dismissing mid-removal left `worktree remove --force`
    // deleting a working directory with no visible surface, and a Ctrl+Tab
    // plus reopen then re-pinned the dialog at another repository which the
    // removal's own completion proceeded to report against.
    if (this.operationInFlight) return;
    this.dispatchEvent(new CustomEvent('close'));
  }

  private renderList() {
    if (this.worktrees.length === 0) {
      return html`
        <div class="empty-state">
          <div>No worktrees found</div>
        </div>
      `;
    }

    return html`
      <div class="worktree-list">
        ${this.worktrees.map(
          (wt) => html`
            <div class="worktree-item ${wt.isMain ? 'main' : ''} ${wt.isLocked ? 'locked' : ''}">
              <div class="worktree-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
              </div>
              <div class="worktree-info">
                <div class="worktree-branch">
                  ${wt.branch || 'detached HEAD'}
                  ${wt.isMain ? html`<span class="main-badge">main</span>` : ''}
                  ${wt.isLocked ? html`<span class="locked-badge">locked</span>` : ''}
                </div>
                <div class="worktree-path" title="${wt.path}">${wt.path}</div>
              </div>
              <div class="worktree-actions">
                ${wt.isLocked
                  ? html`
                      <button
                        class="action-btn"
                        title="Unlock"
                        @click=${() => this.handleUnlock(wt)}
                        ?disabled=${this.loading || this.repositoryBusy || this.removingPath !== null}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                          <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
                        </svg>
                      </button>
                    `
                  : html`
                      <button
                        class="action-btn"
                        title="Lock"
                        @click=${() => this.handleLock(wt)}
                        ?disabled=${this.loading ||
                        this.repositoryBusy ||
                        this.removingPath !== null ||
                        wt.isMain}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                        </svg>
                      </button>
                    `}
                <button
                  class="action-btn danger"
                  title="Remove"
                  @click=${() => this.handleRemove(wt)}
                  ?disabled=${this.loading ||
                  this.repositoryBusy ||
                  this.removingPath === wt.path ||
                  wt.isMain ||
                  this.isCurrentWorktree(wt) ||
                  wt.isLocked}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  </svg>
                </button>
              </div>
            </div>
          `
        )}
      </div>
    `;
  }

  private renderAddForm() {
    return html`
      <div class="form-group">
        <label class="form-label">Worktree Path</label>
        <input
          type="text"
          class="form-input"
          placeholder="../my-feature-worktree"
          .value=${this.addPath}
          @input=${(e: Event) => {
            this.addPath = (e.target as HTMLInputElement).value;
          }}
        />
        <div class="form-hint">Path where the new worktree will be created</div>
      </div>

      <div class="form-group">
        <label class="form-checkbox">
          <input
            type="checkbox"
            .checked=${this.createNewBranch}
            @change=${(e: Event) => {
              this.createNewBranch = (e.target as HTMLInputElement).checked;
            }}
          />
          Create new branch
        </label>
      </div>

      ${this.createNewBranch
        ? html`
            <div class="form-group">
              <label class="form-label">New Branch Name</label>
              <input
                type="text"
                class="form-input"
                placeholder="feature/my-new-feature"
                .value=${this.newBranchName}
                @input=${(e: Event) => {
                  this.newBranchName = (e.target as HTMLInputElement).value;
                }}
              />
            </div>
          `
        : html`
            <div class="form-group">
              <label class="form-label">Branch</label>
              <select
                class="form-select"
                .value=${this.addBranch}
                @change=${(e: Event) => {
                  this.addBranch = (e.target as HTMLSelectElement).value;
                }}
              >
                <option value="">Select a branch...</option>
                ${this.branches.map(
                  (b) => html`<option value="${b.name}">${b.name}</option>`
                )}
              </select>
              <div class="form-hint">
                Only branches not checked out in other worktrees are shown
              </div>
            </div>
          `}
    `;
  }

  render() {
    if (!this.open) return null;

    return html`
      <div class="dialog-overlay" @click=${this.handleClose}>
        <div class="dialog" @click=${(e: Event) => e.stopPropagation()}>
          <div class="dialog-header">
            <span class="dialog-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
              ${this.mode === 'list' ? 'Worktrees' : 'Add Worktree'}
            </span>
            <button
              class="close-btn"
              @click=${this.handleClose}
              ?disabled=${this.operationInFlight}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>

          <div class="dialog-content">
            ${this.loading ? html`<div class="loading">Loading...</div>` : ''}

            ${this.error ? html`<div class="message error">${this.error}</div>` : ''}

            ${this.success ? html`<div class="message success">${this.success}</div>` : ''}

            ${!this.loading
              ? this.mode === 'list'
                ? this.renderList()
                : this.renderAddForm()
              : ''}
          </div>

          <div class="dialog-footer">
            ${this.mode === 'list'
              ? html`
                  <button
                    class="btn btn-primary"
                    @click=${() => {
                      this.mode = 'add';
                      this.error = '';
                      this.success = '';
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <line x1="12" y1="5" x2="12" y2="19"/>
                      <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Add Worktree
                  </button>
                  <div class="dialog-footer-right">
                    <button
                      class="btn btn-secondary"
                      @click=${this.handleClose}
                      ?disabled=${this.operationInFlight}
                    >
                      Close
                    </button>
                  </div>
                `
              : html`
                  <button
                    class="btn btn-secondary"
                    @click=${() => {
                      this.mode = 'list';
                      this.error = '';
                      this.success = '';
                    }}
                  >
                    Cancel
                  </button>
                  <div class="dialog-footer-right">
                    <button
                      class="btn btn-primary"
                      @click=${this.handleAdd}
                      ?disabled=${this.loading || this.repositoryBusy || !this.addPath}
                    >
                      Add Worktree
                    </button>
                  </div>
                `}
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-worktree-dialog': GnWorktreeDialog;
  }
}
