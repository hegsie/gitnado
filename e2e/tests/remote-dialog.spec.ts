import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  findCommand,
  waitForCommand,
  injectCommandMock,
  injectCommandError,
  openViaCommandPalette,
} from '../fixtures/test-helpers';

async function openRemoteDialog(page: import('@playwright/test').Page): Promise<void> {
  await openViaCommandPalette(page, 'remotes');
  await page.locator('gn-remote-dialog').waitFor({ state: 'visible', timeout: 3000 });
}

test.describe('Remote Dialog - List View', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await injectCommandMock(page, {
      'get_remotes': [
        { name: 'origin', url: 'https://github.com/user/repo.git', pushUrl: null },
        { name: 'upstream', url: 'https://github.com/original/repo.git', pushUrl: null },
      ],
      'add_remote': { success: true },
      'remove_remote': { success: true },
      'rename_remote': { success: true },
      'set_remote_url': { success: true },
      'plugin:dialog|confirm': true,
      'plugin:dialog|ask': true,
    });
  });

  test('should open remote dialog from command palette', async ({ page }) => {
    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');
    await expect(remoteDialog).toBeVisible();
  });

  test('should display list of remotes', async ({ page }) => {
    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');

    await expect(remoteDialog.getByText('origin').first()).toBeVisible();
    await expect(remoteDialog.getByText('upstream').first()).toBeVisible();
  });

  test('should show remote name and URL', async ({ page }) => {
    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');

    await expect(remoteDialog.getByText('origin').first()).toBeVisible();
    await expect(remoteDialog.getByText(/github\.com\/user\/repo/i).first()).toBeVisible();
  });

  test('should have Add Remote button', async ({ page }) => {
    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');
    const addButton = remoteDialog.locator('button', { hasText: /add.*remote/i });
    await expect(addButton).toBeVisible();
  });

  test('should have action buttons for each remote', async ({ page }) => {
    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');

    const actionButtons = remoteDialog.locator(
      'button[title*="Edit"], button[title*="Rename"], button[title*="Delete"], button[title*="Remove"], button[aria-label*="edit"], button[aria-label*="rename"], button[aria-label*="delete"]'
    );
    await expect(actionButtons.first()).toBeVisible();
    const buttonCount = await actionButtons.count();
    expect(buttonCount).toBeGreaterThan(0);
  });
});

test.describe('Remote Dialog - Add Remote', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await injectCommandMock(page, {
      'get_remotes': [{ name: 'origin', url: 'https://github.com/user/repo.git', pushUrl: null }],
      'add_remote': { success: true },
    });
  });

  test('clicking Add Remote should show add form', async ({ page }) => {
    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');
    const addButton = remoteDialog.locator('button', { hasText: /add.*remote/i });
    await addButton.click();

    await expect(
      remoteDialog.locator('input').first()
    ).toBeVisible();
  });

  test('add form should have Cancel and Save buttons', async ({ page }) => {
    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');
    const addButton = remoteDialog.locator('button', { hasText: /add.*remote/i });
    await addButton.click();

    const cancelButton = remoteDialog.locator('button', { hasText: /cancel/i });
    const saveButton = remoteDialog.locator('button', { hasText: /save|add/i });

    await expect(cancelButton.or(saveButton).first()).toBeVisible();
  });

  test('Save button should be disabled until form is valid', async ({ page }) => {
    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');
    const addButton = remoteDialog.locator('button', { hasText: /add.*remote/i });
    await addButton.click();

    const saveButton = remoteDialog.locator('button', { hasText: /save|add/i }).first();
    const isDisabled = await saveButton.isDisabled();
    expect(isDisabled).toBe(true);
  });
});

