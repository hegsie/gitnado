/**
 * Interactive Rebase Dialog Component
 * Allows users to reorder, squash, edit, and drop commits
 * with preview, reword editing, and autosquash support
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state, property, query } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showToast } from '../../services/notification.service.ts';
import './gn-modal.ts';
import type { GnModal } from './gn-modal.ts';
import type { RebaseCommit, RebaseAction } from '../../types/git.types.ts';
import {
  tryAcquireRefOp,
  releaseRefOp,
  RefLockController,
} from '../../utils/ref-lock.ts';
import { REBASE_PAUSED_MESSAGE } from '../../utils/rebase-messages.ts';

interface EditableRebaseCommit extends RebaseCommit {
  action: RebaseAction;
  /** New message for reword action */
  newMessage?: string;
}

interface PreviewCommit {
  shortId: string;
  summary: string;
  isSquashed: boolean;
  squashedFrom?: string[];
  /** Error message if this commit configuration is invalid */
  error?: string;
}

@customElement('gn-interactive-rebase-dialog')
export class GnInteractiveRebaseDialog extends LitElement {
  static styles = [
    sharedStyles,
    css`
      .form {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        min-width: 800px;
        max-width: 1000px;
      }

      .header-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-md);
      }

      .header-info {
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        font-size: var(--font-size-sm);
        flex: 1;
      }

      .header-info strong {
        color: var(--color-primary);
      }

      .commit-count {
        margin-left: var(--spacing-sm);
        color: var(--color-text-muted);
      }

      .header-actions {
        display: flex;
        gap: var(--spacing-sm);
      }

      .btn-small {
        padding: var(--spacing-xs) var(--spacing-sm);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-xs);
        cursor: pointer;
        border: 1px solid var(--color-border);
        background: var(--color-bg-secondary);
        color: var(--color-text-secondary);
        transition: all var(--transition-fast);
      }

      .btn-small:hover:not(:disabled) {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .btn-small.active {
        background: var(--color-primary-alpha);
        border-color: var(--color-primary);
        color: var(--color-primary);
      }

      .main-content {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--spacing-md);
      }

      .main-content.preview-hidden {
        grid-template-columns: 1fr;
      }

      .editor-section,
      .preview-section {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .section-title {
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .commits-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        max-height: 350px;
        overflow-y: auto;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        padding: var(--spacing-sm);
      }

      .commit-row {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm);
        background: var(--color-bg-secondary);
        border-radius: var(--radius-sm);
        cursor: grab;
      }

      .commit-row:hover {
        background: var(--color-bg-hover);
      }

      .commit-row.dragging {
        opacity: 0.5;
      }

      .commit-row.drop-target {
        border-top: 2px solid var(--color-primary);
      }

      .commit-row.action-drop {
        opacity: 0.5;
        text-decoration: line-through;
      }

      .commit-row.action-squash,
      .commit-row.action-fixup {
        border-left: 3px solid var(--color-warning);
        margin-left: var(--spacing-sm);
      }

      .commit-row.action-reword {
        border-left: 3px solid var(--color-info);
      }

      .commit-row.action-edit {
        border-left: 3px solid var(--color-success);
      }

      .drag-handle {
        color: var(--color-text-muted);
        cursor: grab;
      }

      .drag-handle svg {
        width: 16px;
        height: 16px;
      }

      .action-select {
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        min-width: 90px;
      }

      .action-select:focus {
        outline: none;
        border-color: var(--color-primary);
      }

      .action-select option {
        background: var(--color-bg-primary);
      }

      .commit-content {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        min-width: 0;
      }

      .commit-info {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .commit-hash {
        font-family: var(--font-mono);
        font-size: var(--font-size-xs);
        color: var(--color-primary);
        background: var(--color-bg-tertiary);
        padding: 2px 6px;
        border-radius: var(--radius-sm);
        flex-shrink: 0;
      }

      .commit-message {
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: var(--font-size-sm);
      }

      .reword-input {
        width: 100%;
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        font-family: inherit;
        resize: none;
      }

      .reword-input:focus {
        outline: none;
        border-color: var(--color-primary);
      }

      .reword-input::placeholder {
        color: var(--color-text-muted);
      }

      /* Preview section styles */
      .preview-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        max-height: 350px;
        overflow-y: auto;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        padding: var(--spacing-sm);
        background: var(--color-bg-tertiary);
      }

      .preview-commit {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm);
        background: var(--color-bg-secondary);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-sm);
      }

      .preview-commit.squashed {
        background: var(--color-warning-bg, rgba(234, 179, 8, 0.1));
        border-left: 3px solid var(--color-warning);
      }

      .preview-hash {
        font-family: var(--font-mono);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        background: var(--color-bg-tertiary);
        padding: 2px 6px;
        border-radius: var(--radius-sm);
      }

      .preview-message {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .squash-badge {
        font-size: var(--font-size-xs);
        color: var(--color-warning);
        background: var(--color-warning-bg, rgba(234, 179, 8, 0.1));
        padding: 1px 6px;
        border-radius: var(--radius-sm);
      }

      .preview-commit.error {
        background: var(--color-error-bg, rgba(239, 68, 68, 0.1));
        border-left: 3px solid var(--color-error);
      }

      .preview-commit.error .preview-message {
        color: var(--color-error);
      }

      .error-badge {
        font-size: var(--font-size-xs);
        color: white;
        background: var(--color-error);
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        font-weight: var(--font-weight-semibold);
      }

      .preview-empty {
        padding: var(--spacing-md);
        text-align: center;
        color: var(--color-text-muted);
        font-style: italic;
      }

      .autosquash-banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-info-bg, rgba(59, 130, 246, 0.1));
        border: 1px solid var(--color-info);
        border-radius: var(--radius-md);
        font-size: var(--font-size-sm);
      }

      .autosquash-banner button {
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-info);
        color: white;
        border: none;
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-size: var(--font-size-xs);
      }

      .autosquash-banner button:hover {
        opacity: 0.9;
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-lg);
        color: var(--color-text-muted);
      }

      .empty {
        padding: var(--spacing-lg);
        text-align: center;
        color: var(--color-text-muted);
      }

      .error-message {
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-error-bg);
        border: 1px solid var(--color-error);
        border-radius: var(--radius-md);
        color: var(--color-error);
        font-size: var(--font-size-sm);
      }

      .warning-message {
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-warning-bg, rgba(234, 179, 8, 0.1));
        border: 1px solid var(--color-warning);
        border-radius: var(--radius-md);
        color: var(--color-warning);
        font-size: var(--font-size-sm);
      }

      .help-section {
        display: flex;
        gap: var(--spacing-lg);
      }

      .help-text {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        line-height: 1.5;
        flex: 1;
      }

      .help-text ul {
        margin: var(--spacing-xs) 0 0 var(--spacing-md);
        padding: 0;
      }

      .keyboard-hints {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .keyboard-hints kbd {
        padding: 1px 4px;
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        border-radius: 3px;
        font-family: var(--font-mono);
        font-size: var(--font-size-xs);
      }

      .btn {
        padding: var(--spacing-sm) var(--spacing-lg);
        border-radius: var(--radius-md);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .btn-primary {
        background: var(--color-primary);
        color: var(--color-text-inverse);
        border: none;
      }

      .btn-primary:hover:not(:disabled) {
        background: var(--color-primary-hover);
      }

      .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-secondary {
        background: transparent;
        color: var(--color-text-secondary);
        border: 1px solid var(--color-border);
      }

      .btn-secondary:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .stats-row {
        display: flex;
        gap: var(--spacing-md);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .stat {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .stat-value {
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-secondary);
      }
    `,
  ];

