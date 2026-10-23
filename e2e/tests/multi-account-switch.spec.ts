import { test, expect } from '@playwright/test';
import {
  setupProfilesAndAccounts,
  type MockUnifiedProfile,
  type MockIntegrationAccount,
} from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';
import { DialogsPage } from '../pages/dialogs.page';
import { injectCommandMock } from '../fixtures/test-helpers';

/**
 * E2E Tests: Switching between integration accounts
 *
 * Tests that multiple accounts are listed in the dropdown, default badges
 * are shown, and switching between accounts updates the selector display.
 */

const defaultProfile: MockUnifiedProfile = {
  id: 'profile-1',
  name: 'Default',
  gitName: 'Test User',
  gitEmail: 'test@example.com',
  signingKey: null,
  urlPatterns: [],
  isDefault: true,
  color: '#4f46e5',
  defaultAccounts: { github: 'gh-acc-1' },
};

const account1: MockIntegrationAccount = {
  id: 'gh-acc-1',
  name: 'GitHub (personal)',
  integrationType: 'github',
  config: { type: 'github' },
  color: '#4f46e5',
  cachedUser: { username: 'personal-user', displayName: 'Personal User', avatarUrl: null },
  urlPatterns: [],
  isDefault: true,
};

const account2: MockIntegrationAccount = {
  id: 'gh-acc-2',
  name: 'GitHub (work)',
  integrationType: 'github',
  config: { type: 'github' },
  color: '#059669',
  cachedUser: { username: 'work-user', displayName: 'Work User', avatarUrl: null },
  urlPatterns: [],
  isDefault: false,
};

test.describe('Multi-Account - Switching Between Accounts', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    await setupProfilesAndAccounts(
      page,
      {
        profiles: [defaultProfile],
        accounts: [account1, account2],
        connectedAccounts: ['gh-acc-1', 'gh-acc-2'],
      },
    );

    // Inject account data into Tauri IPC mocks so dialog's loadInitialData() finds them.
    // The dialog calls get_unified_profiles_config which returns the full config,
    // then store.setConfig() sets both profiles and accounts from it.
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [defaultProfile],
        accounts: [account1, account2],
        repositoryAssignments: {},
      },
      get_integration_accounts: [account1, account2],
      get_profiles: [defaultProfile],
      get_active_profile: defaultProfile,
    });

    app = new AppPage(page);
    dialogs = new DialogsPage(page);
  });

  test('should list both accounts in the dropdown', async ({ page }) => {
    // Open GitHub dialog via command palette
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Click the account selector to open dropdown
    const selectorBtn = page.locator('gn-github-dialog gn-account-selector .selector-btn');
    await selectorBtn.click();

    // Both accounts should be listed
    const dropdownItems = page.locator('gn-github-dialog gn-account-selector .dropdown-item');
    const count = await dropdownItems.count();
    expect(count).toBe(2);

    // Check account names are present
    const dropdownText = await page.locator('gn-github-dialog gn-account-selector .dropdown').textContent();
    expect(dropdownText).toContain('GitHub (personal)');
    expect(dropdownText).toContain('GitHub (work)');
  });

  test('should show Default badge on the default account', async ({ page }) => {
    // Open GitHub dialog via command palette
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Open dropdown
    const selectorBtn = page.locator('gn-github-dialog gn-account-selector .selector-btn');
    await selectorBtn.click();

    // The default account should have a "Default" badge
    const defaultBadge = page.locator('gn-github-dialog gn-account-selector .default-badge');
    await expect(defaultBadge).toBeVisible();
    await expect(defaultBadge).toContainText('Default');

    // Only one default badge should exist
    const badgeCount = await page.locator('gn-github-dialog gn-account-selector .default-badge').count();
    expect(badgeCount).toBe(1);
  });

  test('should update selector display when switching accounts', async ({ page }) => {
    // Open GitHub dialog via command palette
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Verify the initial account is shown
    const selectorText = page.locator('gn-github-dialog gn-account-selector .account-name');
    await expect(selectorText).toHaveText('GitHub (personal)');

    // Open dropdown and click second account
    const selectorBtn = page.locator('gn-github-dialog gn-account-selector .selector-btn');
    await selectorBtn.click();

    // Select the second account
    const workAccountItem = page.locator('gn-github-dialog gn-account-selector .dropdown-item', { hasText: 'GitHub (work)' });
    await workAccountItem.click();

    // The selector should now show the second account
    await expect(selectorText).toHaveText('GitHub (work)');
  });

  test('should show Manage Accounts option in dropdown', async ({ page }) => {
    // Open GitHub dialog via command palette
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Open dropdown
    const selectorBtn = page.locator('gn-github-dialog gn-account-selector .selector-btn');
    await selectorBtn.click();

    // Should show "Manage Accounts..." action
    const manageBtn = page.locator('gn-github-dialog gn-account-selector .dropdown-action:has-text("Manage Accounts")');
    await expect(manageBtn).toBeVisible();
  });
});
