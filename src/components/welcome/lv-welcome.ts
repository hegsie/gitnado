/**
 * Welcome Screen Component
 * Shown when no repository is open
 */

import { LitElement, html, css } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { localized, msg, str } from '@lit/localize';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { repositoryStore, type RecentRepository } from '../../stores/index.ts';
import { workspaceStore } from '../../stores/workspace.store.ts';
import { openRepository } from '../../services/git.service.ts';
import { openRepositoryDialog, openDialog } from '../../services/dialog.service.ts';
import { openRepositoryPath } from '../../services/repository-open.service.ts';
import { showToast } from '../../services/notification.service.ts';
import * as workspaceService from '../../services/workspace.service.ts';
import type { Workspace } from '../../types/git.types.ts';
import { loggers } from '../../utils/logger.ts';

const log = loggers.ui;
import '../dialogs/lv-clone-dialog.ts';
import '../dialogs/lv-init-dialog.ts';
import type { LvCloneDialog } from '../dialogs/lv-clone-dialog.ts';
import type { LvInitDialog } from '../dialogs/lv-init-dialog.ts';
import mascotImage from '../../assets/mascot/gitnado-tower-400.png';

@customElement('lv-welcome')
@localized()
export class LvWelcome extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        align-items: center;
        height: 100%;
        /* Anchors the absolutely positioned drop overlay to the screen. */
        position: relative;
        padding: var(--spacing-xl);
        background: var(--color-bg-primary);
        overflow: auto;
      }

      .welcome-content {
        display: flex;
        flex-direction: column;
        align-items: center;
        max-width: 600px;
        text-align: center;
        margin: auto;
      }

      .mascot {
        width: 200px;
        height: auto;
        margin-bottom: var(--spacing-lg);
        border-radius: var(--radius-lg);
        opacity: 0.9;
        transition: opacity var(--transition-fast), transform var(--transition-fast);
      }

      .mascot:hover {
        opacity: 1;
        transform: scale(1.02);
      }

      .logo {
        font-size: 48px;
        font-weight: 700;
        color: var(--color-primary);
        margin-bottom: var(--spacing-md);
      }

      .tagline {
        font-size: var(--font-size-lg);
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-xl);
      }

      .actions {
        display: flex;
        gap: var(--spacing-md);
        margin-bottom: var(--spacing-xl);
      }

      .action-btn {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-lg);
        width: 140px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        background: var(--color-bg-secondary);
        color: var(--color-text-primary);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .action-btn:hover {
        background: var(--color-bg-hover);
        border-color: var(--color-primary);
      }

      .action-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .action-btn svg {
        width: 32px;
        height: 32px;
        color: var(--color-primary);
      }

      .action-btn span {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
      }

      .recent-section {
        width: 100%;
        max-width: 400px;
      }

      .recent-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--spacing-sm);
        padding-bottom: var(--spacing-xs);
        border-bottom: 1px solid var(--color-border);
      }

      .recent-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .clear-btn {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        background: none;
        border: none;
        cursor: pointer;
        padding: var(--spacing-xs);
      }

      .clear-btn:hover {
        color: var(--color-text-secondary);
      }

      .recent-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .recent-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-md);
        background: var(--color-bg-secondary);
        border: 1px solid transparent;
        cursor: pointer;
        transition: all var(--transition-fast);
        text-align: left;
      }

      .recent-item:hover {
        background: var(--color-bg-hover);
        border-color: var(--color-border);
      }

      .recent-icon {
        flex-shrink: 0;
        width: 20px;
        height: 20px;
        color: var(--color-text-muted);
      }

      .recent-info {
        flex: 1;
        min-width: 0;
      }

      .recent-name {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .recent-path {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .recent-remove {
        flex-shrink: 0;
        width: 20px;
        height: 20px;
        padding: 0;
        border: none;
        background: none;
        color: var(--color-text-muted);
        cursor: pointer;
        opacity: 0;
        transition: opacity var(--transition-fast);
      }

      .recent-item:hover .recent-remove,
      .recent-remove:focus-visible {
        opacity: 1;
      }

      .recent-remove:hover {
        color: var(--color-error);
      }

      .empty-recent {
        padding: var(--spacing-lg);
        text-align: center;
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }

      .workspace-section {
        width: 100%;
        max-width: 400px;
        margin-bottom: var(--spacing-lg);
      }

      .workspace-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--spacing-sm);
        padding-bottom: var(--spacing-xs);
        border-bottom: 1px solid var(--color-border);
      }

      .workspace-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .manage-btn {
        font-size: var(--font-size-xs);
        color: var(--color-primary);
        background: none;
        border: none;
        cursor: pointer;
        padding: var(--spacing-xs);
      }

      .manage-btn:hover {
        text-decoration: underline;
      }

      .workspace-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .workspace-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-md);
        background: var(--color-bg-secondary);
        border: 1px solid transparent;
        cursor: pointer;
        transition: all var(--transition-fast);
        text-align: left;
        width: 100%;
      }

      .workspace-item:hover {
        background: var(--color-bg-hover);
        border-color: var(--color-border);
      }

      .workspace-color-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .workspace-info {
        flex: 1;
        min-width: 0;
      }

      .workspace-name {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
      }

      .workspace-repo-count {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      /* Drop affordance: shown while a folder is dragged over the window so
         the user can see the drop will be accepted before letting go. */
      .drop-overlay {
        position: absolute;
        inset: var(--spacing-md);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--spacing-sm);
        border: 2px dashed var(--color-primary);
        border-radius: var(--radius-lg);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        z-index: 10;
        /* The OS owns the drag; the overlay must never swallow a pointer. */
        pointer-events: none;
      }

      .drop-overlay svg {
        width: 48px;
        height: 48px;
        color: var(--color-primary);
      }

      .drop-overlay-title {
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-medium);
      }

      .drop-overlay-hint {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        max-width: 380px;
        text-align: center;
      }
    `,
  ];

  /**
   * True while an OS drag is over the window. Owned by the shell, which is the
   * one place listening for the webview's drag events.
   */
  @property({ type: Boolean }) dragActive = false;

  @state() private recentRepositories: RecentRepository[] = [];
  @state() private workspaces: Workspace[] = [];
  @state() private isLoading = false;

  @query('lv-clone-dialog') private cloneDialog!: LvCloneDialog;
  @query('lv-init-dialog') private initDialog!: LvInitDialog;

  private unsubscribeRepo?: () => void;
  private unsubscribeWorkspace?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribeRepo = repositoryStore.subscribe((state) => {
      this.recentRepositories = state.recentRepositories;
      this.isLoading = state.isLoading;
    });
    this.unsubscribeWorkspace = workspaceStore.subscribe((state) => {
      this.workspaces = this.sortWorkspaces(state.workspaces);
    });
    // Initialize from current state
    const state = repositoryStore.getState();
    this.recentRepositories = state.recentRepositories;
    this.workspaces = this.sortWorkspaces(workspaceStore.getState().workspaces);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeRepo?.();
    this.unsubscribeWorkspace?.();
  }

  private sortWorkspaces(workspaces: Workspace[]): Workspace[] {
    return [...workspaces].sort((a, b) => {
      const aTime = a.lastOpened ?? a.createdAt;
      const bTime = b.lastOpened ?? b.createdAt;
      return bTime.localeCompare(aTime);
    });
  }

  private async handleOpen(): Promise<void> {
    log.debug('handleOpen called');
    try {
      const path = await openRepositoryDialog();
      log.debug('Got path:', path);
      if (!path) return;
      await this.openRepoByPath(path);
    } catch (error) {
      log.error('Error in handleOpen:', error);
      showToast(
        error instanceof Error ? error.message : msg('Failed to open repository'),
        'error',
      );
    }
  }

  private async openRepoByPath(path: string): Promise<void> {
    // Shared with the window drop handler and the scan results, so tabs, the
    // recent list and persistence behave identically however the repository
    // arrived — and an already-open repository focuses its tab.
    const outcome = await openRepositoryPath(path);
    if (outcome.status === 'error') {
      // repositoryStore.error has no render sink, so surface it directly.
      showToast(outcome.message ?? msg('Failed to open repository'), 'error');
    }
  }

  /**
   * Pick a folder and hand it to the scan dialog. The shell owns that dialog
   * so a folder dropped while a repository is open reaches the same surface.
   */
  private async handleScan(): Promise<void> {
    try {
      const result = await openDialog({
        title: msg('Scan Folder for Repositories'),
        directory: true,
        multiple: false,
      });
      const path = Array.isArray(result) ? result[0] : result;
      // A cancelled picker is not a failure and needs no feedback.
      if (!path) return;
      this.dispatchEvent(
        new CustomEvent<{ path: string; mode: 'scan' }>('open-repository-scan', {
          detail: { path, mode: 'scan' },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (error) {
      log.error('Error choosing a folder to scan:', error);
      showToast(
        error instanceof Error ? error.message : msg('Failed to choose a folder to scan'),
        'error',
      );
    }
  }

  /**
   * Open the init dialog, optionally pre-filled. Called by the shell when a
   * dropped folder is not a repository and the user chooses to initialize it —
   * while no repository is open this component owns the only init dialog.
   */
  public openInitDialog(path?: string): void {
    this.initDialog.open(path);
  }

  private handleClone(): void {
    this.cloneDialog.open();
  }

  private handleInit(): void {
    this.initDialog.open();
  }

  private handleRecentClick(path: string): void {
    this.openRepoByPath(path);
  }

  private handleRecentKeydown(e: KeyboardEvent, path: string): void {
    // The nested remove button's keydown bubbles up to the row, so activating
    // on it unconditionally would open the repository the user just removed.
    // Only the row itself activates.
    if (e.target !== e.currentTarget) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    this.handleRecentClick(path);
  }

  private handleRecentRemove(e: Event, path: string): void {
    e.stopPropagation();
    repositoryStore.getState().removeRecentRepository(path);
  }

  private handleRecentRemoveKeydown(e: KeyboardEvent, path: string): void {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // The global keyboard service claims Enter/Space and cancels them before
    // the browser turns them into a click, so the button needs to activate
    // itself. preventDefault also suppresses any native activation, keeping
    // the removal to exactly one call.
    e.preventDefault();
    e.stopPropagation();
    repositoryStore.getState().removeRecentRepository(path);
  }

  private handleClearRecent(): void {
    repositoryStore.getState().clearRecentRepositories();
  }

  private async handleWorkspaceClick(workspace: Workspace): Promise<void> {
    const store = repositoryStore.getState();

    // Open WITHOUT activating each repo: addRepository's default activation
    // would fire the per-activation side effects (index builds, integration
    // checks) once per repo — a 10-repo workspace would still kick off 10
    // concurrent history walks. Activate only the final repo; the rest get
    // their indexes lazily when their tab is first activated.
    let lastOpenedPath: string | null = null;
    let failedCount = 0;
    for (const repo of workspace.repositories) {
      const result = await openRepository({ path: repo.path });
      if (result.success && result.data) {
        store.addRepository(result.data, { activate: false });
        lastOpenedPath = result.data.path;
      } else {
        failedCount++;
      }
    }
    if (lastOpenedPath) {
      store.setActiveByPath(lastOpenedPath);
    }

    workspaceStore.getState().setActiveWorkspaceId(workspace.id);
    await workspaceService.updateWorkspaceLastOpened(workspace.id);
    // A repo that failed to open (moved, deleted) must not hide behind a
    // green success toast
    if (failedCount === 0) {
      showToast(msg(str`Opened workspace: ${workspace.name}`), 'success');
    } else if (lastOpenedPath) {
      showToast(
        msg(
          str`Opened workspace: ${workspace.name} (${failedCount} of ${workspace.repositories.length} repositories failed to open)`,
        ),
        'warning',
      );
    } else {
      showToast(
        msg(str`Could not open workspace: ${workspace.name} — no repository could be opened`),
        'error',
      );
    }
  }

  private handleManageWorkspaces(): void {
    this.dispatchEvent(new CustomEvent('open-workspace-manager', {
      bubbles: true,
      composed: true,
    }));
  }

  private handleOpenProfileManager(): void {
    this.dispatchEvent(new CustomEvent('open-profile-manager', {
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    return html`
      <lv-clone-dialog></lv-clone-dialog>
      <lv-init-dialog></lv-init-dialog>

      ${this.dragActive
        ? html`
            <div class="drop-overlay" role="status">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              </svg>
              <div class="drop-overlay-title">${msg('Drop a folder to open it')}</div>
              <div class="drop-overlay-hint">
                ${msg(
                  'Git repositories open straight away; any other folder can be scanned or initialized.'
                )}
              </div>
            </div>
          `
        : ''}

      <div class="welcome-content">
        <img class="mascot" src="${mascotImage}" alt=${msg('Gitnado - Dragon wrapped around a tower')} />
        <div class="logo">Gitnado</div>
        <p class="tagline">${msg('A powerful, open-source Git client')}</p>

        <div class="actions">
          <button
            class="action-btn"
            @click=${this.handleOpen}
            ?disabled=${this.isLoading}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
            <span>${msg('Open')}</span>
          </button>

          <button
            class="action-btn"
            @click=${this.handleClone}
            ?disabled=${this.isLoading}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
              <polyline points="10 9 13 12 10 15"></polyline>
            </svg>
            <span>${msg('Clone')}</span>
          </button>

          <button
            class="action-btn"
            @click=${this.handleInit}
            ?disabled=${this.isLoading}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            <span>${msg('Init')}</span>
          </button>

          <button
            class="action-btn"
            @click=${this.handleScan}
            ?disabled=${this.isLoading}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="7"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <span>${msg('Scan')}</span>
          </button>

          <button
            class="action-btn"
            @click=${this.handleOpenProfileManager}
            ?disabled=${this.isLoading}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
              <circle cx="12" cy="7" r="4"></circle>
            </svg>
            <span>${msg('Profiles & Accounts')}</span>
          </button>
        </div>

        ${this.workspaces.length > 0
          ? html`
              <div class="workspace-section">
                <div class="workspace-header">
                  <span class="workspace-title">${msg('Workspaces')}</span>
                  <button class="manage-btn" @click=${this.handleManageWorkspaces}>
                    ${msg('Manage')}
                  </button>
                </div>
                <div class="workspace-list">
                  ${this.workspaces.map(
                    (ws) => html`
                      <button
                        class="workspace-item"
                        @click=${() => this.handleWorkspaceClick(ws)}
                        ?disabled=${this.isLoading || ws.repositories.length === 0}
                      >
                        <span
                          class="workspace-color-dot"
                          style="background: ${ws.color || '#4fc3f7'}"
                        ></span>
                        <div class="workspace-info">
                          <div class="workspace-name">${ws.name}</div>
                          <div class="workspace-repo-count">${ws.repositories.length === 1
                            ? msg('1 repository')
                            : msg(str`${ws.repositories.length} repositories`)}</div>
                        </div>
                      </button>
                    `,
                  )}
                </div>
              </div>
            `
          : ''}

        ${this.recentRepositories.length > 0
          ? html`
              <div class="recent-section">
                <div class="recent-header">
                  <span class="recent-title">${msg('Recent Repositories')}</span>
                  <button class="clear-btn" @click=${this.handleClearRecent}>
                    ${msg('Clear')}
                  </button>
                </div>
                <div class="recent-list">
                  ${this.recentRepositories.map(
                    (repo) => html`
                      <div
                        class="recent-item"
                        role="button"
                        tabindex="0"
                        aria-label=${msg(str`Open ${repo.name}`)}
                        @click=${() => this.handleRecentClick(repo.path)}
                        @keydown=${(e: KeyboardEvent) => this.handleRecentKeydown(e, repo.path)}
                      >
                        <svg class="recent-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                        </svg>
                        <div class="recent-info">
                          <div class="recent-name">${repo.name}</div>
                          <div class="recent-path">${repo.path}</div>
                        </div>
                        <button
                          class="recent-remove"
                          title=${msg('Remove from recent repositories')}
                          aria-label=${msg(str`Remove ${repo.name} from recent repositories`)}
                          @click=${(e: Event) => this.handleRecentRemove(e, repo.path)}
                          @keydown=${(e: KeyboardEvent) => this.handleRecentRemoveKeydown(e, repo.path)}
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
              </div>
            `
          : html`
              <div class="recent-section">
                <div class="recent-header">
                  <span class="recent-title">${msg('Recent Repositories')}</span>
                </div>
                <div class="empty-recent">
                  ${msg('No recent repositories')}
                </div>
              </div>
            `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-welcome': LvWelcome;
  }
}
