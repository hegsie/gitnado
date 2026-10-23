/**
 * GPG Dialog Component
 * Manage GPG signing configuration
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import type { GpgConfig, GpgKey, SshKey } from '../../services/git.service.ts';
import { getPlatform, type Platform } from '../../utils/platform.ts';
import { openExternalUrl } from '../../utils/external-link.ts';
import { pushOverlay, removeOverlay, isTopOverlay } from '../../utils/overlay-stack.ts';
import '../common/gn-toggle.ts';

type SetupStep = 'install-guide' | 'generate-guide' | 'configure' | 'complete';

@customElement('gn-gpg-dialog')
export class GnGpgDialog extends LitElement {
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

      .dialog {
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        width: 500px;
        max-height: 80vh;
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

      .dialog-content {
        flex: 1;
        overflow-y: auto;
        padding: var(--spacing-md);
      }

      .dialog-footer {
        display: flex;
        justify-content: flex-end;
        gap: var(--spacing-sm);
        padding: var(--spacing-md);
        border-top: 1px solid var(--color-border);
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

      /* Status section */
      .status-section {
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-md);
        padding: var(--spacing-md);
        margin-bottom: var(--spacing-md);
      }

      .status-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .status-label {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .status-value {
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
      }

      .status-badge {
        padding: 2px 8px;
        border-radius: var(--radius-xs);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
      }

      .status-badge.available {
        background: var(--color-success-bg);
        color: var(--color-success);
      }

      .status-badge.unavailable {
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      /* Section */
      .section {
        margin-bottom: var(--spacing-lg);
      }

      .section-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-sm);
      }

      /* Toggle */
      .toggle-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm) 0;
        border-bottom: 1px solid var(--color-border);
      }

      .toggle-row:last-child {
        border-bottom: none;
      }

      .toggle-label {
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
      }

      .toggle-desc {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        margin-top: 2px;
      }

      /* Keep the switch's previous look: a tinted track with a border and a
         muted knob that turns white once the switch is on. */
      gn-toggle {
        --gn-toggle-track-bg: var(--color-bg-tertiary);
        --gn-toggle-track-border: var(--color-border);
        --gn-toggle-knob-bg: var(--color-text-muted);
        --gn-toggle-knob-bg-checked: #ffffff;
      }

      /* Key list */
      .key-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .key-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm);
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .key-item:hover {
        background: var(--color-bg-hover);
      }

      .key-item.selected {
        border-color: var(--color-primary);
        background: rgba(59, 130, 246, 0.05);
      }

      .key-radio {
        width: 16px;
        height: 16px;
        border: 2px solid var(--color-border);
        border-radius: 50%;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .key-item.selected .key-radio {
        border-color: var(--color-primary);
      }

      .key-item.selected .key-radio::after {
        content: "";
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--color-primary);
      }

      .key-info {
        flex: 1;
        min-width: 0;
      }

      .key-user {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .key-details {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        font-family: var(--font-family-mono);
      }

      .key-badge {
        padding: 2px 6px;
        border-radius: var(--radius-xs);
        font-size: var(--font-size-xs);
        background: var(--color-bg-tertiary);
        color: var(--color-text-secondary);
      }

      .empty-text {
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
        text-align: center;
        padding: var(--spacing-md);
      }

      /* Buttons */
      .btn {
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .btn-secondary {
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        color: var(--color-text-primary);
      }

      .btn-secondary:hover {
        background: var(--color-bg-hover);
      }

      .btn-primary {
        background: var(--color-primary);
        border: 1px solid var(--color-primary);
        color: white;
      }

      .btn-primary:hover {
        background: var(--color-primary-hover);
      }

      .message {
        padding: var(--spacing-sm);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-sm);
        margin-bottom: var(--spacing-md);
      }

      .message.error {
        background: var(--color-error-bg);
        border: 1px solid var(--color-error);
        color: var(--color-error);
      }

      .message.success {
        background: var(--color-success-bg);
        border: 1px solid var(--color-success);
        color: var(--color-success);
      }

      .message.warning {
        background: rgba(245, 158, 11, 0.1);
        border: 1px solid rgb(245, 158, 11);
        color: rgb(245, 158, 11);
      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-lg);
        color: var(--color-text-secondary);
      }

      /* Scope toggle */
      .scope-toggle {
        display: flex;
        gap: var(--spacing-xs);
        margin-bottom: var(--spacing-md);
      }

      .scope-btn {
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-border);
        background: var(--color-bg-secondary);
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        border-radius: var(--radius-sm);
        cursor: pointer;
      }

      .scope-btn.active {
        background: var(--color-primary);
        border-color: var(--color-primary);
        color: white;
      }

      /* Setup wizard styles */
      .setup-header {
        text-align: center;
        margin-bottom: var(--spacing-lg);
      }

      .setup-icon {
        width: 48px;
        height: 48px;
        margin: 0 auto var(--spacing-md);
        color: var(--color-primary);
      }

      .setup-title {
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-semibold);
        margin-bottom: var(--spacing-xs);
      }

      .setup-description {
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        line-height: 1.5;
      }

      /* Install method cards */
      .install-methods {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        margin-top: var(--spacing-md);
      }

      .install-method {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-md);
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        transition: all var(--transition-fast);
      }

      .install-method:hover {
        border-color: var(--color-primary);
        background: var(--color-bg-hover);
      }

      .method-info {
        flex: 1;
        min-width: 0;
      }

      .method-name {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        margin-bottom: 2px;
      }

      .method-desc {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .method-action {
        flex-shrink: 0;
        margin-left: var(--spacing-md);
      }

      /* Command block with copy */
      .command-block {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        font-family: var(--font-family-mono);
        font-size: var(--font-size-sm);
      }

      .command-block code {
        flex: 1;
        color: var(--color-text-primary);
        word-break: break-all;
      }

      .copy-btn {
        flex-shrink: 0;
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-xs);
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .copy-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .copy-btn.copied {
        background: var(--color-success-bg);
        border-color: var(--color-success);
        color: var(--color-success);
      }

      /* External link button */
      .link-btn {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-primary);
        border: none;
        border-radius: var(--radius-sm);
        color: white;
        font-size: var(--font-size-xs);
        cursor: pointer;
        text-decoration: none;
        transition: all var(--transition-fast);
      }

      .link-btn:hover {
        background: var(--color-primary-hover);
      }

      /* Guide section */
      .guide-section {
        margin-top: var(--spacing-lg);
        padding-top: var(--spacing-lg);
        border-top: 1px solid var(--color-border);
      }

      .guide-section-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        margin-bottom: var(--spacing-sm);
      }

      .guide-text {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        line-height: 1.5;
        margin-bottom: var(--spacing-sm);
      }

      .guide-list {
        margin: var(--spacing-sm) 0;
        padding-left: var(--spacing-lg);
      }

      .guide-list li {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-xs);
        line-height: 1.5;
      }

      .guide-list li strong {
        color: var(--color-text-primary);
      }

      /* External links */
      .external-links {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-sm);
        margin-top: var(--spacing-md);
      }

      .external-link {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-primary);
        font-size: var(--font-size-xs);
        text-decoration: none;
        transition: all var(--transition-fast);
        cursor: pointer;
      }

      .external-link:hover {
        border-color: var(--color-primary);
        color: var(--color-primary);
      }

      /* Complete step */
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

      .complete-title {
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
        margin-bottom: var(--spacing-sm);
      }

      .complete-description {
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
      }

      /* Dialog footer adjustments for wizard */
      .dialog-footer.wizard {
        justify-content: space-between;
      }

      .footer-left {
        display: flex;
        gap: var(--spacing-sm);
      }

      .footer-right {
        display: flex;
        gap: var(--spacing-sm);
      }

      .btn-text {
        background: none;
        border: none;
        color: var(--color-text-secondary);
        padding: var(--spacing-sm) var(--spacing-md);
        cursor: pointer;
        font-size: var(--font-size-sm);
      }

      .btn-text:hover {
        color: var(--color-text-primary);
      }
    `,
  ];

  @property({ type: Boolean }) open = false;
  @property({ type: String }) repositoryPath = '';

  @state() private config: GpgConfig | null = null;
  @state() private keys: GpgKey[] = [];
  @state() private sshKeys: SshKey[] = [];
  @state() private selectedKey: string | null = null;
  @state() private loading = false;
  @state() private error = '';
  @state() private success = '';
  @state() private globalScope = false;
  @state() private setupMode = false;
  @state() private setupStep: SetupStep = 'install-guide';
  @state() private platform: Platform = 'unknown';
  @state() private copyFeedback: string | null = null;

  /**
   * This dialog paints its own overlay instead of using gn-modal, so it had no
   * Escape handling at all — and app-shell's Escape chain now stops at the
   * dialog layer (so a keypress cannot also close the diff behind it), which
   * made Escape a completely dead key here. Dismiss like every sibling.
   */
  private handleKeyDown = (e: KeyboardEvent): void => {
    // Only the topmost overlay owns Escape: every dialog listens on
    // `document`, so without this one keypress ran all of them.
    if (!this.open || !isTopOverlay(this)) return;
    if (e.key === 'Escape') {
      this.handleClose();
    }
  };

  async connectedCallback(): Promise<void> {
    super.connectedCallback();
    document.addEventListener('keydown', this.handleKeyDown);
    if (this.open) {
      await this.loadData();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    removeOverlay(this);
    document.removeEventListener('keydown', this.handleKeyDown);
  }

  /**
   * Repo captured when the dialog opened. `repositoryPath` is live-bound to
   * the ACTIVE repository and rebinds the instant the user Ctrl+Tabs — a
   * document-level shortcut this dialog's overlay does not block — while the
   * data on screen still belongs to the repo that was active at open. Every
   * read and every mutation must use THIS value, or the dialog acts on a
   * repository the user is not looking at.
   */
  private pinnedRepoPath = '';

  /** The repo this dialog is pinned to while open, or null when closed. */
  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.open ? this.pinnedRepoPath : null;
  }

  async updated(changedProperties: Map<string, unknown>): Promise<void> {
    // Announce/withdraw overlay ownership of Escape.
    if (changedProperties.has('open')) {
      if (this.open) { pushOverlay(this); } else { removeOverlay(this); }
    }
    if (changedProperties.has('open') && this.open) {
      this.pinnedRepoPath = this.repositoryPath;
      // Cleared on the OPEN transition, not in loadData(): the loaders run
      // AFTER a handler has set its message (handleRefreshAndCheck calls one
      // directly), so clearing there would blank the result the user just
      // asked for. This dialog stays mounted (app-shell only toggles ?open),
      // so without this `success` survived close/reopen — and a Ctrl+Tab in
      // between replayed "Commit signing enabled" over a DIFFERENT
      // repository's settings.
      this.success = '';
      this.error = '';
      await this.loadData();
    }
  }

  private async loadData(): Promise<void> {
    this.loading = true;
    this.error = '';
    this.platform = getPlatform();

    const [configResult, keysResult] = await Promise.all([
      gitService.getGpgConfig(this.pinnedRepoPath),
      gitService.getGpgKeys(this.pinnedRepoPath),
    ]);

    if (configResult.success && configResult.data) {
      this.config = configResult.data;
      this.selectedKey = configResult.data.signingKey;
    } else {
      this.error = configResult.error?.message || 'Failed to load GPG config';
    }

    if (keysResult.success && keysResult.data) {
      this.keys = keysResult.data;
    }

    // gpg.format=ssh means git signs with an SSH key and never consults the
    // GPG keyring, so the list of keys to choose from has to come from ~/.ssh.
    if (this.config?.gpgFormat === 'ssh') {
      const sshResult = await gitService.getSshKeys();
      if (sshResult.success && sshResult.data) {
        this.sshKeys = sshResult.data;
      } else {
        this.sshKeys = [];
        // Never silent: without a key list this step has nothing to offer.
        // Keeps an earlier config-load error rather than overwriting it.
        if (!this.error) {
          this.error = sshResult.error?.message || 'Failed to load SSH keys';
        }
      }
    } else {
      this.sshKeys = [];
    }

    // Auto-detect setup state
    this.detectSetupState();

    this.loading = false;
  }

  /** True when this repository signs with SSH (gpg.format=ssh) rather than GPG. */
  private get isSshFormat(): boolean {
    return this.config?.gpgFormat === 'ssh';
  }

  /**
   * Whether `key` is the key `user.signingkey` currently names. Git accepts
   * either the public or the private key path there, and the value may still
   * be the unexpanded "~/" form that the backend expands at sign time.
   */
  private isSshKeySelected(key: SshKey): boolean {
    const configured = (this.selectedKey ?? '').trim();
    if (!configured) return false;
    if (configured === key.publicPath || configured === key.path) return true;
    if (configured.startsWith('~/')) {
      const tail = configured.slice(1); // "/.ssh/id_ed25519.pub"
      return key.publicPath.endsWith(tail) || key.path.endsWith(tail);
    }
    return false;
  }

  private detectSetupState(): void {
    if (!this.config) {
      this.setupMode = false;
      return;
    }

    // SSH signing (gpg.format=ssh) does not use GPG or a GPG keyring at all — git
    // signs with the configured SSH key. A configured signing key is sufficient;
    // never push a working SSH signer into the "generate a GPG key" flow.
    if (this.config.gpgFormat === 'ssh') {
      if (this.config.signingKey) {
        this.setupMode = false;
      } else {
        this.setupMode = true;
        this.setupStep = 'configure';
      }
      return;
    }

    // Check if GPG is truly available (must have both available flag AND version)
    const gpgTrulyAvailable = this.config.gpgAvailable && !!this.config.gpgVersion;

    if (!gpgTrulyAvailable) {
      // GPG not installed or not properly detected
      this.setupMode = true;
      this.setupStep = 'install-guide';
    } else if (this.keys.length === 0) {
      // GPG installed but no keys
      this.setupMode = true;
      this.setupStep = 'generate-guide';
    } else if (!this.config.signingKey) {
      // Keys exist but not configured
      this.setupMode = true;
      this.setupStep = 'configure';
    } else {
      // Everything is configured
      this.setupMode = false;
    }
  }

  private async handleToggleCommitSigning(): Promise<void> {
    if (!this.config) return;

    this.loading = true;
    this.error = '';
    // Cleared with `error`, not left behind: without this a failing tag-signing
    // toggle rendered its red banner directly under the stale green
    // "Commit signing enabled" from the previous click.
    this.success = '';

    const result = await gitService.setCommitSigning(
      this.pinnedRepoPath,
      !this.config.signCommits,
      this.globalScope
    );

    if (result.success) {
      this.config = { ...this.config, signCommits: !this.config.signCommits };
      this.success = `Commit signing ${this.config.signCommits ? 'enabled' : 'disabled'}`;
      this.dispatchEvent(new CustomEvent('gpg-changed', {
        detail: { repositoryPath: this.pinnedRepoPath || this.repositoryPath },
      }));
    } else {
      this.error = result.error?.message || 'Failed to update setting';
    }

    this.loading = false;
  }

  private async handleToggleTagSigning(): Promise<void> {
    if (!this.config) return;

    this.loading = true;
    this.error = '';
    this.success = '';

    const result = await gitService.setTagSigning(
      this.pinnedRepoPath,
      !this.config.signTags,
      this.globalScope
    );

    if (result.success) {
      this.config = { ...this.config, signTags: !this.config.signTags };
      this.success = `Tag signing ${this.config.signTags ? 'enabled' : 'disabled'}`;
      this.dispatchEvent(new CustomEvent('gpg-changed', {
        detail: { repositoryPath: this.pinnedRepoPath || this.repositoryPath },
      }));
    } else {
      this.error = result.error?.message || 'Failed to update setting';
    }

    this.loading = false;
  }

  private async handleSelectKey(keyId: string): Promise<void> {
    this.loading = true;
    this.error = '';
    this.success = '';

    const result = await gitService.setSigningKey(
      this.pinnedRepoPath,
      keyId,
      this.globalScope
    );

    if (result.success) {
      this.selectedKey = keyId;
      this.success = 'Signing key updated';
      this.dispatchEvent(new CustomEvent('gpg-changed', {
        detail: { repositoryPath: this.pinnedRepoPath || this.repositoryPath },
      }));
    } else {
      this.error = result.error?.message || 'Failed to set signing key';
    }

    this.loading = false;
  }

  private handleClose(): void {
    this.dispatchEvent(new CustomEvent('close'));
  }

  render() {
    if (!this.open) return nothing;

    return html`
      <div class="dialog-overlay" @click=${this.handleClose}>
        <div class="dialog" @click=${(e: Event) => e.stopPropagation()}>
          <div class="dialog-header">
            <span class="dialog-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
              ${this.getDialogTitle()}
            </span>
            <button class="close-btn" @click=${this.handleClose}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>

          <div class="dialog-content">
            ${this.loading ? html`<div class="loading">Loading...</div>` : ''}

            ${this.error ? html`<div class="message error">${this.error}</div>` : ''}

            ${this.success ? html`<div class="message success">${this.success}</div>` : ''}

            ${!this.loading && this.config ? this.renderContent() : ''}
          </div>

          ${this.renderFooter()}
        </div>
      </div>
    `;
  }

  private getDialogTitle(): string {
    if (!this.setupMode) {
      return 'GPG Signing';
    }

    switch (this.setupStep) {
      case 'install-guide':
        return 'GPG Setup - Install GPG';
      case 'generate-guide':
        return 'GPG Setup - Generate Key';
      case 'configure':
        return this.isSshFormat
          ? 'SSH Signing Setup - Select Key'
          : 'GPG Setup - Select Key';
      case 'complete':
        return 'GPG Setup - Complete';
    }
  }

  private renderContent() {
    if (!this.config) return '';

    // Show setup wizard if in setup mode
    if (this.setupMode) {
      return this.renderSetupWizard();
    }

    // Show normal config view
    return this.renderNormalConfig();
  }

  private renderSetupWizard() {
    switch (this.setupStep) {
      case 'install-guide':
        return this.renderInstallGuide();
      case 'generate-guide':
        return this.renderKeyGenerationGuide();
      case 'configure':
        return this.renderConfigureStep();
      case 'complete':
        return this.renderSetupComplete();
    }
  }

  private renderInstallGuide() {
    return html`
      <div class="setup-header">
        <svg class="setup-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
          <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
          <line x1="12" y1="22.08" x2="12" y2="12"></line>
        </svg>
        <div class="setup-title">Install GPG</div>
        <div class="setup-description">
          GPG (GNU Privacy Guard) is required for signing commits and tags.
          Choose an installation method for your platform.
        </div>
      </div>

      ${this.renderPlatformInstallMethods()}
    `;
  }

  private renderPlatformInstallMethods() {
    switch (this.platform) {
      case 'macos':
        return this.renderMacOSInstallMethods();
      case 'windows':
        return this.renderWindowsInstallMethods();
      case 'linux':
        return this.renderLinuxInstallMethods();
      default:
        return this.renderGenericInstallMethods();
    }
  }

  private renderMacOSInstallMethods() {
    return html`
      <div class="install-methods">
        <div class="install-method">
          <div class="method-info">
            <div class="method-name">Homebrew</div>
            <div class="method-desc">Recommended for developers</div>
          </div>
          <div class="method-action">
            ${this.renderCommandBlock('brew install gnupg')}
          </div>
        </div>
        <div class="install-method">
          <div class="method-info">
            <div class="method-name">GPG Suite</div>
            <div class="method-desc">Full GUI application with keychain integration</div>
          </div>
          <div class="method-action">
            <button class="link-btn" @click=${() => openExternalUrl('https://gpgtools.org/')}>
              Download
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderWindowsInstallMethods() {
    return html`
      <div class="install-methods">
        <div class="install-method">
          <div class="method-info">
            <div class="method-name">Gpg4win</div>
            <div class="method-desc">Official Windows installer with GUI</div>
          </div>
          <div class="method-action">
            <button class="link-btn" @click=${() => openExternalUrl('https://www.gpg4win.org/')}>
              Download
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </button>
          </div>
        </div>
        <div class="install-method">
          <div class="method-info">
            <div class="method-name">Chocolatey</div>
            <div class="method-desc">Via package manager</div>
          </div>
          <div class="method-action">
            ${this.renderCommandBlock('choco install gpg4win')}
          </div>
        </div>
        <div class="install-method">
          <div class="method-info">
            <div class="method-name">winget</div>
            <div class="method-desc">Via Windows Package Manager</div>
          </div>
          <div class="method-action">
            ${this.renderCommandBlock('winget install GnuPG.Gpg4win')}
          </div>
        </div>
      </div>
    `;
  }

  private renderLinuxInstallMethods() {
    return html`
      <div class="install-methods">
        <div class="install-method">
          <div class="method-info">
            <div class="method-name">Debian / Ubuntu</div>
            <div class="method-desc">apt package manager</div>
          </div>
          <div class="method-action">
            ${this.renderCommandBlock('sudo apt install gnupg')}
          </div>
        </div>
        <div class="install-method">
          <div class="method-info">
            <div class="method-name">Fedora / RHEL</div>
            <div class="method-desc">dnf package manager</div>
          </div>
          <div class="method-action">
            ${this.renderCommandBlock('sudo dnf install gnupg2')}
          </div>
        </div>
        <div class="install-method">
          <div class="method-info">
            <div class="method-name">Arch Linux</div>
            <div class="method-desc">pacman package manager</div>
          </div>
          <div class="method-action">
            ${this.renderCommandBlock('sudo pacman -S gnupg')}
          </div>
        </div>
      </div>
    `;
  }

  private renderGenericInstallMethods() {
    return html`
      <div class="install-methods">
        <div class="install-method">
          <div class="method-info">
            <div class="method-name">GnuPG Website</div>
            <div class="method-desc">Download for your platform</div>
          </div>
          <div class="method-action">
            <button class="link-btn" @click=${() => openExternalUrl('https://gnupg.org/download/')}>
              Download
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderKeyGenerationGuide() {
    return html`
      <div class="setup-header">
        <svg class="setup-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path>
        </svg>
        <div class="setup-title">Generate a GPG Key</div>
        <div class="setup-description">
          Create a new GPG key pair for signing your Git commits and tags.
          Run this command in your terminal.
        </div>
      </div>

      ${this.renderCommandBlock('gpg --full-generate-key')}

      <div class="guide-section">
        <div class="guide-section-title">Recommended Settings</div>
        <ul class="guide-list">
          <li><strong>Key type:</strong> RSA and RSA (default) or ECC (Ed25519) for modern systems</li>
          <li><strong>Key size:</strong> 4096 bits for RSA</li>
          <li><strong>Expiration:</strong> 1-2 years recommended for security</li>
          <li><strong>Name/Email:</strong> Should match your Git identity</li>
        </ul>
      </div>

      <div class="guide-section">
        <div class="guide-section-title">After Generation</div>
        <div class="guide-text">
          List your keys to verify they were created:
        </div>
        ${this.renderCommandBlock('gpg --list-secret-keys --keyid-format=long')}
      </div>

      <div class="guide-section">
        <div class="guide-section-title">Platform Documentation</div>
        <div class="guide-text">
          For detailed instructions on adding your key to your platform:
        </div>
        <div class="external-links">
          <a class="external-link" @click=${() => openExternalUrl('https://docs.github.com/en/authentication/managing-commit-signature-verification')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
            </svg>
            GitHub Docs
          </a>
          <a class="external-link" @click=${() => openExternalUrl('https://docs.gitlab.com/ee/user/project/repository/signed_commits/gpg.html')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 0 1 4.82 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0 1 18.6 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.51L23 13.45a.84.84 0 0 1-.35.94z"/>
            </svg>
            GitLab Docs
          </a>
        </div>
      </div>
    `;
  }

  private renderConfigureStep() {
    // An SSH signer must pick an SSH key: writing a GPG key id into
    // user.signingkey while gpg.format=ssh makes every signed commit fail.
    if (this.isSshFormat) return this.renderSshConfigureStep();

    return html`
      <div class="setup-header">
        <svg class="setup-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
        <div class="setup-title">Select Your Signing Key</div>
        <div class="setup-description">
          Choose which GPG key to use for signing commits and tags.
        </div>
      </div>

      <div class="section">
        <div class="section-title">Available Keys</div>
        ${this.keys.length === 0
          ? html`
              <div class="empty-text">
                No GPG keys found. Please generate a key first.
              </div>
            `
          : html`
              <div class="key-list">
                ${this.keys.map(
                  (key) => html`
                    <div
                      class="key-item ${this.selectedKey === key.keyId || this.selectedKey === key.keyIdLong ? 'selected' : ''}"
                      @click=${() => this.handleSelectKey(key.keyIdLong)}
                    >
                      <div class="key-radio"></div>
                      <div class="key-info">
                        <div class="key-user">${key.userId || key.email}</div>
                        <div class="key-details">${key.keyType} ${key.keySize} / ${key.keyId}</div>
                      </div>
                      <span class="key-badge">${key.trust}</span>
                    </div>
                  `
                )}
              </div>
            `}
      </div>
    `;
  }

  private renderSshConfigureStep() {
    return html`
      <div class="setup-header">
        <svg class="setup-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
        <div class="setup-title">Select Your SSH Signing Key</div>
        <div class="setup-description">
          This repository signs with SSH (gpg.format=ssh), so Git needs an SSH
          key &mdash; not a GPG key. Choose one of your ~/.ssh keys.
        </div>
      </div>

      <div class="section">
        <div class="section-title">Available SSH Keys</div>
        ${this.renderSshKeyList()}
      </div>
    `;
  }

  /**
   * The ~/.ssh key picker, shared by the setup wizard and the normal view.
   * Selecting writes the PUBLIC key path into user.signingkey, which is what
   * git (and the backend's usability check) accepts for SSH signing.
   *
   * get_ssh_keys also lists a private key whose .pub file is missing (a known
   * key name is enough), and its publicPath then points at a file that does
   * not exist. Offering such a key would write that path into user.signingkey
   * and report success, while ssh_key_is_usable() rejects it and git fails
   * every signed commit with "failed to read ssh signing key" — so only keys
   * with readable public-key data are selectable.
   */
  private renderSshKeyList() {
    const usable = this.sshKeys.filter((key) => key.publicKey);
    const unusable = this.sshKeys.filter((key) => !key.publicKey);
    return html`
      ${usable.length === 0
        ? html`
            <div class="empty-text">
              No usable SSH keys found in ~/.ssh. Generate one, then refresh:
            </div>
            ${this.renderCommandBlock('ssh-keygen -t ed25519 -C "your@email.com"')}
          `
        : html`
            <div class="key-list">
              ${usable.map(
                (key) => html`
                  <div
                    class="key-item ${this.isSshKeySelected(key) ? 'selected' : ''}"
                    @click=${() => this.handleSelectKey(key.publicPath)}
                  >
                    <div class="key-radio"></div>
                    <div class="key-info">
                      <div class="key-user">${key.comment || key.name}</div>
                      <div class="key-details">${key.keyType} / ${key.fingerprint || key.publicPath}</div>
                    </div>
                    <span class="key-badge">${key.name}</span>
                  </div>
                `
              )}
            </div>
          `}
      ${unusable.length === 0
        ? nothing
        : html`
            <div class="empty-text unusable-keys">
              ${unusable.map((key) => key.name).join(', ')} cannot sign: no
              public key file in ~/.ssh. Recreate it from the private key, then
              refresh:
            </div>
            ${this.renderCommandBlock(
              `ssh-keygen -y -f ${unusable[0].path} > ${unusable[0].publicPath}`
            )}
          `}
    `;
  }

  private renderSetupComplete() {
    return html`
      <div class="complete-content">
        <svg class="success-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
          <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>
        <div class="complete-title">
          ${this.isSshFormat ? 'SSH Signing is Ready!' : 'GPG is Ready!'}
        </div>
        <div class="complete-description">
          Your ${this.isSshFormat ? 'SSH' : 'GPG'} signing is now configured. You
          can enable automatic commit signing in the settings below.
        </div>
      </div>
    `;
  }

  private renderNormalConfig() {
    if (!this.config) return '';

    return html`
      <div class="status-section">
        ${this.isSshFormat
          ? html`
              <div class="status-row">
                <span class="status-label">Signature Format</span>
                <span class="status-value">SSH</span>
              </div>
            `
          : html`
              <div class="status-row">
                <span class="status-label">GPG Status</span>
                <span class="status-badge available">Available</span>
              </div>
              <div class="status-row" style="margin-top: var(--spacing-xs);">
                <span class="status-label">Version</span>
                <span class="status-value">${this.config.gpgVersion || 'Unknown'}</span>
              </div>
            `}
      </div>

      <div class="scope-toggle">
        <button
          class="scope-btn ${!this.globalScope ? 'active' : ''}"
          @click=${() => { this.globalScope = false; }}
        >
          This Repository
        </button>
        <button
          class="scope-btn ${this.globalScope ? 'active' : ''}"
          @click=${() => { this.globalScope = true; }}
        >
          Global
        </button>
      </div>

      <div class="section">
        <div class="section-title">Signing Options</div>
        <div class="toggle-row">
          <div>
            <div class="toggle-label">Sign commits</div>
            <div class="toggle-desc">
              Automatically sign all commits with
              ${this.isSshFormat ? 'your SSH key' : 'GPG'}
            </div>
          </div>
          <gn-toggle
            label="Sign commits"
            description=${`Automatically sign all commits with ${this.isSshFormat ? 'your SSH key' : 'GPG'}`}
            .checked=${this.config.signCommits}
            ?disabled=${this.loading}
            @change=${this.handleToggleCommitSigning}
          ></gn-toggle>
        </div>
        <div class="toggle-row">
          <div>
            <div class="toggle-label">Sign tags</div>
            <div class="toggle-desc">
              Automatically sign all tags with
              ${this.isSshFormat ? 'your SSH key' : 'GPG'}
            </div>
          </div>
          <gn-toggle
            label="Sign tags"
            description=${`Automatically sign all tags with ${this.isSshFormat ? 'your SSH key' : 'GPG'}`}
            .checked=${this.config.signTags}
            ?disabled=${this.loading}
            @change=${this.handleToggleTagSigning}
          ></gn-toggle>
        </div>
      </div>

      <div class="section">
        <div class="section-title">
          ${this.isSshFormat ? 'Signing Key (SSH)' : 'Signing Key'}
        </div>
        ${this.isSshFormat
          ? this.renderSshKeyList()
          : this.keys.length === 0
          ? html`
              <div class="empty-text">
                No GPG keys found. Generate a key with:<br>
                <code style="font-size: var(--font-size-xs);">gpg --full-generate-key</code>
              </div>
            `
          : html`
              <div class="key-list">
                ${this.keys.map(
                  (key) => html`
                    <div
                      class="key-item ${this.selectedKey === key.keyId || this.selectedKey === key.keyIdLong ? 'selected' : ''}"
                      @click=${() => this.handleSelectKey(key.keyIdLong)}
                    >
                      <div class="key-radio"></div>
                      <div class="key-info">
                        <div class="key-user">${key.userId || key.email}</div>
                        <div class="key-details">${key.keyType} ${key.keySize} / ${key.keyId}</div>
                      </div>
                      <span class="key-badge">${key.trust}</span>
                    </div>
                  `
                )}
              </div>
            `}
      </div>
    `;
  }

  private renderCommandBlock(command: string) {
    const isCopied = this.copyFeedback === command;
    return html`
      <div class="command-block">
        <code>${command}</code>
        <button
          class="copy-btn ${isCopied ? 'copied' : ''}"
          @click=${() => this.copyToClipboard(command)}
        >
          ${isCopied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    `;
  }

  private renderFooter() {
    if (this.setupMode) {
      return this.renderSetupFooter();
    }

    return html`
      <div class="dialog-footer">
        <button class="btn btn-secondary" @click=${this.handleClose}>
          Close
        </button>
      </div>
    `;
  }

  private renderSetupFooter() {
    switch (this.setupStep) {
      case 'install-guide':
        return html`
          <div class="dialog-footer wizard">
            <div class="footer-left">
              <button class="btn-text" @click=${this.handleSkipSetup}>
                Skip Setup
              </button>
            </div>
            <div class="footer-right">
              <button class="btn btn-primary" @click=${this.handleRefreshAndCheck}>
                I've Installed GPG
              </button>
            </div>
          </div>
        `;
      case 'generate-guide':
        return html`
          <div class="dialog-footer wizard">
            <div class="footer-left">
              <button class="btn btn-secondary" @click=${this.handleSetupBack}>
                Back
              </button>
            </div>
            <div class="footer-right">
              <button class="btn btn-primary" @click=${this.handleRefreshAndCheck}>
                I've Generated a Key
              </button>
            </div>
          </div>
        `;
      case 'configure':
        return html`
          <div class="dialog-footer wizard">
            <div class="footer-left">
              ${
                // Back would lead to the GPG key-generation guide, which an SSH
                // signer must never be sent to. Refresh is what turns the
                // zero-key case into a real flow: run ssh-keygen in a terminal,
                // refresh, pick a key, complete.
                this.isSshFormat
                ? html`
                    <button class="btn btn-secondary" @click=${this.handleRefreshAndCheck}>
                      Refresh
                    </button>
                  `
                : html`
                    <button class="btn btn-secondary" @click=${this.handleSetupBack}>
                      Back
                    </button>
                  `}
            </div>
            <div class="footer-right">
              <button
                class="btn btn-primary"
                @click=${this.handleCompleteSetup}
                ?disabled=${!this.selectedKey}
              >
                Complete Setup
              </button>
            </div>
          </div>
        `;
      case 'complete':
        return html`
          <div class="dialog-footer wizard">
            <div class="footer-left"></div>
            <div class="footer-right">
              <button class="btn btn-primary" @click=${this.handleFinishSetup}>
                Done
              </button>
            </div>
          </div>
        `;
    }
  }

  private async copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copyFeedback = text;
      setTimeout(() => {
        this.copyFeedback = null;
      }, 2000);
    } catch {
      console.error('Failed to copy to clipboard');
    }
  }

  private handleSkipSetup(): void {
    this.setupMode = false;
  }

  private handleSetupBack(): void {
    // No Back for an SSH signer: every earlier step is GPG installation and
    // GPG key generation, neither of which applies when gpg.format=ssh.
    if (this.isSshFormat) return;
    switch (this.setupStep) {
      case 'generate-guide':
        this.setupStep = 'install-guide';
        break;
      case 'configure':
        this.setupStep = 'generate-guide';
        break;
    }
  }

  private async handleRefreshAndCheck(): Promise<void> {
    await this.loadData();
  }

  private handleCompleteSetup(): void {
    if (this.selectedKey) {
      this.setupStep = 'complete';
    }
  }

  private handleFinishSetup(): void {
    this.setupMode = false;
    this.dispatchEvent(new CustomEvent('gpg-changed', {
        detail: { repositoryPath: this.pinnedRepoPath || this.repositoryPath },
      }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-gpg-dialog': GnGpgDialog;
  }
}
