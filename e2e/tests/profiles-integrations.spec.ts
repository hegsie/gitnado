/**
 * Profiles & Integrations E2E Tests
 *
 * Tests for:
 * - Profile Manager Dialog (CRUD operations)
 * - Global Account Management
 * - Integration Dialogs (GitHub, GitLab, Azure DevOps, Bitbucket)
 * - Account Selector functionality
 * - Profile-to-Repository assignments
 */

import { test, expect, Page } from '@playwright/test';
import { setupOpenRepository, setupTauriMocks, setupProfilesAndAccounts } from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';
import { DialogsPage } from '../pages/dialogs.page';
import {
  findCommand,
  waitForCommand,
  startCommandCaptureWithMocks,
  injectCommandError,
  injectCommandMock,
  autoConfirmDialogs,
} from '../fixtures/test-helpers';

// ============================================================================
// Test Data
// ============================================================================

const testProfiles = {
  work: {
    id: 'profile-work',
    name: 'Work',
    gitName: 'John Doe',
    gitEmail: 'john.doe@company.com',
    signingKey: null,
    urlPatterns: ['github.com/company/*'],
    isDefault: true,
    color: '#3b82f6',
    defaultAccounts: { github: 'account-github-work' },
  },
  personal: {
    id: 'profile-personal',
    name: 'Personal',
    gitName: 'John D',
    gitEmail: 'johnd@personal.com',
    signingKey: null,
    urlPatterns: [],
    isDefault: false,
    color: '#10b981',
    defaultAccounts: {},
  },
};

const testAccounts = {
  githubWork: {
    id: 'account-github-work',
    name: 'Work GitHub',
    integrationType: 'github' as const,
    config: { type: 'github' },
    color: '#3b82f6',
    cachedUser: { username: 'johndoe-work', displayName: 'John Doe', avatarUrl: null },
    urlPatterns: ['github.com/company/*'],
    isDefault: true,
  },
  githubPersonal: {
    id: 'account-github-personal',
    name: 'Personal GitHub',
    integrationType: 'github' as const,
    config: { type: 'github' },
    color: '#10b981',
    cachedUser: { username: 'johnd', displayName: 'John D', avatarUrl: null },
    urlPatterns: [],
    isDefault: false,
  },
  gitlab: {
    id: 'account-gitlab',
    name: 'Company GitLab',
    integrationType: 'gitlab' as const,
    config: { type: 'gitlab', instanceUrl: 'https://gitlab.company.com' },
    color: '#f59e0b',
    cachedUser: { username: 'jdoe', displayName: 'John Doe', avatarUrl: null },
    urlPatterns: ['gitlab.company.com/*'],
    isDefault: true,
  },
};

// ============================================================================
// Profile Manager Dialog Tests
// ============================================================================

test.describe('Profile Manager Dialog - Basic Operations', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should open profile manager from command palette', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.profileManager.addProfileButton).toBeVisible();
  });

  test('should display New Profile button', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.profileManager.addProfileButton).toBeVisible();
    await expect(dialogs.profileManager.addProfileButton).toHaveText('New Profile');
  });

  test('should open create profile form when New Profile clicked', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    await dialogs.profileManager.addProfileButton.click();

    // Should show profile name input (placeholder is "e.g., Work, Personal, Open Source")
    await expect(page.getByPlaceholder(/Work, Personal/i)).toBeVisible();
  });

  test('should have required git identity fields in create form', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    await dialogs.profileManager.addProfileButton.click();

    // Check for git name and email fields (placeholders are "John Doe" and "john@example.com")
    await expect(page.getByPlaceholder('John Doe')).toBeVisible();
    await expect(page.getByPlaceholder('john@example.com')).toBeVisible();
  });

  test('should close dialog with Escape', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.profileManager.addProfileButton).toBeVisible();

    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // Dialog should be closed - check the dialog element itself
    await expect(page.locator('gn-profile-manager-dialog[open]')).not.toBeVisible();
  });
});

// These tests require store initialization with custom profiles/accounts
test.describe('Profile Manager Dialog - With Existing Profiles', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);

    // Setup with existing profiles
    await setupProfilesAndAccounts(page, {
      profiles: [testProfiles.work, testProfiles.personal],
      accounts: [testAccounts.githubWork, testAccounts.githubPersonal],
    });

    // The profile manager dialog calls loadProfiles() which invokes get_unified_profiles_config.
    // The default mock returns empty data, overwriting the store. Inject a mock that returns our test data.
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [testProfiles.work, testProfiles.personal],
        accounts: [testAccounts.githubWork, testAccounts.githubPersonal],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });
  });

  test('should display existing profiles in list', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    // Wait for New Profile button which indicates dialog is loaded
    await expect(page.getByRole('button', { name: 'New Profile' })).toBeVisible();

    // Should see both profiles - the email is rendered as "Name <email>"
    // The < and > are HTML entities, so use regex to match the text content
    await expect(page.getByText(/john\.doe@company\.com/).first()).toBeVisible();
    await expect(page.getByText(/johnd@personal\.com/)).toBeVisible();
  });

  test('should show default badge on default profile', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    // Wait for New Profile button which indicates dialog is loaded
    await expect(page.getByRole('button', { name: 'New Profile' })).toBeVisible();

    // Work profile has "Default" badge
    await expect(page.locator('.default-badge').first()).toBeVisible();
  });

  test('should show git email for each profile', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    // Wait for New Profile button which indicates dialog is loaded
    await expect(page.getByRole('button', { name: 'New Profile' })).toBeVisible();

    // Check emails are visible (shown as "Name <email>")
    await expect(page.getByText(/john\.doe@company\.com/).first()).toBeVisible();
    await expect(page.getByText(/johnd@personal\.com/)).toBeVisible();
  });

  test('should open edit mode when profile clicked', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    // Wait for New Profile button which indicates dialog is loaded
    await expect(page.getByRole('button', { name: 'New Profile' })).toBeVisible();

    // Click on Work profile item to enter edit mode
    await page.locator('.profile-item').first().click();

    // In edit mode, the dialog title changes and Save Profile button appears
    await expect(page.getByRole('button', { name: 'Save Profile' })).toBeVisible();
  });
});

