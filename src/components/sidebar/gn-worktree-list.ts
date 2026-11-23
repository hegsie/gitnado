/**
 * Worktree List Component
 * First-class sidebar component for viewing, switching, opening, and managing Git worktrees.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import type { Worktree } from '../../services/git.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { repositoryStore } from '../../stores/repository.store.ts';
import { samePath } from '../../utils/path-compare.ts';
import { isTopOverlay } from '../../utils/overlay-stack.ts';
import {
  tryAcquireRefOpOrWarn,
  releaseRefOp,
  isRefOpRunning,
  subscribeRefOps,
} from '../../utils/ref-lock.ts';

interface WorktreeContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  worktree: Worktree | null;
}

/**
 * Close any open repository tabs matching the removed worktree path,
 * and prune them from persisted open repositories so deleted worktree tabs
 * never linger or fail to resolve on disk.
 */
export function closeRemovedWorktreeTab(worktreePath: string): void {
  const store = repositoryStore.getState();
  const matching = store.openRepositories.filter((r) =>
    samePath(r.repository.path, worktreePath),
  );
  for (const entry of matching) {
    store.removeRepository(entry.repository.path);
    store.prunePersistedRepo(entry.repository.path);
  }
  const persistedMatches = store.persistedOpenRepos.filter((r) =>
    samePath(r.path, worktreePath),
  );
  for (const p of persistedMatches) {
    store.prunePersistedRepo(p.path);
  }
}

/**
 * Switch to an already-open tab for `worktreePath`, or open it as a new tab.
 */
export async function openOrSwitchWorktreeTab(worktreePath: string): Promise<boolean> {
  const store = repositoryStore.getState();
  const existingIndex = store.openRepositories.findIndex((r) =>
    samePath(r.repository.path, worktreePath),
  );
  if (existingIndex >= 0) {
    store.setActiveIndex(existingIndex);
    return true;
  }

  const result = await gitService.openRepository({ path: worktreePath });
  if (!result.success || !result.data) {
    showToast(
      result.error?.message ?? `Failed to open worktree at "${worktreePath}"`,
      'error',
    );
    return false;
  }

  store.addRepository(result.data);
  return true;
}

