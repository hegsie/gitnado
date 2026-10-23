/**
 * Search Dialog
 *
 * The UI half of the repository content-search backend. `search_in_files`
 * (git grep), `search_in_diff` and `search_commits_by_content` (pickaxe) all
 * shipped with typed service wrappers and a full Rust test suite, but nothing
 * in the app ever called them: the only search a user could reach was the
 * toolbar bar, which dims the graph by commit message/author/date/branch via
 * the search index. "Find this text in my files", "search the diff I am
 * looking at" and "which commit introduced this string" had no entry point at
 * all.
 *
 * Every result row here lands somewhere real — a file match opens blame for
 * that file, a diff match opens that file's working-tree diff, a commit match
 * is revealed in the graph — so the dialog is a way into the app rather than a
 * dead-end list.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import * as gitService from '../../services/git.service.ts';
import type {
  SearchResult,
  SearchFileResult,
  SearchCommit,
} from '../../services/git.service.ts';
import { pushOverlay, removeOverlay, isTopOverlay } from '../../utils/overlay-stack.ts';
import { containsDeepActiveElement } from '../../utils/focus.ts';

export type SearchDialogMode = 'files' | 'diff' | 'commits';

/** Mirrors the backend defaults so the "narrow your search" hint is truthful. */
const FILE_MATCH_CAP = 500;
const COMMIT_CAP = 100;

/** Reused so a result list of hundreds of rows does not build one per row. */
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

@customElement('gn-search-dialog')
export class GnSearchDialog extends LitElement {
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
        width: 760px;
        max-width: 92vw;
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

      .subtitle {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
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
      }

      .close-btn:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .close-btn svg {
        width: 16px;
        height: 16px;
      }

      .controls {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        padding: var(--spacing-md) var(--spacing-lg);
        border-bottom: 1px solid var(--color-border);
      }

      .modes {
        display: flex;
        gap: 0;
      }

      .mode-btn {
        padding: var(--spacing-xs) var(--spacing-md);
        font-size: var(--font-size-sm);
        border: 1px solid var(--color-border);
        background: var(--color-bg-tertiary);
        color: var(--color-text-secondary);
        cursor: pointer;
      }

      .mode-btn:first-child {
        border-radius: var(--radius-sm) 0 0 var(--radius-sm);
      }

      .mode-btn:last-child {
        border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
      }

      .mode-btn + .mode-btn {
        border-left: none;
      }

      .mode-btn.active {
        background: var(--color-primary);
        border-color: var(--color-primary);
        color: white;
      }

      .query-row {
        display: flex;
        gap: var(--spacing-sm);
      }

      .query-input {
        flex: 1;
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: var(--font-size-sm);
        font-family: var(--font-mono);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
      }

      .search-btn {
        padding: var(--spacing-xs) var(--spacing-lg);
        font-size: var(--font-size-sm);
        border: 1px solid var(--color-primary);
        border-radius: var(--radius-sm);
        background: var(--color-primary);
        color: white;
        cursor: pointer;
      }

      .search-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .options {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--spacing-md);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .options label {
        display: flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
      }

      .pattern-input {
        flex: 1;
        min-width: 140px;
        padding: 2px var(--spacing-sm);
        font-size: var(--font-size-xs);
        font-family: var(--font-mono);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
      }

      .content {
        flex: 1;
        overflow-y: auto;
        padding: var(--spacing-md) var(--spacing-lg);
      }

      .status,
      .empty {
        padding: var(--spacing-lg);
        text-align: center;
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }

      .error {
        padding: var(--spacing-sm) var(--spacing-md);
        border: 1px solid var(--color-error);
        border-radius: var(--radius-sm);
        background: var(--color-error-bg);
        color: var(--color-error);
        font-size: var(--font-size-sm);
        word-break: break-word;
      }

      .notice {
        margin-bottom: var(--spacing-sm);
        padding: var(--spacing-xs) var(--spacing-sm);
        border-radius: var(--radius-sm);
        background: var(--color-warning-bg);
        color: var(--color-warning);
        font-size: var(--font-size-xs);
      }

      .result-summary {
        margin-bottom: var(--spacing-sm);
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }

      .result-group {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin-bottom: var(--spacing-sm);
      }