// ============================================================================
// Integration Accounts on Profiles (attach / detach)
// ============================================================================

test.describe('Profile Manager Dialog - Integration Accounts', () => {
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [testProfiles.work, testProfiles.personal],
      accounts: [testAccounts.githubWork, testAccounts.githubPersonal, testAccounts.gitlab],
    });

    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [testProfiles.work, testProfiles.personal],
        accounts: [testAccounts.githubWork, testAccounts.githubPersonal, testAccounts.gitlab],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });
  });

  async function openProfileManager(page: Page): Promise<void> {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();
    await expect(page.getByRole('button', { name: 'New Profile' })).toBeVisible();
  }

  test('edit profile lists only the accounts attached to it', async ({ page }) => {
    await openProfileManager(page);

    // Work profile has github: account-github-work attached
    await page.locator('.profile-item').first().click();
    await expect(page.getByRole('button', { name: 'Save Profile' })).toBeVisible();

    await expect(dialogs.profileManager.attachedAccountItems).toHaveCount(1);
    await expect(dialogs.profileManager.attachedAccountItems.first()).toContainText('Work GitHub');
  });

  test('attach an existing account to a profile and persist on save', async ({ page }) => {
    await openProfileManager(page);

    // Personal profile has no attached accounts
    await page.locator('.profile-item').nth(1).click();
    await expect(dialogs.profileManager.attachedAccountItems).toHaveCount(0);

    await dialogs.profileManager.attachAccountButton.click();
    await expect(page.locator('gn-profile-manager-dialog .dialog-title')).toContainText(
      'Attach Account'
    );

    // Pick the Personal GitHub account from the picker
    await dialogs.profileManager.pickerAccountRows.filter({ hasText: 'Personal GitHub' }).click();

    // Back on the edit form, the account is now attached
    await expect(dialogs.profileManager.attachedAccountItems).toHaveCount(1);
    await expect(dialogs.profileManager.attachedAccountItems.first()).toContainText(
      'Personal GitHub'
    );

    await startCommandCaptureWithMocks(page, {
      save_unified_profile: {
        profile: { ...testProfiles.personal, defaultAccounts: { github: 'account-github-personal' } },
        failedRepositories: [],
      },
    });

    await page.getByRole('button', { name: 'Save Profile' }).click();
    await waitForCommand(page, 'save_unified_profile');

    const cmds = await findCommand(page, 'save_unified_profile');
    const profile = (cmds[0].args as { profile: { defaultAccounts: Record<string, string> } })
      .profile;
    expect(profile.defaultAccounts.github).toBe('account-github-personal');
  });

  test('detach an account removes it from the profile without deleting it globally', async ({
    page,
  }) => {
    await openProfileManager(page);

    // Work profile has one attached account
    await page.locator('.profile-item').first().click();
    await expect(dialogs.profileManager.attachedAccountItems).toHaveCount(1);

    await startCommandCaptureWithMocks(page, {
      save_unified_profile: {
        profile: { ...testProfiles.work, defaultAccounts: {} },
        failedRepositories: [],
      },
    });

    // Click the detach (X) button on the attached account
    await dialogs.profileManager.attachedAccountItems
      .first()
      .locator('.account-actions .action-btn.delete')
      .click();
    await expect(dialogs.profileManager.attachedAccountItems).toHaveCount(0);

    await page.getByRole('button', { name: 'Save Profile' }).click();
    await waitForCommand(page, 'save_unified_profile');

    const cmds = await findCommand(page, 'save_unified_profile');
    const profile = (cmds[0].args as { profile: { defaultAccounts: Record<string, string> } })
      .profile;
    expect(profile.defaultAccounts.github).toBeUndefined();

    // The key fix: detaching must NOT delete the global account
    const deletes = await findCommand(page, 'delete_global_account');
    expect(deletes.length).toBe(0);
  });

  test('attaching another account of the same provider replaces it', async ({ page }) => {
    await openProfileManager(page);

    // Work profile has github: account-github-work attached
    await page.locator('.profile-item').first().click();
    await expect(dialogs.profileManager.attachedAccountItems.first()).toContainText('Work GitHub');

    await dialogs.profileManager.attachAccountButton.click();
    await dialogs.profileManager.pickerAccountRows.filter({ hasText: 'Personal GitHub' }).click();

    // Still one github slot, now showing Personal GitHub
    await expect(dialogs.profileManager.attachedAccountItems).toHaveCount(1);
    await expect(dialogs.profileManager.attachedAccountItems.first()).toContainText(
      'Personal GitHub'
    );
  });

  test('delete account globally from the account edit screen', async ({ page }) => {
    await openProfileManager(page);

    await page.locator('.profile-item').first().click();
    await expect(dialogs.profileManager.attachedAccountItems).toHaveCount(1);

    // Open the attached account's edit screen via the pencil (non-delete) button
    await dialogs.profileManager.attachedAccountItems
      .first()
      .locator('.account-actions .action-btn:not(.delete)')
      .click();
    await expect(page.locator('gn-profile-manager-dialog .dialog-title')).toContainText(
      'Edit Account'
    );

    await startCommandCaptureWithMocks(page, {
      delete_global_account: null,
      'plugin:dialog|message': 'Ok',
    });

    await page.getByRole('button', { name: 'Delete Account' }).click();
    await waitForCommand(page, 'delete_global_account');

    const cmds = await findCommand(page, 'delete_global_account');
    expect(cmds.length).toBeGreaterThan(0);

    // After deletion the dialog returns to the profile editor and the now-deleted
    // account no longer appears in the attached list.
    await expect(page.locator('gn-profile-manager-dialog .dialog-title')).toContainText(
      'Edit Profile'
    );
    await expect(dialogs.profileManager.attachedAccountItems).toHaveCount(0);
  });

  test('edit account URL patterns and persist them in save_global_account', async ({
    page,
  }) => {
    await openProfileManager(page);

    // Open the Work profile's attached GitHub account edit screen.
    await page.locator('.profile-item').first().click();
    await expect(dialogs.profileManager.attachedAccountItems).toHaveCount(1);
    await dialogs.profileManager.attachedAccountItems
      .first()
      .locator('.account-actions .action-btn:not(.delete)')
      .click();
    await expect(page.locator('gn-profile-manager-dialog .dialog-title')).toContainText(
      'Edit Account'
    );

    // The account edit form exposes a URL patterns textarea pre-filled with the
    // account's existing patterns (Work GitHub matches github.com/company/*).
    const patternsTextarea = page.locator('gn-profile-manager-dialog textarea');
    await expect(patternsTextarea).toBeVisible();
    await expect(patternsTextarea).toHaveValue('github.com/company/*');

    // Add a second pattern.
    await patternsTextarea.fill('github.com/company/*\ngithub.com/company-labs/*');

    await startCommandCaptureWithMocks(page, {
      save_global_account: { ...testAccounts.githubWork },
    });

    await page.getByRole('button', { name: 'Save Account' }).click();
    await waitForCommand(page, 'save_global_account');

    const cmds = await findCommand(page, 'save_global_account');
    expect(cmds.length).toBeGreaterThan(0);
    const account = (cmds[0].args as { account: { urlPatterns: string[] } }).account;
    expect(account.urlPatterns).toEqual([
      'github.com/company/*',
      'github.com/company-labs/*',
    ]);
  });
});

