/**
 * Profiles & integrations management — E2E validation
 *
 * Covers user-visible profile/account management behavior:
 *   - Account config fields are editable (GitLab instance URL, ADO org, Bitbucket workspace)
 *   - Migration "complete" view is honest about partial failures
 *   - Profile delete confirmation copy ("...remain available globally")
 *   - Single-repo unassign from a profile's assigned-repositories view
 *   - Profile switch failure surfaces an error (no silent failure)
 *   - Default-account badges: "Profile default" vs "Global default"
 *   - GitLab account delete error is surfaced
 *   - GitHub App connect honors the backend `connected` flag
 *
 * Conventions follow profiles-integrations*.spec.ts: standardized helpers,
 * auto-retrying assertions (no waitForTimeout), shadow-DOM-piercing locators,
 * and verification of UI outcomes (not just that a command was called).
 */

import { test, expect, Page } from '@playwright/test';
import {
  setupOpenRepository,
  setupProfilesAndAccounts,
  type MockUnifiedProfile,
  type MockIntegrationAccount,
} from '../fixtures/tauri-mock';
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

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const workProfile: MockUnifiedProfile = {
  id: 'profile-work',
  name: 'Work',
  gitName: 'John Doe',
  gitEmail: 'john.doe@company.com',
  signingKey: null,
  urlPatterns: [],
  isDefault: true,
  color: '#3b82f6',
  defaultAccounts: {},
};

const gitlabAccount: MockIntegrationAccount = {
  id: 'account-gitlab',
  name: 'Company GitLab',
  integrationType: 'gitlab',
  config: { type: 'gitlab', instanceUrl: 'https://gitlab.com' },
  color: '#fc6d26',
  cachedUser: { username: 'jdoe', displayName: 'John Doe', avatarUrl: null },
  urlPatterns: [],
  isDefault: true,
};

const adoAccount: MockIntegrationAccount = {
  id: 'account-ado',
  name: 'Company Azure',
  integrationType: 'azure-devops',
  config: { type: 'azure-devops', organization: 'acme' },
  color: '#0078d4',
  cachedUser: { username: 'jdoe', displayName: 'John Doe', avatarUrl: null },
  urlPatterns: [],
  isDefault: false,
};

const bitbucketAccount: MockIntegrationAccount = {
  id: 'account-bb',
  name: 'Company Bitbucket',
  integrationType: 'bitbucket',
  config: { type: 'bitbucket', workspace: 'acme-team' },
  color: '#2684ff',
  cachedUser: { username: 'jdoe', displayName: 'John Doe', avatarUrl: null },
  urlPatterns: [],
  isDefault: false,
};

const githubAccount: MockIntegrationAccount = {
  id: 'account-github',
  name: 'Company GitHub',
  integrationType: 'github',
  config: { type: 'github' },
  color: '#3b82f6',
  cachedUser: { username: 'jdoe', displayName: 'John Doe', avatarUrl: null },
  urlPatterns: [],
  isDefault: false,
};

async function openProfileManager(page: Page, dialogs: DialogsPage): Promise<void> {
  await dialogs.commandPalette.open();
  await dialogs.commandPalette.search('Profiles & Accounts');
  await dialogs.commandPalette.executeFirst();
  await expect(page.getByRole('button', { name: 'New Profile' })).toBeVisible();
}

/**
 * From the profile manager, navigate to the standalone "Accounts" view
 * then open the edit screen for the (only) account by clicking its pencil
 * (non-delete) action button.
 */
async function openAccountEditFromAccountsView(page: Page): Promise<void> {
  await page
    .locator('gn-profile-manager-dialog .dialog-footer')
    .getByRole('button', { name: 'Accounts' })
    .click();
  await expect(page.locator('gn-profile-manager-dialog .dialog-title')).toContainText(
    'Accounts',
  );
  await page
    .locator('gn-profile-manager-dialog .accounts-list .account-item .account-actions .action-btn:not(.delete)')
    .first()
    .click();
  await expect(page.locator('gn-profile-manager-dialog .dialog-title')).toContainText(
    'Edit Account',
  );
}

// ===========================================================================
// 1. Account config fields are editable
// ===========================================================================

