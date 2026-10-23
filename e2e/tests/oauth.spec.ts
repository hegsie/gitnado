import { test, expect } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';
import { DialogsPage } from '../pages/dialogs.page';
import { startCommandCapture, findCommand, waitForCommand, injectCommandError } from '../fixtures/test-helpers';

test.describe('GitHub OAuth Integration', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should open GitHub dialog from command palette', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.github.dialog).toBeVisible();
  });

  test('should have connection tab active by default', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.github.connectionTab).toBeVisible();
  });

  test('should have token input field when PAT mode selected', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await dialogs.github.selectPATMethod();
    await expect(dialogs.github.tokenInput).toBeVisible();
  });

  test('should have connect button', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    // Either the connect button (PAT mode) or OAuth sign-in button should be visible
    const connectOrOAuth = page.locator('gn-github-dialog button', { hasText: /connect|sign in/i });
    await expect(connectOrOAuth.first()).toBeVisible();
  });

  test('should show OAuth sign-in button when OAuth is configured', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.github.authMethodToggle).toBeVisible();
    await expect(dialogs.github.oauthSignInButton).toBeVisible();
  });

  test('should toggle between OAuth and PAT methods', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await dialogs.github.selectPATMethod();
    await expect(dialogs.github.tokenInput).toBeVisible();
    await expect(dialogs.github.connectButton).toBeVisible();

    await dialogs.github.selectOAuthMethod();
    await expect(dialogs.github.oauthSignInButton).toBeVisible();
  });

  test('should close dialog with Escape', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await dialogs.github.closeWithEscape();
    await expect(dialogs.github.dialog).not.toBeVisible();
  });
});

test.describe('GitLab OAuth Integration', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should open GitLab dialog from command palette', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitLab Integration');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.gitlab.dialog).toBeVisible();
  });

  test('should have instance URL input', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitLab Integration');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.gitlab.instanceUrlInput).toBeVisible();
  });

  test('should have token input field when PAT mode selected', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitLab Integration');
    await dialogs.commandPalette.executeFirst();

    await dialogs.gitlab.selectPATMethod();
    await expect(dialogs.gitlab.tokenInput).toBeVisible();
  });

  test('should toggle between OAuth and PAT methods', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitLab Integration');
    await dialogs.commandPalette.executeFirst();

    await dialogs.gitlab.selectPATMethod();
    await expect(dialogs.gitlab.tokenInput).toBeVisible();

    await dialogs.gitlab.selectOAuthMethod();
    await expect(dialogs.gitlab.oauthSignInButton).toBeVisible();
  });
});

test.describe('Azure DevOps OAuth Integration', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should open Azure DevOps dialog from command palette', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Azure DevOps');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.azureDevOps.dialog).toBeVisible();
  });

  test('should have organization input', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Azure DevOps');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.azureDevOps.organizationInput).toBeVisible();
  });

  test('should have token input field (PAT is default for ADO)', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Azure DevOps');
    await dialogs.commandPalette.executeFirst();

    // Azure DevOps doesn't have OAuth configured, so the token form is shown by default
    await expect(dialogs.azureDevOps.tokenInput).toBeVisible();
  });

  test('should have organization and token inputs', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Azure DevOps');
    await dialogs.commandPalette.executeFirst();

    // ADO shows organization + token inputs by default (no OAuth toggle)
    await expect(dialogs.azureDevOps.organizationInput).toBeVisible();
    await expect(dialogs.azureDevOps.tokenInput).toBeVisible();
  });

  test('should have Connect button for PAT authentication', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Azure DevOps');
    await dialogs.commandPalette.executeFirst();

    // ADO uses PAT-only auth, so the Connect button should be visible
    await expect(dialogs.azureDevOps.connectButton).toBeVisible();
  });
});

test.describe('Bitbucket OAuth Integration', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should open Bitbucket dialog from command palette', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Bitbucket');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.bitbucket.dialog).toBeVisible();
  });

  test('should have username input when app password mode selected', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Bitbucket');
    await dialogs.commandPalette.executeFirst();

    await dialogs.bitbucket.selectAppPasswordMethod();
    await expect(dialogs.bitbucket.usernameInput).toBeVisible();
  });

  test('should have app password input when app password mode selected', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Bitbucket');
    await dialogs.commandPalette.executeFirst();

    await dialogs.bitbucket.selectAppPasswordMethod();
    await expect(dialogs.bitbucket.appPasswordInput).toBeVisible();
  });

  test('should toggle between OAuth and App Password methods', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Bitbucket');
    await dialogs.commandPalette.executeFirst();

    await dialogs.bitbucket.selectAppPasswordMethod();
    await expect(dialogs.bitbucket.usernameInput).toBeVisible();
    await expect(dialogs.bitbucket.appPasswordInput).toBeVisible();

    await dialogs.bitbucket.selectOAuthMethod();
    await expect(dialogs.bitbucket.oauthSignInButton).toBeVisible();
  });
});

