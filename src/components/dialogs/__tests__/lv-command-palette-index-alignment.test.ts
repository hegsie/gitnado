/**
 * The row you highlight must be the command that runs.
 *
 * renderCommands() groups rows by category before painting them, but keyboard
 * selection, click, and hover all index into `filteredCommands`. While that
 * array kept its unsorted order, any interleaving of categories made the two
 * orders diverge — and they always interleave, both in the default view (a
 * 'navigation' entry sits among the actions) and under a scored query. From the
 * first category boundary onward every row executed a DIFFERENT command than
 * the one it displayed. The palette carries entries like "Clean working
 * directory", so a user could select a benign row and destroy work.
 */

const mockInvoke = (): Promise<unknown> => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

import { expect, fixture, html } from '@open-wc/testing';
import '../lv-command-palette.ts';
import type { LvCommandPalette, PaletteCommand } from '../lv-command-palette.ts';

const executed: string[] = [];

function makeCommand(
  id: string,
  label: string,
  category: PaletteCommand['category'],
): PaletteCommand {
  return {
    id,
    label,
    category,
    action: () => executed.push(id),
  };
}

/**
 * Categories deliberately interleaved, the way getPaletteCommands() emits them:
 * a 'navigation' entry between 'action' entries.
 */
const COMMANDS: PaletteCommand[] = [
  makeCommand('stage-all', 'Stage all changes', 'action'),
  makeCommand('jump-head', 'Jump to HEAD', 'navigation'),
  makeCommand('clean', 'Clean working directory', 'action'),
  makeCommand('toggle-panel', 'Toggle left panel', 'navigation'),
  makeCommand('fetch', 'Fetch from remote', 'action'),
];

async function openPalette(): Promise<LvCommandPalette> {
  const el = await fixture<LvCommandPalette>(
    html`<lv-command-palette .commands=${COMMANDS}></lv-command-palette>`,
  );
  await el.updateComplete;
  el.open = true;
  await el.updateComplete;
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  await el.updateComplete;
  return el;
}

function rows(el: LvCommandPalette): HTMLElement[] {
  return Array.from(el.shadowRoot!.querySelectorAll('.command')) as HTMLElement[];
}

function labelOf(row: HTMLElement): string {
  return (row.querySelector('.command-label')?.textContent ?? '').trim();
}

function pressKey(el: LvCommandPalette, key: string): void {
  const input = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('lv-command-palette index alignment', () => {
  beforeEach(() => {
    executed.length = 0;
    localStorage.removeItem('gitnado-recent-commands');
  });

  it('runs the command shown on the highlighted row past a category boundary', async () => {
    const el = await openPalette();
    const painted = rows(el);
    expect(painted.length).to.equal(COMMANDS.length);

    // Walk to the row after the first category boundary and remember its label.
    pressKey(el, 'ArrowDown');
    pressKey(el, 'ArrowDown');
    pressKey(el, 'ArrowDown');
    await el.updateComplete;

    const highlighted = rows(el).find((r) => r.classList.contains('selected'));
    expect(highlighted, 'a row should be highlighted').to.exist;
    const highlightedLabel = labelOf(highlighted!);

    pressKey(el, 'Enter');
    await el.updateComplete;

    expect(executed).to.have.lengthOf(1);
    const ranLabel = COMMANDS.find((c) => c.id === executed[0])!.label;
    expect(
      ranLabel,
      `highlighted "${highlightedLabel}" but executed "${ranLabel}"`,
    ).to.equal(highlightedLabel);
  });

  it('runs the command shown on the row that was clicked', async () => {
    const el = await openPalette();
    const painted = rows(el);

    // Last row: maximally far past the category boundaries.
    const target = painted[painted.length - 1];
    const targetLabel = labelOf(target);
    target.click();
    await el.updateComplete;

    expect(executed).to.have.lengthOf(1);
    const ranLabel = COMMANDS.find((c) => c.id === executed[0])!.label;
    expect(ranLabel, `clicked "${targetLabel}" but executed "${ranLabel}"`).to.equal(targetLabel);
  });

  it('paints every command exactly once, grouped by category', async () => {
    const el = await openPalette();
    const labels = rows(el).map(labelOf);

    // No row dropped or duplicated by the regrouping.
    expect([...labels].sort()).to.deep.equal(COMMANDS.map((c) => c.label).sort());

    // Categories are contiguous: each one appears as a single run.
    const categories = labels.map((l) => COMMANDS.find((c) => c.label === l)!.category);
    const runs = categories.filter((c, i) => i === 0 || c !== categories[i - 1]);
    expect(new Set(runs).size, 'each category should form one contiguous run').to.equal(runs.length);
  });
});
