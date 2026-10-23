/**
 * Repository Card Component
 * Displays current repository context information
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import type { Repository, Branch, Remote } from '../../types/git.types.ts';
import type { IntegrationType, ProfileAssignmentSource } from '../../types/unified-profile.types.ts';

@customElement('gn-repository-card')
export class GnRepositoryCard extends LitElement {
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
      }

      .card:hover {
        border-color: var(--color-border-strong);
        box-shadow: var(--shadow-sm);
      }

      .card-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        margin-bottom: var(--spacing-sm);
      }

      .repo-info {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        min-width: 0;
      }

      .repo-icon {
        width: 24px;
        height: 24px;
        flex-shrink: 0;
        color: var(--color-text-secondary);
      }

      .repo-details {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }

      .repo-name {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .provider-icon {
        width: 14px;
        height: 14px;
        color: var(--color-text-tertiary);
      }

      .repo-path {
        font-size: var(--font-size-xs);
        color: var(--color-text-tertiary);
        font-family: var(--font-family-mono);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 220px;
      }

      /* Branch info */
      .branch-info {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        margin-top: var(--spacing-sm);
        padding-top: var(--spacing-sm);
        border-top: 1px solid var(--color-border);
      }

      .branch-icon {
        width: 14px;
        height: 14px;
        color: var(--color-text-tertiary);
      }

      .branch-name {
        font-size: var(--font-size-xs);
        font-family: var(--font-family-mono);
        color: var(--color-text-secondary);
        background: var(--color-bg-tertiary);
        padding: 2px 6px;
        border-radius: var(--radius-xs);
      }

      /* A detached HEAD is a state, not a branch, so nothing was rendered here
         for it and the card read as an ordinary checkout for as long as it
         lasted. */
      .branch-name.detached {
        background: var(--color-warning-bg);
        color: var(--color-warning);
      }

      .branch-icon.detached {
        color: var(--color-warning);
      }

      .remote-info {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        font-size: var(--font-size-xs);
        color: var(--color-text-tertiary);
      }

      .remote-icon {
        width: 12px;
        height: 12px;
      }

      /* Assignment info */
      .assignment-info {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        margin-top: var(--spacing-sm);
        font-size: var(--font-size-xs);
        color: var(--color-text-tertiary);
      }

      .assignment-icon {
        width: 12px;
        height: 12px;
      }
    `,
  ];

  @property({ type: Object }) repository: Repository | null = null;
  @property({ type: Object }) currentBranch: Branch | null = null;
  @property({ type: Array }) remotes: Remote[] = [];
  @property({ type: String }) assignmentSource: ProfileAssignmentSource = 'none';
  @property({ type: String }) detectedProvider: IntegrationType | null = null;

  private getProviderIcon(type: IntegrationType) {
    switch (type) {
      case 'github':
        return html`<svg class="provider-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;
      case 'gitlab':
        return html`<svg class="provider-icon" viewBox="0 0 16 16" fill="currentColor"><path d="m15.734 6.1-.022-.058L13.534.358a.568.568 0 0 0-.563-.356.583.583 0 0 0-.328.122.582.582 0 0 0-.193.294l-1.47 4.499H5.025l-1.47-4.5a.572.572 0 0 0-.193-.294.583.583 0 0 0-.328-.122.568.568 0 0 0-.563.357L.289 6.04l-.022.057a4.044 4.044 0 0 0 1.342 4.681l.007.006.02.014 3.318 2.485 1.642 1.242 1 .755a.672.672 0 0 0 .814 0l1-.755 1.642-1.242 3.338-2.5.009-.007a4.046 4.046 0 0 0 1.34-4.678z"/></svg>`;
      case 'azure-devops':
        return html`<svg class="provider-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M15 3.622v8.512L11.5 15l-5.425-1.975v1.958L3.004 10.97l8.951.7V4.005L15 3.622zm-2.984.428L6.994 1v2.001L2.383 4.356l-.383 8.087 1.575 1.557V6.563z"/></svg>`;
      case 'bitbucket':
        return html`<svg class="provider-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M.778 1.211a.768.768 0 0 0-.768.892l2.06 12.484a1.044 1.044 0 0 0 1.02.88h9.947c.396 0 .736-.282.803-.68l2.06-12.684a.768.768 0 0 0-.768-.892H.778zM9.69 10.6H6.344l-.9-4.801h5.15l-.904 4.8z"/></svg>`;
    }
  }

  private getAssignmentLabel(): string {
    switch (this.assignmentSource) {
      case 'manual':
        return 'Profile manually assigned';
      case 'url-pattern':
        return 'Profile matched by URL pattern';
      case 'default':
        return 'Using default profile';
      default:
        return '';
    }
  }

  private getAssignmentIcon() {
    switch (this.assignmentSource) {
      case 'manual':
        // Pin icon
        return html`<svg class="assignment-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182a.5.5 0 0 1-.707-.708l3.182-3.182L2.403 7.133a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z"/></svg>`;
      case 'url-pattern':
        // Link icon
        return html`<svg class="assignment-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M4.715 6.542 3.343 7.914a3 3 0 1 0 4.243 4.243l1.828-1.829A3 3 0 0 0 8.586 5.5L8 6.086a1.002 1.002 0 0 0-.154.199 2 2 0 0 1 .861 3.337L6.88 11.45a2 2 0 1 1-2.83-2.83l.793-.792a4.018 4.018 0 0 1-.128-1.287z"/><path d="M6.586 4.672A3 3 0 0 0 7.414 9.5l.775-.776a2 2 0 0 1-.896-3.346L9.12 3.55a2 2 0 1 1 2.83 2.83l-.793.792c.112.42.155.855.128 1.287l1.372-1.372a3 3 0 1 0-4.243-4.243L6.586 4.672z"/></svg>`;
      case 'default':
        // Star icon
        return html`<svg class="assignment-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/></svg>`;
      default:
        return nothing;
    }
  }

  private truncatePath(path: string): string {
    const maxLength = 40;
    if (path.length <= maxLength) return path;

    // Show the last part of the path
    const parts = path.split('/');
    let result = parts[parts.length - 1];
    let i = parts.length - 2;

    while (i >= 0 && result.length + parts[i].length + 1 < maxLength - 3) {
      result = parts[i] + '/' + result;
      i--;
    }

    return '...' + (result.startsWith('/') ? '' : '/') + result;
  }

  /**
   * In detached HEAD no branch carries `isHead`, so `currentBranch` is null and
   * the card rendered no ref at all. The backend reports the commit HEAD sits
   * on separately, because `headRef` is just 'HEAD' in that state.
   */
  private get detachedHeadOid(): string | null {
    return this.currentBranch ? null : (this.repository?.detachedHeadOid ?? null);
  }

  render() {
    if (!this.repository) {
      return nothing;
    }

    const primaryRemote = this.remotes.find((r) => r.name === 'origin') || this.remotes[0];
    const detachedHeadOid = this.detachedHeadOid;

    return html`
      <div class="card">
        <div class="card-header">
          <div class="repo-info">
            <svg class="repo-icon" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/>
            </svg>
            <div class="repo-details">
              <div class="repo-name">
                ${this.repository.name}
                ${this.detectedProvider ? this.getProviderIcon(this.detectedProvider) : nothing}
              </div>
              <span class="repo-path" title="${this.repository.path}">
                ${this.truncatePath(this.repository.path)}
              </span>
            </div>
          </div>
        </div>

        ${this.currentBranch || detachedHeadOid || primaryRemote
          ? html`
              <div class="branch-info">
                ${this.currentBranch
                  ? html`
                      <svg class="branch-icon" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/>
                      </svg>
                      <span class="branch-name">${this.currentBranch.name}</span>
                    `
                  : detachedHeadOid
                    ? html`
                        <svg class="branch-icon detached" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/>
                        </svg>
                        <span
                          class="branch-name detached"
                          title="HEAD is detached at ${detachedHeadOid}. New commits won't belong to any branch."
                          >Detached HEAD @ ${detachedHeadOid.slice(0, 7)}</span
                        >
                      `
                    : nothing}

                ${primaryRemote
                  ? html`
                      <div class="remote-info">
                        <svg class="remote-icon" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm9.78-2.22-3.5 3.5a.75.75 0 0 1-1.06-1.06l3.5-3.5a.75.75 0 0 1 1.06 1.06Zm-6.56 2.44 3.5 3.5a.75.75 0 0 1-1.06 1.06l-3.5-3.5a.75.75 0 1 1 1.06-1.06Z"/>
                        </svg>
                        <span>${primaryRemote.name}</span>
                      </div>
                    `
                  : nothing}
              </div>
            `
          : nothing}

        ${this.assignmentSource !== 'none'
          ? html`
              <div class="assignment-info">
                ${this.getAssignmentIcon()}
                <span>${this.getAssignmentLabel()}</span>
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-repository-card': GnRepositoryCard;
  }
}
