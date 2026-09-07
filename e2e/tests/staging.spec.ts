import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository, withModifiedFiles, withStagedFiles } from '../fixtures/tauri-mock';
import { RightPanelPage } from '../pages/panels.page';
import {
  startCommandCapture,
  findCommand,
  injectCommandError,
  startCommandCaptureWithMocks,
  waitForCommand,
  autoConfirmDialogs,
  openViaCommandPalette,
} from '../fixtures/test-helpers';

test.describe('File Staging', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withModifiedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: false, isConflicted: false },
        { path: 'README.md', status: 'modified', isStaged: false, isConflicted: false },
        { path: 'newfile.ts', status: 'untracked', isStaged: false, isConflicted: false },
      ])
    );
  });

  test('should display three unstaged files', async () => {
    const count = await rightPanel.getUnstagedCount();
    expect(count).toBe(3);
  });

  test('should show file names in unstaged section', async () => {
    await expect(rightPanel.getUnstagedFile('src/main.ts')).toBeVisible();
    await expect(rightPanel.getUnstagedFile('README.md')).toBeVisible();
    await expect(rightPanel.getUnstagedFile('newfile.ts')).toBeVisible();
  });

  test('should show Stage all button when there are unstaged files', async () => {
    await expect(rightPanel.stageAllButton).toBeVisible();
  });

  test('should show zero staged files count', async () => {
    const stagedCount = await rightPanel.getStagedCount();
    expect(stagedCount).toBe(0);
  });

  test('should emit file-selected event when clicking a file', async ({ page }) => {
    const eventPromise = page.evaluate(() => {
      return new Promise<{ path: string }>((resolve) => {
        document.addEventListener(
          'file-selected',
          (e) => {
            const detail = (e as CustomEvent).detail;
            resolve({ path: detail.file.path });
          },
          { once: true }
        );
        setTimeout(() => resolve({ path: '' }), 3000);
      });
    });

    await rightPanel.getUnstagedFile('src/main.ts').click();
    const result = await eventPromise;
    expect(result.path).toBe('src/main.ts');
  });
});

test.describe('Staged Files', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
        { path: 'README.md', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );
  });

  test('should display staged file count of 2', async () => {
    const count = await rightPanel.getStagedCount();
    expect(count).toBe(2);
  });

  test('should show Unstage all button when files are staged', async () => {
    await expect(rightPanel.unstageAllButton).toBeVisible();
  });

  test('should show zero unstaged files count', async () => {
    const unstagedCount = await rightPanel.getUnstagedCount();
    expect(unstagedCount).toBe(0);
  });

  test('should display staged file names', async () => {
    await expect(rightPanel.getStagedFile('src/main.ts')).toBeVisible();
    await expect(rightPanel.getStagedFile('README.md')).toBeVisible();
  });
});

test.describe('Commit Panel', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([{ path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false }])
    );
  });

  test('should display commit message textarea and commit button', async () => {
    await expect(rightPanel.commitMessage).toBeVisible();
    await expect(rightPanel.commitButton).toBeVisible();
  });

  test('should allow entering and reading back commit message', async () => {
    await rightPanel.commitMessage.fill('feat: add new feature');
    await expect(rightPanel.commitMessage).toHaveValue('feat: add new feature');
  });

  test('should disable commit button when no message is entered', async () => {
    // With staged files but no message, commit should be disabled
    await expect(rightPanel.commitButton).toBeDisabled();
  });

  test('should enable commit button when message is entered and files are staged', async () => {
    await rightPanel.commitMessage.fill('feat: test commit');
    await expect(rightPanel.commitButton).toBeEnabled();
  });

  test('should show character count for summary', async ({ page }) => {
    await rightPanel.commitMessage.fill('short message');
    const charCount = page.locator('lv-commit-panel .char-count');
    await expect(charCount).toContainText('13/72');
  });
});

test.describe('Mixed Staged and Unstaged', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page, {
      status: {
        staged: [{ path: 'staged.ts', status: 'modified', isStaged: true, isConflicted: false }],
        unstaged: [{ path: 'unstaged.ts', status: 'modified', isStaged: false, isConflicted: false }],
      },
    });
  });

  test('should show both staged and unstaged sections with correct counts', async () => {
    const stagedCount = await rightPanel.getStagedCount();
    const unstagedCount = await rightPanel.getUnstagedCount();
    expect(stagedCount).toBe(1);
    expect(unstagedCount).toBe(1);
  });

  test('should display both Stage all and Unstage all buttons', async () => {
    await expect(rightPanel.stageAllButton).toBeVisible();
    await expect(rightPanel.unstageAllButton).toBeVisible();
  });

  test('should show the staged file name', async () => {
    await expect(rightPanel.getStagedFile('staged.ts')).toBeVisible();
  });

  test('should show the unstaged file name', async () => {
    await expect(rightPanel.getUnstagedFile('unstaged.ts')).toBeVisible();
  });
});

