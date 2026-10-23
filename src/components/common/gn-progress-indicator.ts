/**
 * Progress Indicator Component
 * Shows ongoing operations with progress and cancellation support
 */

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import type { ProgressOperation } from '../../services/progress.service.ts';

// Re-export for backwards compatibility
export type { ProgressOperation } from '../../services/progress.service.ts';

@customElement('gn-progress-indicator')
export class GnProgressIndicator extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .progress-container {
        position: fixed;
        bottom: 16px;
        right: 16px;
        z-index: var(--z-toast, 250);
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-width: 320px;
      }

      .progress-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        animation: slideIn 0.2s ease-out;
      }

      @keyframes slideIn {
        from {
          opacity: 0;
          transform: translateX(100%);
        }
        to {
          opacity: 1;
          transform: translateX(0);
        }
      }

      .progress-icon {
        width: 20px;
        height: 20px;
        color: var(--color-primary);
        flex-shrink: 0;
      }

      .progress-icon.spinning {
        animation: spin 1s linear infinite;
      }

      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }

      .progress-content {
        flex: 1;
        min-width: 0;
      }

      .progress-message {
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
        margin-bottom: 4px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .progress-bar {
        height: 4px;
        background: var(--color-bg-tertiary);
        border-radius: 2px;
        overflow: hidden;
      }

      .progress-fill {
        height: 100%;
        background: var(--color-primary);
        border-radius: 2px;
        transition: width 0.2s ease;
      }

      .progress-fill.indeterminate {
        width: 30% !important;
        animation: indeterminate 1.5s ease-in-out infinite;
      }

      @keyframes indeterminate {
        0% { transform: translateX(-100%); }
        100% { transform: translateX(400%); }
      }

      /* Same reasoning as the global loading bar in app-shell: with motion
         reduced the sliding fill would end up parked off-screen, so show a
         static full-width fill instead of nothing. */
      @media (prefers-reduced-motion: reduce) {
        .progress-fill.indeterminate {
          width: 100% !important;
          transform: none;
        }
      }

      .cancel-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-muted);
        cursor: pointer;
        transition: all var(--transition-fast);
        flex-shrink: 0;
      }

      .cancel-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .cancel-btn svg {
        width: 14px;
        height: 14px;
      }

      .progress-percentage {
        display: flex;
        gap: 8px;
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        margin-top: 2px;
      }

      .progress-counts {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    `,
  ];

  @property({ type: Array }) operations: ProgressOperation[] = [];

  /** Bytes as the transfer line shows them — the units git itself uses. */
  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
  }

  /**
   * The "1,234 / 5,000 objects · 2.30 MiB" line, or '' when the backend has
   * not reported any counts for this operation yet (a local operation, or a
   * transfer the remote has not started).
   */
  private transferDetail(op: ProgressOperation): string {
    const { receivedObjects, totalObjects, receivedBytes } = op;
    if (receivedObjects === undefined) return '';
    const objects =
      totalObjects && totalObjects > 0
        ? `${receivedObjects.toLocaleString()} / ${totalObjects.toLocaleString()} objects`
        : `${receivedObjects.toLocaleString()} objects`;
    return receivedBytes ? `${objects} · ${this.formatBytes(receivedBytes)}` : objects;
  }

  private handleCancel(id: string): void {
    this.dispatchEvent(new CustomEvent('cancel-operation', {
      detail: { id },
      bubbles: true,
      composed: true,
    }));
  }

  private getIcon(type: ProgressOperation['type']) {
    switch (type) {
      case 'fetch':
      case 'pull':
        return html`
          <svg class="progress-icon spinning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 12a9 9 0 11-6.219-8.56"></path>
          </svg>
        `;
      case 'push':
        return html`
          <svg class="progress-icon spinning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 19V5M5 12l7-7 7 7"></path>
          </svg>
        `;
      case 'clone':
        return html`
          <svg class="progress-icon spinning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2"></rect>
            <path d="M12 8v8M8 12h8"></path>
          </svg>
        `;
      case 'checkout':
        return html`
          <svg class="progress-icon spinning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 20l-5.447-2.724A1 1 0 0 1 3 16.382V5.618a1 1 0 0 1 1.447-.894L9 7"></path>
            <path d="M15 4l5.447 2.724A1 1 0 0 1 21 7.618v10.764a1 1 0 0 1-1.447.894L15 17"></path>
          </svg>
        `;
      case 'rebase':
      case 'merge':
        return html`
          <svg class="progress-icon spinning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="18" cy="18" r="3"></circle>
            <circle cx="6" cy="6" r="3"></circle>
            <path d="M13 6h3a2 2 0 0 1 2 2v7"></path>
            <path d="M6 9v12"></path>
          </svg>
        `;
      default:
        return html`
          <svg class="progress-icon spinning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M12 6v6l4 2"></path>
          </svg>
        `;
    }
  }

  render() {
    if (this.operations.length === 0) {
      return html``;
    }

    return html`
      <div class="progress-container">
        ${this.operations.map(op => html`
          <div class="progress-item">
            ${this.getIcon(op.type)}
            <div class="progress-content">
              <div class="progress-message">${op.message}</div>
              <div class="progress-bar">
                <div
                  class="progress-fill ${op.progress === undefined ? 'indeterminate' : ''}"
                  style="width: ${op.progress ?? 0}%"
                ></div>
              </div>
              ${op.progress !== undefined || this.transferDetail(op) ? html`
                <div class="progress-percentage">
                  ${op.progress !== undefined ? html`<span class="progress-percent-value">${Math.round(op.progress)}%</span>` : ''}
                  ${this.transferDetail(op) ? html`<span class="progress-counts">${this.transferDetail(op)}</span>` : ''}
                </div>
              ` : ''}
            </div>
            ${op.cancellable ? html`
              <button
                class="cancel-btn"
                @click=${() => this.handleCancel(op.id)}
                title="Cancel"
                aria-label="Cancel ${op.type}"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            ` : ''}
          </div>
        `)}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-progress-indicator': GnProgressIndicator;
  }
}
