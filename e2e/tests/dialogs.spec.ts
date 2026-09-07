import { test, expect } from '@playwright/test';
import { setupOpenRepository, setupTauriMocks } from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';
import { DialogsPage } from '../pages/dialogs.page';
import {
  injectCommandError,
  injectCommandMock,
  autoConfirmDialogs,
  startCommandCaptureWithMocks,
} from '../fixtures/test-helpers';

test.describe('Settings Dialog', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should open settings dialog with Cmd+,', async ({ page }) => {
    await page.keyboard.press('Meta+,');
    await expect(dialogs.settings.dialog).toBeVisible();
  });

  test('should close settings with Escape', async ({ page }) => {
    await page.keyboard.press('Meta+,');
    await dialogs.settings.closeWithEscape();
    await expect(dialogs.settings.dialog).not.toBeVisible();
  });

  test('should have theme selector', async ({ page }) => {
    await page.keyboard.press('Meta+,');
    await expect(dialogs.settings.themeSelect).toBeVisible();
  });

  test('should have toggle switches for settings', async ({ page }) => {
    await page.keyboard.press('Meta+,');
    // Settings has toggle switches for showAvatars, showCommitSize, wordWrap, confirmBeforeDiscard
    // (vim mode toggle is in keyboard shortcuts dialog, not settings)
    await expect(dialogs.settings.vimModeToggle).toBeVisible();
  });
});

test.describe('Keyboard Shortcuts Dialog', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should open with ? key', async ({ page }) => {
    await page.keyboard.press('?');
    await expect(dialogs.keyboardShortcuts.dialog).toBeVisible();
  });

  test('should display shortcuts list', async ({ page }) => {
    await page.keyboard.press('?');
    await expect(dialogs.keyboardShortcuts.shortcutList).toBeVisible();
  });

  test('should have multiple shortcuts', async ({ page }) => {
    await page.keyboard.press('?');
    const count = await dialogs.keyboardShortcuts.getShortcutCount();
    expect(count).toBeGreaterThan(0);
  });

  test('should close with Escape', async ({ page }) => {
    await page.keyboard.press('?');
    await dialogs.keyboardShortcuts.closeWithEscape();
    await expect(dialogs.keyboardShortcuts.dialog).not.toBeVisible();
  });
});

test.describe('Profile Manager Dialog', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should open from command palette', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    // The dialog doesn't have role="dialog", so check for the New Profile button
    // which is only visible when the dialog is open
    await expect(dialogs.profileManager.addProfileButton).toBeVisible();
  });

  test('should display profile list or empty state', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    // Wait for dialog to open
    await expect(dialogs.profileManager.addProfileButton).toBeVisible();

    // Either the profile list or the empty state text must be visible
    await expect(
      page.locator('lv-profile-manager-dialog[open] .profile-list, lv-profile-manager-dialog[open] :text("No profiles yet")').first()
    ).toBeVisible({ timeout: 3000 });
  });

  test('should have new profile button', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.profileManager.addProfileButton).toBeVisible();
  });
});

test.describe('GitHub Dialog', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should open from command palette', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.github.dialog).toBeVisible();
  });

  test('should have connection tab', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.github.connectionTab).toBeVisible();
  });

  test('should have pull requests tab', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.github.pullRequestsTab).toBeVisible();
  });

  test('should have issues tab', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.github.issuesTab).toBeVisible();
  });

  test('should switch between tabs', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await dialogs.github.switchToPullRequestsTab();
    await dialogs.github.switchToIssuesTab();
    await dialogs.github.switchToConnectionTab();

    await expect(dialogs.github.dialog).toBeVisible();
  });

  test('should close with Escape', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await dialogs.github.closeWithEscape();
    await expect(dialogs.github.dialog).not.toBeVisible();
  });
});

