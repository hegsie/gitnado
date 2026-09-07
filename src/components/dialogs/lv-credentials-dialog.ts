import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import type {
  CredentialHelper,
  AvailableHelper,
  CredentialTestResult,
} from '../../services/git.service.ts';
import type { Remote } from '../../types/git.types.ts';
import './lv-modal.ts';

type TabId = 'helpers' | 'test';

/**
 * Credential Management Dialog
 * Manage git credential helpers and test credentials
 */
@customElement('lv-credentials-dialog')
export class LvCredentialsDialog extends LitElement {
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

      .error-banner {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm);
        background: var(--color-error-bg);
        color: var(--color-error);
        border-radius: var(--radius-md);
        margin-bottom: var(--spacing-md);
        font-size: var(--font-size-sm);
      }

      .helper-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        margin-bottom: var(--spacing-md);
      }

      .helper-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        border: 1px solid var(--color-border);
      }

      .helper-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .helper-name {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .helper-command {
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .scope-badge {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        background: var(--color-bg-secondary);
        padding: 2px 6px;
        border-radius: var(--radius-sm);
      }

      .add-helper-form {
        padding: var(--spacing-md);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        border: 1px solid var(--color-border);
      }

      .add-helper-form h4 {
        margin: 0 0 var(--spacing-md) 0;
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
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

      .form-group select,
      .form-group input {
        width: 100%;
        padding: var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
      }

      .form-group select:focus,
      .form-group input:focus {
        outline: none;
        border-color: var(--color-primary);
      }

      .form-group .hint {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        margin-top: var(--spacing-xs);
      }

      .scope-toggle {
        display: flex;
        gap: var(--spacing-sm);
        margin-bottom: var(--spacing-md);
      }

      .scope-btn {
        flex: 1;
        padding: var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-tertiary);
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .scope-btn:hover {
        border-color: var(--color-primary);
      }

      .scope-btn.active {
        border-color: var(--color-primary);
        background: var(--color-primary-bg);
        color: var(--color-primary);
      }

      .form-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--spacing-sm);
        margin-top: var(--spacing-md);
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

      .btn-icon:hover:not(:disabled) {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .btn-icon:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-icon.danger:hover:not(:disabled) {
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      .btn-icon svg {
        width: 16px;
        height: 16px;
      }

      .empty-state {
        text-align: center;
        padding: var(--spacing-xl);
        color: var(--color-text-muted);
      }

      .loading-indicator {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-lg);
        color: var(--color-text-muted);
      }

      .remote-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        margin-bottom: var(--spacing-md);
      }

      .remote-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        border: 1px solid var(--color-border);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .remote-item:hover {
        border-color: var(--color-primary);
      }

      .remote-item.selected {
        border-color: var(--color-primary);
        background: var(--color-primary-bg);
      }

      .remote-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        flex: 1;
      }

      .remote-name {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
      }

      .remote-url {
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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

      .test-result-details {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .test-result-message {
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        margin-top: var(--spacing-sm);
        white-space: pre-wrap;
        word-break: break-all;
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: String }) repositoryPath = '';

  @state() private activeTab: TabId = 'helpers';
  @state() private loading = false;
  @state() private error: string | null = null;

  // Helpers state
  @state() private helpers: CredentialHelper[] = [];
  @state() private availableHelpers: AvailableHelper[] = [];
  @state() private newHelper = '';
  @state() private newHelperScope: 'global' | 'local' = 'global';

  // Test state
  @state() private remotes: Remote[] = [];
  @state() private selectedRemote: Remote | null = null;
  @state() private testing = false;
  @state() private testResult: CredentialTestResult | null = null;

  // GCM status
  @state() private gcmStatus: import('../../services/credential.service.ts').CredentialManagerStatus | null = null;

  async connectedCallback(): Promise<void> {
    super.connectedCallback();
  }

  /**
   * Repo captured when the dialog opened. `repositoryPath` is live-bound to
   * the ACTIVE repository and rebinds the instant the user Ctrl+Tabs — a
   * document-level shortcut this dialog's overlay does not block — while the
   * data on screen still belongs to the repo that was active at open. Every
   * read and every mutation must use THIS value, or the dialog acts on a
   * repository the user is not looking at.
   */
  private pinnedRepoPath = '';

  /** The repo this dialog is pinned to while open, or null when closed. */
  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.open ? this.pinnedRepoPath : null;
  }

  /**
   * True while a credential test round-trip is in flight against the pinned
   * repo's remote. The host's tab-close sweep must not claim otherwise.
   */
  public get operationInFlight(): boolean {
    return this.testing;
  }

  updated(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has('open') && this.open) {
      this.pinnedRepoPath = this.repositoryPath;
      this.loadData();
    }
  }

  private async loadData(): Promise<void> {
    this.loading = true;
    this.error = null;

    try {
      const [helpersResult, availableResult, remotesResult] = await Promise.all([
        gitService.getCredentialHelpers(this.pinnedRepoPath),
        gitService.getAvailableHelpers(),
        gitService.getRemotes(this.pinnedRepoPath),
      ]);

      if (helpersResult.success && helpersResult.data) {
        this.helpers = helpersResult.data;
      }

      if (availableResult.success && availableResult.data) {
        this.availableHelpers = availableResult.data;
      }

      if (remotesResult.success && remotesResult.data) {
        this.remotes = remotesResult.data;
        if (this.remotes.length > 0 && !this.selectedRemote) {
          this.selectedRemote = this.remotes[0];
        }
      }

      // Detect GCM status
      try {
        const { detectCredentialManager } = await import('../../services/credential.service.ts');
        this.gcmStatus = await detectCredentialManager(this.pinnedRepoPath);
      } catch {
        // GCM detection is best-effort
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to load data';
    } finally {
      this.loading = false;
    }
  }

  private handleClose(): void {
    this.dispatchEvent(new CustomEvent('close'));
  }

  private async handleAddHelper(): Promise<void> {
    if (!this.newHelper) return;

    this.error = null;

    try {
      const result = await gitService.setCredentialHelper(
        this.newHelperScope === 'local' ? this.pinnedRepoPath : null,
        this.newHelper,
        this.newHelperScope === 'global'
      );

      if (result.success) {
        this.newHelper = '';
        await this.loadData();
      } else {
        this.error = result.error?.message || 'Failed to set helper';
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to set helper';
    }
  }

  /**
   * Where a helper's removal has to be aimed. A URL-scoped helper can be
   * written in any config file, so `configScope` — the file git reported —
   * decides, not the "url" badge. Null means a file this dialog cannot edit
   * (system/worktree), where `--local`/`--global` would silently miss.
   */
  private removalTarget(helper: CredentialHelper): { path: string | null; global: boolean } | null {
    if (helper.configScope === 'global') return { path: null, global: true };
    if (helper.configScope === 'local') return { path: this.pinnedRepoPath, global: false };
    return null;
  }

  private async handleRemoveHelper(helper: CredentialHelper): Promise<void> {
    const target = this.removalTarget(helper);
    if (!target) {
      this.error = `"${helper.name}" is configured in the ${helper.configScope} git config, which this dialog cannot change.`;
      return;
    }

    const confirmed = await showConfirm('Remove Helper', `Remove credential helper "${helper.name}"?`, 'warning');
    if (!confirmed) return;

    this.error = null;

    try {
      const result = await gitService.unsetCredentialHelper(
        target.path,
        target.global,
        helper.urlPattern ?? undefined
      );

      if (result.success) {
        await this.loadData();
      } else {
        this.error = result.error?.message || 'Failed to remove helper';
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to remove helper';
    }
  }

  private async handleTestCredentials(): Promise<void> {
    if (!this.selectedRemote) return;

    this.testing = true;
    this.error = null;
    this.testResult = null;

    try {
      const result = await gitService.testCredentials(
        this.pinnedRepoPath,
        this.selectedRemote.url
      );

      if (result.success && result.data) {
        this.testResult = result.data;
      } else {
        this.error = result.error?.message || 'Failed to test credentials';
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to test credentials';
    } finally {
      this.testing = false;
    }
  }

  private async handleEraseCredentials(): Promise<void> {
    if (!this.testResult) return;

    const confirmed = await showConfirm(
      'Erase Credentials',
      `Erase stored credentials for ${this.testResult.host}?\n\nYou will need to re-authenticate on your next push/pull.`,
      'warning'
    );
    if (!confirmed) return;

    this.error = null;

    try {
      const result = await gitService.eraseCredentials(
        this.pinnedRepoPath,
        this.testResult.host,
        this.testResult.protocol
      );

      if (result.success) {
        this.testResult = null;
        await this.handleTestCredentials();
      } else {
        this.error = result.error?.message || 'Failed to erase credentials';
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to erase credentials';
    }
  }

  private renderHelpersTab() {
    if (this.loading) {
      return html`<div class="loading-indicator">Loading...</div>`;
    }

    return html`
      ${this.helpers.length > 0
        ? html`
            <div class="helper-list">
              ${this.helpers.map(
                (helper) => html`
                  <div class="helper-item">
                    <div class="helper-info">
                      <span class="helper-name">
                        ${helper.name}
                        <span class="scope-badge">${helper.scope}</span>
                        ${helper.scope === 'url'
                          ? html`<span class="scope-badge">${helper.configScope}</span>`
                          : ''}
                        ${helper.urlPattern
                          ? html`<span class="scope-badge">${helper.urlPattern}</span>`
                          : ''}
                      </span>
                      <span class="helper-command">${helper.command}</span>
                    </div>
                    <button
                      class="btn-icon danger"
                      ?disabled=${this.removalTarget(helper) === null}
                      title=${this.removalTarget(helper) === null
                        ? `Configured in the ${helper.configScope} git config — remove it there`
                        : 'Remove helper'}
                      @click=${() => this.handleRemoveHelper(helper)}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                      </svg>
                    </button>
                  </div>
                `
              )}
            </div>
          `
        : html`
            <div class="empty-state" style="padding: var(--spacing-md)">
              <p>No credential helpers configured</p>
            </div>
          `}

      <div class="add-helper-form">
        <h4>Configure Credential Helper</h4>
        <div class="scope-toggle">
          <button
            class="scope-btn ${this.newHelperScope === 'global' ? 'active' : ''}"
            @click=${() => (this.newHelperScope = 'global')}
          >
            Global
          </button>
          <button
            class="scope-btn ${this.newHelperScope === 'local' ? 'active' : ''}"
            @click=${() => (this.newHelperScope = 'local')}
          >
            Repository
          </button>
        </div>

        <div class="form-group">
          <label>Helper</label>
          <select
            .value=${this.newHelper}
            @change=${(e: Event) => (this.newHelper = (e.target as HTMLSelectElement).value)}
          >
            <option value="">Select a helper...</option>
            ${this.availableHelpers
              .filter((h) => h.available)
              .map(
                (h) => html`
                  <option value=${h.name}>${h.name} - ${h.description}</option>
                `
              )}
          </select>
          <div class="hint">
            Credential helpers securely store your Git passwords and tokens
          </div>
        </div>

        <div class="form-actions">
          <button
            class="btn btn-primary"
            ?disabled=${!this.newHelper}
            @click=${this.handleAddHelper}
          >
            Set Helper
          </button>
        </div>
      </div>
    `;
  }

  private renderTestTab() {
    if (this.loading) {
      return html`<div class="loading-indicator">Loading...</div>`;
    }

    if (this.remotes.length === 0) {
      return html`
        <div class="empty-state">
          <p>No remotes configured</p>
          <p style="font-size: var(--font-size-xs); margin-top: var(--spacing-sm)">
            Add a remote to test credentials
          </p>
        </div>
      `;
    }

    return html`
      <div class="form-group">
        <label>Select Remote</label>
      </div>
      <div class="remote-list">
        ${this.remotes.map(
          (remote) => html`
            <div
              class="remote-item ${this.selectedRemote?.name === remote.name ? 'selected' : ''}"
              @click=${() => {
                this.selectedRemote = remote;
                this.testResult = null;
              }}
            >
              <div class="remote-info">
                <span class="remote-name">${remote.name}</span>
                <span class="remote-url">${remote.url}</span>
              </div>
            </div>
          `
        )}
      </div>

      <div class="form-actions">
        <button
          class="btn btn-primary"
          ?disabled=${!this.selectedRemote || this.testing}
          @click=${this.handleTestCredentials}
        >
          ${this.testing ? 'Testing...' : 'Test Credentials'}
        </button>
      </div>

      ${this.testResult
        ? html`
            <div class="test-result ${this.testResult.success ? 'success' : 'error'}">
              <div class="test-result-header ${this.testResult.success ? 'success' : 'error'}">
                ${this.testResult.success
                  ? html`
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                        <polyline points="22 4 12 14.01 9 11.01"></polyline>
                      </svg>
                      Credentials Working
                    `
                  : html`
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="15" y1="9" x2="9" y2="15"></line>
                        <line x1="9" y1="9" x2="15" y2="15"></line>
                      </svg>
                      No Credentials Found
                    `}
              </div>
              <div class="test-result-details">
                <div>Host: ${this.testResult.host}</div>
                <div>Protocol: ${this.testResult.protocol}</div>
                ${this.testResult.username
                  ? html`<div>Username: ${this.testResult.username}</div>`
                  : ''}
              </div>
              ${this.testResult.message
                ? html`<div class="test-result-message">${this.testResult.message}</div>`
                : ''}
              ${this.testResult.success
                ? html`
                    <div class="form-actions" style="margin-top: var(--spacing-sm)">
                      <button class="btn btn-secondary" @click=${this.handleEraseCredentials}>
                        Erase Credentials
                      </button>
                    </div>
                  `
                : ''}
            </div>
          `
        : ''}
    `;
  }

  render() {
    if (!this.open) return null;

    return html`
      <lv-modal modalTitle="Credential Management" open @close=${this.handleClose}>
        <div class="content">
          ${this.error
            ? html`
                <div class="error-banner">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="15" y1="9" x2="9" y2="15"></line>
                    <line x1="9" y1="9" x2="15" y2="15"></line>
                  </svg>
                  ${this.error}
                </div>
              `
            : ''}

          ${this.gcmStatus ? html`
            <div style="padding: 8px 12px; margin-bottom: 8px; border-radius: 6px; font-size: 12px;
              background: ${this.gcmStatus.gcmAvailable || this.gcmStatus.configuredHelper ? 'var(--color-success-bg, #0d2818)' : 'var(--color-bg-secondary)'};
              border: 1px solid ${this.gcmStatus.gcmAvailable || this.gcmStatus.configuredHelper ? 'var(--color-success, #2ea043)' : 'var(--color-border)'};
              color: ${this.gcmStatus.gcmAvailable || this.gcmStatus.configuredHelper ? 'var(--color-success, #2ea043)' : 'var(--color-text-secondary)'};">
              ${this.gcmStatus.gcmAvailable
                ? html`<strong>Git Credential Manager</strong> detected${this.gcmStatus.gcmVersion ? html` (${this.gcmStatus.gcmVersion})` : ''} — credentials managed by GCM`
                : this.gcmStatus.configuredHelper
                  ? html`<strong>Credential helper</strong>: <code>${this.gcmStatus.configuredHelper}</code> — credentials managed by system`
                  : html`No credential manager detected — using Gitnado's built-in credential storage`}
            </div>
          ` : ''}

          <div class="tabs">
            <button
              class="tab ${this.activeTab === 'helpers' ? 'active' : ''}"
              @click=${() => (this.activeTab = 'helpers')}
            >
              Credential Helpers
            </button>
            <button
              class="tab ${this.activeTab === 'test' ? 'active' : ''}"
              @click=${() => (this.activeTab = 'test')}
            >
              Test Credentials
            </button>
          </div>

          ${this.activeTab === 'helpers' ? this.renderHelpersTab() : this.renderTestTab()}
        </div>
      </lv-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-credentials-dialog': LvCredentialsDialog;
  }
}
