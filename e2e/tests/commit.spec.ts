import { test, expect } from '@playwright/test';
import { setupOpenRepository, withStagedFiles } from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';
import { RightPanelPage } from '../pages/panels.page';
import {
  startCommandCapture,
  findCommand,
  injectCommandError,
  injectCommandMock,
  waitForRepositoryChanged,
  waitForCommand,
} from '../fixtures/test-helpers';

test.describe('Commit Workflow', () => {
  let app: AppPage;
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
        { path: 'README.md', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );
  });

  test('should show commit panel with staged files', async () => {
    await expect(rightPanel.commitPanel).toBeVisible();
    const stagedCount = await rightPanel.getStagedCount();
    expect(stagedCount).toBe(2);
  });

  test('should enable commit button when message is entered and files are staged', async () => {
    // Commit button should be disabled when message is empty
    await expect(rightPanel.commitButton).toBeDisabled();

    await rightPanel.commitMessage.fill('feat: add new feature');

    // With staged files and a message, commit button should be enabled
    await expect(rightPanel.commitButton).toBeEnabled();
  });

  test('should accept multi-line commit messages', async () => {
    const message = 'feat: add new feature\n\nThis is the body of the commit message.\n\n- Point 1\n- Point 2';
    await rightPanel.commitMessage.fill(message);
    await expect(rightPanel.commitMessage).toHaveValue(message);
  });

});

test.describe('Commit Message Validation', () => {
  let app: AppPage;
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([{ path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false }])
    );
  });

  test('should allow conventional commit format', async () => {
    await rightPanel.commitMessage.fill('feat(scope): add new feature');
    await expect(rightPanel.commitMessage).toHaveValue('feat(scope): add new feature');
  });

  test('should allow fix commit type', async () => {
    await rightPanel.commitMessage.fill('fix: resolve bug in parser');
    await expect(rightPanel.commitMessage).toHaveValue('fix: resolve bug in parser');
  });

  test('should allow chore commit type', async () => {
    await rightPanel.commitMessage.fill('chore: update dependencies');
    await expect(rightPanel.commitMessage).toHaveValue('chore: update dependencies');
  });

  test('should allow docs commit type', async () => {
    await rightPanel.commitMessage.fill('docs: update README');
    await expect(rightPanel.commitMessage).toHaveValue('docs: update README');
  });
});

test.describe('Commit Without Staged Files', () => {
  let app: AppPage;
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page, {
      status: { staged: [], unstaged: [{ path: 'file.ts', status: 'modified', isStaged: false, isConflicted: false }] },
    });
  });

  test('should show commit panel', async () => {
    await expect(rightPanel.commitPanel).toBeVisible();
  });

  test('should show commit message area', async () => {
    await expect(rightPanel.commitMessage).toBeVisible();
  });

  test('should have no staged files', async () => {
    const count = await rightPanel.getStagedCount();
    expect(count).toBe(0);
  });
});

test.describe('AI Commit Message Generation', () => {
  let app: AppPage;
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([{ path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false }])
    );
  });

  test('should have AI generate button visible', async () => {
    await expect(rightPanel.aiGenerateButton).toBeVisible();
  });

  test('AI button should be clickable', async () => {
    await expect(rightPanel.aiGenerateButton).toBeEnabled();
  });
});

test.describe('Commit Details Tab', () => {
  let app: AppPage;
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(page);
  });

  test('should have Details tab', async () => {
    await expect(rightPanel.detailsTab).toBeVisible();
  });

  test('should switch to Details tab when clicked', async () => {
    await rightPanel.switchToDetails();
    await expect(rightPanel.commitDetails).toBeVisible();
  });

  test('should switch back to Changes tab', async () => {
    await rightPanel.switchToDetails();
    await rightPanel.switchToChanges();
    await expect(rightPanel.fileStatus).toBeVisible();
  });
});

test.describe('Commit - Event Propagation', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );

    await injectCommandMock(page, { create_commit: 'new-commit-sha-123' });
  });

  test('should dispatch repository-changed event after successful commit', async ({ page }) => {
    const eventPromise = page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        document.addEventListener('repository-changed', () => {
          resolve(true);
        }, { once: true });
        setTimeout(() => resolve(false), 3000);
      });
    });

    await rightPanel.commitMessage.fill('test: add propagation test');
    await rightPanel.commitButton.click();

    const eventReceived = await eventPromise;
    expect(eventReceived).toBe(true);
  });
});