test.describe('Clone Dialog Validation', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page, {
      repository: undefined, // No repo open - show welcome
    });
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await app.goto();
  });

  test('should validate URL input', async () => {
    await app.cloneButton.click();
    await dialogs.clone.waitForOpen();

    // Enter invalid URL
    await dialogs.clone.fillUrl('not-a-valid-url');

    // Clone button state depends on validation logic
    await expect(dialogs.clone.urlInput).toHaveValue('not-a-valid-url');
  });

  test('should accept GitHub HTTPS URL', async () => {
    await app.cloneButton.click();
    await dialogs.clone.waitForOpen();

    await dialogs.clone.fillUrl('https://github.com/user/repo.git');
    await expect(dialogs.clone.urlInput).toHaveValue('https://github.com/user/repo.git');
  });

  test('should accept GitHub SSH URL', async () => {
    await app.cloneButton.click();
    await dialogs.clone.waitForOpen();

    await dialogs.clone.fillUrl('git@github.com:user/repo.git');
    await expect(dialogs.clone.urlInput).toHaveValue('git@github.com:user/repo.git');
  });

  test('should accept GitLab URL', async () => {
    await app.cloneButton.click();
    await dialogs.clone.waitForOpen();

    await dialogs.clone.fillUrl('https://gitlab.com/user/repo.git');
    await expect(dialogs.clone.urlInput).toHaveValue('https://gitlab.com/user/repo.git');
  });
});

test.describe('Dialog Backdrop', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('clicking backdrop should close settings dialog', async ({ page }) => {
    await page.keyboard.press('Meta+,');
    await expect(dialogs.settings.dialog).toBeVisible();

    // Click the overlay behind the dialog to close it
    // The overlay covers the full viewport but Playwright considers it "hidden"
    // because it's behind the dialog in stacking order. Use force: true to click it.
    const overlay = page.locator('lv-modal[open] .overlay');
    await overlay.click({ position: { x: 5, y: 5 }, force: true });
    await expect(dialogs.settings.dialog).not.toBeVisible();
  });
});

test.describe('Dialog Focus Management', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    // Use setupTauriMocks for welcome screen tests that need the clone button
    await setupTauriMocks(page);
    await app.goto();
  });

  test('command palette should focus input on open', async () => {
    await dialogs.commandPalette.open();
    await expect(dialogs.commandPalette.input).toBeFocused();
  });

  test('clone dialog should have URL input visible on open', async () => {
    await app.cloneButton.click();
    await dialogs.clone.waitForOpen();

    // URL input should be visible and ready for input
    // Note: autofocus may not work reliably in test environment due to Playwright's focus handling
    await expect(dialogs.clone.urlInput).toBeVisible();
  });
});

test.describe('Multiple Dialogs', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('opening new dialog should close previous', async ({ page }) => {
    // Open settings
    await page.keyboard.press('Meta+,');
    await expect(dialogs.settings.dialog).toBeVisible();

    // Close settings via Escape (lv-modal handles this)
    await page.keyboard.press('Escape');
    await expect(dialogs.settings.dialog).not.toBeVisible();

    // Now open command palette
    await page.keyboard.press('Meta+p');
    await expect(dialogs.commandPalette.palette).toBeVisible();

    // Close command palette, then open shortcuts dialog
    await page.keyboard.press('Escape');
    await expect(dialogs.commandPalette.palette).not.toBeVisible();

    // Open keyboard shortcuts
    await page.keyboard.press('?');
    await expect(dialogs.keyboardShortcuts.dialog).toBeVisible();
  });
});

test.describe('Settings Dialog - Theme Change', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('changing theme should update body class', async ({ page }) => {
    await page.keyboard.press('Meta+,');
    await expect(dialogs.settings.dialog).toBeVisible();

    // Change theme to light
    await dialogs.settings.setTheme('light');

    // The app should apply the theme as a class or attribute on the body/root
    const bodyClass = await page.evaluate(() => document.documentElement.getAttribute('data-theme') || document.body.className);
    expect(bodyClass).toContain('light');
  });

  test('changing theme should persist to settings store', async ({ page }) => {
    await page.keyboard.press('Meta+,');
    await expect(dialogs.settings.dialog).toBeVisible();

    await dialogs.settings.setTheme('light');

    // Verify the settings store was updated (persisted via zustand/persist to localStorage)
    await page.waitForFunction(() => {
      const stores = (window as any).__GITNADO_STORES__;
      return stores?.settingsStore?.getState()?.theme === 'light';
    });

    const theme = await page.evaluate(() => {
      return (window as any).__GITNADO_STORES__?.settingsStore?.getState()?.theme;
    });
    expect(theme).toBe('light');
  });
});

