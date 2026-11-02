import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
  injectCommandError,
  openViaCommandPalette,
  emitBackendEvent,
  isAppDialogOpen,
} from '../fixtures/test-helpers';

/**
 * E2E tests for the embedded PTY terminal (roadmap 4.6, issue #628).
 *
 * The backend is mocked: `pty_spawn` returns a session id, output arrives as
 * `pty-output` events and exit as `pty-exit`, exactly as the Rust side emits.
 */

const REPO_PATH = '/tmp/test-repo';

function spawnResult(id: number) {
  return { id, cwd: REPO_PATH, program: '/bin/bash', pid: 4242, cols: 80, rows: 24, startedAt: 0 };
}

const panel = (page: import('@playwright/test').Page) => page.locator('gn-terminal-panel');

test.describe('Embedded terminal', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, {
      pty_spawn: spawnResult(1),
      pty_write: null,
      pty_resize: null,
      pty_kill: null,
      get_worktrees: [],
    });
  });

  test('Toggle Terminal opens a shell in the repository and shows its output', async ({ page }) => {
    await openViaCommandPalette(page, 'Toggle Terminal');

    await expect(panel(page).locator('.tab')).toHaveCount(1);
    await waitForCommand(page, 'pty_spawn');
    const [spawn] = await findCommand(page, 'pty_spawn');
    expect((spawn.args as { options: { cwd: string } }).options.cwd).toBe(REPO_PATH);

    await emitBackendEvent(page, 'pty-output', { id: 1, data: 'user@host:test-repo$ ' });
    await expect(panel(page).locator('.xterm-rows')).toContainText('user@host:test-repo$');
  });

  test('typing in the terminal is sent to the PTY', async ({ page }) => {
    await openViaCommandPalette(page, 'Toggle Terminal');
    await expect(panel(page).locator('.xterm')).toBeVisible();
    await waitForCommand(page, 'pty_spawn');

    await panel(page).locator('.xterm').click();
    await page.keyboard.type('git status');
    await page.keyboard.press('Enter');

    await expect
      .poll(async () =>
        (await findCommand(page, 'pty_write'))
          .map((c) => (c.args as { data: string }).data)
          .join(''),
      )
      .toBe('git status\r');
  });

  test('Ctrl+R inside the terminal goes to the shell, not the app', async ({ page }) => {
    await openViaCommandPalette(page, 'Toggle Terminal');
    await expect(panel(page).locator('.xterm')).toBeVisible();
    await waitForCommand(page, 'pty_spawn');
    await panel(page).locator('.xterm').click();

    await page.keyboard.press('Control+r');

    await expect
      .poll(async () => (await findCommand(page, 'pty_write')).map((c) => (c.args as { data: string }).data))
      .toContain('\x12');
    expect(await isAppDialogOpen(page, 'reflog')).toBe(false);
  });

  test('the process exiting is shown on the tab and in the terminal', async ({ page }) => {
    await openViaCommandPalette(page, 'Toggle Terminal');
    await waitForCommand(page, 'pty_spawn');
    await expect(panel(page).locator('.tab')).toHaveCount(1);

    await emitBackendEvent(page, 'pty-exit', { id: 1, exitCode: 0 });

    await expect(panel(page).locator('.tab.exited')).toHaveCount(1);
    await expect(panel(page).locator('.xterm-rows')).toContainText('Process exited with code 0');
  });

  test('closing the tab kills the shell and leaves the empty state', async ({ page }) => {
    await openViaCommandPalette(page, 'Toggle Terminal');
    await expect(panel(page).locator('.tab')).toHaveCount(1);
    await waitForCommand(page, 'pty_spawn');

    await panel(page).locator('.tab-close').click();

    await expect(panel(page).locator('.tab')).toHaveCount(0);
    await expect(panel(page).locator('.empty-state')).toContainText('No terminals open');
    await waitForCommand(page, 'pty_kill');
    expect((await findCommand(page, 'pty_kill'))[0].args).toEqual({ id: 1 });
  });

  test('hiding the panel keeps the shell running and showing it again restores it', async ({ page }) => {
    await openViaCommandPalette(page, 'Toggle Terminal');
    await waitForCommand(page, 'pty_spawn');
    await emitBackendEvent(page, 'pty-output', { id: 1, data: 'still here' });
    await expect(panel(page).locator('.xterm-rows')).toContainText('still here');

    await panel(page).locator('.close-panel-btn').click();
    await expect(panel(page)).toHaveCount(0);

    await openViaCommandPalette(page, 'Toggle Terminal');
    await expect(panel(page).locator('.xterm-rows')).toContainText('still here');
    expect(await findCommand(page, 'pty_spawn')).toHaveLength(1);
    expect(await findCommand(page, 'pty_kill')).toHaveLength(0);
  });

  test('a shell that fails to start is reported', async ({ page }) => {
    await injectCommandError(page, 'pty_spawn', 'Failed to start /bin/bash: permission denied');

    await openViaCommandPalette(page, 'Toggle Terminal');

    await expect(page.locator('.toast.error')).toContainText('Could not start terminal');
    await expect(panel(page).locator('.tab.failed')).toHaveCount(1);
    await expect(panel(page).locator('.xterm-rows')).toContainText('permission denied');
  });

  test('the Output panel opens the built-in terminal', async ({ page }) => {
    await openViaCommandPalette(page, 'Toggle Output Panel');
    await page.locator('gn-output-panel .embedded-terminal-btn').click();

    await expect(panel(page).locator('.tab')).toHaveCount(1);
    await waitForCommand(page, 'pty_spawn');
    expect(await findCommand(page, 'open_terminal')).toHaveLength(0);
  });
});
