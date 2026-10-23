/**
 * Profile Manager Dialog Component
 * Full CRUD interface for managing unified profiles (git identity + integration accounts)
 */

import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { unifiedProfileStore, type AccountConnectionStatus, type ConnectionStatus } from '../../stores/unified-profile.store.ts';
import { repositoryStore, type RecentRepository } from '../../stores/repository.store.ts';
import * as unifiedProfileService from '../../services/unified-profile.service.ts';
import * as credentialService from '../../services/credential.service.ts';
import type { UnifiedProfile, IntegrationAccount, IntegrationType, IntegrationConfig, IntegrationOpenContext, MigrationBackupInfo } from '../../types/unified-profile.types.ts';
import { PROFILE_COLORS, ACCOUNT_COLORS, INTEGRATION_TYPE_NAMES } from '../../types/unified-profile.types.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import { showToast } from '../../services/notification.service.ts';
import { pushOverlay, removeOverlay, isTopOverlay } from '../../utils/overlay-stack.ts';

type ViewMode = 'list' | 'edit' | 'create' | 'select-account' | 'edit-account' | 'assign-repos' | 'accounts';

@customElement('gn-profile-manager-dialog')
export class GnProfileManagerDialog extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .dialog-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: var(--z-modal);
      }

      /* Sit behind a stacked dialog (e.g. an integration dialog opened from the
         picker); the dialog on top provides the backdrop. */
      :host([demoted]) .dialog-overlay {
        z-index: calc(var(--z-modal) - 1);
        background: transparent;
      }

      .dialog {
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        width: 650px;
        max-height: 85vh;
        display: flex;
        flex-direction: column;
        box-shadow: var(--shadow-xl);
      }

      .dialog-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-md);
        border-bottom: 1px solid var(--color-border);
      }

      .dialog-title {
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-semibold);
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      /* Breadcrumb shown in the attach picker so the user always knows which
         profile a connected account will be attached to. */
      .attach-breadcrumb {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-md);
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-sm);
      }

      .attach-breadcrumb strong {
        color: var(--color-text-primary);
      }

      .dialog-content {
        flex: 1;
        overflow-y: auto;
        padding: var(--spacing-md);
      }

      .view-explainer {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        margin: 0 0 var(--spacing-md) 0;
        line-height: 1.4;
      }

      .dialog-footer {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-md);
        border-top: 1px solid var(--color-border);
      }

      .btn-danger {
        background: var(--color-error);
        color: var(--color-text-inverse);
      }

      .btn-danger:hover:not(:disabled) {
        filter: brightness(0.92);
      }

      .close-btn {
        background: none;
        border: none;
        padding: var(--spacing-xs);
        cursor: pointer;
        color: var(--color-text-secondary);
        border-radius: var(--radius-sm);
      }

      .close-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
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

      .btn-sm {
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: var(--font-size-xs);
      }

      /* Profile list */
      .profile-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .profile-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        padding: var(--spacing-md);
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .profile-item:hover {
        background: var(--color-bg-hover);
        border-color: var(--color-accent);
      }

      .profile-color {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .profile-info {
        flex: 1;
        min-width: 0;
      }

      .profile-name {
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .default-badge {
        font-size: var(--font-size-xs);
        padding: 2px 6px;
        background: var(--color-accent-bg);
        color: var(--color-accent);
        border-radius: var(--radius-xs);
      }

      .profile-email {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .profile-meta {
        font-size: var(--font-size-xs);
        color: var(--color-text-tertiary);
        margin-top: 2px;
        display: flex;
        gap: var(--spacing-sm);
      }

      .profile-actions {
        display: flex;
        gap: var(--spacing-xs);
      }

      .action-btn {
        padding: var(--spacing-xs);
        background: none;
        border: none;
        cursor: pointer;
        color: var(--color-text-secondary);
        border-radius: var(--radius-sm);
      }

      .action-btn:hover {
        background: var(--color-bg-tertiary);
        color: var(--color-text-primary);
      }

      .action-btn.delete:hover {
        color: var(--color-error);
      }

      /* Empty state */
      .empty-state {
        text-align: center;
        padding: var(--spacing-xl);
        color: var(--color-text-secondary);
      }

      .empty-state svg {
        width: 48px;
        height: 48px;
        margin-bottom: var(--spacing-md);
        opacity: 0.5;
      }

      /* Form */
      .form-section {
        margin-bottom: var(--spacing-lg);
      }

      .form-section-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
        margin-bottom: var(--spacing-sm);
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .form-group {
        margin-bottom: var(--spacing-md);
      }

      .form-group label {
        display: block;
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-xs);
      }

      .form-group input,
      .form-group textarea,
      .form-group select {
        width: 100%;
        padding: var(--spacing-sm);
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
      }

      .form-group input:focus,
      .form-group textarea:focus,
      .form-group select:focus {
        outline: none;
        border-color: var(--color-accent);
      }

      .form-group textarea {
        min-height: 60px;
        resize: vertical;
        font-family: var(--font-mono);
      }

      .form-hint {
        font-size: var(--font-size-xs);
        color: var(--color-text-tertiary);
        margin-top: var(--spacing-xs);
      }

      .attach-hint {
        flex: 1;
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        font-size: var(--font-size-xs);
        color: var(--color-warning, var(--color-text-secondary));
      }

      .btn-emphasized {
        box-shadow: 0 0 0 2px var(--color-primary);
      }

      .form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--spacing-md);
      }

      /* Color picker */
      .color-picker {
        display: flex;
        gap: var(--spacing-xs);
        flex-wrap: wrap;
      }

      .color-option {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .color-option:hover {
        transform: scale(1.1);
      }

      .color-option.selected {
        border-color: var(--color-text-primary);
      }

      /* Checkbox */
      .checkbox-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) 0;
      }

      .checkbox-row input[type="checkbox"] {
        width: 16px;
        height: 16px;
        accent-color: var(--color-accent);
      }

      .checkbox-row label {
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
        cursor: pointer;
      }

      /* Header with back button */
      .header-with-back {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .back-btn {
        padding: var(--spacing-xs);
        background: none;
        border: none;
        cursor: pointer;
        color: var(--color-text-secondary);
        border-radius: var(--radius-sm);
      }

      .back-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      /* Accounts section */
      .accounts-section {
        margin-top: var(--spacing-md);
        padding-top: var(--spacing-md);
        border-top: 1px solid var(--color-border);
      }

      .accounts-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--spacing-sm);
      }

      .accounts-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .account-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
      }

      .account-item:hover {
        background: var(--color-bg-hover);
      }

      .account-item.selectable {
        cursor: pointer;
      }

      .account-item.selectable input[type="checkbox"] {
        width: 16px;
        height: 16px;
        margin: 0;
        cursor: pointer;
      }

      .account-item.selectable.selected {
        background: var(--color-accent-bg);
        border-color: var(--color-accent);
      }

      .account-icon {
        width: 20px;
        height: 20px;
        flex-shrink: 0;
      }

      .account-info {
        flex: 1;
        min-width: 0;
      }

      .account-name {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .account-detail {
        font-size: var(--font-size-xs);
        color: var(--color-text-tertiary);
      }

      .account-actions {
        display: flex;
        gap: var(--spacing-xs);
      }

      .empty-accounts {
        text-align: center;
        padding: var(--spacing-md);
        color: var(--color-text-tertiary);
        font-size: var(--font-size-sm);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-sm);
      }

      .empty-accounts.warning {
        background: rgba(245, 158, 11, 0.1);
        border: 1px solid rgba(245, 158, 11, 0.3);
        color: var(--color-text-secondary);
      }

      .empty-accounts.warning svg {
        color: rgb(245, 158, 11);
      }

      .type-badge {
        font-size: 10px;
        padding: 1px 4px;
        background: var(--color-bg-secondary);
        border-radius: var(--radius-xs);
        color: var(--color-text-tertiary);
        text-transform: uppercase;
      }

      /* Connection status indicators */
      .status-indicator {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .status-indicator.connected {
        background: var(--color-success, #22c55e);
      }

      .status-indicator.disconnected {
        background: var(--color-error, #ef4444);
      }

      .status-indicator.checking {
        background: var(--color-warning, #f59e0b);
        animation: pulse 1s ease-in-out infinite;
      }

      .status-indicator.unknown {
        background: var(--color-text-tertiary);
        opacity: 0.5;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }

      /* Backup section */
      .backup-section {
        margin-top: var(--spacing-lg);
        padding-top: var(--spacing-md);
        border-top: 1px solid var(--color-border);
      }

      .backup-toggle {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: var(--spacing-sm);
        background: none;
        border: none;
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        cursor: pointer;
        width: 100%;
        text-align: left;
      }

      .backup-toggle:hover {
        color: var(--color-text-primary);
      }

      .backup-toggle svg {
        transition: transform 0.2s;
      }

      .backup-toggle.expanded svg {
        transform: rotate(90deg);
      }

      .backup-content {
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        padding: var(--spacing-md);
        margin-top: var(--spacing-sm);
      }

      .backup-info {
        margin-bottom: var(--spacing-md);
      }

      .backup-info-row {
        display: flex;
        justify-content: space-between;
        font-size: var(--font-size-sm);
        margin-bottom: var(--spacing-xs);
      }

      .backup-info-label {
        color: var(--color-text-tertiary);
      }

      .backup-actions {
        display: flex;
        gap: var(--spacing-sm);
      }

      .btn-warning {
        background: var(--color-warning-bg);
        border-color: var(--color-warning);
        color: var(--color-warning);
      }

      .btn-warning:hover:not(:disabled) {
        background: var(--color-warning);
        color: white;
      }
    `,
  ];

  @property({ type: Boolean }) open = false;
  @property({ type: String }) repoPath = '';
  /**
   * When true, render behind another modal (e.g. an integration dialog opened
   * from the account picker). The profile manager stays mounted and open so that
   * closing the dialog stacked on top reveals it again, right where the user left
   * off — no fragile "return" state to lose across an auth round trip.
   */
  @property({ type: Boolean, reflect: true }) demoted = false;
  /**
   * When the dialog is opened to manage integration accounts (e.g. via the
   * "Manage Accounts" action in an integration dialog), the host sets this to
   * 'accounts' so we land on the account-management view instead of the profile
   * list. Cleared by the host on close.
   */
  @property({ type: String }) initialView: '' | 'accounts' = '';

  @state() private viewMode: ViewMode = 'list';
  @state() private profiles: UnifiedProfile[] = [];
  @state() private repositoryAssignments: Record<string, string> = {};
  @state() private accountConnectionStatus: Record<string, AccountConnectionStatus> = {};
  @state() private editingProfile: Partial<UnifiedProfile> | null = null;
  @state() private editingAccount: Partial<IntegrationAccount> | null = null;
  @state() private isLoading = false;
  @state() private isSaving = false;
  @state() private recentRepositories: RecentRepository[] = [];
  @state() private selectedReposForAssignment: Set<string> = new Set();
  @state() private backupInfo: MigrationBackupInfo | null = null;
  @state() private showBackupSection = false;
  @state() private isRestoringBackup = false;
  // Tracks unsaved edits so we can warn before discarding them (back/close).
  @state() private profileFormDirty = false;
  @state() private accountFormDirty = false;
  // Name of an account just connected+attached via revealAfterConnect. Drives an
  // inline "Save Profile to keep <account> attached" hint so the user doesn't
  // assume the freshly-connected account is already persisted on the profile.
  @state() private justAttachedAccountName: string | null = null;
  // Where the account edit form should return to (it can be reached from the
  // profile form or from the standalone Accounts view).
  private accountReturnView: ViewMode = 'edit';
  private accountsReturnView: ViewMode | null = null;

  private unsubscribeStore?: () => void;
  private unsubscribeRepoStore?: () => void;

  // When the user picks "Connect a new account" for a provider in the picker, we
  // snapshot the account ids that existed beforehand, so revealAfterConnect() can
  // identify the one they just connected and attach it to the target profile.
  private accountIdsBeforeConnect: Set<string> = new Set();

  connectedCallback(): void {
    super.connectedCallback();
    // Get initial state from unified profile store
    const initialState = unifiedProfileStore.getState();
    this.profiles = initialState.profiles;
    this.repositoryAssignments = initialState.config?.repositoryAssignments ?? {};
    this.accountConnectionStatus = initialState.accountConnectionStatus;
    this.isLoading = initialState.isLoading;

    // Get initial state from repository store
    this.recentRepositories = repositoryStore.getState().recentRepositories;

    // Subscribe to store changes
    this.unsubscribeStore = unifiedProfileStore.subscribe((state) => {
      this.profiles = state.profiles;
      this.repositoryAssignments = state.config?.repositoryAssignments ?? {};
      this.accountConnectionStatus = state.accountConnectionStatus;
      this.isLoading = state.isLoading;
    });

    // Subscribe to repository store for recent repos
    this.unsubscribeRepoStore = repositoryStore.subscribe((state) => {
      this.recentRepositories = state.recentRepositories;
    });

    // Escape closes the dialog (or backs out of a sub-view).
    window.addEventListener('keydown', this.handleKeyDown, true);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    removeOverlay(this);
    this.unsubscribeStore?.();
    this.unsubscribeRepoStore?.();
    window.removeEventListener('keydown', this.handleKeyDown, true);
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    // Use the reflected attribute as the source of truth — the `open` property
    // is set via `?open=${...}` from the parent and reliably reflects there.
    const isOpen = this.hasAttribute('open');
    if (!isOpen || this.demoted) return;
    // window + capture runs before EVERY document listener in the app, and
    // this handler stopPropagation()s — so opening the command palette over
    // this dialog and pressing Escape closed the dialog underneath while the
    // palette, the actual topmost overlay, kept ignoring the key.
    if (!isTopOverlay(this)) return;
    e.preventDefault();
    e.stopPropagation();
    if (this.viewMode === 'list') {
      this.handleClose();
    } else {
      this.handleBack();
    }
  };

  willUpdate(changedProperties: Map<string, unknown>): void {
    // Announce/withdraw overlay ownership of Escape.
    if (changedProperties.has('open')) {
      if (this.open) { pushOverlay(this); } else { removeOverlay(this); }
    }
    // Land on the requested view before render so opening doesn't flash the
    // list view first (and avoids a redundant update if set in updated()).
    if (changedProperties.has('open') && this.open) {
      this.viewMode = this.initialView === 'accounts' ? 'accounts' : 'list';
    }
  }

  updated(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has('open') && this.open) {
      // Fresh open: load data, then verify connection status for accurate dots.
      void this.loadProfiles().then(() => this.refreshConnectionStatuses());
    }
    // NOTE: revealing-after-connect is now driven EXPLICITLY by the host calling
    // revealAfterConnect(context) when the stacked provider dialog closes — not by
    // inferring intent from a `demoted` flip. The `demoted` property remains purely
    // a visual signal (render behind the stacked dialog).
  }

  private async loadProfiles(): Promise<void> {
    await unifiedProfileService.loadUnifiedProfiles();
    // Also load backup info
    await this.loadBackupInfo();
  }

  /**
   * Kick off a background connection check for every global account so the status
   * indicator dots are accurate on a fresh open (e.g. after app restart the store
   * status is 'unknown'). NOT called when revealing after connecting an account —
   * the integration dialog already wrote the authoritative status, and re-checking
   * here would clobber it.
   */
  private refreshConnectionStatuses(): void {
    for (const account of this.getGlobalAccounts()) {
      void unifiedProfileService.refreshAccountCachedUser(account);
    }
  }

  private async loadBackupInfo(): Promise<void> {
    try {
      this.backupInfo = await unifiedProfileService.getMigrationBackupInfo();
    } catch {
      // Ignore errors - backup info is optional
      this.backupInfo = null;
    }
  }

  private async handleRestoreBackup(): Promise<void> {
    const confirmed = await showConfirm(
      'Restore Backup',
      'Are you sure you want to restore from backup? This will remove your current unified profiles and restore the pre-migration data. You will need to run migration again.',
      'warning'
    );
    if (!confirmed) {
      return;
    }
    this.isRestoringBackup = true;
    try {
      const result = await unifiedProfileService.restoreMigrationBackup();
      showToast(
        `Restored ${result.profilesCount ?? 0} profiles and ${result.accountsCount ?? 0} accounts from backup`,
        'success'
      );
      // D4: Dispatch `migration-needed` BEFORE closing so the parent can open
      // the migration dialog as this one closes, avoiding a close-then-reopen
      // flicker in the transition.
      this.dispatchEvent(
        new CustomEvent('migration-needed', {
          bubbles: true,
          composed: true,
        })
      );
      this.handleClose();
    } catch (error) {
      showToast(
        `Failed to restore backup: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'error'
      );
    } finally {
      this.isRestoringBackup = false;
    }
  }

  private async handleDeleteBackup(): Promise<void> {
    const confirmed = await showConfirm(
      'Delete Backup',
      'Are you sure you want to delete the migration backup? This action cannot be undone.',
      'warning'
    );
    if (!confirmed) {
      return;
    }
    try {
      await unifiedProfileService.deleteMigrationBackup();
      showToast('Migration backup deleted', 'success');
      this.backupInfo = null;
      this.showBackupSection = false;
    } catch (error) {
      showToast(
        `Failed to delete backup: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'error'
      );
    }
  }

  /**
   * Whether there are unsaved edits to a profile or account form. Used to warn
   * before the whole dialog is dismissed (X / overlay / Escape). The explicit
   * Cancel/Back controls intentionally discard without prompting.
   */
  private isFormDirty(): boolean {
    return (
      (this.profileFormDirty && !!this.editingProfile) ||
      (this.accountFormDirty && !!this.editingAccount)
    );
  }

  private handleClose(): void {
    if (this.isFormDirty()) {
      void showConfirm(
        'Discard changes?',
        'You have unsaved changes. Are you sure you want to discard them?',
        'warning'
      ).then((confirmed) => {
        if (confirmed) this.performClose();
      });
      return;
    }
    this.performClose();
  }

  private performClose(): void {
    // Capture the view we are closing FROM before resetting, so the host can make
    // reversible-navigation decisions (e.g. return to the provider dialog only
    // when closing out of the Accounts view).
    const fromView = this.viewMode;
    this.open = false;
    this.viewMode = 'list';
    this.editingProfile = null;
    this.editingAccount = null;
    this.profileFormDirty = false;
    this.accountFormDirty = false;
    // Drop any in-flight "connect a new account" snapshot so it can't auto-attach
    // to an unrelated profile the next time the dialog is revealed.
    this.accountIdsBeforeConnect = new Set();
    this.dispatchEvent(new CustomEvent('close', { detail: { fromView } }));
  }

  private handleCreateNew(): void {
    this.editingProfile = {
      name: '',
      gitName: '',
      gitEmail: '',
      signingKey: null,
      urlPatterns: [],
      isDefault: false,
      color: PROFILE_COLORS[0],
      defaultAccounts: {},
    };
    this.profileFormDirty = false;
    this.viewMode = 'create';
  }

  private handleEdit(profile: UnifiedProfile): void {
    this.editingProfile = { ...profile, defaultAccounts: { ...profile.defaultAccounts } };
    this.profileFormDirty = false;
    this.viewMode = 'edit';
  }

  private handleDuplicate(profile: UnifiedProfile, e: Event): void {
    e.stopPropagation();
    // Create a copy of the profile with a new ID and name
    this.editingProfile = {
      ...profile,
      id: undefined, // Will be generated on save
      name: `${profile.name} (Copy)`,
      isDefault: false, // Don't copy default status
      defaultAccounts: { ...profile.defaultAccounts }, // Copy default account preferences
    };
    this.profileFormDirty = false;
    this.viewMode = 'create';
  }

  private handleBack(): void {
    switch (this.viewMode) {
      case 'select-account':
        this.viewMode = this.editingProfile?.id ? 'edit' : 'create';
        this.editingAccount = null;
        break;
      case 'edit-account':
        this.viewMode = this.accountReturnView;
        this.editingAccount = null;
        this.accountFormDirty = false;
        break;
      case 'assign-repos':
        this.viewMode = 'edit';
        this.selectedReposForAssignment = new Set();
        break;
      case 'accounts':
        if (this.accountsReturnView) {
          this.viewMode = this.accountsReturnView;
          this.accountsReturnView = null;
          this.dispatchEvent(new CustomEvent('request-restore-provider', { bubbles: true, composed: true }));
        } else if (this.initialView === 'accounts') {
          this.handleClose();
        } else {
          this.viewMode = 'list';
        }
        break;
      default:
        // create / edit
        this.viewMode = 'list';
        this.editingProfile = null;
        this.profileFormDirty = false;
        this.justAttachedAccountName = null;
    }
  }

  private handleOpenRepoAssignment(): void {
    this.selectedReposForAssignment = new Set();
    this.viewMode = 'assign-repos';
  }

  private toggleRepoSelection(path: string): void {
    const newSet = new Set(this.selectedReposForAssignment);
    if (newSet.has(path)) {
      newSet.delete(path);
    } else {
      newSet.add(path);
    }
    this.selectedReposForAssignment = newSet;
  }

  private async handleBulkAssign(): Promise<void> {
    if (!this.editingProfile?.id || this.selectedReposForAssignment.size === 0) return;

    this.isSaving = true;
    const profileId = this.editingProfile.id;
    let successCount = 0;
    const failedRepos: string[] = [];

    try {
      for (const repoPath of this.selectedReposForAssignment) {
        try {
          await unifiedProfileService.assignUnifiedProfileToRepository(repoPath, profileId);
          successCount++;
        } catch {
          failedRepos.push(repoPath);
        }
      }

      // Reload profiles to update repositoryAssignments in the store
      await unifiedProfileService.loadUnifiedProfiles();

      if (failedRepos.length === 0) {
        showToast(`Assigned ${successCount} ${successCount === 1 ? 'repository' : 'repositories'}`, 'success');
        // Only clear selection and leave the view on full success.
        this.selectedReposForAssignment = new Set();
        this.viewMode = 'edit';
      } else {
        // D11: On partial failure, keep the FAILED repos selected so the user can
        // retry, and name them in the feedback instead of showing only a count.
        const names = failedRepos
          .map((p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p)
          .join(', ');
        showToast(
          `Assigned ${successCount}, failed ${failedRepos.length}: ${names}`,
          'warning'
        );
        this.selectedReposForAssignment = new Set(failedRepos);
      }
    } catch (error) {
      showToast(`Failed to assign repositories: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      this.isSaving = false;
    }
  }

  /**
   * Unassign a single repository from the profile being edited. The global
   * accounts and the profile itself are untouched — only the repo→profile
   * assignment is removed. The store subscription re-renders the trimmed list.
   *
   * D5: No change event dispatched here by design — see handleSave. The store
   * subscription is the single source of truth for UI sync.
   */
  private async handleUnassignRepository(repoPath: string): Promise<void> {
    try {
      await unifiedProfileService.unassignUnifiedProfileFromRepository(repoPath);
      // Reload profiles to update repositoryAssignments in the store.
      await unifiedProfileService.loadUnifiedProfiles();
      showToast(`Unassigned ${this.formatRepoPath(repoPath)}`, 'success');
    } catch (error) {
      showToast(
        `Failed to unassign repository: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'error'
      );
    }
  }

  // D5: No change event dispatched here by design — see handleSave. The store
  // subscription is the single source of truth for UI sync.
  private async handleDelete(profile: UnifiedProfile, e: Event): Promise<void> {
    e.stopPropagation();
    const confirmed = await showConfirm(
      'Delete Profile',
      `Delete profile "${profile.name}"? This removes the profile and its repository assignments. Your integration accounts remain available globally.`,
      'warning'
    );
    if (!confirmed) {
      return;
    }

    try {
      await unifiedProfileService.deleteUnifiedProfile(profile.id);
      showToast('Profile deleted', 'success');
    } catch (error) {
      showToast(`Failed to delete profile: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    }
  }

  private async handleApply(profile: UnifiedProfile, e: Event): Promise<void> {
    e.stopPropagation();
    if (!this.repoPath) {
      showToast('No repository open', 'error');
      return;
    }

    try {
      await unifiedProfileService.applyUnifiedProfile(this.repoPath, profile.id);
      showToast(`Applied profile "${profile.name}"`, 'success');
      // Applying a profile rewrites the repo's local git identity/signing
      // config. Refresh so listeners re-read it now (e.g. the commit panel
      // reloads the author used for the {{author}} template placeholder)
      // instead of only after the tab is re-switched.
      window.dispatchEvent(new CustomEvent('repository-refresh'));
    } catch (error) {
      showToast(`Failed to apply profile: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    }
  }

  private updateEditingProfile(field: keyof UnifiedProfile, value: unknown): void {
    if (this.editingProfile) {
      this.editingProfile = { ...this.editingProfile, [field]: value };
      this.profileFormDirty = true;
    }
  }

  // D5: This and its sibling mutators (handleSaveAccount, handleDelete,
  // handleDeleteGlobalAccount) intentionally dispatch NO profile-change event.
  // The Zustand unified-profile store subscription is the single source of truth
  // for UI sync — these handlers call unifiedProfileService.* which updates the
  // store, and subscribed components re-render. Do NOT add a profile-change
  // CustomEvent here: there is no parent listener for it, so it would be an
  // orphan event (CLAUDE.md "Event Dispatch Consistency"). The window-level
  // `repository-refresh` below is a different thing: saving rewrites the open
  // repository's .git/config, and app-shell listens for that event (same as
  // handleApply).
  private async handleSave(): Promise<void> {
    if (!this.editingProfile) return;

    // Validation
    if (!this.editingProfile.name?.trim()) {
      showToast('Profile name is required', 'error');
      return;
    }
    if (!this.editingProfile.gitName?.trim()) {
      showToast('Git name is required', 'error');
      return;
    }
    if (!this.editingProfile.gitEmail?.trim()) {
      showToast('Git email is required', 'error');
      return;
    }

    this.isSaving = true;

    const profile: UnifiedProfile = {
      id: this.editingProfile.id ?? crypto.randomUUID(),
      name: this.editingProfile.name.trim(),
      gitName: this.editingProfile.gitName.trim(),
      gitEmail: this.editingProfile.gitEmail.trim(),
      signingKey: this.editingProfile.signingKey?.trim() || null,
      urlPatterns: this.editingProfile.urlPatterns ?? [],
      isDefault: this.editingProfile.isDefault ?? false,
      color: this.editingProfile.color ?? PROFILE_COLORS[0],
      defaultAccounts: this.editingProfile.defaultAccounts ?? {},
    };

    try {
      const wasCreate = this.viewMode === 'create';
      const { failedRepositories } = await unifiedProfileService.saveUnifiedProfile(profile);
      if (failedRepositories.length > 0) {
        // Saving rewrites the git identity of every repository assigned to this
        // profile. Name the ones that kept the old identity instead of showing a
        // bare "saved" — they are still committing and signing as the profile
        // was before this edit.
        const names = failedRepositories.map((p) => this.formatRepoPath(p)).join(', ');
        showToast(
          `Profile saved, but ${failedRepositories.length} ${failedRepositories.length === 1 ? 'repository' : 'repositories'} kept the old identity: ${names}`,
          'warning'
        );
      } else {
        showToast(wasCreate ? 'Profile created' : 'Profile saved', 'success');
      }
      // After creating a new profile, re-evaluate which profile applies to the
      // current repo. Without this, a freshly-created default profile sits in
      // the list but never becomes active until the user manually applies it.
      if (this.repoPath) {
        await unifiedProfileService.loadUnifiedProfileForRepository(this.repoPath);
        // If the open repo is assigned to the profile just saved, its
        // .git/config was rewritten by the save — refresh so listeners re-read
        // the identity now (same reason handleApply refreshes).
        if (this.repositoryAssignments[this.repoPath] === profile.id) {
          window.dispatchEvent(new CustomEvent('repository-refresh'));
        }
      }
      // Changes are persisted — clear the dirty flag so navigating back doesn't
      // prompt to discard.
      this.profileFormDirty = false;
      this.justAttachedAccountName = null;
      this.handleBack();
    } catch (error) {
      showToast(`Failed to save profile: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      this.isSaving = false;
    }
  }

  private handlePatternsChange(e: Event): void {
    const textarea = e.target as HTMLTextAreaElement;
    const patterns = textarea.value
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p);
    this.updateEditingProfile('urlPatterns', patterns);
  }

  /**
   * Get all global accounts from the store
   */
  private getGlobalAccounts(): IntegrationAccount[] {
    return unifiedProfileStore.getState().accounts;
  }

  /**
   * Accounts attached to the profile being edited, resolved from the profile's
   * defaultAccounts map to concrete global account objects. Dangling ids (whose
   * global account no longer exists) are filtered out defensively, since
   * editingProfile is a local snapshot taken in handleEdit.
   */
  private getAttachedAccounts(): Array<{ type: IntegrationType; account: IntegrationAccount }> {
    const map = this.editingProfile?.defaultAccounts ?? {};
    const globals = this.getGlobalAccounts();
    return Object.entries(map)
      .map(([type, id]) => ({
        type: type as IntegrationType,
        account: globals.find((a) => a.id === id),
      }))
      .filter((entry): entry is { type: IntegrationType; account: IntegrationAccount } =>
        Boolean(entry.account)
      );
  }

  private setEditingProfileAccount(type: IntegrationType, accountId: string): void {
    if (!this.editingProfile) return;
    this.editingProfile = {
      ...this.editingProfile,
      defaultAccounts: { ...this.editingProfile.defaultAccounts, [type]: accountId },
    };
    this.profileFormDirty = true;
  }

  private removeEditingProfileAccount(type: IntegrationType): void {
    if (!this.editingProfile) return;
    const defaultAccounts = { ...this.editingProfile.defaultAccounts };
    delete defaultAccounts[type];
    this.editingProfile = { ...this.editingProfile, defaultAccounts };
    this.profileFormDirty = true;
  }

  // Account management - attaches existing global accounts to the profile
  private handleOpenAccountPicker(): void {
    this.viewMode = 'select-account';
  }

  // Opens the standalone account-management view (edit/delete/connect global
  // accounts independent of any profile).
  private handleOpenAccountsManager(): void {
    this.viewMode = 'accounts';
  }

  /**
   * Attach an existing global account to the profile being edited. Because a
   * profile holds at most one account per provider type, this replaces any
   * account already attached for the same type. Persisted on "Save Profile".
   */
  private handleAttachAccount(account: IntegrationAccount): void {
    const previous = this.editingProfile?.defaultAccounts?.[account.integrationType];
    this.setEditingProfileAccount(account.integrationType, account.id);
    if (previous && previous !== account.id) {
      showToast(
        `Replaced the previously attached ${INTEGRATION_TYPE_NAMES[account.integrationType]} account`,
        'info'
      );
    }
    this.viewMode = this.editingProfile?.id ? 'edit' : 'create';
  }

  /**
   * Detach an account from the profile being edited (local only; the global
   * account is kept). Persisted on "Save Profile".
   */
  private handleDetachAccount(type: IntegrationType): void {
    this.removeEditingProfileAccount(type);
  }

  private handleEditAccount(account: IntegrationAccount): void {
    this.editingAccount = { ...account };
    this.accountFormDirty = false;
    // Remember where to return: the standalone Accounts view, or the profile form.
    this.accountReturnView =
      this.viewMode === 'accounts' ? 'accounts' : this.editingProfile?.id ? 'edit' : 'create';
    this.viewMode = 'edit-account';
  }

  /**
   * Delete a global account entirely (for all profiles). Reachable only from the
   * account's Edit screen because it is destructive and irreversible.
   *
   * D5: No change event dispatched here by design — see handleSave. The store
   * subscription is the single source of truth for UI sync.
   */
  private async handleDeleteGlobalAccount(accountId: string): Promise<void> {
    const confirmed = await showConfirm(
      'Delete Account',
      'Delete this account? This will remove the account for all profiles.',
      'warning'
    );
    if (!confirmed) return;

    // Resolve the integration type so we can clean up the keyring token too.
    // Prefer the stored account record; fall back to the editing snapshot.
    const integrationType =
      this.getGlobalAccounts().find((a) => a.id === accountId)?.integrationType ??
      (this.editingAccount?.id === accountId ? this.editingAccount.integrationType : undefined);

    try {
      // Delete the record first (source of truth), then best-effort delete the
      // keyring token (and its _oauth companion) so it isn't left orphaned.
      await unifiedProfileService.deleteGlobalAccount(accountId);
      if (integrationType) {
        // Best-effort: the record is already gone, so a keyring miss/failure
        // must NOT surface as "Failed to delete account". Mirror the provider
        // dialogs, which isolate token cleanup in its own try/catch.
        try {
          await credentialService.deleteAccountToken(integrationType, accountId);
        } catch (tokenError) {
          console.warn('Failed to delete account token (record already removed):', tokenError);
        }
      }
      // The editing profile is a local snapshot - drop the deleted account from it too.
      const attachedType = Object.entries(this.editingProfile?.defaultAccounts ?? {}).find(
        ([, id]) => id === accountId
      )?.[0] as IntegrationType | undefined;
      if (attachedType) {
        this.removeEditingProfileAccount(attachedType);
      }
      showToast('Account deleted', 'success');
      // Deletion is intentional — skip the unsaved-changes guard and return to
      // wherever the edit form was opened from. When deleting from the Accounts
      // view, stay there; the store subscription re-renders the trimmed list.
      this.editingAccount = null;
      this.accountFormDirty = false;
      if (this.viewMode === 'edit-account') {
        this.viewMode = this.accountReturnView;
      }
    } catch (error) {
      showToast(`Failed to delete account: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    }
  }

  private updateEditingAccount(field: keyof IntegrationAccount, value: unknown): void {
    if (this.editingAccount) {
      this.editingAccount = { ...this.editingAccount, [field]: value };
      this.accountFormDirty = true;
    }
  }

  private handleAccountPatternsChange(e: Event): void {
    const textarea = e.target as HTMLTextAreaElement;
    const patterns = textarea.value
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p);
    this.updateEditingAccount('urlPatterns', patterns);
  }

  // D5: No change event dispatched here by design — see handleSave. The store
  // subscription is the single source of truth for UI sync; adding a parent-less
  // CustomEvent would be an orphan event.
  private async handleSaveAccount(): Promise<void> {
    if (!this.editingAccount) return;

    // Validation
    if (!this.editingAccount.name?.trim()) {
      showToast('Account name is required', 'error');
      return;
    }

    const integrationType = this.editingAccount.integrationType ?? 'github';
    const account: IntegrationAccount = {
      id: this.editingAccount.id ?? crypto.randomUUID(),
      name: this.editingAccount.name.trim(),
      integrationType,
      config: this.editingAccount.config ?? this.getDefaultConfigForType(integrationType),
      color: this.editingAccount.color ?? null,
      cachedUser: this.editingAccount.cachedUser ?? null,
      urlPatterns: this.editingAccount.urlPatterns ?? [],
      isDefault: this.editingAccount.isDefault ?? false,
    };

    try {
      // Save to global accounts
      await unifiedProfileService.saveGlobalAccount(account);
      showToast('Account saved', 'success');
      // Persisted — clear the dirty flag so navigating back doesn't prompt.
      this.accountFormDirty = false;
      this.handleBack();
    } catch (error) {
      showToast(`Failed to save account: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    }
  }

  render() {
    if (!this.open) return nothing;

    return html`
      <div class="dialog-overlay" @click=${(e: Event) => e.target === e.currentTarget && this.handleClose()}>
        <div class="dialog">
          <div class="dialog-header">
            <div class="dialog-title">
              ${this.viewMode !== 'list'
                ? html`
                    <button class="back-btn" @click=${this.handleBack} title="Back">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="15 18 9 12 15 6"></polyline>
                      </svg>
                    </button>
                  `
                : nothing}
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                <circle cx="12" cy="7" r="4"></circle>
              </svg>
              ${this.getDialogTitle()}
            </div>
            <button class="close-btn" @click=${this.handleClose}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <div class="dialog-content">
            ${this.renderContent()}
          </div>
          <div class="dialog-footer">
            ${this.renderFooter()}
          </div>
        </div>
      </div>
    `;
  }

  private getDialogTitle(): string {
    switch (this.viewMode) {
      case 'list':
        return 'Profiles & Accounts';
      case 'create':
        return 'New Profile';
      case 'edit':
        return 'Edit Profile';
      case 'select-account':
        return 'Attach Account';
      case 'edit-account':
        return 'Edit Account';
      case 'assign-repos':
        return 'Assign Repositories';
      case 'accounts':
        return 'Accounts';
      default:
        return 'Profiles & Accounts';
    }
  }

  private renderContent() {
    switch (this.viewMode) {
      case 'list':
        return this.renderProfileList();
      case 'create':
      case 'edit':
        return this.renderProfileForm();
      case 'select-account':
        return this.renderAccountPicker();
      case 'edit-account':
        return this.renderAccountForm();
      case 'assign-repos':
        return this.renderRepoAssignment();
      case 'accounts':
        return this.renderAccountsManager();
      default:
        return nothing;
    }
  }

  private renderFooter() {
    switch (this.viewMode) {
      case 'list':
        return html`
          <button class="btn btn-secondary" @click=${this.handleOpenAccountsManager}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
              <circle cx="9" cy="7" r="4"></circle>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
            </svg>
            Accounts
          </button>
          <div style="flex: 1;"></div>
          <button class="btn btn-primary" @click=${this.handleCreateNew}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            New Profile
          </button>
        `;
      case 'accounts':
        return html`
          <button class="btn btn-secondary" @click=${this.handleBack}>Back</button>
        `;
      case 'create':
      case 'edit':
        return html`
          <button class="btn btn-secondary" @click=${this.handleBack}>Cancel</button>
          ${this.justAttachedAccountName
            ? html`<span class="attach-hint" data-testid="attach-keep-hint">
                Save Profile to keep <strong>${this.justAttachedAccountName}</strong> attached
              </span>`
            : html`<div style="flex: 1;"></div>`}
          <button
            class="btn btn-primary ${this.justAttachedAccountName ? 'btn-emphasized' : ''}"
            @click=${this.handleSave}
            ?disabled=${this.isSaving}
          >
            ${this.isSaving ? 'Saving...' : 'Save Profile'}
          </button>
        `;
      case 'select-account':
        // Picker rows are click-to-attach, so only a back button is needed.
        return html`
          <button class="btn btn-secondary" @click=${this.handleBack}>Back</button>
        `;
      case 'edit-account':
        return html`
          <button
            class="btn btn-danger"
            ?disabled=${!this.editingAccount?.id}
            title="Permanently delete this account for all profiles"
            @click=${() => this.editingAccount?.id && this.handleDeleteGlobalAccount(this.editingAccount.id)}
          >
            Delete Account
          </button>
          <div style="flex: 1;"></div>
          <button class="btn btn-secondary" @click=${this.handleBack}>Cancel</button>
          <button class="btn btn-primary" @click=${this.handleSaveAccount}>Save Account</button>
        `;
      case 'assign-repos':
        return html`
          <button class="btn btn-secondary" @click=${this.handleBack}>Cancel</button>
          <button class="btn btn-primary" @click=${this.handleBulkAssign} ?disabled=${this.selectedReposForAssignment.size === 0 || this.isSaving}>
            ${this.isSaving ? 'Assigning...' : `Assign ${this.selectedReposForAssignment.size} Repository${this.selectedReposForAssignment.size !== 1 ? 'ies' : ''}`}
          </button>
        `;
      default:
        return nothing;
    }
  }

  private renderProfileList() {
    if (this.isLoading) {
      return html`<div class="empty-state">Loading profiles...</div>`;
    }

    const explainer = html`
      <p class="view-explainer">
        Profiles set your git identity per repository. Accounts are shared logins you assign to profiles.
      </p>
    `;

    if (this.profiles.length === 0) {
      return html`
        ${explainer}
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
            <circle cx="12" cy="7" r="4"></circle>
          </svg>
          <div>No profiles yet</div>
          <p style="font-size: var(--font-size-sm); margin-top: var(--spacing-sm);">
            Create profiles to manage git identities and integration accounts together
          </p>
        </div>
      `;
    }

    return html`
      ${explainer}
      <div class="profile-list">
        ${this.profiles.map(
          (profile) => html`
            <div class="profile-item" @click=${() => this.handleEdit(profile)}>
              <div
                class="profile-color"
                style="background: ${profile.color ?? PROFILE_COLORS[0]}"
              ></div>
              <div class="profile-info">
                <div class="profile-name">
                  ${profile.name}
                  ${profile.isDefault ? html`<span class="default-badge">Default</span>` : nothing}
                </div>
                <div class="profile-email">${profile.gitName} &lt;${profile.gitEmail}&gt;</div>
                <div class="profile-meta">
                  ${Object.keys(profile.defaultAccounts).length > 0
                    ? html`<span>${Object.keys(profile.defaultAccounts).length} default account${Object.keys(profile.defaultAccounts).length > 1 ? 's' : ''}</span>`
                    : nothing}
                  ${profile.urlPatterns.length > 0
                    ? html`<span>· ${profile.urlPatterns.length} pattern${profile.urlPatterns.length > 1 ? 's' : ''}</span>`
                    : nothing}
                </div>
              </div>
              <div class="profile-actions">
                ${this.repoPath
                  ? html`
                      <button
                        class="action-btn"
                        @click=${(e: Event) => this.handleApply(profile, e)}
                        title="Apply to current repository"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                      </button>
                    `
                  : nothing}
                <button
                  class="action-btn"
                  @click=${(e: Event) => this.handleDuplicate(profile, e)}
                  title="Duplicate profile"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                </button>
                <button
                  class="action-btn delete"
                  @click=${(e: Event) => this.handleDelete(profile, e)}
                  title="Delete profile"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                </button>
              </div>
            </div>
          `
        )}
      </div>
      ${this.renderBackupSection()}
    `;
  }

  private renderBackupSection() {
    // Only show if backup exists
    if (!this.backupInfo?.hasBackup) {
      return nothing;
    }

    return html`
      <div class="backup-section">
        <button
          class="backup-toggle ${this.showBackupSection ? 'expanded' : ''}"
          @click=${() => (this.showBackupSection = !this.showBackupSection)}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
          Migration Backup Available
        </button>
        ${this.showBackupSection
          ? html`
              <div class="backup-content">
                <div class="backup-info">
                  <div class="backup-info-row">
                    <span class="backup-info-label">Backup Date</span>
                    <span>${this.backupInfo.backupDate ?? 'Unknown'}</span>
                  </div>
                  ${this.backupInfo.profilesCount !== null
                    ? html`
                        <div class="backup-info-row">
                          <span class="backup-info-label">Profiles</span>
                          <span>${this.backupInfo.profilesCount}</span>
                        </div>
                      `
                    : nothing}
                  ${this.backupInfo.accountsCount !== null
                    ? html`
                        <div class="backup-info-row">
                          <span class="backup-info-label">Accounts</span>
                          <span>${this.backupInfo.accountsCount}</span>
                        </div>
                      `
                    : nothing}
                </div>
                <p style="font-size: var(--font-size-sm); color: var(--color-text-secondary); margin-bottom: var(--spacing-md);">
                  A backup of your pre-migration data exists. You can restore it to undo the migration, or delete it if you're satisfied with the current setup.
                </p>
                <div class="backup-actions">
                  <button
                    class="btn btn-warning"
                    @click=${this.handleRestoreBackup}
                    ?disabled=${this.isRestoringBackup}
                  >
                    ${this.isRestoringBackup ? 'Restoring...' : 'Restore Backup'}
                  </button>
                  <button
                    class="btn btn-secondary"
                    @click=${this.handleDeleteBackup}
                    ?disabled=${this.isRestoringBackup}
                  >
                    Delete Backup
                  </button>
                </div>
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private renderProfileForm() {
    if (!this.editingProfile) return nothing;

    return html`
      <div class="form-section">
        <div class="form-section-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
            <circle cx="12" cy="7" r="4"></circle>
          </svg>
          Profile Settings
        </div>

        <div class="form-group">
          <label>Profile Name</label>
          <input
            type="text"
            placeholder="e.g., Work, Personal, Open Source"
            autofocus
            .value=${this.editingProfile.name ?? ''}
            @input=${(e: Event) => this.updateEditingProfile('name', (e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Git Name</label>
            <input
              type="text"
              placeholder="John Doe"
              .value=${this.editingProfile.gitName ?? ''}
              @input=${(e: Event) => this.updateEditingProfile('gitName', (e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="form-group">
            <label>Git Email</label>
            <input
              type="email"
              placeholder="john@example.com"
              .value=${this.editingProfile.gitEmail ?? ''}
              @input=${(e: Event) => this.updateEditingProfile('gitEmail', (e.target as HTMLInputElement).value)}
            />
          </div>
        </div>

        <div class="form-group">
          <label>GPG Signing Key (optional)</label>
          <input
            type="text"
            placeholder="Key ID or fingerprint"
            .value=${this.editingProfile.signingKey ?? ''}
            @input=${(e: Event) => this.updateEditingProfile('signingKey', (e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="form-group">
          <label>URL Patterns (one per line)</label>
          <textarea
            placeholder="github.com/mycompany/*&#10;gitlab.com/work-projects/*"
            .value=${(this.editingProfile.urlPatterns ?? []).join('\n')}
            @input=${this.handlePatternsChange}
          ></textarea>
          <div class="form-hint">
            Auto-detect which profile to use based on repository URL. Supports wildcards (*).
          </div>
        </div>

        <div class="form-group">
          <label>Color</label>
          <div class="color-picker">
            ${PROFILE_COLORS.map(
              (color) => html`
                <div
                  class="color-option ${this.editingProfile?.color === color ? 'selected' : ''}"
                  style="background: ${color}"
                  @click=${() => this.updateEditingProfile('color', color)}
                ></div>
              `
            )}
          </div>
        </div>

        <div class="checkbox-row">
          <input
            type="checkbox"
            id="isDefault"
            .checked=${this.editingProfile.isDefault ?? false}
            @change=${(e: Event) => this.updateEditingProfile('isDefault', (e.target as HTMLInputElement).checked)}
          />
          <label for="isDefault">Set as default profile</label>
        </div>
      </div>

      <!-- Integration Accounts Section -->
      <div class="accounts-section">
        <div class="accounts-header">
          <div class="form-section-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
              <circle cx="9" cy="7" r="4"></circle>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
            </svg>
            Integration Accounts
          </div>
          <button class="btn btn-sm" @click=${this.handleOpenAccountPicker}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            Add
          </button>
        </div>

        ${this.getAttachedAccounts().length === 0
          ? html`
              <div class="empty-accounts">
                No accounts attached to this profile.
                <br />
                Click "Add" to attach an integration account.
              </div>
            `
          : html`
              <div class="accounts-list">
                ${this.getAttachedAccounts().map(({ type, account }) =>
                  this.renderAttachedAccountItem(type, account)
                )}
              </div>
            `}
      </div>

      <!-- Assigned Repositories Section (only for existing profiles) -->
      ${this.editingProfile.id ? this.renderAssignedRepositories() : nothing}
    `;
  }

  private renderAssignedRepositories() {
    const assignedRepos = this.getAssignedRepositories(this.editingProfile?.id);

    return html`
      <div class="accounts-section">
        <div class="accounts-header">
          <div class="form-section-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
            Assigned Repositories
          </div>
          <button class="btn btn-secondary btn-sm" @click=${this.handleOpenRepoAssignment}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            Assign
          </button>
        </div>

        ${assignedRepos.length === 0
          ? html`
              <div class="empty-accounts">
                No repositories are using this profile.
                <br />
                Click "Assign" to add repositories from your recent list.
              </div>
            `
          : html`
              <div class="accounts-list">
                ${assignedRepos.map(
                  (repoPath) => html`
                    <div class="account-item">
                      <svg class="account-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                      </svg>
                      <div class="account-info">
                        <div class="account-name">${this.formatRepoPath(repoPath)}</div>
                        <div class="account-detail">${repoPath}</div>
                      </div>
                      <div class="account-actions">
                        <button
                          class="action-btn delete"
                          @click=${() => this.handleUnassignRepository(repoPath)}
                          title="Unassign repository from this profile"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                          </svg>
                        </button>
                      </div>
                    </div>
                  `
                )}
              </div>
            `}
      </div>
    `;
  }

  private renderRepoAssignment() {
    const assignedRepos = this.getAssignedRepositories(this.editingProfile?.id);
    const availableRepos = this.recentRepositories.filter(
      (repo) => !assignedRepos.includes(repo.path)
    );

    return html`
      <div class="form-content">
        <div class="form-section">
          <p style="color: var(--color-text-secondary); margin-bottom: var(--spacing-md);">
            Select repositories to assign to <strong>${this.editingProfile?.name}</strong>:
          </p>

          ${availableRepos.length === 0
            ? html`
                <div class="empty-accounts">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 48px; height: 48px; opacity: 0.5; margin-bottom: var(--spacing-sm);">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                  </svg>
                  <p>No unassigned repositories available.</p>
                  <p style="font-size: var(--font-size-sm); color: var(--color-text-tertiary);">
                    Open some repositories first to add them here.
                  </p>
                </div>
              `
            : html`
                <div class="accounts-list">
                  ${availableRepos.map(
                    (repo) => html`
                      <label class="account-item selectable ${this.selectedReposForAssignment.has(repo.path) ? 'selected' : ''}">
                        <input
                          type="checkbox"
                          .checked=${this.selectedReposForAssignment.has(repo.path)}
                          @change=${() => this.toggleRepoSelection(repo.path)}
                        />
                        <svg class="account-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                        </svg>
                        <div class="account-info">
                          <div class="account-name">${repo.name}</div>
                          <div class="account-detail">${repo.path}</div>
                        </div>
                      </label>
                    `
                  )}
                </div>
              `}
        </div>
      </div>
    `;
  }

  /**
   * Base renderer for an account row. `actions` is an optional template for the
   * trailing action buttons (edit/detach); `onClick`, when provided, makes the
   * whole row a click-to-select control (used by the account picker). The same
   * markup is reused for attached accounts and picker rows.
   */
  private renderAccountItem(
    account: IntegrationAccount,
    actions: TemplateResult | typeof nothing = nothing,
    onClick?: () => void
  ) {
    const details = this.getAccountDetails(account);
    const connectionStatus = this.getAccountConnectionStatus(account.id);
    const statusTitle = {
      connected: 'Connected',
      disconnected: 'Disconnected - token may be invalid',
      checking: 'Checking connection...',
      unknown: 'Connection status unknown',
    }[connectionStatus];

    return html`
      <div
        class="account-item ${onClick ? 'selectable' : ''}"
        role=${onClick ? 'button' : nothing}
        tabindex=${onClick ? '0' : nothing}
        @click=${onClick ?? nothing}
        @keydown=${onClick
          ? (e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : nothing}
      >
        ${this.renderAccountIcon(account.integrationType)}
        <div class="account-info">
          <div class="account-name">
            ${account.name}
            ${account.isDefault ? html`<span class="default-badge">Default</span>` : nothing}
            <span class="type-badge">${account.integrationType}</span>
          </div>
          ${details ? html`<div class="account-detail">${details}</div>` : nothing}
        </div>
        <span class="status-indicator ${connectionStatus}" title="${statusTitle}"></span>
        ${actions}
      </div>
    `;
  }

  /**
   * An account row in the profile's "Integration Accounts" list. The X button
   * detaches the account from this profile only (it does not delete the global
   * account); editing opens the account's Edit screen.
   */
  private renderAttachedAccountItem(type: IntegrationType, account: IntegrationAccount) {
    return this.renderAccountItem(
      account,
      html`
        <div class="account-actions">
          <button class="action-btn" @click=${() => this.handleEditAccount(account)} title="Edit account">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
          </button>
          <button class="action-btn delete" @click=${() => this.handleDetachAccount(type)} title="Detach from profile">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      `
    );
  }

  /**
   * Account picker shown when attaching an account to a profile. Lists existing
   * global accounts as click-to-attach rows, and always offers a path to connect
   * a brand-new account via the integration dialogs.
   */
  private renderAccountPicker() {
    const accounts = this.getGlobalAccounts();

    return html`
      <div class="form-content">
        <div class="form-section">
          <div class="attach-breadcrumb" data-testid="attach-breadcrumb">
            Adding to <strong>${this.editingProfile?.name || 'this profile'}</strong>
          </div>
          ${accounts.length === 0
            ? html`
                <div class="empty-accounts">
                  No integration accounts yet. Connect one below — once you return, it'll be
                  attached to this profile automatically.
                </div>
              `
            : html`
                <p style="color: var(--color-text-secondary); margin-bottom: var(--spacing-md);">
                  Select an account to attach to <strong>${this.editingProfile?.name || 'this profile'}</strong>.
                  A profile uses one account per provider, so choosing a provider you already have
                  attached will replace it.
                </p>
                <div class="accounts-list">
                  ${accounts.map((account) =>
                    this.renderAccountItem(account, nothing, () => this.handleAttachAccount(account))
                  )}
                </div>
              `}

          ${this.renderConnectButtons()}
        </div>
      </div>
    `;
  }

  /**
   * "Connect a new account" provider buttons, shared by the attach picker and
   * the standalone Accounts view. Each opens the matching integration dialog.
   */
  private renderConnectButtons() {
    const providers: IntegrationType[] = ['github', 'gitlab', 'bitbucket', 'azure-devops', 'oidc'];
    return html`
      <div class="form-section-title" style="margin-top: var(--spacing-lg);">
        Connect a new account
      </div>
      <div style="display: flex; gap: var(--spacing-sm); flex-wrap: wrap; margin-top: var(--spacing-sm);">
        ${providers.map(
          (type) => html`
            <button class="btn btn-secondary btn-sm" @click=${() => this.dispatchIntegrationOpen(type)}>
              ${this.renderAccountIcon(type)}
              ${INTEGRATION_TYPE_NAMES[type]}
            </button>
          `
        )}
      </div>
    `;
  }

  /**
   * Standalone account-management view: lists every global account with edit /
   * delete affordances and offers connect-new buttons. Reachable from the
   * profile list ("Accounts") and from an integration dialog's "Manage
   * Accounts" action — independent of editing any profile, so orphan accounts
   * (attached to no profile) are manageable here.
   */
  private renderAccountsManager() {
    const accounts = this.getGlobalAccounts();

    return html`
      <div class="form-content">
        <div class="form-section">
          ${accounts.length === 0
            ? html`
                <div class="empty-accounts">
                  No integration accounts yet. Connect one below.
                </div>
              `
            : html`
                <div class="accounts-list">
                  ${accounts.map((account) => this.renderManagedAccountItem(account))}
                </div>
              `}
          ${this.renderConnectButtons()}
        </div>
      </div>
    `;
  }

  /**
   * An account row in the standalone Accounts view. Edit opens the account's
   * Edit screen; Delete removes the global account for all profiles.
   */
  private renderManagedAccountItem(account: IntegrationAccount) {
    return this.renderAccountItem(
      account,
      html`
        <div class="account-actions">
          <button class="action-btn" @click=${() => this.handleEditAccount(account)} title="Edit account">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
          </button>
          <button
            class="action-btn delete"
            @click=${() => this.handleDeleteGlobalAccount(account.id)}
            title="Delete account (all profiles)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      `
    );
  }

  private renderAccountIcon(type: IntegrationType) {
    switch (type) {
      case 'github':
        return html`
          <svg class="account-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
          </svg>
        `;
      case 'gitlab':
        return html`
          <svg class="account-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 0 1 4.82 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0 1 18.6 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.51L23 13.45a.84.84 0 0 1-.35.94z"/>
          </svg>
        `;
      case 'azure-devops':
        return html`
          <svg class="account-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z"/>
          </svg>
        `;
      case 'bitbucket':
        return html`
          <svg class="account-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M.778 1.213a.768.768 0 00-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 00.77-.646l3.27-20.03a.768.768 0 00-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z"/>
          </svg>
        `;
      default:
        return html`
          <svg class="account-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
          </svg>
        `;
    }
  }

  private getAccountConnectionStatus(accountId: string): ConnectionStatus {
    return this.accountConnectionStatus[accountId]?.status ?? 'unknown';
  }

  private getAssignedRepositories(profileId: string | undefined): string[] {
    if (!profileId) return [];
    return Object.entries(this.repositoryAssignments)
      .filter(([, id]) => id === profileId)
      .map(([path]) => path);
  }

  private formatRepoPath(path: string): string {
    // Extract just the repo name from the path
    const parts = path.split('/');
    return parts.slice(-2).join('/'); // e.g., "user/repo" from "/path/to/user/repo"
  }

  private getAccountDetails(account: IntegrationAccount): string | null {
    const parts: string[] = [];

    // Add username if available
    if (account.cachedUser?.username) {
      parts.push(`@${account.cachedUser.username}`);
    }

    // Add instance/org info based on type
    if (account.config.type === 'gitlab' && account.config.instanceUrl) {
      try {
        const url = new URL(account.config.instanceUrl);
        if (url.hostname !== 'gitlab.com') {
          parts.push(url.hostname);
        }
      } catch {
        // Invalid URL, ignore
      }
    } else if (account.config.type === 'azure-devops' && account.config.organization) {
      parts.push(account.config.organization);
    }

    return parts.length > 0 ? parts.join(' · ') : null;
  }

  private getDefaultConfigForType(type: IntegrationType): IntegrationConfig {
    switch (type) {
      case 'github':
        return { type: 'github' };
      case 'gitlab':
        return { type: 'gitlab', instanceUrl: 'https://gitlab.com' };
      case 'azure-devops':
        return { type: 'azure-devops', organization: '' };
      case 'bitbucket':
        return { type: 'bitbucket', workspace: '' };
      case 'oidc':
        return { type: 'oidc', issuerUrl: '', clientId: '' };
    }
  }

  private renderAccountForm() {
    if (!this.editingAccount) return nothing;

    // Edit mode - show form for editing existing account metadata
    return html`
      <div class="form-group">
        <label>Account Name</label>
        <input
          type="text"
          placeholder="e.g., Work GitHub, Personal GitLab"
          .value=${this.editingAccount.name ?? ''}
          @input=${(e: Event) => this.updateEditingAccount('name', (e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="form-group">
        <label>Integration Type</label>
        <select
          .value=${this.editingAccount.integrationType ?? 'github'}
          disabled
        >
          <option value="github" ?selected=${this.editingAccount.integrationType === 'github'}>GitHub</option>
          <option value="gitlab" ?selected=${this.editingAccount.integrationType === 'gitlab'}>GitLab</option>
          <option value="azure-devops" ?selected=${this.editingAccount.integrationType === 'azure-devops'}>Azure DevOps</option>
          <option value="bitbucket" ?selected=${this.editingAccount.integrationType === 'bitbucket'}>Bitbucket</option>
          <option value="oidc" ?selected=${this.editingAccount.integrationType === 'oidc'}>Enterprise SSO (OIDC)</option>
        </select>
        <div class="form-hint">Integration type cannot be changed</div>
      </div>

      ${this.renderAccountConfigFields()}

      <div class="form-group">
        <label>URL Patterns (one per line)</label>
        <textarea
          placeholder="github.com/mycompany/*&#10;github.com/another-org/*"
          .value=${(this.editingAccount.urlPatterns ?? []).join('\n')}
          @input=${this.handleAccountPatternsChange}
        ></textarea>
        <div class="form-hint">
          Auto-select this account for repositories whose remote URL matches. Supports wildcards
          (*). Account patterns take precedence over the profile's default account, so use them when
          one repo needs a specific account of this type.
        </div>
      </div>

      <div class="form-group">
        <label>Color (optional)</label>
        <div class="color-picker">
          <div
            class="color-option ${!this.editingAccount.color ? 'selected' : ''}"
            style="background: var(--color-bg-tertiary); border: 1px dashed var(--color-border);"
            @click=${() => this.updateEditingAccount('color', null)}
            title="Inherit from profile"
          ></div>
          ${ACCOUNT_COLORS.map(
            (color) => html`
              <div
                class="color-option ${this.editingAccount?.color === color ? 'selected' : ''}"
                style="background: ${color}"
                @click=${() => this.updateEditingAccount('color', color)}
              ></div>
            `
          )}
        </div>
        <div class="form-hint">Leave unset to inherit the profile color</div>
      </div>

      <div class="checkbox-row">
        <input
          type="checkbox"
          id="isDefault"
          .checked=${this.editingAccount.isDefault ?? false}
          @change=${(e: Event) => this.updateEditingAccount('isDefault', (e.target as HTMLInputElement).checked)}
        />
        <label for="isDefault">Set as default ${INTEGRATION_TYPE_NAMES[this.editingAccount.integrationType ?? 'github']} account globally</label>
      </div>
    `;
  }

  private dispatchIntegrationOpen(type: IntegrationType): void {
    // Snapshot the accounts that exist now so revealAfterConnect() can identify
    // the one the user just connected. This is captured at dispatch time (not
    // inferred later) and travels with the explicit context below.
    this.accountIdsBeforeConnect = new Set(this.getGlobalAccounts().map((a) => a.id));

    // EXPLICIT navigation intent: tell the host exactly how this dialog is being
    // opened so the provider dialog can show a Back arrow that returns HERE, and
    // (only when attaching) attach the just-connected account to this profile.
    // Attach intent is true only when connecting from the per-profile attach
    // picker — never from the standalone Accounts view, where there is no
    // profile to attach to and an auto-attach would be a surprise.
    const attach = this.viewMode === 'select-account' || this.viewMode === 'edit' || this.viewMode === 'create';
    const context: IntegrationOpenContext = {
      returnTo: 'profile-manager',
      integrationType: type,
      profileId: this.editingProfile?.id ?? '',
      profileName: this.editingProfile?.name ?? '',
      attach,
    };

    // Stay on the current view: the host stacks the integration dialog on top and
    // reveals this one again on close (via revealAfterConnect with the context).
    this.dispatchEvent(
      new CustomEvent(`open-${type}`, {
        detail: context,
        bubbles: true,
        composed: true,
      })
    );
  }

  /**
   * Switch directly to the standalone Accounts view. Public so the host can land
   * an already-open manager on Accounts when the `open` property doesn't transition
   * false→true (e.g. "Manage Accounts" clicked from a provider dialog that was
   * itself launched from this manager — the manager is already open & demoted, so
   * `willUpdate`'s open-transition logic never runs). Reloads accounts so the list
   * is fresh.
   */
  public showAccountsView(preserveState = false): void {
    if (preserveState) {
      this.accountsReturnView = this.viewMode;
    } else {
      this.initialView = 'accounts';
      this.accountsReturnView = null;
    }
    this.viewMode = 'accounts';
    void this.loadProfiles().then(() => this.refreshConnectionStatuses());
  }

  /**
   * Called by the host when a provider/OIDC dialog that was opened FROM this
   * manager closes. Driven by the EXPLICIT context captured at open time — not by
   * guessing global state. Reloads accounts and, when the context carried an
   * attach intent, attaches the just-connected account to the target profile and
   * returns to its form so it shows as attached (ready to Save).
   *
   * Public so app-shell can invoke it deterministically on dialog close. When
   * `context.attach` is false (e.g. opened from the standalone Accounts view),
   * we just refresh the list with no surprise attach.
   */
  public async revealAfterConnect(context: IntegrationOpenContext): Promise<void> {
    await this.loadProfiles();

    if (!context.attach) {
      // Standalone "connect a new account" — no profile to attach to. The store
      // subscription already re-rendered the account list; nothing else to do.
      this.accountIdsBeforeConnect = new Set();
      return;
    }

    const type = context.integrationType;

    // Re-resolve the editing profile from the freshly loaded store so the attach
    // lands on the right profile even if the snapshot drifted. For an unsaved
    // (create-mode) profile, profileId is '' and we keep the in-memory draft.
    if (context.profileId) {
      const fresh = this.profiles.find((p) => p.id === context.profileId);
      if (fresh) {
        this.editingProfile = { ...fresh, defaultAccounts: { ...fresh.defaultAccounts } };
      }
    }
    if (!this.editingProfile) {
      this.accountIdsBeforeConnect = new Set();
      return;
    }

    const accountsOfType = this.getGlobalAccounts().filter((a) => a.integrationType === type);
    const previous = this.editingProfile.defaultAccounts?.[type];
    const newlyConnected = accountsOfType.find((a) => !this.accountIdsBeforeConnect.has(a.id));
    this.accountIdsBeforeConnect = new Set();

    if (newlyConnected) {
      // The user explicitly connected this account while attaching to the
      // profile — honor that intent even if another account was already
      // attached for this provider (a profile holds one account per provider).
      if (previous && previous !== newlyConnected.id) {
        showToast(`Replaced the previously attached ${INTEGRATION_TYPE_NAMES[type]} account`, 'info');
      }
      this.setEditingProfileAccount(type, newlyConnected.id);
      // Surface a hint near Save: the account is attached to the in-memory draft
      // only and is dropped if the user backs out without saving.
      this.justAttachedAccountName = newlyConnected.name;
      this.viewMode = this.editingProfile.id ? 'edit' : 'create';
      return;
    }

    // No new account was connected (e.g. the user backed out).
    // We shouldn't auto-fill an existing account here, as backing out should be a no-op.
    return;
  }

  private renderAccountConfigFields() {
    const type = this.editingAccount?.integrationType;
    const config = this.editingAccount?.config;

    if (type === 'gitlab') {
      const instanceUrl = config?.type === 'gitlab' ? config.instanceUrl : '';
      return html`
        <div class="form-group">
          <label>GitLab Instance URL (optional)</label>
          <input
            type="url"
            placeholder="https://gitlab.com"
            .value=${instanceUrl ?? ''}
            @input=${(e: Event) => this.updateEditingAccount('config', {
              type: 'gitlab',
              instanceUrl: (e.target as HTMLInputElement).value || 'https://gitlab.com',
            })}
          />
          <div class="form-hint">Leave empty for gitlab.com, or enter your self-hosted GitLab URL</div>
        </div>
      `;
    }

    if (type === 'azure-devops') {
      const organization = config?.type === 'azure-devops' ? config.organization : '';
      return html`
        <div class="form-group">
          <label>Organization</label>
          <input
            type="text"
            placeholder="my-organization"
            .value=${organization ?? ''}
            @input=${(e: Event) => this.updateEditingAccount('config', {
              type: 'azure-devops',
              organization: (e.target as HTMLInputElement).value || '',
            })}
          />
          <div class="form-hint">Your Azure DevOps organization name</div>
        </div>
      `;
    }

    if (type === 'bitbucket') {
      const workspace = config?.type === 'bitbucket' ? config.workspace : '';
      return html`
        <div class="form-group">
          <label>Workspace (optional)</label>
          <input
            type="text"
            placeholder="my-workspace"
            .value=${workspace ?? ''}
            @input=${(e: Event) => this.updateEditingAccount('config', {
              type: 'bitbucket',
              workspace: (e.target as HTMLInputElement).value || '',
            })}
          />
          <div class="form-hint">Your Bitbucket workspace (usually your username or organization)</div>
        </div>
      `;
    }

    if (type === 'oidc') {
      const issuerUrl = config?.type === 'oidc' ? config.issuerUrl : '';
      const clientId = config?.type === 'oidc' ? config.clientId : '';
      return html`
        <div class="form-group">
          <label>Issuer URL</label>
          <input
            type="url"
            placeholder="https://auth.example.com"
            .value=${issuerUrl ?? ''}
            @input=${(e: Event) => this.updateEditingAccount('config', {
              type: 'oidc',
              issuerUrl: (e.target as HTMLInputElement).value || '',
              clientId,
            })}
          />
          <div class="form-hint">Your OpenID Connect issuer URL (Enterprise SSO).</div>
        </div>
        <div class="form-group">
          <label>Client ID</label>
          <input
            type="text"
            placeholder="your-client-id"
            .value=${clientId ?? ''}
            @input=${(e: Event) => this.updateEditingAccount('config', {
              type: 'oidc',
              issuerUrl,
              clientId: (e.target as HTMLInputElement).value || '',
            })}
          />
          <div class="form-hint">The OAuth client ID registered with your IdP.</div>
        </div>
      `;
    }

    return nothing;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-profile-manager-dialog': GnProfileManagerDialog;
  }
}
