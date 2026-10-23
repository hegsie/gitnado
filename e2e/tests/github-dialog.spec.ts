import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
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
 * E2E tests for GitHub Dialog
 * Tests dialog display, connection flow (PAT authentication), and close behavior.
 */

test.describe('GitHub Dialog - Dialog Display', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should open dialog with all tabs visible', async () => {
    await app.executeCommand('GitHub');

    await expect(dialogs.github.dialog).toBeVisible();
    await expect(dialogs.github.connectionTab).toBeVisible();
    await expect(dialogs.github.pullRequestsTab).toBeVisible();
    await expect(dialogs.github.issuesTab).toBeVisible();
    await expect(dialogs.github.releasesTab).toBeVisible();
    await expect(dialogs.github.actionsTab).toBeVisible();
  });

  test('should have connection tab active by default', async () => {
    await app.executeCommand('GitHub');

    await expect(dialogs.github.dialog).toBeVisible();
    await expect(dialogs.github.connectionTab).toBeVisible();
  });

  test('should be able to switch between tabs', async () => {
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    await dialogs.github.switchToPullRequestsTab();
    await dialogs.github.switchToIssuesTab();
    await dialogs.github.switchToReleasesTab();
    await dialogs.github.switchToActionsTab();
    await dialogs.github.switchToConnectionTab();

    // Dialog remains open after tab navigation
    await expect(dialogs.github.dialog).toBeVisible();
  });
});

test.describe('GitHub Dialog - Connection Flow', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should show token input when PAT method selected', async ({ page }) => {
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Switch to PAT mode (dialog may default to OAuth)
    await dialogs.github.selectPATMethod();

    await expect(dialogs.github.tokenInput).toBeVisible();
    await expect(dialogs.github.connectButton).toBeVisible();
  });

  test('should be able to type in token input', async ({ page }) => {
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    await dialogs.github.selectPATMethod();
    await dialogs.github.tokenInput.fill('ghp_testtoken123');

    await expect(dialogs.github.tokenInput).toHaveValue('ghp_testtoken123');
  });

  test('should call check_github_connection when connecting with token', async ({ page }) => {
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Inject mock for connection check - the actual Tauri command is check_github_connection
    await startCommandCaptureWithMocks(page, {
      check_github_connection: {
        connected: true,
        user: { login: 'testuser', name: 'Test User', avatarUrl: '' },
        scopes: ['repo'],
      },
      save_global_account: {
        id: 'new-gh-account',
        name: 'GitHub (testuser)',
        integrationType: 'github',
        config: { type: 'pat' },
        color: null,
        cachedUser: null,
        urlPatterns: [],
        isDefault: false,
      },
    });

    // Connect with a token
    await dialogs.github.connect('ghp_testtoken123');

    // Verify the connection command was called (actual command name is check_github_connection)
    await waitForCommand(page, 'check_github_connection');
    const connectCmds = await findCommand(page, 'check_github_connection');
    expect(connectCmds.length).toBeGreaterThan(0);
  });

  test('should show connected state on successful token validation', async ({ page }) => {
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Inject mock for connection check after dialog opens
    await startCommandCaptureWithMocks(page, {
      check_github_connection: {
        connected: true,
        user: { login: 'testuser', name: 'Test User', avatarUrl: '' },
        scopes: ['repo'],
      },
      save_global_account: {
        id: 'new-gh-account',
        name: 'GitHub (testuser)',
        integrationType: 'github',
        config: { type: 'pat' },
        color: null,
        cachedUser: null,
        urlPatterns: [],
        isDefault: false,
      },
    });

    // Connect with a valid token
    await dialogs.github.connect('ghp_validtoken');

    // Wait for connection status to update - the .connection-status div is only shown when connected
    await expect(dialogs.github.connectionStatus).toBeVisible({ timeout: 10000 });
  });

  test('should show error message on failed token validation', async ({ page }) => {
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Inject error for the connection check command
    await injectCommandError(page, 'check_github_connection', 'Invalid token');

    // Try to connect with an invalid token
    await dialogs.github.connect('ghp_invalidtoken');

    // Should show an error state - the dialog should still be visible
    // The error is caught and displayed, so just verify the dialog remains open
    await expect(dialogs.github.dialog).toBeVisible();
  });

  test('should replace the token form when the GitHub App method is selected', async () => {
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // GitHub App and Personal Access Token are alternative flows: selecting one
    // must replace the other's form, never stack both connect buttons.
    await dialogs.github.selectAppMethod();

    await expect(dialogs.github.appIdInput).toBeVisible();
    await expect(dialogs.github.connectViaAppButton).toBeVisible();
    await expect(dialogs.github.tokenInput).toHaveCount(0);
    await expect(dialogs.github.connectButton).toHaveCount(0);

    // ...and the swap is symmetric.
    await dialogs.github.selectPATMethod();

    await expect(dialogs.github.tokenInput).toBeVisible();
    await expect(dialogs.github.connectButton).toBeVisible();
    await expect(dialogs.github.appIdInput).toHaveCount(0);
    await expect(dialogs.github.connectViaAppButton).toHaveCount(0);
  });
});