@customElement('gn-worktree-list')
export class GnWorktreeList extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .worktree-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .worktree-item {
        --gn-focus-ring-offset: -2px;
        position: relative;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 10px;
        cursor: pointer;
        font-size: var(--font-size-sm);
        border-left: 2px solid transparent;
      }

      .worktree-item:hover {
        background: var(--color-bg-hover);
      }

      .worktree-item.current {
        background: var(--color-primary-bg);
        border-left-color: var(--color-primary);
      }

      .worktree-item.prunable {
        opacity: 0.65;
      }

      .worktree-icon {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        color: var(--color-text-muted);
      }

      .worktree-item.current .worktree-icon {
        color: var(--color-primary);
      }

      .worktree-info {
        flex: 1;
        min-width: 0;
      }

      .worktree-header {
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
      }

      .worktree-branch {
        flex: 1;
        min-width: 0;
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .worktree-path {
        font-size: 11px;
        color: var(--color-text-muted);
        font-family: var(--font-family-mono);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .badge {
        padding: 0 4px;
        border-radius: var(--radius-xs);
        font-size: 9px;
        line-height: 14px;
        font-weight: var(--font-weight-medium);
        flex-shrink: 0;
      }

      .badge.current {
        background: var(--color-primary);
        color: #fff;
      }

      .badge.open-tab {
        background: var(--color-bg-tertiary);
        color: var(--color-primary);
        border: 1px solid var(--color-primary);
      }

      .badge.main {
        background: var(--color-bg-tertiary);
        color: var(--color-text-secondary);
      }

      .badge.locked {
        background: var(--color-warning-bg, rgba(245, 158, 11, 0.15));
        color: var(--color-warning, #f59e0b);
      }

      .badge.prunable {
        background: var(--color-error-bg, rgba(239, 68, 68, 0.15));
        color: var(--color-error);
      }

      .row-actions {
        position: absolute;
        right: 6px;
        top: 50%;
        transform: translateY(-50%);
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 2px 4px;
        border-radius: var(--radius-sm);
        background: var(--color-bg-hover);
        box-shadow: -8px 0 8px var(--color-bg-hover);
        opacity: 0;
        pointer-events: none;
        transition: opacity var(--transition-fast);
        flex-shrink: 0;
      }

      .worktree-item:hover .row-actions,
      .worktree-item:focus-within .row-actions {
        opacity: 1;
        pointer-events: auto;
      }

      .row-action-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        padding: 0;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
      }

      .row-action-btn:hover:not(:disabled) {
        background: var(--color-bg-tertiary);
        color: var(--color-text-primary);
      }

      .row-action-btn.danger:hover:not(:disabled) {
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      .row-action-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .row-action-btn svg {
        width: 13px;
        height: 13px;
      }

      .worktree-footer-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        padding: 4px 8px;
        border-bottom: 1px solid var(--color-border);
        background: var(--color-bg-secondary);
      }

      .worktree-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        flex: 1;
        min-width: 0;
        padding: 3px 6px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        font-family: inherit;
        font-size: 11px;
        white-space: nowrap;
        cursor: pointer;
      }

      .worktree-btn:hover:not(:disabled) {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .worktree-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }

      .worktree-btn svg {
        width: 12px;
        height: 12px;
        flex-shrink: 0;
      }

      .empty {
        padding: 4px 8px;
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
        text-align: center;
      }

      .error {
        padding: 4px 8px;
        color: var(--color-error);
        font-size: var(--font-size-sm);
        text-align: center;
        overflow-wrap: anywhere;
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-md);
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }

      .context-menu {
        position: fixed;
        z-index: var(--z-dropdown, 100);
        min-width: 170px;
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
        flex-shrink: 0;
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

  @property({ type: String }) repositoryPath = '';

  @state() private worktrees: Worktree[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private contextMenu: WorktreeContextMenuState = {
    visible: false,
    x: 0,
    y: 0,
    worktree: null,
  };
  @state() private refOpsVersion = 0;
  @state() private openRepoPaths: string[] = [];

  private unsubscribeRefOps?: () => void;
  private unsubscribeStore?: () => void;
  private loadSeq = new Map<string, number>();

  private get operationInProgress(): boolean {
    void this.refOpsVersion;
    return isRefOpRunning(this.repositoryPath);
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribeRefOps = subscribeRefOps(() => {
      this.refOpsVersion++;
    });
    this.openRepoPaths = repositoryStore
      .getState()
      .openRepositories.map((r) => r.repository.path);
    this.unsubscribeStore = repositoryStore.subscribe((state) => {
      this.openRepoPaths = state.openRepositories.map((r) => r.repository.path);
    });
    document.addEventListener('click', this.handleDocumentClick);
    document.addEventListener('keydown', this.handleKeydown);
    window.addEventListener('repository-refresh', this.handleRepositoryRefresh);
    if (this.repositoryPath) {
      void this.loadWorktrees();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeRefOps?.();
    this.unsubscribeRefOps = undefined;
    this.unsubscribeStore?.();
    this.unsubscribeStore = undefined;
    document.removeEventListener('click', this.handleDocumentClick);
    document.removeEventListener('keydown', this.handleKeydown);
    window.removeEventListener('repository-refresh', this.handleRepositoryRefresh);
  }

  async updated(changedProperties: Map<string, unknown>): Promise<void> {
    if (changedProperties.has('repositoryPath')) {
      this.contextMenu = { ...this.contextMenu, visible: false };
      this.worktrees = [];
      this.error = null;
      this.dispatchCount(0);
      if (this.repositoryPath) {
        await this.loadWorktrees();
      }
    }
  }

  public async refresh(): Promise<void> {
    await this.loadWorktrees();
  }

  private handleRepositoryRefresh = (e: Event): void => {
    const detail = (e as CustomEvent<{ repoPath?: string }>).detail;
    if (detail?.repoPath && detail.repoPath !== this.repositoryPath) return;
    void this.loadWorktrees();
  };

  private handleDocumentClick = (): void => {
    if (this.contextMenu.visible) {
      this.contextMenu = { ...this.contextMenu, visible: false };
    }
  };

  private handleKeydown = (e: KeyboardEvent): void => {
    if (!isTopOverlay(this)) return;
    if (e.key === 'Escape' && this.contextMenu.visible) {
      this.contextMenu = { ...this.contextMenu, visible: false };
    }
  };

  private dispatchCount(count: number): void {
    this.dispatchEvent(
      new CustomEvent('worktree-count-changed', {
        detail: { count },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async loadWorktrees(): Promise<void> {
    if (!this.repositoryPath) return;
    const loadedPath = this.repositoryPath;
    const seq = (this.loadSeq.get(loadedPath) ?? 0) + 1;
    this.loadSeq.set(loadedPath, seq);

    this.loading = true;
    this.error = null;

    try {
      const result = await gitService.getWorktrees(loadedPath);
      if (this.loadSeq.get(loadedPath) !== seq) return;
      if (this.repositoryPath !== loadedPath) return;

      if (result.success && result.data) {
        this.worktrees = result.data;
        this.error = null;
        this.dispatchCount(this.worktrees.length);
      } else {
        this.worktrees = [];
        this.error = result.error?.message ?? 'Failed to load worktrees';
        this.dispatchCount(0);
      }
    } catch (err) {
      if (this.loadSeq.get(loadedPath) !== seq || this.repositoryPath !== loadedPath) return;
      this.worktrees = [];
      this.error = err instanceof Error ? err.message : 'Failed to load worktrees';
      this.dispatchCount(0);
    } finally {
      if (this.loadSeq.get(loadedPath) === seq && this.repositoryPath === loadedPath) {
        this.loading = false;
      }
    }
  }

  private isCurrentWorktree(wt: Worktree): boolean {
    return Boolean(wt.isCurrent) || samePath(wt.path, this.repositoryPath);
  }

  private isOpenInAnotherTab(wt: Worktree): boolean {
    if (this.isCurrentWorktree(wt)) return false;
    return this.openRepoPaths.some((p) => samePath(p, wt.path));
  }

  private shortenPath(fullPath: string): string {
    const normalized = fullPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length <= 1) return fullPath;
    const folder = parts[parts.length - 1];
    const parent = parts.slice(0, -1).join('/');
    return `${folder} — ${parent}`;
  }

  private async handleOpenWorktreeTab(wt: Worktree, e?: Event): Promise<void> {
    e?.stopPropagation();
    this.contextMenu = { ...this.contextMenu, visible: false };
    if (this.isCurrentWorktree(wt)) return;
    if (wt.isPrunable) {
      showToast(`Worktree directory "${wt.path}" no longer exists on disk. Prune stale worktrees to clean it up.`, 'warning');
      return;
    }
    await openOrSwitchWorktreeTab(wt.path);
  }

  private async handleOpenInTerminal(wt: Worktree, e?: Event): Promise<void> {
    e?.stopPropagation();
    this.contextMenu = { ...this.contextMenu, visible: false };
    const result = await gitService.openTerminal(wt.path);
    if (!result.success) {
      showToast(result.error?.message ?? 'Failed to open terminal', 'error');
    }
  }

  private async handleOpenInEditor(wt: Worktree, e?: Event): Promise<void> {
    e?.stopPropagation();
    this.contextMenu = { ...this.contextMenu, visible: false };
    const result = await gitService.openInConfiguredEditor(wt.path, wt.path);
    if (!result.success) {
      showToast(result.error?.message ?? 'Failed to open editor', 'error');
    }
  }

  private async handleRevealInFileManager(wt: Worktree, e?: Event): Promise<void> {
    e?.stopPropagation();
    this.contextMenu = { ...this.contextMenu, visible: false };
    const result = await gitService.openFileManager(wt.path);
    if (!result.success) {
      showToast(result.error?.message ?? 'Failed to open file manager', 'error');
    }
  }

  private handleManageWorktrees(e?: Event): void {
    e?.stopPropagation();
    this.contextMenu = { ...this.contextMenu, visible: false };
    this.dispatchEvent(
      new CustomEvent('manage-worktrees', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleStartAgent(e?: Event): void {
    e?.stopPropagation();
    this.contextMenu = { ...this.contextMenu, visible: false };
    this.dispatchEvent(
      new CustomEvent('start-agent-worktree', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async handleToggleLock(wt: Worktree, e?: Event): Promise<void> {
    e?.stopPropagation();
    this.contextMenu = { ...this.contextMenu, visible: false };
    const repoPath = this.repositoryPath;
    if (!tryAcquireRefOpOrWarn(repoPath)) return;

    try {
      const result = wt.isLocked
        ? await gitService.unlockWorktree(repoPath, wt.path)
        : await gitService.lockWorktree(repoPath, wt.path);

      if (result.success) {
        showToast(wt.isLocked ? 'Worktree unlocked' : 'Worktree locked', 'info');
        await this.loadWorktrees();
        this.notifyChanged(repoPath);
      } else {
        showToast(
          result.error?.message ?? `Failed to ${wt.isLocked ? 'unlock' : 'lock'} worktree`,
          'error',
        );
      }
    } finally {
      releaseRefOp(repoPath);
    }
  }

  private async handleRemoveWorktree(wt: Worktree, e?: Event): Promise<void> {
    e?.stopPropagation();
    this.contextMenu = { ...this.contextMenu, visible: false };
    if (wt.isMain || this.isCurrentWorktree(wt)) return;

    const repoPath = this.repositoryPath;
    if (!tryAcquireRefOpOrWarn(repoPath)) return;

    try {
      const confirmed = await showConfirm(
        'Remove Worktree',
        `Remove the worktree at "${wt.path}"? Its working directory will be deleted; committed work stays in the repository.`,
        'warning',
      );
      if (!confirmed) return;

      let result = await gitService.removeWorktree(repoPath, wt.path);
      if (
        !result.success &&
        result.error?.message &&
        /contains modified or untracked files/i.test(result.error.message)
      ) {
        const forced = await showConfirm(
          'Remove Worktree',
          `The worktree at "${wt.path}" contains modified or untracked files. Removing it will permanently discard that work. Continue?`,
          'error',
        );
        if (!forced) return;
        result = await gitService.removeWorktree(repoPath, wt.path, true);
      }

      if (result.success) {
        closeRemovedWorktreeTab(wt.path);
        showToast('Worktree removed', 'info');
        await this.loadWorktrees();
        this.notifyChanged(repoPath);
      } else {
        showToast(result.error?.message ?? 'Failed to remove worktree', 'error');
      }
    } finally {
      releaseRefOp(repoPath);
    }
  }

  private async handlePruneWorktrees(e?: Event): Promise<void> {
    e?.stopPropagation();
    this.contextMenu = { ...this.contextMenu, visible: false };
    const repoPath = this.repositoryPath;
    if (!tryAcquireRefOpOrWarn(repoPath)) return;

    try {
      const result = await gitService.pruneWorktrees(repoPath);
      if (result.success) {
        for (const wt of this.worktrees) {
          if (wt.isPrunable) {
            closeRemovedWorktreeTab(wt.path);
          }
        }
        showToast('Pruned stale worktrees', 'info');
        await this.loadWorktrees();
        this.notifyChanged(repoPath);
      } else {
        showToast(result.error?.message ?? 'Failed to prune worktrees', 'error');
      }
    } finally {
      releaseRefOp(repoPath);
    }
  }

  private notifyChanged(repoPath: string): void {
    this.dispatchEvent(
      new CustomEvent('worktrees-changed', {
        detail: { repositoryPath: repoPath },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleContextMenu(e: MouseEvent, wt: Worktree): void {
    e.preventDefault();
    e.stopPropagation();
    this.contextMenu = {
      visible: true,
      x: e.clientX,
      y: e.clientY,
      worktree: wt,
    };
  }

  private renderContextMenu() {
    if (!this.contextMenu.visible || !this.contextMenu.worktree) return nothing;
    const wt = this.contextMenu.worktree;
    const isCurrent = this.isCurrentWorktree(wt);
    const isOpen = this.isOpenInAnotherTab(wt);
    const busy = this.operationInProgress;

    return html`
      <div
        class="context-menu"
        style="left: ${this.contextMenu.x}px; top: ${this.contextMenu.y}px"
        @click=${(e: Event) => e.stopPropagation()}
      >
        ${!isCurrent
          ? html`
              <button
                class="context-menu-item"
                ?disabled=${wt.isPrunable}
                @click=${() => this.handleOpenWorktreeTab(wt)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                  <polyline points="15 3 21 3 21 9"></polyline>
                  <line x1="10" y1="14" x2="21" y2="3"></line>
                </svg>
                ${isOpen ? 'Switch to Worktree Tab' : 'Open Worktree in New Tab'}
              </button>
              <div class="context-menu-divider"></div>
            `
          : nothing}
        <button
          class="context-menu-item"
          ?disabled=${wt.isPrunable}
          @click=${() => this.handleOpenInTerminal(wt)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="4 17 10 11 4 5"></polyline>
            <line x1="12" y1="19" x2="20" y2="19"></line>
          </svg>
          Open in Terminal
        </button>
        <button
          class="context-menu-item"
          ?disabled=${wt.isPrunable}
          @click=${() => this.handleOpenInEditor(wt)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
          Open in Editor
        </button>
        <button
          class="context-menu-item"
          ?disabled=${wt.isPrunable}
          @click=${() => this.handleRevealInFileManager(wt)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          Reveal in File Manager
        </button>
        ${!wt.isMain
          ? html`
              <div class="context-menu-divider"></div>
              <button
                class="context-menu-item"
                ?disabled=${busy}
                @click=${() => this.handleToggleLock(wt)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  ${wt.isLocked
                    ? html`
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                        <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
                      `
                    : html`
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                      `}
                </svg>
                ${wt.isLocked ? 'Unlock Worktree' : 'Lock Worktree'}
              </button>
              <button
                class="context-menu-item danger"
                ?disabled=${busy || wt.isLocked || isCurrent}
                title=${isCurrent
                  ? 'Cannot remove the currently open worktree'
                  : wt.isLocked
                    ? 'Unlock the worktree before removing it'
                    : ''}
                @click=${() => this.handleRemoveWorktree(wt)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
                Remove Worktree
              </button>
            `
          : nothing}
      </div>
    `;
  }

  render() {
    if (this.loading && this.worktrees.length === 0) {
      return html`<div class="loading">Loading worktrees...</div>`;
    }

    if (this.error) {
      return html`<div class="error" role="alert">${this.error}</div>`;
    }

    const hasPrunable = this.worktrees.some((wt) => wt.isPrunable);

    return html`
      <div class="worktree-footer-actions">
        <button
          class="worktree-btn"
          title="Add or manage worktrees"
          @click=${this.handleManageWorktrees}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          Add Worktree
        </button>
        <button
          class="worktree-btn"
          title="Start AI agent in an isolated worktree"
          @click=${this.handleStartAgent}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="11" width="18" height="10" rx="2"></rect>
            <circle cx="12" cy="5" r="2"></circle>
            <path d="M12 7v4"></path>
          </svg>
          Agent Worktree
        </button>
        ${hasPrunable
          ? html`
              <button
                class="worktree-btn"
                title="Prune stale worktrees whose directories were deleted"
                ?disabled=${this.operationInProgress}
                @click=${this.handlePruneWorktrees}
              >
                Prune Stale
              </button>
            `
          : nothing}
      </div>
      ${this.worktrees.length === 0
        ? html`<div class="empty">No worktrees</div>`
        : html`
            <ul class="worktree-list">
              ${this.worktrees.map((wt) => {
                const isCurrent = this.isCurrentWorktree(wt);
                const isOpen = this.isOpenInAnotherTab(wt);
                return html`
                  <li
                    class="worktree-item ${isCurrent ? 'current' : ''} ${wt.isPrunable ? 'prunable' : ''}"
                    title="${wt.branch || 'detached HEAD'} — ${wt.path}${isCurrent ? ' (current tab)' : isOpen ? ' (click to switch tab)' : ' (click to open in new tab)'}"
                    @click=${(e: Event) => this.handleOpenWorktreeTab(wt, e)}
                    @contextmenu=${(e: MouseEvent) => this.handleContextMenu(e, wt)}
                  >
                    <svg class="worktree-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                    </svg>
                    <div class="worktree-info">
                      <div class="worktree-header">
                        <span class="worktree-branch">${wt.branch || 'detached HEAD'}</span>
                        ${isCurrent ? html`<span class="badge current">current</span>` : nothing}
                        ${isOpen ? html`<span class="badge open-tab">open</span>` : nothing}
                        ${wt.isMain ? html`<span class="badge main">main</span>` : nothing}
                        ${wt.isLocked ? html`<span class="badge locked" title=${wt.lockReason || 'Locked'}>locked</span>` : nothing}
                        ${wt.isPrunable ? html`<span class="badge prunable" title="Directory missing on disk">stale</span>` : nothing}
                      </div>
                      <div class="worktree-path">${this.shortenPath(wt.path)}</div>
                    </div>
                    <div class="row-actions" @click=${(e: Event) => e.stopPropagation()}>
                      ${!isCurrent && !wt.isPrunable
                        ? html`
                            <button
                              class="row-action-btn"
                              title=${isOpen ? 'Switch to Tab' : 'Open in New Tab'}
                              @click=${(e: Event) => this.handleOpenWorktreeTab(wt, e)}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                                <polyline points="15 3 21 3 21 9"></polyline>
                                <line x1="10" y1="14" x2="21" y2="3"></line>
                              </svg>
                            </button>
                          `
                        : nothing}
                      ${!wt.isPrunable
                        ? html`
                            <button
                              class="row-action-btn"
                              title="Open in Terminal"
                              @click=${(e: Event) => this.handleOpenInTerminal(wt, e)}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="4 17 10 11 4 5"></polyline>
                                <line x1="12" y1="19" x2="20" y2="19"></line>
                              </svg>
                            </button>
                          `
                        : nothing}
                      ${!wt.isMain && !isCurrent
                        ? html`
                            <button
                              class="row-action-btn danger"
                              title=${wt.isLocked ? 'Locked worktree' : 'Remove Worktree'}
                              ?disabled=${this.operationInProgress || wt.isLocked}
                              @click=${(e: Event) => this.handleRemoveWorktree(wt, e)}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                              </svg>
                            </button>
                          `
                        : nothing}
                    </div>
                  </li>
                `;
              })}
            </ul>
          `}
      ${this.renderContextMenu()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-worktree-list': GnWorktreeList;
  }
}