  @property({ type: String }) repositoryPath = '';

  /**
   * Observe the shared working-tree lock, not just claim it.
   *
   * The handlers below already refuse when another surface holds the lock, but
   * the action buttons were bound to this dialog's own flag alone — so while a
   * checkout, reset or gc ran elsewhere they stayed lit and did nothing except
   * raise a refusal toast.
   */
  private lock = new RefLockController(this, () => this.pinnedRepoPath || this.repositoryPath);

  @state() private onto = '';
  @state() private commits: EditableRebaseCommit[] = [];
  @state() private loading = false;
  @state() private executing = false;
  @state() private error = '';
  @state() private warning = '';
  /**
   * Set when open()'s reword request was refused, so the dialog shows the
   * reason and keeps Start Rebase disabled. Two causes: the target is not in
   * the loaded plan, or the range contains merge commits a rebase would
   * flatten.
   */
  @state() private rewordRefused = false;
  /** Merge commits in the rebase range; they are excluded from the plan. */
  @state() private mergeCountInRange = 0;
  @state() private draggedIndex: number | null = null;
  @state() private dropTargetIndex: number | null = null;
  @state() private showPreview = true;
  /** Repo captured at open. This dialog is long-lived (open → reorder →
   * a separate Execute click); the reactive `repositoryPath` prop rebinds
   * the moment the user Ctrl+Tabs to another repo, so loadCommits AND the
   * history-rewriting execute must use THIS pinned value, never the live
   * prop — executing an interactive rebase against the wrong repo would
   * rewrite the wrong history. */
  private pinnedRepoPath = '';

