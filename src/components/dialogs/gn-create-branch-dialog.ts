/**
 * Create Branch Dialog Component
 * Allows users to create a new branch from current HEAD or a specific ref
 */

import { LitElement, html, css } from 'lit';
import { customElement, state, property, query } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { createBranch } from '../../services/git.service.ts';
import { containsDeepActiveElement } from '../../utils/focus.ts';
import './gn-modal.ts';
import type { GnModal } from './gn-modal.ts';
import {
  tryAcquireRefOp,
  releaseRefOp,
  RefLockController,
} from '../../utils/ref-lock.ts';

@customElement('gn-create-branch-dialog')
export class GnCreateBranchDialog extends LitElement {
  static styles = [
    sharedStyles,
    css`
      .form {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        min-width: 400px;
      }

      .field {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .field label {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
      }

      .field input {
        padding: var(--spacing-sm) var(--spacing-md);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-md);
        font-family: inherit;
      }

      .field input:focus {
        outline: none;
        border-color: var(--color-primary);
        box-shadow: 0 0 0 2px var(--color-primary-light);
      }

      .field input::placeholder {
        color: var(--color-text-muted);
      }

      .field-hint {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .checkbox-field {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .checkbox-field input[type="checkbox"] {
        width: 16px;
        height: 16px;
        accent-color: var(--color-primary);
      }

      .checkbox-field label {
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
        cursor: pointer;
      }

      .error-message {
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--color-error-bg);
        border: 1px solid var(--color-error);
        border-radius: var(--radius-md);
        color: var(--color-error);
        font-size: var(--font-size-sm);
      }

      .btn {
        padding: var(--spacing-sm) var(--spacing-lg);
        border-radius: var(--radius-md);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .btn-primary {
        background: var(--color-primary);
        color: var(--color-text-inverse);
        border: none;
      }

      .btn-primary:hover:not(:disabled) {
        background: var(--color-primary-hover);
      }

      .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-secondary {
        background: transparent;
        color: var(--color-text-secondary);
        border: 1px solid var(--color-border);
      }

      .btn-secondary:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }
    `,
  ];

  @property({ type: String }) repositoryPath = '';

  /**
   * Observe the shared working-tree lock, not just claim it.
   *
   * The handlers below already refuse when another surface holds the lock, but
   * the action buttons were bound to this dialog's own flag alone — so while a
   * checkout, reset or gc ran elsewhere they stayed lit and did nothing except
   * raise a refusal toast.
   */
  private lock = new RefLockController(this, () => this.pinnedRepoPath || this.repositoryPath);
  @property({ type: String }) startPoint = '';

  /** The repo this dialog was opened for, captured at open(). The
   * `repositoryPath` property is bound live to the active tab, so a tab switch
   * while the modal is open would otherwise make Create target the wrong repo. */
  private pinnedRepoPath = '';
  private isOpen = false;

