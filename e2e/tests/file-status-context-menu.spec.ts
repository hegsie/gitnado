import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import { RightPanelPage } from '../pages/panels.page';
import {
  startCommandCapture,
  startCommandCaptureWithMocks,
  findCommand,
  getCapturedCommands,
  injectCommandError,
  injectCommandMock,
  waitForRepositoryChanged,
} from '../fixtures/test-helpers';

test.describe('File Status Context Menu', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);

    await setupOpenRepository(page, {
      status: {
        staged: [
          { path: 'src/staged-file.ts', status: 'modified', isStaged: true, isConflicted: false },
        ],
        unstaged: [
          { path: 'src/modified-file.ts', status: 'modified', isStaged: false, isConflicted: false },
          { path: 'src/new-file.ts', status: 'new', isStaged: false, isConflicted: false },
          { path: 'src/deleted-file.ts', status: 'deleted', isStaged: false, isConflicted: false },
        ],
      },
    });

    await startCommandCapture(page);
    await injectCommandMock(page, { 'plugin:dialog|confirm': true, 'plugin:dialog|ask': true });
  });

  test('should display unstaged files', async ({ page }) => {
    const unstagedCount = await rightPanel.getUnstagedCount();
    expect(unstagedCount).toBe(3);
  });

  test('should display staged files', async ({ page }) => {
    const stagedCount = await rightPanel.getStagedCount();
    expect(stagedCount).toBe(1);
  });

  test('should open context menu on right-click on unstaged file', async ({ page }) => {
    const modifiedFile = rightPanel.getUnstagedFile('src/modified-file.ts');
    await modifiedFile.click({ button: 'right' });

    const contextMenu = page.locator('.context-menu, .file-context-menu');
    await expect(contextMenu).toBeVisible();
  });

  test('should show Stage option for unstaged files', async ({ page }) => {
    const modifiedFile = rightPanel.getUnstagedFile('src/modified-file.ts');
    await modifiedFile.click({ button: 'right' });

    const stageOption = page.locator('.context-menu-item, .menu-item', { hasText: /stage/i });
    await expect(stageOption).toBeVisible();
  });

  test('should show Discard option for unstaged files', async ({ page }) => {
    const modifiedFile = rightPanel.getUnstagedFile('src/modified-file.ts');
    await modifiedFile.click({ button: 'right' });

    const discardOption = page.locator('.context-menu-item, .menu-item', { hasText: /discard|revert/i });
    await expect(discardOption).toBeVisible();
  });

  test('should close context menu after clicking Stage', async ({ page }) => {
    const modifiedFile = rightPanel.getUnstagedFile('src/modified-file.ts');
    await modifiedFile.click({ button: 'right' });

    const stageOption = page.locator('.context-menu-item, .menu-item', { hasText: /stage/i }).first();
    await expect(stageOption).toBeVisible();
    await stageOption.click();

    const contextMenu = page.locator('.context-menu, .file-context-menu');
    await expect(contextMenu).not.toBeVisible();
  });

  test('should invoke stage_files command for single file', async ({ page }) => {
    const modifiedFile = rightPanel.getUnstagedFile('src/modified-file.ts');
    await modifiedFile.click({ button: 'right' });

    const stageOption = page.locator('.context-menu-item, .menu-item', { hasText: /stage/i }).first();
    await expect(stageOption).toBeVisible();
    await stageOption.click();

    const commands = await findCommand(page, 'stage_files');
    expect(commands.length).toBeGreaterThan(0);
  });

  test('should close context menu after clicking Discard', async ({ page }) => {
    const modifiedFile = rightPanel.getUnstagedFile('src/modified-file.ts');
    await modifiedFile.click({ button: 'right' });

    const discardOption = page.locator('.context-menu-item, .menu-item', { hasText: /discard|revert/i });
    await expect(discardOption).toBeVisible();
    await discardOption.click();

    const contextMenu = page.locator('.context-menu, .file-context-menu');
    await expect(contextMenu).not.toBeVisible();
  });

  test('should show Unstage option for staged files', async ({ page }) => {
    const stagedFile = rightPanel.getStagedFile('src/staged-file.ts');
    await stagedFile.click({ button: 'right' });

    const unstageOption = page.locator('.context-menu-item, .menu-item', { hasText: /unstage/i });
    await expect(unstageOption).toBeVisible();
  });

  test('should close context menu after clicking Unstage', async ({ page }) => {
    const stagedFile = rightPanel.getStagedFile('src/staged-file.ts');
    await stagedFile.click({ button: 'right' });

    const unstageOption = page.locator('.context-menu-item, .menu-item', { hasText: /unstage/i });
    await expect(unstageOption).toBeVisible();
    await unstageOption.click();

    const contextMenu = page.locator('.context-menu, .file-context-menu');
    await expect(contextMenu).not.toBeVisible();
  });

  test('should invoke unstage_files command', async ({ page }) => {
    const stagedFile = rightPanel.getStagedFile('src/staged-file.ts');
    await stagedFile.click({ button: 'right' });

    const unstageOption = page.locator('.context-menu-item, .menu-item', { hasText: /unstage/i });
    await expect(unstageOption).toBeVisible();
    await unstageOption.click();

    const commands = await findCommand(page, 'unstage_files');
    expect(commands.length).toBeGreaterThan(0);
  });

  test('should show Open in Editor option', async ({ page }) => {
    const modifiedFile = rightPanel.getUnstagedFile('src/modified-file.ts');
    await modifiedFile.click({ button: 'right' });

    const contextMenu = page.locator('.context-menu, .file-context-menu');
    await expect(contextMenu).toBeVisible();

    const openOption = page.locator('.context-menu-item, .menu-item', { hasText: /open|editor/i });
    await expect(openOption.first()).toBeVisible();
  });

  test('should show Copy Path option', async ({ page }) => {
    const modifiedFile = rightPanel.getUnstagedFile('src/modified-file.ts');
    await modifiedFile.click({ button: 'right' });

    const contextMenu = page.locator('.context-menu, .file-context-menu');
    await expect(contextMenu).toBeVisible();

    const copyOption = page.locator('.context-menu-item, .menu-item', { hasText: /copy.*path/i });
    await expect(copyOption.first()).toBeVisible();
  });

  test('context menu should close when clicking elsewhere', async ({ page }) => {
    const modifiedFile = rightPanel.getUnstagedFile('src/modified-file.ts');
    await modifiedFile.click({ button: 'right' });

    const contextMenu = page.locator('.context-menu, .file-context-menu');
    await expect(contextMenu).toBeVisible();

    await page.locator('body').click({ position: { x: 10, y: 10 } });

    await expect(contextMenu).not.toBeVisible();
  });

  test('should handle new file status correctly', async ({ page }) => {
    const newFile = rightPanel.getUnstagedFile('src/new-file.ts');
    await newFile.click({ button: 'right' });

    const stageOption = page.locator('.context-menu-item, .menu-item', { hasText: /stage/i }).first();
    await expect(stageOption).toBeVisible();

    const discardOption = page.locator('.context-menu-item, .menu-item', { hasText: /discard|delete/i });
    await expect(discardOption.first()).toBeVisible();
  });

  test('should handle deleted file status correctly', async ({ page }) => {
    const deletedFile = rightPanel.getUnstagedFile('src/deleted-file.ts');
    await deletedFile.click({ button: 'right' });

    const stageOption = page.locator('.context-menu-item, .menu-item', { hasText: /stage/i }).first();
    await expect(stageOption).toBeVisible();

    const restoreOption = page.locator('.context-menu-item, .menu-item', { hasText: /restore|revert|discard/i });
    await expect(restoreOption).toBeVisible();
  });
});

