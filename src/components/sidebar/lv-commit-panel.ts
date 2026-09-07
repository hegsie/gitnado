import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import * as aiService from '../../services/ai.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { showPrompt } from '../../services/dialog.service.ts';
import { repositoryStore } from '../../stores/index.ts';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { CommitTemplate, ConventionalType } from '../../services/git.service.ts';
import type { Commit } from '../../types/git.types.ts';
import { RefLockController, tryAcquireRefOpOrWarn, releaseRefOp } from '../../utils/ref-lock.ts';

/**
 * Commit panel component
 * Allows users to write commit messages and create commits
 */
@customElement('lv-commit-panel')
export class LvCommitPanel extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        padding: var(--spacing-xs) var(--spacing-sm);
        gap: var(--spacing-xs);
        background: var(--color-bg-secondary);
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .staged-count {
        font-weight: var(--font-weight-medium);
      }

      .staged-count.has-staged {
        color: var(--color-success);
      }

      .template-row {
        display: flex;
        gap: var(--spacing-xs);
        align-items: center;
      }

      .template-select {
        flex: 1;
        padding: var(--spacing-xs);
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-primary);
        font-size: var(--font-size-xs);
        cursor: pointer;
      }

      .template-select:focus {
        outline: none;
        border-color: var(--color-primary);
      }

      .icon-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        background: transparent;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-secondary);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .icon-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .icon-btn svg {
        width: 14px;
        height: 14px;
      }

      .conventional-row {
        display: flex;
        gap: var(--spacing-xs);
        align-items: center;
      }

      .type-select {
        width: 100px;
        padding: var(--spacing-xs);
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-primary);
        font-size: var(--font-size-xs);
        cursor: pointer;
      }

      .type-select:focus {
        outline: none;
        border-color: var(--color-primary);
      }

      .scope-input {
        flex: 1;
        padding: var(--spacing-xs);
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-primary);
        font-size: var(--font-size-xs);
      }

      .scope-input:focus {
        outline: none;
        border-color: var(--color-primary);
      }

      .scope-input::placeholder {
        color: var(--color-text-muted);
      }

      .message-container {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .summary-input {
        width: 100%;
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        font-family: inherit;
        resize: none;
        transition: border-color var(--transition-fast);
      }

      .summary-input:focus {
        outline: none;
        border-color: var(--color-primary);
      }

      .summary-input::placeholder {
        color: var(--color-text-muted);
      }

      .summary-input.over-limit {
        border-color: var(--color-warning);
      }

      .description-input {
        width: 100%;
        min-height: 48px;
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        font-family: inherit;
        resize: vertical;
        transition: border-color var(--transition-fast);
      }

      .description-input:focus {
        outline: none;
        border-color: var(--color-primary);
      }

      .description-input::placeholder {
        color: var(--color-text-muted);
      }

      .summary-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .char-count {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .char-count.over-limit {
        color: var(--color-warning);
      }

      .options-row {
        display: flex;
        gap: var(--spacing-sm);
        align-items: center;
        flex-wrap: wrap;
      }

      .actions {
        display: flex;
        gap: var(--spacing-xs);
      }

      .commit-btn {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--spacing-xs);
        padding: var(--spacing-sm);
        background: var(--color-primary);
        color: var(--color-text-inverse);
        border-radius: var(--radius-md);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        transition: background var(--transition-fast);
      }

      .commit-btn:hover:not(:disabled) {
        background: var(--color-primary-hover);
      }

      .commit-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .commit-btn svg {
        width: 16px;
        height: 16px;
      }

      .amend-toggle {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        cursor: pointer;
        user-select: none;
      }

      .amend-toggle input {
        margin: 0;
      }

      .conventional-toggle {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        cursor: pointer;
        user-select: none;
      }

      .conventional-toggle input {
        margin: 0;
      }

      .error {
        padding: var(--spacing-xs);
        background: var(--color-error-bg);
        border-radius: var(--radius-sm);
        color: var(--color-error);
        font-size: var(--font-size-xs);
      }

      /* Vibe Check & Split Suggestion styles */
      .ai-checks {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 0 var(--spacing-xs);
      }

      .check-buttons {
        display: flex;
        gap: 4px;
      }

      .check-btn {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 3px 8px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        font-size: 11px;
        cursor: pointer;
      }

      .check-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .check-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }

      .vibe-result {
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        font-size: 11px;
        overflow: hidden;
      }

      .vibe-result.high { border-color: var(--color-error); }
      .vibe-result.medium { border-color: var(--color-warning); }

      .vibe-summary {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        cursor: pointer;
      }

      .vibe-summary:hover { background: var(--color-bg-hover); }

      /* A failed AI pass leaves the regex secret scan alone, and saying so is
         the whole point — a clean-looking result over a check that never ran
         is worse than no check. */
      .vibe-ai-warning {
        padding: 6px 8px;
        border-top: 1px solid var(--color-border);
        color: var(--color-warning);
        font-size: 11px;
        line-height: 1.4;
      }

      .risk-badge {
        padding: 1px 6px;
        border-radius: 8px;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
      }

      .risk-badge.low { background: var(--color-success-bg); color: var(--color-success); }
      .risk-badge.medium { background: var(--color-warning-bg); color: var(--color-warning); }
      .risk-badge.high { background: var(--color-error-bg); color: var(--color-error); }

      .findings-list {
        border-top: 1px solid var(--color-border);
        padding: 4px;
      }

      .finding {
        display: flex;
        gap: 6px;
        align-items: baseline;
        padding: 2px 4px;
        font-size: 11px;
      }

      .finding.error { color: var(--color-error); }
      .finding.warning { color: var(--color-warning); }

      .finding-category {
        font-weight: 600;
        text-transform: uppercase;
        font-size: 9px;
        opacity: 0.7;
        flex-shrink: 0;
      }

      .finding-file {
        color: var(--color-text-muted);
        font-size: 10px;
        margin-left: auto;
        flex-shrink: 0;
      }

      .split-result {
        border: 1px solid var(--color-accent);
        border-radius: var(--radius-sm);
        font-size: 11px;
        overflow: hidden;
      }

      .split-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        cursor: pointer;
        color: var(--color-accent);
      }

      .split-header:hover { background: var(--color-bg-hover); }

      .dismiss-btn {
        margin-left: auto;
        padding: 1px 6px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        font-size: 10px;
        cursor: pointer;
      }

      .split-groups {
        border-top: 1px solid var(--color-border);
        padding: 6px;
      }

      .split-explanation {
        color: var(--color-text-secondary);
        margin-bottom: 6px;
        font-style: italic;
      }

      .split-group {
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        padding: 6px;
        margin-bottom: 4px;
      }

      .group-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .stage-group-btn {
        padding: 2px 8px;
        border: 1px solid var(--color-accent);
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-accent);
        font-size: 10px;
        cursor: pointer;
      }

      .stage-group-btn:hover {
        background: var(--color-accent);
        color: white;
      }

      .group-message {
        color: var(--color-text-secondary);
        font-family: var(--font-mono);
        font-size: 10px;
        margin-top: 2px;
      }

      .group-files {
        color: var(--color-text-muted);
        font-size: 10px;
        margin-top: 2px;
      }

      .success {
        padding: var(--spacing-xs);
        background: var(--color-success-bg);
        border-radius: var(--radius-sm);
        color: var(--color-success);
        font-size: var(--font-size-xs);
      }

      .header-actions {
        display: flex;
        gap: var(--spacing-xs);
        align-items: center;
      }

      .generate-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        background: transparent;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-secondary);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .generate-btn:hover:not(:disabled) {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .generate-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .generate-btn svg {
        width: 14px;
        height: 14px;
      }

      .generate-btn.ai-ready {
        color: var(--color-accent, #4fc3f7);
        border-color: var(--color-accent, #4fc3f7);
      }

      .generate-btn.ai-ready:hover:not(:disabled) {
        background: var(--color-accent, #4fc3f7);
        color: var(--color-bg-primary, #1e1e1e);
      }

      .generate-btn .spinner {
        animation: spin 1s linear infinite;
      }

      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }


      .history-wrapper {
        position: relative;
      }

      .history-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        background: transparent;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-secondary);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .history-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .history-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .history-btn svg {
        width: 14px;
        height: 14px;
      }

      .history-dropdown {
        position: absolute;
        top: calc(100% + 4px);
        right: 0;
        z-index: 100;
        width: 300px;
        max-height: 240px;
        overflow-y: auto;
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      }

      .history-dropdown-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-xs) var(--spacing-sm);
        border-bottom: 1px solid var(--color-border);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .history-clear-btn {
        padding: 2px var(--spacing-xs);
        background: transparent;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-muted);
        font-size: var(--font-size-xs);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .history-clear-btn:hover {
        color: var(--color-error);
        border-color: var(--color-error);
      }

      .history-item {
        display: block;
        width: 100%;
        padding: var(--spacing-xs) var(--spacing-sm);
        background: transparent;
        border: none;
        border-bottom: 1px solid var(--color-border);
        color: var(--color-text-primary);
        font-size: var(--font-size-xs);
        text-align: left;
        cursor: pointer;
        transition: background var(--transition-fast);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .history-item:last-child {
        border-bottom: none;
      }

      .history-item:hover {
        background: var(--color-bg-hover);
      }

      .history-empty {
        padding: var(--spacing-sm);
        color: var(--color-text-muted);
        font-size: var(--font-size-xs);
        text-align: center;
      }
    `,
  ];

  @property({ type: String }) repositoryPath: string = '';

  /**
   * The shared working-tree lock.
   *
   * The graph's Amend menu entry is gated on it, but that entry runs no git
   * command — it just reveals this panel in amend mode. The command that
   * actually rewrites HEAD is this panel's Commit button, and this component
   * never observed the lock at all. So during a graph-initiated rebase, merge,
   * hard reset or discard — with every list, menu and dialog correctly greyed
   * out — Commit stayed live and create_commit ran against the tree those
   * commands were rewriting.
   */
  private lock = new RefLockController(this, () => this.repositoryPath);
  @property({ type: Number }) stagedCount: number = 0;

  @state() private summary: string = '';
  @state() private description: string = '';
  @state() private amend: boolean = false;
  @state() private isCommitting: boolean = false;
  @state() private error: string | null = null;
  @state() private success: string | null = null;
  @state() private lastCommit: Commit | null = null;

  // Template state
  @state() private templates: CommitTemplate[] = [];
  @state() private selectedTemplateId: string = '';

  // Conventional commit state
  @state() private conventionalMode: boolean = false;
  @state() private conventionalTypes: ConventionalType[] = [];
  @state() private selectedType: string = 'feat';
  @state() private scope: string = '';

  // Template variable state
  @state() private currentBranch: string = '';
  private cachedAuthor: string = '';

  // Store original input before amend pre-population
  private originalSummary: string = '';
  private originalDescription: string = '';

  // AI state
  @state() private aiAvailable: boolean = false;
  /** Why AI is unavailable — names the selected provider when it is the one at fault. */
  @state() private aiUnavailableReason: string = '';
  @state() private isGenerating: boolean = false;
  @state() private generationError: string | null = null;

  // Vibe check state
  @state() private vibeCheckResult: import('../../services/ai.service.ts').StagedAnalysis | null = null;
  @state() private isAnalyzing: boolean = false;
  @state() private showVibeDetails: boolean = false;

  // Split suggestion state
  @state() private splitSuggestion: import('../../services/ai.service.ts').CommitSplitSuggestion | null = null;
  @state() private isAnalyzingSplit: boolean = false;
  @state() private showSplitDetails: boolean = false;

  // History state
  @state() private commitHistory: string[] = [];
  @state() private showHistory: boolean = false;

  @query('.summary-input') private summaryInput!: HTMLTextAreaElement;

  private readonly SUMMARY_LIMIT = 72;

  private readonly HISTORY_STORAGE_KEY = 'gitnado-commit-history';
  private readonly HISTORY_MAX_ENTRIES = 20;

  // Per-repo draft cache: preserves commit form state when switching repos
  private draftCache = new Map<string, { summary: string; description: string; conventionalMode: boolean; selectedType: string; scope: string }>();

  private boundHandleTriggerAmend = this.handleTriggerAmend.bind(this);
  private boundHandleAiSettingsChanged = () => this.checkAiAvailability();
  // Reload the author identity when the repo refreshes (e.g. after applying a
  // profile that rewrote user.name/user.email in the repo's git config), so the
  // {{author}} template placeholder reflects the new identity.
  private boundHandleRepositoryRefresh = () => this.loadAuthorName();
  private unsubscribeStore?: () => void;
  private aiRetryTimer?: ReturnType<typeof setTimeout>;
  private modelCompleteUnlisten?: UnlistenFn;

  async connectedCallback(): Promise<void> {
    super.connectedCallback();
    this.loadCommitHistory();
    await this.loadTemplates();
    await this.loadConventionalTypes();
    await this.loadGitTemplate();
    await this.checkAiAvailability();
    await this.loadAuthorName();
    this._onDocumentClick = this._onDocumentClick.bind(this);
    document.addEventListener('click', this._onDocumentClick);

    // Track current branch from store
    const initialState = repositoryStore.getState();
    this.currentBranch = initialState.getActiveRepository()?.currentBranch?.shorthand ?? '';
    this.unsubscribeStore = repositoryStore.subscribe((state) => {
      this.currentBranch = state.getActiveRepository()?.currentBranch?.shorthand ?? '';
    });

    // Listen for trigger-amend events from context menu
    window.addEventListener('trigger-amend', this.boundHandleTriggerAmend);

    // Re-check AI availability when settings change (browser event from settings dialog)
    window.addEventListener('ai-settings-changed', this.boundHandleAiSettingsChanged);

    // Reload author identity after a repository refresh (e.g. profile applied).
    window.addEventListener('repository-refresh', this.boundHandleRepositoryRefresh);

    // Also listen for Tauri backend event when a model download completes and auto-loads
    listen<{ modelId: string; loaded?: boolean }>('model-download-complete', (event) => {
      if (event.payload.loaded) {
        this.checkAiAvailability();
      }
    }).then(unlisten => { this.modelCompleteUnlisten = unlisten; });

    // If AI isn't available yet, poll periodically to catch backend auto-loading
    // a model on startup (which can take 10-30 seconds)
    if (!this.aiAvailable) {
      this.startAiAvailabilityPolling();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('click', this._onDocumentClick);
    window.removeEventListener('trigger-amend', this.boundHandleTriggerAmend);
    window.removeEventListener('ai-settings-changed', this.boundHandleAiSettingsChanged);
    window.removeEventListener('repository-refresh', this.boundHandleRepositoryRefresh);
    this.modelCompleteUnlisten?.();
    if (this.aiRetryTimer) clearTimeout(this.aiRetryTimer);
    this.unsubscribeStore?.();
  }

  willUpdate(changed: PropertyValues): void {
    if (changed.has('repositoryPath')) {
      const oldPath = changed.get('repositoryPath') as string | undefined;

      // Save draft for the previous repo
      if (oldPath) {
        this.draftCache.set(oldPath, {
          summary: this.summary,
          description: this.description,
          conventionalMode: this.conventionalMode,
          selectedType: this.selectedType,
          scope: this.scope,
        });
      }

      // Restore draft for the new repo, or reset to empty
      const draft = this.repositoryPath ? this.draftCache.get(this.repositoryPath) : undefined;
      if (draft) {
        this.summary = draft.summary;
        this.description = draft.description;
        this.conventionalMode = draft.conventionalMode;
        this.selectedType = draft.selectedType;
        this.scope = draft.scope;
      } else {
        this.summary = '';
        this.description = '';
        this.conventionalMode = false;
        this.selectedType = 'feat';
        this.scope = '';
      }

      // Clear transient state
      this.error = null;
      this.success = null;
      this.generationError = null;
      this.amend = false;
      this.lastCommit = null;
    }
  }

  /** Poll for AI availability until it becomes available or we give up. */
  private startAiAvailabilityPolling(): void {
    let attempts = 0;
    const maxAttempts = 12; // ~60 seconds total (5s × 12)
    console.log('[lv-commit-panel] Starting AI availability polling');
    const poll = async () => {
      attempts++;
      console.log(`[lv-commit-panel] Poll attempt ${attempts}/${maxAttempts}`);
      await this.checkAiAvailability();
      if (this.aiAvailable) {
        console.log('[lv-commit-panel] AI became available!');
        return;
      }
      if (attempts >= maxAttempts) {
        console.log('[lv-commit-panel] Gave up polling after', maxAttempts, 'attempts');
        return;
      }
      this.aiRetryTimer = setTimeout(poll, 5000);
    };
    this.aiRetryTimer = setTimeout(poll, 5000);
  }

  private _onDocumentClick(e: MouseEvent): void {
    if (this.showHistory) {
      const path = e.composedPath();
      const isInside = path.some(
        (el) => el instanceof HTMLElement && (el.classList?.contains('history-wrapper'))
      );
      if (!isInside) {
        this.showHistory = false;
      }
    }
  }

  private handleTriggerAmend(e: Event): void {
    const event = e as CustomEvent<{ commit: Commit }>;
    if (event.detail?.commit) {
      // Store original input before pre-populating
      this.originalSummary = this.summary;
      this.originalDescription = this.description;

      // Enable amend mode and populate with commit message
      this.amend = true;
      this.lastCommit = event.detail.commit;
      this.summary = event.detail.commit.summary;
      this.description = event.detail.commit.body ?? '';

      // Focus the summary input
      this.updateComplete.then(() => {
        this.summaryInput?.focus();
      });
    }
  }

  private async checkAiAvailability(): Promise<void> {
    this.aiAvailable = await aiService.isAiAvailable();
    // A selected provider is never substituted, so "unavailable" usually means
    // that one provider is unreachable rather than nothing being configured.
    // Carry the reason so the tooltip can say which provider needs attention.
    this.aiUnavailableReason = this.aiAvailable
      ? ''
      : ((await aiService.getAiUnavailableReason())?.reason ?? '');
    console.log('[lv-commit-panel] checkAiAvailability:', this.aiAvailable);
  }

  private loadCommitHistory(): void {
    try {
      const stored = localStorage.getItem(this.HISTORY_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          this.commitHistory = parsed.filter(
            (item): item is string => typeof item === 'string'
          );
        }
      }
    } catch {
      this.commitHistory = [];
    }
  }

  private saveToHistory(message: string): void {
    const trimmed = message.trim();
    if (!trimmed) return;

    // Remove duplicates, then prepend
    const filtered = this.commitHistory.filter((m) => m !== trimmed);
    const updated = [trimmed, ...filtered].slice(0, this.HISTORY_MAX_ENTRIES);

    this.commitHistory = updated;
    try {
      localStorage.setItem(this.HISTORY_STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // localStorage quota exceeded or unavailable - silently ignore
    }
  }

  private handleHistoryToggle(e: Event): void {
    e.stopPropagation();
    this.showHistory = !this.showHistory;
  }

  private handleHistorySelect(message: string): void {
    // Parse message: first line is summary, rest is description
    const lines = message.split('\n');
    this.summary = lines[0] || '';
    this.description = lines.slice(1).join('\n').replace(/^\n+/, '').trimEnd();
    this.showHistory = false;
  }

  private handleClearHistory(): void {
    this.commitHistory = [];
    localStorage.removeItem(this.HISTORY_STORAGE_KEY);
    this.showHistory = false;
  }

  private async loadTemplates(): Promise<void> {
    const result = await gitService.listTemplates();
    if (result.success && result.data) {
      this.templates = result.data;
    }
  }

  private async loadConventionalTypes(): Promise<void> {
    const result = await gitService.getConventionalTypes();
    if (result.success && result.data) {
      this.conventionalTypes = result.data;
    }
  }

  private async loadGitTemplate(): Promise<void> {
    if (!this.repositoryPath) return;
    const result = await gitService.getCommitTemplate(this.repositoryPath);
    if (result.success && result.data) {
      // Parse the template - first line is summary, rest is description
      const expanded = this.expandTemplateVariables(result.data);
      const lines = expanded.split('\n');
      const nonCommentLines = lines.filter(l => !l.startsWith('#'));
      if (nonCommentLines.length > 0) {
        this.summary = nonCommentLines[0].trim();
        if (nonCommentLines.length > 1) {
          this.description = nonCommentLines.slice(1).join('\n').trim();
        }
      }
    }
  }

  private async loadAuthorName(): Promise<void> {
    if (!this.repositoryPath) return;
    const result = await gitService.getUserIdentity(this.repositoryPath);
    if (result.success && result.data?.name) {
      this.cachedAuthor = result.data.name;
    }
  }

  expandTemplateVariables(content: string): string {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const datetime = `${date} ${hours}:${minutes}`;

    return content
      .replace(/\$\{branch\}/g, this.currentBranch)
      .replace(/\$\{date\}/g, date)
      .replace(/\$\{datetime\}/g, datetime)
      .replace(/\$\{author\}/g, this.cachedAuthor);
  }

  private handleTemplateChange(e: Event): void {
    const select = e.target as HTMLSelectElement;
    this.selectedTemplateId = select.value;

    if (this.selectedTemplateId) {
      const template = this.templates.find(t => t.id === this.selectedTemplateId);
      if (template) {
        // Parse template content with variable expansion - first line is summary, rest is description
        const expanded = this.expandTemplateVariables(template.content);
        const lines = expanded.split('\n');
        this.summary = lines[0] || '';
        this.description = lines.slice(1).join('\n').trim();
        this.conventionalMode = template.isConventional;
      }
    }
  }

  private async handleSaveTemplate(): Promise<void> {
    const name = await showPrompt('Save Template', 'Enter template name:');
    if (!name) return;

    const content = this.description
      ? `${this.summary}\n${this.description}`
      : this.summary;

    const template: CommitTemplate = {
      id: `template-${Date.now()}`,
      name,
      content,
      isConventional: this.conventionalMode,
      createdAt: Date.now(),
    };

    const result = await gitService.saveTemplate(template);
    if (result.success) {
      await this.loadTemplates();
      this.selectedTemplateId = template.id;
    } else {
      showToast(`Failed to save template: ${result.error?.message ?? 'Unknown error'}`, 'error');
    }
  }

  private handleConventionalToggle(e: Event): void {
    const target = e.target as HTMLInputElement;
    this.conventionalMode = target.checked;
  }

  private handleTypeChange(e: Event): void {
    const select = e.target as HTMLSelectElement;
    this.selectedType = select.value;
  }

  private handleScopeInput(e: Event): void {
    const target = e.target as HTMLInputElement;
    this.scope = target.value;
  }

  private buildCommitMessage(): string {
    let summary = this.summary;

    // If conventional mode, prepend type and scope
    if (this.conventionalMode && this.selectedType) {
      const scopePart = this.scope ? `(${this.scope})` : '';
      summary = `${this.selectedType}${scopePart}: ${summary}`;
    }

    return this.description ? `${summary}\n\n${this.description}` : summary;
  }

  private get canCommit(): boolean {
    return (
      this.summary.trim().length > 0 &&
      (this.stagedCount > 0 || this.amend) &&
      !this.isCommitting &&
      !this.lock.busy
    );
  }

  private handleSummaryInput(e: Event): void {
    const target = e.target as HTMLTextAreaElement;
    this.summary = target.value;
    this.error = null;
    this.success = null;
  }

  private handleDescriptionInput(e: Event): void {
    const target = e.target as HTMLTextAreaElement;
    this.description = target.value;
  }

  private async handleAmendToggle(e: Event): Promise<void> {
    const target = e.target as HTMLInputElement;
    this.amend = target.checked;

    if (this.amend) {
      // Store current input before pre-populating
      this.originalSummary = this.summary;
      this.originalDescription = this.description;

      // Fetch last commit and pre-populate message
      await this.fetchLastCommitMessage();
    } else {
      // Restore original input when toggling off
      this.summary = this.originalSummary;
      this.description = this.originalDescription;
      this.lastCommit = null;
    }
  }

  private async fetchLastCommitMessage(): Promise<void> {
    if (!this.repositoryPath) return;

    try {
      const result = await gitService.getCommitHistory({
        path: this.repositoryPath,
        limit: 1,
      });

      if (result.success && result.data && result.data.length > 0) {
        this.lastCommit = result.data[0];
        this.summary = this.lastCommit.summary;
        this.description = this.lastCommit.body ?? '';
        return;
      }

      // Without this the checkbox stayed ticked with lastCommit still null —
      // a state the label and the Commit button cannot tell from a healthy
      // one, since canCommit is satisfied by `amend` alone. The user then
      // learned it had failed only after pressing Commit. (invokeCommand never
      // throws, so this branch — not the catch below — is the real failure
      // path: an unborn HEAD, or a ref deleted out from under the app.)
      this.amend = false;
      showToast(
        result.error?.message ?? 'Could not read the last commit to amend',
        'error'
      );
    } catch (err) {
      console.error('Failed to fetch last commit:', err);
      showToast(`Failed to fetch last commit: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // Cmd/Ctrl + Enter to commit
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && this.canCommit) {
      e.preventDefault();
      this.handleCommit();
    }
  }

  private handleOpenSettings(): void {
    // Dispatch event to open settings dialog
    this.dispatchEvent(new CustomEvent('open-settings', {
      bubbles: true,
      composed: true,
    }));
  }

  private async handleGenerateMessage(): Promise<void> {
    if (!this.repositoryPath || this.isGenerating) return;

    this.isGenerating = true;
    this.generationError = null;

    try {
      const result = await aiService.generateCommitMessage(this.repositoryPath);

      if (result.success && result.data) {
        // Parse conventional commit format if present
        const summary = result.data.summary;
        const conventionalMatch = summary.match(
          /^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)(\(.+?\))?:\s*(.+)$/i
        );

        if (conventionalMatch && this.conventionalMode) {
          this.selectedType = conventionalMatch[1].toLowerCase();
          if (conventionalMatch[2]) {
            this.scope = conventionalMatch[2].slice(1, -1); // Remove parentheses
          }
          this.summary = conventionalMatch[3];
        } else {
          this.summary = summary;
        }

        this.description = result.data.body ?? '';
      } else {
        this.generationError = result.error?.message ?? 'Failed to generate message';
      }
    } catch (err) {
      this.generationError = err instanceof Error ? err.message : 'Unknown error';
    } finally {
      this.isGenerating = false;
    }
  }

  private async handleVibeCheck(): Promise<void> {
    if (!this.repositoryPath || this.stagedCount === 0) return;

    this.isAnalyzing = true;
    this.vibeCheckResult = null;
    this.generationError = null;

    try {
      const result = await aiService.analyzeStagedChanges(this.repositoryPath);

      if (result.success && result.data) {
        this.vibeCheckResult = result.data;
        this.showVibeDetails = result.data.findings.length > 0;
      } else {
        this.generationError = result.error?.message ?? 'Vibe check failed';
      }
    } catch (err) {
      this.generationError = err instanceof Error ? err.message : 'Vibe check failed';
    } finally {
      this.isAnalyzing = false;
    }
  }

  private async handleSuggestSplits(): Promise<void> {
    if (!this.repositoryPath || this.stagedCount === 0) return;

    this.isAnalyzingSplit = true;
    this.splitSuggestion = null;
    this.generationError = null;

    try {
      const result = await aiService.suggestCommitSplits(this.repositoryPath);

      if (result.success && result.data) {
        this.splitSuggestion = result.data;
        this.showSplitDetails = result.data.shouldSplit;
        if (!result.data.shouldSplit) {
          // Success path with nothing to render otherwise — give explicit feedback.
          showToast('Staged changes look cohesive — no split needed', 'info');
        }
      } else {
        this.generationError = result.error?.message ?? 'Split check failed';
      }
    } catch (err) {
      this.generationError = err instanceof Error ? err.message : 'Split check failed';
    } finally {
      this.isAnalyzingSplit = false;
    }
  }

  private async handleStageGroup(files: string[]): Promise<void> {
    if (!this.repositoryPath) return;

    // Isolate this group so the next commit contains ONLY its files. Unstage
    // every currently-staged file that isn't in this group — deriving the set
    // from the real index (not just the other AI-suggested groups, which may
    // not cover every staged file when the diff was truncated for the model).
    const groupSet = new Set(files);
    const status = await gitService.getStatus(this.repositoryPath);
    if (!status.success) {
      showToast(status.error?.message ?? 'Failed to isolate group', 'error');
      return;
    }
    const otherStaged = (status.data ?? [])
      .filter(e => e.isStaged && !groupSet.has(e.path))
      .map(e => e.path);

    if (otherStaged.length > 0) {
      const unstage = await gitService.unstageFiles(this.repositoryPath, { paths: otherStaged });
      if (!unstage.success) {
        showToast(unstage.error?.message ?? 'Failed to isolate group', 'error');
        return;
      }
    }

    const result = await gitService.stageFiles(this.repositoryPath, { paths: files });
    if (result.success) {
      showToast(`Staged ${files.length} files`, 'success');
      window.dispatchEvent(new CustomEvent('status-refresh'));
    } else {
      showToast(result.error?.message ?? 'Failed to stage files', 'error');
    }
  }

  /** Basename of a repo path, for naming an off-screen repo to the user. */
  private repoLabel(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  }

  /**
   * Report a failed commit where the user will actually see it: the panel's
   * own banner while it still shows the repo that failed, a repo-named toast
   * once the user has tabbed away (the banner would otherwise blame the repo
   * now on screen for a failure in a different one).
   */
  private reportCommitFailure(repoPath: string, message: string): void {
    if (this.repositoryPath === repoPath) {
      this.error = message;
    } else {
      showToast(`${this.repoLabel(repoPath)}: ${message}`, 'error');
    }
  }

  private async handleCommit(): Promise<void> {
    if (!this.canCommit) return;

    // Claimed, not just observed: canCommit is also the Cmd+Enter gate, and a
    // lock taken between that check and this call would otherwise slip through.
    const repoPath = this.repositoryPath;
    if (!tryAcquireRefOpOrWarn(repoPath)) return;

    this.isCommitting = true;
    this.error = null;
    this.success = null;

    try {
      const message = this.buildCommitMessage();

      const result = await gitService.createCommit(repoPath, {
        message,
        amend: this.amend,
      });

      if (result.success) {
        this.saveToHistory(message);

        if (this.repositoryPath === repoPath) {
          this.success = `Created commit ${result.data?.shortId}`;
          this.summary = '';
          this.description = '';
          this.amend = false;
          this.lastCommit = null;
          this.originalSummary = '';
          this.originalDescription = '';

          // Clear success message after a delay
          setTimeout(() => {
            this.success = null;
          }, 3000);
        } else {
          // The user switched tabs while create_commit was out, so this
          // long-lived panel is bound to ANOTHER repo and willUpdate has
          // already swapped that repo's draft into the fields. Clearing them
          // here would wipe a draft that was never committed and hang our
          // success banner off the wrong repo. Retire the committed repo's
          // CACHED draft instead — willUpdate stashed the message we just
          // committed there — and name the repo in a toast, since the panel
          // is no longer showing it.
          this.draftCache.delete(repoPath);
          showToast(
            `Created commit ${result.data?.shortId} in ${this.repoLabel(repoPath)}`,
            'success'
          );
        }

        // Notify parent to refresh. The originating repo rides along so
        // forwarders can keep their own refresh pinned to it.
        this.dispatchEvent(new CustomEvent('commit-created', {
          detail: { commit: result.data, repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));

        // Trigger file status refresh immediately
        window.dispatchEvent(new CustomEvent('status-refresh'));

        // Trigger graph refresh and badge update. Names the repo the commit
        // ran IN — captured before the await. Without it the host falls back to
        // refreshing whichever tab is active, so a commit the user tabbed away
        // from would leave its own repo stale until the file watcher noticed.
        window.dispatchEvent(new CustomEvent('repository-refresh', { detail: { repoPath } }));
      } else if (!gitService.isNetworkGateRefusal(result.error)) {
        // A declined confirm — the pushed-amend warning, or the network gate —
        // is the user's own decision, already accounted for. Showing it in the
        // red error banner reports their click back to them as a failure.
        this.reportCommitFailure(repoPath, result.error?.message ?? 'Failed to create commit');
      }
    } catch (err) {
      this.reportCommitFailure(repoPath, err instanceof Error ? err.message : 'Unknown error');
    } finally {
      this.isCommitting = false;
      releaseRefOp(repoPath);
    }
  }

  render() {
    const summaryOverLimit = this.summary.length > this.SUMMARY_LIMIT;

    return html`
      <div class="header">
        <span>Commit</span>
        <span class="staged-count ${this.stagedCount > 0 ? 'has-staged' : ''}">
          ${this.stagedCount} staged ${this.stagedCount === 1 ? 'file' : 'files'}
        </span>
        <div class="header-actions">
          <button
            class="generate-btn ${this.aiAvailable ? 'ai-ready' : ''}"
            @click=${this.aiAvailable ? this.handleGenerateMessage : this.handleOpenSettings}
            ?disabled=${this.isGenerating || (this.aiAvailable && this.stagedCount === 0)}
            title=${this.aiAvailable
              ? (this.stagedCount === 0 ? 'Stage changes to generate a commit message' : 'Generate commit message using AI')
              : (this.aiUnavailableReason || (this.stagedCount > 0 ? 'Configure an AI provider in Settings' : 'Stage changes and configure AI to generate commit messages'))}
          >
            ${this.isGenerating ? html`
              <svg class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"></circle>
              </svg>
            ` : html`
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9.5 2l1 3.5L14 6.5l-3.5 1L9.5 11l-1-3.5L5 6.5l3.5-1z"/>
                <path d="M17 12l.75 2.25L20 15l-2.25.75L17 18l-.75-2.25L14 15l2.25-.75z"/>
                <path d="M6 16l.5 1.5L8 18l-1.5.5L6 20l-.5-1.5L4 18l1.5-.5z"/>
              </svg>
            `}
          </button>
          <button
            class="icon-btn"
            @click=${this.handleSaveTemplate}
            title="Save as template"
            ?disabled=${!this.summary.trim()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
              <polyline points="17 21 17 13 7 13 7 21"></polyline>
              <polyline points="7 3 7 8 15 8"></polyline>
            </svg>
          </button>
        </div>
      </div>

      ${this.templates.length > 0 ? html`
        <div class="template-row">
          <select
            class="template-select"
            .value=${this.selectedTemplateId}
            @change=${this.handleTemplateChange}
          >
            <option value="">Select template...</option>
            ${this.templates.map(t => html`
              <option value=${t.id}>${t.name}</option>
            `)}
          </select>
        </div>
      ` : nothing}

      ${this.aiAvailable && this.stagedCount > 0 ? html`
        <div class="ai-checks">
          <div class="check-buttons">
            <button
              class="check-btn"
              @click=${this.handleVibeCheck}
              ?disabled=${this.isAnalyzing}
              title="Check staged changes for secrets, complexity, and quality issues"
            >
              ${this.isAnalyzing ? 'Checking...' : html`<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm3.28 5.78l-4 4a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 1 1 1.06-1.06L6.75 8.19l3.47-3.47a.75.75 0 1 1 1.06 1.06z"/></svg> Vibe Check`}
            </button>
            <button
              class="check-btn"
              @click=${this.handleSuggestSplits}
              ?disabled=${this.isAnalyzingSplit}
              title="Check if staged changes should be split into separate commits"
            >
              ${this.isAnalyzingSplit ? 'Analyzing...' : html`<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.25a.25.25 0 0 1 .25-.25h5.5a.25.25 0 0 1 .25.25v5.5a.25.25 0 0 1-.25.25h-5.5a.25.25 0 0 1-.25-.25v-5.5zM5 11.75a.25.25 0 0 1 .25-.25h5.5a.25.25 0 0 1 .25.25v1.5a.25.25 0 0 1-.25.25h-5.5a.25.25 0 0 1-.25-.25v-1.5z"/></svg> Split Check`}
            </button>
          </div>

          ${this.vibeCheckResult ? html`
            <div class="vibe-result ${this.vibeCheckResult.riskLevel}">
              <div class="vibe-summary" @click=${() => { this.showVibeDetails = !this.showVibeDetails; }}>
                <span class="risk-badge ${this.vibeCheckResult.riskLevel}">${this.vibeCheckResult.riskLevel}</span>
                <span>${this.vibeCheckResult.summary}</span>
              </div>
              ${this.vibeCheckResult.aiAnalysisRan === false ? html`
                <div class="vibe-ai-warning" role="status">
                  AI analysis did not run, so only the secret scan was
                  performed${this.vibeCheckResult.aiError ? html`: ${this.vibeCheckResult.aiError}` : nothing}
                </div>
              ` : nothing}
              ${this.showVibeDetails && this.vibeCheckResult.findings.length > 0 ? html`
                <div class="findings-list">
                  ${this.vibeCheckResult.findings.map(f => html`
                    <div class="finding ${f.severity}">
                      <span class="finding-category">${f.category}</span>
                      <span class="finding-message">${f.message}</span>
                      ${f.filePath ? html`<span class="finding-file">${f.filePath}</span>` : nothing}
                    </div>
                  `)}
                </div>
              ` : nothing}
            </div>
          ` : nothing}

          ${this.splitSuggestion?.shouldSplit ? html`
            <div class="split-result">
              <div class="split-header" @click=${() => { this.showSplitDetails = !this.showSplitDetails; }}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.25a.25.25 0 0 1 .25-.25h5.5a.25.25 0 0 1 .25.25v5.5a.25.25 0 0 1-.25.25h-5.5a.25.25 0 0 1-.25-.25v-5.5z"/></svg>
                <span>Split into ${this.splitSuggestion.groups.length} commits recommended</span>
                <button class="dismiss-btn" @click=${(e: Event) => { e.stopPropagation(); this.splitSuggestion = null; }}>Dismiss</button>
              </div>
              ${this.showSplitDetails ? html`
                <div class="split-groups">
                  <div class="split-explanation">${this.splitSuggestion.explanation}</div>
                  ${this.splitSuggestion.groups.map(g => html`
                    <div class="split-group">
                      <div class="group-header">
                        <strong>${g.label}</strong>
                        <button class="stage-group-btn" @click=${() => this.handleStageGroup(g.files)}>Stage</button>
                      </div>
                      <div class="group-message">${g.suggestedMessage}</div>
                      <div class="group-files">${g.files.join(', ')}</div>
                    </div>
                  `)}
                </div>
              ` : nothing}
            </div>
          ` : nothing}
        </div>
      ` : nothing}

      ${this.generationError ? html`
        <div class="error">${this.generationError}</div>
      ` : nothing}

      ${this.conventionalMode ? html`
        <div class="conventional-row">
          <select
            class="type-select"
            .value=${this.selectedType}
            @change=${this.handleTypeChange}
          >
            ${this.conventionalTypes.map(t => html`
              <option value=${t.typeName} title=${t.description}>
                ${t.emoji ? `${t.emoji} ` : ''}${t.typeName}
              </option>
            `)}
          </select>
          <input
            type="text"
            class="scope-input"
            placeholder="scope (optional)"
            .value=${this.scope}
            @input=${this.handleScopeInput}
          />
        </div>
      ` : nothing}

      <div class="message-container">
        <textarea
          class="summary-input ${summaryOverLimit ? 'over-limit' : ''}"
          placeholder="${this.conventionalMode ? 'Description (required)' : 'Summary (required)'}"
          rows="1"
          .value=${this.summary}
          @input=${this.handleSummaryInput}
          @keydown=${this.handleKeyDown}
        ></textarea>

        <div class="summary-meta">
          <span class="char-count ${summaryOverLimit ? 'over-limit' : ''}">
            ${this.summary.length}/${this.SUMMARY_LIMIT}
          </span>
          <div class="history-wrapper">
            <button
              class="history-btn"
              @click=${this.handleHistoryToggle}
              title="Recent commit messages"
              ?disabled=${this.commitHistory.length === 0}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
            </button>
            ${this.showHistory ? html`
              <div class="history-dropdown">
                <div class="history-dropdown-header">
                  <span>Recent messages</span>
                  <button class="history-clear-btn" @click=${this.handleClearHistory}>Clear</button>
                </div>
                ${this.commitHistory.length > 0
                  ? this.commitHistory.map(
                      (msg) => html`
                        <button
                          class="history-item"
                          @click=${() => this.handleHistorySelect(msg)}
                          title=${msg}
                        >
                          ${msg.split('\n')[0]}
                        </button>
                      `
                    )
                  : html`<div class="history-empty">No recent messages</div>`}
              </div>
            ` : nothing}
          </div>
        </div>

        <textarea
          class="description-input"
          placeholder="Body (optional)"
          .value=${this.description}
          @input=${this.handleDescriptionInput}
          @keydown=${this.handleKeyDown}
        ></textarea>
      </div>

      <div class="options-row">
        <label class="amend-toggle">
          <input
            type="checkbox"
            .checked=${this.amend}
            @change=${this.handleAmendToggle}
          />
          Amend${this.amend && this.lastCommit ? ` (${this.lastCommit.shortId})` : ''}
        </label>

        <label class="conventional-toggle">
          <input
            type="checkbox"
            .checked=${this.conventionalMode}
            @change=${this.handleConventionalToggle}
          />
          Conventional
        </label>
      </div>

      ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
      ${this.success ? html`<div class="success">${this.success}</div>` : nothing}

      <div class="actions">
        <button
          class="commit-btn"
          ?disabled=${!this.canCommit}
          @click=${this.handleCommit}
          title="Commit staged changes (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          ${this.isCommitting ? 'Committing...' : 'Commit'}
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-commit-panel': LvCommitPanel;
  }
}
