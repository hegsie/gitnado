/**
 * Context Dashboard Component
 * Expandable/collapsible dashboard showing repository context:
 * - Active profile with git identity
 * - Connected integration accounts with status
 * - Repository information
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sharedStyles, animationStyles } from '../../styles/shared-styles.ts';
import { unifiedProfileStore, type AccountConnectionStatus, type ConnectionStatus } from '../../stores/unified-profile.store.ts';
import { repositoryStore, type OpenRepository } from '../../stores/repository.store.ts';
import * as unifiedProfileService from '../../services/unified-profile.service.ts';
import { getRemoteStatus } from '../../services/git.service.ts';
import { showToast } from '../../services/notification.service.ts';
import {
  runFetch,
  runPull,
  runPush,
  runningRemoteOperation,
  type RemoteOperationKind,
} from '../../services/remote-operations.service.ts';
import {
  INTEGRATION_TYPE_NAMES,
  matchesUrlPattern,
  resolveDefaultGlobalAccount,
  resolveProfilePreferredAccount,
} from '../../types/unified-profile.types.ts';
import { loggers } from '../../utils/index.ts';
import type { UnifiedProfile, IntegrationAccount, IntegrationType, ProfileAssignmentSource } from '../../types/unified-profile.types.ts';
import './lv-profile-card.ts';
import './lv-integration-card.ts';
import './lv-repository-card.ts';
import { RefLockController, isPushRunning } from '../../utils/ref-lock.ts';
import {
  hasConfiguredRemote,
  noRemoteButtonLabel,
  NO_REMOTE_MESSAGE,
} from '../../utils/remote-availability.ts';

const STORAGE_KEY = 'lv-context-dashboard-expanded';

const log = loggers.dashboard;

@customElement('lv-context-dashboard')
export class LvContextDashboard extends LitElement {
  static styles = [
    sharedStyles,
    animationStyles,
    css`
      :host {
        display: block;
      }

      /* Compact View */
      .dashboard-compact {
        display: flex;
        align-items: center;
        height: 36px;
        padding: 0 var(--spacing-md);
        background: var(--color-bg-secondary);
        border-bottom: 1px solid var(--color-border);
        gap: var(--spacing-md);
      }

      .compact-profile {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        min-width: 0;
      }

      .profile-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .profile-name {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        white-space: nowrap;
      }

      .compact-identity {
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 200px;
      }

      /* The compact bar names no ref at all, so a detached HEAD had nowhere to
         show while it lasted. */
      .detached-head {
        font-size: var(--font-size-xs);
        font-family: var(--font-family-mono);
        white-space: nowrap;
        padding: 2px 6px;
        border-radius: var(--radius-xs);
        background: var(--color-warning-bg);
        color: var(--color-warning);
      }

      .compact-divider {
        width: 1px;
        height: 16px;
        background: var(--color-border);
      }

      .compact-accounts {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .account-status-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        padding: 0;
        border: none;
        border-radius: 50%;
        background: transparent;
        cursor: pointer;
        transition: transform var(--transition-fast);
      }

      .account-status-btn:hover {
        transform: scale(1.2);
      }

      .account-status-btn:focus {
        outline: 2px solid var(--color-accent);
        outline-offset: 1px;
      }

      .account-status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        pointer-events: none;
      }

      .account-status-dot.connected {
        background: var(--color-success, #22c55e);
      }

      .account-status-dot.disconnected {
        background: var(--color-error, #ef4444);
      }

      .account-status-dot.checking {
        background: var(--color-warning, #f59e0b);
        animation: pulse 1s ease-in-out infinite;
      }

      .account-status-dot.unknown {
        background: var(--color-text-tertiary);
        opacity: 0.5;
      }

      /* Configure button for unconfigured integrations */
      .configure-btn {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-accent);
        border-radius: var(--radius-sm);
        background: var(--color-accent-bg);
        color: var(--color-accent);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .configure-btn:hover {
        background: var(--color-accent);
        color: white;
      }

      /* Configure card for expanded view */
      .configure-card {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        background: var(--color-bg-primary);
        border: 1px dashed var(--color-border);
        border-radius: var(--radius-md);
        padding: var(--spacing-md);
      }

      .configure-card-icon {
        width: 32px;
        height: 32px;
        flex-shrink: 0;
        color: var(--color-text-tertiary);
      }

      .configure-card-icon svg {
        width: 100%;
        height: 100%;
      }

      .configure-card-content {
        flex: 1;
        min-width: 0;
      }

      .configure-card-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        margin-bottom: var(--spacing-xs);
      }

      .configure-card-description {
        font-size: var(--font-size-xs);
        color: var(--color-text-tertiary);
        line-height: 1.4;
      }

      .configure-card-btn {
        padding: var(--spacing-xs) var(--spacing-md);
        border: 1px solid var(--color-accent);
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-accent);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        transition: all var(--transition-fast);
        flex-shrink: 0;
      }

      .configure-card-btn:hover {
        background: var(--color-accent);
        color: white;
      }

      /* pulse animation imported from animationStyles */

      .expand-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        margin-left: auto;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-tertiary);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .expand-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .expand-btn svg {
        width: 16px;
        height: 16px;
        transition: transform var(--transition-fast);
      }

      .expand-btn.expanded svg {
        transform: rotate(180deg);
      }

      /* Expanded View */
      .dashboard-expanded {
        background: var(--color-bg-secondary);
        border-bottom: 1px solid var(--color-border);
        padding: var(--spacing-md);
        animation: slideDown 0.2s ease-out;
      }

      /* slideDown animation imported from animationStyles */

      .dashboard-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--spacing-md);
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
      }

      .dashboard-title {
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .card-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: var(--spacing-md);
      }

      /* Empty states */
      .no-profile {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        font-size: var(--font-size-sm);
        color: var(--color-text-tertiary);
      }

      .no-profile-btn {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .no-profile-btn:hover {
        border-color: var(--color-accent);
        color: var(--color-accent);
      }

      .no-profile-btn svg {
        width: 12px;
        height: 12px;
      }

      /* Profile Selector */
      .profile-selector {
        position: relative;
      }

      .profile-selector-btn {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-xs) var(--spacing-sm);
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .profile-selector-btn:hover {
        background: var(--color-bg-hover);
      }

      .profile-selector-btn.loading {
        opacity: 0.7;
        pointer-events: none;
      }

      .profile-selector-btn .chevron {
        width: 12px;
        height: 12px;
        color: var(--color-text-tertiary);
        transition: transform var(--transition-fast);
      }

      .profile-selector-btn.open .chevron {
        transform: rotate(180deg);
      }

      .profile-dropdown {
        position: absolute;
        top: 100%;
        left: 0;
        margin-top: var(--spacing-xs);
        min-width: 220px;
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        z-index: var(--z-dropdown, 100);
        overflow: hidden;
      }

      .dropdown-header {
        padding: var(--spacing-sm) var(--spacing-md);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        border-bottom: 1px solid var(--color-border);
      }

      .dropdown-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        width: 100%;
        padding: var(--spacing-sm) var(--spacing-md);
        border: none;
        background: none;
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        text-align: left;
        cursor: pointer;
        transition: background var(--transition-fast);
      }

      .dropdown-item:hover {
        background: var(--color-bg-hover);
      }

      .dropdown-item.active {
        background: var(--color-accent-bg);
      }

      .dropdown-item .profile-color {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .dropdown-item .profile-info {
        flex: 1;
        min-width: 0;
      }

      .dropdown-item .profile-display-name {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .dropdown-item .default-tag {
        font-size: 10px;
        opacity: 0.6;
      }

      .dropdown-item .profile-email {
        font-size: var(--font-size-xs);
        color: var(--color-text-tertiary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .dropdown-item .check-icon {
        width: 14px;
        height: 14px;
        color: var(--color-accent);
        flex-shrink: 0;
      }

      .dropdown-divider {
        height: 1px;
        background: var(--color-border);
        margin: var(--spacing-xs) 0;
      }

      .dropdown-action {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        width: 100%;
        padding: var(--spacing-sm) var(--spacing-md);
        border: none;
        background: none;
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        text-align: left;
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .dropdown-action:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .dropdown-action svg {
        width: 14px;
        height: 14px;
      }

      .dropdown-empty {
        padding: var(--spacing-md);
        text-align: center;
        color: var(--color-text-tertiary);
        font-size: var(--font-size-sm);
      }

      .loading-spinner {
        width: 14px;
        height: 14px;
        border: 2px solid var(--color-text-tertiary);
        border-top-color: transparent;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      /* Remote buttons */
      .remote-buttons {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        margin-left: auto;
        padding-right: var(--spacing-sm);
      }

      .remote-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--spacing-xs);
        height: 24px;
        padding: 0 var(--spacing-sm);
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .remote-btn:hover:not(:disabled) {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .remote-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .remote-btn svg {
        width: 14px;
        height: 14px;
      }

      .remote-btn.loading svg {
        animation: spin 1s linear infinite;
      }

      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }

      .remote-btn-wrapper {
        position: relative;
        display: inline-flex;
      }

      .badge {
        position: absolute;
        top: -4px;
        right: -4px;
        min-width: 14px;
        height: 14px;
        padding: 0 3px;
        font-size: 9px;
        font-weight: 600;
        line-height: 14px;
        text-align: center;
        border-radius: var(--radius-full);
        color: white;
      }

      .badge.push {
        background: var(--color-success);
      }

      .badge.pull {
        background: var(--color-primary);
      }
    `,
  ];

  @state() private isExpanded = false;
  @state() private activeProfile: UnifiedProfile | null = null;
  @state() private profiles: UnifiedProfile[] = [];
  @state() private accounts: IntegrationAccount[] = [];
  @state() private accountConnectionStatus: Record<string, AccountConnectionStatus> = {};
  @state() private activeRepository: OpenRepository | null = null;
  @state() private repositoryAssignments: Record<string, string> = {};
  @state() private isProfileDropdownOpen = false;
  @state() private isApplyingProfile = false;
  @state() private ahead = 0;
  @state() private behind = 0;

  private unsubscribeProfile?: () => void;
  private unsubscribeRepo?: () => void;

  connectedCallback(): void {
    super.connectedCallback();

    // Load persisted expand state (with fallback for private browsing)
    try {
      this.isExpanded = localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      this.isExpanded = false;
    }

    // Get initial state
    const profileState = unifiedProfileStore.getState();
    this.activeProfile = profileState.activeProfile;
    this.profiles = profileState.profiles;
    this.accounts = profileState.accounts;
    this.accountConnectionStatus = profileState.accountConnectionStatus;
    this.repositoryAssignments = profileState.config?.repositoryAssignments ?? {};

    const repoState = repositoryStore.getState();
    this.activeRepository = repoState.getActiveRepository();

    // Subscribe to store changes
    this.unsubscribeProfile = unifiedProfileStore.subscribe((state) => {
      this.activeProfile = state.activeProfile;
      this.profiles = state.profiles;
      this.accounts = state.accounts;
      this.accountConnectionStatus = state.accountConnectionStatus;
      this.repositoryAssignments = state.config?.repositoryAssignments ?? {};
    });

    this.unsubscribeRepo = repositoryStore.subscribe((state) => {
      const prevRepo = this.activeRepository;
      this.activeRepository = state.getActiveRepository();
      // Refresh remote status when active repo changes
      if (prevRepo?.repository.path !== this.activeRepository?.repository.path) {
        this.loadRemoteStatus();
      }
    });

    // Listen for repository-refresh events to update badges
    window.addEventListener('repository-refresh', this.handleRepoRefresh);

    // Initial load if there's an active repo
    if (this.activeRepository) {
      this.loadRemoteStatus();
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', this.handleDocumentClick);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeProfile?.();
    this.unsubscribeRepo?.();
    document.removeEventListener('click', this.handleDocumentClick);
    window.removeEventListener('repository-refresh', this.handleRepoRefresh);
  }

  private handleRepoRefresh = (): void => {
    this.loadRemoteStatus();
  };

  private handleDocumentClick = (e: MouseEvent): void => {
    if (!this.contains(e.target as Node)) {
      this.isProfileDropdownOpen = false;
    }
  };

  private async loadRemoteStatus(): Promise<void> {
    if (!this.activeRepository) {
      this.ahead = 0;
      this.behind = 0;
      return;
    }

    try {
      const result = await getRemoteStatus(this.activeRepository.repository.path);
      if (result.success && result.data) {
        this.ahead = result.data.ahead;
        this.behind = result.data.behind;
      } else {
        this.ahead = 0;
        this.behind = 0;
      }
    } catch {
      this.ahead = 0;
      this.behind = 0;
    }
  }

  /**
   * Observe the shared locks, not just claim them.
   *
   * Every remote button's spinner and disabled state is now module state
   * (remote-operations.service holds the slot; ref-lock.ts holds the
   * working-tree and push slots), which Lit cannot observe on its own. This
   * controller subscribes to ALL of those transitions and re-renders on each
   * one, which is what lets a dashboard button show the fetch a keyboard
   * shortcut started — the two surfaces used to disagree about what the app
   * was doing, because these flags were component-local.
   */
  private lock = new RefLockController(this, () => this.activeRepository?.repository.path);

  /** The fetch/pull/push running against this repo, from ANY surface. */
  private get remoteOperation(): RemoteOperationKind | undefined {
    return runningRemoteOperation(this.activeRepository?.repository.path);
  }

  private get isRemoteOperationInProgress(): boolean {
    return this.remoteOperation !== undefined;
  }

  /**
   * Whether this repository has anywhere to fetch, pull or push TO.
   *
   * The toolbar renders the SAME three buttons directly above these and has
   * always disabled them for a repository with no remote — a freshly
   * `git init`ed folder, say. These three did not, so the greyed-out Fetch
   * with its explanation sat right on top of an identical, bright, enabled
   * Fetch that started a progress row and failed with git's own wording. The
   * rule and its phrasing are shared with the toolbar (remote-availability.ts)
   * so the two surfaces cannot drift apart again.
   */
  private get hasRemote(): boolean {
    return hasConfiguredRemote(this.activeRepository);
  }

  /** The tooltip for one of the three buttons, explaining a disabled state the
   * user would otherwise have to guess at. */
  private remoteButtonTitle(action: string, whenAvailable: string): string {
    return this.hasRemote ? whenAvailable : noRemoteButtonLabel(action);
  }

  /**
   * The three buttons are a call into the shared runner and nothing else.
   *
   * They used to carry their own copy of the whole operation — component-local
   * in-flight flags no other surface could see, no progress row at all, and a
   * bespoke refresh — while app-shell's shortcut and palette copies did it
   * differently. remote-operations.service owns the locks, the progress row,
   * the conflict routing, the failure toast and the pinned refresh, so both
   * surfaces now behave identically. The repo path is captured before the
   * runner's awaits so a tab switch mid-operation cannot redirect the result.
   *
   * No success toast: the backend emits `remote-operation-completed` and
   * setupRemoteOperationListeners toasts it, naming the remote. Ahead/behind
   * is re-read by `handleRepoRefresh` when app-shell answers the runner's
   * pinned refresh request with its own `repository-refresh` broadcast, so
   * these badges update whichever surface started the operation.
   */
  private handleFetch(): Promise<void> {
    const repoPath = this.activeRepository?.repository.path;
    if (!repoPath) return Promise.resolve();
    if (!this.warnIfNoRemote()) return Promise.resolve();
    return runFetch(repoPath);
  }

  private handlePull(): Promise<void> {
    const repoPath = this.activeRepository?.repository.path;
    if (!repoPath) return Promise.resolve();
    if (!this.warnIfNoRemote()) return Promise.resolve();
    return runPull(repoPath);
  }

  private handlePush(): Promise<void> {
    const repoPath = this.activeRepository?.repository.path;
    if (!repoPath) return Promise.resolve();
    if (!this.warnIfNoRemote()) return Promise.resolve();
    return runPush(repoPath);
  }

  /**
   * True when the operation may go ahead. The three buttons carry `?disabled`
   * for this, so a click only lands in the race window between a render and
   * the click — where a silent return would look like a dead button, exactly
   * as the toolbar's own `handleRemoteAction` says.
   */
  private warnIfNoRemote(): boolean {
    if (this.hasRemote) return true;
    showToast(NO_REMOTE_MESSAGE, 'warning');
    return false;
  }

  private toggleExpanded(): void {
    this.isExpanded = !this.isExpanded;
    try {
      localStorage.setItem(STORAGE_KEY, String(this.isExpanded));
    } catch {
      // Ignore localStorage errors (e.g., private browsing mode)
    }
  }

  private toggleProfileDropdown(e: Event): void {
    e.stopPropagation();
    this.isProfileDropdownOpen = !this.isProfileDropdownOpen;
  }

  private async handleSelectProfile(profile: UnifiedProfile): Promise<void> {
    if (!this.activeRepository || this.isApplyingProfile) return;

    this.isProfileDropdownOpen = false;
    // Captured before the await: applying is an IPC round-trip, and the
    // refresh must name the repo the switch ran ON, not whichever tab is
    // active when it returns.
    const repoPath = this.activeRepository.repository.path;
    this.isApplyingProfile = true;

    try {
      await unifiedProfileService.applyUnifiedProfile(repoPath, profile.id);
      showToast(`Applied profile "${profile.name}"`, 'success');
      // Applying a profile rewrites the repo's local git identity/signing
      // config. Refresh so listeners re-read it now (the commit panel reloads
      // the author behind its ${author} commit-template placeholder) instead
      // of only after the tab is re-switched — the same reason the profile
      // manager's Apply refreshes. Inside the try, so a failed apply never
      // announces success or refreshes.
      this.dispatchEvent(new CustomEvent('repository-refresh', {
        bubbles: true,
        composed: true,
        detail: { repoPath },
      }));
    } catch (err) {
      // Surface the failure via a visible toast — the repository store's error
      // field has no render sink, so setError alone would be silent (CLAUDE.md
      // error-feedback rule).
      showToast(
        `Failed to switch profile: ${err instanceof Error ? err.message : 'Unknown error'}`,
        'error'
      );
    } finally {
      this.isApplyingProfile = false;
    }
  }

  private getAccountStatus(accountId: string): ConnectionStatus {
    return this.accountConnectionStatus[accountId]?.status ?? 'unknown';
  }

  private isProfileDefaultAccount(account: IntegrationAccount): boolean {
    if (!this.activeProfile) return false;
    const defaultAccountId = this.activeProfile.defaultAccounts[account.integrationType];
    return defaultAccountId === account.id;
  }

  /**
   * Whether this account is the global fallback default for its provider
   * (account.isDefault). The card shows this as a muted "Global default" badge
   * only when the active profile has no explicit preference (profile default
   * takes precedence — see lv-integration-card.renderDefaultBadge).
   */
  private isGlobalDefaultAccount(account: IntegrationAccount): boolean {
    return account.isDefault === true;
  }

  private getProfileAssignmentSource(): ProfileAssignmentSource {
    if (!this.activeRepository || !this.activeProfile) return 'none';

    const repoPath = this.activeRepository.repository.path;

    // Check if manually assigned
    if (this.repositoryAssignments[repoPath] === this.activeProfile.id) {
      return 'manual';
    }

    // Check if matched by URL pattern against remote URLs
    if (this.activeProfile.urlPatterns.length > 0 && this.activeRepository.remotes?.length) {
      const matchesPattern = this.activeRepository.remotes.some((remote) =>
        this.activeProfile!.urlPatterns.some((pattern) => matchesUrlPattern(remote.url, pattern))
      );
      if (matchesPattern) {
        return 'url-pattern';
      }
    }

    // Check if it's the default profile
    if (this.activeProfile.isDefault) {
      return 'default';
    }

    return 'none';
  }

  private detectProvider(): IntegrationType | null {
    if (!this.activeRepository?.remotes?.length) return null;

    for (const remote of this.activeRepository.remotes) {
      const url = remote.url.toLowerCase();
      if (url.includes('github.com')) return 'github';
      if (url.includes('gitlab.com') || url.includes('gitlab')) return 'gitlab';
      if (url.includes('dev.azure.com') || url.includes('visualstudio.com')) return 'azure-devops';
      if (url.includes('bitbucket.org') || url.includes('bitbucket')) return 'bitbucket';
    }

    return null;
  }

  /**
   * Get the relevant integration account for the current repository.
   *
   * Resolution precedence (mirrors the backend
   * `get_repository_preferred_account`, most repo-specific first):
   * 1. An account of the detected provider whose `urlPatterns` match one of the
   *    repository's remote URLs (account-level auto-detection).
   * 2. The active profile's explicit default account for the provider.
   * 3. The global default account for the provider (`isDefault`), falling back
   *    to the first account of that type.
   *
   * Returns null if no account is configured for the detected provider.
   */
  private getRelevantAccount(): IntegrationAccount | null {
    const provider = this.detectProvider();
    if (!provider) return null;

    // 1. Account-level URL pattern match against the repo's remote URLs.
    const remotes = this.activeRepository?.remotes ?? [];
    if (remotes.length > 0) {
      const patternMatch = this.accounts.find(
        (a) =>
          a.integrationType === provider &&
          a.urlPatterns.length > 0 &&
          remotes.some((remote) =>
            a.urlPatterns.some((pattern) => matchesUrlPattern(remote.url, pattern))
          )
      );
      if (patternMatch) return patternMatch;
    }

    // Tiers 2 & 3: the profile's explicit default, then the global default —
    // the same delegation the backend does via get_profile_preferred_account.
    const preferred = this.activeProfile
      ? resolveProfilePreferredAccount(this.activeProfile, this.accounts, provider)
      : resolveDefaultGlobalAccount(this.accounts, provider);
    return preferred ?? null;
  }

  private getProviderIcon(type: IntegrationType) {
    switch (type) {
      case 'github':
        return html`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;
      case 'gitlab':
        return html`<svg viewBox="0 0 16 16" fill="currentColor"><path d="m15.734 6.1-.022-.058L13.534.358a.568.568 0 0 0-.563-.356.583.583 0 0 0-.328.122.582.582 0 0 0-.193.294l-1.47 4.499H5.025l-1.47-4.5a.572.572 0 0 0-.193-.294.583.583 0 0 0-.328-.122.568.568 0 0 0-.563.357L.289 6.04l-.022.057a4.044 4.044 0 0 0 1.342 4.681l.007.006.02.014 3.318 2.485 1.642 1.242 1 .755a.672.672 0 0 0 .814 0l1-.755 1.642-1.242 3.338-2.5.009-.007a4.046 4.046 0 0 0 1.34-4.678z"/></svg>`;
      case 'azure-devops':
        return html`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M15 3.622v8.512L11.5 15l-5.425-1.975v1.958L3.004 10.97l8.951.7V4.005L15 3.622zm-2.984.428L6.994 1v2.001L2.383 4.356l-.383 8.087 1.575 1.557V6.563z"/></svg>`;
      case 'bitbucket':
        return html`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M.778 1.211a.768.768 0 0 0-.768.892l2.06 12.484a1.044 1.044 0 0 0 1.02.88h9.947c.396 0 .736-.282.803-.68l2.06-12.684a.768.768 0 0 0-.768-.892H.778zM9.69 10.6H6.344l-.9-4.801h5.15l-.904 4.8z"/></svg>`;
    }
  }

  private openProfileManager(): void {
    this.dispatchEvent(new CustomEvent('open-profile-manager', { bubbles: true, composed: true }));
  }

  private openIntegrationDialog(type: IntegrationType): void {
    // Only dispatch for types that have registered handlers in app-shell.
    // 'oidc' is intentionally excluded: the dashboard only ever calls this with a
    // provider from detectProvider() (or an account resolved through it), which
    // never returns 'oidc' (OIDC isn't a repo-remote provider). The app-shell
    // @open-oidc listener remains live for the profile manager / command palette.
    const supportedTypes = ['github', 'gitlab', 'azure-devops', 'bitbucket'];
    if (!supportedTypes.includes(type)) {
      log.warn(`No dialog handler for integration type: ${type}`);
      return;
    }
    this.dispatchEvent(new CustomEvent(`open-${type}`, { bubbles: true, composed: true }));
  }

  private handleRefreshAccount(e: CustomEvent<{ accountId: string }>): void {
    this.dispatchEvent(new CustomEvent('refresh-account', {
      detail: e.detail,
      bubbles: true,
      composed: true
    }));
  }

  private renderProfileDropdown() {
    return html`
      <div class="profile-dropdown">
        <div class="dropdown-header">Switch Profile</div>
        ${this.profiles.length > 0
          ? this.profiles.map((profile) => html`
              <button
                class="dropdown-item ${profile.id === this.activeProfile?.id ? 'active' : ''}"
                @click=${() => this.handleSelectProfile(profile)}
              >
                <span
                  class="profile-color"
                  style="background: ${profile.color}"
                ></span>
                <div class="profile-info">
                  <div class="profile-display-name">
                    ${profile.name}
                    ${profile.isDefault ? html`<span class="default-tag">(default)</span>` : nothing}
                  </div>
                  <div class="profile-email">${profile.gitEmail}</div>
                </div>
                ${profile.id === this.activeProfile?.id
                  ? html`
                      <svg class="check-icon" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
                      </svg>
                    `
                  : nothing}
              </button>
            `)
          : html`<div class="dropdown-empty">No profiles configured</div>`}
        <div class="dropdown-divider"></div>
        <button class="dropdown-action" @click=${this.openProfileManager}>
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path fill-rule="evenodd" d="M7.429 1.525a6.593 6.593 0 0 1 1.142 0c.036.003.108.036.137.146l.289 1.105c.147.56.55.967.997 1.189.174.086.341.183.501.29.417.278.97.423 1.53.27l1.102-.303c.11-.03.175.016.195.046.219.31.41.641.573.989.014.031.022.11-.059.19l-.815.806c-.411.406-.562.957-.53 1.456a4.588 4.588 0 0 1 0 .582c-.032.499.119 1.05.53 1.456l.815.806c.08.08.073.159.059.19a6.494 6.494 0 0 1-.573.99c-.02.029-.086.074-.195.045l-1.103-.303c-.559-.153-1.112-.008-1.529.27-.16.107-.327.204-.5.29-.449.222-.851.628-.998 1.189l-.289 1.105c-.029.11-.101.143-.137.146a6.613 6.613 0 0 1-1.142 0c-.036-.003-.108-.037-.137-.146l-.289-1.105c-.147-.56-.55-.967-.997-1.189a4.502 4.502 0 0 1-.501-.29c-.417-.278-.97-.423-1.53-.27l-1.102.303c-.11.03-.175-.016-.195-.046a6.492 6.492 0 0 1-.573-.989c-.014-.031-.022-.11.059-.19l.815-.806c.411-.406.562-.957.53-1.456a4.587 4.587 0 0 1 0-.582c.032-.499-.119-1.05-.53-1.456l-.815-.806c-.08-.08-.073-.159-.059-.19.162-.348.354-.68.573-.99.02-.029.086-.074.195-.045l1.103.303c.559.153 1.112.008 1.529-.27.16-.107.327-.204.5-.29.449-.222.851-.628.998-1.189l.289-1.105c.029-.11.101-.143.137-.146ZM8 0c-.236 0-.47.01-.701.03-.743.065-1.29.615-1.458 1.261l-.29 1.106c-.017.066-.078.158-.211.232a5.489 5.489 0 0 0-.594.344c-.12.08-.234.115-.327.096l-1.103-.303c-.648-.178-1.392.02-1.82.63a7.986 7.986 0 0 0-.704 1.217c-.315.675-.111 1.422.363 1.891l.815.806c.05.048.098.147.088.294a6.084 6.084 0 0 0 0 .772c.01.147-.038.246-.088.294l-.815.806c-.474.469-.678 1.216-.363 1.891.2.428.436.835.704 1.218.428.609 1.172.806 1.82.63l1.103-.303c.093-.02.207.016.327.096.185.124.38.237.594.344.133.074.194.166.211.232l.29 1.106c.167.646.714 1.196 1.457 1.26.23.02.465.031.701.031.236 0 .47-.01.701-.03.743-.065 1.29-.615 1.458-1.261l.29-1.106c.017-.066.078-.158.211-.232a5.49 5.49 0 0 0 .594-.344c.12-.08.234-.115.327-.096l1.103.303c.648.178 1.392-.02 1.82-.63.268-.383.505-.79.704-1.217.315-.675.111-1.422-.364-1.891l-.814-.806c-.05-.048-.098-.147-.088-.294a6.083 6.083 0 0 0 0-.772c-.01-.147.039-.246.088-.294l.814-.806c.475-.469.679-1.216.364-1.891a7.992 7.992 0 0 0-.704-1.218c-.428-.609-1.172-.806-1.82-.63l-1.103.303c-.093.02-.207-.016-.327-.096a5.49 5.49 0 0 0-.594-.344c-.133-.074-.194-.166-.211-.232l-.29-1.106C9.992.645 9.444.095 8.701.031A8.566 8.566 0 0 0 8 0Zm1.5 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/>
          </svg>
          Profiles &amp; Accounts
        </button>
      </div>
    `;
  }

  /**
   * The compact bar names no ref, and the repository card that would is behind
   * a collapsed-by-default panel — so a detached HEAD had nowhere to show.
   */
  private renderDetachedHead() {
    const oid = this.activeRepository?.currentBranch
      ? null
      : this.activeRepository?.repository.detachedHeadOid;
    if (!oid) return nothing;
    return html`
      <div class="compact-divider"></div>
      <span
        class="detached-head"
        title="HEAD is detached at ${oid}. New commits won't belong to any branch."
        >Detached HEAD @ ${oid.slice(0, 7)}</span
      >
    `;
  }

  private renderCompactView() {
    return html`
      <div class="dashboard-compact">
        ${this.activeProfile
          ? html`
              <div class="profile-selector">
                <button
                  class="profile-selector-btn ${this.isProfileDropdownOpen ? 'open' : ''} ${this.isApplyingProfile ? 'loading' : ''}"
                  @click=${this.toggleProfileDropdown}
                  aria-expanded="${this.isProfileDropdownOpen}"
                  aria-haspopup="listbox"
                  aria-label="Switch profile. Currently: ${this.activeProfile.name}"
                >
                  ${this.isApplyingProfile
                    ? html`<div class="loading-spinner"></div>`
                    : html`
                        <div
                          class="profile-dot"
                          style="background: ${this.activeProfile.color}"
                        ></div>
                      `}
                  <span class="profile-name">${this.activeProfile.name}</span>
                  <svg class="chevron" viewBox="0 0 16 16" fill="currentColor">
                    <path fill-rule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"/>
                  </svg>
                </button>
                ${this.isProfileDropdownOpen ? this.renderProfileDropdown() : nothing}
              </div>
              <span class="compact-identity">
                ${this.activeProfile.gitName} &lt;${this.activeProfile.gitEmail}&gt;
              </span>
            `
          : html`
              <div class="no-profile">
                <span>No profile active</span>
                <button class="no-profile-btn" @click=${this.openProfileManager}>
                  <svg viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2Z"/>
                  </svg>
                  Set up profile
                </button>
              </div>
            `}

        ${this.renderDetachedHead()}

        ${(() => {
          const provider = this.detectProvider();
          const relevantAccount = this.getRelevantAccount();

          if (relevantAccount) {
            const status = this.getAccountStatus(relevantAccount.id);
            // Use cached username if available, otherwise fall back to account name
            const displayName = relevantAccount.cachedUser?.username
              ? `${INTEGRATION_TYPE_NAMES[relevantAccount.integrationType]} (@${relevantAccount.cachedUser.username})`
              : relevantAccount.name;
            const label = `${displayName}: ${status}`;

            // Show a more prominent button when disconnected or unknown
            if (status === 'disconnected' || status === 'unknown') {
              return html`
                <div class="compact-divider"></div>
                <button
                  class="configure-btn"
                  @click=${() => this.openIntegrationDialog(relevantAccount.integrationType)}
                  title="${label}. Click to reconnect."
                >
                  <span class="account-status-dot ${status}" aria-hidden="true" style="width: 6px; height: 6px;"></span>
                  Reconnect ${INTEGRATION_TYPE_NAMES[relevantAccount.integrationType]}
                </button>
              `;
            }

            return html`
              <div class="compact-divider"></div>
              <button
                class="account-status-btn"
                @click=${() => this.openIntegrationDialog(relevantAccount.integrationType)}
                aria-label="${label}. Click to open ${INTEGRATION_TYPE_NAMES[relevantAccount.integrationType]} dialog."
                title="${label}"
              >
                <span class="account-status-dot ${status}" aria-hidden="true"></span>
              </button>
            `;
          }

          // Show configure button if provider detected but no account
          if (provider) {
            return html`
              <div class="compact-divider"></div>
              <button
                class="configure-btn"
                @click=${() => this.openIntegrationDialog(provider)}
                title="Configure ${INTEGRATION_TYPE_NAMES[provider]} integration"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                </svg>
                Connect ${INTEGRATION_TYPE_NAMES[provider]}
              </button>
            `;
          }

          return nothing;
        })()}

        <div class="remote-buttons">
          <button
            class="remote-btn ${this.remoteOperation === 'fetch' ? 'loading' : ''}"
            title=${this.remoteButtonTitle('Fetch', 'Fetch from remote')}
            @click=${this.handleFetch}
            ?disabled=${this.isRemoteOperationInProgress || !this.hasRemote}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
              <path d="M3 3v5h5"></path>
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"></path>
              <path d="M16 16h5v5"></path>
            </svg>
            Fetch
          </button>
          <div class="remote-btn-wrapper">
            <button
              class="remote-btn ${this.remoteOperation === 'pull' ? 'loading' : ''}"
              title=${this.remoteButtonTitle(
                'Pull',
                `Pull from remote${this.behind > 0 ? ` (${this.behind} commits behind)` : ''}`,
              )}
              @click=${this.handlePull}
              ?disabled=${this.isRemoteOperationInProgress || this.lock.busy || !this.hasRemote}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 3v18"></path>
                <path d="M5 16l7 7 7-7"></path>
              </svg>
              Pull
            </button>
            ${this.behind > 0 ? html`<span class="badge pull">${this.behind}</span>` : nothing}
          </div>
          <div class="remote-btn-wrapper">
            <button
              class="remote-btn ${this.remoteOperation === 'push' ? 'loading' : ''}"
              title=${this.remoteButtonTitle(
                'Push',
                `Push to remote${this.ahead > 0 ? ` (${this.ahead} commits ahead)` : ''}`,
              )}
              @click=${this.handlePush}
              ?disabled=${this.isRemoteOperationInProgress
                || isPushRunning(this.activeRepository?.repository.path)
                || !this.hasRemote}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 3v18"></path>
                <path d="M5 8l7-7 7 7"></path>
              </svg>
              Push
            </button>
            ${this.ahead > 0 ? html`<span class="badge push">${this.ahead}</span>` : nothing}
          </div>
        </div>

        <button
          class="expand-btn ${this.isExpanded ? 'expanded' : ''}"
          @click=${this.toggleExpanded}
          aria-expanded="${this.isExpanded}"
          aria-label="${this.isExpanded ? 'Collapse' : 'Expand'} repository context dashboard"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd"/>
          </svg>
        </button>
      </div>
    `;
  }

  private renderExpandedView() {
    const assignmentSource = this.getProfileAssignmentSource();
    const detectedProvider = this.detectProvider();

    return html`
      <div class="dashboard-expanded" role="region" aria-label="Repository context">
        <div class="dashboard-header">
          <div class="header-left">
            <span class="dashboard-title">Repository Context</span>
            ${this.activeProfile
              ? html`
                  <div class="profile-selector">
                    <button
                      class="profile-selector-btn ${this.isProfileDropdownOpen ? 'open' : ''} ${this.isApplyingProfile ? 'loading' : ''}"
                      @click=${this.toggleProfileDropdown}
                      aria-expanded="${this.isProfileDropdownOpen}"
                      aria-haspopup="listbox"
                      aria-label="Switch profile. Currently: ${this.activeProfile.name}"
                    >
                      ${this.isApplyingProfile
                        ? html`<div class="loading-spinner"></div>`
                        : html`
                            <div
                              class="profile-dot"
                              style="background: ${this.activeProfile.color}"
                            ></div>
                          `}
                      <span class="profile-name">${this.activeProfile.name}</span>
                      <svg class="chevron" viewBox="0 0 16 16" fill="currentColor">
                        <path fill-rule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"/>
                      </svg>
                    </button>
                    ${this.isProfileDropdownOpen ? this.renderProfileDropdown() : nothing}
                  </div>
                `
              : nothing}
          </div>
          <button
            class="expand-btn expanded"
            @click=${this.toggleExpanded}
            aria-expanded="${this.isExpanded}"
            aria-label="Collapse repository context dashboard"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path fill-rule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd"/>
            </svg>
          </button>
        </div>

        <div class="card-grid">
          <lv-profile-card
            .profile=${this.activeProfile}
            .assignmentSource=${assignmentSource}
            @edit-profile=${this.openProfileManager}
          ></lv-profile-card>

          ${this.activeRepository
            ? html`
                <lv-repository-card
                  .repository=${this.activeRepository.repository}
                  .currentBranch=${this.activeRepository.currentBranch}
                  .remotes=${this.activeRepository.remotes}
                  .assignmentSource=${assignmentSource}
                  .detectedProvider=${detectedProvider}
                ></lv-repository-card>
              `
            : nothing}

          ${(() => {
            const relevantAccount = this.getRelevantAccount();

            if (relevantAccount) {
              return html`
                <lv-integration-card
                  .account=${relevantAccount}
                  .connectionStatus=${this.getAccountStatus(relevantAccount.id)}
                  .isProfileDefault=${this.isProfileDefaultAccount(relevantAccount)}
                  .isGlobalDefault=${this.isGlobalDefaultAccount(relevantAccount)}
                  @open-dialog=${() => this.openIntegrationDialog(relevantAccount.integrationType)}
                  @refresh-account=${this.handleRefreshAccount}
                ></lv-integration-card>
              `;
            }

            // Show configure card if provider detected but no account
            if (detectedProvider) {
              return html`
                <div class="configure-card">
                  <div class="configure-card-icon">
                    ${this.getProviderIcon(detectedProvider)}
                  </div>
                  <div class="configure-card-content">
                    <div class="configure-card-title">${INTEGRATION_TYPE_NAMES[detectedProvider]} not connected</div>
                    <div class="configure-card-description">
                      Connect your ${INTEGRATION_TYPE_NAMES[detectedProvider]} account to enable pull requests, pipelines, and more.
                    </div>
                  </div>
                  <button class="configure-card-btn" @click=${() => this.openIntegrationDialog(detectedProvider)}>
                    Connect
                  </button>
                </div>
              `;
            }

            return nothing;
          })()}
        </div>
      </div>
    `;
  }

  render() {
    if (!this.activeRepository) {
      return nothing;
    }

    return this.isExpanded ? this.renderExpandedView() : this.renderCompactView();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-context-dashboard': LvContextDashboard;
  }
}
