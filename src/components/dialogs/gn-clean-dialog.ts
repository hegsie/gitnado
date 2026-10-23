/**
 * Clean Dialog
 * Remove untracked and ignored files from the working directory
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import type { CleanEntry } from '../../services/git.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import { pushOverlay, removeOverlay, isTopOverlay } from '../../utils/overlay-stack.ts';
import { containsDeepActiveElement } from '../../utils/focus.ts';
import {
  tryAcquireRefOp,
  releaseRefOp,
  isRefOpRunning,
  subscribeRefOps,
} from '../../utils/ref-lock.ts';

@customElement('gn-clean-dialog')
export class GnCleanDialog extends LitElement {
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
        width: 600px;
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
        color: var(--color-warning);
      }

      .title {
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
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

      .warning-banner {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-warning-bg);
        border-bottom: 1px solid var(--color-border);
        color: var(--color-warning);
        font-size: var(--font-size-sm);
      }

      .warning-banner svg {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        margin-top: 2px;
      }

      .options {
        display: flex;
        gap: var(--spacing-md);
        padding: var(--spacing-md);
        border-bottom: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
      }

      .option {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        cursor: pointer;
        user-select: none;
      }

      .option input {
        margin: 0;
      }

      .content {
        flex: 1;
        overflow-y: auto;
        padding: var(--spacing-sm);
      }

      .loading, .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xl);
        color: var(--color-text-muted);
        text-align: center;
      }

      .empty svg {
        width: 48px;
        height: 48px;
        margin-bottom: var(--spacing-md);
        opacity: 0.5;
      }

      .file-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .file-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: background var(--transition-fast);
      }

      .file-item:hover {
        background: var(--color-bg-hover);
      }

      .file-item.selected {
        background: var(--color-bg-selected);
      }

      .file-checkbox {
        margin: 0;
      }

      .file-icon {
        width: 16px;
        height: 16px;
        color: var(--color-text-muted);
        flex-shrink: 0;
      }

      .file-icon.directory {
        color: var(--color-warning);
      }

      .file-icon.ignored {
        color: var(--color-text-muted);
        opacity: 0.5;
      }

      .file-info {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .file-path {
        font-family: var(--font-mono);
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .file-badge {
        font-size: var(--font-size-xs);
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        flex-shrink: 0;
      }

      .file-badge.ignored {
        background: var(--color-bg-tertiary);
        color: var(--color-text-muted);
      }

      .file-badge.directory {
        background: var(--color-warning-bg);
        color: var(--color-warning);
      }

      .file-badge.nested-repo {
        background: var(--color-error-bg, rgba(192, 57, 43, 0.15));
        color: var(--color-error);
      }

      .file-size {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        flex-shrink: 0;
      }

      .footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-md) var(--spacing-lg);
        border-top: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
      }

      .footer-left {
        font-size: var(--font-size-sm);
        color: var(--color-text-muted);
      }

      .footer-right {
        display: flex;
        gap: var(--spacing-sm);
      }

      .btn {
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-md);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .btn-secondary {
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        color: var(--color-text-primary);
      }

      .btn-secondary:hover {
        background: var(--color-bg-hover);
      }

      .btn-danger {
        background: var(--color-error);
        border: 1px solid var(--color-error);
        color: white;
      }

      .btn-danger:hover {
        background: var(--color-error-hover, #c0392b);
      }

      .btn-danger:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .select-all {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
        border-bottom: 1px solid var(--color-border);
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .select-all input {
        margin: 0;
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: String }) repositoryPath = '';

  @state() private entries: CleanEntry[] = [];
  @state() private selectedPaths: Set<string> = new Set();
  @state() private loading = false;
  @state() private cleaning = false;
  @state() private includeIgnored = false;
  @state() private includeDirectories = true;

  /**
   * Repo captured when the dialog opened. `repositoryPath` is live-bound to
   * the ACTIVE repository and rebinds the instant the user Ctrl+Tabs — a
   * document-level shortcut this dialog's overlay does not block. The file
   * list on screen belongs to the repo that was active at open, so every
   * operation must use THIS value: reading the live prop deleted the listed
   * paths out of whichever repo the user had switched to, and untracked files
   * have no trash and no recovery path.
   */
  private pinnedRepoPath = '';
  private unsubscribeRefOps?: () => void;

  /** The repo this dialog is pinned to while open, or null when closed. */
  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.open ? this.pinnedRepoPath : null;
  }

  /**
   * True while `clean_files` is deleting. `dismiss()` already refuses on this;
   * the host's tab-close sweep must consult the same flag, or it clears the
   * host flag directly and reports "clean cancelled" over a delete that is
   * still unlinking files that have no trash and no recovery path.
   */
  public get operationInFlight(): boolean {
    return this.cleaning;
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
      if (this.cleaning) return;
      this.pinnedRepoPath = this.repositoryPath;
      this.focusInitialControl();
      await this.loadFiles();
    }
  }

  /**
   * Move focus into the dialog once it is on screen.
   *
   * This dialog builds its own overlay instead of using <gn-modal>, and had no
   * focus() anywhere: opening it from the command palette left focus on
   * <body> (the palette restores focus to a host that carries no tabindex), so
   * Tab started at the skip link and walked the entire app UNDERNEATH the
   * backdrop — every Enter acting on a live control while a dialog listing
   * files for permanent deletion was on screen.
   *
   * Cancel, not "Delete Selected": the first thing Enter can reach must not be
   * the destructive one. Guarded like <gn-modal>'s own pass so it cannot yank
   * focus off something the user already moved to.
   */
  private focusInitialControl(): void {
    requestAnimationFrame(() => {
      if (!this.open) return;
      if (containsDeepActiveElement(this)) return;
      const cancelBtn = this.shadowRoot?.querySelector(
        '.footer-right .btn-secondary'
      ) as HTMLElement | null;
      cancelBtn?.focus();
    });
  }

  private async loadFiles(): Promise<void> {
    if (!this.pinnedRepoPath) return;

    this.loading = true;
    this.entries = [];
    this.selectedPaths = new Set();

    try {
      const result = await gitService.getCleanableFiles(
        this.pinnedRepoPath,
        this.includeIgnored,
        this.includeDirectories
      );

      if (result.success && result.data) {
        this.entries = result.data;
        // Select all by default EXCEPT untracked nested git repositories:
        // deleting those destroys embedded history, so they require an explicit
        // opt-in (mirroring `git clean`'s need for a second `-f`).
        this.selectedPaths = new Set(
          this.entries.filter(e => !e.isNestedRepo).map(e => e.path)
        );
      } else if (!result.success) {
        showToast(result.error?.message || 'Failed to load cleanable files', 'error');
      }
    } catch (err) {
      console.error('Failed to load cleanable files:', err);
      showToast('Failed to load cleanable files', 'error');
    } finally {
      this.loading = false;
    }
  }

  /**
   * User-initiated dismissal. Blocked while the operation is in flight:
   * closing mid-delete leaves it running with no visible surface, and when it
   * finishes its success path calls close() — yanking shut whatever session
   * the user had reopened in the meantime and discarding their new selection.
   * close() itself stays unguarded because that success path needs it.
   */
  private dismiss(): void {
    if (this.cleaning) return;
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
    this.unsubscribeRefOps = subscribeRefOps(() => {
      this.requestUpdate();
    });
    document.addEventListener('keydown', this.handleKeyDown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeRefOps?.();
    this.unsubscribeRefOps = undefined;
    removeOverlay(this);
    document.removeEventListener('keydown', this.handleKeyDown);
  }

  public close(): void {
    this.open = false;
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private toggleEntry(path: string): void {
    const newSelected = new Set(this.selectedPaths);
    if (newSelected.has(path)) {
      newSelected.delete(path);
    } else {
      newSelected.add(path);
    }
    this.selectedPaths = newSelected;
  }

  private toggleAll(): void {
    if (this.selectedPaths.size === this.entries.length) {
      this.selectedPaths = new Set();
    } else {
      this.selectedPaths = new Set(this.entries.map(e => e.path));
    }
  }

  private async handleOptionChange(): Promise<void> {
    await this.loadFiles();
  }

  private async handleClean(): Promise<void> {
    // Claimed on ENTRY, not after the confirms. showConfirm is an IPC round
    // trip before the native dialog opens and takes focus, and the button stays
    // enabled through that window — so a double-click raised a second delete
    // confirm over the same selection. Confirming both ran the clean twice: the
    // second on paths that no longer existed, producing a "0 of N items"
    // warning that contradicted the success toast the user had just read. Same
    // claim-before-confirm the abort banner and the gitflow panel apply.
    if (this.cleaning || this.selectedPaths.size === 0) return;

    // The repo the listed files were read from — NOT the live prop. Pinning
    // only at click time still deleted from the wrong repository whenever the
    // tab switch happened before the click rather than during the confirm.
    const repoPath = this.pinnedRepoPath;

    // Clean deletes files from the same working tree checkout, reset, merge and
    // rebase mutate, and the backend takes no per-repo lock — so this joins the
    // shared one rather than guarding only itself.
    if (!tryAcquireRefOp(repoPath)) {
      showToast('Another operation is already running in this repository.', 'warning');
      return;
    }
    this.cleaning = true;

    // Captured BEFORE the confirms too. loadFiles() reassigns selectedPaths on
    // every option change and on its own initial load, so reading it after an
    // await can yield a set the user never chose — or an empty one. Pinning it
    // also guarantees the count named in the confirm is exactly what gets
    // deleted.
    const paths = Array.from(this.selectedPaths);
    const nestedRepos = this.entries.filter(
      e => paths.includes(e.path) && e.isNestedRepo
    );

    // Untracked files are unlinked outright: they exist in no git object and
    // there is no trash, so this is the one deletion in the app with no
    // recovery path at all. Discarding a SINGLE untracked file from the file
    // list raises a confirm the user cannot even switch off
    // (gn-file-status.ts confirmDiscard), so deleting 200 of them here must
    // not be the ungated route. The dialog's checkboxes are a selection UI,
    // not a confirmation.
    const confirmedDelete = await showConfirm(
      'Delete Untracked Files',
      `Permanently delete ${paths.length} item${paths.length === 1 ? '' : 's'}? ` +
        `They are not in Git and cannot be recovered.`,
      'warning'
    );
    if (!confirmedDelete) {
      this.cleaning = false;
      releaseRefOp(repoPath);
      return;
    }

    // A nested git repository additionally destroys that repo's whole history,
    // which `git clean` itself guards behind a second `-f` — so it gets its own
    // gate on top of the deletion confirm above.
    if (nestedRepos.length > 0) {
      const names = nestedRepos.map(e => e.path).join(', ');
      const confirmed = await showConfirm(
        nestedRepos.length === 1
          ? 'Delete Nested Repository'
          : 'Delete Nested Repositories',
        `${nestedRepos.length === 1 ? 'A nested git repository' : 'Nested git repositories'} ` +
          `(${names}) will be permanently deleted, including all its history. ` +
          `This cannot be undone. Continue?`,
        'warning'
      );
      if (!confirmed) {
        this.cleaning = false;
        releaseRefOp(repoPath);
        return;
      }
    }
    const forceNested = nestedRepos.length > 0;

    try {
      const result = await gitService.cleanFiles(repoPath, paths, forceNested);

      if (result.success) {
        // clean_files skips entries it cannot remove — nested repos without
        // force, directories holding tracked content, locked files — and
        // reports how many it actually deleted. The dialog closes immediately,
        // so without this the user sees no feedback at all and assumes every
        // selected file is gone.
        const removed = result.data ?? 0;
        const shortfall = paths.length - removed;
        showToast(
          shortfall > 0
            ? `Deleted ${removed} of ${paths.length} items — ${shortfall} could not be removed`
            : `Deleted ${removed} item${removed === 1 ? '' : 's'}`,
          shortfall > 0 ? 'warning' : 'success'
        );

        this.dispatchEvent(new CustomEvent('files-cleaned', {
          // repositoryPath so the host refreshes the repo the clean ran on —
          // the user may have switched tabs during the IPC await.
          detail: { count: removed, repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));
        this.close();
      } else {
        showToast(result.error?.message ?? 'Clean operation failed', 'error');
      }
    } catch (err) {
      console.error('Clean failed:', err);
      showToast('Clean operation failed', 'error');
    } finally {
      this.cleaning = false;
      releaseRefOp(repoPath);
    }
  }

  private formatSize(bytes: number | null): string {
    if (bytes === null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private getTotalSize(): number {
    return this.entries
      .filter(e => this.selectedPaths.has(e.path) && e.size !== null)
      .reduce((sum, e) => sum + (e.size ?? 0), 0);
  }

  private renderEntry(entry: CleanEntry) {
    const isSelected = this.selectedPaths.has(entry.path);

    return html`
      <div
        class="file-item ${isSelected ? 'selected' : ''}"
        @click=${() => this.toggleEntry(entry.path)}
      >
        <input
          type="checkbox"
          class="file-checkbox"
          .checked=${isSelected}
          @click=${(e: Event) => e.stopPropagation()}
          @change=${() => this.toggleEntry(entry.path)}
        />
        ${entry.isDirectory ? html`
          <svg class="file-icon directory" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"></path>
          </svg>
        ` : html`
          <svg class="file-icon ${entry.isIgnored ? 'ignored' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
        `}
        <div class="file-info">
          <span class="file-path" title="${entry.path}">${entry.path}</span>
          ${entry.isIgnored ? html`<span class="file-badge ignored">ignored</span>` : nothing}
          ${entry.isNestedRepo
            ? html`<span class="file-badge nested-repo">nested repo</span>`
            : entry.isDirectory
              ? html`<span class="file-badge directory">dir</span>`
              : nothing}
        </div>
        ${entry.size !== null ? html`
          <span class="file-size">${this.formatSize(entry.size)}</span>
        ` : nothing}
      </div>
    `;
  }

  render() {
    const allSelected = this.selectedPaths.size === this.entries.length && this.entries.length > 0;
    const someSelected = this.selectedPaths.size > 0;

    return html`
      <div class="overlay" @click=${this.handleOverlayClick}></div>
      <div class="dialog">
        <div class="header">
          <div class="header-left">
            <svg class="header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path>
            </svg>
            <span class="title">Clean Working Directory</span>
          </div>
          <button class="close-btn" @click=${this.dismiss}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="warning-banner">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
          <span>This will permanently delete selected files. This action cannot be undone.</span>
        </div>

        <div class="options">
          <label class="option">
            <input
              type="checkbox"
              .checked=${this.includeIgnored}
              @change=${(e: Event) => {
                this.includeIgnored = (e.target as HTMLInputElement).checked;
                this.handleOptionChange();
              }}
            />
            Include ignored files
          </label>
          <label class="option">
            <input
              type="checkbox"
              .checked=${this.includeDirectories}
              @change=${(e: Event) => {
                this.includeDirectories = (e.target as HTMLInputElement).checked;
                this.handleOptionChange();
              }}
            />
            Include directories
          </label>
        </div>

        ${this.entries.length > 0 ? html`
          <div class="select-all">
            <input
              type="checkbox"
              .checked=${allSelected}
              .indeterminate=${someSelected && !allSelected}
              @change=${() => this.toggleAll()}
            />
            <span>Select all (${this.entries.length} ${this.entries.length === 1 ? 'item' : 'items'})</span>
          </div>
        ` : nothing}

        <div class="content">
          ${this.loading
            ? html`<div class="loading">Scanning for untracked files...</div>`
            : this.entries.length === 0
              ? html`
                  <div class="empty">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path d="M22 11.08V12a10 10 0 11-5.93-9.14"></path>
                      <polyline points="22 4 12 14.01 9 11.01"></polyline>
                    </svg>
                    <div>Working directory is clean</div>
                    <div style="font-size: var(--font-size-xs); margin-top: var(--spacing-xs);">
                      No untracked files to remove
                    </div>
                  </div>
                `
              : html`
                  <div class="file-list">
                    ${this.entries.map(entry => this.renderEntry(entry))}
                  </div>
                `
          }
        </div>

        <div class="footer">
          <div class="footer-left">
            ${someSelected ? html`
              ${this.selectedPaths.size} selected
              ${this.getTotalSize() > 0 ? html` (${this.formatSize(this.getTotalSize())})` : nothing}
            ` : html`No files selected`}
          </div>
          <div class="footer-right">
            <!-- Cancel destroys nothing, so it is gated on this dialog's own
                 in-flight flag only. The lock check belongs on Delete, and was
                 copy-pasted onto Cancel in the same edit — greying out the most
                 obvious way to close the dialog whenever anything else touched
                 the repo, which reads as a broken dialog. dismiss() already
                 guards itself on the cleaning flag alone. -->
            <button class="btn btn-secondary" ?disabled=${this.cleaning} @click=${this.dismiss}>Cancel</button>
            <button
              class="btn btn-danger"
              ?disabled=${!someSelected || this.cleaning || isRefOpRunning(this.pinnedRepoPath)}
              @click=${this.handleClean}
            >
              ${this.cleaning ? 'Cleaning...' : 'Delete Selected'}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-clean-dialog': GnCleanDialog;
  }
}
