import { test, expect, type Page } from '@playwright/test';
import { setupProfilesAndAccounts } from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';
import { DialogsPage } from '../pages/dialogs.page';
import {
  findCommand,
  injectCommandError,
  injectCommandMock,
  startCommandCapture,
  waitForCommand,
} from '../fixtures/test-helpers';

/**
 * Wave 2 E2E: in-dialog creation for Bitbucket issues and Azure DevOps work items.
 *
 * Each test reaches a connected state with a detected repo, navigates to the
 * create tab, fills the form, submits, and asserts the create command fired with
 * the correct args plus the success/error UI outcome.
 */

// ============================================================================
// Bitbucket - Create Issue
// ============================================================================

test.describe('Bitbucket Dialog - Create Issue', () => {
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
            defaultAccounts: { bitbucket: 'bb-1' },
          },
        ],
        accounts: [
          {
            id: 'bb-1',
            name: 'Bitbucket',
            integrationType: 'bitbucket',
            config: { type: 'bitbucket', workspace: 'test-workspace' },
            color: null,
            cachedUser: { username: 'bbuser', displayName: 'BB User', avatarUrl: null },
            urlPatterns: [],
            isDefault: false,
          },
        ],
        connectedAccounts: ['bb-1'],
      },
      {
        remotes: [
          { name: 'origin', url: 'https://bitbucket.org/test-workspace/test-repo.git', pushUrl: null },
        ],
      },
    );

    await startCommandCapture(page);

    await injectCommandMock(page, {
      detect_bitbucket_repo: {
        workspace: 'test-workspace',
        repoSlug: 'test-repo',
        remoteName: 'origin',
      },
      check_bitbucket_connection: {
        connected: true,
        user: { username: 'bbuser', displayName: 'BB User', avatarUrl: '' },
      },
      check_bitbucket_connection_with_token: {
        connected: true,
        user: { username: 'bbuser', displayName: 'BB User', avatarUrl: '' },
      },
      list_bitbucket_issues: [],
      list_bitbucket_pull_requests: [],
      list_bitbucket_pipelines: [],
    });
  });

  test('creates an issue and returns to the issues list with a success toast', async ({ page }) => {
    await injectCommandMock(page, {
      create_bitbucket_issue: {
        id: 11,
        title: 'New E2E bug',
        content: 'It is broken',
        state: 'new',
        priority: 'major',
        kind: 'bug',
        reporter: { uuid: '{u}', username: 'bbuser', displayName: 'BB User', avatarUrl: null },
        assignee: null,
        createdOn: new Date().toISOString(),
        url: 'https://bitbucket.org/test-workspace/test-repo/issues/11',
      },
    });

    await app.executeCommand('Bitbucket');
    await expect(dialogs.bitbucket.dialog).toBeVisible();

    await dialogs.bitbucket.issuesTab.click();
    await expect(dialogs.bitbucket.issuesTab).toHaveClass(/active/);

    const newIssueBtn = page.locator('gn-bitbucket-dialog .btn', { hasText: 'New Issue' });
    await newIssueBtn.click();

    await page.locator('gn-bitbucket-dialog .token-form input[type="text"]').fill('New E2E bug');
    await page.locator('gn-bitbucket-dialog .token-form textarea').fill('It is broken');

    await page.locator('gn-bitbucket-dialog .btn-primary', { hasText: 'Create Issue' }).click();

    await waitForCommand(page, 'create_bitbucket_issue');
    const cmds = await findCommand(page, 'create_bitbucket_issue');
    expect(cmds.length).toBeGreaterThan(0);
    const args = cmds[0].args as Record<string, unknown>;
    expect(args.workspace).toBe('test-workspace');
    expect(args.repoSlug).toBe('test-repo');
    const input = args.input as Record<string, unknown>;
    expect(input.title).toBe('New E2E bug');
    expect(input.content).toBe('It is broken');

    // Returns to issues list and shows success toast
    await expect(dialogs.bitbucket.issuesTab).toHaveClass(/active/);
    await expect(page.locator('gn-toast-container .toast.success').first()).toBeVisible({ timeout: 5000 });
  });

  test('shows an error (not silent) when issue creation fails', async ({ page }) => {
    await app.executeCommand('Bitbucket');
    await expect(dialogs.bitbucket.dialog).toBeVisible();

    await dialogs.bitbucket.issuesTab.click();
    await page.locator('gn-bitbucket-dialog .btn', { hasText: 'New Issue' }).click();

    await injectCommandError(page, 'create_bitbucket_issue', 'Issue tracker disabled');

    await page.locator('gn-bitbucket-dialog .token-form input[type="text"]').fill('Will fail');
    await page.locator('gn-bitbucket-dialog .btn-primary', { hasText: 'Create Issue' }).click();

    await expect(dialogs.bitbucket.dialog).toBeVisible();
    await expect(
      page.locator('gn-bitbucket-dialog .error, .toast.error').first()
    ).toBeVisible({ timeout: 5000 });
  });
});

