/**
 * Checkpoints Dialog (roadmap 4.1, issue #607)
 *
 * Lists working-tree checkpoints (snapshots taken before/after agent turns or
 * by hand), shows which files each one captured, and restores or deletes
 * them. Restoring backs up the current state first, so it is undoable from
 * this same list.
 */

import { html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sharedStyles, buttonStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import type {
  AgentHooksStatus,
  Checkpoint,
  CheckpointFile,
} from '../../services/git.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import { tryAcquireRefOpOrWarn, releaseRefOp } from '../../utils/ref-lock.ts';
import { GnRepoScopedDialogBase } from './gn-repo-scoped-dialog-base.ts';
import './gn-modal.ts';

function timeAgo(seconds: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

@customElement('gn-checkpoints-dialog')
export class GnCheckpointsDialog extends GnRepoScopedDialogBase {
  static styles = [
    sharedStyles,
    buttonStyles,
    css`
      .content {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        min-width: min(560px, 85vw);
      }

      .intro {
        margin: 0;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .create-row {
        display: flex;
        gap: var(--spacing-sm);
      }

      .create-row input {
        flex: 1;
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
      }

      .list {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 50vh;
        overflow-y: auto;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
      }

      .checkpoint {
        border-bottom: 1px solid var(--color-border);
      }

      .checkpoint:last-child {
        border-bottom: none;
      }

      .checkpoint-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm);
      }

      .expand-btn {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
        border: none;
        background: none;
        padding: 0;
        text-align: left;
        color: inherit;
        cursor: pointer;
      }

      .label {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 100%;
      }

      .meta {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .session {
        font-family: var(--font-family-mono);
      }

      .files {
        list-style: none;
        margin: 0;
        padding: 0 var(--spacing-sm) var(--spacing-sm) var(--spacing-lg);
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .file-status {
        display: inline-block;
        width: 1.5em;
        font-weight: var(--font-weight-medium);
      }

      .file-status.added { color: var(--color-success); }
      .file-status.deleted { color: var(--color-error); }
      .file-status.modified,
      .file-status.renamed,
      .file-status.typechange { color: var(--color-warning); }

      .empty-state,
      .loading,
      .error-state {
        padding: var(--spacing-lg);
        text-align: center;
        font-size: var(--font-size-sm);
        color: var(--color-text-muted);
      }

      .error-state {
        color: var(--color-error);
      }

      .hooks-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        padding: var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-secondary);
      }

      .hooks-row.error .hooks-status {
        color: var(--color-error);
      }

      .hooks-text {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .hooks-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
      }

      .hooks-status {
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .hooks-btn {
        flex-shrink: 0;
        padding: 2px 10px;
        font-size: var(--font-size-xs);
      }

      .checkpoint-row .btn {
        padding: 2px 10px;
        font-size: var(--font-size-xs);
        flex-shrink: 0;
      }

      .delete-btn {
        color: var(--color-error);
      }
    `,
  ];

  @state() private checkpoints: Checkpoint[] = [];
  @state() private loading = false;
  @state() private loadError: string | null = null;
  @state() private newLabel = '';
  @state() private busy = false;
  @state() private expandedId: string | null = null;
  @state() private files = new Map<string, CheckpointFile[] | 'error'>();
  @state() private hooksStatus: AgentHooksStatus | null = null;
  @state() private hooksError: string | null = null;
  @state() private hooksBusy = false;

  /** Repository captured at open(); every action targets it. */
  private pinnedRepoPath = '';

  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.open ? this.pinnedRepoPath : null;
  }

  public get operationInFlight(): boolean {
    return this.busy || this.hooksBusy;
  }

  override updated(changed: Map<string, unknown>): void {
    super.updated(changed);
    if (changed.has('open') && this.open) {
      this.pinnedRepoPath = this.repositoryPath;
      this.expandedId = null;
      this.files = new Map();
      this.newLabel = '';
      this.hooksStatus = null;
      this.hooksError = null;
      void this.load();
      void this.loadHooksStatus();
    }
  }

  private async loadHooksStatus(): Promise<void> {
    const repoPath = this.pinnedRepoPath;
    const result = await gitService.getAgentHooksStatus(repoPath);
    if (repoPath !== this.pinnedRepoPath) return;
    if (result.success && result.data) {
      this.hooksStatus = result.data;
      this.hooksError = null;
    } else {
      this.hooksStatus = null;
      this.hooksError = result.error?.message ?? 'Could not read the Claude Code hook settings';
    }
  }

  private async handleToggleHooks(enable: boolean): Promise<void> {
    if (this.hooksBusy) return;
    const repoPath = this.pinnedRepoPath;
    this.hooksBusy = true;
    try {
      const result = enable
        ? await gitService.installAgentHooks(repoPath)
        : await gitService.uninstallAgentHooks(repoPath);
      if (!result.success || !result.data) {
        showToast(
          `Failed to ${enable ? 'enable' : 'disable'} Claude Code checkpoints: ${result.error?.message ?? 'Unknown error'}`,
          'error',
        );
        return;
      }
      if (repoPath === this.pinnedRepoPath) {
        this.hooksStatus = result.data;
        this.hooksError = null;
      }
      showToast(
        enable
          ? 'Claude Code will now take a checkpoint before and after every turn in this repository'
          : 'Automatic Claude Code checkpoints turned off',
        'success',
      );
    } finally {
      this.hooksBusy = false;
    }
  }

  close(): void {
    if (this.busy || this.hooksBusy) return;
    this.open = false;
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private async load(): Promise<void> {
    const repoPath = this.pinnedRepoPath;
    const gen = this.nextLoadGeneration();
    this.loading = true;
    this.loadError = null;
    const result = await gitService.listCheckpoints(repoPath);
    if (gen !== this.loadGeneration || repoPath !== this.pinnedRepoPath) return;
    this.loading = false;
    if (!result.success || !result.data) {
      this.loadError = result.error?.message ?? 'Failed to load checkpoints';
      this.checkpoints = [];
      return;
    }
    this.checkpoints = result.data;
  }

  private notifyChanged(repoPath: string, workingTreeChanged: boolean): void {
    this.dispatchRepoEvent('checkpoints-changed', repoPath, { workingTreeChanged });
  }

  private async handleCreate(): Promise<void> {
    if (this.busy) return;
    const repoPath = this.pinnedRepoPath;
    this.busy = true;
    try {
      const result = await gitService.createCheckpoint(repoPath, this.newLabel.trim() || undefined);
      if (!result.success || !result.data) {
        showToast(`Failed to create checkpoint: ${result.error?.message ?? 'Unknown error'}`, 'error');
        return;
      }
      showToast(`Checkpoint "${result.data.label}" created`, 'success');
      this.newLabel = '';
      this.notifyChanged(repoPath, false);
      await this.load();
    } finally {
      this.busy = false;
    }
  }

  private async toggleFiles(cp: Checkpoint): Promise<void> {
    if (this.expandedId === cp.id) {
      this.expandedId = null;
      return;
    }
    this.expandedId = cp.id;
    if (this.files.has(cp.id)) return;
    const result = await gitService.getCheckpointFiles(this.pinnedRepoPath, cp.id);
    const next = new Map(this.files);
    next.set(cp.id, result.success && result.data ? result.data : 'error');
    this.files = next;
  }

  private async handleRestore(cp: Checkpoint): Promise<void> {
    if (this.busy) return;
    const repoPath = this.pinnedRepoPath;
    const confirmed = await showConfirm(
      'Restore checkpoint',
      `Make the working tree match "${cp.label}"?\n\n` +
        'Files created since then are removed and changed files are reverted. ' +
        'HEAD and your commits are not touched, and the current state is saved ' +
        'as a new checkpoint first, so this can be undone.',
      'warning',
    );
    if (!confirmed) return;
    if (!tryAcquireRefOpOrWarn(repoPath)) return;
    this.busy = true;
    try {
      const result = await gitService.restoreCheckpoint(repoPath, cp.id);
      if (!result.success || !result.data) {
        showToast(`Failed to restore checkpoint: ${result.error?.message ?? 'Unknown error'}`, 'error');
        return;
      }
      showToast(
        `Restored "${cp.label}". The previous state was saved as "${result.data.backup.label}".`,
        'success',
      );
      this.notifyChanged(repoPath, true);
      await this.load();
    } finally {
      this.busy = false;
      releaseRefOp(repoPath);
    }
  }

  private async handleDelete(cp: Checkpoint): Promise<void> {
    if (this.busy) return;
    const repoPath = this.pinnedRepoPath;
    const confirmed = await showConfirm(
      'Delete checkpoint',
      `Delete checkpoint "${cp.label}"? This cannot be undone.`,
      'warning',
    );
    if (!confirmed) return;
    this.busy = true;
    try {
      const result = await gitService.deleteCheckpoint(repoPath, cp.id);
      if (!result.success) {
        showToast(`Failed to delete checkpoint: ${result.error?.message ?? 'Unknown error'}`, 'error');
        return;
      }
      showToast(`Checkpoint "${cp.label}" deleted`, 'success');
      this.notifyChanged(repoPath, false);
      await this.load();
    } finally {
      this.busy = false;
    }
  }

  private renderFiles(cp: Checkpoint) {
    if (this.expandedId !== cp.id) return nothing;
    const files = this.files.get(cp.id);
    if (files === undefined) return html`<div class="loading">Loading files…</div>`;
    if (files === 'error') return html`<div class="error-state">Could not load the files in this checkpoint</div>`;
    if (files.length === 0) {
      return html`<div class="empty-state">No changes compared to the commit it was taken on</div>`;
    }
    const mark: Record<string, string> = {
      added: 'A',
      deleted: 'D',
      modified: 'M',
      renamed: 'R',
      typechange: 'T',
    };
    return html`
      <ul class="files">
        ${files.map(
          (f) => html`<li><span class="file-status ${f.status}" title=${f.status}>${mark[f.status] ?? '?'}</span>${f.path}</li>`,
        )}
      </ul>
    `;
  }

  private renderHooks() {
    const status = this.hooksStatus;
    let text: string;
    let action: 'enable' | 'disable' | 'repair' | null = null;
    if (this.hooksError) {
      text = this.hooksError;
    } else if (!status) {
      text = 'Checking Claude Code hooks…';
    } else if (status.installed) {
      text = 'On — Claude Code takes a checkpoint before and after every turn, and its commits are marked with the session.';
      action = 'disable';
    } else if (status.partial) {
      text = 'Incomplete — part of the Claude Code hook setup is missing.';
      action = 'repair';
    } else {
      text = 'Off — turn on to take a checkpoint before and after every Claude Code turn.';
      action = 'enable';
    }
    return html`
      <div class="hooks-row ${this.hooksError ? 'error' : ''}">
        <div class="hooks-text">
          <span class="hooks-title">Automatic checkpoints for Claude Code</span>
          <span class="hooks-status">${text}</span>
        </div>
        ${action
          ? html`<button
              class="btn ${action === 'disable' ? 'btn-secondary' : 'btn-primary'} hooks-btn"
              ?disabled=${this.hooksBusy}
              title=${status?.settingsPath ?? ''}
              @click=${() => void this.handleToggleHooks(action !== 'disable')}
            >${action === 'enable' ? 'Turn On' : action === 'repair' ? 'Repair' : 'Turn Off'}</button>`
          : nothing}
      </div>
    `;
  }

  private renderList() {
    if (this.loading && this.checkpoints.length === 0) {
      return html`<div class="loading">Loading checkpoints…</div>`;
    }
    if (this.loadError) {
      return html`
        <div class="error-state">
          ${this.loadError}
          <div><button class="btn btn-secondary retry-btn" @click=${() => void this.load()}>Retry</button></div>
        </div>
      `;
    }
    if (this.checkpoints.length === 0) {
      return html`
        <div class="empty-state">
          No checkpoints yet. Create one before trying something risky, or let an agent
          session create them for you.
        </div>
      `;
    }
    return html`
      <ul class="list">
        ${this.checkpoints.map(
          (cp) => html`
            <li class="checkpoint" data-id=${cp.id}>
              <div class="checkpoint-row">
                <button
                  class="expand-btn"
                  aria-expanded=${this.expandedId === cp.id ? 'true' : 'false'}
                  @click=${() => void this.toggleFiles(cp)}
                >
                  <span class="label">${cp.label}</span>
                  <span class="meta">
                    ${timeAgo(cp.createdAt)}
                    · ${cp.filesChanged} file${cp.filesChanged === 1 ? '' : 's'}
                    ${cp.branch ? html` · on ${cp.branch}` : nothing}
                    ${cp.sessionId ? html` · agent <span class="session">${cp.sessionId}</span>` : nothing}
                  </span>
                </button>
                <button
                  class="btn btn-secondary restore-btn"
                  ?disabled=${this.busy}
                  @click=${() => void this.handleRestore(cp)}
                >Restore</button>
                <button
                  class="btn btn-ghost delete-btn"
                  aria-label="Delete checkpoint ${cp.label}"
                  ?disabled=${this.busy}
                  @click=${() => void this.handleDelete(cp)}
                >Delete</button>
              </div>
              ${this.renderFiles(cp)}
            </li>
          `,
        )}
      </ul>
    `;
  }

  render() {
    return html`
      <gn-modal
        .open=${this.open}
        modalTitle="Checkpoints"
        @close=${() => {
          if (this.busy || this.hooksBusy) {
            // Keep the modal up: a restore is rewriting the working tree.
            this.requestUpdate();
            return;
          }
          this.close();
        }}
      >
        <div class="content">
          <p class="intro">
            Snapshots of the working tree, including untracked files. Restoring one never
            changes your commits.
          </p>
          ${this.renderHooks()}
          <div class="create-row">
            <input
              type="text"
              class="label-input"
              placeholder="Checkpoint name (optional)"
              aria-label="Checkpoint name"
              maxlength="200"
              .value=${this.newLabel}
              @input=${(e: Event) => {
                this.newLabel = (e.target as HTMLInputElement).value;
              }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === 'Enter') void this.handleCreate();
              }}
            />
            <button
              class="btn btn-primary create-btn"
              ?disabled=${this.busy}
              @click=${() => void this.handleCreate()}
            >Create Checkpoint</button>
          </div>
          ${this.renderList()}
        </div>
      </gn-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-checkpoints-dialog': GnCheckpointsDialog;
  }
}
