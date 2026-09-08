/**
 * Workspace Manager Dialog
 * Create, edit, and manage multi-repository workspaces
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as workspaceService from '../../services/workspace.service.ts';
import * as gitService from '../../services/git.service.ts';
import { openRepositoryDialog, openDialog, saveDialog, showConfirm } from '../../services/dialog.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { repositoryStore } from '../../stores/index.ts';
import { workspaceStore } from '../../stores/workspace.store.ts';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import type { Workspace, WorkspaceRepoStatus, WorkspaceSearchResult } from '../../types/git.types.ts';
import { pushOverlay, removeOverlay, isTopOverlay } from '../../utils/overlay-stack.ts';
import { hasConfiguredRemote } from '../../utils/remote-availability.ts';
import { tryAcquireRefOp, releaseRefOp } from '../../utils/ref-lock.ts';

const WORKSPACE_COLORS = [
  '#4fc3f7', '#81c784', '#ef5350', '#ffb74d',
  '#ce93d8', '#4dd0e1', '#ff8a65', '#aed581',
];

@customElement('lv-workspace-manager-dialog')
export class LvWorkspaceManagerDialog extends LitElement {
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
        width: 800px;
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

      .body {
        display: flex;
        flex: 1;
        overflow: hidden;
      }

      /* Left panel - workspace list */
      .left-panel {
        width: 200px;
        min-width: 200px;
        display: flex;
        flex-direction: column;
        border-right: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
      }

      .new-btn {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: var(--spacing-sm) var(--spacing-md);
        border: none;
        background: transparent;
        color: var(--color-primary);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        transition: background var(--transition-fast);
        border-bottom: 1px solid var(--color-border);
      }

      .new-btn:hover {
        background: var(--color-bg-hover);
      }

      .new-btn svg {
        width: 14px;
        height: 14px;
      }

      .workspace-list {
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }

      .workspace-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
        border: none;
        background: transparent;
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        cursor: pointer;
        transition: all var(--transition-fast);
        text-align: left;
        width: 100%;
      }

      .workspace-item:hover {
        background: var(--color-bg-hover);
      }

      .workspace-item.active {
        background: var(--color-bg-selected);
        color: var(--color-text-primary);
      }

      .workspace-color-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .workspace-item-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Right panel - editor */
      .right-panel {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        padding: var(--spacing-lg);
        gap: var(--spacing-lg);
      }

      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        flex: 1;
        color: var(--color-text-muted);
        text-align: center;
        gap: var(--spacing-sm);
      }

      .empty-state svg {
        width: 48px;
        height: 48px;
        opacity: 0.5;
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

      .form-input, .form-textarea {
        padding: var(--spacing-sm) var(--spacing-md);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        font-family: inherit;
        outline: none;
        transition: border-color var(--transition-fast);
      }

      .form-input:focus, .form-textarea:focus {
        border-color: var(--color-primary);
      }

      .form-textarea {
        resize: vertical;
        min-height: 48px;
      }

      .color-swatches {
        display: flex;
        gap: var(--spacing-sm);
      }

      .color-swatch {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .color-swatch:hover {
        transform: scale(1.15);
      }

      .color-swatch.selected {
        border-color: var(--color-text-primary);
        box-shadow: 0 0 0 2px var(--color-bg-secondary);
      }

      .section-divider {
        border: none;
        border-top: 1px solid var(--color-border);
        margin: 0;
      }

      .repos-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .repos-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
      }

      .add-repo-btn {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-tertiary);
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .add-repo-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .add-repo-btn svg {
        width: 12px;
        height: 12px;
      }

      .repo-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .repo-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-md);
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
      }

      .repo-item.missing {
        border-color: var(--color-warning);
        opacity: 0.7;
      }

      .repo-info {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .repo-name {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .repo-branch {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        font-family: var(--font-mono);
      }

      .repo-branch.detached {
        font-style: italic;
      }

      .repo-status {
        font-size: var(--font-size-xs);
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        white-space: nowrap;
      }

      .repo-status.clean {
        background: var(--color-success-bg, rgba(129, 199, 132, 0.1));
        color: var(--color-success, #81c784);
      }

      .repo-status.changed {
        background: var(--color-warning-bg);
        color: var(--color-warning);
      }

      .repo-status.missing {
        background: var(--color-error-bg, rgba(239, 83, 80, 0.1));
        color: var(--color-error);
      }

      .repo-ahead-behind {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        white-space: nowrap;
      }

      .repo-remove {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-muted);
        cursor: pointer;
        flex-shrink: 0;
        transition: all var(--transition-fast);
      }

      .repo-remove:hover {
        background: var(--color-bg-hover);
        color: var(--color-error);
      }

      .repo-remove svg {
        width: 14px;
        height: 14px;
      }

      .batch-ops {
        display: flex;
        gap: var(--spacing-sm);
      }

      .batch-btn {
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-tertiary);
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .batch-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .batch-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
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
        display: flex;
        gap: var(--spacing-sm);
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

      .btn-primary {
        background: var(--color-primary);
        border: 1px solid var(--color-primary);
        color: white;
      }

      .btn-primary:hover {
        filter: brightness(1.1);
      }

      .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-danger {
        background: transparent;
        border: 1px solid var(--color-error);
        color: var(--color-error);
      }

      .btn-danger:hover {
        background: var(--color-error);
        color: white;
      }

      .no-repos {
        padding: var(--spacing-md);
        text-align: center;
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }

      .search-section {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .search-bar {
        display: flex;
        gap: var(--spacing-xs);
      }

      .search-input {
        flex: 1;
        padding: var(--spacing-sm) var(--spacing-md);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        font-family: inherit;
        outline: none;
        transition: border-color var(--transition-fast);
      }

      .search-input:focus {
        border-color: var(--color-primary);
      }

      .search-btn {
        padding: var(--spacing-sm) var(--spacing-md);
        border: 1px solid var(--color-primary);
        border-radius: var(--radius-md);
        background: var(--color-primary);
        color: white;
        font-size: var(--font-size-sm);
        cursor: pointer;
        transition: all var(--transition-fast);
        white-space: nowrap;
      }

      .search-btn:hover {
        filter: brightness(1.1);
      }

      .search-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .search-results {
        max-height: 300px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .search-result-group {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .search-result-repo {
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-semibold);
        color: var(--color-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-sm);
      }

      .search-result-item {
        display: flex;
        align-items: baseline;
        gap: var(--spacing-sm);
        padding: var(--spacing-xs) var(--spacing-sm);
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-size: var(--font-size-xs);
        transition: background var(--transition-fast);
      }

      .search-result-item:hover {
        background: var(--color-bg-hover);
      }

      .search-result-file {
        font-family: var(--font-mono);
        color: var(--color-text-secondary);
        white-space: nowrap;
      }

      .search-result-line {
        font-family: var(--font-mono);
        color: var(--color-text-muted);
        font-size: 10px;
        flex-shrink: 0;
      }

      .search-result-content {
        flex: 1;
        font-family: var(--font-mono);
        color: var(--color-text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .search-result-match {
        background: var(--color-warning-bg);
        color: var(--color-warning);
        border-radius: 2px;
        padding: 0 1px;
      }

      .search-no-results {
        padding: var(--spacing-md);
        text-align: center;
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }

      .search-failures {
        padding: var(--spacing-sm);
        border: 1px solid var(--color-error);
        background: var(--color-error-bg, rgba(239, 83, 80, 0.1));
        border-radius: var(--radius-sm);
        color: var(--color-error);
        font-size: var(--font-size-xs);
      }

      .import-export-btns {
        display: flex;
        gap: var(--spacing-xs);
      }

      .ie-btn {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-tertiary);
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .ie-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .ie-btn svg {
        width: 12px;
        height: 12px;
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) open = false;

  @state() private workspaces: Workspace[] = [];
  @state() private selectedWorkspaceId: string | null = null;
  @state() private repoStatuses: Map<string, WorkspaceRepoStatus> = new Map();
  /** Which batch is running, so the button the user pressed reports it —
   *  a shared boolean made Fetch All read "Running..." during a Pull All. */
  @state() private batchRunning: 'fetch' | 'pull' | null = null;
  @state() private deletingWorkspace = false;
  @state() private removingRepoPath: string | null = null;
  @state() private statusLoading = false;

  // Search
  @state() private searchQuery = '';
  @state() private searchResults: WorkspaceSearchResult[] = [];
  @state() private searchFailures: string[] = [];
  @state() private searchCompleted = false;
  @state() private searching = false;
  private searchRequestId = 0;

  // Editable fields
  @state() private editName = '';
  @state() private editDescription = '';
  @state() private editColor = WORKSPACE_COLORS[0];

  async updated(changedProps: Map<string, unknown>): Promise<void> {
    // Announce/withdraw overlay ownership of Escape. Missing this made a
    // dialog opened over another one dismiss BOTH on a single keypress:
    // the one underneath was still stack-top, so its own guard passed.
    if (changedProps.has('open')) {
      if (this.open) { pushOverlay(this); } else { removeOverlay(this); }
    }
    if (changedProps.has('open') && this.open) {
      // A stale failure banner from a previous session must not reappear as if
      // it described a fresh search.
      this.resetSearchState();
      await this.loadWorkspaces();
    }
  }

  private get selectedWorkspace(): Workspace | undefined {
    return this.workspaces.find((w) => w.id === this.selectedWorkspaceId);
  }

  private async loadWorkspaces(): Promise<void> {
    const result = await workspaceService.getWorkspaces();
    if (result.success && result.data) {
      this.workspaces = result.data;
      workspaceStore.getState().setWorkspaces(result.data);
      // Select first workspace if none selected
      if (!this.selectedWorkspaceId && this.workspaces.length > 0) {
        this.selectWorkspace(this.workspaces[0].id);
      } else if (this.selectedWorkspaceId) {
        // Re-sync editor fields
        this.syncEditorFields();
      }
    }
  }

  private resetSearchState(): void {
    this.searchQuery = '';
    this.searchResults = [];
    this.searchFailures = [];
    this.searchCompleted = false;
    this.searching = false;
    this.searchRequestId++;
  }

  private selectWorkspace(id: string): void {
    this.selectedWorkspaceId = id;
    this.repoStatuses = new Map();
    this.resetSearchState();
    this.syncEditorFields();
    this.refreshStatus();
  }

  private syncEditorFields(): void {
    const ws = this.selectedWorkspace;
    if (ws) {
      this.editName = ws.name;
      this.editDescription = ws.description;
      this.editColor = ws.color || WORKSPACE_COLORS[0];
    }
  }

  private async handleNewWorkspace(): Promise<void> {
    const newWs: Workspace = {
      id: '',
      name: 'New Workspace',
      description: '',
      color: WORKSPACE_COLORS[0],
      repositories: [],
      createdAt: new Date().toISOString(),
      lastOpened: null,
    };

    const result = await workspaceService.saveWorkspace(newWs);
    if (result.success && result.data) {
      await this.loadWorkspaces();
      this.selectWorkspace(result.data.id);
    }
  }

  private async handleSave(): Promise<void> {
    const ws = this.selectedWorkspace;
    if (!ws) return;

    const updated: Workspace = {
      ...ws,
      name: this.editName,
      description: this.editDescription,
      color: this.editColor,
    };

    const result = await workspaceService.saveWorkspace(updated);
    if (result.success && result.data) {
      workspaceStore.getState().addOrUpdateWorkspace(result.data);
      await this.loadWorkspaces();
    } else {
      showToast(result.error?.message || 'Failed to save workspace', 'error');
    }
  }

  private async handleDelete(): Promise<void> {
    const ws = this.selectedWorkspace;
    if (!ws || this.deletingWorkspace) return;
    // Claimed BEFORE the confirm — this button had no in-flight state at all.
    // showConfirm is an IPC round trip before the native dialog takes focus, so
    // a double-click stacked two prompts for the same workspace and the second
    // delete then failed against a record that was already gone, contradicting
    // the success the user just read.
    this.deletingWorkspace = true;

    // The footer's single Delete button permanently drops a named, saved
    // multi-repo configuration with no undo. Its direct sibling — the profile
    // manager, which manages the same kind of object — confirms first; this
    // dialog was the one that didn't. The count matters: a user with several
    // workspaces selected the wrong row often enough that the confirm has to
    // name which one and how much is in it.
    const count = ws.repositories.length;
    const confirmed = await showConfirm(
      'Delete Workspace',
      `Delete workspace "${ws.name}"? This removes the workspace and its ` +
        `${count} tracked ${count === 1 ? 'repository' : 'repositories'}. ` +
        `The repositories themselves are not touched.`,
      'warning'
    );
    if (!confirmed) {
      this.deletingWorkspace = false;
      return;
    }

    try {
      const result = await workspaceService.deleteWorkspace(ws.id);
      if (result.success) {
        workspaceStore.getState().removeWorkspace(ws.id);
        this.selectedWorkspaceId = null;
        await this.loadWorkspaces();
        showToast(`Deleted workspace ${ws.name}`, 'success');
      } else {
        showToast(result.error?.message || 'Failed to delete workspace', 'error');
      }
    } finally {
      this.deletingWorkspace = false;
    }
  }

  private async handleAddRepo(): Promise<void> {
    const ws = this.selectedWorkspace;
    if (!ws) return;

    const path = await openRepositoryDialog();
    if (!path) return;

    const name = path.split('/').pop() ?? path;
    const result = await workspaceService.addRepositoryToWorkspace(ws.id, path, name);
    if (result.success) {
      await this.loadWorkspaces();
      await this.refreshStatus();
    } else {
      showToast(result.error?.message || 'Failed to add repository', 'error');
    }
  }

  private async handleRemoveRepo(path: string): Promise<void> {
    const ws = this.selectedWorkspace;
    if (!ws || this.removingRepoPath === path) return;
    // Claimed before the confirm, like every other destructive button here.
    this.removingRepoPath = path;

    // The × sits at the end of a dense row next to other controls. Nothing on
    // disk is touched, but the workspace entry — including the path — is gone,
    // and putting it back means knowing where that repo lives and re-browsing
    // to it. A confirm naming the row is cheap next to that.
    const name = ws.repositories.find((r) => r.path === path)?.name ?? path;
    const confirmed = await showConfirm(
      'Remove Repository',
      `Remove "${name}" from the workspace "${ws.name}"? ` +
        `The repository itself is not deleted — only its entry here.`,
      'warning'
    );
    if (!confirmed) {
      this.removingRepoPath = null;
      return;
    }

    const result = await workspaceService.removeRepositoryFromWorkspace(ws.id, path);
    this.removingRepoPath = null;
    if (result.success) {
      const newStatuses = new Map(this.repoStatuses);
      newStatuses.delete(path);
      this.repoStatuses = newStatuses;
      await this.loadWorkspaces();
      showToast(`Removed ${name} from ${ws.name}`, 'success');
    } else {
      showToast(result.error?.message || 'Failed to remove repository', 'error');
    }
  }

  private async refreshStatus(): Promise<void> {
    const ws = this.selectedWorkspace;
    if (!ws || ws.repositories.length === 0) return;

    this.statusLoading = true;
    const result = await workspaceService.validateWorkspaceRepositories(ws.id);
    if (result.success && result.data) {
      const statusMap = new Map<string, WorkspaceRepoStatus>();
      for (const status of result.data) {
        statusMap.set(status.path, status);
      }
      this.repoStatuses = statusMap;
    }
    this.statusLoading = false;
  }

  /**
   * Whether this repository has anywhere to fetch or pull FROM.
   *
   * These two loops are the one route to fetch and pull that does NOT go
   * through remote-operations.service's runner — deliberately, since they run
   * over repositories that need not be open in a tab and answer with one
   * summary instead of a toast per repo — so they do not inherit its refusal
   * and have to ask for themselves. Without it a workspace holding one
   * remoteless repository reported an unexplained, unnamed failure for it,
   * while the very same repository said "No remote configured for this
   * repository — add one first." from the toolbar.
   *
   * `get_remotes` is a local read (no network), and it runs immediately before
   * a network call this repository would otherwise fail.
   *
   * A read that FAILS is not "no remote": the operation goes ahead and reports
   * its own error, exactly as an unreadable repository does elsewhere.
   */
  private async workspaceRepoHasRemote(path: string): Promise<boolean> {
    const result = await gitService.getRemotes(path);
    if (!result.success || !result.data) return true;
    // Through the shared predicate, not a local `length > 0`: re-stating the
    // rule here is how a sixth copy of it gets back into the tree, which is
    // the whole reason it lives in one module.
    return hasConfiguredRemote({ remotes: result.data });
  }

  private async handleFetchAll(): Promise<void> {
    const ws = this.selectedWorkspace;
    if (!ws) return;

    this.batchRunning = 'fetch';
    let successCount = 0;
    let failCount = 0;
    // A security-gate refusal is not a failure: with offline mode on, every
    // repo in the workspace used to count as "failed" and the summary read
    // "0 succeeded, 8 failed" for eight operations that were never attempted.
    let skippedCount = 0;
    // Repos that are gone or no longer git repos were silently dropped, so a
    // summary that now reads as fully accounted-for (succeeded/failed/skipped)
    // still didn't add up to the workspace size.
    let unavailableCount = 0;
    // Repos with nowhere to fetch FROM. Named, not just counted: "1 failed"
    // with no repo and no reason was the whole complaint.
    const noRemote: string[] = [];

    for (const repo of ws.repositories) {
      const status = this.repoStatuses.get(repo.path);
      if (status && (!status.exists || !status.isValidRepo)) {
        unavailableCount++;
        continue;
      }

      if (!(await this.workspaceRepoHasRemote(repo.path))) {
        noRemote.push(repo.name);
        continue;
      }

      const result = await gitService.fetch({ path: repo.path, silent: true });
      if (result.success) {
        successCount++;
      } else if (gitService.isNetworkGateRefusal(result.error)) {
        skippedCount++;
      } else {
        failCount++;
      }
    }

    this.batchRunning = null;
    showToast(
      `Fetch all: ${successCount} succeeded` +
        (failCount > 0 ? `, ${failCount} failed` : '') +
        (noRemote.length > 0
          ? `, ${noRemote.length} with no remote configured (${noRemote.join(', ')})`
          : '') +
        (skippedCount > 0 ? `, ${skippedCount} skipped by security settings` : '') +
        (unavailableCount > 0 ? `, ${unavailableCount} unavailable` : ''),
      failCount > 0 || unavailableCount > 0 || noRemote.length > 0
        ? 'warning'
        : skippedCount > 0
          ? 'info'
          : 'success',
    );
    await this.refreshStatus();
  }

  private async handlePullAll(): Promise<void> {
    const ws = this.selectedWorkspace;
    if (!ws) return;

    this.batchRunning = 'pull';
    let successCount = 0;
    // Named, not just counted: "2 failed" across a 10-repo workspace gave the
    // user nothing to act on.
    const failed: string[] = [];
    const conflicted: string[] = [];
    // A security-gate refusal is not a failure: with offline mode on, every
    // repo in the workspace used to count as "failed" and the summary read
    // "0 succeeded, 8 failed" for eight operations that were never attempted.
    let skippedCount = 0;
    // Repos that are gone or no longer git repos were silently dropped, so a
    // summary that now reads as fully accounted-for (succeeded/failed/skipped)
    // still didn't add up to the workspace size.
    // Repos skipped because another operation held their working-tree lock.
    const busy: string[] = [];
    // Repos with nowhere to pull FROM, named like the rest of this summary.
    const noRemote: string[] = [];
    let unavailableCount = 0;

    for (const repo of ws.repositories) {
      const status = this.repoStatuses.get(repo.path);
      if (status && (!status.exists || !status.isValidRepo)) {
        unavailableCount++;
        continue;
      }

      // Before the working-tree lock: a repository that cannot pull at all
      // must not take a lock other operations then wait behind.
      if (!(await this.workspaceRepoHasRemote(repo.path))) {
        noRemote.push(repo.name);
        continue;
      }

      // The fourth surface reaching pull. handlePull's own comment enumerates
      // three (the shortcut, the palette, the Pull Now toast) and this batch
      // was never in that list — it guarded only its own two buttons with
      // batchRunning. A pull runs checkout_tree and moves the branch ref, so
      // it must take the shared working-tree lock like every other caller.
      // Per repo, since separate repos have separate trees.
      if (!tryAcquireRefOp(repo.path)) {
        busy.push(repo.name);
        continue;
      }
      let result;
      try {
        result = await gitService.pull({ path: repo.path, silent: true });
      } finally {
        releaseRefOp(repo.path);
      }
      if (result.success) {
        successCount++;
      } else if (gitService.isNetworkGateRefusal(result.error)) {
        skippedCount++;
      } else if (
        result.error?.code === 'MERGE_CONFLICT' ||
        result.error?.code === 'REBASE_CONFLICT'
      ) {
        // Counting this as "failed" is wrong in the direction that matters: the
        // pull LANDED and left a conflicted index behind. A summary reading
        // "6 succeeded, 2 failed" told the user nothing happened in two repos
        // that are in fact sitting mid-merge, and named neither of them — so
        // there was no way to find them short of opening all eight.
        conflicted.push(repo.name);
      } else {
        failed.push(repo.name);
      }
    }

    const failCount = failed.length;
    this.batchRunning = null;
    showToast(
      `Pull all: ${successCount} succeeded` +
        (conflicted.length > 0
          ? `, ${conflicted.length} need conflict resolution (${conflicted.join(', ')})`
          : '') +
        (failCount > 0 ? `, ${failCount} failed (${failed.join(', ')})` : '') +
        (noRemote.length > 0
          ? `, ${noRemote.length} with no remote configured (${noRemote.join(', ')})`
          : '') +
        (skippedCount > 0 ? `, ${skippedCount} skipped by security settings` : '') +
        // Named, not just counted: a repo skipped because something else was
        // running in it did NOT pull, and a summary that stays silent about it
        // reads as "everything is up to date".
        (busy.length > 0
          ? `, ${busy.length} busy with another operation (${busy.join(', ')})`
          : '') +
        (unavailableCount > 0 ? `, ${unavailableCount} unavailable` : ''),
      failCount > 0 ||
      conflicted.length > 0 ||
      unavailableCount > 0 ||
      busy.length > 0 ||
      noRemote.length > 0
        ? 'warning'
        : skippedCount > 0
          ? 'info'
          : 'success',
    );
    await this.refreshStatus();
  }

  private async handleOpenWorkspace(): Promise<void> {
    const ws = this.selectedWorkspace;
    if (!ws || ws.repositories.length === 0) return;

    const store = repositoryStore.getState();

    // Open WITHOUT activating each repo: addRepository's default activation
    // would fire the per-activation side effects (index builds, integration
    // checks) once per repo — a 10-repo workspace would still kick off 10
    // concurrent history walks. Activate only the final repo; the rest get
    // their indexes lazily when their tab is first activated.
    let lastOpenedPath: string | null = null;
    let failedCount = 0;
    for (const repo of ws.repositories) {
      const status = this.repoStatuses.get(repo.path);
      if (status && (!status.exists || !status.isValidRepo)) {
        failedCount++;
        continue;
      }

      const result = await gitService.openRepository({ path: repo.path });
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

    workspaceStore.getState().setActiveWorkspaceId(ws.id);
    await workspaceService.updateWorkspaceLastOpened(ws.id);

    this.close();
    // A repo that failed to open (moved, deleted, invalid) must not hide
    // behind a green success toast
    if (failedCount === 0) {
      showToast(`Opened workspace: ${ws.name}`, 'success');
    } else if (lastOpenedPath) {
      showToast(
        `Opened workspace: ${ws.name} (${failedCount} of ${ws.repositories.length} repositories failed to open)`,
        'warning',
      );
    } else {
      showToast(`Could not open workspace: ${ws.name} — no repository could be opened`, 'error');
    }
  }

  private async handleSearch(): Promise<void> {
    const ws = this.selectedWorkspace;
    if (!ws || !this.searchQuery.trim()) return;

    const query = this.searchQuery;
    const requestId = ++this.searchRequestId;
    this.searching = true;
    this.searchResults = [];
    this.searchFailures = [];
    this.searchCompleted = false;

    const result = await workspaceService.searchWorkspace(
      ws.id,
      query,
      false,
      false,
      undefined,
      200,
    );

    // A dialog closed mid-search has no failure panel left on screen, so a
    // toast pointing at "the details below" would be a dead end.
    if (
      !this.open ||
      requestId !== this.searchRequestId ||
      this.searchQuery !== query ||
      this.selectedWorkspace?.id !== ws.id
    ) {
      return;
    }

    if (result.success && result.data) {
      this.searchResults = result.data.results ?? [];
      this.searchFailures = result.data.failures ?? [];
      this.searchCompleted = true;
      if (this.searchFailures.length > 0) {
        // The toast renders as plain text, so newlines collapse: summarise here
        // and leave the per-repository detail to the .search-failures panel,
        // which stays on screen.
        showToast(
          this.searchFailures.length === 1
            ? this.searchFailures[0]
            : `Search completed with ${this.searchFailures.length} problems — see the details below`,
          this.searchResults.length > 0 ? 'warning' : 'error',
        );
      }
    } else {
      showToast(result.error?.message ?? 'Search failed', 'error');
      this.searchFailures = [result.error?.message ?? 'Search failed'];
    }
    this.searching = false;
  }

  private handleSearchKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      this.handleSearch();
    }
  }

  private getGroupedSearchResults(): Map<string, WorkspaceSearchResult[]> {
    const grouped = new Map<string, WorkspaceSearchResult[]>();
    for (const r of this.searchResults) {
      const key = r.repoName;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(r);
    }
    return grouped;
  }

  private async handleExportWorkspace(): Promise<void> {
    const ws = this.selectedWorkspace;
    if (!ws) return;

    const result = await workspaceService.exportWorkspace(ws.id);
    if (!result.success || !result.data) {
      showToast('Failed to export workspace', 'error');
      return;
    }

    const filePath = await saveDialog({
      title: 'Export Workspace',
      defaultPath: `${ws.name.replace(/\s+/g, '-').toLowerCase()}-workspace.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (!filePath) return;

    try {
      await writeTextFile(filePath, result.data);
      showToast(`Workspace exported to ${filePath}`, 'success');
    } catch (err) {
      console.error('Failed to write file:', err);
      showToast('Failed to write file', 'error');
    }
  }

  private async handleImportWorkspace(): Promise<void> {
    const filePath = await openDialog({
      title: 'Import Workspace',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (!filePath || Array.isArray(filePath)) return;

    try {
      const content = await readTextFile(filePath);
      const result = await workspaceService.importWorkspace(content);
      if (result.success && result.data) {
        showToast(`Workspace "${result.data.name}" imported`, 'success');
        await this.loadWorkspaces();
        this.selectWorkspace(result.data.id);
      } else {
        showToast(`Import failed: ${result.error?.message ?? 'Unknown error'}`, 'error');
      }
    } catch (err) {
      console.error('Failed to import workspace:', err);
      showToast('Failed to read file', 'error');
    }
  }

  private handleOverlayClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) {
      this.close();
    }
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    // Only the topmost overlay owns Escape.
    if (!this.open || !isTopOverlay(this)) return;

    if (e.key === 'Escape') {
      this.close();
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
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private renderRepoStatus(status: WorkspaceRepoStatus | undefined) {
    if (!status) return nothing;

    if (!status.exists || !status.isValidRepo) {
      return html`<span class="repo-status missing">${!status.exists ? 'missing' : 'invalid'}</span>`;
    }

    if (status.changedFilesCount > 0) {
      return html`<span class="repo-status changed">${status.changedFilesCount} changed</span>`;
    }

    return html`<span class="repo-status clean">clean</span>`;
  }

  private renderAheadBehind(status: WorkspaceRepoStatus | undefined) {
    if (!status || !status.exists || !status.isValidRepo) return nothing;
    if (status.ahead === 0 && status.behind === 0) return nothing;

    const parts: string[] = [];
    if (status.ahead > 0) parts.push(`↑${status.ahead}`);
    if (status.behind > 0) parts.push(`↓${status.behind}`);
    return html`<span class="repo-ahead-behind">${parts.join(' ')}</span>`;
  }

  render() {
    const ws = this.selectedWorkspace;
    const hasRepos = ws ? ws.repositories.length > 0 : false;

    return html`
      <div class="overlay" @click=${this.handleOverlayClick}></div>
      <div class="dialog">
        <div class="header">
          <div class="header-left">
            <svg class="header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="7" height="7"></rect>
              <rect x="14" y="3" width="7" height="7"></rect>
              <rect x="3" y="14" width="7" height="7"></rect>
              <rect x="14" y="14" width="7" height="7"></rect>
            </svg>
            <span class="title">Workspace Manager</span>
          </div>
          <button class="close-btn" @click=${this.close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="body">
          <div class="left-panel">
            <button class="new-btn" @click=${this.handleNewWorkspace}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              New Workspace
            </button>
            <button class="new-btn" @click=${this.handleImportWorkspace}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              Import
            </button>
            <div class="workspace-list">
              ${this.workspaces.map(
                (w) => html`
                  <button
                    class="workspace-item ${w.id === this.selectedWorkspaceId ? 'active' : ''}"
                    @click=${() => this.selectWorkspace(w.id)}
                  >
                    <span
                      class="workspace-color-dot"
                      style="background: ${w.color || WORKSPACE_COLORS[0]}"
                    ></span>
                    <span class="workspace-item-name">${w.name}</span>
                  </button>
                `,
              )}
            </div>
          </div>

          <div class="right-panel">
            ${ws
              ? html`
                  <div class="form-group">
                    <label class="form-label">Name</label>
                    <input
                      class="form-input"
                      type="text"
                      .value=${this.editName}
                      @input=${(e: InputEvent) => {
                        this.editName = (e.target as HTMLInputElement).value;
                      }}
                      @blur=${() => this.handleSave()}
                    />
                  </div>

                  <div class="form-group">
                    <label class="form-label">Description</label>
                    <textarea
                      class="form-textarea"
                      .value=${this.editDescription}
                      @input=${(e: InputEvent) => {
                        this.editDescription = (e.target as HTMLTextAreaElement).value;
                      }}
                      @blur=${() => this.handleSave()}
                    ></textarea>
                  </div>

                  <div class="form-group">
                    <label class="form-label">Color</label>
                    <div class="color-swatches">
                      ${WORKSPACE_COLORS.map(
                        (color) => html`
                          <button
                            class="color-swatch ${this.editColor === color ? 'selected' : ''}"
                            style="background: ${color}"
                            @click=${() => {
                              this.editColor = color;
                              this.handleSave();
                            }}
                          ></button>
                        `,
                      )}
                    </div>
                  </div>

                  <hr class="section-divider" />

                  ${hasRepos ? html`
                    <div class="search-section">
                      <div class="search-bar">
                        <input
                          class="search-input"
                          type="text"
                          placeholder="Search across all repos..."
                          .value=${this.searchQuery}
                          @input=${(e: InputEvent) => {
                            this.searchQuery = (e.target as HTMLInputElement).value;
                            this.searchResults = [];
                            this.searchFailures = [];
                            this.searchCompleted = false;
                            this.searching = false;
                            this.searchRequestId++;
                          }}
                          @keydown=${(e: KeyboardEvent) => this.handleSearchKeyDown(e)}
                        />
                        <button
                          class="search-btn"
                          ?disabled=${this.searching || !this.searchQuery.trim()}
                          @click=${this.handleSearch}
                        >
                          ${this.searching ? 'Searching...' : 'Search'}
                        </button>
                      </div>
                      ${this.searchFailures.length > 0 ? html`
                        <div class="search-failures">
                          ${this.searchFailures.map((failure) => html`<div>${failure}</div>`)}
                        </div>
                      ` : nothing}
                      ${this.searchResults.length > 0 ? html`
                        <div class="search-results">
                          ${Array.from(this.getGroupedSearchResults().entries()).map(
                            ([repoName, results]) => html`
                              <div class="search-result-group">
                                <div class="search-result-repo">${repoName}</div>
                                ${results.map(
                                  (r) => html`
                                    <div class="search-result-item" @click=${() => {
                                      this.dispatchEvent(new CustomEvent('open-repo-file', {
                                        detail: { repoPath: r.repoPath, filePath: r.filePath, lineNumber: r.lineNumber },
                                        bubbles: true,
                                        composed: true,
                                      }));
                                    }}>
                                      <span class="search-result-file">${r.filePath}</span>
                                      <span class="search-result-line">:${r.lineNumber}</span>
                                      <span class="search-result-content">${r.lineContent}</span>
                                    </div>
                                  `,
                                )}
                              </div>
                            `,
                          )}
                        </div>
                      ` : this.searchCompleted && !this.searching ? html`
                        <div class="search-no-results">No results found</div>
                      ` : nothing}
                    </div>
                    <hr class="section-divider" />
                  ` : nothing}

                  <div class="repos-header">
                    <span class="repos-title">
                      Repositories (${ws.repositories.length})
                    </span>
                    <div class="import-export-btns">
                      <button class="ie-btn" @click=${this.handleExportWorkspace} title="Export workspace">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path>
                          <polyline points="17 8 12 3 7 8"></polyline>
                          <line x1="12" y1="3" x2="12" y2="15"></line>
                        </svg>
                        Export
                      </button>
                      <button class="add-repo-btn" @click=${this.handleAddRepo}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <line x1="12" y1="5" x2="12" y2="19"></line>
                          <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                        Add Repo
                      </button>
                    </div>
                  </div>

                  ${hasRepos
                    ? html`
                        <div class="repo-list">
                          ${ws.repositories.map((repo) => {
                            const status = this.repoStatuses.get(repo.path);
                            const isMissing = status && (!status.exists || !status.isValidRepo);
                            return html`
                              <div class="repo-item ${isMissing ? 'missing' : ''}">
                                <div class="repo-info">
                                  <span class="repo-name" title="${repo.path}">${repo.name}</span>
                                  ${status?.currentBranch
                                    ? html`<span class="repo-branch">${status.currentBranch}</span>`
                                    : status?.isDetached
                                      ? html`<span class="repo-branch detached">detached HEAD</span>`
                                      : nothing}
                                  ${this.renderRepoStatus(status)}
                                  ${this.renderAheadBehind(status)}
                                </div>
                                <button
                                  class="repo-remove"
                                  title="Remove from workspace"
                                  ?disabled=${this.removingRepoPath === repo.path}
                                  @click=${() => this.handleRemoveRepo(repo.path)}
                                >
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <line x1="18" y1="6" x2="6" y2="18"></line>
                                    <line x1="6" y1="6" x2="18" y2="18"></line>
                                  </svg>
                                </button>
                              </div>
                            `;
                          })}
                        </div>

                        <div class="batch-ops">
                          <button
                            class="batch-btn"
                            ?disabled=${this.batchRunning !== null}
                            @click=${this.handleFetchAll}
                          >
                            ${this.batchRunning === 'fetch' ? 'Running...' : 'Fetch All'}
                          </button>
                          <button
                            class="batch-btn"
                            ?disabled=${this.batchRunning !== null}
                            @click=${this.handlePullAll}
                          >
                            ${this.batchRunning === 'pull' ? 'Running...' : 'Pull All'}
                          </button>
                          <button
                            class="batch-btn"
                            ?disabled=${this.statusLoading}
                            @click=${() => this.refreshStatus()}
                          >
                            ${this.statusLoading ? 'Loading...' : 'Refresh Status'}
                          </button>
                        </div>
                      `
                    : html`<div class="no-repos">No repositories added yet</div>`}
                `
              : html`
                  <div class="empty-state">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <rect x="3" y="3" width="7" height="7"></rect>
                      <rect x="14" y="3" width="7" height="7"></rect>
                      <rect x="3" y="14" width="7" height="7"></rect>
                      <rect x="14" y="14" width="7" height="7"></rect>
                    </svg>
                    <div>Select a workspace or create a new one</div>
                  </div>
                `}
          </div>
        </div>

        <div class="footer">
          <div class="footer-left">
            ${ws
              ? html`
                  <button
                    class="btn btn-danger"
                    ?disabled=${this.deletingWorkspace}
                    @click=${this.handleDelete}
                  >
                    Delete
                  </button>
                `
              : nothing}
          </div>
          <div class="footer-right">
            ${ws
              ? html`
                  <button
                    class="btn btn-primary"
                    ?disabled=${!hasRepos}
                    @click=${this.handleOpenWorkspace}
                  >
                    Open Workspace
                  </button>
                `
              : nothing}
            <button class="btn btn-secondary" @click=${this.close}>Close</button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-workspace-manager-dialog': LvWorkspaceManagerDialog;
  }
}
