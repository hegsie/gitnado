/**
 * AI Explain Drawer Component (#621)
 *
 * Inline collapsible drawer that streams and renders a structured AI
 * explanation (Intent, Summary, Key Changes, Potential Risks) for a commit,
 * branch comparison, or working tree change.
 */

import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import {
  explainGitTarget,
  explainGitTargetStream,
  type AiExplanation,
  type AiExplainTokenEvent,
  type ExplainTargetType,
} from '../../services/ai-explain.service.ts';
import { listenToEvent, safeUnlisten } from '../../services/tauri-api.ts';
import { showToast } from '../../services/notification.service.ts';
import type { UnlistenFn } from '@tauri-apps/api/event';

@customElement('gn-ai-explain-drawer')
export class GnAiExplainDrawer extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      :host(:not([open])) {
        display: none;
      }

      .drawer {
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-secondary);
        padding: var(--spacing-sm) var(--spacing-md);
        margin: var(--spacing-xs) 0;
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .drawer-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-sm);
        flex-wrap: wrap;
      }

      .title-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        min-width: 0;
      }

      .sparkle-icon {
        width: 14px;
        height: 14px;
        color: var(--color-primary);
        flex-shrink: 0;
      }

      .drawer-title {
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .provider-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        font-size: 10px;
        font-weight: var(--font-weight-medium);
        flex-shrink: 0;
      }

      .provider-pill.local {
        background: var(--color-success-bg, rgba(22, 163, 74, 0.15));
        color: var(--color-success, #16a34a);
      }

      .provider-pill.cloud {
        background: var(--color-info-bg, rgba(37, 99, 235, 0.15));
        color: var(--color-info, #2563eb);
      }

      .header-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .action-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-tertiary);
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .action-btn:hover:not(:disabled) {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .action-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .action-btn svg {
        width: 12px;
        height: 12px;
      }

      .loading-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        padding: var(--spacing-xs) 0;
      }

      .spinner {
        width: 14px;
        height: 14px;
        border: 2px solid var(--color-border);
        border-top-color: var(--color-primary);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        flex-shrink: 0;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      .stream-preview {
        margin: 0;
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 160px;
        overflow-y: auto;
      }

      .error-box {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-sm);
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-error-bg);
        border: 1px solid var(--color-error);
        border-radius: var(--radius-sm);
        color: var(--color-error);
        font-size: var(--font-size-xs);
      }

      .explanation-body {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        font-size: var(--font-size-xs);
      }

      .headline {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
      }

      .block-label {
        font-size: 10px;
        font-weight: var(--font-weight-semibold);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--color-text-muted);
        margin-top: 2px;
      }

      .block-text {
        color: var(--color-text-secondary);
        line-height: 1.45;
      }

      .bullet-list {
        margin: 0;
        padding-left: 16px;
        color: var(--color-text-secondary);
        line-height: 1.45;
      }

      .bullet-list li {
        margin-bottom: 2px;
      }
    `,
  ];

  @property({ type: String }) repositoryPath = '';
  @property({ type: String }) targetType: ExplainTargetType = 'commit';
  @property({ type: String }) targetId = '';
  @property({ type: String }) baseRef = '';
  @property({ type: String }) filePath = '';
  @property({ type: Boolean, reflect: true }) open = false;

  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private explanation: AiExplanation | null = null;
  @state() private streamBuffer = '';

  private unlistenStream: UnlistenFn | null = null;
  private requestGeneration = 0;
  private lastLoadedKey = '';
  private attemptedKey = '';

  connectedCallback(): void {
    super.connectedCallback();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    safeUnlisten(this.unlistenStream);
    this.unlistenStream = null;
  }

  private async ensureStreamListener(): Promise<void> {
    if (this.unlistenStream) return;
    if (!(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__) return;
    try {
      this.unlistenStream = await listenToEvent<AiExplainTokenEvent>(
        'ai-explain-token',
        (payload) => {
          if (!payload || payload.targetId !== this.targetId) return;
          if (!payload.done && payload.token) {
            this.streamBuffer += payload.token;
          }
        },
      );
    } catch {
      // Event bridge is optional in unit test environments
      this.unlistenStream = null;
    }
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);

    const key = `${this.repositoryPath}|${this.targetType}|${this.targetId}|${this.baseRef}|${this.filePath}`;
    if (
      changed.has('repositoryPath') ||
      changed.has('targetType') ||
      changed.has('targetId') ||
      changed.has('baseRef') ||
      changed.has('filePath')
    ) {
      if (key !== this.lastLoadedKey) {
        this.explanation = null;
        this.error = null;
        this.streamBuffer = '';
      }
    }

    if (changed.has('open') && this.open && this.error) {
      this.attemptedKey = '';
      this.error = null;
    }

    if (
      this.open &&
      this.repositoryPath &&
      this.targetId &&
      key !== this.attemptedKey
    ) {
      void this.loadExplanation();
    }
  }

  public async loadExplanation(force = false): Promise<void> {
    if (!this.repositoryPath || !this.targetId) return;
    const key = `${this.repositoryPath}|${this.targetType}|${this.targetId}|${this.baseRef}|${this.filePath}`;
    if (!force && key === this.lastLoadedKey && this.explanation) return;

    this.attemptedKey = key;
    const gen = ++this.requestGeneration;
    this.loading = true;
    this.error = null;
    this.streamBuffer = '';

    await this.ensureStreamListener();

    try {
      const base = this.baseRef || undefined;
      const result = this.filePath
        ? await explainGitTarget(
            this.repositoryPath,
            this.targetType,
            this.targetId,
            base,
            this.filePath,
          )
        : await explainGitTargetStream(
            this.repositoryPath,
            this.targetType,
            this.targetId,
            base,
          );

      if (gen !== this.requestGeneration) return;

      if (result.success && result.data) {
        this.explanation = result.data;
        this.lastLoadedKey = key;
      } else {
        this.error = result.error?.message ?? 'Failed to generate AI explanation';
      }
    } catch (err) {
      if (gen !== this.requestGeneration) return;
      this.error = err instanceof Error ? err.message : 'Failed to generate AI explanation';
    } finally {
      if (gen === this.requestGeneration) {
        this.loading = false;
      }
    }
  }

  public formatMarkdown(): string {
    if (!this.explanation) return '';
    const e = this.explanation;
    const lines: string[] = [
      `## ${e.title}`,
      '',
      `**Intent:** ${e.intent}`,
      '',
      e.summary,
    ];

    if (e.keyChanges.length > 0) {
      lines.push('', '### Key Changes');
      for (const item of e.keyChanges) {
        lines.push(`- ${item}`);
      }
    }

    if (e.risks.length > 0) {
      lines.push('', '### Potential Risks');
      for (const risk of e.risks) {
        lines.push(`- ${risk}`);
      }
    }

    return lines.join('\n');
  }

  private async handleCopyMarkdown(): Promise<void> {
    const md = this.formatMarkdown();
    if (!md) return;
    try {
      await navigator.clipboard.writeText(md);
      showToast('Explanation copied as Markdown', 'success');
    } catch {
      showToast('Failed to copy explanation to clipboard', 'error');
    }
  }

  private handleRegenerate(): void {
    void this.loadExplanation(true);
  }

  private handleClose(): void {
    this.open = false;
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  render() {
    if (!this.open) return nothing;

    const exp = this.explanation;

    return html`
      <div class="drawer" role="region" aria-label="AI Explanation">
        <div class="drawer-header">
          <div class="title-row">
            <svg class="sparkle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M12 3l1.9 5.8a2 2 0 001.3 1.3L21 12l-5.8 1.9a2 2 0 00-1.3 1.3L12 21l-1.9-5.8a2 2 0 00-1.3-1.3L3 12l5.8-1.9a2 2 0 001.3-1.3L12 3z"></path>
            </svg>
            <span class="drawer-title">AI Explanation</span>
            ${exp
              ? html`
                  <span
                    class="provider-pill ${exp.isLocal ? 'local' : 'cloud'}"
                    data-testid="provider-pill"
                  >
                    ${exp.isLocal ? 'Local' : 'Cloud'} · ${exp.providerUsed}
                  </span>
                `
              : nothing}
          </div>

          <div class="header-actions">
            <button
              class="action-btn"
              type="button"
              title="Regenerate explanation"
              data-testid="regenerate-btn"
              ?disabled=${this.loading}
              @click=${this.handleRegenerate}
            >
              Regenerate
            </button>
            <button
              class="action-btn"
              type="button"
              title="Copy explanation as Markdown"
              data-testid="copy-markdown-btn"
              ?disabled=${this.loading || !exp}
              @click=${this.handleCopyMarkdown}
            >
              Copy Markdown
            </button>
            <button
              class="action-btn"
              type="button"
              title="Close explanation"
              aria-label="Close explanation"
              data-testid="close-explain-btn"
              @click=${this.handleClose}
            >
              Close
            </button>
          </div>
        </div>

        ${this.loading
          ? html`
              <div class="loading-row" data-testid="explain-loading">
                <span class="spinner"></span>
                <span>Analyzing changes with AI…</span>
              </div>
              ${this.streamBuffer
                ? html`<pre class="stream-preview" data-testid="stream-preview">${this.streamBuffer}</pre>`
                : nothing}
            `
          : nothing}

        ${!this.loading && this.error
          ? html`
              <div class="error-box" role="alert" data-testid="explain-error">
                <span>${this.error}</span>
                <button class="action-btn" type="button" @click=${this.handleRegenerate}>
                  Retry
                </button>
              </div>
            `
          : nothing}

        ${!this.loading && !this.error && exp
          ? html`
              <div class="explanation-body" data-testid="explanation-body">
                <div class="headline" data-testid="explanation-title">${exp.title}</div>

                <div class="block-label">Intent</div>
                <div class="block-text" data-testid="explanation-intent">${exp.intent}</div>

                <div class="block-label">Summary</div>
                <div class="block-text" data-testid="explanation-summary">${exp.summary}</div>

                ${exp.keyChanges.length > 0
                  ? html`
                      <div class="block-label">Key Changes</div>
                      <ul class="bullet-list" data-testid="explanation-key-changes">
                        ${exp.keyChanges.map((item) => html`<li>${item}</li>`)}
                      </ul>
                    `
                  : nothing}

                ${exp.risks.length > 0
                  ? html`
                      <div class="block-label">Potential Risks</div>
                      <ul class="bullet-list" data-testid="explanation-risks">
                        ${exp.risks.map((risk) => html`<li>${risk}</li>`)}
                      </ul>
                    `
                  : nothing}
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-ai-explain-drawer': GnAiExplainDrawer;
  }
}