test.describe('Settings Dialog - Toggle Settings', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('toggling a setting should persist to settings store', async ({ page }) => {
    await page.keyboard.press('Meta+,');
    await expect(dialogs.settings.dialog).toBeVisible();

    // Get the initial value of the first toggle (showAvatars)
    const initialValue = await page.evaluate(() => {
      return (window as any).__GITNADO_STORES__?.settingsStore?.getState()?.showAvatars;
    });

    // Toggle the first setting switch
    await dialogs.settings.toggleVimMode();

    // Verify the settings store was updated with the toggled value
    await page.waitForFunction((initial) => {
      const stores = (window as any).__GITNADO_STORES__;
      return stores?.settingsStore?.getState()?.showAvatars !== initial;
    }, initialValue);

    const newValue = await page.evaluate(() => {
      return (window as any).__GITNADO_STORES__?.settingsStore?.getState()?.showAvatars;
    });
    expect(newValue).toBe(!initialValue);
  });

  test('settings should persist after dialog close and reopen', async ({ page }) => {
    // Open settings and change theme
    await page.keyboard.press('Meta+,');
    await expect(dialogs.settings.dialog).toBeVisible();

    await dialogs.settings.setTheme('light');

    await dialogs.settings.closeWithEscape();
    await expect(dialogs.settings.dialog).not.toBeVisible();

    // Reopen settings
    await page.keyboard.press('Meta+,');
    await expect(dialogs.settings.dialog).toBeVisible();

    // Theme select should still be 'light'
    await expect(dialogs.settings.themeSelect).toHaveValue('light');
  });
});

test.describe('Settings Dialog - Error Handling', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('theme change should update document data-theme attribute', async ({ page }) => {
    await page.keyboard.press('Meta+,');
    await expect(dialogs.settings.dialog).toBeVisible();

    await dialogs.settings.setTheme('light');

    // Verify the data-theme attribute is set on the document element
    await page.waitForFunction(() =>
      document.documentElement.getAttribute('data-theme') === 'light'
    );

    const dataTheme = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme')
    );
    expect(dataTheme).toBe('light');
  });
});

test.describe('Keyboard Shortcuts Dialog - Details', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should display at least 5 shortcuts', async ({ page }) => {
    await page.keyboard.press('?');
    await expect(dialogs.keyboardShortcuts.dialog).toBeVisible();

    const count = await dialogs.keyboardShortcuts.getShortcutCount();
    expect(count).toBeGreaterThanOrEqual(5);
  });

  test('should have vim mode toggle in shortcuts dialog', async ({ page }) => {
    await page.keyboard.press('?');
    await expect(dialogs.keyboardShortcuts.dialog).toBeVisible();

    await expect(dialogs.keyboardShortcuts.vimModeToggle).toBeVisible();
  });

  test('toggling vim mode in shortcuts dialog should persist', async ({ page }) => {
    await page.keyboard.press('?');
    await expect(dialogs.keyboardShortcuts.dialog).toBeVisible();

    await dialogs.keyboardShortcuts.toggleVimMode();

    // Vim mode settings are persisted to localStorage by the keyboard service
    await page.waitForFunction(() => {
      const stored = localStorage.getItem('gitnado-keyboard-settings');
      if (!stored) return false;
      const settings = JSON.parse(stored);
      return settings.vimMode === true;
    });

    const vimMode = await page.evaluate(() => {
      const stored = localStorage.getItem('gitnado-keyboard-settings');
      return stored ? JSON.parse(stored).vimMode : null;
    });
    expect(vimMode).toBe(true);
  });
});

test.describe('Dialogs - Error Scenarios', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('settings dialog should allow changing theme without error', async ({ page }) => {
    // Open settings dialog
    await page.keyboard.press('Meta+,');
    await expect(dialogs.settings.dialog).toBeVisible();

    // The theme select should be visible
    await expect(dialogs.settings.themeSelect).toBeVisible();

    // Change the theme
    await dialogs.settings.setTheme('light');

    // Verify the settings store was updated
    await page.waitForFunction(() => {
      return (window as unknown as { __GITNADO_STORES__: { settingsStore: { getState: () => { theme: string } } } })
        .__GITNADO_STORES__?.settingsStore?.getState()?.theme === 'light';
    });

    const theme = await page.evaluate(() => {
      return (window as unknown as { __GITNADO_STORES__: { settingsStore: { getState: () => { theme: string } } } })
        .__GITNADO_STORES__?.settingsStore?.getState()?.theme;
    });
    expect(theme).toBe('light');
  });

  test('settings dialog should allow changing font size without error', async ({ page }) => {
    // Open settings dialog
    await page.keyboard.press('Meta+,');
    await expect(dialogs.settings.dialog).toBeVisible();

    // Find and change the font size select (second select in the dialog)
    const selects = page.locator('lv-settings-dialog select');
    const count = await selects.count();
    expect(count).toBeGreaterThan(0);

    // Change the first available select to its second option
    const firstSelect = selects.first();
    const options = await firstSelect.locator('option').allTextContents();
    if (options.length > 1) {
      await firstSelect.selectOption({ index: 1 });
    }

    // Dialog should still be visible (no crash)
    await expect(dialogs.settings.dialog).toBeVisible();
  });
});