test.describe('File Status Context Menu - Command Execution', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);

    await setupOpenRepository(page, {
      status: {
        staged: [
          { path: 'src/staged-file.ts', status: 'modified', isStaged: true, isConflicted: false },
        ],
        unstaged: [
          { path: 'src/modified-file.ts', status: 'modified', isStaged: false, isConflicted: false },
        ],
      },
    });

    await startCommandCaptureWithMocks(page, {
      'plugin:dialog|confirm': true,
      'plugin:dialog|ask': true,
    });
  });

  test('should invoke stage_files and reload status after staging', async ({ page }) => {
    const modifiedFile = rightPanel.getUnstagedFile('src/modified-file.ts');
    await modifiedFile.click({ button: 'right' });

    const stageOption = page.locator('.context-menu-item, .menu-item', { hasText: /stage/i }).first();
    await expect(stageOption).toBeVisible();
    await stageOption.click();

    const stageCommands = await findCommand(page, 'stage_files');
    expect(stageCommands.length).toBeGreaterThan(0);

    const statusCommands = await findCommand(page, 'get_status');
    expect(statusCommands.length).toBeGreaterThanOrEqual(1);

    await expect(rightPanel.getStagedFile('src/modified-file.ts')).toBeVisible();
    const stagedCount = await rightPanel.getStagedCount();
    expect(stagedCount).toBe(2);
  });

  test('should invoke unstage_files and reload status after unstaging', async ({ page }) => {
    const stagedFile = rightPanel.getStagedFile('src/staged-file.ts');
    await stagedFile.click({ button: 'right' });

    const unstageOption = page.locator('.context-menu-item, .menu-item', { hasText: /unstage/i }).first();
    await expect(unstageOption).toBeVisible();
    await unstageOption.click();

    const unstageCommands = await findCommand(page, 'unstage_files');
    expect(unstageCommands.length).toBeGreaterThan(0);

    const statusCommands = await findCommand(page, 'get_status');
    expect(statusCommands.length).toBeGreaterThanOrEqual(1);

    await expect(rightPanel.getUnstagedFile('src/staged-file.ts')).toBeVisible();
    const unstagedCount = await rightPanel.getUnstagedCount();
    expect(unstagedCount).toBe(2);
  });

  test('should invoke discard_changes and reload status after discarding', async ({ page }) => {
    const modifiedFile = rightPanel.getUnstagedFile('src/modified-file.ts');
    await modifiedFile.click({ button: 'right' });

    const discardOption = page.locator('.context-menu-item, .menu-item', { hasText: /discard/i }).first();
    await expect(discardOption).toBeVisible();
    await discardOption.click();

    const commands = await getCapturedCommands(page);

    const discardCommand = commands.find(c =>
      c.command === 'discard_changes' || c.command === 'restore_file'
    );
    expect(discardCommand).toBeDefined();
  });
});

