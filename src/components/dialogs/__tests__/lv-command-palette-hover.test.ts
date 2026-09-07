/**
 * The command palette must not let a STATIONARY cursor retarget the selection.
 *
 * Chromium dispatches boundary events (mouseover/mouseenter, no mousemove) at
 * elements that appear under a parked cursor — verified directly against
 * Chromium: inserting a div under a cursor that never moves fires
 * mouseover+mouseenter on the next frame. Opening the palette over the pointer
 * therefore moved the selection off the first row, and with no query typed the
 * default list is "Recent", which can hold `Clean working directory`, so the
 * very next Enter ran a destructive command the user never pointed at.
 */

const mockInvoke = (): Promise<unknown> => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

import { expect, fixture, html } from '@open-wc/testing';
import '../lv-command-palette.ts';
import type { LvCommandPalette, PaletteCommand } from '../lv-command-palette.ts';

const executed: string[] = [];

function makeCommand(id: string, label: string): PaletteCommand {
  return {
    id,
    label,
    category: 'action',
    action: () => executed.push(id),
  };
}

const COMMANDS: PaletteCommand[] = [
  makeCommand('clean', 'Clean working directory'),
  makeCommand('prune', 'Prune Unreachable Objects'),
  makeCommand('fetch', 'Fetch from remote'),
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

function selectedIndexOf(el: LvCommandPalette): number {
  return rows(el).findIndex((r) => r.classList.contains('selected'));
}

/** The boundary event Chromium synthesises for an element that just appeared. */
function boundaryEnter(row: HTMLElement): void {
  row.dispatchEvent(new MouseEvent('mouseenter'));
}

function realMove(row: HTMLElement): void {
  row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
}

function pressEnter(el: LvCommandPalette): void {
  const input = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
}

describe('lv-command-palette hover selection', () => {
  beforeEach(() => {
    executed.length = 0;
    // Executing a command persists it under "Recent", which reorders the list
    // for the next fixture. Clear it so each test sees the same three rows.
    localStorage.removeItem('gitnado-recent-commands');
  });

  it('ignores a mouseenter that arrives with no pointer movement since open', async () => {
    const el = await openPalette();
    expect(selectedIndexOf(el), 'the first row starts selected').to.equal(0);

    boundaryEnter(rows(el)[1]);
    await el.updateComplete;

    expect(selectedIndexOf(el), 'the selection did not move under a parked cursor').to.equal(0);

    pressEnter(el);
    expect(executed, 'Enter ran the row the keyboard was on').to.deep.equal(['clean']);
  });

  it('selects on a real pointer movement over a row', async () => {
    const el = await openPalette();

    realMove(rows(el)[2]);
    await el.updateComplete;

    expect(selectedIndexOf(el), 'hover selection still works').to.equal(2);

    pressEnter(el);
    expect(executed).to.deep.equal(['fetch']);
  });

  it('honours mouseenter once the pointer has moved', async () => {
    const el = await openPalette();

    realMove(rows(el)[0]);
    await el.updateComplete;
    boundaryEnter(rows(el)[1]);
    await el.updateComplete;

    expect(selectedIndexOf(el), 'a genuine hover onto another row selects it').to.equal(1);
  });

  it('re-arms the guard on every open', async () => {
    const el = await openPalette();
    realMove(rows(el)[1]);
    await el.updateComplete;
    expect(selectedIndexOf(el)).to.equal(1);

    el.open = false;
    await el.updateComplete;
    el.open = true;
    await el.updateComplete;
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    await el.updateComplete;

    boundaryEnter(rows(el)[2]);
    await el.updateComplete;

    expect(selectedIndexOf(el), 'a reopened palette ignores the stale hover again').to.equal(0);
  });

  it('still executes the row the user actually clicks', async () => {
    const el = await openPalette();

    rows(el)[1].click();
    await el.updateComplete;

    expect(executed, 'a click is an explicit pointer action').to.deep.equal(['prune']);
  });
});
