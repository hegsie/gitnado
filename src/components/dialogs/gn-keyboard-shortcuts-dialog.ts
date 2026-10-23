/**
 * Keyboard Shortcuts Help Dialog
 * Shows all available keyboard shortcuts organized by category
 * Supports editing shortcuts by clicking on the key combination
 */

import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { keyboardService, type Shortcut, type ShortcutBinding } from '../../services/keyboard.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import { pushOverlay, removeOverlay, isTopOverlay } from '../../utils/overlay-stack.ts';
import '../common/gn-toggle.ts';

@customElement('gn-keyboard-shortcuts-dialog')
export class GnKeyboardShortcutsDialog extends LitElement {
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
        width: 600px;
        max-width: 90vw;
        max-height: 80vh;
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

      .header-icon {
        width: 20px;
        height: 20px;
        color: var(--color-primary);
      }

      .title {
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
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
        padding: var(--spacing-md);
      }

      .category {
        margin-bottom: var(--spacing-lg);
      }

      .category:last-child {
        margin-bottom: 0;
      }

      .category-title {
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: var(--spacing-sm);
        padding: 0 var(--spacing-xs);
      }

      .shortcuts-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .shortcut-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-md);
        transition: background var(--transition-fast);
      }

      .shortcut-row:hover {
        background: var(--color-bg-hover);
      }

      .shortcut-description {
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
      }

      .shortcut-keys {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .key {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 24px;
        height: 24px;
        padding: 0 6px;
        font-family: var(--font-mono);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        box-shadow: 0 1px 0 var(--color-border);
      }

      .key-separator {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm) var(--spacing-md);
        border-top: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .vim-toggle {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .vim-toggle label {
        cursor: pointer;
      }

      /* Keep the switch's previous look: 36x20 with a tinted, bordered track. */
      gn-toggle {
        --gn-toggle-width: 36px;
        --gn-toggle-height: 20px;
        --gn-toggle-track-bg: var(--color-bg-tertiary);
        --gn-toggle-track-border: var(--color-border);
        --gn-toggle-knob-bg: #ffffff;
      }

      /* Editable shortcut styles */
      .shortcut-keys.editable {
        cursor: pointer;
        border-radius: var(--radius-sm);
        padding: 2px 4px;
        margin: -2px -4px;
        transition: background var(--transition-fast);
      }

      .shortcut-keys.editable:hover {
        background: var(--color-bg-hover);
      }

      .shortcut-keys.recording {
        background: var(--color-primary);
        animation: pulse 1s infinite;
      }

      .shortcut-keys.recording .key {
        background: transparent;
        border-color: transparent;
        color: white;
        box-shadow: none;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.7; }
      }

      .shortcut-row.customized .shortcut-description::after {
        content: '*';
        color: var(--color-primary);
        margin-left: 4px;
      }

      .reset-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-muted);
        cursor: pointer;
        opacity: 0;
        transition: all var(--transition-fast);
        margin-left: 8px;
      }

      .shortcut-row:hover .reset-btn {
        opacity: 1;
      }

      .reset-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .reset-btn svg {
        width: 14px;
        height: 14px;
      }

      .header-actions {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .reset-all-btn {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        background: transparent;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        padding: 4px 8px;
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .reset-all-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .conflict-warning {
        color: var(--color-error);
        font-size: var(--font-size-xs);
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-error-bg);
        border-radius: var(--radius-sm);
        margin-top: var(--spacing-xs);
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: Boolean }) vimMode = false;

  /** ID of shortcut currently being edited */
  @state() private editingId: string | null = null;
  /** Recorded binding during edit mode */
  @state() private recordedBinding: ShortcutBinding | null = null;
  /** Error message for binding conflicts */
  @state() private conflictError: string | null = null;
  /** Tracks settings changes to force re-render */
  @state() private settingsVersion = 0;

  private settingsUnsubscribe?: () => void;

  updated(changedProps: Map<string, unknown>): void {
    // Announce/withdraw overlay ownership of Escape. Missing this made a
    // dialog opened over another one dismiss BOTH on a single keypress:
    // the one underneath was still stack-top, so its own guard passed.
    if (changedProps.has('open')) {
      if (this.open) { pushOverlay(this); } else { removeOverlay(this); }
    }
  }

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this.handleKeyDown);
    // Subscribe to settings changes
    this.settingsUnsubscribe = keyboardService.addSettingsChangeListener(() => {
      this.settingsVersion++;
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    // Never leave the service disabled: being torn down mid-capture would
    // otherwise kill every shortcut in the app with no way back.
    if (this.editingId) {
      keyboardService.setEnabled(true);
    }
    removeOverlay(this);
    document.removeEventListener('keydown', this.handleKeyDown);
    this.settingsUnsubscribe?.();
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    // Handle recording mode. Gated on `open` as well as editingId: close()
    // cancels recording, but a stale flag must never let a closed dialog eat
    // keystrokes and rewrite bindings.
    if (this.editingId && this.open) {
      e.preventDefault();
      e.stopPropagation();

      // Cancel on Escape
      if (e.key === 'Escape') {
        this.cancelEditing();
        return;
      }

      // Ignore modifier-only keypresses
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
        return;
      }

      // Record the binding
      const binding: ShortcutBinding = {
        key: e.key,
        ctrl: e.ctrlKey || e.metaKey,
        shift: e.shiftKey,
        alt: e.altKey,
      };

      // Try to rebind
      const success = keyboardService.rebind(this.editingId, binding);
      if (success) {
        keyboardService.setEnabled(true);
        this.editingId = null;
        this.recordedBinding = null;
        this.conflictError = null;
      } else {
        this.conflictError = 'This key combination is already in use';
        // Show the attempted binding briefly
        this.recordedBinding = binding;
        setTimeout(() => {
          if (this.conflictError) {
            this.conflictError = null;
            this.recordedBinding = null;
          }
        }, 2000);
      }
      return;
    }

    // Normal mode: close on Escape, but only when this dialog is the topmost
    // overlay. Without that, pressing ? over the clean dialog and then Escape
    // dismissed BOTH — the clean dialog was still stack-top, so its own guard
    // passed and it discarded the user's file selection.
    //
    // The recording branch above is deliberately NOT gated: it is an explicit
    // capture mode inside this dialog and already stops propagation.
    if (e.key === 'Escape' && this.open && isTopOverlay(this)) {
      this.close();
    }
  };

  private startEditing(id: string): void {
    // Silence the shortcut service for the duration of the capture. Its
    // document listener is registered at MODULE EVALUATION, so it always runs
    // before this dialog's (registered in connectedCallback) — and
    // stopPropagation cannot suppress a listener on the same node. So the key
    // being recorded was first EXECUTED: pressing "s" to rebind something
    // staged the entire working tree, Ctrl+Shift+S stashed including
    // untracked files, Ctrl+Shift+U pushed. It also ate the "Esc to cancel"
    // this dialog advertises, closing the whole dialog instead.
    keyboardService.setEnabled(false);
    this.editingId = id;
    this.recordedBinding = null;
    this.conflictError = null;
  }

  private cancelEditing(): void {
    keyboardService.setEnabled(true);
    this.editingId = null;
    this.recordedBinding = null;
    this.conflictError = null;
  }

  private resetBinding(id: string): void {
    keyboardService.resetBinding(id);
  }

  private async resetAllBindings(): Promise<void> {
    const confirmed = await showConfirm(
      'Reset Keyboard Shortcuts',
      'Reset all keyboard shortcuts to their default bindings?'
    );
    if (confirmed) {
      keyboardService.resetAllBindings();
    }
  }

  private handleOverlayClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) {
      this.close();
    }
  }

  private close(): void {
    // Recording MUST be cancelled here. The recording branch of handleKeyDown
    // is gated on editingId alone, and this element is rendered
    // unconditionally, so its document listener stays live forever. Dismissing
    // mid-recording via the x or the backdrop (neither of which went through
    // cancelEditing) left editingId set — and every subsequent keystroke
    // anywhere in the app was then swallowed AND silently rebound that
    // shortcut, persisted to localStorage, with no dialog on screen to show it.
    this.cancelEditing();
    this.open = false;
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private toggleVimMode(): void {
    this.vimMode = !this.vimMode;
    this.dispatchEvent(
      new CustomEvent('vim-mode-change', {
        detail: { enabled: this.vimMode },
        bubbles: true,
        composed: true,
      })
    );
  }

  private formatKeyCombo(shortcut: Shortcut): string[] {
    const isMac = navigator.platform.toLowerCase().includes('mac');
    const keys: string[] = [];

    if (shortcut.ctrl || shortcut.meta) {
      keys.push(isMac ? '⌘' : 'Ctrl');
    }
    if (shortcut.shift) keys.push(isMac ? '⇧' : 'Shift');
    if (shortcut.alt) keys.push(isMac ? '⌥' : 'Alt');

    // Format special keys (initialize with uppercase key as fallback)
    let keyDisplay: string = shortcut.key.toUpperCase();
    switch (shortcut.key.toLowerCase()) {
      case 'arrowup': keyDisplay = '↑'; break;
      case 'arrowdown': keyDisplay = '↓'; break;
      case 'arrowleft': keyDisplay = '←'; break;
      case 'arrowright': keyDisplay = '→'; break;
      case 'enter': keyDisplay = '↵'; break;
      case 'escape': keyDisplay = 'Esc'; break;
      case ' ': keyDisplay = 'Space'; break;
    }
    keys.push(keyDisplay);

    return keys;
  }

  private renderShortcut(shortcut: Shortcut) {
    const keys = this.formatKeyCombo(shortcut);
    return html`
      <div class="shortcut-row">
        <span class="shortcut-description">${shortcut.description}</span>
        <div class="shortcut-keys">
          ${keys.map((key, i) => html`
            <span class="key">${key}</span>
            ${i < keys.length - 1 ? html`<span class="key-separator"></span>` : ''}
          `)}
        </div>
      </div>
    `;
  }

  private renderEditableShortcut(item: {
    id: string;
    binding: ShortcutBinding;
    defaultBinding: ShortcutBinding;
    description: string;
    category: string;
    isCustomized: boolean;
  }) {
    const isEditing = this.editingId === item.id;
    const displayBinding = isEditing && this.recordedBinding ? this.recordedBinding : item.binding;
    const keys = this.formatKeyComboFromBinding(displayBinding);

    return html`
      <div class="shortcut-row ${item.isCustomized ? 'customized' : ''}">
        <span class="shortcut-description">${item.description}</span>
        <div class="shortcut-actions" style="display: flex; align-items: center;">
          <div
            class="shortcut-keys editable ${isEditing ? 'recording' : ''}"
            @click=${() => this.startEditing(item.id)}
            title="Click to change shortcut"
          >
            ${isEditing ? html`
              <span class="key recording-hint">Press a key... (Esc to cancel)</span>
            ` : keys.map((key, i) => html`
              <span class="key">${key}</span>
              ${i < keys.length - 1 ? html`<span class="key-separator"></span>` : ''}
            `)}
          </div>
          ${item.isCustomized ? html`
            <button
              class="reset-btn"
              @click=${(e: Event) => { e.stopPropagation(); this.resetBinding(item.id); }}
              title="Reset to default"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                <path d="M3 3v5h5"></path>
              </svg>
            </button>
          ` : ''}
        </div>
      </div>
      ${isEditing && this.conflictError ? html`
        <div class="conflict-warning">${this.conflictError}</div>
      ` : ''}
    `;
  }

  private formatKeyComboFromBinding(binding: ShortcutBinding): string[] {
    const isMac = navigator.platform.toLowerCase().includes('mac');
    const keys: string[] = [];

    if (binding.ctrl) {
      keys.push(isMac ? '⌘' : 'Ctrl');
    }
    if (binding.shift) keys.push(isMac ? '⇧' : 'Shift');
    if (binding.alt) keys.push(isMac ? '⌥' : 'Alt');

    // Format special keys (initialize with uppercase key as fallback)
    let keyDisplay: string = binding.key.toUpperCase();
    switch (binding.key.toLowerCase()) {
      case 'arrowup': keyDisplay = '↑'; break;
      case 'arrowdown': keyDisplay = '↓'; break;
      case 'arrowleft': keyDisplay = '←'; break;
      case 'arrowright': keyDisplay = '→'; break;
      case 'enter': keyDisplay = '↵'; break;
      case 'escape': keyDisplay = 'Esc'; break;
      case ' ': keyDisplay = 'Space'; break;
    }
    keys.push(keyDisplay);

    return keys;
  }

  render() {
    // Use settingsVersion to force re-render on settings changes
    void this.settingsVersion;

    // Get all bindings for editing
    const allBindings = keyboardService.getAllBindings();
    const hasCustomBindings = allBindings.some(b => b.isCustomized);

    // Group by category
    const byCategory = new Map<string, typeof allBindings>();
    for (const item of allBindings) {
      const existing = byCategory.get(item.category) ?? [];
      existing.push(item);
      byCategory.set(item.category, existing);
    }
    const categories = Array.from(byCategory.entries());

    return html`
      <div class="overlay" @click=${this.handleOverlayClick}></div>
      <div class="dialog">
        <div class="header">
          <div class="header-left">
            <svg class="header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="4" width="20" height="16" rx="2"></rect>
              <line x1="6" y1="8" x2="6" y2="8"></line>
              <line x1="10" y1="8" x2="10" y2="8"></line>
              <line x1="14" y1="8" x2="14" y2="8"></line>
              <line x1="18" y1="8" x2="18" y2="8"></line>
              <line x1="6" y1="12" x2="18" y2="12"></line>
              <line x1="6" y1="16" x2="6" y2="16"></line>
              <line x1="10" y1="16" x2="14" y2="16"></line>
              <line x1="18" y1="16" x2="18" y2="16"></line>
            </svg>
            <span class="title">Keyboard Shortcuts</span>
          </div>
          <div class="header-actions">
            ${hasCustomBindings ? html`
              <button class="reset-all-btn" @click=${this.resetAllBindings}>
                Reset All
              </button>
            ` : ''}
            <button class="close-btn" @click=${this.close}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>

        <div class="content">
          ${categories.map(([category, items]) => html`
            <div class="category">
              <div class="category-title">${category}</div>
              <div class="shortcuts-list">
                ${items.map(item => this.renderEditableShortcut(item))}
              </div>
            </div>
          `)}

          ${this.vimMode ? html`
            <div class="category">
              <div class="category-title">Vim Mode (not customizable)</div>
              <div class="shortcuts-list">
                <div class="shortcut-row">
                  <span class="shortcut-description">Previous commit</span>
                  <div class="shortcut-keys"><span class="key">K</span></div>
                </div>
                <div class="shortcut-row">
                  <span class="shortcut-description">Next commit</span>
                  <div class="shortcut-keys"><span class="key">J</span></div>
                </div>
                <div class="shortcut-row">
                  <span class="shortcut-description">First commit</span>
                  <div class="shortcut-keys">
                    <span class="key">G</span><span class="key">G</span>
                  </div>
                </div>
                <div class="shortcut-row">
                  <span class="shortcut-description">Last commit</span>
                  <div class="shortcut-keys">
                    <span class="key">Shift</span><span class="key">G</span>
                  </div>
                </div>
              </div>
            </div>
          ` : ''}
        </div>

        <div class="footer">
          <span>Click a shortcut to edit • Press <span class="key">Esc</span> to cancel</span>
          <div class="vim-toggle">
            <label @click=${this.toggleVimMode}>Vim-style navigation</label>
            <gn-toggle
              label="Vim-style navigation"
              .checked=${this.vimMode}
              @change=${this.toggleVimMode}
            ></gn-toggle>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-keyboard-shortcuts-dialog': GnKeyboardShortcutsDialog;
  }
}