test.describe('Profile Manager Dialog - Attach with no accounts', () => {
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [testProfiles.personal],
      accounts: [],
    });

    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [testProfiles.personal],
        accounts: [],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });
  });

  test('picker offers connect-new buttons and opens the GitHub dialog', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();
    await expect(page.getByRole('button', { name: 'New Profile' })).toBeVisible();

    await page.locator('.profile-item').first().click();
    await dialogs.profileManager.attachAccountButton.click();
    await expect(page.locator('gn-profile-manager-dialog .dialog-title')).toContainText(
      'Attach Account'
    );

    // No existing accounts to pick, but connect-new buttons are present
    await expect(dialogs.profileManager.pickerAccountRows).toHaveCount(0);
    const githubBtn = page
      .locator('gn-profile-manager-dialog')
      .getByRole('button', { name: 'GitHub', exact: true });
    await expect(githubBtn).toBeVisible();

    await githubBtn.click();

    // The GitHub dialog opens on top; the profile manager stays mounted underneath
    // (demoted) so it can be revealed again when the GitHub dialog closes.
    await expect(dialogs.github.dialog).toBeVisible();
    await expect(page.locator('gn-profile-manager-dialog[open][demoted]')).toHaveCount(1);
  });

  test('connecting a new account auto-attaches it to the profile', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();
    await expect(page.getByRole('button', { name: 'New Profile' })).toBeVisible();

    await page.locator('.profile-item').first().click();
    await dialogs.profileManager.attachAccountButton.click();
    await expect(page.locator('gn-profile-manager-dialog .dialog-title')).toContainText(
      'Attach Account'
    );

    // Connect a new GitHub account → GitHub dialog opens on top, profile manager
    // stays mounted underneath (demoted).
    await page
      .locator('gn-profile-manager-dialog')
      .getByRole('button', { name: 'GitHub', exact: true })
      .click();
    await expect(dialogs.github.dialog).toBeVisible();
    await expect(page.locator('gn-profile-manager-dialog[open][demoted]')).toHaveCount(1);

    // Opened from the profile manager → the dialog shows a Back arrow, not a close ×
    await expect(
      page.locator('gn-github-dialog').getByRole('button', { name: 'Back' })
    ).toBeVisible();
    await expect(
      page.locator('gn-github-dialog').getByRole('button', { name: 'Close' })
    ).toHaveCount(0);

    // Simulate the account being connected while in the GitHub dialog: the next
    // profile reload (on reveal) will include it.
    const newAccount = {
      id: 'account-new-gh',
      name: 'Freshly Connected GitHub',
      integrationType: 'github' as const,
      config: { type: 'github' },
      color: null,
      cachedUser: null,
      urlPatterns: [],
      isDefault: false,
    };
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [testProfiles.personal],
        accounts: [newAccount],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });

    // Going back from the GitHub dialog reveals the profile manager and auto-attaches
    // the account that was just connected — landing back on the edit form.
    await page.locator('gn-github-dialog').getByRole('button', { name: 'Back' }).click();

    await expect(page.locator('gn-profile-manager-dialog[open][demoted]')).toHaveCount(0);
    await expect(page.locator('gn-profile-manager-dialog .dialog-title')).toContainText(
      'Edit Profile'
    );
    await expect(dialogs.profileManager.attachedAccountItems.first()).toContainText(
      'Freshly Connected GitHub'
    );

    // And saving persists it to the profile
    await startCommandCaptureWithMocks(page, {
      save_unified_profile: {
        profile: { ...testProfiles.personal, defaultAccounts: { github: 'account-new-gh' } },
        failedRepositories: [],
      },
    });
    await page.getByRole('button', { name: 'Save Profile' }).click();
    await waitForCommand(page, 'save_unified_profile');
    const cmds = await findCommand(page, 'save_unified_profile');
    const profile = (cmds[0].args as { profile: { defaultAccounts: Record<string, string> } })
      .profile;
    expect(profile.defaultAccounts.github).toBe('account-new-gh');
  });
});