test.describe('Empty Working Directory', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page, {
      status: { staged: [], unstaged: [] },
    });
  });

  test('should show clean working tree message', async ({ page }) => {
    const cleanState = page.locator('lv-file-status .clean-state');
    await expect(cleanState).toBeVisible();
    await expect(cleanState.locator('.title')).toHaveText('Working tree clean');
    await expect(cleanState.locator('.subtitle')).toHaveText('No changes to commit');
  });

  test('should have zero staged and unstaged counts', async () => {
    const stagedCount = await rightPanel.getStagedCount();
    const unstagedCount = await rightPanel.getUnstagedCount();
    expect(stagedCount).toBe(0);
    expect(unstagedCount).toBe(0);
  });

  test('should not show Stage all or Unstage all buttons', async () => {
    await expect(rightPanel.stageAllButton).not.toBeVisible();
    await expect(rightPanel.unstageAllButton).not.toBeVisible();
  });
});

test.describe('Staging Operations', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withModifiedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: false, isConflicted: false },
        { path: 'README.md', status: 'modified', isStaged: false, isConflicted: false },
        { path: 'newfile.ts', status: 'untracked', isStaged: false, isConflicted: false },
      ])
    );
  });

  test('Stage All button should invoke stage_files with all unstaged file paths', async ({ page }) => {
    await startCommandCapture(page);

    await rightPanel.stageAll();

    // Verify DOM: all files should have moved to staged section (Playwright auto-retry)
    const stagedCount = await rightPanel.getStagedCount();
    expect(stagedCount).toBe(3);
    const unstagedCount = await rightPanel.getUnstagedCount();
    expect(unstagedCount).toBe(0);

    const stageCommands = await findCommand(page, 'stage_files');
    expect(stageCommands.length).toBeGreaterThan(0);

    const args = stageCommands[0].args as { paths: string[] };
    expect(args.paths).toContain('src/main.ts');
    expect(args.paths).toContain('README.md');
    expect(args.paths).toContain('newfile.ts');
    expect(args.paths).toHaveLength(3);
  });

  test('individual file stage button should invoke stage_files with that file path', async ({ page }) => {
    await startCommandCapture(page);

    await rightPanel.stageFile('README.md');
    await waitForCommand(page, 'stage_files');

    const stageCommands = await findCommand(page, 'stage_files');
    expect(stageCommands.length).toBeGreaterThan(0);

    const args = stageCommands[0].args as { paths: string[] };
    expect(args.paths).toEqual(['README.md']);

    // Verify DOM: README.md should now be visible in the staged section
    await expect(rightPanel.getStagedFile('README.md')).toBeVisible();
  });

  test('Unstage All button should invoke unstage_files with all staged file paths', async ({ page }) => {
    // Set up with staged files instead
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
        { path: 'README.md', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );

    rightPanel = new RightPanelPage(page);
    await startCommandCapture(page);

    await rightPanel.unstageAll();
    await waitForCommand(page, 'unstage_files');

    const unstageCommands = await findCommand(page, 'unstage_files');
    expect(unstageCommands.length).toBeGreaterThan(0);

    const args = unstageCommands[0].args as { paths: string[] };
    expect(args.paths).toContain('src/main.ts');
    expect(args.paths).toContain('README.md');
    expect(args.paths).toHaveLength(2);

    // Verify DOM: all files should have moved to unstaged section
    const stagedCountAfter = await rightPanel.getStagedCount();
    expect(stagedCountAfter).toBe(0);
    const unstagedCountAfter = await rightPanel.getUnstagedCount();
    expect(unstagedCountAfter).toBe(2);
  });

  test('individual file unstage button should invoke unstage_files with that file path', async ({ page }) => {
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );

    rightPanel = new RightPanelPage(page);
    await startCommandCapture(page);

    await rightPanel.unstageFile('src/main.ts');
    await waitForCommand(page, 'unstage_files');

    const unstageCommands = await findCommand(page, 'unstage_files');
    expect(unstageCommands.length).toBeGreaterThan(0);

    const args = unstageCommands[0].args as { paths: string[] };
    expect(args.paths).toEqual(['src/main.ts']);

    // Verify DOM: unstaged file should now be visible in the unstaged section
    await expect(rightPanel.getUnstagedFile('src/main.ts')).toBeVisible();
  });

  test('stage_files should pass repository path in arguments', async ({ page }) => {
    await startCommandCapture(page);

    await rightPanel.stageAll();
    await waitForCommand(page, 'stage_files');

    const stageCommands = await findCommand(page, 'stage_files');
    expect(stageCommands.length).toBeGreaterThan(0);

    const args = stageCommands[0].args as { path: string };
    expect(args.path).toBe('/tmp/test-repo');
  });
});

