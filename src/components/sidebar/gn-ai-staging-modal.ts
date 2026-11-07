import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import '../dialogs/gn-modal.ts';
import * as gitService from '../../services/git.service.ts';
import {
  suggestHunkSplits,
  stageHunkGroup,
  suggestFixupTargets,
  type AiHunkSplitGroup,
  type FixupTargetSuggestion,
} from '../../services/ai-staging.service.ts';
import { showToast } from '../../services/notification.service.ts';

export type AiStagingMode = 'hunk-split' | 'fixup';

/**
 * Modal component for Hunk-Level AI Staging (#619) and AI Fixup Target Suggestions (#620).
 */
@customElement('gn-ai-staging-modal')
export class GnAiStagingModal extends LitElement {
  static styles = [
    sharedStyles,
    css`
      .modal-body {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        width: 580px;
        max-width: 85vw;
        min-height: 260px;
      }

      .tabs {
        display: flex;
        gap: var(--spacing-xs);
        border-bottom: 1px solid var(--color-border);
        padding-bottom: var(--spacing-xs);
      }

      .tab-btn {
        padding: var(--spacing-xs) var(--spacing-md);
        border: 1px solid transparent;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .tab-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .tab-btn.active {
        background: var(--color-bg-tertiary);
        border-color: var(--color-primary);
        color: var(--color-text-primary);
      }

      .loading-state,
      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xl);
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        text-align: center;
        gap: var(--spacing-sm);
      }

      .error-banner {
        padding: var(--spacing-sm);
        background: var(--color-error-bg);
        border: 1px solid var(--color-error);
        border-radius: var(--radius-sm);
        color: var(--color-error);
        font-size: var(--font-size-xs);
      }

      .cards-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        max-height: 440px;
        overflow-y: auto;
      }

      .card {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        padding: var(--spacing-sm) var(--spacing-md);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-primary);
      }

      .card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-sm);
      }

      .card-title {
        font-family: var(--font-mono);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
        word-break: break-word;
      }

      .card-subtitle {
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .badges {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-xs);
        align-items: center;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        padding: 2px 6px;
        border-radius: var(--radius-sm);
        font-size: 10px;
        font-weight: 600;
        background: var(--color-bg-tertiary);
        color: var(--color-text-secondary);
      }

      .badge.confidence-high {
        background: var(--color-success-bg);
        color: var(--color-success);
      }

      .badge.confidence-medium {
        background: var(--color-warning-bg);
        color: var(--color-warning);
      }

      .badge.confidence-low {
        background: var(--color-bg-tertiary);
        color: var(--color-text-muted);
      }

      .badge.oid {
        font-family: var(--font-mono);
      }

      .hunk-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-top: 4px;
      }

      .hunk-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 4px 8px;
        border-radius: var(--radius-sm);
        background: var(--color-bg-secondary);
        font-size: 11px;
      }

      .hunk-meta {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        font-family: var(--font-mono);
        color: var(--color-text-primary);
      }

      .hunk-header-tag {
        color: var(--color-accent, #4fc3f7);
        font-size: 10px;
      }

      .hunk-summary {
        color: var(--color-text-secondary);
        font-size: 10px;
      }

      .action-btn {
        padding: 4px 10px;
        border: 1px solid var(--color-primary);
        border-radius: var(--radius-sm);
        background: var(--color-primary);
        color: var(--color-text-inverse);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        white-space: nowrap;
        transition: all var(--transition-fast);
      }

      .action-btn:hover:not(:disabled) {
        background: var(--color-primary-hover);
      }

      .action-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .secondary-btn {
        padding: 4px 10px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        cursor: pointer;
      }

      .secondary-btn:hover:not(:disabled) {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: String }) repositoryPath = '';
  @property({ type: Number }) stagedCount = 0;
  @property({ type: String }) mode: AiStagingMode = 'hunk-split';

  @state() private hunkGroups: AiHunkSplitGroup[] = [];
  @state() private fixupTargets: FixupTargetSuggestion[] = [];
  @state() private loading = false;
  @state() private applyingIndex: number | null = null;
  @state() private error: string | null = null;

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has('open') && this.open) {
      void this.loadCurrentMode();
    } else if (changed.has('mode') && this.open) {
      void this.loadCurrentMode();
    }
  }

  public async openWithMode(mode: AiStagingMode): Promise<void> {
    this.mode = mode;
    this.open = true;
    await this.loadCurrentMode();
  }

  public close(): void {
    this.open = false;
    this.error = null;
    this.dispatchEvent(
      new CustomEvent('close', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async switchMode(mode: AiStagingMode): Promise<void> {
    if (this.mode === mode && !this.error) return;
    this.mode = mode;
    await this.loadCurrentMode();
  }

  public async loadCurrentMode(): Promise<void> {
    if (!this.repositoryPath) return;

    this.loading = true;
    this.error = null;

    try {
      if (this.mode === 'hunk-split') {
        const result = await suggestHunkSplits(this.repositoryPath);
        if (result.success && result.data) {
          this.hunkGroups = result.data;
        } else {
          this.hunkGroups = [];
          this.error = result.error?.message ?? 'Failed to suggest hunk splits';
        }
      } else {
        const result = await suggestFixupTargets(this.repositoryPath);
        if (result.success && result.data) {
          this.fixupTargets = result.data;
        } else {
          this.fixupTargets = [];
          this.error = result.error?.message ?? 'Failed to suggest fixup targets';
        }
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Unexpected error';
    } finally {
      this.loading = false;
    }
  }

  private async handleStageHunkGroup(group: AiHunkSplitGroup, index: number): Promise<void> {
    if (!this.repositoryPath || this.applyingIndex !== null) return;

    this.applyingIndex = index;
    this.error = null;

    try {
      const result = await stageHunkGroup(this.repositoryPath, group.hunks);
      if (result.success) {
        const stagedCount = result.data ?? group.hunks.length;
        showToast(
          `Staged ${stagedCount} ${stagedCount === 1 ? 'hunk' : 'hunks'} for "${group.commitMessage}"`,
          'success',
        );
        this.dispatchEvent(
          new CustomEvent('staging-changed', {
            detail: {
              group,
              stagedCount,
              commitMessage: group.commitMessage,
              description: group.description,
            },
            bubbles: true,
            composed: true,
          }),
        );
        window.dispatchEvent(new CustomEvent('status-refresh'));
        await this.loadCurrentMode();
      } else {
        const message = result.error?.message ?? 'Failed to stage hunk group';
        this.error = message;
        showToast(message, 'error');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to stage hunk group';
      this.error = message;
      showToast(message, 'error');
    } finally {
      this.applyingIndex = null;
    }
  }

  private async handleCreateFixupCommit(
    target: FixupTargetSuggestion,
    index: number,
  ): Promise<void> {
    if (!this.repositoryPath || this.applyingIndex !== null) return;

    this.applyingIndex = index;
    this.error = null;

    const fixupMessage = `fixup! ${target.commitSummary}`;

    try {
      if (this.stagedCount === 0 && target.overlappingFiles.length > 0) {
        const stageResult = await gitService.stageFiles(this.repositoryPath, {
          paths: target.overlappingFiles,
        });
        if (!stageResult.success) {
          const message =
            stageResult.error?.message ?? 'Failed to stage overlapping files for fixup';
          this.error = message;
          showToast(message, 'error');
          return;
        }
      }

      const result = await gitService.createCommit(this.repositoryPath, {
        message: fixupMessage,
        amend: false,
      });

      if (result.success) {
        showToast(`Created fixup commit for ${target.shortOid}`, 'success');
        this.dispatchEvent(
          new CustomEvent('commit-created', {
            detail: {
              commit: result.data,
              repositoryPath: this.repositoryPath,
              fixupTarget: target,
            },
            bubbles: true,
            composed: true,
          }),
        );
        this.dispatchEvent(
          new CustomEvent('staging-changed', {
            detail: { fixupTarget: target },
            bubbles: true,
            composed: true,
          }),
        );
        window.dispatchEvent(new CustomEvent('status-refresh'));
        window.dispatchEvent(
          new CustomEvent('repository-refresh', {
            detail: { repoPath: this.repositoryPath },
          }),
        );
        this.close();
      } else {
        const message = result.error?.message ?? 'Failed to create fixup commit';
        this.error = message;
        showToast(message, 'error');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create fixup commit';
      this.error = message;
      showToast(message, 'error');
    } finally {
      this.applyingIndex = null;
    }
  }

  private confidenceClass(confidence: number): string {
    if (confidence >= 0.7) return 'confidence-high';
    if (confidence >= 0.45) return 'confidence-medium';
    return 'confidence-low';
  }

  private renderHunkSplitTab() {
    if (this.loading) {
      return html`<div class="loading-state">Analyzing diff hunks for atomic commit groups...</div>`;
    }

    if (this.hunkGroups.length === 0) {
      return html`
        <div class="empty-state">
          <span>No diff hunks available to split.</span>
        </div>
      `;
    }

    return html`
      <div class="cards-list" role="list" aria-label="Suggested hunk split groups">
        ${this.hunkGroups.map(
          (group, idx) => html`
            <div class="card hunk-group-card" role="listitem">
              <div class="card-header">
                <span class="card-title">${group.commitMessage}</span>
                <button
                  class="action-btn stage-hunk-group-btn"
                  ?disabled=${this.applyingIndex !== null}
                  @click=${() => this.handleStageHunkGroup(group, idx)}
                >
                  ${this.applyingIndex === idx
                    ? 'Staging...'
                    : 'Stage Hunks & Fill Message'}
                </button>
              </div>
              <div class="card-subtitle">${group.description}</div>
              <div class="hunk-list">
                ${group.hunks.map(
                  (hunk) => html`
                    <div class="hunk-item">
                      <div class="hunk-meta">
                        <span>${hunk.filePath}</span>
                        <span class="badge">#${hunk.hunkIndex}</span>
                        <span class="hunk-header-tag">${hunk.header}</span>
                      </div>
                      ${hunk.summary
                        ? html`<div class="hunk-summary">${hunk.summary}</div>`
                        : nothing}
                    </div>
                  `,
                )}
              </div>
            </div>
          `,
        )}
      </div>
    `;
  }

  private renderFixupTab() {
    if (this.loading) {
      return html`<div class="loading-state">Analyzing recent commits for fixup targets...</div>`;
    }

    if (this.fixupTargets.length === 0) {
      return html`
        <div class="empty-state">
          <span>No matching recent commits found for fixup targeting.</span>
        </div>
      `;
    }

    return html`
      <div class="cards-list" role="list" aria-label="Suggested fixup targets">
        ${this.fixupTargets.map(
          (target, idx) => html`
            <div class="card fixup-target-card" role="listitem">
              <div class="card-header">
                <span class="card-title">${target.commitSummary}</span>
                <button
                  class="action-btn create-fixup-btn"
                  ?disabled=${this.applyingIndex !== null}
                  @click=${() => this.handleCreateFixupCommit(target, idx)}
                >
                  ${this.applyingIndex === idx
                    ? 'Creating...'
                    : this.stagedCount === 0 && target.overlappingFiles.length > 0
                      ? 'Stage & Create fixup! Commit'
                      : 'Create fixup! Commit'}
                </button>
              </div>
              <div class="badges">
                <span class="badge oid">${target.shortOid}</span>
                <span class="badge ${this.confidenceClass(target.confidence)}">
                  ${Math.round(target.confidence * 100)}% confidence
                </span>
                <span class="badge overlap-hunks-badge">
                  ${target.overlappingHunks} overlapping
                  ${target.overlappingHunks === 1 ? 'hunk' : 'hunks'}
                </span>
                <span class="badge overlap-files-badge">
                  ${target.overlappingFiles.join(', ')}
                </span>
                ${target.author
                  ? html`<span class="badge">${target.author}</span>`
                  : nothing}
              </div>
              <div class="card-subtitle">${target.rationale}</div>
            </div>
          `,
        )}
      </div>
    `;
  }

  render() {
    const title =
      this.mode === 'hunk-split'
        ? 'AI Hunk Split & Staging'
        : 'Suggest Fixup Target';

    return html`
      <gn-modal .open=${this.open} .modalTitle=${title} @close=${this.close}>
        <div class="modal-body">
          <div class="tabs" role="tablist">
            <button
              role="tab"
              aria-selected=${this.mode === 'hunk-split' ? 'true' : 'false'}
              class="tab-btn tab-hunk-split ${this.mode === 'hunk-split' ? 'active' : ''}"
              @click=${() => this.switchMode('hunk-split')}
            >
              Hunk Split
            </button>
            <button
              role="tab"
              aria-selected=${this.mode === 'fixup' ? 'true' : 'false'}
              class="tab-btn tab-fixup ${this.mode === 'fixup' ? 'active' : ''}"
              @click=${() => this.switchMode('fixup')}
            >
              Suggest Fixup Target
            </button>
          </div>

          ${this.error
            ? html`<div class="error-banner" role="alert">${this.error}</div>`
            : nothing}

          ${this.mode === 'hunk-split'
            ? this.renderHunkSplitTab()
            : this.renderFixupTab()}
        </div>
        <div slot="footer">
          <button
            class="secondary-btn"
            ?disabled=${this.loading}
            @click=${() => this.loadCurrentMode()}
          >
            Refresh
          </button>
          <button class="secondary-btn" @click=${this.close}>Close</button>
        </div>
      </gn-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-ai-staging-modal': GnAiStagingModal;
  }
}
