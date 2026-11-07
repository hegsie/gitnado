/**
 * Embedded Terminal Panel (roadmap 4.6, issue #628)
 *
 * A tabbed terminal pane for the active repository. Each tab is a shell on a
 * real PTY, started in the repository root or in one of its worktrees. The
 * sessions themselves live in terminal.service.ts, so hiding this panel or
 * switching repository tabs keeps every shell (and its scrollback) alive.
 */

import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { sharedStyles, buttonStyles } from '../../styles/shared-styles.ts';
import { xtermStyles } from '../../styles/xterm-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showToast } from '../../services/notification.service.ts';
import {
  attachTerminalSession,
  closeTerminalSession,
  createTerminalSession,
  fitTerminalSession,
  getTerminalSessions,
  subscribeTerminals,
  type TerminalSession,
} from '../../services/terminal.service.ts';

interface WorktreeOption {
  path: string;
  label: string;
}

@customElement('gn-terminal-panel')
export class GnTerminalPanel extends LitElement {
  static styles = [
    sharedStyles,
    buttonStyles,
    xtermStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
      }

      .header {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: 0 var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border-bottom: 1px solid var(--color-border);
        flex-shrink: 0;
        min-height: 28px;
      }

      .tabs {
        display: flex;
        flex: 1;
        min-width: 0;
        overflow-x: auto;
        gap: 2px;
      }

      .tab {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 2px 4px 2px 8px;
        border: none;
        border-radius: var(--radius-sm) var(--radius-sm) 0 0;
        background: none;
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        white-space: nowrap;
        cursor: pointer;
      }

      .tab.active {
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
      }

      .tab.exited .tab-label,
      .tab.failed .tab-label {
        text-decoration: line-through;
        opacity: 0.7;
      }

      .tab-close,
      .icon-btn {
        font-size: var(--font-size-xs);
        padding: 0 6px;
        border: none;
        border-radius: var(--radius-sm);
        background: none;
        color: var(--color-text-muted);
        cursor: pointer;
        line-height: 18px;
      }

