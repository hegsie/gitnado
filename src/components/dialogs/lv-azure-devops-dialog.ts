/**
 * Azure DevOps Integration Dialog
 * Manage Azure DevOps connection, view PRs, work items, and pipelines
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import * as aiService from '../../services/ai.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import { loggers, openExternalUrl, handleExternalLink } from '../../utils/index.ts';
import * as oauthService from '../../services/oauth.service.ts';
import type { OAuthTokenResponse } from '../../types/oauth.types.ts';

const log = loggers.azureDevOps;
import type {
  AdoConnectionStatus,
  DetectedAdoRepo,
  AdoPullRequest,
  AdoWorkItem,
  AdoPipelineRun,
  AdoOrganization,
  CreateAdoPullRequestInput,
  CreateAdoWorkItemInput,
} from '../../services/git.service.ts';
import { unifiedProfileStore, getAccountsByType, selectDefaultGlobalAccount, getActiveProfilePreferredAccount } from '../../stores/unified-profile.store.ts';
import * as unifiedProfileService from '../../services/unified-profile.service.ts';
import type { IntegrationAccount } from '../../types/unified-profile.types.ts';
import * as credentialService from '../../services/credential.service.ts';
import './lv-modal.ts';
import './lv-account-selector.ts';

type TabType = 'connection' | 'pull-requests' | 'work-items' | 'pipelines' | 'create-pr' | 'create-work-item';

/**
 * Page size this dialog asks for when listing work items. Passed straight into
 * the listing call as `limit`, so the number the request caps at and the number
 * the "capped" hint discloses are the same constant. When the list is exactly
 * this long, more may exist and the tab shows the hint.
 */
const WORK_ITEMS_PAGE_SIZE = 50;

/**
 * Page size this dialog asks for when listing pipeline runs and pull requests.
 * Both are passed straight into the listing call as `top`, so the number the
 * request caps at and the number the "capped" hint discloses are the same
 * constant — never a literal at the call site.
 */
const PIPELINE_RUNS_PAGE_SIZE = 20;
const PULL_REQUESTS_PAGE_SIZE = 100;

/** Shown when a PAT connect succeeded but writing the keyring git credential did not. */
const GIT_CRED_WRITE_FAILED_TOAST =
  'Connected, but saving git credentials failed — push/pull may prompt for credentials';

/** OAuth tokens carried from an Entra sign-in through org resolution to persistence. */
interface EntraTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

@customElement('lv-azure-devops-dialog')
export class LvAzureDevOpsDialog extends LitElement {
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

