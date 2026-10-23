import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCapture,
  findCommand,
  waitForCommand,
  injectCommandMock,
  injectCommandError,
  waitForRepositoryChanged,
} from '../fixtures/test-helpers';

/**
 * E2E tests for Interactive Rebase Dialog
 * Tests drag-drop reordering, action changes, preview, and execution
 */
test.describe('Interactive Rebase Dialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await injectCommandMock(page, {
      get_rebase_commits: {
        commits: [
        { oid: 'abc123', shortId: 'abc123', summary: 'First commit', author: 'Test', timestamp: Date.now() / 1000 },
        { oid: 'def456', shortId: 'def456', summary: 'Second commit', author: 'Test', timestamp: Date.now() / 1000 - 3600 },
        { oid: 'ghi789', shortId: 'ghi789', summary: 'Third commit', author: 'Test', timestamp: Date.now() / 1000 - 7200 },
        ],
        mergeCount: 0,
      },
      execute_interactive_rebase: null,
    });
  });

  test('should open dialog and show commits', async ({ page }) => {
    // Trigger opening the interactive rebase dialog from branch context menu
    const developBranch = page.locator('gn-branch-list li.branch-item[title*="feature"]');
    await developBranch.click({ button: 'right' });

    const rebaseMenuItem = page.locator('.context-menu-item', { hasText: 'Interactive rebase onto this' });
    await rebaseMenuItem.waitFor({ state: 'visible' });
    await rebaseMenuItem.click();

    // Dialog should open
    const dialog = page.locator('gn-interactive-rebase-dialog gn-modal[open]');
    await expect(dialog).toBeVisible();

    // Should show commits
    const commitRows = page.locator('gn-interactive-rebase-dialog .commit-row');
    await expect(commitRows).toHaveCount(3);
  });

  test('should show action dropdown for each commit', async ({ page }) => {
    // Open dialog
    const developBranch = page.locator('gn-branch-list li.branch-item[title*="feature"]');
    await developBranch.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Interactive rebase onto this' }).click();

    await page.locator('gn-interactive-rebase-dialog gn-modal[open]').waitFor({ state: 'visible' });

    // Each commit should have an action select
    const actionSelects = page.locator('gn-interactive-rebase-dialog .action-select');
    await expect(actionSelects).toHaveCount(3);

    // Default action should be 'pick'
    const firstSelect = actionSelects.first();
    await expect(firstSelect).toHaveValue('pick');
  });

  test('should change action and update preview', async ({ page }) => {
    // Open dialog
    const developBranch = page.locator('gn-branch-list li.branch-item[title*="feature"]');
    await developBranch.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Interactive rebase onto this' }).click();

    await page.locator('gn-interactive-rebase-dialog gn-modal[open]').waitFor({ state: 'visible' });

    // Change first commit action to 'drop'
    const firstSelect = page.locator('gn-interactive-rebase-dialog .action-select').first();
    await firstSelect.selectOption('drop');

    // Commit row should have 'action-drop' class
    const firstRow = page.locator('gn-interactive-rebase-dialog .commit-row').first();
    await expect(firstRow).toHaveClass(/action-drop/);

    // Stats should update to show 1 dropped
    await expect(page.locator('gn-interactive-rebase-dialog .stat', { hasText: 'Dropped' })).toBeVisible();
  });

  test('should show reword textarea when action is reword', async ({ page }) => {
    // Open dialog
    const developBranch = page.locator('gn-branch-list li.branch-item[title*="feature"]');
    await developBranch.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Interactive rebase onto this' }).click();

    await page.locator('gn-interactive-rebase-dialog gn-modal[open]').waitFor({ state: 'visible' });

    // Change first commit action to 'reword'
    const firstSelect = page.locator('gn-interactive-rebase-dialog .action-select').first();
    await firstSelect.selectOption('reword');

    // Reword textarea should appear
    const rewordInput = page.locator('gn-interactive-rebase-dialog .reword-input').first();
    await expect(rewordInput).toBeVisible();

    // Should be pre-filled with original message
    await expect(rewordInput).toHaveValue('First commit');
  });

  test('should allow editing reword message', async ({ page }) => {
    // Open dialog
    const developBranch = page.locator('gn-branch-list li.branch-item[title*="feature"]');
    await developBranch.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Interactive rebase onto this' }).click();

    await page.locator('gn-interactive-rebase-dialog gn-modal[open]').waitFor({ state: 'visible' });

    // Change to reword and edit message
    const firstSelect = page.locator('gn-interactive-rebase-dialog .action-select').first();
    await firstSelect.selectOption('reword');

    const rewordInput = page.locator('gn-interactive-rebase-dialog .reword-input').first();
    await rewordInput.fill('Updated commit message');

    await expect(rewordInput).toHaveValue('Updated commit message');
  });

  test('should toggle preview panel', async ({ page }) => {
    // Open dialog
    const developBranch = page.locator('gn-branch-list li.branch-item[title*="feature"]');
    await developBranch.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Interactive rebase onto this' }).click();

    await page.locator('gn-interactive-rebase-dialog gn-modal[open]').waitFor({ state: 'visible' });

    // Preview should be visible by default
    const previewSection = page.locator('gn-interactive-rebase-dialog .preview-section');
    await expect(previewSection).toBeVisible();

    // Click toggle button (use .first() to avoid shadow DOM slot duplication)
    const previewToggle = page.locator('gn-interactive-rebase-dialog .btn-small', { hasText: 'Preview' }).first();
    await previewToggle.click();

    // Preview should be hidden
    await expect(previewSection).not.toBeVisible();

    // Click again to show
    await previewToggle.click();
    await expect(previewSection).toBeVisible();
  });

  test('should show squash indicator in preview', async ({ page }) => {
    // Open dialog
    const developBranch = page.locator('gn-branch-list li.branch-item[title*="feature"]');
    await developBranch.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Interactive rebase onto this' }).click();

    await page.locator('gn-interactive-rebase-dialog gn-modal[open]').waitFor({ state: 'visible' });

    // Set second commit to squash
    const secondSelect = page.locator('gn-interactive-rebase-dialog .action-select').nth(1);
    await secondSelect.selectOption('squash');

    // Preview should show squash badge
    const squashBadge = page.locator('gn-interactive-rebase-dialog .squash-badge');
    await expect(squashBadge).toBeVisible();
    await expect(squashBadge).toContainText('+1 squashed');
  });

  test('should show error for orphaned squash', async ({ page }) => {
    // Open dialog
    const developBranch = page.locator('gn-branch-list li.branch-item[title*="feature"]');
    await developBranch.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Interactive rebase onto this' }).click();

    await page.locator('gn-interactive-rebase-dialog gn-modal[open]').waitFor({ state: 'visible' });

    // Set first commit to squash (orphaned - no commit before it)
    const firstSelect = page.locator('gn-interactive-rebase-dialog .action-select').first();
    await firstSelect.selectOption('squash');

    // Preview should show error
    const errorPreview = page.locator('gn-interactive-rebase-dialog .preview-commit.error');
    await expect(errorPreview).toBeVisible();

    // Start Rebase button should be disabled (use .first() to avoid shadow DOM slot duplication)
    const startButton = page.locator('gn-interactive-rebase-dialog .btn-primary', { hasText: 'Start Rebase' }).first();
    await expect(startButton).toBeDisabled();
  });

  test('should close dialog on Cancel', async ({ page }) => {
    // Open dialog
    const developBranch = page.locator('gn-branch-list li.branch-item[title*="feature"]');
    await developBranch.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Interactive rebase onto this' }).click();

    const dialog = page.locator('gn-interactive-rebase-dialog gn-modal[open]');
    await dialog.waitFor({ state: 'visible' });

    // Click Cancel (use .first() to avoid shadow DOM slot duplication)
    const cancelButton = page.locator('gn-interactive-rebase-dialog .btn-secondary', { hasText: 'Cancel' }).first();
    await cancelButton.click();

    // Dialog should close
    await expect(dialog).not.toBeVisible();
  });

  test('should execute rebase and invoke command', async ({ page }) => {
    await startCommandCapture(page);

    // Open dialog
    const developBranch = page.locator('gn-branch-list li.branch-item[title*="feature"]');
    await developBranch.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Interactive rebase onto this' }).click();

    await page.locator('gn-interactive-rebase-dialog gn-modal[open]').waitFor({ state: 'visible' });

    // Click Start Rebase (use .first() to avoid shadow DOM slot duplication)
    const startButton = page.locator('gn-interactive-rebase-dialog .btn-primary', { hasText: 'Start Rebase' }).first();
    await startButton.click();

    await waitForCommand(page, 'execute_interactive_rebase');

    const rebaseCommands = await findCommand(page, 'execute_interactive_rebase');
    expect(rebaseCommands.length).toBeGreaterThan(0);
  });

  test('should show stats for dropped and reworded commits', async ({ page }) => {
    // Open dialog
    const developBranch = page.locator('gn-branch-list li.branch-item[title*="feature"]');
    await developBranch.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Interactive rebase onto this' }).click();

    await page.locator('gn-interactive-rebase-dialog gn-modal[open]').waitFor({ state: 'visible' });

    // Drop first commit
    await page.locator('gn-interactive-rebase-dialog .action-select').first().selectOption('drop');

    // Reword second commit
    await page.locator('gn-interactive-rebase-dialog .action-select').nth(1).selectOption('reword');

    // Check stats
    await expect(page.locator('gn-interactive-rebase-dialog .stat', { hasText: 'Dropped' })).toContainText('1');
    await expect(page.locator('gn-interactive-rebase-dialog .stat', { hasText: 'Reworded' })).toContainText('1');
    await expect(page.locator('gn-interactive-rebase-dialog .stat', { hasText: 'Resulting' })).toContainText('2');
  });
});

