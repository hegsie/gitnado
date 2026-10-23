/**
 * Create Tag Dialog Component
 * Allows users to create a new tag (annotated or lightweight)
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state, property, query } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { createTag } from '../../services/git.service.ts';
import { containsDeepActiveElement } from '../../utils/focus.ts';
import '../common/gn-toggle.ts';
import './gn-modal.ts';
import type { GnModal } from './gn-modal.ts';

@customElement('gn-create-tag-dialog')
export class GnCreateTagDialog extends LitElement {
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

      .field input,
      .field textarea {
        padding: var(--spacing-sm) var(--spacing-md);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-md);
        font-family: inherit;
      }

      .field input:focus,
      .field textarea:focus {
        outline: none;
        border-color: var(--color-primary);
        box-shadow: 0 0 0 2px var(--color-primary-light);
      }

      .field input::placeholder,
      .field textarea::placeholder {
        color: var(--color-text-muted);
      }

      .field textarea {
        min-height: 80px;
        resize: vertical;
      }

      .field-hint {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .toggle-field {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .toggle-label {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .toggle-label-main {
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
      }

      .toggle-label-hint {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
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

  /** The repo this dialog was opened for, captured at open(). The
   * `repositoryPath` property is bound live to the active tab, so a tab switch
   * while the modal is open would otherwise make Create target the wrong repo. */
  private pinnedRepoPath = '';
  private isOpen = false;

  /** The pinned repo while the dialog is open, else null — lets the host
   * self-close the dialog when that repo's tab is closed (a successful create
   * on a closed repo would otherwise be a silent, invisible mutation). */
  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.isOpen ? this.pinnedRepoPath : null;
  }

  /**
   * True while the tag is being created. The host's tab-close sweep must not
   * report "tag creation cancelled" over a create that still lands.
   */
  public get operationInFlight(): boolean {
    return this.isCreating;
  }

  @state() private name = '';
  @state() private targetRef = '';
  @state() private message = '';
  @state() private isAnnotated = true;
  @state() private isCreating = false;
  @state() private error = '';

  @query('gn-modal') private modal!: GnModal;
  @query('#tag-name-input') private inputEl!: HTMLInputElement;

  /**
   * @param targetRef - Ref or oid to tag; omit for the current HEAD
   * @param repositoryPath - Repository the target belongs to. Callers handing
   *   over from a dialog that pins its own repo (describe) must pass it:
   *   `repositoryPath` here is bound live to the ACTIVE tab, so pinning from
   *   it would aim the tag at a repository the target does not exist in.
   */
  public open(targetRef?: string, repositoryPath?: string): void {
    // Tag creation already in flight owns this component; reset() would
    // clear `isCreating` and re-enable the button for a second concurrent run,
    // and the first run's close() would then yank shut the reopened session.
    if (this.isCreating) return;

    // Already open: re-entering must NOT reset. Several entry points converge
    // on this one instance (context menu, panel header button, command
    // palette), and ctrl-shortcuts fire even while typing in an input — so
    // Ctrl+P then "Create..." while the dialog was open silently wiped the
    // tag name and message the user had entered. Re-aim at the new target if one was
    // given, refocus, and keep their text.
    if (this.isOpen) {
      // Re-aiming only makes sense within the repository this session is
      // already pinned to; a target from a different one would be tagged
      // against the wrong repo, so keep the session the user is typing in.
      if (targetRef && (!repositoryPath || repositoryPath === this.pinnedRepoPath)) {
        this.targetRef = targetRef;
      }
      this.inputEl?.focus();
      return;
    }

    this.reset();
    this.pinnedRepoPath = repositoryPath || this.repositoryPath;
    this.isOpen = true;
    if (targetRef) {
      this.targetRef = targetRef;
    }
    // Reveal the modal only AFTER the reset above has rendered. Setting
    // modal.open synchronously made the dialog visible while a render carrying
    // the cleared `name` was still pending, so anything typed in that window
    // was overwritten by `.value=${this.name}` when it committed — the field
    // silently emptied itself and Create Tag stayed disabled.
    void this.updateComplete.then(() => {
      // close() may have run while this was pending — for instance the host's
      // tab-close sweep dismissing the dialog. Re-revealing here would leave
      // modal.open true with isOpen false: a visible dialog the app believes
      // is shut.
      if (!this.isOpen) return;
      this.modal.open = true;
      // Focus the name field once the modal has painted — but only while focus
      // is still nobody's. This used to be an unguarded 100ms timer, which
      // fired long after the user could click or Tab into Target or Message and
      // yanked the caret back into the name box mid-keystroke: the rest of the
      // message landed in the tag name, and Create Tag stayed disabled because
      // Message was still empty. A rAF also lands before gn-modal's own focus
      // pass, which then sees focus inside and backs off.
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
    this.name = '';
    this.targetRef = '';
    this.message = '';
    this.isAnnotated = true;
    this.isCreating = false;
    this.error = '';
  }

  private handleNameChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    // Sanitize tag name (replace invalid characters)
    this.name = input.value.replace(/[^\w\-/.]/g, '-');
    this.error = '';
  }

  private handleTargetChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    this.targetRef = input.value;
    this.error = '';
  }

  private handleMessageChange(e: Event): void {
    const textarea = e.target as HTMLTextAreaElement;
    this.message = textarea.value;
    this.error = '';
  }

  private handleAnnotatedChange(e: CustomEvent<{ checked: boolean }>): void {
    this.isAnnotated = e.detail.checked;
    if (!this.isAnnotated) {
      this.message = '';
    }
  }

  private async handleCreate(): Promise<void> {
    const tagName = this.name.trim();

    if (!tagName) {
      this.error = 'Please enter a tag name';
      return;
    }

    if (tagName.startsWith('-') || tagName.startsWith('.')) {
      this.error = 'Tag name cannot start with - or .';
      return;
    }

    if (this.isAnnotated && !this.message.trim()) {
      this.error = 'Please enter a message for the annotated tag';
      return;
    }

    this.isCreating = true;
    this.error = '';

    try {
      const repoPath = this.pinnedRepoPath;
      const result = await createTag({
        path: repoPath,
        name: tagName,
        target: this.targetRef || undefined,
        message: this.isAnnotated ? this.message.trim() : undefined,
      });

      if (result.success) {
        this.dispatchEvent(new CustomEvent('tag-created', {
          detail: { tag: result.data, repositoryPath: repoPath },
          bubbles: true,
          composed: true,
        }));
        this.close();
      } else {
        this.error = result.error?.message ?? 'Failed to create tag';
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Unknown error occurred';
    } finally {
      this.isCreating = false;
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Enter' || !this.canCreate) return;

    // Inside the message textarea, Enter inserts a newline.
    //
    // This handler is bound on the whole form, so a plain Enter submitted from
    // anywhere. An annotated tag message is exactly the multi-line case — the
    // placeholder invites "Release notes or description..." — and canCreate is
    // already true once the name and first line exist. So pressing Enter to
    // start line two created the tag with a one-line message, with nothing
    // hinting that Shift+Enter was required, and the tag may be pushed before
    // the user notices.
    //
    // Ctrl/Cmd+Enter still submits from the textarea, matching the commit
    // message editors elsewhere in the app.
    const inTextarea = (e.target as HTMLElement | null)?.tagName === 'TEXTAREA';
    if (inTextarea && !(e.ctrlKey || e.metaKey)) return;

    if (e.shiftKey) return;

    e.preventDefault();
    this.handleCreate();
  }

  private handleModalClose(): void {
    // Escape, the overlay and the × must honour the same rule as the disabled
    // Cancel button. gn-modal.close() sets open=false BEFORE dispatching, and
    // this handler additionally dropped `isOpen`, so tag creation carried on with
    // no visible surface and reported failure into a hidden dialog.
    if (this.isCreating) {
      this.modal.open = true;
      return;
    }

    this.isOpen = false;
    this.reset();
  }

  private get canCreate(): boolean {
    const hasName = Boolean(this.name.trim());
    const hasMessageIfAnnotated = !this.isAnnotated || Boolean(this.message.trim());
    return hasName && hasMessageIfAnnotated && !this.isCreating;
  }

  render() {
    return html`
      <gn-modal
        modalTitle="Create Tag"
        @close=${this.handleModalClose}
      >
        <div class="form" @keydown=${this.handleKeyDown}>
          <div class="field">
            <label for="tag-name-input">Tag Name</label>
            <input
              id="tag-name-input"
              type="text"
              placeholder="v1.0.0"
              .value=${this.name}
              @input=${this.handleNameChange}
              ?disabled=${this.isCreating}
            />
            <span class="field-hint">Use semantic versioning (e.g., v1.0.0, v2.1.0-beta)</span>
          </div>

          <div class="field">
            <label for="target-input">Target (optional)</label>
            <input
              id="target-input"
              type="text"
              placeholder="HEAD"
              .value=${this.targetRef}
              @input=${this.handleTargetChange}
              ?disabled=${this.isCreating}
            />
            <span class="field-hint">Commit, branch, or tag to create from (defaults to HEAD)</span>
          </div>

          <div class="toggle-field">
            <gn-toggle
              label="Annotated Tag"
              description=${this.isAnnotated
                ? 'Includes message, author, and date'
                : 'Lightweight tag (just a reference to a commit)'}
              .checked=${this.isAnnotated}
              ?disabled=${this.isCreating}
              @change=${this.handleAnnotatedChange}
            ></gn-toggle>
            <div class="toggle-label">
              <span class="toggle-label-main">Annotated Tag</span>
              <span class="toggle-label-hint">
                ${this.isAnnotated
                  ? 'Includes message, author, and date'
                  : 'Lightweight tag (just a reference to a commit)'}
              </span>
            </div>
          </div>

          ${this.isAnnotated ? html`
            <div class="field">
              <label for="message-input">Message</label>
              <textarea
                id="message-input"
                placeholder="Release notes or description..."
                .value=${this.message}
                @input=${this.handleMessageChange}
                ?disabled=${this.isCreating}
              ></textarea>
            </div>
          ` : nothing}

          ${this.error
            ? html`<div class="error-message">${this.error}</div>`
            : nothing}
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
            ?disabled=${!this.canCreate}
          >
            ${this.isCreating ? 'Creating...' : 'Create Tag'}
          </button>
        </div>
      </gn-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-create-tag-dialog': GnCreateTagDialog;
  }
}
