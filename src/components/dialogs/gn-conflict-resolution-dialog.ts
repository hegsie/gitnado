/**
 * Conflict Resolution Dialog
 * Full-screen dialog for resolving merge/rebase conflicts
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import type { GnMergeEditor } from '../panels/gn-merge-editor.ts';
import type { ConflictFile } from '../../types/git.types.ts';
import type { CommandResult } from '../../types/api.types.ts';
import '../panels/gn-merge-editor.ts';
import { pushOverlay, removeOverlay, isTopOverlay } from '../../utils/overlay-stack.ts';
import { containsDeepActiveElement } from '../../utils/focus.ts';
// DELIBERATELY claim-only: this dialog does NOT bind its buttons to
// isRefOpRunning the way its siblings do. Abort and Continue are the only two
// exits from a conflicted repository, and greying an exit out because an
// unrelated surface holds the lock is the trap that greying Abort out during a
// minutes-long fsck already produced once. Both handlers still claim the lock
// and report the refusal, so the operation stays serialized; only the
// affordance stays live.
import { tryAcquireRefOp, releaseRefOp } from '../../utils/ref-lock.ts';
import { REBASE_PAUSED_MESSAGE, skippedCommitsSuffix } from '../../utils/rebase-messages.ts';

/**
 * Context threaded through a conflicted git-flow finish so the dialog can COMPLETE
 * the finish after the merge conflict is resolved (tag, merge into develop, delete
 * the branch) instead of leaving it half-done.
 */
export interface GitflowFinishContext {
  kind: 'feature' | 'release' | 'hotfix';
  /** Name/version WITHOUT the branch prefix — what the backend finish expects. */
  name: string;
  /** Full prefixed branch name — used to delete the branch directly (squash case). */
  branchName: string;
  deleteBranch: boolean;
  /** Tag message for release/hotfix finish re-invocation. */
  tagMessage?: string;
  /**
   * True when a commit from THIS finish already landed before the conflict —
   * i.e. a release/hotfix whose master merge + version tag committed and then
   * conflicted on the develop merge. An Abort then only rolls back the develop
   * merge, so the dialog must say the master merge and tag survive.
   */
  priorFinishCommitLanded?: boolean;
}

