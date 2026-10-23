/**
 * Tests for gn-search-bar preset restore behavior.
 *
 * loadPreset must restore searchMode (stored by savePreset) before emitting
 * the search, otherwise a semantic-mode preset silently runs in keyword mode.
 * Older presets that lack the field must fall back to 'keyword'.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html, oneEvent } from '@open-wc/testing';
import type { GnSearchBar, FilterPreset, SearchFilter } from '../gn-search-bar.ts';
import '../gn-search-bar.ts';

// ── Helpers ────────────────────────────────────────────────────────────────
async function createComponent(): Promise<GnSearchBar> {
  const el = await fixture<GnSearchBar>(html`<gn-search-bar></gn-search-bar>`);
  await el.updateComplete;
  return el;
}

function makePreset(searchMode: 'keyword' | 'semantic' | undefined): FilterPreset {
  const filter: Partial<SearchFilter> = {
    query: 'refactor',
    author: '',
    dateFrom: '',
    dateTo: '',
    filePath: '',
    branch: '',
  };
  if (searchMode !== undefined) {
    filter.searchMode = searchMode;
  }
  return { id: 'preset-1', name: 'p1', filter: filter as SearchFilter };
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-search-bar preset restore', () => {
  it('restores semantic searchMode from a preset before emitting search', async () => {
    const el = await createComponent();

    const listener = oneEvent(el, 'search-change');
    (el as unknown as { loadPreset: (p: FilterPreset) => void }).loadPreset(makePreset('semantic'));
    const { detail } = await listener;

    expect((el as unknown as { searchMode: string }).searchMode).to.equal('semantic');
    expect((detail as SearchFilter).searchMode).to.equal('semantic');
  });

  it('restores keyword searchMode from a preset', async () => {
    const el = await createComponent();
    // Start in semantic to prove it flips back.
    (el as unknown as { searchMode: string }).searchMode = 'semantic';

    (el as unknown as { loadPreset: (p: FilterPreset) => void }).loadPreset(makePreset('keyword'));

    expect((el as unknown as { searchMode: string }).searchMode).to.equal('keyword');
  });

  it('falls back to keyword for legacy presets lacking searchMode', async () => {
    const el = await createComponent();
    (el as unknown as { searchMode: string }).searchMode = 'semantic';

    (el as unknown as { loadPreset: (p: FilterPreset) => void }).loadPreset(makePreset(undefined));

    expect((el as unknown as { searchMode: string }).searchMode).to.equal('keyword');
  });
});
