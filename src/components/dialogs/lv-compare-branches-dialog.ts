/**
 * Compare Branches Dialog
 *
 * Read-only view over `compare_branches`: pick a base and a compare ref and
 * see how they relate — ahead/behind counts, merge base, the commits on each
 * side and the files that differ.
 *
 * The comparison mutates nothing, so this dialog takes no ref lock and emits
 * no `*-changed` event. Its only outbound event is `show-commit`, which
 * app-shell already listens for, so a commit row is a route into the graph
 * rather than a dead end.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import type { BranchComparison, CompareCommit, ChangedFile } from '../../services/git.service.ts';
import type { Branch } from '../../types/git.types.ts';
import { containsDeepActiveElement } from '../../utils/focus.ts';
import type { LvModal } from './lv-modal.ts';
import './lv-modal.ts';

/** A ref the branch list does not contain, with the label to show for it. */
export interface CompareExtraRef {
  ref: string;
  label: string;
}

export interface CompareOpenOptions {
  /** Preselect the base (left) side. */
  baseRef?: string;
  /** Preselect the compare (right) side. */
  compareRef?: string;
  /**
   * Refs that are not branches — commit oids from the graph's multi-selection
   * — added to both pickers so this dialog can compare things the branch list
   * does not contain. `compare_branches` resolves whatever it is given with
   * `revparse_single`, so an oid is as valid a side as a branch name.
   */
  extraRefs?: CompareExtraRef[];
}

@customElement('lv-compare-branches-dialog')
export class LvCompareBranchesDialog extends LitElement {
  static styles = [
    sharedStyles,
    css`
      .form {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        width: 720px;
        max-width: 100%;
      }

      .refs {
        display: flex;
        align-items: flex-end;
        gap: var(--spacing-md);
      }

      .field {
        display: flex;
        flex: 1;
        min-width: 0;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .field label {
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
      }

      .field select {
        padding: var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
      }

      .field select:disabled {
        background: var(--color-bg-tertiary);
        cursor: not-allowed;
      }

      .swap-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        flex: none;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-primary);
        color: var(--color-text-secondary);
        cursor: pointer;
      }

      .swap-btn:hover:not(:disabled) {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .swap-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .swap-btn svg {
        width: 16px;
        height: 16px;
      }

      .error-message {
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-error-bg);
        border: 1px solid var(--color-error);
        border-radius: var(--radius-md);
        color: var(--color-error);
        font-size: var(--font-size-sm);
      }

      .status {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-xl);
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
        text-align: center;
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

      .summary {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-md);
        padding: var(--spacing-md);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-tertiary);
      }

      .stat {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .stat-label {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .stat-value {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
        font-family: var(--font-family-mono);
      }

      .additions { color: var(--color-success); }
      .deletions { color: var(--color-error); }

      .section-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
      }

      .list {
        display: flex;
        flex-direction: column;
        max-height: 180px;
        overflow-y: auto;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }

      .row {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        width: 100%;
        padding: var(--spacing-xs) var(--spacing-sm);
        border: none;
        border-bottom: 1px solid var(--color-border);
        background: transparent;
        color: var(--color-text-primary);
        font-size: var(--font-size-xs);
        text-align: left;
      }

      .row:last-child { border-bottom: none; }

      button.row { cursor: pointer; }
      button.row:hover { background: var(--color-bg-hover); }

      .oid {
        font-family: var(--font-family-mono);
        color: var(--color-primary);
        flex: none;
      }

      .row-text {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .row-meta {
        flex: none;
        color: var(--color-text-muted);
      }

      .file-status {
        flex: none;
        width: 1.2em;
        text-align: center;
        font-family: var(--font-family-mono);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-secondary);
      }
    `,
  ];

  /** Live-bound to the active tab; pinned at open() so a tab switch mid-run
   * cannot retarget the comparison at another repository. */
  @property({ type: String }) repositoryPath = '';

  private pinnedRepoPath = '';

