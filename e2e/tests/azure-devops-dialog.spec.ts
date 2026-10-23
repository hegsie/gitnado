import { test, expect } from '@playwright/test';
import { setupOpenRepository, setupProfilesAndAccounts } from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';
import { DialogsPage, AzureDevOpsDialogPage } from '../pages/dialogs.page';
import {
  startCommandCapture,
  findCommand,
  injectCommandError,
  injectCommandMock,
  startCommandCaptureWithMocks,
  waitForCommand,
} from '../fixtures/test-helpers';

/**
 * E2E tests for Azure DevOps Dialog
 *
 * The Azure DevOps dialog is opened via the command palette ("Azure DevOps Integration").
 * It has tabs: Connection, Pull Requests, Work Items, Pipelines.
 * It uses `gn-modal[open]` internally and is accessed via `AzureDevOpsDialogPage`.
 *
 * The dialog element is `gn-azure-devops-dialog` with an internal `gn-modal[open]`.
 */

test.describe('Azure DevOps Dialog - Display', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(
      page,
      {
        profiles: [
          {
            id: 'default',
            name: 'Default',
            gitName: 'Test User',
            gitEmail: 'test@example.com',
            signingKey: null,
            urlPatterns: [],
            isDefault: true,
            color: '#3b82f6',
            defaultAccounts: { 'azure-devops': 'ado-account-1' },
          },
        ],
        accounts: [
          {
            id: 'ado-account-1',
            name: 'My Azure DevOps',
            integrationType: 'azure-devops',
            config: { type: 'pat', organization: 'testorg' },
            color: null,
            cachedUser: { username: 'testuser', displayName: 'Test User', avatarUrl: null },
            urlPatterns: ['dev.azure.com/testorg'],
            isDefault: false,
          },
        ],
        connectedAccounts: ['ado-account-1'],
      },
      {
        remotes: [
          { name: 'origin', url: 'https://dev.azure.com/testorg/testproject/_git/testrepo', pushUrl: null },
        ],
      },
    );

    // Mock Azure DevOps commands
    await startCommandCaptureWithMocks(page, {
      detect_ado_repo: {
        organization: 'testorg',
        project: 'testproject',
        repoName: 'testrepo',
        remoteName: 'origin',
      },
      check_ado_connection_with_pat: {
        user: { displayName: 'Test User', emailAddress: 'test@example.com', id: 'user-1' },
      },
      list_ado_pull_requests: [
        {
          pullRequestId: 123,
          title: 'Add new feature',
          status: 'active',
          createdBy: { displayName: 'Developer', uniqueName: 'dev@example.com' },
          creationDate: new Date().toISOString(),
          sourceRefName: 'refs/heads/feature/new-feature',
          targetRefName: 'refs/heads/main',
        },
        {
          pullRequestId: 124,
          title: 'Fix login bug',
          status: 'active',
          createdBy: { displayName: 'Developer 2', uniqueName: 'dev2@example.com' },
          creationDate: new Date().toISOString(),
          sourceRefName: 'refs/heads/fix/login',
          targetRefName: 'refs/heads/main',
        },
      ],
      query_ado_work_items: [
        {
          id: 45,
          title: 'Bug: Application crashes',
          workItemType: 'Bug',
          state: 'Active',
          assignedTo: { displayName: 'Developer' },
          createdDate: new Date().toISOString(),
          priority: 1,
        },
      ],
      list_ado_pipeline_runs: [
        {
          id: 1,
          name: 'CI Pipeline',
          state: 'completed',
          result: 'succeeded',
          sourceBranch: 'refs/heads/main',
          createdDate: new Date().toISOString(),
          finishedDate: new Date().toISOString(),
        },
      ],
    });
  });

  test('opens dialog with all tabs visible', async () => {
    await app.executeCommand('Azure DevOps');

    await expect(dialogs.azureDevOps.dialog).toBeVisible();
    await expect(dialogs.azureDevOps.connectionTab).toBeVisible();
    await expect(dialogs.azureDevOps.pullRequestsTab).toBeVisible();
    await expect(dialogs.azureDevOps.workItemsTab).toBeVisible();
    await expect(dialogs.azureDevOps.pipelinesTab).toBeVisible();
  });

  test('Connection tab is active by default', async () => {
    await app.executeCommand('Azure DevOps');

    await expect(dialogs.azureDevOps.dialog).toBeVisible();
    await expect(dialogs.azureDevOps.connectionTab).toBeVisible();
  });

  test('can navigate between all tabs', async () => {
    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    // Navigate to each tab
    await dialogs.azureDevOps.pullRequestsTab.click();
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    await dialogs.azureDevOps.workItemsTab.click();
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    await dialogs.azureDevOps.pipelinesTab.click();
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    await dialogs.azureDevOps.switchToConnectionTab();
    await expect(dialogs.azureDevOps.dialog).toBeVisible();
  });
});

