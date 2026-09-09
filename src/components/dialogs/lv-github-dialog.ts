/**
 * GitHub Integration Dialog
 * Manage GitHub connection, view PRs, and check Actions status
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { loggers, openExternalUrl, handleExternalLink } from '../../utils/index.ts';
import type {
  GitHubConnectionStatus,
  DetectedGitHubRepo,
  PullRequestSummary,
  WorkflowRun,
  CreatePullRequestInput,
  IssueSummary,
  CreateIssueInput,
  Label,
  ReleaseSummary,
  CreateReleaseInput,
} from '../../services/git.service.ts';
import { unifiedProfileStore, getAccountsByType, selectDefaultGlobalAccount, getActiveProfilePreferredAccount } from '../../stores/unified-profile.store.ts';
import * as unifiedProfileService from '../../services/unified-profile.service.ts';
import type { IntegrationAccount } from '../../types/unified-profile.types.ts';
import * as credentialService from '../../services/credential.service.ts';
import * as oauthService from '../../services/oauth.service.ts';
import { getClientId, isOAuthConfigured } from '../../services/oauth.service.ts';
import type { OAuthFlowState, OAuthTokenResponse } from '../../types/oauth.types.ts';
import * as aiService from '../../services/ai.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import './lv-modal.ts';
import './lv-account-selector.ts';

const log = loggers.github;

/**
 * How many entries each list tab asks GitHub for per page. A full page back
 * means there may be more, which is what puts the "Load more" button on screen.
 */
const PR_PAGE_SIZE = 30;
const ISSUE_PAGE_SIZE = 30;
const RELEASE_PAGE_SIZE = 20;
const WORKFLOW_PAGE_SIZE = 20;

type TabType = 'connection' | 'pull-requests' | 'issues' | 'releases' | 'actions' | 'create-pr' | 'create-issue' | 'create-release';

@customElement('lv-github-dialog')
export class LvGitHubDialog extends LitElement {
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

      /* Connection Tab */
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

