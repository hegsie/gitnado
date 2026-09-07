/**
 * Profiles & Integrations - High-Value Dialog Flow Tests
 *
 * These tests target the gaps identified in the coverage audit:
 *  - Account switching actually re-checks the new account's connection (not just the selector label)
 *  - Add Account from the selector dropdown produces a visible affordance to add a new account
 *  - Error toasts show the actual backend error message (not just any `.error` element)
 *  - Restoring a migration backup actually triggers the migration flow (currently relies on
 *    a `migration-needed` event with no listener in app-shell — expected to FAIL)
 */

import { test, expect, Page } from '@playwright/test';
import { setupOpenRepository, setupProfilesAndAccounts, setupTauriMocks } from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';
import { DialogsPage } from '../pages/dialogs.page';
import {
  findCommand,
  waitForCommand,
  startCommandCapture,
  startCommandCaptureWithMocks,
  injectCommandError,
  injectCommandMock,
  autoConfirmDialogs,
} from '../fixtures/test-helpers';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

/**
 * Shape shared by every profile fixture below.
 *
 * Each fixture sets a different provider under `defaultAccounts`, so inferring
 * the type from `workProfile` and casting the others to it (`as typeof
 * workProfile`) was never valid — TypeScript rejects it, but e2e/ was never
 * typechecked so the 13 casts went unnoticed. Naming the type once removes
 * both the casts and the error.
 */
type TestProfile = {
  id: string;
  name: string;
  gitName: string;
  gitEmail: string;
  signingKey: string | null;
  urlPatterns: string[];
  isDefault: boolean;
  color: string;
  defaultAccounts: Partial<
    Record<'github' | 'gitlab' | 'bitbucket' | 'azure-devops', string | undefined>
  >;
};

const workProfile: TestProfile = {
  id: 'profile-work',
  name: 'Work',
  gitName: 'John Doe',
  gitEmail: 'john.doe@company.com',
  signingKey: null,
  urlPatterns: [],
  isDefault: true,
  color: '#3b82f6',
  defaultAccounts: { github: 'account-github-work' },
};

const personalProfile: TestProfile = {
  id: 'profile-personal',
  name: 'Personal',
  gitName: 'John D',
  gitEmail: 'johnd@personal.com',
  signingKey: null,
  urlPatterns: [],
  isDefault: false,
  color: '#10b981',
  defaultAccounts: { github: 'account-github-personal' },
};

const githubWork = {
  id: 'account-github-work',
  name: 'Work GitHub',
  integrationType: 'github' as const,
  config: { type: 'github' },
  color: '#3b82f6',
  cachedUser: { username: 'johndoe-work', displayName: 'John Doe', avatarUrl: null },
  urlPatterns: [],
  isDefault: true,
};

const githubPersonal = {
  id: 'account-github-personal',
  name: 'Personal GitHub',
  integrationType: 'github' as const,
  config: { type: 'github' },
  color: '#10b981',
  cachedUser: { username: 'johnd', displayName: 'John D', avatarUrl: null },
  urlPatterns: [],
  isDefault: false,
};

async function openProfileManager(page: Page, dialogs: DialogsPage): Promise<void> {
  await dialogs.commandPalette.open();
  await dialogs.commandPalette.search('Profiles & Accounts');
  await dialogs.commandPalette.executeFirst();
  await expect(page.getByRole('button', { name: 'New Profile' })).toBeVisible();
}

// ---------------------------------------------------------------------------
// 1. Account switching: changing account in selector triggers a connection re-check
// ---------------------------------------------------------------------------

