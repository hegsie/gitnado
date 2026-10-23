import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
  injectCommandMock,
  injectCommandError,
  openViaCommandPalette,
  autoConfirmDialogs,
} from '../fixtures/test-helpers';

async function openSubmoduleDialog(page: import('@playwright/test').Page): Promise<void> {
  await openViaCommandPalette(page, 'submodule');
  await page.locator('gn-submodule-dialog .dialog-overlay').waitFor({ state: 'visible', timeout: 3000 });
}

test.describe('Submodule Dialog - List View', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await injectCommandMock(page, {
      get_submodules: [
        { name: 'lib/utils', path: 'lib/utils', url: 'https://github.com/user/utils.git', headOid: 'abc123', branch: 'main', initialized: true, status: 'current' },
        { name: 'vendor/plugin', path: 'vendor/plugin', url: 'https://github.com/vendor/plugin.git', headOid: 'def456', branch: 'main', initialized: true, status: 'modified' },
      ],
      add_submodule: { success: true },
      init_submodules: { success: true },
      update_submodules: { success: true },
      remove_submodule: { success: true },
    });
  });

  test('should open submodule dialog from command palette', async ({ page }) => {
    await openSubmoduleDialog(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');
    await expect(dialog).toBeVisible();
  });

  test('should display list of submodules', async ({ page }) => {
    await openSubmoduleDialog(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');

    await expect(dialog.locator('.submodule-name', { hasText: 'lib/utils' })).toBeVisible();
    await expect(dialog.locator('.submodule-name', { hasText: 'vendor/plugin' })).toBeVisible();
  });

  test('should show submodule name and path', async ({ page }) => {
    await openSubmoduleDialog(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');

    await expect(dialog.locator('.submodule-name', { hasText: 'lib/utils' })).toBeVisible();
    await expect(dialog.locator('.submodule-path', { hasText: 'lib/utils' })).toBeVisible();
    await expect(dialog.locator('.submodule-name', { hasText: 'vendor/plugin' })).toBeVisible();
    await expect(dialog.locator('.submodule-path', { hasText: 'vendor/plugin' })).toBeVisible();
  });

  test('should show status badges for submodules', async ({ page }) => {
    await openSubmoduleDialog(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');

    // Status badges use class "submodule-status" with status-specific classes
    const statusBadges = dialog.locator('.submodule-status');
    await expect(statusBadges).toHaveCount(2);

    // Verify status text is rendered
    await expect(dialog.locator('.submodule-status', { hasText: 'Up to date' })).toBeVisible();
    await expect(dialog.locator('.submodule-status', { hasText: 'Modified' })).toBeVisible();
  });

  test('should have Add Submodule button', async ({ page }) => {
    await openSubmoduleDialog(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');
    const addButton = dialog.locator('button', { hasText: /Add Submodule/i });
    await expect(addButton).toBeVisible();
  });

  test('should have Update All button when multiple submodules exist', async ({ page }) => {
    await openSubmoduleDialog(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');

    const updateAllButton = dialog.locator('.bulk-actions button', { hasText: /Update All/i });
    await expect(updateAllButton).toBeVisible();
  });

  test('should have action buttons for each submodule', async ({ page }) => {
    await openSubmoduleDialog(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');

    await expect(dialog.locator('.submodule-name', { hasText: 'lib/utils' })).toBeVisible();

    // Action buttons use title attributes: "Update" (for initialized) and "Remove"
    const updateButtons = dialog.locator('.submodule-actions button[title="Update"]');
    const removeButtons = dialog.locator('.submodule-actions button[title="Remove"]');

    // Both submodules are initialized, so each should have Update and Remove buttons
    await expect(updateButtons).toHaveCount(2);
    await expect(removeButtons).toHaveCount(2);
  });
});

test.describe('Submodule Dialog - Add Submodule', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await injectCommandMock(page, {
      get_submodules: [],
      add_submodule: { success: true },
    });
  });

  test('clicking Add Submodule should show add form', async ({ page }) => {
    await openSubmoduleDialog(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');
    const addButton = dialog.locator('button', { hasText: /Add Submodule/i });
    await addButton.click();

    // Add form has inputs with specific placeholders
    const urlInput = dialog.locator('input[placeholder*="github"]');
    await expect(urlInput).toBeVisible();

    const pathInput = dialog.locator('input[placeholder*="lib"]');
    await expect(pathInput).toBeVisible();
  });

  test('add form should have optional branch field', async ({ page }) => {
    await openSubmoduleDialog(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');
    const addButton = dialog.locator('button', { hasText: /Add Submodule/i });
    await addButton.click();

    // Branch field has placeholder "main"
    const branchInput = dialog.locator('input[placeholder="main"]');
    await expect(branchInput).toBeVisible();
  });

  test('add form should have Cancel button', async ({ page }) => {
    await openSubmoduleDialog(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');
    const addButton = dialog.locator('button', { hasText: /Add Submodule/i });
    await addButton.click();

    const cancelButton = dialog.locator('button', { hasText: /Cancel/i });
    await expect(cancelButton).toBeVisible();
  });
});

test.describe('Submodule Dialog - Empty State', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await injectCommandMock(page, {
      get_submodules: [],
    });
  });

  test('should show empty state when no submodules', async ({ page }) => {
    await openSubmoduleDialog(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');

    const emptyState = dialog.locator('.empty-state');
    await expect(emptyState).toBeVisible();
    await expect(emptyState.getByText('No submodules')).toBeVisible();
  });
});

test.describe('Submodule Dialog - Update Operations', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await injectCommandMock(page, {
      get_submodules: [
        { name: 'lib/utils', path: 'lib/utils', url: 'https://github.com/user/utils.git', headOid: null, branch: null, initialized: false, status: 'uninitialized' },
      ],
      init_submodules: { success: true },
      update_submodules: { success: true },
    });
  });

  test('should show Initialize button for uninitialized submodules', async ({ page }) => {
    await openSubmoduleDialog(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');

    // Uninitialized submodules get a button with title="Initialize"
    const initButton = dialog.locator('.submodule-actions button[title="Initialize"]');
    await expect(initButton).toBeVisible();
  });

  test('clicking Update should invoke update_submodules command', async ({ page }) => {
    // Use initialized submodule so the Update button appears
    await injectCommandMock(page, {
      get_submodules: [
        { name: 'lib/utils', path: 'lib/utils', url: 'https://github.com/user/utils.git', headOid: 'abc123', branch: 'main', initialized: true, status: 'modified' },
      ],
      update_submodules: { success: true },
    });

    await openSubmoduleDialog(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');

    await startCommandCaptureWithMocks(page, {
      get_submodules: [
        { name: 'lib/utils', path: 'lib/utils', url: 'https://github.com/user/utils.git', headOid: 'abc123', branch: 'main', initialized: true, status: 'modified' },
      ],
      update_submodules: { success: true },
    });

    const updateButton = dialog.locator('.submodule-actions button[title="Update"]');
    await expect(updateButton).toBeVisible();
    await updateButton.click();

    await waitForCommand(page, 'update_submodules');

    const updateCommands = await findCommand(page, 'update_submodules');
    expect(updateCommands.length).toBeGreaterThan(0);

    // Verify the submodule dialog is still visible after update operation
    await expect(page.locator('gn-submodule-dialog .dialog')).toBeVisible();
  });
});

test.describe('Submodule Dialog - Add Submodule E2E', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('add submodule should invoke add_submodule command with correct args', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      get_submodules: [],
      add_submodule: null,
    });

    await openSubmoduleDialog(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');
    const addButton = dialog.locator('.dialog-footer button', { hasText: /Add Submodule/i });
    await addButton.click();

    // Fill in the URL
    const urlInput = dialog.locator('input[placeholder*="github"]');
    await urlInput.fill('https://github.com/test/submod.git');

    // Fill in the path
    const pathInput = dialog.locator('input[placeholder*="lib"]');
    await pathInput.fill('lib/submod');

    // Click the Add Submodule button in add mode footer
    const saveButton = dialog.locator('.dialog-footer-right button', { hasText: /Add Submodule/i });
    await saveButton.click();

    await waitForCommand(page, 'add_submodule');

    const addCommands = await findCommand(page, 'add_submodule');
    expect(addCommands.length).toBeGreaterThan(0);

    const args = addCommands[0].args as Record<string, unknown>;
    const argsStr = JSON.stringify(args);
    expect(argsStr).toContain('https://github.com/test/submod.git');

    // Verify the submodule dialog is still visible after adding (returns to list view)
    await expect(page.locator('gn-submodule-dialog .dialog')).toBeVisible();
  });

  test('update submodule should invoke update_submodules command', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      get_submodules: [
        { name: 'lib/utils', path: 'lib/utils', url: 'https://github.com/user/utils.git', headOid: 'abc123', branch: 'main', initialized: true, status: 'modified' },
      ],
      update_submodules: { success: true },
    });

    await openSubmoduleDialog(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');

    const updateButton = dialog.locator('.submodule-actions button[title="Update"]');
    await expect(updateButton).toBeVisible();
    await updateButton.click();

    await waitForCommand(page, 'update_submodules');

    const updateCommands = await findCommand(page, 'update_submodules');
    expect(updateCommands.length).toBeGreaterThan(0);

    // Verify the submodule dialog is still visible after update operation
    await expect(page.locator('gn-submodule-dialog .dialog')).toBeVisible();
  });

  test('add submodule failure should show error message', async ({ page }) => {
    await injectCommandError(page, 'add_submodule', 'Failed to clone submodule: repository not found');

    await injectCommandMock(page, {
      get_submodules: [],
    });

    await openSubmoduleDialog(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');
    const addButton = dialog.locator('.dialog-footer button', { hasText: /Add Submodule/i });
    await addButton.click();

    // Fill in URL and path (both required for the Add button to be enabled)
    const urlInput = dialog.locator('input[placeholder*="github"]');
    await urlInput.fill('https://github.com/invalid/nonexistent.git');

    const pathInput = dialog.locator('input[placeholder*="lib"]');
    await pathInput.fill('lib/bad');

    const saveButton = dialog.locator('.dialog-footer-right button', { hasText: /Add Submodule/i });
    await saveButton.click();

    // The component shows errors as .message.error inside the dialog
    const errorMessage = dialog.locator('.message.error');
    await expect(errorMessage).toBeVisible({ timeout: 3000 });
  });

  test('init submodules should invoke init_submodules command', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      get_submodules: [
        { name: 'lib/utils', path: 'lib/utils', url: 'https://github.com/user/utils.git', headOid: null, branch: null, initialized: false, status: 'uninitialized' },
      ],
      init_submodules: null,
      update_submodules: null,
    });

    await openSubmoduleDialog(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');

    const initButton = dialog.locator('.submodule-actions button[title="Initialize"]');
    await expect(initButton).toBeVisible();
    await initButton.click();

    await waitForCommand(page, 'init_submodules');

    const initCommands = await findCommand(page, 'init_submodules');
    expect(initCommands.length).toBeGreaterThan(0);

    // Verify the submodule dialog is still visible after initialization
    await expect(page.locator('gn-submodule-dialog .dialog')).toBeVisible();
  });
});