      .user-avatar {
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

      .user-org {
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

      /* Official Microsoft-branded sign-in button (light variant). Kept close to
         Microsoft's brand guidelines: white background, square corners, the
         four-square logo, "Sign in with Microsoft" in Segoe UI. */
      .ms-signin-btn {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        height: 41px;
        padding: 0 12px;
        background: #ffffff;
        border: 1px solid #8c8c8c;
        border-radius: 0;
        color: #5e5e5e;
        font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 15px;
        font-weight: 600;
        cursor: pointer;
        transition: background var(--transition-fast);
      }

      .ms-signin-btn:hover:not(:disabled) {
        background: #f5f5f5;
      }

      /* Keeps the Microsoft-blue ring on the branded sign-in button. Expressed
         through the shared focus-ring properties rather than an outline
         declaration, because the shared rule in sharedStyles is !important. */
      .ms-signin-btn {
        --lv-focus-ring-color: #0067b8;
        --lv-focus-ring-offset: 1px;
      }

      .ms-signin-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
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

      .pr-state.active {
        background: var(--color-success-bg);
        color: var(--color-success);
      }

      .pr-state.completed {
        background: #8250df20;
        color: #8250df;
      }

      .pr-state.abandoned {
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      .pr-state.draft {
        background: var(--color-bg-hover);
        color: var(--color-text-muted);
      }

      /* Work Item styles */
      .work-item {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-md);
        padding: var(--spacing-md);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: background var(--transition-fast);
      }

      .work-item:hover {
        background: var(--color-bg-hover);
      }

      .work-item-id {
        font-weight: var(--font-weight-semibold);
        color: var(--color-primary);
        min-width: 50px;
      }

      .work-item-info {
        flex: 1;
        min-width: 0;
      }

      .work-item-title {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        margin-bottom: var(--spacing-xs);
      }

      .work-item-meta {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-sm);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .work-item-type {
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
      }

      .work-item-type.bug {
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      .work-item-type.task {
        background: var(--color-warning-bg);
        color: var(--color-warning);
      }

      .work-item-type.user-story {
        background: var(--color-success-bg);
        color: var(--color-success);
      }

      .work-item-type.feature {
        background: #8250df20;
        color: #8250df;
      }

      .work-item-state {
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        background: var(--color-bg-hover);
        color: var(--color-text-secondary);
      }

      /* Pipeline styles */
      .pipeline-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
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

      .pipeline-status.succeeded {
        background: var(--color-success);
      }

      .pipeline-status.failed {
        background: var(--color-error);
      }

      .pipeline-status.inProgress,
      .pipeline-status.notStarted {
        background: var(--color-warning);
        animation: pulse 2s infinite;
      }

      .pipeline-status.canceled {
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

      /* Detected Repo */
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

      /* Utility */
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

      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--spacing-xs);
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-md);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        transition: all var(--transition-fast);
        background: var(--color-bg-tertiary);
        color: var(--color-text-primary);
        border: 1px solid var(--color-border);
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
        color: white;
        border-color: var(--color-primary);
      }

      .btn-primary:hover:not(:disabled) {
        background: var(--color-primary-hover);
      }

      .btn-danger {
        background: var(--color-error);
        color: white;
        border-color: var(--color-error);
      }

      .btn-danger:hover:not(:disabled) {
        opacity: 0.9;
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

    `,
  ];

  @property({ type: Boolean }) open = false;
  @property({ type: String }) repositoryPath = '';
  /**
   * Show a back arrow instead of a close ×. Set explicitly by the host ONLY when
   * this dialog was opened with a return target (the profile manager).
   */
  @property({ type: Boolean }) backButton = false;
  /** Profile name for the "Adding to <name>" breadcrumb; empty when standalone. */
  @property({ type: String }) attachToProfileName = '';

  @state() private activeTab: TabType = 'connection';
  @state() private connectionStatus: AdoConnectionStatus | null = null;
  @state() private detectedRepo: DetectedAdoRepo | null = null;
  @state() private pullRequests: AdoPullRequest[] = [];
  @state() private workItems: AdoWorkItem[] = [];
  @state() private pipelineRuns: AdoPipelineRun[] = [];
  @state() private isLoading = false;
  @state() private error: string | null = null;
  @state() private tokenInput = '';
  @state() private organizationInput = '';
  @state() private hasStoredToken = false;
  @state() private authMethod: 'oauth' | 'pat' = 'pat';
  /** True from the moment "Sign in with Microsoft" is clicked until the flow settles. */
  @state() private oauthPending = false;
  /** `oauth-complete` window listener for the interactive loopback flow. */
  private oauthCompleteHandler?: EventListener;
  /** Unsubscribe handle for the OAuth state-change subscription (error surfacing). */
  private oauthStateUnsubscribe?: () => void;
  /**
   * The `entraGeneration` captured when the current sign-in was started. The
   * global `oauth-complete` event carries no generation, so the handler compares
   * this against `entraGeneration` to ignore a callback for an abandoned flow.
   */
  private entraFlowGeneration = 0;
  /** Org typed on the PAT form, stashed while on the OAuth tab so it survives a round-trip. */
  private savedPatOrg = '';
  /** Last `${org}::${token}` written to the keyring git credential, to skip redundant re-syncs. */
  private lastSyncedGitCredKey: string | null = null;
  /**
   * Bumped whenever an Entra sign-in should be abandoned (new start, cancel,
   * close, disconnect). Async continuations capture the value at start and bail
   * if it changed — so closing the dialog mid-finalize can't silently connect.
   */
  private entraGeneration = 0;
  @state() private availableOrgs: AdoOrganization[] = [];
  @state() private needsOrgSelection = false;
  private pendingTokens: EntraTokens | null = null;
  @state() private prFilter: 'active' | 'completed' | 'abandoned' | 'all' = 'active';
  @state() private workItemFilter: string = '';

  // Multi-account support (global accounts)
  @state() private accounts: IntegrationAccount[] = [];
  @state() private selectedAccountId: string | null = null;

  private unsubscribeStore?: () => void;
  private loadGeneration = 0;
  // Set while the user is mid-"Add account" (selection intentionally cleared so
  // the next save creates a NEW account). Guards the store subscription from
  // re-selecting an existing account on a background emit.
  private isAddingAccount = false;

  // Create PR form
  @state() private createPrTitle = '';
  @state() private createPrDescription = '';
  @state() private createPrSource = '';
  @state() private createPrTarget = '';
  @state() private createPrDraft = false;
  @state() private generatingPrDescription = false;

  // Create Work Item form
  @state() private createWorkItemType = 'Task';
  @state() private createWorkItemTitle = '';
  @state() private createWorkItemDescription = '';

  async connectedCallback(): Promise<void> {
    super.connectedCallback();

    // Interactive Entra sign-in (auth-code + loopback) completes asynchronously
    // via a global `oauth-complete` window event dispatched by the OAuth service.
    // Route the azure one into org resolution + finalize.
    this.oauthCompleteHandler = ((e: CustomEvent<{ provider: string; tokens: OAuthTokenResponse; instanceUrl?: string }>) => {
      if (e.detail.provider === 'azure') {
        void this.handleOAuthComplete(e.detail.tokens);
      }
    }) as unknown as EventListener;
    window.addEventListener('oauth-complete', this.oauthCompleteHandler);

    // Surface a failed/denied sign-in so the pending spinner clears with feedback.
    this.oauthStateUnsubscribe = oauthService.onOAuthStateChange((state) => {
      if (state.provider !== 'azure') return;
      // Ignore state for a flow the dialog already abandoned (cancel/close/switch).
      if (this.entraFlowGeneration !== this.entraGeneration) return;
      if (state.status === 'error') {
        this.oauthPending = false;
        this.error = state.error ?? 'Microsoft sign-in failed';
        showToast(this.error, 'error');
      }
    });

    // Subscribe to unified profile store. When the active profile changes,
    // re-derive the preferred account so a profile switch is reflected here.
    let lastActiveProfileId = unifiedProfileStore.getState().activeProfile?.id ?? null;
    const applyAccount = (account: IntegrationAccount | undefined) => {
      if (!account) return;
      this.selectedAccountId = account.id;
      if (account.config.type === 'azure-devops' && account.config.organization) {
        this.organizationInput = account.config.organization;
      }
    };
    this.unsubscribeStore = unifiedProfileStore.subscribe((state) => {
      this.accounts = getAccountsByType('azure-devops');
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
          applyAccount(getActiveProfilePreferredAccount('azure-devops') ?? this.accounts[0]);
        }
      } else if (!this.isAddingAccount && !this.selectedAccountId && this.accounts.length > 0) {
        applyAccount(
          getActiveProfilePreferredAccount('azure-devops')
          ?? selectDefaultGlobalAccount('azure-devops')
          ?? this.accounts[0],
        );
      }
    });

    // Initialize from current state
    this.accounts = getAccountsByType('azure-devops');
    if (this.accounts.length > 0 && !this.selectedAccountId) {
      applyAccount(
        getActiveProfilePreferredAccount('azure-devops')
        ?? selectDefaultGlobalAccount('azure-devops')
        ?? this.accounts[0],
      );
    }

    if (this.open) {
      await this.loadInitialData();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeStore?.();
    // Cancel any in-flight sign-in so its callback can't fire after unmount, and
    // invalidate continuations so a late finalize can't mutate a dead element.
    this.abandonPendingEntraFlow();
    if (this.oauthCompleteHandler) {
      window.removeEventListener('oauth-complete', this.oauthCompleteHandler);
    }
    this.oauthStateUnsubscribe?.();
  }

  async updated(changedProperties: Map<string, unknown>): Promise<void> {
    if (changedProperties.has('open') && this.open) {
      // Fresh open: abandon any sign-in left in-flight from a prior session
      // (the host may hide the dialog without routing through handleClose, e.g.
      // by setting its `open` prop false), so a reopen can't surface a stuck
      // "Connecting..." spinner. Then clear selectedAccountId so
      // loadInitialData() re-derives it.
      this.abandonPendingEntraFlow();
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
    this.createPrDescription = '';
    this.createPrSource = '';
    this.createPrTarget = '';
    this.createPrDraft = false;
    this.createWorkItemType = 'Task';
    this.createWorkItemTitle = '';
    this.createWorkItemDescription = '';
    if (this.activeTab.startsWith('create-')) {
      this.activeTab = 'connection';
    }
  }

  private async loadInitialData(): Promise<void> {
    const generation = ++this.loadGeneration;
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
      this.accounts = getAccountsByType('azure-devops');
      if (this.accounts.length > 0 && !this.selectedAccountId) {
        const preferred = getActiveProfilePreferredAccount('azure-devops')
          ?? selectDefaultGlobalAccount('azure-devops');
        this.selectedAccountId = preferred?.id ?? this.accounts[0]?.id ?? null;
        if (preferred?.config.type === 'azure-devops' && preferred.config.organization) {
          this.organizationInput = preferred.config.organization;
        }
      }

      // Check if selected account has a stored token
      await this.checkStoredToken();
      if (generation !== this.loadGeneration) return;

      // Try to detect repo first to get organization
      if (this.repositoryPath) {
        await this.detectRepo();
        if (generation !== this.loadGeneration) return;
      }
      // Check connection if we have an organization
      if (this.detectedRepo?.organization || this.organizationInput) {
        await this.checkConnection();
        if (generation !== this.loadGeneration) return;

        // Load data now that we know the connection status
        if (this.connectionStatus?.connected && this.detectedRepo) {
          await this.loadAllData();
        }
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

  private async checkStoredToken(): Promise<void> {
    if (this.selectedAccountId) {
      let token = await credentialService.getAccountToken('azure-devops', this.selectedAccountId);

      // If not found, check legacy token and migrate it
      if (!token) {
        const legacyToken = await credentialService.AzureDevOpsCredentials.getToken();
        if (legacyToken) {
          await credentialService.storeAccountToken('azure-devops', this.selectedAccountId, legacyToken);
          token = legacyToken;
        }
      }

      this.hasStoredToken = !!token;
    } else {
      this.hasStoredToken = false;
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

  private async checkConnection(): Promise<void> {
    const org = this.detectedRepo?.organization || this.organizationInput;
    if (!org) return;

    // Get token for selected account (refresh-aware for OAuth accounts).
    const token = await this.getSelectedAccountToken();
    const result = await gitService.checkAdoConnectionWithToken(org, token);
    if (result.success && result.data) {
      this.connectionStatus = result.data;
      this.syncSharedConnectionStatus(result.data.connected);
      // Update cached user in global account if connected
      if (this.selectedAccountId && result.data.connected && result.data.user) {
        await unifiedProfileService.updateGlobalAccountCachedUser(this.selectedAccountId, {
          username: result.data.user.displayName,
          displayName: result.data.user.displayName,
          email: null, // ADO API doesn't return email in this context
          avatarUrl: result.data.user.imageUrl ?? null,
        });
      }

      // Sync the keyring git credentials only with a VERIFIED-connected token, so
      // external git push/pull get a valid credential (never a stale fallback).
      if (result.data.connected && token) {
        await this.syncGitCredentials(org, token);
      }
    } else if (!result.success) {
      log.error('checkConnection failed:', result.error?.message);
      // Failed check must mark the account as disconnected so dependent UI
      // surfaces (toolbar, selector dot) don't keep a stale connected state.
      this.connectionStatus = { connected: false, user: null, organization: org };
      this.syncSharedConnectionStatus(false);
    }
  }

  /**
   * Get the token for the currently selected account, refreshing an expiring
   * Entra OAuth token first (and re-syncing the keyring git credentials so
   * push/pull stay valid). Non-OAuth (PAT) accounts return their stored token.
   */
  private async getSelectedAccountToken(): Promise<string | null> {
    if (!this.selectedAccountId) return null;

    // Refresh-aware: for an OAuth account this returns a freshly-refreshed access
    // token when the stored one is near expiry; for a PAT it returns it unchanged.
    let token = await credentialService.getFreshAccountToken(
      'azure-devops',
      this.selectedAccountId,
      'azure',
    );

    // If not found, check legacy token and migrate it
    if (!token) {
      const legacyToken = await credentialService.AzureDevOpsCredentials.getToken();
      if (legacyToken) {
        try {
          await credentialService.storeAccountToken('azure-devops', this.selectedAccountId, legacyToken);
        } catch { /* migration failed, still use the token */ }
        token = legacyToken;
      }
    }

    return token;
  }

  /**
   * Write the git credentials for `org` to the OS keyring so git push/pull
   * outside this dialog use a valid credential. Only call this with a token that
   * has been VERIFIED to work (a connected check) — never a stale fallback, which
   * would clobber a previously-valid credential. Deduped by (org, token) to avoid
   * redundant keyring writes on hot paths.
   * Returns false when a keyring write failed, so a user-initiated connect can
   * tell the user push/pull will still prompt.
   */
  private async syncGitCredentials(org: string, token: string): Promise<boolean> {
    const syncKey = `${org}::${token}`;
    if (syncKey === this.lastSyncedGitCredKey) return true;
    // storeGitCredentials resolves to a CommandResult (it never throws), so check
    // .success and only mark synced on success — otherwise a failed write would be
    // stickily suppressed and never retried.
    const c1 = await gitService.storeGitCredentials('https://dev.azure.com', 'pat', token);
    const c2 = await gitService.storeGitCredentials(`https://${org}.visualstudio.com`, 'pat', token);
    if (c1.success && c2.success) {
      this.lastSyncedGitCredKey = syncKey;
      return true;
    }
    log.warn('Failed to sync Azure DevOps git credentials to keyring:', c1.error ?? c2.error);
    return false;
  }

  /**
   * Handle account selection change
   */
  private async handleAccountChange(e: CustomEvent<{ account: IntegrationAccount }>): Promise<void> {
    const { account } = e.detail;
    // Abandon any in-flight Entra sign-in BEFORE switching accounts, or a
    // completing flow would persist its token/identity onto the newly selected
    // account.
    this.abandonPendingEntraFlow();
    // The user explicitly selected an existing account — re-enable the
    // subscription's auto-apply branch.
    this.isAddingAccount = false;
    this.selectedAccountId = account.id;
    this.connectionStatus = null;
    this.error = null;
    this.tokenInput = ''; // Clear any manually entered token

    // Update organization from account config
    if (account.config.type === 'azure-devops' && account.config.organization) {
      this.organizationInput = account.config.organization;
    }

    // Check if this account has a stored token
    await this.checkStoredToken();

    // Re-check connection with new account
    await this.loadInitialData();
  }

  /**
   * Handle add account request
   */
  private handleAddAccount(): void {
    // Abandon any in-flight Entra sign-in before clearing the selection, or a
    // completing flow would create/overwrite an unexpected account.
    this.abandonPendingEntraFlow();
    // Clear selection so the next token save creates a new account instead of
    // overwriting the previously-selected account's token. Also clear the org:
    // otherwise a new Entra sign-in would reuse the previous account's org and
    // bypass the org picker (binding the new account to the wrong org). Rotating
    // an existing selected account still uses that account's org.
    this.isAddingAccount = true;
    this.activeTab = 'connection';
    this.connectionStatus = null;
    this.selectedAccountId = null;
    this.tokenInput = '';
    this.organizationInput = '';
  }

  /**
   * Handle manage accounts request
   */
  private handleManageAccounts(e: Event): void {
    // Navigating to the Accounts view hides (but doesn't unmount) this dialog and
    // can re-derive selectedAccountId on the way back, so abandon any in-flight
    // Entra sign-in first — otherwise a late poll could write to the wrong account.
    this.abandonPendingEntraFlow();
    // Consume the account-selector's bubbling/composed event so it can't ALSO
    // reach the host — otherwise the host would receive both it and our re-dispatch
    // below, firing its handler twice (the second pass corrupts reversible-Back state).
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent('manage-accounts', {
        detail: { integrationType: 'azure-devops' },
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
    const result = await gitService.detectAdoRepo(requestedPath);
    if (this.repositoryPath !== requestedPath) return;
    if (result.success && result.data) {
      this.detectedRepo = result.data;
      this.organizationInput = result.data.organization;
      // Auto-load data if connected
      if (this.connectionStatus?.connected) {
        await this.loadAllData();
      }
    } else if (!result.success) {
      // A genuine backend failure (not merely "this isn't an Azure DevOps repo",
      // which surfaces as success with null data) must not fail silently.
      this.error = result.error?.message ?? 'Failed to detect Azure DevOps repository';
    }
  }

  private async loadAllData(providedToken?: string): Promise<void> {
    await Promise.all([
      this.loadPullRequests(providedToken),
      this.loadWorkItems(providedToken),
      this.loadPipelineRuns(providedToken),
    ]);
  }

  private async loadPullRequests(providedToken?: string): Promise<void> {
    if (!this.detectedRepo || !this.connectionStatus?.connected) return;

    this.isLoading = true;
    this.error = null;

    try {
      const token = providedToken ?? await this.getSelectedAccountToken();
      const result = await gitService.listAdoPullRequests(
        this.detectedRepo.organization,
        this.detectedRepo.project,
        this.detectedRepo.repository,
        // Always send the filter: Azure DevOps defaults `searchCriteria.status`
        // to `active`, so omitting it for "All" would return the Active list
        // again and silently drop completed and abandoned pull requests. `all`
        // is a valid PullRequestStatus, so it goes over the wire like the rest.
        this.prFilter,
        PULL_REQUESTS_PAGE_SIZE,
        token
      );

      if (result.success && result.data) {
        this.pullRequests = result.data;
      } else {
        this.error = result.error?.message ?? 'Failed to load pull requests';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to load pull requests';
    } finally {
      this.isLoading = false;
    }
  }

  private async loadWorkItems(providedToken?: string): Promise<void> {
    if (!this.detectedRepo || !this.connectionStatus?.connected) return;

    // Clear any stale error (e.g. from another tab) so a successful load starts
    // clean — matches loadPullRequests.
    this.error = null;

    try {
      const token = providedToken ?? await this.getSelectedAccountToken();
      const result = await gitService.queryAdoWorkItems(
        this.detectedRepo.organization,
        this.detectedRepo.project,
        this.workItemFilter || undefined,
        WORK_ITEMS_PAGE_SIZE,
        token
      );

      if (result.success && result.data) {
        this.workItems = result.data;
      } else if (!result.success) {
        this.error = result.error?.message ?? 'Failed to load work items';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to load work items';
    }
  }

  private async loadPipelineRuns(providedToken?: string): Promise<void> {
    if (!this.detectedRepo || !this.connectionStatus?.connected) return;

    // Clear any stale error (e.g. from another tab) so a successful load starts
    // clean — matches loadPullRequests / loadWorkItems.
    this.error = null;

    try {
      const token = providedToken ?? await this.getSelectedAccountToken();
      const result = await gitService.listAdoPipelineRuns(
        this.detectedRepo.organization,
        this.detectedRepo.project,
        this.detectedRepo.repository,
        PIPELINE_RUNS_PAGE_SIZE,
        token
      );

      if (result.success && result.data) {
        this.pipelineRuns = result.data;
      } else if (!result.success) {
        this.error = result.error?.message ?? 'Failed to load pipeline runs';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to load pipeline runs';
    }
  }

  /**
   * Start the one-click Microsoft (Entra ID) sign-in via the interactive
   * authorization-code + loopback flow (the same path GitHub/GitLab use). Opens
   * the Microsoft sign-in page in the browser; the OAuth service waits on the
   * loopback callback, exchanges the code, and dispatches a global
   * `oauth-complete` event that `handleOAuthComplete` picks up. Uses Microsoft's
   * Visual Studio first-party public client — no per-user app registration and no
   * admin consent.
   */
  private async handleStartEntraOAuth(): Promise<void> {
    // Guard against a double-click starting a second (orphaned) flow.
    if (this.oauthPending) return;

    this.entraFlowGeneration = ++this.entraGeneration;
    this.oauthPending = true;
    this.error = null;

    // Fire-and-forget: startOAuth opens the browser and drives the loopback
    // callback → code exchange, then dispatches `oauth-complete`. Errors surface
    // through the onOAuthStateChange subscription registered in connectedCallback.
    await oauthService.startOAuth('azure', oauthService.getClientId('azure'));
  }

  /**
   * Handle a completed interactive Entra sign-in: route the exchanged tokens into
   * org resolution + finalize. Ignores a callback for a flow the dialog already
   * abandoned (the user cancelled/closed or switched accounts mid-flow).
   */
  private async handleOAuthComplete(tokens: OAuthTokenResponse): Promise<void> {
    const generation = this.entraFlowGeneration;
    if (generation !== this.entraGeneration) return;
    // resolveOrgAndFinalize owns the loading/error/oauthPending state from here.
    await this.resolveOrgAndFinalize(
      {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      },
      generation,
    );
  }

  /**
   * Resolve which Azure DevOps organization to use after an Entra sign-in, then
   * finalize. Prefer the org detected from the repo remote; otherwise list the
   * user's orgs — 1 is used automatically, >1 shows an in-dialog picker, 0 errors.
   */
  private async resolveOrgAndFinalize(tokens: EntraTokens, generation: number): Promise<void> {
    this.isLoading = true;
    this.error = null;
    try {
      let org = this.detectedRepo?.organization || this.organizationInput.trim();
      if (!org) {
        const orgsResult = await gitService.listAdoOrganizations(tokens.accessToken);
        if (generation !== this.entraGeneration) return; // dialog closed/cancelled
        if (!orgsResult.success || !orgsResult.data) {
          this.error = orgsResult.error?.message ?? 'Failed to list Azure DevOps organizations';
          showToast(this.error, 'error');
          return;
        }
        if (orgsResult.data.length === 1) {
          org = orgsResult.data[0].name;
        } else if (orgsResult.data.length > 1) {
          // Defer: let the user pick. Stash tokens + orgs and show the picker.
          this.availableOrgs = orgsResult.data;
          this.pendingTokens = tokens;
          this.needsOrgSelection = true;
          return;
        } else {
          this.error = 'No Azure DevOps organizations found for this Microsoft account';
          showToast(this.error, 'error');
          return;
        }
      }
      this.organizationInput = org;
      await this.finalizeEntraLogin(tokens, org, generation);
    } catch (err) {
      if (generation !== this.entraGeneration) return;
      this.error = err instanceof Error ? err.message : 'Failed to complete Microsoft sign-in';
      showToast(this.error, 'error');
    } finally {
      // Only reset shared state if this flow is still current — a superseding
      // flow (close→reopen→restart) may already own oauthPending/isLoading.
      if (generation === this.entraGeneration) {
        this.oauthPending = false;
        this.isLoading = false;
      }
    }
  }

  /**
   * Complete an in-dialog org selection: finalize the sign-in with the chosen
   * organization. The picker is only dismissed on success — on failure the token
   * and org list are retained so the user can pick another org without re-signing.
   */
  private async handleSelectOrg(org: AdoOrganization): Promise<void> {
    const tokens = this.pendingTokens;
    if (!tokens) return;
    const generation = this.entraGeneration;
    this.isLoading = true;
    this.error = null;
    try {
      this.organizationInput = org.name;
      await this.finalizeEntraLogin(tokens, org.name, generation);
      if (generation !== this.entraGeneration) return; // dialog closed while finalizing
      // finalizeEntraLogin sets this.error on verification failure without throwing.
      if (!this.error) {
        this.needsOrgSelection = false;
        this.pendingTokens = null;
        this.availableOrgs = [];
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to complete Microsoft sign-in';
      showToast(this.error, 'error');
      // Keep the picker + tokens so the user can retry or choose another org.
    } finally {
      if (generation === this.entraGeneration) {
        this.isLoading = false;
      }
    }
  }

  /**
   * Abandon a pending org selection and return to the "Sign in with Microsoft"
   * button, discarding the unused token and org list.
   */
  private handleCancelOrgSelection(): void {
    this.needsOrgSelection = false;
    this.pendingTokens = null;
    this.availableOrgs = [];
    this.error = null;
  }

  /**
   * Verify the Entra token against `organization`, then persist the account,
   * OAuth token (with refresh token + expiry), and git credentials. Handles both
   * rotating an existing account and creating a new one (mirrors the PAT path).
   */
  private async finalizeEntraLogin(
    tokens: EntraTokens,
    organization: string,
    generation: number,
  ): Promise<void> {
    const accessToken = tokens.accessToken;
    // Verify connection BEFORE persisting anything
    const result = await gitService.checkAdoConnectionWithToken(organization, accessToken);

    // If the dialog was closed/cancelled during verification, do NOT persist an
    // account, store credentials, or show a success toast for a dismissed flow.
    if (generation !== this.entraGeneration) return;

    if (result.success && result.data?.connected) {
      const user = result.data.user;
      const cachedUser = user
        ? {
            username: user.displayName,
            displayName: user.displayName,
            email: null, // ADO API doesn't return email in this context
            avatarUrl: user.imageUrl ?? null,
          }
        : null;

      if (this.selectedAccountId) {
        // Rotating credentials on an existing account. Store the full OAuth
        // bundle (access + refresh + expiry) so the token can be refreshed —
        // Entra access tokens are short-lived (~1h).
        await credentialService.storeAccountOAuthToken(
          'azure-devops',
          this.selectedAccountId,
          accessToken,
          tokens.refreshToken,
          tokens.expiresIn,
        );
        if (cachedUser) {
          await unifiedProfileService.updateGlobalAccountCachedUser(
            this.selectedAccountId,
            cachedUser,
          );
        }
      } else {
        // No account selected - create and persist a new global account
        // (mirror the PAT path) BEFORE storing the token so the keyring
        // entry is never orphaned.
        const { createEmptyIntegrationAccount, generateId } = await import(
          '../../types/unified-profile.types.ts'
        );
        const newAccount: IntegrationAccount = {
          ...createEmptyIntegrationAccount('azure-devops', organization),
          id: generateId(),
          name: user?.displayName
            ? `Azure DevOps (${user.displayName})`
            : `Azure DevOps (${organization})`,
          isDefault: this.accounts.length === 0,
          cachedUser,
        };

        const savedAccount = await unifiedProfileService.saveGlobalAccount(newAccount);
        await credentialService.storeAccountOAuthToken(
          'azure-devops',
          savedAccount.id,
          accessToken,
          tokens.refreshToken,
          tokens.expiresIn,
        );
        this.selectedAccountId = savedAccount.id;
        // The new account now exists and is selected — add flow complete.
        this.isAddingAccount = false;

        // Refresh accounts list
        await unifiedProfileService.loadUnifiedProfiles();
        this.accounts = getAccountsByType('azure-devops');
      }

      // Store git credentials in keyring for push/pull operations. Non-fatal:
      // a keyring failure must not undo an otherwise-successful sign-in.
      // The stored access token (~1h) is refreshed on-demand by getFreshAccountToken
      // (using the refresh token persisted above via storeAccountOAuthToken), so
      // in-app git push/pull keep working past expiry.
      // storeGitCredentials resolves to a CommandResult (it never throws), so
      // check .success rather than relying on a catch.
      const cred1 = await gitService.storeGitCredentials('https://dev.azure.com', 'pat', accessToken);
      const cred2 = await gitService.storeGitCredentials(`https://${organization}.visualstudio.com`, 'pat', accessToken);
      if (cred1.success && cred2.success) {
        // Record the synced (org, token) so checkConnection doesn't re-write it.
        this.lastSyncedGitCredKey = `${organization}::${accessToken}`;
      } else {
        log.warn('Failed to store Azure DevOps git credentials for push/pull:', cred1.error ?? cred2.error);
        showToast('Signed in, but saving git credentials failed — push/pull may prompt for credentials', 'error');
      }

      this.connectionStatus = result.data;
      this.syncSharedConnectionStatus(true);
      showToast('Connected to Azure DevOps via Microsoft Entra ID', 'success');

      // Populate the PR / work-item / pipeline tabs immediately (mirror the PAT
      // path) so they aren't empty until the user clicks each tab.
      if (this.connectionStatus?.connected && this.detectedRepo) {
        await this.loadAllData(accessToken);
      }
    } else {
      this.error = 'Connection verification failed';
      showToast('OAuth token received but connection verification failed', 'error');
    }
  }

  /**
   * Cancel a pending Entra ID sign-in.
   *
   * Bumping the generation makes any in-flight `oauth-complete` callback be
   * ignored (see handleOAuthComplete), and cancelOAuth tears down the loopback
   * server / pending flow in the OAuth service.
   */
  private handleCancelEntraOAuth(): void {
    this.abandonPendingEntraFlow();
  }

  /**
   * Abandon any in-flight Entra sign-in: bump the generation so async
   * continuations (oauth-complete/finalize) bail, cancel the loopback flow, and
   * clear all transient sign-in UI state. Safe to call when no flow is active.
   * MUST be called before anything that changes the target account
   * (selectedAccountId) mid-flow, or a completing flow would write to the wrong
   * account.
   */
  private abandonPendingEntraFlow(): void {
    const wasPending = this.oauthPending;
    this.entraGeneration++;
    this.oauthPending = false;
    // Bumping the generation makes resolveOrgAndFinalize's finally skip its own
    // reset, so clear isLoading here too — otherwise cancelling during
    // "Connecting..." would leave the sign-in button disabled forever.
    this.isLoading = false;
    this.needsOrgSelection = false;
    this.pendingTokens = null;
    this.availableOrgs = [];
    if (wasPending) {
      oauthService.cancelOAuth('azure');
    }
  }

  /**
   * Switch between the "Sign in with Microsoft" and PAT tabs. Abandons any
   * in-flight Entra sign-in so it can't complete underneath the other view, and
   * when entering the OAuth tab without a selected account or detected repo,
   * drops any org left over from the PAT form so OAuth sign-in goes through
   * org detection/listing instead of silently reusing a stray value.
   */
  private setAuthMethod(method: 'oauth' | 'pat'): void {
    if (this.oauthPending || this.needsOrgSelection) {
      this.abandonPendingEntraFlow();
    }
    if (method === 'oauth' && !this.selectedAccountId && !this.detectedRepo) {
      // The OAuth path resolves the org from the repo/picker, not a typed value.
      // Stash (don't destroy) any org typed on the PAT form so it survives a
      // round-trip back to the PAT tab.
      this.savedPatOrg = this.organizationInput;
      this.organizationInput = '';
    } else if (method === 'pat' && !this.organizationInput && this.savedPatOrg) {
      this.organizationInput = this.savedPatOrg;
      this.savedPatOrg = '';
    }
    this.authMethod = method;
  }

  private async handleConnectWithStoredToken(): Promise<void> {
    if (!this.organizationInput.trim()) return;

    this.isLoading = true;
    this.error = null;

    try {
      // If user entered a new token, save it first
      if (this.tokenInput.trim()) {
        await this.handleSaveToken();
        return;
      }

      // Otherwise use the stored token
      const token = await this.getSelectedAccountToken();
      if (!token) {
        this.error = 'No stored token found';
        return;
      }

      const organization = this.organizationInput.trim();

      // Verify the stored token works
      const verifyResult = await gitService.checkAdoConnectionWithToken(organization, token);
      if (!verifyResult.success || !verifyResult.data?.connected) {
        this.error = verifyResult.error?.message ?? 'Connection failed - token may have expired';
        return;
      }

      this.connectionStatus = verifyResult.data;
      this.syncSharedConnectionStatus(true);

      // Update cached user if we got user info
      if (this.selectedAccountId && verifyResult.data.user) {
        await unifiedProfileService.updateGlobalAccountCachedUser(this.selectedAccountId, {
          username: verifyResult.data.user.displayName,
          displayName: verifyResult.data.user.displayName,
          email: null,
          avatarUrl: verifyResult.data.user.imageUrl ?? null,
        });
      }

      // Sync git credentials so git push/pull outside this dialog authenticate.
      // storeGitCredentials resolves to a CommandResult (it never throws), so a
      // failed keyring write must be surfaced rather than silently reporting Connected.
      // Non-fatal: the connection itself succeeded.
      if (!(await this.syncGitCredentials(organization, token))) {
        showToast(GIT_CRED_WRITE_FAILED_TOAST, 'error');
      }

      // Load data if connected and repo detected
      if (this.connectionStatus?.connected && this.detectedRepo) {
        await this.loadAllData(token);
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to connect';
    } finally {
      this.isLoading = false;
    }
  }

  private async handleSaveToken(): Promise<void> {
    if (!this.tokenInput.trim() || !this.organizationInput.trim()) return;

    this.isLoading = true;
    this.error = null;
    const tokenToSave = this.tokenInput.trim();
    const organization = this.organizationInput.trim();

    try {
      log.debug('handleSaveToken: verifying token for org:', organization, 'token length:', tokenToSave.length);
      // First verify the token works by checking connection
      // Add timeout because Tauri IPC can hang on Windows
      let verifyResult;
      try {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Connection timed out - please try again')), 15000)
        );
        verifyResult = await Promise.race([
          gitService.checkAdoConnectionWithToken(organization, tokenToSave),
          timeoutPromise
        ]);
      } catch (ipcError) {
        log.error('handleSaveToken: IPC error:', ipcError);
        this.error = `Connection failed: ${ipcError instanceof Error ? ipcError.message : String(ipcError)}`;
        this.isLoading = false;
        return;
      }
      log.debug('handleSaveToken: verifyResult:', verifyResult);
      if (!verifyResult.success || !verifyResult.data?.connected) {
        this.error = verifyResult.error?.message ?? 'Invalid token or connection failed';
        this.isLoading = false;
        return;
      }

      const user = verifyResult.data.user;

      // If we have a selected account, save token to that account
      if (this.selectedAccountId) {
        await credentialService.storeAccountToken('azure-devops', this.selectedAccountId, tokenToSave);
        // Refresh cachedUser so the profile manager shows the up-to-date
        // avatar/username immediately instead of waiting for background validation.
        if (user) {
          await unifiedProfileService.updateGlobalAccountCachedUser(this.selectedAccountId, {
            username: user.displayName,
            displayName: user.displayName,
            email: null, // ADO API doesn't return email in this context
            avatarUrl: user.imageUrl ?? null,
          });
        }
      } else {
        // No account selected - create a new global account
        const { createEmptyIntegrationAccount, generateId } = await import('../../types/unified-profile.types.ts');
        const newAccount: IntegrationAccount = {
          ...createEmptyIntegrationAccount('azure-devops', organization),
          id: generateId(),
          name: user?.displayName ? `Azure DevOps (${user.displayName})` : `Azure DevOps (${organization})`,
          isDefault: this.accounts.length === 0,
          cachedUser: user ? {
            username: user.displayName,
            displayName: user.displayName,
            email: null, // ADO API doesn't return email in this context
            avatarUrl: user.imageUrl ?? null,
          } : null,
        };

        const savedAccount = await unifiedProfileService.saveGlobalAccount(newAccount);
        await credentialService.storeAccountToken('azure-devops', savedAccount.id, tokenToSave);
        this.selectedAccountId = savedAccount.id;
        // The new account now exists and is selected — add flow complete.
        this.isAddingAccount = false;

        // Refresh accounts list
        await unifiedProfileService.loadUnifiedProfiles();
        this.accounts = getAccountsByType('azure-devops');
      }

      // Token saved, update state
      this.tokenInput = '';
      this.connectionStatus = verifyResult.data;
      this.syncSharedConnectionStatus(true);

      // Store git credentials in keyring for push/pull operations
      // Username must be non-empty for macOS Keychain - use 'pat' as a placeholder
      // Store for both dev.azure.com and {org}.visualstudio.com formats
      // storeGitCredentials resolves to a CommandResult (it never throws), so only
      // claim success when both writes actually landed; a failure is non-fatal to
      // the connection but must be told to the user.
      if (await this.syncGitCredentials(organization, tokenToSave)) {
        log.debug(`Stored git credentials in keyring for dev.azure.com and ${organization}.visualstudio.com`);
      } else {
        showToast(GIT_CRED_WRITE_FAILED_TOAST, 'error');
      }

      // Load data if connected and repo detected
      // Pass the token directly since storage might not be ready yet
      if (this.connectionStatus?.connected && this.detectedRepo) {
        await this.loadAllData(tokenToSave);
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to connect';
      this.tokenInput = tokenToSave;
    } finally {
      this.isLoading = false;
    }
  }

  private async handleDisconnect(): Promise<void> {
    this.isLoading = true;
    this.error = null;

    try {
      // Delete token for selected account or legacy token
      if (this.selectedAccountId) {
        await credentialService.deleteAccountToken('azure-devops', this.selectedAccountId);
      } else {
        await gitService.deleteAdoToken();
      }

      // Also delete git credentials from keyring for both URL formats
      await gitService.deleteGitCredentials('https://dev.azure.com');
      if (this.organizationInput) {
        await gitService.deleteGitCredentials(`https://${this.organizationInput}.visualstudio.com`);
      }
      // Deleted creds — force a re-sync on the next connect even if the token
      // matches, both here and in the git.service token path (external git).
      this.lastSyncedGitCredKey = null;
      gitService.resetAdoGitCredentialSyncCache();
      log.debug('Deleted git credentials from keyring');

      this.syncSharedConnectionStatus(false);
      this.connectionStatus = null;
      this.pullRequests = [];
      this.workItems = [];
      this.pipelineRuns = [];
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
      'Delete Azure DevOps Integration',
      `Delete ${accountName}? The stored token will be removed and any profile that uses this account as its default will lose that reference.`,
      'warning',
    );
    if (!confirmed) return;

    this.isLoading = true;
    this.error = null;

    // Delete the account record (source of truth) FIRST, then best-effort token
    // cleanup, matching GitHub/GitLab/OIDC. Deleting tokens first leaves a
    // zombie account on a partial failure.
    const accountId = this.selectedAccountId;
    const organization = this.organizationInput;
    try {
      // Delete the account from unified profiles
      await unifiedProfileService.deleteGlobalAccount(accountId);

      // Refresh accounts list
      await unifiedProfileService.loadUnifiedProfiles();
      this.accounts = getAccountsByType('azure-devops');

      // Reset state
      this.selectedAccountId = this.accounts.length > 0 ? this.accounts[0].id : null;
      this.connectionStatus = null;
      this.hasStoredToken = false;
      this.pullRequests = [];
      this.workItems = [];
      this.pipelineRuns = [];
      this.organizationInput = '';

      // Best-effort token/credential cleanup after the record is gone.
      try {
        await credentialService.deleteAccountToken('azure-devops', accountId);
        await gitService.deleteGitCredentials('https://dev.azure.com');
        if (organization) {
          await gitService.deleteGitCredentials(`https://${organization}.visualstudio.com`);
        }
        this.lastSyncedGitCredKey = null;
        gitService.resetAdoGitCredentialSyncCache();
      } catch (tokenErr) {
        const msg =
          tokenErr instanceof Error
            ? `Account deleted, but its stored token could not be removed: ${tokenErr.message}`
            : 'Account deleted, but its stored token could not be removed.';
        this.error = msg;
        showToast(msg, 'error');
      }

      // If there are remaining accounts, reload data for the first one
      if (this.selectedAccountId) {
        await this.loadInitialData();
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to delete integration';
      showToast(this.error, 'error');
    } finally {
      this.isLoading = false;
    }
  }

  private async handlePrFilterChange(e: Event): Promise<void> {
    this.prFilter = (e.target as HTMLSelectElement).value as 'active' | 'completed' | 'abandoned' | 'all';
    await this.loadPullRequests();
  }

  private async handleGeneratePrDescription(): Promise<void> {
    if (!this.repositoryPath || !this.createPrSource || !this.createPrTarget) return;

    this.generatingPrDescription = true;
    const result = await aiService.generatePrDescription(
      this.repositoryPath,
      this.createPrTarget,
      this.createPrSource,
      this.createPrTitle || 'Untitled PR',
    );

    if (result.success && result.data) {
      this.createPrDescription = result.data.body;
    } else {
      showToast(result.error?.message ?? 'Failed to generate description', 'error');
    }
    this.generatingPrDescription = false;
  }

  private async handleCreatePr(): Promise<void> {
    if (!this.detectedRepo || !this.createPrTitle.trim() || !this.createPrSource.trim() || !this.createPrTarget.trim()) return;

    this.isLoading = true;
    this.error = null;

    try {
      const input: CreateAdoPullRequestInput = {
        title: this.createPrTitle,
        description: this.createPrDescription || undefined,
        sourceRefName: this.createPrSource,
        targetRefName: this.createPrTarget,
        isDraft: this.createPrDraft,
      };

      const token = await this.getSelectedAccountToken();
      const result = await gitService.createAdoPullRequest(
        this.detectedRepo.organization,
        this.detectedRepo.project,
        this.detectedRepo.repository,
        input,
        token
      );

      if (result.success && result.data) {
        // Reset form and go back to list
        this.createPrTitle = '';
        this.createPrDescription = '';
        this.createPrSource = '';
        this.createPrTarget = '';
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

  private async handleCreateWorkItem(): Promise<void> {
    if (!this.detectedRepo || !this.createWorkItemTitle.trim()) return;

    this.isLoading = true;
    this.error = null;

    try {
      const input: CreateAdoWorkItemInput = {
        workItemType: this.createWorkItemType || 'Task',
        title: this.createWorkItemTitle,
        description: this.createWorkItemDescription || undefined,
        // Assign to the signed-in user so the new item appears in the
        // @Me-scoped Work Items list (otherwise it's created unassigned and
        // would be absent from the list that's reloaded right after). Only use a
        // UPN-like identity (uniqueName can fall back to a non-unique display
        // name when the profile has no email — assigning by that is ambiguous, so
        // leave the item unassigned rather than risk the wrong person).
        assignedTo: this.connectionStatus?.user?.uniqueName?.includes('@')
          ? this.connectionStatus.user.uniqueName
          : undefined,
      };

      const token = await this.getSelectedAccountToken();
      const result = await gitService.createAzureDevOpsWorkItem(
        this.detectedRepo.organization,
        this.detectedRepo.project,
        input,
        token
      );

      if (result.success && result.data) {
        const created = result.data;
        this.createWorkItemType = 'Task';
        this.createWorkItemTitle = '';
        this.createWorkItemDescription = '';
        this.activeTab = 'work-items';
        await this.loadWorkItems();
        // Ensure the just-created item is visible even in the edge case where it
        // couldn't be self-assigned (no UPN), so it isn't reloaded out of the
        // @Me-scoped list and replaced by a confusing "none assigned" empty state.
        if (!this.workItems.some((w) => w.id === created.id)) {
          this.workItems = [created, ...this.workItems];
        }
        showToast('Work item created successfully', 'success');
      } else {
        this.error = result.error?.message ?? 'Failed to create work item';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to create work item';
    } finally {
      this.isLoading = false;
    }
  }

  private handleClose(): void {
    // The element stays mounted (only `open` toggles), so disconnectedCallback
    // does NOT fire on close. Abandon any in-flight sign-in here so a background
    // poll OR a still-running finalize can't silently connect an account after
    // the user dismissed the dialog, and discard org-picker state so nothing
    // reappears stale on reopen.
    this.abandonPendingEntraFlow();
    this.dispatchEvent(new CustomEvent('close'));
  }

  private openInBrowser(url: string): void {
    openExternalUrl(url);
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

  private getInitials(name: string): string {
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .substring(0, 2)
      .toUpperCase();
  }

  private getWorkItemTypeClass(type: string): string {
    const lowerType = type.toLowerCase().replace(/\s+/g, '-');
    if (lowerType === 'bug') return 'bug';
    if (lowerType === 'task') return 'task';
    if (lowerType === 'user-story') return 'user-story';
    if (lowerType === 'feature') return 'feature';
    return '';
  }

  private renderConnectionTab() {
    if (this.connectionStatus?.connected && this.connectionStatus.user) {
      const user = this.connectionStatus.user;
      return html`
        <div class="connection-status">
          <div class="user-avatar">${this.getInitials(user.displayName)}</div>
          <div class="user-info">
            <div class="user-name">${user.displayName}</div>
            <div class="user-org">${this.connectionStatus.organization}</div>
          </div>
          <div class="connection-actions">
            <button class="btn btn-danger" @click=${this.handleDisconnect} ?disabled=${this.isLoading}>
              Disconnect
            </button>
            <button class="btn btn-danger-outline" @click=${this.handleDeleteIntegration} ?disabled=${this.isLoading}>
              Delete
            </button>
          </div>
        </div>
      `;
    }

    return html`
      <div class="token-form">
        <!-- Auth method toggle -->
        <div class="auth-method-toggle" style="display:flex;gap:0;margin-bottom:12px;border:1px solid var(--color-border);border-radius:6px;overflow:hidden">
          <button
            style="flex:1;padding:8px;border:none;cursor:pointer;font-size:13px;background:${this.authMethod === 'oauth' ? 'var(--color-accent)' : 'transparent'};color:${this.authMethod === 'oauth' ? 'white' : 'var(--color-text-secondary)'}"
            @click=${() => this.setAuthMethod('oauth')}
          >Sign in with Microsoft</button>
          <button
            style="flex:1;padding:8px;border:none;border-left:1px solid var(--color-border);cursor:pointer;font-size:13px;background:${this.authMethod === 'pat' ? 'var(--color-accent)' : 'transparent'};color:${this.authMethod === 'pat' ? 'white' : 'var(--color-text-secondary)'}"
            @click=${() => this.setAuthMethod('pat')}
          >Personal Access Token</button>
        </div>

        ${this.authMethod === 'oauth' ? html`
          <!-- Entra ID OAuth (interactive authorization-code + loopback flow) -->
          ${this.oauthPending ? html`
            <div style="display:flex;align-items:center;gap:8px;padding:12px;color:var(--color-text-secondary)">
              <div style="width:16px;height:16px;border:2px solid var(--color-border);border-top-color:var(--color-accent);border-radius:50%;animation:spin 0.8s linear infinite"></div>
              ${this.isLoading ? 'Connecting to Azure DevOps...' : 'Complete sign-in in your browser...'}
              <button class="btn" @click=${this.handleCancelEntraOAuth}>Cancel</button>
            </div>
          ` : this.needsOrgSelection ? html`
            <div class="form-group">
              <label>Select an organization</label>
              ${this.availableOrgs.map(org => html`
                <button class="btn" @click=${() => this.handleSelectOrg(org)} ?disabled=${this.isLoading}>${org.name}</button>
              `)}
              ${this.isLoading ? html`
                <div style="display:flex;align-items:center;gap:8px;padding-top:4px;color:var(--color-text-secondary)">
                  <div style="width:16px;height:16px;border:2px solid var(--color-border);border-top-color:var(--color-accent);border-radius:50%;animation:spin 0.8s linear infinite"></div>
                  Connecting...
                </div>
              ` : nothing}
              <div class="btn-row">
                <button class="btn" @click=${this.handleCancelOrgSelection} ?disabled=${this.isLoading}>Cancel</button>
              </div>
            </div>
          ` : html`
            <div class="btn-row">
              <button
                class="ms-signin-btn"
                @click=${this.handleStartEntraOAuth}
                ?disabled=${this.isLoading || this.oauthPending}
                aria-label="Sign in with Microsoft"
              >
                <svg width="21" height="21" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                  <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                  <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                  <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                </svg>
                Sign in with Microsoft
              </button>
            </div>
            <span class="help-text">
              Signs in with your Microsoft work or school account via the browser. No setup required.
            </span>
          `}
        ` : html`
          <!-- PAT Form -->
          <div class="form-group">
            <label>Organization</label>
            <input
              type="text"
              placeholder="my-organization"
              .value=${this.organizationInput}
              @input=${(e: Event) => this.organizationInput = (e.target as HTMLInputElement).value}
            />
            <span class="help-text">
              Your Azure DevOps organization name (from dev.azure.com/{organization})
            </span>
          </div>

          <div class="form-group">
            <label>Personal Access Token (org-scoped)</label>
            <input
              type="password"
              placeholder=${this.hasStoredToken ? '••••••••••••••••••••••••••••••••' : 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'}
              .value=${this.tokenInput}
              @input=${(e: Event) => this.tokenInput = (e.target as HTMLInputElement).value}
            />
            <span class="help-text">
              ${this.hasStoredToken
                ? html`Token saved securely. Enter a new token to update, or click Connect to use the saved token.`
                : html`Create an <strong>organization-scoped</strong> token at
                  <a
                    class="help-link"
                    href="https://dev.azure.com/${this.organizationInput || '{org}'}/_usersSettings/tokens"
                    @click=${handleExternalLink}
                  >Azure DevOps Settings</a>.
                  Required scopes: <strong>Code (Read & Write)</strong>, <strong>Work Items (Read)</strong>, <strong>Build (Read)</strong>, and <strong>User Profile (Read)</strong>.
                  <br><br>
                  <em>Note: Global PATs are deprecated (March 2026) and will stop working December 2026. Use organization-scoped tokens instead.</em>`
              }
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
              @click=${this.tokenInput.trim() ? this.handleSaveToken : this.handleConnectWithStoredToken}
              ?disabled=${this.isLoading || !this.organizationInput.trim() || (!this.tokenInput.trim() && !this.hasStoredToken)}
            >
              Connect
            </button>
          </div>
        `}
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
          <p>Connect to Azure DevOps to view pull requests</p>
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
          <p>No Azure DevOps repository detected</p>
        </div>
      `;
    }

    // The Azure DevOps PR page opens on its Active tab, so a bare link would send
    // someone reading the Completed or Abandoned list to a different list than the
    // one the hint promises to complete. `_a` selects that page's own tabs and
    // takes the filter values verbatim; "All" has no tab of its own, so it stays
    // on the default view.
    const prListQuery = this.prFilter === 'all' ? '' : `?_a=${this.prFilter}`;

    return html`
      <div class="filter-row">
        <select class="filter-select" @change=${this.handlePrFilterChange}>
          <option value="active" ?selected=${this.prFilter === 'active'}>Active</option>
          <option value="completed" ?selected=${this.prFilter === 'completed'}>Completed</option>
          <option value="abandoned" ?selected=${this.prFilter === 'abandoned'}>Abandoned</option>
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
          <div class="pr-item" @click=${() => this.openInBrowser(pr.url)}>
            <span class="pr-number">!${pr.pullRequestId}</span>
            <div class="pr-info">
              <div class="pr-title">${pr.title}</div>
              <div class="pr-meta">
                <span class="pr-state ${pr.isDraft ? 'draft' : pr.status}">${pr.isDraft ? 'Draft' : pr.status}</span>
                <span class="pr-branch">${pr.sourceRefName} → ${pr.targetRefName}</span>
                <span>by ${pr.createdBy.displayName}</span>
                <span>${this.formatDate(pr.creationDate)}</span>
              </div>
            </div>
          </div>
        `)}
      </div>
      ${this.pullRequests.length >= PULL_REQUESTS_PAGE_SIZE ? html`
        <p class="help-text capped-list-hint" style="text-align:center;padding-top:8px">
          Showing the first ${PULL_REQUESTS_PAGE_SIZE} pull requests; more may exist.
          <a
            class="help-link"
            href="https://dev.azure.com/${this.detectedRepo.organization}/${this.detectedRepo.project}/_git/${this.detectedRepo.repository}/pullrequests${prListQuery}"
            @click=${handleExternalLink}
          >Open in Azure DevOps</a> for the full list.
        </p>
      ` : nothing}
    `;
  }

  private renderWorkItemsTab() {
    if (!this.connectionStatus?.connected) {
      return html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"></path>
          </svg>
          <p>Connect to Azure DevOps to view work items</p>
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
          <p>No Azure DevOps repository detected</p>
        </div>
      `;
    }

    if (this.workItems.length === 0 && !this.error) {
      return html`
        <div class="filter-row">
          <button class="btn" @click=${() => this.activeTab = 'create-work-item'}>
            + New Work Item
          </button>
        </div>
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 11l3 3L22 4"></path>
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
          </svg>
          <p>No work items assigned to you</p>
        </div>
      `;
    }

    return html`
      <div class="filter-row">
        <button class="btn" @click=${() => this.activeTab = 'create-work-item'}>
          + New Work Item
        </button>
      </div>
      <div class="pr-list">
        ${this.workItems.map(item => html`
          <div class="work-item" @click=${() => this.openInBrowser(item.url)}>
            <span class="work-item-id">#${item.id}</span>
            <div class="work-item-info">
              <div class="work-item-title">${item.title}</div>
              <div class="work-item-meta">
                <span class="work-item-type ${this.getWorkItemTypeClass(item.workItemType)}">${item.workItemType}</span>
                <span class="work-item-state">${item.state}</span>
                ${item.assignedTo ? html`<span>Assigned to ${item.assignedTo.displayName}</span>` : ''}
                <span>${this.formatDate(item.createdDate)}</span>
              </div>
            </div>
          </div>
        `)}
      </div>
      ${this.workItems.length >= WORK_ITEMS_PAGE_SIZE ? html`
        <p class="help-text capped-list-hint" style="text-align:center;padding-top:8px">
          Showing your ${WORK_ITEMS_PAGE_SIZE} most recent.
          ${this.detectedRepo ? html`<a
            class="help-link"
            href="https://dev.azure.com/${this.detectedRepo.organization}/${this.detectedRepo.project}/_workitems/"
            @click=${handleExternalLink}
          >Open in Azure DevOps</a> for the full list.` : nothing}
        </p>
      ` : nothing}
    `;
  }

  private renderPipelinesTab() {
    if (!this.connectionStatus?.connected) {
      return html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"></path>
          </svg>
          <p>Connect to Azure DevOps to view pipelines</p>
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
          <p>No Azure DevOps repository detected</p>
        </div>
      `;
    }

    if (this.pipelineRuns.length === 0) {
      return html`
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>
          </svg>
          <p>No pipeline runs found</p>
        </div>
      `;
    }

    return html`
      <div class="pipeline-list">
        ${this.pipelineRuns.map(run => html`
          <div class="pipeline-item" @click=${() => this.openInBrowser(run.url)}>
            <div class="pipeline-status ${run.result ?? run.state}"></div>
            <div class="pipeline-info">
              <div class="pipeline-name">${run.name}</div>
              <div class="pipeline-meta">
                <span class="pipeline-branch">${run.sourceBranch}</span>
                <span>${this.formatDate(run.createdDate)}</span>
                ${run.result ? html`<span>${run.result}</span>` : html`<span>${run.state}</span>`}
              </div>
            </div>
          </div>
        `)}
      </div>
      ${this.pipelineRuns.length >= PIPELINE_RUNS_PAGE_SIZE ? html`
        <p class="help-text capped-list-hint" style="text-align:center;padding-top:8px">
          Showing the ${PIPELINE_RUNS_PAGE_SIZE} most recent pipeline runs; more may exist.
          <a
            class="help-link"
            href="https://dev.azure.com/${this.detectedRepo.organization}/${this.detectedRepo.project}/_build?view=runs"
            @click=${handleExternalLink}
          >Open in Azure DevOps</a> for the full list.
        </p>
      ` : nothing}
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
              ?disabled=${this.generatingPrDescription || !this.createPrSource || !this.createPrTarget}
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
          <label>Target Branch</label>
          <input
            type="text"
            placeholder="main"
            .value=${this.createPrTarget}
            @input=${(e: Event) => this.createPrTarget = (e.target as HTMLInputElement).value}
          />
        </div>
        <div class="form-group">
          <div class="checkbox-group">
            <input
              type="checkbox"
              id="pr-draft"
              .checked=${this.createPrDraft}
              @change=${(e: Event) => this.createPrDraft = (e.target as HTMLInputElement).checked}
            />
            <label for="pr-draft">Create as draft</label>
          </div>
        </div>
        <div class="btn-row">
          <button class="btn" @click=${() => this.activeTab = 'pull-requests'}>
            Cancel
          </button>
          <button
            class="btn btn-primary"
            @click=${this.handleCreatePr}
            ?disabled=${this.isLoading || !this.createPrTitle.trim() || !this.createPrSource.trim() || !this.createPrTarget.trim()}
          >
            Create Pull Request
          </button>
        </div>
      </div>
    `;
  }

  private renderCreateWorkItemTab() {
    return html`
      <div class="token-form">
        <div class="form-group">
          <label>Type</label>
          <select
            class="filter-select"
            @change=${(e: Event) => this.createWorkItemType = (e.target as HTMLSelectElement).value}
          >
            <option value="Task" ?selected=${this.createWorkItemType === 'Task'}>Task</option>
            <option value="Bug" ?selected=${this.createWorkItemType === 'Bug'}>Bug</option>
            <option value="User Story" ?selected=${this.createWorkItemType === 'User Story'}>User Story</option>
            <option value="Feature" ?selected=${this.createWorkItemType === 'Feature'}>Feature</option>
            <option value="Epic" ?selected=${this.createWorkItemType === 'Epic'}>Epic</option>
          </select>
        </div>
        <div class="form-group">
          <label>Title</label>
          <input
            type="text"
            placeholder="Work item title"
            .value=${this.createWorkItemTitle}
            @input=${(e: Event) => this.createWorkItemTitle = (e.target as HTMLInputElement).value}
          />
        </div>
        <div class="form-group">
          <label>Description</label>
          <textarea
            placeholder="Describe the work item..."
            .value=${this.createWorkItemDescription}
            @input=${(e: Event) => this.createWorkItemDescription = (e.target as HTMLTextAreaElement).value}
          ></textarea>
        </div>
        <div class="btn-row">
          <button class="btn" @click=${() => this.activeTab = 'work-items'}>
            Cancel
          </button>
          <button
            class="btn btn-primary"
            @click=${this.handleCreateWorkItem}
            ?disabled=${this.isLoading || !this.createWorkItemTitle.trim()}
          >
            Create Work Item
          </button>
        </div>
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
          <div class="repo-name">${decodeURIComponent(this.detectedRepo.organization)}/${decodeURIComponent(this.detectedRepo.project)}/${decodeURIComponent(this.detectedRepo.repository)}</div>
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
    if (baseBranch && !this.createPrTarget) {
      this.createPrTarget = baseBranch;
    }
    this.activeTab = 'create-pr';
  }

  render() {
    return html`
      <lv-modal
        .open=${this.open}
        ?backButton=${this.backButton}
        modalTitle="Azure DevOps"
        @close=${this.handleClose}
      >
        <div class="content">
          ${this.attachToProfileName
            ? html`<div class="attach-breadcrumb" data-testid="attach-breadcrumb">Adding to <strong>${this.attachToProfileName}</strong></div>`
            : nothing}
          ${this.renderDetectedRepo()}

          ${this.accounts.length > 0 || this.connectionStatus?.connected ? html`
            <lv-account-selector
              integrationType="azure-devops"
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
              @click=${() => { this.activeTab = 'pull-requests'; this.loadPullRequests(); }}
            >
              Pull Requests
            </button>
            <button
              class="tab ${this.activeTab === 'work-items' ? 'active' : ''}"
              @click=${() => { this.activeTab = 'work-items'; this.loadWorkItems(); }}
            >
              My Work Items
            </button>
            <button
              class="tab ${this.activeTab === 'pipelines' ? 'active' : ''}"
              @click=${() => { this.activeTab = 'pipelines'; this.loadPipelineRuns(); }}
            >
              Pipelines
            </button>
          </div>

          ${this.error ? html`<div class="error">${this.error}</div>` : ''}

          <div class="tab-content">
            ${this.activeTab === 'connection' ? this.renderConnectionTab() : ''}
            ${this.activeTab === 'pull-requests' ? this.renderPullRequestsTab() : ''}
            ${this.activeTab === 'work-items' ? this.renderWorkItemsTab() : ''}
            ${this.activeTab === 'pipelines' ? this.renderPipelinesTab() : ''}
            ${this.activeTab === 'create-pr' ? this.renderCreatePrTab() : ''}
            ${this.activeTab === 'create-work-item' ? this.renderCreateWorkItemTab() : ''}
          </div>
        </div>
      </lv-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-azure-devops-dialog': LvAzureDevOpsDialog;
  }
}
