import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { codeStyles } from '../../styles/code-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import {
  settingsStore,
  clampDiffContextLines,
  DIFF_WHITESPACE_MODES,
  MIN_DIFF_CONTEXT_LINES,
  MAX_DIFF_CONTEXT_LINES,
} from '../../stores/settings.store.ts';
import type { DiffWhitespaceMode } from '../../types/api.types.ts';
import { CodeRenderMixin } from '../../mixins/code-render-mixin.ts';
import type { DiffFile, DiffHunk, DiffLine, StatusEntry } from '../../types/git.types.ts';
import {
  findWhitespaceOnlyPairs,
  computeInlineWhitespaceDiff,
  isWhitespaceOnlyChange,
  type InlineDiffSegment,
} from '../../utils/diff-utils.ts';
import './lv-image-diff.ts';
import { DiffVirtualScrollManager, DIFF_LINE_HEIGHT, type VisibleRange } from './diff-virtual-scroll.ts';

type DiffViewMode = 'unified' | 'split';

// Default cap on the number of diff lines fetched from the backend. When a diff
// exceeds this, the backend sets diff.truncated=true and we show a "Load full
// diff" affordance that re-fetches with no limit.
const DEFAULT_MAX_DIFF_LINES = 3000;

interface DiffSegment {
  text: string;
  changed: boolean;
}

interface WordDiffResult {
  oldSegments: DiffSegment[];
  newSegments: DiffSegment[];
}

/**
 * Compute word-level diff between two lines.
 * Splits lines into word tokens and uses an LCS algorithm to identify changed words.
 */
function computeWordDiff(oldLine: string, newLine: string): WordDiffResult {
  const tokenize = (line: string): string[] => {
    // Split on word boundaries: whitespace sequences and punctuation are separate tokens
    const tokens: string[] = [];
    const regex = /(\s+|[^\s\w]|[\w]+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      tokens.push(match[0]);
    }
    return tokens;
  };

  const oldTokens = tokenize(oldLine);
  const newTokens = tokenize(newLine);

  // Build LCS table
  const m = oldTokens.length;
  const n = newTokens.length;

  // Optimization: if either side is empty, everything on the other side is changed
  if (m === 0) {
    return {
      oldSegments: [],
      newSegments: newTokens.length > 0 ? [{ text: newLine, changed: true }] : [],
    };
  }
  if (n === 0) {
    return {
      oldSegments: oldTokens.length > 0 ? [{ text: oldLine, changed: true }] : [],
      newSegments: [],
    };
  }

  // Use a 2D table for LCS (kept simple for typical line lengths)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldTokens[i - 1] === newTokens[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find which tokens are in the LCS
  const oldInLCS = new Array<boolean>(m).fill(false);
  const newInLCS = new Array<boolean>(n).fill(false);
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldTokens[i - 1] === newTokens[j - 1]) {
      oldInLCS[i - 1] = true;
      newInLCS[j - 1] = true;
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  // Build segments by merging consecutive tokens with same changed status
  const buildSegments = (tokens: string[], inLCS: boolean[]): DiffSegment[] => {
    const segments: DiffSegment[] = [];
    for (let k = 0; k < tokens.length; k++) {
      const changed = !inLCS[k];
      if (segments.length > 0 && segments[segments.length - 1].changed === changed) {
        segments[segments.length - 1].text += tokens[k];
      } else {
        segments.push({ text: tokens[k], changed });
      }
    }
    return segments;
  };

  return {
    oldSegments: buildSegments(oldTokens, oldInLCS),
    newSegments: buildSegments(newTokens, newInLCS),
  };
}

interface SplitLine {
  left: DiffLine | null;
  right: DiffLine | null;
  isWhitespaceOnly?: boolean;
  inlineSegments?: InlineDiffSegment[];
  /**
   * The hunk this row came from and each side's index into `hunk.lines`.
   * Split rows are addressed by the same (hunkIndex, lineIndex) keys as the
   * unified view, so both views select and stage through one code path.
   */
  hunk: DiffHunk;
  hunkIndex: number;
  leftIndex: number | null;
  rightIndex: number | null;
}

interface DiffContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  line: DiffLine | null;
  hunk: DiffHunk | null;
}

interface FlatDiffItem {
  type: 'hunk-header' | 'line';
  hunkIndex: number;
  lineIndex?: number;
  line?: DiffLine;
  header?: string;
}

/** Unique key for a line within the diff */
type LineKey = `${number}-${number}`;

/**
 * Diff view component
 * Displays file diff with syntax highlighting and line numbers
 * Supports unified and split view modes
 */
@customElement('lv-diff-view')
export class LvDiffView extends CodeRenderMixin(LitElement) {
  static styles = [
    sharedStyles,
    codeStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border-bottom: 1px solid var(--color-border);
        flex-shrink: 0;
      }

      .file-info {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        flex: 1;
        min-width: 0;
      }

      .file-path {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        overflow: hidden;
      }

      .file-path span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .file-status {
        padding: 2px 6px;
        border-radius: var(--radius-sm);
        font-size: 10px;
        font-weight: var(--font-weight-bold);
        text-transform: uppercase;
        flex-shrink: 0;
      }

      .file-status.new,
      .file-status.untracked {
        background: var(--color-success-bg);
        color: var(--color-success);
      }

      .file-status.modified {
        background: var(--color-warning-bg);
        color: var(--color-warning);
      }

      .file-status.deleted {
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      .file-stats {
        display: flex;
        gap: var(--spacing-sm);
        font-size: var(--font-size-xs);
        flex-shrink: 0;
      }

      .additions {
        color: var(--color-success);
      }

      .deletions {
        color: var(--color-error);
      }

      .view-controls {
        display: flex;
        gap: var(--spacing-xs);
        flex-shrink: 0;
        margin-left: var(--spacing-md);
      }

      .view-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .view-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .view-btn.active {
        background: var(--color-primary);
        color: var(--color-text-inverse);
        border-color: var(--color-primary);
      }

      .view-btn svg {
        width: 14px;
        height: 14px;
      }

      .diff-option {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .diff-option select,
      .diff-option input {
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        font-family: inherit;
        cursor: pointer;
      }

      .diff-option input {
        width: 48px;
        cursor: text;
      }

      .diff-option select:hover,
      .diff-option input:hover {
        color: var(--color-text-primary);
      }

      .diff-option select:focus-visible,
      .diff-option input:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: 1px;
      }

      .diff-option-label {
        color: var(--color-text-muted);
        font-size: var(--font-size-xs);
        white-space: nowrap;
      }

      .diff-content {
        flex: 1;
        overflow: auto;
      }

      /* Unified view styles */
      .hunk {
        border-bottom: 1px solid var(--color-border);
      }

      .hunk:last-child {
        border-bottom: none;
      }

      .hunk-separator {
        position: relative;
        height: 8px;
        display: flex;
        align-items: center;
        min-width: max-content;
      }

      .hunk-separator-line {
        flex: 1;
        height: 1px;
        background: var(--color-border);
      }

      .hunk-separator-actions {
        display: none;
        position: absolute;
        right: var(--spacing-sm);
        top: 50%;
        transform: translateY(-50%);
        z-index: 1;
      }

      .hunk-separator:hover .hunk-separator-actions {
        display: flex;
        gap: var(--spacing-xs);
      }

      .hunk-separator-split {
        position: relative;
        height: 22px;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        padding: 0 var(--spacing-sm);
        border-top: 1px solid var(--color-border);
        min-width: max-content;
      }

      .hunk-actions {
        display: flex;
        gap: var(--spacing-xs);
        flex-shrink: 0;
        margin-left: var(--spacing-sm);
      }

      .hunk.active {
        border-left: 3px solid var(--color-primary);
      }

      .stage-btn {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-secondary);
        font-size: 11px;
        font-style: normal;
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .stage-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
        border-color: var(--color-text-muted);
      }

      .stage-btn.stage:hover {
        background: var(--color-success-bg);
        color: var(--color-success);
        border-color: var(--color-success);
      }

      .stage-btn.unstage:hover {
        background: var(--color-warning-bg);
        color: var(--color-warning);
        border-color: var(--color-warning);
      }

      /* The .stage-btn.stage:hover / .stage-btn.unstage:hover rules above are
         restated here so a disabled button does not still light up on hover. */
      .stage-btn:disabled,
      .stage-btn.stage:disabled:hover,
      .stage-btn.unstage:disabled:hover {
        opacity: 0.6;
        cursor: not-allowed;
        background: var(--color-bg-primary);
        color: var(--color-text-secondary);
        border-color: var(--color-border);
      }

      .stage-btn svg {
        width: 12px;
        height: 12px;
      }

      .line {
        display: flex;
        min-height: 20px;
        line-height: 20px;
        min-width: max-content;
      }

      .line:hover {
        filter: brightness(1.1);
      }

      .line-numbers {
        display: flex;
        flex-shrink: 0;
        user-select: none;
      }

      .line-no {
        width: 50px;
        padding: 0 var(--spacing-xs);
        text-align: right;
        color: var(--color-text-muted);
        background: var(--color-bg-secondary);
        border-right: 1px solid var(--color-border);
      }

      .line-no.old {
        border-right: none;
      }

      .line-origin {
        width: 20px;
        text-align: center;
        flex-shrink: 0;
        font-weight: var(--font-weight-bold);
      }

      .line-content {
        flex: 1;
        padding: 0 var(--spacing-sm);
        white-space: pre;
      }

      .line.code-addition .line-origin {
        color: var(--color-success);
      }

      .line.code-deletion .line-origin {
        color: var(--color-error);
      }

      /* Split view styles */
      .split-container {
        display: flex;
        flex: 1;
        overflow: hidden;
      }

      .split-pane {
        flex: 1;
        overflow: auto;
        min-width: 0;
      }

      .split-pane:first-child {
        border-right: 1px solid var(--color-border);
      }

      .split-pane-header {
        position: sticky;
        top: 0;
        z-index: 1;
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border-bottom: 1px solid var(--color-border);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
        text-align: center;
      }

      .split-line {
        display: flex;
        min-height: 20px;
        line-height: 20px;
        min-width: max-content;
      }

      .split-line:hover {
        filter: brightness(1.1);
      }

      .split-line-no {
        width: 50px;
        padding: 0 var(--spacing-xs);
        text-align: right;
        color: var(--color-text-muted);
        background: var(--color-bg-secondary);
        border-right: 1px solid var(--color-border);
        flex-shrink: 0;
        user-select: none;
      }

      .split-line-content {
        flex: 1;
        padding: 0 var(--spacing-sm);
        white-space: pre;
      }