      .result-file {
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-semibold);
        font-family: var(--font-mono);
        color: var(--color-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-sm);
      }

      .result-item {
        display: flex;
        align-items: baseline;
        gap: var(--spacing-sm);
        width: 100%;
        text-align: left;
        padding: var(--spacing-xs) var(--spacing-sm);
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        cursor: pointer;
        font-size: var(--font-size-xs);
        color: var(--color-text-primary);
      }

      .result-item:hover,
      .result-item:focus-visible {
        background: var(--color-bg-hover);
        outline: none;
      }

      .result-line {
        font-family: var(--font-mono);
        color: var(--color-text-muted);
        flex-shrink: 0;
      }

      .result-path {
        font-family: var(--font-mono);
        color: var(--color-text-secondary);
        white-space: nowrap;
        flex-shrink: 0;
      }

      .result-content {
        flex: 1;
        font-family: var(--font-mono);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .result-match {
        background: var(--color-warning-bg);
        color: var(--color-warning);
        border-radius: 2px;
        padding: 0 1px;
      }

      .commit-item {
        flex-direction: column;
        align-items: stretch;
        gap: 2px;
      }

      .commit-top {
        display: flex;
        align-items: baseline;
        gap: var(--spacing-sm);
      }

      .commit-oid {
        font-family: var(--font-mono);
        color: var(--color-primary);
        flex-shrink: 0;
      }

      .commit-message {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .commit-meta {
        display: flex;
        gap: var(--spacing-md);
        color: var(--color-text-muted);
        font-size: 10px;
      }

      .commit-files {
        font-family: var(--font-mono);
        color: var(--color-text-muted);
        font-size: 10px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: String }) repositoryPath = '';
  @property({ type: String }) mode: SearchDialogMode = 'files';

  @state() private query = '';
  @state() private caseSensitive = false;
  @state() private useRegex = false;
  @state() private filePattern = '';
  @state() private staged = false;
  @state() private ignoreCase = false;

  @state() private searching = false;
  @state() private searched = false;
  @state() private capped = false;
  @state() private error: string | null = null;
  @state() private repoChanged = false;
  @state() private fileResults: SearchFileResult[] = [];
  @state() private diffResults: SearchResult[] = [];
  /**
   * The staged flag the rows on screen were found with. The radio can be
   * flipped after a search, so reading `staged` at click time would open the
   * opposite side of the diff from the one the match came from.
   */
  @state() private diffResultsStaged = false;
  @state() private commitResults: SearchCommit[] = [];

  /**
   * Repo captured when the dialog opened. `repositoryPath` is live-bound to
   * the ACTIVE repository and rebinds the instant the user Ctrl+Tabs — a
   * document-level shortcut this overlay does not block. Every search targets
   * the pinned path, so the rows on screen and the repository they navigate
   * into can never disagree.
   */
  private pinnedRepoPath = '';

  /** The repo this dialog is pinned to while open, or null when closed. */
  public get pinnedRepositoryPathIfOpen(): string | null {
    return this.open ? this.pinnedRepoPath : null;
  }

  /**
   * Bumped by every search AND by every re-pin: a response is applied only if
   * its token is still current, so a slow git grep against repo A cannot paint
   * its rows over repo B after a tab switch.
   */
  private searchToken = 0;

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this.handleKeyDown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    removeOverlay(this);
    document.removeEventListener('keydown', this.handleKeyDown);
  }

  // Pinning happens BEFORE the render that follows it, so the dropped results
  // never paint: doing it in updated() would queue a second update and flash
  // the previous repository's rows.
  willUpdate(changedProps: Map<string, unknown>): void {
    const opening = changedProps.has('open') && this.open;
    const switchedWhileOpen = this.open && !opening && changedProps.has('repositoryPath');
    if ((opening || switchedWhileOpen) && this.repositoryPath !== this.pinnedRepoPath) {
      this.repin(switchedWhileOpen);
    }
  }

  updated(changedProps: Map<string, unknown>): void {
    if (changedProps.has('open')) {
      if (this.open) {
        pushOverlay(this);
        this.focusInitialControl();
      } else {
        removeOverlay(this);
      }
    }
  }

  /**
   * Re-aim at the active repository and drop everything the previous one
   * produced. Leaving the rows up would let a click navigate repo B using a
   * hit found in repo A.
   */
  private repin(announce: boolean): void {
    this.pinnedRepoPath = this.repositoryPath;
    this.searchToken++;
    this.fileResults = [];
    this.diffResults = [];
    this.commitResults = [];
    this.error = null;
    this.searched = false;
    this.capped = false;
    this.searching = false;
    this.repoChanged = announce;
  }

  /**
   * A search dialog's first control is its query field — unlike the
   * destructive dialogs, no row here carries an action that can be fired by a
   * stray Enter, so starting in the input is safe and saves a Tab.
   */
  private focusInitialControl(): void {
    requestAnimationFrame(() => {
      if (!this.open) return;
      if (containsDeepActiveElement(this)) return;
      const input = this.shadowRoot?.querySelector('.query-input') as HTMLElement | null;
      input?.focus();
    });
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    // Only the topmost overlay owns Escape — every dialog listens on document.
    if (!this.open || !isTopOverlay(this)) return;
    if (e.key === 'Escape') this.close();
  };

  private handleOverlayClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) this.close();
  }

  public close(): void {
    this.open = false;
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private setMode(mode: SearchDialogMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    // A search still in flight belongs to the mode we just left: bumping the
    // token drops its response, so it cannot mark the new mode searched and
    // report a false "No matches found" over results it never produced.
    this.searchToken++;
    this.searching = false;
    // The result arrays are per-mode, so only the shared banners need clearing.
    this.error = null;
    this.capped = false;
    this.searched = false;
    // The mode is parent-owned: without telling app-shell, its `.mode` binding
    // still holds the value it last pushed, so reopening the dialog in that
    // same mode would be dirty-checked away and land on this one instead.
    this.dispatchEvent(
      new CustomEvent('mode-changed', { detail: { mode }, bubbles: true, composed: true }),
    );
  }

  private get canSearch(): boolean {
    return !!this.query.trim() && !this.searching;
  }

  private async runSearch(): Promise<void> {
    if (!this.canSearch) return;
    const repoPath = this.pinnedRepoPath;
    if (!repoPath) return;

    const query = this.query.trim();
    const mode = this.mode;
    const token = ++this.searchToken;

    this.searching = true;
    this.error = null;
    this.capped = false;
    this.repoChanged = false;

    try {
      if (mode === 'files') {
        const result = await gitService.searchInFiles(
          repoPath,
          query,
          this.caseSensitive,
          this.useRegex,
          this.filePattern.trim() || undefined,
          FILE_MATCH_CAP,
        );
        if (token !== this.searchToken) return;
        if (result.success) {
          this.fileResults = result.data ?? [];
          this.capped = this.totalFileMatches >= FILE_MATCH_CAP;
          this.finishSuccess();
        } else {
          this.fail(result.error?.message);
        }
      } else if (mode === 'diff') {
        const staged = this.staged;
        const result = await gitService.searchInDiff(repoPath, query, staged);
        if (token !== this.searchToken) return;
        if (result.success) {
          this.diffResults = result.data ?? [];
          this.diffResultsStaged = staged;
          this.finishSuccess();
        } else {
          this.fail(result.error?.message);
        }
      } else {
        const result = await gitService.searchCommitsByContent(
          repoPath,
          query,
          this.useRegex,
          this.ignoreCase,
          COMMIT_CAP,
        );
        if (token !== this.searchToken) return;
        if (result.success) {
          this.commitResults = result.data ?? [];
          this.capped = this.commitResults.length >= COMMIT_CAP;
          this.finishSuccess();
        } else {
          this.fail(result.error?.message);
        }
      }
    } catch (err) {
      if (token === this.searchToken) {
        this.fail(err instanceof Error ? err.message : undefined);
      }
    } finally {
      if (token === this.searchToken) this.searching = false;
    }
  }

  private finishSuccess(): void {
    this.error = null;
    this.searched = true;
  }

  /**
   * The dialog stays open on failure, so the error belongs inline in the
   * results area — a toast would be dismissed behind the overlay the user is
   * still looking at.
   */
  private fail(message?: string): void {
    this.error = message ?? 'Search failed';
    this.fileResults = [];
    this.diffResults = [];
    this.commitResults = [];
    this.capped = false;
    this.searched = true;
  }

  private get totalFileMatches(): number {
    return this.fileResults.reduce((sum, f) => sum + f.matches.length, 0);
  }

  private get hasResults(): boolean {
    if (this.mode === 'files') return this.fileResults.length > 0;
    if (this.mode === 'diff') return this.diffResults.length > 0;
    return this.commitResults.length > 0;
  }

  private handleQueryKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      void this.runSearch();
    }
  }

  private emitAndClose(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
    this.close();
  }

  /**
   * `matchStart`/`matchEnd` are UTF-8 BYTE offsets — the backend finds them with
   * Rust's `str::find`. JavaScript string indices are UTF-16 code units, so
   * slicing the string with them mis-highlights every line that carries a
   * non-ASCII character before the match. Slice the encoded bytes instead.
   */
  private renderHighlighted(content: string, start: number, end: number) {
    const bytes = UTF8_ENCODER.encode(content);
    if (end <= start || start < 0 || start >= bytes.length) {
      return html`${content}`;
    }
    const safeEnd = Math.min(end, bytes.length);
    const before = UTF8_DECODER.decode(bytes.subarray(0, start));
    const match = UTF8_DECODER.decode(bytes.subarray(start, safeEnd));
    const after = UTF8_DECODER.decode(bytes.subarray(safeEnd));
    return html`${before}<mark class="result-match">${match}</mark>${after}`;
  }

  private formatDate(timestamp: number): string {
    return new Date(timestamp * 1000).toLocaleString();
  }

  render() {
    return html`
      <div class="overlay" @click=${this.handleOverlayClick}></div>
      <div class="dialog">
        <div class="header">
          <div class="header-left">
            <svg class="header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <div>
              <div class="title">Search</div>
              <div class="subtitle">Find text in files, in the current diff, or in history</div>
            </div>
          </div>
          <button class="close-btn" @click=${this.close} aria-label="Close search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="controls">
          <div class="modes">
            ${(
              [
                ['files', 'Files'],
                ['diff', 'Diff'],
                ['commits', 'Commits'],
              ] as Array<[SearchDialogMode, string]>
            ).map(
              ([value, label]) => html`
                <button
                  class="mode-btn ${this.mode === value ? 'active' : ''}"
                  type="button"
                  aria-pressed=${this.mode === value ? 'true' : 'false'}
                  @click=${() => this.setMode(value)}
                >
                  ${label}
                </button>
              `,
            )}
          </div>

          <div class="query-row">
            <input
              class="query-input"
              type="text"
              placeholder=${this.mode === 'files'
                ? 'Search tracked files…'
                : this.mode === 'diff'
                  ? 'Search the current diff…'
                  : 'Find commits that added or removed…'}
              aria-label="Search query"
              .value=${this.query}
              @input=${(e: InputEvent) => {
                this.query = (e.target as HTMLInputElement).value;
              }}
              @keydown=${this.handleQueryKeyDown}
            />
            <button
              class="search-btn"
              ?disabled=${!this.canSearch}
              @click=${() => void this.runSearch()}
            >
              ${this.searching ? 'Searching…' : 'Search'}
            </button>
          </div>

          <div class="options">${this.renderModeOptions()}</div>
        </div>

        <div class="content">${this.renderResults()}</div>
      </div>
    `;
  }

  private renderModeOptions() {
    if (this.mode === 'files') {
      return html`
        <label>
          <input
            type="checkbox"
            class="opt-case"
            .checked=${this.caseSensitive}
            @change=${(e: Event) => {
              this.caseSensitive = (e.target as HTMLInputElement).checked;
            }}
          />
          Case sensitive
        </label>
        <label>
          <input
            type="checkbox"
            class="opt-regex"
            .checked=${this.useRegex}
            @change=${(e: Event) => {
              this.useRegex = (e.target as HTMLInputElement).checked;
            }}
          />
          Regex
        </label>
        <input
          class="pattern-input"
          type="text"
          placeholder="File pattern (e.g. *.ts)"
          aria-label="File pattern"
          .value=${this.filePattern}
          @input=${(e: InputEvent) => {
            this.filePattern = (e.target as HTMLInputElement).value;
          }}
          @keydown=${this.handleQueryKeyDown}
        />
      `;
    }

    if (this.mode === 'diff') {
      return html`
        <label>
          <input
            type="radio"
            name="diff-source"
            class="opt-unstaged"
            .checked=${!this.staged}
            @change=${() => {
              this.staged = false;
            }}
          />
          Unstaged
        </label>
        <label>
          <input
            type="radio"
            name="diff-source"
            class="opt-staged"
            .checked=${this.staged}
            @change=${() => {
              this.staged = true;
            }}
          />
          Staged
        </label>
      `;
    }

    return html`
      <label>
        <input
          type="checkbox"
          class="opt-regex"
          .checked=${this.useRegex}
          @change=${(e: Event) => {
            this.useRegex = (e.target as HTMLInputElement).checked;
          }}
        />
        Regex
      </label>
      <label>
        <input
          type="checkbox"
          class="opt-ignore-case"
          .checked=${this.ignoreCase}
          @change=${(e: Event) => {
            this.ignoreCase = (e.target as HTMLInputElement).checked;
          }}
        />
        Ignore case
      </label>
    `;
  }

  private renderResults() {
    if (this.searching) return html`<div class="status">Searching…</div>`;
    if (this.error) return html`<div class="error">${this.error}</div>`;

    const notice = this.repoChanged
      ? html`<div class="notice">Repository changed — run the search again</div>`
      : nothing;

    if (!this.searched) {
      return html`${notice}
        <div class="status">Enter a search and press Enter.</div>`;
    }
    if (!this.hasResults) {
      return html`${notice}<div class="empty">No matches found</div>`;
    }

    return html`
      ${notice}
      <div class="result-summary">${this.summaryText()}</div>
      ${this.mode === 'files'
        ? this.renderFileResults()
        : this.mode === 'diff'
          ? this.renderDiffResults()
          : this.renderCommitResults()}
    `;
  }

  private summaryText(): string {
    if (this.mode === 'files') {
      const files = this.fileResults.length;
      const matches = this.totalFileMatches;
      const base = `${matches} ${matches === 1 ? 'match' : 'matches'} in ${files} ${
        files === 1 ? 'file' : 'files'
      }`;
      return this.capped ? `${base} — showing the first ${FILE_MATCH_CAP}, narrow your search` : base;
    }
    if (this.mode === 'diff') {
      const n = this.diffResults.length;
      return `${n} ${n === 1 ? 'match' : 'matches'}`;
    }
    const n = this.commitResults.length;
    const base = `${n} ${n === 1 ? 'commit' : 'commits'}`;
    return this.capped ? `${base} — showing the first ${COMMIT_CAP}, narrow your search` : base;
  }

  private renderRowButton(onActivate: () => void, extraClass: string, body: unknown) {
    return html`
      <button class="result-item ${extraClass}" type="button" @click=${onActivate}>
        ${body}
      </button>
    `;
  }

  private renderFileResults() {
    return html`
      ${this.fileResults.map(
        (file) => html`
          <div class="result-group">
            <div class="result-file">${file.filePath}</div>
            ${file.matches.map((m) =>
              this.renderRowButton(
                () => this.emitAndClose('show-blame', { filePath: file.filePath }),
                '',
                html`
                  <span class="result-line">:${m.lineNumber}</span>
                  <span class="result-content"
                    >${this.renderHighlighted(m.lineContent, m.matchStart, m.matchEnd)}</span
                  >
                `,
              ),
            )}
          </div>
        `,
      )}
    `;
  }

  private renderDiffResults() {
    return html`
      ${this.diffResults.map((m) =>
        this.renderRowButton(
          () =>
            this.emitAndClose('show-working-diff', {
              filePath: m.filePath,
              staged: this.diffResultsStaged,
            }),
          '',
          html`
            <span class="result-path">${m.filePath}</span>
            <span class="result-line">:${m.lineNumber}</span>
            <span class="result-content"
              >${this.renderHighlighted(m.lineContent, m.matchStart, m.matchEnd)}</span
            >
          `,
        ),
      )}
    `;
  }

  private renderCommitResults() {
    return html`
      ${this.commitResults.map((c) =>
        this.renderRowButton(
          () => this.emitAndClose('show-commit', { oid: c.oid }),
          'commit-item',
          html`
            <span class="commit-top">
              <span class="commit-oid">${c.shortOid}</span>
              <span class="commit-message">${c.message}</span>
            </span>
            <span class="commit-meta">
              <span>${c.authorName}</span>
              <span>${this.formatDate(c.authorDate)}</span>
            </span>
            ${c.matches.length > 0
              ? html`<span class="commit-files"
                  >${c.matches.map((m) => m.filePath).join(', ')}</span
                >`
              : nothing}
          `,
        ),
      )}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-search-dialog': GnSearchDialog;
  }
}
