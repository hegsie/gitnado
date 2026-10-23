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
  injectCommandHang,
  injectCommandMock,
  startCommandCaptureWithMocks,
  waitForCommand,
} from '../fixtures/test-helpers';

/**
 * E2E tests for Bitbucket Dialog
 * Tests dialog display, connection flow (App Password authentication), and close behavior.
 */

test.describe('Bitbucket Dialog - Dialog Display', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should open dialog with all tabs visible', async () => {
    await app.executeCommand('Bitbucket');

    await expect(dialogs.bitbucket.dialog).toBeVisible();
    await expect(dialogs.bitbucket.connectionTab).toBeVisible();
    await expect(dialogs.bitbucket.pullRequestsTab).toBeVisible();
    await expect(dialogs.bitbucket.issuesTab).toBeVisible();
    await expect(dialogs.bitbucket.pipelinesTab).toBeVisible();
  });

  test('should have connection tab active by default', async () => {
    await app.executeCommand('Bitbucket');

    await expect(dialogs.bitbucket.dialog).toBeVisible();
    await expect(dialogs.bitbucket.connectionTab).toBeVisible();
  });

  test('should be able to switch between tabs', async () => {
    await app.executeCommand('Bitbucket');
    await expect(dialogs.bitbucket.dialog).toBeVisible();

    await dialogs.bitbucket.pullRequestsTab.click();
    await dialogs.bitbucket.issuesTab.click();
    await dialogs.bitbucket.pipelinesTab.click();
    await dialogs.bitbucket.switchToConnectionTab();

    // Dialog remains open after tab navigation
    await expect(dialogs.bitbucket.dialog).toBeVisible();
  });
});

test.describe('Bitbucket Dialog - Connection Flow', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should show username and app password inputs when App Password method selected', async ({ page }) => {
    await app.executeCommand('Bitbucket');
    await expect(dialogs.bitbucket.dialog).toBeVisible();

    // Switch to App Password mode
    await dialogs.bitbucket.selectAppPasswordMethod();

    await expect(dialogs.bitbucket.usernameInput).toBeVisible();
    await expect(dialogs.bitbucket.appPasswordInput).toBeVisible();
    await expect(dialogs.bitbucket.connectButton).toBeVisible();
  });

  test('should be able to type in username and app password inputs', async ({ page }) => {
    await app.executeCommand('Bitbucket');
    await expect(dialogs.bitbucket.dialog).toBeVisible();

    await dialogs.bitbucket.selectAppPasswordMethod();

    await dialogs.bitbucket.usernameInput.fill('testuser');
    await dialogs.bitbucket.appPasswordInput.fill('app-password-123');

    await expect(dialogs.bitbucket.usernameInput).toHaveValue('testuser');
    await expect(dialogs.bitbucket.appPasswordInput).toHaveValue('app-password-123');
  });

  test('should call check_bitbucket_connection when connecting', async ({ page }) => {
    await app.executeCommand('Bitbucket');
    await expect(dialogs.bitbucket.dialog).toBeVisible();

    // Fill the credential form FIRST, against the default (not-connected) mock so
    // the inputs are reliably rendered. Injecting the connected mock before the
    // dialog's initial loadInitialData()/checkConnection() settles would race it:
    // if the injected mock won, the initial check would return connected and the
    // dialog would render the connected view (no inputs), timing out the fill.
    await dialogs.bitbucket.selectAppPasswordMethod();
    await dialogs.bitbucket.usernameInput.fill('testuser');
    await dialogs.bitbucket.appPasswordInput.fill('app-password-123');

    // Now inject the connected mock for the connect action. Bitbucket
    // handleSaveCredentials stores credentials, then builds the bbapp:-prefixed
    // Basic-auth credential and calls checkConnection() with it, which uses
    // check_bitbucket_connection_with_token. (This also resets the command
    // capture, so the assertion below sees only commands from the connect
    // click onward.)
    await startCommandCaptureWithMocks(page, {
      check_bitbucket_connection_with_token: {
        connected: true,
        user: { username: 'testuser', displayName: 'Test User', avatarUrl: '' },
      },
      store_keyring_token: null,
      get_keyring_token: null,
      delete_keyring_token: null,
    });

    await dialogs.bitbucket.connectButton.click();

    // Verify the connection check ran with the bbapp: Basic-auth credential —
    // app passwords must never be sent as a raw Bearer token
    await waitForCommand(page, 'check_bitbucket_connection_with_token');
    const connectCmds = await findCommand(page, 'check_bitbucket_connection_with_token');
    expect(connectCmds.length).toBeGreaterThan(0);
    expect(
      (connectCmds[0].args as { token?: string }).token
    ).toBe('bbapp:testuser:app-password-123');
  });

  test('should show error on failed connection', async ({ page }) => {
    await app.executeCommand('Bitbucket');
    await expect(dialogs.bitbucket.dialog).toBeVisible();

    // Inject error for the connection check command
    await injectCommandError(page, 'check_bitbucket_connection', 'Invalid credentials');

    // Switch to App Password mode and try to connect with invalid credentials
    await dialogs.bitbucket.selectAppPasswordMethod();
    await dialogs.bitbucket.usernameInput.fill('baduser');
    await dialogs.bitbucket.appPasswordInput.fill('wrong-password');
    await dialogs.bitbucket.connectButton.click();

    // Should still show the dialog with an error indicator
    await expect(dialogs.bitbucket.dialog).toBeVisible();
    await expect(page.locator('gn-bitbucket-dialog .error, gn-bitbucket-dialog .error-message, .toast.error').first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Bitbucket Dialog - Close', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should close dialog with Escape key', async () => {
    await app.executeCommand('Bitbucket');
    await expect(dialogs.bitbucket.dialog).toBeVisible();

    await dialogs.bitbucket.closeWithEscape();
    await expect(dialogs.bitbucket.dialog).not.toBeVisible();
  });

  test('should close dialog with close button', async () => {
    await app.executeCommand('Bitbucket');
    await expect(dialogs.bitbucket.dialog).toBeVisible();

    await dialogs.bitbucket.close();
    await expect(dialogs.bitbucket.dialog).not.toBeVisible();
  });
});

