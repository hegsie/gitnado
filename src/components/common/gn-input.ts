import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { sharedStyles, inputStyles } from '../../styles/shared-styles.ts';

@customElement('gn-input')
export class GnInput extends LitElement {
  static styles = [
    sharedStyles,
    inputStyles,
    css`
      :host {
        display: block;
      }

      .input-wrapper {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      label {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
      }

      .input-container {
        position: relative;
        display: flex;
        align-items: center;
      }

      input {
        width: 100%;
        height: 32px;
        padding: 0 var(--spacing-sm);
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
        transition: border-color var(--transition-fast);
      }

      input:focus {
        outline: none;
        border-color: var(--color-primary);
      }

      input::placeholder {
        color: var(--color-text-muted);
      }

      input:disabled {
        background: var(--color-bg-tertiary);
        cursor: not-allowed;
      }

      .error input {
        border-color: var(--color-error);
      }

      .error-message {
        font-size: var(--font-size-xs);
        color: var(--color-error);
      }

      .prefix,
      .suffix {
        position: absolute;
        display: flex;
        align-items: center;
        color: var(--color-text-muted);
      }

      .prefix {
        left: var(--spacing-sm);
      }

      .suffix {
        right: var(--spacing-sm);
      }

      :host([prefix]) input {
        padding-left: calc(var(--spacing-sm) + 20px);
      }

      :host([suffix]) input {
        padding-right: calc(var(--spacing-sm) + 20px);
      }
    `,
  ];

  @property({ type: String }) label = '';
  @property({ type: String }) value = '';
  @property({ type: String }) placeholder = '';
  @property({ type: String }) type: 'text' | 'password' | 'email' | 'number' = 'text';
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) required = false;
  @property({ type: String }) error = '';
  @property({ type: String }) name = '';

  @query('input') private inputElement!: HTMLInputElement;

  render() {
    const inputId = this.name || 'gn-input';
    const errorId = `${inputId}-error`;

    return html`
      <div class="input-wrapper ${this.error ? 'error' : ''}">
        ${this.label ? html`<label for=${inputId}>${this.label}</label>` : ''}
        <div class="input-container">
          <slot name="prefix" class="prefix"></slot>
          <input
            id=${inputId}
            type=${this.type}
            .value=${this.value}
            placeholder=${this.placeholder}
            ?disabled=${this.disabled}
            ?required=${this.required}
            name=${this.name}
            aria-invalid=${this.error ? 'true' : nothing}
            aria-describedby=${this.error ? errorId : nothing}
            @input=${this._handleInput}
            @change=${this._handleChange}
          />
          <slot name="suffix" class="suffix"></slot>
        </div>
        ${this.error ? html`<span class="error-message" id=${errorId}>${this.error}</span>` : ''}
      </div>
    `;
  }

  private _handleInput(e: Event) {
    const target = e.target as HTMLInputElement;
    this.value = target.value;
    this.dispatchEvent(
      new CustomEvent('gn-input', {
        detail: { value: this.value },
        bubbles: true,
        composed: true,
      })
    );
  }

  private _handleChange(e: Event) {
    const target = e.target as HTMLInputElement;
    this.dispatchEvent(
      new CustomEvent('gn-change', {
        detail: { value: target.value },
        bubbles: true,
        composed: true,
      })
    );
  }

  focus() {
    this.inputElement?.focus();
  }

  blur() {
    this.inputElement?.blur();
  }

  select() {
    this.inputElement?.select();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-input': GnInput;
  }
}