// ============================================================================
// Global Accounts Management Tests
// ============================================================================

test.describe('Global Accounts Management', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [testProfiles.work],
      accounts: [testAccounts.githubWork, testAccounts.githubPersonal, testAccounts.gitlab],
    });

    // Inject mock so loadProfiles() returns our test data instead of empty defaults
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [testProfiles.work],
        accounts: [testAccounts.githubWork, testAccounts.githubPersonal, testAccounts.gitlab],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });
  });

  test('should show global accounts section in profile manager', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    // Look for accounts info in profile cards (e.g., "1 default account")
    const profileManager = page.locator('gn-profile-manager-dialog');
    await expect(profileManager.getByText(/account/i).first()).toBeVisible();
  });

  test('should display account count by type', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    // Wait for dialog to load with profile data
    await expect(page.getByRole('button', { name: 'New Profile' })).toBeVisible();

    // Profile cards show "1 default account" in the meta section
    const profileManager = page.locator('gn-profile-manager-dialog');
    await expect(profileManager.getByText(/default account/i)).toBeVisible();
  });
});

// ============================================================================
// Multiple Accounts of Same Type Tests
// ============================================================================

test.describe('Multiple GitHub Accounts Management', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should allow adding first GitHub account via PAT', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    // Switch to PAT mode
    await dialogs.github.selectPATMethod();

    // Should be able to enter token
    await dialogs.github.tokenInput.fill('ghp_test_token_12345');
    await expect(dialogs.github.tokenInput).toHaveValue('ghp_test_token_12345');

    // Connect button should be present
    await expect(dialogs.github.connectButton).toBeVisible();
  });

  test('should show account name input or PAT token input when adding account', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    // Switch to PAT mode
    await dialogs.github.selectPATMethod();

    // PAT token input should always be visible in PAT mode
    await expect(dialogs.github.tokenInput).toBeVisible();
  });

  test('should have OAuth sign in option', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    // Should have OAuth option visible - the "Sign in with GitHub" text appears in
    // both the auth method toggle button and the .btn-oauth button, use .first()
    await expect(
      page.getByRole('button', { name: /sign in with github/i }).first()
    ).toBeVisible();
  });

  test('should switch between OAuth and PAT methods', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    // Switch to PAT
    await dialogs.github.selectPATMethod();
    await expect(dialogs.github.tokenInput).toBeVisible();

    // Switch back to OAuth
    await dialogs.github.selectOAuthMethod();
    await expect(dialogs.github.oauthSignInButton).toBeVisible();
  });
});

test.describe('Account Deletion Tests', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('GitHub dialog should load and show connection options', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    // The GitHub dialog should be visible with connection tab
    await expect(dialogs.github.connectionTab).toBeVisible();
  });

  test('Profile manager should have New Profile button', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    // Profile manager should be open with the New Profile button
    await expect(dialogs.profileManager.addProfileButton).toBeVisible();
  });
});

// ============================================================================
// Integration Dialog Tests - Account Selector
// ============================================================================

test.describe('GitHub Dialog - Account Selector', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [testProfiles.work],
      accounts: [testAccounts.githubWork, testAccounts.githubPersonal],
      connectedAccounts: ['account-github-work'], // Work account is connected
    });

    // The GitHub dialog calls loadInitialData() -> loadUnifiedProfiles() which resets the store.
    // Inject mocks so the store data is preserved.
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [testProfiles.work],
        accounts: [testAccounts.githubWork, testAccounts.githubPersonal],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      load_unified_profile_for_repository: testProfiles.work,
    });
  });

  test('should show account selector when multiple accounts exist', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.github.dialog).toBeVisible();

    // gn-account-selector is rendered when accounts exist in the store
    const accountSelector = page.locator('gn-account-selector');
    await expect(accountSelector).toBeVisible();
  });

  test('should display connected account in selector', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    // Should show the connected account name in the account selector
    await expect(page.getByText('Work GitHub').first()).toBeVisible();
  });

  test('should show dropdown with all accounts when clicked', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    // Click the account selector button to open dropdown
    const selectorBtn = page.locator('gn-account-selector .selector-btn');
    await expect(selectorBtn).toBeVisible();
    await selectorBtn.click();

    // Should show both accounts in the dropdown
    await expect(page.getByText('Work GitHub').first()).toBeVisible();
    await expect(page.getByText('Personal GitHub').first()).toBeVisible();
  });

  test('should show Add Account option in dropdown', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    // Click the account selector button to open dropdown
    const selectorBtn = page.locator('gn-account-selector .selector-btn');
    await expect(selectorBtn).toBeVisible();
    await selectorBtn.click();

    // Should have Add Account option in dropdown
    await expect(page.getByText('Add Account').first()).toBeVisible();
  });
});

