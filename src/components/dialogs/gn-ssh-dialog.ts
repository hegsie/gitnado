import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import type { SshKey, SshConfig, SshTestResult } from '../../services/git.service.ts';
import './gn-modal.ts';

type TabId = 'keys' | 'generate' | 'test';

/**
 * SSH Key Management Dialog
 * View, generate, and test SSH keys
 */
@customElement('gn-ssh-dialog')
export class GnSshDialog extends LitElement {
  static styles = [
    sharedStyles,
    css`
      .content {
        padding: var(--spacing-md);
        min-width: 550px;
      }

      .tabs {
        display: flex;
        gap: var(--spacing-xs);
        margin-bottom: var(--spacing-md);
        border-bottom: 1px solid var(--color-border);
        padding-bottom: var(--spacing-xs);
      }

      .tab {
        padding: var(--spacing-xs) var(--spacing-md);
        border: none;
        background: none;
        color: var(--color-text-secondary);
        cursor: pointer;
        font-size: var(--font-size-sm);
        border-radius: var(--radius-sm) var(--radius-sm) 0 0;
        transition: all var(--transition-fast);
      }

      .tab:hover {
        color: var(--color-text-primary);
        background: var(--color-bg-hover);
      }

      .tab.active {
        color: var(--color-primary);
        background: var(--color-bg-tertiary);
        font-weight: var(--font-weight-medium);
      }

      /* Button styles */
      .btn {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: var(--spacing-sm) var(--spacing-md);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-secondary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .btn:hover {
        background: var(--color-bg-hover);
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-primary {
        background: var(--color-primary);
        border-color: var(--color-primary);
        color: white;
      }

      .btn-primary:hover:not(:disabled) {
        background: var(--color-primary-hover);
      }

      .btn-secondary {
        background: var(--color-bg-tertiary);
        border-color: var(--color-border);
        color: var(--color-text-primary);
      }

      .btn-secondary:hover:not(:disabled) {
        background: var(--color-bg-hover);
      }

      .status-banner {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        margin-bottom: var(--spacing-md);
        font-size: var(--font-size-sm);
      }

      .status-banner.error {
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      .status-icon {
        width: 20px;
        height: 20px;
      }

      .status-icon.success {
        color: var(--color-success);
      }

      .key-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        max-height: 350px;
        overflow-y: auto;
      }

      .key-item {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        padding: var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        border: 1px solid var(--color-border);
      }

      .key-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .key-name {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .key-type {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        background: var(--color-bg-secondary);
        padding: 2px 6px;
        border-radius: var(--radius-sm);
      }

      .key-fingerprint {
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .key-comment {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .key-actions {
        display: flex;
        gap: var(--spacing-xs);
      }

      .empty-state {
        text-align: center;
        padding: var(--spacing-xl);
        color: var(--color-text-muted);
      }

      .form-group {
        margin-bottom: var(--spacing-md);
      }

      .form-group label {
        display: block;
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        margin-bottom: var(--spacing-xs);
        color: var(--color-text-secondary);
      }

      .form-group input,
      .form-group select {
        width: 100%;
        padding: var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
      }

      .form-group input:focus,
      .form-group select:focus {
        outline: none;
        border-color: var(--color-primary);
      }

      .form-group .hint {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        margin-top: var(--spacing-xs);
      }

      .form-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--spacing-sm);
        margin-top: var(--spacing-lg);
      }

      .test-result {
        padding: var(--spacing-md);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        border: 1px solid var(--color-border);
        margin-top: var(--spacing-md);
      }

      .test-result.success {
        border-color: var(--color-success);
        background: rgba(46, 160, 67, 0.1);
      }

      .test-result.error {
        border-color: var(--color-error);
        background: var(--color-error-bg);
      }

      .test-result-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        margin-bottom: var(--spacing-sm);
        font-weight: var(--font-weight-medium);
      }

      .test-result-header.success {
        color: var(--color-success);
      }

      .test-result-header.error {
        color: var(--color-error);
      }

      .test-result-message {
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        white-space: pre-wrap;
        word-break: break-all;
      }

      .public-key-display {
        margin-top: var(--spacing-sm);
        padding: var(--spacing-sm);
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
        white-space: pre-wrap;
        word-break: break-all;
        max-height: 100px;
        overflow-y: auto;
      }

      .quick-hosts {
        display: flex;
        gap: var(--spacing-xs);
        margin-bottom: var(--spacing-md);
      }

      .quick-host-btn {
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-tertiary);
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .quick-host-btn:hover {
        border-color: var(--color-primary);
        color: var(--color-primary);
      }

      .loading-indicator {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-lg);
        color: var(--color-text-muted);
      }

      .copy-success {
        color: var(--color-success);
        font-size: var(--font-size-xs);
        margin-left: var(--spacing-xs);
      }

      .btn-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .btn-icon:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .btn-icon.danger:hover {
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      .btn-icon svg {
        width: 16px;
        height: 16px;
      }
    `,
  ];