  @query('gn-modal') private modal!: GnModal;

  /**
   * Check if there are any commits with fixup!/squash! prefixes
   */
  private get hasAutosquashCommits(): boolean {
    return this.commits.some(
      c => c.summary.startsWith('fixup! ') || c.summary.startsWith('squash! ')
    );
  }

  /**
   * Check if autosquash can be applied (fixup!/squash! commits still have action='pick')
   */
  private get canApplyAutosquash(): boolean {
    return this.commits.some(
      c => (c.summary.startsWith('fixup! ') || c.summary.startsWith('squash! ')) &&
           c.action === 'pick'
    );
  }

  public async open(onto: string, options?: { rewordCommitOid?: string }): Promise<void> {
    // A rebase already running owns this component; reset() would clear
    // `executing` and re-enable Start Rebase, allowing a second concurrent
    // execute_interactive_rebase against the same repository.
    if (this.executing) return;

    // Already open: re-entering must NOT reset. reset() discards the whole
    // rebase plan — every reorder, squash and reword the user has built. Its
    // create-tag/create-branch siblings had the same shape and the same fix;
    // this one has fewer entry points today, but the cost of hitting it is far
    // higher than a cleared text field.
    if (this.modal?.open) {
      return;
    }

    this.reset();
    this.onto = onto;
    this.pinnedRepoPath = this.repositoryPath;
    this.modal.open = true;
    await this.loadCommits();

    // Pre-select a commit for rewording if requested.
    //
    // Reassigned, not mutated in place: `commits` is @state, so mutating an
    // element triggers no re-render — the action <select> and the reword
    // textarea kept showing `pick`, giving no sign the request had landed.
    //
    // `newMessage` is seeded here too. handleExecute only emits a reword when
    // `newMessage` is set AND differs from the summary; without it the entry
    // fell through to a plain `pick`, so "Reword" rewrote history and changed
    // no message at all. Seeding with the current summary means an untouched
    // textarea is a no-op, and any edit takes effect.
    if (options?.rewordCommitOid) {
      // A .map() that matches nothing is a silent no-op, and the plan it leaves
      // behind still rebases every OTHER commit in range — so an unmatched
      // target (a merge commit, which get_rebase_commits skips) armed a rebase
      // that would destroy the very commit the user asked to reword. Refuse
      // instead: say so, and keep Start Rebase disabled.
      if (!this.commits.some((c) => c.oid === options.rewordCommitOid)) {
        this.rewordRefused = true;
        this.warning =
          'This commit is not part of the rebase plan, so its message cannot be ' +
          'rewritten here. Merge commits cannot be reworded by rebase.';
        return;
      }

      // Merges ABOVE the target are the unguarded case. The plan omits them, so
      // it reads as a clean linear list, but replaying it flattens the merge
      // topology and rewrites the merged-in side commits — a destructive
      // history rewrite from a gesture that promised to change one commit
      // message. Refuse, the same way an unrebaseable target is refused.
      if (this.mergeCountInRange > 0) {
        this.rewordRefused = true;
        this.warning =
          `This commit cannot be reworded here: the range contains ` +
          `${this.mergeCountInRange} merge ` +
          `${this.mergeCountInRange === 1 ? 'commit' : 'commits'}, and rebasing ` +
          `would flatten ${this.mergeCountInRange === 1 ? 'it' : 'them'} and ` +
          `rewrite the merged-in commits. Reword it from an interactive rebase ` +
          `you start deliberately instead.`;
        return;
      }
      this.commits = this.commits.map((c) =>
        c.oid === options.rewordCommitOid
          ? { ...c, action: 'reword' as RebaseAction, newMessage: this.fullMessage(c) }
          : c
      );
    }
  }

  public close(): void {
    this.modal.open = false;
  }