  /**
   * Bumped on every open and every close. Each read captures it before its
   * await and drops its result if it no longer matches, so a response for the
   * repository the dialog was closed on cannot land in a dialog that has
   * since reopened against a different tab.
   */
  private openGeneration = 0;
  private isOpen = false;

  @state() private branches: Branch[] = [];
  /** Non-branch refs the caller asked to compare (commit oids from the graph). */
  @state() private extraRefs: CompareExtraRef[] = [];
  @state() private baseRef = '';
  @state() private compareRef = '';
  @state() private loadingBranches = false;
  @state() private comparing = false;
  @state() private error = '';
  @state() private comparison: BranchComparison | null = null;

  @query('lv-modal') private modal!: LvModal;
  @query('#compare-ref-select') private compareSelect?: HTMLSelectElement;

  /**
   * Always false, and deliberately so.
   *
   * The sweep reads this to decide whether closing a dialog would strand a
   * running operation behind a "cancelled" toast — and it mirrors the flag the
   * dialog's own dismissal guard refuses on. This dialog only ever reads, so
   * it refuses no dismissal and a close mid-request strands nothing: the
   * in-flight comparison resolves into a dialog nobody is looking at. Claiming
   * work is running would make the sweep leave a dead dialog on screen and say
   * the comparison "cannot be stopped".
   */
  public get operationInFlight(): boolean {
    return false;
  }

