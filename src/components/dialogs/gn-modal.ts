/**
 * Base Modal Dialog Component
 * Provides a reusable modal overlay with customizable content
 */

import { LitElement, html, css, type PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { pushOverlay, removeOverlay, isTopOverlay } from '../../utils/overlay-stack.ts';
import { containsDeepActiveElement, deepActiveElement } from '../../utils/focus.ts';

@customElement('gn-modal')
export class GnModal extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: var(--z-modal, 200);
      }

      :host([open]) {
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(2px);
      }

      .dialog {
        position: relative;
        display: flex;
        flex-direction: column;
        max-height: 90vh;
        max-width: 90vw;
        min-width: 400px;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        overflow: hidden;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-md) var(--spacing-lg);
        border-bottom: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .title {
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
        margin: 0;
      }

      .close-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .close-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .close-btn svg {
        width: 16px;
        height: 16px;
      }

      .content {
        flex: 1;
        overflow-y: auto;
        padding: var(--spacing-lg);
      }

      .footer {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: var(--spacing-sm);
        padding: var(--spacing-md) var(--spacing-lg);
        border-top: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: String }) modalTitle = '';
  @property({ type: Boolean }) showClose = true;
  /**
   * When true, the header shows a back arrow (←) on the left instead of the close
   * (×) on the right. Used when the dialog was opened from another screen (e.g. the
   * profile manager) that it should return to. Still dispatches `close`.
   */
  @property({ type: Boolean }) backButton = false;

  private previouslyFocused: HTMLElement | null = null;

  private handleOverlayClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) {
      this.close();
    }
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    // This listener lives on `document` for the element's whole lifetime, but
    // host dialogs keep their <gn-modal> mounted while closed. Without this
    // check every closed modal in the tree answered each Escape press by
    // dispatching `close`, firing host handlers for dialogs the user was not
    // looking at. The Tab trap below already guarded on `open`.
    if (!this.open) return;

    // Only the topmost overlay owns Escape. Every dialog listens on
    // `document`, so without this one keypress ran all of them — dismissing
    // the command palette opened over another dialog dismissed that dialog
    // too, discarding whatever the user had built there.
    if (!isTopOverlay(this)) return;

    if (e.key === 'Escape') {
      this.close();
    }

    // Focus trap: cycle Tab within the modal
    if (e.key === 'Tab' && this.open) {
      const dialog = this.shadowRoot?.querySelector('.dialog') as HTMLElement;
      if (!dialog) return;

      const focusable = this.getFocusableElements(dialog);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      // deepActiveElement, not document.activeElement: every element in
      // `focusable` lives inside a shadow root (this one's, or a slotted
      // component's), while document.activeElement only ever names the
      // outermost custom element (<app-shell>). Comparing against it made
      // both arms permanently false, so the trap never engaged and Tab
      // walked out of the modal onto the live controls behind the backdrop.
      const active = deepActiveElement();

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  private getFocusableElements(container: HTMLElement): HTMLElement[] {
    const selector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const elements = Array.from(container.querySelectorAll(selector)) as HTMLElement[];
    // Also check slotted content
    const slots = container.querySelectorAll('slot');
    for (const slot of slots) {
      const assigned = slot.assignedElements({ flatten: true });
      for (const el of assigned) {
        if (el instanceof HTMLElement) {
          if (el.matches(selector)) elements.push(el);
          elements.push(...(Array.from(el.querySelectorAll(selector)) as HTMLElement[]));
        }
      }
    }
    return elements.filter(el => !el.hasAttribute('disabled') && getComputedStyle(el).display !== 'none');
  }

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this.handleKeyDown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.handleKeyDown);
    removeOverlay(this);
  }

  updated(changedProperties: PropertyValues): void {
    if (changedProperties.has('open')) {
      if (this.open) { pushOverlay(this); } else { removeOverlay(this); }
      if (this.open) {
        // Save the currently focused element for restoration. Same shadow-DOM
        // hazard as the Tab trap: document.activeElement would store
        // <app-shell>, which carries no tabindex, so the restore below was a
        // no-op and focus dropped to <body> on close.
        this.previouslyFocused = deepActiveElement() as HTMLElement | null;
        // Focus the dialog after render
        requestAnimationFrame(() => {
          // Do not override a host that already focused something of its own.
          // getFocusableElements queries this shadow root BEFORE walking the
          // slot, so index 0 is our own header close button — and this rAF
          // lands after a host's microtask focus, so it was silently stealing
          // focus from every slotted field. gn-prompt-dialog focused its text
          // input and lost it every time: typing a branch rename went to the
          // global shortcut handler instead, where "s" ran Stage All Changes.
          if (containsDeepActiveElement(this)) return;

          const dialog = this.shadowRoot?.querySelector('.dialog') as HTMLElement;
          if (dialog) {
            const focusable = this.getFocusableElements(dialog);
            if (focusable.length > 0) {
              focusable[0].focus();
            } else {
              dialog.focus();
            }
          }
        });
      } else {
        // Restore focus when closing
        const restore = this.previouslyFocused;
        this.previouslyFocused = null;
        if (restore?.isConnected) {
          restore.focus();
        }
      }
    }
  }

  public close(): void {
    this.open = false;
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  render() {
    return html`
      <div class="overlay" @click=${this.handleOverlayClick}></div>
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header class="header">
          <div class="header-left">
            ${this.backButton
              ? html`
                  <button class="close-btn" @click=${this.close} aria-label="Back" title="Back">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="15 18 9 12 15 6"></polyline>
                    </svg>
                  </button>
                `
              : ''}
            <h2 class="title" id="modal-title">${this.modalTitle}</h2>
          </div>
          ${this.showClose && !this.backButton
            ? html`
                <button class="close-btn" @click=${this.close} aria-label="Close">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              `
            : ''}
        </header>
        <div class="content">
          <slot></slot>
        </div>
        <footer class="footer">
          <slot name="footer"></slot>
        </footer>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-modal': GnModal;
  }
}
