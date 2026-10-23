import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { sharedStyles, buttonStyles } from '../../styles/shared-styles.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

@customElement('gn-button')
export class GnButton extends LitElement {
  static styles = [
    sharedStyles,
    buttonStyles,
    css`
      :host {
        display: inline-block;
      }

      button {
        width: 100%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--spacing-xs);
        border-radius: var(--radius-md);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        transition: all var(--transition-fast);
        border: none;
      }

      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* Sizes */
      .size-sm {
        height: 28px;
        padding: 0 var(--spacing-sm);
        font-size: var(--font-size-xs);
      }

      .size-md {
        height: 32px;
        padding: 0 var(--spacing-md);
        font-size: var(--font-size-sm);
      }

      .size-lg {
        height: 40px;
        padding: 0 var(--spacing-lg);
        font-size: var(--font-size-md);
      }

      /* Variants */
      .variant-primary {
        background: var(--color-primary);
        color: var(--color-text-inverse);
      }

      .variant-primary:hover:not(:disabled) {
        background: var(--color-primary-hover);
      }

      .variant-secondary {
        background: var(--color-bg-tertiary);
        color: var(--color-text-primary);
      }

      .variant-secondary:hover:not(:disabled) {
        background: var(--color-bg-hover);
      }

      .variant-ghost {
        background: transparent;
        color: var(--color-text-primary);
      }

      .variant-ghost:hover:not(:disabled) {
        background: var(--color-bg-hover);
      }

      .variant-danger {
        background: var(--color-error);
        color: var(--color-text-inverse);
      }

      .variant-danger:hover:not(:disabled) {
        opacity: 0.9;
      }

      /* Icon only */
      .icon-only {
        padding: 0;
        aspect-ratio: 1;
      }
    `,
  ];

  @property({ type: String }) variant: ButtonVariant = 'secondary';
  @property({ type: String }) size: ButtonSize = 'md';
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean, attribute: 'icon-only' }) iconOnly = false;
  @property({ type: String }) type: 'button' | 'submit' | 'reset' = 'button';
  @property({ type: String, attribute: 'aria-label' }) ariaLabel = '';

  render() {
    const classes = [
      `variant-${this.variant}`,
      `size-${this.size}`,
      this.iconOnly ? 'icon-only' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return html`
      <button
        class=${classes}
        ?disabled=${this.disabled}
        type=${this.type}
        aria-label=${this.ariaLabel || nothing}
        @click=${this._handleClick}
      >
        <slot></slot>
      </button>
    `;
  }

  private _handleClick(e: Event) {
    if (this.disabled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-button': GnButton;
  }
}
