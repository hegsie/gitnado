/**
 * Shared base class for Git hosting provider integration dialogs
 * (`gn-github-dialog`, `gn-gitlab-dialog`, `gn-bitbucket-dialog`, `gn-azure-devops-dialog`).
 *
 * Centralizes:
 * - Dialog open / repositoryPath lifecycle (`willUpdate`, `updated`, `disconnectedCallback`)
 * - Generation counters (`loadGeneration`, `detectGeneration`, `repoGeneration`,
 *   `commentLoadGeneration`, `commentPostGeneration`) and in-flight account operation
 *   tracking (`initInFlight`, `accountOpInFlight`, `pendingRepoReconcile`)
 * - Repository-scoped draft reset and deferred repo reconciliation when a repository
 *   switch occurs mid-account-operation
 * - Race-safe create operation runner (`runCreateOperation`) that pins repository,
 *   generation, and selected account across async token retrieval and API execution
 * - Inline PR/MR review comments drawer state, loading, posting, and rendering
 * - Common empty states (`renderNoRepo`) and formatting utilities
 */

import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import * as gitService from '../../services/git.service.ts';
import * as unifiedProfileService from '../../services/unified-profile.service.ts';
import { unifiedProfileStore } from '../../stores/unified-profile.store.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { openExternalUrl } from '../../utils/external-link.ts';
import type { CommandResult } from '../../types/api.types.ts';
import type { IntegrationAccount } from '../../types/unified-profile.types.ts';

export interface PrReviewComment {
  id: string | number;
  body: string;
  author: string;
  avatarUrl?: string | null;
  createdAt: string;
  filePath?: string | null;
  line?: number | null;
}

export interface CreateOperationConfig<TDetectedRepo, TResult> {
  successMessage: string;
  failureMessage: string;
  getToken: (targetAccountId: string | null) => Promise<string | null | undefined>;
  execute: (
    repo: TDetectedRepo,
    token: string | null | undefined,
  ) => Promise<CommandResult<TResult>>;
  onSuccess: (result: TResult) => Promise<void> | void;
}

export abstract class GnProviderDialogBase<
  TDetectedRepo,
  TConnectionStatus extends { connected?: boolean },
  TTab extends string,
> extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: String }) repositoryPath = '';

  @state() protected activeTab: TTab = 'connection' as TTab;
  @state() protected connectionStatus: TConnectionStatus | null = null;
  @state() protected detectedRepo: TDetectedRepo | null = null;
  @state() protected isLoading = false;
  @state() protected isDetectingRepo = false;
  @state() protected error: string | null = null;

  @state() protected accounts: IntegrationAccount[] = [];
  @state() protected selectedAccountId: string | null = null;

  // True after the user clicked "+ Add Account" and before the new account is saved.
  protected isAddingAccount = false;
  // True after the user explicitly picked an account via the selector in this session.
  protected hasManualAccountSelection = false;

  // Monotonic counters so superseded async operations cannot overwrite newer state.
  protected loadGeneration = 0;
  protected detectGeneration = 0;
  protected repoGeneration = 0;
  protected initInFlight = false;
  protected accountOpInFlight = 0;
  protected pendingRepoReconcile = false;

  // Inline PR/MR review comments state
  @state() protected expandedPrNumber: number | null = null;
  @state() protected prComments: Record<number, PrReviewComment[]> = {};
  @state() protected loadingCommentsForPr: number | null = null;
  @state() protected commentBodyInput = '';
  @state() protected commentFilePathInput = '';
  @state() protected commentLineInput = '';
  @state() protected postingCommentForPr: number | null = null;
  protected commentLoadGeneration = 0;
  protected commentPostGeneration = 0;

  protected unsubscribeStore?: () => void;

  /** Human-readable provider name used in common empty-state copy. */
  protected abstract readonly providerDisplayName: string;

  /** Noun used in comment error messages ('PR' or 'MR'). */
  protected readonly reviewCommentNoun: 'PR' | 'MR' = 'PR';

  /** Load initial account/connection/repo state when the dialog opens or switches account. */
  protected abstract loadInitialData(): Promise<void>;

  /** Detect the provider repository for `this.repositoryPath`. */
  protected abstract detectRepo(loadData?: boolean, selectAccount?: boolean): Promise<void>;

  /** Clear provider-specific repo-scoped drafts, lists, pagination flags, and request IDs. */
  protected abstract resetProviderRepoScopedState(): void;

  /** Retrieve the active token for the selected account. */
  protected abstract getTokenForComments(
    targetAccountId: string | null,
  ): Promise<string | null | undefined>;

  /** Outbound host to check before loading/posting review comments. */
  protected abstract getCommentsOutboundHost(repo: TDetectedRepo): string;

  /** Fetch review comments for a PR/MR. */
  protected abstract fetchPrComments(
    repo: TDetectedRepo,
    prNumber: number,
    token: string | null | undefined,
  ): Promise<CommandResult<PrReviewComment[]>>;

  /** Post a review comment on a PR/MR. */
  protected abstract postPrComment(
    repo: TDetectedRepo,
    prNumber: number,
    body: string,
    path: string | undefined,
    line: number | undefined,
    commitId: string | undefined,
    token: string | null | undefined,
  ): Promise<CommandResult<PrReviewComment>>;

  /** Whether the dialog is currently connected for the detected repository. */
  protected isConnectedForComments(): boolean {
    return Boolean(this.connectionStatus?.connected);
  }

  /** Optional hook invoked when `open` transitions to `true` before `loadInitialData()`. */
  protected onBeforeOpen(): void {
    // Subclasses can override (e.g. Bitbucket data-ready attribute, ADO Entra flow cleanup)
  }

  /** Whether interactive account setup (e.g. "+ Add Account" or org picker) is still pending. */
  protected isAccountSetupPending(): boolean {
    return this.isAddingAccount;
  }

  override async updated(changedProperties: Map<string, unknown>): Promise<void> {
    if (changedProperties.has('repositoryPath')) {
      this.resetRepoScopedDrafts();
      this.detectedRepo = null;
    }
    if (changedProperties.has('open') && this.open) {
      // Fresh open: re-derive the preferred account so a profile switch since
      // the last open is reflected. handleAccountChange() also calls
      // loadInitialData(), and we must NOT re-derive in that path or a manual
      // switch would immediately be overwritten.
      this.onBeforeOpen();
      this.isAddingAccount = false;
      this.hasManualAccountSelection = false;
      this.pendingRepoReconcile = false;
      this.selectedAccountId = null;
      await this.loadInitialData();
    } else if (changedProperties.has('repositoryPath') && this.open) {
      if (this.isAccountSetupPending() || this.accountOpInFlight > 0) {
        this.pendingRepoReconcile = true;
        if (this.repositoryPath) {
          await this.detectRepo(false, false);
        }
      } else if (
        this.initInFlight ||
        !this.connectionStatus ||
        (!this.repositoryPath && !this.selectedAccountId && !this.isAddingAccount && this.accounts.length > 0)
      ) {
        if (!this.isAddingAccount && !this.hasManualAccountSelection) {
          this.selectedAccountId = null;
        }
        await this.loadInitialData();
      } else if (this.repositoryPath) {
        await this.detectRepo();
      }
    }
  }

  /**
   * Reset inline PR/MR review comment drawer state and invalidate any
   * in-flight comment loads or posts.
   */
  protected resetCommentDrawerState(): void {
    this.commentLoadGeneration++;
    this.commentPostGeneration++;
    this.expandedPrNumber = null;
    this.prComments = {};
    this.loadingCommentsForPr = null;
    this.commentBodyInput = '';
    this.commentFilePathInput = '';
    this.commentLineInput = '';
    this.postingCommentForPr = null;
  }

  /**
   * Shared state transition when the user manually selects an account in the
   * account selector.
   */
  protected beginAccountSwitch(accountId: string): void {
    this.isAddingAccount = false;
    this.hasManualAccountSelection = true;
    this.pendingRepoReconcile = false;
    this.selectedAccountId = accountId;
    this.resetCommentDrawerState();
    this.connectionStatus = null;
    this.error = null;
  }

  /**
   * Shared state transition when the user clicks "+ Add Account".
   */
  protected beginAddAccount(): void {
    this.loadGeneration++;
    this.detectGeneration++;
    this.hasManualAccountSelection = false;
    this.pendingRepoReconcile = false;
    this.resetCommentDrawerState();
    this.initInFlight = false;
    this.isLoading = false;
    this.isDetectingRepo = false;
    this.isAddingAccount = true;
    this.activeTab = 'connection' as TTab;
    this.connectionStatus = null;
    this.selectedAccountId = null;
  }

  /**
   * Drop every create-* draft, leave any create-* tab, and reset repo-bound
   * lists when `repositoryPath` changes.
   */
  protected resetRepoScopedDrafts(): void {
    if (this.activeTab.startsWith('create-')) {
      this.activeTab = 'connection' as TTab;
    }
    this.repoGeneration++;
    this.detectGeneration++;
    this.isDetectingRepo = Boolean(this.open && this.repositoryPath);
    if (!this.initInFlight && this.accountOpInFlight === 0) {
      this.isLoading = false;
      this.error = null;
    }
    this.resetCommentDrawerState();
    this.detectedRepo = null;
    this.resetProviderRepoScopedState();
  }

  protected beginAccountOp(invalidateCurrentLoad = true): number {
    this.accountOpInFlight++;
    if (!invalidateCurrentLoad) {
      return this.loadGeneration;
    }
    const generation = ++this.loadGeneration;
    this.initInFlight = false;
    this.isLoading = true;
    this.error = null;
    return generation;
  }

  protected finishAccountOp(generation?: number): void {
    this.accountOpInFlight = Math.max(0, this.accountOpInFlight - 1);
    if (generation !== undefined && generation === this.loadGeneration) {
      this.isLoading = false;
    }
    if (
      this.accountOpInFlight === 0 &&
      !this.isAccountSetupPending() &&
      this.pendingRepoReconcile
    ) {
      this.pendingRepoReconcile = false;
      if (this.open && this.repositoryPath) {
        void this.detectRepo();
      }
    }
  }

  protected async runDisconnectOperation(
    deleteCredentials: () => Promise<void>,
    onDisconnected?: () => void,
  ): Promise<void> {
    const generation = this.beginAccountOp();
    const targetAccountId = this.selectedAccountId;

    try {
      await deleteCredentials();

      if (targetAccountId) {
        unifiedProfileStore
          .getState()
          .setAccountConnectionStatus(targetAccountId, 'disconnected');
      }
      if (generation !== this.loadGeneration || this.selectedAccountId !== targetAccountId) {
        return;
      }
      this.connectionStatus = null;
      this.resetCommentDrawerState();
      onDisconnected?.();
    } catch (err) {
      if (generation !== this.loadGeneration) return;
      this.error = err instanceof Error ? err.message : 'Failed to disconnect';
      showToast(this.error, 'error');
    } finally {
      this.finishAccountOp(generation);
    }
  }

  protected async runDeleteIntegrationOperation<
    TAccount extends { id: string; name: string },
  >(options: {
    account: TAccount | undefined;
    providerLabel: string;
    deleteCredentials: (account: TAccount) => Promise<void>;
    getRemainingAccounts: () => TAccount[];
    onDeleted: (nextAccountId: string | null) => Promise<void>;
  }): Promise<void> {
    if (!options.account) return;
    const targetAccount = options.account;

    const confirmed = await showConfirm(
      `Delete ${options.providerLabel} Integration`,
      `Delete ${targetAccount.name || 'this account'}? The stored token will be removed and any profile that uses this account as its default will lose that reference.`,
      'warning',
    );
    if (!confirmed) return;

    const generation = this.beginAccountOp();

    try {
      await unifiedProfileService.deleteGlobalAccount(targetAccount.id);
      await unifiedProfileService.loadUnifiedProfiles();

      // Account is already deleted in the backend; attempt token cleanup separately so a
      // keyring failure surfaces as a partial-cleanup warning rather than aborting UI transition.
      try {
        await options.deleteCredentials(targetAccount);
      } catch (tokenErr) {
        const detail =
          tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
        const msg = `Account deleted, but its stored token could not be removed: ${detail}`;
        if (generation === this.loadGeneration) {
          this.error = msg;
        }
        showToast(msg, 'error');
      }

      if (generation !== this.loadGeneration) return;

      const remainingAccounts = options.getRemainingAccounts();
      this.accounts = remainingAccounts as unknown as IntegrationAccount[];
      const nextAccountId = remainingAccounts[0]?.id ?? null;
      this.hasManualAccountSelection = false;
      this.selectedAccountId = nextAccountId;
      this.connectionStatus = null;
      this.resetCommentDrawerState();
      await options.onDeleted(nextAccountId);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : `Failed to delete ${options.providerLabel} integration`;
      if (generation === this.loadGeneration) {
        this.error = msg;
      }
      showToast(msg, 'error');
    } finally {
      this.finishAccountOp(generation);
    }
  }

  protected isCurrentRepoAndAccount(
    repoPath: string,
    repoGen: number,
    targetRepo: TDetectedRepo,
    targetAccountId: string | null,
  ): boolean {
    return (
      this.repositoryPath === repoPath &&
      this.repoGeneration === repoGen &&
      this.detectedRepo === targetRepo &&
      this.selectedAccountId === targetAccountId
    );
  }

  protected async runCreateOperation<TResult>(
    config: CreateOperationConfig<TDetectedRepo, TResult>,
  ): Promise<void> {
    if (!this.detectedRepo) return;

    const targetRepoPath = this.repositoryPath;
    const repoGen = this.repoGeneration;
    const targetDetectedRepo = this.detectedRepo;
    const targetAccountId = this.selectedAccountId;

    this.isLoading = true;
    this.error = null;

    try {
      const token = await config.getToken(targetAccountId);
      if (
        !this.isCurrentRepoAndAccount(
          targetRepoPath,
          repoGen,
          targetDetectedRepo,
          targetAccountId,
        )
      ) {
        return;
      }

      const result = await config.execute(targetDetectedRepo, token);

      if (result.success && result.data) {
        showToast(config.successMessage, 'success');
        if (
          this.isCurrentRepoAndAccount(
            targetRepoPath,
            repoGen,
            targetDetectedRepo,
            targetAccountId,
          )
        ) {
          await config.onSuccess(result.data);
        }
      } else {
        const msg = result.error?.message ?? config.failureMessage;
        if (
          this.isCurrentRepoAndAccount(
            targetRepoPath,
            repoGen,
            targetDetectedRepo,
            targetAccountId,
          )
        ) {
          this.error = msg;
        } else {
          showToast(msg, 'error');
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : config.failureMessage;
      if (
        this.isCurrentRepoAndAccount(
          targetRepoPath,
          repoGen,
          targetDetectedRepo,
          targetAccountId,
        )
      ) {
        this.error = msg;
      } else {
        showToast(msg, 'error');
      }
    } finally {
      if (
        this.isCurrentRepoAndAccount(
          targetRepoPath,
          repoGen,
          targetDetectedRepo,
          targetAccountId,
        )
      ) {
        this.isLoading = false;
      }
    }
  }

  protected async togglePrComments(prNumber: number): Promise<void> {
    if (this.expandedPrNumber === prNumber) {
      this.commentLoadGeneration++;
      this.loadingCommentsForPr = null;
      this.expandedPrNumber = null;
      return;
    }
    this.expandedPrNumber = prNumber;
    this.commentBodyInput = '';
    this.commentFilePathInput = '';
    this.commentLineInput = '';
    await this.loadPrComments(prNumber);
  }

  protected async loadPrComments(prNumber: number): Promise<void> {
    if (!this.detectedRepo || !this.isConnectedForComments()) return;
    const targetRepoPath = this.repositoryPath;
    const targetDetectedRepo = this.detectedRepo;
    const targetAccountId = this.selectedAccountId;
    const repoGen = this.repoGeneration;
    const loadGen = ++this.commentLoadGeneration;
    this.loadingCommentsForPr = prNumber;
    this.error = null;

    try {
      if (
        await gitService.checkOutboundHostAllowed(
          this.getCommentsOutboundHost(targetDetectedRepo),
          false,
        )
      ) {
        return;
      }
      if (
        this.repositoryPath !== targetRepoPath ||
        this.repoGeneration !== repoGen ||
        this.commentLoadGeneration !== loadGen ||
        this.selectedAccountId !== targetAccountId
      ) {
        return;
      }

      const token = await this.getTokenForComments(targetAccountId);
      if (
        this.repositoryPath !== targetRepoPath ||
        this.repoGeneration !== repoGen ||
        this.commentLoadGeneration !== loadGen ||
        this.selectedAccountId !== targetAccountId
      ) {
        return;
      }

      const result = await this.fetchPrComments(targetDetectedRepo, prNumber, token);
      if (
        this.repositoryPath !== targetRepoPath ||
        this.repoGeneration !== repoGen ||
        this.commentLoadGeneration !== loadGen ||
        this.selectedAccountId !== targetAccountId
      ) {
        return;
      }

      if (result.success && result.data) {
        this.prComments = {
          ...this.prComments,
          [prNumber]: result.data,
        };
      } else if (!gitService.isNetworkGateRefusal(result.error)) {
        this.error =
          result.error?.message ?? `Failed to load ${this.reviewCommentNoun} comments`;
        showToast(this.error, 'error');
      }
    } catch (err) {
      if (
        this.repositoryPath !== targetRepoPath ||
        this.repoGeneration !== repoGen ||
        this.commentLoadGeneration !== loadGen ||
        this.selectedAccountId !== targetAccountId
      ) {
        return;
      }
      this.error =
        err instanceof Error
          ? err.message
          : `Failed to load ${this.reviewCommentNoun} comments`;
      showToast(this.error, 'error');
    } finally {
      if (this.commentLoadGeneration === loadGen && this.loadingCommentsForPr === prNumber) {
        this.loadingCommentsForPr = null;
      }
    }
  }

  protected async handleAddPrComment(prNumber: number, commitId?: string): Promise<void> {
    const body = this.commentBodyInput.trim();
    if (!body || !this.detectedRepo || !this.isConnectedForComments()) return;

    const targetRepoPath = this.repositoryPath;
    const targetDetectedRepo = this.detectedRepo;
    const targetAccountId = this.selectedAccountId;
    const repoGen = this.repoGeneration;
    const drawerLoadGen = this.commentLoadGeneration;
    const postGen = ++this.commentPostGeneration;
    const path = this.commentFilePathInput.trim() || undefined;
    const parsedLine = parseInt(this.commentLineInput.trim(), 10);
    const line = !Number.isNaN(parsedLine) && parsedLine > 0 ? parsedLine : undefined;

    this.postingCommentForPr = prNumber;
    this.error = null;

    try {
      if (
        await gitService.checkOutboundHostAllowed(
          this.getCommentsOutboundHost(targetDetectedRepo),
          false,
        )
      ) {
        return;
      }
      if (
        this.repositoryPath !== targetRepoPath ||
        this.repoGeneration !== repoGen ||
        this.commentPostGeneration !== postGen ||
        this.selectedAccountId !== targetAccountId
      ) {
        return;
      }

      const token = await this.getTokenForComments(targetAccountId);
      if (
        this.repositoryPath !== targetRepoPath ||
        this.repoGeneration !== repoGen ||
        this.commentPostGeneration !== postGen ||
        this.selectedAccountId !== targetAccountId
      ) {
        return;
      }

      const result = await this.postPrComment(
        targetDetectedRepo,
        prNumber,
        body,
        path,
        line,
        commitId,
        token,
      );

      if (result.success) {
        showToast('Comment posted', 'success');
        if (
          this.repositoryPath === targetRepoPath &&
          this.repoGeneration === repoGen &&
          this.selectedAccountId === targetAccountId &&
          this.commentPostGeneration === postGen &&
          this.expandedPrNumber === prNumber
        ) {
          if (this.commentLoadGeneration === drawerLoadGen) {
            this.commentBodyInput = '';
            this.commentFilePathInput = '';
            this.commentLineInput = '';
          }
          await this.loadPrComments(prNumber);
        }
      } else if (!gitService.isNetworkGateRefusal(result.error)) {
        const message =
          result.error?.message ?? `Failed to post ${this.reviewCommentNoun} comment`;
        if (
          this.repositoryPath === targetRepoPath &&
          this.repoGeneration === repoGen &&
          this.commentPostGeneration === postGen &&
          this.selectedAccountId === targetAccountId &&
          this.expandedPrNumber === prNumber
        ) {
          this.error = message;
        }
        showToast(message, 'error');
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : `Failed to post ${this.reviewCommentNoun} comment`;
      if (
        this.repositoryPath === targetRepoPath &&
        this.repoGeneration === repoGen &&
        this.commentPostGeneration === postGen &&
        this.selectedAccountId === targetAccountId &&
        this.expandedPrNumber === prNumber
      ) {
        this.error = message;
      }
      showToast(message, 'error');
    } finally {
      if (this.commentPostGeneration === postGen && this.postingCommentForPr === prNumber) {
        this.postingCommentForPr = null;
      }
    }
  }

  protected renderPrCommentsDrawer(prNumber: number, commitId?: string): TemplateResult {
    const comments = this.prComments[prNumber] ?? [];
    const isLoadingComments = this.loadingCommentsForPr === prNumber;
    const isPosting = this.postingCommentForPr === prNumber;

    return html`
      <div class="pr-comments-drawer" data-testid="pr-comments-drawer-${prNumber}" @click=${(e: Event) => e.stopPropagation()}>
        ${isLoadingComments ? html`
          <div class="pr-comments-empty">Loading comments...</div>
        ` : comments.length === 0 ? html`
          <div class="pr-comments-empty">No comments yet</div>
        ` : html`
          <div class="pr-comments-list">
            ${comments.map(c => html`
              <div class="pr-comment-item" data-testid="pr-comment-item-${c.id}">
                <div class="pr-comment-header">
                  <span class="pr-comment-author">${c.author}</span>
                  ${c.filePath ? html`
                    <span class="pr-comment-location">${c.filePath}${c.line ? `:${c.line}` : ''}</span>
                  ` : nothing}
                  <span class="pr-comment-date">${this.formatDate(c.createdAt)}</span>
                </div>
                <div class="pr-comment-body">${c.body}</div>
              </div>
            `)}
          </div>
        `}
        <div class="pr-comment-form">
          <div class="pr-comment-inline-fields">
            <input
              type="text"
              class="pr-comment-file-input"
              placeholder="File path (optional, for inline comment)"
              .value=${this.commentFilePathInput}
              @input=${(e: Event) => {
                this.commentFilePathInput = (e.target as HTMLInputElement).value;
              }}
            />
            <input
              type="number"
              min="1"
              class="pr-comment-line-input"
              placeholder="Line #"
              .value=${this.commentLineInput}
              @input=${(e: Event) => {
                this.commentLineInput = (e.target as HTMLInputElement).value;
              }}
            />
          </div>
          <div class="pr-comment-input-row">
            <textarea
              class="pr-comment-body-input"
              rows="2"
              placeholder="Write a review comment..."
              .value=${this.commentBodyInput}
              @input=${(e: Event) => {
                this.commentBodyInput = (e.target as HTMLTextAreaElement).value;
              }}
            ></textarea>
            <button
              class="btn btn-primary pr-comment-submit"
              data-testid="pr-comment-submit-${prNumber}"
              ?disabled=${!this.commentBodyInput.trim() || isPosting}
              @click=${() => this.handleAddPrComment(prNumber, commitId)}
            >
              ${isPosting ? 'Posting...' : 'Post Comment'}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  protected renderNoRepo(): TemplateResult {
    if (this.isDetectingRepo || (this.isLoading && Boolean(this.repositoryPath))) {
      return html`<div class="loading">Detecting repository...</div>`;
    }
    return html`
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
        <p>No ${this.providerDisplayName} repository detected</p>
      </div>
    `;
  }

  protected openInBrowser(url: string): void {
    openExternalUrl(url);
  }

  protected formatDate(dateStr: string): string {
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

  protected getInitials(name: string): string {
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .substring(0, 2)
      .toUpperCase();
  }
}
