/**
 * Remote Management Dialog
 * Add, edit, remove, and rename git remotes
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import { showToast } from '../../services/notification.service.ts';
import type { Remote } from '../../types/git.types.ts';
import { pushOverlay, removeOverlay, isTopOverlay } from '../../utils/overlay-stack.ts';

type DialogMode = 'list' | 'add' | 'edit' | 'rename';

@customElement('gn-remote-dialog')
export class GnRemoteDialog extends LitElement {
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
        width: 500px;
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

      .back-btn {
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

      .back-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .back-btn svg {
        width: 16px;
        height: 16px;
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
        padding: var(--spacing-md);
      }

      .remote-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .remote-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        transition: all var(--transition-fast);
      }

      .remote-item:hover {
        border-color: var(--color-primary);
      }

      .remote-icon {
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--color-bg-secondary);
        border-radius: var(--radius-md);
        color: var(--color-text-muted);
      }

      .remote-icon svg {
        width: 18px;
        height: 18px;
      }

      .remote-info {
        flex: 1;
        min-width: 0;
      }

      .remote-name {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        margin-bottom: 2px;
      }

      .remote-url {
        font-size: var(--font-size-xs);
        font-family: var(--font-mono);
        color: var(--color-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .remote-actions {
        display: flex;
        gap: var(--spacing-xs);
      }

      .action-btn {
        width: 28px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .action-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .action-btn.danger:hover {
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      .action-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .action-btn:disabled:hover {
        background: transparent;
        color: var(--color-text-secondary);
      }

      .action-btn svg {
        width: 14px;
        height: 14px;
      }

      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xl);
        color: var(--color-text-muted);
        text-align: center;
      }

      .empty-state svg {
        width: 48px;
        height: 48px;
        margin-bottom: var(--spacing-md);
        opacity: 0.5;
      }

      .form {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
      }

      .form-group {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .form-label {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
      }

      .form-input {
        padding: var(--spacing-sm);
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        font-family: inherit;
        transition: border-color var(--transition-fast);
      }

      .form-input:focus {
        outline: none;
        border-color: var(--color-primary);
      }

      .form-input.mono {
        font-family: var(--font-mono);
      }

      .form-hint {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .footer {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: var(--spacing-sm);
        padding: var(--spacing-md) var(--spacing-lg);
        border-top: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
      }

      .footer-left {
        flex: 1;
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

      .btn-primary {
        background: var(--color-primary);
        border: 1px solid var(--color-primary);
        color: var(--color-text-inverse);
      }

      .btn-primary:hover {
        background: var(--color-primary-hover);
      }

      .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .error {
        padding: var(--spacing-sm);
        background: var(--color-error-bg);
        border-radius: var(--radius-md);
        color: var(--color-error);
        font-size: var(--font-size-sm);
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xl);
        color: var(--color-text-muted);
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: String }) repositoryPath = '';

  @state() private remotes: Remote[] = [];
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private mode: DialogMode = 'list';
  @state() private editingRemote: Remote | null = null;

  // Form state
  @state() private formName = '';
  @state() private formUrl = '';
  @state() private formPushUrl = '';
  @state() private saving = false;
  @state() private fetchingRemote: string | null = null;
  @state() private pruningRemote: string | null = null;
  /** Keyed like its Fetch/Prune siblings in the same row. */
  @state() private removingRemote: string | null = null;

  /**
   * Repo captured when the dialog opened. `repositoryPath` is live-bound to
   * the ACTIVE repository and rebinds the instant the user Ctrl+Tabs — a
   * document-level shortcut this dialog's overlay does not block. The remotes
   * on screen belong to the repo that was active at open, so removing or
   * pruning one must target THAT repo: reading the live prop removed "origin"
   * from whichever repo the user had switched to.
   */
  private pinnedRepoPath = '';

  /** The repo this dialog is pinned to while open, or null when closed. */
  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.open ? this.pinnedRepoPath : null;
  }

  /**
   * True while a remote is being added/renamed/removed/pruned/fetched. The
   * host's tab-close sweep must not report "remote management closed" over a
   * write that is still landing in the closed repo's config.
   */
  public get operationInFlight(): boolean {
    return (
      this.saving ||
      this.pruningRemote !== null ||
      this.removingRemote !== null ||
      this.fetchingRemote !== null
    );
  }

  async updated(changedProps: Map<string, unknown>): Promise<void> {
    // Announce/withdraw overlay ownership of Escape.
    if (changedProps.has('open')) {
      if (this.open) { pushOverlay(this); } else { removeOverlay(this); }
    }
    if (changedProps.has('open') && this.open) {
      this.pinnedRepoPath = this.repositoryPath;
      await this.loadRemotes();
    }
  }

  private async loadRemotes(): Promise<void> {
    if (!this.pinnedRepoPath) return;

    this.loading = true;
    this.error = null;

    try {
      const result = await gitService.getRemotes(this.pinnedRepoPath);
      if (result.success && result.data) {
        this.remotes = result.data;
      } else {
        this.error = result.error?.message ?? 'Failed to load remotes';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Unknown error';
    } finally {
      this.loading = false;
    }
  }

  private handleOverlayClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) {
      this.close();
    }
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    // Only the topmost overlay owns Escape: every dialog listens on
    // `document`, so without this one keypress ran all of them.
    if (!this.open || !isTopOverlay(this)) return;
    if (e.key === 'Escape') {
      if (this.mode !== 'list') {
        this.resetForm();
      } else {
        this.close();
      }
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this.handleKeyDown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    removeOverlay(this);
    document.removeEventListener('keydown', this.handleKeyDown);
  }

  public close(): void {
    this.open = false;
    this.mode = 'list';
    this.resetForm();
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private resetForm(): void {
    this.mode = 'list';
    this.editingRemote = null;
    this.formName = '';
    this.formUrl = '';
    this.formPushUrl = '';
    this.error = null;
  }

  private startAdd(): void {
    this.mode = 'add';
    this.formName = '';
    this.formUrl = '';
    this.formPushUrl = '';
    this.error = null;
  }

  private startEdit(remote: Remote): void {
    this.mode = 'edit';
    this.editingRemote = remote;
    this.formName = remote.name;
    this.formUrl = remote.url;
    this.formPushUrl = remote.pushUrl ?? '';
    this.error = null;
  }

  private startRename(remote: Remote): void {
    this.mode = 'rename';
    this.editingRemote = remote;
    this.formName = remote.name;
    this.error = null;
  }

  private async handleAdd(): Promise<void> {
    if (!this.formName.trim() || !this.formUrl.trim()) return;

    this.saving = true;
    this.error = null;

    try {
      const result = await gitService.addRemote(
        this.pinnedRepoPath,
        this.formName.trim(),
        this.formUrl.trim()
      );

      if (result.success) {
        await this.loadRemotes();
        this.resetForm();
        this.dispatchEvent(new CustomEvent('remotes-changed', { bubbles: true, composed: true }));
      } else {
        this.error = result.error?.message ?? 'Failed to add remote';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Unknown error';
    } finally {
      this.saving = false;
    }
  }

  private async handleSaveUrl(): Promise<void> {
    if (!this.editingRemote || !this.formUrl.trim()) return;

    this.saving = true;
    this.error = null;

    try {
      // Update fetch URL
      let result = await gitService.setRemoteUrl(
        this.pinnedRepoPath,
        this.editingRemote.name,
        this.formUrl.trim(),
        false
      );

      if (!result.success) {
        this.error = result.error?.message ?? 'Failed to update URL';
        return;
      }

      // An empty push URL — or one equal to the fetch URL — means "push where
      // you fetch". Send the empty URL through so the backend unsets it;
      // skipping the write would silently leave the old push destination in
      // place. Nothing to do when the remote never had a push URL.
      const pushUrl = this.formPushUrl.trim();
      const wantsPushUrl = pushUrl !== '' && pushUrl !== this.formUrl.trim();
      const hadPushUrl = (this.editingRemote.pushUrl ?? '') !== '';

      if (wantsPushUrl || hadPushUrl) {
        result = await gitService.setRemoteUrl(
          this.pinnedRepoPath,
          this.editingRemote.name,
          wantsPushUrl ? pushUrl : '',
          true
        );

        if (!result.success) {
          this.error =
            result.error?.message ??
            (wantsPushUrl ? 'Failed to update push URL' : 'Failed to clear push URL');
          return;
        }
      }

      await this.loadRemotes();
      this.resetForm();
      this.dispatchEvent(new CustomEvent('remotes-changed', { bubbles: true, composed: true }));
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Unknown error';
    } finally {
      this.saving = false;
    }
  }

  private async handleRename(): Promise<void> {
    if (!this.editingRemote || !this.formName.trim()) return;
    if (this.formName.trim() === this.editingRemote.name) {
      this.resetForm();
      return;
    }

    this.saving = true;
    this.error = null;

    try {
      const result = await gitService.renameRemote(
        this.pinnedRepoPath,
        this.editingRemote.name,
        this.formName.trim()
      );

      if (result.success) {
        await this.loadRemotes();
        this.resetForm();
        this.dispatchEvent(new CustomEvent('remotes-changed', { bubbles: true, composed: true }));
      } else {
        this.error = result.error?.message ?? 'Failed to rename remote';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Unknown error';
    } finally {
      this.saving = false;
    }
  }

  private async handleFetchRemote(remote: Remote): Promise<void> {
    this.fetchingRemote = remote.name;
    try {
      const result = await gitService.fetch({
        path: this.pinnedRepoPath,
        remote: remote.name,
        silent: true,
      });
      if (result.success) {
        showToast(`Fetched from ${remote.name}`, 'success');
        this.dispatchEvent(new CustomEvent('remotes-changed', { bubbles: true, composed: true }));
      } else if (!gitService.isNetworkGateRefusal(result.error)) {
        // A gate refusal already announced itself, and a declined confirm is
        // the user's own decision — reporting either back is a lie.
        showToast(`Fetch failed: ${result.error?.message ?? 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showToast(`Fetch failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    } finally {
      this.fetchingRemote = null;
    }
  }

  private async handlePruneRemote(remote: Remote): Promise<void> {
    this.pruningRemote = remote.name;
    try {
      const result = await gitService.pruneRemoteTrackingBranches(
        this.pinnedRepoPath,
        remote.name,
      );
      if (result.success && result.data) {
        const count = result.data.branchesPruned.length;
        if (count === 0) {
          showToast(`Nothing to prune from ${remote.name}`, 'info');
        } else {
          showToast(`Pruned ${count} stale tracking branch${count !== 1 ? 'es' : ''} from ${remote.name}`, 'success');
          await this.loadRemotes();
          this.dispatchEvent(new CustomEvent('remotes-changed', { bubbles: true, composed: true }));
        }
      } else if (!gitService.isNetworkGateRefusal(result.error)) {
        showToast(`Prune failed: ${result.error?.message ?? 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showToast(`Prune failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    } finally {
      this.pruningRemote = null;
    }
  }

  private async handleRemove(remote: Remote): Promise<void> {
    // Claimed BEFORE the confirm, not after — and this button had no in-flight
    // state at all, unlike the Fetch and Prune buttons beside it. showConfirm
    // is an IPC round trip before the native dialog takes focus, so a
    // double-click stacked two prompts for the same remote and the second
    // removal then failed against a reference that was already gone,
    // contradicting the success the user just read.
    if (this.removingRemote === remote.name) return;
    this.removingRemote = remote.name;

    // The repo the listed remotes were read from — NOT the live prop, which
    // rebinds on a tab switch and would remove "origin" from the repo the
    // user switched to while this list still showed the old one's.
    const repoPath = this.pinnedRepoPath;

    const confirmed = await showConfirm(
      'Remove Remote',
      `Are you sure you want to remove the remote "${remote.name}"?\n\nThis will not delete the remote repository, only the local reference.`,
      'warning'
    );

    if (!confirmed) {
      this.removingRemote = null;
      return;
    }

    // Clear any inline error left over from a previous form action (add /
    // edit / rename) — the template still renders this.error and a stale
    // banner would persist across the toast-based remove flow otherwise.
    this.error = null;

    try {
      const result = await gitService.removeRemote(repoPath, remote.name);

      if (result.success) {
        await this.loadRemotes();
        this.dispatchEvent(new CustomEvent('remotes-changed', { bubbles: true, composed: true }));
        showToast(`Removed remote ${remote.name}`, 'success');
      } else {
        // Match the toast pattern used by sibling list-row actions
        // (handleFetchRemote, handlePruneRemote).
        showToast(
          `Failed to remove remote: ${result.error?.message ?? 'Unknown error'}`,
          'error',
        );
      }
    } catch (err) {
      showToast(
        `Failed to remove remote: ${err instanceof Error ? err.message : 'Unknown error'}`,
        'error',
      );
    } finally {
      this.removingRemote = null;
    }
  }

  private getTitle(): string {
    switch (this.mode) {
      case 'add': return 'Add Remote';
      case 'edit': return 'Edit Remote URL';
      case 'rename': return 'Rename Remote';
      default: return 'Remotes';
    }
  }

  private renderRemoteList() {
    if (this.loading) {
      return html`<div class="loading">Loading remotes...</div>`;
    }

    if (this.remotes.length === 0) {
      return html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="2" y1="12" x2="22" y2="12"></line>
            <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"></path>
          </svg>
          <div>No remotes configured</div>
          <div style="font-size: var(--font-size-xs); margin-top: var(--spacing-xs);">
            Add a remote to push and pull changes
          </div>
        </div>
        ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
      `;
    }

    return html`
      ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
      <div class="remote-list">
        ${this.remotes.map(remote => html`
          <div class="remote-item">
            <div class="remote-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"></path>
              </svg>
            </div>
            <div class="remote-info">
              <div class="remote-name">${remote.name}</div>
              <div class="remote-url" title="${remote.url}">${remote.url}</div>
              ${remote.pushUrl && remote.pushUrl !== remote.url ? html`
                <div class="remote-url" title="Push: ${remote.pushUrl}">Push: ${remote.pushUrl}</div>
              ` : nothing}
            </div>
            <div class="remote-actions">
              <button
                class="action-btn"
                title="Fetch"
                ?disabled=${this.fetchingRemote === remote.name}
                @click=${() => this.handleFetchRemote(remote)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="8 17 12 21 16 17"></polyline>
                  <line x1="12" y1="12" x2="12" y2="21"></line>
                  <path d="M20.88 18.09A5 5 0 0018 9h-1.26A8 8 0 103 16.29"></path>
                </svg>
              </button>
              <button
                class="action-btn"
                title="Prune stale tracking branches"
                ?disabled=${this.pruningRemote === remote.name}
                @click=${() => this.handlePruneRemote(remote)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="6" cy="6" r="3"></circle>
                  <path d="M8.12 8.12L12 12"></path>
                  <path d="M20 4L8.12 15.88"></path>
                  <circle cx="6" cy="18" r="3"></circle>
                  <path d="M14.8 14.8L20 20"></path>
                </svg>
              </button>
              <button
                class="action-btn"
                title="Edit URL"
                @click=${() => this.startEdit(remote)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
                </svg>
              </button>
              <button
                class="action-btn"
                title="Rename"
                @click=${() => this.startRename(remote)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"></path>
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
              </button>
              <button
                class="action-btn danger"
                title="Remove"
                ?disabled=${this.removingRemote === remote.name}
                @click=${() => this.handleRemove(remote)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path>
                </svg>
              </button>
            </div>
          </div>
        `)}
      </div>
    `;
  }

  private renderAddForm() {
    return html`
      <div class="form">
        <div class="form-group">
          <label class="form-label">Name</label>
          <input
            type="text"
            class="form-input"
            placeholder="e.g., origin, upstream"
            .value=${this.formName}
            @input=${(e: Event) => { this.formName = (e.target as HTMLInputElement).value; }}
          />
          <div class="form-hint">A short name to identify this remote</div>
        </div>
        <div class="form-group">
          <label class="form-label">URL</label>
          <input
            type="text"
            class="form-input mono"
            placeholder="https://github.com/user/repo.git"
            .value=${this.formUrl}
            @input=${(e: Event) => { this.formUrl = (e.target as HTMLInputElement).value; }}
          />
          <div class="form-hint">HTTPS or SSH URL of the remote repository</div>
        </div>
        ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
      </div>
    `;
  }

  private renderEditForm() {
    return html`
      <div class="form">
        <div class="form-group">
          <label class="form-label">Fetch URL</label>
          <input
            type="text"
            class="form-input mono"
            .value=${this.formUrl}
            @input=${(e: Event) => { this.formUrl = (e.target as HTMLInputElement).value; }}
          />
        </div>
        <div class="form-group">
          <label class="form-label">Push URL (optional)</label>
          <input
            type="text"
            class="form-input mono"
            placeholder="Same as fetch URL if empty"
            .value=${this.formPushUrl}
            @input=${(e: Event) => { this.formPushUrl = (e.target as HTMLInputElement).value; }}
          />
          <div class="form-hint">Set a different URL for push operations</div>
        </div>
        ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
      </div>
    `;
  }

  private renderRenameForm() {
    return html`
      <div class="form">
        <div class="form-group">
          <label class="form-label">New Name</label>
          <input
            type="text"
            class="form-input"
            .value=${this.formName}
            @input=${(e: Event) => { this.formName = (e.target as HTMLInputElement).value; }}
          />
        </div>
        ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
      </div>
    `;
  }

  private renderContent() {
    switch (this.mode) {
      case 'add': return this.renderAddForm();
      case 'edit': return this.renderEditForm();
      case 'rename': return this.renderRenameForm();
      default: return this.renderRemoteList();
    }
  }

  private renderFooter() {
    if (this.mode === 'list') {
      return html`
        <div class="footer-left"></div>
        <button class="btn btn-primary" @click=${this.startAdd}>
          Add Remote
        </button>
      `;
    }

    const canSave = this.mode === 'add'
      ? this.formName.trim() && this.formUrl.trim()
      : this.mode === 'rename'
        ? this.formName.trim() && this.formName !== this.editingRemote?.name
        : this.formUrl.trim();

    const handleSave = this.mode === 'add'
      ? () => this.handleAdd()
      : this.mode === 'rename'
        ? () => this.handleRename()
        : () => this.handleSaveUrl();

    return html`
      <button class="btn btn-secondary" @click=${this.resetForm}>Cancel</button>
      <button
        class="btn btn-primary"
        ?disabled=${!canSave || this.saving}
        @click=${handleSave}
      >
        ${this.saving ? 'Saving...' : 'Save'}
      </button>
    `;
  }

  render() {
    return html`
      <div class="overlay" @click=${this.handleOverlayClick}></div>
      <div class="dialog">
        <div class="header">
          <div class="header-left">
            ${this.mode !== 'list' ? html`
              <button class="back-btn" @click=${this.resetForm}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
              </button>
            ` : html`
              <svg class="header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"></path>
              </svg>
            `}
            <span class="title">${this.getTitle()}</span>
          </div>
          <button class="close-btn" @click=${this.close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="content">
          ${this.renderContent()}
        </div>

        <div class="footer">
          ${this.renderFooter()}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-remote-dialog': GnRemoteDialog;
  }
}
