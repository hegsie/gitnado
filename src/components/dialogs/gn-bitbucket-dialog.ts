/**
 * Bitbucket Integration Dialog
 * Manage Bitbucket connection, view PRs, issues, and pipelines
 */

import { html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { invokeCommand } from '../../services/tauri-api.ts';
import * as aiService from '../../services/ai.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { handleExternalLink } from '../../utils/index.ts';
import type {
  BitbucketConnectionStatus,
  DetectedBitbucketRepo,
  BitbucketPullRequest,
  BitbucketIssue,
  BitbucketPipeline,
  CreateBitbucketPullRequestInput,
  CreateBitbucketIssueInput,
} from '../../services/git.service.ts';
import * as oauthService from '../../services/oauth.service.ts';
import { getClientId, isOAuthConfigured } from '../../services/oauth.service.ts';
import type { OAuthFlowState, OAuthTokenResponse } from '../../types/oauth.types.ts';
import * as credentialService from '../../services/credential.service.ts';
import * as unifiedProfileService from '../../services/unified-profile.service.ts';
import { unifiedProfileStore, getAccountsByType, selectDefaultGlobalAccount, getAccountById, getActiveProfilePreferredAccount } from '../../stores/unified-profile.store.ts';
import type { IntegrationAccount } from '../../types/unified-profile.types.ts';
import { GnProviderDialogBase, type PrReviewComment } from './gn-provider-dialog-base.ts';
import './gn-modal.ts';
import './gn-account-selector.ts';

export type { PrReviewComment };

type TabType = 'connection' | 'pull-requests' | 'issues' | 'pipelines' | 'create-pr' | 'create-issue';

/**
 * Page sizes this dialog asks for when listing pull requests, issues and
 * pipelines. Each is passed straight into the listing call as `pagelen`, so the
 * number the request caps at and the number the "capped" hint discloses are the
 * same constant — never a literal at the call site or in commands/bitbucket.rs.
 */
const BITBUCKET_LIST_PAGE_SIZE = 30;
const BITBUCKET_PIPELINE_PAGE_SIZE = 20;

@customElement('gn-bitbucket-dialog')
export class GnBitbucketDialog extends GnProviderDialogBase<
  DetectedBitbucketRepo,
  BitbucketConnectionStatus,
  TabType
> {
  protected readonly providerDisplayName = 'Bitbucket';
  static styles = [
    sharedStyles,
    css`
      .content {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        min-height: 400px;
        max-height: 70vh;
      }

      .tabs {
        display: flex;
        gap: var(--spacing-xs);
        border-bottom: 1px solid var(--color-border);
        padding-bottom: var(--spacing-sm);
      }

      .tab {
        padding: var(--spacing-xs) var(--spacing-md);
        border: none;
        background: none;
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        cursor: pointer;
        border-radius: var(--radius-sm);
        transition: all var(--transition-fast);
      }

      .tab:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .tab.active {
        background: var(--color-primary-bg);
        color: var(--color-primary);
        font-weight: var(--font-weight-medium);
      }

      .tab-content {
        flex: 1;
        overflow: auto;
      }

      .connection-status {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        padding: var(--spacing-md);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
      }

      .avatar {
        width: 48px;
        height: 48px;
        border-radius: 50%;
      }

      .user-avatar-placeholder {
        width: 48px;
        height: 48px;
        border-radius: 50%;
        background: #0052cc;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-weight: var(--font-weight-semibold);
        font-size: var(--font-size-lg);
      }

      .user-info {
        flex: 1;
      }

      .user-name {
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
      }

      .user-login {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .token-form {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
      }

      .form-group {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .form-group label {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
      }

      .form-group input,
      .form-group textarea,
      .form-group select {
        padding: var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-secondary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
      }

      .form-group textarea {
        min-height: 100px;
        resize: vertical;
        font-family: inherit;
      }

      .form-group input:focus,
      .form-group textarea:focus,
      .form-group select:focus {
        outline: none;
        border-color: var(--color-primary);
      }

      .help-text {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .help-link {
        color: var(--color-primary);
        text-decoration: none;
      }

      .help-link:hover {
        text-decoration: underline;
      }

      .pr-list, .issue-list, .pipeline-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .pr-item, .issue-item {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-md);
        padding: var(--spacing-md);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: background var(--transition-fast);
      }

      .pr-item:hover, .issue-item:hover {
        background: var(--color-bg-hover);
      }

      .pr-card-wrapper {
        display: flex;
        flex-direction: column;
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        overflow: hidden;
      }

      .pr-card-wrapper .pr-item {
        border-radius: 0;
      }

      .pr-actions {
        display: flex;
        gap: var(--spacing-xs);
        align-items: center;
      }

      .pr-comments-drawer {
        border-top: 1px solid var(--color-border);
        padding: var(--spacing-md);
        background: var(--color-bg-secondary);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .pr-comments-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        max-height: 240px;
        overflow-y: auto;
      }

      .pr-comment-item {
        padding: var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-sm);
        border: 1px solid var(--color-border);
      }

      .pr-comment-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        margin-bottom: var(--spacing-xs);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .pr-comment-author {
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
      }

      .pr-comment-location {
        font-family: var(--font-family-mono);
        background: var(--color-bg-hover);
        color: var(--color-primary);
        padding: 1px 6px;
        border-radius: var(--radius-sm);
      }

      .pr-comment-body {
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
        white-space: pre-wrap;
        word-break: break-word;
      }

      .pr-comments-empty {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        padding: var(--spacing-xs) 0;
      }

      .pr-comment-form {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        margin-top: var(--spacing-xs);
      }

      .pr-comment-inline-fields {
        display: flex;
        gap: var(--spacing-xs);
      }

      .pr-comment-file-input {
        flex: 1;
        padding: 6px var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-xs);
        font-family: var(--font-family-mono);
      }

      .pr-comment-line-input {
        width: 90px;
        padding: 6px var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-xs);
        font-family: var(--font-family-mono);
      }

      .pr-comment-input-row {
        display: flex;
        gap: var(--spacing-xs);
        align-items: flex-end;
      }

      .pr-comment-body-input {
        flex: 1;
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        font-family: inherit;
        resize: vertical;
        min-height: 48px;
      }

      .pr-number, .issue-number {
        font-weight: var(--font-weight-semibold);
        color: var(--color-primary);
        min-width: 50px;
      }

      .pr-info, .issue-info {
        flex: 1;
        min-width: 0;
      }

      .pr-title, .issue-title {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        margin-bottom: var(--spacing-xs);
      }

      .pr-meta, .issue-meta {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-sm);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .pr-branch {
        display: flex;
        align-items: center;
        gap: 4px;
        font-family: var(--font-family-mono);
        background: var(--color-bg-hover);
        padding: 2px 6px;
        border-radius: var(--radius-sm);
      }

      .pr-state, .issue-state {
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
      }

      .pr-state.OPEN, .issue-state.open {
        background: var(--color-success-bg);
        color: var(--color-success);
      }

      .pr-state.MERGED {
        background: #8250df20;
        color: #8250df;
      }

      .pr-state.DECLINED, .issue-state.closed, .issue-state.resolved {
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      .issue-kind {
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: var(--font-size-xs);
        background: var(--color-bg-hover);
        color: var(--color-text-secondary);
      }

      .pipeline-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        padding: var(--spacing-md);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: background var(--transition-fast);
      }

      .pipeline-item:hover {
        background: var(--color-bg-hover);
      }

      .pipeline-status {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .pipeline-status.SUCCESSFUL {
        background: var(--color-success);
      }

      .pipeline-status.FAILED {
        background: var(--color-error);
      }

      .pipeline-status.IN_PROGRESS, .pipeline-status.PENDING {
        background: var(--color-warning);
        animation: pulse 2s infinite;
      }

      .pipeline-status.STOPPED {
        background: var(--color-text-muted);
      }

      .pipeline-info {
        flex: 1;
        min-width: 0;
      }

      .pipeline-name {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
      }

      .pipeline-meta {
        display: flex;
        gap: var(--spacing-sm);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .pipeline-branch {
        font-family: var(--font-family-mono);
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }

      .detected-repo {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-md);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        margin-bottom: var(--spacing-md);
      }

      .repo-icon {
        width: 20px;
        height: 20px;
        color: var(--color-primary);
      }

      .repo-name {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
      }

      .repo-remote {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .filter-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--spacing-md);
      }

      .filter-select {
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-secondary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
      }

      .btn-row {
        display: flex;
        gap: var(--spacing-sm);
        justify-content: flex-end;
      }

      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xl);
        color: var(--color-text-muted);
        text-align: center;
      }

      .empty-state svg {
        width: 48px;
        height: 48px;
        margin-bottom: var(--spacing-md);
        opacity: 0.5;
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xl);
        color: var(--color-text-muted);
      }

      .error {
        padding: var(--spacing-md);
        background: var(--color-error-bg);
        color: var(--color-error);
        border-radius: var(--radius-md);
        font-size: var(--font-size-sm);
      }

      .checkbox-group {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .checkbox-group input[type="checkbox"] {
        width: 16px;
        height: 16px;
      }

      /* OAuth styles */
      .auth-method-toggle {
        display: flex;
        gap: var(--spacing-sm);
        margin-bottom: var(--spacing-md);
      }

      .auth-method-toggle .btn {
        flex: 1;
        justify-content: center;
      }

      .auth-method-toggle .btn.active {
        background: var(--color-primary);
        border-color: var(--color-primary);
        color: white;
      }

      .btn {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: var(--spacing-sm) var(--spacing-md);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-secondary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .btn:hover {
        background: var(--color-bg-hover);
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-primary {
        background: var(--color-primary);
        border-color: var(--color-primary);
        color: white;
      }

      .btn-primary:hover:not(:disabled) {
        background: var(--color-primary-hover);
      }

      .btn-danger {
        color: var(--color-error);
        border-color: var(--color-error);
      }

      .btn-danger:hover:not(:disabled) {
        background: var(--color-error-bg);
      }

      .btn-danger-outline {
        background: transparent;
        color: var(--color-error);
        border-color: var(--color-error);
      }

      .btn-danger-outline:hover:not(:disabled) {
        background: var(--color-error);
        color: white;
      }

      .connection-actions {
        display: flex;
        gap: var(--spacing-sm);
        margin-left: auto;
      }

      .btn-oauth {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--spacing-sm);
        width: 100%;
        padding: var(--spacing-md);
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        color: var(--color-text-primary);
        font-size: var(--font-size-md);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .btn-oauth:hover:not(:disabled) {
        background: var(--color-bg-hover);
        border-color: var(--color-primary);
      }

      .btn-oauth:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .btn-oauth svg {
        width: 20px;
        height: 20px;
      }

      .oauth-cancel {
        width: 100%;
        justify-content: center;
        margin-top: var(--spacing-sm);
      }

      .oauth-spinner {
        width: 20px;
        height: 20px;
        border: 2px solid var(--color-border);
        border-top-color: var(--color-primary);
        border-radius: 50%;
        animation: oauth-spin 0.8s linear infinite;
      }

      @keyframes oauth-spin {
        to { transform: rotate(360deg); }
      }

      .oauth-status {
        text-align: center;
        padding: var(--spacing-md);
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
      }

      .oauth-status.error {
        color: var(--color-error);
      }

      .oauth-divider {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        margin: var(--spacing-md) 0;
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }

      .oauth-divider::before,
      .oauth-divider::after {
        content: '';
        flex: 1;
        height: 1px;
        background: var(--color-border);
      }
    `,
  ];

  /**
   * Show a back arrow instead of a close ×. Set explicitly by the host ONLY when
   * this dialog was opened with a return target (the profile manager).
   */
  @property({ type: Boolean }) backButton = false;
  /** Profile name for the "Adding to <name>" breadcrumb; empty when standalone. */
  @property({ type: String }) attachToProfileName = '';

  @state() private pullRequests: BitbucketPullRequest[] = [];
  @state() private issues: BitbucketIssue[] = [];
  @state() private pipelines: BitbucketPipeline[] = [];
  @state() private usernameInput = '';
  @state() private appPasswordInput = '';
  @state() private prFilter: 'OPEN' | 'MERGED' | 'DECLINED' = 'OPEN';

  // OAuth state
  @state() private authMethod: 'oauth' | 'app-password' = 'oauth';
  @state() private oauthState: OAuthFlowState = { status: 'idle' };
  @state() private oauthToken: string | null = null;

  private oauthCompleteHandler?: EventListener;
  private oauthStateUnsubscribe?: () => void;
  // The account the in-flight OAuth flow targets, pinned when the flow STARTS.
  // The browser round-trip is async, so `selectedAccountId` may point at a
  // different account by the time `oauth-complete` lands — writing the new token
  // there would route it onto the wrong account.
  private oauthTargetAccountId: string | null | undefined;
  private oauthTargetWasAddingAccount: boolean | undefined;

  // Create PR form
  @state() private createPrTitle = '';
  @state() private createPrDescription = '';
  @state() private createPrSource = '';
  @state() private createPrDestination = '';
  @state() private createPrCloseSource = false;
  @state() private generatingPrDescription = false;

  // Create Issue form
  @state() private createIssueTitle = '';
  @state() private createIssueContent = '';

  connectedCallback(): void {
    super.connectedCallback();

    // Set up OAuth event listeners
    this.oauthCompleteHandler = ((e: CustomEvent<{ provider: string; tokens: OAuthTokenResponse }>) => {
      if (e.detail.provider === 'bitbucket') {
        this.handleOAuthComplete(e.detail.tokens);
      }
    }) as unknown as EventListener;
    window.addEventListener('oauth-complete', this.oauthCompleteHandler);

    this.oauthStateUnsubscribe = oauthService.onOAuthStateChange((state) => {
      if (state.provider === 'bitbucket') {
        this.oauthState = state;
        // A failed/denied sign-in clears the pending spinner — surface the error
        // so the user isn't left with no feedback (matches the other providers).
        if (state.status === 'error') {
          this.error = state.error ?? 'Bitbucket sign-in failed';
          showToast(this.error, 'error');
          // The flow is over and can no longer emit `oauth-complete`, so release
          // the pinned target — otherwise a later completion would be attributed
          // to whichever account was selected when this failed flow started.
          this.oauthTargetAccountId = undefined;
          this.oauthTargetWasAddingAccount = undefined;
        }
      }
    });

    // Subscribe to unified profile store. When the active profile changes,
    // re-derive the preferred account so a profile switch is reflected here.
    let lastActiveProfileId = unifiedProfileStore.getState().activeProfile?.id ?? null;
    this.unsubscribeStore = unifiedProfileStore.subscribe((state) => {
      this.syncBitbucketAccounts();
      if (this.selectedAccountId && !this.accounts.some(a => a.id === this.selectedAccountId)) {
        this.selectedAccountId = null;
      }
      const activeProfileId = state.activeProfile?.id ?? null;
      if (activeProfileId !== lastActiveProfileId) {
        // Track the id either way so this doesn't re-fire, but DON'T clobber a
        // half-completed "Add account" flow (a background store emit must not
        // re-select an existing account, or the next save overwrites it).
        lastActiveProfileId = activeProfileId;
        if (!this.isAddingAccount) {
          const preferred = getActiveProfilePreferredAccount('bitbucket') ?? this.accounts[0];
          this.selectedAccountId = preferred?.id ?? null;
        }
      } else if (!this.isAddingAccount && !this.selectedAccountId && this.accounts.length > 0) {
        const preferred = getActiveProfilePreferredAccount('bitbucket')
          ?? selectDefaultGlobalAccount('bitbucket')
          ?? this.accounts[0];
        this.selectedAccountId = preferred?.id ?? null;
      }
    });

    // Initialize from current state
    this.syncBitbucketAccounts();
    if (this.accounts.length > 0 && !this.selectedAccountId) {
      const preferred = getActiveProfilePreferredAccount('bitbucket')
        ?? selectDefaultGlobalAccount('bitbucket')
        ?? this.accounts[0];
      this.selectedAccountId = preferred?.id ?? null;
    }

    // loadInitialData() is intentionally NOT called here — updated() runs it on
    // the initial 'open' change. Calling it in both places double-loaded and
    // caused render churn (the auth-method toggle/form detaching mid-interaction).
  }

  /**
   * Update `accounts` only when the bitbucket account set actually changed, so a
   * spurious store emit doesn't replace the array reference and force a needless
   * re-render (a source of the open-load render churn).
   */
  private syncBitbucketAccounts(): void {
    const next = getAccountsByType('bitbucket');
    if (
      next.length !== this.accounts.length ||
      next.some((a, i) => {
        const prev = this.accounts[i];
        if (!prev || a.id !== prev.id || a.name !== prev.name || a.isDefault !== prev.isDefault) {
          return true;
        }
        const nextWs = a.config.type === 'bitbucket' ? a.config.workspace : undefined;
        const prevWs = prev.config.type === 'bitbucket' ? prev.config.workspace : undefined;
        return nextWs !== prevWs || a.cachedUser?.username !== prev.cachedUser?.username;
      })
    ) {
      this.accounts = next;
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();

    // Clean up OAuth listeners
    if (this.oauthCompleteHandler) {
      window.removeEventListener('oauth-complete', this.oauthCompleteHandler);
    }
    this.oauthStateUnsubscribe?.();
    this.unsubscribeStore?.();
  }

  protected override onBeforeOpen(): void {
    this.removeAttribute('data-ready');
  }

  protected resetProviderRepoScopedState(): void {
    this.createPrTitle = '';
    this.createPrDescription = '';
    this.createPrSource = '';
    this.createPrDestination = '';
    this.createPrCloseSource = false;
    this.generatingPrDescription = false;
    this.createIssueTitle = '';
    this.createIssueContent = '';
    this.pullRequests = [];
    this.issues = [];
    this.pipelines = [];
  }

  protected async loadInitialData(): Promise<void> {
    const generation = ++this.loadGeneration;
    const autoSelectAccount = !this.selectedAccountId && !this.isAddingAccount;
    this.initInFlight = true;
    this.isLoading = true;
    this.error = null;

    try {
      // Ensure unified profiles are loaded
      await unifiedProfileService.loadUnifiedProfiles();
      if (generation !== this.loadGeneration) return;

      // Load the profile for this repository to set activeProfile
      if (this.repositoryPath) {
        await unifiedProfileService.loadUnifiedProfileForRepository(this.repositoryPath);
        if (generation !== this.loadGeneration) return;
      }

      // Re-sync local state with store after loading. Auto-derive only when
      // nothing is selected (fresh open clears selectedAccountId in updated()).
      // Manual switches set selectedAccountId before calling loadInitialData()
      // and must not be overwritten.
      this.syncBitbucketAccounts();
      if (this.accounts.length > 0 && autoSelectAccount && !this.selectedAccountId && !this.isAddingAccount) {
        const preferred = getActiveProfilePreferredAccount('bitbucket')
          ?? selectDefaultGlobalAccount('bitbucket');
        this.selectedAccountId = preferred?.id ?? this.accounts[0]?.id ?? null;
      }

      if (!this.isAddingAccount) {
        // Load OAuth token for selected account
        if (this.selectedAccountId) {
          const token = await this.getSelectedAccountToken();
          if (generation !== this.loadGeneration) return;
          if (token) {
            this.oauthToken = token;
          }
        }

        await this.checkConnection();
        if (generation !== this.loadGeneration) return;
      }

      if (this.repositoryPath) {
        await this.detectRepo(true, autoSelectAccount);
        if (generation !== this.loadGeneration) return;
      }
    } catch (err) {
      if (generation !== this.loadGeneration) return;
      this.error = err instanceof Error ? err.message : 'Failed to load data';
    } finally {
      if (generation === this.loadGeneration) {
        this.initInFlight = false;
        this.isLoading = false;
        this.isDetectingRepo = false;
        // Signal that the open-load has settled and the DOM is now stable.
        this.setAttribute('data-ready', '');
      }
    }
  }

  /**
   * Mirror a verified connection result into the shared unified-profile store so
   * other views (e.g. the profile manager's status dots) reflect it immediately.
   */
  private syncSharedConnectionStatus(connected: boolean): void {
    if (this.selectedAccountId) {
      unifiedProfileStore
        .getState()
        .setAccountConnectionStatus(this.selectedAccountId, connected ? 'connected' : 'disconnected');
    }
  }

  private async checkConnection(providedToken?: string | null): Promise<void> {
    const generation = this.loadGeneration;
    const accountId = this.selectedAccountId;
    const isCurrent = () =>
      generation === this.loadGeneration &&
      this.selectedAccountId === accountId;
    // Verify the caller's token when it supplied one (e.g. a just-entered app
    // password that isn't persisted yet); otherwise re-read the selected
    // account's credential, refreshing an expiring OAuth token first.
    const token = providedToken ?? await this.getActiveToken();
    if (!isCurrent()) return;

    if (token) {
      // Use OAuth token to check connection
      const result = await gitService.checkBitbucketConnectionWithToken(token);
      if (!isCurrent()) return;
      if (result.success && result.data?.connected) {
        this.connectionStatus = result.data;
        this.syncSharedConnectionStatus(result.data.connected);
        this.oauthToken = token;

        // Update cached user in global account if connected
        if (this.selectedAccountId && result.data.user) {
          await unifiedProfileService.updateGlobalAccountCachedUser(this.selectedAccountId, {
            username: result.data.user.username,
            displayName: result.data.user.displayName ?? null,
            email: null,
            avatarUrl: result.data.user.avatarUrl ?? null,
          });
        }
      } else if (await this.tryMigrateLegacyAppPassword(token)) {
        // Migration succeeded — connection state was set inside the helper.
      } else {
        if (!isCurrent()) return;
        // Failed check must mark the account as disconnected so dependent UI
        // surfaces (toolbar, selector dot) don't keep a stale connected state.
        this.connectionStatus = { connected: false, user: null };
        this.syncSharedConnectionStatus(false);
      }
    } else {
      // Fall back to legacy credential check
      const result = await gitService.checkBitbucketConnection();
      if (!isCurrent()) return;
      if (result.success && result.data) {
        this.connectionStatus = result.data;
      } else {
        this.connectionStatus = { connected: false, user: null };
        this.syncSharedConnectionStatus(false);
      }
    }
  }

  /**
   * Migrate a legacy Bitbucket app-password credential that was stored as a RAW
   * app password (before the `bbapp:` prefix fix). The backend now sends
   * unprefixed tokens as Bearer, so those accounts fail the with_token check and
   * appear permanently disconnected. When the raw token fails, retry the check
   * with the properly-prefixed `bbapp:<username>:<token>` form; on success,
   * re-store the prefixed credential and adopt it so future calls use Basic auth.
   *
   * OAuth access tokens legitimately use Bearer, so this only ever runs AFTER a
   * failed check and never rewrites a token that already connected.
   *
   * @returns true if migration succeeded and connection state was set.
   */
  private async tryMigrateLegacyAppPassword(token: string): Promise<boolean> {
    // Already prefixed (or OAuth) tokens don't need migration.
    if (token.startsWith(credentialService.BITBUCKET_APP_PASSWORD_PREFIX)) {
      return false;
    }
    if (!this.selectedAccountId) return false;

    const generation = this.loadGeneration;
    const accountId = this.selectedAccountId;
    const account = getAccountById(accountId);
    const username = account?.cachedUser?.username;
    if (!username) return false;

    const prefixed = credentialService.formatBitbucketAppPasswordCredential(username, token);
    const retry = await gitService.checkBitbucketConnectionWithToken(prefixed);
    if (!retry.success || !retry.data?.connected) {
      return false;
    }

    // Persist the migrated credential and adopt it for this session.
    await credentialService.storeAccountToken('bitbucket', accountId, prefixed);
    if (
      generation !== this.loadGeneration ||
      this.selectedAccountId !== accountId
    ) {
      return true;
    }
    this.oauthToken = prefixed;
    this.connectionStatus = retry.data;
    this.syncSharedConnectionStatus(true);

    if (retry.data.user) {
      await unifiedProfileService.updateGlobalAccountCachedUser(accountId, {
        username: retry.data.user.username,
        displayName: retry.data.user.displayName ?? null,
        email: null,
        avatarUrl: retry.data.user.avatarUrl ?? null,
      });
    }

    return true;
  }

  /**
   * Get the token for the currently selected account, refreshing an expiring
   * OAuth access token first (Bitbucket OAuth access tokens last ~2h, so
   * without this a signed-in account reads as disconnected on the next open).
   * App-password credentials (`bbapp:` prefixed) have no OAuth bundle and are
   * returned unchanged.
   */
  private async getSelectedAccountToken(): Promise<string | null> {
    if (this.selectedAccountId) {
      return credentialService.getFreshAccountToken(
        'bitbucket',
        this.selectedAccountId,
        'bitbucket'
      );
    }
    return null;
  }

  /**
   * Token for an API call: the selected account's credential, re-read (and
   * refreshed when near expiry) on every call so a long-open dialog never keeps
   * using a token that expired while it was open. Falls back to the token this
   * session's sign-in captured when no account-backed credential exists yet.
   */
  private async getActiveToken(expectedAccountId = this.selectedAccountId): Promise<string | null> {
    if (expectedAccountId) {
      const token = await credentialService.getFreshAccountToken(
        'bitbucket',
        expectedAccountId,
        'bitbucket'
      );
      if (this.selectedAccountId !== expectedAccountId) return null;
      if (token) {
        this.oauthToken = token;
        return token;
      }
      return this.oauthToken;
    }
    return this.oauthToken;
  }

  private normalizeWorkspace(workspace?: string | null): string {
    return (workspace ?? '').trim().toLowerCase();
  }

  /**
   * Handle account selection change
   */
  private async handleAccountChange(e: CustomEvent<{ account: IntegrationAccount }>): Promise<void> {
    const { account } = e.detail;
    // The user explicitly selected an existing account — re-enable the
    // subscription's auto-apply branch.
    this.beginAccountSwitch(account.id);
    this.oauthToken = null;
    this.usernameInput = '';
    this.appPasswordInput = '';

    // Re-check connection with new account
    await this.loadInitialData();
  }

  /**
   * Handle add account request
   */
  private handleAddAccount(): void {
    // Clear selection so the next save creates a new account instead of
    // overwriting the previously-selected account's credentials.
    this.beginAddAccount();
    // Clear any token from the previously-selected account so a verification of
    // the new account can't succeed against the old identity's credentials.
    this.oauthToken = null;
    this.usernameInput = '';
    this.appPasswordInput = '';
  }

  /**
   * Handle manage accounts request
   */
  private handleManageAccounts(e: Event): void {
    // Consume the account-selector's bubbling/composed event so it can't ALSO
    // reach the host — otherwise the host would receive both it and our re-dispatch
    // below, firing its handler twice (the second pass corrupts reversible-Back state).
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent('manage-accounts', {
        detail: { integrationType: 'bitbucket' },
        bubbles: true,
        composed: true,
      })
    );
  }

  protected async detectRepo(loadData = true, allowAccountSwitch = true): Promise<void> {
    if (!this.repositoryPath) {
      this.detectGeneration++;
      this.isDetectingRepo = false;
      return;
    }

    // The dialog outlives the repository -- it stays open when the last tab
    // closes -- so a detect issued for one path can resolve after the path has
    // changed. Dropping the stale result stops the closed (or previously
    // selected) repository from being re-detected and re-loaded over the
    // current one.
    const requestedPath = this.repositoryPath;
    const repoGen = this.repoGeneration;
    const detectGen = ++this.detectGeneration;
    this.detectedRepo = null;
    this.isDetectingRepo = true;
    try {
      const result = await gitService.detectBitbucketRepo(requestedPath);
      if (
        this.repositoryPath !== requestedPath ||
        this.repoGeneration !== repoGen ||
        this.detectGeneration !== detectGen
      ) {
        return;
      }
      this.isDetectingRepo = false;
      if (result.success && result.data) {
        this.detectedRepo = result.data;
        if (loadData && !this.isAddingAccount) {
          const detectedNorm = this.normalizeWorkspace(result.data.workspace);
          let accountChanged = false;
          if (allowAccountSwitch && this.accounts.length > 0 && detectedNorm) {
            const currentAccount = this.selectedAccountId
              ? (getAccountById(this.selectedAccountId) ??
                this.accounts.find((a) => a.id === this.selectedAccountId))
              : undefined;
            const currentNorm =
              currentAccount?.config.type === 'bitbucket'
                ? this.normalizeWorkspace(currentAccount.config.workspace)
                : '';
            if (!currentAccount || currentNorm !== detectedNorm) {
              const exactWorkspaceAccount = this.accounts.find(
                (a) =>
                  a.config.type === 'bitbucket' &&
                  Boolean(this.normalizeWorkspace(a.config.workspace)) &&
                  this.normalizeWorkspace(a.config.workspace) === detectedNorm
              );
              const fallbackUnscopedAccount = currentNorm
                ? this.accounts.find(
                    (a) =>
                      a.config.type === 'bitbucket' &&
                      !this.normalizeWorkspace(a.config.workspace)
                  )
                : currentAccount;
              const nextAccount = exactWorkspaceAccount ?? fallbackUnscopedAccount ?? currentAccount;
              const nextAccountId = nextAccount?.id ?? null;
              if (this.selectedAccountId !== nextAccountId) {
                this.selectedAccountId = nextAccountId;
                this.connectionStatus = null;
                this.oauthToken = null;
                accountChanged = true;
              }
            }
          }
          if (accountChanged) {
            await this.checkConnection();
            if (
              this.repositoryPath !== requestedPath ||
              this.repoGeneration !== repoGen ||
              this.detectGeneration !== detectGen
            ) {
              return;
            }
          }
          if (this.connectionStatus?.connected) {
            await this.loadAllData();
          }
        }
      } else {
        this.detectedRepo = null;
        if (!result.success) {
          // A genuine backend failure (not merely "this isn't a Bitbucket repo",
          // which surfaces as success with null data) must not fail silently.
          this.error = result.error?.message ?? 'Failed to detect Bitbucket repository';
        }
      }
    } finally {
      if (this.detectGeneration === detectGen) {
        this.isDetectingRepo = false;
      }
    }
  }

  private async loadAllData(): Promise<void> {
    await Promise.all([
      this.loadPullRequests(),
      this.loadIssues(),
      this.loadPipelines(),
    ]);
  }

  private async loadPullRequests(): Promise<void> {
    if (!this.detectedRepo || !this.connectionStatus?.connected) return;

    const targetRepoPath = this.repositoryPath;
    const targetDetectedRepo = this.detectedRepo;
    const targetAccountId = this.selectedAccountId;
    this.isLoading = true;
    this.error = null;

    try {
      const token = await this.getActiveToken(targetAccountId);
      const result = await gitService.listBitbucketPullRequests(
        targetDetectedRepo.workspace,
        targetDetectedRepo.repoSlug,
        this.prFilter,
        BITBUCKET_LIST_PAGE_SIZE,
        token
      );
      if (
        this.repositoryPath !== targetRepoPath ||
        this.detectedRepo !== targetDetectedRepo ||
        this.selectedAccountId !== targetAccountId
      ) {
        return;
      }

      if (result.success && result.data) {
        this.pullRequests = result.data;
      } else {
        this.error = result.error?.message ?? 'Failed to load pull requests';
      }
    } catch (err) {
      if (
        this.repositoryPath !== targetRepoPath ||
        this.detectedRepo !== targetDetectedRepo ||
        this.selectedAccountId !== targetAccountId
      ) {
        return;
      }
      this.error = err instanceof Error ? err.message : 'Failed to load pull requests';
    } finally {
      if (
        this.repositoryPath === targetRepoPath &&
        this.detectedRepo === targetDetectedRepo &&
        this.selectedAccountId === targetAccountId
      ) {
        this.isLoading = false;
      }
    }
  }

  protected getCommentsOutboundHost(): string {
    return 'api.bitbucket.org';
  }

  protected async getTokenForComments(
    targetAccountId: string | null,
  ): Promise<string | null | undefined> {
    return this.getActiveToken(targetAccountId);
  }

  protected fetchPrComments(
    detectedRepo: DetectedBitbucketRepo,
    prId: number,
    token: string | null | undefined,
  ) {
    return invokeCommand<PrReviewComment[]>('get_bitbucket_pr_comments', {
      workspace: detectedRepo.workspace,
      repoSlug: detectedRepo.repoSlug,
      prId,
      token,
    });
  }

  protected postPrComment(
    detectedRepo: DetectedBitbucketRepo,
    prId: number,
    body: string,
    filePath: string | undefined,
    line: number | undefined,
    _commitId: string | undefined,
    token: string | null | undefined,
  ) {
    return invokeCommand<PrReviewComment>('add_bitbucket_pr_comment', {
      workspace: detectedRepo.workspace,
      repoSlug: detectedRepo.repoSlug,
      prId,
      content: body,
      filePath,
      line,
      token,
    });
  }

  private async loadIssues(): Promise<void> {
    if (!this.detectedRepo || !this.connectionStatus?.connected) return;

    const targetRepoPath = this.repositoryPath;
    const targetDetectedRepo = this.detectedRepo;
    const targetAccountId = this.selectedAccountId;

    try {
      const token = await this.getActiveToken(targetAccountId);
      const result = await gitService.listBitbucketIssues(
        targetDetectedRepo.workspace,
        targetDetectedRepo.repoSlug,
        undefined,
        BITBUCKET_LIST_PAGE_SIZE,
        token
      );
      if (
        this.repositoryPath !== targetRepoPath ||
        this.detectedRepo !== targetDetectedRepo ||
        this.selectedAccountId !== targetAccountId
      ) {
        return;
      }

      if (result.success && result.data) {
        this.issues = result.data;
      } else if (!result.success) {
        // The backend returns an empty list when issues are disabled (404); a
        // non-404 error (bad token/server) is surfaced rather than swallowed.
        this.error = result.error?.message ?? 'Failed to load issues';
      }
    } catch (err) {
      if (
        this.repositoryPath !== targetRepoPath ||
        this.detectedRepo !== targetDetectedRepo ||
        this.selectedAccountId !== targetAccountId
      ) {
        return;
      }
      this.error = err instanceof Error ? err.message : 'Failed to load issues';
    }
  }

  private async loadPipelines(): Promise<void> {
    if (!this.detectedRepo || !this.connectionStatus?.connected) return;

    const targetRepoPath = this.repositoryPath;
    const targetDetectedRepo = this.detectedRepo;
    const targetAccountId = this.selectedAccountId;

    try {
      const token = await this.getActiveToken(targetAccountId);
      const result = await gitService.listBitbucketPipelines(
        targetDetectedRepo.workspace,
        targetDetectedRepo.repoSlug,
        BITBUCKET_PIPELINE_PAGE_SIZE,
        token
      );
      if (
        this.repositoryPath !== targetRepoPath ||
        this.detectedRepo !== targetDetectedRepo ||
        this.selectedAccountId !== targetAccountId
      ) {
        return;
      }

      if (result.success && result.data) {
        this.pipelines = result.data;
      } else if (!result.success) {
        this.error = result.error?.message ?? 'Failed to load pipelines';
      }
    } catch (err) {
      if (
        this.repositoryPath !== targetRepoPath ||
        this.detectedRepo !== targetDetectedRepo ||
        this.selectedAccountId !== targetAccountId
      ) {
        return;
      }
      this.error = err instanceof Error ? err.message : 'Failed to load pipelines';
    }
  }

  private async handleSaveCredentials(): Promise<void> {
    if (!this.usernameInput.trim() || !this.appPasswordInput.trim()) return;

    const generation = this.beginAccountOp();
    const usernameToSave = this.usernameInput.trim();
    const appPasswordToSave = this.appPasswordInput.trim();
    const targetAccountId = this.selectedAccountId;
    const targetWasAddingAccount = this.isAddingAccount;
    const targetDetectedWorkspace = this.detectedRepo?.workspace;

    try {
      const storeResult = await gitService.storeBitbucketCredentials(
        usernameToSave,
        appPasswordToSave
      );
      if (!storeResult.success) {
        if (generation === this.loadGeneration) {
          this.error = storeResult.error?.message ?? 'Failed to save credentials';
        }
        return;
      }

      // App passwords authenticate via HTTP Basic auth, not Bearer. Build the
      // prefixed credential and use it as the active token so the connection
      // check AND every subsequent API call (PRs/issues/pipelines/create) route
      // through Basic auth — both this session and on every reopen (where the
      // stored per-account token is what drives checkConnection).
      const appPasswordCredential = credentialService.formatBitbucketAppPasswordCredential(
        usernameToSave,
        appPasswordToSave
      );

      // Verify the JUST-ENTERED credential directly so an account switch mid-flight
      // cannot substitute another account's connectionStatus.
      const verifyResult = await gitService.checkBitbucketConnectionWithToken(appPasswordCredential);

      if (verifyResult.success && verifyResult.data?.connected) {
        const user = verifyResult.data.user;
        const workspace = targetDetectedWorkspace || usernameToSave;
        const selectedAccount = targetAccountId
          ? (getAccountById(targetAccountId) ??
            this.accounts.find((a) => a.id === targetAccountId))
          : undefined;
        const selectedAccountWorkspace =
          selectedAccount?.config.type === 'bitbucket'
            ? selectedAccount.config.workspace
            : undefined;
        const canUpdateSelectedAccount =
          Boolean(targetAccountId) &&
          !targetWasAddingAccount &&
          (!selectedAccountWorkspace ||
            !targetDetectedWorkspace ||
            this.normalizeWorkspace(selectedAccountWorkspace) ===
              this.normalizeWorkspace(targetDetectedWorkspace));

        let connectedAccountId: string;

        // Create or update a global account for app-password connections
        if (targetAccountId && canUpdateSelectedAccount) {
          await credentialService.storeAccountToken('bitbucket', targetAccountId, appPasswordCredential);
          // Refresh cachedUser so the profile manager shows the up-to-date
          // avatar/username immediately instead of waiting for background validation.
          if (user) {
            await unifiedProfileService.updateGlobalAccountCachedUser(targetAccountId, {
              username: user.username,
              displayName: user.displayName ?? null,
              email: null,
              avatarUrl: user.avatarUrl ?? null,
            });
          }
          connectedAccountId = targetAccountId;
        } else {
          const { createEmptyIntegrationAccount, generateId } = await import('../../types/unified-profile.types.ts');
          const newAccount: IntegrationAccount = {
            ...createEmptyIntegrationAccount('bitbucket', workspace),
            id: generateId(),
            name: user?.username ? `Bitbucket (${user.username})` : `Bitbucket (${usernameToSave})`,
            isDefault: this.accounts.length === 0,
            cachedUser: user ? {
              username: user.username,
              displayName: user.displayName ?? null,
              email: null,
              avatarUrl: user.avatarUrl ?? null,
            } : null,
          };

          const savedAccount = await unifiedProfileService.saveGlobalAccount(newAccount);
          await credentialService.storeAccountToken('bitbucket', savedAccount.id, appPasswordCredential);
          connectedAccountId = savedAccount.id;
          if (
            this.selectedAccountId === targetAccountId &&
            this.isAddingAccount === targetWasAddingAccount
          ) {
            this.selectedAccountId = savedAccount.id;
            // The new account now exists and is selected — the add flow is complete.
            this.isAddingAccount = false;
          }

          // Refresh accounts list
          await unifiedProfileService.loadUnifiedProfiles();
          this.syncBitbucketAccounts();
        }

        unifiedProfileStore
          .getState()
          .setAccountConnectionStatus(connectedAccountId, 'connected');
        if (this.usernameInput.trim() === usernameToSave) {
          this.usernameInput = '';
        }
        if (this.appPasswordInput.trim() === appPasswordToSave) {
          this.appPasswordInput = '';
        }
        if (generation !== this.loadGeneration || this.selectedAccountId !== connectedAccountId) return;
        this.oauthToken = appPasswordCredential;
        this.connectionStatus = verifyResult.data;
        if (this.repositoryPath && !this.detectedRepo) {
          await this.detectRepo(false, false);
          if (generation !== this.loadGeneration || this.selectedAccountId !== connectedAccountId) return;
        }
        if (this.detectedRepo) {
          await this.loadAllData();
        }
      } else if (generation === this.loadGeneration) {
        if (this.selectedAccountId === targetAccountId) {
          this.connectionStatus = { connected: false, user: null };
        }
        if (targetAccountId) {
          unifiedProfileStore
            .getState()
            .setAccountConnectionStatus(targetAccountId, 'disconnected');
        }
        this.error = 'Failed to connect. Please check your credentials.';
      }
    } catch (err) {
      if (generation !== this.loadGeneration) return;
      this.error = err instanceof Error ? err.message : 'Failed to connect';
    } finally {
      this.finishAccountOp(generation);
    }
  }

  private async handleDisconnect(): Promise<void> {
    const targetAccountId = this.selectedAccountId;

    await this.runDisconnectOperation(
      async () => {
        if (targetAccountId) {
          await credentialService.deleteAccountToken('bitbucket', targetAccountId);
        }
        await gitService.deleteBitbucketCredentials();
      },
      () => {
        this.oauthToken = null;
        this.pullRequests = [];
        this.issues = [];
        this.pipelines = [];
      },
    );
  }

  private async handleDeleteIntegration(): Promise<void> {
    const accountId = this.selectedAccountId;
    const account = accountId
      ? (this.accounts.find((a) => a.id === accountId) ??
        ({ id: accountId, name: 'this account' } as IntegrationAccount))
      : undefined;

    await this.runDeleteIntegrationOperation({
      account,
      providerLabel: 'Bitbucket',
      deleteCredentials: async (target) => {
        await credentialService.deleteAccountToken('bitbucket', target.id);
      },
      getRemainingAccounts: () => {
        this.syncBitbucketAccounts();
        return this.accounts;
      },
      onDeleted: async (nextAccountId) => {
        this.oauthToken = null;
        this.pullRequests = [];
        this.issues = [];
        this.pipelines = [];

        if (nextAccountId) {
          await this.loadInitialData();
        }
      },
    });
  }

  /**
   * Start OAuth flow for Bitbucket
   */
  private async handleStartOAuth(): Promise<void> {
    const clientId = getClientId('bitbucket');
    if (!clientId) {
      this.error = 'Bitbucket OAuth is not configured. Please use an App Password.';
      this.authMethod = 'app-password';
      return;
    }

    this.error = null;
    this.oauthTargetAccountId = this.selectedAccountId;
    this.oauthTargetWasAddingAccount = this.isAddingAccount;
    // `startOAuth` never rejects — it reports failure through the OAuth state
    // subscriber — so the pinned target is cleared there, not here.
    await oauthService.startOAuth('bitbucket', clientId);
  }

  /**
   * Abandon a sign-in that is waiting on the browser. This also releases the
   * backend loopback server, so a retry can re-bind Bitbucket's fixed callback
   * port instead of failing until the flow times out. The local state is set
   * explicitly rather than relying on the service's notification, so the form
   * can never stay stuck if there is no pending entry to cancel.
   */
  private handleCancelOAuth(): void {
    oauthService.cancelOAuth('bitbucket');
    this.oauthState = { status: 'idle' };
    this.error = null;
    // Abandoned flow: release the pinned target so a stray late completion
    // can't be attributed to the account this flow started on.
    this.oauthTargetAccountId = undefined;
    this.oauthTargetWasAddingAccount = undefined;
  }

  /**
   * Handle OAuth completion
   */
  private async handleOAuthComplete(tokens: OAuthTokenResponse): Promise<void> {
    // OAuth can complete after the dialog was closed; still persist the account
    // but surface a toast instead of the (invisible) inline status.
    const wasOpen = this.open;
    const targetAccountId =
      this.oauthTargetAccountId !== undefined
        ? this.oauthTargetAccountId
        : this.selectedAccountId;
    const targetWasAddingAccount =
      this.oauthTargetWasAddingAccount ?? this.isAddingAccount;
    this.oauthTargetAccountId = undefined;
    this.oauthTargetWasAddingAccount = undefined;

    const selectionChangedDuringOAuth = (): boolean =>
      this.selectedAccountId !== targetAccountId ||
      this.isAddingAccount !== targetWasAddingAccount;
    const invalidatedLoad = !selectionChangedDuringOAuth();
    const generation = this.beginAccountOp(invalidatedLoad);
    const targetAccountExists = (): boolean =>
      !targetAccountId ||
      getAccountsByType('bitbucket').some((account) => account.id === targetAccountId);
    let applyOAuthResultToSelection = false;
    let connectedAccountId: string | undefined;

    try {
      // For Bitbucket OAuth, we need to verify the token and get user info
      const verifyResult = await gitService.checkBitbucketConnectionWithToken(tokens.accessToken);

      if (!verifyResult.success || !verifyResult.data?.connected) {
        this.error = verifyResult.error?.message ?? 'OAuth token verification failed';
        return;
      }

      const user = verifyResult.data.user;
      if (!targetAccountExists()) {
        this.error = 'The Bitbucket account was removed before sign-in completed. Please sign in again.';
        showToast(this.error, 'error');
        return;
      }

      // Get workspace from detected repo or user
      const workspace = this.detectedRepo?.workspace || user?.username || '';

      // Find existing account for this workspace, or use the account the flow
      // targeted. When the user explicitly chose "Add account", never match an
      // existing same-workspace account — that would clobber it instead of
      // creating the new account they asked for.
      const existingAccount = targetAccountId
        ? getAccountById(targetAccountId)
        : targetWasAddingAccount
          ? undefined
          : this.accounts.find((a) =>
              a.config.type === 'bitbucket' &&
              a.config.workspace === workspace
            );

      if (existingAccount) {
        // Update existing account with OAuth token
        await credentialService.storeAccountOAuthToken(
          'bitbucket',
          existingAccount.id,
          tokens.accessToken,
          tokens.refreshToken,
          tokens.expiresIn
        );
        if (!targetAccountExists()) {
          // Deleted between the existence check and the write — don't leave an
          // orphaned credential behind for an account that no longer exists.
          await credentialService.deleteAccountToken('bitbucket', existingAccount.id);
          this.error = 'The Bitbucket account was removed before sign-in completed. Please sign in again.';
          showToast(this.error, 'error');
          return;
        }

        // Update cached user info
        if (user) {
          await unifiedProfileService.updateGlobalAccountCachedUser(existingAccount.id, {
            username: user.username,
            displayName: user.displayName ?? null,
            email: null,
            avatarUrl: user.avatarUrl ?? null,
          });
        }

        applyOAuthResultToSelection = !selectionChangedDuringOAuth();
        if (applyOAuthResultToSelection) {
          this.selectedAccountId = existingAccount.id;
        }
        connectedAccountId = existingAccount.id;
      } else {
        // Create new global account
        const { createEmptyIntegrationAccount, generateId } = await import('../../types/unified-profile.types.ts');
        const newAccount: IntegrationAccount = {
          ...createEmptyIntegrationAccount('bitbucket', workspace),
          id: generateId(),
          name: user?.username ? `Bitbucket (${user.username})` : 'Bitbucket Account',
          isDefault: this.accounts.length === 0,
          cachedUser: user ? {
            username: user.username,
            displayName: user.displayName ?? null,
            email: null,
            avatarUrl: user.avatarUrl ?? null,
          } : null,
        };

        const savedAccount = await unifiedProfileService.saveGlobalAccount(newAccount);
        await credentialService.storeAccountOAuthToken(
          'bitbucket',
          savedAccount.id,
          tokens.accessToken,
          tokens.refreshToken,
          tokens.expiresIn
        );

        // Refresh accounts list
        await unifiedProfileService.loadUnifiedProfiles();
        this.syncBitbucketAccounts();
        applyOAuthResultToSelection =
          (this.selectedAccountId === targetAccountId ||
            this.selectedAccountId === savedAccount.id) &&
          this.isAddingAccount === targetWasAddingAccount;
        if (applyOAuthResultToSelection) {
          this.selectedAccountId = savedAccount.id;
          // The new account now exists and is selected — the add flow is complete.
          this.isAddingAccount = false;
        }
        connectedAccountId = savedAccount.id;
      }

      if (connectedAccountId) {
        // Mirror the verified status into the shared store so the profile
        // manager's status dots update immediately (matches checkConnection and
        // the GitHub/GitLab dialogs) instead of staying stale until the next
        // periodic token validation. Keyed off the account the flow targeted,
        // not `selectedAccountId`, which may already point elsewhere.
        unifiedProfileStore
          .getState()
          .setAccountConnectionStatus(connectedAccountId, 'connected');
      }
      if (!applyOAuthResultToSelection) {
        // The user moved on to a different account mid-flow: the token is saved
        // on the account the flow targeted, but the dialog's visible state (and
        // `oauthToken`, which drives API calls) must keep describing the account
        // they are looking at now.
        this.oauthState = { status: 'idle' };
        showToast(
          user?.username ? `Connected Bitbucket account @${user.username}` : 'Connected Bitbucket account',
          'success'
        );
        return;
      }

      // Force UI update
      this.requestUpdate();

      // Store token in state for API calls
      this.oauthToken = tokens.accessToken;
      this.connectionStatus = verifyResult.data;
      this.oauthState = { status: 'idle' };

      // If the dialog was closed before OAuth completed, surface a toast so the
      // connection isn't a silent no-op.
      if (!wasOpen) {
        showToast(
          user?.username ? `Connected Bitbucket account @${user.username}` : 'Connected Bitbucket account',
          'success'
        );
      }

      // Load data if connected and repo detected
      if (wasOpen && this.repositoryPath && !this.detectedRepo) {
        await this.detectRepo(false, false);
      }

      if (generation !== this.loadGeneration || this.selectedAccountId !== connectedAccountId) return;
      if (wasOpen && this.connectionStatus?.connected && this.detectedRepo) {
        await this.loadAllData();
      }
    } catch (err) {
      if (targetAccountId && connectedAccountId === targetAccountId && !targetAccountExists()) {
        await credentialService.deleteAccountToken('bitbucket', targetAccountId);
      }
      if (invalidatedLoad && generation === this.loadGeneration) {
        this.error = err instanceof Error ? err.message : 'Failed to complete OAuth';
      }
    } finally {
      this.finishAccountOp(invalidatedLoad ? generation : undefined);
    }
  }

  private async handlePrFilterChange(e: Event): Promise<void> {
    this.prFilter = (e.target as HTMLSelectElement).value as 'OPEN' | 'MERGED' | 'DECLINED';
    await this.loadPullRequests();
  }

  private async handleGeneratePrDescription(): Promise<void> {
    if (!this.repositoryPath || !this.createPrSource || !this.createPrDestination) return;

    const repoPath = this.repositoryPath;
    const repoGen = this.repoGeneration;
    this.generatingPrDescription = true;
    try {
      const result = await aiService.generatePrDescription(
        repoPath,
        this.createPrDestination,
        this.createPrSource,
        this.createPrTitle || 'Untitled PR',
      );
      if (this.repositoryPath !== repoPath || this.repoGeneration !== repoGen) return;

      if (result.success && result.data) {
        this.createPrDescription = result.data.body;
      } else {
        showToast(result.error?.message ?? 'Failed to generate description', 'error');
      }
    } finally {
      if (this.repositoryPath === repoPath && this.repoGeneration === repoGen) {
        this.generatingPrDescription = false;
      }
    }
  }

  private async handleCreatePr(): Promise<void> {
    if (!this.detectedRepo || !this.createPrTitle.trim() || !this.createPrSource.trim() || !this.createPrDestination.trim()) return;

    const input: CreateBitbucketPullRequestInput = {
      title: this.createPrTitle,
      description: this.createPrDescription || undefined,
      sourceBranch: this.createPrSource,
      destinationBranch: this.createPrDestination,
      closeSourceBranch: this.createPrCloseSource,
    };

    await this.runCreateOperation({
      successMessage: 'Pull request created successfully',
      failureMessage: 'Failed to create pull request',
      getToken: (targetAccountId) => this.getActiveToken(targetAccountId),
      execute: (repo, token) =>
        gitService.createBitbucketPullRequest(
          repo.workspace,
          repo.repoSlug,
          input,
          token,
        ),
      onSuccess: async () => {
        this.createPrTitle = '';
        this.createPrDescription = '';
        this.createPrSource = '';
        this.createPrDestination = '';
        this.createPrCloseSource = false;
        this.activeTab = 'pull-requests';
        await this.loadPullRequests();
      },
    });
  }

  private async handleCreateIssue(): Promise<void> {
    if (!this.detectedRepo || !this.createIssueTitle.trim()) return;

    const input: CreateBitbucketIssueInput = {
      title: this.createIssueTitle,
      content: this.createIssueContent || undefined,
    };

    await this.runCreateOperation({
      successMessage: 'Issue created successfully',
      failureMessage: 'Failed to create issue',
      getToken: (targetAccountId) => this.getActiveToken(targetAccountId),
      execute: (repo, token) =>
        gitService.createBitbucketIssue(
          repo.workspace,
          repo.repoSlug,
          input,
          token,
        ),
      onSuccess: async () => {
        this.createIssueTitle = '';
        this.createIssueContent = '';
        this.activeTab = 'issues';
        await this.loadIssues();
      },
    });
  }

  private handleClose(): void {
    this.dispatchEvent(new CustomEvent('close'));
  }

  private renderConnectionTab() {
    if (this.connectionStatus?.connected && this.connectionStatus.user) {
      const user = this.connectionStatus.user;
      return html`
        <div class="connection-status">
          ${user.avatarUrl
            ? html`<img class="avatar" src="${user.avatarUrl}" alt="${user.username}" />`
            : html`<div class="user-avatar-placeholder">${this.getInitials(user.displayName)}</div>`
          }
          <div class="user-info">
            <div class="user-name">${user.displayName}</div>
            <div class="user-login">@${user.username}</div>
          </div>
          <div class="connection-actions">
            <button class="btn btn-danger" @click=${this.handleDisconnect} ?disabled=${this.isLoading}>Disconnect</button>
            <button class="btn btn-danger-outline" @click=${this.handleDeleteIntegration} ?disabled=${this.isLoading}>Delete</button>
          </div>
        </div>
      `;
    }

    const isOAuthPending = this.oauthState.status === 'pending' || this.oauthState.status === 'exchanging';
    const oauthConfigured = isOAuthConfigured('bitbucket');

    return html`
      <div class="token-form">
        ${oauthConfigured ? html`
          <div class="auth-method-toggle">
            <button
              class="btn ${this.authMethod === 'oauth' ? 'active' : ''}"
              @click=${() => this.authMethod = 'oauth'}
              ?disabled=${isOAuthPending}
            >
              Sign in with Bitbucket
            </button>
            <button
              class="btn ${this.authMethod === 'app-password' ? 'active' : ''}"
              @click=${() => this.authMethod = 'app-password'}
              ?disabled=${isOAuthPending}
            >
              App Password
            </button>
          </div>
        ` : ''}

        ${this.authMethod === 'oauth' && oauthConfigured ? html`
          <button
            class="btn-oauth"
            @click=${this.handleStartOAuth}
            ?disabled=${isOAuthPending || this.isLoading}
          >
            ${isOAuthPending ? html`
              <div class="oauth-spinner"></div>
              <span>${this.oauthState.status === 'exchanging' ? 'Completing sign in...' : 'Waiting for browser...'}</span>
            ` : html`
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M.778 1.213a.768.768 0 00-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 00.77-.646l3.27-20.03a.768.768 0 00-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z"/>
              </svg>
              <span>Sign in with Bitbucket</span>
            `}
          </button>

          ${isOAuthPending ? html`
            <button class="btn oauth-cancel" @click=${this.handleCancelOAuth}>Cancel</button>
          ` : ''}

          ${this.oauthState.status === 'error' ? html`
            <div class="oauth-status error">${this.oauthState.error}</div>
          ` : ''}

          <div class="oauth-divider">or</div>
        ` : ''}

        <div class="form-group">
          <label>Bitbucket Username</label>
          <input
            type="text"
            placeholder="your-username"
            .value=${this.usernameInput}
            @input=${(e: Event) => this.usernameInput = (e.target as HTMLInputElement).value}
            ?disabled=${isOAuthPending}
          />
        </div>
        <div class="form-group">
          <label>App Password</label>
          <input
            type="password"
            placeholder="xxxx-xxxx-xxxx-xxxx"
            .value=${this.appPasswordInput}
            @input=${(e: Event) => this.appPasswordInput = (e.target as HTMLInputElement).value}
            ?disabled=${isOAuthPending}
          />
          <span class="help-text">
            Create an app password at
            <a
              class="help-link"
              href="https://bitbucket.org/account/settings/app-passwords/"
              @click=${handleExternalLink}
            >Bitbucket Settings</a>
            with <code>Repositories: Read/Write</code> and <code>Pull requests: Read/Write</code> permissions.
          </span>
        </div>
        <div class="btn-row">
          ${this.selectedAccountId ? html`
            <button
              class="btn btn-danger-outline"
              @click=${this.handleDeleteIntegration}
              ?disabled=${this.isLoading}
            >
              Delete Integration
            </button>
          ` : nothing}
          <button
            class="btn btn-primary"
            @click=${this.handleSaveCredentials}
            ?disabled=${this.isLoading || isOAuthPending || !this.usernameInput.trim() || !this.appPasswordInput.trim()}
          >
            Connect with App Password
          </button>
        </div>
      </div>
    `;
  }

  private renderPullRequestsTab() {
    if (!this.connectionStatus?.connected) {
      return this.renderNotConnected('pull requests');
    }

    if (!this.detectedRepo) {
      return this.renderNoRepo();
    }

    return html`
      <div class="filter-row">
        <select class="filter-select" @change=${this.handlePrFilterChange}>
          <option value="OPEN" ?selected=${this.prFilter === 'OPEN'}>Open</option>
          <option value="MERGED" ?selected=${this.prFilter === 'MERGED'}>Merged</option>
          <option value="DECLINED" ?selected=${this.prFilter === 'DECLINED'}>Declined</option>
        </select>
        <button class="btn" @click=${() => this.activeTab = 'create-pr'}>
          + New PR
        </button>
      </div>

      ${this.isLoading ? html`<div class="loading">Loading pull requests...</div>` : ''}

      ${!this.isLoading && this.pullRequests.length === 0 ? html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="18" cy="18" r="3"></circle>
            <circle cx="6" cy="6" r="3"></circle>
            <path d="M6 21V9a9 9 0 0 0 9 9"></path>
          </svg>
          <p>No ${this.prFilter.toLowerCase()} pull requests</p>
        </div>
      ` : ''}

      <div class="pr-list">
        ${this.pullRequests.map(pr => html`
          <div class="pr-card-wrapper">
            <div class="pr-item" @click=${() => this.openInBrowser(pr.url)}>
              <span class="pr-number">#${pr.id}</span>
              <div class="pr-info">
                <div class="pr-title">${pr.title}</div>
                <div class="pr-meta">
                  <span class="pr-state ${pr.state}">${pr.state}</span>
                  <span class="pr-branch">${pr.sourceBranch} → ${pr.destinationBranch}</span>
                  <span>by ${pr.author.displayName}</span>
                  <span>${this.formatDate(pr.createdOn)}</span>
                </div>
              </div>
              <div class="pr-actions" @click=${(e: Event) => e.stopPropagation()}>
                <button
                  class="btn pr-comments-toggle"
                  data-testid="pr-comments-toggle-${pr.id}"
                  title="Review comments"
                  @click=${() => this.togglePrComments(pr.id)}
                >
                  Comments${this.prComments[pr.id] ? ` (${this.prComments[pr.id].length})` : ''}
                </button>
              </div>
            </div>
            ${this.expandedPrNumber === pr.id ? this.renderPrCommentsDrawer(pr.id) : nothing}
          </div>
        `)}
      </div>
      ${this.renderCappedListHint(
        this.pullRequests.length,
        BITBUCKET_LIST_PAGE_SIZE,
        'pull requests',
        'pull-requests',
        this.prFilter,
      )}
    `;
  }

  private renderIssuesTab() {
    if (!this.connectionStatus?.connected) {
      return this.renderNotConnected('issues');
    }

    if (!this.detectedRepo) {
      return this.renderNoRepo();
    }

    if (this.issues.length === 0) {
      return html`
        <div class="filter-row">
          <button class="btn" @click=${() => this.activeTab = 'create-issue'}>
            + New Issue
          </button>
        </div>
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <p>No issues found (or issue tracker not enabled)</p>
        </div>
      `;
    }

    return html`
      <div class="filter-row">
        <button class="btn" @click=${() => this.activeTab = 'create-issue'}>
          + New Issue
        </button>
      </div>
      <div class="issue-list">
        ${this.issues.map(issue => html`
          <div class="issue-item" @click=${() => this.openInBrowser(issue.url)}>
            <span class="issue-number">#${issue.id}</span>
            <div class="issue-info">
              <div class="issue-title">${issue.title}</div>
              <div class="issue-meta">
                <span class="issue-state ${issue.state}">${issue.state}</span>
                <span class="issue-kind">${issue.kind}</span>
                <span>${issue.priority}</span>
                ${issue.reporter ? html`<span>by ${issue.reporter.displayName}</span>` : ''}
                <span>${this.formatDate(issue.createdOn)}</span>
              </div>
            </div>
          </div>
        `)}
      </div>
      ${this.renderCappedListHint(
        this.issues.length,
        BITBUCKET_LIST_PAGE_SIZE,
        'issues',
        'issues',
      )}
    `;
  }

  private renderPipelinesTab() {
    if (!this.connectionStatus?.connected) {
      return this.renderNotConnected('pipelines');
    }

    if (!this.detectedRepo) {
      return this.renderNoRepo();
    }

    if (this.pipelines.length === 0) {
      return html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>
          </svg>
          <p>No pipelines found (or Pipelines not enabled)</p>
        </div>
      `;
    }

    return html`
      <div class="pipeline-list">
        ${this.pipelines.map(pipeline => html`
          <div class="pipeline-item" @click=${() => this.openInBrowser(pipeline.url)}>
            <div class="pipeline-status ${pipeline.resultName ?? pipeline.stateName}"></div>
            <div class="pipeline-info">
              <div class="pipeline-name">#${pipeline.buildNumber}</div>
              <div class="pipeline-meta">
                <span class="pipeline-branch">${pipeline.targetBranch}</span>
                <span>${pipeline.resultName ?? pipeline.stateName}</span>
                <span>${this.formatDate(pipeline.createdOn)}</span>
              </div>
            </div>
          </div>
        `)}
      </div>
      ${this.renderCappedListHint(
        this.pipelines.length,
        BITBUCKET_PIPELINE_PAGE_SIZE,
        'pipelines',
        'pipelines',
      )}
    `;
  }

  private renderCappedListHint(
    count: number,
    limit: number,
    label: string,
    route: string,
    state?: string,
  ) {
    if (count < limit || !this.detectedRepo) return nothing;
    const query = state ? `?state=${encodeURIComponent(state)}` : '';
    return html`
      <p class="help-text capped-list-hint" style="text-align:center;padding-top:8px">
        Showing the first ${limit} ${label}; more may exist.
        <a
          class="help-link"
          href="https://bitbucket.org/${this.detectedRepo.workspace}/${this.detectedRepo.repoSlug}/${route}${query}"
          @click=${handleExternalLink}
        >Open in Bitbucket</a> for the full list.
      </p>
    `;
  }

  private renderCreatePrTab() {
    return html`
      <div class="token-form">
        <div class="form-group">
          <label>Title</label>
          <input
            type="text"
            placeholder="Pull request title"
            .value=${this.createPrTitle}
            @input=${(e: Event) => this.createPrTitle = (e.target as HTMLInputElement).value}
          />
        </div>
        <div class="form-group">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <label>Description</label>
            <button
              class="btn btn-sm"
              style="font-size:12px;padding:2px 8px;display:flex;align-items:center;gap:4px"
              @click=${this.handleGeneratePrDescription}
              ?disabled=${this.generatingPrDescription || !this.createPrSource || !this.createPrDestination}
              title="Generate description using AI"
            >
              ${this.generatingPrDescription ? 'Generating...' : html`<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a3.5 3.5 0 0 0-3.5 3.5c0 1.193.603 2.26 1.5 2.898V9.5a1 1 0 0 0 .293.707l1 1a1 1 0 0 0 1.414 0l1-1A1 1 0 0 0 10 9.5V7.398A3.496 3.496 0 0 0 11.5 4.5 3.5 3.5 0 0 0 8 1z"/></svg> AI Generate`}
            </button>
          </div>
          <textarea
            placeholder="Describe your changes..."
            .value=${this.createPrDescription}
            @input=${(e: Event) => this.createPrDescription = (e.target as HTMLTextAreaElement).value}
          ></textarea>
        </div>
        <div class="form-group">
          <label>Source Branch</label>
          <input
            type="text"
            placeholder="feature/my-branch"
            .value=${this.createPrSource}
            @input=${(e: Event) => this.createPrSource = (e.target as HTMLInputElement).value}
          />
        </div>
        <div class="form-group">
          <label>Destination Branch</label>
          <input
            type="text"
            placeholder="main"
            .value=${this.createPrDestination}
            @input=${(e: Event) => this.createPrDestination = (e.target as HTMLInputElement).value}
          />
        </div>
        <div class="form-group">
          <div class="checkbox-group">
            <input
              type="checkbox"
              id="pr-close-source"
              .checked=${this.createPrCloseSource}
              @change=${(e: Event) => this.createPrCloseSource = (e.target as HTMLInputElement).checked}
            />
            <label for="pr-close-source">Close source branch after merge</label>
          </div>
        </div>
        <div class="btn-row">
          <button class="btn" @click=${() => this.activeTab = 'pull-requests'}>
            Cancel
          </button>
          <button
            class="btn btn-primary"
            @click=${this.handleCreatePr}
            ?disabled=${this.isLoading || !this.detectedRepo || !this.createPrTitle.trim() || !this.createPrSource.trim() || !this.createPrDestination.trim()}
          >
            Create Pull Request
          </button>
        </div>
      </div>
    `;
  }

  private renderCreateIssueTab() {
    return html`
      <div class="token-form">
        <div class="form-group">
          <label>Title</label>
          <input
            type="text"
            placeholder="Issue title"
            .value=${this.createIssueTitle}
            @input=${(e: Event) => this.createIssueTitle = (e.target as HTMLInputElement).value}
          />
        </div>
        <div class="form-group">
          <label>Description</label>
          <textarea
            placeholder="Describe the issue..."
            .value=${this.createIssueContent}
            @input=${(e: Event) => this.createIssueContent = (e.target as HTMLTextAreaElement).value}
          ></textarea>
        </div>
        <div class="btn-row">
          <button class="btn" @click=${() => this.activeTab = 'issues'}>
            Cancel
          </button>
          <button
            class="btn btn-primary"
            @click=${this.handleCreateIssue}
            ?disabled=${this.isLoading || !this.detectedRepo || !this.createIssueTitle.trim()}
          >
            Create Issue
          </button>
        </div>
      </div>
    `;
  }

  private renderNotConnected(feature: string) {
    return html`
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"></path>
        </svg>
        <p>Connect to Bitbucket to view ${feature}</p>
      </div>
    `;
  }

  private renderDetectedRepo() {
    if (!this.detectedRepo) return '';

    return html`
      <div class="detected-repo">
        <svg class="repo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
        <div>
          <div class="repo-name">${this.detectedRepo.workspace}/${this.detectedRepo.repoSlug}</div>
          <div class="repo-remote">via ${this.detectedRepo.remoteName}</div>
        </div>
      </div>
    `;
  }

  /**
   * Open the create-pull-request form with `sourceBranch` prefilled as the
   * source branch.
   *
   * The entry point for the sidebar's branch context menu, which deliberately
   * does NOT build its own create flow: this dialog already owns the form, the
   * account selection and the create call, so the menu reuses them. `baseBranch`
   * is only a suggestion and is applied ONLY when the field is still empty, so
   * a draft the user already typed here is never overwritten.
   */
  public startCreatePullRequest(sourceBranch: string, baseBranch?: string): void {
    this.createPrSource = sourceBranch;
    if (baseBranch && !this.createPrDestination) {
      this.createPrDestination = baseBranch;
    }
    this.activeTab = 'create-pr';
  }

  render() {
    return html`
      <gn-modal
        .open=${this.open}
        ?backButton=${this.backButton}
        modalTitle="Bitbucket"
        @close=${this.handleClose}
      >
        <div class="content">
          ${this.attachToProfileName
            ? html`<div class="attach-breadcrumb" data-testid="attach-breadcrumb">Adding to <strong>${this.attachToProfileName}</strong></div>`
            : nothing}
          ${this.renderDetectedRepo()}

          ${this.accounts.length > 0 || this.connectionStatus?.connected ? html`
            <gn-account-selector
              integrationType="bitbucket"
              .selectedAccountId=${this.selectedAccountId}
              @account-change=${this.handleAccountChange}
              @add-account=${this.handleAddAccount}
              @manage-accounts=${this.handleManageAccounts}
            ></gn-account-selector>
          ` : nothing}

          <div class="tabs">
            <button
              class="tab ${this.activeTab === 'connection' ? 'active' : ''}"
              @click=${() => this.activeTab = 'connection'}
            >
              Connection
            </button>
            <button
              class="tab ${this.activeTab === 'pull-requests' ? 'active' : ''}"
              @click=${() => { this.activeTab = 'pull-requests'; this.loadPullRequests(); }}
            >
              Pull Requests
            </button>
            <button
              class="tab ${this.activeTab === 'issues' ? 'active' : ''}"
              @click=${() => { this.activeTab = 'issues'; this.loadIssues(); }}
            >
              Issues
            </button>
            <button
              class="tab ${this.activeTab === 'pipelines' ? 'active' : ''}"
              @click=${() => { this.activeTab = 'pipelines'; this.loadPipelines(); }}
            >
              Pipelines
            </button>
          </div>

          ${this.error ? html`<div class="error">${this.error}</div>` : ''}

          <div class="tab-content">
            ${this.activeTab === 'connection' ? this.renderConnectionTab() : ''}
            ${this.activeTab === 'pull-requests' ? this.renderPullRequestsTab() : ''}
            ${this.activeTab === 'issues' ? this.renderIssuesTab() : ''}
            ${this.activeTab === 'pipelines' ? this.renderPipelinesTab() : ''}
            ${this.activeTab === 'create-pr' ? this.renderCreatePrTab() : ''}
            ${this.activeTab === 'create-issue' ? this.renderCreateIssueTab() : ''}
          </div>
        </div>
      </gn-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-bitbucket-dialog': GnBitbucketDialog;
  }
}