test.describe('Azure DevOps Dialog - Connection Tab', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);

    await setupOpenRepository(page, {
      remotes: [
        { name: 'origin', url: 'https://dev.azure.com/testorg/testproject/_git/testrepo', pushUrl: null },
      ],
    });

    await startCommandCaptureWithMocks(page, {
      detect_ado_repo: {
        organization: 'testorg',
        project: 'testproject',
        repoName: 'testrepo',
        remoteName: 'origin',
      },
      // Default to not connected so the token form is shown
      check_ado_connection: { connected: false, user: null },
    });
  });

  test('shows PAT authentication form', async ({ page }) => {
    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    // ADO has no OAuth toggle - token form is shown by default
    // Token input and connect button should be visible
    await expect(dialogs.azureDevOps.tokenInput).toBeVisible();
    await expect(dialogs.azureDevOps.connectButton).toBeVisible();
  });

  test('can type in PAT input', async ({ page }) => {
    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    await dialogs.azureDevOps.tokenInput.fill('test-pat-token-123');
    await expect(dialogs.azureDevOps.tokenInput).toHaveValue('test-pat-token-123');
  });

  test('connecting with PAT calls check_ado_connection', async ({ page }) => {
    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    // Now inject the connected response for when user clicks Connect
    await startCommandCaptureWithMocks(page, {
      check_ado_connection: {
        connected: true,
        user: { displayName: 'Test User', emailAddress: 'test@example.com', id: 'user-1' },
        organization: 'testorg',
      },
      save_global_account: {
        id: 'new-ado-account',
        name: 'Azure DevOps (Test User)',
        integrationType: 'azure-devops',
        config: { type: 'pat', organization: 'testorg' },
        color: null,
        cachedUser: null,
        urlPatterns: [],
        isDefault: false,
      },
      store_git_credentials: null,
    });

    // Fill organization (required for the connect button to be enabled)
    await dialogs.azureDevOps.organizationInput.fill('testorg');
    await dialogs.azureDevOps.tokenInput.fill('valid-pat-token');
    await dialogs.azureDevOps.connectButton.click();

    await waitForCommand(page, 'check_ado_connection');

    const commands = await findCommand(page, 'check_ado_connection');
    expect(commands.length).toBeGreaterThan(0);

    // Verify the UI shows connected state
    await expect(dialogs.azureDevOps.connectionStatus).toBeVisible({ timeout: 10000 });
  });

  test('shows connected state after successful PAT validation', async ({ page }) => {
    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    // Now inject the connected response for when user clicks Connect
    await startCommandCaptureWithMocks(page, {
      check_ado_connection: {
        connected: true,
        user: { displayName: 'Test User', emailAddress: 'test@example.com', id: 'user-1' },
        organization: 'testorg',
      },
      save_global_account: {
        id: 'new-ado-account',
        name: 'Azure DevOps (Test User)',
        integrationType: 'azure-devops',
        config: { type: 'pat', organization: 'testorg' },
        color: null,
        cachedUser: null,
        urlPatterns: [],
        isDefault: false,
      },
      store_git_credentials: null,
    });

    // Fill organization (required for the connect button to be enabled)
    await dialogs.azureDevOps.organizationInput.fill('testorg');
    await dialogs.azureDevOps.tokenInput.fill('valid-pat-token');
    await dialogs.azureDevOps.connectButton.click();

    // Connection status should show connected info
    await expect(dialogs.azureDevOps.connectionStatus).toBeVisible({ timeout: 10000 });
  });

  // Regression: a PAT connect whose keyring credential write fails used to show
  // "Connected" with no warning at all, so the user only found out when a later
  // HTTPS push/pull prompted for credentials.
  test('warns when the keyring git-credential write fails but keeps the connection', async ({ page }) => {
    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    await startCommandCaptureWithMocks(page, {
      check_ado_connection: {
        connected: true,
        user: { displayName: 'Test User', emailAddress: 'test@example.com', id: 'user-1' },
        organization: 'testorg',
      },
      check_ado_connection_with_token: {
        connected: true,
        user: { displayName: 'Test User', emailAddress: 'test@example.com', id: 'user-1' },
        organization: 'testorg',
      },
      save_global_account: {
        id: 'new-ado-account',
        name: 'Azure DevOps (Test User)',
        integrationType: 'azure-devops',
        config: { type: 'pat', organization: 'testorg' },
        color: null,
        cachedUser: null,
        urlPatterns: [],
        isDefault: false,
      },
    });
    await injectCommandError(page, 'store_git_credentials', 'keyring locked');

    await dialogs.azureDevOps.organizationInput.fill('testorg');
    await dialogs.azureDevOps.tokenInput.fill('valid-pat-token');
    await dialogs.azureDevOps.connectButton.click();

    await expect(
      page.locator('.toast.error', { hasText: /saving git credentials failed/i })
    ).toBeVisible({ timeout: 10000 });
    // The connect itself still succeeded — a keyring failure must not undo it.
    await expect(dialogs.azureDevOps.connectionStatus).toBeVisible({ timeout: 10000 });
  });

  test('shows error on failed PAT validation', async ({ page }) => {
    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    // Inject error for the check command before user clicks Connect
    await injectCommandError(page, 'check_ado_connection', 'Invalid Personal Access Token');

    // Fill organization (required for the connect button to be enabled)
    await dialogs.azureDevOps.organizationInput.fill('testorg');
    await dialogs.azureDevOps.tokenInput.fill('invalid-token');
    await dialogs.azureDevOps.connectButton.click();

    await expect(dialogs.azureDevOps.dialog).toBeVisible();
  });
});

