/**
 * `<gn-ai-review-panel>` — Shared Lit component for:
 * - Local AI Branch / PR Review findings (#623)
 * - PR Review Comment -> Suggested Patch preview & apply (#624)
 * - "Explain This CI Failure" root-cause diagnosis (#626)
 */

import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import type {
  AiBranchReviewResult,
  AiReviewFinding,
  CommentResolutionPatch,
  CiFailureExplanation,
} from '../../services/ai-review.service.ts';

@customElement('gn-ai-review-panel')
export class GnAiReviewPanel extends LitElement {
  @property({ attribute: false }) reviewResult: AiBranchReviewResult | null = null;
  @property({ type: Boolean }) reviewLoading = false;

  @property({ attribute: false }) patchPreview: CommentResolutionPatch | null = null;
  @property({ type: Boolean }) patchLoading = false;
  @property({ type: Boolean }) applyingPatch = false;

  @property({ attribute: false }) ciExplanation: CiFailureExplanation | null = null;
  @property({ type: Boolean }) ciLoading = false;

  @property({ type: String }) error: string | null = null;
  @property({ type: Boolean }) canPostComment = false;

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .ai-panel {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        margin-top: var(--spacing-xs);
      }

      .ai-card {
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-tertiary);
        padding: var(--spacing-sm) var(--spacing-md);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .ai-card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-sm);
        flex-wrap: wrap;
      }

      .ai-card-title-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        flex-wrap: wrap;
      }

      .ai-card-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
      }

      .ai-badge {
        font-size: var(--font-size-xs);
        padding: 2px 6px;
        border-radius: var(--radius-sm);
        font-weight: var(--font-weight-medium);
        text-transform: uppercase;
      }

      .ai-badge.risk-low,
      .ai-badge.clean {
        background: rgba(46, 160, 67, 0.18);
        color: var(--color-success, #3fb950);
      }

      .ai-badge.risk-medium,
      .ai-badge.severity-warning {
        background: rgba(210, 153, 34, 0.18);
        color: var(--color-warning, #d29922);
      }

      .ai-badge.risk-high,
      .ai-badge.severity-critical,
      .ai-badge.conflict {
        background: rgba(248, 81, 73, 0.18);
        color: var(--color-error, #f85149);
      }

      .ai-badge.severity-suggestion,
      .ai-badge.category {
        background: var(--color-bg-hover);
        color: var(--color-text-secondary);
      }

      .ai-meta {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .ai-summary {
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
        line-height: 1.4;
      }

      .findings-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        max-height: 260px;
        overflow-y: auto;
      }

      .finding-item {
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-secondary);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .finding-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-xs);
        flex-wrap: wrap;
      }

      .finding-badges {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }

      .finding-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
      }

      .finding-location {
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
        color: var(--color-primary);
        background: var(--color-bg-hover);
        padding: 1px 6px;
        border-radius: var(--radius-sm);
      }

      .finding-message {
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        white-space: pre-wrap;
      }

      .finding-fix,
      .diff-preview {
        margin: 4px 0 0;
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
        overflow-x: auto;
        white-space: pre;
        color: var(--color-text-primary);
        max-height: 200px;
        overflow-y: auto;
      }

      .diff-line-add {
        color: var(--color-success, #3fb950);
      }

      .diff-line-del {
        color: var(--color-error, #f85149);
      }

      .diff-line-hunk {
        color: var(--color-primary);
      }

      .ai-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: var(--spacing-xs);
      }

      .ai-loading {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        padding: var(--spacing-xs) 0;
      }

      .ai-error {
        font-size: var(--font-size-xs);
        color: var(--color-error, #f85149);
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-error, #f85149);
        border-radius: var(--radius-sm);
      }

      .ci-section-label {
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-secondary);
        margin-top: 2px;
      }

      .ci-files {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }

      .btn-xs {
        font-size: var(--font-size-xs);
        padding: 2px 8px;
      }
    `,
  ];

  private handlePostFinding(finding: AiReviewFinding): void {
    this.dispatchEvent(
      new CustomEvent<{ finding: AiReviewFinding }>('post-finding-comment', {
        detail: { finding },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleApplyPatch(): void {
    if (!this.patchPreview) return;
    this.dispatchEvent(
      new CustomEvent<{ patch: CommentResolutionPatch }>('apply-patch', {
        detail: { patch: this.patchPreview },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleDismissReview(): void {
    this.dispatchEvent(
      new CustomEvent('dismiss-review', { bubbles: true, composed: true }),
    );
  }

  private handleDismissPatch(): void {
    this.dispatchEvent(
      new CustomEvent('dismiss-patch', { bubbles: true, composed: true }),
    );
  }

  private handleDismissCi(): void {
    this.dispatchEvent(
      new CustomEvent('dismiss-ci', { bubbles: true, composed: true }),
    );
  }

  private renderDiffPreview(unifiedDiff: string): TemplateResult {
    const lines = unifiedDiff.split('\n');
    return html`
      <div class="diff-preview" data-testid="ai-patch-diff">
        ${lines.map((line) => {
          const cls = line.startsWith('+++') || line.startsWith('---')
            ? 'diff-line-hunk'
            : line.startsWith('+')
              ? 'diff-line-add'
              : line.startsWith('-')
                ? 'diff-line-del'
                : line.startsWith('@@')
                  ? 'diff-line-hunk'
                  : '';
          return html`<div class=${cls}>${line}</div>`;
        })}
      </div>
    `;
  }

  private renderBranchReview(): TemplateResult | typeof nothing {
    if (this.reviewLoading) {
      return html`
        <div class="ai-card" data-testid="ai-branch-review-section">
          <div class="ai-loading" data-testid="ai-branch-review-loading">
            Running AI branch review...
          </div>
        </div>
      `;
    }

    if (!this.reviewResult) return nothing;
    const { summary, riskLevel, findings, filesReviewed } = this.reviewResult;

    return html`
      <div class="ai-card" data-testid="ai-branch-review-section">
        <div class="ai-card-header">
          <div class="ai-card-title-row">
            <span class="ai-card-title">AI Branch Review</span>
            <span
              class="ai-badge risk-${riskLevel}"
              data-testid="ai-review-risk-badge"
            >
              ${riskLevel} risk
            </span>
            <span class="ai-meta">${filesReviewed} file(s) reviewed</span>
          </div>
          <button
            class="btn btn-xs"
            data-testid="ai-review-dismiss-btn"
            @click=${this.handleDismissReview}
          >
            Dismiss
          </button>
        </div>

        <div class="ai-summary" data-testid="ai-review-summary">${summary}</div>

        ${findings.length === 0
          ? html`
              <div class="ai-meta" data-testid="ai-review-no-findings">
                No issues found
              </div>
            `
          : html`
              <div class="findings-list">
                ${findings.map(
                  (finding, idx) => html`
                    <div
                      class="finding-item"
                      data-testid="ai-review-finding-${idx}"
                    >
                      <div class="finding-header">
                        <div class="finding-badges">
                          <span class="ai-badge severity-${finding.severity}">
                            ${finding.severity}
                          </span>
                          <span class="ai-badge category">
                            ${finding.category}
                          </span>
                          <span class="finding-title">${finding.title}</span>
                          ${finding.filePath
                            ? html`
                                <span class="finding-location">
                                  ${finding.filePath}${finding.line
                                    ? `:${finding.line}`
                                    : ''}
                                </span>
                              `
                            : nothing}
                        </div>
                        ${this.canPostComment
                          ? html`
                              <button
                                class="btn btn-xs"
                                data-testid="ai-finding-post-comment-${idx}"
                                @click=${() => this.handlePostFinding(finding)}
                              >
                                Post as Comment
                              </button>
                            `
                          : nothing}
                      </div>
                      <div class="finding-message">${finding.message}</div>
                      ${finding.suggestedFix
                        ? html`<pre class="finding-fix">${finding.suggestedFix}</pre>`
                        : nothing}
                    </div>
                  `,
                )}
              </div>
            `}
      </div>
    `;
  }

  private renderPatchPreview(): TemplateResult | typeof nothing {
    if (this.patchLoading) {
      return html`
        <div class="ai-card" data-testid="ai-comment-patch-section">
          <div class="ai-loading" data-testid="ai-comment-patch-loading">
            Generating fix patch with AI...
          </div>
        </div>
      `;
    }

    if (!this.patchPreview) return nothing;
    const { filePath, explanation, unifiedDiff, canApplyCleanly } = this.patchPreview;

    return html`
      <div class="ai-card" data-testid="ai-comment-patch-section">
        <div class="ai-card-header">
          <div class="ai-card-title-row">
            <span class="ai-card-title">Suggested Fix</span>
            <span class="finding-location">${filePath}</span>
            <span
              class="ai-badge ${canApplyCleanly ? 'clean' : 'conflict'}"
              data-testid="ai-patch-clean-badge"
            >
              ${canApplyCleanly ? 'Applies cleanly' : 'Needs manual check'}
            </span>
          </div>
          <button
            class="btn btn-xs"
            data-testid="ai-patch-dismiss-btn"
            @click=${this.handleDismissPatch}
          >
            Dismiss
          </button>
        </div>

        <div class="ai-summary" data-testid="ai-patch-explanation">
          ${explanation}
        </div>

        ${this.renderDiffPreview(unifiedDiff)}

        <div class="ai-actions">
          <button
            class="btn btn-primary btn-xs"
            data-testid="ai-patch-apply-btn"
            ?disabled=${this.applyingPatch || !unifiedDiff.trim()}
            @click=${this.handleApplyPatch}
          >
            ${this.applyingPatch
              ? 'Applying...'
              : 'Apply Patch to Working Tree'}
          </button>
        </div>
      </div>
    `;
  }

  private renderCiExplanation(): TemplateResult | typeof nothing {
    if (this.ciLoading) {
      return html`
        <div class="ai-card" data-testid="ai-ci-explanation-section">
          <div class="ai-loading" data-testid="ai-ci-explanation-loading">
            Analyzing CI failure with AI...
          </div>
        </div>
      `;
    }

    if (!this.ciExplanation) return nothing;
    const { checkName, rootCause, failingStep, suggestedFix, relevantFiles } =
      this.ciExplanation;

    return html`
      <div class="ai-card" data-testid="ai-ci-explanation-section">
        <div class="ai-card-header">
          <div class="ai-card-title-row">
            <span class="ai-card-title">
              CI Failure Diagnosis: ${checkName}
            </span>
            ${failingStep
              ? html`
                  <span
                    class="finding-location"
                    data-testid="ai-ci-failing-step"
                  >
                    ${failingStep}
                  </span>
                `
              : nothing}
          </div>
          <button
            class="btn btn-xs"
            data-testid="ai-ci-dismiss-btn"
            @click=${this.handleDismissCi}
          >
            Dismiss
          </button>
        </div>

        <div class="ci-section-label">Root Cause</div>
        <div class="ai-summary" data-testid="ai-ci-root-cause">
          ${rootCause}
        </div>

        <div class="ci-section-label">Suggested Fix</div>
        <div class="ai-summary" data-testid="ai-ci-suggested-fix">
          ${suggestedFix}
        </div>

        ${relevantFiles.length > 0
          ? html`
              <div class="ci-section-label">Relevant Files</div>
              <div class="ci-files" data-testid="ai-ci-relevant-files">
                ${relevantFiles.map(
                  (file) => html`<span class="finding-location">${file}</span>`,
                )}
              </div>
            `
          : nothing}
      </div>
    `;
  }

  render() {
    const hasContent =
      this.reviewLoading ||
      this.reviewResult ||
      this.patchLoading ||
      this.patchPreview ||
      this.ciLoading ||
      this.ciExplanation ||
      this.error;

    if (!hasContent) return nothing;

    return html`
      <div class="ai-panel" @click=${(e: Event) => e.stopPropagation()}>
        ${this.error
          ? html`<div class="ai-error" data-testid="ai-review-error">${this.error}</div>`
          : nothing}
        ${this.renderBranchReview()}
        ${this.renderPatchPreview()}
        ${this.renderCiExplanation()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-ai-review-panel': GnAiReviewPanel;
  }
}
