/**
 * Profile Card Component
 * Displays active profile information including git identity
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import type { UnifiedProfile, ProfileAssignmentSource } from '../../types/unified-profile.types.ts';

@customElement('gn-profile-card')
export class GnProfileCard extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .card {
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        padding: var(--spacing-md);
        transition: all var(--transition-fast);
        position: relative;
        overflow: hidden;
      }

      .card:hover {
        border-color: var(--color-border-strong);
        box-shadow: var(--shadow-sm);
      }

      .card-accent {
        position: absolute;
        top: 0;
        left: 0;
        bottom: 0;
        width: 4px;
      }

      .card-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        margin-bottom: var(--spacing-sm);
      }

      .profile-info {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        min-width: 0;
      }

      .profile-dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .profile-name {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
      }

      .default-badge {
        display: inline-flex;
        align-items: center;
        padding: 2px 6px;
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        color: var(--color-accent);
        background: var(--color-accent-bg);
        border-radius: var(--radius-sm);
      }

      .edit-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-tertiary);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .edit-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .edit-btn svg {
        width: 14px;
        height: 14px;
      }

      .git-identity {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        margin-left: var(--spacing-lg);
      }

      .identity-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        font-size: var(--font-size-xs);
      }

      .identity-label {
        color: var(--color-text-tertiary);
        min-width: 50px;
      }

      .identity-value {
        color: var(--color-text-secondary);
        font-family: var(--font-family-mono);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .signing-key {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .signing-key.configured {
        color: var(--color-success);
      }

      .signing-key.not-configured {
        color: var(--color-text-tertiary);
      }

      .signing-key svg {
        width: 12px;
        height: 12px;
      }

      .assignment-source {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        margin-top: var(--spacing-sm);
        margin-left: var(--spacing-lg);
        font-size: var(--font-size-xs);
        color: var(--color-text-tertiary);
      }

      .assignment-source svg {
        width: 12px;
        height: 12px;
      }

      /* Fallback (no rule matched) is even softer — italic to read as an
         explanation rather than an assignment rule. */
      .assignment-source.fallback {
        font-style: italic;
      }

      /* Empty state */
      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-lg);
        text-align: center;
      }

      .empty-icon {
        width: 32px;
        height: 32px;
        color: var(--color-text-tertiary);
        margin-bottom: var(--spacing-sm);
      }

      .empty-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-xs);
      }

      .empty-description {
        font-size: var(--font-size-xs);
        color: var(--color-text-tertiary);
        margin-bottom: var(--spacing-md);
      }

      .setup-btn {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--color-accent);
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-accent);
        font-size: var(--font-size-xs);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .setup-btn:hover {
        background: var(--color-accent);
        color: white;
      }

      .setup-btn svg {
        width: 12px;
        height: 12px;
      }
    `,
  ];

  @property({ type: Object }) profile: UnifiedProfile | null = null;
  @property({ type: String }) assignmentSource: ProfileAssignmentSource = 'none';

  private handleEdit(): void {
    this.dispatchEvent(new CustomEvent('edit-profile', { bubbles: true, composed: true }));
  }

  private getAssignmentSourceLabel(): string {
    switch (this.assignmentSource) {
      case 'manual':
        return 'Manually assigned';
      case 'url-pattern':
        return 'Matched by URL pattern';
      case 'default':
        return 'Default profile';
      default:
        return '';
    }
  }

  private getAssignmentSourceIcon() {
    switch (this.assignmentSource) {
      case 'manual':
        // Pin icon
        return html`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182a.5.5 0 0 1-.707-.708l3.182-3.182L2.403 7.133a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z"/></svg>`;
      case 'url-pattern':
        // Link icon
        return html`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.715 6.542 3.343 7.914a3 3 0 1 0 4.243 4.243l1.828-1.829A3 3 0 0 0 8.586 5.5L8 6.086a1.002 1.002 0 0 0-.154.199 2 2 0 0 1 .861 3.337L6.88 11.45a2 2 0 1 1-2.83-2.83l.793-.792a4.018 4.018 0 0 1-.128-1.287z"/><path d="M6.586 4.672A3 3 0 0 0 7.414 9.5l.775-.776a2 2 0 0 1-.896-3.346L9.12 3.55a2 2 0 1 1 2.83 2.83l-.793.792c.112.42.155.855.128 1.287l1.372-1.372a3 3 0 1 0-4.243-4.243L6.586 4.672z"/></svg>`;
      case 'default':
        // Star icon
        return html`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/></svg>`;
      default:
        return nothing;
    }
  }

  render() {
    if (!this.profile) {
      return html`
        <div class="card">
          <div class="empty-state">
            <svg class="empty-icon" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/>
              <path fill-rule="evenodd" d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm8-7a7 7 0 0 0-5.468 11.37C3.242 11.226 4.805 10 8 10s4.757 1.225 5.468 2.37A7 7 0 0 0 8 1z"/>
            </svg>
            <div class="empty-title">No Profile Active</div>
            <div class="empty-description">Set up a profile to manage your git identity</div>
            <button class="setup-btn" @click=${this.handleEdit}>
              <svg viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2Z"/>
              </svg>
              Set Up Profile
            </button>
          </div>
        </div>
      `;
    }

    return html`
      <div class="card">
        <div class="card-accent" style="background: ${this.profile.color}"></div>

        <div class="card-header">
          <div class="profile-info">
            <div class="profile-dot" style="background: ${this.profile.color}"></div>
            <span class="profile-name">${this.profile.name}</span>
            ${this.profile.isDefault
              ? html`<span class="default-badge">Default</span>`
              : nothing}
          </div>
          <button class="edit-btn" @click=${this.handleEdit} title="Edit profile">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/>
            </svg>
          </button>
        </div>

        <div class="git-identity">
          <div class="identity-row">
            <span class="identity-label">Name</span>
            <span class="identity-value">${this.profile.gitName}</span>
          </div>
          <div class="identity-row">
            <span class="identity-label">Email</span>
            <span class="identity-value">${this.profile.gitEmail}</span>
          </div>
          <div class="identity-row">
            <span class="identity-label">GPG</span>
            ${this.profile.signingKey
              ? html`
                  <span class="signing-key configured">
                    <svg viewBox="0 0 16 16" fill="currentColor">
                      <path d="M12.354 4.354a.5.5 0 0 0-.708-.708L5 10.293 3.354 8.646a.5.5 0 1 0-.708.708l2 2a.5.5 0 0 0 .708 0l7-7z"/>
                    </svg>
                    Configured
                  </span>
                `
              : html`
                  <span class="signing-key not-configured">
                    Not configured
                  </span>
                `}
          </div>
        </div>

        ${this.assignmentSource !== 'none'
          ? html`
              <div class="assignment-source">
                ${this.getAssignmentSourceIcon()}
                <span>${this.getAssignmentSourceLabel()}</span>
              </div>
            `
          : html`
              <div class="assignment-source fallback">
                <span>Active — no rule matched (first available)</span>
              </div>
            `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-profile-card': GnProfileCard;
  }
}
