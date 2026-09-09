import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  injectCommandError,
  openAppDialog,
} from '../fixtures/test-helpers';

/**
 * E2E tests for Blame View
 * Tests blame display, context menus, line groups, and keyboard interactions.
 *
 * The blame view is conditionally rendered by app-shell when the `blame` dialog
 * is open. We open it through the dialog store and mock the get_file_blame command
 * to return deterministic blame data.
 */

const BLAME_MOCK_DATA = {
  path: 'src/main.ts',
  lines: [
    {
      lineNumber: 1,
      content: 'import { app } from "./app";',
      commitOid: 'abc123def456',
      commitShortId: 'abc123d',
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      timestamp: Math.floor(Date.now() / 1000) - 86400,
      summary: 'Initial commit',
      isBoundary: false,
    },
    {
      lineNumber: 2,
      content: '',
      commitOid: 'abc123def456',
      commitShortId: 'abc123d',
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      timestamp: Math.floor(Date.now() / 1000) - 86400,
      summary: 'Initial commit',
      isBoundary: false,
    },
    {
      lineNumber: 3,
      content: 'const config = { debug: true };',
      commitOid: 'def456abc789',
      commitShortId: 'def456a',
      authorName: 'Bob',
      authorEmail: 'bob@example.com',
      timestamp: Math.floor(Date.now() / 1000) - 43200,
      summary: 'Add configuration',
      isBoundary: false,
    },
    {
      lineNumber: 4,
      content: 'app.run(config);',
      commitOid: 'ghi789000111',
      commitShortId: 'ghi7890',
      authorName: 'Charlie',
      authorEmail: 'charlie@example.com',
      timestamp: Math.floor(Date.now() / 1000),
      summary: 'Run app with config',
      isBoundary: false,
    },
  ],
  totalLines: 4,
};

/**
 * Open the blame view by setting app-shell state and providing mock blame data.
 * Also intercepts get_file_blame so the component receives data.
 */
async function openBlameView(page: import('@playwright/test').Page): Promise<void> {
  // Set up command capture with mock for blame data
  await startCommandCaptureWithMocks(page, {
    get_file_blame: BLAME_MOCK_DATA,
  });

  // Show the blame view. blameFile/blameCommitOid are still app-shell fields
  // (they are re-derived per refresh, not open-time context); the open flag
  // lives in the dialog store.
  await page.evaluate(() => {
    const appShell = document.querySelector('lv-app-shell') as HTMLElement & {
      blameFile: string | null;
      blameCommitOid: string | null;
    };
    if (appShell) {
      appShell.blameFile = 'src/main.ts';
      appShell.blameCommitOid = null;
    }
  });
  await openAppDialog(page, 'blame');

  // Wait for the blame view to become visible
  await page.locator('lv-blame-view').waitFor({ state: 'visible', timeout: 5000 });

  // Wait for blame data to load and render (the groups appear after loadBlame completes)
  await page.locator('lv-blame-view .blame-group').first().waitFor({ state: 'visible', timeout: 5000 });
}

