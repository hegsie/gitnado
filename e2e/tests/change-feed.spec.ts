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

/**
 * Live change feed (#606): review what an agent changed in its worktree hunk
 * by hunk — accept, revert, or send feedback.
 */

const REPO = '/tmp/test-repo';
const WT = '/tmp/test-repo-worktrees/agent-fix';
const WORKTREES = [
  { path: REPO, headOid: 'a', branch: 'main', isMain: true, isLocked: false, lockReason: null, isBare: false, isPrunable: false, isCurrent: true },
  { path: WT, headOid: 'b', branch: 'agent/fix', isMain: false, isLocked: false, lockReason: null, isBare: false, isPrunable: false, isCurrent: false },
];
const HUNK = {
  index: 0, oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, header: '@@ -10,2 +10,2 @@', isStaged: false,
  lines: [
    { lineType: 'deletion', content: 'const retries = 1;\n' },
    { lineType: 'addition', content: 'const retries = 5;\n' },
    { lineType: 'context', content: 'connect(retries);\n' },
  ],
};
const STATUS = [
  { path: 'src/net.ts', status: 'modified', isStaged: false, isConflicted: false },
  { path: 'TODO.md', status: 'untracked', isStaged: false, isConflicted: false },
];

async function openFeed(page: Page, overrides: Record<string, unknown> = {}): Promise<void> {
  await setupOpenRepository(page);
  await startCommandCaptureWithMocks(page, {
    get_worktrees: WORKTREES,
    get_status: STATUS,
    get_file_hunks: { filePath: 'src/net.ts', hunks: [HUNK], totalAdditions: 1, totalDeletions: 1 },
    stage_hunk_by_index: null,
    discard_hunk_by_index: null,
    stage_files: null,
    ...overrides,
  });
  await autoConfirmDialogs(page);
  await openViaCommandPalette(page, 'Review agent changes');
  await expect(feed(page).locator('.file[data-file="src/net.ts"]')).toBeVisible();
}

const feed = (page: Page) => page.locator('gn-change-feed-dialog');
const hunkAction = (page: Page, file: string, hunk: string, action: string) =>
  feed(page).locator(`.file[data-file="${file}"] .hunk[data-hunk="${hunk}"] [data-action="${action}"]`);

test.describe('Agent change feed', () => {
  test('lists the agent worktree changes hunk by hunk', async ({ page }) => {
    await openFeed(page);
    await expect(feed(page).locator('.worktree-select')).toHaveValue(WT);
    await expect(feed(page).locator('.hunk[data-hunk="0"] .range')).toHaveText('lines 10-11');
    await expect(feed(page).locator('.file[data-file="src/net.ts"] pre')).toContainText('+const retries = 5;');
    await expect(feed(page).locator('.file[data-file="TODO.md"] .file-tag')).toHaveText('new file');
    const status = await findCommand(page, 'get_status');
    expect(status.some((c) => (c.args as { path: string }).path === WT)).toBe(true);
  });

  test('Accept stages exactly that hunk in the worktree', async ({ page }) => {
    await openFeed(page);
    await hunkAction(page, 'src/net.ts', '0', 'accept').click();
    await waitForCommand(page, 'stage_hunk_by_index');
    expect((await findCommand(page, 'stage_hunk_by_index'))[0].args).toEqual({ path: WT, filePath: 'src/net.ts', hunkIndex: 0 });
    await expect(feed(page).locator('.notice')).toHaveText('Accepted src/net.ts (lines 10-11)');
  });

  test('Revert reverts that hunk after confirming', async ({ page }) => {
    await openFeed(page);
    await hunkAction(page, 'src/net.ts', '0', 'revert').click();
    await waitForCommand(page, 'discard_hunk_by_index');
    expect((await findCommand(page, 'discard_hunk_by_index'))[0].args).toEqual({ path: WT, filePath: 'src/net.ts', hunkIndex: 0 });
    await expect(feed(page).locator('.notice')).toHaveText('Reverted src/net.ts (lines 10-11)');
  });

  test('a new file is accepted as a whole', async ({ page }) => {
    await openFeed(page);
    await hunkAction(page, 'TODO.md', 'file', 'accept').click();
    await waitForCommand(page, 'stage_files');
    expect((await findCommand(page, 'stage_files'))[0].args).toEqual({ path: WT, paths: ['TODO.md'] });
  });

  test('a failed accept is reported', async ({ page }) => {
    await openFeed(page);
    await injectCommandError(page, 'stage_hunk_by_index', 'patch does not apply');
    await hunkAction(page, 'src/net.ts', '0', 'accept').click();
    await expect(feed(page).locator('.error')).toHaveText('Could not accept the change: patch does not apply');
    await expect(page.locator('.toast.error', { hasText: 'patch does not apply' })).toBeVisible();
  });

  test('feedback without an agent terminal is copied to the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFeed(page);
    await expect(feed(page).locator('.agent')).toHaveText('No agent terminal here');
    await hunkAction(page, 'src/net.ts', '0', 'feedback').click();
    await feed(page).locator('.feedback textarea').fill('Keep retries at 3');
    await feed(page).locator('[data-action="send-feedback"]').click();
    await expect(feed(page).locator('.notice')).toContainText('copied to the clipboard');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Feedback on src/net.ts (lines 10-11): Keep retries at 3');
  });
});
