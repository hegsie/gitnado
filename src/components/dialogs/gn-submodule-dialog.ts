/**
 * Submodule Dialog Component
 * Manage git submodules - list, add, update, remove
 */

import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import type { Submodule } from '../../services/git.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { pushOverlay, removeOverlay, isTopOverlay } from '../../utils/overlay-stack.ts';
import {
  tryAcquireRefOpOrWarn,
  releaseRefOp,
  isRefOpRunning,
  subscribeRefOps,
} from '../../utils/ref-lock.ts';

type DialogMode = 'list' | 'add';

@customElement('gn-submodule-dialog')
export class GnSubmoduleDialog extends LitElement {
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

      /* Submodule list */
      .submodule-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .empty-state {
        text-align: center;
        padding: var(--spacing-xl);
        color: var(--color-text-muted);
      }

      .empty-icon {
        font-size: 48px;
        margin-bottom: var(--spacing-sm);
        opacity: 0.5;
      }

      .submodule-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm);
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }

      .submodule-item:hover {
        background: var(--color-bg-hover);
      }

      .submodule-icon {
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-sm);
        flex-shrink: 0;
      }

      .submodule-icon svg {
        width: 16px;
        height: 16px;
        color: var(--color-text-secondary);
      }

      .submodule-info {
        flex: 1;
        min-width: 0;
      }

      .submodule-name {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .submodule-path {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        font-family: var(--font-family-mono);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .submodule-status {
        padding: 2px 8px;
        border-radius: var(--radius-xs);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        flex-shrink: 0;
      }

      .status-current {
        background: var(--color-success-bg);
        color: var(--color-success);
      }

      .status-modified {
        background: rgba(245, 158, 11, 0.1);
        color: rgb(245, 158, 11);
      }

      .status-uninitialized {
        background: var(--color-bg-tertiary);
        color: var(--color-text-muted);
      }

      .status-missing {
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      .status-dirty {
        background: rgba(245, 158, 11, 0.1);
        color: rgb(245, 158, 11);
      }

      .submodule-actions {
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

      /* Bulk actions */
      .bulk-actions {
        display: flex;
        gap: var(--spacing-sm);
        margin-bottom: var(--spacing-md);
        padding: var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
      }
    `,
  ];

  @property({ type: Boolean }) open = false;
  @property({ type: String }) repositoryPath = '';

  @state() private mode: DialogMode = 'list';
  @state() private submodules: Submodule[] = [];
  @state() private loading = false;
  /** Re-entrancy guard for Remove, kept separate from the load spinner. */
  @state() private removingPath: string | null = null;

  /**
   * The shared working-tree lock, which this dialog was missing entirely.
   *
   * `git submodule deinit -f` + `git rm -f` rewrite the SUPERPROJECT's index
   * and working tree — the same state a checkout, a discard, a reset and a
   * rebase all take this lock for. There is no per-repo lock in the backend, so
   * while a removal ran every branch row, Discard button and graph ref menu
   * stayed live, and a checkout's auto-stash could capture a half-removed tree
   * or die on `index.lock`. `git submodule add`/`update` write the same index.
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
  @state() private addUrl = '';
  @state() private addPath = '';
  @state() private addBranch = '';

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
      await this.loadSubmodules();
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
   * True while `submodule deinit -f` + removal is running. The host's tab-close
   * sweep must not hide it behind a "submodules closed" toast — the removal
   * deletes the submodule's working tree and goes right on doing it.
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
      // a repository the removal never touched, while the one whose index and
      // working tree were just rewritten went unrefreshed.
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
      this.addUrl = '';
      this.addPath = '';
      this.addBranch = '';
      await this.loadSubmodules();
    }
  }

  /**
   * @param repoPath The repo to read. Handlers pass the path they CAPTURED
   * before their await: reading the live pin here refetched — and repainted —
   * whichever repository the dialog had since been re-pinned to. A reload
   * whose path no longer matches the pin is dropped rather than painted over
   * the repository now on screen; its `submodules-changed` event still routes
   * the refresh to the repo that actually changed.
   */
  private async loadSubmodules(repoPath: string = this.pinnedRepoPath): Promise<void> {
    if (repoPath !== this.pinnedRepoPath) return;

    this.loading = true;
    this.error = '';

    const result = await gitService.getSubmodules(repoPath);

    if (repoPath !== this.pinnedRepoPath) return;

    if (result.success && result.data) {
      this.submodules = result.data;
    } else {
      this.error = result.error?.message || 'Failed to load submodules';
    }

    this.loading = false;
  }

  private async handleAdd(): Promise<void> {
    if (!this.addUrl || !this.addPath) {
      this.error = 'URL and path are required';
      return;
    }

    const repoPath = this.pinnedRepoPath;
    if (!tryAcquireRefOpOrWarn(repoPath)) return;

    this.loading = true;
    this.error = '';
    this.success = '';

    try {
    const result = await gitService.addSubmodule(
      repoPath,
      this.addUrl,
      this.addPath,
      this.addBranch || undefined
    );

    if (result.success) {
      this.success = 'Submodule added successfully';
      showToast('Submodule added successfully', 'success');
      this.addUrl = '';
      this.addPath = '';
      this.addBranch = '';
      this.mode = 'list';
      await this.loadSubmodules(repoPath);
      this.dispatchEvent(new CustomEvent('submodules-changed', {
        detail: { repositoryPath: repoPath || this.repositoryPath },
      }));
    } else if (!gitService.isNetworkGateRefusal(result.error)) {
      // The gate already announced a block, and a declined confirm is the
      // user's own decision — neither is a failure to report.
      this.error = result.error?.message || 'Failed to add submodule';
      showToast(result.error?.message || 'Failed to add submodule', 'error');
    }
    } finally {
      this.loading = false;
      releaseRefOp(repoPath);
    }
  }

  private async handleInit(submodule: Submodule): Promise<void> {
    const repoPath = this.pinnedRepoPath;
    if (!tryAcquireRefOpOrWarn(repoPath)) return;

    this.loading = true;
    this.error = '';
    this.success = '';

    try {
    const result = await gitService.initSubmodules(repoPath, [submodule.path]);

    if (result.success) {
      // Also update after init
      const updateResult = await gitService.updateSubmodules(repoPath, {
        submodulePaths: [submodule.path],
      });
      // Same gate contract every other handler in this file honours: BLOCKED
      // means a setting refused it and checkNetworkAllowed already toasted, so
      // reporting again stacked two contradictory messages on one click;
      // CANCELLED means the user declined the confirm, and calling their own
      // decision a failed update is worse still.
      if (!updateResult.success && !gitService.isNetworkGateRefusal(updateResult.error)) {
        showToast('Initialized but update failed: ' + (updateResult.error?.message || 'Unknown error'), 'warning');
      } else {
        // Add, Remove and Update All in this same dialog all report success;
        // Init and Update did not, leaving the user to infer it from a status
        // badge in a row they may not be looking at. The dialog stays open, so
        // it gets the inline message its siblings use.
        this.success = `Initialized ${submodule.path}`;
      }
      await this.loadSubmodules(repoPath);
      this.dispatchEvent(new CustomEvent('submodules-changed', {
        detail: { repositoryPath: repoPath || this.repositoryPath },
      }));
    } else if (!gitService.isNetworkGateRefusal(result.error)) {
      this.error = result.error?.message || 'Failed to initialize submodule';
      showToast(result.error?.message || 'Failed to initialize submodule', 'error');
    }
    } finally {
      this.loading = false;
      releaseRefOp(repoPath);
    }
  }

  private async handleUpdate(submodule: Submodule): Promise<void> {
    const repoPath = this.pinnedRepoPath;
    if (!tryAcquireRefOpOrWarn(repoPath)) return;

    this.loading = true;
    this.error = '';
    this.success = '';

    try {

    // Canonical `git submodule update <path>`: check out the commit the
    // superproject has recorded for this submodule, leaving the superproject
    // clean. (Passing remote:true would run `--remote`, checking out the
    // upstream branch tip instead and dirtying the working tree.)
    const result = await gitService.updateSubmodules(repoPath, {
      submodulePaths: [submodule.path],
    });

    if (result.success) {
      // Same asymmetry as handleInit — see the note there.
      this.success = `Updated ${submodule.path}`;
      await this.loadSubmodules(repoPath);
      this.dispatchEvent(new CustomEvent('submodules-changed', {
        detail: { repositoryPath: repoPath || this.repositoryPath },
      }));
    } else if (!gitService.isNetworkGateRefusal(result.error)) {
      this.error = result.error?.message || 'Failed to update submodule';
      showToast(result.error?.message || 'Failed to update submodule', 'error');
    }
    } finally {
      this.loading = false;
      releaseRefOp(repoPath);
    }
  }

  private async handleRemove(submodule: Submodule): Promise<void> {
    // A DEDICATED flag, not `loading`: that one also tracks background list
    // reloads, and a refresh in flight must not swallow the user's click.
    //
    // Claimed BEFORE the confirm, not after. showConfirm is an IPC round trip
    // before the native dialog opens and takes focus, and the button stays
    // enabled through that window — so a double-click stacked two prompts for
    // the same submodule, and the second removal then failed against a working
    // tree that was already gone, contradicting the success the user just read.
    if (this.removingPath === submodule.path) return;

    // Captured BEFORE the confirm await: removal runs `git submodule deinit -f`
    // + `git rm -f`, deleting the submodule's working tree (including any
    // uncommitted work inside it). This dialog is bound to the active
    // repository and rebinds live, so a mid-confirm tab switch would otherwise
    // aim that at the repo the user switched TO.
    const repoPath = this.pinnedRepoPath;

    // The SHARED lock, not just this dialog's flag: `git rm -f` rewrites the
    // superproject's index and working tree, so it has to serialize against
    // checkout, discard, reset and rebase the same way they serialize against
    // each other.
    if (!tryAcquireRefOpOrWarn(repoPath)) return;
    this.removingPath = submodule.path;

    const confirmed = await showConfirm(
      'Remove Submodule',
      // Names the PATH, not just the .gitmodules section key. The two are
      // independent — git keeps the original section name after a directory
      // move — so a confirm saying only "libfoo" never named vendor/foo, the
      // directory about to be deleted with its uncommitted contents.
      `Are you sure you want to remove the submodule "${submodule.name}" at "${submodule.path}"?\n\nThis deletes that directory, including any uncommitted changes inside it. This cannot be undone.`,
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
      const result = await gitService.removeSubmodule(repoPath, submodule.path);

      if (result.success) {
        this.success = 'Submodule removed successfully';
        showToast('Submodule removed successfully', 'success');
        await this.loadSubmodules(repoPath);
        this.dispatchEvent(new CustomEvent('submodules-changed', {
        detail: { repositoryPath: repoPath || this.repositoryPath },
      }));
      } else {
        this.error = result.error?.message || 'Failed to remove submodule';
        showToast(result.error?.message || 'Failed to remove submodule', 'error');
      }
    } finally {
      this.loading = false;
      this.removingPath = null;
      releaseRefOp(repoPath);
    }
  }

  private async handleUpdateAll(): Promise<void> {
    const repoPath = this.pinnedRepoPath;
    if (!tryAcquireRefOpOrWarn(repoPath)) return;

    this.loading = true;
    this.error = '';
    this.success = '';

    try {
    const result = await gitService.updateSubmodules(repoPath, {
      init: true,
      recursive: true,
    });

    if (result.success) {
      this.success = 'All submodules updated';
      showToast('All submodules updated', 'success');
      await this.loadSubmodules(repoPath);
      this.dispatchEvent(new CustomEvent('submodules-changed', {
        detail: { repositoryPath: repoPath || this.repositoryPath },
      }));
    } else if (!gitService.isNetworkGateRefusal(result.error)) {
      this.error = result.error?.message || 'Failed to update submodules';
      showToast(result.error?.message || 'Failed to update submodules', 'error');
    }
    } finally {
      this.loading = false;
      releaseRefOp(repoPath);
    }
  }

  private handleClose(): void {
    // Escape, the overlay and the x must honour the same rule the Remove
    // button does: dismissing mid-removal left `submodule deinit -f` + `git
    // rm -f` deleting a working tree with no visible surface, and a Ctrl+Tab
    // plus reopen then re-pinned the dialog at another repository which the
    // removal's own completion proceeded to report against.
    if (this.operationInFlight) return;
    this.dispatchEvent(new CustomEvent('close'));
  }

  private getStatusLabel(status: string): string {
    switch (status) {
      case 'current':
        return 'Up to date';
      case 'modified':
        return 'Modified';
      case 'uninitialized':
        return 'Not initialized';
      case 'missing':
        return 'Missing';
      case 'dirty':
        return 'Has changes';
      default:
        return status;
    }
  }

  private renderList() {
    if (this.submodules.length === 0) {
      return html`
        <div class="empty-state">
          <div class="empty-icon">&#128230;</div>
          <div>No submodules</div>
          <div style="font-size: var(--font-size-xs); margin-top: var(--spacing-xs);">
            Add a submodule to include another repository
          </div>
        </div>
      `;
    }

    return html`
      ${this.submodules.length > 1 ? html`
        <div class="bulk-actions">
          <button class="btn btn-secondary" @click=${this.handleUpdateAll} ?disabled=${this.loading || this.repositoryBusy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M23 4v6h-6M1 20v-6h6"/>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
            Update All
          </button>
        </div>
      ` : ''}

      <div class="submodule-list">
        ${this.submodules.map(
          (sub) => html`
            <div class="submodule-item">
              <div class="submodule-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 3h18v18H3z"/>
                  <path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>
                </svg>
              </div>
              <div class="submodule-info">
                <div class="submodule-name">${sub.name}</div>
                <div class="submodule-path">${sub.path}</div>
              </div>
              <span class="submodule-status status-${sub.status}">
                ${this.getStatusLabel(sub.status)}
              </span>
              <div class="submodule-actions">
                ${!sub.initialized
                  ? html`
                      <button
                        class="action-btn"
                        title="Initialize"
                        @click=${() => this.handleInit(sub)}
                        ?disabled=${this.loading || this.repositoryBusy}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                          <polyline points="7 10 12 15 17 10"/>
                          <line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                      </button>
                    `
                  : html`
                      <button
                        class="action-btn"
                        title="Update"
                        @click=${() => this.handleUpdate(sub)}
                        ?disabled=${this.loading || this.repositoryBusy}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M23 4v6h-6M1 20v-6h6"/>
                          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                        </svg>
                      </button>
                    `}
                <button
                  class="action-btn danger"
                  title="Remove"
                  @click=${() => this.handleRemove(sub)}
                  ?disabled=${this.loading || this.repositoryBusy || this.removingPath === sub.path}
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
        <label class="form-label">Repository URL</label>
        <input
          type="text"
          class="form-input"
          placeholder="https://github.com/user/repo.git"
          .value=${this.addUrl}
          @input=${(e: Event) => {
            this.addUrl = (e.target as HTMLInputElement).value;
          }}
        />
        <div class="form-hint">The URL of the repository to add as a submodule</div>
      </div>

      <div class="form-group">
        <label class="form-label">Path</label>
        <input
          type="text"
          class="form-input"
          placeholder="lib/my-submodule"
          .value=${this.addPath}
          @input=${(e: Event) => {
            this.addPath = (e.target as HTMLInputElement).value;
          }}
        />
        <div class="form-hint">Where to place the submodule in your repository</div>
      </div>

      <div class="form-group">
        <label class="form-label">Branch (optional)</label>
        <input
          type="text"
          class="form-input"
          placeholder="main"
          .value=${this.addBranch}
          @input=${(e: Event) => {
            this.addBranch = (e.target as HTMLInputElement).value;
          }}
        />
        <div class="form-hint">Track a specific branch instead of the default</div>
      </div>
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
                <path d="M3 3h18v18H3z"/>
                <path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>
              </svg>
              ${this.mode === 'list' ? 'Submodules' : 'Add Submodule'}
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
                  <button class="btn btn-primary" @click=${() => { this.mode = 'add'; this.error = ''; this.success = ''; }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <line x1="12" y1="5" x2="12" y2="19"/>
                      <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Add Submodule
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
                  <button class="btn btn-secondary" @click=${() => { this.mode = 'list'; this.error = ''; this.success = ''; }}>
                    Cancel
                  </button>
                  <div class="dialog-footer-right">
                    <button
                      class="btn btn-primary"
                      @click=${this.handleAdd}
                      ?disabled=${this.loading || this.repositoryBusy || !this.addUrl || !this.addPath}
                    >
                      Add Submodule
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
    'gn-submodule-dialog': GnSubmoduleDialog;
  }
}
