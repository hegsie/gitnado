/**
 * Merge Editor Component
 * A 3-way merge editor for resolving conflicts (Beyond Compare style)
 *
 * Layout:
 * +------------------+------------------+------------------+
 * |      OURS        |       BASE       |      THEIRS      |
 * |  (Current Branch)|    (Ancestor)    |    (Incoming)    |
 * +------------------+------------------+------------------+
 * |                     OUTPUT (Editable)                  |
 * +-------------------------------------------------------+
 *
 * Conflict markers (<<<<<<< / ======= / >>>>>>>) are an internal, on-disk
 * representation ONLY. They are parsed once into structured segments when the
 * file loads and are never rendered anywhere in the UI. The output pane is a
 * list of segments: resolved text (editable in place) and conflict blocks
 * (ours/theirs side by side with Use Ours / Use Theirs / Use Both / Edit
 * actions). The file is only written back once no conflict blocks remain, so
 * markers can never round-trip into a "resolved" file.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { codeStyles } from '../../styles/code-styles.ts';
import * as gitService from '../../services/git.service.ts';
import * as aiService from '../../services/ai.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import { CodeRenderMixin } from '../../mixins/code-render-mixin.ts';
import type { ConflictFile } from '../../types/git.types.ts';
import {
  isWhitespaceOnlyChange,
  computeInlineWhitespaceDiff,
  alignThreeWay,
  type ThreeWayRow,
} from '../../utils/diff-utils.ts';

export type MergeOperationType = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'stash';

type SegmentOrigin = 'ours' | 'theirs' | 'both' | 'base' | 'manual' | 'ai';

interface OutputSegment {
  id: number;
  type: 'resolved' | 'conflict';
  /** Resolved output lines (empty while type === 'conflict'). */
  lines: string[];
  /** Conflict side content — kept after resolution so the block can be reset. */
  oursLines: string[];
  theirsLines: string[];
  oursLabel: string;
  theirsLabel: string;
  /** How a resolved segment was produced (colors the gutter). */
  origin: SegmentOrigin | null;
  /** True when a resolved segment came from a conflict block (enables Reset). */
  fromConflict: boolean;
}

/** Per-operation pane labels: during a rebase the sides are semantically
 * swapped (ours = the branch being rebased onto, theirs = your own commit). */
const SIDE_LABELS: Record<MergeOperationType, { ours: string; theirs: string }> = {
  merge: { ours: 'Ours (Current Branch)', theirs: 'Theirs (Incoming)' },
  rebase: { ours: 'Ours (Rebasing Onto)', theirs: 'Theirs (Your Commit)' },
  'cherry-pick': { ours: 'Ours (Current Branch)', theirs: 'Theirs (Picked Commit)' },
  revert: { ours: 'Ours (Current Branch)', theirs: 'Theirs (Revert Changes)' },
  stash: { ours: 'Ours (Working Tree)', theirs: 'Theirs (Stashed Changes)' },
};

const ORIGIN_LABELS: Record<SegmentOrigin, string> = {
  ours: 'Ours',
  theirs: 'Theirs',
  both: 'Both',
  base: 'Base',
  manual: 'Edited',
  ai: 'AI',
};

@customElement('gn-merge-editor')
export class GnMergeEditor extends CodeRenderMixin(LitElement) {
  static styles = [
    sharedStyles,
    codeStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: var(--color-bg-primary);
      }

