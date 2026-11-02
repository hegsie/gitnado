/**
 * MCP client tokens and one-click setup (roadmap 4.2, issue #612).
 *
 * Each MCP client gets its own named token, shown once with ready-to-paste
 * setup for Claude Code, Cursor, VS Code or any stdio client. Tokens can be
 * revoked individually; the list shows when each client was last seen.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles, buttonStyles } from '../../styles/shared-styles.ts';
import * as mcpService from '../../services/mcp.service.ts';
import type { McpClientInfo, McpStdioCommand } from '../../services/mcp.service.ts';
import { allSnippets, type McpClientKind } from '../../services/mcp-snippets.ts';
import { showToast } from '../../services/notification.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';

function ago(seconds: number | null): string {
  if (seconds === null) return 'never used';
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (diff < 60) return 'used just now';
  if (diff < 3600) return `used ${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `used ${Math.floor(diff / 3600)}h ago`;
  return `used ${Math.floor(diff / 86400)}d ago`;
}

@customElement('gn-mcp-clients')
export class GnMcpClients extends LitElement {
  static styles = [
    sharedStyles,
    buttonStyles,
    css`
      :host {
        display: block;
        padding: var(--spacing-sm) 0;
      }

      .name {
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
      }

      .description,
      .empty,
      .meta {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .error {
        font-size: var(--font-size-xs);
        color: var(--color-error);
      }

      .create-row {
        display: flex;
        gap: var(--spacing-sm);
        margin: var(--spacing-sm) 0;
      }

      .create-row input {
        flex: 1;
        padding: 2px 8px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
      }

      .btn {
        padding: 2px 10px;
        font-size: var(--font-size-xs);
      }

      .clients {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .client {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-sm);
        padding: 4px 0;
      }

      .new-token {
        margin: var(--spacing-sm) 0;
        padding: var(--spacing-sm);
        border: 1px solid var(--color-warning);
        border-radius: var(--radius-sm);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .tabs {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
      }

      .tab {
        padding: 2px 8px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: none;
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        cursor: pointer;
      }

      .tab.active {
        background: var(--color-bg-tertiary);
        color: var(--color-text-primary);
      }

      pre {
        margin: 0;
        padding: var(--spacing-sm);
        max-height: 160px;
        overflow: auto;
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-sm);
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
        white-space: pre-wrap;
        word-break: break-all;
      }

      .snippet-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
    `,
  ];

  /** Port the MCP server listens on (for the setup snippets). */
  @property({ type: Number }) port = 3001;

  @state() private clients: McpClientInfo[] = [];
  @state() private loadError: string | null = null;
  @state() private newName = '';
  @state() private busy = false;
  /** The just-created client and its token: shown once, then gone. */
  @state() private created: { name: string; token: string } | null = null;
  @state() private activeKind: McpClientKind = 'claude-code';
  @state() private stdio: McpStdioCommand | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
    void mcpService.getMcpStdioCommand().then((r) => {
      if (r.success && r.data) this.stdio = r.data;
    });
  }

  async load(): Promise<void> {
    const result = await mcpService.listMcpClients();
    if (result.success && result.data) {
      this.clients = result.data;
      this.loadError = null;
    } else {
      this.loadError = result.error?.message ?? 'Could not load MCP clients';
    }
  }

  private async create(): Promise<void> {
    if (this.busy || !this.newName.trim()) return;
    this.busy = true;
    try {
      const result = await mcpService.createMcpClient(this.newName.trim());
      if (!result.success || !result.data) {
        showToast(`Failed to add client: ${result.error?.message ?? 'Unknown error'}`, 'error');
        return;
      }
      this.created = { name: result.data.client.name, token: result.data.token };
      this.newName = '';
      showToast(`Token created for ${result.data.client.name} — copy it now, it won't be shown again`, 'success');
      await this.load();
    } finally {
      this.busy = false;
    }
  }

  private async revoke(client: McpClientInfo): Promise<void> {
    const confirmed = await showConfirm(
      'Revoke MCP client',
      `Revoke the token for "${client.name}"? It stops working immediately.`,
      'warning',
    );
    if (!confirmed) return;
    const result = await mcpService.revokeMcpClient(client.id);
    if (!result.success) {
      showToast(`Failed to revoke: ${result.error?.message ?? 'Unknown error'}`, 'error');
      return;
    }
    showToast(`Revoked ${client.name}`, 'success');
    await this.load();
  }

  private async copy(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${what} copied to clipboard`, 'success');
    } catch {
      showToast(`Failed to copy ${what} to clipboard`, 'error');
    }
  }

  private renderCreated() {
    if (!this.created) return nothing;
    const snippets = allSnippets(this.port, this.created.token, this.stdio);
    const active = snippets.find((s) => s.kind === this.activeKind) ?? snippets[0];
    return html`
      <div class="new-token" role="region" aria-label="New client token">
        <div class="name">Set up ${this.created.name}</div>
        <div class="description">
          This token is shown only once. Paste the setup below into your client, or copy the
          token itself.
        </div>
        <div class="tabs" role="tablist">
          ${snippets.map(
            (s) => html`<button
              class="tab ${s.kind === active.kind ? 'active' : ''}"
              role="tab"
              aria-selected=${s.kind === active.kind ? 'true' : 'false'}
              data-kind=${s.kind}
              @click=${() => (this.activeKind = s.kind)}
            >${s.label}</button>`,
          )}
        </div>
        <div class="snippet-head">
          <span class="meta">${active.where}</span>
          <button class="btn btn-secondary copy-snippet-btn" @click=${() => void this.copy(active.text, `${active.label} setup`)}>
            Copy
          </button>
        </div>
        <pre class="snippet">${active.text}</pre>
        <div class="snippet-head">
          <button class="btn btn-ghost copy-token-btn" @click=${() => void this.copy(this.created!.token, 'Token')}>
            Copy token only
          </button>
          <button class="btn btn-ghost done-btn" @click=${() => (this.created = null)}>Done</button>
        </div>
      </div>
    `;
  }

  render() {
    return html`
      <div class="name">Connected clients</div>
      <div class="description">
        Give each MCP client (Claude Code, Cursor, VS Code…) its own token so you can see what
        is connected and revoke one without affecting the others.
      </div>
      <div class="create-row">
        <input
          type="text"
          class="client-name-input"
          placeholder="Client name, e.g. Claude Code"
          aria-label="New MCP client name"
          maxlength="60"
          .value=${this.newName}
          @input=${(e: Event) => (this.newName = (e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') void this.create();
          }}
        />
        <button
          class="btn btn-primary add-client-btn"
          ?disabled=${this.busy || !this.newName.trim()}
          @click=${() => void this.create()}
        >Add Client</button>
      </div>
      ${this.renderCreated()}
      ${this.loadError
        ? html`<div class="error">${this.loadError}</div>`
        : this.clients.length === 0
          ? html`<div class="empty">No client tokens yet.</div>`
          : html`
              <ul class="clients">
                ${this.clients.map(
                  (c) => html`
                    <li class="client">
                      <span>
                        <span class="name">${c.name}</span>
                        <span class="meta"> · ${ago(c.lastUsedAt)}</span>
                      </span>
                      <button
                        class="btn btn-ghost revoke-btn"
                        aria-label="Revoke ${c.name}"
                        @click=${() => void this.revoke(c)}
                      >Revoke</button>
                    </li>
                  `,
                )}
              </ul>
            `}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-mcp-clients': GnMcpClients;
  }
}