test.describe('Bitbucket Dialog - Extended Scenarios', () => {
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
      check_bitbucket_connection: {
        connected: true,
        user: { username: 'testuser', displayName: 'Test User', avatarUrl: '' },
      },
    });

    await app.executeCommand('Bitbucket');
    await expect(dialogs.bitbucket.dialog).toBeVisible();

    // Connection status should show the connected user info
    await expect(dialogs.bitbucket.connectionStatus).toBeVisible({ timeout: 10000 });
  });

  test('should show invalid credentials error message', async ({ page }) => {
    await app.executeCommand('Bitbucket');
    await expect(dialogs.bitbucket.dialog).toBeVisible();

    // Inject invalid credentials error for connection check
    await injectCommandError(page, 'check_bitbucket_connection', 'Invalid credentials: authentication failed');

    // Switch to App Password mode and try to connect with bad credentials
    await dialogs.bitbucket.selectAppPasswordMethod();
    await dialogs.bitbucket.usernameInput.fill('baduser');
    await dialogs.bitbucket.appPasswordInput.fill('wrong-password');
    await dialogs.bitbucket.connectButton.click();

    // Dialog should remain open with error displayed
    await expect(dialogs.bitbucket.dialog).toBeVisible();

    // Verify the error is shown within the dialog
    await expect(page.locator('gn-bitbucket-dialog .error, gn-bitbucket-dialog .error-message, .toast.error').first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Bitbucket Dialog - Cancelling a pending OAuth sign-in', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('releases the loopback port and re-enables Sign in', async ({ page }) => {
    await startCommandCaptureWithMocks(page, {
      oauth_get_authorize_url: {
        authorizeUrl: 'https://bitbucket.org/site/oauth2/authorize',
        state: 'st-1',
        // Bitbucket's registered redirect pins the callback to this port.
        loopbackPort: 8085,
      },
      // Don't actually open a browser window.
      'plugin:shell|open': null,
      oauth_cancel_flow: null,
    });
    // The callback never arrives — the user abandons the browser tab.
    await injectCommandHang(page, 'oauth_wait_for_callback');

    await app.executeCommand('Bitbucket');
    await expect(dialogs.bitbucket.dialog).toBeVisible();
    await dialogs.bitbucket.waitUntilReady();

    await dialogs.bitbucket.oauthSignInButton.click();
    await expect(dialogs.bitbucket.oauthCancelButton).toBeVisible();

    await dialogs.bitbucket.oauthCancelButton.click();

    // The backend loopback server is released, so the fixed port is free for a
    // retry instead of staying bound until the flow times out.
    await waitForCommand(page, 'oauth_cancel_flow');
    const cancelCalls = await findCommand(page, 'oauth_cancel_flow');
    expect(cancelCalls[0].args).toMatchObject({ port: 8085 });

    // And the form is usable again.
    await expect(dialogs.bitbucket.oauthCancelButton).toHaveCount(0);
    await expect(dialogs.bitbucket.oauthSignInButton).toBeEnabled();
  });
});


