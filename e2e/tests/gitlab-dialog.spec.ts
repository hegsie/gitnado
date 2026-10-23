import { test, expect } from '@playwright/test';
import {
  setupOpenRepository,
  setupProfilesAndAccounts,
  type MockIntegrationAccount,
  type MockUnifiedProfile,
} from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';
import { DialogsPage } from '../pages/dialogs.page';
import {
  startCommandCapture,
  findCommand,
  injectCommandError,
  injectCommandMock,
  startCommandCaptureWithMocks,
  waitForCommand,
} from '../fixtures/test-helpers';

/**
 * E2E tests for GitLab Dialog
 * Tests dialog display, connection flow (PAT authentication), and close behavior.
 */

test.describe('GitLab Dialog - Dialog Display', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should open dialog with all tabs visible', async () => {
    await app.executeCommand('GitLab');

    await expect(dialogs.gitlab.dialog).toBeVisible();
    await expect(dialogs.gitlab.connectionTab).toBeVisible();
    await expect(dialogs.gitlab.mergeRequestsTab).toBeVisible();
    await expect(dialogs.gitlab.issuesTab).toBeVisible();
    await expect(dialogs.gitlab.pipelinesTab).toBeVisible();
  });

  test('should have connection tab active by default', async () => {
    await app.executeCommand('GitLab');

    await expect(dialogs.gitlab.dialog).toBeVisible();
    await expect(dialogs.gitlab.connectionTab).toBeVisible();
  });

  test('should be able to switch between tabs', async () => {
    await app.executeCommand('GitLab');
    await expect(dialogs.gitlab.dialog).toBeVisible();

    await dialogs.gitlab.mergeRequestsTab.click();
    await dialogs.gitlab.issuesTab.click();
    await dialogs.gitlab.pipelinesTab.click();
    await dialogs.gitlab.switchToConnectionTab();

    // Dialog remains open after tab navigation
    await expect(dialogs.gitlab.dialog).toBeVisible();
  });
});

test.describe('GitLab Dialog - Connection Flow', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should show instance URL and token inputs when PAT method selected', async ({ page }) => {
    await app.executeCommand('GitLab');
    await expect(dialogs.gitlab.dialog).toBeVisible();

    // Switch to PAT mode if OAuth is configured
    await dialogs.gitlab.selectPATMethod();

    await expect(dialogs.gitlab.instanceUrlInput).toBeVisible();
    await expect(dialogs.gitlab.tokenInput).toBeVisible();
    await expect(dialogs.gitlab.connectButton).toBeVisible();
  });

  test('should be able to type in token input', async ({ page }) => {
    await app.executeCommand('GitLab');
    await expect(dialogs.gitlab.dialog).toBeVisible();

    await dialogs.gitlab.selectPATMethod();
    await dialogs.gitlab.tokenInput.fill('glpat-testtoken123');

    await expect(dialogs.gitlab.tokenInput).toHaveValue('glpat-testtoken123');
  });

  test('should call check_gitlab_connection when connecting with token', async ({ page }) => {
    await app.executeCommand('GitLab');
    await expect(dialogs.gitlab.dialog).toBeVisible();

    // Inject mock for connection check after dialog opens
    // The actual Tauri command is check_gitlab_connection (not check_gitlab_connection_with_token)
    await startCommandCaptureWithMocks(page, {
      check_gitlab_connection: {
        connected: true,
        user: { username: 'testuser', name: 'Test User', avatarUrl: '' },
      },
      save_global_account: {
        id: 'new-gl-account',
        name: 'GitLab (testuser)',
        integrationType: 'gitlab',
        config: { type: 'pat', instanceUrl: 'https://gitlab.com' },
        color: null,
        cachedUser: null,
        urlPatterns: [],
        isDefault: false,
      },
    });

    // Switch to PAT mode and fill in credentials
    await dialogs.gitlab.selectPATMethod();
    await dialogs.gitlab.tokenInput.fill('glpat-testtoken123');
    await dialogs.gitlab.connectButton.click();

    // Verify the connection command was called (actual command name is check_gitlab_connection)
    await waitForCommand(page, 'check_gitlab_connection');
    const connectCmds = await findCommand(page, 'check_gitlab_connection');
    expect(connectCmds.length).toBeGreaterThan(0);
  });

  test('should show error on failed token validation', async ({ page }) => {
    await app.executeCommand('GitLab');
    await expect(dialogs.gitlab.dialog).toBeVisible();

    // Inject error for the connection check command
    await injectCommandError(page, 'check_gitlab_connection', 'Invalid token');

    // Switch to PAT mode and try to connect with invalid token
    await dialogs.gitlab.selectPATMethod();
    await dialogs.gitlab.tokenInput.fill('glpat-invalidtoken');
    await dialogs.gitlab.connectButton.click();

    // Should still show the dialog (error is displayed within it)
    await expect(dialogs.gitlab.dialog).toBeVisible();
  });
});