test.describe('Azure DevOps Dialog - Tabs Content', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(
      page,
      {
        profiles: [
          {
            id: 'default',
            name: 'Default',
            gitName: 'Test User',
            gitEmail: 'test@example.com',
            signingKey: null,
            urlPatterns: [],
            isDefault: true,
            color: '#3b82f6',
            defaultAccounts: { 'azure-devops': 'ado-1' },
          },
        ],
        accounts: [
          {
            id: 'ado-1',
            name: 'Azure DevOps',
            integrationType: 'azure-devops',
            config: { type: 'pat', organization: 'testorg' },
            color: null,
            cachedUser: { username: 'testuser', displayName: 'Test User', avatarUrl: null },
            urlPatterns: [],
            isDefault: false,
          },
        ],
        connectedAccounts: ['ado-1'],
      },
      {
        remotes: [
          { name: 'origin', url: 'https://dev.azure.com/testorg/testproject/_git/testrepo', pushUrl: null },
        ],
      },
    );

    await startCommandCaptureWithMocks(page, {
      detect_ado_repo: {
        organization: 'testorg',
        project: 'testproject',
        repoName: 'testrepo',
        remoteName: 'origin',
      },
      list_ado_pull_requests: [
        {
          pullRequestId: 123,
          title: 'Add new feature',
          status: 'active',
          createdBy: { displayName: 'Developer', uniqueName: 'dev@example.com' },
          creationDate: new Date().toISOString(),
          sourceRefName: 'refs/heads/feature/new-feature',
          targetRefName: 'refs/heads/main',
        },
      ],
      query_ado_work_items: [
        {
          id: 45,
          title: 'Bug: Application crashes',
          workItemType: 'Bug',
          state: 'Active',
          assignedTo: { displayName: 'Developer' },
          createdDate: new Date().toISOString(),
          priority: 1,
        },
      ],
      list_ado_pipeline_runs: [
        {
          id: 1,
          name: 'CI Pipeline',
          state: 'completed',
          result: 'succeeded',
          sourceBranch: 'refs/heads/main',
          createdDate: new Date().toISOString(),
          finishedDate: new Date().toISOString(),
        },
      ],
    });
  });

  test('Pull Requests tab is navigable', async () => {
    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    await dialogs.azureDevOps.pullRequestsTab.click();

    // Tab should now be active
    await expect(dialogs.azureDevOps.pullRequestsTab).toHaveClass(/active/);
  });

  test('Work Items tab is navigable', async () => {
    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    await dialogs.azureDevOps.workItemsTab.click();

    await expect(dialogs.azureDevOps.workItemsTab).toHaveClass(/active/);
  });

  test('Pipelines tab is navigable', async () => {
    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    await dialogs.azureDevOps.pipelinesTab.click();

    await expect(dialogs.azureDevOps.pipelinesTab).toHaveClass(/active/);
  });
});