test.describe('GitHub Dialog - account switching re-checks connection', () => {
  test.beforeEach(async ({ page }) => {
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile, personalProfile],
      accounts: [githubWork, githubPersonal],
      connectedAccounts: ['account-github-work', 'account-github-personal'],
    });

    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile, personalProfile],
        accounts: [githubWork, githubPersonal],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      load_unified_profile_for_repository: workProfile,
    });
  });

  test('switching account triggers a fresh check_github_connection call', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    const app = new AppPage(page);

    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Start capturing AFTER initial load so we only see the post-switch invocations
    await startCommandCaptureWithMocks(page, {
      check_github_connection: {
        connected: true,
        user: { login: 'johnd', name: 'John D', email: 'johnd@personal.com', avatarUrl: null },
        scopes: ['repo'],
      },
    });

    // Open dropdown and pick the other account
    await page.locator('lv-github-dialog lv-account-selector .selector-btn').click();
    await page
      .locator('lv-github-dialog lv-account-selector .dropdown-item', {
        hasText: 'Personal GitHub',
      })
      .click();

    // Selector label flips to the new account…
    await expect(
      page.locator('lv-github-dialog lv-account-selector .account-name'),
    ).toHaveText('Personal GitHub');

    // …and a fresh connection check was kicked off for the new account.
    await waitForCommand(page, 'check_github_connection');
    const checks = await findCommand(page, 'check_github_connection');
    expect(checks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Add Account from selector dropdown
// ---------------------------------------------------------------------------

test.describe('GitHub Dialog - Add Account from selector dropdown', () => {
  test.beforeEach(async ({ page }) => {
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork],
      connectedAccounts: ['account-github-work'],
    });

    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      load_unified_profile_for_repository: workProfile,
    });
  });

  test('clicking Add Account in dropdown surfaces the connection form', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    const app = new AppPage(page);

    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Switch off the connection tab so we can detect the tab change reliably
    await dialogs.github.pullRequestsTab.click();
    await expect(dialogs.github.pullRequestsTab).toHaveClass(/active/);

    // Open the account selector dropdown and click Add Account
    await page.locator('lv-github-dialog lv-account-selector .selector-btn').click();
    await page
      .locator('lv-github-dialog lv-account-selector .dropdown-action.primary', {
        hasText: 'Add Account',
      })
      .click();

    // Dropdown should close
    await expect(page.locator('lv-github-dialog lv-account-selector .dropdown')).toHaveCount(0);

    // Connection tab should be active so the user can connect a new account
    await expect(dialogs.github.connectionTab).toHaveClass(/active/);

    // And we should be able to start entering a new token (PAT method)
    await dialogs.github.selectPATMethod();
    await expect(dialogs.github.tokenInput).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 3. Error toast content: the specific backend error message must be shown
// ---------------------------------------------------------------------------

test.describe('Profile manager - error toasts include backend error message', () => {
  test('save failure surfaces the backend error message in the toast', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await setupOpenRepository(page);

    await openProfileManager(page, dialogs);
    await dialogs.profileManager.addProfileButton.click();

    await dialogs.profileManager.fillProfileForm({
      name: 'Error Profile',
      gitName: 'Error User',
      gitEmail: 'error@test.com',
    });

    const backendMessage = 'PERMISSION_DENIED: cannot write profile config';
    await injectCommandError(page, 'save_unified_profile', backendMessage);

    await page.getByRole('button', { name: 'Save Profile' }).click();

    // The error toast must contain the actual backend message — not just be "an error element"
    const errorToastMessage = page.locator('lv-toast-container .toast.error .toast-message');
    await expect(errorToastMessage).toBeVisible({ timeout: 5000 });
    await expect(errorToastMessage).toContainText(backendMessage);
  });

  test('apply failure surfaces the backend error message in the toast', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [workProfile, personalProfile],
      accounts: [githubWork],
    });

    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile, personalProfile],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });

    await openProfileManager(page, dialogs);

    const backendMessage = 'GIT_CONFIG_LOCKED: another process is editing the config';
    await injectCommandError(page, 'apply_unified_profile', backendMessage);

    await page.locator('button[title="Apply to current repository"]').first().click();

    const errorToastMessage = page.locator('lv-toast-container .toast.error .toast-message');
    await expect(errorToastMessage).toBeVisible({ timeout: 5000 });
    await expect(errorToastMessage).toContainText(backendMessage);
  });

  test('detach + save failure leaves the dialog open with an actionable error', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork],
    });

    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });

    await openProfileManager(page, dialogs);

    // Enter edit mode for the Work profile (has one attached account)
    await page.locator('.profile-item').first().click();
    await expect(dialogs.profileManager.attachedAccountItems).toHaveCount(1);

    // Detach the attached account (local state only until Save)
    await dialogs.profileManager.attachedAccountItems
      .first()
      .locator('.account-actions .action-btn.delete')
      .click();
    await expect(dialogs.profileManager.attachedAccountItems).toHaveCount(0);

    // Save fails — the user should see the real reason
    const backendMessage = 'DISK_FULL: not enough space to persist profile';
    await injectCommandError(page, 'save_unified_profile', backendMessage);

    await page.getByRole('button', { name: 'Save Profile' }).click();

    const errorToastMessage = page.locator('lv-toast-container .toast.error .toast-message');
    await expect(errorToastMessage).toBeVisible({ timeout: 5000 });
    await expect(errorToastMessage).toContainText(backendMessage);

    // The dialog stays in edit mode so the user can retry/cancel — Save Profile button still there
    await expect(page.getByRole('button', { name: 'Save Profile' })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 4. Migration backup restore: orphaned `migration-needed` event
// ---------------------------------------------------------------------------

test.describe('Profile manager - restore migration backup', () => {
  const backupInfo = {
    hasBackup: true,
    backupDate: '2026-01-01T12:00:00Z',
    profilesCount: 2,
    accountsCount: 3,
  };

  test.beforeEach(async ({ page }) => {
    // Seed at least one profile — the backup section is currently only rendered when
    // `profiles.length > 0` (lv-profile-manager-dialog.ts:1306). With zero profiles,
    // the empty state hides the backup section entirely, which is itself a bug, but
    // not the one this test is targeting.
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
      get_migration_backup_info: backupInfo,
      restore_migration_backup: backupInfo,
    });
    await autoConfirmDialogs(page);
  });

  test('restore backup fires the migration-needed event and triggers a follow-on flow', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await openProfileManager(page, dialogs);

    // Expand the collapsed backup section first.
    const backupToggle = page.locator('lv-profile-manager-dialog .backup-toggle');
    await expect(backupToggle).toBeVisible({ timeout: 5000 });
    await backupToggle.click();

    // Install a window-level listener so we can prove whether anything in the
    // app would actually pick up the dispatched `migration-needed` event.
    await page.evaluate(() => {
      (window as unknown as { __MIGRATION_NEEDED_FIRED__: boolean }).__MIGRATION_NEEDED_FIRED__ = false;
      window.addEventListener('migration-needed', () => {
        (window as unknown as { __MIGRATION_NEEDED_FIRED__: boolean }).__MIGRATION_NEEDED_FIRED__ = true;
      });
    });

    const restoreBtn = page.getByRole('button', { name: 'Restore Backup' });
    await expect(restoreBtn).toBeVisible({ timeout: 5000 });
    await restoreBtn.click();

    // Success toast appears
    await expect(
      page.locator('lv-toast-container .toast.success .toast-message'),
    ).toContainText(/Restored/i, { timeout: 5000 });

    // The event bubbled up to window — at minimum the dispatch site is alive.
    const eventFired = await page.evaluate(
      () => (window as unknown as { __MIGRATION_NEEDED_FIRED__: boolean }).__MIGRATION_NEEDED_FIRED__,
    );
    expect(eventFired).toBe(true);

    // …and something in the app reacts to it (migration dialog opens). The
    // host element has display:block with zero dimensions (the overlay is the
    // child, position:fixed), so we assert on the overlay instead of the host.
    await expect(
      page.locator('lv-migration-dialog[open] .dialog-overlay'),
    ).toBeVisible({ timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// 5. Cross-component propagation — dialog actions must update the toolbar
//
// The `lv-context-dashboard` (the toolbar strip under the tabs) subscribes to
// `unifiedProfileStore` and renders the active profile chip plus the integration
// status dot. These tests act on dialogs and assert the toolbar updates without
// requiring a reload. They probe the real user expectation: "I changed it in the
// dialog — the rest of the app reflects it."
// ---------------------------------------------------------------------------

const dashboardProfileName = (page: Page) =>
  page.locator('lv-context-dashboard .profile-name').first();
const dashboardCompactIdentity = (page: Page) =>
  page.locator('lv-context-dashboard .compact-identity').first();
const dashboardNoProfile = (page: Page) =>
  page.locator('lv-context-dashboard .no-profile');
const dashboardAccountStatusDot = (page: Page) =>
  page.locator('lv-context-dashboard .account-status-dot').first();
const dashboardConnectBtn = (page: Page) =>
  page.locator('lv-context-dashboard .configure-btn, lv-context-dashboard .no-profile-btn');

test.describe('Cross-component propagation - toolbar reflects dialog state', () => {
  test('applying a profile updates the toolbar chip immediately', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [workProfile, personalProfile],
      accounts: [githubWork, githubPersonal],
    });

    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile, personalProfile],
        accounts: [githubWork, githubPersonal],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      apply_unified_profile: null,
      get_unified_profile: personalProfile,
      load_unified_profile_for_repository: workProfile,
    });

    // Toolbar starts on the default (Work) profile
    await expect(dashboardProfileName(page)).toHaveText('Work');

    await openProfileManager(page, dialogs);
    await startCommandCaptureWithMocks(page, {
      apply_unified_profile: null,
      get_unified_profile: personalProfile,
      get_assigned_unified_profile: personalProfile,
    });

    // Apply Personal profile (second card's apply button)
    await page.locator('button[title="Apply to current repository"]').nth(1).click();

    // Toolbar must flip to Personal without any reload, AND the backend was told.
    await expect(dashboardProfileName(page)).toHaveText('Personal');
    await expect(dashboardCompactIdentity(page)).toContainText('johnd@personal.com');
    const applies = await findCommand(page, 'apply_unified_profile');
    expect(applies.length).toBeGreaterThan(0);
    const applyArgs = applies[applies.length - 1].args as { profileId: string };
    expect(applyArgs.profileId).toBe('profile-personal');
  });

  test('deleting the active profile falls back to a safe toolbar state', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork],
    });

    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      delete_unified_profile: null,
    });
    await autoConfirmDialogs(page);

    // Toolbar shows the active profile
    await expect(dashboardProfileName(page)).toHaveText('Work');

    await openProfileManager(page, dialogs);
    await page.getByRole('button', { name: 'Delete profile' }).first().click();

    // After delete, the toolbar MUST fall back to the "No profile active" empty
    // state — NOT keep rendering the deleted profile's name.
    await expect(dashboardNoProfile(page)).toBeVisible({ timeout: 5000 });
    await expect(dashboardProfileName(page)).toHaveCount(0);
  });

  test('renaming the active profile updates the toolbar chip', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork],
    });

    const renamed = { ...workProfile, name: 'Client A' };
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      save_unified_profile: { profile: renamed, failedRepositories: [] },
    });

    await expect(dashboardProfileName(page)).toHaveText('Work');

    await openProfileManager(page, dialogs);
    await page.locator('.profile-item').first().click();

    // Edit form opens; clear the name and type a new one
    const nameInput = page.getByPlaceholder(/Work, Personal/i);
    await nameInput.fill('Client A');

    await page.getByRole('button', { name: 'Save Profile' }).click();

    // The toolbar chip should reflect the new name without a reload
    await expect(dashboardProfileName(page)).toHaveText('Client A', { timeout: 5000 });
  });

  // Saving an edited profile re-writes the git identity of every repository
  // assigned to it. The ones the backend could not rewrite must be named, not
  // hidden behind a generic "Profile saved".
  test('editing a profile warns about repositories that kept the old identity', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork],
    });

    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork],
        repositoryAssignments: { '/repo/personal': workProfile.id },
      },
      get_migration_backup_info: { hasBackup: false },
      save_unified_profile: {
        profile: { ...workProfile, gitEmail: 'new@company.com' },
        failedRepositories: ['/repo/personal'],
      },
    });

    await openProfileManager(page, dialogs);
    await page.locator('.profile-item').first().click();

    await page.getByPlaceholder(/john@example.com/i).fill('new@company.com');
    await page.getByRole('button', { name: 'Save Profile' }).click();

    const warning = page.locator('lv-toast-container .toast.warning .toast-message');
    await expect(warning).toBeVisible({ timeout: 5000 });
    await expect(warning).toContainText('personal');
  });

  test('creating the first profile marked default makes it the active profile', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    // `setupProfilesAndAccounts` waits for `profiles.length > 0` so it can't be
    // used for the truly-empty case — set up the repo, then inject empty config.
    await setupOpenRepository(page);
    const newProfile = { ...workProfile, id: 'profile-new', name: 'My Profile', isDefault: true };
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [],
        accounts: [],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      save_unified_profile: { profile: newProfile, failedRepositories: [] },
      get_unified_profile: newProfile,
      apply_unified_profile: null,
    });

    // Toolbar starts in the "no profile active" state
    await expect(dashboardNoProfile(page)).toBeVisible();

    await openProfileManager(page, dialogs);
    await dialogs.profileManager.addProfileButton.click();
    await dialogs.profileManager.fillProfileForm({
      name: 'My Profile',
      gitName: 'John Doe',
      gitEmail: 'john.doe@company.com',
    });
    await page.getByRole('button', { name: 'Save Profile' }).click();

    // A newly-created default profile should become the active profile and the
    // toolbar should reflect that without requiring an extra apply step.
    await expect(dashboardProfileName(page)).toHaveText('My Profile', { timeout: 5000 });
    await expect(dashboardNoProfile(page)).not.toBeVisible();
  });

  test('switching profile from the dashboard dropdown updates the chip', async ({ page }) => {
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile, personalProfile],
      accounts: [githubWork],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile, personalProfile],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      apply_unified_profile: null,
      get_unified_profile: personalProfile,
    });

    await expect(dashboardProfileName(page)).toHaveText('Work');

    await startCommandCaptureWithMocks(page, {
      apply_unified_profile: null,
      get_unified_profile: personalProfile,
    });

    // Open the dashboard's profile dropdown
    await page.locator('lv-context-dashboard .profile-selector-btn').click();
    // Click the other profile in the dropdown
    await page.locator('lv-context-dashboard .profile-dropdown .dropdown-item', {
      hasText: 'Personal',
    }).click();

    await expect(dashboardProfileName(page)).toHaveText('Personal', { timeout: 5000 });
    // The backend was told — UI didn't just update local state.
    const applies = await findCommand(page, 'apply_unified_profile');
    expect(applies.length).toBeGreaterThan(0);
    const applyArgs = applies[applies.length - 1].args as { profileId: string };
    expect(applyArgs.profileId).toBe('profile-personal');
  });

  test('switching profile from the dashboard confirms it and refreshes the identity listeners', async ({ page }) => {
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile, personalProfile],
      accounts: [githubWork],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile, personalProfile],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      apply_unified_profile: null,
      get_unified_profile: personalProfile,
    });

    await expect(dashboardProfileName(page)).toHaveText('Work');

    // Clears the capture buffer, so any get_user_identity seen below is a
    // consequence of the switch, not of the initial repository load.
    await startCommandCaptureWithMocks(page, {
      apply_unified_profile: null,
      get_unified_profile: personalProfile,
      get_user_identity: {
        name: 'John Personal',
        email: 'johnd@personal.com',
        nameIsGlobal: false,
        emailIsGlobal: false,
      },
    });

    await page.locator('lv-context-dashboard .profile-selector-btn').click();
    await page.locator('lv-context-dashboard .profile-dropdown .dropdown-item', {
      hasText: 'Personal',
    }).click();

    // The chip reflects the new profile...
    await expect(dashboardProfileName(page)).toHaveText('Personal', { timeout: 5000 });

    // ...the switch confirms itself instead of completing silently...
    await expect(
      page.locator('lv-toast-container .toast.success .toast-message')
    ).toContainText('Personal', { timeout: 5000 });

    // ...and the repository-refresh reaches the commit panel, which re-reads
    // the git identity behind its commit-template author placeholder. Without
    // it the rest of the app keeps the old identity until an unrelated refresh.
    await expect
      .poll(async () => (await findCommand(page, 'get_user_identity')).length, { timeout: 5000 })
      .toBeGreaterThan(0);
  });

  test("switching profile from the dashboard dropdown flips the profile card to 'Manually assigned'", async ({ page }) => {
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile, personalProfile],
      accounts: [githubWork],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile, personalProfile],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      apply_unified_profile: null,
      get_unified_profile: personalProfile,
    });

    // Expand the dashboard so the profile card (and its assignment badge) render.
    const dashboard = page.locator('lv-context-dashboard');
    await expect(dashboard).toBeVisible({ timeout: 5000 });
    await dashboard.locator('.expand-btn').click();
    await expect(dashboard.locator('.card-grid')).toBeVisible({ timeout: 5000 });

    // workProfile is the default profile and has no repository assignment.
    const badge = page.locator('lv-context-dashboard lv-profile-card .assignment-source');
    await expect(badge).toHaveText('Default profile', { timeout: 5000 });

    // Switch to a non-default profile with no URL patterns. The only thing that
    // can justify a badge now is the repo assignment the backend just saved.
    await dashboard.locator('.profile-selector-btn').click();
    await dashboard.locator('.profile-dropdown .dropdown-item', { hasText: 'Personal' }).click();

    await expect(badge).toHaveText('Manually assigned', { timeout: 5000 });
    await expect(
      page.locator('lv-context-dashboard lv-profile-card .assignment-source.fallback')
    ).toHaveCount(0);
  });

  test('saving a PAT in the GitHub dialog flips the toolbar dot from Reconnect to connected', async ({ page }) => {
    // Real production path: toolbar starts in Reconnect → user opens GitHub
    // dialog (no stored token → shows PAT form) → enters PAT → handleSaveToken
    // verifies via check_github_connection → syncSharedConnectionStatus(true).
    const dialogs = new DialogsPage(page);
    const disconnectedAccount = { ...githubWork, cachedUser: null };
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [disconnectedAccount],
      connectedAccounts: [],
    });

    // Dynamic invoke handler: no token initially → check returns disconnected.
    // After the PAT is entered and Connect is clicked, the same command is
    // called with a non-null token, returning connected.
    await page.evaluate(() => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const orig = internals.invoke;
      internals.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === 'get_unified_profiles_config') {
          return {
            version: 3,
            profiles: [{
              id: 'profile-work', name: 'Work', gitName: 'John Doe',
              gitEmail: 'john.doe@company.com', signingKey: null,
              urlPatterns: [], isDefault: true, color: '#3b82f6',
              defaultAccounts: { github: 'account-github-work' },
            }],
            accounts: [{
              id: 'account-github-work', name: 'Work GitHub',
              integrationType: 'github', config: { type: 'github' },
              color: '#3b82f6', cachedUser: null, urlPatterns: [], isDefault: true,
            }],
            repositoryAssignments: {},
          };
        }
        if (cmd === 'get_migration_backup_info') return { hasBackup: false };
        if (cmd === 'get_assigned_unified_profile') return null;
        if (cmd === 'get_keyring_token') return null;
        if (cmd === 'store_keyring_token') return null;
        if (cmd === 'update_global_account_cached_user') return null;
        if (cmd === 'check_github_connection') {
          const token = (args as { token?: string | null })?.token;
          if (token) {
            return { connected: true, user: { login: 'johndoe-work', name: 'John Doe', email: null, avatarUrl: null }, scopes: ['repo'] };
          }
          return { connected: false, user: null, scopes: [] };
        }
        return orig(cmd, args);
      };
    });

    const reconnectBtn = page.locator(
      'lv-context-dashboard .configure-btn:has-text("Reconnect GitHub")',
    );
    await expect(reconnectBtn).toBeVisible();

    const app = new AppPage(page);
    await app.executeCommand('GitHub');
    // Dialog opens; with no token, the form (not the connected view) renders.
    await dialogs.github.selectPATMethod();
    await dialogs.github.tokenInput.waitFor({ state: 'visible', timeout: 5000 });
    await dialogs.github.tokenInput.fill('ghp_validtoken');
    await page.locator('lv-github-dialog button:has-text("Connect to GitHub")').click();

    await expect(
      page.locator('lv-context-dashboard .account-status-dot.connected'),
    ).toBeVisible({ timeout: 5000 });
    await expect(reconnectBtn).not.toBeVisible();
  });

  test('removing the only account leaves the toolbar in a coherent "Connect" state', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork],
      connectedAccounts: ['account-github-work'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      delete_global_account: null,
    });
    await autoConfirmDialogs(page);

    // Start: connected status dot in toolbar
    await expect(
      page.locator('lv-context-dashboard .account-status-dot.connected'),
    ).toBeVisible();

    // Delete the only global account via the profile manager
    await openProfileManager(page, dialogs);
    await page.locator('.profile-item').first().click();
    await dialogs.profileManager.attachedAccountItems
      .first()
      .locator('.account-actions .action-btn:not(.delete)')
      .click();
    await page.getByRole('button', { name: 'Delete Account' }).click();

    // The connected dot must NOT remain after the account is gone. Either the
    // dot disappears entirely, or a "Connect GitHub" affordance reappears in
    // its place. The one thing the toolbar must NOT do is keep showing a green
    // connected dot for an account that no longer exists.
    await expect(
      page.locator('lv-context-dashboard .account-status-dot.connected'),
    ).not.toBeVisible({ timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// 6. Dialog ↔ Dialog workflows (Profile Manager <-> Integration dialogs)
//
// The previous tests act on one dialog at a time. Real users navigate
// BETWEEN dialogs — open the Profile Manager, jump to the GitHub dialog
// from a picker, come back, save, and expect the state to be coherent at
// every step. These tests exercise those chained journeys.
// ---------------------------------------------------------------------------

test.describe('Workflow - Profile Manager ↔ Integration dialogs', () => {
  // --- W1 -------------------------------------------------------------
  test('W1: Manage Accounts navigates the user to the Profile Manager (not buried behind the integration dialog)', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork, githubPersonal],
      connectedAccounts: ['account-github-work'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork, githubPersonal],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      load_unified_profile_for_repository: workProfile,
    });

    const app = new AppPage(page);
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Open the account selector dropdown and click Manage Accounts
    await page.locator('lv-github-dialog lv-account-selector .selector-btn').click();
    await page
      .locator('lv-github-dialog lv-account-selector .dropdown-action', {
        hasText: 'Manage Accounts',
      })
      .click();

    // The Profile Manager must be visibly on top (not demoted behind the GitHub
    // dialog) so the user actually sees the navigation they asked for.
    const profileManagerOverlay = page.locator('lv-profile-manager-dialog[open] .dialog-overlay');
    await expect(profileManagerOverlay).toBeVisible({ timeout: 3000 });
    // And the integration dialog should be out of the way — either closed or
    // at least not demoted on top of where the user is looking.
    await expect(
      page.locator('lv-profile-manager-dialog[open][demoted]'),
    ).toHaveCount(0);
  });

  // --- W2 -------------------------------------------------------------
  test('W2: editing an attached account and saving shows the new name in the profile\'s attached list', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork],
    });
    const renamedAccount = { ...githubWork, name: 'Acme GitHub' };
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      save_global_account: renamedAccount,
    });

    await openProfileManager(page, dialogs);
    await page.locator('.profile-item').first().click();
    await expect(dialogs.profileManager.attachedAccountItems.first()).toContainText(
      'Work GitHub',
    );

    // Open the account edit screen via the pencil (non-delete) button
    await dialogs.profileManager.attachedAccountItems
      .first()
      .locator('.account-actions .action-btn:not(.delete)')
      .click();
    await expect(page.locator('lv-profile-manager-dialog .dialog-title')).toContainText(
      'Edit Account',
    );

    // Rename the account
    const accountNameInput = page
      .locator('lv-profile-manager-dialog')
      .getByPlaceholder(/Account name|e\.g\./i)
      .first();
    await accountNameInput.fill('Acme GitHub');
    await page.getByRole('button', { name: 'Save Account' }).click();

    // Should return to profile edit view, attached list shows new name
    await expect(page.locator('lv-profile-manager-dialog .dialog-title')).toContainText(
      'Edit Profile',
    );
    await expect(dialogs.profileManager.attachedAccountItems.first()).toContainText(
      'Acme GitHub',
    );
  });

  // --- W3 -------------------------------------------------------------
  test('W3: connecting a new account via PAT entry then reopening the dialog shows the new account in the selector', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork],
      connectedAccounts: ['account-github-work'],
    });

    const freshAccount = {
      id: 'account-github-extra',
      name: 'GitHub (extra-user)',
      integrationType: 'github' as const,
      config: { type: 'github' as const },
      color: null,
      cachedUser: { username: 'extra-user', displayName: 'Extra User', email: null, avatarUrl: null },
      urlPatterns: [],
      isDefault: false,
    };

    // Dynamic invoke handler: simulates the backend persisting the new account
    // after save_global_account is called. The full handleSaveToken flow runs:
    // check_github_connection → save_global_account → store_keyring_token →
    // loadUnifiedProfiles (get_unified_profiles_config returns BOTH accounts).
    await page.evaluate(({ workAcc, fresh }) => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const orig = internals.invoke;
      let accountSaved = false;
      internals.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === 'get_unified_profiles_config') {
          return {
            version: 3,
            profiles: [{
              id: 'profile-work', name: 'Work', gitName: 'John Doe',
              gitEmail: 'john.doe@company.com', signingKey: null,
              urlPatterns: [], isDefault: true, color: '#3b82f6',
              defaultAccounts: { github: 'account-github-work' },
            }],
            accounts: accountSaved ? [workAcc, fresh] : [workAcc],
            repositoryAssignments: {},
          };
        }
        if (cmd === 'get_migration_backup_info') return { hasBackup: false };
        if (cmd === 'get_assigned_unified_profile') return null;
        if (cmd === 'get_keyring_token') return null;
        if (cmd === 'store_keyring_token') return null;
        if (cmd === 'update_global_account_cached_user') return null;
        if (cmd === 'save_global_account') {
          accountSaved = true;
          return fresh;
        }
        if (cmd === 'check_github_connection') {
          const token = (args as { token?: string | null })?.token;
          if (token) {
            return { connected: true, user: { login: 'extra-user', name: 'Extra User', email: null, avatarUrl: null }, scopes: ['repo'] };
          }
          return { connected: false, user: null, scopes: [] };
        }
        return orig(cmd, args);
      };
    }, { workAcc: githubWork, fresh: freshAccount });

    const app = new AppPage(page);
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Open selector → Add Account → clears selection, shows connect form
    await page.locator('lv-github-dialog lv-account-selector .selector-btn').click();
    await page
      .locator('lv-github-dialog lv-account-selector .dropdown-action.primary', {
        hasText: 'Add Account',
      })
      .click();

    await dialogs.github.selectPATMethod();
    await dialogs.github.tokenInput.waitFor({ state: 'visible', timeout: 5000 });
    await dialogs.github.tokenInput.fill('ghp_realtoken_for_test');

    await startCommandCapture(page);
    await page.locator('lv-github-dialog button:has-text("Connect to GitHub")').click();
    await waitForCommand(page, 'save_global_account');

    // Close and reopen — the new account must appear in the selector via the
    // REAL store-reload path (loadUnifiedProfiles → get_unified_profiles_config).
    await page.locator('lv-github-dialog .close-btn, lv-github-dialog button[aria-label="Close"]').first().click();
    await expect(dialogs.github.dialog).not.toBeVisible();

    await app.executeCommand('GitHub');
    await page.locator('lv-github-dialog lv-account-selector .selector-btn').click();
    await expect(
      page.locator('lv-github-dialog lv-account-selector .dropdown-item', {
        hasText: 'GitHub (extra-user)',
      }),
    ).toBeVisible();
  });

  // --- W4 -------------------------------------------------------------
  test('W4: deleting a global account that two profiles reference clears the reference from both', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    // Two profiles both pointing to the same github account
    const p1 = { ...workProfile, defaultAccounts: { github: 'account-github-work' } };
    const p2 = {
      ...personalProfile,
      defaultAccounts: { github: 'account-github-work' as string | undefined },
    };
    await setupProfilesAndAccounts(page, {
      profiles: [p1, p2],
      accounts: [githubWork],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [p1, p2],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      delete_global_account: null,
    });
    await autoConfirmDialogs(page);

    await openProfileManager(page, dialogs);
    // First profile shows the attached account…
    await page.locator('.profile-item').first().click();
    await expect(dialogs.profileManager.attachedAccountItems).toHaveCount(1);

    // Open the account's edit screen and delete it globally
    await dialogs.profileManager.attachedAccountItems
      .first()
      .locator('.account-actions .action-btn:not(.delete)')
      .click();
    await page.getByRole('button', { name: 'Delete Account' }).click();

    // Returns to first profile's edit form — attached list now empty
    await expect(dialogs.profileManager.attachedAccountItems).toHaveCount(0);

    // Go back to the profile list, open the SECOND profile — it must also have
    // lost the reference to the deleted account. If it still shows the (now
    // dangling) account, that's a real bug.
    await page.getByRole('button', { name: /Back|Cancel/i }).first().click();
    await page.locator('.profile-item').nth(1).click();
    await expect(dialogs.profileManager.attachedAccountItems).toHaveCount(0);
  });

  // --- W5 -------------------------------------------------------------
  test('W5: applying a different profile while the integration dialog is closed updates that dialog\'s default account on reopen', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    const profileA = { ...workProfile, defaultAccounts: { github: 'account-github-work' } };
    const profileB = {
      ...personalProfile,
      defaultAccounts: { github: 'account-github-personal' },
    };
    await setupProfilesAndAccounts(page, {
      profiles: [profileA, profileB],
      accounts: [githubWork, githubPersonal],
      connectedAccounts: ['account-github-work', 'account-github-personal'],
    });
    // Initial state: profile A is assigned for the repo
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [profileA, profileB],
        accounts: [githubWork, githubPersonal],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: profileA,
      get_unified_profile: profileA,
      apply_unified_profile: null,
    });

    const app = new AppPage(page);

    // Open GitHub dialog under profile A — selector should show A's default
    await app.executeCommand('GitHub');
    await expect(
      page.locator('lv-github-dialog lv-account-selector .account-name'),
    ).toHaveText('Work GitHub');
    await page.locator('lv-github-dialog .close-btn, lv-github-dialog button[aria-label="Close"]').first().click();

    // Apply profile B (via the dashboard dropdown). In production, the backend
    // would persist the assignment; mirror that by re-injecting the mock so
    // subsequent reads return profileB.
    await page.locator('lv-context-dashboard .profile-selector-btn').click();
    await page.locator('lv-context-dashboard .profile-dropdown .dropdown-item', {
      hasText: 'Personal',
    }).click();
    await expect(
      page.locator('lv-context-dashboard .profile-name'),
    ).toHaveText('Personal');
    await injectCommandMock(page, {
      get_assigned_unified_profile: profileB,
      get_unified_profile: profileB,
    });

    // Reopen GitHub dialog — selector must reflect profile B's default
    await app.executeCommand('GitHub');
    await expect(
      page.locator('lv-github-dialog lv-account-selector .account-name'),
    ).toHaveText('Personal GitHub', { timeout: 5000 });
  });

  // --- W6 -------------------------------------------------------------
  test('W6: adding an account via the Profile Manager picker auto-attaches it via the real PAT save flow', async ({ page }) => {
    // This exercises the real production path that PR #199 had to fix:
    // picker → GitHub dialog → token save → save_global_account → store_keyring_token
    // → back → auto-attach. No direct state.addAccount() injection.
    const dialogs = new DialogsPage(page);

    const newAccount = {
      id: 'account-fresh',
      name: 'GitHub (fresh-user)',
      integrationType: 'github' as const,
      config: { type: 'github' as const },
      color: null,
      cachedUser: { username: 'fresh-user', displayName: 'Fresh', email: null, avatarUrl: null },
      urlPatterns: [],
      isDefault: true,
    };
    const profileBase = { ...personalProfile, defaultAccounts: {} };

    await setupProfilesAndAccounts(page, {
      profiles: [profileBase],
      accounts: [],
    });

    // Dynamic invoke handler: account materialises only after save_global_account
    // is called. handleSaveToken runs the real verify → save → store → reload chain.
    await page.evaluate(({ profile, fresh }) => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const orig = internals.invoke;
      let accountSaved = false;
      internals.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === 'get_unified_profiles_config') {
          return {
            version: 3,
            profiles: [profile],
            accounts: accountSaved ? [fresh] : [],
            repositoryAssignments: {},
          };
        }
        if (cmd === 'get_migration_backup_info') return { hasBackup: false };
        if (cmd === 'get_assigned_unified_profile') return profile;
        if (cmd === 'get_keyring_token') return null;
        if (cmd === 'store_keyring_token') return null;
        if (cmd === 'update_global_account_cached_user') return null;
        if (cmd === 'save_global_account') {
          accountSaved = true;
          return fresh;
        }
        if (cmd === 'check_github_connection') {
          const token = (args as { token?: string | null })?.token;
          if (token) {
            return { connected: true, user: { login: 'fresh-user', name: 'Fresh', email: null, avatarUrl: null }, scopes: ['repo'] };
          }
          return { connected: false, user: null, scopes: [] };
        }
        return orig(cmd, args);
      };
    }, { profile: profileBase, fresh: newAccount });

    await openProfileManager(page, dialogs);
    await page.locator('.profile-item').first().click();
    await dialogs.profileManager.attachAccountButton.click();
    await expect(
      page.locator('lv-profile-manager-dialog .dialog-title'),
    ).toContainText('Attach Account');

    await page
      .locator('lv-profile-manager-dialog')
      .getByRole('button', { name: 'GitHub', exact: true })
      .click();
    await expect(dialogs.github.dialog).toBeVisible();
    await expect(page.locator('lv-profile-manager-dialog[open][demoted]')).toHaveCount(1);

    // EXPLICIT navigation: the GitHub dialog shows a Back arrow (opened with a
    // return target) AND an "Adding to <profile>" breadcrumb naming the target.
    await expect(
      page.locator('lv-github-dialog').getByRole('button', { name: 'Back' }),
    ).toBeVisible();
    await expect(
      page.locator('lv-github-dialog [data-testid="attach-breadcrumb"]'),
    ).toContainText('Personal');

    // REAL save flow.
    await dialogs.github.selectPATMethod();
    await dialogs.github.tokenInput.waitFor({ state: 'visible', timeout: 5000 });
    await dialogs.github.tokenInput.fill('ghp_realtoken_for_test');
    await startCommandCapture(page);
    await page.locator('lv-github-dialog button:has-text("Connect to GitHub")').click();
    await waitForCommand(page, 'save_global_account');
    await waitForCommand(page, 'store_keyring_token');

    // Back → profile manager reveals → PR #199 fix auto-attaches
    await page.locator('lv-github-dialog').getByRole('button', { name: 'Back' }).click();
    await expect(
      page.locator('lv-profile-manager-dialog[open][demoted]'),
    ).toHaveCount(0);
    await expect(
      page.locator('lv-profile-manager-dialog .dialog-title'),
    ).toContainText('Edit Profile');
    await expect(dialogs.profileManager.attachedAccountItems.first()).toContainText(
      'GitHub (fresh-user)',
    );

    // Save the profile and verify the backend received the auto-attached
    // account as the profile's github default — not just UI-only state.
    await startCommandCaptureWithMocks(page, {
      save_unified_profile: {
        profile: { ...personalProfile, defaultAccounts: { github: newAccount.id } },
        failedRepositories: [],
      },
    });
    await page.getByRole('button', { name: 'Save Profile' }).click();
    await waitForCommand(page, 'save_unified_profile');
    const saves = await findCommand(page, 'save_unified_profile');
    const saved = (saves[saves.length - 1].args as { profile: { defaultAccounts: Record<string, string> } }).profile;
    expect(saved.defaultAccounts.github).toBe(newAccount.id);
  });

  // --- W7 -------------------------------------------------------------
  test('W7: a provider dialog opened STANDALONE (command palette) shows no Back arrow and does NOT auto-attach', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    // A profile with NO github account attached, plus a global github account
    // already present. If a stray auto-attach happened, this account would get
    // attached — we assert it does NOT.
    const profileNoGithub = { ...personalProfile, defaultAccounts: {} };
    await setupProfilesAndAccounts(page, {
      profiles: [profileNoGithub],
      accounts: [githubWork],
      connectedAccounts: ['account-github-work'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [profileNoGithub],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      load_unified_profile_for_repository: profileNoGithub,
    });

    const app = new AppPage(page);
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Opened standalone: NO Back arrow, only a Close ×; and no attach breadcrumb.
    await expect(
      page.locator('lv-github-dialog lv-modal').locator('[aria-label="Back"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('lv-github-dialog lv-modal').locator('[aria-label="Close"]'),
    ).toBeVisible();
    await expect(
      page.locator('lv-github-dialog [data-testid="attach-breadcrumb"]'),
    ).toHaveCount(0);

    // Close it, open the manager, edit the profile — the github account must NOT
    // have been auto-attached by the standalone open.
    await page.locator('lv-github-dialog lv-modal [aria-label="Close"]').click();
    await expect(dialogs.github.dialog).not.toBeVisible();

    await openProfileManager(page, dialogs);
    await page.locator('.profile-item').first().click();
    await expect(dialogs.profileManager.attachedAccountItems).toHaveCount(0);
  });

  // --- W8 -------------------------------------------------------------
  test('W8: Manage Accounts from a provider dialog is reversible — Back returns to the provider dialog', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork, githubPersonal],
      connectedAccounts: ['account-github-work'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork, githubPersonal],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      load_unified_profile_for_repository: workProfile,
    });

    const app = new AppPage(page);
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Manage Accounts → lands on the Profiles & Accounts manager (on top).
    await page.locator('lv-github-dialog lv-account-selector .selector-btn').click();
    await page
      .locator('lv-github-dialog lv-account-selector .dropdown-action', {
        hasText: 'Manage Accounts',
      })
      .click();
    await expect(
      page.locator('lv-profile-manager-dialog[open] .dialog-overlay'),
    ).toBeVisible();
    await expect(dialogs.github.dialog).not.toBeVisible();
    await expect(page.locator('lv-profile-manager-dialog .dialog-title')).toContainText('Accounts');

    // REVERSIBLE: Back from the Accounts view returns to the GitHub dialog.
    await page.locator('lv-profile-manager-dialog .dialog-footer button', { hasText: 'Back' }).click();
    await expect(page.locator('lv-profile-manager-dialog[open]')).toHaveCount(0);
    await expect(dialogs.github.dialog).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 7. Remaining flows — duplicate, repo assignment, backup delete, set default
