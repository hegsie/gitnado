/**
 * Migration Dialog Component
 * Guides users through migrating from separate profiles/accounts to unified profiles
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as unifiedProfileService from '../../services/unified-profile.service.ts';
import { unifiedProfileStore } from '../../stores/unified-profile.store.ts';
import { showToast } from '../../services/notification.service.ts';
import type {
  MigrationPreview,
  MigrationPreviewProfile,
  UnmatchedAccount,
  UnifiedMigrationResult,
} from '../../types/unified-profile.types.ts';
import { INTEGRATION_TYPE_NAMES } from '../../types/unified-profile.types.ts';
import { pushOverlay, removeOverlay, isTopOverlay } from '../../utils/overlay-stack.ts';

type ViewMode = 'intro' | 'preview' | 'migrating' | 'complete';

@customElement('gn-migration-dialog')
export class GnMigrationDialog extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .dialog-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: var(--z-modal);
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
        padding: var(--spacing-md) var(--spacing-lg);
        border-bottom: 1px solid var(--color-border);
      }

      .dialog-title {
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-semibold);
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .dialog-content {
        flex: 1;
        overflow-y: auto;
        padding: var(--spacing-lg);
      }

      .dialog-footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-md) var(--spacing-lg);
        border-top: 1px solid var(--color-border);
      }

      .footer-right {
        display: flex;
        gap: var(--spacing-sm);
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

      .btn:hover:not(:disabled) {
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

      .btn-text {
        background: none;
        border: none;
        color: var(--color-text-secondary);
      }

      .btn-text:hover:not(:disabled) {
        color: var(--color-text-primary);
      }

      /* Intro section */
      .intro-content {
        text-align: center;
        padding: var(--spacing-lg) 0;
      }

      .intro-icon {
        width: 64px;
        height: 64px;
        margin: 0 auto var(--spacing-lg);
        color: var(--color-primary);
      }

      .intro-title {
        font-size: var(--font-size-xl);
        font-weight: var(--font-weight-semibold);
        margin-bottom: var(--spacing-sm);
      }

      .intro-description {
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-lg);
        line-height: 1.6;
      }

      .feature-list {
        text-align: left;
        background: var(--color-bg-secondary);
        border-radius: var(--radius-md);
        padding: var(--spacing-md);
        margin-top: var(--spacing-md);
      }

      .feature-item {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) 0;
      }

      .feature-item svg {
        color: var(--color-success);
        flex-shrink: 0;
        margin-top: 2px;
      }

      .feature-item span {
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
      }

      /* Preview section */
      .preview-section {
        margin-bottom: var(--spacing-lg);
      }

      .section-title {
        font-size: var(--font-size-md);
        font-weight: var(--font-weight-medium);
        margin-bottom: var(--spacing-sm);
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .section-description {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-md);
      }

      /* Profile preview card */
      .profile-preview {
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        padding: var(--spacing-md);
        margin-bottom: var(--spacing-sm);
      }

      .profile-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        margin-bottom: var(--spacing-sm);
      }

      .profile-color {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--color-primary);
      }

      .profile-name {
        font-weight: var(--font-weight-medium);
      }

      .profile-email {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .matched-accounts {
        margin-top: var(--spacing-sm);
        padding-top: var(--spacing-sm);
        border-top: 1px solid var(--color-border);
      }

      .matched-accounts-title {
        font-size: var(--font-size-xs);
        color: var(--color-text-tertiary);
        margin-bottom: var(--spacing-xs);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .account-tag {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: 4px 8px;
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-xs);
        margin-right: var(--spacing-xs);
        margin-bottom: var(--spacing-xs);
      }

      .account-tag .type {
        color: var(--color-text-tertiary);
      }

      .no-accounts {
        font-size: var(--font-size-sm);
        color: var(--color-text-tertiary);
        font-style: italic;
      }

      /* Unmatched accounts */
      .unmatched-section {
        background: var(--color-warning-bg);
        border: 1px solid var(--color-warning);
        border-radius: var(--radius-md);
        padding: var(--spacing-md);
      }

      .unmatched-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        margin-bottom: var(--spacing-sm);
        color: var(--color-warning);
      }

      .unmatched-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm);
        background: var(--color-bg-primary);
        border-radius: var(--radius-sm);
        margin-bottom: var(--spacing-xs);
      }

      .unmatched-item:last-child {
        margin-bottom: 0;
      }

      .unmatched-account-info {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .unmatched-account-name {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
      }

      .unmatched-account-type {
        font-size: var(--font-size-xs);
        color: var(--color-text-tertiary);
      }

      .profile-select {
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
      }

      /* Migrating state */
      .migrating-content {
        text-align: center;
        padding: var(--spacing-xl) 0;
      }

      .spinner {
        width: 48px;
        height: 48px;
        border: 3px solid var(--color-border);
        border-top-color: var(--color-primary);
        border-radius: 50%;
        animation: spin 1s linear infinite;
        margin: 0 auto var(--spacing-lg);
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      /* Complete state */
      .complete-content {
        text-align: center;
        padding: var(--spacing-lg) 0;
      }

      .success-icon {
        width: 64px;
        height: 64px;
        color: var(--color-success);
        margin: 0 auto var(--spacing-md);
      }

      .warning-icon {
        width: 64px;
        height: 64px;
        color: var(--color-warning);
        margin: 0 auto var(--spacing-md);
      }

      .error-section {
        text-align: left;
        background: var(--color-warning-bg);
        border: 1px solid var(--color-warning);
        border-radius: var(--radius-md);
        padding: var(--spacing-md);
        margin-top: var(--spacing-lg);
      }

      .error-section-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-warning);
        margin-bottom: var(--spacing-sm);
      }

      .error-list {
        margin: 0;
        padding-left: var(--spacing-lg);
      }

      .error-item {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-xs);
      }

      .stats {
        display: flex;
        justify-content: center;
        gap: var(--spacing-lg);
        margin-top: var(--spacing-lg);
      }

      .stat {
        text-align: center;
      }

      .stat-value {
        font-size: var(--font-size-xl);
        font-weight: var(--font-weight-semibold);
        color: var(--color-primary);
      }

      .stat-label {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      /* Empty state */
      .empty-preview {
        text-align: center;
        padding: var(--spacing-xl);
        color: var(--color-text-secondary);
      }
    `,
  ];

  @property({ type: Boolean }) open = false;

  @state() private viewMode: ViewMode = 'intro';
  @state() private isLoading = false;
  @state() private preview: MigrationPreview | null = null;
  @state() private accountAssignments: Record<string, string> = {}; // accountId -> profileId
  @state() private migrationResult: UnifiedMigrationResult | null = null;

  updated(changedProperties: Map<string, unknown>): void {
    // Announce/withdraw overlay ownership of Escape.
    if (changedProperties.has('open')) {
      if (this.open) { pushOverlay(this); } else { removeOverlay(this); }
    }
    if (changedProperties.has('open') && this.open) {
      this.resetState();
    }
  }

  private resetState(): void {
    this.viewMode = 'intro';
    this.preview = null;
    this.accountAssignments = {};
    this.migrationResult = null;
    this.isLoading = false;
  }

  /**
   * This dialog paints its own overlay instead of using gn-modal, so it had no
   * Escape handling at all — and app-shell's Escape chain stops at the dialog
   * layer (so one keypress cannot also close the diff behind it), which left
   * Escape completely dead here. handleClose already refuses mid-migration.
   */
  private handleKeyDown = (e: KeyboardEvent): void => {
    // Only the topmost overlay owns Escape: every dialog listens on
    // `document`, so without this one keypress ran all of them.
    if (!this.open || !isTopOverlay(this)) return;
    if (e.key === 'Escape') {
      this.handleClose();
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this.handleKeyDown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    removeOverlay(this);
    document.removeEventListener('keydown', this.handleKeyDown);
  }

  private handleClose(): void {
    if (this.viewMode === 'migrating') return; // Don't allow closing during migration
    this.open = false;
    this.dispatchEvent(new CustomEvent('close'));
  }

  private async handleContinue(): Promise<void> {
    if (this.viewMode === 'intro') {
      await this.loadPreview();
    } else if (this.viewMode === 'preview') {
      await this.executeMigration();
    } else if (this.viewMode === 'complete') {
      this.handleClose();
    }
  }

  private async loadPreview(): Promise<void> {
    this.isLoading = true;

    try {
      const preview = await unifiedProfileService.previewUnifiedProfilesMigration();
      this.preview = preview;

      // Initialize assignments for unmatched accounts
      this.accountAssignments = {};
      for (const account of preview.unmatchedAccounts) {
        if (account.suggestedProfileId) {
          this.accountAssignments[account.accountId] = account.suggestedProfileId;
        } else if (preview.profiles.length > 0) {
          this.accountAssignments[account.accountId] = preview.profiles[0].profileId;
        }
      }

      this.viewMode = 'preview';
    } catch (error) {
      showToast(
        `Failed to load migration preview: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'error'
      );
    } finally {
      this.isLoading = false;
    }
  }

  private async executeMigration(): Promise<void> {
    this.viewMode = 'migrating';
    unifiedProfileStore.getState().setMigrating(true);

    try {
      const result = await unifiedProfileService.executeUnifiedProfilesMigration(
        this.accountAssignments
      );
      this.migrationResult = result;
      this.viewMode = 'complete';

      if (result.success) {
        unifiedProfileStore.getState().setNeedsMigration(false);
        showToast('Migration completed successfully', 'success');
      }
    } catch (error) {
      showToast(
        `Migration failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'error'
      );
      this.viewMode = 'preview'; // Go back to preview on error
    } finally {
      unifiedProfileStore.getState().setMigrating(false);
    }
  }

  private handleAssignmentChange(accountId: string, profileId: string): void {
    this.accountAssignments = {
      ...this.accountAssignments,
      [accountId]: profileId,
    };
  }

  private handleSkip(): void {
    // User chose to skip migration - just close and they can do it later
    this.handleClose();
  }

  private handleOpenProfileManager(): void {
    // Dispatch event to open profile manager
    this.dispatchEvent(
      new CustomEvent('open-profile-manager', {
        bubbles: true,
        composed: true,
      })
    );
    // D6: Close this dialog so it isn't left stacked behind the profile manager.
    // Dispatch first, then close, so the parent can open the manager as this one
    // closes (avoiding a flicker), mirroring the restore-backup ordering (D4).
    this.handleClose();
  }

  render() {
    if (!this.open) return nothing;

    return html`
      <div class="dialog-overlay">
        <div class="dialog">
          <div class="dialog-header">
            <div class="dialog-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
                <path d="M2 17l10 5 10-5"></path>
                <path d="M2 12l10 5 10-5"></path>
              </svg>
              ${this.getTitle()}
            </div>
          </div>
          <div class="dialog-content">${this.renderContent()}</div>
          <div class="dialog-footer">${this.renderFooter()}</div>
        </div>
      </div>
    `;
  }

  private getTitle(): string {
    switch (this.viewMode) {
      case 'intro':
        return 'Upgrade to Unified Profiles';
      case 'preview':
        return 'Review Migration';
      case 'migrating':
        return 'Migrating...';
      case 'complete':
        return 'Migration Complete';
    }
  }

  private renderContent() {
    switch (this.viewMode) {
      case 'intro':
        return this.renderIntro();
      case 'preview':
        return this.renderPreview();
      case 'migrating':
        return this.renderMigrating();
      case 'complete':
        return this.renderComplete();
    }
  }

  private renderIntro() {
    return html`
      <div class="intro-content">
        <svg class="intro-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
          <circle cx="12" cy="7" r="4"></circle>
          <path d="M16 11l2 2 4-4"></path>
        </svg>
        <div class="intro-title">Unified Profiles Are Here!</div>
        <div class="intro-description">
          We've improved how profiles and integration accounts work together.
          Now, switching profiles automatically switches your platform accounts too.
        </div>

        <div class="feature-list">
          <div class="feature-item">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            <span><strong>One switch, everything changes</strong> - Profile includes identity AND platform accounts</span>
          </div>
          <div class="feature-item">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            <span><strong>Multiple accounts per platform</strong> - Add several GitHub accounts to one profile</span>
          </div>
          <div class="feature-item">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            <span><strong>Smarter context</strong> - Integration dialogs only show relevant accounts</span>
          </div>
        </div>
      </div>
    `;
  }

  private renderPreview() {
    if (this.isLoading) {
      return html`
        <div class="migrating-content">
          <div class="spinner"></div>
          <div>Loading preview...</div>
        </div>
      `;
    }

    if (!this.preview) {
      return html`<div class="empty-preview">No migration data available</div>`;
    }

    const { profiles, unmatchedAccounts } = this.preview;

    if (profiles.length === 0 && unmatchedAccounts.length === 0) {
      return html`
        <div class="empty-preview">
          <p>No profiles or accounts to migrate.</p>
          <p style="font-size: var(--font-size-sm); margin-top: var(--spacing-sm);">
            You can create profiles from the profile manager first, then come back here.
          </p>
          <div style="margin-top: var(--spacing-md); display: flex; gap: var(--spacing-sm); justify-content: center;">
            <button class="btn" @click=${this.handleOpenProfileManager}>
              Open Profile Manager
            </button>
            <button class="btn" @click=${this.loadPreview}>
              Refresh
            </button>
          </div>
        </div>
      `;
    }

    return html`
      <div class="preview-section">
        <div class="section-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
            <circle cx="12" cy="7" r="4"></circle>
          </svg>
          Your Profiles
        </div>
        <div class="section-description">
          Each profile will include its matched integration accounts.
        </div>

        ${profiles.map((profile) => this.renderProfilePreview(profile))}

        ${profiles.length === 0
          ? html`<div class="empty-preview" style="padding: var(--spacing-md);">No existing profiles found</div>`
          : nothing}
      </div>

      ${unmatchedAccounts.length > 0
        ? html`
            <div class="preview-section">
              <div class="unmatched-section">
                <div class="unmatched-header">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="12"></line>
                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                  </svg>
                  Accounts Needing Assignment
                </div>
                ${profiles.length === 0
                  ? html`
                      <div class="section-description" style="color: var(--color-text-secondary); margin-bottom: var(--spacing-sm);">
                        These accounts will be migrated as shared global accounts. Create a
                        profile afterwards to set a default.
                      </div>
                      ${unmatchedAccounts.map((account) =>
                        this.renderUnmatchedAccount(account, profiles)
                      )}
                      <div style="margin-top: var(--spacing-sm);">
                        <button class="btn" @click=${this.handleOpenProfileManager}>
                          Open Profile Manager
                        </button>
                      </div>
                    `
                  : html`
                      <div class="section-description" style="color: var(--color-text-secondary); margin-bottom: var(--spacing-sm);">
                        These accounts couldn't be auto-matched. Choose which profile each should
                        belong to.
                      </div>
                      ${unmatchedAccounts.map((account) =>
                        this.renderUnmatchedAccount(account, profiles)
                      )}
                    `}
              </div>
            </div>
          `
        : nothing}
    `;
  }

  private renderProfilePreview(profile: MigrationPreviewProfile) {
    return html`
      <div class="profile-preview">
        <div class="profile-header">
          <div class="profile-color"></div>
          <div>
            <div class="profile-name">${profile.profileName}</div>
            <div class="profile-email">${profile.gitEmail}</div>
          </div>
        </div>
        <div class="matched-accounts">
          <div class="matched-accounts-title">Matched Accounts</div>
          ${profile.matchedAccounts.length > 0
            ? profile.matchedAccounts.map(
                (account) => html`
                  <span class="account-tag">
                    ${account.accountName}
                    <span class="type">${INTEGRATION_TYPE_NAMES[account.integrationType]}</span>
                  </span>
                `
              )
            : html`<div class="no-accounts">No accounts matched to this profile</div>`}
        </div>
      </div>
    `;
  }

  private renderUnmatchedAccount(
    account: UnmatchedAccount,
    profiles: MigrationPreviewProfile[]
  ) {
    const selectedProfileId = this.accountAssignments[account.accountId] || '';
    return html`
      <div class="unmatched-item">
        <div class="unmatched-account-info">
          <div>
            <div class="unmatched-account-name">${account.accountName}</div>
            <div class="unmatched-account-type">${INTEGRATION_TYPE_NAMES[account.integrationType]}</div>
          </div>
        </div>
        ${profiles.length === 0
          ? html`<span class="account-tag">Shared global account</span>`
          : html`
              <select
                class="profile-select"
                @change=${(e: Event) =>
                  this.handleAssignmentChange(
                    account.accountId,
                    (e.target as HTMLSelectElement).value
                  )}
              >
                ${profiles.map(
                  (profile) => html`
                    <option
                      value=${profile.profileId}
                      ?selected=${profile.profileId === selectedProfileId}
                    >${profile.profileName}</option>
                  `
                )}
              </select>
            `}
      </div>
    `;
  }

  private renderMigrating() {
    return html`
      <div class="migrating-content">
        <div class="spinner"></div>
        <div class="intro-title">Migrating Your Data</div>
        <div class="intro-description">
          Please wait while we upgrade your profiles and accounts...
        </div>
      </div>
    `;
  }

  private renderComplete() {
    const result = this.migrationResult;

    // Branch on the real success flag. A migration can complete with errors —
    // some items were skipped — and we must surface that instead of always
    // claiming success (which previously hid skipped items from the user).
    if (result && !result.success) {
      return this.renderCompleteWithErrors(result);
    }

    return html`
      <div class="complete-content">
        <svg class="success-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
          <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>
        <div class="intro-title">All Done!</div>
        <div class="intro-description">
          Your profiles and accounts have been unified. You can now manage everything
          from the profile manager.
        </div>

        ${result
          ? html`
              <div class="stats">
                <div class="stat">
                  <div class="stat-value">${result.profilesMigrated}</div>
                  <div class="stat-label">Profiles</div>
                </div>
                <div class="stat">
                  <div class="stat-value">${result.accountsMigrated}</div>
                  <div class="stat-label">Accounts</div>
                </div>
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private renderCompleteWithErrors(result: UnifiedMigrationResult) {
    return html`
      <div class="complete-content">
        <svg class="warning-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
          <line x1="12" y1="9" x2="12" y2="13"></line>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
        <div class="intro-title">Migration Completed With Issues</div>
        <div class="intro-description">
          We migrated ${result.profilesMigrated}
          ${result.profilesMigrated === 1 ? 'profile' : 'profiles'} and
          ${result.accountsMigrated}
          ${result.accountsMigrated === 1 ? 'account' : 'accounts'}, but
          ${result.errors.length} ${result.errors.length === 1 ? 'item' : 'items'}
          could not be migrated and ${result.errors.length === 1 ? 'was' : 'were'} skipped.
        </div>

        <div class="error-section">
          <div class="error-section-title">Skipped items</div>
          <ul class="error-list">
            ${result.errors.map((err) => html`<li class="error-item">${err}</li>`)}
          </ul>
        </div>
      </div>
    `;
  }

  private renderFooter() {
    switch (this.viewMode) {
      case 'intro':
        return html`
          <button class="btn btn-text" @click=${this.handleSkip}>Skip for now</button>
          <div class="footer-right">
            <button class="btn btn-primary" @click=${this.handleContinue} ?disabled=${this.isLoading}>
              ${this.isLoading ? 'Loading...' : 'Continue'}
            </button>
          </div>
        `;
      case 'preview':
        return html`
          <button class="btn btn-text" @click=${this.handleSkip}>Cancel</button>
          <div class="footer-right">
            <button class="btn btn-primary" @click=${this.handleContinue}>
              Start Migration
            </button>
          </div>
        `;
      case 'migrating':
        return html`
          <div></div>
          <div class="footer-right">
            <button class="btn btn-primary" disabled>Migrating...</button>
          </div>
        `;
      case 'complete': {
        const hadErrors = this.migrationResult ? !this.migrationResult.success : false;
        return html`
          <div></div>
          <div class="footer-right">
            ${hadErrors
              ? html`
                  <button class="btn" @click=${this.handleOpenProfileManager}>
                    Review in Profile Manager
                  </button>
                `
              : nothing}
            <button class="btn btn-primary" @click=${this.handleContinue}>Done</button>
          </div>
        `;
      }
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-migration-dialog': GnMigrationDialog;
  }
}