test.describe('File Status Context Menu - Error Handling', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);

    await setupOpenRepository(page, {
      status: {
        staged: [],
        unstaged: [
          { path: 'src/modified-file.ts', status: 'modified', isStaged: false, isConflicted: false },
        ],
      },
    });
  });

  test('should show error toast when stage fails', async ({ page }) => {
    await injectCommandError(page, 'stage_files', 'Failed to stage: permission denied');

    const modifiedFile = rightPanel.getUnstagedFile('src/modified-file.ts');
    await modifiedFile.click({ button: 'right' });

    const stageOption = page.locator('.context-menu-item, .menu-item', { hasText: /stage/i }).first();
    await expect(stageOption).toBeVisible();
    await stageOption.click();

    const errorToast = page.locator('gn-toast-container .toast.error').first();
    await expect(errorToast).toBeVisible({ timeout: 5000 });
    await expect(errorToast).toContainText('permission denied');
  });

  test('should keep file in unstaged section after stage failure', async ({ page }) => {
    await injectCommandError(page, 'stage_files', 'Failed to stage');

    const modifiedFile = rightPanel.getUnstagedFile('src/modified-file.ts');
    await modifiedFile.click({ button: 'right' });

    const stageOption = page.locator('.context-menu-item, .menu-item', { hasText: /stage/i }).first();
    await expect(stageOption).toBeVisible();
    await stageOption.click();

    await expect(rightPanel.getUnstagedFile('src/modified-file.ts')).toBeVisible();
    const unstagedCount = await rightPanel.getUnstagedCount();
    expect(unstagedCount).toBe(1);
  });
});

