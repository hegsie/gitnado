import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  autoConfirmDialogs,
  findCommand,
  injectCommandError,
  openViaCommandPalette,
  startCommandCaptureWithMocks,
  waitForCommand,
} from '../fixtures/test-helpers';

/** Commit Composer (#618): regroup recent commits into a clean series, with undo. */

const SOURCE = {
  mode: 'range', branch: 'main', headOid: 'h'.repeat(40), baseOid: 'b'.repeat(40),
  commits: [
    { oid: '1'.repeat(40), summary: 'wip: half the parser', files: ['src/parser.ts', 'README.md'] },
    { oid: '2'.repeat(40), summary: 'fix typo + tests', files: ['src/parser.ts', 'src/parser.test.ts'] },
  ],
  files: [
    { path: 'README.md', status: 'modified' },
    { path: 'src/parser.test.ts', status: 'added' },
    { path: 'src/parser.ts', status: 'added' },
  ],
};
const RECORD = { branch: 'main', before: 'h'.repeat(40), after: 'n'.repeat(40), mode: 'range', createdAt: 1 };

const composer = (page: Page) => page.locator('gn-commit-composer-dialog');

async function openComposer(page: Page, overrides: Record<string, unknown> = {}): Promise<void> {
  await setupOpenRepository(page);
  await startCommandCaptureWithMocks(page, {
    get_recompose_source: SOURCE,
    is_ai_available: false,
    apply_recompose: RECORD,
    ...overrides,
  });
  await autoConfirmDialogs(page);
  await openViaCommandPalette(page, 'Recompose commits');
  await expect(composer(page).locator('ol.before li')).toHaveCount(2);
}

test.describe('Commit Composer', () => {
  test('shows the commits today and a starting plan, and applies an edited plan', async ({ page }) => {
    await openComposer(page);
    const messages = composer(page).locator('.group:not(.unassigned) .message');
    await expect(messages).toHaveCount(2);
    await expect(composer(page).locator('.problem')).toHaveText('Ready to apply');

    // Fold everything into one commit with a real message.
    await composer(page).locator('.group[data-group="0"] li[data-file="README.md"] select.move').selectOption({ label: 'Commit 2' });
    await composer(page).locator('.group[data-group="0"] [data-action="remove-group"]').click();
    await messages.first().fill('feat(parser): add the parser with tests and docs');
    await composer(page).locator('[data-action="apply"]').click();

    await waitForCommand(page, 'apply_recompose');
    const apply = (await findCommand(page, 'apply_recompose'))[0].args as { base: string; groups: Array<{ message: string; files: string[] }> };
    expect(apply.base).toBe(SOURCE.baseOid);
    expect(apply.groups).toEqual([
      { message: 'feat(parser): add the parser with tests and docs', files: ['README.md', 'src/parser.test.ts', 'src/parser.ts'] },
    ]);
    await expect(page.locator('.toast', { hasText: 'Recomposed main into 1 commit' })).toBeVisible();
    await expect(composer(page).locator('.notice')).toContainText('Recomposed main into 1 commit');
  });

  test('an unassigned file blocks Apply and says why', async ({ page }) => {
    await openComposer(page);
    await composer(page).locator('li[data-file="src/parser.test.ts"] select.move').first().selectOption({ label: 'Unassigned' });
    await expect(composer(page).locator('.problem')).toHaveText(/Put every changed file in a commit|has no files/);
    await expect(composer(page).locator('[data-action="apply"]')).toBeDisabled();
  });

  test('without an AI provider, the suggestion button explains itself', async ({ page }) => {
    await openComposer(page);
    const suggest = composer(page).locator('[data-action="suggest"]');
    await expect(suggest).toBeDisabled();
    await expect(suggest).toHaveAttribute('title', /Set up an AI provider/);
  });

  test('a failed apply is reported', async ({ page }) => {
    await openComposer(page);
    await injectCommandError(page, 'apply_recompose', 'main moved while recomposing');
    await composer(page).locator('[data-action="apply"]').click();
    await expect(composer(page).locator('.error')).toHaveText('Recompose failed: main moved while recomposing');
  });

  test('Revert last recompose from the palette restores the branch', async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, { get_last_recompose: RECORD, undo_recompose: RECORD });
    await autoConfirmDialogs(page);
    await openViaCommandPalette(page, 'Revert last recompose');
    await waitForCommand(page, 'undo_recompose');
    await expect(page.locator('.toast', { hasText: 'Restored main to before the recompose' })).toBeVisible();
  });

  test('Undo with nothing to undo says so', async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, { get_last_recompose: null });
    await openViaCommandPalette(page, 'Revert last recompose');
    await expect(page.locator('.toast', { hasText: 'There is no recompose to undo' })).toBeVisible();
    expect(await findCommand(page, 'undo_recompose')).toHaveLength(0);
  });
});