// ============================================================================
// Integration Dialog Tests - Connection State
// ============================================================================

test.describe('GitHub Dialog - Connection States', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test('should show disconnected state when no accounts connected', async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [testProfiles.work],
      accounts: [testAccounts.githubWork],
      connectedAccounts: [], // No connected accounts
    });

    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    // Dialog should have sign-in options (button may appear multiple times, use first)
    const githubDialog = page.locator('gn-github-dialog');
    await expect(githubDialog.getByRole('button', { name: /sign in with github/i }).first()).toBeVisible();
  });

  test('should show connected state with user info', async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [testProfiles.work],
      accounts: [testAccounts.githubWork],
      connectedAccounts: ['account-github-work'],
    });

    // Inject mocks so store data is preserved when the dialog calls loadInitialData()
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [testProfiles.work],
        accounts: [testAccounts.githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      load_unified_profile_for_repository: testProfiles.work,
      // Mock check_github_connection to return connected state with user info
      check_github_connection: { connected: true, user: { login: 'johndoe-work', name: 'John Doe', email: 'john.doe@company.com', avatarUrl: null } },
    });

    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    // The account selector shows the account name and cached username from the store
    const githubDialog = page.locator('gn-github-dialog');
    // Account selector shows cached username @johndoe-work
    await expect(githubDialog.getByText(/johndoe-work/).first()).toBeVisible();
  });

  test('should have disconnect option when connected', async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [testProfiles.work],
      accounts: [testAccounts.githubWork],
      connectedAccounts: ['account-github-work'],
    });

    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    // Connection tab should have sign-in options (for re-auth or switching accounts)
    const githubDialog = page.locator('gn-github-dialog');
    // The dialog should have connection options available
    await expect(githubDialog.getByRole('button', { name: 'Connection' })).toBeVisible();
  });
});

// ============================================================================
// Integration Dialog Tests - All Platforms
// ============================================================================

test.describe('Integration Dialogs - Platform Tabs', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('GitHub should have Connection, PRs, Issues, Releases, Actions tabs', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.github.connectionTab).toBeVisible();
    await expect(dialogs.github.pullRequestsTab).toBeVisible();
    await expect(dialogs.github.issuesTab).toBeVisible();
    await expect(dialogs.github.releasesTab).toBeVisible();
    await expect(dialogs.github.actionsTab).toBeVisible();
  });

  test('GitLab should have Connection, MRs, Issues, Pipelines tabs', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitLab Integration');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.gitlab.connectionTab).toBeVisible();
    await expect(dialogs.gitlab.mergeRequestsTab).toBeVisible();
    await expect(dialogs.gitlab.issuesTab).toBeVisible();
    await expect(dialogs.gitlab.pipelinesTab).toBeVisible();
  });

  test('Azure DevOps should have Connection, PRs, Work Items, Pipelines tabs', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Azure DevOps');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.azureDevOps.connectionTab).toBeVisible();
    await expect(dialogs.azureDevOps.pullRequestsTab).toBeVisible();
    await expect(dialogs.azureDevOps.workItemsTab).toBeVisible();
    await expect(dialogs.azureDevOps.pipelinesTab).toBeVisible();
  });

  test('Bitbucket should have Connection, PRs, Issues, Pipelines tabs', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Bitbucket');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.bitbucket.connectionTab).toBeVisible();
    await expect(dialogs.bitbucket.pullRequestsTab).toBeVisible();
    await expect(dialogs.bitbucket.issuesTab).toBeVisible();
    await expect(dialogs.bitbucket.pipelinesTab).toBeVisible();
  });
});

// ============================================================================
// Profile Creation Flow Tests
// ============================================================================

test.describe('Profile Creation Flow', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should have save/create button in profile form', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    await dialogs.profileManager.addProfileButton.click();

    // Save/create button should exist
    const saveButton = page.getByRole('button', { name: 'Save Profile' });
    await expect(saveButton).toBeVisible();
  });

  test('should have color picker for profile', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    await dialogs.profileManager.addProfileButton.click();

    // Should have color selection - look for color swatches
    const colorOptions = page.locator('.color-option, .color-swatch, .color-picker button');
    const colorCount = await colorOptions.count();
    expect(colorCount).toBeGreaterThan(0);
  });

  test('should have URL patterns textarea', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    await dialogs.profileManager.addProfileButton.click();

    // URL patterns field has placeholder "github.com/mycompany/*..."
    const urlPatternsInput = page.getByRole('textbox', {
      name: /github\.com\/mycompany/i,
    });

    await expect(urlPatternsInput).toBeVisible();
  });
});

// ============================================================================
// Account Addition Flow Tests
// ============================================================================

