/**
 * Live change feed (roadmap 4.1, #606).
 *
 * Shows what has changed in a worktree — typically one an agent is working
 * in — hunk by hunk, updating while it is open. Each hunk can be accepted
 * (staged), reverted (put back to the index) or answered with feedback that is
 * typed into the agent's terminal session in that worktree.
 */
import { html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sharedStyles, buttonStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import { showToast } from '../../services/notification.service.ts';
import {
  feedSignature,
  findAgentTerminal,
  formatFeedback,
  hunkRange,
  loadFeed,
  sendFeedback,
  type FeedFile,
} from '../../services/change-feed.service.ts';
import { subscribeTerminals } from '../../services/terminal.service.ts';
import type { IndexedDiffHunk } from '../../types/git.types.ts';
import type { Worktree } from '../../services/git/remotes.ts';
import { GnRepoScopedDialogBase } from './gn-repo-scoped-dialog-base.ts';
import './gn-modal.ts';

/** How often the open feed re-reads the worktree's status. */
export const FEED_POLL_MS = 2000;
/** Every this many ticks the hunks are re-read even if the file list is unchanged. */
export const FEED_FULL_RELOAD_TICKS = 3;

@customElement('gn-change-feed-dialog')
export class GnChangeFeedDialog extends GnRepoScopedDialogBase {
  static styles = [
    sharedStyles,
    buttonStyles,
    css`
      .feed {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        width: min(860px, 88vw);
        max-height: 70vh;
      }
      .toolbar {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        font-size: var(--font-size-sm);
      }
      .toolbar select {
        flex: 1;
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
      }
      .agent {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        white-space: nowrap;
      }
      .agent.live {
        color: var(--color-success);
      }
      .files {
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
      }
      .file-name {
        font-family: var(--font-mono, monospace);
        font-size: var(--font-size-sm);
        font-weight: 600;
        margin-bottom: var(--spacing-xs);
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }
      .file-tag {
        font-size: var(--font-size-xs);
        font-weight: normal;
        color: var(--color-text-muted);
      }
      .hunk {
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        margin-bottom: var(--spacing-sm);
      }
      .hunk-head {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: 2px var(--spacing-sm);
        background: var(--color-bg-secondary);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }
      .hunk-head .range {
        margin-right: auto;
      }
      pre {
        margin: 0;
        padding: var(--spacing-xs) 0;
        font-size: var(--font-size-xs);
        overflow-x: auto;
      }
      .line {
        display: block;
        padding: 0 var(--spacing-sm);
        white-space: pre;
      }
      .line.addition {
        background: var(--color-diff-add-bg, rgba(46, 160, 67, 0.15));
      }
      .line.deletion {
        background: var(--color-diff-del-bg, rgba(248, 81, 73, 0.15));
      }
      .feedback {
        display: flex;
        gap: var(--spacing-xs);
        padding: var(--spacing-xs) var(--spacing-sm);
        border-top: 1px solid var(--color-border);
      }
      .feedback textarea {
        flex: 1;
        min-height: 48px;
        resize: vertical;
        font-family: inherit;
        font-size: var(--font-size-sm);
      }
      .empty,
      .muted {
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }
      .notice,
      .error {
        padding: var(--spacing-xs) var(--spacing-sm);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-sm);
      }
      .notice {
        background: var(--color-bg-secondary);
      }
      .error {
        color: var(--color-error);
        border: 1px solid var(--color-error);
      }
    `,
  ];

  @state() private worktrees: Worktree[] = [];
  @state() private selected = '';
  @state() private files: FeedFile[] = [];
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private notice: string | null = null;
  /** Key of the hunk or file an action is running on. */
  @state() private busyKey: string | null = null;
  @state() private feedbackKey: string | null = null;
  @state() private feedbackText = '';
  @state() private agentLabel: string | null = null;

  private pinnedRepoPath = '';
  private signature: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeTerminals: (() => void) | null = null;
  private polling = false;
  private tick = 0;
  private readFailed = false;

  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.open ? this.pinnedRepoPath : null;
  }

  public get operationInFlight(): boolean {
    return this.busyKey !== null;
  }

  override updated(changed: Map<string, unknown>): void {
    super.updated(changed);
    if (changed.has('open')) {
      if (this.open) void this.start();
      else this.stop();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stop();
  }

  close(): void {
    if (this.busyKey) return;
    this.open = false;
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private async start(): Promise<void> {
    this.pinnedRepoPath = this.repositoryPath;
    this.files = [];
    this.error = null;
    this.notice = null;
    this.feedbackKey = null;
    this.signature = null;
    // Loading from the first frame: the empty state ("No unaccepted changes")
    // must not flash up before anything has been read.
    this.loading = true;
    const result = await gitService.getWorktrees(this.pinnedRepoPath);
    if (!this.open) return;
    this.worktrees = result.success && result.data ? result.data.filter((w) => !w.isBare && !w.isPrunable) : [];
    // Prefer a worktree with an agent running in it, then a linked worktree,
    // then the repository itself.
    const withAgent = this.worktrees.find((w) => findAgentTerminal(w.path));
    const linked = this.worktrees.find((w) => !w.isMain);
    this.selected = (withAgent ?? linked)?.path ?? this.pinnedRepoPath;
    this.unsubscribeTerminals = subscribeTerminals(() => this.refreshAgent());
    this.refreshAgent();
    await this.poll(true);
    if (this.open && !this.pollTimer) {
      this.pollTimer = setInterval(() => void this.poll(false), FEED_POLL_MS);
    }
  }

  private stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.unsubscribeTerminals?.();
    this.unsubscribeTerminals = null;
  }

  private refreshAgent(): void {
    this.agentLabel = this.selected ? (findAgentTerminal(this.selected)?.label ?? null) : null;
  }

  /** Re-read status; reload hunks only when the set of changed files moved. */
  private async poll(force: boolean): Promise<void> {
    if (this.polling || !this.selected || this.busyKey) return;
    this.polling = true;
    const path = this.selected;
    try {
      if (force) this.loading = true;
      const status = await gitService.getStatus(path);
      if (path !== this.selected || !this.open) return;
      if (!status.success || !status.data) {
        this.error = `Could not read ${path}: ${status.error?.message ?? 'Unknown error'}`;
        this.readFailed = true;
        return;
      }
      // A read error clears once a read succeeds; an action's error stays
      // until the next action, so the reload after a failure cannot hide it.
      if (this.readFailed) {
        this.error = null;
        this.readFailed = false;
      }
      const signature = feedSignature(status.data);
      // Reload the hunks when the set of changed files moved. A file the agent
      // edits again keeps the same signature, so while there are changes the
      // hunks are also re-read every few ticks; the status read alone is cheap.
      this.tick += 1;
      const stale = signature !== '' && this.tick % FEED_FULL_RELOAD_TICKS === 0;
      if (!force && signature === this.signature && !stale) return;
      this.signature = signature;
      const files = await loadFeed(path, status.data);
      if (path !== this.selected || !this.open) return;
      this.files = files;
    } finally {
      this.loading = false;
      this.polling = false;
    }
  }

  private async selectWorktree(path: string): Promise<void> {
    this.selected = path;
    this.files = [];
    this.feedbackKey = null;
    this.notice = null;
    this.refreshAgent();
    await this.poll(true);
  }

  private key(file: FeedFile, hunk: IndexedDiffHunk | null): string {
    return hunk ? `${file.path}#${hunk.index}` : file.path;
  }

  private changed(): void {
    this.dispatchRepoEvent('change-feed-applied', this.pinnedRepoPath, { worktreePath: this.selected });
  }

  private async run(key: string, action: () => Promise<{ success: boolean; error?: { message?: string } }>, done: string, failed: string): Promise<void> {
    this.busyKey = key;
    this.error = null;
    this.notice = null;
    try {
      const result = await action();
      if (result.success) {
        this.notice = done;
        this.changed();
      } else {
        this.error = `${failed}: ${result.error?.message ?? 'Unknown error'}`;
        showToast(this.error, 'error');
      }
    } finally {
      this.busyKey = null;
    }
    await this.poll(true);
  }

  private accept(file: FeedFile, hunk: IndexedDiffHunk | null): Promise<void> {
    const path = this.selected;
    return this.run(
      this.key(file, hunk),
      () => (hunk ? gitService.stageHunkByIndex(path, file.path, hunk.index) : gitService.stageFiles(path, { paths: [file.path] })),
      hunk ? `Accepted ${file.path} (${hunkRange(hunk)})` : `Accepted ${file.path}`,
      'Could not accept the change',
    );
  }

  private async revert(file: FeedFile, hunk: IndexedDiffHunk | null): Promise<void> {
    const what = hunk ? `this change to ${file.path} (${hunkRange(hunk)})` : file.isNew ? `the new file ${file.path}` : `every change to ${file.path}`;
    const confirmed = await showConfirm('Revert change', `Revert ${what}? This cannot be undone.`, 'warning');
    if (!confirmed) return;
    const path = this.selected;
    await this.run(
      this.key(file, hunk),
      () => (hunk ? gitService.discardHunkByIndex(path, file.path, hunk.index) : gitService.discardChanges(path, [file.path])),
      hunk ? `Reverted ${file.path} (${hunkRange(hunk)})` : `Reverted ${file.path}`,
      'Could not revert the change',
    );
  }

  private async submitFeedback(file: FeedFile, hunk: IndexedDiffHunk | null): Promise<void> {
    if (!this.feedbackText.trim()) return;
    const message = formatFeedback(file.path, hunk, this.feedbackText);
    const result = await sendFeedback(this.selected, message);
    if (result.via === 'terminal') {
      this.notice = `Feedback sent to ${result.label}`;
    } else if (result.via === 'clipboard') {
      this.notice = 'No agent terminal is running in this worktree — the feedback was copied to the clipboard';
    } else {
      this.error = 'Could not send the feedback: no agent terminal is running here and the clipboard is unavailable';
      showToast(this.error, 'error');
      return;
    }
    this.feedbackKey = null;
    this.feedbackText = '';
  }

  private renderActions(file: FeedFile, hunk: IndexedDiffHunk | null) {
    const key = this.key(file, hunk);
    const busy = this.busyKey !== null;
    return html`
      <button class="btn btn-sm btn-primary" data-action="accept" ?disabled=${busy} @click=${() => void this.accept(file, hunk)}>Accept</button>
      <button class="btn btn-sm btn-secondary" data-action="revert" ?disabled=${busy} @click=${() => void this.revert(file, hunk)}>Revert</button>
      <button
        class="btn btn-sm btn-secondary"
        data-action="feedback"
        @click=${() => { this.feedbackKey = this.feedbackKey === key ? null : key; this.feedbackText = ''; }}
      >Feedback</button>
    `;
  }

  private renderFeedback(file: FeedFile, hunk: IndexedDiffHunk | null) {
    if (this.feedbackKey !== this.key(file, hunk)) return nothing;
    return html`
      <div class="feedback">
        <textarea
          placeholder=${this.agentLabel ? `Tell ${this.agentLabel} what to change…` : 'Feedback for the agent (copied to the clipboard: no agent terminal is running here)'}
          .value=${this.feedbackText}
          @input=${(e: Event) => { this.feedbackText = (e.target as HTMLTextAreaElement).value; }}
          @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void this.submitFeedback(file, hunk); }}
        ></textarea>
        <button class="btn btn-sm btn-primary" data-action="send-feedback" ?disabled=${!this.feedbackText.trim()} @click=${() => void this.submitFeedback(file, hunk)}>
          ${this.agentLabel ? 'Send' : 'Copy'}
        </button>
      </div>
    `;
  }

  private renderFile(file: FeedFile) {
    const tag = file.isNew ? 'new file' : file.isDeleted ? 'deleted' : `${file.hunks.length} change${file.hunks.length === 1 ? '' : 's'}`;
    const wholeFile = file.isNew || file.isDeleted || file.hunks.length === 0;
    return html`
      <section class="file" data-file=${file.path}>
        <div class="file-name">
          <span>${file.path}</span>
          <span class="file-tag">${tag}</span>
        </div>
        ${file.hunksError ? html`<div class="muted">${file.hunksError}</div>` : nothing}
        ${wholeFile ? html`
          <div class="hunk" data-hunk="file">
            <div class="hunk-head"><span class="range">${file.isNew ? 'whole file (untracked)' : 'whole file'}</span>${this.renderActions(file, null)}</div>
            ${this.renderFeedback(file, null)}
          </div>
        ` : file.hunks.map((hunk) => html`
          <div class="hunk" data-hunk=${hunk.index}>
            <div class="hunk-head"><span class="range">${hunkRange(hunk)}</span>${this.renderActions(file, hunk)}</div>
            <pre>${hunk.lines.map((l) => html`<span class="line ${l.lineType}">${l.lineType === 'addition' ? '+' : l.lineType === 'deletion' ? '-' : ' '}${l.content.replace(/\n$/, '')}</span>`)}</pre>
            ${this.renderFeedback(file, hunk)}
          </div>
        `)}
      </section>
    `;
  }

  render() {
    const label = (w: Worktree) => `${w.isMain ? 'Repository' : w.branch ?? 'detached'} — ${w.path}`;
    return html`
      <gn-modal .open=${this.open} modalTitle="Agent Changes" @close=${() => this.close()}>
        <div class="feed">
          <div class="toolbar">
            <select
              class="worktree-select"
              .value=${this.selected}
              @change=${(e: Event) => void this.selectWorktree((e.target as HTMLSelectElement).value)}
            >
              ${this.worktrees.length === 0 ? html`<option value=${this.pinnedRepoPath}>${this.pinnedRepoPath}</option>` : nothing}
              ${this.worktrees.map((w) => html`<option value=${w.path} ?selected=${w.path === this.selected}>${label(w)}</option>`)}
            </select>
            <span class="agent ${this.agentLabel ? 'live' : ''}">
              ${this.agentLabel ? `● ${this.agentLabel}` : 'No agent terminal here'}
            </span>
          </div>
          ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
          ${this.notice ? html`<div class="notice" role="status">${this.notice}</div>` : nothing}
          <div class="files">
            ${this.loading && this.files.length === 0
              ? html`<div class="muted">Loading changes…</div>`
              : this.files.length === 0
                ? html`<div class="empty">No unaccepted changes in this worktree. This list updates as the agent works.</div>`
                : this.files.map((f) => this.renderFile(f))}
          </div>
        </div>
      </gn-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-change-feed-dialog': GnChangeFeedDialog;
  }
}
