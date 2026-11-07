/**
 * Agent Sessions Dialog (roadmap 4.1, issue #604)
 *
 * Mission control for terminal coding agents working in this repository:
 * which agents are running, in which worktree and branch, whether they are
 * mid-turn or waiting for you, how many files they have touched, and for how
 * long. Refreshes on its own while open. Agents that exit stay listed as
 * "Ended" until cleared, so a session that finished while you looked away is
 * not silently gone.
 */

import { html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sharedStyles, buttonStyles } from '../../styles/shared-styles.ts';
import {
  formatElapsed,
  listAgentSessions,
  type AgentSession,
} from '../../services/agent-sessions.service.ts';
import * as gitService from '../../services/git.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { GnRepoScopedDialogBase } from './gn-repo-scoped-dialog-base.ts';
import './gn-modal.ts';

/** How often the list refreshes while the dialog is open. */
export const AGENT_SESSIONS_POLL_MS = 3000;

interface EndedSession {
  session: AgentSession;
  endedAt: number;
}

const STATE_LABEL: Record<AgentSession['state'], string> = {
  working: 'Working',
  waiting: 'Waiting for input',
  running: 'Running',
};

const STATE_HINT: Record<AgentSession['state'], string> = {
  working: 'A turn is in progress',
  waiting: 'Finished its turn and is waiting for you',
  running: 'Turn state is shown once automatic Claude Code checkpoints are turned on for this repository',
};

@customElement('gn-agent-sessions-dialog')
export class GnAgentSessionsDialog extends GnRepoScopedDialogBase {
  static styles = [
    sharedStyles,
    buttonStyles,
    css`
      .content {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        min-width: min(620px, 88vw);
      }

      .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-sm);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .list {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 55vh;
        overflow-y: auto;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
      }

      .session {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        padding: var(--spacing-sm) var(--spacing-md);
        border-bottom: 1px solid var(--color-border);
      }

      .session:last-child {
        border-bottom: none;
      }

      .session.ended {
        opacity: 0.6;
      }

      .info {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .title-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .agent {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
      }

      .state {
        padding: 0 6px;
        border-radius: var(--radius-sm);
        font-size: var(--font-size-xs);
        background: var(--color-bg-tertiary);
        color: var(--color-text-secondary);
      }

      .state.working {
        color: var(--color-warning);
      }

      .state.waiting {
        color: var(--color-success);
      }

      .meta,
      .where {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .branch {
        font-family: var(--font-family-mono);
        color: var(--color-text-secondary);
      }

      .session .btn {
        flex-shrink: 0;
        padding: 2px 10px;
        font-size: var(--font-size-xs);
      }

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
    `,
  ];

  @state() private sessions: AgentSession[] = [];
  @state() private ended: EndedSession[] = [];
  @state() private loading = false;
  @state() private loaded = false;
  @state() private loadError: string | null = null;

