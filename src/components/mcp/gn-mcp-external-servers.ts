/**
 * External MCP servers for AI context (roadmap 4.2, issue #613).
 *
 * Gitnado's AI features (commit messages, PR descriptions) can ask MCP servers
 * you add here — an issue tracker, your docs — for context. Each server is
 * reached over HTTP or by running a local command. A server only contributes
 * once you pick its context tool; "Preview" shows exactly what would be added
 * to a prompt for the open repository.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sharedStyles, buttonStyles } from '../../styles/shared-styles.ts';
import * as mcpService from '../../services/mcp.service.ts';
import type { ExternalMcpServer, ExternalMcpTool } from '../../services/mcp.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import { repositoryStore } from '../../stores/repository.store.ts';

interface Draft {
  id: string;
  name: string;
  kind: 'http' | 'stdio';
  url: string;
  command: string;
  args: string;
  token: string;
  clearToken: boolean;
  hasToken: boolean;
  enabled: boolean;
  contextTool: string;
  contextArgs: string;
}

const EMPTY_DRAFT: Draft = {
  id: '',
  name: '',
  kind: 'http',
  url: '',
  command: '',
  args: '',
  token: '',
  clearToken: false,
  hasToken: false,
  enabled: true,
  contextTool: '',
  contextArgs: '',
};

function toDraft(s: ExternalMcpServer): Draft {
  return {
    ...EMPTY_DRAFT,
    id: s.id,
    name: s.name,
    kind: s.transport.type,
    url: s.transport.type === 'http' ? s.transport.url : '',
    command: s.transport.type === 'stdio' ? s.transport.command : '',
    args: s.transport.type === 'stdio' ? s.transport.args.join(' ') : '',
    hasToken: s.hasToken,
    enabled: s.enabled,
    contextTool: s.contextTool ?? '',
    contextArgs: s.contextArgs ?? '',
  };
}

function fromDraft(d: Draft): ExternalMcpServer {
  return {
    id: d.id,
    name: d.name.trim(),
    transport:
      d.kind === 'http'
        ? { type: 'http', url: d.url.trim() }
        : { type: 'stdio', command: d.command.trim(), args: d.args.split(/\s+/).filter(Boolean) },
    enabled: d.enabled,
    contextTool: d.contextTool.trim() || null,
    contextArgs: d.contextArgs.trim() || null,
    hasToken: d.hasToken,
  };
}

function describe(s: ExternalMcpServer): string {
  return s.transport.type === 'http' ? s.transport.url : [s.transport.command, ...s.transport.args].join(' ');
}

@customElement('gn-mcp-external-servers')
export class GnMcpExternalServers extends LitElement {
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
      .meta,
      .empty {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }
      .error {
        font-size: var(--font-size-xs);
        color: var(--color-error);
      }
      .servers {
        list-style: none;
        margin: var(--spacing-sm) 0;
        padding: 0;
      }
      .server {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: var(--spacing-xs) 0;
        border-bottom: 1px solid var(--color-border);
      }
      .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-sm);
      }
      .actions {
        display: flex;
        gap: 4px;
        flex-shrink: 0;
      }
      .btn {
        padding: 2px 10px;
        font-size: var(--font-size-xs);
      }
      form {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }
      label.inline {
        flex-direction: row;
        align-items: center;
        gap: var(--spacing-xs);
      }
      input,
      select,
      textarea {
        padding: 2px 8px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
      }
      textarea {
        font-family: var(--font-family-mono);
        min-height: 48px;
      }
      pre {
        margin: 0;
        padding: var(--spacing-sm);
        max-height: 140px;
        overflow: auto;
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-xs);
        white-space: pre-wrap;
      }
      .tools {
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }
    `,
  ];

  @state() private servers: ExternalMcpServer[] = [];
  @state() private loadError: string | null = null;
  @state() private draft: Draft | null = null;
  @state() private formError: string | null = null;
  @state() private busy = false;
  @state() private tools = new Map<string, ExternalMcpTool[]>();
  @state() private preview = new Map<string, string>();

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  async load(): Promise<void> {
    const result = await mcpService.listExternalMcpServers();
    if (result.success && result.data) {
      this.servers = result.data;
      this.loadError = null;
    } else {
      this.loadError = result.error?.message ?? 'Could not load MCP servers';
    }
  }

  private edit(server?: ExternalMcpServer): void {
    this.draft = server ? toDraft(server) : { ...EMPTY_DRAFT };
    this.formError = null;
  }

  private set<K extends keyof Draft>(key: K, value: Draft[K]): void {
    if (this.draft) this.draft = { ...this.draft, [key]: value };
  }

  private async save(e: Event): Promise<void> {
    e.preventDefault();
    if (!this.draft || this.busy) return;
    this.busy = true;
    this.formError = null;
    try {
      const d = this.draft;
      const result = await mcpService.saveExternalMcpServer(
        fromDraft(d),
        d.token.trim() || undefined,
        d.clearToken || undefined,
      );
      if (!result.success || !result.data) {
        this.formError = result.error?.message ?? 'Could not save the server';
        return;
      }
      showToast(`Saved ${result.data.name}`, 'success');
      this.draft = null;
      await this.load();
    } finally {
      this.busy = false;
    }
  }

  private async removeServer(server: ExternalMcpServer): Promise<void> {
    const ok = await showConfirm('Remove MCP server', `Remove "${server.name}"? Its saved token is deleted too.`, 'warning');
    if (!ok) return;
    const result = await mcpService.removeExternalMcpServer(server.id);
    if (!result.success) {
      showToast(`Failed to remove: ${result.error?.message ?? 'Unknown error'}`, 'error');
      return;
    }
    showToast(`Removed ${server.name}`, 'success');
    await this.load();
  }

  private async test(server: ExternalMcpServer): Promise<void> {
    const result = await mcpService.listExternalMcpTools(server);
    if (!result.success || !result.data) {
      showToast(`${server.name}: ${result.error?.message ?? 'Connection failed'}`, 'error');
      return;
    }
    const next = new Map(this.tools);
    next.set(server.id, result.data);
    this.tools = next;
    showToast(`${server.name} is reachable: ${result.data.length} tool${result.data.length === 1 ? '' : 's'}`, 'success');
  }

  private async showPreview(server: ExternalMcpServer): Promise<void> {
    const repo = repositoryStore.getState();
    const repoPath = repo.openRepositories[repo.activeIndex]?.repository.path;
    if (!repoPath) {
      showToast('Open a repository to preview its context', 'info');
      return;
    }
    const result = await mcpService.previewExternalMcpContext(server, repoPath);
    if (!result.success) {
      showToast(`${server.name}: ${result.error?.message ?? 'Preview failed'}`, 'error');
      return;
    }
    const next = new Map(this.preview);
    next.set(server.id, result.data?.text || '(The tool returned nothing.)');
    this.preview = next;
  }

  private renderForm() {
    const d = this.draft;
    if (!d) return nothing;
    const knownTools = d.id ? this.tools.get(d.id) : undefined;
    return html`
      <form @submit=${(e: Event) => void this.save(e)}>
        <label>Name
          <input class="name-input" .value=${d.name} @input=${(e: Event) => this.set('name', (e.target as HTMLInputElement).value)} />
        </label>
        <label>Connect by
          <select class="kind-select" .value=${d.kind} @change=${(e: Event) => this.set('kind', (e.target as HTMLSelectElement).value as Draft['kind'])}>
            <option value="http" ?selected=${d.kind === 'http'}>URL (HTTP)</option>
            <option value="stdio" ?selected=${d.kind === 'stdio'}>Command (stdio)</option>
          </select>
        </label>
        ${d.kind === 'http'
          ? html`
              <label>Server URL
                <input class="url-input" placeholder="https://mcp.example.com/mcp" .value=${d.url} @input=${(e: Event) => this.set('url', (e.target as HTMLInputElement).value)} />
              </label>
              <label>Bearer token (stored in your system keyring)
                <input class="token-input" type="password" placeholder=${d.hasToken ? 'A token is saved — leave blank to keep it' : 'Optional'} .value=${d.token} @input=${(e: Event) => this.set('token', (e.target as HTMLInputElement).value)} />
              </label>
              ${d.hasToken
                ? html`<label class="inline"><input type="checkbox" class="clear-token" .checked=${d.clearToken} @change=${(e: Event) => this.set('clearToken', (e.target as HTMLInputElement).checked)} />Remove the saved token</label>`
                : nothing}
            `
          : html`
              <label>Command
                <input class="command-input" placeholder="npx" .value=${d.command} @input=${(e: Event) => this.set('command', (e.target as HTMLInputElement).value)} />
              </label>
              <label>Arguments
                <input class="args-input" placeholder="-y @acme/mcp-server" .value=${d.args} @input=${(e: Event) => this.set('args', (e.target as HTMLInputElement).value)} />
              </label>
            `}
        <label>Context tool (leave empty to not use this server for AI context)
          <input class="tool-input" list="known-tools" .value=${d.contextTool} @input=${(e: Event) => this.set('contextTool', (e.target as HTMLInputElement).value)} />
          ${knownTools ? html`<datalist id="known-tools">${knownTools.map((t) => html`<option value=${t.name}>${t.description}</option>`)}</datalist>` : nothing}
        </label>
        <label>Context tool arguments (JSON; placeholders {branch} {issueKey} {issueNumber} {repo})
          <textarea class="args-template" placeholder='{"key": "{issueKey}"}' .value=${d.contextArgs} @input=${(e: Event) => this.set('contextArgs', (e.target as HTMLTextAreaElement).value)}></textarea>
        </label>
        <label class="inline"><input type="checkbox" class="enabled-check" .checked=${d.enabled} @change=${(e: Event) => this.set('enabled', (e.target as HTMLInputElement).checked)} />Enabled</label>
        ${this.formError ? html`<div class="error" role="alert">${this.formError}</div>` : nothing}
        <div class="row">
          <span></span>
          <span class="actions">
            <button type="button" class="btn btn-secondary cancel-btn" @click=${() => (this.draft = null)}>Cancel</button>
            <button type="submit" class="btn btn-primary save-btn" ?disabled=${this.busy}>Save</button>
          </span>
        </div>
      </form>
    `;
  }

  render() {
    return html`
      <div class="row">
        <div>
          <div class="name">MCP servers for AI context</div>
          <div class="description">
            Let commit messages and PR descriptions draw on an issue tracker or docs server, e.g.
            look up the issue named in the branch. Nothing is sent until you add a server and pick
            its context tool.
          </div>
        </div>
        ${this.draft ? nothing : html`<button class="btn btn-secondary add-server-btn" @click=${() => this.edit()}>Add Server</button>`}
      </div>
      ${this.renderForm()}
      ${this.loadError
        ? html`<div class="error">${this.loadError}</div>`
        : this.servers.length === 0
          ? html`<div class="empty">No servers added.</div>`
          : html`
              <ul class="servers">
                ${this.servers.map((s) => {
                  const tools = this.tools.get(s.id);
                  const preview = this.preview.get(s.id);
                  return html`
                    <li class="server" data-id=${s.id}>
                      <div class="row">
                        <span>
                          <span class="name">${s.name}</span>
                          <span class="meta"> · ${describe(s)}${s.enabled ? '' : ' · disabled'}</span>
                        </span>
                        <span class="actions">
                          <button class="btn btn-ghost test-btn" @click=${() => void this.test(s)}>Test</button>
                          ${s.contextTool
                            ? html`<button class="btn btn-ghost preview-btn" @click=${() => void this.showPreview(s)}>Preview</button>`
                            : nothing}
                          <button class="btn btn-ghost edit-btn" @click=${() => this.edit(s)}>Edit</button>
                          <button class="btn btn-ghost remove-btn" aria-label="Remove ${s.name}" @click=${() => void this.removeServer(s)}>Remove</button>
                        </span>
                      </div>
                      <span class="meta">
                        ${s.contextTool ? html`AI context from <code>${s.contextTool}</code>` : 'Not used for AI context'}
                      </span>
                      ${tools
                        ? html`<div class="tools">Tools: ${tools.map((t) => t.name).join(', ') || 'none'}</div>`
                        : nothing}
                      ${preview !== undefined ? html`<pre class="preview">${preview}</pre>` : nothing}
                    </li>
                  `;
                })}
              </ul>
            `}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-mcp-external-servers': GnMcpExternalServers;
  }
}