  @property({ type: Boolean }) open = false;

  @state() private activeTab: TabId = 'keys';
  @state() private loading = false;
  @state() private config: SshConfig | null = null;
  @state() private keys: SshKey[] = [];
  @state() private error: string | null = null;

  // Generate form state
  @state() private generateKeyType = 'ed25519';
  @state() private generateEmail = '';
  @state() private generateFilename = '';
  @state() private generatePassphrase = '';
  @state() private generating = false;
  @state() private generatedKey: SshKey | null = null;

  // Test connection state
  @state() private testHost = '';
  @state() private testing = false;
  @state() private testResult: SshTestResult | null = null;

  // Copy state
  @state() private copiedKey: string | null = null;

  async connectedCallback(): Promise<void> {
    super.connectedCallback();
  }

  updated(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has('open') && this.open) {
      this.loadData();
    }
  }

  private async loadData(): Promise<void> {
    this.loading = true;
    this.error = null;

    try {
      const [configResult, keysResult] = await Promise.all([
        gitService.getSshConfig(),
        gitService.getSshKeys(),
      ]);

      if (configResult.success && configResult.data) {
        this.config = configResult.data;
      }

      if (keysResult.success && keysResult.data) {
        this.keys = keysResult.data;
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to load SSH data';
    } finally {
      this.loading = false;
    }
  }

  private handleClose(): void {
    this.dispatchEvent(new CustomEvent('close'));
    // Reset state
    this.generatedKey = null;
    this.testResult = null;
    this.activeTab = 'keys';
  }

  private async handleGenerateKey(): Promise<void> {
    if (!this.generateEmail) return;

    this.generating = true;
    this.error = null;

    try {
      const result = await gitService.generateSshKey(
        this.generateKeyType,
        this.generateEmail,
        this.generateFilename || undefined,
        this.generatePassphrase || undefined
      );

      if (result.success && result.data) {
        this.generatedKey = result.data;
        await this.loadData(); // Refresh key list
      } else {
        this.error = result.error?.message || 'Failed to generate key';
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to generate key';
    } finally {
      this.generating = false;
    }
  }

  private async handleTestConnection(): Promise<void> {
    if (!this.testHost) return;

    this.testing = true;
    this.error = null;
    this.testResult = null;

    try {
      const result = await gitService.testSshConnection(this.testHost);

      if (result.success && result.data) {
        this.testResult = result.data;
      } else {
        this.error = result.error?.message || 'Failed to test connection';
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to test connection';
    } finally {
      this.testing = false;
    }
  }

  private async handleCopyPublicKey(key: SshKey): Promise<void> {
    if (key.publicKey) {
      try {
        await navigator.clipboard.writeText(key.publicKey);
        this.copiedKey = key.name;
        setTimeout(() => {
          this.copiedKey = null;
        }, 2000);
      } catch {
        this.error = 'Failed to copy to clipboard';
      }
    }
  }

  private async handleDeleteKey(key: SshKey): Promise<void> {
    const confirmed = await showConfirm(
      'Delete SSH Key',
      `Are you sure you want to delete the SSH key "${key.name}"?\n\nThis will delete both the private and public key files.`,
      'warning'
    );

    if (!confirmed) return;

    try {
      const result = await gitService.deleteSshKey(key.name);

      if (result.success) {
        await this.loadData();
      } else {
        this.error = result.error?.message || 'Failed to delete key';
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to delete key';
    }
  }

  private setQuickHost(host: string): void {
    this.testHost = host;
  }

  private renderKeysTab() {
    if (this.loading) {
      return html`<div class="loading-indicator">Loading SSH keys...</div>`;
    }

    if (this.keys.length === 0) {
      return html`
        <div class="empty-state">
          <p>No SSH keys found in ${this.config?.sshDir || '~/.ssh'}</p>
          <p style="margin-top: var(--spacing-sm)">
            <button class="btn btn-primary" @click=${() => (this.activeTab = 'generate')}>
              Generate New Key
            </button>
          </p>
        </div>
      `;
    }

    return html`
      <div class="key-list">
        ${this.keys.map(
          (key) => html`
            <div class="key-item">
              <div class="key-header">
                <span class="key-name">
                  ${key.name}
                  <span class="key-type">${key.keyType}</span>
                </span>
                <div class="key-actions">
                  <button
                    class="btn-icon"
                    title="Copy public key"
                    @click=${() => this.handleCopyPublicKey(key)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                  </button>
                  ${this.copiedKey === key.name
                    ? html`<span class="copy-success">Copied!</span>`
                    : ''}
                  <button
                    class="btn-icon danger"
                    title="Delete key"
                    @click=${() => this.handleDeleteKey(key)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="3 6 5 6 21 6"></polyline>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                  </button>
                </div>
              </div>
              ${key.fingerprint
                ? html`<span class="key-fingerprint">${key.fingerprint}</span>`
                : ''}
              ${key.comment ? html`<span class="key-comment">${key.comment}</span>` : ''}
              ${key.publicKey
                ? html`<div class="public-key-display">${key.publicKey}</div>`
                : ''}
            </div>
          `
        )}
      </div>
    `;
  }

  private renderGenerateTab() {
    if (this.generatedKey) {
      return html`
        <div class="test-result success">
          <div class="test-result-header success">
            <svg class="status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
              <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
            SSH Key Generated Successfully
          </div>
          <p style="margin-bottom: var(--spacing-sm)">
            Your new ${this.generatedKey.keyType} key has been created at:
          </p>
          <code style="display: block; margin-bottom: var(--spacing-sm)">
            ${this.generatedKey.path}
          </code>
          <p style="margin-bottom: var(--spacing-sm)">Public key:</p>
          <div class="public-key-display">${this.generatedKey.publicKey}</div>
          <div class="form-actions">
            <button
              class="btn btn-secondary"
              @click=${() => this.handleCopyPublicKey(this.generatedKey!)}
            >
              Copy Public Key
            </button>
            <button
              class="btn btn-primary"
              @click=${() => {
                this.generatedKey = null;
                this.generateEmail = '';
                this.generateFilename = '';
                this.generatePassphrase = '';
              }}
            >
              Generate Another
            </button>
          </div>
        </div>
      `;
    }

    return html`
      <div class="form-group">
        <label>Key Type</label>
        <select
          .value=${this.generateKeyType}
          @change=${(e: Event) =>
            (this.generateKeyType = (e.target as HTMLSelectElement).value)}
        >
          <option value="ed25519">Ed25519 (Recommended)</option>
          <option value="rsa">RSA (4096 bits)</option>
          <option value="ecdsa">ECDSA</option>
        </select>
        <div class="hint">Ed25519 is recommended for most users</div>
      </div>

      <div class="form-group">
        <label>Email</label>
        <input
          type="email"
          placeholder="you@example.com"
          .value=${this.generateEmail}
          @input=${(e: Event) => (this.generateEmail = (e.target as HTMLInputElement).value)}
        />
        <div class="hint">Used as a comment to identify the key</div>
      </div>

      <div class="form-group">
        <label>Filename (optional)</label>
        <input
          type="text"
          placeholder="id_ed25519"
          .value=${this.generateFilename}
          @input=${(e: Event) => (this.generateFilename = (e.target as HTMLInputElement).value)}
        />
        <div class="hint">Leave empty for default name based on key type</div>
      </div>

      <div class="form-group">
        <label>Passphrase (optional)</label>
        <input
          type="password"
          placeholder="Leave empty for no passphrase"
          .value=${this.generatePassphrase}
          @input=${(e: Event) =>
            (this.generatePassphrase = (e.target as HTMLInputElement).value)}
        />
        <div class="hint">A passphrase adds extra security but requires entry on each use</div>
      </div>

      <div class="form-actions">
        <button
          class="btn btn-primary"
          ?disabled=${!this.generateEmail || this.generating}
          @click=${this.handleGenerateKey}
        >
          ${this.generating ? 'Generating...' : 'Generate Key'}
        </button>
      </div>
    `;
  }

  private renderTestTab() {
    return html`
      <div class="quick-hosts">
        <button class="quick-host-btn" @click=${() => this.setQuickHost('github.com')}>
          GitHub
        </button>
        <button class="quick-host-btn" @click=${() => this.setQuickHost('gitlab.com')}>
          GitLab
        </button>
        <button class="quick-host-btn" @click=${() => this.setQuickHost('bitbucket.org')}>
          Bitbucket
        </button>
      </div>

      <div class="form-group">
        <label>Host</label>
        <input
          type="text"
          placeholder="github.com"
          .value=${this.testHost}
          @input=${(e: Event) => (this.testHost = (e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.handleTestConnection()}
        />
        <div class="hint">Enter a hostname to test SSH connection</div>
      </div>

      <div class="form-actions">
        <button
          class="btn btn-primary"
          ?disabled=${!this.testHost || this.testing}
          @click=${this.handleTestConnection}
        >
          ${this.testing ? 'Testing...' : 'Test Connection'}
        </button>
      </div>

      ${this.testResult
        ? html`
            <div class="test-result ${this.testResult.success ? 'success' : 'error'}">
              <div class="test-result-header ${this.testResult.success ? 'success' : 'error'}">
                ${this.testResult.success
                  ? html`
                      <svg class="status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                        <polyline points="22 4 12 14.01 9 11.01"></polyline>
                      </svg>
                      Connection Successful
                      ${this.testResult.username
                        ? html` (as ${this.testResult.username})`
                        : ''}
                    `
                  : html`
                      <svg class="status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="15" y1="9" x2="9" y2="15"></line>
                        <line x1="9" y1="9" x2="15" y2="15"></line>
                      </svg>
                      Connection Failed
                    `}
              </div>
              <div class="test-result-message">${this.testResult.message}</div>
            </div>
          `
        : ''}
    `;
  }

  render() {
    if (!this.open) return null;

    return html`
      <gn-modal modalTitle="SSH Key Management" open @close=${this.handleClose}>
        <div class="content">
          ${this.config && !this.config.sshAvailable
            ? html`
                <div class="status-banner error">
                  <svg class="status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="12"></line>
                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                  </svg>
                  SSH is not available on this system
                </div>
              `
            : this.config
              ? html`
                  <div class="status-banner">
                    <svg class="status-icon success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                      <polyline points="22 4 12 14.01 9 11.01"></polyline>
                    </svg>
                    <span>${this.config.sshVersion || 'SSH available'}</span>
                  </div>
                `
              : ''}

          ${this.error
            ? html`
                <div class="status-banner error">
                  <svg class="status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="15" y1="9" x2="9" y2="15"></line>
                    <line x1="9" y1="9" x2="15" y2="15"></line>
                  </svg>
                  ${this.error}
                </div>
              `
            : ''}

          <div class="tabs">
            <button
              class="tab ${this.activeTab === 'keys' ? 'active' : ''}"
              @click=${() => (this.activeTab = 'keys')}
            >
              SSH Keys
            </button>
            <button
              class="tab ${this.activeTab === 'generate' ? 'active' : ''}"
              @click=${() => (this.activeTab = 'generate')}
            >
              Generate Key
            </button>
            <button
              class="tab ${this.activeTab === 'test' ? 'active' : ''}"
              @click=${() => (this.activeTab = 'test')}
            >
              Test Connection
            </button>
          </div>

          ${this.activeTab === 'keys'
            ? this.renderKeysTab()
            : this.activeTab === 'generate'
              ? this.renderGenerateTab()
              : this.renderTestTab()}
        </div>
      </gn-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-ssh-dialog': GnSshDialog;
  }
}
