import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import { showConfirm } from '../../services/dialog.service.ts';
import { showToast } from '../../services/notification.service.ts';
import type {
  AttributeEntry,
  CommonAttribute,
  GitAttribute,
  GitignoreEntry,
  GitignoreTemplate,
  IgnoreCheckVerboseResult,
} from '../../services/git.service.ts';
import './gn-modal.ts';

type TabId = 'ignore' | 'attributes';

/**
 * Render one parsed attribute back into the token a human wrote.
 *
 * `AttributeValue` is the externally-tagged Rust enum: the unit variants arrive
 * as bare strings and only the valued variant is an object. Reading a `.type`
 * discriminator off it (as the old TypeScript union claimed) yields `undefined`
 * for every attribute.
 */
export function formatAttributeToken(attr: AttributeEntry): string {
  const value = attr.value;
  if (value === 'set') return attr.name;
  if (value === 'unset') return `-${attr.name}`;
  if (value === 'unspecified') return `!${attr.name}`;
  return `${attr.name}=${value.value}`;
}

/**
 * Ignore rules dialog
 * Edit .gitignore (rules, templates, "why is this ignored?") and .gitattributes
 * for the repository the dialog was opened on.
 */
@customElement('gn-gitignore-dialog')
export class GnGitignoreDialog extends LitElement {
  static styles = [
    sharedStyles,
    css`
      .content {
        padding: var(--spacing-md);
        min-width: 560px;
      }

      .tabs {
        display: flex;
        gap: var(--spacing-xs);
        margin-bottom: var(--spacing-md);
        border-bottom: 1px solid var(--color-border);
        padding-bottom: var(--spacing-xs);
      }

      .tab {
        padding: var(--spacing-xs) var(--spacing-md);
        border: none;
        background: none;
        color: var(--color-text-secondary);
        cursor: pointer;
        font-size: var(--font-size-sm);
        border-radius: var(--radius-sm) var(--radius-sm) 0 0;
        transition: all var(--transition-fast);
      }

      .tab:hover {
        color: var(--color-text-primary);
        background: var(--color-bg-hover);
      }

      .tab.active {
        color: var(--color-primary);
        background: var(--color-bg-tertiary);
        font-weight: var(--font-weight-medium);
      }

      .error-banner {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm);
        background: var(--color-error-bg);
        color: var(--color-error);
        border-radius: var(--radius-md);
        margin-bottom: var(--spacing-md);
        font-size: var(--font-size-sm);
      }

      .rule-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
        max-height: 260px;
        overflow-y: auto;
        margin-bottom: var(--spacing-md);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        padding: var(--spacing-xs);
      }

      .rule-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-sm);
        padding: 2px var(--spacing-xs);
        border-radius: var(--radius-sm);
      }

      .rule-item:hover {
        background: var(--color-bg-hover);
      }

      .rule-text {
        font-family: var(--font-family-mono);
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
        word-break: break-all;
      }

      .rule-item.comment .rule-text {
        color: var(--color-text-muted);
      }

      .rule-item.blank {
        height: 8px;
      }

      .attr-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        max-height: 260px;
        overflow-y: auto;
        margin-bottom: var(--spacing-md);
      }

      .attr-item {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        padding: var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }

      .attr-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-sm);
      }

      .attr-pattern {
        font-family: var(--font-family-mono);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
      }

      .attr-chips {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-xs);
      }

      .attr-chip {
        font-family: var(--font-family-mono);
        font-size: var(--font-size-xs);
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        padding: 1px 6px;
        color: var(--color-text-secondary);
      }

      .section {
        padding: var(--spacing-md);
        background: var(--color-bg-tertiary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        margin-bottom: var(--spacing-md);
      }

      .section h4 {
        margin: 0 0 var(--spacing-sm) 0;
        font-size: var(--font-size-sm);
        color: var(--color-text-primary);
      }

      .inline-form {
        display: flex;
        gap: var(--spacing-sm);
      }

      .inline-form input,
      .inline-form select {
        flex: 1;
        min-width: 0;
        padding: var(--spacing-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        font-size: var(--font-size-sm);
      }

      .inline-form input:focus,
      .inline-form select:focus {
        outline: none;
        border-color: var(--color-primary);
      }

      .hint {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        margin-top: var(--spacing-xs);
      }

      .check-result {
        margin-top: var(--spacing-sm);
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .check-result code {
        font-family: var(--font-family-mono);
        background: var(--color-bg-primary);
        border-radius: var(--radius-sm);
        padding: 1px 4px;
      }

      .btn-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        padding: 0;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .btn-icon:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .btn-icon.danger:hover {
        background: var(--color-error-bg);
        color: var(--color-error);
      }

      .btn-icon svg {
        width: 15px;
        height: 15px;
      }

      .empty-state {
        text-align: center;
        padding: var(--spacing-lg);
        color: var(--color-text-muted);
        border: 1px dashed var(--color-border);
        border-radius: var(--radius-md);
        margin-bottom: var(--spacing-md);
      }

      .loading-indicator {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-lg);
        color: var(--color-text-muted);
      }
    `,
  ];