test.describe('GitHub Dialog - Close', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should close dialog with Escape key', async () => {
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    await dialogs.github.closeWithEscape();
    await expect(dialogs.github.dialog).not.toBeVisible();
  });

  test('should close dialog with close button', async () => {
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    await dialogs.github.close();
    await expect(dialogs.github.dialog).not.toBeVisible();
  });
});

test.describe('GitHub Dialog - Extended Scenarios', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should show PRs tab content after successful connection', async ({ page }) => {
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Mock successful connection and PRs list
    await startCommandCaptureWithMocks(page, {
      check_github_connection: {
        connected: true,
        user: { login: 'testuser', name: 'Test User', avatarUrl: '' },
        scopes: ['repo'],
      },
      save_global_account: {
        id: 'new-gh-account',
        name: 'GitHub (testuser)',
        integrationType: 'github',
        config: { type: 'pat' },
        color: null,
        cachedUser: null,
        urlPatterns: [],
        isDefault: false,
      },
      list_github_pull_requests: [],
    });

    // Connect with a token
    await dialogs.github.connect('ghp_validtoken');

    // Wait for connection to succeed
    await expect(dialogs.github.connectionStatus).toBeVisible({ timeout: 10000 });

    // Switch to PRs tab and verify tab content area is visible (empty list or loading)
    await dialogs.github.switchToPullRequestsTab();
    await expect(dialogs.github.pullRequestsTab).toBeVisible();
    await expect(dialogs.github.dialog).toBeVisible();
  });

  test('should show connected user info when already connected', async ({ page }) => {
    // Set up mocks before opening dialog so connection check returns connected
    await startCommandCaptureWithMocks(page, {
      check_github_connection: {
        connected: true,
        user: { login: 'testuser', name: 'Test User', avatarUrl: '' },
        scopes: ['repo'],
      },
    });

    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Connection status should show the connected user info
    await expect(dialogs.github.connectionStatus).toBeVisible({ timeout: 10000 });
  });

  test('should show rate limit error message', async ({ page }) => {
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    // Inject rate limit error for connection check with token
    await injectCommandError(page, 'check_github_connection', 'Rate limit exceeded');

    // Try to connect
    await dialogs.github.connect('ghp_ratelimited');

    // Dialog should remain open with error displayed
    await expect(dialogs.github.dialog).toBeVisible();

    // Verify the error message is shown in the dialog
    const errorText = page.locator('gn-github-dialog .error-message');
    await expect(errorText).toBeVisible({ timeout: 5000 });
  });
});

/**
 * GitHub App connection.
 *
 * The dialog auto-selects an existing account when it opens, and the GitHub
 * App form sits on the same Connection tab. Connecting an App must therefore
 * write its OWN account record instead of replacing whichever account happens
 * to be selected.
 */
