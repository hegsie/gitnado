/**
 * Account Repository Picker
 *
 * Lists the repositories of a connected provider account so the clone dialog
 * can offer "clone one of mine" instead of only "paste a URL". Selecting a
 * repository hands its HTTPS clone URL back to the host dialog, which runs the
 * unchanged clone flow (progress, cancellation and all).
 *
 * Deliberately its own element rather than more state inside lv-clone-dialog:
 * the dialog keeps one small source-selection block, and every listing state
 * (no accounts, no credential, expired token, API error, blocked by the
 * security gate, empty, loading, loading more, a failed load more) is testable
 * on its own.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import {
  isNetworkGateRefusal,
  listGitHubRepositories,
  listGitLabProjects,
  listBitbucketRepositories,
  listAdoRepositories,
  type ProviderRepository,
  type ProviderRepositoryPage,
} from '../../services/git.service.ts';
import type { CommandResult } from '../../types/api.types.ts';
import { unifiedProfileStore, getAccountsByType } from '../../stores/unified-profile.store.ts';
import { settingsStore } from '../../stores/settings.store.ts';
import { getFreshAccountToken } from '../../services/credential.service.ts';
import type { IntegrationAccount } from '../../types/unified-profile.types.ts';
import { INTEGRATION_TYPE_NAMES } from '../../types/unified-profile.types.ts';
import './lv-account-selector.ts';

/** Providers that can list an account's repositories. */
export type RepoPickerProvider = 'github' | 'gitlab' | 'bitbucket' | 'azure-devops';

export const REPO_PICKER_PROVIDERS: RepoPickerProvider[] = [
  'github',
  'gitlab',
  'bitbucket',
  'azure-devops',
];

/**
 * Page size asked of every provider.
 *
 * Kept in sync with the REPOSITORIES_DEFAULT_* constants in the four Rust
 * command modules, so the number the hint quotes is the number requested.
 */
export const REPO_PICKER_PAGE_SIZE = 30;

/** What stopped the listing, so the UI can say what to do about it. */
type PickerErrorKind =
  | 'no-credential'
  | 'auth'
  | 'blocked'
  | 'misconfigured'
  | 'api';

@customElement('lv-account-repo-picker')
export class LvAccountRepoPicker extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .picker {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .provider-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .provider-row label {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
      }

      .provider-row select,
      .search-input {
        padding: var(--spacing-sm) var(--spacing-md);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        font-family: inherit;
      }

      .search-input {
        width: 100%;
        box-sizing: border-box;
      }

