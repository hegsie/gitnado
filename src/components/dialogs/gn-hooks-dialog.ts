/**
 * Git Hooks Dialog
 * Manage git hooks: view, edit, create, delete, enable/disable
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import {
  getHooks,
  getHook,
  saveHook,
  deleteHook,
  toggleHook,
  getHookExecutionLogs,
  clearHookExecutionLogs,
} from '../../services/git.service.ts';
import type { GitHook, HookExecutionLog } from '../../services/git.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import { pushOverlay, removeOverlay, isTopOverlay } from '../../utils/overlay-stack.ts';

const HOOK_TEMPLATES: Record<string, string> = {
  'pre-commit': `#!/bin/sh
#
# pre-commit hook: Run linting and formatting checks before committing.
#

# Run linter
npm run lint --silent 2>/dev/null
LINT_EXIT=$?

if [ $LINT_EXIT -ne 0 ]; then
  echo "Lint check failed. Please fix errors before committing."
  exit 1
fi

# Run formatter check
npm run format:check --silent 2>/dev/null
FORMAT_EXIT=$?

if [ $FORMAT_EXIT -ne 0 ]; then
  echo "Formatting check failed. Run 'npm run format' to fix."
  exit 1
fi

exit 0
`,
  'commit-msg': `#!/bin/sh
#
# commit-msg hook: Enforce conventional commit message format.
# Format: type(scope): description
#

COMMIT_MSG_FILE="$1"
COMMIT_MSG=$(cat "$COMMIT_MSG_FILE")

# Allow merge commits
if echo "$COMMIT_MSG" | grep -qE "^Merge "; then
  exit 0
fi

# Conventional commit pattern
PATTERN="^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\\(.+\\))?: .{1,}"

if ! echo "$COMMIT_MSG" | grep -qE "$PATTERN"; then
  echo "Invalid commit message format."
  echo "Expected: type(scope): description"
  echo "Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert"
  exit 1
fi

exit 0
`,
  'pre-push': `#!/bin/sh
#
# pre-push hook: Run tests before pushing to remote.
#

echo "Running tests before push..."

npm test --silent 2>/dev/null
TEST_EXIT=$?

if [ $TEST_EXIT -ne 0 ]; then
  echo "Tests failed. Push aborted."
  exit 1
fi

echo "All tests passed."
exit 0
`,
};

@customElement('gn-hooks-dialog')
export class GnHooksDialog extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: var(--z-modal, 200);
      }

      :host([open]) {
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(2px);
      }

      .dialog {
        position: relative;
        display: flex;
        flex-direction: column;
        width: 800px;
        max-width: 90vw;
        max-height: 85vh;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        overflow: hidden;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-md) var(--spacing-lg);
        border-bottom: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .header-icon {
        width: 20px;
        height: 20px;
        color: var(--color-primary);
      }

      .title {
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
      }

      .close-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .close-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .close-btn svg {
        width: 16px;
        height: 16px;
      }

      .body {
        display: flex;
        flex: 1;
        overflow: hidden;
        min-height: 0;
      }

      /* Hook list sidebar */
      .hook-list-panel {
        width: 260px;
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        border-right: 1px solid var(--color-border);
        overflow: hidden;
      }

      .hook-list-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm) var(--spacing-md);
        border-bottom: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
      }

      .hook-list-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .hook-count {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        background: var(--color-bg-primary);
        padding: 1px 6px;
        border-radius: var(--radius-sm);
      }

      .hook-list {
        flex: 1;
        overflow-y: auto;
        padding: var(--spacing-xs);
      }

      .hook-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: background var(--transition-fast);
        user-select: none;
      }

      .hook-item:hover {
        background: var(--color-bg-hover);
      }

      .hook-item.active {
        background: var(--color-bg-selected);
      }

      .hook-item-info {
        flex: 1;
        min-width: 0;
      }

      .hook-item-name {
        font-family: var(--font-mono);
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .hook-item-desc {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin-top: 1px;
      }

      .hook-status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .hook-status-dot.exists-enabled {
        background: var(--color-success, #27ae60);
      }

      .hook-status-dot.exists-disabled {
        background: var(--color-warning, #f39c12);
      }

      .hook-status-dot.not-exists {
        background: var(--color-text-muted);
        opacity: 0.4;
      }

      /* Editor panel */
      .editor-panel {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
        overflow: hidden;
      }

      .editor-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm) var(--spacing-md);
        border-bottom: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
        gap: var(--spacing-sm);
      }

      .editor-header-left {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        min-width: 0;
      }

      .editor-hook-name {
        font-family: var(--font-mono);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .editor-badge {
        font-size: var(--font-size-xs);
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        flex-shrink: 0;
        font-weight: var(--font-weight-medium);
      }

      .editor-badge.enabled {
        background: var(--color-success-bg, rgba(39, 174, 96, 0.15));
        color: var(--color-success, #27ae60);
      }

      .editor-badge.disabled {
        background: var(--color-warning-bg);
        color: var(--color-warning);
      }

      .editor-badge.new-hook {
        background: var(--color-primary-bg, rgba(52, 152, 219, 0.15));
        color: var(--color-primary);
      }

      .editor-header-right {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        flex-shrink: 0;
      }

      .editor-content {
        flex: 1;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      .editor-textarea {
        flex: 1;
        width: 100%;
        padding: var(--spacing-md);
        background: var(--color-bg-primary);
        border: none;
        color: var(--color-text-primary);
        font-family: var(--font-mono);
        font-size: var(--font-size-sm);
        line-height: 1.6;
        resize: none;
        outline: none;
        tab-size: 4;
      }

      .editor-textarea::placeholder {
        color: var(--color-text-muted);
      }

      .editor-empty {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xl);
        color: var(--color-text-muted);
        text-align: center;
      }

      .editor-empty svg {
        width: 48px;
        height: 48px;
        margin-bottom: var(--spacing-md);
        opacity: 0.5;
      }

      .editor-empty-text {
        font-size: var(--font-size-sm);
        margin-bottom: var(--spacing-xs);
      }

      .editor-empty-hint {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      /* Toggle switch */
      .toggle {
        position: relative;
        display: inline-flex;
        align-items: center;
        cursor: pointer;
        user-select: none;
        gap: var(--spacing-xs);
      }

      .toggle-input {
        position: absolute;
        opacity: 0;
        width: 0;
        height: 0;
      }

      .toggle-track {
        position: relative;
        width: 32px;
        height: 18px;
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: 9px;
        transition: all var(--transition-fast);
      }

      .toggle-input:checked + .toggle-track {
        background: var(--color-primary);
        border-color: var(--color-primary);
      }

      .toggle-track::after {
        content: '';
        position: absolute;
        top: 2px;
        left: 2px;
        width: 12px;
        height: 12px;
        background: white;
        border-radius: 50%;
        transition: transform var(--transition-fast);
      }

      .toggle-input:checked + .toggle-track::after {
        transform: translateX(14px);
      }

      .toggle-label {
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      /* Action buttons in editor header */
      .icon-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .icon-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .icon-btn:hover.danger {
        background: var(--color-error-bg, rgba(231, 76, 60, 0.15));
        color: var(--color-error);
      }

      .icon-btn svg {
        width: 14px;
        height: 14px;
      }

      .icon-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .icon-btn:disabled:hover {
        background: transparent;
        color: var(--color-text-secondary);
      }

      /* Footer */
      .footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-md) var(--spacing-lg);
        border-top: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
      }

      .footer-left {
        font-size: var(--font-size-sm);
        color: var(--color-text-muted);
      }

      .footer-right {
        display: flex;
        gap: var(--spacing-sm);
      }

      .btn {
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-md);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .btn-secondary {
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        color: var(--color-text-primary);
      }

      .btn-secondary:hover {
        background: var(--color-bg-hover);
      }

      .btn-primary {
        background: var(--color-primary);
        border: 1px solid var(--color-primary);
        color: white;
      }

      .btn-primary:hover {
        background: var(--color-primary-hover, #2980b9);
      }

      .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-danger {
        background: var(--color-error);
        border: 1px solid var(--color-error);
        color: white;
      }

      .btn-danger:hover {
        background: var(--color-error-hover, #c0392b);
      }

      .btn-danger:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* Loading / empty states */
      .loading, .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xl);
        color: var(--color-text-muted);
        text-align: center;
      }

      .empty svg {
        width: 48px;
        height: 48px;
        margin-bottom: var(--spacing-md);
        opacity: 0.5;
      }

      /* Confirm delete overlay */
      .confirm-overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10;
        backdrop-filter: blur(2px);
      }

      .confirm-dialog {
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        padding: var(--spacing-lg);
        max-width: 400px;
        box-shadow: var(--shadow-lg);
      }

      .confirm-title {
        font-size: var(--font-size-md);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
        margin-bottom: var(--spacing-sm);
      }

      .confirm-message {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-lg);
        line-height: 1.5;
      }

      .confirm-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--spacing-sm);
      }

      /* Unsaved indicator */
      .unsaved-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--color-warning);
        flex-shrink: 0;
      }

      .template-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-xs) var(--spacing-md);
        background: var(--color-bg-tertiary);
        border-bottom: 1px solid var(--color-border);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .template-btn {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-primary);
        border-radius: var(--radius-md);
        background: transparent;
        color: var(--color-primary);
        font-size: var(--font-size-xs);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .template-btn:hover {
        background: var(--color-primary);
        color: white;
      }

      .template-btn svg {
        width: 12px;
        height: 12px;
      }

      /* Execution logs section */
      .execution-logs-section {
        border-top: 1px solid var(--color-border);
        background: var(--color-bg-secondary);
        display: flex;
        flex-direction: column;
        max-height: 220px;
        flex-shrink: 0;
      }

      .execution-logs-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-xs) var(--spacing-md);
        border-bottom: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
      }

      .execution-logs-title {
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .clear-logs-btn {
        padding: 2px var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-secondary);
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .clear-logs-btn:hover:not(:disabled) {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .clear-logs-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .execution-logs-list {
        overflow-y: auto;
        padding: var(--spacing-xs) var(--spacing-md);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .execution-logs-empty {
        padding: var(--spacing-md);
        text-align: center;
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .execution-log-item {
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        overflow: hidden;
      }

      .execution-log-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-sm);
        padding: var(--spacing-xs) var(--spacing-sm);
        cursor: pointer;
        user-select: none;
      }

      .execution-log-row:hover {
        background: var(--color-bg-hover);
      }

      .execution-log-left {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        min-width: 0;
      }

      .execution-log-hook-name {
        font-family: var(--font-mono);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
      }

      .execution-log-badge {
        font-size: var(--font-size-xs);
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        font-weight: var(--font-weight-medium);
      }

      .execution-log-badge.pass {
        background: var(--color-success-bg, rgba(39, 174, 96, 0.15));
        color: var(--color-success, #27ae60);
      }

      .execution-log-badge.fail {
        background: var(--color-error-bg, rgba(231, 76, 60, 0.15));
        color: var(--color-error, #e74c3c);
      }

      .execution-log-meta {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        flex-shrink: 0;
      }

      .execution-log-duration {
        font-family: var(--font-mono);
      }

      .execution-log-output {
        margin: 0;
        padding: var(--spacing-xs) var(--spacing-sm);
        border-top: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
        color: var(--color-text-primary);
        font-family: var(--font-mono);
        font-size: var(--font-size-xs);
        line-height: 1.4;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 120px;
        overflow-y: auto;
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: String }) repoPath = '';

  @state() private hooks: GitHook[] = [];
  @state() private executionLogs: HookExecutionLog[] = [];
  @state() private collapsedLogIds = new Set<string>();
  @state() private clearingLogs = false;
  @state() private selectedHook: GitHook | null = null;
  @state() private editContent = '';
  @state() private loading = false;
  @state() private saving = false;
  @state() private hasUnsavedChanges = false;
  @state() private confirmingDelete: string | null = null;

  /**
   * Repo captured when the dialog opened. `repoPath` is live-bound to the
   * ACTIVE repository and rebinds the instant the user Ctrl+Tabs — a
   * document-level shortcut this dialog's overlay does not block — while the
   * hook list on screen still belongs to the repo active at open. Saving or
   * deleting through the live prop wrote to, and `std::fs::remove_file`d,
   * hooks in the other repository. `.git/hooks` is untracked: like the clean
   * dialog's untracked files, there is no trash and no recovery path.
   */
  private pinnedRepoPath = '';

  /** The repo this dialog is pinned to while open, or null when closed. */
  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.open ? this.pinnedRepoPath : null;
  }

  /**
   * True while a hook script write is in flight. The host's tab-close sweep must
   * not report "hooks closed" over a write still landing on disk.
   */
  public get operationInFlight(): boolean {
    return this.saving || this.clearingLogs;
  }

  async updated(changedProps: Map<string, unknown>): Promise<void> {
    // Announce/withdraw overlay ownership of Escape.
    if (changedProps.has('open')) {
      if (this.open) { pushOverlay(this); } else { removeOverlay(this); }
    }
    if (changedProps.has('open') && this.open) {
      this.pinnedRepoPath = this.repoPath;
      await this.loadHooks();
    }
  }

  private async loadHooks(): Promise<void> {
    if (!this.pinnedRepoPath) return;

    this.loading = true;
    this.hooks = [];
    this.executionLogs = [];
    this.collapsedLogIds = new Set();
    this.selectedHook = null;
    this.editContent = '';
    this.hasUnsavedChanges = false;
    this.confirmingDelete = null;

    try {
      const [logsResult, result] = await Promise.all([
        getHookExecutionLogs(this.pinnedRepoPath),
        getHooks(this.pinnedRepoPath),
      ]);

      if (logsResult.success && Array.isArray(logsResult.data)) {
        this.executionLogs = logsResult.data;
      }

      if (result.success && result.data) {
        this.hooks = result.data;
      } else {
        showToast('Failed to load hooks', 'error');
      }
    } catch (err) {
      console.error('Failed to load hooks:', err);
      showToast('Failed to load hooks', 'error');
    } finally {
      this.loading = false;
    }
  }

  private async loadExecutionLogs(): Promise<void> {
    if (!this.pinnedRepoPath) return;

    try {
      const result = await getHookExecutionLogs(this.pinnedRepoPath);
      if (result.success && Array.isArray(result.data)) {
        this.executionLogs = result.data;
      }
    } catch (err) {
      console.error('Failed to load hook execution logs:', err);
    }
  }

  private async handleClearLogs(): Promise<void> {
    if (!this.pinnedRepoPath || this.clearingLogs) return;

    this.clearingLogs = true;
    try {
      const result = await clearHookExecutionLogs(this.pinnedRepoPath);
      if (result.success) {
        this.executionLogs = [];
        this.collapsedLogIds = new Set();
        await this.loadExecutionLogs();
        showToast('Hook execution logs cleared', 'success');
      } else {
        showToast(
          `Failed to clear hook execution logs: ${result.error?.message ?? 'Unknown error'}`,
          'error',
        );
      }
    } catch (err) {
      console.error('Failed to clear hook execution logs:', err);
      showToast('Failed to clear hook execution logs', 'error');
    } finally {
      this.clearingLogs = false;
    }
  }

  private toggleLogExpanded(id: string): void {
    const next = new Set(this.collapsedLogIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.collapsedLogIds = next;
  }

  private formatLogTimestamp(timestamp: number): string {
    const ms = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return String(timestamp);
    return date.toLocaleString();
  }

  private async selectHook(hook: GitHook): Promise<void> {
    if (this.hasUnsavedChanges) {
      const discard = await showConfirm('Unsaved Changes', 'You have unsaved changes. Discard them?', 'warning');
      if (!discard) return;
    }

    if (hook.exists) {
      try {
        const result = await getHook(this.pinnedRepoPath, hook.name);
        if (result.success && result.data) {
          this.selectedHook = result.data;
          this.editContent = result.data.content ?? '';
        } else {
          this.selectedHook = hook;
          this.editContent = hook.content ?? '';
        }
      } catch {
        this.selectedHook = hook;
        this.editContent = hook.content ?? '';
      }
    } else {
      this.selectedHook = hook;
      this.editContent = this.getDefaultHookContent(hook.name);
    }
    this.hasUnsavedChanges = false;
  }

  private getDefaultHookContent(hookName: string): string {
    return `#!/bin/sh\n#\n# ${hookName} hook\n#\n\n`;
  }

  private handleContentChange(e: Event): void {
    const textarea = e.target as HTMLTextAreaElement;
    this.editContent = textarea.value;

    if (this.selectedHook) {
      const originalContent = this.selectedHook.exists
        ? (this.selectedHook.content ?? '')
        : this.getDefaultHookContent(this.selectedHook.name);
      this.hasUnsavedChanges = this.editContent !== originalContent;
    }
  }

  private handleTabKey(e: KeyboardEvent): void {
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = e.target as HTMLTextAreaElement;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const value = textarea.value;
      textarea.value = value.substring(0, start) + '\t' + value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + 1;
      this.editContent = textarea.value;
      this.hasUnsavedChanges = true;
    }
  }

  private async handleSave(): Promise<void> {
    if (!this.selectedHook || !this.pinnedRepoPath) return;

    this.saving = true;

    try {
      const result = await saveHook(this.pinnedRepoPath, this.selectedHook.name, this.editContent);

      if (result.success) {
        showToast(`Hook "${this.selectedHook.name}" saved successfully`, 'success');
        this.hasUnsavedChanges = false;
        // Reload hooks to update status
        const hooksResult = await getHooks(this.pinnedRepoPath);
        if (hooksResult.success && hooksResult.data) {
          this.hooks = hooksResult.data;
          // Update selected hook reference
          const updated = this.hooks.find(h => h.name === this.selectedHook?.name);
          if (updated) {
            this.selectedHook = { ...updated, content: this.editContent };
          }
        }
      } else {
        showToast(`Failed to save hook: ${result.error?.message ?? 'Unknown error'}`, 'error');
      }
    } catch (err) {
      console.error('Failed to save hook:', err);
      showToast('Failed to save hook', 'error');
    } finally {
      this.saving = false;
    }
  }

  private async handleToggle(hook: GitHook): Promise<void> {
    if (!this.pinnedRepoPath || !hook.exists) return;

    try {
      const result = await toggleHook(this.pinnedRepoPath, hook.name, !hook.enabled);

      if (result.success) {
        showToast(
          `Hook "${hook.name}" ${!hook.enabled ? 'enabled' : 'disabled'}`,
          'success'
        );
        // Reload hooks
        const hooksResult = await getHooks(this.pinnedRepoPath);
        if (hooksResult.success && hooksResult.data) {
          this.hooks = hooksResult.data;
          if (this.selectedHook?.name === hook.name) {
            const updated = this.hooks.find(h => h.name === hook.name);
            if (updated) {
              this.selectedHook = { ...updated, content: this.editContent };
            }
          }
        }
      } else {
        showToast(`Failed to toggle hook: ${result.error?.message ?? 'Unknown error'}`, 'error');
      }
    } catch (err) {
      console.error('Failed to toggle hook:', err);
      showToast('Failed to toggle hook', 'error');
    }
  }

  private requestDelete(hookName: string): void {
    this.confirmingDelete = hookName;
  }

  private cancelDelete(): void {
    this.confirmingDelete = null;
  }

  private async confirmDelete(): Promise<void> {
    if (!this.confirmingDelete || !this.pinnedRepoPath) return;

    const hookName = this.confirmingDelete;
    this.confirmingDelete = null;

    try {
      const result = await deleteHook(this.pinnedRepoPath, hookName);

      if (result.success) {
        showToast(`Hook "${hookName}" deleted`, 'success');
        // Clear editor if we deleted the selected hook
        if (this.selectedHook?.name === hookName) {
          this.selectedHook = null;
          this.editContent = '';
          this.hasUnsavedChanges = false;
        }
        // Reload hooks
        const hooksResult = await getHooks(this.pinnedRepoPath);
        if (hooksResult.success && hooksResult.data) {
          this.hooks = hooksResult.data;
        }
      } else {
        showToast(`Failed to delete hook: ${result.error?.message ?? 'Unknown error'}`, 'error');
      }
    } catch (err) {
      console.error('Failed to delete hook:', err);
      showToast('Failed to delete hook', 'error');
    }
  }

  private handleOverlayClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) {
      this.close();
    }
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    // Only the topmost overlay owns Escape: every dialog listens on
    // `document`, so without this one keypress ran all of them.
    if (!this.open || !isTopOverlay(this)) return;
    if (e.key === 'Escape') {
      if (this.confirmingDelete) {
        this.cancelDelete();
      } else {
        this.close();
      }
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this.handleKeyDown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    removeOverlay(this);
    document.removeEventListener('keydown', this.handleKeyDown);
  }

  public async close(): Promise<void> {
    if (this.hasUnsavedChanges) {
      const discard = await showConfirm('Unsaved Changes', 'You have unsaved changes. Discard them?', 'warning');
      if (!discard) return;
    }
    // Cleared HERE: close() left them set, and the element stays mounted, so
    // one discarded session made EVERY later Escape anywhere in the app pop
    // the same native "Unsaved Changes" confirm out of nowhere.
    this.hasUnsavedChanges = false;
    this.confirmingDelete = null;
    this.open = false;
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private getHookStatusClass(hook: GitHook): string {
    if (!hook.exists) return 'not-exists';
    return hook.enabled ? 'exists-enabled' : 'exists-disabled';
  }

  private hasTemplate(hookName: string): boolean {
    return hookName in HOOK_TEMPLATES;
  }

  private async handleUseTemplate(): Promise<void> {
    if (!this.selectedHook) return;

    const template = HOOK_TEMPLATES[this.selectedHook.name];
    if (!template) return;

    if (this.editContent.trim() && this.editContent !== this.getDefaultHookContent(this.selectedHook.name)) {
      const replace = await showConfirm('Replace Content', 'Replace current content with template?');
      if (!replace) return;
    }

    this.editContent = template;
    this.hasUnsavedChanges = true;
  }

  private getActiveHookCount(): number {
    return this.hooks.filter(h => h.exists && h.enabled).length;
  }

  private renderHookItem(hook: GitHook) {
    const isActive = this.selectedHook?.name === hook.name;

    return html`
      <div
        class="hook-item ${isActive ? 'active' : ''}"
        @click=${() => this.selectHook(hook)}
      >
        <span class="hook-status-dot ${this.getHookStatusClass(hook)}"
              title=${hook.exists ? (hook.enabled ? 'Enabled' : 'Disabled') : 'Not configured'}
        ></span>
        <div class="hook-item-info">
          <div class="hook-item-name">${hook.name}</div>
          <div class="hook-item-desc">${hook.description}</div>
        </div>
        ${isActive && this.hasUnsavedChanges ? html`<span class="unsaved-dot" title="Unsaved changes"></span>` : nothing}
      </div>
    `;
  }

  private renderEditorPanel() {
    if (!this.selectedHook) {
      return html`
        <div class="editor-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"></path>
          </svg>
          <div class="editor-empty-text">Select a hook to view or edit</div>
          <div class="editor-empty-hint">
            Choose a hook from the list to configure it
          </div>
        </div>
      `;
    }

    const hook = this.selectedHook;
    const isExisting = hook.exists;

    return html`
      <div class="editor-header">
        <div class="editor-header-left">
          <span class="editor-hook-name">${hook.name}</span>
          ${isExisting
            ? html`<span class="editor-badge ${hook.enabled ? 'enabled' : 'disabled'}">
                ${hook.enabled ? 'Enabled' : 'Disabled'}
              </span>`
            : html`<span class="editor-badge new-hook">New</span>`
          }
        </div>
        <div class="editor-header-right">
          ${isExisting ? html`
            <label class="toggle" title="${hook.enabled ? 'Disable hook' : 'Enable hook'}">
              <input
                class="toggle-input"
                type="checkbox"
                .checked=${hook.enabled}
                @change=${(e: Event) => {
                  e.stopPropagation();
                  this.handleToggle(hook);
                }}
              />
              <span class="toggle-track"></span>
            </label>
            <button
              class="icon-btn danger"
              title="Delete hook"
              @click=${() => this.requestDelete(hook.name)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path>
              </svg>
            </button>
          ` : nothing}
        </div>
      </div>
      ${this.hasTemplate(hook.name) ? html`
        <div class="template-bar">
          <span>Template available for this hook</span>
          <button class="template-btn" @click=${this.handleUseTemplate}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="16" y1="13" x2="8" y2="13"></line>
              <line x1="16" y1="17" x2="8" y2="17"></line>
              <polyline points="10 9 9 9 8 9"></polyline>
            </svg>
            Use template
          </button>
        </div>
      ` : nothing}
      <div class="editor-content">
        <textarea
          class="editor-textarea"
          .value=${this.editContent}
          @input=${this.handleContentChange}
          @keydown=${this.handleTabKey}
          placeholder="Enter hook script content..."
          spellcheck="false"
        ></textarea>
      </div>
    `;
  }

  private renderExecutionLogsSection() {
    return html`
      <div class="execution-logs-section">
        <div class="execution-logs-header">
          <span class="execution-logs-title">Recent Execution Logs</span>
          <button
            class="clear-logs-btn"
            type="button"
            ?disabled=${this.clearingLogs}
            @click=${this.handleClearLogs}
          >
            Clear Logs
          </button>
        </div>
        ${this.executionLogs.length === 0
          ? html`<div class="execution-logs-empty">No hook executions recorded yet</div>`
          : html`
              <div class="execution-logs-list">
                ${this.executionLogs.map((log) => {
                  const isExpanded = !this.collapsedLogIds.has(log.id);
                  return html`
                    <div class="execution-log-item">
                      <div
                        class="execution-log-row"
                        @click=${() => this.toggleLogExpanded(log.id)}
                      >
                        <div class="execution-log-left">
                          <span class="execution-log-hook-name">${log.hookName}</span>
                          <span class="execution-log-badge ${log.success ? 'pass' : 'fail'}">
                            ${log.success
                              ? 'Pass'
                              : log.exitCode !== null && log.exitCode !== undefined
                                ? `Fail (exit ${log.exitCode})`
                                : 'Fail'}
                          </span>
                        </div>
                        <div class="execution-log-meta">
                          <span class="execution-log-duration">${log.durationMs}ms</span>
                          <span class="execution-log-timestamp">
                            ${this.formatLogTimestamp(log.timestamp)}
                          </span>
                        </div>
                      </div>
                      ${isExpanded && log.output
                        ? html`<pre class="execution-log-output">${log.output}</pre>`
                        : nothing}
                    </div>
                  `;
                })}
              </div>
            `}
      </div>
    `;
  }

  private renderConfirmDelete() {
    if (!this.confirmingDelete) return nothing;

    return html`
      <div class="confirm-overlay" @click=${(e: MouseEvent) => {
        if (e.target === e.currentTarget) this.cancelDelete();
      }}>
        <div class="confirm-dialog">
          <div class="confirm-title">Delete Hook</div>
          <div class="confirm-message">
            Are you sure you want to delete the <strong>${this.confirmingDelete}</strong> hook?
            This action cannot be undone.
          </div>
          <div class="confirm-actions">
            <button class="btn btn-secondary" @click=${this.cancelDelete}>Cancel</button>
            <button class="btn btn-danger" @click=${this.confirmDelete}>Delete</button>
          </div>
        </div>
      </div>
    `;
  }

  render() {
    const activeCount = this.getActiveHookCount();

    return html`
      <div class="overlay" @click=${this.handleOverlayClick}></div>
      <div class="dialog">
        <div class="header">
          <div class="header-left">
            <svg class="header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"></path>
            </svg>
            <span class="title">Git Hooks</span>
          </div>
          <button class="close-btn" @click=${this.close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="body">
          <div class="hook-list-panel">
            <div class="hook-list-header">
              <span class="hook-list-title">Hooks</span>
              <span class="hook-count">${activeCount} active</span>
            </div>
            <div class="hook-list">
              ${this.loading
                ? html`<div class="loading">Loading hooks...</div>`
                : this.hooks.length === 0
                  ? html`<div class="empty">No hooks found</div>`
                  : this.hooks.map(hook => this.renderHookItem(hook))
              }
            </div>
          </div>

          <div class="editor-panel">
            ${this.renderEditorPanel()}
          </div>
        </div>

        ${this.renderExecutionLogsSection()}

        <div class="footer">
          <div class="footer-left">
            ${this.selectedHook && this.hasUnsavedChanges
              ? html`Unsaved changes`
              : this.selectedHook
                ? html`${this.selectedHook.description}`
                : html`${this.hooks.filter(h => h.exists).length} of ${this.hooks.length} hooks configured`
            }
          </div>
          <div class="footer-right">
            <button class="btn btn-secondary" @click=${this.close}>Close</button>
            ${this.selectedHook ? html`
              <button
                class="btn btn-primary"
                ?disabled=${!this.hasUnsavedChanges || this.saving}
                @click=${this.handleSave}
              >
                ${this.saving ? 'Saving...' : this.selectedHook.exists ? 'Save Hook' : 'Create Hook'}
              </button>
            ` : nothing}
          </div>
        </div>

        ${this.renderConfirmDelete()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-hooks-dialog': GnHooksDialog;
  }
}