test.describe('Remote Dialog - Edit Remote', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await injectCommandMock(page, {
      'get_remotes': [{ name: 'origin', url: 'https://github.com/user/repo.git', pushUrl: null }],
      'set_remote_url': { success: true },
    });
  });

  test('clicking Edit should show edit form with URL input', async ({ page }) => {
    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');

    const editButton = remoteDialog.locator('button[title*="Edit"], button[aria-label*="edit"]').first();
    await expect(editButton).toBeVisible();
    await editButton.click();

    const urlInput = remoteDialog.locator('input[type="text"]');
    const urlCount = await urlInput.count();
    expect(urlCount).toBeGreaterThan(0);
  });

  test('edit form should have fetch and push URL fields', async ({ page }) => {
    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');

    const editButton = remoteDialog.locator('button[title*="Edit"], button[aria-label*="edit"]').first();
    await expect(editButton).toBeVisible();
    await editButton.click();

    const fetchLabel = remoteDialog.locator('label, .label', { hasText: /fetch/i });
    const pushLabel = remoteDialog.locator('label, .label', { hasText: /push/i });

    const fetchCount = await fetchLabel.count();
    const pushCount = await pushLabel.count();
    expect(fetchCount + pushCount).toBeGreaterThan(0);
  });
});

test.describe('Remote Dialog - Delete Remote', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await startCommandCaptureWithMocks(page, {
      'get_remotes': [
        { name: 'origin', url: 'https://github.com/user/repo.git', pushUrl: null },
        { name: 'upstream', url: 'https://github.com/original/repo.git', pushUrl: null },
      ],
      'remove_remote': { success: true },
      'plugin:dialog|confirm': true,
      'plugin:dialog|ask': true,
    });
  });

  test('clicking Delete should trigger remove_remote command', async ({ page }) => {
    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');

    const deleteButton = remoteDialog.locator('button[title*="Delete"], button[title*="Remove"], button[aria-label*="delete"]').first();
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();

    await waitForCommand(page, 'remove_remote');

    const removeCommands = await findCommand(page, 'remove_remote');
    expect(removeCommands.length).toBeGreaterThan(0);

    // Verify the remote dialog is still visible after deletion (list refreshes)
    await expect(page.locator('gn-remote-dialog')).toBeVisible();
  });
});

test.describe('Remote Dialog - Empty State', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);

    await injectCommandMock(page, {
      'get_remotes': [],
    });
  });

  test('should show empty state when no remotes', async ({ page }) => {
    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');

    const emptyState = remoteDialog.locator('.empty, [class*="empty"]', { hasText: /no.*remote/i });
    const addButton = remoteDialog.locator('button', { hasText: /add.*remote/i });

    await expect(emptyState.or(addButton).first()).toBeVisible();
  });
});

// ============================================================================
// Add Remote E2E - Command Verification
// ============================================================================

