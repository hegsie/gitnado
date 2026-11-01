/**
 * GitLab Integration Dialog
 * Manage GitLab connection, view MRs, issues, and pipelines
 */

import { html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { invokeCommand } from '../../services/tauri-api.ts';
import * as aiService from '../../services/ai.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { loggers, handleExternalLink } from '../../utils/index.ts';
import { GnProviderDialogBase, type PrReviewComment } from './gn-provider-dialog-base.ts';
export type { PrReviewComment };
import type {
  GitLabConnectionStatus,
  DetectedGitLabRepo,
  GitLabMergeRequest,
  GitLabIssue,
  GitLabPipeline,
  CreateMergeRequestInput,
  CreateGitLabIssueInput,
} from '../../services/git.service.ts';
import { unifiedProfileStore, getAccountsByType, selectDefaultGlobalAccount, getAccountById, getActiveProfilePreferredAccount } from '../../stores/unified-profile.store.ts';
import * as unifiedProfileService from '../../services/unified-profile.service.ts';
import type { IntegrationAccount } from '../../types/unified-profile.types.ts';
import * as credentialService from '../../services/credential.service.ts';
import * as oauthService from '../../services/oauth.service.ts';
import { getClientId, isOAuthConfigured } from '../../services/oauth.service.ts';
import type { OAuthFlowState, OAuthTokenResponse } from '../../types/oauth.types.ts';
import './gn-modal.ts';
import './gn-account-selector.ts';

const log = loggers.gitlab;

const GITLAB_LIST_PAGE_SIZE = 30;
const GITLAB_PIPELINE_PAGE_SIZE = 20;

type TabType = 'connection' | 'merge-requests' | 'issues' | 'pipelines' | 'create-mr' | 'create-issue';

@customElement('gn-gitlab-dialog')
export class GnGitLabDialog extends GnProviderDialogBase<
  DetectedGitLabRepo,
  GitLabConnectionStatus,
  TabType
> {
  protected readonly providerDisplayName = 'GitLab';
  protected override readonly reviewCommentNoun = 'MR' as const;
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

      /* Button styles */
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

      .btn-secondary {
        background: var(--color-bg-tertiary);
        border-color: var(--color-border);
        color: var(--color-text-primary);
      }

      .btn-secondary:hover:not(:disabled) {
        background: var(--color-bg-hover);
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
        background: var(--color-primary);
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

      .mr-list, .issue-list, .pipeline-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .mr-item, .issue-item {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-md);
        padding: var(--spacing-md);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: background var(--transition-fast);
      }

      .mr-item:hover, .issue-item:hover {
        background: var(--color-bg-hover);
      }

      .pr-card-wrapper {
        display: flex;
        flex-direction: column;
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        overflow: hidden;
      }

      .pr-card-wrapper .mr-item {
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

      .mr-number, .issue-number {
        font-weight: var(--font-weight-semibold);
        color: var(--color-primary);
        min-width: 50px;
      }

      .mr-info, .issue-info {
        flex: 1;
        min-width: 0;
      }

      .mr-title, .issue-title {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        margin-bottom: var(--spacing-xs);
      }

      .mr-meta, .issue-meta {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-sm);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .mr-branch {
        display: flex;
        align-items: center;
        gap: 4px;
        font-family: var(--font-family-mono);
        background: var(--color-bg-hover);
        padding: 2px 6px;
        border-radius: var(--radius-sm);
      }

      .mr-state, .issue-state {
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
      }

      .mr-state.opened, .issue-state.opened {
        background: var(--color-success-bg);
        color: var(--color-success);
      }

      .mr-state.merged {
        background: #8250df20;
        color: #8250df;
      }

      .mr-state.closed, .issue-state.closed {
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      .mr-state.draft {
        background: var(--color-bg-hover);
        color: var(--color-text-muted);
      }

      .issue-labels {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: var(--spacing-xs);
      }

      .issue-label {
        padding: 2px 6px;
        border-radius: var(--radius-sm);
        font-size: var(--font-size-xs);
        background: var(--color-bg-hover);
        color: var(--color-text-secondary);
      }

      /* Label picker on the create-issue form */
      .label-picker {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }

      .label-chip {
        padding: 2px 8px;
        border-radius: var(--radius-sm);
        font-size: var(--font-size-xs);
        background: var(--color-bg-hover);
        color: var(--color-text-secondary);
        border: 1px solid var(--color-border);
        cursor: pointer;
        transition: background var(--transition-fast);
      }

      .label-chip:hover {
        background: var(--color-bg-tertiary);
      }

      .label-chip.selected {
        background: var(--color-primary);
        border-color: var(--color-primary);
        color: white;
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

      .pipeline-status.success {
        background: var(--color-success);
      }

      .pipeline-status.failed {
        background: var(--color-error);
      }

      .pipeline-status.running, .pipeline-status.pending {
        background: var(--color-warning);
        animation: pulse 2s infinite;
      }

      .pipeline-status.canceled, .pipeline-status.skipped {
        background: var(--color-text-muted);
      }

      .pipeline-info {
        flex: 1;
        min-width: 0;
      }

      .pipeline-ref {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        font-family: var(--font-family-mono);
      }

      .pipeline-meta {
        display: flex;
        gap: var(--spacing-sm);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
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

  @state() private mergeRequests: GitLabMergeRequest[] = [];
  @state() private issues: GitLabIssue[] = [];
  @state() private pipelines: GitLabPipeline[] = [];
  @state() private labels: string[] = [];
  @state() private tokenInput = '';
  @state() private instanceUrlInput = 'https://gitlab.com';
  @state() private mrFilter: 'opened' | 'merged' | 'closed' | 'all' = 'opened';
  @state() private issueFilter: 'opened' | 'closed' | 'all' = 'opened';

  // OAuth state
  @state() private authMethod: 'oauth' | 'pat' = 'oauth';
  @state() private oauthState: OAuthFlowState = { status: 'idle' };

  private oauthCompleteHandler?: EventListener;
  private oauthStateUnsubscribe?: () => void;
  // The account/instance the in-flight OAuth flow targets, pinned when the flow
  // STARTS. The browser round-trip is async, so `selectedAccountId` may point at
  // a different account by the time `oauth-complete` lands — writing the new
  // token there would route it onto the wrong account.
  private oauthTargetAccountId: string | null | undefined;
  private oauthTargetWasAddingAccount: boolean | undefined;
  private oauthTargetInstanceUrl: string | undefined;

  // Create MR form
  @state() private createMrTitle = '';
  @state() private createMrDescription = '';
  @state() private createMrSource = '';
  @state() private createMrTarget = '';
  @state() private createMrDraft = false;
  @state() private generatingMrDescription = false;

  // Create Issue form
  @state() private createIssueTitle = '';
  @state() private createIssueDescription = '';
  @state() private createIssueLabels: string[] = [];

  async connectedCallback(): Promise<void> {
    super.connectedCallback();

    // Set up OAuth event listeners
    this.oauthCompleteHandler = ((e: CustomEvent<{ provider: string; tokens: OAuthTokenResponse; instanceUrl?: string }>) => {
      if (e.detail.provider === 'gitlab') {
        this.handleOAuthComplete(e.detail.tokens, e.detail.instanceUrl);
      }
    }) as unknown as EventListener;
    window.addEventListener('oauth-complete', this.oauthCompleteHandler);

    this.oauthStateUnsubscribe = oauthService.onOAuthStateChange((state) => {
      if (state.provider === 'gitlab') {
        this.oauthState = state;
        // A failed/denied sign-in clears the pending spinner — surface the error
        // so the user isn't left with no feedback (matches the other providers).
        if (state.status === 'error') {
          this.error = state.error ?? 'GitLab sign-in failed';
          showToast(this.error, 'error');
          // The flow is over and can no longer emit `oauth-complete`, so release
          // the pinned target — otherwise a later completion would be attributed
          // to whichever account was selected when this failed flow started.
          this.oauthTargetAccountId = undefined;
          this.oauthTargetWasAddingAccount = undefined;
          this.oauthTargetInstanceUrl = undefined;
        }
      }
    });

    // Subscribe to unified profile store. When the active profile changes,
    // re-derive the preferred account so a profile switch is reflected here.
    let lastActiveProfileId = unifiedProfileStore.getState().activeProfile?.id ?? null;
    const applyAccount = (account: IntegrationAccount | undefined) => {
      if (!account) return;
      this.selectedAccountId = account.id;
      if (account.config.type === 'gitlab' && account.config.instanceUrl) {
        this.instanceUrlInput = account.config.instanceUrl;
      }
    };
    this.unsubscribeStore = unifiedProfileStore.subscribe((state) => {
      this.accounts = getAccountsByType('gitlab');
      if (this.selectedAccountId && !this.accounts.some(a => a.id === this.selectedAccountId)) {
        this.selectedAccountId = null;
      }
      const selectMatchingCandidate = () => {
        const candidate =
          getActiveProfilePreferredAccount('gitlab') ??
          selectDefaultGlobalAccount('gitlab') ??
          this.accounts[0];
        if (this.detectedRepo) {
          const detectedNorm = this.normalizeInstanceUrl(this.detectedRepo.instanceUrl);
          const candidateNorm =
            candidate?.config.type === 'gitlab'
              ? this.normalizeInstanceUrl(candidate.config.instanceUrl)
              : '';
          const matching =
            candidate && (!candidateNorm || candidateNorm === detectedNorm)
              ? candidate
              : this.accounts.find(
                  (a) =>
                    a.config.type === 'gitlab' &&
                    (!a.config.instanceUrl ||
                      this.normalizeInstanceUrl(a.config.instanceUrl) === detectedNorm)
                );
          if (matching) {
            applyAccount(matching);
          }
        } else {
          applyAccount(candidate);
        }
      };
      const activeProfileId = state.activeProfile?.id ?? null;
      if (activeProfileId !== lastActiveProfileId) {
        // Track the id either way so this doesn't re-fire, but DON'T clobber a
        // half-completed "Add account" flow or an in-flight loadInitialData()
        // that is about to detect the repo and match the host.
        lastActiveProfileId = activeProfileId;
        if (!this.isAddingAccount && !this.initInFlight && this.accounts.length > 0) {
          selectMatchingCandidate();
        }
      } else if (
        !this.isAddingAccount &&
        !this.initInFlight &&
        !this.selectedAccountId &&
        this.accounts.length > 0
      ) {
        selectMatchingCandidate();
      }
    });

    // Initialize from current state
    this.accounts = getAccountsByType('gitlab');
    if (this.accounts.length > 0 && !this.selectedAccountId && !this.open) {
      applyAccount(
        getActiveProfilePreferredAccount('gitlab') ?? selectDefaultGlobalAccount('gitlab') ?? this.accounts[0],
      );
    }

    if (this.open) {
      await this.loadInitialData();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeStore?.();

    // Clean up OAuth listeners
    if (this.oauthCompleteHandler) {
      window.removeEventListener('oauth-complete', this.oauthCompleteHandler);
    }
    this.oauthStateUnsubscribe?.();
  }

  protected resetProviderRepoScopedState(): void {
    if (!this.isAddingAccount) {
      const selectedAccount = this.selectedAccountId
        ? (getAccountById(this.selectedAccountId) ??
          this.accounts.find((a) => a.id === this.selectedAccountId))
        : undefined;
      this.instanceUrlInput =
        selectedAccount?.config.type === 'gitlab' && selectedAccount.config.instanceUrl
          ? selectedAccount.config.instanceUrl
          : 'https://gitlab.com';
    }
    this.createMrTitle = '';
    this.createMrDescription = '';
    this.createMrSource = '';
    this.createMrTarget = '';
    this.createMrDraft = false;
    this.generatingMrDescription = false;
    this.createIssueTitle = '';
    this.createIssueDescription = '';
    this.createIssueLabels = [];
    this.mergeRequests = [];
    this.issues = [];
    this.pipelines = [];
    this.labels = [];
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
      this.accounts = getAccountsByType('gitlab');

      if (this.repositoryPath) {
        await this.detectRepo(false, autoSelectAccount && !this.selectedAccountId && !this.isAddingAccount);
        if (generation !== this.loadGeneration) return;
      }

      if (this.accounts.length > 0 && autoSelectAccount && !this.selectedAccountId && !this.isAddingAccount) {
        const preferred = getActiveProfilePreferredAccount('gitlab')
          ?? selectDefaultGlobalAccount('gitlab');
        if (this.detectedRepo) {
          const matching = this.findMatchingAccountForInstance(
            this.detectedRepo.instanceUrl,
            preferred
          );
          this.selectedAccountId = matching?.id ?? null;
        } else {
          const chosen = preferred ?? this.accounts[0];
          this.selectedAccountId = chosen?.id ?? null;
          if (chosen?.config.type === 'gitlab' && chosen.config.instanceUrl) {
            this.instanceUrlInput = chosen.config.instanceUrl;
          }
        }
      }
      if (!this.isAddingAccount && (this.detectedRepo?.instanceUrl || this.instanceUrlInput)) {
        await this.checkConnection();
        if (generation !== this.loadGeneration) return;

        if (this.isConnectedForDetectedRepo() && this.detectedRepo) {
          await this.loadAllData();
        }
      }
    } catch (err) {
      if (generation !== this.loadGeneration) return;
      this.error = err instanceof Error ? err.message : 'Failed to load data';
    } finally {
      if (generation === this.loadGeneration) {
        this.initInFlight = false;
        this.isLoading = false;
        this.isDetectingRepo = false;
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

  private normalizeInstanceUrl(url?: string | null): string {
    return (url ?? '').trim().replace(/\/+$/, '').toLowerCase();
  }

  private findMatchingAccountForInstance(
    instanceUrl?: string | null,
    preferred?: IntegrationAccount | null
  ): IntegrationAccount | undefined {
    const detectedNorm = this.normalizeInstanceUrl(instanceUrl);
    if (!detectedNorm) return preferred ?? this.accounts[0];
    const preferredNorm =
      preferred?.config.type === 'gitlab'
        ? this.normalizeInstanceUrl(preferred.config.instanceUrl)
        : '';
    if (preferred && preferredNorm && preferredNorm === detectedNorm) {
      return preferred;
    }
    const exactMatch = this.accounts.find(
      (a) =>
        a.config.type === 'gitlab' &&
        Boolean(this.normalizeInstanceUrl(a.config.instanceUrl)) &&
        this.normalizeInstanceUrl(a.config.instanceUrl) === detectedNorm
    );
    if (exactMatch) return exactMatch;
    if (preferred && !preferredNorm) return preferred;
    return this.accounts.find(
      (a) =>
        a.config.type === 'gitlab' &&
        !this.normalizeInstanceUrl(a.config.instanceUrl)
    );
  }

  private isConnectedForDetectedRepo(): boolean {
    if (!this.connectionStatus?.connected) return false;
    if (!this.detectedRepo || !this.connectionStatus.instanceUrl) return true;
    return (
      this.normalizeInstanceUrl(this.connectionStatus.instanceUrl) ===
      this.normalizeInstanceUrl(this.detectedRepo.instanceUrl)
    );
  }

  private async checkConnection(expectedRepoGen?: number): Promise<void> {
    const accountId = this.selectedAccountId;
    const account = accountId
      ? (getAccountById(accountId) ?? this.accounts.find((a) => a.id === accountId))
      : undefined;
    const accountInstanceUrl =
      account?.config.type === 'gitlab' ? account.config.instanceUrl : undefined;
    const instanceUrl =
      accountInstanceUrl || this.detectedRepo?.instanceUrl || this.instanceUrlInput;
    if (!instanceUrl) return;

    const generation = this.loadGeneration;
    const matchesAccountInstance =
      !accountInstanceUrl ||
      this.normalizeInstanceUrl(accountInstanceUrl) === this.normalizeInstanceUrl(instanceUrl);
    const isCurrent = () =>
      generation === this.loadGeneration &&
      (expectedRepoGen === undefined || this.repoGeneration === expectedRepoGen) &&
      this.selectedAccountId === accountId &&
      this.normalizeInstanceUrl(
        accountInstanceUrl || this.detectedRepo?.instanceUrl || this.instanceUrlInput
      ) === this.normalizeInstanceUrl(instanceUrl);
    // When checking a detected repository whose host differs from the selected
    // account's configured instance, do not send that account's token to the
    // foreign host.
    const token = matchesAccountInstance
      ? await this.getSelectedAccountToken(instanceUrl)
      : null;
    if (!isCurrent()) return;
    const result = await gitService.checkGitLabConnectionWithToken(instanceUrl, token);
    if (!isCurrent()) return;
    if (result.success && result.data) {
      this.connectionStatus = {
        ...result.data,
        instanceUrl: result.data.instanceUrl || instanceUrl,
      };
      if (matchesAccountInstance) {
        this.syncSharedConnectionStatus(result.data.connected);
      }
      // Update cached user in global account if connected
      if (this.selectedAccountId && matchesAccountInstance && result.data.connected && result.data.user) {
        await unifiedProfileService.updateGlobalAccountCachedUser(this.selectedAccountId, {
          username: result.data.user.username,
          displayName: result.data.user.name ?? null,
          email: null, // GitLab API doesn't return email in user object
          avatarUrl: result.data.user.avatarUrl ?? null,
        });
      }
    } else {
      // Failed check must mark the account as disconnected so dependent UI
      // surfaces (toolbar, account selector dot) don't keep showing a stale
      // "connected" state for a now-invalid token.
      this.connectionStatus = { connected: false, user: null, instanceUrl };
      if (matchesAccountInstance) {
        this.syncSharedConnectionStatus(false);
      }
    }
  }

  /**
   * Get the token for the currently selected account, refreshing an expiring
   * OAuth access token first (GitLab OAuth access tokens last ~2h, so without
   * this a signed-in account reads as disconnected on the next open). Personal
   * access tokens have no OAuth bundle and are returned unchanged.
   */
  private async getSelectedAccountToken(
    targetInstanceUrl = this.detectedRepo?.instanceUrl,
    targetAccountId: string | null = this.selectedAccountId,
  ): Promise<string | null> {
    if (!targetAccountId) return null;
    // Refresh against the instance the account was created on — a detected repo
    // on a DIFFERENT instance must not redirect the refresh grant.
    const account =
      getAccountById(targetAccountId) ??
      this.accounts.find((a) => a.id === targetAccountId);
    const instanceUrl =
      account?.config.type === 'gitlab' ? account.config.instanceUrl : this.instanceUrlInput;
    if (
      targetInstanceUrl &&
      account?.config.type === 'gitlab' &&
      account.config.instanceUrl &&
      this.normalizeInstanceUrl(account.config.instanceUrl) !==
        this.normalizeInstanceUrl(targetInstanceUrl)
    ) {
      return null;
    }
    return credentialService.getFreshAccountToken(
      'gitlab',
      targetAccountId,
      'gitlab',
      instanceUrl || undefined
    );
  }

  /**
   * Handle account selection change
   */
  private async handleAccountChange(e: CustomEvent<{ account: IntegrationAccount }>): Promise<void> {
    const { account } = e.detail;
    // The user explicitly selected an existing account — re-enable the
    // subscription's auto-apply branch.
    this.beginAccountSwitch(account.id);
    this.tokenInput = '';
    this.mergeRequests = [];
    this.issues = [];
    this.pipelines = [];
    this.labels = [];

    // Update instance URL from account config
    if (account.config.type === 'gitlab' && account.config.instanceUrl) {
      this.instanceUrlInput = account.config.instanceUrl;
    }

    // Re-check connection with new account
    await this.loadInitialData();
  }

  /**
   * Handle add account request
   */
  private handleAddAccount(): void {
    // Clear selection so the next token save creates a new account instead of
    // overwriting the previously-selected account's token.
    this.beginAddAccount();
    this.tokenInput = '';
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
        detail: { integrationType: 'gitlab' },
        bubbles: true,
        composed: true,
      })
    );
  }

  protected async detectRepo(loadData = true, updateInstanceInput = true): Promise<void> {
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
      const result = await gitService.detectGitLabRepo(requestedPath);
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
        if (!this.isAddingAccount && (loadData || updateInstanceInput)) {
          this.instanceUrlInput = result.data.instanceUrl;
        }
        if (loadData && !this.isAddingAccount) {
          const detectedNorm = this.normalizeInstanceUrl(result.data.instanceUrl);
          let accountChanged = false;
          if (this.accounts.length > 0) {
            const currentAccount = this.selectedAccountId
              ? (getAccountById(this.selectedAccountId) ??
                this.accounts.find((a) => a.id === this.selectedAccountId))
              : undefined;
            const matchingAccount = this.findMatchingAccountForInstance(
              result.data.instanceUrl,
              currentAccount
            );
            const nextAccountId = matchingAccount?.id ?? null;
            if (this.selectedAccountId !== nextAccountId) {
              this.selectedAccountId = nextAccountId;
              this.connectionStatus = null;
              accountChanged = true;
            }
          }
          const statusNorm = this.normalizeInstanceUrl(this.connectionStatus?.instanceUrl);
          if (!this.connectionStatus || statusNorm !== detectedNorm || accountChanged) {
            this.connectionStatus = null;
            await this.checkConnection(repoGen);
            if (
              this.repositoryPath !== requestedPath ||
              this.repoGeneration !== repoGen ||
              this.detectGeneration !== detectGen
            ) {
              return;
            }
          }
          if (this.isConnectedForDetectedRepo()) {
            await this.loadAllData();
          }
        }
      } else {
        this.detectedRepo = null;
        if (!result.success) {
          // A genuine backend failure (not merely "this isn't a GitLab repo", which
          // surfaces as success with null data) must not fail silently.
          this.error = result.error?.message ?? 'Failed to detect GitLab repository';
        } else if (loadData && !this.isAddingAccount && this.accounts.length > 0) {
          if (!this.selectedAccountId) {
            const preferred =
              getActiveProfilePreferredAccount('gitlab') ??
              selectDefaultGlobalAccount('gitlab') ??
              this.accounts[0];
            this.selectedAccountId = preferred?.id ?? null;
            if (preferred?.config.type === 'gitlab' && preferred.config.instanceUrl) {
              this.instanceUrlInput = preferred.config.instanceUrl;
            }
            this.connectionStatus = null;
          }
          const currentAccount = this.selectedAccountId
            ? (getAccountById(this.selectedAccountId) ??
              this.accounts.find((a) => a.id === this.selectedAccountId))
            : undefined;
          const accountInstanceUrl =
            currentAccount?.config.type === 'gitlab'
              ? currentAccount.config.instanceUrl
              : undefined;
          if (
            !this.connectionStatus ||
            (accountInstanceUrl &&
              this.normalizeInstanceUrl(this.connectionStatus.instanceUrl) !==
                this.normalizeInstanceUrl(accountInstanceUrl))
          ) {
            this.connectionStatus = null;
            await this.checkConnection(repoGen);
          }
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
      this.loadMergeRequests(),
      this.loadIssues(),
      this.loadPipelines(),
      this.loadLabels(),
    ]);
  }

  private async loadMergeRequests(): Promise<void> {
    if (!this.detectedRepo || !this.isConnectedForDetectedRepo()) return;

    const targetRepoPath = this.repositoryPath;
    const targetDetectedRepo = this.detectedRepo;
    const targetAccountId = this.selectedAccountId;
    this.isLoading = true;
    this.error = null;

    try {
      const token = await this.getSelectedAccountToken();
      const result = await gitService.listGitLabMergeRequests(
        targetDetectedRepo.instanceUrl,
        targetDetectedRepo.projectPath,
        this.mrFilter === 'all' ? undefined : this.mrFilter,
        GITLAB_LIST_PAGE_SIZE,
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
        this.mergeRequests = result.data;
      } else {
        this.error = result.error?.message ?? 'Failed to load merge requests';
      }
    } catch (err) {
      if (
        this.repositoryPath !== targetRepoPath ||
        this.detectedRepo !== targetDetectedRepo ||
        this.selectedAccountId !== targetAccountId
      ) {
        return;
      }
      this.error = err instanceof Error ? err.message : 'Failed to load merge requests';
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

  protected override isConnectedForComments(): boolean {
    return this.isConnectedForDetectedRepo();
  }

  protected getCommentsOutboundHost(repo: DetectedGitLabRepo): string {
    return repo.instanceUrl || 'https://gitlab.com';
  }

  protected async getTokenForComments(
    targetAccountId: string | null,
  ): Promise<string | null | undefined> {
    return this.getSelectedAccountToken(
      this.detectedRepo?.instanceUrl,
      targetAccountId,
    );
  }

  protected fetchPrComments(
    repo: DetectedGitLabRepo,
    mrIid: number,
    token: string | null | undefined,
  ) {
    return invokeCommand<PrReviewComment[]>('get_gitlab_mr_comments', {
      instanceUrl: repo.instanceUrl,
      projectPath: repo.projectPath,
      mrIid,
      token,
    });
  }

  protected postPrComment(
    repo: DetectedGitLabRepo,
    mrIid: number,
    rawBody: string,
    filePath: string | undefined,
    line: number | undefined,
    _commitId: string | undefined,
    token: string | null | undefined,
  ) {
    const body = filePath ? `[${filePath}${line ? `:${line}` : ''}] ${rawBody}` : rawBody;
    return invokeCommand<PrReviewComment>('add_gitlab_mr_comment', {
      instanceUrl: repo.instanceUrl,
      projectPath: repo.projectPath,
      mrIid,
      body,
      token,
    });
  }

  private async loadIssues(): Promise<void> {
    if (!this.detectedRepo || !this.isConnectedForDetectedRepo()) return;

    const targetRepoPath = this.repositoryPath;
    const targetDetectedRepo = this.detectedRepo;
    const targetAccountId = this.selectedAccountId;

    try {
      const token = await this.getSelectedAccountToken();
      const result = await gitService.listGitLabIssues(
        targetDetectedRepo.instanceUrl,
        targetDetectedRepo.projectPath,
        this.issueFilter === 'all' ? undefined : this.issueFilter,
        undefined, // labels
        GITLAB_LIST_PAGE_SIZE,
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
    if (!this.detectedRepo || !this.isConnectedForDetectedRepo()) return;

    const targetRepoPath = this.repositoryPath;
    const targetDetectedRepo = this.detectedRepo;
    const targetAccountId = this.selectedAccountId;

    try {
      const token = await this.getSelectedAccountToken();
      const result = await gitService.listGitLabPipelines(
        targetDetectedRepo.instanceUrl,
        targetDetectedRepo.projectPath,
        undefined, // status
        GITLAB_PIPELINE_PAGE_SIZE,
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

  private async loadLabels(): Promise<void> {
    if (!this.detectedRepo || !this.isConnectedForDetectedRepo()) return;

    const targetRepoPath = this.repositoryPath;
    const targetDetectedRepo = this.detectedRepo;
    const targetAccountId = this.selectedAccountId;

    try {
      const token = await this.getSelectedAccountToken();
      const result = await gitService.getGitLabLabels(
        targetDetectedRepo.instanceUrl,
        targetDetectedRepo.projectPath,
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
        this.labels = result.data;
        // A different project (account/repo switch) has a different label set —
        // drop selections that no longer exist so they can't be submitted invisibly.
        this.createIssueLabels = this.createIssueLabels.filter(l => this.labels.includes(l));
      } else if (!result.success) {
        this.error = result.error?.message ?? 'Failed to load labels';
      }
    } catch (err) {
      if (
        this.repositoryPath !== targetRepoPath ||
        this.detectedRepo !== targetDetectedRepo ||
        this.selectedAccountId !== targetAccountId
      ) {
        return;
      }
      this.error = err instanceof Error ? err.message : 'Failed to load labels';
    }
  }

  private async handleSaveToken(): Promise<void> {
    if (!this.tokenInput.trim() || !this.instanceUrlInput.trim()) return;

    const generation = this.beginAccountOp();
    const tokenToSave = this.tokenInput.trim();
    const instanceUrl = this.instanceUrlInput.trim();
    const targetAccountId = this.selectedAccountId;
    const targetWasAddingAccount = this.isAddingAccount;

    try {
      // First verify the token works by checking connection
      const verifyResult = await gitService.checkGitLabConnectionWithToken(instanceUrl, tokenToSave);
      if (!verifyResult.success || !verifyResult.data?.connected) {
        if (generation === this.loadGeneration) {
          this.error = verifyResult.error?.message ?? 'Invalid token or connection failed';
        }
        return;
      }

      const user = verifyResult.data.user;
      const selectedAccount = targetAccountId
        ? (getAccountById(targetAccountId) ??
          this.accounts.find((a) => a.id === targetAccountId))
        : undefined;
      const selectedAccountInstance =
        selectedAccount?.config.type === 'gitlab'
          ? selectedAccount.config.instanceUrl
          : undefined;
      const canUpdateSelectedAccount =
        Boolean(targetAccountId) &&
        !targetWasAddingAccount &&
        (!selectedAccountInstance ||
          this.normalizeInstanceUrl(selectedAccountInstance) ===
            this.normalizeInstanceUrl(instanceUrl));

      let connectedAccountId: string;

      // If we have a selected account for this same instance, save token to that account
      if (targetAccountId && canUpdateSelectedAccount) {
        await credentialService.storeAccountToken('gitlab', targetAccountId, tokenToSave);
        // Refresh cachedUser so the profile manager shows the up-to-date
        // avatar/username immediately instead of waiting for background validation.
        if (user) {
          await unifiedProfileService.updateGlobalAccountCachedUser(targetAccountId, {
            username: user.username,
            displayName: user.name ?? null,
            email: null, // GitLab API doesn't return email in user object
            avatarUrl: user.avatarUrl ?? null,
          });
        }
        connectedAccountId = targetAccountId;
      } else {
        // No account selected - create a new global account
        const { createEmptyIntegrationAccount, generateId } = await import('../../types/unified-profile.types.ts');
        const newAccount: IntegrationAccount = {
          ...createEmptyIntegrationAccount('gitlab', instanceUrl),
          id: generateId(),
          name: user?.username ? `GitLab (${user.username})` : 'GitLab Account',
          isDefault: this.accounts.length === 0,
          cachedUser: user ? {
            username: user.username,
            displayName: user.name ?? null,
            email: null, // GitLab API doesn't return email in user object
            avatarUrl: user.avatarUrl ?? null,
          } : null,
        };

        const savedAccount = await unifiedProfileService.saveGlobalAccount(newAccount);
        await credentialService.storeAccountToken('gitlab', savedAccount.id, tokenToSave);
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
        this.accounts = getAccountsByType('gitlab');
      }

      unifiedProfileStore
        .getState()
        .setAccountConnectionStatus(connectedAccountId, 'connected');
      if (this.tokenInput.trim() === tokenToSave) {
        this.tokenInput = '';
      }

      if (generation !== this.loadGeneration || this.selectedAccountId !== connectedAccountId) return;
      this.connectionStatus = verifyResult.data;

      if (this.repositoryPath && !this.detectedRepo) {
        await this.detectRepo(false, false);
      }

      if (generation !== this.loadGeneration || this.selectedAccountId !== connectedAccountId) return;
      // Load data if connected and repo detected on this instance
      if (
        this.connectionStatus?.connected &&
        this.detectedRepo &&
        this.normalizeInstanceUrl(this.detectedRepo.instanceUrl) ===
          this.normalizeInstanceUrl(instanceUrl)
      ) {
        await this.loadAllData();
      }
    } catch (err) {
      if (generation !== this.loadGeneration) return;
      this.error = err instanceof Error ? err.message : 'Failed to connect';
      this.tokenInput = tokenToSave;
    } finally {
      this.finishAccountOp(generation);
    }
  }

  private async handleDisconnect(): Promise<void> {
    const targetAccountId = this.selectedAccountId;

    await this.runDisconnectOperation(
      async () => {
        if (targetAccountId) {
          await credentialService.deleteAccountToken('gitlab', targetAccountId);
        } else {
          await gitService.deleteGitLabToken();
        }
      },
      () => {
        this.connectionStatus = {
          connected: false,
          user: null,
          instanceUrl: this.instanceUrlInput || 'https://gitlab.com',
        };
        this.mergeRequests = [];
        this.issues = [];
        this.pipelines = [];
        this.labels = [];
        this.createIssueLabels = [];
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
      providerLabel: 'GitLab',
      deleteCredentials: async (target) => {
        await credentialService.deleteAccountToken('gitlab', target.id);
      },
      getRemainingAccounts: () => getAccountsByType('gitlab'),
      onDeleted: async (nextAccountId) => {
        const nextAccount = this.accounts.length > 0 ? this.accounts[0] : null;
        this.instanceUrlInput =
          (nextAccount?.config.type === 'gitlab' && nextAccount.config.instanceUrl) ||
          this.detectedRepo?.instanceUrl ||
          'https://gitlab.com';
        this.mergeRequests = [];
        this.issues = [];
        this.pipelines = [];
        this.labels = [];
        this.createIssueLabels = [];

        if (nextAccountId) {
          await this.loadInitialData();
        }
      },
    });
  }

  /**
   * Start OAuth flow for GitLab
   */
  private async handleStartOAuth(): Promise<void> {
    const clientId = getClientId('gitlab');
    if (!clientId) {
      this.error = 'GitLab OAuth is not configured. Please use a Personal Access Token.';
      this.authMethod = 'pat';
      return;
    }

    this.error = null;
    this.oauthTargetAccountId = this.selectedAccountId;
    this.oauthTargetWasAddingAccount = this.isAddingAccount;
    this.oauthTargetInstanceUrl = this.instanceUrlInput;
    // Pass instance URL for self-hosted GitLab
    const instanceUrl = this.instanceUrlInput !== 'https://gitlab.com' ? this.instanceUrlInput : undefined;
    // `startOAuth` never rejects — it reports failure through the OAuth state
    // subscriber — so the pinned target is cleared there, not here.
    await oauthService.startOAuth('gitlab', clientId, instanceUrl);
  }

  /**
   * Abandon a sign-in that is waiting on the browser. Without this the whole
   * connect form stays disabled until the backend loopback wait times out. The
   * local state is set explicitly rather than relying on the service's
   * notification, so the form can never stay stuck if there is no pending entry
   * to cancel.
   */
  private handleCancelOAuth(): void {
    oauthService.cancelOAuth('gitlab');
    this.oauthState = { status: 'idle' };
    this.error = null;
    // Abandoned flow: release the pinned target so a stray late completion
    // can't be attributed to the account this flow started on.
    this.oauthTargetAccountId = undefined;
    this.oauthTargetWasAddingAccount = undefined;
    this.oauthTargetInstanceUrl = undefined;
  }

  /**
   * Handle OAuth completion
   */
  private async handleOAuthComplete(tokens: OAuthTokenResponse, instanceUrl?: string): Promise<void> {
    log.debug('handleOAuthComplete called', {
      hasAccessToken: !!tokens?.accessToken,
      instanceUrl,
      currentInstanceUrl: this.instanceUrlInput,
    });

    // OAuth can complete after the dialog was closed; still persist the account
    // but surface a toast instead of the (invisible) inline status.
    const wasOpen = this.open;
    const targetAccountId =
      this.oauthTargetAccountId !== undefined
        ? this.oauthTargetAccountId
        : this.selectedAccountId;
    const targetWasAddingAccount =
      this.oauthTargetWasAddingAccount ?? this.isAddingAccount;
    // The callback's instance URL wins; otherwise use the one the flow started
    // with, not whatever a mid-flow account switch left in the form.
    const targetInstanceUrl =
      instanceUrl ?? this.oauthTargetInstanceUrl ?? this.instanceUrlInput;
    this.oauthTargetAccountId = undefined;
    this.oauthTargetWasAddingAccount = undefined;
    this.oauthTargetInstanceUrl = undefined;

    const selectionChangedDuringOAuth = (): boolean =>
      this.selectedAccountId !== targetAccountId ||
      this.isAddingAccount !== targetWasAddingAccount;
    const invalidatedLoad = !selectionChangedDuringOAuth();
    const generation = this.beginAccountOp(invalidatedLoad);
    const targetAccountExists = (): boolean =>
      !targetAccountId ||
      getAccountsByType('gitlab').some((account) => account.id === targetAccountId);
    let applyOAuthResultToSelection = false;
    let connectedAccountId: string | undefined;

    try {
      log.debug('Verifying token', { instanceUrl: targetInstanceUrl });

      // Verify the token works
      const verifyResult = await gitService.checkGitLabConnectionWithToken(
        targetInstanceUrl,
        tokens.accessToken
      );

      log.debug('Token verification result', {
        success: verifyResult.success,
        connected: verifyResult.data?.connected,
        user: verifyResult.data?.user?.username,
      });

      if (!verifyResult.success || !verifyResult.data?.connected) {
        this.error = verifyResult.error?.message ?? 'OAuth token verification failed';
        return;
      }

      const user = verifyResult.data.user;
      if (!targetAccountExists()) {
        this.error = 'The GitLab account was removed before sign-in completed. Please sign in again.';
        showToast(this.error, 'error');
        return;
      }

      log.debug('Account state', {
        targetAccountId,
        accountsCount: this.accounts.length,
      });

      // Find existing account for this instance URL, or use the account the flow
      // targeted (when its configured instance matches). When the user explicitly
      // chose "Add account", never match an existing same-instance account — that
      // would clobber it instead of creating the new account they asked for.
      const targetAccount = targetAccountId ? getAccountById(targetAccountId) : undefined;
      const targetAccountMatchesInstance =
        targetAccount &&
        (targetAccount.config.type !== 'gitlab' ||
          !targetAccount.config.instanceUrl ||
          this.normalizeInstanceUrl(targetAccount.config.instanceUrl) ===
            this.normalizeInstanceUrl(targetInstanceUrl));
      const existingAccount = targetAccountMatchesInstance
        ? targetAccount
        : targetWasAddingAccount
          ? undefined
          : this.accounts.find((a) =>
              a.config.type === 'gitlab' &&
              this.normalizeInstanceUrl(a.config.instanceUrl) ===
                this.normalizeInstanceUrl(targetInstanceUrl)
            );

      if (existingAccount) {
        // Update existing account with OAuth token
        log.debug('Updating existing account', { accountId: existingAccount.id });
        await credentialService.storeAccountOAuthToken(
          'gitlab',
          existingAccount.id,
          tokens.accessToken,
          tokens.refreshToken,
          tokens.expiresIn
        );
        if (existingAccount.id === targetAccountId && !targetAccountExists()) {
          // Deleted between the existence check and the write — don't leave an
          // orphaned credential behind for an account that no longer exists.
          await credentialService.deleteAccountToken('gitlab', existingAccount.id);
          this.error = 'The GitLab account was removed before sign-in completed. Please sign in again.';
          showToast(this.error, 'error');
          return;
        }

        // Update cached user info
        if (user) {
          await unifiedProfileService.updateGlobalAccountCachedUser(existingAccount.id, {
            username: user.username,
            displayName: user.name ?? null,
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
        log.debug('Creating new global account');
        const { createEmptyIntegrationAccount, generateId } = await import('../../types/unified-profile.types.ts');
        const newAccount: IntegrationAccount = {
          ...createEmptyIntegrationAccount('gitlab', targetInstanceUrl),
          id: generateId(),
          name: user?.username ? `GitLab (${user.username})` : 'GitLab Account',
          isDefault: this.accounts.length === 0,
          cachedUser: user ? {
            username: user.username,
            displayName: user.name ?? null,
            email: null,
            avatarUrl: user.avatarUrl ?? null,
          } : null,
        };

        log.debug('New account to create', { id: newAccount.id, name: newAccount.name });
        const savedAccount = await unifiedProfileService.saveGlobalAccount(newAccount);
        log.debug('Saved account', { id: savedAccount.id });
        await credentialService.storeAccountOAuthToken(
          'gitlab',
          savedAccount.id,
          tokens.accessToken,
          tokens.refreshToken,
          tokens.expiresIn
        );

        // Refresh accounts list
        await unifiedProfileService.loadUnifiedProfiles();
        this.accounts = getAccountsByType('gitlab');
        log.debug('Account created', { count: this.accounts.length });
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
        // the GitHub/OIDC dialogs) instead of staying stale until restart.
        unifiedProfileStore
          .getState()
          .setAccountConnectionStatus(connectedAccountId, 'connected');
      }
      if (!applyOAuthResultToSelection) {
        // The user moved on to a different account mid-flow: the token is saved
        // on the account the flow targeted, but the dialog's visible state must
        // keep describing the account they are looking at now.
        this.oauthState = { status: 'idle' };
        showToast(
          user?.username ? `Connected GitLab account @${user.username}` : 'Connected GitLab account',
          'success'
        );
        return;
      }

      this.instanceUrlInput = targetInstanceUrl;

      // Force UI update
      this.requestUpdate();

      this.connectionStatus = verifyResult.data;
      this.oauthState = { status: 'idle' };

      // If the dialog was closed before OAuth completed, surface a toast so the
      // connection isn't a silent no-op.
      if (!wasOpen) {
        showToast(
          user?.username ? `Connected GitLab account @${user.username}` : 'Connected GitLab account',
          'success'
        );
      }

      if (wasOpen && this.repositoryPath && !this.detectedRepo) {
        await this.detectRepo(false, false);
      }

      if (generation !== this.loadGeneration || this.selectedAccountId !== connectedAccountId) return;
      // Load data if connected and repo detected on this instance
      if (
        wasOpen &&
        this.connectionStatus?.connected &&
        this.detectedRepo &&
        this.normalizeInstanceUrl(this.detectedRepo.instanceUrl) ===
          this.normalizeInstanceUrl(targetInstanceUrl)
      ) {
        await this.loadAllData();
      }
    } catch (err) {
      if (connectedAccountId === targetAccountId && targetAccountId && !targetAccountExists()) {
        await credentialService.deleteAccountToken('gitlab', targetAccountId);
      }
      if (invalidatedLoad && generation === this.loadGeneration) {
        this.error = err instanceof Error ? err.message : 'Failed to complete OAuth';
      }
    } finally {
      this.finishAccountOp(invalidatedLoad ? generation : undefined);
    }
  }

  private async handleMrFilterChange(e: Event): Promise<void> {
    this.mrFilter = (e.target as HTMLSelectElement).value as 'opened' | 'merged' | 'closed' | 'all';
    await this.loadMergeRequests();
  }

  private async handleIssueFilterChange(e: Event): Promise<void> {
    this.issueFilter = (e.target as HTMLSelectElement).value as 'opened' | 'closed' | 'all';
    await this.loadIssues();
  }

  private async handleGenerateMrDescription(): Promise<void> {
    if (!this.repositoryPath || !this.createMrSource || !this.createMrTarget) return;

    const repoPath = this.repositoryPath;
    const repoGen = this.repoGeneration;
    this.generatingMrDescription = true;
    try {
      const result = await aiService.generatePrDescription(
        repoPath,
        this.createMrTarget,
        this.createMrSource,
        this.createMrTitle || 'Untitled MR',
      );
      if (this.repositoryPath !== repoPath || this.repoGeneration !== repoGen) return;

      if (result.success && result.data) {
        this.createMrDescription = result.data.body;
      } else {
        showToast(result.error?.message ?? 'Failed to generate description', 'error');
      }
    } finally {
      if (this.repositoryPath === repoPath && this.repoGeneration === repoGen) {
        this.generatingMrDescription = false;
      }
    }
  }

  private async handleCreateMr(): Promise<void> {
    if (!this.detectedRepo || !this.createMrTitle.trim() || !this.createMrSource.trim() || !this.createMrTarget.trim()) return;

    const input: CreateMergeRequestInput = {
      title: this.createMrTitle,
      description: this.createMrDescription || undefined,
      sourceBranch: this.createMrSource,
      targetBranch: this.createMrTarget,
      draft: this.createMrDraft,
    };

    await this.runCreateOperation({
      successMessage: 'Merge request created successfully',
      failureMessage: 'Failed to create merge request',
      getToken: (targetAccountId) =>
        this.getSelectedAccountToken(
          this.detectedRepo?.instanceUrl,
          targetAccountId,
        ),
      execute: (repo, token) =>
        gitService.createGitLabMergeRequest(repo.instanceUrl, repo.projectPath, input, token),
      onSuccess: async () => {
        this.createMrTitle = '';
        this.createMrDescription = '';
        this.createMrSource = '';
        this.createMrTarget = '';
        this.createMrDraft = false;
        this.activeTab = 'merge-requests';
        await this.loadMergeRequests();
      },
    });
  }

  private async handleCreateIssue(): Promise<void> {
    if (!this.detectedRepo || !this.createIssueTitle.trim()) return;

    const input: CreateGitLabIssueInput = {
      title: this.createIssueTitle,
      description: this.createIssueDescription || undefined,
      labels: this.createIssueLabels.length > 0 ? [...this.createIssueLabels] : undefined,
    };

    await this.runCreateOperation({
      successMessage: 'Issue created successfully',
      failureMessage: 'Failed to create issue',
      getToken: (targetAccountId) =>
        this.getSelectedAccountToken(
          this.detectedRepo?.instanceUrl,
          targetAccountId,
        ),
      execute: (repo, token) =>
        gitService.createGitLabIssue(repo.instanceUrl, repo.projectPath, input, token),
      onSuccess: async () => {
        this.createIssueTitle = '';
        this.createIssueDescription = '';
        this.createIssueLabels = [];
        this.activeTab = 'issues';
        await this.loadIssues();
      },
    });
  }

  private toggleCreateIssueLabel(label: string): void {
    this.createIssueLabels = this.createIssueLabels.includes(label)
      ? this.createIssueLabels.filter(l => l !== label)
      : [...this.createIssueLabels, label];
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
            : html`<div class="user-avatar-placeholder">${this.getInitials(user.name)}</div>`
          }
          <div class="user-info">
            <div class="user-name">${user.name}</div>
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
    const oauthConfigured = isOAuthConfigured('gitlab');

    return html`
      <div class="token-form">
        <div class="form-group">
          <label>GitLab Instance URL</label>
          <input
            type="text"
            placeholder="https://gitlab.com"
            .value=${this.instanceUrlInput}
            @input=${(e: Event) => this.instanceUrlInput = (e.target as HTMLInputElement).value}
            ?disabled=${isOAuthPending}
          />
          <span class="help-text">
            Use https://gitlab.com for GitLab.com or your self-hosted instance URL
          </span>
        </div>

        ${oauthConfigured ? html`
          <div class="auth-method-toggle">
            <button
              class="btn ${this.authMethod === 'oauth' ? 'active' : ''}"
              @click=${() => this.authMethod = 'oauth'}
              ?disabled=${isOAuthPending}
            >
              Sign in with GitLab
            </button>
            <button
              class="btn ${this.authMethod === 'pat' ? 'active' : ''}"
              @click=${() => this.authMethod = 'pat'}
              ?disabled=${isOAuthPending}
            >
              Personal Access Token
            </button>
          </div>
        ` : ''}

        ${this.authMethod === 'oauth' && oauthConfigured ? html`
          <button
            class="btn-oauth"
            @click=${this.handleStartOAuth}
            ?disabled=${isOAuthPending || this.isLoading || this.isDetectingRepo || !this.instanceUrlInput.trim()}
          >
            ${isOAuthPending ? html`
              <div class="oauth-spinner"></div>
              <span>${this.oauthState.status === 'exchanging' ? 'Completing sign in...' : 'Waiting for browser...'}</span>
            ` : html`
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 00-.867 0L16.418 9.45H7.582L4.918 1.263a.455.455 0 00-.867 0L1.387 9.452.045 13.587a.924.924 0 00.331 1.023L12 23.054l11.624-8.443a.92.92 0 00.331-1.024"/>
              </svg>
              <span>Sign in with GitLab</span>
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
          <label>Personal Access Token</label>
          <input
            type="password"
            placeholder="glpat-xxxxxxxxxxxxxxxxxxxx"
            .value=${this.tokenInput}
            @input=${(e: Event) => this.tokenInput = (e.target as HTMLInputElement).value}
            ?disabled=${isOAuthPending}
          />
          <span class="help-text">
            Create a token at
            <a
              class="help-link"
              href="${this.instanceUrlInput}/-/user_settings/personal_access_tokens"
              @click=${handleExternalLink}
            >GitLab Settings</a>
            with <code>api</code> scope.
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
            @click=${this.handleSaveToken}
            ?disabled=${this.isLoading || isOAuthPending || this.isDetectingRepo || !this.tokenInput.trim() || !this.instanceUrlInput.trim()}
          >
            Connect with Token
          </button>
        </div>
      </div>
    `;
  }

  private renderMergeRequestsTab() {
    if (!this.isConnectedForDetectedRepo()) {
      return this.renderNotConnected('merge requests');
    }

    if (!this.detectedRepo) {
      return this.renderNoRepo();
    }

    return html`
      <div class="filter-row">
        <select class="filter-select" @change=${this.handleMrFilterChange}>
          <option value="opened" ?selected=${this.mrFilter === 'opened'}>Open</option>
          <option value="merged" ?selected=${this.mrFilter === 'merged'}>Merged</option>
          <option value="closed" ?selected=${this.mrFilter === 'closed'}>Closed</option>
          <option value="all" ?selected=${this.mrFilter === 'all'}>All</option>
        </select>
        <button class="btn" @click=${() => this.activeTab = 'create-mr'}>
          + New MR
        </button>
      </div>

      ${this.isLoading ? html`<div class="loading">Loading merge requests...</div>` : ''}

      ${!this.isLoading && this.mergeRequests.length === 0 ? html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="18" cy="18" r="3"></circle>
            <circle cx="6" cy="6" r="3"></circle>
            <path d="M6 21V9a9 9 0 0 0 9 9"></path>
          </svg>
          <p>No ${this.mrFilter} merge requests</p>
        </div>
      ` : ''}

      <div class="mr-list">
        ${this.mergeRequests.map(mr => html`
          <div class="pr-card-wrapper">
            <div class="mr-item" @click=${() => this.openInBrowser(mr.webUrl)}>
              <span class="mr-number">!${mr.iid}</span>
              <div class="mr-info">
                <div class="mr-title">${mr.title}</div>
                <div class="mr-meta">
                  <span class="mr-state ${mr.draft ? 'draft' : mr.state}">${mr.draft ? 'Draft' : mr.state}</span>
                  <span class="mr-branch">${mr.sourceBranch} → ${mr.targetBranch}</span>
                  <span>by ${mr.author.name}</span>
                  <span>${this.formatDate(mr.createdAt)}</span>
                </div>
              </div>
              <div class="pr-actions" @click=${(e: Event) => e.stopPropagation()}>
                <button
                  class="btn pr-comments-toggle"
                  data-testid="pr-comments-toggle-${mr.iid}"
                  title="Review comments"
                  @click=${() => this.togglePrComments(mr.iid)}
                >
                  Comments${this.prComments[mr.iid] ? ` (${this.prComments[mr.iid].length})` : ''}
                </button>
              </div>
            </div>
            ${this.expandedPrNumber === mr.iid ? this.renderPrCommentsDrawer(mr.iid) : nothing}
          </div>
        `)}
      </div>
      ${this.renderCappedListHint(
        this.mergeRequests.length,
        GITLAB_LIST_PAGE_SIZE,
        'merge requests',
        'merge_requests',
        this.mrFilter,
      )}
    `;
  }

  private renderIssuesTab() {
    if (!this.isConnectedForDetectedRepo()) {
      return this.renderNotConnected('issues');
    }

    if (!this.detectedRepo) {
      return this.renderNoRepo();
    }

    return html`
      <div class="filter-row">
        <select class="filter-select" @change=${this.handleIssueFilterChange}>
          <option value="opened" ?selected=${this.issueFilter === 'opened'}>Open</option>
          <option value="closed" ?selected=${this.issueFilter === 'closed'}>Closed</option>
          <option value="all" ?selected=${this.issueFilter === 'all'}>All</option>
        </select>
        <button class="btn" @click=${() => { this.activeTab = 'create-issue'; this.loadLabels(); }}>
          + New Issue
        </button>
      </div>

      ${this.issues.length === 0 ? html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <p>No ${this.issueFilter} issues</p>
        </div>
      ` : ''}

      <div class="issue-list">
        ${this.issues.map(issue => html`
          <div class="issue-item" @click=${() => this.openInBrowser(issue.webUrl)}>
            <span class="issue-number">#${issue.iid}</span>
            <div class="issue-info">
              <div class="issue-title">${issue.title}</div>
              <div class="issue-meta">
                <span class="issue-state ${issue.state}">${issue.state}</span>
                <span>by ${issue.author.name}</span>
                <span>${this.formatDate(issue.createdAt)}</span>
              </div>
              ${issue.labels.length > 0 ? html`
                <div class="issue-labels">
                  ${issue.labels.map(label => html`
                    <span class="issue-label">${label}</span>
                  `)}
                </div>
              ` : ''}
            </div>
          </div>
        `)}
      </div>
      ${this.renderCappedListHint(
        this.issues.length,
        GITLAB_LIST_PAGE_SIZE,
        'issues',
        'issues',
        this.issueFilter,
      )}
    `;
  }

  private renderPipelinesTab() {
    if (!this.isConnectedForDetectedRepo()) {
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
          <p>No pipelines found</p>
        </div>
      `;
    }

    return html`
      <div class="pipeline-list">
        ${this.pipelines.map(pipeline => html`
          <div class="pipeline-item" @click=${() => this.openInBrowser(pipeline.webUrl)}>
            <div class="pipeline-status ${pipeline.status}"></div>
            <div class="pipeline-info">
              <div class="pipeline-ref">${pipeline.ref}</div>
              <div class="pipeline-meta">
                <span>#${pipeline.iid}</span>
                <span>${pipeline.status}</span>
                <span>${this.formatDate(pipeline.createdAt)}</span>
                <span>${pipeline.sha.substring(0, 8)}</span>
              </div>
            </div>
          </div>
        `)}
      </div>
      ${this.renderCappedListHint(
        this.pipelines.length,
        GITLAB_PIPELINE_PAGE_SIZE,
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
    const base = this.detectedRepo.instanceUrl.replace(/\/$/, '');
    const query = state ? `?state=${encodeURIComponent(state)}` : '';
    return html`
      <p class="help-text capped-list-hint" style="text-align:center;padding-top:8px">
        Showing the first ${limit} ${label}; more may exist.
        <a
          class="help-link"
          href="${base}/${this.detectedRepo.projectPath}/-/${route}${query}"
          @click=${handleExternalLink}
        >Open in GitLab</a> for the full list.
      </p>
    `;
  }

  private renderCreateMrTab() {
    return html`
      <div class="token-form">
        <div class="form-group">
          <label>Title</label>
          <input
            type="text"
            placeholder="Merge request title"
            .value=${this.createMrTitle}
            @input=${(e: Event) => this.createMrTitle = (e.target as HTMLInputElement).value}
          />
        </div>
        <div class="form-group">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <label>Description</label>
            <button
              class="btn btn-sm"
              style="font-size:12px;padding:2px 8px;display:flex;align-items:center;gap:4px"
              @click=${this.handleGenerateMrDescription}
              ?disabled=${this.generatingMrDescription || !this.createMrSource || !this.createMrTarget}
              title="Generate description using AI"
            >
              ${this.generatingMrDescription ? 'Generating...' : html`<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a3.5 3.5 0 0 0-3.5 3.5c0 1.193.603 2.26 1.5 2.898V9.5a1 1 0 0 0 .293.707l1 1a1 1 0 0 0 1.414 0l1-1A1 1 0 0 0 10 9.5V7.398A3.496 3.496 0 0 0 11.5 4.5 3.5 3.5 0 0 0 8 1z"/></svg> AI Generate`}
            </button>
          </div>
          <textarea
            placeholder="Describe your changes..."
            .value=${this.createMrDescription}
            @input=${(e: Event) => this.createMrDescription = (e.target as HTMLTextAreaElement).value}
          ></textarea>
        </div>
        <div class="form-group">
          <label>Source Branch</label>
          <input
            type="text"
            placeholder="feature/my-branch"
            .value=${this.createMrSource}
            @input=${(e: Event) => this.createMrSource = (e.target as HTMLInputElement).value}
          />
        </div>
        <div class="form-group">
          <label>Target Branch</label>
          <input
            type="text"
            placeholder="main"
            .value=${this.createMrTarget}
            @input=${(e: Event) => this.createMrTarget = (e.target as HTMLInputElement).value}
          />
        </div>
        <div class="form-group">
          <div class="checkbox-group">
            <input
              type="checkbox"
              id="mr-draft"
              .checked=${this.createMrDraft}
              @change=${(e: Event) => this.createMrDraft = (e.target as HTMLInputElement).checked}
            />
            <label for="mr-draft">Create as draft</label>
          </div>
        </div>
        <div class="btn-row">
          <button class="btn" @click=${() => this.activeTab = 'merge-requests'}>
            Cancel
          </button>
          <button
            class="btn btn-primary"
            @click=${this.handleCreateMr}
            ?disabled=${this.isLoading || !this.detectedRepo || !this.createMrTitle.trim() || !this.createMrSource.trim() || !this.createMrTarget.trim()}
          >
            Create Merge Request
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
            .value=${this.createIssueDescription}
            @input=${(e: Event) => this.createIssueDescription = (e.target as HTMLTextAreaElement).value}
          ></textarea>
        </div>
        ${this.labels.length > 0 ? html`
          <div class="form-group">
            <label>Labels</label>
            <div class="label-picker">
              ${this.labels.map(label => html`
                <button
                  type="button"
                  class="label-chip ${this.createIssueLabels.includes(label) ? 'selected' : ''}"
                  aria-pressed=${this.createIssueLabels.includes(label) ? 'true' : 'false'}
                  @click=${() => this.toggleCreateIssueLabel(label)}
                >
                  ${label}
                </button>
              `)}
            </div>
          </div>
        ` : ''}
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
    const mismatch =
      this.connectionStatus?.connected &&
      this.detectedRepo &&
      this.connectionStatus.instanceUrl &&
      this.normalizeInstanceUrl(this.connectionStatus.instanceUrl) !==
        this.normalizeInstanceUrl(this.detectedRepo.instanceUrl);
    return html`
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"></path>
        </svg>
        <p>
          ${mismatch
            ? `Connected to ${this.connectionStatus?.instanceUrl}, not ${this.detectedRepo?.instanceUrl}. Connect to GitLab (${this.detectedRepo?.instanceUrl}) to view ${feature}`
            : `Connect to GitLab to view ${feature}`}
        </p>
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
          <div class="repo-name">${this.detectedRepo.projectPath}</div>
          <div class="repo-remote">${this.detectedRepo.instanceUrl} via ${this.detectedRepo.remoteName}</div>
        </div>
      </div>
    `;
  }

  /**
   * Open the create-merge-request form with `sourceBranch` prefilled as the
   * source branch.
   *
   * The entry point for the sidebar's branch context menu, which deliberately
   * does NOT build its own create flow: this dialog already owns the form, the
   * account selection and the create call, so the menu reuses them. `baseBranch`
   * is only a suggestion and is applied ONLY when the field is still empty, so
   * a draft the user already typed here is never overwritten.
   */
  public startCreateMergeRequest(sourceBranch: string, baseBranch?: string): void {
    this.createMrSource = sourceBranch;
    if (baseBranch && !this.createMrTarget) {
      this.createMrTarget = baseBranch;
    }
    this.activeTab = 'create-mr';
  }

  render() {
    return html`
      <gn-modal
        .open=${this.open}
        ?backButton=${this.backButton}
        modalTitle="GitLab"
        @close=${this.handleClose}
      >
        <div class="content">
          ${this.attachToProfileName
            ? html`<div class="attach-breadcrumb" data-testid="attach-breadcrumb">Adding to <strong>${this.attachToProfileName}</strong></div>`
            : nothing}
          ${this.renderDetectedRepo()}

          ${this.accounts.length > 0 || this.connectionStatus?.connected ? html`
            <gn-account-selector
              integrationType="gitlab"
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
              class="tab ${this.activeTab === 'merge-requests' ? 'active' : ''}"
              @click=${() => { this.activeTab = 'merge-requests'; this.loadMergeRequests(); }}
            >
              Merge Requests
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
            ${this.activeTab === 'merge-requests' ? this.renderMergeRequestsTab() : ''}
            ${this.activeTab === 'issues' ? this.renderIssuesTab() : ''}
            ${this.activeTab === 'pipelines' ? this.renderPipelinesTab() : ''}
            ${this.activeTab === 'create-mr' ? this.renderCreateMrTab() : ''}
            ${this.activeTab === 'create-issue' ? this.renderCreateIssueTab() : ''}
          </div>
        </div>
      </gn-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-gitlab-dialog': GnGitLabDialog;
  }
}