test.describe('Interactive Rebase Autosquash', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await injectCommandMock(page, {
      get_rebase_commits: {
        commits: [
        { oid: 'abc123', shortId: 'abc123', summary: 'Add feature', author: 'Test', timestamp: Date.now() / 1000 },
        { oid: 'def456', shortId: 'def456', summary: 'fixup! Add feature', author: 'Test', timestamp: Date.now() / 1000 - 3600 },
        { oid: 'ghi789', shortId: 'ghi789', summary: 'Another commit', author: 'Test', timestamp: Date.now() / 1000 - 7200 },
        ],
        mergeCount: 0,
      },
      execute_interactive_rebase: null,
    });
  });

  test('should show autosquash banner when fixup! commits exist', async ({ page }) => {
    // Open dialog
    const developBranch = page.locator('gn-branch-list li.branch-item[title*="feature"]');
    await developBranch.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Interactive rebase onto this' }).click();

    await page.locator('gn-interactive-rebase-dialog gn-modal[open]').waitFor({ state: 'visible' });

    // Autosquash banner should be visible
    const banner = page.locator('gn-interactive-rebase-dialog .autosquash-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('fixup!');
  });

  test('should apply autosquash when button clicked', async ({ page }) => {
    // Open dialog
    const developBranch = page.locator('gn-branch-list li.branch-item[title*="feature"]');
    await developBranch.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Interactive rebase onto this' }).click();

    await page.locator('gn-interactive-rebase-dialog gn-modal[open]').waitFor({ state: 'visible' });

    // Click Apply Autosquash
    const applyButton = page.locator('gn-interactive-rebase-dialog .autosquash-banner button');
    await applyButton.click();

    // The fixup commit should now have action 'fixup'
    const actionSelects = page.locator('gn-interactive-rebase-dialog .action-select');

    // After autosquash, the fixup commit should be set to 'fixup' action
    // and reordered after its target
    const secondSelect = actionSelects.nth(1);
    await expect(secondSelect).toHaveValue('fixup');

    // Autosquash banner should be hidden after applying
    await expect(page.locator('gn-interactive-rebase-dialog .autosquash-banner')).not.toBeVisible();
  });
});