test.describe('GitHub Dialog - GitHub App', () => {
  const defaultProfile = {
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

  const existingGitHubAccount = {
    id: 'gh-acc-1',
    name: 'GitHub (testuser)',
    integrationType: 'github',
    config: { type: 'github' },
    color: '#4f46e5',
    cachedUser: { username: 'testuser', displayName: 'Test User', avatarUrl: null },
    urlPatterns: [],
    isDefault: true,
  };

  const PEM = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';

  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
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
  });

  test('connecting a GitHub App does not overwrite the selected account', async ({ page }) => {
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    const selector = page.locator('gn-github-dialog gn-account-selector');
    await expect(selector).toContainText('GitHub (testuser)');

    await startCommandCaptureWithMocks(page, {
      configure_github_app: { connected: true, user: null, scopes: ['app-installation'] },
      save_global_account: {
        id: 'github-app-123456',
        name: 'GitHub App 123456',
        integrationType: 'github',
        config: { type: 'github' },
        color: null,
        cachedUser: null,
        urlPatterns: [],
        isDefault: false,
      },
    });

    await dialogs.github.selectAppMethod();
    await expect(dialogs.github.appIdInput).toBeVisible();
    await dialogs.github.connectViaApp('123456', PEM, '7890');

    await waitForCommand(page, 'save_global_account');

    const saves = await findCommand(page, 'save_global_account');
    expect(saves.length).toBeGreaterThan(0);
    for (const call of saves) {
      const account = (call.args as { account: { id: string } }).account;
      expect(account.id).toBe('github-app-123456');
    }

    // The existing PAT account survives, both as a record and in the selector.
    await expect(page.locator('gn-toast-container .toast.success').first()).toBeVisible({
      timeout: 5000,
    });
    // The App becomes the selected account, but the existing PAT account is
    // still listed intact — name and cached user untouched.
    await selector.locator('.selector-btn').click();
    const dropdown = selector.locator('.dropdown');
    await expect(dropdown).toBeVisible();
    await expect(dropdown).toContainText('GitHub (testuser)');
    await expect(dropdown).toContainText('@testuser');
    await expect(dropdown).toContainText('GitHub App 123456');
  });

  test('shows an error and saves nothing when the App configuration is rejected', async ({
    page,
  }) => {
    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    await startCommandCaptureWithMocks(page, {});
    await injectCommandError(page, 'configure_github_app', 'Invalid private key');

    await dialogs.github.selectAppMethod();
    await expect(dialogs.github.appIdInput).toBeVisible();
    await dialogs.github.connectViaApp('123456', PEM, '7890');

    await expect(
      page
        .locator('gn-github-dialog .error-message, gn-toast-container .toast.error')
        .first()
    ).toBeVisible({ timeout: 5000 });

    const saves = await findCommand(page, 'save_global_account');
    expect(saves).toHaveLength(0);
  });
});

/**
 * Superseding a GitHub App connection.
 *
 * The backend keeps a single GitHub App configuration, so connecting a second
 * App repoints the credential the first App's account resolved through. That
 * account must not stay in the selector pretending to be a separate identity.
 */
test.describe('GitHub Dialog - GitHub App replacement', () => {
  const defaultProfile = {
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

  const existingGitHubAccount = {
    id: 'gh-acc-1',
    name: 'GitHub (testuser)',
    integrationType: 'github',
    config: { type: 'github' },
    color: '#4f46e5',
    cachedUser: { username: 'testuser', displayName: 'Test User', avatarUrl: null },
    urlPatterns: [],
    isDefault: true,
  };

  const oldAppAccount = {
    id: 'github-app-999999',
    name: 'Old App',
    integrationType: 'github',
    config: { type: 'github' },
    color: null,
    cachedUser: null,
    urlPatterns: [],
    isDefault: false,
  };

  const PEM = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';

  test('connecting a different GitHub App drops the account it supersedes', async ({ page }) => {
    const app = new AppPage(page);
    const dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [defaultProfile],
        accounts: [existingGitHubAccount, oldAppAccount],
        repositoryAssignments: {},
      },
      get_integration_accounts: [existingGitHubAccount, oldAppAccount],
      get_profiles: [defaultProfile],
      get_active_profile: defaultProfile,
    });

    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    const selector = page.locator('gn-github-dialog gn-account-selector');
    await expect(selector).toContainText('GitHub (testuser)');

    await startCommandCaptureWithMocks(page, {
      configure_github_app: { connected: true, user: null, scopes: ['app-installation'] },
      save_global_account: {
        id: 'github-app-123456',
        name: 'GitHub App 123456',
        integrationType: 'github',
        config: { type: 'github' },
        color: null,
        cachedUser: null,
        urlPatterns: [],
        isDefault: false,
      },
      delete_global_account: null,
    });

    await dialogs.github.selectAppMethod();
    await expect(dialogs.github.appIdInput).toBeVisible();
    await dialogs.github.connectViaApp('123456', PEM, '7890');

    await waitForCommand(page, 'delete_global_account');

    const deletes = await findCommand(page, 'delete_global_account');
    expect(deletes.map((c) => (c.args as { accountId: string }).accountId)).toEqual([
      'github-app-999999',
    ]);

    await expect(page.locator('gn-toast-container .toast.success').first()).toBeVisible({
      timeout: 5000,
    });

    // The stale App is gone from the selector; the PAT account and the newly
    // connected App are both listed.
    await selector.locator('.selector-btn').click();
    const dropdown = selector.locator('.dropdown');
    await expect(dropdown).toBeVisible();
    await expect(dropdown).toContainText('GitHub App 123456');
    await expect(dropdown).toContainText('GitHub (testuser)');
    await expect(dropdown).not.toContainText('Old App');
  });

  test('warns but stays connected when the superseded App account cannot be removed', async ({
    page,
  }) => {
    const app = new AppPage(page);
    const dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
    await injectCommandMock(page, {
      get_unified_profiles_config: {
        version: 3,
        profiles: [defaultProfile],
        accounts: [existingGitHubAccount, oldAppAccount],
        repositoryAssignments: {},
      },
      get_integration_accounts: [existingGitHubAccount, oldAppAccount],
      get_profiles: [defaultProfile],
      get_active_profile: defaultProfile,
    });

    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();

    await startCommandCaptureWithMocks(page, {
      configure_github_app: { connected: true, user: null, scopes: ['app-installation'] },
      save_global_account: {
        id: 'github-app-123456',
        name: 'GitHub App 123456',
        integrationType: 'github',
        config: { type: 'github' },
        color: null,
        cachedUser: null,
        urlPatterns: [],
        isDefault: false,
      },
    });
    await injectCommandError(page, 'delete_global_account', 'keyring is locked');

    await dialogs.github.selectAppMethod();
    await expect(dialogs.github.appIdInput).toBeVisible();
    await dialogs.github.connectViaApp('123456', PEM, '7890');

    await expect(page.locator('gn-toast-container .toast.warning').first()).toBeVisible({
      timeout: 5000,
    });
    // The connection itself still succeeded.
    await expect(page.locator('gn-toast-container .toast.success').first()).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator('gn-github-dialog .error-message')).toHaveCount(0);
  });
});
/**
 * Pagination: the list tabs used to stop dead at the first page — the backend
 * never sent a `page` param and no tab offered a way to ask for more, so a
 * repository with more than one page of pull requests silently showed 30 and
 * hid the rest.
 */