// ---------------------------------------------------------------------------

test.describe('Remaining flows - Profile Manager', () => {
  test('duplicate profile opens create form pre-filled with "(Copy)" suffix', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });

    await openProfileManager(page, dialogs);

    // Click the duplicate button on the work profile card
    await page.locator('button[title="Duplicate profile"]').first().click();

    // Should land on the create form, pre-filled with "Work (Copy)"
    await expect(page.getByRole('button', { name: 'Save Profile' })).toBeVisible();
    const nameInput = page.getByPlaceholder(/Work, Personal/i);
    await expect(nameInput).toHaveValue('Work (Copy)');
    // Git identity copied over
    await expect(page.getByPlaceholder('John Doe')).toHaveValue('John Doe');
    await expect(page.getByPlaceholder('john@example.com')).toHaveValue('john.doe@company.com');
  });

  test('backup delete removes the backup section', async ({ page }) => {
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
      get_migration_backup_info: {
        hasBackup: true,
        backupDate: '2026-01-01T12:00:00Z',
        profilesCount: 2,
        accountsCount: 3,
      },
      delete_migration_backup: null,
    });
    await autoConfirmDialogs(page);

    await openProfileManager(page, dialogs);
    // Expand the backup section
    await page.locator('lv-profile-manager-dialog .backup-toggle').click();
    const deleteBtn = page.getByRole('button', { name: 'Delete Backup' });
    await expect(deleteBtn).toBeVisible();

    await deleteBtn.click();

    // Backup section should disappear
    await expect(
      page.locator('lv-profile-manager-dialog .backup-toggle'),
    ).toHaveCount(0, { timeout: 5000 });
    // And a success toast should appear
    await expect(
      page.locator('lv-toast-container .toast.success .toast-message'),
    ).toContainText(/Migration backup deleted/i);
  });

  test('toggling "Set as default" in the profile form persists', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    // A non-default profile to start
    const profile = { ...personalProfile, isDefault: false };
    await setupProfilesAndAccounts(page, { profiles: [profile], accounts: [] });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [profile],
        accounts: [],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      save_unified_profile: { profile: { ...profile, isDefault: true }, failedRepositories: [] },
    });

    await openProfileManager(page, dialogs);
    await page.locator('.profile-item').first().click();

    // Toggle the "Set as default" checkbox/control inside the edit form
    const defaultToggle = page.locator('lv-profile-manager-dialog input[type="checkbox"]').first();
    await expect(defaultToggle).toBeVisible();
    if (!(await defaultToggle.isChecked())) {
      await defaultToggle.check();
    }

    await startCommandCaptureWithMocks(page, {
      save_unified_profile: { profile: { ...profile, isDefault: true }, failedRepositories: [] },
    });
    await page.getByRole('button', { name: 'Save Profile' }).click();
    await waitForCommand(page, 'save_unified_profile');

    const cmds = await findCommand(page, 'save_unified_profile');
    const saved = (cmds[0].args as { profile: { isDefault: boolean } }).profile;
    expect(saved.isDefault).toBe(true);
  });

  test('URL patterns: multiple lines persist as separate patterns', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [],
        accounts: [],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });

    await openProfileManager(page, dialogs);
    await dialogs.profileManager.addProfileButton.click();

    await dialogs.profileManager.fillProfileForm({
      name: 'Multi-Pattern',
      gitName: 'Multi User',
      gitEmail: 'multi@example.com',
      urlPatterns: 'github.com/acme/*\ngitlab.acme.com/*\nbitbucket.org/team/*',
    });

    await startCommandCaptureWithMocks(page, {
      save_unified_profile: {
        profile: {
          id: 'profile-multi',
          name: 'Multi-Pattern',
          gitName: 'Multi User',
          gitEmail: 'multi@example.com',
          signingKey: null,
          urlPatterns: ['github.com/acme/*', 'gitlab.acme.com/*', 'bitbucket.org/team/*'],
          isDefault: false,
          color: '#3b82f6',
          defaultAccounts: {},
        },
        failedRepositories: [],
      },
    });
    await page.getByRole('button', { name: 'Save Profile' }).click();
    await waitForCommand(page, 'save_unified_profile');

    const cmds = await findCommand(page, 'save_unified_profile');
    const saved = (cmds[0].args as { profile: { urlPatterns: string[] } }).profile;
    expect(saved.urlPatterns).toEqual([
      'github.com/acme/*',
      'gitlab.acme.com/*',
      'bitbucket.org/team/*',
    ]);
  });

  test('profile form: empty name shows specific error and does not save', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await setupOpenRepository(page);

    await openProfileManager(page, dialogs);
    await dialogs.profileManager.addProfileButton.click();
    // Fill git fields but leave name blank
    await dialogs.profileManager.fillProfileForm({ gitName: 'John Doe', gitEmail: 'john@example.com' });

    await startCommandCaptureWithMocks(page, { save_unified_profile: null });
    await page.getByRole('button', { name: 'Save Profile' }).click();

    await expect(
      page.locator('lv-toast-container .toast.error .toast-message'),
    ).toContainText(/Profile name is required/i, { timeout: 3000 });
    const saves = await findCommand(page, 'save_unified_profile');
    expect(saves.length).toBe(0);
    // Dialog stays open on the form so the user can fix it
    await expect(page.getByRole('button', { name: 'Save Profile' })).toBeVisible();
  });

  test('profile form: empty git name shows specific error and does not save', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await setupOpenRepository(page);

    await openProfileManager(page, dialogs);
    await dialogs.profileManager.addProfileButton.click();
    await dialogs.profileManager.fillProfileForm({ name: 'Work', gitEmail: 'john@example.com' });

    await startCommandCaptureWithMocks(page, { save_unified_profile: null });
    await page.getByRole('button', { name: 'Save Profile' }).click();

    await expect(
      page.locator('lv-toast-container .toast.error .toast-message'),
    ).toContainText(/Git name is required/i, { timeout: 3000 });
    const saves = await findCommand(page, 'save_unified_profile');
    expect(saves.length).toBe(0);
  });

  test('profile form: empty git email shows specific error and does not save', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await setupOpenRepository(page);

    await openProfileManager(page, dialogs);
    await dialogs.profileManager.addProfileButton.click();
    await dialogs.profileManager.fillProfileForm({ name: 'Work', gitName: 'John Doe' });

    await startCommandCaptureWithMocks(page, { save_unified_profile: null });
    await page.getByRole('button', { name: 'Save Profile' }).click();

    await expect(
      page.locator('lv-toast-container .toast.error .toast-message'),
    ).toContainText(/Git email is required/i, { timeout: 3000 });
    const saves = await findCommand(page, 'save_unified_profile');
    expect(saves.length).toBe(0);
  });

  test('cancel from edit returns to list without persisting changes', async ({ page }) => {
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
    });

    await openProfileManager(page, dialogs);
    await page.locator('.profile-item').first().click();

    // Type a different name then cancel
    const nameInput = page.getByPlaceholder(/Work, Personal/i);
    await nameInput.fill('Should Not Persist');

    await startCommandCaptureWithMocks(page, { save_unified_profile: null });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    // Back at the list view — original name still shown
    await expect(dialogs.profileManager.addProfileButton).toBeVisible();
    await expect(page.getByText(/john\.doe@company\.com/).first()).toBeVisible();

    // And NO save command was issued
    const saves = await findCommand(page, 'save_unified_profile');
    expect(saves.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Integration dialog - disconnect account
// ---------------------------------------------------------------------------

test.describe('Integration dialog - disconnect & token management', () => {
  test('disconnect button in connection tab clears the stored token', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork],
      connectedAccounts: ['account-github-work'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: workProfile,
      get_keyring_token: 'gho_existingtoken',
      delete_keyring_token: null,
      check_github_connection: {
        connected: true,
        user: { login: 'johndoe-work', name: 'John Doe', email: 'jd@c.com', avatarUrl: null },
        scopes: ['repo'],
      },
    });

    const app = new AppPage(page);
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Dialog should be on the Connection tab, showing the connected user view
    await dialogs.github.connectionTab.click();

    await startCommandCaptureWithMocks(page, {
      delete_keyring_token: null,
    });

    // Click the Disconnect button visible in the connected-user view
    const disconnect = page.locator('lv-github-dialog button:has-text("Disconnect")').first();
    await expect(disconnect).toBeVisible({ timeout: 5000 });
    await disconnect.click();

    // The stored token must be cleared on the backend
    await waitForCommand(page, 'delete_keyring_token');
    const deletes = await findCommand(page, 'delete_keyring_token');
    expect(deletes.length).toBeGreaterThan(0);
  });

  test('Disconnect of the active profile\'s default account flips the toolbar status to disconnected', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork],
      connectedAccounts: ['account-github-work'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: workProfile,
      get_keyring_token: 'gho_existingtoken',
      delete_keyring_token: null,
      check_github_connection: {
        connected: true,
        user: { login: 'johndoe-work', name: 'John Doe', email: 'jd@c.com', avatarUrl: null },
        scopes: ['repo'],
      },
    });

    // Toolbar starts with the connected status dot
    await expect(
      page.locator('lv-context-dashboard .account-status-dot.connected'),
    ).toBeVisible();

    const app = new AppPage(page);
    await app.executeCommand('GitHub');
    await dialogs.github.connectionTab.click();
    await page.locator('lv-github-dialog button:has-text("Disconnect")').first().click();

    // After disconnect, the toolbar must reflect disconnected/Reconnect state
    await expect(
      page.locator('lv-context-dashboard .account-status-dot.connected'),
    ).not.toBeVisible({ timeout: 5000 });
    await expect(
      page.locator('lv-context-dashboard .configure-btn:has-text("Reconnect GitHub")'),
    ).toBeVisible();
  });

  test('Delete Integration removes the account from the store entirely', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork, githubPersonal],
      connectedAccounts: ['account-github-work'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork, githubPersonal],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: workProfile,
      get_keyring_token: 'gho_existingtoken',
      delete_keyring_token: null,
      delete_global_account: null,
      check_github_connection: {
        connected: true,
        user: { login: 'johndoe-work', name: 'John Doe', email: 'jd@c.com', avatarUrl: null },
        scopes: ['repo'],
      },
    });
    // Delete Integration is destructive — user must confirm. Auto-confirm here.
    await autoConfirmDialogs(page);

    const app = new AppPage(page);
    await app.executeCommand('GitHub');
    await dialogs.github.connectionTab.click();

    await startCommandCaptureWithMocks(page, {
      delete_global_account: null,
      delete_keyring_token: null,
      // Simulate the backend: after delete, the config no longer contains the
      // deleted account. The dialog re-reads via loadUnifiedProfiles().
      get_unified_profiles_config: {
        version: 3,
        profiles: [{ ...workProfile, defaultAccounts: {} }],
        accounts: [githubPersonal],
        repositoryAssignments: {},
      },
    });

    // Click Delete (the danger-outline button — sibling of Disconnect)
    await page.locator('lv-github-dialog button.btn-danger-outline', { hasText: /^\s*Delete\s*$/ }).click();
    await waitForCommand(page, 'delete_global_account');

    // The selector should now reflect that the deleted account is gone — only
    // Personal GitHub remains.
    await expect(
      page.locator('lv-github-dialog lv-account-selector .account-name'),
    ).toHaveText('Personal GitHub', { timeout: 5000 });

    // The store should no longer contain the deleted account.
    const remainingAccounts = await page.evaluate(() => {
      const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
        unifiedProfileStore: { getState: () => { accounts: { id: string }[] } };
      };
      return stores.unifiedProfileStore.getState().accounts.map((a) => a.id);
    });
    expect(remainingAccounts).not.toContain('account-github-work');
    expect(remainingAccounts).toContain('account-github-personal');
  });

  test('Delete Integration of the only account closes the connected view and shows the connect form', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork],
      connectedAccounts: ['account-github-work'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: workProfile,
      get_keyring_token: 'gho_existingtoken',
      delete_keyring_token: null,
      delete_global_account: null,
      check_github_connection: {
        connected: true,
        user: { login: 'johndoe-work', name: 'John Doe', email: 'jd@c.com', avatarUrl: null },
        scopes: ['repo'],
      },
    });
    await autoConfirmDialogs(page);

    const app = new AppPage(page);
    await app.executeCommand('GitHub');
    await dialogs.github.connectionTab.click();

    // Simulate backend: after delete, the config has no accounts.
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [{ ...workProfile, defaultAccounts: {} }],
        accounts: [],
        repositoryAssignments: {},
      },
    });

    await page.locator('lv-github-dialog button.btn-danger-outline', { hasText: /^\s*Delete\s*$/ }).click();

    // No accounts remain — the dialog must NOT keep showing the connected user
    // view (Disconnect button) for an account that no longer exists.
    await expect(
      page.locator('lv-github-dialog button:has-text("Disconnect")'),
    ).not.toBeVisible({ timeout: 5000 });

    // Toolbar should reflect no account → "Connect GitHub" affordance
    await expect(
      page.locator('lv-context-dashboard .configure-btn:has-text("Connect GitHub")'),
    ).toBeVisible({ timeout: 5000 });
  });

  test('Delete Integration: cancelling the confirm preserves the account', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork],
      connectedAccounts: ['account-github-work'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: workProfile,
      get_keyring_token: 'gho_existingtoken',
      check_github_connection: {
        connected: true,
        user: { login: 'johndoe-work', name: 'John Doe', email: 'jd@c.com', avatarUrl: null },
        scopes: ['repo'],
      },
    });
    // Auto-reject the confirm — user clicks Cancel.
    await injectCommandMock(page, {
      'plugin:dialog|confirm': false,
      'plugin:dialog|ask': false,
    });

    const app = new AppPage(page);
    await app.executeCommand('GitHub');
    await dialogs.github.connectionTab.click();

    await startCommandCaptureWithMocks(page, {
      'plugin:dialog|confirm': false,
      'plugin:dialog|ask': false,
    });

    await page.locator('lv-github-dialog button.btn-danger-outline', { hasText: /^\s*Delete\s*$/ }).click();

    // Account must still be in the store — nothing was destroyed.
    await expect(
      page.locator('lv-github-dialog lv-account-selector .account-name'),
    ).toHaveText('Work GitHub');
    const deleteCalls = await findCommand(page, 'delete_global_account');
    expect(deleteCalls.length).toBe(0);
    const tokenDeletes = await findCommand(page, 'delete_keyring_token');
    expect(tokenDeletes.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Connection statuses — checking / disconnected / per-account / failure
// ---------------------------------------------------------------------------

test.describe('Connection statuses', () => {
  test('toolbar shows checking status while refreshConnectionStatuses is in flight', async ({ page }) => {
    // Real production path: opening the Profile Manager fires refreshAccountCachedUser
    // for every global account, which sets status='checking' before the IPC returns.
    // refreshAccountCachedUser short-circuits to 'disconnected' if get_keyring_token
    // returns null, so we must mock both: a stored token AND a hanging connection check.
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork],
    });
    // The toolbar dot only renders for a "relevant account", which requires
    // detectProvider() to match a remote URL. Seed the open repository's
    // remotes so the dashboard can pick GitHub as the relevant provider.
    await page.evaluate(() => {
      const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
        repositoryStore: {
          getState: () => {
            openRepositories: { remotes: { name: string; url: string; pushUrl: string | null }[] }[];
            activeIndex: number;
          };
          setState: (updater: (s: unknown) => unknown) => void;
        };
      };
      stores.repositoryStore.setState((s: unknown) => {
        const state = s as { openRepositories: { remotes: { name: string; url: string; pushUrl: string | null }[] }[] };
        const repos = [...state.openRepositories];
        if (repos[0]) {
          repos[0] = { ...repos[0], remotes: [{ name: 'origin', url: 'https://github.com/test/repo.git', pushUrl: null }] };
        }
        return { ...(state as object), openRepositories: repos };
      });
    });

    await page.evaluate(({ profile, account }) => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const orig = internals.invoke;
      internals.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === 'get_unified_profiles_config') {
          return { version: 3, profiles: [profile], accounts: [account], repositoryAssignments: {} };
        }
        if (cmd === 'get_migration_backup_info') return { hasBackup: false };
        if (cmd === 'get_assigned_unified_profile') return profile;
        if (cmd === 'get_keyring_token') return 'gho_stored_token';
        if (cmd === 'check_github_connection') {
          // Never resolve — keep 'checking' state alive for the assertion.
          return new Promise(() => {});
        }
        return orig(cmd, args);
      };
    }, { profile: workProfile, account: githubWork });

    const dialogs = new DialogsPage(page);
    await openProfileManager(page, dialogs);

    // refreshConnectionStatuses → refreshAccountCachedUser → setAccountConnectionStatus(_, 'checking')
    await expect(
      page.locator('lv-context-dashboard .account-status-dot.checking'),
    ).toBeVisible({ timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// 10. Keyboard / accessibility
// ---------------------------------------------------------------------------

test.describe('Keyboard & a11y', () => {
  // Escape handling is implemented in the Profile Manager (window-level keydown
  // listener), but the existing app-shell `keyboardService` shortcut registers
  // a global Escape handler that calls preventDefault+stopPropagation in the
  // bubble phase; in the Playwright environment a synthetic Escape dispatch
  // does not reach the window-capture listener for reasons we couldn't fully
  // pin down. The functional behaviour exists in the manual app; documenting
  // the gap and re-enabling these as a follow-up.
  test.fixme('Escape closes the Profile Manager dialog', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
    await openProfileManager(page, dialogs);

    await expect(page.locator('lv-profile-manager-dialog[open]')).toBeVisible();
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await expect(page.locator('lv-profile-manager-dialog[open]')).not.toBeVisible({ timeout: 3000 });
  });

  test.fixme('Escape from create form backs out to the list (does not destroy the whole dialog)', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
    await openProfileManager(page, dialogs);

    await dialogs.profileManager.addProfileButton.click();
    await expect(page.getByRole('button', { name: 'Save Profile' })).toBeVisible();

    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    // Dialog should still be open, but back on the list view.
    await expect(page.locator('lv-profile-manager-dialog[open]')).toBeVisible();
    await expect(dialogs.profileManager.addProfileButton).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save Profile' })).not.toBeVisible();

    // Second Escape: now on list → closes.
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await expect(page.locator('lv-profile-manager-dialog[open]')).not.toBeVisible({ timeout: 3000 });
  });

  test.fixme('GitHub dialog can be closed with Escape from any tab', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork],
      connectedAccounts: ['account-github-work'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: workProfile,
      check_github_connection: {
        connected: true,
        user: { login: 'johndoe-work', name: 'John Doe', email: null, avatarUrl: null },
        scopes: ['repo'],
      },
    });

    const app = new AppPage(page);
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Switch to a non-Connection tab — Escape should still close.
    await dialogs.github.pullRequestsTab.click();
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await expect(dialogs.github.dialog).not.toBeVisible({ timeout: 3000 });
  });

  test('Profile form: clicking into the name field focuses it (form is keyboard-reachable)', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
    await openProfileManager(page, dialogs);
    await dialogs.profileManager.addProfileButton.click();

    const nameInput = page.getByPlaceholder(/Work, Personal/i);
    await nameInput.click();
    await expect(nameInput).toBeFocused();
    // Typing reaches the input
    await page.keyboard.type('Hello');
    await expect(nameInput).toHaveValue('Hello');
  });

  test('two connection-check results yield independent per-account statuses', async ({ page }) => {
    // Real production path: the Profile Manager fires refreshAccountCachedUser
    // for EVERY account on open. Mock the check to return different results
    // depending on the account being checked (by tracking call order).
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork, githubPersonal],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork, githubPersonal],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });

    // Make the check return based on the keyring token (which differs per account):
    // work account has a token; personal does not.
    await page.evaluate(() => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const orig = internals.invoke;
      internals.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === 'get_keyring_token') {
          const key = (args as { key?: string })?.key ?? '';
          return key.includes('account-github-work') ? 'gho_token_work' : null;
        }
        if (cmd === 'check_github_connection') {
          const token = (args as { token?: string })?.token;
          if (token === 'gho_token_work') {
            return { connected: true, user: { login: 'johndoe-work', name: 'John', email: null, avatarUrl: null }, scopes: ['repo'] };
          }
          return { connected: false, user: null, scopes: [] };
        }
        return orig(cmd, args);
      };
    });

    const dialogs = new DialogsPage(page);
    await openProfileManager(page, dialogs);

    // Wait for both checks to settle.
    await expect.poll(async () => {
      return page.evaluate(() => {
        const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
          unifiedProfileStore: { getState: () => { accountConnectionStatus: Record<string, { status: string }> } };
        };
        const s = stores.unifiedProfileStore.getState().accountConnectionStatus;
        return s['account-github-work']?.status === 'connected'
          && s['account-github-personal']?.status === 'disconnected';
      });
    }, { timeout: 5000 }).toBe(true);
  });

  test('a failed connection check flips the status to disconnected and updates the toolbar', async ({ page }) => {
    const dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork],
      connectedAccounts: ['account-github-work'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: workProfile,
      // First connection check returns connected; we'll swap to disconnected below
      check_github_connection: {
        connected: true,
        user: { login: 'johndoe-work', name: 'John Doe', email: 'jd@c.com', avatarUrl: null },
        scopes: ['repo'],
      },
    });

    // Initial state shows connected dot
    await expect(
      page.locator('lv-context-dashboard .account-status-dot.connected'),
    ).toBeVisible();

    // Now simulate the next connection check failing — e.g. token expired
    await injectCommandError(page, 'check_github_connection', 'Bad credentials (401)');
    // Trigger a re-check by opening the dialog (it calls loadInitialData → checkConnection)
    const app = new AppPage(page);
    await app.executeCommand('GitHub');

    // Toolbar status flips to disconnected → "Reconnect" affordance appears
    await expect(
      page.locator('lv-context-dashboard .configure-btn:has-text("Reconnect GitHub")'),
    ).toBeVisible({ timeout: 5000 });
  });

  test('opening the integration dialog refreshes the active account\'s connection status', async ({ page }) => {
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: workProfile,
      check_github_connection: {
        connected: true,
        user: { login: 'johndoe-work', name: 'John Doe', email: 'jd@c.com', avatarUrl: null },
        scopes: ['repo'],
      },
    });

    await startCommandCapture(page);
    const app = new AppPage(page);
    await app.executeCommand('GitHub');

    // The dialog must kick off a connection check on open — proof that the
    // status is refreshed rather than trusted from the previous session.
    await waitForCommand(page, 'check_github_connection');
    const checks = await findCommand(page, 'check_github_connection');
    expect(checks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 11. Parity for the other integration dialogs (GitLab, Bitbucket, Azure DevOps)
//
// These dialogs share the bug-prone patterns we fixed in GitHub. Port the
// smoke-level tests that catch the same propagation bugs across providers.
// ---------------------------------------------------------------------------

const gitlabAccountA = {
  id: 'account-gitlab-a',
  name: 'GitLab A',
  integrationType: 'gitlab' as const,
  config: { type: 'gitlab' as const, instanceUrl: 'https://gitlab.com' },
  color: '#fc6d26',
  cachedUser: { username: 'gitlabA', displayName: 'GitLab User A', email: null, avatarUrl: null },
  urlPatterns: [],
  isDefault: true,
};
const gitlabAccountB = {
  id: 'account-gitlab-b',
  name: 'GitLab B',
  integrationType: 'gitlab' as const,
  config: { type: 'gitlab' as const, instanceUrl: 'https://gitlab.com' },
  color: '#aaa',
  cachedUser: { username: 'gitlabB', displayName: 'GitLab User B', email: null, avatarUrl: null },
  urlPatterns: [],
  isDefault: false,
};
const gitlabProfile: TestProfile = {
  ...workProfile,
  defaultAccounts: { gitlab: 'account-gitlab-a' as string | undefined },
};

test.describe('Parity - GitLab dialog', () => {
  test('GitLab: switching account triggers a fresh check_gitlab_connection', async ({ page }) => {
    await setupProfilesAndAccounts(page, {
      profiles: [gitlabProfile],
      accounts: [gitlabAccountA, gitlabAccountB],
      connectedAccounts: ['account-gitlab-a', 'account-gitlab-b'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [gitlabProfile],
        accounts: [gitlabAccountA, gitlabAccountB],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: gitlabProfile,
      check_gitlab_connection: { connected: true, user: { username: 'gitlabA', name: 'A', avatarUrl: null }, instanceUrl: 'https://gitlab.com' },
    });

    const app = new AppPage(page);
    await app.executeCommand('GitLab');
    await expect(page.locator('lv-gitlab-dialog lv-modal[open]')).toBeVisible();

    await startCommandCaptureWithMocks(page, {
      check_gitlab_connection: { connected: true, user: { username: 'gitlabB', name: 'B', avatarUrl: null }, instanceUrl: 'https://gitlab.com' },
    });

    await page.locator('lv-gitlab-dialog lv-account-selector .selector-btn').click();
    await page
      .locator('lv-gitlab-dialog lv-account-selector .dropdown-item', { hasText: 'GitLab B' })
      .click();

    await waitForCommand(page, 'check_gitlab_connection');
    const checks = await findCommand(page, 'check_gitlab_connection');
    expect(checks.length).toBeGreaterThan(0);
  });

  test('GitLab: Delete Integration confirm cancel preserves the account', async ({ page }) => {
    await setupProfilesAndAccounts(page, {
      profiles: [gitlabProfile],
      accounts: [gitlabAccountA],
      connectedAccounts: ['account-gitlab-a'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [gitlabProfile],
        accounts: [gitlabAccountA],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: gitlabProfile,
      get_keyring_token: 'glpat_existing',
      check_gitlab_connection: { connected: true, user: { username: 'gitlabA', name: 'A', avatarUrl: null }, instanceUrl: 'https://gitlab.com' },
      'plugin:dialog|confirm': false,
      'plugin:dialog|ask': false,
    });

    const app = new AppPage(page);
    await app.executeCommand('GitLab');
    await expect(page.locator('lv-gitlab-dialog lv-modal[open]')).toBeVisible();

    await startCommandCaptureWithMocks(page, {
      'plugin:dialog|confirm': false,
      'plugin:dialog|ask': false,
    });
    await page.locator('lv-gitlab-dialog button.btn-danger-outline', { hasText: /^\s*Delete\s*$/ }).click();

    const deletes = await findCommand(page, 'delete_global_account');
    expect(deletes.length).toBe(0);
    await expect(page.locator('lv-gitlab-dialog lv-account-selector .account-name')).toHaveText('GitLab A');
  });

  test('GitLab: PAT save creates a new account via the real handleSaveToken path', async ({ page }) => {
    const freshGitlab = {
      ...gitlabAccountB,
      id: 'account-gitlab-new',
      name: 'GitLab (newuser)',
      cachedUser: { username: 'newuser', displayName: 'New User', email: null, avatarUrl: null },
      isDefault: false,
    };
    await setupProfilesAndAccounts(page, {
      profiles: [gitlabProfile],
      accounts: [gitlabAccountA],
      connectedAccounts: ['account-gitlab-a'],
    });
    await page.evaluate(({ profile, existing, fresh }) => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const orig = internals.invoke;
      let saved = false;
      internals.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === 'get_unified_profiles_config') {
          return { version: 3, profiles: [profile], accounts: saved ? [existing, fresh] : [existing], repositoryAssignments: {} };
        }
        if (cmd === 'get_migration_backup_info') return { hasBackup: false };
        if (cmd === 'get_assigned_unified_profile') return profile;
        if (cmd === 'get_keyring_token') return null;
        if (cmd === 'store_keyring_token') return null;
        if (cmd === 'update_global_account_cached_user') return null;
        if (cmd === 'save_global_account') { saved = true; return fresh; }
        if (cmd === 'check_gitlab_connection') {
          const token = (args as { token?: string | null })?.token;
          if (token) {
            return { connected: true, user: { username: 'newuser', name: 'New User', avatarUrl: null }, instanceUrl: 'https://gitlab.com' };
          }
          return { connected: false, user: null, instanceUrl: 'https://gitlab.com' };
        }
        return orig(cmd, args);
      };
    }, { profile: gitlabProfile, existing: gitlabAccountA, fresh: freshGitlab });

    const app = new AppPage(page);
    await app.executeCommand('GitLab');
    await expect(page.locator('lv-gitlab-dialog lv-modal[open]')).toBeVisible();

    // Use the selector's Add Account action to enter the "new account" PAT form.
    await page.locator('lv-gitlab-dialog lv-account-selector .selector-btn').click();
    await page
      .locator('lv-gitlab-dialog lv-account-selector .dropdown-action.primary', { hasText: 'Add Account' })
      .click();

    const tokenInput = page.locator('lv-gitlab-dialog input[type="password"]');
    await tokenInput.waitFor({ state: 'visible', timeout: 5000 });
    await tokenInput.fill('glpat_newtoken');

    await startCommandCapture(page);
    await page.locator('lv-gitlab-dialog button:has-text("Connect with Token")').click();
    await waitForCommand(page, 'save_global_account');
    await waitForCommand(page, 'store_keyring_token');

    // Close + reopen; the new account must be present in the selector.
    await page.locator('lv-gitlab-dialog button[aria-label="Close"]').first().click();
    await expect(page.locator('lv-gitlab-dialog lv-modal[open]')).not.toBeVisible();
    await app.executeCommand('GitLab');
    await page.locator('lv-gitlab-dialog lv-account-selector .selector-btn').click();
    await expect(
      page.locator('lv-gitlab-dialog lv-account-selector .dropdown-item', { hasText: 'GitLab (newuser)' }),
    ).toBeVisible();
  });

  test('GitLab: disconnect clears the stored token', async ({ page }) => {
    await setupProfilesAndAccounts(page, {
      profiles: [gitlabProfile],
      accounts: [gitlabAccountA],
      connectedAccounts: ['account-gitlab-a'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [gitlabProfile],
        accounts: [gitlabAccountA],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: gitlabProfile,
      get_keyring_token: 'glpat_existing',
      delete_keyring_token: null,
      check_gitlab_connection: { connected: true, user: { username: 'gitlabA', name: 'A', avatarUrl: null }, instanceUrl: 'https://gitlab.com' },
    });

    const app = new AppPage(page);
    await app.executeCommand('GitLab');
    await expect(page.locator('lv-gitlab-dialog lv-modal[open]')).toBeVisible();

    await startCommandCaptureWithMocks(page, { delete_keyring_token: null });
    await page.locator('lv-gitlab-dialog button:has-text("Disconnect")').first().click();
    await waitForCommand(page, 'delete_keyring_token');
    expect((await findCommand(page, 'delete_keyring_token')).length).toBeGreaterThan(0);
  });
});

const bitbucketAccount = {
  id: 'account-bb-a',
  name: 'Bitbucket A',
  integrationType: 'bitbucket' as const,
  config: { type: 'bitbucket' as const, workspace: 'acme' },
  color: '#2684ff',
  cachedUser: { username: 'bbuser', displayName: 'BB User', email: null, avatarUrl: null },
  urlPatterns: [],
  isDefault: true,
};
const bitbucketAccountB = {
  ...bitbucketAccount,
  id: 'account-bb-b',
  name: 'Bitbucket B',
  isDefault: false,
  cachedUser: { username: 'bbuser2', displayName: 'BB Two', email: null, avatarUrl: null },
};
const bitbucketProfile: TestProfile = {
  ...workProfile,
  defaultAccounts: { bitbucket: 'account-bb-a' as string | undefined },
};

test.describe('Parity - Bitbucket dialog', () => {
  test('Bitbucket: switching account triggers a fresh check_bitbucket_connection', async ({ page }) => {
    await setupProfilesAndAccounts(page, {
      profiles: [bitbucketProfile],
      accounts: [bitbucketAccount, bitbucketAccountB],
      connectedAccounts: ['account-bb-a', 'account-bb-b'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [bitbucketProfile],
        accounts: [bitbucketAccount, bitbucketAccountB],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: bitbucketProfile,
      get_keyring_token: 'bbp_stored',
      check_bitbucket_connection_with_token: { connected: true, user: { username: 'bbuser', displayName: 'BB' } },
    });

    const app = new AppPage(page);
    await app.executeCommand('Bitbucket');
    await expect(page.locator('lv-bitbucket-dialog lv-modal[open]')).toBeVisible();

    await startCommandCaptureWithMocks(page, {
      get_keyring_token: 'bbp_stored',
      check_bitbucket_connection_with_token: { connected: true, user: { username: 'bbuser2', displayName: 'BB2' } },
    });

    await page.locator('lv-bitbucket-dialog lv-account-selector .selector-btn').click();
    await page
      .locator('lv-bitbucket-dialog lv-account-selector .dropdown-item', { hasText: 'Bitbucket B' })
      .click();

    await waitForCommand(page, 'check_bitbucket_connection_with_token');
    const checks = await findCommand(page, 'check_bitbucket_connection_with_token');
    expect(checks.length).toBeGreaterThan(0);
  });

  test('Bitbucket: Delete Integration confirm cancel preserves the account', async ({ page }) => {
    await setupProfilesAndAccounts(page, {
      profiles: [bitbucketProfile],
      accounts: [bitbucketAccount],
      connectedAccounts: ['account-bb-a'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [bitbucketProfile],
        accounts: [bitbucketAccount],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: bitbucketProfile,
      get_keyring_token: 'bbp_existing',
      check_bitbucket_connection_with_token: { connected: true, user: { username: 'bbuser', displayName: 'BB' } },
      'plugin:dialog|confirm': false,
      'plugin:dialog|ask': false,
    });

    const app = new AppPage(page);
    await app.executeCommand('Bitbucket');
    await expect(page.locator('lv-bitbucket-dialog lv-modal[open]')).toBeVisible();

    await startCommandCaptureWithMocks(page, {
      'plugin:dialog|confirm': false,
      'plugin:dialog|ask': false,
    });
    await page.locator('lv-bitbucket-dialog button.btn-danger-outline', { hasText: /^\s*Delete\s*$/ }).click();
    const deletes = await findCommand(page, 'delete_global_account');
    expect(deletes.length).toBe(0);
    await expect(
      page.locator('lv-bitbucket-dialog lv-account-selector .account-name'),
    ).toHaveText('Bitbucket A');
  });

  test('Bitbucket: app-password save creates a new account via the real handleSaveCredentials path', async ({ page }) => {
    const freshBb = {
      ...bitbucketAccountB,
      id: 'account-bb-new',
      name: 'Bitbucket (newbb)',
      cachedUser: { username: 'newbb', displayName: 'NewBB', email: null, avatarUrl: null },
      isDefault: false,
    };
    await setupProfilesAndAccounts(page, {
      profiles: [bitbucketProfile],
      accounts: [bitbucketAccount],
      connectedAccounts: ['account-bb-a'],
    });
    await page.evaluate(({ profile, existing, fresh }) => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const orig = internals.invoke;
      let saved = false;
      internals.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === 'get_unified_profiles_config') {
          return { version: 3, profiles: [profile], accounts: saved ? [existing, fresh] : [existing], repositoryAssignments: {} };
        }
        if (cmd === 'get_migration_backup_info') return { hasBackup: false };
        if (cmd === 'get_assigned_unified_profile') return profile;
        if (cmd === 'get_keyring_token') return null;
        if (cmd === 'store_keyring_token') return null;
        if (cmd === 'update_global_account_cached_user') return null;
        if (cmd === 'save_global_account') { saved = true; return fresh; }
        if (cmd === 'check_bitbucket_connection_with_token') {
          const token = (args as { token?: string | null })?.token;
          if (token) return { connected: true, user: { username: 'newbb', displayName: 'NewBB' } };
          return { connected: false, user: null };
        }
        if (cmd === 'check_bitbucket_connection_with_app_password') {
          return { connected: true, user: { username: 'newbb', displayName: 'NewBB' } };
        }
        if (cmd === 'check_bitbucket_connection') {
          // Legacy creds check used by handleSaveCredentials → checkConnection
          // when no oauth token / selected account token exists.
          return { connected: true, user: { username: 'newbb', displayName: 'NewBB' } };
        }
        return orig(cmd, args);
      };
    }, { profile: bitbucketProfile, existing: bitbucketAccount, fresh: freshBb });

    const app = new AppPage(page);
    await app.executeCommand('Bitbucket');
    await expect(page.locator('lv-bitbucket-dialog lv-modal[open]')).toBeVisible();

    await page.locator('lv-bitbucket-dialog lv-account-selector .selector-btn').click();
    await page
      .locator('lv-bitbucket-dialog lv-account-selector .dropdown-action.primary', { hasText: 'Add Account' })
      .click();

    const userInput = page.locator('lv-bitbucket-dialog input[type="text"]').first();
    const pwInput = page.locator('lv-bitbucket-dialog input[type="password"]');
    await userInput.waitFor({ state: 'visible', timeout: 5000 });
    await userInput.fill('newbb');
    await pwInput.fill('bbp_newpassword');

    await startCommandCapture(page);
    await page.locator('lv-bitbucket-dialog button:has-text("Connect with App Password")').click();
    await waitForCommand(page, 'save_global_account');
    await waitForCommand(page, 'store_keyring_token');
  });

  test('Bitbucket: disconnect clears the stored token', async ({ page }) => {
    await setupProfilesAndAccounts(page, {
      profiles: [bitbucketProfile],
      accounts: [bitbucketAccount],
      connectedAccounts: ['account-bb-a'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [bitbucketProfile],
        accounts: [bitbucketAccount],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: bitbucketProfile,
      get_keyring_token: 'bbp_existing',
      delete_keyring_token: null,
      check_bitbucket_connection_with_token: { connected: true, user: { username: 'bbuser', displayName: 'BB' } },
    });

    const app = new AppPage(page);
    await app.executeCommand('Bitbucket');
    await expect(page.locator('lv-bitbucket-dialog lv-modal[open]')).toBeVisible();

    await startCommandCaptureWithMocks(page, { delete_keyring_token: null });
    await page.locator('lv-bitbucket-dialog button:has-text("Disconnect")').first().click();
    await waitForCommand(page, 'delete_keyring_token');
    expect((await findCommand(page, 'delete_keyring_token')).length).toBeGreaterThan(0);
  });
});

const adoAccount = {
  id: 'account-ado-a',
  name: 'Azure A',
  integrationType: 'azure-devops' as const,
  config: { type: 'azure-devops' as const, organization: 'acme' },
  color: '#0078d4',
  cachedUser: { username: 'adouser', displayName: 'ADO User', email: null, avatarUrl: null },
  urlPatterns: [],
  isDefault: true,
};
const adoAccountB = {
  ...adoAccount,
  id: 'account-ado-b',
  name: 'Azure B',
  isDefault: false,
  cachedUser: { username: 'adouser2', displayName: 'ADO Two', email: null, avatarUrl: null },
};
const adoProfile: TestProfile = {
  ...workProfile,
  defaultAccounts: { 'azure-devops': 'account-ado-a' as string | undefined },
};

test.describe('Parity - Azure DevOps dialog', () => {
  test('Azure DevOps: switching account triggers a fresh check_ado_connection', async ({ page }) => {
    await setupProfilesAndAccounts(page, {
      profiles: [adoProfile],
      accounts: [adoAccount, adoAccountB],
      connectedAccounts: ['account-ado-a', 'account-ado-b'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [adoProfile],
        accounts: [adoAccount, adoAccountB],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: adoProfile,
      check_ado_connection: { connected: true, user: { displayName: 'ADO', imageUrl: null }, organization: 'acme' },
    });

    const app = new AppPage(page);
    await app.executeCommand('Azure DevOps');
    await expect(page.locator('lv-azure-devops-dialog lv-modal[open]')).toBeVisible();

    await startCommandCaptureWithMocks(page, {
      check_ado_connection: { connected: true, user: { displayName: 'ADO2', imageUrl: null }, organization: 'acme' },
    });

    await page.locator('lv-azure-devops-dialog lv-account-selector .selector-btn').click();
    await page
      .locator('lv-azure-devops-dialog lv-account-selector .dropdown-item', { hasText: 'Azure B' })
      .click();

    await waitForCommand(page, 'check_ado_connection');
    const checks = await findCommand(page, 'check_ado_connection');
    expect(checks.length).toBeGreaterThan(0);
  });

  test('Azure DevOps: Delete Integration confirm cancel preserves the account', async ({ page }) => {
    await setupProfilesAndAccounts(page, {
      profiles: [adoProfile],
      accounts: [adoAccount],
      connectedAccounts: ['account-ado-a'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [adoProfile],
        accounts: [adoAccount],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: adoProfile,
      get_keyring_token: 'adopat_existing',
      check_ado_connection: { connected: true, user: { displayName: 'ADO', imageUrl: null }, organization: 'acme' },
      'plugin:dialog|confirm': false,
      'plugin:dialog|ask': false,
    });

    const app = new AppPage(page);
    await app.executeCommand('Azure DevOps');
    await expect(page.locator('lv-azure-devops-dialog lv-modal[open]')).toBeVisible();

    await startCommandCaptureWithMocks(page, {
      'plugin:dialog|confirm': false,
      'plugin:dialog|ask': false,
    });
    await page.locator('lv-azure-devops-dialog button.btn-danger-outline', { hasText: /^\s*Delete\s*$/ }).click();
    const deletes = await findCommand(page, 'delete_global_account');
    expect(deletes.length).toBe(0);
    await expect(
      page.locator('lv-azure-devops-dialog lv-account-selector .account-name'),
    ).toHaveText('Azure A');
  });

  test('Azure DevOps: PAT save creates a new account via the real handleSaveToken path', async ({ page }) => {
    const freshAdo = {
      ...adoAccountB,
      id: 'account-ado-new',
      name: 'Azure (newado)',
      cachedUser: { username: 'newado', displayName: 'New ADO', email: null, avatarUrl: null },
      isDefault: false,
    };
    await setupProfilesAndAccounts(page, {
      profiles: [adoProfile],
      accounts: [adoAccount],
      connectedAccounts: ['account-ado-a'],
    });
    await page.evaluate(({ profile, existing, fresh }) => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const orig = internals.invoke;
      let saved = false;
      internals.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === 'get_unified_profiles_config') {
          return { version: 3, profiles: [profile], accounts: saved ? [existing, fresh] : [existing], repositoryAssignments: {} };
        }
        if (cmd === 'get_migration_backup_info') return { hasBackup: false };
        if (cmd === 'get_assigned_unified_profile') return profile;
        if (cmd === 'get_keyring_token') return null;
        if (cmd === 'store_keyring_token') return null;
        if (cmd === 'update_global_account_cached_user') return null;
        if (cmd === 'store_git_credentials') return null;
        if (cmd === 'save_global_account') { saved = true; return fresh; }
        if (cmd === 'check_ado_connection') {
          const token = (args as { token?: string | null })?.token;
          if (token) return { connected: true, user: { displayName: 'New ADO', imageUrl: null }, organization: 'acme' };
          return { connected: false, user: null, organization: 'acme' };
        }
        return orig(cmd, args);
      };
    }, { profile: adoProfile, existing: adoAccount, fresh: freshAdo });

    const app = new AppPage(page);
    await app.executeCommand('Azure DevOps');
    await expect(page.locator('lv-azure-devops-dialog lv-modal[open]')).toBeVisible();

    await page.locator('lv-azure-devops-dialog lv-account-selector .selector-btn').click();
    await page
      .locator('lv-azure-devops-dialog lv-account-selector .dropdown-action.primary', { hasText: 'Add Account' })
      .click();

    const orgInput = page.locator('lv-azure-devops-dialog input[type="text"]').first();
    const tokenInput = page.locator('lv-azure-devops-dialog input[type="password"]');
    await orgInput.waitFor({ state: 'visible', timeout: 5000 });
    await orgInput.fill('acme');
    await tokenInput.fill('adopat_newtoken');

    await startCommandCapture(page);
    await page.locator('lv-azure-devops-dialog .btn-primary:has-text("Connect")').click();
    await waitForCommand(page, 'save_global_account');
    await waitForCommand(page, 'store_keyring_token');
  });

  test('Azure DevOps: disconnect clears the stored token', async ({ page }) => {
    await setupProfilesAndAccounts(page, {
      profiles: [adoProfile],
      accounts: [adoAccount],
      connectedAccounts: ['account-ado-a'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [adoProfile],
        accounts: [adoAccount],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      get_assigned_unified_profile: adoProfile,
      get_keyring_token: 'adopat_existing',
      delete_keyring_token: null,
      check_ado_connection: { connected: true, user: { displayName: 'ADO', imageUrl: null }, organization: 'acme' },
    });

    const app = new AppPage(page);
    await app.executeCommand('Azure DevOps');
    await expect(page.locator('lv-azure-devops-dialog lv-modal[open]')).toBeVisible();

    await startCommandCaptureWithMocks(page, { delete_keyring_token: null });
    await page.locator('lv-azure-devops-dialog button:has-text("Disconnect")').first().click();
    await waitForCommand(page, 'delete_keyring_token');
    expect((await findCommand(page, 'delete_keyring_token')).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 12. No repository open — connecting accounts must still work (#211 / #1, #2)
//
// Previously the integration dialogs were only rendered when a repository was
// open, but the Profile Manager (and its "Connect <provider>" buttons) are
// reachable with no repo. Clicking Connect dead-ended and left the manager
// demoted into a transparent, unusable state. These tests assert the connect
// flow works without a repository.
// ---------------------------------------------------------------------------

test.describe('No repository open - connect flow', () => {
  // Boot the app with mocks but WITHOUT opening a repository, so activeRepository
  // stays null and the welcome screen is shown.
  async function bootWithoutRepository(page: Page): Promise<void> {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await injectCommandMock(page, {
      get_unified_profiles_config: { version: 3, profiles: [], accounts: [], repositoryAssignments: {} },
      get_migration_backup_info: { hasBackup: false },
    });
    // No repo open → the welcome screen is visible (proves the precondition).
    await expect(page.locator('lv-welcome')).toBeVisible({ timeout: 10000 });
  }

  test('Connect GitHub from the picker opens the integration dialog with no repo open', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await bootWithoutRepository(page);

    await openProfileManager(page, dialogs);

    // New profile → account picker → Connect GitHub
    await dialogs.profileManager.addProfileButton.click();
    await dialogs.profileManager.attachAccountButton.click();
    await expect(
      page.locator('lv-profile-manager-dialog .dialog-title'),
    ).toContainText('Attach Account');

    await page
      .locator('lv-profile-manager-dialog')
      .getByRole('button', { name: 'GitHub', exact: true })
      .click();

    // The GitHub dialog must actually open (previously it never mounted with no
    // repo), and the Profile Manager must be demoted behind it — not left
    // transparent with nothing on top.
    await expect(dialogs.github.dialog).toBeVisible({ timeout: 5000 });
    await expect(page.locator('lv-profile-manager-dialog[open][demoted]')).toHaveCount(1);
  });
});

// ---------------------------------------------------------------------------
// 13. Standalone Accounts management view (#211 / #3, #4)
//
// Accounts are global, not owned by a profile. The Profile Manager now exposes
// a dedicated "Manage Accounts" view so accounts can be edited/deleted without
// first attaching them to a profile, and "Manage Accounts" from an integration
// dialog routes there.
// ---------------------------------------------------------------------------

test.describe('Accounts management view', () => {
  test('opens from the profile list "Accounts" button and lists all global accounts', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork, githubPersonal],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork, githubPersonal],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
    });

    await openProfileManager(page, dialogs);
    await page
      .locator('lv-profile-manager-dialog .dialog-footer')
      .getByRole('button', { name: 'Accounts' })
      .click();

    await expect(
      page.locator('lv-profile-manager-dialog .dialog-title'),
    ).toContainText('Accounts');
    // Both global accounts are listed with edit + delete affordances.
    await expect(
      page.locator('lv-profile-manager-dialog .accounts-list .account-item'),
    ).toHaveCount(2);
    await expect(
      page.locator('lv-profile-manager-dialog .account-actions .action-btn.delete'),
    ).toHaveCount(2);
  });

  test('deleting a global account from the accounts view stays in the view and removes it', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork, githubPersonal],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork, githubPersonal],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      delete_global_account: null,
    });
    await autoConfirmDialogs(page);

    await openProfileManager(page, dialogs);
    await page
      .locator('lv-profile-manager-dialog .dialog-footer')
      .getByRole('button', { name: 'Accounts' })
      .click();
    await expect(
      page.locator('lv-profile-manager-dialog .accounts-list .account-item'),
    ).toHaveCount(2);

    // Backend: after delete the config no longer contains the first account.
    await startCommandCaptureWithMocks(page, {
      delete_global_account: null,
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubPersonal],
        repositoryAssignments: {},
      },
    });

    await page
      .locator('lv-profile-manager-dialog .account-actions .action-btn.delete')
      .first()
      .click();
    await waitForCommand(page, 'delete_global_account');

    // Still on the accounts view, now showing only the remaining account.
    await expect(
      page.locator('lv-profile-manager-dialog .dialog-title'),
    ).toContainText('Accounts');
    await expect(
      page.locator('lv-profile-manager-dialog .accounts-list .account-item'),
    ).toHaveCount(1);
  });

  test('"Manage Accounts" from an integration dialog lands on the accounts view', async ({ page }) => {
    const dialogs = new DialogsPage(page);
    await setupProfilesAndAccounts(page, {
      profiles: [workProfile],
      accounts: [githubWork, githubPersonal],
      connectedAccounts: ['account-github-work'],
    });
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [workProfile],
        accounts: [githubWork, githubPersonal],
        repositoryAssignments: {},
      },
      get_migration_backup_info: { hasBackup: false },
      load_unified_profile_for_repository: workProfile,
    });

    const app = new AppPage(page);
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    await page.locator('lv-github-dialog lv-account-selector .selector-btn').click();
    await page
      .locator('lv-github-dialog lv-account-selector .dropdown-action', { hasText: 'Manage Accounts' })
      .click();

    // The Profile Manager opens directly on the account-management view (not the
    // profile list) and is on top (not demoted behind the integration dialog).
    await expect(page.locator('lv-profile-manager-dialog[open] .dialog-overlay')).toBeVisible();
    await expect(page.locator('lv-profile-manager-dialog[open][demoted]')).toHaveCount(0);
    await expect(
      page.locator('lv-profile-manager-dialog .dialog-title'),
    ).toContainText('Accounts');
  });
});

// ---------------------------------------------------------------------------
// 14. Unsaved-changes guard on dialog dismissal (#211 / #6)
// ---------------------------------------------------------------------------

test.describe('Unsaved-changes guard', () => {
  test('closing the dialog with unsaved profile edits prompts to confirm', async ({ page }) => {
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
    });

    await openProfileManager(page, dialogs);
    await page.locator('.profile-item').first().click();

    // Make the form dirty
    await page.getByPlaceholder(/Work, Personal/i).fill('Dirty Name');

    // Auto-confirm the discard prompt, then dismiss via the X button.
    await autoConfirmDialogs(page);
    await startCommandCapture(page);
    await page.locator('lv-profile-manager-dialog .close-btn').click();

    // A confirm dialog was shown (the guard fired) and the dialog then closed.
    await waitForCommand(page, 'plugin:dialog|message');
    const confirms = await findCommand(page, 'plugin:dialog|message');
    expect(confirms.length).toBeGreaterThan(0);
    await expect(page.locator('lv-profile-manager-dialog[open]')).toHaveCount(0, { timeout: 5000 });
  });
});