test.describe('Account Addition Flow', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('GitHub should show PAT token input', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    // Switch to PAT mode if toggle exists
    await dialogs.github.selectPATMethod();

    // Should show token input
    await expect(dialogs.github.tokenInput).toBeVisible();
  });

  test('GitLab should have instance URL input', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitLab Integration');
    await dialogs.commandPalette.executeFirst();

    // Should have instance URL field
    await expect(dialogs.gitlab.instanceUrlInput).toBeVisible();
  });

  test('Azure DevOps should have organization input', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Azure DevOps');
    await dialogs.commandPalette.executeFirst();

    // Should have organization field
    await expect(dialogs.azureDevOps.organizationInput).toBeVisible();
  });

  test('Bitbucket should have app password inputs', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Bitbucket');
    await dialogs.commandPalette.executeFirst();

    // Switch to app password mode
    await dialogs.bitbucket.selectAppPasswordMethod();

    // Should have username and password fields
    await expect(dialogs.bitbucket.usernameInput).toBeVisible();
    await expect(dialogs.bitbucket.appPasswordInput).toBeVisible();
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

test.describe('Error Handling', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should allow entering token in GitHub dialog', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await dialogs.github.selectPATMethod();
    await dialogs.github.tokenInput.fill('test-token-12345');

    // Token should be entered
    await expect(dialogs.github.tokenInput).toHaveValue('test-token-12345');
  });

  test('connect button should be present for PAT auth', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await dialogs.github.selectPATMethod();

    // Connect button should exist
    await expect(dialogs.github.connectButton).toBeVisible();
  });
});

// ============================================================================
// Profile CRUD E2E Tests
// ============================================================================

test.describe('Profile CRUD Operations', () => {
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('create profile end-to-end: fill form, save, verify save_unified_profile command called', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.profileManager.addProfileButton).toBeVisible();
    await dialogs.profileManager.addProfileButton.click();

    // Fill in the profile form
    await dialogs.profileManager.fillProfileForm({
      name: 'CI/CD',
      gitName: 'CI Bot',
      gitEmail: 'ci@company.com',
    });

    // Start capturing commands before clicking save
    // The actual Tauri command is save_unified_profile (not save_profile)
    await startCommandCaptureWithMocks(page, {
      save_unified_profile: { profile: { id: 'profile-cicd', name: 'CI/CD', gitName: 'CI Bot', gitEmail: 'ci@company.com', signingKey: null, urlPatterns: [], isDefault: false, color: '#3b82f6', defaultAccounts: {} }, failedRepositories: [] },
    });

    // Click the save button
    const saveButton = page.getByRole('button', { name: 'Save Profile' });
    await saveButton.click();

    await waitForCommand(page, 'save_unified_profile');

    const saveCommands = await findCommand(page, 'save_unified_profile');
    expect(saveCommands.length).toBeGreaterThan(0);
  });

  test('delete profile should invoke delete_profile command', async ({ page }) => {
    // Set up with existing profiles
    await setupProfilesAndAccounts(page, {
      profiles: [testProfiles.work, testProfiles.personal],
      accounts: [testAccounts.githubWork],
    });

    dialogs = new DialogsPage(page);

    // The dialog calls loadProfiles() on open, which invokes get_unified_profiles_config.
    // The default mock returns empty profiles, so inject a mock that returns our test data.
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [testProfiles.work, testProfiles.personal],
        accounts: [testAccounts.githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });

    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    await expect(page.getByRole('button', { name: 'New Profile' })).toBeVisible();

    // Start capturing commands with mock for delete
    await startCommandCaptureWithMocks(page, {
      delete_unified_profile: null,
    });

    // Mock the Tauri confirm dialog used by showConfirm() in handleDelete
    await autoConfirmDialogs(page);

    // Click the delete button on the Personal profile (second profile card)
    const deleteButton = page.getByRole('button', { name: 'Delete profile' }).last();
    await expect(deleteButton).toBeVisible({ timeout: 3000 });
    await deleteButton.click();

    await expect.poll(async () => {
      const cmds = await findCommand(page, 'delete_unified_profile');
      return cmds.length;
    }).toBeGreaterThan(0);
  });

  test('apply profile should invoke apply_unified_profile command', async ({ page }) => {
    // Set up with existing profiles
    await setupProfilesAndAccounts(page, {
      profiles: [testProfiles.work, testProfiles.personal],
      accounts: [testAccounts.githubWork],
    });

    dialogs = new DialogsPage(page);

    // Inject mock so loadProfiles() returns our test data
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [testProfiles.work, testProfiles.personal],
        accounts: [testAccounts.githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });

    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    await expect(page.getByRole('button', { name: 'New Profile' })).toBeVisible();

    // Start capturing commands - real command is apply_unified_profile
    await startCommandCaptureWithMocks(page, {
      apply_unified_profile: null,
    });

    // Click "Apply to current repository" button (the action-btn with checkmark icon and title)
    const applyButton = page.locator('button[title="Apply to current repository"]').first();
    await applyButton.click();

    await waitForCommand(page, 'apply_unified_profile');

    const applyCommands = await findCommand(page, 'apply_unified_profile');
    expect(applyCommands.length).toBeGreaterThan(0);
  });

  test('save profile form should include git name and email in command args', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    await dialogs.profileManager.addProfileButton.click();

    // Fill in form
    await dialogs.profileManager.fillProfileForm({
      name: 'Test Profile',
      gitName: 'Test Author',
      gitEmail: 'author@test.com',
    });

    // The actual Tauri command is save_unified_profile
    await startCommandCaptureWithMocks(page, {
      save_unified_profile: { profile: { id: 'profile-test', name: 'Test Profile', gitName: 'Test Author', gitEmail: 'author@test.com', signingKey: null, urlPatterns: [], isDefault: false, color: '#3b82f6', defaultAccounts: {} }, failedRepositories: [] },
    });

    const saveButton = page.getByRole('button', { name: 'Save Profile' });
    await saveButton.click();

    await waitForCommand(page, 'save_unified_profile');

    const commands = await findCommand(page, 'save_unified_profile');
    expect(commands.length).toBeGreaterThan(0);

    // Verify the args contain the profile data
    const args = commands[0].args as Record<string, unknown>;
    // The profile data should be somewhere in the args
    const argsStr = JSON.stringify(args);
    expect(argsStr).toContain('Test Author');
    expect(argsStr).toContain('author@test.com');
  });

  test('cancel button in profile form should return to profile list', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    await dialogs.profileManager.addProfileButton.click();

    // The form should be visible
    await expect(page.getByPlaceholder('John Doe')).toBeVisible();

    // Click the Cancel button in the dialog footer (not the back-btn in header)
    const cancelButton = page.getByRole('button', { name: 'Cancel', exact: true });
    await cancelButton.click();

    await expect(dialogs.profileManager.addProfileButton).toBeVisible();
  });

  test('profile form should validate required fields', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    await dialogs.profileManager.addProfileButton.click();

    // Save button should be present
    const saveButton = page.getByRole('button', { name: 'Save Profile' });
    await expect(saveButton).toBeVisible();

    // Without filling any fields, clicking save should show a validation error toast
    // (the component validates in handleSave() and shows toast errors, button is not disabled)
    await saveButton.click();

    // Should show error toast about required field (name, git name, or email)
    await expect(page.locator('.toast, .error, [class*="toast"]').first()).toBeVisible({ timeout: 3000 });
  });

  test('profile creation error should show error feedback', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    await dialogs.profileManager.addProfileButton.click();

    await dialogs.profileManager.fillProfileForm({
      name: 'Error Profile',
      gitName: 'Error User',
      gitEmail: 'error@test.com',
    });

    // Inject error for save commands
    await injectCommandError(page, 'save_unified_profile', 'Failed to save profile: disk full');
    await injectCommandError(page, 'save_profile', 'Failed to save profile: disk full');
    await injectCommandError(page, 'create_profile', 'Failed to save profile: disk full');

    const saveButton = page.getByRole('button', { name: 'Save Profile' });
    await saveButton.click();

    // Error feedback should appear as a toast notification. Filtered to visible
    // before .first(): `[class*="error"]` matches any element whose class merely
    // CONTAINS "error" anywhere on the page, and .first() takes them in DOM
    // order, so a hidden error element in an unrelated panel shadowed the toast.
    await expect(
      page
        .locator('.toast, .error-banner, [class*="error"]')
        .filter({ visible: true })
        .first()
    ).toBeVisible({ timeout: 5000 });
  });

  test('color picker should highlight selected color', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    await dialogs.profileManager.addProfileButton.click();

    const colorOptions = page.locator('.color-option, .color-swatch, .color-picker button');
    const colorCount = await colorOptions.count();
    expect(colorCount).toBeGreaterThan(0);

    // Click the second color option
    await colorOptions.nth(1).click();

    // The selected color should have a visual indicator (selected class, border, etc.)
    const selectedColor = page.locator('.color-option.selected, .color-swatch.selected, .color-option[aria-selected="true"]');
    await expect(selectedColor).toBeVisible();
  });
});

