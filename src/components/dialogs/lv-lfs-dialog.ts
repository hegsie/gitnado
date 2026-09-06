/**
 * LFS Dialog Component
 * Manage Git Large File Storage
 */

import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import { handleExternalLink } from '../../utils/index.ts';
import type { LfsStatus, LfsFile } from '../../services/git.service.ts';
import { pushOverlay, removeOverlay, isTopOverlay } from '../../utils/overlay-stack.ts';
import {
  tryAcquireMaintenance,
  releaseMaintenance,
  isMaintenanceBlocked,
} from '../../utils/maintenance-confirms.ts';
import { warnRepositoryBusy, subscribeRefOps } from '../../utils/ref-lock.ts';

@customElement('lv-lfs-dialog')
export class LvLfsDialog extends LitElement {
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
        justify-content: flex-end;
        gap: var(--spacing-sm);
        padding: var(--spacing-md);
        border-top: 1px solid var(--color-border);
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

      /* Status section */
      .status-section {
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        padding: var(--spacing-md);
        margin-bottom: var(--spacing-md);
      }

      .status-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--spacing-sm);
      }

      .status-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
      }

      .status-badge {
        padding: 2px 8px;
        border-radius: var(--radius-xs);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
      }

      .status-badge.enabled {
        background: var(--color-success-bg);
        color: var(--color-success);
      }

      .status-badge.disabled {
        background: var(--color-bg-secondary);
        color: var(--color-text-muted);
      }

      .status-badge.not-installed {
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      .status-stats {
        display: flex;
        gap: var(--spacing-lg);
        margin-top: var(--spacing-sm);
      }

      .stat {
        text-align: center;
      }

      .stat-value {
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-bold);
        color: var(--color-primary);
      }

      .stat-label {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      /* Patterns section */
      .section {
        margin-bottom: var(--spacing-lg);
      }

      .section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--spacing-sm);
      }

      .section-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
      }

      .pattern-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .pattern-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
      }

      .pattern-text {
        font-family: var(--font-family-mono);
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
      }

      .empty-text {
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
        font-style: italic;
      }

      /* Add pattern form */
      .add-form {
        display: flex;
        gap: var(--spacing-sm);
      }

      .add-input {
        flex: 1;
        padding: var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        font-family: var(--font-family-mono);
      }

      .add-input::placeholder {
        color: var(--color-text-muted);
      }

      /* Files list */
      .files-list {
        max-height: 200px;
        overflow-y: auto;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }

      .file-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-xs) var(--spacing-sm);
        border-bottom: 1px solid var(--color-border);
      }

      .file-item:last-child {
        border-bottom: none;
      }

      .file-status {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        flex-shrink: 0;
      }

      .file-status.downloaded {
        background: var(--color-success-bg);
        color: var(--color-success);
      }

      .file-status.pointer {
        background: var(--color-bg-tertiary);
        color: var(--color-text-muted);
      }

      .file-path {
        flex: 1;
        font-size: var(--font-size-xs);
        font-family: var(--font-family-mono);
        color: var(--color-text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Actions */
      .actions {
        display: flex;
        gap: var(--spacing-sm);
        margin-top: var(--spacing-md);
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

      .btn-sm {
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: var(--font-size-xs);
      }

      .btn-icon {
        padding: var(--spacing-xs);
        background: none;
        border: none;
        color: var(--color-text-secondary);
        cursor: pointer;
        border-radius: var(--radius-sm);
      }

      .btn-icon:hover {
        background: var(--color-bg-tertiary);
        color: var(--color-text-primary);
      }

      .btn-icon.danger:hover {
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      .btn-icon svg {
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

      .message.warning {
        background: rgba(245, 158, 11, 0.1);
        border: 1px solid rgb(245, 158, 11);
        color: rgb(245, 158, 11);
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

  @state() private status: LfsStatus | null = null;
  @state() private files: LfsFile[] = [];
  @state() private loading = false;
  /** Re-entrancy guard for Prune, kept separate from the load spinner. */
  @state() private pruning = false;

  /**
   * The shared maintenance lock, which LFS prune alone was missing.
   *
   * gc, prune and fsck are reachable from both the Repository Health dialog and
   * the command palette, so maintenance-confirms.ts hoisted their concurrency
   * gate out of either surface. `git lfs prune` is the same class of
   * irreversible object deletion against the same `.git` — its own confirm says
   * objects that were never pushed cannot be recovered — but it was never
   * routed through the helper, leaving it the one destructive maintenance
   * command that could run concurrently with a `git gc`.
   */
  @state() private refOpsVersion = 0;
  private unsubscribeRefOps?: () => void;

  private get maintenanceBlocked(): boolean {
    void this.refOpsVersion;
    return isMaintenanceBlocked(this.pinnedRepoPath || this.repositoryPath);
  }
  @state() private error = '';
  @state() private success = '';
  @state() private newPattern = '';
  @state() private showFiles = false;

  /**
   * This dialog paints its own overlay instead of using lv-modal, so it had no
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
      await this.loadStatus();
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
   * True while `git lfs prune` is running. The host's tab-close sweep must not
   * hide it behind an "LFS closed" toast — the prune deletes local LFS objects
   * and goes right on doing it.
   */
  public get operationInFlight(): boolean {
    return this.pruning;
  }

  async updated(changedProperties: Map<string, unknown>): Promise<void> {
    // Announce/withdraw overlay ownership of Escape.
    if (changedProperties.has('open')) {
      if (this.open) { pushOverlay(this); } else { removeOverlay(this); }
    }
    if (changedProperties.has('open') && this.open) {
      // A prune started against the previous pin may still be running (the
      // host can clear ?open without going through handleClose). Re-pinning
      // under it would point every post-await read and the `-changed` event at
      // a repository the prune never touched, while the one whose local LFS
      // objects were just deleted went unrefreshed.
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
      await this.loadStatus();
    }
  }

  /**
   * @param repoPath The repo to read. Handlers pass the path they CAPTURED
   * before their await: reading the live pin here refetched — and repainted —
   * whichever repository the dialog had since been re-pinned to. A reload
   * whose path no longer matches the pin is dropped rather than painted over
   * the repository now on screen; its `lfs-changed` event still routes the
   * refresh to the repo that actually changed.
   */
  private async loadStatus(repoPath: string = this.pinnedRepoPath): Promise<void> {
    if (repoPath !== this.pinnedRepoPath) return;

    this.loading = true;
    this.error = '';

    const result = await gitService.getLfsStatus(repoPath);

    if (repoPath !== this.pinnedRepoPath) return;

    if (result.success && result.data) {
      this.status = result.data;
      if (result.data.enabled) {
        await this.loadFiles(repoPath);
      }
    } else {
      this.error = result.error?.message || 'Failed to load LFS status';
    }

    this.loading = false;
  }

  /** @param repoPath See loadStatus. */
  private async loadFiles(repoPath: string = this.pinnedRepoPath): Promise<void> {
    if (repoPath !== this.pinnedRepoPath) return;

    const result = await gitService.getLfsFiles(repoPath);

    if (repoPath !== this.pinnedRepoPath) return;

    if (result.success && result.data) {
      this.files = result.data;
    }
  }

  private async handleInit(): Promise<void> {
    const repoPath = this.pinnedRepoPath;
    if (!tryAcquireMaintenance(repoPath)) {
      warnRepositoryBusy();
      return;
    }

    this.loading = true;
    this.error = '';
    this.success = '';

    try {
    const result = await gitService.initLfs(repoPath);

    if (result.success) {
      // Says what actually happened: `git lfs install` sets hooks and config
      // but writes no .gitattributes, so nothing is tracked yet.
      this.success = 'Git LFS hooks installed — add a pattern below to start tracking files';
      await this.loadStatus(repoPath);
      this.dispatchEvent(new CustomEvent('lfs-changed', {
        detail: { repositoryPath: repoPath || this.repositoryPath },
      }));
    } else {
      this.error = result.error?.message || 'Failed to initialize LFS';
    }
    } finally {
      this.loading = false;
      releaseMaintenance(repoPath);
    }
  }

  private async handleTrack(): Promise<void> {
    if (!this.newPattern) return;

    const repoPath = this.pinnedRepoPath;
    // The same gate Prune takes — see handlePull.
    if (!tryAcquireMaintenance(repoPath)) {
      warnRepositoryBusy();
      return;
    }

    this.loading = true;
    this.error = '';
    this.success = '';

    try {

    // Captured before the await: the input is cleared on success, and the
    // message has to name what was actually tracked.
    const pattern = this.newPattern;
    const result = await gitService.lfsTrack(repoPath, pattern);

    if (result.success) {
      // Init, Pull and Prune in this same dialog all report success; Track and
      // Untrack did not, and the pattern list is long enough that a row
      // appearing or vanishing is not by itself a signal. The dialog stays
      // open, so it gets the same inline message its siblings use.
      this.success = `Now tracking ${pattern}`;
      this.newPattern = '';
      await this.loadStatus(repoPath);
      this.dispatchEvent(new CustomEvent('lfs-changed', {
        detail: { repositoryPath: repoPath || this.repositoryPath },
      }));
    } else {
      this.error = result.error?.message || 'Failed to track pattern';
    }
    } finally {
      this.loading = false;
      releaseMaintenance(repoPath);
    }
  }

  private async handleUntrack(pattern: string): Promise<void> {
    const repoPath = this.pinnedRepoPath;
    // The same gate Prune takes. These write the superproject too — pull runs
    // `git lfs fetch` + `git lfs checkout` into the working tree, track and
    // untrack rewrite .gitattributes, init rewrites .git/config and the hooks
    // — so a `git gc` from Repository Health, or this dialog's own prune
    // through its confirm, could run straight over them.
    if (!tryAcquireMaintenance(repoPath)) {
      warnRepositoryBusy();
      return;
    }

    this.loading = true;
    this.error = '';
    this.success = '';

    try {

    const result = await gitService.lfsUntrack(repoPath, pattern);

    if (result.success) {
      // Same asymmetry as handleTrack — see the note there.
      this.success = `No longer tracking ${pattern}`;
      await this.loadStatus(repoPath);
      this.dispatchEvent(new CustomEvent('lfs-changed', {
        detail: { repositoryPath: repoPath || this.repositoryPath },
      }));
    } else {
      this.error = result.error?.message || 'Failed to untrack pattern';
    }
    } finally {
      this.loading = false;
      releaseMaintenance(repoPath);
    }
  }

  private async handlePull(): Promise<void> {
    const repoPath = this.pinnedRepoPath;
    // The same gate Prune takes. These write the superproject too — pull runs
    // `git lfs fetch` + `git lfs checkout` into the working tree, track and
    // untrack rewrite .gitattributes, init rewrites .git/config and the hooks
    // — so a `git gc` from Repository Health, or this dialog's own prune
    // through its confirm, could run straight over them.
    if (!tryAcquireMaintenance(repoPath)) {
      warnRepositoryBusy();
      return;
    }

    this.loading = true;
    this.error = '';
    this.success = '';

    try {

    const result = await gitService.lfsPull(repoPath);

    if (result.success) {
      this.success = 'LFS files pulled successfully';
      await this.loadFiles(repoPath);
      this.dispatchEvent(new CustomEvent('lfs-changed', {
        detail: { repositoryPath: repoPath || this.repositoryPath },
      }));
    } else if (!gitService.isNetworkGateRefusal(result.error)) {
      // The gate already said why; a declined confirm needs no message at all.
      this.error = result.error?.message || 'Failed to pull LFS files';
    }
    } finally {
      this.loading = false;
      releaseMaintenance(repoPath);
    }
  }

  private async handlePrune(): Promise<void> {
    // A DEDICATED flag, not `loading`: that one also tracks background status
    // reloads, and a refresh in flight must not swallow the user's click.
    //
    // Claimed BEFORE the confirm, not after. showConfirm is an IPC round trip
    // before the native dialog opens and takes focus, and the button stays
    // enabled through that window — so a double-click made the user read and
    // dismiss the same irreversible-deletion warning twice for one gesture.
    if (this.pruning) return;

    // Captured BEFORE the confirm await: this dialog is bound to the active
    // repository and rebinds live on a tab switch.
    const repoPath = this.pinnedRepoPath;

    // Checked before the confirm, claimed after it — the same order gc and
    // prune use in the Repository Health dialog, so the user is not walked
    // through an irreversible-deletion warning only to be refused at the end.
    if (isMaintenanceBlocked(repoPath)) {
      warnRepositoryBusy();
      return;
    }

    this.pruning = true;

    // `git lfs prune` deletes local LFS objects that recent commits don't
    // reference. Unless lfs.pruneverifyremotealways is configured it does not
    // verify the objects exist on the remote first, so blobs from a commit that
    // was never pushed can be deleted with no copy left anywhere.
    const confirmed = await showConfirm(
      'Prune LFS Files',
      'This permanently deletes local LFS objects that recent commits do not ' +
        'reference. Objects that were never pushed cannot be recovered. Continue?',
      'warning'
    );

    if (!confirmed) {
      this.pruning = false;
      return;
    }

    if (!tryAcquireMaintenance(repoPath)) {
      this.pruning = false;
      warnRepositoryBusy();
      return;
    }

    this.loading = true;
    this.error = '';
    this.success = '';

    try {
      const result = await gitService.lfsPrune(repoPath);

      if (result.success) {
        this.success = result.data || 'LFS files pruned';
        await this.loadStatus(repoPath);
        this.dispatchEvent(new CustomEvent('lfs-changed', {
        detail: { repositoryPath: repoPath || this.repositoryPath },
      }));
      } else {
        this.error = result.error?.message || 'Failed to prune LFS files';
      }
    } finally {
      this.loading = false;
      this.pruning = false;
      releaseMaintenance(repoPath);
    }
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  private handleClose(): void {
    // Escape, the overlay and the x must honour the same rule the Prune button
    // does: dismissing mid-prune left `git lfs prune` deleting local objects
    // with no visible surface, and a Ctrl+Tab plus reopen then re-pinned the
    // dialog at another repository which the prune's own completion proceeded
    // to report against.
    if (this.operationInFlight) return;
    this.dispatchEvent(new CustomEvent('close'));
  }

  render() {
    if (!this.open) return null;

    return html`
      <div class="dialog-overlay" @click=${this.handleClose}>
        <div class="dialog" @click=${(e: Event) => e.stopPropagation()}>
          <div class="dialog-header">
            <span class="dialog-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <path d="M12 8v8m-4-4h8"/>
              </svg>
              Git LFS
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

            ${!this.loading && this.status ? this.renderContent() : ''}
          </div>

          <div class="dialog-footer">
            <button
              class="btn btn-secondary"
              @click=${this.handleClose}
              ?disabled=${this.operationInFlight}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderContent() {
    if (!this.status) return '';
    // The backend always sends `patterns` (a Vec); tolerate its absence anyway,
    // because a throw inside render() rejects the whole update.
    const patterns = this.status.patterns ?? [];

    if (!this.status.installed) {
      return html`
        <div class="message warning">
          Git LFS is not installed. Please install it to manage large files.
          <br><br>
          <a href="https://git-lfs.github.io/" @click=${handleExternalLink} style="color: inherit; text-decoration: underline;">
            Learn more about Git LFS
          </a>
        </div>
      `;
    }

    return html`
      <div class="status-section">
        <div class="status-header">
          <span class="status-title">Status</span>
          <span class="status-badge ${this.status.enabled ? 'enabled' : 'disabled'}">
            ${this.status.enabled ? 'Enabled' : 'Not configured'}
          </span>
        </div>
        <div style="font-size: var(--font-size-xs); color: var(--color-text-muted);">
          ${this.status.version}
        </div>
        ${this.status.enabled
          ? html`
              <div class="status-stats">
                <div class="stat">
                  <div class="stat-value">${this.status.fileCount}</div>
                  <div class="stat-label">Files</div>
                </div>
                <div class="stat">
                  <div class="stat-value">${this.formatSize(this.status.totalSize)}</div>
                  <div class="stat-label">Total size</div>
                </div>
              </div>
            `
          : html`
              <div class="actions">
                <button class="btn btn-primary" @click=${this.handleInit} ?disabled=${this.loading || this.pruning || this.maintenanceBlocked}>
                  Initialize LFS
                </button>
              </div>
            `}
      </div>

      <!-- Tracked Patterns is gated on INSTALLED, not enabled.
           "enabled" means some .gitattributes in the repo enables the LFS
           filter, and the only thing that writes that file is git lfs track —
           which lived in here. git lfs install (the Initialize button) sets config and
           hooks but never touches .gitattributes, so Initialize reported
           success, the badge stayed "Not configured", and the one control that
           could have changed it was unreachable. The dialog was a dead end on
           every repo adopting LFS for the first time. -->
      ${this.status.installed
        ? html`
            <div class="section">
              <div class="section-header">
                <span class="section-title">Tracked Patterns</span>
              </div>
              <div class="pattern-list">
                ${patterns.length === 0
                  ? html`<span class="empty-text">No patterns configured</span>`
                  : patterns.map(
                      (p) => html`
                        <div class="pattern-item">
                          <span class="pattern-text">${p.pattern}</span>
                          <button
                            class="btn-icon danger"
                            title="Remove"
                            @click=${() => this.handleUntrack(p.pattern)}
                            ?disabled=${this.loading || this.pruning || this.maintenanceBlocked}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <line x1="18" y1="6" x2="6" y2="18"></line>
                              <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                          </button>
                        </div>
                      `
                    )}
              </div>
              <div class="add-form" style="margin-top: var(--spacing-sm);">
                <input
                  type="text"
                  class="add-input"
                  placeholder="*.psd, *.zip, images/**"
                  .value=${this.newPattern}
                  @input=${(e: Event) => {
                    this.newPattern = (e.target as HTMLInputElement).value;
                  }}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter') this.handleTrack();
                  }}
                />
                <button
                  class="btn btn-primary btn-sm"
                  @click=${this.handleTrack}
                  ?disabled=${this.loading || this.pruning || this.maintenanceBlocked || !this.newPattern}
                >
                  Track
                </button>
              </div>
            </div>
          `
        : ''}

      ${this.status.enabled
        ? html`

            <div class="section">
              <div class="section-header">
                <span class="section-title">LFS Files (${this.files.length})</span>
                <button
                  class="btn btn-secondary btn-sm"
                  @click=${() => {
                    this.showFiles = !this.showFiles;
                  }}
                >
                  ${this.showFiles ? 'Hide' : 'Show'}
                </button>
              </div>
              ${this.showFiles
                ? html`
                    <div class="files-list">
                      ${this.files.length === 0
                        ? html`<div style="padding: var(--spacing-md); color: var(--color-text-muted); text-align: center;">
                            No LFS files
                          </div>`
                        : this.files.map(
                            (f) => html`
                              <div class="file-item">
                                <span class="file-status ${f.downloaded ? 'downloaded' : 'pointer'}">
                                  ${f.downloaded ? '&#10003;' : '&#8226;'}
                                </span>
                                <span class="file-path" title="${f.path}">${f.path}</span>
                              </div>
                            `
                          )}
                    </div>
                  `
                : ''}
            </div>

            <div class="actions">
              <button class="btn btn-secondary" @click=${this.handlePull} ?disabled=${this.loading || this.pruning || this.maintenanceBlocked}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Pull Files
              </button>
              <button
                class="btn btn-secondary"
                @click=${this.handlePrune}
                ?disabled=${this.loading || this.pruning || this.maintenanceBlocked}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
                Prune Old Files
              </button>
            </div>
          `
        : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-lfs-dialog': LvLfsDialog;
  }
}
