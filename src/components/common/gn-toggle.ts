import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';

/**
 * Accessible on/off switch.
 *
 * `label` is required: it is the switch's accessible name. Call sites that
 * already render their own visible label (a `.setting-name`, a `.toggle-label`)
 * pass the same text here — it is rendered visually hidden inside the switch so
 * that every instance has a name in the accessibility tree, which the
 * hand-rolled `<label class="toggle-switch"><input type="checkbox">` markup this
 * replaces never had (the visible text was a sibling with no `for`/`id` link).
 *
 * This is a controlled component: it never writes to `checked` itself. It
 * reports the value the user asked for in the `change` event and the owner
 * writes it back through the `checked` property. Self-mutating would leave the
 * switch stuck in the wrong position whenever the owner rejects the change (a
 * failed `git config` write, say), because Lit's property binding dirty-checks
 * against the value it last committed and would then skip re-setting it.
 *
 * Appearance is themed through custom properties so each dialog keeps the exact
 * look it had before: `--gn-toggle-width`, `--gn-toggle-height`,
 * `--gn-toggle-track-bg`, `--gn-toggle-track-border`,
 * `--gn-toggle-track-bg-checked`, `--gn-toggle-track-border-checked`,
 * `--gn-toggle-knob-bg`, `--gn-toggle-knob-bg-checked`.
 */
@customElement('gn-toggle')
export class GnToggle extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: inline-flex;
        flex-shrink: 0;
      }

      .toggle-switch {
        position: relative;
        flex-shrink: 0;
        width: var(--gn-toggle-width, 40px);
        height: var(--gn-toggle-height, 22px);
        padding: 0;
        border: none;
        background: none;
        cursor: pointer;
      }

      .toggle-switch:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }

      .toggle-slider {
        position: absolute;
        inset: 0;
        border: 1px solid var(--gn-toggle-track-border, transparent);
        border-radius: calc(var(--gn-toggle-height, 22px) / 2);
        background: var(--gn-toggle-track-bg, var(--color-border));
        transition:
          background var(--transition-fast, 0.2s),
          border-color var(--transition-fast, 0.2s);
      }

      /* The knob is offset inside the track's padding box, so the 1px border
         (transparent by default) keeps the same 3px visual inset either way. */
      .toggle-slider::before {
        content: '';
        position: absolute;
        left: 2px;
        bottom: 2px;
        width: calc(var(--gn-toggle-height, 22px) - 6px);
        height: calc(var(--gn-toggle-height, 22px) - 6px);
        border-radius: 50%;
        background: var(--gn-toggle-knob-bg, var(--toggle-knob-color, #ffffff));
        transition:
          transform var(--transition-fast, 0.2s),
          background var(--transition-fast, 0.2s);
      }

      .toggle-switch[aria-checked='true'] .toggle-slider {
        background: var(--gn-toggle-track-bg-checked, var(--color-primary));
        border-color: var(--gn-toggle-track-border-checked, var(--color-primary));
      }

      .toggle-switch[aria-checked='true'] .toggle-slider::before {
        transform: translateX(
          calc(var(--gn-toggle-width, 40px) - var(--gn-toggle-height, 22px))
        );
        background: var(
          --gn-toggle-knob-bg-checked,
          var(--gn-toggle-knob-bg, var(--toggle-knob-color, #ffffff))
        );
      }
    `,
  ];

  /** Accessible name for the switch. Required — pass the visible label's text. */
  @property({ type: String }) label = '';
  @property({ type: Boolean, reflect: true }) checked = false;
  @property({ type: Boolean, reflect: true }) disabled = false;
  /** Optional longer explanation, exposed as the switch's description. */
  @property({ type: String }) description = '';

  @query('button') private button!: HTMLButtonElement;

  render() {
    return html`
      <button
        type="button"
        class="toggle-switch"
        role="switch"
        aria-checked=${this.checked ? 'true' : 'false'}
        aria-labelledby=${this.label ? 'gn-toggle-label' : nothing}
        aria-describedby=${this.description ? 'gn-toggle-description' : nothing}
        ?disabled=${this.disabled}
        @click=${this.handleClick}
        @keydown=${this.handleKeydown}
      >
        <span class="toggle-slider"></span>
      </button>
      ${this.label
        ? html`<span id="gn-toggle-label" class="visually-hidden">${this.label}</span>`
        : nothing}
      ${this.description
        ? html`<span id="gn-toggle-description" class="visually-hidden"
            >${this.description}</span
          >`
        : nothing}
    `;
  }

  private handleClick(): void {
    this.toggle();
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.key !== ' ' && e.key !== 'Spacebar' && e.key !== 'Enter') return;
    // Own the activation: preventDefault stops the browser synthesising the
    // click a <button> fires for Space/Enter, so one key press is one change.
    e.preventDefault();
    this.toggle();
  }

  private toggle(): void {
    if (this.disabled) return;
    this.dispatchEvent(
      new CustomEvent('change', {
        detail: { checked: !this.checked },
        bubbles: true,
        composed: true,
      })
    );
  }

  focus(options?: FocusOptions): void {
    this.button?.focus(options);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-toggle': GnToggle;
  }
}