test.describe('Staging Error Handling', () => {
  let rightPanel: RightPanelPage;

  test('stage_files failure should not crash the UI and file list remains visible', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withModifiedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: false, isConflicted: false },
      ])
    );

    // Inject error for stage_files command
    await injectCommandError(page, 'stage_files', 'Permission denied: cannot stage file');

    await rightPanel.stageFile('src/main.ts');

    // The UI should still be functional -- unstaged file should still be visible
    // because the loadStatus refresh after a failed stage won't change the data
    await expect(rightPanel.getUnstagedFile('src/main.ts')).toBeVisible();
  });

  test('unstage_files failure should keep staged files visible', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );

    await injectCommandError(page, 'unstage_files', 'Cannot unstage file');

    await rightPanel.unstageFile('src/main.ts');

    // The staged file should still be visible since the operation failed
    await expect(rightPanel.getStagedFile('src/main.ts')).toBeVisible();
  });

  test('commit failure should display error message in commit panel', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );

    await injectCommandError(page, 'create_commit', 'Commit hook failed: pre-commit rejected');

    await rightPanel.commitMessage.fill('test: failing commit');
    await rightPanel.commitButton.click();

    const errorMessage = page.locator('lv-commit-panel .error');
    await expect(errorMessage).toBeVisible();
    await expect(errorMessage).toContainText('Commit hook failed');
  });

  test('get_status failure should display error state in file status component', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withModifiedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: false, isConflicted: false },
      ])
    );

    // Inject error for get_status and then trigger a refresh
    await injectCommandError(page, 'get_status', 'Repository is corrupt');

    // Trigger a status refresh by dispatching the status-refresh event
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('status-refresh'));
    });

    const errorElement = page.locator('lv-file-status .error');
    await expect(errorElement).toBeVisible();
    await expect(errorElement).toContainText('Repository is corrupt');
  });
});