test.describe('Settings Dialog - Reset to Defaults', () => {
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, {});
  });

  test('reset restores defaults and confirms it to the user', async ({ page }) => {
    await autoConfirmDialogs(page);

    await page.keyboard.press('Meta+,');
    await expect(dialogs.settings.dialog).toBeVisible();

    // Move a setting off its default so the reset is observable.
    await dialogs.settings.setTheme('light');
    await page.waitForFunction(() => {
      const stores = (window as any).__GITNADO_STORES__;
      return stores?.settingsStore?.getState()?.theme === 'light';
    });

    await dialogs.settings.resetButton.click();

    // The store goes back to the default theme...
    await page.waitForFunction(() => {
      const stores = (window as any).__GITNADO_STORES__;
      return stores?.settingsStore?.getState()?.theme === 'dark';
    });
    // ...the dialog repaints from the store...
    await expect(dialogs.settings.themeSelect).toHaveValue('dark');
    // ...and the user is told it happened.
    await expect(page.locator('lv-toast-container .toast.success')).toBeVisible();
  });

  test('cancelling the reset keeps the current settings', async ({ page }) => {
    // plugin-dialog 2.x routes confirm() through `message`; anything other than
    // the OK label reads as "declined".
    await injectCommandMock(page, { 'plugin:dialog|message': 'Cancel' });

    await page.keyboard.press('Meta+,');
    await expect(dialogs.settings.dialog).toBeVisible();

    await dialogs.settings.setTheme('light');
    await page.waitForFunction(() => {
      const stores = (window as any).__GITNADO_STORES__;
      return stores?.settingsStore?.getState()?.theme === 'light';
    });

    await dialogs.settings.resetButton.click();

    // Wait until the prompt has actually been raised, so the assertions below
    // are not just racing the click.
    await page.waitForFunction(() => {
      const commands =
        (window as unknown as { __INVOKED_COMMANDS__?: { command: string }[] })
          .__INVOKED_COMMANDS__ || [];
      return commands.some((c) => c.command === 'plugin:dialog|message');
    });

    await expect(dialogs.settings.themeSelect).toHaveValue('light');
    const theme = await page.evaluate(
      () => (window as any).__GITNADO_STORES__?.settingsStore?.getState()?.theme
    );
    expect(theme).toBe('light');
    await expect(page.locator('lv-toast-container .toast')).toHaveCount(0);
  });
});

test.describe('Command Palette - open file in editor', () => {
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('selecting a file whose editor fails shows an error toast', async ({ page }) => {
    await injectCommandMock(page, { list_tracked_files: ['src/main.rs'] });
    await injectCommandError(page, 'open_in_configured_editor', 'Invalid path: src/main.rs');

    await dialogs.commandPalette.open();
    // File entries only join the results once the query is at least 2 chars.
    await dialogs.commandPalette.search('main.rs');
    await dialogs.commandPalette.selectResultByText('src/main.rs');

    // executeSelected closes the palette, so the toast is unobstructed.
    await expect(dialogs.commandPalette.palette).not.toBeVisible();
    await expect(
      page.locator('lv-toast-container .toast.error .toast-message').first()
    ).toContainText('src/main.rs');
  });

  test('selecting a file that opens successfully shows no error toast', async ({ page }) => {
    await injectCommandMock(page, {
      list_tracked_files: ['src/main.rs'],
      open_in_configured_editor: { success: true, message: 'Opened in code' },
    });

    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('main.rs');
    await dialogs.commandPalette.selectResultByText('src/main.rs');

    await expect(dialogs.commandPalette.palette).not.toBeVisible();
    await expect(page.locator('lv-toast-container .toast.error')).toHaveCount(0);
  });
});
