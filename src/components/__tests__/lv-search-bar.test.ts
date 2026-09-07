/**
 * Comprehensive tests for lv-search-bar component.
 *
 * These render the REAL lv-search-bar component, mock only the Tauri invoke
 * layer, and verify the actual component behaviour: rendering, search events,
 * filter panel, preset save/load/delete, and clear functionality.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const invokeHistory: Array<{ command: string; args?: unknown }> = [];
const mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import type { LvSearchBar, SearchFilter } from '../toolbar/lv-search-bar.ts';

// Import the actual component — registers <lv-search-bar> custom element
import '../toolbar/lv-search-bar.ts';

// Import prompt dialog so showPrompt finds it in the DOM
import '../dialogs/lv-prompt-dialog.ts';
import type { LvPromptDialog } from '../dialogs/lv-prompt-dialog.ts';

// Helper to mock the themed prompt dialog used by showPrompt
let mockPromptValue: string | null = null;

function setupMockPrompt(value: string | null): void {
  mockPromptValue = value;
  let dialog = document.querySelector<LvPromptDialog>('lv-prompt-dialog');
  if (!dialog) {
    dialog = document.createElement('lv-prompt-dialog') as LvPromptDialog;
    document.body.appendChild(dialog);
  }
  dialog.open = async () => mockPromptValue;
}

function cleanupMockPrompt(): void {
  const dialog = document.querySelector('lv-prompt-dialog');
  if (dialog) dialog.remove();
}

// ── Helpers ────────────────────────────────────────────────────────────────
const PRESETS_STORAGE_KEY = 'gitnado-search-filter-presets';

function clearHistory(): void {
  invokeHistory.length = 0;
}

async function renderSearchBar(): Promise<LvSearchBar> {
  const el = await fixture<LvSearchBar>(
    html`<lv-search-bar></lv-search-bar>`
  );
  await el.updateComplete;
  return el;
}

function getInput(el: LvSearchBar): HTMLInputElement {
  return el.shadowRoot!.querySelector('input[type="text"]') as HTMLInputElement;
}

function getFilterBtn(el: LvSearchBar): HTMLButtonElement {
  return el.shadowRoot!.querySelector('.filter-btn') as HTMLButtonElement;
}

function getClearBtn(el: LvSearchBar): HTMLButtonElement | null {
  return el.shadowRoot!.querySelector('.clear-btn') as HTMLButtonElement | null;
}

async function openFiltersPanel(el: LvSearchBar): Promise<void> {
  const btn = getFilterBtn(el);
  btn.click();
  await el.updateComplete;
}

function getFiltersPanel(el: LvSearchBar): HTMLElement | null {
  return el.shadowRoot!.querySelector('.filters-panel') as HTMLElement | null;
}

function getFilterInput(el: LvSearchBar, label: string): HTMLInputElement | null {
  const rows = el.shadowRoot!.querySelectorAll('.filter-row');
  for (const row of rows) {
    const rowLabel = row.querySelector('.filter-label')?.textContent?.trim();
    if (rowLabel === label) {
      return row.querySelector('.filter-input') as HTMLInputElement;
    }
  }
  return null;
}

function getFilterActionButton(el: LvSearchBar, text: string): HTMLButtonElement | null {
  const buttons = el.shadowRoot!.querySelectorAll('.filter-actions button');
  return Array.from(buttons).find(
    (btn) => btn.textContent?.trim() === text
  ) as HTMLButtonElement | null;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('lv-search-bar', () => {
  beforeEach(() => {
    clearHistory();
    localStorage.removeItem(PRESETS_STORAGE_KEY);
  });

  // ── 1. Rendering ──────────────────────────────────────────────────────
  describe('rendering', () => {
    it('renders a text input with search placeholder', async () => {
      const el = await renderSearchBar();

      const input = getInput(el);
      expect(input).to.not.be.null;
      expect(input.placeholder).to.equal('Search commits...');
    });

    it('renders a filter button (advanced filters toggle)', async () => {
      const el = await renderSearchBar();

      const filterBtn = getFilterBtn(el);
      expect(filterBtn).to.not.be.null;
      expect(filterBtn.title).to.equal('Advanced filters');
    });

    it('does not show clear button when query is empty', async () => {
      const el = await renderSearchBar();

      const clearBtn = getClearBtn(el);
      expect(clearBtn).to.be.null;
    });

    it('does not show filters panel by default', async () => {
      const el = await renderSearchBar();

      const panel = getFiltersPanel(el);
      expect(panel).to.be.null;
    });
  });

  // ── 2. Search event ───────────────────────────────────────────────────
  describe('search event', () => {
    it('dispatches search-change with correct filter fields when typing', async () => {
      const el = await renderSearchBar();

      let receivedFilter: SearchFilter | null = null;
      el.addEventListener('search-change', ((e: CustomEvent) => {
        receivedFilter = e.detail;
      }) as EventListener);

      const input = getInput(el);
      input.value = 'fix bug';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      expect(receivedFilter).to.not.be.null;
      expect(receivedFilter!.query).to.equal('fix bug');
      expect(receivedFilter!.author).to.equal('');
      expect(receivedFilter!.dateFrom).to.equal('');
      expect(receivedFilter!.dateTo).to.equal('');
      expect(receivedFilter!.filePath).to.equal('');
      expect(receivedFilter!.branch).to.equal('');
    });

    it('shows clear button after typing a query', async () => {
      const el = await renderSearchBar();

      const input = getInput(el);
      input.value = 'test';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      const clearBtn = getClearBtn(el);
      expect(clearBtn).to.not.be.null;
    });

    it('dispatches search-change on Escape key with empty query', async () => {
      const el = await renderSearchBar();

      // First type something
      const input = getInput(el);
      input.value = 'hello';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      let receivedFilter: SearchFilter | null = null;
      el.addEventListener('search-change', ((e: CustomEvent) => {
        receivedFilter = e.detail;
      }) as EventListener);

      // Press Escape
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await el.updateComplete;

      expect(receivedFilter).to.not.be.null;
      expect(receivedFilter!.query).to.equal('');
    });
  });

  // ── 3. Filters panel ──────────────────────────────────────────────────
  describe('filters panel', () => {
    it('opens filters panel when filter button is clicked', async () => {
      const el = await renderSearchBar();

      await openFiltersPanel(el);

      const panel = getFiltersPanel(el);
      expect(panel).to.not.be.null;
    });

    it('filters panel contains Author, From, To, Path, and Branch fields', async () => {
      const el = await renderSearchBar();
      await openFiltersPanel(el);

      const labels = el.shadowRoot!.querySelectorAll('.filter-label');
      const labelTexts = Array.from(labels).map((l) => l.textContent?.trim());
      expect(labelTexts).to.include('Author');
      expect(labelTexts).to.include('From');
      expect(labelTexts).to.include('To');
      expect(labelTexts).to.include('Path');
      expect(labelTexts).to.include('Branch');
    });

    it('Apply button dispatches search-change with all filter values and closes panel', async () => {
      const el = await renderSearchBar();
      await openFiltersPanel(el);

      // Fill in filter fields
      const authorInput = getFilterInput(el, 'Author')!;
      authorInput.value = 'alice';
      authorInput.dispatchEvent(new InputEvent('input', { bubbles: true }));

      const branchInput = getFilterInput(el, 'Branch')!;
      branchInput.value = 'main';
      branchInput.dispatchEvent(new InputEvent('input', { bubbles: true }));

      const pathInput = getFilterInput(el, 'Path')!;
      pathInput.value = 'src/**';
      pathInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      let receivedFilter: SearchFilter | null = null;
      el.addEventListener('search-change', ((e: CustomEvent) => {
        receivedFilter = e.detail;
      }) as EventListener);

      // Click Apply
      const applyBtn = getFilterActionButton(el, 'Apply')!;
      expect(applyBtn).to.not.be.null;
      applyBtn.click();
      await el.updateComplete;

      expect(receivedFilter).to.not.be.null;
      expect(receivedFilter!.author).to.equal('alice');
      expect(receivedFilter!.branch).to.equal('main');
      expect(receivedFilter!.filePath).to.equal('src/**');

      // Panel should be closed after Apply
      const panel = getFiltersPanel(el);
      expect(panel).to.be.null;
    });

    it('filter button gets active class when filters are set', async () => {
      const el = await renderSearchBar();
      await openFiltersPanel(el);

      // Set author filter
      const authorInput = getFilterInput(el, 'Author')!;
      authorInput.value = 'bob';
      authorInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      // Click Apply to close and set filters
      const applyBtn = getFilterActionButton(el, 'Apply')!;
      applyBtn.click();
      await el.updateComplete;

      const filterBtn = getFilterBtn(el);
      expect(filterBtn.classList.contains('active')).to.be.true;
    });

    it('Clear Filters button resets only advanced filters, not the query', async () => {
      const el = await renderSearchBar();

      // Type a search query first
      const input = getInput(el);
      input.value = 'some query';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      // Open filters and set values
      await openFiltersPanel(el);
      const authorInput = getFilterInput(el, 'Author')!;
      authorInput.value = 'charlie';
      authorInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      let receivedFilter: SearchFilter | null = null;
      el.addEventListener('search-change', ((e: CustomEvent) => {
        receivedFilter = e.detail;
      }) as EventListener);

      // Click Clear Filters
      const clearFiltersBtn = getFilterActionButton(el, 'Clear Filters')!;
      clearFiltersBtn.click();
      await el.updateComplete;

      expect(receivedFilter).to.not.be.null;
      expect(receivedFilter!.author).to.equal('');
      expect(receivedFilter!.dateFrom).to.equal('');
      expect(receivedFilter!.dateTo).to.equal('');
      expect(receivedFilter!.filePath).to.equal('');
      expect(receivedFilter!.branch).to.equal('');
      // Query should be preserved (clearFilters only clears advanced filters)
      expect(receivedFilter!.query).to.equal('some query');
    });
  });

  // ── 4. Clear button ───────────────────────────────────────────────────
  describe('clear button', () => {
    it('clears all fields (query + filters) and dispatches search-change', async () => {
      const el = await renderSearchBar();

      // Type a query
      const input = getInput(el);
      input.value = 'search term';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      // Set a filter too
      await openFiltersPanel(el);
      const authorInput = getFilterInput(el, 'Author')!;
      authorInput.value = 'dave';
      authorInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
      const applyBtn = getFilterActionButton(el, 'Apply')!;
      applyBtn.click();
      await el.updateComplete;

      let receivedFilter: SearchFilter | null = null;
      el.addEventListener('search-change', ((e: CustomEvent) => {
        receivedFilter = e.detail;
      }) as EventListener);

      // Click the main clear button (X in the search bar)
      const clearBtn = getClearBtn(el)!;
      expect(clearBtn).to.not.be.null;
      clearBtn.click();
      await el.updateComplete;

      expect(receivedFilter).to.not.be.null;
      expect(receivedFilter!.query).to.equal('');
      expect(receivedFilter!.author).to.equal('');
      expect(receivedFilter!.dateFrom).to.equal('');
      expect(receivedFilter!.dateTo).to.equal('');
      expect(receivedFilter!.filePath).to.equal('');
      expect(receivedFilter!.branch).to.equal('');
    });

    it('clear button disappears after clearing', async () => {
      const el = await renderSearchBar();

      // Type a query so clear button appears
      const input = getInput(el);
      input.value = 'test';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;
      expect(getClearBtn(el)).to.not.be.null;

      // Click clear
      getClearBtn(el)!.click();
      await el.updateComplete;

      expect(getClearBtn(el)).to.be.null;
    });
  });

  // ── 5. Preset save ────────────────────────────────────────────────────
  describe('preset save', () => {
    it('Save Preset button stores current filter and shows it in preset list', async () => {
      const el = await renderSearchBar();
      await openFiltersPanel(el);

      // Set some filter values
      const authorInput = getFilterInput(el, 'Author')!;
      authorInput.value = 'eve';
      authorInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      setupMockPrompt('My Preset');

      try {
        const saveBtn = getFilterActionButton(el, 'Save Preset')!;
        expect(saveBtn).to.not.be.null;
        saveBtn.click();
        await new Promise((r) => setTimeout(r, 100));
        await el.updateComplete;

        // Preset should appear in the list
        const presetItems = el.shadowRoot!.querySelectorAll('.preset-item');
        expect(presetItems.length).to.equal(1);

        const presetName = presetItems[0].querySelector('.preset-name');
        expect(presetName!.textContent?.trim()).to.equal('My Preset');

        // Should be persisted to localStorage
        const stored = localStorage.getItem(PRESETS_STORAGE_KEY);
        expect(stored).to.not.be.null;
        const parsed = JSON.parse(stored!);
        expect(parsed.length).to.equal(1);
        expect(parsed[0].name).to.equal('My Preset');
        expect(parsed[0].filter.author).to.equal('eve');
      } finally {
        cleanupMockPrompt();
      }
    });

    it('does not save preset if prompt is cancelled', async () => {
      const el = await renderSearchBar();
      await openFiltersPanel(el);

      setupMockPrompt(null);

      try {
        const saveBtn = getFilterActionButton(el, 'Save Preset')!;
        saveBtn.click();
        await new Promise((r) => setTimeout(r, 100));
        await el.updateComplete;

        const presetItems = el.shadowRoot!.querySelectorAll('.preset-item');
        expect(presetItems.length).to.equal(0);
      } finally {
        cleanupMockPrompt();
      }
    });
  });

  // ── 6. Preset load ────────────────────────────────────────────────────
  describe('preset load', () => {
    it('clicking a preset restores filter state and dispatches search-change', async () => {
      const el = await renderSearchBar();
      await openFiltersPanel(el);

      // Save a preset first
      const authorInput = getFilterInput(el, 'Author')!;
      authorInput.value = 'frank';
      authorInput.dispatchEvent(new InputEvent('input', { bubbles: true }));

      const branchInput = getFilterInput(el, 'Branch')!;
      branchInput.value = 'develop';
      branchInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      setupMockPrompt('Dev Filter');

      try {
        const saveBtn = getFilterActionButton(el, 'Save Preset')!;
        saveBtn.click();
        await new Promise((r) => setTimeout(r, 100));
        await el.updateComplete;

        // Clear filters to reset state
        const clearFiltersBtn = getFilterActionButton(el, 'Clear Filters')!;
        clearFiltersBtn.click();
        await el.updateComplete;

        // Now load the preset
        let receivedFilter: SearchFilter | null = null;
        el.addEventListener('search-change', ((e: CustomEvent) => {
          receivedFilter = e.detail;
        }) as EventListener);

        const presetItem = el.shadowRoot!.querySelector('.preset-item') as HTMLElement;
        expect(presetItem).to.not.be.null;
        presetItem.click();
        await el.updateComplete;

        expect(receivedFilter).to.not.be.null;
        expect(receivedFilter!.author).to.equal('frank');
        expect(receivedFilter!.branch).to.equal('develop');
      } finally {
        cleanupMockPrompt();
      }
    });
  });

  // ── 7. Preset delete ──────────────────────────────────────────────────
  describe('preset delete', () => {
    it('clicking delete button removes preset from list and localStorage', async () => {
      const el = await renderSearchBar();
      await openFiltersPanel(el);

      setupMockPrompt('Temp Preset');

      try {
        const saveBtn = getFilterActionButton(el, 'Save Preset')!;
        saveBtn.click();
        await new Promise((r) => setTimeout(r, 100));
        await el.updateComplete;

        // Verify preset exists
        let presetItems = el.shadowRoot!.querySelectorAll('.preset-item');
        expect(presetItems.length).to.equal(1);

        // Click the delete button on the preset
        const deleteBtn = presetItems[0].querySelector('.preset-delete') as HTMLButtonElement;
        expect(deleteBtn).to.not.be.null;
        deleteBtn.click();
        await el.updateComplete;

        // Preset should be removed
        presetItems = el.shadowRoot!.querySelectorAll('.preset-item');
        expect(presetItems.length).to.equal(0);

        // localStorage should be updated
        const stored = localStorage.getItem(PRESETS_STORAGE_KEY);
        const parsed = JSON.parse(stored!);
        expect(parsed.length).to.equal(0);
      } finally {
        cleanupMockPrompt();
      }
    });

    it('delete button click does not trigger preset load (stopPropagation)', async () => {
      const el = await renderSearchBar();
      await openFiltersPanel(el);

      // Save a preset with author filter set
      const authorInput = getFilterInput(el, 'Author')!;
      authorInput.value = 'grace';
      authorInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      setupMockPrompt('Grace Filter');

      try {
        const saveBtn = getFilterActionButton(el, 'Save Preset')!;
        saveBtn.click();
        await new Promise((r) => setTimeout(r, 100));
        await el.updateComplete;

        // Clear the author filter
        const clearFiltersBtn = getFilterActionButton(el, 'Clear Filters')!;
        clearFiltersBtn.click();
        await el.updateComplete;

        // Track if search-change fires with the preset's author
        let loadedAuthor = '';
        el.addEventListener('search-change', ((e: CustomEvent) => {
          loadedAuthor = e.detail.author;
        }) as EventListener);

        // Click delete (should NOT load the preset)
        const presetItems = el.shadowRoot!.querySelectorAll('.preset-item');
        const deleteBtn = presetItems[0].querySelector('.preset-delete') as HTMLButtonElement;
        deleteBtn.click();
        await el.updateComplete;

        // Author should remain empty (preset was NOT loaded)
        expect(loadedAuthor).to.equal('');
      } finally {
        cleanupMockPrompt();
      }
    });
  });

  // ── 8. Result count ───────────────────────────────────────────────────
  describe('result count', () => {
    it('shows result count when showResultCount is true and query is non-empty', async () => {
      const el = await fixture<LvSearchBar>(
        html`<lv-search-bar .showResultCount=${true} .resultCount=${42}></lv-search-bar>`
      );
      await el.updateComplete;

      // Type a query to enable count display
      const input = getInput(el);
      input.value = 'test';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await el.updateComplete;

      const resultCount = el.shadowRoot!.querySelector('.result-count');
      expect(resultCount).to.not.be.null;
      expect(resultCount!.textContent?.trim()).to.equal('42 results');
    });

    it('does not show result count when query is empty', async () => {
      const el = await fixture<LvSearchBar>(
        html`<lv-search-bar .showResultCount=${true} .resultCount=${10}></lv-search-bar>`
      );
      await el.updateComplete;

      const resultCount = el.shadowRoot!.querySelector('.result-count');
      expect(resultCount).to.be.null;
    });
  });

  // ── 9. Presets loaded from localStorage on connect ────────────────────
  describe('presets persistence', () => {
    it('loads saved presets from localStorage on connectedCallback', async () => {
      // Pre-populate localStorage with a preset
      const presets = [
        {
          id: 'preset-123',
          name: 'Saved Filter',
          filter: {
            query: 'refactor',
            author: 'heidi',
            dateFrom: '',
            dateTo: '',
            filePath: '',
            branch: 'main',
          },
        },
      ];
      localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));

      const el = await renderSearchBar();
      await openFiltersPanel(el);

      const presetItems = el.shadowRoot!.querySelectorAll('.preset-item');
      expect(presetItems.length).to.equal(1);
      const presetName = presetItems[0].querySelector('.preset-name');
      expect(presetName!.textContent?.trim()).to.equal('Saved Filter');
    });
  });
});