// ============================================================================
// Profiles - UI Outcome Verification Tests
// ============================================================================

test.describe('Profiles - UI Outcome Verification', () => {
  let dialogs: DialogsPage;

  test('save: verify dialog closes form and profile appears in list', async ({ page }) => {
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);

    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.profileManager.addProfileButton).toBeVisible();
    await dialogs.profileManager.addProfileButton.click();

    // Fill in the profile form
    await dialogs.profileManager.fillProfileForm({
      name: 'Automation',
      gitName: 'Auto Bot',
      gitEmail: 'auto@company.com',
    });

    // Mock save to return the new profile, and mock get_unified_profiles_config
    // to return the updated list including the new profile
    const newProfile = {
      id: 'profile-automation',
      name: 'Automation',
      gitName: 'Auto Bot',
      gitEmail: 'auto@company.com',
      signingKey: null,
      urlPatterns: [],
      isDefault: false,
      color: '#3b82f6',
      defaultAccounts: {},
    };

    await startCommandCaptureWithMocks(page, {
      save_unified_profile: { profile: newProfile, failedRepositories: [] },
      get_unified_profiles_config: {
        version: 3,
        profiles: [newProfile],
        accounts: [],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });

    // Click save
    const saveButton = page.getByRole('button', { name: 'Save Profile' });
    await saveButton.click();

    // After save, the form should close and the profile list should be visible
    // The "New Profile" button reappears when we're back in list view
    await expect(dialogs.profileManager.addProfileButton).toBeVisible({ timeout: 5000 });

    // The newly created profile name should appear in the profile list
    await expect(page.getByText('Automation').first()).toBeVisible();
    await expect(page.getByText('auto@company.com').first()).toBeVisible();
  });

  test('delete: verify profile removed from UI', async ({ page }) => {
    dialogs = new DialogsPage(page);

    // Set up with two profiles so we can delete one
    await setupProfilesAndAccounts(page, {
      profiles: [testProfiles.work, testProfiles.personal],
      accounts: [testAccounts.githubWork],
    });

    // Inject mock so loadProfiles() returns our test data
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [testProfiles.work, testProfiles.personal],
        accounts: [testAccounts.githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });

    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    // Wait for dialog with profiles loaded
    await expect(page.getByRole('button', { name: 'New Profile' })).toBeVisible();

    // Verify both profiles are visible before deletion
    await expect(page.getByText(/johnd@personal\.com/)).toBeVisible();
    await expect(page.getByText(/john\.doe@company\.com/).first()).toBeVisible();

    // Mock delete command; after delete, the store removes the profile reactively
    await startCommandCaptureWithMocks(page, {
      delete_unified_profile: null,
    });

    // Mock the Tauri confirm dialog used by showConfirm() in handleDelete
    await autoConfirmDialogs(page);

    // Click the delete button on the Personal profile (second profile card)
    const deleteButton = page.getByRole('button', { name: 'Delete profile' }).last();
    await expect(deleteButton).toBeVisible({ timeout: 3000 });
    await deleteButton.click();

    // Wait for the delete command to be invoked
    await expect.poll(async () => {
      const cmds = await findCommand(page, 'delete_unified_profile');
      return cmds.length;
    }).toBeGreaterThan(0);

    // After deletion and reload, the Personal profile email should no longer be visible
    await expect(page.getByText(/johnd@personal\.com/)).not.toBeVisible({ timeout: 5000 });

    // The Work profile should still be present
    await expect(page.getByText(/john\.doe@company\.com/).first()).toBeVisible();
  });

  test('apply: verify profile status updates with UI feedback', async ({ page }) => {
    dialogs = new DialogsPage(page);

    // Set up with existing profiles
    await setupProfilesAndAccounts(page, {
      profiles: [testProfiles.work, testProfiles.personal],
      accounts: [testAccounts.githubWork],
    });

    // Inject mock so loadProfiles() returns our test data
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [testProfiles.work, testProfiles.personal],
        accounts: [testAccounts.githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });

    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Profiles & Accounts');
    await dialogs.commandPalette.executeFirst();

    // Wait for dialog with profiles loaded
    await expect(page.getByRole('button', { name: 'New Profile' })).toBeVisible();

    // Start capturing commands with mock for apply
    await startCommandCaptureWithMocks(page, {
      apply_unified_profile: null,
    });

    // Click "Apply to current repository" button
    const applyButton = page.locator('button[title="Apply to current repository"]').first();
    await applyButton.click();

    // Wait for the apply command to be invoked
    await waitForCommand(page, 'apply_unified_profile');

    const applyCommands = await findCommand(page, 'apply_unified_profile');
    expect(applyCommands.length).toBeGreaterThan(0);

    // After applying, there should be some UI feedback - either a toast notification
    // or an "Applied" badge/status indicator on the profile card
    const feedbackLocator = page.locator(
      '.toast, [class*="toast"], .applied-badge, .profile-item .status, .success-indicator'
    );
    await expect(feedbackLocator.first()).toBeVisible({ timeout: 5000 });
  });
});

