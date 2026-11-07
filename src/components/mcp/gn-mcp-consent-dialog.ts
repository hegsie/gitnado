/**
 * MCP write approval (roadmap 4.2, issue #610).
 *
 * Shows each write an agent asks for over MCP — what it is, in which
 * repository and branch, with a preview — and sends the user's answer back.
 * Requests queue; unanswered ones expire on the backend (and are denied).
 * Applied writes are re-dispatched as `mcp-write-applied` so the shell can
 * refresh that repository.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { sharedStyles, buttonStyles } from '../../styles/shared-styles.ts';
import * as mcpService from '../../services/mcp.service.ts';
import type {
  McpConsentRequest,
  McpConsentResolved,
  McpWriteApplied,
} from '../../services/mcp.service.ts';
import { listenToEvent, safeUnlisten } from '../../services/tauri-api.ts';
import { showToast } from '../../services/notification.service.ts';
import '../dialogs/gn-modal.ts';

const TOOL_LABEL: Record<string, string> = {
  stage: 'Stage files',
  commit: 'Commit',
  create_branch: 'Create branch',
  create_worktree: 'Create worktree',
  stash: 'Stash changes',
  checkout: 'Check out branch',
};

@customElement('gn-mcp-consent-dialog')
export class GnMcpConsentDialog extends LitElement {
  static styles = [
    sharedStyles,
    buttonStyles,
    css`
      .content {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        min-width: min(520px, 85vw);
      }

      .lead {
        margin: 0;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .summary {
        font-size: var(--font-size-md, 15px);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
      }

      .where {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      code,
      .details {
        font-family: var(--font-family-mono);
      }

      .details {
        margin: 0;
        padding: var(--spacing-sm);
        max-height: 200px;
        overflow: auto;
        list-style: none;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        white-space: pre;
      }

      .remember {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        flex-wrap: wrap;
      }

      .remember input[type='text'] {
        width: 140px;
        padding: 1px 6px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
      }

      .queue {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .footer {
        display: flex;
        justify-content: flex-end;
        gap: var(--spacing-sm);
      }
    `,
  ];

  @state() private queue: McpConsentRequest[] = [];
  @state() private remember = false;
  @state() private pattern = '';
  @state() private answering = false;

  private unlisteners: UnlistenFn[] = [];

  connectedCallback(): void {
    super.connectedCallback();
    void this.start();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const fn of this.unlisteners) safeUnlisten(fn);
    this.unlisteners = [];
  }

  private async start(): Promise<void> {
    try {
      this.unlisteners = await Promise.all([
        listenToEvent<McpConsentRequest>('mcp-consent-request', (r) => this.enqueue(r)),
        listenToEvent<McpConsentResolved>('mcp-consent-resolved', (r) => this.resolved(r)),
        listenToEvent<McpWriteApplied>('mcp-write-applied', (a) => this.applied(a)),
      ]);
    } catch {
      // No event bridge (plain browser); nothing can ask for consent.
    }
    // Requests that arrived before this view existed (e.g. after a reload).
    const pending = await mcpService.getPendingMcpConsents();
    if (pending.success && pending.data) {
      for (const r of pending.data) this.enqueue(r);
    }
  }

  /** Exposed for tests: add a request as if the event had arrived. */
  enqueue(request: McpConsentRequest): void {
    if (this.queue.some((r) => r.id === request.id)) return;
    const wasEmpty = this.queue.length === 0;
    this.queue = [...this.queue, request];
    if (wasEmpty) this.resetRemember();
  }

  /** Exposed for tests: drop a request answered or expired elsewhere. */
  resolved(event: McpConsentResolved): void {
    const head = this.queue[0];
    if (!this.queue.some((r) => r.id === event.id)) return;
    this.queue = this.queue.filter((r) => r.id !== event.id);
    if (event.expired && head?.id === event.id) {
      showToast(`Agent request expired without an answer: ${head.summary}`, 'warning');
    }
    if (head?.id === event.id) this.resetRemember();
  }

  /** Exposed for tests: announce a write and ask the shell to refresh. */
  applied(event: McpWriteApplied): void {
    showToast(
      `Agent: ${event.summary}${event.byPolicy ? ' (always allowed)' : ''}`,
      'info',
    );
    this.dispatchEvent(
      new CustomEvent('mcp-write-applied', {
        detail: { repositoryPath: event.repoPath, tool: event.tool },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private resetRemember(): void {
    this.remember = false;
    this.pattern = this.queue[0]?.branch ?? '';
  }

  private async answer(approve: boolean): Promise<void> {
    const request = this.queue[0];
    if (!request || this.answering) return;
    this.answering = true;
    try {
      const pattern = approve && this.remember && this.pattern.trim() ? this.pattern.trim() : undefined;
      const result = await mcpService.respondMcpConsent(request.id, approve, pattern);
      if (!result.success) {
        showToast(`Could not answer the agent: ${result.error?.message ?? 'Unknown error'}`, 'error');
      } else if (!approve) {
        showToast(`Declined: ${request.summary}`, 'info');
      }
      // Answered or no longer waiting either way: move on.
      this.queue = this.queue.filter((r) => r.id !== request.id);
      this.resetRemember();
    } finally {
      this.answering = false;
    }
  }

  private repoName(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  }

  private renderRequest(request: McpConsentRequest) {
    const label = TOOL_LABEL[request.tool] ?? request.tool;
    return html`
      <div class="content">
        <p class="lead">A tool connected through MCP asked Gitnado to:</p>
        <div>
          <div class="summary">${request.summary}</div>
          <div class="where">
            ${label} in <span title=${request.repoPath}>${this.repoName(request.repoPath)}</span>
            ${request.branch ? html` on <code>${request.branch}</code>` : html` (detached HEAD)`}
          </div>
        </div>
        ${request.details.length
          ? html`<ul class="details">${request.details.map((d) => html`<li>${d}</li>`)}</ul>`
          : nothing}
        ${request.branch
          ? html`
              <label class="remember">
                <input
                  type="checkbox"
                  class="remember-check"
                  .checked=${this.remember}
                  @change=${(e: Event) => {
                    this.remember = (e.target as HTMLInputElement).checked;
                  }}
                />
                Always allow <code>${request.tool}</code> here on branches matching
                <input
                  type="text"
                  class="pattern-input"
                  aria-label="Branch pattern"
                  .value=${this.pattern}
                  @input=${(e: Event) => {
                    this.pattern = (e.target as HTMLInputElement).value;
                  }}
                />
              </label>
            `
          : nothing}
        ${this.queue.length > 1
          ? html`<div class="queue">${this.queue.length - 1} more waiting</div>`
          : nothing}
        <div class="footer">
          <button class="btn btn-secondary deny-btn" ?disabled=${this.answering} @click=${() => void this.answer(false)}>
            Deny
          </button>
          <button class="btn btn-primary approve-btn" ?disabled=${this.answering} @click=${() => void this.answer(true)}>
            Approve
          </button>
        </div>
      </div>
    `;
  }

  render() {
    const request = this.queue[0];
    // The modal stays in the DOM and is opened/closed, like every other
    // dialog: removing an open <gn-modal> leaves its focus trap chasing an
    // element that no longer exists.
    return html`
      <gn-modal
        .open=${request !== undefined}
        modalTitle="An agent wants to make a change"
        .showClose=${false}
        @close=${() => {
          if (this.queue.length > 0) void this.answer(false);
        }}
      >
        ${request ? this.renderRequest(request) : nothing}
      </gn-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-mcp-consent-dialog': GnMcpConsentDialog;
  }
}