  /** The pinned repo while open, else null — lets the host close this dialog
   * when the tab it was opened against goes away. */
  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.isOpen ? this.pinnedRepoPath : null;
  }

  /**
   * @param target Either the ref to preselect on the compare side (e.g. the
   * branch whose context menu was used — base defaults to the current
   * branch), or an options object naming both sides and any non-branch refs
   * they need (the graph's "Compare these commits" hands over two oids).
   */
  public open(target?: string | CompareOpenOptions): void {
    const opts: CompareOpenOptions =
      typeof target === 'string' ? { compareRef: target } : (target ?? {});

    // Re-entry while already open must not wipe a selection the user made:
    // the command palette fires even while the dialog has focus. Re-aim only
    // if a new target was named.
    if (this.isOpen) {
      if (opts.compareRef || opts.baseRef) {
        this.addExtraRefs(opts.extraRefs);
        if (opts.baseRef) this.baseRef = opts.baseRef;
        if (opts.compareRef) this.compareRef = opts.compareRef;
        this.resolveBaseCollision();
        this.comparison = null;
        this.error = '';
      }
      this.compareSelect?.focus();
      return;
    }

    this.reset();
    this.openGeneration++;
    this.pinnedRepoPath = this.repositoryPath;
    this.isOpen = true;
    this.addExtraRefs(opts.extraRefs);
    if (opts.baseRef) {
      this.baseRef = opts.baseRef;
    }
    if (opts.compareRef) {
      this.compareRef = opts.compareRef;
    }

    void this.updateComplete.then(() => {
      if (!this.isOpen) return;
      this.modal.open = true;
      requestAnimationFrame(() => {
        if (!this.isOpen) return;
        if (containsDeepActiveElement(this)) return;
        this.compareSelect?.focus();
      });
      void this.loadBranches();
    });
  }

  public close(): void {
    this.isOpen = false;
    this.openGeneration++;
    if (this.modal) this.modal.open = false;
  }

  /**
   * Push the selected refs onto the <select> elements after their <option>
   * children exist. A `.value` binding on the select itself commits BEFORE
   * lit renders the options, so it lands on an empty list and is discarded —
   * the pickers then showed the first branch while the dialog compared the
   * one the caller actually asked for.
   */
  updated(): void {
    const base = this.renderRoot.querySelector('#base-ref-select') as HTMLSelectElement | null;
    if (base && base.value !== this.baseRef) base.value = this.baseRef;
    const compare = this.renderRoot.querySelector(
      '#compare-ref-select',
    ) as HTMLSelectElement | null;
    if (compare && compare.value !== this.compareRef) compare.value = this.compareRef;
  }

  private reset(): void {
    this.branches = [];
    this.extraRefs = [];
    this.baseRef = '';
    this.compareRef = '';
    this.loadingBranches = false;
    this.comparing = false;
    this.error = '';
    this.comparison = null;
  }

  /**
   * Move `baseRef` off `compareRef` when a re-aim collides them, picking the
   * first other loaded branch. Shared with the initial branch load's own
   * collision correction so base/compare cannot silently become equal on
   * either path — a re-entry that names the branch already on the base
   * picker would otherwise leave both pickers on the same ref and Compare
   * permanently disabled with no explanation.
   */
  private resolveBaseCollision(): void {
    if (this.baseRef !== this.compareRef) return;
    this.baseRef =
      this.selectableRefs.find((r) => r.value !== this.compareRef)?.value ?? this.baseRef;
  }

  /** Merge caller-supplied non-branch refs in, keeping them unique. */
  private addExtraRefs(extra?: CompareExtraRef[]): void {
    if (!extra || extra.length === 0) return;
    const merged = [...this.extraRefs];
    for (const candidate of extra) {
      if (!merged.some((r) => r.ref === candidate.ref)) merged.push(candidate);
    }
    this.extraRefs = merged;
  }

  /**
   * Everything the two pickers offer: the caller's extra refs first (they are
   * what the dialog was opened FOR), then the branches. Every "is there
   * anything to compare" test reads this rather than `branches`, or a
   * commit-to-commit comparison in a single-branch repository would render
   * with both pickers disabled and a "nothing to compare" message over two
   * refs it can compare perfectly well.
   */
  private get selectableRefs(): Array<{ value: string; label: string }> {
    return [
      ...this.extraRefs.map((r) => ({ value: r.ref, label: r.label })),
      ...this.branches.map((b) => ({
        value: b.name,
        label: `${b.name}${b.isHead ? ' (current)' : ''}`,
      })),
    ];
  }

  /**
   * Fill the two pickers. Without a branch list there is nothing to compare,
   * so a failure here is shown in the dialog rather than only logged — the
   * dialog stays open, so the message goes inline like every other field
   * error in this component.
   */
  private async loadBranches(): Promise<void> {
    const repoPath = this.pinnedRepoPath;
    if (!repoPath) return;

    const generation = this.openGeneration;
    this.loadingBranches = true;
    this.error = '';

    try {
      const result = await gitService.getBranches(repoPath);
      if (generation !== this.openGeneration) return;
      if (result.success && result.data) {
        this.branches = result.data;
        const head = result.data.find((b) => b.isHead);
        // Base defaults to the branch the user is on: "how does that branch
        // relate to mine" is the question the context-menu entry asks.
        if (!this.baseRef) {
          this.baseRef = head?.name ?? result.data[0]?.name ?? '';
        }
        if (!this.compareRef) {
          this.compareRef =
            result.data.find((b) => b.name !== this.baseRef)?.name ?? this.baseRef;
        } else if (this.compareRef === this.baseRef) {
          // The caller can hand us the branch that is ALSO the default base.
          // Two identical pickers over a permanently disabled Compare button
          // is a dead end, so move the base off it instead.
          this.resolveBaseCollision();
        }
      } else {
        this.error = result.error?.message ?? 'Failed to load branches';
      }
    } catch (err) {
      if (generation !== this.openGeneration) return;
      this.error = err instanceof Error ? err.message : 'Failed to load branches';
    } finally {
      if (generation === this.openGeneration) this.loadingBranches = false;
    }
  }

  private handleBaseChange(e: Event): void {
    this.baseRef = (e.target as HTMLSelectElement).value;
    // The shown result belongs to the previous pair; leaving it up under new
    // selections reads as a comparison of refs that were never compared.
    this.comparison = null;
    this.error = '';
  }

  private handleCompareChange(e: Event): void {
    this.compareRef = (e.target as HTMLSelectElement).value;
    this.comparison = null;
    this.error = '';
  }

  private handleSwap(): void {
    if (this.comparing) return;
    const base = this.baseRef;
    this.baseRef = this.compareRef;
    this.compareRef = base;
    this.comparison = null;
    this.error = '';
  }

  private get canCompare(): boolean {
    return (
      !!this.baseRef &&
      !!this.compareRef &&
      this.baseRef !== this.compareRef &&
      !this.comparing &&
      !this.loadingBranches
    );
  }

  private async handleCompare(): Promise<void> {
    if (this.comparing) return;
    if (!this.baseRef || !this.compareRef) {
      this.error = 'Select two refs to compare';
      return;
    }
    if (this.baseRef === this.compareRef) {
      this.error = 'Select two different refs to compare';
      return;
    }

    // The repo the pickers were filled from, not the live property.
    const repoPath = this.pinnedRepoPath;
    if (!repoPath) {
      this.error = 'No repository is open';
      return;
    }

    const generation = this.openGeneration;
    this.comparing = true;
    this.error = '';
    this.comparison = null;

    try {
      const result = await gitService.compareBranches(repoPath, this.baseRef, this.compareRef, {
        includeCommits: true,
        includeFiles: true,
      });
      if (generation !== this.openGeneration) return;
      if (result.success && result.data) {
        this.comparison = result.data;
      } else {
        this.error = result.error?.message ?? 'Failed to compare refs';
      }
    } catch (err) {
      if (generation !== this.openGeneration) return;
      this.error = err instanceof Error ? err.message : 'Failed to compare refs';
    } finally {
      if (generation === this.openGeneration) this.comparing = false;
    }
  }

  /** Reveal a commit in the graph. app-shell listens for `show-commit` and
   * reports its own miss cases, so the dialog closes out of the way. */
  private handleShowCommit(oid: string): void {
    this.dispatchEvent(
      new CustomEvent('show-commit', { detail: { oid }, bubbles: true, composed: true }),
    );
    this.close();
  }

  private handleModalClose(): void {
    // A read cannot leave the repository half-changed, so unlike the mutating
    // dialogs there is nothing to block on; just let it go.
    this.close();
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private renderCommitRow(commit: CompareCommit) {
    return html`
      <button
        class="row"
        type="button"
        title="Show ${commit.shortOid} in graph"
        @click=${() => this.handleShowCommit(commit.oid)}
      >
        <span class="oid">${commit.shortOid}</span>
        <span class="row-text">${commit.message.split('\n')[0]}</span>
        <span class="row-meta">${commit.authorName}</span>
      </button>
    `;
  }

  private renderFileRow(file: ChangedFile) {
    return html`
      <div class="row">
        <span class="file-status" title=${file.status}>${file.status.charAt(0).toUpperCase()}</span>
        <span class="row-text" title=${file.path}>
          ${file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span class="row-meta additions">+${file.additions}</span>
        <span class="row-meta deletions">-${file.deletions}</span>
      </div>
    `;
  }

  private renderResult() {
    const c = this.comparison;
    if (!c) return nothing;

    const commitsAhead = c.commitsAhead ?? [];
    const commitsBehind = c.commitsBehind ?? [];
    const files = c.filesChanged ?? [];
    // ahead/behind are the authoritative counts; the lists are only present
    // because this dialog always asks for them.
    const identical = c.ahead === 0 && c.behind === 0 && files.length === 0;

    return html`
      <div class="summary">
        <div class="stat">
          <span class="stat-label">Ahead</span>
          <span class="stat-value">${c.ahead}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Behind</span>
          <span class="stat-value">${c.behind}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Merge base</span>
          <span class="stat-value">${c.mergeBase.slice(0, 7)}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Files changed</span>
          <span class="stat-value">${files.length}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Lines</span>
          <span class="stat-value">
            <span class="additions">+${c.totalAdditions}</span>
            <span class="deletions">-${c.totalDeletions}</span>
          </span>
        </div>
      </div>

      ${identical
        ? html`<div class="status" data-testid="identical">
            ${c.compareRef} and ${c.baseRef} point at the same content — nothing to compare.
          </div>`
        : nothing}

      ${commitsAhead.length > 0
        ? html`
            <div class="section-title">
              ${commitsAhead.length} commit${commitsAhead.length === 1 ? '' : 's'} only on
              ${c.compareRef}
            </div>
            <div class="list" data-testid="commits-ahead">
              ${commitsAhead.map((commit) => this.renderCommitRow(commit))}
            </div>
          `
        : nothing}

      ${commitsBehind.length > 0
        ? html`
            <div class="section-title">
              ${commitsBehind.length} commit${commitsBehind.length === 1 ? '' : 's'} only on
              ${c.baseRef}
            </div>
            <div class="list" data-testid="commits-behind">
              ${commitsBehind.map((commit) => this.renderCommitRow(commit))}
            </div>
          `
        : nothing}

      ${files.length > 0
        ? html`
            <div class="section-title">Changed files</div>
            <div class="list" data-testid="files-changed">
              ${files.map((file) => this.renderFileRow(file))}
            </div>
          `
        : nothing}
    `;
  }

  render() {
    const selectable = this.selectableRefs;
    const options = selectable.map(
      (r) => html`<option value=${r.value}>${r.label}</option>`,
    );
    const tooFewRefs = selectable.length < 2;

    return html`
      <lv-modal modalTitle="Compare Branches" @close=${this.handleModalClose}>
        <div class="form">
          <div class="refs">
            <div class="field">
              <label for="base-ref-select">Base</label>
              <select
                id="base-ref-select"
                @change=${this.handleBaseChange}
                ?disabled=${this.loadingBranches || this.comparing || tooFewRefs}
              >
                ${options}
              </select>
            </div>

            <button
              class="swap-btn"
              type="button"
              title="Swap base and compare"
              aria-label="Swap base and compare"
              ?disabled=${this.loadingBranches || this.comparing || tooFewRefs}
              @click=${this.handleSwap}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <polyline points="17 1 21 5 17 9"></polyline>
                <path d="M3 11V9a4 4 0 014-4h14"></path>
                <polyline points="7 23 3 19 7 15"></polyline>
                <path d="M21 13v2a4 4 0 01-4 4H3"></path>
              </svg>
            </button>

            <div class="field">
              <label for="compare-ref-select">Compare</label>
              <select
                id="compare-ref-select"
                @change=${this.handleCompareChange}
                ?disabled=${this.loadingBranches || this.comparing || tooFewRefs}
              >
                ${options}
              </select>
            </div>
          </div>

          ${this.error ? html`<div class="error-message" role="alert">${this.error}</div>` : nothing}

          ${this.loadingBranches
            ? html`<div class="status"><span class="spinner"></span>Loading branches…</div>`
            : nothing}

          ${!this.loadingBranches && selectable.length === 0 && !this.error
            ? html`<div class="status" data-testid="no-branches">
                This repository has no branches to compare yet.
              </div>`
            : nothing}

          ${!this.loadingBranches && selectable.length === 1 && !this.error
            ? html`<div class="status" data-testid="single-branch">
                ${this.branches.length === 1
                  ? html`${this.branches[0].name} is the only branch here — there is nothing to
                      compare it with yet.`
                  : html`${selectable[0].label} is the only ref here — there is nothing to compare
                      it with yet.`}
              </div>`
            : nothing}

          ${this.comparing
            ? html`<div class="status"><span class="spinner"></span>Comparing…</div>`
            : nothing}

          ${!this.comparing ? this.renderResult() : nothing}
        </div>

        <div slot="footer">
          <button class="btn btn-secondary" @click=${this.handleModalClose}>Close</button>
          <button
            class="btn btn-primary"
            ?disabled=${!this.canCompare}
            @click=${this.handleCompare}
          >
            ${this.comparing ? 'Comparing…' : 'Compare'}
          </button>
        </div>
      </lv-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-compare-branches-dialog': LvCompareBranchesDialog;
  }
}