  /** The repo this dialog is pinned to while open, or null when closed.
   * The host uses it to close the dialog if that repo's tab is closed. */
  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.modal?.open ? this.pinnedRepoPath : null;
  }

  /**
   * True while the rebase is running. `handleModalClose()` re-asserts the modal
   * open on this; the host's tab-close sweep must consult it too, because
   * `close()` is a bare `modal.open = false` that bypasses that guard.
   */
  public get operationInFlight(): boolean {
    return this.executing;
  }

  private reset(): void {
    this.onto = '';
    this.commits = [];
    this.loading = false;
    this.executing = false;
    this.error = '';
    this.warning = '';
    this.rewordRefused = false;
    this.mergeCountInRange = 0;
    this.draggedIndex = null;
    this.dropTargetIndex = null;
    this.showPreview = true;
  }

  private async loadCommits(): Promise<void> {
    if (!this.pinnedRepoPath || !this.onto) return;

    this.loading = true;
    this.error = '';

    try {
      const result = await gitService.getRebaseCommits(this.pinnedRepoPath, this.onto);

      if (result.success) {
        this.commits = (result.data?.commits ?? []).map(c => ({
          ...c,
          action: 'pick' as RebaseAction,
        }));
        // Merges are excluded from the todo, so a range containing them yields
        // a plan that LOOKS linear while the history is not. Replaying it
        // flattens the topology and rewrites the merged-in side commits.
        this.mergeCountInRange = result.data?.mergeCount ?? 0;
      } else {
        this.error = result.error?.message ?? 'Failed to load commits';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Unknown error occurred';
    } finally {
      this.loading = false;
    }
  }

  /**
   * Apply autosquash: reorder and mark fixup!/squash! commits
   */
  private applyAutosquash(): void {
    const newCommits: EditableRebaseCommit[] = [];
    const autosquashCommits: EditableRebaseCommit[] = [];
    const unmatchedCommits: string[] = [];

    // Separate regular and autosquash commits (create copies to avoid mutation)
    for (const commit of this.commits) {
      if (commit.summary.startsWith('fixup! ') || commit.summary.startsWith('squash! ')) {
        autosquashCommits.push({ ...commit });
      } else {
        newCommits.push({ ...commit });
      }
    }

    // For each autosquash commit, find its target and insert after it
    for (const asCommit of autosquashCommits) {
      const isFixup = asCommit.summary.startsWith('fixup! ');
      const targetSummary = asCommit.summary.slice(isFixup ? 7 : 8); // Remove prefix

      // Find the target commit by matching summary
      // Two-pass approach: exact match first, then prefix match (matches git's autosquash behavior)
      let targetIndex = newCommits.findIndex(c => c.summary === targetSummary);
      if (targetIndex === -1) {
        // No exact match, try prefix match
        targetIndex = newCommits.findIndex(c => c.summary.startsWith(targetSummary));
      }

      if (targetIndex !== -1) {
        // Set the action based on prefix
        asCommit.action = isFixup ? 'fixup' : 'squash';
        // Insert after the target (find last consecutive squash/fixup for this target)
        let insertIndex = targetIndex + 1;
        while (insertIndex < newCommits.length &&
               (newCommits[insertIndex].action === 'squash' ||
                newCommits[insertIndex].action === 'fixup')) {
          insertIndex++;
        }
        newCommits.splice(insertIndex, 0, asCommit);
      } else {
        // No target found, keep as pick at end and track for warning
        unmatchedCommits.push(asCommit.shortId);
        newCommits.push(asCommit);
      }
    }

    this.commits = newCommits;

    // Show warning if some commits couldn't find their targets
    if (unmatchedCommits.length > 0) {
      const commitList = unmatchedCommits.join(', ');
      this.warning = unmatchedCommits.length === 1
        ? `Commit ${commitList} couldn't find its target and was kept as pick.`
        : `Commits ${commitList} couldn't find their targets and were kept as picks.`;
    } else {
      this.warning = '';
    }
  }

  /**
   * Generate preview of what commits will look like after rebase
   * Handles edge cases like orphaned squash/fixup commits
   */
  private generatePreview(): PreviewCommit[] {
    const preview: PreviewCommit[] = [];
    let i = 0;
    let hasBaseCommit = false; // Track if we've seen a pick/reword/edit

    while (i < this.commits.length) {
      const commit = this.commits[i];

      if (commit.action === 'drop') {
        // Skip dropped commits
        i++;
        continue;
      }

      // Check if this is an orphaned squash/fixup (no base commit before it)
      if ((commit.action === 'squash' || commit.action === 'fixup') && !hasBaseCommit) {
        // This squash/fixup has no commit to squash into - mark as error
        preview.push({
          shortId: commit.shortId,
          summary: commit.summary,
          isSquashed: false,
          error: `Cannot ${commit.action}: no previous commit to combine with`,
        });
        i++;
        continue;
      }

      // This is a base commit (pick/reword/edit)
      hasBaseCommit = true;

      // Check if following commits are squash/fixup
      // `drop` lines are skipped, not treated as a boundary. git squashes into
      // the last PICKED commit, and a dropped line is not a pick — so with
      // pick/drop/squash the squash lands in the first commit. Stopping here
      // instead emitted it as its own surviving commit, which contradicted both
      // git and the "Resulting: N" stat rendered directly underneath (getStats
      // counts only pick/edit/reword as kept).
      const squashedFrom: string[] = [];
      let j = i + 1;
      while (
        j < this.commits.length &&
        (this.commits[j].action === 'drop' ||
          this.commits[j].action === 'squash' ||
          this.commits[j].action === 'fixup')
      ) {
        if (this.commits[j].action !== 'drop') {
          squashedFrom.push(this.commits[j].shortId);
        }
        j++;
      }

      let summary = commit.summary;
      if (commit.action === 'reword' && commit.newMessage !== undefined) {
        const firstLine = commit.newMessage.split('\n')[0].trim();
        summary = firstLine || '(empty message)';
      }

      preview.push({
        shortId: commit.shortId,
        summary,
        isSquashed: squashedFrom.length > 0,
        squashedFrom: squashedFrom.length > 0 ? squashedFrom : undefined,
      });

      // Advance past any squash/fixup commits we just grouped with this base commit.
      // j starts at i+1 and only increases, so this either skips to the next unprocessed
      // commit (j > i+1 when squashes found) or advances by one (j === i+1 when none found).
      i = j;
    }

    return preview;
  }

  /**
   * Check if the current configuration has validation errors
   */
  private hasValidationErrors(): boolean {
    const preview = this.generatePreview();
    return preview.some(p => p.error !== undefined);
  }

  /**
   * Get statistics about the rebase operation
   *
   * Note: `kept` counts commits that will remain in history (pick, edit, reword).
   * `reworded` is a subset of `kept` - commits that are kept but with modified messages.
   * The sum of kept + squashed + dropped equals total commits, but reworded overlaps with kept.
   */
  private getStats(): { kept: number; squashed: number; dropped: number; reworded: number } {
    let kept = 0;
    let squashed = 0;
    let dropped = 0;
    let reworded = 0;

    for (const commit of this.commits) {
      switch (commit.action) {
        case 'pick':
        case 'edit':
          kept++;
          break;
        case 'reword':
          reworded++; // Also counted in kept (reworded is a subset of kept)
          kept++;
          break;
        case 'squash':
        case 'fixup':
          squashed++;
          break;
        case 'drop':
          dropped++;
          break;
      }
    }

    return { kept, squashed, dropped, reworded };
  }

  private handleActionChange(index: number, e: Event): void {
    const select = e.target as HTMLSelectElement;
    const newAction = select.value as RebaseAction;
    this.commits = this.commits.map((c, i) => {
      if (i !== index) return c;
      return {
        ...c,
        action: newAction,
        // Seeded with the FULL message, not the subject. The textarea's own
        // `?? this.fullMessage(c)` fallback never fires once this is defined,
        // so seeding from the subject both hid the body from the user and made
        // the execute-time "did anything change?" comparison read true for an
        // untouched reword — emitting an amend that replaced the whole message
        // with just its first line.
        newMessage: newAction === 'reword' ? (c.newMessage ?? this.fullMessage(c)) : undefined,
      };
    });
  }

  private handleRewordChange(index: number, e: Event): void {
    const input = e.target as HTMLTextAreaElement;
    this.commits = this.commits.map((c, i) =>
      i === index ? { ...c, newMessage: input.value } : c
    );
  }

  private togglePreview(): void {
    this.showPreview = !this.showPreview;
  }

  private handleDragStart(index: number, e: DragEvent): void {
    this.draggedIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
    }
  }

  private handleDragOver(index: number, e: DragEvent): void {
    e.preventDefault();
    if (this.draggedIndex !== null && this.draggedIndex !== index) {
      this.dropTargetIndex = index;
    }
  }

  private handleDragLeave(): void {
    this.dropTargetIndex = null;
  }

  private handleDrop(index: number, e: DragEvent): void {
    e.preventDefault();
    if (this.draggedIndex !== null && this.draggedIndex !== index) {
      const newCommits = [...this.commits];
      const [removed] = newCommits.splice(this.draggedIndex, 1);
      newCommits.splice(index, 0, removed);
      this.commits = newCommits;
    }
    this.draggedIndex = null;
    this.dropTargetIndex = null;
  }

  private handleDragEnd(): void {
    this.draggedIndex = null;
    this.dropTargetIndex = null;
  }

  private async handleExecute(): Promise<void> {
    if (this.executing || this.commits.length === 0) return;

    // `executing` only stops a second click on THIS button. The working-tree
    // lock is what the sidebar lists and the graph menu read, so without
    // claiming it a sidebar checkout stayed enabled and ran concurrently
    // against the tree this rebase is rewriting.
    const lockedRepo = this.pinnedRepoPath ?? this.repositoryPath;
    if (!tryAcquireRefOp(lockedRepo)) {
      this.error = 'Another operation is already running in this repository.';
      return;
    }

    this.executing = true;
    this.error = '';

    try {
      // Generate the todo file content
      // For reword commits with changed messages, use pick + exec git commit --amend
      // This avoids git opening an editor which won't work in Tauri context
      const todoLines: string[] = [];

      for (const c of this.commits) {
        // Sanitize summary for todo file format (line-based, no newlines allowed)
        const sanitizedSummary = c.summary.replace(/[\r\n]+/g, ' ').trim();

        if (c.action === 'reword' && c.newMessage && c.newMessage !== this.fullMessage(c)) {
          // Use pick + exec to amend with new message
          // This is more reliable than reword which opens an editor
          todoLines.push(`pick ${c.shortId} ${sanitizedSummary}`);
          // Use printf for POSIX shell compatibility (works with dash, sh, bash, zsh)
          // Single quotes around printf arg prevent shell expansion
          // '\'' escapes a single quote within single-quoted string
          const escapedMessage = c.newMessage
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "'\\''")
            .replace(/\r\n/g, '\\n')
            .replace(/\r/g, '\\n')
            .replace(/\n/g, '\\n');
          todoLines.push(`exec git commit --amend -m "$(printf '%b' '${escapedMessage}')"`);
        } else if (c.action === 'reword') {
          // Reword without message change - keep as pick (no point in reword)
          todoLines.push(`pick ${c.shortId} ${sanitizedSummary}`);
        } else {
          todoLines.push(`${c.action} ${c.shortId} ${sanitizedSummary}`);
        }
      }

      const todo = todoLines.join('\n');

      // The repo pinned at open — NOT the live prop, which rebinds on a
      // tab switch while this dialog sits open. Executing against the
      // wrong repo would rewrite the wrong history.
      const repoPath = this.pinnedRepoPath;
      const result = await gitService.executeInteractiveRebase(repoPath, this.onto, todo);

      if (result.success) {
        // Every plain-rebase route toasts this. The interactive one — the most
        // consequential of the four, since it rewrites history wholesale — was
        // the only one that closed without a word.
        showToast(`Rebased onto ${this.onto}`, 'success');
        this.dispatchEvent(new CustomEvent('rebase-complete', {
          // Same pinning as the conflict sibling below: the refresh must
          // target the repo the rebase ran on, not whichever tab is active
          // by the time it completes.
          detail: { repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));
        this.close();
        // An `edit`/`break` line stops the rebase and still exits 0. Closing
        // silently left the user on a detached HEAD mid-rebase, with the
        // operation banner's Abort ("all resolved changes will be lost") as
        // the most obvious thing to click — throwing away the rebase they
        // paused on purpose.
        if (result.data?.paused) {
          showToast(
            // Names the control that actually exists. The banner renders only
            // Resolve Conflicts / Abort / Manage Bisect — there is no
            // "Continue" — so following the old text literally left Abort as
            // the most obvious button, which discards the rebase this message
            // exists to protect.
            REBASE_PAUSED_MESSAGE,
            'warning',
            8000,
          );
        }
      } else {
        if (result.error?.code === 'REBASE_CONFLICT') {
          this.close();
          this.dispatchEvent(new CustomEvent('open-conflict-dialog', {
            bubbles: true,
            composed: true,
            detail: { operationType: 'rebase', repositoryPath: repoPath },
          }));
          showToast('Rebase paused — resolve conflicts to continue', 'warning');
        } else {
          this.error = result.error?.message ?? 'Failed to execute rebase';
        }
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Unknown error occurred';
    } finally {
      this.executing = false;
      releaseRefOp(lockedRepo);
    }
  }

  private handleModalClose(): void {
    // Cancel is disabled while executing is in flight; Escape, the overlay and the
    // × must honour the same rule. gn-modal.close() sets open=false BEFORE
    // dispatching, so without re-asserting it here the rebase kept running with no
    // visible surface — and reported any failure into `error` on a hidden
    // dialog. Mirrors gn-branch-cleanup-dialog.handleModalClose.
    if (this.executing) {
      this.modal.open = true;
      return;
    }

    this.reset();
  }

  private get canExecute(): boolean {
    return (
      this.commits.length > 0 &&
      !this.rewordRefused &&
      !this.executing &&
      !this.hasValidationErrors()
    );
  }

  private renderCommitRow(commit: EditableRebaseCommit, index: number) {
    const isDragging = this.draggedIndex === index;
    const isDropTarget = this.dropTargetIndex === index;
    const actionClass = `action-${commit.action}`;

    return html`
      <div
        class="commit-row ${isDragging ? 'dragging' : ''} ${isDropTarget ? 'drop-target' : ''} ${actionClass}"
        draggable="true"
        @dragstart=${(e: DragEvent) => this.handleDragStart(index, e)}
        @dragover=${(e: DragEvent) => this.handleDragOver(index, e)}
        @dragleave=${this.handleDragLeave}
        @drop=${(e: DragEvent) => this.handleDrop(index, e)}
        @dragend=${this.handleDragEnd}
      >
        <div class="drag-handle">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="8" y1="6" x2="16" y2="6"></line>
            <line x1="8" y1="12" x2="16" y2="12"></line>
            <line x1="8" y1="18" x2="16" y2="18"></line>
          </svg>
        </div>

        <select
          class="action-select"
          .value=${commit.action}
          @change=${(e: Event) => this.handleActionChange(index, e)}
          ?disabled=${this.executing}
        >
          <option value="pick">pick</option>
          <option value="reword">reword</option>
          <option value="edit">edit</option>
          <option value="squash">squash</option>
          <option value="fixup">fixup</option>
          <option value="drop">drop</option>
        </select>

        <div class="commit-content">
          <div class="commit-info">
            <span class="commit-hash">${commit.shortId}</span>
            <span class="commit-message" title="${commit.summary}">${commit.summary}</span>
          </div>
          ${commit.action === 'reword' ? html`
            <textarea
              class="reword-input"
              rows="2"
              placeholder="Enter new commit message..."
              aria-label="New commit message for ${commit.shortId}"
              .value=${commit.newMessage ?? this.fullMessage(commit)}
              @input=${(e: Event) => this.handleRewordChange(index, e)}
              ?disabled=${this.executing}
            ></textarea>
          ` : nothing}
        </div>
      </div>
    `;
  }

  /**
   * The commit's full existing message.
   *
   * The reword route amends with `-m`, which REPLACES the whole message — so
   * seeding this from the subject alone silently deleted the body: trailers,
   * issue references, rationale. The commit panel's amend has always seeded
   * from summary + body, so the same operation preserved the body from one
   * surface and destroyed it from the other.
   *
   * Every place that seeds or compares a reword message must use this — the
   * textarea's fallback alone is not enough, because both seed sites define
   * `newMessage` before it ever renders.
   */
  private fullMessage(commit: EditableRebaseCommit): string {
    return commit.body ? `${commit.summary}\n\n${commit.body}` : commit.summary;
  }

  private renderPreview() {
    const preview = this.generatePreview();

    if (preview.length === 0) {
      return html`<div class="preview-empty">All commits will be dropped</div>`;
    }

    return html`
      ${preview.map(commit => html`
        <div class="preview-commit ${commit.isSquashed ? 'squashed' : ''} ${commit.error ? 'error' : ''}">
          <span class="preview-hash">${commit.shortId}</span>
          <span class="preview-message" title="${commit.error || commit.summary}">
            ${commit.error ? commit.error : commit.summary}
          </span>
          ${commit.squashedFrom ? html`
            <span class="squash-badge">+${commit.squashedFrom.length} squashed</span>
          ` : nothing}
          ${commit.error ? html`
            <span class="error-badge">Error</span>
          ` : nothing}
        </div>
      `)}
    `;
  }

  render() {
    const stats = this.getStats();

    return html`
      <gn-modal
        modalTitle="Interactive Rebase"
        @close=${this.handleModalClose}
      >
        <div class="form">
          <div class="header-row">
            <div class="header-info">
              Rebasing current branch onto <strong>${this.onto}</strong>
              ${this.commits.length > 0 ? html`
                <span class="commit-count">
                  (${this.commits.length} commit${this.commits.length !== 1 ? 's' : ''})
                </span>
              ` : nothing}
            </div>
            <div class="header-actions">
              <button
                class="btn-small ${this.showPreview ? 'active' : ''}"
                @click=${this.togglePreview}
                title="Toggle preview panel"
              >
                Preview
              </button>
            </div>
          </div>

          ${this.canApplyAutosquash ? html`
            <div class="autosquash-banner">
              <span>Found commits with <code>fixup!</code> or <code>squash!</code> prefixes</span>
              <button
                @click=${this.applyAutosquash}
                aria-label="Automatically reorder and mark fixup! and squash! commits"
              >
                Apply Autosquash
              </button>
            </div>
          ` : nothing}

          ${this.loading ? html`
            <div class="loading">Loading commits...</div>
          ` : this.commits.length === 0 ? html`
            <div class="empty">No commits to rebase</div>
          ` : html`
            <div class="main-content ${!this.showPreview ? 'preview-hidden' : ''}">
              <div class="editor-section">
                <div class="section-title">Rebase Plan</div>
                <div class="commits-list">
                  ${this.commits.map((commit, index) => this.renderCommitRow(commit, index))}
                </div>
              </div>

              ${this.showPreview ? html`
                <div class="preview-section">
                  <div class="section-title">Preview Result</div>
                  <div class="preview-list">
                    ${this.renderPreview()}
                  </div>
                </div>
              ` : nothing}
            </div>

            <div class="stats-row">
              <div class="stat">
                <span>Resulting:</span>
                <span class="stat-value">${stats.kept}</span>
              </div>
              ${stats.squashed > 0 ? html`
                <div class="stat">
                  <span>Squashed:</span>
                  <span class="stat-value">${stats.squashed}</span>
                </div>
              ` : nothing}
              ${stats.dropped > 0 ? html`
                <div class="stat">
                  <span>Dropped:</span>
                  <span class="stat-value">${stats.dropped}</span>
                </div>
              ` : nothing}
              ${stats.reworded > 0 ? html`
                <div class="stat">
                  <span>Reworded:</span>
                  <span class="stat-value">${stats.reworded}</span>
                </div>
              ` : nothing}
            </div>
          `}

          <div class="help-section">
            <div class="help-text">
              <ul>
                <li><strong>pick</strong> - use commit as-is</li>
                <li><strong>reword</strong> - use commit, but edit message</li>
                <li><strong>edit</strong> - pause to amend commit</li>
                <li><strong>squash</strong> - meld into previous commit</li>
                <li><strong>fixup</strong> - like squash, but discard message</li>
                <li><strong>drop</strong> - remove commit</li>
              </ul>
            </div>
            <div class="keyboard-hints">
              <div>Drag rows to reorder commits</div>
            </div>
          </div>

          ${this.mergeCountInRange > 0 && !this.rewordRefused
            ? html`<div class="warning-message">
                This range contains ${this.mergeCountInRange} merge
                ${this.mergeCountInRange === 1 ? 'commit' : 'commits'}, which are not
                listed below. Rebasing will flatten
                ${this.mergeCountInRange === 1 ? 'it' : 'them'} and rewrite the
                commits that were merged in.
              </div>`
            : nothing}
          ${this.warning
            ? html`<div class="warning-message">${this.warning}</div>`
            : nothing}

          ${this.error
            ? html`<div class="error-message">${this.error}</div>`
            : nothing}
        </div>

        <div slot="footer">
          <button
            class="btn btn-secondary"
            @click=${this.close}
            ?disabled=${this.executing}
          >
            Cancel
          </button>
          <button
            class="btn btn-primary"
            @click=${this.handleExecute}
            ?disabled=${!this.canExecute || this.lock.busy}
          >
            ${this.executing ? 'Rebasing...' : 'Start Rebase'}
          </button>
        </div>
      </gn-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-interactive-rebase-dialog': GnInteractiveRebaseDialog;
  }
}
