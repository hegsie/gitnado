/**
 * MCP write tools settings (roadmap 4.2, issue #610).
 *
 * Off by default. When on, agents connected over MCP may stage, commit,
 * create branches and worktrees, stash and check out — each write is shown
 * to the user for approval unless a saved "always allow" rule covers it.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sharedStyles, buttonStyles } from '../../styles/shared-styles.ts';
import * as mcpService from '../../services/mcp.service.ts';
import type { McpWritePolicy, McpWriteSettings } from '../../services/mcp.service.ts';
import { showToast } from '../../services/notification.service.ts';
import '../common/gn-toggle.ts';

function repoName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

@customElement('gn-mcp-write-settings')
export class GnMcpWriteSettings extends LitElement {
  static styles = [
    sharedStyles,
    buttonStyles,
    css`
      :host {
        display: block;
      }

      .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-md);
        padding: var(--spacing-sm) 0;
      }

      .label {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .name {
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
      }

      .description,
      .empty {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .error {
        font-size: var(--font-size-xs);
        color: var(--color-error);
      }

      .policies {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .policy {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-sm);
        padding: 4px 0;
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      code {
        font-family: var(--font-family-mono);
      }

      .remove-btn {
        padding: 0 8px;
        font-size: var(--font-size-xs);
      }
    `,
  ];

  @state() private settings: McpWriteSettings | null = null;
  @state() private loadError: string | null = null;
  @state() private saving = false;

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  async load(): Promise<void> {
    const result = await mcpService.getMcpWriteSettings();
    if (result.success && result.data) {
      this.settings = result.data;
      this.loadError = null;
    } else {
      this.loadError = result.error?.message ?? 'Could not read the write-tool settings';
    }
  }

  private async save(next: McpWriteSettings, success: string): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    try {
      const result = await mcpService.setMcpWriteSettings(next);
      if (!result.success) {
        showToast(`Failed to save MCP write settings: ${result.error?.message ?? 'Unknown error'}`, 'error');
        return;
      }
      this.settings = next;
      showToast(success, 'success');
    } finally {
      this.saving = false;
    }
  }

  private toggle(enabled: boolean): void {
    if (!this.settings) return;
    void this.save(
      { ...this.settings, enabled },
      enabled
        ? 'Agents can now request changes. Each one asks you first.'
        : 'MCP write tools turned off',
    );
  }

  private removePolicy(policy: McpWritePolicy): void {
    if (!this.settings) return;
    void this.save(
      { ...this.settings, policies: this.settings.policies.filter((p) => p !== policy) },
      'Rule removed — that change will ask again',
    );
  }

  render() {
    if (this.loadError) {
      return html`<div class="error">${this.loadError}</div>`;
    }
    if (!this.settings) return nothing;
    const { enabled, policies } = this.settings;
    return html`
      <div class="row">
        <div class="label">
          <span class="name">Let agents make changes</span>
          <span class="description">
            Adds stage, commit, create branch, create worktree, stash and checkout tools. Every
            change is shown to you for approval first, unless you chose "always allow" for it.
          </span>
        </div>
        <gn-toggle
          class="write-toggle"
          label="Let agents make changes"
          .checked=${enabled}
          ?disabled=${this.saving}
          @change=${(e: CustomEvent<{ checked: boolean }>) => this.toggle(e.detail.checked)}
        ></gn-toggle>
      </div>
      ${enabled
        ? html`
            <div class="label">
              <span class="name">Always-allowed changes</span>
              ${policies.length === 0
                ? html`<span class="empty">None — every change asks you first.</span>`
                : html`
                    <ul class="policies">
                      ${policies.map(
                        (p) => html`
                          <li class="policy">
                            <span>
                              <code>${p.tool}</code> on branches <code>${p.branchPattern}</code> in
                              <span title=${p.repoPath}>${repoName(p.repoPath)}</span>
                            </span>
                            <button
                              class="btn btn-ghost remove-btn"
                              ?disabled=${this.saving}
                              aria-label="Remove rule ${p.tool} ${p.branchPattern}"
                              @click=${() => this.removePolicy(p)}
                            >Remove</button>
                          </li>
                        `,
                      )}
                    </ul>
                  `}
            </div>
          `
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-mcp-write-settings': GnMcpWriteSettings;
  }
}