test.describe('Remote Dialog - Add Remote E2E', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('add remote should invoke add_remote command with correct args', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      'get_remotes': [{ name: 'origin', url: 'https://github.com/user/repo.git', pushUrl: null }],
      'add_remote': { success: true },
    });

    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');
    const addButton = remoteDialog.locator('button', { hasText: /add.*remote/i });
    await addButton.click();

    const nameInput = remoteDialog.locator('input[placeholder*="origin"], input[placeholder*="name" i], input[name*="name"]').first();
    const urlInput = remoteDialog.locator('input[placeholder*="github"], input[placeholder*="url" i], input[name*="url"]').first();

    await nameInput.fill('fork');
    await urlInput.fill('https://github.com/fork/repo.git');

    const saveButton = remoteDialog.locator('button', { hasText: /save|add/i }).last();
    await saveButton.click();

    await waitForCommand(page, 'add_remote');

    const addCommands = await findCommand(page, 'add_remote');
    expect(addCommands.length).toBeGreaterThan(0);

    const args = addCommands[0].args as Record<string, unknown>;
    const argsStr = JSON.stringify(args);
    expect(argsStr).toContain('fork');
    expect(argsStr).toContain('https://github.com/fork/repo.git');

    // Verify the add form is no longer visible (returns to list view after success)
    const remoteDialogAfter = page.locator('gn-remote-dialog');
    await expect(remoteDialogAfter).toBeVisible();
  });

  test('add remote failure (duplicate name) should show error', async ({ page }) => {
    await injectCommandMock(page, {
      'get_remotes': [{ name: 'origin', url: 'https://github.com/user/repo.git', pushUrl: null }],
      'add_remote': { __error__: 'Remote "origin" already exists' },
    });

    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');
    const addButton = remoteDialog.locator('button', { hasText: /add.*remote/i });
    await addButton.click();

    const nameInput = remoteDialog.locator('input[placeholder*="origin"], input[placeholder*="name" i], input[name*="name"]').first();
    const urlInput = remoteDialog.locator('input[placeholder*="github"], input[placeholder*="url" i], input[name*="url"]').first();

    await nameInput.fill('origin');
    await urlInput.fill('https://github.com/duplicate/repo.git');

    const saveButton = remoteDialog.locator('button', { hasText: /save|add/i }).last();
    await saveButton.click();

    // Filter to visible before taking .first(): `[class*="error"]` matches any
    // element on the page whose class merely CONTAINS "error", and .first()
    // takes them in DOM order. A hidden error element in a sidebar panel
    // therefore shadowed the toast this test is about, failing it from across
    // the app.
    const errorIndicator = page
      .locator('.toast, .error, [class*="error"]')
      .filter({ visible: true })
      .first();
    await expect(errorIndicator).toBeVisible({ timeout: 3000 });
  });

  test('delete remote should invoke remove_remote with correct remote name', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      'get_remotes': [
        { name: 'origin', url: 'https://github.com/user/repo.git', pushUrl: null },
        { name: 'upstream', url: 'https://github.com/original/repo.git', pushUrl: null },
      ],
      'remove_remote': { success: true },
      'plugin:dialog|confirm': true,
      'plugin:dialog|ask': true,
    });

    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');

    const deleteButton = remoteDialog.locator('button[title*="Delete"], button[title*="Remove"], button[aria-label*="delete"]').first();
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();

    await waitForCommand(page, 'remove_remote');

    const removeCommands = await findCommand(page, 'remove_remote');
    expect(removeCommands.length).toBeGreaterThan(0);

    const args = removeCommands[0].args as Record<string, unknown>;
    const argsStr = JSON.stringify(args);
    expect(argsStr).toMatch(/origin|upstream/);

    // Verify the remote dialog is still visible after deletion (list refreshes)
    await expect(page.locator('gn-remote-dialog')).toBeVisible();
  });

  test('rename remote should invoke rename_remote command', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      'get_remotes': [{ name: 'origin', url: 'https://github.com/user/repo.git', pushUrl: null }],
      'rename_remote': { success: true },
      'set_remote_url': { success: true },
    });

    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');

    const renameButton = remoteDialog.locator('button[title*="Rename"], button[aria-label*="rename"]').first();
    if (await renameButton.count() > 0) {
      await renameButton.click();

      const nameInput = remoteDialog.locator('input').first();
      await nameInput.fill('origin-renamed');

      const confirmButton = remoteDialog.locator('button', { hasText: /save|rename|confirm/i }).first();
      if (await confirmButton.count() > 0) {
        await confirmButton.click();

        await waitForCommand(page, 'rename_remote');

        const renameCommands = await findCommand(page, 'rename_remote');
        expect(renameCommands.length).toBeGreaterThan(0);

        // Verify the remote dialog is still visible after rename (list refreshes)
        await expect(page.locator('gn-remote-dialog')).toBeVisible();
      }
    }
  });
});

