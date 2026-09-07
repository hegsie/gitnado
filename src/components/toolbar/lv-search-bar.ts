import { LitElement, html, css } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { showPrompt } from '../../services/dialog.service.ts';

export type SearchMode = 'keyword' | 'semantic';

export interface SearchFilter {
  query: string;
  author: string;
  dateFrom: string;
  dateTo: string;
  filePath: string;
  branch: string;
  searchMode: SearchMode;
}

export interface FilterPreset {
  id: string;
  name: string;
  filter: SearchFilter;
}

@customElement('lv-search-bar')
export class LvSearchBar extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .search-container {
        display: flex;
        align-items: center;
        gap: 8px;
        background: var(--input-background);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        padding: 4px 8px;
        transition: border-color 0.2s;
      }

      .search-container:focus-within {
        border-color: var(--accent-color);
      }

      .search-icon {
        color: var(--text-secondary);
        flex-shrink: 0;
      }

      input {
        flex: 1;
        border: none;
        background: transparent;
        color: var(--text-primary);
        font-size: 13px;
        padding: 6px 0;
        outline: none;
        min-width: 150px;
      }

      input::placeholder {
        color: var(--text-tertiary);
      }

      .clear-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        cursor: pointer;
        border-radius: 3px;
        padding: 0;
      }

      .clear-btn:hover {
        background: var(--hover-background);
        color: var(--text-primary);
      }

      .filter-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        cursor: pointer;
        border-radius: 4px;
      }

      .filter-btn:hover {
        background: var(--hover-background);
      }

      .filter-btn.active {
        color: var(--accent-color);
        background: var(--accent-background);
      }

      .semantic-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        cursor: pointer;
        border-radius: 4px;
        font-size: 14px;
      }

      .semantic-btn:hover {
        background: var(--hover-background);
      }

      .semantic-btn.active {
        color: var(--accent-color);
        background: var(--accent-background);
      }

      .filters-panel {
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        margin-top: 4px;
        background: var(--panel-background);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        padding: 12px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        z-index: 100;
      }

      .filter-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }

      .filter-row:last-child {
        margin-bottom: 0;
      }

      .filter-label {
        font-size: 12px;
        color: var(--text-secondary);
        min-width: 60px;
      }

      .filter-input {
        flex: 1;
        padding: 6px 8px;
        border: 1px solid var(--border-color);
        border-radius: 4px;
        background: var(--input-background);
        color: var(--text-primary);
        font-size: 12px;
      }

      .filter-input:focus {
        outline: none;
        border-color: var(--accent-color);
      }

      .filter-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
        padding-top: 12px;
        border-top: 1px solid var(--border-color);
      }

      .filter-actions button {
        padding: 6px 12px;
        border-radius: 4px;
        font-size: 12px;
        cursor: pointer;
        border: 1px solid var(--border-color);
        background: var(--button-background);
        color: var(--text-primary);
      }

      .filter-actions button:hover {
        background: var(--button-hover-background);
      }

      .filter-actions button.primary {
        background: var(--accent-color);
        border-color: var(--accent-color);
        color: white;
      }

      .result-count {
        font-size: 11px;
        color: var(--text-secondary);
        padding: 0 4px;
      }

      .wrapper {
        position: relative;
      }

      .preset-list {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--border-color);
      }

      .preset-list-title {
        font-size: 11px;
        color: var(--text-secondary);
        margin-bottom: 4px;
      }

      .preset-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        color: var(--text-primary);
      }

      .preset-item:hover {
        background: var(--hover-background);
      }

      .preset-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .preset-delete {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        cursor: pointer;
        border-radius: 3px;
        padding: 0;
        flex-shrink: 0;
      }

      .preset-delete:hover {
        background: var(--hover-background);
        color: var(--text-primary);
      }
    `,
  ];

  private static readonly PRESETS_STORAGE_KEY = 'gitnado-search-filter-presets';
  private static readonly PRESETS_MAX = 10;

  @property({ type: Boolean }) expanded = false;
  @property({ type: Number }) resultCount = 0;
  @property({ type: Boolean }) showResultCount = false;
  @property({ type: Boolean }) semanticAvailable = false;

  @state() private query = '';
  @state() private author = '';
  @state() private dateFrom = '';
  @state() private dateTo = '';
  @state() private filePath = '';
  @state() private branch = '';
  @state() private searchMode: SearchMode = 'keyword';
  @state() private showFilters = false;
  @state() private presets: FilterPreset[] = [];

  @query('input[type="text"]') private inputEl!: HTMLInputElement;

  connectedCallback(): void {
    super.connectedCallback();
    this.loadPresets();
  }

  focus(): void {
    this.inputEl?.focus();
  }

  private loadPresets(): void {
    try {
      const stored = localStorage.getItem(LvSearchBar.PRESETS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          this.presets = parsed.slice(0, LvSearchBar.PRESETS_MAX);
        }
      }
    } catch {
      // localStorage unavailable or corrupt - silently ignore
    }
  }

  private savePreset(name: string): void {
    const preset: FilterPreset = {
      id: `preset-${Date.now()}`,
      name,
      filter: {
        query: this.query,
        author: this.author,
        dateFrom: this.dateFrom,
        dateTo: this.dateTo,
        filePath: this.filePath,
        branch: this.branch,
        searchMode: this.searchMode,
      },
    };

    const updated = [preset, ...this.presets].slice(0, LvSearchBar.PRESETS_MAX);
    this.presets = updated;
    try {
      localStorage.setItem(LvSearchBar.PRESETS_STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // localStorage quota exceeded or unavailable - silently ignore
    }
  }

  private loadPreset(preset: FilterPreset): void {
    this.query = preset.filter.query;
    this.author = preset.filter.author;
    this.dateFrom = preset.filter.dateFrom;
    this.dateTo = preset.filter.dateTo;
    this.filePath = preset.filter.filePath;
    this.branch = preset.filter.branch;
    // Restore search mode; older presets may lack the field, so default to keyword.
    this.searchMode = preset.filter.searchMode ?? 'keyword';
    this.emitSearch();
  }

  private deletePreset(id: string): void {
    const updated = this.presets.filter((p) => p.id !== id);
    this.presets = updated;
    try {
      localStorage.setItem(LvSearchBar.PRESETS_STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // localStorage quota exceeded or unavailable - silently ignore
    }
  }

  private async handleSavePreset(): Promise<void> {
    const name = await showPrompt('Save Preset', 'Preset name:');
    if (name?.trim()) {
      this.savePreset(name.trim());
    }
  }

  private handleInput(e: Event): void {
    const input = e.target as HTMLInputElement;
    this.query = input.value;
    this.emitSearch();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      this.query = '';
      this.emitSearch();
      this.inputEl?.blur();
    } else if (e.key === 'Enter') {
      this.emitSearch();
    }
  }

  private handleClear(): void {
    this.query = '';
    this.author = '';
    this.dateFrom = '';
    this.dateTo = '';
    this.filePath = '';
    this.branch = '';
    this.emitSearch();
    this.inputEl?.focus();
  }

  private toggleFilters(): void {
    this.showFilters = !this.showFilters;
  }

  private handleAuthorChange(e: Event): void {
    this.author = (e.target as HTMLInputElement).value;
  }

  private handleDateFromChange(e: Event): void {
    this.dateFrom = (e.target as HTMLInputElement).value;
  }

  private handleDateToChange(e: Event): void {
    this.dateTo = (e.target as HTMLInputElement).value;
  }

  private handleFilePathChange(e: Event): void {
    this.filePath = (e.target as HTMLInputElement).value;
  }

  private handleBranchChange(e: Event): void {
    this.branch = (e.target as HTMLInputElement).value;
  }

  private applyFilters(): void {
    this.showFilters = false;
    this.emitSearch();
  }

  private clearFilters(): void {
    this.author = '';
    this.dateFrom = '';
    this.dateTo = '';
    this.filePath = '';
    this.branch = '';
    this.emitSearch();
  }

  private toggleSearchMode(): void {
    this.searchMode = this.searchMode === 'keyword' ? 'semantic' : 'keyword';
    this.emitSearch();
  }

  private emitSearch(): void {
    const filter: SearchFilter = {
      query: this.query,
      author: this.author,
      dateFrom: this.dateFrom,
      dateTo: this.dateTo,
      filePath: this.filePath,
      branch: this.branch,
      searchMode: this.searchMode,
    };

    this.dispatchEvent(
      new CustomEvent('search-change', {
        detail: filter,
        bubbles: true,
        composed: true,
      })
    );
  }

  private hasActiveFilters(): boolean {
    return !!(this.author || this.dateFrom || this.dateTo || this.filePath || this.branch);
  }

  render() {
    const hasQuery = this.query.length > 0;
    const hasFilters = this.hasActiveFilters();

    return html`
      <div class="wrapper">
        <div class="search-container">
          <svg class="search-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
          </svg>

          <input
            type="text"
            placeholder="${this.searchMode === 'semantic' ? 'Search commits by meaning...' : 'Search commits...'}"
            .value=${this.query}
            @input=${this.handleInput}
            @keydown=${this.handleKeyDown}
          />

          ${this.showResultCount && hasQuery
            ? html`<span class="result-count">${this.resultCount} results</span>`
            : null}

          ${hasQuery || hasFilters
            ? html`
                <button class="clear-btn" @click=${this.handleClear} title="Clear search">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                    <path d="M6 4.586L1.707.293A1 1 0 00.293 1.707L4.586 6 .293 10.293a1 1 0 101.414 1.414L6 7.414l4.293 4.293a1 1 0 001.414-1.414L7.414 6l4.293-4.293A1 1 0 0010.293.293L6 4.586z"/>
                  </svg>
                </button>
              `
            : null}

          ${this.semanticAvailable ? html`
            <button
              class="semantic-btn ${this.searchMode === 'semantic' ? 'active' : ''}"
              @click=${this.toggleSearchMode}
              title="${this.searchMode === 'semantic' ? 'Switch to keyword search' : 'Switch to semantic search'}"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1a3.5 3.5 0 0 0-3.5 3.5c0 1.193.603 2.26 1.5 2.898V9.5a1 1 0 0 0 .293.707l1 1a1 1 0 0 0 1.414 0l1-1A1 1 0 0 0 10 9.5V7.398A3.496 3.496 0 0 0 11.5 4.5 3.5 3.5 0 0 0 8 1zm0 1.5a2 2 0 0 1 2 2 2 2 0 0 1-2 2 2 2 0 0 1-2-2 2 2 0 0 1 2-2zM5.5 12a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1h-5zm1 2a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1h-3z"/>
              </svg>
            </button>
          ` : null}

          <button
            class="filter-btn ${hasFilters ? 'active' : ''}"
            @click=${this.toggleFilters}
            title="Advanced filters"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1.5 1.5A.5.5 0 0 1 2 1h12a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-.128.334L10 8.692V13.5a.5.5 0 0 1-.342.474l-3 1A.5.5 0 0 1 6 14.5V8.692L1.628 3.834A.5.5 0 0 1 1.5 3.5v-2z"/>
            </svg>
          </button>
        </div>

        ${this.showFilters
          ? html`
              <div class="filters-panel">
                <div class="filter-row">
                  <span class="filter-label">Author</span>
                  <input
                    type="text"
                    class="filter-input"
                    placeholder="Author name or email"
                    .value=${this.author}
                    @input=${this.handleAuthorChange}
                  />
                </div>

                <div class="filter-row">
                  <span class="filter-label">From</span>
                  <input
                    type="date"
                    class="filter-input"
                    .value=${this.dateFrom}
                    @change=${this.handleDateFromChange}
                  />
                </div>

                <div class="filter-row">
                  <span class="filter-label">To</span>
                  <input
                    type="date"
                    class="filter-input"
                    .value=${this.dateTo}
                    @change=${this.handleDateToChange}
                  />
                </div>

                <div class="filter-row">
                  <span class="filter-label">Path</span>
                  <input
                    type="text"
                    class="filter-input"
                    placeholder="*.ts, src/**, or file path"
                    .value=${this.filePath}
                    @input=${this.handleFilePathChange}
                  />
                </div>

                <div class="filter-row">
                  <span class="filter-label">Branch</span>
                  <input
                    type="text"
                    class="filter-input"
                    placeholder="Branch or ref name"
                    .value=${this.branch}
                    @input=${this.handleBranchChange}
                  />
                </div>

                <div class="filter-actions">
                  <button @click=${this.clearFilters}>Clear Filters</button>
                  <button @click=${this.handleSavePreset}>Save Preset</button>
                  <button class="primary" @click=${this.applyFilters}>Apply</button>
                </div>
                ${this.presets.length > 0
                  ? html`
                      <div class="preset-list">
                        <div class="preset-list-title">Saved Presets</div>
                        ${this.presets.map(
                          (preset) => html`
                            <div
                              class="preset-item"
                              @click=${() => this.loadPreset(preset)}
                            >
                              <span class="preset-name">${preset.name}</span>
                              <button
                                class="preset-delete"
                                @click=${(e: Event) => {
                                  e.stopPropagation();
                                  this.deletePreset(preset.id);
                                }}
                                title="Delete preset"
                              >
                                <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
                                  <path d="M6 4.586L1.707.293A1 1 0 00.293 1.707L4.586 6 .293 10.293a1 1 0 101.414 1.414L6 7.414l4.293 4.293a1 1 0 001.414-1.414L7.414 6l4.293-4.293A1 1 0 0010.293.293L6 4.586z"/>
                                </svg>
                              </button>
                            </div>
                          `
                        )}
                      </div>
                    `
                  : null}
              </div>
            `
          : null}
      </div>
    `;
  }
}
