/**
 * Application menu contract test.
 *
 * The native menu bar is built in Rust (`src-tauri/src/menu.rs`) and every item
 * it emits is routed to an action by a table in TypeScript
 * (`src/services/app-menu.service.ts`). Neither side can see the other, so a
 * menu item added, renamed or dropped on one side only compiles, type-checks
 * and ships — and shows up as a menu entry that does nothing, or an action no
 * menu can reach.
 *
 * This test compares the two tables directly:
 *   - the same ids, in the same order
 *   - the same repository-scoped flags, so an item that needs a repository is
 *     greyed out by both halves
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const RUST_MENU = 'src-tauri/src/menu.rs';
const TS_MENU = 'src/services/app-menu.service.ts';

/** Items declared by the Rust menu table, in display order. */
function parseRustMenu(source) {
  const table = source.slice(
    source.indexOf('pub const APP_MENU'),
    source.indexOf('/// Every clickable item')
  );
  assert.ok(table.length > 0, `${RUST_MENU}: APP_MENU table not found`);

  const items = [];
  const pattern = /\b(repo_item|item)\("([^"]+)",\s*"/g;
  let match;
  while ((match = pattern.exec(table)) !== null) {
    items.push({ id: match[2], repositoryScoped: match[1] === 'repo_item' });
  }
  return items;
}

/** Items declared by the frontend action table, in display order. */
function parseTsMenu(source) {
  const start = source.indexOf('export const APP_MENU_ACTIONS');
  assert.notEqual(start, -1, `${TS_MENU}: APP_MENU_ACTIONS table not found`);
  const table = source.slice(start, source.indexOf('\n];', start));

  const items = [];
  for (const entry of table.match(/\{[^{}]*\}/g) ?? []) {
    const id = entry.match(/id:\s*'([^']+)'/);
    const scoped = entry.match(/repositoryScoped:\s*(true|false)/);
    assert.ok(id, `${TS_MENU}: menu entry without an id: ${entry}`);
    assert.ok(scoped, `${TS_MENU}: menu entry "${id[1]}" without repositoryScoped`);
    items.push({ id: id[1], repositoryScoped: scoped[1] === 'true' });
  }
  return items;
}

const rustItems = parseRustMenu(readFileSync(RUST_MENU, 'utf8'));
const tsItems = parseTsMenu(readFileSync(TS_MENU, 'utf8'));

test('both tables declare at least the documented menu items', () => {
  assert.ok(rustItems.length >= 20, `only ${rustItems.length} items parsed from ${RUST_MENU}`);
  assert.ok(tsItems.length >= 20, `only ${tsItems.length} items parsed from ${TS_MENU}`);
});

test('neither table repeats an id', () => {
  for (const [file, items] of [
    [RUST_MENU, rustItems],
    [TS_MENU, tsItems],
  ]) {
    const ids = items.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, `${file} has duplicate menu ids`);
  }
});

test('every native menu item has a frontend action, and vice versa', () => {
  const rustIds = rustItems.map((i) => i.id);
  const tsIds = tsItems.map((i) => i.id);

  const missingInTs = rustIds.filter((id) => !tsIds.includes(id));
  const missingInRust = tsIds.filter((id) => !rustIds.includes(id));

  assert.deepEqual(
    missingInTs,
    [],
    `menu items with no frontend action in ${TS_MENU}: ${missingInTs.join(', ')}`
  );
  assert.deepEqual(
    missingInRust,
    [],
    `frontend actions no menu item emits in ${RUST_MENU}: ${missingInRust.join(', ')}`
  );
});

test('the two tables stay in the same order', () => {
  assert.deepEqual(
    tsItems.map((i) => i.id),
    rustItems.map((i) => i.id),
    'reorder the two menu tables together so they stay readable side by side'
  );
});

test('repository-scoped flags agree on both sides', () => {
  const rustScoped = new Map(rustItems.map((i) => [i.id, i.repositoryScoped]));

  for (const item of tsItems) {
    assert.equal(
      item.repositoryScoped,
      rustScoped.get(item.id),
      `"${item.id}" is repository-scoped in one table but not the other; ` +
        'the native item would be clickable with no repository open, or greyed out with one'
    );
  }
});