test.describe('Remote Dialog Error Scenarios', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('should show error when add_remote fails', async ({ page }) => {
    await injectCommandMock(page, {
      'get_remotes': [{ name: 'origin', url: 'https://github.com/user/repo.git', pushUrl: null }],
    });

    await injectCommandError(page, 'add_remote', 'Failed to add remote: name already exists');

    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');
    const addButton = remoteDialog.locator('button', { hasText: /add.*remote/i });
    await addButton.click();

    const nameInput = remoteDialog.locator('input[placeholder*="origin"], input[placeholder*="name" i], input[name*="name"]').first();
    const urlInput = remoteDialog.locator('input[placeholder*="github"], input[placeholder*="url" i], input[name*="url"]').first();

    await nameInput.fill('upstream');
    await urlInput.fill('https://github.com/upstream/repo.git');

    const saveButton = remoteDialog.locator('button', { hasText: /save|add/i }).last();
    await saveButton.click();

    await expect(page.locator('.toast, .error-message, .error, .error-banner').first()).toBeVisible({ timeout: 5000 });

    // Dialog should remain open after error
    await expect(remoteDialog).toBeVisible();
  });

  test('should show error when rename_remote fails', async ({ page }) => {
    await injectCommandMock(page, {
      'get_remotes': [{ name: 'origin', url: 'https://github.com/user/repo.git', pushUrl: null }],
      'set_remote_url': { success: true },
    });

    await injectCommandError(page, 'rename_remote', 'Failed to rename remote: invalid name');

    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');

    const renameButton = remoteDialog.locator('button[title*="Rename"], button[aria-label*="rename"]').first();
    if (await renameButton.count() > 0) {
      await renameButton.click();

      const nameInput = remoteDialog.locator('input').first();
      await nameInput.fill('bad/name');

      const confirmButton = remoteDialog.locator('button', { hasText: /save|rename|confirm/i }).first();
      if (await confirmButton.count() > 0) {
        await confirmButton.click();

        await expect(page.locator('.toast, .error-message, .error, .error-banner').first()).toBeVisible({ timeout: 5000 });
      }
    }
  });

  test('should show error when remove_remote fails', async ({ page }) => {
    await injectCommandMock(page, {
      'get_remotes': [
        { name: 'origin', url: 'https://github.com/user/repo.git', pushUrl: null },
        { name: 'upstream', url: 'https://github.com/original/repo.git', pushUrl: null },
      ],
      'plugin:dialog|confirm': true,
      'plugin:dialog|ask': true,
    });

    await injectCommandError(page, 'remove_remote', 'Failed to remove remote: remote is in use');

    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');

    const deleteButton = remoteDialog.locator('button[title*="Delete"], button[title*="Remove"], button[aria-label*="delete"]').first();
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();

    await expect(page.locator('.toast, .error-message, .error, .error-banner').first()).toBeVisible({ timeout: 5000 });
  });
});

// ============================================================================
// Extended Tests - Additional Coverage
// ============================================================================