test.describe('GitLab Dialog - Close', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should close dialog with Escape key', async () => {
    await app.executeCommand('GitLab');
    await expect(dialogs.gitlab.dialog).toBeVisible();

    await dialogs.gitlab.closeWithEscape();
    await expect(dialogs.gitlab.dialog).not.toBeVisible();
  });

  test('should close dialog with close button', async () => {
    await app.executeCommand('GitLab');
    await expect(dialogs.gitlab.dialog).toBeVisible();

    await dialogs.gitlab.close();
    await expect(dialogs.gitlab.dialog).not.toBeVisible();
  });
});

test.describe('GitLab Dialog - Extended Scenarios', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should show connected user info when already connected', async ({ page }) => {
    // Set up mocks before opening dialog so connection check returns connected
    await startCommandCaptureWithMocks(page, {
      check_gitlab_connection: {
        connected: true,
        user: { username: 'testuser', name: 'Test User', avatarUrl: '' },
      },
    });

    await app.executeCommand('GitLab');
    await expect(dialogs.gitlab.dialog).toBeVisible();

    // Connection status should show the connected user info
    await expect(dialogs.gitlab.connectionStatus).toBeVisible({ timeout: 10000 });
  });

  test('should show network error message on connection failure', async ({ page }) => {
    await app.executeCommand('GitLab');
    await expect(dialogs.gitlab.dialog).toBeVisible();

    // Inject network error for connection check
    await injectCommandError(page, 'check_gitlab_connection', 'Network error: unable to reach GitLab server');

    // Switch to PAT mode and try to connect
    await dialogs.gitlab.selectPATMethod();
    await dialogs.gitlab.tokenInput.fill('glpat-networkerror');
    await dialogs.gitlab.connectButton.click();

    // Dialog should remain open with error displayed
    await expect(dialogs.gitlab.dialog).toBeVisible();

    // Verify the error is shown within the dialog
    const errorText = page.locator('gn-gitlab-dialog .error');
    await expect(errorText).toBeVisible({ timeout: 5000 });
  });
});

/**
 * Regression: GitLab OAuth access tokens expire in ~2h. The dialog read the raw
 * stored access token, so a signed-in account read as disconnected on the next
 * open (and was marked disconnected app-wide) even though a valid refresh token
 * was stored. Opening the dialog must refresh the expiring token first.
 */
test.describe('GitLab Dialog - OAuth token refresh', () => {
  const oauthProfile: MockUnifiedProfile = {
    id: 'profile-1',
    name: 'Default',
    gitName: 'Test User',
    gitEmail: 'test@example.com',
    signingKey: null,
    urlPatterns: [],
    isDefault: true,
    color: '#4f46e5',
    defaultAccounts: { gitlab: 'gl-oauth-1' },
  };

  const oauthAccount: MockIntegrationAccount = {
    id: 'gl-oauth-1',
    name: 'GitLab (gluser)',
    integrationType: 'gitlab',
    config: { type: 'gitlab', instanceUrl: 'https://gitlab.com' },
    color: '#4f46e5',
    cachedUser: { username: 'gluser', displayName: 'GL User', avatarUrl: null },
    urlPatterns: [],
    isDefault: true,
  };

  test('refreshes an expiring OAuth token when the dialog opens', async ({ page }) => {
    await setupProfilesAndAccounts(page, {
      profiles: [oauthProfile],
      accounts: [oauthAccount],
      connectedAccounts: ['gl-oauth-1'],
    });

    await startCommandCaptureWithMocks(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [oauthProfile],
        accounts: [oauthAccount],
        repositoryAssignments: {},
      },
      // The stored credential is an OAuth bundle whose access token is inside
      // the 5-minute refresh window.
      get_keyring_token: JSON.stringify({
        accessToken: 'stale-access',
        refreshToken: 'r1',
        expiresAt: Date.now() + 60000,
      }),
      store_keyring_token: null,
      oauth_refresh_token: { accessToken: 'fresh-access', refreshToken: 'r2', expiresIn: 3600 },
      check_gitlab_connection: {
        connected: true,
        user: { username: 'gluser', name: 'GL User', avatarUrl: '' },
      },
    });

    const app2 = new AppPage(page);
    const dialogs2 = new DialogsPage(page);
    await app2.executeCommand('GitLab');
    await expect(dialogs2.gitlab.dialog).toBeVisible();

    // The expiring token is refreshed and the FRESH token is what gets verified.
    await waitForCommand(page, 'oauth_refresh_token');
    await waitForCommand(page, 'check_gitlab_connection');
    const checks = await findCommand(page, 'check_gitlab_connection');
    expect(checks.length).toBeGreaterThan(0);
    expect((checks[0].args as { token: string }).token).toBe('fresh-access');

    // The user sees the connected account, not the connect form.
    await expect(dialogs2.gitlab.connectionStatus).toBeVisible({ timeout: 10000 });
    await expect(dialogs2.gitlab.connectionStatus).toContainText('gluser');
  });
});


