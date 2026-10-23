import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  injectCommandError,
  openViaCommandPalette,
} from '../fixtures/test-helpers';

/**
 * E2E tests for the Describe Commit dialog.
 *
 * Covers both entry points (commit context menu, command palette) and all
 * three answers describe can give: a name, no reachable tag (an empty state,
 * not a failure), and a real error.
 */

/**
 * Right-click a commit row in the canvas-drawn graph.
 * Mirrors the helper in context-menus.spec.ts.
 */
async function rightClickOnCommitRow(page: import('@playwright/test').Page, rowIndex = 0): Promise<void> {
  const graphCanvas = page.locator('gn-graph-canvas');
  await expect(graphCanvas).toBeVisible();

  const innerCanvas = graphCanvas.locator('canvas[role="img"]');
  await expect(innerCanvas).toBeAttached();

  const graphHandle = await graphCanvas.elementHandle();
  await page.waitForFunction(
    (el) => ((el as HTMLElement & { sortedNodesByRow?: unknown[] })?.sortedNodesByRow?.length ?? 0) > 0,
    graphHandle
  );

  const box = await graphCanvas.boundingBox();
  if (!box) throw new Error('Canvas not found');

  const rowHeight = 32;
  const headerHeight = 32;
  await page.mouse.click(
    box.x + 400,
    box.y + headerHeight + rowIndex * rowHeight + rowHeight / 2,
    { button: 'right' }
  );
}

/** Open the describe dialog from the commit context menu. */
async function describeFromContextMenu(page: import('@playwright/test').Page): Promise<void> {
  await rightClickOnCommitRow(page, 0);
  const item = page.locator('.context-menu-item').filter({ hasText: 'Describe this commit' });
  await expect(item).toBeVisible({ timeout: 3000 });
  await item.click();
  await expect(page.locator('gn-describe-dialog gn-modal[open]')).toBeAttached();
}

test.describe('Describe Commit Dialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await page.waitForLoadState('domcontentloaded');
    await startCommandCaptureWithMocks(page, {});
  });

  test('describes the commit the context menu was opened on', async ({ page }) => {
    await describeFromContextMenu(page);

    // The described name, and the parts it breaks into.
    await expect(page.locator('gn-describe-dialog .description')).toHaveText('v1.0.0-2-gabc123d');
    const body = page.locator('gn-describe-dialog .fields');
    await expect(body).toContainText('v1.0.0');
    await expect(body).toContainText('2 commits');
    await expect(body).toContainText('abc123d');

    // It described a specific commit, not HEAD.
    const calls = await findCommand(page, 'describe');
    expect(calls.length).toBeGreaterThan(0);
    expect((calls[calls.length - 1].args as { commitish?: string }).commitish).toBeTruthy();
  });

  test('describes HEAD from the command palette', async ({ page }) => {
    await openViaCommandPalette(page, 'Describe commit');

    await expect(page.locator('gn-describe-dialog gn-modal[open]')).toBeAttached();
    await expect(page.locator('gn-describe-dialog .description')).toHaveText('v1.0.0-2-gabc123d');

    const calls = await findCommand(page, 'describe');
    expect(calls.length).toBeGreaterThan(0);
    expect((calls[calls.length - 1].args as { commitish?: string }).commitish).toBeFalsy();
  });

  test('shows an empty state, not an error, when no tag reaches the commit', async ({ page }) => {
    await injectCommandError(
      page,
      'describe',
      'No tags reachable from HEAD',
      'NO_TAGS_REACHABLE'
    );

    await describeFromContextMenu(page);

    const empty = page.locator('gn-describe-dialog .empty-state');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('No tags reachable from this commit');
    await expect(empty).toContainText('lightweight');
    await expect(page.locator('gn-describe-dialog .error-message')).toHaveCount(0);
  });

  test('empty state leads into creating a tag on that commit', async ({ page }) => {
    await injectCommandError(page, 'describe', 'No tags reachable', 'NO_TAGS_REACHABLE');

    await describeFromContextMenu(page);
    await page.locator('gn-describe-dialog .empty-state .btn').click();

    // Describe steps aside and the create-tag dialog takes over, aimed at the
    // same commit — the empty state is not a dead end.
    await expect(page.locator('gn-describe-dialog gn-modal[open]')).toHaveCount(0);
    await expect(page.locator('gn-create-tag-dialog gn-modal[open]')).toBeAttached();
  });

  test('shows a real failure inline with a retry', async ({ page }) => {
    await injectCommandError(page, 'describe', 'git describe failed: bad revision');

    await describeFromContextMenu(page);

    const error = page.locator('gn-describe-dialog .error-message');
    await expect(error).toBeVisible();
    await expect(error).toContainText('bad revision');
    await expect(page.locator('gn-describe-dialog .empty-state')).toHaveCount(0);
    await expect(
      page.locator('gn-describe-dialog .btn').filter({ hasText: 'Try again' })
    ).toBeVisible();
  });

  test('including lightweight tags re-runs describe with --tags', async ({ page }) => {
    await describeFromContextMenu(page);

    await page.locator('gn-describe-dialog input[type="checkbox"]').check();

    await expect
      .poll(async () => {
        const calls = await findCommand(page, 'describe');
        return (calls[calls.length - 1]?.args as { tags?: boolean } | undefined)?.tags;
      })
      .toBe(true);
    await expect(page.locator('gn-describe-dialog .description')).toBeVisible();
  });

  test('closes on the Close button', async ({ page }) => {
    await describeFromContextMenu(page);

    await page.locator('gn-describe-dialog .btn').filter({ hasText: 'Close' }).click();

    await expect(page.locator('gn-describe-dialog gn-modal[open]')).toHaveCount(0);
  });
});