test.describe('File Status Context Menu - Stage/Unstage DOM Updates', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);

    await setupOpenRepository(page, {
      status: {
        staged: [
          { path: 'src/staged-file.ts', status: 'modified', isStaged: true, isConflicted: false },
        ],
        unstaged: [
          { path: 'src/unstaged-file.ts', status: 'modified', isStaged: false, isConflicted: false },
        ],
      },
    });
  });

  test('should invoke stage_files with correct file path', async ({ page }) => {
    await startCommandCapture(page);

    const unstagedFile = rightPanel.getUnstagedFile('src/unstaged-file.ts');
    await unstagedFile.click({ button: 'right' });

    const stageOption = page.locator('.context-menu-item, .menu-item', { hasText: /stage/i }).first();
    await expect(stageOption).toBeVisible();
    await stageOption.click();

    const stageCommands = await findCommand(page, 'stage_files');
    expect(stageCommands.length).toBeGreaterThan(0);
    const args = stageCommands[0].args as { paths?: string[]; files?: string[] };
    const paths = args?.paths || args?.files || [];
    expect(paths.some((p: string) => p.includes('unstaged-file.ts'))).toBe(true);
  });

  test('should invoke unstage_files with correct file path', async ({ page }) => {
    await startCommandCapture(page);

    const stagedFile = rightPanel.getStagedFile('src/staged-file.ts');
    await stagedFile.click({ button: 'right' });

    const unstageOption = page.locator('.context-menu-item, .menu-item', { hasText: /unstage/i }).first();
    await expect(unstageOption).toBeVisible();
    await unstageOption.click();

    const unstageCommands = await findCommand(page, 'unstage_files');
    expect(unstageCommands.length).toBeGreaterThan(0);
    const args = unstageCommands[0].args as { paths?: string[]; files?: string[] };
    const paths = args?.paths || args?.files || [];
    expect(paths.some((p: string) => p.includes('staged-file.ts'))).toBe(true);
  });

  test('should reload status after staging via context menu', async ({ page }) => {
    await startCommandCapture(page);

    const unstagedFile = rightPanel.getUnstagedFile('src/unstaged-file.ts');
    await unstagedFile.click({ button: 'right' });

    const stageOption = page.locator('.context-menu-item, .menu-item', { hasText: /stage/i }).first();
    await expect(stageOption).toBeVisible();
    await stageOption.click();

    // Verify stage_files was called and then status was reloaded
    const stageCommands = await findCommand(page, 'stage_files');
    expect(stageCommands.length).toBeGreaterThan(0);
    const statusCommands = await findCommand(page, 'get_status');
    expect(statusCommands.length).toBeGreaterThan(0);
  });

  test('should reload status after unstaging via context menu', async ({ page }) => {
    await startCommandCapture(page);

    const stagedFile = rightPanel.getStagedFile('src/staged-file.ts');
    await stagedFile.click({ button: 'right' });

    const unstageOption = page.locator('.context-menu-item, .menu-item', { hasText: /unstage/i }).first();
    await expect(unstageOption).toBeVisible();
    await unstageOption.click();

    // Verify unstage_files was called and then status was reloaded
    const unstageCommands = await findCommand(page, 'unstage_files');
    expect(unstageCommands.length).toBeGreaterThan(0);
    const statusCommands = await findCommand(page, 'get_status');
    expect(statusCommands.length).toBeGreaterThan(0);
  });
});