/**
 * The merge-request listing is capped at one page by the backend (`per_page=30`).
 * The tab must say so and hand the user a link that opens the same filtered list
 * in GitLab - through the shell, not by navigating the webview.
 */
test.describe('GitLab Dialog - Capped list disclosure', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  const cappedProfile: MockUnifiedProfile = {
    id: 'profile-1',
    name: 'Default',
    gitName: 'Test User',
    gitEmail: 'test@example.com',
    signingKey: null,
    urlPatterns: [],
    isDefault: true,
    color: '#4f46e5',
    defaultAccounts: { gitlab: 'gl-acc-1' },
  };

  const cappedAccount: MockIntegrationAccount = {
    id: 'gl-acc-1',
    name: 'GitLab (gluser)',
    integrationType: 'gitlab',
    config: { type: 'gitlab', instanceUrl: 'https://gitlab.com' },
    color: '#4f46e5',
    cachedUser: { username: 'gluser', displayName: 'GL User', avatarUrl: null },
    urlPatterns: [],
    isDefault: true,
  };

  const makeMr = (n: number) => ({
    iid: n,
    title: `Capped MR ${n}`,
    description: null,
    state: 'opened',
    author: { id: 1, username: 'gluser', name: 'GL User', avatarUrl: '', webUrl: '' },
    createdAt: '2025-01-15T10:00:00Z',
    sourceBranch: `feature/${n}`,
    targetBranch: 'main',
    draft: false,
    webUrl: `https://gitlab.com/acme/widgets/-/merge_requests/${n}`,
  });

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(
      page,
      { profiles: [cappedProfile], accounts: [cappedAccount], connectedAccounts: ['gl-acc-1'] },
      { remotes: [{ name: 'origin', url: 'https://gitlab.com/acme/widgets.git', pushUrl: null }] },
    );

    await startCommandCaptureWithMocks(page, {
      detect_gitlab_repo: {
        instanceUrl: 'https://gitlab.com',
        projectPath: 'acme/widgets',
        remoteName: 'origin',
      },
      check_gitlab_connection: {
        connected: true,
        user: { username: 'gluser', name: 'GL User', avatarUrl: '' },
      },
      list_gitlab_merge_requests: Array.from({ length: 30 }, (_, index) => makeMr(index + 1)),
      // The hint's link must reach the browser, not navigate the webview away.
      'plugin:shell|open': null,
    });
  });

  test('discloses the capped merge request list and opens GitLab for the rest', async ({ page }) => {
    await app.executeCommand('GitLab');
    await expect(dialogs.gitlab.dialog).toBeVisible();
    await dialogs.gitlab.mergeRequestsTab.click();

    await expect(page.locator('gn-gitlab-dialog .mr-item')).toHaveCount(30);

    const hint = page.locator('gn-gitlab-dialog .capped-list-hint');
    await expect(hint).toContainText('more may exist');
    await expect(hint).toContainText('30');

    await hint.locator('a').click();

    await waitForCommand(page, 'plugin:shell|open');
    const opens = await findCommand(page, 'plugin:shell|open');
    expect((opens[0].args as { path: string }).path).toBe(
      'https://gitlab.com/acme/widgets/-/merge_requests?state=opened',
    );

    // The dialog stays put - the link opened externally.
    await expect(dialogs.gitlab.dialog).toBeVisible();
  });

  test('shows no cap disclosure when the merge request list is short', async ({ page }) => {
    await injectCommandMock(page, { list_gitlab_merge_requests: [makeMr(1)] });

    await app.executeCommand('GitLab');
    await expect(dialogs.gitlab.dialog).toBeVisible();
    await dialogs.gitlab.mergeRequestsTab.click();

    await expect(page.locator('gn-gitlab-dialog .mr-item')).toHaveCount(1);
    await expect(page.locator('gn-gitlab-dialog .capped-list-hint')).toHaveCount(0);
  });
});
