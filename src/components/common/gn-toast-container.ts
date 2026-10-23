import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { uiStore, type Toast } from '../../stores/ui.store.ts';

/**
 * Toast notification container component
 * Renders toast notifications from the UI store
 */
@customElement('gn-toast-container')
export class GnToastContainer extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        position: fixed;
        bottom: var(--spacing-lg);
        right: var(--spacing-lg);
        z-index: var(--z-toast, 9999);
        display: flex;
        flex-direction: column-reverse;
        gap: var(--spacing-sm);
        pointer-events: none;
        max-width: 400px;
      }

      .toast {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        pointer-events: auto;
        animation: slideIn 0.2s ease-out;
        min-width: 280px;
      }

      .toast.exiting {
        animation: slideOut 0.2s ease-in forwards;
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

      @keyframes slideOut {
        from {
          opacity: 1;
          transform: translateX(0);
        }
        to {
          opacity: 0;
          transform: translateX(100%);
        }
      }

      .toast-icon {
        flex-shrink: 0;
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .toast-icon svg {
        width: 16px;
        height: 16px;
      }

      .toast.info .toast-icon {
        color: var(--color-primary);
      }

      .toast.success .toast-icon {
        color: var(--color-success);
      }

      .toast.warning .toast-icon {
        color: var(--color-warning);
      }

      .toast.error .toast-icon {
        color: var(--color-error);
      }

      .toast-content {
        flex: 1;
        min-width: 0;
      }

      .toast-message {
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
        word-wrap: break-word;
      }

      .toast-close {
        flex-shrink: 0;
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: none;
        background: transparent;
        color: var(--color-text-muted);
        cursor: pointer;
        border-radius: var(--radius-sm);
        transition: all var(--transition-fast);
        padding: 0;
      }

      .toast-close:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .toast-close svg {
        width: 14px;
        height: 14px;
      }

      .toast-action {
        margin-top: var(--spacing-xs);
      }

      .toast-action-btn {
        background: transparent;
        border: 1px solid var(--color-primary);
        color: var(--color-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-xs);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .toast-action-btn:hover {
        background: var(--color-primary);
        color: white;
      }

      /* Border colors by type */
      .toast.info {
        border-left: 3px solid var(--color-primary);
      }

      .toast.success {
        border-left: 3px solid var(--color-success);
      }

      .toast.warning {
        border-left: 3px solid var(--color-warning);
      }

      .toast.error {
        border-left: 3px solid var(--color-error);
      }
    `,
  ];

  @state() private toasts: Toast[] = [];
  @state() private exitingToasts: Set<string> = new Set();

  private unsubscribe?: () => void;
  private timeouts: Map<string, number> = new Map();
  /** Toast ids whose action has already run; see handleAction. */
  private firedActions: Set<string> = new Set();

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribe = uiStore.subscribe((state) => {
      const newToasts = state.toasts;

      // Set up auto-dismiss timers for new toasts
      newToasts.forEach((toast) => {
        if (!this.timeouts.has(toast.id)) {
          const duration = toast.duration ?? 5000;
          if (duration > 0) {
            const timeoutId = window.setTimeout(() => {
              this.dismissToast(toast.id);
            }, duration);
            this.timeouts.set(toast.id, timeoutId);
          }
        }
      });

      // Clean up timers for removed toasts
      this.timeouts.forEach((timeoutId, toastId) => {
        if (!newToasts.find((t) => t.id === toastId)) {
          window.clearTimeout(timeoutId);
          this.timeouts.delete(toastId);
        }
      });

      this.toasts = newToasts;
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();

    // Clear all timeouts
    this.timeouts.forEach((timeoutId) => {
      window.clearTimeout(timeoutId);
    });
    this.timeouts.clear();
  }

  private dismissToast(id: string): void {
    // Add to exiting set for animation
    this.exitingToasts = new Set([...this.exitingToasts, id]);
    this.requestUpdate();

    // Remove after animation
    setTimeout(() => {
      uiStore.getState().removeToast(id);
      this.exitingToasts.delete(id);
      this.firedActions.delete(id);
      this.requestUpdate();
    }, 200);
  }

  private handleClose(id: string): void {
    // Clear the auto-dismiss timer
    const timeoutId = this.timeouts.get(id);
    if (timeoutId) {
      window.clearTimeout(timeoutId);
      this.timeouts.delete(id);
    }
    this.dismissToast(id);
  }

  private getIcon(type: Toast['type']) {
    switch (type) {
      case 'info':
        return html`
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
        `;
      case 'success':
        return html`
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
        `;
      case 'warning':
        return html`
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
        `;
      case 'error':
        return html`
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
        `;
    }
  }

  private handleAction(toast: Toast): void {
    // Dismissal is animated: dismissToast only marks the toast `.exiting` and
    // removes it from the store 200ms later, and `.exiting` drives a slideOut
    // animation without pointer-events: none. So the action button stays
    // rendered and clickable after the first click, and a double-click fired
    // the action twice — which for the destructive ones (Force Push, Force Push
    // Tag, Force Delete) meant two native confirms for one gesture, the second
    // operating on something the first had already deleted or moved.
    //
    // Guarded here rather than in each handler so it covers every toast action,
    // including any added later.
    if (this.firedActions.has(toast.id)) return;
    this.firedActions.add(toast.id);
    if (toast.action?.callback) {
      toast.action.callback();
    }
    this.handleClose(toast.id);
  }

  render() {
    return html`
      <div aria-live="polite" aria-atomic="false">
      ${this.toasts.map(
        (toast) => html`
          <div
            class="toast ${toast.type} ${this.exitingToasts.has(toast.id) ? 'exiting' : ''}"
            role="${toast.type === 'error' ? 'alert' : 'status'}"
          >
            <div class="toast-icon">
              ${this.getIcon(toast.type)}
            </div>
            <div class="toast-content">
              <span class="toast-message">${toast.message}</span>
              ${toast.action ? html`
                <div class="toast-action">
                  <button
                    class="toast-action-btn"
                    @click=${() => this.handleAction(toast)}
                  >
                    ${toast.action.label}
                  </button>
                </div>
              ` : ''}
            </div>
            <button
              class="toast-close"
              @click=${() => this.handleClose(toast.id)}
              title="Dismiss"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        `
      )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-toast-container': GnToastContainer;
  }
}
