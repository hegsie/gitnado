/**
 * Jira Integration Dialog
 * Manage Jira connection settings, browse issues, transition statuses, and create branches from issues.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import {
  getJiraConfig,
  saveJiraConfig,
  deleteJiraConfig,
  testJiraConnection,
  getJiraIssues,
  getJiraTransitions,
  transitionJiraIssue,
  generateBranchFromIssue,
} from '../../services/git.service.ts';
import type {
  JiraConfig,
  JiraIssue,
  JiraTransition,
} from '../../services/git.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { pushOverlay, removeOverlay, isTopOverlay } from '../../utils/overlay-stack.ts';

type JiraTab = 'issues' | 'settings';

@customElement('lv-jira-dialog')
export class LvJiraDialog extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: var(--z-modal, 200);
      }

      :host([open]) {
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(2px);
      }

      .dialog {
        position: relative;
        display: flex;
        flex-direction: column;
        width: 720px;
        max-width: 92vw;
        max-height: 85vh;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        overflow: hidden;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-md) var(--spacing-lg);
        border-bottom: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
      }

      .header-title {
        font-size: var(--font-size-md);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
      }

      .close-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        background: transparent;
        color: var(--color-text-secondary);
        border-radius: var(--radius-sm);
        cursor: pointer;
      }

      .close-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .tabs {
        display: flex;
        gap: var(--spacing-xs);
        padding: 0 var(--spacing-lg);
        border-bottom: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
      }

      .tab-btn {
        padding: var(--spacing-sm) var(--spacing-md);
        border: none;
        border-bottom: 2px solid transparent;
        background: transparent;
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
      }

      .tab-btn.active {
        color: var(--color-primary);
        border-bottom-color: var(--color-primary);
      }

      .content {
        flex: 1;
        overflow-y: auto;
        padding: var(--spacing-lg);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
      }

      .error-banner {
        padding: var(--spacing-sm) var(--spacing-md);
        background: rgba(239, 68, 68, 0.12);
        border: 1px solid var(--color-error, #ef4444);
        border-radius: var(--radius-md);
        color: var(--color-error, #ef4444);
        font-size: var(--font-size-sm);
      }

      .success-banner {
        padding: var(--spacing-sm) var(--spacing-md);
        background: rgba(34, 197, 94, 0.12);
        border: 1px solid var(--color-success, #22c55e);
        border-radius: var(--radius-md);
        color: var(--color-success, #22c55e);
        font-size: var(--font-size-sm);
      }

      .toolbar {
        display: flex;
        gap: var(--spacing-sm);
        align-items: center;
      }

      .jql-input,
      .form-input {
        flex: 1;
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
      }

      .form-group {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .form-label {
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
      }

      .form-actions {
        display: flex;
        gap: var(--spacing-sm);
        justify-content: flex-end;
        margin-top: var(--spacing-sm);
      }

      .btn {
        padding: var(--spacing-xs) var(--spacing-md);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-tertiary);
        color: var(--color-text-primary);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
      }

      .btn:hover:not(:disabled) {
        background: var(--color-bg-hover);
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-primary {
        background: var(--color-primary);
        border-color: var(--color-primary);
        color: #fff;
      }

      .btn-danger {
        background: rgba(239, 68, 68, 0.15);
        border-color: var(--color-error, #ef4444);
        color: var(--color-error, #ef4444);
      }

      .issue-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .issue-item {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        padding: var(--spacing-md);
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }

      .issue-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-sm);
      }

      .issue-meta {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        flex-wrap: wrap;
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .issue-key {
        font-family: var(--font-mono);
        font-weight: var(--font-weight-semibold);
        color: var(--color-primary);
      }

      .issue-summary {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
      }

      .badge {
        padding: 2px 6px;
        border-radius: var(--radius-sm);
        background: var(--color-bg-tertiary);
        font-size: var(--font-size-xs);
      }

      .issue-actions {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        flex-wrap: wrap;
        margin-top: var(--spacing-xs);
      }

      .transition-select {
        padding: 4px 8px;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-primary);
        font-size: var(--font-size-xs);
      }

      .empty-state {
        padding: var(--spacing-xl);
        text-align: center;
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: String }) repositoryPath = '';

  @state() private activeTab: JiraTab = 'issues';
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private success: string | null = null;

  // Settings form state
  @state() private baseUrl = '';
  @state() private email = '';
  @state() private apiToken = '';
  @state() private projectKey = '';
  @state() private hasSavedConfig = false;

  // Issues state
  @state() private jqlFilter = '';
  @state() private issues: JiraIssue[] = [];
  @state() private issueTransitions: Record<string, JiraTransition[]> = {};

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (!this.open || !isTopOverlay(this)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this.handleKeyDown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.handleKeyDown);
    removeOverlay(this);
  }

  protected updated(changedProps: Map<string, unknown>): void {
    if (changedProps.has('open')) {
      if (this.open) {
        pushOverlay(this);
        this.error = null;
        this.success = null;
        void this.loadInitialData();
      } else {
        removeOverlay(this);
      }
    } else if (changedProps.has('repositoryPath') && this.open && this.repositoryPath) {
      void this.loadInitialData();
    }
  }

  private async loadInitialData(): Promise<void> {
    if (!this.repositoryPath) return;
    this.loading = true;
    try {
      const configResult = await getJiraConfig(this.repositoryPath);
      if (configResult.success && configResult.data) {
        this.applyConfig(configResult.data);
      } else {
        this.hasSavedConfig = false;
      }

      const issuesResult = await getJiraIssues(
        this.repositoryPath,
        this.jqlFilter.trim() || undefined,
      );
      if (issuesResult.success && Array.isArray(issuesResult.data)) {
        this.issues = issuesResult.data;
      } else {
        this.issues = [];
      }
    } finally {
      this.loading = false;
    }
  }

  private applyConfig(config: JiraConfig): void {
    this.baseUrl = config.baseUrl ?? '';
    this.email = config.email ?? '';
    this.apiToken = config.apiToken ?? '';
    this.projectKey = config.projectKey ?? '';
    this.hasSavedConfig = true;
  }

  private buildConfigFromForm(): JiraConfig {
    return {
      baseUrl: this.baseUrl.trim(),
      email: this.email.trim(),
      apiToken: this.apiToken.trim(),
      projectKey: this.projectKey.trim() || null,
    };
  }

  private async handleTestConnection(): Promise<void> {
    this.error = null;
    this.success = null;
    this.loading = true;
    try {
      const config = this.buildConfigFromForm();
      const result = await testJiraConnection(this.repositoryPath, config);
      if (result.success && result.data !== false) {
        this.success = 'Successfully connected to Jira';
        showToast(this.success, 'success');
      } else {
        this.error = result.error?.message ?? 'Failed to connect to Jira';
        showToast(this.error, 'error');
      }
    } finally {
      this.loading = false;
    }
  }

  private async handleSaveConfig(): Promise<void> {
    this.error = null;
    this.success = null;
    const config = this.buildConfigFromForm();
    if (!config.baseUrl || !config.email || !config.apiToken) {
      this.error = 'Base URL, email, and API token are required';
      showToast(this.error, 'error');
      return;
    }

    this.loading = true;
    try {
      const result = await saveJiraConfig(this.repositoryPath, config);
      if (result.success) {
        this.hasSavedConfig = true;
        this.success = 'Jira configuration saved';
        showToast(this.success, 'success');
        this.dispatchEvent(
          new CustomEvent('jira-config-changed', {
            detail: { config },
            bubbles: true,
            composed: true,
          }),
        );
      } else {
        this.error = result.error?.message ?? 'Failed to save Jira configuration';
        showToast(this.error, 'error');
      }
    } finally {
      this.loading = false;
    }
  }

  private async handleDeleteConfig(): Promise<void> {
    this.error = null;
    this.success = null;
    this.loading = true;
    try {
      const result = await deleteJiraConfig(this.repositoryPath);
      if (result.success) {
        this.baseUrl = '';
        this.email = '';
        this.apiToken = '';
        this.projectKey = '';
        this.hasSavedConfig = false;
        this.issues = [];
        this.success = 'Jira configuration deleted';
        showToast(this.success, 'success');
        this.dispatchEvent(
          new CustomEvent('jira-config-changed', {
            detail: { config: null },
            bubbles: true,
            composed: true,
          }),
        );
      } else {
        this.error = result.error?.message ?? 'Failed to delete Jira configuration';
        showToast(this.error, 'error');
      }
    } finally {
      this.loading = false;
    }
  }

  private async handleRefreshIssues(): Promise<void> {
    if (!this.repositoryPath) return;
    this.error = null;
    this.success = null;
    this.loading = true;
    try {
      const result = await getJiraIssues(
        this.repositoryPath,
        this.jqlFilter.trim() || undefined,
      );
      if (result.success && result.data) {
        this.issues = result.data;
      } else {
        this.error = result.error?.message ?? 'Failed to load Jira issues';
        showToast(this.error, 'error');
      }
    } finally {
      this.loading = false;
    }
  }

  private async handleCreateBranch(issue: JiraIssue): Promise<void> {
    this.error = null;
    this.success = null;
    const branchName = generateBranchFromIssue({
      issueKey: issue.key,
      summary: issue.summary,
      prefix: 'feature',
    });

    this.loading = true;
    try {
      const result = await gitService.createBranch(this.repositoryPath, {
        name: branchName,
        checkout: true,
      });
      if (result.success) {
        this.success = `Created branch ${branchName}`;
        showToast(this.success, 'success');
        this.dispatchEvent(
          new CustomEvent('branch-created', {
            detail: { name: branchName },
            bubbles: true,
            composed: true,
          }),
        );
      } else {
        this.error = result.error?.message ?? `Failed to create branch ${branchName}`;
        showToast(this.error, 'error');
      }
    } finally {
      this.loading = false;
    }
  }

  private async handleLoadTransitions(issueKey: string): Promise<void> {
    this.error = null;
    const result = await getJiraTransitions(this.repositoryPath, issueKey);
    if (result.success && result.data) {
      this.issueTransitions = {
        ...this.issueTransitions,
        [issueKey]: result.data,
      };
    } else {
      this.error = result.error?.message ?? `Failed to load transitions for ${issueKey}`;
      showToast(this.error, 'error');
    }
  }

  private async handleTransitionIssue(
    issueKey: string,
    transitionId: string,
  ): Promise<void> {
    if (!transitionId) return;
    this.error = null;
    this.success = null;
    this.loading = true;
    try {
      const result = await transitionJiraIssue(
        this.repositoryPath,
        issueKey,
        transitionId,
      );
      if (result.success) {
        this.success = `Transitioned ${issueKey}`;
        showToast(this.success, 'success');
        await this.handleRefreshIssues();
      } else {
        this.error = result.error?.message ?? `Failed to transition ${issueKey}`;
        showToast(this.error, 'error');
      }
    } finally {
      this.loading = false;
    }
  }

  public close(): void {
    this.open = false;
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private renderIssuesTab() {
    return html`
      <div class="toolbar">
        <input
          class="jql-input"
          type="text"
          placeholder="Search JQL or project key..."
          .value=${this.jqlFilter}
          @input=${(e: Event) => {
            this.jqlFilter = (e.target as HTMLInputElement).value;
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              void this.handleRefreshIssues();
            }
          }}
        />
        <button
          class="btn refresh-btn"
          ?disabled=${this.loading}
          @click=${() => void this.handleRefreshIssues()}
        >
          Refresh
        </button>
      </div>

      ${this.issues.length === 0
        ? html`<div class="empty-state">No Jira issues found</div>`
        : html`
            <div class="issue-list">
              ${this.issues.map((issue) => {
                const transitions = this.issueTransitions[issue.key];
                return html`
                  <div class="issue-item" data-issue-key=${issue.key}>
                    <div class="issue-header">
                      <span class="issue-key">${issue.key}</span>
                      <span class="badge issue-status">${issue.status}</span>
                    </div>
                    <div class="issue-summary">${issue.summary}</div>
                    <div class="issue-meta">
                      <span class="badge issue-type">${issue.issueType}</span>
                      ${issue.priority
                        ? html`<span class="badge issue-priority">${issue.priority}</span>`
                        : nothing}
                      ${issue.assignee
                        ? html`<span class="issue-assignee">${issue.assignee}</span>`
                        : nothing}
                    </div>
                    <div class="issue-actions">
                      <button
                        class="btn btn-primary create-branch-btn"
                        ?disabled=${this.loading}
                        @click=${() => void this.handleCreateBranch(issue)}
                      >
                        Create Branch
                      </button>
                      <button
                        class="btn load-transitions-btn"
                        ?disabled=${this.loading}
                        @click=${() => void this.handleLoadTransitions(issue.key)}
                      >
                        Status Transitions
                      </button>
                      ${transitions
                        ? html`
                            <select
                              class="transition-select"
                              aria-label="Transition ${issue.key}"
                              @change=${(e: Event) => {
                                const val = (e.target as HTMLSelectElement).value;
                                void this.handleTransitionIssue(issue.key, val);
                              }}
                            >
                              <option value="">Select status...</option>
                              ${transitions.map(
                                (t) => html`<option value=${t.id}>${t.name}</option>`,
                              )}
                            </select>
                            ${transitions.map(
                              (t) => html`
                                <button
                                  class="btn transition-option-btn"
                                  data-transition-id=${t.id}
                                  ?disabled=${this.loading}
                                  @click=${() => void this.handleTransitionIssue(issue.key, t.id)}
                                >
                                  ${t.name}
                                </button>
                              `,
                            )}
                          `
                        : nothing}
                    </div>
                  </div>
                `;
              })}
            </div>
          `}
    `;
  }

  private renderSettingsTab() {
    return html`
      <div class="form-group">
        <label class="form-label" for="jira-base-url">Jira Base URL</label>
        <input
          id="jira-base-url"
          name="baseUrl"
          class="form-input"
          type="url"
          placeholder="https://your-domain.atlassian.net"
          .value=${this.baseUrl}
          @input=${(e: Event) => {
            this.baseUrl = (e.target as HTMLInputElement).value;
          }}
        />
      </div>

      <div class="form-group">
        <label class="form-label" for="jira-email">Email</label>
        <input
          id="jira-email"
          name="email"
          class="form-input"
          type="email"
          placeholder="user@example.com"
          .value=${this.email}
          @input=${(e: Event) => {
            this.email = (e.target as HTMLInputElement).value;
          }}
        />
      </div>

      <div class="form-group">
        <label class="form-label" for="jira-api-token">API Token</label>
        <input
          id="jira-api-token"
          name="apiToken"
          class="form-input"
          type="password"
          placeholder="Enter Jira API token"
          .value=${this.apiToken}
          @input=${(e: Event) => {
            this.apiToken = (e.target as HTMLInputElement).value;
          }}
        />
      </div>

      <div class="form-group">
        <label class="form-label" for="jira-project-key">Project Key (optional)</label>
        <input
          id="jira-project-key"
          name="projectKey"
          class="form-input"
          type="text"
          placeholder="PROJ"
          .value=${this.projectKey}
          @input=${(e: Event) => {
            this.projectKey = (e.target as HTMLInputElement).value;
          }}
        />
      </div>

      <div class="form-actions">
        <button
          class="btn test-connection-btn"
          ?disabled=${this.loading}
          @click=${() => void this.handleTestConnection()}
        >
          Test Connection
        </button>
        <button
          class="btn btn-danger delete-config-btn"
          ?disabled=${this.loading}
          @click=${() => void this.handleDeleteConfig()}
        >
          Delete
        </button>
        <button
          class="btn btn-primary save-config-btn"
          ?disabled=${this.loading}
          @click=${() => void this.handleSaveConfig()}
        >
          Save
        </button>
      </div>
    `;
  }

  render() {
    return html`
      <div class="overlay" @click=${() => this.close()}></div>
      <div class="dialog" role="dialog" aria-label="Jira Integration">
        <div class="header">
          <span class="header-title">Jira Issues</span>
          <button class="close-btn" @click=${() => this.close()} title="Close">
            ✕
          </button>
        </div>

        <div class="tabs">
          <button
            class="tab-btn ${this.activeTab === 'issues' ? 'active' : ''}"
            data-tab="issues"
            @click=${() => {
              this.activeTab = 'issues';
            }}
          >
            Issues
          </button>
          <button
            class="tab-btn ${this.activeTab === 'settings' ? 'active' : ''}"
            data-tab="settings"
            @click=${() => {
              this.activeTab = 'settings';
            }}
          >
            Settings
          </button>
        </div>

        <div class="content">
          ${this.error ? html`<div class="error-banner">${this.error}</div>` : nothing}
          ${this.success ? html`<div class="success-banner">${this.success}</div>` : nothing}
          ${this.activeTab === 'issues' ? this.renderIssuesTab() : this.renderSettingsTab()}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-jira-dialog': LvJiraDialog;
  }
}
