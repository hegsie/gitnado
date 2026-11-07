import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';
import {
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
  injectCommandError,
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

const STACKS = [
  {
    base: 'main',
    branches: [
      { name: 'feat-a', parent: 'main', depth: 1, ahead: 2, behind: 0, isHead: false, parentMissing: false },
      { name: 'feat-b', parent: 'feat-a', depth: 2, ahead: 1, behind: 3, isHead: false, parentMissing: false },
    ],
  },
];

async function reloadBranches(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('repository-refresh')));
}

test.describe('Stacked branches', () => {
  let app: AppPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    await setupOpenRepository(page, {
      branches: [branch('main', true), branch('feat-a'), branch('feat-b'), branch('loose')],
    });
    await startCommandCaptureWithMocks(page, {
      get_stacks: STACKS,
      set_branch_parent: null,
      clear_branch_parent: null,
    });
    await reloadBranches(page);
  });

  test('shows each stack bottom-to-top with restack state', async ({ page }) => {
    const rows = page.locator('gn-branch-list .stack-branch');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('feat-a');
    await expect(rows.nth(0)).toContainText('+2');
    await expect(rows.nth(1)).toContainText('feat-b');
    await expect(rows.nth(1).locator('.stack-badge')).toHaveText('needs restack');
    await expect(page.locator('gn-branch-list .stack-base')).toContainText('on main');
  });

  test('Stack on… declares a parent and reports success', async ({ page }) => {
    await page.locator('gn-branch-list .branch-item:not(.stack-branch)', { hasText: 'loose' }).click({ button: 'right' });
    await page.locator('.context-menu-item[data-action="stack-on"]').click();

    const input = page.locator('gn-prompt-dialog input');
    await expect(input).toBeVisible();
    await input.fill('feat-b');
    await page.locator('gn-prompt-dialog .btn-primary').click();

    await waitForCommand(page, 'set_branch_parent');
    const calls = await findCommand(page, 'set_branch_parent');
    expect(calls[0].args).toMatchObject({ branch: 'loose', parent: 'feat-b' });
    await expect(page.locator('.toast', { hasText: 'loose is now stacked on feat-b' })).toBeVisible();
  });

  test('Stack on… shows the backend refusal', async ({ page }) => {
    await injectCommandError(page, 'set_branch_parent', 'stacking feat-a on it would make a loop');
    await page.locator('gn-branch-list .stack-branch', { hasText: 'feat-a' }).click({ button: 'right' });
    await expect(page.locator('.context-menu-item[data-action="stack-on"]')).toContainText('Change Stack Parent');
    await page.locator('.context-menu-item[data-action="stack-on"]').click();

    const input = page.locator('gn-prompt-dialog input');
    await expect(input).toBeVisible();
    await input.fill('feat-b');
    await page.locator('gn-prompt-dialog .btn-primary').click();

    await expect(page.locator('.toast', { hasText: 'would make a loop' })).toBeVisible();
  });

  test('Remove from Stack clears the parent and the section updates', async ({ page }) => {
    await page.locator('gn-branch-list .stack-branch', { hasText: 'feat-b' }).click({ button: 'right' });
    // After the clear, the backend reports only feat-a stacked.
    await startCommandCaptureWithMocks(page, {
      get_stacks: [{ base: 'main', branches: [STACKS[0].branches[0]] }],
      clear_branch_parent: null,
    });
    await page.locator('.context-menu-item[data-action="remove-from-stack"]').click();

    await waitForCommand(page, 'clear_branch_parent');
    expect((await findCommand(page, 'clear_branch_parent'))[0].args).toMatchObject({ branch: 'feat-b' });
    await expect(page.locator('.toast', { hasText: 'feat-b removed from its stack' })).toBeVisible();
    await expect(page.locator('gn-branch-list .stack-branch')).toHaveCount(1);
  });

  test('palette explains it cannot move below the base', async ({ page }) => {
    await app.executeCommand('Stack: check out the branch below');
    await expect(page.locator('.toast', { hasText: 'main is the base of its stack' })).toBeVisible();
    expect(await findCommand(page, 'checkout_with_autostash')).toHaveLength(0);
  });

  test('palette moves up the stack and back down', async ({ page }) => {
    await app.executeCommand('Stack: check out the branch above');
    await waitForCommand(page, 'checkout_with_autostash');
    expect(JSON.stringify((await findCommand(page, 'checkout_with_autostash'))[0].args)).toContain('feat-a');
    await expect(page.locator('gn-branch-list .branch-item.active:not(.stack-branch)')).toContainText('feat-a');

    await app.executeCommand('Stack: check out the branch below');
    await expect.poll(async () => (await findCommand(page, 'checkout_with_autostash')).length).toBe(2);
    expect(JSON.stringify((await findCommand(page, 'checkout_with_autostash'))[1].args)).toContain('main');
  });

  test('palette reports a branch that is not on a stack', async ({ page }) => {
    await startCommandCaptureWithMocks(page, { get_stacks: [] });
    await app.executeCommand('Stack: check out the branch above');
    await expect(page.locator('.toast', { hasText: 'main is not part of a stack' })).toBeVisible();
  });
});