test.describe('Interactive Rebase - Event Propagation', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await injectCommandMock(page, {
      get_rebase_commits: {
        commits: [
        { oid: 'abc123', shortId: 'abc123', summary: 'First commit', author: 'Test', timestamp: Date.now() / 1000 },
        { oid: 'def456', shortId: 'def456', summary: 'Second commit', author: 'Test', timestamp: Date.now() / 1000 - 3600 },
        ],
        mergeCount: 0,
      },
      execute_interactive_rebase: null,
    });
  });

  test('should dispatch repository-changed event after executing rebase', async ({ page }) => {
    // Either refresh signal counts — the rebase dialog is owned by app-shell,
    // which refreshes directly rather than bubbling `repository-changed` up
    // from a sidebar component.
    const eventPromise = page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        const done = (): void => {
          document.removeEventListener('repository-changed', done);
          window.removeEventListener('repository-refresh', done);
          resolve(true);
        };
        document.addEventListener('repository-changed', done, { once: true });
        window.addEventListener('repository-refresh', done, { once: true });
        setTimeout(() => resolve(false), 5000);
      });
    });

    // Open dialog
    const developBranch = page.locator('gn-branch-list li.branch-item[title*="feature"]');
    await developBranch.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Interactive rebase onto this' }).click();

    await page.locator('gn-interactive-rebase-dialog gn-modal[open]').waitFor({ state: 'visible' });

    // Click Start Rebase button (use .first() to avoid shadow DOM slot duplication)
    const startButton = page.locator('gn-interactive-rebase-dialog button', { hasText: /start.*rebase/i }).first();
    await startButton.click();

    const eventReceived = await eventPromise;
    expect(eventReceived).toBe(true);
  });
});