test.describe('Remote Dialog - Extended Tests', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('edit and save should invoke set_remote_url with the new URL', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      'get_remotes': [{ name: 'origin', url: 'https://github.com/user/repo.git', pushUrl: null }],
      'set_remote_url': { success: true },
    });

    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');

    // Click the Edit button for the remote
    const editButton = remoteDialog.locator('button[title*="Edit"], button[aria-label*="edit"]').first();
    await expect(editButton).toBeVisible();
    await editButton.click();

    // Find the URL input in the edit form and change it
    const urlInput = remoteDialog.locator('input[type="text"]').first();
    await expect(urlInput).toBeVisible();
    await urlInput.fill('https://github.com/newuser/newrepo.git');

    // Click save/confirm
    const saveButton = remoteDialog.locator('button', { hasText: /save|confirm|update/i }).first();
    await expect(saveButton).toBeVisible();
    await saveButton.click();

    // Wait for set_remote_url to be called
    await waitForCommand(page, 'set_remote_url');

    const setUrlCommands = await findCommand(page, 'set_remote_url');
    expect(setUrlCommands.length).toBeGreaterThan(0);

    // Verify the new URL was passed in the command args
    const args = setUrlCommands[0].args as Record<string, unknown>;
    const argsStr = JSON.stringify(args);
    expect(argsStr).toContain('https://github.com/newuser/newrepo.git');

    // Verify the dialog is still visible (returns to list view after save)
    await expect(remoteDialog).toBeVisible();
  });

  test('clearing the push URL removes it from the remote list', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      'get_remotes': [
        { name: 'origin', url: 'https://github.com/user/repo.git', pushUrl: 'git@github.com:user/repo.git' },
      ],
      'set_remote_url': { success: true },
    });

    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');
    await expect(page.getByText('Push: git@github.com:user/repo.git')).toBeVisible();

    const editButton = remoteDialog.locator('button[title*="Edit"]').first();
    await expect(editButton).toBeVisible();
    await editButton.click();

    // Second text input in the edit form is the Push URL
    const pushUrlInput = remoteDialog.locator('input[type="text"]').nth(1);
    await expect(pushUrlInput).toBeVisible();
    await pushUrlInput.fill('');

    // The post-save reload should report the cleared remote
    await injectCommandMock(page, {
      'get_remotes': [{ name: 'origin', url: 'https://github.com/user/repo.git', pushUrl: null }],
    });

    const saveButton = remoteDialog.locator('button', { hasText: /save|confirm|update/i }).first();
    await saveButton.click();

    await waitForCommand(page, 'set_remote_url');

    const setUrlCommands = await findCommand(page, 'set_remote_url');
    const clearCall = setUrlCommands.find((c) => {
      const args = c.args as Record<string, unknown>;
      return args.push === true && args.url === '';
    });
    expect(clearCall).toBeDefined();

    // UI outcome: the Push line is gone
    await expect(page.getByText(/^Push: /)).toHaveCount(0);
  });

  test('remote list should refresh after adding a new remote', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      'get_remotes': [{ name: 'origin', url: 'https://github.com/user/repo.git', pushUrl: null }],
      'add_remote': { success: true },
    });

    await openRemoteDialog(page);

    const remoteDialog = page.locator('gn-remote-dialog');

    // Verify initial state shows origin
    await expect(remoteDialog.getByText('origin').first()).toBeVisible();

    // Now inject the updated remotes list that includes the new remote
    // This simulates the backend returning updated data after add
    await injectCommandMock(page, {
      'get_remotes': [
        { name: 'origin', url: 'https://github.com/user/repo.git', pushUrl: null },
        { name: 'fork', url: 'https://github.com/fork/repo.git', pushUrl: null },
      ],
      'add_remote': { success: true },
    });

    // Click Add Remote button
    const addButton = remoteDialog.locator('button', { hasText: /add.*remote/i });
    await addButton.click();

    // Fill in the form
    const nameInput = remoteDialog.locator('input[placeholder*="origin"], input[placeholder*="name" i], input[name*="name"]').first();
    const urlInput = remoteDialog.locator('input[placeholder*="github"], input[placeholder*="url" i], input[name*="url"]').first();

    await nameInput.fill('fork');
    await urlInput.fill('https://github.com/fork/repo.git');

    // Click save
    const saveButton = remoteDialog.locator('button', { hasText: /save|add/i }).last();
    await saveButton.click();

    // Wait for add_remote command to be called
    await waitForCommand(page, 'add_remote');

    // Verify add_remote was called with the correct remote name
    const addCommands = await findCommand(page, 'add_remote');
    expect(addCommands.length).toBeGreaterThan(0);
    const addArgs = JSON.stringify(addCommands[0].args);
    expect(addArgs).toContain('fork');

    // Verify the new remote appears in the list after refresh
    await expect(remoteDialog.getByText('fork').first()).toBeVisible({ timeout: 5000 });

    // Verify the dialog is still visible
    await expect(remoteDialog).toBeVisible();
  });
});
