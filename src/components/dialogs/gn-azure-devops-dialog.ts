/**
 * Azure DevOps Integration Dialog
 * Manage Azure DevOps connection, view PRs, work items, and pipelines
 */

import { html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { invokeCommand } from '../../services/tauri-api.ts';
import * as aiService from '../../services/ai.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { loggers, handleExternalLink } from '../../utils/index.ts';
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
import { GnProviderDialogBase, providerDialogBaseStyles, type PrReviewComment } from './gn-provider-dialog-base.ts';
import './gn-modal.ts';
import './gn-account-selector.ts';

export type { PrReviewComment };

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

@customElement('gn-azure-devops-dialog')
export class GnAzureDevOpsDialog extends GnProviderDialogBase<
  DetectedAdoRepo,
  AdoConnectionStatus,
  TabType
> {
  protected readonly providerDisplayName = 'Azure DevOps';
  protected readonly integrationType = 'azure-devops' as const;
  protected override readonly deferStoreSelectionDuringInit = true;
  static styles = [
    sharedStyles,
    providerDialogBaseStyles,
    css`
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

      .user-org {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
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
        --gn-focus-ring-color: #0067b8;
        --gn-focus-ring-offset: 1px;
      }

      .ms-signin-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
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

      .pr-card-wrapper .pr-item {
        border-radius: 0;
      }

      .pr-actions {
        display: flex;
        gap: var(--spacing-xs);
        align-items: center;
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

  @state() private pullRequests: AdoPullRequest[] = [];
  @state() private workItems: AdoWorkItem[] = [];
  @state() private pipelineRuns: AdoPipelineRun[] = [];
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

    this.setupUnifiedProfileSubscription({ skipInitialSelectionWhenOpen: true });

    if (this.open) {
      await this.loadInitialData();
    }
  }

  protected override applyStoreSelectedAccount(account: IntegrationAccount | undefined): void {
    if (!account) return;
    this.selectedAccountId = account.id;
    if (account.config.type === 'azure-devops' && account.config.organization) {
      this.organizationInput = account.config.organization;
    }
  }

  protected override resolveStorePreferredAccount(): IntegrationAccount | undefined {
    const candidate =
      getActiveProfilePreferredAccount('azure-devops') ??
      selectDefaultGlobalAccount('azure-devops') ??
      this.accounts[0];
    if (this.detectedRepo) {
      const detectedNorm = this.normalizeOrg(this.detectedRepo.organization);
      const candidateNorm =
        candidate?.config.type === 'azure-devops'
          ? this.normalizeOrg(candidate.config.organization)
          : '';
      return candidate && (!candidateNorm || candidateNorm === detectedNorm)
        ? candidate
        : this.accounts.find(
            (a) =>
              a.config.type === 'azure-devops' &&
              (!a.config.organization ||
                this.normalizeOrg(a.config.organization) === detectedNorm),
          );
    }
    return candidate;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    // Cancel any in-flight sign-in so its callback can't fire after unmount, and
    // invalidate continuations so a late finalize can't mutate a dead element.
    this.abandonPendingEntraFlow();
    if (this.oauthCompleteHandler) {
      window.removeEventListener('oauth-complete', this.oauthCompleteHandler);
    }
    this.oauthStateUnsubscribe?.();
  }

  protected override onBeforeOpen(): void {
    // Fresh open: abandon any sign-in left in-flight from a prior session
    // (the host may hide the dialog without routing through handleClose, e.g.
    // by setting its `open` prop false), so a reopen can't surface a stuck
    // "Connecting..." spinner.
    this.abandonPendingEntraFlow();
  }

  protected override onBeforeCloseOrNavigate(): void {
    this.abandonPendingEntraFlow();
  }

  protected override isAccountSetupPending(): boolean {
    return this.isAddingAccount || this.needsOrgSelection;
  }

  protected resetProviderRepoScopedState(): void {
    if (!this.isAddingAccount) {
      const selectedAccount = this.selectedAccountId
        ? this.accounts.find((a) => a.id === this.selectedAccountId)
        : undefined;
      if (selectedAccount?.config.type === 'azure-devops') {
        this.organizationInput = selectedAccount.config.organization ?? '';
      }
    }
    this.createPrTitle = '';
    this.createPrDescription = '';
    this.createPrSource = '';
    this.createPrTarget = '';
    this.createPrDraft = false;
    this.generatingPrDescription = false;
    this.createWorkItemType = 'Task';
    this.createWorkItemTitle = '';
    this.createWorkItemDescription = '';
    this.pullRequests = [];
    this.workItems = [];
    this.pipelineRuns = [];
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
      this.accounts = getAccountsByType('azure-devops');

      // Try to detect repo first to get organization
      if (this.repositoryPath) {
        await this.detectRepo(false, autoSelectAccount && !this.selectedAccountId && !this.isAddingAccount);
        if (generation !== this.loadGeneration) return;
      }

      if (this.accounts.length > 0 && autoSelectAccount && !this.selectedAccountId && !this.isAddingAccount) {
        const preferred = getActiveProfilePreferredAccount('azure-devops')
          ?? selectDefaultGlobalAccount('azure-devops');
        if (this.detectedRepo) {
          const matching = this.findMatchingAccountForOrg(
            this.detectedRepo.organization,
            preferred
          );
          this.selectedAccountId = matching?.id ?? null;
        } else {
          const chosen = preferred ?? this.accounts[0];
          this.selectedAccountId = chosen?.id ?? null;
          if (chosen?.config.type === 'azure-devops' && chosen.config.organization) {
            this.organizationInput = chosen.config.organization;
          }
        }
      }

      if (!this.isAddingAccount) {
        // Check if selected account has a stored token
        await this.checkStoredToken();
        if (generation !== this.loadGeneration) return;
        // Check connection if we have an organization
        if (this.detectedRepo?.organization || this.organizationInput) {
          await this.checkConnection();
          if (generation !== this.loadGeneration) return;

          // Load data now that we know the connection status
          if (this.isConnectedForDetectedRepo() && this.detectedRepo) {
            await this.loadAllData();
          }
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

  private async checkStoredToken(): Promise<void> {
    const accountId = this.selectedAccountId;
    if (accountId) {
      let token = await credentialService.getAccountToken('azure-devops', accountId);
      if (this.selectedAccountId !== accountId) return;

      // If not found, check legacy token and migrate it
      if (!token) {
        const legacyToken = await credentialService.AzureDevOpsCredentials.getToken();
        if (this.selectedAccountId !== accountId) return;
        if (legacyToken) {
          await credentialService.storeAccountToken('azure-devops', accountId, legacyToken);
          if (this.selectedAccountId !== accountId) return;
          token = legacyToken;
        }
      }

      this.hasStoredToken = !!token;
    } else {
      this.hasStoredToken = false;
    }
  }

  private normalizeOrg(org?: string | null): string {
    return (org ?? '').trim().toLowerCase();
  }

  private findMatchingAccountForOrg(
    org?: string | null,
    preferred?: IntegrationAccount | null
  ): IntegrationAccount | undefined {
    const detectedNorm = this.normalizeOrg(org);
    if (!detectedNorm) return preferred ?? this.accounts[0];
    const preferredNorm =
      preferred?.config.type === 'azure-devops'
        ? this.normalizeOrg(preferred.config.organization)
        : '';
    if (preferred && preferredNorm && preferredNorm === detectedNorm) {
      return preferred;
    }
    const exactMatch = this.accounts.find(
      (a) =>
        a.config.type === 'azure-devops' &&
        Boolean(this.normalizeOrg(a.config.organization)) &&
        this.normalizeOrg(a.config.organization) === detectedNorm
    );
    if (exactMatch) return exactMatch;
    if (preferred && !preferredNorm) return preferred;
    return this.accounts.find(
      (a) =>
        a.config.type === 'azure-devops' &&
        !this.normalizeOrg(a.config.organization)
    );
  }

  private isConnectedForDetectedRepo(): boolean {
    if (!this.connectionStatus?.connected) return false;
    if (!this.detectedRepo || !this.connectionStatus.organization) return true;
    return (
      this.normalizeOrg(this.connectionStatus.organization) ===
      this.normalizeOrg(this.detectedRepo.organization)
    );
  }

  private async checkConnection(expectedRepoGen?: number): Promise<void> {
    const accountId = this.selectedAccountId;
    const account = accountId
      ? this.accounts.find((a) => a.id === accountId)
      : undefined;
    const accountOrg =
      account?.config.type === 'azure-devops' ? account.config.organization : undefined;
    const org = accountOrg || this.detectedRepo?.organization || this.organizationInput;
    if (!org) return;

    const generation = this.loadGeneration;
    const matchesAccountOrg =
      !accountOrg || this.normalizeOrg(accountOrg) === this.normalizeOrg(org);
    const isCurrent = () =>
      generation === this.loadGeneration &&
      (expectedRepoGen === undefined || this.repoGeneration === expectedRepoGen) &&
      this.selectedAccountId === accountId &&
      this.normalizeOrg(accountOrg || this.detectedRepo?.organization || this.organizationInput) ===
        this.normalizeOrg(org);
    // Get token for selected account (refresh-aware for OAuth accounts).
    // When checking a detected repository whose organization differs from the
    // selected account's configured organization, do not send that account's
    // token to the foreign organization.
    const token = matchesAccountOrg
      ? await this.getSelectedAccountToken(org)
      : null;
    if (!isCurrent()) return;
    const result = await gitService.checkAdoConnectionWithToken(org, token);
    if (!isCurrent()) return;
    if (result.success && result.data) {
      this.connectionStatus = {
        ...result.data,
        organization: result.data.organization || org,
      };
      if (matchesAccountOrg) {
        this.syncSharedConnectionStatus(result.data.connected);
      }
      // Update cached user in global account if connected
      if (this.selectedAccountId && matchesAccountOrg && result.data.connected && result.data.user) {
        await unifiedProfileService.updateGlobalAccountCachedUser(this.selectedAccountId, {
          username: result.data.user.displayName,
          displayName: result.data.user.displayName,
          email: null, // ADO API doesn't return email in this context
          avatarUrl: result.data.user.imageUrl ?? null,
        });
      }

      // Sync the keyring git credentials only with a VERIFIED-connected token, so
      // external git push/pull get a valid credential (never a stale fallback).
      if (isCurrent() && matchesAccountOrg && result.data.connected && token) {
        await this.syncGitCredentials(org, token);
      }
    } else if (!result.success) {
      log.error('checkConnection failed:', result.error?.message);
      // Failed check must mark the account as disconnected so dependent UI
      // surfaces (toolbar, selector dot) don't keep a stale connected state.
      this.connectionStatus = { connected: false, user: null, organization: org };
      if (matchesAccountOrg) {
        this.syncSharedConnectionStatus(false);
      }
    }
  }

  /**
   * Get the token for the currently selected account, refreshing an expiring
   * Entra OAuth token first (and re-syncing the keyring git credentials so
   * push/pull stay valid). Non-OAuth (PAT) accounts return their stored token.
   */
  private async getSelectedAccountToken(
    targetOrg = this.detectedRepo?.organization,
    targetAccountId: string | null = this.selectedAccountId,
  ): Promise<string | null> {
    const accountId = targetAccountId;
    if (!accountId) return null;

    const account = this.accounts.find((a) => a.id === accountId);
    if (
      targetOrg &&
      account?.config.type === 'azure-devops' &&
      account.config.organization &&
      this.normalizeOrg(account.config.organization) !==
        this.normalizeOrg(targetOrg)
    ) {
      return null;
    }

    // Refresh-aware: for an OAuth account this returns a freshly-refreshed access
    // token when the stored one is near expiry; for a PAT it returns it unchanged.
    let token = await credentialService.getFreshAccountToken(
      'azure-devops',
      accountId,
      'azure',
    );
    if (this.selectedAccountId !== accountId) return null;

    // If not found, check legacy token and migrate it
    if (!token) {
      const legacyToken = await credentialService.AzureDevOpsCredentials.getToken();
      if (this.selectedAccountId !== accountId) return null;
      if (legacyToken) {
        try {
          await credentialService.storeAccountToken('azure-devops', accountId, legacyToken);
        } catch { /* migration failed, still use the token */ }
        if (this.selectedAccountId !== accountId) return null;
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
    this.beginAccountSwitch(account.id);
    this.tokenInput = ''; // Clear any manually entered token
    this.pullRequests = [];
    this.workItems = [];
    this.pipelineRuns = [];

    // Update organization from account config
    if (account.config.type === 'azure-devops' && account.config.organization) {
      this.organizationInput = account.config.organization;
    }

    // Check if this account has a stored token. A keyring that cannot be read
    // throws (it is not "no token"): say so here rather than leave the panel
    // blank with the previous account's state, which is what an unhandled
    // rejection out of this click handler did.
    try {
      await this.checkStoredToken();
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to read the stored token';
      return;
    }

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
    this.beginAddAccount();
    this.tokenInput = '';
    this.organizationInput = '';
  }

  protected async detectRepo(loadData = true, updateOrgInput = true): Promise<void> {
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
      const result = await gitService.detectAdoRepo(requestedPath);
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
        if (!this.isAddingAccount && (loadData || updateOrgInput)) {
          this.organizationInput = result.data.organization;
        }
        if (loadData && !this.isAddingAccount) {
          const detectedNorm = this.normalizeOrg(result.data.organization);
          let accountChanged = false;
          if (this.accounts.length > 0) {
            const currentAccount = this.selectedAccountId
              ? this.accounts.find((a) => a.id === this.selectedAccountId)
              : undefined;
            const matchingAccount = this.findMatchingAccountForOrg(
              result.data.organization,
              currentAccount
            );
            const nextAccountId = matchingAccount?.id ?? null;
            if (this.selectedAccountId !== nextAccountId) {
              this.selectedAccountId = nextAccountId;
              this.connectionStatus = null;
              accountChanged = true;
            }
          }
          if (accountChanged) {
            await this.checkStoredToken();
            if (
              this.repositoryPath !== requestedPath ||
              this.repoGeneration !== repoGen ||
              this.detectGeneration !== detectGen
            ) {
              return;
            }
          }
          const statusNorm = this.normalizeOrg(this.connectionStatus?.organization);
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
          // Auto-load data if connected
          if (this.isConnectedForDetectedRepo()) {
            await this.loadAllData();
          }
        }
      } else {
        this.detectedRepo = null;
        if (!result.success) {
          // A genuine backend failure (not merely "this isn't an Azure DevOps repo",
          // which surfaces as success with null data) must not fail silently.
          this.error = result.error?.message ?? 'Failed to detect Azure DevOps repository';
        } else if (loadData && !this.isAddingAccount && this.accounts.length > 0) {
          if (!this.selectedAccountId) {
            const preferred =
              getActiveProfilePreferredAccount('azure-devops') ??
              selectDefaultGlobalAccount('azure-devops') ??
              this.accounts[0];
            this.selectedAccountId = preferred?.id ?? null;
            if (preferred?.config.type === 'azure-devops' && preferred.config.organization) {
              this.organizationInput = preferred.config.organization;
            }
            this.connectionStatus = null;
            await this.checkStoredToken();
            if (
              this.repositoryPath !== requestedPath ||
              this.repoGeneration !== repoGen ||
              this.detectGeneration !== detectGen
            ) {
              return;
            }
          }
          const currentAccount = this.selectedAccountId
            ? this.accounts.find((a) => a.id === this.selectedAccountId)
            : undefined;
          const accountOrg =
            currentAccount?.config.type === 'azure-devops'
              ? currentAccount.config.organization
              : undefined;
          if (
            this.organizationInput &&
            (!this.connectionStatus ||
              (accountOrg &&
                this.normalizeOrg(this.connectionStatus.organization) !==
                  this.normalizeOrg(accountOrg)))
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

  private async loadAllData(providedToken?: string): Promise<void> {
    await Promise.all([
      this.loadPullRequests(providedToken),
      this.loadWorkItems(providedToken),
      this.loadPipelineRuns(providedToken),
    ]);
  }

  private async loadPullRequests(providedToken?: string): Promise<void> {
    if (!this.detectedRepo || !this.isConnectedForDetectedRepo()) return;

    const targetRepoPath = this.repositoryPath;
    const targetDetectedRepo = this.detectedRepo;
    const targetAccountId = this.selectedAccountId;
    this.isLoading = true;
    this.error = null;

    try {
      const token = providedToken ?? await this.getSelectedAccountToken();
      const result = await gitService.listAdoPullRequests(
        targetDetectedRepo.organization,
        targetDetectedRepo.project,
        targetDetectedRepo.repository,
        // Always send the filter: Azure DevOps defaults `searchCriteria.status`
        // to `active`, so omitting it for "All" would return the Active list
        // again and silently drop completed and abandoned pull requests. `all`
        // is a valid PullRequestStatus, so it goes over the wire like the rest.
        this.prFilter,
        PULL_REQUESTS_PAGE_SIZE,
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

  protected override isConnectedForComments(): boolean {
    return this.isConnectedForDetectedRepo();
  }

  protected getCommentsOutboundHost(): string {
    return 'dev.azure.com';
  }

  protected async getTokenForComments(
    targetAccountId: string | null,
  ): Promise<string | null | undefined> {
    return this.getSelectedAccountToken(
      this.detectedRepo?.organization,
      targetAccountId,
    );
  }

  protected fetchPrComments(
    repo: DetectedAdoRepo,
    prId: number,
    token: string | null | undefined,
  ) {
    return invokeCommand<PrReviewComment[]>('get_ado_pr_comments', {
      organization: repo.organization,
      project: repo.project,
      repository: repo.repository,
      pullRequestId: prId,
      token,
    });
  }

  protected postPrComment(
    repo: DetectedAdoRepo,
    prId: number,
    content: string,
    filePath: string | undefined,
    line: number | undefined,
    _commitId: string | undefined,
    token: string | null | undefined,
  ) {
    return invokeCommand<PrReviewComment>('add_ado_pr_comment', {
      organization: repo.organization,
      project: repo.project,
      repository: repo.repository,
      pullRequestId: prId,
      content,
      filePath,
      line,
      token,
    });
  }

  private async loadWorkItems(providedToken?: string): Promise<void> {
    if (!this.detectedRepo || !this.isConnectedForDetectedRepo()) return;

    const targetRepoPath = this.repositoryPath;
    const targetDetectedRepo = this.detectedRepo;
    const targetAccountId = this.selectedAccountId;
    // Clear any stale error (e.g. from another tab) so a successful load starts
    // clean — matches loadPullRequests.
    this.error = null;

    try {
      const token = providedToken ?? await this.getSelectedAccountToken();
      const result = await gitService.queryAdoWorkItems(
        targetDetectedRepo.organization,
        targetDetectedRepo.project,
        this.workItemFilter || undefined,
        WORK_ITEMS_PAGE_SIZE,
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
        this.workItems = result.data;
      } else if (!result.success) {
        this.error = result.error?.message ?? 'Failed to load work items';
      }
    } catch (err) {
      if (
        this.repositoryPath !== targetRepoPath ||
        this.detectedRepo !== targetDetectedRepo ||
        this.selectedAccountId !== targetAccountId
      ) {
        return;
      }
      this.error = err instanceof Error ? err.message : 'Failed to load work items';
    }
  }

  private async loadPipelineRuns(providedToken?: string): Promise<void> {
    if (!this.detectedRepo || !this.isConnectedForDetectedRepo()) return;

    const targetRepoPath = this.repositoryPath;
    const targetDetectedRepo = this.detectedRepo;
    const targetAccountId = this.selectedAccountId;
    // Clear any stale error (e.g. from another tab) so a successful load starts
    // clean — matches loadPullRequests / loadWorkItems.
    this.error = null;

    try {
      const token = providedToken ?? await this.getSelectedAccountToken();
      const result = await gitService.listAdoPipelineRuns(
        targetDetectedRepo.organization,
        targetDetectedRepo.project,
        targetDetectedRepo.repository,
        PIPELINE_RUNS_PAGE_SIZE,
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
        this.pipelineRuns = result.data;
      } else if (!result.success) {
        this.error = result.error?.message ?? 'Failed to load pipeline runs';
      }
    } catch (err) {
      if (
        this.repositoryPath !== targetRepoPath ||
        this.detectedRepo !== targetDetectedRepo ||
        this.selectedAccountId !== targetAccountId
      ) {
        return;
      }
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
    this.beginAccountOp();
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
      this.finishAccountOp();
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
    this.beginAccountOp();
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
      this.finishAccountOp();
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
    const targetAccountId = this.selectedAccountId;
    const targetWasAddingAccount = this.isAddingAccount;
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

      const selectedAccount = targetAccountId
        ? this.accounts.find((a) => a.id === targetAccountId)
        : undefined;
      const selectedAccountOrg =
        selectedAccount?.config.type === 'azure-devops'
          ? selectedAccount.config.organization
          : undefined;
      const canUpdateSelectedAccount =
        Boolean(targetAccountId) &&
        !targetWasAddingAccount &&
        (!selectedAccountOrg ||
          this.normalizeOrg(selectedAccountOrg) === this.normalizeOrg(organization));

      let connectedAccountId: string;

      if (targetAccountId && canUpdateSelectedAccount) {
        // Rotating credentials on an existing account. Store the full OAuth
        // bundle (access + refresh + expiry) so the token can be refreshed —
        // Entra access tokens are short-lived (~1h).
        await credentialService.storeAccountOAuthToken(
          'azure-devops',
          targetAccountId,
          accessToken,
          tokens.refreshToken,
          tokens.expiresIn,
        );
        if (generation !== this.entraGeneration) return;
        if (cachedUser) {
          await unifiedProfileService.updateGlobalAccountCachedUser(
            targetAccountId,
            cachedUser,
          );
          if (generation !== this.entraGeneration) return;
        }
        connectedAccountId = targetAccountId;
      } else {
        // No account selected - create and persist a new global account
        // (mirror the PAT path) BEFORE storing the token so the keyring
        // entry is never orphaned.
        const { createEmptyIntegrationAccount, generateId } = await import(
          '../../types/unified-profile.types.ts'
        );
        if (generation !== this.entraGeneration) return;
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
        connectedAccountId = savedAccount.id;
        if (
          generation === this.entraGeneration &&
          this.selectedAccountId === targetAccountId &&
          this.isAddingAccount === targetWasAddingAccount
        ) {
          this.selectedAccountId = savedAccount.id;
          // The new account now exists and is selected — add flow complete.
          this.isAddingAccount = false;
        }

        // Refresh accounts list
        await unifiedProfileService.loadUnifiedProfiles();
        this.accounts = getAccountsByType('azure-devops');
        if (generation !== this.entraGeneration) return;
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
        if (generation === this.entraGeneration) {
          showToast('Signed in, but saving git credentials failed — push/pull may prompt for credentials', 'error');
        }
      }
      if (generation !== this.entraGeneration) return;

      unifiedProfileStore
        .getState()
        .setAccountConnectionStatus(connectedAccountId, 'connected');
      if (this.selectedAccountId !== connectedAccountId) return;
      this.connectionStatus = result.data;
      showToast('Connected to Azure DevOps via Microsoft Entra ID', 'success');

      if (this.open && this.repositoryPath && !this.detectedRepo) {
        await this.detectRepo(false, false);
        if (generation !== this.entraGeneration || this.selectedAccountId !== connectedAccountId) return;
      }

      // Populate the PR / work-item / pipeline tabs immediately (mirror the PAT
      // path) so they aren't empty until the user clicks each tab.
      if (
        this.connectionStatus?.connected &&
        this.detectedRepo &&
        this.normalizeOrg(this.detectedRepo.organization) === this.normalizeOrg(organization)
      ) {
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

    // If user entered a new token, save it first
    if (this.tokenInput.trim()) {
      await this.handleSaveToken();
      return;
    }

    const generation = this.beginAccountOp();
    const targetAccountId = this.selectedAccountId;

    try {
      const organization = this.organizationInput.trim();
      const selectedAccount = targetAccountId
        ? this.accounts.find((a) => a.id === targetAccountId)
        : undefined;
      const selectedAccountOrg =
        selectedAccount?.config.type === 'azure-devops'
          ? selectedAccount.config.organization
          : undefined;
      if (
        selectedAccountOrg &&
        this.normalizeOrg(selectedAccountOrg) !== this.normalizeOrg(organization)
      ) {
        this.error = `Selected account is configured for organization "${selectedAccountOrg}". Enter a token for "${organization}" or add a new account.`;
        return;
      }

      // Otherwise use the stored token
      const token = await this.getSelectedAccountToken(organization);
      if (generation !== this.loadGeneration) return;
      if (!token) {
        this.error = 'No stored token found';
        return;
      }

      // Verify the stored token works
      const verifyResult = await gitService.checkAdoConnectionWithToken(organization, token);
      if (generation !== this.loadGeneration) return;
      if (!verifyResult.success || !verifyResult.data?.connected) {
        this.error = verifyResult.error?.message ?? 'Connection failed - token may have expired';
        return;
      }

      this.connectionStatus = verifyResult.data;
      this.syncSharedConnectionStatus(true);

      // Update cached user if we got user info
      if (targetAccountId && verifyResult.data.user) {
        await unifiedProfileService.updateGlobalAccountCachedUser(targetAccountId, {
          username: verifyResult.data.user.displayName,
          displayName: verifyResult.data.user.displayName,
          email: null,
          avatarUrl: verifyResult.data.user.imageUrl ?? null,
        });
        if (generation !== this.loadGeneration) return;
      }

      // Sync git credentials so git push/pull outside this dialog authenticate.
      // storeGitCredentials resolves to a CommandResult (it never throws), so a
      // failed keyring write must be surfaced rather than silently reporting Connected.
      // Non-fatal: the connection itself succeeded.
      if (!(await this.syncGitCredentials(organization, token))) {
        showToast(GIT_CRED_WRITE_FAILED_TOAST, 'error');
      }
      if (generation !== this.loadGeneration) return;

      if (this.repositoryPath && !this.detectedRepo) {
        await this.detectRepo(false, false);
        if (generation !== this.loadGeneration) return;
      }

      // Load data if connected and repo detected for this organization
      if (
        this.connectionStatus?.connected &&
        this.detectedRepo &&
        this.normalizeOrg(this.detectedRepo.organization) === this.normalizeOrg(organization)
      ) {
        await this.loadAllData(token);
      }
    } catch (err) {
      if (generation !== this.loadGeneration) return;
      this.error = err instanceof Error ? err.message : 'Failed to connect';
    } finally {
      this.finishAccountOp(generation);
    }
  }

  private async handleSaveToken(): Promise<void> {
    if (!this.tokenInput.trim() || !this.organizationInput.trim()) return;

    const generation = this.beginAccountOp();
    const tokenToSave = this.tokenInput.trim();
    const organization = this.organizationInput.trim();
    const targetAccountId = this.selectedAccountId;
    const targetWasAddingAccount = this.isAddingAccount;

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
        if (generation !== this.loadGeneration) return;
        log.error('handleSaveToken: IPC error:', ipcError);
        this.error = `Connection failed: ${ipcError instanceof Error ? ipcError.message : String(ipcError)}`;
        return;
      }
      log.debug('handleSaveToken: verifyResult:', verifyResult);
      if (!verifyResult.success || !verifyResult.data?.connected) {
        if (generation === this.loadGeneration) {
          this.error = verifyResult.error?.message ?? 'Invalid token or connection failed';
        }
        return;
      }

      const user = verifyResult.data.user;
      const selectedAccount = targetAccountId
        ? this.accounts.find((a) => a.id === targetAccountId)
        : undefined;
      const selectedAccountOrg =
        selectedAccount?.config.type === 'azure-devops'
          ? selectedAccount.config.organization
          : undefined;
      const canUpdateSelectedAccount =
        Boolean(targetAccountId) &&
        !targetWasAddingAccount &&
        (!selectedAccountOrg ||
          this.normalizeOrg(selectedAccountOrg) === this.normalizeOrg(organization));

      let connectedAccountId: string;

      // If we have a selected account for this same organization, save token to that account
      if (targetAccountId && canUpdateSelectedAccount) {
        await credentialService.storeAccountToken('azure-devops', targetAccountId, tokenToSave);
        // Refresh cachedUser so the profile manager shows the up-to-date
        // avatar/username immediately instead of waiting for background validation.
        if (user) {
          await unifiedProfileService.updateGlobalAccountCachedUser(targetAccountId, {
            username: user.displayName,
            displayName: user.displayName,
            email: null, // ADO API doesn't return email in this context
            avatarUrl: user.imageUrl ?? null,
          });
        }
        connectedAccountId = targetAccountId;
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
        connectedAccountId = savedAccount.id;
        if (
          this.selectedAccountId === targetAccountId &&
          this.isAddingAccount === targetWasAddingAccount
        ) {
          this.selectedAccountId = savedAccount.id;
          // The new account now exists and is selected — add flow complete.
          this.isAddingAccount = false;
        }

        // Refresh accounts list
        await unifiedProfileService.loadUnifiedProfiles();
        this.accounts = getAccountsByType('azure-devops');
      }

      unifiedProfileStore
        .getState()
        .setAccountConnectionStatus(connectedAccountId, 'connected');
      if (this.tokenInput.trim() === tokenToSave) {
        this.tokenInput = '';
      }

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
      if (generation !== this.loadGeneration || this.selectedAccountId !== connectedAccountId) return;

      // Token saved, update state
      this.hasStoredToken = true;
      this.connectionStatus = verifyResult.data;

      if (this.repositoryPath && !this.detectedRepo) {
        await this.detectRepo(false, false);
        if (generation !== this.loadGeneration || this.selectedAccountId !== connectedAccountId) return;
      }

      // Load data if connected and repo detected for this organization
      // Pass the token directly since storage might not be ready yet
      if (
        this.connectionStatus?.connected &&
        this.detectedRepo &&
        this.normalizeOrg(this.detectedRepo.organization) === this.normalizeOrg(organization)
      ) {
        await this.loadAllData(tokenToSave);
      }
    } catch (err) {
      if (generation !== this.loadGeneration) return;
      this.error = err instanceof Error ? err.message : 'Failed to connect';
      if (!this.tokenInput) {
        this.tokenInput = tokenToSave;
      }
    } finally {
      this.finishAccountOp(generation);
    }
  }

  private async handleDisconnect(): Promise<void> {
    const targetAccountId = this.selectedAccountId;
    const selectedAccount = targetAccountId
      ? this.accounts.find((a) => a.id === targetAccountId)
      : undefined;
    const orgToDelete =
      (selectedAccount?.config.type === 'azure-devops'
        ? selectedAccount.config.organization
        : '') || this.organizationInput.trim();
    const hasOtherAccounts =
      Boolean(targetAccountId) &&
      this.accounts.some((a) => a.id !== targetAccountId);

    await this.runDisconnectOperation(
      async () => {
        if (targetAccountId) {
          await credentialService.deleteAccountToken('azure-devops', targetAccountId);
        } else {
          await gitService.deleteAdoToken();
        }

        // Delete shared dev.azure.com git credential only when no other ADO account remains
        if (!hasOtherAccounts) {
          await gitService.deleteGitCredentials('https://dev.azure.com');
        }
        if (orgToDelete) {
          await gitService.deleteGitCredentials(`https://${orgToDelete}.visualstudio.com`);
        }
        this.lastSyncedGitCredKey = null;
        gitService.resetAdoGitCredentialSyncCache();
        log.debug('Deleted git credentials from keyring');
      },
      () => {
        this.connectionStatus = {
          connected: false,
          user: null,
          organization: orgToDelete || null,
        };
        this.hasStoredToken = false;
        this.pullRequests = [];
        this.workItems = [];
        this.pipelineRuns = [];
      },
    );
  }

  private async handleDeleteIntegration(): Promise<void> {
    const accountId = this.selectedAccountId;
    const selected = accountId
      ? this.accounts.find((a) => a.id === accountId)
      : undefined;
    const account = accountId
      ? (selected ?? ({ id: accountId, name: 'this account' } as IntegrationAccount))
      : undefined;
    const organization =
      (selected?.config.type === 'azure-devops' ? selected.config.organization : '') ||
      this.organizationInput.trim();

    await this.runDeleteIntegrationOperation({
      account,
      providerLabel: 'Azure DevOps',
      deleteCredentials: async (target) => {
        const remainingAccounts = getAccountsByType('azure-devops');
        await credentialService.deleteAccountToken('azure-devops', target.id);
        if (remainingAccounts.length === 0) {
          await gitService.deleteGitCredentials('https://dev.azure.com');
        }
        if (organization) {
          await gitService.deleteGitCredentials(`https://${organization}.visualstudio.com`);
        }
        this.lastSyncedGitCredKey = null;
        gitService.resetAdoGitCredentialSyncCache();
      },
      getRemainingAccounts: () => getAccountsByType('azure-devops'),
      onDeleted: async (nextAccountId) => {
        const nextAccount = this.accounts.length > 0 ? this.accounts[0] : null;
        this.hasStoredToken = false;
        this.pullRequests = [];
        this.workItems = [];
        this.pipelineRuns = [];
        this.organizationInput =
          (nextAccount?.config.type === 'azure-devops' && nextAccount.config.organization) ||
          this.detectedRepo?.organization ||
          '';

        if (nextAccountId) {
          await this.loadInitialData();
        }
      },
    });
  }

  private async handlePrFilterChange(e: Event): Promise<void> {
    this.prFilter = (e.target as HTMLSelectElement).value as 'active' | 'completed' | 'abandoned' | 'all';
    await this.loadPullRequests();
  }

  private async handleGeneratePrDescription(): Promise<void> {
    if (!this.repositoryPath || !this.createPrSource || !this.createPrTarget) return;

    const repoPath = this.repositoryPath;
    const repoGen = this.repoGeneration;
    this.generatingPrDescription = true;
    try {
      const result = await aiService.generatePrDescription(
        repoPath,
        this.createPrTarget,
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
    if (!this.detectedRepo || !this.createPrTitle.trim() || !this.createPrSource.trim() || !this.createPrTarget.trim()) return;

    const input: CreateAdoPullRequestInput = {
      title: this.createPrTitle,
      description: this.createPrDescription || undefined,
      sourceRefName: this.createPrSource,
      targetRefName: this.createPrTarget,
      isDraft: this.createPrDraft,
    };

    await this.runCreateOperation({
      successMessage: 'Pull request created successfully',
      failureMessage: 'Failed to create pull request',
      getToken: async (targetAccountId) => {
        const token = await this.getSelectedAccountToken(
          this.detectedRepo?.organization,
          targetAccountId,
        );
        return token ?? undefined;
      },
      execute: (repo, token) =>
        gitService.createAdoPullRequest(
          repo.organization,
          repo.project,
          repo.repository,
          input,
          token ?? null,
        ),
      onSuccess: async () => {
        this.createPrTitle = '';
        this.createPrDescription = '';
        this.createPrSource = '';
        this.createPrTarget = '';
        this.createPrDraft = false;
        this.activeTab = 'pull-requests';
        await this.loadPullRequests();
      },
    });
  }

  private async handleCreateWorkItem(): Promise<void> {
    if (!this.detectedRepo || !this.createWorkItemTitle.trim()) return;

    const targetRepoPath = this.repositoryPath;
    const repoGen = this.repoGeneration;
    const targetDetectedRepo = this.detectedRepo;
    const targetAccountId = this.selectedAccountId;
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

    await this.runCreateOperation({
      successMessage: 'Work item created successfully',
      failureMessage: 'Failed to create work item',
      getToken: async (accountId) => {
        const token = await this.getSelectedAccountToken(
          targetDetectedRepo.organization,
          accountId,
        );
        return token ?? undefined;
      },
      execute: (repo, token) =>
        gitService.createAzureDevOpsWorkItem(
          repo.organization,
          repo.project,
          input,
          token ?? null,
        ),
      onSuccess: async (created) => {
        this.createWorkItemType = 'Task';
        this.createWorkItemTitle = '';
        this.createWorkItemDescription = '';
        this.activeTab = 'work-items';
        await this.loadWorkItems();
        // Ensure the just-created item is visible even in the edge case where it
        // couldn't be self-assigned (no UPN), so it isn't reloaded out of the
        // @Me-scoped list and replaced by a confusing "none assigned" empty state.
        if (
          this.isCurrentRepoAndAccount(
            targetRepoPath,
            repoGen,
            targetDetectedRepo,
            targetAccountId,
          ) &&
          !this.workItems.some((w) => w.id === created.id)
        ) {
          this.workItems = [created, ...this.workItems];
        }
      },
    });
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
                ?disabled=${this.isLoading || this.oauthPending || this.isDetectingRepo}
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
              ?disabled=${this.isLoading || this.isDetectingRepo || !this.organizationInput.trim() || (!this.tokenInput.trim() && !this.hasStoredToken)}
            >
              Connect
            </button>
          </div>
        `}
      </div>
    `;
  }

  private renderNotConnected(feature: string) {
    const connectedOrg = this.connectionStatus?.connected
      ? this.connectionStatus.organization
      : null;
    const repoOrg = this.detectedRepo?.organization;
    const isOrgMismatch =
      Boolean(connectedOrg && repoOrg) &&
      this.normalizeOrg(connectedOrg) !== this.normalizeOrg(repoOrg);
    const decodedRepoOrg = repoOrg ? decodeURIComponent(repoOrg) : '';
    return html`
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"></path>
        </svg>
        <p>
          ${isOrgMismatch
            ? `Connected to ${connectedOrg}, not ${decodedRepoOrg}. Connect to Azure DevOps (${decodedRepoOrg}) to view ${feature}`
            : `Connect to Azure DevOps to view ${feature}`}
        </p>
      </div>
    `;
  }

  private renderPullRequestsTab() {
    if (!this.isConnectedForDetectedRepo()) {
      return this.renderNotConnected('pull requests');
    }

    if (!this.detectedRepo) {
      return this.renderNoRepo();
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
          <div class="pr-card-wrapper">
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
              <div class="pr-actions" @click=${(e: Event) => e.stopPropagation()}>
                <button
                  class="btn pr-comments-toggle"
                  data-testid="pr-comments-toggle-${pr.pullRequestId}"
                  title="Review comments"
                  @click=${() => this.togglePrComments(pr.pullRequestId)}
                >
                  Comments${this.prComments[pr.pullRequestId] ? ` (${this.prComments[pr.pullRequestId].length})` : ''}
                </button>
              </div>
            </div>
            ${this.expandedPrNumber === pr.pullRequestId ? this.renderPrCommentsDrawer(pr.pullRequestId) : nothing}
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
    if (!this.isConnectedForDetectedRepo()) {
      return this.renderNotConnected('work items');
    }

    if (!this.detectedRepo) {
      return this.renderNoRepo();
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
    if (!this.isConnectedForDetectedRepo()) {
      return this.renderNotConnected('pipelines');
    }

    if (!this.detectedRepo) {
      return this.renderNoRepo();
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
            ?disabled=${this.isLoading || !this.detectedRepo || !this.createPrTitle.trim() || !this.createPrSource.trim() || !this.createPrTarget.trim()}
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
            ?disabled=${this.isLoading || !this.detectedRepo || !this.createWorkItemTitle.trim()}
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
      <gn-modal
        .open=${this.open}
        ?backButton=${this.backButton}
        modalTitle="Azure DevOps"
        @close=${this.handleClose}
      >
        <div class="content">
          ${this.renderAttachBreadcrumb()}
          ${this.renderDetectedRepo()}

          ${this.accounts.length > 0 || this.connectionStatus?.connected ? html`
            <gn-account-selector
              integrationType="azure-devops"
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
      </gn-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-azure-devops-dialog': GnAzureDevOpsDialog;
  }
}