test.describe('Interactive Rebase - Error Handling', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await injectCommandMock(page, {
      get_rebase_commits: {
        commits: [
        { oid: 'abc123', shortId: 'abc123', summary: 'First commit', author: 'Test', timestamp: Date.now() / 1000 },
        { oid: 'def456', shortId: 'def456', summary: 'Second commit', author: 'Test', timestamp: Date.now() / 1000 - 3600 },
        ],
        mergeCount: 0,
      },
      execute_interactive_rebase: { __error__: 'Rebase failed: conflicts detected' },
    });
  });

  test('should show error message in dialog when rebase fails', async ({ page }) => {
    // Open dialog
    const developBranch = page.locator('gn-branch-list li.branch-item[title*="feature"]');
    await developBranch.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Interactive rebase onto this' }).click();

    await page.locator('gn-interactive-rebase-dialog gn-modal[open]').waitFor({ state: 'visible' });

    // Click Start Rebase
    const startButton = page.locator('gn-interactive-rebase-dialog .btn-primary', { hasText: 'Start Rebase' }).first();
    await startButton.click();

    const errorInDialog = page.locator('gn-interactive-rebase-dialog .error-message, gn-interactive-rebase-dialog .error');
    const toastError = page.locator('gn-toast, .toast');

    await expect(errorInDialog.or(toastError).first()).toBeVisible();
  });

  test('should keep dialog open with entries when rebase fails', async ({ page }) => {
    // Open dialog
    const developBranch = page.locator('gn-branch-list li.branch-item[title*="feature"]');
    await developBranch.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Interactive rebase onto this' }).click();

    const dialog = page.locator('gn-interactive-rebase-dialog gn-modal[open]');
    await dialog.waitFor({ state: 'visible' });

    // Click Start Rebase
    const startButton = page.locator('gn-interactive-rebase-dialog .btn-primary', { hasText: 'Start Rebase' }).first();
    await startButton.click();

    // Dialog should remain open (not just toast visible)
    await expect(dialog).toBeVisible();

    // Commit rows should still be displayed so user can adjust and retry
    const commitRows = page.locator('gn-interactive-rebase-dialog .commit-row');
    await expect(commitRows).toHaveCount(2);
  });

  test('should not dispatch repository-changed event on failed rebase', async ({ page }) => {
    const eventPromise = page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        document.addEventListener('repository-changed', () => {
          resolve(true);
        }, { once: true });
        setTimeout(() => resolve(false), 2000);
      });
    });

    // Open dialog
    const developBranch = page.locator('gn-branch-list li.branch-item[title*="feature"]');
    await developBranch.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Interactive rebase onto this' }).click();

    await page.locator('gn-interactive-rebase-dialog gn-modal[open]').waitFor({ state: 'visible' });

    // Click Start Rebase (will fail)
    const startButton = page.locator('gn-interactive-rebase-dialog .btn-primary', { hasText: 'Start Rebase' }).first();
    await startButton.click();

    const eventReceived = await eventPromise;
    expect(eventReceived).toBe(false);
  });
});

