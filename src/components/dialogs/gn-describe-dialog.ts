/**
 * Describe Commit Dialog
 * Names a commit after the most recent tag reachable from it (git describe)
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { describeCommit } from '../../services/git.service.ts';
import { showToast } from '../../services/notification.service.ts';
import type { DescribeResult } from '../../types/api.types.ts';
import './gn-modal.ts';
import type { GnModal } from './gn-modal.ts';

@customElement('gn-describe-dialog')
export class GnDescribeDialog extends LitElement {
  static styles = [
    sharedStyles,
    css`
      .body {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        min-width: 440px;
        max-width: 560px;
      }

      .target {
        display: flex;
        align-items: baseline;
        gap: var(--spacing-sm);
        padding-bottom: var(--spacing-sm);
        border-bottom: 1px solid var(--color-border);
      }

      .target-oid {
        font-family: var(--font-mono);
        font-size: var(--font-size-sm);
        color: var(--color-primary);
        flex-shrink: 0;
      }

      .target-summary {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .option {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .option input {
        accent-color: var(--color-primary);
      }

      .result-line {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-md);
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }

      .description {
        flex: 1;
        font-family: var(--font-mono);
        font-size: var(--font-size-md);
        color: var(--color-text-primary);
        word-break: break-all;
        user-select: text;
      }

      .fields {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--spacing-xs) var(--spacing-md);
        align-items: center;
        font-size: var(--font-size-sm);
      }

      .field-label {
        color: var(--color-text-secondary);
      }

      .field-value {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        color: var(--color-text-primary);
        user-select: text;
      }

      .field-value.mono {
        font-family: var(--font-mono);
      }

      .copy-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        cursor: pointer;
      }

      .copy-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .copy-btn.icon-only {
        padding: 2px 4px;
        border-color: transparent;
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-xl) 0;
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
      }

      .spinner {
        width: 16px;
        height: 16px;
        border: 2px solid var(--color-border);
        border-top-color: var(--color-primary);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-lg) var(--spacing-md);
        text-align: center;
      }

      .empty-state svg {
        color: var(--color-text-muted);
      }

      .empty-title {
        font-size: var(--font-size-md);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
      }

      .empty-text {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        line-height: 1.5;
      }

      .empty-hint {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        line-height: 1.5;
      }

      .error-message {
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-bg-error, rgba(255, 0, 0, 0.08));
        border: 1px solid var(--color-border-error, rgba(255, 0, 0, 0.3));
        border-radius: var(--radius-sm);
        color: var(--color-text-error, #ff6b6b);
        font-size: var(--font-size-sm);
      }

      .footer-actions {
        display: flex;
        gap: var(--spacing-sm);
      }
    `,
  ];

  @property({ type: String }) repositoryPath = '';

  /**
   * The repo captured at open(). `repositoryPath` is bound live to the ACTIVE
   * repository, so a tab switch while this dialog is up would otherwise make
   * the "Include lightweight tags" re-run describe a commit that does not
   * exist in the repo now in front of the user.
   */
  private pinnedRepoPath = '';
  private isOpen = false;

  /**
   * Bumped whenever the answer on screen stops being the one we are waiting
   * for — a new run, and every close. `describeCommit` is a round trip, so
   * without this a slow reply for the commit the dialog USED to show lands on
   * top of the commit it shows now: close it on A, reopen it on B, and A's
   * late reply repaints B's heading with A's tag. A reply whose generation has
   * been superseded is dropped instead.
   */
  private requestGeneration = 0;

  /** The pinned repo while open, else null — the host's tab-close sweep. */
  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.isOpen ? this.pinnedRepoPath : null;
  }

  /**
   * Describe reads; it writes nothing. Dismissing it mid-request strands no
   * work, so the sweep is always free to take its dismissal branch.
   */
  public get operationInFlight(): boolean {
    return false;
  }

  /** Commitish being described. Empty means HEAD. */
  @state() private target = '';
  /** Commit subject, when the caller had one (the graph context menu does). */
  @state() private targetSummary = '';
  @state() private includeLightweight = false;
  @state() private result: DescribeResult | null = null;
  @state() private isLoading = false;
  @state() private error = '';
  /**
   * Nothing tags this commit. Kept apart from `error` because in a repository
   * that has not been tagged yet it is the ordinary answer for every commit,
   * and rendering it in red would read as a fault the user has to fix.
   */
  @state() private noTags = false;

  @query('gn-modal') private modal!: GnModal;

  /**
   * @param commitish - Commit to describe; omit for HEAD
   * @param summary - Commit subject to show alongside it, when known
   */
  public open(commitish?: string, summary?: string): void {
    // Re-entering from a second entry point (context menu, then palette) must
    // re-aim at the new commit rather than leaving the previous answer up
    // under a heading naming a different commit.
    this.reset();
    this.target = commitish ?? '';
    this.targetSummary = summary ?? '';
    this.isOpen = true;
    this.modal.open = true;
    void this.runDescribe();
  }

  public close(): void {
    this.markClosed();
    this.modal.open = false;
  }

  /** Closed by any route: drop whatever describe is still in flight for it. */
  private markClosed(): void {
    this.isOpen = false;
    this.requestGeneration++;
  }

  private reset(): void {
    this.target = '';
    this.targetSummary = '';
    this.includeLightweight = false;
    this.result = null;
    this.error = '';
    this.noTags = false;
    this.isLoading = false;
    this.pinnedRepoPath = this.repositoryPath;
  }

  private async runDescribe(): Promise<void> {
    const generation = ++this.requestGeneration;
    this.isLoading = true;
    this.error = '';
    this.noTags = false;
    this.result = null;

    const response = await describeCommit(this.pinnedRepoPath, {
      commitish: this.target || undefined,
      tags: this.includeLightweight,
      // --dirty is rejected outright when a commit-ish is given, and the
      // question here is about the commit, not the working tree.
      dirty: false,
    });

    // Superseded while we waited: this answer is about a commit, a tag mode or
    // a dialog session that is no longer on screen. Leave the current one be.
    if (generation !== this.requestGeneration) return;

    if (response.success && response.data) {
      this.result = response.data;
    } else if (response.error?.code === 'NO_TAGS_REACHABLE') {
      this.noTags = true;
    } else {
      this.error = response.error?.message ?? 'Failed to describe this commit';
    }

    this.isLoading = false;
  }

  private handleLightweightToggle(e: Event): void {
    this.includeLightweight = (e.target as HTMLInputElement).checked;
    void this.runDescribe();
  }

  private async copy(text: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${label} copied to clipboard`, 'success');
    } catch {
      showToast(`Failed to copy ${label.toLowerCase()} to clipboard`, 'error');
    }
  }

  /**
   * The empty state's way out: tagging the commit is what makes describe able
   * to name it. The host closes this dialog and opens the create-tag one on
   * the same commit, so the user is not left re-finding the commit by hand.
   */
  private handleCreateTag(): void {
    const target = this.target;
    // The pinned repo travels with the target. `target` is an oid in THIS
    // repository, and the host's create-tag dialog is bound live to the active
    // tab — so after a tab switch the host would otherwise tag a commit that
    // only exists here onto whichever repository happens to be in front.
    const repositoryPath = this.pinnedRepoPath;
    this.close();
    this.dispatchEvent(
      new CustomEvent('describe-create-tag', {
        detail: { target, repositoryPath },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private renderTargetHeader() {
    const oid = this.target ? this.target.substring(0, 7) : 'HEAD';
    return html`
      <div class="target">
        <span class="target-oid">${oid}</span>
        ${this.targetSummary
          ? html`<span class="target-summary" title=${this.targetSummary}>${this.targetSummary}</span>`
          : nothing}
      </div>
    `;
  }

  private renderResult(result: DescribeResult) {
    const distance = result.commitsAhead ?? 0;
    return html`
      <div class="result-line">
        <span class="description">${result.description}</span>
        <button class="copy-btn" @click=${() => void this.copy(result.description, 'Description')}>
          ${this.copyIcon()}
          Copy
        </button>
      </div>
      <div class="fields">
        <span class="field-label">Tag</span>
        <span class="field-value mono">
          ${result.tag ?? '—'}
          ${result.tag
            ? html`
                <button
                  class="copy-btn icon-only"
                  title="Copy tag"
                  @click=${() => void this.copy(result.tag as string, 'Tag')}
                >
                  ${this.copyIcon()}
                </button>
              `
            : nothing}
        </span>

        <span class="field-label">Commits since tag</span>
        <span class="field-value">
          ${distance === 0 ? 'On the tag exactly' : `${distance} commit${distance === 1 ? '' : 's'}`}
        </span>

        <span class="field-label">Commit</span>
        <span class="field-value mono">
          ${result.commitHash ?? '—'}
          ${result.commitHash
            ? html`
                <button
                  class="copy-btn icon-only"
                  title="Copy commit hash"
                  @click=${() => void this.copy(result.commitHash as string, 'Commit hash')}
                >
                  ${this.copyIcon()}
                </button>
              `
            : nothing}
        </span>

        ${result.isDirty
          ? html`
              <span class="field-label">Working tree</span>
              <span class="field-value">Has uncommitted changes</span>
            `
          : nothing}
      </div>
    `;
  }

  private renderNoTags() {
    return html`
      <div class="empty-state">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"></path>
          <line x1="7" y1="7" x2="7.01" y2="7"></line>
        </svg>
        <span class="empty-title">No tags reachable from this commit</span>
        <span class="empty-text">
          Describe names a commit after the most recent tag below it in history.
          Nothing on or before this commit is tagged yet.
        </span>
        ${!this.includeLightweight
          ? html`
              <span class="empty-hint">
                Only annotated tags are matched — turn on “Include lightweight tags” to match those too.
              </span>
            `
          : nothing}
        <button class="btn btn-secondary" @click=${this.handleCreateTag}>Create a tag here</button>
      </div>
    `;
  }

  private copyIcon() {
    return html`
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/>
        <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/>
      </svg>
    `;
  }

  render() {
    return html`
      <gn-modal modalTitle="Describe Commit" @close=${() => { this.markClosed(); }}>
        <div class="body">
          ${this.renderTargetHeader()}

          <label class="option">
            <input
              type="checkbox"
              .checked=${this.includeLightweight}
              ?disabled=${this.isLoading}
              @change=${this.handleLightweightToggle}
            />
            Include lightweight tags
          </label>

          ${this.isLoading
            ? html`
                <div class="loading">
                  <div class="spinner"></div>
                  Describing commit…
                </div>
              `
            : nothing}

          ${!this.isLoading && this.error
            ? html`
                <div class="error-message">${this.error}</div>
                <button class="btn btn-secondary" @click=${() => void this.runDescribe()}>Try again</button>
              `
            : nothing}

          ${!this.isLoading && this.noTags ? this.renderNoTags() : nothing}

          ${!this.isLoading && this.result ? this.renderResult(this.result) : nothing}
        </div>

        <div slot="footer" class="footer-actions">
          <button class="btn btn-secondary" @click=${this.close}>Close</button>
        </div>
      </gn-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-describe-dialog': GnDescribeDialog;
  }
}