// ============================================================================
// Azure DevOps - Create Work Item
// ============================================================================

test.describe('Azure DevOps Dialog - Create Work Item', () => {
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

    await startCommandCapture(page);

    await injectCommandMock(page, {
      detect_ado_repo: {
        organization: 'testorg',
        project: 'testproject',
        repository: 'testrepo',
        remoteName: 'origin',
      },
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
      query_ado_work_items: [],
      list_ado_pull_requests: [],
      list_ado_pipeline_runs: [],
    });
  });

  test('creates a work item and returns to the work-items list with a success toast', async ({ page }) => {
    await injectCommandMock(page, {
      create_azure_devops_work_item: {
        id: 999,
        title: 'New E2E task',
        workItemType: 'Task',
        state: 'New',
        assignedTo: null,
        createdDate: new Date().toISOString(),
        url: 'https://dev.azure.com/testorg/testproject/_workitems/edit/999',
      },
    });

    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    await dialogs.azureDevOps.workItemsTab.click();
    await expect(dialogs.azureDevOps.workItemsTab).toHaveClass(/active/);

    const newBtn = page.locator('gn-azure-devops-dialog .btn', { hasText: 'New Work Item' });
    await newBtn.click();

    await page.locator('gn-azure-devops-dialog .token-form input[type="text"]').fill('New E2E task');
    await page.locator('gn-azure-devops-dialog .token-form textarea').fill('Do the work');

    await page.locator('gn-azure-devops-dialog .btn-primary', { hasText: 'Create Work Item' }).click();

    await waitForCommand(page, 'create_azure_devops_work_item');
    const cmds = await findCommand(page, 'create_azure_devops_work_item');
    expect(cmds.length).toBeGreaterThan(0);
    const args = cmds[0].args as Record<string, unknown>;
    expect(args.organization).toBe('testorg');
    expect(args.project).toBe('testproject');
    const input = args.input as Record<string, unknown>;
    expect(input.title).toBe('New E2E task');
    expect(input.workItemType).toBe('Task');
    expect(input.description).toBe('Do the work');

    await expect(dialogs.azureDevOps.workItemsTab).toHaveClass(/active/);
    await expect(page.locator('gn-toast-container .toast.success').first()).toBeVisible({ timeout: 5000 });
  });

  test('shows an error (not silent) when work-item creation fails', async ({ page }) => {
    await app.executeCommand('Azure DevOps');
    await expect(dialogs.azureDevOps.dialog).toBeVisible();

    await dialogs.azureDevOps.workItemsTab.click();
    await page.locator('gn-azure-devops-dialog .btn', { hasText: 'New Work Item' }).click();

    await injectCommandError(page, 'create_azure_devops_work_item', 'Permission denied');

    await page.locator('gn-azure-devops-dialog .token-form input[type="text"]').fill('Will fail');
    await page.locator('gn-azure-devops-dialog .btn-primary', { hasText: 'Create Work Item' }).click();

    await expect(dialogs.azureDevOps.dialog).toBeVisible();
    await expect(
      page.locator('gn-azure-devops-dialog .error, .toast.error').first()
    ).toBeVisible({ timeout: 5000 });
  });
});


// ============================================================================
// GitLab - Create Issue with labels
// ============================================================================