test.describe('Staging to Commit Flow', () => {
  let rightPanel: RightPanelPage;

  test('should invoke create_commit with correct message after staging', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );

    // Set up capture with mock that returns a commit object for create_commit
    await startCommandCaptureWithMocks(page, {
      create_commit: { oid: 'abc123', shortId: 'abc123d', summary: 'feat: new feature' },
    });

    await rightPanel.commitMessage.fill('feat: new feature');
    await rightPanel.commitButton.click();
    await waitForCommand(page, 'create_commit');

    const commitCommands = await findCommand(page, 'create_commit');
    expect(commitCommands.length).toBe(1);

    const args = commitCommands[0].args as { message: string; path: string; amend: boolean };
    expect(args.message).toBe('feat: new feature');
    expect(args.path).toBe('/tmp/test-repo');
    expect(args.amend).toBe(false);
  });

  test('successful commit should show success message in commit panel', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );

    await startCommandCaptureWithMocks(page, {
      create_commit: { oid: 'abc123def456', shortId: 'abc123d', summary: 'test commit' },
    });

    await rightPanel.commitMessage.fill('test: commit message');
    await rightPanel.commitButton.click();

    const successMessage = page.locator('lv-commit-panel .success');
    await expect(successMessage).toBeVisible();
    await expect(successMessage).toContainText('abc123d');
  });

  test('successful commit should clear the commit message field', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );

    await startCommandCaptureWithMocks(page, {
      create_commit: { oid: 'abc123', shortId: 'abc123d', summary: 'test' },
    });

    await rightPanel.commitMessage.fill('test: should be cleared');
    await rightPanel.commitButton.click();

    await expect(rightPanel.commitMessage).toHaveValue('');
  });

  test('successful commit should dispatch repository-refresh pinned to the committing repository', async ({
    page,
  }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );

    await startCommandCaptureWithMocks(page, {
      create_commit: { oid: 'abc123', shortId: 'abc123d', summary: 'test' },
    });

    // Collect every repository-refresh the commit flow emits (the commit panel's
    // own and the right panel's re-broadcast), skipping app-shell's tagged
    // self-broadcast. Each must name the repo the commit ran in — an untagged
    // refresh falls back to whichever tab is active.
    await page.evaluate(() => {
      const w = window as unknown as { __refreshDetails?: Array<{ repoPath?: string }> };
      w.__refreshDetails = [];
      window.addEventListener('repository-refresh', (e) => {
        const detail = (e as CustomEvent).detail as
          | { repoPath?: string; source?: string }
          | undefined;
        if (detail?.source === 'app-shell') return;
        w.__refreshDetails?.push({ repoPath: detail?.repoPath });
      });
    });

    await rightPanel.commitMessage.fill('feat: trigger refresh');
    await rightPanel.commitButton.click();

    await page.waitForFunction(() => {
      const w = window as unknown as { __refreshDetails?: unknown[] };
      return (w.__refreshDetails?.length ?? 0) > 0;
    });

    const details = await page.evaluate(
      () => (window as unknown as { __refreshDetails: Array<{ repoPath?: string }> }).__refreshDetails
    );
    expect(details.length).toBeGreaterThan(0);
    for (const detail of details) {
      expect(detail.repoPath).toBe('/tmp/test-repo');
    }
  });

  test('successful commit should dispatch commit-created event with commit data', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );

    await startCommandCaptureWithMocks(page, {
      create_commit: { oid: 'new-commit-123', shortId: 'new-com', summary: 'feat: test' },
    });

    // Listen for commit-created event
    const eventPromise = page.evaluate(() => {
      return new Promise<{ oid: string } | null>((resolve) => {
        document.addEventListener(
          'commit-created',
          (e) => {
            const detail = (e as CustomEvent).detail;
            resolve(detail.commit);
          },
          { once: true }
        );
        setTimeout(() => resolve(null), 3000);
      });
    });

    await rightPanel.commitMessage.fill('feat: test');
    await rightPanel.commitButton.click();

    const commitData = await eventPromise;
    expect(commitData).not.toBeNull();
    expect(commitData!.oid).toBe('new-commit-123');
  });

  test('commit with description should send full message', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );

    await startCommandCaptureWithMocks(page, {
      create_commit: { oid: 'abc', shortId: 'abc', summary: 'feat: summary' },
    });

    // Fill summary
    await rightPanel.commitMessage.fill('feat: summary line');
    // Fill description
    const descriptionInput = page.locator('lv-commit-panel .description-input');
    await descriptionInput.fill('This is the body of the commit.\nWith multiple lines.');
    await rightPanel.commitButton.click();
    await waitForCommand(page, 'create_commit');

    const commitCommands = await findCommand(page, 'create_commit');
    expect(commitCommands.length).toBe(1);

    const args = commitCommands[0].args as { message: string };
    expect(args.message).toContain('feat: summary line');
    expect(args.message).toContain('This is the body of the commit.');
    expect(args.message).toContain('With multiple lines.');
  });

  test('Cmd+Enter should trigger commit when message is entered', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );

    await startCommandCaptureWithMocks(page, {
      create_commit: { oid: 'abc', shortId: 'abc', summary: 'test' },
    });

    await rightPanel.commitMessage.fill('test: keyboard commit');
    // Use Meta+Enter (Cmd+Enter on Mac)
    await rightPanel.commitMessage.press('Meta+Enter');
    await waitForCommand(page, 'create_commit');

    const commitCommands = await findCommand(page, 'create_commit');
    expect(commitCommands.length).toBe(1);

    const args = commitCommands[0].args as { message: string };
    expect(args.message).toBe('test: keyboard commit');
  });

  test('commit button should be disabled with no staged files and no message', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withModifiedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: false, isConflicted: false },
      ])
    );

    // No staged files and no message -- commit button must be disabled
    await expect(rightPanel.commitButton).toBeDisabled();

    // Even with a message, no staged files means disabled
    await rightPanel.commitMessage.fill('test: no staged files');
    await expect(rightPanel.commitButton).toBeDisabled();
  });
});

test.describe('Staging - UI Outcome Verification', () => {
  let rightPanel: RightPanelPage;

  test('stage files: verify commit button enables after staging', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withModifiedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: false, isConflicted: false },
        { path: 'README.md', status: 'modified', isStaged: false, isConflicted: false },
      ])
    );

    // With no staged files, commit button should be disabled even with a message
    await rightPanel.commitMessage.fill('feat: test commit');
    await expect(rightPanel.commitButton).toBeDisabled();

    // Stage all files
    await rightPanel.stageAll();

    // After staging, the staged count should be 2
    const stagedCount = await rightPanel.getStagedCount();
    expect(stagedCount).toBe(2);

    // Now with staged files and a message, commit button should be enabled
    await expect(rightPanel.commitButton).toBeEnabled();
  });

  test('commit success: verify staged file list clears after commit', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
        { path: 'README.md', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );

    // Verify staged files are initially present
    const initialStagedCount = await rightPanel.getStagedCount();
    expect(initialStagedCount).toBe(2);

    // After commit, the component re-fetches status. Mock get_status to return empty
    // so the staged file list clears and the clean working tree message appears.
    // get_status returns a flat array of StatusEntry[] (not an object with staged/unstaged).
    await startCommandCaptureWithMocks(page, {
      create_commit: { oid: 'commit-abc123', shortId: 'commit-', summary: 'feat: test' },
      get_status: [],
    });

    // Enter commit message and commit
    await rightPanel.commitMessage.fill('feat: test commit');
    await rightPanel.commitButton.click();

    // Wait for commit to complete and subsequent status refresh
    await waitForCommand(page, 'create_commit');
    await waitForCommand(page, 'get_status');

    // Clean working tree message should appear (auto-retrying assertion handles DOM update timing)
    const cleanState = page.locator('lv-file-status .clean-state');
    await expect(cleanState).toBeVisible();

    // After successful commit, staged file list should be empty
    const stagedCountAfter = await rightPanel.getStagedCount();
    expect(stagedCountAfter).toBe(0);
  });
});