      .scopes {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-xs);
        margin-top: var(--spacing-xs);
      }

      .scope-badge {
        font-size: var(--font-size-xs);
        padding: 2px 6px;
        background: var(--color-bg-hover);
        border-radius: var(--radius-sm);
        color: var(--color-text-muted);
      }

      .token-form {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
      }

      /* Auth method toggle */
      .auth-method-toggle {
        display: flex;
        gap: var(--spacing-xs);
        padding: var(--spacing-xs);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
      }

      .auth-method-btn {
        flex: 1;
        padding: var(--spacing-sm) var(--spacing-md);
        border: none;
        background: transparent;
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        cursor: pointer;
        border-radius: var(--radius-sm);
        transition: all var(--transition-fast);
      }

      .auth-method-btn:hover:not(:disabled) {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .auth-method-btn.active {
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-weight: var(--font-weight-medium);
      }

      .auth-method-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* OAuth section */
      .oauth-section {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--spacing-md);
        padding: var(--spacing-lg);
      }

      .btn-oauth {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-md) var(--spacing-xl);
        background: #24292e;
        border: none;
        border-radius: var(--radius-md);
        color: white;
        font-size: var(--font-size-md);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .btn-oauth:hover:not(:disabled) {
        background: #2f363d;
      }

      .btn-oauth:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-oauth .github-icon {
        width: 20px;
        height: 20px;
      }

      .oauth-hint {
        font-size: var(--font-size-sm);
        color: var(--color-text-muted);
        text-align: center;
        margin: 0;
      }

      .oauth-pending {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--spacing-md);
        padding: var(--spacing-lg);
      }

      .oauth-spinner {
        width: 32px;
        height: 32px;
        border: 3px solid var(--color-border);
        border-top-color: var(--color-primary);
        border-radius: 50%;
        animation: spin 1s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
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
      .form-group textarea {
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
      .form-group textarea:focus {
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

      /* PR List */
      .pr-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .pr-item {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-md);
        padding: var(--spacing-md);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: background var(--transition-fast);
      }

      .pr-item:hover {
        background: var(--color-bg-hover);
      }

      .pr-number {
        font-weight: var(--font-weight-semibold);
        color: var(--color-primary);
        min-width: 50px;
      }

      .pr-info {
        flex: 1;
        min-width: 0;
      }

      .pr-title {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        margin-bottom: var(--spacing-xs);
      }

      .pr-meta {
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

      .pr-state {
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
      }

      .pr-state.open {
        background: var(--color-success-bg);
        color: var(--color-success);
      }

      .pr-state.closed {
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      .pr-state.merged {
        background: #8250df20;
        color: #8250df;
      }

      .pr-state.draft {
        background: var(--color-bg-hover);
        color: var(--color-text-muted);
      }

      /* Issue styles */
      .issue-item {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-md);
        padding: var(--spacing-md);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: background var(--transition-fast);
      }

      .issue-item:hover {
        background: var(--color-bg-hover);
      }

      .issue-number {
        font-weight: var(--font-weight-semibold);
        color: var(--color-primary);
        min-width: 50px;
      }

      .issue-info {
        flex: 1;
        min-width: 0;
      }

      .issue-title {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        margin-bottom: var(--spacing-xs);
      }

      .issue-meta {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-sm);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .issue-state {
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
      }

      .issue-state.open {
        background: var(--color-success-bg);
        color: var(--color-success);
      }

      .issue-state.closed {
        background: #8250df20;
        color: #8250df;
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
        font-weight: var(--font-weight-medium);
      }

      .issue-comments {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      /* Release styles */
      .release-item {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-md);
        padding: var(--spacing-md);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: background var(--transition-fast);
      }

      .release-item:hover {
        background: var(--color-bg-hover);
      }

      .release-tag {
        font-family: var(--font-family-mono);
        font-weight: var(--font-weight-semibold);
        color: var(--color-primary);
        min-width: 80px;
      }

      .release-info {
        flex: 1;
        min-width: 0;
      }

      .release-title {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        margin-bottom: var(--spacing-xs);
      }

      .release-meta {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-sm);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .release-badge {
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
      }

      .release-badge.latest {
        background: var(--color-success-bg);
        color: var(--color-success);
      }

      .release-badge.prerelease {
        background: var(--color-warning-bg);
        color: var(--color-warning);
      }

      .release-badge.draft {
        background: var(--color-bg-hover);
        color: var(--color-text-muted);
      }

      .pr-stats {
        display: flex;
        gap: var(--spacing-sm);
        font-size: var(--font-size-xs);
      }

      .stat-additions {
        color: var(--color-success);
      }

      .stat-deletions {
        color: var(--color-error);
      }

      /* Workflow Runs */
      .workflow-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .workflow-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        padding: var(--spacing-md);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
      }

      .workflow-status {
        width: 12px;
        height: 12px;
        border-radius: 50%;
      }

      .workflow-status.success {
        background: var(--color-success);
      }

      .workflow-status.failure {
        background: var(--color-error);
      }

      .workflow-status.pending,
      .workflow-status.in_progress {
        background: var(--color-warning);
        animation: pulse 2s infinite;
      }

      .workflow-status.cancelled,
      .workflow-status.skipped {
        background: var(--color-text-muted);
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }

      .workflow-info {
        flex: 1;
        min-width: 0;
      }

      .workflow-name {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
      }

      .workflow-meta {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .workflow-branch {
        font-family: var(--font-family-mono);
      }

      .workflow-link {
        color: var(--color-primary);
        text-decoration: none;
        font-size: var(--font-size-sm);
      }

      .workflow-link:hover {
        text-decoration: underline;
      }

      .load-more {
        display: flex;
        justify-content: center;
        padding: var(--spacing-sm) 0;
      }

      /* Empty/Error States */
      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xl);
        text-align: center;
        color: var(--color-text-muted);
      }

      .empty-state svg {
        width: 48px;
        height: 48px;
        margin-bottom: var(--spacing-md);
        opacity: 0.5;
      }

      .error-message {
        padding: var(--spacing-md);
        background: var(--color-error-bg);
        color: var(--color-error);
        border-radius: var(--radius-md);
        font-size: var(--font-size-sm);
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xl);
        color: var(--color-text-muted);
      }

      /* Buttons */
      .btn-row {
        display: flex;
        gap: var(--spacing-sm);
        margin-top: var(--spacing-md);
      }

      .btn {
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

      /* Filter row */
      .filter-row {
        display: flex;
        gap: var(--spacing-sm);
        margin-bottom: var(--spacing-md);
      }

      .filter-select {
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-secondary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
      }

      /* Detected repo info */
      .repo-info {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        margin-bottom: var(--spacing-md);
      }

      .repo-icon {
        width: 20px;
        height: 20px;
        color: var(--color-text-muted);
      }

      .repo-name {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
      }

      .repo-remote {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: String }) repositoryPath = '';
  /**
   * Show a back arrow instead of a close ×. Set explicitly by the host ONLY when
   * this dialog was opened with a return target (the profile manager), so the
   * arrow's presence reflects HOW the dialog was opened — not unrelated global
   * state.
   */
  @property({ type: Boolean }) backButton = false;
  /**
   * Name of the profile the connected account will be attached to, when opened
   * from the profile manager's attach flow. Drives the "Adding to <name>"
   * breadcrumb. Empty when opened standalone.
   */
  @property({ type: String }) attachToProfileName = '';

  @state() private activeTab: TabType = 'connection';
  @state() private connectionStatus: GitHubConnectionStatus | null = null;
  @state() private detectedRepo: DetectedGitHubRepo | null = null;
  @state() private pullRequests: PullRequestSummary[] = [];
  @state() private workflowRuns: WorkflowRun[] = [];
  @state() private issues: IssueSummary[] = [];
  @state() private repoLabels: Label[] = [];
  // Pagination cursors for the four list tabs. `hasMore*` is set when the last
  // page came back full; issues carry an explicit cursor from the backend
  // because a filtered page's length cannot signal whether more exist.
  @state() private prPage = 1;
  @state() private hasMorePrs = false;
  @state() private issuesNextPage: number | null = null;
  @state() private releasesPage = 1;
  @state() private hasMoreReleases = false;
  @state() private runsPage = 1;
  @state() private hasMoreRuns = false;
  @state() private isLoadingMorePrs = false;
  @state() private isLoadingMoreRuns = false;
  @state() private isLoadingMoreIssues = false;
  @state() private isLoadingMoreReleases = false;
  // Request generations, one per paged list. A restart (a filter change, a
  // reload after a create) supersedes an in-flight page load: the superseded
  // result must neither append to the list that replaced it nor overwrite its
  // cursor. Plain fields — they drive no rendering.
  private prRequestId = 0;
  private runsRequestId = 0;
  private issuesRequestId = 0;
  private releasesRequestId = 0;
  @state() private isLoading = false;
  @state() private error: string | null = null;
  @state() private tokenInput = '';
  @state() private prFilter: 'open' | 'closed' | 'all' = 'open';
  @state() private issueFilter: 'open' | 'closed' | 'all' = 'open';

  // OAuth state
  @state() private authMethod: 'oauth' | 'pat' | 'app' = 'oauth';
  @state() private appId = '';
  @state() private appPrivateKey = '';
  @state() private appInstallationId = '';
  @state() private appInstallations: import('../../services/credential.service.ts').AppInstallation[] = [];
  @state() private loadingInstallations = false;
  @state() private oauthState: OAuthFlowState = { status: 'idle' };
  private oauthUnsubscribe?: () => void;
  // Set while the user is mid-"Add account" (selection intentionally cleared so
  // the next save creates a NEW account). Guards the store subscription from
  // re-selecting an existing account on a background emit, which would route the
  // token onto the wrong account.
  private isAddingAccount = false;
  private oauthTargetAccountId: string | null | undefined;
  private oauthTargetWasAddingAccount: boolean | undefined;
  private boundOAuthComplete = this.handleOAuthComplete.bind(this);

  // Multi-account support (global accounts)
  @state() private accounts: IntegrationAccount[] = [];
  @state() private selectedAccountId: string | null = null;

  private unsubscribeStore?: () => void;
  private loadGeneration = 0;

  // Create PR form
  @state() private createPrTitle = '';
  @state() private createPrBody = '';
  @state() private createPrHead = '';
  @state() private createPrBase = '';
  @state() private createPrDraft = false;
  @state() private generatingPrDescription = false;

  // Create Issue form
  @state() private createIssueTitle = '';
  @state() private createIssueBody = '';
  @state() private createIssueLabels: string[] = [];

  // Releases
  @state() private releases: ReleaseSummary[] = [];

  // Create Release form
  @state() private createReleaseTag = '';
  @state() private createReleaseName = '';
  @state() private createReleaseBody = '';
  @state() private createReleasePrerelease = false;
  @state() private createReleaseDraft = false;
  @state() private createReleaseGenerateNotes = true;

  async connectedCallback(): Promise<void> {
    super.connectedCallback();

    // Subscribe to OAuth state changes
    this.oauthUnsubscribe = oauthService.onOAuthStateChange((state) => {
      if (state.provider === 'github') {
        this.oauthState = state;
        // A failed/denied sign-in clears the pending spinner — surface the error
        // so the user isn't left staring at a silently reset form (dead-end).
        if (state.status === 'error') {
          this.error = state.error ?? 'GitHub sign-in failed';
          showToast(this.error, 'error');
          // The flow is over and can no longer emit `oauth-complete`, so release
          // the pinned target — otherwise a later completion would be attributed
          // to whichever account was selected when this failed flow started.
          this.oauthTargetAccountId = undefined;
          this.oauthTargetWasAddingAccount = undefined;
        }
      }
    });

    // Listen for OAuth complete events
    window.addEventListener('oauth-complete', this.boundOAuthComplete as unknown as EventListener);

    // Subscribe to unified profile store - get global accounts. Track the
    // active profile so that switching profiles re-derives the preferred
    // account instead of stickily keeping whatever the user manually selected
    // under a previous profile.
    let lastActiveProfileId = unifiedProfileStore.getState().activeProfile?.id ?? null;
    this.unsubscribeStore = unifiedProfileStore.subscribe((state) => {
      this.accounts = getAccountsByType('github');
      // If selected account was deleted, reset to null
      if (this.selectedAccountId && !this.accounts.some(a => a.id === this.selectedAccountId)) {
        this.selectedAccountId = null;
      }
      const activeProfileId = state.activeProfile?.id ?? null;
      if (activeProfileId !== lastActiveProfileId) {
        // Active profile changed — re-derive the preferred account for the new
        // profile, even if the user had a selection from the previous profile.
        // Track the id either way so this doesn't re-fire, but DON'T clobber a
        // half-completed "Add account" flow (selectedAccountId is intentionally
        // null then; a background store emit must not re-select an existing
        // account, or the next save would overwrite it).
        lastActiveProfileId = activeProfileId;
        if (!this.isAddingAccount) {
          const preferred = getActiveProfilePreferredAccount('github');
          this.selectedAccountId = preferred?.id ?? this.accounts[0]?.id ?? null;
        }
      } else if (!this.isAddingAccount && !this.selectedAccountId && this.accounts.length > 0) {
        // First-time selection: prefer the active profile's default, falling
        // back to the global default.
        const preferred = getActiveProfilePreferredAccount('github') ?? selectDefaultGlobalAccount('github');
        this.selectedAccountId = preferred?.id ?? this.accounts[0]?.id ?? null;
      }
    });

    // Initialize from current state
    this.accounts = getAccountsByType('github');
    if (this.accounts.length > 0 && !this.selectedAccountId) {
      const preferred = getActiveProfilePreferredAccount('github') ?? selectDefaultGlobalAccount('github');
      this.selectedAccountId = preferred?.id ?? this.accounts[0]?.id ?? null;
    }

    if (this.open) {
      await this.loadInitialData();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeStore?.();
    this.oauthUnsubscribe?.();
    window.removeEventListener('oauth-complete', this.boundOAuthComplete as unknown as EventListener);
  }

  async updated(changedProperties: Map<string, unknown>): Promise<void> {
    if (changedProperties.has('open') && this.open) {
      // Fresh open: re-derive the preferred account so a profile switch since
      // the last open is reflected. handleAccountChange() also calls
      // loadInitialData(), and we must NOT re-derive in that path or a manual
      // switch would immediately be overwritten.
      this.selectedAccountId = null;
      await this.loadInitialData();
    }
    if (changedProperties.has('repositoryPath')) {
      // The dialog is repo-independent (it stays open across the last tab close),
      // so an empty path must clear the previously detected repo. Otherwise the
      // repo-backed tabs keep rendering and acting on the closed repository.
      // The create-* drafts belong to the repository they were typed against,
      // so they go too -- otherwise a draft left on screen is submitted into
      // whichever repository the dialog is repointed at.
      this.resetRepoScopedDrafts();
      if (!this.repositoryPath) {
        this.detectedRepo = null;
      } else if (this.open) {
        await this.detectRepo();
      }
    }
  }

  /**
   * Drop every create-* draft and leave any create-* tab. Called when
   * repositoryPath changes, because those drafts are scoped to the repository
   * they were composed against while the create handlers guard only on
   * detectedRepo, which is re-derived from whatever repository is now current.
   */
  private resetRepoScopedDrafts(): void {
    this.createPrTitle = '';
    this.createPrBody = '';
    this.createPrHead = '';
    this.createPrBase = '';
    this.createPrDraft = false;
    this.createIssueTitle = '';
    this.createIssueBody = '';
    this.createIssueLabels = [];
    this.createReleaseTag = '';
    this.createReleaseName = '';
    this.createReleaseBody = '';
    this.createReleasePrerelease = false;
    this.createReleaseDraft = false;
    this.createReleaseGenerateNotes = true;
    if (this.activeTab.startsWith('create-')) {
      this.activeTab = 'connection';
    }
  }

  private async loadInitialData(): Promise<void> {
    const generation = ++this.loadGeneration;
    this.isLoading = true;
    this.error = null;

    try {
      log.debug('loadInitialData starting');

      // Ensure unified profiles are loaded
      await unifiedProfileService.loadUnifiedProfiles();
      if (generation !== this.loadGeneration) return;

      // Load the profile for this repository to set activeProfile
      if (this.repositoryPath) {
        await unifiedProfileService.loadUnifiedProfileForRepository(this.repositoryPath);
        if (generation !== this.loadGeneration) return;
      }

      // Re-sync local state with store after loading
      const state = unifiedProfileStore.getState();
      log.debug('Store state', {
        hasActiveProfile: !!state.activeProfile,
        activeProfileId: state.activeProfile?.id,
        globalAccountsCount: state.accounts?.length ?? 0,
        githubAccounts: state.accounts?.filter((a) => a.integrationType === 'github').length ?? 0,
      });

      this.accounts = getAccountsByType('github');
      log.debug('Loaded accounts', this.accounts.map(a => ({ id: a.id, name: a.name })));
      // Only auto-derive if nothing is selected (fresh open clears it in
      // `updated()`). Manual switches set selectedAccountId before calling
      // loadInitialData(), and must not be overwritten.
      if (this.accounts.length > 0 && !this.selectedAccountId) {
        const preferred = getActiveProfilePreferredAccount('github')
          ?? selectDefaultGlobalAccount('github');
        this.selectedAccountId = preferred?.id ?? this.accounts[0]?.id ?? null;
        log.debug('Selected account', { accountId: this.selectedAccountId });
      }

      await this.checkConnection();
      if (generation !== this.loadGeneration) return;
      if (this.repositoryPath) {
        await this.detectRepo();
      }
    } catch (err) {
      if (generation !== this.loadGeneration) return;
      this.error = err instanceof Error ? err.message : 'Failed to load data';
    } finally {
      if (generation === this.loadGeneration) {
        this.isLoading = false;
      }
    }
  }

  /**
   * Mirror a verified connection result into the shared unified-profile store so
   * other views (e.g. the profile manager's status dots) reflect it immediately,
   * rather than waiting for their own re-check.
   */
  private syncSharedConnectionStatus(connected: boolean): void {
    if (this.selectedAccountId) {
      unifiedProfileStore
        .getState()
        .setAccountConnectionStatus(this.selectedAccountId, connected ? 'connected' : 'disconnected');
    }
  }

  private async checkConnection(): Promise<void> {
    try {
      // Get token for selected account (or legacy token if no account)
      const token = await this.getSelectedAccountToken();
      const result = await gitService.checkGitHubConnectionWithToken(token);
      if (result.success && result.data) {
        this.connectionStatus = result.data;
        this.syncSharedConnectionStatus(result.data.connected);
        // Update cached user in global account if connected
        if (this.selectedAccountId && result.data.connected && result.data.user) {
          await unifiedProfileService.updateGlobalAccountCachedUser(this.selectedAccountId, {
            username: result.data.user.login,
            displayName: result.data.user.name ?? null,
            email: result.data.user.email ?? null,
            avatarUrl: result.data.user.avatarUrl ?? null,
          });
        }
      } else if (!result.success) {
        this.error = result.error?.message ?? 'Failed to check connection';
        this.connectionStatus = { connected: false, user: null, scopes: [] };
        this.syncSharedConnectionStatus(false);
      } else {
        this.error = 'Failed to verify connection';
        this.connectionStatus = { connected: false, user: null, scopes: [] };
        this.syncSharedConnectionStatus(false);
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to check connection';
      this.connectionStatus = { connected: false, user: null, scopes: [] };
      this.syncSharedConnectionStatus(false);
    }
  }

  /**
   * Get the token for the currently selected account
   */
  private async getSelectedAccountToken(): Promise<string | null> {
    if (this.selectedAccountId) {
      return credentialService.getFreshAccountToken(
        'github',
        this.selectedAccountId,
        'github'
      );
    }
    return null;
  }

  /**
   * Handle account selection change
   */
  private async handleAccountChange(e: CustomEvent<{ account: IntegrationAccount }>): Promise<void> {
    const { account } = e.detail;
    // The user explicitly selected an existing account, so we're no longer
    // adding a new one — re-enable the subscription's auto-apply branch.
    this.isAddingAccount = false;
    this.selectedAccountId = account.id;
    this.connectionStatus = null;
    this.error = null;

    // Re-check connection with new account
    await this.loadInitialData();
  }

  /**
   * Handle add account request
   */
  private handleAddAccount(): void {
    // Switch to connection tab to add token for a NEW account. Clearing
    // selectedAccountId is essential — without it handleSaveToken would write
    // the new token onto the previously-selected account instead of creating
    // a new one, leaving the user with no way to add additional accounts.
    this.isAddingAccount = true;
    this.activeTab = 'connection';
    this.connectionStatus = null;
    this.selectedAccountId = null;
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
    // Re-dispatch with this provider's canonical type for the host to open accounts.
    this.dispatchEvent(
      new CustomEvent('manage-accounts', {
        detail: { integrationType: 'github' },
        bubbles: true,
        composed: true,
      })
    );
  }

  private async detectRepo(): Promise<void> {
    if (!this.repositoryPath) return;

    // The dialog outlives the repository -- it stays open when the last tab
    // closes -- so a detect issued for one path can resolve after the path has
    // changed. Dropping the stale result stops the closed (or previously
    // selected) repository from being re-detected and re-loaded over the
    // current one.
    const requestedPath = this.repositoryPath;
    const result = await gitService.detectGitHubRepo(requestedPath);
    if (this.repositoryPath !== requestedPath) return;
    if (result.success && result.data) {
      this.detectedRepo = result.data;
      // SAFETY: IPC calls are batched with Promise.all to avoid N+1 sequential calls.
      if (this.connectionStatus?.connected) {
        await Promise.all([
          this.loadPullRequests(),
          this.loadWorkflowRuns(),
          this.loadIssues(),
          this.loadLabels(),
          this.loadReleases(),
        ]);
      }
    } else if (!result.success) {
      // A genuine backend failure (not merely "this isn't a GitHub repo", which
      // surfaces as success with null data) must not fail silently.
      this.error = result.error?.message ?? 'Failed to detect GitHub repository';
    }
  }

  /**
   * Load pull requests. With `append` the next page is fetched and added to the
   * list already on screen; without it the list restarts at page 1 (a filter
   * change, or the initial load).
   */
  private async loadPullRequests(providedToken?: string, append = false): Promise<void> {
    if (!this.detectedRepo || !this.connectionStatus?.connected) return;

    const requestedPage = append ? this.prPage + 1 : 1;
    const requestId = ++this.prRequestId;
    // Appending must not swap the rendered list for the "Loading…" placeholder,
    // so it uses its own flag.
    if (append) {
      this.isLoadingMorePrs = true;
    } else {
      this.isLoadingMorePrs = false;
      this.isLoading = true;
    }
    this.error = null;

    try {
      const token = providedToken ?? await this.getSelectedAccountToken();
      const result = await gitService.listPullRequests(
        this.detectedRepo.owner,
        this.detectedRepo.repo,
        this.prFilter,
        PR_PAGE_SIZE,
        requestedPage,
        token
      );

      if (requestId !== this.prRequestId) return;
      if (result.success && result.data) {
        this.pullRequests = append ? [...this.pullRequests, ...result.data] : result.data;
        this.prPage = requestedPage;
        this.hasMorePrs = result.data.length === PR_PAGE_SIZE;
      } else {
        // Leave the loaded pages, page cursor and hasMore flag alone so the
        // button stays put for a retry.
        this.error = result.error?.message ?? 'Failed to load pull requests';
      }
    } catch (err) {
      if (requestId !== this.prRequestId) return;
      this.error = err instanceof Error ? err.message : 'Failed to load pull requests';
    } finally {
      if (requestId === this.prRequestId) {
        if (append) {
          this.isLoadingMorePrs = false;
        } else {
          this.isLoading = false;
        }
      }
    }
  }

  /** Load workflow runs; see `loadPullRequests` for what `append` means. */
  private async loadWorkflowRuns(providedToken?: string, append = false): Promise<void> {
    if (!this.detectedRepo || !this.connectionStatus?.connected) return;

    const requestedPage = append ? this.runsPage + 1 : 1;
    const requestId = ++this.runsRequestId;
    this.isLoadingMoreRuns = append;
    // Same as loadPullRequests: a load that succeeds must not leave the
    // previous attempt's banner standing.
    this.error = null;

    try {
      const token = providedToken ?? await this.getSelectedAccountToken();
      const result = await gitService.getWorkflowRuns(
        this.detectedRepo.owner,
        this.detectedRepo.repo,
        undefined,
        WORKFLOW_PAGE_SIZE,
        requestedPage,
        token
      );

      if (requestId !== this.runsRequestId) return;
      if (result.success && result.data) {
        this.workflowRuns = append ? [...this.workflowRuns, ...result.data] : result.data;
        this.runsPage = requestedPage;
        this.hasMoreRuns = result.data.length === WORKFLOW_PAGE_SIZE;
      } else if (!result.success) {
        // Use the shared error banner (like loadPullRequests) rather than a
        // toast, so a shared failure across the batched loads doesn't stack
        // four near-identical toasts on open.
        this.error = result.error?.message ?? 'Failed to load workflow runs';
      }
    } catch (err) {
      if (requestId !== this.runsRequestId) return;
      this.error = err instanceof Error ? err.message : 'Failed to load workflow runs';
    } finally {
      if (append && requestId === this.runsRequestId) this.isLoadingMoreRuns = false;
    }
  }

  /**
   * Load issues; see `loadPullRequests` for what `append` means. The next page
   * comes from the backend cursor rather than a counter, because `/issues`
   * mixes in pull requests and a page of them yields no issues at all.
   */
  private async loadIssues(providedToken?: string, append = false): Promise<void> {
    if (!this.detectedRepo || !this.connectionStatus?.connected) return;

    const requestedPage = append ? (this.issuesNextPage ?? 1) : 1;
    const requestId = ++this.issuesRequestId;
    this.isLoadingMoreIssues = append;
    this.error = null;

    try {
      const token = providedToken ?? await this.getSelectedAccountToken();
      const result = await gitService.listIssues(
        this.detectedRepo.owner,
        this.detectedRepo.repo,
        this.issueFilter,
        undefined,
        ISSUE_PAGE_SIZE,
        requestedPage,
        token
      );

      if (requestId !== this.issuesRequestId) return;
      if (result.success && result.data) {
        this.issues = append ? [...this.issues, ...result.data.issues] : result.data.issues;
        this.issuesNextPage = result.data.nextPage ?? null;
      } else if (!result.success) {
        this.error = result.error?.message ?? 'Failed to load issues';
      }
    } catch (err) {
      if (requestId !== this.issuesRequestId) return;
      this.error = err instanceof Error ? err.message : 'Failed to load issues';
    } finally {
      if (append && requestId === this.issuesRequestId) this.isLoadingMoreIssues = false;
    }
  }

  private async loadLabels(providedToken?: string): Promise<void> {
    if (!this.detectedRepo || !this.connectionStatus?.connected) return;

    try {
      const token = providedToken ?? await this.getSelectedAccountToken();
      const result = await gitService.getRepoLabels(
        this.detectedRepo.owner,
        this.detectedRepo.repo,
        undefined,
        token
      );

      if (result.success && result.data) {
        this.repoLabels = result.data;
      } else if (!result.success) {
        this.error = result.error?.message ?? 'Failed to load labels';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to load labels';
    }
  }

  /** Load releases; see `loadPullRequests` for what `append` means. */
  private async loadReleases(providedToken?: string, append = false): Promise<void> {
    if (!this.detectedRepo || !this.connectionStatus?.connected) return;

    const requestedPage = append ? this.releasesPage + 1 : 1;
    const requestId = ++this.releasesRequestId;
    this.isLoadingMoreReleases = append;
    this.error = null;

    try {
      const token = providedToken ?? await this.getSelectedAccountToken();
      const result = await gitService.listReleases(
        this.detectedRepo.owner,
        this.detectedRepo.repo,
        RELEASE_PAGE_SIZE,
        requestedPage,
        token
      );

      if (requestId !== this.releasesRequestId) return;
      if (result.success && result.data) {
        this.releases = append ? [...this.releases, ...result.data] : result.data;
        this.releasesPage = requestedPage;
        this.hasMoreReleases = result.data.length === RELEASE_PAGE_SIZE;
      } else if (!result.success) {
        this.error = result.error?.message ?? 'Failed to load releases';
      }
    } catch (err) {
      if (requestId !== this.releasesRequestId) return;
      this.error = err instanceof Error ? err.message : 'Failed to load releases';
    } finally {
      if (append && requestId === this.releasesRequestId) this.isLoadingMoreReleases = false;
    }
  }

  private async handleStartOAuth(): Promise<void> {
    const clientId = getClientId('github');
    if (!clientId) {
      this.error = 'GitHub OAuth is not configured. Please use a Personal Access Token.';
      this.authMethod = 'pat';
      return;
    }

    this.error = null;
    this.oauthTargetAccountId = this.selectedAccountId;
    this.oauthTargetWasAddingAccount = this.isAddingAccount;
    // `startOAuth` never rejects — it reports failure through the OAuth state
    // subscriber — so the pinned target is cleared there, not here.
    await oauthService.startOAuth('github', clientId);
  }

  /**
   * Abandon a sign-in that is waiting on the browser. Scoped to 'github' so a
   * sign-in pending in another provider's dialog is left alone. The local state
   * is set explicitly rather than relying on the service's notification, so the
   * form can never stay stuck if there is no pending entry to cancel.
   */
  private handleCancelOAuth(): void {
    oauthService.cancelOAuth('github');
    this.oauthState = { status: 'idle' };
    this.error = null;
    // Abandoned flow: release the pinned target so a stray late completion
    // can't be attributed to the account this flow started on.
    this.oauthTargetAccountId = undefined;
    this.oauthTargetWasAddingAccount = undefined;
  }

  private async handleOAuthComplete(event: CustomEvent<{ provider: string; tokens: OAuthTokenResponse }>): Promise<void> {
    const { provider, tokens } = event.detail;
    // Do not log token material (M5) — only presence, never any prefix/value.
    log.debug('OAuth complete event received', {
      provider,
      hasTokens: !!tokens,
    });
    if (provider !== 'github') return;

    // The OAuth callback arrives via a window event and can fire after the user
    // has closed the dialog. We still persist the account (the user completed
    // auth — don't throw it away), but the dialog's inline status is invisible
    // when closed, so remember this to surface a toast instead.
    const wasOpen = this.open;
    const targetAccountId =
      this.oauthTargetAccountId !== undefined
        ? this.oauthTargetAccountId
        : this.selectedAccountId;
    const targetWasAddingAccount =
      this.oauthTargetWasAddingAccount ?? this.isAddingAccount;
    this.oauthTargetAccountId = undefined;
    this.oauthTargetWasAddingAccount = undefined;

    this.isLoading = true;
    this.error = null;
    const targetAccountExists = (): boolean =>
      !targetAccountId ||
      getAccountsByType('github').some((account) => account.id === targetAccountId);
    const selectionChangedDuringOAuth = (): boolean =>
      this.selectedAccountId !== targetAccountId ||
      this.isAddingAccount !== targetWasAddingAccount;
    let applyOAuthResultToSelection = false;
    let connectedAccountId: string | undefined;

    try {
      // IMPORTANT: Ensure profiles are loaded before trying to save the account
      // The OAuth callback fires via window event and may complete before loadInitialData
      await unifiedProfileService.loadUnifiedProfiles();
      if (wasOpen && this.repositoryPath) {
        await unifiedProfileService.loadUnifiedProfileForRepository(this.repositoryPath);
      }
      if (!targetAccountExists()) {
        this.error = 'The GitHub account was removed before sign-in completed. Please sign in again.';
        showToast(this.error, 'error');
        return;
      }

      // Verify the token works
      log.debug('Verifying token');
      const verifyResult = await gitService.checkGitHubConnectionWithToken(tokens.accessToken);
      log.debug('Verify result', { success: verifyResult.success, connected: verifyResult.data?.connected });
      if (!verifyResult.success || !verifyResult.data?.connected) {
        this.error = verifyResult.error?.message ?? 'OAuth token verification failed';
        return;
      }

      const user = verifyResult.data.user;
      if (!targetAccountExists()) {
        this.error = 'The GitHub account was removed before sign-in completed. Please sign in again.';
        showToast(this.error, 'error');
        return;
      }

      // Create or update global account with OAuth token
      log.debug('Creating/updating account', {
        hasSelectedAccountId: !!this.selectedAccountId,
        existingAccountsCount: this.accounts.length,
      });

      if (targetAccountId) {
        log.debug('Storing token for existing account', { accountId: targetAccountId });
        await credentialService.storeAccountOAuthToken(
          'github',
          targetAccountId,
          tokens.accessToken,
          tokens.refreshToken,
          tokens.expiresIn,
        );
        if (!targetAccountExists()) {
          await credentialService.deleteAccountToken('github', targetAccountId);
          this.error = 'The GitHub account was removed before sign-in completed. Please sign in again.';
          showToast(this.error, 'error');
          return;
        }
        // Refresh cachedUser so the profile card shows the current avatar/username
        // immediately rather than a stale one until the 5-min validation. Mirrors
        // the PAT path's mapping; every other provider/path already does this.
        if (user) {
          await unifiedProfileService.updateGlobalAccountCachedUser(targetAccountId, {
            username: user.login,
            displayName: user.name ?? null,
            email: user.email ?? null,
            avatarUrl: user.avatarUrl ?? null,
          });
        }
        applyOAuthResultToSelection = !selectionChangedDuringOAuth();
        if (applyOAuthResultToSelection) {
          this.selectedAccountId = targetAccountId;
        }
        connectedAccountId = targetAccountId;
      } else {
        // Create a new global account
        log.debug('Creating new global account');
        const { createEmptyIntegrationAccount, generateId } = await import('../../types/unified-profile.types.ts');
        const newAccount: IntegrationAccount = {
          ...createEmptyIntegrationAccount('github'),
          id: generateId(),
          name: user?.login ? `GitHub (${user.login})` : 'GitHub Account',
          isDefault: this.accounts.length === 0,
          cachedUser: user ? {
            username: user.login,
            displayName: user.name ?? null,
            email: user.email ?? null,
            avatarUrl: user.avatarUrl ?? null,
          } : null,
        };

        log.debug('New account', { id: newAccount.id, name: newAccount.name });
        const savedAccount = await unifiedProfileService.saveGlobalAccount(newAccount);
        log.debug('Saved account', { id: savedAccount.id });
        await credentialService.storeAccountOAuthToken(
          'github',
          savedAccount.id,
          tokens.accessToken,
          tokens.refreshToken,
          tokens.expiresIn,
        );
        // Refresh accounts list from store after adding new account
        await unifiedProfileService.loadUnifiedProfiles();
        this.accounts = getAccountsByType('github');
        log.debug('Refreshed accounts list', { count: this.accounts.length });
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
        unifiedProfileStore
          .getState()
          .setAccountConnectionStatus(connectedAccountId, 'connected');
      }
      if (!applyOAuthResultToSelection) {
        this.oauthState = { status: 'idle' };
        showToast(
          user?.login ? `Connected GitHub account @${user.login}` : 'Connected GitHub account',
          'success'
        );
        return;
      }

      this.connectionStatus = verifyResult.data;
      this.syncSharedConnectionStatus(true);
      this.oauthState = { status: 'idle' };

      // If the dialog was closed before OAuth completed, its inline status is
      // not visible — surface a toast so the connection isn't a silent no-op.
      if (!wasOpen) {
        showToast(
          user?.login ? `Connected GitHub account @${user.login}` : 'Connected GitHub account',
          'success'
        );
      }

      // Load data if connected and repo detected
      if (wasOpen && this.connectionStatus?.connected && this.detectedRepo) {
        await Promise.all([
          this.loadPullRequests(tokens.accessToken),
          this.loadWorkflowRuns(tokens.accessToken),
          this.loadIssues(tokens.accessToken),
          this.loadLabels(tokens.accessToken),
          this.loadReleases(tokens.accessToken),
        ]);
      }
    } catch (err) {
      if (targetAccountId && !targetAccountExists()) {
        await credentialService.deleteAccountToken('github', targetAccountId);
      }
      this.error = err instanceof Error ? err.message : 'OAuth authentication failed';
    } finally {
      this.isLoading = false;
    }
  }

  private async handleSaveToken(): Promise<void> {
    if (!this.tokenInput.trim()) return;

    this.isLoading = true;
    this.error = null;
    const tokenToSave = this.tokenInput.trim();

    try {
      // First verify the token works by checking connection
      const verifyResult = await gitService.checkGitHubConnectionWithToken(tokenToSave);
      if (!verifyResult.success || !verifyResult.data?.connected) {
        this.error = verifyResult.error?.message ?? 'Invalid token or connection failed';
        return;
      }

      const user = verifyResult.data.user;

      // If we have a selected account, save token to that account
      if (this.selectedAccountId) {
        await credentialService.storeAccountToken('github', this.selectedAccountId, tokenToSave);
        // Refresh cachedUser so the profile manager shows the up-to-date
        // avatar/username immediately instead of waiting for background validation.
        if (user) {
          await unifiedProfileService.updateGlobalAccountCachedUser(this.selectedAccountId, {
            username: user.login,
            displayName: user.name ?? null,
            email: user.email ?? null,
            avatarUrl: user.avatarUrl ?? null,
          });
        }
      } else {
        // No account selected - create a new global account
        const { createEmptyIntegrationAccount, generateId } = await import('../../types/unified-profile.types.ts');
        const newAccount: IntegrationAccount = {
          ...createEmptyIntegrationAccount('github'),
          id: generateId(),
          name: user?.login ? `GitHub (${user.login})` : 'GitHub Account',
          isDefault: this.accounts.length === 0,
          cachedUser: user ? {
            username: user.login,
            displayName: user.name ?? null,
            email: user.email ?? null,
            avatarUrl: user.avatarUrl ?? null,
          } : null,
        };

        const savedAccount = await unifiedProfileService.saveGlobalAccount(newAccount);
        await credentialService.storeAccountToken('github', savedAccount.id, tokenToSave);
        this.selectedAccountId = savedAccount.id;
        // The new account now exists and is selected — the add flow is complete.
        this.isAddingAccount = false;

        // Refresh accounts list
        await unifiedProfileService.loadUnifiedProfiles();
        this.accounts = getAccountsByType('github');
      }

      // Token saved, update state
      this.tokenInput = '';
      this.connectionStatus = verifyResult.data;
      this.syncSharedConnectionStatus(true);

      // Load data if connected and repo detected
      // Pass the token directly since storage might not be ready yet
      if (this.connectionStatus?.connected && this.detectedRepo) {
        await Promise.all([
          this.loadPullRequests(tokenToSave),
          this.loadWorkflowRuns(tokenToSave),
          this.loadIssues(tokenToSave),
          this.loadLabels(tokenToSave),
          this.loadReleases(tokenToSave),
        ]);
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to save token';
      this.tokenInput = tokenToSave;
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * True when this connection is backed by a GitHub App installation rather
   * than a token. App connections keep their credentials in a separate keyring
   * entry, so removing the account's token alone leaves them working.
   */
  private isAppConnection(accountId: string | null): boolean {
    return (
      (accountId?.startsWith('github-app-') ?? false) ||
      (this.connectionStatus?.scopes?.includes('app-installation') ?? false)
    );
  }

  private async handleDisconnect(): Promise<void> {
    this.isLoading = true;
    this.error = null;

    const wasAppConnection = this.isAppConnection(this.selectedAccountId);

    try {
      // Delete token for selected account or legacy token
      if (this.selectedAccountId) {
        await credentialService.deleteAccountToken('github', this.selectedAccountId);
      } else {
        await gitService.deleteGitHubToken();
      }

      // The App config lives in its own keyring entry, so deleting the account
      // token does not disconnect an App. Leaving it behind kept the App
      // authenticating requests after the user pressed Disconnect.
      if (wasAppConnection) {
        try {
          await credentialService.removeGitHubAppConfig();
        } catch (appErr) {
          showToast(
            appErr instanceof Error
              ? `Disconnected, but the GitHub App configuration could not be removed: ${appErr.message}`
              : 'Disconnected, but the GitHub App configuration could not be removed',
            'warning',
          );
        }
      }

      this.syncSharedConnectionStatus(false);
      this.connectionStatus = { connected: false, user: null, scopes: [] };
      this.pullRequests = [];
      this.workflowRuns = [];
      this.issues = [];
      this.repoLabels = [];
      this.releases = [];
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to disconnect';
      showToast(this.error, 'error');
    } finally {
      this.isLoading = false;
    }
  }

  private async handleDeleteIntegration(): Promise<void> {
    if (!this.selectedAccountId) return;

    const selected = this.accounts.find((a) => a.id === this.selectedAccountId);
    const accountName = selected?.name ?? 'this account';
    const confirmed = await showConfirm(
      'Delete GitHub Integration',
      `Delete ${accountName}? The stored token will be removed and any profile that uses this account as its default will lose that reference.`,
      'warning',
    );
    if (!confirmed) return;

    this.isLoading = true;
    this.error = null;

    // M10: Delete the config/account record (the source of truth) FIRST so a
    // failure leaves the token intact but no zombie account. The keyring token
    // deletion is best-effort last; if it fails we surface a warning rather than
    // leaving a half-deleted state.
    const accountId = this.selectedAccountId;
    const wasAppConnection = this.isAppConnection(accountId);
    try {
      await unifiedProfileService.deleteGlobalAccount(accountId);

      // Same as Disconnect: the App keeps its credentials in a separate keyring
      // entry, so deleting the account record alone leaves it able to
      // authenticate.
      if (wasAppConnection) {
        try {
          await credentialService.removeGitHubAppConfig();
        } catch (appErr) {
          showToast(
            appErr instanceof Error
              ? `Account deleted, but the GitHub App configuration could not be removed: ${appErr.message}`
              : 'Account deleted, but the GitHub App configuration could not be removed',
            'warning',
          );
        }
      }

      await unifiedProfileService.loadUnifiedProfiles();
      this.accounts = getAccountsByType('github');

      this.selectedAccountId = this.accounts.length > 0 ? this.accounts[0].id : null;
      this.connectionStatus = null;
      this.pullRequests = [];
      this.issues = [];
      this.workflowRuns = [];
      this.releases = [];
      this.repoLabels = [];

      // Best-effort token cleanup after the record is gone.
      try {
        await credentialService.deleteAccountToken('github', accountId);
      } catch (tokenErr) {
        // M10: surface partial failure instead of swallowing it.
        const msg =
          tokenErr instanceof Error
            ? `Account deleted, but its stored token could not be removed: ${tokenErr.message}`
            : 'Account deleted, but its stored token could not be removed.';
        this.error = msg;
        showToast(msg, 'error');
      }

      if (this.accounts.length > 0) {
        await this.loadInitialData();
      }
    } catch (err) {
      // M10: pair inline error with a toast for consistent feedback.
      const msg = err instanceof Error ? err.message : 'Failed to delete integration';
      this.error = msg;
      showToast(msg, 'error');
    } finally {
      this.isLoading = false;
    }
  }

  private async handleLoadInstallations(): Promise<void> {
    if (!this.appId || !this.appPrivateKey) return;

    this.loadingInstallations = true;
    try {
      const installations = await import('../../services/credential.service.ts').then(m =>
        m.listGitHubAppInstallations(parseInt(this.appId, 10), this.appPrivateKey)
      );
      this.appInstallations = installations;
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load installations', 'error');
    }
    this.loadingInstallations = false;
  }

  private async handleConnectGitHubApp(): Promise<void> {
    if (!this.appId || !this.appPrivateKey || !this.appInstallationId) return;

    this.isLoading = true;
    this.error = null;

    try {
      // The backend now validates the key, mints a JWT, and persists the app
      // config to the keyring (M1). Honor the status it returns instead of
      // assuming success — a non-connected result must not persist a fake account.
      const status = await import('../../services/credential.service.ts').then(m =>
        m.configureGitHubApp(
          parseInt(this.appId, 10),
          this.appPrivateKey,
          parseInt(this.appInstallationId, 10),
        )
      );

      if (!status.connected) {
        throw new Error('GitHub App configuration was not accepted by the server');
      }

      // The App connection always gets its OWN account record. Reusing
      // whatever account happens to be selected would destroy it: the dialog
      // auto-selects an existing PAT/OAuth account when it opens, and
      // saveGlobalAccount() replaces the whole row, so that account's name,
      // cached user, colour, URL patterns and Default flag would be wiped and
      // its id rebound to the App. The PAT and OAuth paths only ever reuse
      // selectedAccountId to store a token, never to rewrite the record.
      const accountId = `github-app-${this.appId}`;

      // Create the App account, or refresh an existing one in place without
      // discarding the metadata the user set on it.
      const unifiedProfile = await import('../../services/unified-profile.service.ts');
      const { createEmptyIntegrationAccount } = await import('../../types/unified-profile.types.ts');
      const existingAppAccount = this.accounts.find((a) => a.id === accountId);
      // The backend keeps a single GitHub App configuration (one keyring
      // entry), so connecting a different App repoints the credential that
      // every other App account resolves through — those accounts have no
      // token of their own and fall back to that same config. Supersede them
      // instead of leaving entries in the selector that silently authenticate
      // as the App just connected.
      const supersededAppAccounts = this.accounts.filter(
        (a) => a.id !== accountId && a.id.startsWith('github-app-'),
      );
      const appAccount: IntegrationAccount = {
        ...(existingAppAccount ?? createEmptyIntegrationAccount('github')),
        id: accountId,
        name: existingAppAccount?.name || `GitHub App ${this.appId}`,
        isDefault: existingAppAccount
          ? existingAppAccount.isDefault
          : supersededAppAccounts.some((a) => a.isDefault) || this.accounts.length === 0,
      };
      await unifiedProfile.saveGlobalAccount(appAccount);
      for (const superseded of supersededAppAccounts) {
        try {
          await unifiedProfileService.deleteGlobalAccount(superseded.id);
        } catch (supersededErr) {
          showToast(
            supersededErr instanceof Error
              ? `Connected, but the previous GitHub App account could not be removed: ${supersededErr.message}`
              : 'Connected, but the previous GitHub App account could not be removed',
            'warning',
          );
        }
      }
      // Keep the selector in sync so the new account is listed and a later
      // store emit cannot reset the selection (the subscription clears
      // selectedAccountId when it is not in this.accounts). Mirrors the
      // create-new branches of the PAT and OAuth paths.
      this.accounts = getAccountsByType('github');

      // Reflect the backend-reported status rather than a hardcoded value (M1).
      this.connectionStatus = {
        connected: status.connected,
        user: status.user ?? null,
        scopes: status.scopes?.length ? status.scopes : ['app-installation'],
      };
      this.selectedAccountId = accountId;
      // The new account now exists and is selected — the add flow is complete
      // (mirrors the PAT and OAuth success paths).
      this.isAddingAccount = false;
      this.syncSharedConnectionStatus(true);

      showToast('Connected via GitHub App', 'success');

      // Reset form
      this.appId = '';
      this.appPrivateKey = '';
      this.appInstallationId = '';
      this.appInstallations = [];
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to connect GitHub App';
      showToast(this.error, 'error');
    }

    this.isLoading = false;
  }

  private async handleGeneratePrDescription(): Promise<void> {
    if (!this.repositoryPath || !this.createPrHead || !this.createPrBase) return;

    this.generatingPrDescription = true;
    const result = await aiService.generatePrDescription(
      this.repositoryPath,
      this.createPrBase,
      this.createPrHead,
      this.createPrTitle || 'Untitled PR',
    );

    if (result.success && result.data) {
      this.createPrBody = result.data.body;
    } else {
      showToast(result.error?.message ?? 'Failed to generate description', 'error');
    }

    this.generatingPrDescription = false;
  }

  private async handleCreatePR(): Promise<void> {
    if (!this.detectedRepo || !this.createPrTitle || !this.createPrHead || !this.createPrBase) return;

    this.isLoading = true;
    this.error = null;

    try {
      const token = await this.getSelectedAccountToken();
      const input: CreatePullRequestInput = {
        title: this.createPrTitle,
        body: this.createPrBody || undefined,
        head: this.createPrHead,
        base: this.createPrBase,
        draft: this.createPrDraft || undefined,
      };

      const result = await gitService.createPullRequest(
        this.detectedRepo.owner,
        this.detectedRepo.repo,
        input,
        token
      );

      if (result.success && result.data) {
        // Reset form and switch to PR list
        this.createPrTitle = '';
        this.createPrBody = '';
        this.createPrHead = '';
        this.createPrBase = '';
        this.createPrDraft = false;
        this.activeTab = 'pull-requests';
        await this.loadPullRequests();
        showToast('Pull request created successfully', 'success');
      } else {
        this.error = result.error?.message ?? 'Failed to create pull request';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to create pull request';
    } finally {
      this.isLoading = false;
    }
  }

  private handlePrFilterChange(e: Event): void {
    const select = e.target as HTMLSelectElement;
    this.prFilter = select.value as 'open' | 'closed' | 'all';
    this.loadPullRequests();
  }

  private handleIssueFilterChange(e: Event): void {
    const select = e.target as HTMLSelectElement;
    this.issueFilter = select.value as 'open' | 'closed' | 'all';
    this.loadIssues();
  }

  private async handleCreateIssue(): Promise<void> {
    if (!this.detectedRepo || !this.createIssueTitle) return;

    this.isLoading = true;
    this.error = null;

    try {
      const token = await this.getSelectedAccountToken();
      const input: CreateIssueInput = {
        title: this.createIssueTitle,
        body: this.createIssueBody || undefined,
        labels: this.createIssueLabels.length > 0 ? this.createIssueLabels : undefined,
      };

      const result = await gitService.createIssue(
        this.detectedRepo.owner,
        this.detectedRepo.repo,
        input,
        token
      );

      if (result.success && result.data) {
        // Reset form and switch to issues list
        this.createIssueTitle = '';
        this.createIssueBody = '';
        this.createIssueLabels = [];
        this.activeTab = 'issues';
        await this.loadIssues();
        showToast('Issue created successfully', 'success');
      } else {
        this.error = result.error?.message ?? 'Failed to create issue';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to create issue';
    } finally {
      this.isLoading = false;
    }
  }

  private toggleIssueLabel(labelName: string): void {
    if (this.createIssueLabels.includes(labelName)) {
      this.createIssueLabels = this.createIssueLabels.filter(l => l !== labelName);
    } else {
      this.createIssueLabels = [...this.createIssueLabels, labelName];
    }
  }

  private getLabelTextColor(bgColor: string): string {
    // Simple luminance check to determine if text should be light or dark
    const hex = bgColor.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? '#000000' : '#ffffff';
  }

  private async handleCreateRelease(): Promise<void> {
    if (!this.detectedRepo || !this.createReleaseTag) return;

    this.isLoading = true;
    this.error = null;

    try {
      const token = await this.getSelectedAccountToken();
      const input: CreateReleaseInput = {
        tagName: this.createReleaseTag,
        name: this.createReleaseName || undefined,
        body: this.createReleaseBody || undefined,
        draft: this.createReleaseDraft || undefined,
        prerelease: this.createReleasePrerelease || undefined,
        generateReleaseNotes: this.createReleaseGenerateNotes || undefined,
      };

      const result = await gitService.createRelease(
        this.detectedRepo.owner,
        this.detectedRepo.repo,
        input,
        token
      );

      if (result.success && result.data) {
        // Reset form and switch to releases list
        this.createReleaseTag = '';
        this.createReleaseName = '';
        this.createReleaseBody = '';
        this.createReleasePrerelease = false;
        this.createReleaseDraft = false;
        this.createReleaseGenerateNotes = true;
        this.activeTab = 'releases';
        await this.loadReleases();
        showToast('Release created successfully', 'success');
      } else {
        this.error = result.error?.message ?? 'Failed to create release';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to create release';
    } finally {
      this.isLoading = false;
    }
  }

  private handleClose(): void {
    this.dispatchEvent(new CustomEvent('close'));
  }

  private openInBrowser(url: string): void {
    openExternalUrl(url);
  }

  /**
   * The badge to show for a pull request.
   *
   * GitHub's REST API reports a MERGED pull request with `state: "closed"` —
   * merged-ness lives in `merged_at`, which the backend already carries all the
   * way here. Reading only `state` gave every merged PR the red "closed" badge,
   * saying the work was abandoned when it had actually landed. The
   * `.pr-state.merged` style existed and nothing could ever reach it.
   *
   * `draft` is only meaningful while the PR is open: GitHub leaves the flag set
   * on a draft that was closed without merging, so checking it first would
   * label a dead PR "draft" forever.
   */
  private getPrState(pr: PullRequestSummary): string {
    if (pr.draft && pr.state === 'open') return 'draft';
    if (pr.mergedAt) return 'merged';
    return pr.state;
  }

  private formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
    return date.toLocaleDateString();
  }

  private renderConnectionTab() {
    if (this.connectionStatus?.connected && this.connectionStatus.user) {
      const user = this.connectionStatus.user;
      return html`
        <div class="connection-status">
          <img class="avatar" src="${user.avatarUrl}" alt="${user.login}" />
          <div class="user-info">
            <div class="user-name">${user.name ?? user.login}</div>
            <div class="user-login">@${user.login}</div>
            ${this.connectionStatus.scopes.length > 0 ? html`
              <div class="scopes">
                ${this.connectionStatus.scopes.map(scope => html`
                  <span class="scope-badge">${scope}</span>
                `)}
              </div>
            ` : ''}
          </div>
          <div class="connection-actions">
            <button class="btn btn-danger" @click=${() => this.handleDisconnect()} ?disabled=${this.isLoading}>Disconnect</button>
            <button class="btn btn-danger-outline" @click=${() => this.handleDeleteIntegration()} ?disabled=${this.isLoading}>Delete</button>
          </div>
        </div>
      `;
    }

    const oauthConfigured = isOAuthConfigured('github');
    const isOAuthPending = this.oauthState.status === 'pending' || this.oauthState.status === 'exchanging';

    return html`
      <div class="token-form">
        <!-- Auth method toggle -->
        <div class="auth-method-toggle">
          <button
            class="auth-method-btn ${this.authMethod === 'oauth' ? 'active' : ''}"
            @click=${() => this.authMethod = 'oauth'}
            ?disabled=${!oauthConfigured}
          >
            Sign in with GitHub
          </button>
          <button
            class="auth-method-btn ${this.authMethod === 'pat' ? 'active' : ''}"
            @click=${() => this.authMethod = 'pat'}
          >
            Personal Access Token
          </button>
          <button
            class="auth-method-btn ${this.authMethod === 'app' ? 'active' : ''}"
            @click=${() => this.authMethod = 'app'}
          >
            GitHub App
          </button>
        </div>

        ${this.authMethod === 'oauth' ? html`
          <!-- OAuth Flow (oauth) -->
          <div class="oauth-section">
            ${isOAuthPending ? html`
              <div class="oauth-pending">
                <div class="oauth-spinner"></div>
                <p>${this.oauthState.status === 'exchanging' ? 'Completing sign in...' : 'Waiting for authorization...'}</p>
                <p class="oauth-hint">Complete the sign in in your browser</p>
                <button class="btn" @click=${this.handleCancelOAuth}>Cancel</button>
              </div>
            ` : html`
              <button
                class="btn btn-oauth"
                @click=${() => this.handleStartOAuth()}
                ?disabled=${this.isLoading || !oauthConfigured}
              >
                <svg class="github-icon" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
                </svg>
                Sign in with GitHub
              </button>
              ${!oauthConfigured ? html`
                <p class="oauth-hint">OAuth is not configured. Use a Personal Access Token instead.</p>
              ` : html`
                <p class="oauth-hint">Opens GitHub in your browser to sign in</p>
              `}
            `}
          </div>
        ` : this.authMethod === 'pat' ? html`
          <!-- PAT Form -->
          <div class="form-group">
            <label>Personal Access Token</label>
            <input
              type="password"
              placeholder="ghp_xxxxxxxxxxxx"
              .value=${this.tokenInput}
              @input=${(e: Event) => this.tokenInput = (e.target as HTMLInputElement).value}
              @change=${(e: Event) => this.tokenInput = (e.target as HTMLInputElement).value}
              @paste=${(e: Event) => {
                const target = e.target as HTMLInputElement;
                setTimeout(() => this.tokenInput = target.value, 0);
              }}
            />
            <span class="help-text">
              Create a token at
              <a
                class="help-link"
                href="https://github.com/settings/tokens/new?scopes=repo,read:user"
                @click=${handleExternalLink}
              >github.com/settings/tokens</a>
              with <code>repo</code> and <code>read:user</code> scopes.
            </span>
          </div>
          <div class="btn-row">
            ${this.selectedAccountId ? html`
              <button
                class="btn btn-danger-outline"
                @click=${() => this.handleDeleteIntegration()}
                ?disabled=${this.isLoading}
              >
                Delete Integration
              </button>
            ` : nothing}
            <button
              class="btn btn-primary"
              @click=${() => this.handleSaveToken()}
              ?disabled=${this.isLoading || !this.tokenInput.trim()}
            >
              Connect to GitHub
            </button>
          </div>
        ` : nothing}

        ${this.authMethod === 'app' ? html`
          <!-- GitHub App Form -->
          <div class="form-group">
            <label>App ID</label>
            <input
              type="text"
              placeholder="123456"
              .value=${this.appId}
              @input=${(e: Event) => {
                this.appId = (e.target as HTMLInputElement).value;
                this.appInstallations = [];
              }}
            />
          </div>
          <div class="form-group">
            <label>Private Key (.pem)</label>
            <textarea
              placeholder="Paste your private key PEM content here..."
              rows="4"
              style="font-family: var(--font-mono, monospace); font-size: 11px; resize: vertical;"
              .value=${this.appPrivateKey}
              @input=${(e: Event) => {
                this.appPrivateKey = (e.target as HTMLTextAreaElement).value;
                this.appInstallations = [];
              }}
            ></textarea>
            <span class="help-text">Paste the private key from your GitHub App settings, or drag and drop the .pem file.</span>
          </div>

          ${this.appId && this.appPrivateKey ? html`
            <div class="form-group">
              <div style="display:flex;align-items:center;justify-content:space-between">
                <label>Installation</label>
                <button
                  class="btn btn-sm"
                  style="font-size:12px;padding:2px 8px"
                  @click=${this.handleLoadInstallations}
                  ?disabled=${this.loadingInstallations}
                >
                  ${this.loadingInstallations ? 'Loading...' : 'Load Installations'}
                </button>
              </div>
              ${this.appInstallations.length > 0 ? html`
                <select
                  .value=${this.appInstallationId}
                  @change=${(e: Event) => this.appInstallationId = (e.target as HTMLSelectElement).value}
                >
                  <option value="">Select installation...</option>
                  ${this.appInstallations.map(inst => html`
                    <option value=${String(inst.id)}>
                      ${inst.account.login} (${inst.targetType})
                    </option>
                  `)}
                </select>
              ` : html`
                <input
                  type="text"
                  placeholder="Installation ID (click Load to discover)"
                  .value=${this.appInstallationId}
                  @input=${(e: Event) => this.appInstallationId = (e.target as HTMLInputElement).value}
                />
              `}
            </div>
          ` : nothing}

          <div class="btn-row">
            <button
              class="btn btn-primary"
              @click=${this.handleConnectGitHubApp}
              ?disabled=${this.isLoading || !this.appId || !this.appPrivateKey || !this.appInstallationId}
            >
              Connect via GitHub App
            </button>
          </div>
          <span class="help-text">
            Create a GitHub App at
            <a class="help-link" href="https://github.com/settings/apps/new" @click=${handleExternalLink}>github.com/settings/apps</a>
            with the permissions your workflow needs.
          </span>
        ` : nothing}
      </div>
    `;
  }

  /**
   * The footer control every paged list tab shares: one button that fetches the
   * next page and appends it. Rendered only when a further page exists, so its
   * absence is itself the "that's the whole list" signal.
   */
  private renderLoadMore(onClick: () => void, isLoading: boolean) {
    return html`
      <div class="load-more">
        <button class="btn" ?disabled=${isLoading} @click=${onClick}>
          ${isLoading ? 'Loading...' : 'Load more'}
        </button>
      </div>
    `;
  }

  private renderPullRequestsTab() {
    if (!this.connectionStatus?.connected) {
      return html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"></path>
          </svg>
          <p>Connect to GitHub to view pull requests</p>
        </div>
      `;
    }

    if (!this.detectedRepo) {
      return html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
          <p>No GitHub repository detected</p>
        </div>
      `;
    }

    return html`
      <div class="filter-row">
        <select class="filter-select" @change=${this.handlePrFilterChange}>
          <option value="open" ?selected=${this.prFilter === 'open'}>Open</option>
          <option value="closed" ?selected=${this.prFilter === 'closed'}>Closed</option>
          <option value="all" ?selected=${this.prFilter === 'all'}>All</option>
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
          <p>No ${this.prFilter} pull requests</p>
        </div>
      ` : ''}

      <div class="pr-list">
        ${this.pullRequests.map(pr => html`
          <div class="pr-item" @click=${() => this.openInBrowser(pr.htmlUrl)}>
            <span class="pr-number">#${pr.number}</span>
            <div class="pr-info">
              <div class="pr-title">${pr.title}</div>
              <div class="pr-meta">
                <span class="pr-state ${this.getPrState(pr)}">${this.getPrState(pr)}</span>
                <span class="pr-branch">${pr.headRef} → ${pr.baseRef}</span>
                <span>by ${pr.user.login}</span>
                <span>${this.formatDate(pr.createdAt)}</span>
              </div>
            </div>
            ${pr.additions != null && pr.deletions != null ? html`
              <div class="pr-stats">
                <span class="stat-additions">+${pr.additions}</span>
                <span class="stat-deletions">-${pr.deletions}</span>
              </div>
            ` : ''}
          </div>
        `)}
      </div>

      ${this.hasMorePrs
        ? this.renderLoadMore(() => this.loadPullRequests(undefined, true), this.isLoadingMorePrs)
        : ''}
    `;
  }

  private renderActionsTab() {
    if (!this.connectionStatus?.connected) {
      return html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"></path>
          </svg>
          <p>Connect to GitHub to view workflow runs</p>
        </div>
      `;
    }

    if (!this.detectedRepo) {
      return html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
          <p>No GitHub repository detected</p>
        </div>
      `;
    }

    return html`
      ${this.workflowRuns.length === 0 ? html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
          </svg>
          <p>No workflow runs found</p>
        </div>
      ` : ''}

      <div class="workflow-list">
        ${this.workflowRuns.map(run => html`
          <div class="workflow-item">
            <div class="workflow-status ${run.conclusion ?? run.status}"></div>
            <div class="workflow-info">
              <div class="workflow-name">${run.name}</div>
              <div class="workflow-meta">
                <span class="workflow-branch">${run.headBranch}</span>
                <span>#${run.runNumber}</span>
                <span>${run.event}</span>
                <span>${this.formatDate(run.createdAt)}</span>
              </div>
            </div>
            <a
              class="workflow-link"
              href="${run.htmlUrl}"
              @click=${(e: Event) => { e.stopPropagation(); handleExternalLink(e); }}
            >
              View →
            </a>
          </div>
        `)}
      </div>

      ${this.hasMoreRuns
        ? this.renderLoadMore(() => this.loadWorkflowRuns(undefined, true), this.isLoadingMoreRuns)
        : ''}
    `;
  }

  private renderIssuesTab() {
    if (!this.connectionStatus?.connected) {
      return html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"></path>
          </svg>
          <p>Connect to GitHub to view issues</p>
        </div>
      `;
    }

    if (!this.detectedRepo) {
      return html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
          <p>No GitHub repository detected</p>
        </div>
      `;
    }

    return html`
      <div class="filter-row">
        <select class="filter-select" @change=${this.handleIssueFilterChange}>
          <option value="open" ?selected=${this.issueFilter === 'open'}>Open</option>
          <option value="closed" ?selected=${this.issueFilter === 'closed'}>Closed</option>
          <option value="all" ?selected=${this.issueFilter === 'all'}>All</option>
        </select>
        <button class="btn" @click=${() => this.activeTab = 'create-issue'}>
          + New Issue
        </button>
      </div>

      ${this.isLoading ? html`<div class="loading">Loading issues...</div>` : ''}

      ${!this.isLoading && this.issues.length === 0 ? html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <p>
            ${this.issuesNextPage === null
              ? html`No ${this.issueFilter} issues`
              : html`No ${this.issueFilter} issues in the pages searched so far`}
          </p>
        </div>
      ` : ''}

      <div class="pr-list">
        ${this.issues.map(issue => html`
          <div class="issue-item" @click=${() => this.openInBrowser(issue.htmlUrl)}>
            <span class="issue-number">#${issue.number}</span>
            <div class="issue-info">
              <div class="issue-title">${issue.title}</div>
              <div class="issue-meta">
                <span class="issue-state ${issue.state}">${issue.state}</span>
                <span>by ${issue.user.login}</span>
                <span>${this.formatDate(issue.createdAt)}</span>
                ${issue.comments > 0 ? html`
                  <span class="issue-comments">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                    </svg>
                    ${issue.comments}
                  </span>
                ` : ''}
              </div>
              ${issue.labels.length > 0 ? html`
                <div class="issue-labels">
                  ${issue.labels.map(label => html`
                    <span
                      class="issue-label"
                      style="background: #${label.color}; color: ${this.getLabelTextColor(label.color)}"
                    >
                      ${label.name}
                    </span>
                  `)}
                </div>
              ` : ''}
            </div>
          </div>
        `)}
      </div>

      ${this.issuesNextPage !== null
        ? this.renderLoadMore(() => this.loadIssues(undefined, true), this.isLoadingMoreIssues)
        : ''}
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
            .value=${this.createIssueBody}
            @input=${(e: Event) => this.createIssueBody = (e.target as HTMLTextAreaElement).value}
          ></textarea>
        </div>

        ${this.repoLabels.length > 0 ? html`
          <div class="form-group">
            <label>Labels</label>
            <div class="issue-labels" style="cursor: pointer;">
              ${this.repoLabels.map(label => html`
                <span
                  class="issue-label"
                  style="
                    background: ${this.createIssueLabels.includes(label.name) ? '#' + label.color : 'var(--color-bg-hover)'};
                    color: ${this.createIssueLabels.includes(label.name) ? this.getLabelTextColor(label.color) : 'var(--color-text-secondary)'};
                    border: 1px solid ${this.createIssueLabels.includes(label.name) ? 'transparent' : 'var(--color-border)'};
                  "
                  @click=${() => this.toggleIssueLabel(label.name)}
                >
                  ${label.name}
                </span>
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
            ?disabled=${this.isLoading || !this.createIssueTitle}
          >
            Create Issue
          </button>
        </div>
      </div>
    `;
  }

  private renderReleasesTab() {
    if (!this.connectionStatus?.connected) {
      return html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"></path>
          </svg>
          <p>Connect to GitHub to view releases</p>
        </div>
      `;
    }

    if (!this.detectedRepo) {
      return html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
          <p>No GitHub repository detected</p>
        </div>
      `;
    }

    return html`
      <div class="filter-row">
        <button class="btn" @click=${() => this.activeTab = 'create-release'}>
          + New Release
        </button>
      </div>

      ${this.isLoading ? html`<div class="loading">Loading releases...</div>` : ''}

      ${!this.isLoading && this.releases.length === 0 ? html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
            <line x1="7" y1="7" x2="7.01" y2="7"></line>
          </svg>
          <p>No releases found</p>
        </div>
      ` : ''}

      <div class="pr-list">
        ${this.releases.map((release, index) => html`
          <div class="release-item" @click=${() => this.openInBrowser(release.htmlUrl)}>
            <span class="release-tag">${release.tagName}</span>
            <div class="release-info">
              <div class="release-title">${release.name || release.tagName}</div>
              <div class="release-meta">
                ${index === 0 && !release.draft && !release.prerelease ? html`
                  <span class="release-badge latest">Latest</span>
                ` : ''}
                ${release.prerelease ? html`
                  <span class="release-badge prerelease">Pre-release</span>
                ` : ''}
                ${release.draft ? html`
                  <span class="release-badge draft">Draft</span>
                ` : ''}
                <span>by ${release.author.login}</span>
                <span>${this.formatDate(release.createdAt)}</span>
                ${release.assetsCount > 0 ? html`
                  <span>${release.assetsCount} asset${release.assetsCount !== 1 ? 's' : ''}</span>
                ` : ''}
              </div>
            </div>
          </div>
        `)}
      </div>

      ${this.hasMoreReleases
        ? this.renderLoadMore(() => this.loadReleases(undefined, true), this.isLoadingMoreReleases)
        : ''}
    `;
  }

  private renderCreateReleaseTab() {
    return html`
      <div class="token-form">
        <div class="form-group">
          <label>Tag Name</label>
          <input
            type="text"
            placeholder="v1.0.0"
            .value=${this.createReleaseTag}
            @input=${(e: Event) => this.createReleaseTag = (e.target as HTMLInputElement).value}
          />
          <span class="help-text">Create a new tag or use an existing one</span>
        </div>

        <div class="form-group">
          <label>Release Title</label>
          <input
            type="text"
            placeholder="Release title (optional)"
            .value=${this.createReleaseName}
            @input=${(e: Event) => this.createReleaseName = (e.target as HTMLInputElement).value}
          />
        </div>

        <div class="form-group">
          <label>Description</label>
          <textarea
            placeholder="Describe this release..."
            .value=${this.createReleaseBody}
            @input=${(e: Event) => this.createReleaseBody = (e.target as HTMLTextAreaElement).value}
          ></textarea>
        </div>

        <div class="form-group">
          <label>
            <input
              type="checkbox"
              .checked=${this.createReleaseGenerateNotes}
              @change=${(e: Event) => this.createReleaseGenerateNotes = (e.target as HTMLInputElement).checked}
            />
            Auto-generate release notes
          </label>
        </div>

        <div class="form-group">
          <label>
            <input
              type="checkbox"
              .checked=${this.createReleasePrerelease}
              @change=${(e: Event) => this.createReleasePrerelease = (e.target as HTMLInputElement).checked}
            />
            Mark as pre-release
          </label>
        </div>

        <div class="form-group">
          <label>
            <input
              type="checkbox"
              .checked=${this.createReleaseDraft}
              @change=${(e: Event) => this.createReleaseDraft = (e.target as HTMLInputElement).checked}
            />
            Save as draft
          </label>
        </div>

        <div class="btn-row">
          <button class="btn" @click=${() => this.activeTab = 'releases'}>
            Cancel
          </button>
          <button
            class="btn btn-primary"
            @click=${this.handleCreateRelease}
            ?disabled=${this.isLoading || !this.createReleaseTag}
          >
            Create Release
          </button>
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
    this.createPrHead = sourceBranch;
    if (baseBranch && !this.createPrBase) {
      this.createPrBase = baseBranch;
    }
    this.activeTab = 'create-pr';
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
              ?disabled=${this.generatingPrDescription || !this.createPrHead || !this.createPrBase}
              title="Generate description using AI"
            >
              ${this.generatingPrDescription ? 'Generating...' : html`<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a3.5 3.5 0 0 0-3.5 3.5c0 1.193.603 2.26 1.5 2.898V9.5a1 1 0 0 0 .293.707l1 1a1 1 0 0 0 1.414 0l1-1A1 1 0 0 0 10 9.5V7.398A3.496 3.496 0 0 0 11.5 4.5 3.5 3.5 0 0 0 8 1z"/></svg> AI Generate`}
            </button>
          </div>
          <textarea
            placeholder="Describe your changes..."
            .value=${this.createPrBody}
            @input=${(e: Event) => this.createPrBody = (e.target as HTMLTextAreaElement).value}
          ></textarea>
        </div>

        <div class="form-group">
          <label>Head Branch (your changes)</label>
          <input
            type="text"
            placeholder="feature-branch"
            .value=${this.createPrHead}
            @input=${(e: Event) => this.createPrHead = (e.target as HTMLInputElement).value}
          />
        </div>

        <div class="form-group">
          <label>Base Branch (merge into)</label>
          <input
            type="text"
            placeholder="main"
            .value=${this.createPrBase}
            @input=${(e: Event) => this.createPrBase = (e.target as HTMLInputElement).value}
          />
        </div>

        <div class="form-group">
          <label>
            <input
              type="checkbox"
              .checked=${this.createPrDraft}
              @change=${(e: Event) => this.createPrDraft = (e.target as HTMLInputElement).checked}
            />
            Create as draft
          </label>
        </div>

        <div class="btn-row">
          <button class="btn" @click=${() => this.activeTab = 'pull-requests'}>
            Cancel
          </button>
          <button
            class="btn btn-primary"
            @click=${this.handleCreatePR}
            ?disabled=${this.isLoading || !this.createPrTitle || !this.createPrHead || !this.createPrBase}
          >
            Create Pull Request
          </button>
        </div>
      </div>
    `;
  }

  render() {
    return html`
      <lv-modal
        ?open=${this.open}
        ?backButton=${this.backButton}
        modalTitle="GitHub"
        @close=${this.handleClose}
      >
        <div class="content">
          ${this.attachToProfileName
            ? html`<div class="attach-breadcrumb" data-testid="attach-breadcrumb">Adding to <strong>${this.attachToProfileName}</strong></div>`
            : nothing}
          ${this.detectedRepo ? html`
            <div class="repo-info">
              <svg class="repo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path>
              </svg>
              <span class="repo-name">${this.detectedRepo.owner}/${this.detectedRepo.repo}</span>
              <span class="repo-remote">(${this.detectedRepo.remoteName})</span>
            </div>
          ` : ''}

          ${this.accounts.length > 0 || this.connectionStatus?.connected ? html`
            <lv-account-selector
              integrationType="github"
              .selectedAccountId=${this.selectedAccountId}
              @account-change=${this.handleAccountChange}
              @add-account=${this.handleAddAccount}
              @manage-accounts=${this.handleManageAccounts}
            ></lv-account-selector>
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
              @click=${() => this.activeTab = 'pull-requests'}
            >
              Pull Requests
            </button>
            <button
              class="tab ${this.activeTab === 'issues' ? 'active' : ''}"
              @click=${() => this.activeTab = 'issues'}
            >
              Issues
            </button>
            <button
              class="tab ${this.activeTab === 'releases' ? 'active' : ''}"
              @click=${() => this.activeTab = 'releases'}
            >
              Releases
            </button>
            <button
              class="tab ${this.activeTab === 'actions' ? 'active' : ''}"
              @click=${() => this.activeTab = 'actions'}
            >
              Actions
            </button>
          </div>

          ${this.error ? html`
            <div class="error-message">${this.error}</div>
          ` : ''}

          <div class="tab-content">
            ${this.activeTab === 'connection' ? this.renderConnectionTab() : ''}
            ${this.activeTab === 'pull-requests' ? this.renderPullRequestsTab() : ''}
            ${this.activeTab === 'issues' ? this.renderIssuesTab() : ''}
            ${this.activeTab === 'releases' ? this.renderReleasesTab() : ''}
            ${this.activeTab === 'actions' ? this.renderActionsTab() : ''}
            ${this.activeTab === 'create-pr' ? this.renderCreatePrTab() : ''}
            ${this.activeTab === 'create-issue' ? this.renderCreateIssueTab() : ''}
            ${this.activeTab === 'create-release' ? this.renderCreateReleaseTab() : ''}
          </div>
        </div>
      </lv-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-github-dialog': LvGitHubDialog;
  }
}
