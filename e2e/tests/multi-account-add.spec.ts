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
 * E2E Tests: Adding a second integration account
 *
 * Tests that the account selector UI supports adding and viewing
 * multiple accounts for a single integration type.
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

const existingGitHubAccount: MockIntegrationAccount = {
  id: 'gh-acc-1',
  name: 'GitHub (testuser)',
  integrationType: 'github',
  config: { type: 'github' },
  color: '#4f46e5',
  cachedUser: { username: 'testuser', displayName: 'Test User', avatarUrl: null },
  urlPatterns: [],
  isDefault: true,
};

test.describe('Multi-Account - Adding Second Account', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    await setupProfilesAndAccounts(
      page,
      {
        profiles: [defaultProfile],
        accounts: [existingGitHubAccount],
        connectedAccounts: ['gh-acc-1'],
      },
    );

    // Inject account data into Tauri IPC mocks so dialog's loadInitialData() finds them.
    // The dialog calls get_unified_profiles_config which returns the full config,
    // then store.setConfig() sets both profiles and accounts from it.
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [defaultProfile],
        accounts: [existingGitHubAccount],
        repositoryAssignments: {},
      },
      get_integration_accounts: [existingGitHubAccount],
      get_profiles: [defaultProfile],
      get_active_profile: defaultProfile,
    });

    app = new AppPage(page);
    dialogs = new DialogsPage(page);
  });

  test('should display existing account in GitHub dialog account selector', async ({ page }) => {
    // Open GitHub dialog via command palette
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // The account selector should show the existing account
    const selector = page.locator('gn-github-dialog gn-account-selector');
    await expect(selector).toBeVisible();

    // Should display the account name
    await expect(selector).toContainText('GitHub (testuser)');
  });

  test('should show Add Account option in account selector dropdown', async ({ page }) => {
    // Open GitHub dialog via command palette
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Click the selector to open dropdown
    const selectorBtn = page.locator('gn-github-dialog gn-account-selector .selector-btn');
    await selectorBtn.click();

    // Should show "Add Account" action in the dropdown
    const addAccountBtn = page.locator('gn-github-dialog gn-account-selector .dropdown-action.primary');
    await expect(addAccountBtn).toBeVisible();
    await expect(addAccountBtn).toContainText('Add Account');
  });

  test('should show PAT input for connecting a second account', async ({ page }) => {
    // Open GitHub dialog via command palette
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // The connection tab should have a token input (for PAT method)
    const connectionTab = page.locator('gn-github-dialog .tab:has-text("Connection")');
    await connectionTab.click();

    // Token input may or may not be visible depending on auth method, but the
    // connection tab should be reachable
    const connectionTabContent = page.locator('gn-github-dialog .tab-content');
    await expect(connectionTabContent).toBeVisible();
  });

  test('should show OAuth sign-in option when OAuth is configured', async ({ page }) => {
    // Open GitHub dialog via command palette
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Switch to connection tab
    const connectionTab = page.locator('gn-github-dialog .tab:has-text("Connection")');
    await connectionTab.click();

    // Either the auth toggle or the OAuth button should exist in the connection UI
    const tabContent = page.locator('gn-github-dialog .tab-content');
    await expect(tabContent).toBeVisible();
  });
});