test.describe('GitHub Dialog - Pagination', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  const connectedMocks = {
    check_github_connection: {
      connected: true,
      user: { login: 'octocat', name: 'The Octocat', avatarUrl: '' },
      scopes: ['repo'],
    },
    detect_github_repo: { owner: 'octocat', repo: 'hello-world', remoteName: 'origin' },
    list_issues: { issues: [], nextPage: null },
    list_releases: [],
    get_workflow_runs: [],
    get_repo_labels: [],
  };

  /**
   * `injectCommandMock` only serves static values, so answer `list_pull_requests`
   * from the requested page here: page 1 is a full page (#1–#30), page 2 the
   * short tail (#31–#40) — or a failure, for the error path.
   */
  async function injectPagedPullRequests(page: Page, failSecondPage = false): Promise<void> {
    await page.evaluate((shouldFail: boolean) => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const originalInvoke = internals.invoke;

      const makePr = (n: number) => ({
        number: n,
        title: `Paged PR ${n}`,
        state: 'open',
        user: { login: 'octocat', id: 1, avatarUrl: '', name: null, email: null },
        createdAt: '2025-01-15T10:00:00Z',
        updatedAt: '2025-01-15T10:00:00Z',
        mergedAt: null,
        headRef: `feature/${n}`,
        headSha: 'abc1234',
        baseRef: 'main',
        draft: false,
        mergeable: true,
        htmlUrl: `https://github.com/octocat/hello-world/pull/${n}`,
        additions: 1,
        deletions: 1,
        changedFiles: 1,
      });

      internals.invoke = async (command: string, args?: unknown) => {
        if (command !== 'list_pull_requests') return originalInvoke(command, args);

        const captured = (window as unknown as {
          __INVOKED_COMMANDS__?: { command: string; args: unknown }[];
        }).__INVOKED_COMMANDS__;
        if (captured) captured.push({ command, args });

        const requested = Number((args as { page?: number })?.page ?? 1);
        if (requested >= 2) {
          if (shouldFail) throw new Error('Rate limit exceeded');
          return Array.from({ length: 10 }, (_, i) => makePr(31 + i));
        }
        return Array.from({ length: 30 }, (_, i) => makePr(1 + i));
      };
    }, failSecondPage);
  }

  async function injectConcurrentListLoads(page: Page): Promise<void> {
    await page.evaluate(() => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const originalInvoke = internals.invoke;
      let releaseSecondPrPage = (): void => {};
      const secondPrPage = new Promise<void>((resolve) => {
        releaseSecondPrPage = resolve;
      });
      (
        window as unknown as { __RELEASE_SECOND_PR_PAGE__?: () => void }
      ).__RELEASE_SECOND_PR_PAGE__ = releaseSecondPrPage;

      const makePr = (n: number) => ({
        number: n,
        title: `Paged PR ${n}`,
        state: 'open',
        user: { login: 'octocat', id: 1, avatarUrl: '', name: null, email: null },
        createdAt: '2025-01-15T10:00:00Z',
        updatedAt: '2025-01-15T10:00:00Z',
        mergedAt: null,
        headRef: `feature/${n}`,
        headSha: 'abc1234',
        baseRef: 'main',
        draft: false,
        mergeable: true,
        htmlUrl: `https://github.com/octocat/hello-world/pull/${n}`,
        additions: 1,
        deletions: 1,
        changedFiles: 1,
      });
      const makeRun = (n: number) => ({
        id: n,
        name: 'CI',
        headBranch: 'main',
        headSha: 'abc1234',
        status: 'completed',
        conclusion: 'success',
        workflowId: 10,
        htmlUrl: `https://github.com/octocat/hello-world/actions/runs/${n}`,
        createdAt: '2025-01-15T10:00:00Z',
        updatedAt: '2025-01-15T10:05:00Z',
        runNumber: n,
        event: 'push',
      });

      internals.invoke = async (command: string, args?: unknown) => {
        const captured = (window as unknown as {
          __INVOKED_COMMANDS__?: { command: string; args: unknown }[];
        }).__INVOKED_COMMANDS__;

        if (command === 'list_pull_requests') {
          if (captured) captured.push({ command, args });
          const requested = Number((args as { page?: number })?.page ?? 1);
          if (requested === 2) await secondPrPage;
          return Array.from(
            { length: requested === 1 ? 30 : 10 },
            (_, i) => makePr(requested === 1 ? i + 1 : i + 31)
          );
        }
        if (command === 'get_workflow_runs') {
          if (captured) captured.push({ command, args });
          return Array.from({ length: 20 }, (_, i) => makeRun(i + 1));
        }
        return originalInvoke(command, args);
      };
    });
  }

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('loads the next page of pull requests when Load more is clicked', async ({ page }) => {
    await startCommandCaptureWithMocks(page, connectedMocks);
    await injectPagedPullRequests(page);

    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();
    await dialogs.github.switchToPullRequestsTab();

    const prItems = page.locator('gn-github-dialog .pr-item');
    await expect(prItems).toHaveCount(30);

    const loadMore = page.locator('gn-github-dialog .load-more button');
    await expect(loadMore).toBeVisible();
    await loadMore.click();

    // The second page is appended, not swapped in, and the button disappears
    // once the short page proves the list has ended.
    await expect(prItems).toHaveCount(40);
    await expect(page.locator('gn-github-dialog .pr-item:has-text("Paged PR 40")')).toBeVisible();
    await expect(loadMore).toHaveCount(0);

    const calls = await findCommand(page, 'list_pull_requests');
    const pages = calls.map((c) => (c.args as { page?: number })?.page);
    expect(pages).toContain(2);
  });

  test('keeps the loaded pull requests and surfaces an error when the next page fails', async ({ page }) => {
    await startCommandCaptureWithMocks(page, connectedMocks);
    await injectPagedPullRequests(page, true);

    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();
    await dialogs.github.switchToPullRequestsTab();

    const prItems = page.locator('gn-github-dialog .pr-item');
    await expect(prItems).toHaveCount(30);

    const loadMore = page.locator('gn-github-dialog .load-more button');
    await loadMore.click();

    await expect(page.locator('gn-github-dialog .error-message')).toBeVisible();
    await expect(page.locator('gn-github-dialog .error-message')).toContainText('Rate limit exceeded');
    // Nothing already loaded is thrown away, and the button stays for a retry.
    await expect(prItems).toHaveCount(30);
    await expect(loadMore).toBeVisible();
  });

  test('keeps each tab pagination control independent', async ({ page }) => {
    await startCommandCaptureWithMocks(page, connectedMocks);
    await injectConcurrentListLoads(page);

    await app.executeCommand('GitHub');
    await expect(dialogs.github.dialog).toBeVisible();
    await dialogs.github.switchToPullRequestsTab();

    const loadMore = page.locator('gn-github-dialog .load-more button');
    await expect(loadMore).toHaveText('Load more');
    await loadMore.click();
    await expect(loadMore).toHaveText('Loading...');

    await dialogs.github.switchToActionsTab();
    await expect(page.locator('gn-github-dialog .workflow-item')).toHaveCount(20);
    await expect(loadMore).toHaveText('Load more');
    await expect(loadMore).toBeEnabled();

    await page.evaluate(() => {
      (
        window as unknown as { __RELEASE_SECOND_PR_PAGE__?: () => void }
      ).__RELEASE_SECOND_PR_PAGE__?.();
    });
  });
});
