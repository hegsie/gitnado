import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as aiService from '../../services/ai.service.ts';
import type {
  AiLedgerEntry,
  AiPrivacySummary,
  AiProviderInfo,
  AiProviderType,
  AiTaskRoute,
  AiTaskTier,
} from '../../services/ai.service.ts';

interface TierMetadata {
  tier: AiTaskTier;
  label: string;
  description: string;
}

const TASK_TIERS: readonly TierMetadata[] = [
  {
    tier: 'fast_text',
    label: 'Commit & Naming (Fast Text)',
    description: 'Commit messages, PR descriptions, changelogs, and reflog matching',
  },
  {
    tier: 'code_review',
    label: 'Review & Explain (Code Review)',
    description: 'Pre-commit Vibe Check, staged change analysis, and conflict explanations',
  },
  {
    tier: 'reasoning_merge',
    label: 'Conflict & History Recompose (Reasoning)',
    description: 'Three-way merge conflict resolution and multi-commit history recomposition',
  },
];

@customElement('gn-ai-routing-ledger')
export class GnAiRoutingLedger extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        margin-top: var(--spacing-md);
      }

      .panel-card {
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        padding: var(--spacing-md);
        margin-bottom: var(--spacing-md);
        background: var(--color-bg-secondary);
      }

      .card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-sm);
        margin-bottom: var(--spacing-sm);
      }

      .card-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
      }

      .card-subtitle {
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-sm);
      }

      .privacy-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: var(--radius-full);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
      }

      .privacy-badge.local {
        background: rgba(34, 197, 94, 0.14);
        color: var(--color-success);
      }

      .privacy-badge.cloud {
        background: rgba(59, 130, 246, 0.14);
        color: var(--color-primary);
      }

      .summary-stats {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: var(--spacing-sm);
        margin-top: var(--spacing-xs);
      }

      .stat-box {
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        padding: var(--spacing-xs) var(--spacing-sm);
      }

      .stat-label {
        font-size: 11px;
        color: var(--color-text-muted);
      }

      .stat-value {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
      }

      .tier-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-md);
        padding: var(--spacing-sm) 0;
        border-bottom: 1px solid var(--color-border);
      }

      .tier-row:last-child {
        border-bottom: none;
      }

      .tier-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex: 1;
        min-width: 0;
      }

      .tier-name {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
      }

      .tier-desc {
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .tier-controls {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      select,
      input[type='text'] {
        padding: 5px 8px;
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-primary);
        font-size: var(--font-size-xs);
      }

      .ledger-actions {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      button.small-btn {
        padding: 4px 10px;
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-primary);
        font-size: var(--font-size-xs);
        cursor: pointer;
      }

      button.small-btn:hover:not(:disabled) {
        background: var(--color-bg-hover);
      }

      button.small-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .ledger-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--font-size-xs);
      }

      .ledger-table th,
      .ledger-table td {
        text-align: left;
        padding: 6px 8px;
        border-bottom: 1px solid var(--color-border);
      }

      .ledger-table th {
        color: var(--color-text-muted);
        font-weight: var(--font-weight-medium);
      }

      .route-pill {
        display: inline-block;
        padding: 2px 6px;
        border-radius: var(--radius-full);
        font-size: 10px;
        font-weight: var(--font-weight-medium);
      }

      .route-pill.local {
        background: rgba(34, 197, 94, 0.14);
        color: var(--color-success);
      }

      .route-pill.cloud {
        background: rgba(59, 130, 246, 0.14);
        color: var(--color-primary);
      }

      .prompt-preview {
        margin-top: 4px;
        padding: 6px 8px;
        border-radius: var(--radius-sm);
        background: var(--color-bg-tertiary);
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--color-text-secondary);
      }

      .empty-ledger {
        padding: var(--spacing-sm) 0;
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }
    `,
  ];

  @state() public providers: AiProviderInfo[] = [];
  @state() public activeProvider: AiProviderType | null = null;
  @state() public taskRoutes: Partial<Record<AiTaskTier, AiTaskRoute>> = {};
  @state() public ledgerEntries: AiLedgerEntry[] = [];
  @state() public privacySummary: AiPrivacySummary = {
    totalCalls: 0,
    localCalls: 0,
    cloudCalls: 0,
    totalEstimatedTokens: 0,
    localPercentage: 100,
  };
  @state() private expandedEntryIds: Set<number> = new Set();

  override connectedCallback(): void {
    super.connectedCallback();
    void this.refreshAll();
  }

  public async refreshAll(): Promise<void> {
    const [providersRes, activeRes, routesRes, ledgerRes, summaryRes] = await Promise.all([
      aiService.getAiProviders(),
      aiService.getActiveAiProvider(),
      aiService.getAiTaskRoutes(),
      aiService.getAiLedger(),
      aiService.getAiPrivacySummary(),
    ]);

    if (providersRes.success && providersRes.data) {
      this.providers = providersRes.data;
    }
    if (activeRes.success) {
      this.activeProvider = activeRes.data ?? null;
    }
    if (routesRes.success && routesRes.data) {
      this.taskRoutes = routesRes.data;
    }
    if (ledgerRes.success && ledgerRes.data) {
      this.ledgerEntries = ledgerRes.data;
    }
    if (summaryRes.success && summaryRes.data) {
      this.privacySummary = summaryRes.data;
    }
  }

  private isCompletelyLocal(): boolean {
    if (this.privacySummary.totalCalls > 0) {
      return this.privacySummary.cloudCalls === 0;
    }
    const configuredProviders: AiProviderType[] = [];
    if (this.activeProvider) {
      configuredProviders.push(this.activeProvider);
    }
    for (const route of Object.values(this.taskRoutes)) {
      if (route) configuredProviders.push(route.provider);
    }
    return configuredProviders.every((p) => aiService.isLocalProvider(p));
  }

  public async handleTierProviderChange(tier: AiTaskTier, providerValue: string): Promise<void> {
    if (!providerValue) {
      const res = await aiService.setAiTaskRoute(tier, null);
      if (res.success) {
        const updated = { ...this.taskRoutes };
        delete updated[tier];
        this.taskRoutes = updated;
      }
      return;
    }

    const provider = providerValue as AiProviderType;
    const existingModel = this.taskRoutes[tier]?.model ?? null;
    const route: AiTaskRoute = { provider, model: existingModel };
    const res = await aiService.setAiTaskRoute(tier, route);
    if (res.success) {
      this.taskRoutes = { ...this.taskRoutes, [tier]: route };
    }
  }

  public async handleTierModelChange(tier: AiTaskTier, modelValue: string): Promise<void> {
    const current = this.taskRoutes[tier];
    if (!current) return;
    const trimmed = modelValue.trim();
    const route: AiTaskRoute = {
      provider: current.provider,
      model: trimmed.length > 0 ? trimmed : null,
    };
    const res = await aiService.setAiTaskRoute(tier, route);
    if (res.success) {
      this.taskRoutes = { ...this.taskRoutes, [tier]: route };
    }
  }

  public async handleClearLedger(): Promise<void> {
    const res = await aiService.clearAiLedger();
    if (res.success) {
      this.ledgerEntries = [];
      this.expandedEntryIds = new Set();
      this.privacySummary = {
        totalCalls: 0,
        localCalls: 0,
        cloudCalls: 0,
        totalEstimatedTokens: 0,
        localPercentage: 100,
      };
    }
  }

  private togglePreview(id: number): void {
    const next = new Set(this.expandedEntryIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.expandedEntryIds = next;
  }

  private formatTimestamp(unixSeconds: number): string {
    try {
      return new Date(unixSeconds * 1000).toLocaleTimeString();
    } catch {
      return String(unixSeconds);
    }
  }

  override render() {
    const isLocal = this.isCompletelyLocal();
    const badgeClass = isLocal ? 'local' : 'cloud';
    const badgeLabel = isLocal ? '100% Local' : 'Cloud Routing';

    return html`
      <div class="panel-card" id="privacy-guarantee-card">
        <div class="card-header">
          <span class="card-title">Privacy Guarantee & Routing Summary</span>
          <span class="privacy-badge ${badgeClass}" id="privacy-guarantee-badge">
            ${badgeLabel}
          </span>
        </div>
        <div class="card-subtitle">
          Live breakdown of local vs. cloud AI execution in this session
        </div>
        <div class="summary-stats">
          <div class="stat-box">
            <div class="stat-label">Total Calls</div>
            <div class="stat-value" id="stat-total-calls">${this.privacySummary.totalCalls}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">Local Calls</div>
            <div class="stat-value" id="stat-local-calls">${this.privacySummary.localCalls}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">Cloud Calls</div>
            <div class="stat-value" id="stat-cloud-calls">${this.privacySummary.cloudCalls}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">Est. Tokens</div>
            <div class="stat-value" id="stat-est-tokens">${this.privacySummary.totalEstimatedTokens}</div>
          </div>
        </div>
      </div>

      <div class="panel-card" id="per-task-routing-card">
        <div class="card-header">
          <span class="card-title">Per-Task Model Routing</span>
        </div>
        <div class="card-subtitle">
          Route specific AI task tiers to local or cloud models, or leave on Default to use the active provider
        </div>
        ${TASK_TIERS.map((meta) => {
          const route = this.taskRoutes[meta.tier];
          const selectedProvider = route?.provider ?? '';
          const selectedModel = route?.model ?? '';
          return html`
            <div class="tier-row" data-tier=${meta.tier}>
              <div class="tier-info">
                <span class="tier-name">${meta.label}</span>
                <span class="tier-desc">${meta.description}</span>
              </div>
              <div class="tier-controls">
                <select
                  class="tier-provider-select"
                  data-tier=${meta.tier}
                  .value=${selectedProvider}
                  @change=${(e: Event) =>
                    this.handleTierProviderChange(
                      meta.tier,
                      (e.target as HTMLSelectElement).value,
                    )}
                >
                  <option value="" ?selected=${!selectedProvider}>
                    Default (Active Provider)
                  </option>
                  ${this.providers.map(
                    (p) => html`
                      <option
                        value=${p.providerType}
                        ?selected=${selectedProvider === p.providerType}
                      >
                        ${p.name} (${aiService.isLocalProvider(p.providerType) ? 'Local' : 'Cloud'})
                      </option>
                    `,
                  )}
                </select>
                ${selectedProvider
                  ? html`
                      <input
                        type="text"
                        class="tier-model-input"
                        data-tier=${meta.tier}
                        placeholder="Model override (optional)"
                        .value=${selectedModel}
                        @change=${(e: Event) =>
                          this.handleTierModelChange(
                            meta.tier,
                            (e.target as HTMLInputElement).value,
                          )}
                        style="width: 150px;"
                      />
                    `
                  : nothing}
              </div>
            </div>
          `;
        })}
      </div>

      <div class="panel-card" id="ai-activity-ledger-card">
        <div class="card-header">
          <span class="card-title">AI Privacy & Activity Ledger</span>
          <div class="ledger-actions">
            <button
              class="small-btn"
              id="refresh-ledger-btn"
              @click=${() => this.refreshAll()}
            >
              Refresh
            </button>
            <button
              class="small-btn"
              id="clear-ledger-btn"
              ?disabled=${this.ledgerEntries.length === 0}
              @click=${() => this.handleClearLedger()}
            >
              Clear Ledger
            </button>
          </div>
        </div>
        <div class="card-subtitle">
          Every AI request is logged with its provider, route locality, token estimate, latency, and redacted prompt preview
        </div>
        ${this.ledgerEntries.length === 0
          ? html`<div class="empty-ledger">No AI activity recorded in this session.</div>`
          : html`
              <table class="ledger-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Feature</th>
                    <th>Tier</th>
                    <th>Provider</th>
                    <th>Locality</th>
                    <th>Tokens</th>
                    <th>Latency</th>
                    <th>Prompt</th>
                  </tr>
                </thead>
                <tbody>
                  ${this.ledgerEntries.map((entry) => {
                    const expanded = this.expandedEntryIds.has(entry.id);
                    return html`
                      <tr class="ledger-row" data-entry-id=${entry.id}>
                        <td>${this.formatTimestamp(entry.timestamp)}</td>
                        <td>${entry.feature}</td>
                        <td>${entry.taskTier}</td>
                        <td>${aiService.getProviderDisplayName(entry.providerType)} (${entry.model})</td>
                        <td>
                          <span class="route-pill ${entry.isLocal ? 'local' : 'cloud'}">
                            ${entry.isLocal ? 'Local' : 'Cloud'}
                          </span>
                        </td>
                        <td>~${entry.estimatedTokens}</td>
                        <td>${entry.durationMs} ms</td>
                        <td>
                          <button
                            class="small-btn toggle-preview-btn"
                            @click=${() => this.togglePreview(entry.id)}
                          >
                            ${expanded ? 'Hide' : 'Preview'}
                          </button>
                          ${expanded
                            ? html`<div class="prompt-preview">${entry.promptPreview}</div>`
                            : nothing}
                        </td>
                      </tr>
                    `;
                  })}
                </tbody>
              </table>
            `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-ai-routing-ledger': GnAiRoutingLedger;
  }
}