      .split-line.empty {
        background: var(--color-bg-tertiary);
      }


      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--color-text-muted);
      }

      .error {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--color-error);
        padding: var(--spacing-md);
        text-align: center;
      }

      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--color-text-muted);
        text-align: center;
        padding: var(--spacing-lg);
      }

      .empty svg {
        width: 48px;
        height: 48px;
        margin-bottom: var(--spacing-sm);
        opacity: 0.5;
      }

      .binary-notice {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--color-text-muted);
        font-style: italic;
      }

      .partial-staging-info {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-info-bg, rgba(56, 132, 255, 0.1));
        border-bottom: 1px solid var(--color-info, #3884ff);
        color: var(--color-info, #3884ff);
        font-size: var(--font-size-xs);
      }

      .partial-staging-info svg {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
      }

      /* Edit mode styles */
      .edit-btn {
        padding: var(--spacing-xs) var(--spacing-sm);
        background: transparent;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-secondary);
        cursor: pointer;
        font-size: var(--font-size-xs);
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        transition: all 0.15s ease;
      }

      .edit-btn:hover {
        background: var(--color-bg-hover);
      }

      .edit-btn.active {
        background: var(--color-accent-bg);
        border-color: var(--color-accent);
        color: var(--color-accent);
      }

      .edit-btn svg {
        width: 14px;
        height: 14px;
      }

      .editor-container {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .editor-toolbar {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border-bottom: 1px solid var(--color-border);
      }

      .editor-toolbar button {
        padding: var(--spacing-xs) var(--spacing-md);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-sm);
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .editor-toolbar .cancel-btn {
        background: transparent;
        border: 1px solid var(--color-border);
        color: var(--color-text-secondary);
      }

      .editor-toolbar .cancel-btn:hover {
        background: var(--color-bg-hover);
      }

      .editor-toolbar .save-btn {
        background: var(--color-accent);
        border: 1px solid var(--color-accent);
        color: white;
      }

      .editor-toolbar .save-btn:hover {
        filter: brightness(1.1);
      }

      .editor-toolbar .save-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .editor-textarea {
        flex: 1;
        width: 100%;
        padding: var(--spacing-sm);
        border: none;
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
        line-height: 20px;
        resize: none;
        outline: none;
        tab-size: 2;
      }

      .editor-textarea:focus {
        outline: none;
      }

      /* The editor fills its pane edge to edge, so the shared keyboard focus
         ring is drawn inside the textarea instead of outside it, where the
         surrounding overflow: hidden would clip it away. */
      .editor-textarea {
        --lv-focus-ring-offset: -2px;
      }

      .edit-indicator {
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-warning-bg);
        color: var(--color-warning);
        font-size: var(--font-size-xs);
        text-align: center;
      }

      /* Conflicted-file redirect (conflicts are resolved in the merge editor) */
      .conflict-redirect {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--spacing-md);
        height: 100%;
        padding: var(--spacing-lg);
        text-align: center;
        color: var(--color-text-secondary);
      }

      .conflict-redirect svg {
        width: 32px;
        height: 32px;
        color: var(--color-warning);
      }

      .conflict-redirect-title {
        font-size: var(--font-size-md);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
      }

      .conflict-redirect-btn {
        padding: var(--spacing-xs) var(--spacing-md);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        border: 1px solid var(--color-primary);
        background: var(--color-primary);
        color: var(--color-text-inverse);
      }

      .conflict-redirect-btn:hover {
        background: var(--color-primary-hover);
      }

      /* Line selection mode */
      .line-selection-mode .line.code-addition,
      .line-selection-mode .line.code-deletion,
      .line-selection-mode .split-line.code-addition,
      .line-selection-mode .split-line.code-deletion,
      .line-selection-mode .split-line.code-ws-change {
        cursor: pointer;
      }

      .line-selection-mode .line.code-addition:hover,
      .line-selection-mode .line.code-deletion:hover,
      .line-selection-mode .split-line.code-addition:hover,
      .line-selection-mode .split-line.code-deletion:hover,
      .line-selection-mode .split-line.code-ws-change:hover {
        filter: brightness(1.15);
      }

      .line.selected,
      .split-line.selected {
        outline: 2px solid var(--color-primary);
        outline-offset: -2px;
        position: relative;
      }

      .line.selected::before,
      .split-line.selected::before {
        content: '';
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 4px;
        background: var(--color-primary);
      }

      .line-checkbox {
        display: none;
        width: 16px;
        height: 16px;
        margin: 0 4px;
        cursor: pointer;
        accent-color: var(--color-primary);
        flex-shrink: 0;
      }

      .line-selection-mode .line.code-addition .line-checkbox,
      .line-selection-mode .line.code-deletion .line-checkbox {
        display: inline-block;
      }

      .selection-actions {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-primary-alpha);
        border-bottom: 1px solid var(--color-primary);
        font-size: var(--font-size-xs);
      }

      .selection-info {
        flex: 1;
        color: var(--color-primary);
        font-weight: var(--font-weight-medium);
      }

      .selection-btn {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 12px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-secondary);
        font-size: 11px;
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .selection-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .selection-btn.primary {
        background: var(--color-primary);
        color: var(--color-text-inverse);
        border-color: var(--color-primary);
      }

      .selection-btn.primary:hover {
        filter: brightness(1.1);
      }

      .selection-btn:disabled,
      .selection-btn:disabled:hover {
        opacity: 0.6;
        cursor: not-allowed;
        filter: none;
      }

      .selection-btn svg {
        width: 12px;
        height: 12px;
      }

      /* Whitespace-only change origin color (diff-view specific) */
      .line.code-ws-change .line-origin {
        color: var(--color-warning);
      }

      /* Hunk navigation */
      .hunk-nav {
        display: flex;
        align-items: center;
        gap: 2px;
      }

      .hunk-counter {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        padding: 0 4px;
        min-width: 32px;
        text-align: center;
      }

      /* Context menu */
      .context-menu {
        position: fixed;
        z-index: var(--z-dropdown, 100);
        min-width: 180px;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        padding: var(--spacing-xs) 0;
      }

      .context-menu-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        width: 100%;
        padding: var(--spacing-xs) var(--spacing-md);
        border: none;
        background: none;
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        font-family: var(--font-family-base);
        text-align: left;
        cursor: pointer;
      }

      .context-menu-item:hover {
        background: var(--color-bg-hover);
      }

      .context-menu-item:disabled,
      .context-menu-item:disabled:hover {
        opacity: 0.6;
        cursor: not-allowed;
        background: none;
      }

      .context-menu-item svg {
        width: 14px;
        height: 14px;
        color: var(--color-text-muted);
      }

      .context-menu-divider {
        height: 1px;
        background: var(--color-border);
        margin: var(--spacing-xs) 0;
      }

      /* Word wrap mode */
      .diff-content.word-wrap .line-content,
      .diff-content.word-wrap .split-line-content {
        white-space: pre-wrap;
        word-break: break-all;
      }

      .diff-content.word-wrap .line,
      .diff-content.word-wrap .hunk-header {
        min-width: 0;
      }

      .split-container.word-wrap .split-line-content {
        white-space: pre-wrap;
        word-break: break-all;
      }

      .split-container.word-wrap .split-line {
        min-width: 0;
      }

      /* Word-level diff highlighting */
      .word-changed-del {
        background: var(--color-diff-del-word-bg, rgba(248, 81, 73, 0.4));
        border-radius: 2px;
      }

      .word-changed-add {
        background: var(--color-diff-add-word-bg, rgba(63, 185, 80, 0.4));
        border-radius: 2px;
      }

      .large-diff-info {
        padding: 8px 12px;
        background: var(--color-bg-secondary, #1e1e2e);
        color: var(--color-text-secondary);
        font-size: 12px;
        border-bottom: 1px solid var(--color-border);
        position: sticky;
        top: 0;
        z-index: 1;
      }

      .large-diff-info .btn-link {
        background: none;
        border: none;
        color: var(--color-primary);
        cursor: pointer;
        font-size: 12px;
        padding: 0;
        margin-left: var(--spacing-sm);
        text-decoration: underline;
      }

      .large-diff-info .btn-link:hover {
        filter: brightness(1.2);
      }

      .diff-virtualized-container {
        overflow: auto;
        flex: 1;
        min-height: 0;
        position: relative;
      }

      .virtual-hunk-header {
        align-items: center;
        color: var(--color-text-muted);
        font-style: italic;
      }

      .virtual-hunk-header .hunk-actions {
        margin-left: var(--spacing-sm);
      }

      .virtual-hunk-header .stage-btn {
        box-sizing: border-box;
        height: 16px;
        padding: 0 6px;
        font-size: 10px;
      }
    `,
  ];

  @property({ type: String }) repositoryPath: string = '';
  @property({ type: Object }) file: StatusEntry | null = null;
  @property({ type: Object }) commitFile: { commitOid: string; filePath: string } | null = null;
  @property({ type: Boolean }) hasPartialStaging = false;

  @state() private diff: DiffFile | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private viewMode: DiffViewMode = 'unified';
  // Word wrap is an app setting (Settings > Diff); the toolbar button below is
  // the same preference, not a second one.
  @state() private wordWrap: boolean = settingsStore.getState().wordWrap;
  // Whitespace mode and context lines are app settings too (Settings > Diff);
  // the toolbar controls below write the same preferences, so a choice made in
  // either place survives a restart and applies to the very next diff.
  @state() private ignoreWhitespace: DiffWhitespaceMode =
    settingsStore.getState().diffIgnoreWhitespace;
  @state() private contextLines: number = settingsStore.getState().diffContextLines;
  @state() private editMode = false;
  @state() private editContent = '';
  @state() private originalContent = '';
  /**
   * The path the edit buffer was loaded from. The pane is a single reused
   * element, so `file` can be reassigned under an open editor; without this the
   * buffer and the Save target could name two different files.
   */
  private editPath: string | null = null;
  private editRepositoryPath: string | null = null;
  private editRequestId = 0;
  @state() private saving = false;
  private saveContextChanged = false;
  @state() private contextMenu: DiffContextMenuState = { visible: false, x: 0, y: 0, line: null, hunk: null };
  @state() private selectedLines: Set<LineKey> = new Set();
  @state() private lineSelectionMode = false;
  @state() private currentHunkIndex = 0;
  @state() private hasDiffTool = false;
  @state() private launchingDiffTool = false;
  // When true, load the diff without a line cap (set by "Load full diff").
  @state() private showFullDiff = false;

  private settingsUnsubscribe: (() => void) | null = null;
  private virtualScrollManager = new DiffVirtualScrollManager();
  private flatLines: FlatDiffItem[] = [];
  private diffScrollTop = 0;
  private diffRequestId = 0;
  // Reactive: the stage/unstage buttons bind `?disabled` to it, so a second
  // click while a mutation is in flight is visibly refused rather than
  // silently dropped by the guards in the handlers below.
  @state() private diffMutationInProgress = false;
  private loadedWorkingDiffContext: {
    repositoryPath: string;
    filePath: string;
    isStaged: boolean;
  } | null = null;

  private handleDocumentClick = (): void => {
    if (this.contextMenu.visible) {
      this.contextMenu = { ...this.contextMenu, visible: false };
    }
  };

  private handleKeydown = (e: KeyboardEvent): void => {
    if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      this.goToNextHunk();
    } else if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault();
      this.goToPrevHunk();
    } else if (e.key === ']' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const target = e.target as HTMLElement;
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return;
      e.preventDefault();
      this.goToNextHunk();
    } else if (e.key === '[' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const target = e.target as HTMLElement;
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return;
      e.preventDefault();
      this.goToPrevHunk();
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('click', this.handleDocumentClick);
    // Word wrap comes from the shared setting, so the Settings dialog toggle and
    // the toolbar button below stay in step.
    const initial = settingsStore.getState();
    this.wordWrap = initial.wordWrap;
    this.ignoreWhitespace = initial.diffIgnoreWhitespace;
    this.contextLines = initial.diffContextLines;
    this.settingsUnsubscribe = settingsStore.subscribe((state) => {
      this.wordWrap = state.wordWrap;
      // Whitespace mode and context lines change what the backend renders, so
      // they need a re-fetch — but only when they actually changed, or every
      // unrelated settings write (theme, font size, ...) would reload the diff.
      const diffOptionsChanged =
        state.diffIgnoreWhitespace !== this.ignoreWhitespace ||
        state.diffContextLines !== this.contextLines;
      this.ignoreWhitespace = state.diffIgnoreWhitespace;
      this.contextLines = state.diffContextLines;
      if (diffOptionsChanged) void this.reloadDiff();
    });
    this.addEventListener('keydown', this.handleKeydown);
    // Make host focusable for keyboard shortcuts
    if (!this.hasAttribute('tabindex')) {
      this.setAttribute('tabindex', '0');
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('click', this.handleDocumentClick);
    this.removeEventListener('keydown', this.handleKeydown);
    this.settingsUnsubscribe?.();
    this.settingsUnsubscribe = null;
  }

  willUpdate(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has('diff')) {
      this.buildFlatLines();
      this.diffScrollTop = 0;
    }
  }

  async updated(changedProperties: Map<string, unknown>): Promise<void> {
    // A <select>'s `.value` is applied before its <option> children exist, so
    // the property binding alone cannot select the stored mode on first render.
    // Push it in after the options are in the DOM.
    const whitespaceSelect = this.shadowRoot?.querySelector<HTMLSelectElement>(
      '#diff-ignore-whitespace'
    );
    if (whitespaceSelect && whitespaceSelect.value !== this.ignoreWhitespace) {
      whitespaceSelect.value = this.ignoreWhitespace;
    }

    // A different file/commit resets the "show full diff" opt-in so large diffs
    // are re-truncated by default.
    if (
      changedProperties.has('file') ||
      changedProperties.has('commitFile') ||
      changedProperties.has('repositoryPath')
    ) {
      this.showFullDiff = false;
      // The editor does NOT follow the selection. This pane is one reused
      // element, so selecting another file while the editor was open left the
      // header naming the new file and the textarea still holding the old
      // one's text — and Save writes `editContent` to `this.file.path`, i.e.
      // the previous file's content over the newly selected file, destroying
      // its uncommitted changes with no git object and no reflog entry.
      this.exitEditModeOnFileChange();
      const previousFile = changedProperties.get('file') as StatusEntry | null | undefined;
      const previousCommitFile = changedProperties.get('commitFile') as
        | { commitOid: string; filePath: string }
        | null
        | undefined;
      const editContextChanged =
        (changedProperties.has('repositoryPath') &&
          changedProperties.get('repositoryPath') !== this.repositoryPath) ||
        (changedProperties.has('file') &&
          (previousFile?.path !== this.file?.path ||
            previousFile?.isConflicted !== this.file?.isConflicted)) ||
        (changedProperties.has('commitFile') &&
          (previousCommitFile?.commitOid !== this.commitFile?.commitOid ||
            previousCommitFile?.filePath !== this.commitFile?.filePath));
      if (editContextChanged) this.editRequestId++;

      const replacedExistingContext =
        (changedProperties.has('file') && changedProperties.get('file') !== null) ||
        (changedProperties.has('commitFile') && changedProperties.get('commitFile') !== null) ||
        (changedProperties.has('repositoryPath') && !!changedProperties.get('repositoryPath'));
      if (replacedExistingContext) {
        this.selectedLines = new Set();
        this.contextMenu = { ...this.contextMenu, visible: false, line: null, hunk: null };
        this.currentHunkIndex = 0;
      }

      if (this.commitFile) {
        await this.loadCommitDiff();
      } else if (this.file) {
        await this.loadWorkingDiff();
      } else {
        this.diffRequestId++;
        this.loadedWorkingDiffContext = null;
        this.diff = null;
        this.error = null;
        this.loading = false;
      }
    }
    if (changedProperties.has('repositoryPath') && this.repositoryPath) {
      await this.checkDiffToolAvailability();
    }
  }

  private async checkDiffToolAvailability(): Promise<void> {
    if (!this.repositoryPath) return;
    try {
      const result = await gitService.getDiffToolConfig(this.repositoryPath);
      this.hasDiffTool = result.success && !!result.data?.tool;
    } catch {
      this.hasDiffTool = false;
    }
  }

  private async handleOpenDiffTool(): Promise<void> {
    if (!this.repositoryPath) return;

    const filePath = this.commitFile?.filePath ?? this.file?.path;
    if (!filePath) return;

    this.launchingDiffTool = true;
    try {
      const result = await gitService.launchDiffTool(
        this.repositoryPath,
        filePath,
        this.file?.isStaged,
        this.commitFile?.commitOid,
      );
      if (result.success && result.data?.success) {
        showToast('Diff tool completed', 'success');
      } else {
        showToast(result.data?.message ?? result.error?.message ?? 'Diff tool failed', 'error');
      }
    } catch {
      showToast('Failed to launch diff tool', 'error');
    } finally {
      this.launchingDiffTool = false;
    }
  }

  /**
   * True while the pane still shows the file an apply was made against.
   *
   * Deliberately weaker than `isSameWorkingDiffContext`: it ignores the loaded
   * diff, so it stays true while a reload for the SAME file is still in flight
   * (the "Load full diff" link is not disabled during an apply, so it can start
   * one mid-apply, and it leaves no loaded context behind). That in-flight
   * reload asked for the diff BEFORE the apply landed, so gating on the loaded
   * context would both keep the invalidated positional
   * `${hunkIndex}-${lineIndex}` keys and let the pre-apply content settle with
   * nothing left to correct it - `status-changed` only re-binds the file when
   * its status or conflicted flag changed, which a partial apply does not do.
   * Re-running `loadWorkingDiff()` bumps `diffRequestId`, so the newer fetch
   * discards the superseded one.
   */
  private isStillOnAppliedFile(context: {
    repositoryPath: string;
    filePath: string;
    isStaged: boolean;
  }): boolean {
    return (
      !this.commitFile &&
      this.repositoryPath === context.repositoryPath &&
      this.file?.path === context.filePath &&
      this.file?.isStaged === context.isStaged
    );
  }

  /**
   * Clear the pane when the reload that followed an apply found nothing left.
   *
   * Staging the last unstaged hunk (or unstaging the last staged one) empties
   * this side of the index for the file, and the backend answers that reload
   * with a "not found in diff" error — which would otherwise be painted into
   * the pane as raw text. The shell cannot rescue it either: the surviving
   * entry for the other side has the same path and status, so it never swaps
   * the bound file. Clear and let the shell close the diff instead.
   *
   * A reload for another file can win the request race while the apply is
   * still awaiting, leaving `error`/`file` describing that other file, so the
   * selection has to still be the file we applied to.
   * `isSameWorkingDiffContext` cannot be used for that: a "not found in diff"
   * reload leaves no loaded context, which is exactly the case handled here.
   */
  private clearIfFullyApplied(context: {
    repositoryPath: string;
    filePath: string;
    isStaged: boolean;
  }): void {
    if (!this.isStillOnAppliedFile(context)) return;
    if (!this.error?.includes('not found in diff')) return;
    this.error = null;
    this.diff = null;
    this.file = null;
    this.dispatchEvent(new CustomEvent('file-cleared', {
      bubbles: true,
      composed: true,
    }));
  }

  /**
   * The whitespace/context options every diff fetch carries. Sent on all three
   * paths (unstaged, staged and commit-file) so the toolbar controls mean the
   * same thing wherever the pane is used.
   */
  private diffRenderOptions(): gitService.DiffRenderOptions {
    return {
      contextLines: this.contextLines,
      ignoreWhitespace: this.ignoreWhitespace,
    };
  }

  /** Re-fetch the currently shown diff (used when a render option changes). */
  private async reloadDiff(): Promise<void> {
    if (this.commitFile) {
      await this.loadCommitDiff();
    } else if (this.file) {
      await this.loadWorkingDiff();
    }
  }

  private async loadWorkingDiff(): Promise<void> {
    if (!this.repositoryPath || !this.file) return;
    const requestId = ++this.diffRequestId;
    const repositoryPath = this.repositoryPath;
    const filePath = this.file.path;
    const isStaged = this.file.isStaged;
    this.loadedWorkingDiffContext = null;
    // Conflicted files render a redirect to the merge editor — don't load the
    // marker-laden diff at all.
    if (this.isConflicted) {
      this.loading = false;
      this.error = null;
      this.diff = null;
      return;
    }

    this.loading = true;
    this.error = null;
    this.diff = null;
    this.hunkLinePairsCache = new WeakMap();
    this.wordDiffCache = new WeakMap();

    try {
      // Initialize highlighter and detect language
      await this.initCodeLanguage(filePath);

      const result = await gitService.getFileDiff(
        repositoryPath,
        filePath,
        isStaged,
        this.showFullDiff ? undefined : DEFAULT_MAX_DIFF_LINES,
        this.diffRenderOptions()
      );

      if (requestId !== this.diffRequestId) return;
      if (result.success) {
        this.diff = result.data!;
        this.loadedWorkingDiffContext = { repositoryPath, filePath, isStaged };
      } else {
        this.error = result.error?.message ?? 'Failed to load diff';
      }
    } catch (err) {
      if (requestId !== this.diffRequestId) return;
      this.error = err instanceof Error ? err.message : 'Unknown error';
    } finally {
      if (requestId === this.diffRequestId) this.loading = false;
    }
  }

  private async loadCommitDiff(): Promise<void> {
    if (!this.repositoryPath || !this.commitFile) return;
    const requestId = ++this.diffRequestId;
    const repositoryPath = this.repositoryPath;
    const commitOid = this.commitFile.commitOid;
    const filePath = this.commitFile.filePath;
    this.loadedWorkingDiffContext = null;

    this.loading = true;
    this.error = null;
    this.diff = null;
    this.hunkLinePairsCache = new WeakMap();
    this.wordDiffCache = new WeakMap();

    try {
      // Initialize highlighter and detect language
      await this.initCodeLanguage(filePath);

      const result = await gitService.getCommitFileDiff(
        repositoryPath,
        commitOid,
        filePath,
        this.showFullDiff ? undefined : DEFAULT_MAX_DIFF_LINES,
        this.diffRenderOptions()
      );

      if (requestId !== this.diffRequestId) return;
      if (result.success) {
        this.diff = result.data!;
      } else {
        this.error = result.error?.message ?? 'Failed to load diff';
      }
    } catch (err) {
      if (requestId !== this.diffRequestId) return;
      this.error = err instanceof Error ? err.message : 'Unknown error';
    } finally {
      if (requestId === this.diffRequestId) this.loading = false;
    }
  }

  private currentWorkingDiffContext(): {
    repositoryPath: string;
    filePath: string;
    isStaged: boolean;
  } | null {
    if (
      this.commitFile ||
      !this.file ||
      !this.loadedWorkingDiffContext ||
      this.loadedWorkingDiffContext.repositoryPath !== this.repositoryPath ||
      this.loadedWorkingDiffContext.filePath !== this.file.path ||
      this.loadedWorkingDiffContext.isStaged !== this.file.isStaged
    ) return null;
    return this.loadedWorkingDiffContext;
  }

  private isSameWorkingDiffContext(context: {
    repositoryPath: string;
    filePath: string;
    isStaged: boolean;
  }): boolean {
    const current = this.currentWorkingDiffContext();
    return !!(
      current &&
      current.repositoryPath === context.repositoryPath &&
      current.filePath === context.filePath &&
      current.isStaged === context.isStaged
    );
  }

  private setViewMode(mode: DiffViewMode): void {
    this.viewMode = mode;
  }

  private toggleWordWrap(): void {
    // Writing the shared setting keeps the Settings dialog toggle and this button
    // in step; the store subscription updates `this.wordWrap`.
    settingsStore.getState().setWordWrap(!this.wordWrap);
  }

  private handleIgnoreWhitespaceChange(e: Event): void {
    const select = e.target as HTMLSelectElement;
    // The store subscription updates `this.ignoreWhitespace` and re-fetches, so
    // the Settings dialog row and this control never drift apart.
    settingsStore.getState().setDiffIgnoreWhitespace(select.value as DiffWhitespaceMode);
  }

  private handleContextLinesChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const clamped = clampDiffContextLines(parseInt(input.value, 10));
    // A number input accepts out-of-range text; write the clamped value back so
    // the field never shows a number the diff was not rendered with.
    input.value = String(clamped);
    settingsStore.getState().setDiffContextLines(clamped);
  }

  /**
   * The empty-diff message. When a whitespace mode is active, "no changes" is
   * misleading on its own — the file does differ, git is just not showing it.
   */
  private get emptyDiffMessage(): string {
    if (this.ignoreWhitespace === 'none') return 'No changes in this file';
    const label =
      DIFF_WHITESPACE_MODES.find((m) => m.value === this.ignoreWhitespace)?.label ??
      this.ignoreWhitespace;
    return `No changes in this file with "${label}" applied`;
  }

  /**
   * Check if edit mode is available (only for working directory changes, not commit diffs)
   */
  private get canEdit(): boolean {
    // Conflicted files must not be free-text edited here — their working-tree
    // content is git's conflict-marker text.
    return (
      !this.saving &&
      this.file !== null &&
      this.commitFile === null &&
      !this.diff?.isBinary &&
      !this.isConflicted
    );
  }

  /**
   * Toggle edit mode
   */
  private async toggleEditMode(): Promise<void> {
    if (this.saving) return;
    if (!this.canEdit) return;

    if (!this.editMode) {
      // Enter edit mode - load file content
      await this.loadFileContent();
    } else {
      // Same guard as Cancel: the header toggle is one click away from the
      // textarea and must not be the cheaper route to the same loss.
      await this.cancelEdit();
    }
  }

  /**
   * Load file content for editing
   */
  private async loadFileContent(): Promise<void> {
    if (!this.repositoryPath || !this.file) return;
    const requestId = ++this.editRequestId;
    const repositoryPath = this.repositoryPath;
    const filePath = this.file.path;

    const result = await gitService.readFileContent(
      repositoryPath,
      filePath,
      false // Read from working directory
    );

    if (
      requestId !== this.editRequestId ||
      this.repositoryPath !== repositoryPath ||
      this.file?.path !== filePath ||
      this.commitFile
    ) return;

    if (result.success && result.data !== undefined) {
      this.originalContent = result.data;
      this.editContent = result.data;
      this.editPath = filePath;
      this.editRepositoryPath = repositoryPath;
      this.editMode = true;
      return;
    }

    // Without this the Edit button was a no-op on two reachable failures: the
    // file was deleted or renamed on disk since the last status refresh
    // (FILE_NOT_FOUND), or it is not valid UTF-8 despite passing the diff's
    // binary heuristic. Neither showed anything — and read_file_content is
    // excluded from the Output panel by its `read_` prefix, so the failure was
    // not even recorded anywhere. The backend deliberately gives the two cases
    // separate codes because they are presented very differently.
    showToast(
      result.error?.code === 'FILE_NOT_FOUND'
        ? `${filePath} is no longer on disk — refresh to see its current state`
        : result.error?.message ?? 'Could not open this file for editing',
      'error'
    );
  }

  /**
   * Handle content change in editor
   */
  private handleEditorChange(e: Event): void {
    const textarea = e.target as HTMLTextAreaElement;
    this.editContent = textarea.value;
  }

  /**
   * Handle tab key in editor
   */
  private handleEditorKeydown(e: KeyboardEvent): void {
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = e.target as HTMLTextAreaElement;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      this.editContent = this.editContent.substring(0, start) + '  ' + this.editContent.substring(end);
      // Set cursor position after the inserted spaces
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      });
    } else if (e.key === 'Escape') {
      void this.cancelEdit();
    } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.saveEdit();
    }
  }

  /**
   * Save edits
   */
  private async saveEdit(): Promise<void> {
    // `editMode` first: once the editor has closed, `editContent` is empty, and
    // a save from a stale binding would truncate the file to nothing.
    if (!this.editMode || !this.repositoryPath || !this.file || this.saving) return;
    // Identity, not just existence: the buffer must belong to the file it is
    // about to be written to.
    if (
      (this.editPath && this.editPath !== this.file.path) ||
      (this.editRepositoryPath && this.editRepositoryPath !== this.repositoryPath)
    ) {
      showToast('The editor no longer matches the selected file', 'error');
      return;
    }

    const requestId = this.editRequestId;
    const repositoryPath = this.repositoryPath;
    const filePath = this.file.path;
    const content = this.editContent;
    this.saveContextChanged = false;
    this.saving = true;

    const result = await gitService.writeFileContent(
      repositoryPath,
      filePath,
      content,
      false // Don't auto-stage
    );

    this.saving = false;

    if (result.success) {
      this.dispatchEvent(new CustomEvent('file-edited', {
        bubbles: true,
        composed: true,
        detail: { path: filePath, repositoryPath }
      }));
      if (
        requestId !== this.editRequestId ||
        this.editRepositoryPath !== repositoryPath ||
        this.editPath !== filePath
      ) return;
      this.discardEditBuffer();
      // Reload the diff to show updated changes
      await this.loadWorkingDiff();
    } else {
      showToast(
        this.saveContextChanged
          ? `Failed to save ${filePath}; its unsaved edits were discarded when the selection changed`
          : `Failed to save file: ${result.error?.message ?? 'Unknown error'}`,
        'error'
      );
    }
  }

  /**
   * Is there typed text the user has not saved?
   *
   * Exposed because this pane can be torn out of the tree by gestures it never
   * sees — the diff header's ×, Escape, and a repository tab switch all set
   * `showDiff = false` in app-shell. Every teardown the component CAN see
   * already guards (Cancel confirms, a file change warns); the host needs this
   * to close the gap for the ones it owns.
   *
   * A save in flight is NOT unsaved: the write is already on its way to disk
   * and `saveEdit` reports its own failure, so counting it here would tell the
   * user their edits were discarded moments before they land.
   */
  public get hasUnsavedEdits(): boolean {
    return this.editMode && this.hasChanges && !this.saving;
  }

  /** The file the unsaved buffer belongs to, for a message naming it. */
  public get editingPath(): string | null {
    return this.editPath;
  }

  /** Leave edit mode without touching disk. */
  private discardEditBuffer(): void {
    this.editMode = false;
    this.editContent = '';
    this.originalContent = '';
    this.editPath = null;
    this.editRepositoryPath = null;
  }

  /**
   * Selecting another file (or a commit's file) closes the editor.
   *
   * A confirm is not possible here — the property has already changed by the
   * time `updated()` runs, so there is nothing left to cancel. Unsaved text is
   * therefore reported rather than silently dropped.
   *
   * The same file turning conflicted closes the editor too, matching the
   * invalidation `updated()` already applies to an in-flight load. `render()`
   * hides the textarea behind the conflict notice, so the buffer would survive
   * unreachable — and reappear over the merge the user then resolved, with
   * Save writing pre-conflict text over the resolution.
   */
  private exitEditModeOnFileChange(): void {
    if (!this.editMode) return;
    if (
      !this.commitFile &&
      !this.file?.isConflicted &&
      this.editPath &&
      this.file?.path === this.editPath &&
      this.editRepositoryPath === this.repositoryPath
    ) return;
    if (this.saving) this.saveContextChanged = true;
    const lost = this.hasChanges && !this.saving ? this.editPath : null;
    this.discardEditBuffer();
    if (lost) {
      showToast(`Unsaved edits to ${lost} were discarded`, 'warning');
    }
  }

  /**
   * Cancel editing.
   *
   * Gated on unsaved text, like every other editing surface in the app
   * (lv-hooks-dialog, lv-merge-editor). Escape reaches here too, and Escape is
   * bound app-wide to "close diff" — so it gets pressed reflexively.
   */
  private async cancelEdit(): Promise<void> {
    if (this.saving) return;
    if (this.hasChanges) {
      const confirmed = await showConfirm(
        'Discard edits?',
        `This file has unsaved edits — closing the editor discards them.`,
        'warning'
      );
      if (!confirmed) return;
    }
    this.discardEditBuffer();
  }

  /**
   * Check if content has been modified
   */
  private get hasChanges(): boolean {
    return this.editContent !== this.originalContent;
  }

  /**
   * Check if this is a conflicted file
   */
  private get isConflicted(): boolean {
    return this.file?.isConflicted ?? false;
  }

  /** Ask the app shell to open the structured conflict-resolution flow. */
  private handleOpenMergeEditor(): void {
    this.dispatchEvent(
      new CustomEvent('open-conflict-dialog', {
        // Pass the file so the dialog opens preselected on it.
        detail: { filePath: this.file?.path },
        bubbles: true,
        composed: true,
      })
    );
  }

  /**
   * Shown instead of the diff for conflicted files: the raw working-tree
   * content contains conflict markers, which must never be rendered.
   */
  private renderConflictedNotice(): ReturnType<typeof html> {
    return html`
      <div class="conflict-redirect">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
          <line x1="12" y1="9" x2="12" y2="13"></line>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
        <div class="conflict-redirect-title">${this.file?.path ?? ''} has merge conflicts</div>
        <div>Resolve them side by side in the merge editor.</div>
        <button class="conflict-redirect-btn" @click=${this.handleOpenMergeEditor}>
          Open Merge Editor
        </button>
      </div>
    `;
  }

  /**
   * Build a patch string for a specific hunk
   * The patch format requires diff headers and the hunk content
   */
  private buildHunkPatch(hunk: DiffHunk): string {
    if (!this.diff || !this.file) return '';

    const filePath = this.file.path;
    const fileStatus = this.diff.status;
    const lines: string[] = [];

    // Add diff header - use /dev/null for new/untracked files
    if (fileStatus === 'new' || fileStatus === 'untracked') {
      lines.push('--- /dev/null');
    } else {
      lines.push(`--- a/${filePath}`);
    }

    if (fileStatus === 'deleted') {
      lines.push('+++ /dev/null');
    } else {
      lines.push(`+++ b/${filePath}`);
    }

    // Add hunk header - trim whitespace and ensure clean format
    const header = hunk.header.trim();
    lines.push(header);

    // Add hunk lines with proper prefixes
    for (const line of hunk.lines) {
      // Skip metadata lines that shouldn't be in the patch content
      if (line.origin === 'hunk-header' || line.origin === 'file-header' || line.origin === 'binary') {
        continue;
      }

      // Handle "no newline at end of file" markers
      if (
        line.origin === 'del-eofnl' ||
        line.origin === 'add-eofnl' ||
        line.origin === 'context-eofnl'
      ) {
        lines.push('\\ No newline at end of file');
        continue;
      }

      // Determine prefix based on origin
      let prefix = ' ';
      if (line.origin === 'addition') prefix = '+';
      else if (line.origin === 'deletion') prefix = '-';

      // Strip only the trailing newline. A \r must be kept: in a CRLF file it
      // is part of the file's bytes, and the patch context has to byte-match
      // the index blob or `git apply --cached` rejects it.
      const content = line.content.replace(/\n$/, '');

      lines.push(prefix + content);
    }

    // Ensure patch ends with newline
    return lines.join('\n') + '\n';
  }

  /**
   * Create a unique key for a line in the diff.
   *
   * The key is constructed from numeric indices (hunkIndex and lineIndex),
   * which guarantees no special characters in the key format.
   * This is used for tracking selected lines in the Set.
   */
  private getLineKey(hunkIndex: number, lineIndex: number): LineKey {
    return `${hunkIndex}-${lineIndex}`;
  }

  /**
   * Toggle line selection mode
   */
  private toggleLineSelectionMode(): void {
    this.lineSelectionMode = !this.lineSelectionMode;
    if (!this.lineSelectionMode) {
      this.selectedLines = new Set();
    }
  }

  /**
   * Toggle selection of a specific line
   */
  private toggleLineSelection(hunkIndex: number, lineIndex: number, line: DiffLine): void {
    // Only allow selecting additions and deletions
    if (line.origin !== 'addition' && line.origin !== 'deletion') return;

    const key = this.getLineKey(hunkIndex, lineIndex);
    const newSelected = new Set(this.selectedLines);
    if (newSelected.has(key)) {
      newSelected.delete(key);
    } else {
      newSelected.add(key);
    }
    this.selectedLines = newSelected;
  }

  /**
   * Toggle a whole split row's selection. A whitespace-only row is one change
   * shown on both sides, so its two underlying lines toggle together — the same
   * rule renderWhitespaceOnlyLine applies in the unified view.
   */
  private toggleSplitRowSelection(keys: LineKey[]): void {
    if (keys.length === 0) return;
    const newSelected = new Set(this.selectedLines);
    const isSelected = keys.some((k) => newSelected.has(k));
    for (const key of keys) {
      if (isSelected) {
        newSelected.delete(key);
      } else {
        newSelected.add(key);
      }
    }
    this.selectedLines = newSelected;
  }

  /**
   * Check if a line is selected
   */
  private isLineSelected(hunkIndex: number, lineIndex: number): boolean {
    return this.selectedLines.has(this.getLineKey(hunkIndex, lineIndex));
  }

  /**
   * Clear all line selections
   */
  private clearLineSelection(): void {
    this.selectedLines = new Set();
  }

  /**
   * Select all lines in a hunk
   */
  private selectAllInHunk(hunkIndex: number): void {
    if (!this.diff) return;
    const hunk = this.diff.hunks[hunkIndex];
    if (!hunk) return;

    const newSelected = new Set(this.selectedLines);
    hunk.lines.forEach((line, lineIndex) => {
      if (line.origin === 'addition' || line.origin === 'deletion') {
        newSelected.add(this.getLineKey(hunkIndex, lineIndex));
      }
    });
    this.selectedLines = newSelected;
  }

  /**
   * Build a patch from selected lines only
   * This is more complex than buildHunkPatch because we need to:
   * 1. Group selected lines by hunk
   * 2. Include context lines around selected lines
   * 3. Adjust line numbers in hunk headers
   */
  /**
   * Build a patch containing only the selected lines.
   *
   * The transformations for the unselected lines differ by direction, because
   * staging applies the patch FORWARD to the index while unstaging
   * reverse-applies it (see unstage_hunk -> apply_patch_to_index(.., true)).
   * A patch reverse-applies cleanly only when its NEW side matches the index.
   *
   * Staging (unstaged diff, index -> worktree):
   *   unselected deletion -> context  (the line still exists in the index)
   *   unselected addition -> omitted  (it is not in the index yet)
   *
   * Unstaging (staged diff, HEAD -> index) is the mirror image:
   *   unselected deletion -> omitted  (the line is NOT in the index)
   *   unselected addition -> context  (the line IS in the index and stays)
   *
   * Using the staging transformation for both is why unstaging a subset of
   * lines failed on every hunk that had other changes: an unselected deletion
   * emitted as context claimed a line the index does not have, and a dropped
   * unselected addition broke contiguity against the index.
   */
  private buildSelectedLinesPatch(direction: 'stage' | 'unstage' = 'stage'): string {
    if (!this.diff || !this.file || this.selectedLines.size === 0) return '';

    const filePath = this.file.path;
    const fileStatus = this.diff.status;
    const patchLines: string[] = [];

    // Add diff header
    if (fileStatus === 'new' || fileStatus === 'untracked') {
      patchLines.push('--- /dev/null');
    } else {
      patchLines.push(`--- a/${filePath}`);
    }

    if (fileStatus === 'deleted') {
      patchLines.push('+++ /dev/null');
    } else {
      patchLines.push(`+++ b/${filePath}`);
    }

    // Group selected lines by hunk
    const selectedByHunk = new Map<number, Set<number>>();
    for (const key of this.selectedLines) {
      const [hunkIndex, lineIndex] = key.split('-').map(Number);
      if (!selectedByHunk.has(hunkIndex)) {
        selectedByHunk.set(hunkIndex, new Set());
      }
      selectedByHunk.get(hunkIndex)!.add(lineIndex);
    }

    // Process each hunk with selected lines
    for (const [hunkIndex, selectedLineIndices] of selectedByHunk) {
      const hunk = this.diff.hunks[hunkIndex];
      if (!hunk) continue;

      // Build the lines for this hunk patch
      // We need to include context lines and adjust for non-selected changes
      const hunkPatchLines: string[] = [];
      let oldLineCount = 0;
      let newLineCount = 0;
      const firstOldLine = hunk.oldStart;
      const firstNewLine = hunk.newStart;

      // Tracks whether the content line most recently written into this patch
      // was actually emitted. A "\ No newline at end of file" marker annotates
      // the line immediately before it, so it must only be emitted when that
      // line made it into the patch (an unselected addition is skipped, so its
      // marker must be skipped too) — otherwise `git apply` rejects the patch.
      let lastContentEmitted = false;

      for (let i = 0; i < hunk.lines.length; i++) {
        const line = hunk.lines[i];
        const isSelected = selectedLineIndices.has(i);

        // Skip metadata lines
        if (line.origin === 'hunk-header' || line.origin === 'file-header' || line.origin === 'binary') {
          continue;
        }

        // Handle "no newline at end of file" markers
        if (
          line.origin === 'del-eofnl' ||
          line.origin === 'add-eofnl' ||
          line.origin === 'context-eofnl'
        ) {
          if (lastContentEmitted) {
            hunkPatchLines.push('\\ No newline at end of file');
          }
          continue;
        }

        // Strip only the trailing newline; keep \r so CRLF content byte-matches
        // the index blob.
        const content = line.content.replace(/\n$/, '');

        if (line.origin === 'context') {
          // Always include context lines
          hunkPatchLines.push(' ' + content);
          oldLineCount++;
          newLineCount++;
          lastContentEmitted = true;
        } else if (line.origin === 'deletion') {
          if (isSelected) {
            // Include this deletion in the patch
            hunkPatchLines.push('-' + content);
            oldLineCount++;
            lastContentEmitted = true;
          } else if (direction === 'stage') {
            // The line still exists in the index (its deletion is not being
            // staged), so it is context on both sides.
            hunkPatchLines.push(' ' + content);
            oldLineCount++;
            newLineCount++;
            lastContentEmitted = true;
          } else {
            // Unstaging: the deletion is already in the index, so this line is
            // absent from the index. Emitting it as context would claim a line
            // the index does not have and the reverse apply would reject the
            // whole patch.
            lastContentEmitted = false;
          }
        } else if (line.origin === 'addition') {
          if (isSelected) {
            // Include this addition
            hunkPatchLines.push('+' + content);
            newLineCount++;
            lastContentEmitted = true;
          } else if (direction === 'stage') {
            // Not in the index yet, so it must not appear in the patch at all.
            lastContentEmitted = false;
          } else {
            // Unstaging: the addition IS in the index and is staying there, so
            // it is context — present on both sides of the reverse apply.
            hunkPatchLines.push(' ' + content);
            oldLineCount++;
            newLineCount++;
            lastContentEmitted = true;
          }
        }
      }

      // Only add hunk if it has actual changes
      if (hunkPatchLines.some(l => l.startsWith('+') || l.startsWith('-'))) {
        // Create hunk header with adjusted counts
        const hunkHeader = `@@ -${firstOldLine},${oldLineCount} +${firstNewLine},${newLineCount} @@`;
        patchLines.push(hunkHeader);
        patchLines.push(...hunkPatchLines);
      }
    }

    // Return empty if no actual hunks were added
    if (patchLines.length <= 2) return '';

    return patchLines.join('\n') + '\n';
  }

  /**
   * Stage selected lines
   *
   * Resolves to true only when the stage was applied. A same-context reload
   * renumbers hunks and lines, so every positional
   * `${hunkIndex}-${lineIndex}` key a caller saved is stale after that.
   */
  private async stageSelectedLines(): Promise<boolean> {
    const context = this.currentWorkingDiffContext();
    if (!context || this.diffMutationInProgress || this.selectedLines.size === 0) return false;

    const patch = this.buildSelectedLinesPatch();
    if (!patch) return false;

    this.diffMutationInProgress = true;
    try {
      const result = await gitService.stageHunk(context.repositoryPath, patch);
      if (result.success) {
        this.dispatchEvent(new CustomEvent('status-changed', {
          bubbles: true,
          composed: true,
        }));
        if (this.isStillOnAppliedFile(context)) {
          this.selectedLines = new Set();
          await this.loadWorkingDiff();
          this.clearIfFullyApplied(context);
        }
        return true;
      }
      console.error('Failed to stage selected lines:', result.error);
      showToast(`Failed to stage lines: ${result.error?.message ?? 'Unknown error'}`, 'error');
    } catch (err) {
      console.error('Failed to stage selected lines:', err);
      showToast(`Failed to stage lines: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    } finally {
      this.diffMutationInProgress = false;
    }
    return false;
  }

  /**
   * Unstage selected lines
   *
   * Resolves to true only when the unstage was applied. A same-context reload
   * renumbers hunks and lines, so every positional
   * `${hunkIndex}-${lineIndex}` key a caller saved is stale after that.
   */
  private async unstageSelectedLines(): Promise<boolean> {
    const context = this.currentWorkingDiffContext();
    if (!context || this.diffMutationInProgress || this.selectedLines.size === 0) return false;

    const patch = this.buildSelectedLinesPatch('unstage');
    if (!patch) return false;

    this.diffMutationInProgress = true;
    try {
      const result = await gitService.unstageHunk(context.repositoryPath, patch);
      if (result.success) {
        this.dispatchEvent(new CustomEvent('status-changed', {
          bubbles: true,
          composed: true,
        }));
        if (this.isStillOnAppliedFile(context)) {
          this.selectedLines = new Set();
          await this.loadWorkingDiff();
          this.clearIfFullyApplied(context);
        }
        return true;
      }
      console.error('Failed to unstage selected lines:', result.error);
      showToast(`Failed to unstage lines: ${result.error?.message ?? 'Unknown error'}`, 'error');
    } catch (err) {
      console.error('Failed to unstage selected lines:', err);
      showToast(`Failed to unstage lines: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    } finally {
      this.diffMutationInProgress = false;
    }
    return false;
  }

  /**
   * Stage a specific hunk
   */
  private async handleStageHunk(hunk: DiffHunk, e: Event): Promise<void> {
    e.stopPropagation();
    const context = this.currentWorkingDiffContext();
    if (!context || this.diffMutationInProgress) return;

    const patch = this.buildHunkPatch(hunk);
    if (!patch) return;

    this.diffMutationInProgress = true;
    try {
      const result = await gitService.stageHunk(context.repositoryPath, patch);
      if (result.success) {
        // Dispatch event to refresh status
        this.dispatchEvent(new CustomEvent('status-changed', {
          bubbles: true,
          composed: true,
        }));
        // Reload diff - if file is fully staged, clear the view
        if (this.isStillOnAppliedFile(context)) {
          this.selectedLines = new Set();
          await this.loadWorkingDiff();
          this.clearIfFullyApplied(context);
        }
      } else {
        console.error('Failed to stage hunk:', result.error);
        showToast(`Failed to stage hunk: ${result.error?.message ?? 'Unknown error'}`, 'error');
      }
    } catch (err) {
      console.error('Failed to stage hunk:', err);
      showToast(`Failed to stage hunk: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    } finally {
      this.diffMutationInProgress = false;
    }
  }

  /**
   * Unstage a specific hunk
   */
  private async handleUnstageHunk(hunk: DiffHunk, e: Event): Promise<void> {
    e.stopPropagation();
    const context = this.currentWorkingDiffContext();
    if (!context || this.diffMutationInProgress) return;

    const patch = this.buildHunkPatch(hunk);
    if (!patch) return;

    this.diffMutationInProgress = true;
    try {
      const result = await gitService.unstageHunk(context.repositoryPath, patch);
      if (result.success) {
        // Dispatch event to refresh status
        this.dispatchEvent(new CustomEvent('status-changed', {
          bubbles: true,
          composed: true,
        }));
        // Reload diff - if nothing is left staged for this file, clear the view
        if (this.isStillOnAppliedFile(context)) {
          this.selectedLines = new Set();
          await this.loadWorkingDiff();
          this.clearIfFullyApplied(context);
        }
      } else {
        console.error('Failed to unstage hunk:', result.error);
        showToast(`Failed to unstage hunk: ${result.error?.message ?? 'Unknown error'}`, 'error');
      }
    } catch (err) {
      console.error('Failed to unstage hunk:', err);
      showToast(`Failed to unstage hunk: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    } finally {
      this.diffMutationInProgress = false;
    }
  }

  private getLineClass(origin: string): string {
    switch (origin) {
      case 'addition':
        return 'code-addition';
      case 'deletion':
        return 'code-deletion';
      default:
        return 'context';
    }
  }

  private getOriginChar(origin: string): string {
    switch (origin) {
      case 'addition':
        return '+';
      case 'deletion':
        return '-';
      default:
        return ' ';
    }
  }

  private get totalHunks(): number {
    return this.diff?.hunks.length ?? 0;
  }

  private goToNextHunk(): void {
    if (this.totalHunks === 0) return;
    this.currentHunkIndex = (this.currentHunkIndex + 1) % this.totalHunks;
    this.scrollToHunk(this.currentHunkIndex);
  }

  private goToPrevHunk(): void {
    if (this.totalHunks === 0) return;
    this.currentHunkIndex = (this.currentHunkIndex - 1 + this.totalHunks) % this.totalHunks;
    this.scrollToHunk(this.currentHunkIndex);
  }

  private scrollToHunk(index: number): void {
    const container = this.shadowRoot?.querySelector('.diff-content') ??
      this.shadowRoot?.querySelector('.split-container');
    if (!container) return;

    const hunks = container.querySelectorAll('.hunk');
    const separators = container.querySelectorAll('.hunk-separator');
    const target = hunks[index] ?? separators[index];
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // Context menu handlers
  private handleLineContextMenu(e: MouseEvent, line: DiffLine, hunk: DiffHunk): void {
    e.preventDefault();
    e.stopPropagation();
    this.contextMenu = { visible: true, x: e.clientX, y: e.clientY, line, hunk };
  }

  private async handleContextCopyLine(): Promise<void> {
    const line = this.contextMenu.line;
    if (!line) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    try {
      await navigator.clipboard.writeText(line.content);
    } catch (err) {
      console.error('Failed to copy line:', err);
    }
  }

  private async handleContextCopySelection(): Promise<void> {
    this.contextMenu = { ...this.contextMenu, visible: false };
    try {
      const selection = window.getSelection()?.toString() ?? '';
      if (selection) {
        await navigator.clipboard.writeText(selection);
      }
    } catch (err) {
      console.error('Failed to copy selection:', err);
    }
  }

  private async handleContextStageHunk(): Promise<void> {
    const hunk = this.contextMenu.hunk;
    if (!hunk) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    // Use the existing handleStageHunk method
    await this.handleStageHunk(hunk, new Event('click'));
  }

  private async handleContextUnstageHunk(): Promise<void> {
    const hunk = this.contextMenu.hunk;
    if (!hunk) return;
    this.contextMenu = { ...this.contextMenu, visible: false };
    await this.handleUnstageHunk(hunk, new Event('click'));
  }

  /**
   * Build a map of paired deletion/addition lines within each hunk for word-level diffing.
   * Pairs consecutive deletion blocks with following addition blocks.
   * Returns a Map from DiffLine to its paired DiffLine.
   */
  private buildLinePairs(hunk: DiffHunk): Map<DiffLine, DiffLine> {
    const pairs = new Map<DiffLine, DiffLine>();
    const lines = hunk.lines;
    let i = 0;

    while (i < lines.length) {
      // Collect consecutive deletions
      const deletions: DiffLine[] = [];
      while (i < lines.length && lines[i].origin === 'deletion') {
        deletions.push(lines[i]);
        i++;
      }
      // Collect consecutive additions
      const additions: DiffLine[] = [];
      while (i < lines.length && lines[i].origin === 'addition') {
        additions.push(lines[i]);
        i++;
      }
      // Pair them up (min of both lengths)
      const pairCount = Math.min(deletions.length, additions.length);
      for (let p = 0; p < pairCount; p++) {
        pairs.set(deletions[p], additions[p]);
        pairs.set(additions[p], deletions[p]);
      }
      // If we didn't consume anything (context line), skip it
      if (deletions.length === 0 && additions.length === 0) {
        i++;
      }
    }

    return pairs;
  }

  /**
   * Cache of line pairs per hunk to avoid recomputation on every render.
   */
  private hunkLinePairsCache = new WeakMap<DiffHunk, Map<DiffLine, DiffLine>>();

  private getLinePairs(hunk: DiffHunk): Map<DiffLine, DiffLine> {
    let pairs = this.hunkLinePairsCache.get(hunk);
    if (!pairs) {
      pairs = this.buildLinePairs(hunk);
      this.hunkLinePairsCache.set(hunk, pairs);
    }
    return pairs;
  }

  /**
   * Word diff result cache to avoid recomputation for the same line pair.
   */
  private wordDiffCache = new WeakMap<DiffLine, WordDiffResult>();

  private getWordDiff(delLine: DiffLine, addLine: DiffLine): WordDiffResult {
    let result = this.wordDiffCache.get(delLine);
    if (!result) {
      result = computeWordDiff(delLine.content, addLine.content);
      this.wordDiffCache.set(delLine, result);
    }
    return result;
  }

  /**
   * Render line content with word-level diff highlighting.
   * Segments marked as changed get a highlighted background.
   */
  private renderWordDiffContent(segments: DiffSegment[], cssClass: string): TemplateResult {
    // We cannot easily combine syntax highlighting with word diff spans,
    // so we use plain text with word-diff highlighting when a pair is available.
    return html`${segments.map(
      (seg) =>
        seg.changed
          ? html`<span class="${cssClass}">${seg.text}</span>`
          : html`<span>${seg.text}</span>`
    )}`;
  }

  /**
   * Stage a single line from context menu
   */
  private async handleContextStageLine(): Promise<void> {
    const line = this.contextMenu.line;
    const hunk = this.contextMenu.hunk;
    const context = this.currentWorkingDiffContext();
    if (!line || !hunk || !this.diff || !context) return;
    const requestId = this.diffRequestId;

    // Find hunk and line indices
    const hunkIndex = this.diff.hunks.indexOf(hunk);
    const lineIndex = hunk.lines.indexOf(line);
    if (hunkIndex === -1 || lineIndex === -1) return;

    this.contextMenu = { ...this.contextMenu, visible: false };

    // Temporarily select just this line and stage it
    const prevSelected = this.selectedLines;
    this.selectedLines = new Set([this.getLineKey(hunkIndex, lineIndex)]);
    // A successful stage reloads the diff, which renumbers hunks and lines, so
    // the saved `${hunkIndex}-${lineIndex}` keys would point at different code.
    // Put the previous selection back only when nothing was applied.
    if (
      !(await this.stageSelectedLines()) &&
      requestId === this.diffRequestId &&
      this.isSameWorkingDiffContext(context)
    ) {
      this.selectedLines = prevSelected;
    }
  }

  /**
   * Unstage a single line from context menu
   */
  private async handleContextUnstageLine(): Promise<void> {
    const line = this.contextMenu.line;
    const hunk = this.contextMenu.hunk;
    const context = this.currentWorkingDiffContext();
    if (!line || !hunk || !this.diff || !context) return;
    const requestId = this.diffRequestId;

    // Find hunk and line indices
    const hunkIndex = this.diff.hunks.indexOf(hunk);
    const lineIndex = hunk.lines.indexOf(line);
    if (hunkIndex === -1 || lineIndex === -1) return;

    this.contextMenu = { ...this.contextMenu, visible: false };

    // Temporarily select just this line and unstage it
    const prevSelected = this.selectedLines;
    this.selectedLines = new Set([this.getLineKey(hunkIndex, lineIndex)]);
    // A successful unstage reloads the diff, which renumbers hunks and lines,
    // so the saved `${hunkIndex}-${lineIndex}` keys would point at different
    // code. Put the previous selection back only when nothing was applied.
    if (
      !(await this.unstageSelectedLines()) &&
      requestId === this.diffRequestId &&
      this.isSameWorkingDiffContext(context)
    ) {
      this.selectedLines = prevSelected;
    }
  }

  private buildFlatLines(): void {
    if (!this.diff) {
      this.flatLines = [];
      return;
    }
    const items: FlatDiffItem[] = [];
    this.diff.hunks.forEach((hunk, hunkIndex) => {
      items.push({ type: 'hunk-header', hunkIndex, header: hunk.header });
      hunk.lines.forEach((line, lineIndex) => {
        items.push({ type: 'line', hunkIndex, lineIndex, line });
      });
    });
    this.flatLines = items;
    this.virtualScrollManager.setTotalLines(items.length);
  }

  private handleDiffScroll(e: Event): void {
    const target = e.target as HTMLElement;
    this.diffScrollTop = target.scrollTop;
    this.requestUpdate();
  }

  private async handleLoadFullDiff(): Promise<void> {
    // Re-fetch the diff without the line cap, in place. Once loaded the diff is
    // no longer truncated, so the "Load full diff" banner disappears.
    this.showFullDiff = true;
    if (this.commitFile) {
      await this.loadCommitDiff();
    } else if (this.file) {
      await this.loadWorkingDiff();
    }
  }

  private renderVirtualizedUnifiedView(): TemplateResult {
    const contentHeight = this.virtualScrollManager.getContentHeight();
    const range: VisibleRange = this.virtualScrollManager.getVisibleRange({
      scrollTop: this.diffScrollTop,
      clientHeight: 600,
    });

    const visibleItems = this.flatLines.slice(range.startLine, range.endLine + 1);
    const offsetY = range.startLine * DIFF_LINE_HEIGHT;

    return html`
      <div class="diff-virtualized-container ${this.lineSelectionMode ? 'line-selection-mode' : ''}"
           @scroll=${this.handleDiffScroll}>
        ${this.flatLines.length > 10000 ? html`
          <div class="large-diff-info">
            Large diff (${this.flatLines.length.toLocaleString()} lines) -- virtualized for performance
          </div>
        ` : nothing}
        <div style="height: ${contentHeight}px; position: relative;">
          <div style="position: absolute; top: ${offsetY}px; left: 0; right: 0;">
            ${visibleItems.map((item) => this.renderVirtualizedItem(item))}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render one row of the virtualized diff. Rows carry the same staging
   * affordances as the hunk view (per-hunk Stage/Unstage buttons, line
   * checkboxes, context menu) so that "Load full diff" on a huge file does not
   * drop the user into a read-only view. Every row must stay exactly
   * DIFF_LINE_HEIGHT tall or the virtual scroll offsets drift.
   */
  private renderVirtualizedItem(item: FlatDiffItem): TemplateResult {
    const hunk = this.diff?.hunks[item.hunkIndex];

    if (item.type === 'hunk-header') {
      return html`
        <div class="line virtual-hunk-header" style="height: ${DIFF_LINE_HEIGHT}px; line-height: ${DIFF_LINE_HEIGHT}px;">
          <div class="line-numbers">
            <span class="line-no old"></span>
            <span class="line-no new"></span>
          </div>
          <span class="line-origin"></span>
          <span class="line-content">${item.header}</span>
          ${hunk
            ? html`<div class="hunk-actions">${this.renderHunkActions(hunk, item.hunkIndex)}</div>`
            : nothing}
        </div>
      `;
    }

    const line = item.line!;
    const lineIndex = item.lineIndex!;
    const lineClass = this.getLineClass(line.origin);
    const originChar = this.getOriginChar(line.origin);
    const isSelectable = line.origin === 'addition' || line.origin === 'deletion';
    const isSelected = this.isLineSelected(item.hunkIndex, lineIndex);

    return html`
      <div
        class="line ${lineClass} ${isSelected ? 'selected' : ''}"
        style="min-height: ${DIFF_LINE_HEIGHT}px; line-height: ${DIFF_LINE_HEIGHT}px;"
        @contextmenu=${(e: MouseEvent) => {
          if (hunk) this.handleLineContextMenu(e, line, hunk);
        }}
        @click=${(e: MouseEvent) => {
          if (this.lineSelectionMode && isSelectable) {
            e.preventDefault();
            this.toggleLineSelection(item.hunkIndex, lineIndex, line);
          }
        }}
      >
        ${this.lineSelectionMode && isSelectable ? html`
          <input
            type="checkbox"
            class="line-checkbox"
            .checked=${isSelected}
            @change=${(e: Event) => {
              e.stopPropagation();
              this.toggleLineSelection(item.hunkIndex, lineIndex, line);
            }}
            @click=${(e: Event) => e.stopPropagation()}
          />
        ` : nothing}
        <div class="line-numbers">
          <span class="line-no old">${line.oldLineNo ?? ''}</span>
          <span class="line-no new">${line.newLineNo ?? ''}</span>
        </div>
        <span class="line-origin">${originChar}</span>
        <span class="line-content">${this.renderHighlightedContent(line.content)}</span>
      </div>
    `;
  }

  private renderLine(line: DiffLine, hunk: DiffHunk, hunkIndex: number, lineIndex: number) {
    const lineClass = this.getLineClass(line.origin);
    const originChar = this.getOriginChar(line.origin);
    const isSelectable = line.origin === 'addition' || line.origin === 'deletion';
    const isSelected = this.isLineSelected(hunkIndex, lineIndex);

    const handleClick = (e: MouseEvent) => {
      if (this.lineSelectionMode && isSelectable) {
        e.preventDefault();
        this.toggleLineSelection(hunkIndex, lineIndex, line);
      }
    };

    const handleCheckboxChange = (e: Event) => {
      e.stopPropagation();
      this.toggleLineSelection(hunkIndex, lineIndex, line);
    };

    // Check if this line has a word-diff pair
    const pairs = this.getLinePairs(hunk);
    const pairedLine = pairs.get(line);
    let contentHtml: TemplateResult;

    if (pairedLine && (line.origin === 'deletion' || line.origin === 'addition')) {
      const delLine = line.origin === 'deletion' ? line : pairedLine;
      const addLine = line.origin === 'addition' ? line : pairedLine;
      const wordDiff = this.getWordDiff(delLine, addLine);

      if (line.origin === 'deletion') {
        contentHtml = this.renderWordDiffContent(wordDiff.oldSegments, 'word-changed-del');
      } else {
        contentHtml = this.renderWordDiffContent(wordDiff.newSegments, 'word-changed-add');
      }
    } else {
      contentHtml = this.renderHighlightedContent(line.content);
    }

    return html`
      <div
        class="line ${lineClass} ${isSelected ? 'selected' : ''}"
        @contextmenu=${(e: MouseEvent) => this.handleLineContextMenu(e, line, hunk)}
        @click=${handleClick}
      >
        ${this.lineSelectionMode && isSelectable ? html`
          <input
            type="checkbox"
            class="line-checkbox"
            .checked=${isSelected}
            @change=${handleCheckboxChange}
            @click=${(e: Event) => e.stopPropagation()}
          />
        ` : nothing}
        <div class="line-numbers">
          <span class="line-no old">${line.oldLineNo ?? ''}</span>
          <span class="line-no new">${line.newLineNo ?? ''}</span>
        </div>
        <span class="line-origin">${originChar}</span>
        <span class="line-content">${contentHtml}</span>
      </div>
    `;
  }

  private renderWhitespaceOnlyLine(
    delLine: DiffLine,
    addLine: DiffLine,
    hunk: DiffHunk,
    hunkIndex: number,
    delIndex: number,
    addIndex: number,
  ) {
    const segments = computeInlineWhitespaceDiff(delLine.content, addLine.content);
    const isDelSelected = this.isLineSelected(hunkIndex, delIndex);
    const isAddSelected = this.isLineSelected(hunkIndex, addIndex);
    const isSelected = isDelSelected || isAddSelected;

    const handleClick = (e: MouseEvent) => {
      if (this.lineSelectionMode) {
        e.preventDefault();
        // Toggle both underlying lines together
        const newSelected = new Set(this.selectedLines);
        const delKey = this.getLineKey(hunkIndex, delIndex);
        const addKey = this.getLineKey(hunkIndex, addIndex);
        if (isSelected) {
          newSelected.delete(delKey);
          newSelected.delete(addKey);
        } else {
          newSelected.add(delKey);
          newSelected.add(addKey);
        }
        this.selectedLines = newSelected;
      }
    };

    const handleCheckboxChange = (e: Event) => {
      e.stopPropagation();
      const newSelected = new Set(this.selectedLines);
      const delKey = this.getLineKey(hunkIndex, delIndex);
      const addKey = this.getLineKey(hunkIndex, addIndex);
      if (isSelected) {
        newSelected.delete(delKey);
        newSelected.delete(addKey);
      } else {
        newSelected.add(delKey);
        newSelected.add(addKey);
      }
      this.selectedLines = newSelected;
    };

    return html`
      <div
        class="line code-ws-change ${isSelected ? 'selected' : ''}"
        @contextmenu=${(e: MouseEvent) => this.handleLineContextMenu(e, addLine, hunk)}
        @click=${handleClick}
      >
        ${this.lineSelectionMode ? html`
          <input
            type="checkbox"
            class="line-checkbox"
            style="display: inline-block"
            .checked=${isSelected}
            @change=${handleCheckboxChange}
            @click=${(e: Event) => e.stopPropagation()}
          />
        ` : nothing}
        <div class="line-numbers">
          <span class="line-no old">${delLine.oldLineNo ?? ''}</span>
          <span class="line-no new">${addLine.newLineNo ?? ''}</span>
        </div>
        <span class="line-origin">~</span>
        <span class="line-content">${this.renderInlineWhitespaceContent(segments)}</span>
      </div>
    `;
  }

  /**
   * Stage/unstage (and, in line-selection mode, Select All) actions for one hunk.
   * Shared by the unified, split and virtualized hunk separators so that every
   * view offers the same staging affordances instead of becoming a read-only
   * dead end.
   */
  private renderHunkActions(hunk: DiffHunk, hunkIndex: number) {
    // Only working-directory diffs can be staged (not commit diffs).
    if (this.file === null || this.commitFile) return nothing;
    const isStaged = this.file.isStaged;

    return html`
      ${this.lineSelectionMode ? html`
        <button
          class="stage-btn"
          @click=${() => this.selectAllInHunk(hunkIndex)}
          title="Select all lines in this hunk"
        >
          Select All
        </button>
      ` : nothing}
      ${isStaged ? html`
        <button
          class="stage-btn unstage"
          @click=${(e: Event) => this.handleUnstageHunk(hunk, e)}
          ?disabled=${this.diffMutationInProgress}
          title="Unstage this hunk"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          Unstage
        </button>
      ` : html`
        <button
          class="stage-btn stage"
          @click=${(e: Event) => this.handleStageHunk(hunk, e)}
          ?disabled=${this.diffMutationInProgress}
          title="Stage this hunk"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          Stage
        </button>
      `}
    `;
  }

  private renderHunk(hunk: DiffHunk, hunkIndex: number) {
    // Only show stage/unstage button for working directory diffs (not commit diffs)
    const showStageButton = this.file !== null && !this.commitFile;
    const isActive = this.currentHunkIndex === hunkIndex;

    // Find whitespace-only pairs for this hunk
    const wsPairs = findWhitespaceOnlyPairs(hunk.lines);
    const skipIndices = new Set(wsPairs.values());

    return html`
      <div class="hunk ${isActive ? 'active' : ''}">
        ${hunkIndex > 0 ? html`
          <div class="hunk-separator">
            <div class="hunk-separator-line"></div>
            ${showStageButton ? html`
              <div class="hunk-separator-actions">
                ${this.renderHunkActions(hunk, hunkIndex)}
              </div>
            ` : nothing}
          </div>
        ` : html`
          ${showStageButton ? html`
            <div class="hunk-separator" style="height: auto; padding: 2px var(--spacing-sm); justify-content: flex-end;">
              ${this.renderHunkActions(hunk, hunkIndex)}
            </div>
          ` : nothing}
        `}
        ${hunk.lines.map((line, lineIndex) => {
          // Skip addition lines that are part of a whitespace-only pair
          if (skipIndices.has(lineIndex)) return nothing;
          // Render whitespace-only pairs as a merged line
          if (wsPairs.has(lineIndex)) {
            const addIndex = wsPairs.get(lineIndex)!;
            return this.renderWhitespaceOnlyLine(
              line, hunk.lines[addIndex], hunk, hunkIndex, lineIndex, addIndex,
            );
          }
          return this.renderLine(line, hunk, hunkIndex, lineIndex);
        })}
      </div>
    `;
  }

  private convertToSplitLines(hunks: DiffHunk[]): SplitLine[] {
    const splitLines: SplitLine[] = [];

    hunks.forEach((hunk, hunkIndex) => {
      // Add hunk separator as a special line
      splitLines.push({
        left: { content: hunk.header, origin: 'hunk-header', oldLineNo: null, newLineNo: null },
        right: { content: hunk.header, origin: 'hunk-header', oldLineNo: null, newLineNo: null },
        hunk,
        hunkIndex,
        leftIndex: null,
        rightIndex: null,
      });

      const deletions: Array<{ line: DiffLine; index: number }> = [];
      const additions: Array<{ line: DiffLine; index: number }> = [];

      const flushPending = () => {
        // Check for whitespace-only pairs while flushing
        while (deletions.length || additions.length) {
          const del = deletions.shift() ?? null;
          const add = additions.shift() ?? null;

          if (del && add && isWhitespaceOnlyChange(del.line.content, add.line.content)) {
            const segments = computeInlineWhitespaceDiff(del.line.content, add.line.content);
            splitLines.push({
              left: del.line,
              right: add.line,
              isWhitespaceOnly: true,
              inlineSegments: segments,
              hunk,
              hunkIndex,
              leftIndex: del.index,
              rightIndex: add.index,
            });
          } else {
            splitLines.push({
              left: del?.line ?? null,
              right: add?.line ?? null,
              hunk,
              hunkIndex,
              leftIndex: del?.index ?? null,
              rightIndex: add?.index ?? null,
            });
          }
        }
      };

      hunk.lines.forEach((line, lineIndex) => {
        if (line.origin === 'deletion') {
          deletions.push({ line, index: lineIndex });
        } else if (line.origin === 'addition') {
          additions.push({ line, index: lineIndex });
        } else {
          // Context line - flush any pending deletions/additions first
          flushPending();
          // Add context line to both sides
          splitLines.push({
            left: line,
            right: line,
            hunk,
            hunkIndex,
            leftIndex: lineIndex,
            rightIndex: lineIndex,
          });
        }
      });

      // Flush remaining deletions/additions
      flushPending();
    });

    return splitLines;
  }

  /**
   * Hunk separator row in split view. Both panes render it so the two sides
   * stay row-aligned, but the stage actions are rendered on the Modified side
   * only rather than being duplicated.
   */
  private renderSplitHunkSeparator(sl: SplitLine, side: 'left' | 'right') {
    // Only show stage/unstage button for working directory diffs (not commit diffs)
    const showStageButton = this.file !== null && !this.commitFile;

    return html`
      <div class="hunk-separator-split">
        <div class="hunk-separator-line"></div>
        ${side === 'right' && showStageButton
          ? html`<div class="hunk-actions">${this.renderHunkActions(sl.hunk, sl.hunkIndex)}</div>`
          : nothing}
      </div>
    `;
  }

  private renderSplitLineCell(sl: SplitLine, side: 'left' | 'right') {
    const line = side === 'left' ? sl.left : sl.right;
    const lineIndex = side === 'left' ? sl.leftIndex : sl.rightIndex;

    if (!line) {
      return html`
        <div class="split-line empty">
          <span class="split-line-no"></span>
          <span class="split-line-content"></span>
        </div>
      `;
    }

    if (line.origin === 'hunk-header') {
      return this.renderSplitHunkSeparator(sl, side);
    }

    const lineNo = side === 'left' ? line.oldLineNo : line.newLineNo;

    // A whitespace-only row is one change shown on both sides, so it selects
    // both of its underlying lines; every other row selects its own line.
    const isSelectable = line.origin === 'addition' || line.origin === 'deletion';
    const keys: LineKey[] =
      sl.isWhitespaceOnly && sl.leftIndex !== null && sl.rightIndex !== null
        ? [this.getLineKey(sl.hunkIndex, sl.leftIndex), this.getLineKey(sl.hunkIndex, sl.rightIndex)]
        : isSelectable && lineIndex !== null
          ? [this.getLineKey(sl.hunkIndex, lineIndex)]
          : [];
    const isSelected = keys.some((k) => this.selectedLines.has(k));

    const handleClick = (e: MouseEvent) => {
      if (this.lineSelectionMode && keys.length > 0) {
        e.preventDefault();
        this.toggleSplitRowSelection(keys);
      }
    };

    const handleCheckboxChange = (e: Event) => {
      e.stopPropagation();
      this.toggleSplitRowSelection(keys);
    };

    const checkbox = this.lineSelectionMode && keys.length > 0 ? html`
      <input
        type="checkbox"
        class="line-checkbox"
        style="display: inline-block"
        .checked=${isSelected}
        @change=${handleCheckboxChange}
        @click=${(e: Event) => e.stopPropagation()}
      />
    ` : nothing;

    if (sl.isWhitespaceOnly && sl.inlineSegments) {
      // Whitespace-only: show inline diff with yellow background
      const filteredSegments = sl.inlineSegments.filter(s =>
        side === 'left' ? s.type !== 'added' : s.type !== 'removed'
      );
      return html`
        <div
          class="split-line code-ws-change ${isSelected ? 'selected' : ''}"
          @contextmenu=${(e: MouseEvent) => this.handleLineContextMenu(e, line, sl.hunk)}
          @click=${handleClick}
        >
          ${checkbox}
          <span class="split-line-no">${lineNo ?? ''}</span>
          <span class="split-line-content">${this.renderInlineWhitespaceContent(filteredSegments)}</span>
        </div>
      `;
    }

    let lineClass = '';
    if (line.origin === 'deletion') lineClass = 'code-deletion';
    else if (line.origin === 'addition') lineClass = 'code-addition';

    return html`
      <div
        class="split-line ${lineClass} ${isSelected ? 'selected' : ''}"
        @contextmenu=${(e: MouseEvent) => this.handleLineContextMenu(e, line, sl.hunk)}
        @click=${handleClick}
      >
        ${checkbox}
        <span class="split-line-no">${lineNo ?? ''}</span>
        <span class="split-line-content">${this.renderHighlightedContent(line.content)}</span>
      </div>
    `;
  }

  private renderSplitView() {
    if (!this.diff) return nothing;

    // Two blank panes are a dead end — say why there is nothing to compare.
    // Ignoring whitespace routinely empties a diff, so this is now reachable
    // from the toolbar, not just from a pure rename.
    if (this.diff.hunks.length === 0) {
      return html`<div class="empty">${this.emptyDiffMessage}</div>`;
    }

    const splitLines = this.convertToSplitLines(this.diff.hunks);

    return html`
      <div class="split-container ${this.wordWrap ? 'word-wrap' : ''} ${this.lineSelectionMode ? 'line-selection-mode' : ''}">
        <div class="split-pane">
          <div class="split-pane-header">Original</div>
          ${splitLines.map((sl) => this.renderSplitLineCell(sl, 'left'))}
        </div>
        <div class="split-pane">
          <div class="split-pane-header">Modified</div>
          ${splitLines.map((sl) => this.renderSplitLineCell(sl, 'right'))}
        </div>
      </div>
    `;
  }

  /**
   * Bulk stage/unstage bar for the current line selection. Rendered once in
   * `render()`, above the view switch, so a selection stays actionable in the
   * unified, split and virtualized views alike.
   */
  private renderSelectionActions() {
    if (!this.lineSelectionMode || this.selectedLines.size === 0) return nothing;
    const isStaged = this.file?.isStaged ?? false;

    return html`
      <div class="selection-actions">
        <span class="selection-info">${this.selectedLines.size} line${this.selectedLines.size !== 1 ? 's' : ''} selected</span>
        <button class="selection-btn" @click=${this.clearLineSelection}>
          Clear
        </button>
        ${isStaged ? html`
          <button
            class="selection-btn primary"
            @click=${this.unstageSelectedLines}
            ?disabled=${this.diffMutationInProgress}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            Unstage Selected
          </button>
        ` : html`
          <button
            class="selection-btn primary"
            @click=${this.stageSelectedLines}
            ?disabled=${this.diffMutationInProgress}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            Stage Selected
          </button>
        `}
      </div>
    `;
  }

  private renderUnifiedView() {
    if (!this.diff) return nothing;

    // Use virtualized rendering for very large diffs
    if (this.virtualScrollManager.shouldVirtualize()) {
      return this.renderVirtualizedUnifiedView();
    }

    return html`
      <div class="diff-content ${this.wordWrap ? 'word-wrap' : ''} ${this.lineSelectionMode ? 'line-selection-mode' : ''}">
        ${this.diff.hunks.length === 0
          ? html`<div class="empty">${this.emptyDiffMessage}</div>`
          : this.diff.hunks.map((hunk, i) => this.renderHunk(hunk, i))}
      </div>
    `;
  }

  private renderContextMenu() {
    if (!this.contextMenu.visible) return nothing;

    const { x, y, line, hunk } = this.contextMenu;
    const showStageButton = this.file !== null && !this.commitFile && hunk;
    const isStaged = this.file?.isStaged ?? false;
    const isChangeableLine = line && (line.origin === 'addition' || line.origin === 'deletion');

    return html`
      <div class="context-menu" style="left: ${x}px; top: ${y}px">
        <button class="context-menu-item" @click=${this.handleContextCopySelection}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          Copy selection
        </button>
        <button class="context-menu-item" @click=${this.handleContextCopyLine}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          Copy line
        </button>
        ${showStageButton && isChangeableLine ? html`
          <div class="context-menu-divider"></div>
          ${isStaged ? html`
            <button
              class="context-menu-item"
              @click=${this.handleContextUnstageLine}
              ?disabled=${this.diffMutationInProgress}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              Unstage line
            </button>
          ` : html`
            <button
              class="context-menu-item"
              @click=${this.handleContextStageLine}
              ?disabled=${this.diffMutationInProgress}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              Stage line
            </button>
          `}
        ` : nothing}
        ${showStageButton ? html`
          <div class="context-menu-divider"></div>
          ${isStaged ? html`
            <button
              class="context-menu-item"
              @click=${this.handleContextUnstageHunk}
              ?disabled=${this.diffMutationInProgress}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              Unstage hunk
            </button>
          ` : html`
            <button
              class="context-menu-item"
              @click=${this.handleContextStageHunk}
              ?disabled=${this.diffMutationInProgress}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              Stage hunk
            </button>
          `}
        ` : nothing}
      </div>
    `;
  }

  render() {
    if (!this.file && !this.commitFile) {
      return html`<div class="empty">No file selected</div>`;
    }

    // A conflicted file's working-tree content is git's marker text — never
    // show it as a diff or free-text edit. Route to the merge editor instead.
    if (this.isConflicted) {
      return this.renderConflictedNotice();
    }

    if (this.loading) {
      return html`<div class="loading">Loading diff...</div>`;
    }

    if (this.error) {
      return html`<div class="error">${this.error}</div>`;
    }

    if (!this.diff) {
      return html`<div class="empty">No changes to display</div>`;
    }

    if (this.diff.isBinary && !this.diff.isImage) {
      return html`<div class="binary-notice">Binary file - cannot display diff</div>`;
    }

    // Render image diff component for image files
    if (this.diff.isImage) {
      const filePath = this.commitFile?.filePath ?? this.file?.path ?? '';
      const staged = this.file?.isStaged ?? false;
      const commitOid = this.commitFile?.commitOid;
      return html`
        <lv-image-diff
          .repoPath=${this.repositoryPath}
          .filePath=${filePath}
          .status=${this.diff.status}
          .staged=${staged}
          .commitOid=${commitOid}
        ></lv-image-diff>
      `;
    }

    // Render edit mode
    if (this.editMode) {
      return html`
        <div class="header">
          <div class="file-info">
            <span class="file-status ${this.diff.status}">${this.diff.status}</span>
            <span class="file-path">${this.file?.path ?? ''}</span>
          </div>
          <button
            class="edit-btn active"
            @click=${() => void this.toggleEditMode()}
            ?disabled=${this.saving}
            title="Exit edit mode"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
            Editing
          </button>
        </div>
        ${this.hasChanges
          ? html`<div class="edit-indicator">Unsaved changes (Ctrl+S to save, Esc to cancel)</div>`
          : nothing}
        <div class="editor-container">
          <div class="editor-toolbar">
            <button
              class="cancel-btn"
              @click=${() => void this.cancelEdit()}
              ?disabled=${this.saving}
            >
              Cancel
            </button>
            <button
              class="save-btn"
              @click=${this.saveEdit}
              ?disabled=${!this.hasChanges || this.saving}
            >
              ${this.saving ? 'Saving...' : 'Save'}
            </button>
          </div>
          <textarea
            class="editor-textarea"
            .value=${this.editContent}
            @input=${this.handleEditorChange}
            @keydown=${this.handleEditorKeydown}
            ?disabled=${this.saving}
            spellcheck="false"
          ></textarea>
        </div>
      `;
    }

    return html`
      <div class="header">
        <div class="file-info">
          <span class="file-status ${this.diff.status}">${this.diff.status}</span>
          <div class="file-stats">
            <span class="additions">+${this.diff.additions}</span>
            <span class="deletions">-${this.diff.deletions}</span>
          </div>
        </div>
        <div class="view-controls">
          ${this.hasDiffTool ? html`
            <button
              class="view-btn"
              @click=${this.handleOpenDiffTool}
              ?disabled=${this.launchingDiffTool}
              title="Open in external diff tool"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </button>
          ` : nothing}
          ${this.file && !this.commitFile ? html`
            <button
              class="view-btn ${this.lineSelectionMode ? 'active' : ''}"
              @click=${this.toggleLineSelectionMode}
              title="Toggle line selection mode for staging individual lines"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 11l3 3L22 4"></path>
                <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"></path>
              </svg>
            </button>
          ` : nothing}
          ${this.totalHunks > 1 ? html`
            <div class="hunk-nav">
              <button
                class="view-btn"
                @click=${this.goToPrevHunk}
                title="Previous change (Alt+Up)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="18 15 12 9 6 15"></polyline>
                </svg>
              </button>
              <span class="hunk-counter">${this.currentHunkIndex + 1}/${this.totalHunks}</span>
              <button
                class="view-btn"
                @click=${this.goToNextHunk}
                title="Next change (Alt+Down)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </button>
            </div>
          ` : nothing}
          ${this.canEdit
            ? html`
                <button
                  class="edit-btn"
                  @click=${this.toggleEditMode}
                  title="Edit file"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                  </svg>
                  Edit
                </button>
              `
            : nothing}
          <div class="diff-option">
            <select
              id="diff-ignore-whitespace"
              class="diff-whitespace-select"
              aria-label="Whitespace handling"
              title="How whitespace-only changes are treated in this diff"
              .value=${this.ignoreWhitespace}
              @change=${this.handleIgnoreWhitespaceChange}
            >
              ${DIFF_WHITESPACE_MODES.map(
                (mode) => html`
                  <option value=${mode.value} ?selected=${mode.value === this.ignoreWhitespace}>
                    ${mode.label}
                  </option>
                `
              )}
            </select>
          </div>
          <div class="diff-option">
            <label class="diff-option-label" for="diff-context-lines">Context</label>
            <input
              id="diff-context-lines"
              class="diff-context-input"
              type="number"
              inputmode="numeric"
              min=${MIN_DIFF_CONTEXT_LINES}
              max=${MAX_DIFF_CONTEXT_LINES}
              step="1"
              aria-label="Lines of context around each change"
              title="Lines of unchanged context shown around each change (${MIN_DIFF_CONTEXT_LINES}-${MAX_DIFF_CONTEXT_LINES})"
              .value=${String(this.contextLines)}
              @change=${this.handleContextLinesChange}
            />
          </div>
          <button
            class="view-btn ${this.wordWrap ? 'active' : ''}"
            @click=${this.toggleWordWrap}
            title="Toggle word wrap"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="12" x2="15" y2="12"></line>
              <path d="M15 12a3 3 0 1 1 0 6H9"></path>
              <polyline points="12 15 9 18 12 21"></polyline>
            </svg>
          </button>
          <button
            class="view-btn ${this.viewMode === 'unified' ? 'active' : ''}"
            @click=${() => this.setViewMode('unified')}
            title="Unified view"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2"></rect>
              <line x1="3" y1="9" x2="21" y2="9"></line>
              <line x1="3" y1="15" x2="21" y2="15"></line>
            </svg>
          </button>
          <button
            class="view-btn ${this.viewMode === 'split' ? 'active' : ''}"
            @click=${() => this.setViewMode('split')}
            title="Split view"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2"></rect>
              <line x1="12" y1="3" x2="12" y2="21"></line>
            </svg>
          </button>
        </div>
      </div>
      ${this.hasPartialStaging && this.file && !this.file.isStaged
        ? html`
            <div class="partial-staging-info">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              This file has staged changes that will be included in the next commit.
            </div>
          `
        : nothing}
      ${this.diff?.truncated ? html`
        <div class="large-diff-info">
          Showing first ${this.diff.hunks.reduce((sum, h) => sum + h.lines.length, 0).toLocaleString()} of ${this.diff.totalLines?.toLocaleString() ?? 'many'} lines
          <button class="btn-link" @click=${this.handleLoadFullDiff}>Load full diff</button>
        </div>
      ` : nothing}
      ${this.renderSelectionActions()}
      ${this.viewMode === 'split' ? this.renderSplitView() : this.renderUnifiedView()}
      ${this.renderContextMenu()}
    `;
  }

}

declare global {
  interface HTMLElementTagNameMap {
    'lv-diff-view': LvDiffView;
  }
}
