import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  injectCommandError,
  openViaCommandPalette,
} from '../fixtures/test-helpers';

/**
 * E2E tests for the content/diff/pickaxe search dialog.
 *
 * The backend commands existed but nothing in the app called them: there was
 * no way for a user to grep their files, search the current diff, or find the
 * commit that introduced a string. These tests drive the flow the way a user
 * does — palette entry, query, Enter — and verify the result rows actually
 * take them somewhere.
 */

const FILE_RESULT = [
  {
    filePath: 'src/main.ts',
    matchCount: 1,
    matches: [
      {
        filePath: 'src/main.ts',
        lineNumber: 42,
        lineContent: 'const token = getToken();',
        matchStart: 6,
        matchEnd: 11,
      },
    ],
  },
];

const BLAME_RESULT = {
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
  ],
  totalLines: 1,
};

async function runSearch(page: import('@playwright/test').Page, query: string): Promise<void> {
  const dialog = page.locator('gn-search-dialog[open]');
  await dialog.waitFor({ state: 'attached' });
  await dialog.locator('.query-input').fill(query);
  await dialog.locator('.query-input').press('Enter');
}

test.describe('Search dialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('finds text in files and shows the match', async ({ page }) => {
    await startCommandCaptureWithMocks(page, { search_in_files: FILE_RESULT });
    await openViaCommandPalette(page, 'Search in files');
    await runSearch(page, 'token');

    const row = page.locator('gn-search-dialog[open] .result-item').first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(':42');
    await expect(row).toContainText('const token = getToken();');
    await expect(page.locator('gn-search-dialog[open] .result-file')).toContainText('src/main.ts');

    const calls = await findCommand(page, 'search_in_files');
    expect(calls.length).toBeGreaterThan(0);
    expect((calls[0].args as { query: string }).query).toBe('token');
  });

  test('clicking a file result opens blame for that file', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      search_in_files: FILE_RESULT,
      get_file_blame: BLAME_RESULT,
    });
    await openViaCommandPalette(page, 'Search in files');
    await runSearch(page, 'token');

    await page.locator('gn-search-dialog[open] .result-item').first().click();

    await expect(page.locator('gn-search-dialog[open]')).toHaveCount(0);
    await expect(page.locator('gn-blame-view')).toBeVisible();
    // The blame header shows only the file name (compact header), with the
    // full path as a hover tooltip rather than in the visible text — this is
    // the component's long-standing, deliberate rendering (getFileName()),
    // not a regression, so verify each half of the intended display in the
    // place it actually appears.
    await expect(page.locator('gn-blame-view .file-path')).toHaveText('main.ts');
    await expect(page.locator('gn-blame-view .file-path')).toHaveAttribute('title', 'src/main.ts');
  });

  test('a backend failure is shown inside the dialog', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {});
    await injectCommandError(page, 'search_in_files', 'fatal: invalid regex');
    await openViaCommandPalette(page, 'Search in files');
    await runSearch(page, 'to(ken');

    const dialog = page.locator('gn-search-dialog[open]');
    await expect(dialog.locator('.error')).toBeVisible();
    await expect(dialog.locator('.error')).toContainText('fatal: invalid regex');
    await expect(dialog).toHaveCount(1);
  });

  test('an empty diff search reports no matches', async ({ page }) => {
    await startCommandCaptureWithMocks(page, { search_in_diff: [] });
    await openViaCommandPalette(page, 'Search in current diff');
    await runSearch(page, 'token');

    await expect(page.locator('gn-search-dialog[open] .empty')).toContainText('No matches found');
  });

  test('finding commits that changed text reveals the commit', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      search_commits_by_content: [
        {
          oid: 'abc123def456',
          shortOid: 'abc123d',
          message: 'Initial commit',
          authorName: 'Test User',
          authorDate: Math.floor(Date.now() / 1000),
          matches: [{ filePath: 'src/main.ts', lineNumber: null, lineContent: null }],
        },
      ],
    });
    await openViaCommandPalette(page, 'Find commits that changed text');
    await runSearch(page, 'token');

    const row = page.locator('gn-search-dialog[open] .result-item').first();
    await expect(row).toContainText('abc123d');
    await row.click();

    await expect(page.locator('gn-search-dialog[open]')).toHaveCount(0);
    await expect(page.locator('gn-commit-details .commit-message')).toContainText('Initial commit');
  });
});