  /** The pinned repo while the dialog is open, else null — lets the host
   * self-close the dialog when that repo's tab is closed (a successful create
   * + checkout on a closed repo would otherwise be a silent, invisible
   * mutation). */
  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.isOpen ? this.pinnedRepoPath : null;
  }

  /**
   * True while the branch is being created (and possibly checked out). The
   * host's tab-close sweep must not report "branch creation cancelled" over a
   * create that still lands — checkout even moves HEAD.
   */
  public get operationInFlight(): boolean {
    return this.isCreating;
  }

  @state() private branchName = '';
  @state() private checkoutAfterCreate = true;
  @state() private isCreating = false;
  @state() private error = '';

  @query('gn-modal') private modal!: GnModal;
  @query('#branch-name-input') private inputEl!: HTMLInputElement;

  public open(startPoint?: string): void {
    // Branch creation already in flight owns this component; reset() would
    // clear `isCreating` and re-enable the button for a second concurrent run,
    // and the first run's close() would then yank shut the reopened session.
    if (this.isCreating) return;

    // Already open: re-entering must NOT reset. Several entry points converge
    // on this one instance (context menu, panel header button, command
    // palette), and ctrl-shortcuts fire even while typing in an input — so
    // Ctrl+P then "Create..." while the dialog was open silently wiped the
    // branch name the user had entered. Re-aim at the new target if one was
    // given, refocus, and keep their text.
    if (this.isOpen) {
      if (startPoint) {
        this.startPoint = startPoint;
      }
      this.inputEl?.focus();
      return;
    }

    this.reset();
    this.pinnedRepoPath = this.repositoryPath;
    this.isOpen = true;
    if (startPoint) {
      this.startPoint = startPoint;
    }
    // Reveal only AFTER the reset above has rendered — same ordering hazard
    // the tag dialog had: opening synchronously left a render carrying the
    // cleared field pending, so anything typed in that window was overwritten
    // when it committed. Guarded on isOpen so a close() that lands while this
    // is pending cannot be undone by it.
    void this.updateComplete.then(() => {
      if (!this.isOpen) return;
      this.modal.open = true;
      // Focus the name field once the modal has painted — but only while focus
      // is still nobody's. The unguarded 100ms timer this replaces fired long
      // after the user could click or Tab into another control and yanked the
      // caret back into the name box mid-keystroke. A rAF also lands before
      // gn-modal's own focus pass, which then sees focus inside and backs off.
      requestAnimationFrame(() => {
        if (!this.isOpen) return;
        if (containsDeepActiveElement(this)) return;
        this.inputEl?.focus();
      });
    });
  }

  public close(): void {
    this.isOpen = false;
    this.modal.open = false;
  }

  private reset(): void {
    this.branchName = '';
    // Cleared like every other field — open() re-applies the argument straight
    // after. Leaving it set made a start point picked once from "Create branch
    // from here" stick to the single shared dialog for the rest of the session:
    // every later Ctrl+Shift+N cut from that ref instead of HEAD, shown only in
    // a disabled "Based on" field with no way to clear it.
    this.startPoint = '';
    this.checkoutAfterCreate = true;
    this.isCreating = false;
    this.error = '';
  }

  private handleNameChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    // Sanitize branch name (replace invalid characters)
    this.branchName = input.value.replace(/[^\w\-/.]/g, '-');
    this.error = '';
  }

  private handleCheckoutChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    this.checkoutAfterCreate = input.checked;
  }

  private async handleCreate(): Promise<void> {
    const name = this.branchName.trim();

    if (!name) {
      this.error = 'Please enter a branch name';
      return;
    }

    if (name.startsWith('-') || name.startsWith('.')) {
      this.error = 'Branch name cannot start with - or .';
      return;
    }

    const repoPath = this.pinnedRepoPath;
    // "Checkout new branch after creation" is this dialog's default, and that
    // path runs checkout_tree + set_head — the same working-tree mutation every
    // other surface serializes on the shared lock. Creating a ref WITHOUT
    // checking it out touches no working tree, so it stays unguarded rather
    // than blocking on an unrelated operation.
    const needsLock = this.checkoutAfterCreate;
    if (needsLock && !tryAcquireRefOp(repoPath)) {
      this.error = 'Another operation is already running in this repository.';
      return;
    }

    this.isCreating = true;
    this.error = '';

    try {
      const result = await createBranch(repoPath, {
        name,
        startPoint: this.startPoint || undefined,
        checkout: this.checkoutAfterCreate,
      });

      if (result.success) {
        this.dispatchEvent(new CustomEvent('branch-created', {
          detail: {
            branch: result.data,
            checkedOut: this.checkoutAfterCreate,
            repositoryPath: repoPath,
          },
          bubbles: true,
          composed: true,
        }));
        this.close();
      } else {
        this.error = result.error?.message ?? 'Failed to create branch';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Unknown error occurred';
    } finally {
      this.isCreating = false;
      if (needsLock) releaseRefOp(repoPath);
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && this.canCreate) {
      this.handleCreate();
    }
  }

  private handleModalClose(): void {
    // Escape, the overlay and the × must honour the same rule as the disabled
    // Cancel button. gn-modal.close() sets open=false BEFORE dispatching, and
    // this handler additionally dropped `isOpen`, so branch creation carried on with
    // no visible surface and reported failure into a hidden dialog.
    if (this.isCreating) {
      this.modal.open = true;
      return;
    }

    this.isOpen = false;
    this.reset();
  }

  private get canCreate(): boolean {
    return Boolean(this.branchName.trim() && !this.isCreating);
  }

  render() {
    return html`
      <gn-modal
        modalTitle="Create Branch"
        @close=${this.handleModalClose}
      >
        <div class="form" @keydown=${this.handleKeyDown}>
          <div class="field">
            <label for="branch-name-input">Branch Name</label>
            <input
              id="branch-name-input"
              type="text"
              placeholder="feature/my-new-feature"
              .value=${this.branchName}
              @input=${this.handleNameChange}
              ?disabled=${this.isCreating}
            />
            <span class="field-hint">Use / to organize branches (e.g., feature/, bugfix/)</span>
          </div>

          ${this.startPoint ? html`
            <div class="field">
              <label>Based on</label>
              <input
                type="text"
                .value=${this.startPoint}
                disabled
                style="background: var(--color-bg-tertiary);"
              />
            </div>
          ` : ''}

          <div class="checkbox-field">
            <input
              id="checkout-after"
              type="checkbox"
              .checked=${this.checkoutAfterCreate}
              @change=${this.handleCheckoutChange}
              ?disabled=${this.isCreating}
            />
            <label for="checkout-after">Checkout new branch after creation</label>
          </div>

          ${this.error
            ? html`<div class="error-message">${this.error}</div>`
            : ''}
        </div>

        <div slot="footer">
          <button
            class="btn btn-secondary"
            @click=${this.close}
            ?disabled=${this.isCreating}
          >
            Cancel
          </button>
          <button
            class="btn btn-primary"
            @click=${this.handleCreate}
            ?disabled=${!this.canCreate ||
              // ONLY when it will also check out. handleCreate claims the lock
              // only for that case — creating a ref without checking it out
              // touches no working tree — so gating unconditionally made the
              // binding and the handler describe different contracts.
              (this.checkoutAfterCreate && this.lock.busy)}
          >
            ${this.isCreating ? 'Creating...' : 'Create Branch'}
          </button>
        </div>
      </gn-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-create-branch-dialog': GnCreateBranchDialog;
  }
}