      .toolbar {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-bg-secondary);
        border-bottom: 1px solid var(--color-border);
      }

      .toolbar-title {
        flex: 1;
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .toolbar-actions {
        display: flex;
        gap: var(--spacing-sm);
      }

      .btn {
        padding: var(--spacing-xs) var(--spacing-sm);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        border: 1px solid var(--color-border);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        transition: all var(--transition-fast);
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
        color: var(--color-text-inverse);
        border-color: var(--color-primary);
      }

      .btn-primary:hover:not(:disabled) {
        background: var(--color-primary-hover);
      }

      .btn-ours {
        background: rgba(var(--color-success-rgb, 34, 197, 94), 0.15);
        border-color: var(--color-success);
        color: var(--color-success);
      }

      .btn-ours:hover:not(:disabled) {
        background: rgba(var(--color-success-rgb, 34, 197, 94), 0.25);
      }

      .btn-theirs {
        background: rgba(var(--color-info-rgb, 59, 130, 246), 0.15);
        border-color: var(--color-info);
        color: var(--color-info);
      }

      .btn-theirs:hover:not(:disabled) {
        background: rgba(var(--color-info-rgb, 59, 130, 246), 0.25);
      }

      .btn-both {
        background: rgba(168, 85, 247, 0.15);
        border-color: #a855f7;
        color: #a855f7;
      }

      .btn-both:hover:not(:disabled) {
        background: rgba(168, 85, 247, 0.25);
      }

      .editor-container {
        display: flex;
        flex-direction: column;
        flex: 1;
        overflow: hidden;
      }

      .source-panels {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        height: 50%;
        min-height: 200px;
        border-bottom: 2px solid var(--color-border);
      }

      .output-panel {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 200px;
      }

      .editor-panel {
        display: flex;
        flex-direction: column;
        border-right: 1px solid var(--color-border);
        overflow: hidden;
      }

      .editor-panel:last-child {
        border-right: none;
      }

      .panel-header {
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border-bottom: 1px solid var(--color-border);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-secondary);
        text-align: center;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--spacing-sm);
      }

      .panel-header.ours {
        background: rgba(var(--color-success-rgb, 34, 197, 94), 0.1);
        color: var(--color-success);
      }

      .panel-header.base {
        background: rgba(var(--color-text-muted-rgb, 128, 128, 128), 0.1);
        color: var(--color-text-muted);
      }

      .panel-header.theirs {
        background: rgba(var(--color-info-rgb, 59, 130, 246), 0.1);
        color: var(--color-info);
      }

      .panel-header.output {
        background: rgba(var(--color-warning-rgb, 234, 179, 8), 0.1);
        color: var(--color-warning);
      }

      .panel-header-btn {
        padding: 2px 6px;
        font-size: var(--font-size-xs);
        border-radius: var(--radius-xs);
        cursor: pointer;
        border: 1px solid currentColor;
        background: transparent;
        color: inherit;
        opacity: 0.8;
      }

      .panel-header-btn:hover {
        opacity: 1;
        background: rgba(255, 255, 255, 0.1);
      }

      .panel-content {
        flex: 1;
        overflow: auto;
        font-family: var(--font-family-mono);
        font-size: var(--font-size-sm);
        line-height: 1.5;
        background: var(--color-bg-primary);
      }

      .panel-content.readonly {
        background: var(--color-bg-secondary);
      }

      .code-view {
        display: table;
        width: 100%;
        border-collapse: collapse;
      }

      .code-line {
        display: table-row;
      }

      .code-line:hover {
        background: var(--color-bg-hover);
      }

      .line-number {
        display: table-cell;
        width: 40px;
        padding: 0 var(--spacing-sm);
        text-align: right;
        color: var(--color-text-muted);
        background: var(--color-bg-tertiary);
        border-right: 1px solid var(--color-border);
        user-select: none;
        font-size: var(--font-size-xs);
      }

      .line-content {
        display: table-cell;
        padding: 0 var(--spacing-sm);
        white-space: pre-wrap;
        word-break: break-all;
      }

      .line-changed {
        background: rgba(var(--color-warning-rgb, 234, 179, 8), 0.2);
      }

      .line-changed .line-number {
        background: rgba(var(--color-warning-rgb, 234, 179, 8), 0.3);
      }

      .line-removed-filler .line-content {
        background: repeating-linear-gradient(
          -45deg,
          transparent,
          transparent 4px,
          rgba(var(--color-text-muted-rgb, 128, 128, 128), 0.12) 4px,
          rgba(var(--color-text-muted-rgb, 128, 128, 128), 0.12) 8px
        );
      }

      /* Resolved-segment origin highlighting in output */
      .output-segment.resolved-ours .line-number {
        border-left: 3px solid var(--color-success);
      }

      .output-segment.resolved-ours .line-content {
        background: rgba(var(--color-success-rgb, 34, 197, 94), 0.1);
      }

      .output-segment.resolved-theirs .line-number {
        border-left: 3px solid var(--color-info);
      }

      .output-segment.resolved-theirs .line-content {
        background: rgba(var(--color-info-rgb, 59, 130, 246), 0.1);
      }

      .output-segment.resolved-both .line-number,
      .output-segment.resolved-ai .line-number {
        border-left: 3px solid #a855f7;
      }

      .output-segment.resolved-both .line-content,
      .output-segment.resolved-ai .line-content {
        background: rgba(168, 85, 247, 0.1);
      }

      .output-segment.resolved-manual .line-number {
        border-left: 3px solid var(--color-warning);
      }

      .output-segment.resolved-manual .line-content {
        background: rgba(var(--color-warning-rgb, 234, 179, 8), 0.08);
      }

      .output-segment {
        position: relative;
      }

      .segment-actions {
        position: absolute;
        top: 2px;
        right: var(--spacing-sm);
        display: none;
        gap: var(--spacing-xs);
        align-items: center;
        z-index: 1;
      }

      .output-segment:hover .segment-actions {
        display: flex;
      }

      .segment-origin-chip {
        font-size: 10px;
        font-weight: var(--font-weight-bold);
        text-transform: uppercase;
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--color-border);
        color: var(--color-text-muted);
        background: var(--color-bg-secondary);
      }

      .segment-btn {
        padding: 1px 6px;
        font-size: var(--font-size-xs);
        border-radius: var(--radius-sm);
        cursor: pointer;
        border: 1px solid var(--color-border);
        background: var(--color-bg-secondary);
        color: var(--color-text-primary);
      }

      .segment-btn:hover {
        background: var(--color-bg-hover);
      }

      /* Inline segment editing */
      .segment-editor {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-primary);
        border-radius: var(--radius-sm);
        margin: 2px 0;
        background: var(--color-bg-primary);
      }

      .segment-editor textarea {
        width: 100%;
        border: none;
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-family: var(--font-family-mono);
        font-size: var(--font-size-sm);
        line-height: 1.5;
        resize: vertical;
        white-space: pre;
        tab-size: 4;
      }

      .segment-editor textarea:focus {
        outline: none;
      }

      .segment-editor-actions {
        display: flex;
        gap: var(--spacing-sm);
        justify-content: flex-end;
      }

      /* Side-by-side conflict block body */
      .conflict-sides {
        display: grid;
        grid-template-columns: 1fr 1px 1fr;
        align-items: stretch;
      }

      .conflict-side-empty {
        padding: var(--spacing-xs) var(--spacing-sm);
        color: var(--color-text-muted);
        font-style: italic;
        font-size: var(--font-size-xs);
      }

      /* Placeholder row for a resolution that removed all lines — keeps the
         segment hoverable so its Edit/Reset actions stay reachable */
      .segment-empty-note {
        color: var(--color-text-muted);
        font-style: italic;
        font-size: var(--font-size-xs);
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--color-text-muted);
      }

      .empty {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--color-text-muted);
        font-style: italic;
      }

      .output-error {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--spacing-md);
        height: 100%;
        color: var(--color-text-muted);
      }

      .diff-indicator {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-left: var(--spacing-xs);
      }

      .panel-stats {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        margin-left: auto;
      }

      .conflict-pick-btn {
        padding: 2px 8px;
        font-size: var(--font-size-xs);
      }

      .conflict-count {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        margin-left: auto;
      }

      .btn-ai {
        background: rgba(168, 85, 247, 0.15);
        border-color: #a855f7;
        color: #a855f7;
      }

      .btn-ai:hover:not(:disabled) {
        background: rgba(168, 85, 247, 0.25);
      }

      .ai-explanation {
        padding: var(--spacing-xs) var(--spacing-sm);
        background: rgba(168, 85, 247, 0.08);
        border-left: 3px solid #a855f7;
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        margin: var(--spacing-xs) 0;
      }
    `,
  ];

  @property({ type: String }) repositoryPath = '';
  @property({ type: Object }) conflictFile: ConflictFile | null = null;
  /** Which git operation produced the conflict — controls the side labels. */
  @property({ type: String }) operationType: MergeOperationType = 'merge';
  /**
   * Set by the host while its own destructive flows (abort/complete) run —
   * launching an external tool then would race them.
   */
  @property({ type: Boolean }) externalToolLocked = false;

  @state() private baseContent = '';
  @state() private oursContent = '';
  @state() private theirsContent = '';
  @state() private segments: OutputSegment[] = [];
  @state() private loading = false;
  @state() private loadFailed = false;
  /**
   * True after a take-side that DELETED the file while it is still on
   * screen (the last file has no auto-advance target). Terminal: the
   * output pane shows a "file deleted" notice, and every write path is
   * inert — reloading instead would fail the workdir read into an
   * alarming error whose verbatim button would resurrect the file, and an
   * empty resolved state would let Mark Resolved write a 0-byte file.
   */
  @state() private resolvedAsDeleted = false;
  /** Terminal state after a NON-deletion chooser resolution (binary /
   * submodule take-side): there is no text pipeline to reload into, and
   * re-rendering the chooser with live buttons invites a second click
   * that errors "No conflict found" on an already-resolved file. */
  @state() private resolvedInPlace = false;
  @state() private launchingExternalTool = false;
  @state() private confirmingWholeFileOverwrite = false;
  @state() private hasMergeTool = false;
  @state() private aiAvailable = false;
  /**
   * Set when AI is unavailable *and* a provider is chosen in Settings. The AI
   * actions then stay on screen but disabled, carrying the reason: they worked
   * until the chosen provider stopped answering, and silently removing them
   * leaves the user with no way to find out why. When no provider was ever
   * configured the actions stay hidden, as before.
   */
  @state() private aiBlockedReason = '';
  @state() private suggestingSegment: number | null = null;
  @state() private suggestingAll = false;
  /** True while a resolve/take-side backend call is in flight. */
  @state() private resolving = false;
  @state() private editingSegmentId: number | null = null;
  @state() private editDraft = '';
  @state() private aiExplanations: Map<number, string> = new Map();

  private nextSegmentId = 1;
  /** Invalidates in-flight loads when a newer one starts (rapid file switches). */
  private loadEpoch = 0;
  /** Ownership tokens so stale async completions can't clobber newer state. */
  private resolveToken = 0;
  private aiResolveAllToken = 0;
  private baseLines: string[] = [];
  private oursLines: string[] = [];
  private theirsLines: string[] = [];
  /** Per-pane read failures — that pane shows an error, not fake content. */
  private sideReadErrors = { base: false, ours: false, theirs: false };
  private alignmentRows: ThreeWayRow[] = [];
  /** Guards against scroll-sync feedback loops between the panes. */
  private syncingScroll = false;

  private boundHandleAiSettingsChanged = async () => {
    await this.refreshAiAvailability();
  };

  private async refreshAiAvailability(): Promise<void> {
    this.aiAvailable = await aiService.isAiAvailable();
    if (this.aiAvailable) {
      this.aiBlockedReason = '';
      return;
    }
    const unavailable = await aiService.getAiUnavailableReason();
    this.aiBlockedReason = unavailable?.providerSelected ? unavailable.reason : '';
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('ai-settings-changed', this.boundHandleAiSettingsChanged);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('ai-settings-changed', this.boundHandleAiSettingsChanged);
  }

  async updated(changedProperties: Map<string, unknown>): Promise<void> {
    if (changedProperties.has('conflictFile') && this.conflictFile) {
      await this.loadContents();
    }
    if (changedProperties.has('repositoryPath') && this.repositoryPath) {
      await this.checkMergeToolAvailability();
      await this.refreshAiAvailability();
    }
  }

  private async checkMergeToolAvailability(): Promise<void> {
    if (!this.repositoryPath) return;
    try {
      const result = await gitService.getMergeToolConfig(this.repositoryPath);
      this.hasMergeTool = result.success && !!result.data?.toolName;
    } catch {
      this.hasMergeTool = false;
    }
  }

  private async handleOpenExternalMergeTool(): Promise<void> {
    if (
      !this.repositoryPath ||
      !this.conflictFile ||
      this.externalToolLocked ||
      this.launchingExternalTool ||
      this.confirmingWholeFileOverwrite ||
      this.resolving ||
      this.resolvedAsDeleted ||
      // A chooser/verbatim take-side or gitlink resolution leaves the file
      // in this terminal state — launching the tool on a no-longer-
      // conflicted file (and locking the dialog's Complete/Abort behind
      // editorToolActive) must not be possible.
      this.resolvedInPlace
    ) {
      return;
    }

    const file = this.conflictFile;
    // Claim the launch BEFORE any await: the confirm below yields to the
    // event loop, and a second click landing in that window would pass the
    // entry guard again — two tool sessions editing the same file.
    this.launchingExternalTool = true;
    // The tool edits the ON-DISK file, which doesn't have the editor's
    // unsaved picks — its output will replace them on reload. Confirm first.
    if (this.hasUnsavedResolutions()) {
      let proceed = false;
      try {
        proceed = await showConfirm(
          'Discard in-progress resolution?',
          'The external tool works on the file as saved on disk — your unsaved picks here will be replaced by its result.',
          'warning',
        );
      } finally {
        if (!proceed) this.launchingExternalTool = false;
      }
      if (!proceed) return;
      // Re-check after the await: the HOST's Abort/Complete are not
      // disabled during this confirm — editorToolActive is only set below,
      // and the internal launch claim is invisible to the dialog — so an
      // abort/complete/resolve or a file switch may have happened while
      // the confirm was up. Launching now would edit a file the operation
      // no longer owns (e.g. write stale conflict text into a post-abort
      // clean tree). Same re-check as every sibling confirm.
      if (
        this.externalToolLocked ||
        this.resolving ||
        this.resolvedAsDeleted ||
        this.resolvedInPlace ||
        this.conflictFile !== file
      ) {
        this.launchingExternalTool = false;
        return;
      }
    }

    // Tell the host a tool session is open so its Abort/Complete stay inert —
    // they would otherwise race the tool's eventual save.
    this.dispatchEvent(
      new CustomEvent('external-tool-started', { bubbles: true, composed: true })
    );
    // Handed to the host with the finished event: the tool may have changed
    // what get_conflicts reports for this file (markerSize, hunks), and the
    // host's stale ConflictFile object would misparse its output.
    let freshConflicts: ConflictFile[] | null = null;
    try {
      const result = await gitService.launchMergeTool(this.repositoryPath, file.path);
      if (result.success && result.data?.success) {
        // The tool may have fully resolved (and staged) the file — verify
        // against the index and let the host mark it, so this path behaves
        // like the dialog's own external tool instead of leaving the file
        // listed unresolved until an extra Mark Resolved click.
        const conflictsResult = await gitService.getConflicts(this.repositoryPath);
        if (conflictsResult.success) {
          freshConflicts = conflictsResult.data ?? [];
        }
        const stillConflicted =
          !conflictsResult.success ||
          (conflictsResult.data ?? []).some((c) => c.path === file.path);
        // Reload ONLY when the tool's file is still the one on screen: it
        // must show the tool's output (a stale parse could be written over
        // the tool's merge if this was the last file and selection stays),
        // but after a mid-session switch a reload would wipe the picks of
        // the file the user is now working on.
        if (this.conflictFile?.path === file.path) {
          const fresh = freshConflicts?.find((c) => c.path === file.path);
          if (fresh && fresh !== this.conflictFile) {
            // The tool may have changed the file's markerSize/style/hunks;
            // adopt the fresh metadata BEFORE parsing (the reactive updated()
            // reloads with it) instead of re-parsing with the stale object
            // and only correcting once the host echoes it back. The host
            // adopts the SAME object via external-tool-finished, so it will
            // not trigger a second reload.
            this.conflictFile = fresh;
          } else {
            await this.loadContents();
          }
        }
        // Mirror the dialog's launcher: success only when the index confirms
        // the resolution — a green toast over "N conflicts remaining" would
        // read as success for an unfinished merge.
        if (stillConflicted) {
          showToast('File still has conflicts', 'warning');
        } else {
          showToast('Merge tool completed', 'success');
          this.dispatchEvent(new CustomEvent('conflict-resolved', {
            detail: { file },
            bubbles: true,
            composed: true,
          }));
        }
      } else {
        showToast(result.data?.message ?? result.error?.message ?? 'Merge tool failed', 'error');
      }
    } catch {
      showToast('Failed to launch merge tool', 'error');
    } finally {
      this.launchingExternalTool = false;
      this.dispatchEvent(
        new CustomEvent('external-tool-finished', {
          detail: { filePath: file.path, freshConflicts },
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  private async loadContents(): Promise<void> {
    if (!this.repositoryPath || !this.conflictFile) return;

    // Rapid file switches start overlapping loads; only the NEWEST may write
    // state, or a slow earlier load would overwrite the panes/segments with
    // another file's content under the current file's path — and Mark
    // Resolved would then stage that wrong content.
    const epoch = ++this.loadEpoch;
    const file = this.conflictFile;

    this.loading = true;
    this.loadFailed = false;
    this.resolvedAsDeleted = false;
    this.resolvedInPlace = false;
    // Per-file UI state must not leak between files.
    this.editingSegmentId = null;
    this.aiExplanations = new Map();
    this.suggestingSegment = null;
    // A resolve or resolve-all bound to the previous file must not keep the
    // new file's buttons disabled; bump the tokens so their finally blocks
    // can't clear state a newer operation owns.
    this.resolving = false;
    this.resolveToken++;
    this.suggestingAll = false;
    this.aiResolveAllToken++;
    this.lastSavedContent = null;
    this.userTouched = false;
    this.sideReadErrors = { base: false, ours: false, theirs: false };

    try {
      // Re-SELECTING an already-resolved chooser file (binary/submodule):
      // its buttons would call take-side on a path the index no longer
      // lists as conflicted, erroring "No conflict found". The blob reads
      // for a binary file also fail (undecodable) and would render the live
      // chooser regardless of loadFailed. Land in the terminal resolved
      // state instead — the resolution is already staged.
      if (file.isBinary || file.isSubmodule) {
        if (await this.isNoLongerConflicted(file.path)) {
          if (epoch !== this.loadEpoch) return;
          this.segments = [];
          this.resolvedInPlace = true;
          return;
        }
        // The isNoLongerConflicted await (a slow per-file get_conflicts)
        // yielded — a newer file selection may have superseded this load.
        // Without this, the submodule early-return below would WIPE the
        // newer file's segments/panes, leaving it with "No conflicts" and
        // Mark Resolved enabled → a 0-byte write. (The binary path is
        // guarded by the post-Promise.all epoch check further down.)
        if (epoch !== this.loadEpoch) return;
      }

      // Submodule (gitlink) conflicts have nothing to read: the entry OIDs
      // are COMMITS (not blobs) and the workdir path is a directory. Every
      // fetch below would fail and land the editor in a loadFailed state
      // it never renders — the submodule chooser draws from the entry
      // metadata alone.
      if (file.isSubmodule) {
        this.segments = [];
        this.baseContent = '';
        this.oursContent = '';
        this.theirsContent = '';
        this.baseLines = [];
        this.oursLines = [];
        this.theirsLines = [];
        this.alignmentRows = [];
        return;
      }

      // Initialize Shiki highlighter and detect language. Inside the try so
      // a highlighter failure cannot wedge the editor in a permanent
      // loading state (the finally below always clears it).
      await this.initCodeLanguage(file.path);

      // Load all three versions and the working directory file in parallel.
      // The working directory file contains git's authoritative diff3 merge.
      const [ancestorResult, oursResult, theirsResult, workdirResult] = await Promise.all([
        file.ancestor?.oid
          ? gitService.getBlobContent(this.repositoryPath, file.ancestor.oid)
          : Promise.resolve({ success: true, data: '' }),
        file.ours?.oid
          ? gitService.getBlobContent(this.repositoryPath, file.ours.oid)
          : Promise.resolve({ success: true, data: '' }),
        file.theirs?.oid
          ? gitService.getBlobContent(this.repositoryPath, file.theirs.oid)
          : Promise.resolve({ success: true, data: '' }),
        gitService.readFileContent(this.repositoryPath, file.path),
      ]);

      // A newer load superseded this one while it was awaiting.
      if (epoch !== this.loadEpoch) return;

      this.baseContent = ancestorResult.success ? (ancestorResult.data || '') : '';
      this.oursContent = oursResult.success ? (oursResult.data || '') : '';
      this.theirsContent = theirsResult.success ? (theirsResult.data || '') : '';

      // A side with no entry (add/add conflicts have no ancestor; delete/modify
      // conflicts miss one side) has ZERO lines — ''.split('\n') would invent a
      // phantom blank line that misaligns and miscolors the panes.
      this.baseLines = file.ancestor ? this.baseContent.split('\n') : [];
      this.oursLines = file.ours ? this.oursContent.split('\n') : [];
      this.theirsLines = file.theirs ? this.theirsContent.split('\n') : [];

      // A failed read of a side that EXISTS must not masquerade as empty
      // content — the panes would lie and whole-file Use Ours/Theirs would
      // truncate the file. Route it to the same Retry state as a failed
      // workdir read, track which pane failed, and drop its fabricated
      // ''-split line so nothing renders as fake content.
      this.sideReadErrors = {
        base: !!file.ancestor?.oid && !ancestorResult.success,
        ours: !!file.ours?.oid && !oursResult.success,
        theirs: !!file.theirs?.oid && !theirsResult.success,
      };
      if (this.sideReadErrors.base) this.baseLines = [];
      if (this.sideReadErrors.ours) this.oursLines = [];
      if (this.sideReadErrors.theirs) this.theirsLines = [];
      // The BASE blob is never needed for parsing or block resolution
      // (parseSegments validates only against ours/theirs, and diff3 base
      // sections are identified by the backend-reported style) — a missing
      // ancestor object (shallow/partial clone) must not disable the whole
      // structured editor, only the Use Base button and its pane content.
      const sideReadFailed = this.sideReadErrors.ours || this.sideReadErrors.theirs;

      // Align AFTER dropping failed sides, or the rows would reference lines
      // that no longer exist and pane rendering would crash on them.
      this.alignmentRows = alignThreeWay(this.baseLines, this.oursLines, this.theirsLines);

      // Only git's own merge output is trustworthy. If the working directory
      // file can't be read, show an error state — never fabricate a merge.
      // An empty string is valid content (empty merged file), so test the
      // type, not truthiness.
      if (!sideReadFailed && workdirResult.success && typeof workdirResult.data === 'string') {
        this.segments = this.parseSegments(workdirResult.data);
      } else if (
        !workdirResult.success &&
        // The deletion claim requires the file to actually be GONE — a
        // kept-but-undecodable file (legacy encoding, resolved externally
        // with checkout --ours) fails the read the same way but must land
        // in the error/Retry/verbatim state, not a false "was deleted".
        workdirResult.error?.code === 'FILE_NOT_FOUND' &&
        (!file.ours || !file.theirs) &&
        (await this.isNoLongerConflicted(file.path))
      ) {
        // RE-SELECTING a file already resolved as a deletion: the workdir
        // read fails because the file is correctly GONE. The generic error
        // state would present the success as a failure — with a Retry that
        // loops forever and a verbatim button that resurrects the staged
        // deletion. Land in the terminal deleted state instead.
        if (epoch !== this.loadEpoch) return;
        this.segments = [];
        this.resolvedAsDeleted = true;
      } else if ((sideReadFailed || !workdirResult.success) && (await this.isNoLongerConflicted(file.path))) {
        // RE-SELECTING a text file already resolved via a verbatim take
        // (its side blob is undecodable): the same reads fail again, but
        // the file is no longer conflicted. The generic error state would
        // loop forever on Retry and its verbatim buttons would error "No
        // conflict found" — present the terminal resolved state instead.
        if (epoch !== this.loadEpoch) return;
        this.segments = [];
        this.resolvedInPlace = true;
      } else {
        this.segments = [];
        this.loadFailed = true;
      }
    } catch (err) {
      console.error('Failed to load conflict contents:', err);
      if (epoch === this.loadEpoch) {
        this.segments = [];
        this.loadFailed = true;
      }
    } finally {
      // A superseding load owns the loading flag now — don't clear it early.
      if (epoch === this.loadEpoch) {
        this.loading = false;
      }
    }
  }

  /**
   * True when the index no longer lists `path` as conflicted — i.e. the
   * file has already been resolved (deleted, or a chooser take-side that
   * staged a side). Distinguishes an ALREADY-RESOLVED re-selection from a
   * genuine read failure, so the editor can show a terminal notice instead
   * of a live chooser / forever-Retry whose buttons error "No conflict
   * found". A failed getConflicts returns false (treat as still
   * conflicted) so a transient error never fabricates a "resolved" state.
   */
  private async isNoLongerConflicted(path: string): Promise<boolean> {
    if (!this.repositoryPath) return false;
    const conflicts = await gitService.getConflicts(this.repositoryPath);
    return conflicts.success && !(conflicts.data ?? []).some((c) => c.path === path);
  }

  /**
   * Marker size the current file's conflict hunks were written with. The
   * backend reports it per file (conflict-marker-size gitattribute verified
   * against the file's actual emission); git's default 7 is the fallback
   * for missing or nonsense values. Parsing MUST use this exact size — the
   * same byte pattern is a real conflict at one size and plain content at
   * another, so it is not decidable from file bytes alone.
   */
  private get effectiveMarkerSize(): number {
    const size = this.conflictFile?.markerSize;
    // The backend caps sizes at u16 range; anything beyond that here is a
    // corrupt value and must not drive giant separator-string allocations.
    return typeof size === 'number' && Number.isInteger(size) && size >= 1 && size <= 65535
      ? size
      : 7;
  }

  /**
   * Parse git's conflict-marker text into structured segments — the ONLY
   * place markers are ever interpreted; they never reach the DOM.
   * Handles diff3-style `|||||||` base sections (discarded) and tolerates an
   * unterminated conflict at EOF (kept as a conflict block).
   *
   * Git emits exactly `effectiveMarkerSize` marker characters, optionally
   * followed by a space and label (the `=======` separator is always bare).
   * Content lines with runs of any OTHER length — banner comments, Markdown
   * setext underlines, `====…` dividers, docs samples showing default-size
   * markers inside a raised-size conflict — must not match, or the
   * ours/theirs split silently corrupts and real markers leak as content.
   * Lines are compared with a trailing CR stripped so CRLF files parse, but
   * content lines are stored verbatim to round-trip their line endings.
   */
  /**
   * Parse using the backend's authoritative marker positions. Returns null
   * when the positions don't describe this text (out of range, unordered,
   * or not pointing at marker-shaped lines) — the caller then falls back
   * to the validated shape heuristics.
   */
  private parseSegmentsFromHunks(
    text: string,
    hunks: NonNullable<ConflictFile['conflictHunks']>,
  ): OutputSegment[] | null {
    const markerSize = this.effectiveMarkerSize;
    const stripCr = (l: string): string => (l.endsWith('\r') ? l.slice(0, -1) : l);
    const runIs = (l: string, ch: string): boolean => {
      const s = stripCr(l);
      let n = 0;
      while (n < s.length && s[n] === ch) n++;
      return n === markerSize && (s.length === n || s[n] === ' ');
    };
    const lines = text.split('\n');
    const ordered = [...hunks].sort((a, b) => a.start - b.start);

    const segments: OutputSegment[] = [];
    let cursor = 0;
    for (const h of ordered) {
      const base = h.base ?? null;
      // Sanity: markers must be ordered, in range, and actually marker-shaped.
      if (
        h.start < cursor ||
        h.end >= lines.length ||
        h.start >= h.separator ||
        h.separator >= h.end ||
        (base !== null && (base <= h.start || base >= h.separator)) ||
        !runIs(lines[h.start], '<') ||
        stripCr(lines[h.separator]) !== '='.repeat(markerSize) ||
        !runIs(lines[h.end], '>') ||
        (base !== null && !runIs(lines[base], '|'))
      ) {
        return null;
      }
      if (h.start > cursor) {
        segments.push(this.makeResolvedSegment(lines.slice(cursor, h.start), null, false));
      }
      segments.push({
        id: this.nextSegmentId++,
        type: 'conflict',
        lines: [],
        oursLines: lines.slice(h.start + 1, base ?? h.separator),
        theirsLines: lines.slice(h.separator + 1, h.end),
        oursLabel: stripCr(lines[h.start]).slice(markerSize).trim() || 'OURS',
        theirsLabel: stripCr(lines[h.end]).slice(markerSize).trim() || 'THEIRS',
        origin: null,
        fromConflict: false,
      });
      cursor = h.end + 1;
    }
    if (cursor < lines.length) {
      segments.push(this.makeResolvedSegment(lines.slice(cursor), null, false));
    }
    return segments;
  }

  private parseSegments(text: string): OutputSegment[] {
    // AUTHORITATIVE positions from the backend's collision-free replay win
    // outright — position-based parsing cannot be confused by content that
    // quotes marker lines, even byte-identical ones. Heuristics remain for
    // hand-edited files (no replay match) and malformed position data.
    const hunks = this.conflictFile?.conflictHunks;
    if (hunks && hunks.length > 0) {
      const fromHunks = this.parseSegmentsFromHunks(text, hunks);
      // The safety net applies to the position-based output too: its hunk
      // positions are fetched once at open and NOT refreshed by Reload, so
      // an externally-added marker block OUTSIDE the original hunk range
      // would be swept into a resolved segment and rendered raw.
      if (fromHunks) return this.enforceNoOrphanMarkers(fromHunks);
    }
    const markerSize = this.effectiveMarkerSize;
    const stripCr = (l: string): string => (l.endsWith('\r') ? l.slice(0, -1) : l);
    /**
     * True when the line is a marker of `ch`: a run of EXACTLY the file's
     * marker size followed by a space or end-of-line. Longer or shorter
     * runs are content.
     */
    const isMarker = (l: string, ch: string): boolean => {
      const s = stripCr(l);
      let n = 0;
      while (n < s.length && s[n] === ch) n++;
      return n === markerSize && (s.length === n || s[n] === ' ');
    };
    const isConflictStart = (l: string): boolean => isMarker(l, '<');
    // `|||||||` is a base-section marker ONLY in diff3-style emission. In
    // the default 'merge' style (which is also all libgit2 ever writes) a
    // pipe run is ours CONTENT — treating it as a marker would silently
    // discard every ours line after it. The backend reports the style it
    // verified against the file's actual emission.
    const diff3 = this.conflictFile?.conflictStyle === 'diff3';
    const isBaseMarker = (l: string): boolean => diff3 && isMarker(l, '|');
    const isSeparator = (l: string): boolean => stripCr(l) === '='.repeat(markerSize);
    const isConflictEnd = (l: string): boolean => isMarker(l, '>');

    const lines = text.split('\n');

    const segments: OutputSegment[] = [];
    let currentResolved: string[] = [];

    /** True when `needle` appears as a consecutive slice of `hay`
     * (CR-insensitively — the workdir may be CRLF while blobs are LF). */
    const isContiguousRun = (needle: string[], hay: string[]): boolean => {
      if (needle.length === 0) return true;
      const n = needle.map(stripCr);
      outer: for (let i = 0; i + n.length <= hay.length; i++) {
        for (let j = 0; j < n.length; j++) {
          if (stripCr(hay[i + j]) !== n[j]) continue outer;
        }
        return true;
      }
      return false;
    };
    // With no blob content at all there is nothing to validate against —
    // the parser falls back to first-candidate closing (the shape-only
    // behavior), which is also what direct unit-test invocations exercise.
    const blobsAvailable = this.oursLines.length > 0 || this.theirsLines.length > 0;
    const lineInBlobs = (l: string): boolean =>
      isContiguousRun([l], this.oursLines) || isContiguousRun([l], this.theirsLines);

    const splitCandidates = (b: string[]): number[] => {
      const out: number[] = [];
      for (let i = 0; i < b.length; i++) {
        if (isSeparator(b[i])) out.push(i);
      }
      return out;
    };
    const splitAt = (b: string[], s: number): { ours: string[]; theirs: string[] } => {
      // diff3 base sections (between ||||||| and the separator) are
      // discarded — never leak base into ours.
      let baseIdx = -1;
      for (let i = 0; i < s; i++) {
        if (isBaseMarker(b[i])) {
          baseIdx = i;
          break;
        }
      }
      return { ours: b.slice(0, baseIdx < 0 ? s : baseIdx), theirs: b.slice(s + 1) };
    };
    /**
     * A split is VALID when each side is a contiguous slice of its blob —
     * content shaped exactly like the separator (a Markdown setext
     * underline is `=======`) is indistinguishable from git's separator by
     * shape alone. Returns the first candidate split that validates.
     *
     * diff3 base markers get the same treatment: a bare `|||||||` line in
     * the OURS content is shaped exactly like git's base marker, and
     * cutting ours at the first one would silently truncate the hunk (the
     * truncated prefix still validates!). Base candidates are therefore
     * tried longest-ours-first, so the real base marker — the one whose
     * full ours slice matches the blob — wins.
     */
    const validSplitOf = (b: string[]): { ours: string[]; theirs: string[] } | null => {
      for (const s of splitCandidates(b)) {
        const theirs = b.slice(s + 1);
        if (!isContiguousRun(theirs, this.theirsLines)) continue;
        const baseCandidates: number[] = [];
        for (let bi = 0; bi < s; bi++) {
          if (isBaseMarker(b[bi])) baseCandidates.push(bi);
        }
        if (baseCandidates.length === 0) {
          if (isContiguousRun(b.slice(0, s), this.oursLines)) {
            return { ours: b.slice(0, s), theirs };
          }
          continue;
        }
        for (let c = baseCandidates.length - 1; c >= 0; c--) {
          const ours = b.slice(0, baseCandidates[c]);
          if (isContiguousRun(ours, this.oursLines)) {
            return { ours, theirs };
          }
        }
      }
      return null;
    };
    const fallbackSplitOf = (b: string[]): { ours: string[]; theirs: string[] } => {
      const cs = splitCandidates(b);
      // Unterminated with no separator — everything is ours.
      if (cs.length === 0) return splitAt(b, b.length);
      return splitAt(b, cs[0]);
    };
    /**
     * Exhaustive blob-validated split for a body WITHOUT a separator line
     * (a hand edit can delete the `=======` itself): the first index where
     * the prefix is a contiguous ours run AND the suffix a contiguous
     * theirs run. Bodies are conflict-hunk sized, so the quadratic scan is
     * cheap.
     */
    const validAnySplitOf = (b: string[]): { ours: string[]; theirs: string[] } | null => {
      for (let s = 0; s <= b.length; s++) {
        const ours = b.slice(0, s);
        const theirs = b.slice(s);
        if (isContiguousRun(ours, this.oursLines) && isContiguousRun(theirs, this.theirsLines)) {
          return { ours, theirs };
        }
      }
      return null;
    };
    /**
     * The text after a candidate close, up to the next REAL start-shaped
     * line. A start-shaped line that is blob content (a quoted example)
     * does not end the window — stopping there would hide an orphaned real
     * end marker sitting below it from both justification checks.
     */
    const trailingAfter = (endIdx: number): string[] => {
      const out: string[] = [];
      for (let k = endIdx + 1; k < lines.length; k++) {
        if (isConflictStart(lines[k]) && !lineInBlobs(lines[k])) break;
        out.push(lines[k]);
      }
      return out;
    };
    /**
     * STRONG close justification: everything after the close (up to the
     * next region) is a contiguous run of some blob — genuinely merged
     * content. This distinguishes even a quoted marker line that is
     * TEXTUALLY IDENTICAL to the real end marker (a tutorial quoting
     * `>>>>>>> feature-branch` while that very branch merges in): closing
     * at the quoted copy leaves the real marker stranded in the trailing
     * text, which then matches no blob run.
     */
    const trailingIsBlobRun = (endIdx: number): boolean => {
      const trailing = trailingAfter(endIdx);
      return (
        isContiguousRun(trailing, this.oursLines) || isContiguousRun(trailing, this.theirsLines)
      );
    };
    /**
     * WEAK close justification: the trailing text contains no marker-shaped
     * line that is absent from both blobs (i.e. no orphaned real marker).
     * Needed because auto-merged trailing text can mix one-sided insertions
     * from both blobs and so fail the strong contiguity check. A validated
     * split alone justifies nothing: a PREFIX of the theirs hunk also
     * validates as contiguous.
     */
    const orphanMarkerAfter = (endIdx: number): boolean => {
      for (const l of trailingAfter(endIdx)) {
        if ((isConflictEnd(l) || isSeparator(l)) && !lineInBlobs(l)) return true;
      }
      return false;
    };

    const flushResolved = (): void => {
      if (currentResolved.length > 0) {
        segments.push(this.makeResolvedSegment(currentResolved, null, false));
        currentResolved = [];
      }
    };
    const pushConflict = (
      split: { ours: string[]; theirs: string[] },
      oursLabel: string,
      theirsLabel: string,
    ): void => {
      flushResolved();
      segments.push({
        id: this.nextSegmentId++,
        type: 'conflict',
        lines: [],
        oursLines: split.ours,
        theirsLines: split.theirs,
        oursLabel,
        theirsLabel,
        origin: null,
        fromConflict: false,
      });
    };
    const labelOf = (markerLine: string, fallback: string): string =>
      stripCr(markerLine).slice(markerSize).trim() || fallback;

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!isConflictStart(line)) {
        currentResolved.push(line);
        i++;
        continue;
      }

      // A start-shaped line opens a candidate conflict region. Walk forward
      // collecting the body and candidate end markers (end-shaped lines
      // after at least one separator-shaped line — git always emits
      // '=======' before '>>>>>>>'). Content can QUOTE markers, so a
      // candidate close is only accepted when it can be justified against
      // the blobs; otherwise the end-shaped line is content and scanning
      // continues to the next candidate.
      const oursLabel = labelOf(line, 'OURS');
      const body: string[] = [];
      let seenSep = false;
      let firstCandidate: { end: number; body: string[] } | null = null;
      let orphanTerminator: { end: number; body: string[] } | null = null;
      let weakCandidate: { end: number; split: { ours: string[]; theirs: string[] } } | null =
        null;
      let closed: { end: number; split: { ours: string[]; theirs: string[] } | null } | null =
        null;

      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (seenSep && isConflictEnd(l)) {
          if (!blobsAvailable) {
            closed = { end: j, split: fallbackSplitOf(body) };
            break;
          }
          if (!firstCandidate) firstCandidate = { end: j, body: [...body] };
          // The whole region (markers included) existing verbatim in a
          // blob means it is QUOTED content — a docs example that survived
          // the merge — not a git-generated conflict. Real markers are in
          // neither blob.
          const region = lines.slice(i, j + 1);
          if (isContiguousRun(region, this.oursLines) || isContiguousRun(region, this.theirsLines)) {
            closed = { end: j, split: null };
            break;
          }
          const split = validSplitOf(body);
          // STRONG close — decisive even against quoted marker lines that
          // are textually identical to the real markers, which defeat the
          // weak (line-membership) orphan test.
          if (split && trailingIsBlobRun(j)) {
            closed = { end: j, split };
            break;
          }
          // WEAK close — remembered, but scanning continues in case a
          // later candidate closes strongly.
          if (split && !weakCandidate && !orphanMarkerAfter(j)) {
            weakCandidate = { end: j, split };
          }
          // This end-shaped line may be content; keep scanning.
          body.push(l);
          continue;
        }
        if (!seenSep && isConflictEnd(l) && blobsAvailable && !lineInBlobs(l)) {
          // An end-shaped line BEFORE any separator that exists in NEITHER
          // blob is a real orphaned end marker — a hand edit deleted the
          // `=======` line (git always emits it before `>>>>>>>`). Close
          // here when the body blob-justifies a split; the marker line is
          // the region's terminator and must never surface as pane content
          // (or round-trip to disk via an accepted side). Without
          // justification the line may still be typed content — it stays
          // in the body and scanning continues, so a real separator+end
          // below still wins (no early close on mid-region junk).
          const split = validAnySplitOf(body);
          if (split && trailingIsBlobRun(j)) {
            closed = { end: j, split };
            break;
          }
          if (split && !weakCandidate && !orphanMarkerAfter(j)) {
            weakCandidate = { end: j, split };
          }
          // Even when nothing blob-justifies a split (the hand edit also
          // changed body lines), remember the orphan marker as a region
          // TERMINATOR: if no real separator+end ever shows up below, the
          // region must close here rather than sweep this line into the
          // ours pane as visible marker text.
          if (!orphanTerminator) {
            orphanTerminator = { end: j, body: [...body] };
          }
          body.push(l);
          continue;
        }
        if (isSeparator(l)) seenSep = true;
        body.push(l);
      }
      if (!closed && weakCandidate) {
        closed = weakCandidate;
      }

      if (closed && closed.split === null) {
        // Quoted region — plain content, merged into the surrounding run.
        currentResolved.push(...lines.slice(i, closed.end + 1));
        i = closed.end + 1;
      } else if (closed) {
        pushConflict(closed.split!, oursLabel, labelOf(lines[closed.end], 'THEIRS'));
        i = closed.end + 1;
      } else if (blobsAvailable && lineInBlobs(line) && firstCandidate) {
        // NOTHING below this start-shaped line validates, and the line
        // itself is blob content — it is a quoted example sitting directly
        // above the real conflict, and it opened the region one line too
        // early (every candidate ours-slice began with the real start
        // marker, which is in neither blob). Treat it as content and
        // rescan from the next line so the REAL start can open a region
        // whose split validates. The recovery requires END-CANDIDATE
        // evidence: with no end-shaped line anywhere below, this is a
        // genuinely unterminated conflict at EOF — reclassifying its start
        // as content would zero the conflict count and let Mark Resolved
        // write the real marker back to disk.
        currentResolved.push(line);
        i++;
      } else if (firstCandidate) {
        // No candidate could be justified (nothing validates) — close at
        // the FIRST candidate, the pre-validation behavior.
        pushConflict(
          fallbackSplitOf(firstCandidate.body),
          oursLabel,
          labelOf(lines[firstCandidate.end], 'THEIRS'),
        );
        i = firstCandidate.end + 1;
      } else if (orphanTerminator) {
        // The only end-shaped evidence is an ORPHAN real end marker with
        // no separator anywhere below it (a hand edit deleted the
        // `=======` AND changed body lines, so no split blob-justified).
        // The marker is still the region's terminator — closing here keeps
        // it out of the panes; falling through to the unterminated case
        // would render it verbatim inside the ours side.
        pushConflict(
          validSplitOf(orphanTerminator.body) ?? fallbackSplitOf(orphanTerminator.body),
          oursLabel,
          labelOf(lines[orphanTerminator.end], 'THEIRS'),
        );
        i = orphanTerminator.end + 1;
      } else {
        // Unterminated conflict (truncated file) — keep it as a conflict
        // block rather than silently promoting marker content to resolved
        // text.
        pushConflict(
          validSplitOf(body) ?? fallbackSplitOf(body),
          oursLabel,
          'THEIRS',
        );
        i = lines.length;
      }
    }
    flushResolved();

    return this.enforceNoOrphanMarkers(segments);
  }

  /**
   * Invariant-1 safety net, applied to BOTH parser paths. A hand edit can
   * delete a `<<<<<<<` start marker (leaving an orphaned `=======`/`>>>>>>>`
   * the region scan sweeps into RESOLVED text), and a fallback split can
   * push an unvalidated marker line into a CONFLICT pane — either renders a
   * raw marker. If ANY segment carries a marker-shaped line that is in NO
   * blob (a real orphaned marker, not quoted content), the parse is
   * unreliable: present the whole file as one unresolved conflict (ours vs
   * theirs from the blobs) so it is resolved cleanly and no marker is ever
   * displayed. The user's on-disk hand edits are untouched (Reload re-reads
   * them).
   */
  private enforceNoOrphanMarkers(segments: OutputSegment[]): OutputSegment[] {
    const blobsAvailable = this.oursLines.length > 0 || this.theirsLines.length > 0;
    if (!blobsAvailable) return segments;
    const echo = this.markerEchoPattern();
    // A marker-shaped line (any shape: <<<<<<< / ======= / >>>>>>> / |||||||)
    // that is in NO blob is a real orphaned marker, whether it landed in a
    // resolved segment (hand-deleted start marker) or a conflict pane (an
    // unvalidated fallback split swept it into a side). A VALIDATED split's
    // sides are contiguous blob runs, so every line IS blob content and is
    // never flagged — only unvalidated fallbacks (genuinely malformed
    // input) can carry a non-blob marker line into a pane. Either way it
    // would render raw, so fall back to the whole-file conflict.
    const orphan = (lines: string[]): boolean =>
      lines.some((l) => echo.test(l) && !this.lineIsBlobContent(l));
    const hasOrphanMarker = segments.some((s) =>
      s.type === 'resolved' ? orphan(s.lines) : orphan(s.oursLines) || orphan(s.theirsLines),
    );
    if (!hasOrphanMarker) return segments;
    return [
      {
        id: this.nextSegmentId++,
        type: 'conflict',
        lines: [],
        oursLines: this.oursLines,
        theirsLines: this.theirsLines,
        oursLabel: 'OURS',
        theirsLabel: 'THEIRS',
        origin: null,
        fromConflict: false,
      },
    ];
  }

  private makeResolvedSegment(
    lines: string[],
    origin: SegmentOrigin | null,
    fromConflict: boolean,
    conflictData?: Pick<OutputSegment, 'oursLines' | 'theirsLines' | 'oursLabel' | 'theirsLabel'>,
  ): OutputSegment {
    return {
      id: this.nextSegmentId++,
      type: 'resolved',
      lines,
      oursLines: conflictData?.oursLines ?? [],
      theirsLines: conflictData?.theirsLines ?? [],
      oursLabel: conflictData?.oursLabel ?? '',
      theirsLabel: conflictData?.theirsLabel ?? '',
      origin,
      fromConflict,
    };
  }

  /** Resolve writes and an open external tool must never overlap — both
   * mutate the same on-disk file and the last write would silently win.
   * The host lock counts too: the dialog sets it while ITS tool session or
   * abort/complete runs against this same file. A resolution that DELETED
   * the on-screen file is terminal: every further action would either fail
   * or resurrect the file. */
  private get actionsBlocked(): boolean {
    return (
      this.resolving ||
      this.launchingExternalTool ||
      this.confirmingWholeFileOverwrite ||
      this.externalToolLocked ||
      this.resolvedAsDeleted ||
      this.resolvedInPlace
    );
  }

  /** Serialized output of the last successful Mark Resolved for this file —
   * work matching it is on disk and safe to navigate away from. */
  private lastSavedContent: string | null = null;
  /** True once the user changed the output in this file (per-block picks,
   * edits, OR whole-file accepts — the latter carry no fromConflict flag). */
  private userTouched = false;

  /**
   * True when the output holds work not yet written to disk: per-block
   * resolutions, whole-file accepts, or an open inline edit. Nothing
   * persists until Mark Resolved, so hosts should confirm before
   * navigating away.
   */
  public hasUnsavedResolutions(): boolean {
    if (this.editingSegmentId !== null) return true;
    if (!this.userTouched) return false;
    return this.buildResolvedContent() !== this.lastSavedContent;
  }

  private get conflictCount(): number {
    return this.segments.filter((s) => s.type === 'conflict').length;
  }

  /** Serialize the output. Only valid once every conflict block is resolved. */
  private buildResolvedContent(): string {
    return this.segments.flatMap((s) => s.lines).join('\n');
  }

  // ── Segment operations ────────────────────────────────────────────────

  private updateSegment(id: number, update: Partial<OutputSegment>): void {
    this.segments = this.segments.map((s) => (s.id === id ? { ...s, ...update } : s));
  }

  /**
   * Drop a stored AI explanation once the segment's content no longer comes
   * from that suggestion (reset, re-picked, or hand-edited) — a stale
   * rationale under unrelated content is worse than none.
   */
  private clearAiExplanation(id: number): void {
    if (!this.aiExplanations.has(id)) return;
    const next = new Map(this.aiExplanations);
    next.delete(id);
    this.aiExplanations = next;
  }

  private resolveConflictSegment(id: number, choice: 'ours' | 'theirs' | 'both'): void {
    // In-memory picks are blocked while a resolve write or external tool
    // session runs: the post-write/post-tool reload would silently destroy
    // them (the pre-launch confirm only covers picks made BEFORE launch).
    if (this.actionsBlocked) return;
    const segment = this.segments.find((s) => s.id === id);
    if (!segment || segment.type !== 'conflict') return;

    const lines =
      choice === 'ours'
        ? [...segment.oursLines]
        : choice === 'theirs'
          ? [...segment.theirsLines]
          : [...segment.oursLines, ...segment.theirsLines];
    this.clearAiExplanation(id);
    this.userTouched = true;
    this.updateSegment(id, { type: 'resolved', lines, origin: choice, fromConflict: true });
  }

  /** Revert a resolved-from-conflict segment back to an open conflict block. */
  private resetSegment(id: number): void {
    if (this.actionsBlocked) return;
    const segment = this.segments.find((s) => s.id === id);
    if (!segment || !segment.fromConflict) return;
    if (this.editingSegmentId === id) this.editingSegmentId = null;
    this.clearAiExplanation(id);
    this.updateSegment(id, { type: 'conflict', lines: [], origin: null, fromConflict: false });
  }

  /**
   * True when it is safe to throw away an open inline-edit draft: no edit
   * is open, or the user confirmed the discard. Opening an edit on a
   * DIFFERENT segment abandons the current typed draft, so this is the
   * confirm for that one path — the same hazard Reload and file switches
   * already confirm for. Whole-file operations use
   * confirmWholeFileOverwrite instead.
   */
  private async confirmDiscardOpenEdit(): Promise<boolean> {
    if (this.editingSegmentId === null) return true;
    return showConfirm(
      'Discard the open edit?',
      'This section has an edit that was not applied — continuing discards the typed text.',
      'warning',
    );
  }

  private async startEditSegment(segment: OutputSegment): Promise<void> {
    if (this.actionsBlocked) return;
    // Opening an edit on ANOTHER segment throws away the current typed
    // draft — confirm like every other draft-discarding path.
    if (this.editingSegmentId !== null && this.editingSegmentId !== segment.id) {
      if (!(await this.confirmDiscardOpenEdit())) return;
      // Re-check after the confirm's await, and re-find the segment — a
      // resolve/tool session or reload may have happened while it was up.
      if (this.actionsBlocked) return;
      if (!this.segments.some((s) => s.id === segment.id)) return;
    }
    this.editingSegmentId = segment.id;
    // Editing an open conflict starts from both sides so the user trims what
    // they don't want — never from marker text.
    this.editDraft =
      segment.type === 'conflict'
        ? [...segment.oursLines, ...segment.theirsLines].join('\n')
        : segment.lines.join('\n');
  }

  /**
   * Matches lines that LOOK like conflict markers. Runs of min(7, size)+
   * cover the default, raised, AND lowered conflict-marker-size cases.
   * Used to keep marker-shaped text out of resolved output unless the user
   * explicitly wants it there.
   */
  private markerEchoPattern(): RegExp {
    const n = Math.min(7, this.effectiveMarkerSize);
    return new RegExp(`^(<{${n},}|={${n},}|>{${n},}|\\|{${n},})( |\\r?$)`, 'm');
  }

  /** CR-insensitive single-line membership in any of the three version
   * blobs. Marker-shaped text that IS blob content (a setext underline, a
   * quoted example) is legitimate; marker-shaped text in no blob is a real
   * orphaned marker a hand edit left behind. BASE counts too: Use Base
   * stages ancestor content verbatim, and a `=======` divider that both
   * sides later changed exists only there — flagging it would raise a
   * false "conflict markers" confirm over clean ancestor content. */
  private lineIsBlobContent(line: string): boolean {
    const strip = (l: string): string => (l.endsWith('\r') ? l.slice(0, -1) : l);
    const target = strip(line);
    return (
      this.oursLines.some((l) => strip(l) === target) ||
      this.theirsLines.some((l) => strip(l) === target) ||
      this.baseLines.some((l) => strip(l) === target)
    );
  }

  private async applyEditSegment(): Promise<void> {
    if (this.actionsBlocked) return;
    const id = this.editingSegmentId;
    if (id === null) return;
    const segment = this.segments.find((s) => s.id === id);
    if (!segment) {
      this.editingSegmentId = null;
      return;
    }

    // Marker-shaped lines in a hand edit are usually an accidental paste of
    // raw conflict text — writing them back would defeat the whole editor.
    // But they CAN be legitimate (a Markdown setext underline is exactly
    // `=======`), so unlike the AI path this confirms instead of blocking.
    if (this.markerEchoPattern().test(this.editDraft)) {
      const proceed = await showConfirm(
        'Keep conflict-marker-like text?',
        'Your edit contains lines that look like git conflict markers. If you pasted raw conflict text, cancel and remove the marker lines; if the text is intentional it will be kept as-is.',
        'warning',
      );
      if (!proceed) return;
      // The confirm awaited — the edit may have been closed or retargeted
      // by a file switch in the meantime; applying a stale draft would
      // write it into the wrong segment. A resolve/tool session may also
      // have started while the confirm was up (same re-check as Reload).
      if (this.editingSegmentId !== id || !this.segments.some((s) => s.id === id)) return;
      if (this.actionsBlocked) return;
    }

    this.clearAiExplanation(id);
    this.userTouched = true;
    this.updateSegment(id, {
      type: 'resolved',
      // An empty draft means ZERO lines (section removed) — ''.split('\n')
      // would silently turn it into one blank line.
      lines: this.editDraft === '' ? [] : this.editDraft.split('\n'),
      origin: 'manual',
      fromConflict: segment.type === 'conflict' ? true : segment.fromConflict,
    });
    this.editingSegmentId = null;
    this.editDraft = '';
  }

  private cancelEditSegment(): void {
    this.editingSegmentId = null;
    this.editDraft = '';
  }

  private handleEditDraftInput(e: Event): void {
    this.editDraft = (e.target as HTMLTextAreaElement).value;
  }

  // ── Whole-file operations ─────────────────────────────────────────────

  /**
   * True when the output is nothing but a previous whole-file accept: no
   * per-block pick, no hand edit and no open draft is in it, so another
   * whole-file button loses nothing. Only acceptWholeFile produces such a
   * segment — per-block picks and AI fills set fromConflict, hand edits set
   * origin 'manual', and freshly parsed segments carry origin null.
   */
  private get outputIsWholeFileAccept(): boolean {
    if (this.editingSegmentId !== null || this.segments.length !== 1) return false;
    const only = this.segments[0];
    return (
      !only.fromConflict &&
      (only.origin === 'ours' || only.origin === 'theirs' || only.origin === 'base')
    );
  }

  /**
   * Ask before an operation throws the current output away, holding the
   * re-entrancy flag for the whole round trip: showConfirm is async IPC, so
   * without it a second click (or an External Tool launch) would slip in
   * behind the open dialog. The wording is the caller's — an in-editor
   * whole-file swap and an on-disk take-side have different consequences
   * and must not share one message.
   */
  private async confirmOverwrite(title: string, messageText: string): Promise<boolean> {
    this.confirmingWholeFileOverwrite = true;
    try {
      return await showConfirm(title, messageText, 'warning');
    } finally {
      this.confirmingWholeFileOverwrite = false;
    }
  }

  /**
   * Unsaved work that is actually IN the output — picks, applied hand edits
   * and whole-file accepts. This is hasUnsavedResolutions() WITHOUT its
   * open-draft shortcut, because an open draft is not in the output:
   * buildResolvedContent() never sees editDraft.
   */
  private get outputHasUnsavedWork(): boolean {
    return this.userTouched && this.buildResolvedContent() !== this.lastSavedContent;
  }

  /**
   * Name what an overwrite destroys, in the words of the caller's operation.
   * Both halves are needed: an open inline-edit draft is NOT in the output,
   * so a message that only describes "work currently in the output" is
   * silent about the typed text it discards — and when the draft is the ONLY
   * unsaved work (hasUnsavedResolutions() is true on an open draft alone,
   * which is the state after Edit-then-toolbar on a freshly loaded file) that
   * message would also enumerate picks and edits the user does not have.
   */
  private overwriteLossText(inOutput: string, openDraft: string): string {
    const parts: string[] = [];
    if (this.outputHasUnsavedWork) parts.push(inOutput);
    if (this.editingSegmentId !== null) parts.push(openDraft);
    // Never empty: every caller gates on hasUnsavedResolutions(), which is
    // exactly outputHasUnsavedWork || an open draft.
    return parts.join(' and ');
  }

  private async confirmWholeFileOverwrite(): Promise<boolean> {
    if (!this.hasUnsavedResolutions()) return true;
    return this.confirmOverwrite(
      'Replace in-progress resolution?',
      `Using one whole-file version ${this.overwriteLossText(
        'replaces the picks, edits and whole-file choice currently in the output',
        'discards the edit that was typed but not applied',
      )}. This cannot be undone.`,
    );
  }

  private async acceptWholeFile(origin: 'ours' | 'theirs' | 'base'): Promise<void> {
    // With a failed load the side contents are not trustworthy — accepting
    // one would replace the segments with fabricated (possibly empty) text.
    // Blocked during resolve writes / tool sessions like every other
    // in-memory mutation. A base-only read failure keeps the editor alive,
    // so Use Base must check its own side too.
    if (this.loadFailed || this.actionsBlocked) return;
    if (origin === 'base' && this.sideReadErrors.base) return;
    const startFile = this.conflictFile;

    // A side with no entry DELETED the file — accepting it means staging the
    // deletion, not writing a 0-byte file from its empty content. The
    // take-side path owns the overwrite confirmation so this delegates
    // before prompting and never asks twice.
    if (
      (origin === 'ours' && !this.conflictFile?.ours) ||
      (origin === 'theirs' && !this.conflictFile?.theirs)
    ) {
      return this.handleTakeSide(origin);
    }

    // Re-picking the side the output already holds verbatim changes nothing.
    if (this.outputIsWholeFileAccept && this.segments[0].origin === origin) return;

    // A pure whole-file accept holds no pick and no edit to lose — the other
    // buttons restore it in one click — so swapping sides to compare them
    // must not raise a confirm that misdescribes the state.
    if (!this.outputIsWholeFileAccept && this.hasUnsavedResolutions()) {
      if (!(await this.confirmWholeFileOverwrite())) return;
      // Re-check after the confirm's await — a resolve/tool session may
      // have started while it was up (same re-check as Reload and Apply),
      // and file IDENTITY too: a switch during the confirm must not let
      // this call overwrite a DIFFERENT file's segments with this side.
      if (this.loadFailed || this.actionsBlocked) return;
      if (this.conflictFile !== startFile) return;
    }
    if (this.editingSegmentId !== null) {
      this.editingSegmentId = null;
      this.editDraft = '';
    }

    const content =
      origin === 'ours' ? this.oursContent : origin === 'theirs' ? this.theirsContent : this.baseContent;
    this.userTouched = true;
    this.segments = [this.makeResolvedSegment(content.split('\n'), origin, false)];
  }

  private handleAcceptOurs(): void {
    void this.acceptWholeFile('ours');
  }

  private handleAcceptTheirs(): void {
    void this.acceptWholeFile('theirs');
  }

  private handleAcceptBase(): void {
    void this.acceptWholeFile('base');
  }

  /** Re-read the on-disk merge, discarding all in-editor resolutions. */
  private async handleReload(): Promise<void> {
    // Reloading mid-write would clear the resolve lock for THIS file and
    // let a second write race the first; reloading mid-tool-session is the
    // session's own job when it ends.
    if (this.actionsBlocked) return;
    // Reload discards exactly like a file switch does — same confirm.
    if (this.hasUnsavedResolutions()) {
      const proceed = await showConfirm(
        'Discard in-progress resolution?',
        'Reloading re-reads the file from disk and discards your unsaved picks and edits.',
        'warning',
      );
      if (!proceed) return;
      // Re-check: a resolve/tool session may have started while the
      // confirm was up.
      if (this.actionsBlocked) return;
    }
    await this.loadContents();
  }

  // ── AI resolution ─────────────────────────────────────────────────────

  /** Resolve one conflict block via AI. Returns false when the call failed. */
  private async handleSuggestSegment(id: number): Promise<boolean> {
    if (!this.conflictFile || this.suggestingSegment !== null || this.actionsBlocked) return false;
    const segment = this.segments.find((s) => s.id === id);
    if (!segment || segment.type !== 'conflict') return false;

    this.suggestingSegment = id;
    try {
      // Surrounding resolved context helps the model match style.
      const resolvedBefore: string[] = [];
      const resolvedAfter: string[] = [];
      let seenTarget = false;
      for (const s of this.segments) {
        if (s.id === id) {
          seenTarget = true;
        } else if (s.type === 'resolved') {
          (seenTarget ? resolvedAfter : resolvedBefore).push(...s.lines);
        }
      }

      const result = await aiService.suggestConflictResolution(
        this.conflictFile.path,
        segment.oursLines.join('\n'),
        segment.theirsLines.join('\n'),
        this.baseContent || undefined,
        resolvedBefore.slice(-20).join('\n') || undefined,
        resolvedAfter.slice(0, 20).join('\n') || undefined,
      );

      // The user may have resolved this block manually while the call was in
      // flight — their explicit pick wins; never overwrite it. Not a failure,
      // so Resolve All continues past it.
      const current = this.segments.find((s) => s.id === id);
      if (!current || current.type !== 'conflict') return true;

      if (result.success && result.data) {
        // AI output bypasses parseSegments, so it must be validated here:
        // a suggestion that echoes marker lines would otherwise render them
        // as "resolved" text and let them be written back to the file.
        // Unlike the hand-edit path this hard-blocks — AI output is
        // untrusted, and being overly conservative just leaves the block
        // unresolved, which is safe.
        if (this.markerEchoPattern().test(result.data.resolvedContent)) {
          showToast('AI suggestion contained conflict markers — block left unresolved', 'error');
          return false;
        }
        this.userTouched = true;
        this.updateSegment(id, {
          type: 'resolved',
          // An empty suggestion means ZERO lines (remove the section) —
          // ''.split('\n') would fabricate one blank line.
          lines: result.data.resolvedContent === '' ? [] : result.data.resolvedContent.split('\n'),
          origin: 'ai',
          fromConflict: true,
        });
        if (result.data.explanation) {
          this.aiExplanations = new Map(this.aiExplanations);
          this.aiExplanations.set(id, result.data.explanation);
        }
        return true;
      }
      showToast(result.error?.message ?? 'AI suggestion failed', 'error');
      return false;
    } catch {
      showToast('Failed to get AI suggestion', 'error');
      return false;
    } finally {
      // Only clear the in-flight flag if it still tracks THIS call — a file
      // switch resets it and a newer suggestion may own it by now; clobbering
      // that would re-enable the AI buttons while a call is genuinely running.
      if (this.suggestingSegment === id) {
        this.suggestingSegment = null;
      }
    }
  }

  private async handleAiResolveAll(): Promise<void> {
    if (this.suggestingAll || this.actionsBlocked) return;

    const conflictIds = this.segments.filter((s) => s.type === 'conflict').map((s) => s.id);
    if (conflictIds.length === 0) return;

    const epoch = this.loadEpoch;
    const token = ++this.aiResolveAllToken;
    this.suggestingAll = true;
    try {
      for (const id of conflictIds) {
        // The file changed under the batch — its ids are stale; stop instead
        // of grinding through no-op calls while the new file's AI is locked.
        if (this.loadEpoch !== epoch) break;
        // The user may have resolved this block manually while the batch was
        // running — that's not a failure, just skip it.
        const segment = this.segments.find((s) => s.id === id);
        if (!segment || segment.type !== 'conflict') continue;
        // Stop on the first real failure — retrying would just repeat the error.
        if (!(await this.handleSuggestSegment(id))) break;
      }
    } finally {
      if (token === this.aiResolveAllToken) {
        this.suggestingAll = false;
      }
    }
  }

  // ── Completion ────────────────────────────────────────────────────────

  private async handleMarkResolved(): Promise<void> {
    if (!this.repositoryPath || !this.conflictFile || this.actionsBlocked) return;
    // Identity of the file when the button was clicked. The orphan-marker
    // confirm below yields to the event loop (native confirms do NOT block
    // it), and nav is not yet locked (resolve-started fires later), so a
    // file switch could retarget conflictFile mid-confirm — marking the
    // WRONG file resolved. Re-checked after the await.
    const startFile = this.conflictFile;

    // The button is disabled in these states; the guards keep the invariant
    // even if invoked directly. A file with open conflict blocks must never
    // be written out (it would re-serialize markers), and a failed load has
    // no trustworthy content to write (it would truncate the file to empty).
    if (this.loadFailed) {
      showToast('The merged file could not be read — retry loading it before resolving', 'warning');
      return;
    }
    if (this.conflictCount > 0) {
      showToast('Resolve all conflict blocks before marking the file resolved', 'warning');
      return;
    }
    // An open inline edit holds an unapplied draft — writing now would stage
    // the PRE-edit text while the screen shows the draft, silently losing it.
    if (this.editingSegmentId !== null) {
      showToast('Apply or cancel the open edit before marking the file resolved', 'warning');
      return;
    }

    // Belt-and-braces for hand-edited files: parser fallbacks can leave a
    // REAL orphaned marker line inside an accepted side (e.g. a hand edit
    // deleted the separator and nothing blob-justified a close). Writing it
    // back SILENTLY would re-serialize a marker as resolved content — the
    // exact failure this editor exists to prevent — so confirm, like the
    // inline-edit path does. Manual segments confirmed at apply time, and
    // marker-shaped lines that are blob content are legitimate; both stay
    // silent.
    const echo = this.markerEchoPattern();
    const hasOrphanMarker = this.segments.some(
      (s) =>
        s.type === 'resolved' &&
        s.origin !== 'manual' &&
        s.lines.some((l) => echo.test(l) && !this.lineIsBlobContent(l)),
    );
    if (hasOrphanMarker) {
      const proceed = await showConfirm(
        'Write conflict-marker-like text?',
        'The resolved content contains lines shaped like git conflict markers that are not part of either version. If a hand edit left real markers behind, cancel and remove them; if the text is intentional it will be written as-is.',
        'warning',
      );
      if (!proceed) return;
      // Re-check after the await — same re-validation as every other
      // confirm in this component, plus file identity: a switch during the
      // confirm must not let this call mark a different file resolved.
      if (!this.repositoryPath || !this.conflictFile || this.actionsBlocked) return;
      if (this.conflictFile !== startFile) return;
      if (this.loadFailed || this.conflictCount > 0 || this.editingSegmentId !== null) return;
    }

    // Capture the file BEFORE the await: the user may select another file in
    // the dialog while the backend call runs, and dispatching that one would
    // mark the wrong file resolved (and let a stash Complete drop the stash
    // with a still-conflicted file).
    const file = this.conflictFile;
    const token = ++this.resolveToken;
    const content = this.buildResolvedContent();
    this.resolving = true;
    // Announce the write so the host can lock its own tool launcher against
    // it (same pattern as the external-tool session events).
    this.dispatchEvent(new CustomEvent('resolve-started', { bubbles: true, composed: true }));
    try {
      const result = await gitService.resolveConflict(
        this.repositoryPath,
        file.path,
        content
      );

      if (result.success) {
        // This exact output is on disk now — navigation away is safe. But
        // only record it while this call still owns the editor's state: a
        // file switch mid-write resets per-file state, and a stale write's
        // content must not masquerade as the CURRENT file's saved state.
        if (token === this.resolveToken) {
          this.lastSavedContent = content;
        }
        this.dispatchEvent(new CustomEvent('conflict-resolved', {
          detail: { file },
          bubbles: true,
          composed: true,
        }));
      } else {
        console.error('Failed to resolve conflict:', result.error);
        showToast(`Failed to mark file as resolved: ${result.error?.message ?? 'Unknown error'}`, 'error');
      }
    } catch (err) {
      // invokeCommand is designed not to throw, but a silent failure here
      // would strand the user with no feedback — same catch as the
      // external-tool sibling.
      console.error('Failed to resolve conflict:', err);
      showToast('Failed to mark file as resolved', 'error');
    } finally {
      // Only the call that owns the flag may clear it — a file switch resets
      // it and a newer call may own it by now.
      if (token === this.resolveToken) {
        this.resolving = false;
      }
      this.dispatchEvent(new CustomEvent('resolve-finished', { bubbles: true, composed: true }));
    }
  }

  private get isBinaryConflict(): boolean {
    return this.conflictFile?.isBinary === true;
  }

  private get isSubmoduleConflict(): boolean {
    return this.conflictFile?.isSubmodule === true;
  }

  /** Any side being a symlink (mode 120000) makes this a link conflict —
   * the "binary" chooser resolves it, but the copy must say what the
   * choice actually is (link targets), not call a link a binary file. */
  private get isSymlinkConflict(): boolean {
    const f = this.conflictFile;
    return (
      !!f && [f.ancestor, f.ours, f.theirs].some((e) => e?.mode === 0o120000)
    );
  }

  /**
   * Resolve the conflict by taking one whole side's blob verbatim.
   * Binary-safe, and correctly stages a deletion when the chosen side removed
   * the file (avoids the text pipeline truncating binary/deleted files).
   */
  private async handleTakeSide(side: 'ours' | 'theirs'): Promise<void> {
    if (!this.repositoryPath || !this.conflictFile || this.actionsBlocked) return;
    const startFile = this.conflictFile;
    if (this.hasUnsavedResolutions()) {
      // Take-side is NOT the in-editor swap acceptWholeFile's copy describes:
      // it writes the chosen blob to disk and stages it, and for a side that
      // dropped the file that means staging a deletion. In the flow that
      // realistically reaches this — a whole-file accept on a modify/delete
      // conflict, whose marker-free workdir file renders no per-block
      // buttons at all — "Using one whole-file version" would describe an
      // in-editor swap while hiding the on-disk consequence that is real.
      const deletesFile = side === 'ours' ? !startFile.ours : !startFile.theirs;
      const lead = deletesFile
        ? 'Taking this side deletes the file and stages the deletion'
        : 'Taking this side writes it to disk and stages the file';
      const proceed = await this.confirmOverwrite(
        'Take this whole side?',
        `${lead}, discarding ${this.overwriteLossText(
          'the picks, edits and whole-file choice currently in the output',
          'the edit that was typed but not applied',
        )}. This cannot be undone.`,
      );
      if (!proceed) return;
      // Re-check identity too: a file switch during the overwrite confirm
      // must not let this call take a side on a different file.
      if (!this.repositoryPath || !this.conflictFile || this.actionsBlocked) return;
      if (this.conflictFile !== startFile) return;
    }
    if (this.editingSegmentId !== null) {
      this.editingSegmentId = null;
      this.editDraft = '';
    }

    // Same capture-before-await as handleMarkResolved: the dispatched file
    // must be the one the call actually resolved.
    const file = this.conflictFile;
    // The verbatim take-side buttons only appear in the side-read-failure
    // (loadFailed) state — a reload afterwards would re-read the same
    // undecodable side blob and loop forever on Retry, presenting a
    // successful resolution as a failure. Remember it to land terminal.
    const wasLoadFailed = this.loadFailed;
    const token = ++this.resolveToken;
    this.resolving = true;
    this.dispatchEvent(new CustomEvent('resolve-started', { bubbles: true, composed: true }));
    try {
      const result = await gitService.resolveConflictTakeSide(
        this.repositoryPath,
        file.path,
        side,
      );

      if (result.success) {
        // The whole-side write supersedes any in-memory picks made before
        // it — without this, a resolved LAST file (no auto-advance target)
        // would flag its stale picks as "unsaved rework" and make Complete
        // raise a false confirm.
        if (token === this.resolveToken) {
          this.userTouched = false;
        }
        // When the taken file is still the one on screen (the last file
        // has no auto-advance target), the stale pre-take parse must not
        // sit there with Mark Resolved enabled — one click would fs::write
        // the old content back. A DELETION cannot reload (the workdir read
        // would fail into an error state whose verbatim button resurrects
        // the file); it lands in the terminal deleted state instead.
        const tookDeletion = side === 'ours' ? !file.ours : !file.theirs;
        if (this.conflictFile?.path === file.path) {
          if (tookDeletion) {
            if (token === this.resolveToken) {
              this.segments = [];
              this.editingSegmentId = null;
              this.resolvedAsDeleted = true;
            }
          } else if (file.isBinary || file.isSubmodule || wasLoadFailed) {
            // A chooser resolution (binary/submodule) has no text pipeline
            // to reload into, and a verbatim take from the side-read-failure
            // state would just re-fail the same undecodable blob — reloading
            // either re-renders live chooser/verbatim buttons whose second
            // click errors "No conflict found", or loops on Retry. Terminal
            // state, like deletions.
            if (token === this.resolveToken) {
              this.resolvedInPlace = true;
            }
          } else {
            await this.loadContents();
          }
        }
        this.dispatchEvent(new CustomEvent('conflict-resolved', {
          detail: { file },
          bubbles: true,
          composed: true,
        }));
      } else {
        console.error('Failed to resolve conflict:', result.error);
        showToast(`Failed to resolve conflict: ${result.error?.message ?? 'Unknown error'}`, 'error');
      }
    } catch (err) {
      console.error('Failed to resolve conflict:', err);
      showToast('Failed to resolve conflict', 'error');
    } finally {
      if (token === this.resolveToken) {
        this.resolving = false;
      }
      this.dispatchEvent(new CustomEvent('resolve-finished', { bubbles: true, composed: true }));
    }
  }

  // ── Scroll synchronization ────────────────────────────────────────────

  /**
   * All panes sync proportionally. The source panes share a row COUNT, but
   * line wrapping (`white-space: pre-wrap`) gives them different pixel
   * heights, so mirroring absolute scrollTop would misalign and, at the
   * bottom of a taller pane, snap the user's scroll back. Writes are skipped
   * when the target is already in place, so the echo scroll event a synced
   * pane fires (after the rAF guard has cleared) finds nothing to change and
   * the loop terminates instead of yanking the source pane around.
   */
  private syncScrollTo(target: HTMLElement, top: number): void {
    if (Math.abs(target.scrollTop - top) > 1) {
      target.scrollTop = top;
    }
  }

  private syncPanesFrom(source: HTMLElement, targetIds: string[]): void {
    if (this.syncingScroll) return;
    this.syncingScroll = true;

    const sourceMax = source.scrollHeight - source.clientHeight;
    const ratio = sourceMax > 0 ? source.scrollTop / sourceMax : 0;

    for (const id of targetIds) {
      const panel = this.shadowRoot?.getElementById(id);
      if (panel && panel !== source) {
        this.syncScrollTo(panel, ratio * (panel.scrollHeight - panel.clientHeight));
      }
    }

    requestAnimationFrame(() => {
      this.syncingScroll = false;
    });
  }

  private handleSourceScroll(e: Event): void {
    this.syncPanesFrom(e.target as HTMLElement, [
      'panel-ours',
      'panel-base',
      'panel-theirs',
      'panel-output',
    ]);
  }

  private handleOutputScroll(e: Event): void {
    this.syncPanesFrom(e.target as HTMLElement, ['panel-ours', 'panel-base', 'panel-theirs']);
  }

  // ── Change statistics ─────────────────────────────────────────────────

  private getChangeCount(side: 'ours' | 'theirs'): number {
    let changes = 0;
    for (const row of this.alignmentRows) {
      const idx = row[side];
      if (row.base === null) {
        if (idx !== null) changes++; // added
      } else if (idx === null) {
        changes++; // removed
      } else {
        const sideLine = side === 'ours' ? this.oursLines[idx] : this.theirsLines[idx];
        if (sideLine !== this.baseLines[row.base]) changes++; // modified
      }
    }
    return changes;
  }

  private getLineCount(content: string): number {
    return content ? content.split('\n').length : 0;
  }

  private formatChangeCount(count: number): string {
    return `${count} change${count === 1 ? '' : 's'} from base`;
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  /** Render one source pane from the shared three-way alignment rows. */
  private renderAlignedPane(side: 'ours' | 'base' | 'theirs'): ReturnType<typeof html> {
    if (this.sideReadErrors[side]) {
      return html`
        <div class="output-error">
          <div>Could not read this version.</div>
        </div>
      `;
    }

    const sideLines =
      side === 'ours' ? this.oursLines : side === 'theirs' ? this.theirsLines : this.baseLines;

    return html`
      <div class="code-view">
        ${this.alignmentRows.map((row) => {
          const idx = row[side];
          if (idx === null) {
            // Filler row keeps the panes vertically aligned. When base has a
            // line here, this side deleted it — show a struck-out filler.
            const removed = side !== 'base' && row.base !== null;
            return html`
              <div class="code-line ${removed ? 'line-removed-filler' : ''}">
                <span class="line-number"></span>
                <span class="line-content"></span>
              </div>
            `;
          }

          const line = sideLines[idx];
          let lineClass = '';
          let wsSegments: ReturnType<typeof computeInlineWhitespaceDiff> | null = null;
          // With an unreadable base there is nothing honest to diff against —
          // don't paint every line as an "addition" relative to a base we
          // never saw.
          if (side !== 'base' && !this.sideReadErrors.base) {
            if (row.base === null) {
              lineClass = 'code-addition';
            } else if (!this.sideReadErrors.base && line !== this.baseLines[row.base]) {
              if (isWhitespaceOnlyChange(this.baseLines[row.base], line)) {
                lineClass = 'code-ws-change';
                wsSegments = computeInlineWhitespaceDiff(this.baseLines[row.base], line);
              } else {
                lineClass = 'line-changed';
              }
            }
          }

          const lineContent = wsSegments
            ? this.renderInlineWhitespaceContent(wsSegments)
            : (this.renderHighlightedContent(line) || html`${' '}`);

          return html`
            <div class="code-line ${lineClass}">
              <span class="line-number">${idx + 1}</span>
              <span class="line-content">${lineContent}</span>
            </div>
          `;
        })}
      </div>
    `;
  }

  private renderSegmentEditor(): ReturnType<typeof html> {
    const rows = Math.min(Math.max(this.editDraft.split('\n').length + 1, 3), 20);
    return html`
      <div class="segment-editor">
        <textarea
          rows=${rows}
          .value=${this.editDraft}
          @input=${this.handleEditDraftInput}
          spellcheck="false"
        ></textarea>
        <div class="segment-editor-actions">
          <button class="btn" @click=${this.cancelEditSegment}>Cancel</button>
          <button class="btn btn-primary" @click=${this.applyEditSegment} ?disabled=${this.actionsBlocked}>
            Apply
          </button>
        </div>
      </div>
    `;
  }

  private renderResolvedSegment(segment: OutputSegment, startLineNum: number): ReturnType<typeof html> {
    if (this.editingSegmentId === segment.id) {
      return this.renderSegmentEditor();
    }

    const originClass = segment.origin ? `resolved-${segment.origin}` : '';
    const explanation = this.aiExplanations.get(segment.id);

    return html`
      <div class="output-segment ${originClass}">
        <div class="segment-actions">
          ${segment.origin && segment.fromConflict
            ? html`<span class="segment-origin-chip">${ORIGIN_LABELS[segment.origin]}</span>`
            : nothing}
          <button
            class="segment-btn"
            @click=${() => this.startEditSegment(segment)}
            ?disabled=${this.actionsBlocked}
            title="Edit this section"
          >
            Edit
          </button>
          ${segment.fromConflict
            ? html`
                <button
                  class="segment-btn"
                  @click=${() => this.resetSegment(segment.id)}
                  ?disabled=${this.actionsBlocked}
                  title="Undo this resolution and reopen the conflict"
                >
                  Reset
                </button>
              `
            : nothing}
        </div>
        ${segment.lines.length === 0
          ? html`
              <div class="code-line">
                <span class="line-number"></span>
                <span class="line-content segment-empty-note">(this resolution removed the section)</span>
              </div>
            `
          : segment.lines.map(
              (line, i) => html`
                <div class="code-line">
                  <span class="line-number">${startLineNum + i}</span>
                  <span class="line-content">${this.renderHighlightedContent(line) || html`${' '}`}</span>
                </div>
              `
            )}
        ${explanation ? html`<div class="ai-explanation">${explanation}</div>` : nothing}
      </div>
    `;
  }

  private renderConflictSegment(segment: OutputSegment): ReturnType<typeof html> {
    if (this.editingSegmentId === segment.id) {
      return this.renderSegmentEditor();
    }

    const labels = SIDE_LABELS[this.operationType] ?? SIDE_LABELS.merge;
    const isSuggesting = this.suggestingSegment === segment.id;
    // Surface the labels git recorded (branch names, commit refs) alongside
    // the generic role — they disambiguate the sides better than roles alone.
    const oursSideLabel = segment.oursLabel && segment.oursLabel !== 'OURS'
      ? `${labels.ours} · ${segment.oursLabel}`
      : labels.ours;
    const theirsSideLabel = segment.theirsLabel && segment.theirsLabel !== 'THEIRS'
      ? `${labels.theirs} · ${segment.theirsLabel}`
      : labels.theirs;

    // A side with a single empty string is one blank line, NOT empty —
    // choosing it inserts a blank line, so it must render as one.
    const renderSide = (lines: string[]) =>
      lines.length === 0
        ? html`<div class="conflict-side-empty">(no lines on this side)</div>`
        : lines.map(
            (line) => html`
              <div class="code-line">
                <span class="line-number"></span>
                <span class="line-content">${this.renderHighlightedContent(line) || html`${' '}`}</span>
              </div>
            `
          );

    return html`
      <div class="code-conflict-block">
        <div class="code-conflict-header">
          <span>Conflict</span>
          <div class="code-conflict-header-actions">
            <button
              class="btn btn-ours conflict-pick-btn"
              @click=${() => this.resolveConflictSegment(segment.id, 'ours')}
              ?disabled=${this.actionsBlocked}
            >
              Use Ours
            </button>
            <button
              class="btn btn-theirs conflict-pick-btn"
              @click=${() => this.resolveConflictSegment(segment.id, 'theirs')}
              ?disabled=${this.actionsBlocked}
            >
              Use Theirs
            </button>
            <button
              class="btn btn-both conflict-pick-btn"
              @click=${() => this.resolveConflictSegment(segment.id, 'both')}
              ?disabled=${this.actionsBlocked}
            >
              Use Both
            </button>
            <button
              class="btn conflict-pick-btn"
              @click=${() => this.startEditSegment(segment)}
              ?disabled=${this.actionsBlocked}
              title="Write this section by hand (starts from both sides)"
            >
              Edit
            </button>
            ${this.aiAvailable || this.aiBlockedReason
              ? html`
                  <button
                    class="btn btn-ai conflict-pick-btn"
                    @click=${() => this.handleSuggestSegment(segment.id)}
                    ?disabled=${!this.aiAvailable ||
                    this.suggestingSegment !== null ||
                    this.suggestingAll ||
                    this.actionsBlocked}
                    title=${this.aiBlockedReason || 'Use AI to resolve this conflict'}
                  >
                    ${isSuggesting ? 'AI...' : 'AI Suggest'}
                  </button>
                `
              : nothing}
          </div>
        </div>
        <div class="conflict-sides">
          <div class="code-conflict-side-ours">
            <div class="code-conflict-side-label">${oursSideLabel}</div>
            ${renderSide(segment.oursLines)}
          </div>
          <div class="code-conflict-divider"></div>
          <div class="code-conflict-side-theirs">
            <div class="code-conflict-side-label">${theirsSideLabel}</div>
            ${renderSide(segment.theirsLines)}
          </div>
        </div>
      </div>
    `;
  }

  private renderOutput(): ReturnType<typeof html> {
    if (this.resolvedAsDeleted) {
      // Terminal success state — deliberately NOT the error state: a
      // Retry/verbatim escape hatch here would resurrect the deletion.
      return html`
        <div class="loading">
          Resolved — this file was deleted by the resolution. Nothing further to do here.
        </div>
      `;
    }
    if (this.resolvedInPlace) {
      // A verbatim take from the side-read-failure state succeeded — show
      // the terminal notice, NOT the error state, whose Retry would loop on
      // the same undecodable blob and whose verbatim buttons would error
      // "No conflict found" on the already-resolved file.
      return html`
        <div class="loading">
          Resolved — the chosen version was staged. Nothing further to do here.
        </div>
      `;
    }
    if (this.loadFailed) {
      // Say what actually failed — blaming the working-directory file when
      // only a side blob was unreadable would be wrong and alarming.
      const sideFailed =
        this.sideReadErrors.base || this.sideReadErrors.ours || this.sideReadErrors.theirs;
      const labels = SIDE_LABELS[this.operationType] ?? SIDE_LABELS.merge;
      return html`
        <div class="output-error">
          <div>
            ${sideFailed
              ? 'Could not read all of this file’s versions.'
              : 'Could not read the merged file from the working directory.'}
          </div>
          <button class="btn btn-primary" @click=${this.handleReload} ?disabled=${this.actionsBlocked}>Retry</button>
          ${
            // Take-side writes one side's blob verbatim — it never touches the
            // BASE blob or the workdir text, so each side is offerable
            // whenever ITS OWN blob was readable (per-side, not all-or-none:
            // a missing base object in a shallow clone must not strand the
            // user with only Retry and Abort).
            (this.conflictFile?.ours && !this.sideReadErrors.ours) ||
            (this.conflictFile?.theirs && !this.sideReadErrors.theirs)
              ? html`
                  <div>
                    This can happen for text files in a legacy (non-UTF-8) encoding or a
                    missing version object. You can still resolve the conflict by taking one
                    side verbatim:
                  </div>
                  <div>
                    ${this.conflictFile?.ours && !this.sideReadErrors.ours
                      ? html`<button
                          class="btn btn-ours"
                          @click=${() => this.handleTakeSide('ours')}
                          ?disabled=${this.actionsBlocked}
                        >
                          Use ${labels.ours} (verbatim)
                        </button>`
                      : nothing}
                    ${this.conflictFile?.theirs && !this.sideReadErrors.theirs
                      ? html`<button
                          class="btn btn-theirs"
                          @click=${() => this.handleTakeSide('theirs')}
                          ?disabled=${this.actionsBlocked}
                        >
                          Use ${labels.theirs} (verbatim)
                        </button>`
                      : nothing}
                  </div>
                `
              : nothing
          }
        </div>
      `;
    }

    let lineNum = 1;
    return html`
      <div class="code-view">
        ${this.segments.map((segment) => {
          if (segment.type === 'resolved') {
            const startLineNum = lineNum;
            lineNum += segment.lines.length;
            return this.renderResolvedSegment(segment, startLineNum);
          }
          return this.renderConflictSegment(segment);
        })}
      </div>
    `;
  }

  private renderBinaryConflict(): ReturnType<typeof html> {
    if (!this.conflictFile) {
      return html`<div class="empty">Select a file to resolve</div>`;
    }
    // Same terminal notice as the text path — without it, a binary
    // deletion take on the last file leaves the "Choose which version to
    // keep" prompt on screen with both buttons dead forever.
    if (this.resolvedAsDeleted) {
      return html`
        <div class="loading">
          Resolved — this file was deleted by the resolution. Nothing further to do here.
        </div>
      `;
    }
    if (this.resolvedInPlace) {
      return html`
        <div class="loading">
          Resolved — the chosen version was staged. Nothing further to do here.
        </div>
      `;
    }

    const oursDeleted = !this.conflictFile.ours;
    const theirsDeleted = !this.conflictFile.theirs;
    const isLink = this.isSymlinkConflict;
    const labels = SIDE_LABELS[this.operationType] ?? SIDE_LABELS.merge;

    // For a link side the blob IS its target path (tiny text) — showing it
    // turns a blind "Use Ours/Theirs" guess into an informed choice.
    const sideDetail = (
      entry: ConflictFile['ours'],
      content: string,
      readFailed: boolean,
    ): string => {
      if (!entry) return 'deleted';
      if (entry.mode === 0o120000) {
        return readFailed ? 'a symbolic link (target unreadable)' : `a link → ${content.trim()}`;
      }
      return 'a regular file';
    };

    return html`
      <div class="toolbar">
        <span class="toolbar-title">${this.conflictFile.path}</span>
      </div>
      <div class="empty" style="flex-direction: column; gap: var(--spacing-md);">
        <div>
          <strong>${isLink ? 'Symbolic link conflict' : 'Binary file conflict'}</strong>
        </div>
        <div style="font-style: normal; text-align: center; max-width: 420px;">
          ${isLink
            ? 'The sides disagree about this symbolic link. Choose which version to keep.'
            : 'This file is binary and cannot be merged as text. Choose which version to keep.'}
        </div>
        ${isLink
          ? html`<div style="font-style: normal; text-align: center; max-width: 420px;">
              ${labels.ours}: ${sideDetail(this.conflictFile.ours, this.oursContent, this.sideReadErrors.ours)}<br />
              ${labels.theirs}: ${sideDetail(this.conflictFile.theirs, this.theirsContent, this.sideReadErrors.theirs)}
            </div>`
          : nothing}
        <div class="toolbar-actions">
          <button class="btn btn-ours" @click=${() => this.handleTakeSide('ours')} ?disabled=${this.actionsBlocked}>
            ${oursDeleted ? 'Use Ours (delete file)' : 'Use Ours'}
          </button>
          <button class="btn btn-theirs" @click=${() => this.handleTakeSide('theirs')} ?disabled=${this.actionsBlocked}>
            ${theirsDeleted ? 'Use Theirs (delete file)' : 'Use Theirs'}
          </button>
        </div>
      </div>
    `;
  }

  private renderSubmoduleConflict(): ReturnType<typeof html> {
    if (!this.conflictFile) {
      return html`<div class="empty">Select a file to resolve</div>`;
    }
    // Same terminal notice as the binary path — a pointer-removal take on
    // the last file must not leave dead chooser buttons on screen.
    if (this.resolvedAsDeleted) {
      return html`
        <div class="loading">
          Resolved — this submodule was removed by the resolution. Nothing further to do here.
        </div>
      `;
    }
    if (this.resolvedInPlace) {
      // A submodule pointer is staged, but its worktree files are NOT
      // checked out here — telling the user "nothing further to do" would
      // contradict the pre-resolution guidance and leave them confused by a
      // still-changed submodule path in the status pane.
      return html`
        <div class="loading">
          Resolved — the chosen commit is staged. Run <code>git submodule update</code> to
          check out its files.
        </div>
      `;
    }

    const ours = this.conflictFile.ours;
    const theirs = this.conflictFile.theirs;
    const labels = SIDE_LABELS[this.operationType] ?? SIDE_LABELS.merge;
    const short = (oid?: string): string => (oid ? oid.slice(0, 7) : '');
    // A submodule↔file TYPE conflict routes here too (any side being a
    // gitlink does) — the non-gitlink side's OID is a BLOB, and formatting
    // it like a commit pointer would mislead.
    const isLinkSide = (e: typeof ours): boolean => e?.mode === 0o160000;
    const sideDesc = (e: typeof ours): ReturnType<typeof html> | string =>
      !e
        ? 'submodule removed'
        : isLinkSide(e)
          ? html`commit <code>${short(e.oid)}</code>`
          : 'a regular file';
    const buttonLabel = (e: typeof ours, name: string): string =>
      !e
        ? `Use ${name} (remove submodule)`
        : isLinkSide(e)
          ? `Use ${name} (${short(e.oid)})`
          : `Use ${name} (file)`;

    return html`
      <div class="toolbar">
        <span class="toolbar-title">${this.conflictFile.path}</span>
      </div>
      <div class="empty" style="flex-direction: column; gap: var(--spacing-md);">
        <div>
          <strong>Submodule conflict</strong>
        </div>
        <div style="font-style: normal; text-align: center; max-width: 420px;">
          The sides disagree about this submodule. Choose which version to keep — the
          submodule's own files are not changed here (update the submodule afterwards to
          check a chosen commit out).
        </div>
        <div style="font-style: normal; text-align: center; max-width: 420px;">
          ${labels.ours}: ${sideDesc(ours)}<br />
          ${labels.theirs}: ${sideDesc(theirs)}
        </div>
        <div class="toolbar-actions">
          <button class="btn btn-ours" @click=${() => this.handleTakeSide('ours')} ?disabled=${this.actionsBlocked}>
            ${buttonLabel(ours, 'Ours')}
          </button>
          <button class="btn btn-theirs" @click=${() => this.handleTakeSide('theirs')} ?disabled=${this.actionsBlocked}>
            ${buttonLabel(theirs, 'Theirs')}
          </button>
        </div>
      </div>
    `;
  }

  render() {
    if (!this.conflictFile) {
      return html`<div class="empty">Select a file to resolve</div>`;
    }

    if (this.loading) {
      return html`<div class="loading">Loading file contents...</div>`;
    }

    // Submodule conflicts have no content at all (commit pointers, not
    // blobs) — offer the commit-pointer chooser.
    if (this.isSubmoduleConflict) {
      return this.renderSubmoduleConflict();
    }

    // Binary conflicts cannot be edited as text — editing would truncate the
    // file to 0 bytes. Offer whole-blob side selection instead.
    if (this.isBinaryConflict) {
      return this.renderBinaryConflict();
    }

    const labels = SIDE_LABELS[this.operationType] ?? SIDE_LABELS.merge;
    const conflictCount = this.conflictCount;

    return html`
      <div class="toolbar">
        <span class="toolbar-title">${this.conflictFile.path}</span>
        <div class="toolbar-actions">
          ${this.hasMergeTool ? html`
            <button
              class="btn"
              @click=${this.handleOpenExternalMergeTool}
              ?disabled=${this.launchingExternalTool ||
              this.confirmingWholeFileOverwrite ||
              this.externalToolLocked ||
              this.resolving ||
              this.resolvedAsDeleted ||
              this.resolvedInPlace}
              title="Open in external merge tool"
            >
              ${this.launchingExternalTool ? 'Waiting for tool...' : 'External Tool'}
            </button>
          ` : nothing}
          <button
            class="btn"
            @click=${this.handleReload}
            ?disabled=${this.actionsBlocked}
            title="Reload the file from disk, discarding resolutions made here"
          >
            Reload
          </button>
          ${this.conflictFile.ancestor
            ? html`<button
                class="btn"
                @click=${this.handleAcceptBase}
                ?disabled=${this.loadFailed || this.actionsBlocked || this.sideReadErrors.base}
                title=${this.sideReadErrors.base
                  ? 'The base version could not be read'
                  : 'Reset to common ancestor'}
              >
                Use Base
              </button>`
            : nothing}
          ${this.conflictFile && !this.conflictFile.ours
            ? html`<button class="btn btn-ours" @click=${() => this.handleTakeSide('ours')} ?disabled=${this.actionsBlocked} title="Ours deleted this file — keep it deleted">
                Use Ours (delete file)
              </button>`
            : html`<button class="btn btn-ours" @click=${this.handleAcceptOurs} ?disabled=${this.loadFailed || this.actionsBlocked} title="Use entire file from ${labels.ours}">
                Use Ours
              </button>`}
          ${this.conflictFile && !this.conflictFile.theirs
            ? html`<button class="btn btn-theirs" @click=${() => this.handleTakeSide('theirs')} ?disabled=${this.actionsBlocked} title="Theirs deleted this file — delete it">
                Use Theirs (delete file)
              </button>`
            : html`<button class="btn btn-theirs" @click=${this.handleAcceptTheirs} ?disabled=${this.loadFailed || this.actionsBlocked} title="Use entire file from ${labels.theirs}">
                Use Theirs
              </button>`}
          ${(this.aiAvailable || this.aiBlockedReason) && conflictCount > 0 ? html`
            <button
              class="btn btn-ai"
              @click=${this.handleAiResolveAll}
              ?disabled=${!this.aiAvailable ||
              this.suggestingAll ||
              this.suggestingSegment !== null ||
              this.actionsBlocked}
              title=${this.aiBlockedReason || 'Use AI to resolve all remaining conflicts'}
            >
              ${this.suggestingAll ? 'AI Resolving...' : 'AI Resolve All'}
            </button>
          ` : nothing}
          <button
            class="btn btn-primary"
            @click=${this.handleMarkResolved}
            ?disabled=${conflictCount > 0 ||
              this.loadFailed ||
              this.editingSegmentId !== null ||
              this.actionsBlocked}
            title=${conflictCount > 0
              ? `Resolve the remaining ${conflictCount} conflict${conflictCount === 1 ? '' : 's'} first`
              : this.editingSegmentId !== null
                ? 'Apply or cancel the open edit first'
                : 'Stage this file as resolved'}
          >
            Mark Resolved
          </button>
        </div>
      </div>

      <div class="editor-container">
        <div class="source-panels">
          <div class="editor-panel">
            <div class="panel-header ours">
              ${labels.ours}
              <span class="panel-stats">
                ${this.sideReadErrors.ours
                  ? 'read failed'
                  : this.sideReadErrors.base
                    ? 'base unavailable'
                    : this.formatChangeCount(this.getChangeCount('ours'))}
              </span>
              <button
                class="panel-header-btn"
                @click=${this.conflictFile.ours ? this.handleAcceptOurs : () => this.handleTakeSide('ours')}
                ?disabled=${this.actionsBlocked || (this.conflictFile.ours ? this.loadFailed : false)}
                title=${this.conflictFile.ours ? 'Use this version' : 'This side deleted the file — stage the deletion'}
              >
                ${this.conflictFile.ours ? 'Use' : 'Use (delete)'}
              </button>
            </div>
            <div class="panel-content readonly" id="panel-ours" @scroll=${this.handleSourceScroll}>
              ${this.renderAlignedPane('ours')}
            </div>
          </div>

          <div class="editor-panel">
            <div class="panel-header base">
              Base (Common Ancestor)
              <span class="panel-stats">
                ${this.sideReadErrors.base ? 'read failed' : `${this.getLineCount(this.baseContent)} lines`}
              </span>
            </div>
            <div class="panel-content readonly" id="panel-base" @scroll=${this.handleSourceScroll}>
              ${this.renderAlignedPane('base')}
            </div>
          </div>

          <div class="editor-panel">
            <div class="panel-header theirs">
              ${labels.theirs}
              <span class="panel-stats">
                ${this.sideReadErrors.theirs
                  ? 'read failed'
                  : this.sideReadErrors.base
                    ? 'base unavailable'
                    : this.formatChangeCount(this.getChangeCount('theirs'))}
              </span>
              <button
                class="panel-header-btn"
                @click=${this.conflictFile.theirs ? this.handleAcceptTheirs : () => this.handleTakeSide('theirs')}
                ?disabled=${this.actionsBlocked || (this.conflictFile.theirs ? this.loadFailed : false)}
                title=${this.conflictFile.theirs ? 'Use this version' : 'This side deleted the file — stage the deletion'}
              >
                ${this.conflictFile.theirs ? 'Use' : 'Use (delete)'}
              </button>
            </div>
            <div class="panel-content readonly" id="panel-theirs" @scroll=${this.handleSourceScroll}>
              ${this.renderAlignedPane('theirs')}
            </div>
          </div>
        </div>

        <div class="output-panel">
          <div class="panel-header output">
            Output
            ${this.loadFailed
              ? html`<span class="conflict-count">load failed</span>`
              : conflictCount > 0
                ? html`<span class="conflict-count">${conflictCount} conflict${conflictCount === 1 ? '' : 's'} remaining</span>`
                : html`<span class="conflict-count">No conflicts</span>`}
          </div>
          <div class="panel-content" id="panel-output" @scroll=${this.handleOutputScroll}>
            ${this.renderOutput()}
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-merge-editor': GnMergeEditor;
  }
}