test.describe('account config fields are editable', () => {
  test('GitLab account edit shows an editable instance-URL field and persists the value', async ({
    page,
  }) => {
    const dialogs = new DialogsPage(page);
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [gitlabAccount],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [gitlabAccount],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });

    await openProfileManager(page, dialogs);
    await openAccountEditFromAccountsView(page);

    // The GitLab instance URL field renders (previously it never did).
    const instanceUrlInput = page.locator('gn-profile-manager-dialog input[type="url"]');
    await expect(instanceUrlInput).toBeVisible();
    await expect(instanceUrlInput).toHaveValue('https://gitlab.com');

    // Edit it to a self-hosted URL and save.
    await instanceUrlInput.fill('https://gitlab.acme.com');

    await startCommandCaptureWithMocks(page, {
      save_global_account: { ...gitlabAccount, config: { type: 'gitlab', instanceUrl: 'https://gitlab.acme.com' } },
    });
    await page.getByRole('button', { name: 'Save Account' }).click();
    await waitForCommand(page, 'save_global_account');

    // The edited instance URL is sent in save_global_account's account config.
    const cmds = await findCommand(page, 'save_global_account');
    const account = (cmds[cmds.length - 1].args as { account: { config: { instanceUrl?: string } } })
      .account;
    expect(account.config.instanceUrl).toBe('https://gitlab.acme.com');
  });

  test('Azure DevOps account edit shows an editable Organization field', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [adoAccount],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [adoAccount],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });

    await openProfileManager(page, dialogs);
    await openAccountEditFromAccountsView(page);

    const orgInput = page.locator('gn-profile-manager-dialog input[placeholder="my-organization"]');
    await expect(orgInput).toBeVisible();
    await expect(orgInput).toHaveValue('acme');

    await orgInput.fill('acme-corp');
    await startCommandCaptureWithMocks(page, {
      save_global_account: { ...adoAccount, config: { type: 'azure-devops', organization: 'acme-corp' } },
    });
    await page.getByRole('button', { name: 'Save Account' }).click();
    await waitForCommand(page, 'save_global_account');

    const cmds = await findCommand(page, 'save_global_account');
    const account = (cmds[cmds.length - 1].args as { account: { config: { organization?: string } } })
      .account;
    expect(account.config.organization).toBe('acme-corp');
  });

  test('Bitbucket account edit shows an editable Workspace field', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [bitbucketAccount],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [bitbucketAccount],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });

    await openProfileManager(page, dialogs);
    await openAccountEditFromAccountsView(page);

    const workspaceInput = page.locator('gn-profile-manager-dialog input[placeholder="my-workspace"]');
    await expect(workspaceInput).toBeVisible();
    await expect(workspaceInput).toHaveValue('acme-team');

    await workspaceInput.fill('acme-eng');
    await startCommandCaptureWithMocks(page, {
      save_global_account: { ...bitbucketAccount, config: { type: 'bitbucket', workspace: 'acme-eng' } },
    });
    await page.getByRole('button', { name: 'Save Account' }).click();
    await waitForCommand(page, 'save_global_account');

    const cmds = await findCommand(page, 'save_global_account');
    const account = (cmds[cmds.length - 1].args as { account: { config: { workspace?: string } } })
      .account;
    expect(account.config.workspace).toBe('acme-eng');
  });
});

// ===========================================================================
// 2. Migration "complete" view is honest about partial failures
// ===========================================================================