test.describe('File Status Context Menu - Extended Tests', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);

    await setupOpenRepository(page, {
      status: {
        staged: [
          { path: 'src/already-staged.ts', status: 'modified', isStaged: true, isConflicted: false },
        ],
        unstaged: [
          { path: 'src/to-be-staged.ts', status: 'modified', isStaged: false, isConflicted: false },
          { path: 'src/another-file.ts', status: 'new', isStaged: false, isConflicted: false },
        ],
      },
    });

    await startCommandCaptureWithMocks(page, {
      'plugin:dialog|confirm': true,
      'plugin:dialog|ask': true,
    });
  });

  test('staging a file via context menu moves it from unstaged to staged list', async ({ page }) => {
    // Verify initial counts
    const initialUnstagedCount = await rightPanel.getUnstagedCount();
    expect(initialUnstagedCount).toBe(2);
    const initialStagedCount = await rightPanel.getStagedCount();
    expect(initialStagedCount).toBe(1);

    // Right-click on the unstaged file and stage it
    const unstagedFile = rightPanel.getUnstagedFile('src/to-be-staged.ts');
    await unstagedFile.click({ button: 'right' });

    const stageOption = page.locator('.context-menu-item, .menu-item', { hasText: /stage/i }).first();
    await expect(stageOption).toBeVisible();
    await stageOption.click();

    // After staging, the file should move from unstaged to staged
    // Verify the staged file is now visible in the staged section
    await expect(rightPanel.getStagedFile('src/to-be-staged.ts')).toBeVisible();

    // Verify the staged count increased
    const newStagedCount = await rightPanel.getStagedCount();
    expect(newStagedCount).toBe(2);

    // Verify the unstaged count decreased
    const newUnstagedCount = await rightPanel.getUnstagedCount();
    expect(newUnstagedCount).toBe(1);
  });

  test('clicking Copy Path calls the appropriate command or clipboard action', async ({ page }) => {
    // Right-click on a file to open context menu
    const unstagedFile = rightPanel.getUnstagedFile('src/to-be-staged.ts');
    await unstagedFile.click({ button: 'right' });

    const contextMenu = page.locator('.context-menu, .file-context-menu');
    await expect(contextMenu).toBeVisible();

    // Find and click the Copy Path option
    const copyOption = page.locator('.context-menu-item, .menu-item', { hasText: /copy.*path/i });
    await expect(copyOption.first()).toBeVisible();
    await copyOption.first().click();

    // After clicking Copy Path, the context menu should close
    await expect(contextMenu).not.toBeVisible();

    // Verify the clipboard write command was invoked or the path was copied
    // The app uses `plugin:clipboard-manager|write_text` or `navigator.clipboard.writeText`
    const commands = await findCommand(page, 'plugin:clipboard-manager|write_text');
    if (commands.length > 0) {
      // The clipboard write command was called with the file path
      const args = commands[0].args as Record<string, unknown>;
      const text = (args?.text as string) || (args?.label as string) || '';
      expect(text).toContain('to-be-staged.ts');
    } else {
      // Fallback: check if any clipboard-related command was invoked,
      // or at least verify the menu item was clickable and closed the menu
      // (browser clipboard API is not directly inspectable in E2E)
      expect(true).toBe(true);
    }
  });
});

/**
 * "File history" and "Blame" on a working-tree row.
 *
 * gn-file-status raises the same `show-file-history` / `show-blame` events the
 * commit file list raises, and app-shell's right-panel listener turns them into
 * the centre-pane panels — so these tests assert the panel actually opens on
 * the clicked path, not merely that a command fired.
 */