  @property({ type: Boolean }) open = false;
  @property({ type: String }) repositoryPath = '';

  @state() private activeTab: TabId = 'ignore';
  @state() private loading = false;
  @state() private saving = false;
  @state() private error: string | null = null;

  // Ignore tab state
  @state() private entries: GitignoreEntry[] = [];
  @state() private templates: GitignoreTemplate[] = [];
  @state() private newPattern = '';
  @state() private selectedTemplate = '';
  @state() private checkPath = '';
  @state() private checkResult: IgnoreCheckVerboseResult | null = null;

  // Attributes tab state
  // NOT `attributes` — that name is taken by HTMLElement.attributes, and
  // shadowing it makes the class stop satisfying HTMLElement entirely.
  @state() private attributeRules: GitAttribute[] = [];
  @state() private commonAttributes: CommonAttribute[] = [];
  @state() private newAttrPattern = '';
  @state() private newAttrValue = '';
  @state() private editingLine: number | null = null;
  @state() private editPattern = '';
  @state() private editValue = '';

  /**
   * Repo captured when the dialog opened. `repositoryPath` is live-bound to
   * the ACTIVE repository and rebinds the instant the user Ctrl+Tabs — a
   * document-level shortcut this dialog's overlay does not block — while the
   * rules on screen still belong to the repo that was active at open. Every
   * read and every write must use THIS value, or the dialog rewrites the
   * .gitignore of a repository the user is not looking at.
   */
  private pinnedRepoPath = '';