test.describe('migration honest results', () => {
  const backupInfo = {
    hasBackup: true,
    backupDate: '2026-01-01T12:00:00Z',
    profilesCount: 1,
    accountsCount: 1,
  };

  const preview = {
    profiles: [
      {
        profileId: 'profile-work',
        profileName: 'Work',
        gitEmail: 'john.doe@company.com',
        matchedAccounts: [],
      },
    ],
    unmatchedAccounts: [],
  };

  async function openMigrationViaRestore(page: Page, dialogs: DialogsPage): Promise<void> {
    await openProfileManager(page, dialogs);
    const backupToggle = page.locator('gn-profile-manager-dialog .backup-toggle');
    await expect(backupToggle).toBeVisible();
    await backupToggle.click();
    const restoreBtn = page.getByRole('button', { name: 'Restore Backup' });
    await expect(restoreBtn).toBeVisible();
    await restoreBtn.click();
    // The migration dialog overlay must appear (host has zero dimensions; assert
    // on the overlay child like the existing restore-backup test does).
    await expect(page.locator('gn-migration-dialog[open] .dialog-overlay')).toBeVisible();
  }

  async function driveToComplete(page: Page): Promise<void> {
    // intro → preview
    await page.locator('gn-migration-dialog button.btn-primary', { hasText: 'Continue' }).click();
    await expect(page.locator('gn-migration-dialog .dialog-title')).toContainText(
      'Review Migration',
    );
    // preview → execute (→ complete)
    await page
      .locator('gn-migration-dialog button.btn-primary', { hasText: 'Start Migration' })
      .click();
  }

  test('a failed migration shows a warning + skipped items, NOT "All Done!"', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await setupProfilesAndAccounts(page, { profiles: [workProfile], accounts: [] });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [],
        repositoryAssignments: {},
      },
      get_migration_backup_info: backupInfo,
      restore_migration_backup: backupInfo,
      preview_unified_profiles_migration: preview,
      execute_unified_profiles_migration: {
        success: false,
        profilesMigrated: 1,
        accountsMigrated: 0,
        unmatchedAccounts: [],
        errors: ['Account "Legacy GitLab" could not be matched to a profile'],
      },
    });
    await autoConfirmDialogs(page);

    await openMigrationViaRestore(page, dialogs);
    await driveToComplete(page);

    // The honest "completed with issues" view — NOT the green All Done.
    await expect(page.locator('gn-migration-dialog')).toContainText(
      'Migration Completed With Issues',
    );
    await expect(page.locator('gn-migration-dialog')).not.toContainText('All Done!');
    // The skipped item is listed.
    await expect(page.locator('gn-migration-dialog .error-list .error-item')).toContainText(
      'Legacy GitLab',
    );
    // And the "Review in Profile Manager" escape hatch is offered.
    await expect(
      page.locator('gn-migration-dialog').getByRole('button', { name: 'Review in Profile Manager' }),
    ).toBeVisible();
  });

  test('a successful migration shows "All Done!" and no warning', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await setupProfilesAndAccounts(page, { profiles: [workProfile], accounts: [] });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [],
        repositoryAssignments: {},
      },
      get_migration_backup_info: backupInfo,
      restore_migration_backup: backupInfo,
      preview_unified_profiles_migration: preview,
      execute_unified_profiles_migration: {
        success: true,
        profilesMigrated: 1,
        accountsMigrated: 1,
        unmatchedAccounts: [],
        errors: [],
      },
    });
    await autoConfirmDialogs(page);

    await openMigrationViaRestore(page, dialogs);
    await driveToComplete(page);

    await expect(page.locator('gn-migration-dialog')).toContainText('All Done!');
    await expect(page.locator('gn-migration-dialog')).not.toContainText(
      'Migration Completed With Issues',
    );
    await expect(
      page.locator('gn-migration-dialog').getByRole('button', { name: 'Review in Profile Manager' }),
    ).toHaveCount(0);
  });
});

// ===========================================================================
// 3. Profile delete confirmation copy
// ===========================================================================

test.describe('profile delete confirmation copy', () => {
  test('confirm text reads "remain available globally" and not the old removal copy', async ({
    page,
  }) => {
    const dialogs = new DialogsPage(page);
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubAccount],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubAccount],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      delete_unified_profile: null,
    });

    await openProfileManager(page, dialogs);

    // Capture the confirm dialog message (plugin:dialog|message). Reject so the
    // profile is NOT actually deleted — we only care about the copy.
    await startCommandCaptureWithMocks(page, {
      'plugin:dialog|confirm': false,
      'plugin:dialog|ask': false,
    });

    await page.getByRole('button', { name: 'Delete profile' }).first().click();
    await waitForCommand(page, 'plugin:dialog|message');

    const confirms = await findCommand(page, 'plugin:dialog|message');
    expect(confirms.length).toBeGreaterThan(0);
    const message = (confirms[confirms.length - 1].args as { message: string }).message;
    expect(message).toContain('remain available globally');
    expect(message).not.toContain('remove all associated integration accounts');
  });
});