test.describe('Interactive Rebase - Command Verification', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await injectCommandMock(page, {
      get_rebase_commits: {
        commits: [
        { oid: 'abc123', shortId: 'abc123', summary: 'First commit', author: 'Test', timestamp: Date.now() / 1000 },
        { oid: 'def456', shortId: 'def456', summary: 'Second commit', author: 'Test', timestamp: Date.now() / 1000 - 3600 },
        ],
        mergeCount: 0,
      },
      execute_interactive_rebase: null,
    });
  });

  test('should pass correct commit actions in rebase command', async ({ page }) => {
    await startCommandCapture(page);

    // Open dialog
    const developBranch = page.locator('gn-branch-list li.branch-item[title*="feature"]');
    await developBranch.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Interactive rebase onto this' }).click();

    await page.locator('gn-interactive-rebase-dialog gn-modal[open]').waitFor({ state: 'visible' });

    // Change first commit to 'drop'
    const firstSelect = page.locator('gn-interactive-rebase-dialog .action-select').first();
    await firstSelect.selectOption('drop');

    // Click Start Rebase
    const startButton = page.locator('gn-interactive-rebase-dialog .btn-primary', { hasText: 'Start Rebase' }).first();
    await startButton.click();

    await waitForCommand(page, 'execute_interactive_rebase');

    const rebaseCommands = await findCommand(page, 'execute_interactive_rebase');
    expect(rebaseCommands.length).toBeGreaterThan(0);

    // The command sends { path, onto, todo } where todo is a string like "drop abc123 First commit"
    const rebaseArgs = rebaseCommands[0].args as { path: string; onto: string; todo: string };
    expect(rebaseArgs?.todo).toBeDefined();
    // Verify the todo string contains 'drop' for the first commit we changed
    expect(rebaseArgs.todo).toContain('drop');
    expect(rebaseArgs.todo).toContain('abc123');
  });
});

test.describe('Interactive Rebase - Injected Error on Execute', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await injectCommandMock(page, {
      get_rebase_commits: {
        commits: [
        { oid: 'abc123', shortId: 'abc123', summary: 'First commit', author: 'Test', timestamp: Date.now() / 1000 },
        { oid: 'def456', shortId: 'def456', summary: 'Second commit', author: 'Test', timestamp: Date.now() / 1000 - 3600 },
        ],
        mergeCount: 0,
      },
      execute_interactive_rebase: null,
    });
  });

  test('should show error when execute_interactive_rebase fails', async ({ page }) => {
    // Open dialog
    const developBranch = page.locator('gn-branch-list li.branch-item[title*="feature"]');
    await developBranch.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Interactive rebase onto this' }).click();

    const dialog = page.locator('gn-interactive-rebase-dialog gn-modal[open]');
    await dialog.waitFor({ state: 'visible' });

    // Inject error AFTER dialog is open so get_rebase_commits still works
    await injectCommandError(page, 'execute_interactive_rebase', 'Rebase failed: merge conflict in src/main.ts');

    // Click Start Rebase - this should now fail
    const startButton = page.locator('gn-interactive-rebase-dialog .btn-primary', { hasText: 'Start Rebase' }).first();
    await startButton.click();

    // Verify error feedback is shown to the user (inline error or toast)
    const errorInDialog = page.locator('gn-interactive-rebase-dialog .error-message, gn-interactive-rebase-dialog .error');
    const toastError = page.locator('gn-toast, .toast');
    await expect(errorInDialog.or(toastError).first()).toBeVisible();

    // Dialog should remain open so the user can adjust and retry
    await expect(dialog).toBeVisible();

    // Verify the rebase entries are still shown (commit rows preserved)
    const commitRows = page.locator('gn-interactive-rebase-dialog .commit-row');
    await expect(commitRows).toHaveCount(2);

    // Verify action selects are still interactable (user can adjust and retry)
    const firstSelect = page.locator('gn-interactive-rebase-dialog .action-select').first();
    await expect(firstSelect).toBeVisible();
    await expect(firstSelect).toBeEnabled();
  });
});