test.describe('Submodule Error Scenarios', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('should show error when add_submodule fails', async ({ page }) => {
    await injectCommandMock(page, {
      get_submodules: [],
    });

    await injectCommandError(page, 'add_submodule', 'Failed to add submodule: repository not found');

    await openSubmoduleDialog(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');
    const addButton = dialog.locator('.dialog-footer button', { hasText: /Add Submodule/i });
    await addButton.click();

    const urlInput = dialog.locator('input[placeholder*="github"]');
    await urlInput.fill('https://github.com/invalid/nonexistent.git');

    const pathInput = dialog.locator('input[placeholder*="lib"]');
    await pathInput.fill('lib/bad');

    const saveButton = dialog.locator('.dialog-footer-right button', { hasText: /Add Submodule/i });
    await saveButton.click();

    // The component shows errors inline as .message.error
    await expect(dialog.locator('.message.error')).toBeVisible({ timeout: 5000 });
  });

  test('should show error when update_submodules fails', async ({ page }) => {
    await injectCommandMock(page, {
      get_submodules: [
        { name: 'lib/utils', path: 'lib/utils', url: 'https://github.com/user/utils.git', headOid: 'abc123', branch: 'main', initialized: true, status: 'modified' },
      ],
    });

    await injectCommandError(page, 'update_submodules', 'Failed to update submodules: network error');

    await openSubmoduleDialog(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');
    const updateButton = dialog.locator('.submodule-actions button[title="Update"]');
    await expect(updateButton).toBeVisible();
    await updateButton.click();

    // The component shows errors inline as .message.error
    await expect(dialog.locator('.message.error')).toBeVisible({ timeout: 5000 });
  });

  test('should show error when remove_submodule fails', async ({ page }) => {
    await injectCommandMock(page, {
      get_submodules: [
        { name: 'lib/utils', path: 'lib/utils', url: 'https://github.com/user/utils.git', headOid: 'abc123', branch: 'main', initialized: true, status: 'current' },
      ],
    });

    await injectCommandError(page, 'remove_submodule', 'Failed to remove submodule: permission denied');

    await openSubmoduleDialog(page);

    // Mock the Tauri confirm dialog used by showConfirm() in handleRemove
    await autoConfirmDialogs(page);

    const dialog = page.locator('gn-submodule-dialog .dialog');

    const removeButton = dialog.locator('.submodule-actions button[title="Remove"]');
    await expect(removeButton).toBeVisible();
    await removeButton.click();

    // The component shows errors inline as .message.error
    await expect(dialog.locator('.message.error')).toBeVisible({ timeout: 5000 });
  });
});
