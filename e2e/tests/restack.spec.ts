import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
  injectCommandError,
  autoConfirmDialogs,
} from '../fixtures/test-helpers';

const branch = (name: string, isHead = false) => ({
  name,
  shorthand: name,
  isHead,
  isRemote: false,
  upstream: null,
  targetOid: `${name}-oid`,
  isStale: false,
});

const entry = (name: string, parent: string, depth: number, behind: number) => ({
  name, parent, depth, ahead: 1, behind, isHead: false, parentMissing: false,
});

const BEHIND = [{ base: 'main', branches: [entry('feat-a', 'main', 1, 2), entry('feat-b', 'feat-a', 2, 0)] }];
const FRESH = [{ base: 'main', branches: [entry('feat-a', 'main', 1, 0), entry('feat-b', 'feat-a', 2, 0)] }];

const step = (branch: string, onto: string, status: string, extra: Record<string, unknown> = {}) => ({
  branch, onto, status, commits: 1, conflictFiles: [], conflictCommit: null, ...extra,
});
const CLEAN_PLAN = {
  base: 'main',
  canApply: true,
  hasChanges: true,
  steps: [step('feat-a', 'main', 'restacked'), step('feat-b', 'feat-a', 'restacked')],
};

async function reloadBranches(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('repository-refresh')));
}

test.describe('Restack a stack', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page, {
      branches: [branch('main', true), branch('feat-a'), branch('feat-b')],
    });
    await startCommandCaptureWithMocks(page, {
      get_stacks: BEHIND,
      preview_restack: CLEAN_PLAN,
      restack: CLEAN_PLAN,
    });
    await autoConfirmDialogs(page);
    await reloadBranches(page);
  });

  test('restacks a stack whose base moved and the restack badge clears', async ({ page }) => {
    const restackBtn = page.locator('gn-branch-list .restack-btn');
    await expect(restackBtn).toBeVisible();
    await expect(page.locator('gn-branch-list .stack-badge', { hasText: 'needs restack' })).toHaveCount(1);

    // After the restack the backend reports everything on its parent's tip.
    await startCommandCaptureWithMocks(page, {
      get_stacks: FRESH,
      preview_restack: CLEAN_PLAN,
      restack: CLEAN_PLAN,
    });
    await restackBtn.click();

    await waitForCommand(page, 'restack');
    expect((await findCommand(page, 'preview_restack'))[0].args).toMatchObject({ base: 'main' });
    expect((await findCommand(page, 'restack'))[0].args).toMatchObject({ base: 'main' });
    const confirm = await findCommand(page, 'plugin:dialog|message');
    expect(JSON.stringify(confirm[0].args)).toContain('feat-b → onto feat-a');
    await expect(page.locator('.toast', { hasText: 'Restacked 2 branches on main' })).toBeVisible();
    await expect(page.locator('gn-branch-list .stack-badge')).toHaveCount(0);
    await expect(restackBtn).toHaveCount(0);
  });

  test('a predicted conflict is explained and nothing is restacked', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      get_stacks: BEHIND,
      preview_restack: {
        ...CLEAN_PLAN,
        canApply: false,
        steps: [
          step('feat-a', 'main', 'conflict', { conflictFiles: ['src/app.ts'], conflictCommit: 'rework app' }),
          step('feat-b', 'feat-a', 'blocked'),
        ],
      },
    });
    await page.locator('gn-branch-list .restack-btn').click();

    await expect(page.locator('.toast', { hasText: 'Restacking would conflict: feat-a at "rework app" in src/app.ts' })).toBeVisible();
    expect(await findCommand(page, 'restack')).toHaveLength(0);
    await expect(page.locator('gn-branch-list .stack-badge', { hasText: 'needs restack' })).toHaveCount(1);
  });

  test('a merged lower branch is called out in the confirmation', async ({ page }) => {
    const plan = {
      ...CLEAN_PLAN,
      steps: [step('feat-a', 'main', 'merged'), step('feat-b', 'main', 'restacked')],
    };
    await startCommandCaptureWithMocks(page, { get_stacks: BEHIND, preview_restack: plan, restack: plan });
    await page.locator('gn-branch-list .restack-btn').click();
    await waitForCommand(page, 'restack');
    const confirm = await findCommand(page, 'plugin:dialog|message');
    expect(JSON.stringify(confirm[0].args)).toContain('feat-a is already merged into main');
    await expect(page.locator('.toast', { hasText: 'Restacked 1 branch on main' })).toBeVisible();
  });

  test('a failed restack is reported', async ({ page }) => {
    await injectCommandError(page, 'restack', 'feat-b is checked out in another worktree');
    await page.locator('gn-branch-list .restack-btn').click();
    await expect(page.locator('.toast', { hasText: 'Restack failed: feat-b is checked out in another worktree' })).toBeVisible();
  });
});
