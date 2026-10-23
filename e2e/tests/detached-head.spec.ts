import { test, expect } from '@playwright/test';
import { setupOpenRepository, defaultMockData } from '../fixtures/tauri-mock';

const DETACHED_OID = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

test.describe('Detached HEAD indicator', () => {
  test('surfaces a detached HEAD across the dashboard', async ({ page }) => {
    await setupOpenRepository(page, {
      repository: {
        ...defaultMockData.repository,
        headRef: 'HEAD',
        detachedHeadOid: DETACHED_OID,
      },
      // In detached HEAD no branch carries isHead, so the store's
      // currentBranch stays null — exactly what left the UI silent.
      branches: defaultMockData.branches.map((b) => ({ ...b, isHead: false })),
    });

    const compactChip = page.locator('gn-context-dashboard .detached-head');
    await expect(compactChip).toBeVisible();
    await expect(compactChip).toHaveText(/Detached HEAD @ [0-9a-f]{7}/);

    await page.locator('gn-context-dashboard .expand-btn').click();

    const cardChip = page.locator('gn-repository-card .branch-name.detached');
    await expect(cardChip).toBeVisible();
    await expect(cardChip).toHaveText(
      new RegExp(`Detached HEAD @ ${DETACHED_OID.slice(0, 7)}`)
    );
  });

  test('shows no detached warning on a branch checkout', async ({ page }) => {
    await setupOpenRepository(page);

    await expect(page.locator('.detached-head')).toHaveCount(0);

    await page.locator('gn-context-dashboard .expand-btn').click();
    await expect(page.locator('gn-repository-card .branch-name')).toHaveText(/main/);
    await expect(page.locator('gn-repository-card .branch-name.detached')).toHaveCount(0);
  });
});
