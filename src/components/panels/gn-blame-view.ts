import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { codeStyles } from '../../styles/code-styles.ts';
import { getFileBlame } from '../../services/git.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { formatRelativeTime } from '../../utils/format.ts';
import { CodeRenderMixin } from '../../mixins/code-render-mixin.ts';
import type { BlameLine } from '../../types/git.types.ts';

// Group of consecutive lines from the same commit
interface BlameGroup {
  commitOid: string;
  commitShortId: string;
  authorName: string;
  authorEmail: string;
  summary: string;
  timestamp: number;
  lines: BlameLine[];
}

interface BlameContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  group: BlameGroup | null;
  line: BlameLine | null;
}

// Generate consistent color for author
function getAuthorColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 50%, 55%)`;
}

@customElement('gn-blame-view')
export class GnBlameView extends CodeRenderMixin(LitElement) {
  static styles = [
    sharedStyles,
    codeStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-bg-tertiary);
        border-bottom: 1px solid var(--color-border);
        flex-shrink: 0;
        gap: var(--spacing-md);
      }

      .file-info {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        flex: 1;
        min-width: 0;
      }

      .file-icon {
        width: 16px;
        height: 16px;
        color: var(--color-text-muted);
        flex-shrink: 0;
      }

      .file-path {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .commit-badge {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: 2px 8px;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        font-size: 11px;
        color: var(--color-text-secondary);
        flex-shrink: 0;
      }

      .commit-badge code {
        color: var(--color-primary);
        font-weight: var(--font-weight-medium);
      }

      .close-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        border-radius: var(--radius-sm);
        transition: all var(--transition-fast);
        flex-shrink: 0;
      }

      .close-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .close-btn svg {
        width: 16px;
        height: 16px;
      }

      .blame-content {
        flex: 1;
        overflow: auto;
      }

      .blame-table {
        width: 100%;
        min-width: max-content;
      }

      /* Group container - holds commit info and lines together */
      .blame-group {
        display: flex;
        border-bottom: 1px solid var(--color-border);
      }

      .blame-group:last-child {
        border-bottom: none;
      }

      /* Left side: commit info panel */
      .group-info {
        display: flex;
        width: 240px;
        min-width: 240px;
        flex-shrink: 0;
        cursor: pointer;
        background: var(--color-bg-secondary);
        border-right: 1px solid var(--color-border);
        transition: background-color 0.1s ease;
      }

      .group-info:hover {
        background: var(--color-bg-hover);
      }

      .author-indicator {
        width: 3px;
        flex-shrink: 0;
      }

      .commit-details {
        display: flex;
        flex-direction: column;
        padding: var(--spacing-xs) var(--spacing-sm);
        gap: 2px;
        min-width: 0;
      }

      .commit-top-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .commit-hash {
        font-size: 11px;
        color: var(--color-primary);
        font-weight: var(--font-weight-medium);
        flex-shrink: 0;
      }

      .commit-message {
        font-size: 11px;
        color: var(--color-text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .commit-bottom-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        font-size: 10px;
        color: var(--color-text-muted);
      }

      .author-name {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100px;
      }

      .commit-date {
        white-space: nowrap;
        flex-shrink: 0;
      }

      /* Right side: lines container */
      .group-lines {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
      }

      .blame-line {
        display: flex;
        height: 20px;
        line-height: 20px;
      }

      .blame-line:hover {
        background: var(--color-bg-hover);
      }

      .line-number {
        width: 50px;
        min-width: 50px;
        padding: 0 var(--spacing-xs);
        flex-shrink: 0;
      }

      .line-content {
        flex: 1;
        padding: 0 var(--spacing-sm);
        white-space: pre;
        overflow-x: visible;
        color: var(--color-text-primary);
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--color-text-muted);
        gap: var(--spacing-sm);
      }

      .loading-spinner {
        width: 20px;
        height: 20px;
        border: 2px solid var(--color-border);
        border-top-color: var(--color-primary);
        border-radius: 50%;
        animation: spin 1s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      .error {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--color-error);
        padding: var(--spacing-lg);
        text-align: center;
        gap: var(--spacing-sm);
      }

      .error-icon {
        width: 48px;
        height: 48px;
        opacity: 0.5;
      }

      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--color-text-muted);
        padding: var(--spacing-lg);
        text-align: center;
      }

      .stats-bar {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        padding: var(--spacing-xs) var(--spacing-md);
        background: var(--color-bg-secondary);
        border-bottom: 1px solid var(--color-border);
        font-size: 11px;
        color: var(--color-text-muted);
      }

      .stat {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .stat-value {
        color: var(--color-text-primary);
        font-weight: var(--font-weight-medium);
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
        font-family: var(--font-family-base);
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
  @property({ type: String }) commitOid: string | null = null;

  @state() private lines: BlameLine[] = [];
  @state() private groups: BlameGroup[] = [];
  @state() private isLoading = false;
  @state() private error: string | null = null;
  @state() private contextMenu: BlameContextMenuState = { visible: false, x: 0, y: 0, group: null, line: null };

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
  private authorColors: Map<string, string> = new Map();
  private uniqueAuthors: Set<string> = new Set();
  private uniqueCommits: Set<string> = new Set();

  updated(changedProps: Map<string, unknown>): void {
    if (
      changedProps.has('filePath') ||
      changedProps.has('repositoryPath') ||
      changedProps.has('commitOid')
    ) {
      this.loadBlame();
    }
  }

  private async loadBlame(): Promise<void> {
    if (!this.repositoryPath || !this.filePath) {
      this.lines = [];
      this.groups = [];
      return;
    }

    this.isLoading = true;
    this.error = null;

    // Initialize Shiki highlighter and detect language
    await this.initCodeLanguage(this.filePath);

    try {
      const result = await getFileBlame(
        this.repositoryPath,
        this.filePath,
        this.commitOid ?? undefined
      );

      if (result.success && result.data) {
        this.lines = result.data.lines;
        this.processLinesIntoGroups();
      } else {
        this.error = result.error?.message ?? 'Failed to load blame';
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to load blame';
    } finally {
      this.isLoading = false;
    }
  }

  private processLinesIntoGroups(): void {
    this.authorColors.clear();
    this.uniqueAuthors.clear();
    this.uniqueCommits.clear();
    this.groups = [];

    if (this.lines.length === 0) return;

    let currentGroup: BlameGroup | null = null;

    for (const line of this.lines) {
      this.uniqueAuthors.add(line.authorName);
      this.uniqueCommits.add(line.commitOid);
      if (!this.authorColors.has(line.authorName)) {
        this.authorColors.set(line.authorName, getAuthorColor(line.authorName));
      }

      // Start a new group if commit changed
      if (!currentGroup || currentGroup.commitOid !== line.commitOid) {
        currentGroup = {
          commitOid: line.commitOid,
          commitShortId: line.commitShortId,
          authorName: line.authorName,
          authorEmail: line.authorEmail,
          summary: line.summary,
          timestamp: line.timestamp,
          lines: [],
        };
        this.groups.push(currentGroup);
      }

      currentGroup.lines.push(line);
    }
  }

  private handleClose(): void {
    this.dispatchEvent(new CustomEvent('close'));
  }

  private handleCommitClick(group: BlameGroup): void {
    this.dispatchEvent(
      new CustomEvent('commit-click', {
        detail: { oid: group.commitOid },
        bubbles: true,
        composed: true,
      })
    );
  }

  // Context menu handlers
  private handleContextMenu(e: MouseEvent, group: BlameGroup, line: BlameLine): void {
    e.preventDefault();
    e.stopPropagation();
    this.contextMenu = { visible: true, x: e.clientX, y: e.clientY, group, line };
  }

  private handleContextShowCommit(): void {
    const group = this.contextMenu.group;
    if (!group) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    this.handleCommitClick(group);
  }

  private async handleContextCopyHash(): Promise<void> {
    const group = this.contextMenu.group;
    if (!group) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    try {
      await navigator.clipboard.writeText(group.commitOid);
    } catch (err) {
      console.error('Failed to copy hash:', err);
      showToast('Failed to copy hash to clipboard', 'error');
    }
  }

  private async handleContextCopyLine(): Promise<void> {
    const line = this.contextMenu.line;
    if (!line) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    try {
      await navigator.clipboard.writeText(line.content);
    } catch (err) {
      console.error('Failed to copy line:', err);
      showToast('Failed to copy line to clipboard', 'error');
    }
  }

  private getFileName(): string {
    return this.filePath.split('/').pop() || this.filePath;
  }

  render() {
    if (this.isLoading) {
      return html`
        <div class="header">
          <div class="file-info">
            <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
            <span class="file-path">${this.filePath}</span>
          </div>
          <button class="close-btn" @click=${this.handleClose} title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div class="loading">
          <div class="loading-spinner"></div>
          <span>Loading blame...</span>
        </div>
      `;
    }

    if (this.error) {
      return html`
        <div class="header">
          <div class="file-info">
            <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
            <span class="file-path">${this.filePath}</span>
          </div>
          <button class="close-btn" @click=${this.handleClose} title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div class="error">
          <svg class="error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <span>${this.error}</span>
        </div>
      `;
    }

    if (!this.filePath) {
      return html`<div class="empty">Select a file to view blame</div>`;
    }

    return html`
      <div class="header">
        <div class="file-info">
          <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
          <span class="file-path" title="${this.filePath}">${this.getFileName()}</span>
        </div>
        ${this.commitOid ? html`
          <div class="commit-badge">
            <span>at</span>
            <code>${this.commitOid.substring(0, 7)}</code>
          </div>
        ` : nothing}
        <button class="close-btn" @click=${this.handleClose} title="Close blame view (Esc)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <div class="stats-bar">
        <div class="stat">
          <span>Lines:</span>
          <span class="stat-value">${this.lines.length}</span>
        </div>
        <div class="stat">
          <span>Authors:</span>
          <span class="stat-value">${this.uniqueAuthors.size}</span>
        </div>
        <div class="stat">
          <span>Commits:</span>
          <span class="stat-value">${this.uniqueCommits.size}</span>
        </div>
      </div>

      <div class="blame-content">
        <div class="blame-table">
          ${this.groups.map((group) => {
            const authorColor = this.authorColors.get(group.authorName) || '#888';

            return html`
              <div class="blame-group">
                <div
                  class="group-info"
                  @click=${() => this.handleCommitClick(group)}
                  title="${group.summary}&#10;&#10;${group.authorName}&#10;${new Date(group.timestamp * 1000).toLocaleString()}"
                >
                  <div
                    class="author-indicator"
                    style="background: ${authorColor}"
                  ></div>
                  <div class="commit-details">
                    <div class="commit-top-row">
                      <span class="commit-hash">${group.commitShortId}</span>
                      <span class="commit-message">${group.summary}</span>
                    </div>
                    <div class="commit-bottom-row">
                      <span class="author-name" style="color: ${authorColor}">${group.authorName}</span>
                      <span>•</span>
                      <!-- Seconds, not milliseconds: formatRelativeTime does the
                           *1000 itself. Converting here too made every diff
                           hugely negative, so "seconds < 60" always won and
                           every blame group read "just now" — contradicting the
                           tooltip above, which formats the same value correctly. -->
                      <span class="commit-date">${formatRelativeTime(group.timestamp)}</span>
                    </div>
                  </div>
                </div>
                <div class="group-lines">
                  ${group.lines.map(
                    (line) => html`
                      <div
                        class="blame-line"
                        @contextmenu=${(e: MouseEvent) => this.handleContextMenu(e, group, line)}
                      >
                        <div class="line-number code-line-no">${line.lineNumber}</div>
                        <div class="line-content">${this.renderHighlightedContent(line.content)}</div>
                      </div>
                    `
                  )}
                </div>
              </div>
            `;
          })}
        </div>
      </div>
      ${this.renderContextMenu()}
    `;
  }

  private renderContextMenu() {
    if (!this.contextMenu.visible) return nothing;

    const { x, y } = this.contextMenu;

    return html`
      <div class="context-menu" style="left: ${x}px; top: ${y}px">
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
        <div class="context-menu-divider"></div>
        <button class="context-menu-item" @click=${this.handleContextCopyLine}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          Copy line
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-blame-view': GnBlameView;
  }
}