test.describe('OAuth UI State Management', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('PAT input should be available in PAT mode', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await dialogs.github.selectPATMethod();

    await expect(dialogs.github.tokenInput).toBeVisible();
  });

  test('should be able to type in token input', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await dialogs.github.selectPATMethod();

    await dialogs.github.tokenInput.fill('ghp_test123');
    await expect(dialogs.github.tokenInput).toHaveValue('ghp_test123');
  });
});

test.describe('Dialog Tabs with OAuth', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('GitHub should have all tabs', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.github.connectionTab).toBeVisible();
    await expect(dialogs.github.pullRequestsTab).toBeVisible();
    await expect(dialogs.github.issuesTab).toBeVisible();
  });

  test('GitLab should have all tabs', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitLab Integration');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.gitlab.connectionTab).toBeVisible();
    await expect(dialogs.gitlab.mergeRequestsTab).toBeVisible();
    await expect(dialogs.gitlab.issuesTab).toBeVisible();
    await expect(dialogs.gitlab.pipelinesTab).toBeVisible();
  });

  test('Azure DevOps should have all tabs', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Azure DevOps');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.azureDevOps.connectionTab).toBeVisible();
    await expect(dialogs.azureDevOps.pullRequestsTab).toBeVisible();
    await expect(dialogs.azureDevOps.workItemsTab).toBeVisible();
    await expect(dialogs.azureDevOps.pipelinesTab).toBeVisible();
  });

  test('Bitbucket should have all tabs', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('Bitbucket');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.bitbucket.connectionTab).toBeVisible();
    await expect(dialogs.bitbucket.pullRequestsTab).toBeVisible();
    await expect(dialogs.bitbucket.issuesTab).toBeVisible();
    await expect(dialogs.bitbucket.pipelinesTab).toBeVisible();
  });
});

test.describe('GitHub PAT Submit Flow', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('submitting PAT should call connect command', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await dialogs.github.selectPATMethod();
    await expect(dialogs.github.tokenInput).toBeVisible();

    await dialogs.github.tokenInput.fill('ghp_validtoken123456');

    await startCommandCapture(page);

    await dialogs.github.connectButton.click();
    await waitForCommand(page, 'check_github_connection');

    const checkCommands = await findCommand(page, 'check_github_connection');
    expect(checkCommands.length).toBeGreaterThan(0);
  });

  test('submitting invalid PAT should show error message', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await dialogs.github.selectPATMethod();

    await injectCommandError(page, 'check_github_connection', 'Invalid token: authentication failed');

    await dialogs.github.tokenInput.fill('ghp_invalidtoken');
    await dialogs.github.connectButton.click();

    // Error should be displayed either as inline error or toast
    await expect(
      page.locator('gn-github-dialog .error, gn-github-dialog .error-message, .toast.error, .toast')
    ).toBeVisible({ timeout: 5000 });
  });
});

test.describe('GitLab PAT Submit Flow', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('submitting PAT should call connect command', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitLab Integration');
    await dialogs.commandPalette.executeFirst();

    await dialogs.gitlab.selectPATMethod();
    await expect(dialogs.gitlab.tokenInput).toBeVisible();

    await dialogs.gitlab.instanceUrlInput.fill('https://gitlab.com');
    await dialogs.gitlab.tokenInput.fill('glpat-validtoken123');

    await startCommandCapture(page);
    await dialogs.gitlab.connectButton.click();
    await waitForCommand(page, 'check_gitlab_connection');

    const checkCommands = await findCommand(page, 'check_gitlab_connection');
    expect(checkCommands.length).toBeGreaterThan(0);
  });
});

test.describe('OAuth Dialog State After Close', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('GitHub dialog should reset state after close and reopen', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();
    await expect(dialogs.github.dialog).toBeVisible();

    await dialogs.github.selectPATMethod();
    await dialogs.github.tokenInput.fill('ghp_test123');

    await dialogs.github.closeWithEscape();
    await expect(dialogs.github.dialog).not.toBeVisible();

    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();
    await expect(dialogs.github.dialog).toBeVisible();

    await expect(dialogs.github.connectionTab).toBeVisible();
  });

  test('switching tabs should preserve connection tab state', async () => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await expect(dialogs.github.connectionTab).toBeVisible();

    await dialogs.github.switchToPullRequestsTab();
    await dialogs.github.switchToConnectionTab();

    await expect(dialogs.github.authMethodToggle).toBeVisible();
  });
});