test.describe('Staging Error Toasts and UI Outcome Verification', () => {
  let rightPanel: RightPanelPage;

  test('stage_files failure should show error toast', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withModifiedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: false, isConflicted: false },
        { path: 'README.md', status: 'modified', isStaged: false, isConflicted: false },
      ])
    );

    // Verify initial state: 2 unstaged, 0 staged
    const initialUnstaged = await rightPanel.getUnstagedCount();
    expect(initialUnstaged).toBe(2);
    const initialStaged = await rightPanel.getStagedCount();
    expect(initialStaged).toBe(0);

    // Inject error for stage_files command
    await injectCommandError(page, 'stage_files', 'Permission denied');

    // Try to stage a file
    await rightPanel.stageFile('src/main.ts');

    // Error toast or error indicator should appear
    const errorIndicator = page.locator(
      'lv-toast-container .toast.error, .toast.error, lv-file-status .error, .error-banner'
    ).first();
    await expect(errorIndicator).toBeVisible({ timeout: 5000 });

    // The file should remain in the unstaged section since the operation failed
    await expect(rightPanel.getUnstagedFile('src/main.ts')).toBeVisible();
  });

  test('unstage_files failure should show error toast', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
        { path: 'README.md', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );

    // Verify initial state: 0 unstaged, 2 staged
    const initialStaged = await rightPanel.getStagedCount();
    expect(initialStaged).toBe(2);
    const initialUnstaged = await rightPanel.getUnstagedCount();
    expect(initialUnstaged).toBe(0);

    // Inject error for unstage_files command
    await injectCommandError(page, 'unstage_files', 'Permission denied');

    // Try to unstage a file
    await rightPanel.unstageFile('src/main.ts');

    // Error toast or error indicator should appear
    const errorIndicator = page.locator(
      'lv-toast-container .toast.error, .toast.error, lv-file-status .error, .error-banner'
    ).first();
    await expect(errorIndicator).toBeVisible({ timeout: 5000 });

    // The file should remain in the staged section since the operation failed
    await expect(rightPanel.getStagedFile('src/main.ts')).toBeVisible();
  });

  test('staging a file should move it from unstaged to staged section with updated counts', async ({
    page,
  }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withModifiedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: false, isConflicted: false },
        { path: 'README.md', status: 'modified', isStaged: false, isConflicted: false },
        { path: 'newfile.ts', status: 'untracked', isStaged: false, isConflicted: false },
      ])
    );

    // Verify initial counts: 3 unstaged, 0 staged
    const initialUnstaged = await rightPanel.getUnstagedCount();
    expect(initialUnstaged).toBe(3);
    const initialStaged = await rightPanel.getStagedCount();
    expect(initialStaged).toBe(0);

    await startCommandCapture(page);

    // Stage a single file
    await rightPanel.stageFile('README.md');
    await waitForCommand(page, 'stage_files');

    // Verify the command was invoked
    const stageCommands = await findCommand(page, 'stage_files');
    expect(stageCommands.length).toBeGreaterThan(0);

    // Verify file moved from unstaged to staged section
    await expect(rightPanel.getStagedFile('README.md')).toBeVisible();

    // Verify counts updated: unstaged decreased by 1, staged increased by 1
    const updatedUnstaged = await rightPanel.getUnstagedCount();
    expect(updatedUnstaged).toBe(2);
    const updatedStaged = await rightPanel.getStagedCount();
    expect(updatedStaged).toBe(1);
  });

  test('unstaging a file should move it from staged to unstaged section with updated counts', async ({
    page,
  }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
        { path: 'README.md', status: 'modified', isStaged: true, isConflicted: false },
        { path: 'newfile.ts', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );

    // Verify initial counts: 0 unstaged, 3 staged
    const initialUnstaged = await rightPanel.getUnstagedCount();
    expect(initialUnstaged).toBe(0);
    const initialStaged = await rightPanel.getStagedCount();
    expect(initialStaged).toBe(3);

    await startCommandCapture(page);

    // Unstage a single file
    await rightPanel.unstageFile('src/main.ts');
    await waitForCommand(page, 'unstage_files');

    // Verify the command was invoked
    const unstageCommands = await findCommand(page, 'unstage_files');
    expect(unstageCommands.length).toBeGreaterThan(0);

    // Verify file moved from staged to unstaged section
    await expect(rightPanel.getUnstagedFile('src/main.ts')).toBeVisible();

    // Verify counts updated: staged decreased by 1, unstaged increased by 1
    const updatedStaged = await rightPanel.getStagedCount();
    expect(updatedStaged).toBe(2);
    const updatedUnstaged = await rightPanel.getUnstagedCount();
    expect(updatedUnstaged).toBe(1);
  });
});

