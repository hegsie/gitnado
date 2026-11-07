import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
  injectCommandError,
  openViaCommandPalette,
  waitForRepositoryChanged,
} from '../fixtures/test-helpers';

/**
 * E2E tests for "Start agent on a task" (roadmap 4.1, issue #605).
 */

const dialog = (page: import('@playwright/test').Page) => page.locator('gn-start-agent-dialog');

test.describe('Start agent on a task', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('creates a worktree and starts the agent in the terminal with the task', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      add_worktree: { path: '/tmp/test-repo.worktrees/fix-flaky-login-test', branch: 'agent/fix-flaky-login-test' },
      get_worktrees: [],
      pty_spawn: {
        id: 7,
        cwd: '/tmp/test-repo.worktrees/fix-flaky-login-test',
        program: '/bin/bash',
        pid: 1,
        cols: 80,
        rows: 24,
        startedAt: 0,
      },
      pty_write: null,
      pty_resize: null,
    });

    await openViaCommandPalette(page, 'Start agent on a task');
    await dialog(page).locator('.task-input').fill('Fix flaky login test');
    await expect(dialog(page).locator('.branch-input')).toHaveValue('agent/fix-flaky-login-test');
    await expect(dialog(page).locator('.path-input')).toHaveValue('/tmp/test-repo.worktrees/fix-flaky-login-test');

    const refreshed = await waitForRepositoryChanged(page, async () => {
      await dialog(page).locator('.start-btn').click();
    });

    await expect(page.locator('.toast.success')).toContainText('Claude Code started');
    expect(refreshed).toBe(true);
    const [add] = await findCommand(page, 'add_worktree');
    expect(add.args).toMatchObject({
      path: '/tmp/test-repo',
      worktreePath: '/tmp/test-repo.worktrees/fix-flaky-login-test',
      newBranch: 'agent/fix-flaky-login-test',
    });
    const [spawn] = await findCommand(page, 'pty_spawn');
    expect((spawn.args as { options: { env: Record<string, string> } }).options.env).toEqual({
      GITNADO_TASK_PROMPT: 'Fix flaky login test',
    });
    await waitForCommand(page, 'pty_write');
    expect((await findCommand(page, 'pty_write'))[0].args).toEqual({ id: 7, data: 'claude "$GITNADO_TASK_PROMPT"\r' });

    // The terminal pane is open on the agent's tab, with no stray extra shell.
    await expect(page.locator('gn-terminal-panel .tab')).toHaveCount(1);
    await expect(page.locator('gn-terminal-panel .tab.active')).toContainText('Claude Code · agent/fix-flaky-login-test');
    expect(await findCommand(page, 'pty_spawn')).toHaveLength(1);
  });

  test('a worktree failure keeps the dialog open with the reason', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {});
    await injectCommandError(page, 'add_worktree', "fatal: '/tmp/x' already exists");
    await openViaCommandPalette(page, 'Start agent on a task');
    await dialog(page).locator('.task-input').fill('Anything');
    await dialog(page).locator('.start-btn').click();

    await expect(dialog(page).locator('.error')).toContainText('already exists');
    await expect(dialog(page).locator('.start-btn')).toBeEnabled();
    expect(await findCommand(page, 'pty_spawn')).toHaveLength(0);
  });

  test('Start is disabled until there is a task and a valid branch', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {});
    await openViaCommandPalette(page, 'Start agent on a task');
    await expect(dialog(page).locator('.start-btn')).toBeDisabled();

    await dialog(page).locator('.task-input').fill('Do something');
    await expect(dialog(page).locator('.start-btn')).toBeEnabled();

    await dialog(page).locator('.branch-input').fill('not valid');
    await expect(dialog(page).locator('.field-error')).toContainText('cannot contain spaces');
    await expect(dialog(page).locator('.start-btn')).toBeDisabled();
  });
});