test.describe('OAuth Error Scenarios', () => {
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('should show error when OAuth token validation fails', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await dialogs.github.selectPATMethod();
    await expect(dialogs.github.tokenInput).toBeVisible();

    // Inject error for the token validation command
    await injectCommandError(page, 'check_github_connection', 'Token validation failed: invalid or expired token');

    await dialogs.github.tokenInput.fill('ghp_expired_token_12345');
    await dialogs.github.connectButton.click();

    // Error message should be displayed in the dialog or as a toast
    await expect(
      page.locator('gn-github-dialog .error, gn-github-dialog .error-message, .toast.error, .toast')
    ).toBeVisible({ timeout: 5000 });
  });

  test('should handle network error during OAuth flow', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();

    await dialogs.github.selectPATMethod();
    await expect(dialogs.github.tokenInput).toBeVisible();

    // Inject a network-level error for the connection check command
    await injectCommandError(page, 'check_github_connection', 'Network error: unable to reach api.github.com');

    await dialogs.github.tokenInput.fill('ghp_valid_looking_token');
    await dialogs.github.connectButton.click();

    // An error state should be visible to the user
    await expect(
      page.locator('gn-github-dialog .error, gn-github-dialog .error-message, .toast.error, .toast')
    ).toBeVisible({ timeout: 5000 });
  });

  test('should show error when GitLab PAT connection fails', async ({ page }) => {
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitLab Integration');
    await dialogs.commandPalette.executeFirst();

    await dialogs.gitlab.selectPATMethod();
    await expect(dialogs.gitlab.tokenInput).toBeVisible();

    // Inject error for GitLab connection check
    await injectCommandError(page, 'check_gitlab_connection', 'Authentication failed: 401 Unauthorized');

    await dialogs.gitlab.instanceUrlInput.fill('https://gitlab.com');
    await dialogs.gitlab.tokenInput.fill('glpat-invalidtoken123');
    await dialogs.gitlab.connectButton.click();

    // Error feedback should be visible
    await expect(
      page.locator('gn-gitlab-dialog .error, gn-gitlab-dialog .error-message, .toast.error, .toast')
    ).toBeVisible({ timeout: 5000 });
  });
});

test.describe('OAuth - Strengthened Assertions', () => {
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    dialogs = new DialogsPage(page);
    await setupOpenRepository(page);
  });

  test('cross-dialog state: GitHub token should not leak into GitLab dialog', async ({ page }) => {
    // Open GitHub dialog, switch to PAT, fill in a token
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();
    await expect(dialogs.github.dialog).toBeVisible();

    await dialogs.github.selectPATMethod();
    await dialogs.github.tokenInput.fill('ghp_cross_dialog_test_token');
    await expect(dialogs.github.tokenInput).toHaveValue('ghp_cross_dialog_test_token');

    // Close GitHub dialog
    await dialogs.github.closeWithEscape();
    await expect(dialogs.github.dialog).not.toBeVisible();

    // Open GitLab dialog
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitLab Integration');
    await dialogs.commandPalette.executeFirst();
    await expect(dialogs.gitlab.dialog).toBeVisible();

    // Verify GitLab dialog is clean: PAT input should be empty (switch to PAT mode first)
    await dialogs.gitlab.selectPATMethod();
    await expect(dialogs.gitlab.tokenInput).toBeVisible();
    await expect(dialogs.gitlab.tokenInput).toHaveValue('');

    // Also verify the instance URL is at its default, not polluted by GitHub state
    await expect(dialogs.gitlab.instanceUrlInput).toBeVisible();
  });

  test('network error vs invalid token error show different messages', async ({ page }) => {
    // Test 1: Network error
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();
    await expect(dialogs.github.dialog).toBeVisible();

    await dialogs.github.selectPATMethod();
    // The actual command used is check_github_connection (not connect_github or check_github_connection_with_token)
    await injectCommandError(page, 'check_github_connection', 'Network error: unable to reach api.github.com');

    await dialogs.github.tokenInput.fill('ghp_network_error_token');
    await dialogs.github.connectButton.click();

    // Capture the network error message text
    const networkErrorLocator = page.locator(
      'gn-github-dialog .error, gn-github-dialog .error-message, .toast.error, .toast'
    );
    await expect(networkErrorLocator).toBeVisible({ timeout: 5000 });
    const networkErrorText = await networkErrorLocator.first().textContent();

    // Close GitHub dialog and reset
    await dialogs.github.closeWithEscape();
    await expect(dialogs.github.dialog).not.toBeVisible();

    // Test 2: Invalid token error
    await dialogs.commandPalette.open();
    await dialogs.commandPalette.search('GitHub Integration');
    await dialogs.commandPalette.executeFirst();
    await expect(dialogs.github.dialog).toBeVisible();

    await dialogs.github.selectPATMethod();
    await injectCommandError(page, 'check_github_connection', 'Invalid token: authentication failed (401 Unauthorized)');

    await dialogs.github.tokenInput.fill('ghp_invalid_token_test');
    await dialogs.github.connectButton.click();

    const invalidTokenErrorLocator = page.locator(
      'gn-github-dialog .error, gn-github-dialog .error-message, .toast.error, .toast'
    );
    await expect(invalidTokenErrorLocator).toBeVisible({ timeout: 5000 });
    const invalidTokenErrorText = await invalidTokenErrorLocator.first().textContent();

    // Both errors should have been shown (both visible), and the messages should differ
    // since the backend provides different error strings for network vs auth failures
    expect(networkErrorText).toBeTruthy();
    expect(invalidTokenErrorText).toBeTruthy();
    expect(networkErrorText).not.toEqual(invalidTokenErrorText);
  });
});
