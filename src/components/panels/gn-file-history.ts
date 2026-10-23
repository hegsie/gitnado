/**
 * File History Panel Component
 * Shows all commits that modified a specific file
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showToast } from '../../services/notification.service.ts';
import type { FileHistoryEntry } from '../../types/git.types.ts';
import { restoreFileFromCommit } from '../../utils/restore-file.ts';

interface HistoryContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  entry: FileHistoryEntry | null;
}

@customElement('gn-file-history')
export class GnFileHistory extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: var(--color-bg-primary);
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-bg-tertiary);
        border-bottom: 1px solid var(--color-border);
        flex-shrink: 0;
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        min-width: 0;
        flex: 1;
      }

      .header-icon {
        width: 18px;
        height: 18px;
        color: var(--color-text-secondary);
        flex-shrink: 0;
      }

      .header-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
      }

      .file-path {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        font-family: var(--font-mono);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .close-btn {
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
        transition: all var(--transition-fast);
        flex-shrink: 0;
      }

      .close-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .close-btn svg {
        width: 14px;
        height: 14px;
      }

      .content {
        flex: 1;
        overflow-y: auto;
      }

      .loading, .empty {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xl);
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }

      .error {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xl);
        color: var(--color-error);
        font-size: var(--font-size-sm);
      }

      .commit-list {
        display: flex;
        flex-direction: column;
      }

      .commit-item {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        padding: var(--spacing-sm) var(--spacing-md);
        border-bottom: 1px solid var(--color-border);
        cursor: pointer;
        transition: background var(--transition-fast);
      }

      .commit-item:hover {
        background: var(--color-bg-hover);
      }

      .commit-item.selected {
        background: var(--color-bg-selected);
      }

      .commit-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .commit-oid {
        font-family: var(--font-mono);
        font-size: var(--font-size-xs);
        color: var(--color-primary);
        flex-shrink: 0;
      }

      .commit-summary {
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
      }

      .commit-meta {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .commit-author {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .commit-author svg {
        width: 12px;
        height: 12px;
      }

      .commit-date {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .commit-date svg {
        width: 12px;
        height: 12px;
      }

      .commit-path {
        font-family: var(--font-mono);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .view-diff-btn {
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: var(--font-size-xs);
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-secondary);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .view-diff-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .commit-count {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        padding: 2px 6px;
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-sm);
      }

      /* Context menu */
      .context-menu {
        position: fixed;
        z-index: var(--z-dropdown, 100);
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

  @property({ type: String }) repositoryPath = '';
  @property({ type: String }) filePath = '';

  @state() private entries: FileHistoryEntry[] = [];
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private selectedCommit: string | null = null;
  @state() private contextMenu: HistoryContextMenuState = { visible: false, x: 0, y: 0, entry: null };

  private handleDocumentClick = (): void => {
    if (this.contextMenu.visible) {
      this.contextMenu = { ...this.contextMenu, visible: false };
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('click', this.handleDocumentClick);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('click', this.handleDocumentClick);
  }

  async updated(changedProps: Map<string, unknown>): Promise<void> {
    if (changedProps.has('filePath') || changedProps.has('repositoryPath')) {
      if (this.filePath && this.repositoryPath) {
        await this.loadHistory();
      }
    }
  }

  private async loadHistory(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.entries = [];

    try {
      const result = await gitService.getFileHistory(
        this.repositoryPath,
        this.filePath,
        100,
        true
      );

      if (result.success && result.data) {
        this.entries = result.data;
      } else if (!result.success) {
        this.error = result.error?.message ?? 'Failed to load file history';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to load file history';
      console.error('Failed to load file history:', err);
    } finally {
      this.loading = false;
    }
  }

  private handleClose(): void {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private handleCommitClick(entry: FileHistoryEntry): void {
    this.selectedCommit = entry.commit.oid;
    this.dispatchEvent(new CustomEvent('commit-selected', {
      detail: { commit: entry.commit },
      bubbles: true,
      composed: true,
    }));
  }

  private handleViewDiff(e: Event, entry: FileHistoryEntry): void {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent('view-diff', {
      // The path the file had AT THAT COMMIT, not this.filePath: before a
      // rename the current name does not exist in that commit's tree and the
      // diff would fail with "File not found in commit".
      detail: { commitOid: entry.commit.oid, filePath: entry.pathAtCommit },
      bubbles: true,
      composed: true,
    }));
  }

  private formatDate(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return 'Today';
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else if (diffDays < 7) {
      return `${diffDays} days ago`;
    } else if (diffDays < 30) {
      const weeks = Math.floor(diffDays / 7);
      return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
    } else if (diffDays < 365) {
      const months = Math.floor(diffDays / 30);
      return `${months} month${months > 1 ? 's' : ''} ago`;
    } else {
      return date.toLocaleDateString();
    }
  }

  // Context menu handlers
  private handleContextMenuOpen(e: MouseEvent, entry: FileHistoryEntry): void {
    e.preventDefault();
    e.stopPropagation();
    this.contextMenu = { visible: true, x: e.clientX, y: e.clientY, entry };
  }

  private handleContextViewDiff(): void {
    const entry = this.contextMenu.entry;
    if (!entry) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    this.handleViewDiff(new Event('click'), entry);
  }

  private handleContextShowCommit(): void {
    const entry = this.contextMenu.entry;
    if (!entry) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    this.handleCommitClick(entry);
  }

  private handleContextViewBlame(): void {
    const entry = this.contextMenu.entry;
    if (!entry) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    this.dispatchEvent(new CustomEvent('show-blame', {
      // Same reason as view-diff: blaming a pre-rename commit under the file's
      // current name fails, the file did not exist under it yet.
      detail: { filePath: entry.pathAtCommit, commitOid: entry.commit.oid },
      bubbles: true,
      composed: true,
    }));
  }

  /**
   * Restore this panel's file to its version in the right-clicked commit.
   *
   * No "can restore" guard, unlike the commit-details menu: with follow=true
   * the history can include the commit that DELETED the file, and nothing in
   * the row says which one that is. The backend's "File '<path>' not found in
   * commit <oid>" comes back through the helper as an error toast, which is
   * the honest outcome.
   *
   * `entry.pathAtCommit` — not `this.filePath` — is the path to restore: we
   * load with follow=true, so every commit from before a rename holds the
   * file under its OLD name and its tree does not contain the current one.
   * Falls back to this.filePath for a backend that did not report a path.
   */
  private async handleContextRestoreFile(): Promise<void> {
    const entry = this.contextMenu.entry;
    if (!entry || !this.repositoryPath || !this.filePath) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    await restoreFileFromCommit(
      this.repositoryPath,
      entry.pathAtCommit ?? this.filePath,
      entry.commit.oid,
      entry.commit.shortId
    );
  }

  private async handleContextCopyHash(): Promise<void> {
    const entry = this.contextMenu.entry;
    if (!entry) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    try {
      await navigator.clipboard.writeText(entry.commit.oid);
    } catch (err) {
      console.error('Failed to copy hash:', err);
      showToast('Failed to copy hash to clipboard', 'error');
    }
  }

  render() {
    return html`
      <div class="header">
        <div class="header-left">
          <svg class="header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"></circle>
            <line x1="12" y1="3" x2="12" y2="9"></line>
            <line x1="12" y1="15" x2="12" y2="21"></line>
          </svg>
          <div>
            <div class="header-title">File History</div>
            <div class="file-path" title="${this.filePath}">${this.filePath}</div>
          </div>
        </div>
        ${!this.loading ? html`
          <span class="commit-count">${this.entries.length} commits</span>
        ` : nothing}
        <button class="close-btn" @click=${this.handleClose} title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <div class="content">
        ${this.loading
          ? html`<div class="loading">Loading history...</div>`
          : this.error
            ? html`<div class="error">${this.error}</div>`
          : this.entries.length === 0
            ? html`<div class="empty">No history found for this file</div>`
            : html`
                <div class="commit-list">
                  ${this.entries.map(entry => html`
                    <div
                      class="commit-item ${this.selectedCommit === entry.commit.oid ? 'selected' : ''}"
                      @click=${() => this.handleCommitClick(entry)}
                      @contextmenu=${(e: MouseEvent) => this.handleContextMenuOpen(e, entry)}
                    >
                      <div class="commit-row">
                        <span class="commit-oid">${entry.commit.shortId}</span>
                        <span class="commit-summary">${entry.commit.summary}</span>
                        <button
                          class="view-diff-btn"
                          @click=${(e: Event) => this.handleViewDiff(e, entry)}
                          title="View diff of ${entry.pathAtCommit} at this commit"
                        >
                          View
                        </button>
                      </div>
                      <div class="commit-meta">
                        <span class="commit-author">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                            <circle cx="12" cy="7" r="4"></circle>
                          </svg>
                          ${entry.commit.author.name}
                        </span>
                        <span class="commit-date">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"></circle>
                            <polyline points="12 6 12 12 16 14"></polyline>
                          </svg>
                          ${this.formatDate(entry.commit.timestamp)}
                        </span>
                        ${entry.pathAtCommit !== this.filePath
                          ? html`<span class="commit-path" title="${entry.pathAtCommit}">${entry.pathAtCommit}</span>`
                          : nothing}
                      </div>
                    </div>
                  `)}
                </div>
              `}
      </div>
      ${this.renderContextMenu()}
    `;
  }

  private renderContextMenu() {
    if (!this.contextMenu.visible || !this.contextMenu.entry) return nothing;

    const { x, y } = this.contextMenu;

    return html`
      <div class="context-menu" style="left: ${x}px; top: ${y}px">
        <button class="context-menu-item" @click=${this.handleContextViewDiff}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 3v18M3 12h18"></path>
          </svg>
          View diff
        </button>
        <button class="context-menu-item" @click=${this.handleContextShowCommit}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"></circle>
            <line x1="12" y1="3" x2="12" y2="9"></line>
            <line x1="12" y1="15" x2="12" y2="21"></line>
          </svg>
          Show commit details
        </button>
        <button class="context-menu-item" @click=${this.handleContextViewBlame}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="16" y1="13" x2="8" y2="13"></line>
            <line x1="16" y1="17" x2="8" y2="17"></line>
          </svg>
          View blame at this commit
        </button>
        <button class="context-menu-item" @click=${this.handleContextRestoreFile}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path>
            <polyline points="3 3 3 8 8 8"></polyline>
          </svg>
          Restore this version
        </button>
        <div class="context-menu-divider"></div>
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
    'gn-file-history': GnFileHistory;
  }
}