@customElement('gn-conflict-resolution-dialog')
export class GnConflictResolutionDialog extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: none;
      }

      :host([open]) {
        display: block;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 1000;
      }

      .backdrop {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
      }

      .dialog {
        position: absolute;
        top: 20px;
        left: 20px;
        right: 20px;
        bottom: 20px;
        background: var(--color-bg-primary);
        border-radius: var(--radius-lg);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: var(--shadow-xl);
      }

      /* Focused programmatically on open (see updated()); it is a focus
         container, not a control, so it needs no ring of its own. */
      .dialog:focus {
        outline: none;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-md) var(--spacing-lg);
        background: var(--color-bg-secondary);
        border-bottom: 1px solid var(--color-border);
      }

      .header-title {
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
      }

      .header-subtitle {
        font-size: var(--font-size-sm);
        color: var(--color-text-muted);
        margin-top: var(--spacing-xs);
      }

      .header-actions {
        display: flex;
        gap: var(--spacing-sm);
      }

      .content {
        display: grid;
        grid-template-columns: 280px 1fr;
        flex: 1;
        overflow: hidden;
      }

      .file-list {
        display: flex;
        flex-direction: column;
        border-right: 1px solid var(--color-border);
        background: var(--color-bg-secondary);
        overflow-y: auto;
      }

      .file-list-header {
        padding: var(--spacing-sm) var(--spacing-md);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        border-bottom: 1px solid var(--color-border);
      }

      .file-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
        cursor: pointer;
        border-bottom: 1px solid var(--color-border-subtle);
        transition: background var(--transition-fast);
      }

      .file-item:hover {
        background: var(--color-bg-hover);
      }

      .file-item.selected {
        background: var(--color-primary-alpha);
      }

      .file-item.resolved {
        opacity: 0.6;
      }

      .file-icon {
        width: 16px;
        height: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .file-icon.conflict {
        color: var(--color-warning);
      }

      .file-icon.resolved {
        color: var(--color-success);
      }

      .file-name {
        flex: 1;
        font-size: var(--font-size-sm);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Directory hint so same-named files in different folders are distinguishable */
      .file-dir {
        display: block;
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .editor-container {
        flex: 1;
        overflow: hidden;
      }

      gn-merge-editor {
        height: 100%;
      }

      .footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-md) var(--spacing-lg);
        background: var(--color-bg-secondary);
        border-top: 1px solid var(--color-border);
      }

      .footer-info {
        font-size: var(--font-size-sm);
        color: var(--color-text-muted);
      }

      .footer-actions {
        display: flex;
        gap: var(--spacing-sm);
      }

      .btn {
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        border: 1px solid var(--color-border);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        transition: all var(--transition-fast);
      }

      .btn:hover {
        background: var(--color-bg-hover);
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-danger {
        background: var(--color-error);
        color: var(--color-text-inverse);
        border-color: var(--color-error);
      }

      .btn-danger:hover {
        background: var(--color-error-hover, #dc2626);
      }

      .btn-primary {
        background: var(--color-primary);
        color: var(--color-text-inverse);
        border-color: var(--color-primary);
      }

      .btn-primary:hover {
        background: var(--color-primary-hover);
      }

      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--color-text-muted);
        font-style: italic;
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--color-text-muted);
      }

      .nav-buttons {
        display: flex;
        gap: var(--spacing-xs);
      }

      .nav-btn {
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-secondary);
        cursor: pointer;
        font-size: var(--font-size-xs);
      }

      .nav-btn:hover:not(:disabled) {
        background: var(--color-bg-hover);
      }

      .nav-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .confirm-overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10;
      }

      .confirm-dialog {
        background: var(--color-bg-primary);
        border-radius: var(--radius-lg);
        padding: var(--spacing-lg);
        max-width: 400px;
        box-shadow: var(--shadow-xl);
      }

      .confirm-title {
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-semibold);
        margin-bottom: var(--spacing-sm);
      }

      .confirm-message {
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-lg);
      }

      .confirm-actions {
        display: flex;
        gap: var(--spacing-sm);
        justify-content: flex-end;
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: String }) repositoryPath = '';
  @property({ type: String }) operationType: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'stash' = 'merge';
  /** The file the user clicked to get here — preselected over the first conflict. */
  @property({ attribute: false }) initialFilePath: string | null = null;
  /**
   * False when 'stash' was merely INFERRED from a clean repository state
   * (external `git stash apply`/`checkout -m`/`apply -3` — indistinguishable).
   * Messaging must then not promise the changes are safe in a stash entry
   * that may not exist.
   */
  @property({ type: Boolean }) stashSourceCertain = true;
  /** For 'stash' completion: which stash entry to drop once conflicts are resolved. */
  @property({ type: Number }) stashIndex = 0;
  /**
   * The stash's oid, when the caller knows it. Preferred over `stashIndex`.
   *
   * `git stash push` prepends, so a stash created by another surface or a
   * terminal renumbers the list — and checkout_with_autostash now resolves its
   * own entry by oid rather than assuming position 0. Its callers used to pass
   * `stashIndex: 0` regardless, so the identity captured here could be a
   * foreign stash, which Complete would then drop.
   */
  @property({ type: String }) stashOid: string | null = null;
  /**
   * For 'stash' completion: whether to drop stash@{stashIndex} on Complete. Pop
   * semantics (auto-stash, explicit pop) drop it; a plain apply keeps it.
   */
  @property({ type: Boolean }) dropStashOnComplete = true;
  /**
   * For 'merge' completion: complete as a squash merge (single-parent commit)
   * rather than a two-parent merge commit. Set when the failed operation that
   * opened this dialog was a squash (e.g. a git-flow squash finish).
   */
  @property({ type: Boolean }) squashMerge = false;
  /**
   * When set, the conflicted merge that opened this dialog was one side of a
   * git-flow finish. After the merge is completed, the finish must be COMPLETED
   * (tag / merge develop / delete branch) rather than left half-done.
   */
  @property({ attribute: false }) gitflowFinish: GitflowFinishContext | null = null;

  @state() private conflicts: ConflictFile[] = [];
  @state() private resolvedFiles: Set<string> = new Set();
  @state() private selectedIndex = 0;
  @state() private loading = false;
  /**
   * Whether the last conflict load FAILED (as opposed to succeeding with zero
   * conflicts). The backend opened this dialog because it reported a conflict, so
   * a failed load means the index IS conflicted but we couldn't read it — we must
   * keep the dialog open with a Retry rather than auto-exiting or falsely treating
   * it as "nothing to resolve".
   */
  @state() private loadFailed = false;
  /**
   * True once commitMerge has succeeded for this dialog session. If the
   * git-flow completion step that follows fails, a retry must skip straight
   * to it — re-running commitMerge would fail with "No merge in progress".
   */
  private mergeCommitted = false;
  /**
   * True when an earlier commit from this git-flow finish (the master-side
   * merge and version tag) already landed — an Abort at the develop stage
   * only rolls back the develop merge and must say so.
   */
  private priorFinishCommitLanded = false;
  @state() private aborting = false;
  @state() private continuing = false;
  /** True while a `--skip` is in flight. Mutually exclusive with the other
   * working-tree operations, exactly as `aborting` / `continuing` are. */
  @state() private skipping = false;
  /** True while the EMBEDDED merge editor has an external tool session open. */
  @state() private editorToolActive = false;
  /**
   * Number of the embedded editor's resolve/take-side writes in flight. A
   * COUNT, not a boolean: switching files mid-write deliberately lets a new
   * resolve start while the old one finishes, and each write dispatches its
   * own started/finished pair — folding them into a boolean would unlock
   * Abort/Complete/External on the FIRST finish while a write is still
   * running.
   */
  @state() private editorResolveDepth = 0;
  @state() private showAbortConfirm = false;
  @state() private hasMergeTool = false;
  @state() private launchingExternalTool: string | null = null;
  @state() private detectedMergeTool: string | null = null;

  async connectedCallback(): Promise<void> {
    super.connectedCallback();
    document.addEventListener('keydown', this.handleKeyDown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    removeOverlay(this);
    document.removeEventListener('keydown', this.handleKeyDown);
  }

  protected updated(changedProperties: Map<string, unknown>): void {
    super.updated(changedProperties);

    // Announce/withdraw overlay ownership of Escape. Missing this made a
    // dialog opened over another one dismiss BOTH on a single keypress: the
    // one underneath was still stack-top, so its own guard passed.
    if (changedProperties.has('open')) {
      if (this.open) { pushOverlay(this); } else { removeOverlay(this); }
    }

    // Move focus into the dialog once it is on screen. It builds its own
    // overlay instead of using <gn-modal> and had no focus() anywhere, so it
    // opened with focus still on <body>: Tab started at the skip link and
    // walked the entire app UNDERNEATH the backdrop. This dialog is the worst
    // case because it also suppresses Escape by design — there was no keyboard
    // way in and none out. The dialog element itself takes focus (its own
    // controls are Abort and Complete; neither should be one Enter away).
    if (changedProperties.has('open') && this.open) {
      requestAnimationFrame(() => {
        if (!this.open) return;
        if (containsDeepActiveElement(this)) return;
        const dialog = this.shadowRoot?.querySelector('.dialog') as HTMLElement | null;
        dialog?.focus();
      });
    }

    // The abort confirm renders LAST, over a dialog whose controls stay
    // focusable, and opening it left focus on the Abort button underneath —
    // so reaching Cancel meant Tabbing through every remaining control of the
    // live dialog. Take focus to Cancel (never the danger button) instead.
    if (changedProperties.has('showAbortConfirm') && this.showAbortConfirm) {
      requestAnimationFrame(() => {
        if (!this.showAbortConfirm) return;
        const cancelBtn = this.shadowRoot?.querySelector(
          '.confirm-actions .btn:not(.btn-danger)'
        ) as HTMLElement | null;
        cancelBtn?.focus();
      });
    }

    // When open changes to true, load conflicts
    if (changedProperties.has('open') && this.open) {
      this.resolvedFiles = new Set();
      this.selectedIndex = 0;
      this.aborting = false;
      this.continuing = false;
      this.skipping = false;
      this.editorToolActive = false;
      this.editorResolveDepth = 0;
      this.showAbortConfirm = false;
      this.mergeCommitted = false;
      // Seed from the finish context: a first-run release/hotfix whose master
      // merge + tag already landed before the develop conflict opens here with
      // this set, so Abort is honest about what survives even on this path
      // (not just the dialog-internal re-run).
      this.priorFinishCommitLanded = this.gitflowFinish?.priorFinishCommitLanded ?? false;
      this.loadConflicts();
      // Capture the to-be-dropped stash entry's IDENTITY at open. Complete
      // may run much later, and an external `git stash drop` in a terminal
      // meanwhile shifts the indices — dropping blindly by the open-time
      // index could then delete an UNRELATED stash. The index AND a session
      // epoch are captured with the request: the dialog can close and
      // reopen for a different stash before this resolves, and a late
      // first-session response must not pair its list with the SECOND
      // session's index.
      this.stashOidToDrop = null;
      this.stashCaptureEpoch++;
      if (this.operationType === 'stash' && this.dropStashOnComplete) {
        if (this.stashOid) {
          // The caller knows exactly which entry it created; no position
          // lookup, so nothing to get wrong.
          this.stashOidToDrop = this.stashOid;
        } else {
          const idx = this.stashIndex;
          const epoch = this.stashCaptureEpoch;
          void gitService.getStashes(this.repositoryPath).then((result) => {
            if (this.open && epoch === this.stashCaptureEpoch && result.success) {
              this.stashOidToDrop = result.data?.[idx]?.oid ?? null;
            }
          });
        }
      }
    }
  }

  /** OID of the stash entry Complete must drop, captured at dialog open. */
  private stashOidToDrop: string | null = null;
  /** Bumped per open/close so a stale identity capture can't cross sessions. */
  private stashCaptureEpoch = 0;

  private handleKeyDown = (e: KeyboardEvent): void => {
    // Only the topmost overlay owns Escape. This handler only swallows the
    // key today, but it must not swallow one aimed at a dialog above it.
    if (!this.open || !isTopOverlay(this)) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      // Escape dismisses the abort confirm. Without this arm the key was
      // swallowed unconditionally, so a keyboard user who opened the
      // "this cannot be undone" confirm had no way back except Tabbing
      // through the whole dialog to reach Cancel.
      if (this.showAbortConfirm) {
        this.handleAbortCancel();
        return;
      }
      // Don't close on escape - require explicit abort/continue
    } else if (e.key === 'ArrowUp' && e.altKey) {
      e.preventDefault();
      this.handlePrevious();
    } else if (e.key === 'ArrowDown' && e.altKey) {
      e.preventDefault();
      this.handleNext();
    }
  };

  private close(): void {
    this.open = false;
    this.conflicts = [];
    this.resolvedFiles = new Set();
    this.aborting = false;
    this.continuing = false;
    this.skipping = false;
    this.editorToolActive = false;
    this.editorResolveDepth = 0;
    this.showAbortConfirm = false;
    this.mergeCommitted = false;
    this.priorFinishCommitLanded = false;
    this.stashOidToDrop = null;
    this.stashCaptureEpoch++;
  }

  /** Re-run the conflict load after a failure, resetting resolution progress. */
  private handleRetryLoad = (): void => {
    this.resolvedFiles = new Set();
    this.selectedIndex = 0;
    void this.loadConflicts();
  };

  private async loadConflicts(): Promise<void> {
    if (!this.repositoryPath) return;

    this.loading = true;
    try {
      const result = await gitService.getConflicts(this.repositoryPath);
      if (result.success && result.data) {
        this.conflicts = result.data;
        this.loadFailed = false;
        // Open on the file the user clicked, when it's one of the conflicts.
        // (Continue-with-new-conflicts paths reset the index to 0 afterwards.)
        if (this.initialFilePath) {
          const initialIndex = this.conflicts.findIndex((c) => c.path === this.initialFilePath);
          if (initialIndex >= 0) {
            this.selectedIndex = initialIndex;
          }
        }
      } else {
        console.error('Failed to load conflicts:', result.error);
        showToast('Failed to load conflicts', 'error');
        this.conflicts = [];
        this.loadFailed = true;
      }
    } catch (err) {
      console.error('Failed to load conflicts:', err);
      showToast('Failed to load conflicts', 'error');
      this.conflicts = [];
      this.loadFailed = true;
    } finally {
      this.loading = false;
    }

    await this.checkMergeToolAvailability();

    // A 'stash' dialog that SUCCESSFULLY loaded with zero conflicts is an
    // inescapable trap: Complete is disabled and Escape is suppressed, leaving
    // only the destructive Abort. The stash was never applied, so auto-run the
    // safe non-destructive exit (keeps the stash, discards nothing).
    // A FAILED load must NOT trigger this: the backend reported a conflict, so the
    // index IS conflicted — we just couldn't read it. Keep the dialog open with a
    // Retry instead of abandoning the user.
    if (
      this.open &&
      this.operationType === 'stash' &&
      !this.loadFailed &&
      this.conflicts.length === 0
    ) {
      this.handleStashNotApplied();
    }
  }

  private async checkMergeToolAvailability(): Promise<void> {
    if (!this.repositoryPath) return;
    try {
      const result = await gitService.getMergeToolConfig(this.repositoryPath);
      this.hasMergeTool = result.success && !!result.data?.toolName;

      // If no tool configured, try auto-detecting one to show a hint
      if (!this.hasMergeTool) {
        const detectResult = await gitService.autoDetectMergeTool();
        this.detectedMergeTool = detectResult.success && detectResult.data
          ? detectResult.data.displayName
          : null;
      } else {
        this.detectedMergeTool = null;
      }
    } catch {
      this.hasMergeTool = false;
      this.detectedMergeTool = null;
    }
  }

  private async handleOpenExternalTool(conflictPath: string): Promise<void> {
    // Re-entrancy + mutual exclusion: one tool session at a time, and never
    // under a running abort/complete.
    if (
      !this.repositoryPath ||
      this.launchingExternalTool !== null ||
      this.aborting ||
      this.continuing ||
      this.skipping ||
      this.editorToolActive ||
      this.editorResolveDepth > 0
    ) {
      return;
    }
    // Claim the launch BEFORE any await: the confirm below yields to the
    // event loop, and a second click landing in that window would pass the
    // entry guard again — two tool sessions editing the same file.
    this.launchingExternalTool = conflictPath;
    // Launching on the SELECTED file replaces the editor's unsaved picks
    // with the tool's output on reload — confirm with tool wording (the
    // file-switch copy would wrongly suggest Mark Resolved keeps the picks
    // safe from the tool's result).
    if (this.selectedConflict?.path === conflictPath) {
      const editor = this.shadowRoot?.querySelector('gn-merge-editor') as GnMergeEditor | null;
      if (editor?.hasUnsavedResolutions()) {
        let proceed = false;
        try {
          proceed = await showConfirm(
            'Discard in-progress resolution?',
            'The external tool works on the file as saved on disk — your unsaved picks here will be replaced by its result.',
            'warning',
          );
        } finally {
          if (!proceed) this.launchingExternalTool = null;
        }
        if (!proceed) return;
      }
    }

    try {
      const result = await gitService.launchMergeTool(this.repositoryPath, conflictPath);
      if (result.success && result.data?.success) {
        // The tool's exit code alone isn't authoritative — re-check the index to
        // confirm the file is no longer conflicted before marking it resolved.
        const conflictsResult = await gitService.getConflicts(this.repositoryPath);
        // A FAILED re-check must count as still conflicted — treating it as
        // resolved would enable Complete (and a stash drop) on a file that
        // may still hold marker text.
        const stillConflicted =
          !conflictsResult.success ||
          (conflictsResult.data ?? []).some((c) => c.path === conflictPath);
        // The embedded editor is bound to this file's ConflictFile object and
        // only reloads on identity change — refresh it so it shows the tool's
        // output instead of a stale parse that Mark Resolved would write back
        // OVER the merge the user just crafted in the tool. Adopt the FRESH
        // entry when the file is still conflicted: the tool may have changed
        // what get_conflicts reports (markerSize, conflictStyle, hunks), and
        // re-parsing with the stale metadata would misread its output.
        const wasSelected = this.selectedConflict?.path === conflictPath;
        const fresh = conflictsResult.data?.find((c) => c.path === conflictPath);
        this.conflicts = this.conflicts.map((c) =>
          c.path === conflictPath ? (fresh ?? { ...c }) : c
        );
        if (stillConflicted) {
          showToast('File still has conflicts', 'warning');
        } else {
          this.resolvedFiles = new Set([...this.resolvedFiles, conflictPath]);
          this.requestUpdate();
          showToast('Merge tool completed', 'success');
          if (wasSelected) {
            this.advanceToNextUnresolved();
          }
        }
      } else {
        showToast(result.data?.message ?? result.error?.message ?? 'Merge tool failed', 'error');
      }
    } catch {
      showToast('Failed to launch merge tool', 'error');
    } finally {
      this.launchingExternalTool = null;
    }
  }

  /**
   * The editor's picks live only in memory until Mark Resolved — navigating
   * away re-parses the file from disk and silently discards them. Confirm
   * before a user-driven switch when in-progress work would be lost.
   * (Auto-advance after a resolution goes straight to selectedIndex — the
   * resolved file's work IS on disk by then.)
   */
  private async confirmLeaveInProgress(): Promise<boolean> {
    const editor = this.shadowRoot?.querySelector('gn-merge-editor') as GnMergeEditor | null;
    if (!editor?.hasUnsavedResolutions()) return true;
    return showConfirm(
      'Discard in-progress resolution?',
      'This file has conflict resolutions that are not saved yet — switching files discards them. Use Mark Resolved to keep them.',
      'warning',
    );
  }

  /**
   * Navigating away mid-write lets the user come BACK and start a second
   * write against the same file — two overlapping writes, last one wins.
   * The file-list rows and keyboard shortcuts have no disabled affordance
   * (unlike the Prev/Next buttons), so the refusal must not be silent.
   */
  private navBlockedByResolve(): boolean {
    if (this.editorResolveDepth === 0) return false;
    showToast('Wait for the current resolve to finish', 'info');
    return true;
  }

  /** The editor's own external-tool session ended. Adopt the fresh
   * ConflictFile the editor re-fetched: the tool may have changed what
   * get_conflicts reports (markerSize, conflictStyle, hunks), and keeping
   * the stale object would misparse the tool's output on the next load. */
  private handleEditorToolFinished(e: Event): void {
    this.editorToolActive = false;
    const detail = (e as CustomEvent<{
      filePath?: string;
      freshConflicts?: ConflictFile[] | null;
    }>).detail;
    const filePath = detail?.filePath;
    const fresh = detail?.freshConflicts?.find((c) => c.path === filePath);
    if (filePath && fresh) {
      this.conflicts = this.conflicts.map((c) => (c.path === filePath ? fresh : c));
    }
  }

  private async handleFileSelect(index: number): Promise<void> {
    if (index === this.selectedIndex) return;
    if (this.navBlockedByResolve()) return;
    if (!(await this.confirmLeaveInProgress())) return;
    if (this.editorResolveDepth > 0) return;
    // Re-validate the index after the confirm await, like handlePrevious/
    // handleNext: a runContinue reload (rebase --continue reporting fresh
    // conflicts) can replace/shrink this.conflicts while the confirm is up,
    // so a stale index would point past the new array and collapse the
    // editor to "Select a file" with conflicts still unresolved.
    if (index < 0 || index >= this.conflicts.length) return;
    this.selectedIndex = index;
  }

  private async handlePrevious(): Promise<void> {
    if (this.selectedIndex > 0) {
      if (this.navBlockedByResolve()) return;
      if (!(await this.confirmLeaveInProgress())) return;
      if (this.editorResolveDepth > 0) return;
      // Re-check the bound after the await: Alt+ArrowUp auto-repeat stacks
      // several of these behind one confirm, and each read the same stale
      // index — decrementing twice would drive the selection to -1 and
      // leave Prev/Next permanently inert.
      if (this.selectedIndex <= 0) return;
      this.selectedIndex--;
    }
  }

  private async handleNext(): Promise<void> {
    if (this.selectedIndex < this.conflicts.length - 1) {
      if (this.navBlockedByResolve()) return;
      if (!(await this.confirmLeaveInProgress())) return;
      if (this.editorResolveDepth > 0) return;
      // Same post-await bound re-check as handlePrevious — stacked calls
      // must not push the index past the last file.
      if (this.selectedIndex >= this.conflicts.length - 1) return;
      this.selectedIndex++;
    }
  }

  /** Move selection to the next unresolved file, wrapping around so files
   * skipped earlier in the list are still reachable. */
  private advanceToNextUnresolved(): void {
    const total = this.conflicts.length;
    for (let offset = 1; offset < total; offset++) {
      const i = (this.selectedIndex + offset) % total;
      if (!this.resolvedFiles.has(this.conflicts[i].path)) {
        this.selectedIndex = i;
        return;
      }
    }
  }

  private handleConflictResolved(e: CustomEvent): void {
    const { file } = e.detail as { file: ConflictFile };
    // A resolve call can land AFTER the user has moved on to another file —
    // only auto-advance when the resolved file is still the selected one, or
    // the completion would yank them off the file they're actively working on
    // (losing its in-memory picks on the way back).
    const wasSelected = this.conflicts[this.selectedIndex]?.path === file.path;
    this.resolvedFiles = new Set([...this.resolvedFiles, file.path]);
    this.requestUpdate();
    if (!wasSelected) return;

    this.advanceToNextUnresolved();
  }

  private handleAbort(): void {
    // Mutually exclusive with Complete and the external merge tool: aborting
    // while a stash-drop Complete is in flight would revert the files AND
    // lose the stash entry; aborting under an open external tool would let
    // its later save re-dirty the just-aborted working tree.
    if (
      this.aborting ||
      this.continuing ||
      this.skipping ||
      this.launchingExternalTool !== null ||
      this.editorToolActive ||
      this.editorResolveDepth > 0
    ) {
      return;
    }
    // Once the merge commit has landed (only the follow-up git-flow finish
    // step failed), there is nothing to abort — exit directly WITHOUT the
    // "all resolved changes will be lost" confirm, which would be false here
    // (nothing is lost, nothing is rolled back). This is the user's safe exit
    // from a persistently-failing finish, not a destructive action.
    if (this.operationType === 'merge' && this.mergeCommitted) {
      this.exitAfterCommittedMerge();
      return;
    }
    this.showAbortConfirm = true;
  }

  /**
   * Leave the dialog when the merge is already committed and only the git-flow
   * finish step remains (and keeps failing). Nothing is rolled back.
   */
  private exitAfterCommittedMerge(): void {
    // A squash finish must NOT be re-run from the panel (its merge is not
    // idempotent once the squash commit landed) — only the branch deletion
    // remains; other finishes are idempotently re-runnable.
    showToast(
      this.gitflowFinish && this.squashMerge
        ? 'The squash commit is already on develop and cannot be rolled back — delete the feature branch from the branch list to finish'
        : 'The merge is already committed and cannot be rolled back — retry the finish from the Git Flow panel',
      'warning'
    );
    this.dispatchEvent(
      new CustomEvent('operation-aborted', { bubbles: true, composed: true })
    );
    this.close();
  }

  private handleAbortCancel(): void {
    this.showAbortConfirm = false;
  }

  private async handleAbortConfirm(): Promise<void> {
    if (
      !this.repositoryPath ||
      this.aborting ||
      this.continuing ||
      this.skipping ||
      this.launchingExternalTool !== null ||
      this.editorToolActive ||
      this.editorResolveDepth > 0
    ) {
      return;
    }

    // Safety net: if the merge was committed after the confirm opened, exit
    // without a no-op abort_merge. handleAbort normally routes here before the
    // confirm ever renders.
    if (this.operationType === 'merge' && this.mergeCommitted) {
      this.showAbortConfirm = false;
      this.exitAfterCommittedMerge();
      return;
    }

    // The banner's Abort claims the shared working-tree lock; this dialog
    // reaches the identical abort_merge/abort_rebase commands and claimed
    // nothing. The backdrop blocks the mouse, but keyboard shortcuts fire
    // through it — Ctrl+Shift+S and Ctrl+Shift+P both claim a free lock and
    // run beside an abort that is restoring the working tree.
    const lockedRepo = this.repositoryPath;
    if (!tryAcquireRefOp(lockedRepo)) {
      showToast('Another operation is already running in this repository.', 'warning');
      return;
    }

    this.aborting = true;
    this.showAbortConfirm = false;

    try {
      let result;
      switch (this.operationType) {
        case 'merge':
          result = await gitService.abortMerge({ path: this.repositoryPath });
          break;
        case 'rebase':
          result = await gitService.abortRebase({ path: this.repositoryPath });
          break;
        case 'cherry-pick':
          result = await gitService.abortCherryPick({ path: this.repositoryPath });
          break;
        case 'revert':
          result = await gitService.abortRevert({ path: this.repositoryPath });
          break;
        case 'stash': {
          // There's no backend "abort stash apply". A hard reset to HEAD would
          // destroy UNRELATED uncommitted changes when the stash was applied/popped
          // onto a dirty tree. Instead restore ONLY the conflicted files: unstage
          // them (clears the conflict index entries, resetting to HEAD) then discard
          // their working-tree changes (restores HEAD content). The stash entry is
          // never touched, so the stashed changes remain recoverable.
          // ALWAYS re-fetch the authoritative conflict list from the index
          // rather than trusting the client-side `this.conflicts`. That list
          // is empty both when the load FAILED and while it is still
          // IN FLIGHT (per-file replay detection can take seconds) — in
          // either case restoring from it would no-op and report a false
          // "nothing needed restoring" success while the tree stays fully
          // conflicted.
          let restoredCount = 0;
          const refetch = await gitService.getConflicts(this.repositoryPath);
          if (!refetch.success || !refetch.data) {
            showToast(
              refetch.error?.message ?? 'Could not read conflicts — nothing was restored',
              'error',
            );
            this.aborting = false;
            return;
          }
          // Restore the UNION of the still-conflicted paths AND the files
          // that were originally conflicted when the dialog opened. A file
          // the user already resolved in this session (Mark Resolved →
          // staged, or take-side deletion) is no longer index-conflicted, so
          // the refetch alone would EXCLUDE it — Abort would leave that
          // resolution staged while claiming everything was reverted. The
          // refetch remains the safety net for an empty/in-flight client
          // list; the union re-adds the resolved files (their stash changes
          // stay safe in the retained stash entry).
          const conflictPaths = Array.from(
            new Set([
              ...refetch.data.map((c) => c.path),
              ...this.conflicts.map((c) => c.path),
            ]),
          );
          if (conflictPaths.length === 0) {
            result = { success: true } as CommandResult<void>;
          } else {
            const unstageResult = await gitService.unstageFiles(this.repositoryPath, {
              paths: conflictPaths,
            });
            result = unstageResult.success
              ? await gitService.discardChanges(this.repositoryPath, conflictPaths)
              : unstageResult;
            if (result.success) restoredCount = conflictPaths.length;
          }
          if (result.success) {
            showToast(
              restoredCount === 0
                ? 'Nothing needed restoring'
                : this.stashSourceCertain
                  ? 'Conflicted files restored — your changes remain in the stash'
                  : 'Conflicted files restored to their committed (HEAD) state',
              'info',
            );
          }
          break;
        }
      }

      if (result.success) {
        if (this.operationType === 'merge' && this.priorFinishCommitLanded) {
          // Only the in-progress develop merge was rolled back — the master
          // merge and version tag from this finish are already committed.
          showToast(
            'The develop merge was aborted, but the master merge and version tag from this finish are already committed',
            'warning',
          );
        } else {
          // The operation banner's Abort reaches these same backend commands
          // and toasts `Aborted merge`. This one — behind an EXTRA in-dialog
          // confirmation, so the more deliberate of the two — said nothing at
          // all for merge/rebase/cherry-pick/revert. Only the stash arm above
          // and the gitflow arm spoke.
          showToast(`Aborted ${this.getOperationTitle().toLowerCase()}`, 'success');
        }
        this.dispatchEvent(
          new CustomEvent('operation-aborted', {
            bubbles: true,
            composed: true,
          })
        );
        this.close();
      } else if (this.abortFailedBecauseNoOperation(result.error?.message)) {
        // The user concluded the operation outside the app (`git merge
        // --abort` / `git commit` in a terminal), so there's nothing left
        // to abort. Escape is suppressed and Complete may be disabled, so
        // without this the full-screen dialog is inescapable. Treat it as
        // concluded and close.
        showToast(
          `This ${this.getOperationTitle().toLowerCase()} was already concluded outside the app`,
          'warning',
        );
        this.dispatchEvent(
          new CustomEvent('operation-aborted', { bubbles: true, composed: true })
        );
        this.close();
      } else {
        console.error('Failed to abort:', result.error);
        showToast(result.error?.message ?? `Failed to abort ${this.getOperationTitle()}`, 'error');
        this.aborting = false; // Allow retry
      }
    } catch (err) {
      console.error('Failed to abort:', err);
      showToast(`Failed to abort ${this.getOperationTitle()}`, 'error');
      this.aborting = false; // Allow retry
    } finally {
      releaseRefOp(lockedRepo);
    }
  }

  /**
   * Skip the stopped pick (`git cherry-pick --skip` / `git revert --skip`).
   *
   * The empty-pick error the backend returns tells the user to "Skip or abort";
   * this is the Skip half. Unlike Abort it KEEPS the picks already applied and
   * resumes the rest of the range, so it is the only exit from an
   * already-applied commit that does not throw the whole range away. Only
   * cherry-pick and revert have a backend skip.
   */
  private async handleSkip(): Promise<void> {
    if (this.operationType !== 'cherry-pick' && this.operationType !== 'revert') return;
    if (
      !this.repositoryPath ||
      this.continuing ||
      this.aborting ||
      this.skipping ||
      this.launchingExternalTool !== null ||
      this.editorToolActive ||
      this.editorResolveDepth > 0 ||
      this.showAbortConfirm
    ) {
      return;
    }

    // Shared working-tree lock — the same claim handleContinue and
    // handleAbortConfirm make, for the same reason: this restores the working
    // tree and must not run beside a discard or a reset.
    const lockedRepo = this.repositoryPath;
    if (!tryAcquireRefOp(lockedRepo)) {
      showToast('Another operation is already running in this repository.', 'warning');
      return;
    }

    this.skipping = true;
    try {
      // Skip drops the stopped pick — and with it every conflict resolution
      // made for it in this dialog. Abort here is behind an explicit confirm
      // for exactly that reason, and the banner's Skip confirms as soon as the
      // repo has conflicted files; a one-click Skip in the surface where the
      // resolution work actually happens was the only unguarded path to that
      // loss. On an empty stop (nothing conflicted, nothing resolved) there is
      // nothing to lose, so it stays a single click there.
      if (this.conflicts.length > 0 || this.resolvedFiles.size > 0) {
        const confirmed = await showConfirm(
          `Skip ${this.getOperationTitle().toLowerCase()}?`,
          `This commit will not be applied and the conflict resolutions for it are ` +
            `discarded. Commits already applied stay, and the rest of the range continues.`,
          'warning',
        );
        if (!confirmed) return;
      }

      const result =
        this.operationType === 'cherry-pick'
          ? await gitService.skipCherryPick({ path: this.repositoryPath })
          : await gitService.skipRevert({ path: this.repositoryPath });

      if (result.success) {
        showToast(`Skipped ${this.getOperationTitle().toLowerCase()}`, 'success');
        this.dispatchEvent(
          new CustomEvent('operation-completed', { bubbles: true, composed: true })
        );
        this.close();
        return;
      }

      // The skip resumed the range and stopped AGAIN on a conflict: reload and
      // stay open, exactly as runContinue's cherry-pick arm does.
      console.error('Failed to skip:', result.error);
      if (
        result.error?.code === 'CHERRY_PICK_CONFLICT' ||
        result.error?.code === 'REVERT_CONFLICT'
      ) {
        await this.loadConflicts();
        if (this.conflicts.length > 0) {
          this.resolvedFiles = new Set();
          this.selectedIndex = 0;
          return;
        }
      }
      showToast(
        result.error?.message ?? `Failed to skip ${this.getOperationTitle().toLowerCase()}`,
        'error',
      );
    } catch (err) {
      console.error('Failed to skip:', err);
      showToast(`Failed to skip ${this.getOperationTitle().toLowerCase()}`, 'error');
    } finally {
      this.skipping = false;
      releaseRefOp(lockedRepo);
    }
  }

  /** True when an abort failed because the operation no longer exists in the
   * repo — the user concluded it outside the app. Detected from the
   * backend/git2 "no ... to abort / not in progress" wording. */
  private abortFailedBecauseNoOperation(message?: string): boolean {
    const m = (message ?? '').toLowerCase();
    return (
      m.includes('no merge to abort') ||
      m.includes('merge_head') ||
      m.includes('no rebase') ||
      m.includes('no cherry') ||
      m.includes('cherry_pick_head') ||
      m.includes('no revert') ||
      m.includes('revert_head') ||
      m.includes('not in progress') ||
      m.includes('nothing to abort')
    );
  }

  /**
   * Close a stash dialog that has nothing to resolve WITHOUT dropping or
   * resetting anything. The backend reported a conflict but nothing was applied,
   * so the changes remain safe in the stash. Used both when the user clicks
   * Complete and automatically when the dialog loads with zero conflicts (which
   * would otherwise be an inescapable trap — Complete disabled, Escape suppressed).
   */
  private handleStashNotApplied(): void {
    showToast(
      this.stashSourceCertain
        ? 'The stash was not applied — your changes are still in the stash'
        : 'No conflicted files remain — nothing to resolve',
      this.stashSourceCertain ? 'warning' : 'info',
    );
    this.dispatchEvent(
      new CustomEvent('operation-aborted', {
        bubbles: true,
        composed: true,
      }),
    );
    this.close();
  }

  private async handleContinue(): Promise<void> {
    // Re-entry guard: a double-click during the awaited backend call must not
    // run the flow twice — a duplicate dropStash would delete an UNRELATED
    // stash entry after the indices shift. Also mutually exclusive with Abort.
    if (
      !this.repositoryPath ||
      this.continuing ||
      this.aborting ||
      this.skipping ||
      this.launchingExternalTool !== null ||
      this.editorToolActive ||
      this.editorResolveDepth > 0 ||
      // The abort confirm is a plain overlay: its backdrop stops the mouse but
      // nothing stopped Enter on a still-focusable "Complete Merge" from
      // committing the merge out from under a confirm that says the resolved
      // changes are about to be thrown away.
      this.showAbortConfirm
    ) {
      return;
    }
    // Claim BEFORE any await so a fast double-click is swallowed by the
    // entry guard above rather than stacking a second confirm/continue —
    // the same claim-before-confirm pattern as the external-tool launcher.
    // The Complete AND Abort buttons' disabled bindings both reflect
    // `continuing`, so claiming here also inerts Abort for the confirm
    // window.
    // Shared working-tree lock — see handleAbortConfirm. A gitflow-finish
    // Complete is a multi-second, multi-command sequence during which every
    // sidebar and graph control otherwise reads the lock as free.
    const lockedContinueRepo = this.repositoryPath;
    if (!tryAcquireRefOp(lockedContinueRepo)) {
      showToast('Another operation is already running in this repository.', 'warning');
      return;
    }

    this.continuing = true;
    try {
      // The editor can hold visible rework that was never Mark-Resolved: a
      // reopened block (Reset), fresh picks, or a mid-typing edit draft. All
      // files still COUNT as resolved (their last Mark Resolved is on disk),
      // so Complete would silently commit that older content — a mere file
      // switch confirms in this state, and completing is far more final.
      const editor = this.shadowRoot?.querySelector('gn-merge-editor') as GnMergeEditor | null;
      if (editor?.hasUnsavedResolutions()) {
        const proceed = await showConfirm(
          'Complete without the latest changes?',
          'This file has picks or edits that were not saved with Mark Resolved — completing uses the last saved content and discards them.',
          'warning',
        );
        if (!proceed) return;
        // Re-check the OTHER exclusion guards after the confirm's await (a
        // tool session or abort may have started). `continuing` is ours.
        if (
          this.aborting ||
          this.launchingExternalTool !== null ||
          this.editorToolActive ||
          this.editorResolveDepth > 0
        ) {
          return;
        }
      }
      await this.runContinue();
    } finally {
      this.continuing = false;
      releaseRefOp(lockedContinueRepo);
    }
  }

  private async runContinue(): Promise<void> {

    // A failed load leaves us with no conflict data even though the index IS
    // conflicted. Never proceed (or drop the stash) in that state — keep the
    // dialog open so the user can Retry.
    if (this.loadFailed) {
      showToast('Could not load conflicts. Please retry.', 'error');
      return;
    }

    // A 'stash' operation with NO conflicts (that LOADED successfully) means the
    // backend reported a conflict but nothing was actually applied — the changes
    // are still safe in the stash. Dropping it here would permanently destroy
    // never-applied changes, so refuse to drop and close without touching the stash.
    if (this.operationType === 'stash' && this.conflicts.length === 0) {
      this.handleStashNotApplied();
      return;
    }

    // Check all conflicts are resolved
    const unresolvedCount = this.conflicts.filter(
      (c) => !this.resolvedFiles.has(c.path)
    ).length;

    if (unresolvedCount > 0) {
      showToast(
        `Please resolve all ${unresolvedCount} remaining conflict(s) before continuing.`,
        'warning'
      );
      return;
    }

    try {
      let result;
      // A rebase that finishes here may have dropped commits whose patch is
      // already on the target — across every leg, not just this one. The
      // backend carries the running total over each conflict pause; this is
      // the only surface that can report it, so the completion toast says so
      // in the same words the four direct-rebase toasts use.
      let completionSuffix = '';
      switch (this.operationType) {
        case 'rebase':
          result = await gitService.continueRebase({ path: this.repositoryPath });
          if (!result.success) {
            // A PAUSE is not a failure. `git rebase --continue` stops again at
            // the next `edit`/`break` line, and the remedy — amend the commit —
            // lives in the commit panel, outside this dialog. Staying open
            // would trap the user: there is no ×, Escape is swallowed, the
            // backdrop is inert, and the only working exit is Abort, which
            // discards the whole rebase. Close and let the banner drive the
            // next Continue, exactly as the initial execute does.
            if (result.error?.code === 'REBASE_PAUSED') {
              showToast(
                REBASE_PAUSED_MESSAGE,
                'warning',
                8000,
              );
              this.dispatchEvent(
                new CustomEvent('operation-completed', { bubbles: true, composed: true }),
              );
              this.close();
              return;
            }
            console.error('Failed to continue rebase:', result.error);
            // Might have more conflicts — reload and stay open if any appeared.
            await this.loadConflicts();
            if (this.conflicts.length > 0) {
              this.resolvedFiles = new Set();
              this.selectedIndex = 0;
              return;
            }
            // No new conflicts, but the operation genuinely failed — surface the
            // error and keep the dialog open instead of falsely reporting success.
            showToast(result.error?.message ?? 'Failed to continue rebase', 'error');
            return;
          }
          completionSuffix = skippedCommitsSuffix(result.data);
          break;
        case 'cherry-pick':
          result = await gitService.continueCherryPick({ path: this.repositoryPath });
          if (!result.success) {
            console.error('Failed to continue cherry-pick:', result.error);
            if (result.error?.code === 'CHERRY_PICK_CONFLICT') {
              await this.loadConflicts();
              if (this.conflicts.length > 0) {
                this.resolvedFiles = new Set();
                this.selectedIndex = 0;
                return;
              }
            }
            showToast(result.error?.message ?? 'Failed to continue cherry-pick', 'error');
            return;
          }
          break;
        case 'revert':
          result = await gitService.continueRevert({ path: this.repositoryPath });
          if (!result.success) {
            console.error('Failed to continue revert:', result.error);
            if (result.error?.code === 'REVERT_CONFLICT') {
              await this.loadConflicts();
              if (this.conflicts.length > 0) {
                this.resolvedFiles = new Set();
                this.selectedIndex = 0;
                return;
              }
            }
            showToast(result.error?.message ?? 'Failed to continue revert', 'error');
            return;
          }
          break;
        case 'merge':
          // Commit the in-progress merge. When the failed operation was a squash
          // (e.g. a git-flow squash finish), complete it as a single-parent squash
          // commit rather than a two-parent merge commit. If a previous Continue
          // already committed the merge but the git-flow completion step failed,
          // skip straight to that step — re-running commitMerge would fail with
          // "No merge in progress" and make retry impossible.
          if (!this.mergeCommitted) {
            result = await gitService.commitMerge(this.repositoryPath, undefined, this.squashMerge);
            if (!result.success) {
              console.error('Failed to complete merge:', result.error);
              if (result.error?.code === 'MERGE_CONFLICT') {
                await this.loadConflicts();
                if (this.conflicts.length > 0) {
                  this.resolvedFiles = new Set();
                  this.selectedIndex = 0;
                  return;
                }
              }
              showToast(result.error?.message ?? 'Failed to complete merge', 'error');
              return;
            }
            this.mergeCommitted = true;
          }
          // If this merge was one side of a git-flow finish, the finish is only
          // PARTIALLY done (no tag, develop not merged, branch not deleted).
          // Complete it now; if it can't finish (routed back into the conflict
          // flow, or errored) stay open — the retry skips the committed merge.
          if (this.gitflowFinish && !(await this.completeGitflowFinish(this.gitflowFinish))) {
            return;
          }
          break;
        case 'stash': {
          // All conflicts resolved. Drop the stash only for pop semantics
          // (dropAfter/pop/auto-stash) — a plain apply must keep the stash entry.
          if (this.dropStashOnComplete) {
            // Drop ONLY via the identity captured at OPEN — never by a
            // blind index, not even as a fallback. The list can shift
            // under the dialog (an external `git stash push` puts new WIP
            // at index 0), so any index read after open — including a
            // "fresh capture" at Complete time — can name the wrong entry.
            // Skipping the drop (with a warning) is always safer than
            // dropping the wrong one.
            let dropIndex: number | null = null;
            if (this.stashOidToDrop !== null) {
              const stashes = await gitService.getStashes(this.repositoryPath);
              if (stashes.success && stashes.data) {
                const found = stashes.data.findIndex((s) => s.oid === this.stashOidToDrop);
                if (found >= 0) {
                  dropIndex = found;
                }
              }
            }
            if (dropIndex === null) {
              showToast(
                'Could not verify the stash entry — it was left in the stash list',
                'warning',
              );
            }
            if (dropIndex !== null) {
              result = await gitService.dropStash({ path: this.repositoryPath, index: dropIndex });
              if (!result.success) {
                // The conflict resolution and the stash APPLY already
                // succeeded — only removing the (now-redundant) stash entry
                // failed. That entry lingering is recoverable, so this is
                // NOT an operation failure: warn, but still complete like
                // the unverifiable-identity branch above, or the pinned
                // repo would never get refreshed and the dialog would
                // dead-end on an already-applied stash.
                console.error('Failed to drop stash:', result.error);
                showToast(
                  `${result.error?.message ?? 'Failed to drop stash'} — it was left in the stash list`,
                  'warning',
                );
              }
            }
          }
          break;
        }
      }

      // The banner's Abort toasts; this dialog's Complete said nothing, so the
      // full-screen dialog simply vanished with no statement that the merge
      // commit was created — the same gesture that, had it failed, produces a
      // red toast. (The paused-rebase branch above returns before this and
      // carries its own, different message.)
      showToast(`${this.getOperationTitle()} completed${completionSuffix}`, 'success');
      this.dispatchEvent(
        new CustomEvent('operation-completed', {
          bubbles: true,
          composed: true,
        })
      );
      this.close();
    } catch (err) {
      console.error('Failed to continue:', err);
      showToast('Failed to continue', 'error');
    }
  }

  /**
   * Complete a git-flow finish whose merge just conflicted and was resolved.
   * Returns true when the finish is fully done (caller may close), false when the
   * dialog must stay open (a further conflict was routed back in, or an error was
   * surfaced via toast).
   */
  private async completeGitflowFinish(ctx: GitflowFinishContext): Promise<boolean> {
    // Squash feature: commitMerge already made the single-parent squash commit on
    // develop. Re-invoking the backend finish would re-merge the same divergence —
    // a squash commit never makes the feature an ancestor of develop — so the
    // remaining branch deletion is done here instead.
    if (ctx.kind === 'feature' && this.squashMerge) {
      // The backend only records a completion marker for squash commits IT
      // created, and this one was created here. Record it BEFORE the optional
      // delete: if the delete is blocked (e.g. a preventDeletion rule) the
      // feature stays listed as active, and the user's next "Squash and Finish"
      // must find the marker and do cleanup only — without it the finish
      // re-conflicts and resolving mints a SECOND squash commit on develop.
      const recorded = await gitService.gitFlowRecordSquashFinish(this.repositoryPath, ctx.name);
      if (!recorded.success) {
        // The squash commit has landed either way, so this is not a failure of
        // the finish — but an unrecorded squash makes a retry duplicate it, so
        // the user has to be told rather than finding out on the retry.
        showToast(
          `${recorded.error?.message ?? 'Failed to record the completed squash'} — the squash commit landed; do not re-run the squash finish for "${ctx.name}"`,
          'warning',
        );
      }
      if (ctx.deleteBranch) {
        const del = await gitService.deleteBranch(this.repositoryPath, ctx.branchName, true);
        if (!del.success) {
          // The squash commit has already landed — deleting the branch is the
          // optional last step. Treating its failure (e.g. a preventDeletion
          // branch rule) as "finish incomplete" left the dialog stuck on a
          // fully-resolved conflict list with no way forward but closing it.
          showToast(
            `${del.error?.message ?? 'Failed to delete feature branch'} — the squash commit landed`,
            'warning',
          );
        }
      }
      return true;
    }

    // Feature (non-squash), release, hotfix: the resolved merge is committed, so
    // re-invoking the (now idempotent) backend finish skips the up-to-date
    // master/develop merges, creates the version tag (release/hotfix), and deletes
    // the branch.
    let result: CommandResult<gitService.GitFlowFinishResult>;
    switch (ctx.kind) {
      case 'feature':
        result = await gitService.gitFlowFinishFeature(
          this.repositoryPath,
          ctx.name,
          ctx.deleteBranch,
          false,
        );
        break;
      case 'release':
        result = await gitService.gitFlowFinishRelease(
          this.repositoryPath,
          ctx.name,
          ctx.tagMessage,
          ctx.deleteBranch,
        );
        break;
      case 'hotfix':
        result = await gitService.gitFlowFinishHotfix(
          this.repositoryPath,
          ctx.name,
          ctx.tagMessage,
          ctx.deleteBranch,
        );
        break;
    }

    if (!result.success) {
      // A develop-side conflict on the re-run (e.g. release/hotfix master side was
      // just resolved) reopens the conflict flow for the develop side. The next
      // Complete must commit THIS new merge before re-invoking finish, so the
      // committed-merge marker is reset — otherwise commitMerge would be skipped
      // and the finish re-run would hit the still-in-progress develop merge.
      if (result.error?.code === 'MERGE_CONFLICT') {
        // A MERGE_CONFLICT from the finish re-run always means a NEW merge is
        // in progress — reset the committed marker BEFORE loading conflicts,
        // so even a failed load (Retry path) leads Complete to commit this
        // merge instead of skipping it and stranding the finish. Remember
        // that a prior commit from this finish (master merge + tag) already
        // landed, so a later Abort can be honest about what survives.
        this.mergeCommitted = false;
        this.priorFinishCommitLanded = true;
        await this.loadConflicts();
        if (this.conflicts.length > 0) {
          this.resolvedFiles = new Set();
          this.selectedIndex = 0;
          return false;
        }
        if (this.loadFailed) {
          // Index is conflicted but unreadable — stay open with the Retry
          // affordance rather than falling through to a misleading toast.
          return false;
        }
      }
      showToast(result.error?.message ?? 'Failed to complete Git Flow finish', 'error');
      return false;
    }

    // The finish can succeed while a branch rule blocks its branch deletion —
    // say so, or the branch silently survives the finish.
    if (result.data?.branchKeptReason) {
      showToast(result.data.branchKeptReason, 'warning');
    }
    return true;
  }

  private get selectedConflict(): ConflictFile | null {
    return this.conflicts[this.selectedIndex] ?? null;
  }

  private get resolvedCount(): number {
    return this.resolvedFiles.size;
  }

  private get totalCount(): number {
    return this.conflicts.length;
  }

  private getOperationTitle(): string {
    switch (this.operationType) {
      case 'merge':
        return 'Merge';
      case 'rebase':
        return 'Rebase';
      case 'cherry-pick':
        return 'Cherry-pick';
      case 'revert':
        return 'Revert';
      case 'stash':
        return 'Stash';
      default:
        return 'Merge';
    }
  }

  /** The pinned repo's name. The dialog stays bound to the repo the
   * operation started on even when another tab is active — without naming
   * it, a user who switched tabs mid-operation has no way to tell whose
   * merge Complete/Abort will hit. */
  private get repositoryName(): string {
    const path = this.repositoryPath ?? '';
    return path.split(/[\\/]/).filter(Boolean).pop() ?? '';
  }

  render() {
    if (!this.open) return nothing;

    return html`
      <div class="backdrop"></div>
      <!-- tabindex="-1" so the open pass above can put focus inside the
           dialog; it is not a tab stop of its own. -->
      <div class="dialog" role="dialog" aria-modal="true" tabindex="-1">
        <div class="header">
          <div>
            <div class="header-title">
              Resolve ${this.getOperationTitle()} Conflicts
            </div>
            <div class="header-subtitle">
              ${this.resolvedCount} of ${this.totalCount} file${this.totalCount === 1 ? '' : 's'} resolved${this.repositoryName ? ` · ${this.repositoryName}` : ''}
            </div>
          </div>
          <div class="header-actions">
            <div class="nav-buttons">
              <button
                class="nav-btn"
                @click=${this.handlePrevious}
                ?disabled=${this.selectedIndex === 0 || this.editorResolveDepth > 0}
                title="Previous file (Alt+Up)"
              >
                ← Prev
              </button>
              <button
                class="nav-btn"
                @click=${this.handleNext}
                ?disabled=${this.selectedIndex >= this.conflicts.length - 1 ||
                this.editorResolveDepth > 0}
                title="Next file (Alt+Down)"
              >
                Next →
              </button>
            </div>
          </div>
        </div>

        <div class="content">
          <div class="file-list">
            <div class="file-list-header">
              Conflicted Files (${this.totalCount})
              ${this.detectedMergeTool ? html`
                <div style="font-size: 10px; text-transform: none; letter-spacing: normal; font-weight: normal; margin-top: 4px; color: var(--color-text-muted);">
                  ${this.detectedMergeTool} detected. Configure in Settings for external editing.
                </div>
              ` : nothing}
            </div>
            ${this.loading
              ? html`<div class="loading">Loading...</div>`
              : this.conflicts.map(
                  (conflict, index) => html`
                    <div
                      class="file-item ${index === this.selectedIndex ? 'selected' : ''} ${this.resolvedFiles.has(conflict.path) ? 'resolved' : ''}"
                      @click=${() => this.handleFileSelect(index)}
                    >
                      <span
                        class="file-icon ${this.resolvedFiles.has(conflict.path) ? 'resolved' : 'conflict'}"
                      >
                        ${this.resolvedFiles.has(conflict.path) ? '✓' : '⚠'}
                      </span>
                      <span class="file-name" title=${conflict.path}>
                        ${conflict.path.split('/').pop()}
                        ${conflict.path.includes('/')
                          ? html`<span class="file-dir">${conflict.path.slice(0, conflict.path.lastIndexOf('/'))}</span>`
                          : nothing}
                      </span>
                      ${this.hasMergeTool && !this.resolvedFiles.has(conflict.path) ? html`
                        <button
                          class="btn btn-sm"
                          style="margin-left: auto; padding: 2px 6px; font-size: 11px;"
                          @click=${(e: Event) => { e.stopPropagation(); this.handleOpenExternalTool(conflict.path); }}
                          ?disabled=${this.launchingExternalTool !== null ||
                          this.aborting ||
                          this.continuing ||
                          this.skipping ||
                          this.editorToolActive ||
                          this.editorResolveDepth > 0}
                          title="Open in external merge tool"
                        >
                          ${this.launchingExternalTool === conflict.path ? '...' : 'External'}
                        </button>
                      ` : nothing}
                    </div>
                  `
                )}
          </div>

          <div class="editor-container">
            ${this.selectedConflict
              ? html`
                  <gn-merge-editor
                    .repositoryPath=${this.repositoryPath}
                    .conflictFile=${this.selectedConflict}
                    .operationType=${this.operationType}
                    .externalToolLocked=${this.continuing ||
                    this.aborting ||
                    this.skipping ||
                    this.launchingExternalTool !== null}
                    @conflict-resolved=${this.handleConflictResolved}
                    @external-tool-started=${() => { this.editorToolActive = true; }}
                    @external-tool-finished=${this.handleEditorToolFinished}
                    @resolve-started=${() => {
                      this.editorResolveDepth++;
                    }}
                    @resolve-finished=${() => {
                      this.editorResolveDepth = Math.max(0, this.editorResolveDepth - 1);
                    }}
                  ></gn-merge-editor>
                `
              : html`
                  <div class="empty-state">
                    ${this.loading
                      ? 'Loading conflicts...'
                      : this.loadFailed
                        ? html`
                            <div>Failed to load conflicts.</div>
                            <button
                              class="btn btn-primary"
                              style="margin-top: var(--spacing-md);"
                              @click=${this.handleRetryLoad}
                            >
                              Retry
                            </button>
                          `
                        : this.conflicts.length === 0
                          ? 'No conflicts to resolve'
                          : 'Select a file to resolve'}
                  </div>
                `}
          </div>
        </div>

        <div class="footer">
          <div class="footer-info">
            ${this.selectedConflict
              ? html`<strong>${this.selectedConflict.path}</strong>`
              : 'No file selected'}
          </div>
          <div class="footer-actions">
            <button
              class="btn btn-danger"
              @click=${this.handleAbort}
              ?disabled=${this.continuing ||
                this.aborting ||
                this.skipping ||
                this.launchingExternalTool !== null ||
                this.editorToolActive ||
                this.editorResolveDepth > 0 ||
                this.showAbortConfirm}
            >
              Abort ${this.getOperationTitle()}
            </button>
            ${this.operationType === 'cherry-pick' || this.operationType === 'revert'
              ? html`
                  <button
                    class="btn skip-btn"
                    @click=${this.handleSkip}
                    ?disabled=${this.continuing ||
                      this.aborting ||
                      this.skipping ||
                      this.launchingExternalTool !== null ||
                      this.editorToolActive ||
                      this.editorResolveDepth > 0 ||
                      this.showAbortConfirm}
                    title="Do not apply this commit; keep the picks already applied and continue with the rest"
                  >
                    Skip ${this.getOperationTitle()}
                  </button>
                `
              : nothing}
            <button
              class="btn btn-primary"
              @click=${this.handleContinue}
              ?disabled=${this.continuing ||
                this.aborting ||
                this.skipping ||
                this.launchingExternalTool !== null ||
                this.editorToolActive ||
                this.editorResolveDepth > 0 ||
                // Matches handleContinue's guard so the button is not a dead
                // control while the abort confirm is up.
                this.showAbortConfirm ||
                this.loadFailed ||
                this.resolvedCount < this.totalCount ||
                (this.operationType === 'stash' && this.conflicts.length === 0)}
            >
              ${this.operationType === 'merge'
                ? 'Complete Merge'
                : this.operationType === 'stash'
                  ? 'Complete'
                  : `Continue ${this.getOperationTitle()}`}
            </button>
          </div>
        </div>

        ${this.showAbortConfirm
          ? html`
              <div class="confirm-overlay">
                <div class="confirm-dialog">
                  <div class="confirm-title">Abort ${this.getOperationTitle()}?</div>
                  <div class="confirm-message">
                    ${this.operationType === 'stash'
                      ? this.stashSourceCertain
                        ? 'The conflicted files will be reverted to their committed (HEAD) state, discarding the applied stash changes in those files. Any unrelated uncommitted changes are kept, and the stash entry itself remains in the stash list.'
                        : 'The conflicted files will be reverted to their committed (HEAD) state, discarding those changes. If they did not come from a stash apply, they are not saved anywhere else — this cannot be undone.'
                      : 'All resolved changes will be lost. This cannot be undone.'}
                  </div>
                  <div class="confirm-actions">
                    <button class="btn" @click=${this.handleAbortCancel}>Cancel</button>
                    <button class="btn btn-danger" @click=${this.handleAbortConfirm}>
                      Abort
                    </button>
                  </div>
                </div>
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-conflict-resolution-dialog': GnConflictResolutionDialog;
  }
}