/**
 * The pull-request listing is capped at one page by the backend (`pagelen=30`).
 * The tab must say so and hand the user a link that opens the same filtered list
 * in Bitbucket - through the shell, not by navigating the webview.
 */
test.describe('Bitbucket Dialog - Capped list disclosure', () => {
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
    color: '#0052cc',
    defaultAccounts: { bitbucket: 'bb-acc-1' },
  };

  const cappedAccount: MockIntegrationAccount = {
    id: 'bb-acc-1',
    name: 'Bitbucket (bbuser)',
    integrationType: 'bitbucket',
    config: { type: 'bitbucket' },
    color: '#0052cc',
    cachedUser: { username: 'bbuser', displayName: 'BB User', avatarUrl: null },
    urlPatterns: [],
    isDefault: true,
  };

  const makePr = (n: number) => ({
    id: n,
    title: `Capped PR ${n}`,
    description: null,
    state: 'OPEN',
    author: { uuid: '{u1}', displayName: 'BB User', nickname: 'bbuser', avatarUrl: '' },
    createdOn: '2025-01-15T10:00:00Z',
    sourceBranch: `feature/${n}`,
    destinationBranch: 'main',
    url: `https://bitbucket.org/acme/widgets/pull-requests/${n}`,
  });

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(
      page,
      { profiles: [cappedProfile], accounts: [cappedAccount], connectedAccounts: ['bb-acc-1'] },
      { remotes: [{ name: 'origin', url: 'https://bitbucket.org/acme/widgets.git', pushUrl: null }] },
    );

    await startCommandCaptureWithMocks(page, {
      detect_bitbucket_repo: { workspace: 'acme', repoSlug: 'widgets', remoteName: 'origin' },
      check_bitbucket_connection: {
        connected: true,
        user: { uuid: '{u1}', displayName: 'BB User', nickname: 'bbuser', avatarUrl: '' },
      },
      check_bitbucket_connection_with_token: {
        connected: true,
        user: { uuid: '{u1}', displayName: 'BB User', nickname: 'bbuser', avatarUrl: '' },
      },
      list_bitbucket_pull_requests: Array.from({ length: 30 }, (_, index) => makePr(index + 1)),
      // The hint's link must reach the browser, not navigate the webview away.
      'plugin:shell|open': null,
    });
  });

  test('discloses the capped pull request list and opens Bitbucket for the rest', async ({ page }) => {
    await app.executeCommand('Bitbucket');
    await expect(dialogs.bitbucket.dialog).toBeVisible();
    await dialogs.bitbucket.pullRequestsTab.click();

    await expect(page.locator('gn-bitbucket-dialog .pr-item')).toHaveCount(30);

    const hint = page.locator('gn-bitbucket-dialog .capped-list-hint');
    await expect(hint).toContainText('more may exist');
    await expect(hint).toContainText('30');

    await hint.locator('a').click();

    await waitForCommand(page, 'plugin:shell|open');
    const opens = await findCommand(page, 'plugin:shell|open');
    expect((opens[0].args as { path: string }).path).toBe(
      'https://bitbucket.org/acme/widgets/pull-requests?state=OPEN',
    );

    // The dialog stays put - the link opened externally.
    await expect(dialogs.bitbucket.dialog).toBeVisible();
  });

  test('shows no cap disclosure when the pull request list is short', async ({ page }) => {
    await injectCommandMock(page, { list_bitbucket_pull_requests: [makePr(1)] });

    await app.executeCommand('Bitbucket');
    await expect(dialogs.bitbucket.dialog).toBeVisible();
    await dialogs.bitbucket.pullRequestsTab.click();

    await expect(page.locator('gn-bitbucket-dialog .pr-item')).toHaveCount(1);
    await expect(page.locator('gn-bitbucket-dialog .capped-list-hint')).toHaveCount(0);
  });
});
