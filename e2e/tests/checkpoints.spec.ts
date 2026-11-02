import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  waitForRepositoryChanged,
  injectCommandError,
  openViaCommandPalette,
} from '../fixtures/test-helpers';

/**
 * E2E tests for working-tree checkpoints (roadmap 4.1, issue #607).
 */

const now = Math.floor(Date.now() / 1000);
const checkpoint = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
  id,
  oid: `oid-${id}`,
  label,
  sessionId: null,
  headOid: 'abc123',
  branch: 'main',
  createdAt: now - 300,
  filesChanged: 2,
  ...extra,
});

const dialog = (page: import('@playwright/test').Page) => page.locator('gn-checkpoints-dialog');

test.describe('Checkpoints', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('lists checkpoints and shows the files one captured', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      list_checkpoints: [
        checkpoint('2', 'After agent turn', { sessionId: 'claude-7' }),
        checkpoint('1', 'Before refactor'),
      ],
      get_checkpoint_files: [
        { path: 'src/main.ts', status: 'modified' },
        { path: 'notes.md', status: 'added' },
      ],
    });

    await openViaCommandPalette(page, 'Checkpoints');

    const rows = dialog(page).locator('.checkpoint');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('After agent turn');
    await expect(rows.first()).toContainText('claude-7');
    await expect(rows.first()).toContainText('5m ago');

    await rows.first().locator('.expand-btn').click();
    await expect(dialog(page).locator('.files')).toContainText('src/main.ts');
    await expect(dialog(page).locator('.files')).toContainText('notes.md');
  });

  test('creates a checkpoint from the dialog', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      list_checkpoints: [],
      create_checkpoint: checkpoint('9', 'Before risky change'),
    });
    await openViaCommandPalette(page, 'Checkpoints');
    await expect(dialog(page).locator('.empty-state')).toContainText('No checkpoints yet');

    await dialog(page).locator('.label-input').fill('Before risky change');
    await dialog(page).locator('.create-btn').click();

    await expect(page.locator('.toast.success')).toContainText('Before risky change');
    const [create] = await findCommand(page, 'create_checkpoint');
    expect(create.args).toMatchObject({ path: '/tmp/test-repo', label: 'Before risky change' });
  });

  test('restoring confirms, reports the backup, and refreshes the repository', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      list_checkpoints: [checkpoint('1', 'After turn 1')],
      restore_checkpoint: {
        restored: checkpoint('1', 'After turn 1'),
        backup: checkpoint('2', 'Before restoring "After turn 1"'),
      },
      'plugin:dialog|message': 'Ok',
    });
    await openViaCommandPalette(page, 'Checkpoints');

    // The working tree changed, so the app must refresh the repository.
    const refreshed = await waitForRepositoryChanged(page, async () => {
      await dialog(page).locator('.restore-btn').click();
    });

    await expect(page.locator('.toast.success')).toContainText('Before restoring');
    const [restore] = await findCommand(page, 'restore_checkpoint');
    expect(restore.args).toEqual({ path: '/tmp/test-repo', id: '1' });
    expect(refreshed).toBe(true);
  });

  test('a failed restore is reported', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      list_checkpoints: [checkpoint('1', 'After turn 1')],
      'plugin:dialog|message': 'Ok',
    });
    await injectCommandError(page, 'restore_checkpoint', 'Resolve merge conflicts before restoring a checkpoint');
    await openViaCommandPalette(page, 'Checkpoints');

    await dialog(page).locator('.restore-btn').click();

    await expect(page.locator('.toast.error')).toContainText('Resolve merge conflicts');
  });

  test('a load failure shows an error with retry', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {});
    await injectCommandError(page, 'list_checkpoints', 'could not read refs');
    await openViaCommandPalette(page, 'Checkpoints');

    await expect(dialog(page).locator('.error-state')).toContainText('could not read refs');
    await expect(dialog(page).locator('.retry-btn')).toBeVisible();
  });

  test('Create checkpoint from the palette works without opening the dialog', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      create_checkpoint: checkpoint('5', 'Checkpoint'),
    });

    await openViaCommandPalette(page, 'Create checkpoint');

    await expect(page.locator('.toast.success')).toContainText('Checkpoint "Checkpoint" created');
    await expect(dialog(page).locator('.checkpoint')).toHaveCount(0);
  });

  test('turning on automatic Claude Code checkpoints', async ({ page }) => {
    const paths = {
      settingsPath: '/tmp/test-repo/.claude/settings.local.json',
      scriptPath: '/tmp/test-repo/.git/gitnado/agent-checkpoint.sh',
    };
    await startCommandCaptureWithMocks(page, {
      list_checkpoints: [],
      install_agent_hooks: { installed: true, partial: false, ...paths },
      uninstall_agent_hooks: { installed: false, partial: false, ...paths },
    });
    await openViaCommandPalette(page, 'Checkpoints');

    const row = dialog(page).locator('.hooks-row');
    await expect(row).toContainText('Off');
    await row.locator('.hooks-btn').click();

    await expect(page.locator('.toast.success')).toContainText('before and after every turn');
    await expect(row).toContainText('On');
    expect((await findCommand(page, 'install_agent_hooks'))[0].args).toEqual({ path: '/tmp/test-repo' });

    await row.locator('.hooks-btn').click();
    await expect(row).toContainText('Off');
    expect(await findCommand(page, 'uninstall_agent_hooks')).toHaveLength(1);
  });

  test('a failed hook install is reported', async ({ page }) => {
    await startCommandCaptureWithMocks(page, { list_checkpoints: [] });
    await injectCommandError(page, 'install_agent_hooks', '.claude/settings.local.json is not a valid JSON object');
    await openViaCommandPalette(page, 'Checkpoints');

    await dialog(page).locator('.hooks-btn').click();

    await expect(page.locator('.toast.error')).toContainText('not a valid JSON object');
    await expect(dialog(page).locator('.hooks-row')).toContainText('Off');
  });
});