test.describe('Staging - Error Handling', () => {
  let rightPanel: RightPanelPage;

  test('stage_files failure should show error feedback and preserve file state', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withModifiedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: false, isConflicted: false },
        { path: 'README.md', status: 'modified', isStaged: false, isConflicted: false },
      ])
    );

    // Verify initial state: 2 unstaged, 0 staged
    const initialUnstaged = await rightPanel.getUnstagedCount();
    expect(initialUnstaged).toBe(2);
    const initialStaged = await rightPanel.getStagedCount();
    expect(initialStaged).toBe(0);

    // Inject error for stage_files command
    await injectCommandError(page, 'stage_files', 'Permission denied');

    // Try to stage a file
    await rightPanel.stageFile('src/main.ts');

    // Error toast/banner should appear
    const errorIndicator = page
      .locator('.toast.error, .error-banner, .error-message, lv-toast-container .toast')
      .first();
    await expect(errorIndicator).toBeVisible({ timeout: 5000 });

    // The file should remain in the unstaged section since the operation failed
    await expect(rightPanel.getUnstagedFile('src/main.ts')).toBeVisible();

    // Both files should still be unstaged (counts unchanged)
    const unstagedAfter = await rightPanel.getUnstagedCount();
    expect(unstagedAfter).toBe(2);
    const stagedAfter = await rightPanel.getStagedCount();
    expect(stagedAfter).toBe(0);
  });

  test('unstage_files failure should show error feedback and preserve file state', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
        { path: 'README.md', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );

    // Verify initial state: 0 unstaged, 2 staged
    const initialStaged = await rightPanel.getStagedCount();
    expect(initialStaged).toBe(2);
    const initialUnstaged = await rightPanel.getUnstagedCount();
    expect(initialUnstaged).toBe(0);

    // Inject error for unstage_files command
    await injectCommandError(page, 'unstage_files', 'Permission denied');

    // Try to unstage a file
    await rightPanel.unstageFile('src/main.ts');

    // Error toast/banner should appear
    const errorIndicator = page
      .locator('.toast.error, .error-banner, .error-message, lv-toast-container .toast')
      .first();
    await expect(errorIndicator).toBeVisible({ timeout: 5000 });

    // The file should remain in the staged section since the operation failed
    await expect(rightPanel.getStagedFile('src/main.ts')).toBeVisible();

    // Both files should still be staged (counts unchanged)
    const stagedAfter = await rightPanel.getStagedCount();
    expect(stagedAfter).toBe(2);
    const unstagedAfter = await rightPanel.getUnstagedCount();
    expect(unstagedAfter).toBe(0);
  });

  test('discard_changes failure should show error feedback', async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withModifiedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: false, isConflicted: false },
        { path: 'README.md', status: 'modified', isStaged: false, isConflicted: false },
      ])
    );

    // Verify initial state: 2 unstaged files
    const initialUnstaged = await rightPanel.getUnstagedCount();
    expect(initialUnstaged).toBe(2);

    // Inject error for discard_changes command
    await injectCommandError(page, 'discard_changes', 'File is locked');

    // Auto-confirm the discard confirmation dialog
    await autoConfirmDialogs(page);

    // Trigger discard via the discard button on a file (hover to reveal, then click)
    const file = rightPanel.getUnstagedFile('src/main.ts');
    await file.hover();
    await file.locator('button[title="Discard changes"]').click();

    // Error toast/banner should appear
    const errorIndicator = page
      .locator('.toast.error, .error-banner, .error-message, lv-toast-container .toast')
      .first();
    await expect(errorIndicator).toBeVisible({ timeout: 5000 });

    // The file should remain in the unstaged section since discard failed
    await expect(rightPanel.getUnstagedFile('src/main.ts')).toBeVisible();

    // File counts should be unchanged
    const unstagedAfter = await rightPanel.getUnstagedCount();
    expect(unstagedAfter).toBe(2);
  });
});