      .repo-list {
        display: flex;
        flex-direction: column;
        max-height: 220px;
        overflow-y: auto;
        margin: 0;
        padding: 0;
        /* The rows carry their own separators; the explicit role="list" keeps
           the list semantics that list-style: none strips in Safari. */
        list-style: none;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-primary);
      }

      .repo-row {
        display: flex;
      }

      .repo-item {
        display: flex;
        flex: 1;
        min-width: 0;
        flex-direction: column;
        gap: 2px;
        padding: var(--spacing-sm) var(--spacing-md);
        border: none;
        border-bottom: 1px solid var(--color-border);
        background: none;
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        font-family: inherit;
        text-align: left;
        cursor: pointer;
      }

      .repo-row:last-child .repo-item {
        border-bottom: none;
      }

      .repo-item:hover {
        background: var(--color-bg-hover);
      }

      .repo-item.selected {
        background: var(--color-accent-bg, var(--color-bg-hover));
      }

      .repo-title {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .repo-name {
        font-weight: var(--font-weight-medium);
      }

      .repo-owner {
        color: var(--color-text-tertiary);
      }

      .badge {
        padding: 0 4px;
        border-radius: var(--radius-sm);
        background: var(--color-bg-tertiary);
        color: var(--color-text-tertiary);
        font-size: var(--font-size-xs);
        text-transform: uppercase;
        letter-spacing: 0.4px;
      }

      .repo-meta {
        color: var(--color-text-tertiary);
        font-size: var(--font-size-xs);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .hint {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted, var(--color-text-tertiary));
      }

      .state-message {
        padding: var(--spacing-md);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-tertiary);
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
      }

      .state-message.error {
        border-color: var(--color-error);
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      .state-actions {
        display: flex;
        gap: var(--spacing-sm);
        margin-top: var(--spacing-sm);
      }

      .link-btn {
        padding: 4px var(--spacing-md);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-secondary);
        color: var(--color-text-primary);
        font-size: var(--font-size-xs);
        font-family: inherit;
        cursor: pointer;
      }

      .link-btn:hover:not(:disabled) {
        background: var(--color-bg-hover);
        border-color: var(--color-primary);
      }

      .link-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `,
  ];

  /** Set while a clone is running, so the picker cannot start another load. */
  @property({ type: Boolean }) disabled = false;

  @state() private provider: RepoPickerProvider = 'github';
  @state() private selectedAccountId: string | null = null;
  @state() private accountCounts: Record<RepoPickerProvider, number> = {
    github: 0,
    gitlab: 0,
    bitbucket: 0,
    'azure-devops': 0,
  };
  @state() private repositories: ProviderRepository[] = [];
  @state() private filter = '';
  @state() private isLoading = false;
  @state() private isLoadingMore = false;
  /** True once a load has completed for the current account. */
  @state() private hasLoaded = false;
  @state() private nextPage: number | null = null;
  @state() private errorKind: PickerErrorKind | null = null;
  @state() private errorMessage = '';
  @state() private selectedRepoId: string | null = null;
  /**
   * The page a failed "Load more" was asking for, or null when the failure
   * belongs to a first-page load.
   *
   * A failed append must not take the list with it: the 30/60/90 repositories
   * already on screen (and the row the user had highlighted) are still valid,
   * so the error renders BENEATH them and Retry re-requests this page instead
   * of restarting the account from page 1.
   */
  @state() private failedAppendPage: number | null = null;

  private unsubscribe?: () => void;
  /**
   * Set once the user picks a provider themselves. After that the picker must
   * not re-home onto a provider that happens to have accounts — doing so would
   * bounce them straight back off the provider whose "connect an account"
   * message they are reading.
   */
  private providerChosenByUser = false;
  /**
   * Bumped on every load. A response whose sequence is stale (the user switched
   * account or provider while it was in flight) is dropped, so a slow first
   * account cannot overwrite the list of the second.
   */
  private loadSequence = 0;
  /**
   * The append page of the load currently running, so `failWith` — which is
   * also reached from `fetchPage` — knows whether the failure it is recording
   * belongs to a "Load more" or to a first-page load.
   */
  private currentLoadAppendPage: number | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribe = unifiedProfileStore.subscribe(() => this.syncAccounts());
    this.syncAccounts();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    // Any response still in flight belongs to a picker that is gone.
    this.loadSequence++;
  }

  /** Recompute per-provider counts and keep the selection valid. */
  private syncAccounts(): void {
    this.accountCounts = {
      github: getAccountsByType('github').length,
      gitlab: getAccountsByType('gitlab').length,
      bitbucket: getAccountsByType('bitbucket').length,
      'azure-devops': getAccountsByType('azure-devops').length,
    };

    // Land on a provider the user actually has an account for, but only while
    // nothing has been chosen yet — re-picking later would yank the list out
    // from under a deliberate choice.
    if (
      this.accountCounts[this.provider] === 0 &&
      !this.selectedAccountId &&
      !this.providerChosenByUser
    ) {
      const withAccounts = REPO_PICKER_PROVIDERS.find((p) => this.accountCounts[p] > 0);
      if (withAccounts) this.provider = withAccounts;
    }

    const accounts = getAccountsByType(this.provider);
    if (this.selectedAccountId && !accounts.some((a) => a.id === this.selectedAccountId)) {
      // The selected account was deleted elsewhere.
      this.selectedAccountId = null;
      this.resetList();
    }
    if (!this.selectedAccountId && accounts.length > 0) {
      const preferred = accounts.find((a) => a.isDefault) ?? accounts[0];
      this.selectedAccountId = preferred.id;
      void this.loadFirstPage();
    }
  }

  private get accounts(): IntegrationAccount[] {
    return getAccountsByType(this.provider);
  }

  private get selectedAccount(): IntegrationAccount | null {
    return this.accounts.find((a) => a.id === this.selectedAccountId) ?? null;
  }

  private get totalAccountCount(): number {
    return REPO_PICKER_PROVIDERS.reduce((sum, p) => sum + this.accountCounts[p], 0);
  }

  private resetList(): void {
    this.repositories = [];
    this.nextPage = null;
    this.hasLoaded = false;
    this.errorKind = null;
    this.errorMessage = '';
    this.failedAppendPage = null;
    this.selectedRepoId = null;
    // Drop any response still in flight for the previous account.
    this.loadSequence++;
    this.isLoading = false;
    this.isLoadingMore = false;
  }

  /**
   * Fetch a page for the selected account.
   *
   * Nothing is fetched when the dialog opens — only when an account is in hand,
   * and one page at a time, because an account can own hundreds of
   * repositories.
   */
  private async loadPage(page: number, append: boolean): Promise<void> {
    const account = this.selectedAccount;
    if (!account || this.disabled) return;

    const sequence = ++this.loadSequence;
    this.currentLoadAppendPage = append ? page : null;
    if (append) {
      this.isLoadingMore = true;
    } else {
      this.isLoading = true;
      this.repositories = [];
      this.selectedRepoId = null;
    }
    this.errorKind = null;
    this.errorMessage = '';
    this.failedAppendPage = null;

    try {
      const token = await this.resolveToken(account);
      if (sequence !== this.loadSequence) return;
      if (!token && account.integrationType !== 'github') {
        // No stored credential at all — the account exists but was never
        // connected, or its token was removed. GitHub is the exception: a
        // configured GitHub App mints an installation token in the backend,
        // so that call is worth making with no token in hand.
        this.failWith('no-credential', '');
        return;
      }

      const result = await this.fetchPage(account, token, page);
      if (sequence !== this.loadSequence) return;

      if (!result) return; // fetchPage already reported a misconfiguration.

      if (!result.success || !result.data) {
        const message = result.error?.message ?? '';
        if (isNetworkGateRefusal(result.error)) {
          this.failWith('blocked', '');
        } else if (result.error?.code === 'AUTH_REQUIRED') {
          this.failWith('auth', '');
        } else if (/token not configured/i.test(message)) {
          // The GitHub-App fallback above found nothing either: there really is
          // no credential for this account.
          this.failWith('no-credential', '');
        } else {
          this.failWith('api', message || 'Failed to list repositories');
        }
        return;
      }

      const data: ProviderRepositoryPage = result.data;
      this.repositories = append
        ? [...this.repositories, ...data.repositories]
        : data.repositories;
      this.nextPage = data.nextPage ?? null;
      this.hasLoaded = true;
    } catch (err) {
      if (sequence !== this.loadSequence) return;
      this.failWith('api', err instanceof Error ? err.message : 'Failed to list repositories');
    } finally {
      if (sequence === this.loadSequence) {
        this.isLoading = false;
        this.isLoadingMore = false;
        this.currentLoadAppendPage = null;
      }
    }
  }

  private failWith(kind: PickerErrorKind, message: string): void {
    this.errorKind = kind;
    this.errorMessage = message;
    // Which load failed decides where the message goes: a first page replaces
    // the list area, a "Load more" is reported under the pages already loaded.
    this.failedAppendPage = this.currentLoadAppendPage;
    // A failed load has still "answered" — the list area shows the failure
    // rather than a stale "choose an account" prompt.
    this.hasLoaded = true;
  }

  private loadFirstPage(): Promise<void> {
    return this.loadPage(1, false);
  }

  private async handleLoadMore(): Promise<void> {
    if (this.nextPage === null || this.isLoading || this.isLoadingMore) return;
    await this.loadPage(this.nextPage, true);
  }

  /**
   * The account's stored token, refreshing an expiring OAuth one first — the
   * same resolution the provider dialogs use, so a picker load never fails for
   * a credential the rest of the app would have renewed.
   */
  private async resolveToken(account: IntegrationAccount): Promise<string | null> {
    switch (account.integrationType) {
      case 'github':
        return getFreshAccountToken('github', account.id, 'github');
      case 'gitlab':
        return getFreshAccountToken(
          'gitlab',
          account.id,
          'gitlab',
          account.config.type === 'gitlab' ? account.config.instanceUrl : undefined,
        );
      case 'bitbucket':
        return getFreshAccountToken('bitbucket', account.id, 'bitbucket');
      case 'azure-devops':
        return getFreshAccountToken('azure-devops', account.id, 'azure');
      default:
        return null;
    }
  }

  /**
   * Issue the provider's listing call. Returns null (having set an error) when
   * the account is missing the detail its provider needs.
   */
  private async fetchPage(
    account: IntegrationAccount,
    token: string | null,
    page: number,
  ): Promise<CommandResult<ProviderRepositoryPage> | null> {
    switch (account.integrationType) {
      case 'github':
        return listGitHubRepositories(REPO_PICKER_PAGE_SIZE, page, token);
      case 'gitlab': {
        const instanceUrl =
          account.config.type === 'gitlab' ? account.config.instanceUrl : '';
        if (!instanceUrl) {
          this.failWith('misconfigured', 'This GitLab account has no instance URL.');
          return null;
        }
        return listGitLabProjects(instanceUrl, REPO_PICKER_PAGE_SIZE, page, token);
      }
      case 'bitbucket': {
        const workspace =
          account.config.type === 'bitbucket' ? account.config.workspace : '';
        // An empty workspace is legitimate: the API then lists every workspace
        // the account belongs to.
        return listBitbucketRepositories(workspace || null, REPO_PICKER_PAGE_SIZE, page, token);
      }
      case 'azure-devops': {
        const organization =
          account.config.type === 'azure-devops' ? account.config.organization : '';
        if (!organization) {
          this.failWith(
            'misconfigured',
            'This Azure DevOps account has no organization configured.',
          );
          return null;
        }
        return listAdoRepositories(organization, REPO_PICKER_PAGE_SIZE, page, token);
      }
      default:
        this.failWith('misconfigured', 'This account type cannot list repositories.');
        return null;
    }
  }

  private handleProviderChange(e: Event): void {
    const value = (e.target as HTMLSelectElement).value as RepoPickerProvider;
    if (value === this.provider) return;
    this.providerChosenByUser = true;
    this.provider = value;
    this.selectedAccountId = null;
    this.resetList();
    // syncAccounts picks this provider's default account and loads it.
    this.syncAccounts();
  }

  private handleAccountChange(e: CustomEvent<{ account: IntegrationAccount }>): void {
    // Consume the selector's event: it is an internal detail of this picker,
    // and the host dialog has no use for it.
    e.stopPropagation();
    const { account } = e.detail;
    if (account.id === this.selectedAccountId) return;
    this.selectedAccountId = account.id;
    this.resetList();
    void this.loadFirstPage();
  }

  /**
   * Both "Add Account" and "Manage Accounts..." lead to the same place: the
   * Profiles & Accounts manager, where a new account is connected. The
   * selector's own event is consumed and re-dispatched under one name so the
   * host has a single thing to listen for.
   */
  private handleAccountsAction(e: Event): void {
    e.stopPropagation();
    this.requestManageAccounts();
  }

  private requestManageAccounts(): void {
    this.dispatchEvent(
      new CustomEvent('manage-accounts', {
        detail: { integrationType: this.provider },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleFilterInput(e: Event): void {
    this.filter = (e.target as HTMLInputElement).value;
  }

  private handleSelectRepository(repo: ProviderRepository): void {
    this.selectedRepoId = repo.id;
    this.dispatchEvent(
      new CustomEvent('repository-selected', {
        detail: { repository: repo },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleRetry(): void {
    // Resume where the failure happened. Restarting at page 1 after a flaky
    // page 4 threw away every page the user had already waited for.
    const appendPage = this.failedAppendPage;
    if (appendPage !== null) {
      void this.loadPage(appendPage, true);
      return;
    }
    void this.loadFirstPage();
  }

  /** Repositories matching the search box, over everything loaded so far. */
  private get filteredRepositories(): ProviderRepository[] {
    const needle = this.filter.trim().toLowerCase();
    if (!needle) return this.repositories;
    return this.repositories.filter((repo) =>
      [repo.fullName, repo.name, repo.owner, repo.description ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }

  render() {
    return html`
      <div class="picker">
        ${this.totalAccountCount === 0
          ? this.renderNoAccounts()
          : html`
              ${this.renderProviderRow()}
              <lv-account-selector
                .integrationType=${this.provider}
                .selectedAccountId=${this.selectedAccountId}
                ?disabled=${this.disabled}
                @account-change=${this.handleAccountChange}
                @add-account=${this.handleAccountsAction}
                @manage-accounts=${this.handleAccountsAction}
              ></lv-account-selector>
              ${this.accounts.length === 0
                ? this.renderNoProviderAccounts()
                : this.renderListArea()}
            `}
      </div>
    `;
  }

  private renderNoAccounts() {
    return html`
      <div class="state-message" data-state="no-accounts">
        No accounts are connected yet. Connect a GitHub, GitLab, Bitbucket or
        Azure DevOps account to clone one of your repositories without pasting a
        URL.
        <div class="state-actions">
          <button class="link-btn" @click=${this.requestManageAccounts}>
            Connect an account
          </button>
        </div>
      </div>
    `;
  }

  private renderNoProviderAccounts() {
    return html`
      <div class="state-message" data-state="no-provider-accounts">
        No ${INTEGRATION_TYPE_NAMES[this.provider]} account is connected.
        <div class="state-actions">
          <button class="link-btn" @click=${this.requestManageAccounts}>
            Connect an account
          </button>
        </div>
      </div>
    `;
  }

  private renderProviderRow() {
    return html`
      <div class="provider-row">
        <label for="repo-provider">Provider</label>
        <select
          id="repo-provider"
          .value=${this.provider}
          @change=${this.handleProviderChange}
          ?disabled=${this.disabled}
        >
          ${REPO_PICKER_PROVIDERS.map(
            (p) => html`<option value=${p} ?selected=${p === this.provider}>
              ${INTEGRATION_TYPE_NAMES[p]} (${this.accountCounts[p]})
            </option>`,
          )}
        </select>
      </div>
    `;
  }

  private renderListArea() {
    if (this.isLoading) {
      return html`<div class="state-message" data-state="loading">
        Loading repositories…
      </div>`;
    }

    // A failed "Load more" keeps its list: only a first-page failure has
    // nothing to show behind it.
    if (this.errorKind && this.failedAppendPage === null) {
      return this.renderError();
    }

    if (!this.hasLoaded) {
      return html`<div class="state-message" data-state="idle">
        Choose an account to list its repositories.
      </div>`;
    }

    if (this.repositories.length === 0) {
      return html`
        <div class="state-message" data-state="empty">
          This account has no repositories to clone.
          <div class="state-actions">
            <button class="link-btn" @click=${this.handleRetry}>Retry</button>
          </div>
        </div>
      `;
    }

    const matches = this.filteredRepositories;

    return html`
      <input
        id="repo-filter"
        class="search-input"
        type="search"
        placeholder="Filter repositories…"
        aria-label="Filter repositories"
        .value=${this.filter}
        @input=${this.handleFilterInput}
        ?disabled=${this.disabled}
      />
      ${matches.length === 0
        ? html`<div class="state-message" data-state="no-matches">
            No repository loaded so far matches “${this.filter.trim()}”.
            ${this.nextPage !== null ? 'Load more to keep looking.' : ''}
          </div>`
        : html`
            <ul class="repo-list" role="list" aria-label="Repositories">
              ${matches.map((repo) => this.renderRepository(repo))}
            </ul>
          `}
      <div class="hint">
        Showing ${matches.length} of ${this.repositories.length} loaded
        ${this.repositories.length === 1 ? 'repository' : 'repositories'}${this
          .nextPage !== null
          ? `, ${REPO_PICKER_PAGE_SIZE} at a time`
          : ''}.
      </div>
      ${this.errorKind
        ? html`<div class="append-error" data-state="load-more-error">
            ${this.renderError()}
          </div>`
        : this.nextPage !== null
          ? html`
              <div class="state-actions">
                <button
                  class="link-btn"
                  data-action="load-more"
                  @click=${this.handleLoadMore}
                  ?disabled=${this.disabled || this.isLoadingMore}
                >
                  ${this.isLoadingMore ? 'Loading more…' : 'Load more'}
                </button>
              </div>
            `
          : nothing}
    `;
  }

  private renderRepository(repo: ProviderRepository) {
    const pushed = formatLastPush(repo.lastPushedAt);
    const meta = [repo.description ?? '', pushed ? `Updated ${pushed}` : '']
      .filter(Boolean)
      .join(' · ');

    const selected = this.selectedRepoId === repo.id;

    // A real <button> inside a plain list row: putting role="listitem" ON the
    // button would override its implicit button role, so a screen reader would
    // announce each repository as static list text instead of something you can
    // activate. Selection is stated with aria-pressed, not left to the
    // `.selected` background alone.
    return html`
      <li class="repo-row" role="listitem">
        <button
          class="repo-item ${selected ? 'selected' : ''}"
          aria-pressed=${selected ? 'true' : 'false'}
          title=${repo.fullName}
          @click=${() => this.handleSelectRepository(repo)}
          ?disabled=${this.disabled}
        >
          <span class="repo-title">
            <span class="repo-name">${repo.name}</span>
            <span class="repo-owner">${repo.owner}</span>
            <span class="badge">${repo.isPrivate ? 'Private' : 'Public'}</span>
          </span>
          ${meta ? html`<span class="repo-meta">${meta}</span>` : nothing}
        </button>
      </li>
    `;
  }

  private renderError() {
    const providerName = INTEGRATION_TYPE_NAMES[this.provider];

    if (this.errorKind === 'blocked') {
      // The provider wrapper blocks these calls silently (no toast) because
      // most of its callers are background refreshes, so the reason has to be
      // said here or the list would just look broken.
      const offline = settingsStore.getState().offlineMode;
      return html`
        <div class="state-message error" data-state="blocked">
          ${offline
            ? 'Offline mode is on, so your repositories cannot be listed. Turn it off in Settings > Security.'
            : `Your remote allowlist does not include ${providerName}, so its repositories cannot be listed. Add it in Settings > Security.`}
          You can still paste a clone URL under "From URL".
          ${this.failedAppendPage !== null
            ? html`<div class="state-actions">
                <button class="link-btn" @click=${this.handleRetry}>Retry</button>
              </div>`
            : nothing}
        </div>
      `;
    }

    if (this.errorKind === 'no-credential' || this.errorKind === 'auth') {
      return html`
        <div
          class="state-message error"
          data-state=${this.errorKind === 'auth' ? 'auth-expired' : 'no-credential'}
        >
          ${this.errorKind === 'auth'
            ? `This ${providerName} account's token was rejected — it has probably expired. Reconnect the account to list its repositories.`
            : `This ${providerName} account has no stored credential. Reconnect it to list its repositories.`}
          <div class="state-actions">
            <button class="link-btn" @click=${this.requestManageAccounts}>
              Reconnect account
            </button>
            <button class="link-btn" @click=${this.handleRetry}>Retry</button>
          </div>
        </div>
      `;
    }

    return html`
      <div class="state-message error" data-state="error">
        ${this.errorMessage || `Failed to list ${providerName} repositories.`}
        <div class="state-actions">
          <button class="link-btn" @click=${this.handleRetry}>Retry</button>
        </div>
      </div>
    `;
  }
}

/**
 * A short, local date for the provider's last-push timestamp. Providers that
 * report none (Azure DevOps) render no date rather than a fabricated one.
 */
function formatLastPush(timestamp: string | null): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString();
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-account-repo-picker': LvAccountRepoPicker;
  }
}