// ============================================================================
// Wave 5a: Discoverability without an open repository
// ============================================================================

test.describe('Profiles & Accounts discoverability (no repository open)', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    // No repository: only mock IPC and navigate, do NOT initialize the repo store.
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    // The welcome screen is the no-repo state.
    await expect(app.welcomeScreen).toBeVisible();
  });

  test('welcome screen exposes a Profiles & Accounts action that opens the manager', async ({ page }) => {
    const action = page.locator('gn-welcome button.action-btn', { hasText: 'Profiles & Accounts' });
    await expect(action).toBeVisible();
    await action.click();

    // Manager opens even with no repository, and shows the explainer + title.
    await expect(dialogs.profileManager.addProfileButton).toBeVisible();
    await expect(page.locator('gn-profile-manager-dialog .dialog-title')).toContainText(
      'Profiles & Accounts',
    );
    await expect(page.locator('gn-profile-manager-dialog .view-explainer')).toContainText(
      'Profiles set your git identity per repository',
    );
  });

  test('Settings has a Profiles & Accounts section that opens the manager and closes Settings', async ({ page }) => {
    await page.keyboard.press('Meta+,');
    await expect(dialogs.settings.dialog).toBeVisible();

    const openBtn = page.locator('gn-settings-dialog button', {
      hasText: 'Open Profiles & Accounts',
    });
    await expect(openBtn).toBeVisible();
    await openBtn.click();

    // Settings closes and the manager opens.
    await expect(dialogs.settings.dialog).not.toBeVisible();
    await expect(dialogs.profileManager.addProfileButton).toBeVisible();
    await expect(page.locator('gn-profile-manager-dialog .dialog-title')).toContainText(
      'Profiles & Accounts',
    );
  });

  test('command palette opens the GitHub integration dialog with no repository open', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    // Dialog opens (account management is repo-independent); no "open a
    // repository first" warning toast is shown.
    await expect(page.getByRole('dialog', { name: 'GitHub' })).toBeVisible();
    await expect(
      page.locator('.toast', { hasText: 'Please open a repository first' }),
    ).toHaveCount(0);
  });

  test('connecting a GitHub account works with no repository (error path surfaced)', async ({ page }) => {
    await injectCommandError(page, 'check_github_connection', 'Bad credentials');

    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();
    await expect(page.getByRole('dialog', { name: 'GitHub' })).toBeVisible();

    // Switch to PAT auth, enter a token, attempt connect.
    if (await dialogs.github.authMethodToggle.isVisible()) {
      await expect(dialogs.github.patButton).toBeVisible();
      await dialogs.github.patButton.click();
    }
    await dialogs.github.tokenInput.fill('ghp_invalid');
    await dialogs.github.connectButton.click();

    // Error is surfaced to the user (not silent), still with no repository open.
    await expect(page.locator('gn-github-dialog .error-message')).toBeVisible();
    await expect(page.locator('gn-github-dialog .error-message')).toContainText('Bad credentials');
  });
});