test.describe('Blame View', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('renders blame lines with content after being opened', async ({ page }) => {
    await openBlameView(page);

    const blameLines = page.locator('lv-blame-view .blame-line');
    const count = await blameLines.count();
    // We have 4 lines in the mock data
    expect(count).toBe(4);

    // Verify line content is rendered
    const firstLineContent = page.locator('lv-blame-view .blame-line .line-content').first();
    await expect(firstLineContent).toBeVisible();
    await expect(firstLineContent).toContainText('import');
  });

  test('shows author info per blame group', async ({ page }) => {
    await openBlameView(page);

    // There should be 3 groups: Alice (lines 1-2), Bob (line 3), Charlie (line 4)
    const groups = page.locator('lv-blame-view .blame-group');
    const groupCount = await groups.count();
    expect(groupCount).toBe(3);

    // Check author names are visible
    const authorNames = page.locator('lv-blame-view .author-name');
    await expect(authorNames.nth(0)).toContainText('Alice');
    await expect(authorNames.nth(1)).toContainText('Bob');
    await expect(authorNames.nth(2)).toContainText('Charlie');
  });

  test('shows commit hash for each group', async ({ page }) => {
    await openBlameView(page);

    const commitHashes = page.locator('lv-blame-view .commit-hash');
    await expect(commitHashes.first()).toBeVisible();
    await expect(commitHashes.nth(0)).toContainText('abc123d');
    await expect(commitHashes.nth(1)).toContainText('def456a');
    await expect(commitHashes.nth(2)).toContainText('ghi7890');
  });

  test('shows line numbers for each blame line', async ({ page }) => {
    await openBlameView(page);

    const lineNumbers = page.locator('lv-blame-view .line-number');
    const count = await lineNumbers.count();
    expect(count).toBe(4);

    await expect(lineNumbers.nth(0)).toContainText('1');
    await expect(lineNumbers.nth(1)).toContainText('2');
    await expect(lineNumbers.nth(2)).toContainText('3');
    await expect(lineNumbers.nth(3)).toContainText('4');
  });

  test('opens context menu on right-click of a blame line', async ({ page }) => {
    await openBlameView(page);

    const firstLine = page.locator('lv-blame-view .blame-line').first();
    await firstLine.click({ button: 'right' });

    const contextMenu = page.locator('lv-blame-view .context-menu');
    await contextMenu.waitFor({ state: 'visible' });
    await expect(contextMenu).toBeVisible();
  });

  test('context menu contains "Show commit details" option', async ({ page }) => {
    await openBlameView(page);

    const firstLine = page.locator('lv-blame-view .blame-line').first();
    await firstLine.click({ button: 'right' });

    const contextMenu = page.locator('lv-blame-view .context-menu');
    await contextMenu.waitFor({ state: 'visible' });

    const showCommitOption = page.locator('lv-blame-view .context-menu-item', {
      hasText: 'Show commit details',
    });
    await expect(showCommitOption).toBeVisible();
  });

  test('Escape key closes the blame view', async ({ page }) => {
    await openBlameView(page);

    const blameView = page.locator('lv-blame-view');
    await expect(blameView).toBeVisible();

    // Press Escape - app-shell handles Escape to close blame
    await page.keyboard.press('Escape');

    // The blame view should no longer be visible (app-shell removes it from the DOM)
    await expect(blameView).not.toBeVisible();
  });
});

// --------------------------------------------------------------------------
// Error Scenarios
// --------------------------------------------------------------------------
test.describe('Blame View - Error Scenarios', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('get_file_blame failure should show error state or toast', async ({ page }) => {
    // Set up command capture with a valid initial response so the view opens
    await startCommandCaptureWithMocks(page, {
      get_file_blame: BLAME_MOCK_DATA,
    });

    // Now inject the error so the next call to get_file_blame will fail
    await injectCommandError(page, 'get_file_blame', 'Failed to get blame');

    // Show the blame view (triggers get_file_blame)
    await page.evaluate(() => {
      const appShell = document.querySelector('lv-app-shell') as HTMLElement & {
        blameFile: string | null;
        blameCommitOid: string | null;
      };
      if (appShell) {
        appShell.blameFile = 'src/main.ts';
        appShell.blameCommitOid = null;
      }
    });
    await openAppDialog(page, 'blame');

    // Wait for the blame view to appear in the DOM
    await page.locator('lv-blame-view').waitFor({ state: 'attached', timeout: 5000 });

    // The error should be displayed — either an error element in the blame view or a toast
    await expect(
      page.locator('.error, .error-banner, .toast, lv-blame-view .error-message').first()
    ).toBeVisible({ timeout: 5000 });
  });

  test('empty blame data should show empty state', async ({ page }) => {
    // Mock get_file_blame to return empty lines
    await startCommandCaptureWithMocks(page, {
      get_file_blame: { path: 'src/main.ts', lines: [], totalLines: 0 },
    });

    // Show the blame view
    await page.evaluate(() => {
      const appShell = document.querySelector('lv-app-shell') as HTMLElement & {
        blameFile: string | null;
        blameCommitOid: string | null;
      };
      if (appShell) {
        appShell.blameFile = 'src/main.ts';
        appShell.blameCommitOid = null;
      }
    });
    await openAppDialog(page, 'blame');

    // Wait for the blame view to appear
    await page.locator('lv-blame-view').waitFor({ state: 'attached', timeout: 5000 });

    // Should show no blame groups since there are no lines
    await expect(page.locator('lv-blame-view .blame-group')).toHaveCount(0);

    // Should show an empty state message or at least no blame lines
    const emptyState = page.locator('lv-blame-view .empty, lv-blame-view .empty-state, lv-blame-view .no-data');
    const blameLines = page.locator('lv-blame-view .blame-line');

    // Either an explicit empty state element is visible, or there are simply no blame lines
    const hasEmptyState = await emptyState.count() > 0;
    if (hasEmptyState) {
      await expect(emptyState.first()).toBeVisible();
    } else {
      await expect(blameLines).toHaveCount(0);
    }
  });
});