// ===========================================================================
// 4. Single-repo unassign from a profile's assigned-repositories view
// ===========================================================================

test.describe('single-repo unassign', () => {
  test('clicking a per-row unassign calls unassign_unified_profile_from_repository and removes the row', async ({
    page,
  }) => {
    const dialogs = new DialogsPage(page);
    const repoPath = '/tmp/test-repo';

    // The repo is assigned to the Work profile; the assigned-repositories list
    // reads from the store's repositoryAssignments.
    await setupProfilesAndAccounts(
      page,
      {
        profiles: [workProfile],
        accounts: [],
        repositoryAssignments: { [repoPath]: workProfile.id },
      },
    );
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [],
        repositoryAssignments: { [repoPath]: workProfile.id },
      },
      get_migration_backup_info: { hasBackup: false },
    });

    await openProfileManager(page, dialogs);
    // Enter edit mode for the Work profile so the Assigned Repositories section shows.
    await page.locator('.profile-item').first().click();
    await expect(page.getByRole('button', { name: 'Save Profile' })).toBeVisible();

    // The assigned-repositories section lists the one assigned repo.
    const assignedSection = page
      .locator('gn-profile-manager-dialog .accounts-section')
      .filter({ hasText: 'Assigned Repositories' });
    const repoRow = assignedSection.locator('.account-item');
    await expect(repoRow).toHaveCount(1);
    await expect(repoRow.first()).toContainText('test-repo');

    // After unassigning, the backend reload returns no assignments.
    await startCommandCaptureWithMocks(page, {
      unassign_unified_profile_from_repository: null,
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [],
        repositoryAssignments: {},
      },
    });

    // Click the per-row unassign (the delete X in the row's actions).
    await repoRow
      .first()
      .locator('.account-actions .action-btn.delete')
      .click();

    await waitForCommand(page, 'unassign_unified_profile_from_repository');
    const cmds = await findCommand(page, 'unassign_unified_profile_from_repository');
    expect(cmds.length).toBeGreaterThan(0);

    // The row disappears and a success toast confirms the unassign.
    await expect(repoRow).toHaveCount(0, { timeout: 5000 });
    await expect(
      page.locator('gn-toast-container .toast.success .toast-message'),
    ).toContainText(/Unassigned/i, { timeout: 5000 });
  });
});

// ===========================================================================
// 5. Profile switch failure surfaces an error (no silent failure)
// ===========================================================================

test.describe('profile switch error is surfaced', () => {
  const personalProfile: MockUnifiedProfile = {
    ...workProfile,
    id: 'profile-personal',
    name: 'Personal',
    gitEmail: 'johnd@personal.com',
    isDefault: false,
    color: '#10b981',
  };

  // Both apply paths must surface failures via a visible error toast: the
  // Profile Manager's "Apply to current repository" button and the dashboard
  // profile dropdown.
  test('a failed apply from the profile manager surfaces an error toast', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile, personalProfile],
      accounts: [],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile, personalProfile],
        accounts: [],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });

    await openProfileManager(page, dialogs);

    const backendMessage = 'Profile apply failed: git config is locked';
    await injectCommandError(page, 'apply_unified_profile', backendMessage);

    await page.locator('button[title="Apply to current repository"]').first().click();

    const errorToast = page.locator('gn-toast-container .toast.error .toast-message');
    await expect(errorToast).toBeVisible({ timeout: 5000 });
    await expect(errorToast).toContainText(backendMessage);
  });

  test('a failed apply from the dashboard dropdown surfaces an error toast', async ({
    page,
  }) => {
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile, personalProfile],
      accounts: [],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile, personalProfile],
        accounts: [],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });

    // Toolbar starts on the default (Work) profile.
    await expect(page.locator('gn-context-dashboard .profile-name').first()).toHaveText('Work');

    const backendMessage = 'Profile apply failed: git config is locked';
    await injectCommandError(page, 'apply_unified_profile', backendMessage);

    // Switch profile via the dashboard dropdown.
    await page.locator('gn-context-dashboard .profile-selector-btn').click();
    await page
      .locator('gn-context-dashboard .profile-dropdown .dropdown-item', { hasText: 'Personal' })
      .click();

    // The failure must be surfaced as a visible error toast (the repository
    // store error field has no render sink).
    const errorToast = page.locator('gn-toast-container .toast.error .toast-message');
    await expect(errorToast).toBeVisible({ timeout: 5000 });
    await expect(errorToast).toContainText('Failed to switch profile');
  });
});