test.describe('GitLab Dialog - Create Issue with labels', () => {
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
            defaultAccounts: { gitlab: 'gl-1' },
          },
        ],
        accounts: [
          {
            id: 'gl-1',
            name: 'GitLab',
            integrationType: 'gitlab',
            config: { type: 'gitlab', instanceUrl: 'https://gitlab.com' },
            color: null,
            cachedUser: { username: 'gluser', displayName: 'GL User', avatarUrl: null },
            urlPatterns: [],
            isDefault: false,
          },
        ],
        connectedAccounts: ['gl-1'],
      },
      {
        remotes: [
          { name: 'origin', url: 'https://gitlab.com/test-group/test-project.git', pushUrl: null },
        ],
      },
    );

    await startCommandCapture(page);

    await injectCommandMock(page, {
      detect_gitlab_repo: {
        instanceUrl: 'https://gitlab.com',
        projectPath: 'test-group/test-project',
        remoteName: 'origin',
      },
      check_gitlab_connection: {
        connected: true,
        user: { id: 1, username: 'gluser', name: 'GL User', avatarUrl: '', webUrl: '' },
        instanceUrl: 'https://gitlab.com',
      },
      check_gitlab_connection_with_token: {
        connected: true,
        user: { id: 1, username: 'gluser', name: 'GL User', avatarUrl: '', webUrl: '' },
        instanceUrl: 'https://gitlab.com',
      },
      list_gitlab_merge_requests: [],
      list_gitlab_issues: [],
      list_gitlab_pipelines: [],
      get_gitlab_labels: ['bug', 'enhancement'],
    });
  });

  async function openCreateIssueForm(page: Page): Promise<void> {
    await app.executeCommand('GitLab');
    await expect(dialogs.gitlab.dialog).toBeVisible();

    await dialogs.gitlab.issuesTab.click();
    await expect(dialogs.gitlab.issuesTab).toHaveClass(/active/);

    await page.locator('gn-gitlab-dialog .btn', { hasText: 'New Issue' }).click();
  }

  test('attaches the picked label to the created issue', async ({ page }) => {
    await injectCommandMock(page, {
      create_gitlab_issue: {
        iid: 77,
        title: 'E2E labelled issue',
        description: null,
        state: 'opened',
        author: { id: 1, username: 'gluser', name: 'GL User', avatarUrl: '', webUrl: '' },
        assignees: [],
        labels: ['bug'],
        createdAt: new Date().toISOString(),
        webUrl: 'https://gitlab.com/test-group/test-project/-/issues/77',
      },
    });

    await openCreateIssueForm(page);

    await page.locator('gn-gitlab-dialog .token-form input[type="text"]').fill('E2E labelled issue');

    await expect(dialogs.gitlab.labelChips).toHaveCount(2);
    const bugChip = dialogs.gitlab.labelChips.filter({ hasText: 'bug' });
    await bugChip.click();
    await expect(bugChip).toHaveClass(/selected/);

    await page.locator('gn-gitlab-dialog .btn-primary', { hasText: 'Create Issue' }).click();

    await waitForCommand(page, 'create_gitlab_issue');
    const cmds = await findCommand(page, 'create_gitlab_issue');
    expect(cmds.length).toBeGreaterThan(0);
    const args = cmds[0].args as Record<string, unknown>;
    const input = args.input as Record<string, unknown>;
    expect(input.title).toBe('E2E labelled issue');
    expect(input.labels).toEqual(['bug']);

    // Returns to the issues list and reports success.
    await expect(dialogs.gitlab.issuesTab).toHaveClass(/active/);
    await expect(page.locator('gn-toast-container .toast.success').first()).toBeVisible({ timeout: 5000 });
  });

  test('shows an error and keeps the picked label when creation fails', async ({ page }) => {
    await openCreateIssueForm(page);

    await page.locator('gn-gitlab-dialog .token-form input[type="text"]').fill('Will fail');

    await expect(dialogs.gitlab.labelChips).toHaveCount(2);
    const bugChip = dialogs.gitlab.labelChips.filter({ hasText: 'bug' });
    await bugChip.click();
    await expect(bugChip).toHaveClass(/selected/);

    await injectCommandError(page, 'create_gitlab_issue', 'Labels not allowed');

    await page.locator('gn-gitlab-dialog .btn-primary', { hasText: 'Create Issue' }).click();

    await expect(dialogs.gitlab.dialog).toBeVisible();
    await expect(
      page.locator('gn-gitlab-dialog .error, .toast.error').first()
    ).toBeVisible({ timeout: 5000 });

    // The form (and the picked label) survives so the user can retry.
    await expect(bugChip).toHaveClass(/selected/);
  });
});
