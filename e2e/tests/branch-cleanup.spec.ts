import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
  injectCommandError,
  openViaCommandPalette,
} from '../fixtures/test-helpers';

/**
 * E2E tests for squash- and rebase-merged branch detection in the Branch
 * Cleanup dialog (roadmap 4.3, issue #617).
 *
 * The backend reports `mergeKind` for merged candidates. Squash- and
 * rebase-merged branches must be listed under Merged as Safe, say how they
 * were merged, and be deleted WITHOUT force (delete_branch accepts them).
 */

const candidates = [
  {
    name: 'feature/squashed',
    shorthand: 'feature/squashed',
    category: 'merged',
    lastCommitTimestamp: null,
    isProtected: false,
    upstream: 'origin/feature/squashed',
    aheadBehind: { ahead: 3, behind: 0 },
    mergeKind: 'squash',
  },
  {
    name: 'feature/rebased',
    shorthand: 'feature/rebased',
    category: 'merged',
    lastCommitTimestamp: null,
    isProtected: false,
    upstream: null,
    aheadBehind: null,
    mergeKind: 'rebase',
  },
  {
    name: 'feature/wip',
    shorthand: 'feature/wip',
    category: 'stale',
    lastCommitTimestamp: 1600000000,
    isProtected: false,
    upstream: 'origin/feature/wip',
    aheadBehind: { ahead: 2, behind: 0 },
    mergeKind: null,
  },
];

async function openCleanup(page: import('@playwright/test').Page) {
  await openViaCommandPalette(page, 'Clean up branches');
  await expect(page.locator('gn-branch-cleanup-dialog .branch-item').first()).toBeVisible();
}

test.describe('Branch Cleanup - squash/rebase-merged detection', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, {
      get_cleanup_candidates: candidates,
      get_remotes: [],
      delete_branch: null,
      prune_remote_tracking_branches: { success: true, branchesPruned: [] },
      'plugin:dialog|message': 'Ok',
    });
  });

  test('lists squash- and rebase-merged branches as Safe with how they merged', async ({ page }) => {
    await openCleanup(page);

    const squashed = page
      .locator('gn-branch-cleanup-dialog .branch-item')
      .filter({ hasText: 'feature/squashed' });
    await expect(squashed).toContainText('Squash-merged');
    await expect(squashed.locator('.risk-badge.safe')).toBeVisible();
    await expect(squashed.locator('input[type="checkbox"]')).toBeChecked();

    const rebased = page
      .locator('gn-branch-cleanup-dialog .branch-item')
      .filter({ hasText: 'feature/rebased' });
    await expect(rebased).toContainText('Rebase-merged');
    await expect(rebased.locator('.risk-badge.safe')).toBeVisible();
  });

  test('deletes squash-merged branches without force and closes with a success toast', async ({
    page,
  }) => {
    await openCleanup(page);

    await page.locator('gn-branch-cleanup-dialog .btn-danger').click();
    await waitForCommand(page, 'delete_branch');
    await expect(page.locator('.toast.success')).toContainText('Deleted 2 branches');

    const deletes = await findCommand(page, 'delete_branch');
    const names = deletes.map((d) => (d.args as { name: string }).name).sort();
    expect(names).toEqual(['feature/rebased', 'feature/squashed']);
    for (const d of deletes) {
      expect((d.args as { force?: boolean }).force).not.toBe(true);
    }

    // Dialog closes once anything was deleted.
    await expect(page.locator('gn-branch-cleanup-dialog .branch-item').first()).toBeHidden();
  });

  test('surfaces a backend refusal instead of silently dropping it', async ({ page }) => {
    await injectCommandError(page, 'delete_branch', 'Branch is locked by another worktree');
    await openCleanup(page);

    await page.locator('gn-branch-cleanup-dialog .btn-danger').click();

    await expect(page.locator('.toast.error')).toContainText('failed');
    await expect(
      page.locator('gn-branch-cleanup-dialog .branch-item').filter({ hasText: 'feature/squashed' }),
    ).toBeVisible();
  });
});