  private pinnedRepoPath = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.open ? this.pinnedRepoPath : null;
  }

  /** Read-only: nothing to interrupt when the tab closes. */
  public get operationInFlight(): boolean {
    return false;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopPolling();
  }

  override updated(changed: Map<string, unknown>): void {
    super.updated(changed);
    if (changed.has('open')) {
      if (this.open) {
        this.pinnedRepoPath = this.repositoryPath;
        this.sessions = [];
        this.ended = [];
        this.loaded = false;
        this.loadError = null;
        void this.refresh();
        this.startPolling();
      } else {
        this.stopPolling();
      }
    }
  }

  close(): void {
    this.open = false;
    this.stopPolling();
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.refresh(), AGENT_SESSIONS_POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Re-read the process table. Public so tests and the Refresh button can drive it. */
  async refresh(): Promise<void> {
    if (this.inFlight || !this.open) return;
    const repoPath = this.pinnedRepoPath;
    this.inFlight = true;
    this.loading = !this.loaded;
    try {
      const result = await listAgentSessions(repoPath);
      if (!this.open || repoPath !== this.pinnedRepoPath) return;
      if (!result.success || !result.data) {
        this.loadError = result.error?.message ?? 'Failed to list agent sessions';
        return;
      }
      this.loadError = null;
      const next = result.data;
      const alive = new Set(next.map((s) => s.pid));
      // Sessions that disappeared since the last refresh have ended.
      const nowEnded = this.sessions
        .filter((s) => !alive.has(s.pid))
        .map((session) => ({ session, endedAt: Date.now() }));
      this.ended = [
        ...nowEnded,
        ...this.ended.filter((e) => !alive.has(e.session.pid)),
      ];
      this.sessions = next;
      this.loaded = true;
    } finally {
      this.inFlight = false;
      this.loading = false;
    }
  }

  private clearEnded(): void {
    this.ended = [];
  }

  private async openTerminal(session: AgentSession): Promise<void> {
    const result = await gitService.openTerminal(session.worktreePath);
    if (!result.success) {
      showToast(result.error?.message ?? 'Failed to open terminal', 'error');
    }
  }

  private renderWhere(s: AgentSession) {
    const place = s.isMainWorktree ? 'main checkout' : s.worktreePath;
    return html`
      <span class="where" title=${s.cwd}>
        ${s.branch ? html`<span class="branch">${s.branch}</span> · ` : html`detached HEAD · `}${place}
      </span>
    `;
  }

  private renderChanged(s: AgentSession): string {
    if (s.changedFiles === null) return 'changes unknown';
    if (s.changedFiles === 0) return 'no uncommitted changes';
    return `${s.changedFiles} changed file${s.changedFiles === 1 ? '' : 's'}`;
  }

  private renderSession(s: AgentSession) {
    return html`
      <li class="session" data-pid=${s.pid}>
        <div class="info">
          <div class="title-row">
            <span class="agent">${s.agent}</span>
            <span class="state ${s.state}" title=${STATE_HINT[s.state]}>${STATE_LABEL[s.state]}</span>
          </div>
          ${this.renderWhere(s)}
          <span class="meta" title=${`PID ${s.pid}: ${s.command}`}>
            ${this.renderChanged(s)} · running ${formatElapsed(s.elapsedSecs)}
          </span>
        </div>
        <button
          class="btn btn-secondary terminal-btn"
          title="Open a terminal in this worktree"
          @click=${() => void this.openTerminal(s)}
        >Terminal</button>
      </li>
    `;
  }

  private renderEnded(e: EndedSession) {
    const s = e.session;
    return html`
      <li class="session ended" data-pid=${s.pid}>
        <div class="info">
          <div class="title-row">
            <span class="agent">${s.agent}</span>
            <span class="state">Ended</span>
          </div>
          ${this.renderWhere(s)}
          <span class="meta">ran for ${formatElapsed(s.elapsedSecs)}</span>
        </div>
      </li>
    `;
  }

  private renderBody() {
    if (this.loading) return html`<div class="loading">Looking for agents…</div>`;
    if (this.loadError && !this.loaded) {
      return html`
        <div class="error-state">
          ${this.loadError}
          <div><button class="btn btn-secondary retry-btn" @click=${() => void this.refresh()}>Retry</button></div>
        </div>
      `;
    }
    if (this.sessions.length === 0 && this.ended.length === 0) {
      return html`
        <div class="empty-state">
          No coding agents are running in this repository or its worktrees.
          Claude Code, Codex CLI, Copilot CLI, Gemini CLI and Aider appear here as soon as
          they start.
        </div>
      `;
    }
    return html`
      <ul class="list">
        ${this.sessions.map((s) => this.renderSession(s))}
        ${this.ended.map((e) => this.renderEnded(e))}
      </ul>
    `;
  }

  render() {
    const count = this.sessions.length;
    return html`
      <gn-modal .open=${this.open} modalTitle="Agent Sessions" @close=${() => this.close()}>
        <div class="content">
          <div class="toolbar">
            <span class="summary">
              ${this.loaded
                ? `${count} running${this.ended.length ? ` · ${this.ended.length} ended` : ''} · updates automatically`
                : ''}
              ${this.loadError && this.loaded
                ? html` · <span class="stale-error">Last refresh failed: ${this.loadError}</span>`
                : nothing}
            </span>
            ${this.ended.length
              ? html`<button class="btn btn-ghost clear-ended-btn" @click=${this.clearEnded}>Clear ended</button>`
              : nothing}
          </div>
          ${this.renderBody()}
        </div>
      </gn-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-agent-sessions-dialog': GnAgentSessionsDialog;
  }
}