test.describe('Commit - Error Handling', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );
  });

  test('should preserve message, staged files, and show error after failed commit', async ({ page }) => {
    await injectCommandError(page, 'create_commit', 'Commit failed: empty tree');

    // Verify initial staged file count
    const initialStaged = await rightPanel.getStagedCount();
    expect(initialStaged).toBe(1);

    await rightPanel.commitMessage.fill('test: should persist after failure');
    await rightPanel.commitButton.click();

    // Verify error feedback is visible
    const errorFeedback = page.locator('gn-commit-panel .error').or(page.locator('.toast.error'));
    await expect(errorFeedback.first()).toBeVisible({ timeout: 5000 });
    await expect(errorFeedback.first()).toContainText(/Commit failed|empty tree/i);

    // Verify commit message is preserved so user can fix and retry
    await expect(rightPanel.commitMessage).toHaveValue('test: should persist after failure');

    // Verify staged files are still present after failed commit
    const finalStaged = await rightPanel.getStagedCount();
    expect(finalStaged).toBe(1);

    // Verify commit button is still enabled (user can retry)
    await expect(rightPanel.commitButton).toBeEnabled();
  });

  test('should not dispatch repository-changed event on failed commit', async ({ page }) => {
    await injectCommandError(page, 'create_commit', 'Commit failed: nothing to commit');

    const eventReceived = await waitForRepositoryChanged(page, async () => {
      await rightPanel.commitMessage.fill('test: should fail');
      await rightPanel.commitButton.click();
    }, 1500);

    expect(eventReceived).toBe(false);
  });

  test('should show error feedback when commit fails due to hook', async ({ page }) => {
    await injectCommandError(page, 'create_commit', 'pre-commit hook failed: linting errors found');

    await rightPanel.commitMessage.fill('feat: add new module');
    await rightPanel.commitButton.click();

    // Verify error feedback is visible in the commit panel
    const inlineError = page.locator('gn-commit-panel .error');
    const toast = page.locator('.toast.error, .toast-error, .toast');
    await expect(inlineError.or(toast).first()).toBeVisible({ timeout: 5000 });

    // Verify the error contains the hook failure reason
    await expect(inlineError.or(toast).first()).toContainText(/pre-commit hook failed|linting errors/i);

    // Verify the commit message is preserved so the user can retry after fixing the hook issue
    await expect(rightPanel.commitMessage).toHaveValue('feat: add new module');

    // Verify staged files are still present (not cleared on failure)
    const stagedCount = await rightPanel.getStagedCount();
    expect(stagedCount).toBe(1);
  });
});

test.describe('Commit - Button State', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
      ])
    );
  });

  test('should disable commit button when message is empty', async () => {
    await rightPanel.commitMessage.fill('');

    await expect(rightPanel.commitButton).toBeDisabled();
  });

  test('should enable commit button when message is entered with staged files', async () => {
    await rightPanel.commitMessage.fill('feat: add new feature');

    await expect(rightPanel.commitButton).toBeEnabled();
  });

  test('should commit and update all UI: clear message, reset staged files, show success', async ({ page }) => {
    // Verify initial state: 1 staged file, button disabled without message
    const initialStaged = await rightPanel.getStagedCount();
    expect(initialStaged).toBe(1);
    await expect(rightPanel.commitButton).toBeDisabled();

    await startCommandCapture(page);

    await rightPanel.commitMessage.fill('feat: test commit message');
    await expect(rightPanel.commitButton).toBeEnabled();
    await rightPanel.commitButton.click();

    await waitForCommand(page, 'create_commit');

    const commitCommands = await findCommand(page, 'create_commit');
    expect(commitCommands.length).toBeGreaterThan(0);
    expect((commitCommands[0].args as { message?: string })?.message).toContain('feat: test commit message');

    // Verify UI: staged files should be cleared after successful commit
    const stagedCount = await rightPanel.getStagedCount();
    expect(stagedCount).toBe(0);

    // Verify UI: commit message should be cleared
    await expect(rightPanel.commitMessage).toHaveValue('');

    // Verify UI: commit button should be disabled again (no staged files, no message)
    await expect(rightPanel.commitButton).toBeDisabled();
  });
});

test.describe('Commit - UI Outcome Verification', () => {
  let rightPanel: RightPanelPage;

  test.beforeEach(async ({ page }) => {
    rightPanel = new RightPanelPage(page);
    await setupOpenRepository(
      page,
      withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
        { path: 'src/utils.ts', status: 'added', isStaged: true, isConflicted: false },
      ])
    );
  });

  test('should reset staged files and clear message after successful commit', async ({ page }) => {
    // Verify initial staged files
    const initialStaged = await rightPanel.getStagedCount();
    expect(initialStaged).toBe(2);

    // Fill in a commit message and commit
    await rightPanel.commitMessage.fill('feat: add utility module');
    await rightPanel.commitButton.click();

    // Wait for commit to complete (staged files should clear)
    await page.waitForFunction(() => {
      const stagedHeader = document.querySelector('gn-file-status .section-header');
      // Either the staged section is gone or the count reads 0
      if (!stagedHeader) return true;
      const countEl = stagedHeader.querySelector('.section-count');
      return countEl?.textContent?.trim() === '0' || !countEl;
    });

    // Verify staged files list is empty
    const finalStaged = await rightPanel.getStagedCount();
    expect(finalStaged).toBe(0);

    // Verify commit message textarea is cleared
    await expect(rightPanel.commitMessage).toHaveValue('');
  });

  test('should populate previous commit message when amend is toggled on', async ({ page }) => {
    // The amend checkbox is inside gn-commit-panel
    const amendCheckbox = page.locator('gn-commit-panel .amend-toggle input[type="checkbox"]');
    await expect(amendCheckbox).toBeVisible();

    // Toggle amend on
    await amendCheckbox.check();

    // After toggling amend, the summary field should be populated with the last commit's summary.
    // The mock's get_commit_history returns commits with summary "Initial commit" as the first entry.
    await expect(rightPanel.commitMessage).not.toHaveValue('');

    // Now perform the amend commit
    await rightPanel.commitButton.click();

    // After successful amend, the amend checkbox should be unchecked
    await expect(amendCheckbox).not.toBeChecked();

    // The commit message area should be cleared after successful commit
    await expect(rightPanel.commitMessage).toHaveValue('');
  });

  test('should disable commit button when message is empty', async () => {
    // Ensure the message field is empty
    await rightPanel.commitMessage.fill('');

    // Verify the commit button is disabled
    await expect(rightPanel.commitButton).toBeDisabled();
  });

  test('should keep commit button disabled for whitespace-only message', async () => {
    // Try committing with whitespace-only message
    await rightPanel.commitMessage.fill('   ');

    // Verify the commit button is disabled (empty/whitespace messages should not be committable)
    await expect(rightPanel.commitButton).toBeDisabled();
  });
});