      .tab-close:hover,
      .icon-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .cwd-select {
        font-size: var(--font-size-xs);
        max-width: 180px;
        padding: 1px 4px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--color-border);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
      }

      .body {
        flex: 1;
        min-height: 0;
        position: relative;
        background: var(--color-bg-primary);
      }

      .terminal-container {
        position: absolute;
        inset: 4px 0 0 8px;
      }

      .terminal-container .terminal-host {
        width: 100%;
        height: 100%;
      }

      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--spacing-sm);
        height: 100%;
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }
    `,
  ];

  @property({ type: String }) repositoryPath = '';

  @state() private sessions: TerminalSession[] = [];
  @state() private activeKey: string | null = null;
  @state() private worktrees: WorktreeOption[] = [];
  @state() private selectedCwd = '';
  @state() private creating = false;

  @query('.terminal-container') private container?: HTMLElement;

  private unsubscribe?: () => void;
  private resizeObserver?: ResizeObserver;
  /** Repositories this panel has already opened a first terminal for. */
  private autoStarted = new Set<string>();
  private worktreeLoadGen = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribe = subscribeTerminals(() => this.syncSessions());
    this.resizeObserver = new ResizeObserver(() => this.fitActive());
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.resizeObserver?.disconnect();
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('repositoryPath')) {
      this.syncSessions();
      this.selectedCwd = this.repositoryPath;
      void this.loadWorktrees();
    }
  }

  protected updated(changed: PropertyValues<this>): void {
    if (changed.has('repositoryPath') && this.repositoryPath) {
      // Opening the panel with no terminal yet starts one, the way every
      // editor's terminal pane does. Only once per repository: closing the
      // last tab must leave the empty state, not respawn a shell.
      if (this.sessions.length === 0 && !this.autoStarted.has(this.repositoryPath)) {
        this.autoStarted.add(this.repositoryPath);
        void this.newTerminal();
      }
    }
    if (this.container) {
      this.resizeObserver?.observe(this.container);
      const active = this.activeSession;
      if (active) {
        attachTerminalSession(active, this.container);
      }
    }
  }

  private get activeSession(): TerminalSession | undefined {
    return this.sessions.find((s) => s.key === this.activeKey);
  }

  private syncSessions(): void {
    const previous = new Set(this.sessions.map((s) => s.key));
    const repoChanged = this.sessions.some((s) => s.repoPath !== this.repositoryPath);
    this.sessions = getTerminalSessions(this.repositoryPath);
    // A session that just appeared — from the + button, the palette, or an
    // agent started on a task — is the one the user wants to see.
    const added = repoChanged ? undefined : this.sessions.filter((s) => !previous.has(s.key)).at(-1);
    if (added) {
      this.activeKey = added.key;
    } else if (!this.sessions.some((s) => s.key === this.activeKey)) {
      this.activeKey = this.sessions.at(-1)?.key ?? null;
    }
    this.requestUpdate();
  }

  private fitActive(): void {
    const active = this.activeSession;
    if (active) fitTerminalSession(active);
  }

  private async loadWorktrees(): Promise<void> {
    const repoPath = this.repositoryPath;
    const gen = ++this.worktreeLoadGen;
    this.worktrees = [];
    if (!repoPath) return;
    const result = await gitService.getWorktrees(repoPath);
    if (gen !== this.worktreeLoadGen) return;
    // Worktrees only add a choice; failing to list them still leaves the
    // repository root, so this is not worth interrupting the user over.
    if (!result.success || !result.data) return;
    this.worktrees = result.data
      .filter((w) => !w.isBare && !w.isPrunable)
      .map((w) => ({
        path: w.path,
        label: w.branch ? `${w.branch} — ${w.path}` : w.path,
      }));
  }

  /** Start a new terminal in the selected directory. */
  async newTerminal(): Promise<void> {
    if (!this.repositoryPath || this.creating) return;
    this.creating = true;
    const repoPath = this.repositoryPath;
    try {
      const session = await createTerminalSession({
        repoPath,
        cwd: this.selectedCwd || repoPath,
      });
      if (repoPath === this.repositoryPath) {
        this.activeKey = session.key;
        this.syncSessions();
      }
      if (session.status === 'failed') {
        showToast(`Could not start terminal: ${session.error}`, 'error');
      }
    } finally {
      this.creating = false;
    }
  }

  private selectTab(key: string): void {
    this.activeKey = key;
    // Focus after the session has been attached by updated().
    void this.updateComplete.then(() => this.activeSession?.term.focus());
  }

  private async closeTab(e: Event, key: string): Promise<void> {
    e.stopPropagation();
    await closeTerminalSession(key);
  }

  private handleClose(): void {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private renderCwdPicker() {
    // Only worth showing when there is more than one place to open a shell.
    if (this.worktrees.length < 2) return nothing;
    return html`
      <select
        class="cwd-select"
        aria-label="Directory for new terminal"
        title="Directory for new terminal"
        .value=${this.selectedCwd}
        @change=${(e: Event) => {
          this.selectedCwd = (e.target as HTMLSelectElement).value;
        }}
      >
        ${this.worktrees.map(
          (w) => html`<option value=${w.path} ?selected=${w.path === this.selectedCwd}>${w.label}</option>`,
        )}
      </select>
    `;
  }

  render() {
    return html`
      <div class="header">
        <div class="tabs" role="tablist" aria-label="Terminals">
          ${this.sessions.map(
            (s) => html`
              <div
                class="tab ${s.key === this.activeKey ? 'active' : ''} ${s.status}"
                role="tab"
                tabindex="0"
                aria-selected=${s.key === this.activeKey ? 'true' : 'false'}
                title=${s.status === 'exited'
                  ? `${s.cwd} (exited${s.exitCode !== null ? ` with code ${s.exitCode}` : ''})`
                  : s.status === 'failed'
                    ? `${s.cwd} (failed to start)`
                    : s.cwd}
                @click=${() => this.selectTab(s.key)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') this.selectTab(s.key);
                }}
              >
                <span class="tab-label">${s.label}</span>
                <button
                  class="tab-close"
                  aria-label="Close terminal ${s.label}"
                  title="Close terminal"
                  @click=${(e: Event) => void this.closeTab(e, s.key)}
                >×</button>
              </div>
            `,
          )}
        </div>
        ${this.renderCwdPicker()}
        <button
          class="icon-btn new-terminal-btn"
          aria-label="New terminal"
          title="New terminal"
          ?disabled=${this.creating}
          @click=${() => void this.newTerminal()}
        >+</button>
        <button
          class="icon-btn close-panel-btn"
          aria-label="Hide terminal panel"
          title="Hide terminal panel (terminals keep running)"
          @click=${this.handleClose}
        >×</button>
      </div>
      <div class="body">
        ${this.activeSession
          ? html`<div class="terminal-container" role="tabpanel"></div>`
          : html`
              <div class="empty-state">
                <span>No terminals open</span>
                <button class="btn btn-sm" @click=${() => void this.newTerminal()}>
                  New Terminal
                </button>
              </div>
            `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-terminal-panel': GnTerminalPanel;
  }
}
