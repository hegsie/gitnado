/**
 * Integration Account Selector Component
 * Dropdown for quick account switching in integration dialogs
 * Uses global accounts from the unified profile store (v3)
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { unifiedProfileStore, getAccountsByType } from '../../stores/unified-profile.store.ts';
import type { IntegrationAccount, IntegrationType } from '../../types/unified-profile.types.ts';
import { ACCOUNT_COLORS, INTEGRATION_TYPE_NAMES } from '../../types/unified-profile.types.ts';

@customElement('lv-account-selector')
export class LvAccountSelector extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        position: relative;
      }

      .selector-container {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        margin-bottom: var(--spacing-md);
      }

      .selector-label {
        font-size: var(--font-size-xs);
        color: var(--color-text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .selector-btn {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        flex: 1;
        min-width: 0;
        height: 36px;
        padding: 0 var(--spacing-md);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-secondary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .selector-btn:hover:not(:disabled) {
        border-color: var(--color-border-hover);
        background: var(--color-bg-hover);
      }

      .selector-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .selector-btn svg {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
      }

      .account-indicator {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .account-avatar {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .account-info {
        flex: 1;
        min-width: 0;
        text-align: left;
      }

      .account-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .account-username {
        font-size: var(--font-size-xs);
        color: var(--color-text-tertiary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .chevron {
        opacity: 0.5;
        flex-shrink: 0;
        margin-left: auto;
      }

      .no-account {
        color: var(--color-text-tertiary);
        font-style: italic;
      }

      /* Dropdown */
      .dropdown {
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        margin-top: var(--spacing-xs);
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        z-index: var(--z-dropdown);
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

      .dropdown-item .account-color {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .dropdown-item .account-avatar-sm {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .dropdown-item .item-info {
        flex: 1;
        min-width: 0;
      }

      .dropdown-item .item-name {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .dropdown-item .item-detail {
        font-size: var(--font-size-xs);
        color: var(--color-text-tertiary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .dropdown-item .check-icon {
        color: var(--color-accent);
        flex-shrink: 0;
      }

      .dropdown-item .default-badge {
        font-size: var(--font-size-xs);
        padding: 1px 4px;
        background: var(--color-primary-bg);
        color: var(--color-primary);
        border-radius: var(--radius-sm);
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

      .dropdown-action.primary {
        color: var(--color-primary);
      }

      .empty-state {
        padding: var(--spacing-md);
        text-align: center;
        color: var(--color-text-tertiary);
        font-size: var(--font-size-sm);
      }
    `,
  ];

  @property({ type: String }) integrationType: IntegrationType = 'github';
  @property({ type: String }) selectedAccountId: string | null = null;
  @property({ type: Boolean }) compact = false;
  /**
   * Makes the whole selector inert: the dropdown cannot be opened and its
   * "Add Account" / "Manage Accounts…" actions neither fire nor dispatch.
   * A host that is busy (the clone dialog mid-clone) disables its picker,
   * and the picker's own controls honour that — this selector, nested inside
   * it, must too, or its account actions stay live while everything around
   * them is locked and can walk the user out of the operation in flight.
   */
  @property({ type: Boolean }) disabled = false;

  @state() private accounts: IntegrationAccount[] = [];
  @state() private isOpen = false;
  // D7: lightweight inline busy state so add/manage clicks aren't silent. We keep
  // this on the sub-dialog itself (a brief "Opening..." label) rather than
  // stacking a toast, since a parent dialog handles the actual navigation.
  @state() private pendingAction: 'add' | 'manage' | null = null;
  private pendingActionResetTimer: number | null = null;

  private unsubscribe?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    // Subscribe to unified profile store - get global accounts
    this.unsubscribe = unifiedProfileStore.subscribe(() => {
      this.accounts = getAccountsByType(this.integrationType);
    });

    // Initialize from current state
    this.accounts = getAccountsByType(this.integrationType);

    // Close dropdown when clicking outside
    document.addEventListener('click', this.handleDocumentClick);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    document.removeEventListener('click', this.handleDocumentClick);
    if (this.pendingActionResetTimer !== null) {
      clearTimeout(this.pendingActionResetTimer);
      this.pendingActionResetTimer = null;
    }
  }

  private handleDocumentClick = (e: MouseEvent): void => {
    if (!this.contains(e.target as Node)) {
      this.isOpen = false;
    }
  };

  willUpdate(changed: Map<PropertyKey, unknown>): void {
    // Disabled while the dropdown is up: fold it away, so the actions inside
    // it are not left on screen for a host that has locked everything else.
    if (changed.has('disabled') && this.disabled && this.isOpen) {
      this.isOpen = false;
      this.clearPendingAction();
    }
  }

  private toggleDropdown(e: Event): void {
    e.stopPropagation();
    if (this.disabled) return;
    this.isOpen = !this.isOpen;
    // Reopening the selector clears any stale "Opening…" busy state.
    if (this.isOpen) this.clearPendingAction();
  }

  /**
   * Show a brief inline busy state for an action that hands off to the parent
   * dialog. The parent's navigation normally supersedes this selector — but if
   * navigation is cancelled or fails, a safety timer clears the state so the
   * actions don't stay permanently disabled.
   */
  private flagPendingAction(action: 'add' | 'manage'): void {
    this.pendingAction = action;
    if (this.pendingActionResetTimer !== null) {
      clearTimeout(this.pendingActionResetTimer);
    }
    this.pendingActionResetTimer = window.setTimeout(() => {
      this.pendingAction = null;
      this.pendingActionResetTimer = null;
    }, 4000);
  }

  private clearPendingAction(): void {
    this.pendingAction = null;
    if (this.pendingActionResetTimer !== null) {
      clearTimeout(this.pendingActionResetTimer);
      this.pendingActionResetTimer = null;
    }
  }

  private handleSelectAccount(account: IntegrationAccount): void {
    this.isOpen = false;
    if (account.id === this.selectedAccountId) return;
    this.dispatchEvent(
      new CustomEvent('account-change', {
        detail: { account },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleAddAccount(): void {
    if (this.disabled) return;
    // D7: show a brief inline busy state before the parent opens the add flow.
    // Keep the dropdown open so the "Opening…" label is actually visible; the
    // parent dialog's navigation supersedes this selector shortly after.
    this.flagPendingAction('add');
    this.dispatchEvent(
      new CustomEvent('add-account', {
        detail: { integrationType: this.integrationType },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleManageAccounts(): void {
    if (this.disabled) return;
    // D7: show a brief inline busy state before the parent opens the manage flow.
    // Keep the dropdown open so the "Opening…" label is visible; the parent
    // dialog's navigation supersedes this selector shortly after.
    this.flagPendingAction('manage');
    this.dispatchEvent(
      new CustomEvent('manage-accounts', {
        detail: { integrationType: this.integrationType },
        bubbles: true,
        composed: true,
      })
    );
  }

  private get selectedAccount(): IntegrationAccount | null {
    if (!this.selectedAccountId) return null;
    return this.accounts.find((a) => a.id === this.selectedAccountId) ?? null;
  }

  render() {
    const integrationName = INTEGRATION_TYPE_NAMES[this.integrationType];

    return html`
      <div class="selector-container">
        <span class="selector-label">${integrationName} Account</span>
        <button
          class="selector-btn"
          @click=${this.toggleDropdown}
          ?disabled=${this.disabled}
          title="Select ${integrationName} Account"
        >
          ${this.renderSelectedAccount()}
          <svg
            class="chevron"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>
      </div>

      ${this.isOpen ? this.renderDropdown() : nothing}
    `;
  }

  private renderSelectedAccount() {
    const account = this.selectedAccount;

    if (!account) {
      return html`
        <span class="no-account">No account selected</span>
      `;
    }

    const color = account.color ?? ACCOUNT_COLORS[0];

    return html`
      ${account.cachedUser?.avatarUrl
        ? html`<img
            class="account-avatar"
            src="${account.cachedUser.avatarUrl}"
            alt=""
          />`
        : html`<span
            class="account-indicator"
            style="background: ${color}"
          ></span>`}
      <span class="account-info">
        <span class="account-name">${account.name}</span>
        ${account.cachedUser?.username
          ? html`<span class="account-username"
              >@${account.cachedUser.username}</span
            >`
          : nothing}
      </span>
    `;
  }

  private renderDropdown() {
    const integrationName = INTEGRATION_TYPE_NAMES[this.integrationType];

    return html`
      <div class="dropdown">
        <div class="dropdown-header">${integrationName} Accounts</div>
        ${this.accounts.length === 0
          ? html`<div class="empty-state">No accounts configured</div>`
          : this.accounts.map((account) => this.renderAccountItem(account))}
        <div class="dropdown-divider"></div>
        <button
          class="dropdown-action primary"
          @click=${this.handleAddAccount}
          ?disabled=${this.disabled || this.pendingAction !== null}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          ${this.pendingAction === 'add' ? 'Opening…' : 'Add Account'}
        </button>
        ${this.accounts.length > 0
          ? html`
              <button
                class="dropdown-action"
                @click=${this.handleManageAccounts}
                ?disabled=${this.disabled || this.pendingAction !== null}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <circle cx="12" cy="12" r="3"></circle>
                  <path
                    d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
                  ></path>
                </svg>
                ${this.pendingAction === 'manage' ? 'Opening…' : 'Manage Accounts...'}
              </button>
            `
          : nothing}
      </div>
    `;
  }

  private renderAccountItem(account: IntegrationAccount) {
    const isSelected = this.selectedAccountId === account.id;
    const color = account.color ?? ACCOUNT_COLORS[0];
    const displayLabel = account.name;
    const detail =
      account.cachedUser?.username ?? account.cachedUser?.email ?? '';

    return html`
      <button
        class="dropdown-item ${isSelected ? 'active' : ''}"
        @click=${() => this.handleSelectAccount(account)}
      >
        ${account.cachedUser?.avatarUrl
          ? html`<img
              class="account-avatar-sm"
              src="${account.cachedUser.avatarUrl}"
              alt=""
            />`
          : html`<span
              class="account-color"
              style="background: ${color}"
            ></span>`}
        <span class="item-info">
          <span class="item-name">
            ${displayLabel}
            ${account.isDefault
              ? html`<span class="default-badge">Default</span>`
              : nothing}
          </span>
          ${detail
            ? html`<span class="item-detail">@${detail}</span>`
            : nothing}
        </span>
        ${isSelected
          ? html`
              <svg
                class="check-icon"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            `
          : nothing}
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'lv-account-selector': LvAccountSelector;
  }
}
