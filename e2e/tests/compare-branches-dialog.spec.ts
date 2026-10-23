import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import { LeftPanelPage } from '../pages/panels.page';
import {
  startCommandCapture,
  findCommand,
  injectCommandError,
  openViaCommandPalette,
  waitForCommand,
} from '../fixtures/test-helpers';

/**
 * E2E tests for the Compare Branches dialog.
 *
 * `compare_branches` had no reachable entry point at all, so these cover the
 * two routes to it (branch context menu, command palette) and what the user
 * sees when the comparison succeeds, comes back empty, or fails.
 */

const DIALOG = 'gn-compare-branches-dialog';
const MODAL = `${DIALOG} gn-modal[open]`;

async function openFromContextMenu(page: Page, branch: string): Promise<void> {
  const leftPanel = new LeftPanelPage(page);
  await leftPanel.openBranchContextMenu(branch);
  const item = page.locator('.context-menu-item', { hasText: 'Compare with current branch' });
  await item.waitFor({ state: 'visible' });
  await item.click();
  await page.locator(MODAL).waitFor({ state: 'visible' });
}

test.describe('Compare Branches Dialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCapture(page);
  });

  test('opens from the branch context menu aimed at the right-clicked branch', async ({ page }) => {
    await openFromContextMenu(page, 'feature/test');

    await waitForCommand(page, 'get_branches');
    await expect(page.locator(`${DIALOG} #compare-ref-select`)).toHaveValue('feature/test');
    // Base defaults to the branch the user is on.
    await expect(page.locator(`${DIALOG} #base-ref-select`)).toHaveValue('main');
  });

  test('the current branch offers no comparison against itself', async ({ page }) => {
    const leftPanel = new LeftPanelPage(page);
    await leftPanel.openBranchContextMenu('main');
    await page.locator('.context-menu').waitFor({ state: 'visible' });

    await expect(
      page.locator('.context-menu-item', { hasText: 'Compare with current branch' })
    ).toHaveCount(0);
  });

  test('opens from the command palette', async ({ page }) => {
    await page.waitForLoadState('domcontentloaded');
    await openViaCommandPalette(page, 'Compare branches');

    await expect(page.locator(MODAL)).toBeVisible();
    await expect(page.locator(`${DIALOG} #base-ref-select`)).toBeVisible();
  });

  test('shows ahead/behind, commits and changed files for a comparison', async ({ page }) => {
    await openFromContextMenu(page, 'feature/test');

    await page.locator(`${DIALOG} .btn-primary`).click();
    await waitForCommand(page, 'compare_branches');

    const calls = await findCommand(page, 'compare_branches');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].args).toMatchObject({
      base: 'main',
      compare: 'feature/test',
      includeCommits: true,
      includeFiles: true,
    });

    await expect(page.locator(`${DIALOG} [data-testid="commits-ahead"]`)).toBeVisible();
    await expect(page.locator(`${DIALOG} [data-testid="files-changed"]`)).toBeVisible();
    await expect(page.locator(`${DIALOG} [data-testid="files-changed"] .row`)).toHaveCount(1);
    await expect(page.locator(`${DIALOG} .summary`)).toContainText('Merge base');
    await expect(page.locator(`${DIALOG}`)).toContainText('src/feature.ts');
  });

  test('swapping the refs re-aims the comparison and clears the old result', async ({ page }) => {
    await openFromContextMenu(page, 'feature/test');
    await page.locator(`${DIALOG} .btn-primary`).click();
    await expect(page.locator(`${DIALOG} [data-testid="commits-ahead"]`)).toBeVisible();

    await page.locator(`${DIALOG} .swap-btn`).click();
    await expect(page.locator(`${DIALOG} [data-testid="commits-ahead"]`)).toHaveCount(0);
    await expect(page.locator(`${DIALOG} #base-ref-select`)).toHaveValue('feature/test');
    await expect(page.locator(`${DIALOG} #compare-ref-select`)).toHaveValue('main');

    await page.locator(`${DIALOG} .btn-primary`).click();
    await expect(page.locator(`${DIALOG} [data-testid="commits-ahead"]`)).toBeVisible();

    const calls = await findCommand(page, 'compare_branches');
    expect(calls[calls.length - 1].args).toMatchObject({
      base: 'feature/test',
      compare: 'main',
    });
  });

  test('says so when the two refs are identical instead of showing an empty panel', async ({ page }) => {
    await openFromContextMenu(page, 'feature/test');
    await page.evaluate(() => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const original = internals.invoke;
      internals.invoke = (cmd: string, args?: unknown) => {
        if (cmd === 'compare_branches') {
          return Promise.resolve({
            baseRef: 'main',
            compareRef: 'feature/test',
            ahead: 0,
            behind: 0,
            mergeBase: 'abc123def456',
            commitsAhead: [],
            commitsBehind: [],
            filesChanged: [],
            totalAdditions: 0,
            totalDeletions: 0,
          });
        }
        return original(cmd, args);
      };
    });

    await page.locator(`${DIALOG} .btn-primary`).click();
    await expect(page.locator(`${DIALOG} [data-testid="identical"]`)).toBeVisible();
    await expect(page.locator(`${DIALOG} [data-testid="commits-ahead"]`)).toHaveCount(0);
  });

  test('surfaces a failed comparison in the dialog rather than failing silently', async ({ page }) => {
    await openFromContextMenu(page, 'feature/test');
    await injectCommandError(page, 'compare_branches', 'No common ancestor found');

    await page.locator(`${DIALOG} .btn-primary`).click();

    const error = page.locator(`${DIALOG} .error-message`);
    await expect(error).toBeVisible();
    await expect(error).toContainText('No common ancestor found');
    await expect(page.locator(`${DIALOG} [data-testid="commits-ahead"]`)).toHaveCount(0);
    // The dialog stays open so the user can pick another pair and retry.
    await expect(page.locator(MODAL)).toBeVisible();
  });

  test('explains a single-branch repository instead of a Compare that never enables', async ({
    page,
  }) => {
    // Only the branch the user is on, so there is no second ref to pick and
    // both pickers land on it.
    await page.evaluate(() => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const original = internals.invoke;
      internals.invoke = (cmd: string, args?: unknown) => {
        if (cmd === 'get_branches') {
          return Promise.resolve([
            {
              name: 'main',
              shorthand: 'main',
              isHead: true,
              isRemote: false,
              upstream: null,
              targetOid: 'oid-main',
              isStale: false,
            },
          ]);
        }
        return original(cmd, args);
      };
    });

    await openViaCommandPalette(page, 'Compare branches');
    await expect(page.locator(MODAL)).toBeVisible();

    const explanation = page.locator(`${DIALOG} [data-testid="single-branch"]`);
    await expect(explanation).toBeVisible();
    await expect(explanation).toContainText('is the only branch here');

    // The dead end is explained, and every control that cannot help is inert.
    await expect(page.locator(`${DIALOG} .btn-primary`)).toBeDisabled();
    await expect(page.locator(`${DIALOG} #base-ref-select`)).toBeDisabled();
    await expect(page.locator(`${DIALOG} #compare-ref-select`)).toBeDisabled();
    await expect(page.locator(`${DIALOG} .swap-btn`)).toBeDisabled();
  });

  test('closes with Escape', async ({ page }) => {
    await openFromContextMenu(page, 'feature/test');
    await page.keyboard.press('Escape');
    await expect(page.locator(MODAL)).not.toBeVisible();
  });
});