// ===========================================================================
// 6. Default-account badges: "Profile default" vs "Global default"
// ===========================================================================

test.describe('default-account badges', () => {
  // The integration card only renders in the dashboard's EXPANDED view, so each
  // test expands the dashboard first.
  async function expandDashboard(page: Page): Promise<void> {
    const dashboard = page.locator('gn-context-dashboard');
    await expect(dashboard).toBeVisible({ timeout: 5000 });
    // The compact view's expand button toggles to the expanded layout.
    const expandBtn = dashboard.locator('.expand-btn');
    await expandBtn.click();
    await expect(dashboard.locator('.card-grid')).toBeVisible({ timeout: 5000 });
  }

  // The dashboard's integration card renders for the repo's detected provider.
  // The default mock repo has a github.com remote, so a GitHub account is the
  // "relevant account" and its card shows the appropriate default badge.
  test('the active profile\'s default account shows "Profile default"', async ({ page }) => {
    const profileWithDefault: MockUnifiedProfile = {
      ...workProfile,
      defaultAccounts: { github: 'account-github' },
    };
    await setupProfilesAndAccounts(page, {
      profiles: [profileWithDefault],
      accounts: [githubAccount],
      connectedAccounts: ['account-github'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [profileWithDefault],
        accounts: [githubAccount],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });

    await expandDashboard(page);
    const card = page.locator('gn-context-dashboard gn-integration-card');
    await expect(card).toBeVisible({ timeout: 5000 });
    const badge = card.locator('.default-badge');
    await expect(badge).toHaveText('Profile default');
    // The profile-default badge is NOT the muted "global" variant.
    await expect(card.locator('.default-badge.global')).toHaveCount(0);
  });

  test('an account used only as global fallback shows "Global default"', async ({ page }) => {
    // Active profile has NO github default → falls back to account.isDefault.
    const profileNoDefault: MockUnifiedProfile = { ...workProfile, defaultAccounts: {} };
    const globalDefaultGithub: MockIntegrationAccount = { ...githubAccount, isDefault: true };
    await setupProfilesAndAccounts(page, {
      profiles: [profileNoDefault],
      accounts: [globalDefaultGithub],
      connectedAccounts: ['account-github'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [profileNoDefault],
        accounts: [globalDefaultGithub],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });

    await expandDashboard(page);
    const card = page.locator('gn-context-dashboard gn-integration-card');
    await expect(card).toBeVisible({ timeout: 5000 });
    const badge = card.locator('.default-badge');
    await expect(badge).toHaveText('Global default');
    // It IS the muted global variant (distinct from the profile-default badge).
    await expect(card.locator('.default-badge.global')).toHaveCount(1);
  });
});

// ===========================================================================
// 7. GitLab account delete error is surfaced (used to be silent)
// ===========================================================================

test.describe('GitLab delete error surfaced', () => {
  const gitlabProfile: MockUnifiedProfile = {
    ...workProfile,
    defaultAccounts: { gitlab: 'account-gitlab' },
  };

  test('a failed delete_global_account surfaces an error toast', async ({ page }) => {
    await setupProfilesAndAccounts(page, {
      profiles: [gitlabProfile],
      accounts: [gitlabAccount],
      connectedAccounts: ['account-gitlab'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [gitlabProfile],
        accounts: [gitlabAccount],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: gitlabProfile,
      get_keyring_token: 'glpat_existing',
      check_gitlab_connection: {
        connected: true,
        user: { username: 'jdoe', name: 'John Doe', avatarUrl: null },
        instanceUrl: 'https://gitlab.com',
      },
    });
    // User confirms the destructive delete…
    await autoConfirmDialogs(page);

    const app = new AppPage(page);
    await app.executeCommand('GitLab');
    await expect(page.locator('gn-gitlab-dialog gn-modal[open]')).toBeVisible();

    // …but the backend delete fails.
    const backendMessage = 'GitLab delete failed: account config is read-only';
    await injectCommandError(page, 'delete_global_account', backendMessage);

    await page
      .locator('gn-gitlab-dialog button.btn-danger-outline', { hasText: /^\s*Delete\s*$/ })
      .click();

    // The failure must be surfaced — both as a toast and the inline error.
    await expect(
      page.locator('gn-toast-container .toast.error .toast-message'),
    ).toContainText(backendMessage, { timeout: 5000 });
    await expect(page.locator('gn-gitlab-dialog .error')).toContainText(backendMessage);

    // And the account is NOT removed from the selector — nothing was destroyed.
    await expect(page.locator('gn-gitlab-dialog gn-account-selector .account-name')).toHaveText(
      'Company GitLab',
    );
  });
});

// ===========================================================================
// 8. GitHub App connect honors the backend `connected` flag
// ===========================================================================

test.describe('GitHub App connect honors backend status', () => {
  /**
   * Drive the GitHub App connection form: switch to the App method, fill the
   * App ID / private key / installation ID, and click Connect.
   */
  async function fillAndConnectGitHubApp(page: Page): Promise<void> {
    // Switch to the GitHub App auth method.
    await page
      .locator('gn-github-dialog .auth-method-btn', { hasText: 'GitHub App' })
      .click();

    await page.locator('gn-github-dialog input[placeholder="123456"]').fill('123456');
    await page
      .locator('gn-github-dialog textarea')
      .fill('-----BEGIN PRIVATE KEY-----\nMOCKKEY\n-----END PRIVATE KEY-----');
    // With App ID + key present, the installation-ID input renders.
    const installInput = page.locator(
      'gn-github-dialog input[placeholder="Installation ID (click Load to discover)"]',
    );
    await expect(installInput).toBeVisible();
    await installInput.fill('99887766');

    await page
      .locator('gn-github-dialog button.btn-primary', { hasText: 'Connect via GitHub App' })
      .click();
  }

  test('a backend `connected:false` shows an error and does NOT persist an account', async ({
    page,
  }) => {
    const dialogs = new DialogsPage(page);
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: workProfile,
    });

    const app = new AppPage(page);
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Backend rejects the GitHub App configuration.
    await startCommandCaptureWithMocks(page, {
      configure_github_app: { connected: false, user: null, scopes: [] },
      save_global_account: null,
    });

    await fillAndConnectGitHubApp(page);

    // An error is shown (inline + toast) and NO account is persisted.
    await expect(page.locator('gn-github-dialog .error-message')).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator('gn-toast-container .toast.error'),
    ).toBeVisible({ timeout: 5000 });

    const saves = await findCommand(page, 'save_global_account');
    expect(saves.length).toBe(0);

    // No connected-state user view should appear.
    await expect(page.locator('gn-github-dialog button:has-text("Disconnect")')).toHaveCount(0);
  });

  test('a backend `connected:true` connects and persists the account', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: workProfile,
    });

    const app = new AppPage(page);
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Backend accepts the GitHub App configuration.
    await startCommandCaptureWithMocks(page, {
      configure_github_app: {
        connected: true,
        user: { login: 'acme-app', name: 'Acme App', email: null, avatarUrl: null },
        scopes: ['app-installation'],
      },
      save_global_account: { id: 'github-app-123456', name: 'GitHub App 123456' },
      store_keyring_token: null,
      update_global_account_cached_user: null,
    });

    await fillAndConnectGitHubApp(page);

    // The account IS persisted on success…
    await waitForCommand(page, 'save_global_account');
    const saves = await findCommand(page, 'save_global_account');
    expect(saves.length).toBeGreaterThan(0);

    // …and a success toast confirms the connection (no error message).
    await expect(
      page.locator('gn-toast-container .toast.success'),
    ).toBeVisible({ timeout: 5000 });
    await expect(page.locator('gn-github-dialog .error-message')).toHaveCount(0);
  });
});