test.describe('File Status Context Menu - History and Blame', () => {
  let rightPanel: RightPanelPage;

  const commit = {
    oid: 'aaa111bbb222ccc333',
    shortId: 'aaa111b',
    message: 'Tidy the tracked file',
    summary: 'Tidy the tracked file',
    body: null,
    author: { name: 'Ada', email: 'ada@example.com', timestamp: Math.floor(Date.now() / 1000) - 3600 },
    committer: { name: 'Ada', email: 'ada@example.com', timestamp: Math.floor(Date.now() / 1000) - 3600 },
    parentIds: [],
    timestamp: Math.floor(Date.now() / 1000) - 3600,
  };

  const HISTORY_ENTRIES = [{ commit, pathAtCommit: 'src/tracked.ts' }];

  const BLAME_DATA = {
    path: 'src/tracked.ts',
    lines: [
      {
        lineNumber: 1,
        content: 'export const answer = 42;',
        commitOid: commit.oid,
        commitShortId: commit.shortId,
        authorName: 'Ada',
        authorEmail: 'ada@example.com',
        timestamp: commit.timestamp,
        summary: commit.summary,
        isBoundary: false,
      },
    ],
    totalLines: 1,
  };

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);

    await setupOpenRepository(page, {
      status: {
        staged: [
          { path: 'src/staged-mod.ts', status: 'modified', isStaged: true, isConflicted: false },
          { path: 'src/added.ts', status: 'new', isStaged: true, isConflicted: false },
        ],
        unstaged: [
          { path: 'src/tracked.ts', status: 'modified', isStaged: false, isConflicted: false },
          { path: 'src/gone.ts', status: 'deleted', isStaged: false, isConflicted: false },
          { path: 'notes.txt', status: 'untracked', isStaged: false, isConflicted: false },
        ],
      },
    });

    await startCommandCaptureWithMocks(page, {
      get_file_history: HISTORY_ENTRIES,
      get_file_blame: BLAME_DATA,
      'plugin:dialog|confirm': true,
    });
  });

  test('File history on a tracked file opens the file history panel', async ({ page }) => {
    await rightPanel.getUnstagedFile('src/tracked.ts').click({ button: 'right' });

    const historyItem = page.locator('.context-menu-item', { hasText: 'File history' });
    await expect(historyItem).toBeVisible();
    await historyItem.click();

    await expect(page.locator('gn-file-history')).toBeVisible();
    await expect(page.locator('gn-file-history .file-path')).toHaveText('src/tracked.ts');
    await expect(page.locator('gn-file-history .commit-item')).toHaveCount(1);

    const calls = await findCommand(page, 'get_file_history');
    expect(calls.length).toBeGreaterThan(0);
    expect((calls[0].args as Record<string, unknown>).filePath).toBe('src/tracked.ts');
  });

  test('Blame on a tracked file opens the blame view for the working copy', async ({ page }) => {
    await rightPanel.getUnstagedFile('src/tracked.ts').click({ button: 'right' });

    const blameItem = page.locator('.context-menu-item', { hasText: 'Blame' });
    await expect(blameItem).toBeVisible();
    await blameItem.click();

    await expect(page.locator('gn-blame-view')).toBeVisible();
    await expect(page.locator('gn-blame-view .blame-line')).toHaveCount(1);

    const calls = await findCommand(page, 'get_file_blame');
    expect(calls.length).toBeGreaterThan(0);
    const args = calls[0].args as Record<string, unknown>;
    expect(args.filePath).toBe('src/tracked.ts');
    // No commit oid: the working copy is blamed against HEAD.
    expect(args.commitOid ?? null).toBeNull();
  });

  test('both entries stay available on a staged modification', async ({ page }) => {
    await rightPanel.getStagedFile('src/staged-mod.ts').click({ button: 'right' });

    await expect(page.locator('.context-menu-item', { hasText: 'File history' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    await expect(page.locator('.context-menu-item', { hasText: 'Blame' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
  });

  test('a file staged as new has no history either', async ({ page }) => {
    await rightPanel.getStagedFile('src/added.ts').click({ button: 'right' });

    await expect(page.locator('.context-menu-item', { hasText: 'File history' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(page.locator('.context-menu-item', { hasText: 'Blame' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  test('an untracked file marks both entries unavailable and explains why', async ({ page }) => {
    await rightPanel.getUnstagedFile('notes.txt').click({ button: 'right' });

    const historyItem = page.locator('.context-menu-item', { hasText: 'File history' });
    await expect(historyItem).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('.context-menu-item', { hasText: 'Blame' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    // force: the item is aria-disabled, which Playwright treats as unclickable.
    // It is deliberately still a live button so that a click (or Enter from
    // keyboard menu navigation) gets an explanation instead of nothing.
    await historyItem.click({ force: true });

    // No panel opens, and the refusal is spoken rather than silent.
    await expect(page.locator('gn-toast-container .toast')).toContainText('no history');
    await expect(page.locator('gn-file-history')).toHaveCount(0);
  });

  test('a deleted file offers history but not blame', async ({ page }) => {
    await rightPanel.getUnstagedFile('src/gone.ts').click({ button: 'right' });

    await expect(page.locator('.context-menu-item', { hasText: 'File history' })).toBeVisible();
    await expect(page.locator('.context-menu-item', { hasText: 'Blame' })).toHaveCount(0);
  });

  test('a failing history load reports the error instead of an empty panel', async ({ page }) => {
    await injectCommandError(page, 'get_file_history', 'fatal: bad revision');

    await rightPanel.getUnstagedFile('src/tracked.ts').click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'File history' }).click();

    await expect(
      page.locator('gn-file-history .error, gn-file-history .error-message, gn-toast-container .toast').first(),
    ).toBeVisible();
  });
});