test.describe('Changes filter', () => {
  let rightPanel: RightPanelPage;

  const filterInput = (page: Page) => page.locator('lv-file-status .filter-input');

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withModifiedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: false, isConflicted: false },
        { path: 'src/utils/helper.ts', status: 'modified', isStaged: false, isConflicted: false },
        { path: 'README.md', status: 'modified', isStaged: false, isConflicted: false },
        { path: 'newfile.ts', status: 'untracked', isStaged: false, isConflicted: false },
      ])
    );
  });

  test('typing a filter narrows the list and the x button restores it', async ({ page }) => {
    await expect(rightPanel.getUnstagedFile('README.md')).toBeVisible();

    await filterInput(page).fill('src/');

    await expect(rightPanel.getUnstagedFile('src/main.ts')).toBeVisible();
    await expect(rightPanel.getUnstagedFile('src/utils/helper.ts')).toBeVisible();
    await expect(rightPanel.getUnstagedFile('README.md')).toHaveCount(0);
    await expect(rightPanel.getUnstagedFile('newfile.ts')).toHaveCount(0);

    // The count stays honest about the real total
    const changesCount = page.locator(
      'lv-file-status .section-header:has-text("Changes") .section-count'
    );
    await expect(changesCount).toHaveText('2 of 4');

    await page.locator('lv-file-status .filter-clear').click();

    await expect(rightPanel.getUnstagedFile('README.md')).toBeVisible();
    await expect(rightPanel.getUnstagedFile('newfile.ts')).toBeVisible();
    await expect(changesCount).toHaveText('4');
  });

  test('Escape in the filter clears it', async ({ page }) => {
    await filterInput(page).fill('helper');
    await expect(rightPanel.getUnstagedFile('README.md')).toHaveCount(0);

    await filterInput(page).press('Escape');

    await expect(filterInput(page)).toHaveValue('');
    await expect(rightPanel.getUnstagedFile('README.md')).toBeVisible();
  });

  test('shows an empty-result state with a clear action when nothing matches', async ({
    page,
  }) => {
    await filterInput(page).fill('does-not-exist');

    const empty = page.locator('lv-file-status .no-match-state');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('No files match');
    await expect(empty).toContainText('does-not-exist');
    await expect(page.locator('lv-file-status li.file-item')).toHaveCount(0);

    await empty.locator('.no-match-clear').click();

    await expect(empty).toHaveCount(0);
    await expect(rightPanel.getUnstagedFile('README.md')).toBeVisible();
  });

  test('the section Stage-all button acts only on the filtered files', async ({ page }) => {
    await filterInput(page).fill('src/utils');
    await expect(rightPanel.getUnstagedFile('src/utils/helper.ts')).toBeVisible();

    await startCommandCapture(page);

    const stageMatching = page.getByRole('button', {
      name: 'Stage 1 file matching the filter',
      exact: true,
    });
    await expect(stageMatching).toBeVisible();
    await stageMatching.click();

    await waitForCommand(page, 'stage_files');
    const calls = await findCommand(page, 'stage_files');
    expect(calls.length).toBeGreaterThan(0);
    const args = calls[0].args as { paths: string[] };
    expect(args.paths).toEqual(['src/utils/helper.ts']);
  });

  test('the s shortcut stages the same set as the header button, and says what it did', async ({
    page,
  }) => {
    await filterInput(page).fill('src/utils');
    await expect(rightPanel.getUnstagedFile('src/utils/helper.ts')).toBeVisible();
    // Leave the filter box: its own keystrokes are text, not shortcuts.
    await filterInput(page).blur();

    await startCommandCapture(page);
    await page.keyboard.press('s');

    await waitForCommand(page, 'stage_files');
    const args = (await findCommand(page, 'stage_files'))[0].args as { paths: string[] };
    // The global shortcut used to stage all four; it now matches the button.
    expect(args.paths).toEqual(['src/utils/helper.ts']);

    // Its label says ALL, so the result has to say what "all" meant.
    await expect(
      page.locator('lv-toast-container .toast', { hasText: 'Staged 1 of 4 files' }),
    ).toBeVisible();
  });

  test('the palette "Stage all changes" entry stages only the filtered files', async ({
    page,
  }) => {
    await filterInput(page).fill('src/utils');
    await expect(rightPanel.getUnstagedFile('src/utils/helper.ts')).toBeVisible();

    await startCommandCapture(page);
    await openViaCommandPalette(page, 'Stage all changes');

    await waitForCommand(page, 'stage_files');
    const args = (await findCommand(page, 'stage_files'))[0].args as { paths: string[] };
    expect(args.paths).toEqual(['src/utils/helper.ts']);
    await expect(
      page.locator('lv-toast-container .toast', { hasText: 'Staged 1 of 4 files' }),
    ).toBeVisible();
  });

  test('a filter that matches nothing makes the s shortcut say so instead of nothing', async ({
    page,
  }) => {
    await filterInput(page).fill('does-not-exist');
    await expect(page.locator('lv-file-status .no-match-state')).toBeVisible();
    await filterInput(page).blur();

    await startCommandCapture(page);
    await page.keyboard.press('s');

    await expect(
      page.locator('lv-toast-container .toast', { hasText: 'Nothing to stage' }),
    ).toBeVisible();
    expect(await findCommand(page, 'stage_files')).toHaveLength(0);
  });

  test('a filter that matches nothing makes the palette entry say so too', async ({ page }) => {
    await filterInput(page).fill('does-not-exist');
    await expect(page.locator('lv-file-status .no-match-state')).toBeVisible();

    await startCommandCapture(page);
    await openViaCommandPalette(page, 'Stage all changes');

    // "Stage all changes" must not look like it worked when it staged nothing.
    await expect(
      page.locator('lv-toast-container .toast', { hasText: 'Nothing to stage' }),
    ).toBeVisible();
    expect(await findCommand(page, 'stage_files')).toHaveLength(0);
  });

  test('a filtered stage-all counts what it staged, not what it showed', async ({ page }) => {
    // A conflicted file inside the filtered set is dropped before the backend
    // call, so counting the SHOWN files made the toast claim a file the
    // "conflicted file skipped" warning next to it says was left alone.
    await setupOpenRepository(
      page,
      withModifiedFiles([
        { path: 'src/utils/helper.ts', status: 'modified', isStaged: false, isConflicted: false },
        { path: 'src/utils/merge.ts', status: 'conflicted', isStaged: false, isConflicted: true },
        { path: 'README.md', status: 'modified', isStaged: false, isConflicted: false },
        { path: 'newfile.ts', status: 'untracked', isStaged: false, isConflicted: false },
      ])
    );

    await filterInput(page).fill('src/utils');
    await expect(rightPanel.getUnstagedFile('src/utils/helper.ts')).toBeVisible();
    await expect(rightPanel.getUnstagedFile('src/utils/merge.ts')).toBeVisible();
    await filterInput(page).blur();

    await startCommandCapture(page);
    await page.keyboard.press('s');

    await waitForCommand(page, 'stage_files');
    const args = (await findCommand(page, 'stage_files'))[0].args as { paths: string[] };
    expect(args.paths).toEqual(['src/utils/helper.ts']);

    await expect(
      page.locator('lv-toast-container .toast', { hasText: '1 conflicted file skipped' }),
    ).toBeVisible();
    await expect(
      page.locator('lv-toast-container .toast', { hasText: 'Staged 1 of 4 files' }),
    ).toBeVisible();
    await expect(
      page.locator('lv-toast-container .toast', { hasText: 'Staged 2 of 4 files' }),
    ).toHaveCount(0);
  });

  test('a filtered stage-all does not blame the filter for a skipped conflict', async ({
    page,
  }) => {
    // The filter shows every unstaged file, so it withholds nothing: the file
    // left unstaged was skipped by the conflict guard, which says so itself.
    // Claiming "the filter is hiding the rest" here contradicts that warning.
    await setupOpenRepository(
      page,
      withModifiedFiles([
        { path: 'src/utils/helper.ts', status: 'modified', isStaged: false, isConflicted: false },
        { path: 'src/utils/merge.ts', status: 'conflicted', isStaged: false, isConflicted: true },
      ])
    );

    await filterInput(page).fill('src/utils');
    await expect(rightPanel.getUnstagedFile('src/utils/helper.ts')).toBeVisible();
    await expect(rightPanel.getUnstagedFile('src/utils/merge.ts')).toBeVisible();
    await filterInput(page).blur();

    await startCommandCapture(page);
    await page.keyboard.press('s');

    await waitForCommand(page, 'stage_files');
    const args = (await findCommand(page, 'stage_files'))[0].args as { paths: string[] };
    expect(args.paths).toEqual(['src/utils/helper.ts']);

    await expect(
      page.locator('lv-toast-container .toast', { hasText: '1 conflicted file skipped' }),
    ).toBeVisible();
    await expect(
      page.locator('lv-toast-container .toast', { hasText: 'is hiding the rest' }),
    ).toHaveCount(0);
  });

  test('the filter works in tree view, keeping only ancestors of matches', async ({ page }) => {
    await page.locator('lv-file-status .view-toggle').click();
    await expect(page.locator('lv-file-status .folder-item')).not.toHaveCount(0);

    await filterInput(page).fill('helper');

    const folderNames = page.locator('lv-file-status .folder-item .folder-name');
    await expect(folderNames).toHaveText(['src', 'utils']);
    await expect(rightPanel.getUnstagedFile('src/utils/helper.ts')).toBeVisible();
    await expect(rightPanel.getUnstagedFile('src/main.ts')).toHaveCount(0);
  });
});