test.describe('Azure DevOps Dialog - Close', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);

    await setupOpenRepository(page);

    await startCommandCaptureWithMocks(page, {
      detect_ado_repo: null,
    });
  });

  test('closes dialog with Escape key', async () => {
    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    await dialogs.azureDevOps.closeWithEscape();
    await expect(dialogs.azureDevOps.dialog).not.toBeVisible();
  });

  test('closes dialog with close button', async () => {
    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    await dialogs.azureDevOps.close();
    await expect(dialogs.azureDevOps.dialog).not.toBeVisible();
  });
});

test.describe('Azure DevOps Dialog - Extended Scenarios', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);

    await setupOpenRepository(page, {
      remotes: [
        { name: 'origin', url: 'https://dev.azure.com/testorg/testproject/_git/testrepo', pushUrl: null },
      ],
    });

    await startCommandCaptureWithMocks(page, {
      detect_ado_repo: {
        organization: 'testorg',
        project: 'testproject',
        repoName: 'testrepo',
        remoteName: 'origin',
      },
    });
  });

  test('should show connected user info when already connected', async ({ page }) => {
    // Inject connected state for the connection check
    await injectCommandMock(page, {
      check_ado_connection: {
        connected: true,
        user: { displayName: 'Test User', emailAddress: 'test@example.com', id: 'user-1' },
        organization: 'testorg',
      },
    });

    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    // Connection status should show the connected user info
    await expect(dialogs.azureDevOps.connectionStatus).toBeVisible({ timeout: 10000 });
  });

  test('should show invalid organization error message', async ({ page }) => {
    // Start with not-connected state
    await injectCommandMock(page, {
      check_ado_connection: { connected: false, user: null },
    });

    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    // Inject error for connection attempt with invalid organization
    await injectCommandError(page, 'check_ado_connection', 'Invalid organization: organization not found');

    // Fill in organization and token, then attempt to connect
    await dialogs.azureDevOps.organizationInput.fill('invalidorg');
    await dialogs.azureDevOps.tokenInput.fill('some-pat-token');
    await dialogs.azureDevOps.connectButton.click();

    // Dialog should remain open with error displayed
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    // Verify the error is shown within the dialog
    await expect(page.locator('gn-azure-devops-dialog .error, gn-azure-devops-dialog .error-message, .toast.error').first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Azure DevOps Dialog - Pipelines scoping', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(
      page,
      {
        profiles: [
          {
            id: 'default',
            name: 'Default',
            gitName: 'Test User',
            gitEmail: 'test@example.com',
            signingKey: null,
            urlPatterns: [],
            isDefault: true,
            color: '#3b82f6',
            defaultAccounts: { 'azure-devops': 'ado-account-1' },
          },
        ],
        accounts: [
          {
            id: 'ado-account-1',
            name: 'My Azure DevOps',
            integrationType: 'azure-devops',
            config: { type: 'pat', organization: 'testorg' },
            color: null,
            cachedUser: { username: 'testuser', displayName: 'Test User', avatarUrl: null },
            urlPatterns: ['dev.azure.com/testorg'],
            isDefault: false,
          },
        ],
        connectedAccounts: ['ado-account-1'],
      },
      {
        remotes: [
          { name: 'origin', url: 'https://dev.azure.com/testorg/testproject/_git/testrepo', pushUrl: null },
        ],
      },
    );

    await startCommandCaptureWithMocks(page, {
      detect_ado_repo: {
        organization: 'testorg',
        project: 'testproject',
        repository: 'testrepo',
        remoteName: 'origin',
      },
      check_ado_connection: {
        connected: true,
        user: {
          id: 'user-1',
          displayName: 'Test User',
          uniqueName: 'test@example.com',
          imageUrl: null,
        },
        organization: 'testorg',
      },
      list_ado_pipeline_runs: [
        {
          id: 1,
          name: 'CI Pipeline #1',
          state: 'completed',
          result: 'succeeded',
          sourceBranch: 'main',
          createdDate: new Date().toISOString(),
          finishedDate: new Date().toISOString(),
          url: 'https://dev.azure.com/testorg/testproject/_build/results?buildId=1',
        },
      ],
    });
  });

  test('Pipelines tab requests runs for the detected repository', async ({ page }) => {
    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    await dialogs.azureDevOps.pipelinesTab.click();

    // The listing must actually fire — loadPipelineRuns() returns early unless
    // the connection check reported connected.
    await waitForCommand(page, 'list_ado_pipeline_runs');
    const calls = await findCommand(page, 'list_ado_pipeline_runs');
    expect(calls.length).toBeGreaterThan(0);

    // Without the repository the backend lists builds for every repo in the project.
    const args = calls[0].args as Record<string, unknown>;
    expect(args.repository).toBe('testrepo');
    expect(args.organization).toBe('testorg');
    expect(args.project).toBe('testproject');

    await expect(page.locator('.pipeline-item')).toHaveCount(1);
    await expect(page.locator('.pipeline-item').first()).toContainText('CI Pipeline');
  });
});


