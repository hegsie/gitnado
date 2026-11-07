import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  injectCommandError,
  injectCommandMock,
  openViaCommandPalette,
} from '../fixtures/test-helpers';

/**
 * E2E tests for the Agent Sessions view (roadmap 4.1, issue #604).
 */

const session = (pid: number, extra: Record<string, unknown> = {}) => ({
  pid,
  agent: 'Claude Code',
  command: 'claude',
  cwd: '/tmp/test-repo',
  worktreePath: '/tmp/test-repo',
  isMainWorktree: true,
  branch: 'main',
  state: 'working',
  startedAt: 0,
  elapsedSecs: 600,
  changedFiles: 4,
  ...extra,
});

const dialog = (page: import('@playwright/test').Page) => page.locator('gn-agent-sessions-dialog');

test.describe('Agent Sessions', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('shows the agents running in the repository and its worktrees', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      list_agent_sessions: [
        session(101),
        session(202, {
          agent: 'Codex CLI',
          state: 'waiting',
          isMainWorktree: false,
          worktreePath: '/tmp/test-repo-feature',
          branch: 'feature/login',
          changedFiles: 0,
        }),
      ],
    });

    await openViaCommandPalette(page, 'Agent Sessions');

    const rows = dialog(page).locator('.session');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Claude Code');
    await expect(rows.nth(0)).toContainText('Working');
    await expect(rows.nth(0)).toContainText('4 changed files');
    await expect(rows.nth(0)).toContainText('running 10m');
    await expect(rows.nth(1)).toContainText('Codex CLI');
    await expect(rows.nth(1)).toContainText('Waiting for input');
    await expect(rows.nth(1)).toContainText('feature/login');
    await expect(rows.nth(1)).toContainText('no uncommitted changes');
  });

  test('an agent that exits is shown as ended after the next refresh', async ({ page }) => {
    await startCommandCaptureWithMocks(page, { list_agent_sessions: [session(101)] });
    await openViaCommandPalette(page, 'Agent Sessions');
    await expect(dialog(page).locator('.session')).toHaveCount(1);

    // The agent exits; the dialog's automatic refresh picks it up.
    await injectCommandMock(page, { list_agent_sessions: [] });

    await expect(dialog(page).locator('.session.ended')).toContainText('Ended', { timeout: 8000 });
    await dialog(page).locator('.clear-ended-btn').click();
    await expect(dialog(page).locator('.empty-state')).toContainText('No coding agents are running');
  });

  test('opens a terminal in the agent worktree', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      list_agent_sessions: [session(202, { worktreePath: '/tmp/test-repo-feature', isMainWorktree: false })],
      open_terminal: null,
    });
    await openViaCommandPalette(page, 'Agent Sessions');

    await dialog(page).locator('.terminal-btn').click();

    await expect
      .poll(async () => (await findCommand(page, 'open_terminal')).map((c) => c.args))
      .toEqual([{ path: '/tmp/test-repo-feature' }]);
  });

  test('shows an empty state when no agents are running', async ({ page }) => {
    await startCommandCaptureWithMocks(page, { list_agent_sessions: [] });
    await openViaCommandPalette(page, 'Agent Sessions');
    await expect(dialog(page).locator('.empty-state')).toContainText('No coding agents are running');
  });

  test('a failure to read the process table is reported with retry', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {});
    await injectCommandError(page, 'list_agent_sessions', 'process table unavailable');
    await openViaCommandPalette(page, 'Agent Sessions');

    await expect(dialog(page).locator('.error-state')).toContainText('process table unavailable');
    await expect(dialog(page).locator('.retry-btn')).toBeVisible();
  });
});