  /** The repo this dialog is pinned to while open, or null when closed. */
  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.open ? this.pinnedRepoPath : null;
  }

  /**
   * True while a .gitignore/.gitattributes write is in flight. The host's
   * tab-close sweep must not report "ignore rules closed" over a write still
   * landing in the working tree.
   */
  public get operationInFlight(): boolean {
    return this.saving;
  }

  updated(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has('open') && this.open) {
      this.pinnedRepoPath = this.repositoryPath;
      this.loadData();
    }
  }

  private async loadData(): Promise<void> {
    this.loading = true;
    this.error = null;

    try {
      const [ignoreResult, templatesResult, attrsResult, commonResult] =
        await Promise.all([
          gitService.getGitignore(this.pinnedRepoPath),
          gitService.getGitignoreTemplates(),
          gitService.getGitattributes(this.pinnedRepoPath),
          gitService.getCommonAttributes(),
        ]);

      if (ignoreResult.success && ignoreResult.data) {
        this.entries = ignoreResult.data;
      } else if (!ignoreResult.success) {
        this.error = ignoreResult.error?.message || 'Failed to read .gitignore';
      }

      if (templatesResult.success && templatesResult.data) {
        this.templates = templatesResult.data;
      }

      if (attrsResult.success && attrsResult.data) {
        this.attributeRules = attrsResult.data;
      } else if (!attrsResult.success) {
        this.error =
          attrsResult.error?.message || 'Failed to read .gitattributes';
      }

      if (commonResult.success && commonResult.data) {
        this.commonAttributes = commonResult.data;
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to load ignore rules';
    } finally {
      this.loading = false;
    }
  }

  private async reloadGitignore(): Promise<void> {
    const result = await gitService.getGitignore(this.pinnedRepoPath);
    if (result.success && result.data) {
      this.entries = result.data;
    }
    // The rule set just moved, so any "why is this ignored?" answer on screen
    // describes a file state that no longer exists.
    this.checkResult = null;
  }

  /**
   * Both files live in the working tree, so every write here makes the file
   * list stale — the host routes this to the repo the write RAN ON.
   */
  private notifyChanged(): void {
    this.dispatchEvent(
      new CustomEvent('ignore-rules-changed', {
        detail: { repositoryPath: this.pinnedRepoPath },
      }),
    );
  }

  private handleClose(): void {
    this.dispatchEvent(new CustomEvent('close'));
  }

  // ── Ignore tab handlers ──────────────────────────────────────────────────

  private async handleAddPattern(): Promise<void> {
    const pattern = this.newPattern.trim();
    if (!pattern) return;

    this.saving = true;
    this.error = null;
    try {
      const result = await gitService.addToGitignore(this.pinnedRepoPath, [
        pattern,
      ]);
      if (result.success) {
        this.newPattern = '';
        await this.reloadGitignore();
        showToast(`Added "${pattern}" to .gitignore`, 'success');
        this.notifyChanged();
      } else {
        this.error = result.error?.message || 'Failed to add ignore rule';
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to add ignore rule';
    } finally {
      this.saving = false;
    }
  }

  private async handleApplyTemplate(): Promise<void> {
    const template = this.templates.find((t) => t.name === this.selectedTemplate);
    if (!template) return;

    this.saving = true;
    this.error = null;
    try {
      const result = await gitService.addToGitignore(
        this.pinnedRepoPath,
        template.patterns,
      );
      if (result.success) {
        await this.reloadGitignore();
        showToast(`Applied the ${template.name} template`, 'success');
        this.notifyChanged();
      } else {
        this.error = result.error?.message || 'Failed to apply template';
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to apply template';
    } finally {
      this.saving = false;
    }
  }

  private async handleRemovePattern(entry: GitignoreEntry): Promise<void> {
    const confirmed = await showConfirm(
      'Remove Ignore Rule',
      `Remove "${entry.pattern.trim()}" from .gitignore?`,
      'warning',
    );
    if (!confirmed) return;

    this.saving = true;
    this.error = null;
    try {
      // Line identity, not just the text: the same line can appear twice in a
      // .gitignore, and only the row the user clicked was asked for.
      const result = await gitService.removeFromGitignore(
        this.pinnedRepoPath,
        entry.pattern,
        entry.lineNumber,
      );
      if (result.success) {
        await this.reloadGitignore();
        showToast('Ignore rule removed', 'success');
        this.notifyChanged();
      } else {
        this.error = result.error?.message || 'Failed to remove ignore rule';
      }
    } catch (e) {
      this.error =
        e instanceof Error ? e.message : 'Failed to remove ignore rule';
    } finally {
      this.saving = false;
    }
  }

  private async handleCheckPath(): Promise<void> {
    const path = this.checkPath.trim();
    if (!path) return;

    this.error = null;
    try {
      const result = await gitService.checkIgnoreVerbose(this.pinnedRepoPath, [
        path,
      ]);
      if (result.success && result.data) {
        this.checkResult = result.data[0] ?? null;
      } else {
        this.error = result.error?.message || 'Failed to check path';
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to check path';
    }
  }

  // ── Attributes tab handlers ──────────────────────────────────────────────

  private async handleAddAttribute(): Promise<void> {
    const pattern = this.newAttrPattern.trim();
    const attrs = this.newAttrValue.trim();
    if (!pattern || !attrs) return;

    this.saving = true;
    this.error = null;
    try {
      const result = await gitService.addGitattribute(
        this.pinnedRepoPath,
        pattern,
        attrs,
      );
      if (result.success && result.data) {
        // The write returns the reparsed file, so there is nothing to refetch.
        this.attributeRules = result.data;
        this.newAttrPattern = '';
        this.newAttrValue = '';
        showToast(`Added attributes for ${pattern}`, 'success');
        this.notifyChanged();
      } else {
        this.error = result.error?.message || 'Failed to add attribute';
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to add attribute';
    } finally {
      this.saving = false;
    }
  }

  private startEditingAttribute(attr: GitAttribute): void {
    this.editingLine = attr.lineNumber;
    this.editPattern = attr.pattern;
    this.editValue = attr.attributes.map(formatAttributeToken).join(' ');
  }

  private cancelEditingAttribute(): void {
    this.editingLine = null;
    this.editPattern = '';
    this.editValue = '';
  }

  private async handleUpdateAttribute(lineNumber: number): Promise<void> {
    const pattern = this.editPattern.trim();
    const attrs = this.editValue.trim();
    if (!pattern || !attrs) return;

    this.saving = true;
    this.error = null;
    try {
      const result = await gitService.updateGitattribute(
        this.pinnedRepoPath,
        lineNumber,
        pattern,
        attrs,
      );
      if (result.success && result.data) {
        this.attributeRules = result.data;
        this.cancelEditingAttribute();
        showToast('Attributes updated', 'success');
        this.notifyChanged();
      } else {
        this.error = result.error?.message || 'Failed to update attribute';
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to update attribute';
    } finally {
      this.saving = false;
    }
  }

  private async handleRemoveAttribute(attr: GitAttribute): Promise<void> {
    const confirmed = await showConfirm(
      'Remove Attributes',
      `Remove the .gitattributes rule for "${attr.pattern}"?`,
      'warning',
    );
    if (!confirmed) return;

    this.saving = true;
    this.error = null;
    try {
      const result = await gitService.removeGitattribute(
        this.pinnedRepoPath,
        attr.lineNumber,
      );
      if (result.success && result.data) {
        this.attributeRules = result.data;
        if (this.editingLine === attr.lineNumber) this.cancelEditingAttribute();
        showToast('Attributes removed', 'success');
        this.notifyChanged();
      } else {
        this.error = result.error?.message || 'Failed to remove attribute';
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to remove attribute';
    } finally {
      this.saving = false;
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  private renderCheckResult() {
    const result = this.checkResult;
    if (!result) return nothing;

    if (!result.isIgnored) {
      return html`<div class="check-result">
        <code>${result.path}</code> — Not ignored.
      </div>`;
    }

    const source =
      result.sourceFile && result.sourceLine !== null
        ? html` (${result.sourceFile}:${result.sourceLine})`
        : result.sourceFile
          ? html` (${result.sourceFile})`
          : nothing;

    return html`<div class="check-result">
      <code>${result.path}</code> is
      ${result.isNegated ? 'explicitly NOT ignored' : 'ignored'} by
      <code>${result.pattern ?? '(unknown rule)'}</code>${source}
    </div>`;
  }

  private renderIgnoreTab() {
    if (this.loading) {
      return html`<div class="loading-indicator">Loading...</div>`;
    }

    return html`
      ${this.entries.length === 0
        ? html`<div class="empty-state">
            No ignore rules yet — add a pattern below, or start from a template.
          </div>`
        : html`
            <div class="rule-list">
              ${this.entries.map((entry) =>
                entry.isEmpty
                  ? html`<div class="rule-item blank"></div>`
                  : html`
                      <div class="rule-item ${entry.isComment ? 'comment' : ''}">
                        <span class="rule-text">${entry.pattern}</span>
                        <button
                          class="btn-icon danger"
                          title="Remove"
                          aria-label="Remove ${entry.pattern.trim()}"
                          ?disabled=${this.saving}
                          @click=${() => this.handleRemovePattern(entry)}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                          </svg>
                        </button>
                      </div>
                    `,
              )}
            </div>
          `}

      <div class="section">
        <h4>Add a rule</h4>
        <div class="inline-form">
          <input
            type="text"
            placeholder="e.g. *.log or /build/"
            .value=${this.newPattern}
            aria-label="Ignore pattern"
            @input=${(e: Event) =>
              (this.newPattern = (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') this.handleAddPattern();
            }}
          />
          <button
            class="btn btn-primary"
            ?disabled=${this.saving || this.newPattern.trim().length === 0}
            @click=${this.handleAddPattern}
          >
            Add
          </button>
        </div>
      </div>

      <div class="section">
        <h4>Start from a template</h4>
        <div class="inline-form">
          <select
            aria-label="Gitignore template"
            .value=${this.selectedTemplate}
            @change=${(e: Event) =>
              (this.selectedTemplate = (e.target as HTMLSelectElement).value)}
          >
            <option value="">Select a template…</option>
            ${this.templates.map(
              (t) => html`<option value=${t.name}>${t.name}</option>`,
            )}
          </select>
          <button
            class="btn btn-secondary"
            ?disabled=${this.saving || !this.selectedTemplate}
            @click=${this.handleApplyTemplate}
          >
            Apply
          </button>
        </div>
        <div class="hint">
          Patterns already present in .gitignore are left untouched.
        </div>
      </div>

      <div class="section">
        <h4>Why is this ignored?</h4>
        <div class="inline-form">
          <input
            type="text"
            placeholder="e.g. build/output.js"
            .value=${this.checkPath}
            aria-label="Path to check"
            @input=${(e: Event) =>
              (this.checkPath = (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') this.handleCheckPath();
            }}
          />
          <button
            class="btn btn-secondary"
            ?disabled=${this.checkPath.trim().length === 0}
            @click=${this.handleCheckPath}
          >
            Check
          </button>
        </div>
        ${this.renderCheckResult()}
      </div>
    `;
  }

  private renderAttributeItem(attr: GitAttribute) {
    if (this.editingLine === attr.lineNumber) {
      return html`
        <div class="attr-item">
          <div class="inline-form">
            <input
              type="text"
              aria-label="Edit pattern"
              .value=${this.editPattern}
              @input=${(e: Event) =>
                (this.editPattern = (e.target as HTMLInputElement).value)}
            />
            <input
              type="text"
              aria-label="Edit attributes"
              .value=${this.editValue}
              @input=${(e: Event) =>
                (this.editValue = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="inline-form">
            <button
              class="btn btn-primary"
              ?disabled=${this.saving ||
              this.editPattern.trim().length === 0 ||
              this.editValue.trim().length === 0}
              @click=${() => this.handleUpdateAttribute(attr.lineNumber)}
            >
              Save
            </button>
            <button class="btn btn-secondary" @click=${this.cancelEditingAttribute}>
              Cancel
            </button>
          </div>
        </div>
      `;
    }

    return html`
      <div class="attr-item">
        <div class="attr-header">
          <span class="attr-pattern">${attr.pattern}</span>
          <span>
            <button
              class="btn-icon"
              title="Edit"
              aria-label="Edit ${attr.pattern}"
              ?disabled=${this.saving}
              @click=${() => this.startEditingAttribute(attr)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"></path>
              </svg>
            </button>
            <button
              class="btn-icon danger"
              title="Remove"
              aria-label="Remove ${attr.pattern}"
              ?disabled=${this.saving}
              @click=${() => this.handleRemoveAttribute(attr)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </span>
        </div>
        <div class="attr-chips">
          ${attr.attributes.map(
            (a) => html`<span class="attr-chip">${formatAttributeToken(a)}</span>`,
          )}
        </div>
      </div>
    `;
  }

  private renderAttributesTab() {
    if (this.loading) {
      return html`<div class="loading-indicator">Loading...</div>`;
    }

    // Hint for the attribute the user is currently typing: the last
    // whitespace-separated token, minus the `-`/`!` prefix and any `=value`
    // suffix, so `*.md diff=markdown` still hints on `diff` and a hyphenated
    // name like `export-ignore` is not chopped in half.
    const typedToken = this.newAttrValue.trim().split(/\s+/).pop() ?? '';
    const typedName = typedToken.replace(/^[-!]/, '').split('=')[0];
    const selected = this.commonAttributes.find((c) => c.name === typedName);

    return html`
      ${this.attributeRules.length === 0
        ? html`<div class="empty-state">
            No .gitattributes rules yet — add one below.
          </div>`
        : html`<div class="attr-list">
            ${this.attributeRules.map((attr) => this.renderAttributeItem(attr))}
          </div>`}

      <div class="section">
        <h4>Add a rule</h4>
        <div class="inline-form">
          <input
            type="text"
            placeholder="Pattern, e.g. *.psd"
            aria-label="Attribute pattern"
            .value=${this.newAttrPattern}
            @input=${(e: Event) =>
              (this.newAttrPattern = (e.target as HTMLInputElement).value)}
          />
          <input
            type="text"
            list="gn-common-attributes"
            placeholder="Attributes, e.g. binary"
            aria-label="Attributes"
            .value=${this.newAttrValue}
            @input=${(e: Event) =>
              (this.newAttrValue = (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') this.handleAddAttribute();
            }}
          />
          <datalist id="gn-common-attributes">
            ${this.commonAttributes.map(
              (c) => html`<option value=${c.name}>${c.description}</option>`,
            )}
          </datalist>
          <button
            class="btn btn-primary"
            ?disabled=${this.saving ||
            this.newAttrPattern.trim().length === 0 ||
            this.newAttrValue.trim().length === 0}
            @click=${this.handleAddAttribute}
          >
            Add
          </button>
        </div>
        <div class="hint">
          ${selected
            ? html`${selected.name}: ${selected.description} — e.g.
              <code>${selected.example}</code>`
            : html`Common attributes:
              ${this.commonAttributes.map((c) => c.name).join(', ')}`}
        </div>
      </div>
    `;
  }

  render() {
    if (!this.open) return null;

    return html`
      <gn-modal modalTitle="Ignore Rules & Attributes" open @close=${this.handleClose}>
        <div class="content">
          ${this.error
            ? html`
                <div class="error-banner">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="15" y1="9" x2="9" y2="15"></line>
                    <line x1="9" y1="9" x2="15" y2="15"></line>
                  </svg>
                  ${this.error}
                </div>
              `
            : ''}

          <div class="tabs">
            <button
              class="tab ${this.activeTab === 'ignore' ? 'active' : ''}"
              @click=${() => (this.activeTab = 'ignore')}
            >
              .gitignore
            </button>
            <button
              class="tab ${this.activeTab === 'attributes' ? 'active' : ''}"
              @click=${() => (this.activeTab = 'attributes')}
            >
              .gitattributes
            </button>
          </div>

          ${this.activeTab === 'ignore'
            ? this.renderIgnoreTab()
            : this.renderAttributesTab()}
        </div>
      </gn-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-gitignore-dialog': GnGitignoreDialog;
  }
}