/**
 * Both Azure DevOps listings are capped: the dialog asks for an explicit page
 * size and the tab must disclose it, with a link that opens the matching Azure
 * DevOps list through the shell rather than navigating the webview.
 */
test.describe('Azure DevOps Dialog - Capped list disclosure', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  const makeRun = (n: number) => ({
    id: n,
    name: `Capped run ${n}`,
    state: 'completed',
    result: 'succeeded',
    sourceBranch: 'main',
    createdDate: '2025-01-15T10:00:00Z',
    finishedDate: '2025-01-15T10:05:00Z',
    url: `https://dev.azure.com/testorg/testproject/_build/results?buildId=${n}`,
  });

  const makePr = (n: number) => ({
    pullRequestId: n,
    title: `Capped PR ${n}`,
    description: null,
    status: 'active',
    createdBy: { id: 'user-1', displayName: 'Test User', uniqueName: 'test@example.com' },
    creationDate: '2025-01-15T10:00:00Z',
    sourceRefName: `refs/heads/feature/${n}`,
    targetRefName: 'refs/heads/main',
    isDraft: false,
    url: `https://dev.azure.com/testorg/testproject/_git/testrepo/pullrequest/${n}`,
  });

  test.beforeEach(async ({ page }) => {
    app = new AppPage(page);
    dialogs = new DialogsPage(page);

    await setupProfilesAndAccounts(
      page,
      {
        profiles: [
          {
            id: 'default',
            name: 'Default',
            gitName: 'Test User',
            gitEmail: 'test@example.com',
            signingKey: null,
            urlPatterns: [],
            isDefault: true,
            color: '#3b82f6',
            defaultAccounts: { 'azure-devops': 'ado-account-1' },
          },
        ],
        accounts: [
          {
            id: 'ado-account-1',
            name: 'My Azure DevOps',
            integrationType: 'azure-devops',
            config: { type: 'pat', organization: 'testorg' },
            color: null,
            cachedUser: { username: 'testuser', displayName: 'Test User', avatarUrl: null },
            urlPatterns: ['dev.azure.com/testorg'],
            isDefault: false,
          },
        ],
        connectedAccounts: ['ado-account-1'],
      },
      {
        remotes: [
          { name: 'origin', url: 'https://dev.azure.com/testorg/testproject/_git/testrepo', pushUrl: null },
        ],
      },
    );

    await startCommandCaptureWithMocks(page, {
      detect_ado_repo: {
        organization: 'testorg',
        project: 'testproject',
        repository: 'testrepo',
        remoteName: 'origin',
      },
      check_ado_connection: {
        connected: true,
        user: {
          id: 'user-1',
          displayName: 'Test User',
          uniqueName: 'test@example.com',
          imageUrl: null,
        },
        organization: 'testorg',
      },
      query_ado_work_items: [],
      // The hint's link must reach the browser, not navigate the webview away.
      'plugin:shell|open': null,
    });
  });

  test('discloses the capped pipeline run list and opens the runs view', async ({ page }) => {
    // Serve exactly the page size the dialog asked for, so the hint can only
    // render if the requested cap and the disclosed cap are the same number.
    await page.evaluate(() => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const originalInvoke = internals.invoke;
      internals.invoke = async (command: string, args?: unknown) => {
        if (command !== 'list_ado_pipeline_runs') return originalInvoke(command, args);
        const captured = (window as unknown as {
          __INVOKED_COMMANDS__?: { command: string; args: unknown }[];
        }).__INVOKED_COMMANDS__;
        if (captured) captured.push({ command, args });
        const top = Number((args as { top?: number })?.top ?? 0);
        return Array.from({ length: top }, (_, i) => ({
          id: i + 1,
          name: `Capped run ${i + 1}`,
          state: 'completed',
          result: 'succeeded',
          sourceBranch: 'main',
          createdDate: '2025-01-15T10:00:00Z',
          finishedDate: '2025-01-15T10:05:00Z',
          url: `https://dev.azure.com/testorg/testproject/_build/results?buildId=${i + 1}`,
        }));
      };
    });

    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();
    await dialogs.azureDevOps.pipelinesTab.click();

    await waitForCommand(page, 'list_ado_pipeline_runs');
    const runCalls = await findCommand(page, 'list_ado_pipeline_runs');
    const requestedTop = (runCalls[0].args as { top: number }).top;
    await expect(page.locator('gn-azure-devops-dialog .pipeline-item')).toHaveCount(requestedTop);

    const hint = page.locator('gn-azure-devops-dialog .capped-list-hint');
    await expect(hint).toContainText('more may exist');
    await expect(hint).toContainText(String(requestedTop));

    await hint.locator('a').click();

    await waitForCommand(page, 'plugin:shell|open');
    const opens = await findCommand(page, 'plugin:shell|open');
    expect((opens[0].args as { path: string }).path).toBe(
      'https://dev.azure.com/testorg/testproject/_build?view=runs',
    );

    await expect(dialogs.azureDevOps.dialog).toBeVisible();
  });

  test('discloses the capped pull request list and opens the PR list', async ({ page }) => {
    await page.evaluate(() => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const originalInvoke = internals.invoke;
      internals.invoke = async (command: string, args?: unknown) => {
        if (command !== 'list_ado_pull_requests') return originalInvoke(command, args);
        const captured = (window as unknown as {
          __INVOKED_COMMANDS__?: { command: string; args: unknown }[];
        }).__INVOKED_COMMANDS__;
        if (captured) captured.push({ command, args });
        const top = Number((args as { top?: number })?.top ?? 0);
        return Array.from({ length: top }, (_, i) => ({
          pullRequestId: i + 1,
          title: `Capped PR ${i + 1}`,
          description: null,
          status: 'active',
          createdBy: { id: 'user-1', displayName: 'Test User', uniqueName: 'test@example.com' },
          creationDate: '2025-01-15T10:00:00Z',
          sourceRefName: `refs/heads/feature/${i + 1}`,
          targetRefName: 'refs/heads/main',
          isDraft: false,
          url: `https://dev.azure.com/testorg/testproject/_git/testrepo/pullrequest/${i + 1}`,
        }));
      };
    });

    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();
    await dialogs.azureDevOps.pullRequestsTab.click();

    await waitForCommand(page, 'list_ado_pull_requests');
    const prCalls = await findCommand(page, 'list_ado_pull_requests');
    // Without an explicit $top the Azure DevOps server default silently caps the
    // list and the dialog has no number to disclose.
    const requestedTop = (prCalls[0].args as { top: number }).top;
    expect(requestedTop).toBeGreaterThan(0);
    await expect(page.locator('gn-azure-devops-dialog .pr-item')).toHaveCount(requestedTop);

    const hint = page.locator('gn-azure-devops-dialog .capped-list-hint');
    await expect(hint).toContainText('more may exist');
    await expect(hint).toContainText(String(requestedTop));

    await hint.locator('a').click();

    await waitForCommand(page, 'plugin:shell|open');
    const opens = await findCommand(page, 'plugin:shell|open');
    // The link has to open the same list the hint is attached to; the Azure
    // DevOps PR page selects that list with `_a`.
    expect((opens[0].args as { path: string }).path).toBe(
      'https://dev.azure.com/testorg/testproject/_git/testrepo/pullrequests?_a=active',
    );

    // Switching the filter must move the link with it, otherwise the "full list"
    // link lands on a different list than the one on screen.
    await page.locator('gn-azure-devops-dialog .filter-select').selectOption('abandoned');
    await expect(hint.locator('a')).toHaveAttribute(
      'href',
      'https://dev.azure.com/testorg/testproject/_git/testrepo/pullrequests?_a=abandoned',
    );
    await hint.locator('a').click();

    await expect
      .poll(async () => (await findCommand(page, 'plugin:shell|open')).length)
      .toBeGreaterThan(1);
    const filteredOpens = await findCommand(page, 'plugin:shell|open');
    expect((filteredOpens[1].args as { path: string }).path).toBe(
      'https://dev.azure.com/testorg/testproject/_git/testrepo/pullrequests?_a=abandoned',
    );
  });

  // Azure DevOps defaults `searchCriteria.status` to `active`, so the "All"
  // filter has to send `all` explicitly — omitting it renders the Active list
  // again with completed and abandoned pull requests silently missing.
  test('requests every state when the All pull request filter is selected', async ({ page }) => {
    await page.evaluate(() => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const originalInvoke = internals.invoke;
      internals.invoke = async (command: string, args?: unknown) => {
        if (command !== 'list_ado_pull_requests') return originalInvoke(command, args);
        const captured = (window as unknown as {
          __INVOKED_COMMANDS__?: { command: string; args: unknown }[];
        }).__INVOKED_COMMANDS__;
        if (captured) captured.push({ command, args });
        // Stand in for the API: `all` returns every state, anything else returns
        // just that one.
        const status = (args as { status?: string })?.status ?? 'active';
        const states = status === 'all' ? ['active', 'completed', 'abandoned'] : [status];
        return states.map((state, i) => ({
          pullRequestId: i + 1,
          title: `${state} PR`,
          description: null,
          status: state,
          createdBy: { id: 'user-1', displayName: 'Test User', uniqueName: 'test@example.com' },
          creationDate: '2025-01-15T10:00:00Z',
          sourceRefName: `refs/heads/feature/${i + 1}`,
          targetRefName: 'refs/heads/main',
          isDraft: false,
          url: `https://dev.azure.com/testorg/testproject/_git/testrepo/pullrequest/${i + 1}`,
        }));
      };
    });

    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();
    await dialogs.azureDevOps.pullRequestsTab.click();
    await expect(page.locator('gn-azure-devops-dialog .pr-item')).toHaveCount(1);

    await page.locator('gn-azure-devops-dialog .filter-select').selectOption('all');
    await expect(page.locator('gn-azure-devops-dialog .pr-item')).toHaveCount(3);
    await expect(page.locator('gn-azure-devops-dialog .pr-list')).toContainText('completed PR');
    await expect(page.locator('gn-azure-devops-dialog .pr-list')).toContainText('abandoned PR');

    const prCalls = await findCommand(page, 'list_ado_pull_requests');
    expect((prCalls[prCalls.length - 1].args as { status?: string }).status).toBe('all');
  });

  // The work-item cap is disclosed from the same constant the request asks for,
  // so serving exactly the requested `limit` is the only way the hint can match.
  test('discloses the capped work item list from the size it requested', async ({ page }) => {
    await page.evaluate(() => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const originalInvoke = internals.invoke;
      internals.invoke = async (command: string, args?: unknown) => {
        if (command !== 'query_ado_work_items') return originalInvoke(command, args);
        const captured = (window as unknown as {
          __INVOKED_COMMANDS__?: { command: string; args: unknown }[];
        }).__INVOKED_COMMANDS__;
        if (captured) captured.push({ command, args });
        const limit = Number((args as { limit?: number })?.limit ?? 0);
        return Array.from({ length: limit }, (_, i) => ({
          id: i + 1,
          title: `Capped work item ${i + 1}`,
          workItemType: 'Task',
          state: 'Active',
          assignedTo: null,
          createdDate: '2025-01-15T10:00:00Z',
          url: `https://dev.azure.com/testorg/_workitems/edit/${i + 1}`,
        }));
      };
    });

    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();
    await dialogs.azureDevOps.workItemsTab.click();

    await waitForCommand(page, 'query_ado_work_items');
    const workItemCalls = await findCommand(page, 'query_ado_work_items');
    const requestedLimit = (workItemCalls[0].args as { limit: number }).limit;
    expect(requestedLimit).toBeGreaterThan(0);
    await expect(page.locator('gn-azure-devops-dialog .work-item')).toHaveCount(requestedLimit);

    const hint = page.locator('gn-azure-devops-dialog .capped-list-hint');
    await expect(hint).toContainText(String(requestedLimit));
  });

  test('shows no cap disclosure when the lists are short', async ({ page }) => {
    await injectCommandMock(page, {
      list_ado_pipeline_runs: [makeRun(1)],
      list_ado_pull_requests: [makePr(1)],
    });

    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    await dialogs.azureDevOps.pullRequestsTab.click();
    await expect(page.locator('gn-azure-devops-dialog .pr-item')).toHaveCount(1);
    await expect(page.locator('gn-azure-devops-dialog .capped-list-hint')).toHaveCount(0);

    await dialogs.azureDevOps.pipelinesTab.click();
    await expect(page.locator('gn-azure-devops-dialog .pipeline-item')).toHaveCount(1);
    await expect(page.locator('gn-azure-devops-dialog .capped-list-hint')).toHaveCount(0);
  });
});
